import crypto from 'node:crypto';
import express, { type Request, type Response } from 'express';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { getAdminServices } from './firebaseAdmin.ts';
import {
  requireAnyAdmin,
  requireAuth,
  requireCapability,
  requirePrimaryAdmin,
  type AuthenticatedRequest,
} from './authMiddleware.ts';
import {
  codeToInternalAuthId,
  formatPlayerCode,
  isValidId,
  normalizePlayerCode,
  ROLE_LABELS,
  VALID_ROLES,
  type ServerAdminGrant,
  type ServerUserPrivate,
  type UserRole,
} from './permissions.ts';
import {
  getBrawlSyncStatus,
  syncBrawlStarsStats,
  testBrawlStarsApiConnection,
} from './brawlStarsService.ts';
import { publishDueScheduledNews } from './newsSchedulerService.ts';
import {
  deleteMediaBlobIfAuthorized,
  extractMediaIdFromUrl,
  loadMediaBlob,
  parseAndValidateImageDataUrl,
  saveMediaBlob,
} from './mediaService.ts';
import { authenticateProfileByPassword } from './profileAuthService.ts';
import { endTeamMembership, upsertTeamMembership } from './rosterService.ts';

function timingSafeSecretEquals(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

function isLocalHostname(urlOrHost: string): boolean {
  return /(^|\/\/)(localhost|127\.0\.0\.1)(:|\/|$)/i.test(urlOrHost);
}

export function normalizePublicBaseUrl(rawBase: string, isProd = process.env.NODE_ENV === 'production'): string {
  const trimmed = rawBase.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  const withScheme = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `${isLocalHostname(trimmed) ? 'http' : 'https'}://${trimmed}`;
  if (isProd && withScheme.startsWith('http://') && !isLocalHostname(withScheme)) {
    return `https://${withScheme.slice('http://'.length)}`;
  }
  return withScheme;
}

export function buildPublicMediaUrl(req: Request, mediaId: string): string {
  const explicitBase = normalizePublicBaseUrl(process.env.PUBLIC_API_URL || '');
  if (explicitBase) {
    return `${explicitBase}/api/media/${mediaId}`;
  }
  const host = req.get('host');
  if (host) {
    const scheme =
      process.env.NODE_ENV === 'production' && !isLocalHostname(host)
        ? 'https'
        : req.protocol || 'http';
    return `${scheme}://${host}/api/media/${mediaId}`;
  }
  return `/api/media/${mediaId}`;
}

export function createApiRouter() {
  const router = express.Router();

  // ---------------------------------------------------------------------------
  // Health & Diagnostics
  // ---------------------------------------------------------------------------
  router.get('/health', (_req: Request, res: Response) => {
    const adminSvc = getAdminServices();
    res.json({
      ok: true,
      service: 'nxf-esports-api',
      adminSdkConfigured: adminSvc.configured,
      brawlTokenConfigured: Boolean(process.env.BRAWL_STARS_API_TOKEN?.trim()),
      bootstrapConfigured: Boolean(
        process.env.BOOTSTRAP_ADMIN_SECRET?.trim() &&
          process.env.BOOTSTRAP_ADMIN_SECRET.trim().length >= 12
      ),
      timestamp: new Date().toISOString(),
    });
  });

  // ---------------------------------------------------------------------------
  // Password-only Login for Selected Visible Member Profile
  // ---------------------------------------------------------------------------
  router.post('/auth/login-profile', async (req: Request, res: Response) => {
    const body = (req.body || {}) as { uid?: string; password?: string };
    const result = await authenticateProfileByPassword({
      uid: String(body.uid || ''),
      password: String(body.password || ''),
      clientIp: req.ip || req.socket.remoteAddress || 'unknown',
    });

    if (!result.ok) {
      res.status(result.status).json({ ok: false, error: result.error });
      return;
    }

    res.json({
      ok: true,
      customToken: result.customToken,
    });
  });

  // ---------------------------------------------------------------------------
  // First Primary Admin Bootstrap (Server-side secret + Single-use lock)
  // ---------------------------------------------------------------------------
  router.get('/admin/bootstrap-status', async (_req: Request, res: Response) => {
    const { configured, db } = getAdminServices();
    if (!configured || !db) {
      res.json({
        ok: true,
        needsBootstrap: false,
        adminSdkConfigured: false,
        bootstrapSecretConfigured: Boolean(
          process.env.BOOTSTRAP_ADMIN_SECRET?.trim() &&
            process.env.BOOTSTRAP_ADMIN_SECRET.trim().length >= 12
        ),
      });
      return;
    }

    try {
      const snap = await db
        .collection('admins')
        .where('role', '==', 'primary_admin')
        .where('active', '==', true)
        .limit(1)
        .get();

      res.json({
        ok: true,
        needsBootstrap: snap.empty,
        adminSdkConfigured: true,
        bootstrapSecretConfigured: Boolean(
          process.env.BOOTSTRAP_ADMIN_SECRET?.trim() &&
            process.env.BOOTSTRAP_ADMIN_SECRET.trim().length >= 12
        ),
      });
    } catch {
      res.json({
        ok: true,
        needsBootstrap: false,
        adminSdkConfigured: false,
        bootstrapSecretConfigured: Boolean(
          process.env.BOOTSTRAP_ADMIN_SECRET?.trim() &&
            process.env.BOOTSTRAP_ADMIN_SECRET.trim().length >= 12
        ),
      });
    }
  });

  router.post('/admin/bootstrap', async (req: Request, res: Response) => {
    const { configured, auth, db } = getAdminServices();
    if (!configured || !auth || !db) {
      res.status(503).json({
        ok: false,
        error:
          'Firebase Admin SDK não configurado no servidor. Configure as variáveis de ambiente no Render ou use scripts/bootstrap-admin.mjs.',
      });
      return;
    }

    const expectedSecret = process.env.BOOTSTRAP_ADMIN_SECRET?.trim() || '';
    if (expectedSecret.length < 12) {
      res.status(503).json({
        ok: false,
        error:
          'BOOTSTRAP_ADMIN_SECRET não configurado no servidor (mínimo 12 caracteres) ou desativado após provisionamento.',
      });
      return;
    }

    const body = (req.body || {}) as {
      bootstrapSecret?: string;
      fullName?: string;
      nick?: string;
      code?: string;
      password?: string;
    };

    const providedSecret = String(body.bootstrapSecret || '').trim();
    if (!providedSecret || !timingSafeSecretEquals(providedSecret, expectedSecret)) {
      res.status(403).json({
        ok: false,
        error: 'Chave de provisionamento administrativo inválida.',
      });
      return;
    }

    const existingAdmins = await db
      .collection('admins')
      .where('role', '==', 'primary_admin')
      .where('active', '==', true)
      .limit(1)
      .get();

    if (!existingAdmins.empty) {
      res.status(409).json({
        ok: false,
        error:
          'Já existe um Administrador Principal ativo. O bootstrap inicial está permanentemente bloqueado.',
      });
      return;
    }

    const normalizedCode = normalizePlayerCode(body.code || '');
    const fullName = String(body.fullName || '').trim().slice(0, 80);
    const nick = String(body.nick || '').trim().slice(0, 32);
    const password = String(body.password || '');

    if (normalizedCode.length < 3 || normalizedCode.length > 20) {
      res.status(400).json({ ok: false, error: 'Code inválido (3 a 20 caracteres).' });
      return;
    }
    if (fullName.length < 2 || nick.length < 2) {
      res.status(400).json({ ok: false, error: 'Informe Nome completo e Nick válidos.' });
      return;
    }
    if (password.length < 8) {
      res.status(400).json({
        ok: false,
        error: 'A senha do Administrador Principal deve ter no mínimo 8 caracteres.',
      });
      return;
    }

    const formattedCode = formatPlayerCode(normalizedCode);
    const internalId = codeToInternalAuthId(normalizedCode);

    try {
      let userRecord;
      try {
        userRecord = await auth.getUserByEmail(internalId);
        await auth.updateUser(userRecord.uid, {
          password,
          displayName: nick,
        });
      } catch {
        userRecord = await auth.createUser({
          email: internalId,
          password,
          displayName: nick,
        });
      }

      const uid = userRecord.uid;
      await auth.setCustomUserClaims(uid, {
        primaryAdmin: true,
        cms: true,
        roles: ['primary_admin'],
      });

      const now = FieldValue.serverTimestamp();
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
          displayName: nick,
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
          nickname: nick,
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

      batch.set(
        db.doc('systemSettings/global'),
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
          primaryAdminCount: 1,
          updatedBy: uid,
          updatedAt: now,
        },
        { merge: true }
      );

      batch.set(db.collection('auditLogs').doc(), {
        actorUid: uid,
        actorLabel: nick,
        action: 'BOOTSTRAP_PRIMARY_ADMIN',
        entityType: 'admins',
        entityId: uid,
        summary: `Primeiro Administrador Principal configurado via backend (${formattedCode}).`,
        createdAt: now,
      });

      await batch.commit();

      res.status(201).json({
        ok: true,
        uid,
        code: formattedCode,
        message: 'Primeiro Administrador Principal provisionado com segurança.',
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : 'Erro ao provisionar administrador.',
      });
    }
  });

  // ---------------------------------------------------------------------------
  // Admin User Management (Roles, Primary Admin, Brawl Tag, Credential Rotation)
  // ---------------------------------------------------------------------------
  router.post(
    '/admin/users/:uid/roles',
    requireAuth,
    requireCapability((c) => c.isPrimaryAdmin || c.permissions.includes('users.manage')),
    async (req: AuthenticatedRequest, res: Response) => {
      const targetUid = req.params.uid;
      if (!isValidId(targetUid)) {
        res.status(400).json({ ok: false, error: 'UID de destino inválido.' });
        return;
      }

      const { role, delegatedPermissions } = (req.body || {}) as {
        role?: UserRole;
        delegatedPermissions?: string[];
      };

      if (!role || !VALID_ROLES.has(role) || role === 'primary_admin') {
        res.status(400).json({
          ok: false,
          error: 'Informe um cargo válido (player, coach, manager ou delegated_admin).',
        });
        return;
      }

      if (role === 'delegated_admin' && !req.authContext!.capabilities.isPrimaryAdmin) {
        res.status(403).json({
          ok: false,
          error: 'Apenas o Administrador Principal pode conceder Administrador Delegado.',
        });
        return;
      }

      const { auth, db } = getAdminServices();
      if (!auth || !db) {
        res.status(503).json({ ok: false, error: 'Firebase Admin SDK indisponível.' });
        return;
      }

      const userRef = db.doc(`users/${targetUid}`);
      const userSnap = await userRef.get();
      if (!userSnap.exists) {
        res.status(404).json({ ok: false, error: 'Usuário não encontrado.' });
        return;
      }

      const targetUser = userSnap.data() as ServerUserPrivate;
      const nextRoles: UserRole[] =
        role === 'candidate'
          ? ['candidate']
          : Array.from(
              new Set([
                ...(Array.isArray(targetUser.roles)
                  ? targetUser.roles.filter((r) => r !== 'candidate')
                  : []),
                role,
              ])
            );

      const cleanPerms = Array.isArray(delegatedPermissions)
        ? delegatedPermissions.filter((p) => typeof p === 'string').slice(0, 20)
        : targetUser.delegatedPermissions || [];

      const now = FieldValue.serverTimestamp();
      const batch = db.batch();

      batch.update(userRef, {
        roles: nextRoles,
        delegatedPermissions: cleanPerms,
        updatedAt: now,
      });

      if (role === 'delegated_admin') {
        batch.set(
          db.doc(`admins/${targetUid}`),
          {
            uid: targetUid,
            role: 'delegated_admin',
            permissions: cleanPerms.length > 0 ? cleanPerms : ['users.read', 'teams.manage', 'recruitment.manage'],
            active: true,
            grantedBy: req.authContext!.uid,
            createdAt: now,
            updatedAt: now,
          },
          { merge: true }
        );
      }

      if (role !== 'candidate') {
        batch.set(
          db.doc(`publicProfiles/${targetUid}`),
          {
            uid: targetUid,
            nickname: targetUser.displayName,
            publicRole: ROLE_LABELS[role],
            layout: 'classic',
            teamIds: targetUser.teamIds || [],
            isActiveMember: true,
            showInEntrySelector: true,
            moderationStatus: 'approved',
            createdAt: now,
            updatedAt: now,
          },
          { merge: true }
        );
      }

      batch.set(db.collection('auditLogs').doc(), {
        actorUid: req.authContext!.uid,
        actorLabel: req.authContext!.userDoc?.displayName || req.authContext!.uid,
        action: 'ASSIGN_ROLE',
        entityType: 'users',
        entityId: targetUid,
        summary: `Cargo ${role} atribuído a ${targetUser.displayName}.`,
        createdAt: now,
      });

      await batch.commit();

      const hasPrimary = nextRoles.includes('primary_admin');
      const hasCms = hasPrimary || cleanPerms.includes('cms.manage');
      await auth.setCustomUserClaims(targetUid, {
        primaryAdmin: hasPrimary,
        cms: hasCms,
        roles: nextRoles,
      });

      res.json({ ok: true, roles: nextRoles });
    }
  );

  router.post(
    '/admin/users/:uid/primary-admin',
    requireAuth,
    requirePrimaryAdmin,
    async (req: AuthenticatedRequest, res: Response) => {
      const targetUid = req.params.uid;
      if (!isValidId(targetUid)) {
        res.status(400).json({ ok: false, error: 'UID de destino inválido.' });
        return;
      }

      const { action } = (req.body || {}) as { action?: 'promote' | 'revoke' };
      if (action !== 'promote' && action !== 'revoke') {
        res.status(400).json({ ok: false, error: 'Ação inválida. Use promote ou revoke.' });
        return;
      }

      const { auth, db } = getAdminServices();
      if (!auth || !db) {
        res.status(503).json({ ok: false, error: 'Firebase Admin SDK indisponível.' });
        return;
      }

      try {
        let updatedRoles: UserRole[] = [];
        let targetDisplayName = targetUid;

        await db.runTransaction(async (tx) => {
          const activePrimariesSnap = await tx.get(
            db.collection('admins').where('role', '==', 'primary_admin').where('active', '==', true)
          );
          const activePrimaryCount = activePrimariesSnap.size;

          const userRef = db.doc(`users/${targetUid}`);
          const userSnap = await tx.get(userRef);
          if (!userSnap.exists) {
            throw new Error('NOT_FOUND:Usuário não encontrado.');
          }
          const targetUser = userSnap.data() as ServerUserPrivate;
          targetDisplayName = targetUser.displayName || targetUid;

          const targetAdminRef = db.doc(`admins/${targetUid}`);
          const targetAdminSnap = await tx.get(targetAdminRef);
          const isCurrentlyActivePrimary =
            targetAdminSnap.exists &&
            (targetAdminSnap.data() as ServerAdminGrant).role === 'primary_admin' &&
            (targetAdminSnap.data() as ServerAdminGrant).active === true;

          if (action === 'revoke') {
            if (isCurrentlyActivePrimary && activePrimaryCount <= 1) {
              throw new Error(
                'LAST_PRIMARY:Bloqueado: não é permitido remover o último Administrador Principal ativo.'
              );
            }
          }

          const now = FieldValue.serverTimestamp();
          if (action === 'promote') {
            updatedRoles = Array.from(
              new Set([
                ...(Array.isArray(targetUser.roles)
                  ? targetUser.roles.filter((r) => r !== 'candidate')
                  : []),
                'primary_admin',
              ])
            );
            tx.set(
              targetAdminRef,
              {
                uid: targetUid,
                role: 'primary_admin',
                permissions: ['*'],
                active: true,
                grantedBy: req.authContext!.uid,
                createdAt: targetAdminSnap.exists ? targetAdminSnap.data()?.createdAt || now : now,
                updatedAt: now,
              },
              { merge: true }
            );
            tx.update(userRef, { roles: updatedRoles, updatedAt: now });
            tx.set(
              db.doc(`publicProfiles/${targetUid}`),
              {
                uid: targetUid,
                nickname: targetDisplayName,
                publicRole: ROLE_LABELS.primary_admin,
                layout: 'classic',
                isActiveMember: true,
                showInEntrySelector: true,
                moderationStatus: 'approved',
                createdAt: now,
                updatedAt: now,
              },
              { merge: true }
            );
          } else {
            updatedRoles = (Array.isArray(targetUser.roles) ? targetUser.roles : []).filter(
              (r) => r !== 'primary_admin'
            );
            if (updatedRoles.length === 0) {
              updatedRoles = ['candidate'];
            }
            tx.set(
              targetAdminRef,
              {
                active: false,
                updatedAt: now,
              },
              { merge: true }
            );
            tx.update(userRef, { roles: updatedRoles, updatedAt: now });
          }

          const nextCount =
            action === 'promote'
              ? isCurrentlyActivePrimary
                ? activePrimaryCount
                : activePrimaryCount + 1
              : Math.max(1, activePrimaryCount - (isCurrentlyActivePrimary ? 1 : 0));

          tx.set(
            db.doc('systemSettings/global'),
            {
              primaryAdminCount: nextCount,
              updatedBy: req.authContext!.uid,
              updatedAt: now,
            },
            { merge: true }
          );

          tx.set(db.collection('auditLogs').doc(), {
            actorUid: req.authContext!.uid,
            actorLabel: req.authContext!.userDoc?.displayName || req.authContext!.uid,
            action: action === 'promote' ? 'PROMOTE_PRIMARY_ADMIN' : 'REVOKE_PRIMARY_ADMIN',
            entityType: 'admins',
            entityId: targetUid,
            summary: `${action === 'promote' ? 'Promoção' : 'Revogação'} de Administrador Principal para ${targetDisplayName}.`,
            createdAt: now,
          });
        });

        const hasPrimary = updatedRoles.includes('primary_admin');
        await auth.setCustomUserClaims(targetUid, {
          primaryAdmin: hasPrimary,
          cms: hasPrimary,
          roles: updatedRoles,
        });
        if (action === 'revoke') {
          await auth.revokeRefreshTokens(targetUid);
        }

        res.json({ ok: true, roles: updatedRoles });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.startsWith('LAST_PRIMARY:')) {
          res.status(409).json({ ok: false, error: msg.slice('LAST_PRIMARY:'.length) });
          return;
        }
        if (msg.startsWith('NOT_FOUND:')) {
          res.status(404).json({ ok: false, error: msg.slice('NOT_FOUND:'.length) });
          return;
        }
        res.status(500).json({ ok: false, error: msg });
      }
    }
  );

  router.post(
    '/admin/users/:uid/brawl-tag',
    requireAuth,
    requireCapability((c) => c.isPrimaryAdmin || c.permissions.includes('users.manage')),
    async (req: AuthenticatedRequest, res: Response) => {
      const targetUid = req.params.uid;
      if (!isValidId(targetUid)) {
        res.status(400).json({ ok: false, error: 'UID inválido.' });
        return;
      }

      const { approved } = (req.body || {}) as { approved?: boolean };
      if (typeof approved !== 'boolean') {
        res.status(400).json({ ok: false, error: 'Informe approved: boolean.' });
        return;
      }

      const { db } = getAdminServices();
      if (!db) {
        res.status(503).json({ ok: false, error: 'Firebase Admin SDK indisponível.' });
        return;
      }

      const userRef = db.doc(`users/${targetUid}`);
      const userSnap = await userRef.get();
      if (!userSnap.exists) {
        res.status(404).json({ ok: false, error: 'Usuário não encontrado.' });
        return;
      }
      const userData = userSnap.data() as ServerUserPrivate;

      const now = FieldValue.serverTimestamp();
      const batch = db.batch();
      batch.update(userRef, {
        brawlTagStatus: approved ? 'approved' : 'rejected',
        updatedAt: now,
      });

      const pubRef = db.doc(`publicProfiles/${targetUid}`);
      const pubSnap = await pubRef.get();
      if (pubSnap.exists) {
        batch.update(pubRef, {
          brawlTag: userData.brawlTag || '',
          brawlTagApproved: approved,
          updatedAt: now,
        });
      }

      batch.set(db.collection('auditLogs').doc(), {
        actorUid: req.authContext!.uid,
        actorLabel: req.authContext!.userDoc?.displayName || req.authContext!.uid,
        action: approved ? 'APPROVE_BRAWL_TAG' : 'REJECT_BRAWL_TAG',
        entityType: 'users',
        entityId: targetUid,
        summary: `Brawl Tag ${userData.brawlTag || '—'} de ${userData.displayName} ${approved ? 'aprovada' : 'rejeitada'}.`,
        createdAt: now,
      });

      await batch.commit();
      res.json({ ok: true, approved });
    }
  );

  router.post(
    '/admin/users/:uid/rotate-password',
    requireAuth,
    requirePrimaryAdmin,
    async (req: AuthenticatedRequest, res: Response) => {
      const targetUid = req.params.uid;
      if (!isValidId(targetUid)) {
        res.status(400).json({ ok: false, error: 'UID inválido.' });
        return;
      }

      const { newPassword } = (req.body || {}) as { newPassword?: string };
      const finalPassword =
        typeof newPassword === 'string' && newPassword.trim().length > 0
          ? newPassword.trim()
          : crypto.randomBytes(12).toString('base64url');

      if (finalPassword.length < 8) {
        res.status(400).json({
          ok: false,
          error: 'A nova senha rotacionada deve possuir no mínimo 8 caracteres.',
        });
        return;
      }

      const { auth, db } = getAdminServices();
      if (!auth || !db) {
        res.status(503).json({ ok: false, error: 'Firebase Admin SDK indisponível.' });
        return;
      }

      try {
        await auth.updateUser(targetUid, { password: finalPassword });
        await auth.revokeRefreshTokens(targetUid);
        await db.collection('auditLogs').add({
          actorUid: req.authContext!.uid,
          actorLabel: req.authContext!.userDoc?.displayName || req.authContext!.uid,
          action: 'ROTATE_USER_CREDENTIALS',
          entityType: 'users',
          entityId: targetUid,
          summary: `Credencial rotacionada e sessões anteriores revogadas para UID ${targetUid}.`,
          createdAt: FieldValue.serverTimestamp(),
        });

        res.json({
          ok: true,
          generatedPassword: newPassword ? undefined : finalPassword,
          message: 'Senha atualizada e tokens de atualização revogados.',
        });
      } catch (err) {
        res.status(500).json({
          ok: false,
          error: err instanceof Error ? err.message : 'Erro ao rotacionar senha.',
        });
      }
    }
  );

  router.post(
    '/admin/settings',
    requireAuth,
    requirePrimaryAdmin,
    async (req: AuthenticatedRequest, res: Response) => {
      const { db } = getAdminServices();
      if (!db) {
        res.status(503).json({ ok: false, error: 'Firebase Admin SDK indisponível.' });
        return;
      }

      const body = (req.body || {}) as {
        enabledModules?: Record<string, boolean>;
        brawlApiSyncIntervalHours?: number;
      };

      const updatePayload: Record<string, unknown> = {
        updatedBy: req.authContext!.uid,
        updatedAt: FieldValue.serverTimestamp(),
      };

      if (body.enabledModules && typeof body.enabledModules === 'object') {
        updatePayload.enabledModules = body.enabledModules;
      }
      if (typeof body.brawlApiSyncIntervalHours === 'number') {
        updatePayload.brawlApiSyncIntervalHours = Math.max(
          1,
          Math.min(168, Math.round(body.brawlApiSyncIntervalHours))
        );
      }

      await db.doc('systemSettings/global').set(updatePayload, { merge: true });
      await db.collection('auditLogs').add({
        actorUid: req.authContext!.uid,
        actorLabel: req.authContext!.userDoc?.displayName || req.authContext!.uid,
        action: 'UPDATE_SYSTEM_SETTINGS',
        entityType: 'systemSettings',
        entityId: 'global',
        summary: 'Configurações globais da plataforma atualizadas.',
        createdAt: FieldValue.serverTimestamp(),
      });

      res.json({ ok: true });
    }
  );

  router.get(
    '/admin/audit-export',
    requireAuth,
    requireCapability((c) => c.isPrimaryAdmin || c.canAccessSystem),
    async (req: AuthenticatedRequest, res: Response) => {
      const { db } = getAdminServices();
      if (!db) {
        res.status(503).json({ ok: false, error: 'Firebase Admin SDK indisponível.' });
        return;
      }

      const snap = await db
        .collection('auditLogs')
        .orderBy('createdAt', 'desc')
        .limit(200)
        .get();

      const logs = snap.docs.map((d) => ({
        id: d.id,
        ...d.data(),
      }));

      await db.collection('auditLogs').add({
        actorUid: req.authContext!.uid,
        actorLabel: req.authContext!.userDoc?.displayName || req.authContext!.uid,
        action: 'EXPORT_AUDIT_LOGS',
        entityType: 'auditLogs',
        entityId: 'export',
        summary: `Exportação JSON de ${logs.length} eventos de auditoria.`,
        createdAt: FieldValue.serverTimestamp(),
      });

      res.json({
        ok: true,
        exportedAt: new Date().toISOString(),
        exportedBy: req.authContext!.uid,
        count: logs.length,
        auditLogs: logs,
      });
    }
  );

  // ---------------------------------------------------------------------------
  // Invitations (Creation + Self-Inspection + Atomic Acceptance)
  // ---------------------------------------------------------------------------
  router.post(
    '/invitations',
    requireAuth,
    requireCapability((c) => c.isAnyAdmin || c.permissions.includes('users.invite')),
    async (req: AuthenticatedRequest, res: Response) => {
      const { db } = getAdminServices();
      if (!db) {
        res.status(503).json({ ok: false, error: 'Firebase Admin SDK indisponível.' });
        return;
      }

      const body = (req.body || {}) as {
        targetCode?: string;
        assignedRoles?: UserRole[];
        teamId?: string;
        roleInTeam?: 'manager' | 'coach' | 'starter' | 'reserve' | 'analyst' | 'none';
        expiresHours?: number;
      };

      const formattedCode = formatPlayerCode(body.targetCode || '');
      if (formattedCode.length < 4) {
        res.status(400).json({ ok: false, error: 'Informe um Code válido (ex.: #ABC1234).' });
        return;
      }

      const safeRoles = Array.isArray(body.assignedRoles)
        ? body.assignedRoles.filter(
            (r): r is UserRole =>
              VALID_ROLES.has(r) &&
              r !== 'primary_admin' &&
              (r !== 'delegated_admin' || req.authContext!.capabilities.isPrimaryAdmin)
          )
        : [];

      if (safeRoles.length === 0) {
        res.status(400).json({ ok: false, error: 'Selecione ao menos um cargo válido.' });
        return;
      }

      const teamId = body.teamId && isValidId(body.teamId) ? body.teamId : '';
      const roleInTeam = teamId ? body.roleInTeam || 'starter' : 'none';
      const hours = Math.max(1, Math.min(336, Number(body.expiresHours || 72)));
      const expiresAt = Timestamp.fromDate(new Date(Date.now() + hours * 3600 * 1000));

      const now = FieldValue.serverTimestamp();
      const invRef = db.collection('invitations').doc();
      await invRef.set({
        targetCode: formattedCode,
        assignedRoles: safeRoles,
        teamId,
        roleInTeam,
        status: 'pending',
        expiresAt,
        createdBy: req.authContext!.uid,
        createdAt: now,
      });

      await db.collection('auditLogs').add({
        actorUid: req.authContext!.uid,
        actorLabel: req.authContext!.userDoc?.displayName || req.authContext!.uid,
        action: 'CREATE_INVITATION',
        entityType: 'invitations',
        entityId: invRef.id,
        summary: `Convite emitido para ${formattedCode} (${safeRoles.join(', ')}).`,
        createdAt: now,
      });

      res.status(201).json({
        ok: true,
        id: invRef.id,
        targetCode: formattedCode,
      });
    }
  );

  router.get(
    '/invitations/mine',
    requireAuth,
    async (req: AuthenticatedRequest, res: Response) => {
      const { db } = getAdminServices();
      if (!db) {
        res.status(503).json({ ok: false, error: 'Firebase Admin SDK indisponível.' });
        return;
      }

      const userCode = formatPlayerCode(req.authContext!.userDoc?.code || '');
      if (!userCode) {
        res.json({ ok: true, invitations: [] });
        return;
      }

      const snap = await db
        .collection('invitations')
        .where('targetCode', '==', userCode)
        .where('status', '==', 'pending')
        .limit(20)
        .get();

      const nowMs = Date.now();
      const invitations = snap.docs
        .map((d) => {
          const data = d.data();
          const expMs =
            data.expiresAt && typeof data.expiresAt.toMillis === 'function'
              ? data.expiresAt.toMillis()
              : 0;
          return {
            id: d.id,
            targetCode: data.targetCode,
            assignedRoles: data.assignedRoles || [],
            teamId: data.teamId || '',
            roleInTeam: data.roleInTeam || 'none',
            status: data.status,
            expiresAtIso: expMs ? new Date(expMs).toISOString() : null,
            expired: expMs > 0 && expMs < nowMs,
          };
        })
        .filter((inv) => !inv.expired);

      res.json({ ok: true, invitations });
    }
  );

  router.post(
    '/invitations/:id/accept',
    requireAuth,
    async (req: AuthenticatedRequest, res: Response) => {
      const invitationId = req.params.id;
      if (!isValidId(invitationId)) {
        res.status(400).json({ ok: false, error: 'ID do convite inválido.' });
        return;
      }

      const { auth, db } = getAdminServices();
      if (!auth || !db) {
        res.status(503).json({ ok: false, error: 'Firebase Admin SDK indisponível.' });
        return;
      }

      const uid = req.authContext!.uid;
      const invRef = db.doc(`invitations/${invitationId}`);

      try {
        let mergedRoles: UserRole[] = [];
        await db.runTransaction(async (tx) => {
          const invSnap = await tx.get(invRef);
          if (!invSnap.exists) {
            throw new Error('NOT_FOUND:Convite não encontrado.');
          }

          const inv = invSnap.data()!;
          if (inv.status !== 'pending') {
            throw new Error('PRECONDITION:Este convite já foi utilizado ou revogado.');
          }
          if (inv.expiresAt?.toMillis && inv.expiresAt.toMillis() < Date.now()) {
            tx.update(invRef, { status: 'expired' });
            throw new Error('EXPIRED:Convite expirado.');
          }

          const userRef = db.doc(`users/${uid}`);
          const userSnap = await tx.get(userRef);
          const userData = (userSnap.exists ? userSnap.data() : {}) as Partial<ServerUserPrivate>;

          const expectedCode = normalizePlayerCode(String(inv.targetCode || ''));
          const actualCode = normalizePlayerCode(String(userData.code || userData.brawlTag || ''));
          if (!expectedCode || expectedCode !== actualCode) {
            throw new Error('FORBIDDEN:Este convite foi emitido para outro Code.');
          }

          const existingRoles: UserRole[] = Array.isArray(userData.roles)
            ? userData.roles
            : ['candidate'];
          const assignedRoles: UserRole[] = Array.isArray(inv.assignedRoles)
            ? inv.assignedRoles.filter((r: UserRole) => r !== 'primary_admin')
            : [];

          mergedRoles = Array.from(
            new Set([...existingRoles.filter((r) => r !== 'candidate'), ...assignedRoles])
          );
          if (mergedRoles.length === 0) mergedRoles = ['player'];

          const existingTeams: string[] = Array.isArray(userData.teamIds) ? userData.teamIds : [];
          const mergedTeams = inv.teamId
            ? Array.from(new Set([...existingTeams, String(inv.teamId)]))
            : existingTeams;

          const nick = String(userData.displayName || 'Membro NXF');
          const fullName = String(userData.fullName || nick);
          const formattedCode = `#${actualCode}`;
          const now = FieldValue.serverTimestamp();

          tx.update(invRef, { status: 'accepted', acceptedBy: uid });
          tx.set(
            userRef,
            {
              uid,
              fullName,
              displayName: nick,
              code: formattedCode,
              roles: mergedRoles,
              teamIds: mergedTeams,
              status: 'active',
              updatedAt: now,
            },
            { merge: true }
          );

          if (inv.teamId && inv.roleInTeam && inv.roleInTeam !== 'none') {
            tx.set(db.doc(`teamMemberships/${inv.teamId}_${uid}`), {
              teamId: inv.teamId,
              uid,
              nickname: nick,
              roleInTeam: inv.roleInTeam,
              status: 'active',
              joinedAt: now,
            });
          }

          tx.set(
            db.doc(`publicProfiles/${uid}`),
            {
              uid,
              nickname: nick,
              publicRole:
                inv.roleInTeam && inv.roleInTeam !== 'none'
                  ? String(inv.roleInTeam)
                  : 'Membro Oficial',
              layout: 'classic',
              teamIds: mergedTeams,
              isActiveMember: true,
              showInEntrySelector: true,
              moderationStatus: 'approved',
              createdAt: now,
              updatedAt: now,
            },
            { merge: true }
          );

          tx.set(db.collection('auditLogs').doc(), {
            actorUid: uid,
            actorLabel: nick,
            action: 'ACCEPT_INVITATION',
            entityType: 'invitations',
            entityId: invitationId,
            summary: `Convite aceito por ${nick} (${formattedCode}) com cargos ${mergedRoles.join(', ')}.`,
            createdAt: now,
          });
        });

        await auth.setCustomUserClaims(uid, {
          primaryAdmin: mergedRoles.includes('primary_admin'),
          cms: mergedRoles.includes('primary_admin'),
          roles: mergedRoles,
        });

        res.json({ ok: true, roles: mergedRoles });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.startsWith('NOT_FOUND:')) {
          res.status(404).json({ ok: false, error: msg.slice('NOT_FOUND:'.length) });
          return;
        }
        if (msg.startsWith('FORBIDDEN:')) {
          res.status(403).json({ ok: false, error: msg.slice('FORBIDDEN:'.length) });
          return;
        }
        if (msg.startsWith('PRECONDITION:') || msg.startsWith('EXPIRED:')) {
          res.status(400).json({ ok: false, error: msg.split(':').slice(1).join(':') });
          return;
        }
        res.status(500).json({ ok: false, error: msg });
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Team Roster Memberships (Transactional + Atomic users.teamIds Sync)
  // ---------------------------------------------------------------------------
  router.post(
    '/teams/:teamId/memberships',
    requireAuth,
    requireCapability((c) => c.canManageOrg),
    async (req: AuthenticatedRequest, res: Response) => {
      const { db } = getAdminServices();
      if (!db) {
        res.status(503).json({ ok: false, error: 'Firebase Admin SDK indisponível.' });
        return;
      }

      const body = (req.body || {}) as {
        uid?: string;
        nickname?: string;
        roleInTeam?: string;
      };

      const result = await upsertTeamMembership(
        db,
        {
          uid: req.authContext!.uid,
          displayName: req.authContext!.userDoc?.displayName || req.authContext!.uid,
          capabilities: req.authContext!.capabilities,
        },
        {
          teamId: req.params.teamId,
          targetUid: String(body.uid || ''),
          nickname: String(body.nickname || ''),
          roleInTeam: String(body.roleInTeam || ''),
        }
      );

      if (!result.ok) {
        res.status(result.status).json({ ok: false, error: result.error });
        return;
      }

      res.status(200).json({
        ok: true,
        membershipId: result.membershipId,
        teamId: result.teamId,
        uid: result.uid,
        teamIds: result.teamIds,
      });
    }
  );

  router.post(
    '/teams/:teamId/memberships/:targetUid/end',
    requireAuth,
    requireCapability((c) => c.canManageOrg),
    async (req: AuthenticatedRequest, res: Response) => {
      const { db } = getAdminServices();
      if (!db) {
        res.status(503).json({ ok: false, error: 'Firebase Admin SDK indisponível.' });
        return;
      }

      const result = await endTeamMembership(
        db,
        {
          uid: req.authContext!.uid,
          displayName: req.authContext!.userDoc?.displayName || req.authContext!.uid,
          capabilities: req.authContext!.capabilities,
        },
        {
          teamId: req.params.teamId,
          targetUid: req.params.targetUid,
        }
      );

      if (!result.ok) {
        res.status(result.status).json({ ok: false, error: result.error });
        return;
      }

      res.status(200).json({
        ok: true,
        membershipId: result.membershipId,
        teamId: result.teamId,
        uid: result.uid,
        teamIds: result.teamIds,
      });
    }
  );

  // ---------------------------------------------------------------------------
  // Notifications (Backend-dispatched)
  // ---------------------------------------------------------------------------
  router.post(
    '/notifications/send',
    requireAuth,
    requireCapability((c) => c.isAnyAdmin || c.isManager || c.isCoach),
    async (req: AuthenticatedRequest, res: Response) => {
      const { db } = getAdminServices();
      if (!db) {
        res.status(503).json({ ok: false, error: 'Firebase Admin SDK indisponível.' });
        return;
      }

      const body = (req.body || {}) as {
        recipientUid?: string;
        title?: string;
        body?: string;
        category?: 'system' | 'training' | 'match' | 'recruitment' | 'admin';
        targetRoute?: string;
      };

      const recipientUid = String(body.recipientUid || '').trim();
      const title = String(body.title || '').trim().slice(0, 120);
      const msgBody = String(body.body || '').trim().slice(0, 500);
      const category = body.category || 'system';

      if (!isValidId(recipientUid) || title.length < 1 || msgBody.length < 1) {
        res.status(400).json({ ok: false, error: 'Dados da notificação inválidos.' });
        return;
      }

      const now = FieldValue.serverTimestamp();
      const notifRef = db.collection('notifications').doc();
      await notifRef.set({
        recipientUid,
        title,
        body: msgBody,
        category,
        ...(body.targetRoute ? { targetRoute: String(body.targetRoute).slice(0, 200) } : {}),
        read: false,
        createdAt: now,
      });

      await db.collection('auditLogs').add({
        actorUid: req.authContext!.uid,
        actorLabel: req.authContext!.userDoc?.displayName || req.authContext!.uid,
        action: 'SEND_NOTIFICATION',
        entityType: 'notifications',
        entityId: notifRef.id,
        summary: `Notificação "${title}" enviada para ${recipientUid}.`,
        createdAt: now,
      });

      res.status(201).json({ ok: true, id: notifRef.id });
    }
  );

  // ---------------------------------------------------------------------------
  // Brawl Stars API (Render Starter Backend + 6h Scheduler)
  // ---------------------------------------------------------------------------
  router.get(
    '/brawl/status',
    requireAuth,
    async (_req: AuthenticatedRequest, res: Response) => {
      const status = await getBrawlSyncStatus();
      res.json({ ok: true, ...status });
    }
  );

  router.post(
    '/brawl/sync',
    requireAuth,
    requireCapability((c) => c.isAnyAdmin || c.canAccessSystem),
    async (req: AuthenticatedRequest, res: Response) => {
      const result = await syncBrawlStarsStats({
        force: true,
        triggeredBy: req.authContext!.uid,
      });

      const { db } = getAdminServices();
      if (db) {
        await db.collection('auditLogs').add({
          actorUid: req.authContext!.uid,
          actorLabel: req.authContext!.userDoc?.displayName || req.authContext!.uid,
          action: 'SYNC_BRAWL_STARS',
          entityType: 'systemJobs',
          entityId: 'brawlStarsSync',
          summary: `Sincronização manual Brawl Stars: ok=${result.ok}, atualizados=${result.syncedCount}, erros=${result.errorCount}.`,
          createdAt: FieldValue.serverTimestamp(),
        });
      }

      res.json(result);
    }
  );

  router.post(
    '/brawl/test-tag',
    requireAuth,
    requirePrimaryAdmin,
    async (req: AuthenticatedRequest, res: Response) => {
      const { tag } = (req.body || {}) as { tag?: string };
      const result = await testBrawlStarsApiConnection(String(tag || ''));

      const { db } = getAdminServices();
      if (db) {
        await db.collection('auditLogs').add({
          actorUid: req.authContext!.uid,
          actorLabel: req.authContext!.userDoc?.displayName || req.authContext!.uid,
          action: 'TEST_BRAWL_STARS_API',
          entityType: 'systemSettings',
          entityId: 'global',
          summary: `Teste de conectividade Brawl Stars (${String(tag || '')}): HTTP ${result.httpStatus ?? 'N/A'}, configurada=${result.brawlApiConfigured}.`,
          createdAt: FieldValue.serverTimestamp(),
        });
      }

      res.json(result);
    }
  );

  // ---------------------------------------------------------------------------
  // CMS Scheduled News Manual Trigger
  // ---------------------------------------------------------------------------
  router.post(
    '/cms/publish-scheduled',
    requireAuth,
    requireCapability((c) => c.isPrimaryAdmin || c.canManageCms),
    async (req: AuthenticatedRequest, res: Response) => {
      const result = await publishDueScheduledNews(req.authContext!.uid);
      res.json(result);
    }
  );

  // ---------------------------------------------------------------------------
  // Spark-Compatible Media Uploads & Serving
  // ---------------------------------------------------------------------------
  router.post(
    '/uploads/profile',
    requireAuth,
    async (req: AuthenticatedRequest, res: Response) => {
      const { db } = getAdminServices();
      if (!db) {
        res.status(503).json({ ok: false, error: 'Firebase Admin SDK indisponível.' });
        return;
      }

      try {
        const body = (req.body || {}) as {
          dataUrl?: string;
          fileName?: string;
          kind?: 'avatar' | 'banner';
          replaceMediaUrl?: string;
        };
        const parsed = parseAndValidateImageDataUrl(body.dataUrl);
        const saved = await saveMediaBlob(db, {
          scope: 'profile',
          folder: body.kind === 'banner' ? 'banner' : 'avatar',
          fileName: String(body.fileName || 'perfil'),
          uploadedBy: req.authContext!.uid,
          parsed,
        });

        const oldMediaId = extractMediaIdFromUrl(body.replaceMediaUrl);
        if (oldMediaId && oldMediaId !== saved.id) {
          await deleteMediaBlobIfAuthorized(db, oldMediaId, {
            uid: req.authContext!.uid,
            allowAny: false,
          }).catch(() => undefined);
        }

        res.status(201).json({
          ok: true,
          id: saved.id,
          url: buildPublicMediaUrl(req, saved.id),
          storagePath: saved.storagePath,
          mimeType: saved.mimeType,
          sizeBytes: saved.sizeBytes,
        });
      } catch (err) {
        res.status(400).json({
          ok: false,
          error: err instanceof Error ? err.message : 'Falha ao validar imagem.',
        });
      }
    }
  );

  router.post(
    '/uploads/cms',
    requireAuth,
    requireCapability(
      (c) => c.isPrimaryAdmin || c.canManageCms,
      'Upload de mídia institucional restrito a gestores de conteúdo (CMS) e Administração Principal.'
    ),
    async (req: AuthenticatedRequest, res: Response) => {
      const { db } = getAdminServices();
      if (!db) {
        res.status(503).json({ ok: false, error: 'Firebase Admin SDK indisponível.' });
        return;
      }

      try {
        const body = (req.body || {}) as {
          dataUrl?: string;
          fileName?: string;
          folder?: string;
          replaceMediaUrl?: string;
        };
        const parsed = parseAndValidateImageDataUrl(body.dataUrl);
        const saved = await saveMediaBlob(db, {
          scope: 'cms',
          folder: String(body.folder || 'geral'),
          fileName: String(body.fileName || 'cms-asset'),
          uploadedBy: req.authContext!.uid,
          parsed,
        });

        const oldMediaId = extractMediaIdFromUrl(body.replaceMediaUrl);
        if (oldMediaId && oldMediaId !== saved.id) {
          await deleteMediaBlobIfAuthorized(db, oldMediaId, {
            uid: req.authContext!.uid,
            allowAny:
              req.authContext!.capabilities.isPrimaryAdmin ||
              req.authContext!.capabilities.canManageCms,
          }).catch(() => undefined);
        }

        const url = buildPublicMediaUrl(req, saved.id);
        const now = FieldValue.serverTimestamp();
        await db.collection('media').add({
          title: String(body.fileName || saved.id).slice(0, 100),
          url,
          storagePath: saved.storagePath,
          mimeType: saved.mimeType,
          sizeBytes: saved.sizeBytes,
          uploadedBy: req.authContext!.uid,
          createdAt: now,
        });

        res.status(201).json({
          ok: true,
          id: saved.id,
          url,
          storagePath: saved.storagePath,
          mimeType: saved.mimeType,
          sizeBytes: saved.sizeBytes,
        });
      } catch (err) {
        res.status(400).json({
          ok: false,
          error: err instanceof Error ? err.message : 'Falha ao enviar mídia CMS.',
        });
      }
    }
  );

  router.delete(
    '/media/:id',
    requireAuth,
    async (req: AuthenticatedRequest, res: Response) => {
      const { db } = getAdminServices();
      if (!db) {
        res.status(503).json({ ok: false, error: 'Firebase Admin SDK indisponível.' });
        return;
      }

      const result = await deleteMediaBlobIfAuthorized(db, req.params.id, {
        uid: req.authContext!.uid,
        allowAny:
          req.authContext!.capabilities.isPrimaryAdmin ||
          req.authContext!.capabilities.canManageCms,
      });

      if (!result.ok) {
        const msg =
          result.status === 400
            ? 'ID de mídia inválido.'
            : result.status === 403
              ? 'Sem permissão para remover esta mídia.'
              : 'Mídia não encontrada.';
        res.status(result.status).json({ ok: false, error: msg });
        return;
      }

      res.json({ ok: true, id: req.params.id });
    }
  );

  router.get('/media/:id', async (req: Request, res: Response) => {
    const { db } = getAdminServices();
    if (!db) {
      res.status(503).end();
      return;
    }

    const blob = await loadMediaBlob(db, req.params.id);
    if (!blob) {
      res.status(404).json({ ok: false, error: 'Mídia não encontrada.' });
      return;
    }

    const etag = `"${req.params.id}"`;
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    const ifNoneMatch = req.headers['if-none-match'];
    if (typeof ifNoneMatch === 'string' && ifNoneMatch.split(',').some((t) => t.trim() === etag)) {
      res.status(304).end();
      return;
    }

    res.setHeader('Content-Type', blob.mimeType);
    res.send(blob.buffer);
  });

  return router;
}
