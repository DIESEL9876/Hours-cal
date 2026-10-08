# Legal calculation rules — documented basis

**Document date:** 2026-10-08
**Applies to engine version:** 1.0.0 (`src/engine/`)
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
| 3.3 | 8.4 decimal hours (8:24) is **never** used as a daily threshold (tested). | — | S |
| 3.4 | Six-day week: Sunday–Thursday **8:00**, Friday **7:00**; weekly cap 42 (so 8×6 ≠ 48 regular hours). | `SIX_DAY_NORMAL_MINUTES = 480`, `SEVEN_HOUR_DAY_MINUTES = 420` | S |
| 3.5 | Statute s.2: on night work, on the day before the weekly rest, and on the eve of a holiday the employee does not work on — a working day does not exceed **7 hours**. Applied as `min(threshold, 7:00)`. | `SEVEN_HOUR_DAY_MINUTES` | S (rule) / **I** (application to five-day arrangements on holiday eves) → `EVE_THRESHOLD_REVIEW` raised whenever the reduction changes the result. |
| 3.6 | Work on a day that is not a scheduled workday (e.g. Friday in a five-day week) is **not** automatically overtime. It is classified against the day's threshold (Friday = eve of weekly rest → 7:00) and the weekly cap, and flagged `UNSCHEDULED_DAY_WORK` for contractual review. | — | I |
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
| 9.6 | Out of scope: income tax, National Insurance, pension, severance, sick/vacation/holiday pay, travel, absence entitlements. Absence statuses never create worked hours. |
