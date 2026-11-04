const esc = (v) => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// columns: [{ key, header }]; BOM ditambahkan agar terbaca benar di Excel
export function toCsv(columns, rows) {
  const head = columns.map((c) => esc(c.header)).join(',');
  const body = rows.map((r) => columns.map((c) => esc(r[c.key])).join(','));
  return '\uFEFF' + [head, ...body].join('\r\n') + '\r\n';
}
