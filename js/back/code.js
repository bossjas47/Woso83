import { db } from "../../firebase-config.js";
import { collection, doc, onSnapshot, setDoc, deleteDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { esc, money, toast, openModal, closeModal } from "../ui.js";

/**
 * Promo codes (promo_codes/{CODE}): fixed baht or percent, scoped to all products, chosen categories or chosen products.
 * The product page previews the discount; wallet purchases are re-checked by the Worker, manual orders by the admin.
 * No demo codes: an empty collection shows an empty list.
 */
let PROMOS = [];
let started = false;
const SCOPE = { all: 'สินค้าทั้งหมด', categories: 'บางหมวดหมู่', products: 'บางสินค้า' };

function start() {
  if (started) return;
  started = true;
  onSnapshot(collection(db, 'promo_codes'), (s) => { PROMOS = s.docs.map(d => ({ ...d.data(), code: d.id })); renderAdminPromos(); },
    (e) => { console.warn('promos:', e); toast('โหลดโค้ดส่วนลดไม่สำเร็จ', 'error'); });
}

export function renderAdminPromos() {
  start();
  const tbody = document.getElementById('admin-promos-table-body');
  if (!tbody) return;
  document.getElementById('admin-promos-empty').classList.toggle('hidden', PROMOS.length > 0);
  const cats = window.getCategoriesForPromo?.() || [], prods = window.getProductsForPromo?.() || [];
  tbody.innerHTML = PROMOS.sort((a, b) => a.code.localeCompare(b.code)).map(p => {
    const code = esc(JSON.stringify(p.code));
    const legacy = !['fixed', 'percent'].includes(p.type);
    const disc = p.type === 'percent' ? `${esc(p.value)}%` : p.type === 'fixed' ? `฿${money(p.value)}` : '<span class="text-launchOrange">แบบเก่า (ใช้ไม่ได้) กรุณาแก้ไข</span>';
    const names = p.appliesTo === 'categories' ? (p.categoryIds || []).map(id => cats.find(c => c.id === id)?.name || id)
      : p.appliesTo === 'products' ? (p.productIds || []).map(id => prods.find(x => x.id === id)?.name || id) : [];
    const used = Number(p.usedCount) || 0, quota = Number(p.maxTotalUses) || 0;
    return `<tr class="border-b border-hairline">
      <td class="py-3 px-4 font-mono font-bold"><span class="bg-mist px-2.5 py-1 rounded-lg border border-hairline">${esc(p.code)}</span>${p.desc ? `<div class="text-[11px] text-slate font-sans font-normal mt-1">${esc(p.desc)}</div>` : ''}</td>
      <td class="py-3 px-4 font-semibold text-pricingBlue">${disc}</td>
      <td class="py-3 px-4 text-slate">${esc(SCOPE[p.appliesTo] || SCOPE.all)}${names.length ? `<div class="text-[11px] line-clamp-2">${esc(names.join(', '))}</div>` : ''}</td>
      <td class="py-3 px-4 text-slate">${Number(p.maxPerUser) > 0 ? `${esc(p.maxPerUser)} ครั้ง` : 'ไม่จำกัด'}</td>
      <td class="py-3 px-4 ${quota && used >= quota ? 'text-red-500 font-semibold' : ''}">${used}${quota ? ` / ${quota}` : ' / ไม่จำกัด'}</td>
      <td class="py-3 px-4">${p.active === false || legacy ? '<span class="text-slate">ปิด</span>' : '<span class="text-emerald-600 font-semibold">เปิด</span>'}</td>
      <td class="py-3 px-4 text-right whitespace-nowrap"><button onclick='openPromoModal(${code})' class="apple-explore-pill px-3 py-1 text-[11px]">แก้ไข</button> <button onclick='deletePromo(${code})' class="apple-explore-pill px-3 py-1 text-[11px] text-red-500 border-red-200">ลบ</button></td>
    </tr>`;
  }).join('');
}

function scopeList(kind, selected) {
  const box = document.getElementById('promo-scope-box');
  const items = kind === 'categories' ? (window.getCategoriesForPromo?.() || []).map(c => [c.id, c.name])
    : kind === 'products' ? (window.getProductsForPromo?.() || []).map(p => [p.id, p.name]) : [];
  box.classList.toggle('hidden', kind === 'all');
  box.innerHTML = items.length
    ? items.map(([id, name]) => `<label class="flex items-center gap-2"><input type="checkbox" class="promo-scope-item" value="${esc(id)}" ${selected.includes(id) ? 'checked' : ''}> ${esc(name)}</label>`).join('')
    : `<p class="text-slate">${kind === 'categories' ? 'ยังไม่มีหมวดหมู่' : 'ยังไม่มีสินค้า'}</p>`;
}
export function handlePromoScopeChange() { scopeList(document.getElementById('promo-applies-to').value, []); }

export function openPromoModal(code = null) {
  start();
  const p = code ? PROMOS.find(x => x.code === code) : null;
  const $ = (id) => document.getElementById(id);
  document.getElementById('promo-form').reset();
  $('promo-modal-heading').innerText = p ? `แก้ไขโค้ด ${p.code}` : 'สร้างโค้ดส่วนลด';
  $('promo-edit-mode').value = p ? 'edit' : 'create';
  $('promo-original-code').value = p?.code || '';
  $('promo-code-name').value = p?.code || '';
  $('promo-code-name').disabled = !!p;
  $('promo-discount-type').value = ['fixed', 'percent'].includes(p?.type) ? p.type : 'fixed';
  $('promo-discount-val').value = p?.value || '';
  $('promo-applies-to').value = p?.appliesTo || 'all';
  $('promo-max-per-user').value = p?.maxPerUser || '';
  $('promo-max-total-uses').value = p?.maxTotalUses || '';
  $('promo-desc').value = p?.desc || '';
  $('promo-active').checked = p ? p.active !== false : true;
  scopeList($('promo-applies-to').value, p?.appliesTo === 'categories' ? (p.categoryIds || []) : (p?.productIds || []));
  openModal('promo-form-modal');
}
export function closePromoModal() { closeModal('promo-form-modal'); }

export async function handleSavePromoModal(e) {
  e.preventDefault();
  const $ = (id) => document.getElementById(id);
  const edit = $('promo-edit-mode').value === 'edit';
  const code = (edit ? $('promo-original-code').value : $('promo-code-name').value).trim().toUpperCase();
  if (!/^[A-Z0-9_-]{2,40}$/.test(code)) return toast('โค้ดใช้ได้เฉพาะ A-Z 0-9 _ - (2-40 ตัว)', 'error');
  if (!edit && PROMOS.some(p => p.code === code)) return toast('มีโค้ดนี้อยู่แล้ว', 'error');
  const type = $('promo-discount-type').value;
  const value = Number($('promo-discount-val').value);
  if (!(value > 0) || (type === 'percent' && value > 100)) return toast('มูลค่าส่วนลดไม่ถูกต้อง', 'error');
  const appliesTo = $('promo-applies-to').value;
  const picked = [...document.querySelectorAll('.promo-scope-item:checked')].map(i => i.value);
  if (appliesTo !== 'all' && !picked.length) return toast(appliesTo === 'categories' ? 'กรุณาเลือกหมวดหมู่อย่างน้อย 1 หมวด' : 'กรุณาเลือกสินค้าอย่างน้อย 1 รายการ', 'error');
  const old = PROMOS.find(p => p.code === code);
  const payload = {
    code, type, value, appliesTo,
    categoryIds: appliesTo === 'categories' ? picked : [], productIds: appliesTo === 'products' ? picked : [],
    maxPerUser: Math.max(0, parseInt($('promo-max-per-user').value, 10) || 0),
    maxTotalUses: Math.max(0, parseInt($('promo-max-total-uses').value, 10) || 0),
    usedCount: Number(old?.usedCount) || 0, desc: $('promo-desc').value.trim(), active: $('promo-active').checked,
    minValue: 0, maxValue: 0, updatedAt: serverTimestamp()
  };
  try { await setDoc(doc(db, 'promo_codes', code), payload); toast(`บันทึกโค้ด ${code} แล้ว`, 'success'); closePromoModal(); }
  catch (err) { console.warn(err); toast('บันทึกไม่สำเร็จ', 'error'); }
}

export async function deletePromo(code) {
  if (!confirm(`ลบโค้ด "${code}"?`)) return;
  try { await deleteDoc(doc(db, 'promo_codes', code)); toast(`ลบโค้ด ${code} แล้ว`, 'success'); }
  catch (e) { toast('ลบไม่สำเร็จ', 'error'); }
}

Object.assign(window, { renderAdminPromos, openPromoModal, closePromoModal, handlePromoScopeChange, handleSavePromoModal, deletePromo });
