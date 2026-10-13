#![allow(dead_code)]
use ed25519_dalek::SigningKey;
use hourscal_license::dates::Date;
use hourscal_license::fsutil::{random_bytes, random_hex};
use hourscal_license::license::{key_id, sign_token, LicensePayload, FORMAT, FORMAT_VERSION};
use std::path::PathBuf;

pub struct TempDir(pub PathBuf);
impl TempDir {
    pub fn new(tag: &str) -> Self {
        let p = std::env::temp_dir().join(format!("hc-test-{tag}-{}", random_hex(6)));
        std::fs::create_dir_all(&p).unwrap();
        TempDir(p)
    }
}
impl Drop for TempDir {
    fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
}

pub fn keypair() -> SigningKey { SigningKey::from_bytes(&random_bytes::<32>()) }

pub fn payload(sk: &SigningKey, device: &str, expires: Option<&str>) -> LicensePayload {
    LicensePayload {
        format: FORMAT.into(),
        format_version: FORMAT_VERSION,
        license_id: "HCL-2026-TEST01".into(),
        licensee: "עילי נגר".into(),
        organization: Some("Hours-Cal".into()),
        device_id: device.into(),
        scope: "single-device".into(),
        issued_at: "2026-10-13".into(),
        expires_at: expires.map(String::from),
        replaces: None,
        key_id: key_id(&sk.verifying_key()),
    }
}

pub fn issue(sk: &SigningKey, device: &str, expires: Option<&str>) -> String {
    sign_token(&payload(sk, device, expires), sk)
}

pub fn d(s: &str) -> Date { Date::parse(s).unwrap() }

pub fn file_hash(p: &std::path::Path) -> String {
    use sha2::{Digest, Sha256};
    hourscal_license::fsutil::hex(&Sha256::digest(std::fs::read(p).unwrap()))
}

pub const GUID_A: &str = "4c4c4544-0038-3010-8052-b4c04f4a3732";
pub const GUID_B: &str = "9f1e2d3c-1111-2222-3333-444455556666";
