import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { getAuth, browserLocalPersistence, setPersistence } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

// ─── Firebase Public Config (psl-esport) ───────────────────────────────────────
const firebaseConfig = {
  apiKey: "AIzaSyC450kePwL6FdVXUSVli0bEP3DdnQs0qzU",
  authDomain: "psl-esport.firebaseapp.com",
  projectId: "psl-esport",
  storageBucket: "psl-esport.firebasestorage.app",
  messagingSenderId: "225108570173",
  appId: "1:225108570173:web:b6483c02368908f3783a54"
};

// Initialize Firebase
const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
const db = getFirestore(app);
const auth = getAuth(app);

setPersistence(auth, browserLocalPersistence).catch(() => {});

export { app, db, auth };