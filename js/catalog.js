import { db } from "../firebase-config.js";
import { readProducts, writeProducts } from "./products-cache.js";
import { collection, onSnapshot } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { ROOT, esc, icon, ICONS, onSettings, workerBase } from "./ui.js";
import { productCardHtml, productSkeletonHtml, levelOf, hiddenFromShop } from "./card.js";
import { watchCategories, categoryCardsHtml, catVisible, categoryOf, catIdOf, isServiceProduct, minQtyOf, unitOf, KIND_LABEL, NONE } from "./categories.js";

/**
 * Catalog shared by the home page and the category page: one compact filter bar (search + a single
 * "ตัวกรอง" dropdown with category / budget / sort), category cards while browsing, product grid,
 * skeleton while loading and empty states. Products without a category show standalone, under the category cards.
 */
export const FALLBACK_IMG = 'https://placehold.co/800x600/f5f5f7/86868b?text=Nugget+Hub';

const S = { cats: [], products: [], real: [], boxes: [], realCats: [], loaded: false, failed: false, cat: 'all', q: '', budget: 'all', sort: 'default', tag: '', lvl: 0, settings: {} };
let opts = { urlSync: false, onProducts: null };

export const priceOf = (p) => { const v = Number(p?.price); if (v > 0) return v; const r = Number(p?.serviceRate); return r > 0 ? r : 0; };
export const stockOf = (p) => { if (p?.isBox) return 0; const s = Number(p?.stock); return s > 0 ? Math.floor(s) : 0; };

function koenText(p) {
  const v = String(p?.koen ?? '').trim();
  if (!v || v === '-') return '';
  const label = String(p.koenLabel || (isServiceProduct(p, S.cats) ? '' : (S.settings.koenLabel || 'Koen'))).trim();
  return !label || v.includes(':') || v.toLowerCase().startsWith(label.toLowerCase()) ? v : `${label}: ${v}`;
}

export function cardFor(p) {
  const isService = isServiceProduct(p, S.cats);
  return productCardHtml({
    p, isService, unit: unitOf(p, S.cats), min: minQtyOf(p, S.cats), price: priceOf(p), stock: stockOf(p), koen: koenText(p),
    categoryName: categoryOf(S.cats, p.category)?.name, fallback: FALLBACK_IMG, instant: !!workerBase()
  });
}

function filterBarHtml() {
  return `
    <div class="flex items-stretch gap-2 w-full">
      <label class="relative flex-1 min-w-0">
        <span class="sr-only">ค้นหาสินค้า</span>
        ${icon(ICONS.search, 'w-4 h-4 text-steel absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none', 2)}
        <input id="cat-search" type="search" placeholder="ค้นหาไอดี ปืน บริการ…" autocomplete="off" class="apple-input w-full pl-10 pr-3 py-2.5 text-[15px]">
      </label>
      <div class="relative">
        <button id="filter-toggle" type="button" aria-expanded="false" aria-controls="filter-panel" class="h-full apple-explore-pill px-4 text-[15px] bg-gallery whitespace-nowrap">
          ${icon(ICONS.filter, 'w-4 h-4', 2)}<span class="hidden sm:inline">ตัวกรอง</span><span id="filter-count" class="hidden min-w-[20px] h-5 px-1.5 rounded-full bg-pricingBlue text-gallery text-[11px] font-semibold items-center justify-center"></span>
        </button>
        <div id="filter-panel" class="hidden absolute right-0 top-full mt-2 z-30 w-[min(320px,calc(100vw-32px))] bg-gallery border border-hairline rounded-[28px] p-5 space-y-5 max-sm:fixed max-sm:inset-x-3 max-sm:top-auto max-sm:bottom-[92px] max-sm:mt-0 max-sm:w-auto max-sm:max-h-[64vh] max-sm:overflow-y-auto max-sm:z-50">
          <div><p class="text-[13px] font-semibold text-ink mb-2.5">หมวดหมู่</p><div data-chips="f-cat" class="flex flex-wrap gap-2"></div><select id="f-cat" class="hidden" aria-hidden="true" tabindex="-1"></select></div>
          <div><p class="text-[13px] font-semibold text-ink mb-2.5">สถานะ / งบประมาณ</p><div data-chips="f-budget" class="flex flex-wrap gap-2"></div>
            <select id="f-budget" class="hidden" aria-hidden="true" tabindex="-1">
              <option value="all">ทั้งหมด</option><option value="instock">เฉพาะพร้อมส่ง</option>
              <option value="under200">พร้อมส่ง · ไม่เกิน ฿200</option><option value="200to500">พร้อมส่ง · ฿200 – ฿500</option><option value="over500">พร้อมส่ง · ฿500 ขึ้นไป</option>
            </select></div>
          <div><p class="text-[13px] font-semibold text-ink mb-2.5">เรียงตาม</p><div data-chips="f-sort" class="flex flex-wrap gap-2"></div>
            <select id="f-sort" class="hidden" aria-hidden="true" tabindex="-1">
              <option value="default">แนะนำ</option><option value="price-asc">ราคา: น้อยไปมาก</option><option value="price-desc">ราคา: มากไปน้อย</option><option value="stock-desc">สต็อกมากที่สุด</option><option value="newest">มาใหม่</option>
            </select></div>
          <div class="flex gap-2 pt-1">
            <button type="button" onclick="clearSearchAndFilters()" class="flex-1 apple-explore-pill py-2.5 text-[15px]">ล้างทั้งหมด</button>
            <button type="button" onclick="closeFilterPanel()" class="flex-1 apple-pricing-pill py-2.5 text-[15px]">ดูผลลัพธ์</button>
          </div>
        </div>
      </div>
    </div>
    <div id="filter-chips" class="flex flex-wrap gap-2 empty:hidden mt-3"></div>`;
}

