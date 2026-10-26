import { db, auth } from "../firebase-config.js";
import { collection, doc, getDoc, onSnapshot, query, where, orderBy, limit } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { esc, num, money, toast, callWorker, openModal, closeModal, onSettings, timeAgo, tsDate } from "./ui.js";
import { GAMES, playGame, sfx, confetti, icon } from "./minigame.js";

const MIN_COUNT = 1, MAX_COUNT = 10, QUICK = [1, 2, 3, 5, 10];
const RARITY = {
  common: ['ทั่วไป', 'bx-r-common'], rare: ['หายาก', 'bx-r-rare'], epic: ['เอพิค', 'bx-r-epic'], legendary: ['ตำนาน', 'bx-r-legendary']
};
const RANK = { common: 0, rare: 1, epic: 2, legendary: 3 };
const KIND_ICON = { credit: 'coin', account: 'gamepad', service: 'wrench' };
const rar = (r) => RARITY[r] || RARITY.common;
const rank = (r) => RANK[r] ?? 0;
const kIcon = (k) => icon(KIND_ICON[k] || 'gift');
const CRATE = `<svg viewBox="0 0 120 120" fill="none" stroke="#1d1d1f" stroke-width="3" stroke-linejoin="round" aria-hidden="true"><rect x="14" y="44" width="92" height="60" rx="8"/><rect x="10" y="28" width="100" height="18" rx="6"/><path d="M60 28v76"/><rect x="52" y="48" width="16" height="16" rx="4" fill="#fff"/></svg>`;

const $ = (id) => document.getElementById(id);
const show = (el, on) => { if (el) el.style.display = on ? '' : 'none'; }; // style.display, not classList.hidden: .bx-chip/.bx-winners set their own display and beat Tailwind's .hidden
const read = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } };
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const clamp = (n) => Math.min(MAX_COUNT, Math.max(MIN_COUNT, Math.round(Number(n)) || MIN_COUNT));

const GIFT_CODE = new URLSearchParams(location.search).get('gift') || '';
let GIFT = null, MYGIFTS = [], unsubGifts = null; // GIFT = the ticket opened from a ?gift= link, MYGIFTS = tickets I sent
const giftLeft = (g) => (g && g.status === 'open' && num(g.left) > 0 && num(g.expiresAt) > Date.now() ? num(g.left) : 0);
const giftUrl = (g) => `${location.origin}${location.pathname}?id=${encodeURIComponent(g.boxId)}&gift=${encodeURIComponent(g.id)}`;
const WON = {}; // prizes won in this visit, so the claim form works before the history snapshot arrives
let PITY = {}, unsubPity = null, BOXES = [], OPENS = [], uid = '', balance = null, busy = false, game = 'reel', count = 1, skipAnim = false, runId = 0, lastN = 1, claimSelf = false, dirtyBoxes = false, unsubUser = null, unsubOpens = null, skipCurrent = null;
const g0 = read('bx-game'); if (GAMES.some(x => x.id === g0)) game = g0;
const a0 = read('bx-skip-anim'); skipAnim = a0 === null ? !!window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches : a0 === '1';

// ---------- list ----------
const prizeIcon = (p) => `<span class="bx-prize-img">${kIcon(p.kind)}</span>`;
function prizeLabel(p) {
  if (p.label) return p.label;
  if (p.kind === 'credit') return `เครดิต ${money(p.amount, 0)}฿`;
  return (p.kind === 'service' ? 'งานบริการ' : 'ไอดีเกม');
}
const FOCUS = new URLSearchParams(location.search).get('id') || '';
const artHtml = (b) => b.image ? `<img src="${esc(b.image)}" alt="${esc(b.name)}" onerror="this.outerHTML=window.__bxCrate">` : CRATE;
const pct = (w, total) => { const v = Math.max(0, num(w)) / total * 100; return v.toFixed(v < 10 ? 2 : 1); };
function prizeRows(b) {
  const ps = (b.prizes || []).slice().sort((x, y) => num(x.weight) - num(y.weight)); // rarest first
  const total = ps.reduce((a, p) => a + Math.max(0, num(p.weight)), 0) || 1;
  return ps.map(p => `<div class="bx-prize ${rar(p.rarity)[1]}">${prizeIcon(p)}
    <div class="min-w-0 flex-1"><p class="font-medium truncate">${esc(prizeLabel(p))}${p.qty > 1 ? ` × ${p.qty}` : ''}</p>
      <p class="bx-rarity">${rar(p.rarity)[0]}</p>${b.showOdds === false ? '' : `<span class="bx-bar"><i style="width:${pct(p.weight, total)}%"></i></span>`}</div>
    ${b.showOdds === false ? '' : `<span class="bx-odds">${pct(p.weight, total)}%</span>`}</div>`).join('');
}
const curBox = () => BOXES.find(x => x.id === FOCUS && x.active !== false);

