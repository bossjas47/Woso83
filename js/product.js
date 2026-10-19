import { db, auth } from "../firebase-config.js";
import { collection, doc, getDoc, getDocs, serverTimestamp, writeBatch } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { loadCategories, isServiceProduct, minQtyOf, unitOf, categoryOf } from "./categories.js";
import { esc, num, baht, money, toast, icon, ICONS, onSettings, workerBase, callWorker, notifyAdmin, maskName } from "./ui.js";
import { deliveryBadge, productCardHtml } from "./card.js";
import { mountPromptPay, promptpayReady, prepareSlip, slipErrorText } from "./pay.js";
import { evaluatePromo } from "./promo.js";
import { orderCardHtml } from "./orders-ui.js";

/**
 * Product page: details, quantity / packages / farm modes, and checkout.
 * Payment:
 *  - เครดิตในบัญชี: the Worker (/buy) checks price, promo and balance, then delivers a game ID at once
 *    (or queues a service) in one transaction. Needs the Worker URL in admin settings.
 *  - พร้อมเพย์ (with slip image) / TrueMoney: files a pending_payment order for an admin to approve.
 */
const FALLBACK = 'https://placehold.co/800x600/f5f5f7/86868b?text=ASTRAPHEX+HUB';
let allProducts = [], CATS = [], P = null;
let gallery = [], gIdx = 0;
let qty = 1, farmMode = '';
let promo = null, promoCode = null, discount = 0;
let method = 'wallet';
let balance = null, user = null;
let submitting = false;
let pp = null;

const $ = (id) => document.getElementById(id);
const isSrv = () => isServiceProduct(P, CATS);

// ---------- Load ----------
async function load() {
  const id = new URLSearchParams(location.search).get('id');
  CATS = await loadCategories();
  try { allProducts = (await getDocs(collection(db, 'products'))).docs.map(d => ({ ...d.data(), id: d.id })); }
  catch (e) { console.warn('products:', e); }
  P = allProducts.find(p => String(p.id) === String(id)) || null;
  $('product-loading-state').classList.add('hidden');
  if (!P) { $('product-not-found').classList.remove('hidden'); return; }
  $('product-content-stage').classList.remove('hidden');
  render();
  renderRelated();
  pp = mountPromptPay($('panel-pay-promptpay'), { getAmount: () => finalPrice(), idPrefix: 'pp' });
  switchProductPaymentTab(defaultMethod(), true);
  if (new URLSearchParams(location.search).get('action') === 'buy') setTimeout(scrollToCheckoutForm, 300);
}

