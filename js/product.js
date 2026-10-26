import { db, auth } from "../firebase-config.js";
import { collection, doc, getDoc, getDocs } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { loadCategories, isServiceProduct, minQtyOf, unitOf, categoryOf } from "./categories.js";
import { esc, num, baht, money, toast, icon, ICONS, onSettings, getSettings, workerBase, callWorker, readSlipQr, fixImageUrl, sizedImage } from "./ui.js";
import { deliveryBadge, productCardHtml, isRentProduct } from "./card.js";
import { mountPromptPay, promptpayReady } from "./pay.js";
import { evaluatePromo } from "./promo.js";
import { rankDiscount, rankOf, RANKS } from "./rank.js";
import { orderCardHtml } from "./orders-ui.js";
import { addToCart } from "./cart-store.js";
import { mountPushCard } from "./push.js";
import { readProducts, writeProducts } from "./products-cache.js";

/**
 * Product page: details, quantity / packages / farm modes, and checkout.
 * Payment:
 *  - เครดิตในบัญชี: the Worker (/buy) checks price, promo and balance, then delivers a game ID at once
 *    (or queues a service) in one transaction. Needs the Worker URL in admin settings.
 *  - พร้อมเพย์ (slip image): the Worker checks the slip with the slip API, credits the price and buys at once (no manual approval).
 *  - ซองอั่งเปา TrueMoney: redeemed by the Worker, then bought with that credit.
 */
const FALLBACK = 'https://placehold.co/800x600/f5f5f7/86868b?text=Nugget+Hub';
let allProducts = [], CATS = [], P = null;
let gallery = [], gIdx = 0;
let qty = 1, farmMode = '';
let promo = null, promoCode = null, discount = 0, rankOff = 0, prof = null;
let method = 'wallet';
let balance = null, user = null;
let submitting = false;
let pp = null;

const $ = (id) => document.getElementById(id);
const isSrv = () => isServiceProduct(P, CATS);

// ---------- Load ----------
async function load() {
  const id = new URLSearchParams(location.search).get('id');
  let one = null;
  [CATS, one] = await Promise.all([loadCategories(), /^[\w-]{1,128}$/.test(String(id)) ? getDoc(doc(db, 'products', String(id))).catch((e) => { console.warn('product:', e); return null; }) : null]);
  P = one?.exists() ? { ...one.data(), id: one.id } : null;
  $('product-loading-state').classList.add('hidden');
  if (!P) { $('product-not-found').classList.remove('hidden'); return; }
  $('product-content-stage').classList.remove('hidden');
  render();
  allProducts = readProducts() || [];
  renderRelated();
  pp = mountPromptPay($('panel-pay-promptpay'), { getAmount: () => finalPrice(), idPrefix: 'pp' });
  switchProductPaymentTab(defaultMethod(), true);
  if (new URLSearchParams(location.search).get('action') === 'buy') setTimeout(scrollToCheckoutForm, 300);
  // the rest of the shop (related items) comes after the page is already showing
  try { allProducts = (await getDocs(collection(db, 'products'))).docs.map(d => ({ ...d.data(), id: d.id })); writeProducts(allProducts); renderRelated(); }
  catch (e) { console.warn('products:', e); }
}

