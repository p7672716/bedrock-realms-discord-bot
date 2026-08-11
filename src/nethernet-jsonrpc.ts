import { createRequire } from 'node:module';
import { EventEmitter, once } from 'node:events';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import type { Authflow as AuthflowType } from 'prismarine-auth';
import { CompactSign, importPKCS8 } from 'jose';
import type { Logger } from './logger.js';

const require = createRequire(import.meta.url);
const { Client: NethernetClient, SignalStructure, SignalType } = require('nethernet') as {
  Client: new (networkId: string) => NethernetClientLike;
  SignalStructure: {
    new (type: string, connectionId: bigint, data: string, networkId?: string | bigint): SignalLike;
    fromString(message: string): SignalLike;
  };
  SignalType: { ConnectRequest: string; ConnectResponse: string; CandidateAdd: string };
};
const { WebSocket } = require('ws') as { WebSocket: WebSocketConstructor };

type SignalLike = {
  type: string;
  connectionId: bigint;
  data: string;
  networkId?: string | bigint;
  toString(): string;
};

type NethernetClientLike = EventEmitter & {
  networkId: bigint;
  credentials: unknown[];
  signalHandler: (signal: SignalLike) => void;
  connection?: { close(reason?: string): void };
  socket?: { close(): void };
  pingInterval?: NodeJS.Timeout;
  connect(): void | Promise<void>;
  handleSignal(signal: SignalLike): void;
  send(buffer: Buffer): void;
  close(reason?: string): void;
};

type WebSocketLike = EventEmitter & {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate?(): void;
};

type WebSocketConstructor = new (url: string, options?: { headers?: Record<string, string> }) => WebSocketLike;

const WEB_SOCKET_OPEN = 1;
const SIGNALING_URL = 'wss://signal.franchise.minecraft-services.net/ws/v1.0/messaging/connect';

export type NethernetConnectionOptions = {
  networkId: string;
  version: string;
  authflow: AuthflowType;
  token?: string;
  log: Logger;
};

export class NethernetRealmTransport extends EventEmitter {
  onConnected: () => void = () => undefined;
  onCloseConnection: (reason?: string) => void = () => undefined;
  onEncapsulated: (data: { buffer: Buffer }, address?: unknown) => void = () => undefined;

  private client?: NethernetClientLike;
  private signaling?: JsonRpcSignaling;
  private token?: string;
  private closed = false;

  constructor(private readonly options: NethernetConnectionOptions) {
    super();
    this.token = options.token;
  }

  get connected(): boolean {
    return Boolean(this.client?.connection) && !this.closed;
  }

  setToken(token: string | undefined): void {
    this.token = token;
  }

  connect(): void {
    void this.connectAsync().catch((error) => {
      const reason = error instanceof Error ? error.message : String(error);
      this.options.log.warn(`Could not connect to NetherNet network ${this.options.networkId}`, reason);
      this.close(reason);
      this.onCloseConnection(reason);
    });
  }

