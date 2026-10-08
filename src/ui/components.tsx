import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { IconAlert, IconCheck, IconInfo, IconX } from './icons';
import type { Severity } from '../engine';

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  children,
  className = '',
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md'; icon?: ReactNode }) {
  const v: Record<Variant, string> = {
    primary: 'bg-brand text-white hover:bg-brand-dark shadow-sm shadow-brand/20 disabled:bg-slate-300 disabled:shadow-none',
    secondary: 'bg-white text-ink border border-line hover:bg-slate-50 hover:border-slate-300 disabled:text-slate-400',
    ghost: 'text-ink-soft hover:bg-slate-100 hover:text-ink disabled:text-slate-300',
    danger: 'bg-red-600 text-white hover:bg-red-700 disabled:bg-red-300',
  };
  const s = size === 'sm' ? 'h-8 px-2.5 text-[13px] gap-1.5' : 'h-10 px-4 text-[14px] gap-2';
  return (
    <button
      type="button"
      className={`inline-flex shrink-0 items-center justify-center rounded-lg font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 disabled:cursor-not-allowed ${v[variant]} ${s} ${className}`}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
}

export function IconButton({ label, children, className = '', ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-md text-ink-soft transition hover:bg-slate-100 hover:text-ink disabled:opacity-30 ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Form fields
// ---------------------------------------------------------------------------

export function Field({ label, hint, error, children, className = '' }: { label: string; hint?: ReactNode; error?: string | null; children: ReactNode; className?: string }) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1.5 block text-[13px] font-medium text-ink">{label}</span>
      {children}
      {hint && !error && <span className="mt-1 block text-[12px] leading-snug text-ink-soft">{hint}</span>}
      {error && <span className="mt-1 block text-[12px] text-red-600">{error}</span>}
    </label>
  );
}

export function Select<T extends string | number>({
  value,
  onChange,
  options,
  className = '',
  ...rest
}: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[] } & Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'onChange' | 'value'>) {
  return (
    <select
      className={`field-input ${className}`}
      value={String(value)}
      onChange={(e) => {
        const o = options.find((x) => String(x.value) === e.target.value);
        if (o) onChange(o.value);
      }}
      {...rest}
    >
      {options.map((o) => (
        <option key={String(o.value)} value={String(o.value)}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Checkbox({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: ReactNode }) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 py-1">
      <input type="checkbox" className="mt-0.5 h-4 w-4 accent-brand" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <span className="text-[14px] text-ink">{label}</span>
        {hint && <span className="block text-[12px] text-ink-soft">{hint}</span>}
      </span>
    </label>
  );
}

export function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[] }) {
  return (
    <div className="inline-flex rounded-lg border border-line bg-slate-50 p-0.5" role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={`rounded-md px-3 py-1.5 text-[13px] font-medium transition ${value === o.value ? 'bg-white text-ink shadow-sm' : 'text-ink-soft hover:text-ink'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export function Card({ children, className = '', ...rest }: { children: ReactNode; className?: string } & React.HTMLAttributes<HTMLDivElement> & { 'data-testid'?: string }) {
  return (
    <div className={`rounded-xl border border-line bg-white shadow-[0_1px_2px_rgba(15,27,45,0.04)] ${className}`} {...rest}>
      {children}
    </div>
  );
}

export function PageHeader({ title, subtitle, breadcrumbs, actions }: { title: ReactNode; subtitle?: ReactNode; breadcrumbs?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="no-print mb-5 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {breadcrumbs && <div className="mb-1.5 text-[13px] text-ink-soft">{breadcrumbs}</div>}
        <h1 className="truncate text-[24px] font-semibold tracking-tight text-ink">{title}</h1>
        {subtitle && <div className="mt-1 text-[14px] text-ink-soft">{subtitle}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function EmptyState({ icon, title, text, action }: { icon: ReactNode; title: string; text?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-soft text-brand">{icon}</div>
      <div className="text-[16px] font-semibold text-ink">{title}</div>
      {text && <div className="mt-1 max-w-md text-[14px] text-ink-soft">{text}</div>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Badge({ tone = 'slate', children, title }: { tone?: 'slate' | 'blue' | 'amber' | 'red' | 'green' | 'violet'; children: ReactNode; title?: string }) {
  const t = {
    slate: 'bg-slate-100 text-slate-700',
    blue: 'bg-blue-50 text-blue-700 ring-1 ring-blue-100',
    amber: 'bg-amber-50 text-amber-800 ring-1 ring-amber-200',
    red: 'bg-red-50 text-red-700 ring-1 ring-red-200',
    green: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200',
    violet: 'bg-violet-50 text-violet-700 ring-1 ring-violet-200',
  }[tone];
  return (
    <span title={title} className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[12px] font-medium ${t}`}>
      {children}
    </span>
  );
}

export const severityTone: Record<Severity, 'red' | 'amber' | 'violet' | 'slate'> = {
  error: 'red',
  review: 'amber',
  compliance: 'violet',
  info: 'slate',
};

export const severityLabel: Record<Severity, string> = {
  error: 'שגיאה',
  review: 'לבדיקה',
  compliance: 'אזהרת ציות',
  info: 'מידע',
};

// ---------------------------------------------------------------------------
// Modal / drawer
// ---------------------------------------------------------------------------

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  width = 'max-w-xl',
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="no-print fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/30 p-6 backdrop-blur-[2px]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal className={`my-8 w-full ${width} rounded-2xl bg-white shadow-2xl ring-1 ring-black/5`}>
        <div className="flex items-center justify-between border-b border-line px-6 py-4">
          <h2 className="text-[17px] font-semibold text-ink">{title}</h2>
          <IconButton label="סגירה" onClick={onClose}>
            <IconX />
          </IconButton>
        </div>
        <div className="px-6 py-5">{children}</div>
        {footer && <div className="flex items-center justify-start gap-2 rounded-b-2xl border-t border-line bg-slate-50/60 px-6 py-3.5">{footer}</div>}
      </div>
    </div>
  );
}

