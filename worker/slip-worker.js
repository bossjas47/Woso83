// Nugget Hub — Cloudflare Worker (server side of the shop). All routes take POST + the user's Firebase ID token.
//   POST /            (or /slip)   top-up slip check with EasySlip, credits the wallet           (any signed-in user)
//   POST /angpao                   TrueMoney gift voucher: redeem, credit (+promo), optional buy
//   POST /buy                      pay with wallet credit: price, promo, balance, stock in one transaction;
//                                  game IDs are delivered at once, services go to the queue      (any signed-in user)
//   POST /cart                     pay up to 8 cart lines with credit (each line like /buy)
//   POST /rent                     rent a game ID by the hour (price, deposit and balance checked here)
//   POST /rent/extend|credentials|return   extend, read the login (only while the rental runs), give back
//   POST /admin/rent               close a returned / expired rental: refund or keep the deposit, put the ID back
//   Cron Trigger (*/5 * * * *)     locks IDs whose rental time is up (needed for the Discord alert; credentials are time-checked anyway)
//   POST /box/open                 loot box (กล่องสุ่ม): charge the credit price, draw the prize here with a secure random number,
//                                  deliver it (credit / game ID / queued service) and log it in one transaction
//   POST /box/claim                give the contact or game login for a won service prize; creates the queue order
//   POST /admin/user               change a user's login name, password, admin claim, disabled  (admin claim only)
//   POST /ammo/quote, /ammo/pay    ammo bundles (ไก่กระสุน): pick IDs whose ammo adds up to the order, then pay (guests allowed per product)
//   POST /ammo/extend              +5 min on a live ammo hold (once)
//   POST /box/gift, /box/gift/cancel   gift tickets for loot boxes (pay now, receiver opens free with giftCode)
//   POST /ammo/claim, /admin/claim  member reports a bad ammo ID within 24 h; admin refunds the order as credit or rejects
//   POST /notify                   Discord message for a new order / top-up request ({kind:'test'} = admin only)
// Variables (Worker > Settings > Variables and Secrets):
//   SERVICE_ACCOUNT  secret  the Firebase service-account JSON, pasted as text
//   EASYSLIP_KEY     secret  EasySlip API key                         (only for automatic slip checks)
//   TRUEMONEY_PHONE  secret  shop's TrueMoney wallet number, e.g. 0812345678 (turns on ซองอั่งเปา /angpao)
//   RECEIVER_MATCH   text    shop account name / digits on the slip    (only for automatic slip checks)
//   ALLOWED_ORIGIN   text    optional, your site origin, e.g. https://astraphex.panderx.xyz (default: any)
// The Discord webhook URL lives in Firestore system_private/secrets.discordWebhook (admin > settings).
const MIN = 20, MAX = 50000, THROTTLE_MS = 10000, MAX_SLIP_AGE_MS = 3 * 864e5;
const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const SHOP = 'Nugget Hub';
export const WORKER_VERSION = '10';

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
  if (now - jwksCache.at > 36e5 || (now - jwksCache.at > 60e3 && !jwksCache.keys.some((k) => k.kid === head.kid))) { // a forged unknown kid can trigger at most one refetch a minute
    jwksCache = { at: now, keys: (await (await fetchFn(JWKS_URL)).json()).keys || [] };
  }
  const jwk = jwksCache.keys.find((k) => k.kid === head.kid);
  if (!jwk) throw fail('unauthenticated', 'โทเคนไม่ถูกต้อง');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, unb64u(s), enc.encode(`${h}.${p}`));
  const sec = now / 1000;
  if (!ok || claims.aud !== projectId || claims.iss !== `https://securetoken.google.com/${projectId}`
      || !(claims.exp > sec) || !(claims.iat <= sec + 60) || !claims.sub) throw fail('unauthenticated', 'กรุณาเข้าสู่ระบบใหม่');
  return { uid: claims.sub, email: claims.email || '', name: claims.name || '', admin: claims.admin === true, perms: Array.isArray(claims.perms) ? claims.perms.map(String) : [] };
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
export function evaluatePromo(promo, product, subtotal, uid = '', now = Date.now()) {
  const value = num(promo?.value);
  if (!promo || promo.active === false || !['fixed', 'percent'].includes(promo.type) || !(value > 0)) return { ok: false, message: 'ไม่พบโค้ดส่วนลดนี้ หรือโค้ดหมดอายุ' };
  if (promo.onlyUid && promo.onlyUid !== uid) return { ok: false, message: 'โค้ดนี้ใช้ได้เฉพาะบัญชีที่ได้รับสิทธิ์' };
  if (num(promo.expiresAt) > 0 && num(promo.expiresAt) < now) return { ok: false, message: 'โค้ดนี้หมดอายุแล้ว' };
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
// Member ranks (same rules as js/rank.js): Bronze after the first purchase, then by total topped up; perks from settings.ranks.
export function rankOf(profile, settings) {
  if (!profile?.hasBought) return null;
  const rows = Array.isArray(settings?.ranks) ? settings.ranks : [], t = num(profile.topupTotal);
  let at = 0;
  for (let i = 1; i < 7; i++) if (num(rows[i]?.min) > 0 && t >= num(rows[i].min)) at = i;
  const pct = (v) => Math.min(100, Math.max(0, num(v)));
  return { index: at, name: RANK_NAMES[at], discount: pct(rows[at]?.discount), bonus: pct(rows[at]?.bonus) };
}
const RANK_NAMES = ['Bronze', 'Silver', 'Gold', 'Diamond', 'Duchess', 'Duke', 'Emperor'];
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

export async function routeSlip({ user, data, fs, env, fetchFn, now, later }) {
  const amount = Number(data.amount);
  const payload = String(data.payload || '');
  if (!Number.isFinite(amount) || amount < MIN || amount > MAX || Math.round(amount * 100) !== amount * 100) return [{ error: 'ยอดเงินไม่ถูกต้อง' }, 400];
  if (payload.length < 20 || payload.length > 2000) return [{ error: 'ไม่พบ QR ที่อ่านได้บนสลิป' }, 400];
  // Slips are checked by the API only (no manual approval): top-up, or pay for one product (purpose 'buy': credit exactly the price, no promo bonus, then buy).
  const buy = data.purpose === 'buy' ? (data.buy || {}) : null;
  if (buy) { const bad = validateBuy(buy); if (bad) return [{ error: bad }, 400]; }
  const settings = await fs.get('system/settings');
  if (!(settings && settings.slipAutoVerify === true) || !env.EASYSLIP_KEY || !env.RECEIVER_MATCH) return [{ status: 'rejected', message: 'ร้านยังไม่เปิดระบบตรวจสลิปอัตโนมัติ กรุณาติดต่อแอดมิน' }];

  const profile = await fs.get(`users/${user.uid}`);
  if (profile?.status === 'suspended') return [{ status: 'rejected', message: 'บัญชีนี้ถูกระงับการใช้งาน' }];
  const attempt = await fs.get(`slip_attempts/${user.uid}`);
  if (attempt && now - attempt.at < THROTTLE_MS) return [{ status: 'rejected', message: 'ส่งสลิปถี่เกินไป รอสักครู่แล้วลองใหม่' }];
  await fs.commit([{ update: { name: fs.name(`slip_attempts/${user.uid}`), fields: fs.fields({ at: now }) } }]);

  let check;
  try { check = await checkSlip({ fetchFn, key: env.EASYSLIP_KEY, receiver: env.RECEIVER_MATCH, payload, amount, now }); }
  catch (e) {
    console.warn('slip api:', e);
    if (buy) return [{ status: 'rejected', message: 'ระบบตรวจสลิปขัดข้องชั่วคราว กรุณาลองใหม่อีกครั้งในอีกสักครู่' }];
    // The slip checker is down: park the slip as a pending top-up for the admin to approve by hand (same payload twice = same slip, never queued twice).
    if ((await fs.query('', 'topup_transactions', [['uid', 'EQUAL', user.uid], ['status', 'EQUAL', 'pending']])).length >= 3) return [{ status: 'rejected', message: 'มีสลิปรอแอดมินตรวจครบ 3 รายการแล้ว รอให้ตรวจก่อนค่อยส่งเพิ่ม' }];
    const h = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload)))].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 40), qid = randomId();
    try {
      await fs.commit([
        { update: { name: fs.name(`slip_refs/q_${h}`), fields: fs.fields({ uid: user.uid, amount }) }, updateTransforms: [stamp('at')], currentDocument: { exists: false } },
        { update: { name: fs.name(`topup_transactions/${qid}`), fields: fs.fields({ txnId: 'TOPUP-' + qid.slice(0, 8).toUpperCase(), uid: user.uid, email: user.email, amount, bonusCredit: 0, finalCredit: amount, paymentMethod: 'promptpay', proofRef: 'ระบบตรวจสลิปล่ม · ตรวจมือ', proofPayload: payload, status: 'pending', verifiedVia: 'manual_queue' }) }, updateTransforms: [stamp('createdAt')] }
      ]);
    } catch (e2) {
      if (e2.code === 'already-exists') return [{ status: 'rejected', message: 'สลิปนี้ส่งให้แอดมินตรวจแล้ว ไม่ต้องส่งซ้ำ' }];
      throw e2;
    }
    later(discord(fs, fetchFn, { title: '⚠️ ระบบตรวจสลิปล่ม · สลิปรออนุมัติมือ', description: `${user.name || user.email} แจ้งเติม ฿${money(amount)} ตรวจยอดเข้าบัญชีแล้วอนุมัติในหน้าเติมเงิน` }));
    return [{ status: 'queued', message: 'ระบบตรวจสลิปอัตโนมัติขัดข้อง ส่งสลิปให้แอดมินตรวจแล้ว เครดิตเข้าเมื่อแอดมินอนุมัติ (ดูสถานะในรายการเติมเงิน) ไม่ต้องส่งซ้ำ' }];
  }
  if (!check.ok) return [{ status: 'rejected', message: check.message }];

  const promos = (await fs.query('', 'topup_promos')).map(d => ({ id: d.id, ...d.data }));
  const best = buy ? { promo: null, bonus: 0 } : bestTopupPromo(promos, amount), promo = best.promo;
  const rank = rankOf(profile, settings), rankBonus = buy || !rank ? 0 : Math.floor(amount * rank.bonus / 100);
  const bonus = best.bonus + rankBonus;
  const id = randomId();
  try {
    // One atomic commit: the slip reference can be used once (exists:false), the wallet is credited, the record is written.
    await fs.commit([
      { update: { name: fs.name(`slip_refs/${check.transRef}`), fields: fs.fields({ uid: user.uid, amount }) }, updateTransforms: [stamp('at')], currentDocument: { exists: false } },
      { update: { name: fs.name(`users/${user.uid}`) }, updateMask: { fieldPaths: [] }, updateTransforms: [{ fieldPath: 'walletBalance', increment: { doubleValue: amount + bonus } }, { fieldPath: 'topupTotal', increment: { doubleValue: amount } }, stamp('lastTopupAt')] },
      { update: { name: fs.name(`topup_transactions/${id}`), fields: fs.fields({ txnId: 'TOPUP-' + id.slice(0, 8).toUpperCase(), uid: user.uid, email: user.email, amount, bonusCredit: bonus, finalCredit: amount + bonus, ...(promo ? { promoId: promo.id } : {}), ...(rankBonus ? { rankBonus, rank: rank.name } : {}), paymentMethod: 'promptpay', proofRef: check.transRef, status: 'completed', verifiedVia: 'easyslip' }) }, updateTransforms: [stamp('createdAt'), stamp('completedAt')] }
    ]);
  } catch (e) {
    if (e.code === 'already-exists') return [{ status: 'rejected', message: e.message }];
    throw e;
  }
  later(discord(fs, fetchFn, { title: 'เติมเงินอัตโนมัติสำเร็จ', description: `ผู้ใช้ ${user.name || user.email} เติม ฿${money(amount)} (+โบนัส ${money(bonus)})` }));
  const out = { status: 'completed', credit: amount + bonus };
  if (!buy) return [out];
  // Spend the new credit on the order. If it fails (price, stock), the credit stays in the account.
  const [b, st] = await routeBuy({ user, data: buy, fs, fetchFn, now, later });
  return [st ? { ...out, buyError: b.error || 'สั่งซื้อไม่สำเร็จ' } : { ...out, buy: b }];
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

