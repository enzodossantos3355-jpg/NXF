import type { Auth } from 'firebase-admin/auth';
import type { Firestore } from 'firebase-admin/firestore';
import { getAdminServices, getFirebaseWebApiKey } from './firebaseAdmin.ts';
import { isValidId } from './permissions.ts';

export interface ProfileAuthDeps {
  auth?: Auth | null;
  db?: Firestore | null;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
}

export interface ProfileAuthResult {
  ok: boolean;
  status: number;
  customToken?: string;
  error?: string;
}

interface RateLimitBucket {
  failures: number;
  windowStartMs: number;
}

const MAX_FAILURES_PER_WINDOW = 10;
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const failureBuckets = new Map<string, RateLimitBucket>();

export function clearProfileAuthRateLimits(): void {
  failureBuckets.clear();
}

function getBucketKey(clientIp: string, uid: string): string {
  return `${clientIp || 'unknown'}:${uid}`;
}

function isRateLimited(key: string, now: number): boolean {
  const bucket = failureBuckets.get(key);
  if (!bucket) return false;
  if (now - bucket.windowStartMs > RATE_LIMIT_WINDOW_MS) {
    failureBuckets.delete(key);
    return false;
  }
  return bucket.failures >= MAX_FAILURES_PER_WINDOW;
}

function recordFailure(key: string, now: number): void {
  const existing = failureBuckets.get(key);
  if (!existing || now - existing.windowStartMs > RATE_LIMIT_WINDOW_MS) {
    failureBuckets.set(key, { failures: 1, windowStartMs: now });
  } else {
    existing.failures += 1;
  }
}

export async function authenticateProfileByPassword(
  params: {
    uid: string;
    password: string;
    clientIp?: string;
  },
  deps: ProfileAuthDeps = {}
): Promise<ProfileAuthResult> {
  const adminSvc = deps.auth && deps.db ? null : getAdminServices();
  const auth = deps.auth ?? adminSvc?.auth ?? null;
  const db = deps.db ?? adminSvc?.db ?? null;
  const apiKey = deps.apiKey ?? getFirebaseWebApiKey();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = (deps.nowMs ?? Date.now)();

  if (!auth || !db) {
    return {
      ok: false,
      status: 503,
      error: 'Login direto por card de perfil requer o backend conectado ao Firebase Admin SDK. Utilize Outra conta / Entrar com Code.',
    };
  }

  if (!apiKey) {
    return {
      ok: false,
      status: 503,
      error: 'FIREBASE_WEB_API_KEY não configurada no servidor para validação de senha.',
    };
  }

  const uid = String(params.uid || '').trim();
  const password = String(params.password || '');

  if (!isValidId(uid)) {
    return { ok: false, status: 400, error: 'Perfil inválido.' };
  }
  if (password.length < 1 || password.length > 200) {
    return { ok: false, status: 400, error: 'Informe sua senha.' };
  }

  const bucketKey = getBucketKey(params.clientIp || 'unknown', uid);
  if (isRateLimited(bucketKey, now)) {
    return {
      ok: false,
      status: 429,
      error: 'Muitas tentativas incorretas para este perfil. Aguarde alguns minutos e tente novamente.',
    };
  }

  const [userSnap, pubSnap] = await Promise.all([
    db.doc(`users/${uid}`).get(),
    db.doc(`publicProfiles/${uid}`).get(),
  ]);

  if (!userSnap.exists) {
    return { ok: false, status: 404, error: 'Conta de usuário não encontrada.' };
  }

  const userData = userSnap.data() || {};
  if (userData.status === 'suspended') {
    return {
      ok: false,
      status: 403,
      error: 'Esta conta está suspensa pela administração da NXF.',
    };
  }

  if (!pubSnap.exists) {
    return {
      ok: false,
      status: 403,
      error: 'Perfil não encontrado no seletor público.',
    };
  }

  const pubData = pubSnap.data() || {};
  if (
    pubData.isActiveMember !== true ||
    pubData.showInEntrySelector !== true ||
    pubData.moderationStatus !== 'approved'
  ) {
    return {
      ok: false,
      status: 403,
      error: 'Este perfil não está habilitado no seletor visual. Utilize Entrar com Code.',
    };
  }

  let internalEmail = '';
  try {
    const userRecord = await auth.getUser(uid);
    internalEmail = userRecord.email || '';
  } catch {
    return { ok: false, status: 404, error: 'Credencial de autenticação não encontrada.' };
  }

  if (!internalEmail) {
    return {
      ok: false,
      status: 400,
      error: 'Este perfil não possui credencial de senha configurada.',
    };
  }

  const verifyResponse = await fetchImpl(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: internalEmail,
        password,
        returnSecureToken: false,
      }),
    }
  );

  if (!verifyResponse.ok) {
    recordFailure(bucketKey, now);
    const errPayload = (await verifyResponse.json().catch(() => ({}))) as {
      error?: { message?: string };
    };
    const msg = errPayload.error?.message || '';
    if (msg.includes('TOO_MANY_ATTEMPTS_TRY_LATER')) {
      return {
        ok: false,
        status: 429,
        error: 'Muitas tentativas seguidas. Aguarde alguns minutos e tente novamente.',
      };
    }
    return {
      ok: false,
      status: 401,
      error: 'Senha inválida para este perfil.',
    };
  }

  failureBuckets.delete(bucketKey);

  const customToken = await auth.createCustomToken(uid);
  return {
    ok: true,
    status: 200,
    customToken,
  };
}
