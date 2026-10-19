import { db } from "../firebase-config.js";
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