function render() {
  const srv = isSrv();
  const unit = unitOf(P, CATS);
  document.title = `${P.name} — ASTRAPHEX HUB`;
  $('breadcrumb-product-name').textContent = P.name;
  $('breadcrumb-category').textContent = categoryOf(CATS, P.category)?.name || (srv ? 'งานบริการ' : 'ไอดีเกม');
  $('product-title-heading').textContent = P.name;
  $('product-kicker-label').textContent = categoryOf(CATS, P.category)?.name || 'Arena Breakout';
  gallery = (Array.isArray(P.gallery) && P.gallery.filter(Boolean).length ? P.gallery.filter(Boolean) : [P.image || FALLBACK]);
  updateGalleryView(0);
  $('product-thumbnail-strip').innerHTML = gallery.length > 1 ? gallery.map((u, i) => `<button type="button" onclick="updateGalleryView(${i})" class="gthumb w-16 h-12 rounded-xl overflow-hidden border shrink-0 ${i === 0 ? 'border-2 border-pricingBlue' : 'border-hairline opacity-70'}"><img src="${esc(u)}" alt="ภาพที่ ${i + 1}" class="w-full h-full object-cover"></button>`).join('') : '';
  renderBadges();
  const stock = Math.max(0, Math.floor(num(P.stock)));
  $('product-stock-line').innerHTML = stock <= 0 ? `<span class="text-launchOrange font-medium">${srv ? 'คิวเต็มชั่วคราว' : 'สินค้าหมด'}</span>`
    : srv ? `<span class="text-emerald-600 font-medium">รับงานได้อีก ${stock} ${esc(unit)}</span>` : `<span class="${stock <= 3 ? 'text-launchOrange' : 'text-emerald-600'} font-medium">คงเหลือ ${stock} ไอดี</span>`;
  $('product-desc-paragraph').textContent = P.desc || '';
  $('product-full-desc').textContent = P.desc || '-';
  const koen = String(P.koen || '').trim();
  $('product-tags').innerHTML = (koen && koen !== '-' ? `<span class="bg-mist text-ink text-[13px] font-medium px-3.5 py-1.5 rounded-full">${esc(P.koenLabel ? `${P.koenLabel}: ${koen}` : koen)}</span>` : '') +
    (P.tags || []).map(t => `<span class="bg-mist text-slate text-[13px] px-3 py-1.5 rounded-full">${esc(t)}</span>`).join('');
  const specs = Array.isArray(P.specs) ? P.specs : [];
  const kv = specs.filter(t => /^[^:：]{1,24}[:：]\s*\S/.test(t));
  const plain = specs.filter(t => !kv.includes(t));
  $('specs').classList.toggle('hidden', !specs.length);
  $('product-specs-grid').innerHTML = (kv.length ? `<div class="grid grid-cols-2 gap-3">${kv.map(t => { const i = t.search(/[:：]/); return `<div class="rounded-2xl bg-gallery p-4"><p class="text-xs text-slate">${esc(t.slice(0, i).trim())}</p><p class="text-[15px] font-semibold mt-0.5">${esc(t.slice(i + 1).trim())}</p></div>`; }).join('')}</div>` : '')
    + plain.map(t => `<div class="flex items-start gap-3"><span class="w-5 h-5 mt-0.5 rounded-full bg-appleBlue/10 text-appleBlue flex items-center justify-center shrink-0">${icon(ICONS.check, 'w-3 h-3', 3)}</span><span class="text-[15px]">${esc(t)}</span></div>`).join('');
  const lines = [[ICONS.queue, P.serviceHours], ...String(P.infoLines || '').split('\n').map(t => [null, t.trim()])].filter(l => l[1]);
  $('info-lines').innerHTML = lines.map(([ic, t]) => `<p class="flex gap-2 text-slate">${ic ? icon(ic, 'w-5 h-5 shrink-0', 1.8) : '<span>•</span>'}<span>${esc(t)}</span></p>`).join('');
  $('product-howto').textContent = P.howTo || (srv ? 'ชำระเงินแล้วทีมงานจะทักไปทาง Facebook เพื่อนัดเวลา และอัปเดตสถานะในเมนูออเดอร์ของฉัน' : 'ชำระด้วยเครดิตรับไอดีทันทีในเมนูออเดอร์ของฉัน หากชำระผ่านพร้อมเพย์ ไอดีจะแสดงเมื่อแอดมินตรวจสอบสลิปแล้ว');
  $('product-warranty').textContent = P.warrantyText || 'หากมีปัญหาเกี่ยวกับสินค้า ติดต่อทีมงานพร้อมเลขที่ออเดอร์';

  // buyer fields: services ask Facebook instead of e-mail
  $('email-field').classList.toggle('hidden', srv);
  $('facebook-field').classList.toggle('hidden', !srv);
  $('buyer-hint').textContent = srv ? 'ทีมงานใช้ Facebook ติดต่อเพื่อนัดเวลาทำงาน' : 'ใช้สำหรับติดต่อเรื่องไอดีที่ซื้อ ทีมงานจะไม่ขอรหัสผ่านอีเมลของคุณ';

  qty = minQtyOf(P, CATS);
  $('order-quantity-input').value = qty;
  $('order-quantity-input').min = qty;
  $('stepper-unit-label').textContent = unit;
  $('stepper-helper-hint').textContent = srv ? `ขั้นต่ำ ${qty} ${unit}` : 'ระบุจำนวนที่ต้องการ';
  farmMode = '';
  renderFarmModes();
  renderValuePacks();
  recalc();
}

function renderBadges() {
  $('product-badges').innerHTML = deliveryBadge(isSrv(), !!workerBase()) + (P.featured ? `<span class="badge badge-featured">${icon(ICONS.star, 'w-3.5 h-3.5', 2)}แนะนำ</span>` : '');
}

