// Generates src/import/__tests__/fixtures/bulk-workbook.xlsx — a SYNTHETIC multi-employee workbook with the same
// layout as real clock-system exports (one employee per sheet, 16- and 20-column variants, native Excel datetimes,
// two punch pairs per day, empty dates, repeated header + summary rows at the bottom, labels above the table).
// All names, numbers and times are invented. Usage: node scripts/import-fixtures/make-workbook.mjs
import ExcelJS from 'exceljs';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('../../src/import/__tests__/fixtures/', import.meta.url));
mkdirSync(OUT, { recursive: true });

const LETTERS = ["א'", "ב'", "ג'", "ד'", "ה'", "ו'", "ש'"];
// Wall-clock values written as UTC so the stored serial is exactly the local date/time (no timezone shift).
const day = (d) => new Date(Date.UTC(2026, 9, d));
const at = (d, hm) => {
  const [h, m] = hm.split(':').map(Number);
  return new Date(Date.UTC(2026, 9, d, h, m));
};
const span = (a, b) => {
  const m = (x) => Number(x.slice(0, 2)) * 60 + Number(x.slice(3, 5));
  return ((m(b) - m(a) + 1440) % 1440) / 60;
};

/** shifts: { d, pairs: [[in, out, outDay?]], remark? } */
const EMPLOYEES = [
  { title: 'דנה לוי אוקטובר 2026', name: 'דנה לוי', id: '101', wide: false, shifts: [
    { d: 2, pairs: [['08:07', '14:55']] },
    { d: 4, pairs: [['15:57', '20:01']], remark: 'מוזיקה' },
    { d: 21, pairs: [['16:41', '20:27']] },
    { d: 27, pairs: [['16:07', '19:53']] },
  ] },
  { title: 'יוסי כהן אוקטובר 2026', name: 'יוסי כהן', id: '102', wide: true, shifts: [
    { d: 2, pairs: [['08:06', '17:05']] },
    { d: 4, pairs: [['08:48', '10:00'], ['15:00', '20:00']] },
    { d: 16, pairs: [['11:59', '18:27']] },
    { d: 18, pairs: [['08:00', '10:00'], ['15:00', '20:00']] },
  ] },
  { title: 'מיכל אברהם אוקטובר 2026', name: 'מיכל אברהם', id: '103', wide: false, shifts: [
    { d: 5, pairs: [['22:00', '06:00', 6]] },
    { d: 7, pairs: [['07:00', '15:30']] },
  ] },
  { title: 'רון שמש אוקטובר 2026', name: 'רון שמש', id: '104', wide: false, shifts: [{ d: 11, pairs: [['09:00', '17:00']] }] },
  { title: 'רון שמש 2 אוקטובר 2026', name: 'רון שמש', id: '104', wide: false, shifts: [{ d: 12, pairs: [['09:00', '13:00']] }] },
  { title: 'נועה ברק אוקטובר 2026', name: 'נועה ברק', id: '105', wide: false, declaredShifts: 3, shifts: [
    { d: 8, pairs: [['07:30', '12:00']], remark: '13:00-16:00 מטבח' },
    { d: 9, pairs: [['07:30', null]] },
  ] },
];

function sheetFor(wb, e) {
  const ws = wb.addWorksheet(e.title, { views: [{ rightToLeft: true }] });
  const pairCols = e.wide ? 2 : 1;
  const head = ['יום', 'תאריך'];
  for (let i = 0; i < pairCols; i++) head.push('תפקיד', 'כניסה', 'יציאה', 'הערות');
  head.push('רגילות', '125%', '150%', 'שבת/חג', '175%', '200%', 'מיוחד 200%', 'סיכום', 'עלות', 'עלות נסיעות');
  const totalCol = head.indexOf('סיכום') + 1;
  ws.addRow([]);
  ws.getCell('A2').value = 'דוח מפורט';
  ws.getCell(2, head.length - 2).value = 'תאריך הוצאה: 02/11/2026 15:34';
  const days = new Set(e.shifts.map((s) => s.d)).size;
  const count = e.declaredShifts ?? e.shifts.reduce((a, s) => a + s.pairs.length, 0);
  ws.getCell('A3').value = `שם עובד: ${e.name}\nחודש: אוקטובר 2026`;
  ws.mergeCells('A3:C3');
  ws.getCell('D3').value = `ימי עבודה: ${days}\nמשמרות: ${count}`;
  ws.mergeCells('D3:F3');
  ws.getCell('G3').value = `מזהה שעון: ${e.id}`;
  ws.mergeCells(3, 7, 3, head.length);
  ws.addRow([]);
  ws.getRow(5).values = head;
  let sum = 0;
  for (let d = 1; d <= 31; d++) {
    const r = ws.getRow(5 + d);
    const dow = new Date(Date.UTC(2026, 9, d)).getUTCDay();
    r.getCell(1).value = LETTERS[dow];
    r.getCell(2).value = day(d);
    r.getCell(2).numFmt = 'mm-dd-yy';
    const s = e.shifts.find((x) => x.d === d);
    if (!s) continue;
    let hours = 0;
    s.pairs.forEach(([a, b, outDay], i) => {
      const c = 3 + i * 4;
      r.getCell(c).value = 'דלפק';
      r.getCell(c + 1).value = at(d, a);
      r.getCell(c + 1).numFmt = 'm/d/yy h:mm';
      if (b) {
        r.getCell(c + 2).value = at(outDay ?? d, b);
        r.getCell(c + 2).numFmt = 'm/d/yy h:mm';
        hours += span(a, b);
      }
      if (i === 0 && s.remark) r.getCell(c + 3).value = s.remark;
    });
    if (hours) {
      r.getCell(totalCol - 7).value = hours; // "regular" column (source-system classification, reference only)
      r.getCell(totalCol).value = hours;
      r.getCell(totalCol + 1).value = Math.round(hours * 40);
      sum += hours;
    }
  }
  ws.addRow(head);
  const s1 = ws.addRow(['סיכום דלפק']);
  s1.getCell(totalCol).value = sum;
  const s2 = ws.addRow(['סיכום כללי']);
  s2.getCell(totalCol).value = sum;
}

const wb = new ExcelJS.Workbook();
for (const e of EMPLOYEES) sheetFor(wb, e);
const notes = wb.addWorksheet('הוראות');
notes.addRow(['גיליון זה אינו דוח נוכחות']);
await wb.xlsx.writeFile(`${OUT}bulk-workbook.xlsx`);
console.log('wrote bulk-workbook.xlsx');