function buyPanel(b) {
  return `<div class="bx-buy" id="bx-buy">
    <div><p class="bx-label">เลือกวิธีเปิด</p><div class="bx-games" role="group" aria-label="เลือกมินิเกม">${GAMES.map(g => `<button type="button" class="bx-game-btn ${g.id === game ? 'on' : ''}" data-game="${g.id}">${icon(g.icon)}<span>${g.label}</span></button>`).join('')}</div></div>
    <div><p class="bx-label">จำนวนกล่อง (${MIN_COUNT}–${MAX_COUNT})</p>
      <div class="bx-qty">
        <div class="bx-stepper" role="group" aria-label="จำนวนกล่อง">
          <button type="button" data-qty="-1" aria-label="ลดจำนวน">${icon('minus')}</button>
          <input id="bx-qty" type="number" inputmode="numeric" min="${MIN_COUNT}" max="${MAX_COUNT}" value="${count}" aria-label="จำนวนกล่องที่ต้องการเปิด">
          <button type="button" data-qty="1" aria-label="เพิ่มจำนวน">${icon('plus')}</button>
        </div>
        <div class="bx-chips" role="group" aria-label="เลือกจำนวนด่วน">${QUICK.map(n => `<button type="button" class="bx-qchip" data-qset="${n}">${n}</button>`).join('')}</div>
      </div></div>
    <label class="bx-check"><input type="checkbox" class="bx-cb" id="bx-skipanim"><span>ข้ามอนิเมชั่น (สุ่มเลย ไม่ต้องเล่นมินิเกม)</span></label>
    <p class="bx-sum" id="bx-sum"></p>
    <button type="button" class="bx-open" data-buy="${esc(b.id)}"></button>
    ${uid ? `<button type="button" class="bx-giftbtn" data-giftsend="${esc(b.id)}">🎁 ส่งเป็นของขวัญให้เพื่อน</button>` : ''}
  </div>`;
}
/** Update the buy panel in place (never re-render it: that would drop focus in the number box and reload the image). */
function refreshBuy() {
  const b = curBox(), root = $('bx-buy'); if (!b || !root) return;
  const total = num(b.price) * count, afford = balance === null || balance >= total;
  const q = $('bx-qty'); if (q) { if (document.activeElement !== q) q.value = String(count); q.disabled = busy; }
  root.querySelector('[data-qty="-1"]').disabled = busy || count <= MIN_COUNT;
  root.querySelector('[data-qty="1"]').disabled = busy || count >= MAX_COUNT;
  root.querySelectorAll('[data-qset]').forEach(x => { x.classList.toggle('on', Number(x.dataset.qset) === count); x.disabled = busy; });
  const cb = $('bx-skipanim'); if (cb) { cb.checked = skipAnim; cb.disabled = busy; }
  root.querySelector('.bx-games')?.classList.toggle('is-off', skipAnim);
  const lines = [];
  if (num(b.pityEvery) > 1) {
    const ev = num(b.pityEvery), miss = Math.min(num(PITY[b.id]), ev - 1), name = RARITY[b.pityRarity]?.[0] || RARITY.epic[0];
    lines.push(`<span class="block text-[11px] mb-1">${miss >= ev - 1 ? `🎯 ครั้งนี้การันตี <b>${name}</b> ขึ้นไป` : `อีก <b>${ev - 1 - miss}</b> ครั้ง การันตี <b>${name}</b> ขึ้นไป`}</span><span class="block" style="height:6px;border-radius:3px;background:rgba(128,128,128,.25);overflow:hidden"><i style="display:block;height:100%;width:${Math.round(miss / (ev - 1) * 100)}%;background:#f5a623"></i></span>`);
  }
  if (count > 1) lines.push(`${count} กล่อง × ฿${money(b.price, 0)} = <b>฿${money(total, 0)}</b>`);
  if (uid && balance !== null && balance < total) lines.push(`ต้องเติมอีก <b>฿${money(total - balance, 0)}</b> · <a href="topup.html" class="text-appleBlue">เติมเงิน</a>`);
  $('bx-sum').innerHTML = lines.join('<br>');
  const btn = root.querySelector('.bx-open');
  btn.classList.toggle('is-off', !!uid && !afford); btn.disabled = busy;
  btn.textContent = !uid ? 'เข้าสู่ระบบเพื่อเปิด' : !afford ? 'ยอดเงินไม่พอ' : `เปิด ${count > 1 ? `${count} กล่อง` : 'กล่อง'} ฿${money(total, 0)}`;
}
function renderBoxes() {
  const wrap = $('box-list'); if (!wrap) return;
  const list = BOXES.filter(b => b.active !== false);
  const b = list.find(x => x.id === FOCUS);
  show($('box-head'), !b);
  if (b) {
    document.title = `${b.name} — Nugget Hub`;
    const others = list.filter(x => x.id !== b.id);
    wrap.innerHTML = `${GIFT && GIFT.boxId === b.id && giftLeft(GIFT) ? `<div class="bx-gift"><span>🎁 <b>${esc(GIFT.fromName || 'เพื่อน')}</b> ส่งตั๋วเปิดกล่อง <b>${esc(GIFT.boxName)}</b> ให้คุณ ${giftLeft(GIFT)} ใบ</span><button type="button" class="bx-pill" data-giftopen="${esc(GIFT.id)}">เปิดเลย</button></div>` : ''}<section class="bx-hero">
        <div class="bx-hero-art">${artHtml(b)}</div>
        <div class="bx-hero-info">
          <p class="bx-kicker">กล่องสุ่ม · ${(b.prizes || []).length} รางวัล</p>
          <h1 class="bx-name">${esc(b.name)}</h1>
          ${b.desc ? `<p class="bx-desc">${esc(b.desc)}</p>` : ''}
          <p class="bx-price">฿${money(b.price, 0)} <span>ต่อกล่อง</span></p>
          ${buyPanel(b)}
          <p class="bx-fine">ระบบสุ่มผลไว้ก่อนเริ่มมินิเกม ฝีมือไม่มีผลกับของที่ได้ · เปิดหลายกล่องเล่นมินิเกมครั้งเดียวต่อชุด · เปิดแล้วไม่คืนเงิน</p>
        </div>
      </section>
      <section class="bx-band"><h2 class="bx-h2">ของรางวัลในกล่อง</h2><div class="bx-panel bx-prizes">${prizeRows(b)}</div></section>
      ${others.length ? `<section class="mt-12"><h2 class="bx-h2">กล่องอื่น</h2><div class="bx-others">${others.map(o => `<a class="bx-mini" href="?id=${encodeURIComponent(o.id)}"><span class="bx-mini-art">${artHtml(o)}</span><span class="font-semibold">${esc(o.name)}</span><span class="text-sm text-slate">฿${money(o.price, 0)}</span></a>`).join('')}</div></section>` : ''}`;
    refreshBuy();
    return;
  }
  document.title = 'กล่องสุ่ม — Nugget Hub';
  if (!list.length) { wrap.innerHTML = '<div class="text-center text-slate py-16">ตอนนี้ยังไม่มีกล่องให้เปิด เดี๋ยวแอดมินเติมของ แวะมาใหม่นะ</div>'; return; }
  wrap.innerHTML = `<div class="bx-others">${list.map(o => `<a class="bx-mini" href="?id=${encodeURIComponent(o.id)}"><span class="bx-mini-art">${artHtml(o)}</span><span class="font-semibold">${esc(o.name)}</span><span class="text-sm text-slate">฿${money(o.price, 0)} · ${(o.prizes || []).length} รางวัล</span></a>`).join('')}</div>`;
}
window.__bxCrate = CRATE;

