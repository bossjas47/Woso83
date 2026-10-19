import { auth } from "../firebase-config.js";
import { 
  signInWithEmailAndPassword, 
  createUserWithEmailAndPassword, 
  updateProfile,
  onAuthStateChanged 
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

/**
 * TACTICAL STORE — Auth Logic (username + password via Firebase Auth only)
 */

let toastTimeout = null;

export function triggerToast(message) {
  const box = document.getElementById('toast-box');
  const text = document.getElementById('toast-text');
  if (!box || !text) {
    alert(message);
    return;
  }

  text.innerText = message;
  box.style.display = 'flex';
  box.classList.remove('hidden', 'opacity-0', '-translate-y-4', 'scale-95');
  box.classList.add('opacity-100', 'translate-y-0', 'scale-100');

  if (toastTimeout) clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    box.classList.add('opacity-0', '-translate-y-4', 'scale-95');
    box.classList.remove('opacity-100', 'translate-y-0', 'scale-100');
    setTimeout(() => {
      box.style.display = 'none';
      box.classList.add('hidden');
    }, 300);
  }, 3500);
}

export function switchAuthMode(mode) {
  const formLogin = document.getElementById('form-login');
  const formRegister = document.getElementById('form-register');
  const tabBtnLogin = document.getElementById('tab-btn-login');
  const tabBtnRegister = document.getElementById('tab-btn-register');

  if (mode === 'register') {
    formLogin.classList.add('hidden');
    formRegister.classList.remove('hidden');

    tabBtnRegister.className = 'py-2.5 rounded-xl font-bold text-xs transition-all duration-300 flex items-center justify-center gap-2 bg-amber-500 text-black shadow-lg';
    tabBtnLogin.className = 'py-2.5 rounded-xl font-bold text-xs transition-all duration-300 flex items-center justify-center gap-2 text-zinc-400 hover:text-white';
  } else {
    formRegister.classList.add('hidden');
    formLogin.classList.remove('hidden');

    tabBtnLogin.className = 'py-2.5 rounded-xl font-bold text-xs transition-all duration-300 flex items-center justify-center gap-2 bg-amber-500 text-black shadow-lg';
    tabBtnRegister.className = 'py-2.5 rounded-xl font-bold text-xs transition-all duration-300 flex items-center justify-center gap-2 text-zinc-400 hover:text-white';
  }
}

export function togglePasswordInput(inputId, btn) {
  const input = document.getElementById(inputId);
  if (!input) return;

  if (input.type === 'password') {
    input.type = 'text';
    btn.innerHTML = `<svg width="16" height="16" class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l18 18"/></svg>`;
  } else {
    input.type = 'password';
    btn.innerHTML = `<svg width="16" height="16" class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>`;
  }
}

