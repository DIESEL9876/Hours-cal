// Generates the Excel (.xlsx) and PDF (text + scanned) import fixtures from data.json.
// Dev-only (ExcelJS + Playwright Chromium). Usage: node scripts/import-fixtures/make.mjs
import ExcelJS from 'exceljs';
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const OUT = fileURLToPath(new URL('../../src/import/__tests__/fixtures/', import.meta.url));
mkdirSync(OUT, { recursive: true });
const DATA = JSON.parse(readFileSync(`${here}data.json`, 'utf8'));

const HE_DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const HE_LETTERS = ["א'", "ב'", "ג'", "ד'", "ה'", "ו'", 'ש'];
const wd = (iso) => new Date(`${iso}T12:00:00Z`).getUTCDay();
const dmy = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const excelDate = (iso) => new Date(`${iso}T00:00:00Z`);
const excelTime = (hm) => {
  const [h, m] = hm.split(':').map(Number);
  return new Date(Date.UTC(1899, 11, 30, h, m));
};
const minutes = (hm) => {
  const [h, m] = hm.split(':').map(Number);
  return h * 60 + m;
};

// ------------------------------------------------------------------- he-standard.xlsx
async function heStandard() {
  const d = DATA.heStandard;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('דוח נוכחות', { views: [{ rightToLeft: true }] });
  ws.addRow(['דוח נוכחות חודשי']);
  ws.addRow([`שם העובד: ${d.employee}`]);
  ws.addRow([`מספר עובד: ${d.number}`]);
  ws.addRow(['חודש: ספטמבר 2026']);
  ws.addRow([]);
  ws.addRow(['תאריך', 'יום', 'שעת כניסה', 'שעת יציאה', 'הפסקה', 'סה"כ שעות', 'הערות']);
  const first = ws.rowCount + 1;
  for (const [date, start, end, brk, note] of d.rows) {
    let total = null;
    if (start && end) {
      let t = minutes(end) - minutes(start);
      if (t <= 0) t += 1440;
      if (brk) t -= minutes(brk);
      total = t / 1440;
    }
    const row = ws.addRow([excelDate(date), HE_DAYS[wd(date)], start ? excelTime(start) : null, end ? excelTime(end) : null, brk ? excelTime(brk) : null, total, note || null]);
    row.getCell(1).numFmt = 'dd/mm/yyyy';
    for (const c of [3, 4]) row.getCell(c).numFmt = 'hh:mm';
    row.getCell(5).numFmt = 'h:mm';
    row.getCell(6).numFmt = '[h]:mm';
  }
  const last = ws.rowCount;
  const sum = ws.addRow(['סה"כ', null, null, null, null, { formula: `SUM(F${first}:F${last})`, result: 0 }, null]);
  sum.getCell(6).numFmt = '[h]:mm';
  ws.getColumn(1).width = 12;
  await wb.xlsx.writeFile(`${OUT}${d.file}`);
}

// ------------------------------------------------------------------- en-two-employees.xlsx
async function enTwo() {
  const d = DATA.enTwoEmployees;
  const wb = new ExcelJS.Workbook();
  const info = wb.addWorksheet('Info');
  info.addRow(['Attendance export']);
  info.addRow(['Company', 'Example Ltd.']);
  info.addRow(['Period', '09/2026']);
  const ws = wb.addWorksheet('Attendance');
  ws.addRow(['Employee Name', 'Clock Out', 'Date', 'Clock In', 'Break (min)']);
  d.rows.forEach(([name, date, start, end, brk], i) => {
    // Mix of text times and native Excel time cells, dates as DD/MM/YYYY text.
    const native = i % 2 === 1;
    const outCell = end && native && !/[AP]M/i.test(end) ? excelTime(end) : end || null;
    const inCell = start && native ? excelTime(start) : start || null;
    const row = ws.addRow([name, outCell, dmy(date), inCell, brk === '' ? null : brk]);
    if (native) {
      row.getCell(2).numFmt = 'hh:mm';
      row.getCell(4).numFmt = 'hh:mm';
    }
  });
  await wb.xlsx.writeFile(`${OUT}${d.file}`);
}

// ------------------------------------------------------------------- PDFs
const css = `
  @page { size: A4; margin: 14mm 12mm; }
  body { font-family: 'DejaVu Sans', Arial, sans-serif; direction: rtl; font-size: 11px; color: #111; }
  h1 { font-size: 16px; margin: 0 0 4px; } .meta { margin-bottom: 10px; }
  table { border-collapse: collapse; width: 100%; } th, td { border: 1px solid #555; padding: 4px 6px; text-align: center; }
  th { background: #e8e8e8; } .page { page-break-after: always; } .page:last-child { page-break-after: auto; }`;

