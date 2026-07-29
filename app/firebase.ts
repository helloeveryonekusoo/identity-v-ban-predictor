import { getApp, getApps, initializeApp, type FirebaseApp } from "firebase/app";
import { getAuth, type Auth } from "firebase/auth";
import { getFirestore, type Firestore } from "firebase/firestore";

export type FirebasePublicConfig = {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket?: string;
  messagingSenderId?: string;
  appId: string;
};

export type FirebaseServices = {
  app: FirebaseApp;
  auth: Auth;
  db: Firestore;
};

export async function loadFirebaseServices(): Promise<FirebaseServices | null> {
  const response = await fetch("/api/firebase-config", { cache: "no-store" });
  if (!response.ok) return null;
  const config = (await response.json()) as FirebasePublicConfig | null;
  if (!config?.apiKey || !config.authDomain || !config.projectId || !config.appId) {
    return null;
  }

  const app = getApps().length ? getApp() : initializeApp(config);
  return { app, auth: getAuth(app), db: getFirestore(app) };
}
