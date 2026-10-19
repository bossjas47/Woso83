import { ROOT, esc, icon, ICONS, imgAttrs } from "./ui.js";

/** Product card shared by the home and category pages. The whole card links to the product page. */
export const productUrl = (id, buy = false) => `${ROOT}front/product.html?id=${encodeURIComponent(id)}${buy ? '&action=buy' : ''}`;

/** A game ID that is lent by the hour (price fields set in admin) instead of sold. */
export const isRentProduct = (p) => !!p && (Number(p.rentHourPrice) > 0 || (Array.isArray(p.rentPackages) && p.rentPackages.some(k => Number(k.hours) > 0 && Number(k.price) > 0)));

/** Delivery badge: game IDs paid with credit are delivered automatically; services follow the queue; rentals show the login while they run. */
export function deliveryBadge(isService, instant, rent = false) {
  if (rent) return `<span class="badge badge-auto">${icon(ICONS.bolt, 'w-3.5 h-3.5', 2)}ไอดีเช่า (รับรหัสทันที)</span>`;
  if (isService) return `<span class="badge badge-queue">${icon(ICONS.queue, 'w-3.5 h-3.5', 2)}งานบริการ (ตามคิว)</span>`;
  return instant
    ? `<span class="badge badge-auto">${icon(ICONS.bolt, 'w-3.5 h-3.5', 2)}ส่งอัตโนมัติ (รับไอดีทันที)</span>`
    : `<span class="badge badge-auto">${icon(ICONS.id, 'w-3.5 h-3.5', 2)}ไอดีเกม (รับในเมนูออเดอร์)</span>`;
}

export function productCardHtml({ p, isService, unit, min, price, stock, koen, categoryName, fallback, instant }) {
  const rent = !isService && isRentProduct(p);
  const out = stock <= 0;
  const low = !isService && stock > 0 && stock <= 3;
  const url = productUrl(p.id);
  const name = esc(p.name || 'ไม่มีชื่อสินค้า');
  const stockText = out ? (isService ? 'คิวเต็ม' : rent ? 'ไม่มีไอดีว่าง' : 'สินค้าหมด')
    : rent ? `ว่างให้เช่า ${stock} ไอดี` : isService ? `รับงานได้ ${stock} ${esc(unit)}` : low ? `เหลือ ${stock} ไอดี` : `พร้อมส่ง ${stock} ไอดี`;
  const dot = out ? 'bg-steel' : low ? 'bg-launchOrange' : 'bg-emerald-500';
  const stockCls = out ? 'text-slate' : low ? 'text-launchOrange' : 'text-slate';
  const mode = rent ? `${icon(ICONS.queue, 'w-3 h-3', 2)}ให้เช่า` : isService ? `${icon(ICONS.queue, 'w-3 h-3', 2)}ตามคิว` : instant ? `${icon(ICONS.bolt, 'w-3 h-3', 2)}ส่งทันที` : `${icon(ICONS.id, 'w-3 h-3', 2)}รับในออเดอร์`;
  return `
    <article class="apple-card !rounded-[24px] p-2.5 sm:p-3 flex flex-col h-full group relative">
      <a href="${url}" class="relative block aspect-square rounded-[18px] overflow-hidden bg-mist" aria-label="${name}">
        <img ${imgAttrs(p.image || fallback, 320, 320)} alt=""
          class="w-full h-full object-cover transition-transform duration-500 group-hover:scale-[1.03] ${out ? 'grayscale opacity-70' : ''}">
        ${p.featured ? `<span class="absolute top-2 left-2 badge badge-featured bg-gallery/95">${icon(ICONS.star, 'w-3 h-3', 2)}แนะนำ</span>` : ''}
        <span class="absolute bottom-2 left-2 inline-flex items-center gap-1 bg-gallery/90 backdrop-blur text-[11px] font-medium px-2 py-0.5 rounded-full ${isService || rent ? 'text-launchOrange' : 'text-[#0a7a3b]'}">${mode}</span>
      </a>
      <div class="flex flex-col flex-grow px-1 pt-2.5 pb-0.5">
        <p class="flex items-center gap-1.5 text-xs ${stockCls}"><span class="w-1.5 h-1.5 rounded-full ${dot}"></span>${stockText}</p>
        <h3 class="text-[15px] sm:text-base leading-snug font-semibold text-ink line-clamp-2 mt-1.5 min-h-[2.6em]"><a href="${url}">${name}</a></h3>
        ${koen ? `<p class="text-xs text-slate mt-0.5 line-clamp-1">${esc(koen)}</p>` : ''}
        <div class="mt-auto pt-2.5">
          <p class="text-xl leading-none font-heading font-semibold">฿${Number(price).toLocaleString('th-TH', { maximumFractionDigits: 2 })}${rent ? `<span class="text-xs text-slate font-normal"> ${Number(p.rentHourPrice) > 0 ? '/ ชม.' : 'ขึ้นไป'}</span>` : isService ? `<span class="text-xs text-slate font-normal"> / ${esc(unit)}</span>` : ''}</p>
          ${isService && min > 1 ? `<p class="text-[11px] text-slate mt-1">ขั้นต่ำ ${min} ${esc(unit)}</p>` : ''}
          ${out
            ? `<span class="mt-3 flex items-center justify-center w-full h-12 rounded-full bg-control text-steel text-[15px] font-semibold">${isService ? 'คิวเต็ม' : rent ? 'ไม่มีไอดีว่าง' : 'สินค้าหมด'}</span>`
            : `<a href="${productUrl(p.id, true)}" class="apple-pricing-pill mt-3 w-full h-12 text-[16px] font-semibold">${rent ? 'เช่าเลย' : 'สั่งซื้อ'}${icon(ICONS.arrow, 'w-4 h-4', 2.2)}</a>`}
        </div>
      </div>
    </article>`;
}

export function productSkeletonHtml(n = 6) {
  return Array.from({ length: n }).map(() => `
    <div class="apple-card !rounded-[24px] p-2.5 sm:p-3" aria-hidden="true">
      <div class="skeleton aspect-square !rounded-[18px]"></div>
      <div class="px-1 pt-3 space-y-2"><div class="skeleton h-3.5 w-24 !rounded-full"></div><div class="skeleton h-4 w-3/4"></div><div class="skeleton h-5 w-1/2"></div><div class="skeleton h-12 w-full !rounded-full mt-3"></div></div>
    </div>`).join('');
}