function renderRelated() {
  const others = allProducts.filter(p => p.id !== P.id).sort((a, b) => (b.category === P.category) - (a.category === P.category)).slice(0, 4);
  $('related-products-grid').innerHTML = others.map(p => {
    const srv = isServiceProduct(p, CATS);
    return productCardHtml({ p, isService: srv, unit: unitOf(p, CATS), min: minQtyOf(p, CATS), price: num(p.price) || num(p.serviceRate), stock: Math.floor(num(p.stock)), koen: '', categoryName: categoryOf(CATS, p.category)?.name, fallback: FALLBACK, instant: !!workerBase() });
  }).join('');
  $('related-products-grid').parentElement.classList.toggle('hidden', !others.length);
}

// ---------- Gallery ----------
function updateGalleryView(i) {
  if (i < 0 || i >= gallery.length) return;
  gIdx = i;
  $('product-main-image').src = gallery[i];
  $('gallery-counter-pill').textContent = `ภาพ ${i + 1} / ${gallery.length}`;
  $('gallery-counter-pill').classList.toggle('hidden', gallery.length < 2);
  document.querySelectorAll('.gthumb').forEach((b, k) => { b.classList.toggle('border-2', k === i); b.classList.toggle('border-pricingBlue', k === i); b.classList.toggle('opacity-70', k !== i); });
}
function openImageFull() { $('lightbox-img').src = gallery[gIdx]; $('lightbox').classList.remove('hidden'); $('lightbox').classList.add('flex'); }
function closeLightbox() { $('lightbox').classList.add('hidden'); $('lightbox').classList.remove('flex'); }
function lightboxStep(d) { updateGalleryView((gIdx + d + gallery.length) % gallery.length); $('lightbox-img').src = gallery[gIdx]; }
let touchX = null;
document.addEventListener('touchstart', e => { touchX = e.target.id === 'product-main-image' ? e.touches[0].clientX : null; }, { passive: true });
document.addEventListener('touchend', e => {
  if (touchX === null || gallery.length < 2) return;
  const dx = e.changedTouches[0].clientX - touchX; touchX = null;
  if (Math.abs(dx) > 40) updateGalleryView(Math.min(gallery.length - 1, Math.max(0, gIdx + (dx < 0 ? 1 : -1))));
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeLightbox(); });

// ---------- Quantity, packages, farm modes ----------
const maxQty = () => isSrv() ? 99999 : Math.max(1, Math.floor(num(P.stock)) || 1);
function setQty(n) {
  const min = minQtyOf(P, CATS);
  qty = Math.min(maxQty(), Math.max(min, Math.floor(num(n)) || min));
  $('order-quantity-input').value = qty;
  recalc();
}
const changeQuantity = (d) => setQty(qty + d);
const handleQuantityDirectInput = (v) => setQty(v);

const packagesOf = () => (Array.isArray(P.packages) ? P.packages : []).map(k => ({ qty: Math.floor(num(k.qty)), bonus: Math.floor(num(k.bonus)) })).filter(k => k.qty > 0).sort((a, b) => a.qty - b.qty);
const bonusFor = (q) => packagesOf().reduce((b, k) => (q >= k.qty ? k.bonus : b), 0);
function renderValuePacks() {
  const pk = packagesOf();
  $('packages-section').classList.toggle('hidden', !pk.length);
  const unit = unitOf(P, CATS);
  $('value-packs-grid').innerHTML = pk.map(k => `<button type="button" data-qty="${k.qty}" onclick="selectValuePack(${k.qty})" class="vpack text-left rounded-2xl p-4 bg-gallery border border-hairline transition">
    <span class="block text-xs text-slate">ซื้อ ${k.qty} ${esc(unit)}</span><span class="block text-lg font-heading font-semibold">฿${(k.qty * unitRate()).toLocaleString('th-TH')}</span>
    ${k.bonus ? `<span class="block text-xs text-appleBlue font-medium mt-0.5">แถม ${k.bonus} · ได้รวม ${k.qty + k.bonus}</span>` : ''}</button>`).join('');
}
const selectValuePack = (q) => setQty(q);

