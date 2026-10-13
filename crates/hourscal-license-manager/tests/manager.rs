//! License Manager core: keys, issuance, registry, backups, compatibility with Hours-Cal.
use base64::engine::general_purpose::{STANDARD as B64S, URL_SAFE_NO_PAD as B64};
use base64::Engine;
use ed25519_dalek::SigningKey;
use hourscal_license::dates::Date;
use hourscal_license::device::from_machine_guid;
use hourscal_license::enforcement::{decide_staged, parse_key_file, KeyConfig};
use hourscal_license::fsutil::random_hex;
use hourscal_license::legal::{LegalDocument, LegalStore, AGREEMENT_TEMPLATE};
use hourscal_license::license::{key_id, sign_token, verify, LicenseError, LicensePayload, LicenseStore, VerifyContext, FORMAT, FORMAT_VERSION};
use hourscal_license::startup::{Route, StartupConfig};
use hourscal_license_manager::backup::{create_backup, peek_backup_key_id, restore_backup, BackupError};
use hourscal_license_manager::issue::{issue, reexport, IssueError, IssueRequest};
use hourscal_license_manager::registry::{revocation_list_text, LicenseStatus};
use hourscal_license_manager::vault::{parse_public_key_file, VaultError, VaultState, CONFIRM_NEW_KEY};
use hourscal_license_manager::Manager;
use std::path::{Path, PathBuf};

struct Tmp(PathBuf);
impl Tmp {
    fn new(tag: &str) -> Tmp {
        let p = std::env::temp_dir().join(format!("hclm-{tag}-{}", random_hex(6)));
        std::fs::create_dir_all(&p).unwrap();
        Tmp(p)
    }
}
impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

const GUID_A: &str = "4c4c4544-0038-3010-8052-b4c04f4a3732";
const GUID_B: &str = "9f1e2d3c-1111-2222-3333-444455556666";
const PASS: &str = "correct horse battery staple";

fn today() -> Date {
    Date::parse("2026-10-20").unwrap()
}

fn req(device: &str, kind: &str, expires: Option<&str>) -> IssueRequest {
    IssueRequest {
        licensee: "עילי נגר".into(),
        device_id: device.into(),
        nickname: Some("מחשב משרד".into()),
        license_type: kind.into(),
        expires_at: expires.map(String::from),
        notes: Some("הערה".into()),
        replaces: None,
    }
}

fn ready_manager(tag: &str) -> (Tmp, Manager) {
    let t = Tmp::new(tag);
    let m = Manager::open(&t.0.join("data")).unwrap();
    m.vault.create(None).unwrap();
    (t, m)
}

/// The exact Hours-Cal app-side path: embedded public key file → staged decision → Ready.
fn hours_cal_accepts(public_key_file: &str, license_file_text: &str, guid: &str) -> Route {
    let t = Tmp::new("app");
    let keys = parse_key_file(public_key_file);
    assert!(matches!(keys, KeyConfig::Keys(_)), "public key file must enable enforcement");
    let doc = LegalDocument::render(AGREEMENT_TEMPLATE, "1.0", "");
    let dev = from_machine_guid(guid);
    LegalStore::new(&t.0).accept("1.1.4", &doc, None, Some(&dev)).unwrap();
    let trusted = keys.trusted();
    // Activation as Hours-Cal does it (LicenseStore::install verifies first).
    let _ = LicenseStore::new(&t.0).install(license_file_text, &VerifyContext { trusted_keys: &trusted, device_id: &dev, today: today(), revoked_ids: &[] });
    decide_staged(
        &StartupConfig { config_dir: &t.0, app_version: "1.1.4", doc: &doc, trusted_keys: &trusted, revoked_ids: &[], machine_guid: Some(guid), today: today(), db_path: &t.0.join("x.sqlite3") },
        &keys,
    )
    .unwrap()
}