function render() {
  const srv = isSrv();
  const unit = unitOf(P, CATS);
  document.title = `${P.name} — Nugget Hub`;
  $('breadcrumb-product-name').textContent = P.name;
  $('breadcrumb-category').textContent = categoryOf(CATS, P.category)?.name || (srv ? 'งานบริการ' : 'ไอดีเกม');
  $('product-title-heading').textContent = P.name;
  $('product-kicker-label').textContent = categoryOf(CATS, P.category)?.name || 'Arena Breakout';
  // the card's picture (P.image) first, then any extra gallery pictures; bad / page-style links are fixed or dropped
  gallery = [...new Set([P.image, ...(Array.isArray(P.gallery) ? P.gallery : [])].map(fixImageUrl).filter(Boolean))];
  if (!gallery.length) gallery = [FALLBACK];
  updateGalleryView(0);
  $('product-thumbnail-strip').innerHTML = thumbsHtml();
  renderBadges();
  const stock = Math.max(0, Math.floor(num(P.stock)));
  $('product-stock-line').innerHTML = stock <= 0 ? `<span class="text-launchOrange font-medium">${srv ? 'คิวเต็มชั่วคราว' : isRent() ? 'ไม่มีไอดีว่างให้เช่า' : 'สินค้าหมด'}</span>`
    : isRent() ? `<span class="text-emerald-600 font-medium">ว่างให้เช่า ${stock} ไอดี</span>` : srv ? `<span class="text-emerald-600 font-medium">รับงานได้อีก ${stock} ${esc(unit)}</span>` : `<span class="${stock <= 3 ? 'text-launchOrange' : 'text-emerald-600'} font-medium">คงเหลือ ${stock} ไอดี</span>`;
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
  $('product-howto').textContent = P.howTo || (srv ? 'จ่ายเสร็จ ทีมจะทัก Facebook ไปนัดเวลา สถานะงานดูได้ที่ "ออเดอร์ของฉัน"' : 'จ่ายด้วยเครดิต ไอดีขึ้นใน "ออเดอร์ของฉัน" ทันที ถ้าจ่ายพร้อมเพย์ ไอดีขึ้นหลังสลิปผ่าน');
  $('product-warranty').textContent = P.warrantyText || 'หากมีปัญหาเกี่ยวกับสินค้า ติดต่อทีมงานพร้อมเลขที่ออเดอร์';

  // buyer fields: services ask Facebook instead of e-mail
  $('buyer-block').classList.toggle('hidden', !srv); // game IDs show up in "my orders": nothing to ask
  $('email-field').classList.add('hidden');
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
  applyRentUi();
  if (P.isAmmo === true) { // ammo bundles: own checkout (js/ammo.js), priced by the real ammo total
    ['farm-modes-section', 'packages-section', 'quantity-card', 'checkout-card', 'rent-card'].forEach(id => $(id)?.classList.add('hidden'));
    $('product-stock-line').innerHTML = stock <= 0 ? '<span class="text-launchOrange font-medium">สินค้าหมด</span>' : `<span class="text-emerald-600 font-medium">พร้อมส่ง ${stock.toLocaleString('th-TH')} กอง</span>`;
    import('./ammo.js').then(m => m.mountAmmo($('ammo-card'), P)).catch(e => console.warn('ammo:', e));
  }
}

function renderBadges() {
  $('product-badges').innerHTML = deliveryBadge(isSrv(), !!workerBase(), isRent()) + (P.featured ? `<span class="badge badge-featured">${icon(ICONS.star, 'w-3.5 h-3.5', 2)}แนะนำ</span>` : '');
}

function renderRelated() {
  const others = allProducts.filter(p => p.id !== P.id).sort((a, b) => (b.category === P.category) - (a.category === P.category)).slice(0, 4);
  $('related-products-grid').innerHTML = others.map(p => {
    const srv = isServiceProduct(p, CATS);
    return productCardHtml({ p, isService: srv, unit: unitOf(p, CATS), min: minQtyOf(p, CATS), price: num(p.price) || num(p.serviceRate), stock: Math.floor(num(p.stock)), koen: String(p.koen || '').trim() && p.koen !== '-' ? (p.koenLabel ? `${p.koenLabel}: ${p.koen}` : String(p.koen)) : '', categoryName: categoryOf(CATS, p.category)?.name, fallback: FALLBACK, instant: !!workerBase() });
  }).join('');
  $('related-products-grid').parentElement.classList.toggle('hidden', !others.length);
}

