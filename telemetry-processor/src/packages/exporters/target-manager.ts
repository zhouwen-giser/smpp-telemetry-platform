import { SnapshotPublisher } from './snapshot-publisher.js';
import { TargetProgressLedger } from './progress-ledger.js';
import { isRecord, type TelemetryWalRecord } from '../../../../packages/telemetry-types/src/index.js';
import { readFile } from 'node:fs/promises';
import { ClickHouseClient, landingRow, canonicalRow, type ClickHouseConnection } from './clickhouse.js';
import { SmppProviderOpsNormalizerV1 } from '../normalization/smpp-provider-ops-v1.js';
import { CoreProjectionV1 } from '../projection/core-projection.js';
import {SdarSharedWarehouseProjectionV1,SdarWarehouseSchemaPreflight} from '../projection/sdar-shared-warehouse-projection.js';

import { projectionTimestamp } from '../validation/timestamp.js';
import { sqlIdentifier } from './standalone-schema.js';
import { uuidV5 } from '../canonical/canonical.js';
import { outputPlanKey, outputRevisionKey, deadLetterId, deterministicRecordError, DeterministicRecordError, type OutputPlan, type ProjectionDeadLetter, type ProjectionRow } from './output-plan.js';
import { asTelemetryEntry, type WalEntry, type WalStore } from '../wal/wal.js';
import type { Metrics } from '../metrics/metrics.js';

const PARTITION_TIME_FIELDS:Readonly<Record<string,string>>=Object.freeze({
  'telemetry_landing.smpp_provider_ops_v1':'occurred_at',
  'telemetry_landing.smpp_provider_ops_conflict_v1':'received_at',
  'telemetry_landing.smpp_provider_ops_rejected_summary_v1':'received_at',
  'telemetry_normalized.canonical_fact_v1':'occurred_at',
  'telemetry_core.entity_relation_fact':'valid_from'
});
const HASH_PARTITIONED_TABLES=new Set([
  'sdar_core.external_provider_fact',
  'sdar_core.external_entity_relation_fact'
]);
const MAX_HASH_PARTITION_ROWS_PER_INSERT=100;

function partitionTimeField(table:string){
  return PARTITION_TIME_FIELDS[table]??(table.startsWith('telemetry_core.')?'occurred_at':null);
}

export function partitionRowsForInsert<T extends ProjectionRow>(table:string,rows:readonly T[]):T[][]{
  if(HASH_PARTITIONED_TABLES.has(table)){
    const blocks=[];
    for(let index=0;index<rows.length;index+=MAX_HASH_PARTITION_ROWS_PER_INSERT)blocks.push(rows.slice(index,index+MAX_HASH_PARTITION_ROWS_PER_INSERT));
    return blocks;
  }
  const field=partitionTimeField(table);
  if(field===null)return [[...rows]];
  const partitions=new Map<string,T[]>();
  for(const row of rows){
    const value=row[field];
    const key=projectionTimestamp(value).slice(0,7);
    if(!partitions.has(key))partitions.set(key,[]);
    partitions.get(key)!.push(row);
  }
  return [...partitions.values()];
}

