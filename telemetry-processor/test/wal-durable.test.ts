import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, truncate, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { WalStore } from '../src/packages/wal/wal.js';
import { DurableState } from '../src/packages/durable-state/state.js';
import { DatabaseSync } from 'node:sqlite';
import { buildStateScanQuery, prefixSuccessor } from '../src/packages/durable-state/scan-query.js';

const directory=()=>mkdtemp(join(tmpdir(),'wal-durable-'));
const record=(id:number,changes:Record<string,unknown>={})=>({kind:'accepted',sourceSystem:'smpp',envelope:{recordId:`r${id}`,recordHash:String(id).padStart(64,'0'),providerId:'p',instanceId:'i',recordType:'provider.task.lifecycle',taskId:'task',providerEventSequence:id,payload:{currentState:'running'},...changes}});
const append=(wal:WalStore,id:number,changes:Record<string,unknown>={})=>{
  const acceptedRecord=record(id,changes);return wal.appendClassified({sourceSystem:'smpp',recordId:acceptedRecord.envelope.recordId,recordHash:acceptedRecord.envelope.recordHash,acceptedRecord,conflictRecord:()=>({...acceptedRecord,kind:'conflict'})});
};

test('state namespace prefix and after scans use a primary-key range seek',()=>{
  const db=new DatabaseSync(':memory:');
  try{
    db.exec('CREATE TABLE state_kv(namespace TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(namespace,key)) WITHOUT ROWID');
    const query=buildStateScanQuery('scope-ledger',{prefix:'target/generation/',after:'target/generation/0000999',limit:1});
    assert.deepEqual(query.bindings,['scope-ledger','target/generation/0000999','target/generation0',1]);
    const details=db.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.bindings).map(row=>String(row.detail)).join('\n');
    assert.match(details,/SEARCH state_kv USING PRIMARY KEY \(namespace=\? AND key>\? AND key<\?\)/);assert.doesNotMatch(details,/SCAN state_kv|TEMP B-TREE/);
  }finally{db.close();}
});

test('state prefix seeks preserve Unicode BINARY order and exclusive after pagination',async()=>{
  const wal=new WalStore({directory:await directory()});await wal.initialize();
  try{
    const keys=['p/a','p/b','p/😀a','p/😀b','p/😁a','p0/a','\uffffa','\u{10000}a','\u{10ffff}a','\u{10ffff}b'];
    await wal.state.transaction(keys.map(key=>({type:'put' as const,namespace:'seek',key,value:key})));
    assert.deepEqual(wal.state.scan('seek',{prefix:'p/',after:'p/b',limit:2}).map(item=>item.key),['p/😀a','p/😀b']);
    assert.deepEqual(wal.state.scan('seek',{prefix:'p/😀'}).map(item=>item.key),['p/😀a','p/😀b']);
    assert.deepEqual(wal.state.scan('seek',{prefix:'p/',after:'p0/a'}),[]);
    assert.deepEqual(wal.state.scan('seek',{prefix:'\uffff',after:'\u{10000}a'}),[]);
    assert.deepEqual(wal.state.scan('seek',{prefix:'\u{10ffff}',after:'\u{10ffff}a'}).map(item=>item.key),['\u{10ffff}b']);
    assert.equal(prefixSuccessor('\u{10ffff}'),undefined);assert.equal(prefixSuccessor('\ud7ff'),'\ue000');
  }finally{await wal.close();}
});

test('cached free-space admission leaves WAL untouched and preserves room for control-state writes',async()=>{
  let availableBytes=64,probes=0;
  const wal=new WalStore({directory:await directory(),minFreeBytes:128,freeSpaceSampleMs:60000,filesystemProbe:async()=>{probes++;return{availableBytes};}});await wal.initialize();
  try{
    await assert.rejects(wal.append(record(1)),error=>error instanceof Error&&error.message==='WAL_DISK_RESERVE_REQUIRED'&&'statusCode'in error&&error.statusCode===503);
    assert.equal(wal.state.lastSequence(),0);assert.equal(wal.totalBytes,0);assert.equal(wal.stats().writeFailed,false);assert.equal((await stat(join(wal.directory,'segment-000000000001.wal'))).size,0);assert.equal(wal.stats().diskReserveRequired,true);
    await wal.state.put('dlq','control',{reason:'existing record needs quarantine'});assert.ok(wal.stats().dlqBytes>0);
    availableBytes=1024*1024;const first=await wal.append(record(1));assert.equal(first.ingestSequence,1);
    const sampleCount=probes;await wal.append(record(2));wal.stats();wal.stats();assert.equal(probes,sampleCount);assert.equal(wal.stats().diskReserveRequired,false);assert.ok(wal.stats().freeSpaceSampledAt);
  }finally{await wal.close();}
});

