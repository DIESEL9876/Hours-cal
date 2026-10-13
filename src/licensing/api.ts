import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { LicensingApi, Route } from "./types";

export const tauriLicensingApi: LicensingApi = {
  startupRoute: () => invoke("licensing_startup_route"),
  legalDocument: () => invoke("legal_document"),
  acceptLegal: (sha256, localUtcOffsetMinutes) => invoke("legal_accept", { sha256, localUtcOffsetMinutes }),
  legalHistory: () => invoke("legal_history"),
  acceptedText: (sha256) => invoke("legal_accepted_text", { sha256 }),
  declineAndExit: () => invoke("legal_decline_and_exit"),
  deviceId: () => invoke("license_device_id"),
  activate: (input) => invoke("license_activate", { input }),
  async pickAndImportLicenseFile() {
    const path = await open({ multiple: false, filters: [{ name: "Hours-Cal License", extensions: ["hclic", "txt"] }] });
    return typeof path === "string" ? invoke<Route>("license_import_file", { path }) : null;
  },
  recoveryTables: () => invoke("recovery_tables"),
  async pickFolderAndExport() {
    const dir = await open({ directory: true, multiple: false });
    return typeof dir === "string" ? invoke("recovery_export", { outDir: dir }) : null;
  },
  copyText: (t) => navigator.clipboard.writeText(t),
};
