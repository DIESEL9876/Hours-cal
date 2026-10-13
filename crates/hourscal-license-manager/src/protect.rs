//! At-rest protection of the private signing key.
//!
//! * Windows: DPAPI (`CryptProtectData`, current-user scope) with an application-specific entropy
//!   string. The protected blob can only be decrypted by the same Windows user on the same computer.
//!   Moving the key to another computer requires an explicit, passphrase-encrypted backup (backup.rs).
//! * Other platforms (development / CI only — the License Manager is shipped for Windows): the key is
//!   stored unencrypted in a file readable only by the current user (0600). Marked `plain-dev`.

use std::io;
use zeroize::Zeroizing;

#[cfg_attr(not(windows), allow(dead_code))]
const ENTROPY: &[u8] = b"Hours-Cal License Manager signing key v1";

#[cfg(windows)]
pub const PROTECTION: &str = "dpapi-user";
#[cfg(not(windows))]
pub const PROTECTION: &str = "plain-dev";

#[cfg(windows)]
mod imp {
    use super::ENTROPY;
    use std::io;
    use std::ptr;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };
    use zeroize::Zeroizing;

    fn blob(data: &[u8]) -> CRYPT_INTEGER_BLOB {
        CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 }
    }

    unsafe fn take(out: CRYPT_INTEGER_BLOB) -> Vec<u8> {
        let v = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
        // Wipe the OS-allocated buffer before freeing it.
        std::ptr::write_bytes(out.pbData, 0, out.cbData as usize);
        LocalFree(out.pbData as _);
        v
    }

    pub fn protect(secret: &[u8]) -> io::Result<Vec<u8>> {
        let input = blob(secret);
        let entropy = blob(ENTROPY);
        let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: ptr::null_mut() };
        let ok = unsafe { CryptProtectData(&input, ptr::null(), &entropy, ptr::null(), ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out) };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(unsafe { take(out) })
    }

    pub fn unprotect(data: &[u8]) -> io::Result<Zeroizing<Vec<u8>>> {
        let input = blob(data);
        let entropy = blob(ENTROPY);
        let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: ptr::null_mut() };
        let ok = unsafe { CryptUnprotectData(&input, ptr::null_mut(), &entropy, ptr::null(), ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out) };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Zeroizing::new(unsafe { take(out) }))
    }
}

#[cfg(not(windows))]
mod imp {
    use std::io;
    use zeroize::Zeroizing;
    pub fn protect(secret: &[u8]) -> io::Result<Vec<u8>> {
        Ok(secret.to_vec())
    }
    pub fn unprotect(data: &[u8]) -> io::Result<Zeroizing<Vec<u8>>> {
        Ok(Zeroizing::new(data.to_vec()))
    }
}

pub fn protect(secret: &[u8]) -> io::Result<Vec<u8>> {
    imp::protect(secret)
}

pub fn unprotect(data: &[u8]) -> io::Result<Zeroizing<Vec<u8>>> {
    imp::unprotect(data)
}

/// Restrict a file to the current user where the platform supports it (non-Windows dev builds).
pub fn restrict_permissions(path: &std::path::Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    let _ = path;
}
