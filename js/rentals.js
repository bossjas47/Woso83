import { db, auth } from "../firebase-config.js";
import { collection, query, where, onSnapshot, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { esc, num, money, toast, callWorker } from "./ui.js";

/**
 * "การเช่าของฉัน": the renter's own rentals (Firestore, read-only for the browser).
 * The login is never stored in these documents: "ดูรหัส" asks the Worker, which answers only while the rental runs.
 */
const STATUS = {
  active: ['กำลังเช่า', 'text-appleBlue'], expired: ['หมดเวลาแล้ว', 'text-launchOrange'],
  returned: ['คืนแล้ว · รอร้านตรวจ', 'text-slate'], closed: ['เสร็จสิ้น', 'text-emerald-600']
};
const DEPOSIT = { held: 'มัดจำ: ร้านถือไว้ รอตรวจ', refunded: 'มัดจำ: คืนเข้าเครดิตแล้ว', forfeited: 'มัดจำ: ร้านยึดไว้', none: '' };
const el = () => document.getElementById('rental-list');
const fmt = (ms) => new Date(ms).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' });

let RENTALS = [], uid = '', authReady = false;
const creds = {}, rates = {}, open = {}, busy = {};

function left(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return `${d ? d + ' วัน ' : ''}${p(h)}:${p(m)}:${p(x)}`;
}
async function loadRate(pid) {
  if (pid in rates) return;
  rates[pid] = 0;
  try { rates[pid] = num((await getDoc(doc(db, 'products', pid))).data()?.rentHourPrice); } catch (e) { console.warn('rate:', e); }
  render();
}

function card(r) {
  const live = r.status === 'active' && Date.now() < num(r.endMs);
  const st = r.status === 'active' && !live ? STATUS.expired : (STATUS[r.status] || [r.status, 'text-slate']);
  const c = live ? creds[r.id] : null;
  const rate = rates[r.productId] || 0;
  loadRate(r.productId);
  return `<article class="apple-card p-5" data-rental="${esc(r.id)}">
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0"><h2 class="text-[17px] font-semibold leading-snug">${esc(r.productName)}</h2>
        <p class="text-sm text-slate mt-0.5">${esc(r.hours)} ชม. · เริ่ม ${fmt(num(r.startMs))}</p></div>
      <p class="text-sm font-medium shrink-0 ${st[1]}">${st[0]}</p>
    </div>
    ${live ? `<div class="mt-4 rounded-2xl bg-mist p-4 text-center"><p class="text-xs text-slate">เหลือเวลา · หมด ${fmt(num(r.endMs))}</p><p class="text-3xl font-heading font-semibold tabular-nums mt-1" data-end="${num(r.endMs)}">${left(num(r.endMs) - Date.now())}</p></div>` : `<p class="text-sm text-slate mt-3">สิ้นสุด ${fmt(num(r.endMs))}</p>`}
    ${c ? `<div class="mt-3 rounded-2xl bg-gallery border border-hairline p-4 space-y-2 text-[15px]">
      <div class="flex items-center justify-between gap-3"><span class="min-w-0"><span class="block text-xs text-slate">ไอดี</span><span class="font-semibold select-all break-all">${esc(c.username)}</span></span><button type="button" onclick="copyRentalValue(${esc(JSON.stringify(c.username))})" class="apple-explore-pill px-3 py-1.5 text-xs">คัดลอก</button></div>
      <div class="flex items-center justify-between gap-3"><span class="min-w-0"><span class="block text-xs text-slate">รหัสผ่าน</span><span class="font-semibold select-all break-all">${esc(c.password)}</span></span><button type="button" onclick="copyRentalValue(${esc(JSON.stringify(c.password))})" class="apple-explore-pill px-3 py-1.5 text-xs">คัดลอก</button></div>
      <p class="text-xs text-launchOrange">ห้ามเปลี่ยนรหัสผ่านหรือผูกบัญชีอื่น · หมดเวลาแล้วรหัสจะถูกซ่อน</p></div>` : ''}
    ${live ? `<div class="grid grid-cols-3 gap-2 mt-4">
      <button type="button" onclick="showRentalLogin('${esc(r.id)}')" ${busy[r.id] ? 'disabled' : ''} class="apple-pricing-pill h-12 text-[15px] font-semibold">${c ? 'ซ่อนรหัส' : 'ดูรหัส'}</button>
      <button type="button" onclick="toggleExtend('${esc(r.id)}')" class="apple-explore-pill h-12 text-[15px] font-semibold ${open[r.id] ? '!bg-ink !text-gallery' : ''}">ต่อเวลา</button>
      <button type="button" onclick="returnRental('${esc(r.id)}')" ${busy[r.id] ? 'disabled' : ''} class="apple-explore-pill h-12 text-[15px] font-semibold">คืนไอดี</button></div>` : ''}
    ${live && open[r.id] ? (rate > 0 ? `<div class="mt-3 rounded-2xl bg-mist p-4"><p class="text-sm font-medium">ต่อเวลาอีก <span class="text-slate font-normal">(฿${money(rate)}/ชม. · ตัดจากเครดิต)</span></p>
      <div class="grid grid-cols-4 gap-2 mt-3">${[1, 3, 6, 12].map(h => `<button type="button" onclick="extendRental('${esc(r.id)}', ${h})" ${busy[r.id] ? 'disabled' : ''} class="rounded-2xl bg-gallery border border-hairline py-2.5 text-sm font-semibold">+${h} ชม.<span class="block text-[11px] text-slate font-normal">฿${money(h * rate)}</span></button>`).join('')}</div></div>` : '<p class="mt-3 text-sm text-slate">ไอดีนี้ไม่เปิดให้ต่อเวลา</p>') : ''}
    ${live ? `<button type="button" onclick="returnRental('${esc(r.id)}', true)" class="mt-3 text-sm text-slate underline">ไอดีมีปัญหา? แจ้งปัญหาและคืน</button>` : ''}
    <p class="text-xs text-slate mt-3">ค่าเช่า ฿${money(r.price)}${num(r.deposit) ? ` · มัดจำ ฿${money(r.deposit)}${DEPOSIT[r.depositStatus] ? ' (' + DEPOSIT[r.depositStatus].replace('มัดจำ: ', '') + ')' : ''}` : ''}</p>
  </article>`;
}

function render() {
  const box = el(); if (!box) return;
  if (!authReady) return;
  if (!uid) { box.innerHTML = '<div class="soft-card py-12 px-6 text-center"><p class="font-semibold">เข้าสู่ระบบเพื่อดูการเช่าของคุณ</p><a href="login.html?mode=login&next=rentals.html" class="apple-pricing-pill px-6 py-2.5 text-[15px] mt-4">เข้าสู่ระบบ</a></div>'; return; }
  if (!RENTALS.length) { box.innerHTML = '<div class="soft-card py-12 px-6 text-center"><p class="font-semibold">ยังไม่มีการเช่า</p><p class="text-slate text-sm mt-1">เลือกไอดีที่มีป้าย "เช่า" แล้วกดเช่าได้เลย</p><a href="category.html" class="apple-explore-pill px-6 py-2.5 text-[15px] mt-4 bg-gallery">ดูไอดีให้เช่า</a></div>'; return; }
  box.innerHTML = RENTALS.map(card).join('');
}

async function act(id, fn) {
  if (busy[id]) return;
  busy[id] = true; render();
  try { await fn(); } catch (e) { console.warn('rental:', e); toast(e.message || 'ทำรายการไม่สำเร็จ', 'error'); }
  finally { busy[id] = false; render(); }
}
async function showRentalLogin(id) {
  if (creds[id]) { delete creds[id]; render(); return; }
  await act(id, async () => { creds[id] = await callWorker('/rent/credentials', { rentalId: id }); });
}
function toggleExtend(id) { open[id] = !open[id]; render(); }
const extendRental = (id, hours) => act(id, async () => {
  const r = RENTALS.find(x => x.id === id), price = Math.round(hours * (rates[r.productId] || 0) * 100) / 100;
  const out = await callWorker('/rent/extend', { rentalId: id, hours, expectedAmount: price });
  toast(`ต่อเวลา ${hours} ชม. แล้ว (฿${money(out.charged)})`, 'success'); open[id] = false;
});
const returnRental = (id, problem = false) => act(id, async () => {
  let note = '';
  if (problem) { note = prompt('บอกปัญหาที่พบสั้น ๆ (เช่น ล็อกอินไม่ได้)', '') ; if (note === null) return; }
  else if (!confirm('คืนไอดีตอนนี้? เวลาที่เหลือจะไม่คืนเงิน และรหัสจะดูไม่ได้อีก')) return;
  await callWorker('/rent/return', { rentalId: id, ...(problem ? { problem: true, note } : {}) });
  delete creds[id]; open[id] = false;
  toast(problem ? 'แจ้งปัญหาแล้ว ทีมงานจะตรวจสอบ' : 'คืนไอดีแล้ว รอร้านตรวจสอบเพื่อคืนมัดจำ', 'success');
});
async function copyRentalValue(v) {
  try { await navigator.clipboard.writeText(v); toast('คัดลอกแล้ว', 'success'); } catch (_) { toast('คัดลอกไม่ได้ กดค้างที่ข้อความเพื่อคัดลอก', 'error'); }
}

setInterval(() => {
  let ended = false;
  document.querySelectorAll('[data-end]').forEach(n => {
    const ms = Number(n.dataset.end) - Date.now();
    if (ms <= 0) ended = true; else n.textContent = left(ms);
  });
  if (ended) { Object.keys(creds).forEach(k => { const r = RENTALS.find(x => x.id === k); if (!r || Date.now() >= num(r.endMs)) delete creds[k]; }); render(); }
}, 1000);

let unsub = null;
onAuthStateChanged(auth, (u) => {
  uid = u?.uid || ''; authReady = true;
  unsub?.(); RENTALS = [];
  if (!uid) { render(); return; }
  unsub = onSnapshot(query(collection(db, 'rentals'), where('uid', '==', uid)),
    (s) => { RENTALS = s.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => num(b.startMs) - num(a.startMs)); render(); },
    (e) => { console.warn(e); el().innerHTML = '<p class="text-slate text-sm">โหลดรายการเช่าไม่สำเร็จ ลองใหม่อีกครั้ง</p>'; });
});
Object.assign(window, { showRentalLogin, toggleExtend, extendRental, returnRental, copyRentalValue });
