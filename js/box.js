import { db, auth } from "../firebase-config.js";
import { collection, doc, onSnapshot, query, where, orderBy, limit } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { esc, num, money, toast, callWorker, openModal, closeModal, onSettings, timeAgo, tsDate } from "./ui.js";
import { GAMES, playGame, sfx, confetti } from "./minigame.js";

const RARITY = {
  common: ['ทั่วไป', 'bx-r-common'], rare: ['หายาก', 'bx-r-rare'], epic: ['เอพิค', 'bx-r-epic'], legendary: ['ตำนาน', 'bx-r-legendary']
};
const KIND_ICON = { credit: '💰', account: '🎮', service: '🛠️' };
const rar = (r) => RARITY[r] || RARITY.common;
const CRATE = `<svg viewBox="0 0 120 120" fill="none" stroke="#1d1d1f" stroke-width="3" stroke-linejoin="round" aria-hidden="true"><rect x="14" y="44" width="92" height="60" rx="8"/><rect x="10" y="28" width="100" height="18" rx="6"/><path d="M60 28v76"/><rect x="52" y="48" width="16" height="16" rx="4" fill="#fff"/></svg>`;

const WON = {}; // prizes won in this visit, so the claim form works before the history snapshot arrives
let BOXES = [], OPENS = [], uid = '', balance = null, busy = false, game = 'safe', unsubUser = null, unsubOpens = null, skipCurrent = null;
try { const g = localStorage.getItem('bx-game'); if (GAMES.some(x => x.id === g)) game = g; } catch { /* storage unavailable */ }
const $ = (id) => document.getElementById(id);

// ---------- list ----------
const prizeIcon = (p) => `<span class="bx-prize-img">${KIND_ICON[p.kind] || '🎁'}</span>`;
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
function openBtn(b) {
  const afford = balance === null || balance >= num(b.price);
  return `<button type="button" class="bx-open ${afford ? '' : 'is-off'}" data-open="${esc(b.id)}">${uid ? (afford ? `เปิดกล่อง ฿${money(b.price, 0)}` : 'ยอดเงินไม่พอ') : 'เข้าสู่ระบบเพื่อเปิด'}</button>`;
}
function renderBoxes() {
  const wrap = $('box-list'); if (!wrap) return;
  const list = BOXES.filter(b => b.active !== false);
  const b = list.find(x => x.id === FOCUS);
  $('box-head')?.classList.toggle('hidden', !!b);
  if (b) {
    document.title = `${b.name} — ASTRAPHEX HUB`;
    const others = list.filter(x => x.id !== b.id);
    wrap.innerHTML = `<section class="bx-hero">
        <div class="bx-hero-art">${artHtml(b)}</div>
        <div class="bx-hero-info">
          <p class="bx-kicker">กล่องสุ่ม · ${(b.prizes || []).length} รางวัล</p>
          <h1 class="bx-name">${esc(b.name)}</h1>
          ${b.desc ? `<p class="bx-desc">${esc(b.desc)}</p>` : ''}
          <p class="bx-price">฿${money(b.price, 0)} <span>ต่อครั้ง</span></p>
          <div><p class="bx-label">เลือกวิธีเปิด</p><div class="bx-games" role="group" aria-label="เลือกมินิเกม">${GAMES.map(g => `<button type="button" class="bx-game-btn ${g.id === game ? 'on' : ''}" data-game="${g.id}"><span>${g.icon}</span>${g.label}</button>`).join('')}</div></div>
          ${openBtn(b)}
          <p class="bx-fine">ระบบสุ่มผลไว้ก่อนเริ่มมินิเกม ฝีมือไม่มีผลกับของที่ได้ · เปิดแล้วไม่คืนเงิน</p>
        </div>
      </section>
      <section class="bx-band"><h2 class="bx-h2">ของรางวัลในกล่อง</h2><div class="bx-panel bx-prizes">${prizeRows(b)}</div></section>
      ${others.length ? `<section class="mt-12"><h2 class="bx-h2">กล่องอื่น</h2><div class="bx-others">${others.map(o => `<a class="bx-mini" href="?id=${encodeURIComponent(o.id)}"><span class="bx-mini-art">${artHtml(o)}</span><span class="font-semibold">${esc(o.name)}</span><span class="text-sm text-slate">฿${money(o.price, 0)}</span></a>`).join('')}</div></section>` : ''}`;
    return;
  }
  if (!list.length) { wrap.innerHTML = '<div class="text-center text-slate py-16">ตอนนี้ยังไม่มีกล่องให้เปิด เดี๋ยวแอดมินเติมของ แวะมาใหม่นะ</div>'; return; }
  wrap.innerHTML = `<div class="bx-others">${list.map(o => `<a class="bx-mini" href="?id=${encodeURIComponent(o.id)}"><span class="bx-mini-art">${artHtml(o)}</span><span class="font-semibold">${esc(o.name)}</span><span class="text-sm text-slate">฿${money(o.price, 0)} · ${(o.prizes || []).length} รางวัล</span></a>`).join('')}</div>`;
}
window.__bxCrate = CRATE;

