import { db } from "../firebase-config.js";
import { collection, onSnapshot, getDocs } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

/**
 * Product categories, shared by the storefront, product page and admin.
 * Admin edits them in Firestore `categories/{id}`; until one exists these defaults are used.
 *   kind    'account' (game ID, one item per stock row) | 'service' (priced per unit, has a minimum)
 *   minQty  default minimum order for a service category; a product's own serviceMin overrides it
 */
export const DEFAULT_CATEGORIES = [
  { id: 'ammo_acc', name: 'ไอดีไก่กระสุน', kind: 'account', order: 10 },
  { id: 'koen', name: 'ไอดีเงิน Koen', kind: 'account', order: 20 },
  { id: 'full_acc', name: 'ไอดีพร้อมเล่น', kind: 'account', order: 30 },
  { id: 'skins', name: 'สกินปืน / เซ็ตชุด', kind: 'account', order: 40 },
  { id: 'service_ammo', name: 'บริการโยนกระสุน M61', kind: 'service', unit: 'กอง', minQty: 15, order: 110 },
  { id: 'service_koen', name: 'บริการโยนเงิน M', kind: 'service', unit: 'M', minQty: 5, order: 120 },
  { id: 'service_farm', name: 'รับฟาร์ม / ดึงของ', kind: 'service', unit: 'รอบ', minQty: 1, order: 130 },
  { id: 'service', name: 'บริการอื่น ๆ', kind: 'service', unit: 'ครั้ง', minQty: 1, order: 190 }
];

export const KIND_LABEL = { account: 'ไอดีเกม', service: 'บริการในเกม' };

const sortCats = (list) => [...list].sort((a, b) => (a.order || 0) - (b.order || 0) || String(a.name).localeCompare(String(b.name), 'th'));

/** Calls cb(categories, fromDb) now and on every change. Empty or unreadable collection -> defaults (fromDb false). */
export function watchCategories(cb) {
  cb(sortCats(DEFAULT_CATEGORIES), false);
  return onSnapshot(collection(db, 'categories'), (snap) => {
    const list = snap.docs.map(d => ({ id: d.id, kind: 'account', ...d.data() }));
    cb(sortCats(list.length ? list : DEFAULT_CATEGORIES), list.length > 0);
  }, (e) => console.warn('Categories fallback to defaults:', e));
}

/** One-shot version for pages that render once (product page). */
export async function loadCategories() {
  try {
    const snap = await getDocs(collection(db, 'categories'));
    const list = snap.docs.map(d => ({ id: d.id, kind: 'account', ...d.data() }));
    return sortCats(list.length ? list : DEFAULT_CATEGORIES);
  } catch (e) {
    console.warn('Categories fallback to defaults:', e);
    return sortCats(DEFAULT_CATEGORIES);
  }
}

export const categoryOf = (cats, id) => (cats || []).find(c => c.id === id);

export function isServiceProduct(p, cats) {
  return p?.productType === 'service' || categoryOf(cats, p?.category)?.kind === 'service' || String(p?.category || '').startsWith('service');
}

// Product setting wins, then the category default, then 1.
export function minQtyOf(p, cats) {
  if (!isServiceProduct(p, cats)) return 1;
  return Math.max(1, Math.floor(Number(p.serviceMin) || Number(categoryOf(cats, p.category)?.minQty) || 1));
}

export function unitOf(p, cats) {
  return p?.serviceUnit || categoryOf(cats, p?.category)?.unit || (isServiceProduct(p, cats) ? 'กอง' : 'ชิ้น');
}

const escCat = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Card grid HTML: one card per category (image + name + product count). Cards call window.filterCategory(id). */
export function categoryCardsHtml(cats, products) {
  return cats.map(c => {
    const n = products.filter(p => p.category === c.id).length;
    const img = c.image
      ? `<img src="${escCat(c.image)}" alt="" loading="lazy" class="w-full h-full object-cover">`
      : `<span class="text-5xl font-heading font-semibold text-steel">${escCat([...String(c.name)][0] || '?')}</span>`;
    return `<button type="button" data-cat="${escCat(c.id)}" onclick="filterCategory(${escCat(JSON.stringify(c.id))})" class="text-left apple-card p-3 hover:bg-mist transition active:scale-[0.98]">
      <span class="flex items-center justify-center overflow-hidden rounded-2xl bg-mist aspect-[16/7]">${img}</span>
      <span class="block px-2 pt-3 pb-1.5"><span class="block text-lg font-heading font-semibold">${escCat(c.name)}</span>
      <span class="block text-sm text-slate mt-0.5">${n} รายการ <span class="text-appleBlue">›</span></span></span></button>`;
  }).join('');
}
