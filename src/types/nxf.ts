export type UserRole =
  | 'primary_admin'
  | 'delegated_admin'
  | 'manager'
  | 'coach'
  | 'player'
  | 'candidate';

export type ProfileLayout = 'classic' | 'competitive' | 'minimal';

export type ApplicationStage =
  | 'recebida'
  | 'em_analise'
  | 'em_teste'
  | 'aprovada'
  | 'rejeitada';

export type MatchFormat = 'MD3' | 'MD5' | 'MD7';

export const BLUEPRINT_LIMITS = {
  ID_REGEX: /^[a-zA-Z0-9_-]+$/,
  SLUG_REGEX: /^[a-z0-9-]+$/,
  CODE_REGEX: /^#?[A-Za-z0-9_-]{3,20}$/,
  FULL_NAME_MAX: 80,
  DISPLAY_NAME_MAX: 32,
  NICKNAME_MAX: 32,
  BIO_MAX: 500,
  BRAWL_TAG_MAX: 20,
  CODE_MAX: 24,
  URL_MAX: 1000,
  TEAM_NAME_MAX: 60,
  TEAM_DESC_MAX: 1000,
  HERO_TITLE_MAX: 140,
  HERO_SUBTITLE_MAX: 400,
  ABOUT_BODY_MAX: 4000,
  NEWS_TITLE_MAX: 140,
  NEWS_SUMMARY_MAX: 300,
  NEWS_CONTENT_MAX: 20000,
  TICKET_SUBJECT_MAX: 120,
  TICKET_DESC_MAX: 2000,
  JUSTIFICATION_MAX: 400,
  NOTES_MAX: 2000,
} as const;