function renderBalance() {
  const el = $('box-balance'); if (!el) return;
  el.classList.toggle('hidden', balance === null);
  el.innerHTML = balance === null ? '' : `คงเหลือ <b>${money(balance, 0)}฿</b> <a href="topup.html" class="text-appleBlue">เติมเงิน</a>`;
}

function renderWinners(rows) {
  const el = $('box-winners'); if (!el) return;
  if (!rows.length) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.innerHTML = rows.map(w => `<span class="bx-chip ${rar(w.rarity)[1]}"><i class="bx-dot"></i>${esc(w.buyerMask || 'ผู้เล่น')} ได้ <b>${esc(w.prizeLabel)}</b></span>`).join('');
}

function renderHistory() {
  const el = $('box-history'); if (!el) return;
  if (!uid) { el.innerHTML = '<p class="text-slate text-sm">เข้าสู่ระบบเพื่อดูประวัติ</p>'; return; }
  if (!OPENS.length) { el.innerHTML = '<p class="text-slate text-sm">ยังไม่เคยเปิดกล่อง</p>'; return; }
  el.innerHTML = OPENS.slice(0, 30).map(o => `<div class="bx-hist-row ${rar(o.rarity)[1]}">
      <span class="text-2xl">${KIND_ICON[o.kind] || '🎁'}</span>
      <div class="min-w-0 flex-1"><p class="font-medium truncate">${esc(o.prizeLabel)}</p><p class="text-xs text-slate">${esc(o.boxName)} · ${money(o.price, 0)}฿ · ${timeAgo(o.createdAt)}</p></div>
      ${o.status === 'pending_claim' ? `<button type="button" class="bx-game-btn on" data-claim="${esc(o.id)}">รับรางวัล</button>` : `<span class="text-xs text-slate">${o.status === 'claimed' ? 'รับแล้ว' : 'ได้รับแล้ว'}</span>`}
    </div>`).join('');
}

// ---------- opening ----------
const stage = () => $('bx-stage');

function showReveal(p, boxId) {
  const [rl, rc] = rar(p.rarity);
  const sub = p.kind === 'credit' ? 'เครดิตเข้ากระเป๋าแล้ว เอาไปช้อปต่อได้เลย' : p.kind === 'account' ? `ไอดีเกมถูกส่งไปที่ "ออเดอร์ของฉัน" แล้ว${p.productName ? `<br><b>${esc(p.productName)}</b>` : ''}` : `${p.productName ? `<b>${esc(p.productName)}</b>${p.qty > 1 ? ` × ${p.qty}` : ''}<br>` : ''}กรอกข้อมูลรับรางวัลเพื่อเข้าคิวงาน`;
  const r = $('bx-reveal'); r.className = `bx-reveal on ${rc}`;
  r.innerHTML = `<div class="bx-reveal-card ${rc}"><span class="bx-rarity">${rl}</span>
    <div class="bx-prize-art">${KIND_ICON[p.kind] || '🎁'}</div><h3 class="bx-prize-name">${esc(p.label)}</h3><p class="bx-prize-sub">${sub}</p>
    <div class="bx-reveal-btns">
      ${p.needsClaim ? `<button type="button" class="bx-btn main" data-rv="claim">กรอกข้อมูลรับรางวัล</button>` : p.kind === 'account' ? `<a class="bx-btn main" href="account.html#orders">ดูไอดีของฉัน</a>` : ''}
      <button type="button" class="bx-btn ${p.needsClaim || p.kind === 'account' ? 'sub' : 'main'}" data-rv="again">เปิดอีกครั้ง</button>
      <button type="button" class="bx-btn sub" data-rv="close">ปิด</button></div></div>`;
  r.dataset.box = boxId; r.dataset.open = p.openId || '';
}

