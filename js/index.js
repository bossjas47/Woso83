import { db, auth } from "../firebase-config.js";
import {
  collection,
  doc,
  setDoc,
  onSnapshot,
  getDoc,
  query,
  where,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { 
  onAuthStateChanged, 
  signOut 
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { productCardHtml } from "./card.js";
import { categoryCardsHtml, watchCategories, loadCategories, isServiceProduct as isServiceProductIn, minQtyOf, unitOf, KIND_LABEL } from "./categories.js";

const FALLBACK_IMG = 'https://placehold.co/800x500/f5f5f7/86868b?text=Arena+Breakout';

// ==========================================
// 1. CATEGORIES & APP STATE
// ==========================================
let CATS = [];
let CATEGORIES = [{ id: 'all', name: 'ทั้งหมด' }];

let PRODUCTS = [];
let productsLoadFailed = false;
let currentCategory = 'all';
let searchQuery = '';
let smartFilter = 'all'; // 'all' | 'instock' | 'under200' | '200to500' | 'over500'
let sortOrder = 'default';
let selectedProduct = null;
let serviceOrderQty = 1;
let currentPaymentMethod = 'promptpay';
let discountAmount = 0;
let promoDiscountFn = null; // subtotal -> discount, so percent codes follow quantity changes
let appliedPromoCode = null;
let isSubmitting = false;
let toastTimeout = null;
let unsubOrders = null;
let currentUser = null;
let currentModalGallery = [];
let currentGalleryIdx = 0;
let customStat2Override = '';
let globalKoenLabel = 'Koen';
let cloudOrdersCache = [];

let promoFailedAttempts = 0;
let promoLockoutExpiry = 0;

// ==========================================
// 0. SAFE HELPERS
// ==========================================
function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isServiceProduct(product) {
  return isServiceProductIn(product, CATS);
}

function getEffectivePrice(product) {
  const rawPrice = Number(product?.price);
  if (Number.isFinite(rawPrice) && rawPrice > 0) return rawPrice;
  const rate = Number(product?.serviceRate);
  return Number.isFinite(rate) && rate > 0 ? rate : 0;
}

function getEffectiveStock(product) {
  const s = Number(product?.stock);
  return Number.isFinite(s) && s > 0 ? Math.floor(s) : 0;
}

function formatKoenText(product) {
  const defaultLabel = isServiceProduct(product) ? 'ข้อกำหนด' : globalKoenLabel;
  const label = String(
    product?.koenLabel ||
    product?.currencyLabel ||
    product?.unitLabel ||
    defaultLabel ||
    'Koen'
  ).trim();
  const val = String(product?.koen ?? '-').trim();
  if (!label || val.includes(':') || val.toLowerCase().startsWith(label.toLowerCase())) {
    return val;
  }
  return `${label}: ${val}`;
}

function triggerToast(message) {
  const box = document.getElementById('toast-box');
  const text = document.getElementById('toast-text');
  if (!box || !text) return;

  text.innerText = message;
  box.classList.remove('opacity-0', '-translate-y-4', 'scale-95');
  box.classList.add('opacity-100', 'translate-y-0', 'scale-100');

  if (toastTimeout) clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    box.classList.add('opacity-0', '-translate-y-4', 'scale-95');
    box.classList.remove('opacity-100', 'translate-y-0', 'scale-100');
  }, 3000);
}

// ==========================================
// 2. FIREBASE AUTH & LIVE LISTENERS
// ==========================================
function initAuthListener() {
  if (!auth) return;
  try {
    onAuthStateChanged(auth, (user) => {
      currentUser = user;
      const loggedOutContainer = document.getElementById('auth-logged-out');
      const loggedInContainer = document.getElementById('auth-logged-in');
      const displayNameEl = document.getElementById('user-display-name');
      const avatarInitialEl = document.getElementById('user-avatar-initial');
      const mobileAuthText = document.getElementById('mobile-nav-auth-text');

      if (user) {
        const name = user.displayName || user.email?.split('@')[0] || 'Agent';
        if (loggedOutContainer) loggedOutContainer.classList.add('hidden');
        if (loggedInContainer) {
          loggedInContainer.classList.remove('hidden');
          loggedInContainer.classList.add('flex');
        }
        if (displayNameEl) displayNameEl.innerText = name;
        if (avatarInitialEl) avatarInitialEl.innerText = name.charAt(0).toUpperCase();
        if (mobileAuthText) mobileAuthText.innerText = name.length > 5 ? name.slice(0, 5) + '...' : name;
        syncUserCloudOrders(user.uid);
      } else {
        syncUserCloudOrders(null);
        cloudOrdersCache = [];
        if (loggedOutContainer) loggedOutContainer.classList.remove('hidden');
        if (loggedInContainer) {
          loggedInContainer.classList.add('hidden');
          loggedInContainer.classList.remove('flex');
        }
        if (mobileAuthText) mobileAuthText.innerText = 'บัญชี';
        updateMyOrdersBadge();
      }
    });
  } catch (err) {
    console.warn("Auth listener skipped:", err);
  }
}

async function handleSignOut() {
  try {
    if (auth) await signOut(auth);
    triggerToast('ออกจากระบบเรียบร้อยแล้ว');
  } catch (error) {
    console.error("Sign out error:", error);
    triggerToast('เกิดข้อผิดพลาดในการออกจากระบบ');
  }
}

function renderSkeletonGrid() {
  const grid = document.getElementById('product-grid');
  if (!grid) return;
  grid.innerHTML = Array.from({ length: 6 }).map(() => `
    <div class="apple-card p-7 flex flex-col h-full animate-pulse">
      <div class="aspect-[16/10] rounded-images bg-mist mb-4"></div>
      <div class="h-4 bg-mist rounded-full w-3/4 mb-2"></div>
      <div class="h-3 bg-mist rounded-full w-full mb-1.5"></div>
      <div class="h-3 bg-mist rounded-full w-2/3 mb-4"></div>
      <div class="h-5 bg-mist rounded-full w-1/3 mb-4"></div>
      <div class="mt-auto pt-3.5 border-t border-hairline flex justify-between items-center">
        <div class="h-7 bg-mist rounded-full w-20"></div>
        <div class="flex gap-2">
          <div class="h-7 bg-mist rounded-full w-24"></div>
          <div class="h-7 bg-mist rounded-full w-16"></div>
        </div>
      </div>
    </div>
  `).join('');
}