test('archive low space and unavailable probes reject admission while explicit zero disables the gate',async()=>{
  const wal=new WalStore({directory:await directory(),minFreeBytes:128,filesystemProbe:async path=>({availableBytes:path.endsWith('/archive')?0:1024*1024})});await wal.initialize();
  try{assert.equal(wal.stats().archiveFreeBytes,0);await assert.rejects(wal.append(record(1)),/WAL_DISK_RESERVE_REQUIRED/);assert.equal(wal.state.lastSequence(),0);}finally{await wal.close();}
  const unavailable=new WalStore({directory:await directory(),filesystemProbe:async()=>{throw new Error('statfs unavailable');}});await unavailable.initialize();
  try{assert.equal(unavailable.stats().walFreeBytes,null);await assert.rejects(unavailable.append(record(1)),/WAL_DISK_RESERVE_REQUIRED/);assert.equal(unavailable.stats().writeFailed,false);}finally{await unavailable.close();}
  const disabled=new WalStore({directory:await directory(),minFreeBytes:0,filesystemProbe:async()=>({availableBytes:0})});await disabled.initialize();
  try{assert.equal((await disabled.append(record(1))).ingestSequence,1);assert.equal(disabled.stats().diskReserveRequired,false);}finally{await disabled.close();}
});

test('SQLite transaction and target checkpoint advance atomically',async()=>{
  const wal=new WalStore({directory:await directory()});await wal.initialize();
  try{
    const entry=await wal.append(record(1));
    await assert.rejects(wal.commit('target:a',entry,{operations:[{type:'put',namespace:'dlq',key:'x',value:{code:'BAD'}},{type:'check',namespace:'plan',key:'missing',expected:123}]}),/STATE_COMPARE_FAILED/);
    assert.equal(wal.state.get('dlq','x'),undefined);assert.equal(wal.pendingCount('target:a'),1);
    await wal.commit('target:a',entry,{operations:[{type:'put',namespace:'dlq',key:'x',value:{code:'BAD'}},{type:'increment',namespace:'publication',key:'target:a'}]});
    assert.deepEqual(wal.state.get('dlq','x'),{code:'BAD'});assert.equal(wal.state.get('publication','target:a'),1);assert.equal(wal.pendingCount('target:a'),0);
  }finally{await wal.close();}
});

test('a fsynced frame whose SQLite commit failed is recovered before duplicate ACK',async()=>{
  const path=await directory();let wal=new WalStore({directory:path});await wal.initialize();
  const indexFrame=wal.state.indexFrame.bind(wal.state);wal.state.indexFrame=async()=>{throw new Error('injected commit failure');};
  await assert.rejects(append(wal,1),/WAL_WRITE_FAILED_RESTART_REQUIRED/);wal.state.indexFrame=indexFrame;
  assert.equal(wal.stats().writeFailed,true);await wal.close();
  wal=new WalStore({directory:path});await wal.initialize();
  try{assert.equal((await append(wal,1)).classification,'duplicate');assert.equal(wal.pendingCount('a'),1);assert.equal(wal.pending('a')[0]!.ingestSequence,1);}finally{await wal.close();}
});