function fillCategorySelect() {
  const sel = document.getElementById('f-cat');
  if (!sel) return;
  const count = (id) => S.products.filter(p => (id === NONE ? catIdOf(p, S.cats) === NONE : p.category === id)).length;
  const groups = ['account', 'service'].map(kind => {
    const items = S.cats.filter(c => c.kind === kind && (catVisible(c) || c.id === S.cat));
    return items.length ? `<optgroup label="${esc(KIND_LABEL[kind])}">${items.map(c => `<option value="${esc(c.id)}">${esc(c.name)} (${count(c.id)})</option>`).join('')}</optgroup>` : '';
  }).join('');
  sel.innerHTML = `<option value="all">ทุกหมวดหมู่ (${S.products.length})</option>${groups}`;
  sel.value = [...sel.options].some(o => o.value === S.cat) ? S.cat : 'all';
}

function renderChipGroups() {
  document.querySelectorAll('[data-chips]').forEach(box => {
    const sel = document.getElementById(box.dataset.chips);
    if (!sel) return;
    box.innerHTML = [...sel.options].map(o => {
      const on = o.value === sel.value;
      const t = o.textContent.replace(/^พร้อมส่ง · /, '');
      return `<button type="button" data-v="${esc(o.value)}" aria-pressed="${on}" class="px-3.5 py-1.5 rounded-full text-[14px] border transition ${on ? 'bg-ink text-gallery border-ink font-semibold' : 'bg-gallery text-ink border-hairline hover:bg-mist'}">${esc(t)}</button>`;
    }).join('');
  });
}

function syncControls() {
  const set = (id, v) => { const e = document.getElementById(id); if (e && e.value !== v) e.value = v; };
  set('cat-search', S.q); set('f-cat', S.cat); set('f-budget', S.budget); set('f-sort', S.sort);
  renderChipGroups();
  const active = [S.cat !== 'all', S.budget !== 'all', S.sort !== 'default'].filter(Boolean).length;
  const badge = document.getElementById('filter-count');
  if (badge) { badge.textContent = active; badge.classList.toggle('hidden', !active); badge.classList.toggle('inline-flex', !!active); }
  const chips = document.getElementById('filter-chips');
  if (chips) {
    const label = (id, v) => document.querySelector(`#${id} option[value="${CSS.escape(v)}"]`)?.textContent?.replace(/\s*\(\d+\)$/, '') || v;
    const chip = (text, key) => `<button type="button" onclick="clearFilter('${key}')" class="inline-flex items-center gap-1.5 bg-mist border border-hairline rounded-full pl-3 pr-2 py-1 text-[13px]">${esc(text)}${icon(ICONS.x, 'w-3.5 h-3.5 text-slate', 2)}</button>`;
    chips.innerHTML = [
      S.cat !== 'all' && chip(label('f-cat', S.cat), 'cat'),
      S.budget !== 'all' && chip(label('f-budget', S.budget), 'budget'),
      S.sort !== 'default' && chip('เรียง: ' + label('f-sort', S.sort), 'sort'),
      S.q.trim() && chip(`"${S.q.trim()}"`, 'q')
    ].filter(Boolean).join('');
  }
}

