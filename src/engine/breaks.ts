/**
 * Break handling.
 *
 * IMPORTANT: The office's automatic policy (<=10:00 gross → 30 min, >10:00 → 45 min) is a COMPANY
 * calculation parameter, not a statutory Israeli rule. Automatic deductions are ESTIMATES that stay
 * flagged until the user confirms the break was actually taken.
 *
 * Statutory reference (Hours of Work and Rest Law s.20, per secondary sources — see docs/LEGAL_RULES.md):
 * on a work day of 6 hours or more, a break of at least 45 minutes including 30 consecutive minutes;
 * on the day before the weekly rest / a holiday, 30 minutes. A break during which the employee must
 * remain available counts as working time.
 */
import type { BreakResult, EmployeeSettings, ShiftInput, Warning } from './types';
import { LAW } from './settings';
import { formatDurationHe } from './time';

export interface BreakContext {
  /** Day before weekly rest or before a holiday (reduced statutory minimum). */
  isEve: boolean;
}

/** Office automatic policy suggestion. Boundary: gross === threshold → short break; threshold + 1 → long break. */
export function companyPolicyBreak(grossMinutes: number, settings: EmployeeSettings): number {
  const p = settings.companyBreakPolicy;
  if (grossMinutes < p.minShiftMinutes) return 0;
  return grossMinutes <= p.thresholdMinutes ? p.shortBreakMinutes : p.longBreakMinutes;
}

/** Statutory minimum break to require for compliance checks (manual labour). */
export function statutoryMinimumBreak(grossMinutes: number, settings: EmployeeSettings, ctx: BreakContext): number {
  if (settings.workType !== 'manual') return 0;
  if (grossMinutes < LAW.BREAK_QUALIFY_MINUTES) return 0;
  return ctx.isEve ? LAW.BREAK_MIN_EVE_MINUTES : LAW.BREAK_MIN_MINUTES;
}

/**
 * Suggestion for the 'legal_profile' method.
 * Manual labour: the statutory minimum. Non-manual: a break is suggested only beyond the commonly cited
 * exemption duration (9h in a five-day week, 8h in a six-day week) — UNVERIFIED, always flagged.
 */
export function legalProfileBreak(grossMinutes: number, settings: EmployeeSettings, ctx: BreakContext): number {
  if (settings.workType === 'manual') return statutoryMinimumBreak(grossMinutes, settings, ctx);
  const exemptUpTo = settings.workweek === 'five' ? 9 * 60 : 8 * 60;
  if (grossMinutes <= exemptUpTo) return 0;
  return ctx.isEve ? LAW.BREAK_MIN_EVE_MINUTES : LAW.BREAK_MIN_MINUTES;
}

/** Which rule determines the break for this shift. */
export function determineBreakPolicy(
  shift: Pick<ShiftInput, 'breakMinutes' | 'breakPaid'>,
  settings: EmployeeSettings,
): BreakResult['kind'] {
  if (shift.breakPaid) return 'paid';
  if (shift.breakMinutes !== null) return 'manual';
  switch (settings.breakMethod) {
    case 'none':
    case 'manual':
      return 'none';
    case 'paid':
      return 'paid';
    case 'company_auto':
      return 'company_estimate';
    case 'legal_profile':
      return 'legal_estimate';
  }
}

