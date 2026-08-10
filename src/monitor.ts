import { EventEmitter } from 'node:events';
import type { Logger } from './logger.js';
import { BedrockRealmConnection } from './bedrock-connection.js';
import { RealmApiClient } from './realm-api.js';
import { StateStore } from './store.js';
import type { AppConfig, Player, PresenceChange, RealmConfig, RealmEvent } from './types.js';

export type MonitorNotifier = {
  notifyPresence(change: PresenceChange): Promise<void>;
  notifyRealmEvent(event: RealmEvent): Promise<void>;
};

export class RealmMonitor extends EventEmitter {
  private readonly connections = new Map<string, BedrockRealmConnection>();
  private baselinePending = new Set<string>();
  private presenceTimer?: NodeJS.Timeout;
  private storyTimer?: NodeJS.Timeout;
  private stopped = true;

  constructor(
    private readonly config: AppConfig,
    private readonly api: RealmApiClient,
    private readonly store: StateStore,
    private readonly notifier: MonitorNotifier,
    private readonly log: Logger,
  ) {
    super();
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.baselinePending = new Set(this.config.realms.map((realm) => realm.id));
    if (this.config.presenceSource !== 'api') {
      for (const realm of this.config.realms) {
        const connection = new BedrockRealmConnection(realm, this.config, this.log);
        connection.on('ready', () => void this.pollPresence(realm));
        this.connections.set(realm.id, connection);
        connection.start();
      }
    }
    await Promise.all(this.config.realms.map((realm) => this.pollPresence(realm)));
    await Promise.all(this.config.realms.map((realm) => this.pollStoryEvents(realm, false)));
    this.presenceTimer = setInterval(() => {
      for (const realm of this.config.realms) void this.pollPresence(realm);
    }, this.config.presencePollMs);
    this.storyTimer = setInterval(() => {
      for (const realm of this.config.realms) void this.pollStoryEvents(realm, true);
    }, this.config.storyPollMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    if (this.storyTimer) clearInterval(this.storyTimer);
    for (const connection of this.connections.values()) connection.stop();
    this.connections.clear();
  }

  getPlayers(realmId: string): Player[] {
    const connectionPlayers = this.connections.get(realmId)?.getPlayers();
    if (connectionPlayers) return connectionPlayers;
    return this.store.getRealm(realmId).players;
  }

  getConnectionStatus(realmId: string): { mode: string; ready: boolean; lastPresenceAt?: string } {
    return {
      mode: this.connections.has(realmId) ? 'bedrock-protocol' : 'realms-api',
      ready: this.connections.get(realmId)?.isReady ?? Boolean(this.store.getRealm(realmId).lastPresenceAt),
      lastPresenceAt: this.store.getRealm(realmId).lastPresenceAt,
    };
  }

  private async pollPresence(realm: RealmConfig): Promise<void> {
    if (this.stopped) return;
    try {
      const apiMode = this.config.presenceSource === 'api';
      const players = apiMode ? await this.api.getLivePlayers(realm.id) : this.connections.get(realm.id)?.getPlayers();
      if (players === null || players === undefined) return;
      const checkedAt = new Date().toISOString();
      const previousState = this.store.getRealm(realm.id);
      const previous = previousState.players;
      if (this.baselinePending.has(realm.id) || !previousState.presenceInitialized) {
        this.baselinePending.delete(realm.id);
        this.store.setPlayers(realm.id, sortPlayers(players), checkedAt, true);
        this.emit('presence-baseline', { realmId: realm.id, players });
        return;
      }
      const joined = difference(players, previous);
      const left = difference(previous, players);
      this.store.setPlayers(realm.id, sortPlayers(players), checkedAt, true);
      if (joined.length === 0 && left.length === 0) return;
      const change: PresenceChange = { realmId: realm.id, joined, left, current: sortPlayers(players), checkedAt };
      await this.notifier.notifyPresence(change);
      this.emit('presence-change', change);
    } catch (error) {
      this.log.warn(`Presence check failed for Realm ${realm.id}`, error instanceof Error ? error.message : error);
    }
  }

  private async pollStoryEvents(realm: RealmConfig, notify: boolean): Promise<void> {
    if (this.stopped) return;
    try {
      const incoming = await this.api.getStoryEvents(realm.id);
      if (incoming === null) return;
      const state = this.store.getRealm(realm.id);
      if (!state.storyInitialized) {
        this.store.addEvents(realm.id, incoming, true);
        this.emit('story-baseline', { realmId: realm.id, count: incoming.length });
        return;
      }
      const fresh = incoming.filter((event) => !state.seenEventIds.includes(event.id));
      this.store.addEvents(realm.id, incoming, true);
      if (notify) {
        for (const event of fresh) await this.notifier.notifyRealmEvent(event);
      }
      if (fresh.length > 0) this.emit('realm-events', fresh);
    } catch (error) {
      this.log.warn(`Story event check failed for Realm ${realm.id}`, error instanceof Error ? error.message : error);
    }
  }
}

function difference(current: Player[], previous: Player[]): Player[] {
  const previousIds = new Set(previous.map((player) => player.id));
  return current.filter((player) => !previousIds.has(player.id));
}

function sortPlayers(players: Player[]): Player[] {
  return [...players].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}
