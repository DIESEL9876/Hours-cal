//! Hours-Cal License Manager — desktop backend (OWNER ONLY, never shipped with Hours-Cal).
//!
//! Thin Tauri commands over `hourscal-license-manager`. Every private-key operation (generation,
//! signing, backup encryption) runs here in Rust; the web UI only ever receives public data:
//! key IDs, the public key, licence tokens (which are public by design) and file paths.
//! No command returns, logs or writes the private key outside the protected vault / an encrypted
//! backup the owner explicitly asked for.

use hourscal_license::dates::{now_utc_iso, Date};
use hourscal_license::device::{device_id_with, read_machine_guid, DeviceIdSource};
use hourscal_license_manager::backup::{create_backup, peek_backup_key_id, restore_backup, BackupError, BackupSummary, RestoreSummary, MIN_PASSPHRASE_CHARS};
use hourscal_license_manager::issue::{issue, reexport, FieldError, IssueError, IssueRequest, Issued};
use hourscal_license_manager::protect::PROTECTION;
use hourscal_license_manager::registry::{revocation_list_text, LicenseView, Stats};
use hourscal_license_manager::vault::{public_key_file_text, KeyInfo, VaultError, VaultStatus};
use hourscal_license_manager::Manager;
use hourscal_license::fsutil::atomic_write;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager as _, State};
use zeroize::Zeroizing;

/// Hours-Cal (the customer app) identifier — used only to find its device-ID fallback file so that
/// "פרטי המחשב שלי" shows exactly the ID Hours-Cal shows on this computer.
const HOURSCAL_IDENTIFIER: &str = "il.office.hourscal";
const LICENSE_FOLDER_NAME: &str = "Hours-Cal Licenses";

pub struct AppState {
    manager: Mutex<Option<Manager>>,
    data_dir: PathBuf,
    default_license_dir: PathBuf,
    hourscal_licensing_dir: Option<PathBuf>,
}

/// Error shape returned to the UI: a Hebrew message plus optional per-field validation errors.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CmdError {
    code: &'static str,
    message: String,
    fields: Vec<FieldError>,
}

impl CmdError {
    fn new(code: &'static str, message: impl Into<String>) -> CmdError {
        CmdError { code, message: message.into(), fields: vec![] }
    }
}

impl From<VaultError> for CmdError {
    fn from(e: VaultError) -> Self {
        let code = match e {
            VaultError::AlreadyConfigured { .. } => "ALREADY_CONFIGURED",
            VaultError::ConfirmationRequired { .. } => "CONFIRMATION_REQUIRED",
            VaultError::NotConfigured => "NOT_CONFIGURED",
            VaultError::KeyUnavailable(_) => "KEY_UNAVAILABLE",
            VaultError::DifferentKey { .. } => "DIFFERENT_KEY",
            VaultError::InvalidKeyFile(_) => "INVALID_KEY_FILE",
            VaultError::Io(_) => "IO",
        };
        CmdError::new(code, e.message_he())
    }
}

impl From<IssueError> for CmdError {
    fn from(e: IssueError) -> Self {
        match e {
            IssueError::Validation(fields) => CmdError { code: "VALIDATION", message: "יש לתקן את השדות המסומנים.".into(), fields },
            IssueError::Vault(v) => v.into(),
            other => CmdError::new("ISSUE_FAILED", other.message_he()),
        }
    }
}

impl From<BackupError> for CmdError {
    fn from(e: BackupError) -> Self {
        match e {
            BackupError::Vault(v) => v.into(),
            BackupError::WeakPassphrase => CmdError::new("WEAK_PASSPHRASE", e.message_he()),
            BackupError::WrongPassphraseOrCorrupt => CmdError::new("WRONG_PASSPHRASE", e.message_he()),
            other => CmdError::new("BACKUP_FAILED", other.message_he()),
        }
    }
}

type R<T> = Result<T, CmdError>;

fn with<T>(state: &State<'_, AppState>, f: impl FnOnce(&Manager) -> R<T>) -> R<T> {
    let mut guard = state.manager.lock().map_err(|_| CmdError::new("INTERNAL", "שגיאה פנימית"))?;
    if guard.is_none() {
        *guard = Some(Manager::open(&state.data_dir).map_err(|e| CmdError::new("REGISTRY", format!("פתיחת רשומת הרישיונות נכשלה: {e}")))?);
    }
    f(guard.as_ref().expect("opened above"))
}

