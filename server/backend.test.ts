import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import express, { type Request, type Response } from 'express';
import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import { createApp } from '../server.ts';
import {
  createRequireAuth,
  requireCapability,
  requireOfficialMember,
  requirePrimaryAdmin,
  type AuthenticatedRequest,
  type AuthDeps,
} from './authMiddleware.ts';
import {
  computeBattleDedupId,
  fetchBrawlApiWithRetry,
  getBrawlSyncStatus,
  lookupBrawlPlayerByTag,
  parseBattlelogItem,
  syncBrawlStarsStats,
  testBrawlStarsApiConnection,
} from './brawlStarsService.ts';
import {
  evaluateBattleForMatches,
  resolveMatchTrackerCandidate,
  runMatchTrackerCycle,
} from './matchTrackerService.ts';
import {
  advanceTournamentStage,
  computeGroupStandings,
  configureTournament,
  createConfiguredTournament,
  DEFAULT_NXF_TOURNAMENT_RULES,
  generateTournamentGroupStage,
  recordTournamentMatchResult,
  type TournamentActor,
} from './tournamentService.ts';
import {
  clearMediaCache,
  deleteMediaBlobIfAuthorized,
  detectImageMimeFromMagicBytes,
  extractMediaIdFromUrl,
  loadMediaBlob,
  MAX_IMAGE_BINARY_BYTES,
  parseAndValidateImageDataUrl,
  saveMediaBlob,
} from './mediaService.ts';
import { publishDueScheduledNews } from './newsSchedulerService.ts';
import {
  authenticateProfileByPassword,
  clearProfileAuthRateLimits,
} from './profileAuthService.ts';
import {
  getFirebaseWebApiKey,
  getFirestoreDatabaseId,
  hasExplicitAdminCredentials,
} from './firebaseAdmin.ts';
import { normalizePublicBaseUrl } from './routes.ts';
import { resolveServerCapabilities } from './permissions.ts';
import { endTeamMembership, upsertTeamMembership } from './rosterService.ts';
import {
  buildPanelNavigation,
  formatTeamRoleLabel,
  resolveActiveNavItem,
} from '../src/lib/panelNavigation.ts';
import { resolveUnifiedCapabilities } from '../src/lib/permissions.ts';
import {
  buildMemberDirectory,
  filterMemberDirectory,
  formatTeamVisibilityLabel,
  isTeamActive,
  resolveTeamVisibility,
  slugifyTeamId,
} from '../src/lib/organizationHelpers.ts';

type PlainRecord = Record<string, unknown>;

function createMockFirestore(initialDocs: Record<string, PlainRecord> = {}) {
  const store = new Map<string, PlainRecord>(
    Object.entries(initialDocs).map(([k, v]) => [k, { ...v }])
  );
  let autoIdCounter = 1;

  const normalizeKey = (p: string) => p.replace(/^\/+/, '');

  const resolveFieldValues = (data: PlainRecord): PlainRecord => {
    const out: PlainRecord = {};
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === 'object' && v.constructor?.name === 'ServerTimestampTransform') {
        out[k] = Timestamp.now();
      } else {
        out[k] = v;
      }
    }
    return out;
  };

  const makeDocRef = (rawPath: string) => {
    const docPath = normalizeKey(rawPath);
    const parts = docPath.split('/');
    const id = parts[parts.length - 1];
    return {
      id,
      path: docPath,
      async get() {
        const val = store.get(docPath);
        return {
          id,
          exists: Boolean(val),
          data: () => (val ? { ...val } : undefined),
        };
      },
      async set(data: PlainRecord, opts?: { merge?: boolean }) {
        const resolved = resolveFieldValues(data);
        if (opts?.merge && store.has(docPath)) {
          store.set(docPath, { ...store.get(docPath)!, ...resolved });
        } else {
          store.set(docPath, resolved);
        }
      },
      async update(data: PlainRecord) {
        if (!store.has(docPath)) {
          throw new Error(`Document not found: ${docPath}`);
        }
        const resolved = resolveFieldValues(data);
        store.set(docPath, { ...store.get(docPath)!, ...resolved });
      },
      async delete() {
        store.delete(docPath);
      },
    };
  };

  const makeQuery = (
    colPath: string,
    filters: Array<{ field: string; op: string; value: unknown }> = [],
    maxLimit?: number
  ) => ({
    where(field: string, op: string, value: unknown) {
      return makeQuery(colPath, [...filters, { field, op, value }], maxLimit);
    },
    select() {
      return makeQuery(colPath, filters, maxLimit);
    },
    limit(n: number) {
      return makeQuery(colPath, filters, n);
    },
    async get() {
      const prefix = `${normalizeKey(colPath)}/`;
      const matched: Array<{
        id: string;
        ref: ReturnType<typeof makeDocRef>;
        data: () => PlainRecord;
      }> = [];

      for (const [k, v] of store.entries()) {
        if (!k.startsWith(prefix)) continue;
        const remainder = k.slice(prefix.length);
        if (remainder.includes('/')) continue;

        let ok = true;
        for (const f of filters) {
          const fv = v[f.field];
          if (f.op === '==') {
            if (fv !== f.value) ok = false;
          } else if (f.op === '<=') {
            const left =
              fv && typeof fv === 'object' && 'toMillis' in fv
                ? (fv as { toMillis: () => number }).toMillis()
                : Number(fv);
            const right =
              f.value && typeof f.value === 'object' && 'toMillis' in f.value
                ? (f.value as { toMillis: () => number }).toMillis()
                : Number(f.value);
            if (!(left <= right)) ok = false;
          }
          if (!ok) break;
        }
        if (ok) {
          matched.push({
            id: remainder,
            ref: makeDocRef(k),
            data: () => ({ ...v }),
          });
        }
      }

      const docs = typeof maxLimit === 'number' ? matched.slice(0, maxLimit) : matched;
      return {
        empty: docs.length === 0,
        size: docs.length,
        docs,
      };
    },
  });

  const db = {
    doc: (p: string) => makeDocRef(p),
    collection: (colPath: string) => ({
      ...makeQuery(colPath),
      doc(customId?: string) {
        const id = customId || `auto_${autoIdCounter++}`;
        return makeDocRef(`${colPath}/${id}`);
      },
      async add(data: PlainRecord) {
        const id = `auto_${autoIdCounter++}`;
        const ref = makeDocRef(`${colPath}/${id}`);
        await ref.set(data);
        return ref;
      },
    }),
    batch() {
      const ops: Array<() => Promise<void>> = [];
      return {
        set(ref: ReturnType<typeof makeDocRef>, data: PlainRecord, opts?: { merge?: boolean }) {
          ops.push(() => ref.set(data, opts));
        },
        update(ref: ReturnType<typeof makeDocRef>, data: PlainRecord) {
          ops.push(() => ref.update(data));
        },
        async commit() {
          for (const op of ops) {
            await op();
          }
        },
      };
    },
    async runTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      const tx = {
        get: async (target: { get: () => Promise<unknown> }) => target.get(),
        set: (ref: ReturnType<typeof makeDocRef>, data: PlainRecord, opts?: { merge?: boolean }) =>
          ref.set(data, opts),
        update: (ref: ReturnType<typeof makeDocRef>, data: PlainRecord) => ref.update(data),
      };
      return fn(tx);
    },
  };

  return {
    db: db as unknown as Firestore,
    store,
  };
}

async function withServer(
  app: express.Express,
  fn: (baseUrl: string) => Promise<void>
): Promise<void> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await fn(baseUrl);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    );
  }
}

