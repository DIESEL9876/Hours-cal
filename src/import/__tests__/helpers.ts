import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setPdfjsLoader } from '../pdf';
import { setOcrConfig } from '../ocr';
import { detectTable, readImportFile, readRecords, type Grid, type ImportFile, type ReadResult, type XlsReader } from '..';

/** Node: pdf.js legacy build; OCR with the same bundled Hebrew/English data the app ships. */
export function setupNodeEnvironment() {
  setPdfjsLoader(async () => (await import('pdfjs-dist/legacy/build/pdf.mjs')) as never);
  const lang = mkdtempSync(join(tmpdir(), 'hc-ocr-'));
  copyFileSync(require.resolve('@tesseract.js-data/heb/4.0.0_best_int/heb.traineddata.gz'), join(lang, 'heb.traineddata.gz'));
  copyFileSync(require.resolve('@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz'), join(lang, 'eng.traineddata.gz'));
  setOcrConfig({ langPath: lang, langs: 'heb+eng' });
}

export const FIXTURES = join(__dirname, 'fixtures');
export const fixture = (name: string): ImportFile => ({ name, bytes: new Uint8Array(readFileSync(join(FIXTURES, name))) });

export const DATA = JSON.parse(readFileSync(join(__dirname, '../../../scripts/import-fixtures/data.json'), 'utf8'));

export async function readAll(file: ImportFile, xlsReader?: XlsReader): Promise<{ grid: Grid; read: ReadResult; ambiguous: boolean }> {
  const grid = await readImportFile(file, { xlsReader: xlsReader ?? null });
  const det = detectTable(grid);
  if (!det.mapping) throw new Error(`no table: ${det.reasons.join(' ')}`);
  return { grid, read: readRecords(grid, det.mapping, { fallbackYear: 2026 }), ambiguous: det.ambiguous };
}

export const segs = (r: { segments: { start: string | null; end: string | null }[] }) => r.segments.map((s) => `${s.start ?? '—'}-${s.end ?? '—'}`).join(' ');
