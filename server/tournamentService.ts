import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { isValidId } from './permissions.ts';
import { normalizeBrawlTag } from './brawlStarsService.ts';

export type MatchFormat = 'MD3' | 'MD5' | 'MD7';
export type AdditionalTiebreakerPolicy = 'none' | 'game_diff' | 'games_won' | 'manual';
export type TournamentStage = 'registration' | 'groups' | 'playoffs' | 'final' | 'completed';

export interface TournamentRules {
  initialStage: 'groups' | 'knockout';
  groupCount: number;
  teamsPerGroup: number;
  groupRoundFormat: 'single_round_robin';
  groupMatchFormat: MatchFormat;
  playoffMatchFormat: MatchFormat;
  finalMatchFormat: MatchFormat;
  winPoints: number;
  lossPoints: number;
  qualifiersPerGroup: number;
  additionalTiebreaker: AdditionalTiebreakerPolicy;
  resultMode: 'hybrid_tracker' | 'manual_only';
  playoffSeedingMode: 'standard_2_groups' | 'custom_admin';
}

export interface TournamentParticipant {
  teamId: string;
  teamName: string;
  playerTags: string[];
  groupName?: string;
  seed?: number;
}

export interface TournamentStandingRow {
  position: number;
  teamId: string;
  team: string;
  groupName: string;
  played: number;
  wins: number;
  losses: number;
  gamesWon: number;
  gamesLost: number;
  gameDiff: number;
  points: number;
  qualified: boolean;
  tieStatus: 'clear' | 'resolved_h2h' | 'resolved_wins' | 'resolved_extra' | 'unresolved';
  tieNote?: string;
}

export interface TournamentGroupState {
  name: string;
  teamIds: string[];
  standings: TournamentStandingRow[];
  unresolvedTieTeamIds: string[];
  manualTieBreakOrder?: string[];
}

export interface PlayoffBracketPairing {
  slot: string;
  label: string;
  teamAKey: string; // Ex.: "A:1", "B:2"
  teamBKey: string;
  format?: MatchFormat;
}

export interface MatchGame {
  gameNumber: number;
  winnerSide: 'teamA' | 'teamB';
  mode?: string;
  map?: string;
  battleTime?: string;
  battleId?: string;
  source: 'auto_tracker' | 'admin_confirmed' | 'manual';
  confirmedBy?: string;
  teamABrawlers?: string[];
  teamBBrawlers?: string[];
}

export interface TournamentMatchRecord {
  id: string;
  tournamentId?: string;
  tournamentName?: string;
  teamId: string;
  teamName: string;
  opponentName: string;
  teamAId?: string;
  teamAName?: string;
  teamBId?: string;
  teamBName?: string;
  stage?: 'groups' | 'playoffs' | 'final' | 'standalone';
  groupName?: string;
  round?: number;
  bracketSlot?: string;
  format: MatchFormat;
  seriesBestOf?: number;
  scheduledAt: unknown;
  status: 'scheduled' | 'live_manual' | 'completed' | 'cancelled';
  nxfScore: number;
  opponentScore: number;
  winnerTeamId?: string;
  locked?: boolean;
  resultSource?: 'manual' | 'auto_tracker' | 'hybrid';
  games?: MatchGame[];
  maps?: Array<{ mode: string; map: string; winner?: 'nxf' | 'opponent' }>;
  isPublic: boolean;
  enteredBy: string;
}

export interface TournamentActor {
  uid: string;
  displayName: string;
}

export const DEFAULT_NXF_TOURNAMENT_RULES: TournamentRules = {
  initialStage: 'groups',
  groupCount: 2,
  teamsPerGroup: 4,
  groupRoundFormat: 'single_round_robin',
  groupMatchFormat: 'MD3',
  playoffMatchFormat: 'MD5',
  finalMatchFormat: 'MD5',
  winPoints: 3,
  lossPoints: 0,
  qualifiersPerGroup: 2,
  additionalTiebreaker: 'none',
  resultMode: 'hybrid_tracker',
  playoffSeedingMode: 'standard_2_groups',
};

export function seriesBestOfForFormat(format: MatchFormat): number {
  if (format === 'MD7') return 7;
  if (format === 'MD5') return 5;
  return 3;
}

export function winsNeededForFormat(format: MatchFormat): number {
  return Math.ceil(seriesBestOfForFormat(format) / 2);
}

export function normalizeTournamentRules(raw?: Partial<TournamentRules>): TournamentRules {
  const groupCount = Math.max(1, Math.min(8, Math.round(Number(raw?.groupCount ?? 2))));
  const teamsPerGroup = Math.max(2, Math.min(16, Math.round(Number(raw?.teamsPerGroup ?? 4))));
  const qualifiersPerGroup = Math.max(
    1,
    Math.min(teamsPerGroup - 1, Math.round(Number(raw?.qualifiersPerGroup ?? 2)))
  );
  const validFormats = new Set<MatchFormat>(['MD3', 'MD5', 'MD7']);
  const groupMatchFormat = validFormats.has(raw?.groupMatchFormat as MatchFormat)
    ? (raw!.groupMatchFormat as MatchFormat)
    : 'MD3';
  const playoffMatchFormat = validFormats.has(raw?.playoffMatchFormat as MatchFormat)
    ? (raw!.playoffMatchFormat as MatchFormat)
    : 'MD5';
  const finalMatchFormat = validFormats.has(raw?.finalMatchFormat as MatchFormat)
    ? (raw!.finalMatchFormat as MatchFormat)
    : 'MD5';

  const validExtra = new Set<AdditionalTiebreakerPolicy>([
    'none',
    'game_diff',
    'games_won',
    'manual',
  ]);
  const additionalTiebreaker = validExtra.has(raw?.additionalTiebreaker as AdditionalTiebreakerPolicy)
    ? (raw!.additionalTiebreaker as AdditionalTiebreakerPolicy)
    : 'none';

  return {
    initialStage: raw?.initialStage === 'knockout' ? 'knockout' : 'groups',
    groupCount,
    teamsPerGroup,
    groupRoundFormat: 'single_round_robin',
    groupMatchFormat,
    playoffMatchFormat,
    finalMatchFormat,
    winPoints: Number.isFinite(Number(raw?.winPoints)) ? Number(raw!.winPoints) : 3,
    lossPoints: Number.isFinite(Number(raw?.lossPoints)) ? Number(raw!.lossPoints) : 0,
    qualifiersPerGroup,
    additionalTiebreaker,
    resultMode: raw?.resultMode === 'manual_only' ? 'manual_only' : 'hybrid_tracker',
    playoffSeedingMode:
      groupCount === 2 && raw?.playoffSeedingMode !== 'custom_admin'
        ? 'standard_2_groups'
        : 'custom_admin',
  };
}

export function groupLetter(index: number): string {
  return String.fromCharCode(65 + index); // A, B, C, ...
}

/**
 * Distribui equipes participantes nos grupos (A, B, C...) respeitando grupos pré-atribuídos quando válidos.
 */
