//! The owner's signing-key vault.
//!
//! Layout under the License Manager data folder (`%LOCALAPPDATA%\il.owner.hourscal.licensemanager`):
//!   keys/owner-signing-key.json   protected private key + public info (never shown in the UI)
//!   owner-profile.json            public record of the configured key (survives key-file loss)
//!   license_public_key.txt        the PUBLIC key, in the format Hours-Cal embeds
//!
//! Rules:
//! * A key is created only by an explicit call to `create`. Never implicitly.
//! * Once a key has been configured (`owner-profile.json` exists), creating a different key requires
//!   the typed confirmation `CONFIRM_NEW_KEY`, because licences signed by a new key are rejected by
//!   Hours-Cal builds that embed the old public key.
//! * The private key is never returned to callers outside this crate and never logged.

use crate::protect;
use base64::engine::general_purpose::{STANDARD as B64S, URL_SAFE_NO_PAD as B64};
use base64::Engine;
use ed25519_dalek::{SigningKey, VerifyingKey};
use hourscal_license::dates::now_utc_iso;
use hourscal_license::fsutil::{atomic_write, random_bytes};
use hourscal_license::license::{key_id, public_key_from_text, public_key_to_text};
use serde::{Deserialize, Serialize};
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use zeroize::Zeroizing;

pub const CONFIRM_NEW_KEY: &str = "מפתח חדש";
const KEY_FORMAT: &str = "hourscal-owner-signing-key";

#[derive(Debug)]
pub enum VaultError {
    AlreadyConfigured { key_id: String },
    ConfirmationRequired { previous_key_id: String },
    NotConfigured,
    KeyUnavailable(String),
    DifferentKey { configured: String, offered: String },
    InvalidKeyFile(String),
    Io(std::io::Error),
}

impl VaultError {
    pub fn message_he(&self) -> String {
        match self {
            VaultError::AlreadyConfigured { key_id } => format!("כבר מוגדר מפתח חתימה ({key_id}). לא נוצר מפתח חדש."),
            VaultError::ConfirmationRequired { previous_key_id } => format!(
                "בעבר הוגדר מפתח חתימה אחר ({previous_key_id}). רישיונות שייחתמו במפתח חדש לא יתקבלו בגרסאות Hours-Cal שמכילות את המפתח הקודם. כדי להמשיך יש להקליד \"{CONFIRM_NEW_KEY}\"."
            ),
            VaultError::NotConfigured => "טרם הוגדר מפתח חתימה.".into(),
            VaultError::KeyUnavailable(e) => format!("לא ניתן לפתוח את מפתח החתימה במחשב זה ({e}). יש לשחזר אותו מגיבוי."),
            VaultError::DifferentKey { configured, offered } => format!(
                "המפתח בגיבוי ({offered}) שונה מהמפתח המוגדר ({configured}). כל הרישיונות חייבים להיחתם באותו מפתח, ולכן השחזור נחסם."
            ),
            VaultError::InvalidKeyFile(e) => format!("קובץ המפתח אינו תקין: {e}"),
            VaultError::Io(e) => format!("שגיאת קובץ: {e}"),
        }
    }
}

impl fmt::Display for VaultError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message_he())
    }
}
impl std::error::Error for VaultError {}
impl From<std::io::Error> for VaultError {
    fn from(e: std::io::Error) -> Self {
        VaultError::Io(e)
    }
}

#[derive(Serialize, Deserialize)]
struct KeyFile {
    format: String,
    version: u32,
    protection: String,
    key_id: String,
    public_key: String,
    created_at: String,
    protected_key_b64: String,
}

/// Public, non-secret description of the configured key.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KeyInfo {
    pub key_id: String,
    pub public_key: String,
    pub created_at: String,
    pub protection: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum VaultState {
    /// First launch: no key has ever been configured here.
    NoKey,
    /// Key present and usable.
    Ready,
    /// A key was configured (profile exists) but cannot be opened (file missing, other Windows user,
    /// Windows reinstalled...). Restore from backup. Never auto-regenerated.
    KeyUnavailable,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    pub state: VaultState,
    pub key: Option<KeyInfo>,
    /// Key recorded in owner-profile.json (also when the key file is unavailable).
    pub configured_key_id: Option<String>,
    pub problem: Option<String>,
    pub public_key_path: String,
}

pub struct Vault {
    dir: PathBuf,
}

