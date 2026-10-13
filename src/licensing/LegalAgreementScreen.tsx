import { useEffect, useRef, useState } from "react";
import type { LegalDoc, LicensingApi } from "./types";
import { LegalText } from "./LegalText";
import { CopyrightFooter } from "./CopyrightFooter";

type Props =
  | { mode: "accept"; api: LicensingApi; onAccepted: () => void }
  | { mode: "review"; api: LicensingApi; onClose: () => void };

export function LegalAgreementScreen(props: Props) {
  const { api } = props;
  const [doc, setDoc] = useState<LegalDoc | null>(null);
  const [checked, setChecked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDecline, setConfirmDecline] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => { api.legalDocument().then(setDoc).catch((e) => setError(String(e))); }, [api]);

  const jump = (id: string) => scroller.current?.querySelector(`#${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });

  async function confirm() {
    if (!doc || !checked) return;
    setSaving(true); setError(null);
    try {
      await api.acceptLegal(doc.sha256, -new Date().getTimezoneOffset());
      setAccepted(true);
    } catch (e) {
      setError("שמירת האישור נכשלה. נסו שוב. " + String(e));
    } finally { setSaving(false); }
  }

  return (
    <main className="hc-legal" dir="rtl" lang="he" aria-labelledby="hc-legal-heading">
      <header className="hc-legal__head">
        <h1 id="hc-legal-heading">
          {props.mode === "accept" ? "הסכם רישיון, תנאי שימוש ומדיניות פרטיות" : "מסמכים משפטיים"}
        </h1>
        {doc && (
          <p className="hc-legal__meta">
            Hours-Cal גרסה {doc.appVersion}, נוסח מסמך {doc.docVersion}
          </p>
        )}
        <nav className="hc-legal__nav" aria-label="מעבר בין מסמכים">
          <button type="button" onClick={() => jump("legal-eula")}>הסכם רישיון ותנאי שימוש</button>
          <button type="button" onClick={() => jump("legal-privacy")}>מדיניות פרטיות</button>
        </nav>
      </header>

      <div className="hc-legal__scroll" ref={scroller} tabIndex={0} role="document" aria-label="נוסח ההסכם המלא">
        {doc ? <LegalText text={doc.text} /> : !error && <p className="hc-legal__loading">טוען את נוסח ההסכם…</p>}
      </div>

      {props.mode === "accept" ? (
        <section className="hc-legal__consent" aria-label="אישור התנאים">
          <label className="hc-legal__check">
            <input
              type="checkbox"
              checked={checked}
              disabled={accepted || !doc}
              onChange={(e) => setChecked(e.target.checked)}
            />
            <span>{doc?.consentLabel ?? "קראתי את הסכם הרישיון, תנאי השימוש ומדיניות הפרטיות ואני מסכים/ה להם"}</span>
          </label>
          {error && <p className="hc-legal__error" role="alert">{error}</p>}
          {accepted && <p className="hc-legal__ok" role="status">ההסכמה נשמרה במחשב זה.</p>}
          <div className="hc-legal__actions">
            <button type="button" className="hc-btn hc-btn--primary" disabled={!checked || accepted || saving} onClick={confirm}>
              אישור קריאה והסכמה
            </button>
            <button type="button" className="hc-btn hc-btn--primary" disabled={!accepted} onClick={props.onAccepted}>
              המשך לאפליקציה
            </button>
            <button type="button" className="hc-btn hc-btn--quiet" onClick={() => setConfirmDecline(true)} disabled={accepted}>
              אינני מסכים/ה — סגירת התוכנה
            </button>
          </div>
          {confirmDecline && (
            <div className="hc-legal__decline" role="alertdialog" aria-labelledby="hc-decline-text">
              <p id="hc-decline-text">התוכנה תיסגר. הנתונים השמורים במחשב לא יימחקו ולא ישתנו.</p>
              <button type="button" className="hc-btn hc-btn--danger" onClick={() => api.declineAndExit()}>סגירת התוכנה</button>
              <button type="button" className="hc-btn hc-btn--quiet" onClick={() => setConfirmDecline(false)}>חזרה להסכם</button>
            </div>
          )}
        </section>
      ) : (
        <div className="hc-legal__actions">
          <button type="button" className="hc-btn" onClick={props.onClose}>סגירה</button>
        </div>
      )}
      <CopyrightFooter />
    </main>
  );
}
