# Hours-Cal 1.1.10 — legal audit of 1.1.9 against the research pack of 2026-11-04

**Date:** 2026-11-04 · **Audited version:** 1.1.9 · **Corrected version:** 1.1.10
**Pack:**
- `Hours-Cal_1.1.9_Israel_Legal_Knowledge_Base_2026-11-04.md` (knowledge base, §1–§7)
- `Hours-Cal_1.1.9_Source_Seed_2026-11-04.json` (youth rules Y-001…Y-013, catalog COLL-001…COLL-018)
- `README_FOR_CLAUDE.txt`

Both pack files were read in full. The pack is a researched seed, **not a complete or certified legal database**. This
report and the app say so.

---

## 0. Evidence: what was actually established

| Evidence class | Meaning | Used for |
|---|---|---|
| **Original official legal text** | The statute or order text itself | **None.** No statute or order text was read for this release. |
| **Official text located** (`official_text_located`, `official_gazette_located`) | The research pack located the government PDF of the instrument; its clauses were not extracted | COLL-002, 003, 005, 006 (gazette), 007–013 |
| **Official document about the instrument** (`official_notice_located`, `official_circular_located`) | An enforcement notice or circular, not the order | COLL-001 (notice), COLL-004 (Ministry of Finance circular) |
| **Official announcement** (`official_announcement`) | Knesset press release on Amendment 22 (2024) | Y-013 |
| **Verified rights summary** (`rights_summary`) | Kol Zchut articles. Approved by you for this task, but not the statute or the official gazette | Y-001…Y-012, Y-014…Y-017 |
| **Located only** (`directory_only`) | The title is listed in the government extension-order directory; no text was extracted | COLL-014…COLL-018 |
| **Unapproved secondary** (`unapproved_secondary`) | Commercial or secondary sources from the 1.1.9 work, outside your source policy | Recuperation rate 451.50 ₪, holiday-pay framework order, pension order (all informational only) |

**Network: no source could be opened from the build environment.** On 2026-11-04 the proxy refused CONNECT (HTTP 403)
to these hosts:
- `main.knesset.gov.il`
- `www.gov.il`
- `www.kolzchut.org.il`
- `teen.kolzchut.org.il`
- `www.btl.gov.il`

So every figure below is **as stated in the research pack**, carried into the code with its source URL and evidence
class. None was independently re-read here.

To allow the hosts, either:
- add them under Network access → Allowed domains in the cloud environment settings; or
- have a payroll-law reviewer verify the rules and record the check in the app.

---

## 1. What 1.1.9 already implemented correctly (kept unchanged)

| Area | 1.1.9 behaviour | Pack reference |
|---|---|---|
| Age per attendance date | `ageOn(birth, date)`; a minor only before the 18th birthday; a mid-month birthday changes the rules from that date | §1, Y-04, tests 7–8 |
| Missing date of birth | Adult rules apply provisionally; no age is guessed; "classification unverified" note | §1 |
| Minutes never removed | Youth checks are warnings only; recorded minutes, classification and pay are unchanged | §1, Y-07 |
| Daily limits | Under 16: 8:00. 16–17 in a five-day week: 9:00. Otherwise 8:00. Eve of the weekly rest: 7:00 | Y-001…Y-005 |
| Weekly limit | 40:00 per Sunday–Saturday week, independent of the adult 42-hour week (COLL-001 never overrides it) | Y-001, COLL-001 |
| Overtime prohibited but paid | `YOUTH_PAY_REVIEW`: "full pay for all hours worked; classification requires review" | Y-008, Y-07 |
| Youth minimum wage | 26.07 / 27.94 / 30.92 ₪ from 2026-04-01, age brackets by date, not retroactive (no check before the table) | Y-009…Y-011 |
| Weekly rest of 36 hours | Adult `WEEKLY_REST_SHORT` check also ran for minors (with a date of birth) | Y-006 |
| Rest day | Taken from the employee's configured weekly rest (Shabbat or a chosen fixed day); never inferred from religion | Y-02 |
| Travel cap | 22.60 ₪/day shown as reference only, never enforced. The pack confirms the figure in the official 2016 PDF | COLL-002 |
| Agreements not activated by selection | Selection is reference only; confirmation and verification required | §3.5, README 4 |
| Partial catalog | The UI says the catalog is partial | §3.2, §4 |
| Closed months immutable | Snapshot and rule versions are stored on close | §1, test 17 |

## 2. What had to change (inconsistencies found) and how 1.1.10 fixes them

