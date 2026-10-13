//! hourscal-license-tool — OWNER-ONLY. Never bundle with the Hours-Cal app.
//!
//!   keygen     --dir <DIR>
//!   pubkey     --key <PRIVATE_KEY_FILE>
//!   device-id
//!   issue      --key <FILE> --device <HC1-...> --licensee <NAME> [--org <ORG>]
//!              [--expires YYYY-MM-DD] [--replaces <LICENSE_ID>] [--out <FILE>]
//!   inspect    <LICENSE_FILE>
//!   verify     --pub <PUBLIC_KEY_FILE> --device <HC1-...> <LICENSE_FILE>
//!   check-release

use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine;
use ed25519_dalek::SigningKey;
use hourscal_license::dates::{now_utc_iso, Date};
use hourscal_license::device::{self, is_well_formed, normalize_code};
use hourscal_license::fsutil::random_bytes;
use hourscal_license::legal::LegalDocument;
use hourscal_license::license::*;
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

const PRIVATE_FILE: &str = "hourscal-signing-key.PRIVATE.txt";
const PUBLIC_FILE: &str = "license_public_key.txt";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let r = match args.first().map(String::as_str) {
        Some("keygen") => keygen(&opts(&args[1..])),
        Some("pubkey") => pubkey(&opts(&args[1..])),
        Some("device-id") => device_id(),
        Some("issue") => issue(&opts(&args[1..])),
        Some("inspect") => inspect(args.get(1)),
        Some("verify") => verify_cmd(&opts(&args[1..]), args.last()),
        Some("check-release") => check_release(),
        _ => { print!("{}", USAGE); Ok(()) }
    };
    match r {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => { eprintln!("ERROR: {e}"); ExitCode::FAILURE }
    }
}

const USAGE: &str = "hourscal-license-tool (OWNER ONLY - do not distribute)
  keygen     --dir <DIR>                 create the signing key pair (once)
  pubkey     --key <PRIVATE_KEY_FILE>    print the public key to embed in the app
  device-id                              print THIS computer's Hours-Cal device ID
  issue      --key <FILE> --device <ID> --licensee <NAME> [--org <ORG>]
             [--expires YYYY-MM-DD] [--replaces <LICENSE_ID>] [--out <FILE>]
  inspect    <LICENSE_FILE>              show contents (no trust implied)
  verify     --pub <PUBLIC_KEY_FILE> --device <ID> <LICENSE_FILE>
  check-release                          fail if legal text is not release-ready
";

fn opts(a: &[String]) -> HashMap<String, String> {
    let mut m = HashMap::new();
    let mut i = 0;
    while i < a.len() {
        if let Some(k) = a[i].strip_prefix("--") {
            let v = a.get(i + 1).filter(|v| !v.starts_with("--")).cloned().unwrap_or_default();
            if !v.is_empty() { i += 1; }
            m.insert(k.to_string(), v);
        }
        i += 1;
    }
    m
}

fn need<'a>(o: &'a HashMap<String, String>, k: &str) -> Result<&'a str, String> {
    o.get(k).map(String::as_str).filter(|v| !v.is_empty()).ok_or_else(|| format!("missing --{k}"))
}

fn inside_git_repo(p: &Path) -> bool {
    let abs = fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    abs.ancestors().any(|a| a.join(".git").exists())
}

fn keygen(o: &HashMap<String, String>) -> Result<(), String> {
    let dir = PathBuf::from(need(o, "dir")?);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    if inside_git_repo(&dir) && !o.contains_key("allow-git-dir") {
        return Err(format!("{} is inside a git repository. Choose a folder outside any repo (e.g. an encrypted USB drive).", dir.display()));
    }
    let priv_path = dir.join(PRIVATE_FILE);
    if priv_path.exists() {
        return Err(format!("{} already exists. Refusing to overwrite an existing signing key.", priv_path.display()));
    }
    let sk = SigningKey::from_bytes(&random_bytes::<32>());
    let vk = sk.verifying_key();
    let body = format!(
        "# HOURS-CAL LICENCE SIGNING KEY - PRIVATE\n# Owner: Ilay Nagar. NEVER share, commit, email, or ship this file.\n# key_id: {}\n# created: {}\n{}\n",
        key_id(&vk), now_utc_iso(), B64.encode(sk.to_bytes())
    );
    let mut f = OpenOptions::new().write(true).create_new(true).open(&priv_path).map_err(|e| e.to_string())?;
    f.write_all(body.as_bytes()).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    { use std::os::unix::fs::PermissionsExt; let _ = fs::set_permissions(&priv_path, fs::Permissions::from_mode(0o600)); }
    fs::write(dir.join(PUBLIC_FILE), format!("# Hours-Cal licence PUBLIC key ({})\n{}\n", key_id(&vk), public_key_to_text(&vk))).map_err(|e| e.to_string())?;
    println!("Created:\n  PRIVATE: {}\n  PUBLIC : {}\n  key_id : {}", priv_path.display(), dir.join(PUBLIC_FILE).display(), key_id(&vk));
    println!("\nNext: copy ONLY {PUBLIC_FILE} into the app at src-tauri/keys/{PUBLIC_FILE}.\nBack up the PRIVATE file to two offline, encrypted locations NOW.");
    Ok(())
}