// ---------- Gallery ----------
/** A picture that fails is taken out of the gallery and the next one shown; the placeholder only when none load. */
function onMainImageError() {
  const img = $('product-main-image');
  if (img.getAttribute('src') !== gallery[gIdx] && gallery[gIdx]) { img.src = gallery[gIdx]; return; } // resized copy failed: try the original
  const bad = gallery[gIdx];
  gallery = gallery.filter(u => u !== bad);
  if (!gallery.length) { gallery = [FALLBACK]; }
  if (bad === FALLBACK) return;
  $('product-thumbnail-strip').innerHTML = thumbsHtml();
  updateGalleryView(Math.min(gIdx, gallery.length - 1));
}
const thumbsHtml = () => gallery.length > 1 ? gallery.map((u, i) => `<button type="button" onclick="updateGalleryView(${i})" class="gthumb w-16 h-12 rounded-xl overflow-hidden border shrink-0 ${i === 0 ? 'border-2 border-pricingBlue' : 'border-hairline opacity-70'}"><img src="${esc(sizedImage(u, 160))}" data-orig="${esc(u)}" alt="ภาพที่ ${i + 1}" width="64" height="48" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="imgFallback(this)" class="w-full h-full object-cover"></button>`).join('') : '';
function updateGalleryView(i) {
  if (i < 0 || i >= gallery.length) return;
  gIdx = i;
  $('product-main-image').src = sizedImage(gallery[i], 1200);
  $('gallery-counter-pill').textContent = `ภาพ ${i + 1} / ${gallery.length}`;
  $('gallery-counter-pill').classList.toggle('hidden', gallery.length < 2);
  document.querySelectorAll('.gthumb').forEach((b, k) => { b.classList.toggle('border-2', k === i); b.classList.toggle('border-pricingBlue', k === i); b.classList.toggle('opacity-70', k !== i); });
}
function setLightbox() { const el = $('lightbox-img'); el.dataset.orig = gallery[gIdx]; el.onerror = () => imgFallbackSafe(el); el.src = sizedImage(gallery[gIdx], 2000); }
const imgFallbackSafe = (el) => window.imgFallback(el);
function openImageFull() { setLightbox(); $('lightbox').classList.remove('hidden'); $('lightbox').classList.add('flex'); }
function closeLightbox() { $('lightbox').classList.add('hidden'); $('lightbox').classList.remove('flex'); }
function lightboxStep(d) { updateGalleryView((gIdx + d + gallery.length) % gallery.length); setLightbox(); }
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
  $('farm-mode-note').textContent = farmMode === 'self' ? 'คุณล็อกอินเล่นเอง ทีมนัดเวลาแล้วชวนเข้าห้อง ไม่ต้องให้รหัส' : farmMode === 'with_id' ? 'ฝากอีเมลกับรหัสเกม ทีมล็อกอินไปจัดให้ งานเสร็จลบรหัสทิ้งทันที' : '';
}
function selectFarmMode(key) { farmMode = key; renderFarmModes(); renderValuePacks(); recalc(); }

// ---------- Price ----------
const subtotal = () => Math.round(qty * unitRate() * 100) / 100;
const finalPrice = () => Math.max(0, Math.round((subtotal() - discount - rankOff) * 100) / 100);
function recalc() {
  if (!P) return;
  const unit = unitOf(P, CATS);
  const sub = subtotal();
  if (promo) {
    const r = evaluatePromo(promo, P, sub);
    discount = r.ok ? r.discount : 0;
  } else discount = 0;
  prof = prof || window.__wallet?.profile || null;
  rankOff = rankDiscount(sub - discount, prof, getSettings()); // the Worker takes the same off
  const fin = finalPrice();
  $('product-unit-price').textContent = baht(unitRate());
  $('product-unit-suffix').textContent = `/ ${unit}`;
  $('calc-qty-label').textContent = qty;
  $('calc-unit-label').textContent = unit;
  $('calc-subtotal').textContent = baht(sub);
  $('calc-discount-row').classList.toggle('hidden', !discount);
  $('calc-discount-val').textContent = `-${baht(discount)}`;
  $('calc-rank-row').classList.toggle('hidden', !rankOff);
  if (rankOff) { $('calc-rank-label').textContent = `ส่วนลดยศ ${RANKS[rankOf(prof, getSettings())].name}`; $('calc-rank-val').textContent = `-${baht(rankOff)}`; }
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
  if (isRent()) updateRent();
  const fin = finalPrice();
  $('wallet-balance').textContent = !user ? 'เข้าสู่ระบบเพื่อดูยอด' : balance === null ? 'กำลังโหลด…' : `${money(balance)}฿`;
  const short = user && balance !== null && balance < fin;
  $('wallet-topup-link').classList.toggle('hidden', !short);
  $('wallet-note').textContent = !workerBase() ? 'ร้านยังไม่เปิดชำระด้วยเครดิต กรุณาเลือกพร้อมเพย์หรือ TrueMoney'
    : isSrv() ? 'ตัดเครดิตทันที งานเข้าคิวให้ทีมลุยได้เลย' : 'ตัดเครดิตทันที จ่ายเสร็จไอดีขึ้นให้เห็นเลย';
}
function updateButton() {
  const btn = $('btn-confirm-product-order');
  if (submitting) return;
  const out = num(P?.stock) <= 0;
  const fin = baht(finalPrice());
  $('btn-add-cart').disabled = out;
  btn.disabled = out || (method === 'wallet' && (!workerBase() || (user && balance !== null && balance < finalPrice())));
  btn.textContent = out ? (isSrv() ? 'คิวเต็มชั่วคราว' : 'สินค้าหมด') : method === 'wallet' ? `ชำระด้วยเครดิต ${fin}` : method === 'angpao' ? `ชำระด้วยซองอั่งเปา ${fin}` : `แจ้งชำระเงิน ${fin}`;
}

