import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  Calendar,
  LayoutDashboard,
  Newspaper,
  Shield,
  Trophy,
  UserCheck,
  Users,
} from 'lucide-react';
import {
  collection,
  limit,
  onSnapshot,
  orderBy,
  query,
  where,
} from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { useAuth } from '../../context/AuthContext';
import { useSiteContent } from '../../context/SiteContext';
import { formatFirestoreDate } from '../../lib/permissions';
import { EmptyState, LoadingSkeleton } from '../../components/common/StateViews';
import { SafeImage } from '../../components/common/BrandMark';
import type {
  Achievement,
  Match,
  NewsArticle,
  Sponsor,
  Team,
  Vacancy,
} from '../../types/nxf';

export function HomePage() {
  const { firebaseUser, userDoc, capabilities } = useAuth();
  const { siteContent } = useSiteContent();

  const [upcomingMatches, setUpcomingMatches] = useState<Match[]>([]);
  const [recentResults, setRecentResults] = useState<Match[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [achievements, setAchievements] = useState<Achievement[]>([]);
  const [news, setNews] = useState<NewsArticle[]>([]);
  const [vacancies, setVacancies] = useState<Vacancy[]>([]);
  const [sponsors, setSponsors] = useState<Sponsor[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubs: Array<() => void> = [];

    unsubs.push(
      onSnapshot(
        query(
          collection(db, 'matches'),
          where('isPublic', '==', true),
          where('status', '==', 'scheduled'),
          orderBy('scheduledAt', 'asc'),
          limit(4)
        ),
        (snap) => {
          setUpcomingMatches(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Match, 'id'>) })));
          setLoading(false);
        },
        () => setLoading(false)
      )
    );

    unsubs.push(
      onSnapshot(
        query(
          collection(db, 'matches'),
          where('isPublic', '==', true),
          where('status', '==', 'completed'),
          orderBy('scheduledAt', 'desc'),
          limit(4)
        ),
        (snap) => {
          setRecentResults(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Match, 'id'>) })));
        },
        () => {}
      )
    );

    unsubs.push(
      onSnapshot(
        query(collection(db, 'teams'), where('isPublic', '==', true), limit(6)),
        (snap) => {
          setTeams(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Team, 'id'>) })));
        },
        () => {}
      )
    );

    unsubs.push(
      onSnapshot(
        query(collection(db, 'achievements'), where('isPublic', '==', true), limit(4)),
        (snap) => {
          setAchievements(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Achievement, 'id'>) })));
        },
        () => {}
      )
    );

    unsubs.push(
      onSnapshot(
        query(
          collection(db, 'news'),
          where('status', '==', 'published'),
          orderBy('publishedAt', 'desc'),
          limit(3)
        ),
        (snap) => {
          setNews(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<NewsArticle, 'id'>) })));
        },
        () => {}
      )
    );

    unsubs.push(
      onSnapshot(
        query(
          collection(db, 'vacancies'),
          where('status', '==', 'open'),
          orderBy('createdAt', 'desc'),
          limit(3)
        ),
        (snap) => {
          setVacancies(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Vacancy, 'id'>) })));
        },
        () => {}
      )
    );

    unsubs.push(
      onSnapshot(
        query(collection(db, 'sponsors'), where('active', '==', true), limit(8)),
        (snap) => {
          setSponsors(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Sponsor, 'id'>) })));
        },
        () => {}
      )
    );

    return () => unsubs.forEach((u) => u());
  }, []);

  const isVisible = (key: string) => siteContent.visibleSections?.[key] !== false;

  return (
    <div className="space-y-14">
      {/* Hero Banner editável pelo NXF Studio */}
      <section className="relative min-h-[460px] sm:min-h-[540px] flex items-end border-b border-white/8 overflow-hidden">
        <picture className="absolute inset-0">
          {siteContent.heroMobileImage && (
            <source media="(max-width: 767px)" srcSet={siteContent.heroMobileImage} />
          )}
          <img
            src={siteContent.heroDesktopImage}
            alt="Arena competitiva NXF eSports"
            referrerPolicy="no-referrer"
            className="w-full h-full object-cover"
          />
        </picture>
        <div className="absolute inset-0 bg-gradient-to-t from-[#0D0D10] via-[#0D0D10]/75 to-black/35" />

        <div className="relative z-10 max-w-7xl mx-auto w-full px-4 sm:px-6 py-12 sm:py-16">
          <div className="max-w-2xl space-y-4">
            <p className="text-xs font-semibold tracking-wider text-[#EF3340] uppercase">
              NEXO FURY · BRAWL STARS
            </p>
            <h1 className="font-display text-4xl sm:text-6xl font-bold leading-[1.02] text-white text-balance">
              {siteContent.heroTitle}
            </h1>
            <p className="text-sm sm:text-base text-[#A1A1AA] leading-relaxed max-w-xl">
              {siteContent.heroSubtitle}
            </p>
            <div className="pt-2 flex flex-wrap items-center gap-3">
              <Link
                to={siteContent.heroPrimaryCtaTo || '/equipes'}
                className="inline-flex items-center gap-2 px-5 py-3 bg-[#DC172B] hover:bg-[#EF3340] text-white text-sm font-semibold rounded-md transition-colors whitespace-nowrap"
              >
                {siteContent.heroPrimaryCtaLabel || 'Explorar Equipes'}
                <ArrowRight className="w-4 h-4" />
              </Link>
              <Link
                to="/recrutamento"
                className="inline-flex items-center gap-2 px-5 py-3 bg-[#15151A]/90 hover:bg-[#202027] border border-white/15 text-white text-sm font-medium rounded-md transition-colors whitespace-nowrap"
              >
                Vagas abertas
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* Atalhos rápidos para usuário autenticado sem redirecionamento forçado */}
      {firebaseUser && (
        <section className="max-w-7xl mx-auto px-4 sm:px-6 -mt-6">
          <div className="bg-[#15151A] border border-white/10 rounded-lg p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <p className="text-sm font-semibold text-white">
                Sessão autenticada como{' '}
                {userDoc?.displayName || firebaseUser.displayName || userDoc?.code || 'Membro'}
              </p>
              <p className="text-xs text-[#A1A1AA] mt-0.5">
                {capabilities.isOfficialMember
                  ? 'O portal público continua acessível. Utilize os atalhos para entrar na área de gestão.'
                  : 'Conta básica ativa. Acompanhe suas candidaturas ou acesse as vagas abertas.'}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2.5">
              {capabilities.isOfficialMember ? (
                <>
                  <Link
                    to="/painel"
                    className="inline-flex items-center gap-2 px-4 py-2 bg-[#DC172B] hover:bg-[#EF3340] text-white text-xs font-semibold rounded-md whitespace-nowrap"
                  >
                    <LayoutDashboard className="w-3.5 h-3.5" />
                    Meu painel
                  </Link>
                  {capabilities.canManageCompetitive && (
                    <Link
                      to="/painel/competitivo"
                      className="px-3.5 py-2 bg-[#202027] hover:bg-[#2B2B35] border border-white/10 text-xs font-medium rounded-md whitespace-nowrap"
                    >
                      Competitivo
                    </Link>
                  )}
                  {capabilities.canManageCms && (
                    <Link
                      to="/painel/studio"
                      className="px-3.5 py-2 bg-[#202027] hover:bg-[#2B2B35] border border-white/10 text-xs font-medium rounded-md whitespace-nowrap"
                    >
                      NXF Studio
                    </Link>
                  )}
                </>
              ) : (
                <>
                  <Link
                    to="/minha-conta"
                    className="inline-flex items-center gap-2 px-4 py-2 bg-[#DC172B] hover:bg-[#EF3340] text-white text-xs font-semibold rounded-md whitespace-nowrap"
                  >
                    Minha conta
                  </Link>
                  <Link
                    to="/recrutamento"
                    className="px-3.5 py-2 bg-[#202027] hover:bg-[#2B2B35] border border-white/10 text-xs font-medium rounded-md whitespace-nowrap"
                  >
                    Recrutamento
                  </Link>
                </>
              )}
            </div>
          </div>
        </section>
      )}

      {/* Próximas Partidas & Resultados Recentes */}
      {(isVisible('matches') || isVisible('results')) && (
        <section className="max-w-7xl mx-auto px-4 sm:px-6 grid grid-cols-1 lg:grid-cols-2 gap-8">
          {isVisible('matches') && (
            <div className="space-y-4">
              <div className="flex items-center justify-between border-b border-white/8 pb-3">
                <div className="flex items-center gap-2">
                  <Calendar className="w-4 h-4 text-[#EF3340]" />
                  <h2 className="font-display text-2xl font-bold">Próximas Partidas</h2>
                </div>
                <Link to="/competitivo" className="text-xs text-[#A1A1AA] hover:text-white">
                  Ver calendário
                </Link>
              </div>
              {loading ? (
                <LoadingSkeleton rows={2} />
              ) : upcomingMatches.length === 0 ? (
                <EmptyState
                  title="Nenhuma partida agendada"
                  description="Os confrontos oficiais aparecerão aqui assim que forem cadastrados pela comissão técnica ou gerência."
                />
              ) : (
                <div className="space-y-3">
                  {upcomingMatches.map((m) => (
                    <div
                      key={m.id}
                      className="bg-[#15151A] border border-white/8 rounded-md p-4 flex items-center justify-between gap-4"
                    >
                      <div className="min-w-0">
                        <p className="text-xs text-[#A1A1AA]">
                          {m.tournamentName || 'Confronto oficial'} · {m.format}
                        </p>
                        <p className="text-sm font-semibold text-white mt-0.5 truncate">
                          {m.teamName} vs {m.opponentName}
                        </p>
                      </div>
                      <span className="font-mono-tabular text-xs text-[#A1A1AA] shrink-0">
                        {formatFirestoreDate(m.scheduledAt)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {isVisible('results') && (
            <div className="space-y-4">
              <div className="flex items-center justify-between border-b border-white/8 pb-3">
                <div className="flex items-center gap-2">
                  <Trophy className="w-4 h-4 text-[#EF3340]" />
                  <h2 className="font-display text-2xl font-bold">Resultados Recentes</h2>
                </div>
                <Link to="/competitivo" className="text-xs text-[#A1A1AA] hover:text-white">
                  Histórico
                </Link>
              </div>
              {loading ? (
                <LoadingSkeleton rows={2} />
              ) : recentResults.length === 0 ? (
                <EmptyState
                  title="Nenhum resultado publicado"
                  description="Os placares finais são validados e registrados pelos responsáveis autorizados após cada série."
                />
              ) : (
                <div className="space-y-3">
                  {recentResults.map((m) => (
                    <div
                      key={m.id}
                      className="bg-[#15151A] border border-white/8 rounded-md p-4 flex items-center justify-between gap-4"
                    >
                      <div className="min-w-0">
                        <p className="text-xs text-[#A1A1AA]">
                          {m.tournamentName || 'Série encerrada'} · {m.format}
                        </p>
                        <p className="text-sm font-semibold text-white mt-0.5 truncate">
                          {m.teamName} vs {m.opponentName}
                        </p>
                      </div>
                      <span className="font-mono-tabular text-base font-bold text-white shrink-0">
                        {m.nxfScore ?? 0} : {m.opponentScore ?? 0}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {/* Equipes */}
      {isVisible('teams') && (
        <section className="max-w-7xl mx-auto px-4 sm:px-6 space-y-5">
          <div className="flex items-center justify-between border-b border-white/8 pb-3">
            <div className="flex items-center gap-2">
              <Users className="w-4 h-4 text-[#EF3340]" />
              <h2 className="font-display text-2xl font-bold">Equipes NXF</h2>
            </div>
            <Link to="/equipes" className="text-xs text-[#A1A1AA] hover:text-white">
              Todas as divisões
            </Link>
          </div>
          {teams.length === 0 ? (
            <EmptyState
              title="Nenhuma equipe pública cadastrada"
              description="As divisões ativas da NXF eSports serão listadas aqui após o cadastro no painel de Organização."
            />
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
              {teams.map((team) => (
                <Link
                  key={team.id}
                  to={`/equipes/${team.id}`}
                  className="bg-[#15151A] border border-white/8 hover:border-white/20 rounded-lg overflow-hidden transition-colors flex flex-col"
                >
                  <SafeImage
                    src={team.bannerUrl || team.logoUrl}
                    alt={team.name}
                    className="h-36 w-full object-cover"
                    fallbackLabel={team.name}
                  />
                  <div className="p-4 space-y-1.5">
                    <p className="text-xs text-[#EF3340] font-medium">{team.category}</p>
                    <h3 className="text-lg font-bold text-white">{team.name}</h3>
                    {team.description && (
                      <p className="text-xs text-[#A1A1AA] line-clamp-2">{team.description}</p>
                    )}
                  </div>
                </Link>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Conquistas & Notícias */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 grid grid-cols-1 lg:grid-cols-3 gap-8">
        {isVisible('achievements') && (
          <div className="space-y-4">
            <div className="flex items-center justify-between border-b border-white/8 pb-3">
              <div className="flex items-center gap-2">
                <Shield className="w-4 h-4 text-[#EF3340]" />
                <h2 className="font-display text-2xl font-bold">Conquistas</h2>
              </div>
              <Link to="/sobre" className="text-xs text-[#A1A1AA] hover:text-white">
                Ver todas
              </Link>
            </div>
            {achievements.length === 0 ? (
              <EmptyState
                title="Sem conquistas registradas"
                description="Títulos e pódios verificados pela organização serão exibidos nesta vitrine."
              />
            ) : (
              <div className="space-y-3">
                {achievements.map((ach) => (
                  <div
                    key={ach.id}
                    className="bg-[#15151A] border border-white/8 rounded-md p-4 space-y-1"
                  >
                    <p className="text-xs font-mono-tabular text-[#EF3340]">{ach.placement}</p>
                    <p className="text-sm font-semibold text-white">{ach.title}</p>
                    {ach.tournamentName && (
                      <p className="text-xs text-[#A1A1AA]">{ach.tournamentName}</p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {isVisible('news') && (
          <div className="lg:col-span-2 space-y-4">
            <div className="flex items-center justify-between border-b border-white/8 pb-3">
              <div className="flex items-center gap-2">
                <Newspaper className="w-4 h-4 text-[#EF3340]" />
                <h2 className="font-display text-2xl font-bold">Últimas Notícias</h2>
              </div>
              <Link to="/noticias" className="text-xs text-[#A1A1AA] hover:text-white">
                Todas as matérias
              </Link>
            </div>
            {news.length === 0 ? (
              <EmptyState
                title="Nenhuma notícia publicada"
                description="Matérias e anúncios oficiais publicados no NXF Studio aparecerão aqui."
              />
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {news.map((article) => (
                  <Link
                    key={article.id}
                    to={`/noticias/${article.slug}`}
                    className="bg-[#15151A] border border-white/8 hover:border-white/20 rounded-lg overflow-hidden transition-colors"
                  >
                    {article.coverImageUrl && (
                      <SafeImage
                        src={article.coverImageUrl}
                        alt={article.title}
                        className="h-36 w-full object-cover"
                      />
                    )}
                    <div className="p-4 space-y-1.5">
                      <p className="text-xs text-[#A1A1AA]">
                        {article.category || 'Comunicado'} · {formatFirestoreDate(article.publishedAt || article.createdAt)}
                      </p>
                      <h3 className="text-base font-bold text-white line-clamp-2">
                        {article.title}
                      </h3>
                      <p className="text-xs text-[#A1A1AA] line-clamp-2">{article.summary}</p>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>
        )}
      </section>

      {/* Recrutamento & Patrocinadores */}
      {isVisible('recruitment') && (
        <section className="max-w-7xl mx-auto px-4 sm:px-6 space-y-4">
          <div className="flex items-center justify-between border-b border-white/8 pb-3">
            <div className="flex items-center gap-2">
              <UserCheck className="w-4 h-4 text-[#EF3340]" />
              <h2 className="font-display text-2xl font-bold">Recrutamento Aberto</h2>
            </div>
            <Link to="/recrutamento" className="text-xs text-[#A1A1AA] hover:text-white">
              Ir para vagas
            </Link>
          </div>
          {vacancies.length === 0 ? (
            <EmptyState
              title="Nenhuma vaga aberta no momento"
              description="Quando uma divisão abrir processo seletivo, os requisitos e prazos ficarão disponíveis aqui."
            />
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {vacancies.map((v) => (
                <div
                  key={v.id}
                  className="bg-[#15151A] border border-white/8 rounded-lg p-5 flex flex-col justify-between gap-4"
                >
                  <div className="space-y-1.5">
                    <p className="text-xs text-[#EF3340] font-medium">
                      {v.teamName} · {v.roleTarget}
                    </p>
                    <h3 className="text-base font-bold text-white">{v.title}</h3>
                    {v.requirements && (
                      <p className="text-xs text-[#A1A1AA] line-clamp-3">{v.requirements}</p>
                    )}
                  </div>
                  <Link
                    to="/recrutamento"
                    className="inline-flex items-center justify-center px-4 py-2 bg-[#202027] hover:bg-[#DC172B] text-white text-xs font-semibold rounded-md transition-colors"
                  >
                    Candidatar-se
                  </Link>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {isVisible('sponsors') && (
        <section className="max-w-7xl mx-auto px-4 sm:px-6 space-y-4">
          <div className="border-b border-white/8 pb-3">
            <h2 className="font-display text-2xl font-bold">Patrocinadores e Parceiros</h2>
          </div>
          {sponsors.length === 0 ? (
            <p className="text-xs text-[#71717A]">
              Nenhum parceiro ativo cadastrado no NXF Studio até o momento.
            </p>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              {sponsors.map((s) => (
                <div
                  key={s.id}
                  className="bg-[#15151A] border border-white/8 rounded-md p-4 flex items-center justify-center h-24"
                >
                  {s.logoUrl ? (
                    <SafeImage
                      src={s.logoUrl}
                      alt={s.name}
                      className="max-h-12 object-contain"
                      fallbackLabel={s.name}
                    />
                  ) : (
                    <span className="text-sm font-semibold text-white">{s.name}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
