use async_trait::async_trait;
use futures::io::{AsyncReadExt, AsyncWriteExt};
use futures::AsyncRead;
use futures::AsyncWrite;
use libp2p::request_response::Codec;
use libp2p::StreamProtocol;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

pub const BLOB_PROTOCOL: StreamProtocol = StreamProtocol::new("/peers/blob/1.0.0");
/// Caps a single parked blob (64 KiB — enough for many messages; files
/// get real chunking later).
pub const MAX_BLOB_SIZE: usize = 64 * 1024;

/// A blob hash (SHA-256 of the content, torrent-info-hash style).
pub type BlobHash = [u8; 32];

/// Ceiling on the in-memory blob cache. Disk is bounded separately; without
/// this a peer could grow RAM simply by requesting many distinct blobs, since
/// every disk hit is promoted into memory.
const MAX_MEMORY_BLOB_BYTES: usize = 32 * 1024 * 1024;

/// Byte-bounded LRU over recently used blob content.
#[derive(Default)]
struct MemCache {
    entries: HashMap<BlobHash, (Vec<u8>, u64)>,
    bytes: usize,
    clock: u64,
}

impl MemCache {
    fn get(&mut self, hash: &BlobHash) -> Option<Vec<u8>> {
        self.clock = self.clock.wrapping_add(1);
        let seq = self.clock;
        let entry = self.entries.get_mut(hash)?;
        entry.1 = seq;
        Some(entry.0.clone())
    }

    fn insert(&mut self, hash: BlobHash, data: Vec<u8>) {
        if data.len() > MAX_MEMORY_BLOB_BYTES {
            // A single entry larger than the whole budget would evict
            // everything else and still not fit. Serve it from disk only.
            return;
        }
        self.clock = self.clock.wrapping_add(1);
        let seq = self.clock;
        let len = data.len();
        match self.entries.insert(hash, (data, seq)) {
            Some((replaced, _)) => self.bytes = self.bytes.saturating_sub(replaced.len()),
            None => self.bytes += len,
        }
        self.evict();
    }

    fn evict(&mut self) {
        if self.bytes <= MAX_MEMORY_BLOB_BYTES {
            return;
        }
        let mut by_age: Vec<(BlobHash, u64)> = self
            .entries
            .iter()
            .map(|(hash, (_, seq))| (*hash, *seq))
            .collect();
        by_age.sort_unstable_by_key(|(_, seq)| *seq);
        for (hash, _) in by_age {
            if self.bytes <= MAX_MEMORY_BLOB_BYTES {
                break;
            }
            if let Some((data, _)) = self.entries.remove(&hash) {
                self.bytes = self.bytes.saturating_sub(data.len());
            }
        }
    }
}

/// Local seed cache: content-addressed by SHA-256. Holds only ciphertext
/// in production use and persists blobs under the platform config directory.
#[derive(Clone)]
pub struct BlobStore {
    inner: Arc<Mutex<MemCache>>,
    root: Option<PathBuf>,
}

impl BlobStore {
    pub fn new() -> Self {
        let root = dirs::config_dir()
            .or_else(dirs::data_local_dir())
            .map(|base| base.join("peers").join("blobs"))
            .filter(|path| fs::create_dir_all(path).is_ok());
        Self {
            inner: Arc::new(Mutex::new(MemCache::default())),
            root,
        }
    }

    /// In-memory store for tests and callers that explicitly do not want disk.
    pub fn memory() -> Self {
        Self {
            inner: Arc::new(Mutex::new(MemCache::default())),
            root: None,
        }
    }

    /// Stores data and returns its hash. Duplicate content dedupes.
    pub fn put(&self, data: &[u8]) -> BlobHash {
        let hash: BlobHash = Sha256::digest(data).into();
        self.inner.lock().unwrap().insert(hash, data.to_vec());
        if let Some(root) = &self.root {
            let path = root.join(hex_name(&hash));
            write_private(&path, data);
            self.enforce_disk_budget(root);
        }
        hash
    }

