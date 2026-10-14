"""Generates the legacy-Excel (.xls, BIFF8) and Windows-1255 CSV import fixtures.

Dev-only. Requires `xlwt` (pip install xlwt) — never shipped with the application.
Usage: python3 scripts/import-fixtures/make_py.py
"""
import datetime
import json
import os

import xlwt

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', '..', 'src', 'import', '__tests__', 'fixtures')
DATA = json.load(open(os.path.join(HERE, 'data.json'), encoding='utf-8'))


def legacy_xls():
    d = DATA['legacyXls']
    wb = xlwt.Workbook(encoding='utf-8')
    ws = wb.add_sheet('נוכחות')
    ws.cols_right_to_left = True
    date_fmt = xlwt.easyxf(num_format_str='DD/MM/YYYY')
    time_fmt = xlwt.easyxf(num_format_str='HH:MM')
    ws.write(0, 0, 'דוח שעות')
    ws.write(1, 0, 'שם העובד: ' + d['employee'])
    for c, h in enumerate(['תאריך עבודה', 'התחלה', 'סיום', 'הפסקה (דקות)']):
        ws.write(3, c, h)
    for i, (date, start, end, brk) in enumerate(d['rows']):
        r = 4 + i
        y, m, dd = map(int, date.split('-'))
        ws.write(r, 0, datetime.datetime(y, m, dd), date_fmt)
        hh, mm = map(int, start.split(':'))
        ws.write(r, 1, datetime.time(hh, mm), time_fmt)
        if end == 'FORMULA':
            # A formula without a stored result: the importer must report it, never evaluate it.
            ws.write(r, 2, xlwt.Formula('B%d+TIME(8,0,0)' % (r + 1)), time_fmt)
        else:
            hh, mm = map(int, end.split(':'))
            ws.write(r, 2, datetime.time(hh, mm), time_fmt)
        ws.write(r, 3, brk)
    wb.save(os.path.join(OUT, d['file']))


def cp1255_csv():
    d = DATA['multiPunch']
    lines = ['דוח נוכחות - ' + d['employee'], '', 'תאריך;יום;כניסה 1;יציאה 1;כניסה 2;יציאה 2;הערות']
    for row in d['rows']:
        lines.append(';'.join(row))
    lines.append('סה"כ;;;;;;')
    with open(os.path.join(OUT, d['file']), 'wb') as f:
        f.write('\r\n'.join(lines).encode('cp1255'))


if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    legacy_xls()
    cp1255_csv()
    print('ok')