test('Express app health, 404, CORS e bloqueio sem Admin SDK', async () => {
  const app = createApp();
  await withServer(app, async (baseUrl) => {
    const health = await fetch(`${baseUrl}/api/health`);
    assert.equal(health.status, 200);
    const body = (await health.json()) as {
      ok: boolean;
      service: string;
      adminSdkConfigured: boolean;
    };
    assert.equal(body.ok, true);
    assert.equal(body.service, 'nxf-esports-api');
    assert.equal(typeof body.adminSdkConfigured, 'boolean');

    const corsAllowed = await fetch(`${baseUrl}/api/health`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:3000' },
    });
    assert.equal(corsAllowed.status, 204);
    assert.equal(corsAllowed.headers.get('access-control-allow-origin'), 'http://localhost:3000');

    const corsDisallowed = await fetch(`${baseUrl}/api/health`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example.com' },
    });
    assert.equal(corsDisallowed.status, 204);
    assert.equal(corsDisallowed.headers.get('access-control-allow-origin'), null);

    const notFound = await fetch(`${baseUrl}/api/nao-existe`);
    assert.equal(notFound.status, 404);

    const unauthAdminRoute = await fetch(`${baseUrl}/api/admin/users/u1/roles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'player' }),
    });
    assert.equal(
      unauthAdminRoute.status,
      body.adminSdkConfigured ? 401 : 503
    );
  });
});

test('Middleware RBAC rejeita anônimo (401), suspenso (403) e candidato (403), e libera primary_admin', async () => {
  const { db } = createMockFirestore({
    'users/cand1': {
      uid: 'cand1',
      fullName: 'Candidato Teste',
      displayName: 'Cand1',
      code: '#CAND1',
      roles: ['candidate'],
      status: 'active',
    },
    'users/susp1': {
      uid: 'susp1',
      fullName: 'Suspenso Teste',
      displayName: 'Susp1',
      code: '#SUSP1',
      roles: ['player'],
      status: 'suspended',
    },
    'users/admin1': {
      uid: 'admin1',
      fullName: 'Admin Teste',
      displayName: 'Admin1',
      code: '#ADM1',
      roles: ['primary_admin'],
      status: 'active',
    },
    'admins/admin1': {
      uid: 'admin1',
      role: 'primary_admin',
      permissions: ['*'],
      active: true,
      grantedBy: 'admin1',
    },
  });

  const mockDeps: AuthDeps = {
    db,
    verifyIdToken: async (token: string) => {
      if (token === 'token-cand') return { uid: 'cand1' } as never;
      if (token === 'token-susp') return { uid: 'susp1' } as never;
      if (token === 'token-admin') return { uid: 'admin1', primaryAdmin: true, cms: true } as never;
      throw new Error('invalid token');
    },
  };

  const authMw = createRequireAuth(() => mockDeps);
  const app = express();
  app.use(express.json());
  app.get('/official', authMw, requireOfficialMember, (_req: Request, res: Response) => {
    res.json({ ok: true });
  });
  app.get('/primary', authMw, requirePrimaryAdmin, (req: AuthenticatedRequest, res: Response) => {
    res.json({ ok: true, uid: req.authContext?.uid });
  });
  app.get(
    '/cms',
    authMw,
    requireCapability((c) => c.canManageCms),
    (_req: Request, res: Response) => {
      res.json({ ok: true });
    }
  );

  await withServer(app, async (baseUrl) => {
    const noToken = await fetch(`${baseUrl}/official`);
    assert.equal(noToken.status, 401);

    const badToken = await fetch(`${baseUrl}/official`, {
      headers: { Authorization: 'Bearer invalido' },
    });
    assert.equal(badToken.status, 401);

    const suspended = await fetch(`${baseUrl}/official`, {
      headers: { Authorization: 'Bearer token-susp' },
    });
    assert.equal(suspended.status, 403);

    const candidateOfficial = await fetch(`${baseUrl}/official`, {
      headers: { Authorization: 'Bearer token-cand' },
    });
    assert.equal(candidateOfficial.status, 403);

    const candidatePrimary = await fetch(`${baseUrl}/primary`, {
      headers: { Authorization: 'Bearer token-cand' },
    });
    assert.equal(candidatePrimary.status, 403);

    const candidateCms = await fetch(`${baseUrl}/cms`, {
      headers: { Authorization: 'Bearer token-cand' },
    });
    assert.equal(candidateCms.status, 403);

    const adminPrimary = await fetch(`${baseUrl}/primary`, {
      headers: { Authorization: 'Bearer token-admin' },
    });
    assert.equal(adminPrimary.status, 200);
    const data = (await adminPrimary.json()) as { ok: boolean; uid: string };
    assert.equal(data.uid, 'admin1');
  });
});

test('Brawl Stars Service trata token ausente, bloqueio de IP 403, sucesso 200 e lock distribuído', async () => {
  // 1. Token ausente
  {
    const { db, store } = createMockFirestore();
    const res = await syncBrawlStarsStats({ force: true }, { db, token: '' });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'missing_token');
    assert.equal(res.brawlApiConfigured, false);
    assert.equal(store.get('systemSettings/global')?.brawlApiConfigured, false);
  }

  // 2. HTTP 403 (IP não autorizado na Supercell / Render Starter dinâmico)
  {
    const { db, store } = createMockFirestore({
      'users/u1': {
        uid: 'u1',
        brawlTag: '#2PP',
        brawlTagStatus: 'approved',
        status: 'active',
      },
    });

    const mockFetch: typeof fetch = async () =>
      new globalThis.Response(JSON.stringify({ reason: 'accessDenied.invalidIp' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      });

    const res = await syncBrawlStarsStats(
      { force: true, triggeredBy: 'admin1' },
      { db, token: 'supercell-secret', fetchImpl: mockFetch, sleepImpl: async () => {} }
    );
    assert.equal(res.ok, false);
    assert.equal(res.brawlApiConfigured, false);
    assert.equal(res.httpStatus, 403);
    assert.equal(res.errorCount, 1);
    assert.match(res.error || '', /HTTP 403/);
    assert.equal(store.get('systemSettings/global')?.brawlApiConfigured, false);
    assert.equal(store.get('systemJobs/brawlStarsSync')?.lastStatus, 'auth_or_ip_blocked');
  }

  // 3. HTTP 200 atualiza playerStats e playerStatsHistory
  {
    const { db, store } = createMockFirestore({
      'users/u1': {
        uid: 'u1',
        brawlTag: '2pp',
        brawlTagStatus: 'approved',
        status: 'active',
      },
    });

    const mockFetch: typeof fetch = async (url) => {
      assert.match(String(url), /\/players\/%232PP$/);
      return new globalThis.Response(
        JSON.stringify({
          name: 'NXF Player',
          trophies: 54200,
          highestTrophies: 56000,
          '3vs3Victories': 8400,
          soloVictories: 310,
          duoVictories: 490,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    };

    const res = await syncBrawlStarsStats(
      { force: true, triggeredBy: 'admin1' },
      { db, token: 'supercell-secret', fetchImpl: mockFetch, sleepImpl: async () => {} }
    );
    assert.equal(res.ok, true);
    assert.equal(res.brawlApiConfigured, true);
    assert.equal(res.syncedCount, 1);
    assert.equal(res.errorCount, 0);
    assert.equal(store.get('playerStats/u1')?.trophies, 54200);
    assert.equal(store.get('playerStats/u1')?.syncStatus, 'ok');
    assert.equal(store.get('systemSettings/global')?.brawlApiConfigured, true);

    const status = await getBrawlSyncStatus({ db, token: 'supercell-secret' });
    assert.equal(status.brawlApiConfigured, true);
    assert.equal(status.lastSuccessCount, 1);

    // 4. Intervalo mínimo (6h) evita execução duplicada quando force=false
    const skippedInterval = await syncBrawlStarsStats(
      { force: false, triggeredBy: 'scheduler' },
      {
        db,
        token: 'supercell-secret',
        fetchImpl: async () => {
          throw new Error('Não deveria chamar fetch antes de 6h');
        },
        nowMs: () => Date.now() + 60_000,
      }
    );
    assert.equal(skippedInterval.skipped, true);
    assert.equal(skippedInterval.reason, 'interval_not_elapsed');
  }

  // 5. Lock distribuído ativo bloqueia execução simultânea
  {
    const nowMs = 1_750_000_000_000;
    const { db } = createMockFirestore({
      'systemJobs/brawlStarsSync': {
        running: true,
        lockOwner: 'worker-a',
        leaseUntilMs: nowMs + 120_000,
      },
    });
    const res = await syncBrawlStarsStats(
      { force: true },
      {
        db,
        token: 'supercell-secret',
        nowMs: () => nowMs,
        fetchImpl: async () => {
          throw new Error('Não deveria executar com lease ativo');
        },
      }
    );
    assert.equal(res.skipped, true);
    assert.equal(res.reason, 'already_running');
  }

  // 6. testBrawlStarsApiConnection
  {
    const { db } = createMockFirestore();
    const okRes = await testBrawlStarsApiConnection('#2PP', {
      db,
      token: 'supercell-secret',
      fetchImpl: async () =>
        new globalThis.Response(JSON.stringify({ name: 'ProNXF', trophies: 61000 }), { status: 200 }),
    });
    assert.equal(okRes.ok, true);
    assert.equal(okRes.brawlApiConfigured, true);
    assert.equal(okRes.playerName, 'ProNXF');

    const failRes = await testBrawlStarsApiConnection('#2PP', {
      db,
      token: 'supercell-secret',
      fetchImpl: async () =>
        new globalThis.Response(JSON.stringify({ reason: 'accessDenied.invalidIp' }), { status: 403 }),
    });
    assert.equal(failRes.ok, false);
    assert.equal(failRes.brawlApiConfigured, false);
    assert.equal(failRes.httpStatus, 403);
  }
});

test('News Scheduler publica apenas matérias agendadas vencidas e respeita lock distribuído', async () => {
  const past = Timestamp.fromMillis(Date.now() - 60_000);
  const { db, store } = createMockFirestore({
    'news/n1': {
      slug: 'anuncio-1',
      title: 'Notícia Agendada',
      status: 'scheduled',
      publishedAt: past,
    },
  });

  const result = await publishDueScheduledNews('admin1', db);
  assert.equal(result.ok, true);
  assert.equal(result.publishedCount, 1);
  assert.equal(store.get('news/n1')?.status, 'published');

  // Lock ativo impede corrida
  await db.doc('systemJobs/publishScheduledNews').set({
    running: true,
    leaseUntilMs: Date.now() + 60_000,
  });
  const skipped = await publishDueScheduledNews('scheduler', db);
  assert.equal(skipped.skipped, true);
});

test('Media Service valida assinaturas binárias (magic bytes) e limite de tamanho', () => {
  const validPng = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  ]);
  assert.equal(detectImageMimeFromMagicBytes(validPng), 'image/png');
  const parsedPng = parseAndValidateImageDataUrl(
    `data:image/png;base64,${validPng.toString('base64')}`
  );
  assert.equal(parsedPng.mimeType, 'image/png');

  const validJpeg = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  ]);
  const parsedJpeg = parseAndValidateImageDataUrl(
    `data:image/jpeg;base64,${validJpeg.toString('base64')}`
  );
  assert.equal(parsedJpeg.mimeType, 'image/jpeg');

  const validWebp = Buffer.from([
    0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
  ]);
  assert.equal(detectImageMimeFromMagicBytes(validWebp), 'image/webp');

  // Rejeita MIME falsificado (header PNG com bytes JPEG)
  assert.throws(
    () =>
      parseAndValidateImageDataUrl(
        `data:image/png;base64,${validJpeg.toString('base64')}`
      ),
    /Conteúdo binário não corresponde/
  );

  // Rejeita SVG/HTML
  assert.throws(
    () =>
      parseAndValidateImageDataUrl(
        `data:image/svg+xml;base64,${Buffer.from('<svg></svg>').toString('base64')}`
      ),
    /Tipo de mídia não permitido/
  );

  // Rejeita imagem acima do limite MAX_IMAGE_BINARY_BYTES
  const oversized = Buffer.concat([validPng, Buffer.alloc(MAX_IMAGE_BINARY_BYTES + 100)]);
  assert.throws(
    () =>
      parseAndValidateImageDataUrl(
        `data:image/png;base64,${oversized.toString('base64')}`
      ),
    /excede o limite/
  );
});

test('CORS em produção bloqueia localhost, aceita origem autorizada e libera DELETE no preflight', async () => {
  const prevNodeEnv = process.env.NODE_ENV;
  const prevAllowed = process.env.ALLOWED_ORIGINS;
  process.env.NODE_ENV = 'production';
  process.env.ALLOWED_ORIGINS = 'https://nxf-esports.onrender.com';

  try {
    const app = createApp();
    await withServer(app, async (baseUrl) => {
      const localhostPreflight = await fetch(`${baseUrl}/api/health`, {
        method: 'OPTIONS',
        headers: { Origin: 'http://localhost:3000' },
      });
      assert.equal(localhostPreflight.status, 204);
      assert.equal(localhostPreflight.headers.get('access-control-allow-origin'), null);

      const prodPreflight = await fetch(`${baseUrl}/api/media/m_test`, {
        method: 'OPTIONS',
        headers: { Origin: 'https://nxf-esports.onrender.com' },
      });
      assert.equal(prodPreflight.status, 204);
      assert.equal(
        prodPreflight.headers.get('access-control-allow-origin'),
        'https://nxf-esports.onrender.com'
      );
      assert.match(prodPreflight.headers.get('access-control-allow-methods') || '', /DELETE/);
    });
  } finally {
    process.env.NODE_ENV = prevNodeEnv;
    process.env.ALLOWED_ORIGINS = prevAllowed;
  }
});

test('Media LRU Cache, normalização HTTPS e limpeza autorizada de mediaBlobs', async () => {
  clearMediaCache();
  assert.equal(normalizePublicBaseUrl('http://nxf-esports-api.onrender.com/', true), 'https://nxf-esports-api.onrender.com');
  assert.equal(normalizePublicBaseUrl('nxf-esports-api.onrender.com', true), 'https://nxf-esports-api.onrender.com');
  assert.equal(normalizePublicBaseUrl('http://localhost:3000', true), 'http://localhost:3000');

  const validPng = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  ]);
  const parsed = parseAndValidateImageDataUrl(
    `data:image/png;base64,${validPng.toString('base64')}`
  );

  const { db, store } = createMockFirestore();
  const saved = await saveMediaBlob(db, {
    scope: 'profile',
    folder: 'avatar',
    fileName: 'avatar.png',
    uploadedBy: 'user_1',
    parsed,
  });

  const mediaUrl = `https://nxf-esports-api.onrender.com/api/media/${saved.id}`;
  assert.equal(extractMediaIdFromUrl(mediaUrl), saved.id);

  // Remove manualmente do store simulado para provar que loadMediaBlob atende via LRU Cache (0 leituras no Firestore)
  const storedSnapshot = { ...store.get(`mediaBlobs/${saved.id}`)! };
  store.delete(`mediaBlobs/${saved.id}`);
  const fromCache = await loadMediaBlob(db, saved.id);
  assert(fromCache);
  assert.equal(fromCache.mimeType, 'image/png');
  assert.equal(Buffer.compare(fromCache.buffer, validPng), 0);

  // Restaura no store para testar controle de posse na exclusão
  store.set(`mediaBlobs/${saved.id}`, storedSnapshot);
  const forbiddenDel = await deleteMediaBlobIfAuthorized(db, saved.id, {
    uid: 'user_2',
    allowAny: false,
  });
  assert.equal(forbiddenDel.ok, false);
  assert.equal(forbiddenDel.status, 403);
  assert.equal(store.has(`mediaBlobs/${saved.id}`), true);

  const ownerDel = await deleteMediaBlobIfAuthorized(db, saved.id, {
    uid: 'user_1',
    allowAny: false,
  });
  assert.equal(ownerDel.ok, true);
  assert.equal(ownerDel.status, 200);
  assert.equal(store.has(`mediaBlobs/${saved.id}`), false);
});

test('Login por card de perfil autentica apenas com senha sem expor Code interno e aplica rate limit', async () => {
  clearProfileAuthRateLimits();
  const { db } = createMockFirestore({
    'users/u_active': {
      uid: 'u_active',
      status: 'active',
    },
    'publicProfiles/u_active': {
      uid: 'u_active',
      nickname: 'FuryAdmin',
      isActiveMember: true,
      showInEntrySelector: true,
      moderationStatus: 'approved',
    },
    'users/u_hidden': {
      uid: 'u_hidden',
      status: 'active',
    },
    'publicProfiles/u_hidden': {
      uid: 'u_hidden',
      nickname: 'HiddenMember',
      isActiveMember: true,
      showInEntrySelector: false,
      moderationStatus: 'approved',
    },
    'users/u_susp': {
      uid: 'u_susp',
      status: 'suspended',
    },
  });

  const mockAuth = {
    async getUser(uid: string) {
      return { uid, email: `${uid}@internal.nxf` };
    },
    async createCustomToken(uid: string) {
      return `custom-token-for-${uid}`;
    },
  } as never;

  const mockFetch: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body || '{}')) as { password?: string; email?: string };
    assert.equal(body.email, 'u_active@internal.nxf');
    if (body.password === 'correta123') {
      return new globalThis.Response(JSON.stringify({ registered: true }), { status: 200 });
    }
    return new globalThis.Response(
      JSON.stringify({ error: { message: 'INVALID_LOGIN_CREDENTIALS' } }),
      { status: 400 }
    );
  };

  // Perfil suspenso bloqueado
  const suspRes = await authenticateProfileByPassword(
    { uid: 'u_susp', password: 'abc', clientIp: '1.1.1.1' },
    { auth: mockAuth, db, apiKey: 'test-key', fetchImpl: mockFetch }
  );
  assert.equal(suspRes.ok, false);
  assert.equal(suspRes.status, 403);

  // Perfil oculto do seletor bloqueado
  const hiddenRes = await authenticateProfileByPassword(
    { uid: 'u_hidden', password: 'abc', clientIp: '1.1.1.1' },
    { auth: mockAuth, db, apiKey: 'test-key', fetchImpl: mockFetch }
  );
  assert.equal(hiddenRes.ok, false);
  assert.equal(hiddenRes.status, 403);

  // Senha inválida -> 401
  const wrongRes = await authenticateProfileByPassword(
    { uid: 'u_active', password: 'errada', clientIp: '2.2.2.2' },
    { auth: mockAuth, db, apiKey: 'test-key', fetchImpl: mockFetch }
  );
  assert.equal(wrongRes.ok, false);
  assert.equal(wrongRes.status, 401);

  // Senha válida -> 200 + customToken sem expor email/code
  const okRes = await authenticateProfileByPassword(
    { uid: 'u_active', password: 'correta123', clientIp: '2.2.2.2' },
    { auth: mockAuth, db, apiKey: 'test-key', fetchImpl: mockFetch }
  );
  assert.equal(okRes.ok, true);
  assert.equal(okRes.status, 200);
  assert.equal(okRes.customToken, 'custom-token-for-u_active');

  // 10 falhas disparam rate limit 429
  for (let i = 0; i < 10; i++) {
    await authenticateProfileByPassword(
      { uid: 'u_active', password: 'errada', clientIp: '3.3.3.3' },
      { auth: mockAuth, db, apiKey: 'test-key', fetchImpl: mockFetch }
    );
  }
  const blockedRes = await authenticateProfileByPassword(
    { uid: 'u_active', password: 'correta123', clientIp: '3.3.3.3' },
    { auth: mockAuth, db, apiKey: 'test-key', fetchImpl: mockFetch }
  );
  assert.equal(blockedRes.ok, false);
  assert.equal(blockedRes.status, 429);
});