function renderBalance() {
  const el = $('box-balance'); if (!el) return;
  show(el, balance !== null);
  el.innerHTML = balance === null ? '' : `คงเหลือ <b>${money(balance, 0)}฿</b> <a href="topup.html" class="text-appleBlue">เติมเงิน</a>`;
}

function renderWinners(rows) {
  const el = $('box-winners'); if (!el) return;
  show(el, rows.length > 0);
  el.innerHTML = rows.map(w => `<span class="bx-chip ${rar(w.rarity)[1]}"><i class="bx-dot"></i>${esc(w.buyerMask || 'ผู้เล่น')} ได้ <b>${esc(w.prizeLabel)}</b></span>`).join('');
}

function renderHistory() {
  const el = $('box-history'); if (!el) return;
  if (!uid) { el.innerHTML = '<p class="text-slate text-sm">เข้าสู่ระบบเพื่อดูประวัติ</p>'; return; }
  if (!OPENS.length) { el.innerHTML = '<p class="text-slate text-sm">ยังไม่เคยเปิดกล่อง</p>'; return; }
  el.innerHTML = OPENS.slice(0, 30).map(o => `<div class="bx-hist-row ${rar(o.rarity)[1]}">
      <span class="bx-hist-ic">${kIcon(o.kind)}</span>
      <div class="min-w-0 flex-1"><p class="font-medium truncate">${esc(o.prizeLabel)}</p><p class="text-xs text-slate">${esc(o.boxName)} · ${money(o.price, 0)}฿ · ${timeAgo(o.createdAt)}</p></div>
      ${o.status === 'pending_claim' ? `<button type="button" class="bx-pill" data-claim="${esc(o.id)}">รับรางวัล</button>` : `<span class="text-xs text-slate">${o.status === 'claimed' ? 'รับแล้ว' : 'ได้รับแล้ว'}</span>`}
    </div>`).join('');
}

