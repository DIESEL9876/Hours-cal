/**
 * Local, offline catalog of Israeli collective agreements and extension orders (1.1.9).
 *
 * Coverage is deliberately limited to instruments whose existence and key terms could be cross-checked. The primary
 * registries (gov.il collective-agreement registry, extension-order collector, Knesset/Reshumot) were NOT reachable
 * from the build environment; entries therefore carry `verification: 'secondary'` (confirmed by several secondary
 * sources) or `'metadata_only'` (existence known, terms not encoded). No entry is marked 'primary'.
 *
 * Rule profiles are VERSIONED with effective dates. An executable rule is used only after (1) the employee-level
 * applicability confirmation and (2) a professional verification of the profile (see rules.ts) — a secondary-source
 * profile never silently changes hours or pay.
 *
 * The catalog can be refreshed only by an application update (no live scraping during payroll).
 */
import type { LocalDate } from '../engine';

export const CATALOG_VERSION = '2026.11.03';
export const CATALOG_VERIFIED_ON: LocalDate = '2026-11-03';

export type InstrumentType = 'statute' | 'general_extension_order' | 'industry_extension_order' | 'general_collective_agreement' | 'special_collective_agreement';

export const INSTRUMENT_TYPE_LABELS: Record<InstrumentType, string> = {
  statute: 'חוק',
  general_extension_order: 'צו הרחבה כללי',
  industry_extension_order: 'צו הרחבה ענפי',
  general_collective_agreement: 'הסכם קיבוצי כללי',
  special_collective_agreement: 'הסכם קיבוצי מיוחד',
};

/** Precedence layer (higher overrides lower only where more favourable and lawful — see rules.ts). */
export const PRECEDENCE: Record<InstrumentType, number> = {
  statute: 0,
  general_extension_order: 1,
  industry_extension_order: 2,
  general_collective_agreement: 3,
  special_collective_agreement: 4,
};

export type Verification = 'primary' | 'secondary' | 'metadata_only';

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
  effectiveFrom: LocalDate;
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

export interface CatalogEntry {
  id: string;
  name: string;
  type: InstrumentType;
  /** Official registration / publication number — null where it could not be verified. */
  officialNumber: string | null;
  industry: string;
  employers: string;
  occupations: string;
  scope: string;
  startDate: LocalDate | null;
  endDate: LocalDate | null;
  history: string[];
  sourceUrl: string;
  sourceNote: string;
  lastVerified: LocalDate;
  verification: Verification;
  profiles: RuleProfileVersion[];
  /** Search keywords (Hebrew / English). */
  keywords: string[];
}

const MINISTRY_ORDERS = 'https://www.gov.il/he/departments/dynamiccollectors/extension-orders';
const MINISTRY_AGREEMENTS = 'https://www.gov.il/he/departments/units/working-relations';

