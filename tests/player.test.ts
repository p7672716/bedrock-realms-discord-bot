import test from 'node:test';
import assert from 'node:assert/strict';
import { isUsablePlayerName, sanitizePlayerName } from '../src/player.js';

test('invalid Bedrock persona identifiers are not displayed as player names', () => {
  const personaIdentifier = '1a706572-736f-6e61-2d61-313030653165';
  assert.equal(isUsablePlayerName(personaIdentifier), false);
  assert.equal(sanitizePlayerName(personaIdentifier), '不明なプレイヤー');
  assert.equal(sanitizePlayerName('Alex'), 'Alex');
});

test('RFC UUIDs are treated as identifiers rather than display names', () => {
  assert.equal(isUsablePlayerName('123e4567-e89b-12d3-a456-426614174000'), false);
  assert.equal(sanitizePlayerName('123e4567-e89b-12d3-a456-426614174000'), '不明なプレイヤー');
});
