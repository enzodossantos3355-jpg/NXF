import React, { createContext, useContext, useEffect, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '../lib/firebase';
import type { SiteContent } from '../types/nxf';

export const DEFAULT_BRAND_LOGO =
  '/assets/aistudio/SmartSelect_20261120_101959_TikTok_d3138b9a.jpg';

export const DEFAULT_HERO_IMAGE =
  '/src/assets/images/hero_nxf_arena_1795182578606.jpg';

export const DEFAULT_SITE_CONTENT: SiteContent = {
  heroTitle: 'NEXO FURY — COMPETITIVO BRAWL STARS',
  heroSubtitle:
    'Organização profissional de eSports focada em alto rendimento, análise tática, formação de talentos e gestão competitiva estruturada.',
  heroDesktopImage: DEFAULT_HERO_IMAGE,
  heroMobileImage: DEFAULT_HERO_IMAGE,
  heroPrimaryCtaLabel: 'Explorar Equipes',
  heroPrimaryCtaTo: '/equipes',
  brandLogoUrl: DEFAULT_BRAND_LOGO,
  aboutTitle: 'Sobre a NXF eSports',
  aboutBody:
    'A NXF eSports (NEXO FURY) nasceu com foco em disciplina competitiva, transparência organizacional e preparação estruturada no cenário de Brawl Stars. Nossas divisões operam com comissão técnica dedicada, acompanhamento de treinos, calendário oficial e processo seletivo transparente.',
  socialLinks: {
    discord: '',
    instagram: '',
    youtube: '',
    twitter: '',
    tiktok: '',
  },
  sectionOrder: [
    'matches',
    'results',
    'teams',
    'achievements',
    'news',
    'recruitment',
    'sponsors',
  ],
  visibleSections: {
    matches: true,
    results: true,
    teams: true,
    achievements: true,
    news: true,
    recruitment: true,
    sponsors: true,
  },
  version: 1,
  updatedBy: 'system',
};

interface SiteContextValue {
  siteContent: SiteContent;
  loadingSite: boolean;
}

const SiteContext = createContext<SiteContextValue>({
  siteContent: DEFAULT_SITE_CONTENT,
  loadingSite: true,
});

export function SiteProvider({ children }: { children: React.ReactNode }) {
  const [siteContent, setSiteContent] = useState<SiteContent>(DEFAULT_SITE_CONTENT);
  const [loadingSite, setLoadingSite] = useState(true);

  useEffect(() => {
    const unsub = onSnapshot(
      doc(db, 'siteContent', 'public'),
      (snap) => {
        if (snap.exists()) {
          const data = snap.data() as Partial<SiteContent>;
          setSiteContent({
            ...DEFAULT_SITE_CONTENT,
            ...data,
            heroDesktopImage: data.heroDesktopImage || DEFAULT_HERO_IMAGE,
            heroMobileImage: data.heroMobileImage || data.heroDesktopImage || DEFAULT_HERO_IMAGE,
            brandLogoUrl: data.brandLogoUrl || DEFAULT_BRAND_LOGO,
            visibleSections: {
              ...DEFAULT_SITE_CONTENT.visibleSections,
              ...(data.visibleSections || {}),
            },
          });
        } else {
          setSiteContent(DEFAULT_SITE_CONTENT);
        }
        setLoadingSite(false);
      },
      () => {
        setSiteContent(DEFAULT_SITE_CONTENT);
        setLoadingSite(false);
      }
    );

    return () => unsub();
  }, []);

  return (
    <SiteContext.Provider value={{ siteContent, loadingSite }}>
      {children}
    </SiteContext.Provider>
  );
}

export function useSiteContent() {
  return useContext(SiteContext);
}
