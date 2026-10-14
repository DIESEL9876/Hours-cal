/**
 * Rebuilds a table (Grid) from positioned text tokens — text-PDF items or OCR words.
 *
 * Rows are anchored on the date column (the x-cluster holding most full dates); each row's band runs
 * half-way to its neighbours, so multi-line cells (e.g. addresses) do not shift values between rows.
 * Columns come from the header lines directly above the first data row; every value token is
 * assigned to the nearest header column. Columns are emitted in reading order (right-to-left for
 * Hebrew documents). All tolerances are relative to the text height, so the same code serves PDF
 * points and OCR pixels.
 */
import type { Cell, GridSheet } from './types';
import { cleanText, headerKey, matchHeader } from './values';

export interface Token {
  page: number;
  x0: number;
  x1: number;
  /** Top-down coordinates. */
  top: number;
  bottom: number;
  text: string;
  rtl: boolean;
  conf?: number;
}

const HEB = /[֐-׿]/;
const DATE_TOKEN = /^\*?\d{1,2}[/.]\d{1,2}[/.](\d{4}|\d{2})\*?$/;

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const cx = (t: { x0: number; x1: number }) => (t.x0 + t.x1) / 2;
const cy = (t: { top: number; bottom: number }) => (t.top + t.bottom) / 2;
const h = (t: Token) => Math.max(1, t.bottom - t.top);

/** Groups tokens of one page into lines (top-down). */
export function toLines(tokens: Token[]): Token[][] {
  const sorted = [...tokens].sort((a, b) => cy(a) - cy(b));
  const lines: Token[][] = [];
  for (const t of sorted) {
    const line = lines[lines.length - 1];
    if (line) {
      const ref = median(line.map(cy));
      const lh = median(line.map(h));
      if (Math.abs(cy(t) - ref) <= Math.max(lh, h(t)) * 0.45) {
        line.push(t);
        continue;
      }
    }
    lines.push([t]);
  }
  return lines;
}

/** Text of a line in reading order. */
export function lineText(line: Token[]): string {
  const rtl = line.filter((t) => HEB.test(t.text)).length * 2 >= line.length && line.some((t) => HEB.test(t.text));
  return line
    .slice()
    .sort((a, b) => (rtl ? b.x0 - a.x0 : a.x0 - b.x0))
    .map((t) => t.text)
    .join(' ');
}

/**
 * Merges glyph-level items (some PDF generators emit one item per letter) into words/phrases.
 * Items on one line that touch horizontally (gap ≤ 0.35 × text height) are joined.
 */
export function mergeGlyphs(tokens: Token[], factor = 0.35): Token[] {
  const out: Token[] = [];
  const byPage = new Map<number, Token[]>();
  for (const t of tokens) if (cleanText(t.text)) byPage.set(t.page, [...(byPage.get(t.page) ?? []), t]);
  for (const pageTokens of byPage.values()) {
    for (const line of toLines(pageTokens)) {
      const xs = line.sort((a, b) => a.x0 - b.x0);
      let group: Token[] = [];
      const flush = () => {
        if (!group.length) return;
        const rtl = group.some((g) => g.rtl || HEB.test(g.text));
        const ordered = rtl ? [...group].sort((a, b) => b.x0 - a.x0) : group;
        let text = '';
        for (let i = 0; i < ordered.length; i++) {
          const prev = ordered[i - 1];
          const cur = ordered[i];
          if (prev) {
            const gap = rtl ? prev.x0 - cur.x1 : cur.x0 - prev.x1;
            if (gap > 0.2 * Math.max(h(prev), h(cur))) text += ' ';
          }
          text += cur.text;
        }
        const confs = group.map((g) => g.conf).filter((c): c is number => typeof c === 'number');
        out.push({
          page: group[0].page,
          x0: Math.min(...group.map((g) => g.x0)),
          x1: Math.max(...group.map((g) => g.x1)),
          top: Math.min(...group.map((g) => g.top)),
          bottom: Math.max(...group.map((g) => g.bottom)),
          text: cleanText(text),
          rtl,
          conf: confs.length ? Math.min(...confs) : undefined,
        });
        group = [];
      };
      for (const t of xs) {
        const last = group[group.length - 1];
        if (last && t.x0 - last.x1 <= factor * Math.max(h(last), h(t)) && t.x0 >= last.x0 - 0.5) group.push(t);
        else {
          flush();
          group.push(t);
        }
      }
      flush();
    }
  }
  return out;
}

interface HeaderColumn {
  x0: number;
  x1: number;
  parts: Token[];
}

