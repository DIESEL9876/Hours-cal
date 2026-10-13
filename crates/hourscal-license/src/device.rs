//! Device activation ID.
//!
//! Windows: `HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid`, hashed with a
//! Hours-Cal–specific domain string. The raw GUID is never displayed, stored
//! or transmitted. Only the derived code (e.g. `HC1-7KQ2-...`) is shown so the
//! user can copy and send it themselves.
//!
//! Stability (see docs/DEVICE_ID.md):
//! * Stable across Hours-Cal uninstall/reinstall/upgrade (it is an OS value).
//! * Changes when Windows itself is reinstalled or reset → replacement licence.
//! * Cloned disk images that were not generalised (sysprep) may share a GUID.
//! * An administrator can edit the value; this is resistance, not proof.
//!
//! If the GUID cannot be read, a random fallback ID is created and stored in
//! the app config dir (`HCF-` prefix). That one does NOT survive deleting the
//! app's config folder.

use crate::fsutil::{atomic_write, hex, random_bytes};
use sha2::{Digest, Sha256};
use std::fs;
use std::io;
use std::path::Path;

const DOMAIN: &[u8] = b"Hours-Cal device activation id v1";
const CROCKFORD: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeviceIdSource {
    WindowsMachineGuid,
    LocalFallback,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeviceId {
    pub code: String,
    pub source: DeviceIdSource,
}

fn base32(bytes: &[u8]) -> String {
    let mut out = String::new();
    let (mut buf, mut bits) = (0u32, 0u32);
    for &b in bytes {
        buf = (buf << 8) | b as u32;
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(CROCKFORD[((buf >> bits) & 31) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(CROCKFORD[((buf << (5 - bits)) & 31) as usize] as char);
    }
    out
}

fn derive(prefix: &str, secret: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(DOMAIN);
    h.update([0u8]);
    h.update(secret);
    let digest = h.finalize();
    let code = base32(&digest[..15]); // 120 bits -> 24 chars
    let groups: Vec<&str> = (0..6).map(|i| &code[i * 4..i * 4 + 4]).collect();
    format!("{prefix}-{}", groups.join("-"))
}

/// Pure derivation from a Windows MachineGuid string (case/whitespace-insensitive).
pub fn from_machine_guid(guid: &str) -> String {
    derive("HC1", guid.trim().to_ascii_lowercase().as_bytes())
}

/// Normalise user-pasted codes: uppercase, drop spaces, map look-alikes.
pub fn normalize_code(s: &str) -> String {
    s.chars()
        .filter(|c| !c.is_whitespace())
        .map(|c| match c.to_ascii_uppercase() {
            'O' => '0',
            'I' | 'L' => '1',
            other => other,
        })
        .collect::<String>()
}

pub fn is_well_formed(code: &str) -> bool {
    let parts: Vec<&str> = code.split('-').collect();
    parts.len() == 7
        && (parts[0] == "HC1" || parts[0] == "HCF")
        && parts[1..].iter().all(|p| p.len() == 4 && p.bytes().all(|b| CROCKFORD.contains(&b)))
}

#[cfg(windows)]
pub fn read_machine_guid() -> Option<String> {
    use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_64KEY};
    let key = winreg::RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey_with_flags("SOFTWARE\\Microsoft\\Cryptography", KEY_READ | KEY_WOW64_64KEY)
        .ok()?;
    let v: String = key.get_value("MachineGuid").ok()?;
    let v = v.trim().to_string();
    if v.is_empty() { None } else { Some(v) }
}

/// Non-Windows builds (owner tool on Linux/macOS, CI): use /etc/machine-id so
/// the owner tool's `device-id` command still works. Not used by the Windows app.
#[cfg(not(windows))]
pub fn read_machine_guid() -> Option<String> {
    fs::read_to_string("/etc/machine-id").ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// Device ID given an (optionally) known OS GUID. Testable without a registry.
pub fn device_id_with(config_dir: &Path, machine_guid: Option<&str>) -> io::Result<DeviceId> {
    if let Some(g) = machine_guid {
        return Ok(DeviceId { code: from_machine_guid(g), source: DeviceIdSource::WindowsMachineGuid });
    }
    let path = config_dir.join("license").join("device-fallback.id");
    let secret = match fs::read_to_string(&path) {
        Ok(s) if s.trim().len() == 32 => s.trim().to_string(),
        _ => {
            let s = hex(&random_bytes::<16>());
            atomic_write(&path, s.as_bytes())?;
            s
        }
    };
    Ok(DeviceId { code: derive("HCF", secret.as_bytes()), source: DeviceIdSource::LocalFallback })
}

pub fn current_device_id(config_dir: &Path) -> io::Result<DeviceId> {
    device_id_with(config_dir, read_machine_guid().as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn deterministic_and_well_formed() {
        let a = from_machine_guid("4c4c4544-0038-3010-8052-b4c04f4a3732");
        let b = from_machine_guid("  4C4C4544-0038-3010-8052-B4C04F4A3732\n");
        assert_eq!(a, b);
        assert!(is_well_formed(&a), "{a}");
        assert_ne!(a, from_machine_guid("4c4c4544-0038-3010-8052-b4c04f4a3733"));
        assert!(!a.to_lowercase().contains("4c4c4544"), "raw GUID must not leak");
    }
    #[test]
    fn normalize_handles_paste() {
        let a = from_machine_guid("x");
        assert_eq!(normalize_code(&format!("  {}  ", a.to_lowercase())), a);
    }
}
