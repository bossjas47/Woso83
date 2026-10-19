const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { verifyTopupSlip } = require('./slip');

initializeApp();

// The SlipOK key is read here from system_private/secrets (admin-only). It never reaches a browser.
exports.verifyTopupSlip = onCall({ region: 'asia-southeast1', maxInstances: 5 }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'กรุณาเข้าสู่ระบบ');
  try {
    return await verifyTopupSlip({
      db: getFirestore(), FieldValue, fetchFn: fetch,
      uid: request.auth.uid, email: request.auth.token.email, data: request.data
    });
  } catch (e) {
    if (e.code === 'invalid-argument') throw new HttpsError('invalid-argument', e.message);
    console.error('verifyTopupSlip failed', e);
    throw new HttpsError('internal', 'ตรวจสลิปไม่สำเร็จ');
  }
});
