import { db } from "../firebase-config.js";
import { collection, onSnapshot } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { esc, icon, ICONS, onSettings, workerBase } from "./ui.js";
import { productCardHtml, productSkeletonHtml } from "./card.js";
import { watchCategories, categoryCardsHtml, categoryOf, catIdOf, isServiceProduct, minQtyOf, unitOf, KIND_LABEL, NONE, NONE_LABEL } from "./categories.js";

/**
 * Catalog shared by the home page and the category page: one compact filter bar (search + a single
 * "ตัวกรอง" dropdown with category / budget / sort), category cards while browsing, product grid,
 * skeleton while loading and empty states. Products without a category still show (as "สินค้าอื่น ๆ").
 */
export const FALLBACK_IMG = 'https://placehold.co/800x600/f5f5f7/86868b?text=ASTRAPHEX+HUB';

const S = { cats: [], products: [], loaded: false, failed: false, cat: 'all', q: '', budget: 'all', sort: 'default', settings: {} };
let opts = { urlSync: false, onProducts: null };

export const priceOf = (p) => { const v = Number(p?.price); if (v > 0) return v; const r = Number(p?.serviceRate); return r > 0 ? r : 0; };
export const stockOf = (p) => { const s = Number(p?.stock); return s > 0 ? Math.floor(s) : 0; };

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
    const items = S.cats.filter(c => c.kind === kind);
    return items.length ? `<optgroup label="${esc(KIND_LABEL[kind])}">${items.map(c => `<option value="${esc(c.id)}">${esc(c.name)} (${count(c.id)})</option>`).join('')}</optgroup>` : '';
  }).join('');
  const none = count(NONE);
  sel.innerHTML = `<option value="all">ทุกหมวดหมู่ (${S.products.length})</option>${groups}${none && S.cats.length ? `<option value="${NONE}">${NONE_LABEL} (${none})</option>` : ''}`;
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

export function render() {
  const grid = document.getElementById('product-grid');
  const empty = document.getElementById('empty-state');
  const cardsEl = document.getElementById('category-cards');
  const backEl = document.getElementById('category-back');
  const countEl = document.getElementById('catalog-count-label');
  if (!grid) return;
  syncControls();
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

  const browsing = S.cat === 'all' && !S.q.trim() && S.budget === 'all' && S.sort === 'default' && S.cats.length > 0;
  if (cardsEl) { cardsEl.classList.toggle('hidden', !browsing); if (browsing) cardsEl.innerHTML = categoryCardsHtml(S.cats, S.products); }
  backEl?.classList.toggle('hidden', browsing || S.cats.length === 0);

  if (S.failed) { if (countEl) countEl.textContent = 'โหลดไม่สำเร็จ'; showEmpty('โหลดรายการสินค้าไม่สำเร็จ', 'กรุณาตรวจสอบอินเทอร์เน็ตแล้วรีเฟรชหน้านี้', false); return; }
  if (!S.products.length) { if (countEl) countEl.textContent = '0 รายการ'; if (cardsEl) cardsEl.classList.add('hidden'); showEmpty('ยังไม่มีสินค้าในร้าน', 'แอดมินกำลังเตรียมสินค้า แวะกลับมาใหม่เร็ว ๆ นี้', false); return; }
  if (browsing) { grid.innerHTML = ''; if (countEl) countEl.textContent = `${S.cats.length + (S.products.some(p => catIdOf(p, S.cats) === NONE) ? 1 : 0)} หมวดหมู่ · ${S.products.length} สินค้า`; return; }

  const q = S.q.toLowerCase().trim();
  const list = S.products.filter(p => {
    if (S.cat !== 'all' && (S.cat === NONE ? catIdOf(p, S.cats) !== NONE : p.category !== S.cat)) return false;
    if (q && !String(p.name || '').toLowerCase().includes(q) && !(p.tags || []).some(t => String(t).toLowerCase().includes(q)) && !String(p.desc || '').toLowerCase().includes(q)) return false;
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
  if (!list.length) { showEmpty('ไม่พบสินค้าที่ตรงกับตัวกรอง', 'ลองเปลี่ยนหมวดหมู่ งบประมาณ หรือคำค้นหา', true); return; }
  grid.innerHTML = list.map(cardFor).join('');
}

// ---------- actions (inline handlers) ----------
function filterCategory(id) { S.cat = id || 'all'; writeUrl(); render(); document.getElementById('catalog-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
function clearFilter(key) { if (key === 'cat') S.cat = 'all'; if (key === 'budget') S.budget = 'all'; if (key === 'sort') S.sort = 'default'; if (key === 'q') S.q = ''; writeUrl(); render(); }
function clearSearchAndFilters() { S.cat = 'all'; S.q = ''; S.budget = 'all'; S.sort = 'default'; writeUrl(); closeFilterPanel(); render(); }
function closeFilterPanel() { document.getElementById('filter-panel')?.classList.add('hidden'); document.getElementById('filter-toggle')?.setAttribute('aria-expanded', 'false'); }
Object.assign(window, { filterCategory, clearFilter, clearSearchAndFilters, closeFilterPanel });

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

  watchCategories((list) => { S.cats = list; fillCategorySelect(); render(); opts.onProducts?.(S); });
  onSettings((s) => { S.settings = s || {}; if (S.loaded) { render(); opts.onProducts?.(S); } });
  const timer = setTimeout(() => { if (!S.loaded) { S.loaded = true; S.failed = true; render(); } }, 10000);
  onSnapshot(collection(db, 'products'), (snap) => {
    clearTimeout(timer);
    S.loaded = true; S.failed = false;
    S.products = snap.docs.map(d => {
      const data = d.data() || {};
      return { ...data, id: d.id, name: String(data.name || 'ไม่มีชื่อสินค้า'), image: data.image || FALLBACK_IMG,
        tags: Array.isArray(data.tags) ? data.tags.map(String) : [] };
    });
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