#[test]
fn initial_key_creation() {
    let t = Tmp::new("create");
    let m = Manager::open(&t.0).unwrap();
    assert_eq!(m.vault.status().state, VaultState::NoKey);
    let info = m.vault.create(None).unwrap();
    assert!(info.key_id.starts_with("k-"));
    let st = m.vault.status();
    assert_eq!(st.state, VaultState::Ready);
    assert_eq!(st.key.unwrap().key_id, info.key_id);
    let pubtxt = std::fs::read_to_string(m.vault.public_key_path()).unwrap();
    assert_eq!(key_id(&parse_public_key_file(&pubtxt).unwrap()), info.key_id);
    // Hours-Cal parses the exported file as an enforcing key configuration.
    assert!(matches!(parse_key_file(&pubtxt), KeyConfig::Keys(ref k) if k.len() == 1));
}

#[test]
fn reopening_never_regenerates_the_key() {
    let t = Tmp::new("reopen");
    let id = Manager::open(&t.0).unwrap().vault.create(None).unwrap().key_id;
    let key_file = std::fs::read(t.0.join("keys/owner-signing-key.json")).unwrap();
    let m = Manager::open(&t.0).unwrap();
    assert_eq!(m.vault.status().key.unwrap().key_id, id);
    assert!(matches!(m.vault.create(None), Err(VaultError::AlreadyConfigured { .. })));
    assert!(matches!(m.vault.create(Some(CONFIRM_NEW_KEY)), Err(VaultError::AlreadyConfigured { .. })));
    assert_eq!(std::fs::read(t.0.join("keys/owner-signing-key.json")).unwrap(), key_file, "key file untouched");
}

#[test]
fn lost_key_is_never_silently_replaced() {
    let t = Tmp::new("lost");
    let m = Manager::open(&t.0).unwrap();
    let old = m.vault.create(None).unwrap().key_id;
    std::fs::remove_file(t.0.join("keys/owner-signing-key.json")).unwrap();
    let st = m.vault.status();
    assert_eq!(st.state, VaultState::KeyUnavailable);
    assert_eq!(st.configured_key_id.as_deref(), Some(old.as_str()));
    assert!(matches!(m.vault.create(None), Err(VaultError::ConfirmationRequired { ref previous_key_id }) if *previous_key_id == old));
    assert!(matches!(m.vault.create(Some("כן")), Err(VaultError::ConfirmationRequired { .. })));
    let new = m.vault.create(Some(CONFIRM_NEW_KEY)).unwrap().key_id;
    assert_ne!(new, old);
}

#[test]
fn issuing_a_perpetual_license() {
    let (t, m) = ready_manager("perp");
    let dev = from_machine_guid(GUID_A);
    // pasted in lower case with spaces → normalised
    let out = t.0.join("out");
    let r = issue(&m.vault, &m.registry, &req(&format!("  {}  ", dev.to_lowercase()), "perpetual", None), &out, today()).unwrap();
    assert_eq!(r.license.record.device_id, dev);
    assert_eq!(r.license.record.license_type, "perpetual");
    assert!(r.license.record.expires_at.is_none());
    assert_eq!(r.license.status, LicenseStatus::Valid);
    let file = std::fs::read_to_string(&r.file_path).unwrap();
    assert!(file.starts_with("-----BEGIN HOURS-CAL LICENSE-----"));
    assert!(r.file_path.ends_with(".hclic") && r.file_path.contains("עילי נגר"));
    // Hours-Cal (enforcing build with this public key) accepts it on that computer only.
    let pubtxt = m.vault.public_key_text().unwrap();
    assert!(matches!(hours_cal_accepts(&pubtxt, &file, GUID_A), Route::Ready { ref licensee, .. } if licensee == "עילי נגר"));
    assert!(matches!(hours_cal_accepts(&pubtxt, &file, GUID_B), Route::Activation { .. }));
}

