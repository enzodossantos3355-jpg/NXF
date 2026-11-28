import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Award,
  BarChart3,
  Check,
  ChevronRight,
  Lock,
  Plus,
  Radar,
  RefreshCw,
  Search,
  Trophy,
  X,
} from 'lucide-react';
import {
  addDoc,
  collection,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  Timestamp,
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../../lib/firebase';
import { apiFetch } from '../../lib/apiClient';
import { useAuth } from '../../context/AuthContext';
import { formatFirestoreDate } from '../../lib/permissions';
import { EmptyState } from '../../components/common/StateViews';
import type {
  AdditionalTiebreakerPolicy,
  BrawlerStatSummary,
  BrawlSyncLog,
  MapStatSummary,
  Match,
  MatchFormat,
  MatchTrackerCandidate,
  ModeStatSummary,
  PlayerAnalytics,
  PlayoffBracketPairing,
  Team,
  TeamAnalytics,
  Tournament,
  TournamentParticipant,
} from '../../types/nxf';

type ActiveTab = 'tournaments' | 'tracker' | 'intelligence';

interface TrackerStatusResponse {
  running: boolean;
  lastRunAtMs: number | null;
  lastStatus: string;
  lastError: string | null;
  lastPolledPlayers: number;
  lastNewBattles: number;
  lastAutoRegisteredGames: number;
  lastPendingConfirmations: number;
  pendingCandidates: MatchTrackerCandidate[];
  logs: BrawlSyncLog[];
}

interface AnalyticsSummaryResponse {
  orgBrawlers: BrawlerStatSummary[];
  orgMaps: MapStatSummary[];
  orgModes: ModeStatSummary[];
  players: PlayerAnalytics[];
  teams: TeamAnalytics[];
  syncLogs: BrawlSyncLog[];
}

interface PlayerLookupResponse {
  ok: boolean;
  player?: {
    tag: string;
    name: string;
    trophies: number;
    highestTrophies: number;
    victories3v3: number;
    soloVictories: number;
    duoVictories: number;
    expLevel: number | null;
    clubTag: string | null;
    clubName: string | null;
    brawlersCount: number;
    topBrawlers: Array<{ name: string; trophies: number; highestTrophies: number; power: number }>;
  };
  error?: string;
}

const STAGE_LABELS: Record<string, string> = {
  registration: 'Inscrições',
  groups: 'Fase de Grupos',
  playoffs: 'Playoffs',
  final: 'Grande Final',
  completed: 'Encerrado',
};

export function CompetitiveAdminPage() {
  const { firebaseUser, capabilities } = useAuth();
  const [activeTab, setActiveTab] = useState<ActiveTab>('tournaments');

  const [teams, setTeams] = useState<Team[]>([]);
  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const [matches, setMatches] = useState<Match[]>([]);
  const [selectedTournamentId, setSelectedTournamentId] = useState<string>('');

  // Criação de campeonato completo (padrão NXF configurável)
  const [tName, setTName] = useState('');
  const [tDesc, setTDesc] = useState('');
  const [tGroupCount, setTGroupCount] = useState(2);
  const [tTeamsPerGroup, setTTeamsPerGroup] = useState(4);
  const [tGroupFormat, setTGroupFormat] = useState<MatchFormat>('MD3');
  const [tPlayoffFormat, setTPlayoffFormat] = useState<MatchFormat>('MD5');
  const [tFinalFormat, setTFinalFormat] = useState<MatchFormat>('MD5');
  const [tTiebreaker, setTTiebreaker] = useState<AdditionalTiebreakerPolicy>('none');
  const [tResultMode, setTResultMode] = useState<'hybrid_tracker' | 'manual_only'>('hybrid_tracker');
  const [tStartDate, setTStartDate] = useState('');
  const [tEndDate, setTEndDate] = useState('');
  const [selectedParticipantIds, setSelectedParticipantIds] = useState<string[]>([]);
  const [guestTeamName, setGuestTeamName] = useState('');
  const [guestTeamTags, setGuestTeamTags] = useState('');
  const [guestParticipants, setGuestParticipants] = useState<TournamentParticipant[]>([]);

  // Chaveamento administrativo para >2 grupos
  const [customBracket, setCustomBracket] = useState<PlayoffBracketPairing[]>([
    { slot: 'QF1', label: 'Quartas 1', teamAKey: 'A:1', teamBKey: 'B:2', format: 'MD5' },
    { slot: 'QF2', label: 'Quartas 2', teamAKey: 'B:1', teamBKey: 'A:2', format: 'MD5' },
    { slot: 'QF3', label: 'Quartas 3', teamAKey: 'C:1', teamBKey: 'D:2', format: 'MD5' },
    { slot: 'QF4', label: 'Quartas 4', teamAKey: 'D:1', teamBKey: 'C:2', format: 'MD5' },
  ]);

  // Resolução manual de empate por grupo (id1,id2,...)
  const [manualTieOrderByGroup, setManualTieOrderByGroup] = useState<Record<string, string[]>>({});

  // Partida avulsa (funcionalidade preservada)
  const [mTeamId, setMTeamId] = useState('');
  const [mOpponent, setMOpponent] = useState('');
  const [mTournamentName, setMTournamentName] = useState('');
  const [mFormat, setMFormat] = useState<MatchFormat>('MD5');
  const [mDate, setMDate] = useState('');

  // NXF Match Tracker
  const [trackerStatus, setTrackerStatus] = useState<TrackerStatusResponse | null>(null);
  const [trackerBusy, setTrackerBusy] = useState(false);

  // Inteligência Brawl Stars
  const [analytics, setAnalytics] = useState<AnalyticsSummaryResponse | null>(null);
  const [lookupTag, setLookupTag] = useState('');
  const [lookupResult, setLookupResult] = useState<PlayerLookupResponse['player'] | null>(null);
  const [intelBusy, setIntelBusy] = useState(false);

  // Estado geral de ações
  const [actionBusy, setActionBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    const u1 = onSnapshot(
      collection(db, 'teams'),
      (s) => {
        const list = s.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Team, 'id'>) }));
        setTeams(list);
        if (!mTeamId && list.length > 0) setMTeamId(list[0].id);
      },
      () => {}
    );
    const u2 = onSnapshot(
      collection(db, 'tournaments'),
      (s) => {
        const list = s.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Tournament, 'id'>) }));
        setTournaments(list);
        if (!selectedTournamentId && list.length > 0) {
          setSelectedTournamentId(list[0].id);
        }
      },
      () => {}
    );
    const u3 = onSnapshot(
      query(collection(db, 'matches'), orderBy('scheduledAt', 'desc')),
      (s) => setMatches(s.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Match, 'id'>) }))),
      () => {}
    );
    return () => {
      u1();
      u2();
      u3();
    };
  }, [mTeamId, selectedTournamentId]);

  const loadTrackerStatus = useCallback(async () => {
    if (!capabilities.canManageCompetitive) return;
    try {
      const res = await apiFetch<TrackerStatusResponse>('/api/match-tracker/status');
      setTrackerStatus(res);
    } catch {
      // Backend indisponível ou sem permissão
    }
  }, [capabilities.canManageCompetitive]);

  const loadAnalytics = useCallback(async () => {
    try {
      const res = await apiFetch<AnalyticsSummaryResponse>('/api/brawl/analytics');
      setAnalytics(res);
    } catch {
      // Backend indisponível
    }
  }, []);

  useEffect(() => {
    if (activeTab === 'tracker') void loadTrackerStatus();
    if (activeTab === 'intelligence') void loadAnalytics();
  }, [activeTab, loadTrackerStatus, loadAnalytics]);

  const selectedTournament = useMemo(
    () => tournaments.find((t) => t.id === selectedTournamentId) || tournaments[0] || null,
    [tournaments, selectedTournamentId]
  );

  const selectedTournamentMatches = useMemo(() => {
    if (!selectedTournament) return [];
    return matches
      .filter((m) => m.tournamentId === selectedTournament.id)
      .sort((a, b) => (a.round || 0) - (b.round || 0));
  }, [matches, selectedTournament]);

  const standaloneMatches = useMemo(
    () => matches.filter((m) => !m.tournamentId || m.stage === 'standalone'),
    [matches]
  );

  const toggleParticipantTeam = (teamId: string) => {
    setSelectedParticipantIds((prev) =>
      prev.includes(teamId) ? prev.filter((id) => id !== teamId) : [...prev, teamId]
    );
  };

  const handleAddGuestParticipant = () => {
    const cleanName = guestTeamName.trim();
    if (cleanName.length < 2) return;
    const id = `ext_${cleanName.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 24)}_${guestParticipants.length + 1}`;
    const tags = guestTeamTags
      .split(/[,;\s]+/)
      .map((t) => t.trim().toUpperCase())
      .filter((t) => t.length >= 3);
    setGuestParticipants((prev) => [
      ...prev,
      { teamId: id, teamName: cleanName, playerTags: tags },
    ]);
    setGuestTeamName('');
    setGuestTeamTags('');
  };

  const handleCreateTournament = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tName.trim()) return;
    setActionBusy(true);
    setErrorMsg('');
    setFeedback('');

    const participants: TournamentParticipant[] = [
      ...selectedParticipantIds.map((tid) => {
        const found = teams.find((t) => t.id === tid);
        return {
          teamId: tid,
          teamName: found?.name || tid,
          playerTags: [],
        };
      }),
      ...guestParticipants,
    ];

    try {
      const res = await apiFetch<{ ok: boolean; id: string }>('/api/tournaments', {
        method: 'POST',
        body: {
          name: tName.trim(),
          description: tDesc.trim(),
          startDateIso: tStartDate ? new Date(tStartDate).toISOString() : undefined,
          endDateIso: tEndDate ? new Date(tEndDate).toISOString() : undefined,
          isPublic: true,
          registrationOpen: true,
          participants,
          rules: {
            initialStage: 'groups',
            groupCount: tGroupCount,
            teamsPerGroup: tTeamsPerGroup,
            groupRoundFormat: 'single_round_robin',
            groupMatchFormat: tGroupFormat,
            playoffMatchFormat: tPlayoffFormat,
            finalMatchFormat: tFinalFormat,
            winPoints: 3,
            lossPoints: 0,
            qualifiersPerGroup: 2,
            additionalTiebreaker: tTiebreaker,
            resultMode: tResultMode,
          },
        },
      });
      setSelectedTournamentId(res.id);
      setTName('');
      setTDesc('');
      setSelectedParticipantIds([]);
      setGuestParticipants([]);
      setFeedback('Campeonato criado no backend com o regulamento NXF configurado.');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Falha ao criar campeonato.');
    } finally {
      setActionBusy(false);
    }
  };

  const handleGenerateGroups = async (tournamentId: string) => {
    setActionBusy(true);
    setErrorMsg('');
    setFeedback('');
    try {
      const res = await apiFetch<{ ok: boolean; groupsCount: number; matchesCreated: number }>(
        `/api/tournaments/${tournamentId}/generate-groups`,
        { method: 'POST', body: {} }
      );
      setFeedback(
        `Fase de grupos gerada: ${res.groupsCount} grupo(s) e ${res.matchesCreated} confronto(s) em turno único.`
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Erro ao gerar fase de grupos.');
    } finally {
      setActionBusy(false);
    }
  };

  const handleRecalculateStandings = async (tournamentId: string) => {
    setActionBusy(true);
    setErrorMsg('');
    setFeedback('');
    try {
      const res = await apiFetch<{ ok: boolean; hasUnresolvedTies: boolean }>(
        `/api/tournaments/${tournamentId}/recalculate-standings`,
        { method: 'POST' }
      );
      setFeedback(
        res.hasUnresolvedTies
          ? 'Classificação recalculada. Atenção: há empate persistente aguardando decisão administrativa.'
          : 'Classificação recalculada oficialmente no backend.'
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Erro ao recalcular tabela.');
    } finally {
      setActionBusy(false);
    }
  };

  const handleSaveManualTiebreak = async (tournamentId: string, groupName: string, orderedIds: string[]) => {
    setActionBusy(true);
    setErrorMsg('');
    setFeedback('');
    try {
      await apiFetch(`/api/tournaments/${tournamentId}/configure`, {
        method: 'POST',
        body: {
          manualTieBreakByGroup: {
            [groupName]: orderedIds,
          },
        },
      });
      setFeedback(`Desempate administrativo registrado para o Grupo ${groupName} e tabela recalculada.`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Erro ao registrar desempate.');
    } finally {
      setActionBusy(false);
    }
  };

  const handleAdvanceStage = async (tournament: Tournament) => {
    setActionBusy(true);
    setErrorMsg('');
    setFeedback('');
    try {
      const needsCustomBracket =
        tournament.currentStage === 'groups' && (tournament.groups?.length || 0) > 2;
      const res = await apiFetch<{
        ok: boolean;
        nextStage: string;
        createdMatchesCount: number;
        championTeamName?: string;
      }>(`/api/tournaments/${tournament.id}/advance`, {
        method: 'POST',
        body: needsCustomBracket ? { playoffBracketConfig: customBracket } : {},
      });
      setFeedback(
        res.championTeamName
          ? `Campeonato encerrado! Campeão oficial: ${res.championTeamName}.`
          : `Fase avançada para ${STAGE_LABELS[res.nextStage] || res.nextStage} (${res.createdMatchesCount} confronto(s) gerado(s)). Fase anterior travada.`
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Não foi possível avançar a fase.');
    } finally {
      setActionBusy(false);
    }
  };

  const handleRecordGame = async (match: Match, winnerSide: 'teamA' | 'teamB') => {
    setActionBusy(true);
    setErrorMsg('');
    setFeedback('');
    try {
      const res = await apiFetch<{
        ok: boolean;
        teamAScore: number;
        teamBScore: number;
        status: string;
      }>(`/api/matches/${match.id}/result`, {
        method: 'POST',
        body: {
          game: { winnerSide },
        },
      });
      setFeedback(
        `Placar atualizado (${match.teamAName || match.teamName} ${res.teamAScore} × ${res.teamBScore} ${match.teamBName || match.opponentName})${res.status === 'completed' ? ' — Confronto encerrado e classificação atualizada!' : ''}.`
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Falha ao atualizar placar.');
    } finally {
      setActionBusy(false);
    }
  };

  const handleFinalizeMatch = async (match: Match) => {
    setActionBusy(true);
    setErrorMsg('');
    setFeedback('');
    try {
      await apiFetch(`/api/matches/${match.id}/result`, {
        method: 'POST',
        body: {
          teamAScore: match.nxfScore ?? 0,
          teamBScore: match.opponentScore ?? 0,
          finalize: true,
        },
      });
      setFeedback('Série encerrada e confirmada no servidor.');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Não foi possível encerrar a série.');
    } finally {
      setActionBusy(false);
    }
  };

  const handleCreateStandaloneMatch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firebaseUser || !mTeamId || !mOpponent.trim() || !mDate) return;
    const teamObj = teams.find((t) => t.id === mTeamId);
    try {
      await addDoc(collection(db, 'matches'), {
        teamId: mTeamId,
        teamName: teamObj?.name || mTeamId,
        tournamentName: mTournamentName.trim().slice(0, 100),
        opponentName: mOpponent.trim().slice(0, 60),
        stage: 'standalone',
        format: mFormat,
        scheduledAt: Timestamp.fromDate(new Date(mDate)),
        status: 'scheduled',
        nxfScore: 0,
        opponentScore: 0,
        locked: false,
        resultSource: 'manual',
        isPublic: true,
        enteredBy: firebaseUser.uid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      setMOpponent('');
      setMTournamentName('');
      setFeedback('Partida avulsa agendada com sucesso.');
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, 'matches');
    }
  };

  const handleRunTracker = async () => {
    setTrackerBusy(true);
    setErrorMsg('');
    setFeedback('');
    try {
      const res = await apiFetch<{
        ok: boolean;
        skipped?: boolean;
        reason?: string;
        polledPlayers: number;
        newBattles: number;
        autoRegisteredGames: number;
        pendingConfirmations: number;
        error?: string | null;
      }>('/api/match-tracker/run', { method: 'POST' });
      await loadTrackerStatus();
      if (res.skipped) {
        setFeedback(`Match Tracker não executado: ${res.error || res.reason || 'sem torneios ativos'}.`);
      } else {
        setFeedback(
          `Match Tracker concluído: ${res.polledPlayers} jogador(es) verificado(s), ${res.newBattles} nova(s) batalha(s), ${res.autoRegisteredGames} jogo(s) registrado(s) automaticamente e ${res.pendingConfirmations} enviado(s) para fila de revisão.`
        );
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Falha ao executar NXF Match Tracker.');
    } finally {
      setTrackerBusy(false);
    }
  };

  const handleResolveCandidate = async (
    candidate: MatchTrackerCandidate,
    decision: 'approve' | 'reject',
    winnerSideOverride?: 'teamA' | 'teamB'
  ) => {
    setTrackerBusy(true);
    setErrorMsg('');
    setFeedback('');
    try {
      await apiFetch(`/api/match-tracker/candidates/${candidate.id}/resolve`, {
        method: 'POST',
        body: { decision, winnerSideOverride },
      });
      await loadTrackerStatus();
      setFeedback(
        decision === 'approve'
          ? `Batalha confirmada para ${candidate.teamAName} × ${candidate.teamBName}. Placar e tabela atualizados.`
          : 'Batalha descartada da fila de confirmação.'
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Erro ao processar item da fila.');
    } finally {
      setTrackerBusy(false);
    }
  };

  const handleLookupPlayer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!lookupTag.trim()) return;
    setIntelBusy(true);
    setErrorMsg('');
    setLookupResult(null);
    try {
      const encoded = encodeURIComponent(lookupTag.trim());
      const res = await apiFetch<PlayerLookupResponse>(`/api/brawl/player/${encoded}`);
      if (res.ok && res.player) {
        setLookupResult(res.player);
      } else {
        setErrorMsg(res.error || 'Tag não encontrada.');
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Falha ao consultar Tag na API oficial.');
    } finally {
      setIntelBusy(false);
    }
  };

  const handleSyncBrawlNow = async () => {
    setIntelBusy(true);
    setErrorMsg('');
    setFeedback('');
    try {
      const res = await apiFetch<{
        ok: boolean;
        syncedCount: number;
        newBattlesCount?: number;
        errorCount: number;
        error?: string | null;
      }>('/api/brawl/sync', { method: 'POST' });
      await loadAnalytics();
      if (res.ok) {
        setFeedback(
          `Sincronização concluída: ${res.syncedCount} jogador(es), ${res.newBattlesCount ?? 0} nova(s) batalha(s) no battlelog, ${res.errorCount} erro(s).`
        );
      } else {
        setErrorMsg(res.error || 'Sincronização retornou falhas.');
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Erro ao sincronizar Brawl Stars.');
    } finally {
      setIntelBusy(false);
    }
  };

  const moveTieTeam = (groupName: string, currentOrder: string[], index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= currentOrder.length) return;
    const next = [...currentOrder];
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved);
    setManualTieOrderByGroup((prev) => ({ ...prev, [groupName]: next }));
  };

  return (
    <div className="space-y-6">
      {/* Cabeçalho & Navegação por Abas */}
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4 border-b border-white/8 pb-4">
        <div>
          <h1 className="font-display text-3xl font-bold text-white">Central Competitiva NXF</h1>
          <p className="text-xs text-[#A1A1AA]">
            Campeonatos em fase de grupos MD3 e playoffs MD5, classificação oficial no backend, NXF Match Tracker e Inteligência Brawl Stars.
          </p>
        </div>

        <div className="inline-flex items-center gap-1 p-1 bg-[#15151A] border border-white/10 rounded-md self-start">
          {(
            [
              { id: 'tournaments', label: 'Campeonatos & Grupos', icon: Trophy },
              { id: 'tracker', label: 'NXF Match Tracker', icon: Radar },
              { id: 'intelligence', label: 'Inteligência Brawl', icon: BarChart3 },
            ] as const
          ).map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded transition-colors whitespace-nowrap ${
                  activeTab === tab.id
                    ? 'bg-[#DC172B] text-white'
                    : 'text-[#A1A1AA] hover:text-white'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      {feedback && (
        <div className="p-3 bg-[#15151A] border border-white/15 rounded text-xs text-white">
          {feedback}
        </div>
      )}
      {errorMsg && (
        <div className="p-3 bg-[#DC172B]/15 border border-[#DC172B]/50 rounded text-xs text-white">
          {errorMsg}
        </div>
      )}

      {/* ===================================================================== */}
      {/* ABA 1: CAMPEONATOS, GRUPOS, CLASSIFICAÇÃO & PLAYOFFS                 */}
      {/* ===================================================================== */}
      {activeTab === 'tournaments' && (
        <div className="space-y-8">
          {/* Painel de Controle do Campeonato Selecionado */}
          <section className="space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <h2 className="font-display text-2xl font-bold text-white">
                Campeonatos Ativos ({tournaments.length})
              </h2>
              {tournaments.length > 0 && (
                <select
                  value={selectedTournament?.id || ''}
                  onChange={(e) => setSelectedTournamentId(e.target.value)}
                  className="bg-[#15151A] border border-white/12 rounded px-3 py-2 text-xs text-white"
                >
                  {tournaments.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} ({STAGE_LABELS[t.currentStage || ''] || t.status})
                    </option>
                  ))}
                </select>
              )}
            </div>

            {!selectedTournament ? (
              <EmptyState
                title="Nenhum campeonato configurado"
                description="Crie um campeonato abaixo com as regras oficiais NXF (grupos MD3, turno único, top 2 para playoffs MD5)."
              />
            ) : (
              <div className="bg-[#15151A] border border-white/8 rounded-lg p-5 space-y-6">
                {/* Resumo do Campeonato & Ações de Fase */}
                <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-white/8 pb-4">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-[#EF3340] font-semibold">
                      <span>{STAGE_LABELS[selectedTournament.currentStage || 'registration']}</span>
                      <span className="text-[#71717A]">·</span>
                      <span className="text-[#A1A1AA] font-mono-tabular">
                        {selectedTournament.rules?.groupCount ?? 2} grupos ×{' '}
                        {selectedTournament.rules?.teamsPerGroup ?? 4} equipes
                      </span>
                      <span className="text-[#71717A]">·</span>
                      <span className="text-[#A1A1AA]">
                        Grupos {selectedTournament.rules?.groupMatchFormat ?? 'MD3'} · Playoffs{' '}
                        {selectedTournament.rules?.playoffMatchFormat ?? 'MD5'}
                      </span>
                      {selectedTournament.lockedStages && selectedTournament.lockedStages.length > 0 && (
                        <span className="inline-flex items-center gap-1 text-[#A1A1AA]">
                          <Lock className="w-3 h-3" /> Travado:{' '}
                          {selectedTournament.lockedStages.join(', ')}
                        </span>
                      )}
                    </div>
                    <h3 className="font-display text-2xl font-bold text-white">
                      {selectedTournament.name}
                    </h3>
                    {selectedTournament.description && (
                      <p className="text-xs text-[#A1A1AA]">{selectedTournament.description}</p>
                    )}
                    <p className="text-[11px] text-[#71717A]">
                      Vitória = {selectedTournament.rules?.winPoints ?? 3} pts · Derrota ={' '}
                      {selectedTournament.rules?.lossPoints ?? 0} pts · Desempate: 1) Pontos 2) Confronto Direto 3) Vitórias
                      {selectedTournament.rules?.additionalTiebreaker &&
                      selectedTournament.rules.additionalTiebreaker !== 'none'
                        ? ` 4) ${selectedTournament.rules.additionalTiebreaker}`
                        : ' 4) Decisão administrativa'}
                    </p>
                  </div>

                  {capabilities.canManageCompetitive && (
                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                      {(selectedTournament.currentStage === 'registration' ||
                        !selectedTournament.currentStage) && (
                        <button
                          type="button"
                          disabled={actionBusy}
                          onClick={() => void handleGenerateGroups(selectedTournament.id)}
                          className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-[#DC172B] hover:bg-[#EF3340] disabled:opacity-50 rounded text-xs font-semibold text-white"
                        >
                          Gerar Grupos e Confrontos MD3
                          <ChevronRight className="w-3.5 h-3.5" />
                        </button>
                      )}
                      {selectedTournament.currentStage === 'groups' && (
                        <>
                          <button
                            type="button"
                            disabled={actionBusy}
                            onClick={() => void handleRecalculateStandings(selectedTournament.id)}
                            className="inline-flex items-center gap-1.5 px-3 py-2 bg-[#202027] hover:bg-[#2B2B35] border border-white/10 rounded text-xs font-medium text-white"
                          >
                            <RefreshCw className="w-3.5 h-3.5" />
                            Recalcular Tabela
                          </button>
                          <button
                            type="button"
                            disabled={actionBusy}
                            onClick={() => void handleAdvanceStage(selectedTournament)}
                            className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-[#DC172B] hover:bg-[#EF3340] disabled:opacity-50 rounded text-xs font-semibold text-white"
                          >
                            Encerrar Grupos e Gerar Playoffs MD5
                            <ChevronRight className="w-3.5 h-3.5" />
                          </button>
                        </>
                      )}
                      {selectedTournament.currentStage === 'playoffs' && (
                        <button
                          type="button"
                          disabled={actionBusy}
                          onClick={() => void handleAdvanceStage(selectedTournament)}
                          className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-[#DC172B] hover:bg-[#EF3340] disabled:opacity-50 rounded text-xs font-semibold text-white"
                        >
                          Gerar Grande Final MD5
                          <ChevronRight className="w-3.5 h-3.5" />
                        </button>
                      )}
                      {selectedTournament.currentStage === 'final' && (
                        <button
                          type="button"
                          disabled={actionBusy}
                          onClick={() => void handleAdvanceStage(selectedTournament)}
                          className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-[#DC172B] hover:bg-[#EF3340] disabled:opacity-50 rounded text-xs font-semibold text-white"
                        >
                          <Award className="w-3.5 h-3.5" />
                          Consagrar Campeão e Encerrar
                        </button>
                      )}
                    </div>
                  )}
                </div>

                {selectedTournament.championTeamName && (
                  <div className="bg-[#0D0D10] border border-[#DC172B]/50 rounded-md p-4 flex items-center gap-3">
                    <Award className="w-6 h-6 text-[#EF3340]" />
                    <div>
                      <p className="text-[11px] uppercase tracking-wider text-[#A1A1AA]">
                        Campeão Oficial do Torneio
                      </p>
                      <p className="text-lg font-bold text-white">
                        {selectedTournament.championTeamName}
                      </p>
                    </div>
                  </div>
                )}

                {/* Definição Administrativa de Chaveamento (obrigatória quando >2 grupos) */}
                {capabilities.canManageCompetitive &&
                  selectedTournament.currentStage === 'groups' &&
                  (selectedTournament.groups?.length || 0) > 2 && (
                    <div className="bg-[#0D0D10] border border-[#D97706]/40 rounded-md p-4 space-y-3">
                      <div className="flex items-center justify-between">
                        <p className="text-xs font-semibold text-white flex items-center gap-2">
                          <AlertTriangle className="w-4 h-4 text-[#D97706]" />
                          Chaveamento Administrativo Obrigatório ({selectedTournament.groups?.length} grupos)
                        </p>
                        <button
                          type="button"
                          onClick={() =>
                            setCustomBracket((prev) => [
                              ...prev,
                              {
                                slot: `P${prev.length + 1}`,
                                label: `Confronto ${prev.length + 1}`,
                                teamAKey: 'A:1',
                                teamBKey: 'B:2',
                                format: 'MD5',
                              },
                            ])
                          }
                          className="text-[11px] text-[#EF3340] hover:underline"
                        >
                          + Adicionar cruzamento
                        </button>
                      </div>
                      <p className="text-[11px] text-[#A1A1AA]">
                        Para campeonatos com mais de 2 grupos, defina explicitamente os cruzamentos no formato <code className="text-white">Grupo:Posição</code> (ex.: <code className="text-white">A:1 × B:2</code>) antes de clicar em gerar playoffs.
                      </p>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                        {customBracket.map((pair, idx) => (
                          <div
                            key={idx}
                            className="flex items-center gap-2 bg-[#15151A] border border-white/8 rounded p-2 text-xs"
                          >
                            <input
                              type="text"
                              value={pair.slot}
                              onChange={(e) =>
                                setCustomBracket((prev) =>
                                  prev.map((p, i) => (i === idx ? { ...p, slot: e.target.value } : p))
                                )
                              }
                              className="w-16 bg-[#0D0D10] border border-white/10 rounded px-2 py-1 font-mono-tabular text-white"
                            />
                            <input
                              type="text"
                              value={pair.teamAKey}
                              onChange={(e) =>
                                setCustomBracket((prev) =>
                                  prev.map((p, i) =>
                                    i === idx ? { ...p, teamAKey: e.target.value.toUpperCase() } : p
                                  )
                                )
                              }
                              placeholder="A:1"
                              className="w-16 bg-[#0D0D10] border border-white/10 rounded px-2 py-1 font-mono-tabular text-white"
                            />
                            <span className="text-[#71717A]">×</span>
                            <input
                              type="text"
                              value={pair.teamBKey}
                              onChange={(e) =>
                                setCustomBracket((prev) =>
                                  prev.map((p, i) =>
                                    i === idx ? { ...p, teamBKey: e.target.value.toUpperCase() } : p
                                  )
                                )
                              }
                              placeholder="B:2"
                              className="w-16 bg-[#0D0D10] border border-white/10 rounded px-2 py-1 font-mono-tabular text-white"
                            />
                            <button
                              type="button"
                              onClick={() =>
                                setCustomBracket((prev) => prev.filter((_, i) => i !== idx))
                              }
                              className="ml-auto text-[#71717A] hover:text-white"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                {/* Tabelas de Classificação dos Grupos */}
                {Array.isArray(selectedTournament.groups) && selectedTournament.groups.length > 0 && (
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    {selectedTournament.groups.map((grp) => {
                      const hasUnresolved = (grp.unresolvedTieTeamIds?.length || 0) > 0;
                      const currentOrder =
                        manualTieOrderByGroup[grp.name] ||
                        grp.standings.map((r) => r.teamId || r.team);

                      return (
                        <div
                          key={grp.name}
                          className="bg-[#0D0D10] border border-white/8 rounded-md p-4 space-y-3"
                        >
                          <div className="flex items-center justify-between border-b border-white/8 pb-2">
                            <h4 className="text-sm font-bold text-white">Grupo {grp.name}</h4>
                            <span className="text-[11px] font-mono-tabular text-[#A1A1AA]">
                              {grp.teamIds.length} equipes · Top {selectedTournament.rules?.qualifiersPerGroup ?? 2}
                            </span>
                          </div>

                          <div className="overflow-x-auto">
                            <table className="w-full min-w-[340px] text-xs">
                              <thead>
                                <tr className="text-[#71717A] border-b border-white/8">
                                  <th className="py-1.5 text-left">#</th>
                                  <th className="py-1.5 text-left">Equipe</th>
                                  <th className="py-1.5 text-right">J</th>
                                  <th className="py-1.5 text-right">V</th>
                                  <th className="py-1.5 text-right">D</th>
                                  <th className="py-1.5 text-right">SG</th>
                                  <th className="py-1.5 text-right">Pts</th>
                                </tr>
                              </thead>
                              <tbody>
                                {grp.standings.map((row) => (
                                  <tr
                                    key={row.teamId || row.team}
                                    className="border-b border-white/5 last:border-none"
                                  >
                                    <td className="py-2 font-mono-tabular">
                                      <span
                                        className={
                                          row.qualified
                                            ? 'text-[#16A34A] font-bold'
                                            : row.tieStatus === 'unresolved'
                                              ? 'text-[#D97706] font-bold'
                                              : 'text-[#A1A1AA]'
                                        }
                                      >
                                        {row.position}º
                                      </span>
                                    </td>
                                    <td className="py-2 font-medium text-white">
                                      {row.team}
                                      {row.tieNote && (
                                        <span
                                          className={`block text-[10px] ${
                                            row.tieStatus === 'unresolved'
                                              ? 'text-[#D97706]'
                                              : 'text-[#71717A]'
                                          }`}
                                        >
                                          {row.tieNote}
                                        </span>
                                      )}
                                    </td>
                                    <td className="py-2 text-right font-mono-tabular text-[#A1A1AA]">
                                      {row.played ?? 0}
                                    </td>
                                    <td className="py-2 text-right font-mono-tabular text-white">
                                      {row.wins}
                                    </td>
                                    <td className="py-2 text-right font-mono-tabular text-[#A1A1AA]">
                                      {row.losses}
                                    </td>
                                    <td className="py-2 text-right font-mono-tabular text-[#A1A1AA]">
                                      {(row.gameDiff ?? 0) > 0
                                        ? `+${row.gameDiff}`
                                        : (row.gameDiff ?? 0)}
                                    </td>
                                    <td className="py-2 text-right font-mono-tabular font-bold text-white">
                                      {row.points}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>

                          {/* Resolução Administrativa para Empate Persistente */}
                          {hasUnresolved && capabilities.canManageCompetitive && (
                            <div className="pt-3 border-t border-[#D97706]/30 space-y-2">
                              <p className="text-[11px] font-semibold text-[#D97706] flex items-center gap-1.5">
                                <AlertTriangle className="w-3.5 h-3.5" />
                                Empate persistente — ordene a decisão administrativa:
                              </p>
                              <div className="space-y-1">
                                {currentOrder.map((tid, idx) => {
                                  const label =
                                    grp.standings.find((r) => r.teamId === tid)?.team || tid;
                                  return (
                                    <div
                                      key={tid}
                                      className="flex items-center justify-between bg-[#15151A] border border-white/8 rounded px-2.5 py-1.5 text-xs"
                                    >
                                      <span className="font-mono-tabular text-white">
                                        {idx + 1}º · {label}
                                      </span>
                                      <div className="flex gap-1">
                                        <button
                                          type="button"
                                          onClick={() => moveTieTeam(grp.name, currentOrder, idx, -1)}
                                          className="px-2 py-0.5 bg-[#202027] rounded text-[10px] text-white"
                                        >
                                          Subir
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => moveTieTeam(grp.name, currentOrder, idx, 1)}
                                          className="px-2 py-0.5 bg-[#202027] rounded text-[10px] text-white"
                                        >
                                          Descer
                                        </button>
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                              <button
                                type="button"
                                disabled={actionBusy}
                                onClick={() =>
                                  void handleSaveManualTiebreak(
                                    selectedTournament.id,
                                    grp.name,
                                    currentOrder
                                  )
                                }
                                className="px-3 py-1.5 bg-[#DC172B] hover:bg-[#EF3340] rounded text-[11px] font-semibold text-white"
                              >
                                Aplicar ordem de desempate
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Confrontos do Campeonato */}
                {selectedTournamentMatches.length > 0 && (
                  <div className="space-y-3 pt-2 border-t border-white/8">
                    <h4 className="text-sm font-bold text-white">
                      Confrontos do Campeonato ({selectedTournamentMatches.length})
                    </h4>
                    <div className="space-y-2.5">
                      {selectedTournamentMatches.map((m) => (
                        <div
                          key={m.id}
                          className="bg-[#0D0D10] border border-white/8 rounded-md p-3.5 flex flex-col md:flex-row md:items-center justify-between gap-3"
                        >
                          <div className="space-y-0.5">
                            <p className="text-[11px] text-[#A1A1AA] font-mono-tabular">
                              {m.stage === 'groups'
                                ? `Grupo ${m.groupName} · Rodada ${m.round ?? 1}`
                                : m.stage === 'final'
                                  ? 'GRANDE FINAL'
                                  : `Playoffs · ${m.bracketSlot || 'Chave'}`}{' '}
                              · {m.format} · {formatFirestoreDate(m.scheduledAt)} · {m.status}
                              {m.locked ? ' · TRAVADA' : ''}
                            </p>
                            <p className="text-sm font-bold text-white font-mono-tabular">
                              {m.teamAName || m.teamName} ({m.nxfScore ?? 0}) × ({m.opponentScore ?? 0}){' '}
                              {m.teamBName || m.opponentName}
                            </p>
                          </div>

                          {capabilities.canManageCompetitive && !m.locked && m.status !== 'completed' ? (
                            <div className="flex flex-wrap items-center gap-2">
                              <button
                                type="button"
                                disabled={actionBusy}
                                onClick={() => void handleRecordGame(m, 'teamA')}
                                className="px-2.5 py-1.5 bg-[#202027] hover:bg-[#2B2B35] rounded text-xs font-mono-tabular text-white"
                              >
                                +1 {m.teamAName || m.teamName}
                              </button>
                              <button
                                type="button"
                                disabled={actionBusy}
                                onClick={() => void handleRecordGame(m, 'teamB')}
                                className="px-2.5 py-1.5 bg-[#202027] hover:bg-[#2B2B35] rounded text-xs font-mono-tabular text-white"
                              >
                                +1 {m.teamBName || m.opponentName}
                              </button>
                              <button
                                type="button"
                                disabled={actionBusy}
                                onClick={() => void handleFinalizeMatch(m)}
                                className="px-3 py-1.5 bg-[#DC172B] hover:bg-[#EF3340] rounded text-xs font-semibold text-white"
                              >
                                Encerrar
                              </button>
                            </div>
                          ) : (
                            <span className="text-[11px] text-[#71717A] inline-flex items-center gap-1">
                              {m.locked && <Lock className="w-3 h-3" />}
                              {m.locked ? 'Fase encerrada' : m.status === 'completed' ? 'Concluído' : ''}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </section>

          {/* Formulários de Criação (Novo Campeonato NXF & Partida Avulsa) */}
          {capabilities.canManageCompetitive && (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
              <form
                onSubmit={handleCreateTournament}
                className="bg-[#15151A] border border-white/8 rounded-lg p-5 space-y-4"
              >
                <h2 className="text-base font-bold text-white flex items-center gap-2 border-b border-white/8 pb-3">
                  <Trophy className="w-4 h-4 text-[#EF3340]" /> Criar Campeonato (Padrão NXF)
                </h2>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <input
                    type="text"
                    required
                    minLength={3}
                    value={tName}
                    onChange={(e) => setTName(e.target.value)}
                    placeholder="Nome do campeonato"
                    className="sm:col-span-2 bg-[#0D0D10] border border-white/12 rounded px-3 py-2 text-sm text-white"
                  />
                  <textarea
                    rows={2}
                    value={tDesc}
                    onChange={(e) => setTDesc(e.target.value)}
                    placeholder="Descrição, regulamento resumido e premiação..."
                    className="sm:col-span-2 bg-[#0D0D10] border border-white/12 rounded px-3 py-2 text-xs text-white"
                  />
                  <div className="space-y-1">
                    <label className="text-[11px] text-[#A1A1AA]">Nº de Grupos</label>
                    <input
                      type="number"
                      min={1}
                      max={8}
                      value={tGroupCount}
                      onChange={(e) => setTGroupCount(Number(e.target.value))}
                      className="w-full bg-[#0D0D10] border border-white/12 rounded px-3 py-1.5 text-xs font-mono-tabular text-white"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] text-[#A1A1AA]">Equipes por Grupo</label>
                    <input
                      type="number"
                      min={2}
                      max={16}
                      value={tTeamsPerGroup}
                      onChange={(e) => setTTeamsPerGroup(Number(e.target.value))}
                      className="w-full bg-[#0D0D10] border border-white/12 rounded px-3 py-1.5 text-xs font-mono-tabular text-white"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] text-[#A1A1AA]">Formato Grupos</label>
                    <select
                      value={tGroupFormat}
                      onChange={(e) => setTGroupFormat(e.target.value as MatchFormat)}
                      className="w-full bg-[#0D0D10] border border-white/12 rounded px-2.5 py-1.5 text-xs text-white"
                    >
                      <option value="MD3">MD3 (Padrão NXF)</option>
                      <option value="MD5">MD5</option>
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] text-[#A1A1AA]">Playoffs / Final</label>
                    <div className="grid grid-cols-2 gap-1.5">
                      <select
                        value={tPlayoffFormat}
                        onChange={(e) => setTPlayoffFormat(e.target.value as MatchFormat)}
                        className="bg-[#0D0D10] border border-white/12 rounded px-2 py-1.5 text-xs text-white"
                      >
                        <option value="MD5">Playoffs MD5</option>
                        <option value="MD3">Playoffs MD3</option>
                        <option value="MD7">Playoffs MD7</option>
                      </select>
                      <select
                        value={tFinalFormat}
                        onChange={(e) => setTFinalFormat(e.target.value as MatchFormat)}
                        className="bg-[#0D0D10] border border-white/12 rounded px-2 py-1.5 text-xs text-white"
                      >
                        <option value="MD5">Final MD5</option>
                        <option value="MD7">Final MD7</option>
                      </select>
                    </div>
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] text-[#A1A1AA]">Desempate Extra (após Pts/CD/Vit)</label>
                    <select
                      value={tTiebreaker}
                      onChange={(e) => setTTiebreaker(e.target.value as AdditionalTiebreakerPolicy)}
                      className="w-full bg-[#0D0D10] border border-white/12 rounded px-2.5 py-1.5 text-xs text-white"
                    >
                      <option value="none">Exigir decisão administrativa</option>
                      <option value="game_diff">Saldo de partidas (MD3)</option>
                      <option value="games_won">Partidas vencidas</option>
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] text-[#A1A1AA]">Registro de Resultados</label>
                    <select
                      value={tResultMode}
                      onChange={(e) =>
                        setTResultMode(e.target.value as 'hybrid_tracker' | 'manual_only')
                      }
                      className="w-full bg-[#0D0D10] border border-white/12 rounded px-2.5 py-1.5 text-xs text-white"
                    >
                      <option value="hybrid_tracker">Híbrido (Match Tracker + Admin)</option>
                      <option value="manual_only">Manual Administrativo</option>
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] text-[#A1A1AA]">Início</label>
                    <input
                      type="datetime-local"
                      value={tStartDate}
                      onChange={(e) => setTStartDate(e.target.value)}
                      className="w-full bg-[#0D0D10] border border-white/12 rounded px-2.5 py-1.5 text-xs text-white"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] text-[#A1A1AA]">Previsão de término</label>
                    <input
                      type="datetime-local"
                      value={tEndDate}
                      onChange={(e) => setTEndDate(e.target.value)}
                      className="w-full bg-[#0D0D10] border border-white/12 rounded px-2.5 py-1.5 text-xs text-white"
                    />
                  </div>
                </div>

                {/* Equipes Participantes (NXF + Convidados com Tags Brawl Stars) */}
                <div className="space-y-2 pt-2 border-t border-white/8">
                  <p className="text-xs font-semibold text-white">
                    Equipes Participantes ({selectedParticipantIds.length + guestParticipants.length})
                  </p>
                  {teams.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {teams.map((team) => {
                        const checked = selectedParticipantIds.includes(team.id);
                        return (
                          <button
                            key={team.id}
                            type="button"
                            onClick={() => toggleParticipantTeam(team.id)}
                            className={`px-2.5 py-1 rounded border text-xs transition-colors ${
                              checked
                                ? 'bg-[#DC172B] border-[#DC172B] text-white font-semibold'
                                : 'bg-[#0D0D10] border-white/10 text-[#A1A1AA] hover:text-white'
                            }`}
                          >
                            {team.name}
                          </button>
                        );
                      })}
                    </div>
                  )}

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-1">
                    <input
                      type="text"
                      value={guestTeamName}
                      onChange={(e) => setGuestTeamName(e.target.value)}
                      placeholder="Equipe convidada"
                      className="bg-[#0D0D10] border border-white/12 rounded px-2.5 py-1.5 text-xs text-white"
                    />
                    <input
                      type="text"
                      value={guestTeamTags}
                      onChange={(e) => setGuestTeamTags(e.target.value)}
                      placeholder="Tags Brawl (#AAA, #BBB)"
                      className="bg-[#0D0D10] border border-white/12 rounded px-2.5 py-1.5 text-xs font-mono-tabular text-white"
                    />
                    <button
                      type="button"
                      onClick={handleAddGuestParticipant}
                      className="px-3 py-1.5 bg-[#202027] hover:bg-[#2B2B35] border border-white/10 rounded text-xs text-white"
                    >
                      + Incluir convidada
                    </button>
                  </div>

                  {guestParticipants.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      {guestParticipants.map((gp) => (
                        <span
                          key={gp.teamId}
                          className="inline-flex items-center gap-1.5 px-2 py-1 bg-[#0D0D10] border border-white/10 rounded text-[11px] text-white"
                        >
                          {gp.teamName}
                          <button
                            type="button"
                            onClick={() =>
                              setGuestParticipants((prev) =>
                                prev.filter((x) => x.teamId !== gp.teamId)
                              )
                            }
                            className="text-[#71717A] hover:text-white"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                <button
                  type="submit"
                  disabled={actionBusy}
                  className="px-4 py-2 bg-[#DC172B] hover:bg-[#EF3340] disabled:opacity-50 text-xs font-semibold text-white rounded"
                >
                  {actionBusy ? 'Salvando...' : 'Criar campeonato'}
                </button>
              </form>

              {/* Partida Avulsa Preservada */}
              <div className="space-y-4">
                <form
                  onSubmit={handleCreateStandaloneMatch}
                  className="bg-[#15151A] border border-white/8 rounded-lg p-5 space-y-4"
                >
                  <h2 className="text-base font-bold text-white flex items-center gap-2 border-b border-white/8 pb-3">
                    <Plus className="w-4 h-4 text-[#EF3340]" /> Agendar Confronto Avulso
                  </h2>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <select
                      value={mTeamId}
                      onChange={(e) => setMTeamId(e.target.value)}
                      className="bg-[#0D0D10] border border-white/12 rounded px-3 py-2 text-xs text-white"
                    >
                      {teams.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                    <input
                      type="text"
                      required
                      value={mOpponent}
                      onChange={(e) => setMOpponent(e.target.value)}
                      placeholder="Equipe adversária"
                      className="bg-[#0D0D10] border border-white/12 rounded px-3 py-2 text-sm text-white"
                    />
                    <input
                      type="text"
                      value={mTournamentName}
                      onChange={(e) => setMTournamentName(e.target.value)}
                      placeholder="Liga / Evento externo"
                      className="bg-[#0D0D10] border border-white/12 rounded px-3 py-2 text-sm text-white"
                    />
                    <div className="grid grid-cols-2 gap-2">
                      <select
                        value={mFormat}
                        onChange={(e) => setMFormat(e.target.value as MatchFormat)}
                        className="bg-[#0D0D10] border border-white/12 rounded px-2 py-2 text-xs text-white"
                      >
                        <option value="MD3">MD3</option>
                        <option value="MD5">MD5</option>
                        <option value="MD7">MD7</option>
                      </select>
                      <input
                        type="datetime-local"
                        required
                        value={mDate}
                        onChange={(e) => setMDate(e.target.value)}
                        className="bg-[#0D0D10] border border-white/12 rounded px-2 py-2 text-xs text-white"
                      />
                    </div>
                  </div>
                  <button
                    type="submit"
                    disabled={teams.length === 0}
                    className="px-4 py-2 bg-[#202027] hover:bg-[#2B2B35] border border-white/10 disabled:opacity-40 text-xs font-semibold text-white rounded"
                  >
                    Agendar partida avulsa
                  </button>
                </form>

                {standaloneMatches.length > 0 && (
                  <div className="bg-[#15151A] border border-white/8 rounded-lg p-5 space-y-3">
                    <h3 className="text-sm font-bold text-white">
                      Confrontos Avulsos ({standaloneMatches.length})
                    </h3>
                    <div className="space-y-2 max-h-72 overflow-y-auto">
                      {standaloneMatches.map((m) => (
                        <div
                          key={m.id}
                          className="bg-[#0D0D10] border border-white/8 rounded p-3 flex items-center justify-between gap-2 text-xs"
                        >
                          <div>
                            <p className="text-[#71717A]">
                              {m.tournamentName || 'Série'} · {m.format} ·{' '}
                              {formatFirestoreDate(m.scheduledAt)}
                            </p>
                            <p className="font-bold text-white font-mono-tabular">
                              {m.teamName} ({m.nxfScore ?? 0}) × ({m.opponentScore ?? 0}){' '}
                              {m.opponentName}
                            </p>
                          </div>
                          {m.status !== 'completed' && !m.locked && (
                            <div className="flex gap-1.5">
                              <button
                                type="button"
                                onClick={() => void handleRecordGame(m, 'teamA')}
                                className="px-2 py-1 bg-[#202027] rounded font-mono-tabular text-white"
                              >
                                +1 A
                              </button>
                              <button
                                type="button"
                                onClick={() => void handleRecordGame(m, 'teamB')}
                                className="px-2 py-1 bg-[#202027] rounded font-mono-tabular text-white"
                              >
                                +1 B
                              </button>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ===================================================================== */}
      {/* ABA 2: NXF MATCH TRACKER (MONITORAMENTO & FILA DE CONFIRMAÇÃO)       */}
      {/* ===================================================================== */}
      {activeTab === 'tracker' && (
        <div className="space-y-6">
          <div className="bg-[#15151A] border border-white/8 rounded-lg p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="space-y-1">
              <h2 className="text-base font-bold text-white">NXF Match Tracker (Battlelog Oficial)</h2>
              <p className="text-xs text-[#A1A1AA]">
                Monitora battlelogs de jogadores vinculados a torneios ativos. Registra automaticamente somente correspondências inequívocas e envia batalhas ambíguas para revisão administrativa.
              </p>
            </div>
            {capabilities.canManageCompetitive && (
              <button
                type="button"
                disabled={trackerBusy}
                onClick={() => void handleRunTracker()}
                className="inline-flex items-center gap-1.5 px-4 py-2 bg-[#DC172B] hover:bg-[#EF3340] disabled:opacity-50 rounded text-xs font-semibold text-white shrink-0"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${trackerBusy ? 'animate-spin' : ''}`} />
                Executar verificação agora
              </button>
            )}
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-[#15151A] border border-white/8 rounded-lg p-4">
              <p className="text-[11px] text-[#A1A1AA]">Status do último ciclo</p>
              <p className="text-sm font-bold font-mono-tabular text-white mt-1">
                {trackerStatus?.lastStatus || 'Aguardando'}
              </p>
            </div>
            <div className="bg-[#15151A] border border-white/8 rounded-lg p-4">
              <p className="text-[11px] text-[#A1A1AA]">Jogadores verificados</p>
              <p className="text-xl font-bold font-mono-tabular text-white mt-1">
                {trackerStatus?.lastPolledPlayers ?? 0}
              </p>
            </div>
            <div className="bg-[#15151A] border border-white/8 rounded-lg p-4">
              <p className="text-[11px] text-[#A1A1AA]">Jogos auto-registrados</p>
              <p className="text-xl font-bold font-mono-tabular text-[#16A34A] mt-1">
                {trackerStatus?.lastAutoRegisteredGames ?? 0}
              </p>
            </div>
            <div className="bg-[#15151A] border border-white/8 rounded-lg p-4">
              <p className="text-[11px] text-[#A1A1AA]">Pendentes de confirmação</p>
              <p className="text-xl font-bold font-mono-tabular text-[#D97706] mt-1">
                {trackerStatus?.pendingCandidates?.length ?? 0}
              </p>
            </div>
          </div>

          {/* Fila de Confirmação Administrativa */}
          <section className="space-y-3">
            <h3 className="font-display text-xl font-bold text-white">
              Fila de Confirmação Administrativa ({trackerStatus?.pendingCandidates?.length ?? 0})
            </h3>
            {!trackerStatus || trackerStatus.pendingCandidates.length === 0 ? (
              <EmptyState
                title="Nenhuma batalha ambígua pendente"
                description="Quando o NXF Match Tracker detectar uma batalha parcialmente correspondente ou com empate/conflito, ela aparecerá aqui para validação segura."
              />
            ) : (
              <div className="space-y-3">
                {trackerStatus.pendingCandidates.map((cand) => (
                  <div
                    key={cand.id}
                    className="bg-[#15151A] border border-[#D97706]/40 rounded-lg p-4 space-y-3"
                  >
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                      <div>
                        <p className="text-xs text-[#EF3340] font-semibold">
                          {cand.tournamentName} · {cand.mode} ({cand.map})
                        </p>
                        <p className="text-base font-bold text-white">
                          {cand.teamAName} × {cand.teamBName}
                        </p>
                        <p className="text-[11px] font-mono-tabular text-[#71717A]">
                          Battle ID: {cand.battleId} · Horário: {cand.battleTime}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          disabled={trackerBusy}
                          onClick={() => void handleResolveCandidate(cand, 'approve', 'teamA')}
                          className="inline-flex items-center gap-1 px-3 py-1.5 bg-[#16A34A] hover:bg-[#15803D] rounded text-xs font-semibold text-white"
                        >
                          <Check className="w-3.5 h-3.5" />
                          Vitória {cand.teamAName}
                        </button>
                        <button
                          type="button"
                          disabled={trackerBusy}
                          onClick={() => void handleResolveCandidate(cand, 'approve', 'teamB')}
                          className="inline-flex items-center gap-1 px-3 py-1.5 bg-[#202027] hover:bg-[#2B2B35] border border-white/15 rounded text-xs font-semibold text-white"
                        >
                          <Check className="w-3.5 h-3.5" />
                          Vitória {cand.teamBName}
                        </button>
                        <button
                          type="button"
                          disabled={trackerBusy}
                          onClick={() => void handleResolveCandidate(cand, 'reject')}
                          className="inline-flex items-center gap-1 px-3 py-1.5 bg-[#DC172B]/20 hover:bg-[#DC172B] border border-[#DC172B]/40 rounded text-xs font-semibold text-white"
                        >
                          <X className="w-3.5 h-3.5" />
                          Descartar
                        </button>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs bg-[#0D0D10] border border-white/8 rounded p-3">
                      <div>
                        <p className="text-[#71717A]">Tags identificadas ({cand.teamAName}):</p>
                        <p className="font-mono-tabular text-white">
                          {cand.matchedTeamATags?.join(', ') || 'Nenhuma'}
                        </p>
                        {cand.teamABrawlers?.length > 0 && (
                          <p className="text-[11px] text-[#A1A1AA] mt-0.5">
                            Brawlers: {cand.teamABrawlers.join(', ')}
                          </p>
                        )}
                      </div>
                      <div>
                        <p className="text-[#71717A]">Tags identificadas ({cand.teamBName}):</p>
                        <p className="font-mono-tabular text-white">
                          {cand.matchedTeamBTags?.join(', ') || 'Nenhuma'}
                        </p>
                        {cand.teamBBrawlers?.length > 0 && (
                          <p className="text-[11px] text-[#A1A1AA] mt-0.5">
                            Brawlers: {cand.teamBBrawlers.join(', ')}
                          </p>
                        )}
                      </div>
                    </div>

                    {cand.reasons?.length > 0 && (
                      <div className="text-xs text-[#D97706] space-y-0.5">
                        {cand.reasons.map((reason, i) => (
                          <p key={i}>• {reason}</p>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Logs do Match Tracker */}
          <section className="bg-[#15151A] border border-white/8 rounded-lg p-5 space-y-3">
            <h3 className="text-sm font-bold text-white">Logs de Sincronização e Monitoramento</h3>
            {!trackerStatus?.logs || trackerStatus.logs.length === 0 ? (
              <p className="text-xs text-[#71717A]">Nenhum ciclo do Match Tracker registrado ainda.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-[#71717A] border-b border-white/8">
                      <th className="py-2 text-left">Status</th>
                      <th className="py-2 text-right">Jogadores</th>
                      <th className="py-2 text-right">Novas Batalhas</th>
                      <th className="py-2 text-right">Auto-Reg</th>
                      <th className="py-2 text-right">Fila</th>
                      <th className="py-2 text-right">Erros</th>
                      <th className="py-2 text-right">Duração</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trackerStatus.logs.map((log) => (
                      <tr key={log.id} className="border-b border-white/5 last:border-none">
                        <td className="py-2 font-mono-tabular text-white">{log.status}</td>
                        <td className="py-2 text-right font-mono-tabular">{log.syncedPlayers}</td>
                        <td className="py-2 text-right font-mono-tabular">{log.newBattles}</td>
                        <td className="py-2 text-right font-mono-tabular text-[#16A34A]">
                          {log.autoMatchedGames ?? 0}
                        </td>
                        <td className="py-2 text-right font-mono-tabular text-[#D97706]">
                          {log.pendingConfirmations ?? 0}
                        </td>
                        <td className="py-2 text-right font-mono-tabular text-[#EF3340]">
                          {log.errorCount}
                        </td>
                        <td className="py-2 text-right font-mono-tabular text-[#71717A]">
                          {log.durationMs}ms
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}

      {/* ===================================================================== */}
      {/* ABA 3: INTELIGÊNCIA BRAWL STARS (BRAWLERS, MAPAS, MODOS, EQUIPES)     */}
      {/* ===================================================================== */}
      {activeTab === 'intelligence' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <form
              onSubmit={handleLookupPlayer}
              className="lg:col-span-2 bg-[#15151A] border border-white/8 rounded-lg p-5 space-y-3"
            >
              <h2 className="text-sm font-bold text-white flex items-center gap-2">
                <Search className="w-4 h-4 text-[#EF3340]" />
                Consultar e Validar Brawl Tag (API Oficial)
              </h2>
              <div className="flex gap-2">
                <input
                  type="text"
                  required
                  value={lookupTag}
                  onChange={(e) => setLookupTag(e.target.value.toUpperCase())}
                  placeholder="#2PP ou Tag do jogador"
                  className="flex-1 bg-[#0D0D10] border border-white/12 rounded px-3 py-2 text-xs font-mono-tabular uppercase text-white"
                />
                <button
                  type="submit"
                  disabled={intelBusy}
                  className="px-4 py-2 bg-[#DC172B] hover:bg-[#EF3340] disabled:opacity-50 rounded text-xs font-semibold text-white shrink-0"
                >
                  Consultar
                </button>
              </div>
              {lookupResult && (
                <div className="bg-[#0D0D10] border border-white/8 rounded p-3.5 space-y-2 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-bold text-white text-sm">
                      {lookupResult.name}{' '}
                      <span className="font-mono-tabular text-[#EF3340]">{lookupResult.tag}</span>
                    </p>
                    <span className="text-[#A1A1AA]">
                      Clube: {lookupResult.clubName || 'Sem clube'}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 font-mono-tabular">
                    <div>
                      <span className="text-[#71717A] block">Troféus</span>
                      <strong className="text-white">
                        {lookupResult.trophies.toLocaleString('pt-BR')}
                      </strong>
                    </div>
                    <div>
                      <span className="text-[#71717A] block">Recorde</span>
                      <strong className="text-white">
                        {lookupResult.highestTrophies.toLocaleString('pt-BR')}
                      </strong>
                    </div>
                    <div>
                      <span className="text-[#71717A] block">Vitórias 3v3</span>
                      <strong className="text-white">
                        {lookupResult.victories3v3.toLocaleString('pt-BR')}
                      </strong>
                    </div>
                    <div>
                      <span className="text-[#71717A] block">Brawlers</span>
                      <strong className="text-white">{lookupResult.brawlersCount}</strong>
                    </div>
                  </div>
                </div>
              )}
            </form>

            <div className="bg-[#15151A] border border-white/8 rounded-lg p-5 flex flex-col justify-between gap-3">
              <div className="space-y-1">
                <h2 className="text-sm font-bold text-white">Coleta de Stats & Battlelogs</h2>
                <p className="text-xs text-[#A1A1AA]">
                  Atualiza troféus, histórico e batalhas recentes de todos os membros com Brawl Tag aprovada.
                </p>
              </div>
              {capabilities.canManageCompetitive && (
                <button
                  type="button"
                  disabled={intelBusy}
                  onClick={() => void handleSyncBrawlNow()}
                  className="inline-flex items-center justify-center gap-1.5 px-4 py-2 bg-[#202027] hover:bg-[#2B2B35] border border-white/12 disabled:opacity-50 rounded text-xs font-semibold text-white"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${intelBusy ? 'animate-spin' : ''}`} />
                  Sincronizar Stats + Battlelogs
                </button>
              )}
            </div>
          </div>

          {!analytics ||
          (analytics.orgBrawlers.length === 0 &&
            analytics.players.length === 0 &&
            analytics.teams.length === 0) ? (
            <EmptyState
              title="Nenhuma métrica de battlelog coletada ainda"
              description="Aprove as Brawl Tags dos jogadores no NXF System e execute a sincronização para alimentar o painel de Brawlers, Mapas, Modos e Desempenho por Equipe."
            />
          ) : (
            <div className="space-y-6">
              {/* Brawlers + Modos */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div className="bg-[#15151A] border border-white/8 rounded-lg p-5 space-y-3">
                  <h3 className="text-sm font-bold text-white">
                    Brawlers Mais Utilizados & Taxa de Vitória
                  </h3>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-[#71717A] border-b border-white/8">
                          <th className="py-1.5 text-left">Brawler</th>
                          <th className="py-1.5 text-right">Batalhas</th>
                          <th className="py-1.5 text-right">V / D</th>
                          <th className="py-1.5 text-right">Win Rate</th>
                        </tr>
                      </thead>
                      <tbody>
                        {analytics.orgBrawlers.slice(0, 12).map((b) => (
                          <tr key={b.brawlerName} className="border-b border-white/5 last:border-none">
                            <td className="py-2 font-medium text-white">{b.brawlerName}</td>
                            <td className="py-2 text-right font-mono-tabular text-[#A1A1AA]">
                              {b.battles}
                            </td>
                            <td className="py-2 text-right font-mono-tabular text-[#A1A1AA]">
                              {b.wins}/{b.losses}
                            </td>
                            <td className="py-2 text-right font-mono-tabular font-semibold text-white">
                              {b.winRate}%
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div className="bg-[#15151A] border border-white/8 rounded-lg p-5 space-y-3">
                  <h3 className="text-sm font-bold text-white">Estatísticas por Modo e Mapa</h3>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-[#71717A] border-b border-white/8">
                          <th className="py-1.5 text-left">Mapa / Modo</th>
                          <th className="py-1.5 text-right">Jogos</th>
                          <th className="py-1.5 text-right">V / D</th>
                          <th className="py-1.5 text-right">Win Rate</th>
                        </tr>
                      </thead>
                      <tbody>
                        {analytics.orgMaps.slice(0, 12).map((m) => (
                          <tr
                            key={`${m.mode}-${m.map}`}
                            className="border-b border-white/5 last:border-none"
                          >
                            <td className="py-2">
                              <span className="font-medium text-white">{m.map}</span>
                              <span className="block text-[10px] text-[#71717A] capitalize">
                                {m.mode}
                              </span>
                            </td>
                            <td className="py-2 text-right font-mono-tabular text-[#A1A1AA]">
                              {m.battles}
                            </td>
                            <td className="py-2 text-right font-mono-tabular text-[#A1A1AA]">
                              {m.wins}/{m.losses}
                            </td>
                            <td className="py-2 text-right font-mono-tabular font-semibold text-white">
                              {m.winRate}%
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>

              {/* Desempenho Individual & Coletivo */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div className="bg-[#15151A] border border-white/8 rounded-lg p-5 space-y-3">
                  <h3 className="text-sm font-bold text-white">Desempenho Individual por Jogador</h3>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-[#71717A] border-b border-white/8">
                          <th className="py-1.5 text-left">Jogador</th>
                          <th className="py-1.5 text-right">Batalhas</th>
                          <th className="py-1.5 text-right">V / D</th>
                          <th className="py-1.5 text-right">WR</th>
                        </tr>
                      </thead>
                      <tbody>
                        {analytics.players.map((p) => (
                          <tr key={p.uid} className="border-b border-white/5 last:border-none">
                            <td className="py-2">
                              <span className="font-medium text-white">
                                {p.displayName || p.uid}
                              </span>
                              <span className="block text-[10px] font-mono-tabular text-[#71717A]">
                                {p.brawlTag}
                              </span>
                            </td>
                            <td className="py-2 text-right font-mono-tabular text-[#A1A1AA]">
                              {p.totalBattles}
                            </td>
                            <td className="py-2 text-right font-mono-tabular text-[#A1A1AA]">
                              {p.wins}/{p.losses}
                            </td>
                            <td className="py-2 text-right font-mono-tabular font-semibold text-white">
                              {p.winRate}%
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div className="bg-[#15151A] border border-white/8 rounded-lg p-5 space-y-3">
                  <h3 className="text-sm font-bold text-white">Desempenho Coletivo por Equipe</h3>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-[#71717A] border-b border-white/8">
                          <th className="py-1.5 text-left">Equipe</th>
                          <th className="py-1.5 text-right">Total / Squad</th>
                          <th className="py-1.5 text-right">V / D</th>
                          <th className="py-1.5 text-right">WR</th>
                        </tr>
                      </thead>
                      <tbody>
                        {analytics.teams.map((tm) => (
                          <tr key={tm.teamId} className="border-b border-white/5 last:border-none">
                            <td className="py-2">
                              <span className="font-medium text-white">{tm.teamName}</span>
                              <span className="block text-[10px] font-mono-tabular text-[#71717A]">
                                {tm.memberTags.length} tag(s) ativa(s)
                              </span>
                            </td>
                            <td className="py-2 text-right font-mono-tabular text-[#A1A1AA]">
                              {tm.totalBattles} / {tm.squadBattles}
                            </td>
                            <td className="py-2 text-right font-mono-tabular text-[#A1A1AA]">
                              {tm.wins}/{tm.losses}
                            </td>
                            <td className="py-2 text-right font-mono-tabular font-semibold text-white">
                              {tm.winRate}%
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
