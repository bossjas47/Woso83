import { db, auth } from "../firebase-config.js";
import { collection, doc, onSnapshot, query, updateDoc, where } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { onAuthStateChanged, signOut, updateProfile, EmailAuthProvider, reauthenticateWithCredential, updatePassword } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { esc, num, toast, fmtDate, icon, ICONS } from "./ui.js";
import { orderCardHtml } from "./orders-ui.js";
import { ensureProfile } from "./profile.js";

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
  $('acc-balance').textContent = `${num(profile.walletBalance).toLocaleString('th-TH', { maximumFractionDigits: 2 })}฿`;
  const suspended = profile.status === 'suspended';
  $('acc-status').innerHTML = `<span class="w-2 h-2 rounded-full ${suspended ? 'bg-launchOrange' : 'bg-emerald-500'}"></span>${suspended ? 'ถูกระงับการใช้งาน' : 'บัญชีปกติ'}`;
  const contact = [profile.facebook && `Facebook: ${profile.facebook}`, profile.contactEmail && `อีเมล: ${profile.contactEmail}`].filter(Boolean).join(' · ');
  $('acc-contact').textContent = contact;
  if (document.activeElement?.closest?.('#form-profile') == null) {
    $('pf-name').value = name;
    $('pf-facebook').value = profile.facebook || '';
    $('pf-email').value = profile.contactEmail || (/@tactical\.store$/.test(user.email || '') ? '' : user.email || '');
  }
}

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
    ? `<a href="queue.html" class="flex items-center justify-between soft-card px-5 py-3.5 text-[15px]"><span>ดูคิวงานทั้งหมดของร้าน</span>${icon('M9 6l6 6-6 6', 'w-4 h-4 text-steel', 2)}</a>` + srv.map(orderCardHtml).join('')
    : empty('ยังไม่มีงานบริการ', 'category.html', 'ดูบริการ');
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
    const claims = (await u.getIdTokenResult()).claims;
    if (claims.admin === true) {
      $('acc-role').textContent = 'ผู้ดูแลระบบ';
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
