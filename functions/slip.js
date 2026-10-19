// Pure slip-check logic, so it can be tested without Firebase or the network.
// shortcut: SlipOK response codes are not mapped one by one; any non-success is shown as its message. Map them if you need per-reason UX.

const MIN_AMOUNT = 20;
const MAX_AMOUNT = 50000;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const THROTTLE_MS = 10000;
// Same table as the packs on front/topup.html. Custom amounts get no bonus.
const BONUS = { 500: 25, 1000: 80, 2000: 200 };

function parseRequest(data) {
  const amount = Number(data?.amount);
  if (!Number.isFinite(amount) || amount < MIN_AMOUNT || amount > MAX_AMOUNT || Math.round(amount * 100) !== amount * 100) {
    throw Object.assign(new Error('ยอดเงินไม่ถูกต้อง'), { code: 'invalid-argument' });
  }
  const b64 = String(data?.imageBase64 || '').replace(/^data:image\/\w+;base64,/, '');
  const image = Buffer.from(b64, 'base64');
  if (image.length < 1000 || image.length > MAX_IMAGE_BYTES) {
    throw Object.assign(new Error('ไฟล์สลิปไม่ถูกต้องหรือใหญ่เกินไป'), { code: 'invalid-argument' });
  }
  return { amount, image };
}

const norm = (v) => String(v ?? '').toLowerCase().replace(/[\s\-]/g, '');

async function checkWithSlipOk({ fetchFn, key, branch, receiver, image, amount }) {
  const form = new FormData();
  form.append('files', new Blob([image], { type: 'image/jpeg' }), 'slip.jpg');
  form.append('amount', String(amount));
  form.append('log', 'true');
  const res = await fetchFn(`https://api.slipok.com/api/line/apikey/${encodeURIComponent(branch)}`, {
    method: 'POST',
    headers: { 'x-authorization': key },
    body: form
  });
  const body = await res.json().catch(() => ({}));
  const d = body.data || {};
  if (!res.ok || body.success !== true || d.success === false) {
    return { ok: false, message: body.message || d.message || 'ตรวจสลิปไม่ผ่าน' };
  }
  if (!d.transRef) return { ok: false, message: 'ไม่พบเลขอ้างอิงในสลิป' };
  if (Number(d.amount) !== amount) return { ok: false, message: 'ยอดในสลิปไม่ตรงกับที่ระบุ' };
  // Without this, a slip for a transfer to ANY account (a friend, your own) would credit the wallet.
  if (!norm(JSON.stringify({ r: d.receiver, b: d.receivingBank, n: d.receiverName })).includes(norm(receiver))) {
    return { ok: false, message: 'บัญชีผู้รับในสลิปไม่ตรงกับบัญชีของร้าน' };
  }
  return { ok: true, transRef: String(d.transRef) };
}

// One transaction: the slip reference can be used once, the wallet is credited, the record is written.
async function creditSlip({ db, FieldValue, uid, email, amount, transRef }) {
  const bonus = BONUS[amount] || 0;
  const refDoc = db.collection('slip_refs').doc(transRef);
  const userDoc = db.collection('users').doc(uid);
  const txnDoc = db.collection('topup_transactions').doc();
  await db.runTransaction(async (t) => {
    if ((await t.get(refDoc)).exists) throw Object.assign(new Error('สลิปนี้ถูกใช้แล้ว'), { code: 'already-exists' });
    t.set(refDoc, { uid, amount, at: FieldValue.serverTimestamp() });
    t.set(userDoc, { walletBalance: FieldValue.increment(amount + bonus), lastTopupAt: FieldValue.serverTimestamp() }, { merge: true });
    t.set(txnDoc, {
      txnId: 'TOPUP-' + txnDoc.id.slice(0, 8).toUpperCase(), uid, email: email || '', amount, bonusCredit: bonus,
      finalCredit: amount + bonus, paymentMethod: 'promptpay', proofRef: transRef, status: 'completed',
      verifiedVia: 'slipok', createdAt: FieldValue.serverTimestamp(), completedAt: FieldValue.serverTimestamp()
    });
  });
  return { credit: amount + bonus };
}

// Whole flow. Returns {status:'completed'|'rejected'|'manual', ...}; throws only for bad requests.
async function verifyTopupSlip({ db, FieldValue, fetchFn, uid, email, data, now = Date.now() }) {
  const { amount, image } = parseRequest(data);
  const [settings, secrets, attempt] = await Promise.all([
    db.doc('system/settings').get(), db.doc('system_private/secrets').get(), db.doc(`slip_attempts/${uid}`).get()
  ]);
  const key = secrets.exists && secrets.data().slipokKey;
  const branch = secrets.exists && secrets.data().slipokBranch;
  const receiver = secrets.exists && secrets.data().slipokReceiver; // shop account name or last digits as printed on the slip
  if (!(settings.exists && settings.data().slipAutoVerify === true) || !key || !branch || !receiver) return { status: 'manual' };

  if (attempt.exists && now - attempt.data().at < THROTTLE_MS) return { status: 'rejected', message: 'ส่งสลิปถี่เกินไป รอสักครู่แล้วลองใหม่' };
  await db.doc(`slip_attempts/${uid}`).set({ at: now });

  const check = await checkWithSlipOk({ fetchFn, key, branch, receiver, image, amount });
  if (!check.ok) return { status: 'rejected', message: check.message };
  try {
    const { credit } = await creditSlip({ db, FieldValue, uid, email, amount, transRef: check.transRef });
    return { status: 'completed', credit };
  } catch (e) {
    if (e.code === 'already-exists') return { status: 'rejected', message: e.message };
    throw e;
  }
}

module.exports = { parseRequest, checkWithSlipOk, creditSlip, verifyTopupSlip, BONUS };