impl Vault {
    pub fn new(dir: &Path) -> Vault {
        Vault { dir: dir.to_path_buf() }
    }
    pub fn dir(&self) -> &Path {
        &self.dir
    }
    fn key_path(&self) -> PathBuf {
        self.dir.join("keys").join("owner-signing-key.json")
    }
    fn profile_path(&self) -> PathBuf {
        self.dir.join("owner-profile.json")
    }
    pub fn public_key_path(&self) -> PathBuf {
        self.dir.join("license_public_key.txt")
    }

    fn profile(&self) -> Option<KeyInfo> {
        serde_json::from_str(&fs::read_to_string(self.profile_path()).ok()?).ok()
    }

    fn read_key_file(&self) -> Result<KeyFile, VaultError> {
        let raw = fs::read_to_string(self.key_path()).map_err(|e| VaultError::KeyUnavailable(e.to_string()))?;
        let kf: KeyFile = serde_json::from_str(&raw).map_err(|e| VaultError::KeyUnavailable(format!("json: {e}")))?;
        if kf.format != KEY_FORMAT || kf.version != 1 {
            return Err(VaultError::KeyUnavailable("unsupported key file".into()));
        }
        Ok(kf)
    }

    /// Decrypts the private key. Crate-internal: only issuance and backup use it.
    pub(crate) fn signing_key(&self) -> Result<SigningKey, VaultError> {
        if !self.key_path().exists() {
            return Err(if self.profile().is_some() { VaultError::KeyUnavailable("קובץ המפתח חסר".into()) } else { VaultError::NotConfigured });
        }
        let kf = self.read_key_file()?;
        let blob = Zeroizing::new(B64S.decode(&kf.protected_key_b64).map_err(|e| VaultError::KeyUnavailable(e.to_string()))?);
        let seed = protect::unprotect(&blob).map_err(|e| VaultError::KeyUnavailable(e.to_string()))?;
        let arr: Zeroizing<[u8; 32]> = Zeroizing::new(seed.as_slice().try_into().map_err(|_| VaultError::KeyUnavailable("אורך מפתח שגוי".into()))?);
        let sk = SigningKey::from_bytes(&arr);
        // Integrity: the decrypted key must match the recorded public key.
        if key_id(&sk.verifying_key()) != kf.key_id || public_key_to_text(&sk.verifying_key()) != kf.public_key {
            return Err(VaultError::KeyUnavailable("המפתח אינו תואם לנתונים השמורים".into()));
        }
        Ok(sk)
    }

    pub fn status(&self) -> VaultStatus {
        let configured = self.profile();
        let public_key_path = self.public_key_path().display().to_string();
        match self.signing_key() {
            Ok(sk) => {
                let kf = self.read_key_file().ok();
                VaultStatus {
                    state: VaultState::Ready,
                    key: Some(KeyInfo {
                        key_id: key_id(&sk.verifying_key()),
                        public_key: public_key_to_text(&sk.verifying_key()),
                        created_at: kf.as_ref().map(|k| k.created_at.clone()).unwrap_or_default(),
                        protection: kf.map(|k| k.protection).unwrap_or_default(),
                    }),
                    configured_key_id: configured.map(|c| c.key_id),
                    problem: None,
                    public_key_path,
                }
            }
            Err(VaultError::NotConfigured) => VaultStatus { state: VaultState::NoKey, key: None, configured_key_id: None, problem: None, public_key_path },
            Err(e) => VaultStatus {
                state: if configured.is_some() || self.key_path().exists() { VaultState::KeyUnavailable } else { VaultState::NoKey },
                key: None,
                configured_key_id: configured.map(|c| c.key_id),
                problem: Some(e.message_he()),
                public_key_path,
            },
        }
    }

    pub fn verifying_key(&self) -> Result<VerifyingKey, VaultError> {
        Ok(self.signing_key()?.verifying_key())
    }

    /// Guard shared by create / import / restore. `offered` = key about to be stored.
    fn check_can_store(&self, offered: &VerifyingKey, confirm: Option<&str>) -> Result<(), VaultError> {
        let offered_id = key_id(offered);
        if let Ok(existing) = self.signing_key() {
            let existing_id = key_id(&existing.verifying_key());
            return if existing_id == offered_id {
                Ok(()) // same key: harmless repair
            } else {
                Err(VaultError::DifferentKey { configured: existing_id, offered: offered_id })
            };
        }
        if let Some(p) = self.profile() {
            if p.key_id != offered_id && confirm.map(str::trim) != Some(CONFIRM_NEW_KEY) {
                return Err(VaultError::ConfirmationRequired { previous_key_id: p.key_id });
            }
        }
        Ok(())
    }

