import { ROOT, esc, icon, ICONS, imgAttrs } from "./ui.js";
import { regCompare, compareButton } from "./compare.js";
import "./cart-store.js"; // registers window.quickAddCart for the card cart button

/** Product card shared by the home and category pages. The whole card links to the product page. */
export const productUrl = (id, buy = false) => `${ROOT}front/product.html?id=${encodeURIComponent(id)}${buy ? '&action=buy' : ''}`;

/** Left out of every list: "secret link" products, and products whose auto-close time has passed (the product page still opens by link). */
export const hiddenFromShop = (p) => p?.unlisted === true || (Number(p?.hideAt) > 0 && Date.now() >= Number(p.hideAt));

/** Level written in the specs as "Level: 40" / "เลเวล: 40" (0 when the product has none). Used by the catalog filter and the ID picker. */
export const levelOf = (p) => { for (const t of p?.specs || []) { const m = /^\s*(?:level|lv\.?|เลเวล)[^:：]*[:：]\s*(\d+)/i.exec(String(t)); if (m) return Number(m[1]); } return 0; };

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

/** "โปรเหลือ 2 วัน 3 ชม." / "เปิดขายในอีก …" for a timed sale or drop; ticked every 30 s by the timer below (a drop that opens reloads the page so the buy button wakes up). */
const leftText = (ms, pre) => { const m = Math.max(0, Math.floor((ms - Date.now()) / 6e4)), d = Math.floor(m / 1440), h = Math.floor(m % 1440 / 60); return m < 1 ? (pre === 'โปรเหลือ' ? 'โปรหมดแล้ว' : 'เปิดขายแล้ว') : `${pre} ${d ? `${d} วัน ${h} ชม.` : h ? `${h} ชม. ${m % 60} นาที` : `${m} นาที`}`; };
const untilHtml = (ms, pre) => `<span data-until="${ms}" data-pre="${pre}" style="font-size:11px;color:#b64400">${leftText(ms, pre)}</span>`;
export const saleLeftHtml = (p) => p?.saleOn === true && Number(p.saleTo) > Date.now() ? untilHtml(Number(p.saleTo), 'โปรเหลือ') : '';
export const dropLeftHtml = (p) => Number(p?.dropAt) > Date.now() ? untilHtml(Number(p.dropAt), 'เปิดขายในอีก') : '';
setInterval(() => document.querySelectorAll('[data-until]').forEach(e => { const t = Number(e.dataset.until); e.textContent = leftText(t, e.dataset.pre); if (e.dataset.pre !== 'โปรเหลือ' && t <= Date.now() && location.pathname.includes('product.html')) location.reload(); }), 30000);

