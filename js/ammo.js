import { auth } from "../firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { esc, num, baht, money, toast, callWorker, readSlipQr, workerBase, getSettings } from "./ui.js";
import { mountPromptPay } from "./pay.js";
import { ammoRateOf, ammoListRate } from "./ammo-rate.js";
import { credentialBoxHtml } from "./orders-ui.js";

/**
 * Ammo bundle checkout (ไก่กระสุน) on the product page. The customer types how many กอง they want, the Worker
 * picks the game IDs that add up to it (or the closest total) and holds them for 15 minutes (/ammo/quote),
 * then the customer pays that real total (/ammo/pay: credit, slip or angpao). Products with requireLogin === false
 * can be bought without an account: the IDs are then kept only in this browser (localStorage 'ammo-orders').
 */
const LS = 'ammo-orders', RESUME = 'ammo-resume'; // RESUME: { pid, quote, url } while the customer tops up; the top-up page links back
const readSaved = () => { try { return JSON.parse(localStorage.getItem(LS) || '[]'); } catch { return []; } };
const saveOrder = (o) => { try { localStorage.setItem(LS, JSON.stringify([o, ...readSaved()].slice(0, 50))); return true; } catch { return false; } };

let P = null, el = null, user = null, quote = null, method = 'wallet', busy = false, timer = 0, pp = null, balance = null;
const $ = (id) => el.querySelector('#am-' + id);
const guestOk = () => P.requireLogin === false;
const closedNow = (s) => { // same rule as ammoClosedNow() in worker/slip-worker.js
  if (s.ammoClosed === true) return true;
  const f = /^(\d\d):(\d\d)$/.exec(s.ammoCloseFrom || ''), t = /^(\d\d):(\d\d)$/.exec(s.ammoCloseTo || '');
  if (!f || !t) return false;
  const m = Math.floor(((Date.now() + 7 * 3600e3) % 864e5) / 6e4), a = +f[1] * 60 + +f[2], b = +t[1] * 60 + +t[2];
  return a === b ? false : a < b ? m >= a && m < b : m >= a || m < b;
};
const listRate = () => ammoListRate(P);
const rate = (qty = 0) => ammoRateOf(P, qty);
const tiers = () => (Array.isArray(P.ammoTiers) ? P.ammoTiers : []).filter(t => num(t.min) > 0 && num(t.value) > 0).sort((a, b) => num(a.min) - num(b.min));
const tiersHtml = () => tiers().length && (!num(P.ammoTiersTo) || Date.now() <= P.ammoTiersTo) ? `<p class="text-xs text-launchOrange mt-1">ซื้อเยอะลดเพิ่ม: ${tiers().map(t => `${num(t.min).toLocaleString('th-TH')} กองขึ้นไป ลด ${t.type === 'percent' ? num(t.value) + '%' : '฿' + money(t.value)}${t.type === 'percent' ? '' : '/กอง'}`).join(' · ')}</p>` : '';
const rateHtml = () => rate() < listRate() ? `<s class="text-steel">฿${money(listRate())}</s> <b class="text-launchOrange">฿${money(rate())}</b>` : `฿${money(rate())}`;
const minQ = () => Math.max(1, Math.floor(num(P.ammoMin)) || 1);
const stock = () => Math.max(0, Math.floor(num(P.stock)));

