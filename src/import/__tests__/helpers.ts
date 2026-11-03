import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setPdfjsLoader } from '../pdf';
import { setOcrConfig } from '../ocr';
import { setImageBackend } from '../image';
import { detectTable, readImportFile, readRecords, type Grid, type ImportFile, type ReadResult, type XlsReader } from '..';

/** Node: pdf.js legacy build; OCR with the same bundled Hebrew/English data the app ships. */
export function setupNodeEnvironment() {
  setPdfjsLoader(async () => (await import('pdfjs-dist/legacy/build/pdf.mjs')) as never);
  const lang = mkdtempSync(join(tmpdir(), 'hc-ocr-'));
  copyFileSync(require.resolve('@tesseract.js-data/heb/4.0.0_best_int/heb.traineddata.gz'), join(lang, 'heb.traineddata.gz'));
  copyFileSync(require.resolve('@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz'), join(lang, 'eng.traineddata.gz'));
  setOcrConfig({ langPath: lang, langs: 'heb+eng' });
  setImageBackend(nodeImageBackend);
}

/** Node image decoding + canvases (@napi-rs/canvas, the same library pdf.js uses in Node). EXIF is applied by the app. */
export const nodeImageBackend = {
  async decode(bytes: Uint8Array) {
    const { createCanvas, loadImage } = await import('@napi-rs/canvas');
    const img = await loadImage(Buffer.from(bytes));
    const c = createCanvas(img.width, img.height);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, img.width, img.height);
    ctx.drawImage(img, 0, 0);
    return { w: img.width, h: img.height, rgba: new Uint8ClampedArray(ctx.getImageData(0, 0, img.width, img.height).data), orientationApplied: false };
  },
  factory: {
    create(w: number, h: number) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { createCanvas } = require('@napi-rs/canvas');
      const canvas = createCanvas(w, h);
      return { canvas, context: canvas.getContext('2d') };
    },
    destroy() {},
  },
};

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
