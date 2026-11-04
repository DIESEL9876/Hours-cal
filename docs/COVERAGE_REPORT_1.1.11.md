# Hours-Cal 1.1.11 — collective agreements and extension orders: source access, coverage and validation

**Date:** 2026-11-04 · **Catalog:** `2026.11.04.2` · **Previous:** 1.1.10

## 1. Source-access assessment (done first)

The access check ran before any research:

- **Direct access:** `curl` through the session proxy and the fetch tool.
- **Search index:** a web-search engine's index of gov.il, which runs outside the container.

| Source | Direct access | Result |
|---|---|---|
| `https://www.gov.il/he/Departments/dynamiccollectors/extension-orders` (Ministry of Labor — extension orders) | **Blocked** | proxy CONNECT 403 / host not resolvable |
| `https://workagreements.labor.gov.il/` (collective agreements registry) | **Blocked** | proxy CONNECT 403 / host not resolvable |
| `https://www.gov.il/he/Departments/Units/working-relations` (Labour Relations Unit) | **Blocked** | proxy CONNECT 403 |
| `https://www.gov.il/BlobFolder/...` (every official PDF) | **Blocked** | proxy CONNECT 403 |
| `www.kolzchut.org.il`, `main.knesset.gov.il`, `www.btl.gov.il` | **Blocked** | proxy CONNECT 403 / not resolvable |
| Search-engine index restricted to gov.il / labor.gov.il | Available | Titles, file URLs and short text fragments of indexed files — **not the documents themselves** |

**Consequence:** **no official document was opened and no clause was verified in this release.**

What you need to provide (either option works):
1. **Allow these domains** in the environment's network settings (Network access → Allowed domains; see https://code.claude.com/docs/en/cloud-environments#network-access):
   - `www.gov.il`
   - `workagreements.labor.gov.il`
   - `www.kolzchut.org.il`
   - `main.knesset.gov.il`
   - `www.btl.gov.il`
2. **Or upload the PDFs** listed in §5 to the session.

Search-index text was used **only** to locate official file URLs. It is never used as the content of a rule. Several
indexed fragments are OCR-garbled, and the index summaries themselves warn the figures may be wrong.

## 2. What was built (independent of the blocked sources)

