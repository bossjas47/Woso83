import { db, auth } from "../firebase-config.js";
import { collection, query, where, onSnapshot, doc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { esc, num, money } from "./ui.js";

/** Credit history = wallet_logs (spend, refunds, admin changes) + completed top-ups. Angpao writes both, so its log row is skipped. */
const METHOD = { promptpay: 'พร้อมเพย์', angpao: 'ซองอั่งเปา' };
const ms = (v) => v?.toMillis?.() ?? (v ? new Date(v).getTime() : 0);
let logs = [], tops = [];

function render() {
  const rows = [
    ...logs.filter(l => !String(l.note || '').startsWith('ซองอั่งเปา')).map(l => ({ t: ms(l.at), delta: num(l.delta), note: l.note || 'ปรับเครดิต', after: l.after })),
    ...tops.filter(t => t.status === 'completed').map(t => ({ t: ms(t.completedAt) || ms(t.createdAt), delta: num(t.finalCredit), note: `เติมเงิน (${METHOD[t.paymentMethod] || 'อื่น ๆ'})${num(t.bonusCredit) ? ` · โบนัส ${money(t.bonusCredit)}` : ''}` }))
  ].sort((a, b) => b.t - a.t).slice(0, 100);
  document.getElementById('wallet-list').innerHTML = rows.length ? rows.map(r => `<div class="soft-card px-4 py-3 flex items-center justify-between gap-3">
    <div class="min-w-0"><p class="text-[15px] font-medium leading-snug">${esc(r.note)}</p><p class="text-xs text-slate mt-0.5">${r.t ? new Date(r.t).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' }) : ''}${r.after != null ? ` · คงเหลือ ฿${money(r.after)}` : ''}</p></div>
    <p class="shrink-0 font-heading font-semibold ${r.delta >= 0 ? 'text-emerald-600' : 'text-ink'}">${r.delta >= 0 ? '+' : '−'}฿${money(Math.abs(r.delta))}</p></div>`).join('')
    : '<div class="soft-card py-12 px-6 text-center"><p class="font-semibold">ยังไม่มีรายการ</p></div>';
}

let unsubs = [];
onAuthStateChanged(auth, (u) => {
  unsubs.forEach(f => f()); unsubs = []; logs = []; tops = [];
  if (!u) { document.getElementById('wallet-list').innerHTML = '<div class="soft-card py-12 px-6 text-center"><p class="font-semibold">เข้าสู่ระบบเพื่อดูประวัติเครดิต</p><a href="login.html?mode=login&next=wallet.html" class="apple-pricing-pill px-6 py-2.5 text-[15px] mt-4">เข้าสู่ระบบ</a></div>'; return; }
  const fail = (e) => console.warn('wallet history:', e);
  unsubs = [
    onSnapshot(doc(db, 'users', u.uid), (s) => { document.getElementById('wallet-total').textContent = `฿${money(s.data()?.walletBalance)}`; }, fail),
    onSnapshot(query(collection(db, 'wallet_logs'), where('uid', '==', u.uid)), (s) => { logs = s.docs.map(d => d.data()); render(); }, fail),
    onSnapshot(query(collection(db, 'topup_transactions'), where('uid', '==', u.uid)), (s) => { tops = s.docs.map(d => d.data()); render(); }, fail)
  ];
});
