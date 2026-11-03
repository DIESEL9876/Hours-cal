/**
 * Image preprocessing for photographed attendance reports (1.1.8). Pure functions on 8-bit grayscale buffers, so the
 * desktop app and the tests run exactly the same code. Each step is conservative: when it cannot measure what it needs
 * (e.g. no visible paper edge), it leaves the image unchanged rather than guessing.
 */

export interface Gray {
  w: number;
  h: number;
  /** Row-major luminance 0..255. */
  px: Uint8Array;
}

export function toGray(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number): Gray {
  const px = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < px.length; i++, j += 4) {
    const a = rgba[j + 3] / 255;
    // Transparent pixels become white paper.
    px[i] = Math.round((0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2]) * a + 255 * (1 - a));
  }
  return { w, h, px };
}

export function toRgba(g: Gray): Uint8ClampedArray {
  const out = new Uint8ClampedArray(g.w * g.h * 4);
  for (let i = 0, j = 0; i < g.px.length; i++, j += 4) {
    out[j] = out[j + 1] = out[j + 2] = g.px[i];
    out[j + 3] = 255;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// EXIF orientation (JPEG) — applied here, so every decoder behaves the same.
// ---------------------------------------------------------------------------------------------

export function jpegOrientation(b: Uint8Array): number {
  if (b[0] !== 0xff || b[1] !== 0xd8) return 1;
  let p = 2;
  while (p + 4 < b.length && p < 256 * 1024) {
    if (b[p] !== 0xff) return 1;
    const marker = b[p + 1];
    const len = (b[p + 2] << 8) | b[p + 3];
    if (marker === 0xe1 && b[p + 4] === 0x45 && b[p + 5] === 0x78 && b[p + 6] === 0x69 && b[p + 7] === 0x66) {
      const t = p + 10; // TIFF header
      const le = b[t] === 0x49;
      const u16 = (o: number) => (le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
      const u32 = (o: number) => (le ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0 : ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0);
      const ifd = t + u32(t + 4);
      const n = u16(ifd);
      for (let i = 0; i < n && ifd + 2 + i * 12 + 12 <= b.length; i++) {
        const e = ifd + 2 + i * 12;
        if (u16(e) === 0x0112) {
          const v = u16(e + 8);
          return v >= 1 && v <= 8 ? v : 1;
        }
      }
      return 1;
    }
    if (marker === 0xda) return 1;
    p += 2 + len;
  }
  return 1;
}

/** Applies an EXIF orientation (1–8). */
export function orient(g: Gray, o: number): Gray {
  if (o === 1) return g;
  const { w, h, px } = g;
  const swap = o >= 5;
  const W = swap ? h : w;
  const H = swap ? w : h;
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      let sx: number, sy: number;
      switch (o) {
        case 2: [sx, sy] = [w - 1 - x, y]; break;
        case 3: [sx, sy] = [w - 1 - x, h - 1 - y]; break;
        case 4: [sx, sy] = [x, h - 1 - y]; break;
        case 5: [sx, sy] = [y, x]; break;
        case 6: [sx, sy] = [y, h - 1 - x]; break;
        case 7: [sx, sy] = [w - 1 - y, h - 1 - x]; break;
        default: [sx, sy] = [w - 1 - y, x]; break; // 8
      }
      out[y * W + x] = px[sy * w + sx];
    }
  return { w: W, h: H, px: out };
}

/** Quarter turns clockwise (0–3). */
export function rotateQuarter(g: Gray, q: number): Gray {
  return [g, orient(g, 6), orient(g, 3), orient(g, 8)][((q % 4) + 4) % 4];
}

// ---------------------------------------------------------------------------------------------
// Resampling
// ---------------------------------------------------------------------------------------------

export function resize(g: Gray, W: number, H: number): Gray {
  W = Math.max(1, Math.round(W));
  H = Math.max(1, Math.round(H));
  const out = new Uint8Array(W * H);
  const sx = g.w / W;
  const sy = g.h / H;
  if (sx > 1 || sy > 1) {
    // Area average (downscale).
    for (let y = 0; y < H; y++) {
      const y0 = Math.floor(y * sy);
      const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
      for (let x = 0; x < W; x++) {
        const x0 = Math.floor(x * sx);
        const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
        let s = 0;
        for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) s += g.px[yy * g.w + xx];
        out[y * W + x] = Math.round(s / ((y1 - y0) * (x1 - x0)));
      }
    }
    return { w: W, h: H, px: out };
  }
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) out[y * W + x] = sample(g, (x + 0.5) * sx - 0.5, (y + 0.5) * sy - 0.5);
  return { w: W, h: H, px: out };
}