const CART_D = 'M3 4h2l2.4 11h10.2L20 7H6.2M9 20h.01M17 20h.01';
export function productCardHtml({ p, isService, unit, min, price, stock, koen, categoryName, fallback, instant }) {
  const rent = !isService && isRentProduct(p);
  const out = stock <= 0;
  // cart: sold IDs and services without a play mode to choose; rentals, ammo bundles and mode services go through the product page
  const waiting = Number(p.dropAt) > Date.now(); // timed drop not open yet
  const cartable = !waiting && !rent && !p.isAmmo && !(isService && Array.isArray(p.farmModes) && p.farmModes.length);
  const low = !isService && !p.isAmmo && stock > 0 && stock <= 3;
  const url = p.href || productUrl(p.id);
  const name = esc(p.name || 'ไม่มีชื่อสินค้า');
  if (p.isBox) return boxCardHtml(p, url);
  const cmp = !isService && !rent && !p.isAmmo && !out ? (regCompare(p, price, koen), compareButton(p.id)) : '';
  const stockText = out ? (isService ? 'คิวเต็ม' : rent ? 'ไม่มีไอดีว่าง' : 'สินค้าหมด')
    : p.isAmmo ? `พร้อมส่ง ${stock.toLocaleString('th-TH')} กอง` : rent ? `ว่างให้เช่า ${stock} ไอดี` : isService ? `รับงานได้ ${stock} ${esc(unit)}` : low ? `เหลือ ${stock} ไอดี` : `พร้อมส่ง ${stock} ไอดี`;
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
      ${cmp}
      <div class="flex flex-col flex-grow px-1 pt-2.5 pb-0.5">
        <p class="flex items-center gap-1.5 text-xs ${stockCls}"><span class="w-1.5 h-1.5 rounded-full ${dot}"></span>${stockText}</p>
        <h3 class="text-[15px] sm:text-base leading-snug font-semibold text-ink line-clamp-2 mt-1.5 min-h-[2.6em]"><a href="${url}">${name}</a></h3>
        ${koen ? `<p class="text-xs text-slate mt-0.5 line-clamp-1">${esc(koen)}</p>` : ''}
        <div class="mt-auto pt-2.5">
          <p class="text-xl leading-none font-heading font-semibold">฿${Number(price).toLocaleString('th-TH', { maximumFractionDigits: 2 })}${p.isAmmo ? '<span class="text-xs text-slate font-normal"> / กอง</span>' : rent ? `<span class="text-xs text-slate font-normal"> ${Number(p.rentHourPrice) > 0 ? '/ ชม.' : 'ขึ้นไป'}</span>` : isService ? `<span class="text-xs text-slate font-normal"> / ${esc(unit)}</span>` : ''}</p>
          ${saleLeftHtml(p) || dropLeftHtml(p) ? `<p class="mt-1">${saleLeftHtml(p)} ${dropLeftHtml(p)}</p>` : ''}
          ${isService && min > 1 ? `<p class="text-[11px] text-slate mt-1">ขั้นต่ำ ${min} ${esc(unit)}</p>` : ''}
          ${out
            ? `<span class="mt-3 flex items-center justify-center w-full h-12 rounded-full bg-control text-steel text-[15px] font-semibold">${isService ? 'คิวเต็ม' : rent ? 'ไม่มีไอดีว่าง' : 'สินค้าหมด'}</span>`
            : `<div class="mt-3 flex gap-2"><a href="${productUrl(p.id, true)}" class="apple-pricing-pill flex-1 min-w-0 h-12 text-[16px] font-semibold">${rent ? 'เช่าเลย' : 'สั่งซื้อ'}${icon(ICONS.arrow, 'w-4 h-4', 2.2)}</a>${cartable ? `<button type="button" onclick="quickAddCart(this, ${esc(JSON.stringify(p.id))}, ${min})" data-max="${isService ? 99999 : stock}" class="card-cart" aria-label="เพิ่ม ${name} ลงตะกร้า">${icon(CART_D, 'w-5 h-5', 2)}</button>` : ''}</div>`}
        </div>
      </div>
    </article>`;
}

/** Loot box shown as a product (in its category, or standalone). */
function boxCardHtml(p, url) {
  const name = esc(p.name);
  return `
    <article class="apple-card !rounded-[24px] p-2.5 sm:p-3 flex flex-col h-full group relative">
      <a href="${url}" class="relative block aspect-square rounded-[18px] overflow-hidden bg-mist" aria-label="${name}">
        <img ${imgAttrs(p.image, 320, 320)} alt="" class="w-full h-full object-cover transition-transform duration-500 group-hover:scale-[1.03]">
        <span class="absolute bottom-2 left-2 inline-flex items-center gap-1 bg-gallery/90 backdrop-blur text-[11px] font-medium px-2 py-0.5 rounded-full text-ink">กล่องสุ่ม</span>
      </a>
      <div class="flex flex-col flex-grow px-1 pt-2.5 pb-0.5">
        <p class="text-xs text-slate">${p.prizeCount} รางวัล · ลุ้นได้ทันที</p>
        <h3 class="text-[15px] sm:text-base leading-snug font-semibold text-ink line-clamp-2 mt-1.5 min-h-[2.6em]"><a href="${url}">${name}</a></h3>
        <div class="mt-auto pt-2.5">
          <p class="text-xl leading-none font-heading font-semibold">฿${Number(p.price).toLocaleString('th-TH', { maximumFractionDigits: 2 })}<span class="text-xs text-slate font-normal"> / ครั้ง</span></p>
          <a href="${url}" class="apple-pricing-pill mt-3 w-full h-12 text-[16px] font-semibold">เปิดกล่อง${icon(ICONS.arrow, 'w-4 h-4', 2.2)}</a>
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
