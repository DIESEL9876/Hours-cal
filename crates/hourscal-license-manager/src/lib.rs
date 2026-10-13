//! Hours-Cal License Manager core (OWNER-ONLY).
//!
//! Reuses the existing licensing protocol from `hourscal-license` unchanged (Ed25519 signed tokens,
//! device IDs, `verify`). Adds: a protected key vault, licence issuance with self-verification,
//! a local registry, and passphrase-encrypted portable key backups.
//!
//! The private key is decrypted only inside this crate (`Vault::signing_key` is crate-private),
//! is never returned through the public API, never logged and never written to licence files,
//! the registry, or the public-key export.

pub mod backup;
pub mod issue;
pub mod protect;
pub mod registry;
pub mod vault;

use hourscal_license::dates::Date;
use registry::{stats, views, LicenseView, Registry, Stats};
use std::path::{Path, PathBuf};
use vault::Vault;

pub struct Manager {
    pub vault: Vault,
    pub registry: Registry,
}

impl Manager {
    pub fn open(data_dir: &Path) -> Result<Manager, String> {
        std::fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
        Ok(Manager { vault: Vault::new(data_dir), registry: Registry::open(&data_dir.join("registry.sqlite3")).map_err(|e| e.to_string())? })
    }

    pub fn list(&self, today: Date) -> Result<Vec<LicenseView>, String> {
        let recs = self.registry.all().map_err(|e| e.to_string())?;
        let vk = self.vault.verifying_key().ok();
        Ok(views(&recs, vk.as_ref(), today))
    }

    pub fn stats(&self, today: Date) -> Result<Stats, String> {
        Ok(stats(&self.list(today)?))
    }

    /// Folder for new .hclic files (owner-configurable; default supplied by the caller).
    pub fn license_dir(&self, default: &Path) -> PathBuf {
        self.registry.setting("license_dir").ok().flatten().map(PathBuf::from).unwrap_or_else(|| default.to_path_buf())
    }
}
