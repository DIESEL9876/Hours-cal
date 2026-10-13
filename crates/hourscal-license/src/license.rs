//! Ed25519-signed offline licences.
//!
//! Token = base64url(payload JSON) "." base64url(64-byte signature).
//! The signature covers the exact payload bytes, so no canonicalisation is
//! needed and any byte change is detected. The application embeds PUBLIC keys
//! only; signing lives in the separate owner tool.

use crate::dates::Date;
use crate::fsutil::{atomic_write, hex};
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine;
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

pub const FORMAT: &str = "hours-cal-license";
pub const FORMAT_VERSION: u32 = 1;
const BEGIN: &str = "-----BEGIN HOURS-CAL LICENSE-----";
const END: &str = "-----END HOURS-CAL LICENSE-----";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct LicensePayload {
    pub format: String,
    pub format_version: u32,
    pub license_id: String,
    pub licensee: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub organization: Option<String>,
    /// Device activation ID this licence is bound to (HC1-/HCF- code).
    pub device_id: String,
    /// "single-device" for now; kept explicit for future scopes.
    pub scope: String,
    pub issued_at: String,
    /// Inclusive last valid day (UTC). None = perpetual.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    /// Licence ID this one replaces (computer replacement / reinstall).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replaces: Option<String>,
    /// Fingerprint of the signing public key.
    pub key_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LicenseError {
    Malformed(String),
    BadSignature,
    UnsupportedFormat,
    WrongDevice { licensed: String, this_device: String },
    Expired { expires_at: String },
    NotYetValid { issued_at: String },
    Revoked { license_id: String },
}

impl LicenseError {
    /// User-facing Hebrew message.
    pub fn message_he(&self) -> String {
        match self {
            LicenseError::Malformed(_) => "קובץ הרישיון או מפתח ההפעלה אינם בפורמט תקין. ודאו שהעתקתם את כל הטקסט.".into(),
            LicenseError::BadSignature => "חתימת הרישיון אינה תקפה. ייתכן שהרישיון שונה או שאינו הונפק על ידי בעל התוכנה.".into(),
            LicenseError::UnsupportedFormat => "פורמט הרישיון אינו נתמך בגרסה זו של התוכנה.".into(),
            LicenseError::WrongDevice { .. } => "הרישיון הונפק למחשב אחר. יש לבקש רישיון עבור מזהה ההפעלה של מחשב זה.".into(),
            LicenseError::Expired { expires_at } => format!("תוקף הרישיון הסתיים בתאריך {expires_at}."),
            LicenseError::NotYetValid { issued_at } => format!("תאריך הנפקת הרישיון ({issued_at}) מאוחר מתאריך המחשב. בדקו את שעון המחשב."),
            LicenseError::Revoked { .. } => "רישיון זה הוחלף או בוטל. יש לפנות לבעל התוכנה לקבלת רישיון עדכני.".into(),
        }
    }
}

impl fmt::Display for LicenseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            LicenseError::Malformed(m) => write!(f, "malformed licence: {m}"),
            LicenseError::BadSignature => write!(f, "invalid signature"),
            LicenseError::UnsupportedFormat => write!(f, "unsupported licence format"),
            LicenseError::WrongDevice { licensed, this_device } => write!(f, "licence is for device {licensed}, this device is {this_device}"),
            LicenseError::Expired { expires_at } => write!(f, "expired on {expires_at}"),
            LicenseError::NotYetValid { issued_at } => write!(f, "issued in the future ({issued_at})"),
            LicenseError::Revoked { license_id } => write!(f, "licence {license_id} is revoked"),
        }
    }
}

impl std::error::Error for LicenseError {}

/// Short public-key fingerprint, e.g. `k-3f9a1c2b7d004e11`.
pub fn key_id(vk: &VerifyingKey) -> String {
    format!("k-{}", hex(&Sha256::digest(vk.as_bytes())[..8]))
}

pub fn public_key_to_text(vk: &VerifyingKey) -> String {
    B64.encode(vk.as_bytes())
}

pub fn public_key_from_text(s: &str) -> Result<VerifyingKey, String> {
    let line = s.lines().map(str::trim).find(|l| !l.is_empty() && !l.starts_with('#')).ok_or("empty public key")?;
    let bytes = B64.decode(line).map_err(|e| format!("public key base64: {e}"))?;
    let arr: [u8; 32] = bytes.try_into().map_err(|_| "public key must be 32 bytes".to_string())?;
    VerifyingKey::from_bytes(&arr).map_err(|e| format!("public key: {e}"))
}

pub fn new_license_id() -> String {
    let r = crate::fsutil::random_hex(5).to_uppercase();
    format!("HCL-{}-{}", Date::today_utc().y, r)
}

/// Sign a payload. Used ONLY by the owner tool and by tests.
pub fn sign_token(payload: &LicensePayload, sk: &SigningKey) -> String {
    let bytes = serde_json::to_vec(payload).expect("payload serialises");
    let sig = sk.sign(&bytes);
    format!("{}.{}", B64.encode(&bytes), B64.encode(sig.to_bytes()))
}

