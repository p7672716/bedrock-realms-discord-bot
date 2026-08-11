import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import { StateStore } from '../src/store.js';
import type { Player } from '../src/types.js';

test('state store persists a player snapshot and avoids startup notifications by baseline', async () => {
  const dataDir = `${process.env.TEMP || process.cwd()}/bedrock-realms-bot-test-${Date.now()}-${Math.random()}`;
  const store = new StateStore(dataDir);
  await store.load();
  const player: Player = { id: 'xuid-1', name: 'Alex', source: 'realms-api' };
  store.setPlayers('123', [player], new Date().toISOString(), true);
  await store.flush();

  const second = new StateStore(dataDir);
  await second.load();
  assert.equal(second.getRealm('123').presenceInitialized, true);
  assert.deepEqual(second.getRealm('123').players, [player]);
});

test('event identifiers are deduplicated in persisted state', async () => {
  const dataDir = `${process.env.TEMP || process.cwd()}/bedrock-realms-bot-test-${Date.now()}-${Math.random()}`;
  const store = new StateStore(dataDir);
  await store.load();
  const event = { id: 'event-1', realmId: '123', content: 'Found a village' };
  store.addEvents('123', [event], true);
  store.addEvents('123', [event], true);
  assert.equal(store.getRealm('123').events.length, 1);
  assert.deepEqual(store.getRealm('123').seenEventIds, ['event-1']);
});

test('event emitter is available for the monitor integration boundary', () => {
  const emitter = new EventEmitter();
  let observed = false;
  emitter.on('presence-change', () => { observed = true; });
  emitter.emit('presence-change');
  assert.equal(observed, true);
});

test('Discord player links are unique by Discord account and Minecraft player', async () => {
  const dataDir = `${process.env.TEMP || process.cwd()}/bedrock-realms-bot-links-test-${Date.now()}-${Math.random()}`;
  try {
    const store = new StateStore(dataDir);
    await store.load();
    store.createDiscordPlayerLink({
      guildId: 'guild-1',
      realmId: 'realm-1',
      discordUserId: 'discord-1',
      playerId: 'xuid-1',
      playerName: 'Alex',
      roleId: 'role-1',
      createdAt: new Date().toISOString(),
    });
    assert.throws(() => store.createDiscordPlayerLink({
      guildId: 'guild-1',
      realmId: 'realm-1',
      discordUserId: 'discord-1',
      playerId: 'xuid-2',
      playerName: 'Steve',
      roleId: 'role-2',
      createdAt: new Date().toISOString(),
    }), /PLAYER_LINK_USER_ALREADY_EXISTS/);
    assert.throws(() => store.createDiscordPlayerLink({
      guildId: 'guild-1',
      realmId: 'realm-1',
      discordUserId: 'discord-2',
      playerId: 'xuid-1',
      playerName: 'Alex',
      roleId: 'role-2',
      createdAt: new Date().toISOString(),
    }), /PLAYER_LINK_PLAYER_ALREADY_EXISTS/);
    store.setMonitoringEnabled(false);
    await store.flush();
    const second = new StateStore(dataDir);
    await second.load();
    assert.equal(second.isMonitoringEnabled(), false);
    assert.equal(second.getDiscordPlayerLink('guild-1', 'realm-1', 'discord-1')?.roleId, 'role-1');
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
