import { db, auth } from "../firebase-config.js";
import {
  collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, writeBatch, onSnapshot, query, where, limit,
  runTransaction, Timestamp, serverTimestamp, increment, deleteField
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { watchCategories, KIND_LABEL, categoryOf, isServiceProduct, minQtyOf, unitOf } from "./categories.js";
import { esc, num, money, toast, fmtDate, openModal, closeModal, compressImage, maskName } from "./ui.js";

/**
 * ASTRAPHEX HUB — back office. The real gate is the Firebase custom claim admin:true (firestore.rules);
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
const PERM_LABEL = { orders: 'ทำคิวงานบริการ (เริ่มงาน/ส่งมอบ/หมายเหตุ)', pay: 'ยืนยันชำระ ยกเลิก/คืนเงิน ดูสลิป เติมเงิน (ทุกออเดอร์)', products: 'สินค้า สต็อก หมวดหมู่', promos: 'โค้ดส่วนลด และโปรเติมเงิน', rentals: 'ไอดีเช่า', boxes: 'กล่องสุ่ม', vault: 'โปรแกรมไอดีไก่', users: 'ผู้ใช้ (ดู/ปรับเครดิต/ข้อมูลติดต่อ)' };
let ADMIN = false, PERMS = new Set();
const can = (p) => ADMIN || PERMS.has(p);
const STAFF_ONLY_QUEUE = () => !ADMIN && !can('pay'); // can work service jobs but not handle money
const TAB_OK = { dashboard: () => ADMIN, settings: () => ADMIN, products: () => can('products'), categories: () => can('products'), orders: () => can('orders') || can('pay'), topups: () => can('pay'), rentals: () => can('rentals'), boxes: () => can('boxes'), vault: () => can('vault'), users: () => can('users'), promos: () => can('promos') };
const tabOk = (t) => (TAB_OK[t] || (() => false))();
let PRODUCTS = [], CATS = [], ORDERS = [], TOPUPS = [], USERS = [], TPROMOS = [], RENTALS = [], STATS = {}, SETTINGS = {};
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
  if (can('products') || can('boxes') || can('promos')) onSnapshot(collection(db, 'products'), (s) => { PRODUCTS = s.docs.map(d => ({ ...d.data(), id: d.id })); renderAdminProducts(); updateAdminMetrics(); renderAdminCategories(); renderDashboard(); }, warn('สินค้า'));
  if (can('products') || can('boxes') || can('promos')) watchCategories((list) => { CATS = list; renderAdminCategories(); fillProductCategorySelect(); renderAdminProducts(); });
  if (can('pay')) onSnapshot(collection(db, 'orders'), (s) => { ORDERS = s.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => tsMs(b.createdAt) - tsMs(a.createdAt)); renderAdminOrders(); renderBadges(); }, warn('ออเดอร์'));
  if (can('pay')) onSnapshot(collection(db, 'topup_transactions'), (s) => { TOPUPS = s.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => tsMs(b.createdAt) - tsMs(a.createdAt)); renderAdminTopups(); renderBadges(); }, warn('รายการเติมเงิน'));
  if (can('rentals')) onSnapshot(collection(db, 'rentals'), (s) => { RENTALS = s.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => tsMs(b.createdAt) - tsMs(a.createdAt)); renderAdminRentals(); renderBadges(); }, warn('การเช่า'));
  if (can('users') || can('vault')) onSnapshot(collection(db, 'users'), (s) => { USERS = s.docs.map(d => ({ uid: d.id, ...d.data() })).sort((a, b) => tsMs(b.createdAt) - tsMs(a.createdAt)); renderAdminUsers(); renderDashboard(); document.dispatchEvent(new Event('adminusers')); }, warn('ผู้ใช้'));
  if (can('promos')) onSnapshot(collection(db, 'topup_promos'), (s) => { TPROMOS = s.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => num(a.minAmount) - num(b.minAmount)); renderTopupPromos(); });
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
  const rows = (list || PRODUCTS).filter(p => !q || String(p.name).toLowerCase().includes(q) || String(categoryOf(CATS, p.category)?.name || '').toLowerCase().includes(q) || (p.tags || []).some(t => String(t).toLowerCase().includes(q)));
  $('admin-products-empty')?.classList.toggle('hidden', rows.length > 0);
  tbody.innerHTML = rows.map(p => {
    const out = num(p.stock) <= 0;
    const id = adminEsc(JSON.stringify(p.id));
    const srv = isServiceProduct(p, CATS);
    return `<tr class="border-b border-hairline">
      <td class="py-3 px-4"><div class="w-14 h-10 rounded-lg overflow-hidden bg-mist border border-hairline"><img src="${adminEsc(p.image)}" alt="" class="w-full h-full object-cover" onerror="this.style.display='none'"></div></td>
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
}
function applyTypeUi() {
  const srv = $('prod-type').value === 'service';
  const on = 'flex-1 py-1.5 px-3 rounded-xl text-xs font-medium transition-all bg-gallery text-ink shadow-sm border border-hairline/50 flex items-center justify-center gap-1.5';
  const off = 'flex-1 py-1.5 px-3 rounded-xl text-xs font-medium transition-all text-slate hover:text-ink flex items-center justify-center gap-1.5';
  $('btn-type-account').className = srv ? off : on;
  $('btn-type-service').className = srv ? on : off;
  $('service-config-box')?.classList.toggle('hidden', !srv);
  $('rent-config-box')?.classList.toggle('hidden', srv);
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

function openProductModal(productId = null) {
  fillProductCategorySelect();
  const p = productId ? PRODUCTS.find(x => x.id === productId) : null;
  $('product-crud-form').reset();
  $('product-modal-heading').innerText = p ? 'แก้ไขสินค้า: ' + p.name : 'เพิ่มสินค้าใหม่';
  $('prod-edit-id').value = p?.id || '';
  if (p) {
    const set = (id, v) => { $(id).value = v ?? ''; };
    set('prod-name', p.name); set('prod-koen', p.koen); set('prod-koen-label', p.koenLabel); set('prod-price', p.price); set('prod-stock', p.stock ?? 0);
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
    set('prod-rent-rate', p.rentHourPrice); set('prod-rent-min', p.rentMinHours); set('prod-rent-deposit', p.rentDeposit);
    set('prod-rent-packages', (p.rentPackages || []).map(k => `${k.hours} ${k.price}`).join('\n'));
    $('prod-type').value = isServiceProduct(p, CATS) ? 'service' : 'account';
  } else {
    $('prod-stock').value = 0;
    $('prod-featured').checked = false;
    $('prod-rent-on').checked = false;
    $('prod-type').value = categoryOf(CATS, $('prod-category').value)?.kind === 'service' ? 'service' : 'account';
  }
  updateImagePreview(p?.image || '');
  applyTypeUi();
  $('product-form-modal').classList.remove('hidden'); $('product-form-modal').classList.add('flex');
}
function closeProductModal() { $('product-form-modal').classList.add('hidden'); $('product-form-modal').classList.remove('flex'); }

async function handleProductFormSubmit(e) {
  e.preventDefault();
  const editId = $('prod-edit-id').value.trim();
  const category = $('prod-category').value;
  const isSrv = $('prod-type').value === 'service';
  const rentOn = !isSrv && $('prod-rent-on').checked;
  const rentRate = rentOn ? num($('prod-rent-rate').value) : 0;
  const rentPackages = rentOn ? $('prod-rent-packages').value.split('\n').map(l => l.trim().split(/[\s,]+/).map(Number)).filter(r => r[0] >= 1 && r[1] > 0).map(r => ({ hours: Math.floor(r[0]), price: r[1] })) : [];
  if (rentOn && !(rentRate > 0) && !rentPackages.length) return triggerToast('ใส่ราคา/ชั่วโมง หรือแพ็กเกจเช่าอย่างน้อย 1 อย่าง', 'error');
  const price = rentOn ? (rentRate || Math.min(...rentPackages.map(k => k.price))) : (num($(isSrv ? 'prod-service-rate' : 'prod-price').value) || num($('prod-price').value));
  const image = formatUrl($('prod-image').value);
  const galleryText = $('prod-gallery').value.trim();
  const packages = $('prod-packages').value.split('\n').map(l => l.trim().split(/[\s,]+/).map(Number)).filter(r => r[0] >= 1).map(r => ({ qty: Math.floor(r[0]), bonus: Math.max(0, Math.floor(r[1]) || 0) }));
  const opt = (id) => $(id).value.trim() || deleteField();
  const fId = num($('prod-farm-id').value), fSelf = num($('prod-farm-self').value);
  const farmModes = isSrv && fId > 0 && fSelf > 0 ? [{ key: 'with_id', label: 'ให้ไอดีไปยืน', price: fId }, { key: 'self', label: 'ไปยืนเอง', price: fSelf }] : null;
  if (!(price > 0) && !farmModes) return triggerToast('กรุณาใส่ราคา', 'error');
  const id = editId || 'prod_' + Date.now().toString(36);
  const payload = {
    id, name: $('prod-name').value.trim(), category: category || deleteField(), koen: $('prod-koen').value.trim(), koenLabel: opt('prod-koen-label'),
    price: farmModes ? Math.min(fId, fSelf) : price, image,
    // service: free number (capacity). ID product: never typed, counted from stock_items (new = 0, edit = untouched)
    ...(isSrv ? { stock: Math.max(0, parseInt($('prod-stock').value, 10) || 0) } : editId ? {} : { stock: 0 }),
    gallery: galleryText ? galleryText.split('\n').map(s => formatUrl(s)).filter(Boolean) : (image ? [image] : []),
    tags: $('prod-tags').value.split(',').map(s => s.trim()).filter(Boolean), desc: $('prod-desc').value.trim(),
    specs: $('prod-specs').value.split('\n').map(s => s.trim()).filter(Boolean),
    productType: isSrv ? 'service' : 'account', featured: $('prod-featured').checked,
    serviceUnit: isSrv && $('prod-service-unit').value.trim() ? $('prod-service-unit').value.trim() : deleteField(),
    serviceMin: isSrv && Math.floor(num($('prod-service-min').value)) > 0 ? Math.floor(num($('prod-service-min').value)) : deleteField(),
    serviceRate: deleteField(),
    rentHourPrice: rentRate > 0 ? rentRate : deleteField(),
    rentMinHours: rentOn && Math.floor(num($('prod-rent-min').value)) > 1 ? Math.floor(num($('prod-rent-min').value)) : deleteField(),
    rentDeposit: rentOn && num($('prod-rent-deposit').value) > 0 ? num($('prod-rent-deposit').value) : deleteField(),
    rentPackages: rentPackages.length ? rentPackages : deleteField(),
    packages: packages.length ? packages : deleteField(), farmModes: farmModes || deleteField(),
    serviceHours: opt('prod-hours'), hoursOpen: opt('prod-hours-open'), hoursClose: opt('prod-hours-close'),
    infoLines: opt('prod-info'), howTo: opt('prod-howto'), warrantyText: opt('prod-warranty'),
    updatedAt: serverTimestamp(), ...(editId ? {} : { createdAt: serverTimestamp() })
  };
  try { await setDoc(doc(db, 'products', id), payload, { merge: true }); triggerToast('บันทึกสินค้าแล้ว', 'success'); closeProductModal(); }
  catch (err) { console.warn(err); triggerToast('บันทึกสินค้าไม่สำเร็จ', 'error'); }
}
async function deleteAdminProduct(id) {
  if (!confirm('ลบสินค้านี้? (ไอดีที่ยังไม่ขายในสต็อกจะเข้าถึงไม่ได้)')) return;
  try { await deleteDoc(doc(db, 'products', id)); triggerToast('ลบสินค้าแล้ว', 'success'); } catch (e) { triggerToast('ลบไม่สำเร็จ', 'error'); }
}
function openStockModalQuick() { const p = PRODUCTS.find(x => !isServiceProduct(x, CATS)); p ? openStockModal(p.id) : triggerToast('ยังไม่มีสินค้าประเภทไอดีเกม', 'error'); }

// ---- bulk stock ----
let currentStockProductId = null, parsedStockItems = [];
function parseStockLines(text) {
  const items = [], seen = new Set(); let dup = false;
  text.split('\n').map(l => l.trim()).filter(Boolean).forEach(line => {
    const m = line.match(/^(?:email|user|username)\s+(\S+)\s+(?:password|pass|pwd)\s+(.+)$/i) || line.match(/^([^:\s|]+)\s*[:|]\s*(.+)$/) || line.match(/^(\S+)\s+(\S+)$/);
    if (!m) return;
    const [u, p] = [m[1].trim(), m[2].trim()];
    if (seen.has(u.toLowerCase())) { dup = true; return; }
    seen.add(u.toLowerCase()); items.push({ username: u, password: p });
  });
  return { items, hasDuplicates: dup };
}
function handleStockTextareaInput(val) {
  const { items, hasDuplicates } = parseStockLines(val);
  parsedStockItems = items;
  $('stock-parsed-counter').textContent = `ตรวจพบ: ${items.length} รายการพร้อมนำเข้า`;
  $('btn-add-stock-label').textContent = `บันทึกและนำเข้าสต็อก (${items.length} ชิ้น)`;
  $('stock-duplicate-warning').classList.toggle('hidden', !hasDuplicates);
}
function openStockModal(id) {
  currentStockProductId = id;
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
      chunk.forEach(it => batch.set(doc(collection(prodRef, 'stock_items')), { username: it.username, password: it.password, status: 'available', addedAt: serverTimestamp(), addedBy: me?.uid || '' }));
      batch.update(prodRef, { stock: increment(chunk.length) });
      await batch.commit();
    }
    triggerToast(`นำเข้าไอดี ${parsedStockItems.length} รายการแล้ว`, 'success');
    $('bulk-stock-textarea').value = ''; handleStockTextareaInput('');
    loadAvailableStockItems(currentStockProductId);
  } catch (e) { console.warn(e); triggerToast('นำเข้าไม่สำเร็จ', 'error'); }
  finally { btn.disabled = false; }
}
async function loadAvailableStockItems(id) {
  const tbody = $('stock-items-list-body'); tbody.innerHTML = '';
  let items = [];
  try { items = (await getDocs(query(collection(db, 'products', id, 'stock_items'), where('status', '==', 'available')))).docs.map(d => ({ id: d.id, ...d.data() })); } catch (e) { console.warn(e); }
  $('stock-available-count').textContent = items.length;
  $('stock-modal-current-count').textContent = items.length;
  $('stock-items-empty').classList.toggle('hidden', items.length > 0);
  const p = PRODUCTS.find(x => x.id === id);
  if (p && num(p.stock) !== items.length && !isServiceProduct(p, CATS)) {
    triggerToast(`สต็อกที่แสดง (${num(p.stock)}) ไม่ตรงกับไอดีจริง (${items.length}) · ปรับให้ตรงแล้ว`);
    updateDoc(doc(db, 'products', id), { stock: items.length }).catch(() => {});
  }
  tbody.innerHTML = items.map((it, i) => `<tr><td class="py-2.5 px-3 text-slate w-8">${i + 1}.</td><td class="py-2.5 px-3 font-semibold select-all">${adminEsc(it.username)}</td><td class="py-2.5 px-3 text-slate">••••••••</td>
    <td class="py-2.5 px-3 text-right"><button onclick='deleteSingleStockItem(${adminEsc(JSON.stringify(id))}, ${adminEsc(JSON.stringify(it.id))})' class="text-red-500 text-[11px] hover:underline">ลบออก</button></td></tr>`).join('');
}
async function deleteSingleStockItem(pid, itemId) {
  if (!confirm('นำไอดีนี้ออกจากคลัง?')) return;
  try {
    const b = writeBatch(db);
    b.delete(doc(db, 'products', pid, 'stock_items', itemId));
    b.update(doc(db, 'products', pid), { stock: increment(-1) });
    await b.commit();
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
  const todo = [
    [ORDERS.filter(o => o.status === 'pending_payment').length, 'ออเดอร์รอตรวจการชำระเงิน', 'orders'],
    [TOPUPS.filter(t => t.status === 'pending').length, 'รายการเติมเงินรอตรวจ', 'topups'],
    [RENTALS.filter(r => r.status === 'returned' || r.status === 'expired').length, 'การเช่ารอตรวจ (เปลี่ยนรหัส/คืนมัดจำ)', 'rentals']
  ].filter(x => x[0]);
  $('dash-todo').innerHTML = todo.map(([n, t, tab]) => `<button type="button" onclick="switchAdminTab('${tab}')" class="w-full flex justify-between rounded-xl bg-mist px-3 py-2 text-left"><span>${t}</span><b class="text-launchOrange">${n}</b></button>`).join('')
    + low.slice(0, 6).map(p => `<button type="button" onclick="switchAdminTab('products')" class="w-full flex justify-between rounded-xl bg-mist px-3 py-2 text-left"><span class="truncate">สต็อกเหลือน้อย: ${adminEsc(p.name)}</span><b class="${num(p.stock) <= 0 ? 'text-red-500' : 'text-launchOrange'}">${num(p.stock)}</b></button>`).join('')
    || '<p class="text-slate">ไม่มีเรื่องค้าง</p>';
  if (!todo.length && !low.length) $('dash-todo').innerHTML = '<p class="text-slate">ไม่มีเรื่องค้าง</p>';
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
    return `<tr class="border-b border-hairline">
      <td class="py-3 px-4 font-medium">${c.image ? `<img src="${adminEsc(c.image)}" alt="" class="inline-block w-10 h-6 object-cover rounded mr-2 align-middle">` : ''}${adminEsc(c.name)}<div class="text-[11px] text-slate font-mono font-normal">${adminEsc(c.id)}</div></td>
      <td class="py-3 px-4 text-slate">${adminEsc(KIND_LABEL[c.kind] || c.kind)}</td>
      <td class="py-3 px-4 font-mono">${c.kind === 'service' ? `ขั้นต่ำ ${adminEsc(c.minQty || 1)} ${adminEsc(c.unit || '')}` : '-'}</td>
      <td class="py-3 px-4 font-mono text-slate">${PRODUCTS.filter(p => p.category === c.id).length}</td>
      <td class="py-3 px-4 text-right whitespace-nowrap"><button onclick='editCategory(${id})' class="apple-explore-pill px-3 py-1 text-[11px]">แก้ไข</button> <button onclick='deleteCategory(${id})' class="apple-explore-pill px-3 py-1 text-[11px] text-red-500 border-red-200">ลบ</button></td></tr>`;
  }).join('') : `<tr><td colspan="5" class="py-12 text-center text-slate">ยังไม่มีหมวดหมู่ · สินค้าทั้งหมดจะแสดงในหน้าร้านตามปกติ</td></tr>`;
}
function editCategory(id) {
  const c = categoryOf(CATS, id); if (!c) return;
  const set = (k, v) => { $(k).value = v ?? ''; };
  set('cat-edit-id', c.id); set('cat-name', c.name); set('cat-kind', c.kind); set('cat-image', c.image); set('cat-unit', c.unit); set('cat-min', c.minQty); set('cat-order', c.order);
  toggleCategoryKind(); $('cat-name').focus();
}
function resetCategoryForm() { $('category-form').reset(); $('cat-edit-id').value = ''; toggleCategoryKind(); }
function toggleCategoryKind() { $('cat-service-fields')?.classList.toggle('hidden', $('cat-kind').value !== 'service'); }
async function handleCategorySubmit(e) {
  e.preventDefault();
  const kind = $('cat-kind').value;
  const id = $('cat-edit-id').value || 'cat_' + Date.now().toString(36);
  const data = { name: $('cat-name').value.trim(), kind, order: num($('cat-order').value), image: formatUrl($('cat-image').value) || deleteField(), updatedAt: serverTimestamp() };
  if (kind === 'service') { data.unit = $('cat-unit').value.trim() || 'กอง'; data.minQty = Math.max(1, Math.floor(num($('cat-min').value)) || 1); }
  else { data.unit = deleteField(); data.minQty = deleteField(); }
  try { await setDoc(doc(db, 'categories', id), data, { merge: true }); triggerToast('บันทึกหมวดหมู่แล้ว', 'success'); resetCategoryForm(); }
  catch (err) { triggerToast('บันทึกหมวดหมู่ไม่สำเร็จ', 'error'); }
}
async function deleteCategory(id) {
  const used = PRODUCTS.filter(p => p.category === id).length;
  if (!confirm(used ? `มีสินค้า ${used} รายการในหมวดนี้ สินค้าจะย้ายไป "สินค้าอื่น ๆ" ลบต่อหรือไม่?` : 'ยืนยันลบหมวดหมู่นี้?')) return;
  try { await deleteDoc(doc(db, 'categories', id)); triggerToast('ลบหมวดหมู่แล้ว', 'success'); } catch (e) { triggerToast('ลบไม่สำเร็จ', 'error'); }
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
  list.innerHTML = rows.slice(0, 200).map(o => {
    const id = adminEsc(JSON.stringify(o.id));
    const [label, cls] = ORDER_UI[o.status] || [o.status, 'bg-mist text-slate'];
    const srv = o.productType === 'service';
    const accs = Array.isArray(o.accountsDelivered) && o.accountsDelivered.length ? o.accountsDelivered : (o.accountDelivered?.username ? [o.accountDelivered] : []);
    const btn = (fn, text, primary) => `<button type="button" onclick='${fn}(${id})' class="${primary ? 'apple-pricing-pill' : 'apple-explore-pill'} px-3 py-1.5 text-[11px]">${text}</button>`;
    const actions = [
      can('pay') && o.status === 'pending_payment' && btn('approveOrder', srv ? 'ยืนยันชำระ › เข้าคิว' : 'ยืนยันชำระ & ส่งไอดี', true),
      o.status === 'processing' && (srv || !STAFF_ONLY_QUEUE()) && o.queueStatus !== 'working' && btn('startWork', 'เริ่มทำงาน', false),
      o.status === 'processing' && (srv || !STAFF_ONLY_QUEUE()) && btn('finishServiceOrder', 'ส่งมอบสำเร็จ', true),
      can('pay') && o.gamePassword && o.status === 'completed' && btn('clearGamePassword', 'ลบรหัสเกม', false),
      (!STAFF_ONLY_QUEUE() || (srv && o.status === 'processing')) && btn('openNote', o.adminNote ? 'แก้หมายเหตุ' : 'หมายเหตุถึงลูกค้า', false),
      can('pay') && o.hasSlip && btn('viewSlip', 'ดูสลิป', false),
      can('pay') && ['pending_payment', 'processing'].includes(o.status) && btn('cancelOrder', 'ยกเลิก', false)
    ].filter(Boolean).join(' ');
    return `<article class="apple-card p-4 sm:p-5 text-xs space-y-3">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0">
          <p class="font-mono font-bold text-ink">${adminEsc(o.orderNumber || o.id)} <span class="font-normal text-slate">· ${adminEsc(fmtDate(o.createdAt))}</span></p>
          <p class="text-sm font-semibold mt-0.5">${adminEsc(o.productName)} <span class="font-normal text-slate">× ${adminEsc(o.quantity || 1)} ${adminEsc(o.unit || '')}${num(o.bonusQty) ? ` (+แถม ${adminEsc(o.bonusQty)})` : ''}</span></p>
          <p class="text-slate mt-0.5">ผู้ซื้อ: <button type="button" class="text-appleBlue hover:underline" onclick='openUserModal(${adminEsc(JSON.stringify(o.userId || ''))})'>${adminEsc(buyerName(o))}</button>
            ${o.buyerFacebook ? ` · FB: <span class="select-all">${adminEsc(o.buyerFacebook)}</span>` : ''}${o.buyerEmail ? ` · อีเมล: <span class="select-all">${adminEsc(o.buyerEmail)}</span>` : ''}${o.buyerContact && !o.gameEmail ? ` · ในเกม: ${adminEsc(o.buyerContact)}` : ''}${o.playTime ? ` · เวลา: ${adminEsc(o.playTime)}` : ''}</p>
          ${o.gameEmail ? `<p class="text-slate">ล็อกอินเกม: <span class="font-mono select-all">${adminEsc(o.gameEmail)}</span> / <span class="font-mono select-all">${adminEsc(o.gamePassword || '(ลบแล้ว)')}</span></p>` : ''}
        </div>
        <div class="text-right">
          <p class="text-base font-display font-semibold">฿${money(o.amount)}</p>
          <p class="text-slate">${o.paymentMethod === 'wallet' ? 'เครดิต (ชำระแล้ว)' : o.paymentMethod === 'prize' ? '🎁 ของรางวัลกล่องสุ่ม' : o.paymentMethod === 'truemoney' ? 'TrueMoney' : 'พร้อมเพย์'}${o.promoCode ? ` · โค้ด ${adminEsc(o.promoCode)} -฿${money(o.discount)}` : ''}</p>
          <span class="inline-block mt-1 px-2.5 py-0.5 rounded-full font-semibold ${cls}">${label}${o.status === 'processing' && o.queueStatus === 'working' ? ' · กำลังทำ' : ''}</span>
        </div>
      </div>
      ${o.paymentProof && o.paymentMethod === 'truemoney' ? `<p class="text-slate break-all">ซอง: <a class="text-appleBlue select-all" href="${adminEsc(o.paymentProof)}" target="_blank" rel="noopener">${adminEsc(o.paymentProof)}</a></p>` : ''}
      ${accs.length ? `<p class="text-slate">ไอดีที่ส่งมอบ: ${accs.map(a => `<span class="font-mono select-all">${adminEsc(a.username)}:${adminEsc(a.password)}</span>`).join(', ')}</p>` : ''}
      ${o.adminNote ? `<p class="rounded-xl bg-[#e8f1fd] text-[#003d80] px-3 py-2">หมายเหตุถึงลูกค้า: ${adminEsc(o.adminNote)}</p>` : ''}
      <div class="flex flex-wrap gap-1.5 pt-1">${actions}</div>
    </article>`;
  }).join('');
}
function refreshOrders() { renderAdminOrders(); triggerToast('อัปเดตรายการล่าสุดแล้ว'); }

/** Public feed + counters for a finished order (stats/public, recent_orders). Called inside a transaction. */
function recordSale(txn, orderId, o) {
  if (o.paymentMethod === 'prize') return; // free loot-box prize: not a sale
  txn.set(doc(db, 'stats', 'public'), { orders: increment(1), sales: increment(num(o.amount)) }, { merge: true });
  txn.set(doc(db, 'recent_orders', orderId), { productName: String(o.productName || '').slice(0, 120), amount: num(o.amount), buyerMask: maskName(buyerName(o)), kind: o.productType === 'service' ? 'service' : 'account', createdAt: serverTimestamp() });
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
function openNote(orderId) {
  const o = ORDERS.find(x => x.id === orderId); if (!o) return;
  $('note-order-id').value = orderId;
  $('note-modal-order').textContent = `${o.orderNumber || orderId} · ${o.productName}`;
  $('note-text').value = o.adminNote || '';
  openModal('note-modal'); $('note-text').focus();
}
async function saveOrderNote(e) {
  e.preventDefault();
  const id = $('note-order-id').value, text = $('note-text').value.trim();
  try { await updateDoc(doc(db, 'orders', id), { adminNote: text || deleteField(), adminNoteAt: serverTimestamp() }); closeModal('note-modal'); triggerToast('บันทึกหมายเหตุแล้ว', 'success'); }
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
function renderAdminUsers() {
  const tbody = $('admin-users-table-body'); if (!tbody) return;
  $('metric-user-count').innerText = USERS.length;
  $('metric-user-balance').innerText = `฿${money(USERS.reduce((s, u) => s + num(u.walletBalance), 0), 0)}`;
  $('metric-user-admins').innerText = USERS.filter(u => u.role === 'admin').length;
  $('metric-user-suspended').innerText = USERS.filter(u => u.status === 'suspended').length;
  const q = ($('user-search').value || '').toLowerCase().trim();
  const rows = USERS.filter(u => !q || [u.username, u.email, u.contactEmail, u.facebook, u.uid].some(v => String(v || '').toLowerCase().includes(q)));
  $('admin-users-empty').classList.toggle('hidden', rows.length > 0);
  tbody.innerHTML = rows.slice(0, 300).map(u => `<tr class="border-b border-hairline">
    <td class="py-3 px-4"><p class="font-semibold">${adminEsc(u.username || '(ไม่มีชื่อ)')}</p><p class="text-[10px] text-slate font-mono">${adminEsc(u.uid)}</p></td>
    <td class="py-3 px-4 text-slate">${adminEsc(u.contactEmail || (/@tactical\.store$/.test(u.email || '') ? '' : u.email) || '-')}${u.facebook ? `<br>FB: ${adminEsc(u.facebook)}` : ''}</td>
    <td class="py-3 px-4 font-mono font-semibold">฿${money(u.walletBalance)}</td>
    <td class="py-3 px-4">${u.role === 'admin' ? '<span class="text-launchOrange font-semibold">Admin</span>' : u.role === 'staff' ? `<span class="font-semibold" title="${adminEsc((u.perms || []).map(p => PERM_LABEL[p] || p).join(', '))}">ทีมงาน (${(u.perms || []).length})</span>` : 'User'}</td>
    <td class="py-3 px-4">${u.status === 'suspended' ? '<span class="text-launchOrange font-semibold">ระงับ</span>' : '<span class="text-emerald-600">ปกติ</span>'}</td>
    <td class="py-3 px-4 text-slate">${adminEsc(fmtDate(u.createdAt))}</td>
    <td class="py-3 px-4 text-right"><button onclick='openUserModal(${adminEsc(JSON.stringify(u.uid))})' class="apple-pricing-pill px-3 py-1 text-[11px]">จัดการ</button></td></tr>`).join('');
}

let umUid = null;
function userModalTab(t) {
  ['info', 'wallet', 'history'].forEach(k => { $(`um-pane-${k}`).classList.toggle('hidden', k !== t); $(`um-tab-${k}`).className = `py-2 rounded-full ${k === t ? 'bg-gallery shadow-sm font-semibold' : 'text-slate'}`; });
  if (t === 'history') loadUserHistory();
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
  $('um-role').value = u.role === 'admin' ? 'admin' : 'user';
  $('um-perms').innerHTML = Object.entries(PERM_LABEL).map(([k, t]) => `<label class="flex items-start gap-2 py-1"><input type="checkbox" value="${k}" ${(u.perms || []).includes(k) ? 'checked' : ''}> <span>${adminEsc(t)}</span></label>`).join('');
  syncPermBox();
  document.querySelectorAll('#um-pane-info input[id^="um-"], #um-pane-info select').forEach(el => { if (['um-username', 'um-password', 'um-role', 'um-status'].includes(el.id) || el.closest('#um-perms-wrap')) el.disabled = !ADMIN; });
  $('um-status').value = u.status === 'suspended' ? 'suspended' : 'active';
  $('um-login-email').textContent = u.email || '-';
  $('um-balance').textContent = `฿${money(u.walletBalance)}`;
  showVault(u);
  $('um-worker-note').textContent = workerUrl() ? '' : 'ยังไม่ได้ตั้งค่า Worker: เปลี่ยนชื่อผู้ใช้สำหรับล็อกอิน / รหัสผ่าน / สิทธิ์ Admin / ระงับการล็อกอิน จะยังไม่มีผล (บันทึกได้เฉพาะข้อมูลในฐานข้อมูล)';
  $('um-amount').value = ''; $('um-wnote').value = '';
  userModalTab('info');
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
      ...(ADMIN ? { role: newRole, status, perms, ...(loginEmail ? { email: loginEmail } : {}) } : {}), adminUpdatedAt: serverTimestamp()
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
  } catch (err) { triggerToast(err.message === 'NEG' ? 'ยอดเงินติดลบไม่ได้' : 'ปรับยอดไม่สำเร็จ', 'error'); }
  finally { btn.disabled = false; }
}
async function loadWalletLogs() {
  const box = $('um-wallet-logs'); box.innerHTML = '<p class="py-3 text-slate">กำลังโหลด…</p>';
  try {
    const logs = (await getDocs(query(collection(db, 'wallet_logs'), where('uid', '==', umUid)))).docs.map(d => d.data()).sort((a, b) => tsMs(b.at) - tsMs(a.at)).slice(0, 20);
    box.innerHTML = logs.length ? logs.map(l => `<div class="py-2 flex justify-between gap-3"><span class="text-slate">${adminEsc(fmtDate(l.at))} · ${adminEsc(l.note || '-')}</span><span class="font-mono font-semibold ${num(l.delta) < 0 ? 'text-launchOrange' : 'text-emerald-600'}">${num(l.delta) >= 0 ? '+' : ''}${money(l.delta)}</span></div>`).join('') : '<p class="py-3 text-slate">ยังไม่มีประวัติ</p>';
  } catch (e) { box.innerHTML = '<p class="py-3 text-slate">โหลดไม่สำเร็จ</p>'; }
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
  renderStatHints();
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
    triggerToast('บันทึกการตั้งค่าแล้ว', 'success');
  } catch (err) { console.warn(err); triggerToast('บันทึกไม่สำเร็จ', 'error'); }
}
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
  renderDashboard, applyTypeUi, setRentalFilter, closeRental, renderAdminRentals,
  handlePinSetupSubmit, handlePinUnlockSubmit, promptResetPin, lockAdminSession, switchAdminTab,
  openStockModal, closeStockModal, handleStockTextareaInput, submitBulkStockImport, deleteSingleStockItem, openStockModalQuick,
  openProductModal, closeProductModal, handleProductFormSubmit, deleteAdminProduct, setProductType, setKoenLabelPreset, setImagePreset,
  updateImagePreview, filterAdminProducts, toggleFeatured, handleCategoryChange, updateServiceSummary, syncServiceRateToPrice, setServiceUnitPreset,
  applyServiceTemplate, editCategory, resetCategoryForm, toggleCategoryKind, handleCategorySubmit, deleteCategory,
  renderAdminOrders, refreshOrders, approveOrder, startWork, finishServiceOrder, cancelOrder, clearGamePassword, openNote, saveOrderNote, viewSlip,
  renderAdminTopups, approveTopup, rejectTopup, saveTopupPromo, editTopupPromo, resetTopupPromo, deleteTopupPromo,
  renderAdminUsers, grantVault, openUserModal, userModalTab, saveUserInfo, saveUserWallet,
  handleSaveSettings, uploadQr, removeQr, testWebhook, closeModal,
  getProductsForPromo: () => PRODUCTS, getCategoriesForPromo: () => CATS
});
