//! Reads legacy Excel 97-2003 (.xls) attendance reports for the import feature.
//!
//! Values only (calamine): formulas are never evaluated and macros/embedded objects are never run.
//! A formula cell without a stored result is reported as unresolved. Input size and table size are
//! capped. Nothing is written to disk; the bytes arrive in memory and are dropped after reading.

use calamine::{Data, Reader, Xls};
use serde::Serialize;
use std::io::Cursor;

pub const MAX_BYTES: usize = 20 * 1024 * 1024;
const MAX_ROWS: usize = 5000;
const MAX_COLS: usize = 80;
const MAX_SHEETS: usize = 30;

#[derive(Serialize, Default, Debug, PartialEq)]
pub struct XlsCell {
    /// Display text.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub t: Option<String>,
    /// Numeric value (Excel serial for dates/times).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub n: Option<f64>,
    /// The number is a date/time/duration.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub d: bool,
    /// Formula without a stored result.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub f: bool,
}

#[derive(Serialize, Debug)]
pub struct XlsSheet {
    pub name: String,
    pub rows: Vec<Vec<XlsCell>>,
}

fn cell(v: &Data) -> XlsCell {
    match v {
        Data::Empty => XlsCell::default(),
        Data::String(s) => XlsCell { t: Some(s.trim().to_string()), ..Default::default() },
        Data::Int(i) => XlsCell { t: Some(i.to_string()), n: Some(*i as f64), ..Default::default() },
        Data::Float(f) => XlsCell { t: Some(f.to_string()), n: Some(*f), ..Default::default() },
        Data::Bool(b) => XlsCell { t: Some(if *b { "TRUE" } else { "FALSE" }.into()), ..Default::default() },
        Data::DateTime(dt) => XlsCell { t: Some(dt.as_f64().to_string()), n: Some(dt.as_f64()), d: true, f: false },
        Data::DateTimeIso(s) | Data::DurationIso(s) => XlsCell { t: Some(s.clone()), ..Default::default() },
        Data::Error(e) => XlsCell { t: Some(format!("#{e:?}")), ..Default::default() },
    }
}

pub fn read_xls(bytes: &[u8]) -> Result<Vec<XlsSheet>, String> {
    if bytes.len() > MAX_BYTES {
        return Err("הקובץ גדול מדי לייבוא (מעל 20MB).".into());
    }
    let mut wb: Xls<_> = Xls::new(Cursor::new(bytes)).map_err(|_| "לא ניתן לקרוא את קובץ ה-Excel (‎.xls). ייתכן שהקובץ פגום או מוגן בסיסמה.".to_string())?;
    let mut out = Vec::new();
    for name in wb.sheet_names().into_iter().take(MAX_SHEETS) {
        let Ok(range) = wb.worksheet_range(&name) else { continue };
        let formulas = wb.worksheet_formula(&name).ok();
        let Some((r0, c0)) = range.start() else {
            out.push(XlsSheet { name, rows: vec![] });
            continue;
        };
        let (h, w) = range.get_size();
        let rows_n = (r0 as usize + h).min(MAX_ROWS);
        let cols_n = (c0 as usize + w).min(MAX_COLS);
        let mut rows: Vec<Vec<XlsCell>> = (0..rows_n).map(|_| (0..cols_n).map(|_| XlsCell::default()).collect()).collect();
        for (ri, row) in range.rows().enumerate() {
            let ar = r0 as usize + ri;
            if ar >= rows_n {
                break;
            }
            for (ci, v) in row.iter().enumerate() {
                let ac = c0 as usize + ci;
                if ac < cols_n {
                    rows[ar][ac] = cell(v);
                }
            }
        }
        if let Some(f) = formulas {
            if let Some((fr0, fc0)) = f.start() {
                for (ri, row) in f.rows().enumerate() {
                    for (ci, formula) in row.iter().enumerate() {
                        let (ar, ac) = (fr0 as usize + ri, fc0 as usize + ci);
                        if !formula.is_empty() && ar < rows_n && ac < cols_n {
                            let c = &mut rows[ar][ac];
                            // No stored (cached) result: report it; the formula itself is never evaluated.
                            if c.n.is_none() && c.t.as_deref().map_or(true, |t| t.trim().is_empty()) {
                                *c = XlsCell { f: true, ..Default::default() };
                            }
                        }
                    }
                }
            }
        }
        out.push(XlsSheet { name, rows });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Vec<u8> {
        std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../src/import/__tests__/fixtures/legacy.xls")).unwrap()
    }

    #[test]
    fn reads_values_dates_times_at_their_real_positions() {
        let sheets = read_xls(&fixture()).unwrap();
        assert_eq!(sheets.len(), 1);
        let rows = &sheets[0].rows;
        assert_eq!(rows[3][0].t.as_deref(), Some("תאריך עבודה"));
        assert_eq!(rows[3][1].t.as_deref(), Some("התחלה"));
        // 2026-09-01 = Excel serial 46266; 08:00 = 1/3 day; native date/time cells are marked.
        assert_eq!(rows[4][0].n, Some(46266.0));
        assert!(rows[4][0].d);
        assert!((rows[4][1].n.unwrap() - 8.0 / 24.0).abs() < 1e-9 && rows[4][1].d);
        assert!((rows[4][2].n.unwrap() - 16.0 / 24.0).abs() < 1e-9);
        assert_eq!(rows[4][3].n, Some(30.0));
    }

    #[test]
    fn formula_without_stored_result_is_reported_not_evaluated() {
        let sheets = read_xls(&fixture()).unwrap();
        let r = &sheets[0].rows[6]; // 2026-09-03: exit is a formula written without a cached value
        assert!(r[2].f, "{:?}", r[2]);
        assert!(r[2].n.is_none());
    }

    #[test]
    fn rejects_garbage_and_oversized_input() {
        assert!(read_xls(b"not an excel file").is_err());
        assert!(read_xls(&vec![0u8; MAX_BYTES + 1]).is_err());
    }
}