| # | 1.1.9 behaviour | Problem against the pack | 1.1.10 correction | Rule / test |
|---|---|---|---|---|
| 1 | Ages 16–17: night = 22:00–06:00 for everyone | An **age-only night permission** (§Y-03: "do not encode a universal night-permission rule based only on age"). 20:00–08:00 applies to minors under compulsory education. | New input **חובת לימוד** (compulsory / not / unknown). Compulsory or under 16 → 20:00–08:00 prohibited. Not compulsory → 22:00–06:00. **Unknown → 20:00–22:00 is a review flag** ("ambiguity between statute and enforcement interpretation"). | Y-014; `legal1110` night tests |
| 2 | No school-vacation handling; message mentioned "חופשת לימודים" vaguely | Amendment 22 (2024): ages 16–17 may work **until 01:00 in an official school vacation**, under conditions; after 23:00 the employer must arrange transport home. Do not use the outdated limit. | User-entered **official school vacation ranges**. On such dates (16–17), minutes from 20:00 to 01:00 become a **conditions review** (Y-013), with a transport note when work continued after 23:00. Never silently allowed. After 01:00: prohibited. Under 16: no exception. No message or rule cites the outdated limit (tested). | Y-013; test 9 |
| 3 | No night permits | Permits must be checked for identity, validity and scope; an unknown or expired permit must not be assumed | **Night permits** (number, validity, latest hour). Inside validity and hour → permit review; expired → the prohibition stays and the message says so | Y-014; test 10 |
| 4 | Rest-day message: "אסורה ללא היתר" | No permit can waive work on the weekly rest | "אסורה, ואין היתר המתיר אותה" + pay review; youth-specific `YOUTH_WEEKLY_REST_SHORT` | Y-006; test 5 |
| 5 | Break: gross ≥ 6:00, break minutes (incl. automatic deductions) ≥ 45 | Trigger is 6 hours of **actual work**; 45 minutes total with **one 30-minute continuous segment**; **30 minutes on an eve**; do not count a hypothetical break | Net ≥ 6:00. Only confirmed unpaid breaks and gaps between same-day shifts count as taken. A 30-minute segment is required. Eve requirement is 30. Unconfirmed automatic or paid breaks → `YOUTH_BREAK_UNVERIFIED` review, never "break taken". | Y-007; test 6 |
| 6 | Eve limit of 7:00 before every holiday | 7 hours "on the day before a holiday **not worked by the youth**" | The holiday-eve limit applies only if the minor does not work on the holiday (the weekly-rest eve always) | Y-005; test 4 |
| 7 | Minimum age 15 flat | 15 in the school year; **14 in an official school vacation** (conditions); below that only licensed exceptions | 14 on a recorded vacation date → conditions review; 14 otherwise or under 14 → prohibited | Y-015; test 11 |
| 8 | No apprentice rate | Apprentice 22.35 ₪ (60%) from 2026-04-01, **only with documented recognised status** | Apprentice applies only with a document reference (blank = not an apprentice), always with a review | Y-012; test 12 |
| 9 | Silent outside the wage table period | Rates not retroactive; earlier months need a historical table | Period review "no youth minimum-wage table for this period" | Y-009; test 12 |
| 10 | Youth vacation not distinguished | 18 calendar days, proration, 4% for short employment; not the business average estimate | A minor's vacation day → `YOUTH_VACATION_REVIEW`; nothing calculated or duplicated | Y-017; test 13 |
| 11 | No schooling caution | School hours cannot be inferred from age | Period review when the minor works outside recorded vacations and schooling is not "not compulsory" | Y-016 |
| 12 | Prohibited and payable hours not reported separately | Reports must separate recorded, prohibited and payable | `result.youth`: recorded (all payable), daily excess, weekly excess beyond it (no double counting), night prohibited / review, rest-day minutes. Shown in the totals bar and the Excel/CSV "נוער" table. | Y-001, Y-008; test 3 |
| 13 | 29 February birthday → invalid "turns 18" date | — | `birthdayOn` → 1 March in a common year | test 8 |
| 14 | Agreements: a whole-profile "professional verification" activated all rules of the version | Each executable **clause** must be verified (exact clause, effective date) and applicability fully confirmed (§1, §3.4–3.7) | **Clause-level gate.** Executable only with a COMPLETE confirmation (industry, occupation, employee class not excluded, full current text read, amendments and exclusions checked) AND a verification of that clause (clause reference, effective date, verifier). 1.1.9 verifications are kept for history but no longer activate anything. | tests 14–15 |
| 15 | Monetary conflicts between instruments → "most favourable value" | "Do not blindly cherry-pick the maximum from every instrument" (§3.6) | Two verified instruments for the same domain → **nothing applied**, professional decision flagged | conflict test |
| 16 | 8 catalog entries with generic directory links; no evidence class; no families | Catalog from government publications, agreements kept separate from orders, amendment histories | COLL-001…018 with specific URLs, evidence class, publication year, scope, covered/excluded employee classes and relations (amended by / wage update). Family filter separates extension orders, collective agreements (none catalogued) and wage notices. Official directories open from the picker. | catalog test |
| 17 | Recuperation helper computed a suggestion from an unverified profile | Recuperation clauses are "not yet provided as verified executable rules"; source outside the policy | The figures are shown for reference only; **no amount is suggested** until the clause is verified | UI + rules test |
| 18 | Closed months could be recalculated with new youth rules | "Version a later amendment without rewriting previously closed month" | Youth rule sets **Y1** (1.1.9, frozen) and **Y2** (1.1.10). A month closed under 1.1.9 is recalculated with Y1; new closes record `youthRuleSet: 'Y2'` and `legalRegistryVersion` | test 17 (engine + database) |