#[test]
fn issuing_a_time_limited_license() {
    let (t, m) = ready_manager("limited");
    let dev = from_machine_guid(GUID_A);
    let r = issue(&m.vault, &m.registry, &req(&dev, "limited", Some("2027-12-31")), &t.0.join("out"), today()).unwrap();
    assert_eq!(r.license.record.license_type, "limited");
    assert_eq!(r.license.record.expires_at.as_deref(), Some("2027-12-31"));
    let vk = m.vault.verifying_key().unwrap();
    let ctx = |d: &str| VerifyContext { trusted_keys: std::slice::from_ref(&vk), device_id: &dev, today: Date::parse(d).unwrap(), revoked_ids: &[] };
    assert!(verify(&r.activation_key, &ctx("2027-12-31")).is_ok(), "last day inclusive");
    assert!(matches!(verify(&r.activation_key, &ctx("2028-01-01")), Err(LicenseError::Expired { .. })));
    // expiry required and must not be in the past
    for bad in [None, Some("2026-10-19"), Some("31/12/2027")] {
        let e = issue(&m.vault, &m.registry, &req(&dev, "limited", bad), &t.0.join("out"), today()).unwrap_err();
        assert!(matches!(e, IssueError::Validation(ref v) if v.iter().any(|f| f.field == "expiresAt")), "{bad:?}");
    }
}

#[test]
fn invalid_device_ids_are_rejected_and_nothing_is_written() {
    let (t, m) = ready_manager("baddev");
    let out = t.0.join("out");
    let good = from_machine_guid(GUID_A);
    for bad in ["", "ABC", "HC2-AAAA-BBBB-CCCC-DDDD-EEEE-FFFF", &good[..good.len() - 1], "HC1-AAAA-BBBB-CCCC-DDDD-EEEE-FFFU"] {
        let e = issue(&m.vault, &m.registry, &req(bad, "perpetual", None), &out, today()).unwrap_err();
        assert!(matches!(e, IssueError::Validation(ref v) if v.iter().any(|f| f.field == "deviceId")), "{bad}");
    }
    let mut no_name = req(&good, "perpetual", None);
    no_name.licensee = "  ".into();
    assert!(matches!(issue(&m.vault, &m.registry, &no_name, &out, today()), Err(IssueError::Validation(_))));
    assert!(!out.exists() || std::fs::read_dir(&out).unwrap().next().is_none());
    assert!(m.registry.all().unwrap().is_empty());
}

#[test]
fn registry_persists_across_restarts() {
    let t = Tmp::new("persist");
    let dir = t.0.join("data");
    let dev = from_machine_guid(GUID_A);
    let (id1, id2) = {
        let m = Manager::open(&dir).unwrap();
        m.vault.create(None).unwrap();
        let a = issue(&m.vault, &m.registry, &req(&dev, "perpetual", None), &t.0.join("out"), today()).unwrap();
        let b = issue(&m.vault, &m.registry, &req(&from_machine_guid(GUID_B), "limited", Some("2027-01-31")), &t.0.join("out"), today()).unwrap();
        (a.license.record.license_id, b.license.record.license_id)
    };
    let m = Manager::open(&dir).unwrap();
    let list = m.list(today()).unwrap();
    assert_eq!(list.len(), 2);
    let a = list.iter().find(|v| v.record.license_id == id1).unwrap();
    assert_eq!(a.record.nickname.as_deref(), Some("מחשב משרד"));
    assert_eq!(a.record.notes.as_deref(), Some("הערה"));
    assert!(a.record.file_path.as_deref().unwrap().ends_with(".hclic"));
    assert!(list.iter().any(|v| v.record.license_id == id2));
    let s = m.stats(today()).unwrap();
    assert_eq!((s.total, s.perpetual, s.limited, s.valid), (2, 1, 1, 2));
}

#[test]
fn many_licenses_with_the_same_key() {
    let (t, m) = ready_manager("many");
    let pubtxt = m.vault.public_key_text().unwrap();
    let vk = parse_public_key_file(&pubtxt).unwrap();
    let mut ids = std::collections::HashSet::new();
    for i in 0..12 {
        let guid = format!("guid-{i}");
        let dev = from_machine_guid(&guid);
        let r = issue(&m.vault, &m.registry, &req(&dev, if i % 2 == 0 { "perpetual" } else { "limited" }, if i % 2 == 0 { None } else { Some("2030-01-01") }), &t.0.join("out"), today()).unwrap();
        assert_eq!(r.license.record.key_id, key_id(&vk));
        assert!(verify(&r.activation_key, &VerifyContext { trusted_keys: &[vk], device_id: &dev, today: today(), revoked_ids: &[] }).is_ok());
        assert!(ids.insert(r.license.record.license_id));
    }
    assert_eq!(m.stats(today()).unwrap().total, 12);
    assert_eq!(std::fs::read_dir(t.0.join("out")).unwrap().count(), 12, "one file per licence, none overwritten");
}