function unitRate() {
  const m = (P.farmModes || []).find(x => x.key === farmMode);
  if (m) return num(m.price);
  return isSrv() ? (num(P.serviceRate) || num(P.price)) : num(P.price);
}
function renderFarmModes() {
  const modes = P.farmModes || [];
  $('farm-modes-section').classList.toggle('hidden', !modes.length);
  farmMode = modes.length ? (modes.find(m => m.key === farmMode) || modes[0]).key : '';
  const unit = unitOf(P, CATS);
  $('farm-modes-grid').innerHTML = modes.map(m => `<button type="button" onclick="selectFarmMode(${esc(JSON.stringify(m.key))})" class="text-left rounded-2xl p-4 bg-gallery border transition ${m.key === farmMode ? 'border-2 border-pricingBlue' : 'border-hairline'}">
    <span class="block text-sm font-semibold">${esc(m.label)}</span><span class="block text-lg font-heading font-semibold mt-1">฿${num(m.price).toLocaleString('th-TH')}<span class="text-xs text-slate font-normal"> / ${esc(unit)}</span></span></button>`).join('');
  const srv = isSrv();
  const self = srv && modes.length && farmMode === 'self';
  $('service-extra-fields').classList.toggle('hidden', !(srv && !self));
  $('self-fields').classList.toggle('hidden', !self);
  $('farm-mode-note').textContent = farmMode === 'self' ? 'คุณเข้าเกมไปยืนเอง ร้านจะนัดเวลาและเชิญเข้าห้อง ไม่ต้องให้รหัสผ่าน' : farmMode === 'with_id' ? 'ให้อีเมลและรหัสผ่านเกม ทีมงานล็อกอินไปทำให้ และลบรหัสเมื่องานเสร็จ' : '';
}
function selectFarmMode(key) { farmMode = key; renderFarmModes(); renderValuePacks(); recalc(); }

// ---------- Price ----------
const subtotal = () => Math.round(qty * unitRate() * 100) / 100;
const finalPrice = () => Math.max(0, Math.round((subtotal() - discount) * 100) / 100);
function recalc() {
  if (!P) return;
  const unit = unitOf(P, CATS);
  const sub = subtotal();
  if (promo) {
    const r = evaluatePromo(promo, P, sub);
    discount = r.ok ? r.discount : 0;
  } else discount = 0;
  const fin = finalPrice();
  $('product-unit-price').textContent = baht(unitRate());
  $('product-unit-suffix').textContent = `/ ${unit}`;
  $('calc-qty-label').textContent = qty;
  $('calc-unit-label').textContent = unit;
  $('calc-subtotal').textContent = baht(sub);
  $('calc-discount-row').classList.toggle('hidden', !discount);
  $('calc-discount-val').textContent = `-${baht(discount)}`;
  $('calc-final-price').textContent = baht(fin);
  $('qty-buy-price').textContent = baht(fin);
  $('voucher-exact-total').textContent = baht(fin);
  const b = bonusFor(qty), total = qty + b;
  $('package-summary').textContent = b ? `ซื้อ ${qty} · แถม ${b} · ได้รวม ${total} ${unit}` : `ซื้อ ${qty} ${unit}`;
  const nx = packagesOf().find(k => k.qty > qty);
  $('package-next').textContent = nx ? `เพิ่มอีก ${nx.qty - qty} ${unit} รับแถม ${nx.bonus}` : '';
  $('real-rate').classList.toggle('hidden', !b || !fin);
  $('real-rate').textContent = `จ่าย ${baht(fin)} ได้ ${total} ${unit} ≈ ${baht(fin / total)}/${unit}`;
  document.querySelectorAll('.vpack').forEach(c => { const on = Number(c.dataset.qty) === qty; c.classList.toggle('border-2', on); c.classList.toggle('border-pricingBlue', on); });
  pp?.refresh();
  updateWalletPanel();
  updateButton();
}