  private async connectAsync(): Promise<void> {
    if (this.client) throw new Error('NetherNet connection already exists');
    this.closed = false;

    const client = new NethernetClient(this.options.networkId);
    this.client = client;
    if (client.pingInterval) clearInterval(client.pingInterval);
    client.pingInterval = undefined;
    client.on('connected', () => {
      if (this.closed) return;
      this.emit('connected');
      this.onConnected();
    });
    client.on('disconnect', (_connectionId: unknown, reason: unknown) => {
      this.handleClose(typeof reason === 'string' ? reason : 'NetherNet disconnected');
    });
    client.on('encapsulated', (data: Buffer, address: unknown) => {
      if (this.closed) return;
      this.onEncapsulated({ buffer: Buffer.from(data) }, address);
    });
    client.on('error', (error: unknown) => {
      this.options.log.warn(`NetherNet transport error for network ${this.options.networkId}`, error instanceof Error ? error.message : error);
    });

    const signaling = new JsonRpcSignaling(
      this.options.networkId,
      client.networkId,
      this.options.authflow,
      this.options.version,
      () => this.token,
      this.options.log,
    );
    this.signaling = signaling;
    signaling.on('signal', (signal: SignalLike) => {
      if (!this.closed) client.handleSignal(signal);
    });
    signaling.on('close', (reason: unknown) => {
      if (!this.closed) this.handleClose(typeof reason === 'string' ? reason : 'NetherNet signaling closed');
    });
    signaling.on('error', (error: unknown) => {
      this.options.log.warn(`NetherNet signaling error for network ${this.options.networkId}`, error instanceof Error ? error.message : error);
    });

    try {
      await signaling.connect();
      client.credentials = signaling.credentials;
      client.signalHandler = signaling.write.bind(signaling);
      await client.connect();
    } catch (error) {
      this.close(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  sendReliable(buffer: Buffer): void {
    if (this.closed || !this.client) return;
    this.client.send(buffer);
  }

  close(reason = 'NetherNet connection closed'): void {
    if (this.closed && !this.client && !this.signaling) return;
    this.closed = true;
    const signaling = this.signaling;
    this.signaling = undefined;
    void signaling?.destroy();

    const client = this.client;
    this.client = undefined;
    if (client) {
      try {
        client.close(reason);
      } catch (error) {
        this.options.log.warn('Failed to close NetherNet client', error instanceof Error ? error.message : error);
      }
      if (client.pingInterval) clearInterval(client.pingInterval);
      // node-nethernet schedules its own UDP socket close. Calling socket.close
      // here as well races that timer and can terminate the whole bot with
      // ERR_SOCKET_DGRAM_NOT_RUNNING.
    }
  }

  private handleClose(reason: string): void {
    if (this.closed) return;
    this.onCloseConnection(reason);
    this.close(reason);
  }
}

class JsonRpcSignaling extends EventEmitter {
  credentials: unknown[] = [];
  private ws?: WebSocketLike;
  private pingInterval?: NodeJS.Timeout;
  private lastLiveness = 0;
  private destroyed = false;
  private connectRequestSent = false;
  private pendingCandidates: SignalLike[] = [];
  private pendingRemoteCandidates: SignalLike[] = [];
  private connectionId?: bigint;
  private candidatesSent = false;

  constructor(
    private readonly serverNetworkId: string,
    private readonly clientNetworkId: bigint,
    private readonly authflow: AuthflowType,
    private readonly version: string,
    private readonly token: () => string | undefined,
    private readonly log: Logger,
  ) {
    super();
  }

  async connect(): Promise<void> {
    if (this.ws?.readyState === WEB_SOCKET_OPEN) throw new Error('NetherNet signaling is already connected');
    this.destroyed = false;
    const mcToken = await this.authflow.getMinecraftBedrockServicesToken({ version: this.version });
    const ws = new WebSocket(SIGNALING_URL, {
      headers: {
        Authorization: mcToken.mcToken,
        'session-id': randomUUID(),
        'request-id': randomUUID(),
      },
    });
    this.ws = ws;
    this.lastLiveness = Date.now();
    ws.on('open', () => this.onOpen());
    ws.on('close', (code: unknown, reason: unknown) => this.onClose(Number(code), String(reason || '')));
    ws.on('error', (error: unknown) => this.emit('error', error));
    ws.on('message', (data: unknown) => void this.onMessage(data));

    this.pingInterval = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WEB_SOCKET_OPEN) return;
      this.sendRpc('System_Ping_v1_0', {});
      if (Date.now() - this.lastLiveness > 60_000) {
        this.ws.terminate?.();
      }
    }, 2_000);

    try {
      await Promise.race([
        once(this, 'credentials'),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('NetherNet signaling credentials timed out')), 15_000)),
      ]);
    } catch (error) {
      await this.destroy();
      throw error;
    }
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    if (this.pingInterval) clearInterval(this.pingInterval);
    this.pingInterval = undefined;
    const ws = this.ws;
    this.ws = undefined;
    if (!ws) return;
    ws.removeAllListeners();
    if (ws.readyState === 0 || ws.readyState === WEB_SOCKET_OPEN) {
      await new Promise<void>((resolve) => {
        ws.once('close', () => resolve());
        try {
          ws.close(1000, 'Normal Closure');
        } catch {
          resolve();
        }
      });
    }
  }

  async write(signal: SignalLike): Promise<void> {
    if (!this.ws || this.ws.readyState !== WEB_SOCKET_OPEN) throw new Error('NetherNet signaling WebSocket is not open');
    if (signal.type === SignalType.CandidateAdd && !this.connectRequestSent) {
      if (!isUsableCandidate(signal.data)) return;
      const candidate = withNetworkCost(signal, this.pendingCandidates.length === 0 ? 50 : 10);
      this.pendingCandidates.push(candidate);
      return;
    }
    let data = signal.toString();
    if (signal.type === SignalType.CandidateAdd) {
      if (!isUsableCandidate(signal.data)) return;
      data = withNetworkCost(signal, 10).toString();
    }
    if (signal.type === SignalType.ConnectRequest) {
      this.connectionId = signal.connectionId;
      data = await this.prepareConnectRequest(data);
      this.connectRequestSent = true;
    }

    this.sendSignalPayload(signal.networkId, data);
  }

  private onOpen(): void {
    this.lastLiveness = Date.now();
    this.sendRpc('Signaling_TurnAuth_v1_0', {});
  }

  private onClose(code: number, reason: string): void {
    if (this.destroyed) return;
    this.emit('close', `NetherNet signaling closed: ${code} ${reason}`.trim());
  }

  private async onMessage(raw: unknown): Promise<void> {
    this.lastLiveness = Date.now();
    let message: any;
    try {
      const text = typeof raw === 'string'
        ? raw
        : Buffer.isBuffer(raw)
          ? raw.toString('utf8')
          : String(raw);
      message = JSON.parse(text);
    } catch (error) {
      this.log.warn('Ignoring invalid NetherNet signaling JSON', error instanceof Error ? error.message : error);
      return;
    }

    if (Array.isArray(message.result?.TurnAuthServers)) {
      this.credentials = parseTurnServers(message.result.TurnAuthServers);
      this.emit('credentials', this.credentials);
    }

    switch (message.method) {
      case 'System_Pong_v1_0':
        this.sendRpcResult(message.id, null);
        break;
      case 'Signaling_ReceiveMessage_v1_0': {
        this.sendRpcResult(message.id, null);
        const params = Array.isArray(message.params) ? message.params : message.params ? [message.params] : [];
        for (const param of params) await this.handleIncomingMessage(param);
        break;
      }
      default:
        break;
    }
  }

  private async handleIncomingMessage(param: any): Promise<void> {
    if (!param || typeof param.Message !== 'string') return;
    this.sendDeliveryNotification(param.From, param.Id);
    let signalMessage = param.Message;
    try {
      const nested = JSON.parse(param.Message);
      if (nested.method === 'Signaling_DeliveryNotification_V1_0') return;
      if (nested.method === 'Signaling_WebRtc_v1_0' && typeof nested.params?.message === 'string') {
        signalMessage = nested.params.message;
      }
    } catch {
      // Older signaling messages are plain SignalStructure strings.
    }
    if (!signalMessage || /could not be delivered/i.test(signalMessage)) return;

    try {
      const signal = SignalStructure.fromString(signalMessage);
      signal.networkId = String(param.From ?? this.serverNetworkId);
      if (signal.type === SignalType.CandidateAdd && !isUsableCandidate(signal.data)) return;

      // The Realm peer creates its ICE side after accepting the offer. Match
      // the Bedrock client behavior by holding candidates until the answer is
      // received, then flush both directions in a deterministic order.
      if (signal.type === SignalType.CandidateAdd && !this.candidatesSent) {
        this.pendingRemoteCandidates.push(signal);
        return;
      }
      if (signal.type === SignalType.ConnectResponse && signal.connectionId === this.connectionId && !this.candidatesSent) {
        this.candidatesSent = true;
        const outgoing = this.pendingCandidates;
        this.pendingCandidates = [];
        for (const candidate of outgoing) await this.write(candidate);
        const incoming = this.pendingRemoteCandidates;
        this.pendingRemoteCandidates = [];
        for (const candidate of incoming) this.emit('signal', candidate);
      }
      this.emit('signal', signal);
    } catch (error) {
      this.log.warn('Ignoring invalid NetherNet signal message', error instanceof Error ? error.message : error);
    }
  }

  private sendDeliveryNotification(toPlayerId: unknown, messageId: unknown): void {
    if (!toPlayerId || !messageId) return;
    const id = randomUUID();
    const inner = JSON.stringify({
      params: { messageId: String(messageId) },
      jsonrpc: '2.0',
      method: 'Signaling_DeliveryNotification_V1_0',
    });
    this.sendRpc('Signaling_SendClientMessage_v1_0', {
      toPlayerId: String(toPlayerId),
      messageId: id,
      message: inner,
    }, id);
  }

  private sendRpc(method: string, params: unknown, id = randomUUID()): void {
    if (!this.ws || this.ws.readyState !== WEB_SOCKET_OPEN) return;
    this.ws.send(JSON.stringify({ params, jsonrpc: '2.0', method, id }));
  }

  private sendRpcResult(id: unknown, result: unknown): void {
    if (!this.ws || this.ws.readyState !== WEB_SOCKET_OPEN || id === undefined) return;
    this.ws.send(JSON.stringify({ id, result, jsonrpc: '2.0' }));
  }

  private async prepareConnectRequest(signal: string): Promise<string> {
    const [, , ...sdpParts] = signal.split(' ');
    const originalSdp = sdpParts.join(' ');
    const prefix = signal.slice(0, signal.length - originalSdp.length);
    let sdp = originalSdp;
    sdp = sdp.replace(/^o=.*$/m, `o=- ${this.clientNetworkId} 2 IN IP4 127.0.0.1`);
    const fingerprint = sdp.match(/^a=fingerprint:sha-256\s+(.+)$/m)?.[1];
    const token = this.token();
    if (!fingerprint || !token) return `${prefix}${sdp}`;

    const { privateKey } = generateKeyPairSync('ec' as any, {
      namedCurve: 'P-384',
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const key = await importPKCS8(privateKey as unknown as string, 'ES384');
    const payload = JSON.stringify({ fingerprint: [{ algorithm: 'sha-256', digest: fingerprint }] });
    const signed = await new CompactSign(new TextEncoder().encode(payload))
      .setProtectedHeader({ alg: 'ES384' })
      .sign(key);
    const [header, , signature] = signed.split('.');
    const assertion = Buffer.from(JSON.stringify({
      assertion: JSON.stringify({ fingerprints: `${header}..${signature}`, token }),
      idp: {
        domain: 'https://authorization.franchise.minecraft-services.net/',
        protocol: 'default',
      },
    })).toString('base64');
    const identitySdp = sdp.replace(/^(a=fingerprint:sha-256\s+.*)$/m, `$1\na=identity:${assertion}`);
    return `${prefix}${identitySdp}`;
  }

  private sendSignalPayload(networkId: string | bigint | undefined, data: string): void {
    const messageId = randomUUID();
    const inner = JSON.stringify({
      params: {
        netherNetId: String(this.clientNetworkId),
        message: data,
      },
      jsonrpc: '2.0',
      method: 'Signaling_WebRtc_v1_0',
    });
    this.sendRpc('Signaling_SendClientMessage_v1_0', {
      toPlayerId: String(networkId ?? this.serverNetworkId),
      messageId,
      message: inner,
    }, messageId);
  }
}

function isUsableCandidate(candidate: string): boolean {
  return !/(?:tcp|::1|127\.0\.0\.1)/i.test(candidate);
}

function withNetworkCost(signal: SignalLike, cost: number): SignalLike {
  const data = signal.data.replace(/\s+network-cost\s+\d+\s*$/i, '').trim();
  return new SignalStructure(SignalType.CandidateAdd, signal.connectionId, `${data} network-cost ${cost}`, signal.networkId);
}

function parseTurnServers(servers: any[]): unknown[] {
  const output: unknown[] = [];
  for (const server of servers) {
    if (!server || !Array.isArray(server.Urls)) continue;
    const urls = server.Urls.filter((url: unknown): url is string => typeof url === 'string' && url.trim().length > 0);
    if (urls.length === 0) continue;
    output.push({
      urls,
      username: typeof server.Username === 'string' ? server.Username : undefined,
      credential: typeof server.Password === 'string' ? server.Password : server.Credential,
    });
  }
  return output;
}
