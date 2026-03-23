import { initializeApp, getApps, getApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getFunctions } from "firebase/functions";

const runtimeConfig =
  window.MEMORYVAULT_CONFIG?.firebase ||
  window.MEMORY_VAULT_CONFIG?.firebase ||
  {};

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || runtimeConfig.apiKey,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || runtimeConfig.authDomain,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || runtimeConfig.projectId,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || runtimeConfig.storageBucket,
  messagingSenderId:
    import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || runtimeConfig.messagingSenderId,
  appId: import.meta.env.VITE_FIREBASE_APP_ID || runtimeConfig.appId,
};

const hasRequiredConfig =
  !!firebaseConfig.apiKey &&
  !!firebaseConfig.authDomain &&
  !!firebaseConfig.projectId &&
  !!firebaseConfig.appId;

const app = hasRequiredConfig
  ? getApps().length
    ? getApp()
    : initializeApp(firebaseConfig)
  : null;

export const auth = app ? getAuth(app) : null;
export const db = app ? getFirestore(app) : null;
export const functions = app ? getFunctions(app) : null;
export const googleProvider = new GoogleAuthProvider();
export const firebaseConfigured = !!app;