fn today() -> Date {
    // Same clock as the Hours-Cal verifier (UTC date), so a licence is never "issued in the future".
    Date::today_utc()
}

fn require_ext(path: &str, exts: &[&str]) -> R<PathBuf> {
    let lower = path.to_lowercase();
    if path.trim().is_empty() || !exts.iter().any(|e| lower.ends_with(e)) {
        return Err(CmdError::new("BAD_PATH", format!("סוג הקובץ חייב להיות {}", exts.join(" / "))));
    }
    Ok(PathBuf::from(path))
}

// ---------------------------------------------------------------------------------------------
// General
// ---------------------------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    version: String,
    data_dir: String,
    license_dir: String,
    protection: &'static str,
    min_passphrase_chars: usize,
    last_backup_at: Option<String>,
    last_backup_key_id: Option<String>,
    today: String,
}

#[tauri::command]
fn app_info(app: AppHandle, state: State<'_, AppState>) -> R<AppInfo> {
    with(&state, |m| {
        Ok(AppInfo {
            version: app.package_info().version.to_string(),
            data_dir: state.data_dir.display().to_string(),
            license_dir: m.license_dir(&state.default_license_dir).display().to_string(),
            protection: PROTECTION,
            min_passphrase_chars: MIN_PASSPHRASE_CHARS,
            last_backup_at: m.registry.setting("last_backup_at").ok().flatten(),
            last_backup_key_id: m.registry.setting("last_backup_key_id").ok().flatten(),
            today: today().to_string(),
        })
    })
}

#[tauri::command]
fn set_license_dir(state: State<'_, AppState>, path: String) -> R<String> {
    let p = PathBuf::from(path.trim());
    if !p.is_absolute() {
        return Err(CmdError::new("BAD_PATH", "יש לבחור תיקייה מלאה."));
    }
    std::fs::create_dir_all(&p).map_err(|e| CmdError::new("IO", format!("לא ניתן ליצור את התיקייה: {e}")))?;
    with(&state, |m| {
        m.registry.set_setting("license_dir", &p.display().to_string()).map_err(|e| CmdError::new("REGISTRY", e.to_string()))?;
        Ok(p.display().to_string())
    })
}

// ---------------------------------------------------------------------------------------------
// Signing key (vault)
// ---------------------------------------------------------------------------------------------

#[tauri::command]
fn vault_status(state: State<'_, AppState>) -> R<VaultStatus> {
    with(&state, |m| Ok(m.vault.status()))
}

/// First-time setup. Refuses if a key exists; if a key was configured before but is now missing,
/// requires the typed confirmation (never silently regenerates).
#[tauri::command]
fn vault_create(state: State<'_, AppState>, confirm: Option<String>) -> R<KeyInfo> {
    with(&state, |m| Ok(m.vault.create(confirm.as_deref())?))
}

/// Import a key created earlier with the command-line owner tool (keeps its licences valid).
#[tauri::command]
fn vault_import_cli_key(state: State<'_, AppState>, path: String, confirm: Option<String>) -> R<KeyInfo> {
    let text = Zeroizing::new(std::fs::read_to_string(&path).map_err(|e| CmdError::new("IO", format!("קריאת קובץ המפתח נכשלה: {e}")))?);
    if text.len() > 64 * 1024 {
        return Err(CmdError::new("INVALID_KEY_FILE", "הקובץ אינו קובץ מפתח של Hours-Cal."));
    }
    with(&state, |m| Ok(m.vault.import_cli_key_text(&text, confirm.as_deref())?))
}

/// Writes license_public_key.txt (PUBLIC key only) to a path the owner picked.
#[tauri::command]
fn export_public_key(state: State<'_, AppState>, out_path: String) -> R<String> {
    let out = require_ext(&out_path, &[".txt"])?;
    with(&state, |m| {
        let vk = m.vault.verifying_key()?;
        atomic_write(&out, public_key_file_text(&vk).as_bytes()).map_err(|e| CmdError::new("IO", format!("שמירת המפתח הציבורי נכשלה: {e}")))?;
        Ok(out.display().to_string())
    })
}

// ---------------------------------------------------------------------------------------------
// Backups
// ---------------------------------------------------------------------------------------------

