import { formatHM, HEBREW_MONTHS, HEBREW_WEEKDAYS, type DayStatusKind, type EmployeeSettings, type Weekday } from '../engine';

/** Display minutes as HH:MM; zero shows as an en dash to keep tables calm. */
export function hm(minutes: number, zero = '–'): string {
  return minutes === 0 ? zero : formatHM(minutes);
}

export function monthTitle(year: number, month: number): string {
  return `${HEBREW_MONTHS[month - 1]} ${year}`;
}

export function shekels(agorot: number | null): string {
  if (agorot === null) return '–';
  const sign = agorot < 0 ? '-' : '';
  const abs = Math.abs(agorot);
  const s = Math.floor(abs / 100).toLocaleString('he-IL');
  return `${sign}₪${s}.${String(abs % 100).padStart(2, '0')}`;
}

export const STATUS_LABELS: Record<DayStatusKind, string> = {
  not_worked: 'לא עבד',
  vacation: 'חופשה',
  sick: 'מחלה',
  holiday: 'חג',
  reserve: 'מילואים',
  missing_record: 'רישום חסר',
};

export const STATUS_OPTIONS: { value: DayStatusKind | ''; label: string }[] = [
  { value: '', label: 'ללא סטטוס' },
  ...(Object.keys(STATUS_LABELS) as DayStatusKind[]).map((k) => ({ value: k, label: STATUS_LABELS[k] })),
];

export function scheduleLabel(s: EmployeeSettings): string {
  if (s.legalProfile === 'custom_contract') return `הסכמי${s.customProfile?.label ? ` – ${s.customProfile.label}` : ''}`;
  return s.workweek === 'five' ? '5 ימים' : '6 ימים';
}

export function weekdayName(d: Weekday | null): string {
  return d === null ? '–' : HEBREW_WEEKDAYS[d];
}

export const PROFILE_LABELS: Record<EmployeeSettings['legalProfile'], string> = {
  general_private: 'כללי – מגזר פרטי (חוק שעות עבודה ומנוחה + צו ההרחבה)',
  custom_contract: 'הסכם קיבוצי / מגזר ציבורי / הסדר חוזי – תקנים ידניים',
  exempt: 'עובד שהחוק אינו חל עליו (משרת אמון / הנהלה) – ללא שעות נוספות',
  minor: 'עובד מתחת לגיל 18 – לא נתמך בחישוב אוטומטי',
};

export const BREAK_METHOD_LABELS: Record<EmployeeSettings['breakMethod'], string> = {
  company_auto: 'מדיניות המשרד האוטומטית (הערכה לאישור)',
  manual: 'הזנה ידנית של הפסקה בכל משמרת',
  none: 'ללא ניכוי הפסקה',
  paid: 'הפסקה בתשלום / נחשבת זמן עבודה',
  legal_profile: 'לפי הפרופיל החוקי, עם בדיקות תאימות',
};

export function formatDateHe(date: string): string {
  const [y, m, d] = date.split('-');
  return `${d}/${m}/${y}`;
}

export function formatTimestamp(iso: string): string {
  if (!iso) return '–';
  const d = new Date(iso);
  return d.toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
