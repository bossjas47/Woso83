// Run: node worker/test.mjs (Node 20+). Fakes Google, Firestore, Identity Toolkit, EasySlip and Discord; no network.
import assert from 'assert';
import { handle, encodeFields, decodeFields, evaluatePromo, bestTopupPromo, maskName, usernameToEmail } from './slip-worker.js';

const PID = 'shop-test';
const b64u = (b) => Buffer.from(b).toString('base64url');
const rsa = () => crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const fb = await rsa(), saKey = await rsa();
const jwk = { ...(await crypto.subtle.exportKey('jwk', fb.publicKey)), kid: 'k1', alg: 'RS256' };
const pem = '-----BEGIN PRIVATE KEY-----\n' + Buffer.from(await crypto.subtle.exportKey('pkcs8', saKey.privateKey)).toString('base64') + '\n-----END PRIVATE KEY-----\n';
const SA = JSON.stringify({ project_id: PID, client_email: 'sa@x', private_key: pem });
const NOW = 1_800_000_000_000;
async function idToken(over = {}) {
  const h = b64u(JSON.stringify({ alg: 'RS256', kid: 'k1' }));
  const p = b64u(JSON.stringify({ aud: PID, iss: `https://securetoken.google.com/${PID}`, sub: 'u1', email: 'buyer01@tactical.store', name: 'buyer01', iat: NOW / 1000 - 10, exp: NOW / 1000 + 3000, ...over }));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', fb.privateKey, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64u(sig)}`;
}
const PAYLOAD = '00020101021230' + '0'.repeat(30);
const slipBody = (over = {}) => ({ success: true, data: { transRef: 'REF1', amount: { amount: 500 }, date: new Date(NOW - 3600e3).toISOString(), receiver: { bank: { short: 'SCB' }, account: { name: { th: 'นาย ร้านทดสอบ' } } }, ...over } });

