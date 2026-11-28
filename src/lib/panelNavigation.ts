import type { UnifiedCapabilities } from './permissions';

export type NavGroupId = 'overview' | 'operations' | 'content' | 'administration';

export type NavIconKey =
  | 'dashboard'
  | 'profile'
  | 'notifications'
  | 'organization'
  | 'competitive'
  | 'trainings'
  | 'recruitment'
  | 'studio'
  | 'system';

export interface PanelNavItem {
  id: string;
  label: string;
  shortLabel: string;
  description: string;
  to: string;
  icon: NavIconKey;
  end?: boolean;
  visible: boolean;
}

export interface PanelNavGroup {
  id: NavGroupId;
  label: string;
  items: PanelNavItem[];
}

/**
 * Resolve a árvore de navegação do painel privado agrupada por domínio
 * (Visão Geral, Operação, Conteúdo e Administração), preservando rigorosamente
 * as rotas existentes e o escopo autorizado para cada cargo.
 */
export function buildPanelNavigation(capabilities: UnifiedCapabilities): PanelNavGroup[] {
  const allGroups: PanelNavGroup[] = [
    {
      id: 'overview',
      label: 'Visão Geral',
      items: [
        {
          id: 'dashboard',
          label: 'Visão geral',
          shortLabel: 'Início',
          description: 'Pendências operacionais e resumo do painel.',
          to: '/painel',
          icon: 'dashboard',
          end: true,
          visible: true,
        },
        {
          id: 'profile',
          label: 'Meu perfil',
          shortLabel: 'Perfil',
          description: 'Avatar, banner, bio, layout público e Brawl Tag.',
          to: '/painel/perfil',
          icon: 'profile',
          visible: true,
        },
        {
          id: 'notifications',
          label: 'Central de avisos',
          shortLabel: 'Avisos',
          description: 'Notificações operacionais e preferências de alertas.',
          to: '/painel/notificacoes',
          icon: 'notifications',
          visible: true,
        },
      ],
    },
    {
      id: 'operations',
      label: 'Operação',
      items: [
        {
          id: 'organization',
          label: 'Equipes e elencos',
          shortLabel: 'Equipes',
          description: 'Divisões, integrantes ativos, visibilidade e convites.',
          to: '/painel/organizacao',
          icon: 'organization',
          visible: capabilities.isOfficialMember,
        },
        {
          id: 'competitive',
          label: 'Torneios e partidas',
          shortLabel: 'Jogos',
          description: 'Campeonatos, placares oficiais e fila do Match Tracker.',
          to: '/painel/competitivo',
          icon: 'competitive',
          visible: capabilities.isOfficialMember,
        },
        {
          id: 'trainings',
          label: 'Treinamentos',
          shortLabel: 'Treinos',
          description: 'Agenda de treinos, confirmações e presença da equipe.',
          to: '/painel/treinamentos',
          icon: 'trainings',
          visible: capabilities.isOfficialMember,
        },
        {
          id: 'recruitment',
          label: 'Recrutamento',
          shortLabel: 'Vagas',
          description: 'Vagas abertas e triagem de candidaturas.',
          to: '/painel/recrutamento',
          icon: 'recruitment',
          visible: true,
        },
      ],
    },
    {
      id: 'content',
      label: 'Conteúdo',
      items: [
        {
          id: 'studio',
          label: 'Portal e CMS',
          shortLabel: 'Studio',
          description: 'Banners, notícias, patrocinadores e seções públicas.',
          to: '/painel/studio',
          icon: 'studio',
          visible: capabilities.canManageCms,
        },
      ],
    },
    {
      id: 'administration',
      label: 'Administração',
      items: [
        {
          id: 'system',
          label: 'Sistema e suporte',
          shortLabel: 'Sistema',
          description: 'Usuários, cargos, auditoria, integrações e chamados.',
          to: '/painel/system',
          icon: 'system',
          visible: capabilities.canAccessSystem || capabilities.isAnyAdmin,
        },
      ],
    },
  ];

  return allGroups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => item.visible),
    }))
    .filter((group) => group.items.length > 0);
}

/**
 * Localiza o grupo e o item ativos com base no pathname atual para breadcumbs e título contextual.
 */
export function resolveActiveNavItem(
  groups: PanelNavGroup[],
  pathname: string
): { group: PanelNavGroup; item: PanelNavItem } | null {
  const normalizedPath = pathname.replace(/\/+$/, '') || '/painel';
  for (const group of groups) {
    for (const item of group.items) {
      if (item.end) {
        if (normalizedPath === item.to) return { group, item };
      } else if (
        normalizedPath === item.to ||
        normalizedPath.startsWith(`${item.to}/`)
      ) {
        return { group, item };
      }
    }
  }
  return null;
}

export const TEAM_ROLE_LABELS: Record<
  'manager' | 'coach' | 'starter' | 'reserve' | 'analyst',
  string
> = {
  starter: 'Titular',
  reserve: 'Reserva',
  coach: 'Técnico',
  manager: 'Gerente',
  analyst: 'Analista',
};

export function formatTeamRoleLabel(role: string | undefined): string {
  if (!role) return 'Integrante';
  return TEAM_ROLE_LABELS[role as keyof typeof TEAM_ROLE_LABELS] || role;
}
