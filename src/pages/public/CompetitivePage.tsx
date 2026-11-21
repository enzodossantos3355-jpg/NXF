import React, { useEffect, useState } from 'react';
import { Calendar, Info, Trophy } from 'lucide-react';
import { collection, onSnapshot, orderBy, query, where } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { formatFirestoreDate } from '../../lib/permissions';
import { EmptyState, LoadingSkeleton } from '../../components/common/StateViews';
import type { Match, Tournament } from '../../types/nxf';

export function CompetitivePage() {
  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const [matches, setMatches] = useState<Match[]>([]);
  const [filterStatus, setFilterStatus] = useState<'all' | 'scheduled' | 'completed'>('all');
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
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-10 space-y-8">
      <div className="border-b border-white/8 pb-5 space-y-2">
        <p className="text-xs font-semibold text-[#EF3340] uppercase tracking-wider">
          Cenário Oficial
        </p>
        <h1 className="font-display text-4xl font-bold text-white">
          Competitivo Brawl Stars
        </h1>
        <p className="text-sm text-[#A1A1AA] max-w-2xl">
          Campeonatos, calendário de séries MD3/MD5/MD7, mapas/modos e classificações oficiais.
        </p>
        <div className="flex items-start gap-2 text-xs text-[#A1A1AA] pt-1">
          <Info className="w-4 h-4 text-[#EF3340] shrink-0 mt-0.5" />
          <span>
            Nota de transparência: placares e resultados de torneios são inseridos e validados manualmente pelos responsáveis autorizados da organização (a API oficial do Brawl Stars não fornece resultados ao vivo de torneios).
          </span>
        </div>
      </div>

      {/* Campeonatos */}
      <section className="space-y-4">
        <div className="flex items-center gap-2">
          <Trophy className="w-4 h-4 text-[#EF3340]" />
          <h2 className="font-display text-2xl font-bold">Campeonatos e Classificações</h2>
        </div>

        {tournaments.length === 0 ? (
          <EmptyState
            title="Nenhum campeonato público registrado"
            description="Quando a organização inscrever equipes em ligas ou torneios, as tabelas e formatos aparecerão aqui."
          />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {tournaments.map((t) => (
              <div
                key={t.id}
                className="bg-[#15151A] border border-white/8 rounded-lg p-5 space-y-2"
              >
                <p className="text-xs text-[#EF3340] font-medium">
                  {t.format} · {t.status === 'ongoing' ? 'Em andamento' : t.status === 'completed' ? 'Encerrado' : 'Em breve'}
                </p>
                <h3 className="text-lg font-bold text-white">{t.name}</h3>
                {t.organizer && (
                  <p className="text-xs text-[#A1A1AA]">Organizador: {t.organizer}</p>
                )}
                {t.standings && t.standings.length > 0 && (
                  <div className="pt-3 border-t border-white/8 overflow-x-auto">
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
                            <td className="py-1.5 text-right font-mono-tabular font-semibold">{row.points}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Partidas */}
      <section className="space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Calendar className="w-4 h-4 text-[#EF3340]" />
            <h2 className="font-display text-2xl font-bold">Calendário e Partidas</h2>
          </div>

          <div className="inline-flex items-center gap-1 p-1 bg-[#15151A] border border-white/10 rounded-md self-start">
            {(
              [
                { id: 'all', label: 'Todas' },
                { id: 'scheduled', label: 'Agendadas' },
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
                      {m.tournamentName || 'Série competitiva'} · {m.format} · {formatFirestoreDate(m.scheduledAt)}
                    </p>
                    <h3 className="text-lg font-bold text-white mt-0.5">
                      {m.teamName} vs {m.opponentName}
                    </h3>
                  </div>
                  <div className="font-mono-tabular text-xl font-bold text-white">
                    {m.status === 'completed' || m.status === 'live_manual'
                      ? `${m.nxfScore ?? 0} : ${m.opponentScore ?? 0}`
                      : 'Agendada'}
                  </div>
                </div>
                {m.maps && m.maps.length > 0 && (
                  <div className="flex flex-wrap gap-4 pt-2 border-t border-white/6 text-xs text-[#A1A1AA]">
                    {m.maps.map((mp, i) => (
                      <span key={i}>
                        Set {i + 1}: {mp.mode} ({mp.map})
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
