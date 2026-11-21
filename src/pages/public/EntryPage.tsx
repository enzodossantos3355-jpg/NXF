import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  AlertCircle,
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Hash,
  KeyRound,
  Lock,
  Search,
  Shield,
  User,
  UserPlus,
  Users,
} from 'lucide-react';
import {
  collection,
  onSnapshot,
  orderBy,
  query,
  where,
} from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { apiFetch } from '../../lib/apiClient';
import { useAuth } from '../../context/AuthContext';
import { EmptyState, LoadingSkeleton } from '../../components/common/StateViews';
import { BLUEPRINT_LIMITS, type PublicProfile } from '../../types/nxf';

type AuthMode = 'login' | 'register';

const PAGE_SIZE = 8;

interface BootstrapStatusResponse {
  needsBootstrap: boolean;
  adminSdkConfigured: boolean;
  bootstrapSecretConfigured: boolean;
}

export function EntryPage() {
  const {
    firebaseUser,
    capabilities,
    signInWithCode,
    signInWithProfile,
    registerWithCode,
  } = useAuth();
  const navigate = useNavigate();

  const [profiles, setProfiles] = useState<PublicProfile[]>([]);
  const [loadingProfiles, setLoadingProfiles] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [page, setPage] = useState(1);

  // Selecionar avatar abre apenas o diálogo de autenticação; nunca autentica sem credencial
  const [selectedProfile, setSelectedProfile] = useState<PublicProfile | null>(null);
  const [showOtherAccountForm, setShowOtherAccountForm] = useState(false);
  const [mode, setMode] = useState<AuthMode>('login');

  const [fullName, setFullName] = useState('');
  const [nick, setNick] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  // Bootstrap seguro do primeiro administrador pelo backend (somente quando não houver nenhum ativo)
  const [bootstrapStatus, setBootstrapStatus] = useState<BootstrapStatusResponse | null>(null);
  const [showBootstrapModal, setShowBootstrapModal] = useState(false);
  const [bootstrapSecret, setBootstrapSecret] = useState('');
  const [bootstrapName, setBootstrapName] = useState('');
  const [bootstrapNick, setBootstrapNick] = useState('Administrador');
  const [bootstrapCode, setBootstrapCode] = useState('');
  const [bootstrapPassword, setBootstrapPassword] = useState('');
  const [bootstrapLoading, setBootstrapLoading] = useState(false);
  const [bootstrapError, setBootstrapError] = useState('');
  const [bootstrapSuccess, setBootstrapSuccess] = useState('');

  useEffect(() => {
    const q = query(
      collection(db, 'publicProfiles'),
      where('isActiveMember', '==', true),
      where('showInEntrySelector', '==', true),
      where('moderationStatus', '==', 'approved'),
      orderBy('nickname', 'asc')
    );

    const unsub = onSnapshot(
      q,
      (snap) => {
        setProfiles(
          snap.docs.map((d) => ({ ...(d.data() as PublicProfile), uid: d.id }))
        );
        setLoadingProfiles(false);
      },
      () => {
        setProfiles([]);
        setLoadingProfiles(false);
      }
    );

    return () => unsub();
  }, []);

  useEffect(() => {
    void apiFetch<BootstrapStatusResponse>('/api/admin/bootstrap-status', {
      requireAuth: false,
    })
      .then((res) => setBootstrapStatus(res))
      .catch(() => setBootstrapStatus(null));
  }, []);

  const filteredProfiles = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    if (!q) return profiles;
    return profiles.filter(
      (p) =>
        p.nickname.toLowerCase().includes(q) ||
        p.publicRole.toLowerCase().includes(q)
    );
  }, [profiles, searchTerm]);

  const totalPages = Math.max(1, Math.ceil(filteredProfiles.length / PAGE_SIZE));
  const paginatedProfiles = filteredProfiles.slice(
    (page - 1) * PAGE_SIZE,
    page * PAGE_SIZE
  );

  const mapAuthError = (err: unknown): string => {
    const errCode = (err as { code?: string })?.code || '';
    if (errCode === 'auth/operation-not-allowed') {
      return 'O motor de autenticação por senha (E-mail/Senha) ainda não foi habilitado no Firebase Console deste projeto (Authentication → Sign-in method → E-mail/senha). Habilite-o no console para liberar o acesso.';
    }
    if (
      errCode === 'auth/invalid-credential' ||
      errCode === 'auth/wrong-password' ||
      errCode === 'auth/user-not-found'
    ) {
      return 'Code ou senha inválidos. Verifique os dados informados.';
    }
    if (errCode === 'auth/email-already-in-use') {
      return 'Este Code já possui conta cadastrada. Faça login usando seu Code e Senha.';
    }
    if (errCode === 'auth/weak-password') {
      return 'A senha precisa ter pelo menos 6 caracteres.';
    }
    return err instanceof Error ? err.message : 'Falha na autenticação.';
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg('');
    setSubmitting(true);

    try {
      if (selectedProfile) {
        const result = await signInWithProfile(selectedProfile.uid, password);
        navigate(result.isOfficialMember ? '/painel' : '/minha-conta');
      } else if (mode === 'login') {
        const result = await signInWithCode(code, password);
        navigate(result.isOfficialMember ? '/painel' : '/minha-conta');
      } else {
        await registerWithCode({ fullName, nick, code, password });
        navigate('/minha-conta');
      }
    } catch (err) {
      setErrorMsg(mapAuthError(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleBootstrapSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBootstrapError('');
    setBootstrapSuccess('');
    setBootstrapLoading(true);
    try {
      const res = await apiFetch<{ ok: boolean; code: string; message: string }>(
        '/api/admin/bootstrap',
        {
          method: 'POST',
          requireAuth: false,
          body: {
            bootstrapSecret,
            fullName: bootstrapName,
            nick: bootstrapNick,
            code: bootstrapCode,
            password: bootstrapPassword,
          },
        }
      );
      setBootstrapSuccess(`${res.message} Fazendo login...`);
      const signInRes = await signInWithCode(res.code, bootstrapPassword);
      setShowBootstrapModal(false);
      navigate(signInRes.isOfficialMember ? '/painel' : '/minha-conta');
    } catch (err) {
      setBootstrapError(
        err instanceof Error ? err.message : 'Não foi possível provisionar o administrador.'
      );
    } finally {
      setBootstrapLoading(false);
    }
  };

  const authPanelActive = Boolean(selectedProfile) || showOtherAccountForm;

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-10 space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 border-b border-white/8 pb-6">
        <div className="space-y-1.5">
          <p className="text-xs font-semibold text-[#EF3340] uppercase tracking-wider">
            Acesso Institucional
          </p>
          <h1 className="font-display text-3xl sm:text-4xl font-bold text-white">
            Entrada de Membros e Contas
          </h1>
          <p className="text-sm text-[#A1A1AA] max-w-2xl">
            Selecione um perfil da organização para entrar informando apenas sua senha, ou utilize Outra conta / Criar conta para visitantes e candidatos.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3 shrink-0">
          {firebaseUser && (
            <Link
              to={capabilities.isOfficialMember ? '/painel' : '/minha-conta'}
              className="px-4 py-2 bg-[#202027] hover:bg-[#2B2B35] border border-white/10 text-xs font-semibold rounded-md whitespace-nowrap"
            >
              {capabilities.isOfficialMember ? 'Ir ao meu painel' : 'Minha conta'}
            </Link>
          )}
          <button
            type="button"
            onClick={() => {
              setSelectedProfile(null);
              setShowOtherAccountForm(true);
              setMode('login');
              setErrorMsg('');
              setCode('');
              setPassword('');
            }}
            className="inline-flex items-center gap-2 px-4 py-2 bg-[#DC172B] hover:bg-[#EF3340] text-white text-xs font-semibold rounded-md transition-colors whitespace-nowrap"
          >
            <UserPlus className="w-4 h-4" />
            Outra conta / Criar conta
          </button>
        </div>
      </div>

      {/* Seletor visual de perfis */}
      {!authPanelActive && (
        <div className="space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="relative w-full sm:max-w-sm">
              <Search className="w-4 h-4 text-[#71717A] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="search"
                value={searchTerm}
                onChange={(e) => {
                  setSearchTerm(e.target.value);
                  setPage(1);
                }}
                placeholder="Buscar perfil por nome ou cargo..."
                className="w-full bg-[#15151A] border border-white/10 rounded-md pl-9 pr-3 py-2 text-sm text-white placeholder:text-[#71717A] focus:border-[#DC172B] focus:outline-none"
              />
            </div>
            <p className="text-xs text-[#A1A1AA] font-mono-tabular">
              {filteredProfiles.length}{' '}
              {filteredProfiles.length === 1
                ? 'perfil visível'
                : 'perfis visíveis'}
            </p>
          </div>

          {loadingProfiles && profiles.length === 0 ? (
            <LoadingSkeleton rows={2} />
          ) : null}

          {!loadingProfiles && paginatedProfiles.length === 0 ? (
            <EmptyState
              title="Nenhum perfil oficial publicado no seletor"
              description="Utilize Outra conta / Criar conta para entrar com seu Code e Senha."
            />
          ) : (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
                {paginatedProfiles.map((profile) => {
                  const isAdminProfile =
                    profile.publicRole === 'Administração NXF' ||
                    profile.publicRole === 'Administrador Principal';
                  return (
                    <button
                      key={profile.uid}
                      type="button"
                      onClick={() => {
                        setSelectedProfile(profile);
                        setShowOtherAccountForm(false);
                        setMode('login');
                        setCode('');
                        setPassword('');
                        setErrorMsg('');
                      }}
                      className="group bg-[#15151A] hover:bg-[#202027] border border-white/8 hover:border-[#DC172B]/70 rounded-lg p-5 text-left transition-colors flex flex-col items-center text-center gap-3"
                    >
                      {profile.avatarUrl ? (
                        <img
                          src={profile.avatarUrl}
                          alt={profile.nickname || profile.publicRole}
                          referrerPolicy="no-referrer"
                          className="w-20 h-20 rounded-full object-cover border border-white/10"
                        />
                      ) : (
                        <div className="w-20 h-20 rounded-full bg-[#202027] border border-white/10 flex items-center justify-center">
                          {isAdminProfile ? (
                            <Shield className="w-8 h-8 text-[#EF3340]" />
                          ) : (
                            <Users className="w-7 h-7 text-[#A1A1AA]" />
                          )}
                        </div>
                      )}
                      <div className="space-y-0.5 min-w-0 w-full">
                        <p className="text-sm font-bold text-white truncate">
                          {profile.nickname}
                        </p>
                        <p className="text-xs text-[#A1A1AA] truncate">
                          {profile.publicRole}
                        </p>
                      </div>
                    </button>
                  );
                })}
              </div>

              {totalPages > 1 && (
                <div className="flex items-center justify-center gap-3 pt-2">
                  <button
                    type="button"
                    disabled={page <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    className="p-2 rounded bg-[#15151A] border border-white/10 disabled:opacity-40"
                    aria-label="Página anterior"
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  <span className="text-xs font-mono-tabular text-[#A1A1AA]">
                    Página {page} de {totalPages}
                  </span>
                  <button
                    type="button"
                    disabled={page >= totalPages}
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    className="p-2 rounded bg-[#15151A] border border-white/10 disabled:opacity-40"
                    aria-label="Próxima página"
                  >
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              )}
            </>
          )}

          {bootstrapStatus?.needsBootstrap && (
            <div className="bg-[#15151A] border border-[#DC172B]/40 rounded-lg p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="space-y-0.5">
                <p className="text-xs font-semibold text-white flex items-center gap-2">
                  <Shield className="w-4 h-4 text-[#EF3340]" />
                  Nenhum Administrador Principal ativo encontrado
                </p>
                <p className="text-xs text-[#A1A1AA]">
                  {bootstrapStatus.bootstrapSecretConfigured
                    ? 'Configure o primeiro Administrador Principal com a chave BOOTSTRAP_ADMIN_SECRET definida no servidor.'
                    : 'Defina BOOTSTRAP_ADMIN_SECRET no backend Render ou execute scripts/bootstrap-admin.mjs com Firebase Admin SDK.'}
                </p>
              </div>
              {bootstrapStatus.bootstrapSecretConfigured && (
                <button
                  type="button"
                  onClick={() => {
                    setBootstrapError('');
                    setBootstrapSuccess('');
                    setShowBootstrapModal(true);
                  }}
                  className="px-4 py-2 bg-[#DC172B] hover:bg-[#EF3340] text-white text-xs font-semibold rounded-md whitespace-nowrap"
                >
                  Configurar primeiro administrador
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Formulário de autenticação */}
      {authPanelActive && (
        <div className="max-w-md mx-auto bg-[#15151A] border border-white/10 rounded-lg p-6 space-y-5">
          <button
            type="button"
            onClick={() => {
              setSelectedProfile(null);
              setShowOtherAccountForm(false);
              setErrorMsg('');
            }}
            className="inline-flex items-center gap-1.5 text-xs text-[#A1A1AA] hover:text-white"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Voltar ao seletor de perfis
          </button>

          {selectedProfile ? (
            <div className="flex items-center gap-3.5 pb-4 border-b border-white/8">
              {selectedProfile.avatarUrl ? (
                <img
                  src={selectedProfile.avatarUrl}
                  alt={selectedProfile.nickname || selectedProfile.publicRole}
                  referrerPolicy="no-referrer"
                  className="w-12 h-12 rounded-full object-cover border border-white/10"
                />
              ) : (
                <div className="w-12 h-12 rounded-full bg-[#202027] flex items-center justify-center font-bold text-white">
                  {selectedProfile.nickname.slice(0, 1).toUpperCase()}
                </div>
              )}
              <div>
                <h2 className="text-lg font-bold text-white">
                  {selectedProfile.nickname}
                </h2>
                <p className="text-xs text-[#A1A1AA]">
                  {selectedProfile.publicRole} · Digite apenas sua senha para entrar
                </p>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2 border-b border-white/8 pb-3">
              <button
                type="button"
                onClick={() => {
                  setMode('login');
                  setErrorMsg('');
                }}
                className={`px-3 py-1.5 text-xs font-semibold rounded ${
                  mode === 'login' ? 'bg-[#DC172B] text-white' : 'text-[#A1A1AA] hover:text-white'
                }`}
              >
                Entrar com Code
              </button>
              <button
                type="button"
                onClick={() => {
                  setMode('register');
                  setErrorMsg('');
                }}
                className={`px-3 py-1.5 text-xs font-semibold rounded ${
                  mode === 'register'
                    ? 'bg-[#DC172B] text-white'
                    : 'text-[#A1A1AA] hover:text-white'
                }`}
              >
                Criar conta
              </button>
            </div>
          )}

          {errorMsg && (
            <div className="p-3 rounded bg-[#DC172B]/15 border border-[#DC172B]/50 flex items-start gap-2 text-xs text-white">
              <AlertCircle className="w-4 h-4 text-[#EF3340] shrink-0 mt-0.5" />
              <span>{errorMsg}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            {mode === 'register' && !selectedProfile && (
              <>
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-[#A1A1AA]">
                    Nome completo (coleta privada de cadastro)
                  </label>
                  <div className="relative">
                    <User className="w-4 h-4 text-[#71717A] absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      required
                      minLength={2}
                      maxLength={BLUEPRINT_LIMITS.FULL_NAME_MAX}
                      value={fullName}
                      onChange={(e) => setFullName(e.target.value)}
                      placeholder="Seu nome completo"
                      className="w-full bg-[#0D0D10] border border-white/12 rounded-md pl-9 pr-3 py-2 text-sm text-white focus:border-[#DC172B] focus:outline-none"
                    />
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-[#A1A1AA]">
                    Nick (apelido no jogo / organização)
                  </label>
                  <input
                    type="text"
                    required
                    minLength={2}
                    maxLength={BLUEPRINT_LIMITS.DISPLAY_NAME_MAX}
                    value={nick}
                    onChange={(e) => setNick(e.target.value)}
                    placeholder="Ex.: FuryPlayer"
                    className="w-full bg-[#0D0D10] border border-white/12 rounded-md px-3 py-2 text-sm text-white focus:border-[#DC172B] focus:outline-none"
                  />
                </div>
              </>
            )}

            {!selectedProfile && (
              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-[#A1A1AA]">
                  Code (Tag Brawl Stars ou código da conta)
                </label>
                <div className="relative">
                  <Hash className="w-4 h-4 text-[#71717A] absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    required
                    minLength={3}
                    maxLength={BLUEPRINT_LIMITS.CODE_MAX}
                    value={code}
                    onChange={(e) => setCode(e.target.value.toUpperCase())}
                    placeholder="#ABC1234"
                    className="w-full bg-[#0D0D10] border border-white/12 rounded-md pl-9 pr-3 py-2 text-sm font-mono-tabular uppercase text-white focus:border-[#DC172B] focus:outline-none"
                  />
                </div>
              </div>
            )}

            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-[#A1A1AA]">
                Senha
              </label>
              <div className="relative">
                <Lock className="w-4 h-4 text-[#71717A] absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="password"
                  required
                  minLength={6}
                  autoFocus={Boolean(selectedProfile)}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full bg-[#0D0D10] border border-white/12 rounded-md pl-9 pr-3 py-2 text-sm text-white focus:border-[#DC172B] focus:outline-none"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="w-full py-2.5 bg-[#DC172B] hover:bg-[#EF3340] disabled:opacity-50 text-white text-sm font-semibold rounded-md transition-colors"
            >
              {submitting
                ? 'Processando...'
                : mode === 'register' && !selectedProfile
                  ? 'Cadastrar conta'
                  : 'Entrar'}
            </button>
          </form>

          <p className="text-[11px] text-[#71717A] leading-relaxed">
            {selectedProfile
              ? `Perfil selecionado: ${selectedProfile.nickname}. Informe apenas sua senha para autenticar neste perfil.`
              : mode === 'register'
                ? 'O cadastro público cria uma conta básica de candidato/visitante usando Nome, Nick, Code e Senha. Contas básicas não têm acesso ao painel administrativo.'
                : 'Informe seu Code e senha para autenticar uma conta não exibida na grade de perfis.'}
          </p>
        </div>
      )}

      {/* Modal seguro de configuração inicial do primeiro Administrador Principal */}
      {showBootstrapModal && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
        >
          <form
            onSubmit={handleBootstrapSubmit}
            className="w-full max-w-md bg-[#15151A] border border-[#DC172B] rounded-lg p-6 space-y-4"
          >
            <div className="flex items-center gap-2 text-[#EF3340]">
              <KeyRound className="w-5 h-5" />
              <h3 className="text-lg font-bold text-white">
                Provisionar Primeiro Administrador
              </h3>
            </div>
            <p className="text-xs text-[#A1A1AA] leading-relaxed">
              Esta ação valida a chave <code className="text-white">BOOTSTRAP_ADMIN_SECRET</code> diretamente no servidor e bloqueia novos bootstraps após criar o primeiro Administrador Principal.
            </p>

            {bootstrapError && (
              <div className="p-2.5 bg-[#DC172B]/15 border border-[#DC172B]/50 rounded text-xs text-white">
                {bootstrapError}
              </div>
            )}
            {bootstrapSuccess && (
              <div className="p-2.5 bg-[#202027] border border-white/15 rounded text-xs text-white">
                {bootstrapSuccess}
              </div>
            )}

            <input
              type="password"
              required
              value={bootstrapSecret}
              onChange={(e) => setBootstrapSecret(e.target.value)}
              placeholder="Chave BOOTSTRAP_ADMIN_SECRET"
              className="w-full bg-[#0D0D10] border border-white/12 rounded px-3 py-2 text-sm text-white"
            />
            <input
              type="text"
              required
              minLength={2}
              value={bootstrapName}
              onChange={(e) => setBootstrapName(e.target.value)}
              placeholder="Nome completo"
              className="w-full bg-[#0D0D10] border border-white/12 rounded px-3 py-2 text-sm text-white"
            />
            <div className="grid grid-cols-2 gap-2">
              <input
                type="text"
                required
                minLength={2}
                value={bootstrapNick}
                onChange={(e) => setBootstrapNick(e.target.value)}
                placeholder="Nick"
                className="bg-[#0D0D10] border border-white/12 rounded px-3 py-2 text-sm text-white"
              />
              <input
                type="text"
                required
                minLength={3}
                value={bootstrapCode}
                onChange={(e) => setBootstrapCode(e.target.value.toUpperCase())}
                placeholder="Code (#NXF001)"
                className="bg-[#0D0D10] border border-white/12 rounded px-3 py-2 text-sm font-mono-tabular uppercase text-white"
              />
            </div>
            <input
              type="password"
              required
              minLength={8}
              value={bootstrapPassword}
              onChange={(e) => setBootstrapPassword(e.target.value)}
              placeholder="Senha forte (mínimo 8 caracteres)"
              className="w-full bg-[#0D0D10] border border-white/12 rounded px-3 py-2 text-sm text-white"
            />

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowBootstrapModal(false)}
                className="px-4 py-2 bg-[#202027] text-xs font-medium text-white rounded"
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={bootstrapLoading}
                className="px-4 py-2 bg-[#DC172B] hover:bg-[#EF3340] disabled:opacity-50 text-xs font-semibold text-white rounded"
              >
                {bootstrapLoading ? 'Provisionando...' : 'Confirmar e entrar'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
