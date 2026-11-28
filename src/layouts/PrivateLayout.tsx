import React, { useEffect, useMemo, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  Bell,
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  LayoutDashboard,
  LogOut,
  Menu,
  Palette,
  Search,
  Settings,
  Trophy,
  UserCheck,
  UserCircle,
  Users,
  X,
} from 'lucide-react';
import { BrandMark } from '../components/common/BrandMark';
import { OfflineIndicator } from '../components/common/PWAInstallButton';
import { useAuth } from '../context/AuthContext';
import { useSiteContent } from '../context/SiteContext';
import { ROLE_LABELS } from '../lib/permissions';
import {
  buildPanelNavigation,
  resolveActiveNavItem,
  type NavIconKey,
} from '../lib/panelNavigation';

const NAV_ICONS: Record<NavIconKey, React.ComponentType<{ className?: string }>> = {
  dashboard: LayoutDashboard,
  profile: UserCircle,
  notifications: Bell,
  organization: Users,
  competitive: Trophy,
  trainings: CalendarClock,
  recruitment: UserCheck,
  studio: Palette,
  system: Settings,
};

export function PrivateLayout() {
  const {
    firebaseUser,
    userDoc,
    publicProfile,
    capabilities,
    signOut,
  } = useAuth();
  const { siteContent } = useSiteContent();
  const navigate = useNavigate();
  const location = useLocation();

  const [collapsed, setCollapsed] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');

  const visibleGroups = useMemo(
    () => buildPanelNavigation(capabilities),
    [capabilities]
  );

  const activeMeta = useMemo(
    () => resolveActiveNavItem(visibleGroups, location.pathname),
    [visibleGroups, location.pathname]
  );

  const canUseSystemSearch = capabilities.canAccessSystem || capabilities.isAnyAdmin;

  useEffect(() => {
    setMobileMenuOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!mobileMenuOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMobileMenuOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mobileMenuOpen]);

  const handleGlobalSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const q = searchTerm.trim();
    if (!q || !canUseSystemSearch) return;
    navigate(`/painel/system?q=${encodeURIComponent(q)}`);
  };

  const handleSignOut = async () => {
    await signOut();
    navigate('/');
  };

  const displayName =
    publicProfile?.nickname ||
    userDoc?.displayName ||
    firebaseUser?.displayName ||
    'Membro';

  const primaryRoleLabel = ROLE_LABELS[capabilities.roles[0] || 'candidate'];

  return (
    <div className="min-h-screen bg-[#0D0D10] text-white flex flex-col md:flex-row">
      {/* Desktop Sidebar */}
      <aside
        className={`hidden md:flex flex-col border-r border-white/8 bg-[#15151A] shrink-0 sticky top-0 h-screen transition-[width] duration-150 ${
          collapsed ? 'w-[72px]' : 'w-64'
        }`}
      >
        <div className="h-16 px-4 flex items-center justify-between border-b border-white/8 shrink-0">
          <Link to="/painel" className="flex items-center gap-2.5 min-w-0">
            <BrandMark logoUrl={siteContent.brandLogoUrl} size="sm" />
            {!collapsed && (
              <span className="font-display text-xl font-bold tracking-tight text-white whitespace-nowrap truncate">
                NXF Painel
              </span>
            )}
          </Link>
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            className="p-2 rounded-md bg-[#202027] hover:bg-[#2B2B35] text-[#A1A1AA] hover:text-white transition-colors shrink-0"
            aria-label={collapsed ? 'Expandir menu lateral' : 'Recolher menu lateral'}
            title={collapsed ? 'Expandir menu lateral' : 'Recolher menu lateral'}
          >
            {collapsed ? (
              <ChevronRight className="w-4 h-4" />
            ) : (
              <ChevronLeft className="w-4 h-4" />
            )}
          </button>
        </div>

        <nav
          aria-label="Navegação do painel administrativo"
          className="flex-1 overflow-y-auto px-3 py-5 space-y-6"
        >
          {visibleGroups.map((group) => (
            <div key={group.id} className="space-y-1">
              {!collapsed ? (
                <p className="px-2.5 pb-1 text-xs font-semibold text-[#71717A] tracking-wide">
                  {group.label}
                </p>
              ) : (
                <div className="h-px bg-white/8 mx-2 my-2" aria-hidden="true" />
              )}
              {group.items.map((item) => {
                const Icon = NAV_ICONS[item.icon];
                return (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.end}
                    title={collapsed ? `${group.label} · ${item.label}` : undefined}
                    className={({ isActive }) =>
                      `flex items-center gap-3 px-2.5 min-h-[40px] rounded-md text-sm transition-colors whitespace-nowrap ${
                        isActive
                          ? 'bg-[#DC172B] text-white font-semibold'
                          : 'text-[#D4D4D8] hover:text-white hover:bg-[#202027] font-medium'
                      }`
                    }
                  >
                    {({ isActive }) => (
                      <>
                        <Icon
                          className={`w-4 h-4 shrink-0 ${
                            isActive ? 'text-white' : 'text-[#A1A1AA]'
                          }`}
                        />
                        {!collapsed && <span className="truncate">{item.label}</span>}
                      </>
                    )}
                  </NavLink>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="p-3 border-t border-white/8 space-y-1 shrink-0">
          <Link
            to="/"
            title={collapsed ? 'Portal Público' : undefined}
            className="flex items-center gap-2.5 px-2.5 min-h-[40px] rounded-md text-xs font-medium text-[#A1A1AA] hover:text-white hover:bg-[#202027] transition-colors whitespace-nowrap"
          >
            <ExternalLink className="w-4 h-4 shrink-0" />
            {!collapsed && <span>Portal Público</span>}
          </Link>
          <button
            type="button"
            onClick={() => void handleSignOut()}
            title={collapsed ? 'Sair da conta' : undefined}
            className="w-full flex items-center gap-2.5 px-2.5 min-h-[40px] rounded-md text-xs font-medium text-[#A1A1AA] hover:text-[#EF3340] hover:bg-[#202027] transition-colors whitespace-nowrap"
          >
            <LogOut className="w-4 h-4 shrink-0" />
            {!collapsed && <span>Sair da conta</span>}
          </button>
        </div>
      </aside>

      {/* Main Content Shell */}
      <div className="flex-1 flex flex-col min-w-0 pb-16 md:pb-0">
        <header className="h-14 md:h-16 border-b border-white/8 bg-[#0D0D10]/95 backdrop-blur-sm px-3 sm:px-6 flex items-center justify-between gap-3 sticky top-0 z-30">
          <div className="flex items-center gap-2.5 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              className="md:hidden min-w-[44px] min-h-[44px] flex items-center justify-center rounded-md bg-[#15151A] border border-white/10 text-[#D4D4D8] hover:text-white transition-colors shrink-0"
              aria-label="Abrir menu do painel"
              aria-expanded={mobileMenuOpen}
            >
              <Menu className="w-5 h-5" />
            </button>

            <nav aria-label="Localização atual" className="min-w-0">
              <ol className="flex items-center gap-2 text-sm min-w-0">
                <li className="hidden sm:inline text-[#71717A] whitespace-nowrap shrink-0">
                  {activeMeta?.group.label || 'Painel'}
                </li>
                <li
                  className="hidden sm:inline text-[#52525B] shrink-0"
                  aria-hidden="true"
                >
                  /
                </li>
                <li className="font-semibold text-white truncate">
                  {activeMeta?.item.label || 'Visão geral'}
                </li>
              </ol>
            </nav>
          </div>

          <div className="flex items-center gap-2.5 sm:gap-3 shrink-0">
            {canUseSystemSearch && (
              <form
                onSubmit={handleGlobalSearch}
                className="hidden lg:block w-64 relative"
              >
                <Search className="w-4 h-4 text-[#71717A] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="search"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  placeholder="Buscar em Sistema..."
                  className="w-full bg-[#15151A] border border-white/10 rounded-md pl-9 pr-3 py-1.5 text-sm text-white placeholder:text-[#71717A] focus:border-[#DC172B] focus:outline-none"
                  aria-label="Buscar no módulo de sistema"
                />
              </form>
            )}

            <Link
              to="/painel/notificacoes"
              className="min-w-[40px] min-h-[40px] flex items-center justify-center rounded-md bg-[#15151A] border border-white/10 text-[#A1A1AA] hover:text-white hover:border-white/20 transition-colors"
              aria-label="Central de avisos"
              title="Central de avisos"
            >
              <Bell className="w-4 h-4" />
            </Link>

            <Link
              to="/painel/perfil"
              className="flex items-center gap-2.5 pl-2 pr-2.5 sm:pr-3 min-h-[40px] rounded-md bg-[#15151A] border border-white/10 hover:border-white/20 transition-colors"
            >
              {publicProfile?.avatarUrl ? (
                <img
                  src={publicProfile.avatarUrl}
                  alt={displayName}
                  referrerPolicy="no-referrer"
                  className="w-7 h-7 rounded object-cover shrink-0"
                />
              ) : (
                <div className="w-7 h-7 rounded bg-[#202027] flex items-center justify-center text-xs font-bold text-white shrink-0">
                  {displayName.slice(0, 1).toUpperCase()}
                </div>
              )}
              <div className="hidden sm:block text-left leading-tight">
                <p className="text-xs font-semibold text-white max-w-[130px] truncate">
                  {displayName}
                </p>
                <p className="text-[11px] text-[#A1A1AA] max-w-[150px] truncate">
                  {primaryRoleLabel}
                </p>
              </div>
            </Link>
          </div>
        </header>

        <main className="flex-1 px-4 py-5 sm:px-6 sm:py-6 max-w-7xl w-full mx-auto">
          <Outlet />
        </main>
      </div>

      {/* Mobile Bottom Navigation (<= 15% viewport height) */}
      <nav
        aria-label="Ações principais do painel"
        className="md:hidden fixed bottom-0 inset-x-0 z-40 h-14 bg-[#15151A] border-t border-white/10 grid grid-cols-5 items-center"
      >
        <NavLink
          to="/painel"
          end
          className={({ isActive }) =>
            `flex flex-col items-center justify-center gap-0.5 min-h-[44px] text-[11px] transition-colors ${
              isActive ? 'text-[#EF3340] font-semibold' : 'text-[#A1A1AA]'
            }`
          }
        >
          <LayoutDashboard className="w-4 h-4" />
          <span>Início</span>
        </NavLink>
        <NavLink
          to="/painel/organizacao"
          className={({ isActive }) =>
            `flex flex-col items-center justify-center gap-0.5 min-h-[44px] text-[11px] transition-colors ${
              isActive ? 'text-[#EF3340] font-semibold' : 'text-[#A1A1AA]'
            }`
          }
        >
          <Users className="w-4 h-4" />
          <span>Equipes</span>
        </NavLink>
        <NavLink
          to="/painel/competitivo"
          className={({ isActive }) =>
            `flex flex-col items-center justify-center gap-0.5 min-h-[44px] text-[11px] transition-colors ${
              isActive ? 'text-[#EF3340] font-semibold' : 'text-[#A1A1AA]'
            }`
          }
        >
          <Trophy className="w-4 h-4" />
          <span>Jogos</span>
        </NavLink>
        <NavLink
          to="/painel/recrutamento"
          className={({ isActive }) =>
            `flex flex-col items-center justify-center gap-0.5 min-h-[44px] text-[11px] transition-colors ${
              isActive ? 'text-[#EF3340] font-semibold' : 'text-[#A1A1AA]'
            }`
          }
        >
          <UserCheck className="w-4 h-4" />
          <span>Vagas</span>
        </NavLink>
        <button
          type="button"
          onClick={() => setMobileMenuOpen(true)}
          className={`flex flex-col items-center justify-center gap-0.5 min-h-[44px] text-[11px] transition-colors ${
            mobileMenuOpen ? 'text-[#EF3340] font-semibold' : 'text-[#A1A1AA]'
          }`}
          aria-label="Abrir todos os módulos"
        >
          <Menu className="w-4 h-4" />
          <span>Menu</span>
        </button>
      </nav>

      {/* Mobile Collapsible Navigation Drawer */}
      {mobileMenuOpen && (
        <div
          className="md:hidden fixed inset-0 z-50 bg-black/75 flex"
          role="dialog"
          aria-modal="true"
          aria-label="Menu do painel NXF"
          onClick={(e) => {
            if (e.target === e.currentTarget) setMobileMenuOpen(false);
          }}
        >
          <div className="w-80 max-w-[85vw] bg-[#15151A] h-full flex flex-col border-r border-white/10">
            <div className="px-4 py-3.5 flex items-center justify-between border-b border-white/8">
              <div className="flex items-center gap-2.5 min-w-0">
                <BrandMark logoUrl={siteContent.brandLogoUrl} size="sm" />
                <div className="min-w-0">
                  <p className="font-display text-lg font-bold text-white leading-tight truncate">
                    NXF Painel
                  </p>
                  <p className="text-xs text-[#A1A1AA] truncate">
                    {displayName} · {primaryRoleLabel}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setMobileMenuOpen(false)}
                className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded-md bg-[#202027] text-[#D4D4D8] hover:text-white"
                aria-label="Fechar menu"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {canUseSystemSearch && (
              <form
                onSubmit={(e) => {
                  handleGlobalSearch(e);
                  setMobileMenuOpen(false);
                }}
                className="px-4 pt-3 pb-1"
              >
                <div className="relative">
                  <Search className="w-4 h-4 text-[#71717A] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    type="search"
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    placeholder="Buscar em Sistema..."
                    className="w-full bg-[#0D0D10] border border-white/12 rounded-md pl-9 pr-3 py-2 text-sm text-white placeholder:text-[#71717A] focus:border-[#DC172B] focus:outline-none"
                    aria-label="Buscar no módulo de sistema"
                  />
                </div>
              </form>
            )}

            <nav
              aria-label="Navegação completa do painel"
              className="flex-1 overflow-y-auto px-3 py-4 space-y-5"
            >
              {visibleGroups.map((group) => (
                <div key={group.id} className="space-y-1">
                  <p className="px-2.5 pb-1 text-xs font-semibold text-[#71717A]">
                    {group.label}
                  </p>
                  {group.items.map((item) => {
                    const Icon = NAV_ICONS[item.icon];
                    return (
                      <NavLink
                        key={item.to}
                        to={item.to}
                        end={item.end}
                        onClick={() => setMobileMenuOpen(false)}
                        className={({ isActive }) =>
                          `flex items-center gap-3 px-3 min-h-[44px] rounded-md text-sm transition-colors ${
                            isActive
                              ? 'bg-[#DC172B] text-white font-semibold'
                              : 'text-[#D4D4D8] hover:text-white hover:bg-[#202027] font-medium'
                          }`
                        }
                      >
                        {({ isActive }) => (
                          <>
                            <Icon
                              className={`w-4 h-4 shrink-0 ${
                                isActive ? 'text-white' : 'text-[#A1A1AA]'
                              }`}
                            />
                            <span className="truncate">{item.label}</span>
                          </>
                        )}
                      </NavLink>
                    );
                  })}
                </div>
              ))}
            </nav>

            <div className="p-3 border-t border-white/8 space-y-2">
              <Link
                to="/"
                onClick={() => setMobileMenuOpen(false)}
                className="flex items-center justify-center gap-2 min-h-[44px] px-4 bg-[#202027] hover:bg-[#2B2B35] rounded-md text-xs font-semibold text-white transition-colors"
              >
                <ExternalLink className="w-4 h-4" />
                <span>Ir ao Portal Público</span>
              </Link>
              <button
                type="button"
                onClick={() => void handleSignOut()}
                className="w-full flex items-center justify-center gap-2 min-h-[44px] px-4 text-xs font-semibold text-[#EF3340] bg-[#202027] hover:bg-[#2B2B35] rounded-md transition-colors"
              >
                <LogOut className="w-4 h-4" />
                <span>Sair da conta</span>
              </button>
            </div>
          </div>
        </div>
      )}

      <OfflineIndicator />
    </div>
  );
}
