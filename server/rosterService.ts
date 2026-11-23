import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import {
  isValidId,
  type ServerCapabilities,
  type ServerUserPrivate,
} from './permissions.ts';

export type TeamMemberRole = 'manager' | 'coach' | 'starter' | 'reserve' | 'analyst';

const VALID_TEAM_ROLES = new Set<TeamMemberRole>([
  'manager',
  'coach',
  'starter',
  'reserve',
  'analyst',
]);

export interface RosterActor {
  uid: string;
  displayName: string;
  capabilities: ServerCapabilities;
}

export interface UpsertMembershipInput {
  teamId: string;
  targetUid: string;
  nickname: string;
  roleInTeam: string;
}

export interface EndMembershipInput {
  teamId: string;
  targetUid: string;
}

export interface RosterOperationResult {
  ok: boolean;
  status: number;
  error?: string;
  membershipId?: string;
  teamId?: string;
  uid?: string;
  teamIds?: string[];
}

function hasGlobalRosterAuthority(capabilities: ServerCapabilities): boolean {
  return (
    capabilities.isPrimaryAdmin ||
    capabilities.permissions.includes('teams.manage') ||
    capabilities.permissions.includes('users.manage')
  );
}

export async function upsertTeamMembership(
  db: Firestore,
  actor: RosterActor,
  input: UpsertMembershipInput
): Promise<RosterOperationResult> {
  const teamId = String(input.teamId || '').trim();
  const targetUid = String(input.targetUid || '').trim();
  const nickname = String(input.nickname || '').trim().slice(0, 32);
  const roleInTeam = String(input.roleInTeam || '').trim() as TeamMemberRole;

  if (!isValidId(teamId)) {
    return { ok: false, status: 400, error: 'ID da equipe inválido.' };
  }
  if (!isValidId(targetUid)) {
    return { ok: false, status: 400, error: 'UID do usuário inválido.' };
  }
  if (nickname.length < 2) {
    return { ok: false, status: 400, error: 'Nickname inválido (mínimo 2 caracteres).' };
  }
  if (!VALID_TEAM_ROLES.has(roleInTeam)) {
    return {
      ok: false,
      status: 400,
      error: 'Função no elenco inválida (use manager, coach, starter, reserve ou analyst).',
    };
  }

  const isGlobal = hasGlobalRosterAuthority(actor.capabilities);
  if (!isGlobal && !actor.capabilities.isManager) {
    return {
      ok: false,
      status: 403,
      error: 'Sem permissão para gerenciar vínculos de elenco.',
    };
  }

  const membershipId = `${teamId}_${targetUid}`;

  try {
    let nextTeamIds: string[] = [];

    await db.runTransaction(async (tx) => {
      const teamRef = db.doc(`teams/${teamId}`);
      const targetUserRef = db.doc(`users/${targetUid}`);
      const membershipRef = db.doc(`teamMemberships/${membershipId}`);
      const publicProfileRef = db.doc(`publicProfiles/${targetUid}`);
      const activeMembershipsQuery = db
        .collection('teamMemberships')
        .where('uid', '==', targetUid)
        .where('status', '==', 'active');

      const [teamSnap, targetUserSnap, existingMembershipSnap, activeSnap, publicProfileSnap] =
        await Promise.all([
          tx.get(teamRef),
          tx.get(targetUserRef),
          tx.get(membershipRef),
          tx.get(activeMembershipsQuery),
          tx.get(publicProfileRef),
        ]);

      if (!isGlobal) {
        const callerMembershipSnap = await tx.get(
          db.doc(`teamMemberships/${teamId}_${actor.uid}`)
        );
        const callerData = callerMembershipSnap.exists ? callerMembershipSnap.data() : null;
        if (
          !callerData ||
          callerData.status !== 'active' ||
          callerData.roleInTeam !== 'manager'
        ) {
          throw new Error(
            'FORBIDDEN:Apenas gerentes ativos desta equipe ou administradores autorizados podem alterar este elenco.'
          );
        }
      }

      if (!teamSnap.exists) {
        throw new Error('NOT_FOUND:Equipe não encontrada.');
      }

      if (!targetUserSnap.exists) {
        throw new Error('NOT_FOUND:Usuário de destino não encontrado.');
      }

      const targetUser = targetUserSnap.data() as ServerUserPrivate;
      if (targetUser.status === 'suspended') {
        throw new Error(
          'BAD_REQUEST:Não é possível vincular um usuário suspenso ao elenco.'
        );
      }

      const activeTeamSet = new Set<string>();
      for (const docSnap of activeSnap.docs) {
        const data = docSnap.data();
        if (typeof data.teamId === 'string' && isValidId(data.teamId)) {
          activeTeamSet.add(data.teamId);
        }
      }
      activeTeamSet.add(teamId);

      nextTeamIds = Array.from(activeTeamSet);
      if (nextTeamIds.length > 20) {
        throw new Error('BAD_REQUEST:Limite máximo de 20 equipes por usuário atingido.');
      }

      const now = FieldValue.serverTimestamp();
      const preservedJoinedAt = existingMembershipSnap.exists
        ? existingMembershipSnap.data()?.joinedAt || now
        : now;

      tx.set(membershipRef, {
        teamId,
        uid: targetUid,
        nickname,
        roleInTeam,
        status: 'active',
        joinedAt: preservedJoinedAt,
      });

      tx.update(targetUserRef, {
        teamIds: nextTeamIds,
        updatedAt: now,
      });

      if (publicProfileSnap.exists) {
        tx.update(publicProfileRef, {
          teamIds: nextTeamIds,
          updatedAt: now,
        });
      }

      tx.set(db.collection('auditLogs').doc(), {
        actorUid: actor.uid,
        actorLabel: actor.displayName || actor.uid,
        action: 'UPSERT_TEAM_MEMBERSHIP',
        entityType: 'teamMemberships',
        entityId: membershipId,
        summary: `Vínculo de ${nickname} (${targetUid}) definido como ${roleInTeam} na equipe ${teamId}.`,
        createdAt: now,
      });
    });

    return {
      ok: true,
      status: 200,
      membershipId,
      teamId,
      uid: targetUid,
      teamIds: nextTeamIds,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith('FORBIDDEN:')) {
      return { ok: false, status: 403, error: msg.slice('FORBIDDEN:'.length) };
    }
    if (msg.startsWith('NOT_FOUND:')) {
      return { ok: false, status: 404, error: msg.slice('NOT_FOUND:'.length) };
    }
    if (msg.startsWith('BAD_REQUEST:')) {
      return { ok: false, status: 400, error: msg.slice('BAD_REQUEST:'.length) };
    }
    return { ok: false, status: 500, error: msg };
  }
}