function textReportHtml() {
  const d = DATA.textPdf;
  const pages = d.pages.map((p) => {
    let total = 0;
    const rows = p.rows
      .map(([date, start, end, brk, note]) => {
        let t = '';
        if (start && end) {
          let m = minutes(end) - minutes(start) - (brk ? minutes(brk) : 0);
          total += m;
          t = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
        }
        return `<tr><td>${dmy(date)}</td><td>${HE_LETTERS[wd(date)]}</td><td>${start}</td><td>${end}</td><td>${brk}</td><td>${t}</td><td>${note}</td></tr>`;
      })
      .join('');
    const tot = `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
    return `<div class="page"><h1>${p.employee} (${p.number}) - דו"ח נוכחות מפורט</h1>
      <div class="meta">תאריך 01/09/2026-30/09/2026</div>
      <table><thead><tr><th>תאריך</th><th>יום</th><th>כניסה</th><th>יציאה</th><th>הפסקה</th><th>סה"כ</th><th>הערות</th></tr></thead>
      <tbody>${rows}<tr><td>סה"כ</td><td></td><td></td><td></td><td></td><td>${tot}</td><td></td></tr></tbody></table></div>`;
  });
  return `<html><head><meta charset="utf-8"><style>${css}</style></head><body>${pages.join('')}</body></html>`;
}

function scannedReportHtml() {
  const d = DATA.scannedPdf;
  const rows = d.rows
    .map(([date, start, end]) => {
      const m = minutes(end) - minutes(start);
      return `<tr><td>${dmy(date)}</td><td>${HE_DAYS[wd(date)]}</td><td>${start}</td><td>${end}</td><td>${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}</td></tr>`;
    })
    .join('');
  return `<html><head><meta charset="utf-8"><style>${css} body{font-size:15px;width:794px;margin:40px 50px} td,th{padding:7px 8px}</style></head><body>
    <h1>דוח נוכחות - ${d.employee} (${d.number})</h1><div class="meta">תקופה: 01/09/2026-30/09/2026</div>
    <table><thead><tr><th>תאריך</th><th>יום</th><th>שעת כניסה</th><th>שעת יציאה</th><th>סה"כ שעות</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
}

async function pdfs() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent(textReportHtml(), { waitUntil: 'load' });
  await page.pdf({ path: `${OUT}${DATA.textPdf.file}`, format: 'A4', printBackground: true });

  // "Scan": render at ~200 DPI, then degrade (grey paper, noise, slight skew, JPEG) and wrap as an image-only PDF.
  const scan = await browser.newPage({ viewport: { width: 900, height: 1273 }, deviceScaleFactor: 2 });
  await scan.setContent(scannedReportHtml(), { waitUntil: 'load' });
  const png = await scan.screenshot({ type: 'png', fullPage: false });
  const degrade = await browser.newPage();
  const jpeg = await degrade.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext('2d');
    g.fillStyle = '#f2f0ea';
    g.fillRect(0, 0, c.width, c.height);
    g.translate(c.width / 2, c.height / 2);
    g.rotate((0.35 * Math.PI) / 180);
    g.translate(-c.width / 2, -c.height / 2);
    g.globalAlpha = 0.92;
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height);
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < d.data.length; i += 4) {
      const grey = 0.3 * d.data[i] + 0.59 * d.data[i + 1] + 0.11 * d.data[i + 2] + (rnd() - 0.5) * 38;
      d.data[i] = d.data[i + 1] = d.data[i + 2] = Math.max(0, Math.min(255, grey));
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.putImageData(d, 0, 0);
    return c.toDataURL('image/jpeg', 0.6).split(',')[1];
  }, png.toString('base64'));
  const wrap = await browser.newPage();
  await wrap.setContent(`<html><head><style>@page{size:A4;margin:0}body{margin:0}img{width:210mm;height:297mm;display:block}</style></head><body><img src="data:image/jpeg;base64,${jpeg}"></body></html>`, { waitUntil: 'load' });
  await wrap.pdf({ path: `${OUT}${DATA.scannedPdf.file}`, format: 'A4', printBackground: true });
  await browser.close();
}

await heStandard();
await enTwo();
await pdfs();
writeFileSync(`${OUT}README.md`, '# Import test fixtures\n\nSynthetic data only (no real people). Generated from `scripts/import-fixtures/data.json` by\n`node scripts/import-fixtures/make.mjs` and `python3 scripts/import-fixtures/make_py.py` (requires xlwt).\n');
console.log('ok');
