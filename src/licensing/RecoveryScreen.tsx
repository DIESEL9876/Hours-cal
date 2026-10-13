import { useEffect, useState } from "react";
import type { ExportReport, LicensingApi, TableSummary } from "./types";
import { CopyrightFooter } from "./CopyrightFooter";

export function RecoveryScreen({ api, onBack }: { api: LicensingApi; onBack: () => void }) {
  const [tables, setTables] = useState<TableSummary[] | null>(null);
  const [report, setReport] = useState<ExportReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { api.recoveryTables().then(setTables).catch((e) => setError(String(e))); }, [api]);

  async function exportAll() {
    setBusy(true); setError(null);
    try { const r = await api.pickFolderAndExport(); if (r) setReport(r); }
    catch (e) { setError(String(e)); } finally { setBusy(false); }
  }

  return (
    <main className="hc-activate" dir="rtl" lang="he">
      <h1>ייצוא נתונים במצב שחזור</h1>
      <p>מצב זה מאפשר לשמור עותק של כל הנתונים הקיימים: עסקים, עובדים ורישומי נוכחות. הנתונים נקראים מעותק זמני בלבד. מסד הנתונים המקורי אינו נפתח לעריכה ואינו משתנה.</p>
      {tables && (
        <table className="hc-recovery__tables">
          <thead><tr><th>טבלה</th><th>שורות</th></tr></thead>
          <tbody>{tables.map((t) => <tr key={t.table}><td dir="ltr">{t.table}</td><td>{t.rows}</td></tr>)}</tbody>
        </table>
      )}
      {error && <p className="hc-activate__error" role="alert">{error}</p>}
      {report && (
        <p className="hc-legal__ok" role="status">
          הייצוא הושלם. נשמרו קובצי CSV לכל טבלה ועותק מלא של הנתונים בתיקייה: <span dir="ltr">{report.folder}</span>
        </p>
      )}
      <div className="hc-legal__actions">
        <button type="button" className="hc-btn hc-btn--primary" disabled={busy || !tables} onClick={exportAll}>בחירת תיקייה וייצוא</button>
        <button type="button" className="hc-btn hc-btn--quiet" onClick={onBack}>חזרה להפעלת רישיון</button>
      </div>
      <CopyrightFooter />
    </main>
  );
}
