// ASTRAPHEX HUB — Cloudflare Worker (server side of the shop). All routes take POST + the user's Firebase ID token.
//   POST /            (or /slip)   top-up slip check with EasySlip, credits the wallet           (any signed-in user)
//   POST /buy                      pay with wallet credit: price, promo, balance, stock in one transaction;
//                                  game IDs are delivered at once, services go to the queue      (any signed-in user)
//   POST /admin/user               change a user's login name, password, admin claim, disabled  (admin claim only)
//   POST /notify                   Discord message for a new order / top-up request ({kind:'test'} = admin only)
// Variables (Worker > Settings > Variables and Secrets):
//   SERVICE_ACCOUNT  secret  the Firebase service-account JSON, pasted as text
//   EASYSLIP_KEY     secret  EasySlip API key                         (only for automatic slip checks)
//   RECEIVER_MATCH   text    shop account name / digits on the slip    (only for automatic slip checks)
//   ALLOWED_ORIGIN   text    optional, your site origin, e.g. https://astraphex.panderx.xyz (default: any)
// The Discord webhook URL lives in Firestore system_private/secrets.discordWebhook (admin > settings).
const MIN = 20, MAX = 50000, THROTTLE_MS = 10000, MAX_SLIP_AGE_MS = 3 * 864e5;
const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const SHOP = 'ASTRAPHEX HUB';

const enc = new TextEncoder();
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const norm = (v) => String(v ?? '').toLowerCase().replace(/[\s\-]/g, '');
const fail = (code, message) => Object.assign(new Error(message), { code });
const r2 = (x) => Math.round(Number(x) * 100) / 100;
const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : 0; };
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);

let jwksCache = { at: 0, keys: [] };
let tokenCache = { at: 0, token: '' };

// ---------- auth ----------
async function verifyIdToken(token, projectId, fetchFn, now) {
  try { return await verifyIdTokenInner(token, projectId, fetchFn, now); }
  catch (e) { throw typeof e.code === 'string' ? e : fail('unauthenticated', 'โทเคนไม่ถูกต้อง'); }
}
async function verifyIdTokenInner(token, projectId, fetchFn, now) {
  const [h, p, s] = String(token).split('.');
  if (!h || !p || !s) throw fail('unauthenticated', 'โทเคนไม่ถูกต้อง');
  const head = JSON.parse(new TextDecoder().decode(unb64u(h)));
  const claims = JSON.parse(new TextDecoder().decode(unb64u(p)));
  if (head.alg !== 'RS256') throw fail('unauthenticated', 'โทเคนไม่ถูกต้อง');
  if (now - jwksCache.at > 36e5 || !jwksCache.keys.some((k) => k.kid === head.kid)) {
    jwksCache = { at: now, keys: (await (await fetchFn(JWKS_URL)).json()).keys || [] };
  }
  const jwk = jwksCache.keys.find((k) => k.kid === head.kid);
  if (!jwk) throw fail('unauthenticated', 'โทเคนไม่ถูกต้อง');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, unb64u(s), enc.encode(`${h}.${p}`));
  const sec = now / 1000;
  if (!ok || claims.aud !== projectId || claims.iss !== `https://securetoken.google.com/${projectId}`
      || !(claims.exp > sec) || !(claims.iat <= sec + 60) || !claims.sub) throw fail('unauthenticated', 'กรุณาเข้าสู่ระบบใหม่');
  return { uid: claims.sub, email: claims.email || '', name: claims.name || '', admin: claims.admin === true };
}

