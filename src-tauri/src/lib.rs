mod db;
mod import_xls;
mod licensing;

use db::{BackupInfo, Db, Stmt};
use serde_json::{Map, Value};
use std::sync::OnceLock;
use tauri::State;

/// The business database. Opened only after the licensing gate reports Ready
/// (see `licensing::on_ready`); until then every data command is refused.
pub struct DbState(pub OnceLock<Db>);

fn db<'a>(state: &'a State<'_, DbState>) -> Result<&'a Db, String> {
    licensing::require_ready()?;
    state.0.get().ok_or_else(|| "DB_NOT_OPEN".to_string())
}

#[tauri::command]
fn db_select(state: State<'_, DbState>, sql: String, params: Vec<Value>) -> Result<Vec<Map<String, Value>>, String> {
    db(&state)?.select(&sql, &params)
}

#[tauri::command]
fn db_batch(state: State<'_, DbState>, statements: Vec<Stmt>) -> Result<(), String> {
    db(&state)?.batch(&statements)
}

#[tauri::command]
fn backup_create(state: State<'_, DbState>, reason: String) -> Result<BackupInfo, String> {
    db(&state)?.create_backup(&reason)
}

#[tauri::command]
fn backup_list(state: State<'_, DbState>) -> Result<Vec<BackupInfo>, String> {
    db(&state)?.list_backups()
}

#[tauri::command]
fn backup_restore(state: State<'_, DbState>, name: String) -> Result<(), String> {
    db(&state)?.restore_backup(&name)
}

#[tauri::command]
fn db_location(state: State<'_, DbState>) -> Result<String, String> {
    Ok(db(&state)?.path.to_string_lossy().to_string())
}

/// Writes an export file to a path the user picked in the native save dialog.
#[tauri::command]
fn write_export_file(path: String, contents: Vec<u8>) -> Result<(), String> {
    licensing::require_ready()?;
    let lower = path.to_lowercase();
    if !(lower.ends_with(".xlsx") || lower.ends_with(".csv") || lower.ends_with(".html")) {
        return Err("סוג קובץ לא נתמך".into());
    }
    std::fs::write(&path, contents).map_err(|e| e.to_string())
}

/// Attendance import: reads a legacy .xls report sent as raw bytes (values only, nothing executed,
/// nothing written to disk).
#[tauri::command]
fn import_read_xls(request: tauri::ipc::Request<'_>) -> Result<Vec<import_xls::XlsSheet>, String> {
    licensing::require_ready()?;
    match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => import_xls::read_xls(bytes),
        _ => Err("פורמט בקשה לא צפוי".into()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // The database is NOT opened here any more: it opens in licensing::on_ready.
        .manage(DbState(OnceLock::new()))
        .invoke_handler(tauri::generate_handler![
            db_select,
            db_batch,
            backup_create,
            backup_list,
            backup_restore,
            db_location,
            write_export_file,
            import_read_xls,
            licensing::licensing_startup_route,
            licensing::legal_document,
            licensing::legal_accept,
            licensing::legal_history,
            licensing::legal_accepted_text,
            licensing::legal_decline_and_exit,
            licensing::license_device_id,
            licensing::license_activate,
            licensing::license_import_file,
            licensing::license_status,
            licensing::recovery_tables,
            licensing::recovery_export,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
