/**
 * Attendance report import — entry point. Reads a file the user picked (bytes in memory only; no copies
 * on disk), detects its real type from its content, and returns the format-independent Grid.
 */
import { readPdf } from './pdf';
import type { OcrProgress } from './ocr';
import { gridFromXls, readCsv, readHtmlTable, readXlsx, decodeText, type RawXlsSheet } from './spreadsheet';
import { ImportError, type Grid } from './types';

export * from './types';
export { detectTable, readRecords, mappingFromSelection } from './analyze';
export { buildPreview, evaluateRow, countPreview, buildImportChanges, monthsInRecords, isIncludable, willWrite, defaultInclude, type PlanContext } from './plan';
export { sameEmployee, nameKey } from './values';
export type { OcrProgress } from './ocr';

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const ACCEPT = '.xlsx,.xlsm,.xls,.csv,.txt,.pdf';

export interface ImportFile {
  name: string;
  bytes: Uint8Array;
}

/** Reads .xls through the desktop backend (calamine). Replaced in tests / unavailable in the browser preview. */
export type XlsReader = (bytes: Uint8Array) => Promise<RawXlsSheet[]>;

export const tauriXlsReader: XlsReader = async (bytes) => {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<RawXlsSheet[]>('import_read_xls', bytes);
};

function kind(f: ImportFile): 'pdf' | 'zip' | 'ole' | 'html' | 'text' {
  const b = f.bytes;
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'pdf'; // %PDF
  if (b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return 'zip'; // xlsx
  if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) return 'ole'; // xls (BIFF)
  const head = decodeText(b.subarray(0, 2048)).trimStart().toLowerCase();
  if (head.startsWith('<') && /<(html|table|!doctype|\?xml|meta)/.test(head)) return 'html';
  return 'text';
}

export async function readImportFile(file: ImportFile, opts: { onProgress?: (p: OcrProgress) => void; xlsReader?: XlsReader | null } = {}): Promise<Grid> {
  if (!file.bytes.length) throw new ImportError('הקובץ ריק.');
  if (file.bytes.length > MAX_FILE_BYTES) throw new ImportError('הקובץ גדול מדי לייבוא (מעל 20MB).');
  const ext = file.name.toLowerCase().split('.').pop() ?? '';
  switch (kind(file)) {
    case 'pdf':
      return readPdf(file.bytes, opts.onProgress);
    case 'zip':
      if (ext === 'xlsx' || ext === 'xlsm' || ext === 'xls') return readXlsx(file.bytes);
      throw new ImportError('סוג הקובץ אינו נתמך. ניתן לייבא Excel‏ (xlsx/xls), ‏CSV או PDF.');
    case 'ole': {
      if (!opts.xlsReader) throw new ImportError('קבצי Excel ישנים (‎.xls) נתמכים בתוכנה המותקנת במחשב.');
      return gridFromXls(await opts.xlsReader(file.bytes));
    }
    case 'html':
      return readHtmlTable(decodeText(file.bytes));
    case 'text':
      if (['csv', 'txt', 'xls', 'tsv'].includes(ext)) return readCsv(file.bytes);
      throw new ImportError('סוג הקובץ אינו נתמך. ניתן לייבא Excel‏ (xlsx/xls), ‏CSV או PDF.');
  }
}
