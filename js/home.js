import { db } from "../firebase-config.js";
import "./popup.js";
import { collection, doc, limit, onSnapshot, orderBy, query } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { esc, num, money, timeAgo, onSettings, icon, ICONS, imgAttrs } from "./ui.js";
import { mountCatalog, cardFor, stockOf, priceOf } from "./catalog.js";
import { ammoRateOf, ammoListRate } from "./ammo-rate.js";
import { productUrl } from "./card.js";
import { orderThumb, PRODUCT_IMAGES } from "./orders-ui.js";
import { QUICK_ICONS, quickOf, safeHref } from "./home-quick.js";

/** Home page: hero, live recent-orders feed, stats (admin base + real counts), featured products, catalog. */

// ---------- Featured + stock stat ----------
let stockTotal = null, PRODUCTS = [], RECENT = null;
function onProducts(S) {
  stockTotal = S.products.reduce((sum, p) => sum + (p.isAmmo ? 0 : stockOf(p)), 0); // ammo stock is in กอง, not IDs
  PRODUCTS = S.products; S.products.forEach(p => p.image && PRODUCT_IMAGES.set(p.id, p.image)); renderRecent();
  renderStats();
  const featured = S.products.filter(p => p.featured === true);
  document.getElementById('featured-section').classList.toggle('hidden', !featured.length);
  document.getElementById('featured-grid').innerHTML = featured.slice(0, 6).map(cardFor).join('');
  renderSpotlight();
  renderAmmoPrice(S.products);
}

/** Live ammo price: rate now (after discount), strike-through list rate, stock in กอง. */
function renderAmmoPrice(products) {
  const am = products.filter(p => p.isAmmo === true), p = am.find(x => stockOf(x) > 0) || am[0];
  const sec = document.getElementById('ammo-price-section'); sec.classList.toggle('hidden', !p);
  if (!p) return;
  const list = ammoListRate(p), now = ammoRateOf(p, 0), cut = now < list, st = stockOf(p);
  document.getElementById('ammo-price-card').href = productUrl(p.id);
  document.getElementById('ammo-price-card').innerHTML = `<div class="flex items-center justify-between gap-4 flex-wrap">
    <div><p class="text-launchOrange text-sm font-semibold">ราคาวันนี้${cut ? ' · <span class="text-red-500">ลดอยู่</span>' : ''}</p>
      <p class="text-xl sm:text-2xl font-heading font-semibold">${esc(p.name)}</p>
      <p class="text-sm text-slate mt-1">${st > 0 ? `เหลือ ${st.toLocaleString('th-TH')} กอง` : 'สินค้าหมดชั่วคราว'}${(p.ammoTiers || []).length ? ' · ซื้อเยอะลดเพิ่ม' : ''}</p></div>
    <div class="text-right"><p class="text-3xl sm:text-4xl font-heading font-semibold">฿${money(now)}<span class="text-sm text-slate font-normal"> /กอง</span></p>
      ${cut ? `<p class="text-sm text-slate" style="text-decoration:line-through">฿${money(list)}</p>` : ''}</div></div>`;
}

// ---------- Spotlight: hand-picked products at the top (back office › ตั้งค่า › สินค้าแนะนำสุดพิเศษ) ----------
let SPOT = {}, spotTimer = null, spotIdx = 0;
function renderSpotlight() {
  const el = document.getElementById('spotlight'); if (!el) return;
  clearInterval(spotTimer);
  const byId = new Map(PRODUCTS.map(p => [p.id, p]));
  // nothing picked: fall back to the products marked "featured"
  const picked = SPOT.on && SPOT.items?.length ? SPOT.items.map(x => byId.get(x.id) && { p: byId.get(x.id), tag: x.tagline }).filter(Boolean)
    : PRODUCTS.filter(p => p.featured === true).slice(0, 3).map(p => ({ p }));
  el.classList.toggle('hidden', !picked.length);
  if (!picked.length) return;
  spotIdx = Math.min(spotIdx, picked.length - 1);
  const kicker = esc(SPOT.kicker || 'แนะนำสุดพิเศษ');
  el.innerHTML = `<div class="sp-track">${picked.map(({ p, tag }, i) => {
    const href = p.href || productUrl(p.id), st = stockOf(p), pr = priceOf(p);
    return `<a href="${esc(href)}" class="sp-slide${i === spotIdx ? ' on' : ''}" aria-hidden="${i !== spotIdx}" ${i !== spotIdx ? 'tabindex="-1"' : ''}>
      <span class="sp-text"><span class="sp-kicker">${kicker}</span><span class="sp-name font-heading">${esc(p.name)}</span>
        <span class="sp-tag">${esc(tag || String(p.desc || '').slice(0, 90))}</span>
        <span class="sp-buy"><span class="sp-price">${pr ? '฿' + money(pr, 0) : ''}${p.isBox || st ? '' : ' <small>· สินค้าหมด</small>'}</span><span class="apple-pricing-pill px-5 py-2 text-[14px]">ดูสินค้า</span></span></span>
      <span class="sp-media"><img ${imgAttrs(p.image, 720, 540, { eager: i === 0 })} alt=""></span></a>`;
  }).join('')}</div>${picked.length > 1 ? `<div class="sp-dots" role="tablist">${picked.map((_, i) => `<button type="button" role="tab" aria-label="สไลด์ ${i + 1}" aria-selected="${i === spotIdx}" data-i="${i}"></button>`).join('')}</div>` : ''}`;
  const go = (i) => {
    spotIdx = (i + picked.length) % picked.length;
    el.querySelectorAll('.sp-slide').forEach((s, k) => { s.classList.toggle('on', k === spotIdx); s.setAttribute('aria-hidden', k !== spotIdx); k === spotIdx ? s.removeAttribute('tabindex') : s.setAttribute('tabindex', '-1'); });
    el.querySelectorAll('.sp-dots button').forEach((b, k) => b.setAttribute('aria-selected', k === spotIdx));
  };
  el.querySelectorAll('.sp-dots button').forEach(b => b.onclick = () => { go(+b.dataset.i); start(); });
  let x0 = null; // swipe on phones
  el.ontouchstart = (e) => { x0 = e.touches[0].clientX; };
  el.ontouchend = (e) => { if (x0 === null) return; const dx = e.changedTouches[0].clientX - x0; x0 = null; if (Math.abs(dx) > 40) { go(spotIdx + (dx < 0 ? 1 : -1)); start(); } };
  const start = () => { clearInterval(spotTimer); if (picked.length > 1 && !matchMedia('(prefers-reduced-motion: reduce)').matches) spotTimer = setInterval(() => !document.hidden && go(spotIdx + 1), (SPOT.interval || 6) * 1000); };
  start();
}