function updateWalletPanel() {
  const fin = finalPrice();
  $('wallet-balance').textContent = !user ? 'เข้าสู่ระบบเพื่อดูยอด' : balance === null ? 'กำลังโหลด…' : `${money(balance)}฿`;
  const short = user && balance !== null && balance < fin;
  $('wallet-topup-link').classList.toggle('hidden', !short);
  $('wallet-note').textContent = !workerBase() ? 'ร้านยังไม่เปิดชำระด้วยเครดิต กรุณาเลือกพร้อมเพย์หรือ TrueMoney'
    : isSrv() ? 'ตัดเงินจากเครดิตทันที งานเข้าคิวให้ทีมงานเริ่มทำได้เลย' : 'ตัดเงินจากเครดิตทันที ไอดีเกมแสดงให้เห็นทันทีหลังชำระ';
}
function updateButton() {
  const btn = $('btn-confirm-product-order');
  if (submitting) return;
  const out = num(P?.stock) <= 0;
  const fin = baht(finalPrice());
  btn.disabled = out || (method === 'wallet' && (!workerBase() || (user && balance !== null && balance < finalPrice())));
  btn.textContent = out ? (isSrv() ? 'คิวเต็มชั่วคราว' : 'สินค้าหมด') : method === 'wallet' ? `ชำระด้วยเครดิต ${fin}` : `แจ้งชำระเงิน ${fin}`;
}

// ---------- Promo ----------
async function applyProductPromo() {
  const code = $('product-promo-input').value.trim().toUpperCase();
  const msg = $('promo-status-msg');
  const show = (t, ok) => { msg.textContent = t; msg.className = `text-sm pt-2 ${ok ? 'text-appleBlue' : 'text-launchOrange'}`; };
  if (!code) { promo = null; promoCode = null; msg.className = 'hidden'; recalc(); return; }
  if (!/^[A-Z0-9_-]{2,40}$/.test(code)) { show('รูปแบบโค้ดไม่ถูกต้อง', false); return; }
  $('btn-apply-promo').disabled = true;
  let data = null;
  try { const s = await getDoc(doc(db, 'promo_codes', code)); if (s.exists()) data = s.data(); } catch (e) { console.warn('promo:', e); }
  $('btn-apply-promo').disabled = false;
  const r = evaluatePromo(data, P, subtotal());
  if (!r.ok) { promo = null; promoCode = null; show(r.message, false); }
  else { promo = data; promoCode = code; show(`ใช้โค้ด ${code} สำเร็จ (${r.message})`, true); toast(`ใช้โค้ด ${code} แล้ว`, 'success'); }
  recalc();
}

// ---------- Payment tabs ----------
let methodPicked = false;
const defaultMethod = () => (workerBase() ? 'wallet' : 'promptpay');
function switchProductPaymentTab(m, auto = false) {
  if (!auto) methodPicked = true;
  method = m;
  ['wallet', 'promptpay', 'truemoney'].forEach(k => {
    $(`panel-pay-${k}`).classList.toggle('hidden', k !== m);
    $(`tab-pay-${k}`).className = `py-2 rounded-full font-medium transition ${k === m ? 'bg-gallery text-ink shadow-sm' : 'text-slate hover:text-ink'}`;
  });
  updateButton();
}

// ---------- Submit ----------
function collectBuyer() {
  const srv = isSrv();
  const modes = P.farmModes || [];
  const self = srv && modes.length && farmMode === 'self';
  const b = {
    buyerEmail: $('buyer-email').value.trim(),
    buyerFacebook: $('buyer-facebook').value.trim(),
    buyerContact: $('buyer-contact').value.trim(),
    playTime: $('play-time').value.trim(),
    gameEmail: $('game-email').value.trim(),
    gamePassword: $('game-password').value
  };
  const fail = (m, id) => { toast(m, 'error'); $(id)?.focus(); return null; };
  if (!srv && !/^\S+@\S+\.\S+$/.test(b.buyerEmail)) return fail('กรุณากรอกอีเมลให้ถูกต้อง', 'buyer-email');
  if (srv && b.buyerFacebook.length < 2) return fail('กรุณากรอกชื่อหรือลิงก์ Facebook', 'buyer-facebook');
  if (srv && !self && (!b.gameEmail.includes('@') || !b.gamePassword)) return fail('กรุณากรอกอีเมลและรหัสผ่านบัญชีเกม', b.gameEmail.includes('@') ? 'game-password' : 'game-email');
  if (self && (!b.buyerContact || !b.playTime)) return fail('กรุณากรอกชื่อในเกม / UID และเวลาที่พร้อมเข้าเกม', b.buyerContact ? 'play-time' : 'buyer-contact');
  return { ...b, self, srv };
}

function setBusy(on, label) {
  submitting = on;
  const btn = $('btn-confirm-product-order');
  btn.disabled = on;
  if (on) btn.textContent = label; else updateButton();
}

