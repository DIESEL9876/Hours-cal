//! Staged enforcement (Hours-Cal integration).
//!
//! The licence requirement is switched on only by a build that embeds the owner's PUBLIC key
//! (`src-tauri/keys/license_public_key.txt`). This lets the owner create the key pair on his own
//! computer, issue and pre-install his own licence, and only then ship a build that enforces it,
//! so the owner's computer is never locked out.
//!
//! * No key line in the file          → `NotConfigured`: legal acceptance (once per version) still
//!   required; licence not required. Data fully usable.
//! * One or more valid key lines       → `Keys`: full enforcement (startup::decide).
//! * Any malformed key line            → `Invalid`: FAIL CLOSED — treated as enforcement with no
//!   trusted key, so no licence validates and only activation / read-only recovery are offered.

use crate::dates::Date;
use crate::fsutil::atomic_write;
use crate::license::{extract_token, public_key_from_text, token_to_file_text, InstallError, LicenseError, LicensePayload, LicenseStore, FORMAT, FORMAT_VERSION};
use crate::startup::{decide, Route, StartupConfig};
use crate::legal::LegalStore;
use crate::device::device_id_with;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine;
use ed25519_dalek::VerifyingKey;

#[derive(Debug, Clone)]
pub enum KeyConfig {
    NotConfigured,
    Keys(Vec<VerifyingKey>),
    Invalid(String),
}

impl KeyConfig {
    pub fn enforced(&self) -> bool {
        !matches!(self, KeyConfig::NotConfigured)
    }
    /// Keys to trust. `Invalid` yields none (fail closed).
    pub fn trusted(&self) -> Vec<VerifyingKey> {
        match self {
            KeyConfig::Keys(k) => k.clone(),
            _ => Vec::new(),
        }
    }
}

/// Parse the embedded public-key file. Each non-empty, non-`#` line is one key (allows rotation).
pub fn parse_key_file(text: &str) -> KeyConfig {
    let lines: Vec<&str> = text.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#')).collect();
    if lines.is_empty() {
        return KeyConfig::NotConfigured;
    }
    let mut keys = Vec::new();
    for l in lines {
        match public_key_from_text(l) {
            Ok(k) => keys.push(k),
            Err(e) => return KeyConfig::Invalid(e),
        }
    }
    KeyConfig::Keys(keys)
}

/// Startup routing honouring the key configuration.
/// `cfg.trusted_keys` must be `keys.trusted()`.
pub fn decide_staged(cfg: &StartupConfig, keys: &KeyConfig) -> std::io::Result<Route> {
    if keys.enforced() {
        return decide(cfg);
    }
    // Not enforced yet: only the per-version legal acceptance gates the app.
    let legal = LegalStore::new(cfg.config_dir);
    let dev = match cfg.machine_guid {
        Some(_) => Some(device_id_with(cfg.config_dir, cfg.machine_guid)?),
        None => None,
    };
    if legal.needs_acceptance(cfg.app_version, cfg.doc, dev.as_ref().map(|d| d.code.as_str())) {
        return Ok(Route::LegalAgreement { app_version: cfg.app_version.into(), doc_version: cfg.doc.doc_version.clone() });
    }
    Ok(Route::Ready { licensee: String::new(), organization: None, license_id: String::new(), expires_at: None })
}

/// Decode a licence WITHOUT checking the signature (pre-enforcement import and status display only).
/// Structure, format, device and dates are checked; trust is established later by `verify`.
pub fn decode_unverified(input: &str, device_id: &str, today: Date) -> Result<LicensePayload, LicenseError> {
    let token = extract_token(input);
    let (p64, s64) = token.split_once('.').ok_or_else(|| LicenseError::Malformed("missing '.'".into()))?;
    let sig = B64.decode(s64).map_err(|e| LicenseError::Malformed(format!("signature: {e}")))?;
    if sig.len() != 64 {
        return Err(LicenseError::Malformed("signature length".into()));
    }
    let bytes = B64.decode(p64).map_err(|e| LicenseError::Malformed(format!("payload: {e}")))?;
    let p: LicensePayload = serde_json::from_slice(&bytes).map_err(|e| LicenseError::Malformed(format!("json: {e}")))?;
    if p.format != FORMAT || p.format_version != FORMAT_VERSION || p.scope != "single-device" {
        return Err(LicenseError::UnsupportedFormat);
    }
    if p.device_id != device_id {
        return Err(LicenseError::WrongDevice { licensed: p.device_id.clone(), this_device: device_id.to_string() });
    }
    Date::parse(&p.issued_at).map_err(LicenseError::Malformed)?;
    if let Some(exp) = &p.expires_at {
        if today > Date::parse(exp).map_err(LicenseError::Malformed)? {
            return Err(LicenseError::Expired { expires_at: exp.clone() });
        }
    }
    Ok(p)
}

/// Store a licence before enforcement is enabled. Nothing is written if the checks fail.
pub fn preinstall(store: &LicenseStore, input: &str, device_id: &str, today: Date) -> Result<LicensePayload, InstallError> {
    let p = decode_unverified(input, device_id, today).map_err(InstallError::Invalid)?;
    if let Some(old) = store.load() {
        let prev = store.path().with_file_name("license.previous.hclic");
        let _ = atomic_write(&prev, old.as_bytes());
    }
    atomic_write(&store.path(), token_to_file_text(&extract_token(input)).as_bytes()).map_err(InstallError::Io)?;
    Ok(p)
}
