export type UserRole =
  | 'primary_admin'
  | 'delegated_admin'
  | 'manager'
  | 'coach'
  | 'player'
  | 'candidate';

export interface ServerUserPrivate {
  uid: string;
  fullName: string;
  displayName: string;
  code: string;
  roles: UserRole[];
  delegatedPermissions?: string[];
  teamIds?: string[];
  status: 'active' | 'suspended' | 'pending_verification';
  brawlTag?: string;
  brawlTagStatus?: 'none' | 'pending' | 'approved' | 'rejected';
}

export interface ServerAdminGrant {
  uid: string;
  role: 'primary_admin' | 'delegated_admin';
  permissions?: string[];
  active: boolean;
  grantedBy: string;
}

export interface ServerCapabilities {
  roles: UserRole[];
  permissions: string[];
  isPrimaryAdmin: boolean;
  isDelegatedAdmin: boolean;
  isAnyAdmin: boolean;
  isManager: boolean;
  isCoach: boolean;
  isPlayer: boolean;
  isOfficialMember: boolean;
  teamIds: string[];
  canManageOrg: boolean;
  canManageCompetitive: boolean;
  canManageTrainings: boolean;
  canManageRecruitment: boolean;
  canManageCms: boolean;
  canAccessSystem: boolean;
}

export const ROLE_LABELS: Record<UserRole, string> = {
  primary_admin: 'Administrador Principal',
  delegated_admin: 'Administrador Delegado',
  manager: 'Gerente de Equipe',
  coach: 'Técnico',
  player: 'Jogador Oficial',
  candidate: 'Candidato / Conta Básica',
};

export const VALID_ROLES = new Set<UserRole>([
  'primary_admin',
  'delegated_admin',
  'manager',
  'coach',
  'player',
  'candidate',
]);

export function normalizePlayerCode(rawCode: string): string {
  return String(rawCode || '')
    .trim()
    .replace(/^#+/, '')
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .toUpperCase();
}

export function formatPlayerCode(rawCode: string): string {
  const clean = normalizePlayerCode(rawCode);
  return clean ? `#${clean}` : '';
}

export function codeToInternalAuthId(rawCode: string): string {
  const clean = normalizePlayerCode(rawCode).toLowerCase();
  return `${clean}@auth.nxf-esports.local`;
}

export function isValidId(id: unknown): id is string {
  return typeof id === 'string' && id.length >= 1 && id.length <= 128 && /^[a-zA-Z0-9_-]+$/.test(id);
}

export function resolveServerCapabilities(
  userDoc: ServerUserPrivate | null,
  adminGrant: ServerAdminGrant | null,
  claims?: { primaryAdmin?: boolean; cms?: boolean; roles?: unknown }
): ServerCapabilities {
  const isSuspended = userDoc?.status === 'suspended';
  const roles = new Set<UserRole>(
    !isSuspended && Array.isArray(userDoc?.roles) && userDoc.roles.length > 0
      ? userDoc.roles
      : ['candidate']
  );

  if (!isSuspended) {
    if (adminGrant?.active && adminGrant.role === 'primary_admin') {
      roles.add('primary_admin');
    } else if (adminGrant?.active && adminGrant.role === 'delegated_admin') {
      roles.add('delegated_admin');
    }

    if (claims?.primaryAdmin === true && adminGrant?.active !== false) {
      roles.add('primary_admin');
    }
  }

  const perms = new Set<string>(
    !isSuspended && adminGrant?.active && Array.isArray(adminGrant.permissions)
      ? adminGrant.permissions
      : []
  );

  if (!isSuspended && claims?.cms === true && (roles.has('primary_admin') || roles.has('delegated_admin'))) {
    perms.add('cms.manage');
  }

  const isPrimaryAdmin = !isSuspended && roles.has('primary_admin');
  const isDelegatedAdmin = !isSuspended && !isPrimaryAdmin && roles.has('delegated_admin');
  const isAnyAdmin = isPrimaryAdmin || isDelegatedAdmin;
  const isManager = !isSuspended && roles.has('manager');
  const isCoach = !isSuspended && roles.has('coach');
  const isPlayer = !isSuspended && roles.has('player');
  const isOfficialMember = isAnyAdmin || isManager || isCoach || isPlayer;

  return {
    roles: Array.from(roles),
    permissions: Array.from(perms),
    isPrimaryAdmin,
    isDelegatedAdmin,
    isAnyAdmin,
    isManager,
    isCoach,
    isPlayer,
    isOfficialMember,
    teamIds: Array.isArray(userDoc?.teamIds) ? userDoc.teamIds : [],
    canManageOrg: isPrimaryAdmin || perms.has('teams.manage') || perms.has('users.manage') || isManager,
    canManageCompetitive: isPrimaryAdmin || perms.has('competitive.manage') || isManager || isCoach,
    canManageTrainings: isPrimaryAdmin || perms.has('trainings.manage') || isManager || isCoach || isPlayer,
    canManageRecruitment: isPrimaryAdmin || perms.has('recruitment.manage') || isManager || isCoach,
    canManageCms: isPrimaryAdmin || perms.has('cms.manage'),
    canAccessSystem: isPrimaryAdmin || perms.has('system.manage') || perms.has('users.read'),
  };
}
