mod common;
use common::*;
use hourscal_license::legal::*;
use std::fs;

fn doc() -> LegalDocument { LegalDocument::render(AGREEMENT_TEMPLATE, "1.0", "legal@example.com") }

#[test]
fn first_install_requires_agreement() {
    let t = TempDir::new("first");
    assert!(LegalStore::new(&t.0).needs_acceptance("1.1.3", &doc(), None));
}

#[test]
fn same_version_second_launch_and_restart_not_shown() {
    let t = TempDir::new("same");
    LegalStore::new(&t.0).accept("1.1.3", &doc(), Some(180), None).unwrap();
    // second launch = new store instance reading the same config dir
    assert!(!LegalStore::new(&t.0).needs_acceptance("1.1.3", &doc(), None));
    // "computer restart": nothing but the files on disk survive -> same result
    for _ in 0..5 { assert!(!LegalStore::new(&t.0).needs_acceptance("1.1.3", &doc(), None)); }
}

#[test]
fn upgrade_1_1_2_to_1_1_3_requires_exactly_once() {
    let t = TempDir::new("upgrade");
    let s = LegalStore::new(&t.0);
    s.accept("1.1.2", &doc(), None, None).unwrap();
    assert!(!s.needs_acceptance("1.1.2", &doc(), None));
    assert!(s.needs_acceptance("1.1.3", &doc(), None), "new version must prompt");
    s.accept("1.1.3", &doc(), None, None).unwrap();
    assert!(!LegalStore::new(&t.0).needs_acceptance("1.1.3", &doc(), None), "relaunch 1.1.3 must not prompt");
    assert_eq!(s.history().len(), 2);
}

#[test]
fn downgrade_and_text_change_require_acceptance() {
    let t = TempDir::new("down");
    let s = LegalStore::new(&t.0);
    s.accept("1.1.3", &doc(), None, None).unwrap();
    assert!(s.needs_acceptance("1.1.2", &doc(), None));
    let changed = LegalDocument::render(&format!("{AGREEMENT_TEMPLATE}\nתוספת"), "1.0", "legal@example.com");
    assert!(s.needs_acceptance("1.1.3", &changed, None));
}

#[test]
fn no_time_based_expiry() {
    let t = TempDir::new("old");
    let s = LegalStore::new(&t.0);
    s.accept("1.1.3", &doc(), None, None).unwrap();
    let p = t.0.join("legal/acceptance.json");
    let raw = fs::read_to_string(&p).unwrap();
    let mut rec: AcceptanceRecord = serde_json::from_str(&raw).unwrap();
    rec.accepted_at_utc = "2001-01-01T00:00:00Z".into();
    fs::write(&p, serde_json::to_string(&rec).unwrap()).unwrap();
    assert!(!s.needs_acceptance("1.1.3", &doc(), None));
}

#[test]
fn backup_restore_and_import_do_not_trigger_agreement() {
    let t = TempDir::new("backup");
    let data = t.0.join("data"); // business data lives elsewhere than config/legal
    fs::create_dir_all(data.join("backups")).unwrap();
    let db = data.join("hours-cal.sqlite");
    fs::write(&db, b"business-db-v1").unwrap();
    let s = LegalStore::new(&t.0);
    s.accept("1.1.3", &doc(), None, None).unwrap();
    let before = file_hash(&t.0.join("legal/acceptance.json"));
    // backup
    fs::copy(&db, data.join("backups/b1.sqlite")).unwrap();
    fs::write(&db, b"business-db-v2").unwrap();
    // restore + import from another computer's backup
    fs::copy(data.join("backups/b1.sqlite"), &db).unwrap();
    fs::write(&db, b"imported-from-other-pc").unwrap();
    assert!(!LegalStore::new(&t.0).needs_acceptance("1.1.3", &doc(), None));
    assert_eq!(before, file_hash(&t.0.join("legal/acceptance.json")));
}

