import { mkdir, open, readdir, readFile, rename, stat, truncate, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { crc32c } from './crc32c.js';
type WalRecord = Record<string, any>;
export interface WalEntry { segment:number; offset:number; offsetEnd:number; record:WalRecord }
export interface WalCheckpoint { segment:number; offsetEnd:number; updatedAt?:string }
type WalError = Error & { statusCode?:number; cause?:unknown };
type Classification = 'new'|'duplicate'|'conflict'|'semantic_conflict';

function providerIdentity(envelope:any):string|null{
  if(!envelope||typeof envelope!=='object')return null;
  const local=envelope.taskId??envelope.externalCommandId??envelope.payload?.externalCommandId??envelope.resourceId??envelope.externalExecutionId??envelope.providerEventId;
  if(typeof envelope.providerId!=='string'||typeof envelope.instanceId!=='string'||typeof local!=='string'||local.length===0)return null;
  return [envelope.providerId,envelope.instanceId,envelope.recordType,local].join('\u001f');
}
function providerRevision(envelope:any):string|null{
  const value=envelope.payload?.providerRevision??envelope.observationRevision??envelope.commandSequence;
  return typeof value==='string'||Number.isSafeInteger(value)?String(value):null;
}
function providerTerminal(envelope:any):string|null{
  const explicit=envelope.payload?.terminalStatus;
  if(typeof explicit==='string'&&explicit.length>0)return explicit;
  if(envelope.attributes?.terminal===true&&typeof envelope.payload?.currentState==='string')return envelope.payload.currentState;
  return null;
}

const HEADER=4, TRAILER=4; const segmentName=(id:number)=>`segment-${String(id).padStart(12,'0')}.wal`;
async function fsyncDirectory(path:string){ const dir=await open(path,'r'); try{await dir.sync();}finally{await dir.close();} }
export class WalStore {
  directory:string;
  segmentMaxBytes:number;
  maxPendingWrites:number;
  pendingWrites:number;
  writeError:WalError|null;
  entries:any[];
  dedup:Map<string,string>;
  providerRevisions:Map<string,string>;
  providerTerminals:Map<string,string>;
  providerSequenceHashes:Map<string,string>;
  providerSequenceMax:Map<string,number>;
  currentSegment:number;
  currentSize:number;
  totalBytes:number;
  checkpoints:Record<string,WalCheckpoint>;
  writeTail:Promise<void>;
  checkpointTail:Promise<void>;

  constructor({directory,segmentMaxBytes=64*1024*1024,maxPendingWrites=1024}:{directory:string;segmentMaxBytes?:number;maxPendingWrites?:number}){ if(!Number.isInteger(maxPendingWrites)||maxPendingWrites<1)throw new Error('WAL_MAX_PENDING_WRITES_INVALID'); this.directory=directory; this.segmentMaxBytes=segmentMaxBytes; this.maxPendingWrites=maxPendingWrites; this.pendingWrites=0; this.writeError=null; this.entries=[]; this.dedup=new Map(); this.providerRevisions=new Map(); this.providerTerminals=new Map(); this.providerSequenceHashes=new Map(); this.providerSequenceMax=new Map(); this.currentSegment=1; this.currentSize=0; this.totalBytes=0; this.checkpoints={}; this.writeTail=Promise.resolve(); this.checkpointTail=Promise.resolve(); }
  async initialize(){ await mkdir(this.directory,{recursive:true}); await this.#loadCheckpoints(); const names=(await readdir(this.directory)).filter(n=>/^segment-\d+\.wal$/.test(n)).sort(); if(!names.length){await this.#createSegment(1);this.#validateCheckpoints();return;} for(const name of names) await this.#scanSegment(name); const currentName=names.at(-1)!; this.currentSegment=Number(currentName.match(/\d+/)![0]); this.currentSize=(await stat(join(this.directory,currentName))).size; this.totalBytes=0; for(const n of names)this.totalBytes+=(await stat(join(this.directory,n))).size; this.#validateCheckpoints(); }
  async #loadCheckpoints(){
    let parsed:any;
    try{parsed=JSON.parse(await readFile(join(this.directory,'checkpoints.json'),'utf8'));}
    catch(error){if(error&&typeof error==='object'&&'code' in error&&error.code==='ENOENT'){this.checkpoints={};return;}throw Object.assign(new Error('WAL_CHECKPOINT_INVALID'),{cause:error});}
    const valid=parsed&&typeof parsed==='object'&&!Array.isArray(parsed)&&Object.values(parsed).every((value:any)=>value&&typeof value==='object'&&Number.isInteger(value.segment)&&value.segment>=0&&Number.isInteger(value.offsetEnd)&&value.offsetEnd>=0);
    if(!valid)throw new Error('WAL_CHECKPOINT_INVALID');
    this.checkpoints=parsed;
  }
  #validateCheckpoints(){
    const boundaries=new Set(this.entries.map(entry=>`${entry.segment}:${entry.offsetEnd}`));
    for(const checkpoint of Object.values(this.checkpoints))
      if((checkpoint.segment!==0||checkpoint.offsetEnd!==0)&&!boundaries.has(`${checkpoint.segment}:${checkpoint.offsetEnd}`))throw new Error('WAL_CHECKPOINT_INVALID');
  }
  async #createSegment(id:number){ const path=join(this.directory,segmentName(id)); const file=await open(path,'a'); await file.sync(); await file.close(); await fsyncDirectory(this.directory); this.currentSegment=id; this.currentSize=0; }
  async #scanSegment(name:string){ const id=Number(name.match(/\d+/)![0]), path=join(this.directory,name), data=await readFile(path); let offset=0; while(offset<data.length){ if(offset+HEADER>data.length){await truncate(path,offset);break;} const length=data.readUInt32BE(offset), end=offset+HEADER+length+TRAILER; if(length>16*1024*1024||end>data.length){await truncate(path,offset);break;} const payload=data.subarray(offset+HEADER,offset+HEADER+length), expected=data.readUInt32BE(offset+HEADER+length); if(crc32c(payload)!==expected){if(end===data.length){await truncate(path,offset);break;} throw new Error(`WAL_CRC_MISMATCH:${name}:${offset}`);} const record=JSON.parse(payload.toString('utf8')) as WalRecord; const entry={segment:id,offset,offsetEnd:end,record}; this.entries.push(entry); if(record.kind==='accepted'){this.dedup.set(`${record.sourceSystem}:${record.envelope.recordId}`,record.envelope.recordHash);this.#indexProviderEvent(record.envelope);} offset=end; } }
  classify(sourceSystem:string,recordId:string,recordHash:string):Classification{ const existing=this.dedup.get(`${sourceSystem}:${recordId}`); if(existing===undefined)return'new'; return existing===recordHash?'duplicate':'conflict'; }
  acceptedHash(sourceSystem:string,recordId:string){ return this.dedup.get(`${sourceSystem}:${recordId}`); }
  // Keep deduplication state, physical frames, and in-memory WAL offsets linearizable.
  #serializeWrite<T>(operation:()=>Promise<T>):Promise<T>{
    if(this.pendingWrites>=this.maxPendingWrites)return Promise.reject(Object.assign(new Error('WAL_WRITE_QUEUE_FULL'),{statusCode:503}));
    this.pendingWrites+=1;
    const result=this.writeTail.then(()=>{if(this.writeError)throw this.writeError;return operation();});
    this.writeTail=result.then(()=>undefined,()=>undefined);
    return result.finally(()=>{this.pendingWrites-=1;});
  }
  async #appendUnlocked(record:WalRecord,maxTotalBytes=Number.POSITIVE_INFINITY):Promise<WalEntry>{
    const payload=Buffer.from(JSON.stringify(record),'utf8'), frame=Buffer.allocUnsafe(HEADER+payload.length+TRAILER);
    frame.writeUInt32BE(payload.length,0);payload.copy(frame,HEADER);frame.writeUInt32BE(crc32c(payload),HEADER+payload.length);
    if(this.totalBytes+frame.length>maxTotalBytes)throw Object.assign(new Error('WAL_HIGH_WATER'),{statusCode:503});
    try{
      if(this.currentSize>0&&this.currentSize+frame.length>this.segmentMaxBytes)await this.#createSegment(this.currentSegment+1);
      const path=join(this.directory,segmentName(this.currentSegment)), offset=this.currentSize, file=await open(path,'a');
      try{await file.writeFile(frame);await file.sync();}finally{await file.close();}
      this.currentSize+=frame.length;this.totalBytes+=frame.length;
      const entry={segment:this.currentSegment,offset,offsetEnd:this.currentSize,record};this.entries.push(entry);
      if(record.kind==='accepted'){this.dedup.set(`${record.sourceSystem}:${record.envelope.recordId}`,record.envelope.recordHash);this.#indexProviderEvent(record.envelope);}
      return entry;
    }catch(error){
      this.writeError=Object.assign(new Error('WAL_WRITE_FAILED_RESTART_REQUIRED'),{statusCode:503,cause:error});
      throw this.writeError;
    }
  }
  async append(record:WalRecord,{maxTotalBytes=Number.POSITIVE_INFINITY}:{maxTotalBytes?:number}={}):Promise<WalEntry>{ return this.#serializeWrite(()=>this.#appendUnlocked(record,maxTotalBytes)); }
  async appendClassified({sourceSystem,recordId,recordHash,acceptedRecord,conflictRecord,maxTotalBytes=Number.POSITIVE_INFINITY}:{sourceSystem:string;recordId:string;recordHash:string;acceptedRecord:WalRecord;conflictRecord:(acceptedRecordHash:string|undefined)=>WalRecord;maxTotalBytes?:number}){
    return this.#serializeWrite(async()=>{
      const classification=this.classify(sourceSystem,recordId,recordHash);
      const acceptedRecordHash=this.acceptedHash(sourceSystem,recordId);
      if(classification==='duplicate')return{classification,acceptedRecordHash,entry:null};
      const quality=classification==='new'?this.#assessProviderEvent(acceptedRecord.envelope):null;
      if(quality?.blockingCode){
        const conflict={...conflictRecord(acceptedRecordHash),errorCode:quality.blockingCode,providerQuality:quality};
        const entry=await this.#appendUnlocked(conflict,maxTotalBytes);
        return{classification:'semantic_conflict' as const,acceptedRecordHash,entry,semanticCode:quality.blockingCode};
      }
      const record=classification==='new'?{...acceptedRecord,providerQuality:quality}:conflictRecord(acceptedRecordHash);
      const entry=await this.#appendUnlocked(record,maxTotalBytes);
      return{classification,acceptedRecordHash,entry};
    });
  }
  #assessProviderEvent(envelope:any){
    const identity=providerIdentity(envelope);const reasons:string[]=[];
    if(identity===null)return{status:'not_applicable',reasonCodes:reasons};
    const revision=providerRevision(envelope);
    if(revision!==null){const prior=this.providerRevisions.get(`${identity}\u001f${revision}`);if(prior!==undefined&&prior!==envelope.recordHash)return{status:'conflict',reasonCodes:['SMPP_PROVIDER_REVISION_CONFLICT'],blockingCode:'SMPP_PROVIDER_REVISION_CONFLICT'};}
    const terminal=providerTerminal(envelope);const priorTerminal=this.providerTerminals.get(identity);
    if(terminal!==null&&priorTerminal!==undefined&&priorTerminal!==terminal)return{status:'conflict',reasonCodes:['SMPP_PROVIDER_TERMINAL_CONFLICT'],blockingCode:'SMPP_PROVIDER_TERMINAL_CONFLICT'};
    const sequence=envelope.providerEventSequence;
    if(Number.isSafeInteger(sequence)){
      const sequenceKey=`${identity}\u001f${sequence}`;const priorHash=this.providerSequenceHashes.get(sequenceKey);
      if(priorHash!==undefined&&priorHash!==envelope.recordHash)return{status:'conflict',reasonCodes:['SMPP_PROVIDER_EVENT_SEQUENCE_CONFLICT'],blockingCode:'SMPP_PROVIDER_EVENT_SEQUENCE_CONFLICT'};
      const maximum=this.providerSequenceMax.get(identity);
      if(maximum!==undefined&&sequence<maximum)reasons.push('SMPP_PROVIDER_EVENT_OUT_OF_ORDER');
      else if(maximum!==undefined&&sequence>maximum+1)reasons.push('SMPP_PROVIDER_EVENT_SEQUENCE_GAP');
    }
    return{status:reasons.length?'accepted_with_quality_issue':'accepted',reasonCodes:reasons};
  }
  #indexProviderEvent(envelope:any){
    const identity=providerIdentity(envelope);if(identity===null)return;
    const revision=providerRevision(envelope);if(revision!==null)this.providerRevisions.set(`${identity}\u001f${revision}`,envelope.recordHash);
    const terminal=providerTerminal(envelope);if(terminal!==null)this.providerTerminals.set(identity,terminal);
    const sequence=envelope.providerEventSequence;if(Number.isSafeInteger(sequence)){this.providerSequenceHashes.set(`${identity}\u001f${sequence}`,envelope.recordHash);this.providerSequenceMax.set(identity,Math.max(sequence,this.providerSequenceMax.get(identity)??sequence));}
  }
  checkpoint(id:string):WalCheckpoint{ return this.checkpoints[id]??{segment:0,offsetEnd:0}; }
  pending(id:string,limit=200){ const cp=this.checkpoint(id); return this.entries.filter(e=>e.segment>cp.segment||(e.segment===cp.segment&&e.offsetEnd>cp.offsetEnd)).slice(0,limit); }
  // Target workers flush concurrently, so merge and replace their checkpoint file in order.
  #serializeCheckpoint<T>(operation:()=>Promise<T>):Promise<T>{ const result=this.checkpointTail.then(operation); this.checkpointTail=result.then(()=>undefined,()=>undefined); return result; }
  async commit(id:string,entry:WalEntry):Promise<WalCheckpoint>{
    return this.#serializeCheckpoint(async()=>{
      const current=this.checkpoint(id);
      if(entry.segment<current.segment||(entry.segment===current.segment&&entry.offsetEnd<=current.offsetEnd))return current;
      const next={segment:entry.segment,offsetEnd:entry.offsetEnd,updatedAt:new Date().toISOString()};
      const all={...this.checkpoints,[id]:next}, temp=join(this.directory,`checkpoints.${process.pid}.${randomUUID()}.tmp`), target=join(this.directory,'checkpoints.json');
      try{
        const file=await open(temp,'wx',0o600);
        try{await file.writeFile(JSON.stringify(all,null,2));await file.sync();}finally{await file.close();}
        await rename(temp,target);
        await fsyncDirectory(this.directory);
        this.checkpoints=all;return next;
      }catch(error){await unlink(temp).catch(()=>{});throw error;}
    });
  }
  async drain(){await this.writeTail;await this.checkpointTail;if(this.writeError)throw this.writeError;}
  stats(){ return {segments:new Set(this.entries.map(e=>e.segment)).size||1,entries:this.entries.length,totalBytes:this.totalBytes,currentBytes:this.currentSize,pendingWrites:this.pendingWrites,maxPendingWrites:this.maxPendingWrites,writeFailed:this.writeError!==null,checkpoints:this.checkpoints,pendingByCheckpoint:Object.fromEntries(Object.keys(this.checkpoints).map(id=>[id,this.pending(id,Number.MAX_SAFE_INTEGER).length]))}; }
}
