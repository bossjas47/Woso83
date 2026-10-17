import { db, auth } from "../firebase-config.js";
import { 
  collection, 
  doc, 
  getDocs,
  query,
  where,
  onSnapshot 
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { 
  onAuthStateChanged, 
  signOut 
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { productCardHtml } from "./card.js";
import { categoryCardsHtml, watchCategories, loadCategories, isServiceProduct as isServiceProductIn, minQtyOf, unitOf, KIND_LABEL } from "./categories.js";

const FALLBACK_IMG = 'https://placehold.co/800x500/f5f5f7/86868b?text=Arena+Breakout';

// No demo catalog: an empty shop must look empty, not sell invented products.
const DEFAULT_PRODUCTS = [];

let CATS = [];
let CATEGORIES = [{ id: 'all', name: 'ทั้งหมด' }];

let PRODUCTS = DEFAULT_PRODUCTS.map(p => ({ ...p }));
let currentCategory = 'all';
let searchQuery = '';
let smartFilter = 'all'; // 'all' | 'instock' | 'under200' | '200to500' | 'over500'
let sortOrder = 'default';
let globalKoenLabel = 'Koen';
let toastTimeout = null;
let currentModalGallery = [];
let currentGalleryIdx = 0;
let cloudOrdersCache = [];

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

function updateFirebaseStatus(isOnline, message) {
  const dot = document.getElementById('firebase-status-dot');
  const text = document.getElementById('firebase-status-text');
  if (dot && text) {
    dot.className = isOnline 
      ? 'w-1.5 h-1.5 rounded-full bg-emerald-500' 
      : 'w-1.5 h-1.5 rounded-full bg-amber-500';
    text.innerText = message;
  }
}

// ==========================================
// 1. INITIALIZATION & SKELETON LOADING
// ==========================================
function syncCategoryFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const catParam = params.get('cat');
  currentCategory = catParam || 'all';
}

function renderSkeletonGrid() {
  const grid = document.getElementById('product-grid');
  if (!grid) return;
  grid.innerHTML = Array.from({ length: 6 }).map(() => `
    <div class="apple-card p-6 flex flex-col h-full animate-pulse">
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

window.addEventListener('DOMContentLoaded', () => {
  syncCategoryFromUrl();
  renderSkeletonGrid();
  updateMyOrdersBadge();
  watchCategories((list) => {
    CATS = list;
    CATEGORIES = [{ id: 'all', name: 'ทั้งหมด' }, ...list];
    renderCategoryOptions();
    renderProducts();
  });
  initAuthListener();
  initFirebaseProductsListener();
  initSettingsListener();

  window.addEventListener('popstate', () => {
    syncCategoryFromUrl();
    renderCategoryOptions();
    renderProducts();
  });

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

function initFirebaseProductsListener() {
  if (!db) {
    updateFirebaseStatus(false, "Firebase: โหมดออฟไลน์");
    renderCategoryOptions();
    renderProducts();
    return;
  }
  try {
    onSnapshot(collection(db, "products"), (snapshot) => {
      if (!snapshot.empty) {
        PRODUCTS = snapshot.docs.map(docSnap => {
          const data = docSnap.data() || {};
          const primaryImg = data.image || FALLBACK_IMG;
          return {
            id: docSnap.id,
            ...data,
            name: String(data.name || 'ไม่มีชื่อสินค้า'),
            category: String(data.category || 'all'),
            price: getEffectivePrice(data),
            stock: getEffectiveStock(data),
            image: primaryImg,
            gallery: Array.isArray(data.gallery) && data.gallery.length > 0 ? data.gallery.filter(Boolean) : [primaryImg],
            tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
            specs: Array.isArray(data.specs) ? data.specs.map(String) : []
          };
        });
        updateFirebaseStatus(true, `Firebase: ${PRODUCTS.length} รายการ`);
      } else {
        PRODUCTS = DEFAULT_PRODUCTS.map(p => ({ ...p }));
        updateFirebaseStatus(true, "Firebase: ข้อมูลเริ่มต้น");
      }
      renderCategoryOptions();
      renderProducts();
    }, (err) => {
      console.warn("Firestore products fallback:", err);
      PRODUCTS = DEFAULT_PRODUCTS.map(p => ({ ...p }));
      updateFirebaseStatus(false, "Firebase: โหมดออฟไลน์");
      renderCategoryOptions();
      renderProducts();
    });
  } catch (e) {
    PRODUCTS = DEFAULT_PRODUCTS.map(p => ({ ...p }));
    updateFirebaseStatus(false, "Firebase: โหมดออฟไลน์");
    renderCategoryOptions();
    renderProducts();
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
      const singleItem = `
        <span class="mx-6 inline-flex items-center gap-2 text-ink whitespace-nowrap shrink-0">
          <span class="text-launchOrange font-semibold whitespace-nowrap shrink-0">ใหม่</span>
          ${safeMarquee}
        </span>
        <span class="text-hairline shrink-0">•</span>
        <span class="mx-6 text-appleBlue font-medium whitespace-nowrap shrink-0">โค้ดส่วนลด: TACTICAL ลด 50 บาท | ARENA10 ลด 10%</span>
        <span class="text-hairline shrink-0">•</span>
      `;
      track.innerHTML = singleItem + singleItem;
    }
  }

  if (data.ribbonText) {
    const ribbon = document.getElementById('apple-promo-ribbon');
    const rText = document.getElementById('ribbon-main-text');
    const rLink = document.getElementById('ribbon-link');
    const rLinkText = document.getElementById('ribbon-link-text');
    if (ribbon) ribbon.classList.remove('hidden');
    if (rText) rText.innerText = data.ribbonText;
    if (rLink && data.ribbonLinkUrl) rLink.href = data.ribbonLinkUrl;
    if (rLinkText && data.ribbonLinkText) rLinkText.innerText = data.ribbonLinkText;
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

// ==========================================
// 2. UNIFIED COMPACT FILTERING
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

  const url = new URL(window.location);
  if (currentCategory === 'all') {
    url.searchParams.delete('cat');
  } else {
    url.searchParams.set('cat', currentCategory);
  }
  window.history.pushState({}, '', url);

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

// Backward-compatible alias
function setStockFilter(val) {
  handleSmartFilterChange(val === 'instock' ? 'instock' : 'all');
}

function handleSortChange(val) {
  sortOrder = val || 'default';
  renderProducts();
}

function clearSearchAndFilters() {
  searchQuery = '';
  currentCategory = 'all';
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

  const url = new URL(window.location);
  url.searchParams.delete('cat');
  window.history.pushState({}, '', url);

  renderProducts();
}

// ==========================================
// 3. RENDER PRODUCTS & LIVE COUNTER
// ==========================================
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
      matchSmart = stockCount > 0 && price >= 200 && price <= 500;
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
    countLabel.innerText = `แสดง ${filtered.length} รายการ (พร้อมส่ง ${readyCount})`;
  }

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
// 4. QUICK VIEW DETAIL MODAL & NAVIGATION
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
    const specsList = Array.isArray(p.specs) && p.specs.length > 0 ? p.specs : [];
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
    buyBtn.innerText = 'สั่งซื้อ';
    buyBtn.disabled = false;
    buyBtn.className = 'apple-pricing-pill px-6 py-2.5 text-xs';
    buyBtn.onclick = () => {
      closeDetailModal();
      goToProduct(p.id, true);
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
    <button type="button" onclick="switchGalleryImage(${idx})" class="w-16 h-12 rounded-xl overflow-hidden bg-mist border ${idx === currentGalleryIdx ? 'border-pricingBlue ring-1 ring-pricingBlue' : 'border-hairline'} shrink-0">
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

function goToProduct(productId, buyNow = false) {
  if (!productId) return;
  const url = `product.html?id=${encodeURIComponent(productId)}${buyNow ? '&action=buy' : ''}`;
  window.location.href = url;
}

// ==========================================
// 5. AUTH & ORDERS (LOCAL + FIRESTORE MERGE)
// ==========================================
function getLocalOrders() {
  try {
    const raw = localStorage.getItem('tactical_my_orders');
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function getMergedOrders() {
  const local = getLocalOrders();
  const seen = new Set();
  const merged = [];

  [...local, ...cloudOrdersCache].forEach(ord => {
    const key = ord.orderNumber || ord.orderId || `${ord.productId}_${ord.createdAt}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(ord);
    }
  });
  return merged;
}

