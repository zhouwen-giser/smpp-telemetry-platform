import { isRecord } from '../../../../packages/telemetry-types/src/index.js';
import type { ProgressRow } from '../../../../telemetry-dashboard/query-api/src/snapshot-types.js';
import type { StateOperation } from '../durable-state/types.js';
import type { WalEntry, WalStore } from '../wal/wal.js';
import { sha256Canonical } from '../canonical/canonical.js';
import { outputPlanKey } from './output-plan.js';

type Disposition='projected'|'quarantined'|'not-routed';
type Dimensions=Pick<ProgressRow,'tenant_id'|'project_id'|'environment'|'smpp_source_id'|'deployment_id'|'fact_type'>;
interface Bucket {dimensions:Dimensions;accepted:number;projected:number;quarantined:number;notRouted:number;pending:number;receivedThrough:number;processedThrough:number;legacy:boolean}
const namespace='progress:scope';
const field=(record:Record<string,unknown>,name:string):string=>typeof record[name]==='string'?record[name]:'';

/** Rebuildable, bounded mirror of accepted inputs and their durable dispositions. */
export class TargetProgressLedger {
  readonly key:string;
  constructor(readonly wal:WalStore,readonly targetId:string,readonly generation:string){this.key=`${targetId}/${generation}/${wal.walEpoch}`;}
  private identity(entry:WalEntry):{key:string;dimensions:Dimensions}|null {
    if(entry.record.kind!=='accepted')return null;
    const mapping=isRecord(entry.record.mapping)?entry.record.mapping:{},trusted=isRecord(entry.record.trustedContext)?entry.record.trustedContext:{},envelope=isRecord(entry.record.envelope)?entry.record.envelope:{};
    const dimensions:Dimensions={tenant_id:field(mapping,'tenantId'),project_id:field(mapping,'projectId'),environment:field(mapping,'environment'),smpp_source_id:field(mapping,'smppSourceId'),deployment_id:field(trusted,'deploymentId'),fact_type:field(envelope,'recordType')};
    return {key:`${this.key}/${sha256Canonical(dimensions)}`,dimensions};
  }
  private pendingKey(key:string,sequence:number){return `${key}/${String(sequence).padStart(20,'0')}`;}
  async indexInputs(limit=1000):Promise<void>{
    const through=this.wal.state.get<number>('progress:indexed',this.key)??0;
    // A bounded batch is committed atomically; an interrupted rebuild resumes at its exact input boundary.
    const entries=this.wal.readEntries(through,limit);
    if(!entries.length)return;
    const buckets=new Map<string,Bucket>(),originals=new Map<string,Bucket|null>(),operations:StateOperation[]=[];
    const checkpoint=this.wal.checkpointSequence(`target:${this.targetId}`);
    for(const entry of entries){
      const identity=this.identity(entry);if(!identity)continue;
      let bucket=buckets.get(identity.key)??this.wal.state.get<Bucket>(namespace,identity.key);
      if(!originals.has(identity.key))originals.set(identity.key,bucket??null);
      bucket={...(bucket??{dimensions:identity.dimensions,accepted:0,projected:0,quarantined:0,notRouted:0,pending:0,receivedThrough:0,processedThrough:0,legacy:false})};
      bucket.accepted++;bucket.receivedThrough=entry.ingestSequence;
      const disposition=this.wal.state.get<Disposition>('disposition',outputPlanKey(this.targetId,this.generation,entry));
      if(disposition){this.apply(bucket,disposition);bucket.processedThrough=Math.max(bucket.processedThrough,entry.ingestSequence);}
      else if(entry.ingestSequence<=checkpoint){bucket.legacy=true;bucket.processedThrough=entry.ingestSequence;}
      else {bucket.pending++;operations.push({type:'put',namespace:'progress:pending',key:this.pendingKey(identity.key,entry.ingestSequence),value:{receivedAt:entry.record.receivedAt}});}
      buckets.set(identity.key,bucket);
    }
    for(const [key,value]of buckets)operations.push({type:'check',namespace,key,expected:originals.get(key)},{type:'put',namespace,key,value});
    operations.push({type:'check',namespace:'progress:indexed',key:this.key,expected:through||null},{type:'put',namespace:'progress:indexed',key:this.key,value:entries.at(-1)!.ingestSequence});
    await this.wal.state.transaction(operations);
  }
  private apply(bucket:Bucket,disposition:Disposition){if(disposition==='not-routed')bucket.notRouted++;else bucket[disposition]++;}
  dispositionOperations(entry:WalEntry,disposition:Disposition):StateOperation[]{
    const identity=this.identity(entry);if(!identity)return [];
    // Inputs beyond this mirror are reconstructed later from the same committed disposition.
    if(entry.ingestSequence>(this.wal.state.get<number>('progress:indexed',this.key)??0))return [];
    const previous=this.wal.state.get<Bucket>(namespace,identity.key);
    if(!previous)throw new Error('PROGRESS_BUCKET_MISSING');
    const pendingKey=this.pendingKey(identity.key,entry.ingestSequence);
    if(this.wal.state.get('progress:pending',pendingKey)===undefined)return [];
    const bucket={...previous,pending:previous.pending-1,processedThrough:Math.max(previous.processedThrough,entry.ingestSequence)};this.apply(bucket,disposition);
    return [{type:'check',namespace,key:identity.key,expected:previous},{type:'put',namespace,key:identity.key,value:bucket},{type:'delete',namespace:'progress:pending',key:pendingKey}];
  }
  rows({version,visibleThrough,now,limit=500,after}:{version:number;visibleThrough:number;now:string;limit?:number;after?:string}):{rows:ProgressRow[];lastKey:string|null;hasMore:boolean}{
    const indexed=this.wal.state.get<number>('progress:indexed',this.key)??0,complete=indexed>=this.wal.state.lastSequence();
    const items=this.wal.state.scan<Bucket>(namespace,{prefix:`${this.key}/`,limit:limit+1,...(after?{after}:{})}),hasMore=items.length>limit,page=items.slice(0,limit);
    return {rows:page.map(({key,value})=>{
      const first=this.wal.state.scan<{receivedAt:unknown}>('progress:pending',{prefix:`${key}/`,limit:1})[0]?.value.receivedAt;
      const date=typeof first==='string'?Date.parse(first):NaN;
      return {...value.dimensions,target_id:this.targetId,generation:this.generation,wal_epoch:this.wal.walEpoch,progress_version:version,
        received_through:value.receivedThrough,processed_through:value.processedThrough,visible_through:Math.min(value.processedThrough,visibleThrough),
        accepted:value.accepted,projected:value.legacy?null:value.projected,quarantined:value.legacy?null:value.quarantined,not_routed:value.legacy?null:value.notRouted,pending:value.pending,
        oldest_pending_received_at:Number.isFinite(date)?new Date(date).toISOString():null,progress_observed_at:now,
        coverage_status:value.legacy?'legacy':complete&&Object.values(value.dimensions).every(Boolean)?'exact':'unknown'};
    }),lastKey:page.at(-1)?.key??null,hasMore};
  }
}