async function accessToken(sa, fetchFn, now) {
  if (tokenCache.token && now - tokenCache.at < 3000e3) return tokenCache.token;
  const iat = Math.floor(now / 1000);
  const head = b64u(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const body = b64u(enc.encode(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform', aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600 })));
  const der = unb64u(sa.private_key.replace(/-----[^-]+-----|\s/g, ''));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = b64u(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(`${head}.${body}`)));
  const res = await fetchFn('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${head}.${body}.${sig}`
  });
  const j = await res.json();
  if (!j.access_token) throw new Error('service account token failed');
  tokenCache = { at: now, token: j.access_token };
  return j.access_token;
}

// ---------- Firestore REST ----------
export function encodeValue(x) {
  if (x === null || x === undefined) return { nullValue: null };
  if (typeof x === 'boolean') return { booleanValue: x };
  if (typeof x === 'number') return Number.isInteger(x) ? { integerValue: String(x) } : { doubleValue: x };
  if (typeof x === 'string') return { stringValue: x };
  if (x instanceof Date) return { timestampValue: x.toISOString() };
  if (Array.isArray(x)) return { arrayValue: { values: x.map(encodeValue) } };
  return { mapValue: { fields: encodeFields(x) } };
}
export const encodeFields = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined).map(([k, v]) => [k, encodeValue(v)]));
export function decodeValue(v = {}) {
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decodeValue);
  if ('mapValue' in v) return decodeFields(v.mapValue.fields);
  return null;
}
export const decodeFields = (f = {}) => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, decodeValue(v)]));

