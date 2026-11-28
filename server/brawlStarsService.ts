import crypto from 'node:crypto';
import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { getAdminServices } from './firebaseAdmin.ts';

const DEFAULT_SYNC_INTERVAL_HOURS = 6;
const LOCK_LEASE_MS = 10 * 60 * 1000; // 10 min lease against crashed workers
const RATE_LIMIT_DELAY_MS = 150;
const RETRY_BASE_DELAY_MS = 400;
const MAX_API_RETRIES = 2;
const JOB_DOC_PATH = 'systemJobs/brawlStarsSync';

export interface BrawlSyncResult {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  brawlApiConfigured: boolean;
  httpStatus?: number | null;
  error?: string | null;
  syncedCount: number;
  errorCount: number;
  newBattlesCount?: number;
  duplicateBattlesCount?: number;
  egressIpWarning?: string | null;
}

export interface BrawlTestResult {
  ok: boolean;
  brawlApiConfigured: boolean;
  httpStatus: number | null;
  error: string | null;
  playerName?: string;
  trophies?: number;
  egressProxyConfigured: boolean;
}

export interface BrawlPlayerLookupResult {
  ok: boolean;
  httpStatus: number | null;
  error: string | null;
  player?: {
    tag: string;
    name: string;
    trophies: number;
    highestTrophies: number;
    victories3v3: number;
    soloVictories: number;
    duoVictories: number;
    expLevel: number | null;
    clubTag: string | null;
    clubName: string | null;
    brawlersCount: number;
    topBrawlers: Array<{ name: string; trophies: number; highestTrophies: number; power: number }>;
  };
}

export interface BrawlBattlePlayer {
  tag: string;
  name: string;
  brawlerId: number | null;
  brawlerName: string;
  power: number | null;
  trophies: number | null;
}

export interface ParsedBrawlBattle {
  battleId: string;
  battleTime: string;
  battleTimeMs: number;
  mode: string;
  map: string;
  battleType: string;
  duration: number | null;
  starPlayerTag: string | null;
  teams: BrawlBattlePlayer[][];
  participantTags: string[];
  perspectives: Record<string, 'victory' | 'defeat' | 'draw' | 'unknown'>;
  sourceTag: string;
  sourceResult: 'victory' | 'defeat' | 'draw' | 'unknown';
}

export interface BrawlerStatSummary {
  brawlerName: string;
  battles: number;
  wins: number;
  losses: number;
  draws: number;
  winRate: number;
}

export interface MapStatSummary {
  map: string;
  mode: string;
  battles: number;
  wins: number;
  losses: number;
  winRate: number;
}

export interface ModeStatSummary {
  mode: string;
  battles: number;
  wins: number;
  losses: number;
  winRate: number;
}

export interface ComputedPlayerAnalytics {
  uid: string;
  displayName?: string;
  brawlTag: string;
  totalBattles: number;
  wins: number;
  losses: number;
  draws: number;
  winRate: number;
  brawlerStats: BrawlerStatSummary[];
  mapStats: MapStatSummary[];
  modeStats: ModeStatSummary[];
  lastBattleTime: string | null;
}

export interface ComputedTeamAnalytics {
  teamId: string;
  teamName: string;
  memberTags: string[];
  totalBattles: number;
  squadBattles: number;
  wins: number;
  losses: number;
  draws: number;
  winRate: number;
  brawlerStats: BrawlerStatSummary[];
  mapStats: MapStatSummary[];
  modeStats: ModeStatSummary[];
}

export interface BrawlStatusSnapshot {
  brawlTokenConfigured: boolean;
  brawlApiConfigured: boolean;
  egressProxyConfigured: boolean;
  apiBaseUrl: string;
  intervalHours: number;
  running: boolean;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastStatus: string;
  lastHttpStatus: number | null;
  lastError: string | null;
  lastSuccessCount: number;
  lastErrorCount: number;
  lastNewBattlesCount?: number;
}