/** Bilinear sample; outside the image = white paper. */
function sample(g: Gray, x: number, y: number): number {
  if (x < -0.5 || y < -0.5 || x > g.w - 0.5 || y > g.h - 0.5) return 255;
  const x0 = Math.max(0, Math.min(g.w - 1, Math.floor(x)));
  const y0 = Math.max(0, Math.min(g.h - 1, Math.floor(y)));
  const x1 = Math.min(g.w - 1, x0 + 1);
  const y1 = Math.min(g.h - 1, y0 + 1);
  const fx = Math.max(0, Math.min(1, x - x0));
  const fy = Math.max(0, Math.min(1, y - y0));
  const a = g.px[y0 * g.w + x0] * (1 - fx) + g.px[y0 * g.w + x1] * fx;
  const b = g.px[y1 * g.w + x0] * (1 - fx) + g.px[y1 * g.w + x1] * fx;
  return Math.round(a * (1 - fy) + b * fy);
}

export function crop(g: Gray, x0: number, y0: number, x1: number, y1: number): Gray {
  x0 = Math.max(0, Math.floor(x0));
  y0 = Math.max(0, Math.floor(y0));
  x1 = Math.min(g.w, Math.ceil(x1));
  y1 = Math.min(g.h, Math.ceil(y1));
  const W = x1 - x0;
  const H = y1 - y0;
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) out.set(g.px.subarray((y0 + y) * g.w + x0, (y0 + y) * g.w + x1), y * W);
  return { w: W, h: H, px: out };
}

// ---------------------------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------------------------

export function otsu(px: Uint8Array): number {
  const hist = new Array(256).fill(0);
  for (const v of px) hist[v]++;
  const total = px.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let thr = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) {
      best = between;
      thr = t;
    }
  }
  return thr;
}

function percentile(px: Uint8Array, p: number): number {
  const hist = new Array(256).fill(0);
  for (const v of px) hist[v]++;
  const target = px.length * p;
  let acc = 0;
  for (let i = 0; i < 256; i++) {
    acc += hist[i];
    if (acc >= target) return i;
  }
  return 255;
}

// ---------------------------------------------------------------------------------------------
// Paper detection: crop to the sheet and correct keystone (perspective) from its left/right edges
// ---------------------------------------------------------------------------------------------

export interface PaperInfo {
  /** Paper bounds in the image (x0,y0,x1,y1). */
  box: [number, number, number, number];
  /** Left/right paper edge at the top and bottom of the paper (for keystone correction). */
  top: [number, number];
  bottom: [number, number];
}

