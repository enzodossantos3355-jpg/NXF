import React, { useEffect, useState } from 'react';
import { Clock, Eye, Newspaper, Palette, Save, Upload } from 'lucide-react';
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
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../../lib/firebase';
import { apiFetch, compressImageToDataUrl } from '../../lib/apiClient';
import { useAuth } from '../../context/AuthContext';
import { useSiteContent } from '../../context/SiteContext';
import { BLUEPRINT_LIMITS, type NewsArticle, type Sponsor } from '../../types/nxf';

export function StudioCmsPage() {
  const { firebaseUser } = useAuth();
  const { siteContent } = useSiteContent();

  const [heroTitle, setHeroTitle] = useState(siteContent.heroTitle);
  const [heroSubtitle, setHeroSubtitle] = useState(siteContent.heroSubtitle);
  const [heroDesktopImage, setHeroDesktopImage] = useState(siteContent.heroDesktopImage || '');
  const [heroMobileImage, setHeroMobileImage] = useState(siteContent.heroMobileImage || '');
  const [brandLogoUrl, setBrandLogoUrl] = useState(siteContent.brandLogoUrl || '');
  const [aboutTitle, setAboutTitle] = useState(siteContent.aboutTitle || '');
  const [aboutBody, setAboutBody] = useState(siteContent.aboutBody || '');
  const [visibleSections, setVisibleSections] = useState<Record<string, boolean>>(
    siteContent.visibleSections || {}
  );
  const [showPreview, setShowPreview] = useState(false);

  const [newsList, setNewsList] = useState<NewsArticle[]>([]);
  const [nTitle, setNTitle] = useState('');
  const [nSummary, setNSummary] = useState('');
  const [nContent, setNContent] = useState('');
  const [nStatus, setNStatus] = useState<'draft' | 'scheduled' | 'published'>('published');
  const [nScheduleAt, setNScheduleAt] = useState('');

  const [sponsors, setSponsors] = useState<Sponsor[]>([]);
  const [spName, setSpName] = useState('');
  const [spLogo, setSpLogo] = useState('');

  const [uploadingFolder, setUploadingFolder] = useState<string | null>(null);
  const [feedback, setFeedback] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    setHeroTitle(siteContent.heroTitle);
    setHeroSubtitle(siteContent.heroSubtitle);
    setHeroDesktopImage(siteContent.heroDesktopImage || '');
    setHeroMobileImage(siteContent.heroMobileImage || '');
    setBrandLogoUrl(siteContent.brandLogoUrl || '');
    setAboutTitle(siteContent.aboutTitle || '');
    setAboutBody(siteContent.aboutBody || '');
    setVisibleSections(siteContent.visibleSections || {});
  }, [siteContent]);

  useEffect(() => {
    const u1 = onSnapshot(
      query(collection(db, 'news'), orderBy('createdAt', 'desc')),
      (s) => setNewsList(s.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<NewsArticle, 'id'>) }))),
      () => {}
    );
    const u2 = onSnapshot(
      collection(db, 'sponsors'),
      (s) => setSponsors(s.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Sponsor, 'id'>) }))),
      () => {}
    );
    return () => {
      u1();
      u2();
    };
  }, []);

  const handleUploadAsset = async (
    file: File | undefined,
    setter: (url: string) => void,
    folder: string,
    currentUrl?: string
  ) => {
    if (!file || !firebaseUser) return;
    setErrorMsg('');
    setFeedback('');
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setErrorMsg('Use apenas arquivos JPG, PNG ou WebP.');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setErrorMsg('Tamanho máximo antes da otimização: 10 MB.');
      return;
    }

    setUploadingFolder(folder);
    try {
      const dataUrl = await compressImageToDataUrl(file, 1600, 420 * 1024);
      const uploaded = await apiFetch<{ url: string }>('/api/uploads/cms', {
        method: 'POST',
        body: {
          dataUrl,
          fileName: file.name.slice(0, 80),
          folder,
          replaceMediaUrl: currentUrl || undefined,
        },
      });
      setter(uploaded.url);
      setFeedback('Mídia otimizada e salva no backend Render (compatível com Firebase Spark). Salve o portal para publicar.');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Erro ao enviar mídia.');
    } finally {
      setUploadingFolder(null);
    }
  };

  const handleSavePortal = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firebaseUser) return;
    try {
      await setDoc(doc(db, 'siteContent', 'public'), {
        heroTitle: heroTitle.trim().slice(0, BLUEPRINT_LIMITS.HERO_TITLE_MAX),
        heroSubtitle: heroSubtitle.trim().slice(0, BLUEPRINT_LIMITS.HERO_SUBTITLE_MAX),
        heroDesktopImage: heroDesktopImage.trim().slice(0, BLUEPRINT_LIMITS.URL_MAX),
        heroMobileImage: heroMobileImage.trim().slice(0, BLUEPRINT_LIMITS.URL_MAX),
        brandLogoUrl: brandLogoUrl.trim().slice(0, BLUEPRINT_LIMITS.URL_MAX),
        aboutTitle: aboutTitle.trim().slice(0, 120),
        aboutBody: aboutBody.trim().slice(0, BLUEPRINT_LIMITS.ABOUT_BODY_MAX),
        visibleSections,
        version: (siteContent.version || 0) + 1,
        updatedBy: firebaseUser.uid,
        updatedAt: serverTimestamp(),
      });
      setFeedback(`Portal publicado (versão ${(siteContent.version || 0) + 1}).`);
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'siteContent/public');
    }
  };

  const handlePublishNews = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firebaseUser || !nTitle.trim()) return;
    const slug = nTitle
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .slice(0, 100);

    try {
      await addDoc(collection(db, 'news'), {
        slug: slug || `noticia-${Date.now()}`,
        title: nTitle.trim().slice(0, BLUEPRINT_LIMITS.NEWS_TITLE_MAX),
        summary: nSummary.trim().slice(0, BLUEPRINT_LIMITS.NEWS_SUMMARY_MAX),
        content: nContent.trim().slice(0, BLUEPRINT_LIMITS.NEWS_CONTENT_MAX),
        category: 'Comunicado',
        status: nStatus,
        publishedAt:
          nStatus === 'scheduled' && nScheduleAt
            ? Timestamp.fromDate(new Date(nScheduleAt))
            : serverTimestamp(),
        authorUid: firebaseUser.uid,
        authorName: firebaseUser.displayName || 'Redação NXF',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      setNTitle('');
      setNSummary('');
      setNContent('');
      setFeedback(
        nStatus === 'scheduled'
          ? 'Matéria agendada. O agendador do backend Render verifica publicações pendentes automaticamente a cada 15 minutos.'
          : 'Matéria salva com sucesso.'
      );
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, 'news');
    }
  };

  const handlePublishDueScheduled = async () => {
    setErrorMsg('');
    try {
      const res = await apiFetch<{ publishedCount: number }>('/api/cms/publish-scheduled', {
        method: 'POST',
      });
      setFeedback(
        res.publishedCount > 0
          ? `${res.publishedCount} matéria(s) agendada(s) publicada(s) agora.`
          : 'Nenhuma matéria agendada vencida para publicação no momento.'
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Erro ao executar agendador de notícias.');
    }
  };

  const handleAddSponsor = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!spName.trim()) return;
    try {
      await addDoc(collection(db, 'sponsors'), {
        name: spName.trim().slice(0, 80),
        logoUrl: spLogo.trim().slice(0, BLUEPRINT_LIMITS.URL_MAX),
        active: true,
        createdAt: serverTimestamp(),
      });
      setSpName('');
      setSpLogo('');
      setFeedback('Patrocinador cadastrado.');
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, 'sponsors');
    }
  };

  return (
    <div className="space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-white/8 pb-4">
        <div>
          <h1 className="font-display text-3xl font-bold text-white">NXF Studio (CMS)</h1>
          <p className="text-xs text-[#A1A1AA]">
            Edição de banners desktop/mobile, marca NXF, visibilidade das seções, notícias e patrocinadores. Versão atual: {siteContent.version}.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void handlePublishDueScheduled()}
            className="inline-flex items-center gap-1.5 px-3 py-2 bg-[#15151A] border border-white/10 rounded text-xs font-medium text-white hover:bg-[#202027]"
          >
            <Clock className="w-3.5 h-3.5 text-[#EF3340]" />
            Verificar agendadas
          </button>
          <button
            type="button"
            onClick={() => setShowPreview((p) => !p)}
            className="inline-flex items-center gap-2 px-3 py-2 bg-[#15151A] border border-white/10 rounded text-xs font-medium text-white"
          >
            <Eye className="w-4 h-4" />
            {showPreview ? 'Ocultar prévia' : 'Prévia do Hero'}
          </button>
        </div>
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

      {showPreview && (
        <div className="relative h-56 rounded-lg overflow-hidden border border-white/15">
          <img
            src={heroDesktopImage}
            alt="Prévia do banner"
            referrerPolicy="no-referrer"
            className="w-full h-full object-cover"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-[#0D0D10] via-[#0D0D10]/70 to-transparent p-6 flex flex-col justify-end">
            <h2 className="font-display text-3xl font-bold text-white">{heroTitle}</h2>
            <p className="text-xs text-[#A1A1AA] max-w-xl">{heroSubtitle}</p>
          </div>
        </div>
      )}

      <form
        onSubmit={handleSavePortal}
        className="bg-[#15151A] border border-white/8 rounded-lg p-6 space-y-5"
      >
        <h2 className="text-base font-bold text-white flex items-center gap-2">
          <Palette className="w-4 h-4 text-[#EF3340]" /> Capa, Marca e Seções da Home
        </h2>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <label className="text-xs text-[#A1A1AA]">Título Principal (Hero)</label>
            <input
              type="text"
              required
              maxLength={140}
              value={heroTitle}
              onChange={(e) => setHeroTitle(e.target.value)}
              className="w-full bg-[#0D0D10] border border-white/12 rounded px-3 py-2 text-sm text-white"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs text-[#A1A1AA]">Logo da Marca NXF (URL ou Upload)</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={brandLogoUrl}
                onChange={(e) => setBrandLogoUrl(e.target.value)}
                className="flex-1 bg-[#0D0D10] border border-white/12 rounded px-3 py-2 text-xs text-white"
              />
              <label className="inline-flex items-center gap-1 px-3 py-2 bg-[#202027] rounded text-xs cursor-pointer">
                <Upload className="w-3.5 h-3.5" />
                {uploadingFolder === 'brand' ? '...' : ''}
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  className="hidden"
                  onChange={(e) =>
                    void handleUploadAsset(e.target.files?.[0], setBrandLogoUrl, 'brand', brandLogoUrl)
                  }
                />
              </label>
            </div>
          </div>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs text-[#A1A1AA]">Subtítulo do Hero</label>
          <textarea
            rows={2}
            required
            maxLength={400}
            value={heroSubtitle}
            onChange={(e) => setHeroSubtitle(e.target.value)}
            className="w-full bg-[#0D0D10] border border-white/12 rounded px-3 py-2 text-sm text-white"
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <label className="text-xs text-[#A1A1AA]">Imagem Hero Desktop</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={heroDesktopImage}
                onChange={(e) => setHeroDesktopImage(e.target.value)}
                className="flex-1 bg-[#0D0D10] border border-white/12 rounded px-3 py-2 text-xs text-white"
              />
              <label className="inline-flex items-center gap-1 px-3 py-2 bg-[#202027] rounded text-xs cursor-pointer">
                <Upload className="w-3.5 h-3.5" />
                {uploadingFolder === 'hero_desktop' ? '...' : ''}
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  className="hidden"
                  onChange={(e) =>
                    void handleUploadAsset(
                      e.target.files?.[0],
                      setHeroDesktopImage,
                      'hero_desktop',
                      heroDesktopImage
                    )
                  }
                />
              </label>
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs text-[#A1A1AA]">Imagem Hero Mobile</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={heroMobileImage}
                onChange={(e) => setHeroMobileImage(e.target.value)}
                className="flex-1 bg-[#0D0D10] border border-white/12 rounded px-3 py-2 text-xs text-white"
              />
              <label className="inline-flex items-center gap-1 px-3 py-2 bg-[#202027] rounded text-xs cursor-pointer">
                <Upload className="w-3.5 h-3.5" />
                {uploadingFolder === 'hero_mobile' ? '...' : ''}
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  className="hidden"
                  onChange={(e) =>
                    void handleUploadAsset(
                      e.target.files?.[0],
                      setHeroMobileImage,
                      'hero_mobile',
                      heroMobileImage
                    )
                  }
                />
              </label>
            </div>
          </div>
        </div>

        <div className="space-y-2 pt-2 border-t border-white/8">
          <p className="text-xs font-medium text-[#A1A1AA]">Visibilidade das seções da Home</p>
          <div className="flex flex-wrap gap-4 text-xs">
            {[
              ['matches', 'Próximas partidas'],
              ['results', 'Resultados'],
              ['teams', 'Equipes'],
              ['achievements', 'Conquistas'],
              ['news', 'Notícias'],
              ['recruitment', 'Recrutamento'],
              ['sponsors', 'Patrocinadores'],
            ].map(([key, label]) => (
              <label key={key} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={visibleSections[key] !== false}
                  onChange={(e) =>
                    setVisibleSections((prev) => ({ ...prev, [key]: e.target.checked }))
                  }
                  className="accent-[#DC172B]"
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </div>

        <button
          type="submit"
          className="inline-flex items-center gap-2 px-5 py-2.5 bg-[#DC172B] hover:bg-[#EF3340] text-xs font-semibold text-white rounded"
        >
          <Save className="w-4 h-4" /> Publicar alterações do portal
        </button>
      </form>

      {/* Notícias & Patrocinadores */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <form
          onSubmit={handlePublishNews}
          className="bg-[#15151A] border border-white/8 rounded-lg p-5 space-y-3"
        >
          <h2 className="text-base font-bold text-white flex items-center gap-2">
            <Newspaper className="w-4 h-4 text-[#EF3340]" /> Nova Matéria ({newsList.length})
          </h2>
          <input
            type="text"
            required
            minLength={3}
            value={nTitle}
            onChange={(e) => setNTitle(e.target.value)}
            placeholder="Título da notícia"
            className="w-full bg-[#0D0D10] border border-white/12 rounded px-3 py-2 text-sm text-white"
          />
          <input
            type="text"
            required
            minLength={3}
            value={nSummary}
            onChange={(e) => setNSummary(e.target.value)}
            placeholder="Resumo curto"
            className="w-full bg-[#0D0D10] border border-white/12 rounded px-3 py-2 text-xs text-white"
          />
          <textarea
            rows={4}
            required
            minLength={5}
            value={nContent}
            onChange={(e) => setNContent(e.target.value)}
            placeholder="Texto completo da matéria..."
            className="w-full bg-[#0D0D10] border border-white/12 rounded px-3 py-2 text-sm text-white"
          />
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={nStatus}
              onChange={(e) => setNStatus(e.target.value as 'draft' | 'scheduled' | 'published')}
              className="bg-[#0D0D10] border border-white/12 rounded px-2.5 py-2 text-xs text-white"
            >
              <option value="published">Publicar agora</option>
              <option value="draft">Rascunho</option>
              <option value="scheduled">Agendar publicação</option>
            </select>
            {nStatus === 'scheduled' && (
              <input
                type="datetime-local"
                value={nScheduleAt}
                onChange={(e) => setNScheduleAt(e.target.value)}
                className="bg-[#0D0D10] border border-white/12 rounded px-2.5 py-2 text-xs text-white"
              />
            )}
            <button
              type="submit"
              className="px-4 py-2 bg-[#DC172B] hover:bg-[#EF3340] text-xs font-semibold text-white rounded"
            >
              Salvar matéria
            </button>
          </div>
        </form>

        <form
          onSubmit={handleAddSponsor}
          className="bg-[#15151A] border border-white/8 rounded-lg p-5 space-y-3"
        >
          <h2 className="text-base font-bold text-white">
            Patrocinadores ({sponsors.length})
          </h2>
          <input
            type="text"
            required
            value={spName}
            onChange={(e) => setSpName(e.target.value)}
            placeholder="Nome do parceiro"
            className="w-full bg-[#0D0D10] border border-white/12 rounded px-3 py-2 text-sm text-white"
          />
          <input
            type="url"
            value={spLogo}
            onChange={(e) => setSpLogo(e.target.value)}
            placeholder="URL da logo (opcional)"
            className="w-full bg-[#0D0D10] border border-white/12 rounded px-3 py-2 text-xs text-white"
          />
          <button
            type="submit"
            className="px-4 py-2 bg-[#202027] hover:bg-[#2B2B35] border border-white/10 text-xs font-semibold text-white rounded"
          >
            Adicionar patrocinador
          </button>
        </form>
      </div>
    </div>
  );
}
