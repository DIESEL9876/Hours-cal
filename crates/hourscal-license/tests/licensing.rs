mod common;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine;
use common::*;
use hourscal_license::device::from_machine_guid;
use hourscal_license::license::*;

fn ctx<'a>(keys: &'a [ed25519_dalek::VerifyingKey], dev: &'a str, today: &str, revoked: &'a [String]) -> VerifyContext<'a> {
    VerifyContext { trusted_keys: keys, device_id: dev, today: d(today), revoked_ids: revoked }
}

#[test]
fn valid_license_activates_offline_and_persists_across_restarts() {
    let sk = keypair();
    let keys = [sk.verifying_key()];
    let dev = from_machine_guid(GUID_A);
    let t = TempDir::new("lic");
    let text = token_to_file_text(&issue(&sk, &dev, None));
    let p = LicenseStore::new(&t.0).install(&text, &ctx(&keys, &dev, "2026-10-13", &[])).unwrap();
    assert_eq!(p.licensee, "עילי נגר");
    // restart: fresh store
    assert!(LicenseStore::new(&t.0).check(&ctx(&keys, &dev, "2026-10-14", &[])).is_ok());
}

#[test]
fn bare_key_with_whitespace_is_accepted() {
    let sk = keypair();
    let keys = [sk.verifying_key()];
    let dev = from_machine_guid(GUID_A);
    let tok = issue(&sk, &dev, None);
    let messy = format!("  {}\n{}  \r\n", &tok[..20], &tok[20..]);
    assert!(verify(&messy, &ctx(&keys, &dev, "2026-10-13", &[])).is_ok());
}

#[test]
fn invalid_signature_rejected() {
    let real = keypair();
    let forger = keypair();
    let dev = from_machine_guid(GUID_A);
    let tok = issue(&forger, &dev, None);
    assert_eq!(verify(&tok, &ctx(&[real.verifying_key()], &dev, "2026-10-13", &[])), Err(LicenseError::BadSignature));
}

#[test]
fn modified_payload_rejected() {
    let sk = keypair();
    let dev = from_machine_guid(GUID_A);
    let tok = issue(&sk, &dev, Some("2026-12-31"));
    let (p, s) = tok.split_once('.').unwrap();
    let json = String::from_utf8(B64.decode(p).unwrap()).unwrap();
    for tampered in [json.replace("2026-12-31", "2099-12-31"), json.replace("עילי נגר", "מישהו אחר")] {
        let forged = format!("{}.{}", B64.encode(tampered.as_bytes()), s);
        assert_eq!(verify(&forged, &ctx(&[sk.verifying_key()], &dev, "2026-10-13", &[])), Err(LicenseError::BadSignature));
    }
    // flipped signature bit
    let mut sig = B64.decode(s).unwrap();
    sig[5] ^= 1;
    let forged = format!("{p}.{}", B64.encode(sig));
    assert_eq!(verify(&forged, &ctx(&[sk.verifying_key()], &dev, "2026-10-13", &[])), Err(LicenseError::BadSignature));
}

#[test]
fn another_machines_license_rejected() {
    let sk = keypair();
    let keys = [sk.verifying_key()];
    let tok = issue(&sk, &from_machine_guid(GUID_A), None);
    let other = from_machine_guid(GUID_B);
    assert!(matches!(verify(&tok, &ctx(&keys, &other, "2026-10-13", &[])), Err(LicenseError::WrongDevice { .. })));
}

#[test]
fn optional_expiry_and_perpetual() {
    let sk = keypair();
    let keys = [sk.verifying_key()];
    let dev = from_machine_guid(GUID_A);
    let exp = issue(&sk, &dev, Some("2027-01-31"));
    assert!(verify(&exp, &ctx(&keys, &dev, "2027-01-31", &[])).is_ok(), "last day inclusive");
    assert_eq!(verify(&exp, &ctx(&keys, &dev, "2027-02-01", &[])), Err(LicenseError::Expired { expires_at: "2027-01-31".into() }));
    let perpetual = issue(&sk, &dev, None);
    assert!(verify(&perpetual, &ctx(&keys, &dev, "2099-12-31", &[])).is_ok());
}

