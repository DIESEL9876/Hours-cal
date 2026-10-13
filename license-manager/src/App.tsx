import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { UiProvider } from '../../src/ui/components';
import { IconBook, IconKey, IconMonitor, IconShield } from './icons';
import type { AppInfo, IssueRequest, LmApi, VaultStatus } from './types';
import { asApiError } from './types';
import { SetupScreen } from './screens/Setup';
import { DashboardScreen } from './screens/Dashboard';
import { MyComputerScreen } from './screens/MyComputer';
import { HelpScreen } from './screens/Help';
import { IssueDialog } from './screens/IssueDialog';
import { BackupDialog, RestoreDialog } from './screens/BackupDialogs';

export const COPYRIGHT = '© 2026 עילי נגר | כל הזכויות שמורות';

export type Route = 'dashboard' | 'myComputer' | 'help';

interface LmContext {
  api: LmApi;
  info: AppInfo;
  vault: VaultStatus;
  /** Reload vault status, app info and (via `version`) every screen's data. */
  refresh: () => Promise<void>;
  version: number;
  go: (r: Route) => void;
  openIssue: (prefill?: Partial<IssueRequest>) => void;
  openBackup: () => void;
  openRestore: () => void;
}

const Ctx = createContext<LmContext | null>(null);

export function useLm(): LmContext {
  const c = useContext(Ctx);
  if (!c) throw new Error('LmContext missing');
  return c;
}

export function App({ api }: { api: LmApi }) {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [vault, setVault] = useState<VaultStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [route, setRoute] = useState<Route>('dashboard');
  const [version, setVersion] = useState(0);
  const [issue, setIssue] = useState<Partial<IssueRequest> | null>(null);
  const [backupOpen, setBackupOpen] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [i, v] = await Promise.all([api.appInfo(), api.vaultStatus()]);
      setInfo(i);
      setVault(v);
      setVersion((x) => x + 1);
      setError(null);
    } catch (e) {
      setError(asApiError(e).message);
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const ctx = useMemo<LmContext | null>(
    () =>
      info && vault
        ? {
            api,
            info,
            vault,
            refresh,
            version,
            go: setRoute,
            openIssue: (p) => setIssue(p ?? {}),
            openBackup: () => setBackupOpen(true),
            openRestore: () => setRestoreOpen(true),
          }
        : null,
    [api, info, vault, refresh, version],
  );

  if (error)
    return (
      <div dir="rtl" className="p-10" role="alert">
        <h1 className="mb-2 text-xl font-bold text-red-700">שגיאה בפתיחת מנהל הרישיונות</h1>
        <p className="text-[14px] text-ink">{error}</p>
      </div>
    );
  if (!ctx) return null;

  const ready = ctx.vault.state === 'ready';
  let screen: ReactNode;
  if (!ready) screen = <SetupScreen />;
  else if (route === 'myComputer') screen = <MyComputerScreen />;
  else if (route === 'help') screen = <HelpScreen />;
  else screen = <DashboardScreen />;

  return (
    <Ctx.Provider value={ctx}>
      <UiProvider>
        <div dir="rtl" className="flex min-h-full flex-col">
          <header className="sticky top-0 z-30 border-b border-line bg-white/90 backdrop-blur">
            <div className="mx-auto flex h-14 max-w-[1500px] items-center justify-between px-6">
              <button className="flex items-center gap-2.5" onClick={() => setRoute('dashboard')}>
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand text-white">
                  <IconKey size={18} />
                </span>
                <span className="text-[15px] font-semibold text-ink">Hours-Cal · ניהול רישיונות</span>
                <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800 ring-1 ring-amber-200">לשימוש בעל התוכנה בלבד</span>
              </button>
              {ready && (
                <nav className="flex items-center gap-1 text-[13px]">
                  <NavLink active={route === 'dashboard'} onClick={() => setRoute('dashboard')} icon={<IconShield size={16} />}>
                    רישיונות
                  </NavLink>
                  <NavLink active={route === 'myComputer'} onClick={() => setRoute('myComputer')} icon={<IconMonitor size={16} />}>
                    פרטי המחשב שלי
                  </NavLink>
                  <NavLink active={route === 'help'} onClick={() => setRoute('help')} icon={<IconBook size={16} />}>
                    הוראות שימוש
                  </NavLink>
                </nav>
              )}
            </div>
          </header>
          <main className="mx-auto w-full max-w-[1500px] flex-1 px-6 py-6">{screen}</main>
          <footer className="px-6 py-3 text-center text-[12px] text-ink-soft" data-testid="copyright-footer">
            {COPYRIGHT} · Hours-Cal License Manager גרסה {info?.version}
          </footer>
        </div>
        {ready && issue && <IssueDialog prefill={issue} onClose={() => setIssue(null)} />}
        {ready && backupOpen && <BackupDialog onClose={() => setBackupOpen(false)} />}
        {restoreOpen && <RestoreDialog onClose={() => setRestoreOpen(false)} />}
      </UiProvider>
    </Ctx.Provider>
  );
}

function NavLink({ active, onClick, icon, children }: { active: boolean; onClick: () => void; icon: ReactNode; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 font-medium transition ${active ? 'bg-brand-soft text-brand' : 'text-ink-soft hover:bg-slate-100 hover:text-ink'}`}
    >
      {icon}
      {children}
    </button>
  );
}
