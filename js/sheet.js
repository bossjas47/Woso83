import { esc } from "./ui.js";

/**
 * Spreadsheet-style table of IDs shared by the leader page (vault.html) and the member page (team.html).
 * Columns: [select] # | ไอดี | กระสุน (กอง) | สถานะ | หมายเหตุ | คัดลอก. Edits are reported through data-f attributes:
 * the page listens for `change` on [data-f] and `click` on [data-copy].
 */
export const COLORS = [null, '#d93025', '#e8710a', '#c7a600', '#1e8e3e', '#1a73e8', '#8430ce'];
export const DEFAULT_LABELS = ['—', 'มีปัญหา', 'กำลังทำ', 'รอตรวจ', 'เสร็จแล้ว', 'พร้อมขาย', 'จองแล้ว'];
export const labelOf = (labels, i) => (i ? labels[i] || DEFAULT_LABELS[i] : '—');

/** "email|pass|20" -> { text: "email|pass", ammo: 20 }: a last |-part that is a whole number is the ammo count. */
export function parseLine(line) {
  const t = String(line).replace(/\s*\(฿[^)]*\)\s*$/, '').trim(), parts = t.split('|'); // a price tail from an export is ignored
  if (parts.length >= 3 && /^\d{1,6}$/.test(parts.at(-1).trim())) return { text: parts.slice(0, -1).join('|').trim(), ammo: Number(parts.at(-1).trim()) };
  return { text: t, ammo: 0 };
}
/** What is copied / handed to a customer: the ID plus its ammo when known (same format as the import). */
export const withPass = (x) => { if (!x.pass) return x.text; const p = String(x.text).split('|'); return [p[0], x.pass, ...p.slice(2)].join('|'); }; // a set password replaces the one inside the pasted line
export const copyLine = (x) => { const t = withPass(x); return Number(x.ammo) > 0 ? `${t}|${Number(x.ammo)}` : t; };
const baht = (n) => `฿${Number(n).toLocaleString('th-TH', { maximumFractionDigits: 2 })}`;
/** Price of one ID: the bundle price when set, else price per ammo x ammo. */
export const priceOf = (x) => (Number(x.priceAll) > 0 ? Number(x.priceAll) : Number(x.priceAmmo) > 0 ? Number(x.priceAmmo) * (Number(x.ammo) || 0) : 0);
export const priceTag = (x) => [Number(x.priceAmmo) > 0 && `${baht(x.priceAmmo)}/กอง`, Number(x.priceAll) > 0 && `เหมา ${baht(x.priceAll)}`].filter(Boolean).join(' · ');
/** What is exported to a customer: the re-importable line plus its price tag, e.g. "mail|pw|20 (฿5/กอง · เหมา ฿100)". */
export const exportLine = (x) => { const t = priceTag(x); return t ? `${copyLine(x)} (${t})` : copyLine(x); };
export const money = baht;

const dot = (c) => `<span class="sh-dot" style="${COLORS[c] ? `background:${COLORS[c]}` : 'border:1.5px solid #c7c7cc'}"></span>`;

export function sheetHtml(rows, { labels = DEFAULT_LABELS, selectable = false, sel = new Set(), sort = '' } = {}) {
  if (!rows.length) return '';
  const opts = (c) => DEFAULT_LABELS.map((_, i) => `<option value="${i}" ${i === (c || 0) ? 'selected' : ''}>${esc(labelOf(labels, i))}</option>`).join('');
  return `<div class="sh-wrap"><table class="sh">
    <thead><tr>${selectable ? `<th class="sh-ck"><input type="checkbox" data-selall ${rows.every(x => sel.has(x.id)) ? 'checked' : ''} aria-label="เลือกทั้งหมดที่แสดง"></th>` : ''}<th class="sh-n">#</th><th>ไอดี</th>
      <th class="sh-ammo"><button type="button" data-sort="ammo">กระสุน ${sort === 'ammo' ? '↓' : ''}</button></th><th class="sh-st">สถานะ</th><th>หมายเหตุ</th><th class="sh-cp"></th></tr></thead>
    <tbody>${rows.map((x, i) => `<tr data-id="${esc(x.id)}" class="${sel.has(x.id) ? 'on' : ''}">
      ${selectable ? `<td class="sh-ck"><input type="checkbox" data-sel ${sel.has(x.id) ? 'checked' : ''} aria-label="เลือกแถว ${i + 1}"></td>` : ''}
      <td class="sh-n">${i + 1}</td>
      <td class="sh-id"><code>${esc(x.text)}</code>${x.pass ? `<small>รหัส ${esc(x.pass)}</small>` : ''}${priceTag(x) ? `<small>${esc(priceTag(x))}</small>` : ''}</td>
      <td class="sh-ammo"><input type="number" min="0" max="999999" inputmode="numeric" data-f="ammo" value="${Number(x.ammo) > 0 ? Number(x.ammo) : ''}" placeholder="0" aria-label="กระสุน (กอง)"></td>
      <td class="sh-st"><label>${dot(x.color || 0)}<select data-f="color" aria-label="สถานะ">${opts(x.color)}</select></label></td>
      <td><input data-f="note" maxlength="200" value="${esc(x.note || '')}" placeholder="—" aria-label="หมายเหตุ"></td>
      <td class="sh-cp"><button type="button" data-copy aria-label="คัดลอกแถว ${i + 1}">คัดลอก</button></td></tr>`).join('')}</tbody></table></div>`;
}

/** Totals line for a list of rows. */
export const sumText = (rows) => `${rows.length} ไอดี · กระสุนรวม ${rows.reduce((a, x) => a + (Number(x.ammo) || 0), 0).toLocaleString('th-TH')} กอง`;

/** Wires a container: edits -> onEdit(id, field, value), copy -> onCopy(id), select -> onSel(id, on), header sort -> onSort(key). */
export function bindSheet(el, { onEdit, onCopy, onSel, onSelAll, onSort }) {
  el.addEventListener('change', (e) => {
    if (e.target.matches('[data-selall]')) return onSelAll?.(e.target.checked);
    const tr = e.target.closest('tr[data-id]'); if (!tr) return;
    if (e.target.matches('[data-sel]')) return onSel?.(tr.dataset.id, e.target.checked);
    const f = e.target.dataset.f; if (!f) return;
    const v = f === 'note' ? e.target.value.trim().slice(0, 200) : Math.max(0, Math.min(f === 'color' ? 6 : 999999, Math.floor(Number(e.target.value) || 0)));
    if (f === 'color') { const d = tr.querySelector('.sh-dot'); d.outerHTML = dot(v); }
    onEdit(tr.dataset.id, f, v);
  });
  el.addEventListener('click', (e) => {
    const s = e.target.closest('[data-sort]'); if (s) return onSort?.(s.dataset.sort);
    if (e.target.closest('[data-copy]')) onCopy(e.target.closest('tr').dataset.id);
  });
}
/** A snapshot must not re-render while someone is typing in a cell. */
export const editing = (el) => el.contains(document.activeElement) && document.activeElement.matches('input:not([type=checkbox]), select');