test('GC preserves exact identity, sequence, revision and terminal indexes after restart',async()=>{
  const path=await directory();let wal=new WalStore({directory:path,segmentMaxBytes:300,gcEnabled:true,cacheMaxBytes:512});await wal.initialize();await wal.registerTarget('a');
  const first=await append(wal,1,{payload:{providerRevision:'7',terminalStatus:'completed'}});assert.ok(first.entry);
  const second=await append(wal,2,{taskId:'different'});assert.ok(second.entry);await wal.commit('a',second.entry);
  await wal.archiveClosedSegments();const result=await wal.compact({dryRun:false});assert.deepEqual(result.eligible,[1]);assert.ok(result.reclaimedBytes>0);
  assert.equal(wal.stats().segments,1);await wal.close();
  wal=new WalStore({directory:path,segmentMaxBytes:300,gcEnabled:true});await wal.initialize();
  try{
    assert.equal(wal.classify('smpp','r1','1'.padStart(64,'0')),'duplicate');assert.equal(wal.classify('smpp','r1','f'.repeat(64)),'conflict');
    assert.equal((await append(wal,3,{providerEventSequence:1})).semanticCode,'SMPP_PROVIDER_EVENT_SEQUENCE_CONFLICT');
    assert.equal((await append(wal,4,{payload:{providerRevision:'7'}})).semanticCode,'SMPP_PROVIDER_REVISION_CONFLICT');
    assert.equal((await append(wal,5,{payload:{terminalStatus:'failed'}})).semanticCode,'SMPP_PROVIDER_TERMINAL_CONFLICT');
    assert.equal(wal.readEntries(0,1)[0]!.record.envelope!==undefined,true);assert.equal(wal.checkpoint('a').segment,2);
  }finally{await wal.close();}
});

test('registered optional targets and replay pins retain closed segments until explicit release',async()=>{
  const wal=new WalStore({directory:await directory(),segmentMaxBytes:200,gcEnabled:true});await wal.initialize();
  try{
    await wal.registerTarget('required');await wal.registerTarget('optional');
    const first=await wal.append(record(1)),last=await wal.append(record(2));await wal.commit('required',last);await wal.archiveClosedSegments();
    assert.ok((await wal.compact()).blocked.some(value=>value.segment===1&&value.reason==='target_pending'));
    await wal.commit('optional',last);await wal.pin({id:'replay:1',owner:'job:1',kind:'replay',fromSequence:1,throughSequence:1});
    assert.ok((await wal.compact()).blocked.some(value=>value.segment===1&&value.reason==='pinned'));
    await wal.releasePin('replay:1');assert.deepEqual((await wal.compact({dryRun:false})).eligible,[first.segment]);
    await wal.registerTarget('new-current',{start:'current'});assert.equal(wal.pendingCount('new-current'),0);
    await wal.registerTarget('archive-reader',{start:'beginning'});assert.equal(wal.pendingCount('archive-reader'),2);assert.equal(wal.pending('archive-reader')[0]!.ingestSequence,1);
  }finally{await wal.close();}
});

test('steady ingestion beyond ten hot-storage budgets keeps cached records and hot WAL bounded',async()=>{
  const budget=4096,wal=new WalStore({directory:await directory(),segmentMaxBytes:600,gcEnabled:true,cacheMaxBytes:1024});await wal.initialize();await wal.registerTarget('a');
  let totalWritten=0;
  try{
    for(let id=1;id<=140;id++){
      const entry=await wal.append(record(id),{maxTotalBytes:budget});totalWritten+=entry.offsetEnd-entry.offset;await wal.commit('a',entry);
      if(id%4===0){await wal.archiveClosedSegments();await wal.compact({dryRun:false});}
      assert.ok(wal.stats().totalBytes<=budget);assert.ok(wal.stats().cacheBytes<=1024);
    }
    assert.ok(totalWritten>budget*10);assert.equal(wal.pendingCount('a'),0);assert.equal(wal.stats().entries,140);assert.ok(wal.stats().stateBytes>0);assert.ok(wal.stats().archiveBytes>budget*10);
  }finally{await wal.close();}
});

test('an acknowledged frame truncated on disk and a missing state database fail closed',async()=>{
  const path=await directory();let wal=new WalStore({directory:path});await wal.initialize();await wal.append(record(1));await wal.close();
  await truncate(join(path,'segment-000000000001.wal'),4);wal=new WalStore({directory:path});await assert.rejects(wal.initialize(),/WAL_INDEXED_FRAME_MISSING/);
  const path2=await directory();wal=new WalStore({directory:path2});await wal.initialize();await wal.close();await unlink(join(path2,'state.sqlite'));
  wal=new WalStore({directory:path2});await assert.rejects(wal.initialize(),/WAL_STATE_MISSING_RESTORE_REQUIRED/);
});

test('acknowledged CRC corruption is never silently truncated as a partial tail',async()=>{
  const path=await directory();let wal=new WalStore({directory:path});await wal.initialize();await wal.append(record(1));await wal.close();
  const file=join(path,'segment-000000000001.wal'),bytes=await readFile(file);bytes[8]=bytes[8]!^1;await writeFile(file,bytes);
  wal=new WalStore({directory:path});await assert.rejects(wal.initialize(),/WAL_CRC_MISMATCH/);
});

