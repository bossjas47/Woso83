import { db, auth } from "../firebase-config.js";
import { toast, ROOT } from "./ui.js";
import { doc, getDoc, setDoc, onSnapshot, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

/** Cart = carts/{uid}.items: [{ productId, quantity, farmMode }]. Ids and quantities only; prices come from the product at checkout. */
export const MAX_LINES = 8;
export const saveCart = (uid, items) => setDoc(doc(db, 'carts', uid), { items, updatedAt: serverTimestamp() });
/** Adds a line (same product + mode = more quantity, capped). Returns the number of lines. */
export async function addToCart(uid, line, cap = 99999) {
  const items = (await getDoc(doc(db, 'carts', uid))).data()?.items || [];
  const same = items.find(x => x.productId === line.productId && (x.farmMode || '') === (line.farmMode || ''));
  if (same) same.quantity = Math.min(cap, same.quantity + line.quantity);
  else if (items.length >= MAX_LINES) throw new Error(`ตะกร้าเต็ม (สูงสุด ${MAX_LINES} รายการ) กรุณาชำระหรือลบบางรายการก่อน`);
  else items.push({ productId: line.productId, quantity: Math.min(cap, line.quantity), farmMode: line.farmMode || '' });
  await saveCart(uid, items);
  return items.length;
}

/** Product ids that are in the cart right now (live from carts/{uid}); the card buttons show it and a second tap takes the item out again. */
export const cartIds = new Set();
const paint = () => document.querySelectorAll('.card-cart[data-id]').forEach(b => {
  const on = cartIds.has(b.dataset.id);
  b.classList.toggle('added', on); b.title = on ? 'นำออกจากตะกร้า' : ''; b.setAttribute('aria-label', `${on ? 'นำออกจากตะกร้า' : 'เพิ่มลงตะกร้า'} ${b.dataset.name || ''}`);
});
let unsubCart = null;
onAuthStateChanged(auth, (u) => {
  unsubCart?.(); cartIds.clear(); paint();
  if (u) unsubCart = onSnapshot(doc(db, 'carts', u.uid), (s) => { cartIds.clear(); (s.data()?.items || []).forEach(i => cartIds.add(i.productId)); paint(); }, () => {});
});
// cards are drawn after load and again on every product update: repaint the buttons when new ones appear (childList only, so painting itself never retriggers it)
let t = null;
new MutationObserver(() => { clearTimeout(t); t = setTimeout(paint, 60); }).observe(document.documentElement, { childList: true, subtree: true });

/** Cart button on product cards (card.js): one unit, no mode. Guests go to login and come back. A card already in the cart: the tap removes it. */
window.quickAddCart = async (btn, id, qty = 1, mode = '') => {
  const u = auth.currentUser;
  if (!u) { location.href = `${ROOT}front/login.html?mode=login&next=${encodeURIComponent(location.pathname + location.search)}`; return; }
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    if (cartIds.has(id)) {
      const items = ((await getDoc(doc(db, 'carts', u.uid))).data()?.items || []).filter(x => x.productId !== id);
      await saveCart(u.uid, items); toast('นำออกจากตะกร้าแล้ว', 'success');
    } else { await addToCart(u.uid, { productId: id, quantity: Math.max(1, qty | 0), farmMode: mode }, Math.max(1, Number(btn.dataset.max) || 1)); toast('เพิ่มลงตะกร้าแล้ว', 'success'); }
  } catch (e) { console.warn('cart:', e); toast(e.message || 'ทำรายการตะกร้าไม่สำเร็จ', 'error'); }
  finally { btn.disabled = false; }
};
