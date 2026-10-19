import { db } from "../firebase-config.js";
import { collection, onSnapshot, getDocs } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

/**
 * Product categories (Firestore `categories/{id}`), shared by the storefront, product page and admin.
 *   kind    'account' (game ID, one item per stock row) | 'service' (priced per unit, has a minimum)
 *   minQty  default minimum order for a service category; a product's own serviceMin overrides it
 * There are no built-in defaults: an empty collection means no categories, and products still show
 * (a product whose category is missing or deleted counts as "ไม่มีหมวดหมู่", id NONE).
 */
export const NONE = '_none';
export const NONE_LABEL = 'สินค้าอื่น ๆ';
export const KIND_LABEL = { account: 'ไอดีเกม', service: 'บริการในเกม' };

const sortCats = (list) => [...list].sort((a, b) => (a.order || 0) - (b.order || 0) || String(a.name).localeCompare(String(b.name), 'th'));
const fromSnap = (snap) => sortCats(snap.docs.map(d => ({ id: d.id, kind: 'account', ...d.data() })));

/** Calls cb(categories) now (empty) and on every change. */
export function watchCategories(cb) {
  cb([]);
  return onSnapshot(collection(db, 'categories'), (snap) => cb(fromSnap(snap)), (e) => { console.warn('Categories:', e); cb([]); });
}

/** One-shot version for pages that render once (product page). */
export async function loadCategories() {
  try { return fromSnap(await getDocs(collection(db, 'categories'))); }
  catch (e) { console.warn('Categories:', e); return []; }
}

export const categoryOf = (cats, id) => (cats || []).find(c => c.id === id);
/** The product's category id, or NONE when it has none / it was deleted. */
export const catIdOf = (p, cats) => (p?.category && categoryOf(cats, p.category) ? p.category : NONE);

export function isServiceProduct(p, cats) {
  return p?.productType === 'service' || categoryOf(cats, p?.category)?.kind === 'service' || String(p?.category || '').startsWith('service');
}

// Product setting wins, then the category default, then 1.
export function minQtyOf(p, cats) {
  if (!isServiceProduct(p, cats)) return 1;
  return Math.max(1, Math.floor(Number(p.serviceMin) || Number(categoryOf(cats, p.category)?.minQty) || 1));
}

export function unitOf(p, cats) {
  return p?.serviceUnit || categoryOf(cats, p?.category)?.unit || (isServiceProduct(p, cats) ? 'กอง' : 'ไอดี');
}

const escCat = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Card grid HTML: one card per category with products, plus "สินค้าอื่น ๆ" for products without one. Cards call window.filterCategory(id). */
export function categoryCardsHtml(cats, products) {
  const cards = cats.map(c => ({ ...c, n: products.filter(p => p.category === c.id).length }));
  const none = products.filter(p => catIdOf(p, cats) === NONE).length;
  if (none) cards.push({ id: NONE, name: NONE_LABEL, n: none });
  return cards.map(c => {
    const img = c.image
      ? `<img src="${escCat(c.image)}" alt="" loading="lazy" class="w-full h-full object-cover">`
      : `<span class="text-5xl font-heading font-semibold text-steel">${escCat([...String(c.name)][0] || '?')}</span>`;
    return `<button type="button" data-cat="${escCat(c.id)}" onclick="filterCategory(${escCat(JSON.stringify(c.id))})" class="text-left apple-card p-3 hover:bg-mist transition active:scale-[0.98]">
      <span class="flex items-center justify-center overflow-hidden rounded-2xl bg-mist aspect-[16/7]">${img}</span>
      <span class="block px-2 pt-3 pb-1.5"><span class="block text-lg font-heading font-semibold">${escCat(c.name)}</span>
      <span class="block text-sm text-slate mt-0.5">${c.n} รายการ <span class="text-appleBlue">›</span></span></span></button>`;
  }).join('');
}