test('completed archives are checked on demand and by explicit audit without rescanning their payload at startup',async()=>{
  const path=await directory();let wal=new WalStore({directory:path,segmentMaxBytes:200,gcEnabled:true});await wal.initialize();await wal.registerTarget('a');await wal.append(record(1));const last=await wal.append(record(2));await wal.commit('a',last);await wal.archiveClosedSegments();await wal.compact({dryRun:false});const archive=wal.state.segment(1)!.archivePath!;await wal.close();
  const bytes=await readFile(archive);bytes[8]=bytes[8]!^1;await writeFile(archive,bytes);
  wal=new WalStore({directory:path,gcEnabled:true});await wal.initialize();
  try{assert.equal(wal.classify('smpp','r1','1'.padStart(64,'0')),'duplicate');assert.throws(()=>wal.readEntries(0,1),/WAL_ARCHIVE_VERIFY_FAILED/);await assert.rejects(wal.auditArchives(),/WAL_ARCHIVE_VERIFY_FAILED/);}finally{await wal.close();}
});

test('accepted counts and oldest accepted lookup use exact kind positions across other frame kinds',async()=>{
  const wal=new WalStore({directory:await directory()});await wal.initialize();
  try{await wal.append({kind:'rejected'});const first=await wal.append(record(1));await wal.append({kind:'conflict'});const second=await wal.append(record(2));assert.equal(wal.acceptedCount(),2);assert.equal(wal.acceptedCount(first.ingestSequence),1);assert.equal(wal.acceptedCount(0,first.ingestSequence),1);assert.equal(wal.firstAcceptedAfter(first.ingestSequence)?.ingestSequence,second.ingestSequence);assert.equal(wal.state.frameCount(0,undefined,'rejected'),1);}finally{await wal.close();}
});

test('same-process reopen fences the prior writer and a different process cannot open its directory',async()=>{
  const path=await directory(),first=new WalStore({directory:path});await first.initialize();const second=new WalStore({directory:path});await second.initialize();
  try{
    await assert.rejects(first.append(record(1)),/WAL_STORE_FENCED/);
    // PID values and process start times can be meaningless in another container.
    // Even deliberately stale audit metadata must not release the OS lock.
    await writeFile(join(path,'writer.lock'),JSON.stringify({pid:1,processStart:'untrusted-container-start',id:'untrusted-owner'}));
    const moduleUrl=new URL('../src/packages/wal/wal.js',import.meta.url).href;
    const script=`import {WalStore} from ${JSON.stringify(moduleUrl)};const wal=new WalStore({directory:${JSON.stringify(path)}});try{await wal.initialize();await wal.close();process.exitCode=2;}catch(error){if(error.message!=='WAL_DIRECTORY_ALREADY_OPEN')throw error;}`;
    const env={...process.env};delete env.NODE_TEST_CONTEXT;
    const child=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout:10000,env});assert.equal(child.status,0,child.stderr);
  }finally{await second.close();}
});

test('two SQLite workers cannot own one directory and close preserves the lease inode for reopening',async()=>{
  const path=await directory(),first=new DurableState(join(path,'state.sqlite'));await first.ready;
  const inode=(await stat(join(path,'owner.sqlite'))).ino;
  try{
    const second=new DurableState(join(path,'state.sqlite'));
    await assert.rejects(second.ready,/WAL_DIRECTORY_ALREADY_OPEN/);
    await first.put('test','owner','first');assert.equal(await first.getAsync('test','owner'),'first');
  }finally{await first.close();}
  const reopened=new DurableState(join(path,'state.sqlite'));await reopened.ready;
  try{assert.equal((await stat(join(path,'owner.sqlite'))).ino,inode);assert.equal(await reopened.getAsync('test','owner'),'first');}finally{await reopened.close();}
});