#[test]
fn new_computer_needs_separate_acceptance() {
    let pc1 = TempDir::new("pc1");
    let pc2 = TempDir::new("pc2");
    LegalStore::new(&pc1.0).accept("1.1.3", &doc(), None, None).unwrap();
    assert!(LegalStore::new(&pc2.0).needs_acceptance("1.1.3", &doc(), None));
}

#[test]
fn corrupt_record_reprompts_without_side_effects() {
    let t = TempDir::new("corrupt");
    let s = LegalStore::new(&t.0);
    s.accept("1.1.3", &doc(), None, None).unwrap();
    fs::write(t.0.join("legal/acceptance.json"), b"{not json").unwrap();
    assert!(s.needs_acceptance("1.1.3", &doc(), None));
}

#[test]
fn record_contents_history_and_exact_text() {
    let t = TempDir::new("rec");
    let s = LegalStore::new(&t.0);
    let r1 = s.accept("1.1.2", &doc(), Some(180), None).unwrap();
    let r2 = s.accept("1.1.3", &doc(), Some(9999), None).unwrap();
    assert_eq!(r1.installation_id, r2.installation_id, "installation id is stable");
    assert_eq!(r1.installation_id.len(), 36);
    assert_eq!(r1.legal_doc_version, "1.0");
    assert_eq!(r1.legal_sha256, doc().sha256);
    assert_eq!(r1.local_utc_offset_minutes, Some(180));
    assert_eq!(r2.local_utc_offset_minutes, None, "absurd offsets are dropped");
    assert!(r1.accepted_at_utc.ends_with('Z'));
    assert_eq!(s.accepted_text(&doc().sha256).unwrap(), doc().text);
    assert!(s.accepted_text("../../etc/passwd").is_none());
}

#[test]
fn complete_hebrew_text_is_bundled() {
    let d = LegalDocument::bundled();
    for must in [
        "הסכם רישיון למשתמש קצה, תנאי שימוש ומדיניות פרטיות — Hours-Cal",
        "פרק א׳ — בעלות וזכויות קניין רוחני", "פרק ב׳ — היקף רישיון השימוש",
        "פרק ג׳ — סודיות והגנה על מידע קנייני", "פרק ד׳ — נתוני המשתמש ואבטחת מידע",
        "פרק ה׳ — תוצאות החישוב ואחריות מקצועית", "פרק ו׳ — הפרת תנאים וסיום הרישיון",
        "פרק ז׳ — הוראות כלליות", "16.4.", "13.4.", "3.7.",
        "מדיניות פרטיות — Hours-Cal", "10. שינויי מדיניות ויצירת קשר",
        "MachineGuid", "מזהה הפעלה", "© 2026 עילי נגר | כל הזכויות שמורות",
    ] {
        assert!(d.text.contains(must), "missing: {must}");
    }
    // every numbered EULA clause 1..16 present
    for n in 1..=16 { assert!(d.text.contains(&format!("### {n}. ")), "clause {n}"); }
}

#[test]
fn release_gate_detects_missing_contact() {
    let missing = LegalDocument::render(AGREEMENT_TEMPLATE, "1.0", "");
    assert!(!missing.release_problems().is_empty());
    assert!(missing.text.contains(CONTACT_PLACEHOLDER_HE));
    let ok = LegalDocument::render(AGREEMENT_TEMPLATE, "1.0", "ilay@example.com");
    assert!(ok.release_problems().is_empty());
    assert!(ok.text.matches("ilay@example.com").count() == 2);
    assert!(!looks_like_email("not an email"));
}

/// Run with HOURSCAL_RELEASE=1 before building a public installer.
#[test]
fn release_config_is_complete_for_distribution() {
    if std::env::var("HOURSCAL_RELEASE").as_deref() != Ok("1") { return; }
    let p = LegalDocument::bundled().release_problems();
    assert!(p.is_empty(), "NOT READY FOR RELEASE: {p:?}");
}