// ---------- Rent (เช่าไอดี) ----------
// Hourly rental: the Worker (/rent) checks price, deposit, balance and hands out one free ID in a transaction.
let rentH = 1, renting = false;
const isRent = () => !isSrv() && isRentProduct(P);
const rentMin = () => Math.max(1, Math.floor(num(P.rentMinHours)) || 1);
const rentPacks = () => (Array.isArray(P.rentPackages) ? P.rentPackages : []).map(k => ({ hours: Math.floor(num(k.hours)), price: num(k.price) })).filter(k => k.hours > 0 && k.price > 0).sort((a, b) => a.hours - b.hours);
const rentPriceFor = (h) => {
  const pk = rentPacks().find(k => k.hours === h);
  if (pk) return Math.round(pk.price * 100) / 100;
  return num(P.rentHourPrice) > 0 && h >= rentMin() ? Math.round(h * num(P.rentHourPrice) * 100) / 100 : 0;
};
const rentTotal = () => rentPriceFor(rentH) + Math.max(0, num(P.rentDeposit));
function applyRentUi() {
  const on = isRent();
  ['farm-modes-section', 'packages-section', 'quantity-card', 'checkout-card'].forEach(id => { if (on) $(id).classList.add('hidden'); });
  if (on) $('checkout-card').classList.add('hidden');
  $('rent-card').classList.toggle('hidden', !on);
  if (!on) return;
  const rate = num(P.rentHourPrice);
  $('product-unit-price').textContent = baht(rate > 0 ? rate : Math.min(...rentPacks().map(k => k.price)));
  $('product-unit-suffix').textContent = rate > 0 ? '/ ชั่วโมง' : 'ขึ้นไป (แพ็กเกจ)';
  $('rent-hint').textContent = rate > 0 ? `${baht(rate)} ต่อชั่วโมง · ขั้นต่ำ ${rentMin()} ชั่วโมง` : 'เลือกแพ็กเกจที่ต้องการ';
  $('rent-stepper').classList.toggle('hidden', !(rate > 0));
  $('rent-min-hint').textContent = `ขั้นต่ำ ${rentMin()} ชม. · สูงสุด 720 ชม.`;
  $('rent-deposit-row').classList.toggle('hidden', !(num(P.rentDeposit) > 0));
  rentH = rate > 0 ? rentMin() : (rentPacks()[0]?.hours || 1);
  const pk = rentPacks();
  $('rent-packs').classList.toggle('hidden', !pk.length);
  $('rent-packs').innerHTML = pk.map(k => `<button type="button" data-h="${k.hours}" onclick="setRentHours(${k.hours})" class="rpack text-left rounded-2xl p-4 bg-gallery border border-hairline transition"><span class="block text-xs text-slate">แพ็กเกจ ${k.hours} ชั่วโมง</span><span class="block text-lg font-heading font-semibold">฿${k.price.toLocaleString('th-TH')}</span></button>`).join('');
  updateRent();
}
function updateRent() {
  if (!isRent()) return;
  const price = rentPriceFor(rentH), dep = Math.max(0, num(P.rentDeposit)), total = price + dep;
  $('rent-hours').value = rentH;
  $('rent-hours-label').textContent = `(${rentH} ชม.)`;
  $('rent-price').textContent = price > 0 ? baht(price) : 'เลือกแพ็กเกจหรือเพิ่มชั่วโมง';
  $('rent-deposit').textContent = baht(dep);
  $('rent-total').textContent = baht(total);
  $('rent-end').textContent = new Date(Date.now() + rentH * 3600e3).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' }) + ' (นับจากตอนกดเช่า)';
  document.querySelectorAll('.rpack').forEach(c => { const on = Number(c.dataset.h) === rentH; c.classList.toggle('border-2', on); c.classList.toggle('border-pricingBlue', on); });
  $('rent-login').classList.toggle('hidden', !!user);
  $('rent-balance').textContent = !user ? '' : balance === null ? '…' : `${money(balance)}฿`;
  const short = !!user && balance !== null && balance < total;
  $('rent-topup-link').classList.toggle('hidden', !short);
  const out = num(P.stock) <= 0;
  const btn = $('btn-rent');
  if (renting) return;
  btn.disabled = out || !price || !workerBase() || short;
  btn.textContent = out ? 'ไม่มีไอดีว่างให้เช่า' : !workerBase() ? 'ร้านยังไม่เปิดให้เช่า' : !price ? 'เลือกระยะเวลาเช่า' : `เช่าเลย ${baht(total)}`;
}
function setRentHours(v) { rentH = Math.min(720, Math.max(1, Math.floor(num(v)) || 1)); if (num(P.rentHourPrice) > 0) rentH = Math.max(rentMin(), rentH); updateRent(); }
const changeRentHours = (d) => setRentHours(rentH + d);
async function payRent() {
  if (!P || renting || !isRent()) return;
  if (!user) { toast('กรุณาเข้าสู่ระบบก่อนเช่า', 'error'); setTimeout(() => { location.href = 'login.html?mode=login'; }, 900); return; }
  const total = rentTotal();
  renting = true; $('btn-rent').disabled = true; $('btn-rent').textContent = 'กำลังเช่า…';
  try {
    const out = await callWorker('/rent', { productId: P.id, hours: rentH, expectedAmount: total });
    P.stock = num(P.stock) - 1;
    const r = out.rental;
    const card = $('product-order-success-card');
    card.innerHTML = `<div class="flex items-center gap-3">
        <span class="w-11 h-11 rounded-full bg-emerald-500 text-gallery flex items-center justify-center">${icon(ICONS.check, 'w-6 h-6', 2.5)}</span>
        <div><p class="text-xs text-slate">เช่าไอดีสำเร็จ</p><h2 class="text-xl font-heading font-semibold">ไอดีพร้อมใช้งานแล้ว</h2></div></div>
      <div class="rounded-2xl bg-mist p-4 text-[15px] space-y-1">
        <p class="font-medium">${esc(r.productName)} · ${esc(r.hours)} ชั่วโมง</p>
        <p class="text-slate">หมดเวลา ${esc(new Date(r.endMs).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' }))}</p>
        <p class="text-slate">ตัดเครดิต ${baht(r.price + r.deposit)} (มัดจำ ${baht(r.deposit)} คืนเมื่อส่งไอดีคืนปกติ)</p></div>
      <a href="rentals.html" class="apple-pricing-pill w-full h-12 text-[16px] font-semibold">ดูรหัสไอดี</a>`;
    card.classList.remove('hidden');
    $('rent-card').classList.add('hidden');
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    toast('เช่าไอดีสำเร็จ', 'success');
  } catch (e) {
    console.warn('rent:', e);
    toast(e.message || 'เช่าไม่สำเร็จ', 'error');
  } finally { renting = false; updateRent(); }
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
  if (m === 'angpao' && !workerBase()) m = method = 'promptpay';
  $('tab-pay-angpao').classList.toggle('hidden', !workerBase());
  $('pay-tabs').classList.toggle('grid-cols-3', !!workerBase()); $('pay-tabs').classList.toggle('grid-cols-2', !workerBase());
  ['wallet', 'promptpay', 'angpao'].forEach(k => {
    $(`panel-pay-${k}`).classList.toggle('hidden', k !== m);
    $(`tab-pay-${k}`).className = `py-2 rounded-full font-medium transition ${k === m ? 'bg-gallery text-ink shadow-sm' : 'text-slate hover:text-ink'}`;
  });
  updateButton();
}

