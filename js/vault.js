import { db, auth } from "../firebase-config.js";
import { collection, doc, onSnapshot, query, orderBy, limit, writeBatch, updateDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { esc, toast, money, openModal, closeModal, onSettings, contactsOf, callWorker } from "./ui.js";

/**
 * ID vault: tabs of IDs, pull-by-count (copy then delete), move / delete across tabs, team assignment by link, full history.
 * Data lives under vaults/{uid}/{tabs,ids,team,logs}; rules open it only while users/{uid}.vaultUntil is in the future.
 */
const $ = (id) => document.getElementById(id);
const ms = (v) => v?.toMillis?.() ?? (v ? new Date(v).getTime() : 0);
const label = (t) => String(t).split(/[|:\s]/)[0].slice(0, 40);
const when = (v) => new Date(ms(v) || Date.now()).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' });
let uid = '', tabs = [], ids = [], team = [], logs = [], trash = [], cur = '', sel = new Set(), subs = [], q = '', flt = '', started = false, ST = {}, trialUsed = false;
const col = (n) => collection(db, 'vaults', uid, n);
const tabIds = () => ids.filter(x => x.tab === cur);
const viewIds = () => tabIds().filter(x => (!q || x.text.toLowerCase().includes(q)) && ({ '': 1, free: !x.assignee, assigned: !!x.assignee, done: x.done, issue: !!x.issue, sold: x.status === 'sold', hold: x.status === 'hold' }[flt]));
const STATUS = { sold: ['ขายแล้ว', 'text-slate'], hold: ['พักไว้', 'text-launchOrange'] };
/** Deleting never destroys: the ID moves to vaults/{uid}/trash for 7 days and can be restored. */
const toTrash = (rows) => rows.flatMap(x => [['set', doc(col('trash'), x.id), { text: x.text, tab: x.tab, tabName: tabName(x.tab), deletedAt: serverTimestamp() }], ['delete', doc(col('ids'), x.id)]]);
const dayText = (ms0) => new Date(ms0).toLocaleDateString('th-TH', { day: 'numeric', month: 'short' });

/** Writes in chunks of 450 (batch limit 500), then one history row, so every action is recorded. */
async function commit(writes, action, detail, items = []) {
  const all = [...writes, ['set', doc(col('logs')), { action, detail, count: items.length, items: items.map(label).slice(0, 100), at: serverTimestamp() }]];
  for (let i = 0; i < all.length; i += 450) {
    const b = writeBatch(db);
    all.slice(i, i + 450).forEach(([k, ref, data]) => (k === 'delete' ? b.delete(ref) : k === 'update' ? b.update(ref, data) : b.set(ref, data)));
    await b.commit();
  }
}
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { console.warn(e); toast('ทำรายการไม่สำเร็จ ลองใหม่อีกครั้ง', 'error'); } };

// ---------- modal ----------
function modal(title, hint, body, ok, onOk, alt, onAlt) {
  $('vm-title').textContent = title; $('vm-hint').textContent = hint || ''; $('vm-body').innerHTML = body;
  const run = (fn) => guard(async () => { if ((await fn()) !== false) closeModal('v-modal'); });
  $('vm-ok').textContent = ok; $('vm-ok').onclick = run(onOk);
  $('vm-alt').classList.toggle('hidden', !alt); if (alt) { $('vm-alt').textContent = alt; $('vm-alt').onclick = run(onAlt); }
  openModal('v-modal');
}
const field = (id, extra = '') => `<input id="${id}" class="w-full apple-input px-3.5 py-2.5 text-[15px]" ${extra}>`;
const tabSelect = (skip) => `<select id="vm-tab" class="w-full apple-input px-3 py-2.5 text-[15px]">${tabs.filter(t => t.id !== skip).map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select>`;

