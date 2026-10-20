// Last product list seen, kept in localStorage so the next page can paint at once while Firestore answers.
// Always replaced by the live data a moment later; Timestamps are stored as milliseconds and given back with toMillis().
const K = 'astraphex_products_v1';
export function readProducts() {
  try { return JSON.parse(localStorage.getItem(K) || 'null', (k, v) => (v && typeof v === 'object' && '__ms' in v ? { toMillis: () => v.__ms } : v)); } catch (_) { return null; }
}
export function writeProducts(list) {
  try { localStorage.setItem(K, JSON.stringify(list, (k, v) => (v && typeof v.toMillis === 'function' ? { __ms: v.toMillis() } : v))); } catch (_) {}
}
