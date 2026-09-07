import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WalStore } from '../src/packages/wal/wal.js';
import { ReplayManager } from '../src/packages/replay/replay.js';
import { assertGenerationIsolation, createReplayExecutor } from '../src/packages/replay/executor.js';
import { planBackfill, exportBackfill, validateBackfill, runBackfill, backfillStatus, type BackfillConfiguration } from '../src/packages/replay/backfill.js';
import { TargetWorker, type ProjectionTarget, type ProjectionClient } from '../src/packages/exporters/target-manager.js';
import { Metrics } from '../src/packages/metrics/metrics.js';
import { envelope, mapping } from './helpers.js';

class Store implements ProjectionClient{
  readonly rows:Array<{table:string;rows:readonly Record<string,unknown>[]}>=[];
  constructor(readonly prefix:string){}
  async initialize(){}async ping(){return true;}
  async query(){return JSON.stringify({data:['telemetry_landing','telemetry_normalized','telemetry_core','telemetry_meta'].map(name=>({name,uuid:`${this.prefix}-${name}`}))});}
  async insert(table:string,rows:readonly Record<string,unknown>[]){this.rows.push({table,rows});}
}
const live:ProjectionTarget={targetId:'live',targetType:'standalone',enabled:true,writeLayers:['landing','normalized','core','relation'],acceptAllMappings:true,connection:{url:'http://live:8123'}};
const isolated:ProjectionTarget={...live,targetId:'rebuild',generation:'g2',connection:{url:'http://rebuild:8123'}};
const request={idempotencyKey:'job',generation:'g2',targetIds:['rebuild'],fromSequence:1,throughSequence:1,normalizerVersion:4,projectionVersion:1,mappingVersion:4,policyVersion:1};

test('real replay executor validates signed input and only sends persisted plans to the isolated target',async()=>{
  const wal=new WalStore({directory:await mkdtemp(join(tmpdir(),'replay-executor-'))});await wal.initialize();
  const source=new Store('live'),destination=new Store('rebuild');
  try{
    await wal.append({kind:'accepted',sourceSystem:'smpp',receivedAt:'2026-07-18T03:12:11Z',trustedContext:{collectorId:'c1',deploymentId:'development'},mapping,envelope:envelope()});
    const manager=new ReplayManager(wal),job=await manager.create(request);
    const original=wal.readEntries()[0]!,sourceEnvelope=original.record.envelope as Record<string,unknown>;
    await wal.state.put('dlq','old-issue',{dlqId:'old-issue',targetId:'live',generation:'legacy',walEpoch:wal.walEpoch,ingestSequence:1,segment:original.segment,offset:original.offset,offsetEnd:original.offsetEnd,sourceRecordId:sourceEnvelope.recordId,sourceRecordHash:sourceEnvelope.recordHash,errorCode:'OLD_PROJECTION_RULE',stage:'prepare',createdAt:'2026-07-18T03:12:11Z',normalizerId:'old',normalizerVersion:1,projectionId:'old',projectionVersion:1,mappingSnapshot:mapping,providerQuality:null,status:'unresolved',resolvedAt:null});
    await wal.pin({id:'dlq:old-issue',owner:'live',kind:'dlq',fromSequence:1,throughSequence:1});
    await assert.rejects(manager.resolveDeadLetter('old-issue',{replayJobId:job.id,reason:'fixed projection'}),/DLQ_REPLAY_NOT_COMPLETED/);
    const executor=await createReplayExecutor({wal,job,targets:[isolated],liveTargets:[live],clientFactory:target=>target.targetId==='live'?source:destination});
    await manager.transition(job.id,'start');const done=await manager.runBatch(job.id,executor);
    assert.equal(done.status,'completed');assert.equal(done.projected,1);assert.equal(source.rows.length,0);assert.ok(destination.rows.some(row=>row.table==='telemetry_core.task_lifecycle_fact'));
    const resolved=await manager.resolveDeadLetter('old-issue',{replayJobId:job.id,reason:'validated replacement generation'});
    assert.equal(resolved.errorCode,'OLD_PROJECTION_RULE');assert.equal(resolved.resolution.originalTargetDisposition,'quarantined');assert.equal(resolved.resolution.replacementTargetId,'rebuild');assert.equal(wal.state.get('pin','dlq:old-issue'),undefined);assert.equal(wal.checkpointSequence('target:live'),0);
    assert.equal((await manager.resolveDeadLetter('old-issue',{replayJobId:job.id,reason:'retry'})).resolvedAt,resolved.resolvedAt);
    assert.throws(()=>assertGenerationIsolation(job,[{...isolated,connection:live.connection}],[live]),/REPLAY_ISOLATED_INSTANCE_REQUIRED/);
    await assert.rejects(createReplayExecutor({wal,job,targets:[isolated],liveTargets:[live],clientFactory:()=>new Store('same-database')}),/REPLAY_LIVE_DATABASE_ALIAS/);
    const changed=wal.readEntries()[0]!;const body=changed.record.envelope as Record<string,unknown>;body.payload={forged:true};await assert.rejects(executor.validate(changed,job),/REPLAY_SOURCE_HASH_MISMATCH/);
  }finally{await wal.close();}
});