#[test]
fn backup_and_restore_on_a_new_computer() {
    let (t, m) = ready_manager("backup");
    let dev = from_machine_guid(GUID_A);
    let first = issue(&m.vault, &m.registry, &req(&dev, "perpetual", None), &t.0.join("out"), today()).unwrap();
    issue(&m.vault, &m.registry, &req(&from_machine_guid(GUID_B), "limited", Some("2028-06-30")), &t.0.join("out"), today()).unwrap();
    let original_pub = m.vault.public_key_text().unwrap();
    let bak = t.0.join("keys-backup.hckeybak");
    assert!(matches!(create_backup(&m.vault, &m.registry, "short", &bak), Err(BackupError::WeakPassphrase)));
    let sum = create_backup(&m.vault, &m.registry, PASS, &bak).unwrap();
    assert_eq!(sum.licenses, 2);
    assert_eq!(peek_backup_key_id(&bak).unwrap(), sum.key_id);

    // New computer: empty data folder.
    let other = Tmp::new("newpc");
    let m2 = Manager::open(&other.0).unwrap();
    assert!(matches!(restore_backup(&m2.vault, &m2.registry, &bak, "wrong passphrase!!", None), Err(BackupError::WrongPassphraseOrCorrupt)));
    assert_eq!(m2.vault.status().state, VaultState::NoKey, "failed restore changes nothing");
    let r = restore_backup(&m2.vault, &m2.registry, &bak, PASS, None).unwrap();
    assert_eq!(r.key.key_id, sum.key_id);
    assert_eq!((r.licenses_in_backup, r.licenses_added), (2, 2));
    assert_eq!(m2.vault.public_key_text().unwrap(), original_pub);
    assert_eq!(m2.list(today()).unwrap().len(), 2);
    // New licences from the restored key are accepted by builds with the ORIGINAL public key.
    let dev3 = from_machine_guid("third");
    let n = issue(&m2.vault, &m2.registry, &req(&dev3, "perpetual", None), &other.0.join("out"), today()).unwrap();
    assert!(matches!(hours_cal_accepts(&original_pub, &std::fs::read_to_string(&n.file_path).unwrap(), "third"), Route::Ready { .. }));
    // Restoring again merges nothing new and keeps the key.
    let again = restore_backup(&m2.vault, &m2.registry, &bak, PASS, None).unwrap();
    assert_eq!(again.licenses_added, 0);
    assert!(m2.registry.get(&first.license.record.license_id).unwrap().is_some());
}

#[test]
fn tampered_backup_is_rejected() {
    let (t, m) = ready_manager("tamper");
    let bak = t.0.join("b.hckeybak");
    create_backup(&m.vault, &m.registry, PASS, &bak).unwrap();
    let mut j: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&bak).unwrap()).unwrap();
    // 1) header change (bound as associated data)
    let mut h = j.clone();
    h["created_at"] = "2020-01-01T00:00:00Z".into();
    std::fs::write(&bak, serde_json::to_string(&h).unwrap()).unwrap();
    let fresh = Tmp::new("tamper2");
    let m2 = Manager::open(&fresh.0).unwrap();
    assert!(matches!(restore_backup(&m2.vault, &m2.registry, &bak, PASS, None), Err(BackupError::WrongPassphraseOrCorrupt)));
    // 2) ciphertext change
    let mut ct = B64S.decode(j["ciphertext_b64"].as_str().unwrap()).unwrap();
    ct[10] ^= 1;
    j["ciphertext_b64"] = B64S.encode(ct).into();
    std::fs::write(&bak, serde_json::to_string(&j).unwrap()).unwrap();
    assert!(matches!(restore_backup(&m2.vault, &m2.registry, &bak, PASS, None), Err(BackupError::WrongPassphraseOrCorrupt)));
    assert_eq!(m2.vault.status().state, VaultState::NoKey);
}

