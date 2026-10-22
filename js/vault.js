import { db, auth } from "../firebase-config.js";
import { collection, doc, onSnapshot, query, where, orderBy, limit, writeBatch, updateDoc, setDoc, deleteDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { esc, toast, money, openModal, closeModal, onSettings, contactsOf, callWorker } from "./ui.js";
import { enablePush } from "./push.js";
import { SALE_TEMPLATES, fillTemplate } from "./sale-templates.js";
import { COLORS, DEFAULT_LABELS, labelOf, parseLine, copyLine, exportLine, priceOf, money as baht, sheetHtml, sumText, bindSheet, editing } from "./sheet.js";

/**
 * ID stock (leader side). Tabs: คลัง (the leader's stock) and ทีม (one per member group). A sheet per tab:
 * ไอดี | กระสุน | สถานะ (6 colours, named by the leader) | หมายเหตุ. + สต๊อก (dedup against every tab and 180 days of sales),
 * ย้าย (selected / count / random), ขาย (selected / count -> copy for the customer + sales history).
 * Team tabs are shared with signed-in members (invite by username, or an invite link); members work in team.html through the Worker.
 * Data: vaults/{uid}/{tabs,ids,sold,sales,trash,logs,meta}; vault_members (Worker-written); vault_links (invite tokens).
 */
const $ = (id) => document.getElementById(id);
const ms = (v) => v?.toMillis?.() ?? (v ? new Date(v).getTime() : 0);
const label = (t) => String(t).split(/[|:\s]/)[0].slice(0, 40);
const when = (v) => new Date(ms(v) || Date.now()).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' });
export const keyOf = (t) => String(t).trim().toLowerCase(); // duplicate check ignores case and outer spaces
const SOLD_DAYS = 180, DAY = 864e5;
const ZONE = { boss: 'คลัง', team: 'ทีม' };
let notifyCfg = {}, hasSub = false, uid = '', tabs = [], ids = [], sold = [], sales = [], logs = [], trash = [], members = [], labels = DEFAULT_LABELS.slice(), cur = '', sel = new Set(), subs = [], q = '', sort = '', flt = -1, started = false, ST = {}, trialUsed = false;
const col = (n) => collection(db, 'vaults', uid, n);
const zoneTabs = (z) => tabs.filter(t => (t.zone || 'boss') === z);
const curTab = () => tabs.find(t => t.id === cur);
const seqOf = (x) => x.seq || ms(x.createdAt); // seq keeps the pasted order (one import shares one server timestamp)
const tabIds = (t = cur) => ids.filter(x => x.tab === t).sort((a, b) => seqOf(a) - seqOf(b) || a.id.localeCompare(b.id));
const viewIds = () => { const r = tabIds().filter(x => (flt < 0 || (x.color || 0) === flt) && (!q || x.text.toLowerCase().includes(q) || String(x.note || '').toLowerCase().includes(q))); return sort === 'ammo' ? r.sort((a, b) => (b.ammo || 0) - (a.ammo || 0)) : r; };
const tabName = (id) => tabs.find(t => t.id === id)?.name || '';
const tabLabel = (id) => { const t = tabs.find(x => x.id === id); return t ? `${ZONE[t.zone || 'boss']} ${t.name}` : '-'; };
const picked = () => ids.filter(x => sel.has(x.id));
const extras = (x) => Object.fromEntries(['pass', 'priceAmmo', 'priceAll'].filter(k => x[k]).map(k => [k, x[k]])); // optional fields travel with the ID
const toTrash = (rows) => rows.flatMap(x => [['set', doc(col('trash'), x.id), { text: x.text, tab: x.tab, tabName: tabName(x.tab), ammo: x.ammo || 0, color: x.color || 0, note: x.note || '', ...extras(x), deletedAt: serverTimestamp() }], ['delete', doc(col('ids'), x.id)]]);

/** Writes in chunks of 450 (batch limit 500), then one history row, so every action is recorded. */
async function commit(writes, action, detail, items = []) {
  const all = [...writes, ['set', doc(col('logs')), { action, detail, count: items.length, items: items.map(label).slice(0, 100), at: serverTimestamp() }]];
  for (let i = 0; i < all.length; i += 450) {
    const b = writeBatch(db);
    all.slice(i, i + 450).forEach(([k, ref, data]) => (k === 'delete' ? b.delete(ref) : k === 'update' ? b.update(ref, data) : b.set(ref, data)));
    await b.commit();
  }
}
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { console.warn(e); toast(e.message && /[ก-๙]/.test(e.message) ? e.message : 'ทำรายการไม่สำเร็จ ลองใหม่อีกครั้ง', 'error'); } };

/** Splits pasted lines into new / duplicate (against the vault, the last 180 days of sales, and earlier lines of the paste). */
export function splitNew(lines, haveKeys) {
  const seen = new Set(haveKeys), fresh = [], dup = [];
  for (const raw of lines) {
    const p = parseLine(raw); if (!p.text) continue;
    if (p.text.length > 300) { dup.push(p.text); continue; }
    const k = keyOf(p.text);
    if (seen.has(k)) dup.push(p.text); else { seen.add(k); fresh.push(p); }
  }
  return { fresh, dup };
}
const knownKeys = () => [...ids.map(x => x.key || keyOf(x.text)), ...sold.filter(x => !x.at || ms(x.at) > Date.now() - SOLD_DAYS * DAY).map(x => x.key)];

// ---------- modal ----------
function modal(title, hint, body, ok, onOk, alt, onAlt) {
  $('vm-title').textContent = title; $('vm-hint').textContent = hint || ''; $('vm-body').innerHTML = body;
  const run = (fn) => guard(async () => { if ((await fn()) !== false) closeModal('v-modal'); });
  $('vm-ok').textContent = ok; $('vm-ok').onclick = run(onOk);
  $('vm-alt').classList.toggle('hidden', !alt); if (alt) { $('vm-alt').textContent = alt; $('vm-alt').onclick = run(onAlt); }
  openModal('v-modal');
}
const later = (fn) => setTimeout(fn, 0); // open a follow-up modal after the current one closes
const field = (id, extra = '') => `<input id="${id}" class="w-full apple-input px-3.5 py-2.5 text-[15px]" ${extra}>`;
const copyBox = (text) => `<textarea id="vm-out" readonly rows="8" class="w-full apple-input px-3.5 py-2.5 text-[13px] font-mono">${esc(text)}</textarea>`;
async function copy(text, msg = 'คัดลอกแล้ว') {
  try { await navigator.clipboard.writeText(text); toast(msg, 'success'); return true; } catch (_) { toast('คัดลอกอัตโนมัติไม่ได้ กดค้างที่ข้อความแล้วคัดลอกเอง', 'error'); return false; }
}