// ---------- Cart ----------
async function addProductToCart() {
  if (!P || submitting) return;
  if (!user) { toast('กรุณาเข้าสู่ระบบก่อนใส่ตะกร้า', 'error'); setTimeout(() => { location.href = 'login.html?mode=login'; }, 900); return; }
  if (num(P.stock) <= 0) { toast('สินค้านี้หมดแล้ว', 'error'); return; }
  try {
    await addToCart(user.uid, { productId: P.id, quantity: qty, farmMode }, maxQty());
    toast('เพิ่มลงตะกร้าแล้ว', 'success');
  } catch (e) { console.warn('cart:', e); toast(e.message || 'เพิ่มลงตะกร้าไม่สำเร็จ', 'error'); }
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
  if (method === 'angpao') return payWithAngpao(b);
  return payWithSlip(b);
}

const buyBody = (b) => ({
  productId: P.id, quantity: qty, farmMode: farmMode || null, promoCode: promoCode || null, expectedAmount: finalPrice(),
  buyerFacebook: b.srv ? b.buyerFacebook : '',
  buyerContact: b.self ? b.buyerContact : '', playTime: b.self ? b.playTime : '',
  gameEmail: b.srv && !b.self ? b.gameEmail : '', gamePassword: b.srv && !b.self ? b.gamePassword : ''
});

