import { initializeApp, type FirebaseApp } from 'firebase/app';
import { getAuth, type Auth } from 'firebase/auth';
import {
  doc,
  getDocFromServer,
  getFirestore,
  type Firestore,
} from 'firebase/firestore';

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

function readEnv(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export const firebaseConfig = {
  apiKey: readEnv(import.meta.env.VITE_FIREBASE_API_KEY),
  authDomain: readEnv(import.meta.env.VITE_FIREBASE_AUTH_DOMAIN),
  projectId: readEnv(import.meta.env.VITE_FIREBASE_PROJECT_ID),
  storageBucket: readEnv(import.meta.env.VITE_FIREBASE_STORAGE_BUCKET),
  messagingSenderId: readEnv(import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID),
  appId: readEnv(import.meta.env.VITE_FIREBASE_APP_ID),
  firestoreDatabaseId:
    readEnv(import.meta.env.VITE_FIREBASE_FIRESTORE_DATABASE_ID) || '(default)',
};

export const missingFirebaseEnvVars: string[] = [
  ...(!firebaseConfig.apiKey ? ['VITE_FIREBASE_API_KEY'] : []),
  ...(!firebaseConfig.authDomain ? ['VITE_FIREBASE_AUTH_DOMAIN'] : []),
  ...(!firebaseConfig.projectId ? ['VITE_FIREBASE_PROJECT_ID'] : []),
  ...(!firebaseConfig.appId ? ['VITE_FIREBASE_APP_ID'] : []),
];

export const isFirebaseConfigured = missingFirebaseEnvVars.length === 0;

let app: FirebaseApp | null = null;
let authInstance: Auth | null = null;
let dbInstance: Firestore | null = null;

if (isFirebaseConfigured) {
  app = initializeApp({
    apiKey: firebaseConfig.apiKey,
    authDomain: firebaseConfig.authDomain,
    projectId: firebaseConfig.projectId,
    ...(firebaseConfig.storageBucket ? { storageBucket: firebaseConfig.storageBucket } : {}),
    ...(firebaseConfig.messagingSenderId
      ? { messagingSenderId: firebaseConfig.messagingSenderId }
      : {}),
    appId: firebaseConfig.appId,
  });
  authInstance = getAuth(app);
  dbInstance =
    firebaseConfig.firestoreDatabaseId && firebaseConfig.firestoreDatabaseId !== '(default)'
      ? getFirestore(app, firebaseConfig.firestoreDatabaseId)
      : getFirestore(app);
}

export const auth: Auth = authInstance as Auth;
export const db: Firestore = dbInstance as Firestore;

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const currentUser = authInstance?.currentUser;
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: currentUser?.uid,
      email: currentUser?.email,
      emailVerified: currentUser?.emailVerified,
      isAnonymous: currentUser?.isAnonymous,
      tenantId: currentUser?.tenantId,
      providerInfo:
        currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export async function testConnection(): Promise<{
  ok: boolean;
  error?: string;
}> {
  if (!isFirebaseConfigured || !dbInstance) {
    return {
      ok: false,
      error: `Firebase não configurado. Defina as variáveis: ${missingFirebaseEnvVars.join(', ')}.`,
    };
  }

  try {
    await getDocFromServer(doc(dbInstance, 'test', 'connection'));
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('the client is offline')) {
      console.error('Verifique a configuração do Firebase.');
    }
    return { ok: false, error: message };
  }
}

if (isFirebaseConfigured) {
  void testConnection();
}