// ---------- render ----------
const ammoOf = (rows) => rows.reduce((a, x) => a + (Number(x.ammo) || 0), 0);
const fmt = (n) => Number(n).toLocaleString('th-TH');
function render() {
  if (editing($('v-list'))) { renderLater = true; return; } // a snapshot must not wipe a cell being typed
  if (!tabs.some(t => t.id === cur)) cur = zoneTabs('boss')[0]?.id || tabs[0]?.id || '';
  const t = curTab(), all = tabIds();
  // sidebar
  const item = (x) => { const r = tabIds(x.id), m = members.filter(y => y.tabId === x.id).length; return `<button type="button" onclick="vTab('${x.id}')" class="vx-item ${x.id === cur ? 'on' : ''}"><span class="nm">${esc(x.name)}</span><span class="ct">${fmt(r.length)} · ${fmt(ammoOf(r))} กอง${x.zone === 'team' ? ` · ${m} คน` : ''}</span></button>`; };
  $('v-side').innerHTML = ['boss', 'team'].map(z => `<div class="vx-group"><h3>${z === 'boss' ? 'คลังของฉัน' : 'ทีม'}</h3><div class="vx-items">${zoneTabs(z).map(item).join('')}<button type="button" class="vx-add" onclick="vNewTab('${z}')">+ ${z === 'boss' ? 'คลังใหม่' : 'ทีมใหม่'}</button></div></div>`).join('');
  // header: title, totals, status chips (tap = filter)
  const counts = DEFAULT_LABELS.map((_, i) => all.filter(x => (x.color || 0) === i).length);
  $('v-head').innerHTML = t ? `<p class="vx-kicker">${t.zone === 'team' ? 'ทีม' : 'คลัง'}</p><h1 class="vx-title">${esc(t.name)}</h1>
    <div class="vx-stats"><div class="vx-stat"><b>${fmt(all.length)}</b><span>ไอดี</span></div><div class="vx-stat"><b>${fmt(ammoOf(all))}</b><span>กระสุน (กอง)</span></div>${t.zone === 'team' ? `<div class="vx-stat"><b>${members.filter(m => m.tabId === cur).length}</b><span>ลูกทีม</span></div>` : ''}</div>
    <div class="vx-chips"><button type="button" class="vx-chip ${flt === -1 ? 'on' : ''}" onclick="vFlt(-1)">ทั้งหมด <i>${fmt(all.length)}</i></button>${counts.map((n, i) => n ? `<button type="button" class="vx-chip ${flt === i ? 'on' : ''}" onclick="vFlt(${i})">${i ? `<span class="sh-dot" style="background:${COLORS[i]}"></span>` : ''}${esc(i ? labelOf(labels, i) : 'ยังไม่ตั้งสถานะ')} <i>${fmt(n)}</i></button>` : '').join('')}</div>`
    : `<p class="vx-kicker">คลังไอดี</p><h1 class="vx-title">เริ่มต้นใช้งาน</h1>`;
  $('v-add').classList.toggle('hidden', t?.zone === 'team' || !t);
  // team panel
  const mem = members.filter(m => m.tabId === cur);
  $('v-team').innerHTML = t?.zone === 'team' ? `<div class="vx-team">
      <div class="flex flex-wrap items-center gap-2">${mem.length ? mem.map(m => `<span class="vx-member">${esc(m.memberName || 'ผู้ใช้')}<button type="button" onclick="vKick('${esc(m.id)}')" title="เตะออกจากทีม" aria-label="เตะ ${esc(m.memberName || '')} ออกจากทีม">เตะออก</button></span>`).join('') : '<span class="text-sm text-slate">ยังไม่มีลูกทีมในทีมนี้</span>'}</div>
      <form onsubmit="vInvite(event)"><input id="v-invite" autocomplete="off" placeholder="ชื่อผู้ใช้ของลูกทีม" aria-label="ชื่อผู้ใช้ของลูกทีม"><button type="submit" class="vx-btn pri">เชิญ</button><button type="button" onclick="vInviteLink()" class="vx-btn">ลิงก์เชิญ</button></form>
      <p class="text-[12px] text-slate">ลูกทีมเห็นทีมนี้ในหน้า "ทีมของฉัน" แก้ได้แค่ กระสุน สถานะ หมายเหตุ</p></div>` : '';
  // list
  const rows = viewIds();
  sel = new Set([...sel].filter(id => all.some(x => x.id === id)));
  $('v-list').innerHTML = !tabs.length ? `<div class="vx-empty"><b>สร้างคลังแรก</b>กด "+ คลังใหม่" ตั้งชื่อ เช่น Mail H4 แล้วกด "+ สต๊อก" วางไอดี</div>`
    : rows.length ? sheetHtml(rows.slice(0, 1000), { labels, selectable: true, sel, sort }) + (rows.length > 1000 ? `<p class="py-3 text-center text-xs text-slate">แสดง 1,000 จาก ${fmt(rows.length)} รายการ</p>` : '')
      : all.length ? '<div class="vx-empty">ไม่พบรายการที่ตรงกับตัวกรอง</div>' : `<div class="vx-empty"><b>แท็บนี้ยังว่าง</b>${t?.zone === 'team' ? 'ไปที่คลัง ติ๊กไอดี แล้วกดชื่อทีมนี้ในแถบด้านล่างเพื่อย้ายมา' : 'กด "+ สต๊อก" วางไอดี บรรทัดละ 1 (ท้ายบรรทัด |20 = 20 กอง)'}</div>`;
  const all1 = $('v-list').querySelector('[data-selall]'); if (all1) all1.indeterminate = !all1.checked && rows.some(x => sel.has(x.id));
  $('v-trash-n').textContent = trash.length ? `(${trash.length})` : '';
  // selection bar
  const pk = picked();
  $('v-bar').classList.toggle('on', pk.length > 0);
  $('v-bar-n').textContent = `เลือก ${fmt(pk.length)} ไอดี`;
  $('v-bar-sum').textContent = `· ${fmt(ammoOf(pk))} กอง`;
  $('v-dest').innerHTML = `<small>ย้ายไป</small>${tabs.filter(x => x.id !== cur).map(x => `<button type="button" onclick="vMoveTo('${x.id}')">${esc(x.name)}</button>`).join('') || '<small>สร้างแท็บอื่นก่อน</small>'}`;
  // history
  $('v-sales-n').textContent = sales.length ? `(${sales.length})` : '';
  $('v-sales').innerHTML = sales.length ? sales.map(s => `<details class="row px-4 py-3"><summary class="cursor-pointer flex justify-between gap-3 text-[14px]"><span>ขาย <b>${s.count}</b> ไอดี${s.ammo ? ` · ${fmt(s.ammo)} กอง` : ''}${s.total ? ` · ${baht(s.total)}` : ''} · ${esc(s.tabLabel || s.tabName || '-')}</span><span class="text-xs text-slate shrink-0">${when(s.at)}</span></summary>
      <textarea readonly rows="4" class="mt-2 w-full apple-input px-3 py-2 text-[12px] font-mono">${esc((s.items || []).join('\n'))}</textarea>
      <button type="button" onclick="vCopySale('${s.id}')" class="mt-1 text-appleBlue text-[13px]">คัดลอกทั้งหมด</button></details>`).join('') : '<p class="px-4 py-6 text-center text-slate text-sm">ยังไม่มีการขาย</p>';
  const ACT = { edit: 'แก้ไข', add: 'เติมสต๊อก', export: 'ย้าย', sell: 'ขาย', delete: 'ลบ', tab: 'แท็บ', token: 'ลิงก์เชิญ', restore: 'กู้คืน', trash: 'ถังขยะ', member: 'ลูกทีม' };
  $('v-logs').innerHTML = logs.length ? logs.map(l => `<details class="row px-4 py-3"><summary class="cursor-pointer flex justify-between gap-3 text-[14px]"><span><b>${ACT[l.action] || esc(l.action)}</b> · ${esc(l.detail)}</span><span class="text-xs text-slate shrink-0">${when(l.at)}</span></summary>
      ${l.items?.length ? `<p class="mt-2 text-xs text-slate break-all font-mono">${l.items.map(esc).join(', ')}${l.count > l.items.length ? ` …+${l.count - l.items.length}` : ''}</p>` : ''}</details>`).join('') : '<p class="px-4 py-6 text-center text-slate text-sm">ยังไม่มีประวัติ</p>';
}
let renderLater = false;
document.addEventListener('focusout', () => { if (renderLater) setTimeout(() => { if (!editing($('v-list'))) { renderLater = false; render(); } }, 0); });