    /// Explicit first-time key creation. Never called automatically.
    pub fn create(&self, confirm: Option<&str>) -> Result<KeyInfo, VaultError> {
        if let Ok(sk) = self.signing_key() {
            return Err(VaultError::AlreadyConfigured { key_id: key_id(&sk.verifying_key()) });
        }
        if let Some(p) = self.profile() {
            if confirm.map(str::trim) != Some(CONFIRM_NEW_KEY) {
                return Err(VaultError::ConfirmationRequired { previous_key_id: p.key_id });
            }
        }
        let seed = Zeroizing::new(random_bytes::<32>());
        let sk = SigningKey::from_bytes(&seed);
        self.store(&sk, &now_utc_iso())
    }

    /// Import the private key created earlier by the command-line owner tool
    /// (`hourscal-signing-key.PRIVATE.txt`). The same key keeps all existing licences valid.
    pub fn import_cli_key_text(&self, text: &str, confirm: Option<&str>) -> Result<KeyInfo, VaultError> {
        let line = Zeroizing::new(
            text.lines().map(str::trim).find(|l| !l.is_empty() && !l.starts_with('#')).ok_or_else(|| VaultError::InvalidKeyFile("הקובץ ריק".into()))?.to_string(),
        );
        let bytes = Zeroizing::new(B64.decode(line.as_bytes()).map_err(|_| VaultError::InvalidKeyFile("אין זה קובץ מפתח פרטי של Hours-Cal".into()))?);
        let arr: Zeroizing<[u8; 32]> = Zeroizing::new(bytes.as_slice().try_into().map_err(|_| VaultError::InvalidKeyFile("אורך מפתח שגוי".into()))?);
        let sk = SigningKey::from_bytes(&arr);
        let created = text.lines().find_map(|l| l.trim().strip_prefix("# created:").map(|s| s.trim().to_string())).unwrap_or_else(now_utc_iso);
        self.check_can_store(&sk.verifying_key(), confirm)?;
        self.store(&sk, &created)
    }

    /// Store a key that came from a decrypted backup (backup.rs).
    pub(crate) fn store_restored(&self, sk: &SigningKey, created_at: &str, confirm: Option<&str>) -> Result<KeyInfo, VaultError> {
        self.check_can_store(&sk.verifying_key(), confirm)?;
        self.store(sk, created_at)
    }

    fn store(&self, sk: &SigningKey, created_at: &str) -> Result<KeyInfo, VaultError> {
        let vk = sk.verifying_key();
        let seed = Zeroizing::new(sk.to_bytes());
        let protected = protect::protect(seed.as_slice())?;
        let info = KeyInfo { key_id: key_id(&vk), public_key: public_key_to_text(&vk), created_at: created_at.to_string(), protection: protect::PROTECTION.to_string() };
        let kf = KeyFile {
            format: KEY_FORMAT.into(),
            version: 1,
            protection: info.protection.clone(),
            key_id: info.key_id.clone(),
            public_key: info.public_key.clone(),
            created_at: info.created_at.clone(),
            protected_key_b64: B64S.encode(&protected),
        };
        let key_path = self.key_path();
        atomic_write(&key_path, serde_json::to_string_pretty(&kf).expect("serialise").as_bytes())?;
        protect::restrict_permissions(&key_path);
        atomic_write(&self.profile_path(), serde_json::to_string_pretty(&info).expect("serialise").as_bytes())?;
        atomic_write(&self.public_key_path(), public_key_file_text(&vk).as_bytes())?;
        // Read back through the normal path: proves the stored key decrypts and matches.
        let check = self.signing_key()?;
        if key_id(&check.verifying_key()) != info.key_id {
            return Err(VaultError::KeyUnavailable("אימות המפתח השמור נכשל".into()));
        }
        Ok(info)
    }

    pub fn public_key_text(&self) -> Result<String, VaultError> {
        Ok(public_key_file_text(&self.verifying_key()?))
    }
}

/// Exactly the format `hourscal-license-tool keygen` writes and Hours-Cal parses.
pub fn public_key_file_text(vk: &VerifyingKey) -> String {
    format!("# Hours-Cal licence PUBLIC key ({})\n{}\n", key_id(vk), public_key_to_text(vk))
}

/// Parse a public key file (for verification of exported files in tests and the UI).
pub fn parse_public_key_file(text: &str) -> Result<VerifyingKey, String> {
    public_key_from_text(text)
}
