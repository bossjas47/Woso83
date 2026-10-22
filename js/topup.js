import { db, auth } from "../firebase-config.js";
import { collection, onSnapshot, query, where } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { esc, num, baht, money, toast, fmtDate, onSettings, getSettings, workerBase, callWorker, readSlipQr } from "./ui.js";
import { mountPromptPay, promptpayReady } from "./pay.js";

/**
 * Top-up page. Credit is never written from the browser (firestore.rules). Two ways in:
 *  - auto (admin turned on slip check + Worker): the QR on the slip is checked by the Worker and credited at once;
 *  - manual: a pending request with the slip image; an admin approves it in the back office.
 *  - ซองอั่งเปา TrueMoney (needs the Worker): redeemed by the Worker and credited at once.
 * Bonus comes from topup_promos (admin-managed): the best active promotion whose minimum the amount reaches.
 */
const MIN = 20, MAX = 50000;
let user = null, amount = 0, method = 'promptpay', promos = [], history = [], submitting = false, pp = null;
const $ = (id) => document.getElementById(id);

export function bestPromo(list, amt) {
  let best = null, bonus = 0;
  for (const p of list) {
    if (p.active === false || amt < num(p.minAmount)) continue;
    const b = p.type === 'percent' ? Math.floor(amt * num(p.value) / 100) : Math.floor(num(p.value));
    if (b > bonus) { bonus = b; best = p; }
  }
  return { promo: best, bonus };
}
const promoText = (p) => p.type === 'percent' ? `รับโบนัส ${num(p.value)}%` : `รับโบนัส ${money(p.value, 0)} บาท`;

function renderPromos() {
  const box = $('promo-list');
  const list = promos.filter(p => p.active !== false).sort((a, b) => num(a.minAmount) - num(b.minAmount));
  $('promo-section').classList.toggle('hidden', !list.length);
  box.innerHTML = list.map(p => `<button type="button" onclick="setAmount(${num(p.minAmount)})" class="snap-start shrink-0 w-56 text-left rounded-2xl p-4 border transition ${amount >= num(p.minAmount) && bestPromo(promos, amount).promo?.id === p.id ? 'border-2 border-pricingBlue bg-[#f2f8ff]' : 'border-hairline bg-gallery hover:border-steel'}">
      <p class="text-xs text-slate">เติมครบ ${money(p.minAmount, 0)} บาท</p>
      <p class="text-lg font-heading font-semibold text-emerald-600 mt-0.5">${esc(promoText(p))}</p>
      ${p.label ? `<p class="text-xs text-slate mt-1 line-clamp-1">${esc(p.label)}</p>` : ''}
    </button>`).join('');
  const quick = [...new Set([50, 100, 300, 500, ...list.map(p => num(p.minAmount))])].filter(v => v >= MIN).sort((a, b) => a - b).slice(0, 8);
  $('quick-amounts').innerHTML = quick.map(v => `<button type="button" onclick="setAmount(${v})" class="rounded-xl py-2.5 text-[15px] font-semibold border transition ${amount === v ? 'border-pricingBlue bg-[#f2f8ff] text-pricingBlue' : 'border-hairline bg-gallery'}">${money(v, 0)}</button>`).join('');
}

function setAmount(v) { $('amount-input').value = v || ''; onAmount(); }
function onAmount() {
  const v = Math.round(num($('amount-input').value) * 100) / 100;
  amount = v;
  const { promo, bonus } = bestPromo(promos, v);
  $('sum-amount').textContent = baht(v);
  $('sum-bonus').textContent = `+${baht(bonus)}`;
  $('sum-credit').textContent = money(v + bonus);
  $('sum-promo').textContent = promo ? `ได้รับโปรโมชั่น: เติมครบ ${money(promo.minAmount, 0)} ${promoText(promo)}` : '';
  $('tm-amount').textContent = baht(v);
  renderPromos();
  pp?.refresh();
}

function switchTopupPaymentTab(m) {
  if (m === 'angpao' && !workerBase()) m = 'promptpay';
  method = m;
  $('tab-angpao').classList.toggle('hidden', !workerBase());
  $('topup-tabs').classList.toggle('grid-cols-2', !!workerBase()); $('topup-tabs').classList.toggle('grid-cols-1', !workerBase());
  ['promptpay', 'angpao'].forEach(k => {
    $(`panel-${k}`).classList.toggle('hidden', k !== m);
    $(`tab-${k}`).className = `py-2 rounded-full font-medium transition ${k === m ? 'bg-gallery text-ink shadow-sm' : 'text-slate hover:text-ink'}`;
  });
  updateNote();
}
const autoMode = () => getSettings().slipAutoVerify === true && !!workerBase();
function updateNote() {
  $('topup-mode-note').textContent = method === 'promptpay'
    ? (autoMode() ? 'บอทเช็กสลิปให้เอง ผ่านปุ๊บเครดิตเข้าปั๊บ' : 'ร้านยังไม่เปิดระบบตรวจสลิปอัตโนมัติ (เติมด้วยซองอั่งเปาแทนได้)')
    : 'บอทรับซองให้เอง เครดิตเข้าทันที';
  if (!submitting) $('btn-topup').textContent = method === 'promptpay' ? 'ส่งสลิปและรับเครดิต' : 'รับซองและเติมเครดิต';
}

function setBusy(on, label) {
  submitting = on;
  $('btn-topup').disabled = on;
  if (on) $('btn-topup').textContent = label; else updateNote();
}