async function buyOnce({ user, d, fs, now, combo = 0, override = 0 }) {
  const tx = await fs.begin();
  let committed = false;
  try {
    const [profile, product] = await Promise.all([fs.get(`users/${user.uid}`, tx), fs.get(`products/${d.productId}`, tx)]);
    if (profile?.status === 'suspended') return [{ error: 'บัญชีนี้ถูกระงับการใช้งาน' }, 403];
    if (!product) return [{ error: 'ไม่พบสินค้านี้' }, 404];
    product.id = d.productId;
    if (num(product.hideAt) > 0 && now >= num(product.hideAt) && !(override > 0)) return [{ error: 'สินค้านี้ปิดขายแล้ว' }, 409];
    if (num(product.dropAt) > now && !(override > 0)) return [{ error: `ยังไม่เปิดขาย (เปิด ${new Date(num(product.dropAt) + 7 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')} เวลาไทย)` }, 409];
    const cat = product.category ? await fs.get(`categories/${product.category}`, tx) : null;
    const isService = product.productType === 'service' || cat?.kind === 'service' || String(product.category || '').startsWith('service');
    const qty = d.quantity;
    const minQty = isService ? Math.max(1, Math.floor(num(product.serviceMin) || num(cat?.minQty) || 1)) : 1;
    if (qty < minQty) return [{ error: `สั่งขั้นต่ำ ${minQty}` }, 400];
    const modes = Array.isArray(product.farmModes) ? product.farmModes : [];
    const mode = modes.find(m => m.key === d.farmMode) || (modes.length ? modes[0] : null);
    const rate = override > 0 ? override : mode ? num(mode.price) : isService ? (num(product.serviceRate) || num(product.price)) : num(product.price);
    if (!(rate > 0)) return [{ error: 'สินค้านี้ยังไม่ได้ตั้งราคา' }, 400];
    const self = isService && mode?.key === 'self';
    if (isService) {
      if (str(d.buyerFacebook).length < 2) return [{ error: 'กรุณากรอกชื่อหรือลิงก์ Facebook' }, 400];
      if (self && (!str(d.buyerContact) || !str(d.playTime))) return [{ error: 'กรุณากรอกชื่อในเกมและเวลาที่พร้อม' }, 400];
      if (!self && (!str(d.gameEmail).includes('@') || !String(d.gamePassword || ''))) return [{ error: 'กรุณากรอกอีเมลและรหัสผ่านบัญชีเกม' }, 400];
    } else if (str(d.buyerEmail) && !/^\S+@\S+\.\S+$/.test(str(d.buyerEmail))) return [{ error: 'อีเมลไม่ถูกต้อง' }, 400];

    const subtotal = r2(qty * rate);
    let discount = 0, code = null;
    if (d.promoCode) {
      code = String(d.promoCode);
      const promo = await fs.get(`promo_codes/${code}`, tx);
      const r = evaluatePromo(promo, product, subtotal, user.uid, now);
      if (!r.ok) return [{ error: r.message }, 400];
      if (num(promo.maxPerUser) > 0) {
        const mine = (await fs.query('', 'orders', [['userId', 'EQUAL', user.uid], ['promoCode', 'EQUAL', code]], { tx })).filter(o => o.data.status !== 'cancelled');
        if (mine.length >= num(promo.maxPerUser)) return [{ error: 'คุณใช้โค้ดนี้ครบสิทธิ์แล้ว' }, 400];
      }
      discount = r2(r.discount);
    }
    const rank = rankOf(profile, await fs.get('system/settings')), rankDiscount = rank && !(override > 0) ? Math.round((subtotal - discount) * rank.discount) / 100 : 0;
    const comboDiscount = combo > 0 ? Math.round((subtotal - discount) * combo) / 100 : 0; // set by /cart only: ID + service in one cart (mirrored in js/cart.js)
    const amount = r2(subtotal - discount - rankDiscount - comboDiscount);
    if (d.expectedAmount != null && Math.abs(num(d.expectedAmount) - amount) > 0.01) return [{ error: `ราคาเปลี่ยนเป็น ฿${money(amount)} กรุณาตรวจสอบอีกครั้ง` }, 409];
    const balance = r2(num(profile?.walletBalance));
    if (balance < amount) return [{ error: `เครดิตไม่พอ (คงเหลือ ฿${money(balance)})` }, 400];

    let items = [], bundle = null;
    if (!isService) {
      items = await fs.query(`products/${d.productId}`, 'stock_items', [['status', 'EQUAL', 'available']], { limit: qty, tx });
      if (items.length < qty) return [{ error: items.length ? `ไอดีเหลือ ${items.length} ชิ้น` : 'สินค้าหมด' }, 409];
      if (product.bundleAmmoId && num(product.bundleAmmo) > 0) { // bundle: the IDs come with about N กอง of ammo from another product, taken in the same transaction
        const want = num(product.bundleAmmo) * qty, rows = (await fs.query(`products/${product.bundleAmmoId}`, 'stock_items', [['status', 'EQUAL', 'available']], { limit: 400, tx })).filter(r => num(r.data.ammo) > 0);
        const m = matchAmmo(rows.map(r => num(r.data.ammo)), want);
        if (!m || Math.abs(m.total - want) > want * 0.1) return [{ error: 'ไก่กระสุนในแพ็กนี้เหลือไม่พอ ลองใหม่ภายหลังหรือติดต่อแอดมิน' }, 409];
        bundle = { id: product.bundleAmmoId, rows: m.idx.map(i => rows[i]), total: m.total };
      }
    } else if (num(product.stock) < qty) return [{ error: num(product.stock) > 0 ? `รับงานได้อีก ${num(product.stock)}` : 'คิวเต็มชั่วคราว' }, 409];

    const oid = randomId();
    const orderNumber = `ORD-${oid.slice(0, 8).toUpperCase()}`;
    const unit = product.serviceUnit || cat?.unit || (isService ? 'กอง' : 'ไอดี');
    const packages = (Array.isArray(product.packages) ? product.packages : []).map(k => ({ qty: Math.floor(num(k.qty)), bonus: Math.floor(num(k.bonus)) })).filter(k => k.qty > 0).sort((a, b) => a.qty - b.qty);
    const bonusQty = isService ? packages.reduce((b, k) => (qty >= k.qty ? k.bonus : b), 0) : 0;
    const accounts = [...items.map(it => ({ username: String(it.data.username || ''), password: String(it.data.password || ''), stockItemId: it.id })), ...(bundle ? bundle.rows.map(it => ({ username: String(it.data.username || ''), password: String(it.data.password || ''), stockItemId: it.id, ammo: num(it.data.ammo) })) : [])];
    const username = profile?.username || user.name || user.email.split('@')[0];
    const nowIso = new Date(now).toISOString();
    const order = {
      orderNumber, orderId: orderNumber, productId: d.productId,
      productName: mode && modes.length ? `${product.name} (${mode.label})` : String(product.name || ''),
      productType: isService ? 'service' : 'account', quantity: qty, bonusQty, receiveQty: qty + bonusQty, unit,
      unitPrice: rate, subtotal, discount, promoCode: code, ...(rankDiscount ? { rankDiscount, rank: rank.name } : {}), ...(comboDiscount ? { comboDiscount } : {}), ...(isService ? {} : { pwRemindAt: now + 864e5, pwReminded: false }), amount, finalPrice: amount,
      paymentMethod: 'wallet', paymentProof: 'เครดิตในบัญชี', userEmail: user.email, userId: user.uid,
      ...(isService ? { buyerFacebook: str(d.buyerFacebook) } : str(d.buyerEmail) ? { buyerEmail: str(d.buyerEmail) } : {}),
      ...(self ? { buyerContact: str(d.buyerContact), playTime: str(d.playTime) } : {}),
      ...(isService && !self ? { gameEmail: str(d.gameEmail), gamePassword: String(d.gamePassword || '').slice(0, 200), buyerContact: str(d.gameEmail) } : {}),
      ...(modes.length ? { farmMode: mode.key } : {}),
      ...(bundle ? { bundleAmmo: bundle.total } : {}),
      ...(isService ? { status: 'processing', queueStatus: 'waiting' } : { status: 'completed', accountsDelivered: accounts, accountDelivered: accounts[0] })
    };
    const writes = [
      { update: { name: fs.name(`users/${user.uid}`), fields: fs.fields({ walletBalance: r2(balance - amount), hasBought: true }) }, updateMask: { fieldPaths: ['walletBalance', 'hasBought'] }, currentDocument: { exists: true } },
      { update: { name: fs.name(`products/${d.productId}`) }, updateMask: { fieldPaths: [] }, updateTransforms: [inc('stock', -qty), stamp('updatedAt')], currentDocument: { exists: true } },
      ...items.map(it => ({ update: { name: fs.name(it.path), fields: fs.fields({ status: 'sold', orderId: oid }) }, updateMask: { fieldPaths: ['status', 'orderId'] }, updateTransforms: [stamp('soldAt')], currentDocument: { exists: true } })),
      { update: { name: fs.name(`orders/${oid}`), fields: fs.fields(order) }, updateTransforms: [stamp('createdAt'), stamp(isService ? 'paidAt' : 'completedAt')], currentDocument: { exists: false } },
      { update: { name: fs.name(`wallet_logs/${randomId()}`), fields: fs.fields({ uid: user.uid, before: balance, after: r2(balance - amount), delta: -amount, note: `ซื้อ ${order.productName} (${orderNumber})`, by: 'system' }) }, updateTransforms: [stamp('at')] }
    ];
    if (bundle) writes.push(
      { update: { name: fs.name(`products/${bundle.id}`) }, updateMask: { fieldPaths: [] }, updateTransforms: [inc('stock', -bundle.total), stamp('updatedAt')], currentDocument: { exists: true } },
      ...bundle.rows.map(it => ({ update: { name: fs.name(it.path), fields: fs.fields({ status: 'sold', orderId: oid }) }, updateMask: { fieldPaths: ['status', 'orderId'] }, updateTransforms: [stamp('soldAt')], currentDocument: { exists: true } })));
    if (isService) writes.push({ update: { name: fs.name(`queue/${oid}`), fields: fs.fields({ orderNumber, productId: d.productId, productName: String(product.name || ''), unit, quantity: qty, nameMask: maskName(username).slice(0, 8), uid: user.uid, status: 'waiting' }) }, updateTransforms: [stamp('createdAt')] });
    else {
      writes.push({ update: { name: fs.name('stats/public') }, updateMask: { fieldPaths: [] }, updateTransforms: [inc('orders', 1), inc('sales', amount)] });
      writes.push({ update: { name: fs.name(`recent_orders/${oid}`), fields: fs.fields({ productName: order.productName.slice(0, 120), productId: d.productId, amount, buyerMask: maskName(username), kind: 'account' }) }, updateTransforms: [stamp('createdAt')] });
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

export async function routeBuy({ user, data, fs, fetchFn, now, later, combo = 0 }) {
  const bad = validateBuy(data);
  if (bad) return [{ error: bad }, 400];
  let out;
  for (let i = 0; i < 3; i++) {
    try { out = await buyOnce({ user, d: data, fs, now, combo }); break; }
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


// ---------- POST /angpao : TrueMoney gift voucher (ซองอั่งเปา) ----------
// JavaScript port of @pichxyaponn/tw-angpao (utils.ts / index.ts / error.class.ts). The voucher is redeemed into the
// shop's TrueMoney wallet (env TRUEMONEY_PHONE), then the amount actually received is credited to the customer
// (+ the best top-up promotion), and optionally spent at once on an order (purpose 'buy').
export function getValidVoucherCode(voucherCode) {
  const parts = String(voucherCode || '').split('?v=');
  const codeToTest = parts[1] || parts[0];
  const match = codeToTest.match(/[0-9A-Za-z]+/);
  return match ? match[0] : '';
}
const thaiPhoneNumberRegex = /^0[689]\d{8}$/;
export function isValidThaiPhoneNumber(phoneNumber) {
  const cleaned = String(phoneNumber || '').replace(/[^\d]/g, '');
  if (cleaned.startsWith('66') && cleaned.length === 11) return thaiPhoneNumberRegex.test('0' + cleaned.substring(2));
  return thaiPhoneNumberRegex.test(cleaned);
}
const isRecord = (v) => typeof v === 'object' && v !== null;
const isTwSuccess = (v) => isRecord(v) && isRecord(v.status) && v.status.code === 'SUCCESS' && isRecord(v.status.data);
const isTwError = (v) => isRecord(v) && isRecord(v.status) && typeof v.status.code === 'string';
async function parseTwResponse(res) {
  if (!res?.ok) {
    try { const j = await res.json(); if (isTwError(j)) return j; } catch { /* fall through */ }
    return { status: { code: 'HTTP_ERROR_' + (res?.status || 'UNKNOWN'), message: `API request failed: ${res?.statusText || 'Unknown'}` }, data: null };
  }
  let data;
  try { data = await res.json(); } catch { return { status: { code: 'INVALID_JSON_RESPONSE', message: 'API returned invalid JSON' }, data: null }; }
  if (isTwSuccess(data) || isTwError(data)) return data;
  return { status: { code: 'MALFORMED_RESPONSE', message: 'API returned JSON in an unrecognised shape' }, data: null };
}
export async function redeemVoucher({ phoneNumber, voucherCode, fetchFn = fetch }) {
  const mobile = String(phoneNumber || '').trim().replace(/[^\d]/g, '').replace(/^66(?=\d{9}$)/, '0');
  const code = voucherCode ? getValidVoucherCode(voucherCode) : '';
  if (!isValidThaiPhoneNumber(mobile)) return { status: { code: 'INVALID_PHONE_NUMBER', message: 'Invalid Thai Phone Number.' }, data: null };
  if (!code) return { status: { code: 'INVALID_VOUCHER_CODE', message: 'Invalid Voucher Code.' }, data: null };
  try {
    const res = await fetchFn(`https://gift.truemoney.com/campaign/vouchers/${code}/redeem`, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ mobile, voucher_hash: code })
    });
    return await parseTwResponse(res);
  } catch (e) {
    return { status: { code: 'NETWORK_ERROR', message: e?.message || 'Unexpected error' }, data: null };
  }
}
const TW_MESSAGES = {
  VOUCHER_OUT_OF_STOCK: 'ซองนี้ถูกรับไปครบแล้ว', TARGET_USER_REDEEMED: 'ซองนี้ถูกรับไปแล้ว', VOUCHER_NOT_FOUND: 'ไม่พบซองนี้ ตรวจลิงก์อีกครั้ง',
  CANNOT_GET_OWN_VOUCHER: 'รับซองของตัวเองไม่ได้', VOUCHER_EXPIRED: 'ซองหมดอายุแล้ว', INVALID_VOUCHER_CODE: 'ลิงก์ซองไม่ถูกต้อง',
  INVALID_PHONE_NUMBER: 'ร้านตั้งค่าเบอร์รับซองไม่ถูกต้อง กรุณาติดต่อแอดมิน'
};
export const angpaoErrorText = (code) => TW_MESSAGES[code] || `รับซองไม่สำเร็จ (${code}) กรุณาลองใหม่หรือติดต่อแอดมิน`;

async function routeAngpao({ user, data, fs, env, fetchFn, now, later }) {
  const link = str(data.link, 300);
  const code = getValidVoucherCode(link);
  if (!/gift\.truemoney\.com/i.test(link) || code.length < 10) return [{ error: 'กรุณาวางลิงก์ซองของขวัญ TrueMoney ให้ถูกต้อง' }, 400];
  if (!env.TRUEMONEY_PHONE) return [{ error: 'ร้านยังไม่เปิดรับซองอั่งเปา' }, 503];
  const buy = data.purpose === 'buy' ? (data.buy || {}) : null;
  if (buy) { const bad = validateBuy(buy); if (bad) return [{ error: bad }, 400]; }

  const profile = await fs.get(`users/${user.uid}`);
  if (profile?.status === 'suspended') return [{ error: 'บัญชีนี้ถูกระงับการใช้งาน' }, 403];
  const key = `angpao_${user.uid}`;
  const attempt = (await fs.get(`slip_attempts/${key}`)) || {};
  if (num(attempt.lockUntil) > now) return [{ error: `ลองใส่ลิงก์ผิดหลายครั้ง กรุณารอ ${Math.ceil((attempt.lockUntil - now) / 60e3)} นาที แล้วลองใหม่` }, 429];
  if (now - num(attempt.at) < 5000) return [{ error: 'ทำรายการถี่เกินไป รอสักครู่แล้วลองใหม่' }, 429];
  // 5 bad links within 10 minutes lock the account's angpao for 10 minutes (stops voucher-code guessing)
  const save = (extra) => fs.commit([{ update: { name: fs.name(`slip_attempts/${key}`), fields: fs.fields({ at: now, fails: num(attempt.fails), failStart: num(attempt.failStart), lockUntil: 0, ...extra }) } }]);
  await save({});

  const r = await redeemVoucher({ phoneNumber: env.TRUEMONEY_PHONE, voucherCode: code, fetchFn });
  if (r.status.code !== 'SUCCESS') {
    const serverSide = /^(HTTP_ERROR_|NETWORK_ERROR|INVALID_JSON_RESPONSE|MALFORMED_RESPONSE)/.test(r.status.code);
    if (serverSide) console.warn('angpao upstream:', r.status.code, r.status.message);
    else {
      const fresh = now - num(attempt.failStart) > 600e3, fails = fresh ? 1 : num(attempt.fails) + 1;
      await save({ fails: fails >= 5 ? 0 : fails, failStart: fresh ? now : num(attempt.failStart), lockUntil: fails >= 5 ? now + 600e3 : 0 });
    }
    return [{ error: angpaoErrorText(r.status.code), code: r.status.code }, serverSide ? 502 : 400];
  }
  const v = r.status.data.voucher || {}, ticket = r.status.data.my_ticket || {};
  const amount = r2(num(ticket.amount_baht) || num(v.amount_baht));
  if (!(amount > 0)) return [{ error: 'รับซองแล้วแต่อ่านยอดเงินไม่ได้ กรุณาติดต่อแอดมิน' }, 502];
  const ref = `${str(v.voucher_id, 80) || code}_${num(ticket.update_date) || now}`.replace(/[^\w-]/g, '');

  const promos = (await fs.query('', 'topup_promos')).map(d => ({ id: d.id, ...d.data }));
  const best = bestTopupPromo(promos, amount), promo = best.promo;
  const rank = rankOf(profile, await fs.get('system/settings')), rankBonus = rank ? Math.floor(amount * rank.bonus / 100) : 0;
  const bonus = best.bonus + rankBonus;
  const id = randomId();
  const credit = r2(amount + bonus);
  const writes = [
    { update: { name: fs.name(`angpao_vouchers/${ref}`), fields: fs.fields({ uid: user.uid, amount, voucherId: str(v.voucher_id, 80), code, txnId: id }) }, updateTransforms: [stamp('at')], currentDocument: { exists: false } },
    { update: { name: fs.name(`users/${user.uid}`) }, updateMask: { fieldPaths: [] }, updateTransforms: [{ fieldPath: 'walletBalance', increment: { doubleValue: credit } }, { fieldPath: 'topupTotal', increment: { doubleValue: amount } }, stamp('lastTopupAt')] },
    { update: { name: fs.name(`topup_transactions/${id}`), fields: fs.fields({ txnId: 'TOPUP-' + id.slice(0, 8).toUpperCase(), uid: user.uid, email: user.email, amount, bonusCredit: bonus, finalCredit: credit, ...(promo ? { promoId: promo.id } : {}), ...(rankBonus ? { rankBonus, rank: rank.name } : {}), paymentMethod: 'angpao', proofRef: str(v.voucher_id, 80) || code, status: 'completed', verifiedVia: 'angpao' }) }, updateTransforms: [stamp('createdAt'), stamp('completedAt')] },
    { update: { name: fs.name(`wallet_logs/${randomId()}`), fields: fs.fields({ uid: user.uid, delta: credit, note: `ซองอั่งเปา ฿${money(amount)}${bonus ? ` + โบนัส ${money(bonus)}` : ''}`, by: 'system' }) }, updateTransforms: [stamp('at')] }
  ];
  let saved = false;
  for (let i = 0; i < 2 && !saved; i++) {
    try { await fs.commit(writes); saved = true; }
    catch (e) { if (e.code === 'already-exists') { saved = 'dup'; break; } console.error('angpao credit failed', e); }
  }
  if (saved === 'dup') return [{ error: 'ซองนี้เติมเครดิตไปแล้ว' }, 409];
  if (saved !== true) {
    // The money is already in the shop's wallet: never lose it silently.
    await discord(fs, fetchFn, { title: '⚠️ รับซองอั่งเปาแล้วแต่เติมเครดิตไม่สำเร็จ', description: `ผู้ใช้ ${user.name || user.email} (${user.uid}) ยอด ฿${money(amount)} ซอง ${code} — กรุณาเติมเครดิตให้เอง` }).catch(() => {});
    return [{ error: `รับซองแล้ว ฿${money(amount)} แต่เติมเครดิตไม่สำเร็จ แอดมินได้รับแจ้งแล้ว กรุณาติดต่อแอดมิน` }, 500];
  }
  later(discord(fs, fetchFn, { title: '🧧 รับซองอั่งเปาอัตโนมัติ', description: `ผู้ใช้ ${user.name || user.email} ได้รับเครดิต ${money(credit)} (ซอง ฿${money(amount)}${bonus ? ` + โบนัส ${money(bonus)}` : ''})` }));
  const out = { status: 'credited', amount, bonus, credit };
  if (!buy) return [out];
  // Spend the new credit on the order. If it fails (price, stock, not enough), the credit stays in the account.
  const [b, st] = await routeBuy({ user, data: buy, fs, fetchFn, now, later });
  return [st ? { ...out, buyError: b.error || 'สั่งซื้อไม่สำเร็จ' } : { ...out, buy: b }];
}

// ---------- POST /cart : pay several cart lines with credit ----------
// Each line is bought with the same code as /buy (own transaction). The balance for the whole cart is checked first;
// a line that fails (sold out, price changed) is reported and costs nothing, the others still go through.
// shortcut: not one all-or-nothing transaction, at most 8 lines per call (Worker subrequest limit); upgrade if partial carts annoy customers.
async function routeCart({ user, data, fs, fetchFn, now, later }) {
  const items = Array.isArray(data.items) ? data.items : [];
  if (!items.length || items.length > 8) return [{ error: 'ตะกร้าต้องมี 1–8 รายการ' }, 400];
  for (const it of items) {
    const bad = validateBuy(it);
    if (bad) return [{ error: bad }, 400];
    if (!(num(it.expectedAmount) > 0)) return [{ error: 'ไม่พบราคาสินค้า กรุณาโหลดตะกร้าใหม่' }, 400];
  }
  const need = r2(items.reduce((a, it) => a + num(it.expectedAmount), 0));
  const balance = r2(num((await fs.get(`users/${user.uid}`))?.walletBalance));
  if (balance < need) return [{ error: `เครดิตไม่พอ ต้องใช้ ฿${money(need)} (คงเหลือ ฿${money(balance)})` }, 400];
  // ID + service in the same cart: the admin's comboPct (%) comes off every line
  const shop = await fs.get('system/settings'), kinds = new Set();
  const comboPct = Math.min(50, Math.max(0, num(shop?.comboPct)));
  if (comboPct > 0) for (const it of items) {
    const p = await fs.get(`products/${it.productId}`), cat = p?.category ? await fs.get(`categories/${p.category}`) : null;
    if (p && !p.isAmmo) kinds.add(p.productType === 'service' || cat?.kind === 'service' || String(p.category || '').startsWith('service') ? 'service' : 'id');
  }
  const combo = kinds.size === 2 ? comboPct : 0;
  const results = [];
  for (const [index, it] of items.entries()) {
    const [body, status] = await routeBuy({ user, data: { ...it, promoCode: null }, fs, fetchFn, now, later, combo });
    results.push(status ? { index, error: body.error || 'สั่งซื้อไม่สำเร็จ' } : { index, ok: true, order: body.order });
  }
  return [{ results }];
}

// ---------- Rentals (เช่าไอดี) ----------
// A rental product keeps its game IDs in products/{id}/stock_items like a sold ID, but the ID is only lent:
//   available -> rented (while the rental runs) -> cooldown (returned / expired, admin changes the password) -> available.
// The customer never reads the credentials from Firestore: /rent/credentials answers only while the rental is active.
const RENT_MAX_HOURS = 720;
export const isRentProduct = (p) => !!p && (num(p.rentHourPrice) > 0 || (Array.isArray(p.rentPackages) && p.rentPackages.some(k => num(k.hours) > 0 && num(k.price) > 0)));
/** Package price when the hours match a package exactly, otherwise hours x hourly rate (0 = not sold that way). */
export function rentPrice(product, hours) {
  const pk = (Array.isArray(product.rentPackages) ? product.rentPackages : []).find(k => Math.floor(num(k.hours)) === hours && num(k.price) > 0);
  if (pk) return r2(num(pk.price));
  const rate = num(product.rentHourPrice);
  const min = Math.max(1, Math.floor(num(product.rentMinHours)) || 1);
  return rate > 0 && hours >= min ? r2(hours * rate) : 0;
}
const rentHours = (v) => { const h = Number(v); return Number.isInteger(h) && h >= 1 && h <= RENT_MAX_HOURS ? h : 0; };
const retry = async (fn) => {
  for (let i = 0; i < 3; i++) {
    try { return await fn(); }
    catch (e) { if (e.code === 'conflict' && i < 2) continue; if (e.code === 'conflict') return [{ error: 'มีคนกำลังทำรายการพร้อมกัน กรุณาลองอีกครั้ง' }, 409]; throw e; }
  }
};
const walletWrites = (fs, uid, before, after, note) => [
  { update: { name: fs.name(`users/${uid}`), fields: fs.fields({ walletBalance: r2(after) }) }, updateMask: { fieldPaths: ['walletBalance'] }, currentDocument: { exists: true } },
  { update: { name: fs.name(`wallet_logs/${randomId()}`), fields: fs.fields({ uid, before: r2(before), after: r2(after), delta: r2(after - before), note, by: 'system' }) }, updateTransforms: [stamp('at')] }
];

async function rentOnce({ user, d, fs, now }) {
  const tx = await fs.begin();
  let committed = false;
  try {
    const [profile, product] = await Promise.all([fs.get(`users/${user.uid}`, tx), fs.get(`products/${d.productId}`, tx)]);
    if (profile?.status === 'suspended') return [{ error: 'บัญชีนี้ถูกระงับการใช้งาน' }, 403];
    if (!isRentProduct(product)) return [{ error: 'ไม่พบสินค้าเช่านี้' }, 404];
    const price = rentPrice(product, d.hours);
    if (!(price > 0)) return [{ error: `เช่าไม่ได้ ขั้นต่ำ ${Math.max(1, Math.floor(num(product.rentMinHours)) || 1)} ชั่วโมง หรือเลือกแพ็กเกจที่ร้านกำหนด` }, 400];
    const deposit = r2(Math.max(0, num(product.rentDeposit)));
    const total = r2(price + deposit);
    if (d.expectedAmount != null && Math.abs(num(d.expectedAmount) - total) > 0.01) return [{ error: `ราคาเปลี่ยนเป็น ฿${money(total)} (รวมมัดจำ ฿${money(deposit)}) กรุณาตรวจสอบอีกครั้ง` }, 409];
    const balance = r2(num(profile?.walletBalance));
    if (balance < total) return [{ error: `เครดิตไม่พอ ต้องใช้ ฿${money(total)} (คงเหลือ ฿${money(balance)})` }, 400];
    const items = await fs.query(`products/${d.productId}`, 'stock_items', [['status', 'EQUAL', 'available']], { limit: 1, tx });
    if (!items.length) return [{ error: 'ไม่มีไอดีว่างให้เช่าตอนนี้' }, 409];

    const rid = randomId();
    const endMs = now + d.hours * 3600e3;
    const username = profile?.username || user.name || user.email.split('@')[0];
    const rental = {
      uid: user.uid, userEmail: user.email, nameMask: maskName(username).slice(0, 8), productId: d.productId, productName: String(product.name || '').slice(0, 200),
      stockItemId: items[0].id, hours: d.hours, price, deposit, depositStatus: deposit > 0 ? 'held' : 'none', startMs: now, endMs, status: 'active', extended: 0, viewCount: 0
    };
    await fs.commit([
      ...walletWrites(fs, user.uid, balance, balance - total, `เช่า ${rental.productName} ${d.hours} ชม. (รวมมัดจำ ฿${money(deposit)})`),
      { update: { name: fs.name(`products/${d.productId}`) }, updateMask: { fieldPaths: [] }, updateTransforms: [inc('stock', -1), stamp('updatedAt')], currentDocument: { exists: true } },
      { update: { name: fs.name(items[0].path), fields: fs.fields({ status: 'rented', rentalId: rid }) }, updateMask: { fieldPaths: ['status', 'rentalId'] }, updateTransforms: [stamp('rentedAt')], currentDocument: { exists: true } },
      { update: { name: fs.name(`rentals/${rid}`), fields: fs.fields(rental) }, updateTransforms: [stamp('createdAt')], currentDocument: { exists: false } }
    ], tx);
    committed = true;
    return [{ status: 'active', rental: { id: rid, ...rental }, balance: r2(balance - total) }];
  } finally { if (!committed) await fs.rollback(tx); }
}
async function routeRent({ user, data, fs, fetchFn, now, later }) {
  if (typeof data.productId !== 'string' || !/^[\w-]{1,128}$/.test(data.productId)) return [{ error: 'ไม่พบสินค้า' }, 400];
  const hours = rentHours(data.hours);
  if (!hours) return [{ error: `จำนวนชั่วโมงไม่ถูกต้อง (1–${RENT_MAX_HOURS})` }, 400];
  const out = await retry(() => rentOnce({ user, d: { ...data, hours }, fs, now }));
  const [body, status] = out;
  if (!status && body.rental) later(discord(fs, fetchFn, { title: '🔑 มีการเช่าไอดีใหม่', fields: [
    { name: 'สินค้า', value: body.rental.productName }, { name: 'ระยะเวลา', value: `${body.rental.hours} ชม.`, inline: true },
    { name: 'ค่าเช่า', value: `฿${money(body.rental.price)}`, inline: true }, { name: 'มัดจำ', value: `฿${money(body.rental.deposit)}`, inline: true }, { name: 'ผู้เช่า', value: user.name || user.email }] }));
  return out;
}

const OWN_RENTAL = [{ error: 'ไม่พบรายการเช่านี้' }, 404];
const rentalId = (d) => (typeof d.rentalId === 'string' && /^[\w-]{1,64}$/.test(d.rentalId) ? d.rentalId : '');

async function extendOnce({ user, d, fs, now }) {
  const tx = await fs.begin();
  let committed = false;
  try {
    const [rental, profile] = await Promise.all([fs.get(`rentals/${d.rentalId}`, tx), fs.get(`users/${user.uid}`, tx)]);
    if (!rental || rental.uid !== user.uid) return OWN_RENTAL;
    if (rental.status !== 'active' || now >= num(rental.endMs)) return [{ error: 'หมดเวลาเช่าแล้ว ต่อเวลาไม่ได้ กรุณาเช่าใหม่' }, 409];
    const product = await fs.get(`products/${rental.productId}`, tx);
    const rate = num(product?.rentHourPrice);
    if (!(rate > 0)) return [{ error: 'ไอดีนี้ไม่เปิดให้ต่อเวลา' }, 400];
    const price = r2(d.hours * rate);
    if (d.expectedAmount != null && Math.abs(num(d.expectedAmount) - price) > 0.01) return [{ error: `ราคาเปลี่ยนเป็น ฿${money(price)} กรุณาตรวจสอบอีกครั้ง` }, 409];
    const balance = r2(num(profile?.walletBalance));
    if (balance < price) return [{ error: `เครดิตไม่พอ (คงเหลือ ฿${money(balance)})` }, 400];
    const endMs = num(rental.endMs) + d.hours * 3600e3;
    await fs.commit([
      ...walletWrites(fs, user.uid, balance, balance - price, `ต่อเวลาเช่า ${rental.productName} +${d.hours} ชม.`),
      { update: { name: fs.name(`rentals/${d.rentalId}`), fields: fs.fields({ endMs }) }, updateMask: { fieldPaths: ['endMs'] }, updateTransforms: [inc('hours', d.hours), inc('price', price), inc('extended', 1)], currentDocument: { exists: true } }
    ], tx);
    committed = true;
    return [{ status: 'active', endMs, charged: price, balance: r2(balance - price) }];
  } finally { if (!committed) await fs.rollback(tx); }
}
async function routeRentExtend({ user, data, fs, now }) {
  const id = rentalId(data), hours = rentHours(data.hours);
  if (!id) return OWN_RENTAL;
  if (!hours) return [{ error: `จำนวนชั่วโมงไม่ถูกต้อง (1–${RENT_MAX_HOURS})` }, 400];
  return retry(() => extendOnce({ user, d: { ...data, rentalId: id, hours }, fs, now }));
}

/** Rental ran out: lock the ID (cooldown) and mark the rental expired. The deposit stays held until an admin decides. */
async function expireRental(fs, id, r) {
  await fs.commit([
    { update: { name: fs.name(`rentals/${id}`), fields: fs.fields({ status: 'expired' }) }, updateMask: { fieldPaths: ['status'] }, updateTransforms: [stamp('expiredAt')], currentDocument: { exists: true } },
    { update: { name: fs.name(`products/${r.productId}/stock_items/${r.stockItemId}`), fields: fs.fields({ status: 'cooldown' }) }, updateMask: { fieldPaths: ['status'] }, currentDocument: { exists: true } }
  ]);
}

async function routeRentCredentials({ user, data, fs, now }) {
  const id = rentalId(data);
  const r = id ? await fs.get(`rentals/${id}`) : null;
  if (!r || r.uid !== user.uid) return OWN_RENTAL;
  if (r.status !== 'active') return [{ error: 'การเช่านี้สิ้นสุดแล้ว ดูรหัสไม่ได้' }, 403];
  if (now >= num(r.endMs)) { await expireRental(fs, id, r); return [{ error: 'หมดเวลาเช่าแล้ว ดูรหัสไม่ได้' }, 403]; }
  const item = await fs.get(`products/${r.productId}/stock_items/${r.stockItemId}`);
  if (!item) return [{ error: 'ไม่พบไอดี กรุณาติดต่อแอดมิน' }, 404];
  await fs.commit([{ update: { name: fs.name(`rentals/${id}`) }, updateMask: { fieldPaths: [] }, updateTransforms: [inc('viewCount', 1), stamp('lastViewAt')], currentDocument: { exists: true } }]);
  return [{ username: String(item.username || ''), password: String(item.password || ''), endMs: num(r.endMs) }];
}

async function routeRentReturn({ user, data, fs, fetchFn, now, later }) {
  const id = rentalId(data);
  const r = id ? await fs.get(`rentals/${id}`) : null;
  if (!r || r.uid !== user.uid) return OWN_RENTAL;
  if (r.status !== 'active') return [{ error: 'การเช่านี้สิ้นสุดแล้ว' }, 409];
  const problem = data.problem === true;
  const note = str(data.note, 300);
  await fs.commit([
    { update: { name: fs.name(`rentals/${id}`), fields: fs.fields({ status: 'returned', returnedMs: now, problem, ...(note ? { note } : {}) }) }, updateMask: { fieldPaths: ['status', 'returnedMs', 'problem', ...(note ? ['note'] : [])] }, currentDocument: { exists: true } },
    { update: { name: fs.name(`products/${r.productId}/stock_items/${r.stockItemId}`), fields: fs.fields({ status: 'cooldown' }) }, updateMask: { fieldPaths: ['status'] }, currentDocument: { exists: true } }
  ]);
  later(discord(fs, fetchFn, { title: problem ? '⚠️ ลูกค้าแจ้งปัญหาไอดีเช่า' : '↩️ ลูกค้าคืนไอดีเช่า รอตรวจ', fields: [
    { name: 'สินค้า', value: String(r.productName) }, { name: 'ผู้เช่า', value: user.name || user.email }, ...(note ? [{ name: 'หมายเหตุ', value: note }] : [])] }));
  return [{ status: 'returned' }];
}

/** Admin closes a returned / expired rental: deposit back or kept, and the ID goes back on the shelf (optionally with a new password). */
const PERMS = ['orders', 'pay', 'products', 'promos', 'rentals', 'boxes', 'vault', 'users'];
async function routeAdminRent({ user, data, fs, now }) {
  if (!user.admin && !user.perms.includes('rentals')) return [{ error: 'เฉพาะผู้ดูแลระบบ' }, 403];
  const id = rentalId(data);
  if (!id) return OWN_RENTAL;
  if (!['refund', 'forfeit'].includes(data.action)) return [{ error: 'คำสั่งไม่ถูกต้อง' }, 400];
  return retry(async () => {
    const tx = await fs.begin();
    let committed = false;
    try {
      const r = await fs.get(`rentals/${id}`, tx);
      if (!r) return OWN_RENTAL;
      if (!['returned', 'expired'].includes(r.status)) return [{ error: r.status === 'active' ? 'ยังอยู่ในช่วงเช่า' : 'ปิดรายการนี้แล้ว' }, 409];
      const refund = data.action === 'refund' && num(r.deposit) > 0 ? r2(r.deposit) : 0;
      const writes = [{ update: { name: fs.name(`rentals/${id}`), fields: fs.fields({ status: 'closed', depositStatus: num(r.deposit) > 0 ? (refund ? 'refunded' : 'forfeited') : 'none' }) }, updateMask: { fieldPaths: ['status', 'depositStatus'] }, updateTransforms: [stamp('closedAt')], currentDocument: { exists: true } }];
      if (refund) {
        const profile = await fs.get(`users/${r.uid}`, tx);
        const before = r2(num(profile?.walletBalance));
        writes.push(...walletWrites(fs, r.uid, before, before + refund, `คืนมัดจำเช่า ${r.productName}`));
      }
      const fresh = {};
      if (str(data.username)) fresh.username = str(data.username);
      if (str(data.password)) fresh.password = str(data.password, 200);
      writes.push(
        { update: { name: fs.name(`products/${r.productId}/stock_items/${r.stockItemId}`), fields: fs.fields({ status: data.keepLocked === true ? 'cooldown' : 'available', rentalId: null, ...fresh }) }, updateMask: { fieldPaths: ['status', 'rentalId', ...Object.keys(fresh)] }, currentDocument: { exists: true } },
        ...(data.keepLocked === true ? [] : [{ update: { name: fs.name(`products/${r.productId}`) }, updateMask: { fieldPaths: [] }, updateTransforms: [inc('stock', 1), stamp('updatedAt')], currentDocument: { exists: true } }])
      );
      await fs.commit(writes, tx);
      committed = true;
      return [{ ok: true, refunded: refund }];
    } finally { if (!committed) await fs.rollback(tx); }
  });
}

/** Cron: every few minutes lock the IDs whose rental time is up and tell the admin to change the passwords. */
/** Daily: "people who bought X also bought Y". Pairs of products bought by the same customer, top 3 per product (seen at least twice), written to system/related for the product page. */
export async function sweepRelated(env, { fetchFn = fetch, now = Date.now() } = {}) {
  const sa = JSON.parse(env.SERVICE_ACCOUNT || '{}');
  if (!sa.project_id) return 0;
  const fs = fsClient(sa.project_id, await accessToken(sa, fetchFn, now), fetchFn);
  const sales = {}, since = now - 30 * 864e5;
  const mine = new Map(); // shortcut: reads up to 1000 completed orders, not the whole history; page through them (or keep a counter doc) once the shop has more
  for (const o of await fs.query('', 'orders', [['status', 'EQUAL', 'completed']], { limit: 1000 })) {
    const d = o.data;
    if (d.productId && d.paymentMethod !== 'prize' && Date.parse(d.createdAt) >= since) sales[d.productId] = (sales[d.productId] || 0) + (d.isAmmo ? 1 : num(d.receiveQty) || num(d.quantity) || 1); // ammo orders count once, not per กอง
    if (!d.userId || !d.productId || d.paymentMethod === 'prize' || d.isAmmo) continue;
    if (!mine.has(d.userId)) mine.set(d.userId, new Set());
    mine.get(d.userId).add(String(d.productId));
  }
  const co = {};
  for (const set of mine.values()) { const ids = [...set].slice(0, 20); for (const a of ids) for (const b of ids) if (a !== b) ((co[a] ||= {})[b] = (co[a][b] || 0) + 1); }
  const map = {};
  for (const [a, row] of Object.entries(co)) { const top = Object.entries(row).filter(x => x[1] >= 2).sort((x, y) => y[1] - x[1]).slice(0, 3).map(x => x[0]); if (top.length) map[a] = top; }
  await fs.commit([{ update: { name: fs.name('system/related'), fields: fs.fields({ map, sales, at: now }) } }]);
  return Object.keys(map).length;
}

/** Daily (cron, first run after 00:00 Thailand time): ammo products whose `stock` differs from the real sum of available + reserved IDs -> Discord. Only reports, never fixes. */
export async function sweepStock(env, { fetchFn = fetch, now = Date.now() } = {}) {
  const sa = JSON.parse(env.SERVICE_ACCOUNT || '{}');
  if (!sa.project_id) return 0;
  const fs = fsClient(sa.project_id, await accessToken(sa, fetchFn, now), fetchFn);
  const bad = [];
  for (const p of (await fs.query('', 'products')).filter(x => x.data.isAmmo === true)) {
    const rows = [...await fs.query(`products/${p.id}`, 'stock_items', [['status', 'EQUAL', 'available']], { limit: 5000 }), ...await fs.query(`products/${p.id}`, 'stock_items', [['status', 'EQUAL', 'reserved']], { limit: 1000 })];
    const real = rows.reduce((t, r) => t + num(r.data.ammo), 0);
    if (real !== num(p.data.stock)) bad.push(`• ${p.data.name}: ตัวเลขบนสินค้า ${num(p.data.stock)} กอง แต่ไอดีจริง ${real} กอง`);
  }
  if (bad.length) await discord(fs, fetchFn, { title: '⚠️ สต็อกไก่กระสุนไม่ตรงกัน', description: bad.join('\n') + '\nเปิดหลังบ้าน › สต็อก ของสินค้านั้นเพื่อให้ระบบปรับให้ตรง' });
  return bad.length;
}
/** Back-in-stock: pushes everyone in stock_watch whose product has stock again, then removes the row (one ping per request). Runs on the 5-minute cron. */
export async function sweepRestock(env, { fetchFn = fetch, now = Date.now() } = {}) {
  const sa = JSON.parse(env.SERVICE_ACCOUNT || '{}');
  if (!sa.project_id) return 0;
  const fs = fsClient(sa.project_id, await accessToken(sa, fetchFn, now), fetchFn);
  const watches = (await fs.query('', 'stock_watch', [], { limit: 500 })), seen = new Map();
  let n = 0;
  for (const w of watches) {
    const pid = String(w.data.productId || '');
    if (!seen.has(pid)) seen.set(pid, await fs.get(`products/${pid}`));
    const p = seen.get(pid);
    if (!p || p.active === false || num(p.stock) <= 0 || num(p.dropAt) > now) continue; // a timed drop is announced when it opens, not when the stock is loaded
    await pushTo(fs, fetchFn, w.data.uid, { title: p.dropAt ? 'เปิดขายแล้ว 🔥' : 'มีของแล้ว 🎉', body: `${str(p.name, 80)} กลับมาพร้อมขาย`, url: `/front/product.html?id=${encodeURIComponent(pid)}`, tag: `restock-${pid}` }, now);
    await fs.commit([{ delete: fs.name(w.path) }]); n++;
  }
  return n;
}
/** Timed sale: products with salePrice + saleFrom/saleTo get `price` swapped while the window is open (basePrice keeps the real one). Runs on the 5-minute cron. */
export async function sweepSales(env, { fetchFn = fetch, now = Date.now() } = {}) {
  const sa = JSON.parse(env.SERVICE_ACCOUNT || '{}');
  if (!sa.project_id) return 0;
  const fs = fsClient(sa.project_id, await accessToken(sa, fetchFn, now), fetchFn);
  let n = 0;
  for (const p of await fs.query('', 'products')) {
    const d = p.data, live = num(d.salePrice) > 0 && num(d.salePrice) < num(d.basePrice || d.price) && (!num(d.saleFrom) || now >= num(d.saleFrom)) && (!num(d.saleTo) || now <= num(d.saleTo));
    if (live && d.saleOn !== true) {
      await fs.commit([{ update: { name: fs.name(`products/${p.id}`), fields: fs.fields({ basePrice: num(d.price), price: num(d.salePrice), saleOn: true }) }, updateMask: { fieldPaths: ['basePrice', 'price', 'saleOn'] }, currentDocument: { exists: true } }]); n++;
      for (const w of (await fs.query('', 'price_watch', [['productId', 'EQUAL', p.id]])).slice(0, 500)) // people who asked to hear about a price drop
        await pushTo(fs, fetchFn, w.data.uid, { title: 'ลดราคาแล้ว 🔔', body: `${str(d.name, 80)} เหลือ ฿${money(num(d.salePrice))} (ปกติ ฿${money(num(d.price))})`, url: `/front/product.html?id=${encodeURIComponent(p.id)}`, tag: `sale-${p.id}` }, now);
    }
    else if (!live && d.saleOn === true) await fs.commit([{ update: { name: fs.name(`products/${p.id}`), fields: fs.fields({ price: num(d.basePrice) || num(d.price), saleOn: false }) }, updateMask: { fieldPaths: ['price', 'saleOn'] }, currentDocument: { exists: true } }]), n++;
  }
  return n;
}
export async function sweepRentals(env, { fetchFn = fetch, now = Date.now() } = {}) {
  const sa = JSON.parse(env.SERVICE_ACCOUNT || '{}');
  if (!sa.project_id) return 0;
  const fs = fsClient(sa.project_id, await accessToken(sa, fetchFn, now), fetchFn);
  const due = (await fs.query('', 'rentals', [['status', 'EQUAL', 'active']])).filter(x => now >= num(x.data.endMs));
  for (const x of due) await expireRental(fs, x.id, x.data);
  if (due.length) await discord(fs, fetchFn, { title: `⏰ หมดเวลาเช่า ${due.length} รายการ`, description: due.map(x => `• ${x.data.productName} — ${x.data.nameMask || ''}`).join('\n').slice(0, 1500), fields: [{ name: 'ต้องทำ', value: 'เปลี่ยนรหัสผ่านไอดีในเกม แล้วกดยืนยันในแท็บ "การเช่า" เพื่อคืนมัดจำและเปิดให้เช่าต่อ' }] });
  return due.length;
}

// ---------- POST /admin/user ----------
async function routeAdminUser({ user, data, sa, fetchFn, now }) {
  if (!user.admin) return [{ error: 'เฉพาะผู้ดูแลระบบ' }, 403];
  const uid = String(data.uid || '');
  if (!/^[\w-]{1,128}$/.test(uid)) return [{ error: 'uid ไม่ถูกต้อง' }, 400];
  if (uid === user.uid && (data.admin === false || data.disabled === true || Array.isArray(data.perms))) return [{ error: 'ห้ามลดสิทธิ์หรือระงับบัญชีของตัวเอง' }, 400];
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
  if (typeof data.admin === 'boolean' || Array.isArray(data.perms)) {
    const look = await call('accounts:lookup', { localId: [uid] });
    let attrs = {};
    try { attrs = JSON.parse(look.users?.[0]?.customAttributes || '{}'); } catch (_) {}
    if (typeof data.admin === 'boolean') { if (data.admin) attrs.admin = true; else delete attrs.admin; }
    if (Array.isArray(data.perms)) { const p = PERMS.filter(x => data.perms.includes(x)); if (p.length) attrs.perms = p; else delete attrs.perms; }
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

// ---------- vault access: bought with credit (prices from system/settings.vaultPackages) or a one-time free trial (vaultTrialDays) ----------
async function vaultOnce({ user, d, fs, now }) {
  const tx = await fs.begin();
  let committed = false;
  try {
    const [profile, st] = await Promise.all([fs.get(`users/${user.uid}`, tx), fs.get('system/settings', tx)]);
    if (profile?.status === 'suspended') return [{ error: 'บัญชีนี้ถูกระงับการใช้งาน' }, 403];
    const days = d.trial ? Math.floor(num(st?.vaultTrialDays)) : Math.floor(num(d.days));
    const pack = d.trial ? null : (Array.isArray(st?.vaultPackages) ? st.vaultPackages : []).find(p => Math.floor(num(p.days)) === days && num(p.price) > 0);
    if (d.trial ? !(days > 0) : !pack) return [{ error: d.trial ? 'ตอนนี้ยังไม่มีโปรทดลองใช้ฟรี' : 'ไม่พบแพ็กเกจนี้' }, 404];
    if (d.trial && profile?.vaultTrialUsed === true) return [{ error: 'คุณใช้สิทธิ์ทดลองฟรีไปแล้ว' }, 409];
    const price = d.trial ? 0 : r2(num(pack.price));
    if (!d.trial && d.expectedAmount != null && Math.abs(num(d.expectedAmount) - price) > 0.01) return [{ error: `ราคาเปลี่ยนเป็น ฿${money(price)} กรุณาตรวจสอบอีกครั้ง` }, 409];
    const balance = r2(num(profile?.walletBalance));
    if (balance < price) return [{ error: `เครดิตไม่พอ ต้องใช้ ฿${money(price)} (คงเหลือ ฿${money(balance)})` }, 400];
    const until = Math.max(now, Date.parse(profile?.vaultUntil) || 0) + days * 864e5; // renewing stacks onto the days left
    const fields = { vaultUntil: new Date(until), ...(d.trial ? { vaultTrialUsed: true } : { walletBalance: r2(balance - price) }) };
    await fs.commit([
      { update: { name: fs.name(`users/${user.uid}`), fields: fs.fields(fields) }, updateMask: { fieldPaths: Object.keys(fields) }, currentDocument: { exists: true } },
      ...(d.trial ? [] : [walletWrites(fs, user.uid, balance, balance - price, `ซื้อสิทธิ์คลังไอดี ${days} วัน`)[1]]),
      { update: { name: fs.name(`vault_sales/${randomId()}`), fields: fs.fields({ uid: user.uid, email: user.email || '', days, price, trial: !!d.trial, by: 'customer', until: new Date(until) }) }, updateTransforms: [stamp('at')] }
    ], tx);
    committed = true;
    return [{ vaultUntil: until, charged: price, balance: r2(balance - price) }];
  } finally { if (!committed) await fs.rollback(tx); }
}
const routeVaultBuy = ({ user, data, fs, now }) => retry(() => vaultOnce({ user, d: data, fs, now }));

// vault_codes/{CODE} (back office): { days, maxUses (0 = no limit), used, active, expiresAt? }. One use per account.
async function codeOnce({ user, code, fs, now }) {
  const tx = await fs.begin();
  let committed = false;
  try {
    const [profile, c, mine] = await Promise.all([fs.get(`users/${user.uid}`, tx), fs.get(`vault_codes/${code}`, tx), fs.get(`vault_codes/${code}/uses/${user.uid}`, tx)]);
    if (profile?.status === 'suspended') return [{ error: 'บัญชีนี้ถูกระงับการใช้งาน' }, 403];
    const days = Math.floor(num(c?.days));
    if (!c || c.active === false || !(days > 0) || (c.expiresAt && Date.parse(c.expiresAt) < now)) return [{ error: 'ไม่พบโค้ดนี้ หรือโค้ดหมดอายุแล้ว' }, 404];
    if (num(c.maxUses) > 0 && num(c.used) >= num(c.maxUses)) return [{ error: 'โค้ดนี้ถูกใช้ครบแล้ว' }, 409];
    if (mine) return [{ error: 'บัญชีนี้ใช้โค้ดนี้ไปแล้ว' }, 409];
    const until = Math.max(now, Date.parse(profile?.vaultUntil) || 0) + days * 864e5;
    await fs.commit([
      { update: { name: fs.name(`users/${user.uid}`), fields: fs.fields({ vaultUntil: new Date(until) }) }, updateMask: { fieldPaths: ['vaultUntil'] }, currentDocument: { exists: true } },
      { update: { name: fs.name(`vault_codes/${code}`) }, updateMask: { fieldPaths: [] }, updateTransforms: [inc('used', 1)], currentDocument: { exists: true } },
      { update: { name: fs.name(`vault_codes/${code}/uses/${user.uid}`), fields: fs.fields({ email: user.email || '' }) }, updateTransforms: [stamp('at')], currentDocument: { exists: false } },
      { update: { name: fs.name(`vault_sales/${randomId()}`), fields: fs.fields({ uid: user.uid, email: user.email || '', days, price: 0, trial: false, by: 'code', code, until: new Date(until) }) }, updateTransforms: [stamp('at')] }
    ], tx);
    committed = true;
    return [{ vaultUntil: until, days }];
  } finally { if (!committed) await fs.rollback(tx); }
}
export async function routeVaultRedeem({ user, data, fs, now }) {
  const code = String(data.code || '').trim().toUpperCase();
  if (!/^[A-Z0-9_-]{4,32}$/.test(code)) return [{ error: 'รูปแบบโค้ดไม่ถูกต้อง' }, 400];
  const key = `vcode_${user.uid}`, at = await fs.get(`slip_attempts/${key}`);
  if (at && now - num(at.at) < 3000) return [{ error: 'ทำรายการถี่เกินไป รอสักครู่' }, 429]; // slows down code guessing
  await fs.commit([{ update: { name: fs.name(`slip_attempts/${key}`), fields: fs.fields({ at: now }) } }]);
  return retry(() => codeOnce({ user, code, fs, now }));
}

// ---------- vault: team link (no login; the secret token in the link is the key) ----------
async function vaultLink(fs, data, now) {
  const token = String(data.token || '');
  const link = /^[A-Za-z0-9]{20,40}$/.test(token) ? await fs.get(`vault_links/${token}`) : null;
  if (!link) return [null, [{ error: 'ลิงก์ไม่ถูกต้องหรือถูกยกเลิกแล้ว' }, 404]];
  const owner = await fs.get(`users/${link.uid}`);
  if (!(Date.parse(owner?.vaultUntil) > now)) return [null, [{ error: 'สิทธิ์ใช้งานของหัวหน้าทีมหมดอายุ' }, 403]];
  return [link, null];
}
// Team tabs are shared with signed-in members: vault_members/{member}_{owner}_{tabId} (written only here).
// Invite by username (/vault/invite, the owner) or by an invite token (/vault/join, the member). A member reads the
// tab's rows and may change ammo / status colour / note (/vault/team, /vault/team/mark); never add, delete, move or sell.
const memberId = (member, owner, tabId) => `${member}_${owner}_${tabId}`;
const idOk = (v) => typeof v === 'string' && /^[\w-]{1,128}$/.test(v);
const nameOf = (u, fallback = '') => str(u?.username || u?.email?.split('@')[0] || fallback, 40);
async function ownerOpen(fs, owner, now) {
  const o = await fs.get(`users/${owner}`);
  return Date.parse(o?.vaultUntil) > now ? [o, null] : [null, [{ error: 'สิทธิ์ใช้งานของหัวหน้าทีมหมดอายุ' }, 403]];
}
async function addMember({ fs, owner, ownerUser, tabId, tab, member, memberUser }) {
  const id = memberId(member, owner, tabId);
  await fs.commit([{ update: { name: fs.name(`vault_members/${id}`), fields: fs.fields({ member, owner, tabId, tabName: str(tab.name, 30), ownerName: nameOf(ownerUser, 'หัวหน้า'), memberName: nameOf(memberUser, 'ลูกทีม') }) }, updateTransforms: [stamp('at')] }]);
  return id;
}
export async function routeVaultInvite({ user, data, fs, now }) {
  if (!idOk(data.tabId)) return [{ error: 'ไม่พบแท็บ' }, 400];
  const [ownerUser, err] = await ownerOpen(fs, user.uid, now); if (err) return err;
  const tab = await fs.get(`vaults/${user.uid}/tabs/${data.tabId}`);
  if (!tab || tab.zone !== 'team') return [{ error: 'เชิญได้เฉพาะแท็บทีม' }, 400];
  const want = str(data.username, 40).toLowerCase();
  if (!want) return [{ error: 'ใส่ชื่อผู้ใช้' }, 400];
  // the login name is unique; a display name is not (anyone can copy one), so it only counts when it matches one account
  const byLogin = (await fs.query('', 'users', [['email', 'EQUAL', usernameToEmail(want)]], { limit: 2 }))[0];
  const byName = byLogin ? [] : await fs.query('', 'users', [['username', 'EQUAL', str(data.username, 40)]], { limit: 2 });
  if (byName.length > 1) return [{ error: 'ชื่อนี้ซ้ำกันหลายบัญชี ใช้ชื่อที่ลูกทีมใช้ล็อกอิน หรือส่งลิงก์เชิญแทน' }, 409];
  const found = byLogin || byName[0];
  if (!found) return [{ error: 'ไม่พบผู้ใช้ชื่อนี้ (ให้ลูกทีมสมัครสมาชิกเว็บก่อน)' }, 404];
  if (found.id === user.uid) return [{ error: 'เชิญตัวเองไม่ได้' }, 400];
  const id = await addMember({ fs, owner: user.uid, ownerUser, tabId: data.tabId, tab, member: found.id, memberUser: found.data });
  return [{ ok: true, id, memberName: nameOf(found.data) }];
}
export async function routeVaultJoin({ user, data, fs, now }) {
  const [link, err] = await vaultLink(fs, data, now); if (err) return err;
  if (link.uid === user.uid) return [{ error: 'นี่คือลิงก์เชิญของคุณเอง ส่งให้ลูกทีม' }, 400];
  const tab = await fs.get(`vaults/${link.uid}/tabs/${link.tabId}`);
  if (!tab || tab.token !== String(data.token)) return [{ error: 'ลิงก์ไม่ถูกต้องหรือถูกยกเลิกแล้ว' }, 404];
  const [ownerUser, memberUser] = await Promise.all([fs.get(`users/${link.uid}`), fs.get(`users/${user.uid}`)]);
  const id = await addMember({ fs, owner: link.uid, ownerUser, tabId: link.tabId, tab, member: user.uid, memberUser: memberUser || { email: user.email } });
  return [{ ok: true, id, tabName: str(tab.name, 30) }];
}
async function memberTab(user, data, fs, now) {
  if (!idOk(data.owner) || !idOk(data.tabId)) return [null, [{ error: 'ไม่พบทีม' }, 400]];
  const m = await fs.get(`vault_members/${memberId(user.uid, data.owner, data.tabId)}`);
  if (!m) return [null, [{ error: 'คุณไม่ได้อยู่ในทีมนี้แล้ว' }, 403]];
  const [, err] = await ownerOpen(fs, data.owner, now); if (err) return [null, err];
  const tab = await fs.get(`vaults/${data.owner}/tabs/${data.tabId}`);
  if (!tab) return [null, [{ error: 'หัวหน้าลบแท็บนี้แล้ว' }, 404]];
  return [tab, null];
}
/** vaults/{owner}/meta/notify = { on, every, color, problem }: push "done N" milestones and problems to the leader's phone. */
export async function notifyLeader({ fs, fetchFn, now, owner, tabId, tab, color, who }) {
  const [cfg, meta] = await Promise.all([fs.get(`vaults/${owner}/meta/notify`), fs.get(`vaults/${owner}/meta/colors`)]);
  if (!cfg?.on) return;
  const label = (i) => str(meta?.labels?.[i], 20) || ['', 'มีปัญหา', 'กำลังทำ', 'รอตรวจ', 'เสร็จแล้ว', 'พร้อมขาย', 'จองแล้ว'][i];
  const team = `ทีม ${str(tab?.name, 30)}`, url = '/front/vault.html';
  if (color === 1 && cfg.problem !== false) return pushTo(fs, fetchFn, owner, { title: team, body: `${who} ตั้งสถานะ "${label(1)}" 1 ไอดี`, url, tag: `p-${tabId}` }, now);
  const target = Math.floor(num(cfg.color) || 4), every = Math.max(1, Math.floor(num(cfg.every) || 20));
  if (color !== target) return;
  const n = (await fs.query(`vaults/${owner}`, 'ids', [['tab', 'EQUAL', tabId], ['color', 'EQUAL', target]])).length;
  if (n > 0 && n % every === 0) return pushTo(fs, fetchFn, owner, { title: team, body: `${label(target)}ครบ ${n} ไอดีแล้ว (ล่าสุดโดย ${who})`, url, tag: `d-${tabId}` }, now);
}
export async function routeVaultTeam({ user, data, fs, now }) {
  const [tab, err] = await memberTab(user, data, fs, now); if (err) return err;
  const [ids, meta] = await Promise.all([fs.query(`vaults/${data.owner}`, 'ids', [['tab', 'EQUAL', data.tabId]]), fs.get(`vaults/${data.owner}/meta/colors`)]);
  const rows = ids.map(x => ({ id: x.id, text: String(x.data.text || ''), ammo: Math.max(0, Math.floor(num(x.data.ammo))), color: Math.max(0, Math.min(6, Math.floor(num(x.data.color)))), note: String(x.data.note || ''), pass: String(x.data.pass || '').slice(0, 100), at: num(x.data.seq) || Date.parse(x.data.createdAt) || 0 }))
    .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id)).map(({ at, ...r }) => r);
  return [{ name: String(tab.name || ''), labels: Array.isArray(meta?.labels) ? meta.labels.map(v => str(v, 20)) : [], ids: rows }];
}
export async function routeVaultMark({ user, data, fs, fetchFn, now, later }) {
  const [tab, err] = await memberTab(user, data, fs, now); if (err) return err;
  const id = String(data.id || '');
  const row = /^[\w-]{1,64}$/.test(id) ? await fs.get(`vaults/${data.owner}/ids/${id}`) : null;
  if (!row || row.tab !== data.tabId) return [{ error: 'ไม่พบไอดีนี้ (อาจถูกย้ายหรือขายไปแล้ว) กดรีเฟรช' }, 404];
  const fields = {};
  if (data.color != null) { const c = Number(data.color); if (!Number.isInteger(c) || c < 0 || c > 6) return [{ error: 'สถานะไม่ถูกต้อง' }, 400]; fields.color = c; }
  if (data.ammo != null) { const a = Number(data.ammo); if (!Number.isInteger(a) || a < 0 || a > 999999) return [{ error: 'จำนวนกระสุนไม่ถูกต้อง' }, 400]; fields.ammo = a; }
  if (data.note != null) fields.note = str(data.note, 200);
  if (!Object.keys(fields).length) return [{ ok: true }];
  await fs.commit([{ update: { name: fs.name(`vaults/${data.owner}/ids/${id}`), fields: fs.fields(fields) }, updateMask: { fieldPaths: Object.keys(fields) }, currentDocument: { exists: true } }]);
  if (fields.color != null && fields.color !== num(row.color) && later) later(notifyLeader({ fs, fetchFn, now, owner: data.owner, tabId: data.tabId, tab, color: fields.color, who: user.name || String(user.email || '').split('@')[0] }));
  return [{ ok: true }];
}


// ---------- Web Push (RFC 8291 aes128gcm + RFC 8292 VAPID), no library ----------
// The VAPID key pair is made on first use and kept in system_private/vapid; browsers subscribe with its public key.
const ub64u = (t) => { t = String(t).replace(/-/g, '+').replace(/_/g, '/'); return Uint8Array.from(atob(t + '='.repeat((4 - t.length % 4) % 4)), c => c.charCodeAt(0)); };
const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
const utf8 = (t) => new TextEncoder().encode(t);
async function vapidKeys(fs) {
  const have = await fs.get('system_private/vapid');
  if (have?.jwk && have?.pub) return have;
  const k = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const out = { jwk: JSON.stringify(await crypto.subtle.exportKey('jwk', k.privateKey)), pub: b64u(await crypto.subtle.exportKey('raw', k.publicKey)) };
  try { await fs.commit([{ update: { name: fs.name('system_private/vapid'), fields: fs.fields(out) }, currentDocument: { exists: false } }]); return out; }
  catch (e) { if (e.code === 'already-exists' || e.code === 'conflict') return fs.get('system_private/vapid'); throw e; } // two first calls at once: keep the one saved first
}
const hkdf = async (salt, ikm, info, len) => new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']), len * 8));
/** Encrypts one message for one subscription (single record, aes128gcm). */
export async function encryptPush(sub, text, { salt = crypto.getRandomValues(new Uint8Array(16)), local } = {}) {
  const ua = ub64u(sub.p256dh), auth = ub64u(sub.auth);
  local ||= await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', ua, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256));
  const ikm = await hkdf(auth, shared, cat(utf8('WebPush: info\0'), ua, asPub), 32);
  const cek = await hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16), nonce = await hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const body = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, cat(utf8(text), new Uint8Array([2]))));
  return cat(salt, new Uint8Array([0, 0, 16, 0]), new Uint8Array([65]), asPub, body); // header: salt | rs=4096 | idlen | keyid
}
export async function vapidAuth(endpoint, keys, now) {
  const jwt = (o) => b64u(utf8(JSON.stringify(o)));
  const head = `${jwt({ typ: 'JWT', alg: 'ES256' })}.${jwt({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: 'mailto:admin@astraphex.panderx.xyz' })}`;
  const key = await crypto.subtle.importKey('jwk', JSON.parse(keys.jwk), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, utf8(head));
  return `vapid t=${head}.${b64u(sig)}, k=${keys.pub}`;
}
/** Sends { title, body, url } to every device the user turned notifications on for. Dead subscriptions are removed. */
export async function pushTo(fs, fetchFn, uid, msg, now = Date.now()) {
  const subs = await fs.query('', 'push_subs', [['uid', 'EQUAL', uid]]);
  if (!subs.length) return 0;
  const keys = await vapidKeys(fs);
  let sent = 0;
  await Promise.all(subs.map(async ({ id, data: sub }) => {
    try {
      const res = await fetchFn(sub.endpoint, { method: 'POST', headers: { authorization: await vapidAuth(sub.endpoint, keys, now), 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', ttl: '86400', urgency: 'high' }, body: await encryptPush(sub, JSON.stringify(msg)) });
      if (res.status === 404 || res.status === 410) await fs.commit([{ delete: fs.name(`push_subs/${id}`) }]);
      else if (res.ok) sent++;
      else console.warn('push', res.status, await res.text().catch(() => ''));
    } catch (e) { console.warn('push failed', e); }
  }));
  return sent;
}
const routePushKey = async ({ fs }) => [{ key: (await vapidKeys(fs)).pub }];
/** Back office pressed เริ่มทำงาน / ส่งมอบสำเร็จ on a service order: tell the customer, and on start tell the next one in line. Each message once. */
export async function routePushQueue({ user, data, fs, fetchFn, now }) {
  if (!user.admin && !user.perms.includes('orders')) return [{ error: 'ไม่มีสิทธิ์' }, 403];
  const id = String(data.orderId || ''), ev = data.event;
  if (!/^[\w-]{1,64}$/.test(id) || !['start', 'done', 'paid'].includes(ev)) return [{ error: 'คำขอไม่ถูกต้อง' }, 400];
  const o = await fs.get(`orders/${id}`);
  if (ev === 'paid') { // slip / angpao order approved by hand: tell the buyer once
    if (!o || !o.userId || !['processing', 'completed'].includes(o.status)) return [{ ok: true, skipped: 'state' }];
    try { await fs.commit([{ update: { name: fs.name(`notify_log/q_paid_${id}`), fields: fs.fields({ by: user.uid }) }, updateTransforms: [stamp('at')], currentDocument: { exists: false } }]); } catch (e) { if (e.code === 'already-exists' || e.code === 'conflict') return [{ ok: true, skipped: 'dup' }]; throw e; }
    return [{ ok: true, sent: await pushTo(fs, fetchFn, o.userId, { title: 'ยืนยันการชำระเงินแล้ว ✓', body: `${str(o.productName, 80)} ${o.status === 'completed' ? 'ส่งมอบแล้ว ดูไอดีได้ที่ออเดอร์ของฉัน' : 'เข้าคิวเรียบร้อย'}`, url: '/front/account.html#orders', tag: `paid-${id}` }, now) }];
  }
  if (!o || o.productType !== 'service' || o.queueStatus !== (ev === 'start' ? 'working' : 'done')) return [{ ok: true, skipped: 'state' }];
  const once = async (key) => { try { await fs.commit([{ update: { name: fs.name(`notify_log/${key}`), fields: fs.fields({ by: user.uid }) }, updateTransforms: [stamp('at')], currentDocument: { exists: false } }]); return true; } catch (e) { if (e.code === 'already-exists' || e.code === 'conflict') return false; throw e; } };
  const what = `${str(o.productName, 80)} ${num(o.receiveQty) || num(o.quantity)} ${str(o.unit, 10)}`.trim(), url = '/front/account.html#orders';
  let sent = 0;
  if (await once(`q_${ev}_${id}`)) sent += await pushTo(fs, fetchFn, o.userId, ev === 'start'
    ? { title: 'ถึงคิวของคุณแล้ว', body: `ทีมงานเริ่มทำ ${what} แล้ว`, url, tag: `q-${id}` }
    : { title: 'งานเสร็จแล้ว ✓', body: `${what} ส่งมอบเรียบร้อย`, url, tag: `q-${id}` }, now);
  if (ev === 'start') { // the oldest one still waiting for the same service is next
    const wait = (await fs.query('', 'queue', [['productId', 'EQUAL', o.productId], ['status', 'EQUAL', 'waiting']])).sort((a, b) => Date.parse(a.data.createdAt) - Date.parse(b.data.createdAt) || a.id.localeCompare(b.id));
    const nx = wait.find(q => q.id !== id && q.data.uid);
    if (nx && await once(`q_next_${nx.id}`)) sent += await pushTo(fs, fetchFn, nx.data.uid, { title: 'อีก 1 คิวถึงคุณ', body: `${str(nx.data.productName, 80)} — เตรียมพร้อมได้เลย`, url, tag: `q-${nx.id}` }, now);
  }
  return [{ ok: true, sent }];
}
const routePushTest = async ({ user, fs, fetchFn, now }) => {
  const sent = await pushTo(fs, fetchFn, user.uid, { title: 'Nugget Hub', body: 'แจ้งเตือนทำงานแล้ว 🎉', url: '/front/vault.html' }, now);
  return sent ? [{ ok: true, sent }] : [{ error: 'ไม่พบเครื่องที่เปิดแจ้งเตือน กด "เปิดแจ้งเตือนบนเครื่องนี้" ก่อน' }, 404];
};

// ---------- Loot boxes (กล่องสุ่ม) ----------
// boxes/{id} (written by the admin): { name, price, active, prizes: [{ id, label, kind, weight, rarity, ... }] }
//   kind 'credit'  amount          -> added to the wallet at once
//   kind 'account' productId       -> one available game ID of that product is sold to the player (order paid by 'prize', ฿0)
//   kind 'service' productId, qty  -> capacity is reserved now; the player then sends contact / login with /box/claim
// The prize is drawn HERE (crypto random), never in the browser. A prize that cannot be handed over right now (no ID left,
// no service capacity) is skipped by re-drawing, which gives exactly the odds among the prizes that are in stock.
const BOX_KINDS = ['credit', 'account', 'service'];
const RARITIES = ['common', 'rare', 'epic', 'legendary'];
const isServiceProd = (p) => p.productType === 'service' || String(p.category || '').startsWith('service');
export function normalizePrizes(list) {
  return (Array.isArray(list) ? list : []).map((p, i) => {
    if (!isRecord(p) || !BOX_KINDS.includes(p.kind) || !(num(p.weight) > 0)) return null;
    const out = { id: str(p.id, 40) || `p${i}`, kind: p.kind, weight: num(p.weight), rarity: RARITIES.includes(p.rarity) ? p.rarity : 'common', label: str(p.label, 80) };
    if (p.kind === 'credit') {
      out.amount = r2(num(p.amount));
      if (!(out.amount > 0)) return null;
      if (!out.label) out.label = `เครดิต ฿${money(out.amount)}`;
      return out;
    }
    if (!/^[\w-]{1,128}$/.test(String(p.productId || ''))) return null;
    out.productId = String(p.productId);
    if (p.kind === 'service') { out.qty = Math.max(1, Math.floor(num(p.qty)) || 1); out.claimMode = p.claimMode === 'self' ? 'self' : 'with_id'; }
    return out;
  }).filter(Boolean);
}
const secureRandom = () => { const a = new Uint32Array(2); crypto.getRandomValues(a); return (a[0] * 2 ** 21 + (a[1] >>> 11)) / 2 ** 53; }; // [0, 1)
export function pickPrize(prizes, rnd = secureRandom) {
  const total = prizes.reduce((a, p) => a + p.weight, 0);
  if (!(total > 0)) return null;
  let x = rnd() * total;
  for (const p of prizes) { if (x < p.weight) return p; x -= p.weight; }
  return prizes[prizes.length - 1];
}
const boxId = (d) => (typeof d.boxId === 'string' && /^[\w-]{1,128}$/.test(d.boxId) ? d.boxId : '');

const RARITY_RANK = { common: 0, rare: 1, epic: 2, legendary: 3 };
export async function boxOpenOnce({ user, d, fs, now, rnd = secureRandom }) {
  const tx = await fs.begin();
  let committed = false;
  try {
    const [profile, box] = await Promise.all([fs.get(`users/${user.uid}`, tx), fs.get(`boxes/${d.boxId}`, tx)]);
    if (profile?.status === 'suspended') return [{ error: 'บัญชีนี้ถูกระงับการใช้งาน' }, 403];
    if (!box || box.active === false) return [{ error: 'ไม่พบกล่องนี้ หรือปิดให้เล่นชั่วคราว' }, 404];
    const price = r2(num(box.price));
    if (!(price > 0)) return [{ error: 'กล่องนี้ยังไม่ได้ตั้งราคา' }, 400];
    // a gift ticket opens a box for free: one ticket per call, counted down in this same transaction
    const giftCode = /^[\w-]{10,40}$/.test(String(d.giftCode || '')) ? String(d.giftCode) : '', gift = giftCode ? await fs.get(`box_gifts/${giftCode}`, tx) : null;
    if (giftCode && (!gift || gift.status !== 'open' || num(gift.left) < 1 || gift.boxId !== d.boxId || num(gift.expiresAt) < now)) return [{ error: 'ตั๋วของขวัญนี้ใช้ไม่ได้แล้ว (ใช้ครบ หมดอายุ หรือถูกยกเลิก)' }, 409];
    const charge = gift ? 0 : price;
    if (d.expectedPrice != null && Math.abs(num(d.expectedPrice) - price) > 0.01) return [{ error: `ราคากล่องเปลี่ยนเป็น ฿${money(price)} กรุณาตรวจสอบอีกครั้ง` }, 409];
    const balance = r2(num(profile?.walletBalance));
    if (balance < charge) return [{ error: `เครดิตไม่พอ ต้องใช้ ฿${money(price)} (คงเหลือ ฿${money(balance)})` }, 400];
    const prizes = normalizePrizes(box.prizes);
    if (!prizes.length) return [{ error: 'กล่องนี้ยังไม่ได้ตั้งของรางวัล' }, 400];
    // pity: after `pityEvery - 1` opens without a prize of rarity pityRarity or better, the next open is drawn only from those (if any can be handed over)
    const pityEvery = Math.floor(num(box.pityEvery)), pityMin = RARITY_RANK[box.pityRarity] ?? 2, pityPath = `box_pity/${user.uid}_${d.boxId}`;
    const miss = pityEvery > 1 ? num((await fs.get(pityPath, tx))?.miss) : 0, guaranteed = pityEvery > 1 && miss >= pityEvery - 1 && prizes.some(p => (RARITY_RANK[p.rarity] ?? 0) >= pityMin);

    // draw; skip what cannot be delivered right now
    const products = new Map();
    const productOf = async (pid) => { if (!products.has(pid)) products.set(pid, await fs.get(`products/${pid}`, tx)); return products.get(pid); };
    let pool = guaranteed ? prizes.filter(p => (RARITY_RANK[p.rarity] ?? 0) >= pityMin) : prizes, prize = null, product = null, item = null, relaxed = false;
    while (pool.length && !prize) {
      const c = pickPrize(pool, rnd);
      let ok = true;
      if (c.kind !== 'credit') {
        const pr = await productOf(c.productId);
        if (!pr) ok = false;
        else if (c.kind === 'account') {
          ok = !isServiceProd(pr);
          if (ok) { item = (await fs.query(`products/${c.productId}`, 'stock_items', [['status', 'EQUAL', 'available']], { limit: 1, tx }))[0] || null; ok = !!item; }
        } else ok = isServiceProd(pr) && num(pr.stock) >= c.qty;
        if (ok) product = pr;
      }
      if (ok) prize = c; else pool = pool.filter(x => x !== c);
      if (!pool.length && !prize && guaranteed && !relaxed) { relaxed = true; pool = prizes; } // nothing good can be handed over right now: fall back to the normal draw
    }
    if (!prize) return [{ error: 'ของรางวัลในกล่องนี้หมดชั่วคราว กรุณาลองใหม่ภายหลัง' }, 409];

    const openId = randomId();
    const username = profile?.username || user.name || user.email.split('@')[0];
    const afterPay = r2(balance - charge);
    const finalBalance = prize.kind === 'credit' ? r2(afterPay + prize.amount) : afterPay;
    const boxName = str(box.name, 120);
    const label = prize.label || (prize.kind === 'credit' ? '' : str(product?.name, 80));
    const writes = [
      { update: { name: fs.name(`users/${user.uid}`), fields: fs.fields({ walletBalance: finalBalance }) }, updateMask: { fieldPaths: ['walletBalance'] }, currentDocument: { exists: true } },
      { update: { name: fs.name(`wallet_logs/${randomId()}`), fields: fs.fields({ uid: user.uid, before: balance, after: afterPay, delta: -price, note: `เปิดกล่องสุ่ม ${boxName}`, by: 'system' }) }, updateTransforms: [stamp('at')] }
    ];
    if (gift) { writes.pop(); writes.push({ update: { name: fs.name(`box_gifts/${giftCode}`), fields: fs.fields({ left: num(gift.left) - 1, status: num(gift.left) - 1 > 0 ? 'open' : 'used' }) }, updateMask: { fieldPaths: ['left', 'status'] }, updateTransforms: [stamp('lastUsedAt')], currentDocument: { exists: true } }); } // free open: no debit, count the ticket down
    const open = { uid: user.uid, userEmail: user.email, boxId: d.boxId, boxName, price, ...(gift ? { giftCode } : {}), prizeId: prize.id, prizeLabel: label, kind: prize.kind, rarity: prize.rarity, status: 'delivered', balanceAfter: finalBalance };
    const out = { id: prize.id, label, kind: prize.kind, rarity: prize.rarity, needsClaim: false };

    if (prize.kind === 'credit') {
      open.amount = prize.amount; out.amount = prize.amount;
      writes.push({ update: { name: fs.name(`wallet_logs/${randomId()}`), fields: fs.fields({ uid: user.uid, before: afterPay, after: finalBalance, delta: prize.amount, note: `ได้รับเครดิตจากกล่องสุ่ม ${boxName}`, by: 'system' }) }, updateTransforms: [stamp('at')] });
    } else if (prize.kind === 'account') {
      const oid = randomId(), orderNumber = `ORD-${oid.slice(0, 8).toUpperCase()}`;
      const acc = { username: String(item.data.username || ''), password: String(item.data.password || ''), stockItemId: item.id };
      const order = {
        orderNumber, orderId: orderNumber, productId: prize.productId, productName: str(product.name, 200), productType: 'account', quantity: 1, bonusQty: 0, receiveQty: 1, unit: 'ไอดี',
        unitPrice: 0, subtotal: 0, discount: 0, promoCode: null, amount: 0, finalPrice: 0, paymentMethod: 'prize', paymentProof: `ของรางวัลจากกล่องสุ่ม ${boxName}`,
        userEmail: user.email, userId: user.uid, status: 'completed', accountsDelivered: [acc], accountDelivered: acc, prizeBox: d.boxId, prizeOpenId: openId
      };
      open.productId = prize.productId; open.productName = order.productName; open.orderId = oid; out.productName = order.productName; out.orderId = oid;
      writes.push(
        { update: { name: fs.name(`products/${prize.productId}`) }, updateMask: { fieldPaths: [] }, updateTransforms: [inc('stock', -1), stamp('updatedAt')], currentDocument: { exists: true } },
        { update: { name: fs.name(item.path), fields: fs.fields({ status: 'sold', orderId: oid }) }, updateMask: { fieldPaths: ['status', 'orderId'] }, updateTransforms: [stamp('soldAt')], currentDocument: { exists: true } },
        { update: { name: fs.name(`orders/${oid}`), fields: fs.fields(order) }, updateTransforms: [stamp('createdAt'), stamp('completedAt')], currentDocument: { exists: false } }
      );
    } else {
      open.status = 'pending_claim'; open.productId = prize.productId; open.productName = str(product.name, 200); open.qty = prize.qty; open.claimMode = prize.claimMode;
      out.needsClaim = true; out.productName = open.productName; out.qty = prize.qty; out.claimMode = prize.claimMode; out.openId = openId;
      writes.push({ update: { name: fs.name(`products/${prize.productId}`) }, updateMask: { fieldPaths: [] }, updateTransforms: [inc('stock', -prize.qty), stamp('updatedAt')], currentDocument: { exists: true } }); // capacity is held for this win
    }
    writes.push({ update: { name: fs.name(`box_opens/${openId}`), fields: fs.fields(open) }, updateTransforms: [stamp('createdAt')], currentDocument: { exists: false } });
    if (pityEvery > 1) { const hit = (RARITY_RANK[prize.rarity] ?? 0) >= pityMin; writes.push({ update: { name: fs.name(pityPath), fields: fs.fields({ uid: user.uid, boxId: d.boxId, miss: hit ? 0 : miss + 1 }) } }); out.pity = { miss: hit ? 0 : miss + 1, every: pityEvery }; }
    if (prize.rarity !== 'common') writes.push({ update: { name: fs.name(`recent_wins/${openId}`), fields: fs.fields({ boxName, prizeLabel: label, rarity: prize.rarity, buyerMask: maskName(username) }) }, updateTransforms: [stamp('createdAt')] });
    await fs.commit(writes, tx);
    committed = true;
    return [{ ok: true, openId, balance: finalBalance, price, prize: out, boxName, username }];
  } finally { if (!committed) await fs.rollback(tx); }
}

async function routeBoxOpen({ user, data, fs, fetchFn, now, later }) {
  const id = boxId(data);
  if (!id) return [{ error: 'ไม่พบกล่องนี้' }, 400];
  const out = await retry(() => boxOpenOnce({ user, d: { ...data, boxId: id }, fs, now }));
  const [body, status] = out;
  if (!status && body.prize && (body.prize.kind !== 'credit' || body.prize.rarity === 'legendary')) {
    const p = body.prize;
    later(discord(fs, fetchFn, { title: p.needsClaim ? '🎁 ลูกค้าสุ่มได้งานบริการ (รอกรอกข้อมูลรับรางวัล)' : p.kind === 'account' ? '🎁 ลูกค้าสุ่มได้ไอดีเกม' : '🎁 ลูกค้าสุ่มได้รางวัลใหญ่', fields: [
      { name: 'กล่อง', value: body.boxName, inline: true }, { name: 'รางวัล', value: `${p.label}${p.qty ? ` × ${p.qty}` : ''}`, inline: true }, { name: 'ผู้เล่น', value: user.name || user.email }] }));
  }
  if (!status) { const { boxName, username, ...rest } = body; return [rest]; }
  return out;
}

export async function boxClaimOnce({ user, d, fs, now }) {
  const tx = await fs.begin();
  let committed = false;
  try {
    const win = await fs.get(`box_opens/${d.openId}`, tx);
    if (!win || win.uid !== user.uid) return [{ error: 'ไม่พบรางวัลนี้' }, 404];
    if (win.kind !== 'service') return [{ error: 'รางวัลนี้ไม่ต้องกรอกข้อมูล' }, 400];
    if (win.status !== 'pending_claim') return [{ error: 'รางวัลนี้รับไปแล้ว' }, 409];
    const [profile, product] = await Promise.all([fs.get(`users/${user.uid}`, tx), fs.get(`products/${win.productId}`, tx)]);
    if (profile?.status === 'suspended') return [{ error: 'บัญชีนี้ถูกระงับการใช้งาน' }, 403];
    if (!product) return [{ error: 'สินค้างานบริการนี้ถูกลบไปแล้ว กรุณาติดต่อแอดมิน' }, 404];
    const cat = product.category ? await fs.get(`categories/${product.category}`, tx) : null;
    const self = win.claimMode === 'self';
    const b = { buyerFacebook: str(d.buyerFacebook), gameEmail: str(d.gameEmail), gamePassword: String(d.gamePassword || '').slice(0, 200), buyerContact: str(d.buyerContact), playTime: str(d.playTime) };
    if (b.buyerFacebook.length < 2) return [{ error: 'กรุณากรอกชื่อหรือลิงก์ Facebook' }, 400];
    if (self && (!b.buyerContact || !b.playTime)) return [{ error: 'กรุณากรอกชื่อในเกมและเวลาที่พร้อม' }, 400];
    if (!self && (!b.gameEmail.includes('@') || !b.gamePassword)) return [{ error: 'กรุณากรอกอีเมลและรหัสผ่านบัญชีเกม' }, 400];
    const modes = Array.isArray(product.farmModes) ? product.farmModes : [];
    const mode = modes.find(m => m.key === (self ? 'self' : 'with_id')) || null;
    const oid = randomId(), orderNumber = `ORD-${oid.slice(0, 8).toUpperCase()}`;
    const unit = product.serviceUnit || cat?.unit || 'กอง';
    const username = profile?.username || user.name || user.email.split('@')[0];
    const qty = Math.max(1, Math.floor(num(win.qty)) || 1);
    const order = {
      orderNumber, orderId: orderNumber, productId: win.productId, productName: mode ? `${product.name} (${mode.label})` : String(product.name || ''), productType: 'service',
      quantity: qty, bonusQty: 0, receiveQty: qty, unit, unitPrice: 0, subtotal: 0, discount: 0, promoCode: null, amount: 0, finalPrice: 0,
      paymentMethod: 'prize', paymentProof: `ของรางวัลจากกล่องสุ่ม ${win.boxName}`, userEmail: user.email, userId: user.uid, buyerFacebook: b.buyerFacebook,
      ...(self ? { buyerContact: b.buyerContact, playTime: b.playTime } : { gameEmail: b.gameEmail, gamePassword: b.gamePassword, buyerContact: b.gameEmail }),
      ...(mode ? { farmMode: mode.key } : {}),
      status: 'processing', queueStatus: 'waiting', prizeBox: win.boxId, prizeOpenId: d.openId
    };
    await fs.commit([
      { update: { name: fs.name(`orders/${oid}`), fields: fs.fields(order) }, updateTransforms: [stamp('createdAt'), stamp('paidAt')], currentDocument: { exists: false } },
      { update: { name: fs.name(`queue/${oid}`), fields: fs.fields({ orderNumber, productId: win.productId, productName: String(product.name || ''), unit, quantity: qty, nameMask: maskName(username).slice(0, 8), uid: user.uid, status: 'waiting' }) }, updateTransforms: [stamp('createdAt')] },
      { update: { name: fs.name(`box_opens/${d.openId}`), fields: fs.fields({ status: 'claimed', orderId: oid }) }, updateMask: { fieldPaths: ['status', 'orderId'] }, updateTransforms: [stamp('claimedAt')], currentDocument: { exists: true } }
    ], tx);
    committed = true;
    const { gamePassword, ...publicOrder } = order;
    return [{ ok: true, orderId: oid, order: { ...publicOrder, id: oid } }];
  } finally { if (!committed) await fs.rollback(tx); }
}

/** POST /box/gift { boxId, count }: pay for 1-10 opens now, get a code the receiver redeems with /box/open { giftCode }. 90 days; the sender can cancel for a refund. */
async function routeBoxGift({ user, data, fs, now }) {
  const id = boxId(data), count = Math.floor(num(data.count));
  if (!id || !(count >= 1 && count <= 10)) return [{ error: 'คำขอไม่ถูกต้อง' }, 400];
  return retry(async () => {
    const tx = await fs.begin(); let committed = false;
    try {
      const [profile, box] = await Promise.all([fs.get(`users/${user.uid}`, tx), fs.get(`boxes/${id}`, tx)]);
      if (profile?.status === 'suspended') return [{ error: 'บัญชีนี้ถูกระงับการใช้งาน' }, 403];
      if (!box || box.active === false || !(num(box.price) > 0)) return [{ error: 'ไม่พบกล่องนี้ หรือปิดให้เล่นชั่วคราว' }, 404];
      const price = r2(num(box.price)), total = r2(price * count), balance = r2(num(profile?.walletBalance));
      if (balance < total) return [{ error: `เครดิตไม่พอ ต้องใช้ ฿${money(total)} (คงเหลือ ฿${money(balance)})` }, 400];
      const code = randomId(), username = profile?.username || user.name || user.email.split('@')[0];
      await fs.commit([
        ...walletWrites(fs, user.uid, balance, balance - total, `ซื้อตั๋วของขวัญกล่อง ${str(box.name, 80)} ×${count}`),
        { update: { name: fs.name(`box_gifts/${code}`), fields: fs.fields({ fromUid: user.uid, fromName: maskName(username), boxId: id, boxName: str(box.name, 120), count, left: count, price, status: 'open', expiresAt: now + 90 * 864e5 }) }, updateTransforms: [stamp('createdAt')], currentDocument: { exists: false } }
      ], tx);
      committed = true;
      return [{ ok: true, code, balance: r2(balance - total) }];
    } finally { if (!committed) await fs.rollback(tx); }
  });
}
/** POST /box/gift/cancel { code }: the sender takes back the unused tickets as credit. */
async function routeBoxGiftCancel({ user, data, fs }) {
  const code = String(data.code || '');
  if (!/^[\w-]{10,40}$/.test(code)) return [{ error: 'คำขอไม่ถูกต้อง' }, 400];
  return retry(async () => {
    const tx = await fs.begin(); let committed = false;
    try {
      const g = await fs.get(`box_gifts/${code}`, tx);
      if (!g || g.fromUid !== user.uid) return [{ error: 'ไม่พบตั๋วของขวัญนี้' }, 404];
      if (g.status !== 'open' || num(g.left) < 1) return [{ error: 'ตั๋วนี้ใช้ครบหรือยกเลิกไปแล้ว' }, 409];
      const profile = await fs.get(`users/${user.uid}`, tx), balance = r2(num(profile?.walletBalance)), refund = r2(num(g.price) * num(g.left));
      await fs.commit([...walletWrites(fs, user.uid, balance, balance + refund, `คืนตั๋วของขวัญที่ไม่ได้ใช้ ${g.boxName}`),
        { update: { name: fs.name(`box_gifts/${code}`), fields: fs.fields({ status: 'cancelled', left: 0 }) }, updateMask: { fieldPaths: ['status', 'left'] }, currentDocument: { exists: true } }], tx);
      committed = true;
      return [{ ok: true, refund }];
    } finally { if (!committed) await fs.rollback(tx); }
  });
}

/** POST /admin/winback { uid, type, value, days }: a one-use personal coupon for one customer (promo_codes.onlyUid), pushed to their phone if they allowed it. */
async function routeAdminWinback({ user, data, fs, fetchFn, now }) {
  if (!user.admin && !user.perms.includes('promos')) return [{ error: 'ไม่มีสิทธิ์' }, 403];
  const uid = String(data.uid || ''), type = data.type === 'fixed' ? 'fixed' : 'percent', value = num(data.value), days = Math.floor(num(data.days));
  if (!/^[\w-]{2,128}$/.test(uid) || !(value > 0) || (type === 'percent' && value > 90) || (type === 'fixed' && value > 10000) || !(days >= 1 && days <= 90)) return [{ error: 'ข้อมูลไม่ถูกต้อง' }, 400];
  if (!(await fs.get(`users/${uid}`))) return [{ error: 'ไม่พบผู้ใช้' }, 404];
  const code = 'BACK-' + randomId().slice(0, 6).toUpperCase(), until = now + days * 864e5;
  await fs.commit([{ update: { name: fs.name(`promo_codes/${code}`), fields: fs.fields({ type, value, active: true, appliesTo: 'all', maxTotalUses: 1, maxPerUser: 1, usedCount: 0, onlyUid: uid, expiresAt: until, note: 'win-back', createdBy: user.email || user.uid }) }, updateTransforms: [stamp('createdAt')], currentDocument: { exists: false } }]);
  const sent = await pushTo(fs, fetchFn, uid, { title: 'โค้ดส่วนลดเฉพาะคุณ 🎁', body: `ใช้โค้ด ${code} ลด ${type === 'percent' ? value + '%' : '฿' + money(value)} ภายใน ${days} วัน`, url: '/front/category.html', tag: `back-${code}` }, now);
  return [{ ok: true, code, sent, until }];
}

async function routeBoxClaim({ user, data, fs, fetchFn, now, later }) {
  if (typeof data.openId !== 'string' || !/^[\w-]{1,64}$/.test(data.openId)) return [{ error: 'ไม่พบรางวัลนี้' }, 400];
  const out = await retry(() => boxClaimOnce({ user, d: data, fs, now }));
  const [body, status] = out;
  if (!status && body.order) {
    const o = body.order;
    later(discord(fs, fetchFn, { title: '🛠️ ออเดอร์บริการใหม่ (ของรางวัลกล่องสุ่ม)', fields: [
      { name: 'ออเดอร์', value: o.orderNumber, inline: true }, { name: 'สินค้า', value: `${o.productName} × ${o.quantity}` }, { name: 'ผู้เล่น', value: user.name || user.email }] }));
  }
  return out;
}

// ---------- router ----------
// ---------- Ammo bundles (ไก่กระสุน) ----------
// products/{id} with isAmmo: true, ammoRate (฿ per กอง), ammoMin, requireLogin (false = guests may buy).
// Each stock_items row is one game ID with its own ammo count. The customer asks for N กอง; the Worker picks the IDs whose
// ammo adds up to exactly N, or the closest total it can make, and the price is that real total x ammoRate.
//   POST /ammo/quote  { productId, target }            -> reserves the picked IDs for AMMO_HOLD_MS, returns the real total + price
//   POST /ammo/pay    { quoteId, method: 'wallet' | 'slip' | 'angpao', payload | link }  -> delivers the IDs (guests: slip / angpao only)
// Guests (no token) are throttled per IP; their order is stored with userId '' and the IDs come back only in the reply.
const AMMO_HOLD_MS = 15 * 60e3, AMMO_MAX_IDS = 25, AMMO_MAX_TARGET = 100000;
/** Subset of ammo counts closest to target (exact first, ties go to the bigger total), fewest IDs. Returns { idx, total } or null. */
export function matchAmmo(ammos, target, maxIds = AMMO_MAX_IDS) {
  const a = ammos.map(x => Math.max(0, Math.floor(num(x))));
  const sumAll = a.reduce((s, x) => s + x, 0);
  if (!(target > 0) || !sumAll) return null;
  const S = Math.min(sumAll, target + Math.max(...a)), n = a.length, INF = 1e9;
  const cnt = new Int32Array(S + 1).fill(INF); cnt[0] = 0;
  const take = new Uint8Array(n * (S + 1));
  for (let i = 0; i < n; i++) {
    const v = a[i]; if (!v) continue;
    for (let s = S; s >= v; s--) if (cnt[s - v] + 1 < cnt[s]) { cnt[s] = cnt[s - v] + 1; take[i * (S + 1) + s] = 1; }
  }
  let best = -1;
  for (let s = 1; s <= S; s++) {
    if (cnt[s] > maxIds) continue;
    if (best < 0) { best = s; continue; }
    const d = Math.abs(s - target), bd = Math.abs(best - target);
    if (d < bd || (d === bd && (s > best || cnt[s] < cnt[best]))) best = s;
  }
  if (best < 0) return null;
  const idx = [];
  for (let i = n - 1, s = best; i >= 0 && s > 0; i--) if (take[i * (S + 1) + s]) { idx.push(i); s -= a[i]; }
  return { idx: idx.reverse(), total: best };
}

/** Price per กอง for qty กอง: the list price minus the single best discount that applies (no stacking). Mirrored in js/ammo.js.
 *  Discounts: the flat one (ammoDiscType 'fixed' = ฿ off per กอง | 'percent', ammoDiscValue, optional window ammoDiscFrom..ammoDiscTo in ms)
 *  and ammoTiers [{ min, type, value }] (applies from min กอง up, optional window ammoTiersFrom..ammoTiersTo). A cut that would make it free is ignored. */
export function ammoRateOf(p, qty = 0, now = Date.now()) {
  const rate = num(p.ammoRate);
  const cut = (type, v) => type === 'percent' ? rate * (1 - Math.min(v, 99) / 100) : rate - v;
  const c = [];
  const live = (!num(p.ammoDiscFrom) || now >= p.ammoDiscFrom) && (!num(p.ammoDiscTo) || now <= p.ammoDiscTo);
  if (live && num(p.ammoDiscValue) > 0) c.push(cut(p.ammoDiscType, num(p.ammoDiscValue)));
  const tierLive = (!num(p.ammoTiersFrom) || now >= p.ammoTiersFrom) && (!num(p.ammoTiersTo) || now <= p.ammoTiersTo);
  for (const t of tierLive && Array.isArray(p.ammoTiers) ? p.ammoTiers : []) if (qty >= num(t.min) && num(t.value) > 0) c.push(cut(t.type, num(t.value)));
  return Math.min(rate, ...c.filter(x => x > 0));
}

const ipKey = (ip) => 'ip_' + String(ip || 'unknown').replace(/[^\w.:-]/g, '').replace(/[.:]/g, '_').slice(0, 60);
async function guestThrottle(fs, ip, kind, gapMs, now) {
  const path = `slip_attempts/${ipKey(ip)}_${kind}`;
  const a = await fs.get(path);
  if (a && now - num(a.at) < gapMs) return false;
  await fs.commit([{ update: { name: fs.name(path), fields: fs.fields({ at: now }) } }]);
  return true;
}

/** Closed by the admin switch, or inside the daily window ammoCloseFrom..ammoCloseTo ('HH:MM', Thailand time, may cross midnight). Mirrored in js/ammo.js. */
export function ammoClosedNow(shop, now) {
  if (shop?.ammoClosed === true) return true;
  const f = /^(\d\d):(\d\d)$/.exec(shop?.ammoCloseFrom || ''), t = /^(\d\d):(\d\d)$/.exec(shop?.ammoCloseTo || '');
  if (!f || !t) return false;
  const m = Math.floor(((now + 7 * 3600e3) % 864e5) / 6e4), a = +f[1] * 60 + +f[2], b = +t[1] * 60 + +t[2];
  return a === b ? false : a < b ? m >= a && m < b : m >= a || m < b;
}
async function ammoQuoteOnce({ user, d, fs, now, owner }) {
  const tx = await fs.begin();
  let committed = false;
  try {
    const product = await fs.get(`products/${d.productId}`, tx);
    if (!product || product.isAmmo !== true || product.active === false) return [{ error: 'ไม่พบสินค้านี้' }, 404];
    if (!user && product.requireLogin !== false) return [{ error: 'สินค้านี้ต้องเข้าสู่ระบบก่อนซื้อ' }, 401];
    if (user) { const prof = await fs.get(`users/${user.uid}`, tx); if (prof?.status === 'suspended') return [{ error: 'บัญชีนี้ถูกระงับการใช้งาน' }, 403]; }
    const shop = await fs.get('system/settings', tx); // admin switch: new quotes stop, quotes already made can still be paid
    if (ammoClosedNow(shop, now)) return [{ error: str(shop.ammoClosedMsg, 300) || (shop.ammoCloseFrom && shop.ammoClosed !== true ? `ปิดรับออเดอร์ไก่กระสุนช่วง ${shop.ammoCloseFrom}–${shop.ammoCloseTo} น.` : 'ปิดรับออเดอร์ไก่กระสุนชั่วคราว'), code: 'closed' }, 503];
    const rate0 = num(product.ammoRate), min = Math.max(1, Math.floor(num(product.ammoMin)) || 1);
    if (!(rate0 > 0)) return [{ error: 'สินค้านี้ยังไม่ได้ตั้งราคา' }, 400];
    if (d.target < min) return [{ error: `สั่งขั้นต่ำ ${min} กอง` }, 400];
    const parent = `products/${d.productId}`;
    const rows = [...await fs.query(parent, 'stock_items', [['status', 'EQUAL', 'available']], { limit: 2000, tx }),
      ...await fs.query(parent, 'stock_items', [['status', 'EQUAL', 'reserved']], { limit: 500, tx })]
      .filter(r => num(r.data.ammo) > 0 && (r.data.status === 'available' || num(r.data.reservedUntil) < now || r.data.reservedBy === owner));
    // matchAmmo needs ~ ids x total bytes: with a big shelf, match on an even spread (big to small) of at most `cap` IDs
    const S = Math.min(rows.reduce((t, r) => t + num(r.data.ammo), 0), d.target + Math.max(0, ...rows.map(r => num(r.data.ammo))));
    const cap = Math.max(50, Math.floor(4e7 / (S + 1)));
    const pool = rows.length > cap ? (() => { const s = [...rows].sort((a, b) => num(b.data.ammo) - num(a.data.ammo)); return Array.from({ length: cap }, (_, i) => s[Math.floor(i * s.length / cap)]); })() : rows;
    const m = matchAmmo(pool.map(r => r.data.ammo), d.target, Math.min(100, Math.max(1, Math.floor(num(product.ammoMaxIds)) || AMMO_MAX_IDS)));
    if (!m) return [{ error: rows.length ? 'จับคู่ไอดีไม่ได้ กรุณาลองจำนวนอื่น' : 'สินค้าหมด' }, 409];
    const picked = m.idx.map(i => pool[i]);
    let rate = ammoRateOf(product, m.total, now), amount = r2(m.total * rate), promoCode = '', promoDiscount = 0, promoMsg = '';
    if (d.promoCode) { // a coupon never stacks with the ammo discounts: the cheaper of the two is used (shortcut: usedCount is raised at delivery, so the quota can overshoot by a few)
      const pc = user && /^[A-Z0-9_-]{2,40}$/.test(d.promoCode) ? await fs.get(`promo_codes/${d.promoCode}`, tx) : null;
      const listSub = r2(m.total * num(product.ammoRate)), ev = evaluatePromo(pc, { ...product, id: d.productId }, listSub, user?.uid || '', now);
      if (!user) promoMsg = 'โค้ดส่วนลดใช้ได้เฉพาะสมาชิกที่เข้าสู่ระบบ';
      else if (!ev.ok) promoMsg = ev.message;
      else if (num(pc.maxPerUser) > 0 && (await fs.query('', 'orders', [['userId', 'EQUAL', user.uid], ['promoCode', 'EQUAL', d.promoCode]], { tx })).filter(o => o.data.status !== 'cancelled').length >= num(pc.maxPerUser)) promoMsg = 'คุณใช้โค้ดนี้ครบสิทธิ์แล้ว';
      else {
        const withCode = r2(listSub - ev.discount);
        if (withCode < amount) { amount = withCode; rate = amount / m.total; promoCode = d.promoCode; promoDiscount = r2(listSub - withCode); }
        else promoMsg = 'ส่วนลดไก่กระสุนถูกกว่าโค้ดนี้ จึงใช้ส่วนลดเดิมให้';
      }
    }
    const qid = randomId(), until = now + AMMO_HOLD_MS;
    // one hold per buyer: IDs this buyer held for an older quote go back on the shelf
    const freed = rows.filter(r => r.data.status === 'reserved' && r.data.reservedBy === owner && !picked.includes(r));
    const writes = [
      ...freed.map(r => ({ update: { name: fs.name(r.path), fields: fs.fields({ status: 'available', reservedUntil: 0, reservedBy: '', quoteId: '' }) }, updateMask: { fieldPaths: ['status', 'reservedUntil', 'reservedBy', 'quoteId'] }, currentDocument: { exists: true } })),
      ...picked.map(r => ({ update: { name: fs.name(r.path), fields: fs.fields({ status: 'reserved', reservedUntil: until, reservedBy: owner, quoteId: qid }) }, updateMask: { fieldPaths: ['status', 'reservedUntil', 'reservedBy', 'quoteId'] }, currentDocument: { exists: true } })),
      { update: { name: fs.name(`ammo_quotes/${qid}`), fields: fs.fields({ productId: d.productId, productName: str(product.name, 120), paths: picked.map(r => r.path), ammo: picked.map(r => num(r.data.ammo)), target: d.target, ammoTotal: m.total, rate, listRate: num(product.ammoRate), amount, ...(promoCode ? { promoCode, promoDiscount } : {}), owner, uid: user?.uid || '', expiresAt: until, status: 'open' }) }, updateTransforms: [stamp('createdAt')], currentDocument: { exists: false } }
    ];
    await fs.commit(writes, tx);
    committed = true;
    return [{ quoteId: qid, target: d.target, ammoTotal: m.total, ids: picked.length, ammo: picked.map(r => num(r.data.ammo)), rate, listRate: num(product.ammoRate), amount, expiresAt: until, ...(promoCode ? { promo: { code: promoCode, discount: promoDiscount } } : {}), ...(promoMsg ? { promoMsg } : {}) }];
  } finally { if (!committed) await fs.rollback(tx); }
}
async function routeAmmoQuote({ user, data, fs, now, ip }) {
  const target = Number(data.target);
  if (typeof data.productId !== 'string' || !/^[\w-]{1,128}$/.test(data.productId)) return [{ error: 'ไม่พบสินค้า' }, 400];
  if (!Number.isInteger(target) || target < 1 || target > AMMO_MAX_TARGET) return [{ error: 'จำนวนกองไม่ถูกต้อง' }, 400];
  if (!(await guestThrottle(fs, user ? 'u_' + user.uid : ip, 'aq', user ? 1500 : 4000, now))) return [{ error: 'ทำรายการถี่เกินไป รอสักครู่แล้วลองใหม่' }, 429];
  return retry(() => ammoQuoteOnce({ user, d: { productId: data.productId, target, promoCode: str(data.promoCode, 40).toUpperCase() }, fs, now, owner: user ? `u_${user.uid}` : ipKey(ip) }));
}

/** Deliver a paid quote in one transaction. paid = { via, ref, amount } ; for 'wallet' the balance is charged here. */
async function ammoDeliverOnce({ user, qid, fs, now, paid }) {
  const tx = await fs.begin();
  let committed = false;
  try {
    const q = await fs.get(`ammo_quotes/${qid}`, tx);
    if (!q || q.status !== 'open') return [{ error: 'รายการนี้ชำระไปแล้วหรือไม่มีอยู่' }, 409];
    if (q.uid && q.uid !== (user?.uid || '')) return [{ error: 'ไม่พบรายการ' }, 404];
    const items = await Promise.all(q.paths.map(p => fs.get(p, tx)));
    const prod = await fs.get(`products/${q.productId}`, tx);
    // still ours: reserved by this quote, or freed again and nobody took it
    if (items.some(it => !it || !(it.status === 'available' || (it.status === 'reserved' && (it.quoteId === qid || num(it.reservedUntil) < now))))) return [{ error: 'ไอดีบางตัวถูกซื้อไปแล้ว กรุณาขอราคาใหม่', code: 'stale' }, 409];
    const prof = user ? await fs.get(`users/${user.uid}`, tx) : null;
    if (prof?.status === 'suspended') return [{ error: 'บัญชีนี้ถูกระงับการใช้งาน' }, 403];
    const writes = [];
    if (paid.via === 'wallet') {
      const bal = r2(num(prof?.walletBalance));
      if (bal < q.amount) return [{ error: `เครดิตไม่พอ (คงเหลือ ฿${money(bal)})` }, 400];
      writes.push(...walletWrites(fs, user.uid, bal, bal - q.amount, `ซื้อ ${q.productName} ${q.ammoTotal} กอง`));
    }
    const oid = randomId(), orderNumber = `ORD-${oid.slice(0, 8).toUpperCase()}`;
    const accounts = items.map((it, i) => ({ username: String(it.username || ''), password: String(it.password || ''), ammo: num(it.ammo), stockItemId: q.paths[i].split('/').pop() }));
    const order = {
      orderNumber, orderId: orderNumber, productId: q.productId, productName: `${q.productName} (${q.ammoTotal} กอง)`, productType: 'account', isAmmo: true,
      quantity: accounts.length, unit: 'ไอดี', ammoTarget: q.target, ammoTotal: q.ammoTotal, unitPrice: q.rate, listUnitPrice: num(q.listRate) || q.rate, subtotal: r2(q.amount + num(q.promoDiscount)), discount: num(q.promoDiscount), promoCode: q.promoCode || null, amount: q.amount, finalPrice: q.amount,
      paymentMethod: paid.via === 'wallet' ? 'wallet' : paid.via, paymentProof: paid.ref || 'เครดิตในบัญชี', userEmail: user?.email || '', userId: user?.uid || '', guest: !user,
      status: 'completed', accountsDelivered: accounts, accountDelivered: accounts[0], ...(paid.extra ? { paidExtra: paid.extra } : {})
    };
    const buyer = user ? ((prof?.username || user.name || user.email.split('@')[0])) : 'guest';
    writes.push(
      ...q.paths.map(p => ({ update: { name: fs.name(p), fields: fs.fields({ status: 'sold', orderId: oid }) }, updateMask: { fieldPaths: ['status', 'orderId'] }, updateTransforms: [stamp('soldAt')], currentDocument: { exists: true } })),
      { update: { name: fs.name(`products/${q.productId}`) }, updateMask: { fieldPaths: [] }, updateTransforms: [inc('stock', -q.ammoTotal), stamp('updatedAt')], currentDocument: { exists: true } },
      { update: { name: fs.name(`ammo_quotes/${qid}`), fields: fs.fields({ status: 'paid', orderId: oid }) }, updateMask: { fieldPaths: ['status', 'orderId'] } },
      { update: { name: fs.name(`orders/${oid}`), fields: fs.fields(order) }, updateTransforms: [stamp('createdAt'), stamp('completedAt')], currentDocument: { exists: false } },
      { update: { name: fs.name('stats/public') }, updateMask: { fieldPaths: [] }, updateTransforms: [inc('orders', 1), inc('sales', q.amount)] },
      { update: { name: fs.name(`recent_orders/${oid}`), fields: fs.fields({ productName: order.productName.slice(0, 120), productId: q.productId, amount: q.amount, buyerMask: maskName(buyer), kind: 'account' }) }, updateTransforms: [stamp('createdAt')] }
    );
    if (q.promoCode) writes.push({ update: { name: fs.name(`promo_codes/${q.promoCode}`) }, updateMask: { fieldPaths: [] }, updateTransforms: [inc('usedCount', 1)] });
    if (user) writes.push({ update: { name: fs.name(`users/${user.uid}`), fields: fs.fields({ hasBought: true }) }, updateMask: { fieldPaths: ['hasBought'] } });
    if (paid.lock) writes.unshift(paid.lock); // slip / voucher reference: used once, in the same commit
    await fs.commit(writes, tx);
    committed = true;
    const low = num(prod?.ammoLowStock), before = num(prod?.stock); // _low: asks the route for a Discord alert when stock falls under the product's limit
    return [{ status: 'completed', orderId: oid, orderNumber, ammoTotal: q.ammoTotal, amount: q.amount, accounts: accounts.map(({ stockItemId, ...a }) => a), ...(low > 0 && before >= low && before - q.ammoTotal < low ? { _low: { left: before - q.ammoTotal, limit: low } } : {}) }];
  } finally { if (!committed) await fs.rollback(tx); }
}

async function routeAmmoPay({ user, data, fs, env, fetchFn, now, later, ip }) {
  const qid = str(data.quoteId, 40), method = data.method;
  if (!/^\w{10,40}$/.test(qid)) return [{ error: 'ไม่พบรายการ' }, 400];
  if (!['wallet', 'slip', 'angpao'].includes(method) || (method === 'wallet' && !user)) return [{ error: 'วิธีชำระไม่ถูกต้อง' }, 400];
  const q = await fs.get(`ammo_quotes/${qid}`);
  if (!q || q.status !== 'open') return [{ error: 'รายการนี้ชำระไปแล้วหรือไม่มีอยู่' }, 409];
  if (q.uid && q.uid !== (user?.uid || '')) return [{ error: 'ไม่พบรายการ' }, 404];
  if (!user && !(await guestThrottle(fs, ip, 'ap', 8000, now))) return [{ error: 'ทำรายการถี่เกินไป รอสักครู่แล้วลองใหม่' }, 429];
  const who = user ? (user.name || user.email) : `ลูกค้าไม่ล็อกอิน (IP ${ip || '-'})`;
  const done = (out) => {
    const [b, st] = out;
    if (!st) later(discord(fs, fetchFn, { title: '✅ ขายไอดีไก่กระสุนอัตโนมัติ', fields: [{ name: 'ออเดอร์', value: b.orderNumber, inline: true }, { name: 'ยอด', value: `฿${money(b.amount)}`, inline: true }, { name: 'สินค้า', value: `${q.productName} ${b.ammoTotal} กอง (สั่ง ${q.target})` }, { name: 'ผู้ซื้อ', value: who }] }));
    if (!st && b._low) { later(discord(fs, fetchFn, { title: '📉 ไก่กระสุนใกล้หมด', fields: [{ name: 'สินค้า', value: q.productName }, { name: 'คงเหลือ', value: `${b._low.left} กอง (เตือนเมื่อต่ำกว่า ${b._low.limit})` }] })); delete b._low; }
    return out;
  };
  if (method === 'wallet') return done(await retry(() => ammoDeliverOnce({ user, qid, fs, now, paid: { via: 'wallet' } })));

  // Money arrives before delivery. If the IDs are gone by then, a member gets the money as credit; a guest's payment is
  // logged for the admin (Discord + ammo_quotes/{id}.status 'paid_undelivered') with the order code shown to the guest.
  const undelivered = async (amount, ref, why) => {
    if (user) {
      await fs.commit([{ update: { name: fs.name(`users/${user.uid}`) }, updateMask: { fieldPaths: [] }, updateTransforms: [{ fieldPath: 'walletBalance', increment: { doubleValue: amount } }] },
        { update: { name: fs.name(`wallet_logs/${randomId()}`), fields: fs.fields({ uid: user.uid, delta: amount, note: `คืนเป็นเครดิต: ${q.productName} (${why})`, by: 'system' }) }, updateTransforms: [stamp('at')] }]);
    }
    await fs.commit([{ update: { name: fs.name(`ammo_quotes/${qid}`), fields: fs.fields({ status: user ? 'refunded_credit' : 'paid_undelivered', paidAmount: amount, paidRef: ref, note: why }) }, updateMask: { fieldPaths: ['status', 'paidAmount', 'paidRef', 'note'] } }]);
    await discord(fs, fetchFn, { title: user ? '↩️ ไก่กระสุน: ส่งไอดีไม่ได้ คืนเป็นเครดิตแล้ว' : '⚠️ ไก่กระสุน: ลูกค้าไม่ล็อกอินจ่ายแล้วแต่ส่งไอดีไม่ได้', description: `${who} · ฿${money(amount)} · อ้างอิง ${ref} · รหัส ${qid} · ${why}` }).catch(() => {});
    return [{ error: user ? `${why} ระบบคืนเงิน ฿${money(amount)} เป็นเครดิตในบัญชีแล้ว` : `${why} ได้รับเงินแล้ว กรุณาแจ้งแอดมินพร้อมรหัส ${qid}`, code: 'undelivered', quoteId: qid }, 409];
  };

  if (method === 'slip') {
    const settings = await fs.get('system/settings');
    if (!(settings?.slipAutoVerify === true) || !env.EASYSLIP_KEY || !env.RECEIVER_MATCH) return [{ error: 'ร้านยังไม่เปิดระบบตรวจสลิปอัตโนมัติ' }, 503];
    const payload = String(data.payload || '');
    if (payload.length < 20 || payload.length > 2000) return [{ error: 'ไม่พบ QR ที่อ่านได้บนสลิป' }, 400];
    let check;
    try { check = await checkSlip({ fetchFn, key: env.EASYSLIP_KEY, receiver: env.RECEIVER_MATCH, payload, amount: q.amount, now }); }
    catch (e) { console.warn('slip api:', e); return [{ error: 'ระบบตรวจสลิปขัดข้องชั่วคราว กรุณาลองใหม่' }, 502]; }
    if (!check.ok) return [{ error: check.message }, 400];
    const lock = { update: { name: fs.name(`slip_refs/${check.transRef}`), fields: fs.fields({ uid: user?.uid || '', amount: q.amount, quoteId: qid }) }, updateTransforms: [stamp('at')], currentDocument: { exists: false } };
    let out;
    try { out = await retry(() => ammoDeliverOnce({ user, qid, fs, now, paid: { via: 'promptpay', ref: check.transRef, lock } })); }
    catch (e) { if (e.code === 'already-exists') return [{ error: 'สลิปนี้ถูกใช้แล้ว' }, 409]; throw e; }
    if (out[1] === 409 && out[0].code === 'stale') {
      try { await fs.commit([lock]); } catch (e) { if (e.code === 'already-exists') return [{ error: 'สลิปนี้ถูกใช้แล้ว' }, 409]; throw e; }
      return undelivered(q.amount, check.transRef, 'ไอดีถูกซื้อไปก่อน');
    }
    return done(out);
  }

  // angpao: the voucher is redeemed first (the amount is only known after), then the order is delivered
  if (!env.TRUEMONEY_PHONE) return [{ error: 'ร้านยังไม่เปิดรับซองอั่งเปา' }, 503];
  const link = str(data.link, 300), code = getValidVoucherCode(link);
  if (!/gift\.truemoney\.com/i.test(link) || code.length < 10) return [{ error: 'กรุณาวางลิงก์ซองของขวัญ TrueMoney ให้ถูกต้อง' }, 400];
  const r = await redeemVoucher({ phoneNumber: env.TRUEMONEY_PHONE, voucherCode: code, fetchFn });
  if (r.status.code !== 'SUCCESS') return [{ error: angpaoErrorText(r.status.code), code: r.status.code }, 400];
  const v = r.status.data.voucher || {}, ticket = r.status.data.my_ticket || {};
  const got = r2(num(ticket.amount_baht) || num(v.amount_baht));
  const ref = `${str(v.voucher_id, 80) || code}_${num(ticket.update_date) || now}`.replace(/[^\w-]/g, '');
  const lock = { update: { name: fs.name(`angpao_vouchers/${ref}`), fields: fs.fields({ uid: user?.uid || '', amount: got, voucherId: str(v.voucher_id, 80), code, quoteId: qid }) }, updateTransforms: [stamp('at')], currentDocument: { exists: false } };
  if (got < q.amount) {
    try { await fs.commit([lock]); } catch (e) { if (e.code === 'already-exists') return [{ error: 'ซองนี้ถูกใช้แล้ว' }, 409]; throw e; }
    return undelivered(got, ref, `ยอดซอง ฿${money(got)} น้อยกว่าราคา ฿${money(q.amount)}`);
  }
  const extra = r2(got - q.amount);
  let out;
  try { out = await retry(() => ammoDeliverOnce({ user, qid, fs, now, paid: { via: 'angpao', ref: str(v.voucher_id, 80) || code, lock, extra } })); }
  catch (e) { if (e.code === 'already-exists') return [{ error: 'ซองนี้ถูกใช้แล้ว' }, 409]; throw e; }
  if (out[1]) { // not delivered: the voucher money is already in the shop's wallet
    try { await fs.commit([lock]); } catch (_) {}
    return undelivered(got, ref, out[0].error || 'ส่งไอดีไม่สำเร็จ');
  }
  if (extra > 0 && user) await fs.commit([{ update: { name: fs.name(`users/${user.uid}`) }, updateMask: { fieldPaths: [] }, updateTransforms: [{ fieldPath: 'walletBalance', increment: { doubleValue: extra } }] }]).catch(e => console.warn('extra credit:', e));
  return done([{ ...out[0], extra, extraTo: extra > 0 ? (user ? 'credit' : 'shop') : '' }]);
}

/** POST /ammo/extend { quoteId }: +5 min on a live hold, once per quote, only for the buyer who made it. */
async function routeAmmoExtend({ user, data, fs, now, ip }) {
  const qid = String(data.quoteId || '');
  if (!/^\w{10,40}$/.test(qid)) return [{ error: 'ไม่พบรายการ' }, 400];
  const owner = user ? `u_${user.uid}` : ipKey(ip);
  return retry(async () => {
    const tx = await fs.begin(); let committed = false;
    try {
      const q = await fs.get(`ammo_quotes/${qid}`, tx);
      if (!q || q.status !== 'open' || q.owner !== owner) return [{ error: 'ไม่พบรายการ' }, 404];
      if (q.extended === true) return [{ error: 'ต่อเวลาไปแล้วครั้งหนึ่ง' }, 409];
      if (num(q.expiresAt) <= now) return [{ error: 'หมดเวลากันไอดีแล้ว กรุณาหาไอดีใหม่', code: 'stale' }, 409];
      const until = num(q.expiresAt) + 5 * 60e3;
      const items = await Promise.all(q.paths.map(p => fs.get(p, tx)));
      if (items.some(it => !it || it.status !== 'reserved' || it.quoteId !== qid)) return [{ error: 'ไอดีบางตัวไม่ได้ถูกกันไว้แล้ว กรุณาหาไอดีใหม่', code: 'stale' }, 409];
      await fs.commit([
        ...q.paths.map(p => ({ update: { name: fs.name(p), fields: fs.fields({ reservedUntil: until }) }, updateMask: { fieldPaths: ['reservedUntil'] }, currentDocument: { exists: true } })),
        { update: { name: fs.name(`ammo_quotes/${qid}`), fields: fs.fields({ expiresAt: until, extended: true }) }, updateMask: { fieldPaths: ['expiresAt', 'extended'] } }
      ], tx);
      committed = true;
      return [{ expiresAt: until }];
    } finally { if (!committed) await fs.rollback(tx); }
  });
}

// ---------- Ammo claims (เคลมไอดีเสีย) ----------
//   POST /ammo/claim  { orderId, reason }            member, own completed ammo order, within AMMO_CLAIM_MS, once  -> ammo_claims/{orderId} 'open'
//   POST /admin/claim { orderId, action, note }      action 'refund' (full order amount back as credit) | 'reject'
// Order doc gets claimStatus / claimNote so the customer sees the answer in "ออเดอร์ของฉัน".
const AMMO_CLAIM_MS = 24 * 3600e3;
async function routeAmmoClaim({ user, data, fs, now, later, fetchFn }) {
  const id = String(data.orderId || ''), reason = str(data.reason, 300);
  if (!/^[\w-]{10,60}$/.test(id)) return [{ error: 'ไม่พบออเดอร์' }, 400];
  if (reason.length < 5) return [{ error: 'กรุณาอธิบายปัญหาอย่างน้อย 5 ตัวอักษร' }, 400];
  return retry(async () => {
    const tx = await fs.begin(); let committed = false;
    try {
      const o = await fs.get(`orders/${id}`, tx);
      if (!o || o.userId !== user.uid || o.isAmmo !== true || o.status !== 'completed') return [{ error: 'ไม่พบออเดอร์ไก่กระสุนนี้' }, 404];
      if (o.claimStatus) return [{ error: 'ออเดอร์นี้แจ้งเคลมไปแล้ว' }, 409];
      if (now - Date.parse(o.createdAt) > AMMO_CLAIM_MS) return [{ error: 'เลยเวลาแจ้งเคลม (24 ชั่วโมงหลังซื้อ)' }, 400];
      await fs.commit([
        { update: { name: fs.name(`ammo_claims/${id}`), fields: fs.fields({ orderId: id, orderNumber: str(o.orderNumber, 40), uid: user.uid, email: user.email, productName: str(o.productName, 120), amount: r2(num(o.amount)), reason, status: 'open' }) }, updateTransforms: [stamp('createdAt')], currentDocument: { exists: false } },
        { update: { name: fs.name(`orders/${id}`), fields: fs.fields({ claimStatus: 'open' }) }, updateMask: { fieldPaths: ['claimStatus'] }, currentDocument: { exists: true } }
      ], tx);
      committed = true;
      later(discord(fs, fetchFn, { title: '🛠️ ลูกค้าแจ้งเคลมไอดีไก่กระสุน', fields: [{ name: 'ออเดอร์', value: str(o.orderNumber, 40), inline: true }, { name: 'ยอด', value: `฿${money(o.amount)}`, inline: true }, { name: 'ปัญหา', value: reason }] }));
      return [{ ok: true }];
    } finally { if (!committed) await fs.rollback(tx); }
  });
}
async function routeAdminClaim({ user, data, fs, fetchFn, now }) {
  if (!user.admin && !user.perms.includes('orders') && !user.perms.includes('pay')) return [{ error: 'เฉพาะผู้ดูแลระบบ' }, 403];
  const id = String(data.orderId || ''), note = str(data.note, 200);
  if (!/^[\w-]{10,60}$/.test(id) || !['refund', 'reject'].includes(data.action)) return [{ error: 'คำสั่งไม่ถูกต้อง' }, 400];
  return retry(async () => {
    const tx = await fs.begin(); let committed = false;
    try {
      const c = await fs.get(`ammo_claims/${id}`, tx);
      if (!c || c.status !== 'open') return [{ error: 'ไม่พบคำขอเคลมที่รอตรวจ' }, 409];
      const status = data.action === 'refund' ? 'refunded' : 'rejected', writes = [];
      if (status === 'refunded') {
        const prof = await fs.get(`users/${c.uid}`, tx), bal = r2(num(prof?.walletBalance));
        writes.push(...walletWrites(fs, c.uid, bal, bal + num(c.amount), `คืนเงินเคลมไอดี ${c.productName} (${c.orderNumber})`));
      }
      writes.push(
        { update: { name: fs.name(`ammo_claims/${id}`), fields: fs.fields({ status, note, by: user.email || user.uid }) }, updateMask: { fieldPaths: ['status', 'note', 'by'] }, updateTransforms: [stamp('doneAt')], currentDocument: { exists: true } },
        { update: { name: fs.name(`orders/${id}`), fields: fs.fields({ claimStatus: status, claimNote: note }) }, updateMask: { fieldPaths: ['claimStatus', 'claimNote'] }, currentDocument: { exists: true } });
      await fs.commit(writes, tx);
      committed = true;
      pushTo(fs, fetchFn, c.uid, { title: status === 'refunded' ? 'เคลมสำเร็จ คืนเครดิตแล้ว' : 'ผลการเคลมไอดี', body: status === 'refunded' ? `คืน ฿${money(c.amount)} เข้าเครดิตแล้ว` : `เคลมไม่ผ่าน${note ? ': ' + note : ''}`, url: '/front/account.html#orders', tag: `claim-${id}` }, now).catch(() => {});
      return [{ ok: true, status }];
    } finally { if (!committed) await fs.rollback(tx); }
  });
}

const GUEST_OK = new Set(['/ammo/quote', '/ammo/pay', '/ammo/extend']);
export async function handle(request, env, { fetchFn = fetch, now = Date.now(), ctx = null } = {}) {
  const cors = { 'access-control-allow-origin': env.ALLOWED_ORIGIN || '*', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-expose-headers': 'x-astraphex-worker', 'x-astraphex-worker': WORKER_VERSION, vary: 'origin' };
  const reply = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', ...cors } });
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return reply({ error: 'method not allowed' }, 405);
  const path = new URL(request.url).pathname.replace(/\/+$/, '') || '/';
  const routes = { '/': routeSlip, '/slip': routeSlip, '/buy': routeBuy, '/angpao': routeAngpao, '/cart': routeCart, '/rent': routeRent, '/rent/extend': routeRentExtend, '/rent/credentials': routeRentCredentials, '/rent/return': routeRentReturn, '/admin/rent': routeAdminRent, '/admin/user': routeAdminUser, '/notify': routeNotify, '/box/open': routeBoxOpen, '/box/gift': routeBoxGift, '/box/gift/cancel': routeBoxGiftCancel, '/box/claim': routeBoxClaim, '/vault/buy': routeVaultBuy, '/vault/redeem': routeVaultRedeem, '/push/key': routePushKey, '/push/test': routePushTest, '/push/queue': routePushQueue, '/vault/team': routeVaultTeam, '/vault/team/mark': routeVaultMark, '/vault/invite': routeVaultInvite, '/vault/join': routeVaultJoin, '/ammo/quote': routeAmmoQuote, '/ammo/pay': routeAmmoPay, '/ammo/extend': routeAmmoExtend, '/ammo/claim': routeAmmoClaim, '/admin/claim': routeAdminClaim, '/admin/winback': routeAdminWinback, '/auction/bid': routeAuctionBid };
  const route = routes[path];
  if (!route) return reply({ error: 'not found' }, 404);
  const pending = [];
  const later = (p) => { const q = Promise.resolve(p).catch((e) => console.warn('later:', e)); if (ctx?.waitUntil) ctx.waitUntil(q); else pending.push(q); };
  try {
    const sa = JSON.parse(env.SERVICE_ACCOUNT || '{}');
    const token = (request.headers.get('authorization') || '').replace(/^Bearer /, '');
    // ammo bundles marked "no login needed" can be quoted and paid without a token (the route checks the product)
    const user = !token && GUEST_OK.has(path) ? null : await verifyIdToken(token, sa.project_id, fetchFn, now);
    const raw = await request.text();
    if (raw.length > 262144) return reply({ error: 'ข้อมูลใหญ่เกินไป' }, 413);
    const data = (() => { try { return JSON.parse(raw); } catch { return {}; } })();
    const fs = fsClient(sa.project_id, await accessToken(sa, fetchFn, now), fetchFn);
    if (CLOSED_ROUTES.has(path) && !user?.admin) { const shop = await fs.get('system/settings'); if (shopClosedNow(shop, now)) return reply({ error: str(shop.shopClosedMsg, 300) || 'ร้านปิดชั่วคราว กลับมาเปิดเร็ว ๆ นี้' }, 503); }
    const ip = request.headers.get('cf-connecting-ip') || '';
    const [body, status = 200] = await route({ user, data: data || {}, fs, env, sa, fetchFn, now, later, ip });
    await Promise.all(pending);
    return reply(body, status);
  } catch (e) {
    if (e.code === 'unauthenticated') return reply({ error: e.message }, 401);
    if (e.code === 'auth-api') return reply({ error: e.message }, 400);
    console.error('worker failed', e);
    return reply({ error: 'ทำรายการไม่สำเร็จ กรุณาลองใหม่' }, 500);
  }
}

/** Shop-wide pause (admin switch in settings): buying, renting, loot boxes and new ammo quotes stop; top-ups, payments already made and claims keep working. Mirrored in js/shell.js. */
const CLOSED_ROUTES = new Set(['/auction/bid', '/buy', '/cart', '/rent', '/rent/extend', '/box/open', '/box/gift', '/ammo/quote']);
export const shopClosedNow = (shop, now) => shop?.shopClosed === true && !(num(shop.shopReopenAt) > 0 && now >= num(shop.shopReopenAt));


// ---------- Auctions ----------
// auctions/{id}: { name, image, productId, startPrice, minStep, endsAt, status open|settling|sold|failed|ended, topBid, topUid, topName, bidCount }
// A bid takes the money at once (the previous leader is refunded in the same transaction). When the time is up the cron refunds the winner and
// buys the ID for the winning price through buyOnce(); if that fails (no stock) the refund simply stays, so nobody pays for nothing.
const AUCTION_SNIPE_MS = 120e3;
async function auctionBidOnce({ user, d, fs, now }) {
  const tx = await fs.begin(); let committed = false;
  try {
    const a = await fs.get(`auctions/${d.auctionId}`, tx);
    if (!a || a.status !== 'open' || now >= num(a.endsAt)) return [{ error: 'การประมูลนี้ปิดแล้ว' }, 409];
    const amount = r2(num(d.amount)), min = a.topUid ? r2(num(a.topBid) + Math.max(1, num(a.minStep))) : r2(num(a.startPrice));
    if (!(amount >= min)) return [{ error: `ต้องเสนออย่างน้อย ฿${money(min)}` }, 400];
    if (amount > 1e6) return [{ error: 'ราคาสูงเกินไป' }, 400];
    const [profile, product] = await Promise.all([fs.get(`users/${user.uid}`, tx), fs.get(`products/${a.productId}`, tx)]);
    if (profile?.status === 'suspended') return [{ error: 'บัญชีนี้ถูกระงับการใช้งาน' }, 403];
    if (!product || product.active === false || num(product.stock) < 1) return [{ error: 'ไอดีของการประมูลนี้หมดสต็อก ติดต่อแอดมิน' }, 409];
    const self = a.topUid === user.uid, balance = r2(num(profile?.walletBalance)), back = self ? num(a.topBid) : 0;
    if (r2(balance + back) < amount) return [{ error: `เครดิตไม่พอ ต้องมี ฿${money(amount)} (คงเหลือ ฿${money(balance)})` }, 400];
    const writes = [];
    if (a.topUid && !self) { const prev = await fs.get(`users/${a.topUid}`, tx); writes.push(...walletWrites(fs, a.topUid, num(prev?.walletBalance), num(prev?.walletBalance) + num(a.topBid), `คืนเครดิตประมูล ${a.name} (มีคนให้ราคาสูงกว่า)`)); }
    writes.push(...walletWrites(fs, user.uid, balance, balance + back - amount, `ประมูล ${a.name} ฿${money(amount)}`));
    const endsAt = num(a.endsAt) - now < AUCTION_SNIPE_MS ? now + AUCTION_SNIPE_MS : num(a.endsAt); // a last-second bid gives everyone 2 more minutes
    writes.push({ update: { name: fs.name(`auctions/${d.auctionId}`), fields: fs.fields({ topBid: amount, topUid: user.uid, topName: maskName(profile?.username || user.name || 'user'), bidCount: num(a.bidCount) + 1, endsAt }) }, updateMask: { fieldPaths: ['topBid', 'topUid', 'topName', 'bidCount', 'endsAt'] }, currentDocument: { exists: true } });
    await fs.commit(writes, tx); committed = true;
    return [{ ok: true, topBid: amount, endsAt, balance: r2(balance + back - amount), outbid: a.topUid && !self ? a.topUid : '', name: a.name }];
  } finally { if (!committed) await fs.rollback(tx); }
}
async function routeAuctionBid({ user, data, fs, fetchFn, now, later }) {
  if (typeof data.auctionId !== 'string' || !/^[\w-]{1,64}$/.test(data.auctionId) || !Number.isFinite(Number(data.amount))) return [{ error: 'คำขอไม่ถูกต้อง' }, 400];
  const out = await retry(() => auctionBidOnce({ user, d: data, fs, now }));
  const [body, status] = out;
  if (!status && body.outbid) later(pushTo(fs, fetchFn, body.outbid, { title: 'มีคนให้ราคาสูงกว่าคุณ', body: `${str(body.name, 80)} ตอนนี้ ฿${money(body.topBid)} · เครดิตคืนแล้ว`, url: '/front/auction.html', tag: `auc-${data.auctionId}` }, now));
  if (!status) delete body.outbid;
  return out;
}
/** Cron: closes auctions whose time is up. */
export async function sweepAuctions(env, { fetchFn = fetch, now = Date.now() } = {}) {
  const sa = JSON.parse(env.SERVICE_ACCOUNT || '{}');
  if (!sa.project_id) return 0;
  const fs = fsClient(sa.project_id, await accessToken(sa, fetchFn, now), fetchFn);
  let n = 0;
  for (const row of await fs.query('', 'auctions', [['status', 'EQUAL', 'open']], { limit: 50 })) {
    const a = row.data; if (num(a.endsAt) > now) continue;
    const id = row.id, setStatus = (f) => fs.commit([{ update: { name: fs.name(`auctions/${id}`), fields: fs.fields(f) }, updateMask: { fieldPaths: Object.keys(f) }, currentDocument: { exists: true } }]);
    if (!a.topUid) { await setStatus({ status: 'ended' }); n++; continue; }
    // claim the auction and give the winner the money back in one step, so a retry can never refund twice
    const claimed = await retry(async () => {
      const tx = await fs.begin(); let committed = false;
      try {
        const cur = await fs.get(`auctions/${id}`, tx); if (!cur || cur.status !== 'open') return [{ skip: true }];
        const prof = await fs.get(`users/${cur.topUid}`, tx), bal = num(prof?.walletBalance);
        await fs.commit([...walletWrites(fs, cur.topUid, bal, bal + num(cur.topBid), `คืนเครดิตประมูล ${cur.name} เพื่อชำระซื้อ`), { update: { name: fs.name(`auctions/${id}`), fields: fs.fields({ status: 'settling' }) }, updateMask: { fieldPaths: ['status'] }, currentDocument: { exists: true } }], tx);
        committed = true; return [{ prof }];
      } finally { if (!committed) await fs.rollback(tx); }
    });
    if (claimed[0].skip || !claimed[0].prof) continue;
    const prof = claimed[0].prof; let res = [{ error: 'ไม่สำเร็จ' }, 500];
    try { res = await buyOnce({ user: { uid: a.topUid, email: prof.email || '', name: prof.username || '' }, d: { productId: a.productId, quantity: 1, buyerEmail: prof.email || '', expectedAmount: num(a.topBid) }, fs, now, override: num(a.topBid) }); } catch (e) { console.warn('auction buy:', e); }
    const ok = !res[1];
    await setStatus(ok ? { status: 'sold', orderId: String(res[0].order?.orderId || res[0].order?.id || '') } : { status: 'failed' });
    await pushTo(fs, fetchFn, a.topUid, ok ? { title: 'คุณชนะประมูล! 🏆', body: `${str(a.name, 80)} ฿${money(num(a.topBid))} · ดูไอดีที่เมนูออเดอร์`, url: '/front/account.html#orders', tag: `auc-${id}` } : { title: 'ประมูลซื้อไม่สำเร็จ', body: `${str(a.name, 80)}: ${str(res[0].error, 120)} · คืนเครดิตแล้ว`, url: '/front/auction.html', tag: `auc-${id}` }, now);
    if (!ok) await discord(fs, fetchFn, { title: '⚠️ ประมูลปิดแล้วแต่ส่งมอบไม่ได้', description: `${a.name} · ผู้ชนะ ${a.topName} ฿${money(num(a.topBid))}\n${res[0].error || ''} (คืนเครดิตให้ผู้ชนะแล้ว)` });
    n++;
  }
  return n;
}

/** One reminder, 24 h after an ID is delivered: change the password. Runs on the 5-minute cron. */
export async function sweepPwRemind(env, { fetchFn = fetch, now = Date.now() } = {}) {
  const sa = JSON.parse(env.SERVICE_ACCOUNT || '{}');
  if (!sa.project_id) return 0;
  const fs = fsClient(sa.project_id, await accessToken(sa, fetchFn, now), fetchFn);
  let n = 0;
  for (const o of await fs.query('', 'orders', [['pwReminded', 'EQUAL', false]], { limit: 200 })) {
    if (num(o.data.pwRemindAt) > now) continue;
    await fs.commit([{ update: { name: fs.name(o.path), fields: fs.fields({ pwReminded: true }) }, updateMask: { fieldPaths: ['pwReminded'] }, currentDocument: { exists: true } }]);
    if (o.data.status === 'completed' && o.data.userId) await pushTo(fs, fetchFn, o.data.userId, { title: 'อย่าลืมเปลี่ยนรหัสไอดี 🔐', body: `ไอดีที่ซื้อ (${str(o.data.productName, 60)}) เปลี่ยนรหัสผ่านเกมวันนี้เพื่อความปลอดภัย`, url: '/front/account.html#orders', tag: `pw-${o.id}` }, now);
    n++;
  }
  return n;
}

export default {
  fetch: (request, env, ctx) => handle(request, env, { ctx }),
  // Cron Trigger (Worker > Settings > Triggers > Cron: */5 * * * *) closes rentals whose time is up
  scheduled: (event, env, ctx) => {
    ctx.waitUntil(sweepRentals(env).catch((e) => console.warn('sweep:', e)));
    ctx.waitUntil(sweepSales(env).catch((e) => console.warn('sale sweep:', e)));
    ctx.waitUntil(sweepRestock(env).catch((e) => console.warn('restock sweep:', e)));
    ctx.waitUntil(sweepAuctions(env).catch((e) => console.warn('auction sweep:', e)));
    ctx.waitUntil(sweepPwRemind(env).catch((e) => console.warn('pw remind:', e)));
    if (Math.floor(((Date.now() + 7 * 3600e3) % 864e5) / 6e4) < 5) { ctx.waitUntil(sweepStock(env).catch((e) => console.warn('stock check:', e))); ctx.waitUntil(sweepRelated(env).catch((e) => console.warn('related:', e))); } // Thailand 00:00-00:04: one of the 5-minute runs
  }
};
