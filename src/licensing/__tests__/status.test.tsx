// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { LicenseStatusPanel } from "../LicenseStatusPanel";
import type { LicenseStatus, LicensingApi, Route } from "../types";

const DEV = "HC1-AAAA-BBBB-CCCC-DDDD-EEEE-FFFF";

function api(initial: LicenseStatus, activate: (k: string) => Promise<Route>): LicensingApi {
  let status = initial;
  return {
    startupRoute: vi.fn(),
    legalDocument: vi.fn(),
    acceptLegal: vi.fn(),
    legalHistory: vi.fn(async () => []),
    acceptedText: vi.fn(),
    declineAndExit: vi.fn(),
    deviceId: vi.fn(async () => ({ code: DEV, fallback: false })),
    activate: vi.fn(async (k: string) => {
      const r = await activate(k);
      if (r.route === "ready") status = { ...status, state: status.enforced ? "valid" : "pending", licenseId: "HCL-2026-OWNER", licensee: "עילי נגר" };
      return r;
    }),
    pickAndImportLicenseFile: vi.fn(async () => null),
    recoveryTables: vi.fn(),
    pickFolderAndExport: vi.fn(),
    copyText: vi.fn(async () => {}),
    licenseStatus: vi.fn(async () => status),
  } as unknown as LicensingApi;
}

const NONE: LicenseStatus = { enforced: false, deviceId: DEV, deviceFallback: false, licenseId: null, licensee: null, organization: null, expiresAt: null, state: "none", messageHe: null };
const READY: Route = { route: "ready", licensee: "", organization: null, licenseId: "", expiresAt: null };

describe("licence status panel (Hours-Cal integration)", () => {
  it("before enforcement: explains it, shows the device ID, and pre-installs the owner licence", async () => {
    const a = api(NONE, async () => READY);
    render(<LicenseStatusPanel api={a} />);
    expect(await screen.findByTestId("license-mode")).toHaveTextContent("דרישת הרישיון טרם הופעלה");
    expect(screen.getByTestId("status-device-id")).toHaveTextContent(DEV);
    expect(screen.getByTestId("license-state")).toHaveTextContent("לא הותקן רישיון");
    const save = screen.getByRole("button", { name: "שמירת הרישיון" });
    expect(save).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/מפתח הפעלה/), "TOKEN");
    await userEvent.click(save);
    expect(a.activate).toHaveBeenCalledWith("TOKEN");
    await waitFor(() => expect(screen.getByTestId("license-state")).toHaveTextContent("החתימה תאומת כאשר דרישת הרישיון תופעל"));
    expect(screen.getByText("HCL-2026-OWNER")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "העתקה" }));
    expect(a.copyText).toHaveBeenCalledWith(DEV);
  });

  it("enforced build: a rejected licence shows the Hebrew reason and changes nothing", async () => {
    const a = api({ ...NONE, enforced: true }, async () => ({ route: "activation", deviceId: DEV, reasonHe: "הרישיון הונפק למחשב אחר.", recoveryAvailable: true }));
    render(<LicenseStatusPanel api={a} />);
    expect(await screen.findByTestId("license-mode")).toHaveTextContent("דרישת הרישיון פעילה");
    await userEvent.type(screen.getByLabelText(/מפתח הפעלה/), "BAD");
    await userEvent.click(screen.getByRole("button", { name: "שמירת הרישיון" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("הרישיון הונפק למחשב אחר.");
    expect(screen.getByTestId("license-state")).toHaveTextContent("לא הותקן רישיון");
  });

  it("enforced build with a valid licence shows its details", async () => {
    const a = api({ ...NONE, enforced: true, state: "valid", licenseId: "HCL-2026-AAAAA", licensee: "עילי נגר", expiresAt: "2027-12-31" }, async () => READY);
    render(<LicenseStatusPanel api={a} />);
    expect(await screen.findByTestId("license-state")).toHaveTextContent("רישיון תקף ומאומת");
    expect(screen.getByText("עד 2027-12-31")).toBeInTheDocument();
    expect(screen.getByLabelText(/החלפת רישיון/)).toBeInTheDocument();
  });
});
