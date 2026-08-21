// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WalStore} from '../src/packages/wal/wal.js';

async function append(wal,envelope){
  return wal.appendClassified({
    sourceSystem:'smpp',recordId:envelope.recordId,recordHash:envelope.recordHash,
    acceptedRecord:{kind:'accepted',sourceSystem:'smpp',envelope},
    conflictRecord:()=>({kind:'conflict',sourceSystem:'smpp',envelope})
  });
}
function event(index,overrides={}){
  return {recordId:`record-${index}`,recordHash:String(index).padStart(64,'0'),recordType:'provider.business_event.source.lifecycle',providerId:'provider-1',instanceId:'instance-1',providerEventId:'event-stream-1',providerEventSequence:index,payload:{currentState:'accepted'},...overrides};
}

test('WAL preserves sequence gap/out-of-order quality and blocks same-sequence content conflicts',async()=>{
  const wal=new WalStore({directory:await mkdtemp(join(tmpdir(),'wal-provider-quality-'))});await wal.initialize();
  assert.equal((await append(wal,event(1))).entry.record.providerQuality.status,'accepted');
  assert.deepEqual((await append(wal,event(3))).entry.record.providerQuality.reasonCodes,['SMPP_PROVIDER_EVENT_SEQUENCE_GAP']);
  assert.deepEqual((await append(wal,event(2))).entry.record.providerQuality.reasonCodes,['SMPP_PROVIDER_EVENT_OUT_OF_ORDER']);
  const conflict=await append(wal,event(4,{providerEventSequence:3,recordHash:'f'.repeat(64)}));
  assert.equal(conflict.classification,'semantic_conflict');
  assert.equal(conflict.semanticCode,'SMPP_PROVIDER_EVENT_SEQUENCE_CONFLICT');
});

test('WAL blocks revision and mutually exclusive terminal conflicts',async()=>{
  const wal=new WalStore({directory:await mkdtemp(join(tmpdir(),'wal-provider-revision-'))});await wal.initialize();
  const base={recordType:'provider.task.lifecycle',providerId:'provider-1',instanceId:'instance-1',taskId:'task-1'};
  await append(wal,event(1,{...base,payload:{providerRevision:'7',terminalStatus:'completed'}}));
  const revision=await append(wal,event(2,{...base,payload:{providerRevision:'7'},recordHash:'e'.repeat(64)}));
  assert.equal(revision.semanticCode,'SMPP_PROVIDER_REVISION_CONFLICT');
  const terminal=await append(wal,event(3,{...base,payload:{providerRevision:'8',terminalStatus:'failed'},recordHash:'d'.repeat(64)}));
  assert.equal(terminal.semanticCode,'SMPP_PROVIDER_TERMINAL_CONFLICT');
});
