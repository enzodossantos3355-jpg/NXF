import React, { useEffect, useState } from 'react';
import { MailPlus, Plus, Users } from 'lucide-react';
import {
  collection,
  doc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  where,
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../../lib/firebase';
import { apiFetch } from '../../lib/apiClient';
import { useAuth } from '../../context/AuthContext';
import { formatFirestoreDate } from '../../lib/permissions';
import { EmptyState } from '../../components/common/StateViews';
import {
  BLUEPRINT_LIMITS,
  formatPlayerCode,
  type Invitation,
  type Team,
  type TeamMembership,
  type UserRole,
} from '../../types/nxf';

export function OrganizationPage() {
  const { firebaseUser, capabilities } = useAuth();
  const [teams, setTeams] = useState<Team[]>([]);
  const [memberships, setMemberships] = useState<TeamMembership[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);

  const [teamName, setTeamName] = useState('');
  const [teamCategory, setTeamCategory] = useState('Principal');
  const [teamDesc, setTeamDesc] = useState('');

  const [memberTeamId, setMemberTeamId] = useState('');
  const [memberUid, setMemberUid] = useState('');
  const [memberNickname, setMemberNickname] = useState('');
  const [memberRole, setMemberRole] = useState<TeamMembership['roleInTeam']>('starter');

  const [inviteCode, setInviteCode] = useState('');
  const [inviteRole, setInviteRole] = useState<UserRole>('player');
  const [inviteTeamId, setInviteTeamId] = useState('');
  const [inviteTeamRole, setInviteTeamRole] = useState<TeamMembership['roleInTeam']>('starter');
  const [savingMembership, setSavingMembership] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  const hasGlobalOrgAuthority =
    capabilities.isPrimaryAdmin ||
    capabilities.permissions.includes('teams.manage') ||
    capabilities.permissions.includes('users.manage');

  const canCreateTeams =
    capabilities.isPrimaryAdmin || capabilities.permissions.includes('teams.manage');

  const managedTeamIds = new Set(
    firebaseUser
      ? memberships
          .filter(
            (m) =>
              m.uid === firebaseUser.uid &&
              m.status === 'active' &&
              m.roleInTeam === 'manager'
          )
          .map((m) => m.teamId)
      : []
  );

  const canManageTeamRoster = (teamId: string) =>
    hasGlobalOrgAuthority || (capabilities.isManager && managedTeamIds.has(teamId));

  const manageableTeams = hasGlobalOrgAuthority
    ? teams
    : teams.filter((t) => managedTeamIds.has(t.id));

  useEffect(() => {
    const u1 = onSnapshot(
      collection(db, 'teams'),
      (s) => {
        const list = s.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Team, 'id'>) }));
        setTeams(list);
        if (!memberTeamId && list.length > 0) setMemberTeamId(list[0].id);
      },
      () => {}
    );

    const u2 = onSnapshot(
      query(collection(db, 'teamMemberships'), where('status', '==', 'active')),
      (s) => {
        setMemberships(s.docs.map((d) => ({ id: d.id, ...(d.data() as TeamMembership) })));
      },
      () => {}
    );

    let u3 = () => {};
    if (capabilities.isAnyAdmin && firebaseUser) {
      u3 = onSnapshot(
        collection(db, 'invitations'),
        (s) => {
          setInvitations(s.docs.map((d) => ({ id: d.id, ...(d.data() as Invitation) })));
        },
        () => {}
      );
    }

    return () => {
      u1();
      u2();
      u3();
    };
  }, [capabilities.isAnyAdmin, firebaseUser, memberTeamId]);

  const handleCreateTeam = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firebaseUser) return;
    setErrorMsg('');
    const slugId = teamName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .slice(0, 48);
    if (!slugId) return;

    try {
      await setDoc(doc(db, 'teams', slugId), {
        id: slugId,
        name: teamName.trim().slice(0, BLUEPRINT_LIMITS.TEAM_NAME_MAX),
        category: teamCategory.trim().slice(0, 40),
        description: teamDesc.trim().slice(0, BLUEPRINT_LIMITS.TEAM_DESC_MAX),
        isPublic: true,
        active: true,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      setTeamName('');
      setTeamDesc('');
      setFeedback(`Equipe "${teamName}" criada com ID ${slugId}.`);
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `teams/${slugId}`);
    }
  };

  const handleAddMembership = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg('');
    setFeedback('');
    const targetTeamId =
      memberTeamId && canManageTeamRoster(memberTeamId)
        ? memberTeamId
        : manageableTeams[0]?.id || '';
    if (!targetTeamId || !memberUid.trim() || !memberNickname.trim()) return;
    setSavingMembership(true);
    try {
      await apiFetch(`/api/teams/${encodeURIComponent(targetTeamId)}/memberships`, {
        method: 'POST',
        body: {
          uid: memberUid.trim(),
          nickname: memberNickname.trim().slice(0, BLUEPRINT_LIMITS.NICKNAME_MAX),
          roleInTeam: memberRole,
        },
      });
      setMemberUid('');
      setMemberNickname('');
      setFeedback('Vínculo de elenco registrado no servidor e equipes do usuário sincronizadas.');
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Erro ao registrar vínculo de elenco no servidor.'
      );
    } finally {
      setSavingMembership(false);
    }
  };

  const handleEndMembership = async (m: TeamMembership) => {
    if (!m.teamId || !m.uid) return;
    setErrorMsg('');
    setFeedback('');
    try {
      await apiFetch(
        `/api/teams/${encodeURIComponent(m.teamId)}/memberships/${encodeURIComponent(m.uid)}/end`,
        {
          method: 'POST',
        }
      );
      setFeedback(`Vínculo de ${m.nickname} encerrado e equipes do usuário sincronizadas.`);
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Erro ao encerrar vínculo de elenco no servidor.'
      );
    }
  };

  const handleCreateInvitation = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg('');
    setFeedback('');
    const formatted = formatPlayerCode(inviteCode);
    if (!firebaseUser || formatted.length < 4) return;
    try {
      const res = await apiFetch<{ id: string; targetCode: string }>('/api/invitations', {
        method: 'POST',
        body: {
          targetCode: formatted,
          assignedRoles: [inviteRole],
          teamId: inviteTeamId || '',
          roleInTeam: inviteTeamId ? inviteTeamRole : 'none',
          expiresHours: 72,
        },
      });
      setInviteCode('');
      setFeedback(
        `Convite único criado no servidor para ${res.targetCode} (ID: ${res.id}, validade 72h). O usuário pode aceitá-lo em /minha-conta.`
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Erro ao emitir convite no servidor.');
    }
  };

  return (
    <div className="space-y-8">
      <div className="border-b border-white/8 pb-4">
        <h1 className="font-display text-3xl font-bold text-white">Organização e Equipes</h1>
        <p className="text-xs text-[#A1A1AA]">
          Gerencie divisões competitivas, titulares/reservas, comissão técnica e convites individuais.
        </p>
      </div>

      {feedback && (
        <div className="p-3 bg-[#15151A] border border-[#DC172B]/50 rounded text-xs text-white">
          {feedback}
        </div>
      )}
      {errorMsg && (
        <div className="p-3 bg-[#DC172B]/15 border border-[#DC172B]/50 rounded text-xs text-white">
          {errorMsg}
        </div>
      )}

      {capabilities.isAnyAdmin && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {canCreateTeams && (
            <form
              onSubmit={handleCreateTeam}
              className="bg-[#15151A] border border-white/8 rounded-lg p-5 space-y-4"
            >
              <h2 className="text-base font-bold text-white flex items-center gap-2">
                <Plus className="w-4 h-4 text-[#EF3340]" /> Nova Equipe / Divisão
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <input
                  type="text"
                  required
                  minLength={2}
                  maxLength={60}
                  value={teamName}
                  onChange={(e) => setTeamName(e.target.value)}
                  placeholder="Nome (ex.: NXF Alpha)"
                  className="bg-[#0D0D10] border border-white/12 rounded px-3 py-2 text-sm text-white"
                />
                <input
                  type="text"
                  required
                  value={teamCategory}
                  onChange={(e) => setTeamCategory(e.target.value)}
                  placeholder="Categoria (ex.: Série A)"
                  className="bg-[#0D0D10] border border-white/12 rounded px-3 py-2 text-sm text-white"
                />
              </div>
              <textarea
                rows={2}
                maxLength={1000}
                value={teamDesc}
                onChange={(e) => setTeamDesc(e.target.value)}
                placeholder="Descrição competitiva da equipe"
                className="w-full bg-[#0D0D10] border border-white/12 rounded px-3 py-2 text-sm text-white"
              />
              <button
                type="submit"
                className="px-4 py-2 bg-[#DC172B] hover:bg-[#EF3340] text-xs font-semibold text-white rounded"
              >
                Cadastrar equipe
              </button>
            </form>
          )}

          <form
            onSubmit={handleCreateInvitation}
            className="bg-[#15151A] border border-white/8 rounded-lg p-5 space-y-4"
          >
            <h2 className="text-base font-bold text-white flex items-center gap-2">
              <MailPlus className="w-4 h-4 text-[#EF3340]" /> Emitir Convite Individual (72h)
            </h2>
            <input
              type="text"
              required
              minLength={3}
              maxLength={24}
              value={inviteCode}
              onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
              placeholder="Code do convidado (ex.: #ABC1234)"
              className="w-full bg-[#0D0D10] border border-white/12 rounded px-3 py-2 text-sm font-mono-tabular uppercase text-white"
            />
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <select
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value as UserRole)}
                className="bg-[#0D0D10] border border-white/12 rounded px-2.5 py-2 text-xs text-white"
              >
                <option value="player">Jogador</option>
                <option value="coach">Técnico</option>
                <option value="manager">Gerente</option>
                {capabilities.isPrimaryAdmin && (
                  <option value="delegated_admin">Admin Delegado</option>
                )}
              </select>
              <select
                value={inviteTeamId}
                onChange={(e) => setInviteTeamId(e.target.value)}
                className="bg-[#0D0D10] border border-white/12 rounded px-2.5 py-2 text-xs text-white"
              >
                <option value="">Sem equipe inicial</option>
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
              <select
                value={inviteTeamRole}
                onChange={(e) => setInviteTeamRole(e.target.value as TeamMembership['roleInTeam'])}
                className="bg-[#0D0D10] border border-white/12 rounded px-2.5 py-2 text-xs text-white"
              >
                <option value="starter">Titular</option>
                <option value="reserve">Reserva</option>
                <option value="coach">Técnico</option>
                <option value="manager">Gerente</option>
              </select>
            </div>
            <button
              type="submit"
              className="px-4 py-2 bg-[#202027] hover:bg-[#2B2B35] border border-white/12 text-xs font-semibold text-white rounded"
            >
              Gerar convite de uso único
            </button>
          </form>
        </div>
      )}

      {capabilities.canManageOrg && manageableTeams.length > 0 && (
        <form
          onSubmit={handleAddMembership}
          className="bg-[#15151A] border border-white/8 rounded-lg p-5 space-y-4"
        >
          <h2 className="text-base font-bold text-white flex items-center gap-2">
            <Users className="w-4 h-4 text-[#EF3340]" /> Vincular Membro ao Elenco
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
            <select
              value={
                memberTeamId && canManageTeamRoster(memberTeamId)
                  ? memberTeamId
                  : manageableTeams[0]?.id || ''
              }
              onChange={(e) => setMemberTeamId(e.target.value)}
              className="bg-[#0D0D10] border border-white/12 rounded px-3 py-2 text-xs text-white"
            >
              {manageableTeams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <input
              type="text"
              required
              value={memberUid}
              onChange={(e) => setMemberUid(e.target.value)}
              placeholder="UID do usuário"
              className="bg-[#0D0D10] border border-white/12 rounded px-3 py-2 text-xs font-mono-tabular text-white"
            />
            <input
              type="text"
              required
              value={memberNickname}
              onChange={(e) => setMemberNickname(e.target.value)}
              placeholder="Nickname no elenco"
              className="bg-[#0D0D10] border border-white/12 rounded px-3 py-2 text-xs text-white"
            />
            <select
              value={memberRole}
              onChange={(e) => setMemberRole(e.target.value as TeamMembership['roleInTeam'])}
              className="bg-[#0D0D10] border border-white/12 rounded px-3 py-2 text-xs text-white"
            >
              <option value="starter">Titular</option>
              <option value="reserve">Reserva</option>
              <option value="coach">Técnico</option>
              <option value="manager">Gerente</option>
              <option value="analyst">Analista</option>
            </select>
          </div>
          <button
            type="submit"
            disabled={savingMembership}
            className="px-4 py-2 bg-[#DC172B] hover:bg-[#EF3340] disabled:opacity-50 text-xs font-semibold text-white rounded"
          >
            {savingMembership ? 'Salvando vínculo...' : 'Salvar vínculo'}
          </button>
        </form>
      )}

      {/* Lista de equipes e elencos ativos */}
      <div className="space-y-4">
        <h2 className="font-display text-2xl font-bold text-white">Equipes e Elencos Ativos</h2>
        {teams.length === 0 ? (
          <EmptyState
            title="Nenhuma equipe cadastrada"
            description="Crie a primeira equipe acima para começar a vincular jogadores e comissão técnica."
          />
        ) : (
          <div className="space-y-4">
            {teams.map((t) => {
              const teamRoster = memberships.filter((m) => m.teamId === t.id);
              return (
                <div
                  key={t.id}
                  className="bg-[#15151A] border border-white/8 rounded-lg p-5 space-y-3"
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-xs text-[#EF3340] font-medium">{t.category}</p>
                      <h3 className="text-lg font-bold text-white">{t.name}</h3>
                    </div>
                    <span className="font-mono-tabular text-xs text-[#A1A1AA]">
                      ID: {t.id}
                    </span>
                  </div>
                  {teamRoster.length === 0 ? (
                    <p className="text-xs text-[#71717A]">Nenhum integrante ativo neste elenco.</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="text-[#71717A] border-b border-white/8">
                            <th className="py-2 text-left">Nickname</th>
                            <th className="py-2 text-left">Função</th>
                            <th className="py-2 text-left">UID</th>
                            <th className="py-2 text-right">Ações</th>
                          </tr>
                        </thead>
                        <tbody>
                          {teamRoster.map((m) => (
                            <tr key={m.id} className="border-b border-white/5 last:border-none">
                              <td className="py-2 font-semibold text-white">{m.nickname}</td>
                              <td className="py-2 text-[#A1A1AA]">{m.roleInTeam}</td>
                              <td className="py-2 font-mono-tabular text-[#71717A]">{m.uid}</td>
                              <td className="py-2 text-right">
                                {canManageTeamRoster(m.teamId) && (
                                  <button
                                    type="button"
                                    onClick={() => void handleEndMembership(m)}
                                    className="text-xs text-[#EF3340] hover:underline"
                                  >
                                    Encerrar vínculo
                                  </button>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {invitations.length > 0 && (
        <div className="space-y-3">
          <h2 className="font-display text-xl font-bold text-white">Convites Emitidos</h2>
          <div className="bg-[#15151A] border border-white/8 rounded-lg overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-[#71717A] border-b border-white/8">
                  <th className="p-3 text-left">Code</th>
                  <th className="p-3 text-left">Cargos</th>
                  <th className="p-3 text-left">Status</th>
                  <th className="p-3 text-right">Validade</th>
                </tr>
              </thead>
              <tbody>
                {invitations.map((inv) => (
                  <tr key={inv.id} className="border-b border-white/5 last:border-none">
                    <td className="p-3 font-mono-tabular text-white">
                      {inv.targetCode || inv.targetEmail}
                    </td>
                    <td className="p-3 text-[#A1A1AA]">{inv.assignedRoles.join(', ')}</td>
                    <td className="p-3 font-medium text-white">{inv.status}</td>
                    <td className="p-3 text-right font-mono-tabular text-[#A1A1AA]">
                      {formatFirestoreDate(inv.expiresAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
