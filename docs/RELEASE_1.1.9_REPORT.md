# Hours-Cal 1.1.9 — release report

**Date:** 2026-11-04 · **Version:** 1.1.9 · **App id:** `il.office.hourscal` (unchanged) · **Schema:** v3 (additive)

This report covers deliverables 4–8 of the 1.1.9 specification:

- **A** — calculation verification;
- **B** — legal sources;
- **C** — agreements coverage;
- **D** — rules that need professional review;
- **E** — data survival.

The user guide is `docs/USER_GUIDE_HE.md` §2ג. The rules are in `docs/LEGAL_RULES.md` §11. Screenshots are in `docs/screenshots/1.1.9/`.

> **Limits, stated plainly.** The figures are for payroll preparation, not a payslip. The agreements catalog is
> **partial** (8 entries plus "unlisted"). No agreement rule is verified against a primary source. No collective
> agreement hours rules are encoded. The primary legal sites (`main.knesset.gov.il`, `www.gov.il`) could not be
> reached from the build environment.

---

## A. Calculation verification report

Every example below is an automated test that passes in this build: `src/engine/__tests__/payroll119.test.ts`,
`src/data/__tests__/payroll119.test.ts` and `e2e/payroll.spec.ts`. All amounts are integer agorot.

### A.1 Paid absence day value

Hourly rate 50 ₪ unless stated otherwise.

| Case | Input | Expected | Result |
|---|---|---|---|
| Manual hours, decimal | 8.40 h/day (= 8:24); 1 vacation day | 8:24 × 50 ₪ = **420.00 ₪** | ✔ 42000 |
| Sick day 1 / day 2 | same | 0% → 0 ₪; 50% → 4:12 × 50 = **210.00 ₪** | ✔ 0 / 21000 |
| Month average | 6:00 + (4:00 + 4:00 same date) + 7:00 = 21:00 on **3** dates | 21:00 ÷ 3 = 7:00 → 350.00 ₪ | ✔ 7:00, 35000; the vacation is not in the average |
| Three complete prior months | November absence; work 10:00 on 3.8, 6:00 on 29.10, 12:00 on 2.11 | window 1.8–31.10, 16:00 ÷ 2 = **8:00** (November excluded) | ✔ |
| Single worked day in window | 5:30 on 15.9 | 5:30 | ✔ |
| No worked days | — | "אין מספיק נתונים לחישוב ממוצע"; nominal 0; review | ✔ no 8.4-hour default, no division by zero |
| Monthly override | average 6:00; manual 8:00 for November, reason "הסכם אישי" | 8:00 used; calculated 6:00 and reason kept; October unaffected | ✔ |
| Monthly employee | vacation | basis `in_salary`, 0 ₪ extra | ✔ no double pay |
| Reserve day | hourly employee | basis `statutory_formula`, 0 ₪ hourly value | ✔ never hourly |
| Rounding | 35.33 ₪ × 7:13 on 2 days | rounded half-up once per day; total = 2 × daily value | ✔ |
| UI (e2e) | 40 ₪/h, 5:00 + 10:00 net on 2 dates, 1 vacation | average 7:30 → **300.00 ₪**; dialog shows 7:30 | ✔ |

### A.2 Youth employment

| Case | Result |
|---|---|
| Born 2008-11-15, attendance 14.11 vs 15.11.2026 | 17 (youth rules) / 18 (adult rules) ✔ |
| No date of birth | adult rules; no youth warnings; no age guessed ✔ |
| Age 17, five-day week: 4 × 9:00 + 8:00 = 44:00 | no daily warning at 9:00; YOUTH_WEEKLY_LIMIT + YOUTH_PAY_REVIEW; 44:00 kept; adult overtime-permit limits not applied ✔ |
| Age 15: 12:00–21:00 with a 30-minute break (8:30 net); age 13 | YOUTH_DAILY_LIMIT (8:00), YOUTH_NIGHT (from 20:00), YOUTH_BREAK (30 < 45); YOUTH_MIN_AGE for the 13-year-old ✔ |
| Age 17: 15:00–22:30; Saturday 10:00–14:00 | YOUTH_NIGHT (from 22:00); YOUTH_REST_DAY ✔ |
| Minimum wage from 2026-04: 26.07 / 27.94 / 30.92 ₪ by age; age 17 paid 27.00 ₪ | YOUTH_MIN_WAGE; rate not changed; no check before 2026-04 ✔ |
| Legacy "minor" profile + date of birth | hours classified (previously "unclassified") ✔ |
| UI (e2e) | age 17, 10:00 net → "העסקת נער בשעות נוספות אסורה"; total 15:00 unchanged ✔ |