function showProductsLoadFailed() {
  PRODUCTS = [];
  productsLoadFailed = true;
  renderCategoryOptions();
  renderProducts();
  updateHeroMetrics();
}

function initFirebaseProductsListener() {
  if (!db) return showProductsLoadFailed();
  // shortcut: fixed 8s wait for the first snapshot, upgrade to retry/backoff if flaky networks matter
  const loadTimer = setTimeout(showProductsLoadFailed, 8000);
  try {
    onSnapshot(collection(db, "products"), (snapshot) => {
      clearTimeout(loadTimer);
      productsLoadFailed = false;
      PRODUCTS = snapshot.docs.map((docSnap) => {
        const data = docSnap.data() || {};
        const primaryImg = data.image || FALLBACK_IMG;
        return {
          id: docSnap.id,
          ...data,
          name: String(data.name || 'ไม่มีชื่อสินค้า'),
          category: String(data.category || 'all'),
          price: getEffectivePrice(data),
          koen: data.koen || '-',
          koenLabel: data.koenLabel || data.currencyLabel || data.unitLabel || '',
          stock: getEffectiveStock(data),
          image: primaryImg,
          gallery: Array.isArray(data.gallery) && data.gallery.length > 0 ? data.gallery.filter(Boolean) : [primaryImg],
          tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
          desc: data.desc || '',
          specs: Array.isArray(data.specs) ? data.specs.map(String) : []
        };
      });
      renderCategoryOptions();
      renderProducts();
      updateHeroMetrics();
    }, (err) => {
      clearTimeout(loadTimer);
      console.warn("Products listener failed:", err);
      showProductsLoadFailed();
    });
  } catch (e) {
    clearTimeout(loadTimer);
    showProductsLoadFailed();
  }
}

