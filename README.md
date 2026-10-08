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
# → src-tauri/target/x86_64-pc-windows-gnu/release/bundle/nsis/Hours-Cal_1.0.0_x64-setup.exe
#   (contains hours-cal.exe, WebView2Loader.dll and an uninstaller)
```

The installer is per-user and needs no administrator rights. If the WebView2 runtime is missing (rare on Windows 10/11),
it is downloaded silently during installation. The installer is not code-signed, so Windows SmartScreen may show a
warning ("More info" → "Run anyway"). Configure `bundle > windows > signCommand` to sign it.

## Tests

```bash
npm test                   # Vitest: engine, storage/repository, input parsing
npm run test:e2e           # Playwright: real UI workflow in Chromium
npm run test:rust          # Rust storage layer (needs webkit2gtk dev libs on Linux)
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

## Data and privacy

All data stays on the local machine. No network calls, telemetry or LLM are used. Automatic daily backups are kept in the
`backups` folder next to the database (last 30), plus backups before restore, migrations and month finalisation.
