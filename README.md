# Hours-Cal — מערכת לניהול נוכחות וחישוב שעות עבודה ושעות נוספות

An offline Windows desktop application (Tauri v2 + React + TypeScript + SQLite) for an Israeli tax-advisory /
accounting office: businesses, employees, monthly attendance, breaks, and daily/weekly overtime classification
under the Israeli Hours of Work and Rest framework. Full Hebrew RTL interface.

> **Legal status:** the official gov.il sources could not be accessed from the build environment. Rules were
> cross-checked against secondary sources and every interpretive point is flagged in the app.
> Read [`docs/LEGAL_RULES.md`](docs/LEGAL_RULES.md) before production use.

## Documents

| File | Contents |
|---|---|
| [`docs/LEGAL_RULES.md`](docs/LEGAL_RULES.md) | Every rule applied, its source, verification status/date, and the exact algorithm |
| [`docs/REVIEW_CASES.md`](docs/REVIEW_CASES.md) | Exceptional cases that require human payroll review (with flag codes) |
| [`docs/USER_GUIDE_HE.md`](docs/USER_GUIDE_HE.md) | Short Hebrew user guide |
| [`docs/LEGAL_AUDIT_1.1.10.md`](docs/LEGAL_AUDIT_1.1.10.md) | 1.1.10: audit of 1.1.9 against the legal research pack — correct / changed / not automatable, and the source and effective date of each activated rule |
| [`docs/RELEASE_1.1.9_REPORT.md`](docs/RELEASE_1.1.9_REPORT.md) | 1.1.9: calculation verification, legal sources, agreements coverage, rules needing professional review, data-survival confirmation |
| [`docs/LICENSE_MANAGER_GUIDE_HE.md`](docs/LICENSE_MANAGER_GUIDE_HE.md) | Hebrew guide for the owner-only License Manager (key setup, issuing, registry, backups, go-live) |

## Architecture

```
src/engine/      Pure deterministic calculation engine (integer minutes, no I/O)
  types.ts         data model: settings, shifts, results, minute buckets, warnings
  time.ts          Asia/Jerusalem conversion (exact across DST), date math, formatting
  calendar.ts      Shabbat window (sunset→nightfall, offline via @hebcal/core), holidays, eves
  settings.ts      legal constants, defaults, versioned settings resolution, validation
  breaks.ts        break policy (office policy / manual / none / paid / legal profile) + checks
  engine.ts        shift timeline → daily threshold → chronological weekly classification → warnings, explanation
  summary.ts       business monthly summary
src/data/        Storage layer
  schema.ts        append-only migrations
  repo.ts          repository: businesses, employees, settings versions, shifts, day entries, holidays,
                   month reviews, audit log — every write is one transaction incl. its audit row
  tauriDriver.ts   native SQLite via Rust (desktop)          sqljsDriver.ts  SQLite-WASM (browser preview/tests)
  service.ts       loads the data range the engine needs (adjacent weeks across month boundaries)
src/export/      Pure report tables → XLSX (ExcelJS, RTL sheets) / CSV (UTF-8 BOM)
src/ui/          React screens: businesses → employees → attendance editor, monthly summary, backups, rules
src-tauri/       Rust shell: rusqlite (bundled SQLite, WAL, synchronous=FULL), backups (VACUUM INTO), restore
```

Daily overtime thresholds (net of confirmed unpaid breaks; weekly regular cap 42:00 in both schedules):

| Schedule | Ordinary day | Shortened day | Friday / eve of rest, holiday eve, night shift |
|---|---|---|---|
| Five-day | **8:24** — office policy (8.4 decimal), more favourable than the statutory 8:36 | 7:36 (statutory, preserved) | 7:00 |
| Six-day | 8:00 | — | 7:00 |

Overtime: first two hours of the day 125%, then 150%; weekly rest / holiday 150 / 175 / 200%.

The monthly totals bar and the business monthly summary also show each HH:MM total in decimal hours
(`formatDecimalHours`: total minutes ÷ 60, exactly 2 decimals, integer arithmetic). Exports use the same function.

Calculation order per shift (never changed): validate → gross → break rule → deductible break → validate break →
net → daily threshold → weekly classification (no double counting) → explanation. Every net minute lands in
exactly one bucket and `sum(buckets) === net` is asserted at runtime.

