/**
 * Price per กอง for qty กอง: list price minus the single best discount that applies (no stacking).
 * Same rule as ammoRateOf() in worker/slip-worker.js (the Worker's number is the one charged). Used by the product page, home page and admin preview.
 *   flat: ammoDiscType 'fixed' (฿ off per กอง) | 'percent', ammoDiscValue, window ammoDiscFrom..ammoDiscTo (ms, optional)
 *   tiers: ammoTiers [{ min, type, value }] from min กอง up, window ammoTiersFrom..ammoTiersTo
 */
const n = (x) => { const v = Number(x); return Number.isFinite(v) ? v : 0; };
export const ammoListRate = (p) => n(p.ammoRate) || n(p.price);
export function ammoRateOf(p, qty = 0, now = Date.now()) {
  const rate = ammoListRate(p), cut = (type, v) => type === 'percent' ? rate * (1 - Math.min(v, 99) / 100) : rate - v;
  const c = [], live = (from, to) => (!n(from) || now >= from) && (!n(to) || now <= to);
  if (live(p.ammoDiscFrom, p.ammoDiscTo) && n(p.ammoDiscValue) > 0) c.push(cut(p.ammoDiscType, n(p.ammoDiscValue)));
  if (live(p.ammoTiersFrom, p.ammoTiersTo)) for (const t of Array.isArray(p.ammoTiers) ? p.ammoTiers : []) if (qty >= n(t.min) && n(t.value) > 0) c.push(cut(t.type, n(t.value)));
  return Math.min(rate, ...c.filter(x => x > 0));
}