function writeUrl() {
  if (!opts.urlSync) return;
  const url = new URL(location.href);
  S.cat === 'all' ? url.searchParams.delete('cat') : url.searchParams.set('cat', S.cat);
  S.q.trim() ? url.searchParams.set('q', S.q.trim()) : url.searchParams.delete('q');
  history.replaceState({}, '', url);
}

/** Quick filters under the filter bar: the most used tags, and level steps when any product writes "Level: n" in its specs. */
function renderTagRow() {
  const bar = document.getElementById('filter-bar'); if (!bar) return;
  let row = document.getElementById('tag-row');
  if (!row) { bar.insertAdjacentHTML('afterend', '<div id="tag-row" class="flex gap-2 overflow-x-auto pb-2 mb-4 empty:hidden"></div>'); row = document.getElementById('tag-row'); }
  const count = {}; for (const p of S.products) for (const t of p.tags || []) { const k = String(t).trim(); if (k) count[k] = (count[k] || 0) + 1; }
  const tags = Object.entries(count).sort((a, b) => b[1] - a[1]).slice(0, 12).map(x => x[0]), hasLvl = S.products.some(p => levelOf(p) > 0);
  const chip = (on, label, fn, t = '') => `<button type="button" data-t="${esc(t)}" onclick="${fn}" class="shrink-0 px-3.5 py-1.5 rounded-full text-[13px] border ${on ? 'bg-ink text-gallery border-ink' : 'bg-mist text-slate border-hairline'}">${label}</button>`;
  const html = (hasLvl ? [20, 40, 60].map(n => chip(S.lvl === n, `Lv ${n}+`, `setLevel(${n})`)).join('') : '') + tags.map(t => chip(S.tag === t, '#' + esc(t), 'setTag(this.dataset.t)', t)).join('');
  if (row.dataset.sig !== html) { row.dataset.sig = html; row.innerHTML = html; }
}

