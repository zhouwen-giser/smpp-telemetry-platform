import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {WalStore} from '../src/packages/wal/wal.js';import {TelemetryProcessor} from '../src/apps/processor.js';import {Metrics} from '../src/packages/metrics/metrics.js';import {envelope,logRecord,mapping} from './helpers.js';async function setup({walOptions={},processorOptions={}}={}){const wal=new WalStore({directory:await mkdtemp(join(tmpdir(),'proc-')),...walOptions});await wal.initialize();const mappings={resolve:()=>mapping};return{wal,p:new TelemetryProcessor({wal,mappings,metrics:new Metrics(),allowedCollectorIds:['smpp-gateway-1'],...processorOptions})};}test('accept, duplicate and conflict',async()=>{const {p}=await setup(),e=envelope();assert.equal((await p.collect(logRecord(e))).status,'accepted');assert.equal((await p.collect(logRecord(e))).status,'duplicate');const c=envelope({payload:{currentState:'failed'}});assert.equal((await p.collect(logRecord(c))).status,'conflict');});test('rejects forged collector identity',async()=>{const {p}=await setup();assert.equal((await p.collect(logRecord(envelope(),{resource:{'telemetry.source.collector_id':'evil'}}))).errorCode,'COLLECTOR_ID_NOT_ALLOWED');});test('stores only a safe rejection summary for secret-bearing input',async()=>{const {p,wal}=await setup(),e=envelope({payload:{password:'secret-do-not-store'}});e.recordHash=(await import('../src/packages/canonical/canonical.js')).calculateProviderOpsRecordHash(e);assert.equal((await p.collect(logRecord(e))).errorCode,'SENSITIVE_KEY_DETECTED');assert.equal(wal.entries.length,1);assert.equal(wal.entries[0].record.kind,'rejected');assert.doesNotMatch(JSON.stringify(wal.entries[0].record),/secret-do-not-store/);});

test('concurrent identical records cross one atomic deduplication boundary',async()=>{
  const {p,wal}=await setup(),e=envelope();
  const results=await Promise.all(Array.from({length:20},()=>p.collect(logRecord(e))));
  assert.equal(results.filter(result=>result.status==='accepted').length,1);
  assert.equal(results.filter(result=>result.status==='duplicate').length,19);
  assert.equal(wal.entries.length,1);
  assert.equal(wal.entries[0].record.kind,'accepted');
});

test('concurrent same-ID different-hash records isolate one conflict',async()=>{
  const {p,wal}=await setup(),accepted=envelope(),different=envelope({payload:{currentState:'failed'}});
  const results=await Promise.all([p.collect(logRecord(accepted)),p.collect(logRecord(different))]);
  assert.deepEqual(results.map(result=>result.status),['accepted','conflict']);
  assert.deepEqual(wal.entries.map(entry=>entry.record.kind),['accepted','conflict']);
  assert.equal(wal.entries[1].record.acceptedRecordHash,accepted.recordHash);
  assert.equal(wal.entries[1].offset,wal.entries[0].offsetEnd);
});

test('concurrent records cannot bypass the WAL high-water limit',async()=>{
  const walMaxBytes=4096,{p,wal}=await setup({processorOptions:{walMaxBytes,walRejectThreshold:1}});
  const records=Array.from({length:20},(_,index)=>envelope({recordId:`d56fda7f-f41a-5f54-96c8-${String(index).padStart(12,'0')}`}));
  const results=await Promise.all(records.map(record=>p.collect(logRecord(record))));
  assert.ok(results.some(result=>result.status==='accepted'));
  assert.ok(results.some(result=>result.status==='rejected_retryable'&&result.errorCode==='WAL_HIGH_WATER'));
  assert.ok(wal.stats().totalBytes<=walMaxBytes);
  assert.equal(wal.entries.length,results.filter(result=>result.status==='accepted').length);
});

test('duplicates remain idempotent when the WAL is at high water',async()=>{
  const {p,wal}=await setup({processorOptions:{walMaxBytes:2048,walRejectThreshold:1}}),record=envelope();
  assert.equal((await p.collect(logRecord(record))).status,'accepted');
  const before=wal.stats().totalBytes;
  assert.equal((await p.collect(logRecord(record))).status,'duplicate');
  assert.equal(wal.stats().totalBytes,before);
});
