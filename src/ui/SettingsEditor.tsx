import { useState } from 'react';
import {
  defaultEmployeeSettings,
  FIVE_DAY_WORKDAYS,
  HEBREW_WEEKDAYS,
  ISRAELI_CITIES,
  SIX_DAY_WORKDAYS,
  type CustomProfile,
  type EmployeeSettings,
  type Weekday,
} from '../engine';
import { Checkbox, Field, Segmented, Select } from './components';
import { BREAK_METHOD_LABELS, PROFILE_LABELS } from './format';

const WEEKDAYS: Weekday[] = [0, 1, 2, 3, 4, 5, 6];

function Section({ title, children, note }: { title: string; children: React.ReactNode; note?: string }) {
  return (
    <section className="border-t border-line pt-5 first:border-t-0 first:pt-0">
      <h3 className="mb-1 text-[14px] font-semibold text-ink">{title}</h3>
      {note && <p className="mb-3 text-[12px] leading-relaxed text-ink-soft">{note}</p>}
      <div className={note ? '' : 'mt-3'}>{children}</div>
    </section>
  );
}

function MinutesInput({ value, onChange, min = 0 }: { value: number; onChange: (v: number) => void; min?: number }) {
  const [text, setText] = useState(`${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`);
  return (
    <input
      className="field-input num text-left"
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const m = /^(\d{1,2}):(\d{2})$/.exec(e.target.value.trim());
        if (m && +m[2] < 60) {
          const v = +m[1] * 60 + +m[2];
          if (v >= min) onChange(v);
        }
      }}
      placeholder="ש:דד"
    />
  );
}