// ---------- render ----------
function render() {
  if (!tabs.some(t => t.id === cur)) cur = tabs[0]?.id || '';
  $('v-tabs').innerHTML = tabs.map(t => `<button type="button" onclick="vTab('${t.id}')" class="shrink-0 rounded-full px-4 py-2 text-[14px] ${t.id === cur ? 'bg-ink text-white' : 'bg-mist text-ink'}">${esc(t.name)} <span class="opacity-60">${ids.filter(x => x.tab === t.id).length}</span></button>`).join('')
    + '<button type="button" onclick="vNewTab()" class="shrink-0 rounded-full border border-steel px-4 py-2 text-[14px]">+ แท็บ</button>';
  const rows = viewIds();
  sel = new Set([...sel].filter(id => rows.some(x => x.id === id)));
  const name = (m) => team.find(t => t.id === m)?.name;
  $('v-list').innerHTML = !tabs.length ? '<p class="py-10 text-center text-slate">เริ่มจากกด "+ แท็บ" เพื่อสร้างหมวดแรก เช่น ไก่กระสุน</p>'
    : rows.length ? rows.slice(0, 500).map(x => `<label class="flex items-center gap-3 py-2.5"><input type="checkbox" ${sel.has(x.id) ? 'checked' : ''} onchange="vSel('${x.id}', this.checked)" class="w-5 h-5 shrink-0">
        <code class="flex-1 min-w-0 truncate text-[14px]">${esc(x.text)}</code>
        ${STATUS[x.status] ? `<span class="shrink-0 text-[12px] ${STATUS[x.status][1]}">${STATUS[x.status][0]}</span>` : ''}
        ${x.issue ? `<span class="shrink-0 text-[12px] text-launchOrange" title="${esc(x.issue)}">⚠ ${esc(x.issue.slice(0, 24))}</span>` : ''}
        ${x.assignee ? `<span class="shrink-0 text-[12px] text-right ${x.done ? 'text-emerald-600' : 'text-appleBlue'}">${esc(name(x.assignee) || '?')}${x.done ? ' ✓' : ''}${x.due ? `<br><span class="${!x.done && x.due < Date.now() ? 'text-launchOrange' : 'text-slate'}">ส่ง ${dayText(x.due)}</span>` : ''}</span>` : ''}</label>`).join('') + (rows.length > 500 ? `<p class="py-3 text-center text-xs text-slate">แสดง 500 จาก ${rows.length} รายการ</p>` : '')
      : tabIds().length ? '<p class="py-10 text-center text-slate">ไม่พบรายการที่ตรงกับตัวกรอง</p>' : `<p class="py-10 text-center text-slate">แท็บนี้ว่าง <button type="button" onclick="vDelTab()" class="text-launchOrange ml-2">ลบแท็บ</button></p>`;
  $('v-trash-n').textContent = trash.length ? `(${trash.length})` : '';
  $('v-sel').classList.toggle('hidden', !sel.size); $('v-sel-n').textContent = `เลือก ${sel.size} รายการ`;
  $('v-all').checked = !!rows.length && sel.size === Math.min(rows.length, 500);
  $('v-team').innerHTML = team.length ? team.map(m => {
    const mine = ids.filter(x => x.assignee === m.id);
    return `<div class="soft-card px-4 py-3 flex items-center gap-3"><div class="min-w-0 flex-1"><p class="font-medium">${esc(m.name)}</p><p class="text-xs text-slate">ทำแล้ว ${mine.filter(x => x.done).length}/${mine.length} ไอดี${mine.some(x => x.issue) ? ` · <span class="text-launchOrange">ปัญหา ${mine.filter(x => x.issue).length}</span>` : ''}${mine.some(x => !x.done && x.due && x.due < Date.now()) ? ` · <span class="text-launchOrange">เลยกำหนด ${mine.filter(x => !x.done && x.due && x.due < Date.now()).length}</span>` : ''}</p></div>
      <button type="button" onclick="vCopyLink('${m.id}')" class="rounded-full border border-steel px-3.5 py-1.5 text-[13px]">คัดลอกลิงก์</button>
      <button type="button" onclick="vDelMember('${m.id}')" class="text-launchOrange text-[13px]">ลบ</button></div>`;
  }).join('') : '<p class="text-sm text-slate">ยังไม่มีทีมงาน</p>';
  const ACT = { add: 'เพิ่ม', pull: 'ดึงออก', move: 'ย้าย', delete: 'ลบ', assign: 'มอบหมาย', team: 'ทีม', done: 'ทำเสร็จ', undone: 'ยกเลิกเสร็จ', tab: 'แท็บ', issue: 'แจ้งปัญหา', export: 'ส่งออก', status: 'สถานะ', restore: 'กู้คืน', trash: 'ถังขยะ' };
  $('v-logs').innerHTML = logs.length ? logs.map(l => `<details class="px-4 py-3"><summary class="cursor-pointer flex justify-between gap-3 text-[14px]"><span><b>${ACT[l.action] || esc(l.action)}</b> · ${esc(l.detail)}</span><span class="text-xs text-slate shrink-0">${when(l.at)}</span></summary>
      ${l.items?.length ? `<p class="mt-2 text-xs text-slate break-all font-mono">${l.items.map(esc).join(', ')}${l.count > l.items.length ? ` …+${l.count - l.items.length}` : ''}</p>` : ''}</details>`).join('') : '<p class="px-4 py-6 text-center text-slate text-sm">ยังไม่มีประวัติ</p>';
}

