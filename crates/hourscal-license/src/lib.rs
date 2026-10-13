//! Hours-Cal offline licensing, one-time-per-version legal acceptance,
//! and read-only data recovery.
//!
//! Design rules enforced by this crate:
//! * Only PUBLIC Ed25519 keys are ever used for verification here.
//! * Nothing in this crate opens the business database for writing.
//! * Legal/licence state lives under the app config dir, never inside
//!   the business SQLite file or its backups.
//! * No network access of any kind.

pub mod dates;
pub mod device;
pub mod fsutil;
pub mod legal;
pub mod license;
pub mod recovery;
pub mod startup;

pub const COPYRIGHT_NOTICE: &str = "© 2026 עילי נגר | כל הזכויות שמורות";