export function distributeTeamsIntoGroups(
  participants: TournamentParticipant[],
  groupCount: number,
  teamsPerGroup: number
): Array<{ name: string; teams: TournamentParticipant[] }> {
  const safeGroupCount = Math.max(1, Math.min(8, groupCount));
  const groups: Array<{ name: string; teams: TournamentParticipant[] }> = Array.from(
    { length: safeGroupCount },
    (_, i) => ({ name: groupLetter(i), teams: [] })
  );

  const byName = new Map(groups.map((g) => [g.name, g]));
  const unassigned: TournamentParticipant[] = [];

  for (const p of participants) {
    const requested = p.groupName?.trim().toUpperCase();
    const target = requested ? byName.get(requested) : undefined;
    if (target && target.teams.length < teamsPerGroup) {
      target.teams.push({ ...p, groupName: target.name });
    } else {
      unassigned.push(p);
    }
  }

  // Distribuição balanceada (serpentine) para equipes sem grupo pré-definido
  let cursor = 0;
  for (const p of unassigned) {
    // Encontra o grupo com menos equipes
    let bestIdx = 0;
    let bestSize = groups[0].teams.length;
    for (let i = 1; i < groups.length; i++) {
      if (groups[i].teams.length < bestSize) {
        bestSize = groups[i].teams.length;
        bestIdx = i;
      }
    }
    const target = groups[bestIdx] || groups[cursor % groups.length];
    target.teams.push({ ...p, groupName: target.name });
    cursor += 1;
  }

  return groups;
}

/**
 * Gera confrontos de turno único (todos contra todos) usando o método do círculo.
 * Cada par de equipes se enfrenta exatamente uma vez.
 */
export function generateSingleRoundRobinPairings<T extends { teamId: string; teamName: string }>(
  teams: T[]
): Array<{ round: number; teamA: T; teamB: T }> {
  if (teams.length < 2) return [];

  const list: Array<T | null> = [...teams];
  if (list.length % 2 === 1) {
    list.push(null); // Bye para número ímpar
  }

  const n = list.length;
  const totalRounds = n - 1;
  const pairings: Array<{ round: number; teamA: T; teamB: T }> = [];

  for (let round = 0; round < totalRounds; round++) {
    for (let i = 0; i < n / 2; i++) {
      const a = list[i];
      const b = list[n - 1 - i];
      if (a && b) {
        pairings.push({ round: round + 1, teamA: a, teamB: b });
      }
    }
    // Rotaciona mantendo o índice 0 fixo
    const last = list.pop()!;
    list.splice(1, 0, last);
  }

  return pairings;
}

interface MutableTeamStats {
  teamId: string;
  teamName: string;
  played: number;
  wins: number;
  losses: number;
  gamesWon: number;
  gamesLost: number;
  gameDiff: number;
  points: number;
}

interface CompletedGroupMatch {
  teamAId: string;
  teamBId: string;
  scoreA: number;
  scoreB: number;
  winnerTeamId: string;
}

function groupByKey<T>(items: T[], keyFn: (item: T) => number): T[][] {
  const buckets = new Map<number, T[]>();
  for (const item of items) {
    const k = keyFn(item);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k)!.push(item);
  }
  return Array.from(buckets.entries())
    .sort((a, b) => b[0] - a[0])
    .map(([, group]) => group);
}

/**
 * Calcula a classificação oficial de um grupo seguindo rigorosamente os critérios NXF:
 * 1) Pontos (vitória=3, derrota=0)
 * 2) Confronto direto (entre as equipes empatadas)
 * 3) Maior número de vitórias em confrontos
 * 4) Critério adicional configurado pelo admin (ou marcação explícita de empate não resolvido sem classificação arbitrária)
 */