/** Bright paper on a darker background. Null when no clear paper region is visible (photo inside the page). */
export function findPaper(g: Gray): PaperInfo | null {
  const scale = Math.min(1, 400 / Math.max(g.w, g.h));
  const s = scale < 1 ? resize(g, g.w * scale, g.h * scale) : g;
  const thr = otsu(s.px);
  const bright = (x: number, y: number) => s.px[y * s.w + x] > thr;
  let darkShare = 0;
  for (const v of s.px) if (v <= thr) darkShare++;
  darkShare /= s.px.length;
  if (darkShare < 0.12) return null; // mostly paper: nothing to crop
  // Rows/columns that are mostly paper.
  const colFrac = Array.from({ length: s.w }, (_, x) => {
    let n = 0;
    for (let y = 0; y < s.h; y++) if (bright(x, y)) n++;
    return n / s.h;
  });
  const run = (fr: number[], min: number): [number, number] | null => {
    let best: [number, number] | null = null;
    let start = -1;
    for (let i = 0; i <= fr.length; i++) {
      if (i < fr.length && fr[i] >= min) {
        if (start < 0) start = i;
      } else if (start >= 0) {
        if (!best || i - start > best[1] - best[0]) best = [start, i];
        start = -1;
      }
    }
    return best;
  };
  const cols = run(colFrac, 0.45);
  if (!cols || cols[1] - cols[0] < s.w * 0.2) return null;
  const rowFrac = Array.from({ length: s.h }, (_, y) => {
    let n = 0;
    for (let x = cols[0]; x < cols[1]; x++) if (bright(x, y)) n++;
    return n / (cols[1] - cols[0]);
  });
  const rows = run(rowFrac, 0.5);
  if (!rows || rows[1] - rows[0] < s.h * 0.2) return null;
  // Paper edges per row band (median of the outermost bright pixel of each row).
  const edges = (y0: number, y1: number): [number, number] => {
    const ls: number[] = [];
    const rs: number[] = [];
    for (let y = Math.max(0, y0); y < Math.min(s.h, y1); y++) {
      let l = -1;
      let r = -1;
      for (let x = 0; x < s.w; x++) if (bright(x, y)) {
        // require a short bright run so isolated reflections are ignored
        if (x + 3 < s.w && bright(x + 1, y) && bright(x + 2, y) && bright(x + 3, y)) {
          l = x;
          break;
        }
      }
      for (let x = s.w - 1; x >= 0; x--) if (bright(x, y)) {
        if (x - 3 >= 0 && bright(x - 1, y) && bright(x - 2, y) && bright(x - 3, y)) {
          r = x + 1;
          break;
        }
      }
      if (l >= 0 && r > l) {
        ls.push(l);
        rs.push(r);
      }
    }
    const med = (a: number[]) => (a.length ? [...a].sort((p, q) => p - q)[Math.floor(a.length / 2)] : NaN);
    return [med(ls), med(rs)];
  };
  const band = Math.max(3, Math.round((rows[1] - rows[0]) * 0.06));
  const top = edges(rows[0], rows[0] + band);
  const bottom = edges(rows[1] - band, rows[1]);
  if ([...top, ...bottom].some((v) => !Number.isFinite(v))) return null;
  const k = 1 / scale;
  return {
    box: [cols[0] * k, rows[0] * k, cols[1] * k, rows[1] * k],
    top: [top[0] * k, top[1] * k],
    bottom: [bottom[0] * k, bottom[1] * k],
  };
}

/** Solves the 3×3 homography mapping 4 source points onto 4 destination points. */
function homography(src: [number, number][], dst: [number, number][]): number[] {
  const A: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  // Gaussian elimination on the 8×9 augmented matrix.
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    const d = A[c][c] || 1e-12;
    for (let k = c; k < 9; k++) A[c][k] /= d;
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c];
      for (let k = c; k < 9; k++) A[r][k] -= f * A[c][k];
    }
  }
  return [...A.map((r) => r[8]), 1];
}

/**
 * Crops to the paper and corrects a keystone (a sheet photographed at an angle is wider at the near edge).
 * Returns the image unchanged when no paper edge is visible.
 */
