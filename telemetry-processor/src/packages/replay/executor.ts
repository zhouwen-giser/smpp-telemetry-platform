import { TargetWorker, type ProjectionClient, type ProjectionTarget } from '../exporters/target-manager.js';
import { ClickHouseClient } from '../exporters/clickhouse.js';
import { Metrics } from '../metrics/metrics.js';
import { asTelemetryEntry, type WalStore } from '../wal/wal.js';
import { calculateProviderOpsRecordHash, sha256Canonical } from '../canonical/canonical.js';
import { validateEnvelope } from '../validation/validation.js';
import { projectionTimestamp } from '../validation/timestamp.js';
import type { ReplayExecutor, ReplayJob } from './replay.js';
import { outputPlanKey, type OutputPlan } from '../exporters/output-plan.js';
import type { StateOperation } from '../durable-state/types.js';

const databases=(target:ProjectionTarget):string[]=>target.targetType==='sdar_shared_warehouse'?['sdar_core']:['telemetry_landing','telemetry_normalized','telemetry_core','telemetry_meta'];
const endpoint=(target:ProjectionTarget):string=>{if(!target.connection.url)throw new Error('REPLAY_TARGET_ENDPOINT_REQUIRED');const url=new URL(target.connection.url);url.username='';url.password='';url.hash='';return url.toString().replace(/\/$/u,'');};
export function assertGenerationIsolation(job:ReplayJob,targets:ProjectionTarget[],liveTargets:ProjectionTarget[]):void{
  if(!liveTargets.length)throw new Error('REPLAY_LIVE_TARGET_INVENTORY_REQUIRED');
  if(JSON.stringify(targets.map(t=>t.targetId).sort())!==JSON.stringify([...job.plan.request.targetIds].sort()))throw new Error('REPLAY_TARGET_SET_MISMATCH');
  const liveIds=new Set(liveTargets.map(target=>target.targetId)),liveEndpoints=new Set(liveTargets.map(endpoint));
  for(const target of targets){
    if(!target.enabled||target.generation!==job.plan.request.generation||liveIds.has(target.targetId))throw new Error('REPLAY_GENERATION_ISOLATION_REQUIRED');
    // All side outputs, including metadata and DLQ mirrors, must stay on the isolated instance.
    if(liveEndpoints.has(endpoint(target))||Object.keys(target.tableMap??{}).length)throw new Error('REPLAY_ISOLATED_INSTANCE_REQUIRED');
  }
}
function createClient(target:ProjectionTarget):ProjectionClient{if(!target.connection.url)throw new Error('REPLAY_TARGET_ENDPOINT_REQUIRED');return new ClickHouseClient({...target.connection,url:target.connection.url});}
async function databaseIdentities(client:ProjectionClient,target:ProjectionTarget):Promise<string[]>{
  if(!client.query)throw new Error('REPLAY_ISOLATION_PROBE_REQUIRED');
  const names=databases(target),result:unknown=JSON.parse(await client.query(`SELECT name,toString(uuid) AS uuid FROM system.databases WHERE name IN (${names.map(name=>`'${name}'`).join(',')}) FORMAT JSON`));
  if(result===null||typeof result!=='object'||!('data'in result)||!Array.isArray(result.data))throw new Error('REPLAY_ISOLATION_PROBE_INVALID');
  const rows=result.data as Array<Record<string,unknown>>;
  if(rows.length!==names.length||rows.some(row=>typeof row.uuid!=='string'||!row.uuid||row.uuid==='00000000-0000-0000-0000-000000000000'))throw new Error('REPLAY_DATABASE_IDENTITY_UNAVAILABLE');
  return rows.map(row=>String(row.uuid));
}
export async function createReplayExecutor({wal,job,targets,liveTargets,clientFactory=createClient}:{wal:WalStore;job:ReplayJob;targets:ProjectionTarget[];liveTargets:ProjectionTarget[];clientFactory?:(target:ProjectionTarget)=>ProjectionClient}):Promise<ReplayExecutor>{
  assertGenerationIsolation(job,targets,liveTargets);
  const liveUuids=new Set<string>();
  for(const target of liveTargets){const client=clientFactory(target);await client.initialize();for(const uuid of await databaseIdentities(client,target))liveUuids.add(uuid);}
  const workers:TargetWorker[]=[];
  const targetIdentities:Array<{targetId:string;databaseUuids:string[]}>=[];
  for(const target of targets){
    const client=clientFactory(target);await client.initialize();const databaseUuids=await databaseIdentities(client,target);if(databaseUuids.some(uuid=>liveUuids.has(uuid)))throw new Error('REPLAY_LIVE_DATABASE_ALIAS');targetIdentities.push({targetId:target.targetId,databaseUuids});
    const worker=new TargetWorker({target,wal,metrics:new Metrics(),client});
    if(worker.normalizer.normalizerVersion!==job.plan.request.normalizerVersion||worker.projection.projectionVersion!==job.plan.request.projectionVersion)throw new Error('REPLAY_IMPLEMENTATION_VERSION_UNAVAILABLE');
    workers.push(worker);
  }
  const describe=(target:ProjectionTarget)=>({targetId:target.targetId,targetType:target.targetType,generation:target.generation??'legacy',endpointHash:sha256Canonical(endpoint(target)),routeIds:target.routeIds??[target.targetId],acceptAllMappings:target.acceptAllMappings??false,writeLayers:target.writeLayers});
  const contract={manifestHash:job.plan.manifestHash,generation:job.plan.request.generation,targets:targets.map(describe),liveTargets:liveTargets.map(describe),targetIdentities};
  const prior=wal.state.get('replay:contracts',job.id);if(prior!==undefined&&sha256Canonical(prior)!==sha256Canonical(contract))throw new Error('REPLAY_TARGET_CONTRACT_CHANGED');
  const owner={jobId:job.id,manifestHash:job.plan.manifestHash};
  const ownerKeys=targets.map(target=>JSON.stringify([target.targetId,job.plan.request.generation,wal.walEpoch]));
  const operations:StateOperation[]=[];
  for(const key of ownerKeys){
    const previous=wal.state.get<{jobId:string;manifestHash:string}>('replay:target-owner',key);
    if(previous!==undefined&&(previous.jobId!==owner.jobId||previous.manifestHash!==owner.manifestHash))throw new Error('REPLAY_GENERATION_ALREADY_BOUND');
    operations.push({type:'check',namespace:'replay:target-owner',key,expected:previous??null},{type:'put',namespace:'replay:target-owner',key,value:owner});
  }
  operations.push({type:'check',namespace:'replay:contracts',key:job.id,expected:prior??null},{type:'put',namespace:'replay:contracts',key:job.id,value:contract});
  try{await wal.state.transaction(operations);}
  catch(error){
    // Simultaneous setup for the same job converges on exactly the same contract.
    const currentOwners=ownerKeys.map(key=>wal.state.get('replay:target-owner',key));
    if(currentOwners.some(value=>value!==undefined&&sha256Canonical(value)!==sha256Canonical(owner)))throw new Error('REPLAY_GENERATION_ALREADY_BOUND');
    if(!currentOwners.every(value=>value!==undefined&&sha256Canonical(value)===sha256Canonical(owner))||sha256Canonical(wal.state.get('replay:contracts',job.id)??null)!==sha256Canonical(contract))throw error;
  }
  // This binding is specific to replay admission; promoted live TargetWorkers do
  // not consult it and may continue writing the generation after activation.
  for(const worker of workers)await worker.initialize();
  return{
    validate:async(raw,current)=>{
      if(current.plan.walEpoch!==wal.walEpoch||current.plan.manifestHash!==job.plan.manifestHash)throw new Error('REPLAY_SOURCE_IDENTITY_CHANGED');
      const entry=asTelemetryEntry(raw);if(entry.record.kind==='rejected')return;
      const{envelope,mapping}=entry.record;
      if(calculateProviderOpsRecordHash(envelope)!==envelope.recordHash)throw new Error('REPLAY_SOURCE_HASH_MISMATCH');
      const attributes={'sdar.record.id':envelope.recordId,'sdar.record.hash':envelope.recordHash,'sdar.schema.name':envelope.schemaName,'sdar.schema.version':envelope.schemaVersion};
      let result=validateEnvelope(envelope,attributes);
      // Historical accepted frames already passed the receiver that allowed UTC
      // text dates. Verify their original hash above and never alter stored/output
      // bytes; this temporary view only runs the remaining current validations.
      if(!result.ok&&result.code==='TIMESTAMP_INVALID'&&entry.record.kind==='accepted'){
        try{
          const view={...envelope,occurredAt:projectionTimestamp(envelope.occurredAt),emittedAt:projectionTimestamp(envelope.emittedAt)};
          view.recordHash=calculateProviderOpsRecordHash(view);
          result=validateEnvelope(view,{...attributes,'sdar.record.hash':view.recordHash});
        }catch{throw new Error('REPLAY_CONTRACT_INVALID:TIMESTAMP_INVALID');}
      }
      if(!result.ok)throw new Error(`REPLAY_CONTRACT_INVALID:${result.code}`);
      if(mapping.mappingVersion!==current.plan.request.mappingVersion||mapping.policyVersion!==current.plan.request.policyVersion)throw new Error('REPLAY_MAPPING_VERSION_MISMATCH');
    },
    project:async(entry)=>{
      let disposition:'projected'|'quarantined'|'not-routed'='not-routed';
      for(const worker of workers){
        const result=await worker.projectReplayEntry(entry);
        if(result==='projected'){
          const key=outputPlanKey(worker.target.targetId,worker.generation,entry),plan=wal.state.get<OutputPlan>('plan',key);
          if(!plan||plan.completedOutputs!==plan.outputs.length)throw new Error('REPLAY_OUTPUT_PLAN_INCOMPLETE');
          const publication=worker.target.targetType==='sdar_shared_warehouse'?'insert_confirmed':wal.state.get('snapshot:done',key)===true?'snapshot_published':'insert_confirmed';
          await wal.state.put('replay:output-evidence',`${job.id}/${worker.target.targetId}/${entry.ingestSequence}`,{targetId:worker.target.targetId,generation:worker.generation,walEpoch:entry.walEpoch,ingestSequence:entry.ingestSequence,planKey:key,revisionKeys:plan.outputs.map(output=>output.revisionKey),publication,verifiedAt:new Date().toISOString()});
        }
        if(result==='quarantined')disposition='quarantined';else if(result==='projected'&&disposition!=='quarantined')disposition='projected';
      }
      return disposition;
    }
  };
}