// ---------- opening ----------
const stage = () => $('bx-stage');

function renderMute() {
  const el = $('bx-mute'); if (!el) return;
  const m = read('bx-mute') === '1';
  el.innerHTML = icon(m ? 'mute' : 'volume'); el.setAttribute('aria-pressed', String(m)); el.setAttribute('aria-label', m ? 'เปิดเสียง' : 'ปิดเสียง');
}

function prizeSub(p, long) {
  if (p.kind === 'credit') return long ? 'เครดิตเข้ากระเป๋าแล้ว เอาไปช้อปต่อได้เลย' : 'เครดิตเข้ากระเป๋าแล้ว';
  const name = p.productName ? `<b>${esc(p.productName)}</b>${p.kind === 'service' && p.qty > 1 ? ` × ${p.qty}` : ''}` : '';
  if (p.kind === 'account') return long ? `ไอดีเกมถูกส่งไปที่ “ออเดอร์ของฉัน” แล้ว${name ? `<br>${name}` : ''}` : (name || 'ส่งไปที่ออเดอร์ของฉันแล้ว');
  return `${name ? `${name}<br>` : ''}${long ? 'กรอกข้อมูลรับรางวัลเพื่อเข้าคิวงาน' : 'กรอกข้อมูลเพื่อเข้าคิวงาน'}`;
}
function cardHtml(p, i, n, open) {
  const [rl, rc] = rar(p.rarity);
  const act = p.needsClaim && p.openId ? `<button type="button" class="bx-btn main sm" data-rv="claim" data-oid="${esc(p.openId)}">กรอกข้อมูลรับรางวัล</button>` : '';
  return `<article class="bx-rc ${rc}${open ? ' is-open instant' : ''}" style="--i:${i}">
    <div class="bx-rc-inner">
      <div class="bx-rc-back">${icon('package')}</div>
      <div class="bx-rc-front">
        <span class="bx-rc-badge">${rank(p.rarity) >= 2 ? icon('star') : ''}${rl}</span>
        <div class="bx-rc-icon">${kIcon(p.kind)}</div>
        <h3 class="bx-rc-name">${esc(p.label)}</h3>
        <p class="bx-rc-sub">${prizeSub(p, n === 1)}</p>${act}
      </div>
    </div></article>`;
}

/** Suspense scene between the game and the prize cards: the crate shakes and glows; rarer prizes wait longer. */
async function suspense(best, n, alive) {
  const r = $('bx-reveal'), [, rc] = rar(best);
  r.className = `bx-reveal on susp ${rc}`;
  r.innerHTML = `<div class="bx-susp"><div class="bx-crate">${icon('package')}${n > 1 ? `<b class="bx-crate-n">×${n}</b>` : ''}</div><p class="bx-susp-t">${n > 1 ? `กำลังเปิด ${n} กล่อง…` : 'กำลังเปิดลัง…'}</p><div class="bx-susp-dots"><i></i><i></i><i></i></div></div>`;
  sfx('boom'); try { navigator.vibrate?.(best === 'common' ? [40] : [40, 60, 40, 60, 120]); } catch { /* ignore */ }
  await wait(({ common: 1100, rare: 1500, epic: 1900, legendary: 2500 }[best] || 1200) + (n > 1 ? 300 : 0));
  if (!alive()) return false;
  r.classList.add('flash'); await wait(220);
  return alive();
}