export function straightenPaper(g: Gray): { img: Gray; cropped: boolean; keystone: boolean } {
  const p = findPaper(g);
  if (!p) return { img: g, cropped: false, keystone: false };
  const [bx0, by0, bx1, by1] = p.box;
  const W = Math.round(Math.max(p.top[1] - p.top[0], p.bottom[1] - p.bottom[0]));
  const H = Math.round(by1 - by0);
  const skew = Math.max(Math.abs(p.top[0] - p.bottom[0]), Math.abs(p.top[1] - p.bottom[1]));
  if (skew < 0.015 * W || W < 50 || H < 50) {
    const pad = 4;
    return { img: crop(g, bx0 - pad, by0 - pad, bx1 + pad, by1 + pad), cropped: true, keystone: false };
  }
  // Map the destination rectangle back into the source quad.
  const Hm = homography(
    [
      [0, 0],
      [W, 0],
      [W, H],
      [0, H],
    ],
    [
      [p.top[0], by0],
      [p.top[1], by0],
      [p.bottom[1], by1],
      [p.bottom[0], by1],
    ],
  );
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const d = Hm[6] * x + Hm[7] * y + Hm[8];
      out[y * W + x] = sample(g, (Hm[0] * x + Hm[1] * y + Hm[2]) / d, (Hm[3] * x + Hm[4] * y + Hm[5]) / d);
    }
  return { img: { w: W, h: H, px: out }, cropped: true, keystone: true };
}

// ---------------------------------------------------------------------------------------------
// Illumination (shadows) and contrast
// ---------------------------------------------------------------------------------------------

/** Separable sliding maximum (removes dark text, keeps the paper's brightness). */
function maxFilter(g: Gray, r: number): Gray {
  const tmp = new Uint8Array(g.px.length);
  const out = new Uint8Array(g.px.length);
  for (let y = 0; y < g.h; y++)
    for (let x = 0; x < g.w; x++) {
      let m = 0;
      for (let k = Math.max(0, x - r); k <= Math.min(g.w - 1, x + r); k++) m = Math.max(m, g.px[y * g.w + k]);
      tmp[y * g.w + x] = m;
    }
  for (let x = 0; x < g.w; x++)
    for (let y = 0; y < g.h; y++) {
      let m = 0;
      for (let k = Math.max(0, y - r); k <= Math.min(g.h - 1, y + r); k++) m = Math.max(m, tmp[k * g.w + x]);
      out[y * g.w + x] = m;
    }
  return { w: g.w, h: g.h, px: out };
}

function boxBlur(g: Gray, r: number): Gray {
  const tmp = new Float32Array(g.px.length);
  const out = new Uint8Array(g.px.length);
  for (let y = 0; y < g.h; y++) {
    let s = 0;
    let n = 0;
    for (let x = -r; x < g.w; x++) {
      if (x + r < g.w) {
        s += g.px[y * g.w + x + r];
        n++;
      }
      if (x - r - 1 >= 0) {
        s -= g.px[y * g.w + x - r - 1];
        n--;
      }
      if (x >= 0) tmp[y * g.w + x] = s / n;
    }
  }
  for (let x = 0; x < g.w; x++) {
    let s = 0;
    let n = 0;
    for (let y = -r; y < g.h; y++) {
      if (y + r < g.h) {
        s += tmp[(y + r) * g.w + x];
        n++;
      }
      if (y - r - 1 >= 0) {
        s -= tmp[(y - r - 1) * g.w + x];
        n--;
      }
      if (y >= 0) out[y * g.w + x] = Math.round(s / n);
    }
  }
  return { w: g.w, h: g.h, px: out };
}

/** Divides by the estimated paper brightness (removes shadows / uneven light), then stretches the contrast. */
export function flattenIllumination(g: Gray): Gray {
  const scale = Math.min(1, 300 / Math.max(g.w, g.h));
  const s = resize(g, g.w * scale, g.h * scale);
  const r = Math.max(2, Math.round(Math.max(s.w, s.h) / 40));
  const bgSmall = boxBlur(maxFilter(s, r), r);
  const bg = resize(bgSmall, g.w, g.h);
  const out = new Uint8Array(g.px.length);
  for (let i = 0; i < out.length; i++) out[i] = Math.min(255, Math.round((g.px[i] * 255) / Math.max(40, bg.px[i])));
  const lo = percentile(out, 0.005);
  const hi = Math.max(lo + 1, percentile(out, 0.6));
  for (let i = 0; i < out.length; i++) out[i] = Math.max(0, Math.min(255, Math.round(((out[i] - lo) * 255) / (hi - lo))));
  return { w: g.w, h: g.h, px: out };
}

