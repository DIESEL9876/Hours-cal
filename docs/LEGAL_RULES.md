# Legal calculation rules — documented basis

**Document date:** 2026-10-08
**Applies to engine version:** 1.1.0 (`src/engine/`)
**Change log:** 1.1.0 (2026-10-08) — office policy: five-day daily threshold 8:24 (rule 3.3). 1.1.6 — Friday policy (4.7). 1.1.7 (2026-11-03) — actual vs. paid attendance, vacation, sickness, holidays, election days (section 10).
**Status:** rules cross-checked against secondary sources only — see "Verification status" below.

This file documents every rule the calculation engine applies, where it comes from, how confident we are,
and how uncertainty is handled. The in-app page "כללי החישוב" summarises the same rules in Hebrew.

---

## 1. Verification status — read first

| Source (as specified) | Attempted | Result |
|---|---|---|
| Ministry of Labor — extension order shortening the workweek to 42 hours (`gov.il/BlobFolder/.../extention-order-short-week-2018.pdf`) | 2026-10-08 | **Not accessible** — the build environment's network policy blocked `www.gov.il` (HTTP 403 at the proxy). |
| Ministry of Labor — Hours of Work and Rest, legal department (`gov.il/BlobFolder/legalinfo/rest-flexibility/...`) | 2026-10-08 | **Not accessible** (same reason). |
| Official guidance — working hours and overtime (`hachvana.mod.gov.il/.../shirot.aspx`) | 2026-10-08 | **Not accessible** (blocked). |
| Ministry of Labor — overtime / weekly-rest permits service page | 2026-10-08 | **Not accessible** (blocked). |
| 2025 certified payroll-checker practical exam (8.6 / 7.6 examples) | 2026-10-08 | **Not accessible** (blocked). |
| Full text of חוק שעות עבודה ומנוחה, תשי"א-1951 (Hebrew Wikisource, Nevo mirrors) | 2026-10-08 | **Not accessible** (blocked). |

Because the primary sources could not be opened, **no rule below is marked "verified against the
official source"**. Rules were cross-checked against secondary sources that quote or summarise the
statute and the extension order, via web search on 2026-10-08:

- כל זכות (kolzchut.org.il): "צו הרחבה בדבר קיצור שבוע העבודה במשק ל-42 שעות שבועיות"; "שאלות ותשובות … קיצור שבוע העבודה ל-42 שעות"; "יום עבודה ושבוע עבודה"; "גמול עבור שעות נוספות"; "מספר השעות הנוספות מחושב תחילה על בסיס יומי ולאחר מכן על בסיס שבועי (פסק דין)"; "מגבלות על העסקה בשעות נוספות"; "מנוחה שבועית"; "עבודה במשמרת לילה"; "הפסקות בעבודה"; "תגמול עבור העסקה ביום המנוחה".
- פורטל זכויות העובדים (workrights.co.il): "42 שעות", "שעות נוספות", "הפסקה", "עבודת לילה", "העסקה ביום מנוחה".
- protocol.co.il ("שעות עבודה", "עבודת לילה", "מנוחה שבועית"), olam-haavoda.co.il, bizportal.co.il (incl. "פירוש המונח 'שבת'"), hilan.co.il, Meitar law firm summary of the extension order.

**Action required before production use:** a qualified payroll professional should verify each rule
marked below against the official texts (and the 2025 payroll-checker exam examples) and record the
verification date in this file.

Status legend:

- **S** — consistent across multiple secondary sources quoting the statute/order.
- **I** — interpretation / not settled in the sources found → the engine applies a documented default **and flags the affected entries for review**.
- **O** — office policy or engine design decision, not a legal rule.

---

## 2. Scope and legal profiles

