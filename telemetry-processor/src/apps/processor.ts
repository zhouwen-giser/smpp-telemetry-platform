import { randomUUID } from 'node:crypto';
import { validateEnvelope, validateTrustedIngress } from '../packages/validation/validation.js';

function safeSourceHint(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return {};
  const safe = {};
  for (const key of ['schemaName','schemaVersion','recordId','recordHash','recordType','providerId','instanceId']) {
    const value = envelope[key];
    if (typeof value === 'string' && /^[A-Za-z0-9._:-]{1,256}$/.test(value)) safe[key] = value;
  }
  return safe;
}

export class TelemetryProcessor {
  constructor({wal,mappings,metrics,requireCollectorId=true,allowedCollectorIds=[],walMaxBytes=10*1024*1024*1024,walRejectThreshold=0.98}) {
    this.wal=wal;
    this.mappings=mappings;
    this.metrics=metrics;
    this.requireCollectorId=requireCollectorId;
    this.allowedCollectorIds=allowedCollectorIds;
    this.walMaxBytes=walMaxBytes;
    this.walRejectThreshold=walRejectThreshold;
  }

  async #quarantine({code,message=code,receivedAt,trustedContext,envelope,mapping=null}) {
    const entry=await this.wal.append({
      kind:'rejected',sourceSystem:'smpp',rejectionId:randomUUID(),receivedAt,trustedContext,
      mapping,errorCode:code,errorSummary:String(message).slice(0,256),sourceHint:safeSourceHint(envelope)
    });
    this.metrics.inc('processor_quarantined_total',{reason:code});
    return entry.record.rejectionId;
  }

  async collect(logRecord) {
    this.metrics.inc('processor_received_records_total');
    if(this.wal.stats().totalBytes>=this.walMaxBytes*this.walRejectThreshold){
      this.metrics.inc('processor_retryable_total',{reason:'WAL_HIGH_WATER'});
      return{status:'rejected_retryable',errorCode:'WAL_HIGH_WATER'};
    }
    const ingress=validateTrustedIngress(logRecord,{requireCollectorId:this.requireCollectorId,allowedCollectorIds:this.allowedCollectorIds});
    if(!ingress.ok){
      this.metrics.inc('processor_permanent_reject_total',{reason:ingress.code});
      return{status:'rejected_permanent',errorCode:ingress.code};
    }
    const envelope=logRecord.body;
    const receivedAt=new Date().toISOString();
    const validation=validateEnvelope(envelope,logRecord.attributes);
    if(!validation.ok){
      const mapping=this.mappings.resolve({...ingress.context,providerId:typeof envelope?.providerId==='string'?envelope.providerId:'',instanceId:typeof envelope?.instanceId==='string'?envelope.instanceId:'',receivedAt:new Date(receivedAt)});
      const rejectionId=await this.#quarantine({code:validation.code,message:validation.message,receivedAt,trustedContext:ingress.context,envelope,mapping});
      this.metrics.inc('processor_permanent_reject_total',{reason:validation.code});
      return{status:'rejected_permanent',errorCode:validation.code,message:validation.message,rejectionId};
    }
    const mapping=this.mappings.resolve({...ingress.context,providerId:envelope.providerId,instanceId:envelope.instanceId,receivedAt:new Date(receivedAt)});
    if(!mapping){
      const rejectionId=await this.#quarantine({code:'SOURCE_UNMAPPED',receivedAt,trustedContext:ingress.context,envelope});
      this.metrics.inc('processor_permanent_reject_total',{reason:'SOURCE_UNMAPPED'});
      return{status:'rejected_permanent',errorCode:'SOURCE_UNMAPPED',rejectionId};
    }
    const sourceSystem='smpp';
    const classification=this.wal.classify(sourceSystem,envelope.recordId,envelope.recordHash);
    if(classification==='duplicate'){
      this.metrics.inc('processor_duplicate_total');
      return{status:'duplicate',recordId:envelope.recordId};
    }
    if(classification==='conflict'){
      await this.wal.append({kind:'conflict',sourceSystem,receiptId:randomUUID(),receivedAt,trustedContext:ingress.context,mapping,envelope,acceptedRecordHash:this.wal.acceptedHash(sourceSystem,envelope.recordId),summary:'sourceRecordId already exists with a different sourceRecordHash'});
      this.metrics.inc('processor_conflict_total');
      return{status:'conflict',recordId:envelope.recordId,errorCode:'RECORD_HASH_CONFLICT'};
    }
    const entry=await this.wal.append({kind:'accepted',sourceSystem,receiptId:randomUUID(),receivedAt,trustedContext:ingress.context,mapping,envelope});
    this.metrics.inc('processor_accepted_records_total');
    return{status:'accepted',recordId:envelope.recordId,receiptId:entry.record.receiptId,wal:{segment:entry.segment,offset:entry.offset}};
  }
}