export function computeGroupStandings(
  groupName: string,
  groupTeams: Array<{ teamId: string; teamName: string }>,
  matches: TournamentMatchRecord[],
  rules: TournamentRules,
  manualTieBreakOrder?: string[]
): {
  standings: TournamentStandingRow[];
  unresolvedTieTeamIds: string[];
} {
  const statsMap = new Map<string, MutableTeamStats>();
  for (const t of groupTeams) {
    statsMap.set(t.teamId, {
      teamId: t.teamId,
      teamName: t.teamName,
      played: 0,
      wins: 0,
      losses: 0,
      gamesWon: 0,
      gamesLost: 0,
      gameDiff: 0,
      points: 0,
    });
  }

  const completedMatches: CompletedGroupMatch[] = [];

  for (const m of matches) {
    if (m.status !== 'completed') continue;
    const teamAId = m.teamAId || m.teamId;
    const teamBId = m.teamBId;
    if (!teamAId || !teamBId) continue;
    const statsA = statsMap.get(teamAId);
    const statsB = statsMap.get(teamBId);
    if (!statsA || !statsB) continue;

    const scoreA = Number(m.nxfScore ?? 0);
    const scoreB = Number(m.opponentScore ?? 0);
    const winnerTeamId =
      m.winnerTeamId || (scoreA > scoreB ? teamAId : scoreB > scoreA ? teamBId : '');
    if (!winnerTeamId || (winnerTeamId !== teamAId && winnerTeamId !== teamBId)) continue;

    statsA.played += 1;
    statsB.played += 1;
    statsA.gamesWon += scoreA;
    statsA.gamesLost += scoreB;
    statsA.gameDiff = statsA.gamesWon - statsA.gamesLost;

    statsB.gamesWon += scoreB;
    statsB.gamesLost += scoreA;
    statsB.gameDiff = statsB.gamesWon - statsB.gamesLost;

    if (winnerTeamId === teamAId) {
      statsA.wins += 1;
      statsA.points += rules.winPoints;
      statsB.losses += 1;
      statsB.points += rules.lossPoints;
    } else {
      statsB.wins += 1;
      statsB.points += rules.winPoints;
      statsA.losses += 1;
      statsA.points += rules.lossPoints;
    }

    completedMatches.push({
      teamAId,
      teamBId,
      scoreA,
      scoreB,
      winnerTeamId,
    });
  }

  const unresolvedSet = new Set<string>();
  const tieMeta = new Map<
    string,
    { status: TournamentStandingRow['tieStatus']; note?: string }
  >();

  const resolveTiedCohort = (cohort: MutableTeamStats[], depth = 0): MutableTeamStats[] => {
    if (cohort.length <= 1) return cohort;

    // Critério 2: Confronto direto (mini-liga entre exatamente as equipes empatadas)
    const cohortIds = new Set(cohort.map((c) => c.teamId));
    const h2hPoints = new Map<string, number>();
    const h2hWins = new Map<string, number>();
    for (const c of cohort) {
      h2hPoints.set(c.teamId, 0);
      h2hWins.set(c.teamId, 0);
    }

    for (const cm of completedMatches) {
      if (cohortIds.has(cm.teamAId) && cohortIds.has(cm.teamBId)) {
        const loserId = cm.winnerTeamId === cm.teamAId ? cm.teamBId : cm.teamAId;
        h2hPoints.set(cm.winnerTeamId, (h2hPoints.get(cm.winnerTeamId) || 0) + rules.winPoints);
        h2hWins.set(cm.winnerTeamId, (h2hWins.get(cm.winnerTeamId) || 0) + 1);
        h2hPoints.set(loserId, (h2hPoints.get(loserId) || 0) + rules.lossPoints);
      }
    }

    const byH2H = groupByKey(cohort, (c) => (h2hPoints.get(c.teamId) || 0) * 100 + (h2hWins.get(c.teamId) || 0));
    if (byH2H.length > 1) {
      const out: MutableTeamStats[] = [];
      for (const sub of byH2H) {
        if (sub.length === 1) {
          tieMeta.set(sub[0].teamId, {
            status: 'resolved_h2h',
            note: 'Desempatado por confronto direto.',
          });
          out.push(sub[0]);
        } else if (depth < 4) {
          out.push(...resolveTiedCohort(sub, depth + 1));
        } else {
          out.push(...sub);
        }
      }
      return out;
    }

    // Critério 3: Maior número de vitórias em confrontos
    const byWins = groupByKey(cohort, (c) => c.wins);
    if (byWins.length > 1) {
      const out: MutableTeamStats[] = [];
      for (const sub of byWins) {
        if (sub.length === 1) {
          tieMeta.set(sub[0].teamId, {
            status: 'resolved_wins',
            note: 'Desempatado por maior número de vitórias.',
          });
          out.push(sub[0]);
        } else if (depth < 4) {
          out.push(...resolveTiedCohort(sub, depth + 1));
        } else {
          out.push(...sub);
        }
      }
      return out;
    }

    // Critério 4: Ordem manual definida pela administração
    if (Array.isArray(manualTieBreakOrder) && manualTieBreakOrder.length > 0) {
      const orderIdx = new Map(manualTieBreakOrder.map((id, i) => [id, i]));
      const allRanked = cohort.every((c) => orderIdx.has(c.teamId));
      if (allRanked) {
        const sortedManual = [...cohort].sort(
          (a, b) => (orderIdx.get(a.teamId) ?? 999) - (orderIdx.get(b.teamId) ?? 999)
        );
        for (const c of sortedManual) {
          tieMeta.set(c.teamId, {
            status: 'resolved_extra',
            note: 'Desempatado por decisão administrativa registrada.',
          });
        }
        return sortedManual;
      }
    }

    // Critério 4 (alternativo): Critério adicional configurado pela administração
    if (rules.additionalTiebreaker === 'game_diff') {
      const byDiff = groupByKey(cohort, (c) => c.gameDiff);
      if (byDiff.length > 1) {
        const out: MutableTeamStats[] = [];
        for (const sub of byDiff) {
          if (sub.length === 1) {
            tieMeta.set(sub[0].teamId, {
              status: 'resolved_extra',
              note: 'Desempatado por saldo de partidas (critério adicional configurado).',
            });
            out.push(sub[0]);
          } else {
            for (const u of sub) {
              unresolvedSet.add(u.teamId);
              tieMeta.set(u.teamId, {
                status: 'unresolved',
                note: 'Empate persistente mesmo após saldo de partidas — exige decisão administrativa.',
              });
            }
            out.push(...sub.sort((a, b) => a.teamName.localeCompare(b.teamName)));
          }
        }
        return out;
      }
    } else if (rules.additionalTiebreaker === 'games_won') {
      const byGamesWon = groupByKey(cohort, (c) => c.gamesWon);
      if (byGamesWon.length > 1) {
        const out: MutableTeamStats[] = [];
        for (const sub of byGamesWon) {
          if (sub.length === 1) {
            tieMeta.set(sub[0].teamId, {
              status: 'resolved_extra',
              note: 'Desempatado por partidas vencidas (critério adicional configurado).',
            });
            out.push(sub[0]);
          } else {
            for (const u of sub) {
              unresolvedSet.add(u.teamId);
              tieMeta.set(u.teamId, {
                status: 'unresolved',
                note: 'Empate persistente mesmo após partidas vencidas — exige decisão administrativa.',
              });
            }
            out.push(...sub.sort((a, b) => a.teamName.localeCompare(b.teamName)));
          }
        }
        return out;
      }
    }

    // Empate persiste -> NÃO classificar arbitrariamente! Sinalizar para decisão administrativa.
    for (const c of cohort) {
      unresolvedSet.add(c.teamId);
      tieMeta.set(c.teamId, {
        status: 'unresolved',
        note: 'Empate persistente após pontos, confronto direto e vitórias — requer critério adicional ou decisão administrativa.',
      });
    }
    return [...cohort].sort((a, b) => a.teamName.localeCompare(b.teamName));
  };

  // Critério 1: Pontos (decrescente)
  const allStats = Array.from(statsMap.values());
  const byPoints = groupByKey(allStats, (s) => s.points);
  const ordered: MutableTeamStats[] = [];
  for (const bucket of byPoints) {
    if (bucket.length === 1) {
      ordered.push(bucket[0]);
    } else {
      // Só sinaliza empate não resolvido se houver ao menos 1 partida concluída ou se for necessário desempate
      const anyPlayed = bucket.some((b) => b.played > 0);
      if (!anyPlayed) {
        ordered.push(...bucket.sort((a, b) => a.teamName.localeCompare(b.teamName)));
      } else {
        ordered.push(...resolveTiedCohort(bucket));
      }
    }
  }

  const standings: TournamentStandingRow[] = ordered.map((s, idx) => {
    const position = idx + 1;
    const meta = tieMeta.get(s.teamId);
    const isUnresolved = unresolvedSet.has(s.teamId);
    const qualified =
      !isUnresolved &&
      position <= rules.qualifiersPerGroup &&
      s.played > 0;

    return {
      position,
      teamId: s.teamId,
      team: s.teamName,
      groupName,
      played: s.played,
      wins: s.wins,
      losses: s.losses,
      gamesWon: s.gamesWon,
      gamesLost: s.gamesLost,
      gameDiff: s.gameDiff,
      points: s.points,
      qualified,
      tieStatus: meta?.status || 'clear',
      ...(meta?.note ? { tieNote: meta.note } : {}),
    };
  });

  return {
    standings,
    unresolvedTieTeamIds: Array.from(unresolvedSet),
  };
}

/**
 * Resolve uma chave de qualificado no formato "A:1" (1º do Grupo A) para o time correspondente.
 */
function resolveQualifierKey(
  groups: TournamentGroupState[],
  key: string
): { teamId: string; teamName: string } | null {
  const match = /^([A-Z]):(\d+)$/i.exec(key.trim());
  if (!match) return null;
  const groupName = match[1].toUpperCase();
  const pos = Number(match[2]);
  const grp = groups.find((g) => g.name.toUpperCase() === groupName);
  if (!grp) return null;
  const row = grp.standings.find((r) => r.position === pos);
  if (!row || !row.teamId) return null;
  return { teamId: row.teamId, teamName: row.team };
}

function sanitizeParticipants(raw: unknown): TournamentParticipant[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const list: TournamentParticipant[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const teamId = String(obj.teamId || '').trim();
    const teamName = String(obj.teamName || '').trim().slice(0, 60);
    if (!isValidId(teamId) || teamName.length < 2 || seen.has(teamId)) continue;
    seen.add(teamId);
    const playerTags = Array.isArray(obj.playerTags)
      ? Array.from(
          new Set(
            obj.playerTags
              .map((t) => normalizeBrawlTag(t))
              .filter((t) => t.length >= 4)
          )
        ).slice(0, 12)
      : [];
    list.push({
      teamId,
      teamName,
      playerTags,
      ...(typeof obj.groupName === 'string' && obj.groupName.trim()
        ? { groupName: obj.groupName.trim().toUpperCase().slice(0, 2) }
        : {}),
      ...(typeof obj.seed === 'number' ? { seed: Math.round(obj.seed) } : {}),
    });
  }
  return list;
}

