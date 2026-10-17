import { db, auth } from "../firebase-config.js";
import { 
  collection, 
  doc, 
  addDoc, 
  getDoc,
  getDocs,
  setDoc, 
  updateDoc,
  deleteDoc,
  writeBatch,
  onSnapshot, 
  query,
  where,
  limit,
  runTransaction,
  serverTimestamp,
  increment,
  deleteField
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { 
  onAuthStateChanged, 
  signOut 
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { watchCategories, DEFAULT_CATEGORIES, KIND_LABEL, categoryOf, isServiceProduct, minQtyOf, unitOf } from "./categories.js";

/**
 * TACTICAL STORE — Master Controller (js/index.js)
 * รวมระบบทั้งหน้าร้านค้า (Storefront) และระบบจัดการหลังบ้าน (Admin Dashboard + Stock Vault)
 */

// ==========================================
// 1. DEFAULT DATA & REPOSITORY
// ==========================================
const DEFAULT_PRODUCTS = [];

const PRESET_IMAGES = {
  m4a1: 'https://images.unsplash.com/photo-1595590424283-b8f1784cb2c8?auto=format&fit=crop&q=80&w=800',
  koen: 'https://images.unsplash.com/photo-1612287230202-1ff1d85d1bdf?auto=format&fit=crop&q=80&w=800',
  sniper: 'https://images.unsplash.com/photo-1585098906517-8e1008d58544?auto=format&fit=crop&q=80&w=800',
  fal: 'https://images.unsplash.com/photo-1550985542-f28329b3a364?auto=format&fit=crop&q=80&w=800',
  wealth: 'https://images.unsplash.com/photo-1633158829585-23ba8f7c8caf?auto=format&fit=crop&q=80&w=800',
  smg: 'https://images.unsplash.com/photo-1574226516831-e1dff420e5c7?auto=format&fit=crop&q=80&w=800'
};

// Global App State
let PRODUCTS = [...DEFAULT_PRODUCTS];
let CATS = DEFAULT_CATEGORIES;
let CATS_FROM_DB = false;
let toastTimeout = null;

// ==========================================
// 2. TOAST NOTIFICATION UTILITY
// ==========================================
function triggerToast(message) {
  const box = document.getElementById('toast-box');
  const text = document.getElementById('toast-text');
  if (!box || !text) return;

  text.innerText = message;
  box.classList.remove('opacity-0', '-translate-y-4', 'scale-95', 'pointer-events-none');
  box.classList.add('opacity-100', 'translate-y-0', 'scale-100');

  if (toastTimeout) clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    box.classList.add('opacity-0', '-translate-y-4', 'scale-95', 'pointer-events-none');
    box.classList.remove('opacity-100', 'translate-y-0', 'scale-100');
  }, 3000);
}
window.showAdminToast = triggerToast;
window.triggerToast = triggerToast;

// ==========================================
// 3. FIRESTORE SYNC & LISTENER
// ==========================================
function initFirebaseProductsListener() {
  const refresh = () => { renderAdminProducts(); updateAdminMetrics(); };
  onSnapshot(collection(db, "products"), (snapshot) => {
    PRODUCTS = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    refresh();
  }, (err) => {
    console.warn("Products listener:", err);
    triggerToast('โหลดสินค้าไม่สำเร็จ ตรวจสอบสิทธิ์แอดมิน');
    refresh();
  });
}

// ==========================================
// 4. ADMIN DASHBOARD: PIN VAULT & SECURITY
// ==========================================
let currentSecurityDoc = null;
let failedAttempts = 0;
let lockoutTimer = null;