/** TrueMoney gift voucher: the Worker redeems it, credits the account, then buys with that credit. */
async function payWithAngpao(b) {
  const link = $('product-voucher-input').value.trim();
  if (!isTrueMoneyVoucher(link)) { toast('กรุณาวางลิงก์ซองอั่งเปา TrueMoney ให้ถูกต้อง', 'error'); $('product-voucher-input').focus(); return; }
  setBusy(true, 'กำลังรับซอง…');
  try {
    const r = await callWorker('/angpao', { link, purpose: 'buy', buy: buyBody(b) });
    $('product-voucher-input').value = '';
    if (r.buy?.order) {
      $('game-password').value = '';
      showSuccess(r.buy.order, true);
      P.stock = num(P.stock) - qty;
      const extra = Math.round((r.credit - finalPrice()) * 100) / 100;
      toast(`รับซอง ${baht(r.amount)} แล้ว ชำระสำเร็จ${extra > 0 ? ` · เครดิตคงเหลือ +${money(extra)}` : ''}`, 'success');
    } else {
      toast(`รับซองแล้ว เครดิต +${money(r.credit)} แต่สั่งซื้อไม่สำเร็จ: ${r.buyError || ''}`, 'error');
      switchProductPaymentTab('wallet');
    }
  } catch (e) {
    console.warn('angpao:', e);
    toast(e.message || 'รับซองไม่สำเร็จ', 'error');
  } finally { setBusy(false); }
}

async function payWithWallet(b) {
  if (balance !== null && balance < finalPrice()) { toast('เครดิตไม่พอ กรุณาเติมเงินก่อน', 'error'); return; }
  setBusy(true, 'กำลังชำระเงิน…');
  try {
    const res = await callWorker('/buy', buyBody(b));
    $('game-password').value = '';
    showSuccess(res.order, true);
    toast(res.order?.status === 'completed' ? 'จ่ายผ่านแล้ว ไอดีพร้อมลุย!' : 'จ่ายผ่านแล้ว งานเข้าคิวเรียบร้อย', 'success');
    P.stock = num(P.stock) - qty;
  } catch (e) {
    console.warn('buy:', e);
    toast(e.message || 'ชำระเงินไม่สำเร็จ', 'error');
  } finally { setBusy(false); }
}

function isTrueMoneyVoucher(u) { try { const x = new URL(u); return x.protocol === 'https:' && x.hostname === 'gift.truemoney.com'; } catch { return false; } }

