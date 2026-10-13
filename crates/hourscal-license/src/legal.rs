//! One-time-per-version legal acceptance.
//!
//! Shown when: no record, OR the installed app version differs from the
//! accepted one (upgrade or downgrade), OR the agreement text hash differs.
//! Never shown because of restarts, reboots, backups, restores, imports or
//! elapsed time. Stored under `<config_dir>/legal/`, separate from the
//! business database and its backups.

use crate::dates::now_utc_iso;
use crate::fsutil::{atomic_write, hex, uuid_v4};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

pub const AGREEMENT_TEMPLATE: &str = include_str!("../../../legal/agreement_he.md");
pub const RELEASE_CONFIG_JSON: &str = include_str!("../../../legal/release-config.json");
pub const CONTACT_TOKEN: &str = "{{CONTACT_EMAIL}}";
pub const CONTACT_PLACEHOLDER_HE: &str = "[כתובת דוא״ל להשלמה לפני ההפצה]";
pub const CONSENT_LABEL_HE: &str = "קראתי את הסכם הרישיון, תנאי השימוש ומדיניות הפרטיות ואני מסכים/ה להם";

#[derive(Deserialize, Debug, Clone)]
pub struct ReleaseConfig {
    pub legal_doc_version: String,
    pub contact_email: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LegalDocument {
    pub doc_version: String,
    pub text: String,
    pub sha256: String,
}

pub fn looks_like_email(s: &str) -> bool {
    let s = s.trim();
    match s.split_once('@') {
        Some((a, d)) => !a.is_empty() && d.contains('.') && !d.starts_with('.') && !d.ends_with('.')
            && !s.contains(char::is_whitespace) && !d.contains('@'),
        None => false,
    }
}

impl LegalDocument {
    pub fn render(template: &str, doc_version: &str, contact_email: &str) -> LegalDocument {
        let contact = if looks_like_email(contact_email) { contact_email.trim() } else { CONTACT_PLACEHOLDER_HE };
        let text = template.replace(CONTACT_TOKEN, contact);
        let sha256 = hex(&Sha256::digest(text.as_bytes()));
        LegalDocument { doc_version: doc_version.to_string(), text, sha256 }
    }

    pub fn bundled() -> LegalDocument {
        let cfg = bundled_release_config();
        Self::render(AGREEMENT_TEMPLATE, &cfg.legal_doc_version, &cfg.contact_email)
    }

    /// Problems that must be fixed before public distribution.
    pub fn release_problems(&self) -> Vec<String> {
        let mut p = Vec::new();
        if self.text.contains(CONTACT_PLACEHOLDER_HE) || self.text.contains(CONTACT_TOKEN) {
            p.push("legal/release-config.json: contact_email is empty or invalid".into());
        }
        if self.text.contains("{{") {
            p.push("agreement still contains an unfilled {{...}} token".into());
        }
        p
    }
}

pub fn bundled_release_config() -> ReleaseConfig {
    serde_json::from_str(RELEASE_CONFIG_JSON).expect("legal/release-config.json is valid JSON")
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct AcceptanceRecord {
    pub schema_version: u32,
    pub installation_id: String,
    pub app_version: String,
    pub legal_doc_version: String,
    pub legal_sha256: String,
    pub accepted_at_utc: String,
    #[serde(default)]
    pub local_utc_offset_minutes: Option<i32>,
    /// Device activation ID at acceptance time. A record copied to another
    /// computer (e.g. whole app folder copied) does not count there.
    #[serde(default)]
    pub device_id: Option<String>,
}

pub struct LegalStore {
    config_dir: PathBuf,
    dir: PathBuf,
}

impl LegalStore {
    pub fn new(config_dir: &Path) -> Self {
        LegalStore { config_dir: config_dir.to_path_buf(), dir: config_dir.join("legal") }
    }

    /// Random per-installation UUID, created once, never derived from hardware.
    pub fn installation_id(&self) -> io::Result<String> {
        let path = self.config_dir.join("installation-id.txt");
        if let Ok(s) = fs::read_to_string(&path) {
            let s = s.trim();
            if s.len() == 36 {
                return Ok(s.to_string());
            }
        }
        let id = uuid_v4();
        atomic_write(&path, id.as_bytes())?;
        Ok(id)
    }

    /// Current record. Unreadable/corrupt → None (agreement is shown again;
    /// nothing else is affected).
    pub fn current(&self) -> Option<AcceptanceRecord> {
        let raw = fs::read_to_string(self.dir.join("acceptance.json")).ok()?;
        serde_json::from_str(&raw).ok()
    }

    pub fn needs_acceptance(&self, app_version: &str, doc: &LegalDocument, device_id: Option<&str>) -> bool {
        match self.current() {
            Some(r) => {
                r.app_version != app_version
                    || r.legal_sha256 != doc.sha256
                    || matches!((r.device_id.as_deref(), device_id), (Some(a), Some(b)) if a != b)
            }
            None => true,
        }
    }

    /// Record explicit acceptance. Writes the accepted text copy and history
    /// first; `acceptance.json` is written last (commit point).
    pub fn accept(&self, app_version: &str, doc: &LegalDocument, local_utc_offset_minutes: Option<i32>, device_id: Option<&str>) -> io::Result<AcceptanceRecord> {
        let offset = local_utc_offset_minutes.filter(|m| (-14 * 60..=14 * 60).contains(m));
        let rec = AcceptanceRecord {
            schema_version: 1,
            installation_id: self.installation_id()?,
            app_version: app_version.to_string(),
            legal_doc_version: doc.doc_version.clone(),
            legal_sha256: doc.sha256.clone(),
            accepted_at_utc: now_utc_iso(),
            local_utc_offset_minutes: offset,
            device_id: device_id.map(String::from),
        };
        let text_path = self.dir.join("accepted-texts").join(format!("{}.md", doc.sha256));
        if !text_path.exists() {
            atomic_write(&text_path, doc.text.as_bytes())?;
        }
        fs::create_dir_all(&self.dir)?;
        let mut hist = OpenOptions::new().create(true).append(true).open(self.dir.join("acceptance-history.jsonl"))?;
        writeln!(hist, "{}", serde_json::to_string(&rec).expect("serialise"))?;
        hist.sync_all()?;
        atomic_write(&self.dir.join("acceptance.json"), serde_json::to_string_pretty(&rec).expect("serialise").as_bytes())?;
        Ok(rec)
    }

    pub fn history(&self) -> Vec<AcceptanceRecord> {
        fs::read_to_string(self.dir.join("acceptance-history.jsonl"))
            .map(|s| s.lines().filter_map(|l| serde_json::from_str(l).ok()).collect())
            .unwrap_or_default()
    }

    /// Exact text that was accepted, for the read-only history view.
    pub fn accepted_text(&self, sha256: &str) -> Option<String> {
        if sha256.len() != 64 || !sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        fs::read_to_string(self.dir.join("accepted-texts").join(format!("{sha256}.md"))).ok()
    }
}