## 3. What cannot yet be safely automated

| Topic | Why | What the app does |
|---|---|---|
| Exact pay for prohibited youth overtime, night or rest-day work (premium bands) | Pack Y-07: needs a dedicated case matrix and professional validation | Keeps the general-law classification (pay never zero or reduced) and flags `YOUTH_PAY_REVIEW` (`requires_payroll_review`) |
| Commencement dates of the youth hour, rest, break and night rules | Seed `effective_from: null` | Applied as **flags only** for all dates, labelled "commencement unverified"; they never change money |
| Amendment 22 (2024) conditions and effective date | Only a press release; conditions not specified | Converts the prohibition into a conditions review; never grants permission |
| 16–17 between 20:00 and 22:00 under compulsory education | Statute vs enforcement ambiguity (Kol Zchut) | Prohibited when "compulsory", review when unknown |
| School hours | Not inferable from age | Period review |
| Permit terms and ministerial exemptions | Need the permit itself | Permit review only within the recorded validity and hour |
| Youth vacation entitlement and pay (18 days, 200/240 proration, 4% under 75 days, 3-month ÷ 90 or best 3 of 12) | History and wage data not held | Vacation-day review; the business paid-day estimate is not statutory vacation pay |
| Adult hourly minimum wage (182 / 186 hours) | Pack: do not apply 173 naively to adults | Not checked |
| Every collective agreement and extension-order clause | No clause extracted; applicability is case-specific | All 18 pack entries are informational ("המקור אותר; הוראות החישוב לא אומתו"); a clause executes only after professional clause verification |
| 2026 sector wage updates (cleaning from 1/2026, guarding from 4/2026) | Amounts not extracted | Listed with dates and **no amounts**; old rates are not used |
| Recuperation rate after 30.6.2026 and the 451.50 ₪ figure itself | Outside the approved sources | Reference only, no suggestion |
| Multi-user editing / shared SQLite on SMB/NAS | Pack safety constraint | Not supported (single-user local database — unchanged) |

## 4. Activated rules — exact source and effective date

Mode legend:
- **flag** — a compliance or review warning only;
- **wage_check** — compares the entered hourly rate, warning only;
- **exception** — can only turn a prohibition into a conditions review.

No rule changes recorded hours or pay.

| Rule | What it checks | Mode | Source (as given in the pack) | Evidence | Effective from | Until |
|---|---|---|---|---|---|---|
| Y-001 | 40 h/week | flag | https://www.kolzchut.org.il/he/יום_עבודה_ושעות_עבודה_לנוער | rights summary | not verified (flag on all dates) | — |
| Y-002 | Under 16: 8 h/day | flag | same | rights summary | not verified | — |
| Y-003 | 16–17, five-day week: 9 h/day | flag | same | rights summary | not verified | — |
| Y-004 | 16–17, six-day week: 8 h/day | flag | same | rights summary | not verified | — |
| Y-005 | 7 h on the eve of the weekly rest / an unworked holiday | flag | same | rights summary | not verified | — |
| Y-006 | 36 h weekly rest incl. the rest day; no permit waives it | flag | https://www.kolzchut.org.il/he/מנוחה_שבועית_לנוער_עובד | rights summary | not verified | — |
| Y-007 | 45 min (30 continuous) after 6 h; 30 min on eves | flag | https://www.kolzchut.org.il/he/הפסקות_בעבודה_לנוער | rights summary | not verified | — |
| Y-008 | Overtime prohibited, but paid | flag | https://www.kolzchut.org.il/he/יום_עבודה_ושעות_עבודה_לנוער | rights summary | not verified | — |
| Y-009 | Minimum wage under 16: 26.07 ₪/h | wage_check | https://www.kolzchut.org.il/he/תשלום_שכר_לבני_נוער | rights summary | **2026-04-01** | open |
| Y-010 | 16 to day before 17: 27.94 ₪/h | wage_check | same | rights summary | **2026-04-01** | open |
| Y-011 | 17 to day before 18: 30.92 ₪/h | wage_check | same | rights summary | **2026-04-01** | open |
| Y-012 | Recognised apprentice: 22.35 ₪/h (document required) | wage_check | same | rights summary | **2026-04-01** | open |
| Y-013 | 16–17 until 01:00 on official school vacation; transport after 23:00 | exception | https://main.knesset.gov.il/News/PressReleases/pages/press03062024jfd.aspx | official announcement | not verified (press release 3.6.2024) | — |
| Y-014 | Night windows by schooling; permits | flag | https://www.kolzchut.org.il/he/איסור_העסקת_נוער_בעבודת_לילה | rights summary | not verified | — |
| Y-015 | Minimum age 15 / 14 on vacation | flag | https://www.kolzchut.org.il/he/גיל_העסקת_נוער | rights summary | not verified | — |
| Y-016 | Schooling not inferable | review | https://www.kolzchut.org.il/he/העסקת_צעירים_מעל_גיל_16 | rights summary | — | — |
| Y-017 | Youth vacation not calculated | review | https://www.kolzchut.org.il/he/חופשה_שנתית_לבני_נוער_עובדים | rights summary | — | — |

