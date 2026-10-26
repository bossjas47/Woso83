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
  gem: '<path d="M6 3h12l4 6-10 13L2 9Z"/><path d="M11 3 8 9l4 13 4-13-3-6"/><path d="M2 9h20"/>',
  terminal: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
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
  { id: 'reel', label: 'วงล้อสุ่ม', icon: 'gift' },
  { id: 'safe', label: 'แงะตู้เซฟ', icon: 'lock' },
  { id: 'dig', label: 'ขุดสมบัติ', icon: 'gem' },
  { id: 'hack', label: 'แฮ็กรหัส', icon: 'terminal' }
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
    const seq = { good: [[660, .07], [880, .09]], bad: [[200, .16]], tick: [[1200, .03]], perfect: [[880, .06], [1175, .06], [1568, .12]], win: [[523, .09], [659, .09], [784, .09], [1047, .22]], big: [[392, .1], [523, .1], [659, .1], [784, .1], [1047, .12], [1319, .32]], boom: [[110, .3]], p0: [[523, .2]], p1: [[659, .2]], p2: [[784, .2]], p3: [[988, .2]] }[kind] || [];
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

/** @param {'reel'|'safe'|'dig'|'hack'} kind  @param {HTMLElement} arena  @param {HTMLElement} msg
 *  @param {{ pool?: Array<{label,kind,rarity,weight}>, target?: Promise<{label,kind,rarity}> }} opts  reel only: the box's prize list and the real (best) prize */
export function playGame(kind, arena, msg, opts = {}) {
  let skipFn = () => {};
  const done = new Promise((resolve) => {
    let finished = false;
    const cleanups = [];
    const end = () => { if (finished) return; finished = true; cleanups.splice(0).forEach(f => { try { f(); } catch { /* ignore */ } }); resolve(); };
    skipFn = end;
    const say = (t, cls = '') => { msg.textContent = t; msg.className = 'bx-msg ' + cls; };
    const fn = { reel, safe, dig, hack }[kind] || safe;
    arena.innerHTML = '';
    fn({ arena, say, end, cleanups, isDone: () => finished, ...opts });
  });
  return { done, skip: () => skipFn() };
}

