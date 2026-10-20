import { db, auth } from "../../firebase-config.js";
import { collection, doc, getDocs, onSnapshot, query, orderBy, limit, setDoc, serverTimestamp, Timestamp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { esc, num, money, toast, fmtDate } from "../ui.js";

/**
 * Back office: ID vault program (โปรแกรมจัดการไอดีไก่). Who has access (users/{uid}.vaultUntil), usage per user
 * (counts under vaults/{uid}/ids and /team), purchases and grants (vault_sales), packages / free trial (system/settings).
 */
const $ = (id) => document.getElementById(id);
const DAY = 864e5;
const ms = (v) => v?.toMillis?.() ?? (v ? new Date(v).getTime() : 0);
const users = () => window.getAdminUsers?.() || [];
let SALES = [], USAGE = {}, started = false, loading = false;

export function startVaultWatch() {
  if (started) return;
  started = true;
  onSnapshot(query(collection(db, 'vault_sales'), orderBy('at', 'desc'), limit(200)), (s) => { SALES = s.docs.map(d => ({ id: d.id, ...d.data() })); renderAdminVault(); },
    (e) => console.warn('vault_sales:', e));
  loadUsage();
}

/** One-off counts per user who ever had access (few users; re-run with the refresh button). */
async function loadUsage() {
  if (loading) return; loading = true;
  const list = users().filter(u => u.vaultUntil || u.vaultTrialUsed);
  await Promise.all(list.map(async (u) => {
    try {
      const [ids, team] = await Promise.all([getDocs(collection(db, 'vaults', u.uid, 'ids')), getDocs(collection(db, 'vaults', u.uid, 'team'))]);
      USAGE[u.uid] = { ids: ids.size, team: team.size };
    } catch (e) { console.warn('vault usage', u.uid, e); }
  }));
  loading = false; renderAdminVault();
}

export function renderAdminVault() {
  if (!$('vault-users')) return;
  const now = Date.now();
  const list = users().filter(u => u.vaultUntil || u.vaultTrialUsed).sort((a, b) => ms(b.vaultUntil) - ms(a.vaultUntil));
  const active = list.filter(u => ms(u.vaultUntil) > now);
  const paid = SALES.filter(s => !s.trial && s.by !== 'admin');
  const tile = (label, value) => `<div class="apple-card p-4"><p class="text-[11px] text-slate">${label}</p><p class="text-2xl font-display font-semibold mt-1">${value}</p></div>`;
  $('vault-stats').innerHTML = tile('ใช้งานอยู่', active.length) + tile('หมดอายุ', list.length - active.length)
    + tile('ใช้สิทธิ์ทดลองฟรีแล้ว', users().filter(u => u.vaultTrialUsed).length) + tile('รายได้จากแพ็กเกจ', `฿${money(paid.reduce((a, s) => a + num(s.price), 0), 0)}`);

  $('vault-users').innerHTML = list.length ? list.map(u => {
    const t = ms(u.vaultUntil), left = Math.ceil((t - now) / DAY), on = t > now, use = USAGE[u.uid];
    const btn = (days, text) => `<button type="button" onclick="vaultGrant('${esc(u.uid)}', ${days})" class="apple-explore-pill px-3 py-1 text-[11px]">${text}</button>`;
    return `<tr class="border-b border-hairline">
      <td class="py-3 px-4"><div class="font-medium">${esc(u.username || u.email || u.uid)}</div><div class="text-[11px] text-slate">${esc(u.email || '')}${u.vaultTrialUsed ? ' · ใช้ทดลองฟรีแล้ว' : ''}</div></td>
      <td class="py-3 px-4">${on ? `<span class="font-semibold">ใช้งานอยู่</span><div class="text-[11px] text-slate">เหลือ ${left} วัน · ถึง ${esc(fmtDate(t))}</div>` : `<span class="text-launchOrange">หมดอายุ</span><div class="text-[11px] text-slate">${t ? esc(fmtDate(t)) : '-'}</div>`}</td>
      <td class="py-3 px-4 font-mono">${use ? use.ids : '…'}</td>
      <td class="py-3 px-4 font-mono">${use ? use.team : '…'}</td>
      <td class="py-3 px-4 text-right whitespace-nowrap space-x-1">${btn(7, '+7 วัน')}${btn(30, '+30 วัน')}${on ? btn(-7, '−7 วัน') + btn(0, 'ปิดสิทธิ์') : ''}</td>
    </tr>`;
  }).join('') : '<tr><td colspan="5" class="py-10 text-center text-slate">ยังไม่มีผู้ใช้ที่มีสิทธิ์</td></tr>';

  const who = (uid) => { const u = users().find(x => x.uid === uid); return u?.username || u?.email || uid; };
  $('vault-sales').innerHTML = SALES.length ? SALES.slice(0, 100).map(s => `<tr class="border-b border-hairline">
      <td class="py-3 px-4 text-slate">${esc(fmtDate(s.at))}</td>
      <td class="py-3 px-4">${esc(s.email || who(s.uid))}</td>
      <td class="py-3 px-4">${s.trial ? 'ทดลองฟรี' : s.by === 'admin' ? `แอดมินปรับ ${num(s.days) > 0 ? '+' : ''}${esc(s.days)} วัน` : `แพ็กเกจ ${esc(s.days)} วัน`}</td>
      <td class="py-3 px-4 font-mono text-right">${num(s.price) ? `฿${money(s.price)}` : '-'}</td>
    </tr>`).join('') : '<tr><td colspan="4" class="py-10 text-center text-slate">ยังไม่มีประวัติ</td></tr>';

  const dl = $('vault-user-list');
  if (dl) dl.innerHTML = users().map(u => `<option value="${esc(u.username || u.email)}">${esc(u.email || '')}</option>`).join('');
}

/** +N days on top of what is left (never before now), −N days, or 0 = close now. Every change is logged in vault_sales. */
async function vaultGrant(uid, days) {
  const u = users().find(x => x.uid === uid); if (!u) return toast('ไม่พบผู้ใช้', 'error');
  if (days === 0 && !confirm(`ปิดสิทธิ์คลังไอดีของ ${u.username || u.email} ตอนนี้?`)) return;
  const cur = Math.max(Date.now(), ms(u.vaultUntil));
  const until = days === 0 ? 0 : cur + days * DAY;
  try {
    await setDoc(doc(db, 'users', uid), { vaultUntil: until > Date.now() ? Timestamp.fromMillis(until) : null }, { merge: true });
    await setDoc(doc(collection(db, 'vault_sales')), { uid, email: u.email || '', days: days === 0 ? -Math.ceil((ms(u.vaultUntil) - Date.now()) / DAY) : days, price: 0, trial: false, by: 'admin', admin: auth.currentUser?.uid || '', at: serverTimestamp() });
    toast(days === 0 ? 'ปิดสิทธิ์แล้ว' : `${days > 0 ? 'เพิ่ม' : 'ลด'} ${Math.abs(days)} วันแล้ว`, 'success');
  } catch (e) { console.warn(e); toast('บันทึกไม่สำเร็จ', 'error'); }
}

function vaultGrantForm(e) {
  e.preventDefault();
  const q = $('vault-grant-user').value.trim().toLowerCase(), days = Math.round(num($('vault-grant-days').value));
  const u = users().find(x => [x.username, x.email, x.uid].some(v => String(v || '').toLowerCase() === q));
  if (!u) return toast('ไม่พบผู้ใช้นี้ (พิมพ์ชื่อผู้ใช้หรืออีเมลให้ตรง)', 'error');
  if (!(days >= 1 && days <= 365)) return toast('ใส่จำนวนวัน 1-365', 'error');
  vaultGrant(u.uid, days).then(() => { $('vault-grant-user').value = ''; loadUsage(); });
}

document.addEventListener('adminusers', () => { if (started) renderAdminVault(); });
Object.assign(window, { startVaultWatch, renderAdminVault, vaultGrant, vaultGrantForm, vaultReloadUsage: () => { USAGE = {}; renderAdminVault(); loadUsage(); } });
