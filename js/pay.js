import { db } from "../firebase-config.js";
import { doc, getDoc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { esc, baht, icon, ICONS, onSettings, copyText, downloadImage, compressImage, fileHash, toast } from "./ui.js";

/**
 * PromptPay block shared by the top-up page and product checkout:
 * QR (uploaded in admin, or an image URL), amount, account name, "ดาวน์โหลดรูป QR", "คัดลอกเลขพร้อมเพย์"
 * and a slip picker with preview. Slips are shrunk to a JPEG and later stored in slip_images/{id};
 * the SHA-256 of the original file goes to slip_hashes/{hash} so the same slip file cannot be sent twice.
 */
let qrUploaded = '';
let settings = {};
const subs = new Set();
const emit = () => subs.forEach(f => f());
onSettings((s) => { settings = s || {}; emit(); });
onSnapshot(doc(db, 'system', 'promptpay_qr'), (snap) => { qrUploaded = snap.exists() ? String(snap.data().image || '') : ''; emit(); }, () => {});

export const qrSrc = () => (qrUploaded.startsWith('data:image/') ? qrUploaded : '') || (/^https:\/\//.test(String(settings.promptpayQrUrl || '')) ? settings.promptpayQrUrl : '');
export const promptpayReady = () => !!qrSrc();

export function mountPromptPay(el, { getAmount, slipRequired = true, idPrefix = 'pp' }) {
  let file = null;
  el.innerHTML = `
    <div class="text-center">
      <div class="mx-auto w-56 h-56 rounded-3xl bg-gallery border border-hairline p-3 flex items-center justify-center">
        <img id="${idPrefix}-qr" alt="QR พร้อมเพย์ของร้าน" class="hidden w-full h-full object-contain">
        <span id="${idPrefix}-qr-empty" class="text-sm text-slate px-4">ร้านยังไม่ได้ตั้งค่า QR พร้อมเพย์ กรุณาติดต่อแอดมิน</span>
      </div>
      <p class="mt-3 text-sm text-slate">ยอดที่ต้องโอน</p>
      <p id="${idPrefix}-amount" class="text-3xl font-heading font-semibold">฿0.00</p>
      <p id="${idPrefix}-name" class="text-sm text-ink mt-1"></p>
      <div class="mt-4 grid grid-cols-2 gap-2 max-w-sm mx-auto">
        <button id="${idPrefix}-dl" type="button" class="apple-explore-pill py-2.5 text-sm bg-gallery">${icon(ICONS.download, 'w-4 h-4', 2)}ดาวน์โหลดรูป QR</button>
        <button id="${idPrefix}-copy" type="button" class="apple-explore-pill py-2.5 text-sm bg-gallery">${icon(ICONS.copy, 'w-4 h-4', 2)}คัดลอกเลขพร้อมเพย์</button>
      </div>
      <p id="${idPrefix}-number" class="text-xs text-slate mt-2 font-mono"></p>
    </div>
    <div class="mt-5">
      <p class="text-sm font-medium mb-2">อัปโหลดรูปภาพสลิปโอนเงิน${slipRequired ? ' <span class="text-launchOrange">*</span>' : ''}</p>
      <label id="${idPrefix}-drop" class="flex items-center gap-3 rounded-2xl border-2 border-dashed border-hairline bg-gallery p-4 cursor-pointer hover:border-pricingBlue transition">
        <span class="w-12 h-12 rounded-xl bg-mist flex items-center justify-center text-pricingBlue shrink-0 overflow-hidden"><img id="${idPrefix}-preview" alt="" class="hidden w-full h-full object-cover">${icon(ICONS.upload, `w-6 h-6 ${idPrefix}-up-icon`, 2)}</span>
        <span class="min-w-0"><span id="${idPrefix}-file-label" class="block text-[15px] font-medium text-ink truncate">เลือกรูปสลิป</span><span class="block text-xs text-slate">JPG / PNG จากแอปธนาคาร</span></span>
        <input id="${idPrefix}-file" type="file" accept="image/*" class="sr-only">
      </label>
    </div>`;
  const $ = (s) => el.querySelector('#' + idPrefix + '-' + s);
  const refresh = () => {
    const src = qrSrc();
    const img = $('qr');
    if (src && img.getAttribute('src') !== src) img.src = src;
    img.classList.toggle('hidden', !src);
    $('qr-empty').classList.toggle('hidden', !!src);
    $('amount').textContent = baht(getAmount());
    $('name').textContent = settings.promptpayName ? `ชื่อบัญชี: ${settings.promptpayName}` : '';
    const no = String(settings.promptpayNumber || '').trim();
    $('number').textContent = no ? `พร้อมเพย์ ${no}` : '';
    $('copy').disabled = !no;
    $('dl').disabled = !src;
  };
  subs.add(refresh);
  $('dl').onclick = () => qrSrc() && downloadImage(qrSrc(), 'astraphex-promptpay-qr.jpg');
  $('copy').onclick = () => settings.promptpayNumber && copyText(String(settings.promptpayNumber).replace(/\s|-/g, ''), 'คัดลอกเลขพร้อมเพย์แล้ว');
  $('file').onchange = (e) => {
    file = e.target.files?.[0] || null;
    $('file-label').textContent = file ? file.name : 'เลือกรูปสลิป';
    const pv = $('preview');
    if (file) { pv.src = URL.createObjectURL(file); pv.classList.remove('hidden'); el.querySelector('.' + idPrefix + '-up-icon')?.classList.add('hidden'); }
    else { pv.classList.add('hidden'); el.querySelector('.' + idPrefix + '-up-icon')?.classList.remove('hidden'); }
  };
  refresh();
  return {
    refresh,
    getFile: () => file,
    reset() { file = null; $('file').value = ''; $('file').onchange({ target: { files: [] } }); }
  };
}

/** Shrinks the slip and checks it was not used before. Returns { image, hash } or throws with a Thai message. */
export async function prepareSlip(file) {
  if (!file) throw new Error('กรุณาแนบรูปสลิปโอนเงิน');
  const [hash, image] = await Promise.all([fileHash(file), compressImage(file)]);
  let used = false;
  try { used = (await getDoc(doc(db, 'slip_hashes', hash))).exists(); } catch (_) { /* rules also block the duplicate on write */ }
  if (used) throw new Error('สลิปนี้เคยถูกใช้แล้ว กรุณาใช้สลิปของรายการนี้');
  return { image, hash };
}

export function slipErrorText(e) {
  if (e?.code === 'permission-denied') return 'ส่งไม่สำเร็จ: สลิปนี้อาจเคยถูกใช้แล้ว หรือข้อมูลไม่ครบ';
  return e?.message && /[฀-๿]/.test(e.message) ? e.message : 'ส่งไม่สำเร็จ กรุณาลองใหม่อีกครั้ง';
}

export { toast, esc };