async function hashPinWithSalt(pin, saltHex) {
  const encoder = new TextEncoder();
  const data = encoder.encode(pin + ":" + saltHex + ":TACTICAL_PIN_VAULT_2026");
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function generateRandomSalt() {
  const saltBytes = new Uint8Array(16);
  crypto.getRandomValues(saltBytes);
  return Array.from(saltBytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function checkSecurityPinState() {
  const gate = document.getElementById('admin-auth-gate');
  if (!gate) return; // ไม่ได้เปิดหน้า admin

  const loadingState = document.getElementById('pin-state-loading');
  const setupState = document.getElementById('pin-state-setup');
  const unlockState = document.getElementById('pin-state-unlock');

  if (sessionStorage.getItem('tactical_admin_pin_unlocked') === 'true') {
    unlockDashboardUI();
    return;
  }

  try {
    let storedData = null;
    const pinDoc = await getDoc(doc(db, 'system_settings', 'admin_pin'));
    if (pinDoc.exists()) {
      storedData = pinDoc.data();
    } else {
      const local = localStorage.getItem('tactical_admin_pin_vault');
      if (local) storedData = JSON.parse(local);
    }

    if (loadingState) loadingState.classList.add('hidden');

    if (!storedData || !storedData.pinHash || !storedData.salt) {
      if (setupState) setupState.classList.remove('hidden');
      if (unlockState) unlockState.classList.add('hidden');
    } else {
      currentSecurityDoc = storedData;
      if (setupState) setupState.classList.add('hidden');
      if (unlockState) unlockState.classList.remove('hidden');
      initPinDigitBoxes();
    }
  } catch (err) {
    console.warn('Security PIN check fallback:', err);
    if (loadingState) loadingState.classList.add('hidden');
    if (setupState) setupState.classList.remove('hidden');
  }
}

async function handlePinSetupSubmit(event) {
  event.preventDefault();
  const p1 = document.getElementById('setup-pin-val').value.trim();
  const p2 = document.getElementById('setup-pin-confirm').value.trim();

  if (!/^\d{6}$/.test(p1)) {
    triggerToast('รหัส PIN ต้องเป็นตัวเลข 6 หลักเท่านั้น');
    return;
  }
  if (p1 !== p2) {
    triggerToast('รหัส PIN ทั้ง 2 ช่องไม่ตรงกัน กรุณาตรวจสอบอีกครั้ง');
    return;
  }

  try {
    const salt = generateRandomSalt();
    const pinHash = await hashPinWithSalt(p1, salt);
    const payload = {
      pinHash,
      salt,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      setBy: 'atest'
    };

    try {
      await setDoc(doc(db, 'system_settings', 'admin_pin'), payload);
    } catch (e) {
      console.warn('Firestore set PIN error, saved locally:', e);
    }
    localStorage.setItem('tactical_admin_pin_vault', JSON.stringify(payload));
    
    currentSecurityDoc = payload;
    triggerToast('บันทึกรหัส PIN ลงฐานข้อมูลสำเร็จ');
    sessionStorage.setItem('tactical_admin_pin_unlocked', 'true');
    setTimeout(() => unlockDashboardUI(), 600);
  } catch (err) {
    triggerToast('เกิดข้อผิดพลาดในการบันทึก PIN: ' + err.message);
  }
}

async function handlePinUnlockSubmit(event) {
  if (event) event.preventDefault();
  if (failedAttempts >= 5) {
    triggerToast('ระบบถูกล็อกชั่วคราวเนื่องจากกรอกรหัสผิดเกินกำหนด');
    return;
  }

  const digits = Array.from(document.querySelectorAll('.pin-digit-input')).map(i => i.value).join('');
  if (digits.length !== 6) {
    triggerToast('กรุณากรอกรหัส PIN ให้ครบ 6 หลัก');
    return;
  }

  const inputHash = await hashPinWithSalt(digits, currentSecurityDoc.salt);
  if (inputHash === currentSecurityDoc.pinHash) {
    failedAttempts = 0;
    sessionStorage.setItem('tactical_admin_pin_unlocked', 'true');
    triggerToast('ปลดล็อกสิทธิ์ผู้ดูแลสำเร็จ');
    unlockDashboardUI();
  } else {
    failedAttempts++;
    document.getElementById('pin-error-msg')?.classList.remove('hidden');
    document.querySelectorAll('.pin-digit-input').forEach(i => i.value = '');
    document.querySelector('.pin-digit-input')?.focus();

    if (failedAttempts >= 5) {
      triggerPinLockout();
    } else {
      triggerToast(`รหัส PIN ไม่ถูกต้อง (เหลือโอกาส ${5 - failedAttempts} ครั้ง)`);
    }
  }
}

function triggerPinLockout() {
  const lockMsg = document.getElementById('pin-lockout-msg');
  const timerSpan = document.getElementById('pin-lockout-timer');
  const btn = document.getElementById('btn-pin-submit');
  if (lockMsg) lockMsg.classList.remove('hidden');
  if (btn) btn.disabled = true;

  let remaining = 60;
  if (lockoutTimer) clearInterval(lockoutTimer);
  lockoutTimer = setInterval(() => {
    remaining--;
    if (timerSpan) timerSpan.textContent = remaining;
    if (remaining <= 0) {
      clearInterval(lockoutTimer);
      failedAttempts = 0;
      if (lockMsg) lockMsg.classList.add('hidden');
      if (btn) btn.disabled = false;
    }
  }, 1000);
}

function unlockDashboardUI() {
  document.getElementById('admin-auth-gate')?.classList.add('hidden');
  document.getElementById('admin-main-content')?.classList.remove('hidden');
  renderAdminProducts();
  renderAdminOrders();
  renderAdminPromos();
  loadAdminSettings();
}

function initPinDigitBoxes() {
  const inputs = document.querySelectorAll('.pin-digit-input');
  inputs.forEach((input, index) => {
    input.addEventListener('input', (e) => {
      if (e.target.value.length === 1 && index < inputs.length - 1) {
        inputs[index + 1].focus();
      }
      if (Array.from(inputs).every(i => i.value.length === 1)) {
        handlePinUnlockSubmit(null);
      }
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !e.target.value && index > 0) {
        inputs[index - 1].focus();
      }
    });
  });
  inputs[0]?.focus();
}

function promptResetPin() {
  if (confirm('คุณต้องการรีเซ็ตรหัส PIN เพื่อตั้งใหม่ใช่หรือไม่?')) {
    sessionStorage.removeItem('tactical_admin_pin_unlocked');
    localStorage.removeItem('tactical_admin_pin_vault');
    location.reload();
  }
}

function lockAdminSession() {
  sessionStorage.removeItem('tactical_admin_pin_unlocked');
  location.reload();
}

// ==========================================
// 5. ADMIN: PRODUCT CRUD & TABLE (WITH STOCK BUTTON)
// ==========================================
function updateAdminMetrics() {
  const total = PRODUCTS.length;
  const inStock = PRODUCTS.filter(p => Number(p.stock) > 0).length;
  const outOfStock = PRODUCTS.filter(p => Number(p.stock) === 0).length;
  
  const elTotal = document.getElementById('metric-total-products');
  const elIn = document.getElementById('metric-instock-products');
  const elOut = document.getElementById('metric-outofstock-products');
  
  if (elTotal) elTotal.innerText = total;
  if (elIn) elIn.innerText = inStock;
  if (elOut) elOut.innerText = outOfStock;
}

function renderAdminProducts(customList = null) {
  const tbody = document.getElementById('admin-products-table-body');
  const empty = document.getElementById('admin-products-empty');
  if (!tbody) return;

  const list = customList || PRODUCTS;
  tbody.innerHTML = '';

  if (list.length === 0) {
    if (empty) empty.classList.remove('hidden');
    return;
  }
  if (empty) empty.classList.add('hidden');

  tbody.innerHTML = list.map(product => {
    const isOutOfStock = Number(product.stock) === 0;

    return `
      <tr class="hover:bg-mist/70 transition-colors border-b border-hairline">
        <td class="py-3 px-4">
          <div class="w-14 h-10 rounded-lg overflow-hidden bg-mist border border-hairline shrink-0">
            <img 
              src="${adminEsc(product.image)}" 
              alt="${adminEsc(product.name)}" 
              class="w-full h-full object-cover"
              onerror="this.onerror=null;this.src='https://placehold.co/100x70/f5f5f7/86868b?text=Tactical'"
            />
          </div>
        </td>
        <td class="py-3 px-4">
          <div class="font-medium text-ink text-xs line-clamp-1">${adminEsc(product.name)}</div>
          <div class="text-[11px] text-slate line-clamp-1">${product.desc || '-'}</div>
        </td>
        <td class="py-3 px-4">
          <span class="inline-block bg-mist border border-hairline px-2 py-0.5 rounded-full text-[10px] text-slate font-mono">
            ${adminEsc(categoryOf(CATS, product.category)?.name || product.category)}
          </span>
          ${isServiceProduct(product, CATS) ? `<div class="text-[10px] text-slate mt-0.5">ขั้นต่ำ ${minQtyOf(product, CATS)} ${adminEsc(unitOf(product, CATS))}</div>` : ''}
        </td>
        <td class="py-3 px-4 font-mono font-semibold text-ink">
          ฿${Number(product.price).toFixed(2)}
        </td>
        <td class="py-3 px-4 font-mono text-slate">
          ${adminEsc(product.koen)}
        </td>
        <td class="py-3 px-4">
          ${!isOutOfStock 
            ? `<span class="inline-flex items-center gap-1 text-emerald-600 font-semibold text-[11px] bg-emerald-50 px-2.5 py-0.5 rounded-full border border-emerald-200">
                 <span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
                 ${product.stock} ชิ้น
               </span>`
            : `<span class="inline-block text-launchOrange font-semibold text-[11px] bg-orange-50 px-2.5 py-0.5 rounded-full border border-orange-200">
                 หมด (0)
               </span>`
          }
        </td>
        <td class="py-3 px-4 text-right">
          <div class="inline-flex items-center gap-1.5 justify-end">
            <!-- ปุ่มสต็อก (Stock Replenishment Button) -->
            <button 
              onclick='openStockModal(${adminEsc(JSON.stringify(product.id))})' 
              title="เติมสต็อกไอดีชุดใหญ่" 
              class="apple-pricing-pill px-3 py-1 text-[11px] font-medium flex items-center gap-1.5 shadow-sm">
              <span><svg class="w-[1.1em] h-[1.1em] inline-block align-[-0.15em]" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 8l-9-5-9 5v8l9 5 9-5V8zM3 8l9 5 9-5M12 13v8"/></svg> สต็อก</span>
              <span class="bg-white/20 px-1.5 py-0.2 rounded-full text-[10px] font-mono">${product.stock}</span>
            </button>
            
            <!-- ปุ่มแก้ไข -->
            <button 
              onclick='openProductModal(${adminEsc(JSON.stringify(product.id))})' 
              title="แก้ไขรายละเอียด" 
              class="apple-explore-pill px-2.5 py-1 text-[11px] text-slate hover:text-ink">
              แก้ไข
            </button>
            
            <!-- ปุ่มลบ -->
            <button 
              onclick='deleteAdminProduct(${adminEsc(JSON.stringify(product.id))})' 
              title="ลบสินค้านี้" 
              class="apple-explore-pill px-2.5 py-1 text-[11px] text-red-500 border-red-200 hover:bg-red-50">
              ลบ
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function filterAdminProducts(queryText) {
  const q = (queryText || '').toLowerCase();
  const filtered = PRODUCTS.filter(p => 
    p.name.toLowerCase().includes(q) ||
    p.category.toLowerCase().includes(q) ||
    p.tags.some(t => t.toLowerCase().includes(q))
  );
  renderAdminProducts(filtered);
}

function openProductModal(productId = null) {
  const modal = document.getElementById('product-form-modal');
  const heading = document.getElementById('product-modal-heading');
  const idInput = document.getElementById('prod-edit-id');
  if (!modal) return;

  if (productId) {
    const p = PRODUCTS.find(it => it.id === productId);
    if (!p) return;
    if (heading) heading.innerText = 'แก้ไขสินค้า: ' + p.name;
    if (idInput) idInput.value = p.id;
    document.getElementById('prod-name').value = p.name;
    document.getElementById('prod-category').value = p.category;
    document.getElementById('prod-koen').value = p.koen;
    document.getElementById('prod-price').value = p.price;
    document.getElementById('prod-stock').value = p.stock;
    document.getElementById('prod-image').value = p.image;
    document.getElementById('prod-gallery').value = (p.gallery || []).join('\n');
    document.getElementById('prod-tags').value = (p.tags || []).join(', ');
    document.getElementById('prod-desc').value = p.desc || '';
    document.getElementById('prod-specs').value = (p.specs || []).join('\n');
    const fm = Object.fromEntries((p.farmModes || []).map(m => [m.key, m.price]));
    document.getElementById('prod-farm-id').value = fm.with_id || '';
    document.getElementById('prod-farm-self').value = fm.self || '';
    document.getElementById('prod-packages').value = (p.packages || []).map(k => `${k.qty} ${k.bonus || 0}`).join('\n');
    document.getElementById('prod-hours').value = p.serviceHours || '';
    document.getElementById('prod-hours-open').value = p.hoursOpen || '';
    document.getElementById('prod-hours-close').value = p.hoursClose || '';
    document.getElementById('prod-info').value = p.infoLines || '';
    document.getElementById('prod-howto').value = p.howTo || '';
    document.getElementById('prod-warranty').value = p.warrantyText || '';
    document.getElementById('prod-service-unit').value = p.serviceUnit || '';
    document.getElementById('prod-service-min').value = p.serviceMin || '';
    document.getElementById('prod-service-rate').value = p.price;
    updateImagePreview(p.image);
  } else {
    if (heading) heading.innerText = 'เพิ่มสินค้าใหม่';
    if (idInput) idInput.value = '';
    document.getElementById('product-crud-form').reset();
    document.getElementById('prod-service-min').value = '';
    updateImagePreview('');
  }
  fillProductCategorySelect();
  if (productId) document.getElementById('prod-category').value = PRODUCTS.find(it => it.id === productId).category;
  handleCategoryChange(document.getElementById('prod-category').value);

  modal.classList.remove('hidden');
  modal.classList.add('flex');
}

function closeProductModal() {
  const modal = document.getElementById('product-form-modal');
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }
}

async function handleProductFormSubmit(event) {
  event.preventDefault();
  const idInput = document.getElementById('prod-edit-id').value.trim();
  const name = document.getElementById('prod-name').value.trim();
  const category = document.getElementById('prod-category').value;
  const koen = document.getElementById('prod-koen').value.trim();
  const isSrv = categoryOf(CATS, category)?.kind === 'service';
  const price = parseFloat(document.getElementById(isSrv ? 'prod-service-rate' : 'prod-price').value) || parseFloat(document.getElementById('prod-price').value) || 0;
  const serviceUnit = document.getElementById('prod-service-unit').value.trim();
  const serviceMin = Math.floor(Number(document.getElementById('prod-service-min').value)) || 0;
  const stock = parseInt(document.getElementById('prod-stock').value, 10) || 0;
  const image = document.getElementById('prod-image').value.trim();
  const galleryText = document.getElementById('prod-gallery').value.trim();
  const gallery = galleryText ? galleryText.split('\n').map(s => s.trim()).filter(Boolean) : [image];
  const tagsText = document.getElementById('prod-tags').value.trim();
  const tags = tagsText ? tagsText.split(',').map(s => s.trim()).filter(Boolean) : [];
  const desc = document.getElementById('prod-desc').value.trim();
  const specsText = document.getElementById('prod-specs').value.trim();
  const specs = specsText ? specsText.split('\n').map(s => s.trim()).filter(Boolean) : [];

  const packages = document.getElementById('prod-packages').value.split('\n')
    .map(l => l.trim().split(/[\s,]+/).map(Number))
    .filter(r => r[0] >= 1).map(r => ({ qty: Math.floor(r[0]), bonus: Math.max(0, Math.floor(r[1]) || 0) }));
  const opt = id => document.getElementById(id).value.trim() || deleteField();

  const fId = Number(document.getElementById('prod-farm-id').value) || 0;
  const fSelf = Number(document.getElementById('prod-farm-self').value) || 0;
  const farmModes = isSrv && fId > 0 && fSelf > 0
    ? [{ key: 'with_id', label: 'ให้ไอดีไปยืน', price: fId }, { key: 'self', label: 'ไปยืนเอง', price: fSelf }] : null;
  const prodId = idInput || 'prod_' + Date.now();
  const payload = {
    id: prodId,
    name,
    category,
    koen,
    price: farmModes ? Math.min(fId, fSelf) : price, // card shows the cheaper mode
    stock,
    image,
    gallery,
    tags,
    desc,
    specs,
    productType: isSrv ? 'service' : 'account',
    // blank = inherit the category default; deleteField clears an old override
    serviceUnit: isSrv && serviceUnit ? serviceUnit : deleteField(),
    serviceMin: isSrv && serviceMin > 0 ? serviceMin : deleteField(),
    packages: packages.length ? packages : deleteField(),
    farmModes: farmModes || deleteField(),
    serviceHours: opt('prod-hours'),
    hoursOpen: opt('prod-hours-open'),
    hoursClose: opt('prod-hours-close'),
    infoLines: opt('prod-info'),
    howTo: opt('prod-howto'),
    warrantyText: opt('prod-warranty'),
    updatedAt: serverTimestamp()
  };

  try {
    await setDoc(doc(db, "products", prodId), payload, { merge: true });
    triggerToast('บันทึกข้อมูลสินค้าลง Firebase สำเร็จ!');
    closeProductModal();
  } catch (err) {
    console.warn('Save product error:', err);
    triggerToast('บันทึกสินค้าไม่สำเร็จ ตรวจสอบสิทธิ์แอดมิน');
  }
}

async function deleteAdminProduct(productId) {
  if (!confirm('คุณต้องการลบสินค้านี้ออกจากระบบใช่หรือไม่?')) return;
  try {
    await deleteDoc(doc(db, "products", productId));
    triggerToast('ลบสินค้าสำเร็จเรียบร้อย');
  } catch (err) {
    console.warn("Delete product error:", err);
    PRODUCTS = PRODUCTS.filter(p => p.id !== productId);
    renderAdminProducts();
    updateAdminMetrics();
    triggerToast('ลบสินค้าในระบบเรียบร้อย (Local)');
  }
}

function setImagePreset(presetKey) {
  const url = PRESET_IMAGES[presetKey];
  if (url) {
    const input = document.getElementById('prod-image');
    if (input) input.value = url;
    updateImagePreview(url);
  }
}

function updateImagePreview(url) {
  const el = document.getElementById('image-preview-element');
  if (el) el.src = url || 'https://placehold.co/800x500/f5f5f7/86868b?text=Image+Preview';
}

function openStockModalQuick() {
  if (PRODUCTS && PRODUCTS.length > 0) {
    openStockModal(PRODUCTS[0].id);
  } else {
    triggerToast('กรุณาเพิ่มสินค้าหรือคืนค่าเริ่มต้นก่อนจัดการสต็อก');
  }
}

// ==========================================
// 6. ADMIN: BULK STOCK REPLENISHMENT ENGINE
// ==========================================
let currentStockProductId = null;
let parsedStockItems = [];

function parseStockLines(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const items = [];
  const seen = new Set();
  let hasDuplicates = false;

  lines.forEach((line) => {
    let username = '';
    let password = '';

    const emailPassMatch = line.match(/^(?:email|user|username)\s+([^\s]+)\s+(?:password|pass|pwd)\s+(.+)$/i);
    const colonPipeMatch = line.match(/^([^:\s|]+)\s*[:|]\s*(.+)$/);
    const spaceMatch = line.match(/^([^\s]+)\s+([^\s]+)$/);

    if (emailPassMatch) {
      username = emailPassMatch[1].trim();
      password = emailPassMatch[2].trim();
    } else if (colonPipeMatch) {
      username = colonPipeMatch[1].trim();
      password = colonPipeMatch[2].trim();
    } else if (spaceMatch) {
      username = spaceMatch[1].trim();
      password = spaceMatch[2].trim();
    }

    if (username && password) {
      const key = username.toLowerCase();
      if (seen.has(key)) {
        hasDuplicates = true;
      } else {
        seen.add(key);
        items.push({ username, password, status: 'available' });
      }
    }
  });

  return { items, hasDuplicates };
}

function handleStockTextareaInput(val) {
  const { items, hasDuplicates } = parseStockLines(val);
  parsedStockItems = items;

  const counter = document.getElementById('stock-parsed-counter');
  const dupWarning = document.getElementById('stock-duplicate-warning');
  const btnLabel = document.getElementById('btn-add-stock-label');

  if (counter) counter.textContent = `ตรวจพบ: ${items.length} รายการพร้อมนำเข้า`;
  if (btnLabel) btnLabel.textContent = `บันทึกและนำเข้าสต็อก (${items.length} ชิ้น)`;
  if (dupWarning) {
    if (hasDuplicates) dupWarning.classList.remove('hidden');
    else dupWarning.classList.add('hidden');
  }
}

async function openStockModal(productId) {
  currentStockProductId = productId;
  parsedStockItems = [];

  const modal = document.getElementById('stock-management-modal');
  const textarea = document.getElementById('bulk-stock-textarea');
  if (textarea) textarea.value = '';
  handleStockTextareaInput('');

  const prod = PRODUCTS.find(p => p.id === productId);
  const prodTitle = prod ? prod.name : 'สินค้า #' + productId;
  const curStock = prod ? prod.stock : 0;

  document.getElementById('stock-modal-prod-title').textContent = prodTitle;
  document.getElementById('stock-modal-current-count').textContent = curStock;

  modal.classList.remove('hidden');
  modal.classList.add('flex');

  loadAvailableStockItems(productId);
}

function closeStockModal() {
  const modal = document.getElementById('stock-management-modal');
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }
  currentStockProductId = null;
}

async function submitBulkStockImport() {
  if (!currentStockProductId) {
    triggerToast('ไม่พบข้อมูลสินค้าระหว่างทำรายการ');
    return;
  }
  if (parsedStockItems.length === 0) {
    triggerToast('กรุณาวางรายการไอดีอย่างน้อย 1 บรรทัด (เช่น email ... password ...)');
    return;
  }

  const btn = document.getElementById('btn-confirm-add-stock');
  if (btn) btn.disabled = true;

  try {
    const batch = writeBatch(db);
    const prodRef = doc(db, 'products', currentStockProductId);

    parsedStockItems.forEach(item => {
      const itemRef = doc(collection(prodRef, 'stock_items'));
      batch.set(itemRef, {
        username: item.username,
        password: item.password,
        status: 'available',
        addedAt: serverTimestamp(),
        addedBy: 'atest'
      });
    });

    batch.update(prodRef, {
      stock: increment(parsedStockItems.length)
    });

    await batch.commit();

    triggerToast(`นำเข้าไอดีสำเร็จเรียบร้อย (${parsedStockItems.length} ชิ้น)`);
    document.getElementById('bulk-stock-textarea').value = '';
    handleStockTextareaInput('');
    
    loadAvailableStockItems(currentStockProductId);
  } catch (err) {
    console.warn('Stock import fallback (local):', err);
    const key = 'tactical_stock_' + currentStockProductId;
    const existing = JSON.parse(localStorage.getItem(key) || '[]');
    const updated = [...existing, ...parsedStockItems.map((it, idx) => ({
      id: 'local_' + Date.now() + '_' + idx,
      username: it.username,
      password: it.password,
      status: 'available',
      addedAt: new Date().toISOString()
    }))];
    localStorage.setItem(key, JSON.stringify(updated));

    // Update local product stock
    const p = PRODUCTS.find(it => it.id === currentStockProductId);
    if (p) p.stock = (p.stock || 0) + parsedStockItems.length;

    renderAdminProducts();
    updateAdminMetrics();
    loadAvailableStockItems(currentStockProductId);
    triggerToast(`นำเข้าไอดีสำเร็จ (${parsedStockItems.length} ชิ้น - โหมด Local)`);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function loadAvailableStockItems(productId) {
  const tbody = document.getElementById('stock-items-list-body');
  const emptyMsg = document.getElementById('stock-items-empty');
  const countBadge = document.getElementById('stock-available-count');
  if (!tbody) return;

  tbody.innerHTML = '';
  let items = [];

  try {
    const stockCol = collection(db, 'products', productId, 'stock_items');
    const q = query(stockCol, where('status', '==', 'available'));
    const snap = await getDocs(q);
    snap.forEach(docSnap => {
      items.push({ id: docSnap.id, ...docSnap.data() });
    });
  } catch (e) {
    const key = 'tactical_stock_' + productId;
    items = JSON.parse(localStorage.getItem(key) || '[]').filter(i => i.status === 'available');
  }

  if (countBadge) countBadge.textContent = items.length;
  const modalCount = document.getElementById('stock-modal-current-count');
  if (modalCount) modalCount.textContent = items.length;

  if (items.length === 0) {
    if (emptyMsg) emptyMsg.classList.remove('hidden');
    return;
  }

  if (emptyMsg) emptyMsg.classList.add('hidden');
  tbody.innerHTML = items.map((it, idx) => `
    <tr class="hover:bg-gallery/80 transition-colors">
      <td class="py-2.5 px-3 text-slate w-8">${idx + 1}.</td>
      <td class="py-2.5 px-3 font-semibold text-ink select-all">${it.username}</td>
      <td class="py-2.5 px-3 text-slate select-all">••••••••</td>
      <td class="py-2.5 px-3 text-right">
        <button onclick="deleteSingleStockItem('${productId}', '${it.id}')" class="text-red-500 hover:text-red-700 text-[11px] font-medium hover:underline">
          ลบออก
        </button>
      </td>
    </tr>
  `).join('');
}

async function deleteSingleStockItem(productId, itemId) {
  if (!confirm('คุณต้องการนำไอดีนี้ออกจากคลังสต็อกใช่หรือไม่?')) return;

  try {
    const batch = writeBatch(db);
    const itemRef = doc(db, 'products', productId, 'stock_items', itemId);
    const prodRef = doc(db, 'products', productId);

    batch.delete(itemRef);
    batch.update(prodRef, {
      stock: increment(-1)
    });
    await batch.commit();

    triggerToast('ลบไอดีออกจากคลังเรียบร้อย');
    loadAvailableStockItems(productId);
  } catch (err) {
    const key = 'tactical_stock_' + productId;
    const items = JSON.parse(localStorage.getItem(key) || '[]');
    const filtered = items.filter(i => i.id !== itemId);
    localStorage.setItem(key, JSON.stringify(filtered));

    const p = PRODUCTS.find(it => it.id === productId);
    if (p && p.stock > 0) p.stock -= 1;

    renderAdminProducts();
    updateAdminMetrics();
    loadAvailableStockItems(productId);
    triggerToast('ลบไอดีเรียบร้อย');
  }
}

// ==========================================
// 5b. ADMIN: CATEGORIES + SERVICE FIELDS OF THE PRODUCT FORM
// ==========================================
function fillProductCategorySelect() {
  const sel = document.getElementById('prod-category');
  if (!sel) return;
  const keep = sel.value;
  sel.innerHTML = ['account', 'service'].map(kind => {
    const opts = CATS.filter(c => c.kind === kind).map(c => `<option value="${adminEsc(c.id)}">${adminEsc(c.name)}</option>`).join('');
    return opts ? `<optgroup label="${adminEsc(KIND_LABEL[kind])}">${opts}</optgroup>` : '';
  }).join('');
  if (keep && CATS.some(c => c.id === keep)) sel.value = keep;
}

// Show the service box for service categories; the minimum and unit default to the category's.
function handleCategoryChange(catId) {
  const cat = categoryOf(CATS, catId);
  const isSrv = cat?.kind === 'service';
  document.getElementById('service-config-box')?.classList.toggle('hidden', !isSrv);
  if (!isSrv) return;
  const unit = document.getElementById('prod-service-unit');
  const min = document.getElementById('prod-service-min');
  unit.placeholder = cat.unit || 'กอง';
  min.placeholder = `ใช้ค่าของหมวด (${cat.minQty || 1})`;
  updateServiceSummary();
}

function updateServiceSummary() {
  const cat = categoryOf(CATS, document.getElementById('prod-category')?.value);
  const unit = document.getElementById('prod-service-unit').value.trim() || cat?.unit || 'กอง';
  const min = Math.floor(Number(document.getElementById('prod-service-min').value)) || cat?.minQty || 1;
  const rate = Number(document.getElementById('prod-service-rate').value) || 0;
  const pill = document.getElementById('service-summary-pill');
  if (pill) pill.innerText = `ราคา ${rate.toFixed(2)}฿ / ${unit} (สั่งซื้อขั้นต่ำ ${min} ${unit})`;
}

function syncServiceRateToPrice(v) {
  document.getElementById('prod-price').value = v;
  updateServiceSummary();
}

function setServiceUnitPreset(u) {
  document.getElementById('prod-service-unit').value = u;
  updateServiceSummary();
}

const SERVICE_TEMPLATES = { m61: ['กอง', 22, 15], koen_m: ['M', 25, 5], farm: ['รอบ', 150, 1] };
function applyServiceTemplate(key) {
  const [unit, rate, min] = SERVICE_TEMPLATES[key] || [];
  if (!unit) return;
  document.getElementById('prod-service-unit').value = unit;
  document.getElementById('prod-service-rate').value = rate;
  document.getElementById('prod-service-min').value = min;
  syncServiceRateToPrice(rate);
}

function renderAdminCategories() {
  const tbody = document.getElementById('admin-categories-table-body');
  if (!tbody) return;
  const note = document.getElementById('admin-categories-default-note');
  if (note) note.classList.toggle('hidden', CATS_FROM_DB);
  tbody.innerHTML = CATS.map(c => {
    const used = PRODUCTS.filter(p => p.category === c.id).length;
    const idArg = adminEsc(JSON.stringify(c.id));
    return `
    <tr class="border-b border-hairline">
      <td class="py-3 px-4 font-medium text-ink">${c.image ? `<img src="${adminEsc(c.image)}" alt="" class="inline-block w-10 h-6 object-cover rounded mr-2 align-middle">` : ''}${adminEsc(c.name)}<div class="text-[11px] text-slate font-mono font-normal">${adminEsc(c.id)}</div></td>
      <td class="py-3 px-4 text-slate">${adminEsc(KIND_LABEL[c.kind] || c.kind)}</td>
      <td class="py-3 px-4 font-mono text-ink">${c.kind === 'service' ? `ขั้นต่ำ ${adminEsc(c.minQty || 1)} ${adminEsc(c.unit || '')}` : '-'}</td>
      <td class="py-3 px-4 font-mono text-slate">${used}</td>
      <td class="py-3 px-4 whitespace-nowrap text-right">
        <button type="button" onclick='editCategory(${idArg})' class="apple-explore-pill px-3 py-1 text-[11px]">แก้ไข</button>
        <button type="button" onclick='deleteCategory(${idArg})' class="apple-explore-pill px-3 py-1 text-[11px] text-red-500 border-red-200 ml-1">ลบ</button>
      </td>
    </tr>`;
  }).join('');
}

function editCategory(id) {
  const c = categoryOf(CATS, id);
  if (!c) return;
  const set = (k, v) => { document.getElementById(k).value = v ?? ''; };
  set('cat-edit-id', c.id); set('cat-name', c.name); set('cat-kind', c.kind);
  set('cat-image', c.image); set('cat-unit', c.unit); set('cat-min', c.minQty); set('cat-order', c.order);
  toggleCategoryKind();
  document.getElementById('cat-name').focus();
}

function resetCategoryForm() {
  document.getElementById('category-form').reset();
  document.getElementById('cat-edit-id').value = '';
  toggleCategoryKind();
}

function toggleCategoryKind() {
  const isSrv = document.getElementById('cat-kind').value === 'service';
  document.getElementById('cat-service-fields')?.classList.toggle('hidden', !isSrv);
}

// Writing the first category into an empty collection would hide the built-in ones, so copy them first.
async function seedDefaultCategories() {
  if (CATS_FROM_DB) return;
  const batch = writeBatch(db);
  DEFAULT_CATEGORIES.forEach(c => batch.set(doc(db, 'categories', c.id), c));
  await batch.commit();
}

async function handleCategorySubmit(event) {
  event.preventDefault();
  const name = document.getElementById('cat-name').value.trim();
  const kind = document.getElementById('cat-kind').value;
  const editId = document.getElementById('cat-edit-id').value;
  const id = editId || 'cat_' + Date.now().toString(36);
  const minQty = Math.max(1, Math.floor(Number(document.getElementById('cat-min').value)) || 1);
  const data = { name, kind, order: Number(document.getElementById('cat-order').value) || 0, image: document.getElementById('cat-image').value.trim() || deleteField(), updatedAt: serverTimestamp() };
  if (kind === 'service') {
    data.unit = document.getElementById('cat-unit').value.trim() || 'กอง';
    data.minQty = minQty;
  }
  try {
    await seedDefaultCategories();
    await setDoc(doc(db, 'categories', id), kind === 'service' ? data : { ...data, unit: deleteField(), minQty: deleteField() }, { merge: true });
    triggerToast('บันทึกหมวดหมู่แล้ว');
    resetCategoryForm();
  } catch (e) {
    console.warn('Save category failed:', e);
    triggerToast('บันทึกหมวดหมู่ไม่สำเร็จ ตรวจสอบสิทธิ์แอดมิน');
  }
}

async function deleteCategory(id) {
  const used = PRODUCTS.filter(p => p.category === id).length;
  if (used && !confirm(`มีสินค้า ${used} รายการใช้หมวดนี้อยู่ สินค้าเหล่านั้นจะไม่ขึ้นในหมวดใดเลย ลบต่อหรือไม่?`)) return;
  if (!used && !confirm('ยืนยันลบหมวดหมู่นี้?')) return;
  try {
    await seedDefaultCategories();
    await deleteDoc(doc(db, 'categories', id));
    triggerToast('ลบหมวดหมู่แล้ว');
  } catch (e) {
    console.warn('Delete category failed:', e);
    triggerToast('ลบไม่สำเร็จ ตรวจสอบสิทธิ์แอดมิน');
  }
}

// ==========================================
// 7. ADMIN: ORDERS & PROMOS & SETTINGS
// ==========================================
const adminEsc = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const tsToDate = (v) => (v?.toDate ? v.toDate() : (v ? new Date(v) : null));

const ORDER_STATUS_UI = {
  pending_payment: { label: 'รอตรวจสอบ', cls: 'text-launchOrange bg-mist border-hairline' },
  processing: { label: 'อยู่ในคิวงาน', cls: 'text-appleBlue bg-mist border-hairline' },
  completed: { label: 'ส่งมอบแล้ว', cls: 'text-appleBlue bg-mist border-hairline' },
  cancelled: { label: 'ยกเลิก', cls: 'text-slate bg-mist border-hairline' }
};

async function renderAdminOrders() {
  const tbody = document.getElementById('admin-orders-table-body');
  const empty = document.getElementById('admin-orders-empty');
  if (!tbody) return;

  let orders = [];
  try {
    const snap = await getDocs(collection(db, 'orders'));
    snap.forEach(d => orders.push({ id: d.id, ...d.data() }));
  } catch (e) {
    console.warn('Load orders failed:', e);
    triggerToast('โหลดคำสั่งซื้อไม่สำเร็จ (ต้องเข้าสู่ระบบด้วยบัญชีแอดมิน)');
  }
  orders.sort((a, b) => (tsToDate(b.createdAt)?.getTime() || 0) - (tsToDate(a.createdAt)?.getTime() || 0));

  // Revenue counts only orders whose payment was verified.
  const done = orders.filter(o => o.status === 'completed');
  const rev = done.reduce((sum, o) => sum + (Number(o.amount) || 0), 0);
  const promptPayCount = orders.filter(o => o.paymentMethod === 'promptpay').length;
  const trueMoneyCount = orders.filter(o => o.paymentMethod === 'truemoney').length;

  const mRev = document.getElementById('metric-order-revenue');
  const mCount = document.getElementById('metric-order-count');
  const mPP = document.getElementById('metric-order-promptpay');
  const mTM = document.getElementById('metric-order-truemoney');

  if (mRev) mRev.innerText = `฿${rev.toFixed(2)}`;
  if (mCount) mCount.innerText = orders.length;
  if (mPP) mPP.innerText = promptPayCount;
  if (mTM) mTM.innerText = trueMoneyCount;

  if (orders.length === 0) {
    tbody.innerHTML = '';
    if (empty) empty.classList.remove('hidden');
    return;
  }
  if (empty) empty.classList.add('hidden');

  tbody.innerHTML = orders.map(o => {
    const acc = o.accountDelivered || {};
    const st = ORDER_STATUS_UI[o.status] || { label: o.status || '-', cls: 'text-slate bg-mist border-hairline' };
    const when = tsToDate(o.createdAt);
    const idArg = adminEsc(JSON.stringify(o.id));
    const actions = o.status === 'pending_payment' ? `
          <button type="button" onclick="approveOrder(${idArg})" class="apple-pricing-pill px-3 py-1 text-[11px]">ยืนยันชำระ &amp; ส่งมอบ</button>
          <button type="button" onclick="cancelOrder(${idArg})" class="apple-explore-pill px-3 py-1 text-[11px] ml-1">ยกเลิก</button>` : (o.status === 'processing' ? `
          <button type="button" onclick="setQueueStatus(${idArg},'working')" class="apple-explore-pill px-3 py-1 text-[11px]">เริ่มทำ</button>
          <button type="button" onclick="finishServiceOrder(${idArg})" class="apple-pricing-pill px-3 py-1 text-[11px] ml-1">เสร็จงาน</button>` : (o.gamePassword ? `
          <button type="button" onclick="clearGamePassword(${idArg})" class="apple-explore-pill px-3 py-1 text-[11px]">ลบรหัสเกม</button>` : ''));
    return `
      <tr class="hover:bg-mist/70 transition-colors border-b border-hairline">
        <td class="py-3 px-4 font-mono font-bold text-ink">${adminEsc(o.orderNumber || o.id)}</td>
        <td class="py-3 px-4 text-slate">${when ? when.toLocaleString('th-TH') : '-'}</td>
        <td class="py-3 px-4 font-medium text-ink">${adminEsc(o.productName)} <span class="text-slate font-normal">×${adminEsc(o.quantity || 1)}</span>${o.playTime ? `<div class="text-[11px] text-slate font-normal">เวลา ${adminEsc(o.playTime)}</div>` : ''}
          <div class="text-[11px] text-slate font-normal">${adminEsc(o.userEmail || '')} ${o.buyerContact ? '· ' + adminEsc(o.buyerContact) : (o.productType === 'service' ? '· ' + adminEsc(o.buyerEmail || '') : '')}</div></td>
        <td class="py-3 px-4 font-mono font-bold text-ink">฿${Number(o.amount || 0).toFixed(2)}${o.promoCode ? `<div class="text-[11px] text-slate font-normal">โค้ด ${adminEsc(o.promoCode)}</div>` : ''}</td>
        <td class="py-3 px-4 uppercase font-semibold text-slate">${adminEsc(o.paymentMethod || '-')}
          <div class="text-[11px] normal-case font-normal break-all select-all">${adminEsc(o.paymentProof || '')}</div></td>
        <td class="py-3 px-4 font-mono text-xs select-all text-slate">${acc.username ? `${adminEsc(acc.username)}:${adminEsc(acc.password)}` : (o.gameEmail ? `${adminEsc(o.gameEmail)}:${adminEsc(o.gamePassword || '(ลบแล้ว)')}` : '-')}</td>
        <td class="py-3 px-4"><span class="inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold border ${st.cls}">${adminEsc(st.label)}</span></td>
        <td class="py-3 px-4 whitespace-nowrap">${actions}</td>
      </tr>
    `;
  }).join('');
}

// Admin verifies the payment (slip / voucher) by hand, then this hands the goods over. The stock
// item, stock count and order status change in one transaction so two admins cannot deliver the
// same account twice.
async function approveOrder(orderId) {
  if (!confirm('ยืนยันว่าตรวจสอบการชำระเงินแล้ว และต้องการส่งมอบออเดอร์นี้?')) return;
  try {
    const orderRef = doc(db, 'orders', orderId);
    const orderSnap = await getDoc(orderRef);
    if (!orderSnap.exists()) throw new Error('NO_ORDER');
    const order = orderSnap.data();
    const prodRef = doc(db, 'products', order.productId);
    const isService = order.productType === 'service';

    let itemRef = null;
    if (!isService) {
      const found = await getDocs(query(collection(prodRef, 'stock_items'), where('status', '==', 'available'), limit(1)));
      if (found.empty) { triggerToast('ไม่มีไอดีในคลังสำหรับสินค้านี้ กรุณาเติมสต็อกก่อน'); return; }
      itemRef = found.docs[0].ref;
    }

    await runTransaction(db, async (txn) => {
      const oSnap = await txn.get(orderRef);
      const pSnap = await txn.get(prodRef);
      const iSnap = itemRef ? await txn.get(itemRef) : null;
      if (oSnap.data().status !== 'pending_payment') throw new Error('NOT_PENDING');
      const qty = isService ? (Number(order.quantity) || 1) : 1;
      // services go into the work queue; accounts are delivered right away
      const update = isService ? { status: 'processing', queuedAt: serverTimestamp() } : { status: 'completed', completedAt: serverTimestamp() };
      if (iSnap) {
        if (!iSnap.exists() || iSnap.data().status !== 'available') throw new Error('ITEM_TAKEN');
        const cred = iSnap.data();
        txn.update(itemRef, { status: 'sold', orderId: order.orderId, soldAt: serverTimestamp() });
        update.accountDelivered = { username: cred.username, password: cred.password, stockItemId: itemRef.id };
      }
      if (pSnap.exists()) {
        txn.update(prodRef, { stock: Math.max(0, (Number(pSnap.data().stock) || 0) - qty), updatedAt: serverTimestamp() });
      }
      txn.update(orderRef, update);
      if (isService) txn.set(doc(db, 'queue', orderId), { status: 'waiting', updatedAt: serverTimestamp() }, { merge: true });
    });

    if (order.promoCode) {
      try { await updateDoc(doc(db, 'promo_codes', order.promoCode), { usedCount: increment(1) }); } catch (_) {}
    }
    triggerToast('ส่งมอบออเดอร์เรียบร้อย');
  } catch (e) {
    console.warn('Approve order failed:', e);
    triggerToast(e.message === 'NOT_PENDING' ? 'ออเดอร์นี้ถูกดำเนินการไปแล้ว' : e.message === 'ITEM_TAKEN' ? 'ไอดีนี้ถูกใช้ไปแล้ว ลองกดอีกครั้ง' : 'ส่งมอบไม่สำเร็จ ตรวจสอบสิทธิ์แอดมิน');
  }
  renderAdminOrders();
}

async function cancelOrder(orderId) {
  if (!confirm('ยืนยันยกเลิกออเดอร์นี้?')) return;
  try {
    await updateDoc(doc(db, 'orders', orderId), { status: 'cancelled', cancelledAt: serverTimestamp() });
    try { await setDoc(doc(db, 'queue', orderId), { status: 'cancelled', updatedAt: serverTimestamp() }, { merge: true }); } catch (_) {}
    triggerToast('ยกเลิกออเดอร์แล้ว');
  } catch (e) {
    console.warn('Cancel order failed:', e);
    triggerToast('ยกเลิกไม่สำเร็จ ตรวจสอบสิทธิ์แอดมิน');
  }
  renderAdminOrders();
}

// Service orders carry the customer's game login only while the job is open.
async function clearGamePassword(orderId) {
  if (!confirm('ลบรหัสผ่านเกมของออเดอร์นี้ออกจากระบบ? (ทำหลังงานเสร็จแล้วเท่านั้น)')) return;
  try {
    await updateDoc(doc(db, 'orders', orderId), { gamePassword: deleteField(), gamePasswordClearedAt: serverTimestamp() });
    triggerToast('ลบรหัสผ่านเกมแล้ว');
  } catch (e) { triggerToast('ลบไม่สำเร็จ ตรวจสอบสิทธิ์แอดมิน'); }
  renderAdminOrders();
}
window.clearGamePassword = clearGamePassword;

async function setQueueStatus(orderId, status) {
  try {
    await setDoc(doc(db, 'queue', orderId), { status, updatedAt: serverTimestamp() }, { merge: true });
    triggerToast('อัปเดตคิวแล้ว');
  } catch (e) { triggerToast('อัปเดตไม่สำเร็จ ตรวจสอบสิทธิ์แอดมิน'); }
}
// Job done: order completes, queue shows done, the customer's game password is wiped.
async function finishServiceOrder(orderId) {
  if (!confirm('งานเสร็จแล้ว? ระบบจะลบรหัสผ่านเกมของลูกค้าออกด้วย')) return;
  try {
    await updateDoc(doc(db, 'orders', orderId), { status: 'completed', completedAt: serverTimestamp(), gamePassword: deleteField(), gamePasswordClearedAt: serverTimestamp() });
    await setDoc(doc(db, 'queue', orderId), { status: 'done', updatedAt: serverTimestamp() }, { merge: true });
    triggerToast('ปิดงานแล้ว ลบรหัสเกมแล้ว');
  } catch (e) { triggerToast('ปิดงานไม่สำเร็จ ตรวจสอบสิทธิ์แอดมิน'); }
  renderAdminOrders();
}
window.setQueueStatus = setQueueStatus;
window.finishServiceOrder = finishServiceOrder;

function refreshOrders() {
  renderAdminOrders();
  triggerToast('รีเฟรชข้อมูลคำสั่งซื้อเรียบร้อย');
}

// ==========================================
// 3. PROMO CODE MANAGEMENT (Moved to js/back/code.js)
// ==========================================
// Separate module js/back/code.js handles renderAdminPromos, openPromoModal,
// closePromoModal, handlePromoTypeChange, handleSavePromoModal, deletePromo.

async function loadAdminSettings() {
  try {
    let data = null;
    try {
      const sDoc = await getDoc(doc(db, 'system', 'settings'));
      if (sDoc.exists()) {
        data = sDoc.data();
      }
    } catch (e) {
      console.warn("Load settings remote fallback:", e);
    }

    if (!data) {
      const local = localStorage.getItem('tactical_store_settings');
      if (local) {
        try { data = JSON.parse(local); } catch (_) {}
      }
    }

    if (!data) data = {};

    // Provider keys live in an admin-only document, never in the public system/settings.
    let secrets = {};
    try {
      const secSnap = await getDoc(doc(db, 'system_private', 'secrets'));
      if (secSnap.exists()) secrets = secSnap.data();
    } catch (e) {
      console.warn('Load secrets skipped:', e);
    }
    data = { ...data, ...secrets };

    const setVal = (id, val) => {
      const el = document.getElementById(id);
      if (el && val !== undefined && val !== null) el.value = val;
    };

    setVal('setting-marquee-text', data.marqueeText);
    setVal('setting-ribbon-text', data.ribbonText);
    setVal('setting-ribbon-link-text', data.ribbonLinkText);
    setVal('setting-ribbon-link-url', data.ribbonLinkUrl);
    setVal('setting-stat1-val', data.stat1Val);
    setVal('setting-stat1-lbl', data.stat1Lbl);
    setVal('setting-stat2-val', data.stat2Val);
    setVal('setting-stat2-lbl', data.stat2Lbl);
    setVal('setting-stat3-val', data.stat3Val);
    setVal('setting-stat3-lbl', data.stat3Lbl);
    setVal('setting-stat4-val', data.stat4Val);
    setVal('setting-stat4-lbl', data.stat4Lbl);
    setVal('setting-discord-link', data.discordLink);
    setVal('setting-line-id', data.lineId);
    setVal('setting-slipok-key', data.slipokKey);
    setVal('setting-slipok-branch', data.slipokBranch);
    setVal('setting-slipok-receiver', data.slipokReceiver);
    setVal('setting-truemoney-key', data.truemoneyKey);
    setVal('setting-promptpay-no', data.promptpayNo);
    setVal('setting-promptpay-qr-url', data.promptpayQrUrl);
    setVal('setting-promptpay-name', data.promptpayName);
    const auto = document.getElementById('setting-slip-auto');
    if (auto) auto.checked = data.slipAutoVerify === true;
    setVal('setting-slip-worker-url', data.slipWorkerUrl);

  } catch (e) {
    console.warn("Load settings error:", e);
  }
}

async function handleSaveSettings(event) {
  event.preventDefault();

  const getVal = (id) => (document.getElementById(id)?.value || '').trim();

  // Only storefront-safe fields go to the public system/settings document.
  const payload = {
    marqueeText: getVal('setting-marquee-text'),
    ribbonText: getVal('setting-ribbon-text'),
    ribbonLinkText: getVal('setting-ribbon-link-text'),
    ribbonLinkUrl: getVal('setting-ribbon-link-url'),
    stat1Val: getVal('setting-stat1-val'),
    stat1Lbl: getVal('setting-stat1-lbl'),
    stat2Val: getVal('setting-stat2-val'),
    stat2Lbl: getVal('setting-stat2-lbl'),
    stat3Val: getVal('setting-stat3-val'),
    stat3Lbl: getVal('setting-stat3-lbl'),
    stat4Val: getVal('setting-stat4-val'),
    stat4Lbl: getVal('setting-stat4-lbl'),
    discordLink: getVal('setting-discord-link'),
    lineId: getVal('setting-line-id'),
    promptpayQrUrl: getVal('setting-promptpay-qr-url'),
    promptpayName: getVal('setting-promptpay-name'),
    // Public flag only: tells the top-up page to offer slip upload. The key itself stays in system_private.
    slipAutoVerify: !!document.getElementById('setting-slip-auto')?.checked,
    slipWorkerUrl: getVal('setting-slip-worker-url'),
    updatedAt: serverTimestamp()
  };
  const secrets = {
    slipokKey: getVal('setting-slipok-key'),
    slipokBranch: getVal('setting-slipok-branch'),
    slipokReceiver: getVal('setting-slipok-receiver'),
    truemoneyKey: getVal('setting-truemoney-key'),
    promptpayNo: getVal('setting-promptpay-no'),
    updatedAt: serverTimestamp()
  };

  try {
    await setDoc(doc(db, 'system', 'settings'), payload, { merge: true });
    await setDoc(doc(db, 'system_private', 'secrets'), secrets, { merge: true });
    triggerToast('บันทึกการตั้งค่าร้านค้าสำเร็จ');
  } catch (e) {
    console.warn('Save settings failed:', e);
    triggerToast('บันทึกไม่สำเร็จ ตรวจสอบสิทธิ์แอดมิน');
  }
}

const TOPUP_STATUS_UI = {
  pending: ['รอตรวจสอบ', 'text-launchOrange'],
  completed: ['เติมแล้ว', 'text-appleBlue'],
  rejected: ['ไม่อนุมัติ', 'text-slate']
};

async function renderAdminTopups() {
  const tbody = document.getElementById('admin-topups-table-body');
  const emptyEl = document.getElementById('admin-topups-empty');
  if (!tbody) return;

  let topups = [];
  try {
    const snap = await getDocs(collection(db, 'topup_transactions'));
    snap.forEach(d => topups.push({ id: d.id, ...d.data() }));
  } catch (e) {
    console.warn('Load topups failed:', e);
    triggerToast('โหลดรายการเติมเงินไม่สำเร็จ (ต้องเข้าสู่ระบบด้วยบัญชีแอดมิน)');
  }
  topups.sort((a, b) => (tsToDate(b.createdAt)?.getTime() || 0) - (tsToDate(a.createdAt)?.getTime() || 0));

  if (topups.length === 0) {
    tbody.innerHTML = '';
    if (emptyEl) emptyEl.classList.remove('hidden');
    return;
  }
  if (emptyEl) emptyEl.classList.add('hidden');

  tbody.innerHTML = topups.map(t => {
    const [label, cls] = TOPUP_STATUS_UI[t.status] || [t.status || '-', 'text-slate'];
    const idArg = adminEsc(JSON.stringify(t.id));
    const actions = t.status === 'pending' ? `
        <button type="button" onclick="approveTopup(${idArg})" class="apple-pricing-pill px-3 py-1 text-[11px]">ยืนยัน &amp; เติมเครดิต</button>
        <button type="button" onclick="rejectTopup(${idArg})" class="apple-explore-pill px-3 py-1 text-[11px] ml-1">ไม่อนุมัติ</button>` : '';
    return `
    <tr class="hover:bg-mist/70 transition-colors border-b border-hairline">
      <td class="py-3 px-4 font-mono font-bold text-xs text-ink">${adminEsc(t.txnId || t.id)}</td>
      <td class="py-3 px-4 text-xs font-mono text-slate">${adminEsc(t.email || t.uid || '-')}</td>
      <td class="py-3 px-4 text-xs font-medium text-ink">${t.paymentMethod === 'truemoney' ? 'TrueMoney' : 'พร้อมเพย์'}</td>
      <td class="py-3 px-4 text-xs font-mono font-semibold text-ink">฿${Number(t.amount || 0).toFixed(2)}</td>
      <td class="py-3 px-4 text-xs font-mono font-semibold text-ink">+${Number(t.finalCredit || t.amount || 0).toFixed(2)}</td>
      <td class="py-3 px-4 text-xs font-mono text-slate break-all select-all max-w-[220px]">${adminEsc(t.proofRef || '-')}</td>
      <td class="py-3 px-4 text-xs font-semibold ${cls}">${adminEsc(label)}</td>
      <td class="py-3 px-4 whitespace-nowrap">${actions}</td>
    </tr>`;
  }).join('');
}

// Credits the wallet only after the admin has checked the money really arrived. One transaction
// flips the request and adds the credit, so a double click cannot pay twice.
async function approveTopup(txnId) {
  if (!confirm('ยืนยันว่าได้รับเงินแล้ว และต้องการเติมเครดิตให้ผู้ใช้?')) return;
  try {
    const tRef = doc(db, 'topup_transactions', txnId);
    await runTransaction(db, async (txn) => {
      const tSnap = await txn.get(tRef);
      if (!tSnap.exists() || tSnap.data().status !== 'pending') throw new Error('NOT_PENDING');
      const t = tSnap.data();
      const uRef = doc(db, 'users', t.uid);
      const uSnap = await txn.get(uRef);
      const prev = uSnap.exists() ? (parseFloat(uSnap.data().walletBalance) || 0) : 0;
      txn.set(uRef, { walletBalance: prev + (Number(t.finalCredit) || Number(t.amount) || 0), lastTopupAt: serverTimestamp() }, { merge: true });
      txn.update(tRef, { status: 'completed', completedAt: serverTimestamp() });
    });
    triggerToast('เติมเครดิตเรียบร้อย');
  } catch (e) {
    console.warn('Approve topup failed:', e);
    triggerToast(e.message === 'NOT_PENDING' ? 'รายการนี้ถูกดำเนินการไปแล้ว' : 'เติมเครดิตไม่สำเร็จ ตรวจสอบสิทธิ์แอดมิน');
  }
  renderAdminTopups();
}

async function rejectTopup(txnId) {
  if (!confirm('ยืนยันไม่อนุมัติรายการนี้?')) return;
  try {
    await updateDoc(doc(db, 'topup_transactions', txnId), { status: 'rejected', completedAt: serverTimestamp() });
    triggerToast('ไม่อนุมัติรายการแล้ว');
  } catch (e) {
    console.warn('Reject topup failed:', e);
    triggerToast('ดำเนินการไม่สำเร็จ ตรวจสอบสิทธิ์แอดมิน');
  }
  renderAdminTopups();
}

function switchAdminTab(tabName) {
  const tabs = ['products', 'categories', 'orders', 'promos', 'topups', 'settings'];
  tabs.forEach(t => {
    const sec = document.getElementById(`admin-sec-${t}`);
    const btn = document.getElementById(`admin-tab-btn-${t}`);
    if (sec) sec.classList.toggle('hidden', t !== tabName);
    if (btn) {
      if (t === tabName) {
        btn.className = 'px-4 py-1.5 rounded-button text-xs font-normal transition-all bg-ink text-gallery flex items-center gap-2 shrink-0';
      } else {
        btn.className = 'px-4 py-1.5 rounded-button text-xs font-normal transition-all text-slate hover:text-ink flex items-center gap-2 shrink-0';
      }
    }
  });

  if (tabName === 'promos') {
    if (typeof window.renderAdminPromos === 'function') {
      window.renderAdminPromos();
    }
  } else if (tabName === 'topups') {
    if (typeof window.renderAdminTopups === 'function') {
      window.renderAdminTopups();
    }
  }
}

// ==========================================
// 9. WINDOW ATTACHMENTS & INITIALIZER
// ==========================================
// Storefront methods

// Admin methods
window.handlePinSetupSubmit = handlePinSetupSubmit;
window.handlePinUnlockSubmit = handlePinUnlockSubmit;
window.promptResetPin = promptResetPin;
window.lockAdminSession = lockAdminSession;
window.openStockModal = openStockModal;
window.closeStockModal = closeStockModal;
window.handleStockTextareaInput = handleStockTextareaInput;
window.submitBulkStockImport = submitBulkStockImport;
window.deleteSingleStockItem = deleteSingleStockItem;
window.openProductModal = openProductModal;
window.closeProductModal = closeProductModal;
window.handleProductFormSubmit = handleProductFormSubmit;
window.deleteAdminProduct = deleteAdminProduct;
window.setImagePreset = setImagePreset;
window.updateImagePreview = updateImagePreview;
window.openStockModalQuick = openStockModalQuick;
window.refreshOrders = refreshOrders;
window.approveOrder = approveOrder;
window.approveTopup = approveTopup;
window.rejectTopup = rejectTopup;
window.cancelOrder = cancelOrder;
window.handleSaveSettings = handleSaveSettings;
window.switchAdminTab = switchAdminTab;
Object.assign(window, { handleCategoryChange, updateServiceSummary, syncServiceRateToPrice, setServiceUnitPreset, applyServiceTemplate, editCategory, resetCategoryForm, toggleCategoryKind, handleCategorySubmit, deleteCategory });

window.addEventListener('DOMContentLoaded', () => {
  initFirebaseProductsListener();
  watchCategories((list, fromDb) => {
    CATS = list;
    CATS_FROM_DB = !!fromDb;
    renderAdminCategories();
    fillProductCategorySelect();
    renderAdminProducts();
  });
  checkSecurityPinState();
});
