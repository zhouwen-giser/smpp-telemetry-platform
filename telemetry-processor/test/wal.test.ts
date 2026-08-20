import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,appendFile,mkdir,readdir,rename,rmdir,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {WalStore} from '../src/packages/wal/wal.js';test('WAL has independent checkpoints',async()=>{const d=await mkdtemp(join(tmpdir(),'wal-'));const w=new WalStore({directory:d,segmentMaxBytes:1024});await w.initialize();const e=await w.append({kind:'accepted',sourceSystem:'smpp',envelope:{recordId:'r1',recordHash:'h1'}});assert.equal(w.pending('a').length,1);assert.equal(w.pending('b').length,1);await w.commit('a',e);assert.equal(w.pending('a').length,0);assert.equal(w.pending('b').length,1);});test('WAL recovers and truncates partial tail',async()=>{const d=await mkdtemp(join(tmpdir(),'wal-'));let w=new WalStore({directory:d});await w.initialize();await w.append({kind:'accepted',sourceSystem:'smpp',envelope:{recordId:'r1',recordHash:'h1'}});await appendFile(join(d,'segment-000000000001.wal'),Buffer.from([0,0,0]));w=new WalStore({directory:d});await w.initialize();assert.equal(w.classify('smpp','r1','h1'),'duplicate');assert.equal(w.entries.length,1);});

test('concurrent appends retain call order and monotonic WAL offsets',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'wal-concurrent-'));
  let wal=new WalStore({directory});
  await wal.initialize();
  const entries=await Promise.all(Array.from({length:32},(_,sequence)=>wal.append({kind:'test',sequence})));
  assert.deepEqual(entries.map(entry=>entry.record.sequence),Array.from({length:32},(_,sequence)=>sequence));
  for(let index=1;index<entries.length;index++){
    assert.equal(entries[index]!.segment,entries[index-1]!.segment);
    assert.equal(entries[index]!.offset,entries[index-1]!.offsetEnd);
  }
  wal=new WalStore({directory});
  await wal.initialize();
  assert.deepEqual(wal.entries.map(entry=>entry.record.sequence),Array.from({length:32},(_,sequence)=>sequence));
});

test('concurrent target commits merge checkpoints and survive reopen',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'wal-checkpoints-'));
  let wal=new WalStore({directory});
  await wal.initialize();
  const first=await wal.append({kind:'test',sequence:1});
  const second=await wal.append({kind:'test',sequence:2});
  await Promise.all([wal.commit('target:a',first),wal.commit('target:b',second)]);
  assert.deepEqual(Object.keys(wal.checkpoints).sort(),['target:a','target:b']);
  assert.equal(wal.pending('target:a').length,1);
  assert.equal(wal.pending('target:b').length,0);
  assert.equal((await readdir(directory)).filter(name=>name.startsWith('checkpoints.')&&name.endsWith('.tmp')).length,0);
  wal=new WalStore({directory});
  await wal.initialize();
  assert.deepEqual(Object.keys(wal.checkpoints).sort(),['target:a','target:b']);
  assert.equal(wal.pending('target:a').length,1);
  assert.equal(wal.pending('target:b').length,0);
});

test('a target checkpoint never moves backward when commits arrive out of order',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'wal-monotonic-checkpoint-'));
  let wal=new WalStore({directory});
  await wal.initialize();
  const first=await wal.append({kind:'test',sequence:1});
  const second=await wal.append({kind:'test',sequence:2});
  await Promise.all([wal.commit('target:a',second),wal.commit('target:a',first)]);
  assert.deepEqual(wal.checkpoint('target:a'),{segment:second.segment,offsetEnd:second.offsetEnd,updatedAt:wal.checkpoint('target:a').updatedAt});
  assert.equal(wal.pending('target:a').length,0);
  wal=new WalStore({directory});
  await wal.initialize();
  assert.equal(wal.checkpoint('target:a').offsetEnd,second.offsetEnd);
  assert.equal(wal.pending('target:a').length,0);
});

test('the WAL write queue rejects above its configured capacity',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'wal-bounded-queue-'));
  const wal=new WalStore({directory,maxPendingWrites:1});
  await wal.initialize();
  const first=wal.append({kind:'test',sequence:1});
  await assert.rejects(wal.append({kind:'test',sequence:2}),{message:'WAL_WRITE_QUEUE_FULL'});
  await first;
  assert.equal(wal.stats().pendingWrites,0);
  assert.equal(wal.entries.length,1);
});

test('checkpoint corruption fails startup closed',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'wal-invalid-checkpoint-'));
  let wal=new WalStore({directory});
  await wal.initialize();
  await writeFile(join(directory,'checkpoints.json'),'{not-json','utf8');
  wal=new WalStore({directory});
  await assert.rejects(wal.initialize(),{message:'WAL_CHECKPOINT_INVALID'});
});

test('a checkpoint outside a real WAL frame boundary fails startup closed',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'wal-checkpoint-boundary-'));
  let wal=new WalStore({directory});
  await wal.initialize();
  await wal.append({kind:'test',sequence:1});
  await writeFile(join(directory,'checkpoints.json'),JSON.stringify({'target:a':{segment:999,offsetEnd:1}}),'utf8');
  wal=new WalStore({directory});
  await assert.rejects(wal.initialize(),{message:'WAL_CHECKPOINT_INVALID'});
});

test('a failed append poisons the store and drain fails closed',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'wal-poison-')),segment=join(directory,'segment-000000000001.wal'),backup=join(directory,'segment.backup');
  const wal=new WalStore({directory});
  await wal.initialize();
  await rename(segment,backup);await mkdir(segment);
  try{
    await assert.rejects(wal.append({kind:'test',sequence:1}),{message:'WAL_WRITE_FAILED_RESTART_REQUIRED'});
    assert.equal(wal.stats().writeFailed,true);
    await assert.rejects(wal.drain(),{message:'WAL_WRITE_FAILED_RESTART_REQUIRED'});
    await assert.rejects(wal.append({kind:'test',sequence:2}),{message:'WAL_WRITE_FAILED_RESTART_REQUIRED'});
  }finally{await rmdir(segment);await rename(backup,segment);}
});
