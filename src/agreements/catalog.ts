/**
 * Local, offline catalog of Israeli extension orders, collective agreements and sector wage notices (1.1.10).
 *
 * This is a SEED catalog, not a complete or certified registry. Entries COLL-001 … COLL-018 come from the research
 * pack of 2026-11-04 (government / Knesset sources and Kol Zchut); a few 1.1.9 entries that the pack does not cover
 * are kept and labelled as unapproved secondary sources. The government extension-order directory lists about 144
 * results (some are wage-update notices); collective agreements registered with the Labour Relations Unit are not
 * catalogued here. Users can open the official directories from the picker instead of relying on this list.
 *
 * Evidence classes (what was actually established — none of these URLs could be opened from the build environment):
 *   official_text_located      original government PDF of the instrument located by the research pack
 *   official_gazette_located   official gazette (Reshumot) PDF located by the research pack
 *   official_circular_located  an official circular ABOUT the instrument (not the instrument itself)
 *   official_notice_located    an official interpretive/enforcement notice (not the order text)
 *   directory_only             the title appears in the government directory; no text was extracted
 *   unapproved_secondary       commercial/secondary sources only (outside the approved source policy)
 *
 * Nothing in the catalog is executable by itself. A rule clause is used only when (rules.ts): the instrument is in
 * force, a COMPLETE applicability confirmation exists for the employee (class not excluded, full current text read,
 * amendments and exclusions checked), and that exact clause of that profile version was verified against the official
 * text with its clause reference and effective date. Selecting an instrument never changes a calculation.
 *
 * The catalog is refreshed only by an application update (no live scraping during payroll).
 */
import type { EmployeeClass, LocalDate } from '../engine';

export const CATALOG_VERSION = '2026.11.04';
export const CATALOG_VERIFIED_ON: LocalDate = '2026-11-04';

export type InstrumentType =
  | 'statute'
  | 'general_extension_order'
  | 'industry_extension_order'
  | 'temporary_general_extension_order'
  | 'sector_minimum_wage_notice'
  | 'general_collective_agreement'
  | 'special_collective_agreement';

export const INSTRUMENT_TYPE_LABELS: Record<InstrumentType, string> = {
  statute: 'חוק',
  general_extension_order: 'צו הרחבה כללי',
  industry_extension_order: 'צו הרחבה ענפי',
  temporary_general_extension_order: 'צו הרחבה כללי זמני',
  sector_minimum_wage_notice: 'הודעת עדכון שכר מינימום ענפי',
  general_collective_agreement: 'הסכם קיבוצי כללי',
  special_collective_agreement: 'הסכם קיבוצי מיוחד',
};

/** Extension orders, collective agreements and wage notices are different instruments and are kept apart. */
export type InstrumentFamily = 'extension_order' | 'collective_agreement' | 'wage_notice' | 'statute';
export const FAMILY_OF: Record<InstrumentType, InstrumentFamily> = {
  statute: 'statute',
  general_extension_order: 'extension_order',
  industry_extension_order: 'extension_order',
  temporary_general_extension_order: 'extension_order',
  sector_minimum_wage_notice: 'wage_notice',
  general_collective_agreement: 'collective_agreement',
  special_collective_agreement: 'collective_agreement',
};
export const FAMILY_LABELS: Record<InstrumentFamily, string> = {
  extension_order: 'צווי הרחבה',
  collective_agreement: 'הסכמים קיבוציים',
  wage_notice: 'הודעות עדכון שכר',
  statute: 'חוקים',
};

/** Precedence layer for display and conflict detection (no automatic "most favourable" cherry-picking — rules.ts). */
export const PRECEDENCE: Record<InstrumentType, number> = {
  statute: 0,
  general_extension_order: 1,
  temporary_general_extension_order: 1,
  industry_extension_order: 2,
  sector_minimum_wage_notice: 2,
  general_collective_agreement: 3,
  special_collective_agreement: 4,
};

export type Verification = 'primary' | 'secondary' | 'metadata_only';
export type Evidence = 'official_text_located' | 'official_gazette_located' | 'official_circular_located' | 'official_notice_located' | 'directory_only' | 'unapproved_secondary';

export const EVIDENCE_LABELS: Record<Evidence, string> = {
  official_text_located: 'נוסח רשמי אותר (PDF ממשלתי)',
  official_gazette_located: 'פרסום ברשומות אותר',
  official_circular_located: 'חוזר רשמי בנושא (אינו נוסח הצו)',
  official_notice_located: 'הודעה רשמית בנושא (אינה נוסח הצו)',
  directory_only: 'רשום במאגר הממשלתי בלבד',
  unapproved_secondary: 'מקורות משניים בלבד',
};