| Capability | Status |
|---|---|
| **Verified clauses now change calculations.** A payroll professional who has read the official text transcribes a clause: clause reference, effective-from / effective-to, verifier and values. Clause types: regular daily/weekly hours (shortened week), overtime tier rates, rest-day and holiday rates, night/shift premium window and percentage, sector minimum hourly wage. | Implemented |
| A clause executes only with a **complete applicability confirmation** for the employee: industry, occupation, employee class not excluded, full current text read, amendments and exclusions checked. Never from a title. | Implemented (since 1.1.10, extended) |
| Values **below the statute are rejected** (overtime < 125% / 150%, rest/holiday < 150%, week > 42 h, day > 8:36, first tier > 2 h). The clause is flagged and not applied. | Implemented |
| **No automatic choice between instruments.** Two instruments with clauses for the same domain and overlapping periods block each other. A catalog profile and a transcription for hours also block each other. | Implemented |
| **Effective dates.** Clauses apply only between effective-from and effective-to, intersected with the instrument's own dates. | Implemented |
| **Closed months are never rewritten.** A clause verified after a month was closed is ignored for that month. Reopening the month applies it. | Implemented and tested |
| **Recorded hours preserved.** Rate and premium clauses change the pay estimate only; minutes and buckets are unchanged. The sector minimum wage is a compliance warning and never changes the rate. Every day's explanation cites the clause. | Implemented |
| **Registered agreements not in the catalog** (e.g. a company's special collective agreement from the registry): enter the title and registration number, then transcribe its clauses. | Implemented |
| **Hebrew search and filters:** free text (title, sector, year, registration number, source, worker class, research key), sector dropdown (15 sectors), document-family filter (extension orders / collective agreements / wage notices), result count | Implemented |
| **Clauses not transcribable** in 1.1.11: recuperation and travel (catalog profile path only), vacation, sickness, pension | Documented limit |

## 3. Catalog coverage (29 instruments, `2026.11.04.2`)

- **Added in 1.1.11:** 8 unique instruments located through the search index.
- **Updated:** 2 entries (COLL-017, COLL-018) gained the addresses of their located official files.
- **Total:** 29 = 18 from the research pack + 8 new + 3 informational entries kept from 1.1.9.

| Evidence class | Count | Meaning |
|---|---|---|
| Official text located (PDF) | 10 | The pack located the instrument's PDF; clauses not extracted |
| Official gazette located | 1 | Reshumot PDF located |
| Official circular / notice about the instrument | 2 | Not the order text |
| Government directory listing only | 5 | Title and date only |
| **Search index only (new)** | 8 | File URL found in a search index; file not opened; title as indexed |
| Unapproved secondary sources | 3 | Recuperation, holiday framework, pension (1.1.9) |

| Sector | Instruments | Entries |
|---|---|---|
| Economy-wide | 6 | short week 2018, travel 2016, reservists 2026 (temporary), recuperation, holiday framework 2000, pension |
| Cleaning and maintenance | 2 | order 2014, 2026 wage notice |
| Security and guarding | 2 | order (2022 circular), 2026 wage notice |
| Construction and infrastructure | 2 | order 2015, order 2025 (Reshumot 13286 located) |
| Hotels and tourism | 2 | hotels 1995, tour guides |
| Institutional catering | 1 | 2025 (gazette) |
| Event halls | 1 | 2008 |
| Retail / food chains | 1 | food marketing networks 2010 |
| Transport, logistics and shuttles | 4 | transport 1989 / 2007 / 2008 (heavy goods), shuttles 2018 |
| Manufacturing and industry | 3 | metal & electrical (youth) 1975, wood 1973, industry pension framework 2006 |
| Agriculture | 2 | order 2000 (by file name), order 2001 (referenced by Ministry guidance) |
| Welfare | 1 | social workers under state contracts 2025 |
| Manpower agencies | 1 | 2004 |
| Services (garages) | 1 | 1995 |
| **Nursing and care** | **0** | No caregiving extension order was found. The 2004 manpower order is indexed as **excluding** care workers. |
| **Restaurants (general)** | **0** | Only institutional catering is covered. No general restaurant order was found. |
| **Collective agreements** | **0** | The registry (workagreements.labor.gov.il) could not be opened. Registered agreements can be recorded as "not listed" with their registration number. |

**What this does and does not cover:**
- It covers the instruments for the priority sectors that could be located.
- It is **not** evidence that these instruments cover most Israeli employees.
- Applicability always depends on each instrument's own definitions, which were not read here.
- The official directory lists about 144 results; the registry holds many thousands of agreements.

## 4. Payroll clauses — verified and executable

| Status | Count |
|---|---|
| Catalog clauses verified against an official text and executable | **0** |
| Catalog clauses encoded but informational (need clause verification): travel cap 22.60 ₪ (COLL-002), recuperation 451.50 ₪ (secondary) | 2 |
| Clauses a professional can transcribe per employee from the official text | hours, overtime rates, rest/holiday rates, night premium, sector minimum wage |

**Every catalog entry remains informational** ("המקור אותר; הוראות החישוב לא אומתו" or "אין מקור מלא") until a
professional transcribes a verified clause for an employee with a complete applicability confirmation.

## 5. Files to provide (located through the search index; not opened)

### 5.1 Priority sectors

| Sector | Official file (URL as indexed) | Why |
|---|---|---|
| Security | `https://www.gov.il/BlobFolder/service/calculator-work-hour/he/workers-rights_wage-update1426.pdf` | Chief Labour Relations Officer circular: sector wage update from 1.4.2026. The index summary quotes hourly figures, but they are **not used** until the file is read. |
| Cleaning | `https://www.gov.il/BlobFolder/dynamiccollectorresultitem/extension-order-cleaning-2014/he/extension-order-cleaning-2014.pdf` + the 2026 wage notice | Sector hours, premiums, minimum wage |
| Construction | `.../extension-order-construction-2015/...pdf` and `https://www.gov.il/BlobFolder/dynamiccollectorresultitem/extension-order-building/he/workers-rights_work-relations_extension-order-building.pdf` (Reshumot 13286, 18.3.2025) | 2015 base and 2025 amendment |
| Hotels | `.../extension-order-hotels-1995/...pdf` + later amendments | Hours, premiums |
| Institutional catering | `.../extension-order-restaurant/he/workers-rights_work-relations_extension-order-restaurant.pdf` | Scope and rates |
| Event halls | `.../extension-order-halls-2008/...pdf` | The index fragment mentions 9 paid holidays after 3 months — **unverified** |
| Food retail | `.../extension-order-food-marketing-2010/...pdf` | Scope (network ≥ 2 stores / > 500 m²) |
| Transport | `.../extension-order-transport-1989`, `-2007`, `-2008`, `extension-order-shuttle-2018` | Hours, overtime, rest days |
| Agriculture | `.../extention-order-agriculture-gardeners-2000/...pdf` and the 2001 agriculture order text | The Ministry holiday guidance (`reports/payment-agri-workers-4holiday/...pdf`) cites §28 of the 2001 order |
| Industry | `.../extention-order-pension-2006/...pdf`, `.../extension-order-wood-1973/...pdf`, metal & electrical | Industry agreements |

### 5.2 Economy-wide and registry

| Need | What to provide |
|---|---|
| Economy-wide | The current texts of the short-week (2018), travel (latest update), recuperation (2026 year) and pension extension orders |
| Collective agreements | Registry access (`workagreements.labor.gov.il`) or specific agreement PDFs. Example indexed file format: `https://workagreements.labor.gov.il/api/GetSelect/DownLoadFile?Type=Agreements&FileName=<number>&FileExtension=pdf` |

## 6. Regression results (this build)

| Suite | Result |
|---|---|
| `tsc -b` | clean |
| Unit (vitest) | **444 passed**, 2 skipped |
| End-to-end (Playwright) | **17 passed**, including the new `e2e/agreements.spec.ts` and the 1.1.10 suites |
| Rust tests, `check:release` | see the final run in the delivery message |

New tests:

- **`src/engine/__tests__/agreements1111.test.ts`** (10):
  - gate (a complete confirmation is required);
  - rejection of sub-statutory values;
  - effective dates;
  - conflicts and disjoint periods;
  - unlisted-agreement citation;
  - bucket table;
  - overtime rates (pay only, minutes unchanged);
  - night premium;
  - sector minimum-wage warning;
  - transcribed hours.
- **`src/data/__tests__/legal1110.test.ts`:**
  - a clause verified after closing does not change the closed month;
  - reopening applies it.
- **`e2e/agreements.spec.ts`:** the full UI path:
  - sector filter;
  - a not-listed registered agreement;
  - complete confirmation;
  - rejected 120% value;
  - transcription of 150% / 200%;
  - **pay estimate 590 → 630 ₪ with hours unchanged**;
  - the citation shown in the day explanation.

All clause values in tests are synthetic.
