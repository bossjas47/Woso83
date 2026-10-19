import { db, auth } from "../firebase-config.js";
import { collection, onSnapshot } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { loadCategories, isServiceProduct } from "./categories.js";

/** Public work queue: per service product, who is waiting / working / done in the last 30 days. */
const DAY30 = 30 * 864e5;
const STATUS = {
  pending_payment: ['รอตรวจสอบ', 'text-slate'],
  waiting: ['รอคิว', 'text-launchOrange'],
  working: ['กำลังดำเนินการ', 'text-appleBlue'],
  done: ['ส่งมอบสำเร็จ', 'text-emerald-600']
};
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const when = (v) => v?.toDate ? v.toDate() : (v ? new Date(v) : new Date());
const fmt = (d) => d.toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' });

let CATS = [], PRODUCTS = [], QUEUE = [], uid = '', authReady = false;
let view = location.hash === '#mine' ? 'mine' : 'all';

function isOpen(open, close, now = new Date()) {
  if (!open || !close) return null;
  const m = now.getHours() * 60 + now.getMinutes();
  const t = (s) => { const [h, mi] = s.split(':').map(Number); return h * 60 + mi; };
  const [o, c] = [t(open), t(close)];
  return o <= c ? m >= o && m < c : m >= o || m < c; // closing time past midnight, e.g. 20:00-07:00
}

function setQueueView(v) {
  view = v;
  history.replaceState(null, '', v === 'mine' ? '#mine' : location.pathname + location.search);
  render();
}
window.setQueueView = setQueueView;

