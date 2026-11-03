// Generates SYNTHETIC photographed-receipt fixtures for the image import tests (1.1.8):
//   receipt-straight.png, receipt-rotated.jpg (tilted + perspective + shadow), receipt-smudged.png (one unreadable time).
// The layout imitates a thermal "דוח שעות עובדים מרוכז" receipt; every name, number and time is invented.
// Usage: node scripts/import-fixtures/make-images.mjs
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('../../src/import/__tests__/fixtures/', import.meta.url));
mkdirSync(OUT, { recursive: true });

export const RECEIPT = {
  employee: '55821 מיכאל',
  // date, weekday letter, entrance, exit (exit may be after midnight)
  rows: [
    ['01/11/26', 'א', '07:05', '15:20'],
    ['02/11/26', 'ב', '06:58', '14:31'],
    ['03/11/26', 'ג', '18:10', '23:42'],
    ['04/11/26', 'ד', '15:02', '23:15'],
    ['05/11/26', 'ה', '18:05', '00:20'],
    ['06/11/26', 'ו', '07:00', '12:45'],
    ['08/11/26', 'א', '07:12', '16:40'],
    ['09/11/26', 'ב', '14:48', '22:06'],
    ['10/11/26', 'ג', '07:03', '15:18'],
    ['11/11/26', 'ד', '16:30', '23:59'],
  ],
};

const span = (a, b) => {
  const m = (x) => Number(x.slice(0, 2)) * 60 + Number(x.slice(3, 5));
  return (m(b) - m(a) + 1440) % 1440;
};
const dec = (min) => (min / 60).toFixed(2);

function html({ smudge }) {
  const rows = RECEIPT.rows
    .map(([d, w, a, b], i) => {
      const hours = dec(span(a, b));
      // RTL thermal layout: the range is printed "exit - entrance" visually (reading right-to-left).
      const range = smudge && i === 3 ? `<span style="filter:blur(3.2px)">${b}</span> - ${a}` : `${b} - ${a}`;
      return `<tr><td>${d}</td><td>${w}</td><td class="r">${range}</td><td>${hours}</td><td>0:00</td></tr>`;
    })
    .join('');
  const total = RECEIPT.rows.reduce((s, [, , a, b]) => s + Math.round(span(a, b)), 0);
  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><style>
    body{margin:0;background:#3a3a3a;display:flex;justify-content:center;padding:30px 0}
    .p{width:520px;background:#f7f7f2;padding:28px 26px;font-family:'DejaVu Sans',Arial,sans-serif;color:#222}
    h1,h2{font-weight:normal;text-align:center;margin:4px 0;font-size:20px}
    table{width:100%;border-collapse:collapse;font-size:21px;margin-top:6px}
    th{font-weight:normal;border-bottom:2px solid #333;padding:4px 2px;text-align:right}
    td{padding:5px 2px;text-align:right}
    td.r{text-align:center;direction:ltr}
    .t{border-top:2px solid #333;text-align:center;font-size:20px;padding-top:6px}
  </style></head><body><div class="p">
    <h1>מאפיית הדוגמה בע"מ</h1><h2>רחוב הדוגמה 1, עיר</h2><h2>ח.פ: 512345678</h2>
    <h2 style="margin-top:14px">דוח שעות עובדים מרוכז</h2>
    <h2 style="margin-top:10px">${RECEIPT.employee}</h2>
    <table><thead><tr><th>תאריך</th><th>יום</th><th>טווח שעות</th><th>שעות</th><th>הפסקה</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="t">סה"כ שעות לעובד: ${dec(total)}</div>
  </div></body></html>`;
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 640, height: 1000 }, deviceScaleFactor: 1.5 });

await page.setContent(html({ smudge: false }));
writeFileSync(`${OUT}receipt-straight.png`, await page.locator('.p').screenshot());

await page.setContent(html({ smudge: true }));
writeFileSync(`${OUT}receipt-smudged.png`, await page.locator('.p').screenshot());

// Photographed: tilted, slight perspective, uneven light (shadow gradient), on a dark table, saved as JPEG.
await page.setContent(html({ smudge: false }));
await page.addStyleTag({
  content: `.p{transform:perspective(1400px) rotateX(6deg) rotate(-3.5deg);position:relative}
  .p::after{content:'';position:absolute;inset:0;background:linear-gradient(115deg,rgba(0,0,0,.28),rgba(0,0,0,0) 55%,rgba(0,0,0,.12));pointer-events:none}
  body{padding:60px 40px}`,
});
writeFileSync(`${OUT}receipt-rotated.jpg`, await page.screenshot({ type: 'jpeg', quality: 82, fullPage: true }));

await browser.close();
writeFileSync(`${OUT}receipt.json`, JSON.stringify(RECEIPT, null, 1));
console.log('wrote receipt-straight.png, receipt-smudged.png, receipt-rotated.jpg');
