/**
 * Photographed / scanned attendance reports (JPG, PNG, WEBP) — 1.1.8. Everything runs on this computer:
 * decode → preprocessing (imageprep.ts) → offline OCR (ocr.ts, the same engine as scanned PDFs) → table layout.
 * Nothing is uploaded. Recognition quality depends on the photo; uncertain values are flagged, never guessed.
 */
import { layoutTable, type Token } from './layout';
import { ocrImages, type CanvasFactory, type CanvasPair, type OcrProgress } from './ocr';
import { ImportError, type Grid } from './types';
import { MAX_IMAGE_PIXELS, prepareForOcr, rotateQuarter, toGray, toRgba, jpegOrientation, type Gray } from './imageprep';

export type ImageKind = 'jpeg' | 'png' | 'webp' | 'heic' | 'other-image' | null;

export function imageKind(b: Uint8Array): ImageKind {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp';
  const ftyp = String.fromCharCode(...b.subarray(4, 12));
  if (ftyp.startsWith('ftyp') && /^(heic|heix|hevc|hevx|heim|heis|mif1|msf1|avif)/.test(ftyp.slice(4))) return 'heic';
  if ((b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) || (b[0] === 0x42 && b[1] === 0x4d) || (b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00)) return 'other-image';
  return null;
}

export const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'];

export interface DecodedImage {
  w: number;
  h: number;
  rgba: Uint8ClampedArray;
  /** True when the decoder already applied the EXIF orientation (browsers do). */
  orientationApplied: boolean;
}

export interface ImageBackend {
  decode(bytes: Uint8Array, mime: string): Promise<DecodedImage>;
  factory: CanvasFactory;
}

/** Browser / desktop (WebView2) backend: the system image decoder and HTML canvases. */
const browserBackend: ImageBackend = {
  async decode(bytes, mime) {
    const url = URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer], { type: mime }));
    try {
      const img = new Image();
      img.decoding = 'async';
      img.src = url;
      await img.decode();
      let w = img.naturalWidth;
      let h = img.naturalHeight;
      if (!w || !h) throw new Error('empty image');
      if (w * h > MAX_IMAGE_PIXELS * 4) throw new ImportError('התמונה גדולה מדי לעיבוד.');
      const k = Math.min(1, Math.sqrt(MAX_IMAGE_PIXELS / (w * h)), 4000 / Math.max(w, h));
      w = Math.max(1, Math.round(w * k));
      h = Math.max(1, Math.round(h * k));
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h); // EXIF orientation is applied by the browser
      const data = ctx.getImageData(0, 0, w, h).data;
      c.width = c.height = 0;
      return { w, h, rgba: data, orientationApplied: true };
    } catch (e) {
      if (e instanceof ImportError) throw e;
      throw new ImportError('לא ניתן לפתוח את התמונה (ייתכן שהקובץ פגום או בפורמט שאינו נתמך).');
    } finally {
      URL.revokeObjectURL(url);
    }
  },
  factory: {
    create(w, h): CanvasPair {
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      return { canvas, context: canvas.getContext('2d', { willReadFrequently: true }) };
    },
    destroy(c) {
      c.canvas.width = 0;
      c.canvas.height = 0;
    },
  },
};

let backend: ImageBackend | null = null;
/** Tests (Node) provide a decoder and canvases; the app uses the browser backend. */
export function setImageBackend(b: ImageBackend) {
  backend = b;
}

const DATE_RE = /^\*?\d{1,2}[/.]\d{1,2}[/.](\d{4}|\d{2})\*?$/;
const TIME_RE = /^\d{1,2}[:.]\d{2}$/;
/** Reading quality of an orientation: recognised dates and times. */
export const ocrScore = (tokens: Token[]) => tokens.filter((t) => DATE_RE.test(t.text)).length * 3 + tokens.filter((t) => TIME_RE.test(t.text)).length;

const cy = (t: Token) => (t.top + t.bottom) / 2;
const HEB = /[\u0590-\u05ff]/;

/**
 * Rows (anchored on a date) with fewer than two clock times get a digits-only re-read of their strip. The re-read
 * replaces the row's numeric words only when it is complete (≥ 2 clock times) and confident; otherwise the original
 * reading stays and the row is flagged later. Nothing is inferred from other columns.
 */
