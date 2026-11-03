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

export interface CanvasPair {
  canvas: { width: number; height: number; toBuffer?: (mime: string) => Uint8Array };
  context: unknown;
}

type Worker = Awaited<ReturnType<typeof import('tesseract.js')['createWorker']>>;

export interface CanvasFactory {
  create(w: number, h: number): CanvasPair;
  destroy(c: CanvasPair): void;
}

/** Main (Hebrew + English, sparse text) and digits-only workers, with the bundled offline language data. */
async function createWorkers(onProgress?: (progress: number) => void): Promise<{ worker: Worker; digits: Worker | null }> {
  const cfg = config ?? defaultConfig();
  const { createWorker, OEM, PSM } = await import('tesseract.js');
  let worker: Worker;
  try {
    worker = await createWorker(cfg.langs, OEM.LSTM_ONLY, {
      ...(cfg.workerPath ? { workerPath: cfg.workerPath, workerBlobURL: false } : {}),
      ...(cfg.corePath ? { corePath: cfg.corePath } : {}),
      langPath: cfg.langPath,
      gzip: true,
      cacheMethod: 'none',
      logger: (m: { status: string; progress: number }) => {
        if (m.status === 'recognizing text') onProgress?.(m.progress);
      },
    });
  } catch (e) {
    throw new ImportError(`רכיב זיהוי הטקסט (OCR) לא נטען: ${e instanceof Error ? e.message : String(e)}`);
  }
  await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT, preserve_interword_spaces: '1', user_defined_dpi: String(DPI) });
  // Second worker: digits only, one line — markedly more accurate for times than the mixed Hebrew pass.
  let digits: Worker | null = null;
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
  return { worker, digits };
}

/** OCR of one rendered page / image held in a canvas → positioned words with confidences. */
async function recognizeCanvas(worker: Worker, digits: Worker | null, factory: CanvasFactory, pair: CanvasPair, page: number): Promise<Token[]> {
  const tokens: Token[] = [];
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
      const refined = await rereadDigits(digits as never, factory, pair, w.bbox);
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
      const refined = await rereadDigits(digits as never, factory, pair, w.bbox);
      if (refined && refined.conf >= 80 && STRICT_VALUE.test(refined.text)) {
        text = refined.text;
        conf = Math.min(Math.max(conf, 40), 70);
      }
    }
    tokens.push({ page, x0: w.bbox.x0, x1: w.bbox.x1, top: w.bbox.y0, bottom: w.bbox.y1, text, rtl: HEB.test(text), conf });
  }
  return tokens;
}

export async function ocrPages(doc: unknown, pageNumbers: number[], onProgress?: (p: OcrProgress) => void): Promise<Token[]> {
  let current = 0;
  const { worker, digits } = await createWorkers((progress) => onProgress?.({ page: current, pages: pageNumbers.length, progress, stage: 'recognize' }));
  const pdf = doc as PdfDoc;
  const factory = pdf.canvasFactory as CanvasFactory;
  const tokens: Token[] = [];
  try {
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
        tokens.push(...(await recognizeCanvas(worker, digits, factory, pair, n)));
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

/**
 * OCR of prepared grayscale images (photographs, 1.1.8). `variants` are tried in order (e.g. orientations);
 * `score` picks the best reading, and the search stops early once `goodEnough` is reached.
 */
export async function ocrImages(
  count: number,
  variant: (i: number) => { w: number; h: number; rgba: Uint8ClampedArray },
  factory: CanvasFactory,
  opts: {
    onProgress?: (p: OcrProgress) => void;
    score: (t: Token[]) => number;
    goodEnough: number;
    /** Second look at weak lines: `reread(box)` re-reads a strip of the image with the digits-only model. */
    refine?: (tokens: Token[], reread: (box: { x0: number; x1: number; top: number; bottom: number }) => Promise<Token[]>) => Promise<Token[]>;
  },
): Promise<{ tokens: Token[]; variant: number }> {
  let current = 0;
  const { worker, digits } = await createWorkers((progress) => opts.onProgress?.({ page: current, pages: count, progress, stage: 'recognize' }));
  let best: { tokens: Token[]; variant: number; score: number } | null = null;
  try {
    for (let i = 0; i < count; i++) {
      current = i + 1;
      opts.onProgress?.({ page: current, pages: count, progress: 0, stage: 'render' });
      const v = variant(i);
      const pair = factory.create(v.w, v.h);
      try {
        const ctx = pair.context as { createImageData(w: number, h: number): { data: Uint8ClampedArray }; putImageData(d: unknown, x: number, y: number): void };
        const img = ctx.createImageData(v.w, v.h);
        img.data.set(v.rgba);
        ctx.putImageData(img, 0, 0);
        let tokens = await recognizeCanvas(worker, digits, factory, pair, 1);
        if (opts.refine && digits) tokens = await opts.refine(tokens, (box) => rereadLine(digits!, factory, pair, box));
        const sc = opts.score(tokens);
        if (!best || sc > best.score) best = { tokens, variant: i, score: sc };
        if (sc >= opts.goodEnough) break;
      } finally {
        factory.destroy(pair);
      }
    }
  } finally {
    await worker.terminate();
    await digits?.terminate();
  }
  return { tokens: best?.tokens ?? [], variant: best?.variant ?? 0 };
}

/** Digits-only reading of one horizontal strip, word by word, in page coordinates. */
async function rereadLine(worker: Worker, factory: CanvasFactory, page: CanvasPair, b: { x0: number; x1: number; top: number; bottom: number }): Promise<Token[]> {
  const x = Math.max(0, Math.floor(b.x0));
  const y = Math.max(0, Math.floor(b.top));
  const w = Math.min(page.canvas.width - x, Math.ceil(b.x1 - b.x0));
  const h = Math.min(page.canvas.height - y, Math.ceil(b.bottom - b.top));
  if (w < 8 || h < 6) return [];
  const crop = factory.create(w, h);
  try {
    const ctx = crop.context as { fillStyle: string; fillRect(...a: number[]): void; drawImage(...a: unknown[]): void };
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(page.canvas, x, y, w, h, 0, 0, w, h);
    const img = typeof crop.canvas.toBuffer === 'function' ? crop.canvas.toBuffer('image/png') : crop.canvas;
    const { data } = await worker.recognize(img as never, {}, { blocks: true, text: false });
    const words = (data.blocks ?? []).flatMap((bl) => bl.paragraphs.flatMap((p) => p.lines.flatMap((l) => l.words)));
    return words
      .filter((wd) => wd.text.trim())
      .map((wd) => ({ page: 1, x0: wd.bbox.x0 + x, x1: wd.bbox.x1 + x, top: wd.bbox.y0 + y, bottom: wd.bbox.y1 + y, text: wd.text.trim(), rtl: false, conf: wd.confidence }));
  } catch {
    return [];
  } finally {
    factory.destroy(crop);
  }
}

/** Character classes of a numeric token: "17:13" → "dd:dd". */
const shape = (t: string) => t.replace(/\d/g, 'd');

async function rereadDigits(
  worker: { recognize(img: never): Promise<{ data: { text: string; confidence: number } }> },
  factory: CanvasFactory,
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