// ---------- Stats: base numbers from admin + real counters in stats/public ----------
let base = {}, actual = {};
function renderStats() {
  const show = (id, v, fmt = (x) => Math.round(x).toLocaleString('th-TH')) => { const el = document.getElementById(id); if (el) el.textContent = fmt(v); };
  show('stat-users', num(base.users) + num(actual.users));
  show('stat-sales', num(base.sales) + num(actual.sales), (x) => money(x, 0));
  show('stat-orders', num(base.orders) + num(actual.orders));
  if (stockTotal !== null) show('stat-stock', stockTotal);
}
onSettings((s) => { base = s.baseStats || {}; SPOT = s.spotlight || {}; renderStats(); renderQuick(s); if (PRODUCTS.length) renderSpotlight(); });
function renderQuick(s) {
  const el = document.getElementById('hm-quick'); if (!el) return;
  el.innerHTML = quickOf(s).filter(q => q.on !== false && q.title).map(q => `<a href="${esc(safeHref(q.href))}" class="hm-q"><span><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${(QUICK_ICONS[q.icon] || QUICK_ICONS.star)[1]}</svg></span><b>${esc(q.title)}</b>${q.sub ? `<small>${esc(q.sub)}</small>` : ''}</a>`).join('');
}
onSnapshot(doc(db, 'stats', 'public'), (snap) => { actual = snap.exists() ? snap.data() : {}; renderStats(); }, () => renderStats());

// ---------- Recent orders feed (recent_orders is written only by admin / Worker when an order completes) ----------
// older feed rows have no productId: match the product by name (the order name may end with " (mode)")
const pidOf = (o) => o.productId || PRODUCTS.find(p => p.name && String(o.productName || '').startsWith(p.name))?.id;
function renderRecent() {
  const ul = document.getElementById('recent-orders'); if (!RECENT) return;
  if (!RECENT.length) { ul.innerHTML = `<li class="py-8 text-center text-slate text-sm">ยังไม่มีใครเปิดบิล มาเป็นคนแรกกัน!</li>`; return; }
  ul.innerHTML = RECENT.map(o => `<li class="py-3 flex items-center gap-3">
      ${orderThumb({ ...o, productId: pidOf(o) }, 48)}
      <div class="min-w-0 flex-1">
        <p class="font-medium text-ink truncate">${esc(o.productName || 'สินค้า')}</p>
        <p class="text-xs text-slate"><span class="font-mono">${esc(o.buyerMask || 'us***')}</span> · ${esc(timeAgo(o.createdAt))}</p>
      </div>
      <span class="font-heading font-semibold text-ink whitespace-nowrap">฿${money(o.amount, 0)}</span>
    </li>`).join('');
}
onSnapshot(query(collection(db, 'recent_orders'), orderBy('createdAt', 'desc'), limit(6)), (snap) => {
  RECENT = snap.docs.map(d => d.data()); renderRecent();
}, (e) => {
  console.warn('recent orders:', e);
  document.getElementById('recent-orders').innerHTML = `<li class="py-8 text-center text-slate text-sm">โหลดรายการไม่สำเร็จ</li>`;
});

mountCatalog({ urlSync: false, onProducts });
