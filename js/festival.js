import { esc } from "./ui.js";
import { safeHref } from "./home-quick.js";

/**
 * Festival effect "Shadow System" (settings.festival = { on, density, msg, link, until, v }), loaded by shell.js only when on.
 * One fixed canvas over the page (pointer-events: none). Kept cheap: pre-rendered glow sprites (no shadowBlur),
 * DPR capped at 1.5, fewer sparks on phones, paused while the tab is hidden, off for prefers-reduced-motion.
 */
const COUNT = { low: 22, mid: 42, high: 72 };
const COLORS = ['#3d8bff', '#5fb4ff', '#8a5cff', '#b28cff'];
let cur = '', cv = null, ctx = null, raf = 0, sparks = [], sprites = [], W = 0, H = 0, last = 0, onResize = null, onVis = null;

function sprite(color) {
  const s = document.createElement('canvas'); s.width = s.height = 32;
  const g = s.getContext('2d'), r = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  r.addColorStop(0, '#ffffff'); r.addColorStop(0.18, color); r.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = r; g.fillRect(0, 0, 32, 32);
  return s;
}
const spark = (anyY) => ({
  x: Math.random() * W, y: anyY ? Math.random() * H : H + 20, size: 6 + Math.random() * 14,
  vy: 18 + Math.random() * 42, sway: 10 + Math.random() * 24, ph: Math.random() * 6.28, sp: 0.6 + Math.random() * 1.4,
  life: 0, max: 5 + Math.random() * 7, img: sprites[(Math.random() * sprites.length) | 0]
});

function size() {
  const dpr = Math.min(1.5, devicePixelRatio || 1);
  W = innerWidth; H = innerHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function frame(t) {
  raf = requestAnimationFrame(frame);
  const dt = Math.min(0.05, (t - (last || t)) / 1000); last = t;
  ctx.clearRect(0, 0, W, H);
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < sparks.length; i++) {
    const s = sparks[i];
    s.life += dt; s.y -= s.vy * dt; s.ph += s.sp * dt;
    if (s.y < -30 || s.life > s.max) { sparks[i] = spark(false); continue; }
    // fade in, flicker, fade out
    const a = Math.min(1, s.life / 0.8, (s.max - s.life) / 1.5) * (0.55 + 0.45 * Math.sin(s.ph * 3));
    if (a <= 0) continue;
    ctx.globalAlpha = a * 0.85;
    ctx.drawImage(s.img, s.x + Math.sin(s.ph) * s.sway - s.size / 2, s.y - s.size / 2, s.size, s.size);
  }
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
}

function startSparks(density) {
  if (cv) return;
  cv = document.createElement('canvas');
  cv.className = 'fx-canvas'; cv.setAttribute('aria-hidden', 'true');
  document.body.appendChild(cv);
  ctx = cv.getContext('2d');
  if (!sprites.length) sprites = COLORS.map(sprite);
  size();
  const n = Math.round((COUNT[density] || COUNT.mid) * (W < 640 ? 0.55 : 1));
  sparks = Array.from({ length: n }, () => spark(true));
  onResize = () => size(); addEventListener('resize', onResize, { passive: true });
  onVis = () => { cancelAnimationFrame(raf); last = 0; if (!document.hidden) raf = requestAnimationFrame(frame); };
  document.addEventListener('visibilitychange', onVis);
  raf = requestAnimationFrame(frame);
}

function stopSparks() {
  if (!cv) return;
  cancelAnimationFrame(raf); removeEventListener('resize', onResize); document.removeEventListener('visibilitychange', onVis);
  cv.remove(); cv = ctx = null; sparks = [];
}

function systemWindow(f) {
  const key = 'fx-seen-' + (f.v || 0);
  try { if (localStorage.getItem(key)) return; } catch (_) {}
  if (document.querySelector('.fx-sys')) return;
  const href = f.link ? safeHref(f.link) : '';
  const box = document.createElement('div');
  box.className = 'fx-sys'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', 'แจ้งเตือนจากระบบ');
  box.innerHTML = `<div class="fx-sys-card">
      <p class="fx-sys-head"><span class="fx-sys-i">!</span>แจ้งเตือนจากระบบ</p>
      <p class="fx-sys-msg">${esc(f.msg)}</p>
      <div class="fx-sys-act">${href && href !== '#' ? `<a href="${esc(href)}" class="fx-sys-btn fx-sys-ok">รับภารกิจ</a>` : ''}<button type="button" class="fx-sys-btn">ปิด</button></div>
    </div>`;
  const close = () => { try { localStorage.setItem(key, '1'); } catch (_) {} box.classList.remove('on'); setTimeout(() => box.remove(), 300); };
  box.addEventListener('click', (e) => { if (e.target === box || e.target.closest('button')) close(); if (e.target.closest('a')) close(); });
  document.addEventListener('keydown', function k(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', k); } });
  document.body.appendChild(box);
  requestAnimationFrame(() => box.classList.add('on'));
  box.querySelector('.fx-sys-btn:last-child').focus({ preventScroll: true });
}

/** Called by shell.js on every settings change. */
export function applyFestival(f, isHome) {
  const on = f?.on === true && !(f.until > 0 && Date.now() > f.until);
  if (cv && cur !== f.density) stopSparks();
  cur = f?.density;
  if (!on || matchMedia('(prefers-reduced-motion: reduce)').matches) stopSparks(); else startSparks(f.density);
  if (on && isHome && String(f.msg || '').trim()) setTimeout(() => systemWindow(f), 1200);
}