test('ingestion performs asynchronous SQLite reads including dedup, quality and segment rotation',async()=>{
  const wal=new WalStore({directory:await directory(),segmentMaxBytes:200});await wal.initialize();
  try{
    const forbidden=()=>{throw new Error('synchronous state read reached ingestion');};
    wal.state.get=forbidden;wal.state.lastSequence=forbidden;wal.state.segment=forbidden;wal.state.meta=forbidden;
    assert.equal((await append(wal,1,{payload:{providerRevision:'1'}})).classification,'new');
    assert.equal((await append(wal,3,{payload:{providerRevision:'3'}})).classification,'new');
    assert.equal((await append(wal,2,{payload:{providerRevision:'2'}})).classification,'new');
    assert.equal((await append(wal,1,{payload:{providerRevision:'1'}})).classification,'duplicate');
    assert.equal((await append(wal,4,{providerEventSequence:1,payload:{providerRevision:'4'}})).semanticCode,'SMPP_PROVIDER_EVENT_SEQUENCE_CONFLICT');
    assert.equal(await wal.state.lastSequenceAsync(),4);
  }finally{await wal.close();}
});

test('an unregistered target observation survives restart and blocks GC until its registration is complete',async()=>{
  const path=await directory();let wal=new WalStore({directory:path,segmentMaxBytes:200,gcEnabled:true});await wal.initialize();
  await wal.registerTarget('known');await wal.append(record(1));const last=await wal.append(record(2));await wal.commit('known',last);await wal.archiveClosedSegments();
  assert.equal(wal.pendingCount('unknown'),2);await assert.rejects(wal.compact({dryRun:false}),/WAL_GC_TARGET_REGISTRY_INCOMPLETE/);await wal.close();
  wal=new WalStore({directory:path,gcEnabled:true});await wal.initialize();
  try{await assert.rejects(wal.compact({dryRun:false}),/WAL_GC_TARGET_REGISTRY_INCOMPLETE/);await wal.registerTarget('unknown');assert.ok((await wal.compact()).blocked.some(item=>item.reason==='target_pending'));await wal.retireTarget('unknown','consumer explicitly retired');assert.equal((await wal.compact({dryRun:false})).eligible.length,1);}finally{await wal.close();}
});

test('a new pin between GC eligibility and manifest commit prevents deletion',async()=>{
  const wal=new WalStore({directory:await directory(),segmentMaxBytes:200,gcEnabled:true});await wal.initialize();
  try{
    await wal.registerTarget('a');await wal.append(record(1));const last=await wal.append(record(2));await wal.commit('a',last);await wal.archiveClosedSegments();
    const planGc=wal.state.planGc.bind(wal.state);
    wal.state.planGc=async(segments,operations)=>{await wal.pin({id:'late-pin',owner:'reader',kind:'reader',fromSequence:1,throughSequence:1});await planGc(segments,operations);};
    await assert.rejects(wal.compact({dryRun:false}),/STATE_COMPARE_FAILED/);wal.state.planGc=planGc;
    assert.equal(wal.state.segment(1)?.gcState,'hot');assert.ok((await stat(join(wal.directory,'segment-000000000001.wal'))).size>0);assert.ok((await wal.compact()).blocked.some(item=>item.reason==='pinned'));
  }finally{await wal.close();}
});

test('GC byte accounting preserves concurrently fsynced frames before their index commit',async()=>{
  const wal=new WalStore({directory:await directory(),segmentMaxBytes:200,gcEnabled:true});await wal.initialize();
  let releasePlan=()=>{},releaseIndex=()=>{},planReached=()=>{},indexReached=()=>{};
  const planReady=new Promise<void>(resolve=>{planReached=resolve;}),indexReady=new Promise<void>(resolve=>{indexReached=resolve;});
  const planGate=new Promise<void>(resolve=>{releasePlan=resolve;}),indexGate=new Promise<void>(resolve=>{releaseIndex=resolve;});
  try{
    await wal.registerTarget('a');await wal.append(record(1));const last=await wal.append(record(2));await wal.commit('a',last);await wal.archiveClosedSegments();
    const planGc=wal.state.planGc.bind(wal.state),indexFrame=wal.state.indexFrame.bind(wal.state);
    wal.state.planGc=async(segments,operations)=>{planReached();await planGate;await planGc(segments,operations);};
    wal.state.indexFrame=async(frame,operations)=>{indexReached();await indexGate;return indexFrame(frame,operations);};
    const compacting=wal.compact({dryRun:false});await planReady;
    const appending=wal.append(record(3));await indexReady;releasePlan();await compacting;
    const bytes=(await stat(join(wal.directory,'segment-000000000002.wal'))).size+(await stat(join(wal.directory,'segment-000000000003.wal'))).size;
    assert.equal(wal.totalBytes,bytes);releaseIndex();await appending;assert.equal(wal.totalBytes,bytes);
  }finally{releasePlan();releaseIndex();await wal.close();}
});

