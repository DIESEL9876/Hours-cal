//! The GUI License Manager and the command-line owner tool use the same key and licence formats.
use hourscal_license::device::from_machine_guid;
use hourscal_license::fsutil::random_hex;
use hourscal_license_manager::issue::{issue, IssueRequest};
use hourscal_license_manager::Manager;
use std::process::Command;

const BIN: &str = env!("CARGO_BIN_EXE_hourscal-license-tool");

fn tmp(tag: &str) -> std::path::PathBuf {
    let p = std::env::temp_dir().join(format!("hc-compat-{tag}-{}", random_hex(5)));
    std::fs::create_dir_all(&p).unwrap();
    p
}
fn run(args: &[&str]) -> (bool, String) {
    let o = Command::new(BIN).args(args).output().unwrap();
    (o.status.success(), format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr)))
}

#[test]
fn cli_key_imported_into_license_manager_issues_licences_the_cli_verifies() {
    let keys = tmp("keys");
    assert!(run(&["keygen", "--dir", keys.to_str().unwrap()]).0);
    let cli_pub = std::fs::read_to_string(keys.join("license_public_key.txt")).unwrap();
    let private = std::fs::read_to_string(keys.join("hourscal-signing-key.PRIVATE.txt")).unwrap();

    let data = tmp("lm");
    let m = Manager::open(&data).unwrap();
    m.vault.import_cli_key_text(&private, None).unwrap();
    // Same public key file as the CLI produced (byte-identical).
    assert_eq!(m.vault.public_key_text().unwrap(), cli_pub);

    let dev = from_machine_guid("compat-guid");
    let today = hourscal_license::dates::Date::today_utc();
    let r = issue(&m.vault, &m.registry, &IssueRequest { licensee: "עילי נגר".into(), device_id: dev.clone(), license_type: "perpetual".into(), ..Default::default() }, &data.join("out"), today).unwrap();
    let (ok, out) = run(&["verify", "--pub", keys.join("license_public_key.txt").to_str().unwrap(), "--device", &dev, &r.file_path]);
    assert!(ok && out.starts_with("VALID"), "{out}");

    // And a licence issued by the CLI verifies against the License Manager's exported public key.
    let cli_lic = keys.join("cli.hclic");
    assert!(run(&["issue", "--key", keys.join("hourscal-signing-key.PRIVATE.txt").to_str().unwrap(), "--device", &dev, "--licensee", "לקוח", "--out", cli_lic.to_str().unwrap()]).0);
    let lm_pub = data.join("license_public_key.txt");
    let (ok, out) = run(&["verify", "--pub", lm_pub.to_str().unwrap(), "--device", &dev, cli_lic.to_str().unwrap()]);
    assert!(ok, "{out}");
    let _ = std::fs::remove_dir_all(&keys);
    let _ = std::fs::remove_dir_all(&data);
}
