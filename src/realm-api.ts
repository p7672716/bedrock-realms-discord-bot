import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import type { Authflow as AuthflowType } from 'prismarine-auth';
import type {
  AppConfig,
  AuthPrompt,
  JoinInfo,
  Player,
  RealmConfig,
  RealmEvent,
  RealmInfo,
} from './types.js';
import type { Logger } from './logger.js';
import { sanitizePlayerName } from './player.js';

const require = createRequire(import.meta.url);
const { Authflow, Titles } = require('prismarine-auth') as typeof import('prismarine-auth');

type JsonObject = Record<string, any>;

export class RealmApiClient extends EventEmitter {
  private authflowInstance: AuthflowType;
  private readonly baseUrl: string;

  constructor(private readonly config: AppConfig, private readonly log: Logger) {
    super();
    this.baseUrl = config.realmsApi.baseUrl.replace(/\/$/, '');
    this.authflowInstance = this.createAuthflow();
  }

  get authflow(): AuthflowType {
    return this.authflowInstance;
  }

  async logout(): Promise<void> {
    await fs.rm(this.config.auth.cacheDir, { recursive: true, force: true });
    await fs.mkdir(this.config.auth.cacheDir, { recursive: true });
    this.authflowInstance = this.createAuthflow();
  }

  private createAuthflow(): AuthflowType {
    return new Authflow(
      this.config.auth.cacheKey,
      this.config.auth.cacheDir,
      {
        flow: 'live',
        authTitle: Titles.MinecraftNintendoSwitch,
        deviceType: 'Nintendo',
      } as any,
      (code: any) => {
        const prompt: AuthPrompt = {
          verificationUri: String(code.verification_uri || code.verificationUri || 'https://www.microsoft.com/link'),
          userCode: String(code.user_code || code.userCode || 'unknown'),
          message: typeof code.message === 'string' ? code.message : undefined,
          occurredAt: new Date().toISOString(),
        };
        this.emit('auth-required', prompt);
        this.log.warn(`Microsoft authentication is required. Open ${prompt.verificationUri} and enter code ${prompt.userCode}.`);
      },
    );
  }

  async getRealm(realmId: string): Promise<RealmInfo> {
    const raw = await this.request(`/worlds/${encodeURIComponent(realmId)}`);
    return mapRealmInfo(realmId, raw);
  }

  async getLivePlayers(realmId: string): Promise<Player[] | null> {
    const raw = await this.request('/activities/live/players');
    const servers = Array.isArray(raw?.servers) ? raw.servers : [];
    const match = servers.find((server: JsonObject) => String(server.id) === String(realmId));
    if (!match) return null;
    const players = Array.isArray(match.players) ? match.players : [];
    return players
      .filter((player: JsonObject) => player.online !== false)
      .map((player: JsonObject) => mapPlayer(player, 'realms-api'));
  }

  async getJoinInfo(realmId: string): Promise<JoinInfo> {
    const raw = await this.request(`/worlds/${encodeURIComponent(realmId)}/join`);
    const address = typeof raw?.address === 'string' ? raw.address.trim() || undefined : undefined;
    const parsed = parseAddress(address);
    const sessionRegionData = raw?.sessionRegionData && typeof raw.sessionRegionData === 'object'
      ? {
          regionName: typeof raw.sessionRegionData.regionName === 'string'
            ? raw.sessionRegionData.regionName.trim() || undefined
            : undefined,
          serviceQuality: typeof raw.sessionRegionData.serviceQuality === 'number' && Number.isFinite(raw.sessionRegionData.serviceQuality)
            ? raw.sessionRegionData.serviceQuality
            : undefined,
        }
      : undefined;
    return {
      ...parsed,
      address,
      region: sessionRegionData?.regionName || parsed.region,
      networkProtocol: typeof raw?.networkProtocol === 'string' ? raw.networkProtocol.trim() || undefined : undefined,
      sessionRegionData,
      raw,
    };
  }

  async getStoryEvents(realmId: string): Promise<RealmEvent[] | null> {
    const template = this.config.realmsApi.storyEventsPathTemplate;
    if (!template) return null;
    const raw = await this.request(expandPath(template, realmId));
    return normaliseEvents(realmId, raw);
  }