test('Firebase Admin config usa exclusivamente variáveis de ambiente e banco padrão (default)', () => {
  const prevDbId = process.env.FIREBASE_FIRESTORE_DATABASE_ID;
  const prevWebKey = process.env.FIREBASE_WEB_API_KEY;
  const prevViteKey = process.env.VITE_FIREBASE_API_KEY;
  const prevSa = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const prevEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const prevPriv = process.env.FIREBASE_PRIVATE_KEY;
  const prevGac = process.env.GOOGLE_APPLICATION_CREDENTIALS;

  try {
    delete process.env.FIREBASE_FIRESTORE_DATABASE_ID;
    delete process.env.FIREBASE_WEB_API_KEY;
    delete process.env.VITE_FIREBASE_API_KEY;
    delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    delete process.env.FIREBASE_CLIENT_EMAIL;
    delete process.env.FIREBASE_PRIVATE_KEY;
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;

    assert.equal(getFirestoreDatabaseId(), '(default)');
    assert.equal(getFirebaseWebApiKey(), '');
    assert.equal(hasExplicitAdminCredentials(), false);

    process.env.FIREBASE_FIRESTORE_DATABASE_ID = 'custom-db';
    process.env.FIREBASE_WEB_API_KEY = 'web-api-key-env';
    assert.equal(getFirestoreDatabaseId(), 'custom-db');
    assert.equal(getFirebaseWebApiKey(), 'web-api-key-env');
  } finally {
    if (prevDbId === undefined) delete process.env.FIREBASE_FIRESTORE_DATABASE_ID;
    else process.env.FIREBASE_FIRESTORE_DATABASE_ID = prevDbId;
    if (prevWebKey === undefined) delete process.env.FIREBASE_WEB_API_KEY;
    else process.env.FIREBASE_WEB_API_KEY = prevWebKey;
    if (prevViteKey === undefined) delete process.env.VITE_FIREBASE_API_KEY;
    else process.env.VITE_FIREBASE_API_KEY = prevViteKey;
    if (prevSa === undefined) delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    else process.env.FIREBASE_SERVICE_ACCOUNT_JSON = prevSa;
    if (prevEmail === undefined) delete process.env.FIREBASE_CLIENT_EMAIL;
    else process.env.FIREBASE_CLIENT_EMAIL = prevEmail;
    if (prevPriv === undefined) delete process.env.FIREBASE_PRIVATE_KEY;
    else process.env.FIREBASE_PRIVATE_KEY = prevPriv;
    if (prevGac === undefined) delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    else process.env.GOOGLE_APPLICATION_CREDENTIALS = prevGac;
  }
});

