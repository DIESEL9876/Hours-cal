# Hours-Cal 1.1.13 — "סיכום חודשי לקליטת שכר" (payroll-entry PDF)

**Date:** 2026-11-06 · **Version:** 1.1.13 (from 1.1.12) · **App id:** `il.office.hourscal` (unchanged)

A focused upgrade. The monthly-summary print/PDF is now a payroll-entry worksheet. A payroll accountant can copy its
figures straight into payroll software, with no hour conversion and no totals to add up. Calculation rules, licensing,
the database schema and the other screens are unchanged.

## What changed

| Area | Result |
|---|---|
| **Decimal hours** | Every duration is printed twice: the **decimal value** (bold, 10 pt), which is the entry figure, and **HH:MM** (7 pt) underneath for checking. Conversion: total minutes ÷ 60, rounded half-up to 2 decimals for display only. Examples: 07:36 = 7.60 · 08:24 = 8.40 · 11:31 = 11.52 · 00:30 = 0.50 · 01:45 = 1.75 · 168:45 = 168.75. HH:MM is never read as a decimal. |
| **Totals** | Summed in integer **minutes** across employees and converted once. They are never sums of already-rounded daily or employee decimals. Example: 3 × 7:20 → 22.00, not 21.99. |
| **Title and identification** | "סיכום חודשי לקליטת שכר", business name, month and year, employee count, time printed, and the month state. Draft is a dashed box ("טיוטה – … הנתונים עשויים להשתנות"); a closed month shows "סופי – החודש נסגר", or a warning if the data changed after closing. Every row carries the employee's name and employee number. |
| **Three separate sections** | **ימים** (days) · **שעות** (hours) · **סכומים (₪)** (money). One row per employee and a business total row in each. Days stay days (hundredths), money stays ₪, and only true durations get decimal hours. |
| **Days** | ימים בפועל, ימים משולמים, ימי חופשה, ימי מחלה, מחלה – ימים משולמים, ימי חג; ימי מילואים / בחירות / היעדרות ללא תשלום appear only when present. |
| **Hours** | שעות בפועל, שעות משולמות, רגילות 100%, נוספות 125%, נוספות 150%; מנוחה/חג 150% · 175% · 200% and שעות לא מסווגות appear when present; payable hours per absence category (חופשה, מחלה, חג, and מילואים/בחירות when present). Any paid-absence hours outside these categories go to "שעות היעדרות אחרת", so nothing is hidden. |
| **Money** | נסיעות, מקדמות, בונוסים, הבראה (כן/לא). דמי הבראה, מילואים, תוספות אחרות and ניכוי מאושר appear only when an amount was recorded. Office **estimates** (absence value, cost estimate) are not printed because they are not payroll figures. |
| **Unverified values** | A cell whose figure is not final is shaded and marked **\***: open review items, missing records, absence entitlement still under review. A value that cannot be determined prints **"לבדיקה"**; a setting that is missing (e.g. no travel reimbursement defined) prints **"לא הוגדר"**. The first table has a status column ("מוכן" / "לבדיקה"), and the report ends with **"פריטים לבדיקה לפני קליטה"**: one line per employee saying what to check (e.g. "עבודה ביום שאינו יום עבודה (2)", "ימי היעדרות לבדיקה: …", "1 רישומים חסרים", "החזר נסיעות לא הוגדר"). |
| **A4 layout** | A4 landscape, Hebrew RTL, Heebo font, 10 mm margins, grey-scale only (prints well in black and white). Up to 12 data columns per table; wider sections continue as "(1/2)", "(2/2)" with the same rows instead of smaller text. Column headers and a running line (section · title · business · month) repeat on every page. Rows never split across pages. Totals appear once, at the end of each table. Page footer: "עמוד X מתוך Y". |
| **Single source of truth** | Everything comes from the existing monthly results (`computeBusinessMonth` and `computeBusinessFinancials`) through one model, `src/export/payrollEntry.ts`. The PDF component only renders that model. The one new engine helper (`absenceByCategory`) only groups the engine's own per-day absence figures; it computes nothing new and is not part of closed-month snapshots. |
| **Exports** | Excel gets a new sheet, **"קליטת שכר"**, built from the same model (decimal hours as numbers, H:MM next to them, a status column, and the reasons to review). CSV appends the same table. The existing "סיכום" sheet is unchanged. |
| **Closed months** | Unchanged behaviour: figures come from each month's stored settings versions, and the report states whether the month is closed. |