export async function loadProjectionTargets(file:string):Promise<ProjectionTarget[]> {
  const data:unknown=JSON.parse(await readFile(file,'utf8'));
  if(!isRecord(data)||!Array.isArray(data.targets)||!data.targets.length)throw new Error('PROJECTION_TARGETS_INVALID');
  const ids=new Set<string>();
  for(const target of data.targets){
    if(!isRecord(target)||typeof target.targetId!=='string'||!/^[-a-zA-Z0-9_.:]{1,128}$/.test(target.targetId)||ids.has(target.targetId)||typeof target.enabled!=='boolean'||typeof target.targetType!=='string'||!['standalone','shadow','standalone_smpp_clickhouse','sdar_shared_warehouse'].includes(target.targetType))throw new Error('PROJECTION_TARGETS_INVALID');
    ids.add(target.targetId);
    if(!Array.isArray(target.writeLayers)||!target.writeLayers.length||target.writeLayers.some(layer=>!['landing','normalized','core','relation'].includes(layer)))throw new Error('PROJECTION_LAYERS_INVALID');
    if(target.targetType==='sdar_shared_warehouse'&&target.writeLayers.some(layer=>!['core','relation'].includes(layer)))throw new Error('SHARED_PROJECTION_LAYERS_INVALID');
    if(target.generation!==undefined&&(typeof target.generation!=='string'||!/^[-a-zA-Z0-9_.]{1,128}$/.test(target.generation)))throw new Error('PROJECTION_GENERATION_INVALID');
    if(!isRecord(target.connection)||typeof target.connection.url!=='string'||!['http:','https:'].includes(new URL(target.connection.url).protocol))throw new Error('TARGET_CONNECTION_URL_REQUIRED');
    for(const key of ['required','acceptAllMappings','snapshotEnabled'])if(target[key]!==undefined&&typeof target[key]!=='boolean')throw new Error('PROJECTION_TARGET_OPTION_INVALID');
    if(target.routeIds!==undefined&&(!Array.isArray(target.routeIds)||target.routeIds.some(route=>typeof route!=='string'||!route)))throw new Error('PROJECTION_ROUTES_INVALID');
    if(target.tableMap!==undefined){if(!isRecord(target.tableMap)||Object.values(target.tableMap).some(value=>typeof value!=='string'))throw new Error('PROJECTION_TABLE_MAP_INVALID');for(const value of Object.values(target.tableMap))sqlIdentifier(String(value));}
  }
  return data.targets as ProjectionTarget[];
}

function processorProjectedAt(value: string, entries: readonly WalEntry[]): string {
  if(!value.endsWith('Z')||!Number.isFinite(Date.parse(value)))throw new Error('PROCESSOR_PROJECTION_TIME_INVALID');
  for(const entry of entries){
    const receivedAt=entry.record.receivedAt;
    if(typeof receivedAt!=='string'||!Number.isFinite(Date.parse(receivedAt)))throw new Error('PROCESSOR_RECEIVED_TIME_INVALID');
    if(Date.parse(value)<Date.parse(receivedAt))throw new Error('PROCESSOR_PROJECTION_CLOCK_BEFORE_RECEIVE');
  }
  return value;
}

export interface ProjectionTarget {
  targetId: string; targetType: string; enabled: boolean; required?: boolean; generation?: string; snapshotEnabled?:boolean; snapshotRetentionDays?:number;
  acceptAllMappings?: boolean; routeIds?: string[]; writeLayers: string[];
  connection: Partial<ClickHouseConnection>; tableMap?: Record<string,string>;
}
export interface ProjectionClient {
  initialize(): Promise<void>; ping(): Promise<unknown>;
  insert(table: string, rows: readonly ProjectionRow[]): Promise<void>;
  query?(sql: string): Promise<string>;
  preflightWritePermissions?(tables:readonly string[]):Promise<void>;
  preflightStandalone?(target: ProjectionTarget): Promise<void>;
}
interface Projection { projectionId: string; projectionVersion: number; project(fact: ReturnType<SmppProviderOpsNormalizerV1['normalize']>[number]): Array<{table:string;row:ProjectionRow}> }
interface Clock {now():string}
interface SchemaPreflight {assert(client: ProjectionClient): Promise<unknown>}
interface WorkerOptions {
  target:ProjectionTarget; wal:WalStore; metrics:Metrics; client:ProjectionClient;
  normalizer?:SmppProviderOpsNormalizerV1; projection?:Projection; batchSize?:number;
  schemaPreflight?:SchemaPreflight; clock?:Clock;
}
const DATE_FIELDS = new Set(['occurred_at','emitted_at','received_at','ingested_at','normalized_at','projected_at','observed_at','created_at','valid_from','valid_to']);
function normalizedRow(row: ProjectionRow): ProjectionRow {
  return Object.fromEntries(Object.entries(row).map(([key,value])=>[key,DATE_FIELDS.has(key)&&value!==null?projectionTimestamp(value):value]));
}

