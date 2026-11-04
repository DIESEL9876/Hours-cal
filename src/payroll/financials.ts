/**
 * Monthly payroll-preparation figures (1.1.9) — integer agorot only, never mixed with hours.
 *
 * Kept strictly apart: actual hours, paid absence hours, the office estimate of absence value, regular/overtime pay
 * estimate, bonuses, recuperation, reserve-duty amounts and employer reimbursements, advances and authorised
 * deductions, travel. Nothing here is a payslip or a gross-to-net calculation.
 */
import type { EmployeePeriodResult, EmployeeSettings, TravelMode } from '../engine';
import type { AdjustmentCategory, EmployeeMonthData, MonthlyAdjustment } from '../data/repo';
import type { ResolvedRules } from '../agreements';

export const ADJUSTMENT_LABELS: Record<AdjustmentCategory, string> = {
  advance: 'מקדמה',
  bonus: 'בונוס',
  recuperation: 'דמי הבראה',
  reserve: 'תשלום מילואים',
  other: 'תוספת אחרת',
};

export const TRAVEL_LABELS: Record<TravelMode, string> = {
  none: 'ללא החזר נסיעות',
  monthly: 'סכום חודשי קבוע',
  daily: 'סכום לכל יום זכאי',
};

export interface ResolvedTravel {
  mode: TravelMode;
  amountAgorot: number;
  inherited: boolean;
}

/** Employee travel setting, falling back to the business default ('inherit' / absent). */
export function resolveTravel(employee: EmployeeSettings | null, business: EmployeeSettings | null): ResolvedTravel {
  const own = employee?.travel;
  if (own && own.mode !== 'inherit') return { mode: own.mode, amountAgorot: own.amountAgorot ?? 0, inherited: false };
  const biz = business?.travel;
  if (biz && biz.mode !== 'inherit') return { mode: biz.mode, amountAgorot: biz.amountAgorot ?? 0, inherited: true };
  return { mode: 'none', amountAgorot: 0, inherited: true };
}

export interface TravelFigures {
  mode: TravelMode;
  inherited: boolean;
  amountAgorot: number;
  /** Distinct dates with actual work (two shifts on one date = one day; absence-only dates excluded). */
  autoDays: number;
  /** Manual correction (remote work, employer transport…), with its reason. */
  overrideDays: number | null;
  overrideReason: string | null;
  eligibleDays: number;
  totalAgorot: number;
  notes: string[];
  reviews: string[];
}

export function travelFigures(result: EmployeePeriodResult, travel: ResolvedTravel, month: EmployeeMonthData, rules: ResolvedRules | null): TravelFigures {
  const autoDays = result.days.filter((d) => d.netMinutes > 0).length;
  const o = month.travel ?? null;
  const eligibleDays = o ? o.eligibleDays : autoDays;
  const total = travel.mode === 'monthly' ? travel.amountAgorot : travel.mode === 'daily' ? travel.amountAgorot * eligibleDays : 0;
  const f: TravelFigures = {
    mode: travel.mode,
    inherited: travel.inherited,
    amountAgorot: travel.amountAgorot,
    autoDays,
    overrideDays: o ? o.eligibleDays : null,
    overrideReason: o?.reason ?? null,
    eligibleDays,
    totalAgorot: total,
    notes: [],
    reviews: [],
  };
  if (travel.mode === 'daily') f.notes.push(`${eligibleDays} ימי נסיעה × ₪${(travel.amountAgorot / 100).toFixed(2)}${o ? ` (תוקן ידנית: ${o.reason})` : ' (ימי עבודה בפועל; חופשה, מחלה וחג ללא עבודה אינם נספרים)'}`);
  if (travel.mode === 'monthly') f.notes.push('סכום חודשי קבוע — אינו תלוי במספר ימי העבודה');
  const cap = rules?.travel;
  if (cap) {
    f.notes.push(`צו ההרחבה: החזר עלות הנסיעה בפועל עד תקרה יומית — ${cap.rule.capStatus}`);
    if (travel.mode === 'none' && autoDays > 0) f.reviews.push('לא הוגדר החזר נסיעות — לפי צו ההרחבה עובד הזקוק לתחבורה זכאי להשתתפות המעסיק. יש לבדוק');
  } else if (travel.mode === 'none' && autoDays > 0) f.reviews.push('לא הוגדר החזר נסיעות — יש לבדוק זכאות לפי צו ההרחבה בדבר הוצאות נסיעה');
  if (travel.mode !== 'none' && travel.amountAgorot <= 0) f.reviews.push('נבחרה שיטת החזר נסיעות ללא סכום');
  if (travel.mode !== 'none') f.notes.push('יש לוודא שהסכום אינו נמוך מעלות הנסיעה בפועל עד לתקרה (או מהסדר מיטיב)');
  return f;
}

