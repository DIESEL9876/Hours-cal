mod db;

use db::{BackupInfo, Db, Stmt};
use serde_json::{Map, Value};
use tauri::{Manager, State};

#[tauri::command]
fn db_select(db: State<'_, Db>, sql: String, params: Vec<Value>) -> Result<Vec<Map<String, Value>>, String> {
    db.select(&sql, &params)
}

#[tauri::command]
fn db_batch(db: State<'_, Db>, statements: Vec<Stmt>) -> Result<(), String> {
    db.batch(&statements)
}

#[tauri::command]
fn backup_create(db: State<'_, Db>, reason: String) -> Result<BackupInfo, String> {
    db.create_backup(&reason)
}

#[tauri::command]
fn backup_list(db: State<'_, Db>) -> Result<Vec<BackupInfo>, String> {
    db.list_backups()
}

#[tauri::command]
fn backup_restore(db: State<'_, Db>, name: String) -> Result<(), String> {
    db.restore_backup(&name)
}

#[tauri::command]
fn db_location(db: State<'_, Db>) -> String {
    db.path.to_string_lossy().to_string()
}

/// Writes an export file to a path the user picked in the native save dialog.
#[tauri::command]
fn write_export_file(path: String, contents: Vec<u8>) -> Result<(), String> {
    let lower = path.to_lowercase();
    if !(lower.ends_with(".xlsx") || lower.ends_with(".csv") || lower.ends_with(".html")) {
        return Err("סוג קובץ לא נתמך".into());
    }
    std::fs::write(&path, contents).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = app.path().app_data_dir().expect("no app data dir");
            let db = Db::open(&dir).map_err(|e| Box::<dyn std::error::Error>::from(e))?;
            if let Err(e) = db.auto_backup() {
                eprintln!("auto backup failed: {e}");
            }
            app.manage(db);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            db_select,
            db_batch,
            backup_create,
            backup_list,
            backup_restore,
            db_location,
            write_export_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
