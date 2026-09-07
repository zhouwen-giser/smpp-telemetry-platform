import test from 'node:test';
import assert from 'node:assert/strict';
import { validTelemetryTimestamp, projectionTimestamp } from '../src/packages/validation/timestamp.js';
import { validateEnvelope } from '../src/packages/validation/validation.js';
import { envelope, logRecord } from './helpers.js';

test('wire dates reject rollover, prose, missing zone and leap seconds', () => {
  for (const value of ['2026-02-29T00:00:00Z', '2026-04-31T00:00:00Z', '2024-00-01T00:00:00Z',
    '2026-09-07T00:00:00', '2026-09-07T24:00:00Z', '2026-09-07T00:00:60Z', 'July 18, 2026 03:12:10 GMT'])
    assert.equal(validTelemetryTimestamp(value), false, value);
  assert.equal(validTelemetryTimestamp('2024-02-29T12:30:00.123456789+08:00'), true);
  const e = envelope({ occurredAt: 'July 18, 2026 03:12:10 GMT' });
  assert.equal(validateEnvelope(e, logRecord(e).attributes).ok, false);
});

test('projection converts offset and already accepted legacy UTC without mutating source', () => {
  assert.equal(projectionTimestamp('2026-09-01T01:00:00+08:00'), '2026-08-31T17:00:00.000Z');
  assert.equal(projectionTimestamp('July 18, 2026 03:12:10 GMT'), '2026-07-18T03:12:10.000Z');
  assert.throws(() => projectionTimestamp('01/02/2026'), /PROJECTION_TIMESTAMP_INVALID/);
});
