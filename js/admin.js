import { db, auth } from "../firebase-config.js";
import {
  collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, writeBatch, onSnapshot, query, where, limit, orderBy,
  runTransaction, Timestamp, serverTimestamp, increment, deleteField
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { watchCategories, catVisible, KIND_LABEL, categoryOf, isServiceProduct, minQtyOf, unitOf } from "./categories.js";
import { esc, num, money, toast, fmtDate, openModal, closeModal, compressImage, maskName } from "./ui.js";
import { rankTable, rankOf, rankBadge, rankIcon, titleBadge, TITLE_COLORS } from "./rank.js";
import { ammoRateOf } from "./ammo-rate.js";
import { dragSort } from "./back/dragsort.js";
import { QUICK_ICONS, quickOf, safeHref } from "./home-quick.js";

/**
 * Nugget Hub — back office. The real gate is the Firebase custom claim admin:true (firestore.rules);
 * the PIN is only a screen lock. Sections: products & stock, categories, orders, top-ups & promotions,
 * users, promo codes (js/back/code.js), settings.
 */
const $ = (id) => document.getElementById(id);
const adminEsc = esc;
const triggerToast = (m, kind) => toast(m, kind);
window.triggerToast = triggerToast;
const tsMs = (v) => v?.toMillis?.() ?? (v ? new Date(v).getTime() : 0);

// Phone layout of the tables (see .admin-table in admin.html): copy each column title onto the cells of its rows.
function labelTable(table) {
  const heads = [...table.querySelectorAll('thead th')].map(th => th.textContent.trim());
  table.querySelectorAll('tbody tr').forEach(tr => [...tr.children].forEach((td, i) => { if (td.tagName === 'TD' && td.colSpan < 2 && heads[i] && td.dataset.label !== heads[i]) td.dataset.label = heads[i]; }));
}
document.querySelectorAll('.admin-table').forEach(table => {
  labelTable(table);
  const body = table.querySelector('tbody');
  if (body) new MutationObserver(() => labelTable(table)).observe(body, { childList: true });
});

/** Per-person permissions (custom claim `perms`); admins can do everything. Mirrors firestore.rules + the Worker. */
const PERM_LABEL = { orders: 'ทำคิวงานบริการ (เริ่มงาน/ส่งมอบ/หมายเหตุ)', pay: 'ยืนยันชำระ ยกเลิก/คืนเงิน ดูสลิป เติมเงิน (ทุกออเดอร์)', products: 'สินค้า สต็อก หมวดหมู่', promos: 'โค้ดส่วนลด และโปรเติมเงิน', rentals: 'ไอดีเช่า', boxes: 'กล่องสุ่ม', vault: 'โปรแกรมไอดีไก่', users: 'ผู้ใช้ (ดู/ข้อมูลติดต่อ)', credit: 'ปรับเครดิตลูกค้า (ตั้งเพดาน ฿/วัน ด้านล่าง)', price: 'แก้ราคาสินค้า', profit: 'ดูต้นทุน/กำไร/รายงานรายเดือน' };
let ADMIN = false, PERMS = new Set();
const can = (p) => ADMIN || PERMS.has(p);
const STAFF_ONLY_QUEUE = () => !ADMIN && !can('pay'); // can work service jobs but not handle money
const TAB_OK = { dashboard: () => ADMIN, settings: () => ADMIN, products: () => can('products'), categories: () => can('products'), orders: () => can('orders') || can('pay'), topups: () => can('pay'), rentals: () => can('rentals'), boxes: () => can('boxes'), vault: () => can('vault'), users: () => can('users') || can('credit'), promos: () => can('promos') };
const tabOk = (t) => (TAB_OK[t] || (() => false))();
let REPLIES = [], REVIEWS_P = [], ACLAIMS = [], AQUOTES = [], PRODUCTS = [], CATS = [], ORDERS = [], TOPUPS = [], USERS = [], TPROMOS = [], RENTALS = [], STATS = {}, SETTINGS = {};
let rentalFilter = 'todo';
let me = null;

const formatUrl = (url) => {
  const s = String(url || '').trim();
  if (s && !/^https?:\/\//i.test(s) && !s.startsWith('/') && !s.startsWith('#') && !s.startsWith('data:')) return 'https://' + s;
  return s;
};
const workerUrl = () => String(SETTINGS.slipWorkerUrl || '').trim().replace(/\/+$/, '');
async function callWorker(path, body) {
  if (!workerUrl()) throw new Error('ยังไม่ได้ตั้งค่า URL ของ Worker (ตั้งค่าร้าน › ระบบอัตโนมัติ)');
  const res = await fetch(workerUrl() + path, { method: 'POST', headers: { authorization: 'Bearer ' + await auth.currentUser.getIdToken(), 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || data.message || `Worker ตอบกลับ ${res.status}`);
  return data;
}

// ==========================================
// GATE: admin claim, then PIN screen lock
// ==========================================
let currentSecurityDoc = null, failedAttempts = 0, lockoutTimer = null, started = false;
async function hashPinWithSalt(pin, salt) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pin + ':' + salt + ':TACTICAL_PIN_VAULT_2026'));
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
}
const randomSalt = () => [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
function gateState(name) { ['loading', 'noauth', 'setup', 'unlock'].forEach(k => $(`pin-state-${k}`)?.classList.toggle('hidden', k !== name)); }

onAuthStateChanged(auth, async (user) => {
  me = user;
  if (!user) { gateState('noauth'); return; }
  let claims = {};
  try { claims = (await user.getIdTokenResult(true)).claims; } catch (_) {}
  const isAdmin = claims.admin === true;
  ADMIN = isAdmin; PERMS = new Set(Array.isArray(claims.perms) ? claims.perms : []);
  if (!isAdmin && !PERMS.size) {
    $('noauth-title').textContent = '403 · ไม่มีสิทธิ์เข้าถึง';
    $('noauth-text').textContent = `บัญชี ${user.displayName || user.email} ไม่ใช่ผู้ดูแลระบบ`;
    $('noauth-login').textContent = 'กลับหน้าร้าน'; $('noauth-login').href = '../home.html';
    gateState('noauth');
    return;
  }
  $('admin-who').textContent = `${ADMIN ? 'แอดมิน' : 'ทีมงาน'}: ${user.displayName || user.email}`;
  if (!ADMIN) { unlockDashboardUI(); return; } // delegated accounts skip the admin PIN (they cannot read it)
  if (sessionStorage.getItem('astraphex_admin_unlocked') === 'true') { unlockDashboardUI(); return; }
  try {
    const pin = await getDoc(doc(db, 'system_settings', 'admin_pin'));
    currentSecurityDoc = pin.exists() ? pin.data() : null;
  } catch (e) { console.warn('pin:', e); }
  if (currentSecurityDoc?.pinHash && currentSecurityDoc?.salt) { gateState('unlock'); initPinDigitBoxes(); }
  else gateState('setup');
});

async function handlePinSetupSubmit(e) {
  e.preventDefault();
  const p1 = $('setup-pin-val').value.trim(), p2 = $('setup-pin-confirm').value.trim();
  if (!/^\d{6}$/.test(p1)) return triggerToast('PIN ต้องเป็นตัวเลข 6 หลัก', 'error');
  if (p1 !== p2) return triggerToast('PIN ทั้งสองช่องไม่ตรงกัน', 'error');
  const salt = randomSalt();
  try {
    await setDoc(doc(db, 'system_settings', 'admin_pin'), { pinHash: await hashPinWithSalt(p1, salt), salt, updatedAt: serverTimestamp(), setBy: me?.uid || '' });
    sessionStorage.setItem('astraphex_admin_unlocked', 'true');
    unlockDashboardUI();
  } catch (err) { triggerToast('บันทึก PIN ไม่สำเร็จ', 'error'); }
}
async function handlePinUnlockSubmit(e) {
  e?.preventDefault();
  if (failedAttempts >= 5) return triggerToast('ล็อกชั่วคราว กรุณารอสักครู่', 'error');
  const digits = [...document.querySelectorAll('.pin-digit-input')].map(i => i.value).join('');
  if (digits.length !== 6) return triggerToast('กรุณากรอก PIN ให้ครบ 6 หลัก', 'error');
  if (await hashPinWithSalt(digits, currentSecurityDoc.salt) === currentSecurityDoc.pinHash) {
    failedAttempts = 0;
    sessionStorage.setItem('astraphex_admin_unlocked', 'true');
    unlockDashboardUI();
    return;
  }
  failedAttempts++;
  $('pin-error-msg')?.classList.remove('hidden');
  document.querySelectorAll('.pin-digit-input').forEach(i => { i.value = ''; });
  document.querySelector('.pin-digit-input')?.focus();
  if (failedAttempts >= 5) {
    $('pin-lockout-msg')?.classList.remove('hidden'); $('btn-pin-submit').disabled = true;
    let left = 60; clearInterval(lockoutTimer);
    lockoutTimer = setInterval(() => { left--; $('pin-lockout-timer').textContent = left; if (left <= 0) { clearInterval(lockoutTimer); failedAttempts = 0; $('pin-lockout-msg').classList.add('hidden'); $('btn-pin-submit').disabled = false; } }, 1000);
  } else triggerToast(`PIN ไม่ถูกต้อง (เหลือ ${5 - failedAttempts} ครั้ง)`, 'error');
}
function initPinDigitBoxes() {
  const inputs = document.querySelectorAll('.pin-digit-input');
  inputs.forEach((input, i) => {
    input.oninput = (e) => { if (e.target.value.length === 1 && i < inputs.length - 1) inputs[i + 1].focus(); if ([...inputs].every(x => x.value.length === 1)) handlePinUnlockSubmit(null); };
    input.onkeydown = (e) => { if (e.key === 'Backspace' && !e.target.value && i > 0) inputs[i - 1].focus(); };
  });
  inputs[0]?.focus();
}
async function promptResetPin() {
  if (!confirm('รีเซ็ตรหัส PIN แล้วตั้งใหม่?')) return;
  try { await deleteDoc(doc(db, 'system_settings', 'admin_pin')); } catch (_) {}
  sessionStorage.removeItem('astraphex_admin_unlocked');
  location.reload();
}
function lockAdminSession() { sessionStorage.removeItem('astraphex_admin_unlocked'); location.reload(); }

function unlockDashboardUI() {
  $('admin-auth-gate')?.classList.add('hidden');
  $('admin-main-content')?.classList.remove('hidden');
  if (started) return;
  started = true;
  // admins made with scripts/set-admin-claim.js have no role field yet; record it for the users list
  if (ADMIN && me) setDoc(doc(db, 'users', me.uid), { role: 'admin' }, { merge: true }).catch(() => {});
  startListeners();
  const saved = sessionStorage.getItem('astraphex_admin_tab');
  switchAdminTab(saved && tabOk(saved) ? saved : ['orders', 'products', 'topups', 'users', 'promos', 'rentals', 'boxes', 'vault'].find(tabOk) || 'orders');
}

function startListeners() {
  if (can('boxes')) window.startBoxWatch?.(); // loot-box opens feed the dashboard too (js/back/boxes.js)
  document.addEventListener('boxopens', () => renderDashboard());
  const warn = (what) => (e) => { console.warn(what, e); triggerToast(`โหลด${what}ไม่สำเร็จ`, 'error'); };
  if (can('products') || can('boxes') || can('promos')) onSnapshot(collection(db, 'products'), (s) => { PRODUCTS = s.docs.map(d => ({ ...d.data(), id: d.id })); renderAdminProducts(); renderAuctionsAdmin(); renderProfit(); updateAdminMetrics(); renderAdminCategories(); renderDashboard(); if (ADMIN && Object.keys(SETTINGS).length) renderSpotlightRows(); }, warn('สินค้า'));
  if (can('products') || can('boxes') || can('promos')) watchCategories((list) => { CATS = list; renderAdminCategories(); fillProductCategorySelect(); renderAdminProducts(); });
  if (can('profit')) getDoc(doc(db, 'system_settings', 'finance')).then(d => { if ($('month-fee')) { $('month-fee').value = num(d.data()?.slipFee) || ''; monthReport(); } }).catch(() => {});
  if (can('pay')) onSnapshot(collection(db, 'orders'), (s) => { ORDERS = s.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => tsMs(b.createdAt) - tsMs(a.createdAt)); renderAdminOrders(); renderBadges(); renderWinback(); renderProfit(); }, warn('ออเดอร์'));
  if (can('pay')) onSnapshot(collection(db, 'topup_transactions'), (s) => { TOPUPS = s.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => tsMs(b.createdAt) - tsMs(a.createdAt)); renderAdminTopups(); renderBadges(); }, warn('รายการเติมเงิน'));
  if (can('rentals')) onSnapshot(collection(db, 'rentals'), (s) => { RENTALS = s.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => tsMs(b.createdAt) - tsMs(a.createdAt)); renderAdminRentals(); renderBadges(); }, warn('การเช่า'));
  if (can('users') || can('vault')) onSnapshot(collection(db, 'users'), (s) => { USERS = s.docs.map(d => ({ uid: d.id, ...d.data() })).sort((a, b) => tsMs(b.createdAt) - tsMs(a.createdAt)); renderAdminUsers(); renderDashboard(); document.dispatchEvent(new Event('adminusers')); }, warn('ผู้ใช้'));
  if (can('promos')) onSnapshot(collection(db, 'topup_promos'), (s) => { TPROMOS = s.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => num(a.minAmount) - num(b.minAmount)); renderTopupPromos(); });
  if (ADMIN) onSnapshot(query(collection(db, 'ammo_quotes'), where('status', 'in', ['open', 'paid_undelivered', 'refunded_credit'])), (s) => { AQUOTES = s.docs.map(d => ({ id: d.id, ...d.data() })); renderDashboard(); }, warn('รายการกันไอดี'));
  if (can('products')) onSnapshot(collection(db, 'auctions'), (s) => { AUCTIONS = s.docs.map(d => ({ id: d.id, ...d.data() })); renderAuctionsAdmin(); }, warn('ประมูล'));
  if (can('orders') || can('pay')) onSnapshot(doc(db, 'system', 'replies'), (d) => { REPLIES = Array.isArray(d.data()?.list) ? d.data().list : []; if (ADMIN && $('replies-text')) $('replies-text').value = REPLIES.join('\n'); }, warn('ข้อความสำเร็จรูป'));
  if (ADMIN) onSnapshot(query(collection(db, 'reviews'), where('status', '==', 'pending'), limit(50)), (s) => { REVIEWS_P = s.docs.map(d => ({ id: d.id, ...d.data() })); renderReviewsDash(); }, warn('รีวิว'));
  if (ADMIN) onSnapshot(query(collection(db, 'ammo_claims'), where('status', '==', 'open')), (s) => { ACLAIMS = s.docs.map(d => ({ id: d.id, ...d.data() })); renderDashboard(); }, warn('รายการเคลม'));
  onSnapshot(doc(db, 'stats', 'public'), (s) => { STATS = s.exists() ? s.data() : {}; renderStatHints(); });
  onSnapshot(doc(db, 'system', 'settings'), (s) => { const first = !Object.keys(SETTINGS).length; SETTINGS = s.exists() ? s.data() : {}; if (first) loadAdminSettings(); });
  onSnapshot(doc(db, 'system', 'promptpay_qr'), (s) => { const img = s.exists() ? s.data().image : ''; $('qr-preview').src = img || SETTINGS.promptpayQrUrl || ''; $('qr-preview').classList.toggle('hidden', !(img || SETTINGS.promptpayQrUrl)); $('qr-preview-empty').classList.toggle('hidden', !!(img || SETTINGS.promptpayQrUrl)); });
  if (!can('pay') && can('orders')) onSnapshot(query(collection(db, 'orders'), where('productType', '==', 'service')), (s) => { ORDERS = s.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => tsMs(b.createdAt) - tsMs(a.createdAt)); renderAdminOrders(); }, warn('ออเดอร์'));
}

function renderBadges() {
  const set = (id, n) => { const el = $(id); if (!el) return; el.textContent = n; el.classList.toggle('hidden', !n); };
  set('badge-orders', ORDERS.filter(o => o.status === 'pending_payment' || o.status === 'processing').length);
  set('badge-topups', TOPUPS.filter(t => t.status === 'pending').length);
  set('badge-rentals', RENTALS.filter(r => r.status === 'returned' || r.status === 'expired').length);
  renderDashboard();
}

function switchAdminTab(tab) {
  if (!tabOk(tab)) return;
  ['dashboard', 'products', 'categories', 'orders', 'topups', 'users', 'promos', 'rentals', 'boxes', 'vault', 'settings'].forEach(t => {
    $(`admin-sec-${t}`)?.classList.toggle('hidden', t !== tab);
    const b = $(`admin-tab-btn-${t}`);
    if (b) b.className = `px-4 py-1.5 rounded-button text-xs transition-all flex items-center shrink-0 ${t === tab ? 'bg-ink text-gallery' : 'text-slate hover:text-ink'}${tabOk(t) ? '' : ' hidden'}`;
  });
  sessionStorage.setItem('astraphex_admin_tab', tab);
  if (tab === 'promos') window.renderAdminPromos?.();
  if (tab === 'boxes') { window.startBoxWatch?.(); window.renderAdminBoxes?.(); }
  if (tab === 'vault') { window.startVaultWatch?.(); window.renderAdminVault?.(); }
}

// ==========================================
// PRODUCTS & STOCK
// ==========================================
function updateAdminMetrics() {
  $('metric-total-products').innerText = PRODUCTS.length;
  $('metric-instock-products').innerText = PRODUCTS.filter(p => num(p.stock) > 0).length;
  $('metric-outofstock-products').innerText = PRODUCTS.filter(p => num(p.stock) <= 0).length;
}

function renderAdminProducts(list = null) {
  const tbody = $('admin-products-table-body');
  if (!tbody) return;
  const q = ($('admin-product-search')?.value || '').toLowerCase();
  const catSel = $('admin-product-cat');
  if (catSel) { const cur = catSel.value; catSel.innerHTML = '<option value="">ทุกหมวด</option><option value="__rent">ไอดีเช่า</option>' + CATS.map(c => `<option value="${adminEsc(c.id)}">${adminEsc(c.name)}</option>`).join(''); catSel.value = [...catSel.options].some(o => o.value === cur) ? cur : ''; }
  const cf = catSel?.value || '', isRent = (p) => num(p.rentHourPrice) > 0 || (p.rentPackages || []).length > 0, ord = (p) => num(p.order) > 0 ? num(p.order) : 1e12;
  const drag = !q; // a search shows only part of the list, so reordering is switched off while it is active
  const rows = [...(list || PRODUCTS)].sort((a, b) => ord(a) - ord(b)).filter(p => (!cf || (cf === '__rent' ? isRent(p) : p.category === cf)) && (!q || String(p.name).toLowerCase().includes(q) || String(categoryOf(CATS, p.category)?.name || '').toLowerCase().includes(q) || (p.tags || []).some(t => String(t).toLowerCase().includes(q))));
  $('admin-products-empty')?.classList.toggle('hidden', rows.length > 0);
  tbody.innerHTML = rows.map(p => {
    const out = num(p.stock) <= 0;
    const id = adminEsc(JSON.stringify(p.id));
    const srv = isServiceProduct(p, CATS);
    return `<tr class="border-b border-hairline" ${drag ? `draggable="true" data-prod="${adminEsc(p.id)}" title="ลากเพื่อจัดลำดับ"` : ''}>
      <td class="py-3 px-4"><div class="flex items-center gap-2">${drag ? '<span class="grip" aria-hidden="true">⋮⋮</span>' : ''}<div class="w-14 h-10 rounded-lg overflow-hidden bg-mist border border-hairline"><img src="${adminEsc(p.image)}" alt="" class="w-full h-full object-cover" onerror="this.style.display='none'"></div></div></td>
      <td class="py-3 px-4"><div class="font-medium text-ink text-xs line-clamp-1">${p.featured ? '<span class="text-pricingBlue">★</span> ' : ''}${adminEsc(p.name)}</div><div class="text-[11px] text-slate line-clamp-1">${adminEsc(p.desc || '-')}</div></td>
      <td class="py-3 px-4"><span class="inline-block bg-mist border border-hairline px-2 py-0.5 rounded-full text-[10px] text-slate">${adminEsc(categoryOf(CATS, p.category)?.name || 'ไม่มีหมวดหมู่')}</span>
        <div class="text-[10px] text-slate mt-0.5">${srv ? `บริการ · ขั้นต่ำ ${minQtyOf(p, CATS)} ${adminEsc(unitOf(p, CATS))}` : (num(p.rentHourPrice) > 0 || (p.rentPackages || []).length) ? 'ไอดีเช่า' : 'ไอดีเกม'}</div></td>
      <td class="py-3 px-4 font-mono font-semibold">฿${money(p.price)}</td>
      <td class="py-3 px-4 font-mono text-slate">${adminEsc(p.koen || '-')}</td>
      <td class="py-3 px-4">${out ? '<span class="text-launchOrange font-semibold text-[11px]">หมด (0)</span>' : `<span class="text-emerald-600 font-semibold text-[11px]">${num(p.stock)} ${srv ? adminEsc(unitOf(p, CATS)) : 'ชิ้น'}</span>`}</td>
      <td class="py-3 px-4 text-right whitespace-nowrap">
        <button onclick='toggleFeatured(${id})' title="แสดงเป็นพิเศษหน้าแรก" class="apple-explore-pill px-2.5 py-1 text-[11px] ${p.featured ? 'text-pricingBlue border-pricingBlue' : ''}">${p.featured ? '★ แนะนำ' : '☆ แนะนำ'}</button>
        ${srv ? '' : `<button onclick='openStockModal(${id})' class="apple-pricing-pill px-3 py-1 text-[11px]">สต็อก ${num(p.stock)}</button>`}
        <button onclick='openProductModal(${id})' class="apple-explore-pill px-2.5 py-1 text-[11px]">แก้ไข</button>
        <button onclick='duplicateProduct(${id})' title="คัดลอกเป็นสินค้าใหม่" class="apple-explore-pill px-2.5 py-1 text-[11px]">คัดลอก</button>
        ${p.unlisted ? `<button onclick='copyProductLink(${id})' title="คัดลอกลิงก์ลับ" class="apple-explore-pill px-2.5 py-1 text-[11px]">🔒 ลิงก์</button>` : ''}
        <button onclick='deleteAdminProduct(${id})' class="apple-explore-pill px-2.5 py-1 text-[11px] text-red-500 border-red-200">ลบ</button>
      </td></tr>`;
  }).join('');
}
const filterAdminProducts = () => renderAdminProducts();

