import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import type { LmApi, PathKind } from './types';

const FILTERS: Record<Exclude<PathKind, 'folder'>, { name: string; extensions: string[] }[]> = {
  backup: [{ name: 'גיבוי מפתחות Hours-Cal', extensions: ['hckeybak'] }],
  publicKey: [{ name: 'מפתח ציבורי', extensions: ['txt'] }],
  revocationList: [{ name: 'רשימת ביטולים', extensions: ['txt'] }],
  cliKey: [{ name: 'קובץ מפתח פרטי (כלי שורת הפקודה)', extensions: ['txt'] }],
};

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

/** All private-key work happens in Rust; these calls only move public data and file paths. */
export const tauriApi: LmApi = {
  appInfo: () => invoke('app_info'),
  setLicenseDir: (path) => invoke('set_license_dir', { path }),
  vaultStatus: () => invoke('vault_status'),
  vaultCreate: (confirm) => invoke('vault_create', { confirm: confirm ?? null }),
  vaultImportCliKey: (path, confirm) => invoke('vault_import_cli_key', { path, confirm: confirm ?? null }),
  exportPublicKey: (outPath) => invoke('export_public_key', { outPath }),
  backupCreate: (passphrase, outPath) => invoke('backup_create_cmd', { passphrase, outPath }),
  backupPeek: (path) => invoke('backup_peek', { path }),
  backupRestore: (path, passphrase, confirm) => invoke('backup_restore_cmd', { path, passphrase, confirm: confirm ?? null }),
  myDevice: () => invoke('my_device'),
  listLicenses: () => invoke('list_licenses'),
  stats: () => invoke('license_stats'),
  issueLicense: (req) => invoke('issue_license', { req }),
  reexportLicense: (id, outDir) => invoke('reexport_license', { id, outDir: outDir ?? null }),
  setRevoked: (id, revoked, reason) => invoke('set_revoked', { id, revoked, reason: reason ?? null }),
  exportRevocationList: (outPath) => invoke('export_revocation_list', { outPath }),
  revealPath: (path) => invoke('reveal_path', { path }),
  pickSave: async (kind, defaultName) => {
    if (kind === 'folder') return null;
    return (await save({ defaultPath: defaultName, filters: FILTERS[kind] })) ?? null;
  },
  pickOpen: async (kind) => {
    const r = kind === 'folder' ? await open({ directory: true, multiple: false }) : await open({ multiple: false, directory: false, filters: FILTERS[kind] });
    return typeof r === 'string' ? r : null;
  },
  copyText,
};

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}
