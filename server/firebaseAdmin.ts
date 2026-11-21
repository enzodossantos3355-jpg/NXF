import fs from 'node:fs';
import path from 'node:path';
import {
  applicationDefault,
  cert,
  getApps,
  initializeApp,
  type App,
  type ServiceAccount,
} from 'firebase-admin/app';
import { getAuth, type Auth } from 'firebase-admin/auth';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';

interface AppletConfigFile {
  apiKey?: string;
  projectId?: string;
  firestoreDatabaseId?: string;
}

function loadAppletConfig(): AppletConfigFile {
  try {
    const configPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf8')) as AppletConfigFile;
    }
  } catch {
    // ignore invalid optional config file
  }
  return {};
}

const appletConfig = loadAppletConfig();

export function getFirebaseWebApiKey(): string {
  return (
    process.env.FIREBASE_WEB_API_KEY?.trim() ||
    process.env.VITE_FIREBASE_API_KEY?.trim() ||
    appletConfig.apiKey ||
    ''
  );
}

let cachedApp: App | null = null;
let cachedAuth: Auth | null = null;
let cachedDb: Firestore | null = null;
let initAttempted = false;
let initError: string | null = null;

function parseServiceAccountFromEnv(): ServiceAccount | null {
  const rawJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
  if (rawJson) {
    try {
      const jsonText = rawJson.startsWith('{')
        ? rawJson
        : Buffer.from(rawJson, 'base64').toString('utf8');
      return JSON.parse(jsonText) as ServiceAccount;
    } catch (err) {
      throw new Error(
        `FIREBASE_SERVICE_ACCOUNT_JSON inválido: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL?.trim();
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.trim();
  const projectId =
    process.env.FIREBASE_PROJECT_ID?.trim() ||
    process.env.GOOGLE_CLOUD_PROJECT?.trim() ||
    appletConfig.projectId;

  if (clientEmail && privateKey && projectId) {
    return {
      projectId,
      clientEmail,
      privateKey: privateKey.replace(/\\n/g, '\n'),
    };
  }

  return null;
}

export function getFirestoreDatabaseId(): string {
  return (
    process.env.FIREBASE_FIRESTORE_DATABASE_ID?.trim() ||
    appletConfig.firestoreDatabaseId ||
    '(default)'
  );
}

export function hasExplicitAdminCredentials(): boolean {
  return Boolean(
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim() ||
      (process.env.FIREBASE_CLIENT_EMAIL?.trim() && process.env.FIREBASE_PRIVATE_KEY?.trim()) ||
      process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim() ||
      process.env.K_SERVICE ||
      process.env.CLOUD_RUN_JOB
  );
}

export function getAdminServices(): {
  configured: boolean;
  error: string | null;
  app: App | null;
  auth: Auth | null;
  db: Firestore | null;
  projectId: string | undefined;
  databaseId: string;
} {
  const projectId =
    process.env.FIREBASE_PROJECT_ID?.trim() ||
    process.env.GOOGLE_CLOUD_PROJECT?.trim() ||
    appletConfig.projectId;
  const databaseId = getFirestoreDatabaseId();

  if (!initAttempted) {
    initAttempted = true;
    try {
      if (getApps().length > 0) {
        cachedApp = getApps()[0];
      } else {
        const serviceAccount = parseServiceAccountFromEnv();
        if (serviceAccount) {
          cachedApp = initializeApp({
            credential: cert(serviceAccount),
            projectId: serviceAccount.projectId || projectId,
          });
        } else if (hasExplicitAdminCredentials()) {
          cachedApp = initializeApp({
            credential: applicationDefault(),
            projectId,
          });
        } else {
          throw new Error(
            'Credenciais do Firebase Admin SDK não configuradas neste ambiente.'
          );
        }
      }
      cachedAuth = getAuth(cachedApp);
      cachedDb =
        databaseId && databaseId !== '(default)'
          ? getFirestore(cachedApp, databaseId)
          : getFirestore(cachedApp);
      initError = null;
    } catch (err) {
      initError = err instanceof Error ? err.message : String(err);
      cachedApp = null;
      cachedAuth = null;
      cachedDb = null;
    }
  }

  return {
    configured: Boolean(cachedApp && cachedAuth && cachedDb && !initError),
    error: initError,
    app: cachedApp,
    auth: cachedAuth,
    db: cachedDb,
    projectId,
    databaseId,
  };
}
