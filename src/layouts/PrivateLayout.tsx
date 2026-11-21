import React, { useMemo, useState } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
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

interface NavGroup {
  group: string;
  visible: boolean;
  items: Array<{
    label: string;
    to: string;
    icon: React.ComponentType<{ className?: string }>;
    end?: boolean;
  }>;
}

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

  const [collapsed, setCollapsed] = useState(false);
  const [mobileModulesOpen, setMobileModulesOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');

  const navGroups: NavGroup[] = useMemo(
    () => [
      {
        group: 'Visão geral',
        visible: true,
        items: [
          { label: 'Painel', to: '/painel', icon: LayoutDashboard, end: true },
          { label: 'Meu perfil', to: '/painel/perfil', icon: UserCircle },
        ],
      },
      {
        group: 'Organização',
        visible: capabilities.isOfficialMember,
        items: [{ label: 'Equipes e elencos', to: '/painel/organizacao', icon: Users }],
      },
      {
        group: 'Competitivo',
        visible: capabilities.isOfficialMember,
        items: [{ label: 'Torneios e partidas', to: '/painel/competitivo', icon: Trophy }],
      },
      {
        group: 'Treinamentos',
        visible: capabilities.isOfficialMember,
        items: [{ label: 'Agenda e presenças', to: '/painel/treinamentos', icon: CalendarClock }],
      },
      {
        group: 'Recrutamento',
        visible: true,
        items: [{ label: 'Vagas e candidaturas', to: '/painel/recrutamento', icon: UserCheck }],
      },
      {
        group: 'Notificações',
        visible: true,
        items: [{ label: 'Central de avisos', to: '/painel/notificacoes', icon: Bell }],
      },
      {
        group: 'NXF Studio',
        visible: capabilities.canManageCms,
        items: [{ label: 'Portal e CMS', to: '/painel/studio', icon: Palette }],
      },
      {
        group: 'NXF System',
        visible: capabilities.canAccessSystem || capabilities.isAnyAdmin,
        items: [{ label: 'Sistema e suporte', to: '/painel/system', icon: Settings }],
      },
    ],
    [capabilities]
  );

  const visibleGroups = navGroups.filter((g) => g.visible);

  const handleGlobalSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const q = searchTerm.trim();
    if (!q) return;
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
        className={`hidden md:flex flex-col border-r border-white/8 bg-[#15151A] shrink-0 transition-all duration-150 ${
          collapsed ? 'w-[72px]' : 'w-64'
        }`}
      >
        <div className="h-16 px-4 flex items-center justify-between border-b border-white/8">
          <Link to="/painel" className="flex items-center gap-2.5 min-w-0">
            <BrandMark logoUrl={siteContent.brandLogoUrl} size="sm" />
            {!collapsed && (
              <span className="font-display text-lg font-bold tracking-tight truncate">
                NXF Painel
              </span>
            )}
          </Link>
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            className="p-1.5 rounded bg-[#202027] hover:bg-[#2B2B35] text-[#A1A1AA] hover:text-white"
            aria-label={collapsed ? 'Expandir menu lateral' : 'Recolher menu lateral'}
          >
            {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
          </button>
        </div>

        <nav
          aria-label="Módulos do painel"
          className="flex-1 overflow-y-auto px-3 py-4 space-y-5"
        >
          {visibleGroups.map((group) => (
            <div key={group.group} className="space-y-1">
              {!collapsed && (
                <p className="px-2 text-[11px] font-semibold text-[#71717A] tracking-wide">
                  {group.group}
                </p>
              )}
              {group.items.map((item) => {
                const Icon = item.icon;
                return (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.end}
                    title={collapsed ? item.label : undefined}
                    className={({ isActive }) =>
                      `flex items-center gap-3 px-2.5 py-2 rounded-md text-sm font-medium transition-colors whitespace-nowrap ${
                        isActive
                          ? 'bg-[#DC172B] text-white'
                          : 'text-[#A1A1AA] hover:text-white hover:bg-[#202027]'
                      }`
                    }
                  >
                    <Icon className="w-4 h-4 shrink-0" />
                    {!collapsed && <span className="truncate">{item.label}</span>}
                  </NavLink>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="p-3 border-t border-white/8 space-y-2">
          <Link
            to="/"
            className="flex items-center gap-2.5 px-2.5 py-2 rounded-md text-xs font-medium text-[#A1A1AA] hover:text-white hover:bg-[#202027]"
          >
            <ExternalLink className="w-4 h-4 shrink-0" />
            {!collapsed && <span>Portal Público</span>}
          </Link>
          <button
            type="button"
            onClick={() => void handleSignOut()}
            className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md text-xs font-medium text-[#A1A1AA] hover:text-[#EF3340] hover:bg-[#202027]"
          >
            <LogOut className="w-4 h-4 shrink-0" />
            {!collapsed && <span>Sair da conta</span>}
          </button>
        </div>
      </aside>

      {/* Main Content Shell */}
      <div className="flex-1 flex flex-col min-w-0 pb-16 md:pb-0">
        <header className="h-16 border-b border-white/8 bg-[#0D0D10] px-4 sm:px-6 flex items-center justify-between gap-4 sticky top-0 z-30">
          <form onSubmit={handleGlobalSearch} className="flex-1 max-w-md relative">
            <Search className="w-4 h-4 text-[#71717A] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="search"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Buscar no painel autorizado..."
              className="w-full bg-[#15151A] border border-white/10 rounded-md pl-9 pr-3 py-1.5 text-sm text-white placeholder:text-[#71717A] focus:border-[#DC172B] focus:outline-none"
              aria-label="Busca global do painel"
            />
          </form>

          <div className="flex items-center gap-3 shrink-0">
            <Link
              to="/painel/notificacoes"
              className="p-2 rounded-md bg-[#15151A] border border-white/10 text-[#A1A1AA] hover:text-white transition-colors"
              aria-label="Notificações"
            >
              <Bell className="w-4 h-4" />
            </Link>

            <Link
              to="/painel/perfil"
              className="flex items-center gap-2.5 pl-2 pr-3 py-1.5 rounded-md bg-[#15151A] border border-white/10 hover:border-white/20 transition-colors"
            >
              {publicProfile?.avatarUrl ? (
                <img
                  src={publicProfile.avatarUrl}
                  alt={displayName}
                  referrerPolicy="no-referrer"
                  className="w-6 h-6 rounded object-cover"
                />
              ) : (
                <div className="w-6 h-6 rounded bg-[#202027] flex items-center justify-center text-xs font-bold text-white">
                  {displayName.slice(0, 1).toUpperCase()}
                </div>
              )}
              <div className="hidden sm:block text-left leading-tight">
                <p className="text-xs font-semibold text-white max-w-[120px] truncate">
                  {displayName}
                </p>
                <p className="text-[11px] text-[#A1A1AA] max-w-[140px] truncate">
                  {primaryRoleLabel}
                </p>
              </div>
            </Link>
          </div>
        </header>

        <main className="flex-1 p-4 sm:p-6 max-w-7xl w-full mx-auto">
          <Outlet />
        </main>
      </div>

      {/* Mobile Bottom Navigation (<= 15% viewport height) */}
      <nav
        aria-label="Navegação móvel do painel"
        className="md:hidden fixed bottom-0 inset-x-0 z-40 h-14 bg-[#15151A] border-t border-white/10 grid grid-cols-5 items-center"
      >
        <NavLink
          to="/painel"
          end
          className={({ isActive }) =>
            `flex flex-col items-center justify-center gap-0.5 text-[11px] ${
              isActive ? 'text-[#EF3340] font-semibold' : 'text-[#A1A1AA]'
            }`
          }
        >
          <LayoutDashboard className="w-4 h-4" />
          <span>Painel</span>
        </NavLink>
        <NavLink
          to="/painel/competitivo"
          className={({ isActive }) =>
            `flex flex-col items-center justify-center gap-0.5 text-[11px] ${
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
            `flex flex-col items-center justify-center gap-0.5 text-[11px] ${
              isActive ? 'text-[#EF3340] font-semibold' : 'text-[#A1A1AA]'
            }`
          }
        >
          <UserCheck className="w-4 h-4" />
          <span>Vagas</span>
        </NavLink>
        <NavLink
          to="/painel/notificacoes"
          className={({ isActive }) =>
            `flex flex-col items-center justify-center gap-0.5 text-[11px] ${
              isActive ? 'text-[#EF3340] font-semibold' : 'text-[#A1A1AA]'
            }`
          }
        >
          <Bell className="w-4 h-4" />
          <span>Avisos</span>
        </NavLink>
        <button
          type="button"
          onClick={() => setMobileModulesOpen(true)}
          className="flex flex-col items-center justify-center gap-0.5 text-[11px] text-[#A1A1AA]"
        >
          <Menu className="w-4 h-4" />
          <span>Módulos</span>
        </button>
      </nav>

      {/* Mobile Full Modules Drawer */}
      {mobileModulesOpen && (
        <div
          className="md:hidden fixed inset-0 z-50 bg-black/80 flex justify-end"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-72 max-w-full bg-[#15151A] h-full p-4 flex flex-col border-l border-white/10">
            <div className="flex items-center justify-between pb-3 border-b border-white/8">
              <span className="font-display text-lg font-bold">Módulos NXF</span>
              <button
                type="button"
                onClick={() => setMobileModulesOpen(false)}
                className="p-1.5 rounded bg-[#202027]"
                aria-label="Fechar módulos"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto py-4 space-y-4">
              {visibleGroups.map((group) => (
                <div key={group.group} className="space-y-1">
                  <p className="text-[11px] font-semibold text-[#71717A] px-2">
                    {group.group}
                  </p>
                  {group.items.map((item) => {
                    const Icon = item.icon;
                    return (
                      <Link
                        key={item.to}
                        to={item.to}
                        onClick={() => setMobileModulesOpen(false)}
                        className="flex items-center gap-2.5 px-2.5 py-2 rounded-md text-sm text-[#A1A1AA] hover:text-white hover:bg-[#202027]"
                      >
                        <Icon className="w-4 h-4 shrink-0" />
                        <span>{item.label}</span>
                      </Link>
                    );
                  })}
                </div>
              ))}
            </div>
            <div className="pt-3 border-t border-white/8 space-y-2">
              <Link
                to="/"
                onClick={() => setMobileModulesOpen(false)}
                className="block text-center py-2 bg-[#202027] rounded text-xs font-medium"
              >
                Ir ao Portal Público
              </Link>
              <button
                type="button"
                onClick={() => void handleSignOut()}
                className="w-full py-2 text-xs font-medium text-[#EF3340] bg-[#202027] rounded"
              >
                Sair da conta
              </button>
            </div>
          </div>
        </div>
      )}

      <OfflineIndicator />
    </div>
  );
}
