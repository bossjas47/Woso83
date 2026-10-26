// "ช่วยเลือกไอดี": 3 questions (budget, what matters, minimum level) -> the 3 best-fitting IDs in stock. Reads the product list the catalog already cached.
import { readProducts } from "./products-cache.js";
import { loadCategories, isServiceProduct } from "./categories.js";
import { esc, num, money } from "./ui.js";
import { productUrl, levelOf, hiddenFromShop } from "./card.js";

const level = levelOf;
const btn = 'display:block;width:100%;text-align:left;border:1px solid #d6d6d6;border-radius:16px;padding:12px 14px;margin-top:8px;background:#fff;color:#1d1d1f;font-size:14px;cursor:pointer';

/** Pure ranking so it can be tested: pool of ID products, answers {budget (max ฿ or 0), goal 'cheap'|'level'|'full', minLevel} -> up to 3 products. */
export function pickIds(pool, { budget = 0, goal = 'cheap', minLevel = 0 } = {}) {
  const fit = pool.filter(p => (!budget || num(p.price) <= budget) && (!minLevel || level(p) >= minLevel));
  const score = { cheap: (p) => -num(p.price), level: (p) => level(p) * 1e6 - num(p.price), full: (p) => (p.specs || []).length * 1e6 - num(p.price) }[goal] || (() => 0);
  return fit.sort((a, b) => score(b) - score(a)).slice(0, 3);
}

window.openPicker = async () => {
  const CATS = await loadCategories().catch(() => []);
  const pool = (readProducts() || []).filter(p => p.active !== false && !hiddenFromShop(p) && num(p.stock) > 0 && num(p.price) > 0 && !p.isAmmo && !p.isBox && !(num(p.rentHourPrice) > 0) && !(num(p.dropAt) > Date.now()) && !isServiceProduct(p, CATS));
  const m = document.createElement('div');
  m.style.cssText = 'position:fixed;inset:0;z-index:70;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;padding:16px';
  m.onclick = (e) => { if (e.target === m) m.remove(); };
  document.body.appendChild(m);
  const ans = {}, prices = pool.map(p => num(p.price)).sort((a, b) => a - b);
  const card = (inner) => { m.innerHTML = `<div style="background:#fff;color:#1d1d1f;border-radius:24px;max-width:460px;width:100%;max-height:88vh;overflow:auto;padding:18px">${inner}</div>`; };
  const steps = [
    { q: 'งบเท่าไหร่?', opts: () => { const a = prices[Math.floor(prices.length / 3)] || 0, b = prices[Math.floor(prices.length * 2 / 3)] || 0; return [[`ไม่เกิน ฿${money(a, 0)}`, a], [`ไม่เกิน ฿${money(b, 0)}`, b], ['ไม่จำกัด', 0]]; }, key: 'budget' },
    { q: 'อยากได้อะไรมากที่สุด?', opts: () => [['ถูกที่สุด', 'cheap'], ['เลเวลสูงสุด', 'level'], ['ข้อมูล/ของครบสุด', 'full']], key: 'goal' },
    { q: 'เลเวลขั้นต่ำที่รับได้?', opts: () => [['ไม่จำกัด', 0], ['20 ขึ้นไป', 20], ['40 ขึ้นไป', 40]], key: 'minLevel' }
  ];
  const ask = (i) => {
    if (i >= steps.length) {
      const r = pickIds(pool, ans);
      return card(`<b>${r.length ? 'ไอดีที่เหมาะกับคุณ' : 'ยังไม่มีไอดีที่ตรงเงื่อนไข ลองผ่อนเงื่อนไขดู'}</b>${r.map(p => `<a href="${esc(productUrl(p.id))}" style="${btn};display:flex;gap:10px;align-items:center;text-decoration:none">${p.image ? `<img src="${esc(p.image)}" alt="" style="width:56px;height:56px;border-radius:12px;object-fit:cover">` : ''}<span><b style="display:block">${esc(p.name)}</b>฿${money(num(p.price))}${level(p) ? ` · Lv ${level(p)}` : ''}</span></a>`).join('')}<button type="button" style="${btn}" id="pick-again">เลือกใหม่</button>`), m.querySelector('#pick-again').onclick = () => ask(0);
    }
    const s = steps[i], o = s.opts();
    card(`<p style="font-size:12px;color:#86868b">คำถาม ${i + 1}/${steps.length}</p><b>${s.q}</b>${o.map((x, n) => `<button type="button" data-n="${n}" style="${btn}">${esc(x[0])}</button>`).join('')}`);
    m.querySelectorAll('[data-n]').forEach(b => { b.onclick = () => { ans[s.key] = o[Number(b.dataset.n)][1]; ask(i + 1); }; });
  };
  ask(0);
};
