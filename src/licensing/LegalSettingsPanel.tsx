import { useEffect, useState } from "react";
import type { AcceptanceRecord, LicensingApi } from "./types";
import { LegalAgreementScreen } from "./LegalAgreementScreen";
import { LegalText } from "./LegalText";

/** Settings → מסמכים משפטיים. Read-only: never asks for (re)acceptance. */
export function LegalSettingsPanel({ api }: { api: LicensingApi }) {
  const [view, setView] = useState<"list" | "current" | { sha: string; text: string }>("list");
  const [history, setHistory] = useState<AcceptanceRecord[]>([]);
  useEffect(() => { api.legalHistory().then(setHistory).catch(() => {}); }, [api]);

  if (view === "current") return <LegalAgreementScreen mode="review" api={api} onClose={() => setView("list")} />;
  if (typeof view === "object") {
    return (
      <section className="hc-legal" dir="rtl">
        <h2>הנוסח שאושר</h2>
        <div className="hc-legal__scroll"><LegalText text={view.text} /></div>
        <button type="button" className="hc-btn" onClick={() => setView("list")}>חזרה</button>
      </section>
    );
  }
  return (
    <section className="hc-settings-legal" dir="rtl" lang="he">
      <h2>מסמכים משפטיים</h2>
      <button type="button" className="hc-btn" onClick={() => setView("current")}>צפייה בהסכם הרישיון ובמדיניות הפרטיות</button>
      <h3>היסטוריית אישורים במחשב זה</h3>
      {history.length === 0 ? <p>לא נמצאו אישורים שמורים.</p> : (
        <ul>
          {history.slice().reverse().map((h) => (
            <li key={h.accepted_at_utc + h.app_version}>
              גרסה {h.app_version}, נוסח {h.legal_doc_version}, אושר ב־{new Date(h.accepted_at_utc).toLocaleString("he-IL")}{" "}
              <button type="button" className="hc-btn hc-btn--quiet" onClick={async () => {
                const t = await api.acceptedText(h.legal_sha256);
                if (t) setView({ sha: h.legal_sha256, text: t });
              }}>הצגת הנוסח שאושר</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
