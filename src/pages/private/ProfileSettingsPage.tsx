import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink, Image as ImageIcon, KeyRound, Save, Trash2, Upload } from 'lucide-react';
import { doc, serverTimestamp, updateDoc } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../../lib/firebase';
import { apiFetch, compressImageToDataUrl } from '../../lib/apiClient';
import { useAuth } from '../../context/AuthContext';
import { SafeImage } from '../../components/common/BrandMark';
import { BLUEPRINT_LIMITS, type ProfileLayout } from '../../types/nxf';

const MAX_PROFILE_IMAGE_BYTES = 5 * 1024 * 1024;

function extractOwnedMediaId(url: string): string | null {
  const match = /\/api\/media\/([a-zA-Z0-9_-]{3,128})(?:[?#].*)?$/.exec(url.trim());
  return match ? match[1] : null;
}

export function ProfileSettingsPage() {
  const { firebaseUser, userDoc, publicProfile, capabilities, changePassword } = useAuth();

  const [fullName, setFullName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [brawlTag, setBrawlTag] = useState('');
  const [bio, setBio] = useState('');
  const [avatarUrl, setAvatarUrl] = useState('');
  const [bannerUrl, setBannerUrl] = useState('');
  const [layout, setLayout] = useState<ProfileLayout>('classic');
  const [showInEntrySelector, setShowInEntrySelector] = useState(true);
  const [socialLinks, setSocialLinks] = useState({
    twitter: '',
    instagram: '',
    youtube: '',
    twitch: '',
    discord: '',
  });

  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState<'avatar' | 'banner' | null>(null);
  const [statusMsg, setStatusMsg] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [changingPass, setChangingPass] = useState(false);

  useEffect(() => {
    setFullName(userDoc?.fullName || '');
    setDisplayName(userDoc?.displayName || firebaseUser?.displayName || '');
    setBrawlTag(publicProfile?.brawlTag || userDoc?.brawlTag || '');
    setBio(publicProfile?.bio || '');
    setAvatarUrl(publicProfile?.avatarUrl || '');
    setBannerUrl(publicProfile?.bannerUrl || '');
    setLayout(publicProfile?.layout || 'classic');
    setShowInEntrySelector(publicProfile?.showInEntrySelector ?? true);
    setSocialLinks({
      twitter: publicProfile?.socialLinks?.twitter || '',
      instagram: publicProfile?.socialLinks?.instagram || '',
      youtube: publicProfile?.socialLinks?.youtube || '',
      twitch: publicProfile?.socialLinks?.twitch || '',
      discord: publicProfile?.socialLinks?.discord || '',
    });
  }, [userDoc, publicProfile, firebaseUser]);

  const handleImageUpload = async (
    file: File | undefined,
    kind: 'avatar' | 'banner'
  ) => {
    if (!file || !firebaseUser) return;
    setErrorMsg('');
    setStatusMsg('');
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setErrorMsg('Envie apenas imagens JPG, PNG ou WebP.');
      return;
    }
    if (file.size > MAX_PROFILE_IMAGE_BYTES) {
      setErrorMsg('A imagem deve ter no máximo 5 MB antes da otimização.');
      return;
    }

    setUploading(kind);
    try {
      const maxDim = kind === 'avatar' ? 720 : 1600;
      const dataUrl = await compressImageToDataUrl(file, maxDim, 420 * 1024);
      const previousUrl = kind === 'avatar' ? avatarUrl : bannerUrl;
      const res = await apiFetch<{ url: string }>('/api/uploads/profile', {
        method: 'POST',
        body: {
          dataUrl,
          fileName: file.name.slice(0, 80),
          kind,
          replaceMediaUrl: previousUrl || undefined,
        },
      });
      if (kind === 'avatar') setAvatarUrl(res.url);
      else setBannerUrl(res.url);
      setStatusMsg(
        `${kind === 'avatar' ? 'Foto de perfil' : 'Banner'} otimizado e enviado com segurança. Clique em "Salvar alterações" para aplicar.`
      );
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? `Falha no envio da imagem: ${err.message}`
          : 'Erro ao enviar arquivo.'
      );
    } finally {
      setUploading(null);
    }
  };

  const handleRemoveImage = async (kind: 'avatar' | 'banner') => {
    setErrorMsg('');
    setStatusMsg('');
    const currentUrl = kind === 'avatar' ? avatarUrl : bannerUrl;
    const mediaId = extractOwnedMediaId(currentUrl);
    if (mediaId) {
      await apiFetch(`/api/media/${mediaId}`, { method: 'DELETE' }).catch(() => undefined);
    }
    if (kind === 'avatar') setAvatarUrl('');
    else setBannerUrl('');
    setStatusMsg(
      `${kind === 'avatar' ? 'Foto de perfil' : 'Banner'} removido. Clique em "Salvar alterações" para confirmar.`
    );
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firebaseUser) return;

    setSaving(true);
    setErrorMsg('');
    setStatusMsg('');

    const cleanTag = brawlTag.trim().toUpperCase().slice(0, BLUEPRINT_LIMITS.BRAWL_TAG_MAX);
    const cleanFullName = fullName.trim().slice(0, BLUEPRINT_LIMITS.FULL_NAME_MAX);
    const cleanName = displayName.trim().slice(0, BLUEPRINT_LIMITS.DISPLAY_NAME_MAX);

    try {
      await updateDoc(doc(db, 'users', firebaseUser.uid), {
        fullName: cleanFullName,
        displayName: cleanName,
        brawlTag: cleanTag,
        brawlTagStatus:
          cleanTag && cleanTag !== userDoc?.brawlTag
            ? 'pending'
            : userDoc?.brawlTagStatus || 'none',
        updatedAt: serverTimestamp(),
      });

      if (publicProfile) {
        const tagChanged = cleanTag !== (publicProfile.brawlTag || '');
        await updateDoc(doc(db, 'publicProfiles', firebaseUser.uid), {
          avatarUrl: avatarUrl.trim().slice(0, BLUEPRINT_LIMITS.URL_MAX),
          bannerUrl: bannerUrl.trim().slice(0, BLUEPRINT_LIMITS.URL_MAX),
          bio: bio.trim().slice(0, BLUEPRINT_LIMITS.BIO_MAX),
          layout,
          showInEntrySelector,
          brawlTag: cleanTag,
          ...(tagChanged ? { brawlTagApproved: false } : {}),
          socialLinks,
          updatedAt: serverTimestamp(),
        });
      }

      setStatusMsg('Configurações salvas com sucesso.');
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `users/${firebaseUser.uid}`);
    } finally {
      setSaving(false);
    }
  };

  const handlePasswordChange = async (e: React.FormEvent) => {
    e.preventDefault();
    setChangingPass(true);
    setStatusMsg('');
    setErrorMsg('');
    try {
      await changePassword(currentPassword, newPassword);
      setCurrentPassword('');
      setNewPassword('');
      setStatusMsg('Senha da conta alterada com sucesso.');
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : 'Não foi possível alterar a senha. Verifique a senha atual.'
      );
    } finally {
      setChangingPass(false);
    }
  };

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-white/8 pb-4">
        <div>
          <h1 className="font-display text-3xl font-bold text-white">Meu Perfil</h1>
          <p className="text-xs text-[#A1A1AA]">
            Personalize sua apresentação mantendo as cores oficiais NXF. Imagens são enviadas diretamente para o servidor com validação e otimização automática.
          </p>
        </div>
        {publicProfile && (
          <Link
            to={`/membro/${firebaseUser?.uid}`}
            className="inline-flex items-center gap-1.5 px-3 py-2 bg-[#15151A] border border-white/10 rounded-md text-xs font-medium text-white hover:bg-[#202027] shrink-0"
          >
            Ver perfil público
            <ExternalLink className="w-3.5 h-3.5" />
          </Link>
        )}
      </div>

      {statusMsg && (
        <div className="p-3 bg-[#15151A] border border-white/15 rounded text-xs text-white">
          {statusMsg}
        </div>
      )}
      {errorMsg && (
        <div className="p-3 bg-[#DC172B]/15 border border-[#DC172B]/50 rounded text-xs text-white">
          {errorMsg}
        </div>
      )}

      <form onSubmit={handleSave} className="space-y-6 bg-[#15151A] border border-white/8 rounded-lg p-6">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-[#A1A1AA]">
              Nome completo (privado)
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
              Nick da conta
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
              Code da conta / Tag Brawl Stars
            </label>
            <input
              type="text"
              maxLength={BLUEPRINT_LIMITS.BRAWL_TAG_MAX}
              value={brawlTag}
              onChange={(e) => setBrawlTag(e.target.value)}
              placeholder="#ABC123"
              className="w-full bg-[#0D0D10] border border-white/12 rounded-md px-3 py-2 text-sm font-mono-tabular text-white focus:border-[#DC172B] focus:outline-none"
            />
            <p className="text-[11px] text-[#71717A] font-mono-tabular">
              Code: {userDoc?.code || '—'} · Status Tag: {userDoc?.brawlTagStatus || 'none'}
            </p>
          </div>
        </div>

        {publicProfile ? (
          <>
            {/* Upload direto de Avatar e Banner (sem campos de URL externa) */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 pt-4 border-t border-white/8">
              <div className="bg-[#0D0D10] border border-white/8 rounded-md p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-white">Foto de Perfil (Avatar)</span>
                  <span className="text-[11px] text-[#71717A]">JPG, PNG ou WebP · até 5 MB</span>
                </div>
                <div className="flex items-center gap-4">
                  <SafeImage
                    src={avatarUrl}
                    alt={displayName || 'Avatar'}
                    className="w-16 h-16 rounded-lg object-cover border border-white/12 bg-[#15151A] shrink-0"
                    fallbackLabel={displayName || 'NXF'}
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#202027] hover:bg-[#2B2B35] border border-white/10 rounded text-xs font-medium text-white cursor-pointer">
                      <Upload className="w-3.5 h-3.5" />
                      {uploading === 'avatar'
                        ? 'Otimizando...'
                        : avatarUrl
                          ? 'Trocar foto'
                          : 'Enviar foto'}
                      <input
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        className="hidden"
                        disabled={uploading !== null}
                        onChange={(e) => {
                          void handleImageUpload(e.target.files?.[0], 'avatar');
                          e.target.value = '';
                        }}
                      />
                    </label>
                    {avatarUrl && (
                      <button
                        type="button"
                        onClick={() => void handleRemoveImage('avatar')}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-[#15151A] hover:bg-[#DC172B]/20 border border-white/10 rounded text-xs text-[#A1A1AA] hover:text-white"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        Remover
                      </button>
                    )}
                  </div>
                </div>
              </div>

              <div className="bg-[#0D0D10] border border-white/8 rounded-md p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-white">Banner do Perfil</span>
                  <span className="text-[11px] text-[#71717A]">16:9 recomendado · até 5 MB</span>
                </div>
                <div className="relative h-16 w-full rounded-md overflow-hidden border border-white/10 bg-[#15151A] flex items-center justify-center">
                  {bannerUrl ? (
                    <SafeImage
                      src={bannerUrl}
                      alt="Prévia do banner"
                      className="w-full h-full object-cover"
                      fallbackLabel="Banner"
                    />
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-[11px] text-[#71717A]">
                      <ImageIcon className="w-3.5 h-3.5" /> Nenhum banner enviado
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#202027] hover:bg-[#2B2B35] border border-white/10 rounded text-xs font-medium text-white cursor-pointer">
                    <Upload className="w-3.5 h-3.5" />
                    {uploading === 'banner'
                      ? 'Otimizando...'
                      : bannerUrl
                        ? 'Trocar banner'
                        : 'Enviar banner'}
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      className="hidden"
                      disabled={uploading !== null}
                      onChange={(e) => {
                        void handleImageUpload(e.target.files?.[0], 'banner');
                        e.target.value = '';
                      }}
                    />
                  </label>
                  {bannerUrl && (
                    <button
                      type="button"
                      onClick={() => void handleRemoveImage('banner')}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-[#15151A] hover:bg-[#DC172B]/20 border border-white/10 rounded text-xs text-[#A1A1AA] hover:text-white"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      Remover
                    </button>
                  )}
                </div>
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-[#A1A1AA]">
                Biografia pública ({bio.length}/{BLUEPRINT_LIMITS.BIO_MAX})
              </label>
              <textarea
                rows={3}
                maxLength={BLUEPRINT_LIMITS.BIO_MAX}
                value={bio}
                onChange={(e) => setBio(e.target.value)}
                className="w-full bg-[#0D0D10] border border-white/12 rounded-md px-3 py-2 text-sm text-white focus:border-[#DC172B] focus:outline-none"
              />
            </div>

            <div className="space-y-2">
              <label className="block text-xs font-medium text-[#A1A1AA]">
                Layout público do perfil (cores NXF preservadas)
              </label>
              <div className="grid grid-cols-3 gap-3">
                {(
                  [
                    { id: 'classic', label: 'Clássico' },
                    { id: 'competitive', label: 'Competitivo' },
                    { id: 'minimal', label: 'Minimalista' },
                  ] as const
                ).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setLayout(item.id)}
                    className={`py-2.5 px-3 rounded-md border text-xs font-semibold transition-colors ${
                      layout === item.id
                        ? 'bg-[#DC172B] border-[#DC172B] text-white'
                        : 'bg-[#0D0D10] border-white/10 text-[#A1A1AA] hover:text-white'
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t border-white/8">
              {(['instagram', 'twitter', 'youtube', 'twitch', 'discord'] as const).map((net) => (
                <div key={net} className="space-y-1">
                  <label className="block text-[11px] font-medium text-[#A1A1AA] capitalize">
                    {net}
                  </label>
                  <input
                    type="text"
                    maxLength={200}
                    value={socialLinks[net]}
                    onChange={(e) =>
                      setSocialLinks((prev) => ({ ...prev, [net]: e.target.value }))
                    }
                    placeholder={`Link ou usuário ${net}`}
                    className="w-full bg-[#0D0D10] border border-white/12 rounded-md px-3 py-1.5 text-xs text-white"
                  />
                </div>
              ))}
            </div>

            <label className="flex items-center gap-2.5 text-xs text-white pt-2">
              <input
                type="checkbox"
                checked={showInEntrySelector}
                onChange={(e) => setShowInEntrySelector(e.target.checked)}
                className="accent-[#DC172B]"
              />
              Exibir meu perfil oficial na grade visual da página Entrar
            </label>
          </>
        ) : (
          <div className="p-4 rounded bg-[#0D0D10] border border-white/8 text-xs text-[#A1A1AA]">
            {capabilities.isOfficialMember
              ? 'Seu perfil público oficial ainda está sendo preparado pela administração no NXF System.'
              : 'Contas básicas de candidatos não possuem vitrine pública nem aparecem no seletor de entrada até receberem vínculo oficial por convite.'}
          </div>
        )}

        <div className="pt-2 flex justify-end">
          <button
            type="submit"
            disabled={saving || uploading !== null}
            className="inline-flex items-center gap-2 px-5 py-2.5 bg-[#DC172B] hover:bg-[#EF3340] disabled:opacity-50 text-white text-xs font-semibold rounded-md"
          >
            <Save className="w-4 h-4" />
            {saving ? 'Salvando...' : 'Salvar alterações'}
          </button>
        </div>
      </form>

      <form
        onSubmit={handlePasswordChange}
        className="space-y-4 bg-[#15151A] border border-white/8 rounded-lg p-6"
      >
        <h2 className="text-base font-bold text-white flex items-center gap-2 border-b border-white/8 pb-3">
          <KeyRound className="w-4 h-4 text-[#EF3340]" /> Alterar Senha de Acesso
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-[#A1A1AA]">Senha atual</label>
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
        </div>
        <div className="flex justify-end">
          <button
            type="submit"
            disabled={changingPass}
            className="px-4 py-2 bg-[#202027] hover:bg-[#2B2B35] border border-white/10 disabled:opacity-50 text-xs font-semibold text-white rounded-md"
          >
            {changingPass ? 'Atualizando...' : 'Atualizar senha'}
          </button>
        </div>
      </form>
    </div>
  );
}