#[test]
fn restore_of_a_different_key_is_blocked() {
    let (ta, a) = ready_manager("keyA");
    let (tb, b) = ready_manager("keyB");
    let bak = tb.0.join("b.hckeybak");
    create_backup(&b.vault, &b.registry, PASS, &bak).unwrap();
    let before = a.vault.status().key.unwrap().key_id;
    assert!(matches!(restore_backup(&a.vault, &a.registry, &bak, PASS, Some(CONFIRM_NEW_KEY)), Err(BackupError::Vault(VaultError::DifferentKey { .. }))));
    assert_eq!(a.vault.status().key.unwrap().key_id, before);
    let _ = ta;
}

/// Exactly what `hourscal-license-tool keygen` writes.
fn cli_key_file(sk: &SigningKey) -> String {
    format!(
        "# HOURS-CAL LICENCE SIGNING KEY - PRIVATE\n# Owner: Ilay Nagar. NEVER share, commit, email, or ship this file.\n# key_id: {}\n# created: 2026-10-13T08:00:00Z\n{}\n",
        key_id(&sk.verifying_key()),
        B64.encode(sk.to_bytes())
    )
}

#[test]
fn importing_the_command_line_key_keeps_existing_licenses_valid() {
    let sk = SigningKey::from_bytes(&[7u8; 32]);
    let dev = from_machine_guid(GUID_A);
    // licence previously issued by the command-line tool with this key
    let old = sign_token(
        &LicensePayload {
            format: FORMAT.into(),
            format_version: FORMAT_VERSION,
            license_id: "HCL-2026-CLI01".into(),
            licensee: "עילי נגר".into(),
            organization: None,
            device_id: dev.clone(),
            scope: "single-device".into(),
            issued_at: "2026-10-13".into(),
            expires_at: None,
            replaces: None,
            key_id: key_id(&sk.verifying_key()),
        },
        &sk,
    );
    let t = Tmp::new("cli");
    let m = Manager::open(&t.0).unwrap();
    let info = m.vault.import_cli_key_text(&cli_key_file(&sk), None).unwrap();
    assert_eq!(info.key_id, key_id(&sk.verifying_key()));
    assert_eq!(info.created_at, "2026-10-13T08:00:00Z");
    let pubtxt = m.vault.public_key_text().unwrap();
    assert!(matches!(hours_cal_accepts(&pubtxt, &old, GUID_A), Route::Ready { .. }), "CLI-issued licence still valid");
    let n = issue(&m.vault, &m.registry, &req(&dev, "perpetual", None), &t.0.join("out"), today()).unwrap();
    assert!(verify(&n.activation_key, &VerifyContext { trusted_keys: &[sk.verifying_key()], device_id: &dev, today: today(), revoked_ids: &[] }).is_ok());
    // garbage is rejected
    assert!(matches!(Manager::open(&Tmp::new("cli2").0).unwrap().vault.import_cli_key_text("hello", None), Err(VaultError::InvalidKeyFile(_))));
}

fn all_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for e in std::fs::read_dir(dir).unwrap().flatten() {
        let p = e.path();
        if p.is_dir() {
            all_files(&p, out)
        } else {
            out.push(p)
        }
    }
}

