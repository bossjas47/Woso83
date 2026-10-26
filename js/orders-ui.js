import { db, auth } from "../firebase-config.js";
import { doc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { ROOT, maskName, esc, baht, fmtDate, icon, ICONS, copyText, imgAttrs, toast, callWorker } from "./ui.js";

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
    return `<div class="rounded-2xl bg-mist p-4 text-sm text-slate">${order.status === 'cancelled' ? 'ออเดอร์นี้ถูกยกเลิก' : 'แอดมินเช็กยอดเสร็จเมื่อไหร่ ไอดีขึ้นตรงนี้ทันที'}</div>`;
  }
  const allKey = `${order.id || order.orderId}-all`;
  vault.set(allKey, { all: accs.map(a => `${a.username}|${a.password}`).join('\n') });
  const copyAll = accs.length > 1 ? `<button type="button" onclick='copyCred(${esc(JSON.stringify(allKey))},"all")' class="apple-explore-pill px-4 py-2 text-sm w-full">${icon(ICONS.copy, 'w-4 h-4', 2)}คัดลอกทั้งหมด ${accs.length} ไอดี (อีเมล|รหัส บรรทัดละไอดี)</button>` : '';
  return copyAll + accs.map((a, i) => {
    const key = `${order.id || order.orderId}-${i}`;
    vault.set(key, a);
    const k = esc(JSON.stringify(key));
    return `<div class="rounded-2xl border border-hairline bg-gallery p-4 space-y-3">
      ${accs.length > 1 || a.ammo ? `<p class="text-xs font-semibold text-slate">${accs.length > 1 ? `ไอดีที่ ${i + 1}` : 'ไอดี'}${a.ammo ? ` · ${Number(a.ammo).toLocaleString('th-TH')} กอง` : ''}</p>` : ''}
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
  }).join('') + `<p class="text-xs text-slate">เข้าเกมได้แล้ว เปลี่ยนรหัสและผูกอีเมลของตัวเองก่อนลงเรดนะ</p>`;
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

/** Product pictures by product id, filled by the page that lists orders (account / home). */
export const PRODUCT_IMAGES = new Map();
export const orderThumb = (o, size = 72) => { const src = o.image || PRODUCT_IMAGES.get(o.productId), css = `width:${size}px;height:${size}px;border-radius:${Math.round(size / 4)}px`; // inline: tw.css has no arbitrary sizes
  return src ? `<img ${imgAttrs(src, size, size)} alt="" style="${css}" class="object-cover bg-mist shrink-0">` : `<span style="${css}" class="bg-mist text-pricingBlue flex items-center justify-center shrink-0">${icon(o.productType === 'service' || o.kind === 'service' ? ICONS.bolt : ICONS.id, 'w-6 h-6', 1.8)}</span>`; };

const CLAIM_TEXT = { open: 'แจ้งเคลมแล้ว รอแอดมินตรวจ', refunded: 'เคลมสำเร็จ คืนเงินเป็นเครดิตแล้ว', rejected: 'เคลมไม่ผ่าน' };
/** Ammo orders: claim button for 24 h after buying (members only), then the claim's status. */
function claimHtml(o) {
  if (!o.isAmmo || !o.userId) return '';
  if (o.claimStatus) return `<p class="text-sm text-slate"><span class="font-medium text-ink">เคลม:</span> ${esc(CLAIM_TEXT[o.claimStatus] || '')}${o.claimNote ? ' · ' + esc(o.claimNote) : ''}</p>`;
  const t = o.createdAt?.toMillis?.() ?? 0;
  return o.status === 'completed' && t && Date.now() - t <= 864e5 ? `<button type="button" onclick="claimAmmo(${esc(JSON.stringify(o.id))})" class="text-[13px] text-appleBlue hover:underline text-left">ไอดีมีปัญหา? แจ้งเคลม (ภายใน 24 ชม. หลังซื้อ) ›</button>` : '';
}
window.claimAmmo = async (id) => {
  const reason = (prompt('อธิบายปัญหาของไอดี เช่น ล็อกอินไม่ได้ รหัสผ่านผิด') || '').trim();
  if (!reason) return;
  try { await callWorker('/ammo/claim', { orderId: id, reason }); toast('ส่งคำขอเคลมแล้ว แอดมินจะตรวจสอบ', 'success'); }
  catch (e) { toast(e.message || 'แจ้งเคลมไม่สำเร็จ', 'error'); }
};

/** Reviews by order id (filled by the account page). A completed ID order shows its review status, or a star form. */
export const REVIEWS = new Map();
const REVIEW_TEXT = { pending: 'รอแอดมินอนุมัติ', shown: 'แสดงในหน้าสินค้าแล้ว', hidden: 'ไม่ได้แสดง' };
function reviewHtml(o) {
  if (o.status !== 'completed' || !o.userId || o.paymentMethod === 'prize') return '';
  const r = REVIEWS.get(o.id), id = esc(JSON.stringify(o.id));
  if (r) return `<p class="text-sm text-slate"><span class="font-medium text-ink">รีวิวของคุณ:</span> <span style="color:#f5a623">${'★'.repeat(r.stars)}${'☆'.repeat(5 - r.stars)}</span> · ${esc(REVIEW_TEXT[r.status] || '')}${r.text ? `<br>${esc(r.text)}` : ''}</p>`;
  return `<details class="text-sm"><summary class="text-appleBlue cursor-pointer">ให้คะแนนสินค้านี้ ›</summary>
    <div class="mt-2 space-y-2"><div id="rv-stars-${esc(o.id)}" data-v="5" style="font-size:26px;color:#f5a623;cursor:pointer;user-select:none">${[1, 2, 3, 4, 5].map(n => `<span onclick="setStars(${id},${n})">★</span>`).join('')}</div>
      <textarea id="rv-text-${esc(o.id)}" rows="2" maxlength="200" placeholder="เล่าให้คนอื่นฟังหน่อย (ไม่บังคับ)" class="w-full apple-input p-2.5 text-sm"></textarea>
      <button type="button" onclick="sendReview(${id}, ${esc(JSON.stringify(o.productId || ''))})" class="apple-pricing-pill px-4 py-1.5 text-[13px]">ส่งรีวิว</button></div></details>`;
}
window.setStars = (id, n) => { const el = document.getElementById('rv-stars-' + id); if (!el) return; el.dataset.v = n; [...el.children].forEach((s, i) => { s.style.opacity = i < n ? 1 : .25; }); };
window.sendReview = async (id, productId) => {
  const u = auth.currentUser; if (!u || !productId) return;
  const stars = Number(document.getElementById('rv-stars-' + id)?.dataset.v) || 5, text = (document.getElementById('rv-text-' + id)?.value || '').trim().slice(0, 200);
  try { await setDoc(doc(db, 'reviews', id), { orderId: id, productId, uid: u.uid, name: maskName(u.displayName || (u.email || '').split('@')[0] || 'ลูกค้า').slice(0, 40), stars, text, status: 'pending', createdAt: serverTimestamp() }); toast('ส่งรีวิวแล้ว รอแอดมินอนุมัติ', 'success'); }
  catch (e) { console.warn('review:', e); toast('ส่งรีวิวไม่สำเร็จ', 'error'); }
};

export function orderCardHtml(o) {
  const st = STATUS[o.status] || { label: o.status || '-', cls: 'bg-mist text-slate' };
  const isSrv = o.productType === 'service';
  const qty = `${esc(o.quantity || 1)} ${esc(o.unit || '')}${num(o.bonusQty) ? ` + แถม ${esc(o.bonusQty)}` : ''}`;
  return `<article class="apple-card p-4 sm:p-5 space-y-4">
    <div class="flex gap-4">
      ${orderThumb(o, 72)}
      <div class="min-w-0 flex-1">
        <div class="flex items-start justify-between gap-3">
          <h3 class="font-semibold text-ink text-[17px] leading-snug line-clamp-2">${esc(o.productName || '-')}</h3>
          <p class="font-heading font-semibold text-[17px] whitespace-nowrap">${baht(o.amount ?? o.finalPrice)}</p>
        </div>
        <p class="text-[13px] text-slate mt-0.5">${qty}${o.paymentMethod === 'wallet' ? ' · จ่ายด้วยเครดิต' : o.paymentMethod === 'prize' ? ' · ของรางวัลกล่องสุ่ม' : ''}${num(o.rankDiscount) ? ` · ส่วนลดยศ ${baht(o.rankDiscount)}` : ''}</p>
        <div class="flex flex-wrap items-center gap-2 mt-2">
          <span class="text-[11px] font-semibold px-2.5 py-0.5 rounded-full ${st.cls}">${esc(st.label)}</span>
          <span class="text-[11px] text-slate"><span class="font-mono">#${esc(o.orderNumber || o.orderId || o.id)}</span> · ${esc(fmtDate(o.createdAt))}</span>
          ${o.isAmmo && o.productId ? `<a href="${esc(`${ROOT}front/product.html?id=${encodeURIComponent(o.productId)}`)}&qty=${num(o.ammoTarget || o.ammoTotal)}" class="text-[12px] text-appleBlue hover:underline">สั่งซ้ำ ${num(o.ammoTarget || o.ammoTotal).toLocaleString('th-TH')} กอง ›</a>` : o.productId && o.paymentMethod !== 'prize' && (o.status === 'completed' || o.status === 'processing') ? `<a href="${esc(`${ROOT}front/product.html?id=${encodeURIComponent(o.productId)}`)}" class="text-[12px] text-appleBlue hover:underline">สั่งอีกครั้ง ›</a>` : ''}
        </div>
      </div>
    </div>
    ${isSrv ? serviceStepsHtml(o) : credentialBoxHtml(o)}
    ${!isSrv && o.pwRemindAt && o.status === 'completed' ? '<p class="text-[12px] text-slate">🔐 เปลี่ยนรหัสผ่านเกมทันทีหลังได้รับไอดี เพื่อความปลอดภัยของบัญชี</p>' : ''}
    ${isSrv ? '' : claimHtml(o)}
    ${isSrv ? '' : reviewHtml(o)}
    ${!isSrv && o.adminNote ? `<p class="text-sm text-slate"><span class="font-medium text-ink">หมายเหตุ:</span> ${esc(o.adminNote)}</p>` : ''}
  </article>`;
}
const num = (v) => Number(v) || 0;

window.copyCred = (key, field) => {
  const a = vault.get(key);
  if (a) copyText(a[field] || '', field === 'all' ? 'คัดลอกทุกไอดีแล้ว' : field === 'password' ? 'คัดลอกรหัสผ่านแล้ว' : 'คัดลอก Username แล้ว');
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