export async function refineWeakRows(tokens: Token[], reread: (box: { x0: number; x1: number; top: number; bottom: number }) => Promise<Token[]>): Promise<Token[]> {
  const dates = tokens.filter((t) => DATE_RE.test(t.text));
  if (dates.length < 2) return tokens;
  const lineOf = (list: Token[], d: Token) => list.filter((t) => t !== d && Math.abs(cy(t) - cy(d)) <= 0.6 * (d.bottom - d.top));
  const timesIn = (list: Token[]) => list.reduce((n, t) => n + (t.text.match(TIME_G) ?? []).length, 0);
  // Expected clock values per row = what most rows show (e.g. entrance, exit and a "0:00" break).
  const counts = dates.map((d) => timesIn(lineOf(tokens, d))).sort((a, b) => a - b);
  const expected = counts[Math.floor(counts.length / 2)];
  if (expected < 2) return tokens;
  let out = tokens;
  for (const d of dates) {
    const h = d.bottom - d.top;
    const line = lineOf(out, d);
    if (timesIn(line) >= expected) continue;
    // The strip on the reading-order side of the date (RTL report: to its left; LTR: to its right).
    const leftSide = line.filter((t) => t.x1 <= d.x0).length >= line.filter((t) => t.x0 >= d.x1).length;
    const box = leftSide ? { x0: 0, x1: d.x0 - h * 0.3, top: d.top - h * 0.35, bottom: d.bottom + h * 0.35 } : { x0: d.x1 + h * 0.3, x1: 1e6, top: d.top - h * 0.35, bottom: d.bottom + h * 0.35 };
    const words = splitTimes((await reread(box)).filter((w) => /\d/.test(w.text)));
    const valid = words.filter((w) => /^\d{1,2}:\d{2}$/.test(w.text) && Number(w.text.split(':')[0]) < 24 && Number(w.text.split(':')[1]) < 60);
    // Accepted only when two re-read clock times agree to the minute with the row's decimal hours, read independently
    // with high confidence (the validation signal). Otherwise the first reading stays and the row is flagged.
    const decimal = line.find((t) => /^\d{1,2}\.\d{2}$/.test(t.text) && (t.conf ?? 0) >= 85 && Number(t.text) <= 24);
    if (!decimal) continue;
    const total = Math.round(Number(decimal.text) * 60);
    let pair: [Token, Token] | null = null;
    for (let i = 0; i < valid.length && !pair; i++)
      for (let j = 0; j < valid.length && !pair; j++) if (i !== j && Math.abs(clockSpan(valid[i].text, valid[j].text) - total) <= 1 && clockSpan(valid[i].text, valid[j].text) !== 1440) pair = [valid[i], valid[j]];
    if (!pair) continue;
    const x0 = Math.min(pair[0].x0, pair[1].x0);
    const x1 = Math.max(pair[0].x1, pair[1].x1);
    // Only the words the two times replace (overlapping them); the hours value, break and weekday stay.
    const inRange = (t: Token) => t !== d && t !== decimal && !HEB.test(t.text) && cy(t) >= box.top && cy(t) <= box.bottom && Math.min(t.x1, x1) - Math.max(t.x0, x0) > 0.3 * (t.x1 - t.x0);
    // One word for the verified range, so the table layout keeps both times in the same column.
    const merged: Token = { page: d.page, x0, x1, top: Math.min(pair[0].top, pair[1].top), bottom: Math.max(pair[0].bottom, pair[1].bottom), text: `${pair[0].text} ${pair[1].text}`, rtl: false, conf: VERIFIED_CONF };
    out = [...out.filter((t) => !inRange(t)), merged];
  }
  return out;
}

const TIME_G = /\d{1,2}:\d{2}/g;
/** Confidence given to times confirmed by an independent value (decimal hours): above the review threshold, below "certain". */
export const VERIFIED_CONF = 80;
const clockSpan = (a: string, b: string) => {
  const m = (x: string) => Number(x.split(':')[0]) * 60 + Number(x.split(':')[1]);
  return (m(b) - m(a) + 1440) % 1440 || 1440;
};

/** "14:35-10:27" read as one word → two tokens, positioned proportionally inside the word box. */
function splitTimes(words: Token[]): Token[] {
  const out: Token[] = [];
  for (const w of words) {
    const parts = [...w.text.matchAll(/\d{1,2}[:.]\d{2}|\d+(?:\.\d+)?/g)];
    if (parts.length <= 1) {
      out.push(parts.length ? { ...w, text: parts[0][0] } : w);
      continue;
    }
    const per = (w.x1 - w.x0) / Math.max(1, w.text.length);
    for (const p of parts) out.push({ ...w, text: p[0], x0: w.x0 + p.index! * per, x1: w.x0 + (p.index! + p[0].length) * per });
  }
  return out;
}

export async function readImage(bytes: Uint8Array, onProgress?: (p: OcrProgress) => void): Promise<Grid> {
  const kind = imageKind(bytes);
  if (kind === 'heic')
    throw new ImportError('תמונות בפורמט HEIC (ברירת המחדל באייפון) אינן נתמכות לזיהוי במחשב ללא חיבור לאינטרנט. יש לשמור או לשלוח את התמונה כ-JPG ולייבא שוב.');
  if (kind !== 'jpeg' && kind !== 'png' && kind !== 'webp') throw new ImportError('סוג התמונה אינו נתמך. ניתן לייבא JPG, PNG או WEBP.');
  const be = backend ?? browserBackend;
  const decoded = await be.decode(bytes, `image/${kind}`);
  if (decoded.w * decoded.h > MAX_IMAGE_PIXELS) throw new ImportError('התמונה גדולה מדי לעיבוד.');
  if (Math.min(decoded.w, decoded.h) < 200) throw new ImportError('התמונה קטנה מדי לזיהוי טקסט אמין.');
  const exif = kind === 'jpeg' && !decoded.orientationApplied ? jpegOrientation(bytes) : 1;
  const prepared = prepareForOcr(toGray(decoded.rgba, decoded.w, decoded.h), exif);
  // Orientation: as photographed first; upside-down / sideways only when the first reading finds no table.
  const turns = [0, 2, 1, 3];
  const variant = (i: number) => {
    const g: Gray = rotateQuarter(prepared.img, turns[i]);
    return { w: g.w, h: g.h, rgba: toRgba(g) };
  };
  const { tokens, variant: used } = await ocrImages(turns.length, variant, be.factory, { onProgress, score: ocrScore, goodEnough: 18, refine: refineWeakRows });
  const notes = [
    'התמונה זוהתה במחשב זה באמצעות OCR — יש להשוות כל שורה לדוח המקורי. ערכים בביטחון נמוך מסומנים לבדיקה.',
    `עיבוד התמונה: ${[...prepared.steps, ...(turns[used] ? [`סיבוב ${turns[used] * 90}°`] : [])].join(' · ')}`,
  ];
  const { sheet, freeText } = layoutTable(tokens, { mergeGlyphs: false });
  if (!sheet) notes.push('לא נמצאה בתמונה טבלה עם תאריכים.');
  return { format: 'image-ocr', sheets: sheet ? [{ ...sheet, name: 'תמונה' }] : [{ name: 'תמונה', rows: [], headerText: freeText }], notes };
}