export async function endTeamMembership(
  db: Firestore,
  actor: RosterActor,
  input: EndMembershipInput
): Promise<RosterOperationResult> {
  const teamId = String(input.teamId || '').trim();
  const targetUid = String(input.targetUid || '').trim();

  if (!isValidId(teamId) || !isValidId(targetUid)) {
    return { ok: false, status: 400, error: 'Equipe ou UID do usuário inválido.' };
  }

  const isGlobal = hasGlobalRosterAuthority(actor.capabilities);
  if (!isGlobal && !actor.capabilities.isManager) {
    return {
      ok: false,
      status: 403,
      error: 'Sem permissão para encerrar vínculos de elenco.',
    };
  }

  const membershipId = `${teamId}_${targetUid}`;

  try {
    let remainingTeamIds: string[] = [];

    await db.runTransaction(async (tx) => {
      const membershipRef = db.doc(`teamMemberships/${membershipId}`);
      const targetUserRef = db.doc(`users/${targetUid}`);
      const publicProfileRef = db.doc(`publicProfiles/${targetUid}`);
      const activeMembershipsQuery = db
        .collection('teamMemberships')
        .where('uid', '==', targetUid)
        .where('status', '==', 'active');

      const [membershipSnap, targetUserSnap, activeSnap, publicProfileSnap] =
        await Promise.all([
          tx.get(membershipRef),
          tx.get(targetUserRef),
          tx.get(activeMembershipsQuery),
          tx.get(publicProfileRef),
        ]);

      if (!isGlobal) {
        const callerMembershipSnap = await tx.get(
          db.doc(`teamMemberships/${teamId}_${actor.uid}`)
        );
        const callerData = callerMembershipSnap.exists ? callerMembershipSnap.data() : null;
        if (
          !callerData ||
          callerData.status !== 'active' ||
          callerData.roleInTeam !== 'manager'
        ) {
          throw new Error(
            'FORBIDDEN:Apenas gerentes ativos desta equipe ou administradores autorizados podem encerrar vínculos deste elenco.'
          );
        }
      }

      if (!membershipSnap.exists) {
        throw new Error('NOT_FOUND:Vínculo de elenco não encontrado.');
      }

      const membershipData = membershipSnap.data() || {};
      const activeTeamSet = new Set<string>();
      for (const docSnap of activeSnap.docs) {
        const data = docSnap.data();
        if (
          docSnap.id !== membershipId &&
          typeof data.teamId === 'string' &&
          data.teamId !== teamId &&
          isValidId(data.teamId)
        ) {
          activeTeamSet.add(data.teamId);
        }
      }
      remainingTeamIds = Array.from(activeTeamSet);

      const now = FieldValue.serverTimestamp();

      tx.update(membershipRef, {
        status: 'transferred',
        endedAt: now,
      });

      if (targetUserSnap.exists) {
        tx.update(targetUserRef, {
          teamIds: remainingTeamIds,
          updatedAt: now,
        });
      }

      if (publicProfileSnap.exists) {
        tx.update(publicProfileRef, {
          teamIds: remainingTeamIds,
          updatedAt: now,
        });
      }

      tx.set(db.collection('auditLogs').doc(), {
        actorUid: actor.uid,
        actorLabel: actor.displayName || actor.uid,
        action: 'END_TEAM_MEMBERSHIP',
        entityType: 'teamMemberships',
        entityId: membershipId,
        summary: `Vínculo de ${String(membershipData.nickname || targetUid)} encerrado na equipe ${teamId}.`,
        createdAt: now,
      });
    });

    return {
      ok: true,
      status: 200,
      membershipId,
      teamId,
      uid: targetUid,
      teamIds: remainingTeamIds,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith('FORBIDDEN:')) {
      return { ok: false, status: 403, error: msg.slice('FORBIDDEN:'.length) };
    }
    if (msg.startsWith('NOT_FOUND:')) {
      return { ok: false, status: 404, error: msg.slice('NOT_FOUND:'.length) };
    }
    return { ok: false, status: 500, error: msg };
  }
}
