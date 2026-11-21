import crypto from 'node:crypto';
import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { getAdminServices } from './firebaseAdmin.ts';

const DEFAULT_SYNC_INTERVAL_HOURS = 6;
const LOCK_LEASE_MS = 10 * 60 * 1000; // 10 min lease against crashed workers
const RATE_LIMIT_DELAY_MS = 150;
const JOB_DOC_PATH = 'systemJobs/brawlStarsSync';

export interface BrawlSyncResult {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  brawlApiConfigured: boolean;
  httpStatus?: number | null;
  error?: string | null;
  syncedCount: number;
  errorCount: number;
  egressIpWarning?: string | null;
}

export interface BrawlTestResult {
  ok: boolean;
  brawlApiConfigured: boolean;
  httpStatus: number | null;
  error: string | null;
  playerName?: string;
  trophies?: number;
  egressProxyConfigured: boolean;
}

export interface BrawlStatusSnapshot {
  brawlTokenConfigured: boolean;
  brawlApiConfigured: boolean;
  egressProxyConfigured: boolean;
  apiBaseUrl: string;
  intervalHours: number;
  running: boolean;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastStatus: string;
  lastHttpStatus: number | null;
  lastError: string | null;
  lastSuccessCount: number;
  lastErrorCount: number;
}

