/** Product card shared by the home and category pages. Buttons call window.openDetailModal / startCheckout. */
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (d, cls = 'w-3.5 h-3.5') => `<svg class="${cls}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
const I = {
  id: 'M6 8h12a4 4 0 014 4v3a3 3 0 01-5 2l-2-2H9l-2 2a3 3 0 01-5-2v-3a4 4 0 014-4zM8 12v3M6.5 13.5h3M16 12h.01M18 14h.01',
  bolt: 'M13 2L4 14h7l-1 8 9-12h-7l1-8z',
  arrow: 'M5 12h14M13 6l6 6-6 6'
};

export function productCardHtml({ p, isService, unit, min, price, stock, koen, categoryName, fallback }) {
  const out = stock <= 0;
  const low = !isService && stock > 0 && stock <= 3;
  const idArg = esc(JSON.stringify(String(p.id ?? '')));
  const name = esc(p.name || 'ไม่มีชื่อสินค้า');
  const stockText = out ? (isService ? 'คิวเต็ม' : 'สินค้าหมด')
    : isService ? `รับงานได้ ${stock} ${esc(unit)}` : low ? `เหลือ ${stock} ไอดี` : `คงเหลือ ${stock} ไอดี`;
  const stockCls = out ? 'text-slate' : low ? 'text-launchOrange' : 'text-ink';
  const tags = (Array.isArray(p.tags) ? p.tags : []).slice(0, 2).map(t => `<span class="text-[11px] text-slate bg-mist rounded-full px-2.5 py-0.5">${esc(t)}</span>`).join('');
  return `
    <article class="apple-card p-3 flex flex-col h-full group">
      <div onclick="openDetailModal(${idArg})" class="relative aspect-[4/3] rounded-[22px] overflow-hidden bg-mist cursor-pointer">
        <img src="${esc(p.image || fallback)}" alt="${name}" loading="lazy" onerror="this.onerror=null;this.src='${fallback}'"
          class="w-full h-full object-cover transition-transform duration-500 group-hover:scale-[1.03] ${out ? 'grayscale opacity-70' : ''}">
        <span class="absolute top-3 left-3 inline-flex items-center gap-1 bg-gallery/90 backdrop-blur text-ink text-[11px] font-medium px-2.5 py-1 rounded-full">${icon(isService ? I.bolt : I.id)}${isService ? 'บริการ' : 'ไอดีเกม'}</span>
        <span class="absolute bottom-3 left-3 bg-gallery/90 backdrop-blur text-[11px] font-medium px-2.5 py-1 rounded-full ${stockCls}">${stockText}</span>
      </div>
      <div class="flex flex-col flex-grow px-2.5 pt-4 pb-1.5">
        ${categoryName ? `<p class="text-xs text-slate">${esc(categoryName)}</p>` : ''}
        <h3 onclick="openDetailModal(${idArg})" class="text-[17px] leading-snug font-semibold text-ink line-clamp-2 cursor-pointer mt-0.5">${name}</h3>
        <p class="text-sm text-slate mt-1 line-clamp-1">${esc(koen)}</p>
        ${tags ? `<div class="flex flex-wrap gap-1.5 mt-2.5">${tags}</div>` : ''}
        <div class="mt-auto pt-4 flex items-end justify-between gap-3">
          <div>
            <p class="text-2xl leading-none font-heading font-semibold">฿${Number(price).toLocaleString('th-TH', { maximumFractionDigits: 2 })}${isService ? `<span class="text-sm text-slate font-normal"> / ${esc(unit)}</span>` : ''}</p>
            ${isService && min > 1 ? `<p class="text-xs text-slate mt-1.5">ขั้นต่ำ ${min} ${esc(unit)}</p>` : ''}
          </div>
          <button type="button" onclick="startCheckout(${idArg})" ${out ? 'disabled' : ''}
            class="${out ? 'bg-control text-steel rounded-full px-5 py-2 text-sm cursor-not-allowed' : 'apple-pricing-pill pl-5 pr-4 py-2 text-sm gap-1.5'}">สั่งซื้อ${out ? '' : icon(I.arrow, 'w-4 h-4')}</button>
        </div>
      </div>
    </article>`;
}
