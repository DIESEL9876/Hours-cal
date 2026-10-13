//! Portable, passphrase-encrypted backup of the signing key (+ the licence registry).
//!
//! File: `*.hckeybak` (JSON). Key derivation Argon2id (64 MiB, 3 passes); encryption
//! XChaCha20-Poly1305 with the public header as associated data (any change → rejected).
//! Created only on explicit user request; restoring requires the same passphrase.

use crate::registry::{LicenseRecord, Registry};
use crate::vault::{KeyInfo, Vault, VaultError};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::engine::general_purpose::STANDARD as B64S;
use base64::Engine;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use ed25519_dalek::SigningKey;
use hourscal_license::dates::now_utc_iso;
use hourscal_license::fsutil::{atomic_write, random_bytes};
use hourscal_license::license::key_id;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use zeroize::Zeroizing;

pub const MIN_PASSPHRASE_CHARS: usize = 12;
const FORMAT: &str = "hourscal-owner-key-backup";
const M_COST_KIB: u32 = 64 * 1024;
const T_COST: u32 = 3;

#[derive(Serialize, Deserialize, Clone)]
struct Header {
    format: String,
    version: u32,
    key_id: String,
    created_at: String,
    kdf: String,
    m_cost_kib: u32,
    t_cost: u32,
    p_cost: u32,
    salt_b64: String,
    cipher: String,
    nonce_b64: String,
}

#[derive(Serialize, Deserialize)]
struct BackupFile {
    #[serde(flatten)]
    header: Header,
    ciphertext_b64: String,
}

#[derive(Serialize, Deserialize)]
struct Secret {
    private_key_b64: String,
    key_created_at: String,
    licenses: Vec<LicenseRecord>,
}

#[derive(Debug)]
pub enum BackupError {
    WeakPassphrase,
    WrongPassphraseOrCorrupt,
    NotABackup(String),
    Vault(VaultError),
    Io(std::io::Error),
    Registry(String),
}

impl BackupError {
    pub fn message_he(&self) -> String {
        match self {
            BackupError::WeakPassphrase => format!("סיסמת הגיבוי חייבת לכלול לפחות {MIN_PASSPHRASE_CHARS} תווים."),
            BackupError::WrongPassphraseOrCorrupt => "הסיסמה שגויה או שקובץ הגיבוי פגום או שונה. לא שוחזר דבר.".into(),
            BackupError::NotABackup(e) => format!("הקובץ אינו גיבוי מפתחות של Hours-Cal License Manager ({e})."),
            BackupError::Vault(e) => e.message_he(),
            BackupError::Io(e) => format!("שגיאת קובץ: {e}"),
            BackupError::Registry(e) => format!("שגיאה ברשומת הרישיונות: {e}"),
        }
    }
}
impl std::fmt::Display for BackupError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message_he())
    }
}
impl From<VaultError> for BackupError {
    fn from(e: VaultError) -> Self {
        BackupError::Vault(e)
    }
}
impl From<std::io::Error> for BackupError {
    fn from(e: std::io::Error) -> Self {
        BackupError::Io(e)
    }
}

fn derive(passphrase: &str, salt: &[u8], m: u32, t: u32, p: u32) -> Result<Zeroizing<[u8; 32]>, BackupError> {
    let params = Params::new(m, t, p, Some(32)).map_err(|e| BackupError::NotABackup(e.to_string()))?;
    let mut out = Zeroizing::new([0u8; 32]);
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(passphrase.as_bytes(), salt, out.as_mut())
        .map_err(|e| BackupError::NotABackup(e.to_string()))?;
    Ok(out)
}

fn aad(h: &Header) -> Vec<u8> {
    serde_json::to_vec(h).expect("serialise header")
}

/// Summary returned to the UI (no secrets).
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BackupSummary {
    pub key_id: String,
    pub created_at: String,
    pub licenses: usize,
}

pub fn create_backup(vault: &Vault, registry: &Registry, passphrase: &str, out: &Path) -> Result<BackupSummary, BackupError> {
    if passphrase.chars().count() < MIN_PASSPHRASE_CHARS {
        return Err(BackupError::WeakPassphrase);
    }
    let sk = vault.signing_key()?;
    let status = vault.status();
    let licenses = registry.all().map_err(|e| BackupError::Registry(e.to_string()))?;
    let secret = Zeroizing::new(
        serde_json::to_vec(&Secret {
            private_key_b64: B64S.encode(sk.to_bytes()),
            key_created_at: status.key.map(|k| k.created_at).unwrap_or_default(),
            licenses: licenses.clone(),
        })
        .expect("serialise"),
    );
    let salt = random_bytes::<16>();
    let nonce = random_bytes::<24>();
    let header = Header {
        format: FORMAT.into(),
        version: 1,
        key_id: key_id(&sk.verifying_key()),
        created_at: now_utc_iso(),
        kdf: "argon2id".into(),
        m_cost_kib: M_COST_KIB,
        t_cost: T_COST,
        p_cost: 1,
        salt_b64: B64S.encode(salt),
        cipher: "xchacha20poly1305".into(),
        nonce_b64: B64S.encode(nonce),
    };
    let key = derive(passphrase, &salt, M_COST_KIB, T_COST, 1)?;
    let ct = XChaCha20Poly1305::new(key.as_ref().into())
        .encrypt(XNonce::from_slice(&nonce), Payload { msg: &secret, aad: &aad(&header) })
        .map_err(|_| BackupError::NotABackup("encryption failed".into()))?;
    let file = BackupFile { header: header.clone(), ciphertext_b64: B64S.encode(ct) };
    atomic_write(out, serde_json::to_string_pretty(&file).expect("serialise").as_bytes())?;
    // Prove the file just written can be restored with this passphrase.
    let check = open_backup(out, passphrase)?;
    if check.0.key_id != header.key_id {
        return Err(BackupError::WrongPassphraseOrCorrupt);
    }
    Ok(BackupSummary { key_id: header.key_id, created_at: header.created_at, licenses: licenses.len() })
}

