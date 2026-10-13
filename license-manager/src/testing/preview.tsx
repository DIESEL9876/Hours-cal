// Dev-server-only preview with the in-memory mock backend (not part of the production build).
import React from 'react';
import ReactDOM from 'react-dom/client';
import '../styles.css';
import { App } from '../App';
import { createMockApi, sampleLicense } from './mockApi';

const params = new URLSearchParams(location.search);
const state = (params.get('state') ?? 'ready') as 'ready' | 'noKey' | 'keyUnavailable';
const empty = params.has('empty');
const licenses = empty
  ? []
  : [
      sampleLicense(),
      sampleLicense({ licenseId: 'HCL-2026-BBBB2222', licensee: 'לוי ושות׳ רואי חשבון', nickname: 'מחשב מנהלת', deviceId: 'HC1-7Q2M-K9XD-4RTP-ZB3N-HW6C-1F8E', licenseType: 'limited', expiresAt: '2027-06-30', createdAt: '2026-10-02T08:00:00Z', issuedAt: '2026-10-02' }),
      sampleLicense({ licenseId: 'HCL-2026-CCCC3333', licensee: 'אברהמי שירותי שכר', nickname: 'מחשב ישן', deviceId: 'HC1-A1B2-C3D4-E5F6-G7H8-J9K0-MNPQ', createdAt: '2026-10-03T08:00:00Z', issuedAt: '2026-10-03' }),
      sampleLicense({ licenseId: 'HCL-2026-DDDD4444', licensee: 'אברהמי שירותי שכר', nickname: 'מחשב חדש', deviceId: 'HC1-ZZZZ-YYYY-XXXX-WWWW-VVVV-TTTT', replaces: 'HCL-2026-CCCC3333', replacesChain: ['HCL-2026-CCCC3333'], createdAt: '2026-10-05T08:00:00Z', issuedAt: '2026-10-05' }),
      sampleLicense({ licenseId: 'HCL-2026-EEEE5555', licensee: 'ניסיון — משרד דוד', nickname: null, deviceId: 'HC1-5555-6666-7777-8888-9999-AAAA', licenseType: 'limited', expiresAt: '2026-10-10', createdAt: '2026-09-10T08:00:00Z', issuedAt: '2026-09-10' }),
      sampleLicense({ licenseId: 'HCL-2026-FFFF6666', licensee: 'משרד שגיא', nickname: 'מחשב קבלה', deviceId: 'HC1-QQQQ-RRRR-SSSS-TTTT-VVVV-WWWW', revokedAt: '2026-10-11T10:00:00Z', revokeReason: 'הלקוח הפסיק את השימוש', createdAt: '2026-09-01T08:00:00Z', issuedAt: '2026-09-01' }),
    ];
const api = createMockApi({ state, licenses });
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App api={api} />
  </React.StrictMode>,
);
