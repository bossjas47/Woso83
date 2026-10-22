import { db, auth } from "../firebase-config.js";
import { collection, doc, onSnapshot, query, serverTimestamp, where, writeBatch } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { esc, num, baht, money, toast, fmtDate, onSettings, getSettings, workerBase, callWorker, notifyAdmin, readSlipQr } from "./ui.js";
import { mountPromptPay, promptpayReady, prepareSlip, slipErrorText } from "./pay.js";

/**
 * Top-up page. Credit is never written from the browser (firestore.rules). Two ways in:
 *  - auto (admin turned on slip check + Worker): the QR on the slip is checked by the Worker and credited at once;
 *  - manual: a pending request with the slip image; an admin approves it in the back office.
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
  method = m;
  ['promptpay', 'truemoney'].forEach(k => {
    $(`panel-${k}`).classList.toggle('hidden', k !== m);
    $(`tab-${k}`).className = `py-2 rounded-full font-medium transition ${k === m ? 'bg-gallery text-ink shadow-sm' : 'text-slate hover:text-ink'}`;
  });
  updateNote();
}
const autoMode = () => getSettings().slipAutoVerify === true && !!workerBase();
function updateNote() {
  $('topup-mode-note').textContent = method === 'promptpay'
    ? (autoMode() ? 'ระบบตรวจสลิปอัตโนมัติ ผ่านแล้วได้เครดิตทันที' : 'แอดมินตรวจสลิปแล้วเติมเครดิตให้ โดยปกติไม่เกิน 15 นาที')
    : 'แอดมินตรวจสอบซองแล้วเติมเครดิตให้';
  if (!submitting) $('btn-topup').textContent = method === 'promptpay' ? (autoMode() ? 'ส่งสลิปและรับเครดิต' : 'ส่งสลิปโอนเงิน') : 'ส่งซองของขวัญ';
}

function setBusy(on, label) {
  submitting = on;
  $('btn-topup').disabled = on;
  if (on) $('btn-topup').textContent = label; else updateNote();
}

async function executeTopup() {
  if (submitting) return;
  if (!user) { toast('กรุณาเข้าสู่ระบบก่อนเติมเงิน', 'error'); return; }
  if (!(amount >= MIN && amount <= MAX)) { toast(`กรุณาใส่จำนวนเงิน ${MIN} – ${money(MAX, 0)} บาท`, 'error'); $('amount-input').focus(); return; }
  const { promo, bonus } = bestPromo(promos, amount);
  let slip = null, proof = '';
  if (method === 'truemoney') {
    proof = $('tm-link').value.trim();
    if (!/^https:\/\/gift\.truemoney\.com\//.test(proof)) { toast('กรุณากรอกลิงก์ซองของขวัญ TrueMoney ให้ถูกต้อง', 'error'); return; }
    setBusy(true, 'กำลังส่ง…');
  } else {
    if (!promptpayReady()) { toast('ร้านยังไม่ได้ตั้งค่า QR พร้อมเพย์', 'error'); return; }
    const file = pp.getFile();
    setBusy(true, 'กำลังเตรียมสลิป…');
    try { slip = await prepareSlip(file); } catch (e) { setBusy(false); toast(e.message, 'error'); return; }
    if (autoMode()) {
      setBusy(true, 'กำลังตรวจสลิป…');
      const r = await tryAuto(file);
      if (r === 'done' || r === 'rejected') { setBusy(false); return; }
    }
    proof = 'สลิปแนบในระบบ';
  }
  setBusy(true, 'กำลังส่ง…');
  try {
    const ref = doc(collection(db, 'topup_transactions'));
    const batch = writeBatch(db);
    batch.set(ref, {
      txnId: 'TOPUP-' + ref.id.slice(0, 8).toUpperCase(), uid: user.uid, email: user.email || '',
      amount, bonusCredit: bonus, finalCredit: amount + bonus, ...(promo ? { promoId: promo.id } : {}),
      paymentMethod: method, proofRef: proof, ...(slip ? { slipHash: slip.hash, hasSlip: true } : {}),
      status: 'pending', createdAt: serverTimestamp()
    });
    if (slip) {
      batch.set(doc(db, 'slip_images', ref.id), { kind: 'topup', uid: user.uid, image: slip.image, createdAt: serverTimestamp() });
      batch.set(doc(db, 'slip_hashes', slip.hash), { kind: 'topup', refId: ref.id, uid: user.uid, createdAt: serverTimestamp() });
    }
    await batch.commit();
    notifyAdmin('topup', ref.id);
    pp.reset(); $('tm-link').value = '';
    toast('ส่งหลักฐานแล้ว แอดมินจะตรวจสอบและเติมเครดิตให้', 'success');
  } catch (e) {
    console.warn('topup:', e);
    toast(slipErrorText(e), 'error');
  } finally { setBusy(false); }
}

/** Auto check through the Worker. 'done' | 'rejected' | 'manual' (fall back to a pending request). */
async function tryAuto(file) {
  try {
    const payload = await readSlipQr(file);
    if (!payload) { toast('อ่าน QR บนสลิปไม่ได้ ส่งให้แอดมินตรวจแทน'); return 'manual'; }
    const r = await callWorker('/', { amount, payload });
    if (r.status === 'completed') { pp.reset(); toast(`เติมเครดิตสำเร็จ +${money(r.credit)}`, 'success'); return 'done'; }
    if (r.status === 'rejected') { toast(r.message || 'ตรวจสลิปไม่ผ่าน', 'error'); return 'rejected'; }
  } catch (e) { console.warn('auto slip:', e); }
  toast('ตรวจอัตโนมัติไม่ได้ในตอนนี้ ส่งให้แอดมินตรวจแทน');
  return 'manual';
}

const ST = { pending: ['รอตรวจสอบ', 'bg-[#fff3e6] text-[#a04a00]'], completed: ['เติมแล้ว', 'bg-[#e8f8ee] text-[#0a7a3b]'], rejected: ['ไม่อนุมัติ', 'bg-mist text-slate'] };
function renderHistory() {
  const box = $('topup-history');
  if (!user) { box.innerHTML = `<p class="py-8 text-center text-slate text-sm">เข้าสู่ระบบเพื่อดูประวัติการเติมเงิน</p>`; return; }
  if (!history.length) { box.innerHTML = `<p class="py-8 text-center text-slate text-sm">ยังไม่มีประวัติการเติมเงิน</p>`; return; }
  box.innerHTML = history.map(t => {
    const [label, cls] = ST[t.status] || [t.status, 'bg-mist text-slate'];
    return `<div class="py-3 flex items-center justify-between gap-3">
      <div class="min-w-0"><p class="font-medium">${baht(t.amount)} ${num(t.bonusCredit) ? `<span class="text-emerald-600 text-sm">+${money(t.bonusCredit)} โบนัส</span>` : ''}</p>
        <p class="text-xs text-slate truncate">${esc(t.txnId || '')} · ${t.paymentMethod === 'truemoney' ? 'TrueMoney' : 'พร้อมเพย์'} · ${esc(fmtDate(t.createdAt))}</p>
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
onSettings(updateNote);

pp = mountPromptPay($('panel-promptpay'), { getAmount: () => amount, idPrefix: 'tp' });
$('amount-input').addEventListener('input', onAmount);
const preset = Number(new URLSearchParams(location.search).get('amount'));
if (preset >= MIN) $('amount-input').value = preset;
switchTopupPaymentTab('promptpay');
onAmount();
Object.assign(window, { setAmount, switchTopupPaymentTab, executeTopup });
