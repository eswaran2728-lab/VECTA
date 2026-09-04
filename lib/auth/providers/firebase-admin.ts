import "server-only";

import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

/**
 * Firebase Admin SDK singleton. The service account JSON never touches the
 * repo — FIREBASE_SERVICE_ACCOUNT_BASE64 is the base64-encoded JSON key
 * downloaded in the Firebase console (Project settings -> Service
 * accounts -> Generate new private key), set as a Vercel env var.
 */
let app: App | null = null;

function getFirebaseAdminApp(): App {
  if (app) return app;
  const existing = getApps();
  if (existing.length > 0) {
    app = existing[0]!;
    return app;
  }

  const encoded = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  if (!encoded) {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT_BASE64 is not set — required when AUTH_PROVIDER=firebase."
    );
  }
  const serviceAccount = JSON.parse(Buffer.from(encoded, "base64").toString("utf-8"));

  app = initializeApp({ credential: cert(serviceAccount) });
  return app;
}

export function getFirebaseAdminAuth() {
  return getAuth(getFirebaseAdminApp());
}
