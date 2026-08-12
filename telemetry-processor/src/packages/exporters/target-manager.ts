import { readFile } from 'node:fs/promises';
import { ClickHouseClient, landingRow, canonicalRow } from './clickhouse.js';
import { SmppProviderOpsNormalizerV1 } from '../normalization/smpp-provider-ops-v1.js';
import { CoreProjectionV1 } from '../projection/core-projection.js';

export async function loadProjectionTargets(file) {
  const data=JSON.parse(await readFile(file,'utf8'));
  if(!Array.isArray(data.targets)) throw new Error('PROJECTION_TARGETS_INVALID');
  return data.targets;
}

export class TargetWorker {
  constructor({target,wal,metrics,client,normalizer=new SmppProviderOpsNormalizerV1(),projection=new CoreProjectionV1(),batchSize=200}) {
    this.target=target;this.wal=wal;this.metrics=metrics;this.client=client;
    this.normalizer=normalizer;this.projection=projection;this.batchSize=batchSize;
    this.running=false;this.lastError=null;this.checkpointId=`target:${target.targetId}`;
  }

  async initialize(){await this.client.initialize();}

  async flush(){
    if(this.running||!this.target.enabled)return;
    this.running=true;
    try{
      const entries=this.wal.pending(this.checkpointId,this.batchSize);
      if(!entries.length){this.lastError=null;return;}
      const tables=new Map();
      const push=(table,row)=>{if(!tables.has(table))tables.set(table,[]);tables.get(table).push(row);};
      for(const entry of entries){
        const allowedRoutes=entry.record.mapping?.projectionRouteIds??[];
        const targetRoutes=this.target.routeIds??[this.target.targetId];
        if(!this.target.acceptAllMappings&&!targetRoutes.some(route=>allowedRoutes.includes(route)))continue;
        if(entry.record.kind==='rejected'){
          if(this.target.writeLayers.includes('landing'))push('telemetry_landing.smpp_provider_ops_rejected_summary_v1',{
            rejection_id:entry.record.rejectionId,
            collector_id:entry.record.trustedContext.collectorId,
            source_hint:JSON.stringify(entry.record.sourceHint),
            error_code:entry.record.errorCode,
            error_summary:entry.record.errorSummary,
            received_at:entry.record.receivedAt
          });
          continue;
        }
        if(entry.record.kind==='conflict'){
          if(this.target.writeLayers.includes('landing'))push('telemetry_landing.smpp_provider_ops_conflict_v1',{
            tenant_id:entry.record.mapping.tenantId,project_id:entry.record.mapping.projectId,
            environment:entry.record.mapping.environment,mapping_version:entry.record.mapping.mappingVersion,
            source_record_id:entry.record.envelope.recordId,
            accepted_record_hash:entry.record.acceptedRecordHash,
            conflicting_record_hash:entry.record.envelope.recordHash,
            provider_id:entry.record.envelope.providerId,record_type:entry.record.envelope.recordType,
            occurred_at:entry.record.envelope.occurredAt,received_at:entry.record.receivedAt,
            conflict_summary:entry.record.summary,wal_segment:entry.segment,wal_offset:entry.offset
          });
          continue;
        }
        if(entry.record.kind!=='accepted')continue;
        if(this.target.writeLayers.includes('landing'))push('telemetry_landing.smpp_provider_ops_v1',landingRow(entry));
        const facts=this.normalizer.normalize(entry);
        for(const fact of facts){
          if(this.target.writeLayers.includes('normalized'))push('telemetry_normalized.canonical_fact_v1',canonicalRow(fact));
          if(this.target.writeLayers.includes('core')||this.target.writeLayers.includes('relation')){
            for(const out of this.projection.project(fact)){
              const isRelation=out.table.endsWith('entity_relation_fact');
              if((isRelation&&this.target.writeLayers.includes('relation'))||(!isRelation&&this.target.writeLayers.includes('core')))push(out.table,out.row);
            }
          }
        }
      }
      for(const [table,rows] of tables)await this.client.insert(this.target.tableMap?.[table]??table,rows);
      await this.wal.commit(this.checkpointId,entries.at(-1));
      this.lastError=null;
      this.metrics.inc('projection_target_batches_total',{target:this.target.targetId});
    }catch(error){
      this.lastError=error;
      this.metrics.inc('projection_target_failures_total',{target:this.target.targetId});
    }finally{this.running=false;}
  }

  status(){return {targetId:this.target.targetId,targetType:this.target.targetType,enabled:this.target.enabled,running:this.running,lastError:this.lastError?.message??null,checkpoint:this.wal.checkpoint(this.checkpointId),pending:this.wal.pending(this.checkpointId,Number.MAX_SAFE_INTEGER).length};}
}

export class TargetManager {
  constructor({targets,wal,metrics,batchSize=200,clientFactory}){
    this.targets=targets.filter(target=>target.enabled).map(target=>new TargetWorker({target,wal,metrics,batchSize,client:clientFactory?clientFactory(target):new ClickHouseClient(target.connection)}));
    this.timer=null;
  }
  async initialize(){for(const target of this.targets)await target.initialize();}
  start(intervalMs=1000){this.timer=setInterval(()=>void this.flush(),intervalMs);this.timer.unref();void this.flush();}
  async flush(){await Promise.all(this.targets.map(target=>target.flush()));}
  statuses(){return this.targets.map(target=>target.status());}
  async pingRequired(){for(const target of this.targets.filter(value=>value.target.required))await target.client.ping();return true;}
}