function fsClient(projectId, token, fetchFn) {
  const root = `projects/${projectId}/databases/(default)/documents`;
  const base = `https://firestore.googleapis.com/v1/${root}`;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const post = async (url, body) => {
    const r = await fetchFn(url, { method: 'POST', headers, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (r.status === 409) throw fail('conflict', j.error?.status === 'ALREADY_EXISTS' ? 'already-exists' : 'aborted');
    if (r.status === 400 && /FAILED_PRECONDITION|NOT_FOUND/.test(JSON.stringify(j))) throw fail('precondition', 'precondition');
    if (r.status === 404) throw fail('precondition', 'not found');
    if (!r.ok) throw new Error(`firestore ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
    return j;
  };
  return {
    name: (path) => `${root}/${path}`,
    fields: encodeFields,
    async get(path, tx) {
      const r = await fetchFn(`${base}/${path}${tx ? `?transaction=${encodeURIComponent(tx)}` : ''}`, { headers });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error('firestore read ' + r.status);
      return decodeFields((await r.json()).fields);
    },
    async begin() { return (await post(`${base}:beginTransaction`, { options: { readWrite: {} } })).transaction; },
    async rollback(tx) { try { await post(`${base}:rollback`, { transaction: tx }); } catch (_) {} },
    /** where: [[field, op, value]] with op 'EQUAL'. Returns [{ id, data }]. */
    async query(parentPath, collectionId, where = [], { limit, tx } = {}) {
      const filters = where.map(([field, op, value]) => ({ fieldFilter: { field: { fieldPath: field }, op, value: encodeValue(value) } }));
      const structuredQuery = { from: [{ collectionId }], ...(filters.length ? { where: filters.length === 1 ? filters[0] : { compositeFilter: { op: 'AND', filters } } } : {}), ...(limit ? { limit } : {}) };
      const out = await post(`${base}${parentPath ? '/' + parentPath : ''}:runQuery`, { structuredQuery, ...(tx ? { transaction: tx } : {}) });
      return (Array.isArray(out) ? out : []).filter(x => x.document).map(x => ({ id: x.document.name.split('/').pop(), path: x.document.name.split('/documents/')[1], data: decodeFields(x.document.fields) }));
    },
    async commit(writes, tx) {
      try { await post(`${base}:commit`, { writes, ...(tx ? { transaction: tx } : {}) }); }
      catch (e) { if (e.code === 'conflict' && e.message === 'already-exists') throw fail('already-exists', 'สลิปนี้ถูกใช้แล้ว'); throw e; }
    }
  };
}
const stamp = (fieldPath) => ({ fieldPath, setToServerValue: 'REQUEST_TIME' });
const inc = (fieldPath, by) => ({ fieldPath, increment: encodeValue(by) });

// ---------- shared rules (mirror js/promo.js, js/topup.js, js/categories.js) ----------
export function bestTopupPromo(promos, amount) {
  let best = null, bonus = 0;
  for (const p of promos) {
    if (p.active === false || amount < num(p.minAmount)) continue;
    const b = p.type === 'percent' ? Math.floor(amount * num(p.value) / 100) : Math.floor(num(p.value));
    if (b > bonus) { bonus = b; best = p; }
  }
  return { promo: best, bonus };
}
export function evaluatePromo(promo, product, subtotal) {
  const value = num(promo?.value);
  if (!promo || promo.active === false || !['fixed', 'percent'].includes(promo.type) || !(value > 0)) return { ok: false, message: 'ไม่พบโค้ดส่วนลดนี้ หรือโค้ดหมดอายุ' };
  const quota = num(promo.maxTotalUses);
  if (quota > 0 && num(promo.usedCount) >= quota) return { ok: false, message: 'โค้ดนี้ถูกใช้ครบตามจำนวนแล้ว' };
  const scope = promo.appliesTo || 'all';
  if (scope === 'categories' && !(promo.categoryIds || []).includes(product.category)) return { ok: false, message: 'โค้ดนี้ใช้กับสินค้านี้ไม่ได้' };
  if (scope === 'products' && !(promo.productIds || []).includes(product.id)) return { ok: false, message: 'โค้ดนี้ใช้กับสินค้านี้ไม่ได้' };
  const raw = promo.type === 'percent' ? r2(subtotal * Math.min(value, 100) / 100) : value;
  return { ok: true, discount: Math.min(raw, subtotal) };
}
export function maskName(name) {
  const s = [...String(name || 'user')];
  if (s.length <= 2) return s[0] + '***';
  if (s.length <= 4) return s[0] + '***' + s[s.length - 1];
  return s.slice(0, 2).join('') + '***' + s.slice(-2).join('');
}
export function usernameToEmail(username) {
  const clean = String(username).trim().toLowerCase();
  if (clean.includes('@')) return clean;
  const ascii = Array.from(clean).map(c => { const code = c.charCodeAt(0); return (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 95 ? c : `u${code.toString(16)}`; }).join('');
  return `${ascii || 'agent'}@tactical.store`;
}
const randomId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 20);

// ---------- Discord ----------
async function discord(fs, fetchFn, embed) {
  const secrets = await fs.get('system_private/secrets').catch(() => null);
  const url = secrets?.discordWebhook;
  if (!/^https:\/\/(discord(app)?\.com)\/api\/webhooks\//.test(String(url || ''))) return false;
  const res = await fetchFn(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: SHOP, embeds: [{ color: 0x00e5ff, timestamp: new Date().toISOString(), ...embed }] }) });
  return res.ok;
}
const money = (x) => num(x).toLocaleString('en-US', { maximumFractionDigits: 2 });

// ---------- POST / : slip ----------
async function checkSlip({ fetchFn, key, receiver, payload, amount, now }) {
  const res = await fetchFn('https://api.easyslip.com/v2/verify/bank', {
    method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ payload })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success !== true) return { ok: false, message: body.error?.message || body.message || 'ตรวจสลิปไม่ผ่าน' };
  const d = body.data || {};
  const s = d.rawSlip || d;
  const got = Number(s.amount?.amount ?? s.amount);
  if (!s.transRef) return { ok: false, message: 'ไม่พบเลขอ้างอิงในสลิป' };
  if (!Number.isFinite(got) || Math.round(got * 100) !== Math.round(amount * 100)) return { ok: false, message: 'ยอดในสลิปไม่ตรงกับที่ระบุ' };
  if (!norm(JSON.stringify(s.receiver)).includes(norm(receiver))) return { ok: false, message: 'บัญชีผู้รับในสลิปไม่ตรงกับบัญชีของร้าน' };
  const at = Date.parse(s.date);
  if (Number.isFinite(at) && now - at > MAX_SLIP_AGE_MS) return { ok: false, message: 'สลิปเก่าเกินไป' };
  return { ok: true, transRef: String(s.transRef) };
}

async function routeSlip({ user, data, fs, env, fetchFn, now, later }) {
  const amount = Number(data.amount);
  const payload = String(data.payload || '');
  if (!Number.isFinite(amount) || amount < MIN || amount > MAX || Math.round(amount * 100) !== amount * 100) return [{ error: 'ยอดเงินไม่ถูกต้อง' }, 400];
  if (payload.length < 20 || payload.length > 2000) return [{ error: 'ไม่พบ QR ที่อ่านได้บนสลิป' }, 400];
  const settings = await fs.get('system/settings');
  if (!(settings && settings.slipAutoVerify === true) || !env.EASYSLIP_KEY || !env.RECEIVER_MATCH) return [{ status: 'manual' }];

  const attempt = await fs.get(`slip_attempts/${user.uid}`);
  if (attempt && now - attempt.at < THROTTLE_MS) return [{ status: 'rejected', message: 'ส่งสลิปถี่เกินไป รอสักครู่แล้วลองใหม่' }];
  await fs.commit([{ update: { name: fs.name(`slip_attempts/${user.uid}`), fields: fs.fields({ at: now }) } }]);

  const check = await checkSlip({ fetchFn, key: env.EASYSLIP_KEY, receiver: env.RECEIVER_MATCH, payload, amount, now });
  if (!check.ok) return [{ status: 'rejected', message: check.message }];

  const promos = (await fs.query('', 'topup_promos')).map(d => ({ id: d.id, ...d.data }));
  const { promo, bonus } = bestTopupPromo(promos, amount);
  const id = randomId();
  try {
    // One atomic commit: the slip reference can be used once (exists:false), the wallet is credited, the record is written.
    await fs.commit([
      { update: { name: fs.name(`slip_refs/${check.transRef}`), fields: fs.fields({ uid: user.uid, amount }) }, updateTransforms: [stamp('at')], currentDocument: { exists: false } },
      { update: { name: fs.name(`users/${user.uid}`) }, updateMask: { fieldPaths: [] }, updateTransforms: [{ fieldPath: 'walletBalance', increment: { doubleValue: amount + bonus } }, stamp('lastTopupAt')] },
      { update: { name: fs.name(`topup_transactions/${id}`), fields: fs.fields({ txnId: 'TOPUP-' + id.slice(0, 8).toUpperCase(), uid: user.uid, email: user.email, amount, bonusCredit: bonus, finalCredit: amount + bonus, ...(promo ? { promoId: promo.id } : {}), paymentMethod: 'promptpay', proofRef: check.transRef, status: 'completed', verifiedVia: 'easyslip' }) }, updateTransforms: [stamp('createdAt'), stamp('completedAt')] }
    ]);
  } catch (e) {
    if (e.code === 'already-exists') return [{ status: 'rejected', message: e.message }];
    throw e;
  }
  later(discord(fs, fetchFn, { title: 'เติมเงินอัตโนมัติสำเร็จ', description: `ผู้ใช้ ${user.name || user.email} เติม ฿${money(amount)} (+โบนัส ${money(bonus)})` }));
  return [{ status: 'completed', credit: amount + bonus }];
}

// ---------- POST /buy ----------
function validateBuy(d) {
  const quantity = Number(d.quantity);
  if (typeof d.productId !== 'string' || !/^[\w-]{1,128}$/.test(d.productId)) return 'ไม่พบสินค้า';
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100000) return 'จำนวนไม่ถูกต้อง';
  if (d.farmMode != null && !['with_id', 'self'].includes(d.farmMode)) return 'รูปแบบบริการไม่ถูกต้อง';
  if (d.promoCode != null && d.promoCode !== '' && !/^[A-Z0-9_-]{2,40}$/.test(String(d.promoCode))) return 'โค้ดส่วนลดไม่ถูกต้อง';
  for (const k of ['buyerEmail', 'buyerFacebook', 'buyerContact', 'playTime', 'gameEmail', 'gamePassword']) if (String(d[k] ?? '').length > 200) return 'ข้อมูลยาวเกินไป';
  return '';
}

async function buyOnce({ user, d, fs, now }) {
  const tx = await fs.begin();
  let committed = false;
  try {
    const [profile, product] = await Promise.all([fs.get(`users/${user.uid}`, tx), fs.get(`products/${d.productId}`, tx)]);
    if (profile?.status === 'suspended') return [{ error: 'บัญชีนี้ถูกระงับการใช้งาน' }, 403];
    if (!product) return [{ error: 'ไม่พบสินค้านี้' }, 404];
    product.id = d.productId;
    const cat = product.category ? await fs.get(`categories/${product.category}`, tx) : null;
    const isService = product.productType === 'service' || cat?.kind === 'service' || String(product.category || '').startsWith('service');
    const qty = d.quantity;
    const minQty = isService ? Math.max(1, Math.floor(num(product.serviceMin) || num(cat?.minQty) || 1)) : 1;
    if (qty < minQty) return [{ error: `สั่งขั้นต่ำ ${minQty}` }, 400];
    const modes = Array.isArray(product.farmModes) ? product.farmModes : [];
    const mode = modes.find(m => m.key === d.farmMode) || (modes.length ? modes[0] : null);
    const rate = mode ? num(mode.price) : isService ? (num(product.serviceRate) || num(product.price)) : num(product.price);
    if (!(rate > 0)) return [{ error: 'สินค้านี้ยังไม่ได้ตั้งราคา' }, 400];
    const self = isService && mode?.key === 'self';
    if (isService) {
      if (str(d.buyerFacebook).length < 2) return [{ error: 'กรุณากรอกชื่อหรือลิงก์ Facebook' }, 400];
      if (self && (!str(d.buyerContact) || !str(d.playTime))) return [{ error: 'กรุณากรอกชื่อในเกมและเวลาที่พร้อม' }, 400];
      if (!self && (!str(d.gameEmail).includes('@') || !String(d.gamePassword || ''))) return [{ error: 'กรุณากรอกอีเมลและรหัสผ่านบัญชีเกม' }, 400];
    } else if (!/^\S+@\S+\.\S+$/.test(str(d.buyerEmail))) return [{ error: 'กรุณากรอกอีเมลให้ถูกต้อง' }, 400];

    const subtotal = r2(qty * rate);
    let discount = 0, code = null;
    if (d.promoCode) {
      code = String(d.promoCode);
      const promo = await fs.get(`promo_codes/${code}`, tx);
      const r = evaluatePromo(promo, product, subtotal);
      if (!r.ok) return [{ error: r.message }, 400];
      if (num(promo.maxPerUser) > 0) {
        const mine = (await fs.query('', 'orders', [['userId', 'EQUAL', user.uid], ['promoCode', 'EQUAL', code]], { tx })).filter(o => o.data.status !== 'cancelled');
        if (mine.length >= num(promo.maxPerUser)) return [{ error: 'คุณใช้โค้ดนี้ครบสิทธิ์แล้ว' }, 400];
      }
      discount = r2(r.discount);
    }
    const amount = r2(subtotal - discount);
    if (d.expectedAmount != null && Math.abs(num(d.expectedAmount) - amount) > 0.01) return [{ error: `ราคาเปลี่ยนเป็น ฿${money(amount)} กรุณาตรวจสอบอีกครั้ง` }, 409];
    const balance = r2(num(profile?.walletBalance));
    if (balance < amount) return [{ error: `เครดิตไม่พอ (คงเหลือ ฿${money(balance)})` }, 400];

    let items = [];
    if (!isService) {
      items = await fs.query(`products/${d.productId}`, 'stock_items', [['status', 'EQUAL', 'available']], { limit: qty, tx });
      if (items.length < qty) return [{ error: items.length ? `ไอดีเหลือ ${items.length} ชิ้น` : 'สินค้าหมด' }, 409];
    } else if (num(product.stock) < qty) return [{ error: num(product.stock) > 0 ? `รับงานได้อีก ${num(product.stock)}` : 'คิวเต็มชั่วคราว' }, 409];

    const oid = randomId();
    const orderNumber = `ORD-${oid.slice(0, 8).toUpperCase()}`;
    const unit = product.serviceUnit || cat?.unit || (isService ? 'กอง' : 'ไอดี');
    const packages = (Array.isArray(product.packages) ? product.packages : []).map(k => ({ qty: Math.floor(num(k.qty)), bonus: Math.floor(num(k.bonus)) })).filter(k => k.qty > 0).sort((a, b) => a.qty - b.qty);
    const bonusQty = isService ? packages.reduce((b, k) => (qty >= k.qty ? k.bonus : b), 0) : 0;
    const accounts = items.map(it => ({ username: String(it.data.username || ''), password: String(it.data.password || ''), stockItemId: it.id }));
    const username = profile?.username || user.name || user.email.split('@')[0];
    const nowIso = new Date(now).toISOString();
    const order = {
      orderNumber, orderId: orderNumber, productId: d.productId,
      productName: mode && modes.length ? `${product.name} (${mode.label})` : String(product.name || ''),
      productType: isService ? 'service' : 'account', quantity: qty, bonusQty, receiveQty: qty + bonusQty, unit,
      unitPrice: rate, subtotal, discount, promoCode: code, amount, finalPrice: amount,
      paymentMethod: 'wallet', paymentProof: 'เครดิตในบัญชี', userEmail: user.email, userId: user.uid,
      ...(isService ? { buyerFacebook: str(d.buyerFacebook) } : { buyerEmail: str(d.buyerEmail) }),
      ...(self ? { buyerContact: str(d.buyerContact), playTime: str(d.playTime) } : {}),
      ...(isService && !self ? { gameEmail: str(d.gameEmail), gamePassword: String(d.gamePassword || '').slice(0, 200), buyerContact: str(d.gameEmail) } : {}),
      ...(modes.length ? { farmMode: mode.key } : {}),
      ...(isService ? { status: 'processing', queueStatus: 'waiting' } : { status: 'completed', accountsDelivered: accounts, accountDelivered: accounts[0] })
    };
    const writes = [
      { update: { name: fs.name(`users/${user.uid}`), fields: fs.fields({ walletBalance: r2(balance - amount) }) }, updateMask: { fieldPaths: ['walletBalance'] }, currentDocument: { exists: true } },
      { update: { name: fs.name(`products/${d.productId}`) }, updateMask: { fieldPaths: [] }, updateTransforms: [inc('stock', -qty), stamp('updatedAt')], currentDocument: { exists: true } },
      ...items.map(it => ({ update: { name: fs.name(it.path), fields: fs.fields({ status: 'sold', orderId: oid }) }, updateMask: { fieldPaths: ['status', 'orderId'] }, updateTransforms: [stamp('soldAt')], currentDocument: { exists: true } })),
      { update: { name: fs.name(`orders/${oid}`), fields: fs.fields(order) }, updateTransforms: [stamp('createdAt'), stamp(isService ? 'paidAt' : 'completedAt')], currentDocument: { exists: false } },
      { update: { name: fs.name(`wallet_logs/${randomId()}`), fields: fs.fields({ uid: user.uid, before: balance, after: r2(balance - amount), delta: -amount, note: `ซื้อ ${order.productName} (${orderNumber})`, by: 'system' }) }, updateTransforms: [stamp('at')] }
    ];
    if (isService) writes.push({ update: { name: fs.name(`queue/${oid}`), fields: fs.fields({ orderNumber, productId: d.productId, productName: String(product.name || ''), unit, quantity: qty, nameMask: maskName(username).slice(0, 8), uid: user.uid, status: 'waiting' }) }, updateTransforms: [stamp('createdAt')] });
    else {
      writes.push({ update: { name: fs.name('stats/public') }, updateMask: { fieldPaths: [] }, updateTransforms: [inc('orders', 1), inc('sales', amount)] });
      writes.push({ update: { name: fs.name(`recent_orders/${oid}`), fields: fs.fields({ productName: order.productName.slice(0, 120), amount, buyerMask: maskName(username), kind: 'account' }) }, updateTransforms: [stamp('createdAt')] });
    }
    if (code) writes.push({ update: { name: fs.name(`promo_codes/${code}`) }, updateMask: { fieldPaths: [] }, updateTransforms: [inc('usedCount', 1)] });
    await fs.commit(writes, tx);
    committed = true;
    const { gamePassword, ...publicOrder } = order;
    return [{ status: order.status, orderId: oid, order: { ...publicOrder, id: oid, createdAt: nowIso } }];
  } finally {
    if (!committed) await fs.rollback(tx); // releases the read locks on early returns and errors
  }
}

async function routeBuy({ user, data, fs, fetchFn, now, later }) {
  const bad = validateBuy(data);
  if (bad) return [{ error: bad }, 400];
  let out;
  for (let i = 0; i < 3; i++) {
    try { out = await buyOnce({ user, d: data, fs, now }); break; }
    catch (e) { if (e.code === 'conflict' && i < 2) continue; if (e.code === 'conflict') return [{ error: 'มีคนกำลังซื้อสินค้านี้พร้อมกัน กรุณาลองอีกครั้ง' }, 409]; throw e; }
  }
  const [body, status] = out;
  if (!status && body.order) {
    const o = body.order;
    later(discord(fs, fetchFn, { title: o.productType === 'service' ? '🛠️ ออเดอร์บริการใหม่ (จ่ายด้วยเครดิต)' : '✅ ขายไอดีอัตโนมัติ (จ่ายด้วยเครดิต)', fields: [
      { name: 'ออเดอร์', value: o.orderNumber, inline: true }, { name: 'ยอด', value: `฿${money(o.amount)}`, inline: true },
      { name: 'สินค้า', value: `${o.productName} × ${o.quantity}` }, { name: 'ผู้ซื้อ', value: user.name || user.email }] }));
  }
  return out;
}

// ---------- POST /admin/user ----------
async function routeAdminUser({ user, data, sa, fetchFn, now }) {
  if (!user.admin) return [{ error: 'เฉพาะผู้ดูแลระบบ' }, 403];
  const uid = String(data.uid || '');
  if (!/^[\w-]{1,128}$/.test(uid)) return [{ error: 'uid ไม่ถูกต้อง' }, 400];
  if (uid === user.uid && (data.admin === false || data.disabled === true)) return [{ error: 'ห้ามลดสิทธิ์หรือระงับบัญชีของตัวเอง' }, 400];
  const token = await accessToken(sa, fetchFn, now);
  const api = `https://identitytoolkit.googleapis.com/v1/projects/${sa.project_id}`;
  const call = async (path, body) => {
    const r = await fetchFn(`${api}/${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const m = j.error?.message || '';
      throw fail('auth-api', m.includes('EMAIL_EXISTS') ? 'ชื่อผู้ใช้นี้มีคนใช้แล้ว' : m.includes('WEAK_PASSWORD') ? 'รหัสผ่านสั้นเกินไป' : m.includes('USER_NOT_FOUND') ? 'ไม่พบผู้ใช้ในระบบล็อกอิน' : `แก้ไขบัญชีไม่สำเร็จ (${m || r.status})`);
    }
    return j;
  };
  const update = { localId: uid };
  if (data.username != null) {
    const u = String(data.username).trim();
    if ([...u].length < 3 || [...u].length > 24 || /[@\s]/.test(u)) return [{ error: 'ชื่อผู้ใช้ 3–24 ตัวอักษร ห้ามมีช่องว่างหรือ @' }, 400];
    update.email = usernameToEmail(u); update.displayName = u;
  }
  if (data.password != null) {
    if (String(data.password).length < 6) return [{ error: 'รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร' }, 400];
    update.password = String(data.password);
  }
  if (typeof data.disabled === 'boolean') { update.disableUser = data.disabled; if (data.disabled) update.validSince = String(Math.floor(now / 1000)); }
  if (typeof data.admin === 'boolean') {
    const look = await call('accounts:lookup', { localId: [uid] });
    let attrs = {};
    try { attrs = JSON.parse(look.users?.[0]?.customAttributes || '{}'); } catch (_) {}
    if (data.admin) attrs.admin = true; else delete attrs.admin;
    update.customAttributes = JSON.stringify(attrs);
  }
  if (Object.keys(update).length === 1) return [{ ok: true }];
  const res = await call('accounts:update', update);
  return [{ ok: true, email: res.email || update.email || '' }];
}

// ---------- POST /notify ----------
async function routeNotify({ user, data, fs, fetchFn, now }) {
  const kind = String(data.kind || '');
  if (kind === 'test') {
    if (!user.admin) return [{ error: 'เฉพาะผู้ดูแลระบบ' }, 403];
    const ok = await discord(fs, fetchFn, { title: 'ทดสอบการแจ้งเตือน', description: `การแจ้งเตือนจาก ${SHOP} ใช้งานได้แล้ว` });
    return ok ? [{ ok: true }] : [{ error: 'ส่งไม่สำเร็จ ตรวจสอบ Discord Webhook URL ในหน้าตั้งค่า แล้วกดบันทึกก่อนทดสอบ' }, 400];
  }
  const id = String(data.id || '');
  if (!['order', 'topup'].includes(kind) || !/^[\w-]{1,64}$/.test(id)) return [{ error: 'คำขอไม่ถูกต้อง' }, 400];
  const d = await fs.get(`${kind === 'order' ? 'orders' : 'topup_transactions'}/${id}`);
  if (!d || (kind === 'order' ? d.userId : d.uid) !== user.uid) return [{ error: 'ไม่พบรายการ' }, 404];
  const created = Date.parse(d.createdAt);
  if (Number.isFinite(created) && now - created > 15 * 60e3) return [{ ok: true, skipped: 'old' }];
  try { await fs.commit([{ update: { name: fs.name(`notify_log/${kind}_${id}`), fields: fs.fields({ uid: user.uid }) }, updateTransforms: [stamp('at')], currentDocument: { exists: false } }]); }
  catch (e) { if (e.code === 'already-exists' || e.code === 'conflict') return [{ ok: true, skipped: 'dup' }]; throw e; }
  const who = user.name || user.email;
  const embed = kind === 'order'
    ? { title: '🧾 ออเดอร์ใหม่ รอตรวจสอบการชำระเงิน', fields: [{ name: 'ออเดอร์', value: String(d.orderNumber || id), inline: true }, { name: 'ยอด', value: `฿${money(d.amount)}`, inline: true }, { name: 'ช่องทาง', value: d.paymentMethod === 'truemoney' ? 'TrueMoney' : `พร้อมเพย์${d.hasSlip ? ' (แนบสลิป)' : ''}`, inline: true }, { name: 'สินค้า', value: `${d.productName} × ${d.quantity}` }, { name: 'ผู้ซื้อ', value: who }] }
    : { title: '💳 แจ้งโอนเงินเติมเครดิต', fields: [{ name: 'รายการ', value: String(d.txnId || id), inline: true }, { name: 'ยอด', value: `฿${money(d.amount)}`, inline: true }, { name: 'เครดิตที่จะได้', value: money(d.finalCredit), inline: true }, { name: 'ช่องทาง', value: d.paymentMethod === 'truemoney' ? 'TrueMoney' : `พร้อมเพย์${d.hasSlip ? ' (แนบสลิป)' : ''}` }, { name: 'ผู้ใช้', value: who }] };
  await discord(fs, fetchFn, embed);
  return [{ ok: true }];
}

// ---------- router ----------
export async function handle(request, env, { fetchFn = fetch, now = Date.now(), ctx = null } = {}) {
  const cors = { 'access-control-allow-origin': env.ALLOWED_ORIGIN || '*', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'POST, OPTIONS', vary: 'origin' };
  const reply = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', ...cors } });
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return reply({ error: 'method not allowed' }, 405);
  const path = new URL(request.url).pathname.replace(/\/+$/, '') || '/';
  const routes = { '/': routeSlip, '/slip': routeSlip, '/buy': routeBuy, '/admin/user': routeAdminUser, '/notify': routeNotify };
  const route = routes[path];
  if (!route) return reply({ error: 'not found' }, 404);
  const pending = [];
  const later = (p) => { const q = Promise.resolve(p).catch((e) => console.warn('later:', e)); if (ctx?.waitUntil) ctx.waitUntil(q); else pending.push(q); };
  try {
    const sa = JSON.parse(env.SERVICE_ACCOUNT || '{}');
    const user = await verifyIdToken((request.headers.get('authorization') || '').replace(/^Bearer /, ''), sa.project_id, fetchFn, now);
    const data = await request.json().catch(() => ({}));
    const fs = fsClient(sa.project_id, await accessToken(sa, fetchFn, now), fetchFn);
    const [body, status = 200] = await route({ user, data: data || {}, fs, env, sa, fetchFn, now, later });
    await Promise.all(pending);
    return reply(body, status);
  } catch (e) {
    if (e.code === 'unauthenticated') return reply({ error: e.message }, 401);
    if (e.code === 'auth-api') return reply({ error: e.message }, 400);
    console.error('worker failed', e);
    return reply({ error: 'ทำรายการไม่สำเร็จ กรุณาลองใหม่' }, 500);
  }
}

export default { fetch: (request, env, ctx) => handle(request, env, { ctx }) };