// ---------- 0) reel: a strip of prizes spins and stops on the real prize (it only lands once the Worker has answered) ----------
const KIND_IC = { credit: 'coin', account: 'gamepad', service: 'wrench' };
const RC = { common: 'bx-r-common', rare: 'bx-r-rare', epic: 'bx-r-epic', legendary: 'bx-r-legendary' };
function reel({ arena, say, end, cleanups, isDone, pool = [], target }) {
  const items = pool.filter(p => p.weight > 0);
  const total = items.reduce((a, p) => a + p.weight, 0);
  const pick = () => { if (!items.length) return { label: '?', kind: 'gift', rarity: 'common' }; let r = Math.random() * total; for (const p of items) if ((r -= p.weight) <= 0) return p; return items[0]; };
  const cell = (p) => `<div class="bx-reel-it ${RC[p.rarity] || RC.common}">${icon(KIND_IC[p.kind] || 'gift')}<span>${String(p.label).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))}</span></div>`;
  arena.innerHTML = `<div class="bx-reel"><div class="bx-reel-strip">${Array.from({ length: 60 }, () => cell(pick())).join('')}</div><i class="bx-reel-mark"></i></div>`;
  const view = arena.querySelector('.bx-reel'), strip = arena.querySelector('.bx-reel-strip');
  const IW = strip.firstElementChild.getBoundingClientRect().width + 8; // item width + gap (css)
  const V = 1700; // px/s while waiting for the result
  let x = 0, v = 0, t0 = 0, last = 0, raf = 0, land = null, lastCell = 0, lastSnd = 0, ready = null;
  Promise.resolve(target).then(p => { ready = p || pick(); }, () => { ready = pick(); });
  say('กำลังหมุน…');
  const frame = (t) => {
    if (isDone()) return;
    t0 ||= t; const dt = last ? Math.min(.05, (t - last) / 1000) : 0; last = t;
    if (!land) {
      v = Math.min(V, v + V * 2.5 * dt); x += v * dt;
      if (x > 40 * IW) { // keep the strip short while we wait: move the first 20 cells to the end
        for (let i = 0; i < 20; i++) strip.appendChild(strip.firstElementChild);
        x -= 20 * IW;
      }
      if (ready && t - t0 > 1200 && v >= V) {
        const half = view.clientWidth / 2, idx = Math.floor((x + half) / IW) + 16;
        strip.children[idx].outerHTML = cell(ready);
        const to = idx * IW + IW / 2 - half + (Math.random() - .5) * IW * .6;
        land = { x0: x, d: to - x, T: 3 * (to - x) / V * 1000, s: t };
      }
    } else {
      const k = Math.min(1, (t - land.s) / land.T);
      x = land.x0 + land.d * (1 - Math.pow(1 - k, 3));
      if (k >= 1) {
        strip.style.transform = `translate3d(${-x}px,0,0)`;
        const won = strip.children[Math.floor((x + view.clientWidth / 2) / IW)];
        won?.classList.add('win'); vibe(30); sfx(ready.rarity === 'common' ? 'good' : 'win');
        say(`ได้ ${ready.label}!`, 'good'); setTimeout(end, 900); return;
      }
    }
    const n = Math.floor(x / IW);
    if (n !== lastCell) { lastCell = n; if (t - lastSnd > 60) { lastSnd = t; sfx('tick'); } }
    strip.style.transform = `translate3d(${-x}px,0,0)`;
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  cleanups.push(() => cancelAnimationFrame(raf));
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

// ---------- 2) dig: 12 tiles hide 3 gems, 6 digs; a number tells how many gems touch that tile ----------
function dig({ arena, say, end, cleanups, isDone }) {
  const COLS = 4, ROWS = 3, GEMS = 3, DIGS = 6;
  const gems = new Set(); while (gems.size < GEMS) gems.add(Math.floor(Math.random() * COLS * ROWS));
  const near = (i) => { let c = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const x = i % COLS + dx, y = Math.floor(i / COLS) + dy; if ((dx || dy) && x >= 0 && x < COLS && y >= 0 && y < ROWS && gems.has(y * COLS + x)) c++; } return c; };
  arena.innerHTML = `
    <div class="bx-crate-prog"><span class="bx-prog-ic">${icon('gem')}</span><div class="bx-pips">${'<i></i>'.repeat(GEMS)}</div><span id="bx-dig-n">${DIGS}</span></div>
    <div class="bx-dig" id="bx-dig">${Array.from({ length: COLS * ROWS }, (_, i) => `<button type="button" class="bx-tile" data-i="${i}" aria-label="ช่องที่ ${i + 1}"></button>`).join('')}</div>`;
  const tiles = [...arena.querySelectorAll('.bx-tile')], pips = [...arena.querySelectorAll('.bx-pips i')], left = arena.querySelector('#bx-dig-n');
  let found = 0, digs = DIGS, over = false;
  say(`ขุดหาอัญมณี ${GEMS} ชิ้น ขุดได้ ${DIGS} ครั้ง เลขในช่องคือจำนวนอัญมณีรอบๆ`);
  const finish = async () => {
    over = true; tiles.forEach(t => { t.disabled = true; });
    for (const i of gems) if (!tiles[i].classList.contains('gem')) { tiles[i].classList.add('gem', 'ghost'); tiles[i].innerHTML = icon('gem'); }
    say(found >= GEMS ? 'ครบทุกชิ้น! ลังเปิดแล้ว' : `ได้ ${found}/${GEMS} ชิ้น ลังเปิดแล้ว`, 'good'); sfx('win');
    if (found >= 2) confetti(arena.parentElement, 24);
    await tick(900); end();
  };
  arena.querySelector('#bx-dig').addEventListener('click', (e) => {
    const t = e.target.closest('.bx-tile'); if (!t || over || isDone() || t.disabled) return;
    const i = +t.dataset.i; t.disabled = true; digs--; left.textContent = digs;
    const r = arena.getBoundingClientRect(), b = t.getBoundingClientRect();
    if (gems.has(i)) { pips[found++].classList.add('ok'); t.classList.add('gem'); t.innerHTML = icon('gem'); sfx('perfect'); vibe(20); burst(arena, b.left - r.left + b.width / 2, b.top - r.top + b.height / 2, 12, '#0071e3'); say(`เจออัญมณี! ${found}/${GEMS}`, 'good'); }
    else { const n = near(i); t.classList.add('dug'); t.textContent = n || ''; sfx('tick'); say(n ? `ใกล้แล้ว มีอัญมณีติดช่องนี้ ${n} ชิ้น` : 'ไม่เจอ ช่องรอบๆ ว่างหมด'); }
    if (found >= GEMS || digs <= 0) finish();
  });
}

// ---------- 3) hack: watch the pads light up, repeat the order; 3 rounds (3/4/5 lights), 2 slips and the round opens itself ----------
function hack({ arena, say, end, isDone }) {
  const ROUNDS = [3, 4, 5], COLORS = ['#0071e3', '#7c3aed', '#b64400', '#1f9d55'];
  arena.innerHTML = `
    <div class="bx-crate-prog"><span class="bx-prog-ic">${icon('terminal')}</span><div class="bx-pips">${'<i></i>'.repeat(ROUNDS.length)}</div></div>
    <div class="bx-pads" id="bx-pads">${COLORS.map((c, i) => `<button type="button" class="bx-pad" data-p="${i}" style="--pc:${c}" aria-label="ปุ่ม ${i + 1}"></button>`).join('')}</div>`;
  const box = arena.querySelector('#bx-pads'), pads = [...box.children], pips = [...arena.querySelectorAll('.bx-pips i')];
  let round = 0, seq = [], pos = 0, misses = 0, input = false;
  const flash = (i) => { pads[i].classList.add('lit'); sfx('p' + i); setTimeout(() => pads[i].classList.remove('lit'), 360); };
  const play = async () => {
    input = false; say(`จำลำดับไฟ ${seq.length} จังหวะ`); await tick(600);
    for (const i of seq) { if (isDone()) return; flash(i); await tick(560); }
    if (isDone()) return; input = true; pos = 0; say('ตาคุณ กดตามลำดับ');
  };
  const start = () => { seq = Array.from({ length: ROUNDS[round] }, () => Math.floor(Math.random() * 4)); misses = 0; return play(); };
  const pass = async (soft) => {
    input = false; pips[round].classList.add(soft ? 'soft' : 'ok'); vibe(15);
    if (++round >= ROUNDS.length) { say('แฮ็กสำเร็จ! ลังเปิดแล้ว', 'good'); sfx('win'); await tick(900); end(); return; }
    say(soft ? 'ระบบช่วยปลดรอบนี้ให้' : 'ผ่าน! รอบต่อไป', 'good'); sfx('good'); await tick(800); if (!isDone()) start();
  };
  box.addEventListener('click', async (e) => {
    const b = e.target.closest('.bx-pad'); if (!b || !input || isDone()) return;
    const i = +b.dataset.p; flash(i);
    if (i === seq[pos]) { if (++pos >= seq.length) pass(false); return; }
    input = false; sfx('bad'); vibe([30, 40, 30]); box.classList.remove('bx-shake'); void box.offsetWidth; box.classList.add('bx-shake');
    if (++misses >= 2) return pass(true);
    say('ผิด! ดูลำดับอีกรอบ', 'bad'); await tick(900); if (!isDone()) play();
  });
  start();
}