function applySystemSettings(data) {
  if (!data) return;

  const customLabel = data.koenLabel || data.currencyLabel || data.unitLabel || data.valueLabel;
  if (customLabel && String(customLabel).trim() !== '') {
    globalKoenLabel = String(customLabel).trim();
    renderProducts();
  }

  if (data.marqueeText && String(data.marqueeText).trim() !== '') {
    const track = document.getElementById('marquee-track-container');
    if (track) {
      const safeMarquee = escapeHtml(data.marqueeText.trim());
      const item = `
        <span class="mx-6 inline-flex items-center gap-2 text-ink shrink-0 whitespace-nowrap">
          <span class="text-launchOrange font-semibold">ใหม่</span>
          ${safeMarquee}
        </span>
        <span class="text-hairline shrink-0">•</span>
        <span class="mx-6 text-appleBlue font-medium shrink-0 whitespace-nowrap">โค้ดส่วนลด: TACTICAL ลด 50 บาท | ARENA10 ลด 10%</span>
        <span class="text-hairline shrink-0">•</span>
      `;
      // The track slides by -50%, so it needs an even number of copies wide enough to cover large screens.
      track.innerHTML = item.repeat(4);
    }
  }

  const ribbon = document.getElementById('apple-promo-ribbon');
  const rText = document.getElementById('ribbon-main-text');
  const rLink = document.getElementById('ribbon-link');
  const rLinkText = document.getElementById('ribbon-link-text');
  if (ribbon && data.ribbonText) {
    ribbon.classList.remove('hidden');
    if (rText) rText.innerText = data.ribbonText;
    if (rLink && /^(https?:|#|\/)/.test(String(data.ribbonLinkUrl || ''))) rLink.href = data.ribbonLinkUrl;
    if (rLinkText && data.ribbonLinkText) rLinkText.innerText = data.ribbonLinkText;
  }

  // Stat tiles 1, 3 and 4 stay hidden until the admin enters a real value; tile 2 is computed from stock.
  [1, 3, 4].forEach((n) => {
    const val = document.getElementById(`hero-stat${n}-val`);
    const lbl = document.getElementById(`hero-stat${n}-lbl`);
    if (val && data[`stat${n}Val`]) {
      val.innerText = data[`stat${n}Val`];
      val.parentElement.classList.remove('hidden');
    }
    if (lbl && data[`stat${n}Lbl`]) lbl.innerText = data[`stat${n}Lbl`];
  });

  const s2l = document.getElementById('hero-stat2-lbl');
  if (s2l && data.stat2Lbl) s2l.innerText = data.stat2Lbl;
  customStat2Override = data.stat2Val ? String(data.stat2Val).trim() : '';
  updateHeroMetrics();

  // Payment details come from system/settings so the shop's real account is never hard-coded.
  const qrImg = document.getElementById('qr-img');
  if (qrImg && /^https:\/\//.test(String(data.promptpayQrUrl || ''))) {
    qrImg.src = data.promptpayQrUrl;
    qrImg.classList.remove('hidden');
    document.getElementById('qr-placeholder')?.classList.add('hidden');
  }
  const acctName = document.getElementById('promptpay-account-name');
  if (acctName && data.promptpayName) {
    acctName.innerText = data.promptpayName;
    acctName.closest('.hidden')?.classList.remove('hidden');
  }
}

function initSettingsListener() {
  try {
    const local = localStorage.getItem('tactical_store_settings');
    if (local) applySystemSettings(JSON.parse(local));
  } catch (_) {}

  if (!db) return;
  try {
    const sDoc = doc(db, "system", "settings");
    onSnapshot(sDoc, (snap) => {
      if (snap.exists()) applySystemSettings(snap.data());
    });
  } catch (err) {
    console.warn("Settings listener error:", err);
  }
}

function updateHeroMetrics() {
  const el = document.getElementById('hero-instock-count');
  if (!el) return;
  if (customStat2Override) {
    el.innerText = customStat2Override;
    return;
  }
  const inStockTotal = PRODUCTS.reduce((sum, p) => sum + getEffectiveStock(p), 0);
  el.innerText = inStockTotal.toLocaleString();
}

// ==========================================
// 3. UNIFIED CATALOG FILTERING & SORTING
// ==========================================
function renderCategoryOptions() {
  const selectEl = document.getElementById('category-select');
  if (!selectEl) return;

  const opt = (cat) => {
    const count = PRODUCTS.filter(p => p.category === cat.id).length;
    return `<option value="${escapeHtml(cat.id)}" ${cat.id === currentCategory ? 'selected' : ''}>${escapeHtml(cat.name)} (${count})</option>`;
  };
  const groups = ['account', 'service'].map(kind => {
    const items = CATS.filter(c => c.kind === kind);
    return items.length ? `<optgroup label="${escapeHtml(KIND_LABEL[kind])}">${items.map(opt).join('')}</optgroup>` : '';
  }).join('');
  selectEl.innerHTML = `<option value="all" ${currentCategory === 'all' ? 'selected' : ''}>ทุกหมวดหมู่ (${PRODUCTS.length})</option>${groups}`;
}

function updateResetButtonVisibility() {
  const resetBtn = document.getElementById('btn-reset-filters');
  if (!resetBtn) return;
  const isFiltered = currentCategory !== 'all' || smartFilter !== 'all' || sortOrder !== 'default' || searchQuery.trim() !== '';
  resetBtn.classList.toggle('hidden', !isFiltered);
}

function filterCategory(catId) {
  currentCategory = CATEGORIES.some(c => c.id === catId) ? catId : 'all';
  const selectEl = document.getElementById('category-select');
  if (selectEl && selectEl.value !== currentCategory) selectEl.value = currentCategory;
  renderProducts();
}

function handleSearch(val) {
  searchQuery = String(val ?? '');
  const desktopInput = document.getElementById('search-input');
  const mobileInput = document.getElementById('search-input-mobile');
  if (desktopInput && desktopInput.value !== searchQuery) desktopInput.value = searchQuery;
  if (mobileInput && mobileInput.value !== searchQuery) mobileInput.value = searchQuery;
  renderProducts();
}

function handleSmartFilterChange(val) {
  smartFilter = val || 'all';
  const selectEl = document.getElementById('smart-filter-select');
  if (selectEl && selectEl.value !== smartFilter) selectEl.value = smartFilter;
  renderProducts();
}

function setStockFilter(mode) {
  handleSmartFilterChange(mode === 'instock' ? 'instock' : 'all');
}

function handleSortChange(val) {
  sortOrder = val || 'default';
  renderProducts();
}

function clearSearchAndFilters() {
  currentCategory = 'all';
  searchQuery = '';
  smartFilter = 'all';
  sortOrder = 'default';
  
  const searchInput = document.getElementById('search-input');
  if (searchInput) searchInput.value = '';
  const searchInputMobile = document.getElementById('search-input-mobile');
  if (searchInputMobile) searchInputMobile.value = '';
  const catSelect = document.getElementById('category-select');
  if (catSelect) catSelect.value = 'all';
  const smartSelect = document.getElementById('smart-filter-select');
  if (smartSelect) smartSelect.value = 'all';
  const sortSelect = document.getElementById('sort-select');
  if (sortSelect) sortSelect.value = 'default';

  renderProducts();
}

function scrollToCatalog() {
  const el = document.getElementById('catalog-section');
  if (el) el.scrollIntoView({ behavior: 'smooth' });
}

function renderProducts() {
  const grid = document.getElementById('product-grid');
  const emptyState = document.getElementById('empty-state');
  const countLabel = document.getElementById('catalog-count-label');
  if (!grid || !emptyState) return;

  updateResetButtonVisibility();

  // Browsing: no category, search or filter yet -> show category cards instead of products.
  const browsing = currentCategory === 'all' && !searchQuery.trim() && smartFilter === 'all' && sortOrder === 'default';
  const cardsEl = document.getElementById('category-cards');
  const backEl = document.getElementById('category-back');
  if (cardsEl) {
    cardsEl.classList.toggle('hidden', !browsing);
    cardsEl.classList.toggle('grid', browsing);
    if (browsing) cardsEl.innerHTML = categoryCardsHtml(CATS, PRODUCTS);
  }
  if (backEl) backEl.classList.toggle('hidden', browsing);
  if (browsing) {
    grid.innerHTML = '';
    emptyState.classList.add('hidden'); emptyState.classList.remove('flex');
    if (countLabel) countLabel.innerText = `${CATS.length} หมวดหมู่`;
    return;
  }

  const q = searchQuery.toLowerCase().trim();
  const filtered = PRODUCTS.filter(p => {
    const matchCat = currentCategory === 'all' || p.category === currentCategory;
    const nameStr = String(p.name || '').toLowerCase();
    const matchSearch = !q || nameStr.includes(q) ||
                        (Array.isArray(p.tags) && p.tags.some(t => String(t).toLowerCase().includes(q)));

    const stockCount = getEffectiveStock(p);
    const price = getEffectivePrice(p);

    let matchSmart = true;
    if (smartFilter === 'instock') {
      matchSmart = stockCount > 0;
    } else if (smartFilter === 'under200') {
      matchSmart = stockCount > 0 && price <= 200;
    } else if (smartFilter === '200to500') {
      matchSmart = stockCount > 0 && price > 200 && price <= 500;
    } else if (smartFilter === 'over500') {
      matchSmart = stockCount > 0 && price > 500;
    }

    return matchCat && matchSearch && matchSmart;
  });

  if (sortOrder === 'price-asc') {
    filtered.sort((a, b) => getEffectivePrice(a) - getEffectivePrice(b));
  } else if (sortOrder === 'price-desc') {
    filtered.sort((a, b) => getEffectivePrice(b) - getEffectivePrice(a));
  } else if (sortOrder === 'stock-desc') {
    filtered.sort((a, b) => getEffectiveStock(b) - getEffectiveStock(a));
  }

  const readyCount = filtered.filter(p => getEffectiveStock(p) > 0).length;
  if (countLabel) {
    countLabel.innerText = productsLoadFailed ? 'โหลดสินค้าไม่สำเร็จ' : `แสดง ${filtered.length} รายการ (พร้อมส่ง ${readyCount})`;
  }
  const emptyTitle = document.getElementById('empty-title');
  if (emptyTitle) emptyTitle.innerText = productsLoadFailed ? 'โหลดรายการสินค้าไม่สำเร็จ กรุณารีเฟรชหน้านี้' : 'ไม่พบสินค้าที่ตรงกับตัวกรอง';

  if (filtered.length === 0) {
    grid.innerHTML = '';
    emptyState.classList.remove('hidden');
    emptyState.classList.add('flex');
    return;
  }

  emptyState.classList.add('hidden');
  emptyState.classList.remove('flex');

  grid.innerHTML = filtered.map(product => productCardHtml({
    p: product,
    isService: isServiceProduct(product),
    unit: unitOf(product, CATS),
    min: minQtyOf(product, CATS),
    price: getEffectivePrice(product),
    stock: getEffectiveStock(product),
    koen: formatKoenText(product),
    categoryName: CATS.find(c => c.id === product.category)?.name,
    fallback: FALLBACK_IMG
  })).join('');
}

// ==========================================
// 4. PRODUCT DETAIL MODAL & MULTI-IMAGE GALLERY
// ==========================================
function openDetailModal(productId) {
  const p = PRODUCTS.find(item => String(item.id) === String(productId));
  if (!p) return;

  const isService = isServiceProduct(p);
  const unit = unitOf(p, CATS);
  const stockCount = getEffectiveStock(p);
  const priceVal = getEffectivePrice(p).toFixed(2);

  currentModalGallery = Array.isArray(p.gallery) && p.gallery.length > 0 ? p.gallery.filter(Boolean) : [p.image || FALLBACK_IMG];
  currentGalleryIdx = 0;

  document.getElementById('modal-img').src = currentModalGallery[0] || FALLBACK_IMG;
  document.getElementById('modal-title').innerText = p.name || 'ไม่มีชื่อสินค้า';
  document.getElementById('modal-koen').innerText = formatKoenText(p);
  document.getElementById('modal-desc').innerText = p.desc || '-';
  document.getElementById('modal-price').innerText = isService ? `฿${priceVal} / ${unit}` : `฿${priceVal}`;

  const priceLbl = document.getElementById('modal-price-label');
  if (priceLbl) {
    priceLbl.innerText = isService ? `ราคาบริการ (ขั้นต่ำ ${minQtyOf(p, CATS)} ${unit})` : 'ราคาจำหน่าย';
  }

  const stockBadge = document.getElementById('modal-stock-badge');
  if (stockCount <= 0) {
    stockBadge.innerText = isService ? 'คิวเต็มชั่วคราว' : 'สินค้าหมด';
    stockBadge.className = 'bg-mist border border-hairline text-launchOrange text-xs font-semibold px-2.5 py-0.5 rounded-full';
  } else {
    stockBadge.innerText = isService ? `พร้อมรับงาน (${stockCount} ${unit})` : `พร้อมส่ง (${stockCount})`;
    stockBadge.className = 'bg-mist border border-hairline text-appleBlue text-xs font-semibold px-2.5 py-0.5 rounded-full';
  }

  renderGalleryThumbnails();

  const specsContainer = document.getElementById('modal-specs');
  if (specsContainer) {
    const specsList = Array.isArray(p.specs) && p.specs.length > 0 ? p.specs : ['รับประกันความปลอดภัย 100%', 'จัดส่งรวดเร็วอัตโนมัติ'];
    specsContainer.innerHTML = specsList.map(item => `
      <div class="flex items-center gap-2">
        <span class="text-appleBlue font-bold">✓</span>
        <span>${escapeHtml(item)}</span>
      </div>
    `).join('');
  }

  const buyBtn = document.getElementById('modal-buy-btn');
  if (stockCount <= 0) {
    buyBtn.innerText = isService ? 'คิวเต็มชั่วคราว' : 'สินค้าหมด';
    buyBtn.disabled = true;
    buyBtn.className = 'bg-control text-steel px-6 py-2.5 rounded-button text-xs font-medium cursor-not-allowed';
    buyBtn.onclick = null;
  } else {
    buyBtn.innerText = 'สั่งซื้อทันที';
    buyBtn.disabled = false;
    buyBtn.className = 'apple-pricing-pill px-6 py-2.5 text-xs';
    buyBtn.onclick = () => {
      closeDetailModal();
      startCheckout(p.id);
    };
  }

  const modal = document.getElementById('product-detail-modal');
  modal.classList.remove('hidden');
  modal.classList.add('flex');
}

function renderGalleryThumbnails() {
  const strip = document.getElementById('modal-gallery-strip');
  const counter = document.getElementById('modal-img-counter');
  if (!strip) return;

  if (currentModalGallery.length <= 1) {
    strip.innerHTML = '';
    strip.classList.add('hidden');
    if (counter) counter.innerText = 'ภาพ 1 / 1';
    return;
  }

  strip.classList.remove('hidden');
  if (counter) counter.innerText = `ภาพ ${currentGalleryIdx + 1} / ${currentModalGallery.length}`;

  strip.innerHTML = currentModalGallery.map((imgUrl, idx) => `
    <button type="button" aria-label="ดูภาพที่ ${idx + 1}" onclick="switchGalleryImage(${idx})" class="w-16 h-12 rounded-links overflow-hidden bg-mist border ${idx === currentGalleryIdx ? 'border-ink ring-1 ring-ink' : 'border-hairline'} shrink-0">
      <img src="${escapeHtml(imgUrl)}" alt="Thumb" class="w-full h-full object-cover" onerror="this.onerror=null;this.src='${FALLBACK_IMG}'">
    </button>
  `).join('');
}

function switchGalleryImage(idx) {
  if (idx < 0 || idx >= currentModalGallery.length) return;
  currentGalleryIdx = idx;
  const modalImg = document.getElementById('modal-img');
  if (modalImg) modalImg.src = currentModalGallery[idx] || FALLBACK_IMG;
  renderGalleryThumbnails();
}

function closeDetailModal() {
  const modal = document.getElementById('product-detail-modal');
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }
}

// ==========================================
// 5. CHECKOUT & ATOMIC STOCK CLAIM ENGINE
// ==========================================

/**
 * ✅ FIXED: ทุกสินค้า (ทั้งไอดีและบริการ) จะพาไปหน้า front/product.html?id=...
 * เดิม: สินค้าไอดีจะไปหน้า checkout ใน index.html (ไม่เปลี่ยนหน้า)
 */
function startCheckout(productId) {
  const product = PRODUCTS.find(p => String(p.id) === String(productId));
  if (!product) {
    triggerToast('ไม่พบสินค้าที่ต้องการ');
    return;
  }
  if (getEffectiveStock(product) <= 0) {
    triggerToast('สินค้าหมดหรือคิวเต็มชั่วคราว');
    return;
  }
  // Redirect ไปหน้า product รายละเอียดสินค้าเสมอ
  window.location.href = `front/product.html?id=${encodeURIComponent(product.id)}`;
}

function adjustServiceQty(delta) {
  if (!selectedProduct || !isServiceProduct(selectedProduct)) return;
  const minQty = minQtyOf(selectedProduct, CATS);
  const maxQty = getEffectiveStock(selectedProduct);
  const nextQty = serviceOrderQty + delta;
  if (nextQty < minQty) {
    triggerToast(`รายการนี้กำหนดขั้นต่ำไว้ที่ ${minQty} ${unitOf(selectedProduct, CATS)}`);
    return;
  }
  if (nextQty > maxQty) {
    triggerToast(`คิวพร้อมให้บริการสูงสุด ${maxQty} ${unitOf(selectedProduct, CATS)}`);
    return;
  }
  serviceOrderQty = nextQty;
  document.getElementById('checkout-service-qty').innerText = serviceOrderQty;
  updateCheckoutTotal();
}

function getSubtotalPrice() {
  if (!selectedProduct) return 0;
  const unitPrice = getEffectivePrice(selectedProduct);
  const qty = isServiceProduct(selectedProduct) ? serviceOrderQty : 1;
  return unitPrice * qty;
}

function updateCheckoutTotal() {
  if (!selectedProduct) return;
  const baseSubtotal = getSubtotalPrice();
  discountAmount = promoDiscountFn ? Math.min(promoDiscountFn(baseSubtotal), baseSubtotal) : 0;
  const finalPrice = baseSubtotal - discountAmount;

  const discountRow = document.getElementById('discount-row');
  discountRow.classList.toggle('hidden', !discountAmount);
  discountRow.classList.toggle('flex', discountAmount > 0);
  document.getElementById('checkout-discount').innerText = `-฿${discountAmount.toFixed(2)}`;
  document.getElementById('checkout-base-price').innerText = `฿${baseSubtotal.toFixed(2)}`;
  document.getElementById('checkout-final-price').innerText = `฿${finalPrice.toFixed(2)}`;
  document.getElementById('qr-amount-label').innerText = `฿${finalPrice.toFixed(2)}`;
  document.getElementById('promptpay-sum-label').innerText = `฿${finalPrice.toFixed(2)}`;
  document.getElementById('voucher-exact-amount').innerText = `฿${finalPrice.toFixed(2)}`;
  
  // ป้องกัน Error: ตรวจสอบว่ามี element nav-cart-text หรือไม่ ก่อนเปลี่ยนค่า
  const cartText = document.getElementById('nav-cart-text');
  if (cartText) cartText.innerText = `฿${finalPrice.toFixed(2)}`;
}

async function applyPromoCode() {
  const now = Date.now();

  // ✅ FIXED: reset attempts เมื่อ lockout หมดอายุ
  if (now < promoLockoutExpiry) {
    const secLeft = Math.ceil((promoLockoutExpiry - now) / 1000);
    triggerToast(`โปรดรอ ${secLeft} วินาที ก่อนลองใส่โค้ดส่วนลดอีกครั้ง`);
    return;
  }
  if (promoLockoutExpiry && now >= promoLockoutExpiry) {
    promoFailedAttempts = 0;
    promoLockoutExpiry = 0;
    const warning = document.getElementById('promo-rate-warning');
    if (warning) warning.classList.add('hidden');
  }

  const input = document.getElementById('promo-input');
  const code = input.value.trim().toUpperCase();
  if (!selectedProduct) return;

  if (!code) {
    promoDiscountFn = null;
    appliedPromoCode = null;
    updateCheckoutTotal();
    return;
  }

  if (code === appliedPromoCode) {
    triggerToast('ใช้โค้ดนี้อยู่แล้ว');
    return;
  }

  let promoData = null;

  if (db) {
    try {
      const pSnap = await getDoc(doc(db, 'promo_codes', code));
      if (pSnap.exists()) promoData = pSnap.data();
    } catch (err) {
      console.warn('Fetch promo fallback:', err);
    }
  }

  if (!promoData) {
    if (code === 'TACTICAL') promoData = { code: 'TACTICAL', type: 'fixed', value: 50 };
    else if (code === 'ARENA10') promoData = { code: 'ARENA10', type: 'percent', value: 10 };
    else if (code === 'MOSZXLL') promoData = { code: 'MOSZXLL', type: 'fixed', value: 100 };
    else if (code === 'LUCKY20') promoData = { code: 'LUCKY20', type: 'random_percent', minValue: 10, maxValue: 20 };
  }

  if (!promoData) {
    promoFailedAttempts++;
    if (promoFailedAttempts >= 5) {
      promoLockoutExpiry = Date.now() + 60000;
      triggerToast('กรอกโค้ดผิดเกิน 5 ครั้ง ระบบล็อกการใช้งานโค้ด 60 วินาที');
      const warning = document.getElementById('promo-rate-warning');
      if (warning) warning.classList.remove('hidden');
      setTimeout(() => {
        const w = document.getElementById('promo-rate-warning');
        if (w) w.classList.add('hidden');
        promoFailedAttempts = 0;
        promoLockoutExpiry = 0;
      }, 60000);
    } else {
      triggerToast(`โค้ดไม่ถูกต้อง (เหลือโอกาสลองอีก ${5 - promoFailedAttempts} ครั้ง)`);
    }
    return;
  }

  if (promoData.maxTotalUses && Number(promoData.maxTotalUses) > 0) {
    const used = Number(promoData.usedCount) || 0;
    if (used >= Number(promoData.maxTotalUses)) {
      triggerToast('โค้ดนี้ถูกใช้งานครบตามจำนวนโควต้าแล้ว');
      return;
    }
  }

  promoFailedAttempts = 0;
  const randBetween = (lo, hi) => Math.floor(Math.random() * (hi - lo + 1)) + lo;
  let discountFn = null;
  if (promoData.type === 'fixed') {
    const amt = Number(promoData.value) || 0;
    discountFn = () => amt;
  } else if (promoData.type === 'percent') {
    const pct = Number(promoData.value) || 0;
    discountFn = (base) => Math.round(base * (pct / 100));
  } else if (promoData.type === 'random_percent') {
    const pct = randBetween(Number(promoData.minValue) || 10, Number(promoData.maxValue) || 20);
    discountFn = (base) => Math.round(base * (pct / 100));
  } else if (promoData.type === 'random_fixed') {
    const amt = randBetween(Number(promoData.minValue) || 10, Number(promoData.maxValue) || 50);
    discountFn = () => amt;
  }

  if (!discountFn) {
    triggerToast('โค้ดนี้ไม่สามารถใช้งานได้');
    return;
  }

  promoDiscountFn = discountFn;
  appliedPromoCode = code;
  updateCheckoutTotal();
  triggerToast(`ใช้โค้ด ${code} สำเร็จ! ลด ฿${discountAmount.toFixed(2)}`);
}

function switchPaymentTab(tab) {
  currentPaymentMethod = tab;
  const pTab = document.getElementById('payment-promptpay-panel');
  const vTab = document.getElementById('payment-truemoney-panel');
  const btnP = document.getElementById('btn-tab-promptpay');
  const btnV = document.getElementById('btn-tab-truemoney');

  if (!pTab || !vTab || !btnP || !btnV) return;

  if (tab === 'promptpay') {
    pTab.classList.remove('hidden');
    pTab.classList.add('flex');
    vTab.classList.add('hidden');
    vTab.classList.remove('flex');
    btnP.className = 'flex-1 py-1.5 rounded-button text-xs font-medium flex items-center justify-center gap-2 transition-all bg-gallery text-ink';
    btnV.className = 'flex-1 py-1.5 rounded-button text-xs font-medium flex items-center justify-center gap-2 transition-all text-slate hover:text-ink';
  } else {
    vTab.classList.remove('hidden');
    vTab.classList.add('flex');
    pTab.classList.add('hidden');
    pTab.classList.remove('flex');
    btnV.className = 'flex-1 py-1.5 rounded-button text-xs font-medium flex items-center justify-center gap-2 transition-all bg-gallery text-ink';
    btnP.className = 'flex-1 py-1.5 rounded-button text-xs font-medium flex items-center justify-center gap-2 transition-all text-slate hover:text-ink';
  }
}

function isTrueMoneyVoucher(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === 'gift.truemoney.com';
  } catch {
    return false;
  }
}

