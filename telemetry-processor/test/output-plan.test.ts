import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WalStore} from '../src/packages/wal/wal.js';
import {TargetWorker,type ProjectionClient,type ProjectionTarget,partitionRowsForInsert} from '../src/packages/exporters/target-manager.js';
import type {ProjectionRow,OutputPlan,ProjectionDeadLetter} from '../src/packages/exporters/output-plan.js';
import {SmppProviderOpsNormalizerV1} from '../src/packages/normalization/smpp-provider-ops-v1.js';
import {Metrics} from '../src/packages/metrics/metrics.js';
import {canonicalizeJson,sha256Canonical} from '../src/packages/canonical/canonical.js';
import {envelope,mapping} from './helpers.js';

class Client implements ProjectionClient {
  failTable='';rows:Array<{table:string;rows:ProjectionRow[]}>=[];
  async initialize(){}
  async ping(){}
  async insert(table:string,rows:readonly ProjectionRow[]){if(table===this.failTable)throw new Error('TEST_STORE_UNAVAILABLE');this.rows.push({table,rows:structuredClone([...rows])});}
}
const target:ProjectionTarget={targetId:'planned',targetType:'standalone',enabled:true,required:true,acceptAllMappings:true,writeLayers:['landing','normalized','core','relation'],connection:{}};
async function fixture(t:TestContext){
  const directory=await mkdtemp(join(tmpdir(),'output-plan-')),wal=new WalStore({directory});await wal.initialize();
  t.after(async()=>{await wal.close();await rm(directory,{recursive:true,force:true});});return{wal,directory};
}
const accepted=(id:string,occurredAt='2026-07-18T03:12:10.000Z')=>({kind:'accepted',sourceSystem:'smpp',receivedAt:'2026-09-04T07:56:43.500Z',trustedContext:{deploymentId:'development',collectorId:'c1'},mapping,envelope:envelope({recordId:id,occurredAt})});
const firstId='d56fda7f-f41a-5f54-96c8-0ee0edcb7de5',secondId='d56fda7f-f41a-5f54-96c8-0ee0edcb7de6';

test('deterministic poison is durably quarantined while subsequent valid records progress',async t=>{
  const{wal}=await fixture(t),client=new Client();client.failTable='telemetry_meta.projection_dead_letter';
  const original=accepted(firstId,'not-a-date');await wal.append(original);await wal.append(accepted(secondId));
  const worker=new TargetWorker({target,wal,metrics:new Metrics(),client});await worker.flush();
  assert.equal(worker.status().pending,0);assert.equal(worker.status().quarantined,1);assert.equal(worker.status().lastError,null);
  const dead=wal.state.scan<ProjectionDeadLetter>('dlq')[0]!.value;
  assert.equal(dead.sourceRecordHash,original.envelope.recordHash);assert.equal(dead.errorCode,'PROJECTION_TIMESTAMP_INVALID');
  assert.equal(wal.readEntries(0,1)[0]!.record.envelope&&canonicalizeJson(wal.readEntries(0,1)[0]!.record.envelope),canonicalizeJson(original.envelope));
  assert.equal(wal.state.scan('outbox:dlq').length,1);assert.equal(wal.state.scan('pin').length,1);
  client.failTable='';await worker.flush();assert.equal(wal.state.scan('outbox:dlq').length,0);assert.equal(wal.state.scan('dlq').length,1);
  assert.equal(client.rows.filter(batch=>batch.table==='telemetry_core.provider_operation_fact').length,1);
});