export interface BrawlServiceDeps {
  db: Firestore;
  fetchImpl?: typeof fetch;
  token?: string;
  apiBaseUrl?: string;
  sleepImpl?: (ms: number) => Promise<void>;
  nowMs?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function resolveApiBaseUrl(override?: string): string {
  const raw =
    override ||
    process.env.BRAWL_STARS_API_BASE_URL?.trim() ||
    'https://api.brawlstars.com/v1';
  return raw.replace(/\/+$/, '');
}

export function normalizeBrawlTag(raw: unknown): string {
  const clean = String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9#]/g, '');
  if (!clean) return '';
  return clean.startsWith('#') ? clean : `#${clean}`;
}

export function classifySupercellFailure(status: number, bodyText: string): string {
  const lower = bodyText.toLowerCase();
  if (status === 403 && (lower.includes('invalidip') || lower.includes('ip'))) {
    return 'HTTP 403 (accessDenied.invalidIp): O IP de saída atual do servidor não está autorizado na chave da API da Supercell. Render Starter usa IPs dinâmicos; configure um proxy/relay de IP fixo em BRAWL_STARS_API_BASE_URL ou autorize os IPs de saída.';
  }
  if (status === 401 || status === 403) {
    return `HTTP ${status}: Token da API Brawl Stars rejeitado ou sem autorização (${bodyText.slice(0, 140)}).`;
  }
  if (status === 429) {
    return 'HTTP 429: Limite de requisições da API Brawl Stars atingido temporariamente.';
  }
  if (status >= 500) {
    return `HTTP ${status}: API oficial da Brawl Stars em manutenção ou indisponível.`;
  }
  return `HTTP ${status}: Falha na consulta à API Brawl Stars.`;
}

function formatTs(val: unknown): string | null {
  if (!val) return null;
  if (
    typeof val === 'object' &&
    val !== null &&
    'toDate' in val &&
    typeof (val as { toDate: () => Date }).toDate === 'function'
  ) {
    return (val as { toDate: () => Date }).toDate().toISOString();
  }
  if (val instanceof Date) return val.toISOString();
  if (typeof val === 'number') return new Date(val).toISOString();
  if (typeof val === 'string') return val;
  return null;
}

/**
 * Converte o timestamp oficial da Supercell (ex.: "20250412T183045.000Z") ou ISO padrão para epoch ms.
 */
export function parseBrawlBattleTimeMs(raw: unknown): number {
  const str = String(raw || '').trim();
  if (!str) return 0;

  const compact = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(?:\.(\d{3}))?Z$/i.exec(str);
  if (compact) {
    const [, y, m, d, hh, mm, ss, ms = '000'] = compact;
    const iso = `${y}-${m}-${d}T${hh}:${mm}:${ss}.${ms}Z`;
    const parsed = Date.parse(iso);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  const parsed = Date.parse(str);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Chave determinística de deduplicação de batalhas coletadas de múltiplos jogadores.
 */
export function computeBattleDedupId(
  battleTime: string,
  participantTags: string[],
  mode: string,
  map: string
): string {
  const sortedTags = Array.from(new Set(participantTags.map((t) => normalizeBrawlTag(t)).filter(Boolean))).sort();
  const canonical = `${battleTime.trim()}|${mode.trim().toLowerCase()}|${map.trim().toLowerCase()}|${sortedTags.join(',')}`;
  const hash = crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 24);
  return `b_${hash}`;
}

/**
 * Faz requisição à API oficial do Brawl Stars com retry controlado em 429/5xx/falha transitória.
 * Nunca repete 401/403/404.
 */
export async function fetchBrawlApiWithRetry(
  url: string,
  token: string,
  deps?: {
    fetchImpl?: typeof fetch;
    sleepImpl?: (ms: number) => Promise<void>;
    maxRetries?: number;
  }
): Promise<Response> {
  const fetchImpl = deps?.fetchImpl || fetch;
  const sleepImpl = deps?.sleepImpl || defaultSleep;
  const maxRetries = deps?.maxRetries ?? MAX_API_RETRIES;

  let lastError: unknown = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetchImpl(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
      });

      const retryableStatus = res.status === 429 || res.status >= 500;
      if (!retryableStatus || attempt === maxRetries) {
        return res;
      }

      const retryAfterSec = Number(res.headers.get('retry-after') || '0');
      const backoffMs =
        retryAfterSec > 0
          ? Math.min(5000, retryAfterSec * 1000)
          : RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
      await sleepImpl(backoffMs);
    } catch (err) {
      lastError = err;
      if (attempt === maxRetries) {
        throw err;
      }
      await sleepImpl(RETRY_BASE_DELAY_MS * Math.pow(2, attempt));
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Falha de rede na API Brawl Stars.');
}

interface RawSupercellBattlePlayer {
  tag?: unknown;
  name?: unknown;
  brawler?: {
    id?: unknown;
    name?: unknown;
    power?: unknown;
    trophies?: unknown;
  };
}

interface RawSupercellBattleItem {
  battleTime?: unknown;
  event?: {
    id?: unknown;
    mode?: unknown;
    map?: unknown;
  };
  battle?: {
    mode?: unknown;
    type?: unknown;
    result?: unknown;
    duration?: unknown;
    starPlayer?: { tag?: unknown } | null;
    teams?: RawSupercellBattlePlayer[][];
    players?: RawSupercellBattlePlayer[];
  };
}

function normalizeBattleResult(raw: unknown): 'victory' | 'defeat' | 'draw' | 'unknown' {
  const lower = String(raw || '').trim().toLowerCase();
  if (lower === 'victory') return 'victory';
  if (lower === 'defeat') return 'defeat';
  if (lower === 'draw') return 'draw';
  return 'unknown';
}

function parseRawBattlePlayer(raw: RawSupercellBattlePlayer): BrawlBattlePlayer | null {
  const tag = normalizeBrawlTag(raw?.tag);
  if (!tag) return null;
  const brawlerName = String(raw?.brawler?.name || '').trim();
  return {
    tag,
    name: String(raw?.name || '').trim() || tag,
    brawlerId: typeof raw?.brawler?.id === 'number' ? raw.brawler.id : null,
    brawlerName: brawlerName || 'Desconhecido',
    power: typeof raw?.brawler?.power === 'number' ? raw.brawler.power : null,
    trophies: typeof raw?.brawler?.trophies === 'number' ? raw.brawler.trophies : null,
  };
}

/**
 * Extrai estritamente os campos reais presentes no item do endpoint oficial `/players/{tag}/battlelog`.
 * Não inventa estatísticas ou campos ausentes na API oficial.
 */
export function parseBattlelogItem(
  item: RawSupercellBattleItem,
  sourceTagRaw: string
): ParsedBrawlBattle | null {
  const battleTime = String(item?.battleTime || '').trim();
  const battleTimeMs = parseBrawlBattleTimeMs(battleTime);
  if (!battleTime || battleTimeMs <= 0 || !item?.battle) {
    return null;
  }

  const mode = String(item.event?.mode || item.battle.mode || '').trim() || 'unknown';
  const map = String(item.event?.map || '').trim() || 'Desconhecido';
  const battleType = String(item.battle.type || '').trim() || 'unknown';
  const duration = typeof item.battle.duration === 'number' ? item.battle.duration : null;
  const starPlayerTag = item.battle.starPlayer?.tag
    ? normalizeBrawlTag(item.battle.starPlayer.tag)
    : null;

  const teams: BrawlBattlePlayer[][] = [];
  if (Array.isArray(item.battle.teams) && item.battle.teams.length > 0) {
    for (const rawTeam of item.battle.teams) {
      if (!Array.isArray(rawTeam)) continue;
      const parsedTeam = rawTeam
        .map((p) => parseRawBattlePlayer(p))
        .filter((p): p is BrawlBattlePlayer => p !== null);
      if (parsedTeam.length > 0) {
        teams.push(parsedTeam);
      }
    }
  } else if (Array.isArray(item.battle.players) && item.battle.players.length > 0) {
    const parsedPlayers = item.battle.players
      .map((p) => parseRawBattlePlayer(p))
      .filter((p): p is BrawlBattlePlayer => p !== null);
    if (parsedPlayers.length > 0) {
      teams.push(parsedPlayers);
    }
  }

  if (teams.length === 0) {
    return null;
  }

  const participantTags = Array.from(
    new Set(teams.flatMap((team) => team.map((p) => p.tag)))
  );
  if (participantTags.length === 0) {
    return null;
  }

  const sourceTag = normalizeBrawlTag(sourceTagRaw);
  const sourceResult = normalizeBattleResult(item.battle.result);
  const battleId = computeBattleDedupId(battleTime, participantTags, mode, map);

  return {
    battleId,
    battleTime,
    battleTimeMs,
    mode,
    map,
    battleType,
    duration,
    starPlayerTag,
    teams,
    participantTags,
    perspectives: sourceTag ? { [sourceTag]: sourceResult } : {},
    sourceTag,
    sourceResult,
  };
}

export async function lookupBrawlPlayerByTag(
  rawTag: string,
  deps?: Partial<BrawlServiceDeps>
): Promise<BrawlPlayerLookupResult> {
  const token = (deps?.token ?? process.env.BRAWL_STARS_API_TOKEN ?? '').trim();
  const apiBaseUrl = resolveApiBaseUrl(deps?.apiBaseUrl);
  const normalizedTag = normalizeBrawlTag(rawTag);

  if (!token) {
    return {
      ok: false,
      httpStatus: null,
      error: 'Variável de ambiente BRAWL_STARS_API_TOKEN não configurada no servidor.',
    };
  }
  if (!normalizedTag || normalizedTag.length < 4) {
    return {
      ok: false,
      httpStatus: null,
      error: 'Informe uma Brawl Tag válida (ex.: #2PP ou #ABC1234).',
    };
  }

  try {
    const encodedTag = encodeURIComponent(normalizedTag);
    const res = await fetchBrawlApiWithRetry(`${apiBaseUrl}/players/${encodedTag}`, token, {
      fetchImpl: deps?.fetchImpl,
      sleepImpl: deps?.sleepImpl,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return {
        ok: false,
        httpStatus: res.status,
        error:
          res.status === 404
            ? `Jogador com Tag ${normalizedTag} não encontrado na API oficial do Brawl Stars.`
            : classifySupercellFailure(res.status, errText),
      };
    }

    const payload = (await res.json()) as {
      tag?: string;
      name?: string;
      trophies?: number;
      highestTrophies?: number;
      '3vs3Victories'?: number;
      soloVictories?: number;
      duoVictories?: number;
      expLevel?: number;
      club?: { tag?: string; name?: string };
      brawlers?: Array<{ name?: string; trophies?: number; highestTrophies?: number; power?: number }>;
    };

    const brawlersList = Array.isArray(payload.brawlers) ? payload.brawlers : [];
    const topBrawlers = brawlersList
      .filter((b) => typeof b?.name === 'string')
      .map((b) => ({
        name: String(b.name),
        trophies: Number(b.trophies || 0),
        highestTrophies: Number(b.highestTrophies || 0),
        power: Number(b.power || 0),
      }))
      .sort((a, b) => b.trophies - a.trophies)
      .slice(0, 8);

    return {
      ok: true,
      httpStatus: res.status,
      error: null,
      player: {
        tag: normalizeBrawlTag(payload.tag || normalizedTag),
        name: String(payload.name || normalizedTag),
        trophies: Number(payload.trophies || 0),
        highestTrophies: Number(payload.highestTrophies || 0),
        victories3v3: Number(payload['3vs3Victories'] || 0),
        soloVictories: Number(payload.soloVictories || 0),
        duoVictories: Number(payload.duoVictories || 0),
        expLevel: typeof payload.expLevel === 'number' ? payload.expLevel : null,
        clubTag: payload.club?.tag ? normalizeBrawlTag(payload.club.tag) : null,
        clubName: payload.club?.name ? String(payload.club.name) : null,
        brawlersCount: brawlersList.length,
        topBrawlers,
      },
    };
  } catch (err) {
    return {
      ok: false,
      httpStatus: null,
      error: `Falha de rede ao consultar jogador: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function fetchPlayerBattlelog(
  rawTag: string,
  deps?: Partial<BrawlServiceDeps>
): Promise<{
  ok: boolean;
  httpStatus: number | null;
  error: string | null;
  battles: ParsedBrawlBattle[];
}> {
  const token = (deps?.token ?? process.env.BRAWL_STARS_API_TOKEN ?? '').trim();
  const apiBaseUrl = resolveApiBaseUrl(deps?.apiBaseUrl);
  const normalizedTag = normalizeBrawlTag(rawTag);

  if (!token) {
    return {
      ok: false,
      httpStatus: null,
      error: 'BRAWL_STARS_API_TOKEN não configurado no servidor.',
      battles: [],
    };
  }
  if (!normalizedTag || normalizedTag.length < 4) {
    return {
      ok: false,
      httpStatus: null,
      error: 'Tag inválida para consulta de battlelog.',
      battles: [],
    };
  }

  try {
    const encodedTag = encodeURIComponent(normalizedTag);
    const res = await fetchBrawlApiWithRetry(
      `${apiBaseUrl}/players/${encodedTag}/battlelog`,
      token,
      {
        fetchImpl: deps?.fetchImpl,
        sleepImpl: deps?.sleepImpl,
      }
    );

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return {
        ok: false,
        httpStatus: res.status,
        error: classifySupercellFailure(res.status, errText),
        battles: [],
      };
    }

    const payload = (await res.json()) as { items?: RawSupercellBattleItem[] };
    const rawItems = Array.isArray(payload?.items) ? payload.items : [];
    const battles = rawItems
      .map((item) => parseBattlelogItem(item, normalizedTag))
      .filter((b): b is ParsedBrawlBattle => b !== null);

    return {
      ok: true,
      httpStatus: res.status,
      error: null,
      battles,
    };
  } catch (err) {
    return {
      ok: false,
      httpStatus: null,
      error: `Erro de rede ao coletar battlelog: ${err instanceof Error ? err.message : String(err)}`,
      battles: [],
    };
  }
}

/**
 * Resolve o resultado de uma batalha para um jogador específico usando a perspectiva registrada
 * ou inferindo pelo time oposto caso outro participante da mesma batalha já tenha fornecido perspectiva oficial.
 */
export function resolvePlayerOutcomeInBattle(
  battle: Pick<ParsedBrawlBattle, 'teams' | 'perspectives'>,
  targetTagRaw: string
): 'victory' | 'defeat' | 'draw' | 'unknown' {
  const targetTag = normalizeBrawlTag(targetTagRaw);
  if (!targetTag) return 'unknown';

  const direct = battle.perspectives?.[targetTag];
  if (direct && direct !== 'unknown') {
    return direct;
  }

  const targetTeamIdx = battle.teams.findIndex((team) => team.some((p) => p.tag === targetTag));
  if (targetTeamIdx === -1) return 'unknown';

  for (const [tag, res] of Object.entries(battle.perspectives || {})) {
    if (res === 'unknown') continue;
    const refTeamIdx = battle.teams.findIndex((team) => team.some((p) => p.tag === tag));
    if (refTeamIdx === -1) continue;
    if (res === 'draw') return 'draw';
    if (refTeamIdx === targetTeamIdx) return res;
    if (battle.teams.length === 2) {
      return res === 'victory' ? 'defeat' : 'victory';
    }
  }

  return 'unknown';
}

function roundPct(wins: number, decided: number): number {
  if (decided <= 0) return 0;
  return Math.round((wins / decided) * 1000) / 10;
}

/**
 * Calcula estatísticas competitivas individuais reais de um jogador a partir de batalhas coletadas.
 */
export function computePlayerAnalyticsFromBattles(
  params: { uid: string; displayName?: string; brawlTag: string },
  battles: Array<Pick<ParsedBrawlBattle, 'battleTime' | 'battleTimeMs' | 'mode' | 'map' | 'teams' | 'perspectives'>>
): ComputedPlayerAnalytics {
  const targetTag = normalizeBrawlTag(params.brawlTag);
  let wins = 0;
  let losses = 0;
  let draws = 0;
  let totalBattles = 0;
  let latestMs = 0;
  let lastBattleTime: string | null = null;

  const brawlerMap = new Map<string, { battles: number; wins: number; losses: number; draws: number }>();
  const mapAcc = new Map<string, { map: string; mode: string; battles: number; wins: number; losses: number }>();
  const modeAcc = new Map<string, { mode: string; battles: number; wins: number; losses: number }>();

  for (const battle of battles) {
    const playerEntry = battle.teams.flat().find((p) => p.tag === targetTag);
    if (!playerEntry) continue;

    totalBattles += 1;
    if (battle.battleTimeMs > latestMs) {
      latestMs = battle.battleTimeMs;
      lastBattleTime = battle.battleTime;
    }

    const outcome = resolvePlayerOutcomeInBattle(battle, targetTag);
    if (outcome === 'victory') wins += 1;
    else if (outcome === 'defeat') losses += 1;
    else if (outcome === 'draw') draws += 1;

    const bKey = playerEntry.brawlerName || 'Desconhecido';
    const bStat = brawlerMap.get(bKey) || { battles: 0, wins: 0, losses: 0, draws: 0 };
    bStat.battles += 1;
    if (outcome === 'victory') bStat.wins += 1;
    else if (outcome === 'defeat') bStat.losses += 1;
    else if (outcome === 'draw') bStat.draws += 1;
    brawlerMap.set(bKey, bStat);

    const mapKey = `${battle.mode}::${battle.map}`;
    const mStat = mapAcc.get(mapKey) || {
      map: battle.map,
      mode: battle.mode,
      battles: 0,
      wins: 0,
      losses: 0,
    };
    mStat.battles += 1;
    if (outcome === 'victory') mStat.wins += 1;
    else if (outcome === 'defeat') mStat.losses += 1;
    mapAcc.set(mapKey, mStat);

    const modeStat = modeAcc.get(battle.mode) || {
      mode: battle.mode,
      battles: 0,
      wins: 0,
      losses: 0,
    };
    modeStat.battles += 1;
    if (outcome === 'victory') modeStat.wins += 1;
    else if (outcome === 'defeat') modeStat.losses += 1;
    modeAcc.set(battle.mode, modeStat);
  }

  const brawlerStats: BrawlerStatSummary[] = Array.from(brawlerMap.entries())
    .map(([brawlerName, s]) => ({
      brawlerName,
      battles: s.battles,
      wins: s.wins,
      losses: s.losses,
      draws: s.draws,
      winRate: roundPct(s.wins, s.wins + s.losses),
    }))
    .sort((a, b) => b.battles - a.battles || b.winRate - a.winRate)
    .slice(0, 20);

  const mapStats: MapStatSummary[] = Array.from(mapAcc.values())
    .map((s) => ({
      ...s,
      winRate: roundPct(s.wins, s.wins + s.losses),
    }))
    .sort((a, b) => b.battles - a.battles || b.winRate - a.winRate)
    .slice(0, 20);

  const modeStats: ModeStatSummary[] = Array.from(modeAcc.values())
    .map((s) => ({
      ...s,
      winRate: roundPct(s.wins, s.wins + s.losses),
    }))
    .sort((a, b) => b.battles - a.battles || b.winRate - a.winRate);

  return {
    uid: params.uid,
    displayName: params.displayName,
    brawlTag: targetTag,
    totalBattles,
    wins,
    losses,
    draws,
    winRate: roundPct(wins, wins + losses),
    brawlerStats,
    mapStats,
    modeStats,
    lastBattleTime,
  };
}

/**
 * Calcula estatísticas coletivas de uma equipe com base nas batalhas reais dos membros ativos.
 */
export function computeTeamAnalyticsFromBattles(
  params: { teamId: string; teamName: string; memberTags: string[] },
  battles: Array<Pick<ParsedBrawlBattle, 'battleId' | 'mode' | 'map' | 'teams' | 'perspectives'>>
): ComputedTeamAnalytics {
  const memberSet = new Set(params.memberTags.map((t) => normalizeBrawlTag(t)).filter(Boolean));
  let totalBattles = 0;
  let squadBattles = 0;
  let wins = 0;
  let losses = 0;
  let draws = 0;

  const brawlerMap = new Map<string, { battles: number; wins: number; losses: number; draws: number }>();
  const mapAcc = new Map<string, { map: string; mode: string; battles: number; wins: number; losses: number }>();
  const modeAcc = new Map<string, { mode: string; battles: number; wins: number; losses: number }>();

  for (const battle of battles) {
    // Identifica qual lado da batalha contém membros desta equipe (evita contar scrim interno como vitória dupla)
    const teamSides = battle.teams
      .map((side, idx) => ({
        idx,
        matchedPlayers: side.filter((p) => memberSet.has(p.tag)),
      }))
      .filter((s) => s.matchedPlayers.length > 0);

    if (teamSides.length === 0) continue;

    // Escolhe o lado com mais membros da equipe
    teamSides.sort((a, b) => b.matchedPlayers.length - a.matchedPlayers.length);
    const primarySide = teamSides[0];
    const sampleTag = primarySide.matchedPlayers[0].tag;
    const outcome = resolvePlayerOutcomeInBattle(battle, sampleTag);

    totalBattles += 1;
    if (primarySide.matchedPlayers.length >= 2) {
      squadBattles += 1;
    }

    if (outcome === 'victory') wins += 1;
    else if (outcome === 'defeat') losses += 1;
    else if (outcome === 'draw') draws += 1;

    for (const p of primarySide.matchedPlayers) {
      const bKey = p.brawlerName || 'Desconhecido';
      const bStat = brawlerMap.get(bKey) || { battles: 0, wins: 0, losses: 0, draws: 0 };
      bStat.battles += 1;
      if (outcome === 'victory') bStat.wins += 1;
      else if (outcome === 'defeat') bStat.losses += 1;
      else if (outcome === 'draw') bStat.draws += 1;
      brawlerMap.set(bKey, bStat);
    }

    const mapKey = `${battle.mode}::${battle.map}`;
    const mStat = mapAcc.get(mapKey) || {
      map: battle.map,
      mode: battle.mode,
      battles: 0,
      wins: 0,
      losses: 0,
    };
    mStat.battles += 1;
    if (outcome === 'victory') mStat.wins += 1;
    else if (outcome === 'defeat') mStat.losses += 1;
    mapAcc.set(mapKey, mStat);

    const modeStat = modeAcc.get(battle.mode) || {
      mode: battle.mode,
      battles: 0,
      wins: 0,
      losses: 0,
    };
    modeStat.battles += 1;
    if (outcome === 'victory') modeStat.wins += 1;
    else if (outcome === 'defeat') modeStat.losses += 1;
    modeAcc.set(battle.mode, modeStat);
  }

  return {
    teamId: params.teamId,
    teamName: params.teamName,
    memberTags: Array.from(memberSet),
    totalBattles,
    squadBattles,
    wins,
    losses,
    draws,
    winRate: roundPct(wins, wins + losses),
    brawlerStats: Array.from(brawlerMap.entries())
      .map(([brawlerName, s]) => ({
        brawlerName,
        battles: s.battles,
        wins: s.wins,
        losses: s.losses,
        draws: s.draws,
        winRate: roundPct(s.wins, s.wins + s.losses),
      }))
      .sort((a, b) => b.battles - a.battles || b.winRate - a.winRate)
      .slice(0, 20),
    mapStats: Array.from(mapAcc.values())
      .map((s) => ({ ...s, winRate: roundPct(s.wins, s.wins + s.losses) }))
      .sort((a, b) => b.battles - a.battles || b.winRate - a.winRate)
      .slice(0, 20),
    modeStats: Array.from(modeAcc.values())
      .map((s) => ({ ...s, winRate: roundPct(s.wins, s.wins + s.losses) }))
      .sort((a, b) => b.battles - a.battles || b.winRate - a.winRate),
  };
}

/**
 * Persiste batalhas coletadas com deduplicação determinística em `brawlBattles/{battleId}`.
 */
export async function persistDeduplicatedBattles(
  db: Firestore,
  battles: ParsedBrawlBattle[]
): Promise<{ newCount: number; duplicateCount: number; storedBattles: ParsedBrawlBattle[] }> {
  let newCount = 0;
  let duplicateCount = 0;
  const storedBattles: ParsedBrawlBattle[] = [];

  for (const battle of battles) {
    const ref = db.doc(`brawlBattles/${battle.battleId}`);
    const snap = await ref.get();
    if (snap.exists) {
      duplicateCount += 1;
      const existing = snap.data() || {};
      const existingPerspectives =
        (existing.perspectives as Record<string, 'victory' | 'defeat' | 'draw' | 'unknown'>) || {};
      const mergedPerspectives = {
        ...existingPerspectives,
        ...battle.perspectives,
      };
      // Atualiza apenas se houver nova perspectiva de outro participante
      if (
        battle.sourceTag &&
        existingPerspectives[battle.sourceTag] !== battle.sourceResult
      ) {
        await ref.set(
          {
            perspectives: mergedPerspectives,
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      }
      storedBattles.push({
        ...battle,
        perspectives: mergedPerspectives,
      });
    } else {
      newCount += 1;
      await ref.set({
        battleId: battle.battleId,
        battleTime: battle.battleTime,
        battleTimeMs: battle.battleTimeMs,
        mode: battle.mode,
        map: battle.map,
        battleType: battle.battleType,
        duration: battle.duration,
        starPlayerTag: battle.starPlayerTag,
        teams: battle.teams,
        participantTags: battle.participantTags,
        perspectives: battle.perspectives,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      storedBattles.push(battle);
    }
  }

  return { newCount, duplicateCount, storedBattles };
}

export async function recomputeOrgAnalytics(
  db: Firestore,
  approvedUsersList: Array<{ uid: string; displayName?: string; brawlTag: string }>
): Promise<void> {
  const battlesSnap = await db.collection('brawlBattles').limit(500).get();
  const allBattles: ParsedBrawlBattle[] = battlesSnap.docs.map((d) => {
    const data = d.data();
    return {
      battleId: String(data.battleId || d.id),
      battleTime: String(data.battleTime || ''),
      battleTimeMs: Number(data.battleTimeMs || 0),
      mode: String(data.mode || 'unknown'),
      map: String(data.map || 'Desconhecido'),
      battleType: String(data.battleType || 'unknown'),
      duration: typeof data.duration === 'number' ? data.duration : null,
      starPlayerTag: data.starPlayerTag ? String(data.starPlayerTag) : null,
      teams: Array.isArray(data.teams) ? (data.teams as BrawlBattlePlayer[][]) : [],
      participantTags: Array.isArray(data.participantTags) ? (data.participantTags as string[]) : [],
      perspectives:
        (data.perspectives as Record<string, 'victory' | 'defeat' | 'draw' | 'unknown'>) || {},
      sourceTag: '',
      sourceResult: 'unknown',
    };
  });

  const now = FieldValue.serverTimestamp();
  const tagByUid = new Map<string, string>();

  for (const user of approvedUsersList) {
    const cleanTag = normalizeBrawlTag(user.brawlTag);
    if (!cleanTag) continue;
    tagByUid.set(user.uid, cleanTag);
    const computed = computePlayerAnalyticsFromBattles(
      { uid: user.uid, displayName: user.displayName, brawlTag: cleanTag },
      allBattles
    );
    await db.doc(`playerAnalytics/${user.uid}`).set({
      ...computed,
      updatedAt: now,
    });
  }

  // Estatísticas coletivas por equipe ativa
  const [teamsSnap, membershipsSnap] = await Promise.all([
    db.collection('teams').where('active', '==', true).limit(50).get(),
    db.collection('teamMemberships').where('status', '==', 'active').limit(300).get(),
  ]);

  const tagsByTeam = new Map<string, Set<string>>();
  for (const mDoc of membershipsSnap.docs) {
    const mData = mDoc.data();
    const teamId = String(mData.teamId || '');
    const uid = String(mData.uid || '');
    const tag = tagByUid.get(uid);
    if (!teamId || !tag) continue;
    if (!tagsByTeam.has(teamId)) tagsByTeam.set(teamId, new Set());
    tagsByTeam.get(teamId)!.add(tag);
  }

  for (const tDoc of teamsSnap.docs) {
    const tData = tDoc.data();
    const memberTags = Array.from(tagsByTeam.get(tDoc.id) || []);
    const teamComputed = computeTeamAnalyticsFromBattles(
      {
        teamId: tDoc.id,
        teamName: String(tData.name || tDoc.id),
        memberTags,
      },
      allBattles
    );
    await db.doc(`teamAnalytics/${tDoc.id}`).set({
      ...teamComputed,
      updatedAt: now,
    });
  }
}

export async function recordBrawlSyncLog(
  db: Firestore,
  entry: {
    jobType: 'player_sync' | 'match_tracker';
    status: 'ok' | 'partial' | 'error' | 'skipped';
    triggeredBy: string;
    syncedPlayers: number;
    newBattles: number;
    duplicateBattles: number;
    autoMatchedGames?: number;
    pendingConfirmations?: number;
    errorCount: number;
    httpStatus?: number | null;
    errorMessage?: string | null;
    durationMs: number;
  }
): Promise<void> {
  await db.collection('brawlSyncLogs').add({
    ...entry,
    createdAt: FieldValue.serverTimestamp(),
  });
}

export async function getCompetitiveAnalyticsSummary(db: Firestore) {
  const [playersSnap, teamsSnap, logsSnap] = await Promise.all([
    db.collection('playerAnalytics').limit(100).get(),
    db.collection('teamAnalytics').limit(50).get(),
    db.collection('brawlSyncLogs').limit(30).get(),
  ]);

  const players = playersSnap.docs
    .map((d) => d.data() as ComputedPlayerAnalytics & { updatedAt?: unknown })
    .sort((a, b) => (b.totalBattles || 0) - (a.totalBattles || 0));

  const teams = teamsSnap.docs
    .map((d) => d.data() as ComputedTeamAnalytics & { updatedAt?: unknown })
    .sort((a, b) => (b.totalBattles || 0) - (a.totalBattles || 0));

  const syncLogs = logsSnap.docs
    .map((d): Record<string, unknown> => ({ id: d.id, ...(d.data() as Record<string, unknown>) }))
    .sort((a, b) => {
      const ta = formatTs(a.createdAt) || '';
      const tb = formatTs(b.createdAt) || '';
      return tb.localeCompare(ta);
    })
    .slice(0, 20);

  // Agrega estatísticas globais da organização a partir dos jogadores sincronizados
  const brawlerAgg = new Map<string, { battles: number; wins: number; losses: number; draws: number }>();
  const mapAgg = new Map<string, { map: string; mode: string; battles: number; wins: number; losses: number }>();
  const modeAgg = new Map<string, { mode: string; battles: number; wins: number; losses: number }>();

  for (const p of players) {
    for (const b of p.brawlerStats || []) {
      const cur = brawlerAgg.get(b.brawlerName) || { battles: 0, wins: 0, losses: 0, draws: 0 };
      cur.battles += b.battles;
      cur.wins += b.wins;
      cur.losses += b.losses;
      cur.draws += b.draws || 0;
      brawlerAgg.set(b.brawlerName, cur);
    }
    for (const m of p.mapStats || []) {
      const k = `${m.mode}::${m.map}`;
      const cur = mapAgg.get(k) || { map: m.map, mode: m.mode, battles: 0, wins: 0, losses: 0 };
      cur.battles += m.battles;
      cur.wins += m.wins;
      cur.losses += m.losses;
      mapAgg.set(k, cur);
    }
    for (const md of p.modeStats || []) {
      const cur = modeAgg.get(md.mode) || { mode: md.mode, battles: 0, wins: 0, losses: 0 };
      cur.battles += md.battles;
      cur.wins += md.wins;
      cur.losses += md.losses;
      modeAgg.set(md.mode, cur);
    }
  }

  return {
    orgBrawlers: Array.from(brawlerAgg.entries())
      .map(([brawlerName, s]) => ({
        brawlerName,
        battles: s.battles,
        wins: s.wins,
        losses: s.losses,
        draws: s.draws,
        winRate: roundPct(s.wins, s.wins + s.losses),
      }))
      .sort((a, b) => b.battles - a.battles || b.winRate - a.winRate)
      .slice(0, 25),
    orgMaps: Array.from(mapAgg.values())
      .map((s) => ({ ...s, winRate: roundPct(s.wins, s.wins + s.losses) }))
      .sort((a, b) => b.battles - a.battles || b.winRate - a.winRate)
      .slice(0, 25),
    orgModes: Array.from(modeAgg.values())
      .map((s) => ({ ...s, winRate: roundPct(s.wins, s.wins + s.losses) }))
      .sort((a, b) => b.battles - a.battles || b.winRate - a.winRate),
    players,
    teams,
    syncLogs,
  };
}

export async function getBrawlSyncStatus(
  deps?: Partial<BrawlServiceDeps>
): Promise<BrawlStatusSnapshot> {
  const token = (deps?.token ?? process.env.BRAWL_STARS_API_TOKEN ?? '').trim();
  const apiBaseUrl = resolveApiBaseUrl(deps?.apiBaseUrl);
  const egressProxyConfigured = apiBaseUrl !== 'https://api.brawlstars.com/v1';

  const db = deps?.db || getAdminServices().db;
  if (!db) {
    return {
      brawlTokenConfigured: Boolean(token),
      brawlApiConfigured: false,
      egressProxyConfigured,
      apiBaseUrl,
      intervalHours: DEFAULT_SYNC_INTERVAL_HOURS,
      running: false,
      lastRunAt: null,
      lastSuccessAt: null,
      lastStatus: 'admin_sdk_not_configured',
      lastHttpStatus: null,
      lastError: 'Firebase Admin SDK não configurado neste ambiente.',
      lastSuccessCount: 0,
      lastErrorCount: 0,
      lastNewBattlesCount: 0,
    };
  }

  const [jobSnap, settingsSnap] = await Promise.all([
    db.doc(JOB_DOC_PATH).get(),
    db.doc('systemSettings/global').get(),
  ]);

  const job = jobSnap.exists ? jobSnap.data() || {} : {};
  const settings = settingsSnap.exists ? settingsSnap.data() || {} : {};

  return {
    brawlTokenConfigured: Boolean(token),
    brawlApiConfigured: Boolean(settings.brawlApiConfigured) && Boolean(token),
    egressProxyConfigured,
    apiBaseUrl,
    intervalHours:
      typeof settings.brawlApiSyncIntervalHours === 'number'
        ? settings.brawlApiSyncIntervalHours
        : DEFAULT_SYNC_INTERVAL_HOURS,
    running:
      Boolean(job.running) &&
      typeof job.leaseUntilMs === 'number' &&
      job.leaseUntilMs > Date.now(),
    lastRunAt: formatTs(job.lastRunAt),
    lastSuccessAt: formatTs(job.lastSuccessAt),
    lastStatus: String(job.lastStatus || (token ? 'awaiting_verification' : 'pending_config')),
    lastHttpStatus: typeof job.lastHttpStatus === 'number' ? job.lastHttpStatus : null,
    lastError: job.lastError ? String(job.lastError) : null,
    lastSuccessCount: Number(job.lastSuccessCount || 0),
    lastErrorCount: Number(job.lastErrorCount || 0),
    lastNewBattlesCount: Number(job.lastNewBattlesCount || 0),
  };
}

export async function testBrawlStarsApiConnection(
  rawTag: string,
  deps?: Partial<BrawlServiceDeps>
): Promise<BrawlTestResult> {
  const token = (deps?.token ?? process.env.BRAWL_STARS_API_TOKEN ?? '').trim();
  const apiBaseUrl = resolveApiBaseUrl(deps?.apiBaseUrl);
  const egressProxyConfigured = apiBaseUrl !== 'https://api.brawlstars.com/v1';
  const fetchImpl = deps?.fetchImpl || fetch;
  const db = deps?.db || getAdminServices().db;

  if (!token) {
    if (db) {
      await db.doc('systemSettings/global').set(
        {
          brawlApiConfigured: false,
          cloudFunctionsConfigured: false,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }
    return {
      ok: false,
      brawlApiConfigured: false,
      httpStatus: null,
      error: 'Variável de ambiente BRAWL_STARS_API_TOKEN não configurada no servidor Render.',
      egressProxyConfigured,
    };
  }

  const normalizedTag = normalizeBrawlTag(rawTag);
  if (!normalizedTag || normalizedTag.length < 4) {
    return {
      ok: false,
      brawlApiConfigured: false,
      httpStatus: null,
      error: 'Informe uma Brawl Tag válida (ex.: #2PP ou #ABC1234) para validar a conectividade.',
      egressProxyConfigured,
    };
  }

  try {
    const encodedTag = encodeURIComponent(normalizedTag);
    const res = await fetchBrawlApiWithRetry(`${apiBaseUrl}/players/${encodedTag}`, token, {
      fetchImpl,
      sleepImpl: deps?.sleepImpl,
      maxRetries: 1,
    });

    if (res.ok) {
      const payload = (await res.json()) as { name?: string; trophies?: number };
      if (db) {
        const now = FieldValue.serverTimestamp();
        await Promise.all([
          db.doc('systemSettings/global').set(
            {
              brawlApiConfigured: true,
              cloudFunctionsConfigured: false,
              updatedAt: now,
            },
            { merge: true }
          ),
          db.doc(JOB_DOC_PATH).set(
            {
              lastStatus: 'verified',
              lastHttpStatus: res.status,
              lastError: null,
              lastSuccessAt: now,
              updatedAt: now,
            },
            { merge: true }
          ),
        ]);
      }

      return {
        ok: true,
        brawlApiConfigured: true,
        httpStatus: res.status,
        error: null,
        playerName: payload.name,
        trophies: payload.trophies,
        egressProxyConfigured,
      };
    }

    const bodyText = await res.text().catch(() => '');
    const diagnostic =
      res.status === 404
        ? 'HTTP 404: Autenticação/IP aceitos pela Supercell, mas a Tag de teste informada não existe.'
        : classifySupercellFailure(res.status, bodyText);
    const authVerified = res.status === 404;

    if (db) {
      const now = FieldValue.serverTimestamp();
      await Promise.all([
        db.doc('systemSettings/global').set(
          {
            brawlApiConfigured: authVerified,
            cloudFunctionsConfigured: false,
            updatedAt: now,
          },
          { merge: true }
        ),
        db.doc(JOB_DOC_PATH).set(
          {
            lastStatus: authVerified ? 'verified' : 'error',
            lastHttpStatus: res.status,
            lastError: diagnostic,
            updatedAt: now,
          },
          { merge: true }
        ),
      ]);
    }

    return {
      ok: authVerified,
      brawlApiConfigured: authVerified,
      httpStatus: res.status,
      error: diagnostic,
      egressProxyConfigured,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (db) {
      await db.doc('systemSettings/global').set(
        {
          brawlApiConfigured: false,
          cloudFunctionsConfigured: false,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }
    return {
      ok: false,
      brawlApiConfigured: false,
      httpStatus: null,
      error: `Falha de rede ao consultar API Brawl Stars: ${errMsg}`,
      egressProxyConfigured,
    };
  }
}

export async function syncBrawlStarsStats(
  options: { force?: boolean; triggeredBy?: string; includeBattlelogs?: boolean } = {},
  deps?: Partial<BrawlServiceDeps>
): Promise<BrawlSyncResult> {
  const adminServices = deps?.db ? null : getAdminServices();
  const db = deps?.db || adminServices?.db;
  if (!db) {
    return {
      ok: false,
      skipped: true,
      reason: 'admin_sdk_not_configured',
      brawlApiConfigured: false,
      error: 'Firebase Admin SDK não configurado.',
      syncedCount: 0,
      errorCount: 0,
    };
  }

  const startedAtMs = Date.now();
  const token = (deps?.token ?? process.env.BRAWL_STARS_API_TOKEN ?? '').trim();
  const apiBaseUrl = resolveApiBaseUrl(deps?.apiBaseUrl);
  const fetchImpl = deps?.fetchImpl || fetch;
  const sleepImpl = deps?.sleepImpl || defaultSleep;
  const nowMs = deps?.nowMs ? deps.nowMs() : Date.now();
  const lockOwner = crypto.randomUUID();
  const jobRef = db.doc(JOB_DOC_PATH);

  const settingsSnap = await db.doc('systemSettings/global').get();
  const intervalHours =
    settingsSnap.exists && typeof settingsSnap.data()?.brawlApiSyncIntervalHours === 'number'
      ? Math.max(1, Math.min(168, Number(settingsSnap.data()?.brawlApiSyncIntervalHours)))
      : DEFAULT_SYNC_INTERVAL_HOURS;
  const minIntervalMs = intervalHours * 3600 * 1000;

  if (!token) {
    const now = FieldValue.serverTimestamp();
    await Promise.all([
      db.doc('systemSettings/global').set(
        {
          brawlApiConfigured: false,
          cloudFunctionsConfigured: false,
          updatedAt: now,
        },
        { merge: true }
      ),
      jobRef.set(
        {
          running: false,
          lastRunAt: Timestamp.fromMillis(nowMs),
          lastStatus: 'pending_config',
          lastHttpStatus: null,
          lastError: 'BRAWL_STARS_API_TOKEN não configurado no ambiente do backend.',
          updatedAt: now,
        },
        { merge: true }
      ),
    ]);

    return {
      ok: false,
      skipped: true,
      reason: 'missing_token',
      brawlApiConfigured: false,
      error: 'BRAWL_STARS_API_TOKEN não configurado no ambiente do backend.',
      syncedCount: 0,
      errorCount: 0,
    };
  }

  // Distributed lease transaction prevents concurrent / duplicate sync across Render restarts & instances
  const leaseAcquired = await db.runTransaction(async (tx) => {
    const snap = await tx.get(jobRef);
    const data = snap.exists ? snap.data() || {} : {};
    const isRunning =
      Boolean(data.running) &&
      typeof data.leaseUntilMs === 'number' &&
      data.leaseUntilMs > nowMs;

    if (isRunning) {
      return { acquired: false, reason: 'already_running' };
    }

    const lastRunMs =
      data.lastRunAt && typeof data.lastRunAt.toMillis === 'function'
        ? data.lastRunAt.toMillis()
        : typeof data.lastRunAtMs === 'number'
          ? data.lastRunAtMs
          : 0;

    if (!options.force && lastRunMs > 0 && nowMs - lastRunMs < minIntervalMs - 60_000) {
      return { acquired: false, reason: 'interval_not_elapsed' };
    }

    tx.set(
      jobRef,
      {
        running: true,
        lockOwner,
        leaseUntilMs: nowMs + LOCK_LEASE_MS,
        lastTriggeredBy: options.triggeredBy || 'scheduler',
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return { acquired: true, reason: 'ok' };
  });

  if (!leaseAcquired.acquired) {
    return {
      ok: true,
      skipped: true,
      reason: leaseAcquired.reason,
      brawlApiConfigured: Boolean(settingsSnap.data()?.brawlApiConfigured),
      syncedCount: 0,
      errorCount: 0,
    };
  }

  let syncedCount = 0;
  let errorCount = 0;
  let newBattlesCount = 0;
  let duplicateBattlesCount = 0;
  let lastHttpStatus: number | null = null;
  let lastError: string | null = null;
  let fatalAuthOrIpBlocked = false;
  let verifiedByRealApi = false;

  const approvedUsersList: Array<{ uid: string; displayName?: string; brawlTag: string }> = [];

  try {
    const approvedUsers = await db
      .collection('users')
      .where('brawlTagStatus', '==', 'approved')
      .where('status', '==', 'active')
      .limit(100)
      .get();

    for (let idx = 0; idx < approvedUsers.docs.length; idx++) {
      const userDoc = approvedUsers.docs[idx];
      const data = userDoc.data();
      const rawTag = normalizeBrawlTag(data.brawlTag);
      if (!rawTag) continue;

      approvedUsersList.push({
        uid: userDoc.id,
        displayName: data.displayName ? String(data.displayName) : undefined,
        brawlTag: rawTag,
      });

      if (idx > 0) {
        await sleepImpl(RATE_LIMIT_DELAY_MS);
      }

      const encodedTag = encodeURIComponent(rawTag);

      try {
        const res = await fetchBrawlApiWithRetry(`${apiBaseUrl}/players/${encodedTag}`, token, {
          fetchImpl,
          sleepImpl,
        });
        lastHttpStatus = res.status;

        if (!res.ok) {
          errorCount += 1;
          const errText = await res.text().catch(() => '');
          lastError = classifySupercellFailure(res.status, errText);

          await db.doc(`playerStats/${userDoc.id}`).set(
            {
              uid: userDoc.id,
              brawlTag: rawTag,
              syncStatus: 'error',
              lastSyncedAt: FieldValue.serverTimestamp(),
            },
            { merge: true }
          );

          if (res.status === 401 || res.status === 403) {
            fatalAuthOrIpBlocked = true;
            break;
          }
          continue;
        }

        verifiedByRealApi = true;
        syncedCount += 1;
        const player = (await res.json()) as {
          name?: string;
          trophies?: number;
          highestTrophies?: number;
          '3vs3Victories'?: number;
          soloVictories?: number;
          duoVictories?: number;
          expLevel?: number;
          club?: { name?: string };
          brawlers?: unknown[];
        };

        const now = FieldValue.serverTimestamp();
        await db.doc(`playerStats/${userDoc.id}`).set({
          uid: userDoc.id,
          brawlTag: rawTag,
          ...(player.name ? { playerName: String(player.name) } : {}),
          trophies: player.trophies || 0,
          highestTrophies: player.highestTrophies || 0,
          victories3v3: player['3vs3Victories'] || 0,
          soloVictories: player.soloVictories || 0,
          duoVictories: player.duoVictories || 0,
          ...(typeof player.expLevel === 'number' ? { expLevel: player.expLevel } : {}),
          ...(player.club?.name ? { clubName: String(player.club.name) } : {}),
          ...(Array.isArray(player.brawlers) ? { brawlersCount: player.brawlers.length } : {}),
          syncStatus: 'ok',
          lastSyncedAt: now,
        });

        await db.collection('playerStatsHistory').add({
          uid: userDoc.id,
          brawlTag: rawTag,
          trophies: player.trophies || 0,
          victories3v3: player['3vs3Victories'] || 0,
          capturedAt: now,
        });

        // Coleta battlelog oficial quando habilitado (preserva compatibilidade de testes unitários que mockam apenas /players/:tag)
        if (options.includeBattlelogs) {
          await sleepImpl(RATE_LIMIT_DELAY_MS);
          const logRes = await fetchPlayerBattlelog(rawTag, {
            token,
            apiBaseUrl,
            fetchImpl,
            sleepImpl,
          });
          if (logRes.ok && logRes.battles.length > 0) {
            const persisted = await persistDeduplicatedBattles(db, logRes.battles);
            newBattlesCount += persisted.newCount;
            duplicateBattlesCount += persisted.duplicateCount;
          } else if (!logRes.ok && logRes.httpStatus !== 404) {
            errorCount += 1;
            lastError = logRes.error || lastError;
          }
        }
      } catch (err) {
        errorCount += 1;
        lastError = err instanceof Error ? err.message : String(err);
      }
    }

    if (options.includeBattlelogs && approvedUsersList.length > 0 && !fatalAuthOrIpBlocked) {
      await recomputeOrgAnalytics(db, approvedUsersList);
    }

    const noApprovedTagsYet = approvedUsers.empty;
    const brawlApiConfigured = fatalAuthOrIpBlocked
      ? false
      : verifiedByRealApi
        ? true
        : Boolean(settingsSnap.data()?.brawlApiConfigured) && !noApprovedTagsYet;

    const finalStatus = fatalAuthOrIpBlocked
      ? 'auth_or_ip_blocked'
      : noApprovedTagsYet
        ? 'no_approved_tags'
        : errorCount > 0 && syncedCount === 0
          ? 'error'
          : 'ok';

    if (noApprovedTagsYet && !lastError) {
      lastError =
        'Token presente, mas ainda não há jogadores com brawlTagStatus="approved" para validar uma chamada real na API da Supercell. Use "Testar Tag na API" ou aprove uma tag.';
    }

    const finishedAt = FieldValue.serverTimestamp();
    await Promise.all([
      db.doc('systemSettings/global').set(
        {
          brawlApiConfigured,
          cloudFunctionsConfigured: false,
          updatedAt: finishedAt,
        },
        { merge: true }
      ),
      jobRef.set(
        {
          running: false,
          lockOwner: null,
          leaseUntilMs: 0,
          lastRunAt: Timestamp.fromMillis(nowMs),
          lastRunAtMs: nowMs,
          ...(verifiedByRealApi ? { lastSuccessAt: finishedAt } : {}),
          lastStatus: finalStatus,
          lastHttpStatus,
          lastError,
          lastSuccessCount: syncedCount,
          lastErrorCount: errorCount,
          lastNewBattlesCount: newBattlesCount,
          updatedAt: finishedAt,
        },
        { merge: true }
      ),
      recordBrawlSyncLog(db, {
        jobType: 'player_sync',
        status: fatalAuthOrIpBlocked
          ? 'error'
          : errorCount > 0 && syncedCount > 0
            ? 'partial'
            : errorCount > 0
              ? 'error'
              : 'ok',
        triggeredBy: options.triggeredBy || 'scheduler',
        syncedPlayers: syncedCount,
        newBattles: newBattlesCount,
        duplicateBattles: duplicateBattlesCount,
        errorCount,
        httpStatus: lastHttpStatus,
        errorMessage: lastError,
        durationMs: Math.max(0, Date.now() - startedAtMs),
      }),
    ]);

    return {
      ok: !fatalAuthOrIpBlocked && (syncedCount > 0 || noApprovedTagsYet),
      brawlApiConfigured,
      httpStatus: lastHttpStatus,
      error: lastError,
      syncedCount,
      errorCount,
      newBattlesCount,
      duplicateBattlesCount,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await jobRef.set(
      {
        running: false,
        lockOwner: null,
        leaseUntilMs: 0,
        lastRunAt: Timestamp.fromMillis(nowMs),
        lastRunAtMs: nowMs,
        lastStatus: 'error',
        lastError: errMsg,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    await recordBrawlSyncLog(db, {
      jobType: 'player_sync',
      status: 'error',
      triggeredBy: options.triggeredBy || 'scheduler',
      syncedPlayers: syncedCount,
      newBattles: newBattlesCount,
      duplicateBattles: duplicateBattlesCount,
      errorCount: errorCount + 1,
      httpStatus: lastHttpStatus,
      errorMessage: errMsg,
      durationMs: Math.max(0, Date.now() - startedAtMs),
    }).catch(() => {});

    return {
      ok: false,
      brawlApiConfigured: false,
      error: errMsg,
      syncedCount,
      errorCount,
      newBattlesCount,
      duplicateBattlesCount,
    };
  }
}

let schedulerStarted = false;

export function startBrawlStarsScheduler(): void {
  if (schedulerStarted) return;
  schedulerStarted = true;

  // Periodic check every 30 min; Firestore distributed lock enforces the configured 6h interval cleanly across restarts
  const runSafe = () => {
    const { configured } = getAdminServices();
    if (!configured) return;
    void syncBrawlStarsStats({
      force: false,
      triggeredBy: 'scheduler',
      includeBattlelogs: true,
    }).catch((err) => {
      console.warn(
        '[BrawlStarsScheduler] Falha ao executar ciclo:',
        err instanceof Error ? err.message : String(err)
      );
    });
  };

  setTimeout(runSafe, 15_000).unref();
  setInterval(runSafe, 30 * 60 * 1000).unref();
}