/** Prize cards: one big card for a single box, a grid of flip cards for 2–10. With anim=false everything is shown at once. */
async function showResults(prizes, boxId, anim, alive) {
  const n = prizes.length, r = $('bx-reveal');
  const order = prizes.map((_, i) => i).sort((a, b) => rank(prizes[a].rarity) - rank(prizes[b].rarity) || a - b); // worst left, best right
  const best = prizes[order[n - 1]].rarity;
  const counts = {}; prizes.forEach(p => { const k = RARITY[p.rarity] ? p.rarity : 'common'; counts[k] = (counts[k] || 0) + 1; });
  const chips = ['legendary', 'epic', 'rare', 'common'].filter(k => counts[k]).map(k => `<span class="bx-chip ${RARITY[k][1]}"><i class="bx-dot"></i>${RARITY[k][0]} ×${counts[k]}</span>`).join('');
  const head = n > 1 ? `<div class="bx-rv-head"><p class="bx-rv-kicker">เปิดครบ ${n} กล่อง</p><h2 class="bx-rv-title">ได้ของ ${n} ชิ้น</h2><div class="bx-rv-chips">${chips}</div></div>` : '';
  r.className = `bx-reveal on ${rar(best)[1]}`;
  r.innerHTML = `<div class="bx-rv-wrap">${head}<div class="bx-rv-grid ${n === 1 ? 'one' : ''}" id="bx-row">${order.map(i => cardHtml(prizes[i], i, n, !anim)).join('')}</div>${n > 4 ? '<p class="bx-rv-hint">เลื่อนดูได้ทั้งหมด ‹ › · ของดีที่สุดอยู่ขวาสุด</p>' : ''}<div class="bx-rv-actions" id="bx-actions" style="display:none"></div></div>`;
  r.dataset.box = boxId; r.dataset.n = String(lastN); r.scrollTop = 0;
  const els = [...r.querySelectorAll('.bx-rc')], row = $('bx-row');
  const center = (el, smooth) => row.scrollTo({ left: el.offsetLeft - (row.clientWidth - el.offsetWidth) / 2, behavior: smooth ? 'smooth' : 'auto' });
  const SFX = n === 1 ? { common: 'good', rare: 'win', epic: 'big', legendary: 'big' } : { common: 'tick', rare: 'good', epic: 'win', legendary: 'big' };
  if (anim) {
    let skipped = false; skipCurrent = () => { skipped = true; }; show($('bx-skip'), true);
    await wait(350);
    const step = n === 1 ? 0 : Math.min(420, Math.round(2400 / n));
    for (let k = 0; k < els.length; k++) { // worst first (left), best last (right)
      if (!alive()) return;
      const p = prizes[order[k]];
      if (!skipped) center(els[k], true);
      els[k].classList.add('is-open');
      if (!skipped) {
        sfx(SFX[p.rarity] || 'tick');
        const cnt = { rare: n === 1 ? 36 : 0, epic: n === 1 ? 60 : 36, legendary: n === 1 ? 100 : 80 }[p.rarity] || 0;
        if (cnt) confetti(r, cnt, p.rarity === 'legendary' ? ['#f2c94c', '#b64400', '#1d1d1f', '#fff'] : undefined);
        if (step) await wait(step);
      }
    }
    if (!skipped) await wait(n === 1 ? 700 : 450);
    skipCurrent = null; show($('bx-skip'), false);
  } else { sfx(SFX[best] || 'good'); center(els[n - 1]); }
  if (!alive()) return;
  const b = BOXES.find(x => x.id === boxId), again = b ? num(b.price) * lastN : 0, hasAcc = prizes.some(p => p.kind === 'account');
  let againHtml = '';
  if (b) againHtml = (balance === null || balance >= again) ? `<button type="button" class="bx-btn ${hasAcc ? 'sub' : 'main'}" data-rv="again">เปิดอีก ${lastN > 1 ? `${lastN} กล่อง ` : ''}฿${money(again, 0)}</button>` : `<a class="bx-btn sub" href="topup.html">ยอดเงินไม่พอ · เติมเงิน</a>`;
  const act = $('bx-actions');
  act.innerHTML = `${hasAcc ? '<a class="bx-btn main" href="account.html#orders">ดูไอดีของฉัน</a>' : ''}${againHtml}<button type="button" class="bx-btn sub" data-rv="close">ปิด</button>`;
  show(act, true); show($('bx-close'), true);
}

function openStage(title) {
  const s = stage(), r = $('bx-reveal'), m = $('bx-msg');
  document.body.style.overflow = 'hidden';
  $('bx-stage-title').textContent = title;
  r.className = 'bx-reveal'; r.innerHTML = '';
  $('bx-arena').innerHTML = '<div class="bx-spin" role="status" aria-label="กำลังโหลด"></div>';
  m.textContent = ''; m.className = 'bx-msg';
  show($('bx-close'), false); show($('bx-skip'), false);
  s.classList.add('on'); s.focus?.();
}
function closeStage() {
  runId++; skipCurrent = null;
  stage().classList.remove('on');
  const r = $('bx-reveal'); r.className = 'bx-reveal'; r.innerHTML = '';
  $('bx-arena').innerHTML = ''; document.body.style.overflow = '';
}

