import React, { useEffect, useState } from 'react';
import { CalendarClock, Check, X } from 'lucide-react';
import {
  addDoc,
  collection,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../../lib/firebase';
import { useAuth } from '../../context/AuthContext';
import { formatFirestoreDate } from '../../lib/permissions';
import { EmptyState } from '../../components/common/StateViews';
import type { Attendance, Team, Training } from '../../types/nxf';

export function TrainingsPage() {
  const { firebaseUser, publicProfile, userDoc, capabilities } = useAuth();
  const [teams, setTeams] = useState<Team[]>([]);
  const [trainings, setTrainings] = useState<Training[]>([]);
  const [attendanceMap, setAttendanceMap] = useState<Record<string, Attendance[]>>({});

  const [teamId, setTeamId] = useState('');
  const [title, setTitle] = useState('');
  const [objectives, setObjectives] = useState('');
  const [dateStr, setDateStr] = useState('');
  const [justification, setJustification] = useState('');
  const [feedback, setFeedback] = useState('');

  useEffect(() => {
    if (!firebaseUser) return;
    const u1 = onSnapshot(
      collection(db, 'teams'),
      (s) => {
        const list = s.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Team, 'id'>) }));
        setTeams(list);
        if (!teamId && list.length > 0) setTeamId(list[0].id);
      },
      () => {}
    );

    const scopedTeamIds = capabilities.teamIds.slice(0, 10);
    let u2 = () => {};
    if (capabilities.isAnyAdmin) {
      u2 = onSnapshot(
        query(collection(db, 'trainings'), orderBy('scheduledAt', 'desc')),
        (s) => setTrainings(s.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Training, 'id'>) }))),
        () => {}
      );
    } else if (scopedTeamIds.length > 0) {
      u2 = onSnapshot(
        query(
          collection(db, 'trainings'),
          where('teamId', 'in', scopedTeamIds),
          orderBy('scheduledAt', 'desc')
        ),
        (s) => setTrainings(s.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Training, 'id'>) }))),
        () => {}
      );
    }

    let u3 = () => {};
    const attQuery = capabilities.isAnyAdmin
      ? collection(db, 'attendance')
      : (capabilities.isManager || capabilities.isCoach) && scopedTeamIds.length > 0
        ? query(collection(db, 'attendance'), where('teamId', 'in', scopedTeamIds))
        : query(collection(db, 'attendance'), where('uid', '==', firebaseUser.uid));

    u3 = onSnapshot(
      attQuery,
      (s) => {
        const grouped: Record<string, Attendance[]> = {};
        s.docs.forEach((d) => {
          const item = { id: d.id, ...(d.data() as Omit<Attendance, 'id'>) };
          if (!grouped[item.trainingId]) grouped[item.trainingId] = [];
          grouped[item.trainingId].push(item);
        });
        setAttendanceMap(grouped);
      },
      () => {}
    );

    return () => {
      u1();
      u2();
      u3();
    };
  }, [firebaseUser, capabilities.isAnyAdmin, capabilities.isManager, capabilities.isCoach, capabilities.teamIds, teamId]);

  const handleScheduleTraining = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firebaseUser || !teamId || !title.trim() || !dateStr) return;
    const teamObj = teams.find((t) => t.id === teamId);
    try {
      await addDoc(collection(db, 'trainings'), {
        teamId,
        teamName: teamObj?.name || teamId,
        title: title.trim().slice(0, 100),
        objectives: objectives.trim().slice(0, 1500),
        scheduledAt: Timestamp.fromDate(new Date(dateStr)),
        durationMinutes: 90,
        status: 'scheduled',
        createdBy: firebaseUser.uid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      setTitle('');
      setObjectives('');
      setFeedback('Treino agendado com sucesso.');
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, 'trainings');
    }
  };

  const handlePlayerConfirmation = async (
    training: Training,
    status: 'confirmed' | 'declined'
  ) => {
    if (!firebaseUser) return;
    const docId = `${training.id}_${firebaseUser.uid}`;
    const existingAtt = (attendanceMap[training.id] || []).find(
      (a) => a.uid === firebaseUser.uid
    );
    const cleanNick = (publicProfile?.nickname || userDoc?.displayName || 'Jogador').slice(0, 32);
    const cleanJustification = status === 'declined' ? justification.slice(0, 400) : '';

    try {
      if (existingAtt) {
        await updateDoc(doc(db, 'attendance', docId), {
          nickname: cleanNick,
          playerStatus: status,
          justification: cleanJustification,
          updatedAt: serverTimestamp(),
        });
      } else {
        await setDoc(doc(db, 'attendance', docId), {
          trainingId: training.id,
          teamId: training.teamId,
          uid: firebaseUser.uid,
          nickname: cleanNick,
          playerStatus: status,
          justification: cleanJustification,
          coachVerifiedStatus: 'unmarked',
          updatedAt: serverTimestamp(),
        });
      }
      setJustification('');
      setFeedback(
        status === 'confirmed'
          ? 'Presença confirmada para o treino.'
          : 'Ausência justificada registrada.'
      );
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `attendance/${docId}`);
    }
  };

  const handleCoachMarkAttendance = async (
    att: Attendance,
    status: 'present' | 'absent' | 'justified'
  ) => {
    if (!firebaseUser) return;
    try {
      await updateDoc(doc(db, 'attendance', att.id), {
        coachVerifiedStatus: status,
        verifiedBy: firebaseUser.uid,
        updatedAt: serverTimestamp(),
      });
      setFeedback(`Presença de ${att.nickname || att.uid} registrada como ${status}.`);
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `attendance/${att.id}`);
    }
  };

  return (
    <div className="space-y-8">
      <div className="border-b border-white/8 pb-4">
        <h1 className="font-display text-3xl font-bold text-white">Treinamentos</h1>
        <p className="text-xs text-[#A1A1AA]">
          Agendamento, objetivos da sessão, confirmação de presença pelos jogadores e registro real pelo técnico.
        </p>
      </div>

      {feedback && (
        <div className="p-3 bg-[#15151A] border border-[#DC172B]/50 rounded text-xs text-white">
          {feedback}
        </div>
      )}

      {(capabilities.isCoach || capabilities.isManager || capabilities.isPrimaryAdmin) &&
        teams.length > 0 && (
          <form
            onSubmit={handleScheduleTraining}
            className="bg-[#15151A] border border-white/8 rounded-lg p-5 space-y-4"
          >
            <h2 className="text-base font-bold text-white flex items-center gap-2">
              <CalendarClock className="w-4 h-4 text-[#EF3340]" /> Agendar Treinamento
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <select
                value={teamId}
                onChange={(e) => setTeamId(e.target.value)}
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
                minLength={3}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Título (ex.: Scrim MD5 Zona Estratégica)"
                className="bg-[#0D0D10] border border-white/12 rounded px-3 py-2 text-sm text-white"
              />
              <input
                type="datetime-local"
                required
                value={dateStr}
                onChange={(e) => setDateStr(e.target.value)}
                className="bg-[#0D0D10] border border-white/12 rounded px-3 py-2 text-xs text-white"
              />
            </div>
            <textarea
              rows={2}
              value={objectives}
              onChange={(e) => setObjectives(e.target.value)}
              placeholder="Objetivos táticos da sessão..."
              className="w-full bg-[#0D0D10] border border-white/12 rounded px-3 py-2 text-sm text-white"
            />
            <button
              type="submit"
              className="px-4 py-2 bg-[#DC172B] hover:bg-[#EF3340] text-xs font-semibold text-white rounded"
            >
              Agendar sessão
            </button>
          </form>
        )}

      <div className="space-y-4">
        {trainings.length === 0 ? (
          <EmptyState
            title="Nenhum treinamento agendado"
            description="Treinos agendados para sua equipe aparecerão aqui para confirmação de presença."
          />
        ) : (
          trainings.map((tr) => {
            const list = attendanceMap[tr.id] || [];
            return (
              <div
                key={tr.id}
                className="bg-[#15151A] border border-white/8 rounded-lg p-5 space-y-4"
              >
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div>
                    <p className="text-xs text-[#EF3340] font-medium">
                      {tr.teamName || tr.teamId} · {formatFirestoreDate(tr.scheduledAt)}
                    </p>
                    <h3 className="text-lg font-bold text-white">{tr.title}</h3>
                    {tr.objectives && (
                      <p className="text-xs text-[#A1A1AA] mt-1">{tr.objectives}</p>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="text"
                      value={justification}
                      onChange={(e) => setJustification(e.target.value)}
                      placeholder="Justificativa (se ausente)"
                      className="bg-[#0D0D10] border border-white/10 rounded px-2.5 py-1.5 text-xs text-white"
                    />
                    <button
                      type="button"
                      onClick={() => void handlePlayerConfirmation(tr, 'confirmed')}
                      className="inline-flex items-center gap-1 px-3 py-1.5 bg-[#202027] hover:bg-[#2B2B35] border border-white/10 text-xs font-medium text-white rounded"
                    >
                      <Check className="w-3.5 h-3.5 text-[#EF3340]" /> Confirmar
                    </button>
                    <button
                      type="button"
                      onClick={() => void handlePlayerConfirmation(tr, 'declined')}
                      className="inline-flex items-center gap-1 px-3 py-1.5 bg-[#202027] hover:bg-[#2B2B35] border border-white/10 text-xs font-medium text-[#A1A1AA] rounded"
                    >
                      <X className="w-3.5 h-3.5" /> Justificar ausência
                    </button>
                  </div>
                </div>

                {list.length > 0 && (
                  <div className="border-t border-white/8 pt-3 space-y-2">
                    <p className="text-xs font-semibold text-[#A1A1AA]">
                      Lista de presença ({list.length})
                    </p>
                    {list.map((att) => (
                      <div
                        key={att.id}
                        className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs bg-[#0D0D10] border border-white/6 rounded px-3 py-2"
                      >
                        <div>
                          <span className="font-semibold text-white">{att.nickname || att.uid}</span>
                          <span className="text-[#A1A1AA]">
                            {' '}
                            · Jogador: {att.playerStatus} · Técnico: {att.coachVerifiedStatus}
                          </span>
                          {att.justification && (
                            <span className="text-[#71717A]"> · "{att.justification}"</span>
                          )}
                        </div>
                        {(capabilities.isCoach || capabilities.isManager || capabilities.isPrimaryAdmin) && (
                          <div className="flex items-center gap-1.5">
                            {(['present', 'absent', 'justified'] as const).map((st) => (
                              <button
                                key={st}
                                type="button"
                                onClick={() => void handleCoachMarkAttendance(att, st)}
                                className="px-2 py-1 rounded bg-[#202027] hover:bg-[#DC172B] text-[11px] text-white"
                              >
                                {st === 'present' ? 'Presente' : st === 'absent' ? 'Falta' : 'Justificada'}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