## Running

Requirements: Node 22, Rust (stable). On Windows, Tauri also needs the WebView2 runtime (preinstalled on Windows 10/11)
and the MSVC build tools.

```bash
npm ci
npm run tauri dev          # desktop app (native SQLite in %APPDATA%\il.office.hourscal\hours-cal.sqlite3)
npm run dev                # browser preview at http://localhost:1420 (SQLite-WASM persisted in IndexedDB)
```

### Building the Windows installer

```bash
npm run tauri build        # on Windows → src-tauri/target/release/bundle/nsis/*.exe and msi/*.msi
```

The GitHub Actions workflow [`.github/workflows/build.yml`](.github/workflows/build.yml) runs all tests and builds the
NSIS and MSI installers on `windows-latest`. They are uploaded as the `hours-cal-windows` artifact.

Cross-compiling the NSIS installer from Linux also works (this is how the provided installer was produced):

```bash
rustup target add x86_64-pc-windows-gnu && sudo apt install mingw-w64 nsis
npx tauri build --target x86_64-pc-windows-gnu --bundles nsis
# → src-tauri/target/x86_64-pc-windows-gnu/release/bundle/nsis/Hours-Cal_<version>_x64-setup.exe
#   (contains hours-cal.exe, WebView2Loader.dll and an uninstaller)
```

The installer is per-user and needs no administrator rights. If the WebView2 runtime is missing (rare on Windows 10/11),
it is downloaded silently during installation. The installer is not code-signed, so Windows SmartScreen may show a
warning ("More info" → "Run anyway"). Configure `bundle > windows > signCommand` to sign it.

## Tests

```bash
npm test                   # Vitest: engine, storage/repository, input parsing
npm run test:e2e           # Playwright: real UI workflow in Chromium
npm run test:rust          # licensing crates + Rust storage layer (needs webkit2gtk dev libs on Linux)
```

- **Engine:** the 15 mandatory scenarios plus extended cases: leap years, month lengths, DST, minute boundaries,
  night work, holidays, eves, weekly rest, breaks, compliance warnings, profiles, tiering modes, pay rounding, report
  consistency, and 40 randomized property tests (reconciliation, determinism, month-split consistency).
  Mutation checks confirmed that the suite fails if the five-day threshold is changed (8:24 office policy), if the
  statutory 7:36 shortened day is not preserved, or if the weekly accumulator is reset
  at month start.
- **Storage:** migrations, business isolation, unique employee numbers, settings history and retroactive
  authorisation, audit trail, atomic rollback, persistence across reopen, backup/restore, finalisation snapshots.
- **E2E:** create businesses → employee → enter shifts (incl. overnight, shortened day, invalid and incomplete input)
  → explanation → undo/redo → confirm breaks → reload persistence → CSV/XLSX export re-parsed and matched to screen
  totals → finalisation and change detection → business isolation → archive protection → backup/restore.

## Attendance report import (since 1.1.5)

`src/import/` reads attendance reports locally and turns them into an editable preview (`ui/screens/AttendanceImport.tsx`).
Nothing is written until the user approves; the approved rows are then saved in ONE atomic batch with audit
(`Repository.applyAttendanceImport`).

- **Formats:**
  - `.xlsx`: ExcelJS, values only.
  - `.xls`: Rust/calamine command `import_read_xls`, values only.
  - CSV: UTF-8, UTF-16 or Windows-1255.
  - HTML-table "xls" exports.
  - Text PDFs: pdf.js legacy build. The table is rebuilt from text positions (`layout.ts`).
  - Scanned PDFs: offline Tesseract (WebAssembly) with bundled Hebrew + English data, plus a digits-only second pass; low-confidence rows are flagged.
- **Safety:**
  - Formulas, macros and PDF scripts are never executed.
  - Size, page, row and column limits apply.
  - Files are processed in memory only.
- **Planning:**
  - Imported times go through the same `buildTimestamps` as manual entry.
  - Existing data is never overwritten without an explicit "replace".
- **Tests:** `src/import/__tests__/*` (fixtures generated by `scripts/import-fixtures/`), `e2e/import.spec.ts`, Rust `import_xls` tests.