// ---------- actions ----------
const picked = () => ids.filter(x => sel.has(x.id));
const tabName = (id) => tabs.find(t => t.id === id)?.name || '';
Object.assign(window, {
  vTab: (id) => { cur = id; sel.clear(); render(); },
  vSel: (id, on) => { on ? sel.add(id) : sel.delete(id); render(); },
  vFilter: () => { q = $('v-q').value.trim().toLowerCase(); flt = $('v-flt').value; render(); },
  vSelAll: (on) => { sel = new Set(on ? viewIds().slice(0, 500).map(x => x.id) : []); render(); },

  vNewTab: () => modal('แท็บใหม่', 'ตั้งชื่อหมวด เช่น ไก่กระสุน', field('vm-name', 'maxlength="30" placeholder="ชื่อแท็บ"'), 'สร้าง', async () => {
    const name = $('vm-name').value.trim(); if (!name) return false;
    const ref = doc(col('tabs')); await commit([['set', ref, { name, createdAt: serverTimestamp() }]], 'tab', `สร้างแท็บ ${name}`); cur = ref.id;
  }),
  vDelTab: () => modal('ลบแท็บ', `ลบแท็บ "${tabName(cur)}" ที่ว่างอยู่`, '', 'ลบแท็บ', () => commit([['delete', doc(col('tabs'), cur)]], 'tab', `ลบแท็บ ${tabName(cur)}`)),

  vAdd: () => !cur ? toast('สร้างแท็บก่อน', 'error') : modal(`เพิ่มไอดีใน ${tabName(cur)}`, 'วาง 1 ไอดีต่อ 1 บรรทัด (เช่น อีเมล|รหัส) ตัวซ้ำจะถูกข้าม', '<textarea id="vm-text" rows="8" class="w-full apple-input px-3.5 py-2.5 text-[14px] font-mono"></textarea><label class="block mt-2 text-[13px] text-appleBlue">หรือนำเข้าจากไฟล์ .txt / .csv <input type="file" accept=".txt,.csv,text/plain,text/csv" class="block mt-1 text-slate" onchange="vFile(this)"></label>', 'เพิ่ม', async () => {
    const have = new Set(ids.map(x => x.text));
    const lines = [...new Set($('vm-text').value.split('\n').map(s => s.trim()).filter(Boolean))].filter(s => s.length <= 300 && !have.has(s)).slice(0, 1000);
    if (!lines.length) { toast('ไม่มีไอดีใหม่ (ว่างหรือซ้ำ)', 'error'); return false; }
    await commit(lines.map(text => ['set', doc(col('ids')), { tab: cur, text, assignee: '', done: false, createdAt: serverTimestamp() }]), 'add', `เพิ่ม ${lines.length} ไอดี ใน ${tabName(cur)}`, lines);
    toast(`เพิ่ม ${lines.length} ไอดี`, 'success');
  }),

  vPull: () => {
    const pool = tabIds().filter(x => !x.assignee && !x.status).sort((a, b) => ms(a.createdAt) - ms(b.createdAt));
    if (!pool.length) return toast('ไม่มีไอดีที่ยังไม่ได้มอบหมายในแท็บนี้', 'error');
    modal(`ดึงไอดีจาก ${tabName(cur)}`, `มีให้ดึง ${pool.length} ไอดี (ไม่รวมที่มอบหมาย ขายแล้ว หรือพักไว้) เรียงเก่าสุดก่อน`, field('vm-n', `type="number" min="1" max="${pool.length}" value="${Math.min(10, pool.length)}" inputmode="numeric"`), 'ต่อไป', () => {
      const n = Math.round(Number($('vm-n').value));
      if (!(n >= 1 && n <= pool.length)) return false;
      const take = pool.slice(0, n), text = take.map(x => x.text).join('\n');
      const remove = () => commit(toTrash(take), 'pull', `ดึง ${n} ไอดี จาก ${tabName(cur)}`, take.map(x => x.text));
      setTimeout(() => modal(`ดึง ${n} ไอดี`, 'กด "คัดลอกแล้วลบ" ระบบจะคัดลอกก่อน แล้วค่อยลบออกจากคลัง', `<textarea id="vm-out" readonly rows="8" class="w-full apple-input px-3.5 py-2.5 text-[14px] font-mono">${esc(text)}</textarea>`, 'คัดลอกแล้วลบ',
        async () => { try { await navigator.clipboard.writeText(text); } catch (_) { $('vm-out').select(); toast('คัดลอกอัตโนมัติไม่ได้ กดค้างคัดลอกเอง แล้วเลือก "คัดลอกเองแล้ว"', 'error'); return false; } await remove(); toast(`คัดลอกและลบ ${n} ไอดีแล้ว`, 'success'); },
        'คัดลอกเองแล้ว ลบเลย', async () => { await remove(); toast(`ลบ ${n} ไอดีแล้ว`, 'success'); }), 0);
    });
  },

  vMove: () => tabs.length < 2 ? toast('ต้องมีอย่างน้อย 2 แท็บ', 'error') : modal(`ย้าย ${sel.size} ไอดี`, 'เลือกแท็บปลายทาง', tabSelect(cur), 'ย้าย', async () => {
    const to = $('vm-tab').value, rows = picked();
    await commit(rows.map(x => ['update', doc(col('ids'), x.id), { tab: to }]), 'move', `ย้าย ${rows.length} ไอดี ${tabName(cur)} → ${tabName(to)}`, rows.map(x => x.text)); sel.clear();
  }),
  vDelete: () => modal(`ลบ ${sel.size} ไอดี`, 'ย้ายไปถังขยะ กู้คืนได้ภายใน 7 วัน', '', 'ลบ', async () => {
    const rows = picked();
    await commit(toTrash(rows), 'delete', `ลบ ${rows.length} ไอดี จาก ${tabName(cur)}`, rows.map(x => x.text)); sel.clear();
  }),
  vAssign: () => modal(`มอบหมาย ${sel.size} ไอดี`, 'เลือกคนในทีม', `<select id="vm-m" class="w-full apple-input px-3 py-2.5 text-[15px]"><option value="">— ไม่มอบหมาย —</option>${team.map(m => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}</select>
      <label class="block text-xs text-slate mt-3 mb-1" for="vm-due">กำหนดส่ง (ไม่บังคับ)</label><input id="vm-due" type="date" class="w-full apple-input px-3 py-2">
      <label class="block text-xs text-slate mt-3 mb-1" for="vm-note">หมายเหตุถึงทีม (ไม่บังคับ)</label><input id="vm-note" maxlength="100" class="w-full apple-input px-3 py-2">`, 'บันทึก', async () => {
    const m = $('vm-m').value, rows = picked();
    await commit(rows.map(x => ['update', doc(col('ids'), x.id), { assignee: m, done: false, issue: '', due: m && $('vm-due').value ? new Date($('vm-due').value + 'T23:59:59').getTime() : 0, note: m ? $('vm-note').value.trim().slice(0, 100) : '' }]), 'assign', `${m ? `มอบหมายให้ ${team.find(t => t.id === m)?.name}` : 'ยกเลิกการมอบหมาย'} · ${rows.length} ไอดี`, rows.map(x => x.text)); sel.clear();
  }),

  vStatus: () => modal(`ตั้งสถานะ ${sel.size} ไอดี`, 'ไอดีที่ขายแล้วหรือพักไว้จะไม่ถูกคัดตอน "ดึงตามจำนวน"', `<select id="vm-st" class="w-full apple-input px-3 py-2.5 text-[15px]"><option value="">ปกติ (พร้อมใช้)</option><option value="sold">ขายแล้ว</option><option value="hold">พักไว้</option></select>`, 'บันทึก', async () => {
    const st = $('vm-st').value, rows = picked();
    await commit(rows.map(x => ['update', doc(col('ids'), x.id), { status: st }]), 'status', `ตั้งเป็น "${st ? STATUS[st][0] : 'ปกติ'}" · ${rows.length} ไอดี`, rows.map(x => x.text)); sel.clear();
  }),
  vTrash: () => {
    const rows = [...trash].sort((a, b) => ms(b.deletedAt) - ms(a.deletedAt));
    modal('ถังขยะ', 'เก็บไว้ 7 วันแล้วลบถาวรอัตโนมัติ', rows.length ? `<div class="max-h-72 overflow-y-auto divide-y divide-hairline">${rows.slice(0, 100).map(x => `<div class="py-2 flex items-center gap-2"><code class="flex-1 min-w-0 truncate text-[13px]">${esc(x.text)}</code><span class="text-xs text-slate shrink-0">${esc(x.tabName || '')}</span><button type="button" onclick="vRestore('${x.id}')" class="shrink-0 text-appleBlue text-[13px]">กู้คืน</button></div>`).join('')}</div>` : '<p class="text-center text-slate py-6">ถังขยะว่าง</p>',
      'กู้คืนทั้งหมด', async () => { if (rows.length) await restore(rows); }, rows.length ? 'ล้างถังขยะ' : '', async () => { await commit(rows.map(x => ['delete', doc(col('trash'), x.id)]), 'trash', `ล้างถังขยะ ${rows.length} ไอดี`, rows.map(x => x.text)); });
  },
  vRestore: guard(async (id) => { const x = trash.find(t => t.id === id); if (x) { await restore([x]); window.vTrash(); } }),
  vClearIssue: () => modal(`ล้างปัญหา ${sel.size} ไอดี`, 'ใช้หลังแก้ไอดีแล้ว', '', 'ล้างปัญหา', async () => {
    const rows = picked().filter(x => x.issue);
    if (!rows.length) { toast('รายการที่เลือกไม่มีปัญหา', 'error'); return false; }
    await commit(rows.map(x => ['update', doc(col('ids'), x.id), { issue: '' }]), 'issue', `ล้างปัญหา ${rows.length} ไอดี`, rows.map(x => x.text)); sel.clear();
  }),
  vFile: async (el) => { const f = el.files[0]; if (!f) return; if (f.size > 1e6) return toast('ไฟล์ใหญ่เกิน 1MB', 'error'); $('vm-text').value = ($('vm-text').value ? $('vm-text').value + '\n' : '') + (await f.text()).replace(/^\uFEFF/, '').trim(); },
  vExport: () => {
    const save = (name, text, type) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 3000); };
    const csv = (v) => `"${String(v).replace(/"/g, '""')}"`;
    modal('ส่งออกไอดี', 'ไฟล์มีรหัสผ่านอยู่ด้วย เก็บไว้ให้ปลอดภัย', '', 'แท็บนี้ (.txt)', async () => {
      const rows = tabIds(); if (!rows.length) { toast('แท็บนี้ว่าง', 'error'); return false; }
      save(`${tabName(cur)}.txt`, rows.map(x => x.text).join('\n'), 'text/plain'); await commit([], 'export', `ส่งออก ${rows.length} ไอดี จาก ${tabName(cur)}`, rows.map(x => x.text));
    }, 'ทั้งหมด (.csv)', async () => {
      if (!ids.length) { toast('ยังไม่มีไอดี', 'error'); return false; }
      save('vault.csv', '\uFEFF' + ['แท็บ,ไอดี,ผู้รับ,เสร็จ,ปัญหา', ...ids.map(x => [tabName(x.tab), x.text, team.find(t => t.id === x.assignee)?.name || '', x.done ? 'Y' : '', x.issue || ''].map(csv).join(','))].join('\n'), 'text/csv');
      await commit([], 'export', `ส่งออกทั้งหมด ${ids.length} ไอดี`, ids.map(x => x.text));
    });
  },
  vGuide: () => modal('วิธีใช้', '', `<ol class="list-decimal pl-5 space-y-2 text-[14px]"><li>กด "+ แท็บ" สร้างหมวด เช่น ไก่กระสุน</li><li>กด "+ เพิ่มไอดี" วางไอดีบรรทัดละ 1 รายการ หรือนำเข้าไฟล์</li><li>"ดึงตามจำนวน" ใส่จำนวน ระบบคัดลอกให้แล้วลบออกจากคลัง</li><li>ติ๊กเลือกไอดี แล้ว ย้ายแท็บ / ลบ / มอบหมายทีม</li><li>"+ เพิ่มคน" ในส่วนทีมงาน แล้ว "คัดลอกลิงก์" ส่งให้คนนั้น เขาเปิดเห็นเฉพาะไอดีของตัวเอง ติ๊กเสร็จหรือแจ้งปัญหาได้</li><li>"ประวัติย้อนหลัง" บันทึกทุกการกระทำ กดดูรายชื่อไอดีได้</li></ol>`, 'เข้าใจแล้ว', () => {}),
  vNewMember: () => modal('เพิ่มคนในทีม', 'ชื่อที่ใช้เรียก เช่น น้องเอ', field('vm-name', 'maxlength="30"'), 'เพิ่ม', async () => {
    const name = $('vm-name').value.trim(); if (!name) return false;
    const token = Array.from(crypto.getRandomValues(new Uint8Array(24)), b => 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 56]).join('');
    const ref = doc(col('team'));
    await commit([['set', ref, { name, token, createdAt: serverTimestamp() }], ['set', doc(db, 'vault_links', token), { uid, memberId: ref.id, name, createdAt: serverTimestamp() }]], 'team', `เพิ่ม ${name}`);
  }),
  vCopyLink: async (id) => {
    const m = team.find(t => t.id === id), url = new URL(`team.html?k=${m.token}`, location.href).href;
    try { await navigator.clipboard.writeText(url); toast('คัดลอกลิงก์แล้ว ส่งให้ ' + m.name, 'success'); } catch (_) { prompt('คัดลอกลิงก์นี้', url); }
  },
  vDelMember: (id) => { const m = team.find(t => t.id === id); modal(`ลบ ${m.name}`, 'ลิงก์ของคนนี้จะใช้ไม่ได้ และไอดีที่มอบหมายจะกลับเป็นยังไม่มอบหมาย', '', 'ลบ', () => commit([
    ...ids.filter(x => x.assignee === id).map(x => ['update', doc(col('ids'), x.id), { assignee: '', done: false }]),
    ['delete', doc(db, 'vault_links', m.token)], ['delete', doc(col('team'), id)]], 'team', `ลบ ${m.name}`)); }
});

