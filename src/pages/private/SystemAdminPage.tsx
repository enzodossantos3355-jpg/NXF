import React, { useEffect, useState } from 'react';
import {
  Activity,
  Download,
  KeyRound,
  LifeBuoy,
  RefreshCw,
  Server,
  ShieldAlert,
  ShieldCheck,
  Users,
} from 'lucide-react';
import {
  addDoc,
  collection,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType, testConnection } from '../../lib/firebase';
import { apiFetch } from '../../lib/apiClient';
import { useAuth } from '../../context/AuthContext';
import { formatFirestoreDate, ROLE_LABELS } from '../../lib/permissions';
import { PendingConfigNotice } from '../../components/common/StateViews';
import type {
  AdminGrant,
  AuditLog,
  SupportTicket,
  UserPrivate,
  UserRole,
} from '../../types/nxf';

interface BrawlStatusData {
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

export function SystemAdminPage() {
  const { firebaseUser, userDoc, capabilities, systemSettings, reauthenticateRecent } = useAuth();
  const [users, setUsers] = useState<UserPrivate[]>([]);
  const [admins, setAdmins] = useState<AdminGrant[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [tickets, setTickets] = useState<SupportTicket[]>([]);

  const [connStatus, setConnStatus] = useState<'checking' | 'ok' | 'error'>('checking');
  const [brawlStatus, setBrawlStatus] = useState<BrawlStatusData | null>(null);
  const [testTagInput, setTestTagInput] = useState('');
  const [syncLoading, setSyncLoading] = useState(false);

  const [ticketSubject, setTicketSubject] = useState('');
  const [ticketCategory, setTicketCategory] = useState<SupportTicket['category']>('acesso');
  const [ticketDesc, setTicketDesc] = useState('');

  // Reautenticação para ações críticas de Administrador Principal
  const [criticalAction, setCriticalAction] = useState<{
    type: 'promote_primary' | 'revoke_primary' | 'rotate_password';
    targetUser: UserPrivate;
  } | null>(null);
  const [reauthPassword, setReauthPassword] = useState('');
  const [newRotatedPassword, setNewRotatedPassword] = useState('');
  const [feedback, setFeedback] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  const loadBrawlStatus = async () => {
    try {
      const res = await apiFetch<BrawlStatusData>('/api/brawl/status');
      setBrawlStatus(res);
    } catch {
      setBrawlStatus(null);
    }
  };

  useEffect(() => {
    void testConnection().then((res) => setConnStatus(res.ok ? 'ok' : 'error'));
    if (firebaseUser) {
      void loadBrawlStatus();
    }
  }, [firebaseUser]);

  useEffect(() => {
    if (!firebaseUser) return;
    const unsubs: Array<() => void> = [];

    if (capabilities.isPrimaryAdmin || capabilities.canAccessSystem) {
      unsubs.push(
        onSnapshot(
          query(collection(db, 'users'), limit(50)),
          (s) => setUsers(s.docs.map((d) => d.data() as UserPrivate)),
          () => {}
        )
      );
      unsubs.push(
        onSnapshot(
          query(collection(db, 'auditLogs'), orderBy('createdAt', 'desc'), limit(30)),
          (s) =>
            setAuditLogs(
              s.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<AuditLog, 'id'>) }))
            ),
          () => {}
        )
      );
    }

    if (capabilities.isPrimaryAdmin) {
      unsubs.push(
        onSnapshot(
          collection(db, 'admins'),
          (s) => setAdmins(s.docs.map((d) => d.data() as AdminGrant)),
          () => {}
        )
      );
    }

    const ticketQuery = capabilities.isAnyAdmin
      ? query(collection(db, 'supportTickets'), orderBy('createdAt', 'desc'), limit(40))
      : query(
          collection(db, 'supportTickets'),
          where('requesterUid', '==', firebaseUser.uid),
          orderBy('createdAt', 'desc')
        );

