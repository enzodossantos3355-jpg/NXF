import type { NextFunction, Request, Response } from 'express';
import type { DecodedIdToken } from 'firebase-admin/auth';
import type { Firestore } from 'firebase-admin/firestore';
import { getAdminServices } from './firebaseAdmin.ts';
import {
  resolveServerCapabilities,
  type ServerAdminGrant,
  type ServerCapabilities,
  type ServerUserPrivate,
} from './permissions.ts';

export interface AuthContext {
  uid: string;
  token: DecodedIdToken;
  userDoc: ServerUserPrivate | null;
  adminGrant: ServerAdminGrant | null;
  capabilities: ServerCapabilities;
}

export interface AuthenticatedRequest extends Request {
  authContext?: AuthContext;
}

export interface AuthDeps {
  verifyIdToken: (token: string, checkRevoked?: boolean) => Promise<DecodedIdToken>;
  db: Firestore;
}

function getDefaultAuthDeps(): AuthDeps | null {
  const { configured, auth, db } = getAdminServices();
  if (!configured || !auth || !db) return null;
  return {
    verifyIdToken: (token: string, checkRevoked = true) => auth.verifyIdToken(token, checkRevoked),
    db,
  };
}

export function extractBearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header || typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

export function createRequireAuth(resolveDeps: () => AuthDeps | null = getDefaultAuthDeps) {
  return async function requireAuth(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    const deps = resolveDeps();
    if (!deps) {
      res.status(503).json({
        ok: false,
        code: 'admin_sdk_not_configured',
        error:
          'Firebase Admin SDK não configurado no servidor. Configure FIREBASE_SERVICE_ACCOUNT_JSON ou GOOGLE_APPLICATION_CREDENTIALS.',
      });
      return;
    }

    const tokenStr = extractBearerToken(req);
    if (!tokenStr) {
      res.status(401).json({
        ok: false,
        code: 'unauthenticated',
        error: 'Token de autenticação Firebase ausente.',
      });
      return;
    }

    try {
      const decoded = await deps.verifyIdToken(tokenStr, true);
      const uid = decoded.uid;

      const [userSnap, adminSnap] = await Promise.all([
        deps.db.doc(`users/${uid}`).get(),
        deps.db.doc(`admins/${uid}`).get(),
      ]);

      const userDoc = userSnap.exists ? (userSnap.data() as ServerUserPrivate) : null;
      const adminGrant = adminSnap.exists ? (adminSnap.data() as ServerAdminGrant) : null;

      if (userDoc?.status === 'suspended') {
        res.status(403).json({
          ok: false,
          code: 'account_suspended',
          error: 'Conta suspensa pela administração da organização.',
        });
        return;
      }

      const capabilities = resolveServerCapabilities(userDoc, adminGrant, {
        primaryAdmin: decoded.primaryAdmin === true,
        cms: decoded.cms === true,
        roles: decoded.roles,
      });

      req.authContext = {
        uid,
        token: decoded,
        userDoc,
        adminGrant,
        capabilities,
      };
      next();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isCredentialError =
        msg.includes('Could not load the default credentials') ||
        msg.includes('credential') ||
        msg.includes('ENOTFOUND') ||
        msg.includes('metadata');

      if (isCredentialError) {
        res.status(503).json({
          ok: false,
          code: 'admin_sdk_credentials_unavailable',
          error:
            'Credenciais do Firebase Admin SDK indisponíveis neste ambiente. Configure FIREBASE_SERVICE_ACCOUNT_JSON ou GOOGLE_APPLICATION_CREDENTIALS.',
        });
        return;
      }

      res.status(401).json({
        ok: false,
        code: 'invalid_token',
        error: 'Sessão inválida ou expirada. Faça login novamente.',
      });
    }
  };
}

export const requireAuth = createRequireAuth();

export function requireOfficialMember(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  if (!req.authContext?.capabilities.isOfficialMember) {
    res.status(403).json({
      ok: false,
      code: 'forbidden',
      error: 'Acesso restrito a membros oficiais e administradores.',
    });
    return;
  }
  next();
}

export function requireAnyAdmin(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  if (!req.authContext?.capabilities.isAnyAdmin) {
    res.status(403).json({
      ok: false,
      code: 'forbidden',
      error: 'Acesso restrito à administração da organização.',
    });
    return;
  }
  next();
}

export function requirePrimaryAdmin(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  if (!req.authContext?.capabilities.isPrimaryAdmin) {
    res.status(403).json({
      ok: false,
      code: 'forbidden_primary_admin',
      error: 'Ação exclusiva de Administradores Principais ativos.',
    });
    return;
  }
  next();
}

export function requireCapability(
  check: (caps: ServerCapabilities) => boolean,
  errorMessage = 'Permissão insuficiente para executar esta operação.'
) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.authContext || !check(req.authContext.capabilities)) {
      res.status(403).json({
        ok: false,
        code: 'forbidden',
        error: errorMessage,
      });
      return;
    }
    next();
  };
}