export class TargetWorker {
  readonly target:ProjectionTarget; readonly wal:WalStore; readonly metrics:Metrics; readonly client:ProjectionClient;
  readonly normalizer:SmppProviderOpsNormalizerV1; readonly projection:Projection; readonly batchSize:number;
  readonly clock:Clock; readonly checkpointId:string; readonly generation:string;
  readonly progressLedger:TargetProgressLedger;
  retryFailures=0;nextAttemptAt=0;
  publisher:SnapshotPublisher|undefined;schemaPreflight:SchemaPreflight; running=false; initialized=false; lastError:Error|null=null;
  constructor({target,wal,metrics,client,normalizer=new SmppProviderOpsNormalizerV1(),projection,batchSize=200,schemaPreflight=new SdarWarehouseSchemaPreflight(),clock={now:()=>new Date().toISOString()}}:WorkerOptions) {
    this.target=target;this.wal=wal;this.metrics=metrics;this.client=client;
    if(target.targetType==='sdar_shared_warehouse'&&Object.keys(target.tableMap??{}).length)throw new Error('SMPP_TARGET_TABLE_MAP_FORBIDDEN');
    this.normalizer=normalizer;this.projection=projection??(target.targetType==='sdar_shared_warehouse'?new SdarSharedWarehouseProjectionV1():new CoreProjectionV1());
    this.schemaPreflight=schemaPreflight;this.batchSize=batchSize;this.clock=clock;
    this.generation=target.generation??'legacy';this.checkpointId=`target:${target.targetId}`;
    this.progressLedger=new TargetProgressLedger(wal,target.targetId,this.generation);
  }
  async initialize(){
    await this.wal.registerTarget(this.checkpointId,{generation:this.generation});
    if(this.wal.state.get('target:counts-coverage',this.checkpointId)===undefined)await this.wal.state.put('target:counts-coverage',this.checkpointId,this.wal.checkpointSequence(this.checkpointId)===0?'exact':'legacy');
    await this.client.initialize();
    if(this.target.targetType==='sdar_shared_warehouse'){await this.schemaPreflight.assert(this.client);await this.client.preflightWritePermissions?.([...(this.target.writeLayers.includes('core')?['sdar_core.external_provider_fact']:[]),...(this.target.writeLayers.includes('relation')?['sdar_core.external_entity_relation_fact']:[])]);}
    else await this.client.preflightStandalone?.(this.target);
    if(this.target.snapshotEnabled){if(this.target.targetType==='sdar_shared_warehouse')throw new Error('SNAPSHOT_DIAGNOSTIC_STORE_REQUIRED');this.publisher=new SnapshotPublisher(this.wal,this.client,this.target.targetId,this.generation,this.target.snapshotRetentionDays??7);await this.publisher.initialize(this.checkpointId);}
    this.initialized=true;this.lastError=null;
  }
  private prepare(entry:WalEntry<TelemetryWalRecord>):OutputPlan {
    const projectedAt=processorProjectedAt(this.clock.now(),[entry]);
    const plan:OutputPlan={version:1,targetId:this.target.targetId,generation:this.generation,walEpoch:entry.walEpoch,ingestSequence:entry.ingestSequence,projectedAt,
      normalizerId:this.normalizer.normalizerId,normalizerVersion:this.normalizer.normalizerVersion,
      projectionId:this.projection.projectionId,projectionVersion:this.projection.projectionVersion,
      outputs:[],completedOutputs:0,disposition:'projected'};
    const allowedRoutes=entry.record.mapping?.projectionRouteIds??[],targetRoutes=this.target.routeIds??[this.target.targetId];
    if(!this.target.acceptAllMappings&&!targetRoutes.some(route=>allowedRoutes.includes(route))){plan.disposition='filtered';return plan;}
    const push=(table:string,row:ProjectionRow)=>{
      const normalized=normalizedRow(row),ordinal=plan.outputs.length;
      const targetTable=this.target.targetType==='sdar_shared_warehouse'?table:(this.target.tableMap?.[table]??table);
      sqlIdentifier(targetTable);
      plan.outputs.push({table,targetTable,row:normalized,ordinal,revisionKey:outputRevisionKey({targetId:plan.targetId,generation:plan.generation,walEpoch:plan.walEpoch,ingestSequence:plan.ingestSequence},table,ordinal,normalized)});
    };
    const quality=entry.record.kind==='rejected'?null:entry.record.providerQuality;
    if(this.target.targetType!=='sdar_shared_warehouse'&&quality?.reasonCodes.length&&entry.record.kind!=='rejected'){
      push('telemetry_meta.provider_quality_observation_v1',{
        observation_id:uuidV5(`quality/v1/${this.target.targetId}/${this.generation}/${entry.walEpoch}/${entry.ingestSequence}`),
        target_id:this.target.targetId,generation:this.generation,wal_epoch:entry.walEpoch,ingest_sequence:entry.ingestSequence,
        tenant_id:entry.record.mapping.tenantId,project_id:entry.record.mapping.projectId,environment:entry.record.mapping.environment,
        smpp_source_id:entry.record.mapping.smppSourceId,deployment_id:entry.record.trustedContext.deploymentId,
        source_record_id:entry.record.envelope.recordId,source_record_hash:entry.record.envelope.recordHash,
        provider_id:entry.record.envelope.providerId,provider_event_id:entry.record.envelope.providerEventId??'',
        status:quality.status,reason_codes:quality.reasonCodes,observed_sequence:quality.observedSequence??null,
        previous_maximum:quality.previousMaximum??null,gap_start:quality.gapStart??null,gap_end:quality.gapEnd??null,
        quality_json:JSON.stringify(quality),received_at:entry.record.receivedAt,projected_at:projectedAt
      });
    }
    if(entry.record.kind==='rejected'){
      if(this.target.writeLayers.includes('landing'))push('telemetry_landing.smpp_provider_ops_rejected_summary_v1',{
        rejection_id:entry.record.rejectionId,collector_id:entry.record.trustedContext.collectorId,
        source_hint:JSON.stringify(entry.record.sourceHint),error_code:entry.record.errorCode,
        error_summary:entry.record.errorSummary,received_at:entry.record.receivedAt
      });
      return plan;
    }
    if(entry.record.kind==='conflict'){
      if(this.target.writeLayers.includes('landing'))push('telemetry_landing.smpp_provider_ops_conflict_v1',{
        tenant_id:entry.record.mapping.tenantId,project_id:entry.record.mapping.projectId,
        environment:entry.record.mapping.environment,mapping_version:entry.record.mapping.mappingVersion,
        source_record_id:entry.record.envelope.recordId,accepted_record_hash:entry.record.acceptedRecordHash??'',
        conflicting_record_hash:entry.record.envelope.recordHash,provider_id:entry.record.envelope.providerId,
        record_type:entry.record.envelope.recordType,occurred_at:entry.record.envelope.occurredAt,
        received_at:entry.record.receivedAt,error_code:entry.record.errorCode??'RECORD_HASH_CONFLICT',conflict_summary:entry.record.errorCode??entry.record.summary,wal_segment:entry.segment,wal_offset:entry.offset
      });
      return plan;
    }
    if(entry.record.kind!=='accepted')throw new Error('WAL_RECORD_KIND_UNSUPPORTED');
    if(this.target.writeLayers.includes('landing'))push('telemetry_landing.smpp_provider_ops_v1',{...landingRow({...entry,record:entry.record}),ingested_at:projectedAt,ingest_version:Date.parse(projectedAt)});
    let facts:ReturnType<SmppProviderOpsNormalizerV1['normalize']>;
    try{facts=this.normalizer.normalize({record:entry.record});}catch(error){if(!deterministicRecordError(error))throw error;throw new DeterministicRecordError(error.message,'normalize');}
    for(const original of facts){
      const fact={...original,normalizedAt:projectedAt};
      if(this.target.writeLayers.includes('normalized')){
        push('telemetry_normalized.canonical_fact_v1',canonicalRow(fact));
        for(const ref of fact.entityRefs)push('telemetry_normalized.canonical_entity_ref_v1',{
          fact_id:fact.factId,tenant_id:fact.tenantId,project_id:fact.projectId,entity_type:ref.entityType,entity_urn:ref.urn,local_id:ref.localId,created_at:projectedAt
        });
        for(const relation of fact.relations)push('telemetry_normalized.canonical_relation_candidate_v1',{
          candidate_id:uuidV5(`${fact.factId}/${relation.relationId}`),fact_id:fact.factId,tenant_id:fact.tenantId,project_id:fact.projectId,
          relation_type:relation.relationType,source_entity_urn:relation.sourceEntityUrn,target_entity_urn:relation.targetEntityUrn,
          evidence_class:relation.confidenceClass,candidate_json:JSON.stringify(relation),created_at:projectedAt
        });
      }
      if(this.target.writeLayers.includes('core')||this.target.writeLayers.includes('relation')){
        for(const out of this.projection.project(fact)){
          const relation=out.table.endsWith('entity_relation_fact');
          if((relation&&this.target.writeLayers.includes('relation'))||(!relation&&this.target.writeLayers.includes('core')))push(out.table,{...out.row,projected_at:projectedAt});
        }
      }
    }
    return plan;
  }
  private async quarantine(entry:WalEntry,key:string,error:Error){
    const stage=error instanceof DeterministicRecordError?error.stage:'prepare';
    const dlqId=deadLetterId(key,stage),createdAt=this.clock.now();
    const envelope=isRecord(entry.record.envelope)?entry.record.envelope:{};
    const dlq:ProjectionDeadLetter={dlqId,targetId:this.target.targetId,generation:this.generation,walEpoch:entry.walEpoch,ingestSequence:entry.ingestSequence,
      segment:entry.segment,offset:entry.offset,offsetEnd:entry.offsetEnd,sourceRecordId:typeof envelope.recordId==='string'?envelope.recordId:'',sourceRecordHash:typeof envelope.recordHash==='string'?envelope.recordHash:'',
      errorCode:error.message,stage,createdAt,normalizerId:this.normalizer.normalizerId,normalizerVersion:this.normalizer.normalizerVersion,
      projectionId:this.projection.projectionId,projectionVersion:this.projection.projectionVersion,mappingSnapshot:entry.record.mapping??null,
      providerQuality:entry.record.providerQuality??null,status:'unresolved',resolvedAt:null};
    const publicationOperations=this.publisher?await this.publisher.emptyDispositionOperations(key,entry,createdAt):[];
    await this.wal.commit(this.checkpointId,entry,{operations:[...publicationOperations,...this.progressLedger.dispositionOperations(entry,'quarantined'),
      {type:'put',namespace:'disposition',key,value:'quarantined'},
      {type:'put',namespace:'dlq',key:dlqId,value:dlq},
      {type:'put',namespace:'outbox:dlq',key:dlqId,value:dlq},
      {type:'put',namespace:'pin',key:`dlq:${dlqId}`,value:{id:`dlq:${dlqId}`,owner:this.checkpointId,kind:'dlq',fromSequence:entry.ingestSequence,throughSequence:entry.ingestSequence}},
      {type:'increment',namespace:'target:quarantined',key:this.checkpointId},
      {type:'increment',namespace:'target:accepted-quarantined',key:this.checkpointId,amount:entry.record.kind==='accepted'?1:0},
      {type:'increment',namespace:'wal',key:'protectionRevision'}
    ]});
    this.metrics.inc('projection_target_quarantined_total',{target:this.target.targetId,reason:error.message});
  }
  private async flushDeadLetters(){
    // The local DLQ is authoritative. A diagnostic-store outage never reverses a durable disposition.
    if(this.target.targetType==='sdar_shared_warehouse')return;
    for(const {key,value}of this.wal.state.scan<ProjectionDeadLetter>('outbox:dlq',{limit:100})){
      try{
        await this.client.insert('telemetry_meta.projection_dead_letter',[{
          dlq_id:value.dlqId,target_id:value.targetId,fact_id:null,source_record_id:value.sourceRecordId,
          error_code:value.errorCode,error_summary:value.errorCode,payload_summary:JSON.stringify({walEpoch:value.walEpoch,ingestSequence:value.ingestSequence,generation:value.generation}),
          created_at:value.createdAt,resolved_at:value.resolvedAt
        }]);
        if(value.stage==='normalize')await this.client.insert('telemetry_normalized.normalization_dead_letter_v1',[{
          dlq_id:value.dlqId,source_system:'smpp',source_record_id:value.sourceRecordId,normalizer_id:value.normalizerId,
          error_code:value.errorCode,error_summary:value.errorCode,created_at:value.createdAt,resolved_at:value.resolvedAt
        }]);
        await this.wal.state.delete('outbox:dlq',key);
      }catch{this.metrics.inc('projection_diagnostic_outbox_failures_total',{target:this.target.targetId});break;}
    }
  }
  private async projectEntry(rawEntry:WalEntry):Promise<'projected'|'quarantined'|'not-routed'>{
        this.publisher?.assertWritable();
        const key=outputPlanKey(this.target.targetId,this.generation,rawEntry);
        const previousDisposition=this.wal.state.get<'projected'|'quarantined'|'not-routed'>('disposition',key);
        if(previousDisposition)return previousDisposition;
        let entry:WalEntry<TelemetryWalRecord>;
        try{entry=asTelemetryEntry(rawEntry);}catch(error){if(!deterministicRecordError(error))throw error;await this.quarantine(rawEntry,key,error);return 'quarantined';}
        let plan=this.wal.state.get<OutputPlan>('plan',key);
        if(!plan){
          try{plan=this.prepare(entry);}catch(error){if(!deterministicRecordError(error))throw error;await this.quarantine(entry,key,error);return 'quarantined';}
          await this.wal.state.put('plan',key,plan);
        }
        if(plan.normalizerId!==this.normalizer.normalizerId||plan.normalizerVersion!==this.normalizer.normalizerVersion||plan.projectionId!==this.projection.projectionId||plan.projectionVersion!==this.projection.projectionVersion)throw new Error('PROJECTION_PLAN_VERSION_MISMATCH_REPLAY_REQUIRED');
        while(plan.completedOutputs<plan.outputs.length){
          const first=plan.outputs[plan.completedOutputs]!;
          let end:number=plan.completedOutputs+1;
          while(end<plan.outputs.length&&plan.outputs[end]!.targetTable===first.targetTable)end++;
          const rows=plan.outputs.slice(plan.completedOutputs,end).map(output=>output.row);
          for(const partition of partitionRowsForInsert(first.table,rows))await this.client.insert(first.targetTable,partition);
          plan={...plan,completedOutputs:end};await this.wal.state.put('plan',key,plan);
        }
        const publicationOperations=this.publisher?await this.publisher.dispositionOperations(key,plan,entry):[];
        await this.wal.commit(this.checkpointId,entry,{operations:[...publicationOperations,...this.progressLedger.dispositionOperations(entry,plan.disposition==='filtered'?'not-routed':'projected'),{type:'put',namespace:'disposition',key,value:plan.disposition==='filtered'?'not-routed':'projected'},{type:'increment',namespace:plan.disposition==='filtered'?'target:accepted-not-routed':'target:accepted-projected',key:this.checkpointId,amount:entry.record.kind==='accepted'?1:0},{type:'put',namespace:'target:progress',key:this.checkpointId,value:{walEpoch:entry.walEpoch,ingestThrough:entry.ingestSequence,projectedAt:plan.projectedAt,disposition:plan.disposition}}]});
        return plan.disposition==='filtered'?'not-routed':'projected';
  }
  async projectReplayEntry(rawEntry:WalEntry):Promise<'projected'|'quarantined'|'not-routed'>{
    if(this.generation==='legacy')throw new Error('REPLAY_LIVE_GENERATION_FORBIDDEN');
    if(!this.initialized)await this.initialize();
    await this.progressLedger.indexInputs();
    const result=await this.projectEntry(rawEntry);
    await this.publisher?.flush(this.clock.now());
    await this.flushDeadLetters();
    return result;
  }
  async flush(){
    if(this.running||!this.target.enabled)return;
    this.running=true;
    try{
      if(!this.initialized)await this.initialize();
      await this.progressLedger.indexInputs();
      for(const rawEntry of this.wal.pending(this.checkpointId,this.batchSize))await this.projectEntry(rawEntry);
      await this.publisher?.flush(this.clock.now());
      this.lastError=null;
      this.retryFailures=0;this.nextAttemptAt=0;
      await this.flushDeadLetters();
      this.metrics.inc('projection_target_batches_total',{target:this.target.targetId});
    }catch(error){
      this.lastError=error instanceof Error?error:new Error('PROJECTION_UNKNOWN_FAILURE');this.retryFailures++;
      this.nextAttemptAt=Date.now()+Math.round(Math.min(60000,1000*2**Math.min(6,this.retryFailures-1))*(0.5+0.5*Math.random()));
      this.metrics.inc('projection_target_failures_total',{target:this.target.targetId});
      // Preserve an existing safe publication boundary while exposing new pending inputs.
      // The first ever publication must still establish its metadata through successful flush.
      if(this.publisher&&(this.wal.state.get<number>('snapshot:version',this.publisher.key)??0)>0){
        try{await this.publisher.refresh(this.clock.now());}catch{this.metrics.inc('projection_progress_publish_failures_total',{target:this.target.targetId});}
      }
    }
    finally{this.running=false;}
  }
  status(){
    const first=this.wal.pending(this.checkpointId,1)[0],receivedAt=first?.record.receivedAt;
    return {targetId:this.target.targetId,targetType:this.target.targetType,generation:this.generation,projectionId:this.projection.projectionId,projectionVersion:this.projection.projectionVersion,enabled:this.target.enabled,running:this.running,lastError:this.lastError?.message??null,checkpoint:this.wal.checkpoint(this.checkpointId),pending:this.wal.pendingCount(this.checkpointId),
      publicationPending:this.publisher?.pending()??0,quarantined:this.wal.state.get<number>('target:quarantined',this.checkpointId)??0,nextRetryAt:this.nextAttemptAt?new Date(this.nextAttemptAt).toISOString():null,
      oldestPendingAgeMs:typeof receivedAt==='string'?Math.max(0,Date.now()-Date.parse(receivedAt)):0};
  }
  async waitForIdle(){while(this.running)await new Promise(resolve=>setTimeout(resolve,10));}
}