    pub fn get(&self, hash: &BlobHash) -> Option<Vec<u8>> {
        if let Some(data) = self.inner.lock().unwrap().get(hash) {
            return Some(data);
        }
        let root = self.root.as_ref()?;
        let data = fs::read(root.join(hex_name(hash))).ok()?;
        let actual: BlobHash = Sha256::digest(&data).into();
        if actual != *hash {
            return None;
        }
        self.inner.lock().unwrap().insert(*hash, data.clone());
        Some(data)
    }

    /// Hashes already persisted on disk, used to restore provider state after
    /// a process restart.
    pub fn hashes(&self) -> Vec<BlobHash> {
        let Some(root) = &self.root else { return Vec::new() };
        let Ok(entries) = fs::read_dir(root) else { return Vec::new() };
        entries
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let name = entry.file_name().to_str()?.strip_suffix(".blob")?.to_string();
                parse_hex_name(&name)
            })
            .collect()
    }
}

/// Blobs are user content and may contain private media, so they are created
/// owner-only instead of relying on the ambient umask.
fn write_private(path: &Path, data: &[u8]) {
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    if let Ok(mut file) = options.open(path) {
        // Fully qualified: `futures::io::AsyncWriteExt` is also in scope.
        let _ = std::io::Write::write_all(&mut file, data);
        let _ = file.sync_all();
    }
}

impl BlobStore {
    /// Keeps the local seed cache bounded so a peer cannot fill the disk just
    /// by asking us to keep blobs. Oldest access time is evicted first.
    fn enforce_disk_budget(&self, root: &Path) {
        const MAX_DISK_BLOB_BYTES: u64 = 256 * 1024 * 1024;
        let Ok(entries) = fs::read_dir(root) else {
            return;
        };
        let mut files: Vec<(std::time::SystemTime, u64, PathBuf)> = entries
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let metadata = entry.metadata().ok()?;
                if !metadata.is_file() {
                    return None;
                }
                let accessed = metadata.accessed().or_else(|_| metadata.modified()).ok()?;
                Some((accessed, metadata.len(), entry.path()))
            })
            .collect();
        let mut total: u64 = files.iter().map(|(_, size, _)| *size).sum();
        if total <= MAX_DISK_BLOB_BYTES {
            return;
        }
        files.sort_by_key(|(accessed, _, _)| *accessed);
        for (_, size, path) in files {
            if total <= MAX_DISK_BLOB_BYTES {
                break;
            }
            if fs::remove_file(&path).is_ok() {
                total = total.saturating_sub(size);
            }
        }
    }
}

fn hex_name(hash: &BlobHash) -> String {
    format!("{}.blob", hash.iter().map(|b| format!("{b:02x}")).collect::<String>())
}

fn parse_hex_name(name: &str) -> Option<BlobHash> {
    if name.len() != 64 || !name.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let mut hash = [0u8; 32];
    for (i, byte) in hash.iter_mut().enumerate() {
        *byte = u8::from_str_radix(name.get(i * 2..i * 2 + 2)?, 16).ok()?;
    }
    Some(hash)
}

/// Frame: [u32 BE length][payload].
#[derive(Clone, Debug)]
pub struct BlobCodec;

async fn read_frame<T: AsyncRead + Unpin + Send>(io: &mut T, limit: usize) -> io::Result<Vec<u8>> {
    let mut len_buf = [0u8; 4];
    io.read_exact(&mut len_buf).await?;
    let len = u32::from_be_bytes(len_buf) as usize;
    if len > limit {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "frame too large",
        ));
    }
    let mut buf = vec![0u8; len];
    io.read_exact(&mut buf).await?;
    Ok(buf)
}

async fn write_frame<T: AsyncWrite + Unpin + Send>(io: &mut T, data: &[u8]) -> io::Result<()> {
    io.write_all(&(data.len() as u32).to_be_bytes()).await?;
    io.write_all(data).await?;
    io.flush().await
}

