import { auth } from "../firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { esc, num, baht, money, toast, callWorker, readSlipQr, workerBase } from "./ui.js";
import { mountPromptPay } from "./pay.js";
import { credentialBoxHtml } from "./orders-ui.js";

/**
 * Ammo bundle checkout (ไก่กระสุน) on the product page. The customer types how many กอง they want, the Worker
 * picks the game IDs that add up to it (or the closest total) and holds them for 15 minutes (/ammo/quote),
 * then the customer pays that real total (/ammo/pay: credit, slip or angpao). Products with requireLogin === false
 * can be bought without an account: the IDs are then kept only in this browser (localStorage 'ammo-orders').
 */
const LS = 'ammo-orders';
const readSaved = () => { try { return JSON.parse(localStorage.getItem(LS) || '[]'); } catch { return []; } };
const saveOrder = (o) => { try { localStorage.setItem(LS, JSON.stringify([o, ...readSaved()].slice(0, 50))); return true; } catch { return false; } };

let P = null, el = null, user = null, quote = null, method = 'wallet', busy = false, timer = 0, pp = null, balance = null;
const $ = (id) => el.querySelector('#am-' + id);
const guestOk = () => P.requireLogin === false;
const rate = () => num(P.ammoRate) || num(P.price);
const minQ = () => Math.max(1, Math.floor(num(P.ammoMin)) || 1);
const stock = () => Math.max(0, Math.floor(num(P.stock)));

export function mountAmmo(root, product) {
  P = product; el = root; balance = window.__wallet?.balance ?? null;
  el.classList.remove('hidden');
  const quick = [50, 100, 200, 500, 1000].filter(n => n >= minQ() && n <= stock()).slice(0, 4);
  el.innerHTML = `
    <div id="am-login" class="hidden rounded-2xl bg-gallery p-4 text-sm flex items-center justify-between gap-3">
      <span>สินค้านี้ต้องเข้าสู่ระบบก่อนซื้อ</span><a href="login.html?mode=login&next=${encodeURIComponent(location.pathname + location.search)}" class="apple-pricing-pill px-4 py-2 text-sm">เข้าสู่ระบบ</a>
    </div>
    <div><h2 class="text-xl font-heading font-semibold">สั่งตามจำนวนกอง</h2>
      <p class="text-sm text-slate mt-0.5">฿${money(rate())} / กอง · ขั้นต่ำ ${minQ()} กอง · พร้อมส่ง ${stock().toLocaleString('th-TH')} กอง</p></div>
    <div class="flex items-center justify-between gap-3">
      <label for="am-target" class="font-medium">ต้องการกี่กอง</label>
      <div class="flex items-center bg-gallery rounded-full p-1">
        <button type="button" data-step="-10" aria-label="ลด 10 กอง" class="w-10 h-10 rounded-full hover:bg-mist text-2xl leading-none">−</button>
        <input id="am-target" type="number" inputmode="numeric" min="${minQ()}" max="${stock()}" value="${Math.min(stock(), Math.max(minQ(), 100))}" class="w-20 text-center text-base font-semibold bg-transparent focus:outline-none">
        <button type="button" data-step="10" aria-label="เพิ่ม 10 กอง" class="w-10 h-10 rounded-full hover:bg-mist text-2xl leading-none">+</button>
      </div>
    </div>
    ${quick.length ? `<div class="flex flex-wrap gap-2">${quick.map(n => `<button type="button" data-set="${n}" class="px-3.5 py-1.5 rounded-full text-[14px] border border-hairline bg-gallery hover:bg-mist">${n.toLocaleString('th-TH')} กอง</button>`).join('')}</div>` : ''}
    <button id="am-quote" type="button" class="w-full apple-explore-pill py-3.5 text-[16px] bg-gallery">หาไอดีให้</button>
    <div id="am-result" class="hidden space-y-5"></div>
    <div id="am-done" class="hidden space-y-4"></div>
    <div id="am-saved" class="hidden space-y-3"></div>`;
  el.addEventListener('click', onClick);
  el.addEventListener('input', (e) => { if (e.target.id === 'am-target' && quote) clearQuote(); });
  onAuthStateChanged(auth, (u) => { user = u; if (!u && method === 'wallet') method = 'slip'; refreshGate(); if (quote) renderQuote(); });
  document.addEventListener('wallet', (e) => { balance = e.detail.balance; if (quote) renderPayButton(); });
  renderSaved();
}

function refreshGate() {
  const blocked = !user && !guestOk();
  $('login').classList.toggle('hidden', !blocked);
  $('quote').disabled = blocked || stock() <= 0;
  $('quote').textContent = stock() <= 0 ? 'สินค้าหมด' : 'หาไอดีให้';
}

function clearQuote() { quote = null; clearInterval(timer); $('result').classList.add('hidden'); $('result').innerHTML = ''; }