export interface MonthFinancials {
  /** Indicative pay for worked hours incl. overtime premiums (existing estimate; null without an hourly rate). */
  workPayEstimateAgorot: number | null;
  /** Office estimate of paid absences ("שיטת חישוב לפי הגדרת העסק"). */
  absenceEstimateAgorot: number;
  byCategory: Record<AdjustmentCategory, number>;
  advance: { advancedAgorot: number; proposedRecoveryAgorot: number; authorizedDeductionAgorot: number };
  reserve: { wageDuringServiceAgorot: number; niiReimbursementAgorot: number; additionalPayableAgorot: number; manualAgorot: number };
  travel: TravelFigures;
  totals: {
    /** Gross additions entered or configured (bonus, recuperation, reserve paid by the employer, other, travel). */
    grossAdditionsAgorot: number;
    /** Advances paid during the month (money paid, not a gross component). */
    advancesPaidAgorot: number;
    /** Deductions only where an authorisation basis was recorded. */
    authorizedDeductionsAgorot: number;
    /** Proposed recovery (not authorised) — informational. */
    proposedDeductionsAgorot: number;
    /** Amounts reimbursed to the EMPLOYER (e.g. National Insurance for reserve duty) — not paid to the employee. */
    employerReimbursementsAgorot: number;
    /** Informational entries that are not payroll items. */
    informationalAgorot: number;
  };
  count: number;
}

export function monthFinancials(
  result: EmployeePeriodResult,
  adjustments: MonthlyAdjustment[],
  travel: ResolvedTravel,
  month: EmployeeMonthData,
  rules: ResolvedRules | null,
): MonthFinancials {
  const byCategory: Record<AdjustmentCategory, number> = { advance: 0, bonus: 0, recuperation: 0, reserve: 0, other: 0 };
  const advance = { advancedAgorot: 0, proposedRecoveryAgorot: 0, authorizedDeductionAgorot: 0 };
  const reserve = { wageDuringServiceAgorot: 0, niiReimbursementAgorot: 0, additionalPayableAgorot: 0, manualAgorot: 0 };
  let gross = 0;
  let info = 0;
  let employer = 0;
  for (const a of adjustments) {
    byCategory[a.category] += a.amountAgorot;
    if (a.category === 'advance') {
      advance.advancedAgorot += a.amountAgorot;
      advance.proposedRecoveryAgorot += a.details.advance?.proposedRecoveryAgorot ?? 0;
      advance.authorizedDeductionAgorot += a.details.advance?.authorizedDeductionAgorot ?? 0;
      continue;
    }
    if (a.category === 'reserve') {
      const k = a.details.reserve?.kind ?? 'manual';
      if (k === 'wage_during_service') reserve.wageDuringServiceAgorot += a.amountAgorot;
      else if (k === 'nii_reimbursement') reserve.niiReimbursementAgorot += a.amountAgorot;
      else if (k === 'additional_payable') reserve.additionalPayableAgorot += a.amountAgorot;
      else reserve.manualAgorot += a.amountAgorot;
    }
    if (a.treatment === 'gross_addition') gross += a.amountAgorot;
    else if (a.treatment === 'employer_reimbursement') employer += a.amountAgorot;
    else info += a.amountAgorot;
  }
  const tr = travelFigures(result, travel, month, rules);
  return {
    workPayEstimateAgorot: result.totals.payAgorot,
    absenceEstimateAgorot: result.attendance.estimatedAbsenceValueAgorot,
    byCategory,
    advance,
    reserve,
    travel: tr,
    totals: {
      grossAdditionsAgorot: gross + tr.totalAgorot,
      advancesPaidAgorot: advance.advancedAgorot,
      authorizedDeductionsAgorot: advance.authorizedDeductionAgorot,
      proposedDeductionsAgorot: advance.proposedRecoveryAgorot,
      employerReimbursementsAgorot: employer,
      informationalAgorot: info,
    },
    count: adjustments.length,
  };
}

/** Business totals = plain sums of the employees' figures. */
export function sumFinancials(list: MonthFinancials[]): MonthFinancials['totals'] & { byCategory: Record<AdjustmentCategory, number>; travelAgorot: number; absenceEstimateAgorot: number } {
  const t = { grossAdditionsAgorot: 0, advancesPaidAgorot: 0, authorizedDeductionsAgorot: 0, proposedDeductionsAgorot: 0, employerReimbursementsAgorot: 0, informationalAgorot: 0 };
  const byCategory: Record<AdjustmentCategory, number> = { advance: 0, bonus: 0, recuperation: 0, reserve: 0, other: 0 };
  let travel = 0;
  let absence = 0;
  for (const f of list) {
    for (const k of Object.keys(t) as (keyof typeof t)[]) t[k] += f.totals[k];
    for (const k of Object.keys(byCategory) as AdjustmentCategory[]) byCategory[k] += f.byCategory[k];
    travel += f.travel.totalAgorot;
    absence += f.absenceEstimateAgorot;
  }
  return { ...t, byCategory, travelAgorot: travel, absenceEstimateAgorot: absence };
}

export const shekelsText = (agorot: number) => `₪${(agorot / 100).toLocaleString('he-IL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