  async request(pathOrUrl: string, init: RequestInit = {}): Promise<any> {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${this.baseUrl}${pathOrUrl.startsWith('/') ? '' : '/'}${pathOrUrl}`;
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const token = await this.authflow.getXboxToken('https://pocket.realms.minecraft.net/');
        const response = await fetch(url, {
          ...init,
          headers: {
            Accept: 'application/json',
            Authorization: `XBL3.0 x=${token.userHash};${token.XSTSToken}`,
            'Client-Version': this.config.realmsApi.clientVersion,
            'User-Agent': 'MCPE/UWP',
            ...(init.headers || {}),
          },
        });
        if (response.ok) {
          const contentType = response.headers.get('content-type') || '';
          return contentType.includes('json') ? response.json() : response.text();
        }
        const body = await response.text();
        if (response.status < 500 && response.status !== 429) {
          throw new Error(`Realms API ${response.status}: ${body.slice(0, 500)}`);
        }
        lastError = new Error(`Realms API ${response.status}: ${body.slice(0, 500)}`);
      } catch (error) {
        lastError = error;
        if (attempt === 3) break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}

export function realmLabel(realm: RealmConfig, info?: RealmInfo): string {
  return realm.name || info?.name || `Realm ${realm.id}`;
}

function mapRealmInfo(fallbackId: string, raw: JsonObject): RealmInfo {
  return {
    id: String(raw?.id ?? fallbackId),
    name: raw?.name,
    motd: raw?.motd,
    state: raw?.state,
    ownerXuid: raw?.ownerUUID,
    maxPlayers: raw?.maxPlayers,
    activeSlot: raw?.activeSlot,
    worldType: raw?.worldType,
    difficulty: mapDifficulty(raw),
    raw,
  };
}

function mapDifficulty(raw: JsonObject): string | undefined {
  if (raw?.hardcore === true) return 'Hardcore';
  const value = raw?.difficulty ?? raw?.difficultyLevel;
  if (typeof value === 'number') return ['Peaceful', 'Easy', 'Normal', 'Hard'][value] || String(value);
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const normalized = value.trim().toLowerCase();
  const names: Record<string, string> = {
    peaceful: 'Peaceful',
    easy: 'Easy',
    normal: 'Normal',
    hard: 'Hard',
    hardcore: 'Hardcore',
  };
  return names[normalized] || value;
}

function mapPlayer(raw: JsonObject, source: Player['source']): Player {
  const xuid = raw.xuid ?? raw.uuid ?? raw.playerId;
  const uuid = raw.uuid && raw.xuid ? raw.uuid : undefined;
  const id = String(xuid ?? raw.name ?? raw.id ?? 'unknown');
  return {
    id,
    name: sanitizePlayerName(raw.name ?? raw.displayName),
    xuid: xuid === undefined ? undefined : String(xuid),
    uuid: uuid === undefined ? undefined : String(uuid),
    source,
  };
}

function parseAddress(address?: string): Pick<JoinInfo, 'host' | 'port' | 'region'> {
  if (!address) return {};
  const lastColon = address.lastIndexOf(':');
  const host = lastColon > 0 ? address.slice(0, lastColon) : address;
  const port = lastColon > 0 ? Number(address.slice(lastColon + 1)) : undefined;
  const regionMatch = host.match(/(?:production|prod)[-.]([a-z0-9-]+)/i);
  return { host, port: Number.isFinite(port) ? port : undefined, region: regionMatch?.[1] };
}

function expandPath(template: string, realmId: string): string {
  return template.replaceAll('{realmId}', encodeURIComponent(realmId));
}

function normaliseEvents(realmId: string, raw: any): RealmEvent[] {
  return extractItems(raw).map((item) => {
    const object = asObject(item);
    const explicitId = object.id ?? object.eventId ?? object.storyId ?? object.uuid;
    const id = explicitId === undefined ? `derived-${hashValue(item)}` : String(explicitId);
    const coordinates = object.coordinates ?? object.position ?? object.location;
    return {
      id,
      realmId,
      playerName: findString(object, ['playerName', 'player', 'username', 'author', 'creator']),
      content: findString(object, ['content', 'description', 'title', 'event', 'message', 'text']),
      type: findString(object, ['type', 'eventType', 'kind']),
      occurredAt: findString(object, ['occurredAt', 'createdAt', 'timestamp', 'date', 'time']),
      coordinates: coordinates && typeof coordinates === 'object'
        ? { x: numberValue(coordinates.x), y: numberValue(coordinates.y), z: numberValue(coordinates.z) }
        : undefined,
      raw: item,
    };
  });
}

function extractItems(raw: any): any[] {
  if (Array.isArray(raw)) return raw;
  for (const key of ['events', 'stories', 'items', 'data', 'activities', 'timeline']) {
    if (Array.isArray(raw?.[key])) return raw[key];
  }
  return raw && typeof raw === 'object' ? [raw] : [];
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === 'object' ? value as JsonObject : { value };
}

function findString(object: JsonObject, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === 'string' && value.trim()) return value;
    if (value && typeof value === 'object') {
      const nested = (value as JsonObject).name ?? (value as JsonObject).displayName ?? (value as JsonObject).text ?? (value as JsonObject).url;
      if (typeof nested === 'string' && nested.trim()) return nested;
    }
  }
  return undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function hashValue(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
}
