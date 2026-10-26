import { db, auth } from "../firebase-config.js";
import { collection, doc, getDocs, onSnapshot, query, updateDoc, where } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { onAuthStateChanged, signOut, updateProfile, EmailAuthProvider, reauthenticateWithCredential, updatePassword } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { esc, num, toast, fmtDate, icon, ICONS, onSettings, money } from "./ui.js";
import { RANKS, rankTable, rankOf, rankIcon } from "./rank.js";
import { orderCardHtml, PRODUCT_IMAGES } from "./orders-ui.js";
import { ensureProfile } from "./profile.js";
import { mountPushCard } from "./push.js";

/** Account page: profile + status, balance with top-up shortcut, game-ID orders, service queue, settings. */
const $ = (id) => document.getElementById(id);
let user = null, profile = {}, orders = [], tab = 'ids';
let unsubOrders = null, unsubProfile = null;

function switchAccountTab(t) {
  tab = t;
  ['ids', 'services', 'settings'].forEach(k => {
    $(`sec-${k}`).classList.toggle('hidden', k !== t);
    const b = $(`tab-${k}`);
    b.className = `py-2.5 rounded-full font-medium transition ${k === t ? 'bg-gallery text-ink shadow-sm' : 'text-slate hover:text-ink'}`;
    b.setAttribute('aria-selected', String(k === t));
  });
}

