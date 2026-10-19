// Cloudflare Worker: checks a bank slip with EasySlip and credits the wallet in Firestore.
// The browser only sends {amount, payload} (the text of the QR printed on the slip) plus the user's Firebase ID token.
// Variables (Worker > Settings > Variables and Secrets):
//   SERVICE_ACCOUNT  secret  the Firebase service-account JSON, pasted as text
//   EASYSLIP_KEY     secret  EasySlip API key
//   RECEIVER_MATCH   text    shop account name or last digits as printed on the slip (required)
//   ALLOWED_ORIGIN   text    optional, your site origin, e.g. https://shop.example.com (default: any)
// Firestore doc system/settings.slipAutoVerify must be true, otherwise the reply is {status:'manual'}.
const MIN = 20, MAX = 50000, THROTTLE_MS = 10000, MAX_SLIP_AGE_MS = 3 * 864e5;
const BONUS = { 500: 25, 1000: 80, 2000: 200 }; // same table as front/topup.html; custom amounts get none
const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

const enc = new TextEncoder();
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const norm = (v) => String(v ?? '').toLowerCase().replace(/[\s\-]/g, '');
const fail = (code, message) => Object.assign(new Error(message), { code });

let jwksCache = { at: 0, keys: [] };
let tokenCache = { at: 0, token: '' };

async function verifyIdToken(token, projectId, fetchFn, now) {
  try { return await verifyIdTokenInner(token, projectId, fetchFn, now); }
  catch (e) { throw typeof e.code === 'string' ? e : fail('unauthenticated', 'โทเคนไม่ถูกต้อง'); } // malformed tokens must be 401, not 500
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
  return { uid: claims.sub, email: claims.email || '' };
}

async function accessToken(sa, fetchFn, now) {
  if (tokenCache.token && now - tokenCache.at < 3000e3) return tokenCache.token;
  const iat = Math.floor(now / 1000);
  const head = b64u(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const body = b64u(enc.encode(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/datastore', aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600 })));
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

function fsClient(projectId, token, fetchFn) {
  const root = `projects/${projectId}/databases/(default)/documents`;
  const base = `https://firestore.googleapis.com/v1/${root}`;
  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const val = (x) => typeof x === 'string' ? { stringValue: x } : typeof x === 'boolean' ? { booleanValue: x }
    : Number.isInteger(x) ? { integerValue: String(x) } : { doubleValue: x };
  const plain = (f = {}) => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.stringValue ?? v.booleanValue ?? Number(v.integerValue ?? v.doubleValue)]));
  return {
    name: (path) => `${root}/${path}`,
    fields: (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, val(v)])),
    async get(path) {
      const r = await fetchFn(`${base}/${path}`, { headers: auth });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error('firestore read ' + r.status);
      return plain((await r.json()).fields);
    },
    async commit(writes) {
      const r = await fetchFn(`${base}:commit`, { method: 'POST', headers: auth, body: JSON.stringify({ writes }) });
      if (r.status === 409) throw fail('already-exists', 'สลิปนี้ถูกใช้แล้ว');
      if (!r.ok) throw new Error('firestore commit ' + r.status);
    }
  };
}

// EasySlip v2 /verify/bank. Response fields are read defensively because the exact shape (rawSlip wrapper or not) can differ.
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
  // Without this, a slip for a transfer to ANY account would credit the wallet.
  if (!norm(JSON.stringify(s.receiver)).includes(norm(receiver))) return { ok: false, message: 'บัญชีผู้รับในสลิปไม่ตรงกับบัญชีของร้าน' };
  const at = Date.parse(s.date);
  if (Number.isFinite(at) && now - at > MAX_SLIP_AGE_MS) return { ok: false, message: 'สลิปเก่าเกินไป' };
  return { ok: true, transRef: String(s.transRef) };
}

export async function handle(request, env, { fetchFn = fetch, now = Date.now() } = {}) {
  const cors = { 'access-control-allow-origin': env.ALLOWED_ORIGIN || '*', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'POST, OPTIONS' };
  const reply = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', ...cors } });
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return reply({ error: 'method not allowed' }, 405);
  try {
    const sa = JSON.parse(env.SERVICE_ACCOUNT || '{}');
    const user = await verifyIdToken((request.headers.get('authorization') || '').replace(/^Bearer /, ''), sa.project_id, fetchFn, now);
    const data = await request.json().catch(() => ({}));
    const amount = Number(data.amount);
    const payload = String(data.payload || '');
    if (!Number.isFinite(amount) || amount < MIN || amount > MAX || Math.round(amount * 100) !== amount * 100) return reply({ error: 'ยอดเงินไม่ถูกต้อง' }, 400);
    if (payload.length < 20 || payload.length > 2000) return reply({ error: 'ไม่พบ QR ที่อ่านได้บนสลิป' }, 400);

    const fs = fsClient(sa.project_id, await accessToken(sa, fetchFn, now), fetchFn);
    const settings = await fs.get('system/settings');
    if (!(settings && settings.slipAutoVerify === true) || !env.EASYSLIP_KEY || !env.RECEIVER_MATCH) return reply({ status: 'manual' });

    const attempt = await fs.get(`slip_attempts/${user.uid}`);
    if (attempt && now - attempt.at < THROTTLE_MS) return reply({ status: 'rejected', message: 'ส่งสลิปถี่เกินไป รอสักครู่แล้วลองใหม่' });
    await fs.commit([{ update: { name: fs.name(`slip_attempts/${user.uid}`), fields: fs.fields({ at: now }) } }]);

    const check = await checkSlip({ fetchFn, key: env.EASYSLIP_KEY, receiver: env.RECEIVER_MATCH, payload, amount, now });
    if (!check.ok) return reply({ status: 'rejected', message: check.message });

    const bonus = BONUS[amount] || 0;
    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 20);
    const stamp = (fieldPath) => ({ fieldPath, setToServerValue: 'REQUEST_TIME' });
    try {
      // One atomic commit: the slip reference can be used once (exists:false), the wallet is credited, the record is written.
      await fs.commit([
        { update: { name: fs.name(`slip_refs/${check.transRef}`), fields: fs.fields({ uid: user.uid, amount }) }, updateTransforms: [stamp('at')], currentDocument: { exists: false } },
        { update: { name: fs.name(`users/${user.uid}`) }, updateMask: { fieldPaths: [] }, updateTransforms: [{ fieldPath: 'walletBalance', increment: { doubleValue: amount + bonus } }, stamp('lastTopupAt')] },
        { update: { name: fs.name(`topup_transactions/${id}`), fields: fs.fields({ txnId: 'TOPUP-' + id.slice(0, 8).toUpperCase(), uid: user.uid, email: user.email, amount, bonusCredit: bonus, finalCredit: amount + bonus, paymentMethod: 'promptpay', proofRef: check.transRef, status: 'completed', verifiedVia: 'easyslip' }) }, updateTransforms: [stamp('createdAt'), stamp('completedAt')] }
      ]);
    } catch (e) {
      if (e.code === 'already-exists') return reply({ status: 'rejected', message: e.message });
      throw e;
    }
    return reply({ status: 'completed', credit: amount + bonus });
  } catch (e) {
    if (e.code === 'unauthenticated') return reply({ error: e.message }, 401);
    console.error('slip worker failed', e);
    return reply({ error: 'ตรวจสลิปไม่สำเร็จ' }, 500);
  }
}

export default { fetch: (request, env) => handle(request, env) };