export function render() {
  const grid = document.getElementById('product-grid');
  const empty = document.getElementById('empty-state');
  const cardsEl = document.getElementById('category-cards');
  const backEl = document.getElementById('category-back');
  const countEl = document.getElementById('catalog-count-label');
  if (!grid) return;
  syncControls();
  renderTagRow();
  if (!S.loaded) { grid.innerHTML = productSkeletonHtml(6); return; }

  const showEmpty = (title, desc, withClear) => {
    grid.innerHTML = '';
    if (!empty) return;
    empty.innerHTML = `<div class="w-14 h-14 rounded-2xl bg-gallery flex items-center justify-center text-steel mx-auto">${icon(ICONS.shop, 'w-7 h-7', 1.8)}</div>
      <h3 class="text-lg font-semibold text-ink mt-4">${esc(title)}</h3><p class="text-slate text-sm mt-1">${esc(desc)}</p>
      ${withClear ? `<button type="button" onclick="clearSearchAndFilters()" class="apple-explore-pill px-5 py-2 text-sm mt-5 bg-gallery">ล้างตัวกรองทั้งหมด</button>` : ''}`;
    empty.classList.remove('hidden');
  };
  empty?.classList.add('hidden');

  const browsing = S.cat === 'all' && !S.tag && !S.lvl && !S.q.trim() && S.budget === 'all' && S.sort === 'default' && S.cats.length > 0;
  if (cardsEl) { cardsEl.classList.toggle('hidden', !browsing); if (browsing) cardsEl.innerHTML = categoryCardsHtml(S.cats.filter(c => catVisible(c)), S.products); }
  backEl?.classList.toggle('hidden', browsing || S.cats.length === 0);
  const note = document.getElementById('cat-desc-note'), curCat = categoryOf(S.cats, S.cat);
  if (note) { note.textContent = curCat?.desc || ''; note.classList.toggle('hidden', browsing || !curCat?.desc); }

  if (S.failed) { if (countEl) countEl.textContent = 'โหลดไม่สำเร็จ'; showEmpty('โหลดรายการสินค้าไม่สำเร็จ', 'กรุณาตรวจสอบอินเทอร์เน็ตแล้วรีเฟรชหน้านี้', false); return; }
  if (!S.products.length) { if (countEl) countEl.textContent = '0 รายการ'; if (cardsEl) cardsEl.classList.add('hidden'); showEmpty('ยังไม่มีสินค้าในร้าน', 'แอดมินกำลังเติมสต๊อก เดี๋ยวของมา แวะมาใหม่นะ', false); return; }
  if (browsing) {
    // products without a category are standalone: shown as cards right under the category cards
    const free = S.products.filter(p => catIdOf(p, S.cats) === NONE).sort((a, b) => (b.featured ? 1 : 0) - (a.featured ? 1 : 0) || (a.order || 0) - (b.order || 0));
    grid.innerHTML = free.map(cardFor).join('');
    if (countEl) countEl.textContent = `${S.cats.length} หมวดหมู่ · ${S.products.length} สินค้า`;
    return;
  }

  const q = S.q.toLowerCase().trim();
  const list = S.products.filter(p => {
    if (S.cat !== 'all' && (S.cat === NONE ? catIdOf(p, S.cats) !== NONE : p.category !== S.cat)) return false;
    if (q && !String(p.name || '').toLowerCase().includes(q) && !(p.tags || []).some(t => String(t).toLowerCase().includes(q)) && !String(p.desc || '').toLowerCase().includes(q)) return false;
    if (S.tag && !(p.tags || []).some(t => String(t).toLowerCase() === S.tag.toLowerCase())) return false;
    if (S.lvl && levelOf(p) < S.lvl) return false;
    const st = stockOf(p), pr = priceOf(p);
    if (S.budget === 'instock') return st > 0;
    if (S.budget === 'under200') return st > 0 && pr <= 200;
    if (S.budget === '200to500') return st > 0 && pr > 200 && pr <= 500;
    if (S.budget === 'over500') return st > 0 && pr > 500;
    return true;
  });
  const ms = (p) => p.updatedAt?.toMillis?.() || p.createdAt?.toMillis?.() || 0;
  if (S.sort === 'price-asc') list.sort((a, b) => priceOf(a) - priceOf(b));
  else if (S.sort === 'price-desc') list.sort((a, b) => priceOf(b) - priceOf(a));
  else if (S.sort === 'stock-desc') list.sort((a, b) => stockOf(b) - stockOf(a));
  else if (S.sort === 'newest') list.sort((a, b) => ms(b) - ms(a));
  else list.sort((a, b) => (b.featured ? 1 : 0) - (a.featured ? 1 : 0) || (stockOf(b) > 0) - (stockOf(a) > 0));

  if (countEl) countEl.textContent = `แสดง ${list.length} รายการ · พร้อมส่ง ${list.filter(p => stockOf(p) > 0).length}`;
  if (!list.length) { showEmpty('ไม่พบสินค้าที่ตรงกับตัวกรอง', 'ลองเปลี่ยนหมวด งบ หรือคำค้นดู', true); return; }
  grid.innerHTML = list.map(cardFor).join('');
}

