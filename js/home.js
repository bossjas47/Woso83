import { db } from "../firebase-config.js";
import "./popup.js";
import { collection, doc, limit, onSnapshot, orderBy, query } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { esc, num, money, timeAgo, onSettings, icon, ICONS } from "./ui.js";
import { mountCatalog, cardFor, stockOf } from "./catalog.js";
import { orderThumb, PRODUCT_IMAGES } from "./orders-ui.js";

/** Home page: hero, live recent-orders feed, stats (admin base + real counts), featured products, catalog. */

// ---------- Featured + stock stat ----------
let stockTotal = null, PRODUCTS = [], RECENT = null;
function onProducts(S) {
  stockTotal = S.products.reduce((sum, p) => sum + stockOf(p), 0);
  PRODUCTS = S.products; S.products.forEach(p => p.image && PRODUCT_IMAGES.set(p.id, p.image)); renderRecent();
  renderStats();
  const featured = S.products.filter(p => p.featured === true);
  document.getElementById('featured-section').classList.toggle('hidden', !featured.length);
  document.getElementById('featured-grid').innerHTML = featured.slice(0, 6).map(cardFor).join('');
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
onSettings((s) => { base = s.baseStats || {}; renderStats(); });
onSnapshot(doc(db, 'stats', 'public'), (snap) => { actual = snap.exists() ? snap.data() : {}; renderStats(); }, () => renderStats());

// ---------- Recent orders feed (recent_orders is written only by admin / Worker when an order completes) ----------
// older feed rows have no productId: match the product by name (the order name may end with " (mode)")
const pidOf = (o) => o.productId || PRODUCTS.find(p => p.name && String(o.productName || '').startsWith(p.name))?.id;
function renderRecent() {
  const ul = document.getElementById('recent-orders'); if (!RECENT) return;
  if (!RECENT.length) { ul.innerHTML = `<li class="py-8 text-center text-slate text-sm">ยังไม่มีรายการสั่งซื้อ เป็นคนแรกเลย!</li>`; return; }
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
