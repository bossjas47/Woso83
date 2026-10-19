import { db } from "../firebase-config.js";
import { doc, getDoc, updateDoc, writeBatch, serverTimestamp, increment } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

/**
 * Makes sure users/{uid} has a profile (username, email, facebook). The first time it is created the
 * public user counter stats/public.users goes up by one in the same batch (firestore.rules checks both).
 * Wallet balance, role and status are never written from here; only an admin or the Worker can set them.
 */
const inflight = new Map();

export function ensureProfile(user, extra = {}) {
  if (!user) return Promise.resolve(null);
  const key = user.uid;
  const run = (inflight.get(key) || Promise.resolve()).then(() => doEnsure(user, extra)).catch((e) => { console.warn('profile:', e.code || e); return null; });
  inflight.set(key, run);
  return run;
}

async function doEnsure(user, extra) {
  const ref = doc(db, 'users', user.uid);
  const snap = await getDoc(ref);
  const username = String(user.displayName || (user.email || '').split('@')[0] || 'user').slice(0, 40);
  const clean = Object.fromEntries(Object.entries(extra).filter(([k, v]) => ['facebook', 'contactEmail'].includes(k) && typeof v === 'string').map(([k, v]) => [k, v.trim().slice(0, 200)]));
  if (!snap.exists()) {
    const batch = writeBatch(db);
    batch.set(ref, { username, email: user.email || '', ...clean, createdAt: serverTimestamp(), lastLoginAt: serverTimestamp() });
    batch.set(doc(db, 'stats', 'public'), { users: increment(1) }, { merge: true });
    await batch.commit();
    return { username, ...clean };
  }
  const data = snap.data();
  const patch = { ...clean };
  if (!data.username) patch.username = username;
  if (!data.email && user.email) patch.email = user.email;
  const last = data.lastLoginAt?.toMillis?.() || 0;
  if (Date.now() - last > 6 * 3600e3) patch.lastLoginAt = serverTimestamp();
  if (Object.keys(patch).length) await updateDoc(ref, patch);
  return { ...data, ...patch };
}
