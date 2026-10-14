/**
 * Offline OCR for scanned PDF pages: pdf.js renders the page locally, Tesseract (WebAssembly, bundled
 * with the application together with Hebrew + English language data) reads it. No network, no cloud.
 * Every word keeps its confidence so uncertain rows are flagged for review instead of trusted.
 */
import type { Token } from './layout';
import { ImportError } from './types';

export interface OcrProgress {
  page: number;
  pages: number;
  /** 0..1 within the current page. */
  progress: number;
  stage: 'render' | 'recognize';
}

export interface OcrConfig {
  /** Absolute URLs / paths of the bundled Tesseract worker, core and language data. Undefined = library default (Node). */
  workerPath?: string;
  corePath?: string;
  langPath: string;
  langs: string;
}

const HEB = /[\u0590-\u05ff]/;
/** Words that should be numbers (times, dates, durations) are re-read with a digits-only model pass. */
const NUMERIC = /^[\d:/.*\-]{3,12}$/;
const NUMERIC_CHARS = '0123456789:/.-';
const STRICT_VALUE = /^(\d{1,2}:\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})$/;
/** Render resolution (OCR works best around 300 DPI); capped to keep memory bounded. */
const DPI = 300;
const MAX_SIDE = 3600;

function defaultConfig(): OcrConfig {
  const base = typeof document !== 'undefined' ? document.baseURI : 'http://localhost/';
  const u = (p: string) => new URL(p, base).href;
  return { workerPath: u('ocr/worker.min.js'), corePath: u('ocr/core'), langPath: u('ocr/lang'), langs: 'heb+eng' };
}

let config: OcrConfig | null = null;
export function setOcrConfig(c: OcrConfig) {
  config = c;
}

type PdfDoc = {
  getPage(n: number): Promise<{
    getViewport(o: { scale: number }): { width: number; height: number };
    render(o: Record<string, unknown>): { promise: Promise<void> };
    cleanup(): void;
  }>;
  canvasFactory: unknown;
};

interface CanvasPair {
  canvas: { width: number; height: number; toBuffer?: (mime: string) => Uint8Array };
  context: unknown;
}