export const EMPLOYEE_CLASS_LABELS: Record<EmployeeClass, string> = {
  site_worker: 'עובד/ת שטח או אתר (לא משרד)',
  office_staff: 'עובד/ת משרד / מטה',
  contractor_worker: 'עובד/ת של קבלן שירותים (ניקיון/שמירה) המוצב/ת אצל לקוח',
  client_employee: 'עובד/ת של חברת הלקוח (לא של הקבלן)',
  other: 'אחר',
};

export interface RecuperationRule {
  /** Recuperation year to which the day value applies. */
  yearFrom: LocalDate;
  yearTo: LocalDate;
  dayValueAgorot: number;
  /** Days per year by completed years of seniority: [minYears, days]. */
  daysBySeniority: [number, number][];
  /** No entitlement before completing the first year of employment. */
  afterFirstYear: true;
  note: string;
}

export interface TravelRule {
  dailyCapAgorot: number;
  /** Status of the cap value itself. */
  capStatus: string;
  note: string;
}

export interface RuleProfileVersion {
  version: string;
  /** null = the effective date of these values is not verified (a clause verification must supply it). */
  effectiveFrom: LocalDate | null;
  effectiveTo: LocalDate | null;
  verification: Verification;
  /** Calculation domains the profile covers (for the coverage report and the precedence engine). */
  covers: ('hours' | 'overtime' | 'breaks' | 'rest' | 'vacation' | 'sickness' | 'recuperation' | 'travel' | 'pension' | 'minimum_wage' | 'holidays')[];
  /** Hours thresholds: only for profiles whose hours provisions are encoded. */
  hours?: { dailyThresholdMinutes: number[]; weeklyThresholdMinutes: number; firstTierMinutes: number };
  recuperation?: RecuperationRule[];
  travel?: TravelRule;
  /** Plain-language summary of what is (and is not) encoded. */
  summary: string;
}

export interface Relation {
  kind: 'amended_by' | 'amends' | 'wage_update' | 'updates';
  id: string;
  note?: string;
}

export interface CatalogEntry {
  id: string;
  /** Key in the research pack of 2026-11-04 (COLL-001 …), null for entries outside the pack. */
  researchId: string | null;
  name: string;
  type: InstrumentType;
  /** Official registration / publication number — null where it could not be verified. */
  officialNumber: string | null;
  /** Year of the located document (the document year is not necessarily the legal effective date). */
  publicationYear: number | null;
  industry: string;
  employers: string;
  occupations: string;
  scope: string;
  /** Employee classes the instrument covers / excludes (only where the source states it). */
  coveredClasses?: EmployeeClass[];
  excludedClasses?: EmployeeClass[];
  startDate: LocalDate | null;
  endDate: LocalDate | null;
  /** Amendment and update history, oldest first. */
  history: string[];
  relations: Relation[];
  sourceUrl: string;
  evidence: Evidence;
  sourceNote: string;
  lastVerified: LocalDate;
  verification: Verification;
  profiles: RuleProfileVersion[];
  /** Search keywords (Hebrew / English). */
  keywords: string[];
}

/** Official repositories (opened in the browser from the picker; never scraped). */
export const OFFICIAL_LINKS: { label: string; url: string }[] = [
  { label: 'מאגר צווי ההרחבה — משרד העבודה', url: 'https://www.gov.il/he/Departments/dynamiccollectors/extension-orders' },
  { label: 'אגף יחסי עבודה — משרד העבודה', url: 'https://www.gov.il/he/departments/units/working-relations' },
  { label: 'רישום או ביטול הסכם קיבוצי (טופס שירות — אינו מאגר כללים)', url: 'https://www.gov.il/he/service/registration-or-cancellation-collective-agreement' },
  { label: 'חוק הסכמים קיבוציים — מאגר החקיקה של הכנסת', url: 'https://main.knesset.gov.il/apps/legislation/main/laws/2000459' },
  { label: 'רשומות — העיתון הרשמי', url: 'https://www.gov.il/he/departments/official_gazette/govil-landing-page' },
  { label: 'מחשבון שעות עבודה ענפי (שמירה, ניקיון, הסעדה מוסדית)', url: 'https://www.gov.il/he/service/calculator-work-hour' },
];

const DIRECTORY = 'https://www.gov.il/he/Departments/dynamiccollectors/extension-orders';
const MINISTRY_AGREEMENTS = 'https://www.gov.il/he/departments/units/working-relations';
const PDF = (slug: string) => `https://www.gov.il/BlobFolder/dynamiccollectorresultitem/${slug}/he/${slug}.pdf`;
const PACK = 'אותר בחבילת המחקר מ-04.11.2026';
const NOT_OPENED = 'המסמך לא נפתח בסביבת הבנייה (חסימת רשת); הוראותיו לא חולצו ואינן מקודדות';

