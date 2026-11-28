import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  RefreshCw,
  Server,
  Wrench,
} from 'lucide-react';
import {
  collection,
  limit,
  onSnapshot,
  query,
  where,
} from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { apiFetch } from '../../lib/apiClient';
import { useAuth } from '../../context/AuthContext';
import { formatFirestoreDate, ROLE_LABELS } from '../../lib/permissions';
import { buildPanelNavigation } from '../../lib/panelNavigation';
import { ErrorState, LoadingSkeleton } from '../../components/common/StateViews';
import type {
  Application,
  Match,
  MatchTrackerCandidate,
  Team,
  TeamMembership,
} from '../../types/nxf';

type QueryState<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'error'; message: string };

interface BrawlDiagnosticStatus {
  brawlTokenConfigured: boolean;
  brawlApiConfigured: boolean;
  egressProxyConfigured: boolean;
  intervalHours: number;
  running: boolean;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastStatus: string;
  lastHttpStatus: number | null;
  lastError: string | null;
  lastSuccessCount: number;
  lastErrorCount: number;
}

interface OperationalPendency {
  id: string;
  title: string;
  detail: string;
  count: number;
  countLabel: string;
  severity: 'high' | 'medium';
  actionLabel: string;
  to: string;
}

function formatIsoShort(iso: string | null | undefined): string {
  if (!iso) return 'Ainda não executada';
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return iso;
  return formatFirestoreDate(new Date(parsed));
}