/** Suspense scene between the game and the prize card: the crate shakes and glows; rarer prizes wait longer. */
async function suspense(rarity) {
  const r = $('bx-reveal'), [, rc] = rar(rarity);
  r.className = `bx-reveal on susp ${rc}`;
  r.innerHTML = `<div class="bx-susp"><div class="bx-crate"><span>📦</span></div><p class="bx-susp-t">กำลังเปิดลัง…</p><div class="bx-susp-dots"><i></i><i></i><i></i></div></div>`;
  sfx('boom'); try { navigator.vibrate?.(rarity === 'common' ? [40] : [40, 60, 40, 60, 120]); } catch { /* ignore */ }
  await new Promise(res => setTimeout(res, { common: 1100, rare: 1500, epic: 1900, legendary: 2500 }[rarity] || 1200));
  r.classList.add('flash'); await new Promise(res => setTimeout(res, 220));
}

function closeStage() { const s = stage(); s.classList.remove('on'); $('bx-reveal').className = 'bx-reveal'; $('bx-arena').innerHTML = ''; document.body.style.overflow = ''; skipCurrent = null; }

async function openBox(id) {
  if (busy) return;
  const b = BOXES.find(x => x.id === id); if (!b) return;
  if (!uid) { location.href = 'login.html?mode=login&next=' + encodeURIComponent(location.pathname); return; }
  if (balance !== null && balance < num(b.price)) { toast('ยอดเงินไม่พอ กรุณาเติมเงินก่อน', 'error'); return; }
  busy = true; document.querySelectorAll('.bx-open').forEach(x => { x.disabled = true; });
  let res;
  try { res = await callWorker('/box/open', { boxId: id }); }
  catch (e) { toast(e.message || 'เปิดกล่องไม่สำเร็จ', 'error'); busy = false; renderBoxes(); return; }
  try {
    if (typeof res.balance === 'number') { balance = res.balance; renderBalance(); }
    const s = stage(); document.body.style.overflow = 'hidden';
    $('bx-stage-title').textContent = `${b.name} · ${GAMES.find(g => g.id === game)?.label || ''}`;
    $('bx-reveal').className = 'bx-reveal'; $('bx-close').classList.add('hidden'); $('bx-skip').classList.remove('hidden');
    s.classList.add('on');
    const g = playGame(game, $('bx-arena'), $('bx-msg')); skipCurrent = g.skip;
    await g.done;
    $('bx-skip').classList.add('hidden'); $('bx-close').classList.remove('hidden');
    if (res.prize?.openId) WON[res.prize.openId] = { prizeLabel: res.prize.label, productName: res.prize.productName, qty: res.prize.qty, claimMode: res.prize.claimMode };
    await suspense(res.prize.rarity);
    showReveal(res.prize, id);
    const rr = res.prize.rarity; sfx(rr === 'common' ? 'good' : rr === 'rare' ? 'win' : 'big');
    if (rr !== 'common') confetti($('bx-reveal'), { rare: 36, epic: 60, legendary: 100 }[rr] || 30, rr === 'legendary' ? ['#f2c94c', '#b64400', '#1d1d1f', '#fff'] : undefined);
  } catch (e) { console.warn(e); closeStage(); toast('เปิดกล่องแล้ว ดูของรางวัลได้ที่ประวัติด้านล่าง', 'success'); }
  finally { busy = false; renderBoxes(); }
}

