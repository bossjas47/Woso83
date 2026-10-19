import { db, auth } from "../firebase-config.js";
import {
  collection,
  getDocs,
  query,
  where
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import {
  onAuthStateChanged,
  signOut,
  updatePassword,
  updateProfile,
  EmailAuthProvider,
  reauthenticateWithCredential
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

/**
 * TACTICAL STORE — Account Controller (js/account.js)
 * Apple-Style UI, Firestore + Local Order Sync, XSS-Safe Credential Delivery & Re-Authenticated Security
 */

const ADMIN_EMAILS = new Set(["atest@tactical.store"]);

let currentUser = null;
let currentUsername = "Agent";
let currentIdentifier = "-";
let isAdmin = false;
let toastTimeout = null;
let allOrders = [];
let filteredOrders = [];
let currentSearchQuery = "";

// ==========================================
// 1. UTILITIES (ESCAPING & TOAST)
// ==========================================
function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function triggerToast(message, isWarning = false) {
  const box = document.getElementById("toast-box");
  const text = document.getElementById("toast-text");
  const dot = document.getElementById("toast-dot");
  if (!box || !text) {
    alert(message);
    return;
  }

  text.innerText = message;
  if (dot) {
    dot.className = isWarning
      ? "w-2 h-2 rounded-full bg-launchOrange shrink-0"
      : "w-2 h-2 rounded-full bg-appleBlue shrink-0";
  }

  box.classList.remove("opacity-0", "-translate-y-4", "scale-95");
  box.classList.add("opacity-100", "translate-y-0", "scale-100");

  if (toastTimeout) clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    box.classList.add("opacity-0", "-translate-y-4", "scale-95");
    box.classList.remove("opacity-100", "translate-y-0", "scale-100");
  }, 3200);
}

// ==========================================
// 2. STRICT ADMIN ROLE CHECK
// ==========================================
// shortcut: checks verified Firebase Auth email only (never localStorage or mutable displayName), upgrade to Firebase Custom Claims when backend Admin SDK is deployed
export function isUserAdmin(user) {
  if (!user || !user.email) return false;
  return ADMIN_EMAILS.has(user.email.trim().toLowerCase());
}

// ==========================================
// 3. AUTHENTICATION STATE & UI RENDERER
// ==========================================
function initAccountAuth() {
  const loadingView = document.getElementById("account-loading-view");
  const guestView = document.getElementById("account-guest-view");
  const dashView = document.getElementById("account-dashboard-view");

  onAuthStateChanged(auth, async (user) => {
    currentUser = user;

    if (loadingView) loadingView.classList.add("hidden");

    if (user) {
      if (guestView) guestView.classList.add("hidden");
      if (dashView) dashView.classList.remove("hidden");

      const displayName = user.displayName || (user.email ? user.email.split("@")[0] : "Agent");
      currentUsername = displayName || "Agent";
      currentIdentifier = user.email || user.uid;
      isAdmin = isUserAdmin(user);

      // Render Display Name, Initial & Identifier
      const nameEl = document.getElementById("account-display-name");
      const avatarEl = document.getElementById("account-avatar-initial");
      const idEl = document.getElementById("account-user-id");
      const statusEl = document.getElementById("account-auth-status");
      const profileInput = document.getElementById("profile-display-name-input");

      if (nameEl) nameEl.innerText = currentUsername;
      if (avatarEl) avatarEl.innerText = currentUsername.charAt(0).toUpperCase();
      if (idEl) idEl.innerText = `IDENTIFIER: ${currentIdentifier}`;
      if (profileInput) profileInput.value = currentUsername;
      if (statusEl) {
        statusEl.innerText = "สถานะ: ยืนยันตัวตนผ่าน Firebase Auth";
      }

      // Render Role Badge & Backoffice Tab Visibility (Apple Style Tokens)
      const roleBadge = document.getElementById("account-role-badge");
      const adminTabBtn = document.getElementById("tab-btn-admin");
      const adminSec = document.getElementById("account-sec-admin");

      if (isAdmin) {
        if (roleBadge) {
          roleBadge.className = "px-3 py-0.5 rounded-full text-xs font-mono font-semibold bg-mist text-launchOrange border border-hairline flex items-center gap-1.5";
          roleBadge.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-launchOrange"></span> ผู้ดูแลระบบ (ADMIN)';
        }
        if (adminTabBtn) adminTabBtn.classList.remove("hidden");
      } else {
        if (roleBadge) {
          roleBadge.className = "px-3 py-0.5 rounded-full text-xs font-mono font-medium bg-mist text-slate border border-hairline flex items-center gap-1.5";
          roleBadge.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-steel"></span> สมาชิกทั่วไป (USER)';
        }
        if (adminTabBtn) adminTabBtn.classList.add("hidden");
        if (adminSec) adminSec.classList.add("hidden");
      }

      await refreshAccountOrders();
    } else {
      if (guestView) guestView.classList.remove("hidden");
      if (dashView) dashView.classList.add("hidden");
    }
  });
}

