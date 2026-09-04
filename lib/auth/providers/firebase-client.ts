import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
import { getAuth, GoogleAuthProvider, signInWithPopup, type Auth, type User } from "firebase/auth";

/**
 * Browser-side Firebase bootstrap. Only ever imported from client
 * components (GoogleSignInButton.tsx, lib/supabase/client.ts) — no
 * "use client" directive needed on a plain module, it just naturally
 * ends up in whichever bundle imports it.
 *
 * NEXT_PUBLIC_FIREBASE_* values come from the Firebase console (Project
 * settings -> General -> Your apps -> the registered web app's config).
 * These are not secrets — Firebase's client config is meant to be public,
 * protected by Authorized domains + Google's own OAuth client
 * restrictions, not by keeping the values hidden.
 */
const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

let app: FirebaseApp | null = null;
function getFirebaseClientApp(): FirebaseApp {
  if (app) return app;
  const existing = getApps();
  app = existing.length > 0 ? existing[0]! : initializeApp(firebaseConfig);
  return app;
}

let authInstance: Auth | null = null;
export function getFirebaseClientAuth(): Auth {
  if (!authInstance) authInstance = getAuth(getFirebaseClientApp());
  return authInstance;
}

/**
 * hd restricts the Google account picker to the AirAsia Workspace domain —
 * a UX convenience only. /api/auth/sync-claims re-checks the domain
 * server-side; a user could bypass this client-side hint.
 */
function createGoogleProvider(): GoogleAuthProvider {
  const provider = new GoogleAuthProvider();
  const domain = process.env.NEXT_PUBLIC_AVSEC_WORKSPACE_DOMAIN;
  if (domain) provider.setCustomParameters({ hd: domain });
  return provider;
}

/** Opens the Google sign-in popup and returns the signed-in user. Callers
 *  (GoogleSignInButton.tsx) get idToken via user.getIdToken() themselves —
 *  kept here rather than inline so the firebase/auth SDK import stays
 *  confined to this adapter file. */
export async function signInWithGoogle(): Promise<User> {
  const result = await signInWithPopup(getFirebaseClientAuth(), createGoogleProvider());
  return result.user;
}
