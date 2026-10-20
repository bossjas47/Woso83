import { db, auth } from "../firebase-config.js";
import { doc, getDoc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { loadCategories, isServiceProduct, minQtyOf, unitOf } from "./categories.js";
import { esc, num, baht, money, toast, callWorker, imgAttrs, workerBase } from "./ui.js";
import { saveCart } from "./cart-store.js";

/** Cart page: game IDs and services, paid with credit through the Worker (/cart). Buyer details are asked here, never stored in the cart. */
const FALLBACK = 'https://placehold.co/800x600/f5f5f7/86868b?text=ASTRAPHEX+HUB';
let user = null, items = [], PRODUCTS = {}, CATS = [], balance = null, ready = false, paying = false;
const form = { facebook: '' };            // typed buyer details survive re-renders (line key -> fields)
const root = () => document.getElementById('cart-root');
const key = (it) => `${it.productId}|${it.farmMode || ''}`;

function info(it) {
  const p = PRODUCTS[it.productId];
  if (!p) return null;
  const srv = isServiceProduct(p, CATS), mode = (p.farmModes || []).find(m => m.key === it.farmMode) || null;
  const rate = mode ? num(mode.price) : srv ? (num(p.serviceRate) || num(p.price)) : num(p.price);
  const min = srv ? minQtyOf(p, CATS) : 1, max = srv ? 99999 : Math.max(0, Math.floor(num(p.stock)));
  return { p, srv, mode, rate, min, max, unit: unitOf(p, CATS), self: srv && mode?.key === 'self', out: num(p.stock) <= 0, total: Math.round(it.quantity * rate * 100) / 100 };
}
const live = () => items.map((it, i) => ({ it, i, d: info(it) })).filter(x => x.d && !x.d.out);

function render() {
  const el = root(); if (!el || !ready) return;
  if (!user) { el.innerHTML = '<div class="soft-card py-12 px-6 text-center"><p class="font-semibold">เข้าสู่ระบบเพื่อใช้ตะกร้า</p><a href="login.html?mode=login&next=cart.html" class="apple-pricing-pill px-6 py-2.5 text-[15px] mt-4">เข้าสู่ระบบ</a></div>'; return; }
  if (!items.length) { el.innerHTML = '<div class="soft-card py-12 px-6 text-center"><p class="font-semibold">ตะกร้าว่าง</p><p class="text-slate text-sm mt-1">เลือกสินค้าแล้วกด "เพิ่มลงตะกร้า"</p><a href="category.html" class="apple-explore-pill px-6 py-2.5 text-[15px] mt-4 bg-gallery">ดูสินค้า</a></div>'; return; }
  const lines = live(), total = Math.round(lines.reduce((a, x) => a + x.d.total, 0) * 100) / 100;
  const anySrv = lines.some(x => x.d.srv), short = balance !== null && balance < total;
  el.innerHTML = items.map((it, i) => {
    const d = info(it);
    if (!d) return `<article class="apple-card p-4 flex items-center justify-between gap-3"><span class="text-slate text-sm">สินค้านี้ถูกลบออกจากร้านแล้ว</span><button onclick="cartRemove(${i})" class="text-sm text-launchOrange">ลบ</button></article>`;
    const f = form[key(it)] || {};
    return `<article class="apple-card p-4 ${d.out ? 'opacity-60' : ''}">
      <div class="flex gap-3"><img ${imgAttrs(d.p.image || FALLBACK, 160, 160)} alt="" class="w-20 h-20 rounded-2xl object-cover bg-mist shrink-0">
        <div class="min-w-0 flex-1"><h2 class="text-[15px] font-semibold leading-snug line-clamp-2">${esc(d.p.name)}</h2>
          <p class="text-xs text-slate mt-0.5">${esc(d.mode ? d.mode.label + ' · ' : '')}${baht(d.rate)}${d.srv ? ' / ' + esc(d.unit) : ''}</p>
          ${d.out ? '<p class="text-xs text-launchOrange mt-1">สินค้าหมด (ไม่รวมในยอด)</p>' : `<div class="flex items-center justify-between mt-2"><div class="flex items-center bg-mist rounded-full p-0.5"><button onclick="cartQty(${i},-1)" class="w-9 h-9 rounded-full text-xl leading-none" aria-label="ลด">−</button><span class="w-10 text-center font-semibold">${it.quantity}</span><button onclick="cartQty(${i},1)" class="w-9 h-9 rounded-full text-xl leading-none" aria-label="เพิ่ม">+</button></div><p class="font-heading font-semibold">${baht(d.total)}</p></div>`}
        </div><button onclick="cartRemove(${i})" aria-label="ลบ" class="self-start text-slate text-xl leading-none px-1">×</button></div>
      ${!d.out && d.srv ? (d.self ? `<div class="grid gap-2 mt-3"><input data-k="${esc(key(it))}" data-f="contact" value="${esc(f.contact || '')}" maxlength="200" placeholder="ชื่อในเกม / UID" class="apple-input px-4 py-2.5 text-sm"><input data-k="${esc(key(it))}" data-f="time" value="${esc(f.time || '')}" maxlength="200" placeholder="เวลาที่พร้อมเข้าเกม" class="apple-input px-4 py-2.5 text-sm"></div>`
        : `<div class="grid gap-2 mt-3"><input data-k="${esc(key(it))}" data-f="email" value="${esc(f.email || '')}" maxlength="200" placeholder="อีเมลบัญชีเกม" autocomplete="off" class="apple-input px-4 py-2.5 text-sm"><input data-k="${esc(key(it))}" data-f="password" type="password" value="${esc(f.password || '')}" maxlength="200" placeholder="รหัสผ่านบัญชีเกม" autocomplete="off" class="apple-input px-4 py-2.5 text-sm"></div>`) : ''}
    </article>`;
  }).join('') + (anySrv ? `<div class="soft-card p-4"><label class="block text-sm font-medium mb-1.5">ชื่อหรือลิงก์ Facebook (สำหรับนัดงานบริการ)</label><input id="cart-facebook" value="${esc(form.facebook)}" maxlength="200" class="w-full apple-input px-4 py-3" placeholder="เช่น Somchai Gamer"></div>` : '')
  + `<div class="soft-card p-5 space-y-3"><div class="flex justify-between text-[15px]"><span class="text-slate">รวม ${lines.length} รายการ</span><span class="text-2xl font-heading font-semibold">${baht(total)}</span></div>
      <div class="flex justify-between text-sm"><span class="text-slate">เครดิตของคุณ</span><span>${balance === null ? '…' : baht(balance)}${short ? ' <a href="topup.html" class="text-appleBlue ml-1">เติมเงิน ›</a>' : ''}</span></div>
      <button id="cart-pay" onclick="cartPay()" ${paying || !lines.length || short || !workerBase() ? 'disabled' : ''} class="w-full apple-pricing-pill h-12 text-[16px] font-semibold">${paying ? 'กำลังชำระเงิน…' : !workerBase() ? 'ร้านยังไม่เปิดชำระด้วยเครดิต' : lines.length ? `ชำระด้วยเครดิต ${baht(total)}` : 'ไม่มีสินค้าที่ชำระได้'}</button>
      <p class="text-xs text-slate">ชำระด้วยเครดิตเท่านั้น รายการที่ซื้อไม่สำเร็จ (เช่น สินค้าหมด) จะไม่ถูกตัดเงินและยังอยู่ในตะกร้า</p></div>`;
}

const persist = () => saveCart(user.uid, items).catch(e => { console.warn('cart save:', e); toast('บันทึกตะกร้าไม่สำเร็จ', 'error'); });
function cartQty(i, d) {
  const it = items[i], x = info(it); if (!x) return;
  it.quantity = Math.min(x.max || 1, Math.max(x.min, it.quantity + d));
  render(); persist();
}
function cartRemove(i) { items.splice(i, 1); render(); persist(); }

async function cartPay() {
  if (paying) return;
  const lines = live(), body = [];
  for (const { it, d } of lines) {
    const f = form[key(it)] || {}, line = { productId: it.productId, quantity: it.quantity, farmMode: it.farmMode || null, expectedAmount: d.total };
    if (d.srv) {
      if (form.facebook.trim().length < 2) { toast('กรุณากรอกชื่อหรือลิงก์ Facebook', 'error'); document.getElementById('cart-facebook')?.focus(); return; }
      line.buyerFacebook = form.facebook.trim();
      if (d.self) { if (!f.contact?.trim() || !f.time?.trim()) { toast(`กรอกชื่อในเกมและเวลาที่พร้อมของ "${d.p.name}"`, 'error'); return; } line.buyerContact = f.contact.trim(); line.playTime = f.time.trim(); }
      else { if (!String(f.email || '').includes('@') || !f.password) { toast(`กรอกอีเมลและรหัสผ่านเกมของ "${d.p.name}"`, 'error'); return; } line.gameEmail = f.email.trim(); line.gamePassword = f.password; }
    }
    body.push(line);
  }
  paying = true; render();
  try {
    const { results } = await callWorker('/cart', { items: body });
    const done = results.filter(r => r.ok), bad = results.filter(r => !r.ok);
    const bought = new Set(done.map(r => lines[r.index].it));
    items = items.filter(it => !bought.has(it)); persist();
    done.forEach(r => { const k = key(lines[r.index].it); delete form[k]; });
    if (bad.length) toast(`ซื้อสำเร็จ ${done.length} · ไม่สำเร็จ ${bad.length}: ${bad.map(r => `${lines[r.index].d.p.name} (${r.error})`).join(', ')}`, 'error');
    else toast(`ชำระสำเร็จ ${done.length} รายการ ดูไอดีที่เมนูออเดอร์ของฉัน`, 'success');
    if (done.length && !bad.length) setTimeout(() => { location.href = 'account.html#orders'; }, 1400);
  } catch (e) { console.warn('cart pay:', e); toast(e.message || 'ชำระเงินไม่สำเร็จ', 'error'); }
  finally { paying = false; render(); }
}

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.id === 'cart-facebook') form.facebook = t.value;
  else if (t.dataset?.k) (form[t.dataset.k] ||= {})[t.dataset.f] = t.value;
});
document.addEventListener('wallet', (e) => { balance = e.detail.balance; if (!paying) render(); });

/** Only the products that are in the cart, read once each (prices and stock stay current for this visit). */
const asked = new Set();
const loadMissing = () => Promise.all(items.filter(it => !asked.has(it.productId)).map(async (it) => {
  asked.add(it.productId);
  try { const s = await getDoc(doc(db, 'products', it.productId)); if (s.exists()) PRODUCTS[it.productId] = { ...s.data(), id: s.id }; } catch (e) { console.warn('product:', e); }
}));

let unsub = null;
(async () => {
  CATS = await loadCategories();
  onAuthStateChanged(auth, (u) => {
    user = u; ready = true; unsub?.(); items = [];
    if (u) unsub = onSnapshot(doc(db, 'carts', u.uid), (s) => { if (paying) return; items = s.data()?.items || []; loadMissing().then(render); }, (e) => console.warn('cart:', e));
    render();
  });
})();
Object.assign(window, { cartQty, cartRemove, cartPay });