// ---------- claim (service prizes) ----------
function openClaim(openId) {
  const o = OPENS.find(x => x.id === openId) || WON[openId]; if (!o) return;
  const self = o.claimMode === 'self';
  $('claim-open-id').value = openId;
  $('claim-info').textContent = `${o.prizeLabel}${o.productName ? ` — ${o.productName}` : ''}${o.qty > 1 ? ` × ${o.qty}` : ''}`;
  document.querySelectorAll('#claim-form [data-mode]').forEach(d => { d.classList.toggle('hidden', d.dataset.mode !== (self ? 'self' : 'account')); });
  $('claim-email').required = !self; $('claim-pass').required = !self; $('claim-name').required = self; $('claim-time').required = self;
  openModal('box-claim-modal');
}
async function submitClaim(e) {
  e.preventDefault();
  const btn = $('claim-submit'); btn.disabled = true;
  try {
    const self = !$('claim-name').closest('.hidden');
    await callWorker('/box/claim', { openId: $('claim-open-id').value, buyerFacebook: $('claim-fb').value.trim(), gameEmail: self ? '' : $('claim-email').value.trim(), gamePassword: self ? '' : $('claim-pass').value, buyerContact: self ? $('claim-name').value.trim() : '', playTime: self ? $('claim-time').value.trim() : '' });
    toast('รับรางวัลแล้ว เข้าคิวงานเรียบร้อย', 'success'); closeModal('box-claim-modal'); $('claim-form').reset(); closeStage();
  } catch (err) { toast(err.message || 'รับรางวัลไม่สำเร็จ', 'error'); }
  finally { btn.disabled = false; }
}

// ---------- events ----------
document.addEventListener('click', (e) => {
  const t = e.target.closest?.('[data-open],[data-game],[data-claim],[data-rv],#bx-skip,#bx-close,#bx-mute'); if (!t) return;
  if (t.dataset.open) return openBox(t.dataset.open);
  if (t.dataset.game) { game = t.dataset.game; try { localStorage.setItem('bx-game', game); } catch { /* ignore */ } document.querySelectorAll('.bx-game-btn[data-game]').forEach(b => b.classList.toggle('on', b.dataset.game === game)); return; }
  if (t.dataset.claim) return openClaim(t.dataset.claim);
  if (t.id === 'bx-mute') { let m = '0'; try { m = localStorage.getItem('bx-mute') === '1' ? '0' : '1'; localStorage.setItem('bx-mute', m); } catch { /* ignore */ } t.textContent = m === '1' ? '🔇' : '🔊'; return; }
  if (t.id === 'bx-skip') return skipCurrent?.();
  if (t.id === 'bx-close') return closeStage();
  const rv = t.dataset.rv, r = $('bx-reveal');
  if (rv === 'close') closeStage();
  else if (rv === 'again') { const id = r.dataset.box; closeStage(); openBox(id); }
  else if (rv === 'claim') openClaim(r.dataset.open);
});
$('claim-form')?.addEventListener('submit', submitClaim);

// ---------- data ----------
onSnapshot(collection(db, 'boxes'), (s) => {
  BOXES = s.docs.map(d => ({ ...d.data(), id: d.id })).sort((a, b) => num(a.order) - num(b.order) || String(a.name).localeCompare(String(b.name)));
  if (!busy) renderBoxes();
}, (e) => { console.warn('boxes:', e); $('box-list').innerHTML = '<div class="sm:col-span-2 text-center text-slate py-16">โหลดกล่องสุ่มไม่สำเร็จ</div>'; });
onSnapshot(query(collection(db, 'recent_wins'), orderBy('createdAt', 'desc'), limit(12)), (s) => renderWinners(s.docs.map(d => d.data())), () => renderWinners([]));
onSettings(() => {});

onAuthStateChanged(auth, (user) => {
  unsubUser?.(); unsubOpens?.(); unsubUser = unsubOpens = null; OPENS = []; balance = null;
  uid = user?.uid || '';
  if (user) {
    unsubUser = onSnapshot(doc(db, 'users', uid), (s) => { balance = num(s.data()?.walletBalance); renderBalance(); if (!busy) renderBoxes(); }, () => {});
    unsubOpens = onSnapshot(query(collection(db, 'box_opens'), where('uid', '==', uid)), (s) => {
      OPENS = s.docs.map(d => ({ ...d.data(), id: d.id })).sort((a, b) => (tsDate(b.createdAt)?.getTime() || 0) - (tsDate(a.createdAt)?.getTime() || 0)); renderHistory();
    }, () => {});
  }
  renderBalance(); renderBoxes(); renderHistory();
});