async function toggleFeatured(id) {
  const p = PRODUCTS.find(x => x.id === id); if (!p) return;
  try { await updateDoc(doc(db, 'products', id), { featured: !p.featured }); triggerToast(p.featured ? 'นำออกจากสินค้าแนะนำแล้ว' : 'ตั้งเป็นสินค้าแนะนำแล้ว', 'success'); }
  catch (e) { triggerToast('บันทึกไม่สำเร็จ', 'error'); }
}

function setProductType(type) {
  $('prod-type').value = type === 'service' ? 'service' : 'account';
  const cur = categoryOf(CATS, $('prod-category').value);
  if (cur && cur.kind !== $('prod-type').value) {
    const first = CATS.find(c => c.kind === $('prod-type').value);
    $('prod-category').value = first ? first.id : '';
  }
  applyTypeUi();
}
function handleCategoryChange(catId) {
  const cat = categoryOf(CATS, catId);
  if (cat) $('prod-type').value = cat.kind === 'service' ? 'service' : 'account';
  applyTypeUi();
  renderSpecFields();
}
/** Ready-made spec boxes from the category's specFields. Idempotent: every value (typed box or free line) is folded back into one list of lines, then the lines that start with a field name move into its box. */
function renderSpecFields() {
  const box = $('spec-fields'), area = $('prod-specs'); if (!box || !area) return;
  const labels = categoryOf(CATS, $('prod-category').value)?.specFields || [];
  const lines = [...[...box.querySelectorAll('input')].filter(i => i.value.trim()).map(i => `${i.dataset.f}: ${i.value.trim()}`), ...area.value.split('\n').map(s => s.trim()).filter(Boolean)];
  const own = {}; for (const l of labels) { const i = lines.findIndex(t => t.toLowerCase().startsWith(l.toLowerCase() + ':') || t.toLowerCase().startsWith(l.toLowerCase() + '：')); if (i >= 0) own[l] = lines.splice(i, 1)[0].replace(/^[^:：]*[:：]\s*/, ''); }
  area.value = lines.join('\n');
  box.innerHTML = labels.map(l => `<label class="text-[11px] text-slate">${adminEsc(l)}<input data-f="${adminEsc(l)}" value="${adminEsc(own[l] || '')}" class="w-full apple-input px-3 py-2 text-xs mt-1"></label>`).join('');
  if ($('prod-type').value !== 'service') area.required = !labels.length; // all specs may live in the boxes
}
const specLines = () => [...[...$('spec-fields').querySelectorAll('input')].filter(i => i.value.trim()).map(i => `${i.dataset.f}: ${i.value.trim()}`), ...$('prod-specs').value.split('\n').map(s => s.trim()).filter(Boolean)];
function applyTypeUi() {
  const srv = $('prod-type').value === 'service';
  const on = 'flex-1 py-1.5 px-3 rounded-xl text-xs font-medium transition-all bg-gallery text-ink shadow-sm border border-hairline/50 flex items-center justify-center gap-1.5';
  const off = 'flex-1 py-1.5 px-3 rounded-xl text-xs font-medium transition-all text-slate hover:text-ink flex items-center justify-center gap-1.5';
  $('btn-type-account').className = srv ? off : on;
  $('btn-type-service').className = srv ? on : off;
  $('service-config-box')?.classList.toggle('hidden', !srv);
  const ammo = !srv && $('prod-ammo-on')?.checked;
  $('ammo-config-box')?.classList.toggle('hidden', srv);
  $('ammo-fields')?.classList.toggle('hidden', !ammo);
  if (ammo) ammoPreview();
  $('rent-config-box')?.classList.toggle('hidden', srv || ammo);
  $('promo-config-box')?.classList.toggle('hidden', ammo);
  $('bundle-fields')?.classList.toggle('hidden', srv);
  $('rent-fields')?.classList.toggle('hidden', !$('prod-rent-on')?.checked);
  $('lbl-prod-stock').textContent = srv ? 'จำนวนที่รับงานได้ (หน่วย):' : 'จำนวนสต็อก (ชิ้น):';
  $('hint-prod-stock').textContent = srv ? 'จำนวนงานที่รับได้ ระบบลดให้อัตโนมัติเมื่อมีออเดอร์' : 'ไอดีเกม: กดปุ่ม "สต็อก" ในตารางเพื่อเพิ่มไอดีจริง ระบบนับให้เอง (แก้ตรงนี้ไม่ได้)';
  // ID products: the count comes from the real stock_items, so typing a number here would only make the shop lie.
  $('prod-stock').readOnly = !srv;
  $('prod-stock').classList.toggle('opacity-60', !srv);
  // Koen value / equipment list / description only make sense for ID products; a service must not be forced to fill them.
  ['prod-koen', 'prod-specs', 'prod-desc'].forEach(id => { $(id).required = !srv; });
  if (srv) {
    const cat = categoryOf(CATS, $('prod-category').value);
    $('prod-service-unit').placeholder = cat?.unit || 'กอง';
    $('prod-service-min').placeholder = `ใช้ค่าของหมวด (${cat?.minQty || 1})`;
    updateServiceSummary();
  }
}
function setKoenLabelPreset(label) { $('prod-koen-label').value = label; }
function updateServiceSummary() {
  const cat = categoryOf(CATS, $('prod-category').value);
  const unit = $('prod-service-unit').value.trim() || cat?.unit || 'กอง';
  const min = Math.floor(num($('prod-service-min').value)) || cat?.minQty || 1;
  const pill = $('service-summary-pill');
  if (pill) pill.innerText = `ราคา ${money($('prod-service-rate').value)}฿ / ${unit} (ขั้นต่ำ ${min} ${unit})`;
}
function syncServiceRateToPrice(v) { $('prod-price').value = v; updateServiceSummary(); }
function setServiceUnitPreset(u) { $('prod-service-unit').value = u; updateServiceSummary(); }
const SERVICE_TEMPLATES = { m61: ['กอง', 22, 15], koen_m: ['M', 25, 5], farm: ['รอบ', 150, 1] };
function applyServiceTemplate(k) { const [u, r, m] = SERVICE_TEMPLATES[k] || []; if (!u) return; $('prod-service-unit').value = u; $('prod-service-rate').value = r; $('prod-service-min').value = m; syncServiceRateToPrice(r); }
const PRESET_IMAGES = {
  m4a1: 'https://images.unsplash.com/photo-1595590424283-b8f1784cb2c8?auto=format&fit=crop&q=80&w=800',
  koen: 'https://images.unsplash.com/photo-1612287230202-1ff1d85d1bdf?auto=format&fit=crop&q=80&w=800',
  sniper: 'https://images.unsplash.com/photo-1585098906517-8e1008d58544?auto=format&fit=crop&q=80&w=800',
  fal: 'https://images.unsplash.com/photo-1550985542-f28329b3a364?auto=format&fit=crop&q=80&w=800',
  wealth: 'https://images.unsplash.com/photo-1633158829585-23ba8f7c8caf?auto=format&fit=crop&q=80&w=800',
  smg: 'https://images.unsplash.com/photo-1574226516831-e1dff420e5c7?auto=format&fit=crop&q=80&w=800'
};
function setImagePreset(k) { if (PRESET_IMAGES[k]) { $('prod-image').value = PRESET_IMAGES[k]; updateImagePreview(PRESET_IMAGES[k]); } }
function updateImagePreview(url) { const el = $('image-preview-element'); if (el) el.src = formatUrl(url) || 'https://placehold.co/800x500/f5f5f7/86868b?text=Preview'; }

function fillProductCategorySelect() {
  const sel = $('prod-category'); if (!sel) return;
  const keep = sel.value;
  sel.innerHTML = '<option value="">— ไม่มีหมวดหมู่ —</option>' + ['account', 'service'].map(kind => {
    const opts = CATS.filter(c => c.kind === kind).map(c => `<option value="${adminEsc(c.id)}">${adminEsc(c.name)}</option>`).join('');
    return opts ? `<optgroup label="${adminEsc(KIND_LABEL[kind])}">${opts}</optgroup>` : '';
  }).join('');
  sel.value = [...sel.options].some(o => o.value === keep) ? keep : '';
}

const msToLocal = (ms) => ms ? new Date(num(ms) - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 16) : '';
const localToMs = (v) => v ? new Date(v).getTime() : 0;
/** "500 0.1" / "1000 5%" per line -> [{ min, type, value }]; null when a line is wrong */
function parseAmmoTiers(text, rate) {
  const out = [];
  for (const line of text.split('\n').map(l => l.trim()).filter(Boolean)) {
    const m = line.match(/^(\d+)\s+(\d+(?:\.\d+)?)\s*(%?)$/); if (!m) return null;
    const [min, value, pct] = [Number(m[1]), Number(m[2]), m[3] === '%'];
    if (!(min > 0) || !(value > 0) || (pct ? value >= 100 : value >= rate)) return null;
    out.push({ min, type: pct ? 'percent' : 'fixed', value });
  }
  return out.sort((a, b) => a.min - b.min);
}
/** Live "what will the customer pay" lines under the ammo discount fields (windows ignored: shows the price while the discount is live). */
document.addEventListener('input', (e) => { if (e.target.closest?.('#ammo-fields')) ammoPreview(); });
function ammoPreview() {
  const out = $('ammo-preview'); if (!out) return;
  const v = (id) => $(id)?.value ?? '', rate = Number(v('prod-ammo-rate')) || 0;
  if (!(rate > 0)) { out.textContent = 'ใส่ราคาต่อกองเพื่อดูตัวอย่าง'; return; }
  const tiers = parseAmmoTiers(v('prod-ammo-tiers'), rate);
  const p = { ammoRate: rate, ammoDiscType: v('prod-ammo-disc-type'), ammoDiscValue: Number(v('prod-ammo-disc')) || 0, ammoTiers: tiers || [] };
  const mins = [...new Set([Number(v('prod-ammo-min')) || 1, ...p.ammoTiers.map(t => t.min)])].sort((a, b) => a - b);
  out.innerHTML = (tiers ? '' : '<span class="text-red-500">ตารางขั้นจำนวนกองผิดรูปแบบ · </span>') + mins.map(q => { const r = ammoRateOf(p, q); return `${q} กอง → ฿${money(r)}/กอง = <b class="text-ink">฿${money(r * q)}</b>${r < rate ? ` <span class="text-launchOrange">(ลด ฿${money((rate - r) * q)})</span>` : ''}`; }).join('<br>');
}
function openProductModal(productId = null) {
  fillProductCategorySelect();
  $('prod-bundle-id').innerHTML = '<option value="">— ไม่แถม —</option>' + PRODUCTS.filter(x => x.isAmmo === true).map(x => `<option value="${adminEsc(x.id)}">${adminEsc(x.name)}</option>`).join('');
  const p = productId ? PRODUCTS.find(x => x.id === productId) : null;
  $('product-crud-form').reset(); $('spec-fields').innerHTML = ''; // boxes from the previous product must not leak into this one
  $('product-modal-heading').innerText = p ? 'แก้ไขสินค้า: ' + p.name : 'เพิ่มสินค้าใหม่';
  $('prod-edit-id').value = p?.id || '';
  $('prod-adv').open = !!p;
  if (!p && !can('price')) return triggerToast('ไม่มีสิทธิ์ตั้งราคาสินค้าใหม่', 'error');
  ['prod-price', 'prod-sale-price', 'prod-ammo-rate'].forEach(id => { const el = $(id); if (el) el.disabled = !can('price'); });
  $('prod-cost')?.closest('div')?.classList.toggle('hidden', !can('profit'));
  if (p) {
    const set = (id, v) => { $(id).value = v ?? ''; };
    set('prod-name', p.name); set('prod-koen', p.koen); set('prod-koen-label', p.koenLabel); set('prod-price', p.saleOn ? p.basePrice : p.price); set('prod-stock', p.stock ?? 0);
    set('prod-image', p.image); set('prod-gallery', (p.gallery || []).join('\n')); set('prod-tags', (p.tags || []).join(', '));
    set('prod-desc', p.desc); set('prod-specs', (p.specs || []).join('\n'));
    const fm = Object.fromEntries((p.farmModes || []).map(m => [m.key, m.price]));
    set('prod-farm-id', fm.with_id); set('prod-farm-self', fm.self);
    set('prod-packages', (p.packages || []).map(k => `${k.qty} ${k.bonus || 0}`).join('\n'));
    set('prod-hours', p.serviceHours); set('prod-hours-open', p.hoursOpen); set('prod-hours-close', p.hoursClose);
    set('prod-info', p.infoLines); set('prod-howto', p.howTo); set('prod-warranty', p.warrantyText);
    set('prod-service-unit', p.serviceUnit); set('prod-service-min', p.serviceMin); set('prod-service-rate', p.serviceRate || p.price);
    $('prod-category').value = categoryOf(CATS, p.category) ? p.category : '';
    $('prod-featured').checked = p.featured === true;
    $('prod-rent-on').checked = num(p.rentHourPrice) > 0 || (p.rentPackages || []).length > 0;
    $('prod-ammo-on').checked = p.isAmmo === true; set('prod-ammo-rate', p.ammoRate); set('prod-ammo-min', p.ammoMin); set('prod-ammo-disc-type', p.ammoDiscType || 'fixed'); set('prod-ammo-disc', p.ammoDiscValue); set('prod-ammo-disc-from', msToLocal(p.ammoDiscFrom)); set('prod-ammo-disc-to', msToLocal(p.ammoDiscTo)); set('prod-ammo-maxids', p.ammoMaxIds); set('prod-ammo-low', p.ammoLowStock); set('prod-ammo-tiers-from', msToLocal(p.ammoTiersFrom)); set('prod-ammo-tiers-to', msToLocal(p.ammoTiersTo)); set('prod-ammo-tiers', (p.ammoTiers || []).map(t => `${t.min} ${t.value}${t.type === 'percent' ? '%' : ''}`).join('\n')); $('prod-ammo-login').checked = p.requireLogin !== false;
    set('prod-rent-rate', p.rentHourPrice); set('prod-rent-min', p.rentMinHours); set('prod-rent-deposit', p.rentDeposit);
    set('prod-rent-packages', (p.rentPackages || []).map(k => `${k.hours} ${k.price}`).join('\n'));
    set('prod-sale-price', p.salePrice); set('prod-sale-from', msToLocal(p.saleFrom)); set('prod-sale-to', msToLocal(p.saleTo));
    set('prod-variant-group', p.variantGroup); set('prod-variant-label', p.variantLabel);
    set('prod-drop-at', msToLocal(p.dropAt)); set('prod-cost', p.cost); set('prod-hide-at', msToLocal(p.hideAt)); $('prod-unlisted').checked = p.unlisted === true;
    set('prod-bundle-id', p.bundleAmmoId); set('prod-bundle-n', p.bundleAmmo);
    $('prod-type').value = isServiceProduct(p, CATS) ? 'service' : 'account';
  } else {
    $('prod-stock').value = 0;
    $('prod-featured').checked = false;
    $('prod-rent-on').checked = false;
    $('prod-ammo-on').checked = false; $('prod-ammo-login').checked = true;
    $('prod-type').value = categoryOf(CATS, $('prod-category').value)?.kind === 'service' ? 'service' : 'account';
  }
  updateImagePreview(p?.image || '');
  applyTypeUi(); renderSpecFields();
  $('product-form-modal').classList.remove('hidden'); $('product-form-modal').classList.add('flex');
}
function closeProductModal() { $('product-form-modal').classList.add('hidden'); $('product-form-modal').classList.remove('flex'); }

