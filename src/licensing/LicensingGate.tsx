import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { LicensingApi, Route } from "./types";
import { LegalAgreementScreen } from "./LegalAgreementScreen";
import { ActivationScreen } from "./ActivationScreen";
import { RecoveryScreen } from "./RecoveryScreen";

/**
 * Wrap the EXISTING app root:  <LicensingGate api={tauriLicensingApi}><App /></LicensingGate>
 * Children (business selection etc.) mount only when the Rust backend reports "ready".
 */
export function LicensingGate({ api, children }: { api: LicensingApi; children: ReactNode }) {
  const [route, setRoute] = useState<Route | null>(null);
  const [recovery, setRecovery] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api.startupRoute().then(setRoute).catch((e) => setError(String(e)));
  }, [api]);
  useEffect(refresh, [refresh]);

  if (error) return <main className="hc-activate" dir="rtl"><p role="alert">שגיאה בבדיקת הרישיון: {error}</p></main>;
  if (!route) return <main className="hc-activate" dir="rtl" aria-busy="true" />;
  switch (route.route) {
    case "legalAgreement":
      return <LegalAgreementScreen mode="accept" api={api} onAccepted={refresh} />;
    case "activation":
      return recovery
        ? <RecoveryScreen api={api} onBack={() => setRecovery(false)} />
        : <ActivationScreen api={api} deviceId={route.deviceId} reasonHe={route.reasonHe}
            recoveryAvailable={route.recoveryAvailable} onActivated={setRoute} onOpenRecovery={() => setRecovery(true)} />;
    case "ready":
      return <>{children}</>;
  }
}
