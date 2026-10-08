//! Native SQLite storage: one connection (WAL, synchronous=FULL, foreign keys on),
//! every batch in a single transaction, consistent backups via `VACUUM INTO`.

use rusqlite::{params_from_iter, types::ValueRef, Connection, DatabaseName, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Number, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const DB_FILE: &str = "hours-cal.sqlite3";
const AUTO_BACKUP_KEEP: usize = 30;
const AUTO_BACKUP_INTERVAL: Duration = Duration::from_secs(20 * 60 * 60);

pub struct Db {
    conn: Mutex<Connection>,
    pub path: PathBuf,
    pub backup_dir: PathBuf,
}

#[derive(Deserialize)]
pub struct Stmt {
    pub sql: String,
    #[serde(default)]
    pub params: Vec<Value>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub name: String,
    pub created_at: String,
    pub size_bytes: u64,
}

fn configure(conn: &Connection) -> rusqlite::Result<()> {
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "FULL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.busy_timeout(Duration::from_secs(5))?;
    Ok(())
}

fn to_sql(v: &Value) -> rusqlite::types::Value {
    use rusqlite::types::Value as V;
    match v {
        Value::Null => V::Null,
        Value::Bool(b) => V::Integer(*b as i64),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                V::Integer(i)
            } else {
                V::Real(n.as_f64().unwrap_or(0.0))
            }
        }
        Value::String(s) => V::Text(s.clone()),
        other => V::Text(other.to_string()),
    }
}

fn from_sql(v: ValueRef<'_>) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => Value::Number(i.into()),
        ValueRef::Real(f) => Number::from_f64(f).map(Value::Number).unwrap_or(Value::Null),
        ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(_) => Value::Null,
    }
}

/// ISO-8601 UTC timestamp without external crates.
pub fn iso_now() -> String {
    iso_from(SystemTime::now())
}

fn iso_from(t: SystemTime) -> String {
    let secs = t.duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) as i64;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // civil-from-days (Howard Hinnant)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        y,
        m,
        d,
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

fn sanitize_reason(r: &str) -> String {
    let s: String = r
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .take(32)
        .collect();
    if s.is_empty() {
        "manual".into()
    } else {
        s
    }
}

impl Db {
    pub fn open(dir: &Path) -> Result<Db, String> {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let backup_dir = dir.join("backups");
        fs::create_dir_all(&backup_dir).map_err(|e| e.to_string())?;
        let path = dir.join(DB_FILE);
        let conn = Connection::open(&path).map_err(|e| e.to_string())?;
        configure(&conn).map_err(|e| e.to_string())?;
        Ok(Db { conn: Mutex::new(conn), path, backup_dir })
    }

