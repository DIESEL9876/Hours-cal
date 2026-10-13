// @vitest-environment jsdom
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LicensingGate } from "../LicensingGate";
import { LegalSettingsPanel } from "../LegalSettingsPanel";
import type { LicensingApi, Route } from "../types";

const TEXT = readFileSync(resolve(__dirname, "../../../legal/agreement_he.md"), "utf8")
  .replaceAll("{{CONTACT_EMAIL}}", "legal@example.com");
const READY: Route = { route: "ready", licensee: "עילי נגר", organization: null, licenseId: "HCL-2026-AAAAA", expiresAt: null };
const ACTIVATION: Route = { route: "activation", deviceId: "HC1-AAAA-BBBB-CCCC-DDDD-EEEE-FFFF", reasonHe: null, recoveryAvailable: true };

function fakeApi(start: Route, over: Partial<LicensingApi> = {}) {
  let route = start;
  const api: LicensingApi = {
    startupRoute: vi.fn(async () => route),
    legalDocument: vi.fn(async () => ({ text: TEXT, docVersion: "1.0", sha256: "abc", appVersion: "1.1.3",
      copyright: "© 2026 עילי נגר | כל הזכויות שמורות", consentLabel: "קראתי את הסכם הרישיון, תנאי השימוש ומדיניות הפרטיות ואני מסכים/ה להם" })),
    acceptLegal: vi.fn(async () => { route = ACTIVATION; return {} as never; }),
    legalHistory: vi.fn(async () => [{ schema_version: 1, installation_id: "x", app_version: "1.1.3", legal_doc_version: "1.0",
      legal_sha256: "a".repeat(64), accepted_at_utc: "2026-10-13T09:00:00Z", local_utc_offset_minutes: 180 }]),
    acceptedText: vi.fn(async () => TEXT),
    declineAndExit: vi.fn(async () => {}),
    deviceId: vi.fn(async () => ({ code: ACTIVATION.route === "activation" ? ACTIVATION.deviceId : "", fallback: false })),
    activate: vi.fn(async (k: string) => k === "GOOD" ? READY : { ...ACTIVATION, reasonHe: "חתימת הרישיון אינה תקפה." } as Route),
    pickAndImportLicenseFile: vi.fn(async () => READY),
    recoveryTables: vi.fn(async () => [{ table: "employees", rows: 12 }]),
    pickFolderAndExport: vi.fn(async () => ({ folder: "C:\\Export", tables: [], sqlite_copy: "x" })),
    copyText: vi.fn(async () => {}),
    ...over,
  };
  return api;
}
const App = () => <div>בחירת עסק</div>;