/** In-memory Firestore REST + the other Google / third-party endpoints the Worker calls. */
function world(seed = {}) {
  const docs = { 'system/settings': { slipAutoVerify: true }, 'topup_promos/p500': { minAmount: 500, type: 'fixed', value: 25 }, 'topup_promos/p1000': { minAmount: 1000, type: 'percent', value: 8 }, ...structuredClone(seed) };
  const log = { easyslip: [], commits: [], discord: [], idt: [] };
  let slip = slipBody();
  const res = (o, status = 200) => ({ ok: status < 300, status, json: async () => o });
  const match = (d, f) => {
    if (!f) return true;
    if (f.compositeFilter) return f.compositeFilter.filters.every(x => match(d, x));
    const { field, op, value } = f.fieldFilter;
    const want = decodeFields({ v: value }).v;
    return op === 'EQUAL' && d[field.fieldPath] === want;
  };
  const fetchFn = async (url, opt = {}) => {
    const u = String(url);
    let body = {}; try { body = opt.body ? JSON.parse(opt.body) : {}; } catch (_) {}
    if (u.includes('/jwk/')) return res({ keys: [jwk] });
    if (u.includes('oauth2.googleapis.com')) return res({ access_token: 'AT' });
    if (u.includes('easyslip.com')) { log.easyslip.push({ auth: opt.headers.authorization, body }); return res(slip); }
    if (u.includes('discord.com/api/webhooks')) { log.discord.push(body); return res({}, 204); }
    if (u.includes('identitytoolkit')) {
      log.idt.push({ url: u, body });
      if (u.endsWith('accounts:lookup')) return res({ users: [{ localId: body.localId[0], customAttributes: JSON.stringify({ tier: 'x' }) }] });
      if (body.email === 'taken@tactical.store') return res({ error: { message: 'EMAIL_EXISTS' } }, 400);
      return res({ localId: body.localId, email: body.email || 'old@tactical.store' });
    }
    const after = u.split('/documents')[1] || '';
    if (after === ':beginTransaction') return res({ transaction: 'tx1' });
    if (after === ':rollback') return res({});
    if (after.endsWith(':runQuery')) {
      const parent = after.slice(1, -':runQuery'.length);
      const q = body.structuredQuery;
      const prefix = (parent ? parent + '/' : '') + q.from[0].collectionId + '/';
      let out = Object.entries(docs).filter(([k]) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/')).filter(([, d]) => match(d, q.where));
      if (q.limit) out = out.slice(0, q.limit);
      return res(out.map(([k, d]) => ({ document: { name: `projects/${PID}/databases/(default)/documents/${k}`, fields: encodeFields(d) } })));
    }
    if (after === ':commit') {
      const writes = body.writes;
      for (const w of writes) {
        const path = w.update.name.split('/documents/')[1];
        if (w.currentDocument?.exists === false && path in docs) return res({ error: { status: 'ALREADY_EXISTS' } }, 409);
        if (w.currentDocument?.exists === true && !(path in docs)) return res({ error: { status: 'NOT_FOUND' } }, 404);
      }
      for (const w of writes) {
        const path = w.update.name.split('/documents/')[1];
        const f = decodeFields(w.update.fields || {});
        if (w.updateMask) { docs[path] = { ...(docs[path] || {}) }; for (const k of w.updateMask.fieldPaths) docs[path][k] = f[k]; }
        else docs[path] = f;
        for (const t of w.updateTransforms || []) docs[path][t.fieldPath] = t.increment ? (docs[path][t.fieldPath] || 0) + decodeFields({ v: t.increment }).v : new Date(NOW).toISOString();
      }
      log.commits.push({ n: writes.length, tx: body.transaction || null });
      return res({});
    }
    const path = after.slice(1).split('?')[0];
    if (!(path in docs)) return res({}, 404);
    return res({ fields: encodeFields(docs[path]) });
  };
  return { docs, log, fetchFn, setSlip: (s) => { slip = s; } };
}
const env = { SERVICE_ACCOUNT: SA, EASYSLIP_KEY: 'EK', RECEIVER_MATCH: 'ร้านทดสอบ' };
const req = async (body = { amount: 500, payload: PAYLOAD }, token, path = '/') => new Request('https://w.test' + path, { method: 'POST', headers: { authorization: `Bearer ${token ?? await idToken()}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const run = async (w, r, e = env, now = NOW) => { const res = await handle(r, e, { fetchFn: w.fetchFn, now }); return { http: res.status, ...(await res.json()) }; };

// ======================= pure helpers =======================
assert.deepStrictEqual(bestTopupPromo([{ id: 'a', minAmount: 500, type: 'fixed', value: 25 }, { id: 'b', minAmount: 1000, type: 'percent', value: 8 }], 1000).bonus, 80);
assert.strictEqual(bestTopupPromo([{ minAmount: 500, type: 'fixed', value: 25, active: false }], 900).bonus, 0);
assert.strictEqual(evaluatePromo({ type: 'percent', value: 10, appliesTo: 'categories', categoryIds: ['c1'] }, { id: 'p', category: 'c2' }, 100).ok, false);
assert.strictEqual(evaluatePromo({ type: 'fixed', value: 500 }, { id: 'p' }, 100).discount, 100);
assert.strictEqual(maskName('user01'), 'us***01'); assert.strictEqual(maskName('ab'), 'a***');
assert.strictEqual(usernameToEmail('Agent_1'), 'agent_1@tactical.store'); assert.strictEqual(usernameToEmail('ไก่'), 'ue44ue01ue48@tactical.store');
console.log('ok  helpers: promo bonus / discount scope / masking / username mapping');

// ======================= POST / (slip) =======================
let w = world();
let r = await run(w, await req());
assert.strictEqual(r.status, 'completed'); assert.strictEqual(r.credit, 525); assert.strictEqual(w.docs['users/u1'].walletBalance, 525);
assert.ok(w.docs['slip_refs/REF1']); assert.strictEqual(w.log.easyslip[0].auth, 'Bearer EK'); assert.strictEqual(w.log.easyslip[0].body.payload, PAYLOAD);
const t = Object.entries(w.docs).find(([k]) => k.startsWith('topup_transactions/'))[1];
assert.strictEqual(t.finalCredit, 525); assert.strictEqual(t.status, 'completed'); assert.strictEqual(t.promoId, 'p500'); console.log('ok  slip: 500 + promo bonus 25 credited atomically');

r = await run(w, await req(), env, NOW + 20000);
assert.strictEqual(r.status, 'rejected'); assert.strictEqual(w.docs['users/u1'].walletBalance, 525); console.log('ok  slip: same slip twice -> rejected, no second credit');

w = world();
for (const [tok, label] of [[await idToken({ aud: 'other' }), 'wrong project'], [await idToken({ exp: NOW / 1000 - 5 }), 'expired'], ['a.b.c', 'garbage']]) {
  r = await run(w, await req(undefined, tok)); assert.strictEqual(r.http, 401, label);
}
const bad = (await idToken()).split('.'); bad[2] = bad[2].slice(0, -4) + 'AAAA';
assert.strictEqual((await run(w, await req(undefined, bad.join('.')))).http, 401); assert.ok(!w.docs['users/u1']); console.log('ok  bad token -> 401');

for (const [s, label] of [[slipBody({ amount: { amount: 400 } }), 'amount'], [slipBody({ receiver: { account: { name: { th: 'คนอื่น' } } } }), 'receiver'], [slipBody({ date: new Date(NOW - 5 * 864e5).toISOString() }), 'old']]) {
  w = world(); w.setSlip(s); r = await run(w, await req()); assert.strictEqual(r.status, 'rejected', label); assert.ok(!w.docs['users/u1']);
} console.log('ok  slip: wrong amount / receiver / too old -> rejected');

w = world(); await run(w, await req()); w.setSlip(slipBody({ transRef: 'R2' }));
r = await run(w, await req(), env, NOW + 3000); assert.strictEqual(r.status, 'rejected'); console.log('ok  slip: throttle within 10s');

for (const [seed, e] of [[{ 'system/settings': { slipAutoVerify: false } }, env], [{}, { ...env, RECEIVER_MATCH: '' }]]) {
  w = world(seed); r = await run(w, await req(), e); assert.strictEqual(r.status, 'manual'); assert.strictEqual(w.log.easyslip.length, 0);
} console.log('ok  slip: switched off / not configured -> manual');

w = world();
for (const body of [{ amount: 5, payload: PAYLOAD }, { amount: 500.555, payload: PAYLOAD }, { amount: 500, payload: 'x' }]) assert.strictEqual((await run(w, await req(body))).http, 400);
console.log('ok  slip: bad amount / payload -> 400');

// ======================= POST /buy =======================
const shop = (extra = {}) => ({
  'users/u1': { username: 'buyer01', walletBalance: 1000 },
  'products/acc1': { name: 'ไอดีไก่ A', price: 300, stock: 2, category: 'c_acc', productType: 'account' },
  'products/acc1/stock_items/s1': { username: 'game1@mail', password: 'pw1', status: 'available' },
  'products/acc1/stock_items/s2': { username: 'game2@mail', password: 'pw2', status: 'available' },
  'products/srv1': { name: 'โยนกระสุน', price: 20, stock: 100, category: 'c_srv', productType: 'service', serviceMin: 15, packages: [{ qty: 20, bonus: 5 }] },
  'categories/c_acc': { name: 'ไอดี', kind: 'account' }, 'categories/c_srv': { name: 'บริการ', kind: 'service', unit: 'กอง', minQty: 15 },
  'system_private/secrets': { discordWebhook: 'https://discord.com/api/webhooks/1/abc' },
  ...extra
});
const buy = (body) => req({ productId: 'acc1', quantity: 1, buyerEmail: 'me@mail.com', ...body }, undefined, '/buy');

w = world(shop());
r = await run(w, await buy({ expectedAmount: 300 }));
assert.strictEqual(r.http, 200); assert.strictEqual(r.status, 'completed');
assert.strictEqual(r.order.accountsDelivered[0].username, 'game1@mail'); assert.strictEqual(r.order.accountDelivered.password, 'pw1');
assert.strictEqual(w.docs['users/u1'].walletBalance, 700); assert.strictEqual(w.docs['products/acc1'].stock, 1);
assert.strictEqual(w.docs['products/acc1/stock_items/s1'].status, 'sold'); assert.strictEqual(w.docs['products/acc1/stock_items/s2'].status, 'available');
const order = Object.entries(w.docs).find(([k]) => k.startsWith('orders/'))[1];
assert.strictEqual(order.status, 'completed'); assert.strictEqual(order.paymentMethod, 'wallet'); assert.strictEqual(order.amount, 300);
assert.strictEqual(w.docs['stats/public'].orders, 1); assert.strictEqual(w.docs['stats/public'].sales, 300);
const recent = Object.entries(w.docs).find(([k]) => k.startsWith('recent_orders/'))[1];
assert.strictEqual(recent.buyerMask, 'bu***01'); assert.strictEqual(recent.amount, 300);
assert.ok(Object.keys(w.docs).some(k => k.startsWith('wallet_logs/'))); assert.strictEqual(w.log.commits.at(-1).tx, 'tx1');
assert.strictEqual(w.log.discord.length, 1); console.log('ok  buy: game ID delivered at once, balance/stock/stats/feed/log updated in one transaction, Discord pinged');

r = await run(w, await buy({ quantity: 2 })); assert.strictEqual(r.http, 409); assert.match(r.error, /เหลือ 1/); console.log('ok  buy: more than stock -> 409');
w = world(shop({ 'users/u1': { walletBalance: 100 } }));
r = await run(w, await buy({})); assert.strictEqual(r.http, 400); assert.match(r.error, /เครดิตไม่พอ/); assert.strictEqual(w.docs['users/u1'].walletBalance, 100); console.log('ok  buy: not enough credit -> 400, nothing written');
w = world(shop());
r = await run(w, await buy({ expectedAmount: 250 })); assert.strictEqual(r.http, 409); assert.strictEqual(w.docs['users/u1'].walletBalance, 1000); console.log('ok  buy: price changed since page load -> 409');
w = world(shop({ 'users/u1': { walletBalance: 1000, status: 'suspended' } }));
assert.strictEqual((await run(w, await buy({}))).http, 403); console.log('ok  buy: suspended account -> 403');
w = world(shop());
assert.strictEqual((await run(w, await buy({ buyerEmail: 'nope' }))).http, 400);
assert.strictEqual((await run(w, await buy({ quantity: 0 }))).http, 400);
assert.strictEqual((await run(w, await buy({ productId: '../x' }))).http, 400); console.log('ok  buy: bad email / quantity / id -> 400');

// promo codes
w = world(shop({ 'promo_codes/TEN': { type: 'percent', value: 10, appliesTo: 'categories', categoryIds: ['c_acc'], usedCount: 0, maxPerUser: 1 } }));
r = await run(w, await buy({ promoCode: 'TEN', expectedAmount: 270 }));
assert.strictEqual(r.status, 'completed'); assert.strictEqual(w.docs['users/u1'].walletBalance, 730); assert.strictEqual(w.docs['promo_codes/TEN'].usedCount, 1);
r = await run(w, await buy({ promoCode: 'TEN' })); assert.strictEqual(r.http, 400); assert.match(r.error, /ครบสิทธิ์/); console.log('ok  buy: category promo applied once, per-user limit enforced');
w = world(shop({ 'promo_codes/SRV': { type: 'fixed', value: 50, appliesTo: 'products', productIds: ['srv1'] } }));
r = await run(w, await buy({ promoCode: 'SRV' })); assert.strictEqual(r.http, 400); assert.match(r.error, /ใช้กับสินค้านี้ไม่ได้/); console.log('ok  buy: promo for another product -> 400');

// service
const srv = (body) => req({ productId: 'srv1', quantity: 20, buyerFacebook: 'Somchai FB', gameEmail: 'g@mail.com', gamePassword: 'secret', ...body }, undefined, '/buy');
w = world(shop());
r = await run(w, await srv({ expectedAmount: 400 }));
assert.strictEqual(r.status, 'processing'); assert.strictEqual(r.order.gamePassword, undefined);
const so = Object.entries(w.docs).find(([k]) => k.startsWith('orders/'))[1];
assert.strictEqual(so.queueStatus, 'waiting'); assert.strictEqual(so.bonusQty, 5); assert.strictEqual(so.buyerFacebook, 'Somchai FB'); assert.strictEqual(so.gamePassword, 'secret');
const qd = Object.entries(w.docs).find(([k]) => k.startsWith('queue/'))[1];
assert.strictEqual(qd.status, 'waiting'); assert.strictEqual(qd.nameMask, 'bu***01');
assert.strictEqual(w.docs['products/srv1'].stock, 80); assert.strictEqual(w.docs['users/u1'].walletBalance, 600); assert.ok(!w.docs['stats/public']);
console.log('ok  buy: service paid, queued (waiting), password kept for the job but not echoed back, sale counted at finish');
assert.strictEqual((await run(w, await srv({ quantity: 10 }))).http, 400);
assert.strictEqual((await run(w, await srv({ buyerFacebook: '' }))).http, 400); console.log('ok  buy: service below minimum / without Facebook -> 400');

// ======================= POST /admin/user =======================
w = world();
r = await run(w, await req({ uid: 'u2', password: 'newpass' }, undefined, '/admin/user')); assert.strictEqual(r.http, 403); assert.strictEqual(w.log.idt.length, 0);
const adminTok = await idToken({ sub: 'adm', admin: true });
r = await run(w, await req({ uid: 'u2', username: 'NewName', password: 'newpass1', admin: true, disabled: false }, adminTok, '/admin/user'));
assert.strictEqual(r.ok, true); assert.strictEqual(r.email, 'newname@tactical.store');
const upd = w.log.idt.find(x => x.url.endsWith('accounts:update')).body;
assert.strictEqual(upd.email, 'newname@tactical.store'); assert.strictEqual(upd.displayName, 'NewName'); assert.strictEqual(upd.password, 'newpass1');
assert.deepStrictEqual(JSON.parse(upd.customAttributes), { tier: 'x', admin: true }); assert.strictEqual(upd.disableUser, false);
r = await run(w, await req({ uid: 'u2', username: 'taken' }, adminTok, '/admin/user')); assert.strictEqual(r.http, 400); assert.match(r.error, /มีคนใช้แล้ว/);
r = await run(w, await req({ uid: 'adm', admin: false }, adminTok, '/admin/user')); assert.strictEqual(r.http, 400);
r = await run(w, await req({ uid: 'u2', password: '123' }, adminTok, '/admin/user')); assert.strictEqual(r.http, 400);
console.log('ok  admin/user: admin claim required; username->login e-mail, password, admin claim merge, self-demote blocked');

// ======================= POST /notify =======================
w = world(shop({ 'orders/o1': { userId: 'u1', orderNumber: 'ORD-1', amount: 99, productName: 'X', quantity: 1, createdAt: new Date(NOW - 60e3).toISOString(), hasSlip: true }, 'orders/o2': { userId: 'other', createdAt: new Date(NOW).toISOString() } }));
r = await run(w, await req({ kind: 'order', id: 'o1' }, undefined, '/notify')); assert.strictEqual(r.ok, true); assert.strictEqual(w.log.discord.length, 1);
assert.match(JSON.stringify(w.log.discord[0]), /ORD-1/);
r = await run(w, await req({ kind: 'order', id: 'o1' }, undefined, '/notify')); assert.strictEqual(r.skipped, 'dup'); assert.strictEqual(w.log.discord.length, 1);
r = await run(w, await req({ kind: 'order', id: 'o2' }, undefined, '/notify')); assert.strictEqual(r.http, 404);
r = await run(w, await req({ kind: 'test' }, undefined, '/notify')); assert.strictEqual(r.http, 403);
r = await run(w, await req({ kind: 'test' }, adminTok, '/notify')); assert.strictEqual(r.ok, true); assert.strictEqual(w.log.discord.length, 2);
console.log('ok  notify: own fresh order once, not someone else\'s, test needs admin');

w = world();
assert.strictEqual((await run(w, await req({}, undefined, '/nope'))).http, 404);
const o = await handle(new Request('https://w.test/buy', { method: 'OPTIONS' }), env, { fetchFn: w.fetchFn, now: NOW });
assert.strictEqual(o.status, 204); assert.ok(o.headers.get('access-control-allow-origin')); console.log('ok  unknown route 404, CORS preflight');
console.log('worker: all checks passed');