## Image import and bulk employee import (since 1.1.8)

- **Images** (`src/import/image.ts`, `imageprep.ts`):
  - Preprocessing: JPG/PNG/WEBP decoded locally → EXIF orientation → paper crop and keystone correction → illumination flattening → deskew → upscale.
  - OCR: the existing offline Tesseract runs on the result (`ocr.ts`, shared with scanned PDFs).
  - Weak rows get a digits-only re-read. It is accepted only when the two times agree with the row's decimal hours.
  - "Entrance - exit" ranges are ordered by the hours value, never by the RTL layout.
  - Unreadable values are flagged, never guessed. HEIC is rejected with a clear message.
- **Workbooks** (`src/import/workbook.ts`, `bulk.ts`, `ui/screens/BulkImport.tsx`):
  - Analysis: each worksheet goes through the same table detection as a single import, then employee name, clock id, month, declared counts and printed totals are read.
  - Wizard: proposes create / match / merge / skip.
  - Write: `Repository.bulkImport` writes the business, the employees and every shift in ONE atomic batch. `undoBulkImport` reverts it.
- **Privacy:** the real customer samples are never committed. `src/import/__tests__/real-samples.test.ts` runs against them only when `HC_REAL_SAMPLES` points to a local folder. Committed fixtures are synthetic (`scripts/import-fixtures/make-workbook.mjs`, `make-images.mjs`).

## Actual vs. paid attendance (since 1.1.7)

`src/engine/absence.ts` adds a per-day attendance record next to the existing (unchanged) overtime result. The rules and their sources are in `docs/LEGAL_RULES.md` §10.

- **Day type ("סוג יום"):**
  - Set only by the user. Calendar holidays and categories found in imported reports are suggestions only.
  - Replacing an existing category asks for confirmation. A blank date stays blank.
- **Figures:**
  - Days and hours actually worked.
  - Paid-absence nominal hours and equivalents (vacation, sickness 0/50/50/100 with continuous periods across months, holidays, election days).
  - Paid days and hours, plus an optional weekly credit toward the 42-hour week.
  - All in integer minutes and hundredths of a day; totals are sums of the daily values.
- **Outputs:** shown in the employee totals bar, the business monthly summary (per employee and grand total), print, and Excel/CSV.
- **Data:**
  - Additive migration v2 adds the nullable column `day_entries.absence_json`; nothing existing is changed.
  - The new figures stay out of the finalisation snapshot, so finalised months keep their hash.
  - The weekly credit is off for existing businesses and applies only after the last finalised month.
- **Tests:** `src/engine/__tests__/absence.test.ts`, `src/data/__tests__/absence.test.ts`, `src/import/__tests__/categories.test.ts`, `e2e/absence.spec.ts`.

## Payroll preparation (since 1.1.9)

Rules and sources: `docs/LEGAL_RULES.md` §11. Verification and coverage: `docs/RELEASE_1.1.9_REPORT.md`.

- **Paid absence day value** (`src/engine/absence.ts`):
  - Methods: manual hours/day, average of the current month, or average of the 3 complete prior months (net worked minutes ÷ distinct worked dates).
  - Money value = hourly rate × equivalent hours. Monthly employees get no extra value. Reserve duty is never valued hourly.
  - "אין מספיק נתונים לחישוב ממוצע" instead of a default. Per-month override with a reason.
- **Youth** (`src/engine/youth.ts`):
  - Optional date of birth; age is evaluated per attendance date.
  - Checks: daily and weekly limits, overtime ban, night, weekly rest, break, minimum wage.
  - Warnings only. Minutes are never removed.
- **Payroll components** (`src/data/repo.ts`, `src/payroll/financials.ts`, `ui/screens/PayrollItems.tsx`):
  - The "רכיבי שכר נוספים" button sits next to "פתיחת דוח שעות".
  - Categories: advance, bonus, recuperation, reserve, other. Stored per employee and month in integer agorot.
  - Audited, idempotent, read-only in closed months.
