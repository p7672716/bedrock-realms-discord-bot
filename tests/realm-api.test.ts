import test from 'node:test';
import assert from 'node:assert/strict';
import { RealmApiClient } from '../src/realm-api.js';
import type { AppConfig } from '../src/types.js';

const config = {
  auth: { cacheKey: 'test', cacheDir: `${process.env.TEMP || process.cwd()}/realm-api-test-cache` },
  realmsApi: { baseUrl: 'https://example.test', clientVersion: '1.26.40' },
} as AppConfig;
const log = { info() {}, warn() {}, error() {} };

test('join info preserves NetherNet JSON-RPC metadata', async () => {
  const api = new RealmApiClient(config, log);
  (api as any).request = async () => ({
    address: '590d0d67-58d6-4a7b-b49d-1513f0b420c8',
    networkProtocol: 'NETHERNET_JSONRPC',
    sessionRegionData: { regionName: 'JapanWest', serviceQuality: 4 },
  });

  const join = await api.getJoinInfo('123');
  assert.equal(join.address, '590d0d67-58d6-4a7b-b49d-1513f0b420c8');
  assert.equal(join.networkProtocol, 'NETHERNET_JSONRPC');
  assert.equal(join.region, 'JapanWest');
  assert.deepEqual(join.sessionRegionData, { regionName: 'JapanWest', serviceQuality: 4 });
  assert.equal(join.port, undefined);
});

test('join info keeps legacy host and port as a fallback', async () => {
  const api = new RealmApiClient(config, log);
  (api as any).request = async () => ({
    address: 'prod-japanwest.example.test:19132',
    networkProtocol: 'DEFAULT',
  });

  const join = await api.getJoinInfo('123');
  assert.equal(join.host, 'prod-japanwest.example.test');
  assert.equal(join.port, 19132);
  assert.equal(join.networkProtocol, 'DEFAULT');
});
