import { db } from "../firebase-config.js";
import { collection, doc, limit, onSnapshot, orderBy, query } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { esc, num, money, timeAgo, onSettings, icon, ICONS } from "./ui.js";
import { mountCatalog, cardFor, stockOf } from "./catalog.js";

/** Home page: hero, live recent-orders feed, stats (admin base + real counts), featured products, catalog. */

// ---------- Featured + stock stat ----------
let stockTotal = null;
function onProducts(S) {
  stockTotal = S.products.reduce((sum, p) => sum + stockOf(p), 0);
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
onSnapshot(query(collection(db, 'recent_orders'), orderBy('createdAt', 'desc'), limit(6)), (snap) => {
  const ul = document.getElementById('recent-orders');
  if (snap.empty) {
    ul.innerHTML = `<li class="py-8 text-center text-slate text-sm">ยังไม่มีรายการสั่งซื้อ เป็นคนแรกเลย!</li>`;
    return;
  }
  ul.innerHTML = snap.docs.map(d => {
    const o = d.data();
    return `<li class="py-3 flex items-center gap-3">
      <span class="w-10 h-10 shrink-0 rounded-full bg-mist text-pricingBlue flex items-center justify-center">${icon(o.kind === 'service' ? ICONS.bolt : ICONS.id, 'w-5 h-5', 2)}</span>
      <div class="min-w-0 flex-1">
        <p class="font-medium text-ink truncate">${esc(o.productName || 'สินค้า')}</p>
        <p class="text-xs text-slate"><span class="font-mono">${esc(o.buyerMask || 'us***')}</span> · ${esc(timeAgo(o.createdAt))}</p>
      </div>
      <span class="font-heading font-semibold text-ink whitespace-nowrap">฿${money(o.amount, 0)}</span>
    </li>`;
  }).join('');
}, (e) => {
  console.warn('recent orders:', e);
  document.getElementById('recent-orders').innerHTML = `<li class="py-8 text-center text-slate text-sm">โหลดรายการไม่สำเร็จ</li>`;
});

mountCatalog({ urlSync: false, onProducts });
