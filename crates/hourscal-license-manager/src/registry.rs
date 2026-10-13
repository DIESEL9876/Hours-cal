//! Local registry of issued licences (SQLite, `registry.sqlite3` in the License Manager data folder).
//! Stores only public data: the signed licence token (= the .hclic content), never the private key.

use ed25519_dalek::VerifyingKey;
use hourscal_license::dates::{now_utc_iso, Date};
use hourscal_license::license::{verify, LicenseError, VerifyContext};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LicenseRecord {
    pub license_id: String,
    pub licensee: String,
    pub device_id: String,
    pub nickname: Option<String>,
    /// "perpetual" | "limited"
    pub license_type: String,
    pub issued_at: String,
    pub expires_at: Option<String>,
    pub notes: Option<String>,
    /// Where the .hclic was first written.
    pub file_path: Option<String>,
    /// Signed licence token (public; same content as the .hclic file).
    pub token: String,
    pub replaces: Option<String>,
    pub key_id: String,
    pub revoked_at: Option<String>,
    pub revoke_reason: Option<String>,
    pub created_at: String,
}

pub struct Registry {
    conn: Connection,
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS licenses (
  license_id TEXT PRIMARY KEY,
  licensee TEXT NOT NULL,
  device_id TEXT NOT NULL,
  nickname TEXT,
  license_type TEXT NOT NULL CHECK (license_type IN ('perpetual','limited')),
  issued_at TEXT NOT NULL,
  expires_at TEXT,
  notes TEXT,
  file_path TEXT,
  token TEXT NOT NULL,
  replaces TEXT,
  key_id TEXT NOT NULL,
  revoked_at TEXT,
  revoke_reason TEXT,
  created_at TEXT NOT NULL,
  CHECK ((license_type = 'perpetual' AND expires_at IS NULL) OR (license_type = 'limited' AND expires_at IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, action TEXT NOT NULL, license_id TEXT, detail TEXT);
";

fn row(r: &rusqlite::Row) -> rusqlite::Result<LicenseRecord> {
    Ok(LicenseRecord {
        license_id: r.get("license_id")?,
        licensee: r.get("licensee")?,
        device_id: r.get("device_id")?,
        nickname: r.get("nickname")?,
        license_type: r.get("license_type")?,
        issued_at: r.get("issued_at")?,
        expires_at: r.get("expires_at")?,
        notes: r.get("notes")?,
        file_path: r.get("file_path")?,
        token: r.get("token")?,
        replaces: r.get("replaces")?,
        key_id: r.get("key_id")?,
        revoked_at: r.get("revoked_at")?,
        revoke_reason: r.get("revoke_reason")?,
        created_at: r.get("created_at")?,
    })
}

impl Registry {
    pub fn open(path: &Path) -> rusqlite::Result<Registry> {
        if let Some(d) = path.parent() {
            let _ = std::fs::create_dir_all(d);
        }
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "FULL")?;
        conn.execute_batch(SCHEMA)?;
        Ok(Registry { conn })
    }

    pub fn insert(&self, r: &LicenseRecord) -> rusqlite::Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO licenses (license_id, licensee, device_id, nickname, license_type, issued_at, expires_at, notes, file_path, token, replaces, key_id, revoked_at, revoke_reason, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
            params![r.license_id, r.licensee, r.device_id, r.nickname, r.license_type, r.issued_at, r.expires_at, r.notes, r.file_path, r.token, r.replaces, r.key_id, r.revoked_at, r.revoke_reason, r.created_at],
        )?;
        tx.execute("INSERT INTO audit (at, action, license_id, detail) VALUES (?1, 'issue', ?2, ?3)", params![now_utc_iso(), r.license_id, r.licensee])?;
        tx.commit()
    }

    pub fn all(&self) -> rusqlite::Result<Vec<LicenseRecord>> {
        let mut st = self.conn.prepare("SELECT * FROM licenses ORDER BY issued_at DESC, created_at DESC")?;
        let rows = st.query_map([], row)?.collect();
        rows
    }

    pub fn get(&self, id: &str) -> rusqlite::Result<Option<LicenseRecord>> {
        self.conn.query_row("SELECT * FROM licenses WHERE license_id = ?1", [id], row).optional()
    }

    pub fn set_revoked(&self, id: &str, revoked: bool, reason: Option<&str>) -> rusqlite::Result<bool> {
        let tx = self.conn.unchecked_transaction()?;
        let n = if revoked {
            tx.execute("UPDATE licenses SET revoked_at = ?2, revoke_reason = ?3 WHERE license_id = ?1", params![id, now_utc_iso(), reason])?
        } else {
            tx.execute("UPDATE licenses SET revoked_at = NULL, revoke_reason = NULL WHERE license_id = ?1", params![id])?
        };
        tx.execute("INSERT INTO audit (at, action, license_id, detail) VALUES (?1, ?2, ?3, ?4)", params![now_utc_iso(), if revoked { "revoke" } else { "unrevoke" }, id, reason])?;
        tx.commit()?;
        Ok(n == 1)
    }

    pub fn update_file_path(&self, id: &str, path: &str) -> rusqlite::Result<()> {
        self.conn.execute("UPDATE licenses SET file_path = COALESCE(file_path, ?2) WHERE license_id = ?1", params![id, path])?;
        Ok(())
    }

    /// Add records that are not present yet (restore from backup). Returns how many were added.
    pub fn merge(&self, recs: &[LicenseRecord]) -> rusqlite::Result<usize> {
        let mut added = 0;
        for r in recs {
            if self.get(&r.license_id)?.is_none() {
                self.insert(r)?;
                added += 1;
            }
        }
        Ok(added)
    }

    pub fn setting(&self, key: &str) -> rusqlite::Result<Option<String>> {
        self.conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| r.get(0)).optional()
    }