// แปลง Username เป็น ASCII-safe Email ภายในสำหรับ Firebase Auth (รองรับทั้งภาษาไทยและอังกฤษ)
function usernameToEmail(username) {
  const clean = username.trim().toLowerCase();
  if (clean.includes('@')) return clean;

  const asciiSafe = Array.from(clean).map(c => {
    const code = c.charCodeAt(0);
    return (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 95 
      ? c 
      : `u${code.toString(16)}`;
  }).join('');
  return `${asciiSafe || 'agent'}@tactical.store`;
}

// Old versions kept plaintext passwords here; wipe them from the browser.
try { localStorage.removeItem('tactical_accounts'); localStorage.removeItem('tactical_current_user'); } catch (_) {}

export async function handleLoginSubmit(e) {
  if (e && e.preventDefault) e.preventDefault();
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  const submitBtn = document.getElementById('btn-login-submit');

  if (!username) {
    triggerToast("กรุณากรอกชื่อผู้ใช้งาน");
    return;
  }
  if (!password) {
    triggerToast("กรุณากรอกรหัสผ่าน");
    return;
  }

  submitBtn.disabled = true;
  submitBtn.innerHTML = `กำลังตรวจสอบข้อมูล...`;

  const email = usernameToEmail(username);

  try {
    const userCredential = await signInWithEmailAndPassword(auth, email, password);
    const displayName = userCredential.user.displayName || username;
    triggerToast(`ยินดีต้อนรับกลับ คุณ ${displayName}`);
    setTimeout(() => {
      window.location.href = 'account.html';
    }, 1200);
  } catch (error) {
    console.warn("Login with Firebase Auth:", error.code, error.message);
    
    let errMsg = "เข้าสู่ระบบไม่สำเร็จ กรุณาตรวจสอบชื่อผู้ใช้งานหรือรหัสผ่าน";
    if (error.code === 'auth/user-not-found' || error.code === 'auth/invalid-credential') {
      errMsg = "ไม่พบบัญชีผู้ใช้งานนี้ หรือรหัสผ่านไม่ถูกต้อง";
    } else if (error.code === 'auth/wrong-password') {
      errMsg = "รหัสผ่านไม่ถูกต้อง";
    } else if (error.code === 'auth/too-many-requests') {
      errMsg = "พยายามเข้าสู่ระบบถี่เกินไป โปรดลองใหม่อีกครั้งภายหลัง";
    }
    
    triggerToast(errMsg);
    submitBtn.disabled = false;
    submitBtn.innerHTML = `<span>ยืนยันเข้าสู่ระบบ (ACCESS PORTAL)</span><svg width="16" height="16" class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14 5l7 7m0 0l-7 7m7-7H3"/></svg>`;
  }
}

export async function handleRegisterSubmit(e) {
  if (e && e.preventDefault) e.preventDefault();
  const username = document.getElementById('register-username').value.trim();
  const password = document.getElementById('register-password').value;
  const confirmPassword = document.getElementById('register-confirm-password').value;
  const submitBtn = document.getElementById('btn-register-submit');

  if (!username) {
    triggerToast("กรุณากรอกชื่อผู้ใช้งาน");
    return;
  }

  if (username.length < 3 || username.length > 24) {
    triggerToast("ชื่อผู้ใช้งานต้องมีความยาว 3 ถึง 24 ตัวอักษร");
    return;
  }

  if (password.length < 6) {
    triggerToast("รหัสผ่านต้องมีความยาวอย่างน้อย 6 ตัวอักษร");
    return;
  }

  if (password !== confirmPassword) {
    triggerToast("รหัสผ่านทั้งสองช่องไม่ตรงกัน กรุณาตรวจสอบอีกครั้ง");
    return;
  }

  submitBtn.disabled = true;
  submitBtn.innerHTML = `กำลังสร้างบัญชีของคุณ...`;

  const email = usernameToEmail(username);

  try {
    const userCredential = await createUserWithEmailAndPassword(auth, email, password);
    await updateProfile(userCredential.user, {
      displayName: username
    });
    triggerToast("สร้างบัญชีสำเร็จ! กำลังพาท่านเข้าสู่ระบบ...");
    setTimeout(() => {
      window.location.href = 'account.html';
    }, 1200);
  } catch (error) {
    console.warn("Register error with Firebase Auth:", error.code, error.message);
    
    let errMsg = "สร้างบัญชีไม่สำเร็จ กรุณาลองใหม่อีกครั้ง";
    if (error.code === 'auth/email-already-in-use') {
      errMsg = "ชื่อผู้ใช้งานนี้มีผู้ใช้แล้ว โปรดตั้งชื่ออื่น";
    } else if (error.code === 'auth/weak-password') {
      errMsg = "รหัสผ่านง่ายเกินไป โปรดตั้งอย่างน้อย 6 ตัวอักษร";
    } else if (error.code === 'auth/network-request-failed') {
      errMsg = "เชื่อมต่อเครือข่ายไม่ได้ กรุณาลองใหม่อีกครั้ง";
    }
    
    triggerToast(errMsg);
    submitBtn.disabled = false;
    submitBtn.innerHTML = `<span>สร้างบัญชีผู้ใช้งาน (CREATE ACCOUNT)</span><svg width="16" height="16" class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>`;
  }
}

window.switchAuthMode = switchAuthMode;
window.togglePasswordInput = togglePasswordInput;
window.handleLoginSubmit = handleLoginSubmit;
window.handleRegisterSubmit = handleRegisterSubmit;
window.triggerToast = triggerToast;

window.addEventListener('DOMContentLoaded', () => {
  const urlParams = new URLSearchParams(window.location.search);
  const mode = urlParams.get('mode');
  if (mode === 'register') {
    switchAuthMode('register');
  }

  const formLogin = document.getElementById('form-login');
  if (formLogin) formLogin.addEventListener('submit', handleLoginSubmit);

  const formReg = document.getElementById('form-register');
  if (formReg) formReg.addEventListener('submit', handleRegisterSubmit);

  onAuthStateChanged(auth, (user) => {
    if (user) {
      console.log("[Auth] ตรวจพบผู้ใช้เข้าสู่ระบบ:", user.displayName || user.email);
    }
  });
});