    pub fn select(&self, sql: &str, params: &[Value]) -> Result<Vec<Map<String, Value>>, String> {
        let conn = self.conn.lock().map_err(|_| "database lock poisoned".to_string())?;
        let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
        let cols: Vec<String> = stmt.column_names().iter().map(|c| c.to_string()).collect();
        let mut rows = stmt
            .query(params_from_iter(params.iter().map(to_sql)))
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let mut m = Map::new();
            for (i, c) in cols.iter().enumerate() {
                m.insert(c.clone(), from_sql(row.get_ref(i).map_err(|e| e.to_string())?));
            }
            out.push(m);
        }
        Ok(out)
    }

    pub fn batch(&self, statements: &[Stmt]) -> Result<(), String> {
        let mut conn = self.conn.lock().map_err(|_| "database lock poisoned".to_string())?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        for s in statements {
            tx.execute(&s.sql, params_from_iter(s.params.iter().map(to_sql)))
                .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())
    }

    pub fn create_backup(&self, reason: &str) -> Result<BackupInfo, String> {
        let created_at = iso_now();
        let stamp = created_at.replace([':', '-'], "").replace('T', "-").replace('Z', "");
        let mut name = format!("backup-{}-{}.sqlite3", stamp, sanitize_reason(reason));
        let mut n = 1;
        while self.backup_dir.join(&name).exists() {
            name = format!("backup-{}-{}-{}.sqlite3", stamp, sanitize_reason(reason), n);
            n += 1;
        }
        let target = self.backup_dir.join(&name);
        let conn = self.conn.lock().map_err(|_| "database lock poisoned".to_string())?;
        conn.execute("VACUUM INTO ?1", [target.to_string_lossy().to_string()])
            .map_err(|e| e.to_string())?;
        let size_bytes = fs::metadata(&target).map(|m| m.len()).unwrap_or(0);
        Ok(BackupInfo { name, created_at, size_bytes })
    }

    pub fn list_backups(&self) -> Result<Vec<BackupInfo>, String> {
        let mut out = Vec::new();
        for entry in fs::read_dir(&self.backup_dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.ends_with(".sqlite3") {
                continue;
            }
            let meta = entry.metadata().map_err(|e| e.to_string())?;
            let created_at = meta.modified().map(iso_from).unwrap_or_default();
            out.push(BackupInfo { name, created_at, size_bytes: meta.len() });
        }
        out.sort_by(|a, b| b.name.cmp(&a.name));
        Ok(out)
    }

    pub fn restore_backup(&self, name: &str) -> Result<(), String> {
        if name.contains('/') || name.contains('\\') || name.contains("..") || !name.ends_with(".sqlite3") {
            return Err("שם גיבוי לא תקין".into());
        }
        let src = self.backup_dir.join(name);
        if !src.exists() {
            return Err("הגיבוי לא נמצא".into());
        }
        // Validate the backup before touching the live database.
        {
            let probe = Connection::open_with_flags(&src, OpenFlags::SQLITE_OPEN_READ_ONLY)
                .map_err(|e| e.to_string())?;
            let ok: String = probe
                .query_row("PRAGMA integrity_check", [], |r| r.get(0))
                .map_err(|e| e.to_string())?;
            if ok != "ok" {
                return Err(format!("קובץ הגיבוי פגום: {}", ok));
            }
            probe
                .query_row("SELECT COUNT(*) FROM businesses", [], |r| r.get::<_, i64>(0))
                .map_err(|_| "הקובץ אינו גיבוי של המערכת".to_string())?;
        }
        self.create_backup("before-restore")?;
        let mut conn = self.conn.lock().map_err(|_| "database lock poisoned".to_string())?;
        conn.restore(DatabaseName::Main, &src, None::<fn(rusqlite::backup::Progress)>)
            .map_err(|e| e.to_string())?;
        configure(&conn).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Daily automatic backup on start-up; keeps the newest AUTO_BACKUP_KEEP automatic backups.
    pub fn auto_backup(&self) -> Result<(), String> {
        let list = self.list_backups()?;
        let autos: Vec<&BackupInfo> = list.iter().filter(|b| b.name.ends_with("-auto.sqlite3")).collect();
        let newest = autos
            .iter()
            .filter_map(|b| fs::metadata(self.backup_dir.join(&b.name)).ok()?.modified().ok())
            .max();
        let due = match newest {
            None => true,
            Some(t) => SystemTime::now().duration_since(t).unwrap_or_default() > AUTO_BACKUP_INTERVAL,
        };
        let has_data: i64 = {
            let conn = self.conn.lock().map_err(|_| "database lock poisoned".to_string())?;
            conn.query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'businesses'",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0)
        };
        if due && has_data > 0 {
            self.create_backup("auto")?;
        }
        let mut autos: Vec<BackupInfo> = self
            .list_backups()?
            .into_iter()
            .filter(|b| b.name.ends_with("-auto.sqlite3"))
            .collect();
        autos.sort_by(|a, b| b.name.cmp(&a.name));
        for old in autos.iter().skip(AUTO_BACKUP_KEEP) {
            let _ = fs::remove_file(self.backup_dir.join(&old.name));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("hourscal-test-{}-{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn batch_is_atomic_and_select_roundtrips() {
        let db = Db::open(&tmpdir("atomic")).unwrap();
        db.batch(&[Stmt { sql: "CREATE TABLE businesses (id TEXT PRIMARY KEY, n INTEGER, s TEXT)".into(), params: vec![] }])
            .unwrap();
        let bad = db.batch(&[
            Stmt { sql: "INSERT INTO businesses VALUES (?, ?, ?)".into(), params: vec!["a".into(), 1.into(), "שלום".into()] },
            Stmt { sql: "INSERT INTO nope VALUES (1)".into(), params: vec![] },
        ]);
        assert!(bad.is_err());
        assert_eq!(db.select("SELECT * FROM businesses", &[]).unwrap().len(), 0);
        db.batch(&[Stmt {
            sql: "INSERT INTO businesses VALUES (?, ?, ?)".into(),
            params: vec!["a".into(), 1.into(), "שלום".into()],
        }])
        .unwrap();
        let rows = db.select("SELECT * FROM businesses WHERE id = ?", &["a".into()]).unwrap();
        assert_eq!(rows[0]["s"], Value::String("שלום".into()));
        assert_eq!(rows[0]["n"], Value::Number(1.into()));
    }

    #[test]
    fn backup_and_restore() {
        let db = Db::open(&tmpdir("backup")).unwrap();
        db.batch(&[Stmt { sql: "CREATE TABLE businesses (id TEXT PRIMARY KEY)".into(), params: vec![] }]).unwrap();
        db.batch(&[Stmt { sql: "INSERT INTO businesses VALUES ('x')".into(), params: vec![] }]).unwrap();
        let b = db.create_backup("manual").unwrap();
        db.batch(&[Stmt { sql: "DELETE FROM businesses".into(), params: vec![] }]).unwrap();
        db.restore_backup(&b.name).unwrap();
        assert_eq!(db.select("SELECT * FROM businesses", &[]).unwrap().len(), 1);
        assert!(db.restore_backup("../etc/passwd").is_err());
        assert!(db.list_backups().unwrap().iter().any(|x| x.name.contains("before-restore")));
    }

    #[test]
    fn iso_format() {
        assert_eq!(iso_from(UNIX_EPOCH + Duration::from_secs(1_791_331_200)), "2026-10-07T00:00:00Z");
    }
}