test('unknown implementation and schema failures hold the checkpoint instead of entering DLQ',async t=>{
  const{wal}=await fixture(t);await wal.append(accepted(firstId));
  class BrokenNormalizer extends SmppProviderOpsNormalizerV1 {override normalize():never{throw new Error('UNEXPECTED_IMPLEMENTATION_DEFECT');}}
  const worker=new TargetWorker({target,wal,metrics:new Metrics(),client:new Client(),normalizer:new BrokenNormalizer()});
  await worker.flush();assert.equal(worker.status().pending,1);assert.equal(worker.status().lastError,'UNEXPECTED_IMPLEMENTATION_DEFECT');assert.equal(wal.state.scan('dlq').length,0);
  const brokenSchema=new TargetWorker({target:{...target,targetType:'sdar_shared_warehouse',writeLayers:['core']},wal,metrics:new Metrics(),client:new Client(),schemaPreflight:{async assert(){throw new Error('SMPP_SCHEMA_DRIFT');}}});
  await brokenSchema.flush();assert.equal(brokenSchema.status().pending,1);assert.equal(wal.state.scan('dlq').length,0);
});

test('partial output failure and process restart preserve rows and processor timestamps',async t=>{
  const{wal,directory}=await fixture(t),client=new Client();await wal.append(accepted(firstId));
  client.failTable='telemetry_core.provider_operation_fact';
  const before='2026-09-04T07:56:43.750Z';
  const worker=new TargetWorker({target,wal,metrics:new Metrics(),client,clock:{now:()=>before}});await worker.flush();
  const plan=wal.state.scan<OutputPlan>('plan')[0]!.value;
  assert.ok(plan.completedOutputs>0);assert.ok(plan.completedOutputs<plan.outputs.length);
  const existing=client.rows.length;await wal.close();const recovered=new WalStore({directory});await recovered.initialize();t.after(()=>recovered.close());
  client.failTable='';const restarted=new TargetWorker({target,wal:recovered,metrics:new Metrics(),client,clock:{now:()=> '2026-09-04T07:59:43.750Z'}});await restarted.flush();
  assert.equal(restarted.status().pending,0);
  const later=client.rows.slice(existing).flatMap(batch=>batch.rows);assert.ok(later.every(row=>row.projected_at===before));
  assert.equal(client.rows.filter(batch=>batch.table==='telemetry_landing.smpp_provider_ops_v1').length,1);
  assert.equal(recovered.state.scan<OutputPlan>('plan')[0]!.value.projectedAt,before);
});

test('publication outbox survives failure after local disposition and retries fixed identities',async t=>{
  const{wal}=await fixture(t),client=new Client();await wal.append(accepted(firstId));
  client.failTable='telemetry_query.publication_v1';
  const worker=new TargetWorker({target:{...target,snapshotEnabled:true},wal,metrics:new Metrics(),client});await worker.flush();
  assert.equal(worker.status().pending,0);assert.equal(worker.status().publicationPending,1);
  assert.equal(client.rows.filter(batch=>batch.table==='telemetry_query.snapshot_v1').length,0);
  const revision=client.rows.find(batch=>batch.table==='telemetry_query.output_revision_v1')!.rows[0]!;
  assert.equal(revision.row_hash,sha256Canonical(JSON.parse(String(revision.row_json))));
  client.failTable='';await worker.flush();
  assert.equal(worker.status().publicationPending,0);assert.equal(wal.state.scan('pin').length,0);
  const attempts=client.rows.filter(batch=>batch.table==='telemetry_query.output_revision_v1');assert.deepEqual(attempts[0],attempts[1]);
  const snapshot=client.rows.find(batch=>batch.table==='telemetry_query.snapshot_v1')!.rows[0]!;
  assert.equal(snapshot.legacy_coverage,0);assert.equal(snapshot.ingest_through,1);
  assert.equal(snapshot.published_revision_count,wal.state.scan<OutputPlan>('plan')[0]!.value.outputs.length);
});

test('all partition keys are checked including singleton and timezone month transitions',()=>{
  assert.throws(()=>partitionRowsForInsert('telemetry_core.provider_operation_fact',[{occurred_at:'bad'}]),/PROJECTION_TIMESTAMP_INVALID/);
  const rows=[{id:1,occurred_at:'2026-08-01T00:00:00+01:00'},{id:2,occurred_at:'2026-07-31T22:00:00Z'}];
  assert.equal(partitionRowsForInsert('telemetry_core.provider_operation_fact',rows).length,1);
});