async function sendGift(id) {
  const b = BOXES.find(x => x.id === id), n = clamp(count); if (!b || busy) return;
  if (balance !== null && balance < num(b.price) * n) return toast('ยอดเงินไม่พอ กรุณาเติมเงินก่อน', 'error');
  if (!confirm(`ซื้อตั๋วของขวัญ ${b.name} ${n} ใบ ราคา ฿${money(num(b.price) * n, 0)}?\nส่งลิงก์ให้เพื่อนกดเปิดเองได้ ถ้าไม่มีใครรับ ยกเลิกเพื่อคืนเครดิตได้`)) return;
  try {
    const r = await callWorker('/box/gift', { boxId: id, count: n });
    if (typeof r.balance === 'number') { balance = r.balance; renderBalance(); refreshBuy(); }
    const link = giftUrl({ boxId: id, id: r.code });
    try { await navigator.clipboard.writeText(link); toast('ซื้อตั๋วแล้ว คัดลอกลิงก์ให้แล้ว ส่งให้เพื่อนได้เลย', 'success'); } catch { prompt('คัดลอกลิงก์ของขวัญนี้ส่งให้เพื่อน', link); }
  } catch (e) { toast(e.message || 'ซื้อตั๋วไม่สำเร็จ', 'error'); }
}
async function cancelGift(code) {
  if (!confirm('ยกเลิกตั๋วใบที่ยังไม่ได้ใช้ และคืนเครดิต?')) return;
  try { const r = await callWorker('/box/gift/cancel', { code }); toast(`คืนเครดิต ฿${money(r.refund, 0)} แล้ว`, 'success'); } catch (e) { toast(e.message || 'ยกเลิกไม่สำเร็จ', 'error'); }
}
function renderGifts() {
  const el = $('box-gifts'); if (!el) return;
  const mine = MYGIFTS.filter(g => giftLeft(g)).sort((a, b) => num(b.expiresAt) - num(a.expiresAt));
  el.innerHTML = mine.length ? `<p class="text-sm text-slate mb-2">ตั๋วของขวัญที่ฉันส่งและยังไม่มีใครใช้</p>` + mine.map(g => `<div class="bx-hist-row"><span class="bx-hist-ic">🎁</span><div class="min-w-0 flex-1"><p class="font-medium truncate">${esc(g.boxName)} · เหลือ ${giftLeft(g)}/${num(g.count)} ใบ</p><p class="text-xs text-slate">หมดอายุ ${new Date(num(g.expiresAt)).toLocaleDateString('th-TH', { dateStyle: 'medium' })}</p></div><button type="button" class="bx-pill" data-giftcopy="${esc(g.id)}">คัดลอกลิงก์</button> <button type="button" class="bx-pill" style="background:#86868b" data-giftcancel="${esc(g.id)}">ยกเลิก</button></div>`).join('') : '';
}
async function loadGift() {
  if (!GIFT_CODE || !uid || !/^[\w-]{10,40}$/.test(GIFT_CODE)) return;
  try { const s = await getDoc(doc(db, 'box_gifts', GIFT_CODE)); GIFT = s.exists() ? { ...s.data(), id: s.id } : null; } catch { GIFT = null; }
  if (GIFT && !giftLeft(GIFT)) toast('ตั๋วของขวัญใบนี้ใช้ครบ หมดอายุ หรือถูกยกเลิกแล้ว', 'info');
  if (!busy) renderBoxes();
}
function setCount(n) { count = clamp(n); refreshBuy(); }

