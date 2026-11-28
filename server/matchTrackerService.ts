import crypto from 'node:crypto';
import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { getAdminServices } from './firebaseAdmin.ts';
import { isValidId } from './permissions.ts';
import {
  fetchPlayerBattlelog,
  normalizeBrawlTag,
  persistDeduplicatedBattles,
  recordBrawlSyncLog,
  resolvePlayerOutcomeInBattle,
  type BrawlServiceDeps,
  type ParsedBrawlBattle,
} from './brawlStarsService.ts';
import {
  recordTournamentMatchResult,
  type TournamentActor,
  type TournamentMatchRecord,
  type TournamentParticipant,
} from './tournamentService.ts';

const TRACKER_JOB_DOC = 'systemJobs/matchTrackerSync';
const TRACKER_LEASE_MS = 5 * 60 * 1000;
const TRACKER_MIN_INTERVAL_MS = 5 * 60 * 1000;
const TRACKER_RATE_LIMIT_MS = 180;
const MATCH_WINDOW_BEFORE_MS = 30 * 60 * 1000; // 30 min antes do horário agendado
const MATCH_WINDOW_AFTER_MS = 6 * 60 * 60 * 1000; // 6h após o horário agendado

const NON_3V3_MODES = new Set([
  'soloshowdown',
  'duoshowdown',
  'trioshowdown',
  'biggame',
  'bossfight',
  'roborumble',
]);

export interface ActiveMatchContext {
  matchId: string;
  tournamentId: string;
  tournamentName: string;
  match: TournamentMatchRecord;
  scheduledAtMs: number;
  teamAId: string;
  teamAName: string;
  teamBId: string;
  teamBName: string;
  teamATags: string[];
  teamBTags: string[];
}

export interface BattleMatchEvaluation {
  disposition: 'auto_confirm' | 'pending_review' | 'ignore';
  matchContext?: ActiveMatchContext;
  winnerSide: 'teamA' | 'teamB' | 'unknown';
  matchedTeamATags: string[];
  matchedTeamBTags: string[];
  teamABrawlers: string[];
  teamBBrawlers: string[];
  reasons: string[];
}

