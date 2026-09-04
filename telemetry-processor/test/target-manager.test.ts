import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {WalStore} from '../src/packages/wal/wal.js';import {TargetManager,partitionRowsForInsert} from '../src/packages/exporters/target-manager.js';import {Metrics} from '../src/packages/metrics/metrics.js';import {envelope,mapping} from './helpers.js';class Fake{constructor(fail=false){this.fail=fail;this.rows=[];}async initialize(){}async ping(){if(this.fail)throw new Error('down');}async insert(t,r){if(this.fail)throw new Error('down');this.rows.push([t,r]);}}test('target failures do not stop independent target checkpoints',async()=>{const wal=new WalStore({directory:await mkdtemp(join(tmpdir(),'targets-'))});await wal.initialize();await wal.append({kind:'accepted',sourceSystem:'smpp',receivedAt:'2026-07-18T03:12:11Z',trustedContext:{deploymentId:'development',collectorId:'c1'},mapping,envelope:envelope()});const clients={good:new Fake(),bad:new Fake(true)},targets=[{targetId:'good',targetType:'standalone',enabled:true,required:true,acceptAllMappings:true,writeLayers:['landing','normalized','core','relation'],connection:{}},{targetId:'bad',targetType:'shadow',enabled:true,required:false,acceptAllMappings:true,writeLayers:['core'],connection:{}}],m=new TargetManager({targets,wal,metrics:new Metrics(),clientFactory:t=>clients[t.targetId]});await m.initialize();await m.flush();assert.equal(m.statuses().find(x=>x.targetId==='good').pending,0);assert.equal(m.statuses().find(x=>x.targetId==='bad').pending,1);assert.ok(clients.good.rows.length>=3);});

test('target inserts are stably split by the table month partition',()=>{
  const rows=[
    {id:'a',occurred_at:'2026-08-01T00:00:00.000Z'},
    {id:'b',occurred_at:'2025-07-01T00:00:00.000Z'},
    {id:'c',occurred_at:'2026-08-31T23:59:59.999Z'}
  ];
  assert.deepEqual(partitionRowsForInsert('telemetry_core.provider_operation_fact',rows),[[rows[0],rows[2]],[rows[1]]]);
});

test('hash-partitioned shared tables never exceed 100 possible partitions per insert',()=>{
  const rows=Array.from({length:205},(_,id)=>({id}));
  const blocks=partitionRowsForInsert('sdar_core.external_provider_fact',rows);
  assert.deepEqual(blocks.map(block=>block.length),[100,100,5]);
  assert.deepEqual(blocks.flat(),rows);
  assert.deepEqual(
    partitionRowsForInsert('sdar_core.external_entity_relation_fact',rows).map(block=>block.length),
    [100,100,5]
  );
});

test('sdar_shared_warehouse selects the typed adapter and keeps an independent checkpoint',async()=>{const wal=new WalStore({directory:await mkdtemp(join(tmpdir(),'sdar-target-'))});await wal.initialize();await wal.append({kind:'accepted',sourceSystem:'smpp',receivedAt:'2026-08-18T01:02:04Z',trustedContext:{deploymentId:'development',collectorId:'c1'},mapping,envelope:envelope()});const client=new Fake();const target={targetId:'sdar-warehouse-shadow',targetType:'sdar_shared_warehouse',enabled:true,required:false,acceptAllMappings:true,writeLayers:['core','relation'],connection:{},tableMap:{}};const m=new TargetManager({targets:[target],wal,metrics:new Metrics(),clientFactory:()=>client});m.targets[0].schemaPreflight={assert:async()=>true};await m.initialize();await m.flush();assert.equal(m.statuses()[0].pending,0);assert.equal(m.statuses()[0].projectionId,'smpp_provider_ops_to_sdar_core');assert.equal(client.rows[0][0],'sdar_core.external_provider_fact');assert.equal(client.rows[0][1][0].smpp_source_id,'smpp.test.provider-one');});

test('sdar target restart replays its pending WAL without moving standalone twice',async()=>{const directory=await mkdtemp(join(tmpdir(),'sdar-restart-'));let wal=new WalStore({directory});await wal.initialize();await wal.append({kind:'accepted',sourceSystem:'smpp',receivedAt:'2026-08-18T01:02:04Z',trustedContext:{deploymentId:'development',collectorId:'c1'},mapping,envelope:envelope()});const standalone=new Fake(),failedSdar=new Fake(true);const targets=[{targetId:'standalone-smpp',targetType:'standalone',enabled:true,required:true,acceptAllMappings:true,writeLayers:['landing'],connection:{}},{targetId:'sdar-warehouse-shadow',targetType:'sdar_shared_warehouse',enabled:true,required:false,acceptAllMappings:true,writeLayers:['core','relation'],connection:{},tableMap:{}}];let manager=new TargetManager({targets,wal,metrics:new Metrics(),clientFactory:(target)=>target.targetId==='standalone-smpp'?standalone:failedSdar});manager.targets[1].schemaPreflight={assert:async()=>true};await manager.initialize();await manager.flush();assert.equal(manager.statuses()[0].pending,0);assert.equal(manager.statuses()[1].pending,1);wal=new WalStore({directory});await wal.initialize();const recoveredSdar=new Fake();manager=new TargetManager({targets,wal,metrics:new Metrics(),clientFactory:(target)=>target.targetId==='standalone-smpp'?standalone:recoveredSdar});manager.targets[1].schemaPreflight={assert:async()=>true};await manager.initialize();await manager.flush();assert.equal(manager.statuses()[0].pending,0);assert.equal(manager.statuses()[1].pending,0);assert.equal(standalone.rows.length,1);assert.equal(recoveredSdar.rows[0][0],'sdar_core.external_provider_fact');});

