import React, { useEffect, useState } from 'react';
import { Columns3, Plus, Table2 } from 'lucide-react';
import {
  addDoc,
  collection,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../../lib/firebase';
import { useAuth } from '../../context/AuthContext';
import { EmptyState } from '../../components/common/StateViews';
import type { Application, ApplicationStage, Team, Vacancy } from '../../types/nxf';

const STAGES: Array<{ id: ApplicationStage; label: string }> = [
  { id: 'recebida', label: 'Recebida' },
  { id: 'em_analise', label: 'Em análise' },
  { id: 'em_teste', label: 'Em teste' },
  { id: 'aprovada', label: 'Aprovada' },
  { id: 'rejeitada', label: 'Rejeitada' },
];

export function RecruitmentAdminPage() {
  const { firebaseUser, capabilities } = useAuth();
  const [viewMode, setViewMode] = useState<'table' | 'kanban'>('kanban');
  const [teams, setTeams] = useState<Team[]>([]);
  const [vacancies, setVacancies] = useState<Vacancy[]>([]);
  const [applications, setApplications] = useState<Application[]>([]);

  const [vTeamId, setVTeamId] = useState('');
  const [vTitle, setVTitle] = useState('');
  const [vRoleTarget, setVRoleTarget] = useState('Jogador Titular');
  const [vReqs, setVReqs] = useState('');
  const [notesDraft, setNotesDraft] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState('');

  useEffect(() => {
    if (!firebaseUser) return;
    const u1 = onSnapshot(collection(db, 'teams'), (s) => {
      const list = s.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Team, 'id'>) }));
      setTeams(list);
      if (!vTeamId && list.length > 0) setVTeamId(list[0].id);
    }, () => {});

    const u2 = onSnapshot(
      query(collection(db, 'vacancies'), orderBy('createdAt', 'desc')),
      (s) => setVacancies(s.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Vacancy, 'id'>) }))),
      () => {}
    );

    const hasGlobalRecruitment =
      capabilities.isPrimaryAdmin ||
      capabilities.permissions.includes('recruitment.manage');
    const scopedTeams = capabilities.teamIds.slice(0, 10);

    const appQuery = hasGlobalRecruitment
      ? collection(db, 'applications')
      : capabilities.canManageRecruitment && scopedTeams.length > 0
        ? query(collection(db, 'applications'), where('teamId', 'in', scopedTeams))
        : query(collection(db, 'applications'), where('applicantUid', '==', firebaseUser.uid));

    const u3 = onSnapshot(
      appQuery,
      (s) =>
        setApplications(
          s.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Application, 'id'>) }))
        ),
      () => {}
    );

    return () => {
      u1();
      u2();
      u3();
    };
  }, [
    firebaseUser,
    capabilities.isPrimaryAdmin,
    capabilities.permissions,
    capabilities.canManageRecruitment,
    capabilities.teamIds,
    vTeamId,
  ]);

  const handleCreateVacancy = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firebaseUser || !vTeamId || !vTitle.trim()) return;
    const teamObj = teams.find((t) => t.id === vTeamId);
    try {
      await addDoc(collection(db, 'vacancies'), {
        teamId: vTeamId,
        teamName: teamObj?.name || vTeamId,
        title: vTitle.trim().slice(0, 80),
        roleTarget: vRoleTarget.trim().slice(0, 40),
        requirements: vReqs.trim().slice(0, 1500),
        status: 'open',
        createdBy: firebaseUser.uid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      setVTitle('');
      setVReqs('');
      setFeedback('Vaga aberta e publicada no portal.');
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, 'vacancies');
    }
  };

  const handleMoveStage = async (app: Application, nextStage: ApplicationStage) => {
    try {
      await updateDoc(doc(db, 'applications', app.id), {
        stage: nextStage,
        internalNotes: notesDraft[app.id] ?? app.internalNotes ?? '',
        updatedAt: serverTimestamp(),
      });
      setFeedback(`Candidatura de ${app.applicantName} movida para ${nextStage}.`);
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `applications/${app.id}`);
    }
  };

  return (
    <div className="space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-white/8 pb-4">
        <div>
          <h1 className="font-display text-3xl font-bold text-white">Recrutamento</h1>
          <p className="text-xs text-[#A1A1AA]">
            {capabilities.canManageRecruitment
              ? 'Gestão de vagas, notas internas protegidas e pipeline em Tabela ou Kanban.'
              : 'Acompanhe em tempo real a etapa das suas candidaturas enviadas.'}
          </p>
        </div>

        {capabilities.canManageRecruitment && (
          <div className="inline-flex items-center gap-1 p-1 bg-[#15151A] border border-white/10 rounded-md self-start">
            <button
              type="button"
              onClick={() => setViewMode('kanban')}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded ${
                viewMode === 'kanban' ? 'bg-[#DC172B] text-white' : 'text-[#A1A1AA]'
              }`}
            >
              <Columns3 className="w-3.5 h-3.5" /> Kanban
            </button>
            <button
              type="button"
              onClick={() => setViewMode('table')}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded ${
                viewMode === 'table' ? 'bg-[#DC172B] text-white' : 'text-[#A1A1AA]'
              }`}
            >
              <Table2 className="w-3.5 h-3.5" /> Tabela
            </button>
          </div>
        )}
      </div>

      {feedback && (
        <div className="p-3 bg-[#15151A] border border-[#DC172B]/50 rounded text-xs text-white">
          {feedback}
        </div>
      )}

      {capabilities.canManageRecruitment && teams.length > 0 && (
        <form
          onSubmit={handleCreateVacancy}
          className="bg-[#15151A] border border-white/8 rounded-lg p-5 space-y-4"
        >
          <h2 className="text-base font-bold text-white flex items-center gap-2">
            <Plus className="w-4 h-4 text-[#EF3340]" /> Abrir Nova Vaga ({vacancies.length} cadastradas)
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <select
              value={vTeamId}
              onChange={(e) => setVTeamId(e.target.value)}
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
              value={vTitle}
              onChange={(e) => setVTitle(e.target.value)}
              placeholder="Título da vaga"
              className="bg-[#0D0D10] border border-white/12 rounded px-3 py-2 text-sm text-white"
            />
            <input
              type="text"
              required
              value={vRoleTarget}
              onChange={(e) => setVRoleTarget(e.target.value)}
              placeholder="Função (ex.: Controlador / Tank)"
              className="bg-[#0D0D10] border border-white/12 rounded px-3 py-2 text-sm text-white"
            />
          </div>
          <textarea
            rows={2}
            value={vReqs}
            onChange={(e) => setVReqs(e.target.value)}
            placeholder="Requisitos mínimos e horários de treino..."
            className="w-full bg-[#0D0D10] border border-white/12 rounded px-3 py-2 text-sm text-white"
          />
          <button
            type="submit"
            className="px-4 py-2 bg-[#DC172B] hover:bg-[#EF3340] text-xs font-semibold text-white rounded"
          >
            Publicar vaga
          </button>
        </form>
      )}

      {applications.length === 0 ? (
        <EmptyState
          title="Nenhuma candidatura registrada"
          description={
            capabilities.canManageRecruitment
              ? 'As inscrições enviadas pelos candidatos no portal aparecerão aqui.'
              : 'Acesse a página Recrutamento no portal público para enviar uma candidatura.'
          }
        />
      ) : !capabilities.canManageRecruitment || viewMode === 'table' ? (
        <div className="bg-[#15151A] border border-white/8 rounded-lg overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-[#71717A] border-b border-white/8">
                <th className="p-3 text-left">Candidato</th>
                <th className="p-3 text-left">Tag</th>
                <th className="p-3 text-left">Equipe</th>
                <th className="p-3 text-left">Etapa</th>
                {capabilities.canManageRecruitment && <th className="p-3 text-right">Mover para</th>}
              </tr>
            </thead>
            <tbody>
              {applications.map((app) => (
                <tr key={app.id} className="border-b border-white/5 last:border-none">
                  <td className="p-3 font-semibold text-white">{app.applicantName}</td>
                  <td className="p-3 font-mono-tabular text-[#A1A1AA]">{app.brawlTag || '—'}</td>
                  <td className="p-3 text-[#A1A1AA]">{app.teamId}</td>
                  <td className="p-3 text-white font-medium">{app.stage}</td>
                  {capabilities.canManageRecruitment && (
                    <td className="p-3 text-right">
                      <select
                        value={app.stage}
                        disabled={app.stage === 'aprovada' || app.stage === 'rejeitada'}
                        onChange={(e) =>
                          void handleMoveStage(app, e.target.value as ApplicationStage)
                        }
                        className="bg-[#0D0D10] border border-white/12 rounded px-2 py-1 text-xs text-white"
                      >
                        {STAGES.map((st) => (
                          <option key={st.id} value={st.id}>
                            {st.label}
                          </option>
                        ))}
                      </select>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
          {STAGES.map((stage) => {
            const items = applications.filter((a) => a.stage === stage.id);
            return (
              <div
                key={stage.id}
                className="bg-[#15151A] border border-white/8 rounded-lg p-3 space-y-3"
              >
                <div className="flex items-center justify-between border-b border-white/8 pb-2">
                  <h3 className="text-xs font-bold text-white">{stage.label}</h3>
                  <span className="font-mono-tabular text-xs text-[#A1A1AA]">
                    {items.length}
                  </span>
                </div>
                <div className="space-y-2.5">
                  {items.map((app) => (
                    <div
                      key={app.id}
                      className="bg-[#0D0D10] border border-white/8 rounded p-3 space-y-2"
                    >
                      <p className="text-xs font-bold text-white">{app.applicantName}</p>
                      <p className="text-[11px] font-mono-tabular text-[#A1A1AA]">
                        {app.brawlTag || 'Sem tag'} · {app.teamId}
                      </p>
                      <textarea
                        rows={2}
                        value={notesDraft[app.id] ?? app.internalNotes ?? ''}
                        onChange={(e) =>
                          setNotesDraft((prev) => ({ ...prev, [app.id]: e.target.value }))
                        }
                        placeholder="Nota interna protegida..."
                        className="w-full bg-[#15151A] border border-white/10 rounded px-2 py-1 text-[11px] text-white"
                      />
                      {app.stage !== 'aprovada' && app.stage !== 'rejeitada' && (
                        <select
                          value={app.stage}
                          onChange={(e) =>
                            void handleMoveStage(app, e.target.value as ApplicationStage)
                          }
                          className="w-full bg-[#15151A] border border-white/12 rounded px-2 py-1 text-[11px] text-white"
                        >
                          {STAGES.map((st) => (
                            <option key={st.id} value={st.id}>
                              {st.label}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
