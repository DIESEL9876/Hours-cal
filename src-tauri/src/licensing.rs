//! Hours-Cal licensing gate — Tauri v2 glue around the `hourscal-license` crate.
//! Copy to src-tauri/src/licensing.rs. See docs/INTEGRATION.md.
//!
//! Enforcement lives HERE (Rust), not in React:
//!  * The business DB is opened / migrated ONLY after `Route::Ready`
//!    (call your existing init from `on_ready`).
//!  * Every existing mutating command starts with `licensing::require_ready(&app)?;`.

use ed25519_dalek::VerifyingKey;
use hourscal_license::dates::Date;
use hourscal_license::device::{self, DeviceIdSource};
use hourscal_license::legal::{AcceptanceRecord, LegalDocument, LegalStore, CONSENT_LABEL_HE};
use hourscal_license::license::{public_key_from_text, LicenseStore, VerifyContext};
use hourscal_license::recovery::{ExportReport, RecoverySnapshot, TableSummary};
use hourscal_license::startup::{decide, Route, StartupConfig};
use hourscal_license::COPYRIGHT_NOTICE;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use tauri::{AppHandle, Manager};

const PUBLIC_KEY_TEXT: &str = include_str!("../keys/license_public_key.txt");
const REVOKED_TEXT: &str = include_str!("../keys/revoked-licenses.txt");

static READY: AtomicBool = AtomicBool::new(false);
static DOC: OnceLock<LegalDocument> = OnceLock::new();

fn doc() -> &'static LegalDocument {
    DOC.get_or_init(LegalDocument::bundled)
}

fn trusted_keys() -> Vec<VerifyingKey> {
    vec![public_key_from_text(PUBLIC_KEY_TEXT).expect("keys/license_public_key.txt is a valid Ed25519 public key")]
}

fn revoked() -> Vec<String> {
    REVOKED_TEXT.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#')).map(String::from).collect()
}

/// Licensing/legal state: %LOCALAPPDATA%\<identifier>\licensing\ (not roamed between PCs,
/// separate from the business database's folder and its backups).
fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_local_data_dir().map(|d| d.join("licensing")).map_err(|e| e.to_string())
}

fn device_code(app: &AppHandle) -> Result<String, String> {
    device::current_device_id(&config_dir(app)?).map(|d| d.code).map_err(|e| e.to_string())
}

/// >>> WIRE THIS to the EXISTING database path function. Do not change where
/// the database lives. <<<
fn business_db_path(app: &AppHandle) -> Result<PathBuf, String> {
    crate::db::database_path(app).map_err(|e| e.to_string())
}

fn app_version(app: &AppHandle) -> String {
    app.package_info().version.to_string()
}

fn route(app: &AppHandle) -> Result<Route, String> {
    let cfg_dir = config_dir(app)?;
    let db = business_db_path(app)?;
    let guid = device::read_machine_guid();
    let keys = trusted_keys();
    let revoked = revoked();
    let version = app_version(app);
    let r = decide(&StartupConfig {
        config_dir: &cfg_dir, app_version: &version, doc: doc(), trusted_keys: &keys, revoked_ids: &revoked,
        machine_guid: guid.as_deref(), today: Date::today_utc(), db_path: &db,
    }).map_err(|e| e.to_string())?;
    if matches!(r, Route::Ready { .. }) && !READY.swap(true, Ordering::SeqCst) {
        on_ready(app)?;
    }
    Ok(r)
}

/// Runs once per process when the gate opens: existing DB init + migrations.
fn on_ready(app: &AppHandle) -> Result<(), String> {
    crate::db::init_existing_database(app).map_err(|e| e.to_string()) // >>> WIRE to existing init <<<
}

/// Guard for every existing command that reads or changes business data.
pub fn require_ready(_app: &AppHandle) -> Result<(), String> {
    if READY.load(Ordering::SeqCst) { Ok(()) } else { Err("LICENSE_REQUIRED".into()) }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegalDocDto { text: String, doc_version: String, sha256: String, app_version: String, copyright: &'static str, consent_label: &'static str }

#[tauri::command]
pub fn licensing_startup_route(app: AppHandle) -> Result<Route, String> { route(&app) }

#[tauri::command]
pub fn legal_document(app: AppHandle) -> LegalDocDto {
    let d = doc();
    LegalDocDto { text: d.text.clone(), doc_version: d.doc_version.clone(), sha256: d.sha256.clone(),
        app_version: app_version(&app), copyright: COPYRIGHT_NOTICE, consent_label: CONSENT_LABEL_HE }
}

/// The UI must echo the hash of the text it displayed; accepting any other text is refused.
#[tauri::command]
pub fn legal_accept(app: AppHandle, sha256: String, local_utc_offset_minutes: Option<i32>) -> Result<AcceptanceRecord, String> {
    if sha256 != doc().sha256 { return Err("DOCUMENT_MISMATCH".into()); }
    let dev = device_code(&app)?;
    LegalStore::new(&config_dir(&app)?).accept(&app_version(&app), doc(), local_utc_offset_minutes, Some(&dev)).map_err(|e| e.to_string())
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
pub fn legal_decline_and_exit(app: AppHandle) { app.exit(0); }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceDto { code: String, fallback: bool }

#[tauri::command]
pub fn license_device_id(app: AppHandle) -> Result<DeviceDto, String> {
    let d = device::current_device_id(&config_dir(&app)?).map_err(|e| e.to_string())?;
    Ok(DeviceDto { code: d.code, fallback: d.source == DeviceIdSource::LocalFallback })
}

/// Accepts a pasted activation key or the full contents of a .hclic file.
#[tauri::command]
pub fn license_activate(app: AppHandle, input: String) -> Result<Route, String> {
    let cfg = config_dir(&app)?;
    let dev = device::current_device_id(&cfg).map_err(|e| e.to_string())?;
    let keys = trusted_keys();
    let revoked = revoked();
    LicenseStore::new(&cfg)
        .install(&input, &VerifyContext { trusted_keys: &keys, device_id: &dev.code, today: Date::today_utc(), revoked_ids: &revoked })
        .map_err(|e| match e {
            hourscal_license::license::InstallError::Invalid(le) => le.message_he(),
            hourscal_license::license::InstallError::Io(io) => format!("שמירת הרישיון נכשלה: {io}"),
        })?;
    route(&app)
}

#[tauri::command]
pub fn license_import_file(app: AppHandle, path: String) -> Result<Route, String> {
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() > 64 * 1024 { return Err("הקובץ גדול מדי לקובץ רישיון.".into()); }
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    license_activate(app, text)
}

/// Recovery is for users who accepted the terms but lack a valid licence.
fn require_accepted(app: &AppHandle) -> Result<(), String> {
    let dev = device_code(app)?;
    if LegalStore::new(&config_dir(app)?).needs_acceptance(&app_version(app), doc(), Some(&dev)) { Err("TERMS_NOT_ACCEPTED".into()) } else { Ok(()) }
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

/* Register in main.rs / lib.rs:
   .invoke_handler(tauri::generate_handler![
       // ...existing commands...
       licensing::licensing_startup_route, licensing::legal_document, licensing::legal_accept,
       licensing::legal_history, licensing::legal_accepted_text, licensing::legal_decline_and_exit,
       licensing::license_device_id, licensing::license_activate, licensing::license_import_file,
       licensing::recovery_tables, licensing::recovery_export,
   ])
   and REMOVE the existing eager DB init from setup() — it now runs in on_ready(). */
