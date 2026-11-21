import type { AdminGrant, UserPrivate, UserRole } from '../types/nxf';

export const ROLE_LABELS: Record<UserRole, string> = {
  primary_admin: 'Administrador Principal',
  delegated_admin: 'Administrador Delegado',
  manager: 'Gerente de Equipe',
  coach: 'Técnico',
  player: 'Jogador Oficial',
  candidate: 'Candidato / Conta Básica',
};

export interface UnifiedCapabilities {
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

export function resolveUnifiedCapabilities(
  userDoc: UserPrivate | null,
  adminGrant: AdminGrant | null,
  tokenClaims?: { primaryAdmin?: boolean; cms?: boolean }
): UnifiedCapabilities {
  const isSuspended = userDoc?.status === 'suspended';
  const roles = new Set<UserRole>(
    !isSuspended && userDoc?.roles?.length ? userDoc.roles : ['candidate']
  );

  if (!isSuspended) {
    if (adminGrant?.active && adminGrant.role === 'primary_admin') {
      roles.add('primary_admin');
    }
    if (adminGrant?.active && adminGrant.role === 'delegated_admin') {
      roles.add('delegated_admin');
    }
    if (tokenClaims?.primaryAdmin === true && adminGrant?.active !== false) {
      roles.add('primary_admin');
    }
  }

  const perms = new Set<string>(
    !isSuspended && adminGrant?.active ? adminGrant.permissions || [] : []
  );

  if (!isSuspended && tokenClaims?.cms === true && (roles.has('primary_admin') || roles.has('delegated_admin'))) {
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
    teamIds: !isSuspended ? userDoc?.teamIds || [] : [],
    canManageOrg: isPrimaryAdmin || perms.has('teams.manage') || perms.has('users.manage') || isManager,
    canManageCompetitive: isPrimaryAdmin || perms.has('competitive.manage') || isManager || isCoach,
    canManageTrainings: isPrimaryAdmin || perms.has('trainings.manage') || isManager || isCoach || isPlayer,
    canManageRecruitment: isPrimaryAdmin || perms.has('recruitment.manage') || isManager || isCoach,
    canManageCms: isPrimaryAdmin || perms.has('cms.manage'),
    canAccessSystem: isPrimaryAdmin || perms.has('system.manage') || perms.has('users.read'),
  };
}

export function formatFirestoreDate(value: unknown): string {
  if (!value) return '—';
  let date: Date | null = null;
  if (value instanceof Date) {
    date = value;
  } else if (
    typeof value === 'object' &&
    value !== null &&
    'toDate' in value &&
    typeof (value as { toDate: () => Date }).toDate === 'function'
  ) {
    date = (value as { toDate: () => Date }).toDate();
  } else if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) date = parsed;
  }
  if (!date) return '—';
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}