/** Position of each queue row inside its own service (oldest first), the same numbers the public list shows. */
function seqOf(rows) {
  const by = new Map();
  [...rows].sort((a, b) => when(a.createdAt) - when(b.createdAt)).forEach(q => { const n = (by.get(q.productId) || 0) + 1; by.set(q.productId, n); q._seq = n; });
}
const STEPS = ['pending_payment', 'waiting', 'working', 'done'];
function renderMine() {
  const el = document.getElementById('queue-mine');
  if (!authReady) { el.innerHTML = '<div class="skeleton h-28 !rounded-[28px]"></div>'; return; }
  if (!uid) { el.innerHTML = `<div class="soft-card py-12 px-6 text-center"><p class="font-semibold">เข้าสู่ระบบเพื่อดูการจ้างของคุณ</p><a href="login.html?mode=login&next=queue.html%23mine" class="apple-pricing-pill px-6 py-2.5 text-[15px] mt-4">เข้าสู่ระบบ</a></div>`; return; }
  seqOf(QUEUE.filter(q => q.status !== 'cancelled' && when(q.createdAt).getTime() >= Date.now() - DAY30));
  const mine = QUEUE.filter(q => q.uid === uid && q.status !== 'cancelled').sort((a, b) => when(b.createdAt) - when(a.createdAt));
  if (!mine.length) { el.innerHTML = `<div class="soft-card py-12 px-6 text-center"><p class="font-semibold">ยังไม่มีการจ้างงาน</p><p class="text-slate text-sm mt-1">เมื่อคุณสั่งงานบริการ คิวของคุณจะแสดงที่นี่</p><a href="category.html" class="apple-explore-pill px-6 py-2.5 text-[15px] mt-4 bg-gallery">ดูบริการ</a></div>`; return; }
  el.innerHTML = mine.map(q => {
    const [label, cls] = STATUS[q.status] || [q.status, 'text-slate'];
    const step = STEPS.indexOf(q.status);
    const ahead = q.status === 'waiting' ? QUEUE.filter(o => o.productId === q.productId && ['waiting', 'working'].includes(o.status) && when(o.createdAt) < when(q.createdAt)).length : 0;
    return `<article class="apple-card p-5">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0"><p class="text-xs text-slate">${esc(q.orderNumber || '')}</p>
          <h2 class="text-[17px] font-semibold leading-snug">${esc(q.productName)}</h2>
          <p class="text-sm text-slate mt-0.5">${esc(q.quantity)} ${esc(q.unit)} · ${fmt(when(q.createdAt))}</p></div>
        <div class="text-right shrink-0">${q._seq ? `<p class="text-2xl font-heading font-semibold">#${q._seq}</p>` : ''}<p class="text-sm font-medium ${cls}">${label}</p></div>
      </div>
      <div class="stepper mt-4" style="grid-template-columns:repeat(4,1fr)">${['รอตรวจสอบ', 'รอคิว', 'กำลังทำ', 'สำเร็จ'].map((t, i) => `<div class="step ${i <= step ? 'done' : ''}"><div class="step-bar"></div>${t}</div>`).join('')}</div>
      ${q.status === 'waiting' ? `<p class="text-sm text-slate mt-3">${ahead ? `มีคิวก่อนหน้าคุณ ${ahead} คิว` : 'คุณเป็นคิวถัดไป'}</p>` : ''}
    </article>`;
  }).join('') + `<a href="account.html#orders" class="block text-center text-appleBlue text-[15px] pt-2">ดูรายละเอียดในออเดอร์ของฉัน ›</a>`;
}

function render() {
  ['all', 'mine'].forEach(k => { const b = document.getElementById(`qtab-${k}`); if (b) { b.className = `py-2.5 rounded-full font-medium transition ${view === k ? 'bg-gallery text-ink shadow-sm' : 'text-slate'}`; b.setAttribute('aria-selected', String(view === k)); } });
  document.getElementById('queue-mine').classList.toggle('hidden', view !== 'mine');
  document.getElementById('queue-groups').classList.toggle('hidden', view !== 'all');
  if (view === 'mine') { renderMine(); return; }
  const el = document.getElementById('queue-groups');
  const cutoff = Date.now() - DAY30;
  const rows = QUEUE.filter(q => q.status !== 'cancelled' && when(q.createdAt).getTime() >= cutoff);
  const services = PRODUCTS.filter(p => isServiceProduct(p, CATS));
  const ids = new Set(services.map(p => p.id));
  const groups = services.map(p => ({ id: p.id, name: p.name, p }));
  // queue rows whose product was deleted still show
  rows.filter(q => !ids.has(q.productId)).forEach(q => { ids.add(q.productId); groups.push({ id: q.productId, name: q.productName, p: {} }); });
  if (!groups.length) { el.innerHTML = '<div class="soft-card py-14 text-center"><p class="font-semibold">ยังไม่มีงานบริการ</p><p class="text-slate text-sm mt-1">เมื่อร้านเปิดบริการ คิวจะแสดงที่นี่</p></div>'; return; }

  el.innerHTML = groups.map(g => {
    const mine = rows.filter(q => q.productId === g.id).sort((a, b) => when(a.createdAt) - when(b.createdAt));
    const seq = new Map(mine.map((q, i) => [q.id, i + 1]));
    const n = (s) => mine.filter(q => q.status === s).length;
    const active = mine.filter(q => q.status !== 'done');
    const done = mine.filter(q => q.status === 'done').reverse();
    const working = mine.find(q => q.status === 'working');
    const msg = working ? `กำลังทำคิว #${seq.get(working.id)}` : n('waiting') ? 'รอทีมงานเริ่มคิว' : 'ไม่มีคิวค้าง';
    const open = isOpen(g.p.hoursOpen, g.p.hoursClose);
    const row = (q) => {
      const [label, cls] = STATUS[q.status] || [q.status, 'text-slate'];
      return `<div class="flex items-center gap-3 rounded-2xl bg-mist p-3.5 ${q.uid === uid ? 'ring-1 ring-pricingBlue' : ''}">
        <span class="w-10 h-10 shrink-0 rounded-full bg-gallery flex items-center justify-center text-sm font-semibold">#${seq.get(q.id)}</span>
        <div class="min-w-0 flex-1"><p class="text-sm text-slate truncate">${esc(q.nameMask)}${q.uid === uid ? ' <span class="text-pricingBlue font-medium">· ของคุณ</span>' : ''}</p>
          <p class="font-semibold">${esc(q.quantity)} ${esc(q.unit)}</p>
          <p class="text-xs text-slate">${fmt(when(q.createdAt))}</p></div>
        <span class="text-sm font-medium ${cls}">${label}</span></div>`;
    };
    return `<section class="apple-card p-5 sm:p-6" data-queue="${esc(g.id)}">
      <div class="flex items-start justify-between gap-3">
        <div><h2 class="text-xl font-heading font-semibold">${esc(g.name)}</h2>
          ${g.p.hoursOpen && g.p.hoursClose ? `<p class="text-sm text-slate mt-0.5">เวลาทำงาน ${esc(g.p.hoursOpen)} - ${esc(g.p.hoursClose)} น.</p>` : ''}</div>
        ${open === null ? '' : `<span class="text-xs font-medium whitespace-nowrap ${open ? 'text-emerald-600' : 'text-slate'}">${open ? 'อยู่ในเวลาทำงาน' : 'นอกเวลาทำงาน'}</span>`}
      </div>
      <p class="mt-4 text-lg font-semibold">${msg}</p>
      <p class="text-sm text-slate">รอคิว ${n('waiting')} · กำลังดำเนินการ ${n('working')} · รอตรวจสอบ ${n('pending_payment')}</p>
      <h3 class="mt-5 mb-3 font-semibold">งานค้างและประวัติ 30 วัน</h3>
      <div class="space-y-2.5">${[...active, ...done].map(row).join('') || '<p class="text-sm text-slate">ยังไม่มีรายการ</p>'}</div>
    </section>`;
  }).join('');
}

(async () => {
  CATS = await loadCategories();
  onSnapshot(collection(db, 'products'), (s) => { PRODUCTS = s.docs.map(d => ({ id: d.id, ...d.data() })); render(); });
  // shortcut: reads the whole queue collection and filters 30 days client-side; add a createdAt range query when it grows
  onSnapshot(collection(db, 'queue'), (s) => { QUEUE = s.docs.map(d => ({ id: d.id, ...d.data() })); render(); },
    (e) => { document.getElementById('queue-groups').innerHTML = '<p class="text-slate text-sm">โหลดคิวไม่สำเร็จ ลองใหม่อีกครั้ง</p>'; console.warn(e); });
  onAuthStateChanged(auth, (u) => { uid = u?.uid || ''; authReady = true; render(); });
})();