#[test]
fn private_key_never_leaves_the_vault() {
    let seed = [42u8; 32];
    let sk = SigningKey::from_bytes(&seed);
    let t = Tmp::new("leak");
    let data = t.0.join("data");
    let out = t.0.join("licences");
    let m = Manager::open(&data).unwrap();
    m.vault.import_cli_key_text(&cli_key_file(&sk), None).unwrap();
    let dev = from_machine_guid(GUID_A);
    let issued = issue(&m.vault, &m.registry, &req(&dev, "perpetual", None), &out, today()).unwrap();
    let re = reexport(&m.vault, &m.registry, &issued.license.record.license_id, &out).unwrap();
    let bak = t.0.join("backup.hckeybak");
    let sum = create_backup(&m.vault, &m.registry, PASS, &bak).unwrap();
    std::fs::write(t.0.join("revoked.txt"), revocation_list_text(&m.registry.all().unwrap())).unwrap();

    let needles: Vec<Vec<u8>> = vec![seed.to_vec(), B64.encode(seed).into_bytes(), B64S.encode(seed).into_bytes(), hourscal_license::fsutil::hex(&seed).into_bytes()];
    let mut files = Vec::new();
    all_files(&t.0, &mut files);
    let key_file = data.join("keys").join("owner-signing-key.json");
    // Positive control: on non-Windows dev builds the key store is unencrypted, so the scanner MUST
    // find the key there — proving it would detect a leak anywhere else.
    #[cfg(not(windows))]
    {
        let kb = std::fs::read(&key_file).unwrap();
        assert!(needles.iter().any(|n| kb.windows(n.len()).any(|w| w == n.as_slice())), "scanner sanity check");
    }
    for f in &files {
        if *f == key_file {
            continue; // the protected store itself (DPAPI-encrypted on Windows)
        }
        let bytes = std::fs::read(f).unwrap();
        for n in &needles {
            assert!(!bytes.windows(n.len()).any(|w| w == n.as_slice()), "private key material found in {}", f.display());
        }
    }
    assert!(files.iter().any(|f| f.extension().is_some_and(|e| e == "hclic")));
    assert!(std::path::Path::new(&re).exists());
    // Everything the GUI can receive, serialised:
    let dtos = serde_json::json!({
        "status": m.vault.status(), "list": m.list(today()).unwrap(), "stats": m.stats(today()).unwrap(),
        "issued": issued, "backup": sum, "public": m.vault.public_key_text().unwrap(),
    })
    .to_string();
    for n in &needles {
        assert!(!dtos.as_bytes().windows(n.len()).any(|w| w == n.as_slice()), "private key material in UI data");
    }
}

#[test]
fn statuses_revocation_replacement_and_reexport() {
    let (t, m) = ready_manager("status");
    let out = t.0.join("out");
    let a = issue(&m.vault, &m.registry, &req(&from_machine_guid(GUID_A), "perpetual", None), &out, today()).unwrap();
    let mut rep = req(&from_machine_guid(GUID_B), "perpetual", None);
    rep.replaces = Some(a.license.record.license_id.clone());
    let b = issue(&m.vault, &m.registry, &rep, &out, today()).unwrap();
    let c = issue(&m.vault, &m.registry, &req(&from_machine_guid("c"), "limited", Some("2026-11-30")), &out, today()).unwrap();
    // replacement to the same computer is refused
    let mut same = req(&from_machine_guid(GUID_B), "perpetual", None);
    same.replaces = Some(b.license.record.license_id.clone());
    assert!(matches!(issue(&m.vault, &m.registry, &same, &out, today()), Err(IssueError::Validation(_))));

    m.registry.set_revoked(&c.license.record.license_id, true, Some("לקוח עזב")).unwrap();
    let list = m.list(Date::parse("2026-12-15").unwrap()).unwrap();
    let get = |id: &str| list.iter().find(|v| v.record.license_id == id).unwrap().clone();
    assert_eq!(get(&a.license.record.license_id).status, LicenseStatus::Replaced);
    assert_eq!(get(&a.license.record.license_id).replaced_by.as_deref(), Some(b.license.record.license_id.as_str()));
    assert_eq!(get(&b.license.record.license_id).replaces_chain, vec![a.license.record.license_id.clone()]);
    assert_eq!(get(&b.license.record.license_id).status, LicenseStatus::Valid);
    assert_eq!(get(&c.license.record.license_id).status, LicenseStatus::Revoked);
    let txt = revocation_list_text(&m.registry.all().unwrap());
    assert!(txt.contains(&c.license.record.license_id) && !txt.contains(&b.license.record.license_id));
    assert!(txt.contains("Offline licences cannot be revoked remotely"));
    // un-revoke → expired (past its date on 2026-12-15)
    m.registry.set_revoked(&c.license.record.license_id, false, None).unwrap();
    let list = m.list(Date::parse("2026-12-15").unwrap()).unwrap();
    assert_eq!(list.iter().find(|v| v.record.license_id == c.license.record.license_id).unwrap().status, LicenseStatus::Expired);
    // re-export writes an identical licence to a new file
    let p = reexport(&m.vault, &m.registry, &b.license.record.license_id, &out).unwrap();
    assert_ne!(p, b.file_path);
    assert_eq!(std::fs::read_to_string(&p).unwrap(), std::fs::read_to_string(&b.file_path).unwrap());
}

