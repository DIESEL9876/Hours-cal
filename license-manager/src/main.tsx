import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles.css';
import { App } from './App';
import { isTauri, tauriApi } from './api';
import type { LmApi } from './types';

/** The desktop backend; browser previews / UI tests inject a mock via window.__LM_TEST_API__. */
function resolveApi(): LmApi | null {
  if (isTauri()) return tauriApi;
  return (window as unknown as { __LM_TEST_API__?: LmApi }).__LM_TEST_API__ ?? null;
}

const api = resolveApi();
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {api ? (
      <App api={api} />
    ) : (
      <div dir="rtl" className="p-10 text-ink">
        יישום זה פועל רק כתוכנת Windows (Hours-Cal License Manager).
      </div>
    )}
  </React.StrictMode>,
);
