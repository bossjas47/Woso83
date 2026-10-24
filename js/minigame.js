/* Nugget Hub — mini-games that "open" a loot box (v3).
 * The prize is decided by the Worker before any game starts, so skill never changes the result:
 * a game only needs to finish. Each game returns { done: Promise, skip() }.
 * Difficulty: HARD = 1.2 → every tuning value (speed, zone/target size, time, clear threshold) is 20% tougher than v2.
 * Set HARD = 1 to get the old difficulty back. */

export const HARD = 1.2;

// ---------- icons: inline SVG (Lucide-style, stroke = currentColor), used instead of emoji everywhere ----------
const ICONS = {
  lock: '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  unlock: '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>',
  target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  ticket: '<path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/><path d="M13 5v2M13 11v2M13 17v2"/>',
  coin: '<circle cx="12" cy="12" r="10"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/><path d="M12 18V6"/>',
  gamepad: '<path d="M6 11h4M8 9v4M15 12h.01M18 10h.01"/><path d="M17.32 5H6.68a4 4 0 0 0-3.98 3.59C2.6 9.42 2 14.46 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.41-1.41A2 2 0 0 1 9.83 16h4.34a2 2 0 0 1 1.42.59L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.55-.6-6.58-.69-7.26A4 4 0 0 0 17.32 5z"/>',
  wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94z"/>',
  gift: '<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13"/><path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7"/><path d="M7.5 8a2.5 2.5 0 0 1 0-5A4.8 8 0 0 1 12 8a4.8 8 0 0 1 4.5-5 2.5 2.5 0 0 1 0 5"/>',
  package: '<path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  volume: '<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a10 10 0 0 1 0 14"/>',
  mute: '<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="m22 9-6 6M16 9l6 6"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
  minus: '<path d="M5 12h14"/>',
  plus: '<path d="M5 12h14M12 5v14"/>',
  star: '<path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8-6.2-3.3-6.2 3.3L7 14.2 2 9.3l6.9-1z"/>'
};
export const icon = (name, cls = '') => `<svg class="bx-ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.gift}</svg>`;

export const GAMES = [
  { id: 'safe', label: 'แงะตู้เซฟ', icon: 'lock' },
  { id: 'shoot', label: 'ยิงเป้า', icon: 'target' },
  { id: 'scratch', label: 'ขูดบัตร', icon: 'ticket' }
];

const rand = (a, b) => a + Math.random() * (b - a);
const tick = (ms) => new Promise(r => setTimeout(r, ms));
const vibe = (p) => { try { navigator.vibrate?.(p); } catch { /* not supported */ } };

// ---------- feel: tiny synthesized sounds (WebAudio, no files), confetti, sparks ----------
let actx = null;
export const sfx = (kind) => {
  try {
    if (localStorage.getItem('bx-mute') === '1') return;
    actx ||= new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === 'suspended') actx.resume();
    const seq = { good: [[660, .07], [880, .09]], bad: [[200, .16]], tick: [[1200, .03]], perfect: [[880, .06], [1175, .06], [1568, .12]], win: [[523, .09], [659, .09], [784, .09], [1047, .22]], big: [[392, .1], [523, .1], [659, .1], [784, .1], [1047, .12], [1319, .32]], boom: [[110, .3]] }[kind] || [];
    let t = actx.currentTime;
    for (const [f, d] of seq) {
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = kind === 'bad' || kind === 'boom' ? 'sawtooth' : 'triangle'; o.frequency.value = f;
      g.gain.setValueAtTime(.0001, t); g.gain.exponentialRampToValueAtTime(.16, t + .01); g.gain.exponentialRampToValueAtTime(.0001, t + d);
      o.connect(g).connect(actx.destination); o.start(t); o.stop(t + d + .02); t += d * .9;
    }
  } catch { /* audio blocked */ }
};
/** Confetti: DOM pieces falling inside `root` (needs position: relative/absolute/fixed). */
export function confetti(root, n = 40, colors = ['#0071e3', '#7c3aed', '#f2c94c', '#b64400', '#30d158']) {
  if (!root) return;
  const box = document.createElement('div'); box.className = 'bx-confetti'; root.appendChild(box);
  for (let i = 0; i < n; i++) {
    const p = document.createElement('i');
    p.style.cssText = `left:${rand(0, 100)}%;background:${colors[i % colors.length]};animation-delay:${rand(0, .5).toFixed(2)}s;animation-duration:${rand(1.6, 2.8).toFixed(2)}s;--dx:${rand(-60, 60).toFixed(0)}px;--rot:${rand(240, 900).toFixed(0)}deg;width:${rand(6, 11).toFixed(0)}px;height:${rand(8, 16).toFixed(0)}px`;
    box.appendChild(p);
  }
  setTimeout(() => box.remove(), 3600);
}
/** A "+1" that floats up from a point inside root. */
const floaty = (root, x, y, text, color) => { const e = document.createElement('b'); e.className = 'bx-float'; e.textContent = text; e.style.left = x + 'px'; e.style.top = y + 'px'; if (color) e.style.color = color; root.appendChild(e); setTimeout(() => e.remove(), 800); };
/** Small spark burst from a point inside root (root must be positioned). */
function burst(root, x, y, n = 8, color = '#f2c94c') {
  for (let i = 0; i < n; i++) {
    const s = document.createElement('i'), a = rand(0, Math.PI * 2), d = rand(24, 64);
    s.className = 'bx-spark';
    s.style.cssText = `left:${x}px;top:${y}px;background:${color};--dx:${(Math.cos(a) * d).toFixed(0)}px;--dy:${(Math.sin(a) * d).toFixed(0)}px`;
    root.appendChild(s); setTimeout(() => s.remove(), 650);
  }
}

