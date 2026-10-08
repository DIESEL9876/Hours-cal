/**
 * XLSX / CSV generation and saving. Exports are generated locally; nothing is sent anywhere.
 */
import { formatDecimalHours, formatHM, type BusinessSummary, type EmployeePeriodResult } from '../engine';
import type { Business, Employee } from '../data/repo';
import { isTauri } from '../data/tauriDriver';
import { monthTitle } from '../ui/format';
import { businessDetailTable, businessMonthTable, employeeMonthTable, type Cell, type Table } from './tables';

export type ExportFormat = 'xlsx' | 'csv';

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

function csvCell(c: Cell): string {
  switch (c.kind) {
    case 'text':
      return c.v;
    case 'dur':
      return formatHM(c.v);
    case 'int':
      return String(c.v);
    case 'money':
      return c.v === null ? '' : (c.v / 100).toFixed(2);
  }
}

const q = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** UTF-8 CSV with BOM (opens correctly in Hebrew Excel). Durations as H:MM plus decimal-hour columns. */
export function tableToCsv(t: Table): string {
  const durCols = t.headers.map((_, i) => t.rows.some((r) => r[i]?.kind === 'dur')).map((isDur, i) => (isDur ? i : -1)).filter((i) => i >= 0);
  const headers = [...t.headers, ...durCols.map((i) => `${t.headers[i]} (עשרוני)`)];
  const lines = [headers.map(q).join(',')];
  for (const r of t.rows) {
    const dec = durCols.map((i) => (r[i]?.kind === 'dur' ? formatDecimalHours(r[i].v as number) : ''));
    lines.push([...r.map(csvCell), ...dec].map(q).join(','));
  }
  return '﻿' + lines.join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------------------
// XLSX
// ---------------------------------------------------------------------------

async function tablesToXlsx(tables: Table[], meta: { title: string; subtitle: string }): Promise<Uint8Array> {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'מערכת נוכחות ושעות נוספות';
  wb.created = new Date();
  for (const t of tables) {
    const ws = wb.addWorksheet(t.title.slice(0, 31), { views: [{ rightToLeft: true, state: 'frozen', ySplit: 4 }] });
    ws.getCell('A1').value = meta.title;
    ws.getCell('A1').font = { bold: true, size: 14 };
    ws.getCell('A2').value = meta.subtitle;
    ws.getCell('A2').font = { size: 10, color: { argb: 'FF475569' } };
    const durCols = t.headers.map((_, i) => t.rows.some((r) => r[i]?.kind === 'dur'));
    const headers = [...t.headers, ...t.headers.filter((_, i) => durCols[i]).map((h) => `${h} (עשרוני)`)];
    const headerRow = ws.getRow(4);
    headers.forEach((h, i) => {
      const c = headerRow.getCell(i + 1);
      c.value = h;
      c.font = { bold: true, color: { argb: 'FF0F1B2D' } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF3FF' } };
      c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      c.border = { bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } } };
    });
    headerRow.height = 30;
    t.rows.forEach((r, ri) => {
      const row = ws.getRow(5 + ri);
      let extra = t.headers.length;
      r.forEach((cell, ci) => {
        const c = row.getCell(ci + 1);
        if (cell.kind === 'dur') {
          // Excel duration: days fraction with [h]:mm format (display is exact to the minute).
          c.value = cell.v / 1440;
          c.numFmt = '[h]:mm';
          c.alignment = { horizontal: 'center' };
          const d = row.getCell(++extra);
          d.value = Math.round((cell.v * 100) / 60) / 100;
          d.numFmt = '0.00';
          d.alignment = { horizontal: 'center' };
        } else if (cell.kind === 'int') {
          c.value = cell.v;
          c.alignment = { horizontal: 'center' };
        } else if (cell.kind === 'money') {
          c.value = cell.v === null ? null : cell.v / 100;
          c.numFmt = '#,##0.00';
        } else {
          c.value = cell.v;
        }
      });
      if (t.totalRow === ri) {
        row.font = { bold: true };
        row.eachCell((c) => {
          c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
          c.border = { top: { style: 'thin', color: { argb: 'FF94A3B8' } } };
        });
      }
    });
    headers.forEach((h, i) => {
      ws.getColumn(i + 1).width = Math.max(10, Math.min(48, h.length + 4));
    });
    const notesIdx = t.headers.indexOf('הערות והתראות');
    if (notesIdx >= 0) ws.getColumn(notesIdx + 1).width = 60;
    ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 };
  }
  const buf = await wb.xlsx.writeBuffer();
  return new Uint8Array(buf as ArrayBuffer);
}

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

function safeName(s: string): string {
  return s.replace(/[\\/:*?"<>|]+/g, '-').trim();
}

/** Returns a user message, or null when the user cancelled. */
export async function saveBytes(fileName: string, bytes: Uint8Array, mime: string): Promise<string | null> {
  if (isTauri()) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const { invoke } = await import('@tauri-apps/api/core');
    const ext = fileName.split('.').pop()!;
    const path = await save({ defaultPath: fileName, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
    if (!path) return null;
    await invoke('write_export_file', { path, contents: Array.from(bytes) });
    return `הקובץ נשמר: ${path}`;
  }
  const blob = new Blob([bytes as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return `הקובץ ${fileName} הורד`;
}

async function emit(format: ExportFormat, baseName: string, tables: Table[], meta: { title: string; subtitle: string }) {
  if (format === 'csv') {
    const bytes = new TextEncoder().encode(tableToCsv(tables[0]));
    return saveBytes(`${safeName(baseName)}.csv`, bytes, 'text/csv;charset=utf-8');
  }
  const bytes = await tablesToXlsx(tables, meta);
  return saveBytes(`${safeName(baseName)}.xlsx`, bytes, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
}

const generatedLine = (bizName: string) =>
  `${bizName} · הופק ${new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })} · נתוני נוכחות ושעות בלבד – אינו תלוש שכר`;

export async function exportEmployeeMonth(
  format: ExportFormat,
  business: Business,
  employee: Employee,
  result: EmployeePeriodResult,
  ym: { year: number; month: number },
): Promise<string | null> {
  const title = `דוח שעות - ${employee.fullName} - ${monthTitle(ym.year, ym.month)}`;
  const table = employeeMonthTable('דוח שעות', result);
  return emit(format, title, [table], { title, subtitle: generatedLine(business.name) });
}

export async function exportBusinessMonth(
  format: ExportFormat,
  business: Business,
  summary: BusinessSummary,
  ym: { year: number; month: number },
  statusLine: string,
): Promise<string | null> {
  const title = `סיכום שעות עובדים - ${monthTitle(ym.year, ym.month)} - ${business.name}`;
  const includePay = summary.rows.some((r) => r.totals.payAgorot !== null);
  const tables = [businessMonthTable('סיכום', summary, includePay), businessDetailTable('פירוט יומי', summary)];
  return emit(format, title, tables, { title, subtitle: `${generatedLine(business.name)} · ${statusLine}` });
}

export { tablesToXlsx };
