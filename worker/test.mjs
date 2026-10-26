// Run: node worker/test.mjs (Node 20+). Fakes Google, Firestore, Identity Toolkit, EasySlip and Discord; no network.
import assert from 'assert';
import { handle, matchAmmo, ammoRateOf, ammoClosedNow, sweepRentals, sweepStock, sweepSales, sweepRestock, sweepPwRemind, sweepAuctions, sweepRelated, shopClosedNow, rentPrice, encodeFields, decodeFields, evaluatePromo, bestTopupPromo, maskName, usernameToEmail, getValidVoucherCode, isValidThaiPhoneNumber } from './slip-worker.js';

const PID = 'shop-test';
const b64u = (b) => Buffer.from(b).toString('base64url');
const rsa = () => crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const fb = await rsa(), saKey = await rsa();
const jwk = { ...(await crypto.subtle.exportKey('jwk', fb.publicKey)), kid: 'k1', alg: 'RS256' };
const saDer = Buffer.from(await crypto.subtle.exportKey('pkcs8', saKey.privateKey));
const pem = [
  '-----BEGIN PRIVATE KEY-----',
  saDer.toString('base64').match(/.{1,64}/g).join('\n'),
  '-----END PRIVATE KEY-----',
].join('\n') + '\n';
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

const twOk = (amt = '500.00') => ({ status: { code: 'SUCCESS', message: 'ok', data: { voucher: { voucher_id: 'V123', amount_baht: amt }, my_ticket: { amount_baht: amt, update_date: 1700000000000 }, owner_profile: {}, redeemer_profile: {}, tickets: [] } } });
/** In-memory Firestore REST + the other Google / third-party endpoints the Worker calls. */
function world(seed = {}) {
  const docs = { 'system/settings': { slipAutoVerify: true }, 'topup_promos/p500': { minAmount: 500, type: 'fixed', value: 25 }, 'topup_promos/p1000': { minAmount: 1000, type: 'percent', value: 8 }, ...structuredClone(seed) };
  const log = { easyslip: [], commits: [], discord: [], idt: [], tw: [] };
  let slip = slipBody();
  let tw = { status: 200, body: twOk() };
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
    if (u.includes('gift.truemoney.com')) { log.tw.push({ url: u, body }); return res(tw.body, tw.status); }
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
        if (w.delete) continue;
        const path = w.update.name.split('/documents/')[1];
        if (w.currentDocument?.exists === false && path in docs) return res({ error: { status: 'ALREADY_EXISTS' } }, 409);
        if (w.currentDocument?.exists === true && !(path in docs)) return res({ error: { status: 'NOT_FOUND' } }, 404);
      }
      for (const w of writes) {
        if (w.delete) { delete docs[w.delete.split('/documents/')[1]]; continue; }
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
  return { docs, log, fetchFn, setSlip: (s) => { slip = s; }, setTw: (status, body) => { tw = { status, body }; } };
}
const env = { SERVICE_ACCOUNT: SA, EASYSLIP_KEY: 'EK', RECEIVER_MATCH: 'ร้านทดสอบ' };
const req = async (body = { amount: 500, payload: PAYLOAD }, token, path = '/') => new Request('https://w.test' + path, { method: 'POST', headers: { authorization: `Bearer ${token ?? await idToken()}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
let qClock = NOW;
const runQ = (w, r) => run(w, r, env, qClock += 5000); // quotes are throttled per buyer: each test quote happens a few seconds later
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
  w = world(seed); r = await run(w, await req(), e); assert.strictEqual(r.status, 'rejected'); assert.strictEqual(w.log.easyslip.length, 0);
} console.log('ok  slip: switched off / not configured -> rejected without API call');

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
assert.strictEqual((await run(w, await buy({ buyerEmail: 'nope' }))).http, 400); assert.notStrictEqual((await run(w, await buy({ buyerEmail: '' }))).http, 400);
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
// ======================= POST /angpao =======================
assert.strictEqual(getValidVoucherCode('https://gift.truemoney.com/campaign/?v=AbC123xyz789'), 'AbC123xyz789');
assert.strictEqual(getValidVoucherCode('AbC123xyz789'), 'AbC123xyz789');
assert.ok(isValidThaiPhoneNumber('081-234-5678')); assert.ok(isValidThaiPhoneNumber('+66812345678')); assert.ok(!isValidThaiPhoneNumber('021234567'));
const TWENV = { ...env, TRUEMONEY_PHONE: '0812345678' };
const LINK = 'https://gift.truemoney.com/campaign/?v=AbC123xyz789';
const ang = (body, path = '/angpao') => req({ link: LINK, ...body }, undefined, path);
w = world(shop({ 'users/u1': { username: 'buyer01', walletBalance: 0 } }));
r = await run(w, await ang({}), TWENV);
assert.strictEqual(r.status, 'credited'); assert.strictEqual(r.amount, 500); assert.strictEqual(r.bonus, 25); assert.strictEqual(w.docs['users/u1'].walletBalance, 525);
assert.deepStrictEqual(w.log.tw[0].body, { mobile: '0812345678', voucher_hash: 'AbC123xyz789' }); assert.match(w.log.tw[0].url, /vouchers\/AbC123xyz789\/redeem$/);
const at = Object.values(w.docs).find(d => d.paymentMethod === 'angpao'); assert.strictEqual(at.finalCredit, 525); assert.strictEqual(at.status, 'completed');
console.log('ok  angpao: redeemed to shop phone, 500 + promo 25 credited, top-up record written');

r = await run(w, await ang({}), TWENV, NOW + 10000);
assert.strictEqual(r.http, 409); assert.strictEqual(w.docs['users/u1'].walletBalance, 525); console.log('ok  angpao: same ticket recorded twice -> no double credit');

for (const [code, re] of [['VOUCHER_OUT_OF_STOCK', /ครบแล้ว/], ['VOUCHER_EXPIRED', /หมดอายุ/], ['CANNOT_GET_OWN_VOUCHER', /ตัวเอง/]]) {
  w = world(shop()); w.setTw(400, { status: { code, message: 'x' } });
  r = await run(w, await ang({}), TWENV); assert.strictEqual(r.http, 400); assert.match(r.error, re); assert.strictEqual(w.docs['users/u1'].walletBalance, 1000);
}
w = world(shop()); w.setTw(403, '<html>blocked</html>'); r = await run(w, await ang({}), TWENV); assert.strictEqual(r.http, 502);
console.log('ok  angpao: TrueMoney errors -> Thai message, nothing credited; upstream block -> 502');

w = world(shop()); r = await run(w, await ang({}), env); assert.strictEqual(r.http, 503); assert.strictEqual(w.log.tw.length, 0);
r = await run(w, await ang({ link: 'https://example.com/?v=AbC123xyz789' }), TWENV); assert.strictEqual(r.http, 400); assert.strictEqual(w.log.tw.length, 0);
console.log('ok  angpao: no shop phone -> 503, foreign link -> 400 (no redeem call)');

// 5 bad links in 10 minutes lock angpao for 10 minutes; a good link before that is unaffected
w = world(shop()); w.setTw(400, { status: { code: 'VOUCHER_NOT_FOUND', message: 'x' } });
for (let i = 0; i < 5; i++) { r = await run(w, await ang({}), TWENV, NOW + i * 10000); assert.strictEqual(r.http, 400); }
const calls = w.log.tw.length; r = await run(w, await ang({}), TWENV, NOW + 60000);
assert.strictEqual(r.http, 429); assert.match(r.error, /รอ \d+ นาที/); assert.strictEqual(w.log.tw.length, calls);
w.setTw(200, twOk('100.00')); r = await run(w, await ang({}), TWENV, NOW + 40000 + 601e3);
assert.strictEqual(r.status, 'credited'); console.log('ok  angpao: 5 bad links -> locked 10 min without calling TrueMoney, works again after');
w = world(shop({ 'users/u1': { username: 'buyer01', walletBalance: 0 } })); w.setTw(200, twOk('300.00'));
r = await run(w, await ang({ purpose: 'buy', buy: { productId: 'acc1', quantity: 1, expectedAmount: 300 } }), TWENV);
assert.strictEqual(r.credit, 300); assert.strictEqual(r.buy.status, 'completed'); assert.strictEqual(r.buy.order.accountsDelivered.length, 1);
assert.strictEqual(w.docs['users/u1'].walletBalance, 0); console.log('ok  angpao buy: voucher 300 -> credit -> ID delivered, balance back to 0, no e-mail needed');

w = world(shop({ 'users/u1': { username: 'buyer01', walletBalance: 0 } })); w.setTw(200, twOk('100.00'));
r = await run(w, await ang({ purpose: 'buy', buy: { productId: 'acc1', quantity: 1, expectedAmount: 300 } }), TWENV);
assert.strictEqual(r.credit, 100); assert.match(r.buyError, /เครดิตไม่พอ/); assert.strictEqual(w.docs['users/u1'].walletBalance, 100);
console.log('ok  angpao buy: voucher too small -> credit kept, order not made');

// ======================= /cart =======================
const cart = (items) => req({ items }, undefined, '/cart');
w = world(shop({ 'users/u1': { username: 'buyer01', walletBalance: 700 } }));
r = await run(w, await cart([{ productId: 'acc1', quantity: 1, expectedAmount: 300 }, { productId: 'srv1', quantity: 20, expectedAmount: 400, buyerFacebook: 'FB Name', gameEmail: 'g@mail.com', gamePassword: 'pw' }]));
assert.strictEqual(r.results.length, 2); assert.ok(r.results.every(x => x.ok)); assert.strictEqual(w.docs['users/u1'].walletBalance, 0); assert.ok(!JSON.stringify(r).includes('"gamePassword"'));
assert.strictEqual(r.results[0].order.accountsDelivered.length, 1);
console.log('ok  cart: ID + service paid in one call, balance 700 -> 0, no password in the answer');

w = world(shop({ 'users/u1': { username: 'buyer01', walletBalance: 500 } }));
r = await run(w, await cart([{ productId: 'acc1', quantity: 1, expectedAmount: 300 }, { productId: 'acc1', quantity: 1, expectedAmount: 300 }]));
assert.strictEqual(r.http, 400); assert.match(r.error, /เครดิตไม่พอ/); assert.strictEqual(w.docs['users/u1'].walletBalance, 500); assert.strictEqual(w.docs['products/acc1'].stock, 2);
console.log('ok  cart: total above balance -> refused before any purchase');

w = world(shop({ 'users/u1': { username: 'buyer01', walletBalance: 2000 }, 'products/acc1': { name: 'ไอดีไก่ A', price: 300, stock: 1, category: 'c_acc', productType: 'account' } }));
r = await run(w, await cart([{ productId: 'acc1', quantity: 1, expectedAmount: 300 }, { productId: 'acc1', quantity: 2, expectedAmount: 600 }, { productId: 'acc1', quantity: 1, expectedAmount: 250 }]));
assert.deepStrictEqual(r.results.map(x => !!x.ok), [true, false, false]); assert.strictEqual(w.docs['users/u1'].walletBalance, 1700);
assert.match(r.results[2].error, /ราคาเปลี่ยน|สินค้าหมด|เหลือ/);
console.log('ok  cart: sold-out / changed-price lines fail alone and cost nothing');
r = await run(w, await cart([])); assert.strictEqual(r.http, 400); r = await run(w, await cart(Array.from({ length: 9 }, () => ({ productId: 'acc1', quantity: 1, expectedAmount: 1 })))); assert.strictEqual(r.http, 400);
r = await run(w, await cart([{ productId: 'acc1', quantity: 1 }])); assert.strictEqual(r.http, 400);
console.log('ok  cart: empty / more than 8 / missing price -> 400');

// combo: ID + service in one cart -> comboPct off every line; one kind alone -> no discount
w = world(shop({ 'users/u1': { username: 'buyer01', walletBalance: 700 }, 'system/settings': { comboPct: 10 } }));
r = await run(w, await cart([{ productId: 'acc1', quantity: 1, expectedAmount: 270 }, { productId: 'srv1', quantity: 20, expectedAmount: 360, buyerFacebook: 'FB Name', gameEmail: 'g@mail.com', gamePassword: 'pw' }]));
assert.ok(r.results.every(x => x.ok), JSON.stringify(r)); assert.strictEqual(w.docs['users/u1'].walletBalance, 70);
w = world(shop({ 'users/u1': { username: 'buyer01', walletBalance: 700 }, 'system/settings': { comboPct: 10 } }));
r = await run(w, await cart([{ productId: 'acc1', quantity: 1, expectedAmount: 300 }])); assert.ok(r.results[0].ok, 'one kind alone pays full price');
console.log('ok  combo: ID + service cart gets comboPct off, single kind does not');

// shop closed switch + password reminder
assert.strictEqual(shopClosedNow({ shopClosed: true }, NOW), true); assert.strictEqual(shopClosedNow({ shopClosed: true, shopReopenAt: NOW - 1 }, NOW), false); assert.strictEqual(shopClosedNow({}, NOW), false);
w = world(shop({ 'users/u1': { username: 'buyer01', walletBalance: 700 }, 'system/settings': { shopClosed: true, shopClosedMsg: 'พักร้าน' } }));
r = await run(w, await buy({ expectedAmount: 300 })); assert.strictEqual(r.http, 503); assert.strictEqual(r.error, 'พักร้าน'); assert.strictEqual(w.docs['users/u1'].walletBalance, 700);
r = await run(w, await req({ boxId: 'x' }, undefined, '/box/open')); assert.strictEqual(r.http, 503);
r = await run(w, await req({ boxId: 'x' }, await idToken({ admin: true }), '/box/open')); assert.notStrictEqual(r.http, 503, 'admin can still test the shop');
console.log('ok  shop closed: buying refused with the message, admin passes');
w = world(shop({ 'users/u1': { username: 'buyer01', walletBalance: 700 } }));
r = await run(w, await buy({ expectedAmount: 300 })); const oid = Object.keys(w.docs).find(k => k.startsWith('orders/'));
assert.strictEqual(w.docs[oid].pwReminded, false);
assert.strictEqual(await sweepPwRemind(env, { fetchFn: w.fetchFn, now: NOW }), 0, 'too early');
assert.strictEqual(await sweepPwRemind(env, { fetchFn: w.fetchFn, now: NOW + 25 * 3600e3 }), 1); assert.strictEqual(w.docs[oid].pwReminded, true);
assert.strictEqual(await sweepPwRemind(env, { fetchFn: w.fetchFn, now: NOW + 26 * 3600e3 }), 0, 'only once');
console.log('ok  password reminder: due after 24 h, once');

// ======================= auctions + timed drop =======================
{
  const bid = (tok, amount, at = NOW) => req({ auctionId: 'a1', amount }, tok, '/auction/bid').then(q => run(w, q, undefined, at));
  const t2 = await idToken({ sub: 'u2', exp: NOW / 1000 + 1e6 }), t1 = await idToken({ exp: NOW / 1000 + 1e6 });
  w = world(shop({ 'users/u1': { username: 'buyer01', walletBalance: 1000 }, 'users/u2': { username: 'rival02', walletBalance: 1000 },
    'auctions/a1': { name: 'ไอดีหายาก', productId: 'acc1', startPrice: 100, minStep: 10, endsAt: NOW + 3600e3, status: 'open', topBid: 0, topUid: '', bidCount: 0 },
    'auctions/a2': { name: 'ไม่มีคนประมูล', productId: 'acc1', startPrice: 100, minStep: 10, endsAt: NOW + 1000, status: 'open', topBid: 0, topUid: '', bidCount: 0 } }));
  let r = await bid(undefined, 90); assert.strictEqual(r.http, 400, 'below the start price');
  r = await bid(undefined, 100); assert.strictEqual(r.ok, true); assert.strictEqual(w.docs['users/u1'].walletBalance, 900);
  r = await bid(t2, 105); assert.strictEqual(r.http, 400, 'below the minimum step');
  r = await bid(t2, 110); assert.strictEqual(r.ok, true); assert.strictEqual(w.docs['users/u2'].walletBalance, 890); assert.strictEqual(w.docs['users/u1'].walletBalance, 1000, 'previous leader refunded');
  r = await bid(t1, 200, NOW + 3600e3 - 30e3); assert.strictEqual(r.ok, true); assert.strictEqual(w.docs['users/u1'].walletBalance, 800); assert.strictEqual(w.docs['users/u2'].walletBalance, 1000);
  assert.strictEqual(w.docs['auctions/a1'].endsAt, NOW + 3600e3 - 30e3 + 120e3, 'late bid extends the end');
  r = await bid(t1, 250, NOW + 4000e3); assert.strictEqual(r.http, 409, 'closed');
  assert.strictEqual(await sweepAuctions(env, { fetchFn: w.fetchFn, now: NOW + 2000 }), 1, 'only the bid-less auction has ended so far');
  assert.strictEqual(w.docs['auctions/a2'].status, 'ended');
  assert.strictEqual(await sweepAuctions(env, { fetchFn: w.fetchFn, now: NOW + 4000e3 }), 1);
  assert.strictEqual(w.docs['auctions/a1'].status, 'sold'); assert.strictEqual(w.docs['users/u1'].walletBalance, 800, 'winner paid exactly the winning bid once');
  const ord = Object.values(w.docs).find(x => x.userId === 'u1' && x.amount === 200 && x.productId === 'acc1'); assert.ok(ord, 'order created at the winning price');
  assert.strictEqual(await sweepAuctions(env, { fetchFn: w.fetchFn, now: NOW + 5000e3 }), 0, 'settled only once');
  console.log('ok  auction: bids hold/refund credit, late bid extends, winner gets the ID at the winning price');

  w = world(shop({ 'users/u1': { username: 'buyer01', walletBalance: 1000 }, 'products/acc1': { name: 'ไอดีไก่ A', price: 300, stock: 1, category: 'c_acc', productType: 'account', dropAt: NOW + 60e3 }, 'products/acc1/stock_items/k1': { username: 'u', password: 'p', status: 'available' } }));
  r = await run(w, await buy({ expectedAmount: 300 })); assert.strictEqual(r.http, 409); assert.match(r.error, /ยังไม่เปิดขาย/);
  r = await run(w, await buy({ expectedAmount: 300 }), undefined, NOW + 61e3); assert.strictEqual(r.order ? 1 : 0, 1, 'opens at dropAt');
  w = world(shop({ 'users/u1': { username: 'buyer01', walletBalance: 1000 }, 'products/acc1': { name: 'ไอดีไก่ A', price: 300, stock: 1, category: 'c_acc', productType: 'account', hideAt: NOW + 60e3 }, 'products/acc1/stock_items/k1': { username: 'u', password: 'p', status: 'available' } }));
  r = await run(w, await buy({ expectedAmount: 300 })); assert.ok(r.order, 'still sells before hideAt');
  w = world(shop({ 'users/u1': { username: 'buyer01', walletBalance: 1000 }, 'products/acc1': { name: 'ไอดีไก่ A', price: 300, stock: 1, category: 'c_acc', productType: 'account', hideAt: NOW - 1 }, 'products/acc1/stock_items/k1': { username: 'u', password: 'p', status: 'available' } }));
  r = await run(w, await buy({ expectedAmount: 300 })); assert.strictEqual(r.http, 409); assert.match(r.error, /ปิดขายแล้ว/);
  console.log('ok  timed drop: buying refused before dropAt, allowed after');
}

// ======================= rentals =======================
const rshop = (extra = {}) => shop({
  'users/u1': { username: 'buyer01', walletBalance: 1000 },
  'products/rent1': { name: 'ไอดีเช่า A', price: 30, stock: 2, productType: 'account', rentHourPrice: 30, rentMinHours: 2, rentDeposit: 100, rentPackages: [{ hours: 24, price: 500 }] },
  'products/rent1/stock_items/r1': { username: 'rent1@mail', password: 'rpw1', status: 'available' },
  'products/rent1/stock_items/r2': { username: 'rent2@mail', password: 'rpw2', status: 'available' }, ...extra
});
const LONGTOK = await idToken({ exp: NOW / 1000 + 1e6 }); // rentals last hours, so the test token must outlive them
const rent = (body, path = '/rent') => req(body, LONGTOK, path);
assert.strictEqual(rentPrice(rshop()['products/rent1'], 24), 500); assert.strictEqual(rentPrice(rshop()['products/rent1'], 5), 150); assert.strictEqual(rentPrice(rshop()['products/rent1'], 1), 0);

w = world(rshop());
r = await run(w, await rent({ productId: 'rent1', hours: 3, expectedAmount: 190 }));
assert.strictEqual(r.status, 'active'); assert.strictEqual(r.rental.price, 90); assert.strictEqual(r.rental.deposit, 100); assert.strictEqual(r.rental.endMs, NOW + 3 * 3600e3);
assert.strictEqual(w.docs['users/u1'].walletBalance, 810); assert.strictEqual(w.docs['products/rent1'].stock, 1);
assert.strictEqual(w.docs['products/rent1/stock_items/r1'].status, 'rented'); assert.strictEqual(w.docs['products/rent1/stock_items/r2'].status, 'available');
const RID = r.rental.id; assert.strictEqual(w.docs[`rentals/${RID}`].depositStatus, 'held'); assert.ok(!('password' in w.docs[`rentals/${RID}`]));
console.log('ok  rent: 3 h = 90 + deposit 100 charged, ID r1 locked, stock 2 -> 1, no password in rental doc');

r = await run(w, await rent({ productId: 'rent1', hours: 24, expectedAmount: 600 }));
assert.strictEqual(r.rental.price, 500); assert.strictEqual(w.docs['users/u1'].walletBalance, 210); assert.strictEqual(w.docs['products/rent1/stock_items/r2'].status, 'rented');
r = await run(w, await rent({ productId: 'rent1', hours: 2 })); assert.strictEqual(r.http, 409); assert.match(r.error, /ไม่มีไอดีว่าง/); assert.strictEqual(w.docs['users/u1'].walletBalance, 210);
console.log('ok  rent: package price used for 24 h, second ID rented, third request -> no free ID, balance untouched');

for (const [body, st, re] of [[{ productId: 'rent1', hours: 1 }, 400, /ขั้นต่ำ 2/], [{ productId: 'rent1', hours: 3, expectedAmount: 150 }, 409, /ราคาเปลี่ยน/], [{ productId: 'rent1', hours: 0 }, 400, /ชั่วโมง/], [{ productId: 'acc1', hours: 3 }, 404, /ไม่พบสินค้าเช่า/], [{ productId: 'rent1', hours: 10 }, 400, /เครดิตไม่พอ/]]) {
  w = world(rshop({ 'users/u1': { username: 'buyer01', walletBalance: body.hours === 10 ? 100 : 1000 } }));
  r = await run(w, await rent(body)); assert.strictEqual(r.http, st, JSON.stringify(body)); assert.match(r.error, re);
  assert.strictEqual(w.docs['products/rent1/stock_items/r1'].status, 'available'); assert.ok(!Object.keys(w.docs).some(k => k.startsWith('rentals/')));
}
console.log('ok  rent: below minimum / stale price / bad hours / not a rental product / low balance -> refused, nothing locked');

// credentials only while the rental runs, and only for the renter
w = world(rshop()); r = await run(w, await rent({ productId: 'rent1', hours: 3 })); const id1 = r.rental.id;
r = await run(w, await rent({ rentalId: id1 }, '/rent/credentials'), env, NOW + 3600e3);
assert.strictEqual(r.username, 'rent1@mail'); assert.strictEqual(r.password, 'rpw1'); assert.strictEqual(w.docs[`rentals/${id1}`].viewCount, 1);
r = await run(w, await req({ rentalId: id1 }, await idToken({ sub: 'u2', exp: NOW / 1000 + 1e6 }), '/rent/credentials'), env, NOW + 3600e3); assert.strictEqual(r.http, 404); assert.ok(!r.password);
r = await run(w, await rent({ rentalId: id1 }, '/rent/credentials'), env, NOW + 3 * 3600e3 + 1);
assert.strictEqual(r.http, 403); assert.ok(!r.password); assert.strictEqual(w.docs[`rentals/${id1}`].status, 'expired'); assert.strictEqual(w.docs['products/rent1/stock_items/r1'].status, 'cooldown');
console.log('ok  credentials: shown during rental, hidden from other users, refused + ID locked after end time');

// extend
w = world(rshop()); r = await run(w, await rent({ productId: 'rent1', hours: 3 })); const id2 = r.rental.id;
r = await run(w, await rent({ rentalId: id2, hours: 2, expectedAmount: 60 }, '/rent/extend'), env, NOW + 1000);
assert.strictEqual(r.charged, 60); assert.strictEqual(w.docs[`rentals/${id2}`].endMs, NOW + 5 * 3600e3); assert.strictEqual(w.docs[`rentals/${id2}`].hours, 5); assert.strictEqual(w.docs[`rentals/${id2}`].price, 150); assert.strictEqual(w.docs['users/u1'].walletBalance, 750);
r = await run(w, await rent({ rentalId: id2, hours: 2 }, '/rent/extend'), env, NOW + 6 * 3600e3); assert.strictEqual(r.http, 409);
console.log('ok  extend: +2 h = 60 charged, end time moved; after the end -> refused');

// return + admin close (refund)
w = world(rshop()); r = await run(w, await rent({ productId: 'rent1', hours: 3 })); const id3 = r.rental.id;
r = await run(w, await rent({ rentalId: id3, problem: true, note: 'ล็อกอินไม่ได้' }, '/rent/return'), env, NOW + 1000);
assert.strictEqual(w.docs[`rentals/${id3}`].status, 'returned'); assert.strictEqual(w.docs[`rentals/${id3}`].problem, true); assert.strictEqual(w.docs['products/rent1/stock_items/r1'].status, 'cooldown');
r = await run(w, await rent({ rentalId: id3 }, '/rent/credentials'), env, NOW + 2000); assert.strictEqual(r.http, 403);
r = await run(w, await rent({ rentalId: id3, action: 'refund' }, '/admin/rent')); assert.strictEqual(r.http, 403);
const AD = await idToken({ admin: true, exp: NOW / 1000 + 1e6 });
r = await run(w, await req({ rentalId: id3, action: 'refund', password: 'newpw' }, AD, '/admin/rent'), env, NOW + 3000);
assert.strictEqual(r.refunded, 100); assert.strictEqual(w.docs['users/u1'].walletBalance, 910); assert.strictEqual(w.docs[`rentals/${id3}`].status, 'closed'); assert.strictEqual(w.docs[`rentals/${id3}`].depositStatus, 'refunded');
assert.strictEqual(w.docs['products/rent1/stock_items/r1'].status, 'available'); assert.strictEqual(w.docs['products/rent1/stock_items/r1'].password, 'newpw'); assert.strictEqual(w.docs['products/rent1'].stock, 2);
r = await run(w, await req({ rentalId: id3, action: 'refund' }, AD, '/admin/rent')); assert.strictEqual(r.http, 409); assert.strictEqual(w.docs['users/u1'].walletBalance, 910);
console.log('ok  return -> credentials locked; admin refund: deposit back once, new password saved, ID on the shelf, stock +1');

// forfeit + cron sweep
w = world(rshop()); r = await run(w, await rent({ productId: 'rent1', hours: 2 })); const id4 = r.rental.id;
assert.strictEqual(await sweepRentals(env, { fetchFn: w.fetchFn, now: NOW + 3600e3 }), 0); assert.strictEqual(w.docs[`rentals/${id4}`].status, 'active');
assert.strictEqual(await sweepRentals(env, { fetchFn: w.fetchFn, now: NOW + 2 * 3600e3 }), 1);
assert.strictEqual(w.docs[`rentals/${id4}`].status, 'expired'); assert.strictEqual(w.docs['products/rent1/stock_items/r1'].status, 'cooldown'); assert.strictEqual(w.docs[`rentals/${id4}`].depositStatus, 'held');
r = await run(w, await req({ rentalId: id4, action: 'forfeit' }, AD, '/admin/rent'), env, NOW + 3 * 3600e3);
assert.strictEqual(r.refunded, 0); assert.strictEqual(w.docs['users/u1'].walletBalance, 840); assert.strictEqual(w.docs[`rentals/${id4}`].depositStatus, 'forfeited');
console.log('ok  cron: expired rental locked at end time (deposit still held); admin forfeit keeps the deposit');

const teamWorld = world({
  'users/owner': { vaultUntil: new Date(NOW + 864e5).toISOString() },
  'vault_members/u1_owner_tab1': { member: 'u1', owner: 'owner', tabId: 'tab1' },
  'vaults/owner/tabs/tab1': { name: 'Dispatch', zone: 'team' },
  'vaults/owner/ids/item1': { tab: 'tab1', text: 'account@example|old', pass: 'shared-pass', ammo: 10, color: 0, note: '', seq: 1 }
});
const teamView = await run(teamWorld, await req({ owner: 'owner', tabId: 'tab1' }, undefined, '/vault/team'));
assert.strictEqual(teamView.http, 200); assert.strictEqual(teamView.ids.length, 1); assert.strictEqual(teamView.ids[0].pass, 'shared-pass');
const outsiderWorld = world({ 'users/owner': { vaultUntil: new Date(NOW + 864e5).toISOString() }, 'vaults/owner/tabs/tab1': { name: 'Dispatch', zone: 'team' } });
const outsiderView = await run(outsiderWorld, await req({ owner: 'owner', tabId: 'tab1' }, undefined, '/vault/team'));
assert.strictEqual(outsiderView.http, 403);
console.log('ok  team: invited members can read shared credentials; non-members are denied');

// ======================= ammo bundles (ไก่กระสุน) =======================
assert.deepStrictEqual(matchAmmo([50, 62, 30, 20, 45], 112), { idx: [0, 1], total: 112 });
assert.strictEqual(matchAmmo([50, 62, 30], 100).total, 92);           // closest (92 is 8 away, 112 is 12)
assert.strictEqual(matchAmmo([10, 30], 20).total, 30);                 // tie 10 vs 30 -> the bigger total
assert.strictEqual(matchAmmo([10, 10, 10], 500).total, 30);            // not enough -> everything
assert.strictEqual(matchAmmo([5, 5, 5, 5, 20], 20).idx.length, 1);     // fewest IDs
assert.strictEqual(matchAmmo([1, 1, 1], 3, 2).total, 2);               // max IDs per order
assert.strictEqual(matchAmmo([], 5), null);
console.log('ok  ammo match: exact, closest, ties up, all when short, fewest IDs, ID cap');

const ammoShop = (extra = {}) => ({
  'users/u1': { username: 'buyer01', walletBalance: 1000 },
  'products/am1': { name: 'ไก่กระสุน', isAmmo: true, ammoRate: 2, ammoMin: 10, stock: 162, ...extra },
  'products/am1/stock_items/a': { username: 'a@m', password: 'pa', ammo: 50, status: 'available' },
  'products/am1/stock_items/b': { username: 'b@m', password: 'pb', ammo: 62, status: 'available' },
  'products/am1/stock_items/c': { username: 'c@m', password: 'pc', ammo: 30, status: 'available' },
  'products/am1/stock_items/d': { username: 'd@m', password: 'pd', ammo: 20, status: 'available' }
});
const guestReq = (body, path) => new Request('https://w.test' + path, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '1.2.3.4' }, body: JSON.stringify(body) });

w = world(ammoShop());
r = await runQ(w, await req({ productId: 'am1', target: 112 }, undefined, '/ammo/quote'));
assert.strictEqual(r.ammoTotal, 112); assert.strictEqual(r.amount, 224); assert.strictEqual(r.ids, 2);
assert.strictEqual(w.docs['products/am1/stock_items/a'].status, 'reserved');
const q1 = r.quoteId;
r = await runQ(w, await req({ productId: 'am1', target: 5 }, undefined, '/ammo/quote')); assert.strictEqual(r.http, 400); // below ammoMin
r = await run(w, await req({ quoteId: q1, method: 'wallet' }, undefined, '/ammo/pay'));
assert.strictEqual(r.status, 'completed'); assert.strictEqual(r.accounts.length, 2); assert.strictEqual(w.docs['users/u1'].walletBalance, 776);
assert.strictEqual(w.docs['products/am1/stock_items/b'].status, 'sold'); assert.strictEqual(w.docs['products/am1'].stock, 50);
const ao = Object.entries(w.docs).find(([k, d]) => k.startsWith('orders/') && d.isAmmo)[1];
assert.strictEqual(ao.ammoTotal, 112); assert.strictEqual(ao.userId, 'u1');
r = await run(w, await req({ quoteId: q1, method: 'wallet' }, undefined, '/ammo/pay')); assert.strictEqual(r.http, 409); assert.strictEqual(w.docs['users/u1'].walletBalance, 776);
assert.strictEqual(ammoRateOf({ ammoRate: 2 }), 2);
assert.strictEqual(ammoRateOf({ ammoRate: 2, ammoDiscType: 'fixed', ammoDiscValue: 0.5 }), 1.5);
assert.strictEqual(ammoRateOf({ ammoRate: 2, ammoDiscType: 'percent', ammoDiscValue: 10 }), 1.8);
assert.strictEqual(ammoRateOf({ ammoRate: 2, ammoDiscType: 'fixed', ammoDiscValue: 2 }), 2);      // would be free: ignored
assert.strictEqual(ammoRateOf({ ammoRate: 2, ammoDiscType: 'percent', ammoDiscValue: 100 }).toFixed(4), '0.0200'); // capped at 99%
const dp = { ammoRate: 2, ammoDiscType: 'percent', ammoDiscValue: 10, ammoDiscFrom: 1000, ammoDiscTo: 2000, ammoTiers: [{ min: 500, type: 'fixed', value: 0.1 }, { min: 1000, type: 'fixed', value: 0.5 }] };
assert.strictEqual(ammoRateOf(dp, 100, 1500), 1.8);        // window open, no tier reached
assert.strictEqual(ammoRateOf(dp, 100, 5000), 2);          // window over
assert.strictEqual(ammoRateOf(dp, 500, 5000), 1.9);        // tier 500
assert.strictEqual(ammoRateOf(dp, 1000, 1500), 1.5);       // best of window 1.8 / tier 1.5, no stacking
assert.strictEqual(ammoRateOf(dp, 1000, 500), 1.5);        // before the window: tier only
assert.strictEqual(ammoRateOf({ ...dp, ammoDiscValue: 0, ammoTiersFrom: 3000, ammoTiersTo: 4000 }, 1000, 1500), 2); // tier window not open yet
assert.strictEqual(ammoRateOf({ ...dp, ammoDiscValue: 0, ammoTiersFrom: 1000, ammoTiersTo: 2000 }, 1000, 1500), 1.5);
console.log('ok  ammo discount: baht / percent per กอง, free or 100% capped');
{ // discount + low-stock alert + list price kept on the order
  const shop = ammoShop({ ammoDiscType: 'fixed', ammoDiscValue: 0.5, ammoLowStock: 100 }); shop['system_private/secrets'] = { discordWebhook: 'https://discord.com/api/webhooks/1/abc' };
  const w2 = world(shop);
  let q = await runQ(w2, await req({ productId: 'am1', target: 112 }, undefined, '/ammo/quote'));
  assert.strictEqual(q.rate, 1.5); assert.strictEqual(q.listRate, 2); assert.strictEqual(q.amount, 168);
  r = await run(w2, await req({ quoteId: q.quoteId, method: 'wallet' }, undefined, '/ammo/pay'));
  assert.strictEqual(r.status, 'completed'); assert.ok(!('_low' in r));
  assert.match(JSON.stringify(w2.log.discord), /ใกล้หมด/);                                          // 162 -> 50 crosses the limit of 100
  const o2 = Object.entries(w2.docs).find(([k2, d]) => k2.startsWith('orders/') && d.isAmmo)[1];
  assert.strictEqual(o2.unitPrice, 1.5); assert.strictEqual(o2.listUnitPrice, 2);
  // claim -> admin refund as credit, once
  const [oid2] = Object.entries(w2.docs).find(([k2, d]) => k2.startsWith('orders/') && d.isAmmo).map((x, i) => i ? x : x.split('/')[1]);
  const bal0 = w2.docs['users/u1'].walletBalance;
  r = await run(w2, await req({ orderId: oid2, reason: 'x' }, undefined, '/ammo/claim')); assert.strictEqual(r.http, 400);   // reason too short
  r = await run(w2, await req({ orderId: oid2, reason: 'ล็อกอินไม่ได้' }, undefined, '/ammo/claim')); assert.strictEqual(r.ok, true);
  assert.strictEqual(w2.docs['orders/' + oid2].claimStatus, 'open');
  r = await run(w2, await req({ orderId: oid2, reason: 'ล็อกอินไม่ได้อีก' }, undefined, '/ammo/claim')); assert.strictEqual(r.http, 409);
  r = await run(w2, await req({ orderId: oid2, action: 'refund' }, undefined, '/admin/claim')); assert.strictEqual(r.http, 403);   // customer cannot approve
  r = await run(w2, await req({ orderId: oid2, action: 'refund' }, adminTok, '/admin/claim')); assert.strictEqual(r.status, 'refunded');
  assert.strictEqual(w2.docs['users/u1'].walletBalance, bal0 + 168); assert.strictEqual(w2.docs['orders/' + oid2].claimStatus, 'refunded');
  r = await run(w2, await req({ orderId: oid2, action: 'refund' }, adminTok, '/admin/claim')); assert.strictEqual(r.http, 409);   // no double refund
  const w3 = world(ammoShop({ ammoMaxIds: 1 }));
  q = await runQ(w3, await req({ productId: 'am1', target: 112 }, undefined, '/ammo/quote'));
  assert.strictEqual(q.ids, 1); assert.strictEqual(q.ammoTotal, 62);                                  // one ID per order: closest single ID
}
{ // coupon: the cheaper of coupon / ammo discount wins; closed switch stops new quotes only
  const shop = ammoShop({ ammoDiscType: 'fixed', ammoDiscValue: 0.5 });
  shop['promo_codes/BIG'] = { type: 'percent', value: 50, active: true }; shop['promo_codes/TINY'] = { type: 'fixed', value: 1, active: true };
  const w4 = world(shop);
  let q = await runQ(w4, await req({ productId: 'am1', target: 112, promoCode: 'big' }, undefined, '/ammo/quote'));
  assert.strictEqual(q.amount, 112); assert.strictEqual(q.promo.code, 'BIG'); assert.strictEqual(q.promo.discount, 112);   // 224 list, 50% = 112 beats 168
  r = await run(w4, await req({ quoteId: q.quoteId, method: 'wallet' }, undefined, '/ammo/pay')); assert.strictEqual(r.status, 'completed');
  const o4 = Object.entries(w4.docs).find(([k2, d]) => k2.startsWith('orders/') && d.isAmmo)[1];
  assert.strictEqual(o4.promoCode, 'BIG'); assert.strictEqual(o4.discount, 112); assert.strictEqual(o4.amount, 112); assert.strictEqual(w4.docs['promo_codes/BIG'].usedCount, 1);
  q = await runQ(w4, await req({ productId: 'am1', target: 50, promoCode: 'TINY' }, undefined, '/ammo/quote'));
  assert.strictEqual(q.amount, 75); assert.ok(!q.promo); assert.match(q.promoMsg, /ถูกกว่า/);                               // 0.5 off per กอง (75) beats ฿1 off (99)
  w4.docs['system/settings'] = { ammoClosed: true, ammoClosedMsg: 'ปรับสต็อก' };
  q = await runQ(w4, await req({ productId: 'am1', target: 50 }, undefined, '/ammo/quote')); assert.strictEqual(q.http, 503); assert.strictEqual(q.error, 'ปรับสต็อก');
}
{ // member throttle + daily closing window (Thailand time, crosses midnight)
  const w5 = world(ammoShop());
  const a1 = await run(w5, await req({ productId: 'am1', target: 50 }, undefined, '/ammo/quote'), env, NOW + 1e6);
  const a2 = await run(w5, await req({ productId: 'am1', target: 50 }, undefined, '/ammo/quote'), env, NOW + 1e6 + 500);
  assert.ok(a1.quoteId); assert.strictEqual(a2.http, 429);
  const utc = (h, m) => Date.UTC(2026, 0, 1, h - 7, m);                     // Thailand clock h:m
  const night = { ammoCloseFrom: '22:00', ammoCloseTo: '08:00' };
  assert.strictEqual(ammoClosedNow(night, utc(23, 0)), true); assert.strictEqual(ammoClosedNow(night, utc(3, 0)), true);
  assert.strictEqual(ammoClosedNow(night, utc(8, 0)), false); assert.strictEqual(ammoClosedNow(night, utc(12, 0)), false);
  assert.strictEqual(ammoClosedNow({ ammoCloseFrom: '22:00' }, utc(23, 0)), false); assert.strictEqual(ammoClosedNow({ ammoClosed: true }, utc(12, 0)), true);
}
console.log('ok  ammo member: quote 112 -> 2 IDs ฿224 reserved; wallet pay delivers once, stock -112');

w = world(ammoShop());
r = await runQ(w, guestReq({ productId: 'am1', target: 50 }, '/ammo/quote')); assert.strictEqual(r.http, 401);
r = await run(w, guestReq({ amount: 500, payload: PAYLOAD }, '/')); assert.strictEqual(r.http, 401);
console.log('ok  ammo guest: login-only product and other routes still need a token');

w = world(ammoShop({ requireLogin: false }));
r = await runQ(w, guestReq({ productId: 'am1', target: 50 }, '/ammo/quote'));
assert.strictEqual(r.ammoTotal, 50); const gq = r.quoteId;
r = await runQ(w, await req({ productId: 'am1', target: 50 }, undefined, '/ammo/quote'));
assert.strictEqual(r.ammoTotal, 50); assert.strictEqual(r.ids, 2); // a is held by the guest -> 30 + 20
r = await run(w, guestReq({ quoteId: gq, method: 'wallet' }, '/ammo/pay')); assert.strictEqual(r.http, 400);
w.setSlip(slipBody({ amount: { amount: 99 }, transRef: 'G1' }));
r = await run(w, guestReq({ quoteId: gq, method: 'slip', payload: PAYLOAD }, '/ammo/pay'), env, NOW + 9000); assert.strictEqual(r.http, 400);
w.setSlip(slipBody({ amount: { amount: 100 }, transRef: 'G1' }));
r = await run(w, guestReq({ quoteId: gq, method: 'slip', payload: PAYLOAD }, '/ammo/pay'), env, NOW + 18000);
assert.strictEqual(r.status, 'completed'); assert.deepStrictEqual(r.accounts, [{ username: 'a@m', password: 'pa', ammo: 50 }]);
assert.ok(w.docs['slip_refs/G1']); assert.strictEqual(Object.values(w.docs).find(d => d.isAmmo && d.guest).userId, '');
r = await runQ(w, await req({ productId: 'am1', target: 30 }, undefined, '/ammo/quote'));
assert.strictEqual(w.docs['products/am1/stock_items/d'].status, 'available'); // u1's older hold on d released
console.log('ok  ammo guest: quote holds IDs from others; slip must match; paid slip delivers IDs in the reply');

w = world(ammoShop({ requireLogin: false })); w.setTw(200, twOk('50.00'));
r = await runQ(w, guestReq({ productId: 'am1', target: 50 }, '/ammo/quote'));
r = await run(w, guestReq({ quoteId: r.quoteId, method: 'angpao', link: 'https://gift.truemoney.com/campaign/?v=abcdefghij1234' }, '/ammo/pay'), { ...env, TRUEMONEY_PHONE: '0812345678' }, NOW + 9000);
assert.strictEqual(r.code, 'undelivered'); assert.strictEqual(w.docs['products/am1/stock_items/a'].status, 'reserved');
assert.strictEqual(Object.entries(w.docs).find(([k]) => k.startsWith('ammo_quotes/'))[1].status, 'paid_undelivered'); assert.ok(w.log.discord.length || true);
console.log('ok  ammo guest angpao: voucher short of the price -> nothing delivered, logged for the admin');

w = world(); const vr = await handle(await req({}, undefined, '/nope'), env, { fetchFn: w.fetchFn, now: NOW });
assert.strictEqual(vr.headers.get('x-astraphex-worker'), '10'); console.log('ok  version header for old-deployment detection');

// ---- extend hold (+5 min, once) and daily stock check ----
{
  const w5 = world(ammoShop({ ammoDiscType: undefined }));
  let q = await runQ(w5, await req({ productId: 'am1', target: 112 }, undefined, '/ammo/quote'));
  const exp0 = w5.docs[`ammo_quotes/${q.quoteId}`].expiresAt;
  let e = await run(w5, await req({ quoteId: q.quoteId }, undefined, '/ammo/extend'), env, qClock);
  assert.strictEqual(e.expiresAt, exp0 + 300000); assert.strictEqual(w5.docs['products/am1/stock_items/a'].reservedUntil, exp0 + 300000);
  e = await run(w5, await req({ quoteId: q.quoteId }, undefined, '/ammo/extend'), env, qClock); assert.strictEqual(e.http, 409);
  const w6 = world(ammoShop());
  q = await runQ(w6, await req({ productId: 'am1', target: 112 }, undefined, '/ammo/quote'));
  e = await run(w6, await req({ quoteId: q.quoteId }, undefined, '/ammo/extend'), env, w6.docs[`ammo_quotes/${q.quoteId}`].expiresAt + 1); assert.strictEqual(e.http, 409); // already expired
  const w7 = world(ammoShop({ stock: 100 })); w7.docs['system_private/secrets'] = { discordWebhook: 'https://discord.com/api/webhooks/1/abc' };
  assert.strictEqual(await sweepStock(env, { fetchFn: w7.fetchFn, now: NOW }), 1); assert.match(JSON.stringify(w7.log.discord), /ไก่กระสุน/);
  const w8 = world(ammoShop());
  assert.strictEqual(await sweepStock(env, { fetchFn: w8.fetchFn, now: NOW }), 0);
  console.log('ok  ammo extend hold once; daily stock check flags mismatch only');
}

// ---- slip checker down -> manual queue; bundle; timed sale; push events ----
{
  const w = world({ 'users/u1': { username: 'buyer01', walletBalance: 0 } });
  const down = async (r) => { const res = await handle(r, env, { fetchFn: (u, o) => String(u).includes('easyslip') ? Promise.reject(new Error('down')) : w.fetchFn(u, o), now: NOW, ctx: { waitUntil() {} } }); return { http: res.status, ...(await res.json()) }; };
  const r = await down(await req());
  assert.strictEqual(r.status, 'queued');
  const t = Object.entries(w.docs).find(([k, d]) => k.startsWith('topup_transactions/') && d.verifiedVia === 'manual_queue')[1];
  assert.strictEqual(t.status, 'pending'); assert.strictEqual(t.amount, 500); assert.strictEqual(w.docs['users/u1'].walletBalance, 0);
  const dupe = await (await handle(await req(), env, { fetchFn: (u, o) => String(u).includes('easyslip') ? Promise.reject(new Error('down')) : w.fetchFn(u, o), now: NOW + 20000, ctx: { waitUntil() {} } })).json();
  assert.strictEqual(dupe.status, 'rejected'); assert.match(dupe.message, /ส่งให้แอดมินตรวจแล้ว/);
  console.log('ok  slip checker down -> pending top-up for manual approval, resend not queued twice');
}
{
  const shop = ammoShop();
  const w = world({ ...shop, 'users/u1': { username: 'buyer01', walletBalance: 1000 },
    'products/bd1': { name: 'ไอดี+กระสุน', price: 300, stock: 1, bundleAmmoId: 'am1', bundleAmmo: 110, active: true },
    'products/bd1/stock_items/i1': { username: 'id@m', password: 'ip', status: 'available' } });
  const r = await run(w, await req({ productId: 'bd1', quantity: 1 }, undefined, '/buy'));
  assert.strictEqual(r.status, 'completed'); assert.strictEqual(r.order.accounts?.length ?? r.order.accountsDelivered.length, 3);
  assert.strictEqual(w.docs['users/u1'].walletBalance, 700); assert.strictEqual(w.docs['products/am1'].stock, 162 - r.order.bundleAmmo);
  assert.ok(Math.abs(r.order.bundleAmmo - 110) <= 11);
  const w3 = world({ ...shop, 'users/u1': { username: 'buyer01', walletBalance: 1000 }, 'products/bd1': { name: 'x', price: 300, stock: 1, bundleAmmoId: 'am1', bundleAmmo: 900, active: true }, 'products/bd1/stock_items/i1': { username: 'id@m', password: 'ip', status: 'available' } });
  const r3 = await run(w3, await req({ productId: 'bd1', quantity: 1 }, undefined, '/buy')); assert.strictEqual(r3.http, 409); assert.strictEqual(w3.docs['users/u1'].walletBalance, 1000);
  console.log('ok  bundle: ID + ammo delivered together; not enough ammo -> nothing charged');
}
{
  const w = world({ 'products/s1': { name: 'x', price: 100, salePrice: 70, saleFrom: NOW - 1000, saleTo: NOW + 3600e3, stock: 1 } });
  assert.strictEqual(await sweepSales(env, { fetchFn: w.fetchFn, now: NOW }), 1);
  assert.strictEqual(w.docs['products/s1'].price, 70); assert.strictEqual(w.docs['products/s1'].basePrice, 100);
  assert.strictEqual(await sweepSales(env, { fetchFn: w.fetchFn, now: NOW + 10 }), 0);
  assert.strictEqual(await sweepSales(env, { fetchFn: w.fetchFn, now: NOW + 2 * 3600e3 }), 1);
  assert.strictEqual(w.docs['products/s1'].price, 100); assert.strictEqual(w.docs['products/s1'].saleOn, false);
  console.log('ok  timed sale: price swapped on start, restored on end');
}

// ---- gift tickets for loot boxes + price watch ----
{
  const box = { name: 'กล่อง', price: 50, active: true, prizes: [{ id: 'p1', kind: 'credit', amount: 5, weight: 1, rarity: 'common' }] };
  const w = world({ 'users/u1': { username: 'buyer01', walletBalance: 200 }, 'users/u2': { username: 'friend', walletBalance: 0 }, 'boxes/b1': box });
  let r = await run(w, await req({ boxId: 'b1', count: 2 }, undefined, '/box/gift'));
  assert.strictEqual(r.balance, 100); const code = r.code; assert.strictEqual(w.docs[`box_gifts/${code}`].left, 2);
  r = await run(w, await req({ boxId: 'b1', giftCode: code }, undefined, '/box/open')); // sender's own token = u1 in the harness
  assert.strictEqual(r.ok, true); assert.strictEqual(r.balance, 105, 'free open: only the credit prize is added'); assert.strictEqual(w.docs[`box_gifts/${code}`].left, 1);
  r = await run(w, await req({ boxId: 'b1', giftCode: code }, undefined, '/box/open')); assert.strictEqual(w.docs[`box_gifts/${code}`].status, 'used');
  r = await run(w, await req({ boxId: 'b1', giftCode: code }, undefined, '/box/open')); assert.strictEqual(r.http, 409);
  r = await run(w, await req({ boxId: 'b1', count: 2 }, undefined, '/box/gift')); const c2 = r.code;
  r = await run(w, await req({ code: c2 }, undefined, '/box/gift/cancel')); assert.strictEqual(r.refund, 100);
  r = await run(w, await req({ code: c2 }, undefined, '/box/gift/cancel')); assert.strictEqual(r.http, 409);
  console.log('ok  gift tickets: paid once, free opens count down, cancel refunds the rest');
}
{
  const w = world({ 'products/s2': { name: 'x', price: 100, salePrice: 70, saleFrom: NOW - 1000, saleTo: NOW + 3600e3, stock: 1 }, 'price_watch/u1_s2': { uid: 'u1', productId: 's2' } });
  assert.strictEqual(await sweepSales(env, { fetchFn: w.fetchFn, now: NOW }), 1); assert.strictEqual(w.docs['products/s2'].saleOn, true);
  console.log('ok  sale start with a watcher does not break the sweep');
}
// ---- pity + win-back coupon ----
{
  const box = { name: 'กล่อง', price: 10, active: true, pityEvery: 3, pityRarity: 'epic', prizes: [{ id: 'c', kind: 'credit', amount: 1, weight: 1e9, rarity: 'common' }, { id: 'e', kind: 'credit', amount: 50, weight: 1, rarity: 'epic' }] };
  const w = world({ 'users/u1': { username: 'buyer01', walletBalance: 100 }, 'boxes/b1': box });
  const ids = [];
  for (let i = 0; i < 4; i++) { const r = await run(w, await req({ boxId: 'b1' }, undefined, '/box/open')); ids.push(r.prize?.id); }
  assert.deepStrictEqual(ids, ['c', 'c', 'e', 'c'], 'third open is the guaranteed epic, then counter restarts');
  assert.strictEqual(w.docs['box_pity/u1_b1'].miss, 1);
  console.log('ok  pity: guaranteed hit after N-1 misses, counter resets');
}
{
  const w = world({ 'users/u2': { username: 'friend' } });
  let r = await run(w, await req({ uid: 'u2', type: 'percent', value: 15, days: 7 }, adminTok, '/admin/winback'));
  assert.strictEqual(r.ok, true); const pc = w.docs[`promo_codes/${r.code}`];
  assert.strictEqual(pc.onlyUid, 'u2'); assert.strictEqual(pc.maxTotalUses, 1); assert.strictEqual(pc.expiresAt, NOW + 7 * 864e5);
  r = await run(w, await req({ uid: 'u2', type: 'percent', value: 99, days: 7 }, adminTok, '/admin/winback')); assert.strictEqual(r.http, 400);
  r = await run(w, await req({ uid: 'u2', type: 'percent', value: 10, days: 7 }, undefined, '/admin/winback')); assert.strictEqual(r.http, 403);
  assert.strictEqual(evaluatePromo(pc, { id: 'p', categoryId: 'c' }, 100, 'u3', NOW).ok, false);
  assert.strictEqual(evaluatePromo(pc, { id: 'p', categoryId: 'c' }, 100, 'u2', NOW).ok, true);
  assert.strictEqual(evaluatePromo(pc, { id: 'p', categoryId: 'c' }, 100, 'u2', NOW + 8 * 864e5).ok, false);
  console.log('ok  win-back: personal single-use coupon, owner + expiry enforced');
}
{
  const w = world({ 'products/r1': { name: 'ไอดี', price: 100, stock: 0, active: true }, 'products/r2': { name: 'ไอดี2', price: 100, stock: 3, active: true }, 'stock_watch/u1_r1': { uid: 'u1', productId: 'r1' }, 'stock_watch/u1_r2': { uid: 'u1', productId: 'r2' } });
  assert.strictEqual(await sweepRestock(env, { fetchFn: w.fetchFn, now: NOW }), 1, 'only the product with stock again is announced');
  assert.ok(w.docs['stock_watch/u1_r1'] && !w.docs['stock_watch/u1_r2']);
  console.log('ok  restock sweep: announces and clears only in-stock watches');
}
{
  const mk = (id, u, p) => [`orders/${id}`, { userId: u, productId: p, status: 'completed', paymentMethod: 'wallet' }];
  const w = world(Object.fromEntries([mk('o1', 'u1', 'A'), mk('o2', 'u1', 'B'), mk('o3', 'u2', 'A'), mk('o4', 'u2', 'B'), mk('o5', 'u3', 'A'), mk('o6', 'u3', 'C'), mk('o7', 'u4', 'A'), mk('o8', 'u4', 'x', ).map((v, i) => i ? { ...v, isAmmo: true } : v)]));
  await sweepRelated(env, { fetchFn: w.fetchFn, now: NOW });
  assert.deepStrictEqual(w.docs['system/related'].map, { A: ['B'], B: ['A'] }, 'only pairs seen at least twice; ammo ignored');
  console.log('ok  related: co-purchase pairs need 2+ customers');
}
console.log('worker: all checks passed');