- **Travel:** none / monthly / per eligible day (distinct worked dates), inherited from the business, with a manual day correction.
- **Agreements** (`src/agreements/`):
  - Partial offline catalog with metadata and verification level.
  - Rules apply only with an applicability confirmation AND a verified profile version. Precedence is handled.
  - The rule versions used are stored when a month is closed.
- **Outputs:** totals bar, business monthly summary columns, Excel ("רכיבי שכר" sheet), CSV (appended table), print.
- **Data:** migration v3 is additive (`employees.birth_date`, `monthly_adjustments`, `employee_months`, `month_reviews.rules_json`). A pre-migration backup is taken first.
- **Tests:** `src/engine/__tests__/payroll119.test.ts`, `src/data/__tests__/payroll119.test.ts`, `e2e/payroll.spec.ts`.

## Legal corrections (1.1.10)

- **Rule registry:** `src/engine/legalRules.ts`. Rule ids Y-001…Y-017, each with its source URL, evidence class, effective dates, mode and tests. Every youth warning carries its `ruleId`.
- **Youth rule set Y2** (`src/engine/youth.ts`):
  - night windows depend on schooling status;
  - the 2024 school-vacation exception until 01:00 is a conditions review;
  - recorded night permits are honoured only within their validity and hour;
  - breaks are judged on actual breaks only;
  - the holiday-eve limit applies only before a holiday the minor does not work;
  - minimum age 14 on a school vacation; apprentice rate only with a document;
  - youth vacation is flagged;
  - figures are reported separately: recorded / prohibited (daily, then weekly) / night / rest day.
- **Y1** (1.1.9) is frozen and used for months closed under 1.1.9.
- **Agreements** (`src/agreements/`):
  - seed catalog COLL-001…018 with evidence classes, families and amendment relations;
  - employee-class scope;
  - a clause-level execution gate;
  - no cherry-picking between instruments.
- **Data:** migration v4 (`employees.youth_json`, additive).
- **Tests:** `src/engine/__tests__/legal1110.test.ts`, `src/data/__tests__/legal1110.test.ts`, `e2e/payroll.spec.ts`.

## Licensing and legal agreement (since 1.1.3)

- **Agreement:** a Hebrew EULA, Terms of Use and Privacy Policy (`legal/agreement_he.md`) must be accepted on first run and once after every version update. The acceptance record is stored locally, separately from business data.
- **Licences:** Ed25519-signed and offline, bound to a device ID derived from the Windows MachineGuid (`crates/hourscal-license`). If a licence becomes invalid, a read-only recovery export is available.
- **Owner tool:** `crates/hourscal-license-tool` is OWNER-ONLY and is never shipped. Build it with
  `cargo build --release -p hourscal-license-tool`.
- **Staged enforcement:** the licence requirement is enabled only when the owner's PUBLIC key is placed in `src-tauri/keys/license_public_key.txt`.
- **Secrets:** private keys, issued licences and the issuance log are git-ignored and never bundled.
- **Owner guide (Hebrew):** [`docs/LICENSING_OWNER_GUIDE_HE.md`](docs/LICENSING_OWNER_GUIDE_HE.md). Integration notes: [`docs/LICENSING_INTEGRATION.md`](docs/LICENSING_INTEGRATION.md).
- **License Manager (OWNER-ONLY GUI):** `license-manager/` is a separate Tauri app (Hebrew RTL) built on
  `crates/hourscal-license-manager`. It generates the signing key on the owner's PC and stores it with Windows DPAPI. It
  issues and self-verifies licences, keeps a local SQLite registry, and writes passphrase-encrypted key backups
  (Argon2id + XChaCha20-Poly1305). All private-key work happens in Rust, and no command returns the key. Build it with
  `cd license-manager && npx tauri build` (Windows), or cross-build with
  `CARGO_TARGET_DIR=../src-tauri/target npx tauri build --target x86_64-pc-windows-gnu --bundles nsis`.
  It is never part of the Hours-Cal installer.
- **Release gate:** `npm run check:release` must pass before public distribution. It requires the contact email and the public key.

© 2026 עילי נגר | כל הזכויות שמורות

## Data and privacy

All data stays on the local machine. No network calls, telemetry or LLM are used. Automatic daily backups are kept in the
`backups` folder next to the database (last 30), plus backups before restore, migrations and month finalisation.
