//! Staged enforcement: owner can pre-install his licence before a build enforces it.
mod common;
use common::*;
use hourscal_license::device::from_machine_guid;
use hourscal_license::enforcement::{decode_unverified, decide_staged, parse_key_file, preinstall, KeyConfig};
use hourscal_license::legal::{LegalDocument, LegalStore, AGREEMENT_TEMPLATE};
use hourscal_license::license::{public_key_to_text, InstallError, LicenseError, LicenseStore};
use hourscal_license::startup::{Route, StartupConfig};

fn doc() -> LegalDocument {
    LegalDocument::render(AGREEMENT_TEMPLATE, "1.0", "")
}

fn route(dir: &std::path::Path, version: &str, keys: &KeyConfig, db: &std::path::Path) -> Route {
    let d = doc();
    let trusted = keys.trusted();
    decide_staged(
        &StartupConfig {
            config_dir: dir,
            app_version: version,
            doc: &d,
            trusted_keys: &trusted,
            revoked_ids: &[],
            machine_guid: Some(GUID_A),
            today: d_("2026-10-20"),
            db_path: db,
        },
        keys,
    )
    .unwrap()
}

fn d_(s: &str) -> hourscal_license::dates::Date {
    d(s)
}

#[test]
fn key_file_parsing() {
    let placeholder = "# Hours-Cal licence PUBLIC key\n# (not configured yet)\n\n";
    assert!(matches!(parse_key_file(placeholder), KeyConfig::NotConfigured));
    assert!(!parse_key_file(placeholder).enforced());
    let k1 = keypair();
    let k2 = keypair();
    let one = format!("# key\n{}\n", public_key_to_text(&k1.verifying_key()));
    assert!(matches!(parse_key_file(&one), KeyConfig::Keys(ref v) if v.len() == 1));
    let two = format!("{}\n{}\n", public_key_to_text(&k1.verifying_key()), public_key_to_text(&k2.verifying_key()));
    assert!(matches!(parse_key_file(&two), KeyConfig::Keys(ref v) if v.len() == 2));
    let bad = parse_key_file("not-a-key\n");
    assert!(matches!(bad, KeyConfig::Invalid(_)));
    assert!(bad.enforced(), "malformed key must FAIL CLOSED");
    assert!(bad.trusted().is_empty());
}

#[test]
fn not_enforced_still_requires_agreement_once_per_version_but_no_licence() {
    let t = TempDir::new("unenf");
    let db = t.0.join("hours-cal.sqlite3");
    let keys = KeyConfig::NotConfigured;
    assert!(matches!(route(&t.0, "1.1.3", &keys, &db), Route::LegalAgreement { .. }));
    LegalStore::new(&t.0).accept("1.1.3", &doc(), None, Some(&from_machine_guid(GUID_A))).unwrap();
    assert!(matches!(route(&t.0, "1.1.3", &keys, &db), Route::Ready { .. }));
    // restart: still ready, no second agreement
    assert!(matches!(route(&t.0, "1.1.3", &keys, &db), Route::Ready { .. }));
    // version update: agreement again
    assert!(matches!(route(&t.0, "1.1.4", &keys, &db), Route::LegalAgreement { .. }));
}

#[test]
fn malformed_key_file_fails_closed_even_with_a_licence() {
    let t = TempDir::new("closed");
    let db = t.0.join("hours-cal.sqlite3");
    std::fs::write(&db, b"x").unwrap();
    let dev = from_machine_guid(GUID_A);
    LegalStore::new(&t.0).accept("1.1.3", &doc(), None, Some(&dev)).unwrap();
    let sk = keypair();
    preinstall(&LicenseStore::new(&t.0), &issue(&sk, &dev, None), &dev, d("2026-10-20")).unwrap();
    let r = route(&t.0, "1.1.3", &parse_key_file("garbage"), &db);
    assert!(matches!(r, Route::Activation { recovery_available: true, .. }), "{r:?}");
}

#[test]
fn preinstalled_owner_licence_is_accepted_once_enforcement_is_enabled() {
    let t = TempDir::new("pre");
    let db = t.0.join("hours-cal.sqlite3");
    std::fs::write(&db, b"x").unwrap();
    let dev = from_machine_guid(GUID_A);
    let sk = keypair();
    LegalStore::new(&t.0).accept("1.1.3", &doc(), None, Some(&dev)).unwrap();

    // Build without key: owner imports his licence (signature cannot be checked yet).
    let p = preinstall(&LicenseStore::new(&t.0), &issue(&sk, &dev, None), &dev, d("2026-10-20")).unwrap();
    assert_eq!(p.licensee, "עילי נגר");
    assert!(matches!(route(&t.0, "1.1.3", &KeyConfig::NotConfigured, &db), Route::Ready { .. }));

    // Build WITH the owner's public key: straight to Ready, no activation screen.
    let enforced = parse_key_file(&public_key_to_text(&sk.verifying_key()));
    let r = route(&t.0, "1.1.3", &enforced, &db);
    assert!(matches!(r, Route::Ready { ref licensee, .. } if licensee == "עילי נגר"), "{r:?}");

    // A build embedding a DIFFERENT key rejects the pre-installed file (signature now checked).
    let other = parse_key_file(&public_key_to_text(&keypair().verifying_key()));
    let r = route(&t.0, "1.1.3", &other, &db);
    assert!(matches!(r, Route::Activation { reason_he: Some(_), recovery_available: true, .. }), "{r:?}");
}

#[test]
fn preinstall_rejects_wrong_device_expired_and_malformed_without_writing() {
    let t = TempDir::new("prebad");
    let store = LicenseStore::new(&t.0);
    let dev = from_machine_guid(GUID_A);
    let other = from_machine_guid(GUID_B);
    let sk = keypair();
    let e = preinstall(&store, &issue(&sk, &other, None), &dev, d("2026-10-20")).unwrap_err();
    assert!(matches!(e, InstallError::Invalid(LicenseError::WrongDevice { .. })));
    let e = preinstall(&store, &issue(&sk, &dev, Some("2026-10-01")), &dev, d("2026-10-20")).unwrap_err();
    assert!(matches!(e, InstallError::Invalid(LicenseError::Expired { .. })));
    assert!(matches!(decode_unverified("hello", &dev, d("2026-10-20")), Err(LicenseError::Malformed(_))));
    assert!(store.load().is_none(), "nothing may be written for a rejected licence");
}

#[test]
fn preinstall_keeps_the_previous_file() {
    let t = TempDir::new("prekeep");
    let store = LicenseStore::new(&t.0);
    let dev = from_machine_guid(GUID_A);
    let sk = keypair();
    preinstall(&store, &issue(&sk, &dev, None), &dev, d("2026-10-20")).unwrap();
    let first = store.load().unwrap();
    preinstall(&store, &issue(&sk, &dev, Some("2030-01-01")), &dev, d("2026-10-20")).unwrap();
    let prev = std::fs::read_to_string(store.path().with_file_name("license.previous.hclic")).unwrap();
    assert_eq!(prev, first);
}
