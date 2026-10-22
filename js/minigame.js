/* Nugget Hub — mini-games that "open" a loot box.
 * The prize is already decided by the Worker before any game starts, so skill never changes the result:
 * a game only needs to finish. Each game returns { done: Promise, skip() }. */

export const GAMES = [
  { id: 'safe', label: 'แงะตู้เซฟ', icon: '🔐' },
  { id: 'shoot', label: 'ยิงเป้า', icon: '🎯' },
  { id: 'scratch', label: 'ขูดบัตร', icon: '🎟️' }
];

const rand = (a, b) => a + Math.random() * (b - a);
const tick = (ms) => new Promise(r => setTimeout(r, ms));
const vibe = (p) => { try { navigator.vibrate?.(p); } catch { /* not supported */ } };

// ---------- feel: tiny synthesized sounds (WebAudio, no files) and a confetti burst ----------
let actx = null;
export const sfx = (kind) => {
  try {
    if (localStorage.getItem('bx-mute') === '1') return;
    actx ||= new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === 'suspended') actx.resume();
    const seq = { good: [[660, .07], [880, .09]], bad: [[200, .16]], tick: [[1200, .03]], win: [[523, .09], [659, .09], [784, .09], [1047, .22]], big: [[392, .1], [523, .1], [659, .1], [784, .1], [1047, .12], [1319, .32]], boom: [[110, .3]] }[kind] || [];
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
export function confetti(root, n = 40, colors = ['#0071e3', '#1d1d1f', '#f2c94c', '#b64400', '#1f9d55']) {
  const box = document.createElement('div'); box.className = 'bx-confetti'; root.appendChild(box);
  for (let i = 0; i < n; i++) {
    const p = document.createElement('i');
    p.style.cssText = `left:${rand(0, 100)}%;background:${colors[i % colors.length]};animation-delay:${rand(0, .5).toFixed(2)}s;animation-duration:${rand(1.6, 2.8).toFixed(2)}s;--dx:${rand(-60, 60).toFixed(0)}px;--rot:${rand(240, 900).toFixed(0)}deg;width:${rand(6, 11).toFixed(0)}px;height:${rand(8, 16).toFixed(0)}px`;
    box.appendChild(p);
  }
  setTimeout(() => box.remove(), 3600);
}
/** A "+1" that floats up from a point inside root. */
const floaty = (root, x, y, text) => { const e = document.createElement('b'); e.className = 'bx-float'; e.textContent = text; e.style.left = x + 'px'; e.style.top = y + 'px'; root.appendChild(e); setTimeout(() => e.remove(), 800); };

/** @param {'safe'|'shoot'|'scratch'} kind  @param {HTMLElement} arena  @param {HTMLElement} msg */
export function playGame(kind, arena, msg) {
  let skipFn = () => {};
  const done = new Promise((resolve) => {
    let finished = false;
    const end = () => { if (finished) return; finished = true; cleanups.splice(0).forEach(f => { try { f(); } catch { /* ignore */ } }); resolve(); };
    const cleanups = [];
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
  arena.innerHTML = `
    <div class="bx-pins"><i class="bx-pin"></i><i class="bx-pin"></i><i class="bx-pin"></i></div>
    <div class="bx-dial-wrap" id="bx-dial-wrap">
      <svg class="bx-dial" viewBox="-100 -100 200 200" aria-hidden="true">
        <circle r="94" fill="#fff" stroke="#d6d6d6" stroke-width="2"/>
        <g id="bx-ticks" stroke="#86868b" stroke-width="1.5"></g>
        <path id="bx-zone" fill="none" stroke="#1d1d1f" stroke-width="9" stroke-linecap="round"/>
        <g id="bx-needle"><line x1="0" y1="0" x2="0" y2="-80" stroke="#0071e3" stroke-width="3" stroke-linecap="round"/><circle r="5" fill="#0071e3"/></g>
      </svg>
      <button type="button" class="bx-dial-btn" id="bx-dial-btn">หยุด!</button>
    </div>`;
  const $ = (s) => arena.querySelector(s);
  const ticks = $('#bx-ticks'), zone = $('#bx-zone'), needle = $('#bx-needle'), wrap = $('#bx-dial-wrap'), pins = [...arena.querySelectorAll('.bx-pin')];
  for (let i = 0; i < 36; i++) { const a = i * 10 * Math.PI / 180, l = i % 3 ? 4 : 8; ticks.insertAdjacentHTML('beforeend', `<line x1="${Math.sin(a) * 84}" y1="${-Math.cos(a) * 84}" x2="${Math.sin(a) * (84 + l)}" y2="${-Math.cos(a) * (84 + l)}"/>`); }
  const arc = (c, w) => { const p = (d) => { const a = d * Math.PI / 180; return `${(Math.sin(a) * 72).toFixed(1)} ${(-Math.cos(a) * 72).toFixed(1)}`; }; return `M ${p(c - w / 2)} A 72 72 0 ${w > 180 ? 1 : 0} 1 ${p(c + w / 2)}`; };
  let pin = 0, misses = 0, ang = rand(0, 360), speed = 190, center = 0, width = 56, last = 0, raf = 0;
  const newZone = () => { center = rand(0, 360); width = 56 + misses * 30; zone.setAttribute('d', arc(center, width)); };
  const diff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
  newZone(); say('กดหยุดเข็มให้ตรงโซนดำ 3 ชั้น แล้วตู้เปิด');
  const frame = (t) => {
    if (isDone()) return;
    const dt = last ? Math.min(.05, (t - last) / 1000) : 0; last = t;
    ang = (ang + speed * dt * (pin % 2 ? -1 : 1) + 360) % 360;
    needle.setAttribute('transform', `rotate(${ang.toFixed(1)})`);
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  cleanups.push(() => cancelAnimationFrame(raf));
  const btn = $('#bx-dial-btn');
  const press = async () => {
    if (btn.disabled || isDone()) return;
    const hit = diff(ang, center) <= width / 2;
    if (hit || misses >= 2) {
      pins[pin].classList.add(hit ? 'ok' : 'soft'); pin++; misses = 0; speed += 35; vibe(15); sfx(hit ? 'good' : 'tick'); wrap.classList.remove('bx-pulse'); void wrap.offsetWidth; wrap.classList.add('bx-pulse');
      if (pin >= 3) { cancelAnimationFrame(raf); say('ปลดล็อกสำเร็จ!', 'good'); btn.disabled = true; sfx('win'); wrap.classList.add('bx-opened'); await tick(650); end(); return; }
      say(hit ? 'เยี่ยม! อีก ' + (3 - pin) + ' ชั้น' : 'ตู้เซฟช่วยปลดให้ อีก ' + (3 - pin) + ' ชั้น', 'good'); newZone();
    } else {
      misses++; sfx('bad'); say('พลาด! โซนกว้างขึ้นให้แล้ว ลองอีกครั้ง', 'bad'); wrap.classList.remove('bx-shake'); void wrap.offsetWidth; wrap.classList.add('bx-shake'); vibe([30, 40, 30]); newZone();
    }
  };
  btn.addEventListener('click', press);
}

// ---------- 2) target practice: 5 targets, each ~1.5s, then the crate pops ----------
function shoot({ arena, say, end, cleanups, isDone }) {
  const TOTAL = 5;
  arena.innerHTML = `
    <div class="bx-crate-prog"><span>📦</span><div class="bx-crate-bar"><i></i></div><span id="bx-shoot-n">0/${TOTAL}</span></div>
    <div class="bx-range" id="bx-range"></div>`;
  const range = arena.querySelector('#bx-range'), bar = arena.querySelector('.bx-crate-bar i'), counter = arena.querySelector('#bx-shoot-n');
  let n = 0, hits = 0, timer = 0, cur = null;
  const progress = () => { bar.style.width = (n / TOTAL * 100) + '%'; counter.textContent = `${n}/${TOTAL}`; };
  cleanups.push(() => clearTimeout(timer));
  say('ยิงเป้าให้ทัน! ครบ 5 เป้าลังเปิดเอง');
  const spawn = () => {
    if (isDone()) return;
    if (n >= TOTAL) { say(hits >= 3 ? 'แม่นมาก! ลังเปิดแล้ว' : 'ลังเปิดแล้ว!', 'good'); sfx('win'); confetti(arena.parentElement, 24); tick(600).then(end); return; }
    const w = range.clientWidth, h = range.clientHeight;
    const t = document.createElement('div');
    t.className = 'bx-target'; t.style.left = rand(46, Math.max(60, w - 46)) + 'px'; t.style.top = rand(46, Math.max(60, h - 46)) + 'px';
    range.appendChild(t); cur = t;
    const next = (hit) => {
      if (cur !== t) return; cur = null; clearTimeout(timer);
      t.classList.add(hit ? 'hit' : 'gone'); n++; if (hit) { hits++; vibe(12); sfx('good'); floaty(range, parseFloat(t.style.left), parseFloat(t.style.top) - 20, hits > 1 ? `คอมโบ x${hits}` : '+1'); } else sfx('bad'); progress();
      setTimeout(() => t.remove(), 400); timer = setTimeout(spawn, 260);
    };
    t.addEventListener('pointerdown', (e) => { e.stopPropagation(); next(true); });
    timer = setTimeout(() => next(false), 1500 - n * 90);
  };
  range.addEventListener('pointerdown', (e) => { // a stray tap leaves a ring (just for feel)
    const r = range.getBoundingClientRect(), ring = document.createElement('i');
    ring.className = 'bx-ring'; ring.style.left = (e.clientX - r.left) + 'px'; ring.style.top = (e.clientY - r.top) + 'px'; range.appendChild(ring); setTimeout(() => ring.remove(), 450);
  });
  timer = setTimeout(spawn, 500);
}

// ---------- 3) scratch card: rub the foil away (or press auto) ----------
function scratch({ arena, say, end, cleanups, isDone }) {
  arena.innerHTML = `
    <div class="bx-scratch">
      <div class="bx-scratch-under"><span class="bx-scratch-q">?</span></div>
      <canvas class="bx-scratch-cv" id="bx-cv"></canvas>
    </div>
    <button type="button" class="bx-ghost" id="bx-auto">ขูดให้อัตโนมัติ</button>`;
  const cv = arena.querySelector('#bx-cv'), box = arena.querySelector('.bx-scratch');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = box.clientWidth, H = box.clientHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  const ctx = cv.getContext('2d'); ctx.scale(dpr, dpr);
  ctx.fillStyle = '#d6d6d6'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#86868b'; ctx.font = '600 14px sans-serif'; ctx.textAlign = 'center';
  for (let y = 24; y < H; y += 34) for (let x = (y / 34) % 2 ? 40 : 90; x < W; x += 100) ctx.fillText('NUGGET', x, y);
  ctx.globalCompositeOperation = 'destination-out';
  let drawing = false, lx = 0, ly = 0, finished = false, counter = 0;
  const pos = (e) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const dot = (x, y) => { ctx.beginPath(); ctx.arc(x, y, 22, 0, 7); ctx.fill(); };
  const line = (x, y) => { ctx.lineWidth = 44; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(x, y); ctx.stroke(); };
  const cleared = () => { // sample the alpha channel on a coarse grid
    const d = ctx.getImageData(0, 0, cv.width, cv.height).data; let c = 0, t = 0;
    for (let i = 3; i < d.length; i += 4 * 97) { t++; if (d[i] < 40) c++; }
    return c / t;
  };
  const finish = async () => {
    if (finished || isDone()) return; finished = true; cv.classList.add('done'); say('เปิดบัตรแล้ว!', 'good'); vibe(20); sfx('win'); confetti(arena.parentElement, 24); await tick(750); end();
  };
  cv.addEventListener('pointerdown', (e) => { drawing = true; cv.setPointerCapture?.(e.pointerId); [lx, ly] = pos(e); dot(lx, ly); });
  cv.addEventListener('pointermove', (e) => {
    if (!drawing || finished) return; const [x, y] = pos(e); line(x, y); lx = x; ly = y; if (counter % 5 === 0) sfx('tick');
    if (++counter % 6 === 0 && cleared() > .42) finish();
  });
  const up = () => { drawing = false; if (!finished && cleared() > .42) finish(); };
  cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
  arena.querySelector('#bx-auto').addEventListener('click', async () => {
    if (finished) return; ctx.lineWidth = 60; ctx.lineCap = 'round';
    for (let y = 20, dir = 1; y < H + 30; y += 38, dir *= -1) { ctx.beginPath(); ctx.moveTo(dir > 0 ? -20 : W + 20, y); ctx.lineTo(dir > 0 ? W + 20 : -20, y); ctx.stroke(); await tick(60); if (isDone()) return; }
    finish();
  });
  say('ขูดฟอยล์ออกให้เห็นของข้างใต้');
}