### A.3 Travel

| Case | Result |
|---|---|
| Daily 15 ₪, two shifts on one date + one other date + vacation day | 2 days × 15 = **30.00 ₪** ✔ (UI and unit) |
| Manual correction to N days with reason | N × rate; reason shown ✔ |
| Fixed monthly; employee overrides the business | employee value used ✔ |

### A.4 Payroll components

| Case | Result |
|---|---|
| Bonus 500 ₪ saved by a double click | one row ✔ |
| Advance 1,000 ₪, proposed recovery 500 ₪ | kept apart; "הצעות להחזר (לא אושרו): 500.00" ✔ |
| Authorised deduction without a basis | rejected ✔ |
| November entries in October | none ✔ |
| After restart / reload | persisted ✔ |
| Edit, delete | audited; deleted rows stop counting ✔ |
| Finalised month | read-only (RepoError) until reopened ✔ |
| Business summary | bonus 500.00 and travel 30.00 in the grand total; hours unchanged (15:00) ✔ |
| CSV | payroll columns plus a "רכיבי שכר" table ✔ |

### A.5 Agreements

| Case | Result |
|---|---|
| Search "הבראה" | 1 result with metadata and source ✔ |
| Selection without confirmation | "ממתין לאישור תחולה", rules inactive ✔ |
| Confirmation without verification | "הוראות ההסכם טרם אומתו — הכללים אינם מופעלים" ✔ |
| Confirmation + professional verification of the profile version | rules active ✔ |
| Metadata-only or unlisted | never execute ✔ |
| Two instruments | precedence order; monetary conflict → favourable value + review ✔ |
| Synthetic verified hours profile | daily/weekly thresholds change and the source is cited ✔ |

### A.6 Test totals for this build

| Suite | Result |
|---|---|
| Unit (vitest) | **407 passed**, 2 skipped (real-sample tests run only locally) |
| End-to-end (Playwright) | **15 passed**, including `e2e/payroll.spec.ts` |
| Rust (`cargo test`, app + license crates) | all passed |
| `tsc -b` | clean |
| `check:release` | "Release-ready" |

---

## B. Legal sources

Primary texts could not be opened from the build environment:

- `main.knesset.gov.il` — DNS outside the network policy;
- `www.gov.il` and `www.kolzchut.org.il` — blocked or unresolvable.

Every figure below is consistent across several secondary sources found by web search on 2026-11-03.

| Topic | Figure used | Secondary sources |
|---|---|---|
| Youth hours | 8 h/day; 9 h from 16 in a five-day week; 7 h on eves; 40 h/week; overtime prohibited | tep.haifa.ac.il, malam-payroll.com, finance.walla.co.il, inn.co.il |
| Youth night | under 16: 20:00–08:00; 16–17: 22:00–06:00 | meyda.education.gov.il, kolzchut (snippet), protocol.co.il, koloved.net |
| Youth break | 45 min (30 continuous) after 6 h | same as above |
| Minor who worked prohibited overtime is still paid | — | workrights.co.il, kolzchut (snippet), hon.co.il |
| Minimum wage | 6,443.85 ₪/month from 1.4.2026; youth 70% / 75% / 83% ÷ 173 | chamber.org.il, heshevavoda.co.il, teen.kolzchut.org.il, minimum.org.il, taxo.co.il |
| Travel cap | 22.60 ₪/day for 2026; conflicting older figure 25.20 ₪ | bizportal.co.il, hilan.co.il, malam-payroll.com, kolhamas.co.il; yael-sachar.com (25.20) |
| Recuperation | 451.50 ₪/day for year 2026 (1.7.2025–30.6.2026, order of 18.8.2026); previously 418 ₪; seniority table 5/6/6/7…/10 | hashavim.co.il, taxcollege.co.il, bizportal.co.il, malam-payroll.com, law-firm summaries |
| Reserve duty | 3-month gross ÷ 90 × days; floor 328.76 ₪; ceiling 1,730.33 ₪ | btl.gov.il and kolzchut (snippets), jobcalc.co.il, malam-payroll.com |
| Vacation pay, hourly worker | 3-month wage ÷ 90 × calendar days; monthly worker: regular salary | kolzchut, workrights.co.il, protocol.co.il, btl.gov.il (snippets) |

