import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WalStore } from '../src/packages/wal/wal.js';
import { ReplayManager, type ReplayRequest, type ReplayExecutor } from '../src/packages/replay/replay.js';

const request=(throughSequence:number):ReplayRequest=>({idempotencyKey:'rebuild-1',generation:'rebuild-v2',targetIds:['isolated-v2'],fromSequence:1,throughSequence,normalizerVersion:1,projectionVersion:2,mappingVersion:4,policyVersion:1});
async function setup(){const directory=await mkdtemp(join(tmpdir(),'replay-')),wal=new WalStore({directory,segmentMaxBytes:300,gcEnabled:true});await wal.initialize();await wal.registerTarget('live');for(let id=1;id<=3;id++){const entry=await wal.append({kind:'accepted',sourceSystem:'smpp',mapping:{tenantId:'tenant-a'},trustedContext:{deploymentId:'game-a'},envelope:{recordId:`record-${id}`,recordHash:`hash-${id}`}});await wal.commit('live',entry);}return{directory,wal,replays:new ReplayManager(wal)};}

test('replay jobs pin immutable inputs, survive restart and complete without changing live checkpoint',async()=>{
  const initial=await setup();let wal=initial.wal,replays=initial.replays;const live=wal.checkpoint('live');
  const plan=replays.plan(request(3));assert.equal(plan.selected,3);assert.equal(plan.invalidInputs,0);
  const job=await replays.create(request(3));assert.equal((await replays.create(request(3))).id,job.id);assert.ok(wal.state.get('pin',`replay:${job.id}`));
  await assert.rejects(replays.create({...request(3),generation:'different'}),/REPLAY_IDEMPOTENCY_CONFLICT/);
  await replays.transition(job.id,'start');const output:number[]=[];const executor:ReplayExecutor={validate:async()=>{},project:async(entry)=>{output.push(entry.ingestSequence);return'projected';}};
  assert.equal((await replays.runBatch(job.id,executor,1)).afterSequence,1);await replays.transition(job.id,'pause');await wal.close();
  wal=new WalStore({directory:initial.directory,gcEnabled:true});await wal.initialize();replays=new ReplayManager(wal);
  try{
    assert.equal(replays.get(job.id)?.status,'paused');await replays.transition(job.id,'resume');const done=await replays.runBatch(job.id,executor);
    assert.equal(done.status,'completed');assert.equal(done.projected,3);assert.deepEqual(output,[1,2,3]);assert.equal(wal.state.get('pin',`replay:${job.id}`),undefined);assert.deepEqual(wal.checkpoint('live'),live);
  }finally{await wal.close();}
});

test('failed replay retains its source pin and resumes at the failed record after source validation',async()=>{
  const{wal,replays}=await setup();
  try{
    const job=await replays.create(request(3));await replays.transition(job.id,'start');
    const failed=await replays.runBatch(job.id,{validate:async()=>{throw new Error('REPLAY_HASH_MISMATCH');},project:async()=>'projected'});
    assert.equal(failed.status,'failed');assert.equal(failed.afterSequence,0);assert.equal(failed.errorCode,'REPLAY_HASH_MISMATCH');assert.ok(wal.state.get('pin',`replay:${job.id}`));
    await replays.transition(job.id,'resume');const done=await replays.runBatch(job.id,{validate:async()=>{},project:async()=>'quarantined'});assert.equal(done.status,'completed');assert.equal(done.quarantined,3);
  }finally{await wal.close();}
});

test('scope filtering and cancellation are durable and never report skipped inputs as projected',async()=>{
  const{wal,replays}=await setup();
  try{
    const job=await replays.create({...request(3),scope:{tenantId:'different'}});assert.equal(job.plan.selected,0);await replays.transition(job.id,'start');
    const done=await replays.runBatch(job.id,{validate:async()=>{throw new Error('must not validate another tenant');},project:async()=>{throw new Error('must not project another tenant');}});assert.equal(done.projected,0);assert.equal(done.notRouted,3);assert.equal(done.status,'completed');
    const cancelled=await replays.create({...request(3),idempotencyKey:'cancel-me'});await replays.transition(cancelled.id,'cancel');assert.equal(replays.get(cancelled.id)?.status,'cancelled');assert.equal(wal.state.get('pin',`replay:${cancelled.id}`),undefined);assert.equal((await replays.transition(cancelled.id,'cancel')).status,'cancelled');
  }finally{await wal.close();}
});

test('a replay can read archived source frames after hot-segment collection',async()=>{
  const{wal,replays}=await setup();
  try{
    await wal.archiveClosedSegments();assert.ok((await wal.compact({dryRun:false})).reclaimedBytes>0);
    const job=await replays.create(request(3));await replays.transition(job.id,'start');const done=await replays.runBatch(job.id,{validate:async()=>{},project:async()=>'projected'});assert.equal(done.projected,3);assert.equal(done.status,'completed');
  }finally{await wal.close();}
});

test('ReplayManager instances sharing a WalStore serialize one job while append remains available',async()=>{
  const{wal,replays}=await setup(),other=new ReplayManager(wal);let entered=()=>{},release=()=>{};
  const ready=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  try{
    const job=await replays.create(request(3));await replays.transition(job.id,'start');let projected=0;
    const executor:ReplayExecutor={validate:async()=>{},project:async()=>{projected++;entered();await gate;return'projected';}};
    const first=replays.runBatch(job.id,executor,1);await ready;
    await assert.rejects(other.runBatch(job.id,executor,1),/REPLAY_JOB_ALREADY_RUNNING/);
    assert.equal((await wal.append({kind:'rejected'})).ingestSequence,4);
    release();assert.equal((await first).processed,1);assert.equal(projected,1);
    const next=await other.runBatch(job.id,{validate:async()=>{},project:async()=>{projected++;return'projected';}},1);
    assert.equal(next.processed,2);assert.equal(next.afterSequence,2);assert.equal(projected,2);
  }finally{release();await wal.close();}
});