export function DashboardPage() {
  const { firebaseUser, userDoc, capabilities, systemSettings } = useAuth();
  const [reloadKey, setReloadKey] = useState(0);

  const [teamsState, setTeamsState] = useState<QueryState<Team[]>>({ status: 'loading' });
  const [membershipsState, setMembershipsState] = useState<QueryState<TeamMembership[]>>({
    status: 'loading',
  });
  const [applicationsState, setApplicationsState] = useState<QueryState<Application[]>>({
    status: 'loading',
  });
  const [trackerState, setTrackerState] = useState<QueryState<MatchTrackerCandidate[]>>({
    status: 'loading',
  });
  const [liveMatchesState, setLiveMatchesState] = useState<QueryState<Match[]>>({
    status: 'loading',
  });
  const [scheduledMatchesState, setScheduledMatchesState] = useState<QueryState<number>>({
    status: 'loading',
  });
  const [notificationsState, setNotificationsState] = useState<QueryState<number>>({
    status: 'loading',
  });
  const [brawlDiagState, setBrawlDiagState] = useState<
    | { status: 'idle' }
    | { status: 'loading' }
    | { status: 'ready'; data: BrawlDiagnosticStatus }
    | { status: 'error'; message: string }
  >({ status: 'idle' });

  const canViewSupercellDiagnostics =
    capabilities.isAnyAdmin || capabilities.canAccessSystem;

  const hasGlobalRecruitment =
    capabilities.isPrimaryAdmin ||
    capabilities.permissions.includes('recruitment.manage');

  const scopedRecruitmentTeams = useMemo(
    () => capabilities.teamIds.slice(0, 10),
    [capabilities.teamIds]
  );

  // Assinaturas Firestore com tratamento explícito de carregamento e erro
  useEffect(() => {
    if (!firebaseUser) return;
    const unsubs: Array<() => void> = [];

    setTeamsState({ status: 'loading' });
    setMembershipsState({ status: 'loading' });
    setLiveMatchesState({ status: 'loading' });
    setScheduledMatchesState({ status: 'loading' });
    setNotificationsState({ status: 'loading' });

    unsubs.push(
      onSnapshot(
        query(collection(db, 'teams'), limit(100)),
        (snap) => {
          const list = snap.docs.map((d) => ({
            id: d.id,
            ...(d.data() as Omit<Team, 'id'>),
          }));
          setTeamsState({ status: 'ready', data: list });
        },
        (err) => {
          setTeamsState({
            status: 'error',
            message: err.message || 'Falha ao consultar equipes no Firestore.',
          });
        }
      )
    );

    unsubs.push(
      onSnapshot(
        query(
          collection(db, 'teamMemberships'),
          where('status', '==', 'active'),
          limit(300)
        ),
        (snap) => {
          const list = snap.docs.map((d) => ({
            id: d.id,
            ...(d.data() as TeamMembership),
          }));
          setMembershipsState({ status: 'ready', data: list });
        },
        (err) => {
          setMembershipsState({
            status: 'error',
            message: err.message || 'Falha ao consultar elencos ativos.',
          });
        }
      )
    );

    unsubs.push(
      onSnapshot(
        query(
          collection(db, 'matches'),
          where('status', '==', 'live_manual'),
          limit(50)
        ),
        (snap) => {
          const list = snap.docs.map((d) => ({
            id: d.id,
            ...(d.data() as Omit<Match, 'id'>),
          }));
          setLiveMatchesState({ status: 'ready', data: list });
        },
        (err) => {
          setLiveMatchesState({
            status: 'error',
            message: err.message || 'Falha ao consultar partidas em andamento.',
          });
        }
      )
    );

    unsubs.push(
      onSnapshot(
        query(
          collection(db, 'matches'),
          where('status', '==', 'scheduled'),
          limit(50)
        ),
        (snap) => {
          setScheduledMatchesState({ status: 'ready', data: snap.size });
        },
        (err) => {
          setScheduledMatchesState({
            status: 'error',
            message: err.message || 'Falha ao consultar agenda competitiva.',
          });
        }
      )
    );

    unsubs.push(
      onSnapshot(
        query(
          collection(db, 'notifications'),
          where('recipientUid', '==', firebaseUser.uid),
          where('read', '==', false),
          limit(50)
        ),
        (snap) => {
          setNotificationsState({ status: 'ready', data: snap.size });
        },
        (err) => {
          setNotificationsState({
            status: 'error',
            message: err.message || 'Falha ao consultar avisos não lidos.',
          });
        }
      )
    );

    // Candidaturas novas (somente para cargos que gerenciam recrutamento)
    if (capabilities.canManageRecruitment) {
      if (hasGlobalRecruitment) {
        setApplicationsState({ status: 'loading' });
        unsubs.push(
          onSnapshot(
            query(
              collection(db, 'applications'),
              where('stage', '==', 'recebida'),
              limit(100)
            ),
            (snap) => {
              const list = snap.docs.map((d) => ({
                id: d.id,
                ...(d.data() as Omit<Application, 'id'>),
              }));
              setApplicationsState({ status: 'ready', data: list });
            },
            (err) => {
              setApplicationsState({
                status: 'error',
                message: err.message || 'Falha ao consultar candidaturas novas.',
              });
            }
          )
        );
      } else if (scopedRecruitmentTeams.length > 0) {
        setApplicationsState({ status: 'loading' });
        unsubs.push(
          onSnapshot(
            query(
              collection(db, 'applications'),
              where('teamId', 'in', scopedRecruitmentTeams),
              limit(100)
            ),
            (snap) => {
              const list = snap.docs
                .map((d) => ({
                  id: d.id,
                  ...(d.data() as Omit<Application, 'id'>),
                }))
                .filter((a) => a.stage === 'recebida');
              setApplicationsState({ status: 'ready', data: list });
            },
            (err) => {
              setApplicationsState({
                status: 'error',
                message: err.message || 'Falha ao consultar candidaturas da sua equipe.',
              });
            }
          )
        );
      } else {
        setApplicationsState({ status: 'ready', data: [] });
      }
    } else {
      setApplicationsState({ status: 'ready', data: [] });
    }

    // Fila de validação do Match Tracker (somente para cargos competitivos)
    if (capabilities.canManageCompetitive) {
      setTrackerState({ status: 'loading' });
      unsubs.push(
        onSnapshot(
          query(
            collection(db, 'matchTrackerCandidates'),
            where('status', '==', 'pending_review'),
            limit(100)
          ),
          (snap) => {
            const list = snap.docs.map((d) => ({
              id: d.id,
              ...(d.data() as Omit<MatchTrackerCandidate, 'id'>),
            }));
            setTrackerState({ status: 'ready', data: list });
          },
          (err) => {
            setTrackerState({
              status: 'error',
              message: err.message || 'Falha ao consultar fila de validação de resultados.',
            });
          }
        )
      );
    } else {
      setTrackerState({ status: 'ready', data: [] });
    }

    return () => unsubs.forEach((u) => u());
  }, [
    firebaseUser,
    reloadKey,
    capabilities.canManageRecruitment,
    capabilities.canManageCompetitive,
    hasGlobalRecruitment,
    scopedRecruitmentTeams,
  ]);

  // Diagnóstico da integração Supercell apenas para cargos autorizados
  const loadBrawlDiagnostics = useCallback(async () => {
    if (!firebaseUser || !canViewSupercellDiagnostics) {
      setBrawlDiagState({ status: 'idle' });
      return;
    }
    setBrawlDiagState({ status: 'loading' });
    try {
      const data = await apiFetch<BrawlDiagnosticStatus>('/api/brawl/status');
      setBrawlDiagState({ status: 'ready', data });
    } catch (err) {
      setBrawlDiagState({
        status: 'error',
        message:
          err instanceof Error
            ? err.message
            : 'Diagnóstico da API Supercell indisponível no momento.',
      });
    }
  }, [firebaseUser, canViewSupercellDiagnostics]);

  useEffect(() => {
    void loadBrawlDiagnostics();
  }, [loadBrawlDiagnostics, reloadKey]);

  const handleRetryAll = () => {
    setReloadKey((k) => k + 1);
  };

  // Equipes ativas (compatível com documentos legados sem campo `active`)
  const activeTeams = useMemo(() => {
    if (teamsState.status !== 'ready') return null;
    return teamsState.data.filter((t) => t.active !== false);
  }, [teamsState]);

  const teamsWithoutRoster = useMemo(() => {
    if (!activeTeams || membershipsState.status !== 'ready') return null;
    const populatedTeamIds = new Set(membershipsState.data.map((m) => m.teamId));
    return activeTeams.filter((t) => !populatedTeamIds.has(t.id));
  }, [activeTeams, membershipsState]);

  // Constrói lista confirmada de pendências operacionais
  const pendencies = useMemo<OperationalPendency[]>(() => {
    const items: OperationalPendency[] = [];

    if (teamsWithoutRoster && teamsWithoutRoster.length > 0) {
      const sampleNames = teamsWithoutRoster
        .slice(0, 3)
        .map((t) => t.name || t.id)
        .join(', ');
      const extraCount =
        teamsWithoutRoster.length > 3 ? ` e +${teamsWithoutRoster.length - 3}` : '';
      const targetUrl =
        teamsWithoutRoster.length === 1
          ? `/painel/organizacao?team=${encodeURIComponent(teamsWithoutRoster[0].id)}`
          : '/painel/organizacao';

      items.push({
        id: 'teams-without-roster',
        title:
          teamsWithoutRoster.length === 1
            ? 'Equipe sem elenco vinculado'
            : 'Equipes sem elenco vinculado',
        detail: `Sem integrantes ativos: ${sampleNames}${extraCount}.`,
        count: teamsWithoutRoster.length,
        countLabel:
          teamsWithoutRoster.length === 1 ? '1 equipe' : `${teamsWithoutRoster.length} equipes`,
        severity: 'high',
        actionLabel: capabilities.canManageOrg ? 'Vincular elenco' : 'Ver equipes',
        to: targetUrl,
      });
    }

    if (
      capabilities.canManageRecruitment &&
      applicationsState.status === 'ready' &&
      applicationsState.data.length > 0
    ) {
      const count = applicationsState.data.length;
      items.push({
        id: 'new-applications',
        title: 'Candidaturas novas aguardando triagem',
        detail:
          count === 1
            ? `Candidatura recebida de ${applicationsState.data[0].applicantName || 'candidato'}.`
            : `${count} candidaturas recebidas aguardando avaliação inicial.`,
        count,
        countLabel: count === 1 ? '1 candidatura' : `${count} candidaturas`,
        severity: 'high',
        actionLabel: 'Avaliar candidaturas',
        to: '/painel/recrutamento',
      });
    }

    if (
      capabilities.canManageCompetitive &&
      trackerState.status === 'ready' &&
      trackerState.data.length > 0
    ) {
      const count = trackerState.data.length;
      items.push({
        id: 'tracker-validation',
        title: 'Resultados aguardando validação no Match Tracker',
        detail:
          count === 1
            ? `${trackerState.data[0].teamAName} × ${trackerState.data[0].teamBName} aguarda confirmação administrativa.`
            : `${count} batalhas detectadas exigem confirmação manual antes de contar no placar.`,
        count,
        countLabel: count === 1 ? '1 resultado' : `${count} resultados`,
        severity: 'high',
        actionLabel: 'Validar resultados',
        to: '/painel/competitivo',
      });
    }

    if (
      capabilities.canManageCompetitive &&
      liveMatchesState.status === 'ready' &&
      liveMatchesState.data.length > 0
    ) {
      const count = liveMatchesState.data.length;
      items.push({
        id: 'live-matches',
        title: 'Confrontos em andamento sem encerramento',
        detail:
          count === 1
            ? `${liveMatchesState.data[0].teamName} × ${liveMatchesState.data[0].opponentName} ainda está em aberto.`
            : `${count} partidas em andamento aguardam fechamento do placar oficial.`,
        count,
        countLabel: count === 1 ? '1 partida' : `${count} partidas`,
        severity: 'medium',
        actionLabel: 'Atualizar placares',
        to: '/painel/competitivo',
      });
    }

    if (notificationsState.status === 'ready' && notificationsState.data > 0) {
      const count = notificationsState.data;
      items.push({
        id: 'unread-notifications',
        title: 'Avisos não lidos na sua conta',
        detail:
          count === 1
            ? 'Você possui 1 notificação pendente de leitura.'
            : `Você possui ${count} notificações pendentes de leitura.`,
        count,
        countLabel: count === 1 ? '1 aviso' : `${count} avisos`,
        severity: 'medium',
        actionLabel: 'Abrir avisos',
        to: '/painel/notificacoes',
      });
    }

    if (userDoc?.brawlTagStatus === 'rejected') {
      items.push({
        id: 'brawl-tag-rejected',
        title: 'Sua Brawl Tag precisa de revisão',
        detail:
          'A solicitação anterior foi recusada. Atualize sua tag no perfil para reenviar.',
        count: 1,
        countLabel: '1 ajuste',
        severity: 'medium',
        actionLabel: 'Revisar perfil',
        to: '/painel/perfil',
      });
    }

    return items;
  }, [
    teamsWithoutRoster,
    capabilities.canManageOrg,
    capabilities.canManageRecruitment,
    capabilities.canManageCompetitive,
    applicationsState,
    trackerState,
    liveMatchesState,
    notificationsState,
    userDoc?.brawlTagStatus,
  ]);

  const pendencyErrors = useMemo(() => {
    const errors: Array<{ label: string; message: string }> = [];
    if (teamsState.status === 'error') {
      errors.push({ label: 'Equipes', message: teamsState.message });
    }
    if (membershipsState.status === 'error') {
      errors.push({ label: 'Elencos', message: membershipsState.message });
    }
    if (capabilities.canManageRecruitment && applicationsState.status === 'error') {
      errors.push({ label: 'Candidaturas', message: applicationsState.message });
    }
    if (capabilities.canManageCompetitive && trackerState.status === 'error') {
      errors.push({ label: 'Validação de resultados', message: trackerState.message });
    }
    if (capabilities.canManageCompetitive && liveMatchesState.status === 'error') {
      errors.push({ label: 'Partidas em andamento', message: liveMatchesState.message });
    }
    if (notificationsState.status === 'error') {
      errors.push({ label: 'Avisos', message: notificationsState.message });
    }
    return errors;
  }, [
    teamsState,
    membershipsState,
    applicationsState,
    trackerState,
    liveMatchesState,
    notificationsState,
    capabilities.canManageRecruitment,
    capabilities.canManageCompetitive,
  ]);

  const isCheckingPendencies =
    teamsState.status === 'loading' ||
    membershipsState.status === 'loading' ||
    notificationsState.status === 'loading' ||
    (capabilities.canManageRecruitment && applicationsState.status === 'loading') ||
    (capabilities.canManageCompetitive &&
      (trackerState.status === 'loading' || liveMatchesState.status === 'loading'));

  // Atalhos secundários (exclui o próprio /painel para evitar redundância)
  const secondaryShortcuts = useMemo(() => {
    const groups = buildPanelNavigation(capabilities);
    return groups.flatMap((g) =>
      g.items
        .filter((item) => item.to !== '/painel')
        .map((item) => ({ ...item, groupLabel: g.label }))
    );
  }, [capabilities]);

  const renderMetricValue = (
    state: 'loading' | 'ready' | 'error',
    value?: number
  ) => {
    if (state === 'loading') {
      return (
        <span
          className="inline-block h-7 w-12 rounded bg-[#202027] animate-pulse align-middle"
          aria-label="Carregando"
        />
      );
    }
    if (state === 'error') {
      return (
        <span className="text-sm font-medium text-[#EF3340]">Indisponível</span>
      );
    }
    return (
      <span className="font-mono-tabular text-2xl font-bold text-white">
        {value}
      </span>
    );
  };

  return (
    <div className="space-y-8">
      {/* Cabeçalho da Visão Geral */}
      <div className="border-b border-white/8 pb-5 flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div className="space-y-1.5">
          <h1 className="font-display text-3xl sm:text-4xl font-bold text-white leading-tight">
            Visão Geral Operacional
          </h1>
          <p className="text-sm text-[#A1A1AA]">
            Acesso ativo como{' '}
            <span className="text-[#E4E4E7] font-medium">
              {capabilities.roles.map((r) => ROLE_LABELS[r]).join(' · ')}
            </span>
          </p>
        </div>
        <button
          type="button"
          onClick={handleRetryAll}
          className="self-start sm:self-auto inline-flex items-center gap-2 px-3.5 min-h-[40px] rounded-md bg-[#15151A] hover:bg-[#202027] border border-white/10 text-xs font-semibold text-[#D4D4D8] hover:text-white transition-colors whitespace-nowrap"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          <span>Atualizar painel</span>
        </button>
      </div>

      {/* Faixa de Indicadores Confirmados (zero só após consulta bem-sucedida) */}
      <section aria-label="Resumo operacional" className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <div className="bg-[#15151A] border border-white/8 rounded-lg p-4 space-y-1.5">
          <p className="text-xs text-[#A1A1AA]">Equipes ativas</p>
          <div>
            {renderMetricValue(
              teamsState.status,
              activeTeams ? activeTeams.length : undefined
            )}
          </div>
        </div>

        <div className="bg-[#15151A] border border-white/8 rounded-lg p-4 space-y-1.5">
          <p className="text-xs text-[#A1A1AA]">Integrantes em elenco</p>
          <div>
            {renderMetricValue(
              membershipsState.status,
              membershipsState.status === 'ready'
                ? membershipsState.data.length
                : undefined
            )}
          </div>
        </div>

        <div className="bg-[#15151A] border border-white/8 rounded-lg p-4 space-y-1.5">
          <p className="text-xs text-[#A1A1AA]">Partidas agendadas</p>
          <div>
            {renderMetricValue(
              scheduledMatchesState.status,
              scheduledMatchesState.status === 'ready'
                ? scheduledMatchesState.data
                : undefined
            )}
          </div>
        </div>

        <div className="bg-[#15151A] border border-white/8 rounded-lg p-4 space-y-1.5">
          <p className="text-xs text-[#A1A1AA]">Avisos não lidos</p>
          <div>
            {renderMetricValue(
              notificationsState.status,
              notificationsState.status === 'ready'
                ? notificationsState.data
                : undefined
            )}
          </div>
        </div>
      </section>

      {/* Foco Principal: Pendências Operacionais */}
      <section aria-labelledby="pendencies-heading" className="space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-baseline justify-between gap-1">
          <div>
            <h2
              id="pendencies-heading"
              className="font-display text-2xl font-bold text-white"
            >
              Pendências Operacionais
            </h2>
            <p className="text-sm text-[#A1A1AA]">
              Itens confirmados nos dados atuais que exigem atenção ou validação.
            </p>
          </div>
          {!isCheckingPendencies && pendencyErrors.length === 0 && (
            <p className="text-xs font-mono-tabular text-[#A1A1AA]">
              {pendencies.length === 0
                ? '0 pendências'
                : pendencies.length === 1
                  ? '1 frente pendente'
                  : `${pendencies.length} frentes pendentes`}
            </p>
          )}
        </div>

        {pendencyErrors.length > 0 && (
          <ErrorState
            title="Algumas verificações operacionais falharam"
            description={pendencyErrors
              .map((e) => `${e.label}: ${e.message}`)
              .join(' · ')}
            onRetry={handleRetryAll}
          />
        )}

        {isCheckingPendencies && pendencies.length === 0 ? (
          <LoadingSkeleton rows={3} />
        ) : pendencies.length > 0 ? (
          <div className="bg-[#15151A] border border-white/8 rounded-lg divide-y divide-white/8">
            {pendencies.map((item) => (
              <div
                key={item.id}
                className="p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-[#1B1B22] transition-colors"
              >
                <div className="space-y-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                    <AlertCircle
                      className={`w-4 h-4 shrink-0 ${
                        item.severity === 'high'
                          ? 'text-[#EF3340]'
                          : 'text-amber-400'
                      }`}
                    />
                    <h3 className="text-sm sm:text-base font-semibold text-white">
                      {item.title}
                    </h3>
                    <span className="text-xs font-mono-tabular text-[#A1A1AA]">
                      · {item.countLabel}
                    </span>
                  </div>
                  <p className="text-sm text-[#A1A1AA] sm:pl-6 leading-relaxed">
                    {item.detail}
                  </p>
                </div>

                <Link
                  to={item.to}
                  className="self-start sm:self-center inline-flex items-center gap-2 px-4 min-h-[40px] rounded-md bg-[#202027] hover:bg-[#DC172B] border border-white/10 hover:border-[#DC172B] text-xs font-semibold text-white transition-colors whitespace-nowrap shrink-0"
                >
                  <span>{item.actionLabel}</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </Link>
              </div>
            ))}
            {isCheckingPendencies && (
              <div className="px-5 py-3 text-xs text-[#71717A]">
                Concluindo verificações adicionais...
              </div>
            )}
          </div>
        ) : pendencyErrors.length === 0 ? (
          <div className="bg-[#15151A] border border-white/8 rounded-lg p-6 flex items-start gap-3.5">
            <CheckCircle2 className="w-5 h-5 text-emerald-500 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <h3 className="text-base font-semibold text-white">
                Nenhuma pendência operacional no momento
              </h3>
              <p className="text-sm text-[#A1A1AA]">
                Todas as consultas autorizadas para o seu cargo foram concluídas sem itens aguardando ação imediata.
              </p>
            </div>
          </div>
        ) : null}
      </section>

      {/* Estado da Integração Supercell (exclusivo para cargos autorizados quando há diagnóstico) */}
      {canViewSupercellDiagnostics && (
        <section aria-labelledby="supercell-heading" className="space-y-3">
          <h2
            id="supercell-heading"
            className="font-display text-xl font-bold text-white"
          >
            Integração Supercell (Brawl Stars)
          </h2>

          {brawlDiagState.status === 'loading' ? (
            <LoadingSkeleton rows={1} />
          ) : brawlDiagState.status === 'ready' ? (
            <div className="bg-[#15151A] border border-white/8 rounded-lg p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
              <div className="space-y-1.5 min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  {brawlDiagState.data.brawlApiConfigured ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
                  ) : (
                    <Wrench className="w-4 h-4 text-amber-400 shrink-0" />
                  )}
                  <span className="text-sm font-semibold text-white">
                    {brawlDiagState.data.brawlApiConfigured
                      ? 'API oficial conectada'
                      : 'Integração pendente ou bloqueada'}
                  </span>
                  <span className="text-xs text-[#71717A]">·</span>
                  <span className="text-xs text-[#A1A1AA] font-mono-tabular">
                    Último sucesso: {formatIsoShort(brawlDiagState.data.lastSuccessAt)}
                  </span>
                </div>

                <p className="text-xs text-[#A1A1AA] leading-relaxed">
                  {brawlDiagState.data.brawlApiConfigured ? (
                    <>
                      Sincronização periódica a cada{' '}
                      <span className="font-mono-tabular text-white">
                        {brawlDiagState.data.intervalHours}h
                      </span>
                      {' · '}
                      <span className="font-mono-tabular text-white">
                        {brawlDiagState.data.lastSuccessCount}
                      </span>{' '}
                      perfis atualizados no último ciclo.
                    </>
                  ) : (
                    brawlDiagState.data.lastError ||
                    (!brawlDiagState.data.brawlTokenConfigured
                      ? 'Token BRAWL_STARS_API_TOKEN não configurado no servidor backend.'
                      : 'Valide o token e o IP autorizado no portal da Supercell pelo módulo Sistema.')
                  )}
                </p>
              </div>

              <Link
                to="/painel/system"
                className="self-start lg:self-center inline-flex items-center gap-2 px-4 min-h-[40px] rounded-md bg-[#202027] hover:bg-[#2B2B35] border border-white/10 text-xs font-semibold text-white transition-colors whitespace-nowrap shrink-0"
              >
                <Server className="w-3.5 h-3.5 text-[#A1A1AA]" />
                <span>Abrir diagnóstico</span>
              </Link>
            </div>
          ) : brawlDiagState.status === 'error' ? (
            <div className="bg-[#15151A] border border-white/8 rounded-lg p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="space-y-1">
                <p className="text-sm font-semibold text-white">
                  Diagnóstico da integração indisponível no momento
                </p>
                <p className="text-xs text-[#A1A1AA]">
                  {typeof systemSettings?.brawlApiConfigured === 'boolean'
                    ? `Último estado salvo no Firestore: ${
                        systemSettings.brawlApiConfigured ? 'configurada' : 'pendente'
                      }. `
                    : ''}
                  {brawlDiagState.message}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void loadBrawlDiagnostics()}
                className="self-start sm:self-center px-3.5 min-h-[40px] rounded-md bg-[#202027] hover:bg-[#2B2B35] border border-white/10 text-xs font-semibold text-white transition-colors whitespace-nowrap shrink-0"
              >
                Tentar novamente
              </button>
            </div>
          ) : null}
        </section>
      )}

      {/* Atalhos Secundários de Módulos (discretos para não duplicar o menu lateral) */}
      <section aria-labelledby="shortcuts-heading" className="pt-2 border-t border-white/8 space-y-3">
        <div className="flex items-baseline justify-between">
          <h2
            id="shortcuts-heading"
            className="text-sm font-semibold text-[#A1A1AA]"
          >
            Acesso direto aos módulos autorizados
          </h2>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
          {secondaryShortcuts.map((shortcut) => (
            <Link
              key={shortcut.to}
              to={shortcut.to}
              className="px-3.5 py-3 rounded-md bg-[#15151A]/70 hover:bg-[#202027] border border-white/6 hover:border-white/14 flex items-center justify-between gap-2 transition-colors"
            >
              <div className="min-w-0">
                <p className="text-xs text-[#71717A] truncate">{shortcut.groupLabel}</p>
                <p className="text-sm font-medium text-[#E4E4E7] truncate">
                  {shortcut.label}
                </p>
              </div>
              <ArrowRight className="w-3.5 h-3.5 text-[#71717A] shrink-0" />
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
