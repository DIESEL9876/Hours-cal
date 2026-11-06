# Hours-Cal 1.1.12 — UX simplification & refinement

**Date:** 2026-11-05 · **Version:** 1.1.12 (from 1.1.11) · **App id:** `il.office.hourscal` (unchanged)

A UX-focused release: less clutter, fewer settings, clearer explanations, faster payroll workflow, a simpler monthly
summary, and a genuinely usable A4 print. No legal calculation rule or youth-employment protection was changed; all
existing data and the licensing system are preserved.

## The 13 items

| # | Requirement | What was done |
|---|---|---|
| 1 | Simplify the monthly summary | Removed the **ימי בחירות** and **תוספות אחרות** columns from the summary (and from its exports). Election days and "other additions" are still computed and stored — only the columns were removed. |
| 2 | Payroll components in the summary | Removed the **רכיבי שכר** block from the employees list. The summary now has **inline editing**: מקדמות (₪) and בונוסים (₪) as editable numeric cells, and **הבראה** as a כן/לא dropdown. Saved per employee+month; totals and exports update immediately; closed months are read-only. The detailed components dialog (reserve, travel override, paid-day override, authorised deductions, recuperation amount) moved to the **attendance screen** so nothing is lost. |
| 3 | Simplify the employees list | Removed the **מתכונת** and **יום מקוצר** columns. The underlying settings are unchanged and still editable in the employee's calculation settings. |
| 4 | Simplify the language | Shortened copy across the summary, settings and employees screens; trimmed long legal paragraphs to concise lines while keeping the essential warnings. |
| 5 | Clearer warnings & reviews | New accessible **WarningTip**: hovering **or keyboard-focusing** a warning indicator shows what the problem is, why it was flagged, which employee/date/value it affects, and **the action to take** (`פעולה: …`). Errors / legal warnings / manual-review / informational are visually distinct, with per-code guidance and short Hebrew messages. Also shown as an explicit action line in the day drawer and summary detail. |
| 6 | Remove settings history button | Removed **היסטוריית הגדרות**. Settings now apply from the selected month onward and **never inside an already-closed month** (floored by the last finalized month); previous months keep their stored settings. History is still kept internally for calculation consistency and auditing. |
| 7 | Default shortened day | The shortened day now defaults to **לא הוגדר**. No shortened day is auto-selected. (The `NO_SHORT_DAY` prompt was downgraded from a blocking review to an informational note.) |
| 8 | Remove contractual daily hours | Removed **היקף משרה יומי חוזי** from the settings UI. The engine field is kept (defaults to null → no effect) so no regular-hours/overtime calculation breaks; existing stored values are preserved. |
| 9 | Remove window expansion | Removed **הרחבת החלון בתחילה / בסיום** controls. The offsets default to 0 (no effect on the rest-window calculation). |
| 10 | Reorder breaks | The breaks settings are now two right-to-left pairs: **משמרת מינימלית להפסקה קצרה → הפסקה קצרה**, then **משמרת מינימלית להפסקה ארוכה → הפסקה ארוכה**. |
| 11 | Remove rest-between-shifts warning | Removed the **סף אזהרה למנוחה בין משמרות** setting and its optional (non-statutory) warning. Mandatory legal checks (e.g. the 36-hour weekly rest) are untouched. |
| 12 | Reorder summary columns | Removed **ימי עבודה**; moved **ימים בפועל** into its position. The leading columns are now: עובד · **ימים בפועל · ימים משולמים · שעות בפועל · שעות משולמות** · then hours, absence days and the payroll values. Every metric's meaning and calculation is unchanged. |
| 13 | A4 printing | A dedicated print layout: two narrow tables (**hours/days** and **payroll ₪**) that each fit A4 landscape, so **no column is clipped and no text overlaps**. Correct RTL, proper margins, clear headings and totals, readable fonts, repeated headers/totals across pages for long reports. Verified with a realistic multi-employee PDF. |

## Global requirements

- **Hebrew / RTL:** preserved throughout; visual review done on every changed screen (see screenshots).
- **Legal rules & youth protections:** unchanged — the engine, agreement clause gate and youth rule set Y2 are untouched.
- **Data & database compatibility:** preserved. The הבראה flag rides in the existing `employee_months` JSON; inline advances/bonuses use the existing `monthly_adjustments` table (a single canonical row per employee+month+category). **No schema migration was needed.**
- **Licensing:** unchanged.
- **No Firebase/web/PWA work** was started.
- **No regressions:** time, payroll, legal-compliance, export and persistence behaviour verified by the full test suite.

## Verification

| Check | Result |
|---|---|
| `tsc -b` | clean |
| Unit / integration (vitest) | **447 passed**, 2 skipped |
| End-to-end (Playwright) | **17 passed** |
| Payroll inputs persist after restart | ✔ (`ux1112.test.ts` + `payroll.spec.ts` reload) |
| Closed months keep their results | ✔ (inline edits and the הבראה flag are rejected on a finalized month) |
| Summary exports match the display | ✔ (same columns; reconciliation test updated) |
| Warning explanations are useful/actionable | ✔ (WarningTip with per-code action) |
| A4 print with realistic data | ✔ (6-employee landscape PDF, no clipping) |
| Hebrew RTL visual review | ✔ (screenshots) |

New tests: `src/data/__tests__/ux1112.test.ts` (inline advance/bonus persistence across restart, recuperation כן/לא flag,
closed-month protection). Updated: `app`, `absence`, `bulk`, `payroll` e2e specs and the engine/data unit tests affected
by reqs 7 and 11.

## Screenshots (`docs/screenshots/1.1.12/`)

- `01-employees.png` — simplified employees list
- `02-summary.png` — redesigned monthly summary with inline מקדמות / בונוסים / הבראה
- `03-settings.png` — calculation settings (default shortened day "לא הוגדר", removed fields, "applies from this month")
- `04-warning-tooltip.png` — accessible warning tooltip with the action to take
- `05-print-a4.png` — A4 print output (two tables, no clipping)

## Notes & decisions

- **הבראה כן/לא** is a manual monthly eligibility flag, separate from any recuperation *amount*; it does not invent an amount or change the legal meaning of recuperation eligibility. The recuperation amount (when needed) is still entered in the detailed components dialog and appears in the detailed export sheet.
- **Inline advances/bonuses:** the summary cell edits a single canonical per-month value. If a power user also entered **detailed** advance/bonus entries in the components dialog, the summary cell becomes read-only and shows the combined total (with a ✎ hint) so the figure always matches the export; the detailed entries remain editable in the dialog.
- **Removed settings** (contractual daily hours, window offsets, rest-between-shifts) keep their engine fields defaulting to no-effect values, so historical data and calculations are unaffected — only the controls were removed.

## Installer

- `downloads/Hours-Cal_1.1.12_x64-setup.exe` (10.8 MiB, NSIS x64)
- SHA-256: `19f03e6e667d57ef6f21c1cf34e06ef9eac1f0ba6fcea5ac77b6fb14753296f0`
- Installer audit (`scripts/audit-installers.mjs`): passed — licence public key embedded, no owner-only programs or key material.