test('SIGKILL at frame/state and GC-manifest/unlink boundaries preserves recoverable evidence',async()=>{
  const moduleUrl=new URL('../src/packages/wal/wal.js',import.meta.url).href;
  const env={...process.env};delete env.NODE_TEST_CONTEXT;
  for(const boundary of['before-index','after-index','after-gc-plan','after-unlink']){
    const path=await directory();
    const script=`import {WalStore} from ${JSON.stringify(moduleUrl)};
      const wal=new WalStore({directory:${JSON.stringify(path)},segmentMaxBytes:200,gcEnabled:true});await wal.initialize();
      const record=n=>({kind:'accepted',sourceSystem:'smpp',envelope:{recordId:'r'+n,recordHash:'h'+n}});
      const stop=()=>process.kill(process.pid,'SIGKILL');
      const boundary=${JSON.stringify(boundary)};
      if(boundary==='before-index'||boundary==='after-index'){
        const original=wal.state.indexFrame.bind(wal.state);wal.state.indexFrame=async(...args)=>{if(boundary==='before-index')stop();const result=await original(...args);stop();return result;};await wal.append(record(1));
      }else{
        await wal.registerTarget('a');await wal.append(record(1));const last=await wal.append(record(2));await wal.commit('a',last);await wal.archiveClosedSegments();
        if(boundary==='after-gc-plan'){const original=wal.state.planGc.bind(wal.state);wal.state.planGc=async(...args)=>{await original(...args);stop();};}
        else{const original=wal.state.saveSegment.bind(wal.state);wal.state.saveSegment=async(segment)=>{if(segment.gcState==='complete')stop();await original(segment);};}
        await wal.compact({dryRun:false});
      }`;
    const child=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout:10000,env});assert.equal(child.signal,'SIGKILL',`${boundary}: ${child.stderr}`);
    const wal=new WalStore({directory:path,gcEnabled:true});await wal.initialize();
    try{assert.equal(wal.classify('smpp','r1','h1'),'duplicate');assert.equal(wal.readEntries(0,1)[0]!.ingestSequence,1);if(boundary.startsWith('after-gc')||boundary==='after-unlink')assert.equal(wal.pendingCount('a'),0);}finally{await wal.close();}
  }
});

test('SIGKILL during archive copy, fsync and rename never makes unregistered archives eligible for deletion',async()=>{
  const moduleUrl=new URL('../src/packages/wal/wal.js',import.meta.url).href,archiveUrl=new URL('../src/packages/wal/archive.js',import.meta.url).href;
  const env={...process.env};delete env.NODE_TEST_CONTEXT;
  for(const boundary of['copied','file_synced','renamed','directory_synced']){
    const path=await directory(),script=`import {WalStore} from ${JSON.stringify(moduleUrl)};import {archiveSegment} from ${JSON.stringify(archiveUrl)};import {join} from 'node:path';
      const wal=new WalStore({directory:${JSON.stringify(path)},segmentMaxBytes:200,gcEnabled:true});await wal.initialize();await wal.registerTarget('a');
      const record=n=>({kind:'accepted',sourceSystem:'smpp',envelope:{recordId:'r'+n,recordHash:'h'+n}});await wal.append(record(1));const last=await wal.append(record(2));await wal.commit('a',last);
      await archiveSegment(join(wal.directory,'segment-000000000001.wal'),join(wal.archiveDirectory,wal.walEpoch),'segment-000000000001.wal',async phase=>{if(phase===${JSON.stringify(boundary)})process.kill(process.pid,'SIGKILL');});`;
    const child=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout:10000,env});assert.equal(child.signal,'SIGKILL',`${boundary}: ${child.stderr}`);
    const wal=new WalStore({directory:path,gcEnabled:true});await wal.initialize();
    try{assert.equal(wal.state.segment(1)?.gcState,'hot');assert.equal(wal.state.segment(1)?.archivePath,null);assert.equal(wal.pendingCount('a'),0);assert.equal(wal.readEntries(0,1)[0]!.record.sourceSystem,'smpp');await wal.archiveClosedSegments();assert.equal((await wal.compact({dryRun:false})).eligible.length,1);assert.equal(wal.classify('smpp','r1','h1'),'duplicate');}finally{await wal.close();}
  }
});