export function mountAmmo(root, product) {
  P = product; el = root; balance = window.__wallet?.balance ?? null;
  el.classList.remove('hidden');
  const quick = [...new Set([50, 100, 200, 500, 1000, ...tiers().map(t => num(t.min))])].filter(n => n >= minQ() && n <= stock()).sort((a, b) => a - b).slice(0, 6);
  el.innerHTML = `
    <div id="am-login" class="hidden rounded-2xl bg-gallery p-4 text-sm flex items-center justify-between gap-3">
      <span>สินค้านี้ต้องเข้าสู่ระบบก่อนซื้อ</span><a href="login.html?mode=login&next=${encodeURIComponent(location.pathname + location.search)}" class="apple-pricing-pill px-4 py-2 text-sm">เข้าสู่ระบบ</a>
    </div>
    <div id="am-closed" class="hidden rounded-2xl bg-gallery p-4 text-sm text-launchOrange font-medium"></div>
    <div><h2 class="text-xl font-heading font-semibold">สั่งตามจำนวนกอง</h2>
      <p class="text-sm text-slate mt-0.5">${rateHtml()} / กอง · ขั้นต่ำ ${minQ()} กอง · พร้อมส่ง ${stock().toLocaleString('th-TH')} กอง</p>${tiersHtml()}</div>
    <div class="flex items-center justify-between gap-3">
      <label for="am-target" class="font-medium">ต้องการกี่กอง</label>
      <div class="flex items-center bg-gallery rounded-full p-1">
        <button type="button" data-step="-10" aria-label="ลด 10 กอง" class="w-10 h-10 rounded-full hover:bg-mist text-2xl leading-none">−</button>
        <input id="am-target" type="number" inputmode="numeric" min="${minQ()}" max="${stock()}" value="${Math.min(stock(), Math.max(minQ(), Math.floor(num(new URLSearchParams(location.search).get('qty'))) || 100))}" class="w-20 text-center text-base font-semibold bg-transparent focus:outline-none">
        <button type="button" data-step="10" aria-label="เพิ่ม 10 กอง" class="w-10 h-10 rounded-full hover:bg-mist text-2xl leading-none">+</button>
      </div>
    </div>
    ${quick.length ? `<div class="flex flex-wrap gap-2">${quick.map(n => `<button type="button" data-set="${n}" class="px-3.5 py-1.5 rounded-full text-[14px] border border-hairline bg-gallery hover:bg-mist">${n.toLocaleString('th-TH')} กอง${rate(n) < listRate() ? ` <span class="text-launchOrange text-[12px]">ประหยัด ฿${money((listRate() - rate(n)) * n)}</span>` : ''}</button>`).join('')}</div>` : ''}
    <div id="am-codebox" class="hidden"><input id="am-code" type="text" maxlength="40" autocomplete="off" placeholder="โค้ดส่วนลด (ไม่บังคับ · สมาชิกเท่านั้น)" class="w-full apple-input px-4 py-3 uppercase"></div>
    <p id="am-nudge" class="hidden text-sm rounded-2xl bg-mist px-4 py-2.5"></p>
    <button id="am-quote" type="button" class="w-full apple-explore-pill py-3.5 text-[16px] bg-gallery">หาไอดีให้</button>
    <div id="am-result" class="hidden space-y-5"></div>
    <div id="am-done" class="hidden space-y-4"></div>
    <div id="am-saved" class="hidden space-y-3"></div>`;
  el.addEventListener('click', onClick);
  el.addEventListener('input', (e) => { if (e.target.id === 'am-target' && quote) clearQuote(); });
  el.addEventListener('input', nudge); el.addEventListener('click', () => setTimeout(nudge, 0)); nudge();
  onAuthStateChanged(auth, (u) => { user = u; if (!u && method === 'wallet') method = 'slip'; refreshGate(); if (quote) renderQuote(); });
  document.addEventListener('wallet', (e) => { balance = e.detail.balance; if (quote) renderPayButton(); });
  renderSaved();
  try { // back from the top-up page: restore the held quote if it is still ours and not expired
    const r = JSON.parse(sessionStorage.getItem(RESUME) || 'null'); sessionStorage.removeItem(RESUME);
    if (r?.pid === P.id && r.quote?.expiresAt > Date.now()) { quote = r.quote; method = 'wallet'; $('target').value = quote.target; renderQuote(); }
  } catch { /* ignore */ }
}

function refreshGate() {
  const blocked = !user && !guestOk();
  $('login').classList.toggle('hidden', !blocked);
  const st = getSettings(), closed = closedNow(st);
  $('closed').classList.toggle('hidden', !closed); $('closed').textContent = closed ? (st.ammoClosedMsg || (st.ammoCloseFrom && st.ammoClosed !== true ? `ปิดรับออเดอร์ไก่กระสุนช่วง ${st.ammoCloseFrom}–${st.ammoCloseTo} น.` : 'ปิดรับออเดอร์ไก่กระสุนชั่วคราว')) : '';
  $('codebox').classList.toggle('hidden', !user);
  $('quote').disabled = blocked || stock() <= 0 || closed;
  $('quote').textContent = stock() <= 0 ? 'สินค้าหมด' : 'หาไอดีให้';
}

function clearQuote() { quote = null; clearInterval(timer); $('result').classList.add('hidden'); $('result').innerHTML = ''; }

