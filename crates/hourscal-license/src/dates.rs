use std::fmt;
use std::time::{SystemTime, UNIX_EPOCH};

/// Calendar date (proleptic Gregorian). Licence dates are whole days, UTC.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Date {
    pub y: i32,
    pub m: u32,
    pub d: u32,
}

fn is_leap(y: i32) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

fn days_in_month(y: i32, m: u32) -> u32 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap(y) => 29,
        2 => 28,
        _ => 0,
    }
}

impl Date {
    pub fn new(y: i32, m: u32, d: u32) -> Result<Date, String> {
        if !(1970..=9999).contains(&y) || !(1..=12).contains(&m) || d < 1 || d > days_in_month(y, m) {
            return Err(format!("invalid date {y:04}-{m:02}-{d:02}"));
        }
        Ok(Date { y, m, d })
    }

    /// Strict `YYYY-MM-DD`.
    pub fn parse(s: &str) -> Result<Date, String> {
        let b = s.as_bytes();
        if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
            return Err(format!("date must be YYYY-MM-DD, got '{s}'"));
        }
        let num = |r: &str| r.parse::<u32>().map_err(|_| format!("bad date '{s}'"));
        if !s[0..4].bytes().chain(s[5..7].bytes()).chain(s[8..10].bytes()).all(|c| c.is_ascii_digit()) {
            return Err(format!("bad date '{s}'"));
        }
        Date::new(num(&s[0..4])? as i32, num(&s[5..7])?, num(&s[8..10])?)
    }

    /// Days since 1970-01-01 -> civil date (H. Hinnant's algorithm).
    pub fn from_unix_days(z: i64) -> Date {
        let z = z + 719_468;
        let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
        let doe = z - era * 146_097;
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        let y = yoe + era * 400;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
        let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
        Date { y: (if m <= 2 { y + 1 } else { y }) as i32, m, d }
    }

    pub fn today_utc() -> Date {
        let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
        Date::from_unix_days(secs.div_euclid(86_400))
    }
}

impl fmt::Display for Date {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:04}-{:02}-{:02}", self.y, self.m, self.d)
    }
}

/// Current UTC timestamp, e.g. `2026-10-13T09:31:00Z`.
pub fn now_utc_iso() -> String {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    let date = Date::from_unix_days(secs.div_euclid(86_400));
    let rem = secs.rem_euclid(86_400);
    format!("{}T{:02}:{:02}:{:02}Z", date, rem / 3600, (rem % 3600) / 60, rem % 60)
}

/// Compact UTC stamp for file names, e.g. `20261013-093100`.
pub fn now_file_stamp() -> String {
    now_utc_iso().replace(['-', ':'], "").replace('T', "-").trim_end_matches('Z').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn roundtrip_known_dates() {
        assert_eq!(Date::from_unix_days(0).to_string(), "1970-01-01");
        assert_eq!(Date::from_unix_days(20_739).to_string(), "2026-10-13");
        assert_eq!(Date::from_unix_days(11_016).to_string(), "2000-02-29");
    }
    #[test]
    fn strict_parse() {
        assert!(Date::parse("2026-02-29").is_err());
        assert!(Date::parse("2028-02-29").is_ok());
        assert!(Date::parse("2026-1-01").is_err());
        assert!(Date::parse("2026-13-01").is_err());
        assert!(Date::parse("２０２６-01-01").is_err());
        assert!(Date::parse("2026-10-13").unwrap() < Date::parse("2026-10-14").unwrap());
    }
}
