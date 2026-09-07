/** Actual production replay, coordinated lifecycle and old cursor across independent ClickHouse instances. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TargetWorker, type ProjectionClient, type ProjectionTarget } from '../../../telemetry-processor/src/packages/exporters/target-manager.js';
import { SnapshotPublisher } from '../../../telemetry-processor/src/packages/exporters/snapshot-publisher.js';
import { GenerationCoordinator } from '../../../telemetry-processor/src/packages/replay/generation.js';
import { generationCli } from '../../../telemetry-processor/src/packages/replay/generation-cli.js';
import { ReplayManager } from '../../../telemetry-processor/src/packages/replay/replay.js';
import { createReplayExecutor } from '../../../telemetry-processor/src/packages/replay/executor.js';
import { WalStore } from '../../../telemetry-processor/src/packages/wal/wal.js';
import { StandaloneSchemaPreflight } from '../../../telemetry-processor/src/packages/exporters/standalone-schema.js';
import { Metrics } from '../../../telemetry-processor/src/packages/metrics/metrics.js';
import { envelope, mapping } from '../../../telemetry-processor/test/helpers.js';
import { createPagination } from '../src/pagination.js';
import type { DiagnosticStore } from '../src/clickhouse.js';
import { validateReaderRegistry } from '../src/reader-registry.js';
const [oldContainer, nextContainer] = process.argv.slice(2);
if (!oldContainer || !nextContainer || [oldContainer,nextContainer].some(v => !/^[A-Za-z0-9_-]+$/u.test(v)) || oldContainer === nextContainer) throw new Error('Pass two independent isolated ClickHouse containers');
function transport(container: string, password: string) {
  const query = async (sql: string, input = ''): Promise<string> => new Promise((resolve,reject) => {
    const child = spawn('docker',['exec','-i',container,'clickhouse-client',...(password ? ['--password',password] : []),'--date_time_input_format=best_effort','--query',sql]);
    let output='',error='';child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',(v: string)=>{output+=v;});child.stderr.on('data',(v: string)=>{error+=v;});child.once('error',reject);child.stdin.once('error',reject);child.once('close',code=>code===0?resolve(output):reject(new Error(`ClickHouse ${code}: ${error}`)));child.stdin.end(input);
  });
  const client: ProjectionClient = { initialize: async()=>{}, ping: async()=>true, query, preflightStandalone: async target => { await new StandaloneSchemaPreflight().assert({query},target); }, insert: async(table,rows)=>{if(rows.length)await query(`INSERT INTO ${table} FORMAT JSONEachRow`,rows.map(row=>JSON.stringify(row)).join('\n')+'\n');} };
  const reader: DiagnosticStore={queryJson:async sql=>JSON.parse(await query(sql+' FORMAT JSON')) as {data:Record<string,unknown>[]}};
  return {query,client,reader};
}
const old = transport(oldContainer,''), next = transport(nextContainer,'e1-isolated-only');
for (const store of [old,next]) for (const file of (await readdir('telemetry-schema/migrations')).filter(v=>/^01[0-3]_.*\.sql$/u.test(v)).sort()) {
  for(const sql of (await readFile('telemetry-schema/migrations/'+file,'utf8')).replace(/^\s*--.*$/gmu,'').split(/;\s*(?:\n|$)/u).map(v=>v.trim()).filter(Boolean)) await store.query(sql);
}
const directory = await mkdtemp(join(tmpdir(),'generation-e2e-')), registryPath = join(directory,'readers.json'), writersPath = join(directory,'writers.json');
const id = randomUUID(), oldId='generation-old-'+id, nextId='generation-new-'+id;
const template = { targetType:'standalone_smpp_clickhouse',enabled:true,required:true,snapshotEnabled:true,acceptAllMappings:true,writeLayers:['landing','normalized','core','relation'] };
const oldTarget:ProjectionTarget={...template,targetId:oldId,generation:'g1',connection:{url:'http://old-isolated:8123'}}, nextTarget:ProjectionTarget={...template,targetId:nextId,generation:'g2',connection:{url:'http://new-isolated:8123'}};
await writeFile(writersPath,JSON.stringify({targets:[oldTarget,nextTarget]}));
await writeFile(registryPath,JSON.stringify({version:1,revision:1,activeTargetId:oldId,readers:{[oldId]:{url:oldTarget.connection.url}}}));
let wal=new WalStore({directory});await wal.initialize();let now=Date.now(), loseLifecycleAck=true;
const clock={now:()=>new Date(now).toISOString()}, key='persistent-generation-qualification-cursor-key';
const receivedAt=new Date(now-100).toISOString(),eventAt=new Date(now-200).toISOString();
try {
  const original = [0,1,2,3].map(()=>envelope({recordId:randomUUID(),occurredAt:eventAt,emittedAt:eventAt}));
  for(const record of original)await wal.append({kind:'accepted',sourceSystem:'smpp',receivedAt,trustedContext:{deploymentId:'development',collectorId:'simulation-qualification'},mapping,envelope:record});
  let oldWorker=new TargetWorker({target:oldTarget,wal,client:old.client,metrics:new Metrics(),clock});await oldWorker.initialize();await oldWorker.flush();assert.equal(oldWorker.status().lastError,null);
  const path='http://query/api/v1/events?consistency=snapshot&limit=2&order=asc';
  const first=await createPagination({client:old.reader,snapshotEnabled:true,snapshotTargetId:oldId,cursorKey:key,now:()=>now})(new URL(path));assert.ok(first?.nextCursor);
  let replay=new ReplayManager(wal), job=await replay.create({idempotencyKey:id,generation:'g2',targetIds:[nextId],fromSequence:1,throughSequence:4,normalizerVersion:4,projectionVersion:1,mappingVersion:4,policyVersion:1});
  const executor=await createReplayExecutor({wal,job,targets:[nextTarget],liveTargets:[oldTarget],clientFactory:target=>target.targetId===oldId?old.client:next.client});
  await replay.transition(job.id,'start');job=await replay.runBatch(job.id,executor);assert.equal(job.status,'completed',job.errorCode??'');now=Date.now();
  function coordinator(){return new GenerationCoordinator({wal,offline:true,now:()=>now,readerFor:target=>target===oldId?old.reader:next.reader,publishLifecycle:async lifecycle=>{
    await new SnapshotPublisher(wal,lifecycle.targetId===oldId?old.client:next.client,lifecycle.targetId,lifecycle.generation).refresh(clock.now());
    if(lifecycle.targetId===nextId&&loseLifecycleAck){loseLifecycleAck=false;throw new Error('QUALIFICATION_LIFECYCLE_ACK_LOST');}
  }});}
  let admin=coordinator();const evidence=await admin.inspectPromotion(job.id,nextId);assert.equal(evidence.throughSequence,4);
  await assert.rejects(admin.promote({jobId:job.id,targetId:nextId,readerConnection:{url:nextTarget.connection.url!},registryPath}),/QUALIFICATION_LIFECYCLE_ACK_LOST/u);
  assert.equal(JSON.parse(await readFile(registryPath,'utf8')).activeTargetId,oldId);
  const switchId=wal.state.scan('generation:switch',{limit:10})[0]!.key;
  await wal.close();wal=new WalStore({directory});await wal.initialize();admin=coordinator();
  const result=await admin.resume(switchId);assert.equal(result.registry.activeTargetId,nextId);assert.equal((await admin.resume(switchId)).switchId,switchId);
  const registry=validateReaderRegistry(JSON.parse(await readFile(registryPath,'utf8')));assert.equal(registry.revision,2);assert.ok(registry.readers[oldId]);
  oldWorker=new TargetWorker({target:oldTarget,wal,client:old.client,metrics:new Metrics(),clock});await oldWorker.initialize();await oldWorker.flush();
  assert.equal((await old.reader.queryJson(`SELECT lifecycle_status FROM telemetry_query.snapshot_v1 FINAL WHERE target_id='${oldId}'`)).data[0]?.lifecycle_status,'draining');
  await assert.rejects(oldWorker.projectReplayEntry(wal.readEntries(0,1)[0]!),/GENERATION_NOT_ACTIVE/u);
  const page=createPagination({client:next.reader,snapshotEnabled:true,snapshotTargetId:nextId,snapshotReaders:{[oldId]:old.reader},cursorKey:key,now:()=>now});
  const continued=await page(new URL(path+'&cursor='+encodeURIComponent(String(first.nextCursor))));assert.equal((continued?.snapshot as Record<string,unknown>).targetId,oldId);
  assert.deepEqual(new Set([...(first.data as Record<string,unknown>[]),...(continued?.data as Record<string,unknown>[])].map(row=>row.source_record_id)),new Set(original.map(row=>row.recordId)));
  const active=await page(new URL(path));assert.equal((active?.snapshot as Record<string,unknown>).targetId,nextId);
  await assert.rejects(createPagination({client:next.reader,snapshotEnabled:true,snapshotTargetId:nextId,cursorKey:key,now:()=>now})(new URL(path+'&cursor='+encodeURIComponent(String(first.nextCursor)))),/SNAPSHOT_READER_RETIRED/u);
  const rollback=await admin.rollback(switchId);assert.equal(rollback.registry.activeTargetId,oldId);
  const revertedPage=createPagination({client:old.reader,snapshotEnabled:true,snapshotTargetId:oldId,snapshotReaders:{[nextId]:next.reader},cursorKey:key,now:()=>now});
  const oldContinuation=await revertedPage(new URL(path+'&cursor='+encodeURIComponent(String(first.nextCursor))));assert.equal((oldContinuation?.snapshot as Record<string,unknown>).targetId,oldId);
  const newContinuation=await revertedPage(new URL(path+'&cursor='+encodeURIComponent(String(active!.nextCursor))));assert.equal((newContinuation?.snapshot as Record<string,unknown>).targetId,nextId);
  assert.equal((await revertedPage(new URL(path)))?.hasMore,true);
  const restored=await admin.rollback(rollback.switchId);assert.equal(restored.registry.activeTargetId,nextId);
  await wal.append({kind:'accepted',sourceSystem:'smpp',receivedAt:clock.now(),trustedContext:{deploymentId:'development',collectorId:'simulation-qualification'},mapping,envelope:envelope({recordId:randomUUID(),occurredAt:eventAt,emittedAt:eventAt})});
  await assert.rejects(admin.rollback(restored.switchId),/GENERATION_ROLLBACK_INPUT_BARRIER/u);
  await assert.rejects(admin.retire(oldId,'g1'),/GENERATION_READ_LEASE_ACTIVE/u);assert.equal(admin.gcDryRun(oldId,'g1').eligible,false);
  now+=660000;await admin.retire(oldId,'g1');assert.equal(admin.gcDryRun(oldId,'g1').eligible,true);assert.equal(wal.state.get<{status:string}>('target',`target:${oldId}`)?.status,'retired');
  await new SnapshotPublisher(wal,old.client,oldId,'g1').refresh(clock.now());assert.equal((await old.reader.queryJson(`SELECT lifecycle_status FROM telemetry_query.snapshot_v1 FINAL WHERE target_id='${oldId}'`)).data[0]?.lifecycle_status,'retired');
  await wal.close();
  let cliOutput:unknown;await generationCli(['gc-dry-run',oldId,'--generation','g1','--wal',directory,'--registry',registryPath,'--targets',writersPath],value=>{cliOutput=value;});
  // Wall time is intentionally earlier than the qualification's advanced clock: CLI conservatively refuses early GC.
  assert.equal((cliOutput as {eligible:boolean}).eligible,false);
  console.log(JSON.stringify({status:'PASS',oldTargetId:oldId,newTargetId:nextId,replayId:job.id,switchId,walDirectory:directory,cases:['actual production full ReplayExecutor','independent database UUIDs','manifest and output evidence','real snapshot count/hash joins','lifecycle ACK loss and SQLite owner restart','idempotent prepared switch recovery','atomic registry revision','old signed cursor on old instance after active switch','new cursor on promoted instance','missing historical reader 410','draining publisher never reactivates','draining target rejects writes','lease-protected retire and GC dry-run','retired publisher never reactivates','executable offline GC CLI','rollback at a common input barrier','both generation cursors survive rollback','new WAL input rejects incomplete rollback'] }));
}finally{await wal.close();}
