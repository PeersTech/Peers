use async_trait::async_trait;
use futures::io::{AsyncReadExt, AsyncWriteExt};
use futures::AsyncRead;
use futures::AsyncWrite;
use libp2p::request_response::Codec;
use libp2p::StreamProtocol;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io;
use std::sync::{Arc, Mutex};

pub const BLOB_PROTOCOL: StreamProtocol = StreamProtocol::new("/peers/blob/1.0.0");
/// Caps a single parked blob (64 KiB — enough for many messages; files
/// get real chunking later).
pub const MAX_BLOB_SIZE: usize = 64 * 1024;

/// A blob hash (SHA-256 of the content, torrent-info-hash style).
pub type BlobHash = [u8; 32];

/// Local seed cache: content-addressed by SHA-256. Holds only ciphertext
/// in production use.
#[derive(Clone, Default)]
pub struct BlobStore {
    inner: Arc<Mutex<HashMap<BlobHash, Vec<u8>>>>,
}

impl BlobStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Stores data and returns its hash. Duplicate content dedupes.
    pub fn put(&self, data: &[u8]) -> BlobHash {
        let hash: BlobHash = Sha256::digest(data).into();
        self.inner.lock().unwrap().insert(hash, data.to_vec());
        hash
    }

    pub fn get(&self, hash: &BlobHash) -> Option<Vec<u8>> {
        self.inner.lock().unwrap().get(hash).cloned()
    }

    pub fn has(&self, hash: &BlobHash) -> bool {
        self.inner.lock().unwrap().contains_key(hash)
    }

    pub fn len(&self) -> usize {
        self.inner.lock().unwrap().len()
    }
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
        let store = BlobStore::new();
        let h1 = store.put(b"same content");
        let h2 = store.put(b"same content");
        assert_eq!(h1, h2);
        assert_eq!(store.len(), 1);
        assert!(store.has(&h1));
        assert_eq!(store.get(&h1).unwrap(), b"same content");
    }
}
