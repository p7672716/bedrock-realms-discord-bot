import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { StateStore } from '../src/store.js';

function testDataDir(): string {
  return `${process.env.TEMP || process.cwd()}/bedrock-realms-bot-location-test-${Date.now()}-${Math.random()}`;
}

test('locations default to the overworld and persist creator, note, and images', async () => {
  const dataDir = testDataDir();
  try {
    const store = new StateStore(dataDir);
    await store.load();
    const location = store.createLocation('123', {
      name: 'Home',
      x: 10,
      y: 64,
      z: -5,
      dimension: 'overworld',
      note: 'Main base',
      images: [{ url: 'https://cdn.example.test/home.png', name: 'home.png' }],
      createdBy: { id: 'user-1', name: 'Alex' },
    });
    await store.flush();

    const second = new StateStore(dataDir);
    await second.load();
    assert.equal(second.listLocations('123').length, 1);
    assert.equal(second.listLocations('123')[0].dimension, 'overworld');
    assert.equal(second.listLocations('123')[0].createdBy.name, 'Alex');
    assert.equal(second.listLocations('123')[0].images[0].url, 'https://cdn.example.test/home.png');
    assert.equal(location.name, 'Home');
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('location names are unique per Realm and edits reject duplicates', async () => {
  const dataDir = testDataDir();
  try {
    const store = new StateStore(dataDir);
    await store.load();
    store.createLocation('123', {
      name: 'Home',
      x: 0,
      y: 64,
      z: 0,
      dimension: 'overworld',
      images: [],
      createdBy: { id: 'user-1', name: 'Alex' },
    });
    assert.throws(() => store.createLocation('123', {
      name: 'ｈｏｍｅ',
      x: 1,
      y: 64,
      z: 1,
      dimension: 'overworld',
      images: [],
      createdBy: { id: 'user-2', name: 'Steve' },
    }), /LOCATION_NAME_ALREADY_EXISTS/);

    store.createLocation('456', {
      name: 'Home',
      x: 1,
      y: 64,
      z: 1,
      dimension: 'overworld',
      images: [],
      createdBy: { id: 'user-2', name: 'Steve' },
    });
    store.createLocation('123', {
      name: 'Mine',
      x: 2,
      y: 64,
      z: 2,
      dimension: 'overworld',
      images: [],
      createdBy: { id: 'user-2', name: 'Steve' },
    });
    assert.throws(() => store.updateLocation('123', 'Home', { name: 'mine' }), /LOCATION_NAME_ALREADY_EXISTS/);
    await store.flush();
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('location search matches names and notes and edit can replace images', async () => {
  const dataDir = testDataDir();
  try {
    const store = new StateStore(dataDir);
    await store.load();
    store.createLocation('123', {
      name: 'Village',
      x: 100,
      y: 70,
      z: 100,
      dimension: 'overworld',
      note: 'Trading hall',
      images: [{ url: 'https://cdn.example.test/old.png' }],
      createdBy: { id: 'user-1', name: 'Alex' },
    });
    assert.equal(store.searchLocations('123', 'Trading')[0].name, 'Village');
    const updated = store.updateLocation('123', 'Village', {
      dimension: 'nether',
      images: [{ url: 'https://cdn.example.test/new.png' }],
      replaceImages: true,
    });
    await store.flush();
    assert.equal(updated.dimension, 'nether');
    assert.deepEqual(updated.images.map((image) => image.url), ['https://cdn.example.test/new.png']);
    store.addLocationImages('123', 'Village', [{ url: 'https://cdn.example.test/extra.png' }]);
    const removed = store.removeLocationImage('123', 'Village', 1);
    await store.flush();
    assert.deepEqual(removed.images.map((image) => image.url), ['https://cdn.example.test/extra.png']);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