    pub fn set_setting(&self, key: &str, value: &str) -> rusqlite::Result<()> {
        self.conn.execute("INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value", params![key, value])?;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Status (computed, never just stored)
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LicenseStatus {
    /// Signature verifies with the configured key, not expired, not revoked/replaced.
    Valid,
    Expired,
    /// Marked revoked by the owner (effective only in Hours-Cal builds that include it in the revocation list).
    Revoked,
    /// A newer licence replaces it.
    Replaced,
    /// Cannot be verified with the configured key (different key, damaged token).
    Unverifiable,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LicenseView {
    #[serde(flatten)]
    pub record: LicenseRecord,
    pub status: LicenseStatus,
    pub status_he: String,
    pub replaced_by: Option<String>,
    /// Older licences this one replaces, nearest first.
    pub replaces_chain: Vec<String>,
}

pub fn views(records: &[LicenseRecord], key: Option<&VerifyingKey>, today: Date) -> Vec<LicenseView> {
    let by_id: HashMap<&str, &LicenseRecord> = records.iter().map(|r| (r.license_id.as_str(), r)).collect();
    let mut replaced_by: HashMap<&str, &str> = HashMap::new();
    for r in records {
        if let Some(old) = r.replaces.as_deref() {
            replaced_by.insert(old, r.license_id.as_str());
        }
    }
    records
        .iter()
        .map(|r| {
            let mut chain = Vec::new();
            let mut cur = r.replaces.clone();
            while let Some(id) = cur {
                if chain.contains(&id) || chain.len() > 50 {
                    break;
                }
                cur = by_id.get(id.as_str()).and_then(|p| p.replaces.clone());
                chain.push(id);
            }
            let (status, status_he) = status_of(r, key, today, replaced_by.get(r.license_id.as_str()).copied());
            LicenseView { record: r.clone(), status, status_he, replaced_by: replaced_by.get(r.license_id.as_str()).map(|s| s.to_string()), replaces_chain: chain }
        })
        .collect()
}

fn status_of(r: &LicenseRecord, key: Option<&VerifyingKey>, today: Date, replaced_by: Option<&str>) -> (LicenseStatus, String) {
    if r.revoked_at.is_some() {
        return (LicenseStatus::Revoked, "בוטל (יחול רק בגרסת Hours-Cal שתכלול את רשימת הביטולים)".into());
    }
    if let Some(n) = replaced_by {
        return (LicenseStatus::Replaced, format!("הוחלף ברישיון {n}"));
    }
    let Some(k) = key else { return (LicenseStatus::Unverifiable, "לא ניתן לאמת – מפתח החתימה אינו זמין".into()) };
    let keys = [*k];
    match verify(&r.token, &VerifyContext { trusted_keys: &keys, device_id: &r.device_id, today, revoked_ids: &[] }) {
        Ok(_) => (LicenseStatus::Valid, if r.license_type == "perpetual" { "תקף – ללא הגבלת זמן".into() } else { format!("תקף עד {}", r.expires_at.clone().unwrap_or_default()) }),
        Err(LicenseError::Expired { expires_at }) => (LicenseStatus::Expired, format!("פג תוקף ב-{expires_at}")),
        Err(LicenseError::BadSignature) => (LicenseStatus::Unverifiable, "נחתם במפתח אחר – לא יתקבל בגרסה עם המפתח הנוכחי".into()),
        Err(e) => (LicenseStatus::Unverifiable, e.message_he()),
    }
}

#[derive(Serialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub total: usize,
    pub perpetual: usize,
    pub limited: usize,
    pub valid: usize,
    pub expired: usize,
    pub revoked: usize,
    pub replaced: usize,
    pub unverifiable: usize,
}

pub fn stats(v: &[LicenseView]) -> Stats {
    let mut s = Stats { total: v.len(), ..Default::default() };
    for x in v {
        if x.record.license_type == "perpetual" {
            s.perpetual += 1;
        } else {
            s.limited += 1;
        }
        match x.status {
            LicenseStatus::Valid => s.valid += 1,
            LicenseStatus::Expired => s.expired += 1,
            LicenseStatus::Revoked => s.revoked += 1,
            LicenseStatus::Replaced => s.replaced += 1,
            LicenseStatus::Unverifiable => s.unverifiable += 1,
        }
    }
    s
}

/// Text for `src-tauri/keys/revoked-licenses.txt` of the Hours-Cal project.
pub fn revocation_list_text(records: &[LicenseRecord]) -> String {
    let mut out = String::from(
        "# Hours-Cal revoked / replaced licence IDs (one per line).\n\
         # Exported by Hours-Cal License Manager. Takes effect ONLY in Hours-Cal builds that include this\n\
         # file, and only on computers that install such a build. Offline licences cannot be revoked remotely.\n",
    );
    for r in records.iter().filter(|r| r.revoked_at.is_some()) {
        out.push_str(&r.license_id);
        out.push('\n');
    }
    out
}