test('historical accepted UTC text timestamps replay without changing signed source bytes or skipping other validation',async()=>{
  const wal=new WalStore({directory:await mkdtemp(join(tmpdir(),'replay-legacy-time-'))});await wal.initialize();
  try{
    const original=envelope({occurredAt:'July 18, 2026 03:12:10 GMT',emittedAt:'July 18, 2026 03:12:11 GMT'}),sourceJson=JSON.stringify(original);
    await wal.append({kind:'accepted',sourceSystem:'smpp',receivedAt:'2026-07-18T03:12:12Z',trustedContext:{collectorId:'c1',deploymentId:'development'},mapping,envelope:original});
    const manager=new ReplayManager(wal),job=await manager.create(request),destination=new Store('rebuild');
    const executor=await createReplayExecutor({wal,job,targets:[isolated],liveTargets:[live],clientFactory:target=>target.targetId==='live'?new Store('live'):destination});
    await manager.transition(job.id,'start');const done=await manager.runBatch(job.id,executor);assert.equal(done.status,'completed');assert.equal(done.projected,1);
    assert.equal(JSON.stringify(wal.readEntries()[0]!.record.envelope),sourceJson);
    const landing=destination.rows.find(output=>output.table==='telemetry_landing.smpp_provider_ops_v1')!.rows[0]!;
    assert.equal(landing.source_record_hash,original.recordHash);assert.deepEqual(JSON.parse(String(landing.envelope_json)),original);assert.equal(landing.occurred_at,'2026-07-18T03:12:10.000Z');
    const invalid=wal.readEntries()[0]!;invalid.record.envelope=envelope({...original,eventCategory:'command.lifecycle'});
    await assert.rejects(executor.validate(invalid,job),/REPLAY_CONTRACT_INVALID:RECORD_EVENT_CATEGORY_MISMATCH/);
    invalid.record.envelope=envelope({...original,occurredAt:'July 18, 2026 03:12:10'});
    await assert.rejects(executor.validate(invalid,job),/REPLAY_CONTRACT_INVALID:TIMESTAMP_INVALID/);
    invalid.record.kind='conflict';invalid.record.envelope=original;
    await assert.rejects(executor.validate(invalid,job),/REPLAY_CONTRACT_INVALID:TIMESTAMP_INVALID/);
  }finally{await wal.close();}
});