// ---------- buy access (price is read from settings by the Worker, never trusted from here) ----------
const packs = () => (Array.isArray(ST.vaultPackages) ? ST.vaultPackages : []).filter(p => p.days > 0 && p.price > 0);
const trialDays = () => (trialUsed ? 0 : Math.floor(ST.vaultTrialDays) || 0);
const packsHtml = () => `<div class="grid gap-2">${trialDays() ? `<button type="button" onclick="vBuy(0)" class="soft-card px-4 py-3 flex justify-between items-center text-left"><span class="font-medium">ทดลองฟรี ${trialDays()} วัน <span class="text-launchOrange text-xs">โปร</span></span><span class="text-appleBlue">รับสิทธิ์</span></button>` : ''}
  ${packs().map(p => `<button type="button" onclick="vBuy(${p.days})" class="soft-card px-4 py-3 flex justify-between items-center text-left"><span class="font-medium">${p.days} วัน</span><span class="font-heading font-semibold">฿${money(p.price)}</span></button>`).join('')}</div>`;
window.vRenew = () => modal('ซื้อ / ต่อสิทธิ์คลังไอดี', 'ชำระด้วยเครดิต วันที่ซื้อใหม่จะต่อท้ายวันที่เหลืออยู่', packsHtml(), 'ปิด', () => {});
window.vBuy = (days) => {
  const p = packs().find(x => x.days === days);
  if (days && !p) return;
  modal(days ? `ซื้อ ${days} วัน ฿${money(p.price)}` : `รับสิทธิ์ทดลอง ${trialDays()} วัน`, days ? 'หักจากเครดิตทันที ต่อท้ายวันที่เหลืออยู่' : 'ใช้ได้ครั้งเดียวต่อบัญชี', '', days ? 'ยืนยันซื้อ' : 'รับสิทธิ์', async () => {
    try { await callWorker('/vault/buy', days ? { days, expectedAmount: p.price } : { trial: true }); toast(days ? 'ซื้อสิทธิ์สำเร็จ' : 'รับสิทธิ์ทดลองแล้ว', 'success'); }
    catch (e) { toast(e.message || 'ทำรายการไม่สำเร็จ', 'error'); return false; }
  });
};