async function hydrateParticipantTagsFromRoster(
  db: Firestore,
  participants: TournamentParticipant[]
): Promise<TournamentParticipant[]> {
  if (participants.length === 0) return [];
  const membershipsSnap = await db
    .collection('teamMemberships')
    .where('status', '==', 'active')
    .limit(400)
    .get();
  const usersSnap = await db
    .collection('users')
    .where('status', '==', 'active')
    .limit(300)
    .get();

  const tagByUid = new Map<string, string>();
  for (const u of usersSnap.docs) {
    const data = u.data();
    const tag = normalizeBrawlTag(data.brawlTag);
    if (tag) tagByUid.set(u.id, tag);
  }

  const tagsByTeam = new Map<string, Set<string>>();
  for (const m of membershipsSnap.docs) {
    const data = m.data();
    const teamId = String(data.teamId || '');
    const uid = String(data.uid || '');
    const tag = tagByUid.get(uid);
    if (!teamId || !tag) continue;
    if (!tagsByTeam.has(teamId)) tagsByTeam.set(teamId, new Set());
    tagsByTeam.get(teamId)!.add(tag);
  }

  return participants.map((p) => {
    const rosterTags = Array.from(tagsByTeam.get(p.teamId) || []);
    const mergedTags = Array.from(new Set([...(p.playerTags || []), ...rosterTags]));
    return {
      ...p,
      playerTags: mergedTags,
    };
  });
}

export async function createConfiguredTournament(
  db: Firestore,
  actor: TournamentActor,
  payload: {
    name?: string;
    description?: string;
    organizer?: string;
    startDateIso?: string;
    endDateIso?: string;
    isPublic?: boolean;
    registrationOpen?: boolean;
    rules?: Partial<TournamentRules>;
    participants?: TournamentParticipant[];
  }
): Promise<{ ok: true; id: string; rules: TournamentRules } | { ok: false; status: number; error: string }> {
  const name = String(payload.name || '').trim().slice(0, 100);
  if (name.length < 3) {
    return { ok: false, status: 400, error: 'Informe um nome de campeonato com pelo menos 3 caracteres.' };
  }

  const rules = normalizeTournamentRules(payload.rules);
  const rawParticipants = sanitizeParticipants(payload.participants);
  const participants = await hydrateParticipantTagsFromRoster(db, rawParticipants);

  const now = FieldValue.serverTimestamp();
  const tRef = db.collection('tournaments').doc();

  const startDate =
    payload.startDateIso && Number.isFinite(Date.parse(payload.startDateIso))
      ? Timestamp.fromDate(new Date(payload.startDateIso))
      : Timestamp.now();
  const endDate =
    payload.endDateIso && Number.isFinite(Date.parse(payload.endDateIso))
      ? Timestamp.fromDate(new Date(payload.endDateIso))
      : undefined;

  await tRef.set({
    name,
    description: String(payload.description || '').trim().slice(0, 1000),
    organizer: String(payload.organizer || 'NXF eSports').trim().slice(0, 80),
    format: rules.initialStage === 'groups' ? 'Grupos + Playoffs' : rules.playoffMatchFormat,
    status: 'upcoming',
    currentStage: 'registration',
    lockedStages: [],
    startDate,
    ...(endDate ? { endDate } : {}),
    registrationOpen: payload.registrationOpen !== false,
    isPublic: payload.isPublic !== false,
    rules,
    participants,
    groups: [],
    standings: [],
    createdAt: now,
    updatedAt: now,
  });

  await db.collection('auditLogs').add({
    actorUid: actor.uid,
    actorLabel: actor.displayName,
    action: 'CREATE_TOURNAMENT',
    entityType: 'tournaments',
    entityId: tRef.id,
    summary: `Campeonato "${name}" criado (${rules.groupCount} grupos × ${rules.teamsPerGroup} equipes, grupos ${rules.groupMatchFormat}, playoffs ${rules.playoffMatchFormat}).`,
    createdAt: now,
  });

  return { ok: true, id: tRef.id, rules };
}

export async function configureTournament(
  db: Firestore,
  actor: TournamentActor,
  tournamentId: string,
  payload: {
    name?: string;
    description?: string;
    registrationOpen?: boolean;
    isPublic?: boolean;
    rules?: Partial<TournamentRules>;
    participants?: TournamentParticipant[];
    playoffBracketConfig?: PlayoffBracketPairing[];
    manualTieBreakByGroup?: Record<string, string[]>;
  }
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  if (!isValidId(tournamentId)) {
    return { ok: false, status: 400, error: 'ID de campeonato inválido.' };
  }

  const tRef = db.doc(`tournaments/${tournamentId}`);
  const tSnap = await tRef.get();
  if (!tSnap.exists) {
    return { ok: false, status: 404, error: 'Campeonato não encontrado.' };
  }

  const existing = tSnap.data() || {};
  const lockedStages: string[] = Array.isArray(existing.lockedStages) ? existing.lockedStages : [];
  const updateData: Record<string, unknown> = {
    updatedAt: FieldValue.serverTimestamp(),
  };

  if (typeof payload.name === 'string' && payload.name.trim().length >= 3) {
    updateData.name = payload.name.trim().slice(0, 100);
  }
  if (typeof payload.description === 'string') {
    updateData.description = payload.description.trim().slice(0, 1000);
  }
  if (typeof payload.registrationOpen === 'boolean') {
    updateData.registrationOpen = payload.registrationOpen;
  }
  if (typeof payload.isPublic === 'boolean') {
    updateData.isPublic = payload.isPublic;
  }

  const nextRules = payload.rules
    ? normalizeTournamentRules({ ...(existing.rules || {}), ...payload.rules })
    : normalizeTournamentRules(existing.rules);
  if (payload.rules) {
    updateData.rules = nextRules;
  }

  if (payload.participants) {
    if (lockedStages.includes('groups')) {
      return {
        ok: false,
        status: 409,
        error: 'A fase de grupos já foi encerrada e travada; não é possível alterar participantes.',
      };
    }
    const clean = sanitizeParticipants(payload.participants);
    updateData.participants = await hydrateParticipantTagsFromRoster(db, clean);
  }

  if (Array.isArray(payload.playoffBracketConfig)) {
    if (lockedStages.includes('playoffs')) {
      return {
        ok: false,
        status: 409,
        error: 'Os playoffs já foram encerrados e travados.',
      };
    }
    updateData.playoffBracketConfig = payload.playoffBracketConfig.slice(0, 16);
  }

  if (payload.manualTieBreakByGroup && typeof payload.manualTieBreakByGroup === 'object') {
    const existingGroups: TournamentGroupState[] = Array.isArray(existing.groups)
      ? existing.groups
      : [];
    updateData.groups = existingGroups.map((g) => {
      const manualOrder = payload.manualTieBreakByGroup?.[g.name];
      if (!Array.isArray(manualOrder)) return g;
      return {
        ...g,
        manualTieBreakOrder: manualOrder.filter((id) => typeof id === 'string'),
      };
    });
  }

  await tRef.set(updateData, { merge: true });

  // Se houve alteração de regras ou ordem manual de desempate e já existem grupos, recalcula tabela no backend
  if (
    (payload.rules || payload.manualTieBreakByGroup) &&
    Array.isArray(existing.groups) &&
    existing.groups.length > 0
  ) {
    await recalculateTournamentStandings(db, tournamentId);
  }

  await db.collection('auditLogs').add({
    actorUid: actor.uid,
    actorLabel: actor.displayName,
    action: 'CONFIGURE_TOURNAMENT',
    entityType: 'tournaments',
    entityId: tournamentId,
    summary: `Configurações do campeonato "${String(updateData.name || existing.name || tournamentId)}" atualizadas.`,
    createdAt: FieldValue.serverTimestamp(),
  });

  return { ok: true };
}

export async function generateTournamentGroupStage(
  db: Firestore,
  actor: TournamentActor,
  tournamentId: string,
  options: { scheduledStartIso?: string } = {}
): Promise<
  | { ok: true; groupsCount: number; matchesCreated: number; groups: TournamentGroupState[] }
  | { ok: false; status: number; error: string }