/** Entry without encoded rules — reference only. */
function meta(e: Omit<CatalogEntry, 'lastVerified' | 'verification' | 'profiles' | 'relations' | 'history'> & Partial<Pick<CatalogEntry, 'relations' | 'history'>>): CatalogEntry {
  return { relations: [], history: [], ...e, lastVerified: CATALOG_VERIFIED_ON, verification: 'metadata_only', profiles: [] };
}

export const CATALOG: CatalogEntry[] = [
  {
    id: 'eo-short-week-2018',
    researchId: 'COLL-001',
    name: 'צו הרחבה בדבר קיצור שבוע העבודה במשק (42 שעות)',
    type: 'general_extension_order',
    officialNumber: null,
    publicationYear: 2018,
    industry: 'כלל המשק',
    employers: 'כל המעסיקים במשק (צו הרחבה כללי) — לפי תנאי הצו',
    occupations: 'עובדים בגירים; אינו גובר על מגבלת 40 השעות לנוער',
    scope: 'ארצי',
    startDate: '2018-04-01',
    endDate: null,
    history: ['שבוע עבודה של 42 שעות (במקום 43) ללא הפחתת שכר — בתוקף מ-01.04.2018 (לפי מקורות משניים; התאריך לא אומת בנוסח)'],
    relations: [],
    sourceUrl: 'https://www.gov.il/BlobFolder/policy/instructions-regarding-hourly-minimum-wage-in-light-a-shorten-work-week/he/workers-rights_enforcement-and-exercise-of-rights_minimum-wage-enforcement-procedure.pdf',
    evidence: 'official_notice_located',
    sourceNote: `${PACK}: נוהל אכיפה רשמי בעניין שכר מינימום שעתי לאור קיצור שבוע העבודה (אינו נוסח הצו). ${NOT_OPENED}`,
    lastVerified: CATALOG_VERIFIED_ON,
    verification: 'metadata_only',
    profiles: [
      {
        version: '2018.04',
        effectiveFrom: '2018-04-01',
        effectiveTo: null,
        verification: 'secondary',
        covers: ['hours'],
        summary: 'שבוע 42 שעות ויום מקוצר קבוע — מיושם כבר בפרופיל הכללי של Hours-Cal למבוגרים. בחירת הצו אינה משנה את החישוב, ולעולם אינה גוברת על 40 השעות לנוער.',
      },
    ],
    keywords: ['42', 'קיצור שבוע', 'שעות עבודה', 'שבוע עבודה', 'short week', 'שכר מינימום שעתי'],
  },
  {
    id: 'eo-travel',
    researchId: 'COLL-002',
    name: 'צו הרחבה בדבר השתתפות המעביד בהוצאות נסיעה לעבודה וממנה',
    type: 'general_extension_order',
    officialNumber: null,
    publicationYear: 2016,
    industry: 'כלל המשק',
    employers: 'כל המעסיקים במשק',
    occupations: 'עובד הזקוק לתחבורה כדי להגיע למקום עבודתו, לפי ימי עבודה בפועל',
    scope: 'ארצי',
    startDate: null,
    endDate: null,
    history: ['נוסח 2016 באתר משרד העבודה — לפי חבילת המחקר מציין עד 22.60 ₪ ליום, ימי עבודה בפועל ועלות נסיעה; יש לבדוק עדכונים מאוחרים והסכמים מיוחדים'],
    relations: [],
    sourceUrl: PDF('extention-order-travel-expenses-2016'),
    evidence: 'official_text_located',
    sourceNote: `${PACK}. ${NOT_OPENED}. מועד התחולה של התקרה לא אומת`,
    lastVerified: CATALOG_VERIFIED_ON,
    verification: 'metadata_only',
    profiles: [
      {
        version: '2016-pdf',
        effectiveFrom: null,
        effectiveTo: null,
        verification: 'secondary',
        covers: ['travel'],
        travel: {
          dailyCapAgorot: 2260,
          capStatus: 'תקרה של 22.60 ₪ ליום — לפי הנוסח הרשמי שאותר בחבילת המחקר; מועד התחולה ועדכונים מאוחרים לא אומתו',
          note: 'ההחזר הוא עלות הנסיעה בפועל (או הכרטיס הזול יותר) עד התקרה, לכל יום עבודה שבו העובד נזקק לתחבורה. הסכם מיטיב גובר.',
        },
        summary: 'בדיקת סבירות להחזר הנסיעות שהוגדר לעובד: התקרה מוצגת לעיון ואינה משנה סכומים.',
      },
    ],
    keywords: ['נסיעות', 'החזר נסיעות', 'תחבורה', 'travel', '22.60'],
  },
  meta({
    id: 'eo-cleaning',
    researchId: 'COLL-003',
    name: 'צו הרחבה בענף הניקיון (2014)',
    type: 'industry_extension_order',
    officialNumber: null,
    publicationYear: 2014,
    industry: 'ניקיון ואחזקה',
    employers: 'חברות ניקיון ואחזקה (קבלני שירות) — לפי הגדרות הצו',
    occupations: 'עובדי ניקיון של חברות הניקיון',
    scope: 'ארצי',
    coveredClasses: ['contractor_worker'],
    excludedClasses: ['client_employee'],
    startDate: null,
    endDate: null,
    history: ['צו יסוד 2014', 'עדכון שכר מינימום ענפי מ-01.2026 רשום במאגר (COLL-016) — הסכום לא חולץ'],
    relations: [{ kind: 'wage_update', id: 'coll-016' }],
    sourceUrl: PDF('extension-order-cleaning-2014'),
    evidence: 'official_text_located',
    sourceNote: `${PACK}. חל על עובדי חברות ניקיון — לא על עובד משרד של עסק שמעסיק קבלן ניקיון. ${NOT_OPENED}`,
    keywords: ['ניקיון', 'קבלן ניקיון', 'אחזקה', 'cleaning'],
  }),
  meta({
    id: 'eo-security',
    researchId: 'COLL-004',
    name: 'צו הרחבה בענף השמירה והאבטחה (חוזר 2022)',
    type: 'industry_extension_order',
    officialNumber: null,
    publicationYear: 2022,
    industry: 'שמירה ואבטחה',
    employers: 'חברות שמירה ואבטחה — לפי הגדרות הצו',
    occupations: 'מאבטחים ושומרים',
    scope: 'ארצי',
    coveredClasses: ['contractor_worker'],
    excludedClasses: ['client_employee'],
    startDate: null,
    endDate: null,
    history: ['חוזר משרד האוצר 2022 — תוספות שכר לפי הכשרה ומנוחה שבועית', 'עדכון שכר מינימום ענפי מ-04.2026 רשום במאגר (COLL-017) — אין להשתמש בערכים ישנים'],
    relations: [{ kind: 'wage_update', id: 'coll-017' }],
    sourceUrl: 'https://www.gov.il/BlobFolder/dynamiccollectorresultitem/guidelines-constractor-workers-04092022/he/ag-guidelines-constractor-workers_guidelines-constractor-workers-04092022.pdf',
    evidence: 'official_circular_located',
    sourceNote: `${PACK}: חוזר רשמי של משרד האוצר (אינו נוסח הצו). ${NOT_OPENED}`,
    keywords: ['שמירה', 'אבטחה', 'מאבטח', 'security', 'guard'],
  }),
  meta({
    id: 'eo-construction',
    researchId: 'COLL-005',
    name: 'צו הרחבה בענף הבנייה, התשתיות, הצמ״ה, העבודות הציבוריות והשיפוצים (2015)',
    type: 'industry_extension_order',
    officialNumber: null,
    publicationYear: 2015,
    industry: 'בנייה, תשתיות, צמ״ה, עבודות ציבוריות ושיפוצים',
    employers: 'מעסיקים בענף — לפי הגדרות הצו',
    occupations: 'עובדי אתר שאינם עובדי משרד, כולל מנהלי עבודה באתר',
    scope: 'ארצי',
    coveredClasses: ['site_worker'],
    excludedClasses: ['office_staff'],
    startDate: null,
    endDate: null,
    history: ['צו 2015 — ההגדרה כוללת עובדי אתר ומנהלי אתר שאינם עובדי משרד', 'צו/תיקון 2025 רשום במאגר (COLL-018) — אין להחיל את צו 2015 בלי לקרוא את נוסח 2025'],
    relations: [{ kind: 'amended_by', id: 'coll-018' }],
    sourceUrl: PDF('extension-order-construction-2015'),
    evidence: 'official_text_located',
    sourceNote: `${PACK}. ${NOT_OPENED}`,
    keywords: ['בנייה', 'בניין', 'תשתיות', 'שיפוצים', 'צמה', 'construction'],
  }),
  meta({
    id: 'coll-006',
    researchId: 'COLL-006',
    name: 'צו הרחבה בענף שירותי ההסעדה המוסדית (2025)',
    type: 'industry_extension_order',
    officialNumber: null,
    publicationYear: 2025,
    industry: 'הסעדה מוסדית',
    employers: 'חברות הסעדה מוסדית — לא כל מסעדה; לפי הגדרות הצו',
    occupations: 'לפי הגדרות העובד בצו',
    scope: 'ארצי',
    startDate: null,
    endDate: null,
    sourceUrl: 'https://www.gov.il/BlobFolder/dynamiccollectorresultitem/extension-order-restaurant/he/workers-rights_work-relations_extension-order-restaurant.pdf',
    evidence: 'official_gazette_located',
    sourceNote: `${PACK} (פרסום ברשומות). ${NOT_OPENED}`,
    keywords: ['הסעדה', 'הסעדה מוסדית', 'קייטרינג', 'מטבח', 'catering'],
  }),
  meta({
    id: 'coll-007',
    researchId: 'COLL-007',
    name: 'צו הרחבה בענף המלונאות (1995)',
    type: 'industry_extension_order',
    officialNumber: null,
    publicationYear: 1995,
    industry: 'מלונאות ואירוח',
    employers: 'בתי מלון, בתי הארחה ומשרדים ראשיים של רשתות כמוגדר בצו',
    occupations: 'לפי הגדרות הצו',
    scope: 'ארצי',
    startDate: null,
    endDate: null,
    history: ['צו בסיס היסטורי 1995 — ייתכנו תיקונים מאוחרים שלא אותרו'],
    sourceUrl: PDF('extension-order-hotels-1995'),
    evidence: 'official_text_located',
    sourceNote: `${PACK}. ${NOT_OPENED}`,
    keywords: ['מלון', 'מלונאות', 'אירוח', 'בית הארחה', 'hotel'],
  }),
  meta({
    id: 'coll-008',
    researchId: 'COLL-008',
    name: 'צו הרחבה בענף אולמות וגני האירועים (2008)',
    type: 'industry_extension_order',
    officialNumber: null,
    publicationYear: 2008,
    industry: 'אולמות וגני אירועים',
    employers: 'אולמות וגני אירועים המכוסים בצו — לא כל קייטרינג או עבודת אירועים',
    occupations: 'לפי הגדרות הצו',
    scope: 'ארצי',
    startDate: null,
    endDate: null,
    sourceUrl: PDF('extension-order-halls-2008'),
    evidence: 'official_text_located',
    sourceNote: `${PACK}. ${NOT_OPENED}`,
    keywords: ['אולמות', 'גני אירועים', 'אירועים', 'events'],
  }),
  meta({
    id: 'coll-009',
    researchId: 'COLL-009',
    name: 'צו הרחבה בענף רשתות שיווק המזון (2010)',
    type: 'industry_extension_order',
    officialNumber: null,
    publicationYear: 2010,
    industry: 'רשתות שיווק מזון',
    employers: 'רשת של 2 חנויות לפחות או חנות מעל 500 מ״ר, בתנאים ובהחרגות שבצו',
    occupations: 'לפי הגדרות הצו',
    scope: 'ארצי',
    startDate: null,
    endDate: null,
    sourceUrl: PDF('extension-order-food-marketing-2010'),
    evidence: 'official_text_located',
    sourceNote: `${PACK}. ${NOT_OPENED}`,
    keywords: ['סופרמרקט', 'רשת מזון', 'שיווק מזון', 'קמעונאות', 'food retail'],
  }),
  meta({
    id: 'coll-010',
    researchId: 'COLL-010',
    name: 'צו הרחבה בענף ההובלה (1989)',
    type: 'industry_extension_order',
    officialNumber: null,
    publicationYear: 1989,
    industry: 'הובלה',
    employers: 'לפי הגדרות הצו',
    occupations: 'לפי הגדרות הצו',
    scope: 'ארצי',
    startDate: null,
    endDate: null,
    history: ['צו היסטורי — שינויים מאוחרים רבים'],
    relations: [
      { kind: 'amended_by', id: 'coll-011', note: 'קשר לא אומת' },
      { kind: 'amended_by', id: 'coll-012', note: 'קשר לא אומת' },
    ],
    sourceUrl: PDF('extension-order-transport-1989'),
    evidence: 'official_text_located',
    sourceNote: `${PACK}. ${NOT_OPENED}`,
    keywords: ['הובלה', 'נהגים', 'תובלה', 'transport'],
  }),
  meta({
    id: 'coll-011',
    researchId: 'COLL-011',
    name: 'צו הרחבה בענף ההובלה (2007)',
    type: 'industry_extension_order',
    officialNumber: null,
    publicationYear: 2007,
    industry: 'הובלה',
    employers: 'לפי הגדרות הצו',
    occupations: 'עובדי הובלה — כולל החרגות לסוגי נהגי משא כבד',
    scope: 'ארצי',
    startDate: null,
    endDate: null,
    sourceUrl: PDF('extension-order-transport-2007'),
    evidence: 'official_text_located',
    sourceNote: `${PACK}. ${NOT_OPENED}`,
    keywords: ['הובלה', 'נהגים', 'transport'],
  }),
  meta({
    id: 'coll-012',
    researchId: 'COLL-012',
    name: 'צו הרחבה בענף ההובלה — משא כבד (2008)',
    type: 'industry_extension_order',
    officialNumber: null,
    publicationYear: 2008,
    industry: 'הובלת משא כבד',
    employers: 'לפי הגדרות הצו',
    occupations: 'נהגי משאיות המובילות מטען מעל 4 טון — לא כל הנהגים',
    scope: 'ארצי',
    startDate: null,
    endDate: null,
    sourceUrl: PDF('extension-order-transport-2008'),
    evidence: 'official_text_located',
    sourceNote: `${PACK}. ${NOT_OPENED}`,
    keywords: ['הובלה', 'משא כבד', 'משאית', 'נהגים', 'truck'],
  }),
  meta({
    id: 'coll-013',
    researchId: 'COLL-013',
    name: 'צו הרחבה בענף המתכת ומוצרי החשמל — נוער (1975)',
    type: 'industry_extension_order',
    officialNumber: null,
    publicationYear: 1975,
    industry: 'מתכת ומוצרי חשמל',
    employers: 'לפי הגדרות הצו',
    occupations: 'נוער עובד בענף',
    scope: 'ארצי',
    startDate: null,
    endDate: null,
    history: ['מסמך היסטורי — יש לבדוק תחולה וגרסאות מאוחרות'],
    sourceUrl: PDF('extension-order-metal-electricity-youth-1975'),
    evidence: 'official_text_located',
    sourceNote: `${PACK}. ${NOT_OPENED}`,
    keywords: ['מתכת', 'חשמל', 'נוער', 'metal'],
  }),
  meta({
    id: 'coll-014',
    researchId: 'COLL-014',
    name: 'צווי הרחבה לעובדים סוציאליים המועסקים לפי התקשרויות המדינה (2025)',
    type: 'industry_extension_order',
    officialNumber: null,
    publicationYear: 2025,
    industry: 'רווחה — עובדים סוציאליים',
    employers: 'מעסיקים בהתקשרויות עם המדינה — לא כל עובד סוציאלי',
    occupations: 'עובדים סוציאליים לפי תנאי ההתקשרות',
    scope: 'ארצי',
    startDate: null,
    endDate: null,
    sourceUrl: DIRECTORY,
    evidence: 'directory_only',
    sourceNote: `${PACK}: רשום במאגר בלבד; הנוסח לא חולץ`,
    keywords: ['עובד סוציאלי', 'עובדים סוציאליים', 'רווחה', 'social worker'],
  }),
  meta({
    id: 'coll-015',
    researchId: 'COLL-015',
    name: 'צו הרחבה בעניין משרתי מילואים ובני זוגם וצבירת חופשה (2026)',
    type: 'temporary_general_extension_order',
    officialNumber: null,
    publicationYear: 2026,
    industry: 'כלל המשק',
    employers: 'לפי הצו',
    occupations: 'משרתי מילואים ובני זוגם — לפי הגדרות הצו',
    scope: 'ארצי (זמני)',
    startDate: null,
    endDate: null,
    sourceUrl: DIRECTORY,
    evidence: 'directory_only',
    sourceNote: `${PACK}: הוראות חירום/זמניות — יש לבדוק פרסום, זכאים ותקופת תוקף; הנוסח לא חולץ`,
    keywords: ['מילואים', 'בני זוג', 'צבירת חופשה', 'reserve'],
  }),
  meta({
    id: 'coll-016',
    researchId: 'COLL-016',
    name: 'עדכון שכר מינימום ענפי לעובדי ניקיון (2026)',
    type: 'sector_minimum_wage_notice',
    officialNumber: null,
    publicationYear: 2026,
    industry: 'ניקיון ואחזקה',
    employers: 'חברות ניקיון — לפי צו הענף',
    occupations: 'עובדי ניקיון',
    scope: 'ארצי',
    startDate: '2026-01-01',
    endDate: null,
    history: ['לפי המאגר: עדכון מינואר 2026 — הסכום לא חולץ ואינו מקודד'],
    relations: [{ kind: 'updates', id: 'eo-cleaning' }],
    sourceUrl: DIRECTORY,
    evidence: 'directory_only',
    sourceNote: `${PACK}: רשום במאגר בלבד; אין להמציא סכומים ואין להשתמש בתעריפים ישנים`,
    keywords: ['ניקיון', 'שכר מינימום ענפי', '2026', 'cleaning wage'],
  }),
  meta({
    id: 'coll-017',
    researchId: 'COLL-017',
    name: 'עדכון שכר מינימום ענפי לעובדי שמירה ואבטחה (2026)',
    type: 'sector_minimum_wage_notice',
    officialNumber: null,
    publicationYear: 2026,
    industry: 'שמירה ואבטחה',
    employers: 'חברות שמירה — לפי צו הענף',
    occupations: 'מאבטחים ושומרים',
    scope: 'ארצי',
    startDate: '2026-04-01',
    endDate: null,
    history: ['לפי המאגר: עדכון מאפריל 2026 — הסכום לא חולץ ואינו מקודד'],
    relations: [{ kind: 'updates', id: 'eo-security' }],
    sourceUrl: DIRECTORY,
    evidence: 'directory_only',
    sourceNote: `${PACK}: רשום במאגר בלבד; אין להמציא סכומים ואין להשתמש בתעריפים ישנים`,
    keywords: ['שמירה', 'אבטחה', 'שכר מינימום ענפי', '2026', 'security wage'],
  }),
  meta({
    id: 'coll-018',
    researchId: 'COLL-018',
    name: 'צו הרחבה בענף הבנייה, התשתיות, הצמ״ה, העבודות הציבוריות והשיפוצים (2025)',
    type: 'industry_extension_order',
    officialNumber: null,
    publicationYear: 2025,
    industry: 'בנייה, תשתיות, צמ״ה, עבודות ציבוריות ושיפוצים',
    employers: 'מעסיקים בענף — לפי הגדרות הצו',
    occupations: 'עובדי אתר — לפי הגדרות הצו',
    scope: 'ארצי',
    coveredClasses: ['site_worker'],
    excludedClasses: ['office_staff'],
    startDate: null,
    endDate: null,
    history: ['צו 2025 רשום במאגר — יש לבדוק את השפעתו על צו 2015'],
    relations: [{ kind: 'amends', id: 'eo-construction' }],
    sourceUrl: DIRECTORY,
    evidence: 'directory_only',
    sourceNote: `${PACK}: רשום במאגר בלבד; הנוסח לא חולץ`,
    keywords: ['בנייה', 'בניין', 'תשתיות', '2025', 'construction'],
  }),
  // ---- Entries kept from 1.1.9 that the research pack does not cover (unapproved secondary sources) ----
  {
    id: 'eo-recuperation',
    researchId: null,
    name: 'צו הרחבה בדבר השתתפות בהוצאות הבראה (דמי הבראה)',
    type: 'general_extension_order',
    officialNumber: null,
    publicationYear: null,
    industry: 'כלל המשק (מגזר פרטי)',
    employers: 'כל המעסיקים במגזר הפרטי',
    occupations: 'עובד שהשלים שנת עבודה אחת לפחות',
    scope: 'ארצי',
    startDate: null,
    endDate: null,
    history: ['תעריף יום הבראה 418 ₪ (עד שנת ההבראה 2025) — מקורות משניים', 'לפי מקורות משניים: צו לשנת 2026 (פורסם 18.08.2026) — 451.50 ₪ ליום לשנת ההבראה 1.7.2025–30.6.2026'],
    relations: [],
    sourceUrl: DIRECTORY,
    evidence: 'unapproved_secondary',
    sourceNote: 'אינו נכלל בחבילת המחקר; הנתונים ממקורות משניים שאינם רשמיים. "סעיפי צו ההבראה טרם סופקו כחוקים מאומתים" — מידע בלבד עד אימות סעיף',
    lastVerified: CATALOG_VERIFIED_ON,
    verification: 'metadata_only',
    profiles: [
      {
        version: '2026',
        effectiveFrom: '2025-07-01',
        effectiveTo: null,
        verification: 'secondary',
        covers: ['recuperation'],
        recuperation: [
          {
            yearFrom: '2025-07-01',
            yearTo: '2026-06-30',
            dayValueAgorot: 45150,
            daysBySeniority: [
              [1, 5],
              [2, 6],
              [4, 7],
              [11, 8],
              [16, 9],
              [20, 10],
            ],
            afterFirstYear: true,
            note: 'שנה ראשונה: 5 ימים; 2–3: 6; 4–10: 7; 11–15: 8; 16–19: 9; 20 ומעלה: 10. במשרה חלקית — לפי חלקיות המשרה (מקורות משניים).',
          },
        ],
        summary: 'עזר לחישוב דמי הבראה — מופעל רק לאחר אימות הסעיף מול הנוסח הרשמי; עד אז מוצגים הנתונים לעיון בלבד.',
      },
    ],
    keywords: ['הבראה', 'דמי הבראה', 'recuperation', 'havraa', '451.50'],
  },
  meta({
    id: 'eo-holidays-framework-2000',
    researchId: null,
    name: 'צו הרחבה להסכם המסגרת (2000) — דמי חגים',
    type: 'general_extension_order',
    officialNumber: null,
    publicationYear: 2000,
    industry: 'כלל המשק',
    employers: 'כל המעסיקים במשק',
    occupations: 'עובד שעתי/יומי לאחר 3 חודשי עבודה',
    scope: 'ארצי',
    startDate: null,
    endDate: null,
    history: ['תנאי זכאות לעובד שעתי/יומי (מקורות משניים): ותק 3 חודשים, חג שאינו חל בשבת, ללא היעדרות סמוך לחג שלא בהסכמה — מיושמים כהערכה בחישוב החגים (1.1.7)'],
    sourceUrl: DIRECTORY,
    evidence: 'unapproved_secondary',
    sourceNote: 'אינו נכלל בחבילת המחקר; מקורות משניים בלבד',
    keywords: ['חגים', 'דמי חגים', 'הסכם מסגרת', 'holiday'],
  }),
  meta({
    id: 'eo-pension',
    researchId: null,
    name: 'צו הרחבה לביטוח פנסיוני מקיף במשק',
    type: 'general_extension_order',
    officialNumber: null,
    publicationYear: 2008,
    industry: 'כלל המשק',
    employers: 'כל המעסיקים במשק',
    occupations: 'כל העובדים לפי תנאי הצו',
    scope: 'ארצי',
    startDate: null,
    endDate: null,
    sourceUrl: DIRECTORY,
    evidence: 'unapproved_secondary',
    sourceNote: 'אינו נכלל בחבילת המחקר; Hours-Cal אינה מחשבת הפרשות פנסיוניות',
    keywords: ['פנסיה', 'ביטוח פנסיוני', 'pension'],
  }),
];

