import { onSettings, workerBase, esc, toast } from "./ui.js";

// Team member page: opened from the owner's link (?k=token), no login. The Worker returns only this member's IDs.
const token = new URLSearchParams(location.search).get('k') || '';
const $ = (id) => document.getElementById(id);
let ids = [];
const call = async (path, body) => {
  const r = await fetch(workerBase() + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, ...body }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'โหลดไม่สำเร็จ');
  return j;
};
function render() {
  $('t-sub').textContent = `${ids.filter(x => x.done).length}/${ids.length} เสร็จแล้ว`;
  $('t-list').innerHTML = ids.length ? ids.map((x, i) => `<div class="soft-card px-4 py-3 ${x.done ? 'opacity-50' : ''}"><div class="flex items-center gap-3">
    <input type="checkbox" ${x.done ? 'checked' : ''} onchange="tDone(${i}, this.checked)" class="w-5 h-5 shrink-0" aria-label="เสร็จแล้ว">
    <code class="flex-1 min-w-0 break-all text-[14px]">${esc(x.text)}</code>
    <button type="button" onclick="tCopy(${i})" class="shrink-0 rounded-full border border-steel px-3 py-1 text-[12px]">คัดลอก</button></div>
    ${x.due || x.note ? `<p class="text-xs mt-2 ${!x.done && x.due && x.due < Date.now() ? 'text-launchOrange' : 'text-slate'}">${x.due ? `ส่งภายใน ${new Date(x.due).toLocaleDateString('th-TH', { day: 'numeric', month: 'short' })}` : ''}${x.due && x.note ? ' · ' : ''}${esc(x.note)}</p>` : ''}
    <p class="text-xs mt-2">${x.issue ? `<span class="text-launchOrange">⚠ ${esc(x.issue)}</span> · ` : ''}<button type="button" onclick="tIssue(${i})" class="text-appleBlue">${x.issue ? 'แก้ข้อความปัญหา' : 'แจ้งปัญหา'}</button></p></div>`).join('')
    : '<div class="soft-card py-12 px-6 text-center"><p class="font-semibold">ยังไม่มีไอดีที่มอบหมายให้คุณ</p></div>';
}
window.tIssue = async (i) => {
  const t = prompt('บอกปัญหาของไอดีนี้ (เช่น รหัสผิด โดนแบน) เว้นว่าง = ยกเลิกการแจ้ง', ids[i].issue || '');
  if (t === null) return;
  try { await call('/vault/team/issue', { id: ids[i].id, issue: t.trim().slice(0, 200) }); ids[i].issue = t.trim().slice(0, 200); render(); toast(t.trim() ? 'แจ้งหัวหน้าแล้ว' : 'ยกเลิกการแจ้งแล้ว', 'success'); }
  catch (e) { toast(e.message, 'error'); }
};
window.tCopy = async (i) => { try { await navigator.clipboard.writeText(ids[i].text); toast('คัดลอกแล้ว', 'success'); } catch (_) { toast('คัดลอกไม่ได้ กดค้างที่ข้อความแล้วคัดลอกเอง', 'error'); } };
window.tDone = async (i, done) => {
  ids[i].done = done; render();
  try { await call('/vault/team/done', { id: ids[i].id, done }); } catch (e) { ids[i].done = !done; render(); toast(e.message, 'error'); }
};
let started = false;
onSettings(async () => {
  if (started) return; started = true;
  if (!workerBase() || !token) { $('t-list').innerHTML = '<div class="soft-card py-12 px-6 text-center"><p class="font-semibold">ลิงก์ไม่ถูกต้อง</p></div>'; return; }
  try { const j = await call('/vault/team', {}); $('t-title').textContent = `งานของ ${j.name}`; ids = j.ids; render(); }
  catch (e) { $('t-list').innerHTML = `<div class="soft-card py-12 px-6 text-center"><p class="font-semibold">${esc(e.message)}</p></div>`; }
});