export const CATALOG: CatalogEntry[] = [
  {
    id: 'eo-short-week-2018',
    name: 'צו הרחבה בדבר קיצור שבוע העבודה במשק',
    type: 'general_extension_order',
    officialNumber: null,
    industry: 'כלל המשק',
    employers: 'כל המעסיקים במשק (צו הרחבה כללי)',
    occupations: 'כל העובדים',
    scope: 'ארצי',
    startDate: '2018-04-01',
    endDate: null,
    history: ['נחתם 15.03.2018; בתוקף מ-01.04.2018 — שבוע עבודה של 42 שעות (במקום 43) ללא הפחתת שכר'],
    sourceUrl: MINISTRY_ORDERS,
    sourceNote: 'אומת במקורות משניים (כל זכות, משרדי עורכי דין); הנוסח הרשמי לא היה נגיש בעת הבנייה',
    lastVerified: CATALOG_VERIFIED_ON,
    verification: 'secondary',
    profiles: [
      {
        version: '2018.04',
        effectiveFrom: '2018-04-01',
        effectiveTo: null,
        verification: 'secondary',
        covers: ['hours'],
        summary: 'שבוע 42 שעות ויום מקוצר קבוע — מיושם כבר בפרופיל הכללי של Hours-Cal (תקן 8:36/7:36 ומדיניות המשרד 8:24). בחירת הצו אינה משנה את החישוב.',
      },
    ],
    keywords: ['42', 'קיצור שבוע', 'שעות עבודה', 'שבוע עבודה', 'short week'],
  },
  {
    id: 'eo-travel',
    name: 'צו הרחבה בדבר השתתפות המעביד בהוצאות נסיעה לעבודה וממנה',
    type: 'general_extension_order',
    officialNumber: null,
    industry: 'כלל המשק',
    employers: 'כל המעסיקים במשק',
    occupations: 'עובד הזקוק לתחבורה כדי להגיע למקום עבודתו',
    scope: 'ארצי',
    startDate: null,
    endDate: null,
    history: ['הנוסח המפורסם באתר משרד העבודה: extention-order-travel-expenses-2016', 'תקרה יומית מתעדכנת — ערך 2026 לפי מקורות משניים: 22.60 ₪ (במקור משני אחד ערך ישן של 25.20 ₪)'],
    sourceUrl: 'https://www.gov.il/BlobFolder/dynamiccollectorresultitem/extention-order-travel-expenses-2016/he/extention-order-travel-expenses-2016.pdf',
    sourceNote: 'הנוסח הרשמי לא היה נגיש בעת הבנייה; התקרה אומתה במקורות משניים בלבד ומועד תחולתה המדויק לא אומת',
    lastVerified: CATALOG_VERIFIED_ON,
    verification: 'secondary',
    profiles: [
      {
        version: '2026',
        effectiveFrom: '2026-01-01',
        effectiveTo: null,
        verification: 'secondary',
        covers: ['travel'],
        travel: {
          dailyCapAgorot: 2260,
          capStatus: 'תקרה של 22.60 ₪ ליום לפי מקורות משניים (2026); מועד התחולה והנוסח הרשמי לא אומתו',
          note: 'ההחזר הוא עלות הנסיעה בתחבורה ציבורית בפועל (או הכרטיס החודשי הזול יותר) עד התקרה, לכל יום עבודה שבו העובד נזקק לתחבורה. הסכם מיטיב גובר.',
        },
        summary: 'בדיקת סבירות להחזר הנסיעות שהוגדר לעובד: התקרה מוצגת לבדיקה ואינה משנה סכומים.',
      },
    ],
    keywords: ['נסיעות', 'החזר נסיעות', 'תחבורה', 'travel', '22.60'],
  },
  {
    id: 'eo-recuperation',
    name: 'צו הרחבה בדבר השתתפות בהוצאות הבראה (דמי הבראה)',
    type: 'general_extension_order',
    officialNumber: null,
    industry: 'כלל המשק (מגזר פרטי)',
    employers: 'כל המעסיקים במגזר הפרטי',
    occupations: 'עובד שהשלים שנת עבודה אחת לפחות',
    scope: 'ארצי',
    startDate: null,
    endDate: null,
    history: ['תעריף יום הבראה 418 ₪ (עד שנת ההבראה 2025)', 'צו הרחבה לשנת 2026 פורסם ב-18.08.2026: 451.50 ₪ ליום לשנת ההבראה 2026 (1.7.2025–30.6.2026), כולל השלמת הפרש למי ששולם לו לפי 418 ₪'],
    sourceUrl: MINISTRY_ORDERS,
    sourceNote: 'אומת במקורות משניים (חשבים, המכללה למיסים, משרדי עורכי דין); נוסח הצו ברשומות לא היה נגיש',
    lastVerified: CATALOG_VERIFIED_ON,
    verification: 'secondary',
    profiles: [
      {
        version: '2026',
        effectiveFrom: '2025-07-01',
        effectiveTo: null, // the order is open-ended; only the day rate is updated yearly (see rules.ts fallback review)
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
            note: 'שנה ראשונה: 5 ימים; 2–3: 6; 4–10: 7; 11–15: 8; 16–19: 9; 20 ומעלה: 10. במשרה חלקית — לפי חלקיות המשרה.',
          },
        ],
        summary: 'עזר לחישוב דמי הבראה (ימים לפי ותק × תעריף × חלקיות משרה). מוצג כהצעה בלבד; הסכום נרשם ידנית.',
      },
    ],
    keywords: ['הבראה', 'דמי הבראה', 'recuperation', 'havraa', '451.50'],
  },
  {
    id: 'eo-holidays-framework-2000',
    name: 'צו הרחבה להסכם המסגרת (2000) — דמי חגים',
    type: 'general_extension_order',
    officialNumber: null,
    industry: 'כלל המשק',
    employers: 'כל המעסיקים במשק',
    occupations: 'עובד שעתי/יומי לאחר 3 חודשי עבודה',
    scope: 'ארצי',
    startDate: '2000-01-01',
    endDate: null,
    history: ['תנאי זכאות לעובד שעתי/יומי: ותק 3 חודשים, חג שאינו חל בשבת (ובשבוע של 5 ימים — גם לא בשישי), ללא היעדרות סמוך לחג שלא בהסכמה'],
    sourceUrl: MINISTRY_ORDERS,
    sourceNote: 'אומת במקורות משניים; מיושם בפרופיל "לפי צו ההרחבה" של דמי החגים (גרסה 1.1.7)',
    lastVerified: CATALOG_VERIFIED_ON,
    verification: 'secondary',
    profiles: [
      {
        version: '2000',
        effectiveFrom: '2000-01-01',
        effectiveTo: null,
        verification: 'secondary',
        covers: ['holidays'],
        summary: 'תנאי הזכאות כבר מיושמים בחישוב החגים הקיים (סטטוס "הערכה" לעובד שעתי/יומי). שיעור התשלום הכספי אינו מחושב.',
      },
    ],
    keywords: ['חגים', 'דמי חגים', 'הסכם מסגרת', 'holiday'],
  },
  {
    id: 'eo-pension',
    name: 'צו הרחבה לביטוח פנסיוני מקיף במשק',
    type: 'general_extension_order',
    officialNumber: null,
    industry: 'כלל המשק',
    employers: 'כל המעסיקים במשק',
    occupations: 'כל העובדים לפי תנאי הצו',
    scope: 'ארצי',
    startDate: '2008-01-01',
    endDate: null,
    history: ['בתוקף משנת 2008 ועודכן מאז (שיעורי הפקדה)'],
    sourceUrl: MINISTRY_ORDERS,
    sourceNote: 'קיום הצו אומת במקורות משניים; Hours-Cal אינה מחשבת הפרשות פנסיוניות',
    lastVerified: CATALOG_VERIFIED_ON,
    verification: 'metadata_only',
    profiles: [],
    keywords: ['פנסיה', 'ביטוח פנסיוני', 'pension'],
  },
  {
    id: 'eo-cleaning',
    name: 'צו הרחבה בענף הניקיון',
    type: 'industry_extension_order',
    officialNumber: null,
    industry: 'ניקיון',
    employers: 'קבלני שירותי ניקיון (לפי תנאי הצו)',
    occupations: 'עובדי ניקיון',
    scope: 'ארצי',
    startDate: '2014-01-01',
    endDate: null,
    history: ['צו הרחבה ענפי משנת 2014 (לפי מקורות משניים); עדכונים מאוחרים לא אומתו'],
    sourceUrl: MINISTRY_ORDERS,
    sourceNote: 'קיום הצו אומת במקורות משניים בלבד; השם המדויק, המספר והוראות הצו לא אומתו',
    lastVerified: CATALOG_VERIFIED_ON,
    verification: 'metadata_only',
    profiles: [],
    keywords: ['ניקיון', 'קבלן ניקיון', 'cleaning'],
  },
  {
    id: 'eo-security',
    name: 'צו הרחבה בענף השמירה והאבטחה',
    type: 'industry_extension_order',
    officialNumber: null,
    industry: 'שמירה ואבטחה',
    employers: 'חברות שמירה ואבטחה (לפי תנאי הצו)',
    occupations: 'מאבטחים ושומרים',
    scope: 'ארצי',
    startDate: '2014-01-01',
    endDate: null,
    history: ['צו הרחבה ענפי משנת 2014 (לפי מקורות משניים); עדכונים מאוחרים לא אומתו'],
    sourceUrl: MINISTRY_ORDERS,
    sourceNote: 'קיום הצו אומת במקורות משניים בלבד; השם המדויק, המספר והוראות הצו לא אומתו',
    lastVerified: CATALOG_VERIFIED_ON,
    verification: 'metadata_only',
    profiles: [],
    keywords: ['שמירה', 'אבטחה', 'מאבטח', 'security', 'guard'],
  },
  {
    id: 'eo-construction',
    name: 'צו הרחבה בענף הבנייה',
    type: 'industry_extension_order',
    officialNumber: null,
    industry: 'בנייה ותשתיות',
    employers: 'מעסיקים בענף הבנייה (לפי תנאי הצו)',
    occupations: 'עובדי בניין',
    scope: 'ארצי',
    startDate: null,
    endDate: null,
    history: ['צו הרחבה ענפי (לפי מקורות משניים); תאריכים ועדכונים לא אומתו'],
    sourceUrl: MINISTRY_ORDERS,
    sourceNote: 'קיום הצו אומת במקורות משניים בלבד; השם המדויק, המספר והוראות הצו לא אומתו',
    lastVerified: CATALOG_VERIFIED_ON,
    verification: 'metadata_only',
    profiles: [],
    keywords: ['בנייה', 'בניין', 'תשתיות', 'construction'],
  },
];

