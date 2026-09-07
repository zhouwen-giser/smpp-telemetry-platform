import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WalStore, asTelemetryEntry, type WalEntry } from '../src/packages/wal/wal.js';
import { SmppProviderOpsNormalizerV1 } from '../src/packages/normalization/smpp-provider-ops-v1.js';
import { CoreProjectionV1 } from '../src/packages/projection/core-projection.js';
import { SdarSharedWarehouseProjectionV1 } from '../src/packages/projection/sdar-shared-warehouse-projection.js';
import { landingRow, canonicalRow } from '../src/packages/exporters/clickhouse.js';
import { TargetWorker, type ProjectionClient } from '../src/packages/exporters/target-manager.js';
import type { ProjectionDeadLetter } from '../src/packages/exporters/output-plan.js';
import { Metrics } from '../src/packages/metrics/metrics.js';
import { uuidV5 } from '../src/packages/canonical/canonical.js';
import type { AcceptedWalRecord, ProviderQuality } from '../../packages/telemetry-types/src/index.js';
import { envelope, mapping } from './helpers.js';

class Store implements ProjectionClient{
  readonly writes:Array<{table:string;rows:readonly Record<string,unknown>[]}>=[];
  async initialize(){}async ping(){return true;}
  async insert(table:string,rows:readonly Record<string,unknown>[]){this.writes.push({table,rows});}
  rows(table:string){return this.writes.filter(write=>write.table===table).flatMap(write=>write.rows);}
}
async function sequence(wal:WalStore,value:number):Promise<WalEntry>{
  const event=envelope({recordId:uuidV5(`quality-projection/${value}`),providerEventId:'immutable-stream',providerEventSequence:value});
  const record={kind:'accepted',sourceSystem:'smpp',receivedAt:'2026-07-18T03:12:11Z',trustedContext:{collectorId:'c1',deploymentId:'development'},mapping,envelope:event};
  const outcome=await wal.appendClassified({sourceSystem:'smpp',recordId:event.recordId,recordHash:event.recordHash,acceptedRecord:record,conflictRecord:()=>({...record,kind:'conflict',summary:'conflict'})});assert.ok(outcome.entry);return outcome.entry;
}
function accepted(raw:WalEntry):WalEntry<AcceptedWalRecord>{const entry=asTelemetryEntry(raw);assert.equal(entry.record.kind,'accepted');if(entry.record.kind!=='accepted')throw new Error('accepted fixture required');return{...entry,record:entry.record};}

test('first quality snapshots persist through Landing, Canonical, Core and shared provenance',async()=>{
  const wal=new WalStore({directory:await mkdtemp(join(tmpdir(),'quality-projection-'))});await wal.initialize();
  try{
    await sequence(wal,1);const entry=accepted(await sequence(wal,3)),quality=entry.record.providerQuality!;
    assert.deepEqual(quality.reasonCodes,['SMPP_PROVIDER_EVENT_SEQUENCE_GAP']);assert.equal(quality.previousMaximum,1);assert.equal(quality.gapStart,2);assert.equal(quality.gapEnd,2);
    const fact=new SmppProviderOpsNormalizerV1().normalize(entry)[0]!;
    assert.deepEqual(JSON.parse(landingRow(entry).provider_quality_json),quality);
    assert.deepEqual(JSON.parse(canonicalRow(fact).provenance_json).providerQuality,quality);
    const core=new CoreProjectionV1().project(fact).find(row=>row.table==='telemetry_core.task_lifecycle_fact')!;
    assert.deepEqual(JSON.parse(String(core.row.provenance_json)).providerQuality,quality);
    const shared=new SdarSharedWarehouseProjectionV1().project(fact)[0]!;
    assert.deepEqual(JSON.parse(String(shared.row.provenance_json)).providerQuality,quality);
    const store=new Store(),worker=new TargetWorker({wal,target:{targetId:'quality',targetType:'standalone',enabled:true,acceptAllMappings:true,connection:{},writeLayers:['landing','normalized','core','relation']},client:store,metrics:new Metrics()});await worker.flush();assert.equal(worker.lastError,null);
    assert.equal(store.rows('telemetry_meta.provider_quality_observation_v1').length,1);assert.deepEqual(JSON.parse(String(store.rows('telemetry_meta.provider_quality_observation_v1')[0]!.quality_json)),quality);
  }finally{await wal.close();}
});

