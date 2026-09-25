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
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

pub const BLOB_PROTOCOL: StreamProtocol = StreamProtocol::new("/peers/blob/1.0.0");
/// Caps a single parked blob (64 KiB — enough for many messages; files
/// get real chunking later).
pub const MAX_BLOB_SIZE: usize = 64 * 1024;

/// A blob hash (SHA-256 of the content, torrent-info-hash style).
pub type BlobHash = [u8; 32];

/// Local seed cache: content-addressed by SHA-256. Holds only ciphertext
/// in production use and persists blobs under the platform config directory.
#[derive(Clone)]
pub struct BlobStore {
    inner: Arc<Mutex<HashMap<BlobHash, Vec<u8>>>>,
    root: Option<PathBuf>,
}

impl BlobStore {
    pub fn new() -> Self {
        let root = dirs::config_dir()
            .or_else(dirs::data_local_dir())
            .map(|base| base.join("peers").join("blobs"))
            .filter(|path| fs::create_dir_all(path).is_ok());
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
            root,
        }
    }

    /// In-memory store for tests and callers that explicitly do not want disk.
    pub fn memory() -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
            root: None,
        }
    }

    /// Stores data and returns its hash. Duplicate content dedupes.
    pub fn put(&self, data: &[u8]) -> BlobHash {
        let hash: BlobHash = Sha256::digest(data).into();
        self.inner.lock().unwrap().insert(hash, data.to_vec());
        if let Some(root) = &self.root {
            let path = root.join(hex_name(&hash));
            let _ = fs::write(path, data);
        }
        hash
    }

    pub fn get(&self, hash: &BlobHash) -> Option<Vec<u8>> {
        if let Some(data) = self.inner.lock().unwrap().get(hash).cloned() {
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
}
