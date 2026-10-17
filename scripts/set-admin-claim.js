// One-time: make a Firebase user an admin (custom claim {admin: true}).
// Usage:  GOOGLE_APPLICATION_CREDENTIALS=serviceAccount.json node scripts/set-admin-claim.js <uid|email>
// Get serviceAccount.json from Firebase console > Project settings > Service accounts. Never commit it.
// After running, the user must sign out and back in so the new claim is in their token.
const admin = require('firebase-admin');

const target = process.argv[2];
if (!target) {
  console.error('Usage: node scripts/set-admin-claim.js <uid|email>');
  process.exit(1);
}

admin.initializeApp();
const lookup = target.includes('@') ? admin.auth().getUserByEmail(target) : admin.auth().getUser(target);
lookup
  .then((user) => admin.auth().setCustomUserClaims(user.uid, { admin: true }).then(() => user))
  .then((user) => console.log(`admin claim set for ${user.email || user.uid}`))
  .catch((err) => { console.error(err.message); process.exit(1); });