export class TargetManager {
  readonly targets:TargetWorker[]; readonly registrations:ProjectionTarget[]; readonly wal:WalStore;
  timer:ReturnType<typeof setInterval>|null=null;
  constructor({targets,wal,metrics,batchSize=200,clientFactory,clock={now:()=>new Date().toISOString()}}:{targets:ProjectionTarget[];wal:WalStore;metrics:Metrics;batchSize?:number;clientFactory?:(target:ProjectionTarget)=>ProjectionClient;clock?:Clock}){
    this.registrations=targets;this.wal=wal;
    this.targets=targets.filter(target=>target.enabled).map(target=>{
      if(!clientFactory&&!target.connection.url)throw new Error('TARGET_CONNECTION_URL_REQUIRED');
      const client=clientFactory?clientFactory(target):new ClickHouseClient({...target.connection,url:target.connection.url!});
      return new TargetWorker({target,wal,metrics,batchSize,client,clock});
    });
  }
  async initialize(){
    // Disabled targets remain registered consumers until explicit audited retirement.
    for(const target of this.registrations)await this.wal.registerTarget(`target:${target.targetId}`,{generation:target.generation??'legacy'});
    for(const target of this.targets){try{await target.initialize();}catch(error){target.lastError=error instanceof Error?error:new Error('TARGET_INITIALIZE_FAILED');target.metrics.inc('projection_target_failures_total',{target:target.target.targetId});if(target.target.required)throw error;}}
  }
  start(intervalMs=1000){this.timer=setInterval(()=>void Promise.all(this.targets.filter(target=>target.nextAttemptAt<=Date.now()).map(target=>target.flush())),intervalMs);this.timer.unref();void this.flush();}
  async flush(){await Promise.all(this.targets.map(target=>target.flush()));}
  pause(){if(this.timer){clearInterval(this.timer);this.timer=null;}}
  async stop(timeoutMs=10000){
    this.pause();
    const drain=async()=>{await Promise.all(this.targets.map(target=>target.waitForIdle()));await this.flush();};
    let timeout:ReturnType<typeof setTimeout>|undefined;
    try{await Promise.race([drain(),new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(new Error('TARGET_DRAIN_TIMEOUT')),timeoutMs);timeout.unref();})]);}
    finally{clearTimeout(timeout);}
  }
  statuses(){return this.targets.map(target=>target.status());}
  async pingRequired(){for(const target of this.targets.filter(value=>value.target.required)){if(!target.initialized||target.lastError)throw new Error('TARGET_NOT_READY');await target.client.ping();}return true;}
}