#[tauri::command]
fn backup_create_cmd(state: State<'_, AppState>, passphrase: String, out_path: String) -> R<BackupSummary> {
    let passphrase = Zeroizing::new(passphrase);
    let out = require_ext(&out_path, &[".hckeybak"])?;
    with(&state, |m| {
        let s = create_backup(&m.vault, &m.registry, &passphrase, &out)?;
        let _ = m.registry.set_setting("last_backup_at", &now_utc_iso());
        let _ = m.registry.set_setting("last_backup_key_id", &s.key_id);
        Ok(s)
    })
}

#[tauri::command]
fn backup_peek(path: String) -> R<String> {
    Ok(peek_backup_key_id(Path::new(&path))?)
}

#[tauri::command]
fn backup_restore_cmd(state: State<'_, AppState>, path: String, passphrase: String, confirm: Option<String>) -> R<RestoreSummary> {
    let passphrase = Zeroizing::new(passphrase);
    with(&state, |m| Ok(restore_backup(&m.vault, &m.registry, Path::new(&path), &passphrase, confirm.as_deref())?))
}

// ---------------------------------------------------------------------------------------------
// This computer
// ---------------------------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MyDevice {
    /// None when it cannot be determined reliably (then use the ID shown in Hours-Cal itself).
    device_id: Option<String>,
    source: &'static str,
    note: String,
}

#[tauri::command]
fn my_device(state: State<'_, AppState>) -> R<MyDevice> {
    if let Some(guid) = read_machine_guid().filter(|_| cfg!(windows)) {
        let d = device_id_with(Path::new("."), Some(&guid)).map_err(|e| CmdError::new("IO", e.to_string()))?;
        debug_assert_eq!(d.source, DeviceIdSource::WindowsMachineGuid);
        return Ok(MyDevice { device_id: Some(d.code), source: "windows", note: "זהה למזהה ההפעלה ש-Hours-Cal מציגה במחשב זה.".into() });
    }
    // No Windows machine GUID: Hours-Cal uses a random fallback stored in its own folder. Read it if
    // it already exists (never create it here, so nothing is written into the Hours-Cal folder).
    if let Some(dir) = &state.hourscal_licensing_dir {
        let f = dir.join("license").join("device-fallback.id");
        if std::fs::read_to_string(&f).map(|s| s.trim().len() == 32).unwrap_or(false) {
            let d = device_id_with(dir, None).map_err(|e| CmdError::new("IO", e.to_string()))?;
            return Ok(MyDevice { device_id: Some(d.code), source: "fallback", note: "מזהה חלופי ש-Hours-Cal יצרה במחשב זה.".into() });
        }
    }
    Ok(MyDevice {
        device_id: None,
        source: "unknown",
        note: "לא ניתן לקבוע את מזהה המחשב מכאן. פתחו את Hours-Cal במחשב זה והעתיקו את מזהה ההפעלה ממסך ההפעלה.".into(),
    })
}

// ---------------------------------------------------------------------------------------------
// Licences
// ---------------------------------------------------------------------------------------------

#[tauri::command]
fn list_licenses(state: State<'_, AppState>) -> R<Vec<LicenseView>> {
    with(&state, |m| m.list(today()).map_err(|e| CmdError::new("REGISTRY", e)))
}

#[tauri::command]
fn license_stats(state: State<'_, AppState>) -> R<Stats> {
    with(&state, |m| m.stats(today()).map_err(|e| CmdError::new("REGISTRY", e)))
}

#[tauri::command]
fn issue_license(state: State<'_, AppState>, req: IssueRequest) -> R<Issued> {
    with(&state, |m| {
        let dir = m.license_dir(&state.default_license_dir);
        Ok(issue(&m.vault, &m.registry, &req, &dir, today())?)
    })
}

#[tauri::command]
fn reexport_license(state: State<'_, AppState>, id: String, out_dir: Option<String>) -> R<String> {
    with(&state, |m| {
        let dir = out_dir.map(PathBuf::from).unwrap_or_else(|| m.license_dir(&state.default_license_dir));
        Ok(reexport(&m.vault, &m.registry, &id, &dir)?)
    })
}

#[tauri::command]
fn set_revoked(state: State<'_, AppState>, id: String, revoked: bool, reason: Option<String>) -> R<()> {
    let reason = reason.map(|r| r.trim().chars().take(500).collect::<String>()).filter(|r| !r.is_empty());
    with(&state, |m| {
        let found = m.registry.set_revoked(&id, revoked, reason.as_deref()).map_err(|e| CmdError::new("REGISTRY", e.to_string()))?;
        if found { Ok(()) } else { Err(CmdError::new("NOT_FOUND", "הרישיון לא נמצא.")) }
    })
}

