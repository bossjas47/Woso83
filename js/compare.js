// Compare 2–3 game IDs side by side. Picks live in sessionStorage as small snapshots, so they survive moving between pages.
import { esc } from "./ui.js";

let mo; // set below
const K = 'astraphex_compare_v1', MAX = 3, seen = new Map();
let sel = [];
try { sel = JSON.parse(sessionStorage.getItem(K) || '[]').filter(x => x && x.id).slice(0, MAX); } catch (_) {}
const save = () => { try { sessionStorage.setItem(K, JSON.stringify(sel)); } catch (_) {} };
export const isCompared = (id) => sel.some(x => x.id === id);

/** Called by the card renderer so a click can pick up the card's data without another query. */
export function regCompare(p, price, koen) {
  seen.set(p.id, { id: p.id, name: String(p.name || ''), image: p.image || '', price: Number(price) || 0, koen: koen || '', specs: Array.isArray(p.specs) ? p.specs.slice(0, 30).map(String) : [], href: p.href || '' });
}
export const compareButton = (id) => `<button type="button" data-cmp="${esc(id)}" onclick="toggleCompare(this.dataset.cmp)" style="position:absolute;top:14px;right:14px;z-index:2;border:0;border-radius:999px;padding:3px 10px;font-size:11px;cursor:pointer;background:rgba(255,255,255,.92);color:#1d1d1f;box-shadow:0 1px 4px rgba(0,0,0,.2)">${isCompared(id) ? '✓ เทียบ' : '+ เทียบ'}</button>`;

function paint() {
  mo.disconnect();
  try { draw(); } finally { mo.observe(document.documentElement, { childList: true, subtree: true }); }
}
function draw() {
  document.querySelectorAll('[data-cmp]').forEach(b => { const on = isCompared(b.dataset.cmp); b.textContent = on ? '✓ เทียบ' : '+ เทียบ'; b.style.background = on ? '#0071e3' : 'rgba(255,255,255,.92)'; b.style.color = on ? '#fff' : '#1d1d1f'; });
  let bar = document.getElementById('cmp-bar');
  if (!sel.length) return bar?.remove();
  if (!bar) { bar = document.createElement('div'); bar.id = 'cmp-bar'; bar.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:18px;z-index:60;display:flex;align-items:center;gap:10px;padding:8px 8px 8px 16px;border-radius:999px;background:#1d1d1f;color:#fff;font-size:13px;box-shadow:0 6px 24px rgba(0,0,0,.3)'; document.body.appendChild(bar); }
  bar.innerHTML = `<span>เทียบ ${sel.length}/${MAX}</span><button type="button" onclick="openCompare()" ${sel.length < 2 ? 'disabled' : ''} style="border:0;border-radius:999px;padding:6px 14px;background:#0071e3;color:#fff;cursor:pointer;${sel.length < 2 ? 'opacity:.4' : ''}">ดูเปรียบเทียบ</button><button type="button" onclick="clearCompare()" style="border:0;background:none;color:#aaa;cursor:pointer;padding:6px 10px">ล้าง</button>`;
}

const kvOf = (t) => { const m = /^([^:：]{1,24})[:：]\s*(\S.*)$/.exec(t); return m ? [m[1].trim(), m[2].trim()] : null; };

window.toggleCompare = (id) => {
  if (isCompared(id)) sel = sel.filter(x => x.id !== id);
  else { const s = seen.get(id); if (!s) return; if (sel.length >= MAX) sel.shift(); sel.push(s); }
  save(); paint();
};
window.clearCompare = () => { sel = []; save(); paint(); document.getElementById('cmp-modal')?.remove(); };
window.openCompare = () => {
  if (sel.length < 2) return;
  const keys = [...new Set(sel.flatMap(x => x.specs.map(kvOf).filter(Boolean).map(k => k[0])))];
  const low = Math.min(...sel.map(x => x.price));
  const cell = 'padding:8px 10px;border-top:1px solid rgba(128,128,128,.25);vertical-align:top;font-size:13px';
  const row = (label, f) => `<tr><th style="${cell};text-align:left;font-weight:500;color:#86868b;white-space:nowrap">${label}</th>${sel.map(x => `<td style="${cell}">${f(x)}</td>`).join('')}</tr>`;
  const html = `<table style="width:100%;border-collapse:collapse;table-layout:fixed;min-width:${90 + sel.length * 150}px"><tbody>
    <tr><th style="width:90px"></th>${sel.map(x => `<td style="padding:8px 10px;vertical-align:top"><a href="${esc(x.href || `product.html?id=${encodeURIComponent(x.id)}`)}" style="color:inherit;text-decoration:none">${x.image ? `<img src="${esc(x.image)}" alt="" style="width:100%;aspect-ratio:1;object-fit:cover;border-radius:14px">` : ''}<b style="display:block;margin-top:6px;font-size:14px">${esc(x.name)}</b></a></td>`).join('')}</tr>
    ${row('ราคา', x => `<b style="font-size:16px;${x.price === low ? 'color:#0a7a3b' : ''}">฿${x.price.toLocaleString('th-TH', { maximumFractionDigits: 2 })}</b>${x.price === low && sel.length > 1 ? ' <small>ถูกสุด</small>' : ''}`)}
    ${x0(sel) ? row('ข้อมูล', x => esc(x.koen) || '–') : ''}
    ${keys.map(k => row(esc(k), x => { const f = x.specs.map(kvOf).find(p => p && p[0] === k); return f ? esc(f[1]) : '–'; })).join('')}
    ${row('อื่น ๆ', x => x.specs.filter(t => !kvOf(t)).map(t => `• ${esc(t)}`).join('<br>') || '–')}
  </tbody></table>`;
  document.getElementById('cmp-modal')?.remove();
  const m = document.createElement('div'); m.id = 'cmp-modal';
  m.style.cssText = 'position:fixed;inset:0;z-index:70;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;padding:16px';
  m.onclick = (e) => { if (e.target === m) m.remove(); };
  m.innerHTML = `<div style="background:#fff;color:#1d1d1f;border-radius:24px;max-width:760px;width:100%;max-height:88vh;overflow:auto;padding:16px"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><b>เปรียบเทียบไอดี</b><button type="button" onclick="document.getElementById('cmp-modal').remove()" style="border:0;background:none;font-size:20px;cursor:pointer;color:inherit">×</button></div><div style="overflow-x:auto">${html}</div></div>`;
  document.body.appendChild(m);
};
function x0(s) { return s.some(x => x.koen); }

mo = new MutationObserver(() => { clearTimeout(paint.t); paint.t = setTimeout(paint, 60); });
document.addEventListener('DOMContentLoaded', paint);
paint();
// cards are drawn after load and again on every Firestore update, so re-sync the button labels when the DOM changes
mo.observe(document.documentElement, { childList: true, subtree: true });
