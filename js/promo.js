/**
 * Discount-code rules shared by the product page (preview) and mirrored in worker/slip-worker.js (wallet
 * purchases, the source of truth there). A code: { type: 'fixed'|'percent', value, appliesTo: 'all'|'categories'|'products',
 * categoryIds: [], productIds: [], maxTotalUses, usedCount, maxPerUser, active }.
 */
export function promoScopeOk(promo, product) {
  const scope = promo?.appliesTo || 'all';
  if (scope === 'categories') return (promo.categoryIds || []).includes(product?.category);
  if (scope === 'products') return (promo.productIds || []).includes(product?.id);
  return true;
}

/** -> { ok, discount, message } for a subtotal. */
export function evaluatePromo(promo, product, subtotal) {
  const value = Number(promo?.value);
  if (!promo || promo.active === false || !['fixed', 'percent'].includes(promo.type) || !(value > 0)) return { ok: false, discount: 0, message: 'ไม่พบโค้ดส่วนลดนี้ หรือโค้ดหมดอายุ' };
  const quota = Number(promo.maxTotalUses) || 0;
  if (quota > 0 && (Number(promo.usedCount) || 0) >= quota) return { ok: false, discount: 0, message: 'โค้ดนี้ถูกใช้ครบตามจำนวนแล้ว' };
  if (!promoScopeOk(promo, product)) return { ok: false, discount: 0, message: 'โค้ดนี้ใช้กับสินค้านี้ไม่ได้' };
  const raw = promo.type === 'percent' ? Math.round(subtotal * Math.min(value, 100) / 100 * 100) / 100 : value;
  return { ok: true, discount: Math.min(raw, subtotal), message: promo.type === 'percent' ? `ลด ${value}%` : `ลด ${value} บาท` };
}