> {
  if (!isValidId(tournamentId)) {
    return { ok: false, status: 400, error: 'ID de campeonato inválido.' };
  }

  const tRef = db.doc(`tournaments/${tournamentId}`);
  const tSnap = await tRef.get();
  if (!tSnap.exists) {
    return { ok: false, status: 404, error: 'Campeonato não encontrado.' };
  }

  const tournament = tSnap.data() || {};
  const lockedStages: string[] = Array.isArray(tournament.lockedStages) ? tournament.lockedStages : [];
  if (lockedStages.includes('groups') || tournament.currentStage === 'playoffs' || tournament.currentStage === 'completed') {
    return {
      ok: false,
      status: 409,
      error: 'A fase de grupos já foi encerrada ou avançada. Não é permitido regerar grupos.',
    };
  }

  const existingMatchesSnap = await db
    .collection('matches')
    .where('tournamentId', '==', tournamentId)
    .get();
  const existingGroupMatches = existingMatchesSnap.docs.filter(
    (d) => d.data().stage === 'groups'
  );
  if (existingGroupMatches.length > 0) {
    return {
      ok: false,
      status: 409,
      error: 'Os confrontos da fase de grupos já foram gerados para este campeonato.',
    };
  }

  const rules = normalizeTournamentRules(tournament.rules);
  const rawParticipants = sanitizeParticipants(tournament.participants);
  if (rawParticipants.length < rules.groupCount * 2) {
    return {
      ok: false,
      status: 400,
      error: `É necessário inscrever pelo menos ${rules.groupCount * 2} equipes para gerar ${rules.groupCount} grupo(s).`,
    };
  }

  const participants = await hydrateParticipantTagsFromRoster(db, rawParticipants);
  const distributed = distributeTeamsIntoGroups(
    participants,
    rules.groupCount,
    rules.teamsPerGroup
  );

  const baseStartMs =
    options.scheduledStartIso && Number.isFinite(Date.parse(options.scheduledStartIso))
      ? Date.parse(options.scheduledStartIso)
      : Date.now() + 3600 * 1000;

  const now = FieldValue.serverTimestamp();
  const batch = db.batch();
  let matchesCreated = 0;
  const groupsState: TournamentGroupState[] = [];
  const allStandings: TournamentStandingRow[] = [];

  for (const grp of distributed) {
    const pairings = generateSingleRoundRobinPairings(grp.teams);
    for (let i = 0; i < pairings.length; i++) {
      const p = pairings[i];
      const matchRef = db.collection('matches').doc();
      const scheduledMs = baseStartMs + (p.round - 1) * 2 * 3600 * 1000 + i * 20 * 60 * 1000;
      batch.set(matchRef, {
        tournamentId,
        tournamentName: String(tournament.name || tournamentId),
        teamId: p.teamA.teamId,
        teamName: p.teamA.teamName,
        opponentName: p.teamB.teamName,
        teamAId: p.teamA.teamId,
        teamAName: p.teamA.teamName,
        teamBId: p.teamB.teamId,
        teamBName: p.teamB.teamName,
        stage: 'groups',
        groupName: grp.name,
        round: p.round,
        format: rules.groupMatchFormat,
        seriesBestOf: seriesBestOfForFormat(rules.groupMatchFormat),
        scheduledAt: Timestamp.fromMillis(scheduledMs),
        status: 'scheduled',
        nxfScore: 0,
        opponentScore: 0,
        locked: false,
        resultSource: 'manual',
        games: [],
        maps: [],
        isPublic: tournament.isPublic !== false,
        enteredBy: actor.uid,
        createdAt: now,
        updatedAt: now,
      });
      matchesCreated += 1;
    }

    const { standings, unresolvedTieTeamIds } = computeGroupStandings(
      grp.name,
      grp.teams,
      [],
      rules
    );
    groupsState.push({
      name: grp.name,
      teamIds: grp.teams.map((t) => t.teamId),
      standings,
      unresolvedTieTeamIds,
    });
    allStandings.push(...standings);
  }

  const updatedParticipants = distributed.flatMap((g) => g.teams);

  batch.set(
    tRef,
    {
      status: 'ongoing',
      currentStage: 'groups',
      registrationOpen: false,
      participants: updatedParticipants,
      groups: groupsState,
      standings: allStandings,
      updatedAt: now,
    },
    { merge: true }
  );

  batch.set(db.collection('auditLogs').doc(), {
    actorUid: actor.uid,
    actorLabel: actor.displayName,
    action: 'GENERATE_TOURNAMENT_GROUPS',
    entityType: 'tournaments',
    entityId: tournamentId,
    summary: `Fase de grupos gerada (${groupsState.length} grupos, ${matchesCreated} confrontos ${rules.groupMatchFormat} em turno único).`,
    createdAt: now,
  });

  await batch.commit();

  return {
    ok: true,
    groupsCount: groupsState.length,
    matchesCreated,
    groups: groupsState,
  };
}

export async function recalculateTournamentStandings(
  db: Firestore,
  tournamentId: string
): Promise<
  | { ok: true; groups: TournamentGroupState[]; hasUnresolvedTies: boolean }
  | { ok: false; status: number; error: string }
