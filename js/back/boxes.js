import { db } from "../../firebase-config.js";
import { collection, doc, onSnapshot, setDoc, deleteDoc, query, orderBy, limit, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { esc, num, money, toast, openModal, closeModal, fmtDate, compressImage } from "../ui.js";
import { isServiceProduct } from "../categories.js";
import { dragSort } from "./dragsort.js";
import { toast as say } from "../ui.js";
dragSort('admin-boxes-body', 'data-box', 'boxes', (m, t) => say(m, t));

/**
 * Back office: loot boxes (กล่องสุ่ม). boxes/{id} holds the box and its prize list; every open is written by the Worker
 * (box_opens) and only read here. Prize kinds: credit (฿ into the wallet), account (a game ID of a product), service
 * (a queue job the player fills in afterwards).
 */
const RARITY = { common: 'ธรรมดา', rare: 'หายาก', epic: 'มหากาพย์', legendary: 'ตำนาน' };
const KIND = { credit: 'เครดิต', account: 'ไอดีเกม', service: 'งานบริการ' };
const STATUS = { delivered: ['ส่งของแล้ว', 'text-emerald-600'], pending_claim: ['รอลูกค้ากรอกข้อมูลรับรางวัล', 'text-launchOrange'], claimed: ['รับรางวัลแล้ว', 'text-slate'] };
let BOXES = [], OPENS = [], started = false;
const $ = (id) => document.getElementById(id);
const products = () => window.getProductsForPromo?.() || [];
const cats = () => window.getCategoriesForPromo?.() || [];
const isSvc = (p) => isServiceProduct(p, cats());
const productById = (id) => products().find(p => p.id === id);

export function startBoxWatch() {
  if (started) return;
  started = true;
  onSnapshot(collection(db, 'boxes'), (s) => { BOXES = s.docs.map(d => ({ ...d.data(), id: d.id })).sort((a, b) => num(a.order) - num(b.order) || String(a.name).localeCompare(String(b.name))); renderAdminBoxes(); },
    (e) => { console.warn('boxes:', e); toast('โหลดกล่องสุ่มไม่สำเร็จ', 'error'); });
  onSnapshot(query(collection(db, 'box_opens'), orderBy('createdAt', 'desc'), limit(200)), (s) => { OPENS = s.docs.map(d => ({ ...d.data(), id: d.id })); renderAdminBoxes(); document.dispatchEvent(new Event('boxopens')); },
    (e) => console.warn('box_opens:', e));
}
export const getBoxOpens = () => OPENS;

/** Nominal (shop price) value of one prize, used only for the "average value" hint. */
function prizeValue(p) {
  if (p.kind === 'credit') return num(p.amount);
  const pr = productById(p.productId);
  return pr ? num(pr.price) * (p.kind === 'service' ? Math.max(1, num(p.qty)) : 1) : 0;
}
function averageValue(prizes) {
  const w = prizes.reduce((a, p) => a + num(p.weight), 0);
  return w > 0 ? prizes.reduce((a, p) => a + num(p.weight) * prizeValue(p), 0) / w : 0;
}

export function renderAdminBoxes() {
  const body = $('admin-boxes-body'); if (!body) return;
  $('admin-boxes-empty').classList.toggle('hidden', BOXES.length > 0);
  const opensOf = (id) => OPENS.filter(o => o.boxId === id).length;
  body.innerHTML = BOXES.map(b => {
    const id = esc(JSON.stringify(b.id));
    const prizes = Array.isArray(b.prizes) ? b.prizes : [];
    const avg = averageValue(prizes), price = num(b.price);
    const pct = price > 0 ? Math.round(avg / price * 100) : 0;
    return `<tr class="border-b border-hairline" draggable="true" data-box="${esc(b.id)}" title="ลากเพื่อจัดลำดับ">
      <td class="py-3 px-4"><p class="font-semibold"><span class="grip" aria-hidden="true">⋮⋮</span>${esc(b.name)}</p>${b.desc ? `<p class="text-[11px] text-slate">${esc(b.desc)}</p>` : ''}</td>
      <td class="py-3 px-4 font-mono font-semibold">฿${money(price)}</td>
      <td class="py-3 px-4 text-slate">${prizes.length} รายการ</td>
      <td class="py-3 px-4 font-mono">฿${money(avg)} <span class="text-[11px] ${pct > 100 ? 'text-red-500 font-semibold' : 'text-slate'}">(${pct}% ของราคากล่อง)</span></td>
      <td class="py-3 px-4 font-mono text-slate">${opensOf(b.id)}</td>
      <td class="py-3 px-4">${b.active === false ? '<span class="text-slate">ปิด</span>' : '<span class="text-emerald-600 font-semibold">เปิด</span>'}</td>
      <td class="py-3 px-4 text-right whitespace-nowrap"><button onclick='openBoxModal(${id})' class="apple-explore-pill px-3 py-1 text-[11px]">แก้ไข</button> <button onclick='deleteBox(${id})' class="apple-explore-pill px-3 py-1 text-[11px] text-red-500 border-red-200">ลบ</button></td></tr>`;
  }).join('');

  const revenue = OPENS.reduce((a, o) => a + num(o.price), 0);
  const paidCredit = OPENS.filter(o => o.kind === 'credit').reduce((a, o) => a + num(o.amount), 0);
  const pending = OPENS.filter(o => o.status === 'pending_claim').length;
  const card = (label, value, sub = '') => `<div class="apple-card p-4"><p class="text-[11px] text-slate">${label}</p><p class="text-2xl font-heading font-semibold mt-1">${value}</p><p class="text-[11px] text-slate mt-0.5">${sub}</p></div>`;
  $('box-stats').innerHTML = [
    card('เปิดกล่อง (ล่าสุด 200 ครั้ง)', OPENS.length, `${BOXES.filter(b => b.active !== false).length} กล่องที่เปิดอยู่`),
    card('เครดิตที่ลูกค้าจ่าย', '฿' + money(revenue), 'จากการเปิดกล่อง'),
    card('เครดิตที่แจกเป็นรางวัล', '฿' + money(paidCredit), revenue > 0 ? `${Math.round(paidCredit / revenue * 100)}% ของที่รับ (ยังไม่รวมไอดี/งาน)` : ''),
    card('รอลูกค้ากรอกข้อมูลรับงาน', pending, 'ของรางวัลแบบงานบริการ')
  ].join('');

  const rows = OPENS.slice(0, 100);
  $('admin-box-opens-empty').classList.toggle('hidden', rows.length > 0);
  $('admin-box-opens-body').innerHTML = rows.map(o => {
    const [label, cls] = STATUS[o.status] || [o.status, 'text-slate'];
    return `<tr class="border-b border-hairline">
      <td class="py-2.5 px-4 text-slate whitespace-nowrap">${esc(fmtDate(o.createdAt))}</td>
      <td class="py-2.5 px-4">${esc(String(o.userEmail || '').replace(/@tactical\.store$/, ''))}</td>
      <td class="py-2.5 px-4">${esc(o.boxName)}</td>
      <td class="py-2.5 px-4"><span class="font-medium">${esc(o.prizeLabel || '-')}</span>${o.qty ? ` × ${esc(o.qty)}` : ''} <span class="text-[11px] text-slate">${esc(KIND[o.kind] || '')} · ${esc(RARITY[o.rarity] || '')}</span></td>
      <td class="py-2.5 px-4 font-mono">฿${money(o.price)}</td>
      <td class="py-2.5 px-4 font-medium ${cls}">${label}</td></tr>`;
  }).join('');
}

// ---------- editor ----------
const sel = (cls, opts, cur) => `<select class="${cls} w-full apple-input px-2 py-1.5">${opts.map(([v, t]) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>`;

function rowHtml(p = {}) {
  const kind = KIND[p.kind] ? p.kind : 'credit';
  const accOpts = [['', '— เลือกสินค้าไอดีเกม —'], ...products().filter(x => !isSvc(x)).map(x => [x.id, `${x.name} (สต็อก ${num(x.stock)})`])];
  const svcOpts = [['', '— เลือกสินค้างานบริการ —'], ...products().filter(isSvc).map(x => [x.id, `${x.name} (รับได้ ${num(x.stock)})`])];
  return `<div class="prize-row rounded-2xl border border-hairline p-3 space-y-2" data-id="${esc(p.id || '')}">
    <div class="grid grid-cols-2 gap-2">
      ${sel('pz-kind', Object.entries(KIND), kind)}
      ${sel('pz-rarity', Object.entries(RARITY), RARITY[p.rarity] ? p.rarity : 'common')}
    </div>
    <div class="pz-credit ${kind === 'credit' ? '' : 'hidden'}"><input class="pz-amount w-full apple-input px-3 py-1.5 font-mono" type="number" min="0.01" step="0.01" placeholder="จำนวนเครดิต (฿)" value="${p.kind === 'credit' ? esc(p.amount ?? '') : ''}"></div>
    <div class="pz-account ${kind === 'account' ? '' : 'hidden'}">${sel('pz-product-account', accOpts, p.kind === 'account' ? p.productId : '')}</div>
    <div class="pz-service ${kind === 'service' ? '' : 'hidden'} grid grid-cols-3 gap-2">
      <div class="col-span-3">${sel('pz-product-service', svcOpts, p.kind === 'service' ? p.productId : '')}</div>
      <input class="pz-qty w-full apple-input px-3 py-1.5 font-mono" type="number" min="1" step="1" placeholder="จำนวนหน่วย" value="${p.kind === 'service' ? esc(p.qty ?? '') : ''}">
      <div class="col-span-2">${sel('pz-claim', [['with_id', 'ลูกค้าให้ไอดีไปทำ'], ['self', 'ลูกค้าไปยืนเอง']], p.claimMode === 'self' ? 'self' : 'with_id')}</div>
    </div>
    <div class="grid grid-cols-12 gap-2 items-center">
      <input class="pz-label col-span-5 apple-input px-3 py-1.5" type="text" maxlength="80" placeholder="ชื่อที่แสดง (เว้นว่าง = ใช้ชื่ออัตโนมัติ)" value="${esc(p.label || '')}">
      <input class="pz-weight col-span-3 apple-input px-3 py-1.5 font-mono" type="number" min="0.0001" step="any" placeholder="น้ำหนัก" value="${esc(p.weight ?? '')}">
      <span class="pz-pct col-span-2 font-mono text-slate text-center"></span>
      <button type="button" class="pz-del col-span-2 apple-explore-pill px-2 py-1 text-red-500 border-red-200">ลบ</button>
    </div>
  </div>`;
}

function readRows() {
  return [...document.querySelectorAll('#prize-rows .prize-row')].map((row, i) => {
    const v = (c) => row.querySelector('.' + c)?.value ?? '';
    const kind = v('pz-kind');
    const p = { id: row.dataset.id || `p${Date.now().toString(36)}${i}`, kind, rarity: v('pz-rarity'), weight: num(v('pz-weight')), label: v('pz-label').trim() };
    if (kind === 'credit') p.amount = Math.round(num(v('pz-amount')) * 100) / 100;
    else if (kind === 'account') p.productId = v('pz-product-account');
    else { p.productId = v('pz-product-service'); p.qty = Math.max(1, Math.floor(num(v('pz-qty'))) || 0); p.claimMode = v('pz-claim') === 'self' ? 'self' : 'with_id'; }
    return p;
  });
}

function refreshRows() {
  const rows = readRows();
  const total = rows.reduce((a, p) => a + (p.weight > 0 ? p.weight : 0), 0);
  document.querySelectorAll('#prize-rows .prize-row').forEach((row, i) => {
    const kind = rows[i].kind;
    row.querySelector('.pz-credit').classList.toggle('hidden', kind !== 'credit');
    row.querySelector('.pz-account').classList.toggle('hidden', kind !== 'account');
    row.querySelector('.pz-service').classList.toggle('hidden', kind !== 'service');
    row.querySelector('.pz-pct').textContent = total > 0 && rows[i].weight > 0 ? `${(rows[i].weight / total * 100).toLocaleString('th-TH', { maximumFractionDigits: 2 })}%` : '-';
  });
  const price = num($('box-price').value), avg = averageValue(rows.filter(p => p.weight > 0));
  $('box-ev').innerHTML = rows.length
    ? `มูลค่าเฉลี่ยของรางวัลต่อ 1 ครั้ง ≈ <b class="text-ink">฿${money(avg)}</b>${price > 0 ? ` (${Math.round(avg / price * 100)}% ของราคากล่อง ฿${money(price)})` : ''} · คิดจากราคาขายปกติของไอดี/งาน${price > 0 && avg > price ? ' <b class="text-red-500">— สูงกว่าราคากล่อง ร้านจะขาดทุนถ้าลูกค้าเปิดจำนวนมาก</b>' : ''}`
    : 'ยังไม่มีของรางวัล';
}

export function addPrizeRow(p = {}) {
  $('prize-rows').insertAdjacentHTML('beforeend', rowHtml(p));
  refreshRows();
}

export function openBoxModal(id = null) {
  startBoxWatch();
  const b = id ? BOXES.find(x => x.id === id) : null;
  $('box-form').reset();
  $('box-modal-heading').textContent = b ? `แก้ไขกล่อง: ${b.name}` : 'สร้างกล่องสุ่ม';
  $('box-edit-id').value = b?.id || '';
  $('box-name').value = b?.name || ''; $('box-desc').value = b?.desc || ''; $('box-image').value = b?.image || '';
  $('box-price').value = b?.price ?? ''; $('box-order').value = b?.order ?? '';
  $('box-pity').value = b?.pityEvery || 0; $('box-pity-rarity').value = b?.pityRarity || 'epic';
  $('box-active').checked = b ? b.active !== false : true;
  $('box-show-odds').checked = b ? b.showOdds !== false : true;
  $('box-category').innerHTML = document.getElementById('prod-category')?.innerHTML || '<option value="">— ไม่มีหมวดหมู่ —</option>';
  $('box-category').value = [...$('box-category').options].some(o => o.value === b?.category) ? b.category : '';
  $('prize-rows').innerHTML = '';
  (b?.prizes?.length ? b.prizes : [{ kind: 'credit', amount: 5, weight: 60, rarity: 'common' }, { kind: 'credit', amount: 50, weight: 5, rarity: 'rare' }]).forEach(p => addPrizeRow(p));
  boxImagePreview();
  $('box-sim').classList.add('hidden');
  openModal('box-form-modal');
}
export function boxImagePreview() {
  const v = $('box-image').value.trim(), im = $('box-image-preview');
  im.classList.toggle('hidden', !v); if (v) im.src = v;
}
export async function boxImageUpload(input) {
  const f = input.files?.[0]; if (!f) return;
  try { $('box-image').value = await compressImage(f, 800, 0.85, 160000); boxImagePreview(); }
  catch (e) { toast(e.message || 'อัปโหลดรูปไม่สำเร็จ', 'error'); }
  input.value = '';
}
export function boxImageClear() { $('box-image').value = ''; boxImagePreview(); }

/** Monte-Carlo: 10,000 opens with the form's weights -> money in vs prize value out, plus a 100-box swing range. */
export function simulateBox() {
  const rows = readRows().filter(p => p.weight > 0), price = num($('box-price').value), out = $('box-sim');
  out.classList.remove('hidden');
  if (!rows.length || !(price > 0)) { out.textContent = 'ใส่ราคากล่องและของรางวัลก่อน'; return; }
  const total = rows.reduce((a, p) => a + p.weight, 0), vals = rows.map(prizeValue), cnt = {};
  const draw = () => { let r = Math.random() * total, i = 0; while (i < rows.length - 1 && (r -= rows[i].weight) >= 0) i++; return i; };
  let pay = 0; const N = 10000;
  for (let k = 0; k < N; k++) { const i = draw(); pay += vals[i]; cnt[rows[i].rarity] = (cnt[rows[i].rarity] || 0) + 1; }
  const batches = []; for (let b = 0; b < 1000; b++) { let g = 0; for (let k = 0; k < 100; k++) g += price - vals[draw()]; batches.push(g); }
  batches.sort((a, b) => a - b);
  const take = N * price, profit = take - pay, R = { legendary: 'ตำนาน', epic: 'เอพิค', rare: 'หายาก', common: 'ทั่วไป' };
  out.innerHTML = `รับ ฿${money(take, 0)} · จ่ายของรางวัล ≈ ฿${money(pay, 0)} · <b class="${profit >= 0 ? 'text-ink' : 'text-red-500'}">${profit >= 0 ? 'กำไร' : 'ขาดทุน'} ฿${money(Math.abs(profit), 0)} (${(profit / take * 100).toFixed(1)}%)</b><br>`
    + `ทุก 100 กล่อง กำไรมักอยู่ระหว่าง ฿${money(batches[50], 0)} ถึง ฿${money(batches[950], 0)} (90% ของรอบ)<br>`
    + Object.keys(R).filter(k => cnt[k]).map(k => `${R[k]} ${(cnt[k] / N * 100).toFixed(1)}%`).join(' · ')
    + '<br><span class="text-[10px]">มูลค่าไอดี/งานคิดตามราคาขายในร้าน</span>';
}
export const closeBoxModal = () => closeModal('box-form-modal');

export async function handleSaveBox(e) {
  e.preventDefault();
  const prizes = readRows();
  if (!prizes.length) return toast('ใส่ของรางวัลอย่างน้อย 1 รายการ', 'error');
  for (const [i, p] of prizes.entries()) {
    const n = i + 1;
    if (!(p.weight > 0)) return toast(`ของรางวัลที่ ${n}: ใส่น้ำหนักมากกว่า 0`, 'error');
    if (p.kind === 'credit' && !(p.amount > 0)) return toast(`ของรางวัลที่ ${n}: ใส่จำนวนเครดิต`, 'error');
    if (p.kind !== 'credit' && !p.productId) return toast(`ของรางวัลที่ ${n}: เลือกสินค้า`, 'error');
    if (p.kind === 'service' && !(p.qty >= 1)) return toast(`ของรางวัลที่ ${n}: ใส่จำนวนหน่วยของงาน`, 'error');
  }
  const editId = $('box-edit-id').value;
  const id = editId || 'box_' + Date.now().toString(36);
  const clean = prizes.map(p => Object.fromEntries(Object.entries(p).filter(([k, v]) => !(k === 'label' && !v))));
  const payload = {
    name: $('box-name').value.trim(), desc: $('box-desc').value.trim(), image: $('box-image').value.trim(),
    price: Math.round(num($('box-price').value) * 100) / 100, order: Math.floor(num($('box-order').value)),
    pityEvery: Math.max(0, Math.min(500, Math.floor(num($('box-pity').value)))), pityRarity: $('box-pity-rarity').value, category: $('box-category').value, active: $('box-active').checked, showOdds: $('box-show-odds').checked, prizes: clean,
    updatedAt: serverTimestamp(), ...(editId ? {} : { createdAt: serverTimestamp() })
  };
  if (!(payload.price > 0)) return toast('ใส่ราคากล่อง', 'error');
  try { await setDoc(doc(db, 'boxes', id), payload, { merge: true }); toast('บันทึกกล่องสุ่มแล้ว', 'success'); closeBoxModal(); }
  catch (err) { console.warn(err); toast('บันทึกไม่สำเร็จ', 'error'); }
}

export async function deleteBox(id) {
  const b = BOXES.find(x => x.id === id);
  if (!confirm(`ลบกล่อง "${b?.name || id}"? (ประวัติการเปิดที่ผ่านมายังอยู่)`)) return;
  try { await deleteDoc(doc(db, 'boxes', id)); toast('ลบกล่องแล้ว', 'success'); } catch (e) { toast('ลบไม่สำเร็จ', 'error'); }
}

// live updates inside the editor (kind switch, weights, price)
document.addEventListener('input', (e) => { if (e.target.closest?.('#box-form')) refreshRows(); });
document.addEventListener('change', (e) => { if (e.target.closest?.('#box-form')) refreshRows(); });
document.addEventListener('click', (e) => {
  const del = e.target.closest?.('.pz-del');
  if (del) { del.closest('.prize-row').remove(); refreshRows(); }
});

Object.assign(window, { boxImagePreview, boxImageUpload, boxImageClear, simulateBox, startBoxWatch, getBoxOpens, renderAdminBoxes, openBoxModal, closeBoxModal, handleSaveBox, deleteBox, addPrizeRow: () => addPrizeRow() });
