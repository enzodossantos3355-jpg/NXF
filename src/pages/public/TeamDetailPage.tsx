import React, { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Calendar, Trophy, Users } from 'lucide-react';
import {
  collection,
  doc,
  onSnapshot,
  query,
  where,
} from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { formatFirestoreDate } from '../../lib/permissions';
import { EmptyState, LoadingSkeleton } from '../../components/common/StateViews';
import { SafeImage } from '../../components/common/BrandMark';
import type { Achievement, Match, Team, TeamMembership } from '../../types/nxf';

const TEAM_ROLE_LABEL: Record<TeamMembership['roleInTeam'], string> = {
  manager: 'Gerente',
  coach: 'Técnico',
  starter: 'Titular',
  reserve: 'Reserva',
  analyst: 'Analista',
};

export function TeamDetailPage() {
  const { teamId } = useParams<{ teamId: string }>();
  const [team, setTeam] = useState<Team | null>(null);
  const [members, setMembers] = useState<TeamMembership[]>([]);
  const [matches, setMatches] = useState<Match[]>([]);
  const [achievements, setAchievements] = useState<Achievement[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!teamId) return;
    const unsubs: Array<() => void> = [];

    unsubs.push(
      onSnapshot(
        doc(db, 'teams', teamId),
        (snap) => {
          setTeam(snap.exists() ? { id: snap.id, ...(snap.data() as Omit<Team, 'id'>) } : null);
          setLoading(false);
        },
        () => setLoading(false)
      )
    );

    unsubs.push(
      onSnapshot(
        query(
          collection(db, 'teamMemberships'),
          where('teamId', '==', teamId),
          where('status', '==', 'active')
        ),
        (snap) => {
          setMembers(snap.docs.map((d) => ({ id: d.id, ...(d.data() as TeamMembership) })));
        },
        () => {}
      )
    );

    unsubs.push(
      onSnapshot(
        query(
          collection(db, 'matches'),
          where('teamId', '==', teamId),
          where('isPublic', '==', true)
        ),
        (snap) => {
          setMatches(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Match, 'id'>) })));
        },
        () => {}
      )
    );

    unsubs.push(
      onSnapshot(
        query(
          collection(db, 'achievements'),
          where('teamId', '==', teamId),
          where('isPublic', '==', true)
        ),
        (snap) => {
          setAchievements(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Achievement, 'id'>) })));
        },
        () => {}
      )
    );

    return () => unsubs.forEach((u) => u());
  }, [teamId]);

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-10">
        <LoadingSkeleton rows={4} />
      </div>
    );
  }

  if (!team) {
    return (
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-10 space-y-4">
        <Link to="/equipes" className="inline-flex items-center gap-1.5 text-xs text-[#A1A1AA] hover:text-white">
          <ArrowLeft className="w-3.5 h-3.5" /> Voltar às equipes
        </Link>
        <EmptyState
          title="Equipe não encontrada"
          description="Esta divisão não existe ou não está marcada como pública."
        />
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-10 space-y-10">
      <div className="space-y-4">
        <Link to="/equipes" className="inline-flex items-center gap-1.5 text-xs text-[#A1A1AA] hover:text-white">
          <ArrowLeft className="w-3.5 h-3.5" /> Todas as equipes
        </Link>

        <div className="bg-[#15151A] border border-white/8 rounded-lg overflow-hidden">
          <SafeImage
            src={team.bannerUrl || team.logoUrl}
            alt={team.name}
            className="h-52 sm:h-64 w-full object-cover"
            fallbackLabel={team.name}
          />
          <div className="p-6 space-y-2">
            <p className="text-xs font-semibold text-[#EF3340]">{team.category}</p>
            <h1 className="font-display text-3xl sm:text-4xl font-bold text-white">{team.name}</h1>
            {team.description && (
              <p className="text-sm text-[#A1A1AA] max-w-3xl leading-relaxed">{team.description}</p>
            )}
          </div>
        </div>
      </div>

      {/* Elenco & Comissão Técnica */}
      <section className="space-y-4">
        <div className="flex items-center gap-2 border-b border-white/8 pb-3">
          <Users className="w-4 h-4 text-[#EF3340]" />
          <h2 className="font-display text-2xl font-bold">Elenco e Comissão Técnica</h2>
        </div>
        {members.length === 0 ? (
          <EmptyState
            title="Nenhum membro vinculado"
            description="Titulares, reservas, técnicos e gerentes vinculados a esta equipe aparecerão aqui."
          />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {members.map((m) => (
              <Link
                key={m.uid}
                to={`/membro/${m.uid}`}
                className="bg-[#15151A] border border-white/8 hover:border-white/20 rounded-md p-4 space-y-1 transition-colors"
              >
                <p className="text-xs text-[#EF3340] font-medium">
                  {TEAM_ROLE_LABEL[m.roleInTeam]}
                </p>
                <p className="text-base font-bold text-white">{m.nickname}</p>
                <p className="text-xs text-[#71717A]">Ver perfil público</p>
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* Partidas & Conquistas */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <section className="space-y-4">
          <div className="flex items-center gap-2 border-b border-white/8 pb-3">
            <Calendar className="w-4 h-4 text-[#EF3340]" />
            <h2 className="font-display text-2xl font-bold">Calendário e Resultados</h2>
          </div>
          {matches.length === 0 ? (
            <EmptyState
              title="Nenhuma partida registrada"
              description="As séries oficiais desta equipe serão listadas aqui."
            />
          ) : (
            <div className="space-y-3">
              {matches.map((m) => (
                <div
                  key={m.id}
                  className="bg-[#15151A] border border-white/8 rounded-md p-4 flex items-center justify-between gap-4"
                >
                  <div>
                    <p className="text-xs text-[#A1A1AA]">
                      {m.tournamentName || 'Série'} · {m.format} · {formatFirestoreDate(m.scheduledAt)}
                    </p>
                    <p className="text-sm font-semibold text-white mt-0.5">
                      {m.teamName} vs {m.opponentName}
                    </p>
                  </div>
                  <span className="font-mono-tabular text-sm font-bold text-white">
                    {m.status === 'completed'
                      ? `${m.nxfScore ?? 0} : ${m.opponentScore ?? 0}`
                      : 'Agendada'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="space-y-4">
          <div className="flex items-center gap-2 border-b border-white/8 pb-3">
            <Trophy className="w-4 h-4 text-[#EF3340]" />
            <h2 className="font-display text-2xl font-bold">Conquistas da Equipe</h2>
          </div>
          {achievements.length === 0 ? (
            <EmptyState
              title="Sem conquistas registradas"
              description="Premiações verificadas vinculadas a esta divisão aparecerão aqui."
            />
          ) : (
            <div className="space-y-3">
              {achievements.map((a) => (
                <div
                  key={a.id}
                  className="bg-[#15151A] border border-white/8 rounded-md p-4 space-y-1"
                >
                  <p className="text-xs font-mono-tabular text-[#EF3340]">{a.placement}</p>
                  <p className="text-sm font-semibold text-white">{a.title}</p>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
