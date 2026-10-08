# Exceptional cases requiring human payroll review

The engine never silently guesses in these situations. Each one produces a flag (code in brackets)
that appears in the attendance row, the day drawer, the monthly summary and the exports.
"Blocks finalisation" means the month cannot be closed until it is resolved.

## A. Data problems — block finalisation

| Case | Flag | What to do |
|---|---|---|
| Entry without exit, or exit without entry | `INCOMPLETE` | Complete or delete the record. |
| Day marked "רישום חסר" | `MISSING_RECORD` | Obtain the attendance data. |
| Duplicate or overlapping shifts (incl. across midnight) | `DUPLICATE_SHIFT`, `OVERLAPPING_SHIFT` | Delete or correct one of them. Both are excluded from totals until fixed. |
| Break equal to / longer than the shift, break outside the shift | `BREAK_EXCEEDS_SHIFT`, `BREAK_OUTSIDE_SHIFT` | Correct the break. |
| Wall-clock time that does not exist (spring DST gap) | `NONEXISTENT_TIME` | Re-enter the actual time. |
| Estimated break not confirmed as actually taken | `BREAK_UNCONFIRMED` | Confirm (✓) or type the actual break. |
| Employee under 18 | `MINOR_UNSUPPORTED` | Calculate manually under the Youth Labour Law. |
| No settings in force for a date | `NO_SETTINGS` | Add a settings version. |

## B. Legal classification uncertain — must be reviewed (acknowledge per shift or at month close)

| Case | Flag | Why |
|---|---|---|
| Work on a non-scheduled day (e.g. Friday for a five-day employee, Saturday) | `UNSCHEDULED_DAY_WORK` | Treatment may depend on the employment contract or agreement. Engine applies daily + weekly thresholds only. |
| 7-hour eve-of-rest / holiday-eve threshold changed the result | `EVE_THRESHOLD_REVIEW` | Application to five-day arrangements is interpretive. |
| Any work on a holiday | `HOLIDAY_WORK` | Holiday premium depends on the applicable extension order/agreement; default 150/175/200 unverified. Independence Day included. |
| Weekly-rest window for a non-Jewish employee | `REST_WINDOW_REVIEW` | Calendar-day window used; actual 36-hour rest must be confirmed. |
| Break position unknown and the shift crosses Shabbat/holiday start | `BREAK_POSITION_ASSUMED` | Premium minutes depend on when the break was taken. Enter the break start time. |
| Night-shift status depends on the (unknown) break position | `NIGHT_BREAK_DEPENDENT` | Changes the daily threshold (7 h vs normal). |
| Ambiguous wall-clock time (autumn DST overlap) | `AMBIGUOUS_TIME` | The first occurrence is used. |
| Shift longer than 16 hours | `LONG_SHIFT` | Likely data-entry error. |
| Absence status on a day with recorded work | `STATUS_CONFLICT` | Contradictory data. |
| Break estimate for non-manual employee via legal profile | `BREAK_NON_MANUAL_ESTIMATE` | Exemption duration not verified. |
| Exempt-from-law employee | `EXEMPT_PROFILE` | Confirm the employee is truly excluded (s.30). |
| Custom / collective-agreement profile | `CUSTOM_PROFILE` | Confirm thresholds match the agreement. |
| Five-day employee without a configured short day | `NO_SHORT_DAY` | The extension order requires one fixed 7.6-hour day. |

## C. Compliance warnings — hours are kept; the office must decide

| Case | Flag |
|---|---|
| More than 12 hours in a day | `DAILY_LIMIT` |
| More than 16 overtime hours in a week | `WEEKLY_OT_LIMIT` |
| More than 58 hours in a week | `WEEKLY_TOTAL_LIMIT` |
| Work during weekly rest (permit + compensatory rest) | `WORK_ON_WEEKLY_REST` |
| Weekly rest shorter than 36 hours | `WEEKLY_REST_SHORT` |
| Short rest between shifts (office threshold) | `SHORT_REST_BETWEEN_SHIFTS` |
| Manual labourer with less than the statutory break | `BREAK_BELOW_MINIMUM` |
| Break longer than 3 hours | `BREAK_TOO_LONG` |

## D. Always outside the engine — handle in payroll

- Special industries and occupations with their own rules (security guards, hotels, health, transport, agriculture, drivers, domestic caregivers).
- Public-sector 40-hour week and other collective agreements (use the custom profile and verify).
- On-call / standby time, travel time, training time — whether they count as work.
- Compensatory rest for work on the weekly rest day.
- Global overtime arrangements (שעות נוספות גלובליות) and their validity.
- Vacation, sick leave, holiday pay, reserve duty pay, pension, severance, tax, National Insurance.
- Minimum-wage compliance and hourly-rate determination for monthly employees.
- Changes in law after 2026-10-08 (re-verify `docs/LEGAL_RULES.md`).