#[test]
fn revoked_replaced_license_rejected_and_replacement_works() {
    let sk = keypair();
    let keys = [sk.verifying_key()];
    let old_dev = from_machine_guid(GUID_A);
    let new_dev = from_machine_guid(GUID_B);
    let old = issue(&sk, &old_dev, None);
    let mut rp = payload(&sk, &new_dev, None);
    rp.license_id = "HCL-2026-REPL01".into();
    rp.replaces = Some("HCL-2026-TEST01".into());
    let replacement = sign_token(&rp, &sk);
    let revoked = vec!["HCL-2026-TEST01".to_string()];
    assert!(matches!(verify(&old, &ctx(&keys, &old_dev, "2026-10-13", &revoked)), Err(LicenseError::Revoked { .. })));
    let ok = verify(&replacement, &ctx(&keys, &new_dev, "2026-10-13", &revoked)).unwrap();
    assert_eq!(ok.replaces.as_deref(), Some("HCL-2026-TEST01"));
}

#[test]
fn invalid_input_never_overwrites_a_valid_license() {
    let sk = keypair();
    let keys = [sk.verifying_key()];
    let dev = from_machine_guid(GUID_A);
    let t = TempDir::new("keep");
    let store = LicenseStore::new(&t.0);
    store.install(&issue(&sk, &dev, None), &ctx(&keys, &dev, "2026-10-13", &[])).unwrap();
    let before = file_hash(&store.path());
    assert!(store.install("garbage", &ctx(&keys, &dev, "2026-10-13", &[])).is_err());
    assert!(store.install(&issue(&keypair(), &dev, None), &ctx(&keys, &dev, "2026-10-13", &[])).is_err());
    assert_eq!(before, file_hash(&store.path()));
}

#[test]
fn no_universal_bypass() {
    let dev = from_machine_guid(GUID_A);
    let none: [ed25519_dalek::VerifyingKey; 0] = [];
    for input in ["", ".", "ADMIN", "bypass", "a.b", &issue(&keypair(), &dev, None)] {
        assert!(verify(input, &ctx(&none, &dev, "2026-10-13", &[])).is_err(), "{input}");
    }
}

#[test]
fn key_rotation_two_trusted_keys() {
    let k1 = keypair();
    let k2 = keypair();
    let keys = [k1.verifying_key(), k2.verifying_key()];
    let dev = from_machine_guid(GUID_A);
    assert!(verify(&issue(&k1, &dev, None), &ctx(&keys, &dev, "2026-10-13", &[])).is_ok());
    assert!(verify(&issue(&k2, &dev, None), &ctx(&keys, &dev, "2026-10-13", &[])).is_ok());
}

#[test]
fn unknown_fields_rejected_even_if_signed() {
    let sk = keypair();
    let dev = from_machine_guid(GUID_A);
    let mut v = serde_json::to_value(payload(&sk, &dev, None)).unwrap();
    v["unlimited"] = serde_json::json!(true);
    let bytes = serde_json::to_vec(&v).unwrap();
    use ed25519_dalek::Signer;
    let tok = format!("{}.{}", B64.encode(&bytes), B64.encode(sk.sign(&bytes).to_bytes()));
    assert!(matches!(verify(&tok, &ctx(&[sk.verifying_key()], &dev, "2026-10-13", &[])), Err(LicenseError::Malformed(_))));
}

#[test]
fn hebrew_messages_exist_for_every_error() {
    for e in [LicenseError::BadSignature, LicenseError::Malformed("x".into()), LicenseError::UnsupportedFormat,
              LicenseError::Expired { expires_at: "2027-01-01".into() }, LicenseError::Revoked { license_id: "x".into() },
              LicenseError::WrongDevice { licensed: "a".into(), this_device: "b".into() },
              LicenseError::NotYetValid { issued_at: "2030-01-01".into() }] {
        assert!(e.message_he().chars().any(|c| ('\u{05D0}'..='\u{05EA}').contains(&c)));
    }
}