export function Drawer({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="no-print fixed inset-0 z-40 bg-slate-900/20" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="absolute inset-y-0 left-0 flex w-full max-w-[480px] flex-col bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 className="text-[16px] font-semibold">{title}</h2>
          <IconButton label="סגירה" onClick={onClose}>
            <IconX />
          </IconButton>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toasts and confirmation dialogs
// ---------------------------------------------------------------------------

interface Toast {
  id: number;
  tone: 'success' | 'error' | 'info';
  text: string;
}

interface ConfirmOptions {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  /** When set, the user must type this text to enable the confirm button. */
  typeToConfirm?: string;
}

interface UiApi {
  toast: (text: string, tone?: Toast['tone']) => void;
  confirm: (o: ConfirmOptions) => Promise<boolean>;
}

const UiContext = createContext<UiApi | null>(null);

export function useUi(): UiApi {
  const c = useContext(UiContext);
  if (!c) throw new Error('UiProvider missing');
  return c;
}

export function UiProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [confirm, setConfirm] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null);
  const [typed, setTyped] = useState('');
  const seq = useRef(0);

  const toast = useCallback((text: string, tone: Toast['tone'] = 'success') => {
    const id = ++seq.current;
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 7000 : 3500);
  }, []);

  const ask = useCallback((o: ConfirmOptions) => {
    setTyped('');
    return new Promise<boolean>((resolve) => setConfirm({ ...o, resolve }));
  }, []);

  const close = (v: boolean) => {
    confirm?.resolve(v);
    setConfirm(null);
  };

  // Stable identity: screens list `ui` in effect dependencies, so a new object per toast would reload them.
  const api = useMemo(() => ({ toast, confirm: ask }), [toast, ask]);

  return (
    <UiContext.Provider value={api}>
      {children}
      <div className="no-print pointer-events-none fixed bottom-24 left-6 z-[60] flex flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className={`pointer-events-auto flex max-w-sm items-start gap-2 rounded-xl px-4 py-3 text-[14px] shadow-lg ring-1 ${
              t.tone === 'error' ? 'bg-red-50 text-red-800 ring-red-200' : t.tone === 'info' ? 'bg-white text-ink ring-line' : 'bg-emerald-50 text-emerald-800 ring-emerald-200'
            }`}
          >
            <span className="mt-0.5">{t.tone === 'error' ? <IconAlert size={16} /> : t.tone === 'info' ? <IconInfo size={16} /> : <IconCheck size={16} />}</span>
            <span className="whitespace-pre-line">{t.text}</span>
          </div>
        ))}
      </div>
      <Modal
        open={!!confirm}
        onClose={() => close(false)}
        title={confirm?.title}
        width="max-w-md"
        footer={
          <>
            <Button
              variant={confirm?.danger ? 'danger' : 'primary'}
              disabled={!!confirm?.typeToConfirm && typed.trim() !== confirm.typeToConfirm}
              onClick={() => close(true)}
            >
              {confirm?.confirmLabel ?? 'אישור'}
            </Button>
            <Button onClick={() => close(false)}>ביטול</Button>
          </>
        }
      >
        <div className="text-[14px] leading-relaxed text-ink">{confirm?.message}</div>
        {confirm?.typeToConfirm && (
          <Field label={`להמשך יש להקליד: ${confirm.typeToConfirm}`} className="mt-4">
            <input className="field-input" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
          </Field>
        )}
      </Modal>
    </UiContext.Provider>
  );
}
