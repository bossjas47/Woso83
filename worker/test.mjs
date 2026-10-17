// Run: node worker/test.mjs (Node 20+). Fakes Google, Firestore and EasySlip; no network.
import assert from 'assert';
import { handle } from './slip-worker.js';

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
  const p = b64u(JSON.stringify({ aud: PID, iss: `https://securetoken.google.com/${PID}`, sub: 'u1', email: 'a@b.c', iat: NOW / 1000 - 10, exp: NOW / 1000 + 3000, ...over }));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', fb.privateKey, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64u(sig)}`;
}
const PAYLOAD = '00020101021230' + '0'.repeat(30);
const slipBody = (over = {}) => ({ success: true, data: { transRef: 'REF1', amount: { amount: 500 }, date: new Date(NOW - 3600e3).toISOString(), sender: { account: { name: { th: 'นาย ทดสอบ' } } }, receiver: { bank: { short: 'SCB' }, account: { name: { th: 'นาย ร้านทดสอบ' } } }, ...over } });

function world(seed = {}) {
  const docs = { 'system/settings': { slipAutoVerify: true }, ...seed };
  const log = { easyslip: [], commits: [] };
  let slip = slipBody();
  const fetchFn = async (url, opt = {}) => {
    const u = String(url);
    const res = (o, status = 200) => ({ ok: status < 300, status, json: async () => o });
    if (u.includes('/jwk/')) return res({ keys: [jwk] });
    if (u.includes('oauth2.googleapis.com')) return res({ access_token: 'AT' });
    if (u.includes('easyslip.com')) { log.easyslip.push({ auth: opt.headers.authorization, body: JSON.parse(opt.body) }); return res(slip); }
    if (u.endsWith(':commit')) {
      const writes = JSON.parse(opt.body).writes;
      for (const w of writes) if (w.currentDocument?.exists === false && w.update.name.split('/documents/')[1] in docs) return res({}, 409);
      for (const w of writes) {
        const path = w.update.name.split('/documents/')[1];
        const f = Object.fromEntries(Object.entries(w.update.fields || {}).map(([k, v]) => [k, v.stringValue ?? v.booleanValue ?? Number(v.integerValue ?? v.doubleValue)]));
        docs[path] = { ...(docs[path] || {}), ...f };
        for (const t of w.updateTransforms || []) docs[path][t.fieldPath] = t.increment ? (docs[path][t.fieldPath] || 0) + t.increment.doubleValue : 'TS';
      }
      log.commits.push(writes.length);
      return res({});
    }
    const path = u.split('/documents/')[1];
    if (!(path in docs)) return res({}, 404);
    const o = Object.fromEntries(Object.entries(docs[path]).map(([k, v]) => [k, typeof v === 'boolean' ? { booleanValue: v } : typeof v === 'number' ? { integerValue: String(v) } : { stringValue: v }]));
    return res({ fields: o });
  };
  return { docs, log, fetchFn, setSlip: (s) => { slip = s; } };
}
const env = { SERVICE_ACCOUNT: SA, EASYSLIP_KEY: 'EK', RECEIVER_MATCH: 'ร้านทดสอบ' };
const req = async (body = { amount: 500, payload: PAYLOAD }, token) => new Request('https://w.test', { method: 'POST', headers: { authorization: `Bearer ${token ?? await idToken()}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const run = async (w, r, e = env, now = NOW) => { const res = await handle(r, e, { fetchFn: w.fetchFn, now }); return { status: res.status, ...(await res.json()) }; };

let w = world();
let r = await run(w, await req());
assert.strictEqual(r.status, 'completed');
assert.strictEqual(r.credit, 525); assert.strictEqual(w.docs['users/u1'].walletBalance, 525);
assert.ok(w.docs['slip_refs/REF1']); assert.strictEqual(w.log.easyslip[0].auth, 'Bearer EK'); assert.strictEqual(w.log.easyslip[0].body.payload, PAYLOAD);
const t = Object.entries(w.docs).find(([k]) => k.startsWith('topup_transactions/'))[1];
assert.strictEqual(t.finalCredit, 525); assert.strictEqual(t.status, 'completed'); assert.strictEqual(t.uid, 'u1'); console.log('ok  500 + 25 bonus credited, one atomic commit of 3 writes');

r = await run(w, await req(), env, NOW + 20000);
assert.strictEqual(r.status, 'rejected'); assert.strictEqual(w.docs['users/u1'].walletBalance, 525); console.log('ok  same slip twice -> rejected (409), no second credit');

w = world();
for (const [tok, label] of [[await idToken({ aud: 'other' }), 'wrong project'], [await idToken({ exp: NOW / 1000 - 5 }), 'expired'], ['a.b.c', 'garbage']]) {
  r = await run(w, await req(undefined, tok)); assert.strictEqual(r.status, 401, label);
}
const bad = (await idToken()).split('.'); bad[2] = bad[2].slice(0, -4) + 'AAAA';
assert.strictEqual((await run(w, await req(undefined, bad.join('.')))).status, 401); assert.ok(!w.docs['users/u1']); console.log('ok  bad token (wrong project / expired / garbage / forged signature) -> 401');

w = world(); w.setSlip(slipBody({ amount: { amount: 400 } }));
r = await run(w, await req()); assert.strictEqual(r.status, 'rejected'); assert.ok(!w.docs['users/u1']); console.log('ok  amount differs -> rejected');

w = world(); w.setSlip(slipBody({ receiver: { account: { name: { th: 'คนอื่น' } } } }));
r = await run(w, await req()); assert.strictEqual(r.status, 'rejected'); assert.ok(!w.docs['users/u1']); console.log('ok  paid to another account -> rejected');

w = world(); w.setSlip(slipBody({ date: new Date(NOW - 5 * 864e5).toISOString() }));
r = await run(w, await req()); assert.strictEqual(r.status, 'rejected'); console.log('ok  old slip -> rejected');

w = world(); w.setSlip({ success: false, error: { message: 'สลิปปลอม' } });
r = await run(w, await req()); assert.strictEqual(r.message, 'สลิปปลอม'); console.log('ok  EasySlip error message passed through');

w = world(); w.setSlip({ success: true, data: { rawSlip: slipBody().data } });
r = await run(w, await req()); assert.strictEqual(r.status, 'completed'); console.log('ok  rawSlip wrapper also accepted');

w = world();
await run(w, await req({ amount: 500, payload: PAYLOAD })); w.setSlip(slipBody({ transRef: 'R2' }));
r = await run(w, await req(), env, NOW + 3000); assert.strictEqual(r.status, 'rejected'); assert.strictEqual(w.docs['users/u1'].walletBalance, 525); console.log('ok  throttle: 2nd call within 10s blocked');

for (const [seed, e] of [[{ 'system/settings': { slipAutoVerify: false } }, env], [{}, { ...env, RECEIVER_MATCH: '' }], [{}, { ...env, EASYSLIP_KEY: '' }]]) {
  w = world(seed); r = await run(w, await req(), e); assert.strictEqual(r.status, 'manual'); assert.strictEqual(w.log.easyslip.length, 0);
} console.log('ok  switch off / no receiver / no key -> manual, EasySlip never called');

w = world();
for (const body of [{ amount: 5, payload: PAYLOAD }, { amount: 500.555, payload: PAYLOAD }, { amount: 500, payload: 'x' }, { amount: 99999, payload: PAYLOAD }]) assert.strictEqual((await run(w, await req(body))).status, 400);
console.log('ok  bad amount / payload -> 400 before any call');

const o = await handle(new Request('https://w.test', { method: 'OPTIONS' }), env, { fetchFn: w.fetchFn, now: NOW });
assert.strictEqual(o.status, 204); assert.ok(o.headers.get('access-control-allow-origin')); console.log('ok  CORS preflight');
console.log('worker: all checks passed');
