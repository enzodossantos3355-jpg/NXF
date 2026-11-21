import React, { useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { Menu, X } from 'lucide-react';
import { BrandMark } from '../components/common/BrandMark';
import { OfflineIndicator, PWAInstallButton } from '../components/common/PWAInstallButton';
import { useAuth } from '../context/AuthContext';
import { useSiteContent } from '../context/SiteContext';

const PRIMARY_NAV = [
  { label: 'Início', to: '/' },
  { label: 'Equipes', to: '/equipes' },
  { label: 'Competitivo', to: '/competitivo' },
  { label: 'Notícias', to: '/noticias' },
  { label: 'Recrutamento', to: '/recrutamento' },
];

export function PublicLayout() {
  const { firebaseUser, capabilities } = useAuth();
  const { siteContent } = useSiteContent();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const location = useLocation();
  const accountPath = capabilities.isOfficialMember ? '/painel' : '/minha-conta';
  const accountLabel = capabilities.isOfficialMember ? 'Meu painel' : 'Minha conta';

  return (
    <div className="min-h-screen flex flex-col bg-[#0D0D10] text-white">
      <header className="sticky top-0 z-40 border-b border-white/8 bg-[#0D0D10]/95 backdrop-blur-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-8">
          {/* Zone 1: Single-line Brand Zone */}
          <Link
            to="/"
            className="flex items-center gap-3 whitespace-nowrap shrink-0 focus-visible:outline-[#EF3340]"
          >
            <BrandMark logoUrl={siteContent.brandLogoUrl} size="sm" />
            <span className="font-display text-xl font-bold tracking-tight text-white">
              NXF eSports
            </span>
          </Link>

          {/* Zone 2: 5 concise single-line text navigation links */}
          <nav
            aria-label="Navegação principal"
            className="hidden md:flex items-center gap-6 text-sm font-medium"
          >
            {PRIMARY_NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                className={({ isActive }) =>
                  `whitespace-nowrap shrink-0 py-1 transition-colors border-b-2 ${
                    isActive
                      ? 'text-white border-[#DC172B]'
                      : 'text-[#A1A1AA] border-transparent hover:text-white'
                  }`
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>

          {/* Zone 3: 1 Primary Action + Mobile Menu Trigger */}
          <div className="flex items-center gap-3 shrink-0">
            <Link
              to={firebaseUser ? accountPath : '/entrar'}
              className="hidden sm:inline-flex items-center justify-center px-4 py-2 bg-[#DC172B] hover:bg-[#EF3340] text-white text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0"
            >
              {firebaseUser ? accountLabel : 'Entrar'}
            </Link>

            <button
              type="button"
              onClick={() => setMobileMenuOpen((prev) => !prev)}
              className="md:hidden p-2 rounded-md bg-[#15151A] border border-white/10 text-white"
              aria-label={mobileMenuOpen ? 'Fechar menu' : 'Abrir menu'}
              aria-expanded={mobileMenuOpen}
            >
              {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </button>
          </div>
        </div>

        {mobileMenuOpen && (
          <div className="md:hidden border-t border-white/8 bg-[#15151A] px-4 py-4 space-y-2">
            {PRIMARY_NAV.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                onClick={() => setMobileMenuOpen(false)}
                className={`block px-3 py-2.5 rounded-md text-sm font-medium ${
                  location.pathname === item.to
                    ? 'bg-[#202027] text-white'
                    : 'text-[#A1A1AA] hover:text-white hover:bg-[#202027]'
                }`}
              >
                {item.label}
              </Link>
            ))}
            <div className="border-t border-white/8 pt-2 mt-2 space-y-2">
              <Link
                to="/sobre"
                onClick={() => setMobileMenuOpen(false)}
                className="block px-3 py-2 text-sm text-[#A1A1AA] hover:text-white"
              >
                Sobre a NXF
              </Link>
              <Link
                to="/instalar"
                onClick={() => setMobileMenuOpen(false)}
                className="block px-3 py-2 text-sm text-[#A1A1AA] hover:text-white"
              >
                Instalar aplicativo
              </Link>
              <Link
                to={firebaseUser ? accountPath : '/entrar'}
                onClick={() => setMobileMenuOpen(false)}
                className="block w-full text-center px-4 py-2.5 bg-[#DC172B] hover:bg-[#EF3340] text-white text-sm font-semibold rounded-md"
              >
                {firebaseUser ? accountLabel : 'Entrar'}
              </Link>
            </div>
          </div>
        )}
      </header>

      <main className="flex-1">
        <Outlet />
      </main>

      <footer className="border-t border-white/8 bg-[#15151A] mt-16">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-10 grid grid-cols-1 md:grid-cols-4 gap-8">
          <div className="space-y-3 md:col-span-2">
            <div className="flex items-center gap-3">
              <BrandMark logoUrl={siteContent.brandLogoUrl} size="sm" />
              <span className="font-display text-lg font-bold text-white">
                NXF eSports · NEXO FURY
              </span>
            </div>
            <p className="text-xs text-[#A1A1AA] max-w-md leading-relaxed">
              Organização competitiva de Brawl Stars. Calendário oficial, elencos ativos,
              processo seletivo e gestão operacional em plataforma dedicada.
            </p>
            <div className="pt-1">
              <PWAInstallButton compact />
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-xs font-semibold text-white">Portal Público</p>
            <ul className="space-y-1.5 text-xs text-[#A1A1AA]">
              <li><Link to="/equipes" className="hover:text-white">Equipes</Link></li>
              <li><Link to="/competitivo" className="hover:text-white">Competitivo</Link></li>
              <li><Link to="/noticias" className="hover:text-white">Notícias</Link></li>
              <li><Link to="/recrutamento" className="hover:text-white">Recrutamento</Link></li>
            </ul>
          </div>

          <div className="space-y-2">
            <p className="text-xs font-semibold text-white">Organização</p>
            <ul className="space-y-1.5 text-xs text-[#A1A1AA]">
              <li><Link to="/sobre" className="hover:text-white">Sobre a NXF</Link></li>
              <li><Link to="/instalar" className="hover:text-white">Instalar aplicativo</Link></li>
              <li><Link to="/entrar" className="hover:text-white">Acesso de membros</Link></li>
              {siteContent.socialLinks?.discord && (
                <li>
                  <a
                    href={siteContent.socialLinks.discord}
                    target="_blank"
                    rel="noreferrer"
                    className="hover:text-white"
                  >
                    Discord oficial
                  </a>
                </li>
              )}
              {siteContent.socialLinks?.instagram && (
                <li>
                  <a
                    href={siteContent.socialLinks.instagram}
                    target="_blank"
                    rel="noreferrer"
                    className="hover:text-white"
                  >
                    Instagram
                  </a>
                </li>
              )}
            </ul>
          </div>
        </div>
        <div className="border-t border-white/6 py-4 px-4 sm:px-6">
          <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-[#71717A]">
            <span>© {new Date().getFullYear()} NXF eSports (NEXO FURY). Todos os direitos reservados.</span>
            <span>Brawl Stars Competitivo</span>
          </div>
        </div>
      </footer>

      <OfflineIndicator />
    </div>
  );
}
