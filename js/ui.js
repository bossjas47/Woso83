import { db, auth } from "../firebase-config.js";
import { doc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

/** Shared helpers for every customer page (toast, money, copy, images, store settings, worker calls). */

export const SHOP_NAME = 'ASTRAPHEX HUB';
export const ROOT = new URL('../', import.meta.url).href; // site root, works from / and /front/

export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
export const money = (v, digits = 2) => num(v).toLocaleString('th-TH', { minimumFractionDigits: digits, maximumFractionDigits: 2 });
export const baht = (v) => `฿${money(v)}`;
export const tsDate = (v) => (v?.toDate ? v.toDate() : (v ? new Date(v) : null));
export const fmtDate = (v) => { const d = tsDate(v); return d && !isNaN(d) ? d.toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' }) : '-'; };

export function timeAgo(v) {
  const d = tsDate(v); if (!d) return '';
  const s = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (s < 60) return 'เมื่อสักครู่';
  if (s < 3600) return `${Math.floor(s / 60)} นาทีที่แล้ว`;
  if (s < 86400) return `${Math.floor(s / 3600)} ชั่วโมงที่แล้ว`;
  return `${Math.floor(s / 86400)} วันที่แล้ว`;
}

/** "user01" -> "us***01" (keeps at most 2 chars at each end). */
export function maskName(name) {
  const s = [...String(name || 'user')];
  if (s.length <= 2) return s[0] + '***';
  if (s.length <= 4) return s.slice(0, 1).join('') + '***' + s.slice(-1).join('');
  return s.slice(0, 2).join('') + '***' + s.slice(-2).join('');
}

// ---------- Toast ----------
export function toast(message, kind = 'info') {
  let host = document.getElementById('toast-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toast-host'; host.className = 'toast-host'; host.setAttribute('role', 'status'); host.setAttribute('aria-live', 'polite');
    document.body.append(host);
  }
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<span class="toast-dot"></span><span></span>`;
  el.lastChild.textContent = message;
  host.append(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 250); }, 3200);
  while (host.children.length > 3) host.firstChild.remove();
}
window.triggerToast = (m, warn) => toast(m, warn === true ? 'error' : 'info');
window.showToast = toast;

export async function copyText(text, label = 'คัดลอกแล้ว') {
  const legacy = () => {
    const t = document.createElement('textarea'); t.value = String(text); t.setAttribute('readonly', ''); t.style.position = 'fixed'; t.style.opacity = '0';
    document.body.append(t); t.select(); t.setSelectionRange(0, t.value.length);
    const ok = document.execCommand('copy'); t.remove(); return ok;
  };
  let ok = false;
  try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(String(text)); ok = true; } } catch (_) {}
  // In-app browsers (Facebook, Line) often block the Clipboard API; the old way still works there.
  if (!ok) { try { ok = legacy(); } catch (_) {} }
  ok ? toast(label, 'success') : toast('คัดลอกไม่สำเร็จ กรุณากดค้างเพื่อคัดลอกเอง', 'error');
}
window.copyText = copyText;

// ---------- Modals ----------
export function openModal(id) { const m = document.getElementById(id); if (m) { m.classList.add('open'); m.setAttribute('aria-hidden', 'false'); } }
export function closeModal(id) { const m = document.getElementById(id); if (m) { m.classList.remove('open'); m.setAttribute('aria-hidden', 'true'); } }
window.openModal = openModal; window.closeModal = closeModal;
document.addEventListener('click', (e) => { if (e.target.classList?.contains('modal')) closeModal(e.target.id); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.querySelectorAll('.modal.open').forEach(m => closeModal(m.id)); });

// ---------- Store settings (system/settings, public) ----------
let settingsCache = null;
const settingsSubs = new Set();
let settingsStarted = false;
export function onSettings(cb) {
  settingsSubs.add(cb);
  if (settingsCache) cb(settingsCache);
  if (!settingsStarted) {
    settingsStarted = true;
    onSnapshot(doc(db, 'system', 'settings'), (snap) => {
      settingsCache = snap.exists() ? snap.data() : {};
      settingsSubs.forEach(f => { try { f(settingsCache); } catch (e) { console.warn(e); } });
    }, (e) => { console.warn('settings:', e); settingsCache = {}; settingsSubs.forEach(f => f(settingsCache)); });
  }
  return () => settingsSubs.delete(cb);
}
export const getSettings = () => settingsCache || {};

/** Contact channels from settings (new keys, falling back to the old lineId / discordLink). */
export function contactsOf(s = getSettings()) {
  const line = String(s.contactLine || s.lineId || '').trim();
  const lineUrl = !line ? '' : /^https?:\/\//.test(line) ? line : `https://line.me/R/ti/p/${encodeURIComponent(line.startsWith('@') ? line : '@' + line)}`;
  const safe = (u) => /^https:\/\//.test(String(u || '').trim()) ? String(u).trim() : '';
  return [
    { key: 'line', label: 'Line', text: line, url: lineUrl, color: '#06c755' },
    { key: 'facebook', label: 'Facebook', text: 'Facebook', url: safe(s.contactFacebook), color: '#1877f2' },
    { key: 'discord', label: 'Discord', text: 'Discord', url: safe(s.contactDiscord || s.discordLink), color: '#5865f2' }
  ].filter(c => c.url);
}

// ---------- Worker (Cloudflare) ----------
export const workerBase = () => String(getSettings().slipWorkerUrl || '').trim().replace(/\/+$/, '');
export async function callWorker(path, body) {
  const base = workerBase();
  if (!base) throw Object.assign(new Error('ยังไม่ได้ตั้งค่า Worker'), { code: 'no-worker' });
  const user = auth.currentUser;
  if (!user) throw Object.assign(new Error('กรุณาเข้าสู่ระบบ'), { code: 'unauthenticated' });
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + await user.getIdToken(), 'content-type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || data.message || 'ทำรายการไม่สำเร็จ'), { status: res.status, data });
  return data;
}
/** Fire-and-forget: ask the Worker to post a Discord message for a new order / top-up. */
export function notifyAdmin(kind, id) {
  if (!workerBase()) return;
  callWorker('/notify', { kind, id }).catch((e) => console.warn('notify skipped:', e.message));
}

// ---------- Images ----------
/** Shrinks an image file to a JPEG data URL (default ≤1280px, ~quality .72) so it fits in a Firestore doc. */
export async function compressImage(file, maxDim = 1280, quality = 0.72, maxChars = 650000) {
  if (!file || !/^image\//.test(file.type)) throw new Error('กรุณาเลือกไฟล์รูปภาพ');
  if (file.size > 15 * 1024 * 1024) throw new Error('ไฟล์ใหญ่เกิน 15MB');
  const bmp = await createImageBitmap(file);
  let dim = maxDim, q = quality, out = '';
  for (let i = 0; i < 6; i++) {
    const k = Math.min(1, dim / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    out = c.toDataURL('image/jpeg', q);
    if (out.length <= maxChars) return out;
    dim = Math.round(dim * 0.8); q = Math.max(0.5, q - 0.06);
  }
  if (out.length > maxChars) throw new Error('รูปใหญ่เกินไป กรุณาครอปหรือแคปใหม่');
  return out;
}

/** SHA-256 hex of the original file bytes (same file uploaded twice -> same hash). */
export async function fileHash(file) {
  const buf = await file.arrayBuffer();
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Reads the QR printed on a bank slip (BarcodeDetector, else jsQR from cdnjs). Returns its text or ''. */
export async function readSlipQr(file) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  const ctx = c.getContext('2d'); ctx.drawImage(bmp, 0, 0, c.width, c.height);
  if ('BarcodeDetector' in window) {
    try { const r = await new BarcodeDetector({ formats: ['qr_code'] }).detect(c); if (r[0]?.rawValue) return r[0].rawValue; } catch (_) {}
  }
  if (!window.jsQR) await new Promise((ok, no) => {
    const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jsQR/1.4.0/jsQR.min.js';
    s.onload = ok; s.onerror = no; document.head.append(s);
  });
  const d = ctx.getImageData(0, 0, c.width, c.height);
  return window.jsQR(d.data, d.width, d.height)?.data || '';
}

/** Saves an image (data URL or https URL) as a file; falls back to opening it when the host blocks downloads. */
export async function downloadImage(src, filename) {
  try {
    const blob = await (await fetch(src)).blob();
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast('บันทึกรูปแล้ว', 'success');
  } catch (_) {
    window.open(src, '_blank', 'noopener');
    toast('เปิดรูปในแท็บใหม่แล้ว กดค้างที่รูปเพื่อบันทึก');
  }
}

// ---------- Small render helpers ----------
export const icon = (d, cls = 'w-5 h-5', sw = 1.8) => `<svg class="${cls}" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
export const ICONS = {
  home: 'M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10',
  shop: 'M4 7h16l-1 13H5L4 7zm4 0a4 4 0 018 0',
  wallet: 'M3 7h16a2 2 0 012 2v10H5a2 2 0 01-2-2V7zm0 0V6a2 2 0 012-2h11M16 14h.01',
  plus: 'M12 5v14M5 12h14',
  tools: 'M14.7 6.3a4 4 0 00-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 005.4-5.4l-2.6 2.6-2.4-.6-.6-2.4 2.6-2.6z',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  user: 'M12 12a4 4 0 100-8 4 4 0 000 8zm-8 9a8 8 0 0116 0',
  queue: 'M12 7v5l3 2M12 21a9 9 0 100-18 9 9 0 000 18z',
  orders: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  chat: 'M21 12a8 8 0 01-11.6 7.1L4 20l1-4.6A8 8 0 1121 12z',
  logout: 'M17 16l4-4-4-4M21 12H9M13 20H6a2 2 0 01-2-2V6a2 2 0 012-2h7',
  login: 'M15 3h3a2 2 0 012 2v14a2 2 0 01-2 2h-3M10 17l5-5-5-5M15 12H3',
  moon: 'M21 13A9 9 0 1111 3a7 7 0 0010 10z',
  copy: 'M8 8h11v13H8zM5 16H4V3h11v1',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zm10 3a3 3 0 100-6 3 3 0 000 6z',
  eyeOff: 'M3 3l18 18M10.6 10.6a2 2 0 002.8 2.8M9.9 5.1A10 10 0 0112 5c6 0 10 7 10 7a17 17 0 01-3.2 3.9M6.6 6.6C3.8 8.4 2 12 2 12s4 7 10 7a9.6 9.6 0 004.4-1',
  check: 'M5 13l4 4L19 7',
  download: 'M12 3v12m0 0l-4-4m4 4l4-4M4 21h16',
  upload: 'M12 21V9m0 0l-4 4m4-4l4 4M4 3h16',
  bolt: 'M13 2L4 14h7l-1 8 9-12h-7l1-8z',
  id: 'M6 8h12a4 4 0 014 4v3a3 3 0 01-5 2l-2-2H9l-2 2a3 3 0 01-5-2v-3a4 4 0 014-4zM8 12v3M6.5 13.5h3M16 12h.01M18 14h.01',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  star: 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9L12 3z',
  search: 'M21 21l-5-5m2-6a8 8 0 11-16 0 8 8 0 0116 0z',
  filter: 'M3 5h18M6 12h12M10 19h4',
  gift: 'M3 8h18v4H3zM5 12v9h14v-9M12 8v13M12 8S9.5 3 7.5 4.5 9 8 12 8zm0 0s2.5-5 4.5-3.5S15 8 12 8z',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z',
  x: 'M6 6l12 12M18 6L6 18'
};
