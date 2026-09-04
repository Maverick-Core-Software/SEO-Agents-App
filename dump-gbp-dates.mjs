import xlsx from 'xlsx';
import { excelDateToIso } from './scripts/lib/gbp-runner.mjs';
const p = 'C:/Workspace/Shared/Operations/Grizzly/GBP/Grizzly GBP Schedule.xlsx';
const wb = xlsx.readFile(p, { cellDates: true });
const name = wb.SheetNames.includes('Posts') ? 'Posts' : wb.SheetNames[0];
const rows = xlsx.utils.sheet_to_json(wb.Sheets[name], { defval: '' });
const recent = [];
for (const r of rows) {
  const d = excelDateToIso(r.Date || r.date);
  if (d >= '2026-08-20' && d <= '2026-09-10') {
    recent.push({
      Date: d,
      Status: String(r.Status || ''),
      Posted: r.Posted,
      Topic: String(r.Topic || r.Title || '').slice(0, 80),
    });
  }
}
console.log('sheet=' + name + ' nrows=' + rows.length + ' recent=' + recent.length);
console.log(JSON.stringify(recent, null, 2));
