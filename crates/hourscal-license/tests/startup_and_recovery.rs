mod common;
use common::*;
use hourscal_license::device::{device_id_with, from_machine_guid, DeviceIdSource};
use hourscal_license::legal::{LegalDocument, LegalStore, AGREEMENT_TEMPLATE};
use hourscal_license::license::{token_to_file_text, LicenseStore, VerifyContext};
use hourscal_license::recovery::{RecoveryError, RecoverySnapshot};
use hourscal_license::startup::{decide, Route, StartupConfig};
use rusqlite::Connection;
use std::fs;
use std::path::Path;

fn doc() -> LegalDocument { LegalDocument::render(AGREEMENT_TEMPLATE, "1.0", "legal@example.com") }

/// Simulated existing Hours-Cal database in WAL mode with some rows still
/// only in the -wal file (not checkpointed).
fn make_business_db(path: &Path) {
    let c = Connection::open(path).unwrap();
    c.execute_batch(
        "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA user_version=7;
         CREATE TABLE businesses(id INTEGER PRIMARY KEY, name TEXT);
         CREATE TABLE employees(id INTEGER PRIMARY KEY, business_id INT, name TEXT, note TEXT);
         CREATE TABLE attendance(id INTEGER PRIMARY KEY, employee_id INT, day TEXT, check_in TEXT, check_out TEXT, break_min INT);
         INSERT INTO businesses VALUES (1,'מאפיית השכונה');
         INSERT INTO employees VALUES (1,1,'דנה כהן','משמרת \"בוקר\", קבועה'),(2,1,'יוסי לוי','=HYPERLINK(\"x\")');
         INSERT INTO attendance VALUES (1,1,'2026-10-01','07:00','15:30',30),(2,2,'2026-10-01','08:00','17:00',45);",
    ).unwrap();
    std::mem::forget(c); // keep WAL un-checkpointed, like a running/crashed app
}

fn cfg<'a>(t: &'a Path, ver: &'a str, d: &'a LegalDocument, keys: &'a [ed25519_dalek::VerifyingKey], guid: Option<&'a str>, today: &str, db: &'a Path) -> StartupConfig<'a> {
    StartupConfig { config_dir: t, app_version: ver, doc: d, trusted_keys: keys, revoked_ids: &[], machine_guid: guid, today: common::d(today), db_path: db }
}

#[test]
fn full_owner_journey_upgrade_1_1_2_to_1_1_3() {
    let sk = keypair();
    let keys = [sk.verifying_key()];
    let t = TempDir::new("journey");
    let db = t.0.join("data.sqlite");
    make_business_db(&db);
    let db_hash = file_hash(&db);
    let d = doc();

    // 1. first launch of 1.1.3 -> agreement
    assert!(matches!(decide(&cfg(&t.0, "1.1.3", &d, &keys, Some(GUID_A), "2026-10-13", &db)).unwrap(), Route::LegalAgreement { .. }));
    // 2. accept -> no licence yet -> activation, recovery offered, no error text
    LegalStore::new(&t.0).accept("1.1.3", &d, Some(180), None).unwrap();
    match decide(&cfg(&t.0, "1.1.3", &d, &keys, Some(GUID_A), "2026-10-13", &db)).unwrap() {
        Route::Activation { device_id, reason_he, recovery_available } => {
            assert_eq!(device_id, from_machine_guid(GUID_A));
            assert!(reason_he.is_none());
            assert!(recovery_available);
        }
        r => panic!("{r:?}"),
    }
    // 3. owner issues licence for the shown device id, user imports it
    let dev = from_machine_guid(GUID_A);
    LicenseStore::new(&t.0).install(&token_to_file_text(&issue(&sk, &dev, None)),
        &VerifyContext { trusted_keys: &keys, device_id: &dev, today: common::d("2026-10-13"), revoked_ids: &[] }).unwrap();
    // 4. ready; relaunches stay ready with no agreement
    for _ in 0..3 {
        assert!(matches!(decide(&cfg(&t.0, "1.1.3", &d, &keys, Some(GUID_A), "2026-10-14", &db)).unwrap(), Route::Ready { .. }));
    }
    // 5. update to 1.1.4 -> agreement once, licence still valid afterwards
    assert!(matches!(decide(&cfg(&t.0, "1.1.4", &d, &keys, Some(GUID_A), "2026-11-01", &db)).unwrap(), Route::LegalAgreement { .. }));
    LegalStore::new(&t.0).accept("1.1.4", &d, None, None).unwrap();
    assert!(matches!(decide(&cfg(&t.0, "1.1.4", &d, &keys, Some(GUID_A), "2026-11-01", &db)).unwrap(), Route::Ready { .. }));
    // startup routing never touched the business database
    assert_eq!(db_hash, file_hash(&db));
}

