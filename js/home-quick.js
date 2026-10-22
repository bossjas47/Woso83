/** Home shortcut cards: system/settings.homeQuick = [{ on, icon, title, sub, href }] x4, edited in the back office (ตั้งค่า). */
export const QUICK_ICONS = {
  plus: ['เติมเงิน (+)', '<path d="M12 5v14M5 12h14"/>'],
  box: ['กล่อง', '<path d="M21 8l-9-5-9 5v8l9 5 9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/>'],
  key: ['กุญแจ', '<circle cx="8" cy="15" r="4"/><path d="M10.8 12.2L20 3M16 7l3 3"/>'],
  clock: ['นาฬิกา', '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'],
  cart: ['ตะกร้า', '<path d="M4 7h16l-1 13H5L4 7zm4 0a4 4 0 018 0"/>'],
  gift: ['ของขวัญ', '<path d="M4 11h16v9H4zM3 7h18v4H3zM12 7v13M12 7c-2-4-6-3-5 0M12 7c2-4 6-3 5 0"/>'],
  star: ['ดาว', '<path d="M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z"/>'],
  tool: ['เครื่องมือ', '<path d="M14.7 6.3a4 4 0 00-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 005.4-5.4l-2.6 2.6-2.4-.6-.6-2.4 2.6-2.6z"/>'],
  chat: ['แชท', '<path d="M21 12a8 8 0 01-11.6 7.1L4 20l1-4.6A8 8 0 1121 12z"/>'],
  user: ['บัญชี', '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0116 0"/>']
};
export const QUICK_DEFAULT = [
  { on: true, icon: 'plus', title: 'เติมเงิน', sub: 'เติมแล้วรับโบนัสเพิ่ม', href: 'front/topup.html' },
  { on: true, icon: 'box', title: 'กล่องสุ่ม', sub: 'เปิดลุ้นไอดีกับเครดิต', href: 'front/box.html' },
  { on: true, icon: 'key', title: 'เช่าไอดี', sub: 'เช่ารายชั่วโมง ไม่ต้องซื้อขาด', href: 'front/rentals.html' },
  { on: true, icon: 'clock', title: 'ตรวจสอบคิว', sub: 'ดูว่าอีกกี่คิวถึงตาคุณ', href: 'front/queue.html' }
];
/** Only https:// or a same-site path; anything with another scheme (javascript:, data:) becomes '#'. */
export const safeHref = (u) => { u = String(u || '').trim(); return /^https:\/\//i.test(u) || (u && !/^[a-z][\w+.-]*:/i.test(u) && !u.startsWith('//')) ? u : '#'; };
export const quickOf = (st) => QUICK_DEFAULT.map((d, i) => ({ ...d, ...((Array.isArray(st?.homeQuick) && st.homeQuick[i]) || {}) }));
