import path from 'node:path';
import type { AppConfig, RealmConfig } from './types.js';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function integerEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return Math.floor(value);
}

function parseRealms(): RealmConfig[] {
  const raw = required('REALMS_JSON');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('REALMS_JSON must be valid JSON');
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('REALMS_JSON must contain at least one Realm');
  }
  const realms = parsed.map((value, index) => {
    if (!value || typeof value !== 'object') throw new Error(`REALMS_JSON[${index}] must be an object`);
    const item = value as Record<string, unknown>;
    const id = String(item.id ?? '').trim();
    if (!id) throw new Error(`REALMS_JSON[${index}].id is required`);
    return {
      id,
      name: item.name ? String(item.name) : undefined,
      notificationChannelId: item.notificationChannelId ? String(item.notificationChannelId) : undefined,
    } satisfies RealmConfig;
  });
  if (new Set(realms.map((realm) => realm.id)).size !== realms.length) {
    throw new Error('REALMS_JSON contains duplicate Realm IDs');
  }
  return realms;
}

export function loadConfig(): AppConfig {
  const dataDir = path.resolve(process.env.DATA_DIR?.trim() || './data');
  const presenceSource = (process.env.PRESENCE_SOURCE?.trim().toLowerCase() || 'protocol');
  if (presenceSource !== 'protocol' && presenceSource !== 'api') {
    throw new Error('PRESENCE_SOURCE must be protocol or api');
  }
  return {
    discord: {
      token: required('DISCORD_TOKEN'),
      applicationId: required('DISCORD_APPLICATION_ID'),
      guildId: process.env.DISCORD_GUILD_ID?.trim() || undefined,
      defaultNotificationChannelId: process.env.DISCORD_NOTIFY_CHANNEL_ID?.trim() || undefined,
    },
    auth: {
      cacheKey: process.env.AUTH_CACHE_KEY?.trim() || 'bedrock-realms-bot',
      cacheDir: path.join(dataDir, 'auth'),
    },
    realms: parseRealms(),
    realmsApi: {
      baseUrl: process.env.REALMS_API_BASE_URL?.trim() || 'https://pocket.realms.minecraft.net',
      clientVersion: process.env.BEDROCK_VERSION?.trim() || '1.26.30',
      storyEventsPathTemplate: process.env.REALM_STORY_EVENTS_PATH_TEMPLATE?.trim() || undefined,
    },
    dataDir,
    presenceSource,
    presencePollMs: integerEnv('PRESENCE_POLL_MS', 60_000),
    storyPollMs: integerEnv('STORY_POLL_MS', 60_000),
    reconnectBaseMs: integerEnv('RECONNECT_BASE_MS', 10_000),
  };
}
