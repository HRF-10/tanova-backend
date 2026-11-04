export const now = () => Date.now();

export function toMs(v, fallback = null) {
  if (v === null || v === undefined || v === '') return fallback;
  if (typeof v === 'number') return v;
  if (/^\d+$/.test(String(v))) return Number(v);
  const t = Date.parse(v);
  return Number.isNaN(t) ? fallback : t;
}

export const iso = (ms) => (ms === null || ms === undefined ? null : new Date(Number(ms)).toISOString());

export function parseInterval(s) {
  const m = /^(\d+)(s|m|h|d)$/.exec(s || '');
  if (!m) return null;
  return Number(m[1]) * { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[2]];
}

export const toWib = (ms) =>
  new Date(Number(ms)).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', hour12: false });
