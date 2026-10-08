import { HEBREW_MONTHS } from '../engine';
import type { YearMonth } from './App';
import { IconChevronLeft, IconChevronRight } from './icons';

export function shiftMonth(ym: YearMonth, delta: number): YearMonth {
  const idx = ym.year * 12 + (ym.month - 1) + delta;
  return { year: Math.floor(idx / 12), month: (idx % 12) + 1 };
}

export function MonthPicker({ value, onChange }: { value: YearMonth; onChange: (v: YearMonth) => void }) {
  const years: number[] = [];
  for (let y = value.year - 5; y <= value.year + 2; y++) years.push(y);
  return (
    <div className="flex items-center gap-1 rounded-lg border border-line bg-white p-1">
      <button className="flex h-8 w-8 items-center justify-center rounded-md text-ink-soft hover:bg-slate-100" title="חודש קודם" onClick={() => onChange(shiftMonth(value, -1))}>
        <IconChevronRight size={18} />
      </button>
      <select
        aria-label="חודש"
        className="h-8 rounded-md bg-transparent px-1 text-[14px] font-medium outline-none hover:bg-slate-50"
        value={value.month}
        onChange={(e) => onChange({ ...value, month: +e.target.value })}
      >
        {HEBREW_MONTHS.map((m, i) => (
          <option key={m} value={i + 1}>
            {m}
          </option>
        ))}
      </select>
      <select
        aria-label="שנה"
        className="h-8 rounded-md bg-transparent px-1 text-[14px] font-medium outline-none hover:bg-slate-50"
        value={value.year}
        onChange={(e) => onChange({ ...value, year: +e.target.value })}
      >
        {years.map((y) => (
          <option key={y} value={y}>
            {y}
          </option>
        ))}
      </select>
      <button className="flex h-8 w-8 items-center justify-center rounded-md text-ink-soft hover:bg-slate-100" title="חודש הבא" onClick={() => onChange(shiftMonth(value, 1))}>
        <IconChevronLeft size={18} />
      </button>
    </div>
  );
}
