export type RealmConfig = {
  id: string;
  name?: string;
  notificationChannelId?: string;
};

export type AppConfig = {
  discord: {
    token: string;
    applicationId: string;
    guildId?: string;
    defaultNotificationChannelId?: string;
  };
  auth: {
    cacheKey: string;
    cacheDir: string;
  };
  realms: RealmConfig[];
  realmsApi: {
    baseUrl: string;
    clientVersion: string;
    storyEventsPathTemplate?: string;
  };
  raknetBackend: 'raknet-native' | 'jsp-raknet';
  dataDir: string;
  presenceSource: 'protocol' | 'api';
  presencePollMs: number;
  storyPollMs: number;
  reconnectBaseMs: number;
};

export type Player = {
  id: string;
  name: string;
  xuid?: string;
  uuid?: string;
  source: 'realms-api' | 'bedrock-protocol';
};

export type RealmEvent = {
  id: string;
  realmId: string;
  playerName?: string;
  content?: string;
  type?: string;
  occurredAt?: string;
  coordinates?: { x?: number; y?: number; z?: number };
  raw?: unknown;
};

export type Dimension = 'overworld' | 'nether' | 'the_end';

export type LocationImage = {
  url: string;
  name?: string;
  contentType?: string;
  size?: number;
};

export type SavedLocation = {
  id: string;
  realmId: string;
  name: string;
  x: number;
  y: number;
  z: number;
  dimension: Dimension;
  note?: string;
  images: LocationImage[];
  createdBy: {
    id: string;
    name: string;
  };
  createdAt: string;
  updatedAt: string;
};

export type LocationCreateInput = {
  name: string;
  x: number;
  y: number;
  z: number;
  dimension: Dimension;
  note?: string;
  images: LocationImage[];
  createdBy: SavedLocation['createdBy'];
};

export type LocationUpdateInput = {
  name?: string;
  x?: number;
  y?: number;
  z?: number;
  dimension?: Dimension;
  note?: string;
  clearNote?: boolean;
  images?: LocationImage[];
  replaceImages?: boolean;
};

export type PersistedRealmState = {
  players: Player[];
  presenceInitialized: boolean;
  lastPresenceAt?: string;
  events: RealmEvent[];
  seenEventIds: string[];
  storyInitialized: boolean;
  lastStoryAt?: string;
  locations: SavedLocation[];
};

export type PersistedState = {
  version: 1;
  realms: Record<string, PersistedRealmState>;
};

export type PresenceChange = {
  realmId: string;
  joined: Player[];
  left: Player[];
  current: Player[];
  checkedAt: string;
};

export type RealmInfo = {
  id: string;
  name?: string;
  motd?: string;
  state?: string;
  ownerXuid?: string;
  maxPlayers?: number;
  activeSlot?: number;
  worldType?: string;
  difficulty?: string;
  raw: unknown;
};

export type JoinInfo = {
  address?: string;
  host?: string;
  port?: number;
  region?: string;
  raw: unknown;
};