export interface BrawlServiceDeps {
  db: Firestore;
  fetchImpl?: typeof fetch;
  token?: string;
  apiBaseUrl?: string;
  sleepImpl?: (ms: number) => Promise<void>;
  nowMs?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function resolveApiBaseUrl(override?: string): string {
  const raw =
    override ||
    process.env.BRAWL_STARS_API_BASE_URL?.trim() ||
    'https://api.brawlstars.com/v1';
  return raw.replace(/\/+$/, '');
}

function normalizeTag(raw: unknown): string {
  const clean = String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9#]/g, '');
  if (!clean) return '';
  return clean.startsWith('#') ? clean : `#${clean}`;
}

function classifySupercellFailure(status: number, bodyText: string): string {
  const lower = bodyText.toLowerCase();
  if (status === 403 && (lower.includes('invalidip') || lower.includes('ip'))) {
    return 'HTTP 403 (accessDenied.invalidIp): O IP de saída atual do servidor não está autorizado na chave da API da Supercell. Render Starter usa IPs dinâmicos; configure um proxy/relay de IP fixo em BRAWL_STARS_API_BASE_URL ou autorize os IPs de saída.';
  }
  if (status === 401 || status === 403) {
    return `HTTP ${status}: Token da API Brawl Stars rejeitado ou sem autorização (${bodyText.slice(0, 140)}).`;
  }
  if (status === 429) {
    return 'HTTP 429: Limite de requisições da API Brawl Stars atingido temporariamente.';
  }
  if (status >= 500) {
    return `HTTP ${status}: API oficial da Brawl Stars em manutenção ou indisponível.`;
  }
  return `HTTP ${status}: Falha na consulta à API Brawl Stars.`;
}

function formatTs(val: unknown): string | null {
  if (!val) return null;
  if (typeof val === 'object' && val !== null && 'toDate' in val && typeof (val as { toDate: () => Date }).toDate === 'function') {
    return (val as { toDate: () => Date }).toDate().toISOString();
  }
  if (val instanceof Date) return val.toISOString();
  if (typeof val === 'number') return new Date(val).toISOString();
  if (typeof val === 'string') return val;
  return null;
}

export async function getBrawlSyncStatus(
  deps?: Partial<BrawlServiceDeps>
): Promise<BrawlStatusSnapshot> {
  const token = (deps?.token ?? process.env.BRAWL_STARS_API_TOKEN ?? '').trim();
  const apiBaseUrl = resolveApiBaseUrl(deps?.apiBaseUrl);
  const egressProxyConfigured = apiBaseUrl !== 'https://api.brawlstars.com/v1';

  const db = deps?.db || getAdminServices().db;
  if (!db) {
    return {
      brawlTokenConfigured: Boolean(token),
      brawlApiConfigured: false,
      egressProxyConfigured,
      apiBaseUrl,
      intervalHours: DEFAULT_SYNC_INTERVAL_HOURS,
      running: false,
      lastRunAt: null,
      lastSuccessAt: null,
      lastStatus: 'admin_sdk_not_configured',
      lastHttpStatus: null,
      lastError: 'Firebase Admin SDK não configurado neste ambiente.',
      lastSuccessCount: 0,
      lastErrorCount: 0,
    };
  }

  const [jobSnap, settingsSnap] = await Promise.all([
    db.doc(JOB_DOC_PATH).get(),
    db.doc('systemSettings/global').get(),
  ]);

  const job = jobSnap.exists ? jobSnap.data() || {} : {};
  const settings = settingsSnap.exists ? settingsSnap.data() || {} : {};

  return {
    brawlTokenConfigured: Boolean(token),
    brawlApiConfigured: Boolean(settings.brawlApiConfigured) && Boolean(token),
    egressProxyConfigured,
    apiBaseUrl,
    intervalHours:
      typeof settings.brawlApiSyncIntervalHours === 'number'
        ? settings.brawlApiSyncIntervalHours
        : DEFAULT_SYNC_INTERVAL_HOURS,
    running: Boolean(job.running) && typeof job.leaseUntilMs === 'number' && job.leaseUntilMs > Date.now(),
    lastRunAt: formatTs(job.lastRunAt),
    lastSuccessAt: formatTs(job.lastSuccessAt),
    lastStatus: String(job.lastStatus || (token ? 'awaiting_verification' : 'pending_config')),
    lastHttpStatus: typeof job.lastHttpStatus === 'number' ? job.lastHttpStatus : null,
    lastError: job.lastError ? String(job.lastError) : null,
    lastSuccessCount: Number(job.lastSuccessCount || 0),
    lastErrorCount: Number(job.lastErrorCount || 0),
  };
}

export async function testBrawlStarsApiConnection(
  rawTag: string,
  deps?: Partial<BrawlServiceDeps>
): Promise<BrawlTestResult> {
  const token = (deps?.token ?? process.env.BRAWL_STARS_API_TOKEN ?? '').trim();
  const apiBaseUrl = resolveApiBaseUrl(deps?.apiBaseUrl);
  const egressProxyConfigured = apiBaseUrl !== 'https://api.brawlstars.com/v1';
  const fetchImpl = deps?.fetchImpl || fetch;
  const db = deps?.db || getAdminServices().db;

  if (!token) {
    if (db) {
      await db.doc('systemSettings/global').set(
        {
          brawlApiConfigured: false,
          cloudFunctionsConfigured: false,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }
    return {
      ok: false,
      brawlApiConfigured: false,
      httpStatus: null,
      error: 'Variável de ambiente BRAWL_STARS_API_TOKEN não configurada no servidor Render.',
      egressProxyConfigured,
    };
  }

  const normalizedTag = normalizeTag(rawTag);
  if (!normalizedTag || normalizedTag.length < 4) {
    return {
      ok: false,
      brawlApiConfigured: false,
      httpStatus: null,
      error: 'Informe uma Brawl Tag válida (ex.: #2PP ou #ABC1234) para validar a conectividade.',
      egressProxyConfigured,
    };
  }

  try {
    const encodedTag = encodeURIComponent(normalizedTag);
    const res = await fetchImpl(`${apiBaseUrl}/players/${encodedTag}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    });

    if (res.ok) {
      const payload = (await res.json()) as { name?: string; trophies?: number };
      if (db) {
        const now = FieldValue.serverTimestamp();
        await Promise.all([
          db.doc('systemSettings/global').set(
            {
              brawlApiConfigured: true,
              cloudFunctionsConfigured: false,
              updatedAt: now,
            },
            { merge: true }
          ),
          db.doc(JOB_DOC_PATH).set(
            {
              lastStatus: 'verified',
              lastHttpStatus: res.status,
              lastError: null,
              lastSuccessAt: now,
              updatedAt: now,
            },
            { merge: true }
          ),
        ]);
      }

      return {
        ok: true,
        brawlApiConfigured: true,
        httpStatus: res.status,
        error: null,
        playerName: payload.name,
        trophies: payload.trophies,
        egressProxyConfigured,
      };
    }

    const bodyText = await res.text().catch(() => '');
    const diagnostic =
      res.status === 404
        ? 'HTTP 404: Autenticação/IP aceitos pela Supercell, mas a Tag de teste informada não existe.'
        : classifySupercellFailure(res.status, bodyText);
    const authVerified = res.status === 404;

    if (db) {
      const now = FieldValue.serverTimestamp();
      await Promise.all([
        db.doc('systemSettings/global').set(
          {
            brawlApiConfigured: authVerified,
            cloudFunctionsConfigured: false,
            updatedAt: now,
          },
          { merge: true }
        ),
        db.doc(JOB_DOC_PATH).set(
          {
            lastStatus: authVerified ? 'verified' : 'error',
            lastHttpStatus: res.status,
            lastError: diagnostic,
            updatedAt: now,
          },
          { merge: true }
        ),
      ]);
    }

    return {
      ok: authVerified,
      brawlApiConfigured: authVerified,
      httpStatus: res.status,
      error: diagnostic,
      egressProxyConfigured,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (db) {
      await db.doc('systemSettings/global').set(
        {
          brawlApiConfigured: false,
          cloudFunctionsConfigured: false,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }
    return {
      ok: false,
      brawlApiConfigured: false,
      httpStatus: null,
      error: `Falha de rede ao consultar API Brawl Stars: ${errMsg}`,
      egressProxyConfigured,
    };
  }
}

export async function syncBrawlStarsStats(
  options: { force?: boolean; triggeredBy?: string } = {},
  deps?: Partial<BrawlServiceDeps>
): Promise<BrawlSyncResult> {
  const adminServices = deps?.db ? null : getAdminServices();
  const db = deps?.db || adminServices?.db;
  if (!db) {
    return {
      ok: false,
      skipped: true,
      reason: 'admin_sdk_not_configured',
      brawlApiConfigured: false,
      error: 'Firebase Admin SDK não configurado.',
      syncedCount: 0,
      errorCount: 0,
    };
  }

  const token = (deps?.token ?? process.env.BRAWL_STARS_API_TOKEN ?? '').trim();
  const apiBaseUrl = resolveApiBaseUrl(deps?.apiBaseUrl);
  const fetchImpl = deps?.fetchImpl || fetch;
  const sleepImpl = deps?.sleepImpl || defaultSleep;
  const nowMs = deps?.nowMs ? deps.nowMs() : Date.now();
  const lockOwner = crypto.randomUUID();
  const jobRef = db.doc(JOB_DOC_PATH);

  // Read sync interval setting (default 6h)
  const settingsSnap = await db.doc('systemSettings/global').get();
  const intervalHours =
    settingsSnap.exists && typeof settingsSnap.data()?.brawlApiSyncIntervalHours === 'number'
      ? Math.max(1, Math.min(168, Number(settingsSnap.data()?.brawlApiSyncIntervalHours)))
      : DEFAULT_SYNC_INTERVAL_HOURS;
  const minIntervalMs = intervalHours * 3600 * 1000;

  if (!token) {
    const now = FieldValue.serverTimestamp();
    await Promise.all([
      db.doc('systemSettings/global').set(
        {
          brawlApiConfigured: false,
          cloudFunctionsConfigured: false,
          updatedAt: now,
        },
        { merge: true }
      ),
      jobRef.set(
        {
          running: false,
          lastRunAt: Timestamp.fromMillis(nowMs),
          lastStatus: 'pending_config',
          lastHttpStatus: null,
          lastError: 'BRAWL_STARS_API_TOKEN não configurado no ambiente do backend.',
          updatedAt: now,
        },
        { merge: true }
      ),
    ]);

    return {
      ok: false,
      skipped: true,
      reason: 'missing_token',
      brawlApiConfigured: false,
      error: 'BRAWL_STARS_API_TOKEN não configurado no ambiente do backend.',
      syncedCount: 0,
      errorCount: 0,
    };
  }

  // Distributed lease transaction prevents concurrent / duplicate sync across Render restarts & instances
  const leaseAcquired = await db.runTransaction(async (tx) => {
    const snap = await tx.get(jobRef);
    const data = snap.exists ? snap.data() || {} : {};
    const isRunning =
      Boolean(data.running) &&
      typeof data.leaseUntilMs === 'number' &&
      data.leaseUntilMs > nowMs;

    if (isRunning) {
      return { acquired: false, reason: 'already_running' };
    }

    const lastRunMs =
      data.lastRunAt && typeof data.lastRunAt.toMillis === 'function'
        ? data.lastRunAt.toMillis()
        : typeof data.lastRunAtMs === 'number'
          ? data.lastRunAtMs
          : 0;

    if (!options.force && lastRunMs > 0 && nowMs - lastRunMs < minIntervalMs - 60_000) {
      return { acquired: false, reason: 'interval_not_elapsed' };
    }

    tx.set(
      jobRef,
      {
        running: true,
        lockOwner,
        leaseUntilMs: nowMs + LOCK_LEASE_MS,
        lastTriggeredBy: options.triggeredBy || 'scheduler',
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return { acquired: true, reason: 'ok' };
  });

  if (!leaseAcquired.acquired) {
    return {
      ok: true,
      skipped: true,
      reason: leaseAcquired.reason,
      brawlApiConfigured: Boolean(settingsSnap.data()?.brawlApiConfigured),
      syncedCount: 0,
      errorCount: 0,
    };
  }

  let syncedCount = 0;
  let errorCount = 0;
  let lastHttpStatus: number | null = null;
  let lastError: string | null = null;
  let fatalAuthOrIpBlocked = false;
  let verifiedByRealApi = false;

  try {
    const approvedUsers = await db
      .collection('users')
      .where('brawlTagStatus', '==', 'approved')
      .where('status', '==', 'active')
      .limit(100)
      .get();

    for (let idx = 0; idx < approvedUsers.docs.length; idx++) {
      const userDoc = approvedUsers.docs[idx];
      const data = userDoc.data();
      const rawTag = normalizeTag(data.brawlTag);
      if (!rawTag) continue;

      if (idx > 0) {
        await sleepImpl(RATE_LIMIT_DELAY_MS);
      }

      const encodedTag = encodeURIComponent(rawTag);

      try {
        const res = await fetchImpl(`${apiBaseUrl}/players/${encodedTag}`, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
          },
        });
        lastHttpStatus = res.status;

        if (!res.ok) {
          errorCount += 1;
          const errText = await res.text().catch(() => '');
          lastError = classifySupercellFailure(res.status, errText);

          await db.doc(`playerStats/${userDoc.id}`).set(
            {
              uid: userDoc.id,
              brawlTag: rawTag,
              syncStatus: 'error',
              lastSyncedAt: FieldValue.serverTimestamp(),
            },
            { merge: true }
          );

          if (res.status === 401 || res.status === 403) {
            fatalAuthOrIpBlocked = true;
            break;
          }
          continue;
        }

        verifiedByRealApi = true;
        syncedCount += 1;
        const player = (await res.json()) as {
          trophies?: number;
          highestTrophies?: number;
          '3vs3Victories'?: number;
          soloVictories?: number;
          duoVictories?: number;
        };

        const now = FieldValue.serverTimestamp();
        await db.doc(`playerStats/${userDoc.id}`).set({
          uid: userDoc.id,
          brawlTag: rawTag,
          trophies: player.trophies || 0,
          highestTrophies: player.highestTrophies || 0,
          victories3v3: player['3vs3Victories'] || 0,
          soloVictories: player.soloVictories || 0,
          duoVictories: player.duoVictories || 0,
          syncStatus: 'ok',
          lastSyncedAt: now,
        });

        await db.collection('playerStatsHistory').add({
          uid: userDoc.id,
          brawlTag: rawTag,
          trophies: player.trophies || 0,
          victories3v3: player['3vs3Victories'] || 0,
          capturedAt: now,
        });
      } catch (err) {
        errorCount += 1;
        lastError = err instanceof Error ? err.message : String(err);
      }
    }

    const noApprovedTagsYet = approvedUsers.empty;
    const brawlApiConfigured = fatalAuthOrIpBlocked
      ? false
      : verifiedByRealApi
        ? true
        : Boolean(settingsSnap.data()?.brawlApiConfigured) && !noApprovedTagsYet;

    const finalStatus = fatalAuthOrIpBlocked
      ? 'auth_or_ip_blocked'
      : noApprovedTagsYet
        ? 'no_approved_tags'
        : errorCount > 0 && syncedCount === 0
          ? 'error'
          : 'ok';

    if (noApprovedTagsYet && !lastError) {
      lastError =
        'Token presente, mas ainda não há jogadores com brawlTagStatus="approved" para validar uma chamada real na API da Supercell. Use "Testar Tag na API" ou aprove uma tag.';
    }

    const finishedAt = FieldValue.serverTimestamp();
    await Promise.all([
      db.doc('systemSettings/global').set(
        {
          brawlApiConfigured,
          cloudFunctionsConfigured: false,
          updatedAt: finishedAt,
        },
        { merge: true }
      ),
      jobRef.set(
        {
          running: false,
          lockOwner: null,
          leaseUntilMs: 0,
          lastRunAt: Timestamp.fromMillis(nowMs),
          lastRunAtMs: nowMs,
          ...(verifiedByRealApi ? { lastSuccessAt: finishedAt } : {}),
          lastStatus: finalStatus,
          lastHttpStatus,
          lastError,
          lastSuccessCount: syncedCount,
          lastErrorCount: errorCount,
          updatedAt: finishedAt,
        },
        { merge: true }
      ),
    ]);

    return {
      ok: !fatalAuthOrIpBlocked && (syncedCount > 0 || noApprovedTagsYet),
      brawlApiConfigured,
      httpStatus: lastHttpStatus,
      error: lastError,
      syncedCount,
      errorCount,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await jobRef.set(
      {
        running: false,
        lockOwner: null,
        leaseUntilMs: 0,
        lastRunAt: Timestamp.fromMillis(nowMs),
        lastRunAtMs: nowMs,
        lastStatus: 'error',
        lastError: errMsg,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return {
      ok: false,
      brawlApiConfigured: false,
      error: errMsg,
      syncedCount,
      errorCount,
    };
  }
}

let schedulerStarted = false;

export function startBrawlStarsScheduler(): void {
  if (schedulerStarted) return;
  schedulerStarted = true;

  // Periodic check every 30 min; Firestore distributed lock enforces the configured 6h interval cleanly across restarts
  const runSafe = () => {
    const { configured } = getAdminServices();
    if (!configured) return;
    void syncBrawlStarsStats({ force: false, triggeredBy: 'scheduler' }).catch((err) => {
      console.warn('[BrawlStarsScheduler] Falha ao executar ciclo:', err instanceof Error ? err.message : String(err));
    });
  };

  setTimeout(runSafe, 15_000).unref();
  setInterval(runSafe, 30 * 60 * 1000).unref();
}
