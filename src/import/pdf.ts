/**
 * PDF extraction with Mozilla pdf.js, locally. PDF scripts are never run (no scripting, no XFA).
 * Text pages → positioned tokens → layoutTable. Image-only (scanned) pages → OCR (ocr.ts).
 */
import { layoutTable, type Token } from './layout';
import { ImportError, type Grid } from './types';
import { ocrPages, type OcrProgress } from './ocr';

export const MAX_PDF_PAGES = 40;
/** Pages with less visible text than this are treated as scanned images. */
const MIN_TEXT_CHARS = 25;

type PdfJs = typeof import('pdfjs-dist');
type Loader = () => Promise<PdfJs>;

// The "legacy" build carries polyfills for very recent JavaScript features, so it runs on every
// WebView2 version found on office computers (not only the newest).
let loader: Loader = async () => {
  const [m, worker] = await Promise.all([import('pdfjs-dist/legacy/build/pdf.mjs'), import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')]);
  m.GlobalWorkerOptions.workerSrc = worker.default;
  return m as unknown as PdfJs;
};

/** Tests (Node) use the legacy build without a worker URL. */
export function setPdfjsLoader(l: Loader) {
  loader = l;
}

export interface PdfPage {
  index: number;
  tokens: Token[];
  textChars: number;
}

export async function openPdf(bytes: Uint8Array) {
  const pdfjs = await loader();
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    // pdf.js 6 never evaluates code from the document; XFA forms stay disabled and huge images are refused.
    enableXfa: false,
    maxImageSize: 64 * 1024 * 1024,
    useSystemFonts: false,
    stopAtErrors: false,
    verbosity: 0,
  });
  let doc;
  try {
    doc = await task.promise;
  } catch (e) {
    const name = (e as { name?: string })?.name;
    if (name === 'PasswordException') throw new ImportError('קובץ ה-PDF מוגן בסיסמה ולא ניתן לקרוא אותו.');
    throw new ImportError('לא ניתן לפתוח את קובץ ה-PDF (ייתכן שהקובץ פגום).');
  }
  if (doc.numPages > MAX_PDF_PAGES) {
    await task.destroy();
    throw new ImportError(`הקובץ מכיל ${doc.numPages} עמודים. ניתן לייבא עד ${MAX_PDF_PAGES} עמודים בקובץ אחד.`);
  }
  return { pdfjs, doc, task };
}

export async function pdfTextPages(pdfjs: PdfJs, doc: Awaited<ReturnType<typeof openPdf>>['doc']): Promise<PdfPage[]> {
  const pages: PdfPage[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const tokens: Token[] = [];
    let chars = 0;
    for (const it of tc.items) {
      if (!('str' in it) || !it.str || !it.str.trim()) continue;
      chars += it.str.trim().length;
      const tx = pdfjs.Util.transform(vp.transform, it.transform);
      const fh = Math.hypot(tx[2], tx[3]) || it.height || 1;
      const x0 = tx[4];
      const base = tx[5];
      tokens.push({ page: i, x0, x1: x0 + Math.max(it.width, 0.1), top: base - fh, bottom: base, text: it.str, rtl: it.dir === 'rtl' });
    }
    pages.push({ index: i, tokens, textChars: chars });
    page.cleanup();
  }
  return pages;
}

export async function readPdf(bytes: Uint8Array, onProgress?: (p: OcrProgress) => void): Promise<Grid> {
  const { pdfjs, doc, task } = await openPdf(bytes);
  try {
    const pages = await pdfTextPages(pdfjs, doc);
    const scanned = pages.filter((p) => p.textChars < MIN_TEXT_CHARS).map((p) => p.index);
    const notes: string[] = [];
    const tokens: Token[] = pages.filter((p) => !scanned.includes(p.index)).flatMap((p) => p.tokens);
    let format: Grid['format'] = 'pdf';
    if (scanned.length) {
      const ocrTokens = await ocrPages(doc, scanned, onProgress);
      notes.push(
        scanned.length === pages.length
          ? 'המסמך סרוק (תמונה). הטקסט זוהה במחשב זה באמצעות OCR — יש להשוות את התוצאה למקור.'
          : `${scanned.length} עמודים סרוקים זוהו באמצעות OCR.`,
      );
      format = 'pdf-ocr';
      // OCR words are already words; text-PDF items may be single glyphs.
      const text = layoutTable(tokens, { mergeGlyphs: true });
      const ocr = layoutTable(ocrTokens, { mergeGlyphs: false });
      const sheets = [ocr.sheet, text.sheet].filter((s): s is NonNullable<typeof s> => !!s);
      return { format, sheets: sheets.length ? sheets : [{ name: 'PDF', rows: [], headerText: [...ocr.freeText, ...text.freeText] }], notes };
    }
    const { sheet, freeText } = layoutTable(tokens, { mergeGlyphs: true });
    if (!sheet) notes.push('לא נמצאה בקובץ טבלה עם תאריכים.');
    return { format, sheets: sheet ? [sheet] : [{ name: 'PDF', rows: [], headerText: freeText }], notes };
  } finally {
    await task.destroy();
  }
}