fn load_private(path: &str) -> Result<SigningKey, String> {
    let s = fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))?;
    let line = s.lines().map(str::trim).find(|l| !l.is_empty() && !l.starts_with('#')).ok_or("empty key file")?;
    let b = B64.decode(line).map_err(|e| format!("key: {e}"))?;
    let arr: [u8; 32] = b.try_into().map_err(|_| "private key must be 32 bytes".to_string())?;
    Ok(SigningKey::from_bytes(&arr))
}

fn pubkey(o: &HashMap<String, String>) -> Result<(), String> {
    let sk = load_private(need(o, "key")?)?;
    println!("# Hours-Cal licence PUBLIC key ({})\n{}", key_id(&sk.verifying_key()), public_key_to_text(&sk.verifying_key()));
    Ok(())
}

fn device_id() -> Result<(), String> {
    match device::read_machine_guid() {
        Some(g) => { println!("{}", device::from_machine_guid(&g)); Ok(()) }
        None => Err("could not read this computer's MachineGuid; use the ID shown on the app's activation screen".into()),
    }
}

fn issue(o: &HashMap<String, String>) -> Result<(), String> {
    let key_path = need(o, "key")?;
    let sk = load_private(key_path)?;
    let device = normalize_code(need(o, "device")?);
    if !is_well_formed(&device) {
        return Err(format!("'{device}' is not a valid Hours-Cal device ID (expected HC1-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX)"));
    }
    let today = Date::today_utc();
    let expires = match o.get("expires").filter(|v| !v.is_empty()) {
        Some(e) => {
            let d = Date::parse(e)?;
            if d < today { return Err(format!("--expires {e} is in the past")); }
            Some(d.to_string())
        }
        None => None,
    };
    let payload = LicensePayload {
        format: FORMAT.into(),
        format_version: FORMAT_VERSION,
        license_id: new_license_id(),
        licensee: need(o, "licensee")?.trim().to_string(),
        organization: o.get("org").filter(|v| !v.is_empty()).cloned(),
        device_id: device.clone(),
        scope: "single-device".into(),
        issued_at: today.to_string(),
        expires_at: expires.clone(),
        replaces: o.get("replaces").filter(|v| !v.is_empty()).cloned(),
        key_id: key_id(&sk.verifying_key()),
    };
    let token = sign_token(&payload, &sk);
    // Self-check exactly as the app will verify it.
    verify(&token, &VerifyContext { trusted_keys: &[sk.verifying_key()], device_id: &device, today, revoked_ids: &[] })
        .map_err(|e| format!("self-verification failed: {e}"))?;
    let out = o.get("out").filter(|v| !v.is_empty()).map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(format!("{}.hclic", payload.license_id)));
    fs::write(&out, token_to_file_text(&token)).map_err(|e| format!("{}: {e}", out.display()))?;
    // Issuance log next to the private key (CSV, owner records).
    let log = Path::new(key_path).parent().unwrap_or(Path::new(".")).join("issued-licenses.csv");
    let new_log = !log.exists();
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&log) {
        if new_log { let _ = f.write_all(b"\xEF\xBB\xBFlicense_id,issued_at,licensee,organization,device_id,expires_at,replaces\r\n"); }
        let q = |s: &str| format!("\"{}\"", s.replace('"', "\"\""));
        let _ = write!(f, "{},{},{},{},{},{},{}\r\n", payload.license_id, payload.issued_at, q(&payload.licensee),
            q(payload.organization.as_deref().unwrap_or("")), device, expires.as_deref().unwrap_or("perpetual"),
            payload.replaces.as_deref().unwrap_or(""));
    }
    println!("License ID : {}\nLicensee   : {}\nDevice     : {}\nExpires    : {}\nReplaces   : {}\nFile       : {}\nLogged in  : {}",
        payload.license_id, payload.licensee, device, expires.as_deref().unwrap_or("never (perpetual)"),
        payload.replaces.as_deref().unwrap_or("-"), out.display(), log.display());
    println!("\nActivation key (paste into the app, or send the .hclic file):\n{token}");
    Ok(())
}

fn inspect(path: Option<&String>) -> Result<(), String> {
    let s = fs::read_to_string(path.ok_or("missing license file")?).map_err(|e| e.to_string())?;
    let tok = extract_token(&s);
    let p64 = tok.split('.').next().unwrap_or("");
    let json = B64.decode(p64).map_err(|e| format!("payload: {e}"))?;
    println!("(UNVERIFIED contents - use `verify` to check the signature)\n{}", String::from_utf8_lossy(&json));
    Ok(())
}

fn verify_cmd(o: &HashMap<String, String>, file: Option<&String>) -> Result<(), String> {
    let vk = public_key_from_text(&fs::read_to_string(need(o, "pub")?).map_err(|e| e.to_string())?)?;
    let dev = normalize_code(need(o, "device")?);
    let s = fs::read_to_string(file.ok_or("missing license file")?).map_err(|e| e.to_string())?;
    let p = verify(&s, &VerifyContext { trusted_keys: &[vk], device_id: &dev, today: Date::today_utc(), revoked_ids: &[] })
        .map_err(|e| format!("INVALID: {e}"))?;
    println!("VALID: {} for {} (device {}, expires {})", p.license_id, p.licensee, p.device_id, p.expires_at.as_deref().unwrap_or("never"));
    Ok(())
}

fn check_release() -> Result<(), String> {
    let p = LegalDocument::bundled().release_problems();
    if p.is_empty() { println!("Legal text is release-ready."); Ok(()) } else { Err(format!("NOT release-ready:\n  {}", p.join("\n  "))) }
}