pub fn token_to_file_text(token: &str) -> String {
    let wrapped: Vec<String> = token.as_bytes().chunks(64).map(|c| String::from_utf8_lossy(c).into_owned()).collect();
    format!("{BEGIN}\n{}\n{END}\n", wrapped.join("\n"))
}

/// Accepts a whole .hclic file or a bare activation key; ignores whitespace.
pub fn extract_token(input: &str) -> String {
    let body = match (input.find(BEGIN), input.find(END)) {
        (Some(a), Some(b)) if b > a => &input[a + BEGIN.len()..b],
        _ => input,
    };
    body.chars().filter(|c| !c.is_whitespace()).collect()
}

pub struct VerifyContext<'a> {
    pub trusted_keys: &'a [VerifyingKey],
    pub device_id: &'a str,
    pub today: Date,
    pub revoked_ids: &'a [String],
}

/// Full verification: signature → format → device → revocation → dates.
pub fn verify(input: &str, ctx: &VerifyContext) -> Result<LicensePayload, LicenseError> {
    let token = extract_token(input);
    let (p64, s64) = token.split_once('.').ok_or_else(|| LicenseError::Malformed("missing '.'".into()))?;
    let payload_bytes = B64.decode(p64).map_err(|e| LicenseError::Malformed(format!("payload: {e}")))?;
    let sig_bytes = B64.decode(s64).map_err(|e| LicenseError::Malformed(format!("signature: {e}")))?;
    let sig_arr: [u8; 64] = sig_bytes.try_into().map_err(|_| LicenseError::Malformed("signature length".into()))?;
    let sig = Signature::from_bytes(&sig_arr);

    // Signature is checked BEFORE the payload is trusted for anything.
    if !ctx.trusted_keys.iter().any(|k| k.verify_strict(&payload_bytes, &sig).is_ok()) {
        return Err(LicenseError::BadSignature);
    }
    let p: LicensePayload = serde_json::from_slice(&payload_bytes).map_err(|e| LicenseError::Malformed(format!("json: {e}")))?;
    if p.format != FORMAT || p.format_version != FORMAT_VERSION || p.scope != "single-device" {
        return Err(LicenseError::UnsupportedFormat);
    }
    if p.device_id != ctx.device_id {
        return Err(LicenseError::WrongDevice { licensed: p.device_id.clone(), this_device: ctx.device_id.to_string() });
    }
    if ctx.revoked_ids.iter().any(|r| r == &p.license_id) {
        return Err(LicenseError::Revoked { license_id: p.license_id.clone() });
    }
    let issued = Date::parse(&p.issued_at).map_err(LicenseError::Malformed)?;
    // One day of tolerance for time-zone differences between owner and user.
    if issued > Date::from_unix_days(days(ctx.today) + 1) {
        return Err(LicenseError::NotYetValid { issued_at: p.issued_at.clone() });
    }
    if let Some(exp) = &p.expires_at {
        if ctx.today > Date::parse(exp).map_err(LicenseError::Malformed)? {
            return Err(LicenseError::Expired { expires_at: exp.clone() });
        }
    }
    Ok(p)
}

fn days(d: Date) -> i64 {
    // inverse of from_unix_days (H. Hinnant days_from_civil)
    let y = if d.m <= 2 { d.y as i64 - 1 } else { d.y as i64 };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (d.m as i64 + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d.d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Local licence storage: `<config_dir>/license/license.hclic`.
/// Outside the business database and outside business backups.
pub struct LicenseStore {
    dir: PathBuf,
}

impl LicenseStore {
    pub fn new(config_dir: &Path) -> Self {
        LicenseStore { dir: config_dir.join("license") }
    }
    pub fn path(&self) -> PathBuf {
        self.dir.join("license.hclic")
    }
    pub fn load(&self) -> Option<String> {
        fs::read_to_string(self.path()).ok()
    }
    /// Verifies first; only a VALID licence is ever written. An existing
    /// licence file is never replaced by an invalid one.
    pub fn install(&self, input: &str, ctx: &VerifyContext) -> Result<LicensePayload, InstallError> {
        let p = verify(input, ctx).map_err(InstallError::Invalid)?;
        let token = extract_token(input);
        if let Some(old) = self.load() {
            let _ = atomic_write(&self.dir.join("license.previous.hclic"), old.as_bytes());
        }
        atomic_write(&self.path(), token_to_file_text(&token).as_bytes()).map_err(InstallError::Io)?;
        Ok(p)
    }
    pub fn check(&self, ctx: &VerifyContext) -> Result<LicensePayload, Option<LicenseError>> {
        match self.load() {
            None => Err(None),
            Some(t) => verify(&t, ctx).map_err(Some),
        }
    }
}

#[derive(Debug)]
pub enum InstallError {
    Invalid(LicenseError),
    Io(io::Error),
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn days_roundtrip() {
        for z in [0i64, 1, 59, 60, 11_016, 20_739, 40_000] {
            assert_eq!(days(Date::from_unix_days(z)), z);
        }
    }
}