test('Roster Service sincroniza users.teamIds e publicProfiles.teamIds atomicamente e bloqueia acesso cruzado', async () => {
  const { db, store } = createMockFirestore({
    'teams/team-a': { id: 'team-a', name: 'NXF Alpha', active: true },
    'teams/team-b': { id: 'team-b', name: 'NXF Beta', active: true },
    'users/mgrA': {
      uid: 'mgrA',
      fullName: 'Gestor A',
      displayName: 'MgrA',
      code: '#MGRA',
      roles: ['manager'],
      teamIds: ['team-a'],
      status: 'active',
    },
    'users/coachA': {
      uid: 'coachA',
      fullName: 'Coach A',
      displayName: 'CoachA',
      code: '#COACHA',
      roles: ['coach'],
      teamIds: ['team-a'],
      status: 'active',
    },
    'users/player1': {
      uid: 'player1',
      fullName: 'Jogador Um',
      displayName: 'Player1',
      code: '#PLY1',
      roles: ['player'],
      teamIds: ['team-b'],
      status: 'active',
    },
    'publicProfiles/player1': {
      uid: 'player1',
      nickname: 'Player1',
      teamIds: ['team-b'],
    },
    'users/susp1': {
      uid: 'susp1',
      fullName: 'Suspenso',
      displayName: 'Susp1',
      code: '#SUSP1',
      roles: ['player'],
      teamIds: [],
      status: 'suspended',
    },
    'teamMemberships/team-a_mgrA': {
      teamId: 'team-a',
      uid: 'mgrA',
      nickname: 'MgrA',
      roleInTeam: 'manager',
      status: 'active',
    },
    'teamMemberships/team-b_player1': {
      teamId: 'team-b',
      uid: 'player1',
      nickname: 'Player1',
      roleInTeam: 'starter',
      status: 'active',
    },
  });

  const mgrActor = {
    uid: 'mgrA',
    displayName: 'MgrA',
    capabilities: resolveServerCapabilities(store.get('users/mgrA') as never, null),
  };
  const coachActor = {
    uid: 'coachA',
    displayName: 'CoachA',
    capabilities: resolveServerCapabilities(store.get('users/coachA') as never, null),
  };
  const primaryActor = {
    uid: 'admin1',
    displayName: 'Admin1',
    capabilities: resolveServerCapabilities(
      {
        uid: 'admin1',
        fullName: 'Admin',
        displayName: 'Admin1',
        code: '#ADM1',
        roles: ['primary_admin'],
        status: 'active',
      },
      {
        uid: 'admin1',
        role: 'primary_admin',
        permissions: ['*'],
        active: true,
        grantedBy: 'admin1',
      }
    ),
  };

  // Coach não pode gerenciar vínculos de elenco
  const coachDenied = await upsertTeamMembership(db, coachActor, {
    teamId: 'team-a',
    targetUid: 'player1',
    nickname: 'Player1',
    roleInTeam: 'starter',
  });
  assert.equal(coachDenied.ok, false);
  assert.equal(coachDenied.status, 403);

  // Gestor de team-a NÃO pode alterar elenco de team-b
  const crossTeamDenied = await upsertTeamMembership(db, mgrActor, {
    teamId: 'team-b',
    targetUid: 'player1',
    nickname: 'Player1',
    roleInTeam: 'reserve',
  });
  assert.equal(crossTeamDenied.ok, false);
  assert.equal(crossTeamDenied.status, 403);

  // Usuário suspenso não pode ser vinculado
  const suspendedDenied = await upsertTeamMembership(db, mgrActor, {
    teamId: 'team-a',
    targetUid: 'susp1',
    nickname: 'Susp1',
    roleInTeam: 'starter',
  });
  assert.equal(suspendedDenied.ok, false);
  assert.equal(suspendedDenied.status, 400);

  // Gestor de team-a adiciona player1 em team-a -> users.teamIds e publicProfiles.teamIds incluem team-b e team-a
  const added = await upsertTeamMembership(db, mgrActor, {
    teamId: 'team-a',
    targetUid: 'player1',
    nickname: 'Player1',
    roleInTeam: 'starter',
  });
  assert.equal(added.ok, true);
  assert.deepEqual(new Set(added.teamIds), new Set(['team-b', 'team-a']));
  assert.equal(store.get('teamMemberships/team-a_player1')?.status, 'active');
  assert.deepEqual(
    new Set(store.get('users/player1')?.teamIds as string[]),
    new Set(['team-b', 'team-a'])
  );
  assert.deepEqual(
    new Set(store.get('publicProfiles/player1')?.teamIds as string[]),
    new Set(['team-b', 'team-a'])
  );

  // Gestor de team-a NÃO pode encerrar vínculo de team-b
  const crossEndDenied = await endTeamMembership(db, mgrActor, {
    teamId: 'team-b',
    targetUid: 'player1',
  });
  assert.equal(crossEndDenied.ok, false);
  assert.equal(crossEndDenied.status, 403);

  // Gestor de team-a encerra vínculo de team-a -> team-a sai de users.teamIds mantendo team-b ativo
  const ended = await endTeamMembership(db, mgrActor, {
    teamId: 'team-a',
    targetUid: 'player1',
  });
  assert.equal(ended.ok, true);
  assert.deepEqual(ended.teamIds, ['team-b']);
  assert.equal(store.get('teamMemberships/team-a_player1')?.status, 'transferred');
  assert.deepEqual(store.get('users/player1')?.teamIds, ['team-b']);
  assert.deepEqual(store.get('publicProfiles/player1')?.teamIds, ['team-b']);

  // Administrador Principal consegue encerrar vínculo de team-b -> teamIds fica vazio
  const adminEnded = await endTeamMembership(db, primaryActor, {
    teamId: 'team-b',
    targetUid: 'player1',
  });
  assert.equal(adminEnded.ok, true);
  assert.deepEqual(adminEnded.teamIds, []);
  assert.deepEqual(store.get('users/player1')?.teamIds, []);
  assert.deepEqual(store.get('publicProfiles/player1')?.teamIds, []);

  // Verifica trilha de auditoria gravada
  const auditEntries = Array.from(store.entries()).filter(([k]) => k.startsWith('auditLogs/'));
  assert.equal(auditEntries.length, 3);
});

