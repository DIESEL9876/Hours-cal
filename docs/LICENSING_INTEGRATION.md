# Integrating the licensing layer into the existing Hours-Cal repo

Everything here was built and tested **outside** the Hours-Cal codebase, which was not available. These steps wire it in. They can be handed to Claude Code running on the owner's Windows machine. Nothing below changes calculations, exports, UI workflows, the database schema, the app identifier or the data directory.

## 0. Preconditions (owner rollout safety)

- The owner key pair exists, and the owner licence is already issued. See the Hebrew guide, steps 0–3.
- The 1.1.2 installer and a full data-folder copy are saved.

## 1. Add the code

```
hourscal-licensing/crates/hourscal-license         -> <repo>/crates/hourscal-license
hourscal-licensing/legal/                          -> <repo>/legal/   (crate include_str!s ../../../legal)
hourscal-licensing/crates/hourscal-license-tool    -> keep OUT of the app repo, or in it but never in the installer
tauri-integration/src-tauri/src/licensing.rs       -> <repo>/src-tauri/src/licensing.rs
tauri-integration/src-tauri/keys/                  -> <repo>/src-tauri/keys/  (+ license_public_key.txt from keygen)
tauri-integration/src/licensing/                   -> <repo>/src/licensing/
```

Add to `.gitignore`: `*.PRIVATE.txt`, `issued-licenses.csv`, `*.hclic`.

In `src-tauri/Cargo.toml`:
```toml
hourscal-license = { path = "../crates/hourscal-license" }
ed25519-dalek = "2.1"
```

If the app already uses `rusqlite`, align versions to avoid two bundled SQLite copies. If it uses `tauri-plugin-sql`/sqlx, keeping the crate's own rusqlite for recovery is fine.

## 2. Wire the two placeholders in `licensing.rs`

- `business_db_path(app)` → the existing function or constant that locates the SQLite file. Do not move the file.
- `on_ready(app)` → the existing DB open + migrations, moved out of `setup()`.

## 3. Backend enforcement

- In `setup()`, remove the eager DB init. It now runs only when the gate reports `Ready`.
- Add `licensing::require_ready(&app)?;` as the first line of every existing command that reads or writes business data.
- Register the 11 commands listed at the bottom of `licensing.rs`.
- Add `tauri-plugin-dialog` if not present. In Tauri v2 capabilities, allow `dialog:allow-open`.

## 4. Frontend

```tsx
import { LicensingGate, tauriLicensingApi } from "./licensing";
import "./licensing/licensing.css";
<LicensingGate api={tauriLicensingApi}><ExistingApp /></LicensingGate>
```

- Map `--hc-accent`, `--hc-bg`, `--hc-surface`, `--hc-text`, `--hc-muted`, `--hc-border`, `--hc-radius` and `--hc-font` to the existing design tokens.
- Settings: add a "מסמכים משפטיים" entry that renders `<LegalSettingsPanel api={tauriLicensingApi} />`.
- Add `<CopyrightFooter />`, or the `COPYRIGHT` string, to:
  - the main footer
  - the About screen
  - report/print footers, as text only, without changing the export logic

## 5. Backup / restore

The existing backup and restore code must **exclude** `%LOCALAPPDATA%\<identifier>\licensing\` and never write into it.

If backups only copy the `.sqlite` file, nothing needs to change. Even if this folder were copied to another PC, acceptance and licence are device-bound and would be rejected there (tested).

## 6. Version

Bump 1.1.2 → **1.1.3** in `tauri.conf.json`, `src-tauri/Cargo.toml` and `package.json`. Keep `identifier` unchanged.

## 7. Tests and build (on Windows)

```
cargo test --workspace                 # 41 licensing tests + existing Rust tests
npm test                               # existing UI tests + licensing UI tests (vitest)
hourscal-license-tool check-release    # must pass before PUBLIC distribution
npm run tauri build                    # NSIS/MSI installer
```

Existing calculation and export tests must pass unchanged.

## 8. Manual acceptance test on the owner's PC (with the real installer)

1. Install 1.1.3 over 1.1.2. The agreement shows. Accept it.
2. Activation screen: the device ID equals the `device-id` tool output. Import `owner.hclic`. You should see "הרישיון הופעל בהצלחה" and then the business list, with all data present.
3. Close and reopen. The app goes straight to the business list.
4. Reboot. The app goes straight to the business list.
5. Back up and restore through the existing feature. No agreement is shown.
6. Settings → מסמכים משפטיים shows the documents and history, with no checkbox.
7. Optional: in a VM, install fresh. Expect a separate agreement and an activation request, and the owner licence is rejected.

## Tauri v1

If the app uses Tauri v1, change these in `licensing.rs`:
- `app.path().app_local_data_dir()` → `app.path_resolver().app_local_data_dir()`
- `app.path().app_cache_dir()` → `app.path_resolver().app_cache_dir()`
- `@tauri-apps/api/core` → `@tauri-apps/api/tauri`
- `plugin-dialog` → `@tauri-apps/api/dialog`

---

## Integration status in this repository (Hours-Cal 1.1.3)

Done, with these project-specific decisions:

| Item | How it was integrated |
|---|---|
| Crates | `crates/hourscal-license`, `crates/hourscal-license-tool`; root `Cargo.toml` workspace (`exclude = ["src-tauri"]`). `rusqlite` aligned to 0.32 (same bundled SQLite as the app). |
| `business_db_path` | `%APPDATA%\il.office.hourscal\hours-cal.sqlite3` (`app_data_dir()/DB_FILE`, unchanged location). |
| `on_ready` | Opens `db::Db` and runs the daily auto-backup. The DB is no longer opened in `setup()`. `READY` flips only after the DB is open, under a lock, so a racing second startup call cannot reach an unopened DB. Schema migrations still run from the frontend after the gate opens. |
| Guards | `db_select`, `db_batch`, `backup_*`, `db_location` and `write_export_file` all call `licensing::require_ready()`. |
| Staged enforcement | `crates/hourscal-license/src/enforcement.rs`. With no key line in `src-tauri/keys/license_public_key.txt`, the licence is not required, but the agreement is still required once per version. A licence can be pre-installed (format, device and dates checked); its signature is verified on every start once a key is embedded. A malformed key file fails closed. Covered by tests in `tests/staged_enforcement.rs`. |
| Frontend | `main.tsx` wraps the app in `LicensingGate` in the desktop app. The repository is opened only after the gate opens. The "מסמכים משפטיים ורישיון" page (`LicenseStatusPanel` + `LegalSettingsPanel`) is in the top navigation. The copyright notice appears in the app footer, in print headers and in the XLSX subtitle. Design tokens are mapped in `src/styles.css`. |
| Backups | Unchanged. They copy only the SQLite DB (`VACUUM INTO`). Licensing state lives under `%LOCALAPPDATA%` and is never touched. |
| Release gate | `npm run check:release` fails until the contact email and the public key are both set. |