test('a replay generation binds one job atomically across competing setup and restart without blocking promoted live writes',async()=>{
  const path=await mkdtemp(join(tmpdir(),'replay-generation-owner-'));let wal=new WalStore({directory:path});await wal.initialize();
  const source=new Store('live'),destination=new Store('rebuild');
  const clientFactory=(target:ProjectionTarget)=>target.targetId==='live'?source:destination;
  try{
    const accepted={kind:'accepted',sourceSystem:'smpp',receivedAt:'2026-07-18T03:12:12Z',trustedContext:{collectorId:'c1',deploymentId:'development'},mapping,envelope:envelope()};
    await wal.append(accepted);const manager=new ReplayManager(wal),jobs=[await manager.create(request),await manager.create({...request,idempotencyKey:'competing-job'})];
    const results=await Promise.allSettled(jobs.map(job=>createReplayExecutor({wal,job,targets:[isolated],liveTargets:[live],clientFactory})));
    const winner=results.findIndex(result=>result.status==='fulfilled'),loser=1-winner;assert.ok(winner>=0);assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
    const rejected=results[loser]!;assert.equal(rejected.status,'rejected');if(rejected.status==='rejected')assert.match(String(rejected.reason),/REPLAY_GENERATION_ALREADY_BOUND/);
    const winningJob=jobs[winner]!,losingJob=jobs[loser]!;
    await Promise.all([1,2].map(()=>createReplayExecutor({wal,job:winningJob,targets:[isolated],liveTargets:[live],clientFactory})));
    const execution=results[winner]!;assert.equal(execution.status,'fulfilled');if(execution.status!=='fulfilled')throw new Error('missing winning executor');
    await manager.transition(winningJob.id,'start');assert.equal((await manager.runBatch(winningJob.id,execution.value)).status,'completed');
    await wal.append({...accepted,envelope:envelope({recordId:'efc6990d-6491-5c9b-bc71-5e7f5a377b5a'})});
    const liveAfterPromotion=new TargetWorker({wal,target:isolated,client:destination,metrics:new Metrics()});await liveAfterPromotion.flush();assert.equal(liveAfterPromotion.lastError,null);assert.equal(wal.checkpointSequence('target:rebuild'),2);
    await wal.close();wal=new WalStore({directory:path});await wal.initialize();
    await assert.rejects(createReplayExecutor({wal,job:losingJob,targets:[isolated],liveTargets:[live],clientFactory}),/REPLAY_GENERATION_ALREADY_BOUND/);
  }finally{await wal.close();}
});

test('backfill rejects compatibility views and preserves partial invalid-source evidence during a real replay',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'backfill-')),exportFile=join(directory,'export.jsonl'),mappings=join(directory,'mappings.json');
  const config:BackfillConfiguration={sourceTable:'legacy.provider_ops_raw_v1',sealedSource:true,exportFile,walDirectory:join(directory,'wal'),sourceMappingsFile:mappings,trustedContext:{collectorId:'c1',deploymentId:'development',trustDomain:'test'},replay:request,isolatedTargetsFile:join(directory,'isolated.json'),liveTargetsFile:join(directory,'live.json')};
  await writeFile(mappings,JSON.stringify({version:4,mappings:[{...mapping,status:'active',providerId:'warehouse-provider',instanceId:'runtime-replica-1',collectorId:'c1',deploymentId:'development',trustDomain:'test'}]}));
  await writeFile(config.isolatedTargetsFile,JSON.stringify({targets:[isolated]}));await writeFile(config.liveTargetsFile,JSON.stringify({targets:[live]}));
  const ignored=await planBackfill({query:async()=>JSON.stringify({data:[{engine:'View'}]})},config);assert.equal(ignored.reason,'compatibility_view_is_not_a_legacy_source');
  const valid=envelope(),rows=[{record_id:valid.recordId,record_hash:valid.recordHash,envelope_json:JSON.stringify(valid),received_at:'2026-07-18T03:12:11Z'},{record_id:'missing-original',record_hash:'h',received_at:'2026-07-18T03:12:11Z'}];
  const source={query:async(sql:string)=>JSON.stringify({data:sql.includes('system.tables')?[{engine:'MergeTree'}]:sql.includes('system.columns')?['record_id','record_hash','envelope_json','received_at'].map(name=>({name})):sql.includes('count()')?[{rows:2}]:rows})};
  assert.equal((await exportBackfill(source,config)).rows,2);const validation=await validateBackfill(config);assert.equal(validation.valid,1);assert.equal(validation.invalid,1);assert.equal(validation.status,'partial');
  const destination=new Store('rebuild'),liveStore=new Store('live');
  const factory:typeof createReplayExecutor=options=>createReplayExecutor({...options,clientFactory:target=>target.targetId==='live'?liveStore:destination});
  const report=await runBackfill(config,{executorFactory:factory});assert.equal(report.status,'partial');assert.ok(report.replayId);assert.equal(liveStore.rows.length,0);assert.ok(destination.rows.length>0);
  const repeat=await runBackfill(config,{executorFactory:factory});assert.equal(repeat.duplicates,1);assert.equal((await backfillStatus(config))?.invalid,1);
  const wal=new WalStore({directory:config.walDirectory});await wal.initialize();try{assert.equal(wal.state.scan('backfill:invalid').length,1);assert.equal(wal.acceptedCount(),1);}finally{await wal.close();}
  await writeFile(exportFile,'tampered');await assert.rejects(validateBackfill(config),/BACKFILL_MANIFEST_MISMATCH/);
});
