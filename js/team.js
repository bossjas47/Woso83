import { db, auth } from "../firebase-config.js";
import { collection, doc, onSnapshot, query, where, deleteDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { esc, toast, callWorker } from "./ui.js";
import { COLORS, DEFAULT_LABELS, labelOf, copyLine, sheetHtml, bindSheet, editing } from "./sheet.js";

/**
 * ทีมของฉัน (member side). A signed-in user can belong to many leaders' team tabs (vault_members/{member}_{owner}_{tab},
 * written by the Worker on invite or join). Rows are read and edited only through the Worker (ammo, status, note);
 * add / delete / move / sell stay with the leader. The sheet refreshes every 15 s while the page is visible.
 */
const $ = (id) => document.getElementById(id);
let uid = '', me = '', flt = -1, teams = [], cur = '', rows = [], labels = DEFAULT_LABELS, name = '', q = '', sort = '', timer = 0, unsub = null;
const team = () => teams.find(t => t.id === cur);
const view = () => { const r = rows.filter(x => (flt < 0 || (x.color || 0) === flt) && (!q || x.text.toLowerCase().includes(q) || String(x.note || '').toLowerCase().includes(q))); return sort === 'ammo' ? r.slice().sort((a, b) => (b.ammo || 0) - (a.ammo || 0)) : r; };
const copy = async (text, msg) => { try { await navigator.clipboard.writeText(text); toast(msg, 'success'); } catch (_) { toast('คัดลอกไม่ได้ กดค้างที่ข้อความแล้วคัดลอกเอง', 'error'); } };

const fmt = (n) => Number(n).toLocaleString('th-TH');
const ammoOf = (r) => r.reduce((a, x) => a + (Number(x.ammo) || 0), 0);
function renderTeams() {
  if (!teams.some(t => t.id === cur)) { cur = teams[0]?.id || ''; rows = []; flt = -1; load(); } // first team, or the one just left
  $('t-teams').innerHTML = teams.length ? teams.map(t => `<button type="button" onclick="tPick('${esc(t.id)}')" class="vx-item ${t.id === cur ? 'on' : ''}"><span class="nm">${esc(t.tabName || '')} <span style="opacity:.6;font-weight:400">· ${esc(t.ownerName || 'หัวหน้า')}</span></span></button>`).join('')
    : '<p class="text-sm text-slate px-3">ยังไม่มี</p>';
  $('t-bar').classList.toggle('hidden', !cur);
  render();
}
function render() {
  if (editing($('t-list'))) return; // a refresh must not wipe a cell being typed
  const t = team();
  if (!t) { $('t-head').innerHTML = '<p class="vx-kicker">ทีมของฉัน</p><h1 class="vx-title">ยังไม่ได้อยู่ในทีมไหน</h1>'; $('t-list').innerHTML = '<div class="vx-empty"><b>ให้หัวหน้าเชิญคุณ</b>ส่งชื่อผู้ใช้ของคุณ (ด้านล่าง) ให้หัวหน้า หรือวางลิงก์เชิญที่ได้รับ</div>'; return; }
  const counts = DEFAULT_LABELS.map((_, i) => rows.filter(x => (x.color || 0) === i).length);
  $('t-head').innerHTML = `<p class="vx-kicker flex items-center justify-between gap-3"><span>ทีมของ ${esc(t.ownerName || 'หัวหน้า')}</span><button type="button" onclick="tLeave()" class="text-[13px] font-normal text-launchOrange">ออกจากทีม</button></p><h1 class="vx-title">${esc(name || t.tabName)}</h1>
    <div class="vx-stats"><div class="vx-stat"><b>${fmt(rows.length)}</b><span>ไอดี</span></div><div class="vx-stat"><b>${fmt(ammoOf(rows))}</b><span>กระสุน (กอง)</span></div></div>
    <div class="vx-chips"><button type="button" class="vx-chip ${flt === -1 ? 'on' : ''}" onclick="tFlt(-1)">ทั้งหมด <i>${fmt(rows.length)}</i></button>${counts.map((n, i) => n ? `<button type="button" class="vx-chip ${flt === i ? 'on' : ''}" onclick="tFlt(${i})">${i ? `<span class="sh-dot" style="background:${COLORS[i]}"></span>` : ''}${esc(i ? labelOf(labels, i) : 'ยังไม่ตั้งสถานะ')} <i>${fmt(n)}</i></button>` : '').join('')}</div>`;
  const r = view();
  $('t-list').innerHTML = r.length ? sheetHtml(r, { labels, sort }) : `<div class="vx-empty">${rows.length ? 'ไม่พบรายการที่ตรงกับตัวกรอง' : '<b>ยังไม่มีงาน</b>รอหัวหน้าย้ายไอดีเข้าทีมนี้'}</div>`;
}
async function load() {
  clearInterval(timer);
  const t = team(); render(); if (!t) return;
  try {
    const j = await callWorker('/vault/team', { owner: t.owner, tabId: t.tabId });
    if (team() !== t) return;
    rows = j.ids || []; labels = j.labels?.length ? j.labels : DEFAULT_LABELS; name = j.name || ''; render();
  } catch (e) { $('t-list').innerHTML = `<p class="py-10 text-center text-launchOrange">${esc(e.message)}</p>`; return; }
  timer = setInterval(() => { if (!document.hidden && !editing($('t-list'))) callWorker('/vault/team', { owner: t.owner, tabId: t.tabId }).then(j => { if (team() === t) { rows = j.ids || []; labels = j.labels?.length ? j.labels : DEFAULT_LABELS; render(); } }).catch(() => {}); }, 15000);
}
async function join(token) {
  try { const r = await callWorker('/vault/join', { token }); toast(`เข้าร่วมทีม ${r.tabName || ''} แล้ว`, 'success'); cur = r.id || cur; }
  catch (e) { toast(e.message || 'เข้าร่วมไม่สำเร็จ', 'error'); }
}

Object.assign(window, {
  tPick: (id) => { cur = id; rows = []; q = ''; flt = -1; $('t-q').value = ''; renderTeams(); load(); },
  tSortAmmo: () => { sort = sort === 'ammo' ? '' : 'ammo'; render(); },
  tFlt: (i) => { flt = flt === i ? -1 : i; render(); },
  tCopyMe: () => me && copy(me, 'คัดลอกชื่อผู้ใช้แล้ว'),
  tLoad: load,
  tFilter: () => { q = $('t-q').value.trim().toLowerCase(); render(); },
  tCopyAll: () => { const r = view(); return r.length ? copy(r.map(copyLine).join('\n'), `คัดลอก ${r.length} ไอดีแล้ว`) : toast('ยังไม่มีงาน', 'error'); },
  tJoin: async (e) => { e.preventDefault(); const code = $('t-code').value.trim().replace(/^.*[?&]join=/, ''); if (!code) return; await join(code); $('t-code').value = ''; },
  tLeave: async () => {
    const t = team(); if (!t || !confirm(`ออกจากทีม ${t.ownerName || ''} · ${t.tabName || ''}?`)) return;
    try { await deleteDoc(doc(db, 'vault_members', t.id)); toast('ออกจากทีมแล้ว', 'success'); } catch (e) { toast('ทำรายการไม่สำเร็จ', 'error'); }
  }
});
bindSheet($('t-list'), {
  onEdit: async (id, f, v) => {
    const t = team(), x = rows.find(r => r.id === id); if (!t || !x) return;
    const old = x[f]; x[f] = v;
    try { await callWorker('/vault/team/mark', { owner: t.owner, tabId: t.tabId, id, [f]: v }); }
    catch (e) { x[f] = old; render(); toast(e.message, 'error'); }
  },
  onCopy: (id) => { const x = rows.find(r => r.id === id); if (x) copy(copyLine(x), 'คัดลอกแล้ว'); },
  onSort: (k) => { sort = sort === k ? '' : k; render(); }
});

onAuthStateChanged(auth, async (u) => {
  unsub?.(); unsub = null; clearInterval(timer); uid = u?.uid || ''; teams = []; cur = '';
  const joinToken = new URLSearchParams(location.search).get('join');
  if (!u) {
    $('t-app').classList.add('hidden'); $('t-gate').classList.remove('hidden');
    $('t-gate').innerHTML = `<p class="font-semibold">เข้าสู่ระบบเพื่อดูทีมของคุณ</p><p class="text-sm text-slate mt-2">ลูกทีมไม่ต้องซื้อสิทธิ์ บัญชีเดียวเข้าได้หลายทีม</p><a href="login.html?mode=login&next=${encodeURIComponent('team.html' + location.search)}" class="apple-pricing-pill px-6 py-2.5 text-[15px] mt-4">เข้าสู่ระบบ</a>`;
    return;
  }
  $('t-gate').classList.add('hidden'); $('t-app').classList.remove('hidden');
  me = u.displayName || (u.email || '').split('@')[0]; $('t-me').textContent = me;
  if (joinToken) { history.replaceState(null, '', location.pathname); await join(joinToken); }
  unsub = onSnapshot(query(collection(db, 'vault_members'), where('member', '==', uid)), (s) => {
    teams = s.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => String(a.ownerName).localeCompare(String(b.ownerName)) || String(a.tabName).localeCompare(String(b.tabName)));
    renderTeams();
  }, (e) => { console.warn('teams:', e); renderTeams(); });
});
