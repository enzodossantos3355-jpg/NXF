import React, { useEffect, useState } from 'react';
import { Plus, Trophy } from 'lucide-react';
import {
  addDoc,
  collection,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  Timestamp,
  updateDoc,
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../../lib/firebase';
import { useAuth } from '../../context/AuthContext';
import { formatFirestoreDate } from '../../lib/permissions';
import { EmptyState } from '../../components/common/StateViews';
import type { Match, MatchFormat, Team, Tournament } from '../../types/nxf';

export function CompetitiveAdminPage() {
  const { firebaseUser, capabilities } = useAuth();
  const [teams, setTeams] = useState<Team[]>([]);
  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const [matches, setMatches] = useState<Match[]>([]);

  const [tName, setTName] = useState('');
  const [tFormat, setTFormat] = useState<Tournament['format']>('MD5');
  const [mTeamId, setMTeamId] = useState('');
  const [mOpponent, setMOpponent] = useState('');
  const [mTournamentName, setMTournamentName] = useState('');
  const [mFormat, setMFormat] = useState<MatchFormat>('MD5');
  const [mDate, setMDate] = useState('');
  const [feedback, setFeedback] = useState('');

  useEffect(() => {
    const u1 = onSnapshot(collection(db, 'teams'), (s) => {
      const list = s.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Team, 'id'>) }));
      setTeams(list);
      if (!mTeamId && list.length > 0) setMTeamId(list[0].id);
    }, () => {});
    const u2 = onSnapshot(collection(db, 'tournaments'), (s) => {
      setTournaments(s.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Tournament, 'id'>) })));
    }, () => {});
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
  }, [mTeamId]);

  const handleCreateTournament = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tName.trim()) return;
    try {
      await addDoc(collection(db, 'tournaments'), {
        name: tName.trim().slice(0, 100),
        format: tFormat,
        status: 'ongoing',
        isPublic: true,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      setTName('');
      setFeedback('Campeonato cadastrado.');
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, 'tournaments');
    }
  };

  const handleCreateMatch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firebaseUser || !mTeamId || !mOpponent.trim() || !mDate) return;
    const teamObj = teams.find((t) => t.id === mTeamId);
    try {
      await addDoc(collection(db, 'matches'), {
        teamId: mTeamId,
        teamName: teamObj?.name || mTeamId,
        tournamentName: mTournamentName.trim().slice(0, 100),
        opponentName: mOpponent.trim().slice(0, 60),
        format: mFormat,
        scheduledAt: Timestamp.fromDate(new Date(mDate)),
        status: 'scheduled',
        nxfScore: 0,
        opponentScore: 0,
        isPublic: true,
        enteredBy: firebaseUser.uid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      setMOpponent('');
      setMTournamentName('');
      setFeedback('Partida agendada com sucesso.');
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, 'matches');
    }
  };

  const handleScoreUpdate = async (
    match: Match,
    nxfScore: number,
    opponentScore: number,
    complete: boolean
  ) => {
    try {
      await updateDoc(doc(db, 'matches', match.id), {
        nxfScore,
        opponentScore,
        status: complete ? 'completed' : 'live_manual',
        updatedAt: serverTimestamp(),
      });
      setFeedback('Placar oficial atualizado.');
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `matches/${match.id}`);
    }
  };

  return (
    <div className="space-y-8">
      <div className="border-b border-white/8 pb-4">
        <h1 className="font-display text-3xl font-bold text-white">Gestão Competitiva</h1>
        <p className="text-xs text-[#A1A1AA]">
          Cadastro de campeonatos, confrontos MD3/MD5/MD7 e atualização manual autorizada de placares.
        </p>
      </div>

      {feedback && (
        <div className="p-3 bg-[#15151A] border border-[#DC172B]/50 rounded text-xs text-white">
          {feedback}
        </div>
      )}

      {capabilities.canManageCompetitive && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <form
            onSubmit={handleCreateTournament}
            className="bg-[#15151A] border border-white/8 rounded-lg p-5 space-y-4"
          >
            <h2 className="text-base font-bold text-white flex items-center gap-2">
              <Trophy className="w-4 h-4 text-[#EF3340]" /> Novo Campeonato
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <input
                type="text"
                required
                minLength={3}
                value={tName}
                onChange={(e) => setTName(e.target.value)}
                placeholder="Nome do campeonato"
                className="bg-[#0D0D10] border border-white/12 rounded px-3 py-2 text-sm text-white"
              />
              <select
                value={tFormat}
                onChange={(e) => setTFormat(e.target.value as Tournament['format'])}
                className="bg-[#0D0D10] border border-white/12 rounded px-3 py-2 text-xs text-white"
              >
                <option value="MD3">MD3</option>
                <option value="MD5">MD5</option>
                <option value="MD7">MD7</option>
                <option value="Pontos Corridos">Pontos Corridos</option>
                <option value="Chave Dupla">Chave Dupla</option>
              </select>
            </div>
            <button
              type="submit"
              className="px-4 py-2 bg-[#202027] hover:bg-[#2B2B35] border border-white/10 text-xs font-semibold text-white rounded"
            >
              Cadastrar campeonato
            </button>
          </form>

          <form
            onSubmit={handleCreateMatch}
            className="bg-[#15151A] border border-white/8 rounded-lg p-5 space-y-4"
          >
            <h2 className="text-base font-bold text-white flex items-center gap-2">
              <Plus className="w-4 h-4 text-[#EF3340]" /> Agendar Confronto
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
                placeholder="Campeonato / Etapa"
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
              className="px-4 py-2 bg-[#DC172B] hover:bg-[#EF3340] disabled:opacity-40 text-xs font-semibold text-white rounded"
            >
              Agendar partida
            </button>
          </form>
        </div>
      )}

      <div className="space-y-3">
        <h2 className="font-display text-2xl font-bold text-white">
          Partidas e Placares ({tournaments.length} campeonatos)
        </h2>
        {matches.length === 0 ? (
          <EmptyState
            title="Nenhuma partida registrada"
            description="Cadastre equipes em Organização e agende confrontos oficiais aqui."
          />
        ) : (
          <div className="space-y-3">
            {matches.map((m) => (
              <div
                key={m.id}
                className="bg-[#15151A] border border-white/8 rounded-lg p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
              >
                <div>
                  <p className="text-xs text-[#A1A1AA]">
                    {m.tournamentName || 'Série'} · {m.format} · {formatFirestoreDate(m.scheduledAt)} · {m.status}
                  </p>
                  <p className="text-base font-bold text-white">
                    {m.teamName} ({m.nxfScore ?? 0}) vs ({m.opponentScore ?? 0}) {m.opponentName}
                  </p>
                </div>

                {capabilities.canManageCompetitive && m.status !== 'completed' && (
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        void handleScoreUpdate(m, (m.nxfScore ?? 0) + 1, m.opponentScore ?? 0, false)
                      }
                      className="px-2.5 py-1.5 bg-[#202027] rounded text-xs font-mono-tabular"
                    >
                      +1 NXF
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        void handleScoreUpdate(m, m.nxfScore ?? 0, (m.opponentScore ?? 0) + 1, false)
                      }
                      className="px-2.5 py-1.5 bg-[#202027] rounded text-xs font-mono-tabular"
                    >
                      +1 Adv
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        void handleScoreUpdate(m, m.nxfScore ?? 0, m.opponentScore ?? 0, true)
                      }
                      className="px-3 py-1.5 bg-[#DC172B] hover:bg-[#EF3340] rounded text-xs font-semibold text-white"
                    >
                      Encerrar série
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
