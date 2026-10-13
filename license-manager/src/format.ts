import type { LicenseStatus, LicenseView } from './types';

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('he-IL', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export const statusTone: Record<LicenseStatus, 'green' | 'amber' | 'red' | 'slate' | 'violet'> = {
  valid: 'green',
  expired: 'amber',
  revoked: 'red',
  replaced: 'slate',
  unverifiable: 'violet',
};

export const statusHelp: Record<LicenseStatus, string> = {
  valid: 'החתימה תקינה עם המפתח הנוכחי והרישיון בתוקף.',
  expired: 'רישיון מוגבל בזמן שתאריך התפוגה שלו עבר. Hours-Cal תחסום את השימוש לאחר תאריך זה.',
  revoked: 'סומן כמבוטל ברשומות. הביטול חל רק בגרסאות Hours-Cal שנבנו עם רשימת הביטולים המעודכנת.',
  replaced: 'הונפק רישיון חדש במקומו (למשל לאחר החלפת מחשב).',
  unverifiable: 'לא ניתן לאמת את החתימה במפתח הנוכחי (נחתם במפתח אחר או שהנתונים פגומים).',
};

export function typeLabel(l: Pick<LicenseView, 'licenseType'>): string {
  return l.licenseType === 'perpetual' ? 'קבוע (ללא הגבלת זמן)' : 'מוגבל בזמן';
}

/** Text the owner can paste into an email/WhatsApp to the customer (all public information). */
export function licenseInfoText(l: LicenseView): string {
  return [
    `רישיון Hours-Cal`,
    `בעל הרישיון: ${l.licensee}`,
    `מספר רישיון: ${l.licenseId}`,
    `מזהה מחשב: ${l.deviceId}${l.nickname ? ` (${l.nickname})` : ''}`,
    `סוג: ${typeLabel(l)}`,
    `תאריך הנפקה: ${fmtDate(l.issuedAt)}`,
    `תוקף עד: ${l.expiresAt ? fmtDate(l.expiresAt) : 'ללא הגבלה'}`,
    ``,
    `הפעלה: פתחו את Hours-Cal במחשב זה ← "ייבוא קובץ רישיון" ← בחרו בקובץ ה-.hclic שצורף,`,
    `או הדביקו את מפתח ההפעלה המלא בשדה ההפעלה.`,
  ].join('\n');
}

export function addMonths(isoDate: string, months: number): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(d, last));
  return t.toISOString().slice(0, 10);
}