function renderProfile() {
  const name = profile.username || user.displayName || (user.email || '').split('@')[0] || 'สมาชิก';
  $('acc-name').textContent = name;
  $('acc-avatar').textContent = [...name][0]?.toUpperCase() || 'A';
  $('acc-since').textContent = fmtDate(profile.createdAt || user.metadata?.creationTime).split(' ').slice(0, 3).join(' ');
  $('acc-balance').innerHTML = `<small>฿</small>${num(profile.walletBalance).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  $('acc-topup-total').textContent = `฿${num(profile.topupTotal).toLocaleString('th-TH', { maximumFractionDigits: 0 })}`;
  const suspended = profile.status === 'suspended';
  $('acc-status').innerHTML = `<span class="w-2 h-2 rounded-full ${suspended ? 'bg-launchOrange' : 'bg-emerald-500'}"></span>${suspended ? 'ถูกระงับการใช้งาน' : 'บัญชีปกติ'}`;
  const contact = [profile.facebook && `Facebook: ${profile.facebook}`, profile.contactEmail && `อีเมล: ${profile.contactEmail}`].filter(Boolean).join(' · ');
  $('acc-contact').textContent = contact;
  if (document.activeElement?.closest?.('#form-profile') == null) {
    $('pf-name').value = name;
    $('pf-facebook').value = profile.facebook || '';
    $('pf-email').value = profile.contactEmail || (/@tactical\.store$/.test(user.email || '') ? '' : user.email || '');
  }
  renderRank();
}

let ST = {};
// product pictures for the order cards (one read; a missing picture falls back to an icon)
getDocs(collection(db, 'products')).then(s => { s.forEach(d => d.data().image && PRODUCT_IMAGES.set(d.id, d.data().image)); if (user && orders.length) renderOrders(); }).catch(e => console.warn('products:', e));
/** Rank card: current rank, what it gives, how much more to top up for the next one, and the whole ladder. */
function renderRank() {
  const el = $('acc-rank'); if (!el || !user) return;
  const tb = rankTable(ST), at = rankOf(profile, ST), total = num(profile.topupTotal);
  const rn = $('acc-rank-name'); if (rn) rn.textContent = at >= 0 && tb[at] ? tb[at].name : 'ยังไม่มี';
  const next = tb.slice(at + 1).find(r => r.min > 0 && r.min > total);
  const perks = (r) => [r.discount && `ลด ${r.discount}% ทุกออเดอร์`, r.bonus && `โบนัสเติมเงิน +${r.bonus}%`].filter(Boolean).join(' · ') || 'ป้ายยศ';
  const pct = next ? Math.min(100, Math.round(total / next.min * 100)) : 100;
  el.innerHTML = `<div class="flex items-center gap-4">
      <span class="shrink-0 w-16 h-16 rounded-[20px] bg-mist flex items-center justify-center">${at < 0 ? `<span style="filter:grayscale(1);opacity:.35">${rankIcon(0, 'w-11 h-11')}</span>` : rankIcon(at, 'w-11 h-11')}</span>
      <div class="min-w-0 flex-1"><p class="text-xs text-slate">ยศสมาชิก</p><p class="text-2xl font-heading font-semibold leading-tight">${at < 0 ? 'ยังไม่มียศ' : RANKS[at].name}</p>
        <p class="text-sm text-slate mt-0.5">${at < 0 ? 'ซื้อของชิ้นแรก ปลดล็อกยศ Bronze ทันที' : esc(perks(tb[at]))}</p></div></div>
    ${at < 0 ? '' : `<div class="mt-4"><div class="flex justify-between text-xs text-slate"><span>ยอดเติมสะสม ฿${money(total, 0)}</span><span>${next ? `อีก ฿${money(next.min - total, 0)} เป็น ${next.name}` : 'ยศสูงสุดแล้ว'}</span></div>
      <div class="rank-bar mt-1.5"><span style="width:${pct}%"></span></div></div>`}
    <details class="mt-4"><summary class="text-sm text-appleBlue cursor-pointer">ดูยศทั้งหมด</summary>
      <ol class="mt-3 divide-y divide-hairline">${tb.map((r, i) => `<li class="py-2.5 flex items-center gap-3 ${i === at ? 'font-semibold' : ''}">${rankIcon(i, 'w-7 h-7 shrink-0')}<span class="w-20">${r.name}</span><span class="flex-1 text-xs text-slate">${i ? (r.min ? `เติมสะสม ฿${money(r.min, 0)}` : 'ยังไม่เปิด') : 'ซื้อครั้งแรก'}</span><span class="text-xs text-right">${esc(perks(r))}</span></li>`).join('')}</ol></details>`;
}
onSettings((s) => { ST = s; renderRank(); });

function renderOrders() {
  const ids = orders.filter(o => o.productType !== 'service');
  const srv = orders.filter(o => o.productType === 'service');
  $('acc-count-ids').textContent = ids.filter(o => o.status === 'completed').length;
  $('acc-count-srv').textContent = srv.length;
  $('acc-count-pending').textContent = orders.filter(o => o.status === 'pending_payment' || o.status === 'processing').length;
  const empty = (title, href, cta) => `<div class="soft-card py-14 px-6 text-center"><div class="w-14 h-14 rounded-2xl bg-gallery mx-auto flex items-center justify-center text-steel">${icon(ICONS.orders, 'w-7 h-7', 1.8)}</div>
    <p class="font-semibold mt-4">${title}</p><a href="${href}" class="apple-pricing-pill px-6 py-2.5 text-sm mt-5">${cta}</a></div>`;
  $('sec-ids').innerHTML = ids.length ? ids.map(orderCardHtml).join('') : empty('ยังไม่มีไอดีที่ซื้อ', 'category.html', 'เลือกซื้อไอดี');
  $('sec-services').innerHTML = srv.length
    ? `<div id="push-card"></div><a href="queue.html" class="flex items-center justify-between soft-card px-5 py-3.5 text-[15px]"><span>ดูคิวงานทั้งหมดของร้าน</span>${icon('M9 6l6 6-6 6', 'w-4 h-4 text-steel', 2)}</a>` + srv.map(orderCardHtml).join('')
    : empty('ยังไม่มีงานบริการ', 'category.html', 'ดูบริการ');
  if (srv.some(o => o.status !== 'completed' && o.status !== 'cancelled')) mountPushCard($('push-card'), 'เปิดแจ้งเตือนไว้ ใกล้ถึงคิว ถึงคิว หรืองานเสร็จ มือถือเด้งบอกทันที');
}

function watch(u) {
  unsubOrders?.(); unsubProfile?.();
  unsubOrders = onSnapshot(query(collection(db, 'orders'), where('userId', '==', u.uid)), (s) => {
    orders = s.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (b.createdAt?.toMillis?.() ?? Date.now()) - (a.createdAt?.toMillis?.() ?? Date.now()));
    renderOrders();
    if (location.hash === '#orders' && !watch.done) {
      watch.done = true;
      const hasIds = orders.some(o => o.productType !== 'service');
      switchAccountTab(!hasIds && orders.some(o => o.productType === 'service') ? 'services' : 'ids');
    }
  }, (e) => { console.warn('orders:', e); $('sec-ids').innerHTML = '<p class="text-slate text-sm p-4">โหลดออเดอร์ไม่สำเร็จ</p>'; });
  unsubProfile = onSnapshot(doc(db, 'users', u.uid), (s) => { profile = s.exists() ? s.data() : {}; renderProfile(); }, () => renderProfile());
}

onAuthStateChanged(auth, async (u) => {
  user = u;
  $('acc-loading').classList.add('hidden');
  $('acc-guest').classList.toggle('hidden', !!u);
  $('acc-dash').classList.toggle('hidden', !u);
  if (!u) { unsubOrders?.(); unsubProfile?.(); return; }
  renderProfile();
  $('sec-ids').innerHTML = `<div class="skeleton h-40 !rounded-[28px]"></div><div class="skeleton h-40 !rounded-[28px]"></div>`;
  watch(u);
  try {
    // force refresh: a cached token keeps the old claims for up to an hour after an admin grants the role
    const claims = (await u.getIdTokenResult(true)).claims;
    const staff = Array.isArray(claims.perms) && claims.perms.length > 0;
    if (claims.admin === true || staff) {
      $('acc-role').textContent = claims.admin === true ? 'ผู้ดูแลระบบ' : 'ทีมงาน';
      $('acc-role').className = 'text-[11px] font-semibold px-2.5 py-0.5 rounded-full bg-[#fff3e6] text-[#a04a00]';
      $('acc-admin-link').classList.remove('hidden');
    }
  } catch (_) {}
});

$('form-profile').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('pf-name').value.trim();
  const facebook = $('pf-facebook').value.trim();
  const contactEmail = $('pf-email').value.trim();
  if (name.length < 2) { toast('ชื่อที่แสดงต้องมีอย่างน้อย 2 ตัวอักษร', 'error'); return; }
  if (contactEmail && !/^\S+@\S+\.\S+$/.test(contactEmail)) { toast('อีเมลไม่ถูกต้อง', 'error'); return; }
  const btn = $('pf-save'); btn.disabled = true;
  try {
    await ensureProfile(user);
    if (name !== user.displayName) await updateProfile(user, { displayName: name });
    await updateDoc(doc(db, 'users', user.uid), { username: name, facebook, contactEmail });
    toast('บันทึกข้อมูลแล้ว', 'success');
  } catch (err) { console.warn(err); toast('บันทึกไม่สำเร็จ กรุณาลองใหม่', 'error'); }
  finally { btn.disabled = false; }
});

$('form-password').addEventListener('submit', async (e) => {
  e.preventDefault();
  const cur = $('pw-current').value, p1 = $('pw-new').value, p2 = $('pw-confirm').value;
  if (p1.length < 6) { toast('รหัสผ่านใหม่ต้องมีอย่างน้อย 6 ตัวอักษร', 'error'); return; }
  if (p1 !== p2) { toast('ยืนยันรหัสผ่านไม่ตรงกัน', 'error'); return; }
  const btn = $('pw-save'); btn.disabled = true; btn.textContent = 'กำลังอัปเดต…';
  try {
    await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, cur));
    await updatePassword(user, p1);
    e.target.reset();
    toast('เปลี่ยนรหัสผ่านแล้ว', 'success');
  } catch (err) {
    const c = err?.code || '';
    toast(c === 'auth/wrong-password' || c === 'auth/invalid-credential' ? 'รหัสผ่านปัจจุบันไม่ถูกต้อง' : c === 'auth/too-many-requests' ? 'ลองหลายครั้งเกินไป กรุณารอสักครู่' : 'เปลี่ยนรหัสผ่านไม่สำเร็จ', 'error');
  } finally { btn.disabled = false; btn.textContent = 'อัปเดตรหัสผ่าน'; }
});

async function accountSignOut() {
  if (!confirm('ออกจากระบบใช่หรือไม่?')) return;
  await signOut(auth).catch(() => {});
  location.href = '../home.html';
}

window.addEventListener('hashchange', () => { if (location.hash === '#orders') switchAccountTab('ids'); });
Object.assign(window, { switchAccountTab, accountSignOut });
switchAccountTab(location.hash === '#settings' ? 'settings' : 'ids');
