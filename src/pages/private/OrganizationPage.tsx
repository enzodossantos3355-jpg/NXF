import React, { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Eye,
  EyeOff,
  MailPlus,
  Plus,
  Search,
  Settings2,
  ShieldAlert,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import {
  collection,
  doc,
  limit,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { apiFetch } from '../../lib/apiClient';
import { useAuth } from '../../context/AuthContext';
import { formatFirestoreDate, ROLE_LABELS } from '../../lib/permissions';
import { formatTeamRoleLabel } from '../../lib/panelNavigation';
import {
  buildMemberDirectory,
  filterMemberDirectory,
  formatTeamVisibilityLabel,
  isTeamActive,
  resolveTeamVisibility,
  slugifyTeamId,
  type SelectableMember,
} from '../../lib/organizationHelpers';
import { EmptyState, ErrorState, LoadingSkeleton } from '../../components/common/StateViews';
import {
  BLUEPRINT_LIMITS,
  formatPlayerCode,
  type Invitation,
  type PublicProfile,
  type Team,
  type TeamMembership,
  type UserPrivate,
  type UserRole,
} from '../../types/nxf';

type QueryState<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'error'; message: string };

type TeamFilter = 'all' | 'no_roster' | 'public' | 'internal';
type TeamWorkspaceTab = 'roster' | 'settings';

interface TeamRecord extends Team {
  rawHasIdField?: boolean;
  rawHasCreatedAt?: boolean;
}

const INVITATION_STATUS_LABELS: Record<Invitation['status'], string> = {
  pending: 'Pendente',
  accepted: 'Aceito',
  revoked: 'Revogado',
  expired: 'Expirado',
};

function formatFirestoreErrorMessage(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = String((err as { code?: unknown }).code || '');
    if (code === 'permission-denied') {
      return 'Permissão negada pelo Firestore. Verifique seu cargo ou se o documento legado possui os campos obrigatórios.';
    }
    if (code === 'unavailable') {
      return 'Serviço do Firestore temporariamente indisponível. Tente novamente em instantes.';
    }
  }
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

export function OrganizationPage() {
  const { firebaseUser, capabilities } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [reloadKey, setReloadKey] = useState(0);

  // Estados explícitos de leitura (carregando / pronto / erro)
  const [teamsState, setTeamsState] = useState<QueryState<TeamRecord[]>>({ status: 'loading' });
  const [membershipsState, setMembershipsState] = useState<QueryState<TeamMembership[]>>({
    status: 'loading',
  });
  const [invitationsState, setInvitationsState] = useState<QueryState<Invitation[]>>({
    status: 'loading',
  });
  const [usersDirState, setUsersDirState] = useState<QueryState<UserPrivate[]>>({
    status: 'ready',
    data: [],
  });
  const [publicProfilesDirState, setPublicProfilesDirState] = useState<
    QueryState<PublicProfile[]>
  >({
    status: 'ready',
    data: [],
  });

  // Navegação e filtros da lista de equipes
  const [teamSearch, setTeamSearch] = useState('');
  const [teamFilter, setTeamFilter] = useState<TeamFilter>('all');
  const [selectedTeamId, setSelectedTeamId] = useState<string>(
    () => searchParams.get('team') || ''
  );
  const [activeTab, setActiveTab] = useState<TeamWorkspaceTab>('roster');

  // Painéis de ações secundárias no cabeçalho
  const [activeDrawer, setActiveDrawer] = useState<'none' | 'create_team' | 'invite'>('none');

  // Formulário: Nova equipe
  const [newTeamName, setNewTeamName] = useState('');
  const [newTeamCategory, setNewTeamCategory] = useState('Principal');
  const [newTeamDesc, setNewTeamDesc] = useState('');
  const [newTeamIsPublic, setNewTeamIsPublic] = useState(true);
  const [creatingTeam, setCreatingTeam] = useState(false);

  // Formulário: Editar equipe selecionada e visibilidade
  const [editName, setEditName] = useState('');
  const [editCategory, setEditCategory] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editIsPublic, setEditIsPublic] = useState(true);
  const [editActive, setEditActive] = useState(true);
  const [savingTeamEdit, setSavingTeamEdit] = useState(false);

  // Formulário: Vincular membro ao elenco (com seletor pesquisável)
  const [memberSearch, setMemberSearch] = useState('');
  const [selectedMember, setSelectedMember] = useState<SelectableMember | null>(null);
  const [manualUidMode, setManualUidMode] = useState(false);
  const [manualUid, setManualUid] = useState('');
  const [memberNickname, setMemberNickname] = useState('');
  const [memberRole, setMemberRole] = useState<TeamMembership['roleInTeam']>('starter');
  const [savingMembership, setSavingMembership] = useState(false);
  const [confirmEndKey, setConfirmEndKey] = useState<string | null>(null);
  const [endingMembershipKey, setEndingMembershipKey] = useState<string | null>(null);

  // Formulário: Emitir convite individual
  const [inviteCode, setInviteCode] = useState('');
  const [inviteRole, setInviteRole] = useState<UserRole>('player');
  const [inviteTeamId, setInviteTeamId] = useState('');
  const [inviteTeamRole, setInviteTeamRole] =
    useState<TeamMembership['roleInTeam']>('starter');
  const [sendingInvite, setSendingInvite] = useState(false);

  // Feedbacks globais de operação
  const [feedback, setFeedback] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  // Permissões reais alinhadas a firestore.rules e server/rosterService.ts
  const canCreateTeams =
    capabilities.isPrimaryAdmin || capabilities.permissions.includes('teams.manage');

  const canEditAnyTeam =
    capabilities.isPrimaryAdmin || capabilities.permissions.includes('teams.manage');

  const hasGlobalRosterAuthority =
    capabilities.isPrimaryAdmin ||
    capabilities.permissions.includes('teams.manage') ||
    capabilities.permissions.includes('users.manage');

  const canReadUsersDirectory =
    capabilities.isPrimaryAdmin ||
    capabilities.permissions.includes('users.read') ||
    capabilities.permissions.includes('users.manage');

  const canLoadDirectory = hasGlobalRosterAuthority || capabilities.isManager;

  const teams = useMemo(
    () => (teamsState.status === 'ready' ? teamsState.data : []),
    [teamsState]
  );

  const memberships = useMemo(
    () => (membershipsState.status === 'ready' ? membershipsState.data : []),
    [membershipsState]
  );

  const managedTeamIds = useMemo(() => {
    if (!firebaseUser) return new Set<string>();
    return new Set(
      memberships
        .filter(
          (m) =>
            m.uid === firebaseUser.uid &&
            m.status === 'active' &&
            m.roleInTeam === 'manager'
        )
        .map((m) => m.teamId)
    );
  }, [firebaseUser, memberships]);

  const canManageTeamRoster = (teamId: string) =>
    hasGlobalRosterAuthority || (capabilities.isManager && managedTeamIds.has(teamId));

  const canEditTeam = (teamId: string) =>
    canEditAnyTeam || (capabilities.isManager && managedTeamIds.has(teamId));

  // Assinaturas principais: teams, teamMemberships ativos e invitations (se admin)
  useEffect(() => {
    if (!firebaseUser) return;
    const unsubs: Array<() => void> = [];

    setTeamsState({ status: 'loading' });
    setMembershipsState({ status: 'loading' });

    unsubs.push(
      onSnapshot(
        collection(db, 'teams'),
        (snap) => {
          const list: TeamRecord[] = snap.docs
            .map((d) => {
              const raw = d.data() as Record<string, unknown>;
              return {
                ...(raw as Omit<Team, 'id'>),
                id: d.id,
                name: typeof raw.name === 'string' && raw.name.trim() ? raw.name : d.id,
                category: typeof raw.category === 'string' ? raw.category : '',
                rawHasIdField: typeof raw.id === 'string' && raw.id === d.id,
                rawHasCreatedAt: Boolean(raw.createdAt),
              };
            })
            .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' }));
          setTeamsState({ status: 'ready', data: list });
        },
        (err) => {
          setTeamsState({
            status: 'error',
            message: formatFirestoreErrorMessage(
              err,
              'Não foi possível carregar a lista de equipes.'
            ),
          });
        }
      )
    );

    unsubs.push(
      onSnapshot(
        query(collection(db, 'teamMemberships'), where('status', '==', 'active')),
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
            message: formatFirestoreErrorMessage(
              err,
              'Não foi possível carregar os vínculos de elenco ativos.'
            ),
          });
        }
      )
    );

    if (capabilities.isAnyAdmin) {
      setInvitationsState({ status: 'loading' });
      unsubs.push(
        onSnapshot(
          collection(db, 'invitations'),
          (snap) => {
            const list = snap.docs.map((d) => ({
              id: d.id,
              ...(d.data() as Invitation),
            }));
            setInvitationsState({ status: 'ready', data: list });
          },
          (err) => {
            setInvitationsState({
              status: 'error',
              message: formatFirestoreErrorMessage(
                err,
                'Não foi possível carregar os convites emitidos.'
              ),
            });
          }
        )
      );
    } else {
      setInvitationsState({ status: 'ready', data: [] });
    }

    return () => {
      unsubs.forEach((fn) => fn());
    };
  }, [capabilities.isAnyAdmin, firebaseUser, reloadKey]);

  // Assinaturas de diretório de membros estritamente dentro do escopo autorizado nas regras
  useEffect(() => {
    if (!firebaseUser || !canLoadDirectory) {
      setUsersDirState({ status: 'ready', data: [] });
      setPublicProfilesDirState({ status: 'ready', data: [] });
      return;
    }

    const unsubs: Array<() => void> = [];

    if (canReadUsersDirectory) {
      setUsersDirState({ status: 'loading' });
      unsubs.push(
        onSnapshot(
          query(collection(db, 'users'), limit(200)),
          (snap) => {
            const list = snap.docs.map((d) => ({
              uid: d.id,
              ...(d.data() as Omit<UserPrivate, 'uid'>),
            }));
            setUsersDirState({ status: 'ready', data: list });
          },
          (err) => {
            setUsersDirState({
              status: 'error',
              message: formatFirestoreErrorMessage(
                err,
                'Não foi possível carregar o diretório de contas.'
              ),
            });
          }
        )
      );
    } else {
      setUsersDirState({ status: 'ready', data: [] });
    }

    setPublicProfilesDirState({ status: 'loading' });
    const profilesQuery = capabilities.isAnyAdmin
      ? query(collection(db, 'publicProfiles'), limit(200))
      : query(
          collection(db, 'publicProfiles'),
          where('isActiveMember', '==', true),
          where('moderationStatus', '==', 'approved'),
          limit(200)
        );

    unsubs.push(
      onSnapshot(
        profilesQuery,
        (snap) => {
          const list = snap.docs.map((d) => ({
            uid: d.id,
            ...(d.data() as Omit<PublicProfile, 'uid'>),
          }));
          setPublicProfilesDirState({ status: 'ready', data: list });
        },
        (err) => {
          setPublicProfilesDirState({
            status: 'error',
            message: formatFirestoreErrorMessage(
              err,
              'Não foi possível carregar perfis públicos para seleção.'
            ),
          });
        }
      )
    );

    return () => {
      unsubs.forEach((fn) => fn());
    };
  }, [capabilities.isAnyAdmin, canLoadDirectory, canReadUsersDirectory, firebaseUser, reloadKey]);

  // Sincronização de ?team=<id> na URL com equipe selecionada
  useEffect(() => {
    const paramTeam = searchParams.get('team');
    if (paramTeam && teams.some((t) => t.id === paramTeam)) {
      setSelectedTeamId(paramTeam);
      return;
    }
    if (teams.length > 0 && (!selectedTeamId || !teams.some((t) => t.id === selectedTeamId))) {
      setSelectedTeamId(teams[0].id);
    }
  }, [searchParams, selectedTeamId, teams]);

  const selectedTeam = useMemo(
    () => teams.find((t) => t.id === selectedTeamId) || null,
    [selectedTeamId, teams]
  );

  // Sincroniza formulário de edição e aba ativa ao trocar equipe selecionada
  useEffect(() => {
    if (!selectedTeam) return;
    setEditName(selectedTeam.name || '');
    setEditCategory(selectedTeam.category || '');
    setEditDesc(selectedTeam.description || '');
    setEditIsPublic(selectedTeam.isPublic !== false);
    setEditActive(isTeamActive(selectedTeam));
    setConfirmEndKey(null);
    if (!canEditTeam(selectedTeam.id)) {
      setActiveTab('roster');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTeam?.id, selectedTeam?.name, selectedTeam?.category, selectedTeam?.description, selectedTeam?.isPublic, selectedTeam?.active]);

  // Contagens por equipe somente quando membershipsState === 'ready'
  const rosterCountByTeam = useMemo(() => {
    const counts = new Map<string, number>();
    if (membershipsState.status !== 'ready') return counts;
    for (const m of membershipsState.data) {
      counts.set(m.teamId, (counts.get(m.teamId) || 0) + 1);
    }
    return counts;
  }, [membershipsState]);

  const filteredTeams = useMemo(() => {
    const q = teamSearch.trim().toLowerCase();
    return teams.filter((t) => {
      if (q) {
        const matchesName = (t.name || '').toLowerCase().includes(q);
        const matchesCategory = (t.category || '').toLowerCase().includes(q);
        const matchesId = t.id.toLowerCase().includes(q);
        if (!matchesName && !matchesCategory && !matchesId) return false;
      }
      if (teamFilter === 'no_roster') {
        if (membershipsState.status !== 'ready') return false;
        return (rosterCountByTeam.get(t.id) || 0) === 0;
      }
      if (teamFilter === 'public') return resolveTeamVisibility(t) === 'public';
      if (teamFilter === 'internal') return resolveTeamVisibility(t) === 'internal';
      return true;
    });
  }, [membershipsState.status, rosterCountByTeam, teamFilter, teamSearch, teams]);

  const teamsWithoutRosterCount = useMemo(() => {
    if (teamsState.status !== 'ready' || membershipsState.status !== 'ready') return null;
    return teams.filter((t) => (rosterCountByTeam.get(t.id) || 0) === 0).length;
  }, [membershipsState.status, rosterCountByTeam, teams, teamsState.status]);

  const publicTeamsCount = useMemo(
    () => teams.filter((t) => resolveTeamVisibility(t) === 'public').length,
    [teams]
  );

  const internalTeamsCount = useMemo(
    () => teams.filter((t) => resolveTeamVisibility(t) === 'internal').length,
    [teams]
  );

  const selectedTeamRoster = useMemo(() => {
    if (!selectedTeam || membershipsState.status !== 'ready') return [];
    return membershipsState.data
      .filter((m) => m.teamId === selectedTeam.id)
      .sort((a, b) => a.nickname.localeCompare(b.nickname, 'pt-BR', { sensitivity: 'base' }));
  }, [membershipsState, selectedTeam]);

  const selectedTeamRosterUidSet = useMemo(
    () => new Set(selectedTeamRoster.map((m) => m.uid)),
    [selectedTeamRoster]
  );

  // Diretório pesquisável de membros (unifica apenas fontes autorizadas)
  const memberDirectory = useMemo(
    () =>
      buildMemberDirectory({
        users: usersDirState.status === 'ready' ? usersDirState.data : [],
        publicProfiles:
          publicProfilesDirState.status === 'ready' ? publicProfilesDirState.data : [],
        memberships: membershipsState.status === 'ready' ? membershipsState.data : [],
      }),
    [membershipsState, publicProfilesDirState, usersDirState]
  );

  const directoryByUid = useMemo(() => {
    const map = new Map<string, SelectableMember>();
    for (const item of memberDirectory) map.set(item.uid, item);
    return map;
  }, [memberDirectory]);

  const filteredDirectory = useMemo(
    () => filterMemberDirectory(memberDirectory, memberSearch).slice(0, 8),
    [memberDirectory, memberSearch]
  );

  const directoryLoading =
    usersDirState.status === 'loading' || publicProfilesDirState.status === 'loading';

  const directoryError =
    usersDirState.status === 'error'
      ? usersDirState.message
      : publicProfilesDirState.status === 'error'
        ? publicProfilesDirState.message
        : null;

  const teamNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const t of teams) map.set(t.id, t.name || t.id);
    return map;
  }, [teams]);

  const handleSelectTeam = (teamId: string) => {
    setSelectedTeamId(teamId);
    setConfirmEndKey(null);
    const next = new URLSearchParams(searchParams);
    next.set('team', teamId);
    setSearchParams(next, { replace: true });
  };

  const handlePickMember = (member: SelectableMember) => {
    setSelectedMember(member);
    setManualUidMode(false);
    setManualUid('');
    setMemberNickname(member.displayName.slice(0, BLUEPRINT_LIMITS.NICKNAME_MAX));
    setMemberSearch('');
  };

  const handleCreateTeam = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firebaseUser || !canCreateTeams) return;
    setErrorMsg('');
    setFeedback('');

    const cleanName = newTeamName.trim().slice(0, BLUEPRINT_LIMITS.TEAM_NAME_MAX);
    const cleanCategory = newTeamCategory.trim().slice(0, 40);
    const cleanDesc = newTeamDesc.trim().slice(0, BLUEPRINT_LIMITS.TEAM_DESC_MAX);
    const slugId = slugifyTeamId(cleanName);

    if (cleanName.length < 2) {
      setErrorMsg('Informe um nome com pelo menos 2 caracteres.');
      return;
    }
    if (cleanCategory.length < 2) {
      setErrorMsg('Informe uma categoria com pelo menos 2 caracteres.');
      return;
    }
    if (slugId.length < 2) {
      setErrorMsg('O nome da equipe precisa gerar um identificador alfanumérico válido.');
      return;
    }
    if (teams.some((t) => t.id === slugId)) {
      setErrorMsg(`Já existe uma equipe com o identificador "${slugId}". Escolha outro nome.`);
      return;
    }

    setCreatingTeam(true);
    try {
      await setDoc(doc(db, 'teams', slugId), {
        id: slugId,
        name: cleanName,
        category: cleanCategory,
        description: cleanDesc,
        isPublic: newTeamIsPublic,
        active: true,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      setNewTeamName('');
      setNewTeamCategory('Principal');
      setNewTeamDesc('');
      setNewTeamIsPublic(true);
      setActiveDrawer('none');
      handleSelectTeam(slugId);
      setFeedback(`Equipe "${cleanName}" criada com sucesso (ID: ${slugId}).`);
    } catch (err) {
      setErrorMsg(
        formatFirestoreErrorMessage(err, 'Não foi possível criar a equipe no Firestore.')
      );
    } finally {
      setCreatingTeam(false);
    }
  };

  const handleUpdateTeam = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedTeam || !canEditTeam(selectedTeam.id)) return;
    setErrorMsg('');
    setFeedback('');

    const cleanName = editName.trim().slice(0, BLUEPRINT_LIMITS.TEAM_NAME_MAX);
    const cleanCategory = editCategory.trim().slice(0, 40);
    const cleanDesc = editDesc.trim().slice(0, BLUEPRINT_LIMITS.TEAM_DESC_MAX);

    if (cleanName.length < 2) {
      setErrorMsg('O nome da equipe deve ter pelo menos 2 caracteres.');
      return;
    }
    if (cleanCategory.length < 2) {
      setErrorMsg('A categoria da equipe deve ter pelo menos 2 caracteres.');
      return;
    }

    setSavingTeamEdit(true);
    try {
      await updateDoc(doc(db, 'teams', selectedTeam.id), {
        name: cleanName,
        category: cleanCategory,
        description: cleanDesc,
        isPublic: editIsPublic,
        active: editActive,
        updatedAt: serverTimestamp(),
      });
      setFeedback(`Alterações da equipe "${cleanName}" salvas com sucesso.`);
    } catch (err) {
      setErrorMsg(
        formatFirestoreErrorMessage(
          err,
          'Não foi possível salvar as alterações da equipe.'
        )
      );
    } finally {
      setSavingTeamEdit(false);
    }
  };

  const handleAddMembership = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedTeam || !canManageTeamRoster(selectedTeam.id)) return;
    setErrorMsg('');
    setFeedback('');

    const resolvedUid = manualUidMode ? manualUid.trim() : selectedMember?.uid || '';
    const cleanNickname = memberNickname.trim().slice(0, BLUEPRINT_LIMITS.NICKNAME_MAX);

    if (!resolvedUid) {
      setErrorMsg('Selecione um integrante na lista ou informe um UID válido.');
      return;
    }
    if (cleanNickname.length < 2) {
      setErrorMsg('Informe o nickname do integrante no elenco (mínimo 2 caracteres).');
      return;
    }

    setSavingMembership(true);
    try {
      await apiFetch(`/api/teams/${encodeURIComponent(selectedTeam.id)}/memberships`, {
        method: 'POST',
        body: {
          uid: resolvedUid,
          nickname: cleanNickname,
          roleInTeam: memberRole,
        },
      });
      setSelectedMember(null);
      setManualUid('');
      setManualUidMode(false);
      setMemberNickname('');
      setMemberSearch('');
      setFeedback(
        `Vínculo de "${cleanNickname}" (${formatTeamRoleLabel(memberRole)}) salvo na equipe ${selectedTeam.name}.`
      );
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : 'Não foi possível salvar o vínculo de elenco no servidor.'
      );
    } finally {
      setSavingMembership(false);
    }
  };

  const handleEndMembership = async (m: TeamMembership) => {
    if (!m.teamId || !m.uid || !canManageTeamRoster(m.teamId)) return;
    const key = m.id || `${m.teamId}_${m.uid}`;
    setErrorMsg('');
    setFeedback('');
    setEndingMembershipKey(key);
    try {
      await apiFetch(
        `/api/teams/${encodeURIComponent(m.teamId)}/memberships/${encodeURIComponent(m.uid)}/end`,
        {
          method: 'POST',
        }
      );
      setConfirmEndKey(null);
      setFeedback(`Vínculo de ${m.nickname} encerrado e equipes do usuário sincronizadas.`);
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : 'Não foi possível encerrar o vínculo de elenco no servidor.'
      );
    } finally {
      setEndingMembershipKey(null);
    }
  };

  const handleCreateInvitation = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firebaseUser || !capabilities.isAnyAdmin) return;
    setErrorMsg('');
    setFeedback('');

    const formatted = formatPlayerCode(inviteCode);
    if (formatted.length < 4) {
      setErrorMsg('Informe um código válido do convidado (ex.: #ABC1234).');
      return;
    }

    setSendingInvite(true);
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
      setActiveDrawer('none');
      setFeedback(
        `Convite único criado para ${res.targetCode} (ID: ${res.id}, validade 72h). O usuário pode aceitá-lo em /minha-conta.`
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Erro ao emitir convite no servidor.');
    } finally {
      setSendingInvite(false);
    }
  };

  const openInviteDrawer = () => {
    setInviteTeamId(selectedTeam?.id || '');
    setActiveDrawer((prev) => (prev === 'invite' ? 'none' : 'invite'));
  };

  const openCreateTeamDrawer = () => {
    setActiveDrawer((prev) => (prev === 'create_team' ? 'none' : 'create_team'));
  };

  const selectedTeamHasLegacyGap = Boolean(
    selectedTeam && (!selectedTeam.rawHasCreatedAt || !selectedTeam.rawHasIdField)
  );

  return (
    <div className="space-y-6">
      {/* Cabeçalho principal com ações secundárias claras */}
      <header className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 border-b border-white/8 pb-5">
        <div className="space-y-1">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#71717A]">
            Operação
          </p>
          <h1 className="font-display text-2xl sm:text-3xl font-bold text-white tracking-tight">
            Equipes e Elencos
          </h1>
          <p className="text-sm text-[#A1A1AA] max-w-2xl">
            Consulte as equipes cadastradas, acompanhe os elencos ativos e gerencie vínculos,
            visibilidade e convites conforme suas permissões.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {capabilities.isAnyAdmin && (
            <button
              type="button"
              onClick={openInviteDrawer}
              className={`inline-flex items-center gap-2 px-4 min-h-[44px] sm:min-h-[40px] rounded-md text-xs font-semibold transition-colors border ${
                activeDrawer === 'invite'
                  ? 'bg-[#202027] border-white/25 text-white'
                  : 'bg-[#15151A] hover:bg-[#202027] border-white/12 text-[#E4E4E7]'
              }`}
            >
              <MailPlus className="w-4 h-4 text-[#EF3340]" />
              Emitir convite
            </button>
          )}
          {canCreateTeams && (
            <button
              type="button"
              onClick={openCreateTeamDrawer}
              className="inline-flex items-center gap-2 px-4 min-h-[44px] sm:min-h-[40px] rounded-md text-xs font-semibold bg-[#DC172B] hover:bg-[#EF3340] text-white transition-colors"
            >
              <Plus className="w-4 h-4" />
              Nova equipe
            </button>
          )}
        </div>
      </header>

      {/* Alertas de confirmação / erro */}
      {feedback && (
        <div
          role="status"
          className="flex items-start justify-between gap-3 p-3.5 bg-[#15151A] border border-emerald-500/40 rounded-lg text-sm text-white"
        >
          <div className="flex items-start gap-2.5">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
            <span>{feedback}</span>
          </div>
          <button
            type="button"
            onClick={() => setFeedback('')}
            aria-label="Fechar aviso"
            className="text-[#A1A1AA] hover:text-white p-1"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {errorMsg && (
        <div
          role="alert"
          className="flex items-start justify-between gap-3 p-3.5 bg-[#DC172B]/12 border border-[#DC172B]/50 rounded-lg text-sm text-white"
        >
          <div className="flex items-start gap-2.5">
            <AlertCircle className="w-4 h-4 text-[#EF3340] shrink-0 mt-0.5" />
            <span>{errorMsg}</span>
          </div>
          <button
            type="button"
            onClick={() => setErrorMsg('')}
            aria-label="Fechar erro"
            className="text-[#A1A1AA] hover:text-white p-1"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Painel recolhível: Nova equipe */}
      {activeDrawer === 'create_team' && canCreateTeams && (
        <section className="bg-[#15151A] border border-white/12 rounded-lg p-5 space-y-4">
          <div className="flex items-center justify-between gap-3 border-b border-white/8 pb-3">
            <div>
              <h2 className="text-base font-bold text-white">Nova equipe</h2>
              <p className="text-xs text-[#A1A1AA]">
                Cadastre uma nova divisão competitiva. O identificador será gerado a partir do
                nome.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setActiveDrawer('none')}
              aria-label="Fechar formulário de nova equipe"
              className="min-w-[40px] min-h-[40px] inline-flex items-center justify-center rounded-md text-[#A1A1AA] hover:text-white hover:bg-white/5"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <form onSubmit={handleCreateTeam} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-[#E4E4E7]">Nome da equipe</span>
                <input
                  type="text"
                  required
                  minLength={2}
                  maxLength={BLUEPRINT_LIMITS.TEAM_NAME_MAX}
                  value={newTeamName}
                  onChange={(e) => setNewTeamName(e.target.value)}
                  placeholder="Ex.: NXF Alpha"
                  className="w-full min-h-[42px] bg-[#0D0D10] border border-white/12 focus:border-[#DC172B] focus:outline-none rounded-md px-3 text-sm text-white placeholder:text-[#71717A]"
                />
                {newTeamName.trim() && (
                  <span className="block text-[11px] text-[#71717A] font-mono-tabular">
                    ID gerado: {slugifyTeamId(newTeamName) || '—'}
                  </span>
                )}
              </label>

              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-[#E4E4E7]">Categoria</span>
                <input
                  type="text"
                  required
                  minLength={2}
                  maxLength={40}
                  value={newTeamCategory}
                  onChange={(e) => setNewTeamCategory(e.target.value)}
                  placeholder="Ex.: Principal, Academy, Série A"
                  className="w-full min-h-[42px] bg-[#0D0D10] border border-white/12 focus:border-[#DC172B] focus:outline-none rounded-md px-3 text-sm text-white placeholder:text-[#71717A]"
                />
              </label>
            </div>

            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-[#E4E4E7]">
                Descrição competitiva (opcional)
              </span>
              <textarea
                rows={2}
                maxLength={BLUEPRINT_LIMITS.TEAM_DESC_MAX}
                value={newTeamDesc}
                onChange={(e) => setNewTeamDesc(e.target.value)}
                placeholder="Resumo do objetivo competitivo, liga ou divisão da equipe."
                className="w-full bg-[#0D0D10] border border-white/12 focus:border-[#DC172B] focus:outline-none rounded-md px-3 py-2 text-sm text-white placeholder:text-[#71717A]"
              />
            </label>

            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pt-1">
              <label className="inline-flex items-center gap-2.5 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={newTeamIsPublic}
                  onChange={(e) => setNewTeamIsPublic(e.target.checked)}
                  className="w-4 h-4 accent-[#DC172B] rounded"
                />
                <span className="text-xs text-[#E4E4E7]">
                  Exibir esta equipe no portal público da NXF
                </span>
              </label>

              <div className="flex items-center gap-2.5">
                <button
                  type="button"
                  onClick={() => setActiveDrawer('none')}
                  className="px-4 min-h-[42px] rounded-md text-xs font-medium text-[#A1A1AA] hover:text-white bg-[#202027] hover:bg-[#2B2B35]"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={creatingTeam}
                  className="px-4 min-h-[42px] rounded-md text-xs font-semibold text-white bg-[#DC172B] hover:bg-[#EF3340] disabled:opacity-50"
                >
                  {creatingTeam ? 'Cadastrando...' : 'Cadastrar equipe'}
                </button>
              </div>
            </div>
          </form>
        </section>
      )}

      {/* Painel recolhível: Emitir convite individual */}
      {activeDrawer === 'invite' && capabilities.isAnyAdmin && (
        <section className="bg-[#15151A] border border-white/12 rounded-lg p-5 space-y-4">
          <div className="flex items-center justify-between gap-3 border-b border-white/8 pb-3">
            <div>
              <h2 className="text-base font-bold text-white">Emitir convite individual (72h)</h2>
              <p className="text-xs text-[#A1A1AA]">
                Gera um convite de uso único vinculado ao código NXF do membro. O aceite é feito
                em <span className="font-mono-tabular text-[#E4E4E7]">/minha-conta</span>.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setActiveDrawer('none')}
              aria-label="Fechar formulário de convite"
              className="min-w-[40px] min-h-[40px] inline-flex items-center justify-center rounded-md text-[#A1A1AA] hover:text-white hover:bg-white/5"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <form onSubmit={handleCreateInvitation} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-[#E4E4E7]">Código do convidado</span>
                <input
                  type="text"
                  required
                  minLength={3}
                  maxLength={24}
                  value={inviteCode}
                  onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
                  placeholder="#ABC1234"
                  className="w-full min-h-[42px] bg-[#0D0D10] border border-white/12 focus:border-[#DC172B] focus:outline-none rounded-md px-3 text-sm font-mono-tabular uppercase text-white placeholder:text-[#71717A]"
                />
              </label>

              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-[#E4E4E7]">Cargo atribuído</span>
                <select
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value as UserRole)}
                  className="w-full min-h-[42px] bg-[#0D0D10] border border-white/12 focus:border-[#DC172B] focus:outline-none rounded-md px-3 text-sm text-white"
                >
                  <option value="player">Jogador</option>
                  <option value="coach">Técnico</option>
                  <option value="manager">Gerente</option>
                  {capabilities.isPrimaryAdmin && (
                    <option value="delegated_admin">Admin Delegado</option>
                  )}
                </select>
              </label>

              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-[#E4E4E7]">Equipe inicial</span>
                <select
                  value={inviteTeamId}
                  onChange={(e) => setInviteTeamId(e.target.value)}
                  className="w-full min-h-[42px] bg-[#0D0D10] border border-white/12 focus:border-[#DC172B] focus:outline-none rounded-md px-3 text-sm text-white"
                >
                  <option value="">Sem equipe inicial</option>
                  {teams.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-[#E4E4E7]">Função na equipe</span>
                <select
                  value={inviteTeamRole}
                  disabled={!inviteTeamId}
                  onChange={(e) =>
                    setInviteTeamRole(e.target.value as TeamMembership['roleInTeam'])
                  }
                  className="w-full min-h-[42px] bg-[#0D0D10] border border-white/12 disabled:opacity-50 focus:border-[#DC172B] focus:outline-none rounded-md px-3 text-sm text-white"
                >
                  <option value="starter">Titular</option>
                  <option value="reserve">Reserva</option>
                  <option value="coach">Técnico</option>
                  <option value="manager">Gerente</option>
                  <option value="analyst">Analista</option>
                </select>
              </label>
            </div>

            <div className="flex items-center justify-end gap-2.5">
              <button
                type="button"
                onClick={() => setActiveDrawer('none')}
                className="px-4 min-h-[42px] rounded-md text-xs font-medium text-[#A1A1AA] hover:text-white bg-[#202027] hover:bg-[#2B2B35]"
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={sendingInvite}
                className="px-4 min-h-[42px] rounded-md text-xs font-semibold text-white bg-[#DC172B] hover:bg-[#EF3340] disabled:opacity-50"
              >
                {sendingInvite ? 'Gerando convite...' : 'Gerar convite de uso único'}
              </button>
            </div>
          </form>
        </section>
      )}

      {/* Bloco principal: Equipes existentes primeiro (Master-Detail) */}
      {teamsState.status === 'loading' ? (
        <LoadingSkeleton rows={4} />
      ) : teamsState.status === 'error' ? (
        <ErrorState
          title="Erro ao carregar equipes"
          description={teamsState.message}
          onRetry={() => setReloadKey((k) => k + 1)}
        />
      ) : teams.length === 0 ? (
        <EmptyState
          title="Nenhuma equipe cadastrada"
          description="Ainda não existem divisões competitivas registradas. Cadastre a primeira equipe para começar a organizar os elencos."
          action={
            canCreateTeams ? (
              <button
                type="button"
                onClick={() => setActiveDrawer('create_team')}
                className="inline-flex items-center gap-2 px-4 min-h-[42px] bg-[#DC172B] hover:bg-[#EF3340] text-xs font-semibold text-white rounded-md"
              >
                <Plus className="w-4 h-4" />
                Nova equipe
              </button>
            ) : undefined
          }
        />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Coluna esquerda: Lista de equipes existentes */}
          <section className="lg:col-span-5 bg-[#15151A] border border-white/8 rounded-lg overflow-hidden">
            <div className="p-4 border-b border-white/8 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-white">
                  Equipes cadastradas
                </h2>
                <span className="text-xs font-mono-tabular text-[#A1A1AA]">
                  {filteredTeams.length} de {teams.length}
                </span>
              </div>

              <div className="relative">
                <Search className="w-4 h-4 text-[#71717A] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="search"
                  value={teamSearch}
                  onChange={(e) => setTeamSearch(e.target.value)}
                  placeholder="Filtrar por nome, categoria ou ID..."
                  className="w-full min-h-[40px] bg-[#0D0D10] border border-white/10 focus:border-[#DC172B] focus:outline-none rounded-md pl-9 pr-3 text-xs text-white placeholder:text-[#71717A]"
                />
              </div>

              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filtros de equipes">
                {(
                  [
                    { id: 'all', label: `Todas (${teams.length})` },
                    {
                      id: 'no_roster',
                      label:
                        teamsWithoutRosterCount === null
                          ? 'Sem elenco'
                          : `Sem elenco (${teamsWithoutRosterCount})`,
                    },
                    { id: 'public', label: `Públicas (${publicTeamsCount})` },
                    { id: 'internal', label: `Internas (${internalTeamsCount})` },
                  ] as const
                ).map((btn) => {
                  const active = teamFilter === btn.id;
                  return (
                    <button
                      key={btn.id}
                      type="button"
                      onClick={() => setTeamFilter(btn.id)}
                      className={`px-2.5 min-h-[34px] rounded text-xs font-medium transition-colors font-mono-tabular ${
                        active
                          ? 'bg-[#DC172B] text-white'
                          : 'bg-[#0D0D10] text-[#A1A1AA] hover:text-white border border-white/8'
                      }`}
                    >
                      {btn.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {filteredTeams.length === 0 ? (
              <div className="p-6 text-center space-y-2">
                <p className="text-sm font-medium text-white">Nenhuma equipe encontrada</p>
                <p className="text-xs text-[#A1A1AA]">
                  Ajuste a busca ou limpe o filtro selecionado para ver todas as equipes.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setTeamSearch('');
                    setTeamFilter('all');
                  }}
                  className="mt-2 px-3 py-1.5 rounded bg-[#202027] hover:bg-[#2B2B35] text-xs text-white"
                >
                  Limpar filtros
                </button>
              </div>
            ) : (
              <ul className="divide-y divide-white/6 max-h-[560px] overflow-y-auto">
                {filteredTeams.map((team) => {
                  const isSelected = selectedTeam?.id === team.id;
                  const countReady = membershipsState.status === 'ready';
                  const memberCount = countReady ? rosterCountByTeam.get(team.id) || 0 : null;
                  const active = isTeamActive(team);
                  const visibilityState = resolveTeamVisibility(team);

                  return (
                    <li key={team.id}>
                      <button
                        type="button"
                        onClick={() => handleSelectTeam(team.id)}
                        aria-current={isSelected ? 'true' : undefined}
                        className={`w-full text-left p-4 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-[#DC172B] ${
                          isSelected
                            ? 'bg-[#202027]'
                            : 'hover:bg-white/[0.03]'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 space-y-0.5">
                            <div className="flex items-center gap-2">
                              <span
                                className={`text-sm font-semibold truncate ${
                                  isSelected ? 'text-white' : 'text-[#F4F4F5]'
                                }`}
                              >
                                {team.name}
                              </span>
                              {!active && (
                                <span className="text-[11px] font-medium text-[#A1A1AA]">
                                  (Inativa)
                                </span>
                              )}
                            </div>
                            <p className="text-xs text-[#A1A1AA] truncate">
                              {team.category || 'Sem categoria'}
                            </p>
                          </div>

                          <div className="text-right shrink-0">
                            <p
                              className={`text-sm font-semibold font-mono-tabular ${
                                memberCount === 0 ? 'text-amber-400' : 'text-white'
                              }`}
                            >
                              {memberCount === null ? '—' : memberCount}
                            </p>
                            <p className="text-[11px] text-[#71717A]">
                              {memberCount === 1 ? 'integrante' : 'integrantes'}
                            </p>
                          </div>
                        </div>

                        <div className="mt-2.5 flex items-center justify-between gap-2 text-[11px]">
                          <span className="inline-flex items-center gap-1.5 text-[#A1A1AA]">
                            {visibilityState === 'public' ? (
                              <Eye className="w-3.5 h-3.5 text-emerald-400" />
                            ) : visibilityState === 'internal' ? (
                              <EyeOff className="w-3.5 h-3.5 text-[#71717A]" />
                            ) : (
                              <AlertCircle className="w-3.5 h-3.5 text-amber-400" />
                            )}
                            {formatTeamVisibilityLabel(team)}
                          </span>

                          {memberCount === 0 ? (
                            <span className="font-medium text-amber-400">Sem elenco ativo</span>
                          ) : isSelected ? (
                            <span className="font-medium text-[#EF3340]">Selecionada</span>
                          ) : null}
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* Coluna direita: Espaço de trabalho da equipe selecionada */}
          <section className="lg:col-span-7 bg-[#15151A] border border-white/8 rounded-lg overflow-hidden">
            {!selectedTeam ? (
              <div className="p-8 text-center text-sm text-[#A1A1AA]">
                Selecione uma equipe na lista ao lado para visualizar o elenco e as opções
                disponíveis.
              </div>
            ) : (
              <>
                {/* Cabeçalho da equipe selecionada */}
                <div className="p-5 border-b border-white/8 space-y-4">
                  <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
                    <div className="space-y-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                        <span className="font-medium text-[#EF3340]">
                          {selectedTeam.category || 'Sem categoria'}
                        </span>
                        <span className="text-[#52525B]">/</span>
                        <span className="font-mono-tabular text-[#A1A1AA]">
                          ID: {selectedTeam.id}
                        </span>
                      </div>
                      <h2 className="font-display text-2xl font-bold text-white break-words">
                        {selectedTeam.name}
                      </h2>
                      {selectedTeam.description && (
                        <p className="text-sm text-[#A1A1AA] leading-relaxed">
                          {selectedTeam.description}
                        </p>
                      )}
                    </div>

                    <div className="flex flex-row sm:flex-col items-center sm:items-end justify-between sm:justify-start gap-1 shrink-0 text-xs">
                      <span className="text-[#E4E4E7] font-medium">
                        {formatTeamVisibilityLabel(selectedTeam)}
                      </span>
                      <span
                        className={
                          isTeamActive(selectedTeam) ? 'text-emerald-400' : 'text-[#A1A1AA]'
                        }
                      >
                        {isTeamActive(selectedTeam) ? 'Equipe ativa' : 'Equipe inativa'}
                      </span>
                    </div>
                  </div>

                  {/* Abas do espaço da equipe */}
                  <div className="flex items-center gap-1 border-t border-white/6 pt-3">
                    <button
                      type="button"
                      onClick={() => setActiveTab('roster')}
                      className={`inline-flex items-center gap-2 px-3.5 min-h-[40px] rounded-md text-xs font-semibold transition-colors ${
                        activeTab === 'roster'
                          ? 'bg-[#202027] text-white'
                          : 'text-[#A1A1AA] hover:text-white hover:bg-white/[0.04]'
                      }`}
                    >
                      <Users className="w-4 h-4 text-[#EF3340]" />
                      Elenco
                      <span className="font-mono-tabular text-[#A1A1AA]">
                        (
                        {membershipsState.status === 'ready'
                          ? selectedTeamRoster.length
                          : '—'}
                        )
                      </span>
                    </button>

                    {canEditTeam(selectedTeam.id) && (
                      <button
                        type="button"
                        onClick={() => setActiveTab('settings')}
                        className={`inline-flex items-center gap-2 px-3.5 min-h-[40px] rounded-md text-xs font-semibold transition-colors ${
                          activeTab === 'settings'
                            ? 'bg-[#202027] text-white'
                            : 'text-[#A1A1AA] hover:text-white hover:bg-white/[0.04]'
                        }`}
                      >
                        <Settings2 className="w-4 h-4 text-[#EF3340]" />
                        Editar e visibilidade
                      </button>
                    )}
                  </div>
                </div>

                {/* Conteúdo da aba ELENCO */}
                {activeTab === 'roster' && (
                  <div className="p-5 space-y-6">
                    {/* Lista de integrantes ativos */}
                    <div className="space-y-3">
                      <div className="flex items-center justify-between gap-2">
                        <h3 className="text-sm font-semibold text-white">Integrantes ativos</h3>
                        {!canManageTeamRoster(selectedTeam.id) && (
                          <span className="text-xs text-[#71717A]">Somente leitura</span>
                        )}
                      </div>

                      {membershipsState.status === 'loading' ? (
                        <LoadingSkeleton rows={3} />
                      ) : membershipsState.status === 'error' ? (
                        <ErrorState
                          title="Erro ao carregar elenco"
                          description={membershipsState.message}
                          onRetry={() => setReloadKey((k) => k + 1)}
                        />
                      ) : selectedTeamRoster.length === 0 ? (
                        <div className="bg-[#0D0D10] border border-white/8 rounded-md p-5 text-center space-y-1">
                          <p className="text-sm font-medium text-white">
                            Nenhum integrante ativo neste elenco
                          </p>
                          <p className="text-xs text-[#A1A1AA]">
                            {canManageTeamRoster(selectedTeam.id)
                              ? 'Use o formulário abaixo para vincular titulares, reservas ou comissão técnica.'
                              : 'Esta equipe ainda não possui integrantes vinculados.'}
                          </p>
                        </div>
                      ) : (
                        <>
                          {/* Mobile: cards empilhados */}
                          <div className="sm:hidden space-y-2.5">
                            {selectedTeamRoster.map((m) => {
                              const rowKey = m.id || `${m.teamId}_${m.uid}`;
                              const dirInfo = directoryByUid.get(m.uid);
                              const isConfirming = confirmEndKey === rowKey;
                              const isEnding = endingMembershipKey === rowKey;
                              return (
                                <div
                                  key={rowKey}
                                  className="bg-[#0D0D10] border border-white/8 rounded-md p-3.5 space-y-2"
                                >
                                  <div className="flex items-start justify-between gap-2">
                                    <div className="min-w-0">
                                      <p className="text-sm font-semibold text-white truncate">
                                        {m.nickname}
                                      </p>
                                      <p className="text-xs text-[#EF3340]">
                                        {formatTeamRoleLabel(m.roleInTeam)}
                                      </p>
                                    </div>
                                    {(dirInfo?.brawlTag || dirInfo?.code) && (
                                      <span className="text-xs font-mono-tabular text-[#A1A1AA]">
                                        {dirInfo.brawlTag || dirInfo.code}
                                      </span>
                                    )}
                                  </div>
                                  <p className="text-[11px] font-mono-tabular text-[#71717A] break-all">
                                    UID: {m.uid}
                                  </p>
                                  {canManageTeamRoster(m.teamId) && (
                                    <div className="pt-1 flex items-center gap-2">
                                      {isConfirming ? (
                                        <>
                                          <button
                                            type="button"
                                            disabled={isEnding}
                                            onClick={() => void handleEndMembership(m)}
                                            className="px-3 min-h-[38px] rounded bg-[#DC172B] hover:bg-[#EF3340] disabled:opacity-50 text-xs font-semibold text-white"
                                          >
                                            {isEnding ? 'Encerrando...' : 'Confirmar encerramento'}
                                          </button>
                                          <button
                                            type="button"
                                            disabled={isEnding}
                                            onClick={() => setConfirmEndKey(null)}
                                            className="px-3 min-h-[38px] rounded bg-[#202027] text-xs text-[#A1A1AA] hover:text-white"
                                          >
                                            Cancelar
                                          </button>
                                        </>
                                      ) : (
                                        <button
                                          type="button"
                                          onClick={() => setConfirmEndKey(rowKey)}
                                          className="min-h-[38px] text-xs font-medium text-[#EF3340] hover:underline"
                                        >
                                          Encerrar vínculo
                                        </button>
                                      )}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>

                          {/* Desktop: tabela limpa */}
                          <div className="hidden sm:block overflow-x-auto bg-[#0D0D10] border border-white/8 rounded-md">
                            <table className="w-full text-xs">
                              <thead>
                                <tr className="text-[#71717A] border-b border-white/8">
                                  <th className="px-3.5 py-2.5 text-left font-medium">
                                    Integrante
                                  </th>
                                  <th className="px-3.5 py-2.5 text-left font-medium">Função</th>
                                  <th className="px-3.5 py-2.5 text-left font-medium">
                                    Tag / Código
                                  </th>
                                  <th className="px-3.5 py-2.5 text-right font-medium">Ação</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-white/6">
                                {selectedTeamRoster.map((m) => {
                                  const rowKey = m.id || `${m.teamId}_${m.uid}`;
                                  const dirInfo = directoryByUid.get(m.uid);
                                  const isConfirming = confirmEndKey === rowKey;
                                  const isEnding = endingMembershipKey === rowKey;
                                  return (
                                    <tr key={rowKey} className="hover:bg-white/[0.02]">
                                      <td className="px-3.5 py-3">
                                        <p className="font-semibold text-white text-sm">
                                          {m.nickname}
                                        </p>
                                        <p className="text-[11px] font-mono-tabular text-[#71717A]">
                                          {m.uid}
                                        </p>
                                      </td>
                                      <td className="px-3.5 py-3 text-[#E4E4E7]">
                                        {formatTeamRoleLabel(m.roleInTeam)}
                                      </td>
                                      <td className="px-3.5 py-3 font-mono-tabular text-[#A1A1AA]">
                                        {dirInfo?.brawlTag || dirInfo?.code || '—'}
                                      </td>
                                      <td className="px-3.5 py-3 text-right">
                                        {canManageTeamRoster(m.teamId) ? (
                                          isConfirming ? (
                                            <div className="inline-flex items-center gap-2">
                                              <button
                                                type="button"
                                                disabled={isEnding}
                                                onClick={() => void handleEndMembership(m)}
                                                className="px-2.5 py-1.5 rounded bg-[#DC172B] hover:bg-[#EF3340] disabled:opacity-50 text-xs font-semibold text-white"
                                              >
                                                {isEnding ? 'Encerrando...' : 'Confirmar'}
                                              </button>
                                              <button
                                                type="button"
                                                disabled={isEnding}
                                                onClick={() => setConfirmEndKey(null)}
                                                className="px-2.5 py-1.5 rounded bg-[#202027] text-xs text-[#A1A1AA] hover:text-white"
                                              >
                                                Cancelar
                                              </button>
                                            </div>
                                          ) : (
                                            <button
                                              type="button"
                                              onClick={() => setConfirmEndKey(rowKey)}
                                              className="text-xs font-medium text-[#EF3340] hover:underline"
                                            >
                                              Encerrar vínculo
                                            </button>
                                          )
                                        ) : (
                                          <span className="text-[#52525B]">—</span>
                                        )}
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        </>
                      )}
                    </div>

                    {/* Formulário: Vincular membro ao elenco com busca por nome ou tag */}
                    {canManageTeamRoster(selectedTeam.id) && (
                      <form
                        onSubmit={handleAddMembership}
                        className="border-t border-white/8 pt-5 space-y-4"
                      >
                        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                          <div>
                            <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                              <UserPlus className="w-4 h-4 text-[#EF3340]" />
                              Vincular integrante a {selectedTeam.name}
                            </h3>
                            <p className="text-xs text-[#A1A1AA] mt-0.5">
                              Busque pelo nome, apelido, código NXF ou Brawl Tag. O UID é mantido
                              internamente no envio ao servidor.
                            </p>
                          </div>

                          <button
                            type="button"
                            onClick={() => {
                              setManualUidMode((prev) => !prev);
                              setSelectedMember(null);
                            }}
                            className="self-start sm:self-auto text-xs text-[#A1A1AA] hover:text-white underline underline-offset-2"
                          >
                            {manualUidMode
                              ? 'Voltar para busca por nome/tag'
                              : 'Informar UID manualmente'}
                          </button>
                        </div>

                        {manualUidMode ? (
                          <label className="block space-y-1.5">
                            <span className="text-xs font-medium text-[#E4E4E7]">
                              UID da conta (modo manual)
                            </span>
                            <input
                              type="text"
                              required
                              value={manualUid}
                              onChange={(e) => setManualUid(e.target.value)}
                              placeholder="Cole o UID do usuário"
                              className="w-full min-h-[42px] bg-[#0D0D10] border border-white/12 focus:border-[#DC172B] focus:outline-none rounded-md px-3 text-sm font-mono-tabular text-white placeholder:text-[#71717A]"
                            />
                            <span className="block text-[11px] text-[#71717A]">
                              Útil quando o usuário ainda não possui perfil público aprovado para
                              aparecer na busca de gerente.
                            </span>
                          </label>
                        ) : selectedMember ? (
                          <div className="p-3.5 bg-[#0D0D10] border border-[#DC172B]/40 rounded-md flex items-center justify-between gap-3">
                            <div className="min-w-0 space-y-0.5">
                              <div className="flex items-center gap-2">
                                <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                                <span className="text-sm font-semibold text-white truncate">
                                  {selectedMember.displayName}
                                </span>
                              </div>
                              <p className="text-xs text-[#A1A1AA] font-mono-tabular truncate">
                                {[
                                  selectedMember.brawlTag,
                                  selectedMember.code,
                                  `UID: ${selectedMember.uid}`,
                                ]
                                  .filter(Boolean)
                                  .join(' · ')}
                              </p>
                              {selectedTeamRosterUidSet.has(selectedMember.uid) && (
                                <p className="text-[11px] text-amber-400">
                                  Este usuário já está neste elenco — salvar atualizará o nickname
                                  e a função.
                                </p>
                              )}
                            </div>
                            <button
                              type="button"
                              onClick={() => {
                                setSelectedMember(null);
                                setMemberNickname('');
                              }}
                              className="px-3 min-h-[36px] rounded bg-[#202027] hover:bg-[#2B2B35] text-xs font-medium text-white shrink-0"
                            >
                              Trocar
                            </button>
                          </div>
                        ) : (
                          <div className="space-y-2">
                            <div className="relative">
                              <Search className="w-4 h-4 text-[#71717A] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                              <input
                                type="search"
                                value={memberSearch}
                                onChange={(e) => setMemberSearch(e.target.value)}
                                placeholder="Buscar por nome, apelido, código (#) ou Brawl Tag..."
                                className="w-full min-h-[42px] bg-[#0D0D10] border border-white/12 focus:border-[#DC172B] focus:outline-none rounded-md pl-9 pr-3 text-sm text-white placeholder:text-[#71717A]"
                              />
                            </div>

                            {directoryError && (
                              <p className="text-xs text-amber-400">{directoryError}</p>
                            )}

                            <div className="bg-[#0D0D10] border border-white/8 rounded-md overflow-hidden">
                              {directoryLoading ? (
                                <p className="p-3 text-xs text-[#A1A1AA]">
                                  Carregando integrantes disponíveis...
                                </p>
                              ) : filteredDirectory.length === 0 ? (
                                <p className="p-3 text-xs text-[#A1A1AA]">
                                  {memberDirectory.length === 0
                                    ? 'Nenhum perfil elegível encontrado no escopo do seu cargo. Você pode usar "Informar UID manualmente".'
                                    : 'Nenhum integrante corresponde à busca informada.'}
                                </p>
                              ) : (
                                <ul className="divide-y divide-white/6 max-h-52 overflow-y-auto">
                                  {filteredDirectory.map((member) => {
                                    const alreadyInTeam = selectedTeamRosterUidSet.has(member.uid);
                                    return (
                                      <li key={member.uid}>
                                        <button
                                          type="button"
                                          onClick={() => handlePickMember(member)}
                                          className="w-full text-left px-3.5 py-2.5 hover:bg-white/[0.04] transition-colors flex items-center justify-between gap-3"
                                        >
                                          <div className="min-w-0">
                                            <p className="text-sm font-medium text-white truncate">
                                              {member.displayName}
                                              {member.fullName &&
                                                member.fullName !== member.displayName && (
                                                  <span className="text-xs text-[#71717A] font-normal ml-1.5">
                                                    ({member.fullName})
                                                  </span>
                                                )}
                                            </p>
                                            <p className="text-[11px] font-mono-tabular text-[#A1A1AA] truncate">
                                              {[member.brawlTag, member.code]
                                                .filter(Boolean)
                                                .join(' · ') || `UID: ${member.uid}`}
                                            </p>
                                          </div>
                                          <span className="text-[11px] shrink-0 font-medium text-[#A1A1AA]">
                                            {alreadyInTeam ? 'No elenco' : 'Selecionar'}
                                          </span>
                                        </button>
                                      </li>
                                    );
                                  })}
                                </ul>
                              )}
                            </div>

                            {!canReadUsersDirectory && (
                              <p className="text-[11px] text-[#71717A]">
                                A busca exibe membros com perfil público aprovado e integrantes já
                                vinculados. Para contas sem perfil público, use a opção manual de
                                UID.
                              </p>
                            )}
                          </div>
                        )}

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <label className="block space-y-1.5">
                            <span className="text-xs font-medium text-[#E4E4E7]">
                              Nickname no elenco
                            </span>
                            <input
                              type="text"
                              required
                              minLength={2}
                              maxLength={BLUEPRINT_LIMITS.NICKNAME_MAX}
                              value={memberNickname}
                              onChange={(e) => setMemberNickname(e.target.value)}
                              placeholder="Ex.: NXF Player"
                              className="w-full min-h-[42px] bg-[#0D0D10] border border-white/12 focus:border-[#DC172B] focus:outline-none rounded-md px-3 text-sm text-white placeholder:text-[#71717A]"
                            />
                          </label>

                          <label className="block space-y-1.5">
                            <span className="text-xs font-medium text-[#E4E4E7]">
                              Função na equipe
                            </span>
                            <select
                              value={memberRole}
                              onChange={(e) =>
                                setMemberRole(e.target.value as TeamMembership['roleInTeam'])
                              }
                              className="w-full min-h-[42px] bg-[#0D0D10] border border-white/12 focus:border-[#DC172B] focus:outline-none rounded-md px-3 text-sm text-white"
                            >
                              <option value="starter">Titular</option>
                              <option value="reserve">Reserva</option>
                              <option value="coach">Técnico</option>
                              <option value="manager">Gerente</option>
                              <option value="analyst">Analista</option>
                            </select>
                          </label>
                        </div>

                        <div className="flex justify-end">
                          <button
                            type="submit"
                            disabled={
                              savingMembership ||
                              (!manualUidMode && !selectedMember) ||
                              (manualUidMode && !manualUid.trim())
                            }
                            className="px-4 min-h-[42px] rounded-md text-xs font-semibold text-white bg-[#DC172B] hover:bg-[#EF3340] disabled:opacity-50 transition-colors"
                          >
                            {savingMembership ? 'Salvando vínculo...' : 'Salvar vínculo no elenco'}
                          </button>
                        </div>
                      </form>
                    )}
                  </div>
                )}

                {/* Conteúdo da aba EDITAR E VISIBILIDADE */}
                {activeTab === 'settings' && canEditTeam(selectedTeam.id) && (
                  <form onSubmit={handleUpdateTeam} className="p-5 space-y-5">
                    {selectedTeamHasLegacyGap && (
                      <div className="p-3.5 bg-amber-500/10 border border-amber-500/30 rounded-md flex items-start gap-2.5 text-xs text-amber-200">
                        <ShieldAlert className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                        <p className="leading-relaxed">
                          Esta equipe possui registro legado sem todos os metadados obrigatórios
                          (<span className="font-mono-tabular">id</span> ou{' '}
                          <span className="font-mono-tabular">createdAt</span>). A regra atual do
                          Firestore pode recusar a edição direta pelo navegador até a normalização
                          do documento no backend.
                        </p>
                      </div>
                    )}

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <label className="block space-y-1.5">
                        <span className="text-xs font-medium text-[#E4E4E7]">Nome da equipe</span>
                        <input
                          type="text"
                          required
                          minLength={2}
                          maxLength={BLUEPRINT_LIMITS.TEAM_NAME_MAX}
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          className="w-full min-h-[42px] bg-[#0D0D10] border border-white/12 focus:border-[#DC172B] focus:outline-none rounded-md px-3 text-sm text-white"
                        />
                      </label>

                      <label className="block space-y-1.5">
                        <span className="text-xs font-medium text-[#E4E4E7]">Categoria</span>
                        <input
                          type="text"
                          required
                          minLength={2}
                          maxLength={40}
                          value={editCategory}
                          onChange={(e) => setEditCategory(e.target.value)}
                          placeholder="Ex.: Principal"
                          className="w-full min-h-[42px] bg-[#0D0D10] border border-white/12 focus:border-[#DC172B] focus:outline-none rounded-md px-3 text-sm text-white"
                        />
                      </label>
                    </div>

                    <label className="block space-y-1.5">
                      <span className="text-xs font-medium text-[#E4E4E7]">Descrição</span>
                      <textarea
                        rows={3}
                        maxLength={BLUEPRINT_LIMITS.TEAM_DESC_MAX}
                        value={editDesc}
                        onChange={(e) => setEditDesc(e.target.value)}
                        placeholder="Descrição exibida no portal e na gestão interna."
                        className="w-full bg-[#0D0D10] border border-white/12 focus:border-[#DC172B] focus:outline-none rounded-md px-3 py-2 text-sm text-white"
                      />
                    </label>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-1">
                      <div className="p-3.5 bg-[#0D0D10] border border-white/8 rounded-md space-y-2">
                        <p className="text-xs font-semibold text-white">Visibilidade no portal</p>
                        <label className="flex items-start gap-2.5 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={editIsPublic}
                            onChange={(e) => setEditIsPublic(e.target.checked)}
                            className="w-4 h-4 accent-[#DC172B] mt-0.5"
                          />
                          <span className="text-xs text-[#A1A1AA] leading-relaxed">
                            {editIsPublic
                              ? 'Pública — aparece na página pública de equipes da NXF.'
                              : 'Interna — visível apenas para membros oficiais no painel.'}
                          </span>
                        </label>
                      </div>

                      <div className="p-3.5 bg-[#0D0D10] border border-white/8 rounded-md space-y-2">
                        <p className="text-xs font-semibold text-white">Situação operacional</p>
                        <label className="flex items-start gap-2.5 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={editActive}
                            onChange={(e) => setEditActive(e.target.checked)}
                            className="w-4 h-4 accent-[#DC172B] mt-0.5"
                          />
                          <span className="text-xs text-[#A1A1AA] leading-relaxed">
                            {editActive
                              ? 'Ativa — disponível para operações e escalações.'
                              : 'Inativa — arquivada preservando histórico e vínculos existentes.'}
                          </span>
                        </label>
                      </div>
                    </div>

                    <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-white/8">
                      <button
                        type="submit"
                        disabled={savingTeamEdit}
                        className="px-4 min-h-[42px] rounded-md text-xs font-semibold text-white bg-[#DC172B] hover:bg-[#EF3340] disabled:opacity-50"
                      >
                        {savingTeamEdit ? 'Salvando alterações...' : 'Salvar alterações da equipe'}
                      </button>
                    </div>
                  </form>
                )}
              </>
            )}
          </section>
        </div>
      )}

      {/* Seção secundária: Convites Emitidos (somente administradores) */}
      {capabilities.isAnyAdmin && (
        <section className="space-y-3 pt-2">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h2 className="font-display text-lg font-bold text-white">Convites emitidos</h2>
              <p className="text-xs text-[#A1A1AA]">
                Histórico de convites individuais gerados para entrada oficial na organização.
              </p>
            </div>
            {invitationsState.status === 'ready' && (
              <span className="text-xs font-mono-tabular text-[#A1A1AA]">
                {invitationsState.data.length}{' '}
                {invitationsState.data.length === 1 ? 'registro' : 'registros'}
              </span>
            )}
          </div>

          {invitationsState.status === 'loading' ? (
            <LoadingSkeleton rows={2} />
          ) : invitationsState.status === 'error' ? (
            <ErrorState
              title="Erro ao carregar convites"
              description={invitationsState.message}
              onRetry={() => setReloadKey((k) => k + 1)}
            />
          ) : invitationsState.data.length === 0 ? (
            <div className="bg-[#15151A] border border-white/8 rounded-lg p-5 text-xs text-[#A1A1AA]">
              Nenhum convite emitido até o momento. Use o botão{' '}
              <span className="text-white font-medium">Emitir convite</span> no topo para gerar um
              convite individual.
            </div>
          ) : (
            <div className="bg-[#15151A] border border-white/8 rounded-lg overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-[#71717A] border-b border-white/8">
                    <th className="p-3.5 text-left font-medium">Código</th>
                    <th className="p-3.5 text-left font-medium">Cargos</th>
                    <th className="p-3.5 text-left font-medium">Equipe</th>
                    <th className="p-3.5 text-left font-medium">Status</th>
                    <th className="p-3.5 text-right font-medium">Validade</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/6">
                  {invitationsState.data.map((inv) => (
                    <tr key={inv.id} className="hover:bg-white/[0.02]">
                      <td className="p-3.5 font-mono-tabular text-white">
                        {inv.targetCode || inv.targetEmail || '—'}
                      </td>
                      <td className="p-3.5 text-[#E4E4E7]">
                        {(inv.assignedRoles || [])
                          .map((r) => ROLE_LABELS[r] || r)
                          .join(', ') || '—'}
                      </td>
                      <td className="p-3.5 text-[#A1A1AA]">
                        {inv.teamId ? teamNameById.get(inv.teamId) || inv.teamId : 'Sem equipe'}
                      </td>
                      <td className="p-3.5 font-medium text-white">
                        {INVITATION_STATUS_LABELS[inv.status] || inv.status}
                      </td>
                      <td className="p-3.5 text-right font-mono-tabular text-[#A1A1AA]">
                        {formatFirestoreDate(inv.expiresAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