async function executeTopup() {
  if (submitting) return;
  if (!user) { toast('กรุณาเข้าสู่ระบบก่อนเติมเงิน', 'error'); return; }
  if (method === 'angpao') return redeemAngpao();
  if (!(amount >= MIN && amount <= MAX)) { toast(`กรุณาใส่จำนวนเงิน ${MIN} – ${money(MAX, 0)} บาท`, 'error'); $('amount-input').focus(); return; }
  if (!promptpayReady()) { toast('ร้านยังไม่ได้ตั้งค่า QR พร้อมเพย์', 'error'); return; }
  if (!autoMode()) { toast('ร้านยังไม่เปิดระบบตรวจสลิปอัตโนมัติ กรุณาติดต่อแอดมิน', 'error'); return; }
  const file = pp.getFile();
  if (!file) { toast('กรุณาแนบรูปสลิปโอนเงิน', 'error'); return; }
  setBusy(true, 'กำลังตรวจสลิป…');
  await verifySlip(file);
  setBusy(false);
}

/** TrueMoney gift voucher: the Worker redeems it into the shop wallet and credits the amount received + promo bonus. */
async function redeemAngpao() {
  const link = $('tm-link').value.trim();
  if (!/^https:\/\/gift\.truemoney\.com\//.test(link)) { toast('กรุณาวางลิงก์ซองอั่งเปา TrueMoney ให้ถูกต้อง', 'error'); $('tm-link').focus(); return; }
  setBusy(true, 'กำลังรับซอง…');
  try {
    const r = await callWorker('/angpao', { link });
    $('tm-link').value = '';
    toast(`เติมเครดิตสำเร็จ +${money(r.credit)}${r.bonus ? ` (รวมโบนัส ${money(r.bonus)})` : ''}`, 'success');
  } catch (e) {
    console.warn('angpao:', e);
    toast(e.message || 'รับซองไม่สำเร็จ', 'error');
  } finally { setBusy(false); }
}

/** Slips are checked by the API only: credited at once, or an error to try again (no manual queue). */
async function verifySlip(file) {
  try {
    const payload = await readSlipQr(file);
    if (!payload) { toast('อ่าน QR บนสลิปไม่ได้ กรุณาใช้รูปสลิปที่เห็น QR ชัดเจน (ไม่ครอป ไม่เบลอ)', 'error'); return; }
    const r = await callWorker('/', { amount, payload });
    if (r.status === 'completed') { pp.reset(); toast(`เติมเครดิตสำเร็จ +${money(r.credit)}`, 'success'); return; }
    toast(r.message || 'ตรวจสลิปไม่ผ่าน', 'error');
  } catch (e) { console.warn('slip:', e); toast(e.message || 'ตรวจสลิปไม่ได้ในตอนนี้ กรุณาลองใหม่อีกครั้ง', 'error'); }
}

const ST = { pending: ['รอตรวจสอบ', 'bg-[#fff3e6] text-[#a04a00]'], completed: ['เติมแล้ว', 'bg-[#e8f8ee] text-[#0a7a3b]'], rejected: ['ไม่อนุมัติ', 'bg-mist text-slate'] };
function renderHistory() {
  const box = $('topup-history');
  if (!user) { box.innerHTML = `<p class="py-8 text-center text-slate text-sm">เข้าสู่ระบบเพื่อดูประวัติการเติมเงิน</p>`; return; }
  if (!history.length) { box.innerHTML = `<p class="py-8 text-center text-slate text-sm">ยังไม่เคยเติม เติมครั้งแรกรับโบนัสตามโปรได้เลย</p>`; return; }
  box.innerHTML = history.map(t => {
    const [label, cls] = ST[t.status] || [t.status, 'bg-mist text-slate'];
    return `<div class="py-3 flex items-center justify-between gap-3">
      <div class="min-w-0"><p class="font-medium">${baht(t.amount)} ${num(t.bonusCredit) ? `<span class="text-emerald-600 text-sm">+${money(t.bonusCredit)} โบนัส</span>` : ''}</p>
        <p class="text-xs text-slate truncate">${esc(t.txnId || '')} · ${t.paymentMethod === 'angpao' ? 'ซองอั่งเปา' : t.paymentMethod === 'truemoney' ? 'TrueMoney' : 'พร้อมเพย์'} · ${esc(fmtDate(t.createdAt))}</p>
        ${t.status === 'rejected' && t.adminNote ? `<p class="text-xs text-launchOrange">${esc(t.adminNote)}</p>` : ''}</div>
      <span class="text-[11px] font-semibold px-2.5 py-1 rounded-full whitespace-nowrap ${cls}">${label}</span></div>`;
  }).join('');
}

let unsubHist = null;
onAuthStateChanged(auth, (u) => {
  user = u;
  $('login-needed').classList.toggle('hidden', !!u);
  if (unsubHist) { unsubHist(); unsubHist = null; }
  history = [];
  renderHistory();
  if (u) unsubHist = onSnapshot(query(collection(db, 'topup_transactions'), where('uid', '==', u.uid)), (s) => {
    history = s.docs.map(d => d.data()).sort((a, b) => (b.createdAt?.toMillis?.() ?? Date.now()) - (a.createdAt?.toMillis?.() ?? Date.now())).slice(0, 30);
    renderHistory();
  }, (e) => console.warn('history:', e));
});
onSnapshot(collection(db, 'topup_promos'), (s) => { promos = s.docs.map(d => ({ id: d.id, ...d.data() })); onAmount(); }, () => { promos = []; onAmount(); });
onSettings(() => switchTopupPaymentTab(method));

pp = mountPromptPay($('panel-promptpay'), { getAmount: () => amount, idPrefix: 'tp' });
$('amount-input').addEventListener('input', onAmount);
const preset = Number(new URLSearchParams(location.search).get('amount'));
if (preset >= MIN) $('amount-input').value = preset;
switchTopupPaymentTab('promptpay');
onAmount();
Object.assign(window, { setAmount, switchTopupPaymentTab, executeTopup });
