import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import type { Authflow as AuthflowType } from 'prismarine-auth';
import type { RealmConfig } from './types.js';
import type { Logger } from './logger.js';
import { NethernetRealmTransport } from './nethernet-jsonrpc.js';

const require = createRequire(import.meta.url);
const bedrock = require('bedrock-protocol') as any;
const { createSerializer, createDeserializer } = require('bedrock-protocol/src/transforms/serializer') as any;
const { Framer } = require('bedrock-protocol/src/transforms/framer') as any;
const { ClientStatus } = require('bedrock-protocol/src/connection') as any;
const { KeyExchange } = require('bedrock-protocol/src/handshake/keyExchange') as any;
const Login = require('bedrock-protocol/src/handshake/login') as (client: any, server: unknown, options: unknown) => void;
const LoginVerify = require('bedrock-protocol/src/handshake/loginVerify') as (client: any, server: unknown, options: unknown) => void;
const JWT = require('jsonwebtoken') as { sign(payload: unknown, key: unknown, options: unknown): string };

export type NethernetClientLike = any;

export type NethernetClientOptions = {
  realm: RealmConfig;
  networkId: string;
  version: string;
  authflow: AuthflowType;
  username: string;
  profilesFolder: string;
  onMsaCode: (code: unknown) => void;
  log: Logger;
};

export function createNethernetClient(options: NethernetClientOptions): NethernetClientLike {
  const client = new bedrock.Client({
    username: options.username,
    profilesFolder: options.profilesFolder,
    version: options.version,
    host: 'nethernet',
    port: 19132,
    authflow: options.authflow,
    conLog: null,
    onMsaCode: options.onMsaCode,
    connectTimeout: 30_000,
    delayedInit: true,
  });

  // Reuse bedrock-protocol's current packet definitions, authentication setup,
  // and handshake state machine, but install a NetherNet transport instead of
  // constructing its RakNet connection.
  client.validateOptions();
  client.serializer = createSerializer(client.options.version);
  client.deserializer = createDeserializer(client.options.version);
  client._loadFeatures();
  KeyExchange(client, null, client.options);
  Login(client, null, client.options);
  LoginVerify(client, null, client.options);

  const transport = new NethernetRealmTransport({
    networkId: options.networkId,
    version: options.version,
    authflow: options.authflow,
    identityPrivateKeyPem: client.ecdhKeyPair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    log: options.log,
  });
  client.connection = transport;
  client.batchHeader = null;
  client.disableEncryption = true;
  client.encryptionEnabled = false;

  let receivedPackets = 0;
  client.on('packet', (packet: any) => {
    if (receivedPackets >= 20) return;
    receivedPackets += 1;
    options.log.info(`Realm ${options.realm.id} Bedrock packet received`, {
      packet: packet?.data?.name,
      bytes: packet?.fullBuffer?.length,
    });
  });
  client.on('loggingIn', () => options.log.info(`Realm ${options.realm.id} Bedrock login sent`));
  client.on('join', () => options.log.info(`Realm ${options.realm.id} Bedrock login accepted`));

  // NetherNet already provides an authenticated encrypted WebRTC channel. The
  // RakNet ECDH/AES encryption must not be enabled for this transport. Keep
  // the normal handshake listeners, though: the server still expects the
  // client to acknowledge its handshake before sending play packets.
  client.startEncryption = () => {
    client.encryptionEnabled = false;
  };

  client.on('session', () => {
    transport.setToken(client.multiplayerToken);
  });

  client.handle = (buffer: Buffer) => {
    for (const packet of decodeNethernetBatch(client, buffer)) client.readPacket(packet);
  };
  client.sendLogin = () => sendNethernetLogin(client);

  return client;
}

function decodeNethernetBatch(client: any, buffer: Buffer): Buffer[] {
  let payload: Buffer;
  if (client.features?.compressorInHeader && client.compressionReady) {
    payload = Framer.decompress(buffer[0], buffer.subarray(1));
  } else {
    try {
      payload = Framer.decompress(client.compressionAlgorithm, buffer);
    } catch {
      payload = buffer;
    }
  }
  return Framer.getPackets(payload);
}

function sendNethernetLogin(client: any): void {
  client.status = ClientStatus.Authenticating;
  const data = require('minecraft-data')('bedrock_' + client.options.version);
  const tokenData = decodeTokenPayload(client.multiplayerToken);
  const playFabId = String(tokenData?.mid || tokenData?.pfbid || '').toLowerCase();
  const payload = {
    ...data.defaultSkin,
    GameVersion: client.options.version,
    PersonaSkin: true,
    DeviceOS: 2,
    DeviceId: randomUUID(),
    DeviceModel: 'PrismarineJS-NetherNet',
    CurrentInputMode: 2,
    DefaultInputMode: 2,
    SelfSignedId: randomUUID(),
    GuiScale: 0,
    UIProfile: 1,
    LanguageCode: 'en_US',
    MaxViewDistance: 12,
    MemoryTier: 4,
    PlatformType: 1,
    GraphicsMode: 1,
    TrustedSkin: true,
    OverrideSkin: false,
    PlayFabId: playFabId,
    SkinId: `persona-${playFabId}-5`,
    ThirdPartyName: client.username,
  };
  const clientToken = JWT.sign(payload, client.ecdhKeyPair.privateKey, {
    algorithm: 'ES384',
    header: { x5u: client.clientX509 },
    noTimestamp: true,
  });
  const identity = JSON.stringify({
    Certificate: JSON.stringify({ chain: [] }),
    AuthenticationType: 0,
    Token: client.multiplayerToken || '',
  });
  client.write('login', {
    protocol_version: client.options.protocolVersion,
    tokens: {
      identity,
      client: clientToken,
    },
  });
  client.emit('loggingIn');
}

function decodeTokenPayload(token: unknown): Record<string, any> | undefined {
  if (typeof token !== 'string') return undefined;
  const [, payload] = token.split('.');
  if (!payload) return undefined;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
}