The registry is in `src/engine/legalRules.ts` (`LEGAL_REGISTRY_VERSION 2026.11.04`). Every warning the engine emits
carries its `ruleId`; exports list it.

**No collective-agreement or extension-order clause is activated in 1.1.10.** The mechanism accepts per-clause
verifications by a professional.

## 5. Catalog `2026.11.04` (seed — not exhaustive)

- **Coverage:** 18 research-pack entries (COLL-001…018) plus 3 informational 1.1.9 entries outside the pack, plus "not listed".
- **Collective agreements:** none catalogued. The family filter shows this, and registered agreements must be entered as "not listed".
- **Size:** the official directory lists about 144 results; this catalog does not claim to cover them.
- **Statuses:**
  - **אסמכתה בלבד** — official text located;
  - **אין מקור מלא** — directory-only or secondary;
  - **הוחלף/תוקן** — a later amendment or wage update is listed;
  - per employee: **תחולה בבדיקה**, then **המקור אותר; הוראות החישוב לא אומתו** or **כללים מאומתים** (per verified clause).
- **Employee-class scope:**
  - construction (2015/2025): site workers covered, office staff excluded;
  - cleaning and guarding: contractor workers covered, the client company's employees excluded.
- **Amendment history:**
  - construction 2015 → amended by 2025;
  - cleaning 2014 → 2026 wage update;
  - guarding 2022 → 2026 wage update;
  - transport 1989 → 2007/2008 (the relation is marked unverified).

## 6. Data and versioning

- **Migration v4** is additive: nullable `employees.youth_json`. A pre-migration backup is taken automatically, and no existing value changes (tested v3 → v4).
- **Youth rule sets:**
  - Y1 = 1.1.9, frozen code (`checkYouthDayV1` / `checkYouthWeekV1`);
  - Y2 = 1.1.10;
  - a month closed without `youthRuleSet` in `rules_json` is recalculated with Y1, so its snapshot hash does not change (tested end-to-end through the database);
  - new closes store `youthRuleSet: 'Y2'`, `legalRegistryVersion` and every clause verification.
- **Agreement selections** stored by 1.1.9 still resolve (ids kept). Their old confirmations show as "תחולה בבדיקה" until the new scope checks are completed.
- **Unchanged:** licensing, app id `il.office.hourscal`, the Hebrew RTL UI and all other functions.

## 7. Tests

- `src/engine/__tests__/legal1110.test.ts` (23 tests): the pack's §6 matrix items 1–17 (item 18, multi-user sync, does not apply), the registry, and the "no outdated limit" check.
- `src/data/__tests__/legal1110.test.ts` (3 tests): migration v4, youth-details validation, closed-month rule-set preservation.
- `e2e/payroll.spec.ts` extended:
  - youth details;
  - the recorded / prohibited split;
  - the family filter and official links;
  - the full confirmation;
  - construction + office employee blocked.
- **Deliberately changed 1.1.9 tests** (`src/data/__tests__/payroll119.test.ts`):
  - "confirmation + professional verification activate a profile" now requires the complete confirmation plus a clause verification;
  - "monetary conflicts take the favourable value" replaced by "values are informational until verified";
  - search expectations updated for the larger catalog.
- **All other existing tests are unchanged and pass.**

## 8. Other fix found during verification (not a legal rule)

- **What happened:** in one full e2e run, an exit time typed while the entry-only save was still in flight was lost. The grid row still believed it had no shift, tried to create a second, overlapping one, and that was rejected.
- **Fix** (`src/ui/screens/Attendance.tsx`):
  - each grid row now serialises its commits and always builds on its own latest shift;
  - undo records the correct "before" state.
- **Test:** `e2e/fast-entry.spec.ts` guards fast entry → exit → break typing under CPU throttling. It could **not** reproduce the original timing on demand (it also passes on the old code), so it is a guard, not proof.
