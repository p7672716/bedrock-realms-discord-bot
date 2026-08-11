import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  LocationCreateInput,
  LocationImage,
  LocationUpdateInput,
  PersistedRealmState,
  PersistedState,
  Player,
  RealmEvent,
  SavedLocation,
} from './types.js';

const emptyRealmState = (): PersistedRealmState => ({
  players: [],
  presenceInitialized: false,
  events: [],
  seenEventIds: [],
  storyInitialized: false,
  locations: [],
});

export class StateStore {
  private state: PersistedState = { version: 1, realms: {} };
  private writeChain: Promise<void> = Promise.resolve();
  private readonly filePath: string;

  constructor(private readonly dataDir: string) {
    this.filePath = path.join(dataDir, 'state.json');
  }

  async load(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistedState>;
      if (parsed.version !== 1 || !parsed.realms || typeof parsed.realms !== 'object') {
        throw new Error('unsupported state version');
      }
      this.state = {
        version: 1,
        realms: Object.fromEntries(
          Object.entries(parsed.realms as Record<string, Partial<PersistedRealmState>>).map(([realmId, realm]) => [
            realmId,
            {
              ...emptyRealmState(),
              ...realm,
              locations: Array.isArray(realm.locations) ? realm.locations : [],
            },
          ]),
        ),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`State file could not be loaded; starting with an empty state: ${String(error)}`);
      }
      await this.flush();
    }
  }

  getRealm(realmId: string): PersistedRealmState {
    this.state.realms[realmId] ??= emptyRealmState();
    this.state.realms[realmId].locations ??= [];
    return this.state.realms[realmId];
  }

  listLocations(realmId: string): SavedLocation[] {
    return [...this.getRealm(realmId).locations].sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  }

  searchLocations(realmId: string, query: string): SavedLocation[] {
    const normalizedQuery = normalizeLocationName(query);
    return this.listLocations(realmId).filter((location) => (
      normalizeLocationName(location.name).includes(normalizedQuery)
      || normalizeLocationName(location.note || '').includes(normalizedQuery)
    ));
  }

  getLocation(realmId: string, name: string): SavedLocation | undefined {
    return this.getRealm(realmId).locations.find(
      (location) => normalizeLocationName(location.name) === normalizeLocationName(name),
    );
  }

  deleteLocation(realmId: string, targetName: string): SavedLocation {
    const realm = this.getRealm(realmId);
    const index = realm.locations.findIndex(
      (location) => normalizeLocationName(location.name) === normalizeLocationName(targetName),
    );
    if (index < 0) throw new Error('LOCATION_NOT_FOUND');
    const [location] = realm.locations.splice(index, 1);
    void this.flush();
    return location;
  }

  createLocation(realmId: string, input: LocationCreateInput): SavedLocation {
    const realm = this.getRealm(realmId);
    if (realm.locations.some((location) => normalizeLocationName(location.name) === normalizeLocationName(input.name))) {
      throw new Error('LOCATION_NAME_ALREADY_EXISTS');
    }
    const now = new Date().toISOString();
    const location: SavedLocation = {
      id: randomUUID(),
      realmId,
      name: input.name.trim(),
      x: input.x,
      y: input.y,
      z: input.z,
      dimension: input.dimension,
      note: input.note?.trim() || undefined,
      images: [...input.images],
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    };
    realm.locations.push(location);
    void this.flush();
    return location;
  }

  updateLocation(realmId: string, targetName: string, input: LocationUpdateInput): SavedLocation {
    const realm = this.getRealm(realmId);
    const location = this.getLocation(realmId, targetName);
    if (!location) throw new Error('LOCATION_NOT_FOUND');

    if (input.name !== undefined) {
      const nextName = input.name.trim();
      if (!nextName) throw new Error('LOCATION_NAME_REQUIRED');
      const duplicate = realm.locations.some(
        (candidate) => candidate.id !== location.id && normalizeLocationName(candidate.name) === normalizeLocationName(nextName),
      );
      if (duplicate) throw new Error('LOCATION_NAME_ALREADY_EXISTS');
      location.name = nextName;
    }
    if (input.x !== undefined) location.x = input.x;
    if (input.y !== undefined) location.y = input.y;
    if (input.z !== undefined) location.z = input.z;
    if (input.dimension !== undefined) location.dimension = input.dimension;
    if (input.note !== undefined) location.note = input.note.trim() || undefined;
    if (input.clearNote) delete location.note;
    if (input.images?.length) {
      location.images = input.replaceImages ? [...input.images] : [...location.images, ...input.images];
    } else if (input.replaceImages) {
      location.images = [];
    }
    location.updatedAt = new Date().toISOString();
    void this.flush();
    return location;
  }

  addLocationImages(realmId: string, targetName: string, images: LocationImage[]): SavedLocation {
    if (images.length === 0) throw new Error('LOCATION_IMAGES_REQUIRED');
    const location = this.getLocation(realmId, targetName);
    if (!location) throw new Error('LOCATION_NOT_FOUND');
    location.images = [...location.images, ...images.filter((image) => !location.images.some((existing) => existing.url === image.url))];
    location.updatedAt = new Date().toISOString();
    void this.flush();
    return location;
  }

  removeLocationImage(realmId: string, targetName: string, imageIndex: number): SavedLocation {
    const location = this.getLocation(realmId, targetName);
    if (!location) throw new Error('LOCATION_NOT_FOUND');
    if (!Number.isInteger(imageIndex) || imageIndex < 1 || imageIndex > location.images.length) {
      throw new Error('LOCATION_IMAGE_INDEX_INVALID');
    }
    location.images.splice(imageIndex - 1, 1);
    location.updatedAt = new Date().toISOString();
    void this.flush();
    return location;
  }

  setPlayers(realmId: string, players: Player[], checkedAt: string, initialized = true): void {
    const realm = this.getRealm(realmId);
    realm.players = players;
    realm.lastPresenceAt = checkedAt;
    realm.presenceInitialized = initialized;
    void this.flush();
  }

  addEvents(realmId: string, events: RealmEvent[], initialized?: boolean): void {
    const realm = this.getRealm(realmId);
    const byId = new Map(realm.events.map((event) => [event.id, event]));
    for (const event of events) byId.set(event.id, event);
    realm.events = [...byId.values()]
      .sort((a, b) => (b.occurredAt || '').localeCompare(a.occurredAt || ''))
      .slice(0, 200);
    realm.seenEventIds = [...new Set([...realm.seenEventIds, ...events.map((event) => event.id)])].slice(-1000);
    realm.lastStoryAt = new Date().toISOString();
    if (initialized !== undefined) realm.storyInitialized = initialized;
    void this.flush();
  }

  async flush(): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      const temporaryPath = `${this.filePath}.tmp`;
      await fs.writeFile(temporaryPath, JSON.stringify(this.state, null, 2), 'utf8');
      await fs.rename(temporaryPath, this.filePath);
    });
    return this.writeChain;
  }
}

function normalizeLocationName(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('ja-JP');
}