/** @param {'safe'|'shoot'|'scratch'} kind  @param {HTMLElement} arena  @param {HTMLElement} msg */
export function playGame(kind, arena, msg) {
  let skipFn = () => {};
  const done = new Promise((resolve) => {
    let finished = false;
    const cleanups = [];
    const end = () => { if (finished) return; finished = true; cleanups.splice(0).forEach(f => { try { f(); } catch { /* ignore */ } }); resolve(); };
    skipFn = end;
    const say = (t, cls = '') => { msg.textContent = t; msg.className = 'bx-msg ' + cls; };
    const fn = { safe, shoot, scratch }[kind] || safe;
    arena.innerHTML = '';
    fn({ arena, say, end, cleanups, isDone: () => finished });
  });
  return { done, skip: () => skipFn() };
}

// ---------- 1) safe cracking: stop the needle inside the green zone, 3 pins ----------
function safe({ arena, say, end, cleanups, isDone }) {
  const PINS = 3, BASE_SPEED = 190 * HARD, STEP = 35 * HARD, BASE_W = 56 / HARD, GROW = 30 / HARD, R = 66;
  arena.innerHTML = `
    <div class="bx-pins" aria-hidden="true">${Array.from({ length: PINS }, () => `<span class="bx-pin">${icon('lock', 'l')}${icon('unlock', 'u')}</span>`).join('')}</div>
    <div class="bx-dial-wrap" id="bx-dial-wrap">
      <svg class="bx-dial" viewBox="-100 -100 200 200" aria-hidden="true">
        <defs>
          <linearGradient id="bxg-bezel" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fafafa"/><stop offset=".5" stop-color="#c7c9ce"/><stop offset="1" stop-color="#8e9098"/></linearGradient>
          <radialGradient id="bxg-face" cx=".4" cy=".35" r=".85"><stop offset="0" stop-color="#3a3a40"/><stop offset="1" stop-color="#18181b"/></radialGradient>
        </defs>
        <circle r="98" fill="url(#bxg-bezel)"/>
        <circle r="90" fill="#0e0e10"/>
        <circle r="87" fill="url(#bxg-face)"/>
        <g id="bx-ticks" stroke="#8e8e93" stroke-width="1.6" stroke-linecap="round"></g>
        <path id="bx-zone-glow" fill="none" stroke="#30d158" stroke-opacity=".28" stroke-width="19" stroke-linecap="round"/>
        <path id="bx-zone" fill="none" stroke="#30d158" stroke-width="9" stroke-linecap="round"/>
        <g id="bx-needle"><line x1="0" y1="16" x2="0" y2="-77" stroke="#ff9f0a" stroke-width="3.2" stroke-linecap="round"/><circle cy="-77" r="3.8" fill="#ff9f0a"/></g>
        <circle r="38" fill="#2a2a2e" stroke="#58585f" stroke-width="2"/>
      </svg>
      <button type="button" class="bx-dial-btn" id="bx-dial-btn">หยุด</button>
    </div>`;
  const $ = (s) => arena.querySelector(s);
  const ticks = $('#bx-ticks'), zone = $('#bx-zone'), glow = $('#bx-zone-glow'), needle = $('#bx-needle'), wrap = $('#bx-dial-wrap'), pins = [...arena.querySelectorAll('.bx-pin')], btn = $('#bx-dial-btn');
  for (let i = 0; i < 60; i++) {
    const a = i * 6 * Math.PI / 180, l = i % 5 ? 3 : 7;
    ticks.insertAdjacentHTML('beforeend', `<line x1="${(Math.sin(a) * 79).toFixed(2)}" y1="${(-Math.cos(a) * 79).toFixed(2)}" x2="${(Math.sin(a) * (79 + l)).toFixed(2)}" y2="${(-Math.cos(a) * (79 + l)).toFixed(2)}"/>`);
  }
  const pt = (d) => { const a = d * Math.PI / 180; return `${(Math.sin(a) * R).toFixed(1)} ${(-Math.cos(a) * R).toFixed(1)}`; };
  const arc = (c, w) => `M ${pt(c - w / 2)} A ${R} ${R} 0 ${w > 180 ? 1 : 0} 1 ${pt(c + w / 2)}`;
  const diff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
  let pin = 0, misses = 0, ang = rand(0, 360), speed = BASE_SPEED, center = 0, width = BASE_W, last = 0, raf = 0;
  const newZone = () => {
    center = rand(0, 360); width = BASE_W + misses * GROW;
    const d = arc(center, width); zone.setAttribute('d', d); glow.setAttribute('d', d);
    for (const el of [zone, glow]) { el.style.animation = 'none'; el.getBoundingClientRect(); el.style.animation = ''; el.classList.add('bx-zone-in'); }
  };
  newZone(); say(`กดหยุดเข็มให้ตรงโซนเขียว ${PINS} ชั้น แล้วตู้เปิด`);
  const frame = (t) => {
    if (isDone()) return;
    const dt = last ? Math.min(.05, (t - last) / 1000) : 0; last = t;
    ang = (ang + speed * dt * (pin % 2 ? -1 : 1) + 360) % 360;
    needle.setAttribute('transform', `rotate(${ang.toFixed(1)})`);
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  cleanups.push(() => cancelAnimationFrame(raf));
  const restart = (cls) => { wrap.classList.remove(cls); void wrap.offsetWidth; wrap.classList.add(cls); };
  const press = async () => {
    if (btn.disabled || isDone()) return;
    const off = diff(ang, center), hit = off <= width / 2, perfect = hit && off <= width / 6;
    if (hit || misses >= 2) {
      pins[pin].classList.add(hit ? 'ok' : 'soft'); pin++; misses = 0; speed += STEP;
      vibe(15); sfx(perfect ? 'perfect' : hit ? 'good' : 'tick'); restart('bx-pulse');
      if (hit) {
        const k = wrap.clientWidth / 200, a = center * Math.PI / 180, x = wrap.clientWidth / 2 + Math.sin(a) * R * k, y = wrap.clientWidth / 2 - Math.cos(a) * R * k;
        burst(wrap, x, y, perfect ? 14 : 8, '#30d158'); if (perfect) floaty(wrap, wrap.clientWidth / 2, wrap.clientWidth * .22, 'เป๊ะ!', '#30d158');
      }
      if (pin >= PINS) { cancelAnimationFrame(raf); say('ปลดล็อกสำเร็จ!', 'good'); btn.disabled = true; sfx('win'); wrap.classList.add('bx-opened'); await tick(700); end(); return; }
      say(hit ? `${perfect ? 'เป๊ะมาก!' : 'เยี่ยม!'} อีก ${PINS - pin} ชั้น` : `ตู้เซฟช่วยปลดให้ อีก ${PINS - pin} ชั้น`, 'good'); newZone();
    } else {
      misses++; sfx('bad'); say('พลาด! โซนกว้างขึ้นให้แล้ว ลองอีกครั้ง', 'bad'); restart('bx-shake'); vibe([30, 40, 30]); newZone();
    }
  };
  btn.addEventListener('click', press);
  const onKey = (e) => { if ((e.code === 'Space' || e.key === ' ') && e.target?.tagName !== 'BUTTON') { e.preventDefault(); press(); } };
  document.addEventListener('keydown', onKey); cleanups.push(() => document.removeEventListener('keydown', onKey));
}

// ---------- 2) target practice: 6 targets, each ~1.2s and smaller, then the crate pops ----------
function shoot({ arena, say, end, cleanups, isDone }) {
  const TOTAL = Math.round(5 * HARD), SIZE = Math.round(64 / HARD), life = (n) => Math.max(520, Math.round((1500 - n * 90) / HARD));
  arena.innerHTML = `
    <div class="bx-crate-prog"><span class="bx-prog-ic">${icon('package')}</span><div class="bx-pips" id="bx-pips">${'<i></i>'.repeat(TOTAL)}</div><span id="bx-shoot-n">0/${TOTAL}</span></div>
    <div class="bx-range" id="bx-range"></div>`;
  const range = arena.querySelector('#bx-range'), pips = [...arena.querySelectorAll('#bx-pips i')], counter = arena.querySelector('#bx-shoot-n');
  let n = 0, hits = 0, streak = 0, timer = 0, cur = null;
  const progress = (ok) => { pips[n - 1]?.classList.add(ok ? 'ok' : 'miss'); counter.textContent = `${n}/${TOTAL}`; };
  cleanups.push(() => clearTimeout(timer));
  say(`ยิงเป้าให้ทัน! ครบ ${TOTAL} เป้าลังเปิดเอง`);
  const spawn = () => {
    if (isDone()) return;
    if (n >= TOTAL) {
      say(hits >= TOTAL - 1 ? 'แม่นสุดๆ! ลังเปิดแล้ว' : hits >= Math.ceil(TOTAL / 2) ? 'แม่นมาก! ลังเปิดแล้ว' : 'ลังเปิดแล้ว!', 'good'); sfx('win');
      if (hits >= Math.ceil(TOTAL / 2)) confetti(arena.parentElement, 24); tick(650).then(end); return;
    }
    const w = range.clientWidth, h = range.clientHeight, pad = SIZE / 2 + 8, ms = life(n);
    const t = document.createElement('div');
    t.className = 'bx-target'; t.style.cssText = `left:${rand(pad, Math.max(pad + 1, w - pad)).toFixed(0)}px;top:${rand(pad, Math.max(pad + 1, h - pad)).toFixed(0)}px;--ts:${SIZE}px;--life:${ms}ms`;
    t.innerHTML = '<svg viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="48" fill="#fff" stroke="#0071e3" stroke-width="4"/><circle cx="50" cy="50" r="34" fill="#0071e3"/><circle cx="50" cy="50" r="21" fill="#fff"/><circle cx="50" cy="50" r="9" fill="#ff9f0a"/></svg>';
    range.appendChild(t); cur = t;
    const next = (hit) => {
      if (cur !== t) return; cur = null; clearTimeout(timer);
      t.classList.add(hit ? 'hit' : 'gone'); n++;
      const x = parseFloat(t.style.left), y = parseFloat(t.style.top);
      if (hit) { hits++; streak++; vibe(12); sfx('good'); burst(range, x, y, 9, '#0071e3'); floaty(range, x, y - 22, streak > 1 ? `คอมโบ x${streak}` : '+1'); }
      else { streak = 0; sfx('bad'); say('ช้าไป! เป้าหนีแล้ว', 'bad'); range.classList.remove('bx-shake'); void range.offsetWidth; range.classList.add('bx-shake'); }
      progress(hit); if (hit && n < TOTAL) say(`โดน! เหลืออีก ${TOTAL - n} เป้า`, 'good');
      setTimeout(() => t.remove(), 400); timer = setTimeout(spawn, 260);
    };
    t.addEventListener('pointerdown', (e) => { e.stopPropagation(); next(true); });
    timer = setTimeout(() => next(false), ms);
  };
  range.addEventListener('pointerdown', (e) => { // a stray tap leaves a ring (just for feel)
    const r = range.getBoundingClientRect(), ring = document.createElement('i');
    ring.className = 'bx-ring'; ring.style.left = (e.clientX - r.left) + 'px'; ring.style.top = (e.clientY - r.top) + 'px'; range.appendChild(ring); setTimeout(() => ring.remove(), 450);
  });
  timer = setTimeout(spawn, 500);
}

// ---------- 3) scratch card: rub the foil away (needs ~50% cleared, brush is smaller) or press auto ----------
function scratch({ arena, say, end, cleanups, isDone }) {
  const NEED = .42 * HARD, BRUSH = 22 / HARD;
  arena.innerHTML = `
    <div class="bx-scratch" id="bx-sc">
      <div class="bx-scratch-under"><span class="bx-scratch-q">${icon('gift')}</span></div>
      <canvas class="bx-scratch-cv" id="bx-cv"></canvas>
    </div>
    <div class="bx-scratch-prog"><div class="bx-crate-bar"><i id="bx-sc-bar"></i></div><span id="bx-sc-pct">0%</span></div>
    <button type="button" class="bx-ghost" id="bx-auto">${icon('zap')}ขูดให้อัตโนมัติ</button>`;
  const cv = arena.querySelector('#bx-cv'), box = arena.querySelector('#bx-sc'), bar = arena.querySelector('#bx-sc-bar'), pct = arena.querySelector('#bx-sc-pct');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = box.clientWidth, H = box.clientHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  const ctx = cv.getContext('2d'); ctx.scale(dpr, dpr);
  const foil = ctx.createLinearGradient(0, 0, W, H);
  foil.addColorStop(0, '#d9dce2'); foil.addColorStop(.35, '#f4f5f7'); foil.addColorStop(.62, '#b9bec7'); foil.addColorStop(1, '#e3e6ea');
  ctx.fillStyle = foil; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(0,0,0,.08)'; ctx.font = '700 13px sans-serif'; ctx.textAlign = 'center';
  for (let row = 0, y = 22; y < H + 20; y += 30, row++) for (let x = row % 2 ? 30 : 80; x < W + 40; x += 100) ctx.fillText('NUGGET', x, y);
  ctx.save(); ctx.fillStyle = 'rgba(255,255,255,.4)'; ctx.translate(W * .3, 0); ctx.rotate(.35); ctx.fillRect(0, -30, 26, H * 1.8); ctx.fillRect(46, -30, 8, H * 1.8); ctx.restore();
  ctx.globalCompositeOperation = 'destination-out';
  const sm = document.createElement('canvas'); sm.width = 48; sm.height = 32; const sctx = sm.getContext('2d', { willReadFrequently: true });
  let drawing = false, lx = 0, ly = 0, finished = false, auto = false, counter = 0;
  const pos = (e) => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) * W / r.width, (e.clientY - r.top) * H / r.height]; };
  const dot = (x, y) => { ctx.beginPath(); ctx.arc(x, y, BRUSH, 0, 7); ctx.fill(); };
  const line = (x, y) => { ctx.lineWidth = BRUSH * 2; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(x, y); ctx.stroke(); };
  const cleared = () => { // downscale the foil to 48x32 and count mostly-transparent cells (cheap, unlike reading the full canvas)
    sctx.clearRect(0, 0, 48, 32); sctx.drawImage(cv, 0, 0, 48, 32);
    const d = sctx.getImageData(0, 0, 48, 32).data; let c = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] < 128) c++;
    return c / (48 * 32);
  };
  const upd = () => { const f = cleared(), p = Math.min(100, Math.round(f / NEED * 100)); bar.style.width = p + '%'; pct.textContent = p + '%'; return f; };
  const finish = async () => {
    if (finished || isDone()) return; finished = true; cv.classList.add('done'); bar.style.width = '100%'; pct.textContent = '100%';
    say('เปิดบัตรแล้ว!', 'good'); vibe(20); sfx('win'); confetti(arena.parentElement, 24); await tick(800); end();
  };
  cv.addEventListener('pointerdown', (e) => { if (finished || auto) return; drawing = true; cv.setPointerCapture?.(e.pointerId); [lx, ly] = pos(e); dot(lx, ly); });
  cv.addEventListener('pointermove', (e) => {
    if (!drawing || finished) return; const [x, y] = pos(e); line(x, y); lx = x; ly = y;
    if (counter % 5 === 0) sfx('tick');
    if (counter % 3 === 0) { const r = box.getBoundingClientRect(); burst(box, e.clientX - r.left, e.clientY - r.top, 2, '#c7c9ce'); }
    if (++counter % 4 === 0 && upd() >= NEED) finish();
  });
  const up = () => { drawing = false; if (!finished && upd() >= NEED) finish(); };
  cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
  arena.querySelector('#bx-auto').addEventListener('click', async () => {
    if (finished || auto) return; auto = true; ctx.lineWidth = 60; ctx.lineCap = 'round';
    for (let y = 20, dir = 1; y < H + 30; y += 38, dir *= -1) { ctx.beginPath(); ctx.moveTo(dir > 0 ? -20 : W + 20, y); ctx.lineTo(dir > 0 ? W + 20 : -20, y); ctx.stroke(); upd(); sfx('tick'); await tick(60); if (isDone()) return; }
    finish();
  });
  say('ขูดฟอยล์ออกให้เห็นของข้างใต้');
}
