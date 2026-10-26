import { db, auth } from "../firebase-config.js";
import { collection, onSnapshot, query, where, limit } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { esc, num, money, toast, callWorker, imgAttrs } from "./ui.js";

/** Public auctions: live list (open ones with a ticking clock) and the last results. Bids go through the Worker (/auction/bid). */
const FALLBACK = 'https://placehold.co/800x600/f5f5f7/86868b?text=Nugget+Hub';
let ROWS = [], uid = '', busy = '';
const left = (ms) => { const s = Math.max(0, Math.floor((ms - Date.now()) / 1000)), d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return s <= 0 ? 'ปิดแล้ว' : d ? `${d} วัน ${h} ชม.` : h ? `${h} ชม. ${m} นาที` : `${m}:${String(s % 60).padStart(2, '0')}`; };
const minBid = (a) => a.topUid ? num(a.topBid) + Math.max(1, num(a.minStep)) : num(a.startPrice);

function render() {
  const open = ROWS.filter(a => a.status === 'open').sort((a, b) => num(a.endsAt) - num(b.endsAt));
  const typing = document.activeElement?.dataset?.bid; // keep what the visitor is typing across live updates
  document.getElementById('auction-list').innerHTML = open.length ? open.map(a => {
    const mine = uid && a.topUid === uid, ended = num(a.endsAt) <= Date.now(), min = minBid(a);
    return `<article class="apple-card p-4 sm:p-5 space-y-3"><div class="flex gap-4">
      <img ${imgAttrs(a.image || FALLBACK, 200, 200)} alt="" class="w-24 h-24 sm:w-28 sm:h-28 rounded-2xl object-cover bg-mist shrink-0">
      <div class="min-w-0 flex-1"><h2 class="font-semibold text-[17px] leading-snug">${esc(a.name)}</h2>
        <p class="text-xs text-slate mt-1">${num(a.bidCount) ? `${num(a.bidCount)} ครั้ง · นำโดย ${esc(a.topName || '-')}` : 'ยังไม่มีผู้เสนอราคา'}</p>
        <p class="font-heading font-semibold text-2xl mt-1">฿${money(num(a.topBid) || num(a.startPrice))}</p>
        <p class="text-xs mt-0.5" data-end="${num(a.endsAt)}" style="color:#b64400">${ended ? 'ปิดแล้ว' : 'เหลือ ' + left(num(a.endsAt))}</p></div></div>
      ${(a.specs || []).length ? `<ul class="text-[13px] text-slate grid grid-cols-2 gap-x-4 gap-y-0.5">${a.specs.slice(0, 8).map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
      ${mine ? '<p class="text-sm font-medium" style="color:#0a7a3b">คุณนำอยู่ตอนนี้ ✓</p>' : ''}
      <form class="flex gap-2" onsubmit="return placeBid(event, '${esc(a.id)}')"><input data-bid="${esc(a.id)}" type="number" inputmode="decimal" min="${min}" step="1" value="${typing === a.id ? '' : min}" ${ended ? 'disabled' : ''} class="flex-1 min-w-0 apple-input px-4 py-2.5 font-mono" aria-label="ราคาที่เสนอ">
        <button type="submit" ${ended || busy === a.id ? 'disabled' : ''} class="apple-pricing-pill h-11 px-6 text-[15px] font-semibold">${busy === a.id ? '…' : 'ประมูล'}</button></form>
      <p class="text-[11px] text-slate">ขั้นต่ำ ฿${money(min)} · เพิ่มครั้งละอย่างน้อย ฿${money(Math.max(1, num(a.minStep)))}</p></article>`;
  }).join('') : '<div class="apple-card p-8 text-center text-slate">ยังไม่มีการประมูลตอนนี้</div>';
  if (typing) { const el = document.querySelector(`[data-bid="${typing}"]`); if (el && !el.value) el.value = minBid(ROWS.find(a => a.id === typing) || {}); }
  document.getElementById('auction-done').innerHTML = ROWS.filter(a => a.status === 'sold').slice(0, 8).map(a => `<p>${esc(a.name)} · ฿${money(num(a.topBid))} · ผู้ชนะ ${esc(a.topName || '-')}</p>`).join('') || '<p>ยังไม่มีผลการประมูล</p>';
}

window.placeBid = async (e, id) => {
  e.preventDefault();
  if (!auth.currentUser) { location.href = 'login.html?mode=login'; return false; }
  const amount = Number(document.querySelector(`[data-bid="${id}"]`).value);
  busy = id; render();
  try { const r = await callWorker('/auction/bid', { auctionId: id, amount }); toast(`เสนอ ฿${money(r.topBid)} แล้ว คุณนำอยู่`, 'success'); }
  catch (err) { toast(err.message || 'เสนอราคาไม่สำเร็จ', 'error'); }
  busy = ''; render(); return false;
};

onAuthStateChanged(auth, (u) => { uid = u?.uid || ''; render(); });
onSnapshot(query(collection(db, 'auctions'), limit(60)), (s) => { ROWS = s.docs.map(d => ({ ...d.data(), id: d.id })); render(); }, (e) => { console.warn('auctions:', e); render(); });
setInterval(() => document.querySelectorAll('[data-end]').forEach(el => { const t = Number(el.dataset.end); el.textContent = t <= Date.now() ? 'ปิดแล้ว' : 'เหลือ ' + left(t); }), 1000);