    unsubs.push(
      onSnapshot(
        ticketQuery,
        (s) =>
          setTickets(
            s.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<SupportTicket, 'id'>) }))
          ),
        () => {}
      )
    );

    return () => unsubs.forEach((u) => u());
  }, [firebaseUser, capabilities]);

  const activePrimaryCount = admins.filter((a) => a.role === 'primary_admin' && a.active).length;

  const handleAssignRole = async (target: UserPrivate, role: UserRole) => {
    setErrorMsg('');
    setFeedback('');
    try {
      await apiFetch(`/api/admin/users/${target.uid}/roles`, {
        method: 'POST',
        body: { role },
      });
      setFeedback(`Cargo ${ROLE_LABELS[role]} atribuído a ${target.displayName} via servidor.`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Falha ao atribuir cargo no servidor.');
    }
  };

  const handleApproveBrawlTag = async (target: UserPrivate, approved: boolean) => {
    setErrorMsg('');
    setFeedback('');
    try {
      await apiFetch(`/api/admin/users/${target.uid}/brawl-tag`, {
        method: 'POST',
        body: { approved },
      });
      setFeedback(
        `Tag de ${target.displayName} ${approved ? 'aprovada' : 'rejeitada'} pelo servidor.`
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Falha ao validar Tag Brawl Stars.');
    }
  };

  const executeCriticalAdminAction = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!criticalAction || !firebaseUser) return;
    setErrorMsg('');
    setFeedback('');

    try {
      await reauthenticateRecent(reauthPassword);
      const { type, targetUser } = criticalAction;

      if (type === 'rotate_password') {
        const res = await apiFetch<{ generatedPassword?: string; message: string }>(
          `/api/admin/users/${targetUser.uid}/rotate-password`,
          {
            method: 'POST',
            body: newRotatedPassword.trim() ? { newPassword: newRotatedPassword.trim() } : {},
          }
        );
        setCriticalAction(null);
        setReauthPassword('');
        setNewRotatedPassword('');
        setFeedback(
          res.generatedPassword
            ? `Credencial de ${targetUser.displayName} rotacionada. Nova senha temporária (anote agora): ${res.generatedPassword}`
            : res.message
        );
        return;
      }

      if (type === 'revoke_primary' && activePrimaryCount <= 1) {
        setErrorMsg('Bloqueado: não é permitido remover o último Administrador Principal ativo.');
        return;
      }

      await apiFetch(`/api/admin/users/${targetUser.uid}/primary-admin`, {
        method: 'POST',
        body: { action: type === 'promote_primary' ? 'promote' : 'revoke' },
      });

      setCriticalAction(null);
      setReauthPassword('');
      setFeedback('Ação crítica executada no servidor com reautenticação e auditoria registrada.');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Falha na reautenticação ou permissão.');
    }
  };

  const handleManualBrawlSync = async () => {
    setSyncLoading(true);
    setErrorMsg('');
    setFeedback('');
    try {
      const res = await apiFetch<{
        ok: boolean;
        skipped?: boolean;
        reason?: string;
        syncedCount: number;
        errorCount: number;
        error?: string | null;
      }>('/api/brawl/sync', { method: 'POST' });

      await loadBrawlStatus();
      if (res.ok) {
        setFeedback(
          `Sincronização concluída: ${res.syncedCount} jogador(es) atualizado(s), ${res.errorCount} erro(s).`
        );
      } else {
        setErrorMsg(res.error || `Sincronização não concluída (${res.reason || 'erro'}).`);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Erro ao acionar sincronização.');
    } finally {
      setSyncLoading(false);
    }
  };

  const handleTestBrawlTag = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!testTagInput.trim()) return;
    setSyncLoading(true);
    setErrorMsg('');
    setFeedback('');
    try {
      const res = await apiFetch<{
        ok: boolean;
        httpStatus: number | null;
        error: string | null;
        playerName?: string;
        trophies?: number;
      }>('/api/brawl/test-tag', {
        method: 'POST',
        body: { tag: testTagInput },
      });

      await loadBrawlStatus();
      if (res.ok) {
        setFeedback(
          res.playerName
            ? `Conexão validada na Supercell: ${res.playerName} (${res.trophies ?? 0} troféus).`
            : 'Autenticação/IP validados na API Brawl Stars.'
        );
      } else {
        setErrorMsg(res.error || `Falha no teste HTTP ${res.httpStatus ?? 'N/A'}.`);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Erro ao testar tag na API.');
    } finally {
      setSyncLoading(false);
    }
  };

  const handleCreateTicket = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firebaseUser) return;
    try {
      await addDoc(collection(db, 'supportTickets'), {
        requesterUid: firebaseUser.uid,
        requesterName: userDoc?.displayName || firebaseUser.displayName || 'Usuário',
        subject: ticketSubject.trim().slice(0, 120),
        category: ticketCategory,
        description: ticketDesc.trim().slice(0, 2000),
        status: 'aberto',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      setTicketSubject('');
      setTicketDesc('');
      setFeedback('Ticket técnico aberto com sucesso.');
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, 'supportTickets');
    }
  };

  const handleExportAuditJson = async () => {
    setErrorMsg('');
    try {
      const payload = await apiFetch<{
        exportedAt: string;
        count: number;
        auditLogs: unknown[];
      }>('/api/admin/audit-export');

      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `nxf-auditoria-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      const fallback = {
        exportedAt: new Date().toISOString(),
        auditLogsCount: auditLogs.length,
        auditLogs,
      };
      const blob = new Blob([JSON.stringify(fallback, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `nxf-auditoria-local-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
    }
  };

  return (
    <div className="space-y-8">
      <div className="border-b border-white/8 pb-4">
        <h1 className="font-display text-3xl font-bold text-white">NXF System e Suporte</h1>
        <p className="text-xs text-[#A1A1AA]">
          Governança de cargos via backend Render, múltiplos administradores principais, sincronização Brawl Stars, auditoria imutável e tickets técnicos.
        </p>
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

      {/* Diagnósticos Reais */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-[#15151A] border border-white/8 rounded-lg p-4 space-y-1">
          <div className="flex items-center gap-2 text-xs text-[#A1A1AA]">
            <Activity className="w-4 h-4 text-[#EF3340]" /> Firestore (Plano Spark)
          </div>
          <p className="text-sm font-bold text-white">
            {connStatus === 'ok'
              ? 'Conectado ao servidor'
              : connStatus === 'checking'
                ? 'Verificando...'
                : 'Offline / Verificar config'}
          </p>
        </div>
        <div className="bg-[#15151A] border border-white/8 rounded-lg p-4 space-y-1">
          <div className="flex items-center gap-2 text-xs text-[#A1A1AA]">
            <ShieldCheck className="w-4 h-4 text-[#EF3340]" /> API Brawl Stars
          </div>
          <p className="text-sm font-bold text-white">
            {brawlStatus?.brawlApiConfigured || systemSettings?.brawlApiConfigured
              ? 'Validada e operacional'
              : brawlStatus?.brawlTokenConfigured
                ? 'Token presente (validar IP/Tag)'
                : 'Configuração pendente'}
          </p>
        </div>
        <div className="bg-[#15151A] border border-white/8 rounded-lg p-4 space-y-1">
          <div className="flex items-center gap-2 text-xs text-[#A1A1AA]">
            <Server className="w-4 h-4 text-[#EF3340]" /> Backend Render Starter
          </div>
          <p className="text-sm font-bold text-white">
            {brawlStatus ? 'API Express conectada' : 'Verificar backend / Admin SDK'}
          </p>
        </div>
      </div>

      {/* Painel de Diagnóstico e Sincronização Brawl Stars */}
      {(capabilities.isPrimaryAdmin || capabilities.canAccessSystem) && (
        <section className="bg-[#15151A] border border-white/8 rounded-lg p-5 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-white/8 pb-3">
            <div>
              <h2 className="text-base font-bold text-white">
                Integração Oficial Brawl Stars (Render Backend · Ciclo 6h)
              </h2>
              <p className="text-xs text-[#A1A1AA]">
                Execução exclusiva pelo backend Node.js + Express com bloqueio distribuído no Firestore para evitar execuções duplicadas.
              </p>
            </div>
            <button
              type="button"
              disabled={syncLoading}
              onClick={() => void handleManualBrawlSync()}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-[#DC172B] hover:bg-[#EF3340] disabled:opacity-50 rounded text-xs font-semibold text-white shrink-0"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${syncLoading ? 'animate-spin' : ''}`} />
              Sincronizar agora
            </button>
          </div>

          {brawlStatus && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
              <div className="bg-[#0D0D10] border border-white/8 rounded p-3 space-y-1.5">
                <p className="text-[#A1A1AA]">
                  Status do último ciclo:{' '}
                  <strong className="text-white font-mono-tabular">{brawlStatus.lastStatus}</strong>
                </p>
                <p className="text-[#A1A1AA]">
                  Última execução:{' '}
                  <span className="text-white font-mono-tabular">
                    {brawlStatus.lastRunAt ? formatFirestoreDate(brawlStatus.lastRunAt) : 'Nunca'}
                  </span>
                </p>
                <p className="text-[#A1A1AA]">
                  Última resposta HTTP:{' '}
                  <span className="text-white font-mono-tabular">
                    {brawlStatus.lastHttpStatus ?? '—'}
                  </span>{' '}
                  · Proxy IP fixo:{' '}
                  <span className="text-white">
                    {brawlStatus.egressProxyConfigured ? 'Configurado' : 'Direto (IP dinâmico Render)'}
                  </span>
                </p>
                {brawlStatus.lastError && (
                  <p className="text-[#EF3340] pt-1 leading-relaxed">{brawlStatus.lastError}</p>
                )}
              </div>

              {capabilities.isPrimaryAdmin && (
                <form
                  onSubmit={handleTestBrawlTag}
                  className="bg-[#0D0D10] border border-white/8 rounded p-3 space-y-2.5"
                >
                  <p className="font-semibold text-white">
                    Validar Token e IP na Supercell com Tag real
                  </p>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      required
                      value={testTagInput}
                      onChange={(e) => setTestTagInput(e.target.value.toUpperCase())}
                      placeholder="#2PP ou Tag de jogador"
                      className="flex-1 bg-[#15151A] border border-white/12 rounded px-3 py-1.5 text-xs font-mono-tabular uppercase text-white"
                    />
                    <button
                      type="submit"
                      disabled={syncLoading}
                      className="px-3 py-1.5 bg-[#202027] hover:bg-[#2B2B35] border border-white/10 rounded text-xs font-semibold text-white"
                    >
                      Testar API
                    </button>
                  </div>
                  <p className="text-[11px] text-[#71717A] leading-relaxed">
                    Render Starter não fornece IP de saída fixo dedicado. Se a Supercell retornar HTTP 403 (invalidIp), utilize um relay/proxy de IP fixo em <code className="text-white">BRAWL_STARS_API_BASE_URL</code>.
                  </p>
                </form>
              )}
            </div>
          )}
        </section>
      )}

      {/* Gestão de Usuários e Administradores Principais */}
      {capabilities.isPrimaryAdmin && (
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-2xl font-bold text-white flex items-center gap-2">
              <Users className="w-5 h-5 text-[#EF3340]" /> Usuários, Cargos e Tags ({users.length})
            </h2>
            <span className="text-xs font-mono-tabular text-[#A1A1AA]">
              Admins Principais ativos: {Math.max(1, activePrimaryCount)}
            </span>
          </div>

          <div className="bg-[#15151A] border border-white/8 rounded-lg overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-[#71717A] border-b border-white/8">
                  <th className="p-3 text-left">Usuário</th>
                  <th className="p-3 text-left">Cargos</th>
                  <th className="p-3 text-left">Brawl Tag</th>
                  <th className="p-3 text-right">Ações</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const isPrim = u.roles.includes('primary_admin');
                  return (
                    <tr key={u.uid} className="border-b border-white/5 last:border-none">
                      <td className="p-3">
                        <p className="font-semibold text-white">
                          {u.displayName}{' '}
                          <span className="font-normal text-[#A1A1AA]">({u.fullName})</span>
                        </p>
                        <p className="text-[11px] font-mono-tabular text-[#71717A]">
                          {u.code} · {u.uid}
                        </p>
                      </td>
                      <td className="p-3 text-[#A1A1AA]">{u.roles.join(', ')}</td>
                      <td className="p-3 font-mono-tabular">
                        {u.brawlTag || '—'}{' '}
                        {u.brawlTagStatus === 'pending' && (
                          <span className="inline-flex gap-1 ml-2">
                            <button
                              type="button"
                              onClick={() => void handleApproveBrawlTag(u, true)}
                              className="text-[#EF3340] underline"
                            >
                              Aprovar
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleApproveBrawlTag(u, false)}
                              className="text-[#71717A] underline"
                            >
                              Rejeitar
                            </button>
                          </span>
                        )}
                      </td>
                      <td className="p-3 text-right space-x-2 whitespace-nowrap">
                        <select
                          defaultValue=""
                          onChange={(e) => {
                            if (e.target.value) {
                              void handleAssignRole(u, e.target.value as UserRole);
                              e.target.value = '';
                            }
                          }}
                          className="bg-[#0D0D10] border border-white/12 rounded px-2 py-1 text-[11px] text-white"
                        >
                          <option value="">Atribuir cargo...</option>
                          <option value="player">Jogador</option>
                          <option value="coach">Técnico</option>
                          <option value="manager">Gerente</option>
                          <option value="delegated_admin">Admin Delegado</option>
                        </select>
                        <button
                          type="button"
                          onClick={() => {
                            setNewRotatedPassword('');
                            setCriticalAction({ type: 'rotate_password', targetUser: u });
                          }}
                          className="px-2 py-1 bg-[#202027] hover:bg-[#2B2B35] rounded text-[11px] text-white"
                          title="Rotacionar senha e invalidar sessões antigas"
                        >
                          Rotacionar senha
                        </button>
                        {!isPrim ? (
                          <button
                            type="button"
                            onClick={() =>
                              setCriticalAction({ type: 'promote_primary', targetUser: u })
                            }
                            className="px-2 py-1 bg-[#202027] hover:bg-[#DC172B] rounded text-[11px] text-white"
                          >
                            Promover Principal
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() =>
                              setCriticalAction({ type: 'revoke_primary', targetUser: u })
                            }
                            className="px-2 py-1 bg-[#202027] hover:bg-[#DC172B] rounded text-[11px] text-[#EF3340] hover:text-white"
                          >
                            Remover Principal
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <PendingConfigNotice
            title="Exportação de Dados e Snapshots"
            description="No plano Firebase Spark, a exportação manual de logs de auditoria em JSON funciona diretamente pelo backend Express (/api/admin/audit-export). Snapshots gerenciados em Google Cloud Storage (GCS) permanecem desativados sem plano Blaze."
            requirements={[
              'Utilize o botão Exportar JSON abaixo para baixar registros de auditoria autenticados.',
              'Mantenha a rotação periódica de credenciais usando o botão Rotacionar senha.',
            ]}
          />
        </section>
      )}

      {/* Auditoria Imutável */}
      {capabilities.canAccessSystem && (
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-2xl font-bold text-white">Logs de Auditoria</h2>
            <button
              type="button"
              onClick={() => void handleExportAuditJson()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#15151A] border border-white/10 rounded text-xs text-white"
            >
              <Download className="w-3.5 h-3.5" /> Exportar JSON
            </button>
          </div>
          <div className="bg-[#15151A] border border-white/8 rounded-lg p-4 space-y-2 max-h-64 overflow-y-auto">
            {auditLogs.length === 0 ? (
              <p className="text-xs text-[#71717A]">Nenhum evento auditado registrado ainda.</p>
            ) : (
              auditLogs.map((log) => (
                <div
                  key={log.id}
                  className="text-xs border-b border-white/5 pb-2 last:border-none flex flex-col sm:flex-row sm:items-center justify-between gap-1"
                >
                  <div>
                    <span className="font-mono-tabular text-[#EF3340]">{log.action}</span>
                    <span className="text-white"> · {log.summary}</span>
                  </div>
                  <span className="font-mono-tabular text-[#71717A] shrink-0">
                    {formatFirestoreDate(log.createdAt)}
                  </span>
                </div>
              ))
            )}
          </div>
        </section>
      )}

      {/* Suporte por Tickets Técnicos (não é chat) */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <form
          onSubmit={handleCreateTicket}
          className="bg-[#15151A] border border-white/8 rounded-lg p-5 space-y-3"
        >
          <h2 className="text-base font-bold text-white flex items-center gap-2">
            <LifeBuoy className="w-4 h-4 text-[#EF3340]" /> Abrir Ticket Técnico de Suporte
          </h2>
          <p className="text-xs text-[#71717A]">
            Canal exclusivo para suporte técnico e solicitações administrativas (não é chat entre membros).
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <input
              type="text"
              required
              minLength={4}
              maxLength={120}
              value={ticketSubject}
              onChange={(e) => setTicketSubject(e.target.value)}
              placeholder="Assunto do ticket"
              className="bg-[#0D0D10] border border-white/12 rounded px-3 py-2 text-sm text-white"
            />
            <select
              value={ticketCategory}
              onChange={(e) => setTicketCategory(e.target.value as SupportTicket['category'])}
              className="bg-[#0D0D10] border border-white/12 rounded px-3 py-2 text-xs text-white"
            >
              <option value="acesso">Acesso e permissões</option>
              <option value="brawl_tag">Vinculação de Tag</option>
              <option value="bug">Erro técnico</option>
              <option value="integracao">Integrações</option>
              <option value="outro">Outro</option>
            </select>
          </div>
          <textarea
            rows={3}
            required
            minLength={10}
            maxLength={2000}
            value={ticketDesc}
            onChange={(e) => setTicketDesc(e.target.value)}
            placeholder="Descreva o problema técnico encontrado..."
            className="w-full bg-[#0D0D10] border border-white/12 rounded px-3 py-2 text-sm text-white"
          />
          <button
            type="submit"
            className="px-4 py-2 bg-[#DC172B] hover:bg-[#EF3340] text-xs font-semibold text-white rounded"
          >
            Enviar ticket
          </button>
        </form>

        <div className="bg-[#15151A] border border-white/8 rounded-lg p-5 space-y-3">
          <h2 className="text-base font-bold text-white">Tickets Registrados ({tickets.length})</h2>
          {tickets.length === 0 ? (
            <p className="text-xs text-[#71717A]">Nenhum ticket técnico registrado.</p>
          ) : (
            <div className="space-y-2.5 max-h-72 overflow-y-auto">
              {tickets.map((t) => (
                <div key={t.id} className="bg-[#0D0D10] border border-white/8 rounded p-3 space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-semibold text-white">{t.subject}</span>
                    <span className="text-[#EF3340]">{t.status}</span>
                  </div>
                  <p className="text-xs text-[#A1A1AA]">{t.description}</p>
                  {capabilities.isAnyAdmin && t.status !== 'resolvido' && (
                    <button
                      type="button"
                      onClick={() =>
                        void updateDoc(doc(db, 'supportTickets', t.id), {
                          status: 'resolvido',
                          updatedAt: serverTimestamp(),
                        })
                      }
                      className="text-[11px] text-[#EF3340] hover:underline pt-1"
                    >
                      Marcar como resolvido
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Modal de Reautenticação Recente para Ações Críticas */}
      {criticalAction && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
        >
          <form
            onSubmit={executeCriticalAdminAction}
            className="w-full max-w-md bg-[#15151A] border border-[#DC172B] rounded-lg p-6 space-y-4"
          >
            <div className="flex items-center gap-2.5 text-[#EF3340]">
              {criticalAction.type === 'rotate_password' ? (
                <KeyRound className="w-5 h-5" />
              ) : (
                <ShieldAlert className="w-5 h-5" />
              )}
              <h3 className="text-lg font-bold text-white">Confirmação Crítica e Reautenticação</h3>
            </div>
            <p className="text-xs text-[#A1A1AA] leading-relaxed">
              Você está prestes a{' '}
              <strong className="text-white">
                {criticalAction.type === 'promote_primary'
                  ? `promover ${criticalAction.targetUser.displayName} a Administrador Principal`
                  : criticalAction.type === 'revoke_primary'
                    ? `remover ${criticalAction.targetUser.displayName} da lista de Administradores Principais`
                    : `rotacionar a senha e revogar sessões antigas de ${criticalAction.targetUser.displayName}`}
              </strong>
              . Esta ação exige reautenticação recente e execução autorizada no servidor.
            </p>
            {criticalAction.type === 'rotate_password' && (
              <input
                type="password"
                minLength={8}
                value={newRotatedPassword}
                onChange={(e) => setNewRotatedPassword(e.target.value)}
                placeholder="Nova senha (deixe em branco para gerar aleatória)"
                className="w-full bg-[#0D0D10] border border-white/12 rounded px-3 py-2 text-sm text-white"
              />
            )}
            <input
              type="password"
              required
              value={reauthPassword}
              onChange={(e) => setReauthPassword(e.target.value)}
              placeholder="Confirme sua senha atual de administrador"
              className="w-full bg-[#0D0D10] border border-white/12 rounded px-3 py-2 text-sm text-white"
            />
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setCriticalAction(null)}
                className="px-4 py-2 bg-[#202027] text-xs font-medium rounded"
              >
                Cancelar
              </button>
              <button
                type="submit"
                className="px-4 py-2 bg-[#DC172B] hover:bg-[#EF3340] text-xs font-semibold text-white rounded"
              >
                Reautenticar e confirmar
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
