import { db, auth } from "../firebase-config.js";
import { doc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { ROOT, SHOP_NAME, esc, icon, ICONS, onSettings, contactsOf, toast, openModal, num } from "./ui.js";
import { ensureProfile } from "./profile.js";
import { RANKS, rankOf, rankIcon } from "./rank.js";

let lastProfile = null, lastST = {}, festivalLoaded = false;
onSettings((st) => { lastST = st; });
const rankLine = () => { const i = rankOf(lastProfile, lastST); return i < 0 ? '<span class="opacity-70">ซื้อครั้งแรกรับยศ Bronze</span>' : `${rankIcon(i, 'w-5 h-5')}<a href="${ROOT}front/account.html" class="font-semibold">ยศ ${RANKS[i].name}</a>`; };
/**
 * Shared shell for every customer page:
 *  - announcement bar (admin: settings > ประกาศ), header with logo + nav, footer with contacts
 *  - phone bottom bar: หน้าหลัก | สินค้า | เติมเงิน (floating) | เครื่องมือ | เพิ่มเติม
 *  - "เพิ่มเติม" sheet: balance (คงเหลือ X฿), account, queue, contacts
 * Pages only need <header id="site-header"></header> and <footer id="site-footer"></footer>.
 */
const page = (location.pathname.split('/').pop() || 'index').replace(/\.html$/, '') + '.html'; // same with or without .html (Vercel cleanUrls)
const ACTIVE = { 'home.html': 'home', 'index.html': 'home', '': 'home', 'category.html': 'shop', 'product.html': 'shop', 'topup.html': 'topup', 'account.html': 'more', 'queue.html': 'more', 'auction.html': 'more', 'box.html': 'shop', 'rentals.html': 'more', 'wallet.html': 'more', 'cart.html': 'more', 'vault.html': 'more' }[page] || '';
const L = {
  home: ROOT + 'home.html', shop: ROOT + 'front/category.html', topup: ROOT + 'front/topup.html',
  account: ROOT + 'front/account.html', queue: ROOT + 'front/queue.html', auction: ROOT + 'front/auction.html', box: ROOT + 'front/box.html', orders: ROOT + 'front/account.html#orders',
  cart: ROOT + 'front/cart.html', vault: ROOT + 'front/vault.html', login: ROOT + 'front/login.html?mode=login', register: ROOT + 'front/login.html?mode=register'
};
const LOGO = ROOT + 'assets/logo-icon-96.png';

let user = null;
let balance = null;
let settings = {};

/** Shop paused by the admin (same rule as shopClosedNow() in worker/slip-worker.js): an orange line under the header on every page. */
function renderClosed() {
  let bar = document.getElementById('closed-bar');
  const off = settings.shopClosed === true && !(Number(settings.shopReopenAt) > 0 && Date.now() >= Number(settings.shopReopenAt));
  if (!off) { bar?.remove(); return; }
  if (!bar) {
    bar = document.createElement('div'); bar.id = 'closed-bar'; bar.setAttribute('role', 'status');
    bar.className = 'text-center text-[13px] py-2 px-4'; bar.style.cssText = 'background:#fff3e6;color:#b64400';
    const header = document.getElementById('site-header');
    (header?.parentNode || document.body).insertBefore(bar, header?.nextSibling || document.body.firstChild);
  }
  const back = Number(settings.shopReopenAt) > 0 ? ` · เปิดอีกครั้ง ${new Date(Number(settings.shopReopenAt)).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' })}` : '';
  bar.textContent = (String(settings.shopClosedMsg || '').trim() || 'ร้านปิดชั่วคราว') + back;
}

function renderAnnouncement() {
  let bar = document.getElementById('announce-bar');
  const on = settings.announcementEnabled === true && String(settings.announcementText || '').trim();
  if (!on) { bar?.remove(); return; }
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'announce-bar';
    bar.className = 'bg-ink text-gallery text-[13px] overflow-hidden whitespace-nowrap select-none';
    const header = document.getElementById('site-header');
    (header?.parentNode || document.body).insertBefore(bar, header || document.body.firstChild);
  }
  const text = esc(String(settings.announcementText).trim());
  const link = /^(https:\/\/|\/|#|\.\.?\/)/.test(String(settings.announcementLink || '')) ? settings.announcementLink : '';
  const item = `<span class="inline-flex items-center gap-2 px-8 py-2"><span class="w-1.5 h-1.5 rounded-full bg-cyanGlow"></span>${text}</span>`;
  const track = `<div class="marquee-track">${item.repeat(6)}</div>`;
  bar.innerHTML = link ? `<a href="${esc(link)}" class="block">${track}</a>` : track;
}

function renderHeader() {
  const h = document.getElementById('site-header');
  if (!h) return;
  h.className = 'site-header';
  const navItem = (key, label, href) => `<a href="${href}" class="${ACTIVE === key ? 'text-ink font-semibold' : 'text-slate hover:text-ink'} transition-colors">${label}</a>`;
  h.innerHTML = `
    <nav class="max-w-[1200px] mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-4" aria-label="เมนูหลัก">
      <a href="${L.home}" class="flex items-center gap-2.5 shrink-0" aria-label="${SHOP_NAME} หน้าหลัก">
        <img src="${LOGO}" alt="" width="34" height="34" class="w-[34px] h-[34px] object-contain">
        <span class="font-heading font-bold text-[17px] tracking-tight text-ink">Nugget <span class="text-brandTeal">Hub</span></span>
      </a>
      <div class="hidden md:flex items-center gap-7 text-[14px]">
        ${navItem('home', 'หน้าหลัก', L.home)}
        ${navItem('shop', 'สินค้า', L.shop)}
        <a href="${L.topup}" class="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full font-semibold text-[#04131c] bg-cyanGlow hover: transition">${icon(ICONS.wallet, 'w-4 h-4', 2)}เติมเงิน</a>
        <button type="button" onclick="openTools()" class="text-slate hover:text-ink transition-colors">เครื่องมือ</button>
        <button type="button" onclick="toggleMore(event)" class="${ACTIVE === 'more' ? 'text-ink font-semibold' : 'text-slate hover:text-ink'} inline-flex items-center gap-1 transition-colors" aria-haspopup="dialog">เพิ่มเติม ${icon('M6 9l6 6 6-6', 'w-3.5 h-3.5', 2)}</button>
      </div>
      <div class="flex items-center gap-2 shrink-0">
        <a href="${L.cart}" class="relative w-10 h-10 rounded-full hover:bg-mist flex items-center justify-center text-ink" aria-label="ตะกร้า">${icon('M3 4h2l2.4 11h10.2L20 7H6.2M9 20h.01M17 20h.01', 'w-[22px] h-[22px]', 2)}<span id="cart-badge" class="hidden absolute top-0 right-0 min-w-[18px] h-[18px] px-1 rounded-full bg-launchOrange text-gallery text-[11px] font-semibold leading-[18px] text-center"></span></a>
        <div id="header-auth" class="flex items-center gap-2 shrink-0"></div>
      </div>
    </nav>`;
  renderHeaderAuth();
}

function renderHeaderAuth() {
  const box = document.getElementById('header-auth');
  if (!box) return;
  if (!user) {
    box.innerHTML = `<span class="hidden sm:flex items-center gap-2"><a href="${L.login}" class="text-[14px] text-slate hover:text-ink px-2 py-1 whitespace-nowrap">เข้าสู่ระบบ</a>
      <a href="${L.register}" class="apple-pricing-pill px-4 py-1.5 text-[13px] whitespace-nowrap">สมัครสมาชิก</a></span>
      <span class="sm:hidden"><a href="${L.login}" class="apple-pricing-pill px-4 py-1.5 text-[13px] whitespace-nowrap">เข้าสู่ระบบ</a></span>`;
    return;
  }
  const name = user.displayName || (user.email || '').split('@')[0] || 'สมาชิก';
  box.innerHTML = `<a href="${L.account}" class="flex items-center gap-2 text-[14px] text-ink rounded-full pl-1 pr-3 py-1 hover:bg-mist transition" title="บัญชีของฉัน">
      <span class="w-7 h-7 rounded-full bg-ink text-gallery text-xs font-semibold flex items-center justify-center">${esc([...name][0]?.toUpperCase() || 'A')}</span>
      <span class="max-w-[90px] truncate font-medium max-[360px]:hidden">${esc(name)}</span></a>`;
}

function renderFooter() {
  const f = document.getElementById('site-footer');
  if (!f) return;
  const c = contactsOf(settings);
  f.className = 'bg-mist border-t border-hairline mt-16';
  f.innerHTML = `
    <div class="max-w-[1200px] mx-auto px-4 sm:px-6 py-12 grid gap-10 md:grid-cols-3 text-sm">
      <div>
        <div class="flex items-center gap-2.5"><img src="${LOGO}" alt="" width="40" height="40" class="w-10 h-10 object-contain"><span class="font-heading font-bold text-[19px] tracking-tight text-ink">Nugget <span class="text-brandTeal">Hub</span></span></div>
        <p class="text-slate mt-4 leading-relaxed">ไอดีและบริการ Arena Breakout ของคนเล่นจริง เช็กได้ทุกออเดอร์</p>
      </div>
      <div>
        <h2 class="font-semibold text-ink mb-3">เมนู</h2>
        <ul class="space-y-2 text-slate">
          <li><a class="hover:text-ink" href="${L.home}">หน้าหลัก</a></li>
          <li><a class="hover:text-ink" href="${L.shop}">สินค้าทั้งหมด</a></li>
          <li><a class="hover:text-ink" href="${L.topup}">เติมเงิน</a></li>
          <li><a class="hover:text-ink" href="${L.queue}">คิวงานบริการ</a></li>
          <li><a class="hover:text-ink" href="${L.auction}">ประมูลไอดี</a></li>
          <li><a class="hover:text-ink" href="${L.orders}">ออเดอร์ของฉัน</a></li>
        </ul>
      </div>
      <div>
        <h2 class="font-semibold text-ink mb-3">ติดต่อแอดมิน</h2>
        <div class="flex flex-wrap gap-2">${c.length ? c.map(contactBtn).join('') : '<p class="text-slate">ร้านยังไม่ได้ใส่ช่องทางติดต่อ</p>'}</div>
      </div>
    </div>
    <div class="border-t border-hairline"><p class="max-w-[1200px] mx-auto px-4 sm:px-6 py-5 text-xs text-slate">© ${new Date().getFullYear()} ${SHOP_NAME} · การซื้อขายไอดีและไอเท็มอาจขัดต่อข้อกำหนดของผู้พัฒนาเกม</p></div>`;
}

const contactBtn = (c) => `<a href="${esc(c.url)}" target="_blank" rel="noopener" class="inline-flex items-center gap-2 bg-gallery border border-hairline rounded-full pl-2 pr-4 py-1.5 text-sm font-medium text-ink hover:border-steel transition">
  <span class="w-6 h-6 rounded-full flex items-center justify-center text-gallery" style="background:${c.color}">${icon(ICONS.chat, 'w-3.5 h-3.5', 2.2)}</span>${esc(c.label)}</a>`;

function renderBottomNav() {
  if (document.getElementById('bottom-nav')) return;
  const nav = document.createElement('nav');
  nav.id = 'bottom-nav';
  nav.className = 'bottom-nav';
  nav.setAttribute('aria-label', 'เมนูด้านล่าง');
  const tab = (key, label, ic, href) => `<a href="${href}" class="${ACTIVE === key ? 'is-active' : ''}" ${ACTIVE === key ? 'aria-current="page"' : ''}>${icon(ic, '', 1.8)}<span>${label}</span></a>`;
  nav.innerHTML = `
    ${tab('home', 'หน้าหลัก', ICONS.home, L.home)}
    ${tab('shop', 'สินค้า', ICONS.shop, L.shop)}
    <a href="${L.topup}" class="nav-topup ${ACTIVE === 'topup' ? 'is-active' : ''}" aria-label="เติมเงิน"><span class="nav-topup-orb">${icon(ICONS.wallet, '', 2)}</span><span>เติมเงิน</span></a>
    <button type="button" onclick="openTools()">${icon(ICONS.tools, '', 1.8)}<span>เครื่องมือ</span></button>
    <button type="button" onclick="toggleMore(event)" class="${ACTIVE === 'more' ? 'is-active' : ''}" aria-haspopup="dialog">${icon(ICONS.grid, '', 1.8)}<span>เพิ่มเติม</span></button>`;
  document.body.append(nav);
  document.body.classList.add('has-bottom-nav');
}

function renderMoreSheet() {
  if (!document.getElementById('more-sheet')) {
    const bd = document.createElement('div');
    bd.id = 'more-backdrop'; bd.className = 'sheet-backdrop'; bd.onclick = closeMore;
    const sh = document.createElement('div');
    sh.id = 'more-sheet'; sh.className = 'sheet'; sh.setAttribute('role', 'dialog'); sh.setAttribute('aria-label', 'เมนูเพิ่มเติม');
    document.body.append(bd, sh);
  }
  const sh = document.getElementById('more-sheet');
  const c = contactsOf(settings);
  const row = (href, ic, label, extra = '') => `<a href="${href}" class="flex items-center gap-3 px-3 py-3 rounded-2xl hover:bg-mist transition text-[16px] font-medium text-ink">${icon(ic, 'w-6 h-6 text-slate', 2)}<span class="flex-1">${label}</span>${extra}${icon('M9 6l6 6-6 6', 'w-4 h-4 text-steel', 2)}</a>`;
  sh.innerHTML = `
    <div class="w-10 h-1.5 rounded-full bg-control mx-auto mb-4 md:hidden"></div>
    ${user ? `
      <div class="rounded-3xl p-5 text-gallery mb-3" style="background:#1d1d1f">
        <p class="text-[13px] opacity-80">ยอดเงินในบัญชี</p>
        <p id="more-balance" class="text-3xl font-heading font-bold mt-1">${balance === null ? 'กำลังโหลด…' : `คงเหลือ ${fmtBal(balance)}฿`}</p>
        <p id="more-rank" class="text-[13px] mt-1.5 flex items-center gap-1.5">${rankLine()}</p>
        <a href="${L.topup}" class="mt-4 inline-flex items-center gap-1.5 bg-cyanGlow text-[#04131c] font-semibold text-sm rounded-full px-4 py-2">${icon(ICONS.plus, 'w-4 h-4', 2.6)}เติมเงิน</a>
      </div>` : `
      <div class="rounded-3xl bg-mist p-5 mb-3">
        <p class="font-semibold text-ink">ยังไม่ได้เข้าสู่ระบบ</p>
        <p class="text-sm text-slate mt-0.5">เข้าสู่ระบบเพื่อดูยอดเงินและออเดอร์ของคุณ</p>
        <div class="flex gap-2 mt-4"><a href="${L.login}" class="apple-pricing-pill px-5 py-2 text-sm">เข้าสู่ระบบ</a><a href="${L.register}" class="apple-explore-pill px-5 py-2 text-sm">สมัครสมาชิก</a></div>
      </div>`}
    <div class="space-y-0.5">
      ${row(L.account, ICONS.user, 'บัญชี')}
      ${row(L.orders, ICONS.orders, 'ออเดอร์ของฉัน')}
      ${row(L.queue, ICONS.queue, 'คิวงาน')}
      ${row(L.auction, ICONS.bolt, 'ประมูลไอดี')}
      <button type="button" onclick="toggleTheme()" class="w-full flex items-center gap-3 px-3 py-3 rounded-2xl hover:bg-mist transition text-[16px] font-medium text-ink">${icon(ICONS.moon, 'w-6 h-6 text-slate', 2)}<span class="flex-1 text-left">สลับโหมดสว่าง / มืด</span></button>
    </div>
    <div class="mt-4 pt-4 border-t border-hairline">
      <p class="text-sm font-semibold text-ink px-1 mb-2.5">ติดต่อแอดมิน</p>
      <div class="flex flex-wrap gap-2">${c.length ? c.map(contactBtn).join('') : '<p class="text-sm text-slate px-1">ร้านยังไม่ได้ใส่ช่องทางติดต่อ</p>'}</div>
    </div>
    ${user ? `<button type="button" onclick="shellSignOut()" class="mt-4 w-full flex items-center justify-center gap-2 py-3 rounded-2xl text-[15px] font-medium text-launchOrange hover:bg-mist">${icon(ICONS.logout, 'w-5 h-5', 2)}ออกจากระบบ</button>` : ''}`;
}

const fmtBal = (v) => num(v).toLocaleString('th-TH', { maximumFractionDigits: 2 });

function toggleMore(e) {
  e?.stopPropagation();
  const sh = document.getElementById('more-sheet');
  if (!sh) return;
  sh.classList.contains('open') ? closeMore() : (sh.classList.add('open'), document.getElementById('more-backdrop')?.classList.add('open'));
}
function closeMore() {
  document.getElementById('more-sheet')?.classList.remove('open');
  document.getElementById('more-backdrop')?.classList.remove('open');
}

function openTools() { location.href = L.vault; }

async function shellSignOut() {
  try { await signOut(auth); toast('ออกจากระบบแล้ว'); closeMore(); } catch (_) { toast('ออกจากระบบไม่สำเร็จ', 'error'); }
}

let unsubUser = null, unsubCart = null;
function watchUser(u) {
  if (unsubUser) { unsubUser(); unsubUser = null; }
  if (unsubCart) { unsubCart(); unsubCart = null; }
  balance = null;
  const badge = document.getElementById('cart-badge');
  if (badge) badge.classList.add('hidden');
  if (!u) return;
  unsubCart = onSnapshot(doc(db, 'carts', u.uid), (s) => {
    const n = (s.data()?.items || []).length, b = document.getElementById('cart-badge');
    if (b) { b.textContent = n; b.classList.toggle('hidden', !n); }
  }, () => {});
  unsubUser = onSnapshot(doc(db, 'users', u.uid), (snap) => {
    const d = snap.exists() ? snap.data() : {};
    balance = num(d.walletBalance);
    const el = document.getElementById('more-balance');
    if (el) el.textContent = `คงเหลือ ${fmtBal(balance)}฿`;
    lastProfile = d; const rk = document.getElementById('more-rank'); if (rk) rk.innerHTML = rankLine();
    document.querySelectorAll('[onclick="openTools()"], [data-tools]').forEach(b => b.classList.toggle('has-dot', num(d.vaultAlerts) > 0));
    window.__wallet = { balance, profile: d }; // pages that load after this event read the last one
    document.dispatchEvent(new CustomEvent('wallet', { detail: window.__wallet }));
    if (d.status === 'suspended') {
      toast('บัญชีนี้ถูกระงับการใช้งาน กรุณาติดต่อแอดมิน', 'error');
      signOut(auth).catch(() => {});
    }
  }, (e) => console.warn('wallet:', e.code || e));
}

function speculate() {
  if (!HTMLScriptElement.supports?.('speculationrules')) return;
  const dir = new URL(ROOT + 'front/', location.href).pathname;
  const s = document.createElement('script'); s.type = 'speculationrules';
  s.textContent = JSON.stringify({ prerender: [{ where: { href_matches: ['product', 'category', 'topup', 'queue', 'cart', 'box'].map(n => `${dir}${n}*`) }, eagerness: 'moderate' }] });
  document.head.append(s);
}

function init() {
  speculate();
  renderHeader();
  renderFooter();
  renderBottomNav();
  renderMoreSheet();
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMore(); });
  onSettings((s) => {
    settings = s || {}; renderClosed(); renderAnnouncement(); renderFooter(); renderMoreSheet();
    // festival code is only downloaded while a festival is on (or was on, so it can switch itself off)
    if (settings.festival?.on || festivalLoaded) { festivalLoaded = true; import('./festival.js').then(m => m.applyFestival(settings.festival, ACTIVE === 'home')).catch(e => console.warn('festival:', e)); }
  });
  onAuthStateChanged(auth, (u) => {
    user = u;
    renderHeaderAuth();
    renderMoreSheet();
    watchUser(u);
    if (u) ensureProfile(u);
  });
}

Object.assign(window, { toggleMore, closeMore, openTools, shellSignOut });
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
// a page module that ran after the first wallet snapshot gets it again once every module has loaded
document.addEventListener('DOMContentLoaded', () => { if (window.__wallet) document.dispatchEvent(new CustomEvent('wallet', { detail: window.__wallet })); });
