import { db, auth } from "../firebase-config.js";
import { toast, ROOT } from "./ui.js";
import { doc, getDoc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

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

/** Cart button on product cards (card.js): one unit, no mode. Guests go to login and come back. */
window.quickAddCart = async (btn, id, qty = 1) => {
  const u = auth.currentUser;
  if (!u) { location.href = `${ROOT}front/login.html?mode=login&next=${encodeURIComponent(location.pathname + location.search)}`; return; }
  if (btn.disabled) return;
  btn.disabled = true;
  try { await addToCart(u.uid, { productId: id, quantity: Math.max(1, qty | 0), farmMode: '' }, Math.max(1, Number(btn.dataset.max) || 1)); btn.classList.add('added'); toast('เพิ่มลงตะกร้าแล้ว', 'success'); setTimeout(() => btn.classList.remove('added'), 1200); }
  catch (e) { console.warn('cart:', e); toast(e.message || 'เพิ่มลงตะกร้าไม่สำเร็จ', 'error'); }
  finally { btn.disabled = false; }
};
