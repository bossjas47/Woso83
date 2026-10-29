import { db } from "../../firebase-config.js";
import { doc, writeBatch } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

/** Drag rows of one admin table to a new place; every row in the table gets order = position x 10 in one batch.
 *  rows: <tr attr="docId"> inside #bodyId. Rows without the attribute (e.g. while a search is active) cannot be dragged. */
export function dragSort(bodyId, attr, col, say) {
  let from = null;
  const body = () => document.getElementById(bodyId);
  const rowOf = (e) => { const tr = e.target.closest?.(`tr[${attr}]`); return tr && body()?.contains(tr) ? tr : null; };
  const clear = () => body()?.querySelectorAll('.drag-over').forEach(r => r.classList.remove('drag-over'));
  document.addEventListener('dragstart', (e) => { const tr = rowOf(e); if (tr) { from = tr.getAttribute(attr); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', from); } });
  document.addEventListener('dragover', (e) => { const tr = from && rowOf(e); if (tr) { e.preventDefault(); clear(); tr.classList.add('drag-over'); } });
  document.addEventListener('dragend', () => { from = null; clear(); });
  document.addEventListener('drop', async (e) => {
    const tr = from && rowOf(e); if (!tr) return;
    e.preventDefault(); clear();
    const to = tr.getAttribute(attr), moved = from; from = null;
    if (to === moved) return;
    const rows = [...body().querySelectorAll(`tr[${attr}]`)], movedRow = rows.find(r => r.getAttribute(attr) === moved);
    const ids = rows.map(r => r.getAttribute(attr)).filter(id => id !== moved);
    ids.splice(ids.indexOf(to) + (movedRow.compareDocumentPosition(tr) & Node.DOCUMENT_POSITION_FOLLOWING ? 1 : 0), 0, moved);
    try { const b = writeBatch(db); ids.forEach((id, i) => b.update(doc(db, col, id), { order: (i + 1) * 10 })); await b.commit(); say('จัดลำดับแล้ว', 'success'); }
    catch (err) { console.warn(err); say('จัดลำดับไม่สำเร็จ', 'error'); }
  });
}