export interface MatchTrackerRunResult {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  polledPlayers: number;
  newBattles: number;
  duplicateBattles: number;
  autoRegisteredGames: number;
  pendingConfirmations: number;
  errorCount: number;
  error?: string | null;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function toMillis(val: unknown): number {
  if (!val) return 0;
  if (typeof val === 'number') return val;
  if (val instanceof Date) return val.getTime();
  if (
    typeof val === 'object' &&
    val !== null &&
    'toMillis' in val &&
    typeof (val as { toMillis: () => number }).toMillis === 'function'
  ) {
    return (val as { toMillis: () => number }).toMillis();
  }
  if (typeof val === 'string') {
    const parsed = Date.parse(val);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/**
 * Avalia de forma conservadora se uma batalha real do battlelog corresponde a um confronto de torneio.
 *
 * Princípio de integridade NXF:
 * - Somente retorna `auto_confirm` quando a correspondência for INEQUÍVOCA (janela horária, ambos os lados
 *   identificados com tags verificadas em lados opostos, zero sobreposição, resultado consistente, modo 3v3).
 * - Qualquer ambiguidade (apenas um time encontrado, empate, conflito de perspectiva, múltiplas partidas na janela
 *   ou cobertura parcial de elenco) é encaminhada para `pending_review` (fila de confirmação administrativa).
 */
export function evaluateBattleForMatches(
  battle: ParsedBrawlBattle,
  activeMatches: ActiveMatchContext[]
): BattleMatchEvaluation {
  const modeLower = battle.mode.toLowerCase().replace(/[^a-z0-9]/g, '');
  const isTwoTeamBattle = Array.isArray(battle.teams) && battle.teams.length === 2;

  const candidates: Array<{
    ctx: ActiveMatchContext;
    matchedA: string[];
    matchedB: string[];
    teamABrawlers: string[];
    teamBBrawlers: string[];
    winnerSide: 'teamA' | 'teamB' | 'unknown';
    unambiguous: boolean;
    reasons: string[];
  }> = [];

  for (const ctx of activeMatches) {
    if (ctx.match.locked === true) continue;
    if (ctx.match.status !== 'scheduled' && ctx.match.status !== 'live_manual') continue;

    // Já vinculada neste confronto -> ignorar para evitar duplicidade
    if (
      Array.isArray(ctx.match.games) &&
      ctx.match.games.some((g) => g.battleId === battle.battleId)
    ) {
      continue;
    }

    // Validação de janela temporal
    const windowStart = ctx.scheduledAtMs - MATCH_WINDOW_BEFORE_MS;
    const windowEnd = ctx.scheduledAtMs + MATCH_WINDOW_AFTER_MS;
    if (battle.battleTimeMs < windowStart || battle.battleTimeMs > windowEnd) {
      continue;
    }

    const setA = new Set(ctx.teamATags.map((t) => normalizeBrawlTag(t)).filter(Boolean));
    const setB = new Set(ctx.teamBTags.map((t) => normalizeBrawlTag(t)).filter(Boolean));

    if (!isTwoTeamBattle) {
      const anyMatchedA = battle.participantTags.filter((t) => setA.has(t));
      const anyMatchedB = battle.participantTags.filter((t) => setB.has(t));
      if (anyMatchedA.length > 0 && anyMatchedB.length > 0) {
        candidates.push({
          ctx,
          matchedA: anyMatchedA,
          matchedB: anyMatchedB,
          teamABrawlers: [],
          teamBBrawlers: [],
          winnerSide: 'unknown',
          unambiguous: false,
          reasons: ['Formato de batalha não possui exatamente 2 equipes opostas (exige revisão manual).'],
        });
      }
      continue;
    }

    const side0 = battle.teams[0];
    const side1 = battle.teams[1];

    // Testa orientação normal (A=side0, B=side1) vs invertida (A=side1, B=side0)
    const s0A = side0.filter((p) => setA.has(p.tag));
    const s1B = side1.filter((p) => setB.has(p.tag));
    const s1A = side1.filter((p) => setA.has(p.tag));
    const s0B = side0.filter((p) => setB.has(p.tag));

    const scoreNormal = s0A.length + s1B.length;
    const scoreSwapped = s1A.length + s0B.length;

    if (scoreNormal === 0 && scoreSwapped === 0) {
      continue;
    }

    const useNormal = scoreNormal >= scoreSwapped;
    const sideAPlayers = useNormal ? side0 : side1;
    const sideBPlayers = useNormal ? side1 : side0;
    const matchedA = (useNormal ? s0A : s1A).map((p) => p.tag);
    const matchedB = (useNormal ? s1B : s0B).map((p) => p.tag);
    const oppositeOverlap = useNormal
      ? s1A.length > 0 || s0B.length > 0
      : s0A.length > 0 || s1B.length > 0;

    // Se apenas 1 jogador de 1 equipe apareceu e 0 da outra, pode ser partida casual (não encher fila com ruído)
    if (matchedA.length === 0 && matchedB.length < 2) continue;
    if (matchedB.length === 0 && matchedA.length < 2) continue;

    const reasons: string[] = [];
    if (NON_3V3_MODES.has(modeLower)) {
      reasons.push(`Modo de jogo não competitivo 3v3 detectado (${battle.mode}).`);
    }
    if (oppositeOverlap) {
      reasons.push('Sobreposição de tags entre os dois lados da partida.');
    }
    if (matchedA.length === 0 || matchedB.length === 0) {
      reasons.push('Apenas uma das equipes do confronto teve tags identificadas nesta batalha.');
    }

    const minRequiredA = setA.size >= 2 ? 2 : 1;
    const minRequiredB = setB.size >= 2 ? 2 : 1;
    if (matchedA.length > 0 && matchedA.length < minRequiredA) {
      reasons.push(
        `Cobertura parcial da Equipe A (${matchedA.length}/${minRequiredA} jogadores verificados na partida).`
      );
    }
    if (matchedB.length > 0 && matchedB.length < minRequiredB) {
      reasons.push(
        `Cobertura parcial da Equipe B (${matchedB.length}/${minRequiredB} jogadores verificados na partida).`
      );
    }

    // Verifica consistência de resultado entre todas as perspectivas registradas
    const inferredSideAOutcomes = new Set<'victory' | 'defeat' | 'draw'>();
    for (const p of sideAPlayers) {
      const outcome = resolvePlayerOutcomeInBattle(battle, p.tag);
      if (outcome !== 'unknown') inferredSideAOutcomes.add(outcome);
    }
    for (const p of sideBPlayers) {
      const outcome = resolvePlayerOutcomeInBattle(battle, p.tag);
      if (outcome === 'victory') inferredSideAOutcomes.add('defeat');
      else if (outcome === 'defeat') inferredSideAOutcomes.add('victory');
      else if (outcome === 'draw') inferredSideAOutcomes.add('draw');
    }

    let winnerSide: 'teamA' | 'teamB' | 'unknown' = 'unknown';
    if (inferredSideAOutcomes.size > 1) {
      reasons.push('Conflito de perspectiva nos battlelogs coletados para esta batalha.');
    } else if (inferredSideAOutcomes.has('draw')) {
      reasons.push('Batalha terminou empatada (draw) — exige validação administrativa.');
    } else if (inferredSideAOutcomes.has('victory')) {
      winnerSide = 'teamA';
    } else if (inferredSideAOutcomes.has('defeat')) {
      winnerSide = 'teamB';
    } else {
      reasons.push('Resultado oficial (vitória/derrota) indisponível na resposta da API.');
    }

    const unambiguous =
      reasons.length === 0 &&
      winnerSide !== 'unknown' &&
      matchedA.length >= minRequiredA &&
      matchedB.length >= minRequiredB;

    candidates.push({
      ctx,
      matchedA,
      matchedB,
      teamABrawlers: sideAPlayers.map((p) => p.brawlerName),
      teamBBrawlers: sideBPlayers.map((p) => p.brawlerName),
      winnerSide,
      unambiguous,
      reasons,
    });
  }

  if (candidates.length === 0) {
    return {
      disposition: 'ignore',
      winnerSide: 'unknown',
      matchedTeamATags: [],
      matchedTeamBTags: [],
      teamABrawlers: [],
      teamBBrawlers: [],
      reasons: [],
    };
  }

  // Se mais de um confronto ativo casou com a mesma batalha, força fila de confirmação manual!
  if (candidates.length > 1) {
    candidates.sort((a, b) => b.matchedA.length + b.matchedB.length - (a.matchedA.length + a.matchedB.length));
    const best = candidates[0];
    return {
      disposition: 'pending_review',
      matchContext: best.ctx,
      winnerSide: best.winnerSide,
      matchedTeamATags: best.matchedA,
      matchedTeamBTags: best.matchedB,
      teamABrawlers: best.teamABrawlers,
      teamBBrawlers: best.teamBBrawlers,
      reasons: [
        ...best.reasons,
        `Múltiplos confrontos ativos (${candidates.length}) compatíveis com a mesma janela horária.`,
      ],
    };
  }

  const single = candidates[0];
  return {
    disposition: single.unambiguous ? 'auto_confirm' : 'pending_review',
    matchContext: single.ctx,
    winnerSide: single.winnerSide,
    matchedTeamATags: single.matchedA,
    matchedTeamBTags: single.matchedB,
    teamABrawlers: single.teamABrawlers,
    teamBBrawlers: single.teamBBrawlers,
    reasons: single.reasons,
  };
}

export async function runMatchTrackerCycle(
  options: { force?: boolean; triggeredBy?: string } = {},
  deps?: Partial<BrawlServiceDeps>
): Promise<MatchTrackerRunResult> {
  const adminServices = deps?.db ? null : getAdminServices();
  const db = deps?.db || adminServices?.db;
  if (!db) {
    return {
      ok: false,
      skipped: true,
      reason: 'admin_sdk_not_configured',
      polledPlayers: 0,
      newBattles: 0,
      duplicateBattles: 0,
      autoRegisteredGames: 0,
      pendingConfirmations: 0,
      errorCount: 0,
      error: 'Firebase Admin SDK não configurado.',
    };
  }

  const token = (deps?.token ?? process.env.BRAWL_STARS_API_TOKEN ?? '').trim();
  if (!token) {
    return {
      ok: false,
      skipped: true,
      reason: 'missing_token',
      polledPlayers: 0,
      newBattles: 0,
      duplicateBattles: 0,
      autoRegisteredGames: 0,
      pendingConfirmations: 0,
      errorCount: 0,
      error: 'BRAWL_STARS_API_TOKEN não configurado no servidor.',
    };
  }

  const startedAtMs = Date.now();
  const nowMs = deps?.nowMs ? deps.nowMs() : Date.now();
  const sleepImpl = deps?.sleepImpl || defaultSleep;
  const lockOwner = crypto.randomUUID();
  const jobRef = db.doc(TRACKER_JOB_DOC);

  const lease = await db.runTransaction(async (tx) => {
    const snap = await tx.get(jobRef);
    const data = snap.exists ? snap.data() || {} : {};
    const running =
      Boolean(data.running) &&
      typeof data.leaseUntilMs === 'number' &&
      data.leaseUntilMs > nowMs;
    if (running) {
      return { acquired: false, reason: 'already_running' };
    }
    const lastRunMs = typeof data.lastRunAtMs === 'number' ? data.lastRunAtMs : 0;
    if (!options.force && lastRunMs > 0 && nowMs - lastRunMs < TRACKER_MIN_INTERVAL_MS) {
      return { acquired: false, reason: 'interval_not_elapsed' };
    }
    tx.set(
      jobRef,
      {
        running: true,
        lockOwner,
        leaseUntilMs: nowMs + TRACKER_LEASE_MS,
        lastTriggeredBy: options.triggeredBy || 'scheduler',
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return { acquired: true, reason: 'ok' };
  });

  if (!lease.acquired) {
    return {
      ok: true,
      skipped: true,
      reason: lease.reason,
      polledPlayers: 0,
      newBattles: 0,
      duplicateBattles: 0,
      autoRegisteredGames: 0,
      pendingConfirmations: 0,
      errorCount: 0,
    };
  }

  let polledPlayers = 0;
  let newBattles = 0;
  let duplicateBattles = 0;
  let autoRegisteredGames = 0;
  let pendingConfirmations = 0;
  let errorCount = 0;
  let lastError: string | null = null;
  let lastHttpStatus: number | null = null;

  try {
    // 1. Carrega torneios em andamento habilitados para monitoramento híbrido
    const tournamentsSnap = await db
      .collection('tournaments')
      .where('status', '==', 'ongoing')
      .limit(20)
      .get();

    const activeTournaments = tournamentsSnap.docs.filter(
      (d) => d.data().rules?.resultMode !== 'manual_only'
    );

    if (activeTournaments.length === 0) {
      await jobRef.set(
        {
          running: false,
          lockOwner: null,
          leaseUntilMs: 0,
          lastRunAt: Timestamp.fromMillis(nowMs),
          lastRunAtMs: nowMs,
          lastStatus: 'no_active_tournaments',
          lastError: null,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      return {
        ok: true,
        skipped: true,
        reason: 'no_active_tournaments',
        polledPlayers: 0,
        newBattles: 0,
        duplicateBattles: 0,
        autoRegisteredGames: 0,
        pendingConfirmations: 0,
        errorCount: 0,
      };
    }

    // 2. Hidrata tags das equipes a partir de users + teamMemberships + participants
    const [membershipsSnap, usersSnap] = await Promise.all([
      db.collection('teamMemberships').where('status', '==', 'active').limit(400).get(),
      db.collection('users').where('status', '==', 'active').limit(300).get(),
    ]);

    const userTagByUid = new Map<string, string>();
    for (const u of usersSnap.docs) {
      const tag = normalizeBrawlTag(u.data().brawlTag);
      if (tag) userTagByUid.set(u.id, tag);
    }

    const rosterTagsByTeam = new Map<string, Set<string>>();
    for (const m of membershipsSnap.docs) {
      const data = m.data();
      const teamId = String(data.teamId || '');
      const tag = userTagByUid.get(String(data.uid || ''));
      if (!teamId || !tag) continue;
      if (!rosterTagsByTeam.has(teamId)) rosterTagsByTeam.set(teamId, new Set());
      rosterTagsByTeam.get(teamId)!.add(tag);
    }

    // 3. Monta contextos de partidas ativas e conjunto de tags para consulta
    const activeMatchContexts: ActiveMatchContext[] = [];
    const tagsToPoll = new Set<string>();

    for (const tDoc of activeTournaments) {
      const tData = tDoc.data();
      const participants: TournamentParticipant[] = Array.isArray(tData.participants)
        ? tData.participants
        : [];
      const partTagsByTeam = new Map<string, string[]>();
      for (const p of participants) {
        const merged = Array.from(
          new Set([
            ...(Array.isArray(p.playerTags) ? p.playerTags.map((t) => normalizeBrawlTag(t)) : []),
            ...Array.from(rosterTagsByTeam.get(p.teamId) || []),
          ])
        ).filter(Boolean);
        partTagsByTeam.set(p.teamId, merged);
      }

      const matchesSnap = await db
        .collection('matches')
        .where('tournamentId', '==', tDoc.id)
        .get();

      for (const mDoc of matchesSnap.docs) {
        const mData = mDoc.data() as TournamentMatchRecord;
        if (mData.locked === true) continue;
        if (mData.status !== 'scheduled' && mData.status !== 'live_manual') continue;

        const teamAId = mData.teamAId || mData.teamId;
        const teamBId = mData.teamBId || '';
        const teamATags = partTagsByTeam.get(teamAId) || Array.from(rosterTagsByTeam.get(teamAId) || []);
        const teamBTags = teamBId
          ? partTagsByTeam.get(teamBId) || Array.from(rosterTagsByTeam.get(teamBId) || [])
          : [];

        if (teamATags.length === 0 && teamBTags.length === 0) continue;

        teamATags.forEach((t) => tagsToPoll.add(t));
        teamBTags.forEach((t) => tagsToPoll.add(t));

        activeMatchContexts.push({
          matchId: mDoc.id,
          tournamentId: tDoc.id,
          tournamentName: String(tData.name || tDoc.id),
          match: { ...mData, id: mDoc.id },
          scheduledAtMs: toMillis(mData.scheduledAt) || nowMs,
          teamAId,
          teamAName: mData.teamAName || mData.teamName,
          teamBId,
          teamBName: mData.teamBName || mData.opponentName,
          teamATags,
          teamBTags,
        });
      }
    }

    // 4. Coleta battlelogs com rate limit + deduplicação
    const collectedByBattleId = new Map<string, ParsedBrawlBattle>();
    const tagList = Array.from(tagsToPoll).slice(0, 80);

    for (let i = 0; i < tagList.length; i++) {
      if (i > 0) await sleepImpl(TRACKER_RATE_LIMIT_MS);
      const tag = tagList[i];
      polledPlayers += 1;

      const res = await fetchPlayerBattlelog(tag, {
        token,
        apiBaseUrl: deps?.apiBaseUrl,
        fetchImpl: deps?.fetchImpl,
        sleepImpl,
      });
      lastHttpStatus = res.httpStatus;

      if (!res.ok) {
        errorCount += 1;
        lastError = res.error;
        if (res.httpStatus === 401 || res.httpStatus === 403) {
          break;
        }
        continue;
      }

      const persisted = await persistDeduplicatedBattles(db, res.battles);
      newBattles += persisted.newCount;
      duplicateBattles += persisted.duplicateCount;

      for (const battle of persisted.storedBattles) {
        const prev = collectedByBattleId.get(battle.battleId);
        if (prev) {
          collectedByBattleId.set(battle.battleId, {
            ...prev,
            perspectives: { ...prev.perspectives, ...battle.perspectives },
          });
        } else {
          collectedByBattleId.set(battle.battleId, battle);
        }
      }
    }

    // 5. Ordena batalhas cronologicamente (mais antiga primeiro) e avalia correspondência com confrontos
    const orderedBattles = Array.from(collectedByBattleId.values()).sort(
      (a, b) => a.battleTimeMs - b.battleTimeMs
    );

    const trackerActor: TournamentActor = {
      uid: 'nxf_match_tracker',
      displayName: 'NXF Match Tracker',
    };

    for (const battle of orderedBattles) {
      const evalRes = evaluateBattleForMatches(battle, activeMatchContexts);
      if (evalRes.disposition === 'ignore' || !evalRes.matchContext) continue;

      const ctx = evalRes.matchContext;
      if (evalRes.disposition === 'auto_confirm' && evalRes.winnerSide !== 'unknown') {
        const reg = await recordTournamentMatchResult(db, trackerActor, {
          matchId: ctx.matchId,
          game: {
            winnerSide: evalRes.winnerSide,
            mode: battle.mode,
            map: battle.map,
            battleTime: battle.battleTime,
            battleId: battle.battleId,
            source: 'auto_tracker',
            teamABrawlers: evalRes.teamABrawlers,
            teamBBrawlers: evalRes.teamBBrawlers,
          },
        });

        if (reg.ok && !reg.duplicateBattle) {
          autoRegisteredGames += 1;
          // Atualiza snapshot em memória para que a próxima batalha da série respeite status/games atualizados
          ctx.match.nxfScore = reg.teamAScore;
          ctx.match.opponentScore = reg.teamBScore;
          ctx.match.status = reg.status as TournamentMatchRecord['status'];
          ctx.match.games = [
            ...(ctx.match.games || []),
            {
              gameNumber: (ctx.match.games?.length || 0) + 1,
              winnerSide: evalRes.winnerSide,
              battleId: battle.battleId,
              source: 'auto_tracker',
            },
          ];
        }
      } else if (evalRes.disposition === 'pending_review') {
        const candidateId = `${ctx.matchId}_${battle.battleId}`;
        const candRef = db.doc(`matchTrackerCandidates/${candidateId}`);
        const candSnap = await candRef.get();
        if (!candSnap.exists) {
          await candRef.set({
            id: candidateId,
            tournamentId: ctx.tournamentId,
            tournamentName: ctx.tournamentName,
            matchId: ctx.matchId,
            teamAName: ctx.teamAName,
            teamBName: ctx.teamBName,
            battleId: battle.battleId,
            battleTime: battle.battleTime,
            mode: battle.mode,
            map: battle.map,
            suggestedWinnerSide: evalRes.winnerSide,
            matchedTeamATags: evalRes.matchedTeamATags,
            matchedTeamBTags: evalRes.matchedTeamBTags,
            teamABrawlers: evalRes.teamABrawlers,
            teamBBrawlers: evalRes.teamBBrawlers,
            reasons: evalRes.reasons,
            status: 'pending_review',
            createdAt: FieldValue.serverTimestamp(),
          });
          pendingConfirmations += 1;
        }
      }
    }

    const finishedAt = FieldValue.serverTimestamp();
    const finalStatus = errorCount > 0 && polledPlayers === 0 ? 'error' : errorCount > 0 ? 'partial' : 'ok';

    await Promise.all([
      jobRef.set(
        {
          running: false,
          lockOwner: null,
          leaseUntilMs: 0,
          lastRunAt: Timestamp.fromMillis(nowMs),
          lastRunAtMs: nowMs,
          lastStatus: finalStatus,
          lastHttpStatus,
          lastError,
          lastPolledPlayers: polledPlayers,
          lastNewBattles: newBattles,
          lastAutoRegisteredGames: autoRegisteredGames,
          lastPendingConfirmations: pendingConfirmations,
          updatedAt: finishedAt,
        },
        { merge: true }
      ),
      recordBrawlSyncLog(db, {
        jobType: 'match_tracker',
        status: finalStatus,
        triggeredBy: options.triggeredBy || 'scheduler',
        syncedPlayers: polledPlayers,
        newBattles,
        duplicateBattles,
        autoMatchedGames: autoRegisteredGames,
        pendingConfirmations,
        errorCount,
        httpStatus: lastHttpStatus,
        errorMessage: lastError,
        durationMs: Math.max(0, Date.now() - startedAtMs),
      }),
    ]);

    return {
      ok: finalStatus !== 'error',
      polledPlayers,
      newBattles,
      duplicateBattles,
      autoRegisteredGames,
      pendingConfirmations,
      errorCount,
      error: lastError,
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
    await recordBrawlSyncLog(db, {
      jobType: 'match_tracker',
      status: 'error',
      triggeredBy: options.triggeredBy || 'scheduler',
      syncedPlayers: polledPlayers,
      newBattles,
      duplicateBattles,
      autoMatchedGames: autoRegisteredGames,
      pendingConfirmations,
      errorCount: errorCount + 1,
      httpStatus: lastHttpStatus,
      errorMessage: errMsg,
      durationMs: Math.max(0, Date.now() - startedAtMs),
    }).catch(() => {});

    return {
      ok: false,
      polledPlayers,
      newBattles,
      duplicateBattles,
      autoRegisteredGames,
      pendingConfirmations,
      errorCount: errorCount + 1,
      error: errMsg,
    };
  }
}

export async function resolveMatchTrackerCandidate(
  db: Firestore,
  actor: TournamentActor,
  payload: {
    candidateId: string;
    decision: 'approve' | 'reject';
    winnerSideOverride?: 'teamA' | 'teamB';
    notes?: string;
  }
): Promise<
  | { ok: true; status: 'approved' | 'rejected'; matchResult?: unknown }
  | { ok: false; status: number; error: string }
> {
  if (!isValidId(payload.candidateId)) {
    return { ok: false, status: 400, error: 'ID de candidato inválido.' };
  }

  const candRef = db.doc(`matchTrackerCandidates/${payload.candidateId}`);
  const candSnap = await candRef.get();
  if (!candSnap.exists) {
    return { ok: false, status: 404, error: 'Candidato de partida não encontrado.' };
  }

  const cand = candSnap.data() || {};
  if (cand.status !== 'pending_review') {
    return { ok: false, status: 409, error: 'Este item da fila já foi revisado anteriormente.' };
  }

  const now = FieldValue.serverTimestamp();
  const cleanNotes = String(payload.notes || '').trim().slice(0, 400);

  if (payload.decision === 'reject') {
    await candRef.set(
      {
        status: 'rejected',
        resolvedBy: actor.uid,
        resolvedAt: now,
        resolutionNotes: cleanNotes,
      },
      { merge: true }
    );
    await db.collection('auditLogs').add({
      actorUid: actor.uid,
      actorLabel: actor.displayName,
      action: 'REJECT_TRACKER_CANDIDATE',
      entityType: 'matchTrackerCandidates',
      entityId: payload.candidateId,
      summary: `Batalha ${String(cand.battleId || '')} rejeitada na fila do Match Tracker para ${String(cand.teamAName || '')} × ${String(cand.teamBName || '')}.`,
      createdAt: now,
    });
    return { ok: true, status: 'rejected' };
  }

  const winnerSide =
    payload.winnerSideOverride === 'teamA' || payload.winnerSideOverride === 'teamB'
      ? payload.winnerSideOverride
      : cand.suggestedWinnerSide === 'teamA' || cand.suggestedWinnerSide === 'teamB'
        ? (cand.suggestedWinnerSide as 'teamA' | 'teamB')
        : null;

  if (!winnerSide) {
    return {
      ok: false,
      status: 400,
      error: 'Informe o vencedor (teamA ou teamB) ao aprovar uma batalha sem vencedor sugerido.',
    };
  }

  const reg = await recordTournamentMatchResult(db, actor, {
    matchId: String(cand.matchId || ''),
    game: {
      winnerSide,
      mode: String(cand.mode || ''),
      map: String(cand.map || ''),
      battleTime: String(cand.battleTime || ''),
      battleId: String(cand.battleId || ''),
      source: 'admin_confirmed',
      teamABrawlers: Array.isArray(cand.teamABrawlers) ? (cand.teamABrawlers as string[]) : undefined,
      teamBBrawlers: Array.isArray(cand.teamBBrawlers) ? (cand.teamBBrawlers as string[]) : undefined,
    },
  });

  if (!reg.ok) {
    return reg;
  }

  await candRef.set(
    {
      status: 'approved',
      resolvedBy: actor.uid,
      resolvedAt: now,
      resolutionNotes: cleanNotes,
    },
    { merge: true }
  );

  await db.collection('auditLogs').add({
    actorUid: actor.uid,
    actorLabel: actor.displayName,
    action: 'APPROVE_TRACKER_CANDIDATE',
    entityType: 'matchTrackerCandidates',
    entityId: payload.candidateId,
    summary: `Batalha ${String(cand.battleId || '')} confirmada manualmente para ${String(cand.teamAName || '')} × ${String(cand.teamBName || '')} (vencedor: ${winnerSide}).`,
    createdAt: now,
  });

  return { ok: true, status: 'approved', matchResult: reg };
}

export async function getMatchTrackerStatus(db: Firestore) {
  const [jobSnap, pendingSnap, logsSnap] = await Promise.all([
    db.doc(TRACKER_JOB_DOC).get(),
    db
      .collection('matchTrackerCandidates')
      .where('status', '==', 'pending_review')
      .limit(50)
      .get(),
    db.collection('brawlSyncLogs').where('jobType', '==', 'match_tracker').limit(20).get(),
  ]);

  const job = jobSnap.exists ? jobSnap.data() || {} : {};
  const pendingCandidates = pendingSnap.docs.map((d) => ({
    id: d.id,
    ...(d.data() as Record<string, unknown>),
  }));
  const logs = logsSnap.docs
    .map((d): Record<string, unknown> => ({ id: d.id, ...(d.data() as Record<string, unknown>) }))
    .sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt));

  return {
    running:
      Boolean(job.running) &&
      typeof job.leaseUntilMs === 'number' &&
      job.leaseUntilMs > Date.now(),
    lastRunAtMs: typeof job.lastRunAtMs === 'number' ? job.lastRunAtMs : null,
    lastStatus: String(job.lastStatus || 'idle'),
    lastError: job.lastError ? String(job.lastError) : null,
    lastPolledPlayers: Number(job.lastPolledPlayers || 0),
    lastNewBattles: Number(job.lastNewBattles || 0),
    lastAutoRegisteredGames: Number(job.lastAutoRegisteredGames || 0),
    lastPendingConfirmations: Number(job.lastPendingConfirmations || 0),
    pendingCandidates,
    logs,
  };
}

let trackerSchedulerStarted = false;

export function startMatchTrackerScheduler(): void {
  if (trackerSchedulerStarted) return;
  trackerSchedulerStarted = true;

  const runSafe = () => {
    const { configured } = getAdminServices();
    if (!configured || !process.env.BRAWL_STARS_API_TOKEN?.trim()) return;
    void runMatchTrackerCycle({ force: false, triggeredBy: 'scheduler' }).catch((err) => {
      console.warn(
        '[MatchTrackerScheduler] Falha ao executar ciclo:',
        err instanceof Error ? err.message : String(err)
      );
    });
  };

  setTimeout(runSafe, 45_000).unref();
  setInterval(runSafe, 10 * 60 * 1000).unref();
}
