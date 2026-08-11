import { EventEmitter } from 'node:events';
import type { Logger } from './logger.js';
import { BedrockRealmConnection } from './bedrock-connection.js';
import { RealmApiClient } from './realm-api.js';
import { StateStore } from './store.js';
import type { AppConfig, AuthPrompt, Player, PresenceChange, RealmConfig, RealmEvent } from './types.js';
import { isUsablePlayerName } from './player.js';

export type MonitorStatus = {
  enabled: boolean;
  state: 'disabled' | 'connecting' | 'ready' | 'auth-required' | 'account-in-use' | 'error';
  prompt?: AuthPrompt;
  lastError?: string;
};

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
  private authState: MonitorStatus['state'] = 'disabled';
  private authPrompt?: AuthPrompt;
  private lastError?: string;

  constructor(
    private readonly config: AppConfig,
    private readonly api: RealmApiClient,
    private readonly store: StateStore,
    private readonly notifier: MonitorNotifier,
    private readonly log: Logger,
  ) {
    super();
    this.api.on('auth-required', (prompt: AuthPrompt) => this.reportAuthRequired(prompt));
  }

  async start(): Promise<void> {
    if (!this.store.isMonitoringEnabled()) {
      this.authState = 'disabled';
      return;
    }
    this.startRuntime();
  }

  async enable(): Promise<void> {
    this.store.setMonitoringEnabled(true);
    if (this.stopped) this.startRuntime();
  }

  async disable(): Promise<void> {
    this.store.setMonitoringEnabled(false);
    this.stopRuntime();
    this.authState = 'disabled';
    this.authPrompt = undefined;
  }

  getStatus(): MonitorStatus {
    return {
      enabled: this.store.isMonitoringEnabled(),
      state: this.store.isMonitoringEnabled() ? this.authState : 'disabled',
      prompt: this.authPrompt,
      lastError: this.lastError,
    };
  }

  private startRuntime(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.authState = 'connecting';
    this.lastError = undefined;
    this.authPrompt = undefined;
    this.baselinePending = new Set(this.config.realms.map((realm) => realm.id));
    if (this.config.presenceSource !== 'api') {
      for (const realm of this.config.realms) {
        const connection = new BedrockRealmConnection(realm, this.config, this.api, this.log);
        connection.on('ready', () => {
          this.authState = 'ready';
          void this.pollPresence(realm);
        });
        connection.on('auth-required', (prompt: AuthPrompt) => this.reportAuthRequired({ ...prompt, realmId: realm.id }));
        connection.on('account-in-use', (reason: string) => {
          this.authState = 'account-in-use';
          this.lastError = reason;
          this.emit('account-in-use', { realmId: realm.id, reason });
        });
        this.connections.set(realm.id, connection);
        connection.start();
      }
    }
    void Promise.all(this.config.realms.map((realm) => this.pollPresence(realm)));
    void Promise.all(this.config.realms.map((realm) => this.pollStoryEvents(realm, false)));
    this.presenceTimer = setInterval(() => {
      for (const realm of this.config.realms) void this.pollPresence(realm);
    }, this.config.presencePollMs);
    this.storyTimer = setInterval(() => {
      for (const realm of this.config.realms) void this.pollStoryEvents(realm, true);
    }, this.config.storyPollMs);
  }

  stop(): void {
    this.stopRuntime();
  }

  private stopRuntime(): void {
    this.stopped = true;
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    if (this.storyTimer) clearInterval(this.storyTimer);
    this.presenceTimer = undefined;
    this.storyTimer = undefined;
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

  private reportAuthRequired(prompt: AuthPrompt): void {
    this.authPrompt = prompt;
    this.authState = 'auth-required';
    this.emit('auth-required', prompt);
  }

  private async pollPresence(realm: RealmConfig): Promise<void> {
    if (this.stopped) return;
    try {
      const apiMode = this.config.presenceSource === 'api';
      let players = apiMode ? await this.api.getLivePlayers(realm.id) : this.connections.get(realm.id)?.getPlayers();
      if (players === null || players === undefined) return;
      if (!apiMode && players.some((player) => !isUsablePlayerName(player.name))) {
        const apiPlayers = await this.api.getLivePlayers(realm.id).catch(() => null);
        if (apiPlayers) players = mergePlayerNames(players, apiPlayers);
      }
      if (this.authState === 'connecting' || this.authState === 'error') this.authState = 'ready';
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
      if (isAuthError(error)) {
        this.authState = 'error';
        this.lastError = error instanceof Error ? error.message : String(error);
      }
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
      if (isAuthError(error)) {
        this.authState = 'error';
        this.lastError = error instanceof Error ? error.message : String(error);
      }
      this.log.warn(`Story event check failed for Realm ${realm.id}`, error instanceof Error ? error.message : error);
    }
  }
}

function isAuthError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /(401|403|auth|login|token|xbox|microsoft|not.?authenticated|sign.?in)/i.test(text);
}

function mergePlayerNames(protocolPlayers: Player[], apiPlayers: Player[]): Player[] {
  return protocolPlayers.map((player) => {
    if (isUsablePlayerName(player.name)) return player;
    const match = apiPlayers.find((candidate) => (
      candidate.id === player.id
      || (player.xuid && candidate.xuid === player.xuid)
      || (player.uuid && candidate.uuid === player.uuid)
    ));
    return match?.name && isUsablePlayerName(match.name) ? { ...player, name: match.name } : player;
  });
}

function difference(current: Player[], previous: Player[]): Player[] {
  const previousIds = new Set(previous.map((player) => player.id));
  return current.filter((player) => !previousIds.has(player.id));
}

function sortPlayers(players: Player[]): Player[] {
  return [...players].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}
