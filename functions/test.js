// Run: node functions/test.js (Node 18+). Fakes the Admin SDK and SlipOK; no network.
const assert = require('assert');
const { verifyTopupSlip, parseRequest } = require('./slip');

function makeDb(seed) {
  const data = { ...seed }; let n = 0;
  const snap = (p) => ({ exists: p in data, data: () => data[p] });
  const ref = (p) => ({ id: p.split('/').pop(), path: p, get: async () => snap(p), set: async (v, o) => { data[p] = o?.merge ? merge(data[p], v) : v; } });
  const merge = (cur = {}, v) => { const out = { ...cur }; for (const [k, x] of Object.entries(v)) out[k] = x && x.__inc !== undefined ? (out[k] || 0) + x.__inc : x; return out; };
  return {
    data,
    doc: ref,
    collection: (c) => ({ doc: (id) => ref(`${c}/${id || 'AUTO' + (++n) + 'ABCDEFGH'}`) }),
    runTransaction: async (fn) => {
      const writes = [];
      await fn({ get: async (r) => r.get(), set: (r, v, o) => writes.push([r, v, o]) });
      for (const [r, v, o] of writes) await r.set(v, o);
    }
  };
}
const FV = { serverTimestamp: () => 'TS', increment: (x) => ({ __inc: x }) };
const IMG = Buffer.alloc(2000, 1).toString('base64');
const ready = { 'system/settings': { slipAutoVerify: true }, 'system_private/secrets': { slipokKey: 'K', slipokBranch: '0001', slipokReceiver: 'ร้านทดสอบ' } };
const slipOk = (over = {}) => async (url, opt) => {
  slipOk.calls.push({ url, key: opt.headers['x-authorization'] });
  return { ok: true, json: async () => ({ success: true, data: { success: true, transRef: 'REF1', amount: 500, receiver: { displayName: 'นาย ร้านทดสอบ จำกัด' }, ...over } }) };
};
slipOk.calls = [];

(async () => {
  const run = (db, data, fetchFn = slipOk(), now = 1e9) => verifyTopupSlip({ db, FieldValue: FV, fetchFn, uid: 'u1', email: 'a@b.c', data, now });

  let db = makeDb(ready);
  let r = await run(db, { amount: 500, imageBase64: IMG });
  assert.deepStrictEqual(r, { status: 'completed', credit: 525 });
  assert.strictEqual(db.data['users/u1'].walletBalance, 525);
  assert.ok(db.data['slip_refs/REF1']);
  const txn = Object.entries(db.data).find(([k]) => k.startsWith('topup_transactions/'))[1];
  assert.strictEqual(txn.status, 'completed'); assert.strictEqual(txn.verifiedVia, 'slipok'); assert.strictEqual(txn.finalCredit, 525);
  assert.ok(slipOk.calls[0].url.endsWith('/0001') && slipOk.calls[0].key === 'K'); console.log('ok  completed: 500 + 25 bonus, key sent to SlipOK');

  r = await run(db, { amount: 500, imageBase64: IMG }, slipOk(), 1e9 + 20000);
  assert.strictEqual(r.status, 'rejected'); assert.strictEqual(db.data['users/u1'].walletBalance, 525); console.log('ok  same slip twice -> rejected, no second credit');

  db = makeDb(ready);
  r = await run(db, { amount: 500, imageBase64: IMG }, slipOk({ amount: 400 }));
  assert.strictEqual(r.status, 'rejected'); assert.ok(!db.data['users/u1']); console.log('ok  slip amount differs -> rejected');

  db = makeDb(ready);
  r = await run(db, { amount: 500, imageBase64: IMG }, slipOk({ receiver: { displayName: 'คนอื่น' } }));
  assert.strictEqual(r.status, 'rejected'); assert.ok(!db.data['users/u1']); console.log('ok  slip paid to another account -> rejected');

  db = makeDb({ ...ready, 'system_private/secrets': { slipokKey: 'K', slipokBranch: '0001' } });
  assert.deepStrictEqual(await run(db, { amount: 500, imageBase64: IMG }), { status: 'manual' }); console.log('ok  no receiver configured -> manual, never auto-credit');

  db = makeDb(ready);
  r = await run(db, { amount: 500, imageBase64: IMG }, async () => ({ ok: false, json: async () => ({ code: 1012, message: 'สลิปปลอม' }) }));
  assert.deepStrictEqual(r, { status: 'rejected', message: 'สลิปปลอม' }); console.log('ok  SlipOK error message passed through');

  db = makeDb(ready);
  await run(db, { amount: 500, imageBase64: IMG }, slipOk({ transRef: 'R9' }), 1e9);
  r = await run(db, { amount: 500, imageBase64: IMG }, slipOk({ transRef: 'R10' }), 1e9 + 3000);
  assert.strictEqual(r.status, 'rejected'); assert.strictEqual(db.data['users/u1'].walletBalance, 525); console.log('ok  throttle: 2nd call within 10s blocked');

  for (const seed of [{}, { ...ready, 'system/settings': { slipAutoVerify: false } }, { 'system/settings': { slipAutoVerify: true }, 'system_private/secrets': { slipokKey: 'K' } }]) {
    r = await run(makeDb(seed), { amount: 500, imageBase64: IMG });
    assert.deepStrictEqual(r, { status: 'manual' });
  } console.log('ok  no key / switch off / no branch -> manual (admin checks by hand)');

  for (const bad of [{ amount: 5, imageBase64: IMG }, { amount: 99999, imageBase64: IMG }, { amount: 100.123, imageBase64: IMG }, { amount: 100, imageBase64: 'abc' }, {}]) {
    assert.throws(() => parseRequest(bad), /ไม่ถูกต้อง/);
  } console.log('ok  bad amount / image rejected before any call');

  db = makeDb(ready);
  r = await run(db, { amount: 100, imageBase64: IMG }, slipOk({ amount: 100, transRef: 'R3' }));
  assert.strictEqual(r.credit, 100); console.log('ok  custom amount: no bonus');
  console.log('functions: all checks passed');
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