// ---------- actions (inline handlers) ----------
function filterCategory(id) { S.cat = id || 'all'; writeUrl(); render(); document.getElementById('catalog-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
function clearFilter(key) { if (key === 'cat') S.cat = 'all'; if (key === 'budget') S.budget = 'all'; if (key === 'sort') S.sort = 'default'; if (key === 'q') S.q = ''; writeUrl(); render(); }
function clearSearchAndFilters() { S.cat = 'all'; S.q = ''; S.budget = 'all'; S.sort = 'default'; S.tag = ''; S.lvl = 0; writeUrl(); closeFilterPanel(); render(); }
function closeFilterPanel() { document.getElementById('filter-panel')?.classList.add('hidden'); document.getElementById('filter-toggle')?.setAttribute('aria-expanded', 'false'); }
window.setTag = (t) => { S.tag = S.tag === t ? '' : t; render(); };
window.setLevel = (n) => { S.lvl = S.lvl === n ? 0 : n; render(); };
Object.assign(window, { filterCategory, clearFilter, clearSearchAndFilters, closeFilterPanel });

function merge() {
  const boxes = S.boxes.map(b => ({ id: 'box_' + b.id, boxId: b.id, isBox: true, name: String(b.name || 'กล่องสุ่ม'), desc: b.desc || '', price: Number(b.price) || 0, image: b.image || ROOT + 'assets/box.svg',
    category: b.category || '', prizeCount: (b.prizes || []).length, tags: [], featured: b.featured === true, href: `${ROOT}front/box.html?id=${encodeURIComponent(b.id)}` }));
  S.products = [...S.real, ...boxes];
  S.cats = S.realCats;
}

export function mountCatalog(options = {}) {
  opts = { ...opts, ...options };
  if (opts.urlSync) {
    const sp = new URLSearchParams(location.search);
    S.cat = sp.get('cat') || 'all';
    S.q = sp.get('q') || '';
  }
  const bar = document.getElementById('filter-bar');
  if (bar) {
    bar.innerHTML = filterBarHtml();
    const search = document.getElementById('cat-search');
    let t = null;
    search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { S.q = search.value; writeUrl(); render(); }, 150); });
    document.getElementById('filter-toggle').addEventListener('click', (e) => {
      e.stopPropagation();
      const p = document.getElementById('filter-panel');
      const open = p.classList.toggle('hidden') === false;
      e.currentTarget.setAttribute('aria-expanded', String(open));
    });
    document.getElementById('filter-panel').addEventListener('click', (e) => e.stopPropagation());
    document.addEventListener('click', closeFilterPanel);
    document.getElementById('filter-panel').addEventListener('click', (e) => {
      const b = e.target.closest('[data-chips] button'); if (!b) return;
      const sel = document.getElementById(b.closest('[data-chips]').dataset.chips);
      sel.value = b.dataset.v; sel.dispatchEvent(new Event('change'));
    });
    document.getElementById('f-cat').addEventListener('change', (e) => { S.cat = e.target.value; writeUrl(); render(); });
    document.getElementById('f-budget').addEventListener('change', (e) => { S.budget = e.target.value; render(); });
    document.getElementById('f-sort').addEventListener('change', (e) => { S.sort = e.target.value; render(); });
  }
  render();

  watchCategories((list) => { S.realCats = list; merge(); fillCategorySelect(); render(); opts.onProducts?.(S); });
  // Loot boxes show as products (in their category, or standalone when none); the card opens front/box.html?id=…
  onSnapshot(collection(db, 'boxes'), (snap) => {
    S.boxes = snap.docs.map(d => ({ ...d.data(), id: d.id })).filter(b => b.active !== false);
    merge(); if (S.loaded) { fillCategorySelect(); render(); opts.onProducts?.(S); }
  }, (e) => console.warn('boxes:', e));
  onSettings((s) => { S.settings = s || {}; if (S.loaded) { render(); opts.onProducts?.(S); } });
  const cached = readProducts(); // paint the last known list now; the snapshot below replaces it
  if (Array.isArray(cached) && cached.length) { S.real = cached; merge(); S.loaded = true; fillCategorySelect(); render(); opts.onProducts?.(S); }
  const timer = setTimeout(() => { if (!S.loaded) { S.loaded = true; S.failed = true; render(); } }, 10000);
  onSnapshot(collection(db, 'products'), (snap) => {
    clearTimeout(timer);
    S.loaded = true; S.failed = false;
    S.products = snap.docs.filter(d => !hiddenFromShop(d.data())).map(d => {
      const data = d.data() || {};
      return { ...data, id: d.id, name: String(data.name || 'ไม่มีชื่อสินค้า'), image: data.image || FALLBACK_IMG,
        tags: Array.isArray(data.tags) ? data.tags.map(String) : [] };
    });
    S.real = S.products; writeProducts(S.real); merge();
    fillCategorySelect();
    render();
    opts.onProducts?.(S);
  }, (e) => {
    clearTimeout(timer);
    console.warn('products:', e);
    S.loaded = true; S.failed = true; render();
  });
  return S;
}
