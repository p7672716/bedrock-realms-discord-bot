import { EventEmitter } from 'node:events';
import bedrock from 'bedrock-protocol';
import type { AppConfig, Player, RealmConfig } from './types.js';
import type { Logger } from './logger.js';

type Packet = Record<string, any>;
type ClientLike = EventEmitter & {
  profile?: { name?: string; xuid?: string; uuid?: string };
  username?: string;
  close(): void;
  disconnect(reason?: string): void;
};

export class BedrockRealmConnection extends EventEmitter {
  private client?: ClientLike;
  private readonly players = new Map<string, Player>();
  private ownProfile?: { name?: string; xuid?: string; uuid?: string };
  private ready = false;
  private stopped = false;
  private reconnectTimer?: NodeJS.Timeout;
  private reconnectAttempt = 0;
  private settleTimer?: NodeJS.Timeout;

  constructor(
    private readonly realm: RealmConfig,
    private readonly config: AppConfig,
    private readonly log: Logger,
  ) {
    super();
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.ready = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.client?.close();
    this.client = undefined;
  }

  get isReady(): boolean {
    return this.ready;
  }

  getPlayers(): Player[] | null {
    return this.ready ? sortPlayers([...this.players.values()].filter((player) => !this.isSelf(player))) : null;
  }

  private connect(): void {
    if (this.stopped) return;
    this.ready = false;
    this.players.clear();
    try {
      const client = bedrock.createClient({
        username: this.config.auth.cacheKey,
        profilesFolder: this.config.auth.cacheDir,
        version: this.config.realmsApi.clientVersion as any,
        realms: { realmId: this.realm.id },
        raknetBackend: 'jsp-raknet',
        conLog: null,
        onMsaCode: (code: any) => {
          const uri = code.verification_uri || code.verificationUri || 'https://www.microsoft.com/link';
          const userCode = code.user_code || code.userCode || 'unknown';
          this.log.warn(`Microsoft authentication is required for Realm ${this.realm.id}. Open ${uri} and enter code ${userCode}.`);
        },
      } as any) as ClientLike;
      this.client = client;
      client.on('session', (profile: any) => {
        this.ownProfile = profile;
      });
      client.on('player_list', (packet: Packet) => this.handlePlayerList(packet));
      client.on('add_player', (packet: Packet) => this.addPlayer(packet));
      client.on('remove_player', (packet: Packet) => this.removePlayer(packet));
      client.on('spawn', () => this.onSpawn());
      client.on('error', (error: unknown) => {
        this.log.warn(`Bedrock connection error for Realm ${this.realm.id}`, error instanceof Error ? error.message : error);
      });
      client.on('kick', (packet: Packet) => {
        this.log.warn(`Bedrock connection was kicked for Realm ${this.realm.id}`, packet?.message || packet);
      });
      client.on('close', () => this.onClose());
    } catch (error) {
      this.log.error(`Could not create Bedrock connection for Realm ${this.realm.id}`, error);
      this.scheduleReconnect();
    }
  }

  private onSpawn(): void {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      if (this.stopped || !this.client) return;
      this.ready = true;
      this.reconnectAttempt = 0;
      this.log.info(`Bedrock connection ready for Realm ${this.realm.id}`, { players: this.players.size });
      this.emit('ready');
    }, 3_000);
  }

  private onClose(): void {
    this.ready = false;
    if (this.stopped) return;
    this.log.warn(`Bedrock connection closed for Realm ${this.realm.id}`);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = Math.min(this.config.reconnectBaseMs * 2 ** this.reconnectAttempt, 300_000);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
  }

  private handlePlayerList(packet: Packet): void {
    const type = packet.type === 1 || packet.type === 'remove' ? 'remove' : 'add';
    const entries = packet.records ?? packet.entries ?? packet.players ?? [];
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      if (type === 'remove') this.removePlayer(entry);
      else this.addPlayer(entry);
    }
  }

  private addPlayer(packet: Packet): void {
    const rawId = packet.xbox_user_id ?? packet.xuid ?? packet.player_id ?? packet.uuid ?? packet.unique_id;
    if (rawId === undefined && !packet.username) return;
    const id = String(rawId ?? packet.username);
    const player: Player = {
      id,
      name: String(packet.username ?? packet.name ?? id),
      xuid: packet.xbox_user_id === undefined ? undefined : String(packet.xbox_user_id),
      uuid: packet.uuid === undefined ? undefined : String(packet.uuid),
      source: 'bedrock-protocol',
    };
    if (!this.isSelf(player)) this.players.set(id, player);
  }

  private removePlayer(packet: Packet): void {
    const candidates = [packet.xbox_user_id, packet.xuid, packet.player_id, packet.uuid, packet.unique_id]
      .filter((value) => value !== undefined)
      .map(String);
    for (const key of candidates) this.players.delete(key);
    for (const [key, player] of this.players) {
      if (candidates.includes(player.uuid || '') || candidates.includes(player.xuid || '')) this.players.delete(key);
    }
  }

  private isSelf(player: Player): boolean {
    const profile = this.ownProfile;
    return Boolean(
      (profile?.xuid && player.xuid === String(profile.xuid)) ||
      (profile?.uuid && player.uuid === String(profile.uuid)) ||
      (profile?.name && player.name === profile.name),
    );
  }
}

function sortPlayers(players: Player[]): Player[] {
  return players.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}