| Profile | Treatment |
|---|---|
| `general_private` | Adult employee under the general private-sector framework (Hours of Work and Rest Law + 2018 extension order). All rules in §3–§9 apply. |
| `custom_contract` | Collective agreement / public sector / industry / contractual arrangement. The office enters daily thresholds per weekday, weekly threshold and first-tier length. Optional: apply the 7-hour statutory reductions. Always flagged for review (`CUSTOM_PROFILE`). |
| `exempt` | Employee to whom the Law does not apply (e.g. management / special trust position). Net hours only; minutes reported as "unclassified"; no overtime or rest premiums; flagged (`EXEMPT_PROFILE`). |
| `minor` | Under 18 — Youth Labour Law applies. **Not processed under adult rules**: net hours only, flagged as an error (`MINOR_UNSUPPORTED`) so the month cannot be finalised. |

Special industries (security, hospitality, health, transport, agriculture …) must use `custom_contract`.

---

## 3. Regular hours

| # | Rule | Engine constant | Status |
|---|---|---|---|
| 3.1 | Full-time weekly regular hours: **42** (extension order, from 1.4.2018; previously 43). | `LAW.WEEKLY_REGULAR_MINUTES = 2520` | S |
| 3.2 | Five-day week: **four days of 8.6 decimal hours = 8:36**, and **one fixed shortened day of 7.6 = 7:36**, chosen by the employer; the hour may not be spread over several days. Hours are net of breaks unless agreed otherwise. | `FIVE_DAY_NORMAL_MINUTES = 516`, `FIVE_DAY_SHORT_MINUTES = 456` | S |
| 3.3 | **Office policy (five-day week):** daily overtime threshold of **8.4 decimal hours = exactly 8:24** on every working day, requested by the office. It is more favourable to the employee than the statutory 8:36, so overtime starts earlier. The engine applies `min(office policy, statutory threshold)`: the designated shortened day keeps the statutory **7:36**, and the 7-hour night / eve-of-rest / holiday-eve thresholds (3.5) still apply on top. The 42-hour weekly cap is unchanged. Weekly arithmetic: 4 × 8:24 + 7:36 = 41:12, so up to 0:48 more regular time may fall on another day before weekly overtime starts. Custom-contract profiles are not affected. | `OFFICE_POLICY.FIVE_DAY_DAILY_MINUTES = 504` | O |
| 3.4 | Six-day week: Sunday–Thursday **8:00**, Friday **7:00**; weekly cap 42 (so 8×6 ≠ 48 regular hours). | `SIX_DAY_NORMAL_MINUTES = 480`, `SEVEN_HOUR_DAY_MINUTES = 420` | S |
| 3.5 | Statute s.2: on night work, on the day before the weekly rest, and on the eve of a holiday the employee does not work on — a working day does not exceed **7 hours**. Applied as `min(threshold, 7:00)`. | `SEVEN_HOUR_DAY_MINUTES` | S (rule) / **I** (application to five-day arrangements on holiday eves) → `EVE_THRESHOLD_REVIEW` raised whenever the reduction changes the result. |
| 3.6 | Work on a day that is not a scheduled workday (e.g. Friday in a five-day week) is **not** automatically overtime. It is classified against the day's threshold (Friday = eve of weekly rest → 7:00; other unscheduled days in a five-day week → 8:24) and the weekly cap, and flagged `UNSCHEDULED_DAY_WORK` for contractual review. | — | I |
| 3.7 | Part-time contractual hours: regular minutes beyond the contractual daily hours but within the legal threshold are reported separately as "excess hours at 100%" (`contractExcessMinutes`), never as overtime. | — | O |

## 4. Overtime

| # | Rule | Status |
|---|---|---|
| 4.1 | Overtime premium (s.16): **125%** for each of the first two overtime hours, **150%** for each further hour. | S |
| 4.2 | Overtime is determined **daily first, then weekly**; the same minute is never compensated twice. | S (court ruling cited by Kol Zchut) |
| 4.3 | No monthly threshold (182 h) is used to determine overtime. 182 is only the hourly-rate divisor for monthly employees and is not used by the engine. | S |
| 4.4 | Short days / absences never offset overtime earned on other days. | S |
| 4.5 | Tier assignment for **weekly** overtime minutes. Default `per_day`: all overtime minutes of the workday (daily + weekly) share the day's first two hours at 125%. Alternative `per_week`: weekly overtime minutes tiered by their running count within the week. | **I** — configurable per employee |

