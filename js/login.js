import { auth } from "../firebase-config.js";
import { signInWithEmailAndPassword, createUserWithEmailAndPassword, updateProfile } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { toast, icon, ICONS, contactsOf } from "./ui.js";
import { ensureProfile } from "./profile.js";

/**
 * Login / register with a username. Firebase Auth needs an e-mail, so the username is mapped to an ASCII
 * address @tactical.store (kept from the old site so existing accounts still sign in; the Worker uses the same mapping).
 */
const $ = (id) => document.getElementById(id);
const EYE = icon(ICONS.eye, 'w-5 h-5', 2), EYE_OFF = icon(ICONS.eyeOff, 'w-5 h-5', 2);
document.querySelectorAll('button[onclick^="togglePasswordInput"]').forEach(b => { b.innerHTML = EYE; });

function switchAuthMode(mode) {
  const login = mode !== 'register';
  $('form-login').classList.toggle('hidden', !login);
  $('form-register').classList.toggle('hidden', login);
  $('tab-btn-login').className = `py-2.5 rounded-full font-medium text-[15px] transition ${login ? 'bg-gallery text-ink shadow-sm' : 'text-slate'}`;
  $('tab-btn-register').className = `py-2.5 rounded-full font-medium text-[15px] transition ${!login ? 'bg-gallery text-ink shadow-sm' : 'text-slate'}`;
}

function togglePasswordInput(id, btn) {
  const i = $(id);
  const show = i.type === 'password';
  i.type = show ? 'text' : 'password';
  btn.innerHTML = show ? EYE_OFF : EYE;
  btn.setAttribute('aria-label', show ? 'ซ่อนรหัสผ่าน' : 'แสดงรหัสผ่าน');
}

export function usernameToEmail(username) {
  const clean = username.trim().toLowerCase();
  if (clean.includes('@')) return clean;
  const ascii = Array.from(clean).map(c => {
    const code = c.charCodeAt(0);
    return (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 95 ? c : `u${code.toString(16)}`;
  }).join('');
  return `${ascii || 'agent'}@tactical.store`;
}

try { localStorage.removeItem('tactical_accounts'); localStorage.removeItem('tactical_current_user'); } catch (_) {}

// same-site only: a page name (box.html, cart) or an absolute path (/front/box?id=…); never //host or a scheme
const next = () => { const n = new URLSearchParams(location.search).get('next'); return n && /^(\/(?![\/\\])[\w\-./]*|[a-z]+(\.html)?)([?#][^\\]*)?$/i.test(n) ? n : 'account.html'; };

let busy = false;
async function handleLogin(e) {
  e.preventDefault();
  if (busy) return;
  const username = $('login-username').value.trim();
  const password = $('login-password').value;
  if (!username || !password) { toast('กรุณากรอกชื่อผู้ใช้และรหัสผ่าน', 'error'); return; }
  busy = true; const btn = $('btn-login-submit'); btn.disabled = true; btn.textContent = 'กำลังเข้าสู่ระบบ…';
  try {
    const cred = await signInWithEmailAndPassword(auth, usernameToEmail(username), password);
    toast(`ยินดีต้อนรับ ${cred.user.displayName || username}`, 'success');
    setTimeout(() => { location.href = next(); }, 700);
  } catch (err) {
    const c = err.code || '';
    toast(c === 'auth/user-disabled' ? 'บัญชีนี้ถูกระงับการใช้งาน กรุณาติดต่อแอดมิน'
      : c === 'auth/too-many-requests' ? 'ลองหลายครั้งเกินไป กรุณารอสักครู่'
      : c === 'auth/network-request-failed' ? 'เชื่อมต่ออินเทอร์เน็ตไม่ได้' : 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง', 'error');
    busy = false; btn.disabled = false; btn.textContent = 'เข้าสู่ระบบ';
  }
}

async function handleRegister(e) {
  e.preventDefault();
  if (busy) return;
  const username = $('register-username').value.trim();
  const facebook = $('register-facebook').value.trim();
  const p1 = $('register-password').value, p2 = $('register-confirm-password').value;
  if ([...username].length < 3 || [...username].length > 24) { toast('ชื่อผู้ใช้ต้องมี 3–24 ตัวอักษร', 'error'); return; }
  if (/[@\s]/.test(username)) { toast('ชื่อผู้ใช้ห้ามมีช่องว่างหรือ @', 'error'); return; }
  if (p1.length < 6) { toast('รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร', 'error'); return; }
  if (p1 !== p2) { toast('รหัสผ่านทั้งสองช่องไม่ตรงกัน', 'error'); return; }
  if (!$('accept-terms').checked) { toast('กรุณายอมรับเงื่อนไขก่อนสมัคร', 'error'); return; }
  busy = true; const btn = $('btn-register-submit'); btn.disabled = true; btn.textContent = 'กำลังสร้างบัญชี…';
  try {
    const cred = await createUserWithEmailAndPassword(auth, usernameToEmail(username), p1);
    await updateProfile(cred.user, { displayName: username });
    await ensureProfile(cred.user, facebook ? { facebook } : {});
    toast('สร้างบัญชีสำเร็จ', 'success');
    setTimeout(() => { location.href = next(); }, 700);
  } catch (err) {
    const c = err.code || '';
    toast(c === 'auth/email-already-in-use' ? 'ชื่อผู้ใช้นี้มีคนใช้แล้ว' : c === 'auth/weak-password' ? 'รหัสผ่านง่ายเกินไป' : c === 'auth/network-request-failed' ? 'เชื่อมต่ออินเทอร์เน็ตไม่ได้' : 'สร้างบัญชีไม่สำเร็จ กรุณาลองใหม่', 'error');
    busy = false; btn.disabled = false; btn.textContent = 'สร้างบัญชี';
  }
}

function forgotPassword() {
  const c = contactsOf();
  toast(c.length ? `ลืมรหัสผ่าน ติดต่อแอดมินทาง ${c.map(x => x.label).join(' / ')} (เมนูเพิ่มเติม)` : 'ลืมรหัสผ่าน กรุณาติดต่อแอดมิน');
}

$('form-login').addEventListener('submit', handleLogin);
$('form-register').addEventListener('submit', handleRegister);
Object.assign(window, { switchAuthMode, togglePasswordInput, forgotPassword });
switchAuthMode(new URLSearchParams(location.search).get('mode') === 'register' ? 'register' : 'login');
