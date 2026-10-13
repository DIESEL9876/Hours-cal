import { LegalSettingsPanel, LicenseStatusPanel, COPYRIGHT, type LicensingApi } from '../../licensing';
import { Card, PageHeader } from '../components';

/** "מסמכים משפטיים ורישיון": licence status, legal documents and acceptance history (read-only). */
export function LegalLicenseScreen({ api }: { api: LicensingApi }) {
  return (
    <div className="max-w-5xl">
      <PageHeader title="מסמכים משפטיים ורישיון" subtitle={`Hours-Cal גרסה ${__APP_VERSION__} · ${COPYRIGHT}`} />
      <div className="space-y-5">
        <Card className="p-5">
          <LicenseStatusPanel api={api} />
        </Card>
        <Card className="p-5">
          <LegalSettingsPanel api={api} />
        </Card>
      </div>
    </div>
  );
}
