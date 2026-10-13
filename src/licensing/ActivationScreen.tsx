import { useEffect, useState } from "react";
import type { LicensingApi, Route } from "./types";
import { CopyrightFooter } from "./CopyrightFooter";

interface Props {
  api: LicensingApi;
  deviceId: string;
  reasonHe: string | null;
  recoveryAvailable: boolean;
  onActivated: (r: Route) => void;
  onOpenRecovery: () => void;
}

export function ActivationScreen({ api, deviceId, reasonHe, recoveryAvailable, onActivated, onOpenRecovery }: Props) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [done, setDone] = useState<Route | null>(null);
  const [fallback, setFallback] = useState(false);

  useEffect(() => { api.deviceId().then((d) => setFallback(d.fallback)).catch(() => {}); }, [api]);

  async function run(p: Promise<Route | null>) {
    setBusy(true); setError(null);
    try {
      const r = await p;
      if (!r) return;
      if (r.route === "ready") setDone(r);
      else setError(r.route === "activation" && r.reasonHe ? r.reasonHe : "הרישיון לא הופעל.");
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }

  if (done && done.route === "ready") {
    return (
      <main className="hc-activate" dir="rtl" lang="he">
        <h1>הרישיון הופעל בהצלחה</h1>
        <dl className="hc-activate__facts">
          <dt>בעל הרישיון</dt><dd>{done.licensee}{done.organization ? `, ${done.organization}` : ""}</dd>
          <dt>מספר רישיון</dt><dd dir="ltr">{done.licenseId}</dd>
          <dt>תוקף</dt><dd>{done.expiresAt ? `עד ${done.expiresAt}` : "ללא הגבלת זמן"}</dd>
        </dl>
        <button type="button" className="hc-btn hc-btn--primary" onClick={() => onActivated(done)}>המשך לבחירת עסק</button>
        <CopyrightFooter />
      </main>
    );
  }

  return (
    <main className="hc-activate" dir="rtl" lang="he">
      <h1>הפעלת רישיון</h1>
      {reasonHe && <p className="hc-activate__reason" role="alert">{reasonHe}</p>}
      <p>כדי להשתמש ב-Hours-Cal במחשב זה נדרש רישיון שהונפק עבורו. שלחו את מזהה ההפעלה לבעל התוכנה, והדביקו כאן את מפתח ההפעלה שתקבלו או ייבאו את קובץ הרישיון.</p>

      <section className="hc-activate__device" aria-label="מזהה הפעלה של מחשב זה">
        <h2>מזהה ההפעלה של מחשב זה</h2>
        <code dir="ltr" data-testid="device-id">{deviceId}</code>
        <button type="button" className="hc-btn" onClick={async () => { await api.copyText(deviceId); setCopied(true); }}>
          {copied ? "המזהה הועתק" : "העתקת המזהה"}
        </button>
        <p className="hc-activate__note">
          המזהה מחושב במחשב זה בלבד ואינו כולל שם משתמש, שם מחשב או פרטי חומרה. הוא אינו נשלח לשום מקום אלא אם תעתיקו ותשלחו אותו בעצמכם.
          {fallback && " לא ניתן היה לקרוא את מזהה Windows, ולכן נוצר מזהה מקומי. מזהה זה ישתנה אם תיקיית ההגדרות של התוכנה תימחק."}
        </p>
      </section>

      <section className="hc-activate__input" aria-label="הזנת רישיון">
        <label htmlFor="hc-key">מפתח הפעלה</label>
        <textarea id="hc-key" dir="ltr" rows={5} value={key} onChange={(e) => setKey(e.target.value)} spellCheck={false} />
        {error && <p className="hc-activate__error" role="alert">{error}</p>}
        <div className="hc-legal__actions">
          <button type="button" className="hc-btn hc-btn--primary" disabled={!key.trim() || busy} onClick={() => run(api.activate(key))}>
            הפעלת הרישיון
          </button>
          <button type="button" className="hc-btn" disabled={busy} onClick={() => run(api.pickAndImportLicenseFile())}>
            ייבוא קובץ רישיון
          </button>
        </div>
      </section>

      {recoveryAvailable && (
        <section className="hc-activate__recovery">
          <p>הנתונים הקיימים במחשב זה שמורים ולא נמחקו. ניתן לייצא אותם גם ללא רישיון פעיל.</p>
          <button type="button" className="hc-btn hc-btn--quiet" onClick={onOpenRecovery}>ייצוא נתונים קיימים (קריאה בלבד)</button>
        </section>
      )}
      <CopyrightFooter />
    </main>
  );
}