/** Append-only trail of admin changes (firestore.rules: create only, read admin). Shown in ตั้งค่า › ประวัติการแก้ไข. */
const audit = (action, target, detail = '') => setDoc(doc(collection(db, 'audit_logs')), { at: serverTimestamp(), by: me?.email || me?.uid || '', action, target: String(target || '').slice(0, 120), detail: String(detail).slice(0, 600) }).catch(e => console.warn('audit:', e));
const AUDIT_FIELDS = ['name', 'price', 'category', 'active', 'isAmmo', 'ammoRate', 'ammoMin', 'ammoMaxIds', 'ammoLowStock', 'ammoDiscType', 'ammoDiscValue', 'ammoDiscFrom', 'ammoDiscTo', 'ammoTiers', 'ammoTiersFrom', 'ammoTiersTo', 'requireLogin'];
const auditVal = (v) => v?._methodName === 'deleteField' || v == null || v === '' ? '-' : JSON.stringify(v);
let AUDIT = [];
async function loadAudit() {
  const box = $('audit-list'); box.innerHTML = '<p class="text-slate">กำลังโหลด…</p>';
  try {
    AUDIT = (await getDocs(query(collection(db, 'audit_logs'), orderBy('at', 'desc'), limit(500)))).docs.map(d => d.data());
    renderAudit();
  } catch (e) { console.warn(e); box.innerHTML = '<p class="text-red-500">โหลดไม่สำเร็จ (ตรวจว่า Publish firestore.rules ใหม่แล้ว)</p>'; }
}
/** The loaded audit rows after the actor / text / date filters (dates are Thai-local days, inclusive). */
function auditFiltered() {
  const v = (id) => ($(id)?.value || '').trim().toLowerCase(), by = v('audit-by'), q = v('audit-q');
  const from = $('audit-from')?.value ? new Date($('audit-from').value + 'T00:00:00').getTime() : 0, to = $('audit-to')?.value ? new Date($('audit-to').value + 'T23:59:59').getTime() : Infinity;
  return AUDIT.filter(r => { const t = tsMs(r.at); return t >= from && t <= to && (!by || String(r.by).toLowerCase().includes(by)) && (!q || `${r.action} ${r.target} ${r.detail}`.toLowerCase().includes(q)); });
}
function renderAudit() {
  const box = $('audit-list'), rows = auditFiltered();
  $('audit-count').textContent = `${rows.length}/${AUDIT.length} รายการ`;
  box.innerHTML = rows.length ? rows.slice(0, 200).map(r => `<div class="rounded-xl bg-mist px-3 py-2"><p><b>${adminEsc(r.action)}</b> ${adminEsc(r.target)} <span class="text-slate">· ${adminEsc(r.by)} · ${adminEsc(fmtDate(r.at))}</span></p>${r.detail ? `<p class="text-slate break-words">${adminEsc(r.detail)}</p>` : ''}</div>`).join('') + (rows.length > 200 ? '<p class="text-slate">แสดง 200 รายการแรก — ส่งออก CSV เพื่อดูทั้งหมด</p>' : '') : '<p class="text-slate">ไม่พบรายการ</p>';
}
function exportAuditCsv() {
  const rows = [['เวลา', 'ผู้ทำ', 'การกระทำ', 'เป้าหมาย', 'รายละเอียด'], ...auditFiltered().map(r => [fmtDate(r.at), r.by, r.action, r.target, r.detail])];
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob(['\ufeff' + rows.map(r => r.map(csvCell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' })), download: `audit-${new Date().toISOString().slice(0, 10)}.csv` });
  a.click(); URL.revokeObjectURL(a.href);
}
/** Everything needed to rebuild the shop: categories, settings, products and ALL their stock rows (IDs + passwords). */
async function exportBackup() {
  if (!ADMIN) return;
  if (!confirm('ไฟล์สำรองมีไอดีและรหัสผ่านของสต็อกทั้งหมด เก็บให้ปลอดภัยและอย่าส่งต่อ ดำเนินการต่อหรือไม่?')) return;
  try {
    const products = [];
    for (const p of PRODUCTS) products.push({ ...p, stock_items: (await getDocs(collection(db, 'products', p.id, 'stock_items'))).docs.map(d => ({ id: d.id, ...d.data() })) });
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), categories: CATS, settings: SETTINGS, products }, null, 1)], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `astraphex-backup-${new Date().toISOString().slice(0, 10)}.json` });
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    audit('ส่งออกข้อมูลสำรอง', '', `${products.length} สินค้า`);
  } catch (e) { console.warn(e); triggerToast('ส่งออกไม่สำเร็จ', 'error'); }
}
async function handleProductFormSubmit(e) {
  e.preventDefault();
  const editId = $('prod-edit-id').value.trim();
  const category = $('prod-category').value;
  const isSrv = $('prod-type').value === 'service';
  const ammoOn = !isSrv && $('prod-ammo-on').checked, ammoRate = num($('prod-ammo-rate').value);
  if (ammoOn && !(ammoRate > 0)) return triggerToast('ใส่ราคาต่อกอง', 'error');
  const discType = $('prod-ammo-disc-type').value === 'percent' ? 'percent' : 'fixed', disc = ammoOn ? num($('prod-ammo-disc').value) : 0;
  if (disc < 0 || (discType === 'percent' ? disc >= 100 : disc >= ammoRate) && disc > 0) return triggerToast(discType === 'percent' ? 'ส่วนลด % ต้องน้อยกว่า 100' : 'ส่วนลดบาทต้องน้อยกว่าราคาต่อกอง', 'error');
  const dFrom = ammoOn && disc > 0 ? localToMs($('prod-ammo-disc-from').value) : 0, dTo = ammoOn && disc > 0 ? localToMs($('prod-ammo-disc-to').value) : 0;
  if (dFrom && dTo && dTo <= dFrom) return triggerToast('เวลาสิ้นสุดส่วนลดต้องอยู่หลังเวลาเริ่ม', 'error');
  const tiers = ammoOn ? parseAmmoTiers($('prod-ammo-tiers').value, ammoRate) : [];
  const tFrom = tiers?.length ? localToMs($('prod-ammo-tiers-from').value) : 0, tTo = tiers?.length ? localToMs($('prod-ammo-tiers-to').value) : 0;
  if (tFrom && tTo && tTo <= tFrom) return triggerToast('เวลาสิ้นสุดขั้นจำนวนกองต้องอยู่หลังเวลาเริ่ม', 'error');
  if (!tiers) return triggerToast('ส่วนลดตามจำนวนกอง: ใส่บรรทัดละ "จำนวนกอง ค่าลด" (ลดบาทต้องน้อยกว่าราคาต่อกอง · % ต้องน้อยกว่า 100)', 'error');
  const rentOn = !isSrv && !ammoOn && $('prod-rent-on').checked;
  const rentRate = rentOn ? num($('prod-rent-rate').value) : 0;
  const rentPackages = rentOn ? $('prod-rent-packages').value.split('\n').map(l => l.trim().split(/[\s,]+/).map(Number)).filter(r => r[0] >= 1 && r[1] > 0).map(r => ({ hours: Math.floor(r[0]), price: r[1] })) : [];
  if (rentOn && !(rentRate > 0) && !rentPackages.length) return triggerToast('ใส่ราคา/ชั่วโมง หรือแพ็กเกจเช่าอย่างน้อย 1 อย่าง', 'error');
  const price = ammoOn ? ammoRate : rentOn ? (rentRate || Math.min(...rentPackages.map(k => k.price))) : (num($(isSrv ? 'prod-service-rate' : 'prod-price').value) || num($('prod-price').value));
  const image = formatUrl($('prod-image').value);
  const galleryText = $('prod-gallery').value.trim();
  const packages = $('prod-packages').value.split('\n').map(l => l.trim().split(/[\s,]+/).map(Number)).filter(r => r[0] >= 1).map(r => ({ qty: Math.floor(r[0]), bonus: Math.max(0, Math.floor(r[1]) || 0) }));
  const opt = (id) => $(id).value.trim() || deleteField();
  const fId = num($('prod-farm-id').value), fSelf = num($('prod-farm-self').value);
  const farmModes = isSrv && fId > 0 && fSelf > 0 ? [{ key: 'with_id', label: 'ให้ไอดีไปยืน', price: fId }, { key: 'self', label: 'ไปยืนเอง', price: fSelf }] : null;
  if (!(price > 0) && !farmModes) return triggerToast('กรุณาใส่ราคา', 'error');
  const id = editId || 'prod_' + Date.now().toString(36);
  const salePrice = num($('prod-sale-price')?.value), sFrom = localToMs($('prod-sale-from')?.value), sTo = localToMs($('prod-sale-to')?.value), baseP = farmModes ? Math.min(fId, fSelf) : price;
  const saleOk = !ammoOn && salePrice > 0 && salePrice < baseP && (!sFrom || !sTo || sTo > sFrom);
  const saleLive = saleOk && (!sFrom || Date.now() >= sFrom) && (!sTo || Date.now() <= sTo);
  const bundleN = Math.floor(num($('prod-bundle-n')?.value)), bundleOn = !isSrv && !ammoOn && !!$('prod-bundle-id')?.value && bundleN > 0;
  const payload = {
    id, name: $('prod-name').value.trim(), category: category || deleteField(), koen: $('prod-koen').value.trim(), koenLabel: opt('prod-koen-label'),
    price: saleLive ? salePrice : farmModes ? Math.min(fId, fSelf) : price, image,
    salePrice: saleOk ? salePrice : deleteField(), saleFrom: saleOk && sFrom ? sFrom : deleteField(), saleTo: saleOk && sTo ? sTo : deleteField(),
    basePrice: saleLive ? (farmModes ? Math.min(fId, fSelf) : price) : deleteField(), saleOn: saleLive ? true : deleteField(),
    variantGroup: $('prod-variant-group').value.trim() || deleteField(), variantLabel: $('prod-variant-label').value.trim() || deleteField(),
    ...(can('profit') ? { cost: num($('prod-cost').value) > 0 ? num($('prod-cost').value) : deleteField() } : {}),
    hideAt: localToMs($('prod-hide-at').value) > Date.now() ? localToMs($('prod-hide-at').value) : deleteField(),
    unlisted: $('prod-unlisted').checked || deleteField(),
    dropAt: !isSrv && localToMs($('prod-drop-at')?.value) > Date.now() ? localToMs($('prod-drop-at').value) : deleteField(),
    bundleAmmoId: bundleOn ? $('prod-bundle-id').value : deleteField(), bundleAmmo: bundleOn ? bundleN : deleteField(),
    // service: free number (capacity). ID product: never typed, counted from stock_items (new = 0, edit = untouched)
    ...(isSrv ? { stock: Math.max(0, parseInt($('prod-stock').value, 10) || 0) } : editId ? {} : { stock: 0 }),
    gallery: galleryText ? galleryText.split('\n').map(s => formatUrl(s)).filter(Boolean) : (image ? [image] : []),
    tags: $('prod-tags').value.split(',').map(s => s.trim()).filter(Boolean), desc: $('prod-desc').value.trim(),
    specs: specLines(),
    productType: isSrv ? 'service' : 'account', featured: $('prod-featured').checked,
    serviceUnit: isSrv && $('prod-service-unit').value.trim() ? $('prod-service-unit').value.trim() : deleteField(),
    serviceMin: isSrv && Math.floor(num($('prod-service-min').value)) > 0 ? Math.floor(num($('prod-service-min').value)) : deleteField(),
    serviceRate: deleteField(),
    isAmmo: ammoOn || deleteField(), ammoRate: ammoOn ? ammoRate : deleteField(),
    ammoDiscType: disc > 0 ? discType : deleteField(), ammoDiscValue: disc > 0 ? disc : deleteField(),
    ammoMaxIds: ammoOn && Math.floor(num($('prod-ammo-maxids').value)) > 0 ? Math.min(100, Math.floor(num($('prod-ammo-maxids').value))) : deleteField(),
    ammoLowStock: ammoOn && Math.floor(num($('prod-ammo-low').value)) > 0 ? Math.floor(num($('prod-ammo-low').value)) : deleteField(),
    ammoDiscFrom: dFrom || deleteField(), ammoDiscTo: dTo || deleteField(), ammoTiers: tiers.length ? tiers : deleteField(), ammoTiersFrom: tFrom || deleteField(), ammoTiersTo: tTo || deleteField(),
    ammoMin: ammoOn && Math.floor(num($('prod-ammo-min').value)) > 1 ? Math.floor(num($('prod-ammo-min').value)) : deleteField(),
    requireLogin: ammoOn && !$('prod-ammo-login').checked ? false : deleteField(),
    rentHourPrice: rentRate > 0 ? rentRate : deleteField(),
    rentMinHours: rentOn && Math.floor(num($('prod-rent-min').value)) > 1 ? Math.floor(num($('prod-rent-min').value)) : deleteField(),
    rentDeposit: rentOn && num($('prod-rent-deposit').value) > 0 ? num($('prod-rent-deposit').value) : deleteField(),
    rentPackages: rentPackages.length ? rentPackages : deleteField(),
    packages: packages.length ? packages : deleteField(), farmModes: farmModes || deleteField(),
    serviceHours: opt('prod-hours'), hoursOpen: opt('prod-hours-open'), hoursClose: opt('prod-hours-close'),
    infoLines: opt('prod-info'), howTo: opt('prod-howto'), warrantyText: opt('prod-warranty'),
    updatedAt: serverTimestamp(), ...(editId ? {} : { createdAt: serverTimestamp() })
  };
  const old = PRODUCTS.find(x => x.id === id);
  const oldBase = num(old?.basePrice) || num(old?.price);
  if (!isSrv && !ammoOn && !rentOn && price > 0 && price !== oldBase) payload.priceHist = [...(Array.isArray(old?.priceHist) ? old.priceHist : oldBase ? [{ t: tsMs(old.createdAt) || Date.now() - 864e5, p: oldBase }] : []), { t: Date.now(), p: price }].slice(-30); // shown as the price chart on the product page
  const diff = old ? AUDIT_FIELDS.filter(k => k in payload && auditVal(payload[k]) !== auditVal(old[k])).map(k => `${k}: ${auditVal(old[k])} → ${auditVal(payload[k])}`).join('; ') : 'สร้างสินค้าใหม่';
  try { await setDoc(doc(db, 'products', id), payload, { merge: true }); if (diff) audit(old ? 'แก้สินค้า' : 'สร้างสินค้า', payload.name, diff); triggerToast('บันทึกสินค้าแล้ว', 'success'); closeProductModal(); }
  catch (err) { console.warn(err); triggerToast('บันทึกสินค้าไม่สำเร็จ', 'error'); }
}
async function deleteAdminProduct(id) {
  if (!confirm('ลบสินค้านี้? (ไอดีที่ยังไม่ขายในสต็อกจะเข้าถึงไม่ได้)')) return;
  try { await deleteDoc(doc(db, 'products', id)); audit('ลบสินค้า', PRODUCTS.find(x => x.id === id)?.name || id); triggerToast('ลบสินค้าแล้ว', 'success'); } catch (e) { triggerToast('ลบไม่สำเร็จ', 'error'); }
}
function openStockModalQuick() { const p = PRODUCTS.find(x => !isServiceProduct(x, CATS)); p ? openStockModal(p.id) : triggerToast('ยังไม่มีสินค้าประเภทไอดีเกม', 'error'); }

// ---- bulk stock ----
let SHELF = { at: 0, byPid: new Map() }, STOCK_ITEMS = [];
let currentStockProductId = null, parsedStockItems = [], stockExisting = new Set(), stockOther = new Map(); // usernames already on the shelf (available / reserved) of the open product
const stockIsAmmo = () => PRODUCTS.find(x => x.id === currentStockProductId)?.isAmmo === true;
function parseStockLines(text, ammo = stockIsAmmo()) {
  const items = [], seen = new Set(); let dup = false, bad = 0, inDb = 0, inOther = 0;
  text.split('\n').map(l => l.trim()).filter(Boolean).forEach(line => {
    let u, p, a = 0;
    if (ammo) { // email|pass|ammo (also ":" or spaces between the three parts)
      const m = line.match(/^(\S+?)\s*[|:\s]\s*(\S+)\s*[|:\s]\s*(\d{1,6})$/);
      if (!m || !(Number(m[3]) > 0)) { bad++; return; }
      [u, p, a] = [m[1], m[2], Number(m[3])];
    } else {
      const m = line.match(/^(?:email|user|username)\s+(\S+)\s+(?:password|pass|pwd)\s+(.+)$/i) || line.match(/^([^:\s|]+)\s*[:|]\s*(.+)$/) || line.match(/^(\S+)\s+(\S+)$/);
      if (!m) { bad++; return; }
      [u, p] = [m[1].trim(), m[2].trim()];
    }
    if (seen.has(u.toLowerCase())) { dup = true; return; }
    if (stockExisting.has(u.toLowerCase())) { inDb++; return; }
    if (stockOther.has(u.toLowerCase())) { inOther++; return; }
    seen.add(u.toLowerCase()); items.push(ammo ? { username: u, password: p, ammo: a } : { username: u, password: p });
  });
  return { items, hasDuplicates: dup, bad, inDb, inOther };
}
function handleStockTextareaInput(val) {
  const { items, hasDuplicates, bad, inDb, inOther } = parseStockLines(val);
  parsedStockItems = items;
  const ammo = items.reduce((t, it) => t + (it.ammo || 0), 0);
  $('stock-parsed-counter').textContent = `ตรวจพบ: ${items.length} รายการพร้อมนำเข้า${stockIsAmmo() ? ` · รวม ${ammo.toLocaleString('th-TH')} กอง` : ''}${bad ? ` · ${bad} บรรทัดอ่านไม่ได้ (ข้าม)` : ''}${inDb ? ` · ${inDb} ไอดีซ้ำกับในคลัง (ข้าม)` : ''}${inOther ? ` · ${inOther} ไอดีซ้ำกับสินค้าอื่น (ข้าม)` : ''}`;
  $('btn-add-stock-label').textContent = `บันทึกและนำเข้าสต็อก (${items.length} ชิ้น)`;
  $('stock-duplicate-warning').classList.toggle('hidden', !hasDuplicates);
}
/** Every ID still on a shelf (available / reserved), per product. One query per product, cached 2 minutes; force = fresh read. */
async function scanShelf(force = false) {
  if (!force && Date.now() - SHELF.at < 12e4) return SHELF.byPid;
  const byPid = new Map();
  await Promise.all(PRODUCTS.filter(p => !isServiceProduct(p, CATS)).map(async p => {
    const rows = (await getDocs(query(collection(db, 'products', p.id, 'stock_items'), where('status', 'in', ['available', 'reserved'])))).docs.map(d => ({ id: d.id, ...d.data() }));
    byPid.set(p.id, rows);
  }));
  SHELF = { at: Date.now(), byPid };
  return byPid;
}
/** What the product's stock number should be, by the same rule the stock modal uses. */
const realStock = (p, rows) => p.isAmmo === true ? rows.reduce((t, r) => t + num(r.ammo), 0) : rows.filter(r => r.status === 'available').length;
function otherShelf(excludePid) {
  const m = new Map();
  for (const [pid, rows] of SHELF.byPid) if (pid !== excludePid) rows.forEach(r => { const u = String(r.username || '').toLowerCase(); if (u && !m.has(u)) m.set(u, pid); });
  return m;
}
async function checkStockAll() {
  const box = $('stock-audit'); box.classList.remove('hidden'); box.innerHTML = '<p class="text-slate text-xs">กำลังตรวจ…</p>';
  try {
    const by = await scanShelf(true), bad = PRODUCTS.filter(p => by.has(p.id)).map(p => ({ p, real: realStock(p, by.get(p.id)) })).filter(x => num(x.p.stock) !== x.real);
    window.__stockBad = bad;
    box.innerHTML = bad.length ? `<div class="flex flex-wrap items-center gap-2 mb-2"><p class="font-semibold text-sm mr-auto">สต็อกไม่ตรง ${bad.length} สินค้า</p><button type="button" onclick="fixStockAll()" class="apple-pricing-pill px-4 py-1.5 text-xs">ซ่อมทั้งหมดให้ตรงกับไอดีจริง</button></div>`
      + bad.map(({ p, real }) => `<div class="flex justify-between gap-3 rounded-xl bg-mist px-3 py-2 text-xs"><span class="truncate">${adminEsc(p.name)}</span><span class="shrink-0">แสดง ${num(p.stock)} · จริง <b>${real}</b></span></div>`).join('')
      : `<p class="text-xs text-emerald-600 font-semibold">สต็อกตรงกับไอดีจริงทุกสินค้า (${by.size} สินค้า)</p>`;
  } catch (e) { console.warn(e); box.innerHTML = '<p class="text-xs text-red-500">ตรวจไม่สำเร็จ</p>'; }
}
async function fixStockAll() {
  const bad = window.__stockBad || []; if (!bad.length) return;
  try {
    for (let i = 0; i < bad.length; i += 400) { const b = writeBatch(db); bad.slice(i, i + 400).forEach(({ p, real }) => b.update(doc(db, 'products', p.id), { stock: real })); await b.commit(); }
    audit('ซ่อมสต็อกให้ตรง', '', `${bad.length} สินค้า`); triggerToast(`ซ่อมสต็อก ${bad.length} สินค้าแล้ว`, 'success'); window.__stockBad = []; checkStockAll();
  } catch (e) { console.warn(e); triggerToast('ซ่อมไม่สำเร็จ', 'error'); }
}
function openStockModal(id) {
  currentStockProductId = id; stockExisting = new Set(); stockOther = new Map(); STOCK_ITEMS = []; $('stock-search').value = '';
  $('bulk-stock-textarea').value = ''; handleStockTextareaInput('');
  const p = PRODUCTS.find(x => x.id === id);
  $('stock-modal-prod-title').textContent = p?.name || id;
  $('stock-modal-current-count').textContent = num(p?.stock);
  $('stock-management-modal').classList.remove('hidden'); $('stock-management-modal').classList.add('flex');
  loadAvailableStockItems(id);
}
function closeStockModal() { $('stock-management-modal').classList.add('hidden'); $('stock-management-modal').classList.remove('flex'); currentStockProductId = null; }
async function submitBulkStockImport() {
  if (!currentStockProductId || !parsedStockItems.length) return triggerToast('กรุณาวางรายการไอดีอย่างน้อย 1 บรรทัด', 'error');
  const btn = $('btn-confirm-add-stock'); btn.disabled = true;
  try {
    const prodRef = doc(db, 'products', currentStockProductId);
    for (let i = 0; i < parsedStockItems.length; i += 400) {
      const chunk = parsedStockItems.slice(i, i + 400);
      const batch = writeBatch(db);
      chunk.forEach(it => batch.set(doc(collection(prodRef, 'stock_items')), { username: it.username, password: it.password, ...(it.ammo ? { ammo: it.ammo } : {}), status: 'available', addedAt: serverTimestamp(), addedBy: me?.uid || '' }));
      // ammo products count stock in กอง (sum of ammo), other ID products in IDs
      batch.update(prodRef, { stock: increment(chunk.reduce((t, it) => t + (it.ammo || 1), 0)) });
      await batch.commit();
    }
    SHELF.at = 0; audit('นำเข้าสต็อก', PRODUCTS.find(x => x.id === currentStockProductId)?.name || currentStockProductId, `${parsedStockItems.length} ไอดี`);
    triggerToast(`นำเข้าไอดี ${parsedStockItems.length} รายการแล้ว`, 'success');
    $('bulk-stock-textarea').value = ''; handleStockTextareaInput('');
    loadAvailableStockItems(currentStockProductId);
  } catch (e) { console.warn(e); triggerToast('นำเข้าไม่สำเร็จ', 'error'); }
  finally { btn.disabled = false; }
}
async function loadAvailableStockItems(id) {
  const tbody = $('stock-items-list-body'); tbody.innerHTML = '';
  const p = PRODUCTS.find(x => x.id === id), ammo = p?.isAmmo === true;
  let items = [];
  try { items = (await getDocs(query(collection(db, 'products', id, 'stock_items'), where('status', 'in', ammo ? ['available', 'reserved'] : ['available'])))).docs.map(d => ({ id: d.id, ...d.data() })); } catch (e) { console.warn(e); }
  stockExisting = new Set(items.map(it => String(it.username || '').toLowerCase()));
  handleStockTextareaInput($('bulk-stock-textarea').value);
  const real = ammo ? items.reduce((t, it) => t + num(it.ammo), 0) : items.length;
  $('stock-available-count').textContent = ammo ? `${items.length} ไอดี · ${real.toLocaleString('th-TH')} กอง` : items.length;
  $('stock-modal-current-count').textContent = real;
  $('stock-items-empty').classList.toggle('hidden', items.length > 0);
  if (p && num(p.stock) !== real && !isServiceProduct(p, CATS)) {
    triggerToast(`สต็อกที่แสดง (${num(p.stock)}) ไม่ตรงกับไอดีจริง (${real}) · ปรับให้ตรงแล้ว`);
    updateDoc(doc(db, 'products', id), { stock: real }).catch(() => {});
  }
  if (ammo) items.sort((a, b) => num(b.ammo) - num(a.ammo));
  STOCK_ITEMS = items; renderStockList();
  scanShelf().then(() => { if (currentStockProductId === id) { stockOther = otherShelf(id); handleStockTextareaInput($('bulk-stock-textarea').value); } }).catch(e => console.warn('shelf:', e));
}
/** Rows of the open product, filtered by the search box. Reserved ammo IDs (a customer is paying) cannot be selected. */
function renderStockList() {
  const ammo = stockIsAmmo(), q = $('stock-search').value.trim().toLowerCase(), id = currentStockProductId;
  const rows = STOCK_ITEMS.filter(it => !q || String(it.username).toLowerCase().includes(q));
  const held = (it) => it.status === 'reserved' && num(it.reservedUntil) > Date.now();
  $('stock-items-list-body').innerHTML = rows.map((it, i) => `<tr><td class="py-2.5 px-3 w-8">${held(it) ? '' : `<input type="checkbox" class="stock-pick" value="${adminEsc(it.id)}" onchange="syncStockPick()" aria-label="เลือก ${adminEsc(it.username)}">`}</td><td class="py-2.5 px-3 font-semibold select-all">${adminEsc(it.username)}${ammo ? ` <span class="text-slate font-normal">· ${num(it.ammo)} กอง${held(it) ? ' · <span class="text-launchOrange">ลูกค้ากำลังจ่าย</span>' : ''}</span>` : ''}</td><td class="py-2.5 px-3 text-slate">••••••••</td>
    <td class="py-2.5 px-3 text-right"><button onclick='deleteSingleStockItem(${adminEsc(JSON.stringify(id))}, ${adminEsc(JSON.stringify(it.id))}, ${ammo ? num(it.ammo) : 1})' class="text-red-500 text-[11px] hover:underline">ลบออก</button></td></tr>`).join('');
  $('stock-items-empty').classList.toggle('hidden', rows.length > 0);
  $('stock-pick-all').checked = false; syncStockPick();
}
const stockPicks = () => [...document.querySelectorAll('#stock-items-list-body .stock-pick:checked')].map(c => c.value);
function syncStockPick() { const n = stockPicks().length; $('stock-del-picked').textContent = `ลบที่เลือก (${n})`; $('stock-del-picked').disabled = !n; }
function toggleStockPickAll(on) { document.querySelectorAll('#stock-items-list-body .stock-pick').forEach(c => { c.checked = on; }); syncStockPick(); }
/** Delete the given stock rows of the open product and take their count off the product's stock number (chunks of 400 writes). */
async function removeStockRows(rows, what) {
  const pid = currentStockProductId, ammo = stockIsAmmo(); if (!pid || !rows.length) return;
  try {
    for (let i = 0; i < rows.length; i += 399) {
      const part = rows.slice(i, i + 399), b = writeBatch(db);
      part.forEach(it => b.delete(doc(db, 'products', pid, 'stock_items', it.id)));
      b.update(doc(db, 'products', pid), { stock: increment(-part.reduce((t, it) => t + (ammo ? num(it.ammo) : 1), 0)) });
      await b.commit();
    }
    SHELF.at = 0; audit(what, PRODUCTS.find(x => x.id === pid)?.name || pid, `${rows.length} ไอดี`);
    triggerToast(`${what} ${rows.length} ไอดีแล้ว`, 'success');
    loadAvailableStockItems(pid);
  } catch (e) { console.warn(e); triggerToast('ลบไม่สำเร็จ', 'error'); }
}
const stockDeletable = () => STOCK_ITEMS.filter(it => !(it.status === 'reserved' && num(it.reservedUntil) > Date.now()));
function deleteStockPicked() { const ids = new Set(stockPicks()), rows = STOCK_ITEMS.filter(it => ids.has(it.id)); if (rows.length && confirm(`ลบไอดีที่เลือก ${rows.length} ตัวออกจากคลัง?`)) removeStockRows(rows, 'ลบไอดีที่เลือก'); }
function clearStockAll() {
  const rows = stockDeletable(), name = PRODUCTS.find(x => x.id === currentStockProductId)?.name || '';
  if (!rows.length) return triggerToast('ไม่มีไอดีให้เคลียร์', 'error');
  if ((prompt(`เคลียร์สต็อกทั้งหมดของ "${name}" (${rows.length} ไอดี) ย้อนกลับไม่ได้\nพิมพ์คำว่า เคลียร์ เพื่อยืนยัน`) || '').trim() !== 'เคลียร์') return;
  removeStockRows(rows, 'เคลียร์สต็อกทั้งหมด');
}
async function deleteSingleStockItem(pid, itemId, n = 1) {
  if (!confirm('นำไอดีนี้ออกจากคลัง?')) return;
  try {
    const b = writeBatch(db);
    b.delete(doc(db, 'products', pid, 'stock_items', itemId));
    b.update(doc(db, 'products', pid), { stock: increment(-n) });
    await b.commit();
    SHELF.at = 0; audit('ลบไอดีออกจากสต็อก', PRODUCTS.find(x => x.id === pid)?.name || pid, itemId);
    triggerToast('ลบไอดีออกจากคลังแล้ว', 'success');
    loadAvailableStockItems(pid);
  } catch (e) { triggerToast('ลบไม่สำเร็จ', 'error'); }
}

