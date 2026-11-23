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
  getBrawlSyncStatus,
  syncBrawlStarsStats,
  testBrawlStarsApiConnection,
} from './brawlStarsService.ts';
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