#[test]
fn rejected_terms_leave_everything_untouched() {
    let keys = [keypair().verifying_key()];
    let t = TempDir::new("reject");
    let db = t.0.join("data.sqlite");
    make_business_db(&db);
    let wal = t.0.join("data.sqlite-wal");
    let (h1, h2) = (file_hash(&db), file_hash(&wal));
    let d = doc();
    for _ in 0..3 {
        assert!(matches!(decide(&cfg(&t.0, "1.1.3", &d, &keys, Some(GUID_A), "2026-10-13", &db)).unwrap(), Route::LegalAgreement { .. }));
    }
    assert_eq!((h1, h2), (file_hash(&db), file_hash(&wal)));
    assert!(!t.0.join("legal").exists(), "declining writes no acceptance");
    assert!(!t.0.join("license").exists());
}

#[test]
fn backup_db_on_another_computer_does_not_carry_activation() {
    let sk = keypair();
    let keys = [sk.verifying_key()];
    let pc1 = TempDir::new("pc1");
    let pc2 = TempDir::new("pc2");
    let d = doc();
    let dev1 = from_machine_guid(GUID_A);
    LegalStore::new(&pc1.0).accept("1.1.3", &d, None, None).unwrap();
    LicenseStore::new(&pc1.0).install(&issue(&sk, &dev1, None),
        &VerifyContext { trusted_keys: &keys, device_id: &dev1, today: common::d("2026-10-13"), revoked_ids: &[] }).unwrap();
    // business backup copied to pc2
    let db1 = pc1.0.join("data.sqlite");
    make_business_db(&db1);
    let db2 = pc2.0.join("data.sqlite");
    fs::copy(&db1, &db2).unwrap();
    assert!(matches!(decide(&cfg(&pc2.0, "1.1.3", &d, &keys, Some(GUID_B), "2026-10-13", &db2)).unwrap(), Route::LegalAgreement { .. }));
    LegalStore::new(&pc2.0).accept("1.1.3", &d, None, None).unwrap();
    assert!(matches!(decide(&cfg(&pc2.0, "1.1.3", &d, &keys, Some(GUID_B), "2026-10-13", &db2)).unwrap(), Route::Activation { .. }));
    // even if someone copies pc1's licence file over, it is rejected on pc2
    fs::create_dir_all(pc2.0.join("license")).unwrap();
    fs::copy(pc1.0.join("license/license.hclic"), pc2.0.join("license/license.hclic")).unwrap();
    match decide(&cfg(&pc2.0, "1.1.3", &d, &keys, Some(GUID_B), "2026-10-13", &db2)).unwrap() {
        Route::Activation { reason_he: Some(r), .. } => assert!(r.contains("מחשב אחר")),
        r => panic!("{r:?}"),
    }
}

#[test]
fn expired_license_goes_to_activation_with_recovery() {
    let sk = keypair();
    let keys = [sk.verifying_key()];
    let t = TempDir::new("exp");
    let db = t.0.join("data.sqlite");
    make_business_db(&db);
    let d = doc();
    let dev = from_machine_guid(GUID_A);
    LegalStore::new(&t.0).accept("1.1.3", &d, None, None).unwrap();
    LicenseStore::new(&t.0).install(&issue(&sk, &dev, Some("2026-12-31")),
        &VerifyContext { trusted_keys: &keys, device_id: &dev, today: common::d("2026-10-13"), revoked_ids: &[] }).unwrap();
    match decide(&cfg(&t.0, "1.1.3", &d, &keys, Some(GUID_A), "2027-01-01", &db)).unwrap() {
        Route::Activation { reason_he: Some(r), recovery_available: true, .. } => assert!(r.contains("2026-12-31")),
        r => panic!("{r:?}"),
    }
    assert!(t.0.join("license/license.hclic").exists(), "expired licence file is kept, not deleted");
}