### 4.6 Algorithm (exact, integer minutes)

For each Sunday–Saturday week, in chronological order of workdays and, within a workday, of worked minutes:

```
i = index of the minute within the workday's net worked minutes (0-based)
if i >= dailyThreshold:                       → DAILY overtime
elif countsWeekly and weeklyRegular >= 2520:  → WEEKLY overtime
else:                                         → REGULAR (weeklyRegular += 1 if countsWeekly)
overtime tier: first 120 overtime minutes of the day (per_day) → 125%, rest → 150%
```

`countsWeekly` is true unless the minute falls in weekly rest/holiday and the employee setting
`restMinutesCountTowardWeekly` is off (default on — see 6.4).

The week is never reset at a month boundary. Data from adjacent months is always loaded
(`requiredDataRange`), so the result for a day is identical whichever month is opened (tested).

### 4.7 Office policy: Friday in a five-day week (since 1.1.6)

This is an **office policy**, not a statutory rule. It is set as a business default ("חישוב שעות נוספות ביום שישי").
Each employee either inherits it ("לפי הגדרת העסק") or overrides it in their effective-dated settings.

- **"כל שעות יום שישי כשעות נוספות"** — five-day-week employees only. Every net minute of a Friday row is overtime.
  - Breaks are deducted first.
  - The first 2 hours are 125%, the rest 150%. This holds even when the week is below 42 hours.
  - These minutes never consume the weekly regular allowance, so they cannot be counted again as weekly overtime.
  - Weekly-rest / holiday premiums stay attached to the minute: after Friday sunset → 175%/200%, on a holiday → 175%/200%.
    The policy can only raise the rate.
  - Exempt / minor profiles are not affected (no overtime classification).
- **"ללא תוספת אוטומטית לשעות יום שישי"** (and the default for all data created before 1.1.6): exactly the earlier classification.
  Statutory daily / weekly overtime and weekly-rest rules still apply.
- **Six-day-week employees:** never affected.
- **Changing the business default:** it takes effect from the month after the business's last finalised month.
  Finalised months are never recalculated.

## 5. Night work

| # | Rule | Status |
|---|---|---|
| 5.1 | Night work: a shift in which **at least two hours** are worked between **22:00 and 06:00**. Counted on worked (net) minutes. | S |
| 5.2 | Daily threshold for night work: **7 hours**. | S |
| 5.3 | No automatic percentage premium for night work as such. | S |
| 5.4 | If the break position was not entered and night status depends on it → `NIGHT_BREAK_DEPENDENT` review flag. | O |
| 5.5 | Weekly cap for night workers is kept at 42 (no separate statutory weekly threshold applied). 58-hour weekly maximum is a compliance warning. | I |

## 6. Weekly rest and holidays