test('Brawl Stars Intelligence: deduplicação de battlelog, retry controlado (429/500 vs 403), lookup e analytics reais', async () => {
  // 1. Deduplicação determinística entre perspectivas opostas da mesma batalha
  const rawBattlePerspectiveA = {
    battleTime: '20261127T180000.000Z',
    event: { id: 15000001, mode: 'gemGrab', map: 'Hard Rock Mine' },
    battle: {
      mode: 'gemGrab',
      type: 'friendly',
      result: 'victory',
      duration: 128,
      starPlayer: { tag: '#A1', name: 'AlphaOne', brawler: { id: 16000000, name: 'SHELLY', power: 11, trophies: 900 } },
      teams: [
        [
          { tag: '#A1', name: 'AlphaOne', brawler: { id: 16000000, name: 'SHELLY', power: 11, trophies: 900 } },
          { tag: '#A2', name: 'AlphaTwo', brawler: { id: 16000001, name: 'COLT', power: 11, trophies: 880 } },
          { tag: '#A3', name: 'AlphaThree', brawler: { id: 16000002, name: 'BULL', power: 11, trophies: 850 } },
        ],
        [
          { tag: '#B1', name: 'BetaOne', brawler: { id: 16000003, name: 'BROCK', power: 11, trophies: 890 } },
          { tag: '#B2', name: 'BetaTwo', brawler: { id: 16000004, name: 'RICO', power: 11, trophies: 870 } },
          { tag: '#B3', name: 'BetaThree', brawler: { id: 16000005, name: 'SPIKE', power: 11, trophies: 910 } },
        ],
      ],
    },
  };
  const rawBattlePerspectiveB = {
    ...rawBattlePerspectiveA,
    battle: {
      ...rawBattlePerspectiveA.battle,
      result: 'defeat',
      teams: [rawBattlePerspectiveA.battle.teams[1], rawBattlePerspectiveA.battle.teams[0]],
    },
  };

  const parsedA = parseBattlelogItem(rawBattlePerspectiveA, '#A1');
  const parsedB = parseBattlelogItem(rawBattlePerspectiveB, '#B1');
  assert(parsedA && parsedB);
  assert.equal(parsedA.battleId, parsedB.battleId);
  assert.equal(
    parsedA.battleId,
    computeBattleDedupId(parsedA.battleTime, parsedA.participantTags, parsedA.mode, parsedA.map)
  );

  // 2. Retry controlado: tenta novamente em 429 e 500, mas NÃO tenta novamente em 403/404
  {
    let attempts = 0;
    const flakyFetch: typeof fetch = async () => {
      attempts += 1;
      if (attempts === 1) return new globalThis.Response('rate limit', { status: 429 });
      if (attempts === 2) return new globalThis.Response('server error', { status: 500 });
      return new globalThis.Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    const res = await fetchBrawlApiWithRetry('https://api.brawlstars.com/v1/players/%23A1', 'secret', {
      fetchImpl: flakyFetch,
      sleepImpl: async () => {},
      maxRetries: 3,
    });
    assert.equal(res.ok, true);
    assert.equal(res.status, 200);
    assert.equal(attempts, 3);
  }
  {
    let attempts = 0;
    const forbiddenFetch: typeof fetch = async () => {
      attempts += 1;
      return new globalThis.Response(JSON.stringify({ reason: 'accessDenied.invalidIp' }), { status: 403 });
    };
    const res = await fetchBrawlApiWithRetry('https://api.brawlstars.com/v1/players/%23A1', 'secret', {
      fetchImpl: forbiddenFetch,
      sleepImpl: async () => {},
      maxRetries: 3,
    });
    assert.equal(res.ok, false);
    assert.equal(res.status, 403);
    assert.equal(attempts, 1);
  }

  // 3. Lookup oficial por Tag com topBrawlers
  {
    const lookup = await lookupBrawlPlayerByTag('2pp', {
      token: 'supercell-secret',
      fetchImpl: async (url) => {
        assert.match(String(url), /\/players\/%232PP$/);
        return new globalThis.Response(
          JSON.stringify({
            tag: '#2PP',
            name: 'AlphaOne',
            trophies: 62000,
            highestTrophies: 64500,
            '3vs3Victories': 9100,
            soloVictories: 210,
            duoVictories: 340,
            club: { tag: '#CLB1', name: 'NXF Fury' },
            brawlers: [
              { id: 16000000, name: 'SHELLY', power: 11, rank: 35, trophies: 1050, highestTrophies: 1100 },
              { id: 16000005, name: 'SPIKE', power: 11, rank: 34, trophies: 990, highestTrophies: 1020 },
            ],
          }),
          { status: 200 }
        );
      },
      sleepImpl: async () => {},
    });
    assert.equal(lookup.ok, true);
    assert.equal(lookup.player?.tag, '#2PP');
    assert.equal(lookup.player?.clubName, 'NXF Fury');
    assert.equal(lookup.player?.brawlersCount, 2);
    assert.equal(lookup.player?.topBrawlers[0]?.name, 'SHELLY');
  }

  // 4. Sync completo com includeBattlelogs=true persiste brawlBattles deduplicadas, playerAnalytics, teamAnalytics e brawlSyncLogs
  {
    const battleWithValidTags = {
      ...rawBattlePerspectiveA,
      battle: {
        ...rawBattlePerspectiveA.battle,
        teams: [
          [
            { tag: '#A101', name: 'AlphaOne', brawler: { id: 16000000, name: 'SHELLY', power: 11, trophies: 900 } },
            { tag: '#A102', name: 'AlphaTwo', brawler: { id: 16000001, name: 'COLT', power: 11, trophies: 880 } },
            { tag: '#A103', name: 'AlphaThree', brawler: { id: 16000002, name: 'BULL', power: 11, trophies: 850 } },
          ],
          [
            { tag: '#B101', name: 'BetaOne', brawler: { id: 16000003, name: 'BROCK', power: 11, trophies: 890 } },
            { tag: '#B102', name: 'BetaTwo', brawler: { id: 16000004, name: 'RICO', power: 11, trophies: 870 } },
            { tag: '#B103', name: 'BetaThree', brawler: { id: 16000005, name: 'SPIKE', power: 11, trophies: 910 } },
          ],
        ],
      },
    };

    const { db, store } = createMockFirestore({
      'teams/team-alpha': { id: 'team-alpha', name: 'NXF Alpha', active: true },
      'users/uA1': {
        uid: 'uA1',
        displayName: 'AlphaOne',
        brawlTag: '#A101',
        brawlTagStatus: 'approved',
        status: 'active',
        teamIds: ['team-alpha'],
      },
      'users/uA2': {
        uid: 'uA2',
        displayName: 'AlphaTwo',
        brawlTag: '#A102',
        brawlTagStatus: 'approved',
        status: 'active',
        teamIds: ['team-alpha'],
      },
      'teamMemberships/team-alpha_uA1': {
        teamId: 'team-alpha',
        uid: 'uA1',
        nickname: 'AlphaOne',
        roleInTeam: 'starter',
        status: 'active',
      },
      'teamMemberships/team-alpha_uA2': {
        teamId: 'team-alpha',
        uid: 'uA2',
        nickname: 'AlphaTwo',
        roleInTeam: 'starter',
        status: 'active',
      },
    });

    const mockFetch: typeof fetch = async (url) => {
      const s = String(url);
      if (s.endsWith('/battlelog')) {
        return new globalThis.Response(
          JSON.stringify({ items: [battleWithValidTags] }),
          { status: 200 }
        );
      }
      return new globalThis.Response(
        JSON.stringify({
          name: s.includes('%23A101') ? 'AlphaOne' : 'AlphaTwo',
          trophies: 60000,
          highestTrophies: 61000,
          '3vs3Victories': 8000,
          soloVictories: 100,
          duoVictories: 200,
        }),
        { status: 200 }
      );
    };

    const res = await syncBrawlStarsStats(
      { force: true, triggeredBy: 'admin1', includeBattlelogs: true },
      { db, token: 'supercell-secret', fetchImpl: mockFetch, sleepImpl: async () => {} }
    );
    assert.equal(res.ok, true);
    assert.equal(res.syncedCount, 2);
    assert.equal(res.newBattlesCount, 1);
    assert.equal(res.duplicateBattlesCount, 1);

    // Exatamente 1 batalha deduplicada gravada em brawlBattles
    const storedBattles = Array.from(store.entries()).filter(([k]) => k.startsWith('brawlBattles/'));
    assert.equal(storedBattles.length, 1);

    // playerAnalytics real gerado para uA1 e uA2
    const analyticsA1 = store.get('playerAnalytics/uA1') as Record<string, unknown>;
    assert(analyticsA1);
    assert.equal(analyticsA1.totalBattles, 1);
    assert.equal(analyticsA1.wins, 1);
    assert.equal(analyticsA1.winRate, 100);
    assert.equal((analyticsA1.brawlerStats as Array<{ brawlerName: string }>)[0]?.brawlerName, 'SHELLY');

    // teamAnalytics real gerado para team-alpha
    const teamAnalytics = store.get('teamAnalytics/team-alpha') as Record<string, unknown>;
    assert(teamAnalytics);
    assert.equal(teamAnalytics.totalBattles, 1);
    assert.equal(teamAnalytics.wins, 1);
    assert.equal(teamAnalytics.winRate, 100);

    // Log de sincronização registrado em brawlSyncLogs
    const syncLogs = Array.from(store.entries()).filter(([k]) => k.startsWith('brawlSyncLogs/'));
    assert.equal(syncLogs.length, 1);
    assert.equal(syncLogs[0][1].status, 'ok');
  }
});

test('NXF Match Tracker: confirma batalha inequívoca, deduplica leituras, envia ambíguas para fila e atualiza classificação', async () => {
  const actor: TournamentActor = { uid: 'admin1', displayName: 'AdminNXF' };
  const scheduledAtMs = Date.parse('2026-11-27T18:00:00.000Z');

  const { db, store } = createMockFirestore({
    'teams/team-a': { id: 'team-a', name: 'NXF Alpha', active: true },
    'teams/team-b': { id: 'team-b', name: 'NXF Beta', active: true },
    'users/uA1': { uid: 'uA1', displayName: 'A1', brawlTag: '#A101', brawlTagStatus: 'approved', status: 'active' },
    'users/uA2': { uid: 'uA2', displayName: 'A2', brawlTag: '#A102', brawlTagStatus: 'approved', status: 'active' },
    'users/uA3': { uid: 'uA3', displayName: 'A3', brawlTag: '#A103', brawlTagStatus: 'approved', status: 'active' },
    'users/uB1': { uid: 'uB1', displayName: 'B1', brawlTag: '#B101', brawlTagStatus: 'approved', status: 'active' },
    'users/uB2': { uid: 'uB2', displayName: 'B2', brawlTag: '#B102', brawlTagStatus: 'approved', status: 'active' },
    'users/uB3': { uid: 'uB3', displayName: 'B3', brawlTag: '#B103', brawlTagStatus: 'approved', status: 'active' },
    'tournaments/t1': {
      name: 'Copa NXF Tracker',
      status: 'ongoing',
      currentStage: 'groups',
      rules: DEFAULT_NXF_TOURNAMENT_RULES,
      participants: [
        { teamId: 'team-a', teamName: 'NXF Alpha', playerTags: ['#A101', '#A102', '#A103'] },
        { teamId: 'team-b', teamName: 'NXF Beta', playerTags: ['#B101', '#B102', '#B103'] },
      ],
      groups: [
        { name: 'A', teamIds: ['team-a', 'team-b'], standings: [], unresolvedTieTeamIds: [] },
      ],
    },
    'matches/m1': {
      tournamentId: 't1',
      tournamentName: 'Copa NXF Tracker',
      stage: 'groups',
      groupName: 'A',
      round: 1,
      format: 'MD3',
      seriesBestOf: 3,
      teamId: 'team-a',
      teamName: 'NXF Alpha',
      teamAId: 'team-a',
      teamBId: 'team-b',
      opponentName: 'NXF Beta',
      scheduledAt: Timestamp.fromMillis(scheduledAtMs),
      status: 'scheduled',
      nxfScore: 0,
      opponentScore: 0,
      games: [],
      locked: false,
      isPublic: true,
    },
  });

  // 1. Batalha inequívoca #1 (3v3 completo, todos os 6 jogadores verificados em lados opostos -> auto_confirm)
  const cleanGame1 = {
    battleTime: '20261127T180500.000Z',
    event: { id: 1, mode: 'gemGrab', map: 'Hard Rock Mine' },
    battle: {
      mode: 'gemGrab',
      type: 'friendly',
      result: 'victory',
      teams: [
        [
          { tag: '#A101', name: 'A1', brawler: { name: 'SHELLY' } },
          { tag: '#A102', name: 'A2', brawler: { name: 'COLT' } },
          { tag: '#A103', name: 'A3', brawler: { name: 'SPIKE' } },
        ],
        [
          { tag: '#B101', name: 'B1', brawler: { name: 'BROCK' } },
          { tag: '#B102', name: 'B2', brawler: { name: 'RICO' } },
          { tag: '#B103', name: 'B3', brawler: { name: 'PIPER' } },
        ],
      ],
    },
  };

  // 2. Batalha ambígua #2 (cobertura parcial de elenco: apenas 1 jogador conhecido do lado B -> pending_review)
  const ambiguousGame2 = {
    battleTime: '20261127T181200.000Z',
    event: { id: 2, mode: 'brawlBall', map: 'Backyard Bowl' },
    battle: {
      mode: 'brawlBall',
      type: 'friendly',
      result: 'victory',
      teams: [
        [
          { tag: '#A101', name: 'A1', brawler: { name: 'MAX' } },
          { tag: '#A102', name: 'A2', brawler: { name: 'GENE' } },
          { tag: '#A103', name: 'A3', brawler: { name: 'SANDY' } },
        ],
        [
          { tag: '#B101', name: 'B1', brawler: { name: 'BYRON' } },
          { tag: '#RAND1', name: 'Sub1', brawler: { name: 'GUS' } },
          { tag: '#RAND2', name: 'Sub2', brawler: { name: 'MELODIE' } },
        ],
      ],
    },
  };

  // Também testa evaluateBattleForMatches diretamente em empate (draw -> pending_review, nunca auto_confirm)
  const drawBattle = parseBattlelogItem(
    {
      ...cleanGame1,
      battleTime: '20261127T182000.000Z',
      battle: { ...cleanGame1.battle, result: 'draw' },
    },
    '#A101'
  );
  assert(drawBattle);
  const drawEval = evaluateBattleForMatches(drawBattle, [
    {
      matchId: 'm1',
      tournamentId: 't1',
      tournamentName: 'Copa NXF Tracker',
      match: store.get('matches/m1') as never,
      scheduledAtMs,
      teamAId: 'team-a',
      teamAName: 'NXF Alpha',
      teamBId: 'team-b',
      teamBName: 'NXF Beta',
      teamATags: ['#A101', '#A102', '#A103'],
      teamBTags: ['#B101', '#B102', '#B103'],
    },
  ]);
  assert.equal(drawEval.disposition, 'pending_review');
  assert(drawEval.reasons.some((r) => /empatada|draw/i.test(r)));

  // Executa ciclo do Match Tracker (lê battlelog de vários jogadores com as mesmas batalhas para testar deduplicação)
  const trackerMockFetch: typeof fetch = async (url) => {
    const u = String(url);
    if (u.includes('%23A101') || u.includes('%23A102')) {
      return new globalThis.Response(
        JSON.stringify({ items: [cleanGame1, ambiguousGame2] }),
        { status: 200 }
      );
    }
    return new globalThis.Response(JSON.stringify({ items: [] }), { status: 200 });
  };

  const cycleRes = await runMatchTrackerCycle(
    { force: true, triggeredBy: 'admin1' },
    {
      db,
      token: 'supercell-secret',
      fetchImpl: trackerMockFetch,
      sleepImpl: async () => {},
      nowMs: () => scheduledAtMs + 20 * 60_000,
    }
  );
  assert.equal(cycleRes.ok, true);
  assert.equal(cycleRes.autoRegisteredGames, 1);
  assert.equal(cycleRes.pendingConfirmations, 1);

  // Partida m1 avançou exatamente para 1 x 0 (não duplicou ao ler A2!) e ainda está live_manual (MD3 precisa de 2)
  const matchAfterCycle = store.get('matches/m1') as Record<string, unknown>;
  assert.equal(matchAfterCycle.nxfScore, 1);
  assert.equal(matchAfterCycle.opponentScore, 0);
  assert.equal(matchAfterCycle.status, 'live_manual');

  // Fila de confirmação administrativa contém exatamente 1 candidato pendente (a batalha ambígua)
  const candidates = Array.from(store.entries()).filter(([k]) =>
    k.startsWith('matchTrackerCandidates/')
  );
  assert.equal(candidates.length, 1);
  const [candKey, candData] = candidates[0];
  const candidateId = candKey.split('/')[1];
  assert.equal(candData.status, 'pending_review');
  assert.equal(candData.matchId, 'm1');
  assert((candData.reasons as string[]).length > 0);

  // Admin aprova a batalha ambígua -> placar vai para 2 x 0 -> série MD3 encerra -> tabela de grupos atualiza com 3 pts para NXF Alpha!
  const approveRes = await resolveMatchTrackerCandidate(db, actor, {
    candidateId,
    decision: 'approve',
    notes: 'Substitutos autorizados pela organização.',
  });
  assert.equal(approveRes.ok, true);
  assert.equal(store.get('matches/m1')?.nxfScore, 2);
  assert.equal(store.get('matches/m1')?.opponentScore, 0);
  assert.equal(store.get('matches/m1')?.status, 'completed');
  assert.equal(store.get('matches/m1')?.winnerTeamId, 'team-a');
  assert.equal(store.get('matches/m1')?.resultSource, 'hybrid');

  // Verifica recálculo automático da classificação do Grupo A
  const groups = (store.get('tournaments/t1')?.groups || []) as Array<{
    name: string;
    standings: Array<{ teamId: string; points: number; wins: number; losses: number }>;
  }>;
  assert.equal(groups[0].standings[0].teamId, 'team-a');
  assert.equal(groups[0].standings[0].points, 3);
  assert.equal(groups[0].standings[0].wins, 1);
  assert.equal(groups[0].standings[1].teamId, 'team-b');
  assert.equal(groups[0].standings[1].points, 0);
});

test('Tournament Engine: grupos MD3, desempate (Pts -> H2H -> Vitórias -> Empate persistente), bloqueio de fase, playoffs MD5 e >2 grupos', async () => {
  const actor: TournamentActor = { uid: 'admin1', displayName: 'AdminNXF' };
  const sampleTs = Timestamp.now();

  // 1. Teste unitário puro de computeGroupStandings:
  //    (a) Confronto direto (H2H) desempata 2 equipes com mesma pontuação
  {
    const h2hRes = computeGroupStandings(
      'A',
      [
        { teamId: 't1', teamName: 'Alpha' },
        { teamId: 't2', teamName: 'Beta' },
        { teamId: 't3', teamName: 'Gamma' },
      ],
      [
        {
          id: 'm1',
          stage: 'groups',
          groupName: 'A',
          format: 'MD3',
          teamId: 't1',
          teamName: 'Alpha',
          teamAId: 't1',
          teamBId: 't2',
          opponentName: 'Beta',
          status: 'completed',
          nxfScore: 1,
          opponentScore: 2,
          winnerTeamId: 't2',
          scheduledAt: sampleTs,
          isPublic: true,
          enteredBy: 'admin1',
        },
        {
          id: 'm2',
          stage: 'groups',
          groupName: 'A',
          format: 'MD3',
          teamId: 't1',
          teamName: 'Alpha',
          teamAId: 't1',
          teamBId: 't3',
          opponentName: 'Gamma',
          status: 'completed',
          nxfScore: 2,
          opponentScore: 0,
          winnerTeamId: 't1',
          scheduledAt: sampleTs,
          isPublic: true,
          enteredBy: 'admin1',
        },
        {
          id: 'm3',
          stage: 'groups',
          groupName: 'A',
          format: 'MD3',
          teamId: 't2',
          teamName: 'Beta',
          teamAId: 't2',
          teamBId: 't3',
          opponentName: 'Gamma',
          status: 'completed',
          nxfScore: 2,
          opponentScore: 1,
          winnerTeamId: 't2',
          scheduledAt: sampleTs,
          isPublic: true,
          enteredBy: 'admin1',
        },
      ],
      DEFAULT_NXF_TOURNAMENT_RULES
    );
    assert.equal(h2hRes.unresolvedTieTeamIds.length, 0);
    assert.equal(h2hRes.standings[0].teamId, 't2'); // 6 pts
    assert.equal(h2hRes.standings[1].teamId, 't1'); // 3 pts
    assert.equal(h2hRes.standings[2].teamId, 't3'); // 0 pts
  }

  //    (b) Empate triplo circular perfeito (A>B, B>C, C>A, todos 2x1 -> 3 pts, H2H 1V/1D, 1 vitória)
  //        NÃO classifica arbitrariamente quando additionalTiebreaker = 'none'
  {
    const circularRes = computeGroupStandings(
      'A',
      [
        { teamId: 't1', teamName: 'Alpha' },
        { teamId: 't2', teamName: 'Beta' },
        { teamId: 't3', teamName: 'Gamma' },
      ],
      [
        {
          id: 'c1',
          stage: 'groups',
          groupName: 'A',
          format: 'MD3',
          teamId: 't1',
          teamName: 'Alpha',
          teamAId: 't1',
          teamBId: 't2',
          opponentName: 'Beta',
          status: 'completed',
          nxfScore: 2,
          opponentScore: 1,
          winnerTeamId: 't1',
          scheduledAt: sampleTs,
          isPublic: true,
          enteredBy: 'admin1',
        },
        {
          id: 'c2',
          stage: 'groups',
          groupName: 'A',
          format: 'MD3',
          teamId: 't2',
          teamName: 'Beta',
          teamAId: 't2',
          teamBId: 't3',
          opponentName: 'Gamma',
          status: 'completed',
          nxfScore: 2,
          opponentScore: 1,
          winnerTeamId: 't2',
          scheduledAt: sampleTs,
          isPublic: true,
          enteredBy: 'admin1',
        },
        {
          id: 'c3',
          stage: 'groups',
          groupName: 'A',
          format: 'MD3',
          teamId: 't3',
          teamName: 'Gamma',
          teamAId: 't3',
          teamBId: 't1',
          opponentName: 'Alpha',
          status: 'completed',
          nxfScore: 2,
          opponentScore: 1,
          winnerTeamId: 't3',
          scheduledAt: sampleTs,
          isPublic: true,
          enteredBy: 'admin1',
        },
      ],
      { ...DEFAULT_NXF_TOURNAMENT_RULES, additionalTiebreaker: 'none' }
    );
    assert.equal(circularRes.unresolvedTieTeamIds.length, 3);
    assert.equal(circularRes.standings.every((r) => r.tieStatus === 'unresolved'), true);
    assert.equal(circularRes.standings.some((r) => r.qualified), false);
  }

  // 2. Fluxo completo de campeonato NXF padrão (2 grupos × 4 equipes -> 12 jogos MD3 -> empate bloqueado -> resolução manual -> lock -> SF1/SF2 MD5 -> FINAL MD5 -> Campeão)
  {
    const { db, store } = createMockFirestore();
    const participants = [
      { teamId: 'a1', teamName: 'Alpha 1', groupName: 'A', playerTags: [] },
      { teamId: 'a2', teamName: 'Alpha 2', groupName: 'A', playerTags: [] },
      { teamId: 'a3', teamName: 'Alpha 3', groupName: 'A', playerTags: [] },
      { teamId: 'a4', teamName: 'Alpha 4', groupName: 'A', playerTags: [] },
      { teamId: 'b1', teamName: 'Beta 1', groupName: 'B', playerTags: [] },
      { teamId: 'b2', teamName: 'Beta 2', groupName: 'B', playerTags: [] },
      { teamId: 'b3', teamName: 'Beta 3', groupName: 'B', playerTags: [] },
      { teamId: 'b4', teamName: 'Beta 4', groupName: 'B', playerTags: [] },
    ];

    const created = await createConfiguredTournament(db, actor, {
      name: 'NXF Major Season 1',
      participants,
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const tid = created.id;

    // Verifica padrão configurável NXF
    assert.equal(created.rules.groupCount, 2);
    assert.equal(created.rules.teamsPerGroup, 4);
    assert.equal(created.rules.groupMatchFormat, 'MD3');
    assert.equal(created.rules.playoffMatchFormat, 'MD5');
    assert.equal(created.rules.winPoints, 3);
    assert.equal(created.rules.lossPoints, 0);
    assert.equal(created.rules.qualifiersPerGroup, 2);

    const gen = await generateTournamentGroupStage(db, actor, tid);
    assert.equal(gen.ok, true);
    if (!gen.ok) return;
    assert.equal(gen.groupsCount, 2);
    assert.equal(gen.matchesCreated, 12); // 6 confrontos por grupo em turno único

    // Tentar avançar antes de concluir todos os confrontos -> bloqueado (409)
    const prematureAdvance = await advanceTournamentStage(db, actor, tid);
    assert.equal(prematureAdvance.ok, false);
    if (!prematureAdvance.ok) assert.equal(prematureAdvance.status, 409);

    // Preenche resultados:
    // Grupo A: a1 vence todos (9 pts), e a2/a3/a4 criam empate triplo circular (3 pts cada, tudo 2x1)!
    // Grupo B: b1 (9 pts), b2 (6 pts), b3 (3 pts), b4 (0 pts) — sem empate.
    const groupMatches: Array<Record<string, unknown> & { id: string }> = Array.from(store.entries())
      .filter(([k, v]) => k.startsWith('matches/') && v.tournamentId === tid && v.stage === 'groups')
      .map(([k, v]) => ({ ...(v as Record<string, unknown>), id: k.split('/')[1] }));
    assert.equal(groupMatches.length, 12);

    const winnerForPair = (a: string, b: string): string => {
      const set = new Set([a, b]);
      // Grupo A
      if (set.has('a1')) return 'a1';
      if (set.has('a2') && set.has('a3')) return 'a2';
      if (set.has('a3') && set.has('a4')) return 'a3';
      if (set.has('a4') && set.has('a2')) return 'a4';
      // Grupo B (ordem estrita b1 > b2 > b3 > b4)
      return a < b ? a : b;
    };

    for (const m of groupMatches) {
      const teamAId = String(m.teamAId);
      const teamBId = String(m.teamBId);
      const winner = winnerForPair(teamAId, teamBId);
      const res = await recordTournamentMatchResult(db, actor, {
        matchId: m.id,
        teamAScore: winner === teamAId ? 2 : 1,
        teamBScore: winner === teamBId ? 2 : 1,
        finalize: true,
      });
      assert.equal(res.ok, true);
    }

    // Todos os 12 confrontos foram concluídos, MAS há empate triplo persistente no Grupo A -> avanço BLOQUEADO (409)!
    const blockedByTie = await advanceTournamentStage(db, actor, tid);
    assert.equal(blockedByTie.ok, false);
    if (!blockedByTie.ok) {
      assert.equal(blockedByTie.status, 409);
      assert.match(blockedByTie.error, /empate não resolvido/i);
    }

    // Admin define ordem manual explícita para o Grupo A (a1, a3, a2, a4) -> resolve empate
    const resolveTie = await configureTournament(db, actor, tid, {
      manualTieBreakByGroup: { A: ['a1', 'a3', 'a2', 'a4'] },
    });
    assert.equal(resolveTie.ok, true);

    // Agora avança para Playoffs -> trava grupos e cria SF1 (1º A × 2º B = a1 × b2) e SF2 (1º B × 2º A = b1 × a3) em MD5!
    const toPlayoffs = await advanceTournamentStage(db, actor, tid);
    assert.equal(toPlayoffs.ok, true);
    if (!toPlayoffs.ok) return;
    assert.equal(toPlayoffs.nextStage, 'playoffs');
    assert.equal(toPlayoffs.createdMatchesCount, 2);

    // Fase de grupos travada: tentar alterar qualquer partida de grupo deve falhar com 409
    const editLocked = await recordTournamentMatchResult(db, actor, {
      matchId: groupMatches[0].id,
      teamAScore: 0,
      teamBScore: 2,
      finalize: true,
    });
    assert.equal(editLocked.ok, false);
    if (!editLocked.ok) assert.equal(editLocked.status, 409);

    const playoffMatches: Array<Record<string, unknown> & { id: string }> = Array.from(store.entries())
      .filter(([k, v]) => k.startsWith('matches/') && v.tournamentId === tid && v.stage === 'playoffs')
      .map(([k, v]) => ({ ...(v as Record<string, unknown>), id: k.split('/')[1] }));
    assert.equal(playoffMatches.length, 2);
    const sf1 = playoffMatches.find((m) => m.bracketSlot === 'SF1')!;
    const sf2 = playoffMatches.find((m) => m.bracketSlot === 'SF2')!;
    assert.equal(sf1.format, 'MD5');
    assert.equal(sf1.teamAId, 'a1');
    assert.equal(sf1.teamBId, 'b2');
    assert.equal(sf2.format, 'MD5');
    assert.equal(sf2.teamAId, 'b1');
    assert.equal(sf2.teamBId, 'a3');

    // Conclui SF1 (a1 vence 3x1) e SF2 (b1 vence 3x2) -> avança para Grand Final em MD5
    await recordTournamentMatchResult(db, actor, { matchId: sf1.id, teamAScore: 3, teamBScore: 1, finalize: true });
    await recordTournamentMatchResult(db, actor, { matchId: sf2.id, teamAScore: 3, teamBScore: 2, finalize: true });

    const toFinal = await advanceTournamentStage(db, actor, tid);
    assert.equal(toFinal.ok, true);
    if (!toFinal.ok) return;
    assert.equal(toFinal.nextStage, 'final');
    assert.equal(toFinal.createdMatchesCount, 1);

    const finalMatch: Record<string, unknown> & { id: string } = Array.from(store.entries())
      .filter(([k, v]) => k.startsWith('matches/') && v.tournamentId === tid && v.stage === 'final')
      .map(([k, v]) => ({ ...(v as Record<string, unknown>), id: k.split('/')[1] }))[0];
    assert.equal(finalMatch.format, 'MD5');
    assert.equal(finalMatch.teamAId, 'a1');
    assert.equal(finalMatch.teamBId, 'b1');

    // Conclui Grande Final (a1 vence 3x0) -> encerra torneio e coroa campeã Alpha 1
    await recordTournamentMatchResult(db, actor, { matchId: finalMatch.id, teamAScore: 3, teamBScore: 0, finalize: true });
    const complete = await advanceTournamentStage(db, actor, tid);
    assert.equal(complete.ok, true);
    if (!complete.ok) return;
    assert.equal(complete.nextStage, 'completed');
    assert.equal(complete.championTeamName, 'Alpha 1');
    assert.equal(store.get(`tournaments/${tid}`)?.status, 'completed');
  }

  // 3. Mais de 2 grupos (3 grupos × 2 equipes): exige chaveamento administrativo explícito antes de gerar playoffs
  {
    const { db, store } = createMockFirestore();
    const created3 = await createConfiguredTournament(db, actor, {
      name: 'NXF Tri-Group Cup',
      rules: { groupCount: 3, teamsPerGroup: 2, qualifiersPerGroup: 2 },
      participants: [
        { teamId: 'g1a', teamName: 'G1A', groupName: 'A', playerTags: [] },
        { teamId: 'g1b', teamName: 'G1B', groupName: 'A', playerTags: [] },
        { teamId: 'g2a', teamName: 'G2A', groupName: 'B', playerTags: [] },
        { teamId: 'g2b', teamName: 'G2B', groupName: 'B', playerTags: [] },
        { teamId: 'g3a', teamName: 'G3A', groupName: 'C', playerTags: [] },
        { teamId: 'g3b', teamName: 'G3B', groupName: 'C', playerTags: [] },
      ],
    });
    assert.equal(created3.ok, true);
    if (!created3.ok) return;
    const tid3 = created3.id;

    const gen3 = await generateTournamentGroupStage(db, actor, tid3);
    assert.equal(gen3.ok, true);

    const matches3 = Array.from(store.entries())
      .filter(([k, v]) => k.startsWith('matches/') && v.tournamentId === tid3 && v.stage === 'groups')
      .map(([k]) => k.split('/')[1]);
    for (const mId of matches3) {
      await recordTournamentMatchResult(db, actor, { matchId: mId, teamAScore: 2, teamBScore: 0, finalize: true });
    }

    // Sem definição administrativa -> bloqueado com 400
    const missingBracket = await advanceTournamentStage(db, actor, tid3);
    assert.equal(missingBracket.ok, false);
    if (!missingBracket.ok) {
      assert.equal(missingBracket.status, 400);
      assert.match(missingBracket.error, /chaveamento administrativo/i);
    }

    // Com playoffBracketConfig explícito -> gera playoffs MD5 corretamente
    const explicitPlayoffs = await advanceTournamentStage(db, actor, tid3, {
      playoffBracketConfig: [
        { slot: 'QF1', label: 'Quartas 1', teamAKey: 'A:1', teamBKey: 'C:2' },
        { slot: 'QF2', label: 'Quartas 2', teamAKey: 'B:1', teamBKey: 'A:2' },
      ],
    });
    assert.equal(explicitPlayoffs.ok, true);
    if (explicitPlayoffs.ok) {
      assert.equal(explicitPlayoffs.nextStage, 'playoffs');
      assert.equal(explicitPlayoffs.createdMatchesCount, 2);
    }
  }
});

test('Navegação do painel agrupa domínios e respeita permissões de cada cargo', () => {
  const makeUser = (roles: Array<'candidate' | 'player' | 'coach' | 'manager' | 'delegated_admin' | 'primary_admin'>) => ({
    uid: `u_${roles.join('_')}`,
    fullName: 'Teste NXF',
    displayName: 'Teste',
    code: '#TST001',
    roles,
    teamIds: ['team-test'],
    status: 'active' as const,
  });

  // 1. Administrador Principal: vê os 4 grupos e todas as 9 rotas
  const primaryCaps = resolveUnifiedCapabilities(makeUser(['primary_admin']), {
    uid: 'u_primary_admin',
    role: 'primary_admin',
    permissions: ['*'],
    active: true,
    grantedBy: 'u_primary_admin',
  });
  const primaryGroups = buildPanelNavigation(primaryCaps);
  assert.deepEqual(
    primaryGroups.map((g) => g.label),
    ['Visão Geral', 'Operação', 'Conteúdo', 'Administração']
  );
  const primaryPaths = primaryGroups.flatMap((g) => g.items.map((i) => i.to));
  assert.deepEqual(primaryPaths, [
    '/painel',
    '/painel/perfil',
    '/painel/notificacoes',
    '/painel/organizacao',
    '/painel/competitivo',
    '/painel/treinamentos',
    '/painel/recrutamento',
    '/painel/studio',
    '/painel/system',
  ]);
  assert.equal(resolveActiveNavItem(primaryGroups, '/painel')?.item.id, 'dashboard');
  assert.equal(resolveActiveNavItem(primaryGroups, '/painel/organizacao/')?.group.id, 'operations');
  assert.equal(resolveActiveNavItem(primaryGroups, '/painel/studio')?.group.id, 'content');
  assert.equal(resolveActiveNavItem(primaryGroups, '/painel/system')?.group.id, 'administration');
  assert.equal(resolveActiveNavItem(primaryGroups, '/rota-invalida'), null);

  // 2. Admin Delegado somente teams.manage: sem grupo Conteúdo, mantém Administração
  const delegatedTeamsCaps = resolveUnifiedCapabilities(makeUser(['delegated_admin']), {
    uid: 'u_delegated_admin',
    role: 'delegated_admin',
    permissions: ['teams.manage'],
    active: true,
    grantedBy: 'u_primary_admin',
  });
  const delegatedTeamsGroups = buildPanelNavigation(delegatedTeamsCaps);
  assert.deepEqual(
    delegatedTeamsGroups.map((g) => g.label),
    ['Visão Geral', 'Operação', 'Administração']
  );

  // 3. Admin Delegado com cms.manage: inclui Conteúdo (Portal e CMS)
  const delegatedCmsCaps = resolveUnifiedCapabilities(makeUser(['delegated_admin']), {
    uid: 'u_delegated_admin',
    role: 'delegated_admin',
    permissions: ['cms.manage'],
    active: true,
    grantedBy: 'u_primary_admin',
  });
  const delegatedCmsGroups = buildPanelNavigation(delegatedCmsCaps);
  assert.deepEqual(
    delegatedCmsGroups.map((g) => g.label),
    ['Visão Geral', 'Operação', 'Conteúdo', 'Administração']
  );

  // 4. Manager, Coach e Player: somente Visão Geral e Operação (sem Conteúdo nem Administração)
  for (const role of ['manager', 'coach', 'player'] as const) {
    const caps = resolveUnifiedCapabilities(makeUser([role]), null);
    const groups = buildPanelNavigation(caps);
    assert.deepEqual(
      groups.map((g) => g.label),
      ['Visão Geral', 'Operação']
    );
    const paths = groups.flatMap((g) => g.items.map((i) => i.to));
    assert(paths.includes('/painel/organizacao'));
    assert(!paths.includes('/painel/studio'));
    assert(!paths.includes('/painel/system'));
  }

  // 5. Candidato: vê Visão Geral e somente Recrutamento em Operação
  const candidateCaps = resolveUnifiedCapabilities(makeUser(['candidate']), null);
  const candidateGroups = buildPanelNavigation(candidateCaps);
  assert.deepEqual(
    candidateGroups.map((g) => g.label),
    ['Visão Geral', 'Operação']
  );
  assert.deepEqual(
    candidateGroups.find((g) => g.id === 'operations')?.items.map((i) => i.to),
    ['/painel/recrutamento']
  );

  assert.equal(formatTeamRoleLabel('starter'), 'Titular');
  assert.equal(formatTeamRoleLabel('manager'), 'Gerente');
  assert.equal(formatTeamRoleLabel(undefined), 'Integrante');
});

test('Organization Helpers preservam equipes legadas e filtram diretório por nome, código ou Brawl Tag mantendo UID', () => {
  // Equipe legada sem campos opcionais (ex.: documento existente criado fora do fluxo atual)
  const legacyTeam = { id: 'chifre', name: 'Chifre' };
  assert.equal(resolveTeamVisibility(legacyTeam), 'unknown');
  assert.equal(formatTeamVisibilityLabel(legacyTeam), 'Visibilidade não definida');
  assert.equal(isTeamActive(legacyTeam), true);

  assert.equal(formatTeamVisibilityLabel({ id: 'a', name: 'Alpha', isPublic: true }), 'Pública no portal');
  assert.equal(formatTeamVisibilityLabel({ id: 'b', name: 'Beta', isPublic: false }), 'Interna');
  assert.equal(isTeamActive({ id: 'c', name: 'Archived', active: false }), false);

  assert.equal(slugifyTeamId('  NXF Fúria Academy 2026! '), 'nxf-furia-academy-2026');

  const directory = buildMemberDirectory({
    users: [
      {
        uid: 'uid_alpha_1',
        fullName: 'Lucas Silva',
        displayName: 'FuryLux',
        code: '#NXF101',
        brawlTag: '#2PP99AA',
        roles: ['player'],
        status: 'active',
      },
      {
        uid: 'uid_susp_1',
        fullName: 'Conta Suspensa',
        displayName: 'BlockedUser',
        code: '#SUSP99',
        roles: ['player'],
        status: 'suspended',
      },
    ],
    publicProfiles: [
      {
        uid: 'uid_alpha_1',
        nickname: 'FuryLux',
        publicRole: 'Jogador',
        layout: 'competitive',
        brawlTag: '#2PP99AA',
        isActiveMember: true,
        showInEntrySelector: true,
        moderationStatus: 'approved',
      },
      {
        uid: 'uid_public_2',
        nickname: 'VortexBR',
        publicRole: 'Jogador',
        layout: 'competitive',
        brawlTag: '#88QQVTX',
        isActiveMember: true,
        showInEntrySelector: true,
        moderationStatus: 'approved',
      },
    ],
    memberships: [
      {
        id: 'chifre_uid_legacy_3',
        teamId: 'chifre',
        uid: 'uid_legacy_3',
        nickname: 'LegacyCap',
        roleInTeam: 'manager',
        status: 'active',
      },
    ],
  });

  // Usuário suspenso não entra no seletor; 3 integrantes válidos ordenados por displayName
  assert.equal(directory.length, 3);
  assert.equal(directory.some((m) => m.uid === 'uid_susp_1'), false);

  // Busca por Brawl Tag sem '#' retorna o membro correto preservando o UID interno
  const byTag = filterMemberDirectory(directory, '88qqvtx');
  assert.equal(byTag.length, 1);
  assert.equal(byTag[0].uid, 'uid_public_2');

  // Busca por código NXF com '#' retorna o membro correto
  const byCode = filterMemberDirectory(directory, '#nxf101');
  assert.equal(byCode.length, 1);
  assert.equal(byCode[0].uid, 'uid_alpha_1');

  // Busca por nome completo retorna mesmo quando displayName difere
  const byFullName = filterMemberDirectory(directory, 'lucas silva');
  assert.equal(byFullName.length, 1);
  assert.equal(byFullName[0].uid, 'uid_alpha_1');

  // Busca por apelido de integrante oriundo de membership legado
  const byLegacyNick = filterMemberDirectory(directory, 'legacycap');
  assert.equal(byLegacyNick.length, 1);
  assert.equal(byLegacyNick[0].uid, 'uid_legacy_3');
});



