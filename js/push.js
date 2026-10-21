import { db, auth } from "../firebase-config.js";
import { doc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { callWorker, toast, esc } from "./ui.js";

/**
 * Web Push on this device: register /sw.js, subscribe with the Worker's VAPID key, save it in push_subs/{sha(endpoint)}.
 * Used by the vault (team alerts for the leader) and by customers (service queue: your turn / next / done).
 */
export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const iosBrowser = () => /iPhone|iPad|iPod/.test(navigator.userAgent) && !(matchMedia('(display-mode: standalone)').matches || navigator.standalone);
export const pushHint = () => (iosBrowser() ? 'iPhone/iPad: กดปุ่มแชร์ แล้ว "เพิ่มไปยังหน้าจอโฮม" เปิดเว็บจากไอคอนนั้น แล้วกดเปิดแจ้งเตือนอีกครั้ง (iOS 16.4 ขึ้นไป)' : 'เบราว์เซอร์นี้ไม่รองรับการแจ้งเตือน ลองใช้ Chrome หรือ Safari รุ่นใหม่');

/** true when this browser already has a live subscription. */
export async function pushOnHere() {
  if (!pushSupported() || Notification.permission !== 'granted') return false;
  const reg = await navigator.serviceWorker.getRegistration('/').catch(() => null);
  return !!(await reg?.pushManager.getSubscription().catch(() => null));
}

export async function enablePush() {
  const uid = auth.currentUser?.uid; if (!uid) throw new Error('เข้าสู่ระบบก่อน');
  if (!pushSupported()) throw new Error(pushHint());
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('ไม่ได้รับอนุญาตให้แจ้งเตือน เปิดสิทธิ์ในการตั้งค่าเบราว์เซอร์');
  const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' }); await navigator.serviceWorker.ready;
  const { key } = await callWorker('/push/key', {});
  const raw = Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - key.length % 4) % 4)), c => c.charCodeAt(0));
  let s = await reg.pushManager.getSubscription();
  const same = (a) => a && btoa(String.fromCharCode(...new Uint8Array(a))) === btoa(String.fromCharCode(...raw));
  if (s && !same(s.options.applicationServerKey)) { await s.unsubscribe(); s = null; } // the shop key changed
  s ||= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: raw });
  const j = s.toJSON(), id = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(j.endpoint)))].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 40);
  await setDoc(doc(db, 'push_subs', id), { uid, endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, createdAt: serverTimestamp() });
}

/** A small "turn on notifications" card in el, shown only while this device is not subscribed. */
export async function mountPushCard(el, text) {
  if (!el || !auth.currentUser || await pushOnHere()) { if (el) el.innerHTML = ''; return; }
  el.innerHTML = `<div class="soft-card px-5 py-4 flex items-center gap-3"><span class="flex-1 text-[14px]">${esc(text)}</span><button type="button" class="apple-pricing-pill px-4 py-2 text-[14px] shrink-0">เปิดแจ้งเตือน</button></div>`;
  el.querySelector('button').onclick = async (e) => {
    e.target.disabled = true;
    try { await enablePush(); el.innerHTML = ''; toast('เปิดแจ้งเตือนแล้ว', 'success'); }
    catch (err) { toast(err.message || 'เปิดแจ้งเตือนไม่สำเร็จ', 'error'); e.target.disabled = false; }
  };
}