| # | Rule | Status |
|---|---|---|
| 6.1 | Weekly rest: at least **36 consecutive hours**, including Shabbat for a Jewish employee; for a non-Jewish employee Saturday, Sunday or Friday per their choice (s.7). | S |
| 6.2 | Shabbat window = **sunset on Friday → nightfall (tzeit, sun 8.5° below horizon) on Saturday**, computed offline for the configured city (`@hebcal/core`), rounded outward to whole minutes. Configurable offsets extend the window. | **I** (court interpretation cited by secondary sources) |
| 6.3 | Work during weekly rest: at least **150%**; overtime during rest: **175%** (first two OT hours) and **200%** thereafter (150% + 25%/50%). | S |
| 6.4 | Minutes worked during rest **count toward the 42-hour weekly accumulator** (chronological processing), so after 42 regular hours Saturday work is 175%/200% from the first hour — consistent with Kol Zchut. Configurable. | I |
| 6.5 | Work during rest requires a permit → `WORK_ON_WEEKLY_REST` compliance warning on every such shift. | S |
| 6.6 | A gap shorter than 36 h around the rest day (when no work overlaps it) → `WEEKLY_REST_SHORT` warning. | S |
| 6.7 | Non-Jewish fixed rest day: calendar day 00:00–24:00 (+offsets) → `REST_WINDOW_REVIEW` flag. | I |
| 6.8 | Statutory holidays (Israel): Rosh Hashana ×2, Yom Kippur, Sukkot I, Shemini Atzeret, Pesach I and VII, Shavuot, and Independence Day. Window: sunset of the eve → nightfall of the day. Chol HaMoed is not a holiday. | S (dates) |
| 6.9 | Holiday work premium: classified separately with the same 150/175/200 structure, **always flagged `HOLIDAY_WORK` for review** — the entitlement and rate depend on the applicable extension order / agreement and were not verified. | **I** |
| 6.10 | Holiday that coincides with Shabbat: classified once, as weekly rest. | O |
| 6.11 | Office-defined custom holidays (e.g. for non-Jewish employees): civil day, flagged. | O |

## 7. Breaks

| # | Rule | Status |
|---|---|---|
| 7.1 | Overtime is computed on **net** time: `net = gross − legally deductible unpaid break`. Never on gross. | S |
| 7.2 | Rest/meal break time is not working time; a break during which the employee must remain available / cannot leave counts as working time (paid break option). | S |
| 7.3 | s.20: on a work day of **6 hours or more**, a break of **≥45 minutes including ≥30 consecutive**; on the day before weekly rest / a holiday, 30 minutes. Applied as a **compliance warning** (`BREAK_BELOW_MINIMUM`) for manual-labour employees. | S (rule) / I (manual vs non-manual scope) |
| 7.4 | Non-manual employees: sources describe an exemption for working without a break up to 8 h (six-day) / 9 h (five-day). Used only by the optional "legal profile" estimate and **flagged** (`BREAK_NON_MANUAL_ESTIMATE`). | I |
| 7.5 | **Office policy** (`company_auto`): gross ≤ 10:00 → 30 min; gross > 10:00 → 45 min; no deduction below a configurable minimum shift (default 6:00). This is **not a statutory rule**. Deductions are estimates flagged `BREAK_UNCONFIRMED` until confirmed; months with unconfirmed breaks cannot be finalised. | O |
| 7.6 | A break equal to or longer than the shift is rejected (error); a break > 3 h is a warning. | O |
| 7.7 | Break position: if a start time is entered, the break is removed at that time; otherwise it is assumed centred in the shift and `BREAK_POSITION_ASSUMED` is raised when the shift crosses a rest/holiday boundary. | O |

## 8. Compliance warnings (never delete worked hours)

| Code | Rule | Status |
|---|---|---|
| `DAILY_LIMIT` | More than 12 h in a day including overtime. | S |
| `WEEKLY_OT_LIMIT` | More than 16 overtime hours in a week (general permit). | S |
| `WEEKLY_TOTAL_LIMIT` | More than 58 hours in a week. | S |
| `SHORT_REST_BETWEEN_SHIFTS` | Rest between shifts on different workdays below an **office-configured** threshold (default 8 h). No general statutory minimum was verified. | O |
| `WORK_ON_WEEKLY_REST`, `WEEKLY_REST_SHORT` | §6. | S |

## 9. Engine conventions (design decisions)