/** An instrument the user knows applies but which is not in the catalog (reference only, never executable). */
export const UNLISTED_ID = 'unlisted';
export const UNLISTED_ENTRY: CatalogEntry = meta({
  id: UNLISTED_ID,
  researchId: null,
  name: 'הסכם או צו שאינו ברשימה — לבדיקה ידנית',
  type: 'special_collective_agreement',
  officialNumber: null,
  publicationYear: null,
  industry: '—',
  employers: '—',
  occupations: '—',
  scope: '—',
  startDate: null,
  endDate: null,
  sourceUrl: MINISTRY_AGREEMENTS,
  evidence: 'directory_only',
  sourceNote: 'הוזן ידנית — הוראותיו אינן מקודדות ולא ישפיעו על החישוב',
  keywords: [],
});

export function catalogEntry(id: string): CatalogEntry | null {
  return id === UNLISTED_ID ? UNLISTED_ENTRY : (CATALOG.find((e) => e.id === id) ?? null);
}

/** Catalog-level status (before any employee selection). */
export type CatalogStatus = 'reference_only' | 'no_full_source';
export const CATALOG_STATUS_LABELS: Record<CatalogStatus, string> = { reference_only: 'אסמכתה בלבד', no_full_source: 'אין מקור מלא' };
export function catalogStatus(e: CatalogEntry): CatalogStatus {
  return e.evidence === 'directory_only' || e.evidence === 'unapproved_secondary' ? 'no_full_source' : 'reference_only';
}
/** The instrument has a later amendment, replacement or wage update in the catalog. */
export function isAmended(e: CatalogEntry): boolean {
  return e.relations.some((r) => r.kind === 'amended_by' || r.kind === 'wage_update');
}