fn open_backup(path: &Path, passphrase: &str) -> Result<(KeyInfo, SigningKey, Vec<LicenseRecord>), BackupError> {
    let raw = fs::read_to_string(path)?;
    let file: BackupFile = serde_json::from_str(&raw).map_err(|e| BackupError::NotABackup(e.to_string()))?;
    let h = &file.header;
    if h.format != FORMAT || h.version != 1 || h.kdf != "argon2id" || h.cipher != "xchacha20poly1305" {
        return Err(BackupError::NotABackup("unsupported format".into()));
    }
    // Refuse absurd parameters from a hostile file (memory/time exhaustion).
    if h.m_cost_kib > 1024 * 1024 || h.t_cost > 10 || h.p_cost > 4 {
        return Err(BackupError::NotABackup("parameters out of range".into()));
    }
    let salt = B64S.decode(&h.salt_b64).map_err(|e| BackupError::NotABackup(e.to_string()))?;
    let nonce = B64S.decode(&h.nonce_b64).map_err(|e| BackupError::NotABackup(e.to_string()))?;
    if nonce.len() != 24 {
        return Err(BackupError::NotABackup("nonce".into()));
    }
    let ct = B64S.decode(&file.ciphertext_b64).map_err(|e| BackupError::NotABackup(e.to_string()))?;
    let key = derive(passphrase, &salt, h.m_cost_kib, h.t_cost, h.p_cost)?;
    let pt = Zeroizing::new(
        XChaCha20Poly1305::new(key.as_ref().into())
            .decrypt(XNonce::from_slice(&nonce), Payload { msg: &ct, aad: &aad(h) })
            .map_err(|_| BackupError::WrongPassphraseOrCorrupt)?,
    );
    let secret: Secret = serde_json::from_slice(&pt).map_err(|_| BackupError::WrongPassphraseOrCorrupt)?;
    let bytes = Zeroizing::new(B64S.decode(&secret.private_key_b64).map_err(|_| BackupError::WrongPassphraseOrCorrupt)?);
    let arr: Zeroizing<[u8; 32]> = Zeroizing::new(bytes.as_slice().try_into().map_err(|_| BackupError::WrongPassphraseOrCorrupt)?);
    let sk = SigningKey::from_bytes(&arr);
    if key_id(&sk.verifying_key()) != h.key_id {
        return Err(BackupError::WrongPassphraseOrCorrupt);
    }
    let info = KeyInfo {
        key_id: h.key_id.clone(),
        public_key: hourscal_license::license::public_key_to_text(&sk.verifying_key()),
        created_at: secret.key_created_at.clone(),
        protection: String::new(),
    };
    Ok((info, sk, secret.licenses))
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RestoreSummary {
    pub key: KeyInfo,
    pub licenses_in_backup: usize,
    pub licenses_added: usize,
}

/// Restore key (+ merge registry). Blocked if a DIFFERENT key is already usable here; if a different
/// key was configured before but is unavailable, requires the typed confirmation.
pub fn restore_backup(vault: &Vault, registry: &Registry, path: &Path, passphrase: &str, confirm: Option<&str>) -> Result<RestoreSummary, BackupError> {
    let (info, sk, licenses) = open_backup(path, passphrase)?;
    let key = vault.store_restored(&sk, &info.created_at, confirm)?;
    let added = registry.merge(&licenses).map_err(|e| BackupError::Registry(e.to_string()))?;
    Ok(RestoreSummary { key, licenses_in_backup: licenses.len(), licenses_added: added })
}

/// Read only the public header (to show which key a backup contains before asking for the passphrase).
pub fn peek_backup_key_id(path: &Path) -> Result<String, BackupError> {
    let raw = fs::read_to_string(path)?;
    let file: BackupFile = serde_json::from_str(&raw).map_err(|e| BackupError::NotABackup(e.to_string()))?;
    if file.header.format != FORMAT {
        return Err(BackupError::NotABackup("unsupported format".into()));
    }
    Ok(file.header.key_id)
}
