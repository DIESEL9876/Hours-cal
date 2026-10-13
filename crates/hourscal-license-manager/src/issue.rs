//! Licence issuance: validate → sign (Ed25519, existing protocol) → verify → write .hclic → record.

use crate::registry::{views, LicenseRecord, LicenseView, Registry};
use crate::vault::{Vault, VaultError};
use hourscal_license::dates::{now_utc_iso, Date};
use hourscal_license::device::{is_well_formed, normalize_code};
use hourscal_license::license::{key_id, new_license_id, sign_token, token_to_file_text, verify, LicensePayload, VerifyContext, FORMAT, FORMAT_VERSION};
use serde::{Deserialize, Serialize};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Deserialize, Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct IssueRequest {
    pub licensee: String,
    pub device_id: String,
    pub nickname: Option<String>,
    /// "perpetual" | "limited"
    pub license_type: String,
    pub expires_at: Option<String>,
    pub notes: Option<String>,
    pub replaces: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FieldError {
    pub field: String,
    pub message: String,
}

#[derive(Debug)]
pub enum IssueError {
    Validation(Vec<FieldError>),
    Vault(VaultError),
    SelfCheckFailed(String),
    Io(std::io::Error),
    Registry(String),
}

impl IssueError {
    pub fn message_he(&self) -> String {
        match self {
            IssueError::Validation(v) => v.iter().map(|f| f.message.clone()).collect::<Vec<_>>().join(" "),
            IssueError::Vault(e) => e.message_he(),
            IssueError::SelfCheckFailed(e) => format!("בדיקת הרישיון שנוצר נכשלה ({e}). הרישיון לא נשמר."),
            IssueError::Io(e) => format!("שמירת קובץ הרישיון נכשלה: {e}"),
            IssueError::Registry(e) => format!("רישום הרישיון נכשל: {e}. קובץ הרישיון לא נשמר."),
        }
    }
}

const MAX_TEXT: usize = 200;
const MAX_NOTES: usize = 2000;

fn clean(s: &Option<String>) -> Option<String> {
    s.as_ref().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

/// Validate and normalise. Returns (device, expires, nickname, notes, replaces).
pub fn validate(req: &IssueRequest, today: Date, registry: &Registry) -> Result<(String, Option<String>, Option<String>, Option<String>, Option<String>), IssueError> {
    let mut errs = Vec::new();
    let mut e = |f: &str, m: &str| errs.push(FieldError { field: f.into(), message: m.into() });
    let licensee = req.licensee.trim();
    if licensee.is_empty() {
        e("licensee", "יש להזין שם בעל הרישיון או שם החברה.");
    } else if licensee.chars().count() > MAX_TEXT {
        e("licensee", "שם בעל הרישיון ארוך מדי.");
    } else if licensee.chars().any(|c| c.is_control()) {
        e("licensee", "שם בעל הרישיון מכיל תווים לא חוקיים.");
    }
    let device = normalize_code(&req.device_id);
    if device.is_empty() {
        e("deviceId", "יש להזין את מזהה ההפעלה של המחשב.");
    } else if !is_well_formed(&device) {
        e("deviceId", "מזהה ההפעלה אינו תקין. הפורמט הנדרש: HC1-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX (מסך ההפעלה של Hours-Cal).");
    }
    let nickname = clean(&req.nickname);
    if nickname.as_ref().is_some_and(|n| n.chars().count() > MAX_TEXT || n.chars().any(|c| c.is_control())) {
        e("nickname", "כינוי המחשב ארוך מדי או מכיל תווים לא חוקיים.");
    }
    let notes = clean(&req.notes);
    if notes.as_ref().is_some_and(|n| n.chars().count() > MAX_NOTES) {
        e("notes", "ההערות ארוכות מדי.");
    }
    let mut expires = None;
    match req.license_type.as_str() {
        "perpetual" => {}
        "limited" => match clean(&req.expires_at) {
            None => e("expiresAt", "ברישיון מוגבל בזמן יש לבחור תאריך תפוגה."),
            Some(x) => match Date::parse(&x) {
                Err(_) => e("expiresAt", "תאריך התפוגה אינו תקין."),
                Ok(d) if d < today => e("expiresAt", "תאריך התפוגה כבר עבר."),
                Ok(d) => expires = Some(d.to_string()),
            },
        },
        _ => e("licenseType", "יש לבחור סוג רישיון."),
    }
    let replaces = clean(&req.replaces);
    if let Some(r) = &replaces {
        match registry.get(r) {
            Ok(Some(old)) if old.device_id == device && !device.is_empty() => e("replaces", "הרישיון המוחלף הונפק לאותו מחשב. החלפה נועדה למחשב או התקנת Windows חדשים."),
            Ok(Some(_)) => {}
            Ok(None) => e("replaces", "הרישיון המוחלף לא נמצא ברשומות."),
            Err(err) => e("replaces", &format!("שגיאה בבדיקת הרישיון המוחלף: {err}")),
        }
    }
    if errs.is_empty() {
        Ok((device, expires, nickname, notes, replaces))
    } else {
        Err(IssueError::Validation(errs))
    }
}

/// Safe Windows file-name component.
pub fn safe_file_part(s: &str) -> String {
    let t: String = s
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' || c == ' ' || c == '.' { c } else { '_' })
        .collect::<String>()
        .trim()
        .trim_matches('.')
        .chars()
        .take(60)
        .collect();
    if t.is_empty() { "license".into() } else { t }
}

fn write_new(dir: &Path, base: &str, contents: &str) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(dir)?;
    for n in 0..100 {
        let name = if n == 0 { format!("{base}.hclic") } else { format!("{base} ({n}).hclic") };
        let path = dir.join(name);
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut f) => {
                f.write_all(contents.as_bytes())?;
                f.sync_all()?;
                return Ok(path);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    Err(std::io::Error::new(std::io::ErrorKind::AlreadyExists, "too many files with the same name"))
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Issued {
    pub license: LicenseView,
    pub file_path: String,
    /// The activation key (public; same as the .hclic content without the frame).
    pub activation_key: String,
}

pub fn issue(vault: &Vault, registry: &Registry, req: &IssueRequest, out_dir: &Path, today: Date) -> Result<Issued, IssueError> {
    let (device, expires, nickname, notes, replaces) = validate(req, today, registry)?;
    let sk = vault.signing_key().map_err(IssueError::Vault)?;
    let vk = sk.verifying_key();
    let mut license_id = new_license_id();
    while registry.get(&license_id).map_err(|e| IssueError::Registry(e.to_string()))?.is_some() {
        license_id = new_license_id();
    }
    let payload = LicensePayload {
        format: FORMAT.into(),
        format_version: FORMAT_VERSION,
        license_id: license_id.clone(),
        licensee: req.licensee.trim().to_string(),
        organization: None,
        device_id: device.clone(),
        scope: "single-device".into(),
        issued_at: today.to_string(),
        expires_at: expires.clone(),
        replaces: replaces.clone(),
        key_id: key_id(&vk),
    };
    let token = sign_token(&payload, &sk);
    drop(sk);
    // Verify exactly as Hours-Cal will, before anything is saved.
    let checked = verify(&token, &VerifyContext { trusted_keys: &[vk], device_id: &device, today, revoked_ids: &[] }).map_err(|e| IssueError::SelfCheckFailed(e.to_string()))?;
    if checked != payload {
        return Err(IssueError::SelfCheckFailed("payload mismatch".into()));
    }
    let base = format!("{} - {}", safe_file_part(&payload.licensee), license_id);
    let path = write_new(out_dir, &base, &token_to_file_text(&token)).map_err(IssueError::Io)?;
    let rec = LicenseRecord {
        license_id,
        licensee: payload.licensee.clone(),
        device_id: device,
        nickname,
        license_type: if expires.is_some() { "limited".into() } else { "perpetual".into() },
        issued_at: payload.issued_at.clone(),
        expires_at: expires,
        notes,
        file_path: Some(path.display().to_string()),
        token: token.clone(),
        replaces,
        key_id: payload.key_id.clone(),
        revoked_at: None,
        revoke_reason: None,
        created_at: now_utc_iso(),
    };
    if let Err(e) = registry.insert(&rec) {
        let _ = std::fs::remove_file(&path);
        return Err(IssueError::Registry(e.to_string()));
    }
    let all = registry.all().map_err(|e| IssueError::Registry(e.to_string()))?;
    let view = views(&all, Some(&vk), today).into_iter().find(|v| v.record.license_id == rec.license_id).expect("just inserted");
    Ok(Issued { license: view, file_path: path.display().to_string(), activation_key: token })
}

/// Write another copy of a previously issued licence (signature + device re-verified first).
pub fn reexport(vault: &Vault, registry: &Registry, license_id: &str, out_dir: &Path) -> Result<String, IssueError> {
    let rec = registry
        .get(license_id)
        .map_err(|e| IssueError::Registry(e.to_string()))?
        .ok_or_else(|| IssueError::Registry("הרישיון לא נמצא".into()))?;
    let vk = vault.verifying_key().map_err(IssueError::Vault)?;
    let issued = Date::parse(&rec.issued_at).map_err(IssueError::SelfCheckFailed)?;
    verify(&rec.token, &VerifyContext { trusted_keys: &[vk], device_id: &rec.device_id, today: issued, revoked_ids: &[] }).map_err(|e| IssueError::SelfCheckFailed(e.message_he()))?;
    let path = write_new(out_dir, &format!("{} - {}", safe_file_part(&rec.licensee), rec.license_id), &token_to_file_text(&rec.token)).map_err(IssueError::Io)?;
    let _ = registry.update_file_path(license_id, &path.display().to_string());
    Ok(path.display().to_string())
}
