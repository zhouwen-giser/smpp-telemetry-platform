import { randomUUID } from 'node:crypto';
import { validateEnvelope, validateTrustedIngress } from '../packages/validation/validation.js';

function safeSourceHint(envelope:any):Record<string,string> {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return {};
  const safe:Record<string,string> = {};
  for (const key of ['schemaName','schemaVersion','recordId','recordHash','recordType','providerId','instanceId']) {
    const value = envelope[key];
    if (typeof value === 'string' && /^[A-Za-z0-9._:-]{1,256}$/.test(value)) safe[key] = value;
  }
  return safe;
}

export class TelemetryProcessor {
  wal:any;
  mappings:any;
  metrics:any;
  requireCollectorId:boolean;
  allowedCollectorIds:string[];
  walMaxBytes:number;
  walRejectThreshold:number;

  constructor({wal,mappings,metrics,requireCollectorId=true,allowedCollectorIds=[],walMaxBytes=10*1024*1024*1024,walRejectThreshold=0.98}:{wal:any;mappings:any;metrics:any;requireCollectorId?:boolean;allowedCollectorIds?:string[];walMaxBytes?:number;walRejectThreshold?:number}) {
    this.wal=wal;
    this.mappings=mappings;
    this.metrics=metrics;
    this.requireCollectorId=requireCollectorId;
    this.allowedCollectorIds=allowedCollectorIds;
    this.walMaxBytes=walMaxBytes;
    this.walRejectThreshold=walRejectThreshold;
  }

  async #quarantine({code,message=code,receivedAt,trustedContext,envelope,mapping=null}:{code:string;message?:string;receivedAt:string;trustedContext:any;envelope:any;mapping?:any}) {
    const entry=await this.wal.append({
      kind:'rejected',sourceSystem:'smpp',rejectionId:randomUUID(),receivedAt,trustedContext,
      mapping,errorCode:code,errorSummary:String(message).slice(0,256),sourceHint:safeSourceHint(envelope)
    },{maxTotalBytes:this.walMaxBytes*this.walRejectThreshold});
    this.metrics.inc('processor_quarantined_total',{reason:code});
    return entry.record.rejectionId;
  }

  #retryableWal(error:unknown) {
    const code=error instanceof Error?error.message:undefined;
    if(!code||!['WAL_HIGH_WATER','WAL_WRITE_QUEUE_FULL','WAL_WRITE_FAILED_RESTART_REQUIRED'].includes(code)) return null;
    this.metrics.inc('processor_retryable_total',{reason:code});
    return{status:'rejected_retryable',errorCode:code};
  }

  async collect(logRecord:any) {
    this.metrics.inc('processor_received_records_total');
    const ingress:any=(validateTrustedIngress as any)(logRecord,{requireCollectorId:this.requireCollectorId,allowedCollectorIds:this.allowedCollectorIds});
    if(!ingress.ok){
      this.metrics.inc('processor_permanent_reject_total',{reason:ingress.code});
      return{status:'rejected_permanent',errorCode:ingress.code};
    }
    const envelope=logRecord.body;
    const receivedAt=new Date().toISOString();
    const validation:any=validateEnvelope(envelope,logRecord.attributes);
    if(!validation.ok){
      const mapping=this.mappings.resolve({...ingress.context,providerId:typeof envelope?.providerId==='string'?envelope.providerId:'',instanceId:typeof envelope?.instanceId==='string'?envelope.instanceId:'',receivedAt:new Date(receivedAt)});
      let rejectionId;
      try{rejectionId=await this.#quarantine({code:validation.code,message:validation.message,receivedAt,trustedContext:ingress.context,envelope,mapping});}
      catch(error){const retryable=this.#retryableWal(error);if(retryable)return retryable;throw error;}
      this.metrics.inc('processor_permanent_reject_total',{reason:validation.code});
      return{status:'rejected_permanent',errorCode:validation.code,message:validation.message,rejectionId};
    }
    const mapping=this.mappings.resolve({...ingress.context,providerId:envelope.providerId,instanceId:envelope.instanceId,receivedAt:new Date(receivedAt)});
    if(!mapping){
      let rejectionId;
      try{rejectionId=await this.#quarantine({code:'SOURCE_UNMAPPED',receivedAt,trustedContext:ingress.context,envelope});}
      catch(error){const retryable=this.#retryableWal(error);if(retryable)return retryable;throw error;}
      this.metrics.inc('processor_permanent_reject_total',{reason:'SOURCE_UNMAPPED'});
      return{status:'rejected_permanent',errorCode:'SOURCE_UNMAPPED',rejectionId};
    }
    const sourceSystem='smpp';
    let outcome;
    try{
      outcome=await this.wal.appendClassified({
        sourceSystem,recordId:envelope.recordId,recordHash:envelope.recordHash,
        acceptedRecord:{kind:'accepted',sourceSystem,receiptId:randomUUID(),receivedAt,trustedContext:ingress.context,mapping,envelope},
        conflictRecord:(acceptedRecordHash:string|undefined)=>({kind:'conflict',sourceSystem,receiptId:randomUUID(),receivedAt,trustedContext:ingress.context,mapping,envelope,acceptedRecordHash,summary:'sourceRecordId already exists with a different sourceRecordHash'}),
        maxTotalBytes:this.walMaxBytes*this.walRejectThreshold
      });
    }catch(error){const retryable=this.#retryableWal(error);if(retryable)return retryable;throw error;}
    if(outcome.classification==='duplicate'){
      this.metrics.inc('processor_duplicate_total');
      return{status:'duplicate',recordId:envelope.recordId};
    }
    if(outcome.classification==='conflict'){
      this.metrics.inc('processor_conflict_total');
      return{status:'conflict',recordId:envelope.recordId,errorCode:'RECORD_HASH_CONFLICT'};
    }
    const entry=outcome.entry;
    this.metrics.inc('processor_accepted_records_total');
    return{status:'accepted',recordId:envelope.recordId,receiptId:entry.record.receiptId,wal:{segment:entry.segment,offset:entry.offset}};
  }
}
