import React, { useEffect, useState } from 'react';
import { Trophy } from 'lucide-react';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { useSiteContent } from '../../context/SiteContext';
import { BrandMark, SafeImage } from '../../components/common/BrandMark';
import { EmptyState } from '../../components/common/StateViews';
import type { Achievement, Sponsor } from '../../types/nxf';

export function AboutPage() {
  const { siteContent } = useSiteContent();
  const [achievements, setAchievements] = useState<Achievement[]>([]);
  const [sponsors, setSponsors] = useState<Sponsor[]>([]);

  useEffect(() => {
    const u1 = onSnapshot(
      query(collection(db, 'achievements'), where('isPublic', '==', true)),
      (snap) => {
        setAchievements(
          snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Achievement, 'id'>) }))
        );
      },
      () => {}
    );
    const u2 = onSnapshot(
      query(collection(db, 'sponsors'), where('active', '==', true)),
      (snap) => {
        setSponsors(
          snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Sponsor, 'id'>) }))
        );
      },
      () => {}
    );
    return () => {
      u1();
      u2();
    };
  }, []);

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-10 space-y-12">
      <section className="bg-[#15151A] border border-white/8 rounded-lg p-6 sm:p-8 space-y-5">
        <div className="flex items-center gap-4">
          <BrandMark logoUrl={siteContent.brandLogoUrl} size="lg" />
          <div>
            <p className="text-xs font-semibold text-[#EF3340] uppercase tracking-wider">
              Identidade Organizacional
            </p>
            <h1 className="font-display text-3xl sm:text-4xl font-bold text-white">
              {siteContent.aboutTitle || 'Sobre a NXF eSports'}
            </h1>
          </div>
        </div>
        <p className="text-sm sm:text-base text-[#A1A1AA] leading-relaxed whitespace-pre-line">
          {siteContent.aboutBody}
        </p>
      </section>

      <section className="space-y-4">
        <div className="flex items-center gap-2 border-b border-white/8 pb-3">
          <Trophy className="w-4 h-4 text-[#EF3340]" />
          <h2 className="font-display text-2xl font-bold">Conquistas Verificadas</h2>
        </div>
        {achievements.length === 0 ? (
          <EmptyState
            title="Nenhuma conquista verificada publicada"
            description="Os títulos e pódios verificados pela diretoria aparecerão aqui."
          />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {achievements.map((a) => (
              <div
                key={a.id}
                className="bg-[#15151A] border border-white/8 rounded-md p-4 space-y-1"
              >
                <p className="text-xs font-mono-tabular text-[#EF3340]">{a.placement}</p>
                <h3 className="text-base font-bold text-white">{a.title}</h3>
                {a.tournamentName && (
                  <p className="text-xs text-[#A1A1AA]">{a.tournamentName}</p>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-4">
        <h2 className="font-display text-2xl font-bold border-b border-white/8 pb-3">
          Patrocinadores e Canais Oficiais
        </h2>
        {sponsors.length > 0 ? (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {sponsors.map((s) => (
              <div
                key={s.id}
                className="bg-[#15151A] border border-white/8 rounded-md p-4 flex items-center justify-center h-24"
              >
                {s.logoUrl ? (
                  <SafeImage src={s.logoUrl} alt={s.name} className="max-h-12 object-contain" />
                ) : (
                  <span className="text-sm font-semibold">{s.name}</span>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-[#71717A]">Nenhum patrocinador ativo publicado.</p>
        )}
      </section>
    </div>
  );
}