/** An agreement the user knows applies but which is not in the catalog (reference only, never executable). */
export const UNLISTED_ID = 'unlisted';
export const UNLISTED_ENTRY: CatalogEntry = {
  id: UNLISTED_ID,
  name: 'הסכם שאינו ברשימה — לבדיקה ידנית',
  type: 'special_collective_agreement',
  officialNumber: null,
  industry: '—',
  employers: '—',
  occupations: '—',
  scope: '—',
  startDate: null,
  endDate: null,
  history: [],
  sourceUrl: MINISTRY_AGREEMENTS,
  sourceNote: 'הסכם שהוזן ידנית — הוראותיו אינן מקודדות ולא ישפיעו על החישוב',
  lastVerified: CATALOG_VERIFIED_ON,
  verification: 'metadata_only',
  profiles: [],
  keywords: [],
};

export function catalogEntry(id: string): CatalogEntry | null {
  return id === UNLISTED_ID ? UNLISTED_ENTRY : (CATALOG.find((e) => e.id === id) ?? null);
}

const norm = (s: string) => s.toLowerCase().replace(/["'׳״.,\-()]/g, ' ').replace(/\s+/g, ' ').trim();

/** Offline search by name, industry, official number or keyword. All words must match. */
export function searchCatalog(query: string): CatalogEntry[] {
  const words = norm(query).split(' ').filter(Boolean);
  if (!words.length) return [...CATALOG];
  return CATALOG.filter((e) => {
    const hay = norm([e.name, e.industry, e.officialNumber ?? '', e.occupations, INSTRUMENT_TYPE_LABELS[e.type], ...e.keywords].join(' '));
    return words.every((w) => hay.includes(w));
  });
}

/** The profile version in force on a date. */
export function profileOn(entry: CatalogEntry, date: LocalDate): RuleProfileVersion | null {
  return entry.profiles.find((p) => date >= p.effectiveFrom && (p.effectiveTo === null || date <= p.effectiveTo)) ?? null;
}
