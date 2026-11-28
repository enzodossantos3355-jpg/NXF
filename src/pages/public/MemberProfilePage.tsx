import React, { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, BarChart3, ExternalLink, Shield, Trophy } from 'lucide-react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { EmptyState, LoadingSkeleton } from '../../components/common/StateViews';
import { SafeImage } from '../../components/common/BrandMark';
import type { PlayerAnalytics, PlayerStats, PublicProfile } from '../../types/nxf';

export function MemberProfilePage() {
  const { profileId } = useParams<{ profileId: string }>();
  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [stats, setStats] = useState<PlayerStats | null>(null);
  const [analytics, setAnalytics] = useState<PlayerAnalytics | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!profileId) return;
    const u1 = onSnapshot(
      doc(db, 'publicProfiles', profileId),
      (snap) => {
        setProfile(snap.exists() ? ({ ...(snap.data() as PublicProfile), uid: snap.id }) : null);
        setLoading(false);
      },
      () => setLoading(false)
    );
    const u2 = onSnapshot(
      doc(db, 'playerStats', profileId),
      (snap) => {
        setStats(snap.exists() ? (snap.data() as PlayerStats) : null);
      },
      () => {}
    );
    const u3 = onSnapshot(
      doc(db, 'playerAnalytics', profileId),
      (snap) => {
        setAnalytics(snap.exists() ? (snap.data() as PlayerAnalytics) : null);
      },
      () => {}
    );
    return () => {
      u1();
      u2();
      u3();
    };
  }, [profileId]);

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-10">
        <LoadingSkeleton rows={4} />
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-10 space-y-4">
        <Link to="/equipes" className="inline-flex items-center gap-1.5 text-xs text-[#A1A1AA] hover:text-white">
          <ArrowLeft className="w-3.5 h-3.5" /> Voltar
        </Link>
        <EmptyState
          title="Perfil público indisponível"
          description="Este perfil não está ativo para visualização pública ou encontra-se em moderação."
        />
      </div>
    );
  }

  const layout = profile.layout || 'classic';

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-10 space-y-8">
      <Link to="/entrar" className="inline-flex items-center gap-1.5 text-xs text-[#A1A1AA] hover:text-white">
        <ArrowLeft className="w-3.5 h-3.5" /> Voltar
      </Link>

      {/* Layout Minimalista */}
      {layout === 'minimal' ? (
        <div className="bg-[#15151A] border border-white/10 rounded-lg p-8 space-y-5">
          <div className="flex flex-col sm:flex-row sm:items-center gap-5">
            <SafeImage
              src={profile.avatarUrl}
              alt={profile.nickname}
              className="w-20 h-20 rounded-full object-cover border border-white/15 shrink-0"
              fallbackLabel={profile.nickname}
            />
            <div className="space-y-1">
              <p className="text-xs font-semibold text-[#EF3340]">{profile.publicRole}</p>
              <h1 className="font-display text-3xl font-bold text-white">{profile.nickname}</h1>
              {profile.brawlTag && (
                <p className="text-xs font-mono-tabular text-[#A1A1AA]">
                  Tag Brawl Stars: {profile.brawlTag}
                  {profile.brawlTagApproved ? ' · Verificada pela organização' : ''}
                </p>
              )}
            </div>
          </div>
          {profile.bio && (
            <p className="text-sm text-[#A1A1AA] leading-relaxed border-t border-white/8 pt-4">
              {profile.bio}
            </p>
          )}
        </div>
      ) : (
        /* Layouts Clássico e Competitivo */
        <div className="bg-[#15151A] border border-white/10 rounded-lg overflow-hidden">
          <div className="relative h-48 sm:h-60 bg-[#202027]">
            {profile.bannerUrl ? (
              <SafeImage
                src={profile.bannerUrl}
                alt={`Banner de ${profile.nickname}`}
                className="w-full h-full object-cover"
                fallbackLabel={profile.nickname}
              />
            ) : (
              <div className="w-full h-full bg-gradient-to-br from-[#1B1B22] via-[#121217] to-[#260D12]" />
            )}
            <div className="absolute inset-0 bg-gradient-to-t from-[#15151A] via-[#15151A]/40 to-transparent" />
          </div>

          <div className="px-6 pb-6 -mt-12 relative z-10 space-y-5">
            <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
              <div className="flex items-end gap-4">
                <SafeImage
                  src={profile.avatarUrl}
                  alt={profile.nickname}
                  className="w-24 h-24 rounded-lg object-cover border-2 border-[#0D0D10] bg-[#202027]"
                  fallbackLabel={profile.nickname}
                />
                <div className="space-y-0.5 pb-1">
                  <p className="text-xs font-semibold text-[#EF3340]">{profile.publicRole}</p>
                  <h1 className="font-display text-3xl sm:text-4xl font-bold text-white">
                    {profile.nickname}
                  </h1>
                </div>
              </div>

              {profile.brawlTag && (
                <div className="bg-[#202027] border border-white/10 rounded-md px-3.5 py-2 text-xs">
                  <span className="text-[#A1A1AA]">Tag: </span>
                  <span className="font-mono-tabular font-semibold text-white">
                    {profile.brawlTag}
                  </span>
                </div>
              )}
            </div>

            {profile.bio && (
              <p className="text-sm text-[#A1A1AA] leading-relaxed max-w-3xl">{profile.bio}</p>
            )}

            {(layout === 'competitive' || stats?.syncStatus === 'ok') && (
              <div className="grid grid-cols-1 sm:grid-cols-4 gap-4 pt-2 border-t border-white/8">
                <div className="bg-[#0D0D10] border border-white/8 rounded-md p-4">
                  <p className="text-xs text-[#A1A1AA]">Troféus Oficiais (API)</p>
                  <p className="font-mono-tabular text-2xl font-bold text-white mt-1">
                    {stats?.syncStatus === 'ok' ? (stats.trophies ?? 0).toLocaleString('pt-BR') : '—'}
                  </p>
                </div>
                <div className="bg-[#0D0D10] border border-white/8 rounded-md p-4">
                  <p className="text-xs text-[#A1A1AA]">Vitórias 3v3</p>
                  <p className="font-mono-tabular text-2xl font-bold text-white mt-1">
                    {stats?.syncStatus === 'ok' ? (stats.victories3v3 ?? 0).toLocaleString('pt-BR') : '—'}
                  </p>
                </div>
                <div className="bg-[#0D0D10] border border-white/8 rounded-md p-4">
                  <p className="text-xs text-[#A1A1AA]">Win Rate (Battlelog)</p>
                  <p className="font-mono-tabular text-2xl font-bold text-white mt-1">
                    {analytics && analytics.totalBattles > 0 ? `${analytics.winRate}%` : '—'}
                  </p>
                </div>
                <div className="bg-[#0D0D10] border border-white/8 rounded-md p-4">
                  <p className="text-xs text-[#A1A1AA]">Vínculo organizacional</p>
                  <p className="text-sm font-semibold text-white mt-2 flex items-center gap-1.5">
                    <Shield className="w-4 h-4 text-[#EF3340]" />
                    {profile.brawlTagApproved ? 'Tag aprovada pela NXF' : 'Membro ativo'}
                  </p>
                </div>
              </div>
            )}

            {profile.socialLinks && Object.values(profile.socialLinks).some(Boolean) && (
              <div className="flex flex-wrap gap-3 pt-2 border-t border-white/8">
                {Object.entries(profile.socialLinks)
                  .filter(([, url]) => Boolean(url))
                  .map(([network, url]) => (
                    <a
                      key={network}
                      href={url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#202027] hover:bg-[#2B2B35] border border-white/10 rounded text-xs text-white capitalize"
                    >
                      {network}
                      <ExternalLink className="w-3 h-3 text-[#A1A1AA]" />
                    </a>
                  ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Análise Competitiva Real (Battlelogs Coletados) */}
      {analytics && analytics.totalBattles > 0 && (
        <section className="bg-[#15151A] border border-white/8 rounded-lg p-6 space-y-5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-white/8 pb-3">
            <h2 className="font-display text-xl font-bold text-white flex items-center gap-2">
              <BarChart3 className="w-4 h-4 text-[#EF3340]" />
              Desempenho Recente no Brawl Stars
            </h2>
            <p className="text-xs font-mono-tabular text-[#A1A1AA]">
              {analytics.totalBattles} batalha(s) · {analytics.wins}V / {analytics.losses}D · {analytics.winRate}% WR
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-[#A1A1AA]">
                Brawlers mais utilizados
              </h3>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-[#71717A] border-b border-white/8">
                    <th className="py-1.5 text-left font-medium">Brawler</th>
                    <th className="py-1.5 text-right font-medium">Jogos</th>
                    <th className="py-1.5 text-right font-medium">V/D</th>
                    <th className="py-1.5 text-right font-medium">Win Rate</th>
                  </tr>
                </thead>
                <tbody>
                  {analytics.brawlerStats.slice(0, 6).map((b) => (
                    <tr key={b.brawlerName} className="border-b border-white/5 last:border-none">
                      <td className="py-2 font-medium text-white">{b.brawlerName}</td>
                      <td className="py-2 text-right font-mono-tabular text-[#A1A1AA]">{b.battles}</td>
                      <td className="py-2 text-right font-mono-tabular text-[#A1A1AA]">
                        {b.wins}/{b.losses}
                      </td>
                      <td className="py-2 text-right font-mono-tabular font-semibold text-white">
                        {b.winRate}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-[#A1A1AA]">
                Modos mais jogados
              </h3>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-[#71717A] border-b border-white/8">
                    <th className="py-1.5 text-left font-medium">Modo</th>
                    <th className="py-1.5 text-right font-medium">Jogos</th>
                    <th className="py-1.5 text-right font-medium">V/D</th>
                    <th className="py-1.5 text-right font-medium">Win Rate</th>
                  </tr>
                </thead>
                <tbody>
                  {analytics.modeStats.slice(0, 6).map((m) => (
                    <tr key={m.mode} className="border-b border-white/5 last:border-none">
                      <td className="py-2 font-medium text-white capitalize">{m.mode}</td>
                      <td className="py-2 text-right font-mono-tabular text-[#A1A1AA]">{m.battles}</td>
                      <td className="py-2 text-right font-mono-tabular text-[#A1A1AA]">
                        {m.wins}/{m.losses}
                      </td>
                      <td className="py-2 text-right font-mono-tabular font-semibold text-white">
                        {m.winRate}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      <div className="bg-[#15151A] border border-white/8 rounded-lg p-5 flex items-center gap-3 text-xs text-[#A1A1AA]">
        <Trophy className="w-4 h-4 text-[#EF3340] shrink-0" />
        <span>
          Estatísticas e históricos de Brawl Stars exibidos nesta página são coletados exclusivamente da API oficial via sincronização segura do backend NXF.
        </span>
      </div>
    </div>
  );
}
