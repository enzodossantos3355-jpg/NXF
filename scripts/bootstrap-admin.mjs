/**
 * NXF eSports — Script Seguro de Provisionamento do Primeiro Administrador Principal
 *
 * Uso (local ou CI segura com credencial Firebase Admin SDK):
 *   FIREBASE_SERVICE_ACCOUNT_JSON='{"type":"service_account",...}' \
 *   node scripts/bootstrap-admin.mjs --code "#NXF001" --name "Nome Completo" --nick "FounderNXF"
 *
 * Também aceita GOOGLE_APPLICATION_CREDENTIALS ou FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY.
 *
 * Opcionalmente:
 *   --uid <FIREBASE_AUTH_UID> se o usuário já existir no Firebase Auth.
 *   BOOTSTRAP_ADMIN_PASSWORD="..." via variável de ambiente (se omitida ao criar novo usuário,
 *   uma senha temporária aleatória será gerada e exibida uma única vez no terminal).
 */

import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import admin from 'firebase-admin';

function loadAppletConfig() {
  try {
    const p = path.resolve(process.cwd(), 'firebase-applet-config.json');
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    }
  } catch {
    // ignore optional file errors
  }
  return {};
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i];
    const val = argv[i + 1];
    if (key?.startsWith('--') && val) {
      args[key.slice(2)] = val;
    }
  }
  return args;
}

function normalizePlayerCode(raw) {
  return String(raw || '')
    .trim()
    .replace(/^#+/, '')
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '');
}

function formatPlayerCode(raw) {
  const norm = normalizePlayerCode(raw);
  return norm ? `#${norm}` : '';
}

function codeToInternalAuthId(raw) {
  const norm = normalizePlayerCode(raw).toLowerCase();
  return `${norm}@auth.nxf-esports.local`;
}

function initAdminApp(appletConfig) {
  if (admin.apps.length) return admin.apps[0];

  const rawJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
  if (rawJson) {
    const jsonText = rawJson.startsWith('{')
      ? rawJson
      : Buffer.from(rawJson, 'base64').toString('utf8');
    const sa = JSON.parse(jsonText);
    return admin.initializeApp({
      credential: admin.credential.cert(sa),
      projectId: sa.project_id || process.env.FIREBASE_PROJECT_ID || appletConfig.projectId,
    });
  }

  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL?.trim();
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.trim();
  const projectId = process.env.FIREBASE_PROJECT_ID?.trim() || appletConfig.projectId;
  if (clientEmail && privateKey && projectId) {
    return admin.initializeApp({
      credential: admin.credential.cert({
        projectId,
        clientEmail,
        privateKey: privateKey.replace(/\\n/g, '\n'),
      }),
      projectId,
    });
  }

  return admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    projectId,
  });
}