## Verification

| Check | Result |
|---|---|
| `tsc -b` | clean |
| Unit / integration (vitest) | **459 passed**, 2 skipped. New: `src/export/__tests__/payrollEntry.test.ts`, 12 tests. |
| End-to-end (Playwright) | **20 passed**. New: `e2e/payroll-pdf.spec.ts`, 3 tests. |

What the new tests cover:

- **Minutes → decimal hours:** the six examples above, and that HH:MM is never treated as a decimal.
- **Rounding of accumulated totals:** 3 × 7:20 → 22.00, while the sum of rounded values is 21.99.
- **Overtime and rest/holiday categories:** each equals the engine's buckets, and the categories add up to actual hours.
- **Absences:** vacation, sickness (days, paid days, payable hours) and holiday. Σ absence hours = the engine's paid-absence equivalent, and actual + absence = paid hours, so nothing is counted twice.
- **Empty, missing and unverified fields:** "–", "לא הוגדר", "לבדיקה", status and reasons.
- **Money:** advances, bonuses, recuperation כן/לא, and a recuperation amount only when one is recorded; estimates excluded.
- **Consistency between screen, PDF and exports:** the "קליטת שכר" sheet equals the "סיכום" export for every shared field and row. The PDF totals equal the on-screen totals (actual hours, paid hours, bonuses). The Excel sheet total equals the PDF total.
- **Hebrew RTL printing:** `dir="rtl"` and computed direction checked in print mode.
- **Multiple employees, multi-page A4:** 36 employees produce a 6-page A4 PDF. Every page repeats the running header, the column headers and the page number. No table or cell overflows the 277 mm content width.
- **Short report:** 6 employees put all three sections on page 1.
- **Closed month:** marked "סופי – החודש נסגר", with the same figures as the screen.

## Samples and screenshots (all data fictional)

- `docs/samples/payroll-entry-sample-36-employees.pdf` — 36 employees, 6 A4 pages
- `docs/samples/payroll-entry-sample-6-employees.pdf` — 6 employees, 2 pages
- `docs/screenshots/1.1.13/pdf-36-*.png`, `pdf-6-*.png` — the PDF pages
- `docs/screenshots/1.1.13/01-summary-screen.png` — the on-screen summary for the same month (same figures)

The demo data (`e2e/seedPayroll.ts`) is generated by the real repository and computed by the app itself.

## Notes and limits

- The figures are only as final as the month. An open month prints as a draft. Items the engine flags for review stay marked until they are resolved or acknowledged in the attendance screen.
- "מילואים (₪)" prints the same total as the summary screen (all recorded reserve-duty entries). Their breakdown, including any National Insurance reimbursement to the employer, is in the "רכיבי שכר" Excel sheet.
- Page numbers ("עמוד X מתוך Y") rely on CSS page-margin boxes, which the Chromium/WebView2 print engine supports. The PDF is created with the print dialog's "Save as PDF".

## Installer

- `downloads/Hours-Cal_1.1.13_x64-setup.exe` (10.8 MiB, NSIS x64)
- SHA-256: `0a8aa033f1e4be137790beaca4ab8fe945fa5986314bc9167936bf9c96de7efd`
- Installer audit (`scripts/audit-installers.mjs`): passed — licence public key embedded, no owner-only programs or key material.
