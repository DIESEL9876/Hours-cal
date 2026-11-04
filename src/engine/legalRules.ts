/**
 * Registry of the legal rules Hours-Cal applies to minors and the payroll-preparation flags (1.1.10).
 *
 * Every rule has: id, description, instrument, source URL, source class, effective dates, required inputs, how it is
 * applied (mode), review status and the regression tests that cover it. Rule ids follow the research pack of
 * 2026-11-04 (Y-001 … Y-013) where one exists.
 *
 * SOURCE CLASSES — what the evidence actually is (no class means "official legal text verified"):
 *   rights_summary        Kol Zchut rights summary (approved by the user for this task; NOT the statute or the gazette)
 *   official_announcement Knesset press release on an amendment (official, but not the enacted text)
 *   official_data         Government statistics page (Bituach Leumi)
 *   official_text_located Original government PDF located by the research pack; its clauses were NOT extracted here
 *   directory_only        Name listed in the government extension-order directory; no text extracted
 *   unapproved_secondary  Earlier commercial/secondary sources outside the approved source policy
 *
 * The build environment could not open any of these URLs (network policy: www.gov.il, main.knesset.gov.il,
 * www.kolzchut.org.il, teen.kolzchut.org.il and www.btl.gov.il are refused). The figures come from the research pack.
 *
 * MODES
 *   flag           produces a compliance/review warning only — never changes recorded minutes, classification or pay
 *   wage_check     compares the entered hourly rate with a published rate in force on the date — warning only
 *   exception      can only DOWNGRADE a prohibition warning to "review: check the conditions" — never grants permission
 *   not_automated  documented; the engine raises a review flag instead of calculating
 *
 * A rule whose effective date is unknown never changes money. Flags with an unknown commencement date are applied to
 * every date and say so; wage checks apply only inside their verified effective period.
 */
import type { LocalDate } from './types';

export const LEGAL_REGISTRY_VERSION = '2026.11.04';

export type SourceClass = 'rights_summary' | 'official_announcement' | 'official_data' | 'official_text_located' | 'directory_only' | 'unapproved_secondary';
export type RuleMode = 'flag' | 'wage_check' | 'exception' | 'not_automated';

export const SOURCE_CLASS_LABELS: Record<SourceClass, string> = {
  rights_summary: 'סיכום זכויות (כל זכות) — אינו נוסח החוק',
  official_announcement: 'הודעה רשמית (הכנסת) — אינה נוסח החוק',
  official_data: 'נתון רשמי (ביטוח לאומי)',
  official_text_located: 'נוסח רשמי אותר — הוראותיו לא חולצו',
  directory_only: 'רשום במאגר הממשלתי בלבד — נוסח לא נבדק',
  unapproved_secondary: 'מקור משני שאינו רשמי',
};

export interface LegalRule {
  id: string;
  title: string;
  instrument: string;
  sourceUrl: string;
  sourceClass: SourceClass;
  /** null = commencement not verified (the rule is then never used to change money). */
  effectiveFrom: LocalDate | null;
  effectiveUntil: LocalDate | null;
  inputs: string[];
  mode: RuleMode;
  /** Warning codes the engine emits for this rule. */
  codes: string[];
  reviewStatus: string;
  tests: string[];
}

const KZ_HOURS = 'https://www.kolzchut.org.il/he/יום_עבודה_ושעות_עבודה_לנוער';
const KZ_REST = 'https://www.kolzchut.org.il/he/מנוחה_שבועית_לנוער_עובד';
const KZ_BREAKS = 'https://www.kolzchut.org.il/he/הפסקות_בעבודה_לנוער';
const KZ_NIGHT = 'https://www.kolzchut.org.il/he/איסור_העסקת_נוער_בעבודת_לילה';
const KZ_AGE = 'https://www.kolzchut.org.il/he/גיל_העסקת_נוער';
const KZ_WAGE = 'https://www.kolzchut.org.il/he/תשלום_שכר_לבני_נוער';
const KZ_VACATION = 'https://www.kolzchut.org.il/he/חופשה_שנתית_לבני_נוער_עובדים';
const KNESSET_2024 = 'https://main.knesset.gov.il/News/PressReleases/pages/press03062024jfd.aspx';
const YOUTH_LAW = 'חוק עבודת הנוער, התשי"ג-1953';
const T_ENGINE = 'src/engine/__tests__/legal1110.test.ts';