#[test]
fn foreign_key_records_are_reported_as_unverifiable() {
    let (_t, m) = ready_manager("foreign");
    let (_t2, other) = ready_manager("foreign2");
    let dev = from_machine_guid(GUID_A);
    let x = issue(&other.vault, &other.registry, &req(&dev, "perpetual", None), &_t2.0.join("o"), today()).unwrap();
    m.registry.merge(&[x.license.record.clone()]).unwrap();
    let v = m.list(today()).unwrap();
    assert_eq!(v[0].status, LicenseStatus::Unverifiable);
    assert!(reexport(&m.vault, &m.registry, &x.license.record.license_id, &_t.0.join("o")).is_err(), "never re-export what does not verify");
}

/// The owner's documented go-live workflow, end to end:
/// 1) create the key in the License Manager, 2) issue a licence for the owner's own computer,
/// 3) import it into the CURRENT Hours-Cal build (no public key embedded → licence not yet required;
///    `preinstall` stores it), 4) build Hours-Cal with the exported license_public_key.txt →
///    the enforced build opens straight to Ready on that computer, while another computer must activate.
#[test]
fn own_computer_activation_workflow_before_enforcement() {
    use hourscal_license::enforcement::preinstall;
    let (t, m) = ready_manager("golive");
    let my_device = from_machine_guid(GUID_A);
    let issued = issue(&m.vault, &m.registry, &req(&my_device, "perpetual", None), &t.0.join("out"), today()).unwrap();
    let hclic = std::fs::read_to_string(&issued.file_path).unwrap();
    let exported = std::fs::read_to_string(m.vault.public_key_path()).unwrap();

    // Hours-Cal as shipped today: the repository key file has no key line → not enforced.
    let repo_key_file = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src-tauri/keys/license_public_key.txt")).unwrap();
    let current = parse_key_file(&repo_key_file);
    assert!(matches!(current, KeyConfig::NotConfigured), "the shipped Hours-Cal must not enforce yet");

    let app = Tmp::new("hourscal-config");
    let doc = LegalDocument::render(AGREEMENT_TEMPLATE, "1.0", "");
    let db = app.0.join("hours-cal.sqlite3");
    let cfg = |version: &'static str, trusted: &[ed25519_dalek::VerifyingKey], keys: &KeyConfig| {
        decide_staged(
            &StartupConfig { config_dir: &app.0, app_version: version, doc: &doc, trusted_keys: trusted, revoked_ids: &[], machine_guid: Some(GUID_A), today: today(), db_path: &db },
            keys,
        )
        .unwrap()
    };
    LegalStore::new(&app.0).accept("1.1.3", &doc, None, Some(&my_device)).unwrap();
    assert!(matches!(cfg("1.1.3", &[], &current), Route::Ready { .. }));
    // Owner imports the licence file in the current version ("ייבוא קובץ רישיון").
    let p = preinstall(&LicenseStore::new(&app.0), &hclic, &my_device, today()).unwrap();
    assert_eq!(p.license_id, issued.license.record.license_id);

    // Enforced build (e.g. 1.1.4) with the exported public key: opens without asking for activation.
    let enforced = parse_key_file(&exported);
    LegalStore::new(&app.0).accept("1.1.4", &doc, None, Some(&my_device)).unwrap();
    match cfg("1.1.4", &enforced.trusted(), &enforced) {
        Route::Ready { license_id, .. } => assert_eq!(license_id, issued.license.record.license_id),
        other => panic!("owner's computer must open directly, got {other:?}"),
    }
    // A customer computer without a licence is asked to activate.
    assert!(matches!(hours_cal_accepts(&exported, "", GUID_B), Route::Activation { .. }));
}