function setSubmitButtonsDisabled(disabled) {
  ['btn-submit-promptpay', 'btn-submit-truemoney'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.disabled = disabled;
  });
}

// The browser never verifies payment or hands out credentials: it only files a pending_payment order.
// The backend/admin confirms the money, then sets status "completed" and accountDelivered.
async function submitOrder() {
  const product = selectedProduct;
  if (isSubmitting || !product) return;
  if (!currentUser || !db) {
    triggerToast('กรุณาเข้าสู่ระบบก่อนสั่งซื้อ');
    return;
  }

  const isService = isServiceProduct(product);
  const serviceTarget = document.getElementById('checkout-service-target')?.value.trim() || '';
  if (isService && !serviceTarget) {
    triggerToast('กรุณากรอกชื่อในเกม / UID หรือช่องทางติดต่อเพื่อนัดรับของ');
    document.getElementById('checkout-service-target')?.focus();
    return;
  }
  if (isService && serviceOrderQty < minQtyOf(product, CATS)) {
    triggerToast(`รายการนี้สั่งขั้นต่ำ ${minQtyOf(product, CATS)} ${unitOf(product, CATS)}`);
    return;
  }

  let paymentProof;
  if (currentPaymentMethod === 'truemoney') {
    paymentProof = document.getElementById('voucher-url-input').value.trim();
    if (!isTrueMoneyVoucher(paymentProof)) {
      triggerToast('กรุณากรอกลิงก์ซองของขวัญ TrueMoney ให้ถูกต้อง (https://gift.truemoney.com/...)');
      return;
    }
  } else {
    if (document.getElementById('qr-img').classList.contains('hidden')) {
      triggerToast('ร้านยังไม่เปิดรับชำระผ่านพร้อมเพย์ กรุณาเลือกช่องทางอื่น');
      return;
    }
    paymentProof = document.getElementById('payment-ref-input').value.trim();
    if (!paymentProof) {
      triggerToast('กรุณากรอกเวลาที่โอนหรือเลขอ้างอิงรายการ');
      document.getElementById('payment-ref-input').focus();
      return;
    }
  }

  isSubmitting = true;
  setSubmitButtonsDisabled(true);
  try {
    const orderRef = doc(collection(db, 'orders'));
    const orderId = `ORD-${orderRef.id.slice(0, 8).toUpperCase()}`;
    const qty = isService ? serviceOrderQty : 1;
    const unit = unitOf(product, CATS);
    const finalPrice = getSubtotalPrice() - discountAmount;

    await setDoc(orderRef, {
      orderNumber: orderId,
      orderId,
      productId: product.id,
      productName: product.name,
      productType: isService ? 'service' : 'account',
      quantity: qty,
      unit: isService ? unit : 'ไอดี',
      unitPrice: getEffectivePrice(product),
      subtotal: getSubtotalPrice(),
      buyerEmail: isService ? serviceTarget : (currentUser.email || ''),
      amount: finalPrice,
      finalPrice,
      discount: discountAmount,
      promoCode: appliedPromoCode,
      paymentMethod: currentPaymentMethod,
      paymentProof,
      status: 'pending_payment',
      userEmail: currentUser.email || '',
      userId: currentUser.uid,
      createdAt: serverTimestamp()
    });

    document.getElementById('voucher-url-input').value = '';
    document.getElementById('payment-ref-input').value = '';
    document.getElementById('success-product-name').innerText = product.name;
    document.getElementById('success-order-id').innerText = `ORDER ID: #${orderId}`;
    document.getElementById('success-service-box').classList.toggle('hidden', !isService);
    if (isService) {
      document.getElementById('srv-target-display').innerText = serviceTarget;
      document.getElementById('srv-qty-display').innerText = `${qty} ${unit}`;
    }
    navigateTo('success');
  } catch (err) {
    console.error('Submit order failed:', err);
    triggerToast('ส่งคำสั่งซื้อไม่สำเร็จ กรุณาลองอีกครั้ง');
  } finally {
    isSubmitting = false;
    setSubmitButtonsDisabled(false);
  }
}