export function SettingsEditor({ value, onChange }: { value: EmployeeSettings; onChange: (s: EmployeeSettings) => void }) {
  const s = value;
  const set = (patch: Partial<EmployeeSettings>) => onChange({ ...s, ...patch });
  const p = s.companyBreakPolicy;

  const setWorkweek = (w: 'five' | 'six') =>
    set({ workweek: w, workDays: w === 'five' ? [...FIVE_DAY_WORKDAYS] : [...SIX_DAY_WORKDAYS], shortDay: w === 'five' ? (s.shortDay ?? 4) : null });

  const toggleDay = (d: Weekday) => {
    const days = s.workDays.includes(d) ? s.workDays.filter((x) => x !== d) : [...s.workDays, d].sort();
    set({ workDays: days as Weekday[], shortDay: s.shortDay !== null && !days.includes(s.shortDay) ? null : s.shortDay });
  };

  const custom: CustomProfile = s.customProfile ?? {
    label: '',
    dailyThresholdMinutes: [480, 480, 480, 480, 480, 420, 480],
    weeklyThresholdMinutes: 2520,
    firstTierMinutes: 120,
    applyStatutoryReductions: true,
  };

  return (
    <div className="space-y-5">
      <Section title="פרופיל חוקי">
        <Select
          value={s.legalProfile}
          onChange={(v) => set({ legalProfile: v, customProfile: v === 'custom_contract' ? custom : s.customProfile })}
          options={(Object.keys(PROFILE_LABELS) as EmployeeSettings['legalProfile'][]).map((k) => ({ value: k, label: PROFILE_LABELS[k] }))}
        />
        {s.legalProfile === 'minor' && <p className="mt-2 text-[12px] text-red-700">חוק עבודת הנוער קובע הגבלות שונות. המערכת תציג שעות נטו בלבד ותסמן את הדוח כשגוי עד לטיפול ידני.</p>}
        {s.legalProfile === 'exempt' && <p className="mt-2 text-[12px] text-amber-700">יש לוודא שהעובד אכן מוחרג מהחוק (למשל משרת הנהלה או משרה הדורשת מידה מיוחדת של אמון). השעות יוצגו ללא סיווג לשעות נוספות.</p>}
        {s.legalProfile === 'custom_contract' && (
          <div className="mt-4 rounded-xl border border-line bg-slate-50/60 p-4">
            <Field label="שם ההסכם / ההסדר">
              <input className="field-input" value={custom.label} onChange={(e) => set({ customProfile: { ...custom, label: e.target.value } })} placeholder="לדוגמה: הסכם קיבוצי ענף המתכת" />
            </Field>
            <div className="mt-3 grid grid-cols-7 gap-2">
              {WEEKDAYS.map((d) => (
                <Field key={d} label={HEBREW_WEEKDAYS[d]}>
                  <MinutesInput
                    value={custom.dailyThresholdMinutes[d]}
                    onChange={(v) => {
                      const arr = [...custom.dailyThresholdMinutes] as CustomProfile['dailyThresholdMinutes'];
                      arr[d] = v;
                      set({ customProfile: { ...custom, dailyThresholdMinutes: arr } });
                    }}
                  />
                </Field>
              ))}
            </div>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <Field label="תקן שבועי (ש:דד)">
                <MinutesInput value={custom.weeklyThresholdMinutes} onChange={(v) => set({ customProfile: { ...custom, weeklyThresholdMinutes: v } })} />
              </Field>
              <Field label="שעות נוספות בדרגה הראשונה (125%) ביום">
                <MinutesInput value={custom.firstTierMinutes} onChange={(v) => set({ customProfile: { ...custom, firstTierMinutes: v } })} />
              </Field>
            </div>
            <Checkbox
              checked={custom.applyStatutoryReductions}
              onChange={(v) => set({ customProfile: { ...custom, applyStatutoryReductions: v } })}
              label="להחיל גם את התקן המקוצר של 7 שעות (לילה, ערב מנוחה, ערב חג)"
            />
          </div>
        )}
      </Section>

      <Section title="מתכונת עבודה">
        <div className="flex flex-wrap items-center gap-4">
          <Segmented value={s.workweek} onChange={setWorkweek} options={[{ value: 'five', label: 'שבוע עבודה בן 5 ימים' }, { value: 'six', label: 'שבוע עבודה בן 6 ימים' }]} />
        </div>
        <div className="mt-3">
          <span className="mb-1.5 block text-[13px] font-medium">ימי עבודה רגילים</span>
          <div className="flex flex-wrap gap-1.5">
            {WEEKDAYS.map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => toggleDay(d)}
                className={`h-9 min-w-[3.6rem] rounded-lg border px-2 text-[13px] font-medium transition ${s.workDays.includes(d) ? 'border-brand bg-brand-soft text-brand' : 'border-line bg-white text-ink-soft hover:border-slate-300'}`}
              >
                {HEBREW_WEEKDAYS[d]}
              </button>
            ))}
          </div>
        </div>
        {s.workweek === 'five' && (
          <Field label="היום המקוצר (7:36 שעות נטו)" className="mt-3 max-w-xs" hint="לפי צו ההרחבה: יום אחד קבוע בשבוע שבו יום העבודה קצר בשעה (7.6 שעות).">
            <Select
              value={s.shortDay === null ? -1 : s.shortDay}
              onChange={(v) => set({ shortDay: v === -1 ? null : (v as Weekday) })}
              options={[{ value: -1, label: 'לא הוגדר' }, ...s.workDays.map((d) => ({ value: d as number, label: HEBREW_WEEKDAYS[d] }))]}
            />
          </Field>
        )}
        <div className="mt-3 grid grid-cols-2 gap-3">
          <Field label="סוג עבודה" hint="משפיע על בדיקת ההפסקה המינימלית לעובדי כפיים">
            <Select value={s.workType} onChange={(v) => set({ workType: v })} options={[{ value: 'non_manual', label: 'עבודה שאינה עבודת כפיים' }, { value: 'manual', label: 'עבודת כפיים / פיזית' }]} />
          </Field>
          <Field label="היקף משרה יומי חוזי (אופציונלי)" hint="למשרה חלקית: שעות מעבר לכך ועד התקן יוצגו כ'שעות עודפות 100%'">
            <input
              className="field-input num text-left"
              placeholder="ש:דד"
              defaultValue={s.contractDailyMinutes === null ? '' : `${Math.floor(s.contractDailyMinutes / 60)}:${String(s.contractDailyMinutes % 60).padStart(2, '0')}`}
              onChange={(e) => {
                const t = e.target.value.trim();
                if (!t) return set({ contractDailyMinutes: null });
                const m = /^(\d{1,2}):(\d{2})$/.exec(t);
                if (m && +m[2] < 60 && +m[1] * 60 + +m[2] > 0) set({ contractDailyMinutes: +m[1] * 60 + +m[2] });
              }}
            />
          </Field>
        </div>
        <Checkbox checked={s.nightRulesEnabled} onChange={(v) => set({ nightRulesEnabled: v })} label="להחיל כללי משמרת לילה (תקן 7 שעות כששעתיים לפחות בין 22:00 ל-06:00)" />
      </Section>

      <Section title="מנוחה שבועית וחגים" note="חלון המנוחה לעובד יהודי מחושב משקיעת החמה ביום שישי ועד צאת הכוכבים במוצאי שבת, לפי העיר שנבחרה.">
        <div className="grid grid-cols-2 gap-3">
          <Field label="יום המנוחה השבועית">
            <Select
              value={s.weeklyRest.kind === 'shabbat' ? 'shabbat' : `fixed_${s.weeklyRest.fixedDay}`}
              onChange={(v) =>
                set({
                  weeklyRest:
                    v === 'shabbat'
                      ? { ...s.weeklyRest, kind: 'shabbat', fixedDay: null }
                      : { ...s.weeklyRest, kind: 'fixed_day', fixedDay: +v.split('_')[1] as Weekday },
                })
              }
              options={[
                { value: 'shabbat', label: 'שבת (עובד יהודי) – משקיעה עד צאת הכוכבים' },
                { value: 'fixed_5', label: 'יום שישי (יממה קלנדרית)' },
                { value: 'fixed_6', label: 'יום שבת (יממה קלנדרית)' },
                { value: 'fixed_0', label: 'יום ראשון (יממה קלנדרית)' },
              ]}
            />
          </Field>
          <Field label="עיר לחישוב זמני כניסה/יציאה">
            <Select value={s.location} onChange={(v) => set({ location: v })} options={ISRAELI_CITIES} />
          </Field>
          <Field label="הרחבת החלון לפני תחילתו (דקות)">
            <input
              type="number"
              min={0}
              className="field-input num text-left"
              value={s.weeklyRest.startOffsetMinutes}
              onChange={(e) => set({ weeklyRest: { ...s.weeklyRest, startOffsetMinutes: Math.max(0, Math.floor(+e.target.value || 0)) } })}
            />
          </Field>
          <Field label="הרחבת החלון אחרי סיומו (דקות)">
            <input
              type="number"
              min={0}
              className="field-input num text-left"
              value={s.weeklyRest.endOffsetMinutes}
              onChange={(e) => set({ weeklyRest: { ...s.weeklyRest, endOffsetMinutes: Math.max(0, Math.floor(+e.target.value || 0)) } })}
            />
          </Field>
        </div>
        <Field label="לוח חגים" className="mt-3">
          <Select
            value={s.holidayCalendar}
            onChange={(v) => set({ holidayCalendar: v })}
            options={[
              { value: 'jewish_israel', label: 'חגי ישראל (ימי שבתון + יום העצמאות) – זיהוי אוטומטי' },
              { value: 'none', label: 'ללא חגים אוטומטיים – רק חגים שהוגדרו לעסק' },
            ]}
          />
        </Field>
      </Section>

      <Section title="הפסקות" note="מדיניות ההפסקה האוטומטית היא פרמטר חישוב של המשרד ואינה כלל חוקי מחייב. ניכוי משוער מסומן עד לאישור שההפסקה ניתנה בפועל.">
        <Field label="שיטת חישוב ההפסקה">
          <Select
            value={s.breakMethod}
            onChange={(v) => set({ breakMethod: v })}
            options={(Object.keys(BREAK_METHOD_LABELS) as EmployeeSettings['breakMethod'][]).map((k) => ({ value: k, label: BREAK_METHOD_LABELS[k] }))}
          />
        </Field>
        {s.breakMethod === 'company_auto' && (
          <div className="mt-3 grid grid-cols-4 gap-3 rounded-xl border border-line bg-slate-50/60 p-4">
            <Field label="סף משמרת (ש:דד)" hint="עד וכולל הסף – הפסקה קצרה">
              <MinutesInput value={p.thresholdMinutes} onChange={(v) => set({ companyBreakPolicy: { ...p, thresholdMinutes: v } })} />
            </Field>
            <Field label="הפסקה קצרה (דקות)">
              <input type="number" min={0} className="field-input num text-left" value={p.shortBreakMinutes} onChange={(e) => set({ companyBreakPolicy: { ...p, shortBreakMinutes: Math.max(0, Math.floor(+e.target.value || 0)) } })} />
            </Field>
            <Field label="הפסקה ארוכה (דקות)" hint="מעל הסף">
              <input type="number" min={0} className="field-input num text-left" value={p.longBreakMinutes} onChange={(e) => set({ companyBreakPolicy: { ...p, longBreakMinutes: Math.max(0, Math.floor(+e.target.value || 0)) } })} />
            </Field>
            <Field label="משמרת מינימלית להפעלה (ש:דד)" hint="משמרת קצרה יותר – ללא ניכוי">
              <MinutesInput value={p.minShiftMinutes} onChange={(v) => set({ companyBreakPolicy: { ...p, minShiftMinutes: v } })} />
            </Field>
          </div>
        )}
      </Section>

      <Section title="שכר ופרמטרים מתקדמים">
        <div className="grid grid-cols-2 gap-3">
          <Field label="שכר שעתי (₪, אופציונלי)" hint="להערכת עלות בלבד – אינו חישוב שכר ברוטו-נטו">
            <input
              className="field-input num text-left"
              inputMode="decimal"
              defaultValue={s.hourlyRateAgorot === null ? '' : (s.hourlyRateAgorot / 100).toFixed(2)}
              onChange={(e) => {
                const t = e.target.value.trim();
                if (!t) return set({ hourlyRateAgorot: null });
                const m = /^(\d{1,6})(?:\.(\d{1,2}))?$/.exec(t);
                if (m) set({ hourlyRateAgorot: +m[1] * 100 + (m[2] ? +m[2].padEnd(2, '0') : 0) });
              }}
            />
          </Field>
          <Field label="סף אזהרה למנוחה בין משמרות (שעות)" hint="אזהרה משרדית – לא כלל חוקי כללי שאומת">
            <input
              type="number"
              min={0}
              className="field-input num text-left"
              value={s.restBetweenShiftsWarnMinutes / 60}
              onChange={(e) => set({ restBetweenShiftsWarnMinutes: Math.max(0, Math.round((+e.target.value || 0) * 60)) })}
            />
          </Field>
          <Field label="דירוג שעות נוספות שבועיות">
            <Select
              value={s.weeklyOvertimeTiering}
              onChange={(v) => set({ weeklyOvertimeTiering: v })}
              options={[
                { value: 'per_day', label: 'לפי יום – שעתיים ראשונות של כל יום ב-125%' },
                { value: 'per_week', label: 'לפי שבוע – שעתיים ראשונות מעבר לתקן השבועי ב-125%' },
              ]}
            />
          </Field>
          <div className="pt-6">
            <Checkbox checked={s.restMinutesCountTowardWeekly} onChange={(v) => set({ restMinutesCountTowardWeekly: v })} label="שעות במנוחה/חג נספרות במכסת 42 השעות השבועית" />
          </div>
        </div>
      </Section>
    </div>
  );
}

export { defaultEmployeeSettings };
