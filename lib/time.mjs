// Dates as YYYY-MM-DD strings in the app's time zone.
export const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);

export function localDate(ms, timeZone = 'UTC') {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms));
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5);

export const shortDate = (d) => (isDate(d) ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : '');

export function relative(ms, nowMs, timeZone = 'UTC') {
  const min = Math.round((nowMs - ms) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const today = localDate(nowMs, timeZone);
  const day = localDate(ms, timeZone);
  const time = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
  if (day === today) return `today ${time}`;
  const d = daysBetween(day, today);
  if (d === 1) return `yesterday ${time}`;
  return d < 7 ? `${d} days ago` : shortDate(day);
}

// DATE columns come back as 'YYYY-MM-DD' strings (see the type parsers in lib/db.mjs and dev/pglite.mjs).
export const dateOnly = (v) => (v ? String(v).slice(0, 10) : '');