function copyTextToClipboard(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text);
    } else {
      const temp = document.createElement("textarea");
      temp.value = text;
      document.body.appendChild(temp);
      temp.select();
      document.execCommand("copy");
      document.body.removeChild(temp);
    }
  } catch (err) {
    console.warn("Copy error:", err);
  }
}

// ==========================================
// 6. CUSTOMER "MY ORDERS" HISTORY (LIVE FROM FIRESTORE)
// ==========================================
function getMergedOrders() {
  return [...cloudOrdersCache].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

function findOrder(key) {
  return getMergedOrders().find(o => (o.orderNumber || o.orderId) === key) || {};
}

// Live listener so a pending order flips to "completed" (with credentials) without a reload.
function syncUserCloudOrders(uid) {
  if (unsubOrders) unsubOrders();
  unsubOrders = null;
  if (!db || !uid) return;
  unsubOrders = onSnapshot(query(collection(db, "orders"), where("userId", "==", uid)), (snap) => {
    cloudOrdersCache = snap.docs.map(d => {
      const data = d.data();
      return {
        ...data,
        createdAt: data.createdAt?.toDate ? data.createdAt.toDate().toISOString() : data.createdAt
      };
    });
    updateMyOrdersBadge();
  }, (err) => console.warn("Cloud orders sync skipped:", err));
}

function updateMyOrdersBadge() {
  const list = getMergedOrders();
  const badge = document.getElementById('nav-order-badge');
  if (badge) {
    if (list.length > 0) {
      badge.innerText = list.length;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }
}

const ORDER_STATUS_LABEL = {
  pending_payment: 'รอตรวจสอบการชำระเงิน',
  processing: 'อยู่ในคิวงาน',
  cancelled: 'ยกเลิกแล้ว'
};

function openMyOrdersModal() {
  const modal = document.getElementById('my-orders-modal');
  const container = document.getElementById('my-orders-list');
  const empty = document.getElementById('my-orders-empty');
  if (!modal || !container || !empty) return;

  const orders = getMergedOrders();

  if (orders.length === 0) {
    container.innerHTML = '';
    empty.classList.remove('hidden');
    empty.classList.add('flex');
  } else {
    empty.classList.add('hidden');
    empty.classList.remove('flex');
    container.innerHTML = orders.map((ord, idx) => {
      const orderNo = escapeHtml(ord.orderNumber || ord.orderId || '-');
      const keyArg = escapeHtml(JSON.stringify(String(ord.orderNumber || ord.orderId || '')));
      const priceVal = Number(ord.amount ?? ord.finalPrice ?? 0).toFixed(2);
      const timeStr = ord.createdAt ? escapeHtml(new Date(ord.createdAt).toLocaleString('th-TH')) : '';
      const isSrv = ord.productType === 'service';
      const isDone = ord.status === 'completed';
      const statusLabel = escapeHtml(isDone ? (isSrv ? 'รับงานแล้ว' : 'จัดส่งสำเร็จ') : (ORDER_STATUS_LABEL[ord.status] || ord.status || '-'));
      const userVal = escapeHtml(ord.accountDelivered?.username || '-');
      const target = escapeHtml(ord.buyerEmail || '-');
      const prodName = escapeHtml(ord.productName || '-');
      const srvQty = escapeHtml(ord.quantity || 1);
      const srvUnit = escapeHtml(ord.unit || 'กอง');

      // Credentials are only ever shown once the backend has marked the order completed.
      const detail = isSrv ? `
            <div class="bg-mist p-3 rounded-nav border border-hairline text-xs text-ink">
              ผู้รับบริการ: <span class="font-mono font-semibold">${target}</span> • จำนวน: <strong>${srvQty} ${srvUnit}</strong>
            </div>
          ` : (isDone && ord.accountDelivered?.username ? `
            <div class="bg-mist p-3 rounded-nav border border-hairline font-mono text-xs space-y-1.5">
              <div class="flex items-center justify-between">
                <span class="text-slate text-[10px]">USERNAME:</span>
                <span class="text-ink font-semibold select-all">${userVal}</span>
              </div>
              <div class="flex items-center justify-between">
                <span class="text-slate text-[10px]">PASSWORD:</span>
                <span id="order-pw-${idx}" class="text-slate font-semibold select-all">••••••••••••</span>
              </div>
            </div>
            <div class="flex items-center justify-end gap-2 pt-1">
              <button type="button" onclick="toggleOrderPassword(${keyArg}, ${idx})" class="apple-explore-pill px-3 py-1 text-[11px]">
                <span id="order-btn-lbl-${idx}">แสดงรหัส</span>
              </button>
              <button type="button" onclick="copySpecificCredentials(${keyArg})" class="apple-pricing-pill px-3 py-1 text-[11px]">
                คัดลอกไอดี
              </button>
            </div>
          ` : `
            <div class="bg-mist p-3 rounded-nav border border-hairline text-xs text-slate">
              ไอดีจะแสดงที่นี่เมื่อทีมงานยืนยันการชำระเงินแล้ว
            </div>
          `);

      return `
        <div class="apple-card p-4 sm:p-5 border border-hairline space-y-3 bg-gallery">
          <div class="flex justify-between items-start gap-2 border-b border-hairline pb-2.5">
            <div>
              <span class="text-[10px] font-mono text-appleBlue font-medium">#${orderNo}</span>
              <h4 class="font-semibold text-ink text-sm">${prodName}</h4>
              ${timeStr ? `<span class="text-[10px] text-slate">${timeStr}</span>` : ''}
            </div>
            <div class="text-right">
              <span class="text-sm font-semibold text-ink">฿${priceVal}</span>
              <span class="block text-[10px] text-slate font-medium">${statusLabel}</span>
            </div>
          </div>
          ${detail}
        </div>
      `;
    }).join('');
  }

  modal.classList.remove('hidden');
  modal.classList.add('flex');
}

function closeMyOrdersModal() {
  const modal = document.getElementById('my-orders-modal');
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }
}

function toggleOrderPassword(key, idx) {
  const realPw = String(findOrder(key).accountDelivered?.password || '-');
  const el = document.getElementById(`order-pw-${idx}`);
  const lbl = document.getElementById(`order-btn-lbl-${idx}`);
  if (!el || !lbl) return;

  if (el.dataset.revealed === 'true') {
    el.innerText = '••••••••••••';
    el.dataset.revealed = 'false';
    lbl.innerText = 'แสดงรหัส';
  } else {
    el.innerText = realPw;
    el.dataset.revealed = 'true';
    lbl.innerText = 'ซ่อนรหัส';
  }
}

function copySpecificCredentials(key) {
  const acc = findOrder(key).accountDelivered;
  if (!acc?.username) return;
  copyTextToClipboard(`User: ${acc.username}\nPass: ${acc.password}`);
  triggerToast('คัดลอกข้อมูลไอดีนี้เรียบร้อยแล้ว!');
}

// ==========================================
// 7. NAVIGATION VIEW CONTROLLER
// ==========================================
function navigateTo(viewName) {
  const storeView = document.getElementById('view-store');
  const checkoutView = document.getElementById('view-checkout');
  const successView = document.getElementById('view-success');

  if (storeView) storeView.classList.add('hidden');
  if (checkoutView) checkoutView.classList.add('hidden');
  if (successView) {
    successView.classList.add('hidden');
    successView.classList.remove('flex');
  }

  if (viewName === 'store' && storeView) {
    storeView.classList.remove('hidden');
    selectedProduct = null;
    discountAmount = 0;
    promoDiscountFn = null;
    appliedPromoCode = null;
    const cartText = document.getElementById('nav-cart-text');
    if (cartText) cartText.innerText = '฿0.00';
  } else if (viewName === 'checkout' && checkoutView) {
    checkoutView.classList.remove('hidden');
  } else if (viewName === 'success' && successView) {
    successView.classList.remove('hidden');
    successView.classList.add('flex');
    const cartText = document.getElementById('nav-cart-text');
    if (cartText) cartText.innerText = '฿0.00';
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ==========================================
// 8. ATTACH TO WINDOW & INITIALIZE
// ==========================================
Object.assign(window, {
  navigateTo,
  filterCategory,
  triggerToast,
  handleSearch,
  handleSmartFilterChange,
  setStockFilter,
  handleSortChange,
  clearSearchAndFilters,
  scrollToCatalog,
  openDetailModal,
  closeDetailModal,
  switchGalleryImage,
  startCheckout,
  adjustServiceQty,
  applyPromoCode,
  switchPaymentTab,
  submitOrder,
  handleSignOut,
  openMyOrdersModal,
  closeMyOrdersModal,
  toggleOrderPassword,
  copySpecificCredentials
});

window.addEventListener('DOMContentLoaded', () => {
  renderSkeletonGrid();
  updateMyOrdersBadge();
  initAuthListener();
  watchCategories((list) => {
    CATS = list;
    CATEGORIES = [{ id: 'all', name: 'ทั้งหมด' }, ...list];
    renderCategoryOptions();
    renderProducts();
  });
  initFirebaseProductsListener();
  initSettingsListener();

  ['my-orders-modal', 'product-detail-modal'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('click', (e) => {
        if (e.target === el) {
          id === 'my-orders-modal' ? closeMyOrdersModal() : closeDetailModal();
        }
      });
    }
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeMyOrdersModal();
      closeDetailModal();
    }
  });
});