describe("legal agreement", () => {
  it("is shown before the application and shows the complete Hebrew documents", async () => {
    render(<LicensingGate api={fakeApi({ route: "legalAgreement", appVersion: "1.1.3", docVersion: "1.0" })}><App /></LicensingGate>);
    await screen.findByText("פרק ז׳ — הוראות כלליות");
    expect(screen.queryByText("בחירת עסק")).toBeNull();
    for (const h of ["פרק א׳ — בעלות וזכויות קניין רוחני", "מדיניות פרטיות — Hours-Cal", "16. הוראות משלימות", "10. שינויי מדיניות ויצירת קשר"])
      expect(screen.getByText(h)).toBeInTheDocument();
    expect(screen.getAllByText("© 2026 עילי נגר | כל הזכויות שמורות").length).toBeGreaterThan(0);
  });

  it("consent is never prechecked, continue stays disabled until confirmation is saved", async () => {
    const api = fakeApi({ route: "legalAgreement", appVersion: "1.1.3", docVersion: "1.0" });
    render(<LicensingGate api={api}><App /></LicensingGate>);
    const box = await screen.findByRole("checkbox", { name: /קראתי את הסכם הרישיון/ });
    const confirm = screen.getByRole("button", { name: "אישור קריאה והסכמה" });
    const cont = screen.getByRole("button", { name: "המשך לאפליקציה" });
    await waitFor(() => expect(box).toBeEnabled());
    expect(box).not.toBeChecked();
    expect(confirm).toBeDisabled();
    expect(cont).toBeDisabled();
    // scrolling is not consent
    screen.getByRole("document").scrollTop = 99999;
    expect(cont).toBeDisabled();
    await userEvent.click(box);
    expect(cont).toBeDisabled();
    await userEvent.click(confirm);
    expect(api.acceptLegal).toHaveBeenCalledWith("abc", expect.any(Number));
    await waitFor(() => expect(cont).toBeEnabled());
    await userEvent.click(cont);
    await screen.findByRole("heading", { name: "הפעלת רישיון" });
  });

  it("declining closes without accepting or touching anything", async () => {
    const api = fakeApi({ route: "legalAgreement", appVersion: "1.1.3", docVersion: "1.0" });
    render(<LicensingGate api={api}><App /></LicensingGate>);
    await userEvent.click(await screen.findByRole("button", { name: /אינני מסכים/ }));
    const dlg = screen.getByRole("alertdialog");
    expect(dlg).toHaveTextContent("לא יימחקו");
    await userEvent.click(within(dlg).getByRole("button", { name: "סגירת התוכנה" }));
    expect(api.declineAndExit).toHaveBeenCalled();
    expect(api.acceptLegal).not.toHaveBeenCalled();
    expect(api.recoveryTables).not.toHaveBeenCalled();
  });

  it("an already-accepted version opens the app directly", async () => {
    const api = fakeApi(READY);
    render(<LicensingGate api={api}><App /></LicensingGate>);
    await screen.findByText("בחירת עסק");
    expect(api.legalDocument).not.toHaveBeenCalled();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("settings view is read-only (no consent controls) and shows accepted history", async () => {
    render(<LegalSettingsPanel api={fakeApi(READY)} />);
    await screen.findByText(/גרסה 1.1.3, נוסח 1.0/);
    await userEvent.click(screen.getByRole("button", { name: /צפייה בהסכם/ }));
    await screen.findByText("פרק ז׳ — הוראות כלליות");
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "אישור קריאה והסכמה" })).toBeNull();
  });
});

describe("activation and recovery", () => {
  it("missing licence shows the device ID; invalid key shows a Hebrew error; valid key succeeds", async () => {
    const api = fakeApi(ACTIVATION);
    render(<LicensingGate api={api}><App /></LicensingGate>);
    expect(await screen.findByTestId("device-id")).toHaveTextContent("HC1-AAAA-BBBB-CCCC-DDDD-EEEE-FFFF");
    await userEvent.click(screen.getByRole("button", { name: "העתקת המזהה" }));
    expect(api.copyText).toHaveBeenCalledWith("HC1-AAAA-BBBB-CCCC-DDDD-EEEE-FFFF");
    const ta = screen.getByLabelText("מפתח הפעלה");
    await userEvent.type(ta, "BAD");
    await userEvent.click(screen.getByRole("button", { name: "הפעלת הרישיון" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("חתימת הרישיון אינה תקפה");
    expect(screen.queryByText("בחירת עסק")).toBeNull();
    await userEvent.clear(ta);
    await userEvent.type(ta, "GOOD");
    await userEvent.click(screen.getByRole("button", { name: "הפעלת הרישיון" }));
    await screen.findByRole("heading", { name: "הרישיון הופעל בהצלחה" });
    await userEvent.click(screen.getByRole("button", { name: "המשך לבחירת עסק" }));
    await screen.findByText("בחירת עסק");
  });

  it("recovery mode offers export only", async () => {
    const api = fakeApi({ ...ACTIVATION, reasonHe: "תוקף הרישיון הסתיים בתאריך 2026-12-31." } as Route);
    render(<LicensingGate api={api}><App /></LicensingGate>);
    expect(await screen.findByRole("alert")).toHaveTextContent("2026-12-31");
    await userEvent.click(screen.getByRole("button", { name: /ייצוא נתונים קיימים/ }));
    await screen.findByText("employees");
    await userEvent.click(screen.getByRole("button", { name: "בחירת תיקייה וייצוא" }));
    expect(await screen.findByRole("status")).toHaveTextContent("C:\\Export");
    expect(screen.queryByText("בחירת עסק")).toBeNull();
  });
});
