import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Bell,
  CheckCheck,
  KeyRound,
  LogOut,
  MailCheck,
  Save,
  Send,
  Shield,
  User,
} from 'lucide-react';
import {
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
import { apiFetch } from '../../lib/apiClient';
import { useAuth } from '../../context/AuthContext';
import { formatFirestoreDate, ROLE_LABELS } from '../../lib/permissions';
import { EmptyState } from '../../components/common/StateViews';
import {
  BLUEPRINT_LIMITS,
  type Application,
  type NotificationItem,
  type UserRole,
} from '../../types/nxf';

const STAGE_LABELS: Record<Application['stage'], string> = {
  recebida: 'Recebida',
  em_analise: 'Em análise',
  em_teste: 'Em teste',
  aprovada: 'Aprovada',
  rejeitada: 'Não selecionada',
};

interface PendingInvitationItem {
  id: string;
  targetCode: string;
  assignedRoles: UserRole[];
  teamId?: string;
  roleInTeam?: string;
  expiresAtIso?: string | null;
}

export function CandidatePortalPage() {
  const { firebaseUser, userDoc, capabilities, changePassword, refreshClaims, signOut } =
    useAuth();
  const navigate = useNavigate();

  const [applications, setApplications] = useState<Application[]>([]);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [pendingInvitations, setPendingInvitations] = useState<PendingInvitationItem[]>([]);
  const [acceptingInvId, setAcceptingInvId] = useState<string | null>(null);

  const [fullName, setFullName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [brawlTag, setBrawlTag] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [savingPassword, setSavingPassword] = useState(false);

  const [feedback, setFeedback] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    setFullName(userDoc?.fullName || '');
    setDisplayName(userDoc?.displayName || firebaseUser?.displayName || '');
    setBrawlTag(userDoc?.brawlTag || userDoc?.code || '');
  }, [userDoc, firebaseUser]);

  const loadPendingInvitations = async () => {
    try {
      const res = await apiFetch<{ invitations: PendingInvitationItem[] }>(
        '/api/invitations/mine'
      );
      setPendingInvitations(res.invitations || []);
    } catch {
      setPendingInvitations([]);
    }
  };

  useEffect(() => {
    if (!firebaseUser) return;
    void loadPendingInvitations();

    const u1 = onSnapshot(
      query(collection(db, 'applications'), where('applicantUid', '==', firebaseUser.uid)),
      (s) =>
        setApplications(
          s.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Application, 'id'>) }))
        ),
      () => {}
    );

    const u2 = onSnapshot(
      query(
        collection(db, 'notifications'),
        where('recipientUid', '==', firebaseUser.uid),
        orderBy('createdAt', 'desc')
      ),
      (s) =>
        setNotifications(
          s.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<NotificationItem, 'id'>) }))
        ),
      () => {}
    );

    return () => {
      u1();
      u2();
    };
  }, [firebaseUser]);

  const handleAcceptInvitation = async (inv: PendingInvitationItem) => {
    setAcceptingInvId(inv.id);
    setErrorMsg('');
    setFeedback('');
    try {
      await apiFetch(`/api/invitations/${inv.id}/accept`, {
        method: 'POST',
      });
      await refreshClaims();
      await loadPendingInvitations();
      setFeedback('Convite oficial aceito com sucesso. Acesso ao painel liberado.');
      navigate('/painel');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Falha ao aceitar convite.');
    } finally {
      setAcceptingInvId(null);
    }
  };

  const handleSaveData = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firebaseUser) return;
    setSavingProfile(true);
    setFeedback('');
    setErrorMsg('');

    const cleanFull = fullName.trim().slice(0, BLUEPRINT_LIMITS.FULL_NAME_MAX);
    const cleanNick = displayName.trim().slice(0, BLUEPRINT_LIMITS.DISPLAY_NAME_MAX);
    const cleanTag = brawlTag.trim().toUpperCase().slice(0, BLUEPRINT_LIMITS.BRAWL_TAG_MAX);

    try {
      await updateDoc(doc(db, 'users', firebaseUser.uid), {
        fullName: cleanFull,
        displayName: cleanNick,
        brawlTag: cleanTag,
        brawlTagStatus:
          cleanTag && cleanTag !== userDoc?.brawlTag
            ? 'pending'
            : userDoc?.brawlTagStatus || 'none',
        updatedAt: serverTimestamp(),
      });
      setFeedback('Dados da conta atualizados com sucesso.');
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `users/${firebaseUser.uid}`);
    } finally {
      setSavingProfile(false);
    }
  };

  const handlePasswordUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingPassword(true);
    setFeedback('');
    setErrorMsg('');
    try {
      await changePassword(currentPassword, newPassword);
      setCurrentPassword('');
      setNewPassword('');
      setFeedback('Senha atualizada com sucesso.');
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : 'Não foi possível alterar a senha. Verifique a senha atual.'
      );
    } finally {
      setSavingPassword(false);
    }
  };

  const handleSignOut = async () => {
    await signOut();
    navigate('/');
  };

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-10 space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-white/8 pb-6">
        <div className="space-y-1">
          <p className="text-xs font-semibold text-[#EF3340] uppercase tracking-wider">
            Conta Básica · Candidato e Visitante
          </p>
          <h1 className="font-display text-3xl sm:text-4xl font-bold text-white">
            Minha Conta
          </h1>
          <p className="text-xs text-[#A1A1AA]">
            Acompanhe suas inscrições no recrutamento, convites oficiais pendentes, dados cadastrais e senha.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {capabilities.isOfficialMember && (
            <Link
              to="/painel"
              className="inline-flex items-center gap-1.5 px-4 py-2 bg-[#DC172B] hover:bg-[#EF3340] text-white text-xs font-semibold rounded-md"
            >
              <Shield className="w-3.5 h-3.5" />
              Acessar painel da organização
            </Link>
          )}
          <Link
            to="/recrutamento"
            className="inline-flex items-center gap-1.5 px-4 py-2 bg-[#202027] hover:bg-[#2B2B35] border border-white/10 text-xs font-semibold text-white rounded-md"
          >
            <Send className="w-3.5 h-3.5" />
            Ver vagas abertas
          </Link>
          <button
            type="button"
            onClick={() => void handleSignOut()}
            className="inline-flex items-center gap-1.5 px-4 py-2 bg-[#15151A] hover:bg-[#202027] border border-white/10 text-xs font-medium text-[#EF3340] rounded-md"
          >
            <LogOut className="w-3.5 h-3.5" />
            Sair
          </button>
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

      {/* Convites Oficiais Pendentes (Backend Render) */}
      {pendingInvitations.length > 0 && (
        <section className="bg-[#15151A] border border-[#DC172B] rounded-lg p-5 space-y-3">
          <h2 className="text-base font-bold text-white flex items-center gap-2">
            <MailCheck className="w-4 h-4 text-[#EF3340]" /> Convite Oficial Pendente para {userDoc?.code}
          </h2>
          <div className="space-y-2.5">
            {pendingInvitations.map((inv) => (
              <div
                key={inv.id}
                className="bg-[#0D0D10] border border-white/10 rounded p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
              >
                <div className="space-y-1 text-xs">
                  <p className="text-white font-semibold">
                    Cargos atribuídos:{' '}
                    {inv.assignedRoles.map((r) => ROLE_LABELS[r] || r).join(', ')}
                  </p>
                  <p className="text-[#A1A1AA]">
                    {inv.teamId ? `Equipe: ${inv.teamId} (${inv.roleInTeam || 'membro'})` : 'Sem vínculo de equipe inicial'}
                    {inv.expiresAtIso ? ` · Válido até ${formatFirestoreDate(inv.expiresAtIso)}` : ''}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={acceptingInvId === inv.id}
                  onClick={() => void handleAcceptInvitation(inv)}
                  className="px-4 py-2 bg-[#DC172B] hover:bg-[#EF3340] disabled:opacity-50 text-white text-xs font-semibold rounded shrink-0"
                >
                  {acceptingInvId === inv.id ? 'Confirmando...' : 'Aceitar convite oficial'}
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Dados Cadastrais */}
        <form
          onSubmit={handleSaveData}
          className="bg-[#15151A] border border-white/8 rounded-lg p-6 space-y-4"
        >
          <div className="flex items-center justify-between border-b border-white/8 pb-3">
            <h2 className="text-base font-bold text-white flex items-center gap-2">
              <User className="w-4 h-4 text-[#EF3340]" /> Dados de Cadastro
            </h2>
            <span className="font-mono-tabular text-xs text-[#A1A1AA]">
              Code: <strong className="text-white">{userDoc?.code || '—'}</strong>
            </span>
          </div>

          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-[#A1A1AA]">
              Nome completo
            </label>
            <input
              type="text"
              required
              minLength={2}
              maxLength={BLUEPRINT_LIMITS.FULL_NAME_MAX}
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              className="w-full bg-[#0D0D10] border border-white/12 rounded-md px-3 py-2 text-sm text-white focus:border-[#DC172B] focus:outline-none"
            />
          </div>

          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-[#A1A1AA]">
              Nick
            </label>
            <input
              type="text"
              required
              minLength={2}
              maxLength={BLUEPRINT_LIMITS.DISPLAY_NAME_MAX}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="w-full bg-[#0D0D10] border border-white/12 rounded-md px-3 py-2 text-sm text-white focus:border-[#DC172B] focus:outline-none"
            />
          </div>

          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-[#A1A1AA]">
              Tag Brawl Stars (opcional)
            </label>
            <input
              type="text"
              maxLength={BLUEPRINT_LIMITS.BRAWL_TAG_MAX}
              value={brawlTag}
              onChange={(e) => setBrawlTag(e.target.value)}
              placeholder="#ABC123"
              className="w-full bg-[#0D0D10] border border-white/12 rounded-md px-3 py-2 text-sm font-mono-tabular uppercase text-white focus:border-[#DC172B] focus:outline-none"
            />
          </div>

          <button
            type="submit"
            disabled={savingProfile}
            className="inline-flex items-center gap-2 px-4 py-2 bg-[#DC172B] hover:bg-[#EF3340] disabled:opacity-50 text-xs font-semibold text-white rounded-md"
          >
            <Save className="w-3.5 h-3.5" />
            {savingProfile ? 'Salvando...' : 'Salvar dados'}
          </button>
        </form>

        {/* Alterar Senha */}
        <form
          onSubmit={handlePasswordUpdate}
          className="bg-[#15151A] border border-white/8 rounded-lg p-6 space-y-4"
        >
          <div className="border-b border-white/8 pb-3">
            <h2 className="text-base font-bold text-white flex items-center gap-2">
              <KeyRound className="w-4 h-4 text-[#EF3340]" /> Segurança da Conta
            </h2>
          </div>

          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-[#A1A1AA]">
              Senha atual
            </label>
            <input
              type="password"
              required
              minLength={6}
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              className="w-full bg-[#0D0D10] border border-white/12 rounded-md px-3 py-2 text-sm text-white focus:border-[#DC172B] focus:outline-none"
            />
          </div>

          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-[#A1A1AA]">
              Nova senha (mínimo 6 caracteres)
            </label>
            <input
              type="password"
              required
              minLength={6}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="w-full bg-[#0D0D10] border border-white/12 rounded-md px-3 py-2 text-sm text-white focus:border-[#DC172B] focus:outline-none"
            />
          </div>

          <button
            type="submit"
            disabled={savingPassword}
            className="px-4 py-2 bg-[#202027] hover:bg-[#2B2B35] border border-white/10 disabled:opacity-50 text-xs font-semibold text-white rounded-md"
          >
            {savingPassword ? 'Atualizando...' : 'Alterar senha'}
          </button>
        </form>
      </div>

      {/* Minhas Candidaturas */}
      <section className="space-y-4">
        <h2 className="font-display text-2xl font-bold text-white">
          Minhas Candidaturas ({applications.length})
        </h2>
        {applications.length === 0 ? (
          <EmptyState
            title="Nenhuma candidatura enviada"
            description="Quando você se inscrever em uma seletiva na página de Recrutamento, o status em tempo real aparecerá aqui."
            action={
              <Link
                to="/recrutamento"
                className="px-4 py-2 bg-[#DC172B] hover:bg-[#EF3340] text-white text-xs font-semibold rounded-md"
              >
                Explorar vagas abertas
              </Link>
            }
          />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {applications.map((app) => (
              <div
                key={app.id}
                className="bg-[#15151A] border border-white/8 rounded-lg p-5 space-y-2"
              >
                <div className="flex items-center justify-between text-xs">
                  <span className="font-mono-tabular text-[#A1A1AA]">
                    {app.brawlTag || userDoc?.code || 'Sem tag'}
                  </span>
                  <span className="font-semibold text-[#EF3340]">
                    {STAGE_LABELS[app.stage]}
                  </span>
                </div>
                <p className="text-sm font-bold text-white">{app.applicantName}</p>
                <p className="text-xs text-[#71717A]">
                  Enviada em {formatFirestoreDate(app.createdAt)}
                </p>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Avisos pessoais */}
      <section className="space-y-4">
        <h2 className="font-display text-2xl font-bold text-white flex items-center gap-2">
          <Bell className="w-5 h-5 text-[#EF3340]" /> Avisos Recebidos ({notifications.length})
        </h2>
        {notifications.length === 0 ? (
          <EmptyState
            title="Nenhum aviso recebido"
            description="Atualizações sobre suas candidaturas ou comunicados diretos da organização aparecerão aqui."
          />
        ) : (
          <div className="space-y-2">
            {notifications.map((n) => (
              <div
                key={n.id}
                className={`p-4 rounded-lg border flex items-start justify-between gap-4 ${
                  n.read
                    ? 'bg-[#15151A] border-white/8'
                    : 'bg-[#15151A] border-[#DC172B]/50'
                }`}
              >
                <div className="space-y-1">
                  <p className="text-sm font-bold text-white">{n.title}</p>
                  <p className="text-xs text-[#A1A1AA]">{n.body}</p>
                  <p className="text-[11px] font-mono-tabular text-[#71717A]">
                    {formatFirestoreDate(n.createdAt)}
                  </p>
                </div>
                {!n.read && (
                  <button
                    type="button"
                    onClick={() =>
                      void updateDoc(doc(db, 'notifications', n.id), { read: true })
                    }
                    className="inline-flex items-center gap-1 px-2.5 py-1 bg-[#202027] rounded text-[11px] text-white shrink-0"
                  >
                    <CheckCheck className="w-3.5 h-3.5 text-[#EF3340]" />
                    Marcar lida
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
