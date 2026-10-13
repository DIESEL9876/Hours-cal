import { useCallback, useEffect, useState } from "react";
import type { LicenseStatus, LicensingApi, Route } from "./types";

/**
 * Hours-Cal integration: licence status inside the app ("מסמכים משפטיים ורישיון").
 * Shows this computer's device ID and the installed licence, and lets the owner import a licence.
 * In a build without an embedded public key the requirement is not enforced yet; an imported
 * licence is stored and its signature is verified automatically once enforcement is enabled.
 */
export function LicenseStatusPanel({ api }: { api: LicensingApi }) {
  const [status, setStatus] = useState<LicenseStatus | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(() => {
    api.licenseStatus?.().then(setStatus).catch((e) => setError(String(e)));
  }, [api]);
  useEffect(load, [load]);

  async function run(p: Promise<Route | null>) {
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      const r = await p;
      if (!r) return;
      if (r.route === "activation" && r.reasonHe) setError(r.reasonHe);
      else {
        setOk("קובץ הרישיון נשמר במחשב זה.");
        setKey("");
      }
      load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!status) return <section className="hc-settings-legal" dir="rtl" aria-busy="true" />;

  const stateText: Record<LicenseStatus["state"], string> = {
    valid: "רישיון תקף ומאומת",
    pending: "רישיון שמור – החתימה תאומת כאשר דרישת הרישיון תופעל",
    invalid: "הרישיון השמור אינו תקף",
    none: "לא הותקן רישיון",
  };

  return (
    <section className="hc-settings-legal hc-license-status" dir="rtl" lang="he" aria-labelledby="hc-license-heading">
      <h2 id="hc-license-heading">רישיון שימוש</h2>
      <p className={status.enforced ? "hc-license-status__mode" : "hc-license-status__mode hc-license-status__mode--off"} data-testid="license-mode">
        {status.enforced
          ? "דרישת הרישיון פעילה בגרסה זו."
          : "דרישת הרישיון טרם הופעלה בגרסה זו. אפשר כבר עכשיו להתקין את הרישיון של מחשב זה, כדי שהמעבר לגרסה האוכפת יהיה ללא הפרעה."}
      </p>

      <dl className="hc-activate__facts">
        <dt>מזהה ההפעלה של מחשב זה</dt>
        <dd>
          <code dir="ltr" data-testid="status-device-id">{status.deviceId}</code>{" "}
          <button type="button" className="hc-btn hc-btn--quiet" onClick={async () => { await api.copyText(status.deviceId); setCopied(true); }}>
            {copied ? "המזהה הועתק" : "העתקה"}
          </button>
        </dd>
        <dt>מצב</dt>
        <dd data-testid="license-state">{stateText[status.state]}</dd>
        {status.licenseId && (
          <>
            <dt>בעל הרישיון</dt>
            <dd>{status.licensee}{status.organization ? `, ${status.organization}` : ""}</dd>
            <dt>מספר רישיון</dt>
            <dd dir="ltr">{status.licenseId}</dd>
            <dt>תוקף</dt>
            <dd>{status.expiresAt ? `עד ${status.expiresAt}` : "ללא הגבלת זמן"}</dd>
          </>
        )}
      </dl>
      {status.messageHe && <p className="hc-activate__error" role="alert">{status.messageHe}</p>}
      {status.deviceFallback && (
        <p className="hc-activate__note">לא ניתן היה לקרוא את מזהה Windows, ולכן נוצר מזהה מקומי. מזהה זה ישתנה אם תיקיית ההגדרות של התוכנה תימחק.</p>
      )}

      <div className="hc-activate__input">
        <label htmlFor="hc-status-key">{status.licenseId ? "החלפת רישיון – מפתח הפעלה" : "התקנת רישיון – מפתח הפעלה"}</label>
        <textarea id="hc-status-key" dir="ltr" rows={4} value={key} onChange={(e) => setKey(e.target.value)} spellCheck={false} />
        {error && <p className="hc-activate__error" role="alert">{error}</p>}
        {ok && <p className="hc-legal__ok" role="status">{ok}</p>}
        <div className="hc-legal__actions">
          <button type="button" className="hc-btn hc-btn--primary" disabled={!key.trim() || busy} onClick={() => run(api.activate(key))}>
            שמירת הרישיון
          </button>
          <button type="button" className="hc-btn" disabled={busy} onClick={() => run(api.pickAndImportLicenseFile())}>
            ייבוא קובץ רישיון
          </button>
        </div>
      </div>
    </section>
  );
}
