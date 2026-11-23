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

type RawServiceAccount = ServiceAccount & {
  project_id?: string;
  client_email?: string;
  private_key?: string;
};

export function getFirebaseWebApiKey(): string {
  return (
    process.env.FIREBASE_WEB_API_KEY?.trim() ||
    process.env.VITE_FIREBASE_API_KEY?.trim() ||
    ''
  );
}

let cachedApp: App | null = null;
let cachedAuth: Auth | null = null;
let cachedDb: Firestore | null = null;
let initAttempted = false;
let initError: string | null = null;

function parseServiceAccountFromEnv(): RawServiceAccount | null {
  const rawJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
  if (rawJson) {
    try {
      const jsonText = rawJson.startsWith('{')
        ? rawJson
        : Buffer.from(rawJson, 'base64').toString('utf8');
      return JSON.parse(jsonText) as RawServiceAccount;
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
    process.env.GOOGLE_CLOUD_PROJECT?.trim();

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
  return process.env.FIREBASE_FIRESTORE_DATABASE_ID?.trim() || '(default)';
}

export function hasExplicitAdminCredentials(): boolean {
  return Boolean(
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim() ||
      (process.env.FIREBASE_CLIENT_EMAIL?.trim() && process.env.FIREBASE_PRIVATE_KEY?.trim()) ||
      process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim()
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
  let resolvedProjectId =
    process.env.FIREBASE_PROJECT_ID?.trim() ||
    process.env.GOOGLE_CLOUD_PROJECT?.trim() ||
    undefined;
  const databaseId = getFirestoreDatabaseId();

  if (!initAttempted) {
    initAttempted = true;
    try {
      if (getApps().length > 0) {
        cachedApp = getApps()[0];
      } else {
        const serviceAccount = parseServiceAccountFromEnv();
        if (serviceAccount) {
          resolvedProjectId =
            serviceAccount.project_id || serviceAccount.projectId || resolvedProjectId;
          cachedApp = initializeApp({
            credential: cert(serviceAccount),
            ...(resolvedProjectId ? { projectId: resolvedProjectId } : {}),
          });
        } else if (hasExplicitAdminCredentials()) {
          cachedApp = initializeApp({
            credential: applicationDefault(),
            ...(resolvedProjectId ? { projectId: resolvedProjectId } : {}),
          });
        } else {
          throw new Error(
            'Credenciais do Firebase Admin SDK não configuradas neste ambiente. Defina FIREBASE_SERVICE_ACCOUNT_JSON.'
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
    projectId: cachedApp?.options?.projectId || resolvedProjectId,
    databaseId,
  };
}