// ---------- actions ----------
async function sellRows(rows) {
  const saleRef = doc(col('sales')), items = rows.map(exportLine), ammo = ammoOf(rows), total = rows.reduce((a, x) => a + priceOf(x), 0);
  await commit([
    ['set', saleRef, { count: rows.length, ammo, total, tab: cur, tabName: tabName(cur), tabLabel: tabLabel(cur), items, at: serverTimestamp() }],
    ...rows.flatMap(x => [['set', doc(col('sold')), { key: x.key || keyOf(x.text), text: x.text, tab: cur, saleId: saleRef.id, at: serverTimestamp() }], ['delete', doc(col('ids'), x.id)]])
  ], 'sell', `ขาย ${rows.length} ไอดี${ammo ? ` (${ammo} กอง)` : ''} จาก ${tabLabel(cur)}`, items);
  sel.clear();
}
const tok = () => Array.from(crypto.getRandomValues(new Uint8Array(24)), b => 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 56]).join('');
const joinUrl = (t) => new URL(`team.html?join=${t}`, location.href).href;
const shuffle = (a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

Object.assign(window, {
  vTab: (id) => { cur = id; sel.clear(); flt = -1; q = ''; $('v-q').value = ''; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); },
  vFilter: () => { q = $('v-q').value.trim().toLowerCase(); render(); },
  vFlt: (i) => { flt = flt === i ? -1 : i; render(); },
  vClear: () => { sel.clear(); render(); },
  vSortAmmo: () => { sort = sort === 'ammo' ? '' : 'ammo'; render(); },
  /** One step to pick work: the first N (oldest) or N at random among what is shown. */
  vQuick: (how) => {
    const rows = viewIds(), n = Math.round(Number($('v-n').value));
    if (!rows.length) return toast('ไม่มีรายการให้ติ๊ก', 'error');
    if (!(n >= 1)) return toast('ใส่จำนวนที่จะติ๊ก', 'error');
    const base = sort ? tabIds().filter(x => rows.includes(x)) : rows; // "แรก" always means oldest first
    sel = new Set((how === 'rand' ? shuffle(rows) : base).slice(0, n).map(x => x.id)); render();
    if (n > rows.length) toast(`มีแค่ ${rows.length} รายการ ติ๊กทั้งหมดแล้ว`);
  },

  vNewTab: (zone) => modal(zone === 'boss' ? 'คลังใหม่' : 'ทีมใหม่', zone === 'boss' ? 'ตั้งชื่อคลัง เช่น Mail H4' : 'ตั้งชื่อทีม เช่น ทีม 1 หรือชื่อลูกทีม แล้วเชิญลูกทีมเข้ามา', field('vm-name', 'maxlength="30" placeholder="ชื่อ"'), 'สร้าง', async () => {
    const name = $('vm-name').value.trim(); if (!name) return false;
    const ref = doc(col('tabs')); await commit([['set', ref, { name, zone, createdAt: serverTimestamp() }]], 'tab', `สร้าง${ZONE[zone]} ${name}`); cur = ref.id; sel.clear();
  }),
  vRename: () => { const t = curTab(); if (!t) return; modal('เปลี่ยนชื่อแท็บ', '', field('vm-name', `maxlength="30" value="${esc(t.name)}"`), 'บันทึก', async () => {
    const name = $('vm-name').value.trim(); if (!name) return false; await commit([['update', doc(col('tabs'), t.id), { name }]], 'tab', `เปลี่ยนชื่อ ${t.name} → ${name}`);
  }); },
  vDelTab: () => { const t = curTab(); if (!t) return; if (tabIds().length) return toast('ย้ายหรือขายไอดีในแท็บนี้ออกให้หมดก่อน จึงลบแท็บได้', 'error');
    modal('ลบแท็บ', `ลบ "${t.name}"${t.zone === 'team' ? ' ลูกทีมจะถูกเอาออกด้วย' : ''}`, '', 'ลบแท็บ', () => commit([['delete', doc(col('tabs'), cur)], ...(t.token ? [['delete', doc(db, 'vault_links', t.token)]] : []), ...members.filter(m => m.tabId === cur).map(m => ['delete', doc(db, 'vault_members', m.id)])], 'tab', `ลบแท็บ ${tabLabel(cur)}`)); },

  vAdd: () => {
    if (!zoneTabs('boss').length) return toast('สร้างคลังก่อน (กด "+ คลังใหม่")', 'error');
    modal('+ สต๊อก', 'บรรทัดละ 1 ไอดี ท้ายบรรทัด |ตัวเลข = จำนวนกระสุน (เช่น mail|pass|20) ไอดีที่ซ้ำกับในคลังหรือที่ขายไปใน 180 วันจะถูกข้าม',
      `<label class="block text-xs text-slate mb-1" for="vm-tab">เติมเข้า</label><select id="vm-tab" class="w-full apple-input px-3 py-2.5 text-[15px] mb-3">${zoneTabs('boss').map(t => `<option value="${t.id}" ${t.id === cur ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>
      <textarea id="vm-text" rows="8" class="w-full apple-input px-3.5 py-2.5 text-[14px] font-mono" placeholder="mail1@x.com|pass|20&#10;mail2@x.com|pass"></textarea><label class="block mt-2 text-[13px] text-appleBlue">หรือนำเข้าจากไฟล์ .txt / .csv <input type="file" accept=".txt,.csv,text/plain,text/csv" class="block mt-1 text-slate" onchange="vFile(this)"></label>`, 'เพิ่มสต๊อก', async () => {
        const to = $('vm-tab').value;
        const { fresh, dup } = splitNew($('vm-text').value.split('\n'), knownKeys());
        const add = fresh.slice(0, 2000);
        if (add.length) await commit(add.map((p, i) => ['set', doc(col('ids')), { tab: to, text: p.text, key: keyOf(p.text), ammo: p.ammo, color: 0, note: '', seq: Date.now() + i, createdAt: serverTimestamp() }]), 'add', `เติม ${add.length} ไอดี เข้า ${tabLabel(to)}${dup.length ? ` (ซ้ำ ${dup.length})` : ''}`, add.map(p => p.text));
        cur = to;
        if (dup.length || fresh.length > add.length) later(() => modal('สรุปการเติมสต๊อก', '', `<p class="text-[15px]">เพิ่มสำเร็จ <b>${add.length}</b> ไอดี · ซ้ำ <b class="text-launchOrange">${dup.length}</b>${fresh.length > add.length ? ` · เกินครั้งละ 2,000 ข้าม ${fresh.length - add.length}` : ''}</p>${dup.length ? `<p class="text-xs text-slate mt-3 mb-1">ไอดีที่ซ้ำ (ไม่ได้เพิ่ม)</p>${copyBox(dup.join('\n'))}` : ''}`, 'ตกลง', () => {}));
        else toast(`เพิ่ม ${add.length} ไอดีแล้ว`, 'success');
      });
  },
  vFile: async (el) => { const f = el.files[0]; if (!f) return; if (f.size > 1e6) return toast('ไฟล์ใหญ่เกิน 1MB', 'error'); $('vm-text').value = ($('vm-text').value ? $('vm-text').value + '\n' : '') + (await f.text()).replace(/^﻿/, '').trim(); },

  /** Tap a tab name in the selection bar = move there. No dialog; undo is moving back. */
  vMoveTo: guard(async (to) => {
    const rows = picked(); if (!rows.length) return;
    await commit(rows.map(x => ['update', doc(col('ids'), x.id), { tab: to }]), 'export', `ย้าย ${rows.length} ไอดี ${tabLabel(cur)} → ${tabLabel(to)}`, rows.map(x => x.text));
    sel.clear(); render(); toast(`ย้าย ${rows.length} ไอดีไป ${tabName(to)} แล้ว`, 'success');
  }),
  /** Sell = one dialog: the list to send + one button that copies it and cuts the IDs out. */
  vSell: () => {
    const rows = picked(); if (!rows.length) return;
    const ids = rows.map(exportLine).join('\n'), ammo = ammoOf(rows), total = rows.reduce((a, x) => a + priceOf(x), 0);
    let tid = 'raw'; try { tid = localStorage.getItem('v-sale-tpl') || 'raw'; } catch { /* ignore */ }
    if (!SALE_TEMPLATES.some(t => t.id === tid)) tid = 'raw';
    const build = (id) => fillTemplate(id, { ids, count: rows.length, ammo, total });
    modal(`ขาย ${rows.length} ไอดี${ammo ? ` · ${fmt(ammo)} กอง` : ''}${total ? ` · ${baht(total)}` : ''}`, 'เลือกแบบข้อความ แก้ในช่องได้ แล้วกดปุ่มเดียว: คัดลอกส่งลูกค้า ตัดออกจากแท็บ และบันทึกประวัติการขาย',
      `<div id="vm-tpl" class="flex gap-2 overflow-x-auto pb-2 mb-2" role="group" aria-label="แบบข้อความ">${SALE_TEMPLATES.map(t => `<button type="button" data-tpl="${t.id}" class="vx-chip shrink-0 px-3 py-1.5 rounded-full text-[13px] ${t.id === tid ? 'bg-ink text-gallery' : 'bg-mist text-ink'}">${esc(t.label)}</button>`).join('')}</div>
       <textarea id="vm-out" rows="10" class="w-full apple-input px-3.5 py-2.5 text-[13px]">${esc(build(tid))}</textarea>`,
      'คัดลอกและยืนยันขาย', async () => {
        const text = $('vm-out').value; await sellRows(rows); await copy(text, `ขาย ${rows.length} ไอดีแล้ว · คัดลอกข้อความแล้ว`);
      });
    $('vm-tpl').onclick = (e) => {
      const b = e.target.closest('[data-tpl]'); if (!b) return;
      try { localStorage.setItem('v-sale-tpl', b.dataset.tpl); } catch { /* ignore */ }
      $('vm-out').value = build(b.dataset.tpl);
      $('vm-tpl').querySelectorAll('[data-tpl]').forEach(x => { const on = x === b; x.classList.toggle('bg-ink', on); x.classList.toggle('text-gallery', on); x.classList.toggle('bg-mist', !on); x.classList.toggle('text-ink', !on); });
    };
  },
  /** Edit every ticked ID at once: ammo, status, note, password (same for all / one each) and prices. Blank = leave as is. */
  vEdit: () => {
    const rows = picked(); if (!rows.length) return;
    const lab = 'block text-xs text-slate mb-1', inp = 'w-full apple-input px-3 py-2.5 text-[15px]';
    modal(`แก้ ${fmt(rows.length)} ไอดีพร้อมกัน`, 'ช่องที่เว้นว่างไว้ = ไม่เปลี่ยน ใส่เฉพาะที่ต้องการแก้',
      `<div class="grid grid-cols-2 gap-3">
        <div><label class="${lab}" for="vm-ammo">กระสุน (กอง)</label><input id="vm-ammo" type="number" min="0" max="999999" inputmode="numeric" placeholder="ไม่เปลี่ยน" class="${inp}"></div>
        <div><label class="${lab}" for="vm-st">สถานะ</label><select id="vm-st" class="${inp}"><option value="">ไม่เปลี่ยน</option>${DEFAULT_LABELS.map((_, i) => `<option value="${i}">${esc(labelOf(labels, i))}</option>`).join('')}</select></div>
      </div>
      <label class="${lab} mt-3" for="vm-note">หมายเหตุ</label><input id="vm-note" maxlength="200" placeholder="ไม่เปลี่ยน" class="${inp}">
      <label class="mt-1 flex items-center gap-2 text-[13px] text-slate"><input type="checkbox" id="vm-noteclr"> ล้างหมายเหตุของที่เลือก</label>
      <p class="${lab} mt-4">รหัสผ่าน</p>
      <div class="vx-seg" role="radiogroup"><label><input type="radio" name="vm-pm" value="keep" checked onchange="vEditMode()"><span>ไม่เปลี่ยน</span></label><label><input type="radio" name="vm-pm" value="same" onchange="vEditMode()"><span>เหมือนกันทุกเมล</span></label><label><input type="radio" name="vm-pm" value="each" onchange="vEditMode()"><span>แยกแต่ละเมล</span></label></div>
      <div id="vm-same" class="hidden mt-2"><input id="vm-pw" maxlength="100" autocomplete="off" placeholder="รหัสผ่านที่ใช้กับทุกไอดีที่เลือก" class="${inp}"></div>
      <div id="vm-each" class="hidden mt-2"><p class="text-[12px] text-slate mb-2">กรอกทีละเมล หรือวางรหัสหลายบรรทัดลงช่องแรก ระบบจะเรียงลงให้ตามลำดับ</p><div class="vx-each">${rows.map(x => `<div><code title="${esc(x.text)}">${esc(label(x.text))}</code><input data-pw="${esc(x.id)}" maxlength="100" autocomplete="off" value="${esc(x.pass || '')}" placeholder="รหัสผ่าน" aria-label="รหัสผ่านของ ${esc(label(x.text))}"></div>`).join('')}</div></div>
      <p class="${lab} mt-4">ราคา (แสดงตอนส่งออก/ขาย/คัดลอก · ใส่ 0 = เอาราคาออก)</p>
      <div class="grid grid-cols-2 gap-3">
        <div><input id="vm-pa" type="number" min="0" step="any" inputmode="decimal" placeholder="ราคาต่อกอง ฿" class="${inp}" aria-label="ราคาต่อกอง"></div>
        <div><input id="vm-pb" type="number" min="0" step="any" inputmode="decimal" placeholder="ราคาเหมา ฿" class="${inp}" aria-label="ราคาเหมา"></div>
      </div>`, 'บันทึก', async () => {
        const num = (id, max) => { const v = $(id).value.trim(); if (v === '') return null; const n = Number(v); if (!Number.isFinite(n) || n < 0 || n > max) throw new Error('ตัวเลขไม่ถูกต้อง'); return n; };
        const ammo = num('vm-ammo', 999999), pa = num('vm-pa', 999999), pb = num('vm-pb', 999999), st = $('vm-st').value, note = $('vm-note').value.trim().slice(0, 200), mode = document.querySelector('input[name=vm-pm]:checked').value;
        const same = $('vm-pw').value.trim(), each = Object.fromEntries([...document.querySelectorAll('#vm-each [data-pw]')].map(i => [i.dataset.pw, i.value.trim()]));
        if (ammo != null && !Number.isInteger(ammo)) throw new Error('กระสุนต้องเป็นจำนวนเต็ม');
        if (mode === 'same' && !same) throw new Error('ใส่รหัสผ่านก่อน หรือเลือก "ไม่เปลี่ยน"');
        const ops = []; let n = 0;
        for (const x of rows) {
          const f = {};
          if (ammo != null) f.ammo = ammo;
          if (st !== '') f.color = Number(st);
          if (note) f.note = note; else if ($('vm-noteclr').checked) f.note = '';
          if (mode === 'same') f.pass = same; else if (mode === 'each' && (each[x.id] || '') !== (x.pass || '')) f.pass = each[x.id] || '';
          if (pa != null) f.priceAmmo = pa; if (pb != null) f.priceAll = pb;
          for (const k of Object.keys(f)) if (f[k] === x[k] || (f[k] === '' && !x[k]) || (f[k] === 0 && ['priceAmmo', 'priceAll'].includes(k) && !x[k])) delete f[k];
          if (Object.keys(f).length) { ops.push(['update', doc(col('ids'), x.id), f]); n++; }
        }
        if (!ops.length) { toast('ไม่มีอะไรเปลี่ยน', 'error'); return false; }
        const what = [ammo != null && 'กระสุน', st !== '' && 'สถานะ', (note || $('vm-noteclr').checked) && 'หมายเหตุ', mode !== 'keep' && 'รหัสผ่าน', (pa != null || pb != null) && 'ราคา'].filter(Boolean).join(' ');
        await commit(ops, 'edit', `แก้ ${n} ไอดี (${what}) ใน ${tabLabel(cur)}`, rows.map(x => x.text)); // password / price values never go in the history
        toast(`แก้ ${n} ไอดีแล้ว`, 'success');
      });
    $('vm-each').addEventListener('paste', (e) => {
      const t = e.clipboardData.getData('text'), lines = t.split(/\r?\n/).map(v => v.trim()).filter(Boolean); if (lines.length < 2) return;
      e.preventDefault(); const ins = [...document.querySelectorAll('#vm-each [data-pw]')], at = Math.max(0, ins.indexOf(e.target));
      lines.forEach((v, i) => { if (ins[at + i]) ins[at + i].value = v.slice(0, 100); });
    });
  },
  vEditMode: () => { const m = document.querySelector('input[name=vm-pm]:checked').value; $('vm-same').classList.toggle('hidden', m !== 'same'); $('vm-each').classList.toggle('hidden', m !== 'each'); },
  vDelete: () => { const rows = picked(); if (!rows.length) return; modal(`ลบ ${rows.length} ไอดี`, 'ย้ายไปถังขยะ กู้คืนได้ภายใน 7 วัน', '', 'ลบ', async () => {
    await commit(toTrash(rows), 'delete', `ลบ ${rows.length} ไอดี จาก ${tabLabel(cur)}`, rows.map(x => x.text)); sel.clear();
  }); },
  vCopySel: () => { const r = picked(); if (r.length) copy(r.map(exportLine).join('\n'), `คัดลอก ${r.length} ไอดีแล้ว`); },
  vCopyAll: () => { const r = viewIds(); return r.length ? copy(r.map(exportLine).join('\n'), `คัดลอก ${r.length} ไอดีแล้ว`) : toast('แท็บนี้ว่าง', 'error'); },
  vCopySale: (id) => copy((sales.find(s => s.id === id)?.items || []).join('\n')),
  /** Web Push to this device: subscribe with the Worker's VAPID key, save it in push_subs, settings in meta/notify. */
  vNotify: () => {
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent), standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    const can = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
    const perm = can ? Notification.permission : 'unsupported', n = notifyCfg;
    const lab = 'block text-xs text-slate mb-1', inp = 'w-full apple-input px-3 py-2.5 text-[15px]';
    modal('แจ้งเตือนเข้ามือถือ', 'เด้งเตือนที่เครื่องนี้เมื่อลูกทีมเปลี่ยนสถานะไอดี (เปิดได้หลายเครื่อง)',
      `${!can ? `<p class="rounded-[14px] bg-mist p-3 text-[13px] mb-3">${ios && !standalone ? 'iPhone/iPad: กดปุ่มแชร์ ⎋ แล้ว "เพิ่มไปยังหน้าจอโฮม" จากนั้นเปิดเว็บจากไอคอนบนหน้าจอโฮม แล้วกลับมาเปิดแจ้งเตือนที่นี่ (iOS 16.4 ขึ้นไป)' : 'เบราว์เซอร์นี้ไม่รองรับการแจ้งเตือน ลองใช้ Chrome หรือ Safari รุ่นใหม่'}</p>` : ''}
      <div class="flex items-center justify-between gap-3 rounded-[14px] bg-mist p-3"><span class="text-[14px]">${perm === 'granted' && hasSub ? 'เปิดแจ้งเตือนแล้ว (กดเปิดซ้ำได้ถ้าเพิ่มเครื่องใหม่)' : perm === 'denied' ? 'ถูกบล็อกไว้ เปิดสิทธิ์แจ้งเตือนในการตั้งค่าเบราว์เซอร์' : 'ยังไม่เปิดบนเครื่องนี้'}</span>
        ${can && perm !== 'denied' ? `<button type="button" onclick="vPushOn(this)" class="vx-btn pri shrink-0">${hasSub ? 'เปิดใหม่' : 'เปิดแจ้งเตือน'}</button>` : ''}</div>
      <label class="mt-4 flex items-center gap-2 text-[14px]"><input type="checkbox" id="vm-non" class="vx-check" ${n.on ? 'checked' : ''}> ส่งแจ้งเตือนจากทีม</label>
      <div class="grid grid-cols-2 gap-3 mt-3">
        <div><label class="${lab}" for="vm-nc">เมื่อไอดีเป็นสถานะ</label><select id="vm-nc" class="${inp}">${DEFAULT_LABELS.map((_, i) => i > 1 ? `<option value="${i}" ${i === (n.color || 4) ? 'selected' : ''}>${esc(labelOf(labels, i))}</option>` : '').join('')}</select></div>
        <div><label class="${lab}" for="vm-ne">ครบทุก (ไอดี)</label><input id="vm-ne" type="number" min="1" max="1000" inputmode="numeric" value="${n.every || 20}" class="${inp}"></div>
      </div>
      <label class="mt-3 flex items-center gap-2 text-[14px]"><input type="checkbox" id="vm-np" class="vx-check" ${n.problem !== false ? 'checked' : ''}> แจ้งทันทีเมื่อลูกทีมตั้ง "${esc(labelOf(labels, 1))}"</label>
      <p class="text-[12px] text-slate mt-3">ตัวอย่าง: ทีม 1 — ${esc(labelOf(labels, n.color || 4))}ครบ ${n.every || 20} ไอดีแล้ว · นับเฉพาะที่ลูกทีมแก้ในหน้า "ทีมของฉัน"</p>`,
      'บันทึก', async () => {
        const every = Math.round(Number($('vm-ne').value));
        if (!(every >= 1 && every <= 1000)) throw new Error('ใส่จำนวน 1-1000');
        await setDoc(doc(col('meta'), 'notify'), { on: $('vm-non').checked, color: Number($('vm-nc').value), every, problem: $('vm-np').checked });
        toast('บันทึกการแจ้งเตือนแล้ว', 'success');
      }, hasSub ? 'ส่งทดสอบ' : '', async () => { await callWorker('/push/test', {}); toast('ส่งแล้ว ดูที่มือถือ', 'success'); return false; });
  },
  vPushOn: guard(async (btn) => {
    btn.disabled = true;
    try {
      await enablePush();
      if (!notifyCfg.on) await setDoc(doc(col('meta'), 'notify'), { color: 4, every: 20, problem: true, ...notifyCfg, on: true });
      hasSub = true; toast('เปิดแจ้งเตือนบนเครื่องนี้แล้ว', 'success'); closeModal('v-modal'); later(() => window.vNotify());
    } finally { btn.disabled = false; }
  }),
  vLabels: () => modal('ตั้งชื่อสถานะ', 'ลูกทีมเห็นชื่อเหล่านี้ด้วย', COLORS.slice(1).map((c, i) => `<div class="flex items-center gap-2 mb-2"><span class="sh-dot" style="background:${c}"></span><input id="vm-l${i + 1}" value="${esc(labelOf(labels, i + 1))}" maxlength="20" class="flex-1 apple-input px-3 py-2 text-[14px]"></div>`).join(''), 'บันทึก', async () => {
    await setDoc(doc(col('meta'), 'colors'), { labels: ['—', ...COLORS.slice(1).map((_, i) => $(`vm-l${i + 1}`).value.trim().slice(0, 20))] });
  }),

  vInvite: guard(async (e) => {
    e.preventDefault(); const username = $('v-invite').value.trim(); if (!username) return;
    const r = await callWorker('/vault/invite', { tabId: cur, username });
    await commit([], 'member', `เชิญ ${r.memberName || username} เข้า ${tabLabel(cur)}`); $('v-invite').value = ''; toast(`เชิญ ${r.memberName || username} แล้ว`, 'success');
  }),
  vInviteLink: guard(async () => {
    const t = curTab(); let token = t.token;
    if (!token) { token = tok(); await commit([['update', doc(col('tabs'), t.id), { token }], ['set', doc(db, 'vault_links', token), { uid, tabId: t.id, name: t.name, createdAt: serverTimestamp() }]], 'token', `สร้างลิงก์เชิญ ${tabLabel(t.id)}`); }
    modal('ลิงก์เชิญ', 'ส่งลิงก์ให้ลูกทีม เขาล็อกอินแล้วกดครั้งเดียวก็เข้าทีม (หรือวางรหัสในหน้า "ทีมของฉัน")', copyBox(`${joinUrl(token)}\nรหัสเชิญ: ${token}`), 'คัดลอกลิงก์', () => copy(joinUrl(token), 'คัดลอกลิงก์เชิญแล้ว'), 'ยกเลิกลิงก์นี้', () => commit([['delete', doc(db, 'vault_links', token)], ['update', doc(col('tabs'), t.id), { token: '' }]], 'token', `ยกเลิกลิงก์เชิญ ${tabLabel(t.id)}`));
  }),
  vKick: (id) => { const m = members.find(x => x.id === id); modal('เอาลูกทีมออก', `${m?.memberName || 'ผู้ใช้'} จะไม่เห็นทีมนี้อีก`, '', 'เอาออก', async () => { await deleteDoc(doc(db, 'vault_members', id)); await commit([], 'member', `เอา ${m?.memberName || ''} ออกจาก ${tabLabel(m?.tabId)}`); }); },

  vTrash: () => {
    const rows = [...trash].sort((a, b) => ms(b.deletedAt) - ms(a.deletedAt));
    modal('ถังขยะ', 'เก็บไว้ 7 วันแล้วลบถาวรอัตโนมัติ', rows.length ? `<div class="max-h-72 overflow-y-auto divide-y divide-hairline">${rows.slice(0, 100).map(x => `<div class="py-2 flex items-center gap-2"><code class="flex-1 min-w-0 truncate text-[13px]">${esc(x.text)}</code><span class="text-xs text-slate shrink-0">${esc(x.tabName || '')}</span><button type="button" onclick="vRestore('${x.id}')" class="shrink-0 text-appleBlue text-[13px]">กู้คืน</button></div>`).join('')}</div>` : '<p class="text-center text-slate py-6">ถังขยะว่าง</p>',
      'กู้คืนทั้งหมด', async () => { if (rows.length) await restore(rows); }, rows.length ? 'ล้างถังขยะ' : '', async () => { await commit(rows.map(x => ['delete', doc(col('trash'), x.id)]), 'trash', `ล้างถังขยะ ${rows.length} ไอดี`, rows.map(x => x.text)); });
  },
  vRestore: guard(async (id) => { const x = trash.find(t => t.id === id); if (x) { await restore([x]); window.vTrash(); } }),
  vGuide: () => modal('วิธีใช้', '', `<ol class="list-decimal pl-5 space-y-2 text-[14px]"><li><b>+ คลังใหม่</b> แล้ว <b>+ สต๊อก</b> วางไอดี (ท้ายบรรทัด |20 = 20 กอง)</li><li><b>+ ทีมใหม่</b> แล้วพิมพ์ชื่อผู้ใช้ลูกทีม กด <b>เชิญ</b> (หรือส่ง <b>ลิงก์เชิญ</b>)</li><li>ที่คลัง ใส่จำนวนในช่อง <b>ติ๊ก</b> กด "แรก" หรือ "สุ่ม" แล้วแตะชื่อทีมในแถบด้านล่าง = ย้ายเสร็จ</li><li>ลูกทีมแก้ กระสุน สถานะ หมายเหตุ ในหน้า "ทีมของฉัน" คุณเห็นทันที กดชิปสถานะด้านบนเพื่อกรอง</li><li>ติ๊กไอดีที่จะขาย กด <b>ขาย</b> แล้ว "คัดลอกและยืนยันขาย" ส่งลูกค้าได้เลย</li></ol>`, 'เข้าใจแล้ว', () => {})
});
bindSheet($('v-list'), {
  onEdit: guard(async (id, f, v) => { await updateDoc(doc(col('ids'), id), { [f]: v }); }),
  onCopy: (id) => { const x = ids.find(r => r.id === id); if (x) copy(exportLine(x)); },
  onSel: (id, on) => { on ? sel.add(id) : sel.delete(id); render(); },
  onSelAll: (on) => { const r = viewIds().slice(0, 1000); r.forEach(x => (on ? sel.add(x.id) : sel.delete(x.id))); render(); },
  onSort: (k) => { sort = sort === k ? '' : k; render(); }
});

// ---------- buy access (price is read from settings by the Worker, never trusted from here) ----------
const packs = () => (Array.isArray(ST.vaultPackages) ? ST.vaultPackages : []).filter(p => p.days > 0 && p.price > 0);
const trialDays = () => (trialUsed ? 0 : Math.floor(ST.vaultTrialDays) || 0);
const packsHtml = () => `<div class="grid gap-2" style="grid-template-columns:minmax(0,1fr)">${trialDays() ? `<button type="button" onclick="vBuy(0)" class="soft-card px-4 py-3 flex justify-between items-center text-left" style="background:#fff"><span class="font-medium">ทดลองฟรี ${trialDays()} วัน <span class="text-launchOrange text-xs">โปร</span></span><span class="text-appleBlue">รับสิทธิ์</span></button>` : ''}
  ${packs().map(p => `<button type="button" onclick="vBuy(${p.days})" class="soft-card px-4 py-3 flex justify-between items-center text-left" style="background:#fff"><span class="font-medium">${p.days} วัน</span><span class="font-heading font-semibold">฿${money(p.price)}</span></button>`).join('')}
  <form onsubmit="vRedeem(event)" class="flex gap-2 mt-1"><input name="code" size="1" required minlength="4" maxlength="32" autocomplete="off" autocapitalize="characters" placeholder="มีโค้ด? กรอกรับวันใช้งาน" aria-label="โค้ดรับวันใช้งาน" class="flex-1 min-w-0 apple-input px-4 py-2.5 text-[15px] uppercase"><button type="submit" class="apple-pricing-pill px-5 text-[15px]">ใช้โค้ด</button></form></div>`;
window.vRedeem = async (e) => {
  e.preventDefault(); const f = e.target, b = f.querySelector('button'); b.disabled = true;
  try { const r = await callWorker('/vault/redeem', { code: f.code.value.trim().toUpperCase() }); toast(`รับ ${r.days} วันแล้ว`, 'success'); f.reset(); closeModal('v-modal'); }
  catch (err) { toast(err.message || 'ใช้โค้ดไม่สำเร็จ', 'error'); }
  b.disabled = false;
};
window.vRenew = () => modal('ซื้อ / ต่อสิทธิ์', 'ชำระด้วยเครดิต วันที่ซื้อใหม่จะต่อท้ายวันที่เหลืออยู่', packsHtml(), 'ปิด', () => {});
window.vBuy = (days) => {
  const p = packs().find(x => x.days === days);
  if (days && !p) return;
  modal(days ? `ซื้อ ${days} วัน ฿${money(p.price)}` : `รับสิทธิ์ทดลอง ${trialDays()} วัน`, days ? 'หักจากเครดิตทันที ต่อท้ายวันที่เหลืออยู่' : 'ใช้ได้ครั้งเดียวต่อบัญชี', '', days ? 'ยืนยันซื้อ' : 'รับสิทธิ์', async () => {
    try { await callWorker('/vault/buy', days ? { days, expectedAmount: p.price } : { trial: true }); toast(days ? 'ซื้อสิทธิ์สำเร็จ' : 'รับสิทธิ์ทดลองแล้ว', 'success'); }
    catch (e) { toast(e.message || 'ทำรายการไม่สำเร็จ', 'error'); return false; }
  });
};

const restore = (rows) => commit(rows.flatMap(x => [['set', doc(col('ids')), { tab: tabs.some(t => t.id === x.tab) ? x.tab : zoneTabs('boss')[0]?.id || tabs[0]?.id || '', text: x.text, key: keyOf(x.text), ammo: x.ammo || 0, color: x.color || 0, note: x.note || '', ...extras(x), seq: Date.now(), createdAt: serverTimestamp() }], ['delete', doc(col('trash'), x.id)]]), 'restore', `กู้คืน ${rows.length} ไอดี`, rows.map(x => x.text)).then(() => toast(`กู้คืน ${rows.length} ไอดีแล้ว`, 'success'));

// ---------- boot ----------
function listen() {
  if (started) return; started = true;
  const warn = (e) => console.warn('vault:', e);
  subs = [
    onSnapshot(col('tabs'), (s) => { tabs = s.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => ms(a.createdAt) - ms(b.createdAt)); render(); }, warn),
    onSnapshot(col('ids'), (s) => { ids = s.docs.map(d => ({ id: d.id, ...d.data() })); render(); }, warn),
    onSnapshot(col('sold'), (s) => {
      sold = s.docs.map(d => ({ id: d.id, ...d.data() }));
      const old = sold.filter(x => x.at && ms(x.at) < Date.now() - SOLD_DAYS * DAY); // duplicate guard keeps 180 days of sales
      if (old.length) commit(old.map(x => ['delete', doc(col('sold'), x.id)]), 'trash', `ล้างรายการขายเกิน ${SOLD_DAYS} วัน ${old.length} รายการ`).catch(warn);
    }, warn),
    onSnapshot(query(col('sales'), orderBy('at', 'desc'), limit(100)), (s) => { sales = s.docs.map(d => ({ id: d.id, ...d.data() })); render(); }, warn),
    onSnapshot(doc(col('meta'), 'notify'), (s) => { notifyCfg = s.data() || {}; }, warn),
    onSnapshot(query(collection(db, 'push_subs'), where('uid', '==', uid)), (s) => { hasSub = !s.empty; }, warn),
    onSnapshot(doc(col('meta'), 'colors'), (s) => { if (Array.isArray(s.data()?.labels)) labels = s.data().labels; render(); }, warn),
    onSnapshot(query(collection(db, 'vault_members'), where('owner', '==', uid)), (s) => { members = s.docs.map(d => ({ id: d.id, ...d.data() })); render(); }, warn),
    onSnapshot(col('trash'), (s) => {
      trash = s.docs.map(d => ({ id: d.id, ...d.data() })); render();
      const old = trash.filter(x => x.deletedAt && ms(x.deletedAt) < Date.now() - 7 * DAY);
      if (old.length) commit(old.map(x => ['delete', doc(col('trash'), x.id)]), 'trash', `ลบถาวรอัตโนมัติ ${old.length} ไอดี (เกิน 7 วัน)`, old.map(x => x.text)).catch(warn);
    }, warn),
    onSnapshot(query(col('logs'), orderBy('at', 'desc'), limit(100)), (s) => { logs = s.docs.map(d => d.data()); render(); }, warn)
  ];
}
const gate = (html) => { $('v-gate').classList.remove('hidden'); $('v-app').classList.add('hidden'); $('v-gate').innerHTML = html; };
let isOpen = false, signedIn = false;
const renderGate = () => {
  if (isOpen) return;
  if (!signedIn) return gate('<p class="font-semibold">เข้าสู่ระบบเพื่อใช้โปรแกรม</p><a href="login.html?mode=login&next=vault.html" class="apple-pricing-pill px-6 py-2.5 text-[15px] mt-4">เข้าสู่ระบบ</a>');
  gate(`<p class="font-semibold text-lg">ยังไม่มีคลังของตัวเอง</p><p class="text-slate text-sm mt-2 mb-4">เป็นหัวหน้าทีม: คลังสต๊อกไอดี แบ่งงานให้ลูกทีม ตัดขายพร้อมประวัติ กันเติมซ้ำอัตโนมัติ<br>เป็นลูกทีมของคนอื่นไม่ต้องซื้อ ไปที่ <a href="team.html" class="text-appleBlue">ทีมของฉัน</a></p><div class="text-left max-w-sm mx-auto">${packsHtml()}</div>
    <div class="flex justify-center gap-2 mt-4 flex-wrap">${contactsOf(ST).map(c => `<a href="${esc(c.url)}" target="_blank" rel="noopener" class="rounded-full border border-steel px-4 py-2 text-[14px]">${esc(c.label)}</a>`).join('')}</div>`);
};
onSettings((st) => { ST = st; renderGate(); });
let unsubUser = () => {};
onAuthStateChanged(auth, (u) => {
  subs.forEach(f => f()); subs = []; unsubUser(); started = false; uid = u?.uid || ''; signedIn = !!u; isOpen = false; renderGate();
  if (!u) return;
  unsubUser = onSnapshot(doc(db, 'users', u.uid), (s) => {
    const until = ms(s.data()?.vaultUntil); trialUsed = s.data()?.vaultTrialUsed === true; isOpen = until > Date.now();
    const left = Math.ceil((until - Date.now()) / DAY), warn = $('v-warn'); warn.classList.toggle('hidden', !(isOpen && left <= 3));
    warn.innerHTML = `สิทธิ์เหลือ ${left} วัน · <button type="button" onclick="vRenew()" class="text-appleBlue">ต่ออายุ</button>`;
    $('v-until').innerHTML = isOpen ? `ใช้ได้ถึง ${new Date(until).toLocaleDateString('th-TH', { dateStyle: 'medium' })} · <button type="button" onclick="vRenew()" class="text-appleBlue">ต่ออายุ</button>` : '';
    if (isOpen) { $('v-gate').classList.add('hidden'); $('v-app').classList.remove('hidden'); listen(); } else renderGate();
  }, (e) => console.warn('vault user:', e));
});