#[test]
fn recovery_is_read_only_and_exports_everything_including_wal_data() {
    let t = TempDir::new("recovery");
    let db = t.0.join("data.sqlite");
    make_business_db(&db);
    let wal = t.0.join("data.sqlite-wal");
    assert!(fs::metadata(&wal).unwrap().len() > 0, "test precondition: data sits in WAL");
    let (h_db, h_wal) = (file_hash(&db), file_hash(&wal));
    let out = TempDir::new("out");
    let work = TempDir::new("work");
    {
        let snap = RecoverySnapshot::open(&db, &work.0).unwrap();
        assert!(snap.is_write_protected());
        let tables = snap.tables().unwrap();
        let counts: Vec<(String, i64)> = tables.iter().map(|t| (t.table.clone(), t.rows)).collect();
        assert_eq!(counts, vec![("attendance".into(), 2), ("businesses".into(), 1), ("employees".into(), 2)]);
        let rep = snap.export_all(&out.0).unwrap();
        let emp = fs::read_to_string(rep.folder.join("employees.csv")).unwrap();
        assert!(emp.starts_with('\u{feff}'));
        assert!(emp.contains("דנה כהן"));
        assert!(emp.contains("\"משמרת \"\"בוקר\"\", קבועה\""), "CSV escaping");
        assert!(emp.contains("'=HYPERLINK"), "formula injection neutralised");
        let copy = Connection::open(&rep.sqlite_copy).unwrap();
        let n: i64 = copy.query_row("SELECT COUNT(*) FROM attendance", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 2);
        let uv: i64 = copy.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(uv, 7, "no migration ran");
        assert!(rep.folder.join("README-שחזור.txt").exists());
    }
    assert_eq!((h_db, h_wal), (file_hash(&db), file_hash(&wal)), "original files byte-identical");
    assert_eq!(fs::read_dir(&work.0).unwrap().count(), 0, "temp snapshot cleaned up");
}

#[test]
fn recovery_missing_db_is_a_clear_error() {
    let t = TempDir::new("nodb");
    assert!(matches!(RecoverySnapshot::open(&t.0.join("nope.sqlite"), &t.0), Err(RecoveryError::DatabaseNotFound(_))));
}

#[test]
fn device_id_stable_across_reinstall_and_fallback_behaviour() {
    let install1 = TempDir::new("i1");
    let install2 = TempDir::new("i2"); // app config wiped / reinstalled
    let a = device_id_with(&install1.0, Some(GUID_A)).unwrap();
    let b = device_id_with(&install2.0, Some(GUID_A)).unwrap();
    assert_eq!(a, b, "MachineGuid-based ID survives app reinstall");
    assert_eq!(a.source, DeviceIdSource::WindowsMachineGuid);
    let f1 = device_id_with(&install1.0, None).unwrap();
    assert_eq!(f1, device_id_with(&install1.0, None).unwrap(), "fallback stable while config kept");
    assert!(f1.code.starts_with("HCF-"));
    assert_ne!(f1, device_id_with(&install2.0, None).unwrap(), "fallback changes if config is wiped");
}

#[test]
fn copying_the_whole_app_folder_to_another_pc_still_requires_acceptance() {
    let keys = [keypair().verifying_key()];
    let pc1 = TempDir::new("cp1");
    let pc2 = TempDir::new("cp2");
    let d = doc();
    let db = pc2.0.join("data.sqlite");
    LegalStore::new(&pc1.0).accept("1.1.3", &d, None, Some(&from_machine_guid(GUID_A))).unwrap();
    // same PC: not shown
    assert!(matches!(decide(&cfg(&pc1.0, "1.1.3", &d, &keys, Some(GUID_A), "2026-10-13", &db)).unwrap(), Route::Activation { .. }));
    // whole folder copied to another PC
    fs::create_dir_all(pc2.0.join("legal")).unwrap();
    fs::copy(pc1.0.join("legal/acceptance.json"), pc2.0.join("legal/acceptance.json")).unwrap();
    assert!(matches!(decide(&cfg(&pc2.0, "1.1.3", &d, &keys, Some(GUID_B), "2026-10-13", &db)).unwrap(), Route::LegalAgreement { .. }));
}