const overlap = (a: { x0: number; x1: number }, b: { x0: number; x1: number }) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));

/** Header columns from header tokens; a label spanning two or more columns (group title) is ignored. */
function headerColumns(tokens: Token[]): HeaderColumn[] {
  const cols: HeaderColumn[] = [];
  for (const t of [...tokens].sort((a, b) => a.x1 - a.x0 - (b.x1 - b.x0))) {
    const hits = cols.filter((c) => overlap(c, t) >= 0.5 * Math.min(c.x1 - c.x0, t.x1 - t.x0));
    if (hits.length === 0) cols.push({ x0: t.x0, x1: t.x1, parts: [t] });
    else if (hits.length === 1) {
      hits[0].parts.push(t);
      hits[0].x0 = Math.min(hits[0].x0, t.x0);
      hits[0].x1 = Math.max(hits[0].x1, t.x1);
    }
  }
  return cols;
}

export interface LayoutResult {
  sheet: GridSheet | null;
  /** Lines of text above the table (all pages) — titles, labels. */
  freeText: string[];
}

export interface PageInfo {
  page: number;
  employee: string | null;
  employeeNo: string | null;
}

/** Employee name / number printed above the table on a page. */
export function employeeFromLines(lines: string[]): { name: string | null; number: string | null } {
  let name: string | null = null;
  let number: string | null = null;
  for (const raw of lines) {
    const l = cleanText(raw);
    const k = headerKey(l);
    const label = /(שם\s*ה?עובד|employee\s*name|שם\s*עובד\/ת)\s*:?/i;
    if (!name && label.test(l)) {
      const v = cleanText(l.replace(label, '').replace(/^[:\-–]\s*/, ''));
      if (v && v.length <= 60) name = v;
    }
    const num = /(מספר\s*עובד|מס['׳]?\s*עובד|employee\s*(?:no|number|id))\s*:?\s*(\S+)/i.exec(l);
    if (!number && num) number = num[2];
    if (!name) {
      // "דוח נוכחות - <name> (130)"
      const t2 = /(?:דו"?ח|דוח|report)[^-–]{0,30}[-–]\s*(.{2,40}?)\s*[()]\s*(\d{1,8})\s*[()]/i.exec(l);
      if (t2) {
        name = cleanText(t2[1]);
        number = number ?? t2[2];
      }
    }
    if (!name) {
      // "<name> (130) - דו"ח נוכחות" — parentheses may come out mirrored from RTL PDFs.
      const title = /^(.{2,40}?)\s*[()]\s*(\d{1,8})\s*[()]\s*[-–]?\s*(דו"?ח|דוח|report)/i.exec(l);
      if (title) {
        name = cleanText(title[1]);
        number = number ?? title[2];
      }
    }
    if (k.includes('employee') && !name) {
      const m = /employee\s*:?\s*(.+)$/i.exec(l);
      if (m) name = cleanText(m[1]);
    }
  }
  return { name, number };
}

export function layoutTable(rawTokens: Token[], opts: { mergeGlyphs: boolean }): LayoutResult {
  // Text PDFs: glyphs → words (tight). OCR: words → phrases ("שעת" + "כניסה"); columns are much further apart.
  const tokens = mergeGlyphs(rawTokens, opts.mergeGlyphs ? 0.35 : 0.8);
  const lh = median(tokens.map(h)) || 1;

  // 1. Date anchors: the x-cluster with most full dates.
  const dates = tokens.filter((t) => DATE_TOKEN.test(t.text));
  const clusters: Token[][] = [];
  for (const d of [...dates].sort((a, b) => cx(a) - cx(b))) {
    const c = clusters[clusters.length - 1];
    if (c && Math.abs(cx(d) - median(c.map(cx))) <= 2 * lh) c.push(d);
    else clusters.push([d]);
  }
  const anchorCluster = clusters.sort((a, b) => b.length - a.length)[0];
  const pages = [...new Set(tokens.map((t) => t.page))].sort((a, b) => a - b);
  const freeText: string[] = [];
  if (!anchorCluster || anchorCluster.length < 2) {
    for (const p of pages) freeText.push(...toLines(tokens.filter((t) => t.page === p)).map(lineText));
    return { sheet: null, freeText };
  }
  const anchorSet = new Set(anchorCluster);

  // Row spacing (median distance between consecutive anchors on a page).
  const gaps: number[] = [];
  for (const p of pages) {
    const a = anchorCluster.filter((t) => t.page === p).sort((x, y) => cy(x) - cy(y));
    for (let i = 1; i < a.length; i++) gaps.push(cy(a[i]) - cy(a[i - 1]));
  }
  const half = (median(gaps) || 2.4 * lh) / 2;

  interface PageLayout {
    page: number;
    cols: HeaderColumn[];
    score: number;
    headerSet: Set<Token>;
    bodies: { anchor: Token; tokens: Token[] }[];
    dateCol: HeaderColumn;
  }
  const layouts: PageLayout[] = [];
  let lastEmployee: { name: string | null; number: string | null } = { name: null, number: null };
  const employees = new Map<number, { name: string | null; number: string | null }>();
  const labelOf = (c: HeaderColumn, rtlText: boolean) =>
    c.parts
      .slice()
      .sort((a, b) => a.top - b.top || (rtlText ? b.x0 - a.x0 : a.x0 - b.x0))
      .map((t) => t.text)
      .join(' ');

  for (const p of pages) {
    const pageTokens = tokens.filter((t) => t.page === p);
    const anchors = anchorCluster.filter((t) => t.page === p).sort((a, b) => cy(a) - cy(b));
    if (!anchors.length) continue;
    const firstTop = anchors[0].top;

    // 2. Header: lines directly above the first data row that look like column titles.
    const above = toLines(pageTokens.filter((t) => t.bottom <= firstTop + 0.2 * lh));
    // Data column positions from the first rows (values on the date anchors' lines).
    const dataXs = pageTokens
      .filter((t) => anchors.slice(0, 6).some((a) => Math.abs(cy(t) - cy(a)) <= 0.6 * lh))
      .map((t) => ({ x0: t.x0, x1: t.x1 }));
    const alignedColumns = (line: Token[]) =>
      new Set(line.map((t) => dataXs.findIndex((d) => Math.abs(cx(d) - cx(t)) <= Math.max((d.x1 - d.x0) / 2, (t.x1 - t.x0) / 2) + 0.5 * lh)).filter((i) => i >= 0)).size;
    const headerLines: Token[][] = [];
    let prevTop = firstTop;
    for (let i = above.length - 1; i >= 0 && headerLines.length < 4; i--) {
      const line = above[i];
      const bottom = Math.max(...line.map((t) => t.bottom));
      if (prevTop - bottom > 2.2 * lh) break;
      // A header line names columns ("כניסה"), is a numbering line ("1 1 2 2"), or spreads over several
      // data columns (multi-level headers). Titles / period lines ("תקופה: 01/09/2026-30/09/2026") stop the walk.
      const names = line.filter((t) => matchHeader(t.text) && !/\d{4}/.test(t.text)).length;
      const hasDates = line.some((t) => /\d{1,2}[/.]\d{1,2}[/.]\d{2,4}/.test(t.text));
      const numbering = line.every((t) => cleanText(t.text).length <= 3) && alignedColumns(line) >= 2;
      const spread = line.length >= 2 && alignedColumns(line) >= 2;
      if (!names && (hasDates || (!numbering && !spread))) break;
      headerLines.unshift(line);
      prevTop = Math.min(...line.map((t) => t.top));
    }
    const headerTokens = headerLines.flat().filter((t) => !DATE_TOKEN.test(t.text));
    const cols = headerColumns(headerTokens);
    const score = cols.filter((c) => matchHeader(c.parts.map((t) => t.text).join(' '))).length;
    const headerSet = new Set(headerLines.flat());

    // Free text above the header (titles, employee name, period).
    const titleLines = above.filter((l) => !l.some((t) => headerSet.has(t))).map(lineText);
    freeText.push(...titleLines);
    const emp = employeeFromLines(titleLines);
    if (emp.name || emp.number) lastEmployee = emp;
    employees.set(p, lastEmployee);

    // 3. Row bands.
    const bodies = anchors.map((a, i) => {
      const top = i === 0 ? cy(a) - half : (cy(anchors[i - 1]) + cy(a)) / 2;
      const bottom = i === anchors.length - 1 ? cy(a) + half : (cy(a) + cy(anchors[i + 1])) / 2;
      return { anchor: a, tokens: pageTokens.filter((t) => t !== a && !anchorSet.has(t) && !headerSet.has(t) && cy(t) >= top && cy(t) < bottom) };
    });
    const dateCol: HeaderColumn = { x0: Math.min(...anchors.map((t) => t.x0)), x1: Math.max(...anchors.map((t) => t.x1)), parts: [] };
    layouts.push({ page: p, cols, score, headerSet, bodies, dateCol });
  }

  // 4. Columns. Each page uses its own header when it has one (column positions can differ between
  //    pages); pages without a header reuse the best header. Columns are unified across pages by label.
  const best = layouts.reduce((a, b) => (b.score > a.score ? b : a), layouts[0]);
  const rtl = headerTokensRtl(best.cols) ?? anchorCluster.some((t) => t.rtl);
  interface Canon {
    key: string;
    label: string;
    x: number;
  }
  const canon: Canon[] = [{ key: '__date__', label: '', x: cx(best.dateCol) }];
  const canonIndex = (key: string, label: string, x: number) => {
    let i = canon.findIndex((c) => c.key === key);
    if (i < 0) {
      canon.push({ key, label, x });
      i = canon.length - 1;
    }
    return i;
  };
  const pageRows: { page: number; anchor: Token; cells: Map<number, Token[]> }[] = [];
  for (const L of layouts) {
    const source = L.score >= 2 ? L : best;
    const dateCol = { ...L.dateCol };
    const labelled = source.cols.filter((c) => overlap(c, dateCol) < 0.5 * Math.min(c.x1 - c.x0, dateCol.x1 - dateCol.x0));
    const dateHeader = source.cols.find((c) => !labelled.includes(c));
    if (dateHeader && !canon[0].label) canon[0].label = labelOf(dateHeader, rtl);
    const colKey = new Map<HeaderColumn, number>();
    colKey.set(dateCol, 0);
    for (const c of labelled) {
      const label = labelOf(c, rtl);
      colKey.set(c, canonIndex(`h:${headerKey(label)}`, label, cx(c)));
    }
    const extra: HeaderColumn[] = [];
    const nearest = (t: Token): HeaderColumn | null => {
      let bestCol: HeaderColumn | null = null;
      let bestD = Infinity;
      for (const c of [dateCol, ...labelled, ...extra]) {
        const d = Math.abs(cx(c) - cx(t));
        const reach = Math.max((c.x1 - c.x0) / 2, (t.x1 - t.x0) / 2) + 0.9 * lh;
        if (d <= reach && d < bestD) {
          bestCol = c;
          bestD = d;
        }
      }
      return bestCol;
    };
    for (const b of L.bodies) {
      const cells = new Map<number, Token[]>();
      for (const t of b.tokens) {
        let c = nearest(t);
        if (!c) {
          c = { x0: t.x0, x1: t.x1, parts: [] };
          extra.push(c);
          colKey.set(c, canonIndex(`x:${L.page}:${Math.round(cx(c) / lh)}`, '', cx(c)));
        }
        const i = colKey.get(c)!;
        cells.set(i, [...(cells.get(i) ?? []), t]);
      }
      pageRows.push({ page: L.page, anchor: b.anchor, cells });
    }
  }

  // Reading order of the unified columns (by their position on the page they were first seen).
  const order = canon.map((c, i) => ({ c, i })).sort((a, b) => (rtl ? b.c.x - a.c.x : a.c.x - b.c.x));
  const pos = new Map(order.map((o, k) => [o.i, k]));
  const rows: Cell[][] = [order.map((o) => ({ text: o.c.label }))];
  const rowMeta: { page?: number; employee?: string | null; employeeNo?: string | null }[] = [{}];
  for (const r of pageRows) {
    const cells: Cell[] = order.map(() => ({ text: '' }));
    cells[pos.get(0)!] = { text: r.anchor.text, conf: r.anchor.conf };
    for (const [i, ts] of r.cells) {
      if (i === 0) continue; // the date cell is the anchor date only (annotations such as "ערב חג" are dropped)
      const sorted = ts.sort((a, c) => a.top - c.top || (rtl ? c.x0 - a.x0 : a.x0 - c.x0));
      const confs = sorted.map((t) => t.conf).filter((c): c is number => typeof c === 'number');
      cells[pos.get(i)!] = { text: sorted.map((t) => t.text).join(' '), conf: confs.length ? Math.min(...confs) : undefined, parts: sorted.map((t) => t.text) };
    }
    rows.push(cells);
    const emp = employees.get(r.page);
    rowMeta.push({ page: r.page, employee: emp?.name ?? null, employeeNo: emp?.number ?? null });
  }

  return { sheet: { name: 'PDF', rows, rtl, rowMeta, headerText: freeText }, freeText };
}

function headerTokensRtl(cols: HeaderColumn[]): boolean | null {
  const parts = cols.flatMap((c) => c.parts);
  if (!parts.length) return null;
  return parts.filter((t) => HEB.test(t.text)).length * 2 >= parts.length;
}
