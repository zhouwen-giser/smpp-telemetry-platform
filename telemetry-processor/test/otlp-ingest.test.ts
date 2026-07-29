import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WalStore } from '../src/packages/wal/wal.js';
import { Metrics } from '../src/packages/metrics/metrics.js';
import { TelemetryProcessor } from '../src/apps/processor.js';
import { createServer } from '../src/apps/server.js';
import { envelope, mapping } from './helpers.js';

const av = (v) => typeof v === 'string' ? { stringValue: v }
  : typeof v === 'boolean' ? { boolValue: v }
  : typeof v === 'number' ? { intValue: String(v) }
  : Array.isArray(v) ? { arrayValue: { values: v.map(av) } }
  : v && typeof v === 'object' ? { kvlistValue: { values: Object.entries(v).map(([key, value]) => ({ key, value: av(value) })) } }
  : { stringValue: '' };
const attrs = (o) => Object.entries(o).map(([key, value]) => ({ key, value: av(value) }));
function request(e) {
  return { resourceLogs: [{ resource: { attributes: attrs({
    'telemetry.source.system': 'smpp',
    'telemetry.source.collector_id': 'smpp-gateway-1',
    'telemetry.source.trust_domain': 'local-compose',
    'telemetry.source.deployment_id': 'development'
  }) }, scopeLogs: [{ logRecords: [{ body: av(e), attributes: attrs({
    'sdar.record.id': e.recordId,
    'sdar.record.hash': e.recordHash,
    'telemetry.channel': 'smpp.provider_ops',
    'telemetry.contract.version': '1.1.0'
  }) }] }] }] };
}

test('internal OTLP JSON reaches Processor WAL before success', async () => {
  const wal = new WalStore({ directory: await mkdtemp(join(tmpdir(), 'otlp-')) }); await wal.initialize();
  const metrics = new Metrics();
  const processor = new TelemetryProcessor({ wal, mappings: { resolve: () => mapping }, metrics, allowedCollectorIds: ['smpp-gateway-1'] });
  const targets = { pingRequired: async () => true, statuses: () => [], flush: async () => {} };
  const config = { maxRequestBytes: 1024 * 1024, adminApiKey: '', walMaxBytes: 1024 * 1024 };
  const server = createServer({ config, tlsOptions: null, processor, wal, targets, metrics });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/internal/otlp/v1/logs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request(envelope())) });
  assert.equal(response.status, 200);
  assert.equal(wal.entries.length, 1);
  assert.equal(wal.entries[0].record.kind, 'accepted');
  await new Promise((resolve) => server.close(resolve));
});