| # | Decision |
|---|---|
| 9.1 | All arithmetic in **integer minutes**; timestamps converted with the IANA `Asia/Jerusalem` zone, so DST transitions are exact (overnight shift on the October change = 9 h; on the March change = 7 h; non-existent times rejected, ambiguous times flagged). |
| 9.2 | Every net minute is materialised once and assigned to exactly one bucket: regular / 125 / 150 / rest 150·175·200 / holiday 150·175·200 / unclassified. **Sum of buckets = net minutes** is asserted at runtime and in property tests. |
| 9.3 | A shift belongs to the workday on which it **starts** (overnight shifts stay with their start date). Monthly reports include the workdays dated in the month; weekly classification always uses the full Sunday–Saturday week across month boundaries. Weekly warnings are attached to the Saturday of the week. |
| 9.4 | Settings are versioned by effective date. New versions never change earlier months; editing an existing version requires explicit authorisation and is audit-logged. Business defaults are copied (not linked) into new employees. |
| 9.5 | Optional pay estimate: `minutes × percent × rate(agorot)` summed exactly as integers, divided and rounded half-up **once** per day / per total. Not a payroll calculation. |
| 9.6 | Out of scope: income tax, National Insurance, pension, severance, travel. Since 1.1.7 paid absences are shown as **days and hour-equivalents** (section 10) — an estimate for review, never a payroll amount. Absence categories never create worked hours. |

## 10. Actual vs. paid attendance, vacation, sickness, holidays, election days (since 1.1.7)

### 10.1 Verification status for this section

| Source | Attempted | Result |
|---|---|---|
| חוק דמי מחלה, התשל"ו-1976 (btl.gov.il / fs.knesset.gov.il) | 2026-11-03 | **Not accessible** (network policy). |
| כל זכות — "דמי מחלה", "חישוב דמי מחלה לעובד במשכורת חודשית" | 2026-11-03 | **Not accessible** (host blocked). |
| חוק חופשה שנתית, התשי"א-1951; צו ההרחבה (הסכם המסגרת 2000) — דמי חגים; חוק-יסוד: הכנסת §10; חוק הבחירות לכנסת §136; חוק הרשויות המקומיות (בחירות) §97ב | 2026-11-03 | Primary texts **not accessible**; consistent statements found via web search in secondary sources (workrights.co.il, bizportal, chambers of commerce, NATLEX summary of amendment 4 to the Sick Pay Law, law-firm summaries, a 2024 local-elections guide). |

Nothing in this section is marked as verified against the official text. Every absence day whose entitlement
depends on information the system does not hold is marked **"דורש בדיקה"** and must be acknowledged before the
month can be closed. Figures are hour/day equivalents for payroll preparation — not payroll.

### 10.2 Principles (all O — engine design)

| # | Rule |
|---|---|
| 10.2.1 | The day type (`עבודה רגילה`, `חופשה`, `מחלה`, `חג`, `בחירות`, `היעדרות ללא תשלום`, `יום ללא עבודה`) is set **only by the user**. Calendar holidays and categories found in imported reports are shown as suggestions; nothing is saved until the user accepts. Replacing an existing category asks for confirmation. A blank date stays blank. |
| 10.2.2 | **Actual** = net minutes physically worked (the existing engine result, unchanged). **Paid** = actual + paid-absence equivalent (absence nominal hours × payment rate). Premiums (125/150, rest/holiday) are never applied to absence time; absence minutes are never overtime. |
| 10.2.3 | Nominal hours of an absent day = the employee's effective schedule for that date (contract daily hours, else the daily norm of the schedule — 8:24 office policy / 7:36 shortened day / six-day 8:00·7:00), or a fixed value, or the 3-month daily average (hourly/daily employees; at least 5 worked days required, else review). A day that is not a scheduled workday has no nominal hours. |
| 10.2.4 | Partial-day absence: the user enters the absent hours; the day fraction = absent ÷ nominal (capped at one day). Work and a partial absence on the same date are both counted, without double counting. Work recorded on a date marked as a **full** absence is counted as work only and the date is flagged. |
| 10.2.5 | Precision: integer minutes; equivalents rounded half-up once per day; day counts in hundredths per day; every total is the sum of the daily values (exact reconciliation between the day rows, the employee totals, the business summary and the exports). |
| 10.2.6 | The new figures are kept outside the finalisation snapshot, so months finalised before 1.1.7 keep their hash. The only part that can change overtime — the weekly credit (10.7) — is off for existing businesses and a change applies only after the last finalised month. |
| 10.2.7 | Additive migration (schema v2): one nullable column `day_entries.absence_json`. No existing value is changed or reinterpreted; a pre-migration backup is created automatically. |

