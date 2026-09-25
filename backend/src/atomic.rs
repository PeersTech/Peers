use rand::RngCore;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::Path;

/// Writes a private file atomically where the platform supports replacement.
///
/// Secret state must never be left half-written after a crash or power loss.
pub fn write_private(path: &Path, data: &[u8]) -> io::Result<()> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;

    let mut nonce = [0u8; 8];
    rand::rngs::OsRng.fill_bytes(&mut nonce);
    let temp = parent.join(format!(
        ".{}.tmp-{}",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("state"),
        u64::from_le_bytes(nonce)
    ));

    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }

    let result = (|| {
        let mut file = options.open(&temp)?;
        file.write_all(data)?;
        file.sync_all()?;
        drop(file);

        match fs::rename(&temp, path) {
            Ok(()) => {}
            #[cfg(windows)]
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
                // Windows does not replace an existing destination. The
                // fallback loses replace atomicity, but still never exposes a
                // partially written file.
                fs::remove_file(path)?;
                fs::rename(&temp, path)?;
            }
            Err(e) => return Err(e),
        }

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
            File::open(parent)?.sync_all()?;
        }
        Ok(())
    })();

    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}