#[tauri::command]
fn export_revocation_list(state: State<'_, AppState>, out_path: String) -> R<usize> {
    let out = require_ext(&out_path, &[".txt"])?;
    with(&state, |m| {
        let recs = m.registry.all().map_err(|e| CmdError::new("REGISTRY", e.to_string()))?;
        atomic_write(&out, revocation_list_text(&recs).as_bytes()).map_err(|e| CmdError::new("IO", e.to_string()))?;
        Ok(recs.iter().filter(|r| r.revoked_at.is_some()).count())
    })
}

// ---------------------------------------------------------------------------------------------
// Explorer
// ---------------------------------------------------------------------------------------------

/// Shows a file selected in Explorer (or opens a folder). Only existing paths.
#[tauri::command]
fn reveal_path(path: String) -> R<()> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(CmdError::new("NOT_FOUND", "הקובץ או התיקייה לא נמצאו (ייתכן שהועברו או נמחקו)."));
    }
    #[cfg(windows)]
    {
        let mut cmd = std::process::Command::new("explorer");
        if p.is_dir() {
            cmd.arg(&p);
        } else {
            cmd.arg(format!("/select,{}", p.display()));
        }
        cmd.spawn().map_err(|e| CmdError::new("IO", e.to_string()))?;
    }
    #[cfg(not(windows))]
    {
        let dir = if p.is_dir() { p.clone() } else { p.parent().map(Path::to_path_buf).unwrap_or(p.clone()) };
        std::process::Command::new("xdg-open").arg(dir).spawn().map_err(|e| CmdError::new("IO", e.to_string()))?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app.path().app_local_data_dir()?;
            let docs = app.path().document_dir().or_else(|_| app.path().home_dir())?;
            let hourscal_licensing_dir = data_dir.parent().map(|p| p.join(HOURSCAL_IDENTIFIER).join("licensing"));
            app.manage(AppState {
                manager: Mutex::new(None),
                data_dir,
                default_license_dir: docs.join(LICENSE_FOLDER_NAME),
                hourscal_licensing_dir,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            set_license_dir,
            vault_status,
            vault_create,
            vault_import_cli_key,
            export_public_key,
            backup_create_cmd,
            backup_peek,
            backup_restore_cmd,
            my_device,
            list_licenses,
            license_stats,
            issue_license,
            reexport_license,
            set_revoked,
            export_revocation_list,
            reveal_path,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Hours-Cal License Manager");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_paths_are_restricted_to_expected_file_types() {
        assert!(require_ext("C:\\x\\license_public_key.txt", &[".txt"]).is_ok());
        assert!(require_ext("C:\\x\\backup.HCKEYBAK", &[".hckeybak"]).is_ok());
        for bad in ["", "   ", "C:\\x\\key.json", "C:\\x\\backup.hckeybak.exe", "C:\\x\\notes.txt.bat"] {
            assert_eq!(require_ext(bad, &[".txt", ".hckeybak"]).unwrap_err().code, "BAD_PATH", "{bad}");
        }
    }

    #[test]
    fn errors_reach_the_ui_with_stable_codes_and_hebrew_messages() {
        let e: CmdError = VaultError::ConfirmationRequired { previous_key_id: "k-1".into() }.into();
        assert_eq!(e.code, "CONFIRMATION_REQUIRED");
        assert!(!e.message.is_empty());
        let e: CmdError = IssueError::Validation(vec![FieldError { field: "deviceId".into(), message: "x".into() }]).into();
        assert_eq!(e.code, "VALIDATION");
        assert_eq!(e.fields[0].field, "deviceId");
        let e: CmdError = BackupError::WrongPassphraseOrCorrupt.into();
        assert_eq!(e.code, "WRONG_PASSPHRASE");
        let e: CmdError = BackupError::Vault(VaultError::NotConfigured).into();
        assert_eq!(e.code, "NOT_CONFIGURED");
        let json = serde_json::to_value(CmdError::new("X", "y")).unwrap();
        assert_eq!(json, serde_json::json!({ "code": "X", "message": "y", "fields": [] }));
    }
}