async function main() {
  const appletConfig = loadAppletConfig();
  const args = parseArgs(process.argv);
  const rawCode = args.code;
  const uidArg = args.uid;
  const fullName = (args.name || 'Administrador NXF').trim().slice(0, 80);
  const nickname = (args.nick || args.nickname || 'AdminNXF').trim().slice(0, 32);
  const databaseId =
    process.env.FIREBASE_FIRESTORE_DATABASE_ID?.trim() ||
    appletConfig.firestoreDatabaseId ||
    '(default)';

  if (!rawCode && !uidArg) {
    console.error('Erro: informe --code "#SEUCODE" (ou --uid <uid>).');
    process.exit(1);
  }

  const normalizedCode = normalizePlayerCode(rawCode || 'ADMINNXF');
  if (normalizedCode.length < 3 || normalizedCode.length > 20) {
    console.error('Erro: o Code deve ter entre 3 e 20 caracteres alfanuméricos.');
    process.exit(1);
  }

  const formattedCode = formatPlayerCode(normalizedCode);
  const internalAuthId = codeToInternalAuthId(normalizedCode);

  const app = initAdminApp(appletConfig);
  const auth = admin.auth(app);
  const db =
    databaseId && databaseId !== '(default)'
      ? admin.firestore(app).databaseId
        ? admin.firestore(app)
        : admin.firestore(app)
      : admin.firestore(app);

  if (databaseId && databaseId !== '(default)') {
    db.settings({ databaseId });
  }

  let userRecord;
  if (uidArg) {
    userRecord = await auth.getUser(uidArg);
  } else {
    try {
      userRecord = await auth.getUserByEmail(internalAuthId);
    } catch {
      const initialPassword =
        process.env.BOOTSTRAP_ADMIN_PASSWORD || crypto.randomBytes(12).toString('base64url');
      userRecord = await auth.createUser({
        email: internalAuthId,
        password: initialPassword,
        displayName: nickname,
      });
      if (!process.env.BOOTSTRAP_ADMIN_PASSWORD) {
        console.log(
          `Usuário criado no Auth para Code ${formattedCode}. Senha inicial temporária (altere em Configurações): ${initialPassword}`
        );
      } else {
        console.log(`Usuário criado no Auth para Code ${formattedCode} com senha fornecida via ambiente.`);
      }
    }
  }

  const uid = userRecord.uid;
  await auth.setCustomUserClaims(uid, {
    primaryAdmin: true,
    cms: true,
    roles: ['primary_admin'],
  });

  const now = admin.firestore.FieldValue.serverTimestamp();
  const batch = db.batch();

  batch.set(
    db.doc(`admins/${uid}`),
    {
      uid,
      role: 'primary_admin',
      permissions: ['*'],
      active: true,
      grantedBy: uid,
      createdAt: now,
      updatedAt: now,
    },
    { merge: true }
  );

  batch.set(
    db.doc(`users/${uid}`),
    {
      uid,
      fullName,
      displayName: userRecord.displayName || nickname,
      code: formattedCode,
      roles: ['primary_admin'],
      delegatedPermissions: [],
      teamIds: [],
      status: 'active',
      brawlTag: formattedCode,
      brawlTagStatus: 'approved',
      authProviders: ['code_password'],
      hasLocalPassword: true,
      createdAt: now,
      updatedAt: now,
    },
    { merge: true }
  );

  batch.set(
    db.doc(`publicProfiles/${uid}`),
    {
      uid,
      nickname: userRecord.displayName || nickname,
      publicRole: 'Administração NXF',
      layout: 'classic',
      teamIds: [],
      brawlTag: formattedCode,
      brawlTagApproved: true,
      isActiveMember: true,
      showInEntrySelector: true,
      moderationStatus: 'approved',
      createdAt: now,
      updatedAt: now,
    },
    { merge: true }
  );

  const settingsRef = db.doc('systemSettings/global');
  const settingsSnap = await settingsRef.get();
  const currentCount = settingsSnap.exists ? settingsSnap.data()?.primaryAdminCount || 0 : 0;

  batch.set(
    settingsRef,
    {
      enabledModules: {
        teams: true,
        competitive: true,
        trainings: true,
        recruitment: true,
        notifications: true,
        studio: true,
        brawlApi: false,
        backups: false,
      },
      brawlApiSyncIntervalHours: 6,
      brawlApiConfigured: false,
      cloudFunctionsConfigured: false,
      primaryAdminCount: Math.max(1, currentCount),
      updatedBy: uid,
      updatedAt: now,
    },
    { merge: true }
  );

  const logId = `bootstrap_${Date.now()}`;
  batch.set(db.doc(`auditLogs/${logId}`), {
    actorUid: uid,
    actorLabel: nickname,
    action: 'BOOTSTRAP_PRIMARY_ADMIN',
    entityType: 'admins',
    entityId: uid,
    summary: `Provisionamento inicial de Administrador Principal (${formattedCode}) via Firebase Admin SDK.`,
    createdAt: now,
  });

  await batch.commit();
  console.log(`Administrador Principal provisionado com sucesso: UID=${uid} | Code=${formattedCode}`);
}

main().catch((err) => {
  console.error('Falha ao provisionar Administrador Principal:', err);
  process.exit(1);
});