async function getQuote() {
  const target = Math.floor(num($('target').value));
  if (target < minQ()) return toast(`สั่งขั้นต่ำ ${minQ()} กอง`, 'error');
  if (!workerBase()) return toast('ร้านยังไม่เปิดระบบสั่งซื้ออัตโนมัติ', 'error');
  busy = true; $('quote').disabled = true; $('quote').textContent = 'กำลังจับคู่ไอดี…';
  try { quote = await callWorker('/ammo/quote', { productId: P.id, target, promoCode: user ? $('code').value.trim() : '' }, { guest: true }); renderQuote(); }
  catch (e) { toast(e.message || 'จับคู่ไอดีไม่สำเร็จ', 'error'); }
  finally { busy = false; refreshGate(); }
}

/** Close to the next discount step? Say how few extra กอง unlock the cheaper rate and what it costs. */
function nudge() {
  const box = $('nudge'), q = Math.floor(num($('target')?.value)); if (!box) return;
  const next = tiers().find(t => num(t.min) > q && num(t.min) <= stock() && rate(num(t.min)) < rate(q));
  const extra = next ? num(next.min) - q : 0;
  box.classList.toggle('hidden', !next || extra > Math.max(50, num(next.min) * .15) || q < minQ());
  if (box.classList.contains('hidden')) return;
  const cost = rate(num(next.min)) * num(next.min) - rate(q) * q;
  box.innerHTML = cost <= 0 ? `เพิ่มอีก <b>${extra.toLocaleString('th-TH')}</b> กอง (เป็น ${num(next.min).toLocaleString('th-TH')}) ยอดรวม<b class="text-launchOrange">ถูกลง ฿${money(-cost)}</b> เพราะได้เรตใหม่ ฿${money(rate(num(next.min)))}/กอง`
    : `เพิ่มอีก <b>${extra.toLocaleString('th-TH')}</b> กอง (เป็น ${num(next.min).toLocaleString('th-TH')}) จ่ายเพิ่มแค่ <b class="text-launchOrange">฿${money(cost)}</b> ได้เรตใหม่ ฿${money(rate(num(next.min)))}/กอง`;
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
      <div class="flex justify-between items-baseline gap-3 border-t border-hairline pt-3 mt-1"><span class="text-slate min-w-0">${q.promo ? `ยอดชำระ (ใช้โค้ด ${esc(q.promo.code)} ลด ฿${money(q.promo.discount)})` : `ยอดชำระ (${q.ammoTotal} × ฿${money(q.rate)}${q.listRate > q.rate ? ` ลดจาก ฿${money(q.listRate)}` : ''})`}</span><span class="text-2xl font-heading font-semibold">${baht(q.amount)}</span></div>
      ${q.promoMsg ? `<p class="text-xs text-launchOrange">${esc(q.promoMsg)}</p>` : ''}
      <p class="text-xs text-slate flex flex-wrap items-center gap-x-3 gap-y-1">กันไอดีชุดนี้ไว้ให้อีก <b id="am-left" class="text-ink"></b> นาที <button id="am-ext" type="button" class="hidden text-appleBlue font-medium">ต่อเวลา +5 นาที (ครั้งเดียว)</button></p>
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
    left.classList.toggle('text-launchOrange', ms < 180e3);
    $('ext')?.classList.toggle('hidden', !(ms < 180e3 && !q.extended));
  };
  tick(); timer = setInterval(tick, 1000);
}

function renderPayButton() {
  const b = $('pay'); if (!b || !quote) return;
  const bal = $('bal'); if (bal) bal.textContent = balance === null ? '…' : baht(balance);
  const short = method === 'wallet' && balance !== null && balance < quote.amount;
  b.disabled = busy;
  b.textContent = busy ? 'กำลังชำระเงิน…' : short ? 'เครดิตไม่พอ · เติมเงินแล้วกลับมาซื้อต่อ' : `ชำระ ${baht(quote.amount)}`;
}

async function extendHold() {
  if (!quote || busy) return;
  try { const r = await callWorker('/ammo/extend', { quoteId: quote.quoteId }, { guest: true }); quote.expiresAt = r.expiresAt; quote.extended = true; $('ext')?.classList.add('hidden'); toast('ต่อเวลาให้อีก 5 นาทีแล้ว', 'success'); }
  catch (e) { toast(e.message || 'ต่อเวลาไม่สำเร็จ', 'error'); }
}

async function pay() {
  if (busy || !quote) return;
  if (method === 'wallet' && balance !== null && balance < quote.amount) { // short of credit: keep this quote, top up, come back to it
    try { sessionStorage.setItem(RESUME, JSON.stringify({ pid: P.id, quote, url: location.pathname + location.search })); } catch { /* storage off: they just search again */ }
    location.href = 'topup.html'; return;
  }
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
  else if (t.id === 'am-ext') extendHold();
}