> {
  if (!isValidId(tournamentId)) {
    return { ok: false, status: 400, error: 'ID de campeonato inválido.' };
  }

  const tRef = db.doc(`tournaments/${tournamentId}`);
  const tSnap = await tRef.get();
  if (!tSnap.exists) {
    return { ok: false, status: 404, error: 'Campeonato não encontrado.' };
  }

  const tournament = tSnap.data() || {};
  const rules = normalizeTournamentRules(tournament.rules);
  const participants = sanitizeParticipants(tournament.participants);
  const participantById = new Map(participants.map((p) => [p.teamId, p]));
  const existingGroups: TournamentGroupState[] = Array.isArray(tournament.groups)
    ? tournament.groups
    : [];

  if (existingGroups.length === 0) {
    return { ok: true, groups: [], hasUnresolvedTies: false };
  }

  const matchesSnap = await db
    .collection('matches')
    .where('tournamentId', '==', tournamentId)
    .get();

  const allMatches = matchesSnap.docs.map((d) => ({
    id: d.id,
    ...(d.data() as Omit<TournamentMatchRecord, 'id'>),
  }));

  const updatedGroups: TournamentGroupState[] = [];
  const flattenedStandings: TournamentStandingRow[] = [];
  let hasUnresolvedTies = false;

  for (const grp of existingGroups) {
    const groupTeams = grp.teamIds.map((teamId) => ({
      teamId,
      teamName:
        participantById.get(teamId)?.teamName ||
        grp.standings.find((r) => r.teamId === teamId)?.team ||
        teamId,
    }));

    const groupMatches = allMatches.filter(
      (m) => m.stage === 'groups' && m.groupName === grp.name
    );

    const { standings, unresolvedTieTeamIds } = computeGroupStandings(
      grp.name,
      groupTeams,
      groupMatches,
      rules,
      grp.manualTieBreakOrder
    );

    if (unresolvedTieTeamIds.length > 0) {
      hasUnresolvedTies = true;
    }

    updatedGroups.push({
      ...grp,
      standings,
      unresolvedTieTeamIds,
    });
    flattenedStandings.push(...standings);
  }

  await tRef.set(
    {
      groups: updatedGroups,
      standings: flattenedStandings,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  return { ok: true, groups: updatedGroups, hasUnresolvedTies };
}

export async function recordTournamentMatchResult(
  db: Firestore,
  actor: TournamentActor,
  params: {
    matchId: string;
    game?: {
      winnerSide: 'teamA' | 'teamB';
      mode?: string;
      map?: string;
      battleTime?: string;
      battleId?: string;
      source: 'auto_tracker' | 'admin_confirmed' | 'manual';
      teamABrawlers?: string[];
      teamBBrawlers?: string[];
    };
    teamAScore?: number;
    teamBScore?: number;
    finalize?: boolean;
  }
): Promise<
  | {
      ok: true;
      matchId: string;
      teamAScore: number;
      teamBScore: number;
      status: string;
      winnerTeamId: string | null;
      duplicateBattle?: boolean;
    }
  | { ok: false; status: number; error: string }
> {
  if (!isValidId(params.matchId)) {
    return { ok: false, status: 400, error: 'ID de partida inválido.' };
  }

  const matchRef = db.doc(`matches/${params.matchId}`);
  const matchSnap = await matchRef.get();
  if (!matchSnap.exists) {
    return { ok: false, status: 404, error: 'Partida não encontrada.' };
  }

  const match = matchSnap.data() as TournamentMatchRecord;
  if (match.locked === true) {
    return {
      ok: false,
      status: 409,
      error: 'Esta partida pertence a uma fase encerrada e travada contra alterações.',
    };
  }

  const format: MatchFormat =
    match.format === 'MD5' || match.format === 'MD7' ? match.format : 'MD3';
  const winsNeeded = winsNeededForFormat(format);
  const existingGames: MatchGame[] = Array.isArray(match.games) ? [...match.games] : [];
  let scoreA = Number(match.nxfScore ?? 0);
  let scoreB = Number(match.opponentScore ?? 0);
  let resultSource = match.resultSource || 'manual';

  if (params.game) {
    // Deduplicação de batalha na série
    if (
      params.game.battleId &&
      existingGames.some((g) => g.battleId && g.battleId === params.game!.battleId)
    ) {
      return {
        ok: true,
        matchId: params.matchId,
        teamAScore: scoreA,
        teamBScore: scoreB,
        status: match.status,
        winnerTeamId: match.winnerTeamId || null,
        duplicateBattle: true,
      };
    }

    if (match.status === 'completed') {
      return {
        ok: false,
        status: 409,
        error: 'Este confronto já foi encerrado.',
      };
    }

    const nextGame: MatchGame = {
      gameNumber: existingGames.length + 1,
      winnerSide: params.game.winnerSide,
      ...(params.game.mode ? { mode: params.game.mode } : {}),
      ...(params.game.map ? { map: params.game.map } : {}),
      ...(params.game.battleTime ? { battleTime: params.game.battleTime } : {}),
      ...(params.game.battleId ? { battleId: params.game.battleId } : {}),
      source: params.game.source,
      confirmedBy: actor.uid,
      ...(params.game.teamABrawlers ? { teamABrawlers: params.game.teamABrawlers } : {}),
      ...(params.game.teamBBrawlers ? { teamBBrawlers: params.game.teamBBrawlers } : {}),
    };

    existingGames.push(nextGame);
    if (nextGame.winnerSide === 'teamA') scoreA += 1;
    else scoreB += 1;

    if (params.game.source === 'auto_tracker') {
      resultSource = resultSource === 'manual' ? 'auto_tracker' : resultSource;
    } else if (params.game.source === 'admin_confirmed') {
      resultSource = 'hybrid';
    }
  } else {
    if (typeof params.teamAScore === 'number') {
      scoreA = Math.max(0, Math.min(10, Math.round(params.teamAScore)));
    }
    if (typeof params.teamBScore === 'number') {
      scoreB = Math.max(0, Math.min(10, Math.round(params.teamBScore)));
    }
    resultSource = existingGames.some((g) => g.source === 'auto_tracker') ? 'hybrid' : 'manual';
  }

  const teamAId = match.teamAId || match.teamId;
  const teamBId = match.teamBId || '';

  const reachedWinThreshold = scoreA >= winsNeeded || scoreB >= winsNeeded;
  const shouldComplete = reachedWinThreshold || params.finalize === true;

  if (shouldComplete && scoreA === scoreB) {
    return {
      ok: false,
      status: 400,
      error: `Confrontos ${format} não podem ser encerrados empatados. Defina o vencedor (${winsNeeded} vitórias).`,
    };
  }

  const winnerTeamId = shouldComplete
    ? scoreA > scoreB
      ? teamAId
      : teamBId || 'opponent'
    : null;
  const nextStatus = shouldComplete ? 'completed' : 'live_manual';

  const mapsSummary = existingGames
    .filter((g) => g.mode || g.map)
    .map((g) => ({
      mode: g.mode || 'Modo',
      map: g.map || 'Mapa',
      winner: (g.winnerSide === 'teamA' ? 'nxf' : 'opponent') as 'nxf' | 'opponent',
    }));

  const now = FieldValue.serverTimestamp();
  await matchRef.set(
    {
      nxfScore: scoreA,
      opponentScore: scoreB,
      status: nextStatus,
      ...(winnerTeamId ? { winnerTeamId } : {}),
      games: existingGames,
      ...(mapsSummary.length > 0 ? { maps: mapsSummary } : {}),
      resultSource,
      confirmedBy: actor.uid,
      ...(shouldComplete ? { confirmedAt: now } : {}),
      updatedAt: now,
    },
    { merge: true }
  );

  // Recalcula classificação automaticamente no backend quando o confronto pertence a um campeonato
  if (match.tournamentId && match.stage === 'groups') {
    await recalculateTournamentStandings(db, match.tournamentId);
  }

  await db.collection('auditLogs').add({
    actorUid: actor.uid,
    actorLabel: actor.displayName,
    action: shouldComplete ? 'COMPLETE_TOURNAMENT_MATCH' : 'RECORD_MATCH_GAME',
    entityType: 'matches',
    entityId: params.matchId,
    summary: `Placar atualizado (${match.teamName} ${scoreA} × ${scoreB} ${match.opponentName}, ${format}, status=${nextStatus}, origem=${resultSource}).`,
    createdAt: now,
  });

  return {
    ok: true,
    matchId: params.matchId,
    teamAScore: scoreA,
    teamBScore: scoreB,
    status: nextStatus,
    winnerTeamId,
  };
}

/**
 * Avança automaticamente a fase do campeonato (Grupos -> Playoffs MD5 -> Final MD5 -> Encerrado),
 * validando integralmente:
 * - Todas as partidas da fase atual concluídas e confirmadas
 * - Nenhum empate não resolvido nos grupos
 * - Bloqueio imediato das partidas da fase encerrada (locked = true)
 * - Para 2 grupos: chaveamento automático 1º A × 2º B e 1º B × 2º A em MD5
 * - Para >2 grupos: exige definição administrativa explícita de chaveamento antes de gerar playoffs
 */
export async function advanceTournamentStage(
  db: Firestore,
  actor: TournamentActor,
  tournamentId: string,
  options: {
    playoffBracketConfig?: PlayoffBracketPairing[];
    scheduledStartIso?: string;
  } = {}
): Promise<
  | {
      ok: true;
      nextStage: TournamentStage;
      createdMatchesCount: number;
      championTeamName?: string;
    }
  | { ok: false; status: number; error: string }
> {
  if (!isValidId(tournamentId)) {
    return { ok: false, status: 400, error: 'ID de campeonato inválido.' };
  }

  const tRef = db.doc(`tournaments/${tournamentId}`);
  const tSnap = await tRef.get();
  if (!tSnap.exists) {
    return { ok: false, status: 404, error: 'Campeonato não encontrado.' };
  }

  const tournament = tSnap.data() || {};
  const rules = normalizeTournamentRules(tournament.rules);
  const currentStage: TournamentStage = (tournament.currentStage as TournamentStage) || 'registration';
  const lockedStages: string[] = Array.isArray(tournament.lockedStages) ? [...tournament.lockedStages] : [];

  const matchesSnap = await db
    .collection('matches')
    .where('tournamentId', '==', tournamentId)
    .get();
  const allMatches = matchesSnap.docs.map((d) => ({
    id: d.id,
    ref: d.ref,
    data: d.data() as TournamentMatchRecord,
  }));

  const baseStartMs =
    options.scheduledStartIso && Number.isFinite(Date.parse(options.scheduledStartIso))
      ? Date.parse(options.scheduledStartIso)
      : Date.now() + 2 * 3600 * 1000;

  const now = FieldValue.serverTimestamp();

  // -------------------------------------------------------------------------
  // TRANSIÇÃO 1: FASE DE GRUPOS -> PLAYOFFS (MD5)
  // -------------------------------------------------------------------------
  if (currentStage === 'groups') {
    const groupMatches = allMatches.filter((m) => m.data.stage === 'groups');
    if (groupMatches.length === 0) {
      return {
        ok: false,
        status: 400,
        error: 'Nenhuma partida de fase de grupos encontrada para este campeonato.',
      };
    }

    const incomplete = groupMatches.filter((m) => m.data.status !== 'completed');
    if (incomplete.length > 0) {
      return {
        ok: false,
        status: 409,
        error: `Ainda existem ${incomplete.length} confronto(s) pendente(s) na fase de grupos. Todos os resultados devem estar confirmados antes de avançar.`,
      };
    }

    const recalc = await recalculateTournamentStandings(db, tournamentId);
    if (!recalc.ok) return recalc;

    if (recalc.hasUnresolvedTies) {
      const tiedGroups = recalc.groups
        .filter((g) => g.unresolvedTieTeamIds.length > 0)
        .map((g) => `Grupo ${g.name}`)
        .join(', ');
      return {
        ok: false,
        status: 409,
        error: `Empate não resolvido em ${tiedGroups} após pontos, confronto direto e vitórias. Configure o critério adicional ou registre a decisão administrativa antes de gerar os playoffs.`,
      };
    }

    const groups = recalc.groups;
    let pairingsToCreate: PlayoffBracketPairing[] = [];

    if (groups.length === 2) {
      // Regra padrão NXF para 2 grupos: 1º A × 2º B e 1º B × 2º A em MD5
      pairingsToCreate = [
        {
          slot: 'SF1',
          label: 'Semifinal 1 (1º A × 2º B)',
          teamAKey: `${groups[0].name}:1`,
          teamBKey: `${groups[1].name}:2`,
          format: rules.playoffMatchFormat,
        },
        {
          slot: 'SF2',
          label: 'Semifinal 2 (1º B × 2º A)',
          teamAKey: `${groups[1].name}:1`,
          teamBKey: `${groups[0].name}:2`,
          format: rules.playoffMatchFormat,
        },
      ];
    } else if (groups.length === 1) {
      pairingsToCreate = [
        {
          slot: 'FINAL',
          label: 'Grande Final (1º A × 2º A)',
          teamAKey: `${groups[0].name}:1`,
          teamBKey: `${groups[0].name}:2`,
          format: rules.finalMatchFormat,
        },
      ];
    } else {
      // >2 grupos: exige definição administrativa explícita de chaveamento antes de gerar playoffs
      const configuredBracket =
        options.playoffBracketConfig && options.playoffBracketConfig.length > 0
          ? options.playoffBracketConfig
          : Array.isArray(tournament.playoffBracketConfig)
            ? (tournament.playoffBracketConfig as PlayoffBracketPairing[])
            : [];

      if (configuredBracket.length === 0) {
        return {
          ok: false,
          status: 400,
          error: `Este campeonato possui ${groups.length} grupos. Defina explicitamente o chaveamento administrativo dos playoffs (ex.: A:1 × B:2, C:1 × D:2) antes de gerar a próxima fase.`,
        };
      }
      pairingsToCreate = configuredBracket;
    }

    // Valida todos os cruzamentos antes de gravar
    const resolvedPairings: Array<{
      slot: string;
      label: string;
      teamA: { teamId: string; teamName: string };
      teamB: { teamId: string; teamName: string };
      format: MatchFormat;
    }> = [];
    const usedTeamIds = new Set<string>();

    for (const pair of pairingsToCreate) {
      const teamA = resolveQualifierKey(groups, pair.teamAKey);
      const teamB = resolveQualifierKey(groups, pair.teamBKey);
      if (!teamA || !teamB) {
        return {
          ok: false,
          status: 400,
          error: `Chaveamento inválido no slot ${pair.slot}: não foi possível resolver ${pair.teamAKey} × ${pair.teamBKey}.`,
        };
      }
      if (teamA.teamId === teamB.teamId) {
        return {
          ok: false,
          status: 400,
          error: `Chaveamento inválido no slot ${pair.slot}: a mesma equipe não pode enfrentar a si mesma.`,
        };
      }
      if (usedTeamIds.has(teamA.teamId) || usedTeamIds.has(teamB.teamId)) {
        return {
          ok: false,
          status: 400,
          error: `Chaveamento inválido no slot ${pair.slot}: equipe duplicada na mesma rodada dos playoffs.`,
        };
      }
      usedTeamIds.add(teamA.teamId);
      usedTeamIds.add(teamB.teamId);
      resolvedPairings.push({
        slot: pair.slot,
        label: pair.label || pair.slot,
        teamA,
        teamB,
        format: pair.format || rules.playoffMatchFormat,
      });
    }

    const nextStage: TournamentStage = resolvedPairings.length === 1 && resolvedPairings[0].slot === 'FINAL'
      ? 'final'
      : 'playoffs';

    const batch = db.batch();

    // Trava todas as partidas da fase de grupos contra edições indevidas
    for (const gm of groupMatches) {
      batch.set(gm.ref, { locked: true, updatedAt: now }, { merge: true });
    }

    // Gera os confrontos da próxima fase (Playoffs em MD5)
    for (let i = 0; i < resolvedPairings.length; i++) {
      const rp = resolvedPairings[i];
      const matchRef = db.collection('matches').doc();
      batch.set(matchRef, {
        tournamentId,
        tournamentName: String(tournament.name || tournamentId),
        teamId: rp.teamA.teamId,
        teamName: rp.teamA.teamName,
        opponentName: rp.teamB.teamName,
        teamAId: rp.teamA.teamId,
        teamAName: rp.teamA.teamName,
        teamBId: rp.teamB.teamId,
        teamBName: rp.teamB.teamName,
        stage: nextStage === 'final' ? 'final' : 'playoffs',
        bracketSlot: rp.slot,
        round: 1,
        format: rp.format,
        seriesBestOf: seriesBestOfForFormat(rp.format),
        scheduledAt: Timestamp.fromMillis(baseStartMs + i * 2 * 3600 * 1000),
        status: 'scheduled',
        nxfScore: 0,
        opponentScore: 0,
        locked: false,
        resultSource: 'manual',
        games: [],
        maps: [],
        isPublic: tournament.isPublic !== false,
        enteredBy: actor.uid,
        createdAt: now,
        updatedAt: now,
      });
    }

    const nextLockedStages = Array.from(new Set([...lockedStages, 'groups']));
    batch.set(
      tRef,
      {
        currentStage: nextStage,
        lockedStages: nextLockedStages,
        playoffBracketConfig: pairingsToCreate,
        groupStageClosedAt: now,
        playoffsGeneratedAt: now,
        updatedAt: now,
      },
      { merge: true }
    );

    batch.set(db.collection('auditLogs').doc(), {
      actorUid: actor.uid,
      actorLabel: actor.displayName,
      action: 'ADVANCE_TOURNAMENT_TO_PLAYOFFS',
      entityType: 'tournaments',
      entityId: tournamentId,
      summary: `Fase de grupos encerrada e travada. ${resolvedPairings.length} confronto(s) de ${nextStage} gerado(s) em ${rules.playoffMatchFormat}.`,
      createdAt: now,
    });

    await batch.commit();
    return {
      ok: true,
      nextStage,
      createdMatchesCount: resolvedPairings.length,
    };
  }

  // -------------------------------------------------------------------------
  // TRANSIÇÃO 2: PLAYOFFS -> GRANDE FINAL (MD5) ou PRÓXIMA RODADA DE PLAYOFFS
  // -------------------------------------------------------------------------
  if (currentStage === 'playoffs') {
    const playoffMatches = allMatches.filter((m) => m.data.stage === 'playoffs');
    if (playoffMatches.length === 0) {
      return { ok: false, status: 400, error: 'Nenhuma partida de playoffs encontrada.' };
    }

    const maxRound = Math.max(...playoffMatches.map((m) => Number(m.data.round || 1)));
    const currentRoundMatches = playoffMatches
      .filter((m) => Number(m.data.round || 1) === maxRound)
      .sort((a, b) => String(a.data.bracketSlot || '').localeCompare(String(b.data.bracketSlot || '')));

    const incomplete = currentRoundMatches.filter((m) => m.data.status !== 'completed');
    if (incomplete.length > 0) {
      return {
        ok: false,
        status: 409,
        error: `Existem ${incomplete.length} confronto(s) de playoffs ainda não concluído(s).`,
      };
    }

    const winners = currentRoundMatches
      .map((m) => {
        const wId = m.data.winnerTeamId;
        if (!wId) return null;
        const isA = wId === (m.data.teamAId || m.data.teamId);
        return {
          teamId: wId,
          teamName: isA ? m.data.teamAName || m.data.teamName : m.data.teamBName || m.data.opponentName,
        };
      })
      .filter((w): w is { teamId: string; teamName: string } => w !== null);

    if (winners.length < 2 || winners.length % 2 !== 0) {
      return {
        ok: false,
        status: 400,
        error: `Número de vencedores (${winners.length}) incompatível para pareamento automático da próxima rodada.`,
      };
    }

    const isFinalRound = winners.length === 2;
    const nextStage: TournamentStage = isFinalRound ? 'final' : 'playoffs';
    const nextFormat = isFinalRound ? rules.finalMatchFormat : rules.playoffMatchFormat;
    const batch = db.batch();

    // Trava partidas concluídas da rodada atual
    for (const pm of currentRoundMatches) {
      batch.set(pm.ref, { locked: true, updatedAt: now }, { merge: true });
    }

    let created = 0;
    for (let i = 0; i < winners.length; i += 2) {
      const a = winners[i];
      const b = winners[i + 1];
      const matchRef = db.collection('matches').doc();
      batch.set(matchRef, {
        tournamentId,
        tournamentName: String(tournament.name || tournamentId),
        teamId: a.teamId,
        teamName: a.teamName,
        opponentName: b.teamName,
        teamAId: a.teamId,
        teamAName: a.teamName,
        teamBId: b.teamId,
        teamBName: b.teamName,
        stage: isFinalRound ? 'final' : 'playoffs',
        bracketSlot: isFinalRound ? 'FINAL' : `R${maxRound + 1}_M${i / 2 + 1}`,
        round: maxRound + 1,
        format: nextFormat,
        seriesBestOf: seriesBestOfForFormat(nextFormat),
        scheduledAt: Timestamp.fromMillis(baseStartMs + created * 2 * 3600 * 1000),
        status: 'scheduled',
        nxfScore: 0,
        opponentScore: 0,
        locked: false,
        resultSource: 'manual',
        games: [],
        maps: [],
        isPublic: tournament.isPublic !== false,
        enteredBy: actor.uid,
        createdAt: now,
        updatedAt: now,
      });
      created += 1;
    }

    const nextLockedStages = isFinalRound
      ? Array.from(new Set([...lockedStages, 'playoffs']))
      : lockedStages;

    batch.set(
      tRef,
      {
        currentStage: nextStage,
        lockedStages: nextLockedStages,
        updatedAt: now,
      },
      { merge: true }
    );

    batch.set(db.collection('auditLogs').doc(), {
      actorUid: actor.uid,
      actorLabel: actor.displayName,
      action: isFinalRound ? 'ADVANCE_TOURNAMENT_TO_FINAL' : 'ADVANCE_PLAYOFF_ROUND',
      entityType: 'tournaments',
      entityId: tournamentId,
      summary: isFinalRound
        ? `Grande Final (${nextFormat}) gerada entre ${winners[0].teamName} × ${winners[1].teamName}.`
        : `Nova rodada de playoffs gerada com ${created} confronto(s) em ${nextFormat}.`,
      createdAt: now,
    });

    await batch.commit();
    return {
      ok: true,
      nextStage,
      createdMatchesCount: created,
    };
  }

  // -------------------------------------------------------------------------
  // TRANSIÇÃO 3: GRANDE FINAL -> CAMPEONATO CONCLUÍDO
  // -------------------------------------------------------------------------
  if (currentStage === 'final') {
    const finalMatches = allMatches.filter((m) => m.data.stage === 'final');
    const finalMatch = finalMatches[0];
    if (!finalMatch || finalMatch.data.status !== 'completed' || !finalMatch.data.winnerTeamId) {
      return {
        ok: false,
        status: 409,
        error: 'A Grande Final precisa estar encerrada com vencedor definido antes de finalizar o campeonato.',
      };
    }

    const isA = finalMatch.data.winnerTeamId === (finalMatch.data.teamAId || finalMatch.data.teamId);
    const championTeamId = finalMatch.data.winnerTeamId;
    const championTeamName = isA
      ? finalMatch.data.teamAName || finalMatch.data.teamName
      : finalMatch.data.teamBName || finalMatch.data.opponentName;

    const batch = db.batch();
    for (const fm of finalMatches) {
      batch.set(fm.ref, { locked: true, updatedAt: now }, { merge: true });
    }
    batch.set(
      tRef,
      {
        status: 'completed',
        currentStage: 'completed',
        lockedStages: Array.from(new Set([...lockedStages, 'groups', 'playoffs', 'final'])),
        championTeamId,
        championTeamName,
        updatedAt: now,
      },
      { merge: true }
    );
    batch.set(db.collection('auditLogs').doc(), {
      actorUid: actor.uid,
      actorLabel: actor.displayName,
      action: 'COMPLETE_TOURNAMENT',
      entityType: 'tournaments',
      entityId: tournamentId,
      summary: `Campeonato encerrado. Campeão oficial: ${championTeamName}.`,
      createdAt: now,
    });

    await batch.commit();
    return {
      ok: true,
      nextStage: 'completed',
      createdMatchesCount: 0,
      championTeamName,
    };
  }

  return {
    ok: false,
    status: 400,
    error: `Não é possível avançar a partir do estágio atual (${currentStage}).`,
  };
}