/** Bank slip: the Worker checks it with the slip API, credits exactly the price, then buys (no manual approval). */
async function payWithSlip(b) {
  if (!promptpayReady()) { toast('ร้านยังไม่เปิดรับพร้อมเพย์ กรุณาเลือกช่องทางอื่น', 'error'); return; }
  if (getSettings().slipAutoVerify !== true) { toast('ร้านยังไม่เปิดระบบตรวจสลิปอัตโนมัติ กรุณาเลือกช่องทางอื่น', 'error'); return; }
  const file = pp.getFile();
  if (!file) { toast('กรุณาแนบรูปสลิปโอนเงิน', 'error'); return; }
  setBusy(true, 'กำลังตรวจสลิป…');
  try {
    const payload = await readSlipQr(file);
    if (!payload) { toast('อ่าน QR บนสลิปไม่ได้ กรุณาใช้รูปสลิปที่เห็น QR ชัดเจน (ไม่ครอป ไม่เบลอ)', 'error'); return; }
    const r = await callWorker('/', { amount: finalPrice(), payload, purpose: 'buy', buy: buyBody(b) });
    if (r.status !== 'completed') { toast(r.message || 'ตรวจสลิปไม่ผ่าน', 'error'); return; }
    pp.reset();
    if (r.buy?.order) {
      $('game-password').value = '';
      showSuccess(r.buy.order, true);
      P.stock = num(P.stock) - qty;
      toast('ตรวจสลิปผ่าน ชำระสำเร็จ', 'success');
    } else {
      toast(`ตรวจสลิปผ่าน เครดิต +${money(r.credit)} แต่สั่งซื้อไม่สำเร็จ: ${r.buyError || ''}`, 'error');
      switchProductPaymentTab('wallet');
    }
  } catch (e) { console.warn('slip buy:', e); toast(e.message || 'ตรวจสลิปไม่ได้ในตอนนี้ กรุณาลองใหม่อีกครั้ง', 'error'); }
  finally { setBusy(false); }
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
    ${orderCardHtml({ ...order, image: P?.image })}
    <div id="push-card"></div>
    <div class="grid grid-cols-2 gap-3">
      <a href="account.html#orders" class="apple-pricing-pill py-3 text-[15px]">ออเดอร์ของฉัน</a>
      <a href="${srv ? 'queue.html' : 'category.html'}" class="apple-explore-pill py-3 text-[15px]">${srv ? 'ดูคิวงาน' : 'ดูสินค้าอื่น'}</a>
    </div>`;
  card.classList.remove('hidden');
  $('checkout-card').classList.add('hidden');
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (srv && paid) mountPushCard($('push-card'), 'เปิดแจ้งเตือนไว้ ใกล้ถึงคิว ถึงคิว หรืองานเสร็จ มือถือเด้งบอกทันที');
}

function scrollToCheckoutForm() { $('checkout-anchor-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }

// ---------- Auth + wallet ----------
onAuthStateChanged(auth, (u) => {
  user = u;
  $('login-needed').classList.toggle('hidden', !!u);
  if (!u) balance = null;
  if (P) { updateWalletPanel(); updateButton(); }
});
document.addEventListener('wallet', (e) => {
  balance = e.detail.balance; prof = e.detail.profile || null;
  const fb = e.detail.profile?.facebook;
  if (fb && !$('buyer-facebook').value) $('buyer-facebook').value = fb;
  if (P) { recalc(); updateWalletPanel(); updateButton(); }
});
onSettings(() => {
  if (!P) return;
  recalc();
  renderBadges();
  renderRelated();
  updateWalletPanel();
  switchProductPaymentTab(!methodPicked || (method === 'wallet' && !workerBase()) ? defaultMethod() : method, true);
});

Object.assign(window, {
  updateGalleryView, onMainImageError, openImageFull, closeLightbox, lightboxStep, changeQuantity, handleQuantityDirectInput, selectValuePack,
  selectFarmMode, applyProductPromo, switchProductPaymentTab, executeProductPurchase, scrollToCheckoutForm,
  setRentHours, changeRentHours, payRent, addProductToCart
});
load();
