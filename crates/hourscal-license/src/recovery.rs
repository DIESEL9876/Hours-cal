//! Read-only data recovery when the licence is missing, invalid or expired.
//!
//! Guarantees:
//! * The original business database file is NEVER opened by SQLite here.
//!   We copy it (plus its -wal file) into a private temporary folder and work
//!   on that snapshot, so no lock, journal, WAL checkpoint or migration can
//!   touch the original.
//! * The snapshot connection runs with `PRAGMA query_only = ON`.
//! * The application's migration code is never invoked in this mode.
//! * Output: one UTF-8 (BOM) CSV per table, opened correctly by Excel in
//!   Hebrew, plus a full consolidated SQLite copy and a Hebrew README.

use crate::dates::now_file_stamp;
use crate::fsutil::random_hex;
use rusqlite::{types::ValueRef, Connection, OpenFlags};
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

#[derive(Debug)]
pub enum RecoveryError {
    DatabaseNotFound(PathBuf),
    Io(io::Error),
    Sqlite(rusqlite::Error),
}
impl From<io::Error> for RecoveryError {
    fn from(e: io::Error) -> Self { RecoveryError::Io(e) }
}
impl From<rusqlite::Error> for RecoveryError {
    fn from(e: rusqlite::Error) -> Self { RecoveryError::Sqlite(e) }
}
impl std::fmt::Display for RecoveryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RecoveryError::DatabaseNotFound(p) => write!(f, "database not found: {}", p.display()),
            RecoveryError::Io(e) => write!(f, "io: {e}"),
            RecoveryError::Sqlite(e) => write!(f, "sqlite: {e}"),
        }
    }
}

pub struct RecoverySnapshot {
    conn: Option<Connection>,
    dir: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct TableSummary {
    pub table: String,
    pub rows: i64,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ExportReport {
    pub folder: PathBuf,
    pub tables: Vec<TableSummary>,
    pub sqlite_copy: PathBuf,
}

fn qident(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}

impl RecoverySnapshot {
    /// `work_dir` should be a temp/cache folder, NOT the data folder.
    pub fn open(db_path: &Path, work_dir: &Path) -> Result<Self, RecoveryError> {
        if !db_path.is_file() {
            return Err(RecoveryError::DatabaseNotFound(db_path.to_path_buf()));
        }
        let dir = work_dir.join(format!("hourscal-recovery-{}-{}", now_file_stamp(), random_hex(4)));
        fs::create_dir_all(&dir)?;
        let snap = dir.join("snapshot.sqlite");
        fs::copy(db_path, &snap)?;
        let wal = PathBuf::from(format!("{}-wal", db_path.display()));
        if wal.is_file() {
            fs::copy(&wal, dir.join("snapshot.sqlite-wal"))?;
        }
        // Read-write on OUR PRIVATE COPY only so SQLite can replay the WAL;
        // then lock it down with query_only.
        let conn = Connection::open_with_flags(&snap, OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
        conn.pragma_update(None, "query_only", "ON")?;
        Ok(RecoverySnapshot { conn: Some(conn), dir })
    }

    fn conn(&self) -> &Connection {
        self.conn.as_ref().expect("open")
    }

    /// Is a write attempt rejected? (used by tests and as a runtime assertion)
    pub fn is_write_protected(&self) -> bool {
        self.conn().execute_batch("CREATE TABLE __hourscal_write_probe(x)").is_err()
    }

    pub fn tables(&self) -> Result<Vec<TableSummary>, RecoveryError> {
        let mut st = self.conn().prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )?;
        let names: Vec<String> = st.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
        let mut out = Vec::new();
        for n in names {
            let rows: i64 = self.conn().query_row(&format!("SELECT COUNT(*) FROM {}", qident(&n)), [], |r| r.get(0))?;
            out.push(TableSummary { table: n, rows });
        }
        Ok(out)
    }

    pub fn export_all(&self, out_parent: &Path) -> Result<ExportReport, RecoveryError> {
        let folder = out_parent.join(format!("Hours-Cal-recovery-export-{}", now_file_stamp()));
        fs::create_dir_all(&folder)?;
        let tables = self.tables()?;
        for t in &tables {
            self.export_table_csv(&t.table, &folder.join(format!("{}.csv", safe_file_name(&t.table))))?;
        }
        let sqlite_copy = folder.join("hours-cal-data-copy.sqlite");
        {
            let mut dst = Connection::open(&sqlite_copy)?;
            let b = rusqlite::backup::Backup::new(self.conn(), &mut dst)?;
            b.run_to_completion(256, std::time::Duration::from_millis(0), None)?;
        }
        let mut readme = String::from(
            "ייצוא נתונים במצב שחזור — Hours-Cal\r\n\r\n\
             תיקייה זו נוצרה במצב קריאה בלבד, ללא שינוי של מסד הנתונים המקורי.\r\n\
             כל קובץ CSV מכיל טבלה אחת (קידוד UTF-8, נפתח ב-Excel).\r\n\
             הקובץ hours-cal-data-copy.sqlite הוא עותק מלא של הנתונים.\r\n\r\n\
             טבלאות ומספר שורות:\r\n",
        );
        for t in &tables {
            readme.push_str(&format!("  {} — {}\r\n", t.table, t.rows));
        }
        readme.push_str("\r\n© 2026 עילי נגר | כל הזכויות שמורות\r\n");
        fs::write(folder.join("README-שחזור.txt"), readme)?;
        Ok(ExportReport { folder, tables, sqlite_copy })
    }

    fn export_table_csv(&self, table: &str, path: &Path) -> Result<(), RecoveryError> {
        let mut st = self.conn().prepare(&format!("SELECT * FROM {}", qident(table)))?;
        let cols: Vec<String> = st.column_names().iter().map(|s| s.to_string()).collect();
        let mut f = io::BufWriter::new(fs::File::create(path)?);
        f.write_all(b"\xEF\xBB\xBF")?;
        writeln_csv(&mut f, cols.iter().map(|c| c.as_str()))?;
        let n = cols.len();
        let mut rows = st.query([])?;
        while let Some(r) = rows.next()? {
            let mut vals = Vec::with_capacity(n);
            for i in 0..n {
                vals.push(match r.get_ref(i)? {
                    ValueRef::Null => String::new(),
                    ValueRef::Integer(v) => v.to_string(),
                    ValueRef::Real(v) => v.to_string(),
                    ValueRef::Text(t) => String::from_utf8_lossy(t).into_owned(),
                    ValueRef::Blob(b) => format!("0x{}", crate::fsutil::hex(b)),
                });
            }
            writeln_csv(&mut f, vals.iter().map(|s| s.as_str()))?;
        }
        f.flush()?;
        Ok(())
    }
}

impl Drop for RecoverySnapshot {
    fn drop(&mut self) {
        drop(self.conn.take());
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn writeln_csv<'a, W: Write>(w: &mut W, fields: impl Iterator<Item = &'a str>) -> io::Result<()> {
    let line: Vec<String> = fields
        .map(|s| {
            // Neutralise spreadsheet formula injection in exported text.
            let s = if s.starts_with(['=', '+', '-', '@']) && s.parse::<f64>().is_err() { format!("'{s}") } else { s.to_string() };
            if s.contains([',', '"', '\n', '\r']) { format!("\"{}\"", s.replace('"', "\"\"")) } else { s }
        })
        .collect();
    write!(w, "{}\r\n", line.join(","))
}

fn safe_file_name(s: &str) -> String {
    s.chars().map(|c| if c.is_alphanumeric() || c == '_' || c == '-' { c } else { '_' }).collect()
}