// ---------------------------------------------------------------------------------------------
// Deskew
// ---------------------------------------------------------------------------------------------

/** Text-line angle in degrees (positive = text rises to the right), searched within ±maxDeg. */
export function skewAngle(g: Gray, maxDeg = 10): number {
  const scale = Math.min(1, 900 / Math.max(g.w, g.h));
  const s = scale < 1 ? resize(g, g.w * scale, g.h * scale) : g;
  const thr = Math.min(otsu(s.px), 160);
  const pts: [number, number][] = [];
  for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) if (s.px[y * s.w + x] < thr) pts.push([x, y]);
  if (pts.length < 50) return 0;
  const score = (deg: number) => {
    const a = (deg * Math.PI) / 180;
    const sin = Math.sin(a);
    const cos = Math.cos(a);
    const bins = new Map<number, number>();
    for (const [x, y] of pts) {
      const b = Math.round(y * cos + x * sin);
      bins.set(b, (bins.get(b) ?? 0) + 1);
    }
    let v = 0;
    for (const c of bins.values()) v += c * c;
    return v;
  };
  let best = 0;
  let bestScore = score(0);
  for (let d = -maxDeg; d <= maxDeg; d += 0.5) {
    const sc = score(d);
    if (sc > bestScore * 1.0005) {
      best = d;
      bestScore = sc;
    }
  }
  for (let d = best - 0.4; d <= best + 0.4; d += 0.1) {
    const sc = score(d);
    if (sc > bestScore) {
      best = d;
      bestScore = sc;
    }
  }
  return Math.round(best * 10) / 10;
}

/** Rotates by `deg` degrees (positive = counter-clockwise), white background, same size. */
export function rotate(g: Gray, deg: number): Gray {
  if (!deg) return g;
  const a = (deg * Math.PI) / 180;
  const sin = Math.sin(a);
  const cos = Math.cos(a);
  const cx = g.w / 2;
  const cy = g.h / 2;
  const out = new Uint8Array(g.px.length);
  for (let y = 0; y < g.h; y++)
    for (let x = 0; x < g.w; x++) {
      const dx = x - cx;
      const dy = y - cy;
      out[y * g.w + x] = sample(g, cx + dx * cos - dy * sin, cy + dx * sin + dy * cos);
    }
  return { w: g.w, h: g.h, px: out };
}

// ---------------------------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------------------------

export const MAX_IMAGE_PIXELS = 40_000_000;
const WORK_MAX_SIDE = 3200;
const TARGET_MIN_WIDTH = 1900;

export interface Prepared {
  img: Gray;
  steps: string[];
}

/** Orientation → paper crop / keystone → shadows & contrast → deskew → scale for OCR. */
export function prepareForOcr(input: Gray, exifOrientation = 1): Prepared {
  const steps: string[] = [];
  let g = orient(input, exifOrientation);
  if (exifOrientation !== 1) steps.push('סיבוב לפי נתוני המצלמה');
  const big = Math.max(g.w, g.h);
  if (big > WORK_MAX_SIDE) g = resize(g, (g.w * WORK_MAX_SIDE) / big, (g.h * WORK_MAX_SIDE) / big);
  const paper = straightenPaper(g);
  g = paper.img;
  if (paper.keystone) steps.push('תיקון פרספקטיבה');
  else if (paper.cropped) steps.push('חיתוך לגבולות הדף');
  g = flattenIllumination(g);
  steps.push('איזון תאורה וניגודיות');
  const angle = skewAngle(g);
  if (Math.abs(angle) >= 0.3) {
    g = rotate(g, -angle); // text rising to the right is turned back clockwise
    steps.push(`יישור הטיה (${angle.toFixed(1)}°)`);
  }
  if (g.w < TARGET_MIN_WIDTH) {
    const k = Math.min(3, TARGET_MIN_WIDTH / g.w);
    g = resize(g, g.w * k, g.h * k);
    steps.push('הגדלה לזיהוי');
  }
  return { img: g, steps };
}