async function openBox(id, n = count, giftCode = '') {
  if (busy) return;
  const b = BOXES.find(x => x.id === id); if (!b) return;
  if (!uid) { location.href = 'login.html?mode=login&next=' + encodeURIComponent(location.pathname + location.search); return; } // keep ?id= so the person lands back on this box
  n = clamp(n);
  if (!giftCode && balance !== null && balance < num(b.price) * n) { toast('ยอดเงินไม่พอ กรุณาเติมเงินก่อน', 'error'); return; }
  busy = true; lastN = n; refreshBuy();
  const my = ++runId, alive = () => my === runId, anim = !skipAnim;
  openStage(`${b.name}${n > 1 ? ` · ${n} กล่อง` : ''}${anim ? ` · ${GAMES.find(g => g.id === game)?.label || ''}` : ''}`);
  const prizes = []; let err = null, at = 0, gameOn = false, gotFirst;
  const first = new Promise(r => { gotFirst = r; });
  const progress = () => { if (!gameOn && alive()) $('bx-msg').textContent = n > 1 ? `กำลังสุ่มกล่องที่ ${Math.min(at + 1, n)}/${n}…` : 'กำลังสุ่ม…'; };
  // one /box/open call per box (each is charged and recorded on its own); the game starts as soon as the first box is paid
  const all = (async () => {
    for (; at < n; at++) {
      progress();
      let res;
      try { res = await callWorker('/box/open', giftCode ? { boxId: id, giftCode } : { boxId: id }); } catch (e) { err = e; break; }
      if (typeof res?.balance === 'number') { balance = res.balance; renderBalance(); }
      const p = res?.prize;
      if (!p) { err = new Error('ไม่พบผลรางวัล'); break; }
      prizes.push(p); gotFirst(true);
      if (p.openId) WON[p.openId] = { prizeLabel: p.label, productName: p.productName, qty: p.qty, claimMode: p.claimMode };
    }
    gotFirst(false);
  })();
  const bestOf = () => prizes.reduce((a, p) => rank(p.rarity) > rank(a.rarity) ? p : a, prizes[0]);
  try {
    if (!(await first)) { await all; if (alive()) closeStage(); toast(err?.message || 'เปิดกล่องไม่สำเร็จ', 'error'); return; }
    if (anim && alive()) {
      show($('bx-skip'), true); gameOn = true;
      const pool = (b.prizes || []).map(p => ({ label: prizeLabel(p), kind: p.kind, rarity: p.rarity, weight: num(p.weight) }));
      const g = playGame(game, $('bx-arena'), $('bx-msg'), { pool, target: all.then(bestOf) }); skipCurrent = g.skip;
      await g.done; skipCurrent = null; show($('bx-skip'), false); gameOn = false;
      if (at < n && !err) progress();
    }
    await all;
    if (err) toast(`สุ่มสำเร็จ ${prizes.length}/${n} กล่อง — ${err.message || 'เกิดข้อผิดพลาด'} ตรวจยอดเงินและประวัติอีกครั้ง`, 'error');
    if (!alive()) return;
    if (anim && !(await suspense(bestOf().rarity, prizes.length, alive))) return;
    await showResults(prizes, id, anim, alive);
  } catch (e) { console.warn(e); closeStage(); toast('เปิดกล่องแล้ว ดูของรางวัลได้ที่ประวัติด้านล่าง', 'success'); }
  finally { busy = false; if (dirtyBoxes) { dirtyBoxes = false; renderBoxes(); } else refreshBuy(); }
}

// ---------- claim (service prizes) ----------
function openClaim(openId) {
  const o = OPENS.find(x => x.id === openId) || WON[openId]; if (!o) return;
  claimSelf = o.claimMode === 'self';
  $('claim-open-id').value = openId;
  $('claim-info').textContent = `${o.prizeLabel}${o.productName ? ` — ${o.productName}` : ''}${o.qty > 1 ? ` × ${o.qty}` : ''}`;
  document.querySelectorAll('#claim-form [data-mode]').forEach(d => show(d, d.dataset.mode === (claimSelf ? 'self' : 'account')));
  $('claim-email').required = !claimSelf; $('claim-pass').required = !claimSelf; $('claim-name').required = claimSelf; $('claim-time').required = claimSelf;
  openModal('box-claim-modal');
}
function markClaimed(openId) {
  document.querySelectorAll('[data-rv="claim"]').forEach(btn => {
    if (btn.dataset.oid === openId) btn.outerHTML = `<span class="bx-rc-done">${icon('check')}ส่งข้อมูลแล้ว</span>`;
  });
}
async function submitClaim(e) {
  e.preventDefault();
  const btn = $('claim-submit'), openId = $('claim-open-id').value; btn.disabled = true;
  try {
    const self = claimSelf;
    await callWorker('/box/claim', { openId, buyerFacebook: $('claim-fb').value.trim(), gameEmail: self ? '' : $('claim-email').value.trim(), gamePassword: self ? '' : $('claim-pass').value, buyerContact: self ? $('claim-name').value.trim() : '', playTime: self ? $('claim-time').value.trim() : '' });
    toast('รับรางวัลแล้ว เข้าคิวงานเรียบร้อย', 'success'); closeModal('box-claim-modal'); $('claim-form').reset();
    markClaimed(openId);
    // one prize on screen → back to the page; several → stay so the other cards can still be claimed
    if (stage().classList.contains('on') && document.querySelectorAll('.bx-rc').length <= 1) closeStage();
  } catch (err) { toast(err.message || 'รับรางวัลไม่สำเร็จ', 'error'); }
  finally { btn.disabled = false; }
}