test('optional SDAR schema preflight outage does not prevent required standalone startup',async()=>{const wal=new WalStore({directory:await mkdtemp(join(tmpdir(),'sdar-preflight-outage-'))});await wal.initialize();const required=new Fake(),optional=new Fake(),targets=[{targetId:'standalone-smpp',targetType:'standalone',enabled:true,required:true,acceptAllMappings:true,writeLayers:['landing'],connection:{}},{targetId:'sdar-warehouse-shadow',targetType:'sdar_shared_warehouse',enabled:true,required:false,acceptAllMappings:true,writeLayers:['core'],connection:{},tableMap:{}}],manager=new TargetManager({targets,wal,metrics:new Metrics(),clientFactory:(target)=>target.targetId==='standalone-smpp'?required:optional});manager.targets[1].schemaPreflight={assert:async()=>{throw new Error('SMPP_SHADOW_TARGET_UNAVAILABLE');}};await manager.initialize();assert.equal(manager.statuses()[0].lastError,null);assert.equal(manager.statuses()[1].lastError,'SMPP_SHADOW_TARGET_UNAVAILABLE');});

test('projection rows carry processor time across targets with opposite server clock drift',async()=>{
  const wal=new WalStore({directory:await mkdtemp(join(tmpdir(),'processor-projection-time-'))});
  await wal.initialize();
  await wal.append({kind:'accepted',sourceSystem:'smpp',receivedAt:'2026-09-04T07:56:43.500Z',trustedContext:{deploymentId:'development',collectorId:'c1'},mapping,envelope:envelope()});
  class DriftedTarget extends Fake{
    constructor(serverNow){super();this.serverNow=serverNow;}
    async insert(table,rows){this.rows.push([table,rows.map(row=>({...row,projected_at:row.projected_at??this.serverNow}))]);}
  }
  const clients={
    'standalone-smpp':new DriftedTarget('2026-09-04T07:58:13.750Z'),
    'sdar-warehouse-shadow':new DriftedTarget('2026-09-04T07:55:13.750Z')
  };
  const targets=[
    {targetId:'standalone-smpp',targetType:'standalone_smpp_clickhouse',enabled:true,required:true,acceptAllMappings:true,writeLayers:['core','relation'],connection:{}},
    {targetId:'sdar-warehouse-shadow',targetType:'sdar_shared_warehouse',enabled:true,required:false,acceptAllMappings:true,writeLayers:['core','relation'],connection:{},tableMap:{}}
  ];
  const processorTime='2026-09-04T07:56:43.750Z';
  const manager=new TargetManager({targets,wal,metrics:new Metrics(),clock:{now:()=>processorTime},clientFactory:target=>clients[target.targetId]});
  manager.targets[1].schemaPreflight={assert:async()=>true};
  await manager.initialize();
  await manager.flush();
  for(const client of Object.values(clients)){
    const rows=client.rows.flatMap(([,batch])=>batch);
    assert.ok(rows.length>0);
    assert.ok(rows.every(row=>row.projected_at===processorTime));
  }
  assert.deepEqual(manager.statuses().map(status=>status.pending),[0,0]);
  assert.deepEqual(manager.statuses().map(status=>[status.checkpoint.segment,status.checkpoint.offsetEnd]),[[1,manager.statuses()[0].checkpoint.offsetEnd],[1,manager.statuses()[0].checkpoint.offsetEnd]]);
});

test('projection fails closed when processor projection time precedes receiver time',async()=>{
  const wal=new WalStore({directory:await mkdtemp(join(tmpdir(),'processor-clock-regression-'))});
  await wal.initialize();
  await wal.append({kind:'accepted',sourceSystem:'smpp',receivedAt:'2026-09-04T07:56:43.500Z',trustedContext:{deploymentId:'development',collectorId:'c1'},mapping,envelope:envelope()});
  const client=new Fake();
  const target={targetId:'standalone-smpp',targetType:'standalone_smpp_clickhouse',enabled:true,required:true,acceptAllMappings:true,writeLayers:['core'],connection:{}};
  const manager=new TargetManager({targets:[target],wal,metrics:new Metrics(),clock:{now:()=> '2026-09-04T07:56:43.499Z'},clientFactory:()=>client});
  await manager.initialize();
  await manager.flush();
  assert.equal(manager.statuses()[0].lastError,'PROCESSOR_PROJECTION_CLOCK_BEFORE_RECEIVE');
  assert.equal(manager.statuses()[0].pending,1);
  assert.equal(client.rows.length,0);
});
