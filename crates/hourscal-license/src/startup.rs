//! Startup routing. Never opens the business database.

use crate::dates::Date;
use crate::device::{device_id_with, DeviceId};
use crate::legal::{LegalDocument, LegalStore};
use crate::license::{LicenseStore, VerifyContext};
use ed25519_dalek::VerifyingKey;
use serde::Serialize;
use std::path::Path;

pub struct StartupConfig<'a> {
    pub config_dir: &'a Path,
    pub app_version: &'a str,
    pub doc: &'a LegalDocument,
    pub trusted_keys: &'a [VerifyingKey],
    pub revoked_ids: &'a [String],
    /// Result of `device::read_machine_guid()` in production; injected in tests.
    pub machine_guid: Option<&'a str>,
    pub today: Date,
    pub db_path: &'a Path,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(tag = "route", rename_all = "camelCase")]
pub enum Route {
    /// First launch on this installation, or first launch of a new version.
    LegalAgreement { app_version: String, doc_version: String },
    /// No valid licence. Recovery = read-only export of existing data.
    #[serde(rename_all = "camelCase")]
    Activation { device_id: String, reason_he: Option<String>, recovery_available: bool },
    #[serde(rename_all = "camelCase")]
    Ready { licensee: String, organization: Option<String>, license_id: String, expires_at: Option<String> },
}

pub fn device(cfg: &StartupConfig) -> std::io::Result<DeviceId> {
    device_id_with(cfg.config_dir, cfg.machine_guid)
}

pub fn decide(cfg: &StartupConfig) -> std::io::Result<Route> {
    let legal = LegalStore::new(cfg.config_dir);
    // Read-only device derivation; for the GUID path this writes nothing.
    let dev = match cfg.machine_guid {
        Some(_) => Some(device(cfg)?),
        None => None, // fallback ID would create a file; defer until after acceptance
    };
    if legal.needs_acceptance(cfg.app_version, cfg.doc, dev.as_ref().map(|d| d.code.as_str())) {
        return Ok(Route::LegalAgreement { app_version: cfg.app_version.into(), doc_version: cfg.doc.doc_version.clone() });
    }
    let dev = match dev { Some(d) => d, None => device(cfg)? };
    let ctx = VerifyContext { trusted_keys: cfg.trusted_keys, device_id: &dev.code, today: cfg.today, revoked_ids: cfg.revoked_ids };
    Ok(match LicenseStore::new(cfg.config_dir).check(&ctx) {
        Ok(p) => Route::Ready { licensee: p.licensee, organization: p.organization, license_id: p.license_id, expires_at: p.expires_at },
        Err(e) => Route::Activation {
            device_id: dev.code,
            reason_he: e.map(|e| e.message_he()),
            recovery_available: cfg.db_path.is_file(),
        },
    })
}