test('sequence 1,3,2 retains gap and out-of-order snapshots and fact hashes across restart and replay',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'quality-restart-'));let wal=new WalStore({directory});await wal.initialize();
  const entries=[await sequence(wal,1),await sequence(wal,3),await sequence(wal,2)],normalizer=new SmppProviderOpsNormalizerV1();
  const quality=entries.map(entry=>entry.record.providerQuality),hashes=entries.map(entry=>normalizer.normalize(accepted(entry))[0]!.factHash);await wal.close();
  wal=new WalStore({directory});await wal.initialize();
  try{
    const restored=wal.readEntries();assert.deepEqual(restored.map(entry=>entry.record.providerQuality),quality);assert.deepEqual(restored.map(entry=>normalizer.normalize(accepted(entry))[0]!.factHash),hashes);
    assert.deepEqual((restored[1]!.record.providerQuality as ProviderQuality).reasonCodes,['SMPP_PROVIDER_EVENT_SEQUENCE_GAP']);assert.deepEqual((restored[2]!.record.providerQuality as ProviderQuality).reasonCodes,['SMPP_PROVIDER_EVENT_OUT_OF_ORDER']);
    const store=new Store(),worker=new TargetWorker({wal,target:{targetId:'rebuild-quality',generation:'g2',targetType:'standalone',enabled:true,acceptAllMappings:true,connection:{},writeLayers:['normalized']},client:store,metrics:new Metrics()});
    for(const entry of restored)assert.equal(await worker.projectReplayEntry(entry),'projected');
    const canonical=store.rows('telemetry_normalized.canonical_fact_v1');assert.deepEqual(canonical.map(row=>JSON.parse(String(row.provenance_json)).providerQuality),quality);assert.deepEqual(canonical.map(row=>row.fact_hash),hashes);
  }finally{await wal.close();}
});

test('normalization DLQ preserves the original quality snapshot and publishes its normalization diagnostic',async()=>{
  class InvalidNormalizer extends SmppProviderOpsNormalizerV1{override normalize(entry:{record:AcceptedWalRecord}){if(entry.record.providerQuality?.reasonCodes.includes('SMPP_PROVIDER_EVENT_SEQUENCE_GAP'))throw new Error('TENANT_ID_REQUIRED');return super.normalize(entry);}}
  const wal=new WalStore({directory:await mkdtemp(join(tmpdir(),'quality-dlq-'))});await wal.initialize();
  try{
    await sequence(wal,1);const bad=await sequence(wal,3);await sequence(wal,2);
    const store=new Store(),worker=new TargetWorker({wal,target:{targetId:'quality-dlq',targetType:'standalone',enabled:true,acceptAllMappings:true,connection:{},writeLayers:['landing','normalized']},normalizer:new InvalidNormalizer(),client:store,metrics:new Metrics()});await worker.flush();
    assert.equal(worker.lastError,null);assert.equal(wal.pendingCount(worker.checkpointId),0);
    const issues=wal.state.scan<ProjectionDeadLetter>('dlq');assert.equal(issues.length,1);assert.equal(issues[0]!.value.stage,'normalize');assert.deepEqual(issues[0]!.value.providerQuality,bad.record.providerQuality);
    assert.equal(store.rows('telemetry_normalized.normalization_dead_letter_v1').length,1);assert.equal(store.rows('telemetry_normalized.normalization_dead_letter_v1')[0]!.error_code,'TENANT_ID_REQUIRED');assert.equal(store.rows('telemetry_landing.smpp_provider_ops_v1').length,2);
    assert.equal(wal.stats().dlqBytes,Buffer.byteLength(JSON.stringify(issues[0]!.value)));assert.equal(wal.state.namespaceUsage('dlq').entries,1);
  }finally{await wal.close();}
});