// ---------- events ----------
document.addEventListener('click', (e) => {
  const t = e.target.closest?.('[data-giftopen],[data-giftsend],[data-giftcopy],[data-giftcancel],[data-buy],[data-game],[data-claim],[data-rv],[data-qty],[data-qset],#bx-skip,#bx-close,#bx-mute,#claim-close'); if (!t) return;
  if (t.dataset.giftopen) return openBox(curBox()?.id, Math.min(10, giftLeft(GIFT)), t.dataset.giftopen);
  if (t.dataset.giftsend) return sendGift(t.dataset.giftsend);
  if (t.dataset.giftcopy) { const g = MYGIFTS.find(x => x.id === t.dataset.giftcopy); if (g) navigator.clipboard?.writeText(giftUrl(g)).then(() => toast('คัดลอกลิงก์ของขวัญแล้ว ส่งให้เพื่อนได้เลย', 'success'), () => prompt('คัดลอกลิงก์นี้', giftUrl(g))); return; }
  if (t.dataset.giftcancel) return cancelGift(t.dataset.giftcancel);
  if (t.dataset.buy) return openBox(t.dataset.buy);
  if (t.dataset.qty) return setCount(count + Number(t.dataset.qty));
  if (t.dataset.qset) return setCount(Number(t.dataset.qset));
  if (t.dataset.game) { game = t.dataset.game; write('bx-game', game); document.querySelectorAll('.bx-game-btn[data-game]').forEach(b => b.classList.toggle('on', b.dataset.game === game)); return; }
  if (t.dataset.claim) return openClaim(t.dataset.claim);
  if (t.id === 'claim-close') return closeModal('box-claim-modal');
  if (t.id === 'bx-mute') { write('bx-mute', read('bx-mute') === '1' ? '0' : '1'); return renderMute(); }
  if (t.id === 'bx-skip') return skipCurrent?.();
  if (t.id === 'bx-close') return closeStage();
  const rv = t.dataset.rv, r = $('bx-reveal');
  if (rv === 'close') closeStage();
  else if (rv === 'again') { const id = r.dataset.box, n = Number(r.dataset.n) || 1; closeStage(); openBox(id, n); }
  else if (rv === 'claim') openClaim(t.dataset.oid);
});
document.addEventListener('input', (e) => {
  if (e.target.id !== 'bx-qty') return;
  const v = parseInt(e.target.value, 10); if (Number.isFinite(v)) { count = clamp(v); refreshBuy(); }
});
document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.id === 'bx-qty') { count = clamp(t.value); refreshBuy(); t.value = String(count); }
  else if (t.id === 'bx-skipanim') { skipAnim = t.checked; write('bx-skip-anim', skipAnim ? '1' : '0'); refreshBuy(); }
});
$('claim-form')?.addEventListener('submit', submitClaim);
// Esc closes the stage once the results are on screen (same as the ปิด button)
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && stage().classList.contains('on') && $('bx-close').style.display !== 'none' && !document.querySelector('.modal.open')) closeStage(); });
renderMute();

// ---------- data ----------
onSnapshot(collection(db, 'boxes'), (s) => {
  BOXES = s.docs.map(d => ({ ...d.data(), id: d.id })).sort((a, b) => num(a.order) - num(b.order) || String(a.name).localeCompare(String(b.name)));
  if (busy) dirtyBoxes = true; else renderBoxes();
}, (e) => { console.warn('boxes:', e); $('box-list').innerHTML = '<div class="text-center text-slate py-16">โหลดกล่องสุ่มไม่สำเร็จ</div>'; });
onSnapshot(query(collection(db, 'recent_wins'), orderBy('createdAt', 'desc'), limit(12)), (s) => renderWinners(s.docs.map(d => d.data())), () => renderWinners([]));
onSettings(() => {});

onAuthStateChanged(auth, (user) => {
  unsubUser?.(); unsubOpens?.(); unsubGifts?.(); unsubPity?.(); unsubUser = unsubOpens = unsubGifts = unsubPity = null; PITY = {}; OPENS = []; MYGIFTS = []; balance = null;
  uid = user?.uid || '';
  if (user) {
    unsubUser = onSnapshot(doc(db, 'users', uid), (s) => { balance = num(s.data()?.walletBalance ?? 0); renderBalance(); refreshBuy(); }, () => {});
    unsubGifts = onSnapshot(query(collection(db, 'box_gifts'), where('fromUid', '==', uid)), (s) => { MYGIFTS = s.docs.map(d => ({ ...d.data(), id: d.id })); renderGifts(); }, () => {});
    loadGift();
    unsubPity = onSnapshot(query(collection(db, 'box_pity'), where('uid', '==', uid)), (s) => { PITY = Object.fromEntries(s.docs.map(d => [d.data().boxId, num(d.data().miss)])); if (!busy) refreshBuy(); }, () => {});
    unsubOpens = onSnapshot(query(collection(db, 'box_opens'), where('uid', '==', uid)), (s) => {
      OPENS = s.docs.map(d => ({ ...d.data(), id: d.id })).sort((a, b) => (tsDate(b.createdAt)?.getTime() || 0) - (tsDate(a.createdAt)?.getTime() || 0)); renderHistory();
    }, () => {});
  }
  renderBalance(); if (busy) refreshBuy(); else renderBoxes(); renderHistory();
});
