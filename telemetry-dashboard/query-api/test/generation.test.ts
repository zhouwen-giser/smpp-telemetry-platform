import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { WalStore } from '../../../telemetry-processor/src/packages/wal/wal.js';
import { assertGenerationWritable, generationKey, refreshGenerationLease } from '../../../telemetry-processor/src/packages/exporters/generation-lifecycle.js';
import { atomicReaderRegistry, GenerationCoordinator } from '../../../telemetry-processor/src/packages/replay/generation.js';
import { ReplayManager } from '../../../telemetry-processor/src/packages/replay/replay.js';
import { loadReaderRegistry, validateReaderRegistry } from '../src/reader-registry.js';
import { envelope, mapping } from '../../../telemetry-processor/test/helpers.js';
const registry = { version: 1 as const, revision: 1, activeTargetId: 'old', readers: { old: { url: 'http://old:8123', passwordFile: '/secrets/reader' } } };

test('registry is trusted configuration and atomic updates reject stale revisions', async () => {
  for (const readers of [{ old: { url: 'file:///private' } }, { old: { url: 'http://old', password: 'inline', passwordFile: 'file' } }, { bad: { url: 'http://old' } }]) assert.throws(() => validateReaderRegistry({ ...registry, readers }));
  const directory = await mkdtemp(join(tmpdir(), 'registry-test-')), path = join(directory, 'readers.json');
  try {
    const text = JSON.stringify(registry); await writeFile(path, text);
    const next = { ...registry, revision: 2 };
    await assert.rejects(atomicReaderRegistry(path, next, 'stale'), /GENERATION_REGISTRY_CHANGED/u);
    assert.equal(await readFile(path, 'utf8'), text);
    await atomicReaderRegistry(path, next, createHash('sha256').update(text).digest('hex'));
    assert.equal(JSON.parse(await readFile(path, 'utf8')).revision, 2);
    await writeFile(path, JSON.stringify({ version: 1, revision: 3, activeTargetId: '__proto__', readers: Object.fromEntries([['__proto__', { url: 'http://old:8123' }]]) }));
    const loaded = await loadReaderRegistry(path); assert.equal(Object.getPrototypeOf(loaded.clients), null); assert.ok(Object.hasOwn(loaded.clients, '__proto__'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('draining lifecycle survives owner restart and cannot be renewed, written or collected during its lease', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'generation-test-')); let wal = new WalStore({ directory }); await wal.initialize();
  let now = Date.now(); const timestamp = () => new Date(now).toISOString();
  try {
    const active = await refreshGenerationLease(wal, 'old', 'g1', timestamp());
    assertGenerationWritable(wal, 'old', 'g1');
    const key = generationKey('old', 'g1', wal.walEpoch), draining = { ...active, status: 'draining' as const };
    await wal.state.put('generation:lifecycle', key, draining);
    await wal.close(); wal = new WalStore({ directory }); await wal.initialize();
    now += 1000; assert.deepEqual(await refreshGenerationLease(wal, 'old', 'g1', timestamp()), draining);
    assert.throws(() => assertGenerationWritable(wal, 'old', 'g1'), /GENERATION_NOT_ACTIVE/u);
    let published = 0;
    const admin = new GenerationCoordinator({ wal, offline: true, now: () => now, readerFor: () => { throw Error('unexpected query'); }, publishLifecycle: async () => { published++; } });
    await assert.rejects(admin.retire('old', 'g1'), /GENERATION_READ_LEASE_ACTIVE/u);
    assert.equal(admin.gcDryRun('old', 'g1').eligible, false);
    now += 600001; await admin.retire('old', 'g1'); assert.equal(published, 1);
    const preview = admin.gcDryRun('old', 'g1'); assert.equal(preview.eligible, true); assert.equal(preview.statements.length, 4);
    assert.ok(preview.statements.every(sql => sql.includes("target_id='old' AND generation='g1' AND wal_epoch=")));
    assert.equal((await refreshGenerationLease(wal, 'old', 'g1', timestamp())).status, 'retired');
  } finally { await wal.close(); await rm(directory, { recursive: true, force: true }); }
});

test('completed scoped or partial replay cannot claim complete-generation promotion', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'generation-scope-test-')), wal = new WalStore({ directory }); await wal.initialize();
  try {
    for (const id of ['1','2']) await wal.append({ kind: 'accepted', sourceSystem: 'smpp', receivedAt: new Date().toISOString(), trustedContext: { deploymentId: 'development', collectorId: 'test' }, mapping, envelope: envelope({ recordId: randomUUID(), taskId: id }) });
    const replay = new ReplayManager(wal), admin = new GenerationCoordinator({ wal, offline: true, readerFor: () => { throw Error('unexpected query'); }, publishLifecycle: async () => {} });
    for (const subset of [{ fromSequence: 2 }, { scope: { tenantId: mapping.tenantId } }]) {
      let job = await replay.create({ idempotencyKey: JSON.stringify(subset), generation: 'g2', targetIds: ['new'], fromSequence: 1, throughSequence: 2, normalizerVersion: 4, projectionVersion: 1, mappingVersion: 4, policyVersion: 1, ...subset });
      await replay.transition(job.id, 'start'); job = await replay.runBatch(job.id, { validate: async () => {}, project: async () => 'projected' }); assert.equal(job.status, 'completed');
      await assert.rejects(admin.inspectPromotion(job.id, 'new'), /GENERATION_FULL_COVERAGE_REQUIRED/u);
    }
  } finally { await wal.close(); await rm(directory, { recursive: true, force: true }); }
});