export function calculateDeductibleBreakMinutes(
  grossMinutes: number,
  shift: Pick<ShiftInput, 'id' | 'workDate' | 'breakMinutes' | 'breakPaid' | 'breakConfirmed' | 'breakStart'>,
  settings: EmployeeSettings,
  ctx: BreakContext,
): { result: BreakResult; warnings: Warning[] } {
  const warnings: Warning[] = [];
  const w = (code: string, severity: Warning['severity'], message: string) =>
    warnings.push({ code, severity, message, date: shift.workDate, shiftId: shift.id });

  const kind = determineBreakPolicy(shift, settings);
  const company = companyPolicyBreak(grossMinutes, settings);
  let result: BreakResult;

  switch (kind) {
    case 'paid': {
      const paid = shift.breakMinutes ?? 0;
      result = {
        kind,
        suggestedMinutes: paid,
        deductedMinutes: 0,
        paidMinutes: paid,
        unconfirmed: false,
        positioned: shift.breakStart !== null,
        rule: paid > 0 ? `הפסקה בתשלום / בזמינות של ${formatDurationHe(paid)} – נחשבת זמן עבודה ואינה מנוכה` : 'הפסקה בתשלום – אינה מנוכה',
      };
      break;
    }
    case 'manual': {
      const m = shift.breakMinutes!;
      result = {
        kind,
        suggestedMinutes: settings.breakMethod === 'company_auto' ? company : m,
        deductedMinutes: m,
        paidMinutes: 0,
        unconfirmed: false,
        positioned: shift.breakStart !== null,
        rule: m > 0 ? `הפסקה שהוזנה ידנית: ${formatDurationHe(m)}` : 'הוזן ידנית: ללא הפסקה',
      };
      break;
    }
    case 'none':
      result = {
        kind,
        suggestedMinutes: 0,
        deductedMinutes: 0,
        paidMinutes: 0,
        unconfirmed: false,
        positioned: false,
        rule: settings.breakMethod === 'manual' ? 'לא הוזנה הפסקה – לא נוכה זמן' : 'ללא ניכוי הפסקה (הגדרת העובד)',
      };
      break;
    case 'company_estimate': {
      const p = settings.companyBreakPolicy;
      if (grossMinutes < p.minShiftMinutes) {
        result = {
          kind: 'below_minimum_shift',
          suggestedMinutes: 0,
          deductedMinutes: 0,
          paidMinutes: 0,
          unconfirmed: false,
          positioned: false,
          rule: `משמרת קצרה מ-${formatDurationHe(p.minShiftMinutes)} – מדיניות ההפסקה האוטומטית אינה חלה`,
        };
      } else {
        result = {
          kind,
          suggestedMinutes: company,
          deductedMinutes: company,
          paidMinutes: 0,
          unconfirmed: !shift.breakConfirmed,
          positioned: shift.breakStart !== null,
          rule:
            grossMinutes <= p.thresholdMinutes
              ? `מדיניות המשרד: משמרת של עד ${formatDurationHe(p.thresholdMinutes)} ברוטו – הפסקה של ${formatDurationHe(p.shortBreakMinutes)} (מדיניות פנימית, לא חובה חוקית)`
              : `מדיניות המשרד: משמרת של מעל ${formatDurationHe(p.thresholdMinutes)} ברוטו – הפסקה של ${formatDurationHe(p.longBreakMinutes)} (מדיניות פנימית, לא חובה חוקית)`,
        };
      }
      break;
    }
    case 'legal_estimate': {
      const m = legalProfileBreak(grossMinutes, settings, ctx);
      result = {
        kind,
        suggestedMinutes: m,
        deductedMinutes: m,
        paidMinutes: 0,
        unconfirmed: m > 0 && !shift.breakConfirmed,
        positioned: shift.breakStart !== null,
        rule:
          m > 0
            ? `הערכה לפי הפרופיל החוקי: הפסקה של ${formatDurationHe(m)}`
            : 'לפי הפרופיל החוקי לא נדרשת הפסקה במשמרת זו – לא נוכה זמן',
      };
      if (settings.workType !== 'manual' && m > 0)
        w('BREAK_NON_MANUAL_ESTIMATE', 'review', 'הערכת הפסקה לעובד שאינו עובד כפיים מבוססת על פרשנות שלא אומתה – יש לאשר');
      break;
    }
    default:
      throw new Error(`unknown break kind ${kind as string}`);
  }

  // --- validation ---------------------------------------------------------
  const total = result.deductedMinutes + result.paidMinutes;
  if (!Number.isInteger(result.deductedMinutes) || result.deductedMinutes < 0 || !Number.isInteger(result.paidMinutes) || result.paidMinutes < 0) {
    w('BREAK_INVALID', 'error', 'משך הפסקה לא תקין');
  } else if (result.deductedMinutes > 0 && result.deductedMinutes >= grossMinutes) {
    w('BREAK_EXCEEDS_SHIFT', 'error', 'ההפסקה שווה למשך המשמרת או ארוכה ממנו – לא ניתן לנכות');
  } else if (result.paidMinutes > grossMinutes) {
    w('BREAK_EXCEEDS_SHIFT', 'error', 'ההפסקה בתשלום ארוכה ממשך המשמרת');
  }
  if (result.unconfirmed) {
    w('BREAK_UNCONFIRMED', 'review', `ניכוי הפסקה משוער (${formatDurationHe(result.deductedMinutes)}) – יש לאשר שההפסקה ניתנה בפועל`);
  }
  if (total > LAW.BREAK_MAX_MINUTES) {
    w('BREAK_TOO_LONG', 'compliance', 'הפסקה ארוכה מ-3 שעות – יש לבדוק את תקינות הרישום');
  }
  const required = statutoryMinimumBreak(grossMinutes, settings, ctx);
  if (required > 0 && total < required && !(kind === 'paid' && shift.breakMinutes === null)) {
    w(
      'BREAK_BELOW_MINIMUM',
      'compliance',
      `עובד כפיים ביום עבודה של 6 שעות ומעלה זכאי להפסקה של ${formatDurationHe(required)} לפחות (מתוכה 30 דקות רצופות). נרשמו ${formatDurationHe(total)}`,
    );
  }
  return { result, warnings };
}

export function calculateNetWorkedMinutes(grossMinutes: number, deductedBreakMinutes: number): number {
  if (deductedBreakMinutes < 0) throw new Error('negative break');
  if (deductedBreakMinutes >= grossMinutes && deductedBreakMinutes > 0) return 0;
  return grossMinutes - deductedBreakMinutes;
}
