import { db, auth } from "../firebase-config.js";
import { collection, doc, getDocs, onSnapshot, query, where } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

/**
 * Shared shell for every customer page: credit balance + top-up button in the header and a
 * bottom tab bar on phones (the desktop nav links are hidden below md). Load as a module.
 */
const ROOT = new URL('../', import.meta.url).href;
const page = location.pathname.split('/').pop() || 'index.html';
const onTopup = page === 'topup.html';
const ICONS = {
  home: 'M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10',
  shop: 'M4 7h16l-1 13H5L4 7zm4 0a4 4 0 018 0',
  topup: 'M3 7h18v12H3zM3 11h18M7 15h3',
  orders: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  queue: 'M12 7v5l3 2M12 21a9 9 0 100-18 9 9 0 000 18z',
  moon: 'M21 13A9 9 0 1111 3a7 7 0 0010 10z',
  wallet: 'M3 7h16a2 2 0 012 2v10H5a2 2 0 01-2-2V7zm0 0V6a2 2 0 012-2h11M16 14h.01',
  user: 'M12 12a4 4 0 100-8 4 4 0 000 8zm-8 9a8 8 0 0116 0'
};
const TABS = [
  ['index.html', 'หน้าแรก', 'home', ROOT + 'index.html'],
  ['category.html', 'สินค้า', 'shop', ROOT + 'front/category.html'],
  ['queue.html', 'คิวงาน', 'queue', ROOT + 'front/queue.html'],
  ['topup.html', 'เติมเงิน', 'topup', ROOT + 'front/topup.html'],
  ['account.html', 'บัญชี', 'user', ROOT + 'front/account.html']
];
const svg = (d, cls = 'w-5 h-5') => `<svg class="${cls}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="${d}"/></svg>`;

function addHeaderChip() {
  const header = document.querySelector('header');
  if (!header || document.getElementById('wallet-chip')) return;
  const wrap = document.createElement('div');
  wrap.className = 'flex items-center gap-2 shrink-0';
  wrap.className = 'flex items-center gap-2 shrink-0 relative';
  wrap.innerHTML = `
    <button id="theme-toggle" type="button" onclick="toggleTheme()" aria-label="สลับโหมดสว่าง/มืด" class="w-8 h-8 rounded-full bg-mist border border-hairline text-ink flex items-center justify-center">${svg(ICONS.moon, 'w-4 h-4')}</button>
    <button id="wallet-chip" type="button" aria-expanded="false" class="hidden items-center gap-1.5 bg-mist border border-hairline pl-2.5 pr-3 py-1 rounded-full text-xs whitespace-nowrap" title="เครดิตคงเหลือ">
      ${svg(ICONS.wallet, 'w-4 h-4 text-slate')}<strong id="wallet-chip-amount" class="text-ink font-mono font-semibold">0.00</strong>
    </button>
    <div id="wallet-pop" class="hidden fixed right-4 top-14 sm:absolute sm:right-0 sm:top-full sm:mt-2 w-72 max-w-[calc(100vw-2rem)] z-50 bg-gallery border border-hairline rounded-[28px] p-5 text-left">
      <p class="text-xs text-slate">เครดิตคงเหลือ</p>
      <p class="text-3xl font-heading font-semibold mt-0.5">฿<span id="wallet-pop-amount">0.00</span></p>
      ${onTopup ? '' : `<a href="${ROOT}front/topup.html" class="apple-pricing-pill w-full py-2.5 text-sm mt-4">เติมเงิน</a>`}
      <p class="text-xs text-slate mt-5 mb-2">รายการเติมเงินล่าสุด</p>
      <div id="wallet-pop-list" class="space-y-2 text-sm"><p class="text-slate text-xs">-</p></div>
    </div>
    ${onTopup ? '' : `<a href="${ROOT}front/topup.html" class="apple-pricing-pill px-3.5 py-1 text-xs whitespace-nowrap max-sm:hidden">เติมเงิน</a>`}`;
  const loggedOut = document.getElementById('auth-logged-out');
  if (loggedOut) loggedOut.parentElement.prepend(wrap);
  else {
    const back = header.querySelector('a.apple-explore-pill');
    if (back) back.parentElement.insertBefore(wrap, back); else header.firstElementChild?.append(wrap);
  }
}

