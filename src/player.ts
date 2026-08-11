import type { DiscordPlayerLink, Player } from './types.js';

/**
 * Bedrock 1.26.x can expose persona names as a UUID-shaped hex string. The
 * first byte is a length/control byte and the remaining bytes are the UTF-8
 * value (for example, "persona-a100e1e"). Keep normal UUIDs untouched.
 */
export function normalizeBedrockPlayerName(value: unknown): string {
  const text = String(value ?? '').trim();
  if (!text || !isUsablePlayerName(text)) return '';
  return text;
}

export function sanitizePlayerName(value: unknown): string {
  return normalizeBedrockPlayerName(value) || '不明なプレイヤー';
}

export function isUsablePlayerName(value: unknown): boolean {
  const text = String(value ?? '').trim();
  if (!text || text === '不明なプレイヤー' || /[\u0000-\u001F\u007F]/.test(text)) return false;
  if (decodePersonaName(text)) return false;
  return !isUuidLike(text);
}

export function normalizePlayerKey(value: unknown): string {
  return String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase('ja-JP');
}

export function playerMatchesLink(player: Player, link: DiscordPlayerLink): boolean {
  const ids = [player.id, player.xuid, player.uuid].filter(Boolean).map(String);
  if ([link.playerId, link.xuid, link.uuid].filter(Boolean).some((value) => ids.includes(String(value)))) return true;
  return normalizePlayerKey(player.name) === normalizePlayerKey(link.playerName);
}

function decodePersonaName(value: string): string | undefined {
  const compact = value.replaceAll('-', '');
  if (compact.length < 8 || compact.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(compact)) return undefined;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(compact, 'hex');
  } catch {
    return undefined;
  }
  const candidates = [bytes, bytes.subarray(1)];
  for (const candidate of candidates) {
    const decoded = candidate.toString('utf8');
    if (decoded.includes('\uFFFD') || /[\u0000-\u001F\u007F]/.test(decoded)) continue;
    if (/^persona-[a-z0-9_-]+$/i.test(decoded)) return decoded;
  }
  return undefined;
}

function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