export async function ocrPages(doc: unknown, pageNumbers: number[], onProgress?: (p: OcrProgress) => void): Promise<Token[]> {
  const cfg = config ?? defaultConfig();
  const { createWorker, OEM, PSM } = await import('tesseract.js');
  let current = 0;
  let worker: Awaited<ReturnType<typeof createWorker>>;
  try {
    worker = await createWorker(cfg.langs, OEM.LSTM_ONLY, {
      ...(cfg.workerPath ? { workerPath: cfg.workerPath, workerBlobURL: false } : {}),
      ...(cfg.corePath ? { corePath: cfg.corePath } : {}),
      langPath: cfg.langPath,
      gzip: true,
      cacheMethod: 'none',
      logger: (m: { status: string; progress: number }) => {
        if (m.status === 'recognizing text') onProgress?.({ page: current, pages: pageNumbers.length, progress: m.progress, stage: 'recognize' });
      },
    });
  } catch (e) {
    throw new ImportError(`רכיב זיהוי הטקסט (OCR) לא נטען: ${e instanceof Error ? e.message : String(e)}`);
  }
  // Second worker: digits only, one line — markedly more accurate for times than the mixed Hebrew pass.
  let digits: Awaited<ReturnType<typeof createWorker>> | null = null;
  try {
    digits = await createWorker('eng', OEM.LSTM_ONLY, {
      ...(cfg.workerPath ? { workerPath: cfg.workerPath, workerBlobURL: false } : {}),
      ...(cfg.corePath ? { corePath: cfg.corePath } : {}),
      langPath: cfg.langPath,
      gzip: true,
      cacheMethod: 'none',
    });
    await digits.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE, tessedit_char_whitelist: NUMERIC_CHARS, user_defined_dpi: String(DPI) });
  } catch {
    digits = null;
  }
  const pdf = doc as PdfDoc;
  const factory = pdf.canvasFactory as { create(w: number, h: number): CanvasPair; destroy(c: CanvasPair): void };
  const tokens: Token[] = [];
  try {
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT, preserve_interword_spaces: '1', user_defined_dpi: String(DPI) });
    for (const n of pageNumbers) {
      current = pageNumbers.indexOf(n) + 1;
      onProgress?.({ page: current, pages: pageNumbers.length, progress: 0, stage: 'render' });
      const page = await pdf.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(DPI / 72, MAX_SIDE / Math.max(base.width, base.height));
      const vp = page.getViewport({ scale });
      const pair = factory.create(Math.ceil(vp.width), Math.ceil(vp.height));
      try {
        await page.render({ canvasContext: pair.context, canvas: pair.canvas, viewport: vp, background: '#ffffff' }).promise;
        const image = typeof pair.canvas.toBuffer === 'function' ? pair.canvas.toBuffer('image/png') : pair.canvas;
        const { data } = await worker.recognize(image as never, {}, { blocks: true, text: false });
        const words = (data.blocks ?? []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines.flatMap((l) => l.words)));
        for (const w of words) {
          let text = w.text.trim();
          let conf = w.confidence;
          if (!text) continue;
          const bw = w.bbox.x1 - w.bbox.x0;
          const bh = Math.max(1, w.bbox.y1 - w.bbox.y0);
          if (digits && /\d/.test(text) && NUMERIC.test(text.replace(/[()]/g, ''))) {
            const refined = await rereadDigits(digits, factory, pair, w.bbox);
            // Use the digits-only reading when it is confident and has the same shape (e.g. HH:MM).
            if (refined && refined.conf >= Math.max(conf, 70) && shape(refined.text) === shape(text)) {
              text = refined.text;
              conf = refined.conf;
            } else if (refined && refined.conf >= 80 && STRICT_VALUE.test(refined.text) && !STRICT_VALUE.test(text)) {
              text = refined.text;
              conf = Math.min(conf, 70); // different shape: keep it below the review threshold
            }
          } else if (digits && (conf < 60 || (/^\d{1,2}$/.test(text) && bw > 1.6 * bh)) && bw < bh * 6) {
            // A garbled word, or a box much wider than its text (e.g. "08:05" read as "5"): re-read digits-only.
            // Accept only a strict time/date, and keep it BELOW the review threshold so the row is always checked.
            const refined = await rereadDigits(digits, factory, pair, w.bbox);
            if (refined && refined.conf >= 80 && STRICT_VALUE.test(refined.text)) {
              text = refined.text;
              conf = Math.min(Math.max(conf, 40), 70);
            }
          }
          tokens.push({ page: n, x0: w.bbox.x0, x1: w.bbox.x1, top: w.bbox.y0, bottom: w.bbox.y1, text, rtl: HEB.test(text), conf });
        }
      } finally {
        factory.destroy(pair); // release the rendered page image
        page.cleanup();
      }
    }
  } finally {
    await worker.terminate();
    await digits?.terminate();
  }
  return tokens;
}

/** Character classes of a numeric token: "17:13" → "dd:dd". */
const shape = (t: string) => t.replace(/\d/g, 'd');

async function rereadDigits(
  worker: { recognize(img: never): Promise<{ data: { text: string; confidence: number } }> },
  factory: { create(w: number, h: number): CanvasPair; destroy(c: CanvasPair): void },
  page: CanvasPair,
  b: { x0: number; y0: number; x1: number; y1: number },
): Promise<{ text: string; conf: number } | null> {
  const pad = Math.round((b.y1 - b.y0) * 0.35) + 2;
  const x = Math.max(0, b.x0 - pad);
  const y = Math.max(0, b.y0 - pad);
  const w = Math.min(page.canvas.width - x, b.x1 - b.x0 + 2 * pad);
  const h = Math.min(page.canvas.height - y, b.y1 - b.y0 + 2 * pad);
  if (w < 4 || h < 4) return null;
  const crop = factory.create(w, h);
  try {
    const ctx = crop.context as { fillStyle: string; fillRect(...a: number[]): void; drawImage(...a: unknown[]): void };
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(page.canvas, x, y, w, h, 0, 0, w, h);
    const img = typeof crop.canvas.toBuffer === 'function' ? crop.canvas.toBuffer('image/png') : crop.canvas;
    const { data } = await worker.recognize(img as never);
    const text = data.text.replace(/\s+/g, '');
    return text ? { text, conf: data.confidence } : null;
  } catch {
    return null;
  } finally {
    factory.destroy(crop);
  }
}
