import React, { useEffect, useState } from 'react';
import { Award, Calendar, Info, ShieldCheck, Trophy } from 'lucide-react';
import { collection, onSnapshot, orderBy, query, where } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { formatFirestoreDate } from '../../lib/permissions';
import { EmptyState, LoadingSkeleton } from '../../components/common/StateViews';
import type { Match, Tournament } from '../../types/nxf';

const STAGE_LABELS: Record<string, string> = {
  registration: 'Inscrições',
  groups: 'Fase de Grupos',
  playoffs: 'Playoffs',
  final: 'Grande Final',
  completed: 'Encerrado',
};

export function CompetitivePage() {
  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const [matches, setMatches] = useState<Match[]>([]);
  const [filterStatus, setFilterStatus] = useState<'all' | 'scheduled' | 'live_manual' | 'completed'>('all');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const u1 = onSnapshot(
      query(collection(db, 'tournaments'), where('isPublic', '==', true)),
      (snap) => {
        setTournaments(
          snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Tournament, 'id'>) }))
        );
      },
      () => {}
    );

    const u2 = onSnapshot(
      query(
        collection(db, 'matches'),
        where('isPublic', '==', true),
        orderBy('scheduledAt', 'desc')
      ),
      (snap) => {
        setMatches(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Match, 'id'>) })));
        setLoading(false);
      },
      () => setLoading(false)
    );

    return () => {
      u1();
      u2();
    };
  }, []);

  const filteredMatches = matches.filter((m) =>
    filterStatus === 'all' ? true : m.status === filterStatus
  );

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-10 space-y-10">
      <div className="border-b border-white/8 pb-5 space-y-2">
        <p className="text-xs font-semibold text-[#EF3340] uppercase tracking-wider">
          Cenário Oficial
        </p>
        <h1 className="font-display text-4xl font-bold text-white">
          Competitivo Brawl Stars
        </h1>
        <p className="text-sm text-[#A1A1AA] max-w-3xl">
          Campeonatos com fase de grupos MD3, tabela oficial com critérios de desempate, playoffs em MD5 e histórico validado de confrontos.
        </p>
        <div className="flex items-start gap-2 text-xs text-[#A1A1AA] pt-1">
          <Info className="w-4 h-4 text-[#EF3340] shrink-0 mt-0.5" />
          <span>
            Monitoramento híbrido NXF: confrontos utilizam validação automática via Battlelog oficial da Supercell quando inequívocos, com confirmação administrativa obrigatória para casos ambíguos e fechamento de fases.
          </span>
        </div>
      </div>

      {/* Campeonatos, Grupos e Playoffs */}
      <section className="space-y-5">
        <div className="flex items-center gap-2">
          <Trophy className="w-4 h-4 text-[#EF3340]" />
          <h2 className="font-display text-2xl font-bold text-white">Campeonatos e Classificações</h2>
        </div>

        {tournaments.length === 0 ? (
          <EmptyState
            title="Nenhum campeonato público registrado"
            description="Quando a organização abrir campeonatos ou fases de grupos públicas, as tabelas e chaveamentos aparecerão aqui."
          />
        ) : (
          <div className="space-y-6">
            {tournaments.map((t) => {
              const playoffMatches = matches.filter(
                (m) => m.tournamentId === t.id && (m.stage === 'playoffs' || m.stage === 'final')
              );
              const hasStructuredGroups = Array.isArray(t.groups) && t.groups.length > 0;

              return (
                <div
                  key={t.id}
                  className="bg-[#15151A] border border-white/8 rounded-lg p-6 space-y-5"
                >
                  <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 border-b border-white/8 pb-4">
                    <div className="space-y-1">
                      <p className="text-xs text-[#EF3340] font-medium">
                        {t.format} · {STAGE_LABELS[t.currentStage || ''] || (t.status === 'ongoing' ? 'Em andamento' : t.status === 'completed' ? 'Encerrado' : 'Em breve')}
                        {t.rules
                          ? ` · Grupos ${t.rules.groupMatchFormat} · Playoffs ${t.rules.playoffMatchFormat}`
                          : ''}
                      </p>
                      <h3 className="font-display text-2xl font-bold text-white">{t.name}</h3>
                      {t.description && (
                        <p className="text-xs text-[#A1A1AA] max-w-2xl">{t.description}</p>
                      )}
                      {t.organizer && (
                        <p className="text-[11px] text-[#71717A]">Organização: {t.organizer}</p>
                      )}
                    </div>

                    {t.championTeamName && (
                      <div className="bg-[#0D0D10] border border-[#DC172B]/50 rounded-md px-4 py-2.5 flex items-center gap-2.5 shrink-0">
                        <Award className="w-5 h-5 text-[#EF3340]" />
                        <div>
                          <p className="text-[10px] uppercase tracking-wider text-[#A1A1AA]">
                            Campeão Oficial
                          </p>
                          <p className="text-sm font-bold text-white">{t.championTeamName}</p>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Tabelas de Grupos Estruturadas */}
                  {hasStructuredGroups ? (
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                      {t.groups!.map((grp) => (
                        <div
                          key={grp.name}
                          className="bg-[#0D0D10] border border-white/8 rounded-md p-4 space-y-3"
                        >
                          <div className="flex items-center justify-between border-b border-white/8 pb-2">
                            <h4 className="text-sm font-bold text-white">Grupo {grp.name}</h4>
                            <span className="text-[11px] text-[#71717A]">
                              Top {t.rules?.qualifiersPerGroup ?? 2} avançam
                            </span>
                          </div>
                          <div className="overflow-x-auto">
                            <table className="w-full min-w-[340px] text-xs">
                              <thead>
                                <tr className="text-[#71717A] border-b border-white/8">
                                  <th className="py-1.5 text-left font-medium">#</th>
                                  <th className="py-1.5 text-left font-medium">Equipe</th>
                                  <th className="py-1.5 text-right font-medium">J</th>
                                  <th className="py-1.5 text-right font-medium">V</th>
                                  <th className="py-1.5 text-right font-medium">D</th>
                                  <th className="py-1.5 text-right font-medium">SG</th>
                                  <th className="py-1.5 text-right font-medium">Pts</th>
                                </tr>
                              </thead>
                              <tbody>
                                {grp.standings.map((row) => (
                                  <tr
                                    key={row.teamId || row.team}
                                    className="border-b border-white/5 last:border-none"
                                  >
                                    <td className="py-2 font-mono-tabular text-[#A1A1AA]">
                                      <span
                                        className={
                                          row.qualified
                                            ? 'text-[#16A34A] font-bold'
                                            : row.tieStatus === 'unresolved'
                                              ? 'text-[#D97706] font-bold'
                                              : ''
                                        }
                                      >
                                        {row.position}º
                                      </span>
                                    </td>
                                    <td className="py-2 font-medium text-white">
                                      {row.team}
                                      {row.tieStatus === 'unresolved' && (
                                        <span className="block text-[10px] text-[#D97706]">
                                          Empate em análise administrativa
                                        </span>
                                      )}
                                    </td>
                                    <td className="py-2 text-right font-mono-tabular text-[#A1A1AA]">
                                      {row.played ?? row.wins + row.losses}
                                    </td>
                                    <td className="py-2 text-right font-mono-tabular text-white">
                                      {row.wins}
                                    </td>
                                    <td className="py-2 text-right font-mono-tabular text-[#A1A1AA]">
                                      {row.losses}
                                    </td>
                                    <td className="py-2 text-right font-mono-tabular text-[#A1A1AA]">
                                      {typeof row.gameDiff === 'number'
                                        ? row.gameDiff > 0
                                          ? `+${row.gameDiff}`
                                          : row.gameDiff
                                        : '—'}
                                    </td>
                                    <td className="py-2 text-right font-mono-tabular font-bold text-white">
                                      {row.points}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    t.standings &&
                    t.standings.length > 0 && (
                      <div className="pt-2 overflow-x-auto">
                        <table className="w-full min-w-[280px] text-xs">
                          <thead>
                            <tr className="text-[#71717A] border-b border-white/8">
                              <th className="py-1.5 text-left font-medium">#</th>
                              <th className="py-1.5 text-left font-medium">Equipe</th>
                              <th className="py-1.5 text-right font-medium">V</th>
                              <th className="py-1.5 text-right font-medium">D</th>
                              <th className="py-1.5 text-right font-medium">Pts</th>
                            </tr>
                          </thead>
                          <tbody>
                            {t.standings.map((row) => (
                              <tr key={row.team} className="border-b border-white/5 last:border-none">
                                <td className="py-1.5 font-mono-tabular">{row.position}</td>
                                <td className="py-1.5 font-medium text-white">{row.team}</td>
                                <td className="py-1.5 text-right font-mono-tabular">{row.wins}</td>
                                <td className="py-1.5 text-right font-mono-tabular">{row.losses}</td>
                                <td className="py-1.5 text-right font-mono-tabular font-semibold">
                                  {row.points}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )
                  )}

                  {/* Chaveamento de Playoffs / Grande Final */}
                  {playoffMatches.length > 0 && (
                    <div className="pt-3 border-t border-white/8 space-y-3">
                      <h4 className="text-xs font-semibold uppercase tracking-wider text-[#A1A1AA]">
                        Playoffs e Grande Final
                      </h4>
                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                        {playoffMatches.map((pm) => (
                          <div
                            key={pm.id}
                            className="bg-[#0D0D10] border border-white/10 rounded-md p-3.5 space-y-2"
                          >
                            <div className="flex items-center justify-between text-[11px] text-[#A1A1AA]">
                              <span className="font-semibold text-[#EF3340]">
                                {pm.stage === 'final' ? 'GRANDE FINAL' : pm.bracketSlot || 'PLAYOFFS'} · {pm.format}
                              </span>
                              <span className="font-mono-tabular">{formatFirestoreDate(pm.scheduledAt)}</span>
                            </div>
                            <div className="space-y-1 text-sm">
                              <div className="flex items-center justify-between">
                                <span className="font-semibold text-white">
                                  {pm.teamAName || pm.teamName}
                                </span>
                                <span className="font-mono-tabular font-bold text-white">
                                  {pm.nxfScore ?? 0}
                                </span>
                              </div>
                              <div className="flex items-center justify-between">
                                <span className="font-semibold text-white">
                                  {pm.teamBName || pm.opponentName}
                                </span>
                                <span className="font-mono-tabular font-bold text-white">
                                  {pm.opponentScore ?? 0}
                                </span>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Partidas */}
      <section className="space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Calendar className="w-4 h-4 text-[#EF3340]" />
            <h2 className="font-display text-2xl font-bold text-white">Calendário e Confrontos</h2>
          </div>

          <div className="inline-flex items-center gap-1 p-1 bg-[#15151A] border border-white/10 rounded-md self-start">
            {(
              [
                { id: 'all', label: 'Todas' },
                { id: 'scheduled', label: 'Agendadas' },
                { id: 'live_manual', label: 'Em andamento' },
                { id: 'completed', label: 'Encerradas' },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setFilterStatus(tab.id)}
                className={`px-3 py-1.5 text-xs font-medium rounded transition-colors ${
                  filterStatus === tab.id
                    ? 'bg-[#DC172B] text-white'
                    : 'text-[#A1A1AA] hover:text-white'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {loading ? (
          <LoadingSkeleton rows={3} />
        ) : filteredMatches.length === 0 ? (
          <EmptyState
            title="Nenhuma partida encontrada para o filtro"
            description="Partidas agendadas e placares encerrados registrados no painel competitivo serão listados aqui."
          />
        ) : (
          <div className="space-y-3">
            {filteredMatches.map((m) => (
              <div
                key={m.id}
                className="bg-[#15151A] border border-white/8 rounded-lg p-5 space-y-3"
              >
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div>
                    <p className="text-xs text-[#A1A1AA]">
                      {m.tournamentName || 'Série competitiva'}
                      {m.stage === 'groups' && m.groupName ? ` · Grupo ${m.groupName} (R${m.round ?? 1})` : ''}
                      {m.stage === 'playoffs' ? ` · Playoffs (${m.bracketSlot || 'Chave'})` : ''}
                      {m.stage === 'final' ? ' · Grande Final' : ''}
                      {' · '}{m.format} · {formatFirestoreDate(m.scheduledAt)}
                    </p>
                    <h3 className="text-lg font-bold text-white mt-0.5">
                      {m.teamAName || m.teamName} vs {m.teamBName || m.opponentName}
                    </h3>
                  </div>
                  <div className="text-right">
                    <div className="font-mono-tabular text-xl font-bold text-white">
                      {m.status === 'completed' || m.status === 'live_manual'
                        ? `${m.nxfScore ?? 0} : ${m.opponentScore ?? 0}`
                        : 'Agendada'}
                    </div>
                    {m.resultSource && m.resultSource !== 'manual' && (
                      <p className="text-[11px] text-[#16A34A] inline-flex items-center gap-1">
                        <ShieldCheck className="w-3 h-3" />
                        {m.resultSource === 'auto_tracker' ? 'Validado via Battlelog' : 'Híbrido (Tracker + Admin)'}
                      </p>
                    )}
                  </div>
                </div>
                {Array.isArray(m.games) && m.games.length > 0 ? (
                  <div className="flex flex-wrap gap-x-5 gap-y-1.5 pt-2 border-t border-white/6 text-xs text-[#A1A1AA]">
                    {m.games.map((g) => (
                      <span key={g.gameNumber} className="font-mono-tabular">
                        Jogo {g.gameNumber}: {g.mode || '3v3'}
                        {g.map ? ` (${g.map})` : ''} —{' '}
                        <strong className="text-white">
                          {g.winnerSide === 'teamA'
                            ? m.teamAName || m.teamName
                            : m.teamBName || m.opponentName}
                        </strong>
                      </span>
                    ))}
                  </div>
                ) : (
                  m.maps &&
                  m.maps.length > 0 && (
                    <div className="flex flex-wrap gap-4 pt-2 border-t border-white/6 text-xs text-[#A1A1AA]">
                      {m.maps.map((mp, i) => (
                        <span key={i}>
                          Set {i + 1}: {mp.mode} ({mp.map})
                        </span>
                      ))}
                    </div>
                  )
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