export function normalizePlayerCode(rawCode: string): string {
  return rawCode.trim().replace(/^#+/, '').replace(/[^a-zA-Z0-9_-]/g, '').toUpperCase();
}

export function formatPlayerCode(rawCode: string): string {
  const clean = normalizePlayerCode(rawCode);
  return clean ? `#${clean}` : '';
}

export function codeToInternalAuthId(rawCode: string): string {
  const clean = normalizePlayerCode(rawCode).toLowerCase();
  return `${clean}@auth.nxf-esports.local`;
}

export interface UserPrivate {
  uid: string;
  fullName: string;
  displayName: string;
  code: string;
  email?: string;
  roles: UserRole[];
  delegatedPermissions?: string[];
  teamIds?: string[];
  status: 'active' | 'suspended' | 'pending_verification';
  brawlTag?: string;
  brawlTagStatus?: 'none' | 'pending' | 'approved' | 'rejected';
  authProviders?: string[];
  hasLocalPassword?: boolean;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface AdminGrant {
  uid: string;
  role: 'primary_admin' | 'delegated_admin';
  permissions?: string[];
  active: boolean;
  grantedBy: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface PublicProfile {
  uid: string;
  nickname: string;
  publicRole: string;
  avatarUrl?: string;
  bannerUrl?: string;
  bio?: string;
  layout: ProfileLayout;
  teamIds?: string[];
  brawlTag?: string;
  brawlTagApproved?: boolean;
  socialLinks?: {
    twitter?: string;
    instagram?: string;
    youtube?: string;
    twitch?: string;
    discord?: string;
  };
  isActiveMember: boolean;
  showInEntrySelector: boolean;
  moderationStatus: 'approved' | 'pending' | 'hidden';
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface Team {
  id: string;
  name: string;
  category: string;
  description?: string;
  logoUrl?: string;
  bannerUrl?: string;
  isPublic: boolean;
  active: boolean;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface TeamMembership {
  id?: string;
  teamId: string;
  uid: string;
  nickname: string;
  roleInTeam: 'manager' | 'coach' | 'starter' | 'reserve' | 'analyst';
  status: 'active' | 'inactive' | 'transferred';
  joinedAt?: unknown;
  endedAt?: unknown;
}

export interface Invitation {
  id?: string;
  codeHash?: string;
  targetCode: string;
  targetEmail?: string;
  assignedRoles: UserRole[];
  teamId?: string;
  roleInTeam?: 'manager' | 'coach' | 'starter' | 'reserve' | 'analyst' | 'none';
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  expiresAt: unknown;
  createdBy: string;
  acceptedBy?: string;
  createdAt?: unknown;
}

export interface Vacancy {
  id: string;
  teamId: string;
  teamName: string;
  title: string;
  roleTarget: string;
  requirements?: string;
  customFields?: string[];
  deadline?: unknown;
  status: 'open' | 'closed' | 'archived';
  createdBy: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface Application {
  id: string;
  vacancyId: string;
  teamId: string;
  applicantUid: string;
  applicantName: string;
  brawlTag?: string;
  answers?: Record<string, string>;
  stage: ApplicationStage;
  internalNotes?: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface Tournament {
  id: string;
  name: string;
  organizer?: string;
  format: 'MD3' | 'MD5' | 'MD7' | 'Pontos Corridos' | 'Chave Dupla';
  status: 'upcoming' | 'ongoing' | 'completed';
  startDate?: unknown;
  isPublic: boolean;
  standings?: Array<{ position: number; team: string; points: number; wins: number; losses: number }>;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface Match {
  id: string;
  tournamentId?: string;
  tournamentName?: string;
  teamId: string;
  teamName: string;
  opponentName: string;
  format: MatchFormat;
  scheduledAt: unknown;
  status: 'scheduled' | 'live_manual' | 'completed' | 'cancelled';
  nxfScore?: number;
  opponentScore?: number;
  maps?: Array<{ mode: string; map: string; winner?: 'nxf' | 'opponent' }>;
  lineupUids?: string[];
  isPublic: boolean;
  enteredBy: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface Training {
  id: string;
  teamId: string;
  teamName?: string;
  title: string;
  objectives?: string;
  scheduledAt: unknown;
  durationMinutes?: number;
  status: 'scheduled' | 'completed' | 'cancelled';
  createdBy: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface Attendance {
  id: string;
  trainingId: string;
  teamId: string;
  uid: string;
  nickname?: string;
  playerStatus: 'pending' | 'confirmed' | 'declined';
  justification?: string;
  coachVerifiedStatus: 'unmarked' | 'present' | 'absent' | 'justified';
  verifiedBy?: string;
  updatedAt?: unknown;
}

export interface NotificationItem {
  id: string;
  recipientUid: string;
  title: string;
  body: string;
  category: 'system' | 'training' | 'match' | 'recruitment' | 'admin';
  targetRoute?: string;
  read: boolean;
  dedupKey?: string;
  createdAt?: unknown;
}

export interface Achievement {
  id: string;
  title: string;
  tournamentName?: string;
  placement: string;
  teamId?: string;
  achievedAt: unknown;
  isPublic: boolean;
  createdBy: string;
}

export interface SiteContent {
  heroTitle: string;
  heroSubtitle: string;
  heroDesktopImage?: string;
  heroMobileImage?: string;
  heroPrimaryCtaLabel?: string;
  heroPrimaryCtaTo?: string;
  brandLogoUrl?: string;
  aboutTitle?: string;
  aboutBody?: string;
  socialLinks?: {
    twitter?: string;
    instagram?: string;
    youtube?: string;
    discord?: string;
    tiktok?: string;
  };
  sectionOrder?: string[];
  visibleSections?: Record<string, boolean>;
  version: number;
  updatedBy: string;
  updatedAt?: unknown;
}

export interface NewsArticle {
  id: string;
  slug: string;
  title: string;
  summary: string;
  content: string;
  coverImageUrl?: string;
  category?: string;
  status: 'draft' | 'scheduled' | 'published';
  publishedAt?: unknown;
  authorUid: string;
  authorName?: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface Sponsor {
  id: string;
  name: string;
  tier?: string;
  logoUrl?: string;
  websiteUrl?: string;
  active: boolean;
  order?: number;
  createdAt?: unknown;
}

export interface AuditLog {
  id: string;
  actorUid: string;
  actorLabel?: string;
  action: string;
  entityType: string;
  entityId: string;
  summary: string;
  createdAt?: unknown;
}

export interface SupportTicket {
  id: string;
  requesterUid: string;
  requesterName?: string;
  subject: string;
  category: 'acesso' | 'bug' | 'brawl_tag' | 'integracao' | 'outro';
  description: string;
  status: 'aberto' | 'em_andamento' | 'resolvido';
  adminResolution?: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface SystemSettings {
  enabledModules: Record<string, boolean>;
  brawlApiSyncIntervalHours?: number;
  brawlApiConfigured?: boolean;
  cloudFunctionsConfigured?: boolean;
  primaryAdminCount?: number;
  updatedBy: string;
  updatedAt?: unknown;
}

export interface BackupJob {
  id: string;
  type: 'export' | 'restore';
  status: 'pending_config' | 'queued' | 'completed' | 'failed';
  operationName?: string;
  requestedBy: string;
  notes?: string;
  createdAt?: unknown;
}

export interface PlayerStats {
  uid: string;
  brawlTag: string;
  trophies?: number;
  highestTrophies?: number;
  victories3v3?: number;
  soloVictories?: number;
  duoVictories?: number;
  syncStatus: 'ok' | 'pending_config' | 'error';
  lastSyncedAt?: unknown;
}
