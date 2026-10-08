import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles.css';
import { App } from './ui/App';
import { Repository } from './data/repo';
import { isTauri, TauriDriver } from './data/tauriDriver';
import type { SqlDriver } from './data/driver';

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

async function boot() {
  const root = ReactDOM.createRoot(document.getElementById('root')!);
  try {
    const repo = new Repository(await openDriver());
    await repo.migrate();
    root.render(
      <React.StrictMode>
        <App repo={repo} />
      </React.StrictMode>,
    );
  } catch (e) {
    root.render(
      <div dir="rtl" className="p-10 text-red-700">
        <h1 className="mb-2 text-xl font-bold">שגיאה בפתיחת מסד הנתונים</h1>
        <pre className="whitespace-pre-wrap text-sm">{String(e)}</pre>
      </div>,
    );
  }
}

boot();
