import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WalStore, type WalEntry } from '../src/packages/wal/wal.js';
import { TargetProgressLedger } from '../src/packages/exporters/progress-ledger.js';
import { outputPlanKey } from '../src/packages/exporters/output-plan.js';
import { progressResponse } from '../../telemetry-dashboard/query-api/src/progress.js';
import { envelope } from './helpers.js';

const now='2026-09-07T12:00:00Z';
async function append(wal:WalStore,tenantId:string,factType='TaskLifecycleChanged'):Promise<WalEntry>{return wal.append({kind:'accepted',sourceSystem:'smpp',receivedAt:'2026-09-07T11:59:00Z',mapping:{tenantId,projectId:'p',environment:'test',smppSourceId:'s'},trustedContext:{deploymentId:'game'},envelope:envelope({recordId:randomUUID(),recordType:factType})});}
async function dispose(wal:WalStore,ledger:TargetProgressLedger,entry:WalEntry,kind:'projected'|'quarantined'|'not-routed'){
  await wal.commit('target:test',entry,{operations:[...ledger.dispositionOperations(entry,kind),{type:'put',namespace:'disposition',key:outputPlanKey('test','g1',entry),value:kind}]});
}

test('durable scoped progress separates tenant and fact type and survives restart without duplicate counts',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'scope-ledger-'));let wal=new WalStore({directory});await wal.initialize();await wal.registerTarget('target:test',{generation:'g1'});
  let ledger=new TargetProgressLedger(wal,'test','g1');
  const a=await append(wal,'a'),b=await append(wal,'b'),c=await append(wal,'a','ResourceStateChanged');
  await ledger.indexInputs();await dispose(wal,ledger,a,'projected');await dispose(wal,ledger,b,'quarantined');
  let rows=ledger.rows({version:1,visibleThrough:a.ingestSequence,now}).rows;
  assert.equal(rows.length,3);
  const lookup=(tenant:string,type:string)=>rows.find(row=>row.tenant_id===tenant&&row.fact_type===type)!;
  assert.equal(progressResponse({...lookup('a','TaskLifecycleChanged')},Date.parse(now)).completeness,'caught_up');
  assert.equal(progressResponse({...lookup('b','TaskLifecycleChanged')},Date.parse(now)).completenessReason,'PUBLICATION_PENDING');
  assert.equal(progressResponse({...lookup('a','ResourceStateChanged')},Date.parse(now)).projectionLagMs,60000);
  await wal.close();wal=new WalStore({directory});await wal.initialize();ledger=new TargetProgressLedger(wal,'test','g1');
  try{
    await ledger.indexInputs();await dispose(wal,ledger,c,'not-routed');
    rows=ledger.rows({version:2,visibleThrough:c.ingestSequence,now}).rows;
    assert.equal(rows.reduce((sum,row)=>sum+Number(row.accepted),0),3);
    assert.equal(progressResponse({...lookup('b','TaskLifecycleChanged')},Date.parse(now)).completeness,'caught_up_with_quarantine');
    assert.equal(lookup('a','ResourceStateChanged').not_routed,1);
    assert.ok(rows.every(row=>row.pending===0));
  }finally{await wal.close();}
});

test('bounded scope mirror is unknown until all known inputs are indexed and rebuilds prior durable dispositions',async()=>{
  const wal=new WalStore({directory:await mkdtemp(join(tmpdir(),'scope-bounded-'))});await wal.initialize();
  try{
    await wal.registerTarget('target:test',{generation:'g1'});const entries=[await append(wal,'a'),await append(wal,'a'),await append(wal,'b')];
    const ledger=new TargetProgressLedger(wal,'test','g1');
    await dispose(wal,ledger,entries[0]!,'projected');await dispose(wal,ledger,entries[1]!,'quarantined');
    await ledger.indexInputs(1);
    let rows=ledger.rows({version:1,visibleThrough:2,now}).rows;assert.equal(rows[0]!.coverage_status,'unknown');
    await ledger.indexInputs(1);await ledger.indexInputs(1);
    rows=ledger.rows({version:2,visibleThrough:2,now}).rows;
    const a=rows.find(row=>row.tenant_id==='a')!,b=rows.find(row=>row.tenant_id==='b')!;
    assert.deepEqual([a.accepted,a.projected,a.quarantined,a.pending],[2,1,1,0]);assert.equal(a.coverage_status,'exact');assert.equal(b.pending,1);
    const page=ledger.rows({version:3,visibleThrough:2,now,limit:1});assert.equal(page.hasMore,true);assert.ok(page.lastKey);
    const next=ledger.rows({version:3,visibleThrough:2,now,limit:1,after:page.lastKey});assert.equal(next.hasMore,false);assert.notEqual(page.rows[0]!.tenant_id,next.rows[0]!.tenant_id);
  }finally{await wal.close();}
});

test('legacy consumed inputs without dispositions cannot be reported as exact scoped progress',async()=>{
  const wal=new WalStore({directory:await mkdtemp(join(tmpdir(),'scope-legacy-'))});await wal.initialize();
  try{await wal.registerTarget('target:test',{generation:'g1'});const entry=await append(wal,'a');await wal.commit('target:test',entry);const ledger=new TargetProgressLedger(wal,'test','g1');await ledger.indexInputs();const row=ledger.rows({version:1,visibleThrough:1,now}).rows[0]!;assert.equal(row.coverage_status,'legacy');assert.equal(row.projected,null);assert.equal(progressResponse({...row},Date.parse(now)).completeness,'legacy_best_known');}
  finally{await wal.close();}
});

test('scope indexing cannot overwrite a disposition committed between reading and updating the bucket',async()=>{
  const wal=new WalStore({directory:await mkdtemp(join(tmpdir(),'scope-race-'))});await wal.initialize();
  try{
    await wal.registerTarget('target:test',{generation:'g1'});const first=await append(wal,'a'),ledger=new TargetProgressLedger(wal,'test','g1');await ledger.indexInputs();await append(wal,'a');
    const transaction=wal.state.transaction.bind(wal.state);let intercepted=false;
    wal.state.transaction=async operations=>{
      if(!intercepted&&operations.some(op=>op.namespace==='progress:indexed')){intercepted=true;await dispose(wal,ledger,first,'projected');}
      return transaction(operations);
    };
    await assert.rejects(ledger.indexInputs(),/STATE_COMPARE_FAILED/);await ledger.indexInputs();
    const row=ledger.rows({version:1,visibleThrough:1,now}).rows[0]!;
    assert.deepEqual([row.accepted,row.projected,row.quarantined,row.pending],[2,1,0,1]);
  }finally{await wal.close();}
});