/** Short search terms per employee class (the display labels mention example industries and would over-match). */
const CLASS_SEARCH: Record<EmployeeClass, string> = { site_worker: 'עובדי אתר שטח', office_staff: 'עובדי משרד מטה', contractor_worker: 'עובדי קבלן', client_employee: 'עובדי לקוח', other: '' };

const norm = (s: string) => s.toLowerCase().replace(/["'׳״.,\-()/]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Offline search by title, industry, year, registration number, source, covered worker class, research key or keyword.
 * All words must match. An optional family filter keeps extension orders, agreements and wage notices apart.
 */
export function searchCatalog(query: string, family: InstrumentFamily | 'all' = 'all'): CatalogEntry[] {
  const words = norm(query).split(' ').filter(Boolean);
  const pool = family === 'all' ? CATALOG : CATALOG.filter((e) => FAMILY_OF[e.type] === family);
  if (!words.length) return [...pool];
  return pool.filter((e) => {
    const hay = norm(
      [
        e.name,
        e.industry,
        e.officialNumber ?? '',
        e.occupations,
        e.employers,
        INSTRUMENT_TYPE_LABELS[e.type],
        FAMILY_LABELS[FAMILY_OF[e.type]],
        e.publicationYear ? String(e.publicationYear) : '',
        e.researchId ?? '',
        e.sourceUrl,
        EVIDENCE_LABELS[e.evidence],
        ...(e.coveredClasses ?? []).map((c) => CLASS_SEARCH[c]),
        ...e.keywords,
      ].join(' '),
    );
    return words.every((w) => hay.includes(w));
  });
}

/** The profile version in force on a date (a profile without a verified effective date is shown for every date). */
export function profileOn(entry: CatalogEntry, date: LocalDate): RuleProfileVersion | null {
  return entry.profiles.find((p) => (p.effectiveFrom === null || date >= p.effectiveFrom) && (p.effectiveTo === null || date <= p.effectiveTo)) ?? null;
}