// ==========================================
// DASHBOARD (สรุปภาพรวม): computed in the browser from the lists already loaded
// ==========================================
const PAID = (o) => (o.status === 'completed' || o.status === 'processing') && o.paymentMethod !== 'prize'; // a service order is paid once it is processing; loot-box prizes are free
function renderDashboard() {
  if (!ADMIN) return;
  const cards = $('dash-cards'); if (!cards) return;
  const day0 = new Date().setHours(0, 0, 0, 0), D = 864e5;
  // shortcut: rental income is counted on the day the rental started (extensions included), fine for a summary
  const sales = [...ORDERS.filter(PAID).map(o => ({ t: tsMs(o.createdAt), v: num(o.amount), name: o.productName })), ...RENTALS.map(r => ({ t: tsMs(r.createdAt), v: num(r.price), name: r.productName })),
    ...(window.getBoxOpens?.() || []).map(b => ({ t: tsMs(b.createdAt), v: num(b.price), name: `กล่องสุ่ม ${b.boxName || ''}` }))]; // box opens: the credit paid for them
  const sum = (rows, from) => rows.filter(x => x.t >= from).reduce((a, x) => a + x.v, 0);
  const topups = TOPUPS.filter(t => t.status === 'completed').map(t => ({ t: tsMs(t.completedAt) || tsMs(t.createdAt), v: num(t.amount) }));
  const card = (label, value, sub = '') => `<div class="apple-card p-4"><p class="text-[11px] text-slate">${label}</p><p class="text-2xl font-heading font-semibold mt-1">${value}</p><p class="text-[11px] text-slate mt-0.5">${sub}</p></div>`;
  const ordersToday = ORDERS.filter(o => tsMs(o.createdAt) >= day0 && PAID(o)).length; // same rule as the sales figure: paid orders only
  const newUsers = (from) => USERS.filter(u => tsMs(u.createdAt) >= from).length;
  const credit = USERS.reduce((a, u) => a + num(u.walletBalance), 0);
  cards.innerHTML = [
    card('ยอดขายวันนี้', '฿' + money(sum(sales, day0)), `${ordersToday} ออเดอร์`),
    card('ยอดขาย 7 วัน', '฿' + money(sum(sales, day0 - 6 * D)), `เฉลี่ย ฿${money(sum(sales, day0 - 6 * D) / 7)}/วัน`),
    card('ยอดขาย 30 วัน', '฿' + money(sum(sales, day0 - 29 * D)), `ทั้งหมด ฿${money(sum(sales, 0))}`),
    card('เงินเติมเข้า 30 วัน', '฿' + money(sum(topups, day0 - 29 * D)), `วันนี้ ฿${money(sum(topups, day0))}`),
    card('ผู้ใช้ใหม่', newUsers(day0), `7 วัน ${newUsers(day0 - 6 * D)} · ทั้งหมด ${USERS.length}`),
    card('เครดิตค้างในระบบ', '฿' + money(credit), 'ยอดรวมของทุกบัญชี'),
    card('กำลังเช่า', RENTALS.filter(r => r.status === 'active' && num(r.endMs) > Date.now()).length, `รอตรวจ ${RENTALS.filter(r => r.status === 'returned' || r.status === 'expired').length}`),
    card('คิวบริการที่ค้าง', ORDERS.filter(o => o.productType === 'service' && o.status === 'processing').length, 'กำลังดำเนินการ / รอคิว')
  ].join('');
  // 14-day bars
  const days = Array.from({ length: 14 }, (_, k) => day0 - (13 - k) * D);
  const vals = days.map(d => sum(sales.filter(x => x.t < d + D), d));
  const max = Math.max(...vals, 1);
  $('dash-chart').innerHTML = days.map((d, k) => `<div class="flex-1 flex flex-col items-center justify-end h-full min-w-0" title="${new Date(d).toLocaleDateString('th-TH')} ฿${money(vals[k])}"><div class="w-full rounded-t-md ${k === 13 ? 'bg-pricingBlue' : 'bg-control'}" style="height:${Math.max(vals[k] ? 4 : 1, vals[k] / max * 100)}%"></div><span class="text-[9px] text-slate mt-1">${new Date(d).getDate()}</span></div>`).join('');
  // top products (30 days)
  const by = {};
  sales.filter(x => x.t >= day0 - 29 * D).forEach(x => { const k = String(x.name || '').replace(/\s*\(.*\)$/, ''); by[k] = by[k] || { n: 0, v: 0 }; by[k].n++; by[k].v += x.v; });
  const top = Object.entries(by).sort((a, b) => b[1].v - a[1].v).slice(0, 5);
  $('dash-top').innerHTML = top.length ? top.map(([n, x], k) => `<div class="flex justify-between gap-3"><span class="truncate">${k + 1}. ${adminEsc(n)}</span><span class="shrink-0 text-slate">${x.n} รายการ · <b class="text-ink">฿${money(x.v)}</b></span></div>`).join('') : '<p class="text-slate">ยังไม่มีข้อมูล</p>';
  // to-do
  const low = PRODUCTS.filter(p => !isServiceProduct(p, CATS) && num(p.stock) <= 3).sort((a, b) => num(a.stock) - num(b.stock));
  // "วันนี้ต้องทำ": every pending pile with its oldest item's age; piles past their SLA come first, then the oldest
  const nowMs = Date.now(), oldest = (rows, f = (x) => x.createdAt) => rows.length ? Math.min(...rows.map(x => tsMs(f(x)) || nowMs)) : nowMs;
  const piles = [ // [rows, label, tab, SLA hours, timestamp getter]
    [ORDERS.filter(o => o.status === 'pending_payment'), 'ออเดอร์รอตรวจการชำระเงิน', 'orders', 2],
    [TOPUPS.filter(t => t.status === 'pending'), 'รายการเติมเงินรอตรวจ', 'topups', 1],
    [ORDERS.filter(o => o.productType === 'service' && o.status === 'processing'), 'งานบริการที่ยังไม่ส่งมอบ', 'orders', 24],
    [ACLAIMS, 'คำขอเคลมไอดีไก่กระสุน (แผงด้านล่าง)', 'dashboard', 12],
    [RENTALS.filter(r => r.status === 'returned' || r.status === 'expired'), 'การเช่ารอตรวจ (เปลี่ยนรหัส/คืนมัดจำ)', 'rentals', 6, (r) => r.endMs],
    [REVIEWS_P, 'รีวิวรออนุมัติ (แผงด้านล่าง)', 'dashboard', 48]
  ].filter(x => x[0].length).map(([rows, t, tab, sla, f]) => { const age = (nowMs - oldest(rows, f)) / 36e5; return { n: rows.length, t, tab, age, late: age > sla }; })
    .sort((x, y) => y.late - x.late || y.age - x.age);
  const ageTxt = (h) => h < 1 ? '<1 ชม.' : h < 48 ? `${Math.floor(h)} ชม.` : `${Math.floor(h / 24)} วัน`;
  const todo = piles;
  $('dash-todo').innerHTML = piles.map(x => `<button type="button" onclick="switchAdminTab('${x.tab}')" class="w-full flex justify-between gap-3 rounded-xl bg-mist px-3 py-2 text-left"><span>${x.t}<span class="${x.late ? 'text-red-500 font-semibold' : 'text-slate'}"> · เก่าสุด ${ageTxt(x.age)}${x.late ? ' · เกินเวลา' : ''}</span></span><b class="text-launchOrange">${x.n}</b></button>`).join('')
    + low.slice(0, 6).map(p => `<button type="button" onclick="switchAdminTab('products')" class="w-full flex justify-between rounded-xl bg-mist px-3 py-2 text-left"><span class="truncate">สต็อกเหลือน้อย: ${adminEsc(p.name)}</span><b class="${num(p.stock) <= 0 ? 'text-red-500' : 'text-launchOrange'}">${num(p.stock)}</b></button>`).join('')
    || '<p class="text-slate">ไม่มีเรื่องค้าง</p>';
  renderAmmoDash(day0, D);
}
function renderReviewsDash() {
  renderDashboard();
  const box = $('dash-reviews'); if (!box) return;
  box.classList.toggle('hidden', !REVIEWS_P.length);
  const pn = (id) => PRODUCTS.find(p => p.id === id)?.name || id;
  $('dash-reviews-body').innerHTML = REVIEWS_P.map(r => { const id = adminEsc(JSON.stringify(r.id)); return `<div class="rounded-xl bg-mist px-3 py-2.5 space-y-1.5"><p><span style="color:#f5a623">${'★'.repeat(num(r.stars))}${'☆'.repeat(5 - num(r.stars))}</span> <b>${adminEsc(r.name)}</b> · <span class="text-slate">${adminEsc(pn(r.productId))}</span></p>${r.text ? `<p>${adminEsc(r.text)}</p>` : ''}
    <div class="flex gap-2"><button type="button" onclick='moderateReview(${id}, "shown")' class="apple-pricing-pill px-3 py-1 text-[11px]">แสดง</button><button type="button" onclick='moderateReview(${id}, "hidden")' class="apple-explore-pill px-3 py-1 text-[11px]">ซ่อน</button></div></div>`; }).join('');
}
async function moderateReview(id, status) {
  try { await updateDoc(doc(db, 'reviews', id), { status }); triggerToast(status === 'shown' ? 'แสดงรีวิวแล้ว' : 'ซ่อนรีวิวแล้ว', 'success'); }
  catch (e) { console.warn(e); triggerToast('ทำรายการไม่สำเร็จ', 'error'); }
}
async function resolveAmmoClaim(orderId, action) {
  const note = action === 'reject' ? (prompt('เหตุผลที่ปฏิเสธ (ลูกค้าจะเห็น)') || '').trim() : '';
  if (action === 'reject' && !note) return;
  if (action === 'refund' && !confirm('คืนเงินเต็มจำนวนออเดอร์นี้เป็นเครดิตให้ลูกค้า?')) return;
  try { await callWorker('/admin/claim', { orderId, action, note }); triggerToast(action === 'refund' ? 'คืนเครดิตแล้ว' : 'ปฏิเสธคำขอแล้ว', 'success'); }
  catch (e) { triggerToast(e.message || 'ทำรายการไม่สำเร็จ', 'error'); }
}
/** กอง sold per hour of day (Thai time) as plain bars, so the admin sees when to restock / run a discount. */
function hourChart(orders) {
  if (!orders.length) return '';
  const h = Array(24).fill(0); orders.forEach(o => { h[new Date(tsMs(o.createdAt) + 7 * 36e5).getUTCHours()] += num(o.ammoTotal); });
  const max = Math.max(...h, 1), top = h.indexOf(Math.max(...h));
  return `<div class="rounded-xl bg-mist px-3 py-2.5"><p class="text-slate mb-2">ขายตามชั่วโมง (30 วัน, กอง) · ขายดีสุด <b class="text-ink">${String(top).padStart(2, '0')}:00</b></p>
    <div style="display:flex;align-items:flex-end;gap:2px;height:64px">${h.map((v, i) => `<div title="${String(i).padStart(2, '0')}:00 · ${v.toLocaleString('th-TH')} กอง" style="flex:1;height:${Math.max(2, Math.round(v / max * 100))}%;background:${i === top ? '#0071e3' : '#b8c4d4'};border-radius:2px"></div>`).join('')}</div>
    <div style="display:flex;justify-content:space-between" class="text-[10px] text-slate mt-1"><span>00</span><span>06</span><span>12</span><span>18</span><span>23</span></div></div>`;
}
/** Ammo panel: per product sold today / 30 days, shelf left, IDs held right now, discount given; plus money received but not delivered. */
function renderAmmoDash(day0, D) {
  const box = $('dash-ammo'); if (!box) return;
  const prods = PRODUCTS.filter(p => p.isAmmo === true);
  box.classList.toggle('hidden', !prods.length && !ACLAIMS.length);
  if (!prods.length && !ACLAIMS.length) return;
  const now = Date.now(), sold = ORDERS.filter(o => o.isAmmo === true && o.status === 'completed');
  const stuck = AQUOTES.filter(q => q.status === 'paid_undelivered');
  const row = (p) => {
    const mine = sold.filter(o => o.productId === p.id), sum = (from, f) => mine.filter(o => tsMs(o.createdAt) >= from).reduce((t, o) => t + f(o), 0);
    const held = AQUOTES.filter(q => q.productId === p.id && q.status === 'open' && num(q.expiresAt) > now).reduce((t, q) => t + num(q.ammoTotal), 0);
    const give = (o) => Math.max(0, num(o.listUnitPrice) - num(o.unitPrice)) * num(o.ammoTotal);
    return `<div class="rounded-xl bg-mist px-3 py-2.5 space-y-1"><p class="font-semibold truncate">${adminEsc(p.name)}</p>
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-x-3 gap-y-1 text-slate">
        <span>วันนี้ <b class="text-ink">${sum(day0, o => num(o.ammoTotal)).toLocaleString('th-TH')}</b> กอง · ฿${money(sum(day0, o => num(o.amount)))}</span>
        <span>30 วัน <b class="text-ink">${sum(day0 - 29 * D, o => num(o.ammoTotal)).toLocaleString('th-TH')}</b> กอง · ฿${money(sum(day0 - 29 * D, o => num(o.amount)))}</span>
        <span>คงเหลือ <b class="text-ink">${num(p.stock).toLocaleString('th-TH')}</b> กอง${held ? ` · กันไว้ ${held.toLocaleString('th-TH')}` : ''}</span>
        <span>ลดไปแล้ว <b class="text-ink">฿${money(sum(0, give))}</b></span></div></div>`;
  };
  const claimFlag = (c) => { const mine = ORDERS.filter(o => o.userId === c.uid), n = mine.filter(o => o.claimStatus).length, tot = mine.filter(o => o.isAmmo && PAID(o)).length; return n >= 3 || (tot >= 4 && n / tot > 0.3) ? `<p class="text-red-500">⚠ ลูกค้ารายนี้เคลมแล้ว ${n} ครั้งจาก ${tot} ออเดอร์ ตรวจให้ละเอียด</p>` : ''; };
  const claims = ACLAIMS.map(c => `<div class="rounded-xl bg-mist px-3 py-2.5 space-y-1.5">${claimFlag(c)}<p><b>เคลมไอดี</b> ${adminEsc(c.orderNumber)} · ${adminEsc(c.productName)} · ฿${money(c.amount)} · <span class="text-slate">${adminEsc(c.email || '')}</span></p><p class="text-slate">${adminEsc(c.reason)}</p>
    <div class="flex gap-2"><button type="button" onclick='resolveAmmoClaim(${adminEsc(JSON.stringify(c.id))}, "refund")' class="apple-pricing-pill px-3 py-1 text-[11px]">คืนเป็นเครดิต ฿${money(c.amount)}</button><button type="button" onclick='resolveAmmoClaim(${adminEsc(JSON.stringify(c.id))}, "reject")' class="apple-explore-pill px-3 py-1 text-[11px] text-red-500 border-red-200">ปฏิเสธ</button></div></div>`).join('');
  $('dash-ammo-body').innerHTML = claims + (stuck.length ? `<div class="rounded-xl bg-red-50 text-red-500 px-3 py-2.5"><b>จ่ายเงินแล้วแต่ไม่ได้ไอดี ${stuck.length} รายการ</b> · ${stuck.slice(0, 5).map(q => `${adminEsc(q.productName)} ฿${money(q.paidAmount)} (อ้างอิง ${adminEsc(q.paidRef || '-')})`).join(' · ')}<br><span class="text-slate">ตรวจใน Discord แล้วส่งไอดีให้ลูกค้าเอง</span></div>` : '') + prods.map(row).join('') + hourChart(sold.filter(o => tsMs(o.createdAt) >= day0 - 29 * D));
}

// ==========================================
// RENTALS (เช่าไอดี): the Worker does every state change; this tab only lists and closes them
// ==========================================
const RENT_STATUS = { active: ['กำลังเช่า', 'text-appleBlue'], expired: ['หมดเวลา · รอตรวจ', 'text-launchOrange'], returned: ['คืนแล้ว · รอตรวจ', 'text-launchOrange'], closed: ['ปิดรายการแล้ว', 'text-slate'] };
function setRentalFilter(f) { rentalFilter = f; renderAdminRentals(); }
function renderAdminRentals() {
  const body = $('admin-rentals-body'); if (!body) return;
  ['todo', 'active', 'all'].forEach(k => { const b = $(`rf-${k}`); if (b) { b.classList.toggle('!bg-ink', k === rentalFilter); b.classList.toggle('!text-gallery', k === rentalFilter); } });
  const rows = RENTALS.filter(r => rentalFilter === 'all' || (rentalFilter === 'active' ? r.status === 'active' : r.status === 'returned' || r.status === 'expired'));
  $('admin-rentals-empty').classList.toggle('hidden', rows.length > 0);
  const t = (ms) => new Date(num(ms)).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' });
  body.innerHTML = rows.map(r => {
    const [label, cls] = RENT_STATUS[r.status] || [r.status, 'text-slate'];
    const id = adminEsc(JSON.stringify(r.id));
    const todo = r.status === 'returned' || r.status === 'expired';
    const dep = { held: 'ถือมัดจำ', refunded: 'คืนแล้ว', forfeited: 'ยึดแล้ว', none: '' }[r.depositStatus] || '';
    return `<tr class="border-b border-hairline">
      <td class="py-3 px-4"><div class="font-medium">${adminEsc(r.userEmail || r.nameMask || '-')}</div><div class="text-[11px] text-slate line-clamp-1">${adminEsc(r.productName)}</div>${r.problem ? `<div class="text-[11px] text-red-500">⚠ แจ้งปัญหา${r.note ? ': ' + adminEsc(r.note) : ''}</div>` : ''}</td>
      <td class="py-3 px-4 text-slate">${t(r.startMs)}<br>ถึง ${t(r.endMs)}<div class="text-[11px]">${adminEsc(r.hours)} ชม.${num(r.extended) ? ` · ต่อ ${adminEsc(r.extended)} ครั้ง` : ''} · ดูรหัส ${adminEsc(r.viewCount || 0)} ครั้ง</div></td>
      <td class="py-3 px-4 font-mono">฿${money(r.price)}<div class="text-[11px] text-slate">มัดจำ ฿${money(r.deposit)} ${dep}</div></td>
      <td class="py-3 px-4 font-medium ${cls}">${label}</td>
      <td class="py-3 px-4 text-right whitespace-nowrap">${todo ? `<button onclick='closeRental(${id}, "refund")' class="apple-pricing-pill px-3 py-1 text-[11px]">คืนมัดจำ</button> <button onclick='closeRental(${id}, "forfeit")' class="apple-explore-pill px-3 py-1 text-[11px] text-red-500 border-red-200">ยึดมัดจำ</button>` : ''}</td></tr>`;
  }).join('');
}
async function closeRental(id, action) {
  const r = RENTALS.find(x => x.id === id); if (!r) return;
  const word = action === 'refund' ? `คืนมัดจำ ฿${money(r.deposit)} ให้ลูกค้า` : `ยึดมัดจำ ฿${money(r.deposit)}`;
  const pw = prompt(`${word}\nและเปิดไอดีให้เช่าต่อ\n\nถ้าเปลี่ยนรหัสผ่านไอดีแล้ว ใส่รหัสผ่านใหม่ตรงนี้ (เว้นว่างถ้าไม่เปลี่ยน)\nกดยกเลิกเพื่อไม่ทำอะไร`, '');
  if (pw === null) return;
  try {
    await callWorker('/admin/rent', { rentalId: id, action, ...(pw.trim() ? { password: pw.trim() } : {}) });
    triggerToast(action === 'refund' ? 'คืนมัดจำและเปิดไอดีแล้ว' : 'ยึดมัดจำและเปิดไอดีแล้ว', 'success');
  } catch (e) { triggerToast(e.message || 'ทำรายการไม่สำเร็จ', 'error'); }
}

// ==========================================
// CATEGORIES (no built-in defaults: deleting the last one leaves the list empty)
// ==========================================
function renderAdminCategories() {
  const tbody = $('admin-categories-table-body'); if (!tbody) return;
  tbody.innerHTML = CATS.length ? CATS.map(c => {
    const id = adminEsc(JSON.stringify(c.id));
    return `<tr class="border-b border-hairline" draggable="true" data-cat="${adminEsc(c.id)}" title="ลากเพื่อจัดลำดับ">
      <td class="py-3 px-4 font-medium"><span class="text-steel cursor-grab mr-2" aria-hidden="true">⠿</span>${c.image ? `<img src="${adminEsc(c.image)}" alt="" class="inline-block w-10 h-6 object-cover rounded mr-2 align-middle">` : ''}${adminEsc(c.name)}${!catVisible(c) ? ' <span class="text-[10px] text-launchOrange">(ซ่อนอยู่)</span>' : ''}${c.badge ? ` <span class="text-[10px] bg-mist px-1.5 rounded-full">${adminEsc(c.badge)}</span>` : ''}<div class="text-[11px] text-slate font-mono font-normal">${adminEsc(c.id)}</div>${c.desc ? `<div class="text-[11px] text-slate font-normal mt-0.5">${adminEsc(c.desc)}</div>` : ''}</td>
      <td class="py-3 px-4 text-slate">${adminEsc(KIND_LABEL[c.kind] || c.kind)}</td>
      <td class="py-3 px-4 font-mono">${c.kind === 'service' ? `ขั้นต่ำ ${adminEsc(c.minQty || 1)} ${adminEsc(c.unit || '')}` : '-'}</td>
      <td class="py-3 px-4 font-mono text-slate">${PRODUCTS.filter(p => p.category === c.id).length}</td>
      <td class="py-3 px-4 text-right whitespace-nowrap"><button onclick='editCategory(${id})' class="apple-explore-pill px-3 py-1 text-[11px]">แก้ไข</button> <button onclick='deleteCategory(${id})' class="apple-explore-pill px-3 py-1 text-[11px] text-red-500 border-red-200">ลบ</button></td></tr>`;
  }).join('') : `<tr><td colspan="5" class="py-12 text-center text-slate">ยังไม่มีหมวดหมู่ · สินค้าทั้งหมดจะแสดงในหน้าร้านตามปกติ</td></tr>`;
}
/** Drag rows to reorder: categories, products (while no text search is active). Boxes do the same in js/back/boxes.js. */
dragSort('admin-categories-table-body', 'data-cat', 'categories', triggerToast);
dragSort('admin-products-table-body', 'data-prod', 'products', triggerToast);

