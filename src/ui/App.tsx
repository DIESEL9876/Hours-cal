import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Repository } from '../data/repo';
import { UiProvider } from './components';
import { IconBook, IconClock, IconDatabase } from './icons';
import { BusinessesScreen } from './screens/Businesses';
import { EmployeesScreen } from './screens/Employees';
import { AttendanceScreen } from './screens/Attendance';
import { SummaryScreen } from './screens/Summary';
import { BackupsScreen } from './screens/Backups';
import { LegalScreen } from './screens/Legal';

export type Route =
  | { name: 'businesses' }
  | { name: 'employees'; businessId: string }
  | { name: 'attendance'; businessId: string; employeeId: string }
  | { name: 'summary'; businessId: string }
  | { name: 'backups' }
  | { name: 'legal' };

export interface YearMonth {
  year: number;
  month: number;
}

interface AppApi {
  repo: Repository;
  route: Route;
  go: (r: Route) => void;
  ym: YearMonth;
  setYm: (ym: YearMonth) => void;
  /** Incremented after data changes elsewhere (e.g. restore) so screens reload. */
  dataVersion: number;
  bumpData: () => void;
}

const AppContext = createContext<AppApi | null>(null);

export function useApp(): AppApi {
  const c = useContext(AppContext);
  if (!c) throw new Error('AppContext missing');
  return c;
}

function initialYm(): YearMonth {
  const d = new Date();
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}

export function App({ repo }: { repo: Repository }) {
  const [route, setRoute] = useState<Route>({ name: 'businesses' });
  const [ym, setYm] = useState<YearMonth>(initialYm);
  const [dataVersion, setDataVersion] = useState(0);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [route]);

  const api: AppApi = { repo, route, go: setRoute, ym, setYm, dataVersion, bumpData: () => setDataVersion((v) => v + 1) };

  let screen: ReactNode;
  switch (route.name) {
    case 'businesses':
      screen = <BusinessesScreen />;
      break;
    case 'employees':
      screen = <EmployeesScreen key={route.businessId} businessId={route.businessId} />;
      break;
    case 'attendance':
      screen = <AttendanceScreen key={route.employeeId} businessId={route.businessId} employeeId={route.employeeId} />;
      break;
    case 'summary':
      screen = <SummaryScreen key={route.businessId} businessId={route.businessId} />;
      break;
    case 'backups':
      screen = <BackupsScreen />;
      break;
    case 'legal':
      screen = <LegalScreen />;
      break;
  }

  return (
    <AppContext.Provider value={api}>
      <UiProvider>
        <div className="flex min-h-full flex-col">
          <header className="no-print sticky top-0 z-30 border-b border-line bg-white/90 backdrop-blur">
            <div className="mx-auto flex h-14 max-w-[1600px] items-center justify-between px-6">
              <button className="flex items-center gap-2.5" onClick={() => setRoute({ name: 'businesses' })}>
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand text-white">
                  <IconClock size={18} />
                </span>
                <span className="text-[15px] font-semibold text-ink">מערכת נוכחות ושעות נוספות</span>
              </button>
              <nav className="flex items-center gap-1 text-[13px]">
                <NavLink active={route.name === 'legal'} onClick={() => setRoute({ name: 'legal' })} icon={<IconBook size={16} />}>
                  כללי החישוב
                </NavLink>
                <NavLink active={route.name === 'backups'} onClick={() => setRoute({ name: 'backups' })} icon={<IconDatabase size={16} />}>
                  גיבוי ונתונים
                </NavLink>
              </nav>
            </div>
          </header>
          <main className="mx-auto w-full max-w-[1600px] flex-1 px-6 py-6">{screen}</main>
        </div>
      </UiProvider>
    </AppContext.Provider>
  );
}

function NavLink({ active, onClick, icon, children }: { active: boolean; onClick: () => void; icon: ReactNode; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 font-medium transition ${active ? 'bg-brand-soft text-brand' : 'text-ink-soft hover:bg-slate-100 hover:text-ink'}`}
    >
      {icon}
      {children}
    </button>
  );
}

export function Crumbs({ items }: { items: { label: string; onClick?: () => void }[] }) {
  return (
    <nav className="flex flex-wrap items-center gap-1.5">
      {items.map((it, i) => (
        <span key={i} className="flex items-center gap-1.5">
          {i > 0 && <span className="text-slate-300">←</span>}
          {it.onClick ? (
            <button className="hover:text-brand hover:underline" onClick={it.onClick}>
              {it.label}
            </button>
          ) : (
            <span className="text-ink">{it.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}
