import { canonicalizeJson, sha256Canonical } from '../canonical/canonical.js';
import type { TelemetryWalRecord } from '../../../../packages/telemetry-types/src/index.js';
import type { WalEntry, WalStore } from '../wal/wal.js';
import type { StateOperation } from '../durable-state/types.js';
import type { OutputPlan } from './output-plan.js';
import type { ProjectionClient } from './target-manager.js';
import type { OutputRevisionRow, PublicationRow, SnapshotRow, ProgressRow } from '../../../../telemetry-dashboard/query-api/src/snapshot-types.js';
import { assertGenerationWritable, refreshGenerationLease } from './generation-lifecycle.js';
import { TargetProgressLedger } from './progress-ledger.js';

interface PublicationOutbox {key:string;planKey:string;ingestSequence:number;publicationFrom:number;publicationThrough:number;reservationOrdinal:number;revisions:OutputRevisionRow[];publications:PublicationRow[]}
interface Progress {reservationOrdinal:number;ingestThrough:number;publicationThrough:number;publishedRevisionCount:number;legacyCoverage:0|1}
const text=(value:unknown):string=>typeof value==='string'?value:'';

/** Local publication outbox is committed with source disposition; Query only sees completed publications. */
export class SnapshotPublisher {
  readonly key:string;
  constructor(readonly wal:WalStore,readonly client:ProjectionClient,readonly targetId:string,readonly generation:string,readonly retentionDays=7){
    this.key=`${targetId}/${generation}/${wal.walEpoch}`;
    if(!Number.isSafeInteger(retentionDays)||retentionDays<1)throw new Error('SNAPSHOT_RETENTION_INVALID');
  }
  async initialize(checkpointId:string){
    if(this.wal.state.get('snapshot:progress',this.key))return;
    const checkpoint=this.wal.checkpoint(checkpointId);
    await this.wal.state.put('snapshot:progress',this.key,{reservationOrdinal:0,ingestThrough:0,publicationThrough:0,publishedRevisionCount:0,legacyCoverage:checkpoint.segment===0?0:1} satisfies Progress);
  }
  async dispositionOperations(planKey:string,plan:OutputPlan,entry:WalEntry<TelemetryWalRecord>):Promise<StateOperation[]>{
    this.assertWritable();
    if(this.wal.state.get('snapshot:done',planKey))return [];
    let outbox=this.wal.state.get<PublicationOutbox>('snapshot:reservation',planKey);
    if(!outbox){
      const storedSequence=this.wal.state.get<number>('snapshot:sequence',this.key);
      const previous=storedSequence??0;
      const storedOrdinal=this.wal.state.get<number>('snapshot:ordinal',this.key),ordinal=(storedOrdinal??0)+1;
      const expiresAt=new Date(Date.parse(plan.projectedAt)+this.retentionDays*86400000).toISOString();
      const record=entry.record,mapping=record.mapping,envelope=record.kind==='rejected'?null:record.envelope;
      const revisions:OutputRevisionRow[]=plan.outputs.map(output=>{
        const row=output.row;
        return {target_id:this.targetId,generation:this.generation,wal_epoch:entry.walEpoch,ingest_sequence:entry.ingestSequence,
          output_revision_key:output.revisionKey,row_hash:sha256Canonical(row),physical_table:output.table,
          sort_time:text(row.occurred_at)||text(row.valid_from)||text(row.created_at)||plan.projectedAt,
          logical_id:text(row.source_record_id)||text(row.relation_id)||text(row.fact_id)||text(row.rejection_id)||output.revisionKey,
          revision_version:plan.projectionVersion,tenant_id:mapping?.tenantId??'',project_id:mapping?.projectId??'',environment:mapping?.environment??'',
          smpp_source_id:mapping?.smppSourceId??'',deployment_id:record.trustedContext.deploymentId,
          source_entity_urn:text(row.source_entity_urn),target_entity_urn:text(row.target_entity_urn),
          dimensions_json:canonicalizeJson({...row,provider_id:envelope?.providerId??'',task_id:envelope?.taskId??'',resource_id:envelope?.resourceId??'',runtime_instance_id:envelope?.instanceId??'',operation_name:envelope?.operationName??''}),
          row_json:canonicalizeJson(row),expires_at:expiresAt};
      });
      const publications:PublicationRow[]=revisions.map((revision,index)=>({target_id:this.targetId,generation:this.generation,wal_epoch:entry.walEpoch,
        publication_sequence:previous+index+1,ingest_sequence:entry.ingestSequence,output_revision_key:revision.output_revision_key,
        row_hash:revision.row_hash,published_at:plan.projectedAt,expires_at:expiresAt}));
      outbox={key:`${this.key}/${String(ordinal).padStart(20,'0')}`,planKey,ingestSequence:entry.ingestSequence,publicationFrom:previous+1,publicationThrough:previous+publications.length,reservationOrdinal:ordinal,revisions,publications};
      await this.wal.state.transaction([
        {type:'check',namespace:'snapshot:sequence',key:this.key,expected:storedSequence??null},
        {type:'check',namespace:'snapshot:ordinal',key:this.key,expected:storedOrdinal??null},
        {type:'put',namespace:'snapshot:ordinal',key:this.key,value:ordinal},
        {type:'put',namespace:'snapshot:sequence',key:this.key,value:outbox.publicationThrough},
        {type:'put',namespace:'snapshot:reservation',key:planKey,value:outbox}
      ]);
    }
    return [{type:'put',namespace:'outbox:snapshot',key:outbox.key,value:outbox},
      {type:'put',namespace:'pin',key:`publication:${outbox.key}`,value:{id:`publication:${outbox.key}`,owner:this.key,kind:'reader',fromSequence:entry.ingestSequence,throughSequence:entry.ingestSequence}},
      {type:'increment',namespace:'wal',key:'protectionRevision'}];
  }
  async emptyDispositionOperations(planKey:string,entry:WalEntry,projectedAt:string):Promise<StateOperation[]>{
    const record={kind:'rejected' as const,sourceSystem:'smpp',rejectionId:'',receivedAt:projectedAt,trustedContext:{deploymentId:'',collectorId:''},mapping:null,sourceHint:{},errorCode:'',errorSummary:''};
    const plan:OutputPlan={version:1,targetId:this.targetId,generation:this.generation,walEpoch:entry.walEpoch,ingestSequence:entry.ingestSequence,projectedAt,normalizerId:'',normalizerVersion:0,projectionId:'',projectionVersion:0,outputs:[],completedOutputs:0,disposition:'filtered'};
    return this.dispositionOperations(planKey,plan,{...entry,record});
  }
  async flush(now:string){
    for(const {key,value}of this.wal.state.scan<PublicationOutbox>('outbox:snapshot',{prefix:`${this.key}/`,limit:200})){
      const previous=this.wal.state.get<Progress>('snapshot:progress',this.key)!;
      if(previous.publicationThrough!==value.publicationFrom-1||previous.reservationOrdinal+1!==value.reservationOrdinal)throw new Error('SNAPSHOT_PUBLICATION_GAP');
      // Each retry sends byte-identical content under the same revision identity and publication number.
      for(let offset=0;offset<value.revisions.length;offset+=100){
        await this.client.insert('telemetry_query.output_revision_v1',value.revisions.slice(offset,offset+100).map(row=>({...row})));
        await this.client.insert('telemetry_query.publication_v1',value.publications.slice(offset,offset+100).map(row=>({...row})));
      }
      await this.wal.state.transaction([
        {type:'check',namespace:'snapshot:progress',key:this.key,expected:previous},
        {type:'put',namespace:'snapshot:progress',key:this.key,value:{...previous,reservationOrdinal:value.reservationOrdinal,ingestThrough:Math.max(previous.ingestThrough,value.ingestSequence),publicationThrough:Math.max(previous.publicationThrough,value.publicationThrough),publishedRevisionCount:previous.publishedRevisionCount+value.revisions.length}},
        {type:'delete',namespace:'outbox:snapshot',key},
        {type:'put',namespace:'snapshot:done',key:value.planKey,value:true},
        {type:'delete',namespace:'pin',key:`publication:${key}`},
        {type:'increment',namespace:'wal',key:'protectionRevision'}
      ]);
    }
    await this.refresh(now);
  }
  async refresh(now:string){
    const lifecycle=await refreshGenerationLease(this.wal,this.targetId,this.generation,now);
    const progress=this.wal.state.get<Progress>('snapshot:progress',this.key)!;
    const result=await this.wal.state.transaction([{type:'increment',namespace:'snapshot:version',key:this.key}]);
    const row:SnapshotRow={target_id:this.targetId,generation:this.generation,wal_epoch:this.wal.walEpoch,
      snapshot_version:Number(result[0]),ingest_through:progress.ingestThrough,publication_through:progress.publicationThrough,published_revision_count:progress.publishedRevisionCount,
      retention_policy_epoch:`immutable-v1-${this.retentionDays}d`,lifecycle_status:lifecycle.status,readable_until:lifecycle.readableUntil,
      legacy_coverage:progress.legacyCoverage,progress_observed_at:now};
    await this.client.insert('telemetry_query.snapshot_v1',[{...row}]);
    const checkpointId=`target:${this.targetId}`,coverage=this.wal.state.get<string>('target:counts-coverage',checkpointId),first=this.wal.firstAcceptedAfter(this.wal.checkpointSequence(checkpointId));
    const data:ProgressRow={target_id:this.targetId,generation:this.generation,wal_epoch:this.wal.walEpoch,
      tenant_id:'*',project_id:'*',environment:'*',smpp_source_id:'*',deployment_id:'*',fact_type:'*',
      progress_version:row.snapshot_version,received_through:this.wal.state.lastSequence(),processed_through:this.wal.checkpointSequence(checkpointId),visible_through:progress.ingestThrough,
      accepted:this.wal.acceptedCount(),projected:coverage==='exact'?(this.wal.state.get<number>('target:accepted-projected',checkpointId)??0):null,
      quarantined:coverage==='exact'?(this.wal.state.get<number>('target:accepted-quarantined',checkpointId)??0):null,
      not_routed:coverage==='exact'?(this.wal.state.get<number>('target:accepted-not-routed',checkpointId)??0):null,pending:this.wal.acceptedCount(this.wal.checkpointSequence(checkpointId)),
      oldest_pending_received_at:typeof first?.record.receivedAt==='string'?new Date(first.record.receivedAt).toISOString():null,
      progress_observed_at:now,coverage_status:coverage==='exact'?'exact':'legacy'};
    await this.client.insert('telemetry_query.progress_v1',[{...data}]);
    const after=this.wal.state.get<string>('progress:published-after',this.key);
    const scopePage=new TargetProgressLedger(this.wal,this.targetId,this.generation).rows({version:Number(row.snapshot_version),visibleThrough:progress.ingestThrough,now,...(after?{after}:{})});
    if(scopePage.rows.length)await this.client.insert('telemetry_query.progress_v1',scopePage.rows.map(value=>({...value})));
    if(scopePage.hasMore&&scopePage.lastKey)await this.wal.state.put('progress:published-after',this.key,scopePage.lastKey);
    else await this.wal.state.delete('progress:published-after',this.key);
  }
  pending():number {return Math.max(0,(this.wal.state.get<number>('snapshot:ordinal',this.key)??0)-(this.wal.state.get<Progress>('snapshot:progress',this.key)?.reservationOrdinal??0));}
  assertWritable():void {assertGenerationWritable(this.wal,this.targetId,this.generation);}
}
