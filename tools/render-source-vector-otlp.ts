import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { calculateProviderOpsRecordHash, uuidV5 } from '../telemetry-processor/src/packages/canonical/canonical.js';

const VECTOR_PATH = resolve(
  process.cwd(),
  'telemetry-schema/contracts/test-vectors/smpp-local-source-provider-resource-state-1.1.0.json'
);

function anyValue(value) {
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number' && Number.isInteger(value)) return { intValue: String(value) };
  if (typeof value === 'number') return { doubleValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(anyValue) } };
  if (value && typeof value === 'object') {
    return {
      kvlistValue: {
        values: Object.entries(value).map(([key, child]) => ({ key, value: anyValue(child) }))
      }
    };
  }
  return { stringValue: '' };
}

function attributes(values) {
  return Object.entries(values).map(([key, value]) => ({ key, value: anyValue(value) }));
}

const mode = process.argv[2] ?? 'original';
const vector = JSON.parse(await readFile(VECTOR_PATH, 'utf8'));
const envelope = structuredClone(vector.envelope);

if (mode === 'conflict') {
  envelope.payload = { ...envelope.payload, state: 'degraded', reasonCode: 'QUALIFICATION_CONFLICT' };
  envelope.recordHash = calculateProviderOpsRecordHash(envelope);
} else if (mode === 'outage-recovery') {
  envelope.recordId = uuidV5('goal-01-clickhouse-outage-recovery');
  envelope.providerEventId = 'qualification-outage-recovery-001';
  envelope.providerEventSequence = 2;
  envelope.occurredAt = '2026-08-12T08:05:00.000Z';
  envelope.emittedAt = '2026-08-12T08:05:00.250Z';
  envelope.payload = { ...envelope.payload, state: 'ready', reasonCode: 'OUTAGE_RECOVERED' };
  envelope.recordHash = calculateProviderOpsRecordHash(envelope);
} else if (mode === 'malformed') {
  delete envelope.deliveryClass;
} else if (mode === 'oversized') {
  envelope.payload = { diagnostic: 'x'.repeat(20_000) };
  envelope.recordHash = calculateProviderOpsRecordHash(envelope);
} else if (mode === 'sensitive') {
  envelope.payload = { password: 'qualification-secret-must-not-persist' };
  envelope.recordHash = calculateProviderOpsRecordHash(envelope);
} else if (mode !== 'original' && mode !== 'unselected') {
  throw new Error(`Unsupported mode: ${mode}`);
}

const contractAttributes = mode === 'unselected'
  ? { 'sdar.schema.name': 'example.unselected', 'sdar.schema.version': '1.0.0' }
  : {
      'sdar.schema.name': envelope.schemaName,
      'sdar.schema.version': envelope.schemaVersion,
      'sdar.record.id': envelope.recordId,
      'sdar.record.hash': envelope.recordHash
    };

const request = {
  resourceLogs: [{
    resource: { attributes: attributes({ 'service.name': 'sdar-mcp-tasks-provider-runtime' }) },
    scopeLogs: [{
      scope: { name: 'sdar.provider.ops', version: envelope.runtimeVersion },
      logRecords: [{
        timeUnixNano: String(BigInt(Date.parse(envelope.emittedAt)) * 1_000_000n),
        body: anyValue(envelope),
        attributes: attributes(contractAttributes)
      }]
    }]
  }]
};

process.stdout.write(JSON.stringify(request));