async function handleAccountSignOut() {
  if (!window.confirm("คุณต้องการออกจากระบบใช่หรือไม่?")) return;

  try {
    await signOut(auth);
    triggerToast("ออกจากระบบเรียบร้อยแล้ว");
    setTimeout(() => {
      window.location.href = "../index.html";
    }, 800);
  } catch (err) {
    console.warn("Sign out error:", err);
    window.location.href = "../index.html";
  }
}

function copyUserIdentifier() {
  if (!currentIdentifier || currentIdentifier === "-") return;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(currentIdentifier);
  }
  triggerToast("คัดลอกข้อมูลระบุตัวตนเรียบร้อยแล้ว");
}

// ==========================================
// 4. TAB CONTROLLER (APPLE SEGMENTED PILLS)
// ==========================================
function switchAccountTab(tabName) {
  if (tabName === "admin" && !isAdmin) {
    triggerToast("สิทธิ์ไม่เพียงพอ: เฉพาะผู้ดูแลระบบที่ยืนยันตัวตนแล้วเท่านั้น", true);
    return;
  }

  const tabs = ["orders", "security", "admin"];
  tabs.forEach((t) => {
    const sec = document.getElementById(`account-sec-${t}`);
    const btn = document.getElementById(`tab-btn-${t}`);
    const isActive = t === tabName;

    if (sec) {
      sec.classList.toggle("hidden", !isActive);
      sec.classList.toggle("block", isActive);
    }

    if (btn) {
      btn.setAttribute("aria-selected", String(isActive));
      if (isActive) {
        btn.className = "px-5 py-2 rounded-button text-xs font-medium transition-all bg-ink text-gallery flex items-center gap-2 shrink-0";
      } else if (t === "admin") {
        btn.className = "px-5 py-2 rounded-button text-xs font-medium transition-all text-launchOrange hover:bg-gallery flex items-center gap-2 shrink-0";
      } else {
        btn.className = "px-5 py-2 rounded-button text-xs font-medium transition-all text-slate hover:text-ink flex items-center gap-2 shrink-0";
      }
    }
  });
}

