import { ROOT, esc, icon, ICONS } from "./ui.js";

/** Product card shared by the home and category pages. The whole card links to the product page. */
export const productUrl = (id, buy = false) => `${ROOT}front/product.html?id=${encodeURIComponent(id)}${buy ? '&action=buy' : ''}`;

/** Delivery badge: game IDs paid with credit are delivered automatically; services follow the queue. */
export function deliveryBadge(isService, instant) {
  if (isService) return `<span class="badge badge-queue">${icon(ICONS.queue, 'w-3.5 h-3.5', 2)}งานบริการ (ตามคิว)</span>`;
  return instant
    ? `<span class="badge badge-auto">${icon(ICONS.bolt, 'w-3.5 h-3.5', 2)}ส่งอัตโนมัติ (รับไอดีทันที)</span>`
    : `<span class="badge badge-auto">${icon(ICONS.id, 'w-3.5 h-3.5', 2)}ไอดีเกม (รับในเมนูออเดอร์)</span>`;
}

export function productCardHtml({ p, isService, unit, min, price, stock, koen, categoryName, fallback, instant }) {
  const out = stock <= 0;
  const low = !isService && stock > 0 && stock <= 3;
  const url = productUrl(p.id);
  const name = esc(p.name || 'ไม่มีชื่อสินค้า');
  const stockText = out ? (isService ? 'คิวเต็ม' : 'สินค้าหมด')
    : isService ? `รับงานได้ ${stock} ${esc(unit)}` : low ? `เหลือ ${stock} ไอดี` : `คงเหลือ ${stock} ไอดี`;
  const stockCls = out ? 'text-slate' : low ? 'text-launchOrange' : 'text-ink';
  const tags = (Array.isArray(p.tags) ? p.tags : []).slice(0, 2).map(t => `<span class="text-[11px] text-slate bg-mist rounded-full px-2.5 py-0.5">${esc(t)}</span>`).join('');
  return `
    <article class="apple-card p-3 flex flex-col h-full group relative">
      <a href="${url}" class="relative block aspect-[4/3] rounded-[22px] overflow-hidden bg-mist" aria-label="${name}">
        <img src="${esc(p.image || fallback)}" alt="" loading="lazy" onerror="this.onerror=null;this.src='${fallback}'"
          class="w-full h-full object-cover transition-transform duration-500 group-hover:scale-[1.03] ${out ? 'grayscale opacity-70' : ''}">
        ${p.featured ? `<span class="absolute top-3 left-3 badge badge-featured bg-gallery/95">${icon(ICONS.star, 'w-3.5 h-3.5', 2)}แนะนำ</span>` : ''}
        <span class="absolute bottom-3 left-3 bg-gallery/90 backdrop-blur text-[11px] font-medium px-2.5 py-1 rounded-full ${stockCls}">${stockText}</span>
      </a>
      <div class="flex flex-col flex-grow px-2.5 pt-3.5 pb-1.5">
        <div class="flex flex-wrap gap-1.5">${deliveryBadge(isService, instant)}</div>
        ${categoryName ? `<p class="text-xs text-slate mt-2.5">${esc(categoryName)}</p>` : '<div class="mt-2"></div>'}
        <h3 class="text-[17px] leading-snug font-semibold text-ink line-clamp-2 mt-0.5"><a href="${url}" class="hover:text-appleBlue">${name}</a></h3>
        ${koen ? `<p class="text-sm text-slate mt-1 line-clamp-1">${esc(koen)}</p>` : ''}
        ${tags ? `<div class="flex flex-wrap gap-1.5 mt-2.5">${tags}</div>` : ''}
        <div class="mt-auto pt-4 flex items-end justify-between gap-3">
          <div>
            <p class="text-2xl leading-none font-heading font-semibold">฿${Number(price).toLocaleString('th-TH', { maximumFractionDigits: 2 })}${isService ? `<span class="text-sm text-slate font-normal"> / ${esc(unit)}</span>` : ''}</p>
            ${isService && min > 1 ? `<p class="text-xs text-slate mt-1.5">ขั้นต่ำ ${min} ${esc(unit)}</p>` : ''}
          </div>
          ${out
            ? `<span class="bg-control text-steel rounded-full px-5 py-2 text-sm">${isService ? 'คิวเต็ม' : 'หมด'}</span>`
            : `<a href="${productUrl(p.id, true)}" class="apple-pricing-pill pl-5 pr-4 py-2 text-sm">สั่งซื้อ${icon(ICONS.arrow, 'w-4 h-4', 2)}</a>`}
        </div>
      </div>
    </article>`;
}

export function productSkeletonHtml(n = 6) {
  return Array.from({ length: n }).map(() => `
    <div class="apple-card p-3" aria-hidden="true">
      <div class="skeleton aspect-[4/3] !rounded-[22px]"></div>
      <div class="px-2.5 pt-4 space-y-2.5"><div class="skeleton h-5 w-40 !rounded-full"></div><div class="skeleton h-5 w-3/4"></div><div class="skeleton h-4 w-1/2"></div>
      <div class="flex justify-between items-end pt-4 pb-2"><div class="skeleton h-7 w-24"></div><div class="skeleton h-9 w-24 !rounded-full"></div></div></div>
    </div>`).join('');
}