### 10.3 Vacation (חוק חופשה שנתית)

| Rule | Status |
|---|---|
| Vacation days are paid in full: a monthly employee receives the regular wage; an hourly/daily employee the average daily wage (§10). Engine: 100% of the nominal hours; basis "rule" for monthly, "estimate" for hourly/daily (the daily average depends on payroll data). | S |
| Manual override of the rate requires a reason; a rate below 100% is flagged. Profile "ידני" → every vacation day is flagged. | O |
| The system does not manage the vacation balance (no fabricated entitlement); it shows days used only. | O |

### 10.4 Sickness (חוק דמי מחלה)

| Rule | Status |
|---|---|
| Rates per day of a continuous sickness period: day 1 — 0%, days 2–3 — 50%, from day 4 — 100% (amendment 4, in force 1.4.2011; one secondary source still quotes 37.5% — conflict noted, the engine uses 50%). | S |
| The period is counted in calendar days and continues across months (look-back up to about 3 months is loaded). If its start lies before the loaded data, the day is flagged. | O |
| Monthly employee: weekly rest days and holidays inside the period are part of it. Hourly/daily employee: sick pay only for scheduled workdays. The estimated balance deduction follows the same rule. | S |
| Accrual 1.5 days per month up to 90 days; payment requires a balance and a medical certificate — **not managed**, so every sick day is flagged for review. | S |
| More favourable arrangements: "100% from day 2" / "100% from day 1"; a manual override can never go below the statutory rate (clamped, with an explanation). | O |
| Display: recorded sick days, paid day-equivalents (e.g. day 2 at 50% = 0.50) and hour-equivalents (8:24 × 50% = 4:12). Example from the specification reproduced in the tests. | O |

### 10.5 Holidays (דמי חגים)

| Rule | Status |
|---|---|
| Monthly employee: no deduction for a holiday on a scheduled workday (100%, "rule"). | S |
| Hourly/daily employee (extension order, framework agreement 2000): after 3 months of employment; not for a holiday on Friday/Saturday in a five-day workplace (six-day: not Saturday); not if absent the day before/after without the employer's consent. Engine: missing employment start date → review; worked/authorised neighbouring workdays or a manual "זכאות אושרה" → 100% "estimate"; otherwise review. Payment basis (annual daily average) is not computed. | S |
| A day marked "חג" is never counted as vacation. Work on a holiday is recorded as work with the existing holiday premiums; the additional holiday-pay question is flagged (case law on hourly workers who worked on a holiday). | S / I |
| Frameworks: "לפי צו ההרחבה", "הסכמי – כל חג משולם", "ידני" (always review). | O |

### 10.6 Election days

| Rule | Status |
|---|---|
| Knesset elections (Basic Law: The Knesset §10; Elections Law §136) and local-authority elections (§97ב): a paid day of rest for an employee with at least 14 consecutive days with the employer; paid as a regular day, not deducted from vacation. Local elections require a manual confirmation that the day applies to the workplace's area. "Other election day" → manual review. | S |
| Work on election day: actual hours are recorded as work; the statute sets no rate — **no automatic 200%** (a common practice only). Flagged. | S / I |

### 10.7 Weekly credit toward the 42-hour week (I)

No primary source or ruling settling whether paid absence counts toward the weekly 42 hours was found; one
payroll-accounting source says it does. The engine therefore makes it a **business setting**
("היעדרות בתשלום ותקן 42 השעות"): when on, the nominal hours of a paid absence day (rate > 0) are credited to the
week's regular allowance, so later work in the same week (including Friday under the 1.1.6 Friday policy)
reaches the weekly threshold earlier. Credited minutes are never classified as overtime and are never added to
actual hours. Default: on for new businesses, **off** for existing ones (identical results to 1.1.6); a change
applies from the month after the last finalised month.
