import { esc, onSettings, fixImageUrl, sizedImage } from "./ui.js";

/** Home-page welcome popup: image slides set in admin (popupImages). Shows on every visit until "ไม่แสดงอีก 1 ชม." is pressed. */
const KEY = 'astraphex_popup_until', HOUR = 36e5;
const snoozed = () => { try { return Number(localStorage.getItem(KEY)) > Date.now(); } catch (_) { return false; } };
let shown = false, i = 0, imgs = [];

function paint() {
  const m = document.getElementById('welcome-popup');
  m.querySelector('img').src = sizedImage(imgs[i], 1000);
  m.querySelector('img').dataset.orig = imgs[i];
  m.querySelectorAll('[data-dot]').forEach((d, k) => d.classList.toggle('bg-pricingBlue', k === i));
  const next = m.querySelector('[data-next]'); if (next) next.textContent = `ถัดไป (${i + 1}/${imgs.length})`;
}
function show() {
  imgs = [];
  document.body.insertAdjacentHTML('beforeend', `<div id="welcome-popup" class="modal" role="dialog" aria-modal="true" aria-label="ประกาศ"><div class="modal-card !p-3 text-center">
    <button type="button" onclick="closeModal('welcome-popup')" aria-label="ปิด" class="absolute top-5 right-5 w-9 h-9 rounded-full bg-gallery/90 text-ink shadow flex items-center justify-center text-xl leading-none">×</button>
    <img alt="" class="w-full rounded-[20px] bg-mist" referrerpolicy="no-referrer" onerror="imgFallback(this)">
    <div class="flex justify-center gap-1.5 mt-3" id="popup-dots"></div>
    <div class="grid grid-cols-2 gap-2 mt-3"><button type="button" data-next class="apple-explore-pill py-3 text-[15px]">ถัดไป</button>
      <button type="button" data-snooze class="apple-explore-pill py-3 text-[15px]">ไม่แสดงอีก 1 ชม.</button></div></div></div>`);
}
onSettings((s) => {
  if (shown) return;
  const list = (Array.isArray(s.popupImages) ? s.popupImages : []).map(fixImageUrl).filter(Boolean).slice(0, 6);
  if (s.popupEnabled !== true || !list.length || snoozed()) return;
  shown = true; show(); imgs = list;
  const m = document.getElementById('welcome-popup');
  m.querySelector('#popup-dots').innerHTML = imgs.map((_, k) => `<span data-dot class="w-2 h-2 rounded-full bg-control"></span>`).join('');
  const one = imgs.length < 2;
  m.querySelector('[data-next]').classList.toggle('hidden', one);
  m.querySelector('[data-snooze]').parentElement.classList.toggle('grid-cols-2', !one); m.querySelector('[data-snooze]').parentElement.classList.toggle('grid-cols-1', one);
  m.querySelector('#popup-dots').classList.toggle('hidden', one);
  m.querySelector('[data-next]').onclick = () => { i = (i + 1) % imgs.length; paint(); };
  m.querySelector('[data-snooze]').onclick = () => { try { localStorage.setItem(KEY, String(Date.now() + HOUR)); } catch (_) {} window.closeModal('welcome-popup'); };
  paint();
  setTimeout(() => window.openModal('welcome-popup'), 400);
});
