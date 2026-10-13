//! Hours-Cal licensing gate — Tauri v2 glue around the `hourscal-license` crate.
//!
//! Enforcement lives HERE (Rust), not in React:
//!  * The business DB is opened (and auto-backed-up) ONLY after the gate reports `Ready`
//!    (`on_ready`), and every data command calls `require_ready` first.
//!  * The licence requirement is enabled only when `keys/license_public_key.txt` contains the
//!    owner's public key (see `hourscal_license::enforcement`). Without it, the legal agreement is
//!    still required once per version, and a licence can be pre-installed for later verification.
//!  * Licensing / legal state: `%LOCALAPPDATA%\il.office.hourscal\licensing\`, separate from the
//!    business database (`%APPDATA%\il.office.hourscal\hours-cal.sqlite3`) and its backups.

use crate::db::{Db, DB_FILE};
use crate::DbState;
use hourscal_license::dates::Date;
use hourscal_license::device::{self, DeviceIdSource};
use hourscal_license::enforcement::{decide_staged, decode_unverified, parse_key_file, preinstall, KeyConfig};
use hourscal_license::legal::{AcceptanceRecord, LegalDocument, LegalStore, CONSENT_LABEL_HE};
use hourscal_license::license::{verify, InstallError, LicenseStore, VerifyContext};
use hourscal_license::recovery::{ExportReport, RecoverySnapshot, TableSummary};
use hourscal_license::startup::{Route, StartupConfig};
use hourscal_license::COPYRIGHT_NOTICE;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Manager, State};

const PUBLIC_KEY_TEXT: &str = include_str!("../keys/license_public_key.txt");
const REVOKED_TEXT: &str = include_str!("../keys/revoked-licenses.txt");

static READY: AtomicBool = AtomicBool::new(false);
static INIT_LOCK: Mutex<()> = Mutex::new(());
static DOC: OnceLock<LegalDocument> = OnceLock::new();
static KEYS: OnceLock<KeyConfig> = OnceLock::new();

fn doc() -> &'static LegalDocument {
    DOC.get_or_init(LegalDocument::bundled)
}

fn keys() -> &'static KeyConfig {
    KEYS.get_or_init(|| {
        let k = parse_key_file(PUBLIC_KEY_TEXT);
        if let KeyConfig::Invalid(e) = &k {
            eprintln!("licensing: keys/license_public_key.txt is invalid ({e}); failing closed");
        }
        k
    })
}

fn revoked() -> Vec<String> {
    REVOKED_TEXT.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#')).map(String::from).collect()
}

fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_local_data_dir().map(|d| d.join("licensing")).map_err(|e| e.to_string())
}

fn device_code(app: &AppHandle) -> Result<String, String> {
    device::current_device_id(&config_dir(app)?).map(|d| d.code).map_err(|e| e.to_string())
}

/// Existing Hours-Cal database location (unchanged since 1.0.0).
fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

fn business_db_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join(DB_FILE))
}

fn app_version(app: &AppHandle) -> String {
    app.package_info().version.to_string()
}

fn route(app: &AppHandle) -> Result<Route, String> {
    let cfg_dir = config_dir(app)?;
    let db = business_db_path(app)?;
    let guid = device::read_machine_guid();
    let trusted = keys().trusted();
    let revoked = revoked();
    let version = app_version(app);
    let r = decide_staged(
        &StartupConfig {
            config_dir: &cfg_dir,
            app_version: &version,
            doc: doc(),
            trusted_keys: &trusted,
            revoked_ids: &revoked,
            machine_guid: guid.as_deref(),
            today: Date::today_utc(),
            db_path: &db,
        },
        keys(),
    )
    .map_err(|e| e.to_string())?;
    if matches!(r, Route::Ready { .. }) && !READY.load(Ordering::SeqCst) {
        // Open the database exactly once; READY flips only after it is open, so no data command
        // can run against an unopened database even if two startup calls race.
        let _guard = INIT_LOCK.lock().map_err(|_| "init lock poisoned".to_string())?;
        if !READY.load(Ordering::SeqCst) {
            on_ready(app)?;
            READY.store(true, Ordering::SeqCst);
        }
    }
    Ok(r)
}

/// Runs once per process when the gate opens: the existing DB open + daily auto-backup.
/// (Schema migrations run from the frontend after this, exactly as before.)
fn on_ready(app: &AppHandle) -> Result<(), String> {
    let state: State<'_, DbState> = app.state();
    if state.0.get().is_some() {
        return Ok(());
    }
    let db = Db::open(&data_dir(app)?)?;
    if let Err(e) = db.auto_backup() {
        eprintln!("auto backup failed: {e}");
    }
    let _ = state.0.set(db);
    Ok(())
}