function editCategory(id) {
  const c = categoryOf(CATS, id); if (!c) return;
  const set = (k, v) => { $(k).value = v ?? ''; };
  set('cat-edit-id', c.id); set('cat-name', c.name); set('cat-kind', c.kind); set('cat-image', c.image); set('cat-desc', c.desc); set('cat-badge', c.badge); set('cat-spec-fields', (c.specFields || []).join(', ')); $('cat-hidden').checked = c.hidden === true; set('cat-show-from', msToLocal(c.showFrom)); set('cat-show-to', msToLocal(c.showTo)); set('cat-unit', c.unit); set('cat-min', c.minQty); set('cat-order', c.order);
  toggleCategoryKind(); $('cat-name').focus();
}
function resetCategoryForm() { $('category-form').reset(); $('cat-edit-id').value = ''; toggleCategoryKind(); }
function toggleCategoryKind() { $('cat-service-fields')?.classList.toggle('hidden', $('cat-kind').value !== 'service'); }
async function handleCategorySubmit(e) {
  e.preventDefault();
  const kind = $('cat-kind').value;
  const id = $('cat-edit-id').value || 'cat_' + Date.now().toString(36);
  const data = { name: $('cat-name').value.trim(), kind, order: num($('cat-order').value), image: formatUrl($('cat-image').value) || deleteField(), desc: $('cat-desc').value.trim().slice(0, 300) || deleteField(), badge: $('cat-badge').value.trim().slice(0, 16) || deleteField(), specFields: (() => { const l = $('cat-spec-fields').value.split(',').map(x => x.trim().replace(/[:：]/g, '')).filter(Boolean).slice(0, 12); return l.length ? l : deleteField(); })(), hidden: $('cat-hidden').checked || deleteField(), showFrom: localToMs($('cat-show-from').value) || deleteField(), showTo: localToMs($('cat-show-to').value) || deleteField(), updatedAt: serverTimestamp() };
  if (kind === 'service') { data.unit = $('cat-unit').value.trim() || 'กอง'; data.minQty = Math.max(1, Math.floor(num($('cat-min').value)) || 1); }
  else { data.unit = deleteField(); data.minQty = deleteField(); }
  try { await setDoc(doc(db, 'categories', id), data, { merge: true }); audit($('cat-edit-id').value ? 'แก้หมวดหมู่' : 'สร้างหมวดหมู่', data.name); triggerToast('บันทึกหมวดหมู่แล้ว', 'success'); resetCategoryForm(); }
  catch (err) { triggerToast('บันทึกหมวดหมู่ไม่สำเร็จ', 'error'); }
}
async function deleteCategory(id) {
  const used = PRODUCTS.filter(p => p.category === id).length;
  if (!confirm(used ? `มีสินค้า ${used} รายการในหมวดนี้ สินค้าจะกลายเป็นสินค้าเดี่ยว (ไม่มีหมวด) ลบต่อหรือไม่?` : 'ยืนยันลบหมวดหมู่นี้?')) return;
  try { await deleteDoc(doc(db, 'categories', id)); audit('ลบหมวดหมู่', categoryOf(CATS, id)?.name || id); triggerToast('ลบหมวดหมู่แล้ว', 'success'); } catch (e) { triggerToast('ลบไม่สำเร็จ', 'error'); }
}

// ==========================================
// ORDERS
// ==========================================
const ORDER_UI = {
  pending_payment: ['รอตรวจสอบ', 'bg-[#fff3e6] text-[#a04a00]'], processing: ['กำลังดำเนินการ', 'bg-[#e8f1fd] text-[#0058b9]'],
  completed: ['ส่งมอบสำเร็จ', 'bg-[#e8f8ee] text-[#0a7a3b]'], cancelled: ['ยกเลิก', 'bg-mist text-slate']
};
window.getAdminUsers = () => USERS;
const userOf = (uid) => USERS.find(u => u.uid === uid) || {};
const buyerName = (o) => userOf(o.userId).username || String(o.userEmail || '').split('@')[0] || 'user';

