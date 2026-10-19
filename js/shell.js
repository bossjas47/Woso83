import { db, auth } from "../firebase-config.js";
import { doc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { ROOT, SHOP_NAME, esc, icon, ICONS, onSettings, contactsOf, toast, openModal, num } from "./ui.js";
import { ensureProfile } from "./profile.js";

/**
 * Shared shell for every customer page:
 *  - announcement bar (admin: settings > ประกาศ), header with logo + nav, footer with contacts
 *  - phone bottom bar: หน้าหลัก | สินค้า | เติมเงิน (floating) | เครื่องมือ | เพิ่มเติม
 *  - "เพิ่มเติม" sheet: balance (คงเหลือ X฿), account, queue, contacts
 * Pages only need <header id="site-header"></header> and <footer id="site-footer"></footer>.
 */
const page = location.pathname.split('/').pop() || 'index.html';
const ACTIVE = { 'index.html': 'home', '': 'home', 'category.html': 'shop', 'product.html': 'shop', 'topup.html': 'topup', 'account.html': 'more', 'queue.html': 'more' }[page] || '';
const L = {
  home: ROOT + 'index.html', shop: ROOT + 'front/category.html', topup: ROOT + 'front/topup.html',
  account: ROOT + 'front/account.html', queue: ROOT + 'front/queue.html', orders: ROOT + 'front/account.html#orders',
  login: ROOT + 'front/login.html?mode=login', register: ROOT + 'front/login.html?mode=register'
};
const LOGO = ROOT + 'assets/logo-icon.png';
const LOGO_FULL = ROOT + 'assets/logo-full.jpg';

let user = null;
let balance = null;
let settings = {};

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
        <span class="font-heading font-bold text-[17px] tracking-tight text-ink">ASTRAPHEX <span class="text-brandTeal">HUB</span></span>
      </a>
      <div class="hidden md:flex items-center gap-7 text-[14px]">
        ${navItem('home', 'หน้าหลัก', L.home)}
        ${navItem('shop', 'สินค้า', L.shop)}
        <a href="${L.topup}" class="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full font-semibold text-[#04131c] bg-cyanGlow shadow-[0_0_16px_rgba(0,229,255,.55)] hover:shadow-[0_0_22px_rgba(0,229,255,.8)] transition">${icon(ICONS.wallet, 'w-4 h-4', 2)}เติมเงิน</a>
        <button type="button" onclick="openTools()" class="text-slate hover:text-ink transition-colors">เครื่องมือ</button>
        <button type="button" onclick="toggleMore(event)" class="${ACTIVE === 'more' ? 'text-ink font-semibold' : 'text-slate hover:text-ink'} inline-flex items-center gap-1 transition-colors" aria-haspopup="dialog">เพิ่มเติม ${icon('M6 9l6 6 6-6', 'w-3.5 h-3.5', 2)}</button>
      </div>
      <div id="header-auth" class="flex items-center gap-2 shrink-0"></div>
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
        <div class="rounded-2xl overflow-hidden bg-black w-[240px] max-w-full"><img src="${LOGO_FULL}" alt="${SHOP_NAME}" width="1200" height="463" class="w-full h-auto"></div>
        <p class="text-slate mt-4 leading-relaxed">ศูนย์รวมไอดีและบริการในเกม Arena Breakout ตรวจสอบได้ทุกออเดอร์</p>
      </div>
      <div>
        <h2 class="font-semibold text-ink mb-3">เมนู</h2>
        <ul class="space-y-2 text-slate">
          <li><a class="hover:text-ink" href="${L.home}">หน้าหลัก</a></li>
          <li><a class="hover:text-ink" href="${L.shop}">สินค้าทั้งหมด</a></li>
          <li><a class="hover:text-ink" href="${L.topup}">เติมเงิน</a></li>
          <li><a class="hover:text-ink" href="${L.queue}">คิวงานบริการ</a></li>
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
      <div class="rounded-3xl p-5 text-gallery mb-3" style="background:linear-gradient(135deg,#0b1f6b 0%,#0e3a8a 55%,#159a9c 100%)">
        <p class="text-[13px] opacity-80">ยอดเงินในบัญชี</p>
        <p id="more-balance" class="text-3xl font-heading font-bold mt-1">${balance === null ? 'กำลังโหลด…' : `คงเหลือ ${fmtBal(balance)}฿`}</p>
        <a href="${L.topup}" class="mt-4 inline-flex items-center gap-1.5 bg-cyanGlow text-[#04131c] font-semibold text-sm rounded-full px-4 py-2 shadow-[0_0_16px_rgba(0,229,255,.6)]">${icon(ICONS.plus, 'w-4 h-4', 2.6)}เติมเงิน</a>
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

function renderToolsModal() {
  if (document.getElementById('tools-modal')) return;
  const m = document.createElement('div');
  m.id = 'tools-modal'; m.className = 'modal'; m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true'); m.setAttribute('aria-label', 'เครื่องมือ');
  m.innerHTML = `<div class="modal-card text-center">
      <button type="button" onclick="closeModal('tools-modal')" aria-label="ปิด" class="absolute top-4 right-4 w-9 h-9 rounded-full bg-mist text-slate flex items-center justify-center">${icon(ICONS.x, 'w-4 h-4', 2)}</button>
      <div class="w-16 h-16 mx-auto rounded-2xl bg-mist flex items-center justify-center text-pricingBlue">${icon(ICONS.tools, 'w-8 h-8', 2)}</div>
      <p class="text-xs font-semibold text-launchOrange mt-5 tracking-wide">COMING SOON</p>
      <h2 class="text-2xl font-heading font-semibold mt-1">โปรแกรมจัดการไอดีไก่</h2>
      <p class="text-slate mt-2">อยู่ระหว่างการพัฒนา (Coming Soon)<br>เปิดให้ใช้งานเร็ว ๆ นี้</p>
      <button type="button" onclick="closeModal('tools-modal')" class="apple-pricing-pill w-full py-3 text-[15px] mt-6">รับทราบ</button>
    </div>`;
  document.body.append(m);
}
function openTools() { closeMore(); renderToolsModal(); openModal('tools-modal'); }

async function shellSignOut() {
  try { await signOut(auth); toast('ออกจากระบบแล้ว'); closeMore(); } catch (_) { toast('ออกจากระบบไม่สำเร็จ', 'error'); }
}

let unsubUser = null;
function watchUser(u) {
  if (unsubUser) { unsubUser(); unsubUser = null; }
  balance = null;
  if (!u) return;
  unsubUser = onSnapshot(doc(db, 'users', u.uid), (snap) => {
    const d = snap.exists() ? snap.data() : {};
    balance = num(d.walletBalance);
    const el = document.getElementById('more-balance');
    if (el) el.textContent = `คงเหลือ ${fmtBal(balance)}฿`;
    document.dispatchEvent(new CustomEvent('wallet', { detail: { balance, profile: d } }));
    if (d.status === 'suspended') {
      toast('บัญชีนี้ถูกระงับการใช้งาน กรุณาติดต่อแอดมิน', 'error');
      signOut(auth).catch(() => {});
    }
  }, (e) => console.warn('wallet:', e.code || e));
}

function init() {
  renderHeader();
  renderFooter();
  renderBottomNav();
  renderMoreSheet();
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMore(); });
  onSettings((s) => { settings = s || {}; renderAnnouncement(); renderFooter(); renderMoreSheet(); });
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