// ==========================================
// 5. CUSTOMER ORDER RETRIEVAL (FIRESTORE + LOCAL FALLBACK)
// ==========================================
function getLocalOrders() {
  try {
    const raw = localStorage.getItem("tactical_my_orders");
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function fetchFirestoreOrders(user) {
  if (!user || !db) return [];
  const results = [];
  const seenDocIds = new Set();

  try {
    const queries = [];
    if (user.uid) {
      queries.push(query(collection(db, "orders"), where("userId", "==", user.uid)));
    }
    if (user.email) {
      queries.push(query(collection(db, "orders"), where("userEmail", "==", user.email)));
    }

    const snapshots = await Promise.allSettled(queries.map((q) => getDocs(q)));
    snapshots.forEach((res) => {
      if (res.status === "fulfilled" && res.value) {
        res.value.forEach((docSnap) => {
          if (!seenDocIds.has(docSnap.id)) {
            seenDocIds.add(docSnap.id);
            results.push({ id: docSnap.id, ...docSnap.data() });
          }
        });
      }
    });
  } catch (err) {
    console.warn("Firestore order sync fallback to localStorage:", err);
  }

  return results;
}

function normalizeTimestamp(val) {
  if (!val) return 0;
  if (typeof val === "number") return val;
  if (typeof val?.toMillis === "function") return val.toMillis();
  if (typeof val?.seconds === "number") return val.seconds * 1000;
  const parsed = Date.parse(val);
  return Number.isNaN(parsed) ? 0 : parsed;
}

async function refreshAccountOrders() {
  const remoteOrders = await fetchFirestoreOrders(currentUser);
  const localOrders = getLocalOrders();

  const mergedMap = new Map();
  [...remoteOrders, ...localOrders].forEach((order, index) => {
    const key = String(order.orderNumber || order.id || `local-${index}`);
    if (!mergedMap.has(key)) {
      mergedMap.set(key, order);
    }
  });

  allOrders = Array.from(mergedMap.values()).sort(
    (a, b) => normalizeTimestamp(b.createdAt) - normalizeTimestamp(a.createdAt)
  );

  handleOrderSearch(currentSearchQuery);
}

function handleOrderSearch(queryText) {
  currentSearchQuery = (queryText || "").trim().toLowerCase();

  if (!currentSearchQuery) {
    filteredOrders = [...allOrders];
  } else {
    filteredOrders = allOrders.filter((o) => {
      const orderNum = String(o.orderNumber || "").toLowerCase();
      const prodName = String(o.productName || "").toLowerCase();
      const username = String(o.accountDelivered?.username || "").toLowerCase();
      return (
        orderNum.includes(currentSearchQuery) ||
        prodName.includes(currentSearchQuery) ||
        username.includes(currentSearchQuery)
      );
    });
  }

  renderAccountOrders();
}

function renderAccountOrders() {
  const container = document.getElementById("account-orders-list");
  const empty = document.getElementById("account-orders-empty");
  const emptyTitle = document.getElementById("account-orders-empty-title");
  const emptyDesc = document.getElementById("account-orders-empty-desc");
  const countBadge = document.getElementById("account-orders-count-badge");
  if (!container) return;

  if (countBadge) countBadge.innerText = String(allOrders.length);

  if (filteredOrders.length === 0) {
    container.innerHTML = "";
    if (empty) {
      empty.classList.remove("hidden");
      empty.classList.add("flex");
    }
    if (currentSearchQuery && allOrders.length > 0) {
      if (emptyTitle) emptyTitle.innerText = "ไม่พบคำสั่งซื้อที่ตรงกับการค้นหา";
      if (emptyDesc) emptyDesc.innerText = `ไม่พบรายการที่ตรงกับ "${currentSearchQuery}" ลองค้นหาด้วยคำอื่น`;
    } else {
      if (emptyTitle) emptyTitle.innerText = "ยังไม่มีประวัติคำสั่งซื้อ";
      if (emptyDesc) emptyDesc.innerText = "เมื่อคุณเลือกซื้อไอดีเกม รหัสบัญชีจะปรากฏในหน้านี้โดยอัตโนมัติ";
    }
    return;
  }

  if (empty) {
    empty.classList.add("hidden");
    empty.classList.remove("flex");
  }

  container.innerHTML = filteredOrders
    .map((o, idx) => {
      const acc = o.accountDelivered || {};
      const hasUsername = Boolean(acc.username && String(acc.username).trim());
      const hasPassword = Boolean(acc.password && String(acc.password).trim());
      const ts = normalizeTimestamp(o.createdAt);
      const timeStr = ts ? new Date(ts).toLocaleString("th-TH") : "ไม่ระบุเวลา";
      const orderNum = escapeHtml(o.orderNumber || `ORD-${idx + 1}`);
      const productName = escapeHtml(o.productName || "ไอดีเกม Arena Breakout");
      const paymentMethod = escapeHtml(o.paymentMethod || "PromptPay / ระบบอัตโนมัติ");
      const amountStr = Number(o.amount || 0).toLocaleString("th-TH", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      });
      const safeUsername = hasUsername ? escapeHtml(acc.username) : "รอการจัดส่งจากระบบ";

      return `
      <div class="apple-card p-6 sm:p-7 space-y-5 transition-all hover:border-steel">
        <div class="flex flex-col sm:flex-row justify-between sm:items-center gap-3 border-b border-hairline pb-4">
          <div>
            <div class="flex items-center gap-2 flex-wrap mb-1.5">
              <span class="text-ink font-mono text-xs font-semibold">#${orderNum}</span>
              <span class="bg-mist text-ink border border-hairline px-2.5 py-0.5 rounded-full text-[11px] font-medium">
                ${hasPassword ? "✓ ชำระและจัดส่งไอดีแล้ว" : "• รอตรวจสอบ / จัดส่ง"}
              </span>
              <span class="text-[11px] text-steel font-mono">
                ช่องทาง: ${paymentMethod}
              </span>
            </div>
            <h3 class="text-base font-heading font-semibold text-ink">${productName}</h3>
            <span class="text-[11px] text-slate font-mono">${escapeHtml(timeStr)}</span>
          </div>

          <div class="text-left sm:text-right">
            <span class="text-[11px] text-slate block">ยอดสุทธิ</span>
            <span class="text-xl font-heading font-semibold text-ink">฿${amountStr}</span>
          </div>
        </div>

        <!-- Credentials Delivery Display (Apple Studio Mist Box) -->
        <div class="bg-mist p-4 rounded-2xl border border-hairline font-mono text-xs space-y-2.5">
          <div class="flex items-center justify-between gap-2">
            <span class="text-slate text-[11px] uppercase tracking-wider">USERNAME:</span>
            <div class="flex items-center gap-2">
              <span class="text-ink font-semibold select-all text-sm">${safeUsername}</span>
              ${
                hasUsername
                  ? `<button type="button" onclick="copyOrderField(${idx}, 'username')" class="text-[11px] font-sans font-medium text-appleBlue hover:underline">คัดลอก</button>`
                  : ""
              }
            </div>
          </div>
          <div class="flex items-center justify-between gap-2">
            <span class="text-slate text-[11px] uppercase tracking-wider">PASSWORD:</span>
            <div class="flex items-center gap-2">
              <span id="acc-order-pw-${idx}" class="text-ink font-semibold select-all text-sm">${
                hasPassword ? "••••••••••••" : "ติดต่อแอดมินเพื่อรับรหัส"
              }</span>
              ${
                hasPassword
                  ? `<button type="button" onclick="copyOrderField(${idx}, 'password')" class="text-[11px] font-sans font-medium text-appleBlue hover:underline">คัดลอก</button>`
                  : ""
              }
            </div>
          </div>
        </div>

        <div class="flex flex-wrap items-center justify-between gap-2.5 pt-1">
          <button type="button" onclick="reportOrderIssue(${idx})" class="text-xs text-slate hover:text-ink underline-offset-2 hover:underline">
            แจ้งปัญหาคำสั่งซื้อ #${orderNum}
          </button>

          <div class="flex items-center gap-2 ml-auto">
            <button
              type="button"
              onclick="toggleOrderPassword(${idx})"
              ${hasPassword ? "" : "disabled"}
              class="apple-explore-pill px-4 py-2 text-xs disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <span id="acc-order-lbl-${idx}">แสดงรหัส</span>
            </button>
            <button
              type="button"
              onclick="copyOrderField(${idx}, 'all')"
              ${hasUsername && hasPassword ? "" : "disabled"}
              class="apple-pricing-pill px-5 py-2 text-xs"
            >
              คัดลอกไอดีและรหัส
            </button>
          </div>
        </div>
      </div>
    `;
    })
    .join("");
}

function toggleOrderPassword(idx) {
  const order = filteredOrders[idx];
  const realPw = order?.accountDelivered?.password;
  const el = document.getElementById(`acc-order-pw-${idx}`);
  const lbl = document.getElementById(`acc-order-lbl-${idx}`);
  if (!el || !lbl) return;

  if (!realPw) {
    triggerToast("ยังไม่มีรหัสผ่านในรายการนี้ กรุณาติดต่อแอดมิน", true);
    return;
  }

  if (el.dataset.revealed === "true") {
    el.innerText = "••••••••••••";
    el.dataset.revealed = "false";
    lbl.innerText = "แสดงรหัส";
  } else {
    el.innerText = String(realPw);
    el.dataset.revealed = "true";
    lbl.innerText = "ซ่อนรหัส";
  }
}

function copyOrderField(idx, field) {
  const order = filteredOrders[idx];
  const acc = order?.accountDelivered || {};
  if (!acc.username && !acc.password) {
    triggerToast("ไม่พบข้อมูลไอดีสำหรับคัดลอก", true);
    return;
  }

  let textToCopy = "";
  let message = "";

  if (field === "username") {
    textToCopy = String(acc.username || "");
    message = "คัดลอก Username เรียบร้อยแล้ว";
  } else if (field === "password") {
    textToCopy = String(acc.password || "");
    message = "คัดลอก Password เรียบร้อยแล้ว";
  } else {
    textToCopy = `User: ${acc.username || "-"}\nPass: ${acc.password || "-"}`;
    message = "คัดลอกไอดีและรหัสผ่านเรียบร้อยแล้ว";
  }

  if (navigator.clipboard && textToCopy) {
    navigator.clipboard.writeText(textToCopy);
    triggerToast(message);
  }
}

function reportOrderIssue(idx) {
  const order = filteredOrders[idx];
  if (!order) return;
  const ref = `#${order.orderNumber || idx + 1} (${order.productName || "Tactical Store"})`;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(`แจ้งปัญหาคำสั่งซื้อ ${ref} | บัญชี: ${currentIdentifier}`);
  }
  triggerToast(`คัดลอกเลขอ้างอิง ${ref} แล้ว สามารถส่งให้แอดมินทางแชทได้ทันที`);
}

