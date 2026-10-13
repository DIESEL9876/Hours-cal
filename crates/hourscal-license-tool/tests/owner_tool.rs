//! End-to-end: the owner tool issues a licence that the APP-SIDE code accepts.
use hourscal_license::dates::Date;
use hourscal_license::device::from_machine_guid;
use hourscal_license::legal::{LegalDocument, LegalStore, AGREEMENT_TEMPLATE};
use hourscal_license::license::{public_key_from_text, LicenseStore, VerifyContext};
use hourscal_license::startup::{decide, Route, StartupConfig};
use std::path::PathBuf;
use std::process::Command;

const BIN: &str = env!("CARGO_BIN_EXE_hourscal-license-tool");
const GUID: &str = "4c4c4544-0038-3010-8052-b4c04f4a3732";

fn tmp(tag: &str) -> PathBuf {
    let p = std::env::temp_dir().join(format!("hc-tool-{tag}-{}", hourscal_license::fsutil::random_hex(5)));
    std::fs::create_dir_all(&p).unwrap();
    p
}
fn run(args: &[&str]) -> (bool, String) {
    let o = Command::new(BIN).args(args).output().unwrap();
    (o.status.success(), format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr)))
}

#[test]
fn owner_issues_and_app_activates() {
    let keys = tmp("keys");
    let (ok, out) = run(&["keygen", "--dir", keys.to_str().unwrap()]);
    assert!(ok, "{out}");
    // refuses to overwrite
    assert!(!run(&["keygen", "--dir", keys.to_str().unwrap()]).0);
    let priv_key = keys.join("hourscal-signing-key.PRIVATE.txt");
    let pub_key = keys.join("license_public_key.txt");
    let dev = from_machine_guid(GUID);
    let lic = keys.join("owner.hclic");
    let (ok, out) = run(&["issue", "--key", priv_key.to_str().unwrap(), "--device", &dev.to_lowercase(),
        "--licensee", "עילי נגר", "--org", "Hours-Cal", "--out", lic.to_str().unwrap()]);
    assert!(ok, "{out}");
    assert!(out.contains("License ID : HCL-"));
    let (ok, out) = run(&["verify", "--pub", pub_key.to_str().unwrap(), "--device", &dev, lic.to_str().unwrap()]);
    assert!(ok && out.starts_with("VALID"), "{out}");
    // wrong device via tool
    assert!(!run(&["verify", "--pub", pub_key.to_str().unwrap(), "--device", &from_machine_guid("other"), lic.to_str().unwrap()]).0);

    // App side: embedded public key + startup routing
    let vk = public_key_from_text(&std::fs::read_to_string(&pub_key).unwrap()).unwrap();
    let app_cfg = tmp("app");
    let db = app_cfg.join("data.sqlite");
    std::fs::write(&db, b"x").unwrap();
    let doc = LegalDocument::render(AGREEMENT_TEMPLATE, "1.0", "legal@example.com");
    LegalStore::new(&app_cfg).accept("1.1.3", &doc, None, None).unwrap();
    let keys_arr = [vk];
    let today = Date::today_utc();
    LicenseStore::new(&app_cfg).install(&std::fs::read_to_string(&lic).unwrap(),
        &VerifyContext { trusted_keys: &keys_arr, device_id: &dev, today, revoked_ids: &[] }).unwrap();
    let route = decide(&StartupConfig { config_dir: &app_cfg, app_version: "1.1.3", doc: &doc, trusted_keys: &keys_arr,
        revoked_ids: &[], machine_guid: Some(GUID), today, db_path: &db }).unwrap();
    assert!(matches!(route, Route::Ready { ref licensee, .. } if licensee == "עילי נגר"), "{route:?}");

    // issuance log written
    let log = std::fs::read_to_string(keys.join("issued-licenses.csv")).unwrap();
    assert!(log.contains(&dev));
    let _ = std::fs::remove_dir_all(&keys);
    let _ = std::fs::remove_dir_all(&app_cfg);
}

#[test]
fn replacement_and_expiry_options() {
    let keys = tmp("keys2");
    assert!(run(&["keygen", "--dir", keys.to_str().unwrap()]).0);
    let k = keys.join("hourscal-signing-key.PRIVATE.txt");
    let out = keys.join("r.hclic");
    let (ok, o) = run(&["issue", "--key", k.to_str().unwrap(), "--device", &from_machine_guid("new-pc"), "--licensee", "לקוח",
        "--expires", "2099-12-31", "--replaces", "HCL-2026-OLD001", "--out", out.to_str().unwrap()]);
    assert!(ok, "{o}");
    let (_, shown) = run(&["inspect", out.to_str().unwrap()]);
    assert!(shown.contains("\"replaces\":\"HCL-2026-OLD001\"") && shown.contains("2099-12-31"));
    // bad inputs rejected
    assert!(!run(&["issue", "--key", k.to_str().unwrap(), "--device", "HC1-NOPE", "--licensee", "x"]).0);
    assert!(!run(&["issue", "--key", k.to_str().unwrap(), "--device", &from_machine_guid("a"), "--licensee", "x", "--expires", "2001-01-01"]).0);
    let _ = std::fs::remove_dir_all(&keys);
}

#[test]
fn tool_device_id_matches_app_algorithm_on_this_machine() {
    let (ok, out) = run(&["device-id"]);
    if let Some(g) = hourscal_license::device::read_machine_guid() {
        assert!(ok);
        assert_eq!(out.trim(), from_machine_guid(&g));
    }
}

#[test]
fn refuses_key_generation_inside_git_repo() {
    let repo = tmp("repo");
    std::fs::create_dir_all(repo.join(".git")).unwrap();
    let (ok, out) = run(&["keygen", "--dir", repo.join("keys").to_str().unwrap()]);
    assert!(!ok && out.contains("git"), "{out}");
    let _ = std::fs::remove_dir_all(&repo);
}