/// Guard for every command that reads or changes business data.
pub fn require_ready() -> Result<(), String> {
    if READY.load(Ordering::SeqCst) {
        Ok(())
    } else {
        Err("LICENSE_REQUIRED".into())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegalDocDto {
    text: String,
    doc_version: String,
    sha256: String,
    app_version: String,
    copyright: &'static str,
    consent_label: &'static str,
}

#[tauri::command]
pub fn licensing_startup_route(app: AppHandle) -> Result<Route, String> {
    route(&app)
}

#[tauri::command]
pub fn legal_document(app: AppHandle) -> LegalDocDto {
    let d = doc();
    LegalDocDto {
        text: d.text.clone(),
        doc_version: d.doc_version.clone(),
        sha256: d.sha256.clone(),
        app_version: app_version(&app),
        copyright: COPYRIGHT_NOTICE,
        consent_label: CONSENT_LABEL_HE,
    }
}

/// The UI must echo the hash of the text it displayed; accepting any other text is refused.
#[tauri::command]
pub fn legal_accept(app: AppHandle, sha256: String, local_utc_offset_minutes: Option<i32>) -> Result<AcceptanceRecord, String> {
    if sha256 != doc().sha256 {
        return Err("DOCUMENT_MISMATCH".into());
    }
    let dev = device_code(&app)?;
    LegalStore::new(&config_dir(&app)?)
        .accept(&app_version(&app), doc(), local_utc_offset_minutes, Some(&dev))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn legal_history(app: AppHandle) -> Result<Vec<AcceptanceRecord>, String> {
    Ok(LegalStore::new(&config_dir(&app)?).history())
}

#[tauri::command]
pub fn legal_accepted_text(app: AppHandle, sha256: String) -> Result<Option<String>, String> {
    Ok(LegalStore::new(&config_dir(&app)?).accepted_text(&sha256))
}

#[tauri::command]
pub fn legal_decline_and_exit(app: AppHandle) {
    app.exit(0);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceDto {
    code: String,
    fallback: bool,
}

#[tauri::command]
pub fn license_device_id(app: AppHandle) -> Result<DeviceDto, String> {
    let d = device::current_device_id(&config_dir(&app)?).map_err(|e| e.to_string())?;
    Ok(DeviceDto { code: d.code, fallback: d.source == DeviceIdSource::LocalFallback })
}

/// Accepts a pasted activation key or the full contents of a .hclic file.
/// Enforced build: full verification before saving. Not-yet-enforced build: pre-install (format,
/// device and dates checked; the signature is verified on every start once a key is embedded).
#[tauri::command]
pub fn license_activate(app: AppHandle, input: String) -> Result<Route, String> {
    let cfg = config_dir(&app)?;
    let dev = device::current_device_id(&cfg).map_err(|e| e.to_string())?;
    let store = LicenseStore::new(&cfg);
    let today = Date::today_utc();
    let res = if keys().enforced() {
        let trusted = keys().trusted();
        let revoked = revoked();
        store.install(&input, &VerifyContext { trusted_keys: &trusted, device_id: &dev.code, today, revoked_ids: &revoked }).map(|_| ())
    } else {
        preinstall(&store, &input, &dev.code, today).map(|_| ())
    };
    res.map_err(|e| match e {
        InstallError::Invalid(le) => le.message_he(),
        InstallError::Io(io) => format!("שמירת הרישיון נכשלה: {io}"),
    })?;
    route(&app)
}

#[tauri::command]
pub fn license_import_file(app: AppHandle, path: String) -> Result<Route, String> {
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() > 64 * 1024 {
        return Err("הקובץ גדול מדי לקובץ רישיון.".into());
    }
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    license_activate(app, text)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseStatusDto {
    /// True when this build embeds a public key (licence required).
    enforced: bool,
    device_id: String,
    device_fallback: bool,
    /// Installed licence, if any.
    license_id: Option<String>,
    licensee: Option<String>,
    organization: Option<String>,
    expires_at: Option<String>,
    /// "valid" | "pending" (not enforced; signature not checked yet) | "invalid" | "none"
    state: &'static str,
    message_he: Option<String>,
}

/// Status for the "מסמכים משפטיים ורישיון" page.
#[tauri::command]
pub fn license_status(app: AppHandle) -> Result<LicenseStatusDto, String> {
    let cfg = config_dir(&app)?;
    let dev = device::current_device_id(&cfg).map_err(|e| e.to_string())?;
    let enforced = keys().enforced();
    let today = Date::today_utc();
    let mut dto = LicenseStatusDto {
        enforced,
        device_id: dev.code.clone(),
        device_fallback: dev.source == DeviceIdSource::LocalFallback,
        license_id: None,
        licensee: None,
        organization: None,
        expires_at: None,
        state: "none",
        message_he: None,
    };
    let Some(text) = LicenseStore::new(&cfg).load() else { return Ok(dto) };
    let checked = if enforced {
        let trusted = keys().trusted();
        let revoked = revoked();
        verify(&text, &VerifyContext { trusted_keys: &trusted, device_id: &dev.code, today, revoked_ids: &revoked })
    } else {
        decode_unverified(&text, &dev.code, today)
    };
    match checked {
        Ok(p) => {
            dto.state = if enforced { "valid" } else { "pending" };
            dto.license_id = Some(p.license_id);
            dto.licensee = Some(p.licensee);
            dto.organization = p.organization;
            dto.expires_at = p.expires_at;
        }
        Err(e) => {
            dto.state = "invalid";
            dto.message_he = Some(e.message_he());
        }
    }
    Ok(dto)
}

/// Recovery is for users who accepted the terms but lack a valid licence.
fn require_accepted(app: &AppHandle) -> Result<(), String> {
    let dev = device_code(app)?;
    if LegalStore::new(&config_dir(app)?).needs_acceptance(&app_version(app), doc(), Some(&dev)) {
        Err("TERMS_NOT_ACCEPTED".into())
    } else {
        Ok(())
    }
}

#[tauri::command]
pub fn recovery_tables(app: AppHandle) -> Result<Vec<TableSummary>, String> {
    require_accepted(&app)?;
    let snap = RecoverySnapshot::open(&business_db_path(&app)?, &app.path().app_cache_dir().map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    snap.tables().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn recovery_export(app: AppHandle, out_dir: String) -> Result<ExportReport, String> {
    require_accepted(&app)?;
    let snap = RecoverySnapshot::open(&business_db_path(&app)?, &app.path().app_cache_dir().map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    snap.export_all(std::path::Path::new(&out_dir)).map_err(|e| e.to_string())
}