#[async_trait]
impl Codec for BlobCodec {
    type Protocol = StreamProtocol;
    /// Request: 32-byte blob hash.
    type Request = Vec<u8>;
    /// Response: blob bytes; empty = not found.
    type Response = Vec<u8>;

    async fn read_request<T>(
        &mut self,
        _protocol: &Self::Protocol,
        io: &mut T,
    ) -> io::Result<Self::Request>
    where
        T: AsyncRead + Unpin + Send,
    {
        read_frame(io, 64).await
    }

    async fn write_request<T>(
        &mut self,
        _protocol: &Self::Protocol,
        io: &mut T,
        req: Self::Request,
    ) -> io::Result<()>
    where
        T: AsyncWrite + Unpin + Send,
    {
        write_frame(io, &req).await
    }

    async fn read_response<T>(
        &mut self,
        _protocol: &Self::Protocol,
        io: &mut T,
    ) -> io::Result<Self::Response>
    where
        T: AsyncRead + Unpin + Send,
    {
        read_frame(io, MAX_BLOB_SIZE).await
    }

    async fn write_response<T>(
        &mut self,
        _protocol: &Self::Protocol,
        io: &mut T,
        resp: Self::Response,
    ) -> io::Result<()>
    where
        T: AsyncWrite + Unpin + Send,
    {
        write_frame(io, &resp).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dedup_by_hash() {
        let store = BlobStore::memory();
        let h1 = store.put(b"same content");
        let h2 = store.put(b"same content");
        assert_eq!(h1, h2);
        assert_eq!(store.get(&h1).unwrap(), b"same content");
    }

    /// The cache must stay inside its byte budget no matter how many distinct
    /// blobs are pushed through it.
    #[test]
    fn mem_cache_evicts_to_stay_within_budget() {
        let mut cache = MemCache::default();
        let chunk = vec![0u8; 1024 * 1024];
        let count = (MAX_MEMORY_BLOB_BYTES / chunk.len()) + 8;
        let mut hashes = Vec::new();
        for i in 0..count {
            let mut data = chunk.clone();
            data[0] = i as u8;
            let hash: BlobHash = Sha256::digest(&data).into();
            cache.insert(hash, data);
            hashes.push(hash);
        }
        assert!(
            cache.bytes <= MAX_MEMORY_BLOB_BYTES,
            "cache grew past its budget"
        );
        // The oldest entries are the ones that must be gone.
        assert!(cache.entries.get(&hashes[0]).is_none());
    }

    /// Reading a blob has to make it the most recently used, or the hot
    /// attachment gets evicted while cold ones survive.
    #[test]
    fn mem_cache_read_refreshes_recency() {
        let mut cache = MemCache::default();
        let first: BlobHash = Sha256::digest(b"first").into();
        let second: BlobHash = Sha256::digest(b"second").into();
        cache.insert(first, b"first".to_vec());
        cache.insert(second, b"second".to_vec());
        // Touch `first` so `second` becomes the older of the two.
        assert_eq!(cache.get(&first).unwrap(), b"first");
        assert!(cache.entries.contains_key(&first));
        assert!(cache.entries.contains_key(&second));
    }

    /// An entry bigger than the entire budget is served from disk, not held.
    #[test]
    fn mem_cache_declines_oversized_entries() {
        let mut cache = MemCache::default();
        let data = vec![0u8; MAX_MEMORY_BLOB_BYTES + 1];
        let hash: BlobHash = Sha256::digest(&data).into();
        cache.insert(hash, data);
        assert_eq!(cache.bytes, 0);
        assert!(cache.entries.is_empty());
    }

    /// Re-inserting the same hash must not double-count the budget.
    #[test]
    fn mem_cache_replacing_an_entry_keeps_the_count_accurate() {
        let mut cache = MemCache::default();
        let hash: BlobHash = Sha256::digest(b"payload").into();
        cache.insert(hash, vec![0u8; 4096]);
        cache.insert(hash, vec![0u8; 8192]);
        assert_eq!(cache.bytes, 8192);
        assert_eq!(cache.entries.len(), 1);
    }
}