async function executeProductPurchase() {
  if (!P || submitting) return;
  if (!user) { toast('กรุณาเข้าสู่ระบบก่อนสั่งซื้อ', 'error'); setTimeout(() => { location.href = 'login.html?mode=login'; }, 900); return; }
  if (num(P.stock) <= 0) { toast('สินค้านี้หมดแล้ว', 'error'); return; }
  const b = collectBuyer(); if (!b) return;
  if (method === 'wallet') return payWithWallet(b);
  return fileManualOrder(b);
}

async function payWithWallet(b) {
  if (balance !== null && balance < finalPrice()) { toast('เครดิตไม่พอ กรุณาเติมเงินก่อน', 'error'); return; }
  setBusy(true, 'กำลังชำระเงิน…');
  try {
    const res = await callWorker('/buy', {
      productId: P.id, quantity: qty, farmMode: farmMode || null, promoCode: promoCode || null, expectedAmount: finalPrice(),
      buyerEmail: b.srv ? '' : b.buyerEmail, buyerFacebook: b.srv ? b.buyerFacebook : '',
      buyerContact: b.self ? b.buyerContact : '', playTime: b.self ? b.playTime : '',
      gameEmail: b.srv && !b.self ? b.gameEmail : '', gamePassword: b.srv && !b.self ? b.gamePassword : ''
    });
    $('game-password').value = '';
    showSuccess(res.order, true);
    toast(res.order?.status === 'completed' ? 'ชำระเงินสำเร็จ รับไอดีได้เลย' : 'ชำระเงินสำเร็จ งานเข้าคิวแล้ว', 'success');
    P.stock = num(P.stock) - qty;
  } catch (e) {
    console.warn('buy:', e);
    toast(e.message || 'ชำระเงินไม่สำเร็จ', 'error');
  } finally { setBusy(false); }
}

function isTrueMoneyVoucher(u) { try { const x = new URL(u); return x.protocol === 'https:' && x.hostname === 'gift.truemoney.com'; } catch { return false; } }

async function fileManualOrder(b) {
  let proof = '', slip = null;
  if (method === 'truemoney') {
    proof = $('product-voucher-input').value.trim();
    if (!isTrueMoneyVoucher(proof)) { toast('กรุณากรอกลิงก์ซองของขวัญ TrueMoney ให้ถูกต้อง', 'error'); return; }
  } else {
    if (!promptpayReady()) { toast('ร้านยังไม่เปิดรับพร้อมเพย์ กรุณาเลือกช่องทางอื่น', 'error'); return; }
    setBusy(true, 'กำลังเตรียมสลิป…');
    try { slip = await prepareSlip(pp.getFile()); } catch (e) { setBusy(false); toast(e.message, 'error'); return; }
    proof = 'สลิปแนบในระบบ';
  }
  setBusy(true, 'กำลังส่งคำสั่งซื้อ…');
  const srv = b.srv, modes = P.farmModes || [];
  const sub = subtotal(), fin = finalPrice();
  try {
    const ref = doc(collection(db, 'orders'));
    const orderId = `ORD-${ref.id.slice(0, 8).toUpperCase()}`;
    const payload = {
      orderNumber: orderId, orderId, productId: P.id,
      productName: modes.length ? `${P.name} (${modes.find(m => m.key === farmMode)?.label || ''})` : P.name,
      productType: srv ? 'service' : 'account',
      quantity: qty, bonusQty: bonusFor(qty), receiveQty: qty + bonusFor(qty), unit: unitOf(P, CATS),
      unitPrice: unitRate(), subtotal: sub, discount: Math.min(discount, sub), promoCode: promoCode || null,
      amount: fin, finalPrice: fin, paymentMethod: method, paymentProof: proof,
      ...(srv ? { buyerFacebook: b.buyerFacebook } : { buyerEmail: b.buyerEmail }),
      ...(b.self ? { buyerContact: b.buyerContact, playTime: b.playTime } : {}),
      ...(srv && !b.self ? { gameEmail: b.gameEmail, gamePassword: b.gamePassword, buyerContact: b.gameEmail } : {}),
      ...(modes.length ? { farmMode } : {}),
      ...(slip ? { slipHash: slip.hash, hasSlip: true } : {}),
      status: 'pending_payment', userEmail: user.email || '', userId: user.uid, createdAt: serverTimestamp()
    };
    const batch = writeBatch(db);
    batch.set(ref, payload);
    if (slip) {
      batch.set(doc(db, 'slip_images', ref.id), { kind: 'order', uid: user.uid, image: slip.image, createdAt: serverTimestamp() });
      batch.set(doc(db, 'slip_hashes', slip.hash), { kind: 'order', refId: ref.id, uid: user.uid, createdAt: serverTimestamp() });
    }
    if (srv) {
      batch.set(doc(db, 'queue', ref.id), {
        orderNumber: orderId, productId: P.id, productName: P.name, unit: unitOf(P, CATS), quantity: qty,
        nameMask: maskName(user.displayName || (user.email || '').split('@')[0]).slice(0, 8), uid: user.uid, status: 'pending_payment', createdAt: serverTimestamp()
      });
    }
    await batch.commit();
    notifyAdmin('order', ref.id);
    $('game-password').value = '';
    $('product-voucher-input').value = '';
    pp.reset();
    showSuccess({ ...payload, id: ref.id, createdAt: new Date() }, false);
    toast('ส่งคำสั่งซื้อแล้ว ทีมงานกำลังตรวจสอบ', 'success');
  } catch (e) {
    console.warn('order:', e);
    toast(slipErrorText(e), 'error');
  } finally { setBusy(false); }
}