/** Orders in the chosen date range (empty = no limit) as a UTF-8 CSV that Excel opens with Thai text intact. */
function exportOrdersCsv() {
  const from = $('csv-from').value ? new Date($('csv-from').value + 'T00:00:00').getTime() : 0, to = $('csv-to').value ? new Date($('csv-to').value + 'T23:59:59.999').getTime() : Infinity;
  const rows = ORDERS.filter(o => tsMs(o.createdAt) >= from && tsMs(o.createdAt) <= to).reverse();
  if (!rows.length) return triggerToast('ไม่มีออเดอร์ในช่วงวันที่เลือก', 'error');
  const cell = (v) => { let s = typeof v === 'number' ? String(v) : String(v ?? ''); if (typeof v !== 'number' && /^[=+\-@\t\r]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; }; // leading = + - @ would run as a formula in Excel
  const head = ['เลขออเดอร์', 'วันที่', 'สินค้า', 'ประเภท', 'จำนวน', 'กองที่ได้', 'ก่อนลด', 'ส่วนลด', 'ส่วนลดยศ', 'ยอดสุทธิ', 'โค้ด', 'วิธีชำระ', 'สถานะ', 'ผู้ซื้อ', 'อีเมล'];
  const body = rows.map(o => [o.orderNumber || o.orderId || o.id, new Date(tsMs(o.createdAt)).toLocaleString('sv-SE'), o.productName, o.isAmmo ? 'ไก่กระสุน' : o.productType === 'service' ? 'บริการ' : 'ไอดี', num(o.quantity), o.isAmmo ? num(o.ammoTotal) : '', num(o.subtotal), num(o.discount), num(o.rankDiscount), num(o.amount ?? o.finalPrice), o.promoCode || '', o.paymentMethod || '', o.status || '', o.guest ? 'ลูกค้าไม่ล็อกอิน' : buyerName(o), o.userEmail || o.buyerEmail || '']);
  const blob = new Blob(['\ufeff' + [head, ...body].map(r => r.map(cell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `orders_${$('csv-from').value || 'all'}_${$('csv-to').value || 'now'}.csv` });
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function renderAdminOrders() {
  const list = $('admin-orders-list'); if (!list) return;
  const done = ORDERS.filter(o => o.status === 'completed');
  $('metric-order-revenue').innerText = `฿${money(done.reduce((s, o) => s + num(o.amount), 0))}`;
  $('metric-order-count').innerText = ORDERS.length;
  $('metric-order-pending').innerText = ORDERS.filter(o => o.status === 'pending_payment').length;
  $('metric-order-processing').innerText = ORDERS.filter(o => o.status === 'processing').length;
  const f = $('order-status-filter').value, q = ($('order-search').value || '').toLowerCase().trim();
  const rows = ORDERS.filter(o => (f === 'all' || (f === 'active' ? ['pending_payment', 'processing'].includes(o.status) : o.status === f))
    && (!q || [o.orderNumber, o.productName, o.userEmail, o.buyerEmail, o.buyerFacebook, o.buyerContact, buyerName(o)].some(v => String(v || '').toLowerCase().includes(q))));
  $('admin-orders-empty').classList.toggle('hidden', rows.length > 0);
  const cnt = (s) => ORDERS.filter(o => o.status === s).length;
  const chips = [['active', 'ต้องดำเนินการ', cnt('pending_payment') + cnt('processing')], ['pending_payment', 'รอตรวจสอบ', cnt('pending_payment')], ['processing', 'กำลังดำเนินการ', cnt('processing')], ['completed', 'สำเร็จ', cnt('completed')], ['cancelled', 'ยกเลิก', cnt('cancelled')], ['all', 'ทั้งหมด', ORDERS.length]];
  const chipBox = $('order-chips');
  if (chipBox) chipBox.innerHTML = chips.map(([v, t, n]) => `<button type="button" class="ord-chip ${f === v ? 'on' : ''}" onclick="setOrderFilter('${v}')">${t}<b>${n}</b></button>`).join('');
  const PAY = { wallet: 'เครดิต (ชำระแล้ว)', prize: '🎁 ของรางวัลกล่องสุ่ม', truemoney: 'TrueMoney', promptpay: 'พร้อมเพย์' };
  const STEP = { pending_payment: 0, processing: 1, completed: 2 };
  list.innerHTML = rows.slice(0, 200).map(o => {
    const id = adminEsc(JSON.stringify(o.id));
    const [label] = ORDER_UI[o.status] || [o.status];
    const srv = o.productType === 'service';
    const accs = Array.isArray(o.accountsDelivered) && o.accountsDelivered.length ? o.accountsDelivered : (o.accountDelivered?.username ? [o.accountDelivered] : []);
    const btn = (fn, text, primary, danger) => `<button type="button" onclick='${fn}(${id})' class="${primary ? 'apple-pricing-pill' : 'apple-explore-pill'} px-3.5 py-1.5 text-[12px] ${danger ? 'ord-danger' : ''}">${text}</button>`;
    const actions = [
      can('pay') && o.status === 'pending_payment' && btn('approveOrder', srv ? 'ยืนยันชำระ › เข้าคิว' : 'ยืนยันชำระ & ส่งไอดี', true),
      o.status === 'processing' && (srv || !STAFF_ONLY_QUEUE()) && o.queueStatus !== 'working' && btn('startWork', 'เริ่มทำงาน', false),
      o.status === 'processing' && (srv || !STAFF_ONLY_QUEUE()) && btn('finishServiceOrder', 'ส่งมอบสำเร็จ', true),
      can('pay') && o.gamePassword && o.status === 'completed' && btn('clearGamePassword', 'ลบรหัสเกม', false),
      (!STAFF_ONLY_QUEUE() || (srv && o.status === 'processing')) && btn('openNote', o.adminNote ? 'แก้หมายเหตุ' : 'หมายเหตุถึงลูกค้า', false),
      can('pay') && o.hasSlip && btn('viewSlip', 'ดูสลิป', false),
      can('pay') && ['pending_payment', 'processing'].includes(o.status) && btn('cancelOrder', 'ยกเลิก', false, true)
    ].filter(Boolean).join('');
    const at = STEP[o.status], steps = ['ชำระเงิน', srv ? 'ทำงาน' : 'เตรียมไอดี', 'ส่งมอบ'];
    const prod = PRODUCTS.find(p => p.id === o.productId), img = o.image || prod?.image;
    const thumb = img ? `<img src="${adminEsc(img)}" alt="" class="ord-thumb" loading="lazy">` : `<span class="ord-thumb ord-thumb-ph">${srv ? '⚡' : '🎮'}</span>`;
    const cell = (k, v) => v ? `<div class="ord-cell"><dt>${k}</dt><dd>${v}</dd></div>` : '';
    const buyer = `<button type="button" class="text-appleBlue hover:underline" onclick='openUserModal(${adminEsc(JSON.stringify(o.userId || ''))})'>${adminEsc(buyerName(o))}</button>`;
    const sel = (v) => `<span class="select-all">${adminEsc(v)}</span>`;
    const pay = (PAY[o.paymentMethod] || 'พร้อมเพย์') + (o.promoCode ? ` · โค้ด ${adminEsc(o.promoCode)} -฿${money(o.discount)}` : '');
    return `<article class="ord ord-${adminEsc(o.status)}">
      <div class="ord-head">
        ${thumb}
        <div class="ord-main">
          <p class="ord-num">${adminEsc(o.orderNumber || o.id)}<span>${adminEsc(fmtDate(o.createdAt))}</span></p>
          <p class="ord-name">${adminEsc(o.productName)}</p>
          <p class="ord-qty">${srv ? '⚡ งานบริการ' : '🎮 ไอดีเกม'} · × ${adminEsc(o.quantity || 1)} ${adminEsc(o.unit || '')}${num(o.bonusQty) ? ` (+แถม ${adminEsc(o.bonusQty)})` : ''}</p>
        </div>
        <div class="ord-side">
          <p class="ord-amt">฿${money(o.amount)}</p>
          <span class="ord-pill">${label}${o.status === 'processing' && o.queueStatus === 'working' ? ' · กำลังทำ' : ''}</span>
        </div>
      </div>
      ${at === undefined ? '' : `<ol class="ord-steps">${steps.map((s, i) => `<li class="${i < at ? 'done' : i === at ? 'now' : ''}"><i></i>${s}</li>`).join('')}</ol>`}
      <dl class="ord-grid">
        ${cell('ผู้ซื้อ', buyer)}${cell('Facebook', o.buyerFacebook && sel(o.buyerFacebook))}${cell('อีเมล', o.buyerEmail && sel(o.buyerEmail))}
        ${cell('ชื่อในเกม', o.buyerContact && !o.gameEmail && adminEsc(o.buyerContact))}${cell('เวลาพร้อมเล่น', o.playTime && adminEsc(o.playTime))}${cell('ชำระผ่าน', pay)}
      </dl>
      ${o.gameEmail ? `<div class="ord-box"><span>ล็อกอินเกม</span><code class="select-all">${adminEsc(o.gameEmail)}</code><code class="select-all">${adminEsc(o.gamePassword || '(ลบแล้ว)')}</code></div>` : ''}
      ${o.paymentProof && o.paymentMethod === 'truemoney' ? `<div class="ord-box"><span>ซองอั่งเปา</span><a class="text-appleBlue select-all break-all" href="${adminEsc(o.paymentProof)}" target="_blank" rel="noopener">${adminEsc(o.paymentProof)}</a></div>` : ''}
      ${accs.length ? `<div class="ord-box"><span>ไอดีที่ส่งมอบ</span>${accs.map(a => `<code class="select-all">${adminEsc(a.username)}:${adminEsc(a.password)}</code>`).join('')}</div>` : ''}
      ${o.adminNote ? `<p class="ord-note"><b>หมายเหตุถึงลูกค้า</b>${adminEsc(o.adminNote)}</p>` : ''}
      ${actions ? `<div class="ord-actions">${actions}</div>` : ''}
    </article>`;
  }).join('');
}
function setOrderFilter(v) { const s = $('order-status-filter'); if (s) { s.value = v; renderAdminOrders(); } }
window.setOrderFilter = setOrderFilter;
function refreshOrders() { renderAdminOrders(); triggerToast('อัปเดตรายการล่าสุดแล้ว'); }

/** Public feed + counters for a finished order (stats/public, recent_orders). Called inside a transaction. */
function recordSale(txn, orderId, o) {
  if (o.paymentMethod === 'prize') return; // free loot-box prize: not a sale
  txn.set(doc(db, 'stats', 'public'), { orders: increment(1), sales: increment(num(o.amount)) }, { merge: true });
  txn.set(doc(db, 'recent_orders', orderId), { productName: String(o.productName || '').slice(0, 120), productId: o.productId || '', amount: num(o.amount), buyerMask: maskName(buyerName(o)), kind: o.productType === 'service' ? 'service' : 'account', createdAt: serverTimestamp() });
}

async function approveOrder(orderId) {
  const o0 = ORDERS.find(x => x.id === orderId); if (!o0) return;
  const srv = o0.productType === 'service';
  if (!confirm(srv ? 'ยืนยันว่าได้รับเงินแล้ว และนำงานเข้าคิว?' : 'ยืนยันว่าได้รับเงินแล้ว และส่งไอดีให้ลูกค้า?')) return;
  try {
    const orderRef = doc(db, 'orders', orderId);
    const prodRef = doc(db, 'products', o0.productId);
    const qty = Math.max(1, Math.floor(num(o0.quantity)) || 1);
    let itemRefs = [];
    if (!srv) {
      const found = await getDocs(query(collection(prodRef, 'stock_items'), where('status', '==', 'available'), limit(qty)));
      if (found.size < qty) { triggerToast(`ไอดีในคลังไม่พอ (มี ${found.size} ต้องการ ${qty}) กรุณาเติมสต็อกก่อน`, 'error'); return; }
      itemRefs = found.docs.map(d => d.ref);
    }
    await runTransaction(db, async (txn) => {
      const oSnap = await txn.get(orderRef);
      const pSnap = await txn.get(prodRef);
      const items = [];
      for (const r of itemRefs) items.push(await txn.get(r));
      const o = oSnap.data();
      if (!oSnap.exists() || o.status !== 'pending_payment') throw new Error('NOT_PENDING');
      if (pSnap.exists()) txn.update(prodRef, { stock: Math.max(0, num(pSnap.data().stock) - qty), updatedAt: serverTimestamp() });
      if (srv) {
        txn.update(orderRef, { status: 'processing', queueStatus: 'waiting', paidAt: serverTimestamp() });
        txn.set(doc(db, 'queue', orderId), { status: 'waiting', updatedAt: serverTimestamp() }, { merge: true });
      } else {
        const accs = items.map(s => {
          if (!s.exists() || s.data().status !== 'available') throw new Error('ITEM_TAKEN');
          txn.update(s.ref, { status: 'sold', orderId, soldAt: serverTimestamp() });
          return { username: s.data().username, password: s.data().password, stockItemId: s.id };
        });
        txn.update(orderRef, { status: 'completed', completedAt: serverTimestamp(), accountsDelivered: accs, accountDelivered: accs[0] });
        recordSale(txn, orderId, o);
      }
      if (o.promoCode) txn.set(doc(db, 'promo_codes', o.promoCode), { usedCount: increment(1) }, { merge: true });
    });
    triggerToast(srv ? 'นำงานเข้าคิวแล้ว' : 'ส่งมอบไอดีแล้ว', 'success');
    callWorker('/push/queue', { orderId, event: 'paid' }).catch(e => console.warn('push:', e)); // buyer: "ยืนยันการชำระเงินแล้ว"
  } catch (e) {
    console.warn('approve:', e);
    triggerToast(e.message === 'NOT_PENDING' ? 'ออเดอร์นี้ถูกดำเนินการไปแล้ว' : e.message === 'ITEM_TAKEN' ? 'ไอดีถูกใช้ไปแล้ว ลองกดอีกครั้ง' : 'ดำเนินการไม่สำเร็จ', 'error');
  }
}

async function startWork(orderId) {
  try {
    const b = writeBatch(db);
    b.update(doc(db, 'orders', orderId), { queueStatus: 'working', workStartedAt: serverTimestamp() });
    b.set(doc(db, 'queue', orderId), { status: 'working', startedAt: serverTimestamp(), updatedAt: serverTimestamp() }, { merge: true });
    await b.commit();
    triggerToast('อัปเดตเป็นกำลังทำแล้ว', 'success');
    callWorker('/push/queue', { orderId, event: 'start' }).catch(e => console.warn('push:', e)); // customer: "ถึงคิวแล้ว", next in line: "อีก 1 คิว"
  } catch (e) { triggerToast('อัปเดตไม่สำเร็จ', 'error'); }
}
async function finishServiceOrder(orderId) {
  if (!confirm('งานเสร็จแล้ว? ระบบจะลบรหัสผ่านเกมของลูกค้าออกด้วย')) return;
  try {
    const ref = doc(db, 'orders', orderId);
    await runTransaction(db, async (txn) => {
      const s = await txn.get(ref);
      if (!s.exists() || s.data().status !== 'processing') throw new Error('NOT_PROCESSING');
      txn.update(ref, { status: 'completed', queueStatus: 'done', completedAt: serverTimestamp(), gamePassword: deleteField(), gamePasswordClearedAt: serverTimestamp() });
      txn.set(doc(db, 'queue', orderId), { status: 'done', updatedAt: serverTimestamp() }, { merge: true });
      recordSale(txn, orderId, s.data());
    });
    triggerToast('ปิดงานแล้ว ลบรหัสเกมแล้ว', 'success');
    callWorker('/push/queue', { orderId, event: 'done' }).catch(e => console.warn('push:', e));
  } catch (e) { triggerToast(e.message === 'NOT_PROCESSING' ? 'สถานะออเดอร์เปลี่ยนไปแล้ว' : 'ปิดงานไม่สำเร็จ', 'error'); }
}
async function cancelOrder(orderId) {
  const o = ORDERS.find(x => x.id === orderId); if (!o) return;
  const refund = o.status === 'processing' && num(o.amount) > 0; // money was received (wallet or approved transfer); a free prize has nothing to give back
  const reason = prompt(`เหตุผลที่ยกเลิก (ลูกค้าจะเห็น)${refund ? `\nระบบจะคืนเงิน ฿${money(o.amount)} เข้าเครดิตของลูกค้า` : ''}`, '');
  if (reason === null) return;
  try {
    await runTransaction(db, async (txn) => {
      const ref = doc(db, 'orders', orderId);
      const s = await txn.get(ref);
      const cur = s.data();
      if (!['pending_payment', 'processing'].includes(cur.status)) throw new Error('DONE');
      const pRef = doc(db, 'products', cur.productId);
      const p = cur.status === 'processing' ? await txn.get(pRef) : null;
      txn.update(ref, { status: 'cancelled', cancelledAt: serverTimestamp(), gamePassword: deleteField(), ...(reason.trim() ? { adminNote: reason.trim() } : {}) });
      txn.set(doc(db, 'queue', orderId), { status: 'cancelled', updatedAt: serverTimestamp() }, { merge: true });
      if (p?.exists()) txn.update(pRef, { stock: num(p.data().stock) + (num(cur.quantity) || 1) });
      if (cur.status === 'processing' && num(cur.amount) > 0) {
        txn.set(doc(db, 'users', cur.userId), { walletBalance: increment(num(cur.amount)) }, { merge: true });
        txn.set(doc(collection(db, 'wallet_logs')), { uid: cur.userId, delta: num(cur.amount), note: `คืนเงินออเดอร์ ${cur.orderNumber || orderId}`, by: me?.uid || '', at: serverTimestamp() });
      }
    });
    triggerToast('ยกเลิกออเดอร์แล้ว', 'success');
  } catch (e) { triggerToast(e.message === 'DONE' ? 'ออเดอร์นี้ปิดไปแล้ว' : 'ยกเลิกไม่สำเร็จ', 'error'); }
}
async function clearGamePassword(orderId) {
  if (!confirm('ลบรหัสผ่านเกมของออเดอร์นี้?')) return;
  try { await updateDoc(doc(db, 'orders', orderId), { gamePassword: deleteField(), gamePasswordClearedAt: serverTimestamp() }); triggerToast('ลบรหัสเกมแล้ว', 'success'); }
  catch (e) { triggerToast('ลบไม่สำเร็จ', 'error'); }
}
const DEFAULT_REPLIES = ['รับเรื่องแล้ว กำลังตรวจสอบให้ครับ', 'ขอเวลาดำเนินการเพิ่มเล็กน้อย จะอัปเดตให้เร็วที่สุดครับ', 'ตรวจสอบแล้ว ปัญหาเกิดจากข้อมูลไม่ตรง รบกวนส่งข้อมูลใหม่อีกครั้งครับ', 'ไม่สามารถเคลมได้ เนื่องจากไม่เข้าเงื่อนไขการรับประกัน', 'ดำเนินการเรียบร้อยแล้ว ขอบคุณที่ใช้บริการครับ'];
const useReply = (i) => { $('note-text').value = (REPLIES.length ? REPLIES : DEFAULT_REPLIES)[i] || ''; };
async function saveReplies() {
  const list = $('replies-text').value.split('\n').map(x => x.trim().slice(0, 200)).filter(Boolean).slice(0, 20);
  try { await setDoc(doc(db, 'system', 'replies'), { list }); audit('ข้อความสำเร็จรูป', '', `${list.length} ข้อความ`); triggerToast('บันทึกข้อความสำเร็จรูปแล้ว', 'success'); }
  catch (e) { console.warn(e); triggerToast('บันทึกไม่สำเร็จ', 'error'); }
}
function openNote(orderId) {
  const o = ORDERS.find(x => x.id === orderId); if (!o) return;
  $('note-order-id').value = orderId;
  $('note-modal-order').textContent = `${o.orderNumber || orderId} · ${o.productName}`;
  $('note-text').value = o.adminNote || '';
  $('note-push').checked = false;
  const rs = REPLIES.length ? REPLIES : DEFAULT_REPLIES;
  $('note-replies').innerHTML = rs.map((t, i) => `<button type="button" onclick="useReply(${i})" class="apple-explore-pill px-2.5 py-1 text-[11px] text-left">${adminEsc(t.slice(0, 40))}${t.length > 40 ? '…' : ''}</button>`).join('');
  openModal('note-modal'); $('note-text').focus();
}
async function saveOrderNote(e) {
  e.preventDefault();
  const id = $('note-order-id').value, text = $('note-text').value.trim();
  try {
    await updateDoc(doc(db, 'orders', id), { adminNote: text || deleteField(), adminNoteAt: serverTimestamp() });
    const push = $('note-push').checked && text; closeModal('note-modal');
    if (push) { const r = await callWorker('/admin/msg', { orderId: id, text }).catch(() => null); triggerToast(r ? (r.sent ? 'บันทึกและส่งแจ้งเตือนลูกค้าแล้ว' : 'บันทึกแล้ว (ลูกค้ายังไม่ได้เปิดรับแจ้งเตือน)') : 'บันทึกแล้ว แต่ส่งแจ้งเตือนไม่สำเร็จ', r ? 'success' : 'error'); }
    else triggerToast('บันทึกหมายเหตุแล้ว', 'success');
  }
  catch (err) { triggerToast('บันทึกไม่สำเร็จ', 'error'); }
}
async function viewSlip(id) {
  $('slip-modal-img').removeAttribute('src');
  $('slip-modal-meta').textContent = 'กำลังโหลด…';
  openModal('slip-modal');
  try {
    const s = await getDoc(doc(db, 'slip_images', id));
    if (!s.exists()) { $('slip-modal-meta').textContent = 'ไม่พบรูปสลิป'; return; }
    $('slip-modal-img').src = s.data().image;
    $('slip-modal-meta').textContent = `อัปโหลดเมื่อ ${fmtDate(s.data().createdAt)}`;
  } catch (e) { $('slip-modal-meta').textContent = 'โหลดสลิปไม่สำเร็จ'; }
}

// ==========================================
// TOP-UPS + PROMOTIONS
// ==========================================
const TOPUP_UI = { pending: ['รอตรวจสอบ', 'bg-[#fff3e6] text-[#a04a00]'], completed: ['เติมแล้ว', 'bg-[#e8f8ee] text-[#0a7a3b]'], rejected: ['ไม่อนุมัติ', 'bg-mist text-slate'] };
function renderAdminTopups() {
  const list = $('admin-topups-list'); if (!list) return;
  const f = $('topup-status-filter').value;
  const rows = TOPUPS.filter(t => f === 'all' || t.status === f);
  $('admin-topups-empty').classList.toggle('hidden', rows.length > 0);
  list.innerHTML = rows.slice(0, 200).map(t => {
    const id = adminEsc(JSON.stringify(t.id));
    const [label, cls] = TOPUP_UI[t.status] || [t.status, 'bg-mist text-slate'];
    const u = userOf(t.uid);
    const promo = TPROMOS.find(p => p.id === t.promoId);
    return `<article class="apple-card p-4 sm:p-5 text-xs flex flex-col sm:flex-row sm:items-center gap-3 justify-between">
      <div class="min-w-0">
        <p class="font-mono font-bold">${adminEsc(t.txnId || t.id)} <span class="font-normal text-slate">· ${adminEsc(fmtDate(t.createdAt))}</span></p>
        <p class="mt-0.5">ผู้ใช้: <button type="button" class="text-appleBlue hover:underline" onclick='openUserModal(${adminEsc(JSON.stringify(t.uid || ''))})'>${adminEsc(u.username || String(t.email || '').split('@')[0] || t.uid)}</button> · ${t.paymentMethod === 'angpao' ? 'ซองอั่งเปา (อัตโนมัติ)' : t.paymentMethod === 'truemoney' ? 'TrueMoney' : 'พร้อมเพย์'}${t.verifiedVia ? ` · ตรวจอัตโนมัติ (${adminEsc(t.verifiedVia)})` : ''}</p>
        ${t.paymentMethod === 'truemoney' && t.proofRef ? `<p class="text-slate break-all"><a class="text-appleBlue select-all" href="${adminEsc(t.proofRef)}" target="_blank" rel="noopener">${adminEsc(t.proofRef)}</a></p>` : (t.proofRef && !t.hasSlip ? `<p class="text-slate break-all select-all">อ้างอิง: ${adminEsc(t.proofRef)}</p>` : '')}
        ${t.adminNote ? `<p class="text-slate">หมายเหตุ: ${adminEsc(t.adminNote)}</p>` : ''}
      </div>
      <div class="flex items-center gap-3 sm:text-right">
        <div><p class="text-base font-display font-semibold">฿${money(t.amount)}</p><p class="text-slate">ได้เครดิต ${money(t.finalCredit ?? t.amount)}${num(t.bonusCredit) ? ` (โบนัส ${money(t.bonusCredit)}${promo ? ` · โปรเติมครบ ${money(promo.minAmount, 0)}` : ''})` : ''}</p>
          <span class="inline-block mt-1 px-2.5 py-0.5 rounded-full font-semibold ${cls}">${label}</span></div>
        <div class="flex flex-col gap-1.5">
          ${t.hasSlip ? `<button type="button" onclick='viewSlip(${id})' class="apple-explore-pill px-3 py-1.5 text-[11px]">ดูสลิป</button>` : ''}
          ${t.status === 'pending' ? `<button type="button" onclick='approveTopup(${id})' class="apple-pricing-pill px-3 py-1.5 text-[11px]">อนุมัติ & เติมเครดิต</button><button type="button" onclick='rejectTopup(${id})' class="apple-explore-pill px-3 py-1.5 text-[11px]">ไม่อนุมัติ</button>` : ''}
        </div>
      </div>
    </article>`;
  }).join('');
}
async function approveTopup(id) {
  const t0 = TOPUPS.find(x => x.id === id);
  if (!confirm(`ยืนยันได้รับเงิน ฿${money(t0?.amount)} และเติมเครดิต ${money(t0?.finalCredit)} ให้ผู้ใช้?`)) return;
  try {
    await runTransaction(db, async (txn) => {
      const ref = doc(db, 'topup_transactions', id);
      const s = await txn.get(ref);
      if (!s.exists() || s.data().status !== 'pending') throw new Error('NOT_PENDING');
      const t = s.data();
      txn.set(doc(db, 'users', t.uid), { walletBalance: increment(num(t.finalCredit) || num(t.amount)), lastTopupAt: serverTimestamp() }, { merge: true });
      txn.update(ref, { status: 'completed', completedAt: serverTimestamp(), approvedBy: me?.uid || '' });
    });
    triggerToast('เติมเครดิตแล้ว', 'success');
  } catch (e) { triggerToast(e.message === 'NOT_PENDING' ? 'รายการนี้ถูกดำเนินการไปแล้ว' : 'เติมเครดิตไม่สำเร็จ', 'error'); }
}
async function rejectTopup(id) {
  const reason = prompt('เหตุผลที่ไม่อนุมัติ (ผู้ใช้จะเห็น)', 'ไม่พบยอดเงินเข้าบัญชี');
  if (reason === null) return;
  try {
    await runTransaction(db, async (txn) => { // never overwrite a top-up that was already credited
      const ref = doc(db, 'topup_transactions', id), s = await txn.get(ref);
      if (!s.exists() || s.data().status !== 'pending') throw new Error('NOT_PENDING');
      txn.update(ref, { status: 'rejected', completedAt: serverTimestamp(), adminNote: reason.trim() });
    });
    triggerToast('ไม่อนุมัติรายการแล้ว', 'success');
  } catch (e) { triggerToast(e.message === 'NOT_PENDING' ? 'รายการนี้ถูกดำเนินการไปแล้ว' : 'ดำเนินการไม่สำเร็จ', 'error'); }
}

function renderTopupPromos() {
  const box = $('tpromo-list'); if (!box) return;
  box.innerHTML = TPROMOS.length ? TPROMOS.map(p => {
    const id = adminEsc(JSON.stringify(p.id));
    return `<div class="py-3 flex items-center justify-between gap-3 text-xs">
      <div><p class="font-semibold">เติมครบ ${money(p.minAmount, 0)} บาท › โบนัส ${p.type === 'percent' ? `${num(p.value)}%` : `${money(p.value, 0)} บาท`} ${p.active === false ? '<span class="text-slate font-normal">(ปิดอยู่)</span>' : ''}</p>${p.label ? `<p class="text-slate">${adminEsc(p.label)}</p>` : ''}</div>
      <div class="whitespace-nowrap"><button onclick='editTopupPromo(${id})' class="apple-explore-pill px-3 py-1 text-[11px]">แก้ไข</button> <button onclick='deleteTopupPromo(${id})' class="apple-explore-pill px-3 py-1 text-[11px] text-red-500 border-red-200">ลบ</button></div></div>`;
  }).join('') : '<p class="py-6 text-center text-slate text-xs">ยังไม่มีโปรโมชั่นการเติมเงิน</p>';
}
async function saveTopupPromo(e) {
  e.preventDefault();
  const type = $('tpromo-type').value, value = num($('tpromo-value').value), minAmount = num($('tpromo-min').value);
  if (minAmount < 20 || !(value > 0) || (type === 'percent' && value > 100)) return triggerToast('ข้อมูลโปรโมชั่นไม่ถูกต้อง', 'error');
  const id = $('tpromo-id').value || 'tp_' + Date.now().toString(36);
  try {
    await setDoc(doc(db, 'topup_promos', id), { minAmount, type, value, label: $('tpromo-label').value.trim(), active: $('tpromo-active').checked, updatedAt: serverTimestamp() });
    triggerToast('บันทึกโปรโมชั่นแล้ว', 'success'); resetTopupPromo();
  } catch (err) { triggerToast('บันทึกไม่สำเร็จ', 'error'); }
}
function editTopupPromo(id) {
  const p = TPROMOS.find(x => x.id === id); if (!p) return;
  $('tpromo-id').value = p.id; $('tpromo-min').value = p.minAmount; $('tpromo-type').value = p.type; $('tpromo-value').value = p.value;
  $('tpromo-label').value = p.label || ''; $('tpromo-active').checked = p.active !== false; $('tpromo-min').focus();
}
function resetTopupPromo() { $('tpromo-form').reset(); $('tpromo-id').value = ''; $('tpromo-active').checked = true; }
async function deleteTopupPromo(id) {
  if (!confirm('ลบโปรโมชั่นนี้?')) return;
  try { await deleteDoc(doc(db, 'topup_promos', id)); triggerToast('ลบโปรโมชั่นแล้ว', 'success'); } catch (e) { triggerToast('ลบไม่สำเร็จ', 'error'); }
}

// ==========================================
// USERS
// ==========================================
function duplicateProduct(id) {
  openProductModal(id);
  $('prod-edit-id').value = ''; $('prod-name').value += ' (สำเนา)'; $('product-modal-heading').innerText = 'เพิ่มสินค้าใหม่ (คัดลอก)';
}
function copyProductLink(id) {
  const url = new URL(`product.html?id=${encodeURIComponent(id)}`, location.href.replace(/admin\.html.*$/, '')).href;
  navigator.clipboard?.writeText(url).then(() => triggerToast('คัดลอกลิงก์แล้ว', 'success'), () => prompt('คัดลอกลิงก์นี้', url));
}

/** Sales history and profit per product from the orders already loaded (paid orders only; cost = prod-cost x units). */
function renderProfit() {
  const card = $('profit-card'); if (card) card.classList.toggle('hidden', !can('profit'));
  const box = $('profit-list'); if (!box || !can('profit')) return;
  monthReport();
  const by = {};
  for (const o of ORDERS.filter(PAID)) {
    if (!o.productId) continue;
    const u = o.isAmmo ? num(o.ammoTotal) : num(o.receiveQty) || num(o.quantity) || 1, r = (by[o.productId] ||= { units: 0, rev: 0, orders: [] });
    r.units += u; r.rev += num(o.amount); r.orders.push(o);
  }
  const rows = Object.entries(by).map(([id, r]) => { const p = PRODUCTS.find(x => x.id === id), cost = num(p?.cost) * r.units; return { id, p, ...r, profit: p && num(p.cost) > 0 ? r.rev - cost : null }; })
    .filter(r => r.p).sort((a, b) => (b.profit ?? -1e12) - (a.profit ?? -1e12) || b.rev - a.rev).slice(0, 30);
  const tot = rows.filter(r => r.profit !== null).reduce((s, r) => s + r.profit, 0);
  box.innerHTML = (rows.some(r => r.profit !== null) ? `<p class="text-slate">กำไรรวมสินค้าที่ใส่ต้นทุน: <b class="text-ink">฿${money(tot, 0)}</b></p>` : '') + (rows.map(r => `<details class="rounded-xl bg-mist px-3 py-2"><summary class="cursor-pointer flex gap-3 items-center"><b class="truncate mr-auto">${adminEsc(r.p.name)}</b><span class="text-slate">ขาย ${money(r.units, 0)}</span><span>฿${money(r.rev, 0)}</span><span style="min-width:84px;text-align:right;color:${r.profit === null ? '#86868b' : r.profit >= 0 ? '#0a7a3b' : '#d70015'}">${r.profit === null ? 'ไม่มีต้นทุน' : (r.profit >= 0 ? '+' : '−') + '฿' + money(Math.abs(r.profit), 0)}</span></summary>
    <div class="mt-2 space-y-1 text-slate">${r.orders.slice(0, 15).map(o => `<p>${adminEsc(fmtDate(o.createdAt))} · ${adminEsc(buyerName(o))} · ${adminEsc(o.orderNumber || '')} · ฿${money(num(o.amount))}</p>`).join('')}${r.orders.length > 15 ? `<p>… อีก ${r.orders.length - 15} ออเดอร์</p>` : ''}</div></details>`).join('') || '<p class="text-slate">ยังไม่มียอดขาย</p>');
}

/** Monthly P&L from the loaded feeds. Month = Thai calendar month; compares with the month before. Pure over ORDERS/RENTALS/TOPUPS/PRODUCTS/box opens. */
export function monthStats(ym, slipFee = 0) {
  const [y, m] = ym.split('-').map(Number), th = 7 * 36e5;
  const from = Date.UTC(y, m - 1, 1) - th, to = Date.UTC(y, m, 1) - th, inM = (v) => { const t = tsMs(v); return t >= from && t < to; };
  const cost = (id, units) => num(PRODUCTS.find(x => x.id === id)?.cost) * units;
  const paid = ORDERS.filter(o => PAID(o) && inM(o.createdAt)), rentals = RENTALS.filter(r => inM(r.createdAt));
  const opens = (window.getBoxOpens?.() || []).filter(b => inM(b.createdAt)), tops = TOPUPS.filter(t => t.status === 'completed' && inM(t.completedAt || t.createdAt));
  const r = { orders: paid.length, rentals: rentals.length, opens: opens.length };
  r.revenue = paid.reduce((a, o) => a + num(o.amount), 0) + rentals.reduce((a, x) => a + num(x.price), 0) + opens.reduce((a, b) => a + num(b.price), 0);
  r.cogs = paid.reduce((a, o) => a + cost(o.productId, o.isAmmo ? num(o.ammoTotal) : num(o.receiveQty) || num(o.quantity) || 1), 0);
  r.discounts = paid.reduce((a, o) => a + num(o.discount) + num(o.rankDiscount) + num(o.comboDiscount), 0);
  r.slips = tops.filter(t => t.verifiedVia === 'easyslip').length; r.slipFees = r.slips * slipFee;
  r.bonus = tops.reduce((a, t) => a + num(t.bonusCredit), 0); // free credit handed out on top-ups
  r.boxPayout = opens.reduce((a, b) => a + (b.kind === 'credit' ? num(b.amount) : b.kind === 'account' ? cost(b.productId, 1) : b.kind === 'service' ? cost(b.productId, num(b.qty) || 1) : 0), 0);
  r.boxProfit = opens.reduce((a, b) => a + num(b.price), 0) - r.boxPayout;
  r.net = r.revenue - r.cogs - r.slipFees - r.bonus - r.boxPayout;
  return r;
}
let SLIP_FEE = 0;
function monthReport() {
  const box = $('month-body'); if (!box || !can('profit')) return;
  const inp = $('month-pick'); if (!inp.value) inp.value = new Date(Date.now() + 7 * 36e5).toISOString().slice(0, 7);
  const [y, m] = inp.value.split('-').map(Number), prev = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
  SLIP_FEE = num($('month-fee').value);
  const a = monthStats(inp.value, SLIP_FEE), b = monthStats(prev, SLIP_FEE);
  const row = (label, k, sign = 1, strong = false) => { const d = b[k] ? Math.round((a[k] - b[k]) / Math.abs(b[k]) * 100) : null; return `<div class="flex justify-between gap-3 ${strong ? 'font-semibold border-t border-hairline pt-1.5' : ''}"><span>${label}</span><span>${sign < 0 ? '−' : ''}฿${money(Math.abs(a[k]), 0)} <span class="text-slate font-normal">${d === null ? '' : `(${d >= 0 ? '+' : ''}${d}% vs เดือนก่อน ฿${money(b[k], 0)})`}</span></span></div>`; };
  const noCost = PRODUCTS.some(p => num(p.cost) <= 0) ? '<p class="text-[11px] text-slate">สินค้าที่ไม่ได้ใส่ต้นทุนนับต้นทุนเป็น ฿0 กำไรจะสูงกว่าจริง</p>' : '';
  box.innerHTML = row('รายได้ (ออเดอร์ + เช่า + กล่องสุ่ม)', 'revenue') + row('ต้นทุนสินค้า', 'cogs', -1) + row(`ค่าเช็คสลิป (${a.slips} ใบ)`, 'slipFees', -1) + row('โบนัสเติมเงินที่แจกฟรี', 'bonus', -1) + row('ของรางวัลกล่องสุ่มที่จ่ายออก', 'boxPayout', -1)
    + row('กำไรสุทธิ', 'net', 1, true) + '<div class="pt-1.5 text-slate space-y-1">' + row('ส่วนลดที่ให้ลูกค้า (หักจากรายได้แล้ว)', 'discounts') + row('กำไรกล่องสุ่ม (ค่าเปิด − ของรางวัล)', 'boxProfit') + '</div>' + noCost
    + `<p class="text-[11px] text-slate">${a.orders} ออเดอร์ · ${a.rentals} เช่า · ${a.opens} ครั้งเปิดกล่อง (กล่องสุ่มดูย้อนหลังได้ 200 ครั้งล่าสุด)</p>`;
}
async function saveSlipFee() {
  try { await setDoc(doc(db, 'system_settings', 'finance'), { slipFee: num($('month-fee').value) }, { merge: true }); monthReport(); } catch (e) { console.warn(e); triggerToast('บันทึกค่าเช็คสลิปไม่สำเร็จ', 'error'); }
}

const csvCell = (v) => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; }; // a leading = + - @ would run as an Excel formula
function exportProductsCsv() {
  const rows = [['id', 'ชื่อ', 'ราคา', 'ต้นทุน', 'แท็ก', 'สเปก'], ...PRODUCTS.map(p => [p.id, p.name, p.saleOn ? p.basePrice : p.price, p.cost || '', (p.tags || []).join('|'), (p.specs || []).join('|')])];
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob(['\ufeff' + rows.map(r => r.map(csvCell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' })), download: 'products.csv' });
  a.click(); URL.revokeObjectURL(a.href);
}
export const parseCsv = (text) => { // RFC 4180: quoted cells, "" escapes, CRLF or LF
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim()));
};
async function importProductsCsv(input) {
  const f = input.files?.[0]; input.value = ''; if (!f) return;
  const rows = parseCsv((await f.text()).replace(/^\ufeff/, '')).slice(1), plan = [];
  for (const [id, name, price, cost, tags, specs] of rows) {
    const p = PRODUCTS.find(x => x.id === (id || '').trim()); if (!p) continue;
    const u = {}, cl = (s) => String(s ?? '').replace(/^'/, '').trim();
    if (cl(name) && cl(name) !== p.name) u.name = cl(name).slice(0, 200);
    const np = num(cl(price)), oldP = p.saleOn ? num(p.basePrice) : num(p.price), fixedPrice = !p.saleOn && !p.isAmmo && !isServiceProduct(p, CATS) && !(num(p.rentHourPrice) > 0);
    if (fixedPrice && np > 0 && np !== oldP) { u.price = np; u.priceHist = [...(Array.isArray(p.priceHist) ? p.priceHist : oldP ? [{ t: tsMs(p.createdAt) || Date.now() - 864e5, p: oldP }] : []), { t: Date.now(), p: np }].slice(-30); }
    const nc = num(cl(cost)); if (cost !== undefined && cl(cost) !== '' && nc >= 0 && nc !== num(p.cost)) u.cost = nc > 0 ? nc : deleteField();
    const nt = cl(tags).split('|').map(s => s.trim()).filter(Boolean).slice(0, 20); if (tags !== undefined && nt.join('|') !== (p.tags || []).join('|')) u.tags = nt;
    const ns = cl(specs).split('|').map(s => s.trim()).filter(Boolean).slice(0, 40); if (specs !== undefined && ns.join('|') !== (p.specs || []).join('|')) u.specs = ns;
    if (Object.keys(u).length) plan.push([p, u]);
  }
  if (!plan.length) return triggerToast('ไม่มีสินค้าที่เปลี่ยนแปลง', 'error');
  if (!confirm(`อัปเดต ${plan.length} สินค้า?\n` + plan.slice(0, 8).map(([p, u]) => `• ${p.name}: ${Object.keys(u).filter(k => k !== 'priceHist').join(', ')}`).join('\n'))) return;
  try {
    for (let i = 0; i < plan.length; i += 400) { const b = writeBatch(db); plan.slice(i, i + 400).forEach(([p, u]) => b.update(doc(db, 'products', p.id), { ...u, updatedAt: serverTimestamp() })); await b.commit(); }
    audit('นำเข้า CSV สินค้า', `${plan.length} รายการ`); triggerToast(`อัปเดต ${plan.length} สินค้าแล้ว`, 'success');
  } catch (e) { console.warn(e); triggerToast('นำเข้าไม่สำเร็จ', 'error'); }
}

let AUCTIONS = [];
const AUC_STATUS = { open: 'กำลังประมูล', settling: 'กำลังส่งมอบ', sold: 'ขายแล้ว', failed: 'ส่งมอบไม่สำเร็จ (คืนเครดิตแล้ว)', ended: 'ปิด ไม่มีคนประมูล' };
function renderAuctionsAdmin() {
  const sel = $('auc-product'), box = $('auction-admin-list'); if (!sel || !box) return;
  const cur = sel.value, ok = PRODUCTS.filter(p => !isServiceProduct(p, CATS) && !p.isAmmo && !(num(p.rentHourPrice) > 0) && !p.isBox && num(p.stock) > 0);
  sel.innerHTML = ok.map(p => `<option value="${esc(p.id)}">${esc(p.name)} (เหลือ ${num(p.stock)})</option>`).join('') || '<option value="">ไม่มีไอดีที่มีสต็อก</option>';
  if (ok.some(p => p.id === cur)) sel.value = cur;
  box.innerHTML = AUCTIONS.slice().sort((a, b) => num(b.endsAt) - num(a.endsAt)).slice(0, 15).map(a => `<div class="flex items-center gap-2 rounded-xl bg-mist px-3 py-2"><b class="truncate">${esc(a.name)}</b><span class="text-slate mr-auto">${AUC_STATUS[a.status] || a.status} · ${num(a.bidCount)} ครั้ง${a.topBid ? ` · ฿${money(num(a.topBid))} (${esc(a.topName)})` : ''} · ${a.status === 'open' ? 'ปิด ' : ''}${esc(new Date(num(a.endsAt)).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' }))}</span>${!num(a.bidCount) ? `<button type="button" class="text-red-500" onclick='removeAuction(${esc(JSON.stringify(a.id))})'>ลบ</button>` : ''}</div>`).join('') || '<p class="text-slate">ยังไม่มีการประมูล</p>';
}
async function createAuction(e) {
  e.preventDefault();
  const p = PRODUCTS.find(x => x.id === $('auc-product').value); if (!p) return false;
  const id = 'auc_' + Date.now().toString(36);
  try {
    await setDoc(doc(db, 'auctions', id), { name: p.name, image: p.image || '', specs: (p.specs || []).slice(0, 8), productId: p.id, startPrice: Math.max(1, Math.floor(num($('auc-start').value))), minStep: Math.max(1, Math.floor(num($('auc-step').value))), endsAt: Date.now() + Math.min(168, Math.max(1, num($('auc-hours').value))) * 36e5, status: 'open', topBid: 0, topUid: '', topName: '', bidCount: 0, createdAt: serverTimestamp() });
    audit('เริ่มประมูล', p.name); triggerToast('เริ่มประมูลแล้ว', 'success');
  } catch (err) { console.warn(err); triggerToast('สร้างการประมูลไม่สำเร็จ', 'error'); }
  return false;
}
async function removeAuction(id) { if (!confirm('ลบการประมูลนี้?')) return; try { await deleteDoc(doc(db, 'auctions', id)); } catch (e) { triggerToast('ลบไม่ได้ (มีผู้เสนอราคาแล้ว)', 'error'); } }

function renderWinback() {
  const box = $('winback-list'); if (!box) return;
  const days = Math.max(1, num($('wb-days').value) || 30), cut = Date.now() - days * 864e5, by = {};
  ORDERS.filter(PAID).forEach(o => { const u = o.userId; if (!u) return; const t = tsMs(o.createdAt); (by[u] ||= { n: 0, last: 0, sum: 0 }); by[u].n++; by[u].sum += num(o.amount); by[u].last = Math.max(by[u].last, t); });
  const rows = Object.entries(by).filter(([, v]) => v.n >= 2 && v.last < cut).sort((a, b) => b[1].sum - a[1].sum).slice(0, 30);
  box.innerHTML = rows.length ? rows.map(([uid, v]) => `<div class="flex items-center gap-2 rounded-xl bg-mist px-3 py-2"><button type="button" class="text-appleBlue hover:underline font-medium" onclick='openUserModal(${adminEsc(JSON.stringify(uid))})'>${adminEsc(userOf(uid).username || uid.slice(0, 8))}</button><span class="text-slate mr-auto">ซื้อ ${v.n} ครั้ง · ฿${money(v.sum, 0)} · หาย ${Math.floor((Date.now() - v.last) / 864e5)} วัน</span><button type="button" class="apple-explore-pill px-3 py-1" onclick='sendWinback(${adminEsc(JSON.stringify(uid))}, this)'>ส่งโค้ด</button></div>`).join('') : '<p class="text-slate">ไม่มีลูกค้าที่เข้าเงื่อนไข</p>';
}
async function sendWinback(uid, btn) {
  btn.disabled = true;
  try {
    const r = await callWorker('/admin/winback', { uid, type: $('wb-type').value, value: num($('wb-value').value), days: num($('wb-valid').value) });
    btn.outerHTML = `<span class="font-mono text-ink select-all">${adminEsc(r.code)}</span><span class="text-slate">${r.sent ? '· ส่งแจ้งเตือนแล้ว' : '· ลูกค้าไม่ได้เปิดแจ้งเตือน คัดลอกส่งเอง'}</span>`;
  } catch (e) { btn.disabled = false; triggerToast(e.message, 'error'); }
}

function renderAdminUsers() {
  renderWinback();
  const tbody = $('admin-users-table-body'); if (!tbody) return;
  $('metric-user-count').innerText = USERS.length;
  $('metric-user-balance').innerText = `฿${money(USERS.reduce((s, u) => s + num(u.walletBalance), 0), 0)}`;
  $('metric-user-admins').innerText = USERS.filter(u => u.role === 'admin').length;
  $('metric-user-suspended').innerText = USERS.filter(u => u.status === 'suspended').length;
  const q = ($('user-search').value || '').toLowerCase().trim();
  const rows = USERS.filter(u => !q || [u.username, u.email, u.contactEmail, u.facebook, u.uid].some(v => String(v || '').toLowerCase().includes(q)));
  $('admin-users-empty').classList.toggle('hidden', rows.length > 0);
  tbody.innerHTML = rows.slice(0, 300).map(u => `<tr class="border-b border-hairline">
    <td class="py-3 px-4"><p class="font-semibold flex items-center gap-2">${adminEsc(u.username || '(ไม่มีชื่อ)')} ${rankBadge(rankOf(u, SETTINGS))} ${titleBadge(u)}</p><p class="text-[10px] text-slate font-mono">${adminEsc(u.uid)}</p></td>
    <td class="py-3 px-4 text-slate">${adminEsc(u.contactEmail || (/@tactical\.store$/.test(u.email || '') ? '' : u.email) || '-')}${u.facebook ? `<br>FB: ${adminEsc(u.facebook)}` : ''}</td>
    <td class="py-3 px-4 font-mono font-semibold">฿${money(u.walletBalance)}</td>
    <td class="py-3 px-4">${u.role === 'admin' ? '<span class="text-launchOrange font-semibold">Admin</span>' : u.role === 'staff' ? `<span class="font-semibold" title="${adminEsc((u.perms || []).map(p => PERM_LABEL[p] || p).join(', '))}">ทีมงาน (${(u.perms || []).length})</span>` : 'User'}</td>
    <td class="py-3 px-4">${u.status === 'suspended' ? '<span class="text-launchOrange font-semibold">ระงับ</span>' : '<span class="text-emerald-600">ปกติ</span>'}</td>
    <td class="py-3 px-4 text-slate">${adminEsc(fmtDate(u.createdAt))}</td>
    <td class="py-3 px-4 text-right"><button onclick='openUserModal(${adminEsc(JSON.stringify(u.uid))})' class="apple-pricing-pill px-3 py-1 text-[11px]">จัดการ</button></td></tr>`).join('');
}

let umUid = null;
function userModalTab(t) {
  ['overview', 'info', 'wallet', 'history'].forEach(k => { $(`um-pane-${k}`).classList.toggle('hidden', k !== t); $(`um-tab-${k}`).className = `py-2 rounded-full ${k === t ? 'bg-gallery shadow-sm font-semibold' : 'text-slate'}`; });
  if (t === 'history') loadUserHistory();
  if (t === 'overview') loadUserOverview();
  if (t === 'wallet') loadWalletLogs();
}
function syncPermBox() { $('um-perms-wrap').classList.toggle('hidden', $('um-role').value === 'admin'); }
window.syncPermBox = syncPermBox;
function openUserModal(uid) {
  if (!uid) return;
  umUid = uid;
  const u = userOf(uid);
  $('um-uid').textContent = `UID: ${uid}`;
  $('um-title').textContent = u.username || 'ผู้ใช้';
  $('um-username').value = u.username || '';
  $('um-contact-email').value = u.contactEmail || '';
  $('um-facebook').value = u.facebook || '';
  $('um-password').value = '';
  $('um-title').value = u.title || '';
  $('um-title-color').innerHTML = Object.entries(TITLE_COLORS).map(([k, c]) => `<option value="${k}" ${u.titleColor === k ? 'selected' : ''}>${c[2]}</option>`).join('');
  $('um-role').value = u.role === 'admin' ? 'admin' : 'user';
  $('um-perms').innerHTML = Object.entries(PERM_LABEL).map(([k, t]) => `<label class="flex items-start gap-2 py-1"><input type="checkbox" value="${k}" ${(u.perms || []).includes(k) ? 'checked' : ''}> <span>${adminEsc(t)}</span></label>`).join('');
  $('um-perms').insertAdjacentHTML('beforeend', `<label class="flex items-center gap-2 py-1 col-span-full"><span>เพดานปรับเครดิต ฿/วัน (ของคนนี้)</span><input id="um-credit-cap" type="number" min="0" step="100" value="${num(u.creditCap) || ''}" class="apple-input px-2 py-1 w-28"></label>`);
  syncPermBox();
  document.querySelectorAll('#um-pane-info input[id^="um-"], #um-pane-info select').forEach(el => { if (['um-username', 'um-password', 'um-role', 'um-status', 'um-title', 'um-title-color'].includes(el.id) || el.closest('#um-perms-wrap')) el.disabled = !ADMIN; });
  $('um-status').value = u.status === 'suspended' ? 'suspended' : 'active';
  $('um-login-email').textContent = u.email || '-';
  $('um-balance').textContent = `฿${money(u.walletBalance)}`;
  showVault(u);
  $('um-worker-note').textContent = workerUrl() ? '' : 'ยังไม่ได้ตั้งค่า Worker: เปลี่ยนชื่อผู้ใช้สำหรับล็อกอิน / รหัสผ่าน / สิทธิ์ Admin / ระงับการล็อกอิน จะยังไม่มีผล (บันทึกได้เฉพาะข้อมูลในฐานข้อมูล)';
  $('um-amount').value = ''; $('um-wnote').value = '';
  userModalTab('overview');
  openModal('user-modal');
}
const vaultMs = (u) => tsMs(u?.vaultUntil);
function showVault(u) { const t = vaultMs(u); $('um-vault').textContent = t > Date.now() ? `ถึง ${new Date(t).toLocaleDateString('th-TH', { dateStyle: 'medium' })}` : 'ยังไม่เปิดสิทธิ์'; }
/** Adds N days on top of what is left (never before today); 0 = close now. Only admins can write this field (rules). */
async function grantVault(add) {
  const days = Math.round(num($('um-vault-days').value));
  if (add && !(days >= 1 && days <= 365)) return triggerToast('ใส่จำนวนวัน 1-365', 'error');
  const until = add ? Math.max(Date.now(), vaultMs(userOf(umUid))) + days * 864e5 : 0;
  try {
    await setDoc(doc(db, 'users', umUid), { vaultUntil: add ? Timestamp.fromMillis(until) : null }, { merge: true });
    showVault({ vaultUntil: { toMillis: () => until } });
    triggerToast(add ? `เปิดสิทธิ์คลังไอดี +${days} วัน` : 'ปิดสิทธิ์คลังไอดีแล้ว', 'success');
  } catch (e) { triggerToast('บันทึกไม่สำเร็จ', 'error'); }
}
async function saveUserInfo(e) {
  e.preventDefault();
  const u = userOf(umUid);
  const username = $('um-username').value.trim();
  const password = $('um-password').value;
  const role = $('um-role').value, status = $('um-status').value;
  if (username && ([...username].length < 3 || /[@\s]/.test(username))) return triggerToast('ชื่อผู้ใช้ 3–24 ตัวอักษร ห้ามมีช่องว่างหรือ @', 'error');
  if (password && password.length < 6) return triggerToast('รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร', 'error');
  if (umUid === me?.uid && (role !== 'admin' || status === 'suspended')) return triggerToast('ห้ามลดสิทธิ์หรือระงับบัญชีของตัวเอง', 'error');
  const authChange = {};
  if (username && username !== u.username) authChange.username = username;
  if (password) authChange.password = password;
  if ((role === 'admin') !== (u.role === 'admin')) authChange.admin = role === 'admin';
  const perms = role === 'admin' ? [] : [...document.querySelectorAll('#um-perms input:checked')].map(i => i.value);
  const oldPerms = Array.isArray(u.perms) ? u.perms : [];
  if (perms.join() !== oldPerms.join()) authChange.perms = perms;
  const creditCap = perms.includes('credit') ? Math.max(0, Math.floor(num($('um-credit-cap')?.value))) : 0;
  if (creditCap !== num(u.creditCap)) authChange.creditCap = creditCap;
  const newRole = role === 'admin' ? 'admin' : perms.length ? 'staff' : 'user';
  if ((status === 'suspended') !== (u.status === 'suspended')) authChange.disabled = status === 'suspended';
  const btn = $('um-save'); btn.disabled = true;
  try {
    let loginEmail = null;
    if (Object.keys(authChange).length && workerUrl()) {
      const r = await callWorker('/admin/user', { uid: umUid, ...authChange });
      loginEmail = r.email || null;
    }
    await updateDoc(doc(db, 'users', umUid), {
      username: username || u.username || '', contactEmail: $('um-contact-email').value.trim(), facebook: $('um-facebook').value.trim(),
      ...(ADMIN ? { role: newRole, status, perms, creditCap, title: $('um-title').value.trim().slice(0, 24), titleColor: $('um-title-color').value, ...(loginEmail ? { email: loginEmail } : {}) } : {}), adminUpdatedAt: serverTimestamp()
    });
    $('um-password').value = '';
    triggerToast(Object.keys(authChange).length && !workerUrl() ? 'บันทึกข้อมูลแล้ว (การล็อกอินยังไม่เปลี่ยน เพราะยังไม่ได้ตั้ง Worker)' : 'บันทึกข้อมูลผู้ใช้แล้ว', 'success');
  } catch (err) { console.warn(err); triggerToast(err.message || 'บันทึกไม่สำเร็จ', 'error'); }
  finally { btn.disabled = false; }
}
async function saveUserWallet(e) {
  e.preventDefault();
  const mode = document.querySelector('input[name="um-wmode"]:checked').value;
  const amt = Math.round(num($('um-amount').value) * 100) / 100;
  const note = $('um-wnote').value.trim();
  if (!(amt >= 0) || (mode !== 'set' && !(amt > 0))) return triggerToast('กรุณาใส่จำนวนเงิน', 'error');
  const btn = $('um-wsave'); btn.disabled = true;
  try {
    if (!ADMIN) { // staff: the Worker enforces the daily cap
      const r = await callWorker('/admin/wallet', { uid: umUid, mode, amount: amt, note });
      $('um-balance').textContent = `฿${money(r.balance)}`; $('um-amount').value = ''; $('um-wnote').value = '';
      triggerToast(`ปรับยอดเงินแล้ว (คงเหลือ ฿${money(r.balance)} · เหลือเพดานวันนี้ ฿${money(r.left)})`, 'success');
      return loadWalletLogs();
    }
    const after = await runTransaction(db, async (txn) => {
      const ref = doc(db, 'users', umUid);
      const s = await txn.get(ref);
      const before = num(s.exists() ? s.data().walletBalance : 0);
      const next = Math.round((mode === 'set' ? amt : mode === 'add' ? before + amt : before - amt) * 100) / 100;
      if (next < 0) throw new Error('NEG');
      txn.set(ref, { walletBalance: next }, { merge: true });
      txn.set(doc(collection(db, 'wallet_logs')), { uid: umUid, before, after: next, delta: Math.round((next - before) * 100) / 100, note, by: me?.uid || '', at: serverTimestamp() });
      return next;
    });
    $('um-balance').textContent = `฿${money(after)}`;
    $('um-amount').value = ''; $('um-wnote').value = '';
    triggerToast(`ปรับยอดเงินแล้ว (คงเหลือ ฿${money(after)})`, 'success');
    loadWalletLogs();
  } catch (err) { triggerToast(err.message === 'NEG' ? 'ยอดเงินติดลบไม่ได้' : (!ADMIN && err.message) || 'ปรับยอดไม่สำเร็จ', 'error'); }
  finally { btn.disabled = false; }
}
async function loadWalletLogs() {
  const box = $('um-wallet-logs'); box.innerHTML = '<p class="py-3 text-slate">กำลังโหลด…</p>';
  try {
    const logs = (await getDocs(query(collection(db, 'wallet_logs'), where('uid', '==', umUid)))).docs.map(d => d.data()).sort((a, b) => tsMs(b.at) - tsMs(a.at)).slice(0, 20);
    box.innerHTML = logs.length ? logs.map(l => `<div class="py-2 flex justify-between gap-3"><span class="text-slate">${adminEsc(fmtDate(l.at))} · ${adminEsc(l.note || '-')}</span><span class="font-mono font-semibold ${num(l.delta) < 0 ? 'text-launchOrange' : 'text-emerald-600'}">${num(l.delta) >= 0 ? '+' : ''}${money(l.delta)}</span></div>`).join('') : '<p class="py-3 text-slate">ยังไม่มีประวัติ</p>';
  } catch (e) { box.innerHTML = '<p class="py-3 text-slate">โหลดไม่สำเร็จ</p>'; }
}
/** One-glance customer card: money in/out, claims, boxes, reviews, last purchase, plus claim-abuse warning. */
async function loadUserOverview() {
  const box = $('um-overview'), u = userOf(umUid), uid = umUid;
  const orders = ORDERS.filter(o => o.userId === uid), paid = orders.filter(o => PAID(o)), tops = TOPUPS.filter(t => t.uid === uid && t.status === 'completed');
  const claims = orders.filter(o => o.claimStatus).length, ammoN = paid.filter(o => o.isAmmo).length, boxes = (window.getBoxOpens?.() || []).filter(b => b.uid === uid);
  const last = paid.map(o => tsMs(o.createdAt)).sort((a, b) => b - a)[0];
  const tile = (k, v) => `<div class="rounded-xl bg-mist px-3 py-2.5"><p class="text-slate">${k}</p><p class="text-base font-semibold text-ink">${v}</p></div>`;
  const warn = claims >= 3 || (ammoN >= 4 && claims / ammoN > 0.3) ? `<p class="rounded-xl bg-red-50 text-red-500 px-3 py-2.5">⚠ เคลมแล้ว ${claims} ครั้งจาก ${ammoN} ออเดอร์ไก่กระสุน ตรวจให้ละเอียดก่อนคืนเงิน</p>` : '';
  const draw = (rv = '') => { box.innerHTML = `${warn}<div class="grid grid-cols-2 gap-2">${tile('ใช้จ่ายรวม', '฿' + money(paid.reduce((t, o) => t + num(o.amount), 0)))}${tile('ออเดอร์สำเร็จ', paid.length)}${tile('เติมเงินรวม', '฿' + money(tops.reduce((t, x) => t + num(x.amount), 0)))}${tile('เครดิตคงเหลือ', '฿' + money(u.walletBalance))}${tile('เคลมไอดี', claims)}${tile('เปิดกล่องสุ่ม', boxes.length + ' ครั้ง')}${tile('ซื้อล่าสุด', last ? fmtDate(last) : '-')}${tile('รีวิว', rv || '…')}</div>${u.facebook ? `<p class="text-slate">Facebook: ${adminEsc(u.facebook)}</p>` : ''}`; };
  draw();
  try {
    const s = await getDocs(query(collection(db, 'reviews'), where('uid', '==', uid), limit(50)));
    if (uid === umUid) draw(s.size ? `${s.size} · เฉลี่ย ${(s.docs.reduce((t, d) => t + num(d.data().stars), 0) / s.size).toFixed(1)}★` : 'ยังไม่มี');
  } catch (e) { if (uid === umUid) draw('-'); }
}
function loadUserHistory() {
  const t = TOPUPS.filter(x => x.uid === umUid), o = ORDERS.filter(x => x.userId === umUid);
  $('um-topups').innerHTML = t.length ? t.map(x => `<div class="py-2 flex justify-between gap-3"><span>${adminEsc(fmtDate(x.createdAt))} · ${x.paymentMethod === 'angpao' ? 'ซองอั่งเปา (อัตโนมัติ)' : x.paymentMethod === 'truemoney' ? 'TrueMoney' : 'พร้อมเพย์'}</span><span class="font-mono">฿${money(x.amount)} · ${(TOPUP_UI[x.status] || [x.status])[0]}</span></div>`).join('') : '<p class="py-2 text-slate">ไม่มีรายการ</p>';
  $('um-orders').innerHTML = o.length ? o.map(x => `<div class="py-2 flex justify-between gap-3"><span class="min-w-0 truncate">${adminEsc(fmtDate(x.createdAt))} · ${adminEsc(x.productName)} ×${adminEsc(x.quantity || 1)}</span><span class="font-mono whitespace-nowrap">฿${money(x.amount)} · ${(ORDER_UI[x.status] || [x.status])[0]}</span></div>`).join('') : '<p class="py-2 text-slate">ไม่มีรายการ</p>';
}

// ==========================================
// SETTINGS
// ==========================================
async function loadAdminSettings() {
  const d = SETTINGS;
  let secrets = {};
  try { const s = await getDoc(doc(db, 'system_private', 'secrets')); if (s.exists()) secrets = s.data(); } catch (_) {}
  const set = (id, v) => { const el = $(id); if (el) el.value = v ?? ''; };
  $('setting-ammo-closed').checked = d.ammoClosed === true; set('setting-ammo-closed-msg', d.ammoClosedMsg); set('setting-ammo-close-from', d.ammoCloseFrom); set('setting-ammo-close-to', d.ammoCloseTo);
  $('setting-auto-sort').checked = d.autoSort === true;
  $('setting-shop-closed').checked = d.shopClosed === true; set('setting-shop-closed-msg', d.shopClosedMsg); set('setting-shop-reopen', d.shopReopenAt ? msToLocal(d.shopReopenAt) : ''); set('setting-combo-pct', d.comboPct || 0);
  $('setting-announce-on').checked = d.announcementEnabled === true;
  set('setting-announce-text', d.announcementText ?? d.marqueeText);
  set('setting-announce-link', d.announcementLink);
  $('setting-popup-on').checked = d.popupEnabled === true;
  set('setting-popup-images', (d.popupImages || []).join('\n'));
  set('setting-vault-packages', (d.vaultPackages || []).map(p => `${p.days}=${p.price}`).join('\n'));
  set('setting-vault-trial', d.vaultTrialDays || 0);
  set('setting-contact-line', d.contactLine ?? d.lineId);
  set('setting-contact-facebook', d.contactFacebook);
  set('setting-contact-discord', d.contactDiscord ?? d.discordLink);
  set('setting-base-users', d.baseStats?.users); set('setting-base-sales', d.baseStats?.sales); set('setting-base-orders', d.baseStats?.orders);
  set('setting-promptpay-name', d.promptpayName); set('setting-promptpay-number', d.promptpayNumber ?? secrets.promptpayNo);
  set('setting-promptpay-qr-url', d.promptpayQrUrl);
  set('setting-slip-worker-url', d.slipWorkerUrl);
  $('setting-slip-auto').checked = d.slipAutoVerify === true;
  set('setting-discord-webhook', secrets.discordWebhook);
  set('setting-koen-label', d.koenLabel);
  $('rank-rows').innerHTML = rankTable(d).map((r, i) => `<tr><td class="py-1.5 pr-2 whitespace-nowrap"><span class="inline-flex items-center gap-1.5 font-semibold">${rankIcon(i, 'w-5 h-5')}${r.name}</span></td>
    <td class="px-1"><input id="rk-min-${i}" type="number" min="0" value="${i ? r.min : 0}" ${i ? '' : 'disabled title="ซื้อครั้งแรก"'} class="w-full apple-input px-2.5 py-1.5 text-xs font-mono"></td>
    <td class="px-1"><input id="rk-dis-${i}" type="number" min="0" max="100" step="0.1" value="${r.discount}" class="w-full apple-input px-2.5 py-1.5 text-xs font-mono"></td>
    <td class="px-1"><input id="rk-bon-${i}" type="number" min="0" max="100" step="0.1" value="${r.bonus}" class="w-full apple-input px-2.5 py-1.5 text-xs font-mono"></td></tr>`).join('');
  const inp = 'w-full apple-input px-2.5 py-1.5 text-xs';
  $('quick-rows').innerHTML = quickOf(d).map((q, i) => `<div class="grid grid-cols-2 sm:grid-cols-12 gap-2 items-center hq-row">
    <label class="hq-wide sm:col-span-2 flex items-center gap-2 text-xs font-semibold"><input id="hq-on-${i}" type="checkbox" ${q.on !== false ? 'checked' : ''}> การ์ด ${i + 1}</label>
    <select id="hq-icon-${i}" aria-label="ไอคอน" class="sm:col-span-2 ${inp}">${Object.entries(QUICK_ICONS).map(([k, [l]]) => `<option value="${k}" ${k === q.icon ? 'selected' : ''}>${l}</option>`).join('')}</select>
    <input id="hq-title-${i}" value="${adminEsc(q.title)}" maxlength="24" placeholder="ชื่อ" aria-label="ชื่อ" class="sm:col-span-2 ${inp}">
    <input id="hq-sub-${i}" value="${adminEsc(q.sub)}" maxlength="40" placeholder="คำอธิบาย" aria-label="คำอธิบาย" class="hq-wide sm:col-span-3 ${inp}">
    <input id="hq-href-${i}" value="${adminEsc(q.href)}" maxlength="300" placeholder="front/box.html" aria-label="ลิงก์" class="hq-wide sm:col-span-3 ${inp} font-mono"></div>`).join('');
  renderStatHints();
  renderSpotlightRows(d);
  const fx = d.festival || {};
  $('fx-on').checked = fx.on === true; $('fx-density').value = fx.density || 'mid';
  set('fx-msg', fx.msg); set('fx-link', fx.link);
  $('fx-until').value = fx.until ? new Date(fx.until - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';
}
function renderSpotlightRows(d = SETTINGS) {
  const sp = d.spotlight || {};
  $('sp-on').checked = sp.on === true; $('sp-kicker').value = sp.kicker || ''; $('sp-interval').value = sp.interval || '';
  const items = sp.items || [];
  const opts = (sel) => '<option value="">— ไม่เลือก —</option>' + PRODUCTS.map(p => `<option value="${adminEsc(p.id)}" ${p.id === sel ? 'selected' : ''}>${adminEsc(p.name)}</option>`).join('');
  $('sp-rows').innerHTML = [0, 1, 2, 3, 4].map(i => `<div class="sp-row"><select id="sp-pid-${i}" aria-label="สินค้า ${i + 1}" class="w-full apple-input px-2.5 py-1.5 text-xs">${opts(items[i]?.id)}</select>
    <input id="sp-tag-${i}" value="${adminEsc(items[i]?.tagline)}" maxlength="80" placeholder="ข้อความโปรย ${i + 1}" aria-label="ข้อความโปรย ${i + 1}" class="w-full apple-input px-2.5 py-1.5 text-xs">${i ? `<button type="button" onclick="spUp(${i})" title="เลื่อนขึ้น" aria-label="เลื่อนขึ้น" class="apple-explore-pill px-2.5 py-1 text-xs">↑</button>` : '<span style="width:38px"></span>'}</div>`).join('');
}
/** Swap spotlight row i with the one above it (the order here is the order on the home page). */
function spUp(i) {
  for (const k of ['sp-pid-', 'sp-tag-']) { const a = $(k + i), b = $(k + (i - 1)), t = a.value; a.value = b.value; b.value = t; }
}
async function saveSpotlight() {
  const items = [0, 1, 2, 3, 4].map(i => ({ id: $(`sp-pid-${i}`).value, tagline: $(`sp-tag-${i}`).value.trim().slice(0, 80) })).filter(x => x.id);
  const spotlight = { on: $('sp-on').checked, kicker: $('sp-kicker').value.trim().slice(0, 30), interval: Math.min(30, Math.max(3, Math.round(num($('sp-interval').value)) || 6)), items };
  if (spotlight.on && !items.length) return triggerToast('เลือกสินค้าอย่างน้อย 1 รายการ', 'error');
  try { await setDoc(doc(db, 'system', 'settings'), { spotlight, updatedAt: serverTimestamp() }, { merge: true }); triggerToast('บันทึกสินค้าแนะนำแล้ว', 'success'); }
  catch (e) { console.warn(e); triggerToast('บันทึกไม่สำเร็จ', 'error'); }
}
async function saveFestival() {
  const until = $('fx-until').value ? new Date($('fx-until').value).getTime() : 0;
  const link = $('fx-link').value.trim();
  if (link && safeHref(link) === '#') return triggerToast('ลิงก์ใช้ไม่ได้ ใส่หน้าในเว็บหรือ https://', 'error');
  const festival = { on: $('fx-on').checked, density: ['low', 'mid', 'high'].includes($('fx-density').value) ? $('fx-density').value : 'mid', msg: $('fx-msg').value.trim().slice(0, 120), link: link.slice(0, 300), until, v: Date.now() };
  try { await setDoc(doc(db, 'system', 'settings'), { festival, updatedAt: serverTimestamp() }, { merge: true }); triggerToast('บันทึกเทศกาลแล้ว', 'success'); }
  catch (e) { console.warn(e); triggerToast('บันทึกไม่สำเร็จ', 'error'); }
}
/** Home shortcut cards, saved on their own (merge) like the ranks. */
async function saveHomeQuick() {
  const v = (id) => ($(id)?.value || '').trim();
  const homeQuick = [0, 1, 2, 3].map(i => ({ on: $(`hq-on-${i}`).checked, icon: QUICK_ICONS[v(`hq-icon-${i}`)] ? v(`hq-icon-${i}`) : 'star', title: v(`hq-title-${i}`).slice(0, 24), sub: v(`hq-sub-${i}`).slice(0, 40), href: v(`hq-href-${i}`).slice(0, 300) }));
  const bad = homeQuick.find(q => q.on && (!q.title || safeHref(q.href) === '#'));
  if (bad) return triggerToast(!bad.title ? 'การ์ดที่เปิดอยู่ต้องมีชื่อ' : `ลิงก์ "${bad.href || '(ว่าง)'}" ใช้ไม่ได้ ใส่หน้าในเว็บหรือ https://`, 'error');
  try { await setDoc(doc(db, 'system', 'settings'), { homeQuick, updatedAt: serverTimestamp() }, { merge: true }); triggerToast('บันทึกทางลัดแล้ว', 'success'); }
  catch (e) { console.warn(e); triggerToast('บันทึกไม่สำเร็จ', 'error'); }
}
function renderStatHints() {
  const b = SETTINGS.baseStats || {};
  const hint = (id, key, fmt = (x) => Math.round(x).toLocaleString('th-TH')) => { const el = $(id); if (el) el.textContent = `จริงในระบบ ${fmt(num(STATS[key]))} · หน้าเว็บแสดง ${fmt(num(b[key]) + num(STATS[key]))}`; };
  hint('stat-actual-users', 'users'); hint('stat-actual-sales', 'sales', (x) => money(x, 0)); hint('stat-actual-orders', 'orders');
}
async function handleSaveSettings(e) {
  e.preventDefault();
  const v = (id) => ($(id)?.value || '').trim();
  const webhook = v('setting-discord-webhook');
  if (webhook && !/^https:\/\/(discord(app)?\.com)\/api\/webhooks\//.test(webhook)) return triggerToast('Discord Webhook URL ไม่ถูกต้อง', 'error');
  const n = (id) => Math.max(0, Math.floor(num(v(id))));
  const payload = {
    ammoClosed: $('setting-ammo-closed').checked, ammoClosedMsg: v('setting-ammo-closed-msg'), ammoCloseFrom: v('setting-ammo-close-from') && v('setting-ammo-close-to') ? v('setting-ammo-close-from') : '', ammoCloseTo: v('setting-ammo-close-from') && v('setting-ammo-close-to') ? v('setting-ammo-close-to') : '',
    autoSort: $('setting-auto-sort').checked,
    shopClosed: $('setting-shop-closed').checked, shopClosedMsg: v('setting-shop-closed-msg'), shopReopenAt: localToMs(v('setting-shop-reopen')) || 0, comboPct: Math.min(50, Math.max(0, Math.floor(num(v('setting-combo-pct'))))),
    announcementEnabled: $('setting-announce-on').checked, announcementText: v('setting-announce-text'), announcementLink: v('setting-announce-link'),
    popupEnabled: $('setting-popup-on').checked, popupImages: v('setting-popup-images').split('\n').map(x => formatUrl(x.trim())).filter(Boolean).slice(0, 6),
    vaultPackages: v('setting-vault-packages').split('\n').map(l => l.split('=').map(x => Math.round(num(x)))).filter(([d, p]) => d >= 1 && d <= 365 && p > 0).slice(0, 4).map(([days, price]) => ({ days, price })),
    vaultTrialDays: Math.min(365, n('setting-vault-trial')),
    contactLine: v('setting-contact-line'), contactFacebook: formatUrl(v('setting-contact-facebook')), contactDiscord: formatUrl(v('setting-contact-discord')),
    baseStats: { users: n('setting-base-users'), sales: n('setting-base-sales'), orders: n('setting-base-orders') },
    promptpayName: v('setting-promptpay-name'), promptpayNumber: v('setting-promptpay-number'), promptpayQrUrl: formatUrl(v('setting-promptpay-qr-url')),
    slipWorkerUrl: formatUrl(v('setting-slip-worker-url')), slipAutoVerify: $('setting-slip-auto').checked, koenLabel: v('setting-koen-label'),
    lineId: deleteField(), discordLink: deleteField(), marqueeText: deleteField(), ribbonText: deleteField(), ribbonLinkText: deleteField(), ribbonLinkUrl: deleteField(),
    updatedAt: serverTimestamp()
  };
  try {
    await setDoc(doc(db, 'system', 'settings'), payload, { merge: true });
    await setDoc(doc(db, 'system_private', 'secrets'), { discordWebhook: webhook, updatedAt: serverTimestamp() }, { merge: true });
    audit('บันทึกตั้งค่าร้าน', '', ['ammoClosed', 'shopClosed', 'comboPct', 'ammoCloseFrom', 'ammoCloseTo', 'announcementEnabled', 'slipWorkerUrl'].filter(k => auditVal(payload[k]) !== auditVal(SETTINGS[k])).map(k => `${k}: ${auditVal(SETTINGS[k])} → ${auditVal(payload[k])}`).join('; '));
    triggerToast('บันทึกการตั้งค่าแล้ว', 'success');
  } catch (err) { console.warn(err); triggerToast('บันทึกไม่สำเร็จ', 'error'); }
}
/** Ranks are saved on their own (merge), so this button never touches the other settings. */
async function saveRanks() {
  const v = (id) => Math.max(0, num($(id)?.value));
  const ranks = [0, 1, 2, 3, 4, 5, 6].map(i => ({ min: i ? Math.round(v(`rk-min-${i}`)) : 0, discount: Math.min(100, v(`rk-dis-${i}`)), bonus: Math.min(100, v(`rk-bon-${i}`)) }));
  const mins = ranks.slice(1).map(r => r.min).filter(Boolean);
  if (mins.some((m, i) => i && m <= mins[i - 1])) return triggerToast('ยอดเติมสะสมของยศที่สูงกว่าต้องมากกว่ายศก่อนหน้า', 'error');
  try { await setDoc(doc(db, 'system', 'settings'), { ranks, updatedAt: serverTimestamp() }, { merge: true }); triggerToast('บันทึกยศแล้ว', 'success'); }
  catch (e) { console.warn(e); triggerToast('บันทึกไม่สำเร็จ', 'error'); }
}
/** One-off: topupTotal = completed top-ups (money in), hasBought = any order that was not cancelled. */
async function recountRanks(btn) {
  if (!confirm('คำนวณยอดเติมสะสมและสถานะการซื้อของลูกค้าทุกคนจากประวัติ?')) return;
  btn.disabled = true;
  try {
    const [tops, ords] = await Promise.all([getDocs(query(collection(db, 'topup_transactions'), where('status', '==', 'completed'))), getDocs(collection(db, 'orders'))]);
    const sum = {}, bought = new Set();
    tops.forEach(d => { const t = d.data(); if (t.uid) sum[t.uid] = (sum[t.uid] || 0) + num(t.amount); });
    ords.forEach(d => { const o = d.data(); if (o.userId && o.status !== 'cancelled') bought.add(o.userId); });
    const list = USERS.filter(u => num(u.topupTotal) !== Math.round((sum[u.uid] || 0) * 100) / 100 || !!u.hasBought !== bought.has(u.uid));
    for (let i = 0; i < list.length; i += 400) {
      const b = writeBatch(db);
      list.slice(i, i + 400).forEach(u => b.update(doc(db, 'users', u.uid), { topupTotal: Math.round((sum[u.uid] || 0) * 100) / 100, hasBought: bought.has(u.uid) }));
      await b.commit();
    }
    triggerToast(`อัปเดต ${list.length} บัญชีแล้ว`, 'success');
  } catch (e) { console.warn(e); triggerToast('คำนวณไม่สำเร็จ', 'error'); }
  btn.disabled = false;
}
window.saveRanks = saveRanks; window.recountRanks = recountRanks;

async function uploadQr() {
  const file = $('qr-file').files?.[0];
  if (!file) return triggerToast('กรุณาเลือกรูป QR', 'error');
  const btn = $('btn-upload-qr'); btn.disabled = true;
  try {
    const image = await compressImage(file, 900, 0.9, 700000);
    await setDoc(doc(db, 'system', 'promptpay_qr'), { image, updatedAt: serverTimestamp() });
    $('qr-file').value = '';
    triggerToast('อัปโหลด QR แล้ว', 'success');
  } catch (err) { triggerToast(err.message || 'อัปโหลดไม่สำเร็จ', 'error'); }
  finally { btn.disabled = false; }
}
async function removeQr() {
  if (!confirm('ลบรูป QR ที่อัปโหลด? (ถ้ามีลิงก์รูป QR ระบบจะใช้ลิงก์แทน)')) return;
  try { await deleteDoc(doc(db, 'system', 'promptpay_qr')); triggerToast('ลบ QR แล้ว', 'success'); } catch (e) { triggerToast('ลบไม่สำเร็จ', 'error'); }
}
async function testWebhook() {
  try { await callWorker('/notify', { kind: 'test' }); triggerToast('ส่งข้อความทดสอบแล้ว ตรวจใน Discord', 'success'); }
  catch (e) { triggerToast(e.message, 'error'); }
}

Object.assign(window, {
  parseCsv, duplicateProduct, copyProductLink, exportProductsCsv, importProductsCsv,
  createAuction, removeAuction,
  renderWinback, sendWinback,
  saveSpotlight, saveFestival,
  saveHomeQuick,
  renderDashboard, applyTypeUi, setRentalFilter, closeRental, renderAdminRentals,
  handlePinSetupSubmit, handlePinUnlockSubmit, promptResetPin, lockAdminSession, switchAdminTab,
  openStockModal, closeStockModal, handleStockTextareaInput, submitBulkStockImport, deleteSingleStockItem, openStockModalQuick,
  moderateReview, ammoPreview, openProductModal, closeProductModal, handleProductFormSubmit, deleteAdminProduct, setProductType, setKoenLabelPreset, setImagePreset,
  updateImagePreview, filterAdminProducts, toggleFeatured, handleCategoryChange, updateServiceSummary, syncServiceRateToPrice, setServiceUnitPreset,
  applyServiceTemplate, editCategory, resetCategoryForm, toggleCategoryKind, handleCategorySubmit, deleteCategory,
  exportOrdersCsv, resolveAmmoClaim, checkStockAll, fixStockAll, renderStockList, syncStockPick, toggleStockPickAll, deleteStockPicked, clearStockAll, loadAudit, renderAudit, exportAuditCsv, useReply, spUp, saveReplies, monthReport, saveSlipFee, monthStats, exportBackup, renderAdminOrders, refreshOrders, approveOrder, startWork, finishServiceOrder, cancelOrder, clearGamePassword, openNote, saveOrderNote, viewSlip,
  renderAdminTopups, approveTopup, rejectTopup, saveTopupPromo, editTopupPromo, resetTopupPromo, deleteTopupPromo,
  renderAdminUsers, grantVault, openUserModal, userModalTab, saveUserInfo, saveUserWallet,
  handleSaveSettings, uploadQr, removeQr, testWebhook, closeModal,
  getProductsForPromo: () => PRODUCTS, getCategoriesForPromo: () => CATS
});

// ---------- Ctrl/⌘+K: jump to any tab by typing ----------
(() => {
  let box = null;
  const close = () => { box?.remove(); box = null; };
  const open = () => {
    if (box) return close();
    const tabs = [...document.querySelectorAll('[id^="admin-tab-btn-"]')].filter(b => !b.classList.contains('hidden'));
    box = document.createElement('div');
    box.style.cssText = 'position:fixed;inset:0;z-index:100;background:rgba(0,0,0,.35);display:flex;justify-content:center;align-items:flex-start;padding-top:12vh';
    box.innerHTML = '<div style="width:min(92vw,440px);background:#fff;border-radius:20px;padding:12px;box-shadow:0 20px 60px rgba(0,0,0,.3)"><input type="search" placeholder="ไปที่… (เช่น ออเดอร์, กล่องสุ่ม, ตั้งค่า)" class="w-full apple-input px-4 py-2.5 text-sm" aria-label="ค้นหาเมนู"><div class="mt-2 space-y-1 text-sm" style="max-height:50vh;overflow:auto"></div></div>';
    document.body.appendChild(box);
    const inp = box.querySelector('input'), list = box.firstElementChild.lastElementChild;
    const draw = () => { const q = inp.value.trim().toLowerCase(); list.innerHTML = ''; tabs.filter(b => b.textContent.toLowerCase().includes(q)).forEach((b, i) => { const x = document.createElement('button'); x.type = 'button'; x.className = 'w-full text-left rounded-xl px-3 py-2 hover:bg-mist' + (i ? '' : ' bg-mist'); x.textContent = b.textContent.trim(); x.onclick = () => { close(); b.click(); }; list.appendChild(x); }); };
    inp.oninput = draw; draw(); inp.focus();
    inp.onkeydown = (e) => { if (e.key === 'Enter') list.querySelector('button')?.click(); };
    box.onclick = (e) => { if (e.target === box) close(); };
  };
  document.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); open(); } else if (e.key === 'Escape') close(); });
})();
