import { db, auth } from "../firebase-config.js";
import { collection, onSnapshot } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { loadCategories, isServiceProduct } from "./categories.js";

/** Public work queue: per service product, who is waiting / working / done in the last 30 days. */
const DAY30 = 30 * 864e5;
const STATUS = {
  pending_payment: ['รอตรวจชำระ', 'text-slate'],
  waiting: ['รอทำ', 'text-launchOrange'],
  working: ['กำลังทำ', 'text-appleBlue'],
  done: ['เสร็จแล้ว', 'text-emerald-600']
};
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const when = (v) => v?.toDate ? v.toDate() : (v ? new Date(v) : new Date());
const fmt = (d) => d.toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' });

let CATS = [], PRODUCTS = [], QUEUE = [], uid = '';

function isOpen(open, close, now = new Date()) {
  if (!open || !close) return null;
  const m = now.getHours() * 60 + now.getMinutes();
  const t = (s) => { const [h, mi] = s.split(':').map(Number); return h * 60 + mi; };
  const [o, c] = [t(open), t(close)];
  return o <= c ? m >= o && m < c : m >= o || m < c; // closing time past midnight, e.g. 20:00-07:00
}

function render() {
  const el = document.getElementById('queue-groups');
  const cutoff = Date.now() - DAY30;
  const rows = QUEUE.filter(q => q.status !== 'cancelled' && when(q.createdAt).getTime() >= cutoff);
  const services = PRODUCTS.filter(p => isServiceProduct(p, CATS));
  const ids = new Set(services.map(p => p.id));
  const groups = services.map(p => ({ id: p.id, name: p.name, p }));
  // queue rows whose product was deleted still show
  rows.filter(q => !ids.has(q.productId)).forEach(q => { ids.add(q.productId); groups.push({ id: q.productId, name: q.productName, p: {} }); });
  if (!groups.length) { el.innerHTML = '<p class="text-slate text-sm">ยังไม่มีบริการ</p>'; return; }

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
      <p class="text-sm text-slate">รอทำ ${n('waiting')} · กำลังทำ ${n('working')} · รอตรวจชำระ ${n('pending_payment')}</p>
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
  onAuthStateChanged(auth, (u) => { uid = u?.uid || ''; render(); });
})();
