// The License Manager reuses Hours-Cal's UI components (src/ui/components.tsx). That file imports the
// payroll engine for one display helper; the License Manager build resolves that import here instead,
// so no payroll/calendar code is bundled into the owner tool.
export type Severity = 'error' | 'review' | 'compliance' | 'info';
export function formatDecimalHours(minutes: number): string {
  return (Math.round((minutes * 100) / 60) / 100).toFixed(2);
}