// ==========================================
// 6. PROFILE & RE-AUTHENTICATED PASSWORD UPDATE
// ==========================================
async function handleDisplayNameUpdate(e) {
  e.preventDefault();
  const input = document.getElementById("profile-display-name-input");
  const newName = (input?.value || "").trim();

  if (newName.length < 2) {
    triggerToast("ชื่อที่แสดงต้องมีความยาวอย่างน้อย 2 ตัวอักษร", true);
    return;
  }

  try {
    if (currentUser) {
      await updateProfile(currentUser, { displayName: newName });
    }

    currentUsername = newName;
    const nameEl = document.getElementById("account-display-name");
    const avatarEl = document.getElementById("account-avatar-initial");
    if (nameEl) nameEl.innerText = newName;
    if (avatarEl) avatarEl.innerText = newName.charAt(0).toUpperCase();

    triggerToast("บันทึกชื่อที่แสดงเรียบร้อยแล้ว");
  } catch (err) {
    console.error("Update profile error:", err);
    triggerToast("ไม่สามารถอัปเดตชื่อโปรไฟล์ได้ในขณะนี้ กรุณาลองใหม่อีกครั้ง", true);
  }
}

async function handlePasswordChange(e) {
  e.preventDefault();
  const currentPw = document.getElementById("change-pw-current")?.value || "";
  const p1 = document.getElementById("change-pw-new")?.value || "";
  const p2 = document.getElementById("change-pw-confirm")?.value || "";
  const submitBtn = document.getElementById("change-pw-submit-btn");

  if (!currentUser || !currentUser.email) {
    triggerToast("ต้องเข้าสู่ระบบด้วยบัญชีอีเมลจริงผ่าน Firebase จึงจะเปลี่ยนรหัสผ่านได้", true);
    return;
  }

  if (p1.length < 6) {
    triggerToast("รหัสผ่านใหม่ต้องมีความยาวอย่างน้อย 6 ตัวอักษร", true);
    return;
  }
  if (p1 !== p2) {
    triggerToast("รหัสผ่านใหม่และการยืนยันรหัสผ่านไม่ตรงกัน", true);
    return;
  }
  if (currentPw === p1) {
    triggerToast("รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสผ่านปัจจุบัน", true);
    return;
  }

  try {
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerText = "กำลังตรวจสอบและอัปเดต...";
    }

    const credential = EmailAuthProvider.credential(currentUser.email, currentPw);
    await reauthenticateWithCredential(currentUser, credential);
    await updatePassword(currentUser, p1);

    triggerToast("อัปเดตรหัสผ่านสำเร็จแล้ว");
    e.target.reset();
  } catch (err) {
    console.error("Update password error:", err);
    const code = err?.code || "";
    if (code === "auth/wrong-password" || code === "auth/invalid-credential") {
      triggerToast("รหัสผ่านปัจจุบันไม่ถูกต้อง กรุณาตรวจสอบอีกครั้ง", true);
    } else if (code === "auth/weak-password") {
      triggerToast("รหัสผ่านใหม่คาดเดาง่ายเกินไป กรุณาตั้งให้ซับซ้อนขึ้น", true);
    } else if (code === "auth/too-many-requests") {
      triggerToast("คุณทำรายการผิดพลาดหลายครั้ง กรุณารอสักครู่แล้วลองใหม่", true);
    } else if (code === "auth/requires-recent-login") {
      triggerToast("เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่อีกครั้งก่อนเปลี่ยนรหัสผ่าน", true);
    } else {
      triggerToast("เปลี่ยนรหัสผ่านไม่สำเร็จ กรุณาตรวจสอบการเชื่อมต่อแล้วลองใหม่", true);
    }
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerText = "อัปเดตรหัสผ่าน";
    }
  }
}

// Attach functions to window for inline HTML handlers
window.switchAccountTab = switchAccountTab;
window.handleAccountSignOut = handleAccountSignOut;
window.handlePasswordChange = handlePasswordChange;
window.handleDisplayNameUpdate = handleDisplayNameUpdate;
window.toggleOrderPassword = toggleOrderPassword;
window.copyOrderField = copyOrderField;
window.reportOrderIssue = reportOrderIssue;
window.handleOrderSearch = handleOrderSearch;
window.refreshAccountOrders = refreshAccountOrders;
window.copyUserIdentifier = copyUserIdentifier;
window.triggerToast = triggerToast;

window.addEventListener("DOMContentLoaded", () => {
  initAccountAuth();
});
