import { esc, baht, fmtDate, icon, ICONS, copyText } from "./ui.js";

/**
 * Order rendering shared by the account page and the product-page success card.
 *  - game IDs: credential box with show/hide password and separate copy buttons for username and password
 *  - services: status steps รอตรวจสอบ -> กำลังดำเนินการ -> ส่งมอบสำเร็จ, plus the admin's note to the customer
 */
export const STATUS = {
  pending_payment: { label: 'รอตรวจสอบ', cls: 'bg-[#fff3e6] text-[#a04a00]' },
  processing: { label: 'กำลังดำเนินการ', cls: 'bg-[#e8f1fd] text-[#0058b9]' },
  completed: { label: 'ส่งมอบสำเร็จ', cls: 'bg-[#e8f8ee] text-[#0a7a3b]' },
  cancelled: { label: 'ยกเลิกแล้ว', cls: 'bg-mist text-slate' }
};
const STEP_INDEX = { pending_payment: 0, processing: 1, completed: 2 };

export const accountsOf = (o) => (Array.isArray(o.accountsDelivered) && o.accountsDelivered.length ? o.accountsDelivered : (o.accountDelivered?.username ? [o.accountDelivered] : []));

// Credentials are kept here (not in the DOM) and looked up by key when copying / revealing.
const vault = new Map();

export function credentialBoxHtml(order) {
  const accs = accountsOf(order);
  if (order.status !== 'completed' || !accs.length) {
    return `<div class="rounded-2xl bg-mist p-4 text-sm text-slate">${order.status === 'cancelled' ? 'ออเดอร์นี้ถูกยกเลิก' : 'ไอดีจะแสดงที่นี่เมื่อทีมงานยืนยันการชำระเงินแล้ว'}</div>`;
  }
  return accs.map((a, i) => {
    const key = `${order.id || order.orderId}-${i}`;
    vault.set(key, a);
    const k = esc(JSON.stringify(key));
    return `<div class="rounded-2xl border border-hairline bg-gallery p-4 space-y-3">
      ${accs.length > 1 ? `<p class="text-xs font-semibold text-slate">ไอดีที่ ${i + 1}</p>` : ''}
      <div>
        <p class="text-xs text-slate mb-1">Username / อีเมลเกม</p>
        <div class="flex items-center gap-2"><code class="flex-1 min-w-0 truncate rounded-xl bg-mist px-3 py-2.5 text-[15px] text-ink">${esc(a.username)}</code>
          <button type="button" onclick='copyCred(${k},"username")' class="apple-explore-pill px-3.5 py-2 text-sm shrink-0">${icon(ICONS.copy, 'w-4 h-4', 2)}คัดลอก</button></div>
      </div>
      <div>
        <p class="text-xs text-slate mb-1">Password</p>
        <div class="flex items-center gap-2"><code id="pw-${esc(key)}" data-shown="0" class="flex-1 min-w-0 truncate rounded-xl bg-mist px-3 py-2.5 text-[15px] text-ink tracking-widest">••••••••</code>
          <button type="button" onclick='togglePw(${k}, this)' aria-label="แสดงรหัสผ่าน" class="w-10 h-10 rounded-full border border-hairline flex items-center justify-center shrink-0 hover:bg-mist">${icon(ICONS.eye, 'w-5 h-5', 2)}</button>
          <button type="button" onclick='copyCred(${k},"password")' class="apple-explore-pill px-3.5 py-2 text-sm shrink-0">${icon(ICONS.copy, 'w-4 h-4', 2)}คัดลอก</button></div>
      </div>
    </div>`;
  }).join('') + `<p class="text-xs text-slate">แนะนำให้เปลี่ยนรหัสผ่านและผูกอีเมลของคุณทันทีหลังเข้าเกม</p>`;
}

export function serviceStepsHtml(order) {
  if (order.status === 'cancelled') return `<div class="rounded-2xl bg-mist p-4 text-sm text-slate">ออเดอร์นี้ถูกยกเลิก${order.adminNote ? ` · ${esc(order.adminNote)}` : ''}</div>`;
  const at = STEP_INDEX[order.status] ?? 0;
  const steps = ['รอตรวจสอบ', 'กำลังดำเนินการ', 'ส่งมอบสำเร็จ'];
  return `<div class="space-y-3">
    <ol class="stepper" aria-label="สถานะงาน">${steps.map((s, i) => `<li class="step ${i <= at ? 'done' : ''}" ${i === at ? 'aria-current="step"' : ''}><div class="step-bar"></div>${s}</li>`).join('')}</ol>
    ${order.adminNote ? `<div class="rounded-2xl bg-[#e8f1fd] text-[#003d80] p-3.5 text-sm"><p class="text-xs font-semibold mb-0.5">ข้อความจากทีมงาน</p><p class="whitespace-pre-line">${esc(order.adminNote)}</p></div>` : ''}
  </div>`;
}

export function orderCardHtml(o) {
  const st = STATUS[o.status] || { label: o.status || '-', cls: 'bg-mist text-slate' };
  const isSrv = o.productType === 'service';
  return `<article class="apple-card p-4 sm:p-5 space-y-4">
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0">
        <p class="text-xs font-mono text-appleBlue">#${esc(o.orderNumber || o.orderId || o.id)}</p>
        <h3 class="font-semibold text-ink leading-snug">${esc(o.productName || '-')}</h3>
        <p class="text-xs text-slate mt-0.5">${esc(fmtDate(o.createdAt))} · ${esc(o.quantity || 1)} ${esc(o.unit || '')}${o.paymentMethod === 'wallet' ? ' · จ่ายด้วยเครดิต' : ''}</p>
      </div>
      <div class="text-right shrink-0">
        <p class="font-heading font-semibold">${baht(o.amount ?? o.finalPrice)}</p>
        <span class="inline-block mt-1 text-[11px] font-semibold px-2.5 py-0.5 rounded-full ${st.cls}">${esc(st.label)}</span>
      </div>
    </div>
    ${isSrv ? serviceStepsHtml(o) : credentialBoxHtml(o)}
    ${!isSrv && o.adminNote ? `<p class="text-sm text-slate"><span class="font-medium text-ink">หมายเหตุ:</span> ${esc(o.adminNote)}</p>` : ''}
  </article>`;
}

window.copyCred = (key, field) => {
  const a = vault.get(key);
  if (a) copyText(a[field] || '', field === 'password' ? 'คัดลอกรหัสผ่านแล้ว' : 'คัดลอก Username แล้ว');
};
window.togglePw = (key, btn) => {
  const a = vault.get(key);
  const el = document.getElementById('pw-' + key);
  if (!a || !el) return;
  const show = el.dataset.shown !== '1';
  el.dataset.shown = show ? '1' : '0';
  el.textContent = show ? (a.password || '-') : '••••••••';
  el.classList.toggle('tracking-widest', !show);
  btn.innerHTML = icon(show ? ICONS.eyeOff : ICONS.eye, 'w-5 h-5', 2);
  btn.setAttribute('aria-label', show ? 'ซ่อนรหัสผ่าน' : 'แสดงรหัสผ่าน');
};