**To verify against the primary texts**, use either route:

- allow `main.knesset.gov.il`, `www.gov.il`, `www.btl.gov.il` and `www.kolzchut.org.il` in the environment's network settings; or
- have a payroll professional check the texts and record the check in the app (agreement verification field).

---

## C. Agreements coverage report (catalog `2026.11.03`)

| Id | Instrument | Verification | Executable rules |
|---|---|---|---|
| eo-short-week-2018 | General extension order — shortening the work week (42 h) | secondary | none (already the base profile of the app) |
| eo-travel | General extension order — travel expenses | secondary | travel cap reference (22.60 ₪, not enforced) |
| eo-recuperation | General extension order — recuperation pay | secondary | recuperation helper (suggestion only) |
| eo-holidays-framework-2000 | Extension order (framework agreement 2000) — holiday pay | secondary | none new (1.1.7 holiday rules) |
| eo-pension | Mandatory pension extension order | metadata only | none |
| eo-cleaning | Cleaning industry | metadata only | none |
| eo-security | Security / guarding industry | metadata only | none |
| eo-construction | Construction industry | metadata only | none |
| unlisted | "הסכם שאינו ברשימה — לבדיקה ידנית" | — | none (always manual review) |

What the catalog does and does not cover:

- **Primary-verified entries:** 0.
- **Official numbers:** recorded as "not verified" (null) for every entry.
- **Industry agreements:** not covered beyond metadata. Hundreds of special collective agreements are not catalogued.
- **Claim:** the catalog does **not** cover all agreements and is not presented as doing so. The UI says "הקטלוג חלקי — ראו דוח הכיסוי".
- **Mechanism:** effective-dated, versioned rule profiles; activation requires the confirmation plus the verification; precedence handling; rule versions stored on month close (`month_reviews.rules_json`). The mechanism is ready for verified rules to be added.

---

## D. Rules requiring professional review

1. Paid-day value for hourly or daily employees (business method vs. Annual Leave Law §10 reference period). Every such vacation or holiday day is flagged.
2. Youth employment:
   - all thresholds (11.3);
   - permit exceptions (night until 23:00/24:00, artistic work, school holidays);
   - compulsory-education status, which is not stored;
   - eve-of-holiday detection.
3. Youth minimum wage outside the period from 2026-04-01 (no automatic check).
4. Travel:
   - the 2026 cap (22.60 vs. 25.20);
   - actual travel cost;
   - eligibility when "no reimbursement" is set.
5. Recuperation:
   - the rate after 30.6.2026;
   - seniority from the employment start date;
   - part-time fraction;
   - payment timing.
6. Reserve duty:
   - the NII amount (wage history required);
   - the employer reimbursement;
   - any supplement under an agreement.
7. Advances: the authorisation basis for deductions (Wage Protection Law §25); the proposed recovery is not applied.
8. Every agreement selection:
   - applicability (industry, employer organisation, occupation, period);
   - verification of the rule-profile version against the official text.
9. The legacy "minor" legal profile without a date of birth.
10. Months closed before 1.1.9 have no stored rule versions (`rules_json` is null).

---

## E. Confirmation that existing data survives the update

- **Migration v3 is purely additive:**
  - nullable `employees.birth_date`;
  - new tables `monthly_adjustments` and `employee_months`;
  - nullable `month_reviews.rules_json`.
  - No existing column or row is changed, dropped or reinterpreted.
- **Backup:** a pre-migration backup is created automatically before v3 runs (existing `repo.migrate` mechanism). It can be restored from "גיבוי ונתונים".
- **Automated proof:** `src/data/__tests__/payroll119.test.ts` › *additive migration v2 → v3*:
  - builds a v2 database with a business, an employee, settings, a shift and a vacation day;
  - migrates it;
  - asserts that the backup exists, the employee is unchanged (`birthDate: null`) and there are no components;
  - asserts that the **calculation snapshot hash of the month is identical** before and after.
  - The v1 → v2 test (1.1.7) still passes.
- **Finalised months keep their hash:**
  - youth warnings appear only when a date of birth exists;
  - the new money figures are outside the snapshot;
  - new settings (travel, agreements) default to "inherit" or empty for existing employees.
- **Preserved:**
  - app identifier `il.office.hourscal` and database file location;
  - licensing and legal agreement (no changes);
  - import (1.1.5/1.1.8) and absence (1.1.7) behaviour. All their e2e and unit tests pass unchanged.
