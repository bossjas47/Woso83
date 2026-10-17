import { db } from "../../firebase-config.js";
import { 
  collection, 
  doc, 
  getDoc,
  getDocs, 
  setDoc, 
  deleteDoc, 
  serverTimestamp 
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

/**
 * TACTICAL STORE — Promo Code Management Engine (Backoffice)
 * File: js/back/code.js
 * Supports: Fixed THB, Percent (%), Random Range (%, THB), Uses/User, Total Quotas, Modal CRUD, Delete
 */

let ADMIN_PROMOS = [
  { code: 'TACTICAL', type: 'fixed', value: 50, maxPerUser: 1, maxTotalUses: 100, usedCount: 14, desc: 'ส่วนลดเงินสด 50 บาท' },
  { code: 'ARENA10', type: 'percent', value: 10, maxPerUser: 0, maxTotalUses: 0, usedCount: 42, desc: 'ลด 10% สำหรับทุกออเดอร์' },
  { code: 'MOSZXLL', type: 'fixed', value: 100, maxPerUser: 1, maxTotalUses: 50, usedCount: 50, desc: 'ส่วนลดพิเศษ 100 บาท' },
  { code: 'LUCKY20', type: 'random_percent', minValue: 10, maxValue: 20, maxPerUser: 1, maxTotalUses: 200, usedCount: 28, desc: 'สุ่มรับส่วนลด 10% - 20%' }
];

export async function renderAdminPromos() {
  const tbody = document.getElementById('admin-promos-table-body');
  const emptyEl = document.getElementById('admin-promos-empty');
  if (!tbody) return;

  try {
    const snap = await getDocs(collection(db, 'promo_codes'));
    if (!snap.empty) {
      ADMIN_PROMOS = [];
      snap.forEach(d => ADMIN_PROMOS.push(d.data()));
    }
  } catch (e) {
    const local = localStorage.getItem('tactical_admin_promos');
    if (local) {
      try { ADMIN_PROMOS = JSON.parse(local); } catch (_) {}
    }
  }

  if (ADMIN_PROMOS.length === 0) {
    tbody.innerHTML = '';
    if (emptyEl) emptyEl.classList.remove('hidden');
    return;
  }
  if (emptyEl) emptyEl.classList.add('hidden');

  tbody.innerHTML = ADMIN_PROMOS.map(p => {
    let discountBadge = '';
    if (p.type === 'fixed') {
      discountBadge = `<span class="font-mono font-bold text-pricingBlue">฿${Number(p.value).toFixed(2)}</span>`;
    } else if (p.type === 'percent') {
      discountBadge = `<span class="font-mono font-bold text-pricingBlue">${p.value}%</span>`;
    } else if (p.type === 'random_percent') {
      discountBadge = `<span class="font-mono font-bold text-launchOrange">สุ่ม ${p.minValue}% - ${p.maxValue}%</span>`;
    } else if (p.type === 'random_fixed') {
      discountBadge = `<span class="font-mono font-bold text-launchOrange">สุ่ม ฿${p.minValue} - ฿${p.maxValue}</span>`;
    }

    const perUserText = (p.maxPerUser && Number(p.maxPerUser) > 0)
      ? `${p.maxPerUser} ครั้ง / คน`
      : '<span class="text-steel">ไม่จำกัด</span>';

    const used = Number(p.usedCount) || 0;
    const maxTotal = Number(p.maxTotalUses) || 0;
    let totalText = '';
    if (maxTotal > 0) {
      const isFull = used >= maxTotal;
      totalText = `<span class="${isFull ? 'text-red-500 font-bold' : 'text-ink'}">${used} / ${maxTotal} คน</span>`;
    } else {
      totalText = `<span class="text-steel">${used} ครั้ง (ไม่จำกัด)</span>`;
    }

    return `
      <tr class="hover:bg-mist/60 transition-colors border-b border-hairline">
        <td class="py-3 px-4 font-mono font-bold text-ink text-xs">
          <span class="bg-mist px-2.5 py-1 rounded-lg border border-hairline tracking-wider">${p.code}</span>
        </td>
        <td class="py-3 px-4 text-xs">${discountBadge}</td>
        <td class="py-3 px-4 text-xs text-slate">${perUserText}</td>
        <td class="py-3 px-4 text-xs">${totalText}</td>
        <td class="py-3 px-4 text-xs text-slate max-w-[200px] truncate">${p.desc || '-'}</td>
        <td class="py-3 px-4 text-right">
          <div class="flex items-center justify-end gap-2">
            <button onclick="openPromoModal('${p.code}')" class="apple-explore-pill px-3 py-1 text-[11px] text-slate hover:text-ink">
              แก้ไข
            </button>
            <button onclick="deletePromo('${p.code}')" class="apple-explore-pill px-3 py-1 text-[11px] text-red-500 border-red-200 hover:bg-red-50">
              ลบ
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

export function openPromoModal(code = null) {
  const modal = document.getElementById('promo-form-modal');
  const heading = document.getElementById('promo-modal-heading');
  const modeInput = document.getElementById('promo-edit-mode');
  const origCodeInput = document.getElementById('promo-original-code');
  const codeInput = document.getElementById('promo-code-name');
  if (!modal) return;

  if (code) {
    const p = ADMIN_PROMOS.find(it => it.code === code);
    if (!p) return;
    if (heading) heading.innerText = `แก้ไขโค้ด: ${p.code}`;
    if (modeInput) modeInput.value = 'edit';
    if (origCodeInput) origCodeInput.value = p.code;
    if (codeInput) {
      codeInput.value = p.code;
      codeInput.disabled = true;
    }
    document.getElementById('promo-discount-type').value = p.type || 'fixed';
    document.getElementById('promo-discount-val').value = p.value || '';
    document.getElementById('promo-range-min').value = p.minValue || '';
    document.getElementById('promo-range-max').value = p.maxValue || '';
    document.getElementById('promo-max-per-user').value = p.maxPerUser || '';
    document.getElementById('promo-max-total-uses').value = p.maxTotalUses || '';
    document.getElementById('promo-desc').value = p.desc || '';
    handlePromoTypeChange(p.type || 'fixed');
  } else {
    if (heading) heading.innerText = 'สร้างโค้ดส่วนลดใหม่';
    if (modeInput) modeInput.value = 'create';
    if (origCodeInput) origCodeInput.value = '';
    if (codeInput) {
      codeInput.value = '';
      codeInput.disabled = false;
    }
    document.getElementById('promo-discount-type').value = 'fixed';
    document.getElementById('promo-discount-val').value = '';
    document.getElementById('promo-range-min').value = '';
    document.getElementById('promo-range-max').value = '';
    document.getElementById('promo-max-per-user').value = '';
    document.getElementById('promo-max-total-uses').value = '';
    document.getElementById('promo-desc').value = '';
    handlePromoTypeChange('fixed');
  }

  modal.classList.remove('hidden');
  modal.classList.add('flex');
}

export function closePromoModal() {
  const modal = document.getElementById('promo-form-modal');
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }
}

export function handlePromoTypeChange(type) {
  const singleBox = document.getElementById('promo-single-val-box');
  const rangeBox = document.getElementById('promo-range-val-box');
  const valLabel = document.getElementById('promo-val-label');
  const minLabel = document.getElementById('promo-min-label');
  const maxLabel = document.getElementById('promo-max-label');

  if (type === 'fixed') {
    if (singleBox) singleBox.classList.remove('hidden');
    if (rangeBox) rangeBox.classList.add('hidden');
    if (valLabel) valLabel.innerText = 'มูลค่าที่ลด (บาท):';
  } else if (type === 'percent') {
    if (singleBox) singleBox.classList.remove('hidden');
    if (rangeBox) rangeBox.classList.add('hidden');
    if (valLabel) valLabel.innerText = 'เปอร์เซ็นต์ที่ลด (%):';
  } else if (type === 'random_percent') {
    if (singleBox) singleBox.classList.add('hidden');
    if (rangeBox) rangeBox.classList.remove('hidden');
    if (minLabel) minLabel.innerText = 'สุ่มต่ำสุด (%):';
    if (maxLabel) maxLabel.innerText = 'สุ่มสูงสุด (%):';
  } else if (type === 'random_fixed') {
    if (singleBox) singleBox.classList.add('hidden');
    if (rangeBox) rangeBox.classList.remove('hidden');
    if (minLabel) minLabel.innerText = 'สุ่มต่ำสุด (บาท):';
    if (maxLabel) maxLabel.innerText = 'สุ่มสูงสุด (บาท):';
  }
}

export async function handleSavePromoModal(event) {
  event.preventDefault();
  const mode = document.getElementById('promo-edit-mode').value;
  const origCode = document.getElementById('promo-original-code').value;
  const code = (mode === 'edit' ? origCode : document.getElementById('promo-code-name').value).trim().toUpperCase();
  const type = document.getElementById('promo-discount-type').value;
  const desc = document.getElementById('promo-desc').value.trim();

  const value = (type === 'fixed' || type === 'percent') ? (parseFloat(document.getElementById('promo-discount-val').value) || 0) : 0;
  const minValue = (type === 'random_percent' || type === 'random_fixed') ? (parseFloat(document.getElementById('promo-range-min').value) || 0) : 0;
  const maxValue = (type === 'random_percent' || type === 'random_fixed') ? (parseFloat(document.getElementById('promo-range-max').value) || 0) : 0;

  const maxPerUser = parseInt(document.getElementById('promo-max-per-user').value, 10) || 0;
  const maxTotalUses = parseInt(document.getElementById('promo-max-total-uses').value, 10) || 0;

  if (!code) {
    if (typeof window.triggerToast === 'function') window.triggerToast('กรุณากรอกรหัสโค้ด');
    else alert('กรุณากรอกรหัสโค้ด');
    return;
  }

  const existing = ADMIN_PROMOS.find(it => it.code === code);
  const payload = {
    code,
    type,
    value,
    minValue,
    maxValue,
    maxPerUser,
    maxTotalUses,
    usedCount: existing?.usedCount || 0,
    desc,
    updatedAt: serverTimestamp()
  };

  try {
    await setDoc(doc(db, 'promo_codes', code), payload, { merge: true });
    if (typeof window.triggerToast === 'function') window.triggerToast(`บันทึกโค้ด ${code} สำเร็จ!`);
  } catch (e) {
    console.warn('Save promo fallback:', e);
    if (typeof window.triggerToast === 'function') window.triggerToast(`บันทึกโค้ด ${code} สำเร็จ (Local)`);
  }

  const idx = ADMIN_PROMOS.findIndex(p => p.code === code);
  if (idx >= 0) ADMIN_PROMOS[idx] = payload;
  else ADMIN_PROMOS.unshift(payload);
  localStorage.setItem('tactical_admin_promos', JSON.stringify(ADMIN_PROMOS));

  renderAdminPromos();
  closePromoModal();
}

export async function deletePromo(code) {
  if (!confirm(`คุณต้องการลบโค้ดส่วนลด "${code}" ออกจากระบบใช่หรือไม่?`)) return;

  try {
    await deleteDoc(doc(db, 'promo_codes', code));
    if (typeof window.triggerToast === 'function') window.triggerToast(`ลบโค้ด ${code} เรียบร้อยแล้ว`);
  } catch (e) {
    console.warn('Delete promo fallback:', e);
    if (typeof window.triggerToast === 'function') window.triggerToast(`ลบโค้ด ${code} เรียบร้อย (Local)`);
  }

  ADMIN_PROMOS = ADMIN_PROMOS.filter(p => p.code !== code);
  localStorage.setItem('tactical_admin_promos', JSON.stringify(ADMIN_PROMOS));
  renderAdminPromos();
}

// Window bindings for inline DOM events
window.renderAdminPromos = renderAdminPromos;
window.openPromoModal = openPromoModal;
window.closePromoModal = closePromoModal;
window.handlePromoTypeChange = handlePromoTypeChange;
window.handleSavePromoModal = handleSavePromoModal;
window.deletePromo = deletePromo;

// Initialize on DOM load if promo table is present
window.addEventListener('DOMContentLoaded', () => {
  if (document.getElementById('admin-promos-table-body')) {
    renderAdminPromos();
  }
});