const restore = (rows) => commit(rows.flatMap(x => [['set', doc(col('ids')), { tab: tabs.some(t => t.id === x.tab) ? x.tab : tabs[0]?.id || '', text: x.text, assignee: '', done: false, createdAt: serverTimestamp() }], ['delete', doc(col('trash'), x.id)]]), 'restore', `กู้คืน ${rows.length} ไอดี`, rows.map(x => x.text)).then(() => toast(`กู้คืน ${rows.length} ไอดีแล้ว`, 'success'));

// ---------- boot ----------
function listen() {
  if (started) return; started = true;
  const warn = (e) => console.warn('vault:', e);
  subs = [
    onSnapshot(col('tabs'), (s) => { tabs = s.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => ms(a.createdAt) - ms(b.createdAt)); render(); }, warn),
    onSnapshot(col('ids'), (s) => { ids = s.docs.map(d => ({ id: d.id, ...d.data() })); render(); }, warn),
    onSnapshot(col('team'), (s) => { team = s.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => ms(a.createdAt) - ms(b.createdAt)); render(); }, warn),
    onSnapshot(col('trash'), (s) => {
      trash = s.docs.map(d => ({ id: d.id, ...d.data() })); render();
      const old = trash.filter(x => x.deletedAt && ms(x.deletedAt) < Date.now() - 7 * 864e5);
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
  gate(`<p class="font-semibold text-lg">โปรแกรมยังไม่เปิดสิทธิ์</p><p class="text-slate text-sm mt-2 mb-4">จัดการไอดีหลายแท็บ แจกงานทีมผ่านลิงก์ ตรวจประวัติย้อนหลัง</p>${packs().length || trialDays() ? `<div class="text-left max-w-sm mx-auto">${packsHtml()}</div>` : ''}
    <div class="flex justify-center gap-2 mt-4 flex-wrap">${contactsOf(ST).map(c => `<a href="${esc(c.url)}" target="_blank" rel="noopener" class="rounded-full border border-steel px-4 py-2 text-[14px]">${esc(c.label)}</a>`).join('')}</div>`);
};
onSettings((st) => { ST = st; renderGate(); });
let unsubUser = () => {};
onAuthStateChanged(auth, (u) => {
  subs.forEach(f => f()); subs = []; unsubUser(); started = false; uid = u?.uid || ''; signedIn = !!u; isOpen = false; renderGate();
  if (!u) return;
  unsubUser = onSnapshot(doc(db, 'users', u.uid), (s) => {
    const until = ms(s.data()?.vaultUntil); trialUsed = s.data()?.vaultTrialUsed === true; isOpen = until > Date.now();
    const left = Math.ceil((until - Date.now()) / 864e5), warn = $('v-warn'); warn.classList.toggle('hidden', !(isOpen && left <= 3));
    warn.innerHTML = `สิทธิ์เหลือ ${left} วัน · <button type="button" onclick="vRenew()" class="text-appleBlue">ต่ออายุ</button>`;
    $('v-until').innerHTML = isOpen ? `สิทธิ์ใช้งานถึง ${new Date(until).toLocaleDateString('th-TH', { dateStyle: 'medium' })} · <button type="button" onclick="vRenew()" class="text-appleBlue">ต่ออายุ</button>` : '';
    if (isOpen && s.data()?.vaultAlerts > 0) updateDoc(doc(db, 'users', u.uid), { vaultAlerts: 0 }).catch(() => {});
    if (isOpen) { $('v-gate').classList.add('hidden'); $('v-app').classList.remove('hidden'); listen(); } else renderGate();
  }, (e) => console.warn('vault user:', e));
});
