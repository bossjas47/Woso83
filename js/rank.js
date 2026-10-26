/**
 * Member ranks. Bronze comes with the first purchase (users.hasBought), higher ranks with the total amount topped up
 * (users.topupTotal, money in only, bonus credit not counted). Thresholds and perks live in system/settings.ranks
 * (7 rows: { min, discount, bonus } in the order below), set in the back office. The Worker applies the same rules
 * (rankOf in worker/slip-worker.js): keep both in step.
 */
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
export const RANKS = [
  { key: 'bronze', name: 'Bronze', color: '#a2643c' },
  { key: 'silver', name: 'Silver', color: '#8a96a3' },
  { key: 'gold', name: 'Gold', color: '#c49a00' },
  { key: 'diamond', name: 'Diamond', color: '#1f8fd6' },
  { key: 'duchess', name: 'Duchess', color: '#c2417f' },
  { key: 'duke', name: 'Duke', color: '#6a4bd6' },
  { key: 'emperor', name: 'Emperor', color: '#1d1d1f', ink: '#f2c94c' }
];
/** Rank table with the shop's numbers; perks are percentages 0-100. */
export const rankTable = (st) => RANKS.map((r, i) => {
  const c = (Array.isArray(st?.ranks) ? st.ranks[i] : null) || {};
  return { ...r, min: i ? Math.max(0, num(c.min)) : 0, discount: Math.min(100, Math.max(0, num(c.discount))), bonus: Math.min(100, Math.max(0, num(c.bonus))) };
});
/** -1 = no rank yet (never bought). A rank whose minimum is 0 (not set) above Bronze is never reached. */
export function rankOf(profile, st) {
  if (!profile?.hasBought) return -1;
  const t = num(profile.topupTotal), tb = rankTable(st);
  let at = 0;
  for (let i = 1; i < tb.length; i++) if (tb[i].min > 0 && t >= tb[i].min) at = i;
  return at;
}
/** Rank discount on an order total (after promo), rounded like the Worker. */
export const rankDiscount = (amount, profile, st) => { const i = rankOf(profile, st); return i < 0 ? 0 : Math.round(amount * rankTable(st)[i].discount) / 100; };

// Shield + an emblem that grows with the rank: 1-3 chevrons, gem, tiara, crown, crown with jewel.
const EMBLEM = [
  '<path d="M8.5 11l3.5 2.5 3.5-2.5" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  '<path d="M8.5 9l3.5 2.5L15.5 9M8.5 13l3.5 2.5 3.5-2.5" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  '<path d="M8.5 7.5l3.5 2.5 3.5-2.5M8.5 11l3.5 2.5 3.5-2.5M8.5 14.5L12 17l3.5-2.5" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
  '<path d="M9.2 8h5.6l2 2.8L12 16.5l-4.8-5.7z" fill="#fff"/><path d="M7.2 10.8h9.6M10.4 8l1.6 8.5 1.6-8.5" fill="none" stroke="#1f8fd6" stroke-width=".9"/>',
  '<path d="M7.5 14.5l.8-5.2 2.2 2.4L12 8l1.5 3.7 2.2-2.4.8 5.2z" fill="#fff"/><circle cx="12" cy="7.2" r="1" fill="#fff"/>',
  '<path d="M7 15l-.6-6.4 3 2.4L12 7l2.6 4 3-2.4L17 15z" fill="#fff"/><path d="M7 16.4h10" stroke="#fff" stroke-width="1.4" stroke-linecap="round"/>',
  '<path d="M7 14.6l-.6-6.4 3 2.4L12 6.6l2.6 4 3-2.4-.6 6.4z" fill="#f2c94c"/><path d="M7 16.2h10" stroke="#f2c94c" stroke-width="1.4" stroke-linecap="round"/><circle cx="12" cy="11.6" r="1.2" fill="#1d1d1f"/>'
];
export function rankIcon(i, cls = 'w-6 h-6') {
  const r = RANKS[i]; if (!r) return '';
  return `<svg class="${cls}" viewBox="0 0 24 24" role="img" aria-label="ยศ ${r.name}"><path d="M12 1.8l8.2 3v6.4c0 5.2-3.5 9.3-8.2 11-4.7-1.7-8.2-5.8-8.2-11V4.8z" fill="${r.color}"/>${EMBLEM[i]}</svg>`;
}
/** Small inline badge: icon + name. */
export const rankBadge = (i, cls = 'w-4 h-4') => (i < 0 ? '' : `<span class="rank-badge" style="--rk:${RANKS[i].color}">${rankIcon(i, cls)}${RANKS[i].name}</span>`);

/** Custom title an admin gives a user (users.title + users.titleColor); plain text badge, colours are fixed presets. */
export const TITLE_COLORS = { gray: ['#f5f5f7', '#1d1d1f', 'เทา'], blue: ['#eaf3ff', '#0071e3', 'น้ำเงิน'], violet: ['#f3edff', '#7c3aed', 'ม่วง'], green: ['#e7f8ec', '#1f9d55', 'เขียว'], orange: ['#fff3e6', '#b64400', 'ส้ม'], gold: ['#fff3d6', '#8a6100', 'ทอง'] };
export function titleBadge(p) {
  const t = String(p?.title || '').trim().slice(0, 24); if (!t) return '';
  const [bg, fg] = TITLE_COLORS[p.titleColor] || TITLE_COLORS.gray;
  return `<span class="text-[11px] font-semibold px-2.5 py-0.5 rounded-full" style="background:${bg};color:${fg}">${t.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))}</span>`;
}
