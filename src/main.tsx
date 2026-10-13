import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import './styles.css';
import './licensing/licensing.css';
import { App } from './ui/App';
import { Repository } from './data/repo';
import { isTauri, TauriDriver } from './data/tauriDriver';
import type { SqlDriver } from './data/driver';
import { LicensingGate, tauriLicensingApi, type LicensingApi } from './licensing';

async function openDriver(): Promise<SqlDriver> {
  if (isTauri()) return new TauriDriver();
  const [{ default: initSqlJs }, { default: wasmUrl }, { SqlJsDriver, indexedDbPersistence }] = await Promise.all([
    import('sql.js'),
    import('sql.js/dist/sql-wasm.wasm?url'),
    import('./data/sqljsDriver'),
  ]);
  const SQL = await initSqlJs({ locateFile: () => wasmUrl });
  return SqlJsDriver.open(SQL, indexedDbPersistence);
}

/**
 * Licensing is enforced by the desktop (Tauri) backend. The browser preview used for development
 * and automated UI tests has no backend; tests may inject a fake API via window.__HC_LICENSING_TEST_API__.
 */
function licensingApi(): LicensingApi | null {
  if (isTauri()) return tauriLicensingApi;
  return (window as unknown as { __HC_LICENSING_TEST_API__?: LicensingApi }).__HC_LICENSING_TEST_API__ ?? null;
}

let repoPromise: Promise<Repository> | null = null;
/** Opened once, and only after the licensing gate is open (the backend refuses data access before). */
function openRepository(): Promise<Repository> {
  repoPromise ??= (async () => {
    const repo = new Repository(await openDriver());
    await repo.migrate();
    return repo;
  })();
  return repoPromise;
}

function DataApp({ licensing }: { licensing: LicensingApi | null }) {
  const [repo, setRepo] = useState<Repository | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    openRepository().then(setRepo, (e) => setError(String(e)));
  }, []);
  if (error)
    return (
      <div dir="rtl" className="p-10 text-red-700">
        <h1 className="mb-2 text-xl font-bold">שגיאה בפתיחת מסד הנתונים</h1>
        <pre className="whitespace-pre-wrap text-sm">{error}</pre>
      </div>
    );
  if (!repo) return null;
  return <App repo={repo} licensing={licensing} />;
}

const licensing = licensingApi();
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {licensing ? (
      <LicensingGate api={licensing}>
        <DataApp licensing={licensing} />
      </LicensingGate>
    ) : (
      <DataApp licensing={null} />
    )}
  </React.StrictMode>,
);