function addTabBar() {
  if (document.getElementById('shell-tabbar') || page === 'product.html') return; // product has its own buy bar
  const bar = document.createElement('nav');
  bar.id = 'shell-tabbar';
  bar.setAttribute('aria-label', 'เมนูหลัก');
  bar.className = 'md:hidden fixed bottom-0 inset-x-0 z-40 bg-gallery/90 backdrop-blur-xl border-t border-hairline grid grid-cols-5 pb-[env(safe-area-inset-bottom)]';
  bar.innerHTML = TABS.map(([file, label, icon, href]) => {
    const active = file === page;
    return `<a href="${href}" ${active ? 'aria-current="page"' : ''} class="flex flex-col items-center gap-0.5 py-2 text-[11px] ${active ? 'text-appleBlue font-semibold' : 'text-slate'}">${svg(ICONS[icon])}<span>${label}</span></a>`;
  }).join('');
  document.body.append(bar);
  document.body.style.paddingBottom = 'calc(3.5rem + env(safe-area-inset-bottom))'; // keep content clear of the bar
}

let unsub = null;
const TOPUP_ST = { pending: 'รอตรวจสอบ', completed: 'สำเร็จ', rejected: 'ไม่อนุมัติ' };
async function openWalletPop(user) {
  const pop = document.getElementById('wallet-pop'); if (!pop) return;
  pop.classList.toggle('hidden');
  document.getElementById('wallet-chip').setAttribute('aria-expanded', String(!pop.classList.contains('hidden')));
  if (pop.classList.contains('hidden')) return;
  const list = document.getElementById('wallet-pop-list');
  try {
    const snap = await getDocs(query(collection(db, 'topup_transactions'), where('uid', '==', user.uid)));
    const ms = (d) => d.createdAt?.toMillis?.() || 0;
    const rows = snap.docs.map(d => d.data()).sort((a, b) => ms(b) - ms(a)).slice(0, 4);
    list.innerHTML = rows.length ? rows.map(r => `<div class="flex justify-between"><span>฿${Number(r.amount).toLocaleString('th-TH')}</span><span class="text-slate">${TOPUP_ST[r.status] || r.status}</span></div>`).join('') : '<p class="text-slate text-xs">ยังไม่มีรายการ</p>';
  } catch (e) { list.innerHTML = '<p class="text-slate text-xs">โหลดรายการไม่สำเร็จ</p>'; }
}

function watchWallet(user) {
  if (unsub) { unsub(); unsub = null; }
  const chip = document.getElementById('wallet-chip');
  const amount = document.getElementById('wallet-chip-amount');
  if (!chip || !amount) return;
  chip.classList.toggle('hidden', !user);
  chip.classList.toggle('inline-flex', !!user);
  chip.onclick = user ? (e) => { e.stopPropagation(); openWalletPop(user); } : null;
  if (!user) { document.getElementById('wallet-pop')?.classList.add('hidden'); return; }
  unsub = onSnapshot(doc(db, 'users', user.uid), (snap) => {
    amount.innerText = (parseFloat(snap.exists() ? snap.data().walletBalance : 0) || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const pa = document.getElementById('wallet-pop-amount'); if (pa) pa.innerText = amount.innerText;
  }, (e) => console.warn('Wallet chip:', e));
}

document.addEventListener('click', (e) => {
  const pop = document.getElementById('wallet-pop');
  if (pop && !pop.classList.contains('hidden') && !pop.contains(e.target)) pop.classList.add('hidden');
});

function init() {
  addHeaderChip();
  addTabBar();
  onAuthStateChanged(auth, watchWallet);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