async function getQuote() {
  const target = Math.floor(num($('target').value));
  if (target < minQ()) return toast(`สั่งขั้นต่ำ ${minQ()} กอง`, 'error');
  if (!workerBase()) return toast('ร้านยังไม่เปิดระบบสั่งซื้ออัตโนมัติ', 'error');
  busy = true; $('quote').disabled = true; $('quote').textContent = 'กำลังจับคู่ไอดี…';
  try { quote = await callWorker('/ammo/quote', { productId: P.id, target }, { guest: true }); renderQuote(); }
  catch (e) { toast(e.message || 'จับคู่ไอดีไม่สำเร็จ', 'error'); }
  finally { busy = false; refreshGate(); }
}

function renderQuote() {
  const q = quote, r = $('result'), exact = q.ammoTotal === q.target;
  r.classList.remove('hidden');
  const tabs = [user && ['wallet', 'เครดิต'], ['slip', 'พร้อมเพย์'], ['angpao', 'ซองอั่งเปา']].filter(Boolean);
  if (!tabs.some(t => t[0] === method)) method = tabs[0][0];
  r.innerHTML = `
    <div class="rounded-2xl bg-gallery p-5 space-y-2">
      <p class="text-sm ${exact ? 'text-[#0a7a3b]' : 'text-launchOrange'} font-semibold">${exact ? 'ได้ตรงตามที่สั่ง' : `ไม่มีชุดที่ได้ ${q.target.toLocaleString('th-TH')} กองพอดี · นี่คือใกล้ที่สุด`}</p>
      <p class="text-3xl font-heading font-semibold">${q.ammoTotal.toLocaleString('th-TH')} กอง</p>
      <p class="text-sm text-slate">${q.ids} ไอดี (${q.ammo.map(a => a.toLocaleString('th-TH')).join(' + ')} กอง)</p>
      <div class="flex justify-between items-baseline border-t border-hairline pt-3 mt-1"><span class="text-slate">ยอดชำระ (${q.ammoTotal} × ฿${money(q.rate)})</span><span class="text-2xl font-heading font-semibold">${baht(q.amount)}</span></div>
      <p class="text-xs text-slate">กันไอดีชุดนี้ไว้ให้อีก <b id="am-left" class="text-ink"></b> นาที</p>
    </div>
    <div class="bg-control/70 p-1 rounded-full grid text-sm" style="grid-template-columns:repeat(${tabs.length},1fr)" role="tablist">
      ${tabs.map(([k, l]) => `<button type="button" data-method="${k}" class="py-2 rounded-full font-medium ${k === method ? 'bg-gallery text-ink shadow-sm' : 'text-slate'}">${l}</button>`).join('')}</div>
    <div id="am-pay-wallet" class="${method === 'wallet' ? '' : 'hidden'} bg-gallery rounded-2xl p-5 flex justify-between"><span class="text-slate">เครดิตคงเหลือ</span><span id="am-bal" class="font-semibold"></span></div>
    <div id="am-pay-slip" class="${method === 'slip' ? '' : 'hidden'} bg-gallery rounded-2xl p-5"></div>
    <div id="am-pay-angpao" class="${method === 'angpao' ? '' : 'hidden'} bg-gallery rounded-2xl p-5 space-y-3">
      <p class="text-sm text-slate">ส่งซองของขวัญ TrueMoney ยอด <b class="text-ink">${baht(q.amount)}</b> แบ่งให้ 1 คน แล้ววางลิงก์ซอง${user ? ' (ใส่เกิน ส่วนที่เกินเข้าเครดิต)' : ' (ยอดต้องไม่น้อยกว่าราคา)'}</p>
      <input id="am-link" type="url" inputmode="url" maxlength="300" placeholder="https://gift.truemoney.com/campaign/?v=..." class="w-full apple-input px-4 py-3">
    </div>
    ${!user ? `<p class="text-xs text-launchOrange">ไม่ได้เข้าสู่ระบบ: ไอดีจะเก็บไว้ในเบราว์เซอร์นี้เท่านั้น ล้างข้อมูลเว็บแล้วจะหาย กรุณาคัดลอกเก็บไว้ทันทีหลังซื้อ</p>` : ''}
    <button id="am-pay" type="button" class="w-full apple-pricing-pill py-4 text-[17px]"></button>`;
  pp = method === 'slip' ? mountPromptPay($('pay-slip'), { getAmount: () => q.amount, idPrefix: 'amp' }) : null;
  renderPayButton();
  clearInterval(timer);
  const tick = () => {
    const ms = q.expiresAt - Date.now(), left = $('left');
    if (!left) return clearInterval(timer);
    if (ms <= 0) { clearInterval(timer); left.textContent = '0'; toast('หมดเวลากันไอดี กรุณากดหาไอดีใหม่', 'error'); clearQuote(); return; }
    left.textContent = `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
  };
  tick(); timer = setInterval(tick, 1000);
}

function renderPayButton() {
  const b = $('pay'); if (!b || !quote) return;
  const bal = $('bal'); if (bal) bal.textContent = balance === null ? '…' : baht(balance);
  const short = method === 'wallet' && balance !== null && balance < quote.amount;
  b.disabled = busy || short;
  b.textContent = busy ? 'กำลังชำระเงิน…' : short ? 'เครดิตไม่พอ · เติมเงินก่อน' : `ชำระ ${baht(quote.amount)}`;
}

async function pay() {
  if (busy || !quote) return;
  const body = { quoteId: quote.quoteId, method };
  if (method === 'slip') {
    const file = pp?.getFile();
    if (!file) return toast('กรุณาแนบรูปสลิปโอนเงิน', 'error');
    body.payload = await readSlipQr(file).catch(() => '');
    if (!body.payload) return toast('อ่าน QR บนสลิปไม่ได้ กรุณาใช้รูปสลิปที่เห็น QR ชัดเจน', 'error');
  }
  if (method === 'angpao') {
    body.link = $('link').value.trim();
    if (!/gift\.truemoney\.com/i.test(body.link)) return toast('กรุณาวางลิงก์ซองของขวัญ TrueMoney', 'error');
  }
  busy = true; renderPayButton();
  try {
    const r = await callWorker('/ammo/pay', body, { guest: true });
    done(r);
  } catch (e) {
    toast(e.message || 'ชำระเงินไม่สำเร็จ', 'error');
    if (e.data?.code === 'stale' || e.data?.code === 'undelivered') clearQuote();
  } finally { busy = false; renderPayButton(); }
}

function done(r) {
  clearQuote();
  const order = { id: r.orderId, orderNumber: r.orderNumber, status: 'completed', accountsDelivered: r.accounts };
  let note = user ? 'ไอดีอยู่ในเมนู "ออเดอร์ของฉัน" ด้วย' : '';
  if (!user) {
    const ok = saveOrder({ orderNumber: r.orderNumber, id: r.orderId, product: P.name, ammoTotal: r.ammoTotal, amount: r.amount, accounts: r.accounts, at: Date.now() });
    note = ok ? 'บันทึกไว้ในเบราว์เซอร์นี้แล้ว (ดูได้ที่หน้านี้) กรุณาคัดลอกเก็บไว้ที่อื่นด้วย' : 'เบราว์เซอร์นี้บันทึกข้อมูลไม่ได้ กรุณาคัดลอกเก็บไว้ตอนนี้';
  }
  if (r.extra > 0) note += ` · ซองเกินราคา ฿${money(r.extra)}${r.extraTo === 'credit' ? ' เข้าเครดิตแล้ว' : ''}`;
  const d = $('done');
  d.classList.remove('hidden');
  d.innerHTML = `<div class="rounded-2xl bg-gallery p-5"><p class="text-sm text-[#0a7a3b] font-semibold">ชำระสำเร็จ · ${esc(r.orderNumber)}</p><p class="text-2xl font-heading font-semibold mt-1">ได้ ${num(r.ammoTotal).toLocaleString('th-TH')} กอง</p><p class="text-sm text-slate mt-1">${esc(note)}</p></div>${credentialBoxHtml(order)}`;
  d.scrollIntoView({ behavior: 'smooth', block: 'start' });
  toast('ชำระสำเร็จ ไอดีขึ้นแล้ว', 'success');
  renderSaved();
}

function renderSaved() {
  const s = $('saved'), list = readSaved().filter(o => o && Array.isArray(o.accounts));
  s.classList.toggle('hidden', !list.length);
  if (!list.length) return;
  s.innerHTML = `<details class="rounded-2xl bg-gallery p-4"><summary class="cursor-pointer font-medium">ไอดีที่ซื้อไว้ในเครื่องนี้ (${list.length})</summary>
    <div class="space-y-4 mt-4">${list.map(o => `<div class="space-y-2"><p class="text-sm"><b>${esc(o.orderNumber)}</b> · ${esc(o.product)} · ${num(o.ammoTotal)} กอง · ${baht(o.amount)} · <span class="text-slate">${new Date(o.at).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' })}</span></p>${credentialBoxHtml({ id: o.id || o.orderNumber, status: 'completed', accountsDelivered: o.accounts })}</div>`).join('')}</div></details>`;
}

function onClick(e) {
  const t = e.target.closest('button'); if (!t || !el.contains(t)) return;
  if (t.dataset.step) { const i = $('target'); i.value = Math.max(minQ(), Math.floor(num(i.value)) + Number(t.dataset.step)); clearQuote(); }
  else if (t.dataset.set) { $('target').value = t.dataset.set; clearQuote(); }
  else if (t.id === 'am-quote') getQuote();
  else if (t.dataset.method) { method = t.dataset.method; renderQuote(); }
  else if (t.id === 'am-pay') pay();
}