async function syncUserCloudOrders(uid) {
  if (!db || !uid) return;
  try {
    const q = query(collection(db, "orders"), where("userId", "==", uid));
    const snap = await getDocs(q);
    cloudOrdersCache = snap.docs.map(d => {
      const data = d.data();
      return {
        ...data,
        createdAt: data.createdAt?.toDate ? data.createdAt.toDate().toISOString() : data.createdAt
      };
    });
    updateMyOrdersBadge();
  } catch (err) {
    console.warn("Cloud orders sync skipped:", err);
  }
}

function updateMyOrdersBadge() {
  const badge = document.getElementById('nav-order-badge');
  if (!badge) return;
  const orders = getMergedOrders();
  if (orders.length > 0) {
    badge.innerText = orders.length;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

function openMyOrdersModal() {
  const modal = document.getElementById('my-orders-modal');
  const listEl = document.getElementById('my-orders-list');
  const emptyEl = document.getElementById('my-orders-empty');
  if (!modal || !listEl || !emptyEl) return;

  const orders = getMergedOrders();

  if (orders.length === 0) {
    listEl.innerHTML = '';
    emptyEl.classList.remove('hidden');
    emptyEl.classList.add('flex');
  } else {
    emptyEl.classList.add('hidden');
    emptyEl.classList.remove('flex');
    listEl.innerHTML = orders.map((ord, idx) => {
      const orderNo = escapeHtml(ord.orderNumber || ord.orderId || '-');
      const priceVal = Number(ord.amount ?? ord.finalPrice ?? 0).toFixed(2);
      const timeStr = ord.createdAt ? escapeHtml(new Date(ord.createdAt).toLocaleString('th-TH')) : '';
      const isSrv = ord.productType === 'service';
      const userVal = escapeHtml(ord.accountDelivered?.username || ord.credentials?.user || ord.buyerEmail || '-');
      const prodName = escapeHtml(ord.productName || '-');
      const srvQty = escapeHtml(ord.quantity || 1);
      const srvUnit = escapeHtml(ord.unit || 'กอง');

      return `
        <div class="apple-card p-4 sm:p-5 border border-hairline space-y-3 bg-gallery">
          <div class="flex justify-between items-start gap-2 border-b border-hairline pb-2.5">
            <div>
              <span class="text-[10px] font-mono text-appleBlue font-medium">#${orderNo}</span>
              <h4 class="font-semibold text-ink text-sm">${prodName}</h4>
              ${timeStr ? `<span class="text-[10px] text-slate">${timeStr}</span>` : ''}
            </div>
            <div class="text-right">
              <span class="text-sm font-semibold text-pricingBlue">฿${priceVal}</span>
              <span class="block text-[10px] text-emerald-600 font-medium">
                ${isSrv ? '<svg class="w-[1.1em] h-[1.1em] inline-block align-[-0.15em]" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z"/></svg> งานบริการ' : 'จัดส่งสำเร็จ'}
              </span>
            </div>
          </div>

          ${isSrv ? `
            <div class="bg-mist p-3 rounded-2xl border border-hairline text-xs text-ink">
              ผู้รับบริการ: <span class="font-mono font-semibold">${userVal}</span> • จำนวน: <strong>${srvQty}${srvUnit}</strong>
            </div>
          ` : `
            <div class="bg-mist p-3 rounded-2xl border border-hairline font-mono text-xs space-y-1.5">
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
              <button type="button" onclick="toggleOrderPassword(${idx})" class="apple-explore-pill px-3 py-1 text-[11px]">
                <span id="order-btn-lbl-${idx}">แสดงรหัส</span>
              </button>
              <button type="button" onclick="copySpecificCredentials(${idx})" class="apple-pricing-pill px-3 py-1 text-[11px]">
                คัดลอกไอดี
              </button>
            </div>
          `}
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

function toggleOrderPassword(idx) {
  const orders = getMergedOrders();
  const ord = orders[idx] || {};
  const realPw = String(ord.accountDelivered?.password || ord.credentials?.pass || ord.buyerPassword || '-');
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

function copySpecificCredentials(idx) {
  const orders = getMergedOrders();
  const ord = orders[idx] || {};
  const u = ord.accountDelivered?.username || ord.credentials?.user || ord.buyerEmail || '-';
  const p = ord.accountDelivered?.password || ord.credentials?.pass || ord.buyerPassword || '-';
  const text = `User: ${u}\nPass: ${p}`;

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
  } catch (_) {}
  triggerToast('คัดลอกข้อมูลไอดีนี้เรียบร้อยแล้ว!');
}

function initAuthListener() {
  if (!auth) return;
  try {
    onAuthStateChanged(auth, (user) => {
      const loggedOut = document.getElementById('auth-logged-out');
      const loggedIn = document.getElementById('auth-logged-in');
      const nameEl = document.getElementById('user-display-name');
      const initialEl = document.getElementById('user-avatar-initial');
      const mobileAuthText = document.getElementById('mobile-nav-auth-text');

      if (user) {
        if (loggedOut) loggedOut.classList.add('hidden');
        if (loggedIn) {
          loggedIn.classList.remove('hidden');
          loggedIn.classList.add('flex');
        }
        const name = user.displayName || user.email?.split('@')[0] || 'Agent';
        if (nameEl) nameEl.innerText = name;
        if (initialEl) initialEl.innerText = name.charAt(0).toUpperCase();
        if (mobileAuthText) mobileAuthText.innerText = name.length > 5 ? name.slice(0, 5) + '...' : name;
        syncUserCloudOrders(user.uid);
      } else {
        cloudOrdersCache = [];
        if (loggedIn) {
          loggedIn.classList.add('hidden');
          loggedIn.classList.remove('flex');
        }
        if (loggedOut) loggedOut.classList.remove('hidden');
        if (mobileAuthText) mobileAuthText.innerText = 'บัญชี';
        updateMyOrdersBadge();
      }
    });
  } catch (e) {
    console.warn("Auth listener fallback:", e);
  }
}

async function handleSignOut() {
  try {
    if (auth) await signOut(auth);
    triggerToast('ออกจากระบบเรียบร้อยแล้ว');
  } catch (e) {
    console.warn("Sign out error:", e);
    triggerToast('เกิดข้อผิดพลาดในการออกจากระบบ');
  }
}

Object.assign(window, {
  filterCategory,
  handleSearch,
  handleSmartFilterChange,
  setStockFilter,
  handleSortChange,
  clearSearchAndFilters,
  openDetailModal,
  closeDetailModal,
  switchGalleryImage,
  goToProduct,
  openMyOrdersModal,
  closeMyOrdersModal,
  toggleOrderPassword,
  copySpecificCredentials,
  handleSignOut,
  triggerToast
});
