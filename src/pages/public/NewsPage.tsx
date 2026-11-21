import React, { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Share2 } from 'lucide-react';
import { collection, onSnapshot, orderBy, query, where } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { formatFirestoreDate } from '../../lib/permissions';
import { EmptyState, LoadingSkeleton } from '../../components/common/StateViews';
import { SafeImage } from '../../components/common/BrandMark';
import type { NewsArticle } from '../../types/nxf';

export function NewsPage() {
  const [articles, setArticles] = useState<NewsArticle[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsub = onSnapshot(
      query(
        collection(db, 'news'),
        where('status', '==', 'published'),
        orderBy('publishedAt', 'desc')
      ),
      (snap) => {
        setArticles(
          snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<NewsArticle, 'id'>) }))
        );
        setLoading(false);
      },
      () => setLoading(false)
    );
    return () => unsub();
  }, []);

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-10 space-y-6">
      <div className="border-b border-white/8 pb-5 space-y-1.5">
        <p className="text-xs font-semibold text-[#EF3340] uppercase tracking-wider">
          Editorial NXF
        </p>
        <h1 className="font-display text-4xl font-bold text-white">Notícias e Comunicados</h1>
        <p className="text-sm text-[#A1A1AA]">
          Cobertura oficial de torneios, movimentações de elenco e comunicados institucionais.
        </p>
      </div>

      {loading ? (
        <LoadingSkeleton rows={3} />
      ) : articles.length === 0 ? (
        <EmptyState
          title="Nenhuma notícia publicada"
          description="As matérias publicadas pelo NXF Studio aparecerão aqui automaticamente."
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {articles.map((article) => (
            <Link
              key={article.id}
              to={`/noticias/${article.slug}`}
              className="bg-[#15151A] border border-white/8 hover:border-white/20 rounded-lg overflow-hidden transition-colors"
            >
              {article.coverImageUrl && (
                <SafeImage
                  src={article.coverImageUrl}
                  alt={article.title}
                  className="h-44 w-full object-cover"
                />
              )}
              <div className="p-5 space-y-2">
                <p className="text-xs text-[#A1A1AA]">
                  {article.category || 'Editorial'} · {formatFirestoreDate(article.publishedAt || article.createdAt)}
                </p>
                <h2 className="text-lg font-bold text-white">{article.title}</h2>
                <p className="text-xs text-[#A1A1AA] line-clamp-3">{article.summary}</p>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export function NewsDetailPage() {
  const { slug } = useParams<{ slug: string }>();
  const [article, setArticle] = useState<NewsArticle | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!slug) return;
    const unsub = onSnapshot(
      query(
        collection(db, 'news'),
        where('slug', '==', slug),
        where('status', '==', 'published')
      ),
      (snap) => {
        if (!snap.empty) {
          const d = snap.docs[0];
          const data = { id: d.id, ...(d.data() as Omit<NewsArticle, 'id'>) };
          setArticle(data);
          document.title = `${data.title} — NXF eSports`;
        } else {
          setArticle(null);
        }
        setLoading(false);
      },
      () => setLoading(false)
    );
    return () => {
      unsub();
      document.title = 'NXF eSports — NEXO FURY | Brawl Stars Competitivo';
    };
  }, [slug]);

  const handleShare = async () => {
    const url = window.location.href;
    if (navigator.share) {
      try {
        await navigator.share({ title: article?.title, url });
        return;
      } catch {
        // fallback para copiar link
      }
    }
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-10">
        <LoadingSkeleton rows={4} />
      </div>
    );
  }

  if (!article) {
    return (
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-10 space-y-4">
        <Link to="/noticias" className="inline-flex items-center gap-1.5 text-xs text-[#A1A1AA] hover:text-white">
          <ArrowLeft className="w-3.5 h-3.5" /> Voltar às notícias
        </Link>
        <EmptyState
          title="Matéria não encontrada"
          description="Este conteúdo não está disponível ou ainda não foi publicado."
        />
      </div>
    );
  }

  return (
    <article className="max-w-4xl mx-auto px-4 sm:px-6 py-10 space-y-6">
      <div className="flex items-center justify-between gap-4">
        <Link to="/noticias" className="inline-flex items-center gap-1.5 text-xs text-[#A1A1AA] hover:text-white">
          <ArrowLeft className="w-3.5 h-3.5" /> Notícias
        </Link>
        <button
          type="button"
          onClick={() => void handleShare()}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#15151A] border border-white/10 rounded text-xs text-white hover:bg-[#202027]"
        >
          <Share2 className="w-3.5 h-3.5" />
          {copied ? 'Link copiado' : 'Compartilhar'}
        </button>
      </div>

      <header className="space-y-3 border-b border-white/8 pb-6">
        <p className="text-xs text-[#EF3340] font-medium">
          {article.category || 'Editorial'} · {formatFirestoreDate(article.publishedAt || article.createdAt)}
          {article.authorName ? ` · Por ${article.authorName}` : ''}
        </p>
        <h1 className="font-display text-3xl sm:text-5xl font-bold text-white leading-tight text-balance">
          {article.title}
        </h1>
        <p className="text-base text-[#A1A1AA] leading-relaxed">{article.summary}</p>
      </header>

      {article.coverImageUrl && (
        <SafeImage
          src={article.coverImageUrl}
          alt={article.title}
          className="w-full max-h-[420px] object-cover rounded-lg"
        />
      )}

      <div className="text-sm sm:text-base text-[#E4E4E7] leading-7 whitespace-pre-wrap">
        {article.content}
      </div>
    </article>
  );
}