export const LEGAL_RULES: LegalRule[] = [
  {
    id: 'Y-001',
    title: 'נוער: עד 40 שעות עבודה בפועל בשבוע',
    instrument: YOUTH_LAW,
    sourceUrl: KZ_HOURS,
    sourceClass: 'rights_summary',
    effectiveFrom: null,
    effectiveUntil: null,
    inputs: ['תאריך לידה', 'שעות נטו בפועל לכל יום', 'שבוע ראשון–שבת'],
    mode: 'flag',
    codes: ['YOUTH_WEEKLY_LIMIT', 'YOUTH_PAY_REVIEW'],
    reviewStatus: 'סיכום זכויות מאומת; תחילת התוקף ההיסטורית לא אומתה — מופעל כהתראה בלבד',
    tests: [T_ENGINE],
  },
  {
    id: 'Y-002',
    title: 'נוער מתחת לגיל 16: עד 8 שעות ביום',
    instrument: YOUTH_LAW,
    sourceUrl: KZ_HOURS,
    sourceClass: 'rights_summary',
    effectiveFrom: null,
    effectiveUntil: null,
    inputs: ['גיל בתאריך העבודה', 'שעות נטו'],
    mode: 'flag',
    codes: ['YOUTH_DAILY_LIMIT', 'YOUTH_PAY_REVIEW'],
    reviewStatus: 'התראה בלבד',
    tests: [T_ENGINE],
  },
  {
    id: 'Y-003',
    title: 'נוער בני 16–17 במקום עבודה של 5 ימים: עד 9 שעות ביום',
    instrument: YOUTH_LAW,
    sourceUrl: KZ_HOURS,
    sourceClass: 'rights_summary',
    effectiveFrom: null,
    effectiveUntil: null,
    inputs: ['גיל', 'מתכונת שבוע העבודה (הגדרות העובד)'],
    mode: 'flag',
    codes: ['YOUTH_DAILY_LIMIT'],
    reviewStatus: 'התראה בלבד',
    tests: [T_ENGINE],
  },
  {
    id: 'Y-004',
    title: 'נוער בני 16–17 בשבוע של 6 ימים: עד 8 שעות ביום',
    instrument: YOUTH_LAW,
    sourceUrl: KZ_HOURS,
    sourceClass: 'rights_summary',
    effectiveFrom: null,
    effectiveUntil: null,
    inputs: ['גיל', 'מתכונת שבוע העבודה'],
    mode: 'flag',
    codes: ['YOUTH_DAILY_LIMIT'],
    reviewStatus: 'התראה בלבד',
    tests: [T_ENGINE],
  },
  {
    id: 'Y-005',
    title: 'נוער: עד 7 שעות בערב המנוחה השבועית ובערב חג שבו הנער אינו עובד',
    instrument: YOUTH_LAW,
    sourceUrl: KZ_HOURS,
    sourceClass: 'rights_summary',
    effectiveFrom: null,
    effectiveUntil: null,
    inputs: ['יום המנוחה השבועית (הגדרות העובד)', 'לוח החגים', 'עבודה ביום החג'],
    mode: 'flag',
    codes: ['YOUTH_DAILY_LIMIT'],
    reviewStatus: 'התראה בלבד',
    tests: [T_ENGINE],
  },
  {
    id: 'Y-006',
    title: 'נוער: מנוחה שבועית של 36 שעות רצופות לפחות, כולל יום המנוחה; עבודה ביום המנוחה אסורה ואין היתר המתיר אותה',
    instrument: YOUTH_LAW,
    sourceUrl: KZ_REST,
    sourceClass: 'rights_summary',
    effectiveFrom: null,
    effectiveUntil: null,
    inputs: ['יום המנוחה שנבחר לעובד (אין הסקה מדת)', 'שעות כניסה ויציאה'],
    mode: 'flag',
    codes: ['YOUTH_REST_DAY', 'YOUTH_WEEKLY_REST_SHORT', 'YOUTH_PAY_REVIEW'],
    reviewStatus: 'התראה בלבד; השכר בגין עבודה שבוצעה נשמר',
    tests: [T_ENGINE],
  },
  {
    id: 'Y-007',
    title: 'נוער: ביום של 6 שעות עבודה ומעלה — 45 דקות הפסקה, מתוכן 30 רצופות; בערב מנוחה/חג — 30 דקות לפחות',
    instrument: YOUTH_LAW,
    sourceUrl: KZ_BREAKS,
    sourceClass: 'rights_summary',
    effectiveFrom: null,
    effectiveUntil: null,
    inputs: ['הפסקות שנרשמו בפועל ואושרו', 'פערים בין משמרות באותו יום'],
    mode: 'flag',
    codes: ['YOUTH_BREAK', 'YOUTH_BREAK_UNVERIFIED'],
    reviewStatus: 'התראה בלבד; לא מנוכה הפסקה שלא התקיימה. רציפות של הפסקה שנרשמה כמספר דקות אחד אינה ניתנת לאימות',
    tests: [T_ENGINE],
  },
  {
    id: 'Y-008',
    title: 'נוער: העסקה בשעות נוספות אסורה — אך שעות שבוצעו משולמות',
    instrument: YOUTH_LAW,
    sourceUrl: KZ_HOURS,
    sourceClass: 'rights_summary',
    effectiveFrom: null,
    effectiveUntil: null,
    inputs: ['עודף יומי ואחריו עודף שבועי (ללא כפילות)'],
    mode: 'flag',
    codes: ['YOUTH_PAY_REVIEW'],
    reviewStatus: 'סיווג התשלום (גמול) דורש בדיקת חשב/ת שכר — הסכומים מסומנים לבדיקה',
    tests: [T_ENGINE],
  },
  {
    id: 'Y-009',
    title: 'שכר מינימום לנוער מתחת לגיל 16: 26.07 ₪ לשעה (70%)',
    instrument: 'חוק שכר מינימום והתקנות לנוער',
    sourceUrl: KZ_WAGE,
    sourceClass: 'rights_summary',
    effectiveFrom: '2026-04-01',
    effectiveUntil: null,
    inputs: ['גיל בתאריך העבודה', 'שכר שעתי'],
    mode: 'wage_check',
    codes: ['YOUTH_MIN_WAGE'],
    reviewStatus: 'שיעור שפורסם; יש לעקוב אחר עדכונים. לא חל רטרואקטיבית',
    tests: [T_ENGINE],
  },
  {
    id: 'Y-010',
    title: 'שכר מינימום לנוער מגיל 16 ועד יום לפני גיל 17: 27.94 ₪ לשעה (75%)',
    instrument: 'חוק שכר מינימום והתקנות לנוער',
    sourceUrl: KZ_WAGE,
    sourceClass: 'rights_summary',
    effectiveFrom: '2026-04-01',
    effectiveUntil: null,
    inputs: ['גיל', 'שכר שעתי'],
    mode: 'wage_check',
    codes: ['YOUTH_MIN_WAGE'],
    reviewStatus: 'כמו Y-009',
    tests: [T_ENGINE],
  },
  {
    id: 'Y-011',
    title: 'שכר מינימום לנוער מגיל 17 ועד יום לפני גיל 18: 30.92 ₪ לשעה (83%)',
    instrument: 'חוק שכר מינימום והתקנות לנוער',
    sourceUrl: KZ_WAGE,
    sourceClass: 'rights_summary',
    effectiveFrom: '2026-04-01',
    effectiveUntil: null,
    inputs: ['גיל', 'שכר שעתי'],
    mode: 'wage_check',
    codes: ['YOUTH_MIN_WAGE'],
    reviewStatus: 'כמו Y-009',
    tests: [T_ENGINE],
  },
  {
    id: 'Y-012',
    title: 'שכר מינימום לחניך מוכר לפי חוק החניכות: 22.35 ₪ לשעה (60%) — רק עם מסמך הכרה',
    instrument: 'חוק החניכות / חוק שכר מינימום',
    sourceUrl: KZ_WAGE,
    sourceClass: 'rights_summary',
    effectiveFrom: '2026-04-01',
    effectiveUntil: null,
    inputs: ['מעמד חניך מוכר ומספר מסמך (מוזן ידנית)'],
    mode: 'wage_check',
    codes: ['YOUTH_MIN_WAGE', 'YOUTH_APPRENTICE_REVIEW'],
    reviewStatus: 'מעמד החניך אינו נגזר מגיל או מתפקיד — תמיד מסומן לבדיקה',
    tests: [T_ENGINE],
  },
  {
    id: 'Y-013',
    title: 'תיקון 22 (2024): בני 16–17 עד 01:00 בחופשת לימודים רשמית, בתנאים; סיום אחרי 23:00 — הסעה של המעסיק הביתה (לא תחבורה ציבורית)',
    instrument: `${YOUTH_LAW} — תיקון מס׳ 22`,
    sourceUrl: KNESSET_2024,
    sourceClass: 'official_announcement',
    effectiveFrom: null,
    effectiveUntil: null,
    inputs: ['גיל', 'טווחי חופשת לימודים רשמית (מוזנים ידנית)', 'שעת סיום', 'הסעה'],
    mode: 'exception',
    codes: ['YOUTH_NIGHT_VACATION_REVIEW', 'YOUTH_NIGHT'],
    reviewStatus: 'מועד התחילה של התיקון לא אומת — אינו מתיר עבודה אוטומטית; ממיר את האיסור ל"בדיקת תנאים" בלבד. הנחיית משרד העבודה שעודכנה לאחרונה ב-2025 ומציינת שעה מוקדמת יותר — מיושנת ואינה משמשת',
    tests: [T_ENGINE],
  },
  {
    id: 'Y-014',
    title: 'עבודת לילה: 20:00–08:00 לנער החייב בלימודי חובה או מתחת ל-16; 22:00–06:00 לבני 16–17 שאינם חייבים; היתר — רק לפי פרטיו ותוקפו',
    instrument: YOUTH_LAW,
    sourceUrl: KZ_NIGHT,
    sourceClass: 'rights_summary',
    effectiveFrom: null,
    effectiveUntil: null,
    inputs: ['גיל', 'חובת לימוד (חלה / לא חלה / לא ידוע)', 'היתר לילה (מספר, תוקף, שעת סיום)'],
    mode: 'flag',
    codes: ['YOUTH_NIGHT', 'YOUTH_NIGHT_REVIEW', 'YOUTH_NIGHT_PERMIT_REVIEW'],
    reviewStatus: 'בני 16–17 בין 20:00 ל-22:00 כשחובת הלימוד אינה ידועה — לבדיקה (קיימת עמימות בין לשון החוק לפרשנות האכיפה)',
    tests: [T_ENGINE],
  },
  {
    id: 'Y-015',
    title: 'גיל העסקה: 15 בשנת הלימודים; 14 בחופשת לימודים רשמית (בתנאים); מתחת לכך — רק חריגים בהיתר',
    instrument: YOUTH_LAW,
    sourceUrl: KZ_AGE,
    sourceClass: 'rights_summary',
    effectiveFrom: null,
    effectiveUntil: null,
    inputs: ['גיל', 'חופשת לימודים רשמית'],
    mode: 'flag',
    codes: ['YOUTH_MIN_AGE', 'YOUTH_MIN_AGE_REVIEW'],
    reviewStatus: 'התראה בלבד',
    tests: [T_ENGINE],
  },
  {
    id: 'Y-016',
    title: 'שעות לימודים וחובת לימוד אינן נגזרות מהגיל — דורש אימות',
    instrument: YOUTH_LAW,
    sourceUrl: 'https://www.kolzchut.org.il/he/העסקת_צעירים_מעל_גיל_16',
    sourceClass: 'rights_summary',
    effectiveFrom: null,
    effectiveUntil: null,
    inputs: ['חובת לימוד', 'חופשות לימודים'],
    mode: 'not_automated',
    codes: ['YOUTH_SCHOOL_REVIEW'],
    reviewStatus: 'לא ממוכן — התראת בדיקה',
    tests: [T_ENGINE],
  },
  {
    id: 'Y-017',
    title: 'חופשה שנתית לנוער: 18 ימים קלנדריים, חישוב יחסי (200/240 ימי עבודה), 4% לשעתי/יומי שהועסק פחות מ-75 ימים רצופים',
    instrument: 'חוק עבודת הנוער / חוק חופשה שנתית',
    sourceUrl: KZ_VACATION,
    sourceClass: 'rights_summary',
    effectiveFrom: null,
    effectiveUntil: null,
    inputs: ['ותק', 'ימי עבודה בשנה', 'שכר בתקופה הקובעת'],
    mode: 'not_automated',
    codes: ['YOUTH_VACATION_REVIEW'],
    reviewStatus: 'לא ממוכן — יום חופשה של נער מסומן לבדיקה; אין לערבב עם הערכת ערך יום ההיעדרות של העסק',
    tests: [T_ENGINE],
  },
];

export function legalRule(id: string): LegalRule | undefined {
  return LEGAL_RULES.find((r) => r.id === id);
}

/** Rules in force on a date (rules without a verified commencement date are listed as "commencement unverified"). */
export function rulesInForce(date: LocalDate): LegalRule[] {
  return LEGAL_RULES.filter((r) => (r.effectiveFrom === null || date >= r.effectiveFrom) && (r.effectiveUntil === null || date <= r.effectiveUntil));
}
