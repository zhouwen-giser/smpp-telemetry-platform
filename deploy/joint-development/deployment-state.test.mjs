import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { registryPath, saveDeployment, resolveDeployment, operationalArgs } from './deployment-state.mjs';
import { preflightWriters, preflightReaders } from './preflight.mjs';
const fixture = () => { const dir = mkdtempSync(resolve(tmpdir(), 'joint-state-test-')); const envPath = resolve(dir, '.env'); const registry = registryPath(envPath); return { dir, envPath, registry }; };
const descriptor = (f, id = 'original') => ({ deploymentId: id, project: id, envPath: f.envPath, composePath: resolve(f.registry, id, 'compose.json'), configRevision: 'revision-1', phase: 'attempted', lastSuccessfulRevision: null });

test('operations use saved project after env removal, parse errors or project rename; no env is regenerated', () => {
  const f = fixture(); const d = descriptor(f); saveDeployment(f.registry, d);
  mkdirSync(resolve(f.dir, 'bin')); const log = resolve(f.dir, 'docker-args.json');
  writeFileSync(resolve(f.dir, 'bin/docker'), '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.ARGV_LOG,JSON.stringify(process.argv.slice(2)))', { mode: 0o755 });
  for (const value of [null, 'DEPLOY_PROJECT=renamed\nTYPO=x', 'SHARED__URL="unterminated']) {
    if (value === null) rmSync(f.envPath, { force: true }); else writeFileSync(f.envPath, value);
    for (const action of ['status', 'logs', 'down']) {
      const result = spawnSync(process.execPath, [resolve(import.meta.dirname, 'cli.mjs'), action, f.envPath], { env: { ...process.env, PATH: `${f.dir}/bin:${process.env.PATH}`, ARGV_LOG: log }, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(readFileSync(log,"utf8")), operationalArgs(d, action));
    }
  }
  assert.equal(resolveDeployment({ ...f }).phase, 'stopped');
});
test('multiple deployments require explicit identity; interrupted attempts remain operable and index is recoverable', () => {
  const f = fixture(); saveDeployment(f.registry, descriptor(f)); saveDeployment(f.registry, descriptor(f, 'renamed'));
  rmSync(resolve(f.registry, 'env-index.json'));
  assert.throws(() => resolveDeployment(f), /DEPLOYMENT_AMBIGUOUS/);
  assert.equal(resolveDeployment({ ...f, deploymentId: 'original' }).phase, 'attempted');
  assert.throws(() => resolveDeployment({ ...f, deploymentId: '../bad' }), /DEPLOYMENT_ID_INVALID/);
});
test('legacy discovery refuses ambiguous projects and adopts only an explicit or unique deployment', () => {
  const f = fixture();
  for (const name of ['first', 'second']) { mkdirSync(resolve(f.registry, name), { recursive: true }); writeFileSync(resolve(f.registry, name, 'compose.json'), JSON.stringify({ name })); }
  assert.throws(() => resolveDeployment(f), /DEPLOYMENT_AMBIGUOUS/);
  assert.equal(resolveDeployment({ ...f, deploymentId: 'second' }).project, 'second');
});
test('writer preflight uses actual target connections and INSERT grants independently of query credentials', async () => {
  const seen = []; const connection = { url: 'https://writer.invalid', user: 'writer', passwordFile: '/run/secrets/writer' };
  const common = { loadConfig: async () => ({ projectionTargetsFile: '/real/targets' }), loadProjectionTargets: async file => { assert.equal(file, '/real/targets'); return [{ enabled: true, targetId: 'shared', targetType: 'sdar_shared_warehouse', writeLayers: ['core','relation'], connection }]; }, createClient: c => { assert.deepEqual(c, connection); return { initialize: async () => {}, query: async sql => { seen.push(sql); return '1\n'; } }; }, assertShared: async () => {}, assertStandalone: async () => {}, standaloneTargetTables: () => [] };
  await preflightWriters(common);
  assert.deepEqual(seen, ['CHECK GRANT INSERT ON sdar_core.external_provider_fact','CHECK GRANT INSERT ON sdar_core.external_entity_relation_fact']);
  await assert.rejects(preflightWriters({ ...common, createClient: () => ({ initialize: async () => {}, query: async () => '0' }) }), /WRITER_INSERT_DENIED/);
});
test('read-only reader is accepted; password file priority and independent authority connection reach native loader', async () => {
  const seen = []; const env = { CLICKHOUSE_URL: 'http://reader.invalid', CLICKHOUSE_USER: 'readonly', CLICKHOUSE_PASSWORD: 'inline', CLICKHOUSE_PASSWORD_FILE: '/reader/secret', AUTHORITY_ENABLED: 'true', AUTHORITY_CLICKHOUSE_URL: 'http://authority-reader.invalid', AUTHORITY_CLICKHOUSE_USER: 'authority_reader' };
  await preflightReaders({ env, createClient: c => { seen.push(c); return { initialize: async () => {} }; }, probeQueryStore: async (_store, kind) => { assert.ok(['standalone','authority'].includes(kind)); return { status: 'ready' }; } });
  assert.equal(seen[0].passwordFile, '/reader/secret'); assert.equal(seen[1].url, env.AUTHORITY_CLICKHOUSE_URL);
  await assert.rejects(preflightReaders({ env, createClient: () => ({ initialize: async () => {} }), probeQueryStore: async () => ({ status: 'unavailable' }) }), /READER_STANDALONE_UNAVAILABLE/);
});

test('external launcher guard rejects old images against v2 WAL even if the binary has no guard', async () => {
  const { assertWalReader } = await import('../wal-reader-guard.mjs');
  const f=fixture(),readerVersionFile=resolve(f.dir,'image-reader-version');
  writeFileSync(resolve(f.dir,'wal-format.json'),JSON.stringify({version:2,minimumReaderVersion:2}));
  await assert.rejects(assertWalReader({walDirectory:f.dir,readerVersionFile,requiredVersion:1}),/WAL_READER_DOWNGRADE_REFUSED/);
  writeFileSync(readerVersionFile,'2\n');
  assert.equal((await assertWalReader({walDirectory:f.dir,readerVersionFile})).supportedVersion,2);
  writeFileSync(resolve(f.dir,'wal-format.json'),JSON.stringify({version:3,minimumReaderVersion:3}));
  await assert.rejects(assertWalReader({walDirectory:f.dir,readerVersionFile}),/WAL_READER_DOWNGRADE_REFUSED/);
  writeFileSync(resolve(f.dir,'wal-format.json'),'broken');
  await assert.rejects(assertWalReader({walDirectory:f.dir,readerVersionFile}));
});


test('operations remain available when the catalog, template and neighboring source checkout are absent', () => {
  const f=fixture(),d=descriptor(f);saveDeployment(f.registry,d);
  const cliRoot=resolve(f.dir,'detached-launcher');mkdirSync(cliRoot);
  for(const file of ['cli.mjs','compose.mjs','deployment-state.mjs','preflight.mjs'])copyFileSync(resolve(import.meta.dirname,file),resolve(cliRoot,file));
  mkdirSync(resolve(f.dir,'bin'));
  writeFileSync(resolve(f.dir,'bin/docker'),'#!/bin/sh\nexit 0\n',{mode:0o755});
  const result=spawnSync(process.execPath,[resolve(cliRoot,'cli.mjs'),'status',f.envPath],{env:{...process.env,PATH:`${f.dir}/bin:${process.env.PATH}`},encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
});