function showSuccess(order, paid) {
  const card = $('product-order-success-card');
  const srv = order.productType === 'service';
  card.innerHTML = `
    <div class="flex items-center gap-3">
      <span class="w-11 h-11 rounded-full ${paid ? 'bg-emerald-500' : 'bg-ink'} text-gallery flex items-center justify-center">${icon(ICONS.check, 'w-6 h-6', 2.5)}</span>
      <div><p class="text-xs text-slate">${paid ? 'ชำระเงินสำเร็จ' : 'ได้รับคำสั่งซื้อแล้ว'}</p>
        <h2 class="text-xl font-heading font-semibold">${paid ? (srv ? 'งานของคุณเข้าคิวแล้ว' : 'รับไอดีของคุณได้เลย') : 'รอทีมงานตรวจสอบการชำระเงิน'}</h2></div>
    </div>
    ${orderCardHtml(order)}
    <div class="grid grid-cols-2 gap-3">
      <a href="account.html#orders" class="apple-pricing-pill py-3 text-[15px]">ออเดอร์ของฉัน</a>
      <a href="${srv ? 'queue.html' : 'category.html'}" class="apple-explore-pill py-3 text-[15px]">${srv ? 'ดูคิวงาน' : 'ดูสินค้าอื่น'}</a>
    </div>`;
  card.classList.remove('hidden');
  $('checkout-card').classList.add('hidden');
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function scrollToCheckoutForm() { $('checkout-anchor-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }

// ---------- Auth + wallet ----------
onAuthStateChanged(auth, (u) => {
  user = u;
  $('login-needed').classList.toggle('hidden', !!u);
  if (u?.email && !$('buyer-email').value && !/@tactical\.store$/.test(u.email)) $('buyer-email').value = u.email;
  if (!u) balance = null;
  if (P) { updateWalletPanel(); updateButton(); }
});
document.addEventListener('wallet', (e) => {
  balance = e.detail.balance;
  const fb = e.detail.profile?.facebook;
  if (fb && !$('buyer-facebook').value) $('buyer-facebook').value = fb;
  const ce = e.detail.profile?.contactEmail;
  if (ce && !$('buyer-email').value) $('buyer-email').value = ce;
  if (P) { updateWalletPanel(); updateButton(); }
});
onSettings(() => {
  if (!P) return;
  renderBadges();
  renderRelated();
  updateWalletPanel();
  switchProductPaymentTab(!methodPicked || (method === 'wallet' && !workerBase()) ? defaultMethod() : method, true);
});

Object.assign(window, {
  updateGalleryView, openImageFull, closeLightbox, lightboxStep, changeQuantity, handleQuantityDirectInput, selectValuePack,
  selectFarmMode, applyProductPromo, switchProductPaymentTab, executeProductPurchase, scrollToCheckoutForm
});
load();
