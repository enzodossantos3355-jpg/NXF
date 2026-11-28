import type { PublicProfile, Team, TeamMembership, UserPrivate } from '../types/nxf';

export interface SelectableMember {
  uid: string;
  displayName: string;
  fullName?: string;
  code?: string;
  brawlTag?: string;
  source: 'users' | 'publicProfiles' | 'memberships';
}

export type TeamVisibilityState = 'public' | 'internal' | 'unknown';

export function resolveTeamVisibility(team: Partial<Team>): TeamVisibilityState {
  if (typeof team.isPublic !== 'boolean') return 'unknown';
  return team.isPublic ? 'public' : 'internal';
}

export function formatTeamVisibilityLabel(team: Partial<Team>): string {
  const state = resolveTeamVisibility(team);
  if (state === 'public') return 'Pública no portal';
  if (state === 'internal') return 'Interna';
  return 'Visibilidade não definida';
}

export function isTeamActive(team: Partial<Team>): boolean {
  return team.active !== false;
}

export function buildMemberDirectory(params: {
  users?: UserPrivate[];
  publicProfiles?: PublicProfile[];
  memberships?: TeamMembership[];
}): SelectableMember[] {
  const byUid = new Map<string, SelectableMember>();

  // 1. Base de users privados (quando o cargo possui permissão users.read/users.manage/primary_admin)
  for (const u of params.users || []) {
    if (!u.uid || u.status === 'suspended') continue;
    byUid.set(u.uid, {
      uid: u.uid,
      displayName: (u.displayName || u.fullName || u.uid).trim(),
      fullName: u.fullName?.trim() || undefined,
      code: u.code?.trim() || undefined,
      brawlTag: u.brawlTag?.trim() || undefined,
      source: 'users',
    });
  }

  // 2. Perfis públicos (acessível para gerentes e admins)
  for (const p of params.publicProfiles || []) {
    if (!p.uid) continue;
    const existing = byUid.get(p.uid);
    if (existing) {
      byUid.set(p.uid, {
        ...existing,
        displayName: existing.displayName || p.nickname || p.uid,
        brawlTag: existing.brawlTag || p.brawlTag?.trim() || undefined,
      });
    } else {
      byUid.set(p.uid, {
        uid: p.uid,
        displayName: (p.nickname || p.uid).trim(),
        brawlTag: p.brawlTag?.trim() || undefined,
        source: 'publicProfiles',
      });
    }
  }

  // 3. Membros já presentes em elencos ativos (garante cobertura de integrantes legados)
  for (const m of params.memberships || []) {
    if (!m.uid || byUid.has(m.uid)) continue;
    byUid.set(m.uid, {
      uid: m.uid,
      displayName: (m.nickname || m.uid).trim(),
      source: 'memberships',
    });
  }

  return Array.from(byUid.values()).sort((a, b) =>
    a.displayName.localeCompare(b.displayName, 'pt-BR', { sensitivity: 'base' })
  );
}

export function filterMemberDirectory(
  directory: SelectableMember[],
  rawQuery: string
): SelectableMember[] {
  const term = rawQuery.trim().toLowerCase();
  if (!term) return directory;
  const normalizedTag = term.replace(/^#+/, '');

  return directory.filter((member) => {
    const nameMatch = member.displayName.toLowerCase().includes(term);
    const fullNameMatch = (member.fullName || '').toLowerCase().includes(term);
    const codeMatch = (member.code || '')
      .toLowerCase()
      .replace(/^#+/, '')
      .includes(normalizedTag);
    const tagMatch = (member.brawlTag || '')
      .toLowerCase()
      .replace(/^#+/, '')
      .includes(normalizedTag);
    const uidMatch = member.uid.toLowerCase().includes(term);
    return nameMatch || fullNameMatch || codeMatch || tagMatch || uidMatch;
  });
}

export function slugifyTeamId(rawName: string): string {
  return rawName
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 48);
}
