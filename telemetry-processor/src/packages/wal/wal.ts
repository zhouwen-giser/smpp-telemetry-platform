import { open, readdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import { readFileSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { crc32c } from './crc32c.js';
import { MAX_FRAME_BYTES, readFrame, scanFrames, segmentName } from './segment-reader.js';
import { archiveSegment, durableMkdir, fileSha256, fileSha256Sync, fsyncDirectory } from './archive.js';
import { WalFreeSpace, type WalFilesystemProbe } from './free-space.js';
import { DurableState } from '../durable-state/state.js';
import type { IndexedFrame, SegmentState, StateOperation } from '../durable-state/types.js';
import type { TelemetryWalRecord } from '../../../../packages/telemetry-types/src/index.js';
export type WalRecord = Record<string,unknown>;
function object(value:unknown):Record<string,unknown>{return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};}
function acceptedEnvelope(record:WalRecord):Record<string,unknown>&{recordId:string;recordHash:string}{const envelope=object(record.envelope);if(typeof envelope.recordId!=='string'||typeof envelope.recordHash!=='string')throw new Error('WAL_ACCEPTED_ENVELOPE_INVALID');return envelope as Record<string,unknown>&{recordId:string;recordHash:string};}
export interface WalEntry<T=WalRecord> {segment:number;offset:number;offsetEnd:number;record:T;walEpoch:string;ingestSequence:number}
/** Validate retained source context before handing an untyped frame to a telemetry projection. */
export function asTelemetryEntry(entry:WalEntry):WalEntry<TelemetryWalRecord>{
  const record=entry.record,trusted=object(record.trustedContext),mapping=object(record.mapping);
  if(!['accepted','conflict','rejected'].includes(String(record.kind))||typeof record.sourceSystem!=='string'||typeof record.receivedAt!=='string'||typeof trusted.collectorId!=='string'||typeof trusted.deploymentId!=='string')throw new Error('WAL_TELEMETRY_RECORD_INVALID');
  if(record.mapping!==null&&(!['tenantId','projectId','environment','sourceProduct'].every(key=>typeof mapping[key]==='string')||!Array.isArray(mapping.projectionRouteIds)))throw new Error('WAL_TELEMETRY_MAPPING_INVALID');
  if(record.kind==='rejected'){
    if(typeof record.rejectionId!=='string'||typeof record.errorCode!=='string'||typeof record.errorSummary!=='string'||!record.sourceHint||typeof record.sourceHint!=='object')throw new Error('WAL_TELEMETRY_REJECTION_INVALID');
  }else{
    const envelope=acceptedEnvelope(record);
    if(record.mapping===null||envelope.schemaName!=='sdar.provider.ops.event'||envelope.schemaVersion!=='1.1.0'||!['recordType','eventCategory','occurredAt','emittedAt','providerId','runtimeVersion','instanceId'].every(key=>typeof envelope[key]==='string')||!envelope.attributes||typeof envelope.attributes!=='object')throw new Error('WAL_TELEMETRY_ENVELOPE_INVALID');
  }
  return entry as unknown as WalEntry<TelemetryWalRecord>;
}
export interface WalCheckpoint {segment:number;offsetEnd:number;updatedAt?:string}
export interface TargetRegistration {id:string;generation:string;startSequence:number;status:'active'|'paused'|'retired';registeredAt:string;retiredAt?:string;retirementReason?:string;unprocessedThrough?:number}
export interface WalPin {id:string;owner:string;kind:'reader'|'replay'|'dlq';fromSequence:number;throughSequence:number;expiresAt?:string}
type WalError=Error&{statusCode?:number;cause?:unknown};
type Classification='new'|'duplicate'|'conflict'|'semantic_conflict';
const owners=new Map<string,WalStore>();
function processStart(pid:number):string|undefined{try{const value=readFileSync(`/proc/${pid}/stat`,'utf8');return value.slice(value.lastIndexOf(')')+2).split(' ')[19];}catch{return undefined;}}
const identityKey=(source:string,id:string)=>JSON.stringify([source,id]);
function providerIdentity(value:unknown):string|null{
  const envelope=object(value);
  if(!envelope||typeof envelope!=='object')return null;
  const local=envelope.providerEventId??envelope.externalCommandId??object(envelope.payload).externalCommandId??envelope.taskId??envelope.resourceId??envelope.externalExecutionId;
  if(typeof envelope.providerId!=='string'||typeof envelope.instanceId!=='string'||typeof local!=='string'||!local)return null;
  return[envelope.providerId,envelope.instanceId,envelope.recordType,local].join('\u001f');
}
function providerRevision(envelope:Record<string,unknown>):string|null{const value=object(envelope.payload).providerRevision??envelope.observationRevision??envelope.commandSequence;return typeof value==='string'||Number.isSafeInteger(value)?String(value):null;}
function providerTerminal(envelope:Record<string,unknown>):string|null{const payload=object(envelope.payload),value=payload.terminalStatus;if(typeof value==='string'&&value)return value;if(object(envelope.attributes).terminal===true&&typeof payload.currentState==='string')return payload.currentState;return null;}
const isMissing=(error:unknown)=>Boolean(error&&typeof error==='object'&&'code'in error&&error.code==='ENOENT');
async function atomicJson(directory:string,name:string,value:unknown):Promise<void>{
  const temp=join(directory,`.${name}.${randomUUID()}.tmp`);try{const file=await open(temp,'wx',0o600);try{await file.writeFile(JSON.stringify(value,null,2));await file.sync();}finally{await file.close();}await rename(temp,join(directory,name));await fsyncDirectory(directory);}finally{await unlink(temp).catch(()=>{});}
}

export class WalStore {
  readonly directory:string;
  readonly segmentMaxBytes:number;
  readonly maxPendingWrites:number;
  readonly archiveDirectory:string;
  readonly gcEnabled:boolean;
  state!:DurableState;
  walEpoch='';
  pendingWrites=0;
  writeError:WalError|null=null;
  currentSegment=1;
  currentSize=0;
  totalBytes=0;
  checkpoints:Record<string,WalCheckpoint>={};
  writeTail:Promise<void>=Promise.resolve();
  checkpointTail:Promise<void>=Promise.resolve();
  private initialized=false;
  private fenced=false;
  private closing=false;
  private lockId=randomUUID();
  private cache=new Map<number,WalEntry>();
  private cacheBytes=0;
  private verifiedArchives=new Map<number,{hash:string;size:number;mtimeMs:number;ctimeMs:number}>();
  private readonly cacheMaxBytes:number;
  private readonly freeSpace:WalFreeSpace;
  private observedTargets=new Set<string>();
  private maintenanceTail:Promise<void>=Promise.resolve();
  constructor({directory,segmentMaxBytes=64*1024*1024,maxPendingWrites=1024,cacheMaxBytes=8*1024*1024,archiveDirectory,gcEnabled=false,minFreeBytes=64*1024*1024,freeSpaceSampleMs=1000,filesystemProbe}:{directory:string;segmentMaxBytes?:number;maxPendingWrites?:number;cacheMaxBytes?:number;archiveDirectory?:string;gcEnabled?:boolean;minFreeBytes?:number;freeSpaceSampleMs?:number;filesystemProbe?:WalFilesystemProbe}){
    if(!Number.isInteger(maxPendingWrites)||maxPendingWrites<1)throw new Error('WAL_MAX_PENDING_WRITES_INVALID');
    if(!Number.isSafeInteger(segmentMaxBytes)||segmentMaxBytes<1)throw new Error('WAL_SEGMENT_SIZE_INVALID');
    if(!Number.isSafeInteger(cacheMaxBytes)||cacheMaxBytes<0)throw new Error('WAL_CACHE_SIZE_INVALID');
    this.directory=resolve(directory);this.segmentMaxBytes=segmentMaxBytes;this.maxPendingWrites=maxPendingWrites;this.cacheMaxBytes=cacheMaxBytes;this.archiveDirectory=resolve(archiveDirectory??join(directory,'archive'));this.gcEnabled=gcEnabled;
    this.freeSpace=new WalFreeSpace(this.directory,this.archiveDirectory,minFreeBytes,freeSpaceSampleMs,filesystemProbe);
  }
  private assertOpen(){if(this.fenced)throw new Error('WAL_STORE_FENCED');if(!this.initialized)throw new Error('WAL_NOT_INITIALIZED');}
  async initialize():Promise<void>{
    if(this.fenced)throw new Error('WAL_STORE_FENCED');
    if(this.initialized&&!this.fenced)return;
    const previous=owners.get(this.directory);if(previous&&previous!==this)await previous.close();
    await durableMkdir(this.directory);owners.set(this.directory,this);
    try{
      const legacy=await this.loadCheckpoints();
      let marker:{version:number;walEpoch:string}|undefined;
      try{marker=JSON.parse(await readFile(join(this.directory,'wal-format.json'),'utf8'));if(marker?.version!==2||typeof marker.walEpoch!=='string')throw new Error('WAL_FORMAT_UNSUPPORTED');}catch(error){if(!isMissing(error))throw error;}
      try{await stat(join(this.directory,'state.sqlite'));}catch(error){if(!isMissing(error))throw error;if(marker)throw new Error('WAL_STATE_MISSING_RESTORE_REQUIRED');}
      this.state=new DurableState(join(this.directory,'state.sqlite'));await this.state.ready;await atomicJson(this.directory,'writer.lock',{pid:process.pid,processStart:processStart(process.pid),id:this.lockId,authority:'owner.sqlite-exclusive-lock'});this.walEpoch=this.state.meta().walEpoch;
      if(marker&&marker.walEpoch!==this.walEpoch)throw new Error('WAL_STATE_EPOCH_MISMATCH');
      const names=(await readdir(this.directory)).filter(name=>/^segment-\d+\.wal$/.test(name)).sort();
      await this.recoverCompaction();
      const existingNames=(await readdir(this.directory)).filter(name=>/^segment-\d+\.wal$/.test(name)).sort();
      const known=this.state.segments();
      for(const segment of known){if(segment.gcState==='hot'&&!existingNames.includes(segmentName(segment.segment)))throw new Error(`WAL_SEGMENT_MISSING:${segment.segment}`);}
      for(const name of existingNames){
        const id=Number(name.match(/\d+/)![0]),path=join(this.directory,name),saved=this.state.segment(id);
        if(saved?.gcState==='complete')throw new Error('WAL_COMPACTED_SEGMENT_REAPPEARED');
        if(saved&&saved.indexedThrough>0){const last=this.state.frameAt(id,saved.indexedThrough);if(!last)throw new Error('WAL_INDEX_BOUNDARY_INVALID');const raw=readFrame(path,last.offset,last.offsetEnd);if(raw.crc!==last.crc)throw new Error('WAL_INDEX_CRC_MISMATCH');}
        for await(const raw of scanFrames(path,saved?.indexedThrough??0,name===existingNames.at(-1)&&!saved?.closed)){
          const next=this.state.lastSequence()+1;
          if(raw.record._wal!==undefined&&(object(raw.record._wal).epoch!==this.walEpoch||object(raw.record._wal).ingestSequence!==next))throw new Error('WAL_FRAME_SEQUENCE_MISMATCH');
          await this.state.indexFrame({ingestSequence:next,segment:id,offset:raw.offset,offsetEnd:raw.offsetEnd,crc:raw.crc,kind:String(raw.record.kind??'unknown')},await this.indexOperations(raw.record));
        }
        const bytes=(await stat(path)).size;
        const current=this.state.segment(id)??{segment:id,bytes:0,indexedThrough:0,firstSequence:0,lastSequence:0,closed:false,archivePath:null,archiveHash:null,gcState:'hot' as const};
        await this.state.saveSegment({...current,bytes,closed:name!==existingNames.at(-1)||current.closed});
      }
      for(const [id,checkpoint]of Object.entries(legacy)){
        this.validateBoundary(checkpoint);
        const persisted=this.state.get<WalCheckpoint>('checkpoint',id);
        if(!persisted)await this.state.put('checkpoint',id,checkpoint);
      }
      this.checkpoints=Object.fromEntries(this.scanAll<WalCheckpoint>('checkpoint').map(item=>[item.key,item.value]));
      for(const checkpoint of Object.values(this.checkpoints))this.validateBoundary(checkpoint);
      if(existingNames.length){const last=existingNames.at(-1)!;this.currentSegment=Number(last.match(/\d+/)![0]);this.currentSize=(await stat(join(this.directory,last))).size;if(this.state.segment(this.currentSegment)?.closed)await this.createSegment(this.currentSegment+1);}
      else{const maximum=Math.max(0,...known.map(s=>s.segment),...names.map(name=>Number(name.match(/\d+/)![0])));await this.createSegment(maximum+1);}
      this.totalBytes=this.state.segments().filter(s=>s.gcState!=='complete').reduce((sum,s)=>sum+s.bytes,0);
      await atomicJson(this.directory,'wal-format.json',{version:2,minimumReaderVersion:2,walEpoch:this.walEpoch,gcEnabled:this.gcEnabled});
      for(const id of Object.keys(this.checkpoints)){if(!this.state.get('target',id))await this.state.put('target',id,{id,generation:'legacy',startSequence:0,status:'active',registeredAt:new Date().toISOString()} satisfies TargetRegistration);}
      await this.freeSpace.start();this.initialized=true;this.fenced=false;
    }catch(error){await this.freeSpace.close();await this.state?.close().catch(()=>{});await this.releaseLock();if(owners.get(this.directory)===this)owners.delete(this.directory);throw error;}
  }
  private async releaseLock(){try{const owner=JSON.parse(await readFile(join(this.directory,'writer.lock'),'utf8'));if(owner.id===this.lockId){await unlink(join(this.directory,'writer.lock'));await fsyncDirectory(this.directory);}}catch(error){if(!isMissing(error)&&!(error instanceof SyntaxError))throw error;}}
  private async loadCheckpoints():Promise<Record<string,WalCheckpoint>>{
    let parsed:unknown;try{parsed=JSON.parse(await readFile(join(this.directory,'checkpoints.json'),'utf8'));}catch(error){if(isMissing(error))return{};throw Object.assign(new Error('WAL_CHECKPOINT_INVALID'),{cause:error});}
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)||!Object.values(parsed).every(value=>Number.isSafeInteger(object(value).segment)&&Number(object(value).segment)>=0&&Number.isSafeInteger(object(value).offsetEnd)&&Number(object(value).offsetEnd)>=0))throw new Error('WAL_CHECKPOINT_INVALID');return parsed as Record<string,WalCheckpoint>;
  }
  private validateBoundary(checkpoint:WalCheckpoint){if((checkpoint.segment!==0||checkpoint.offsetEnd!==0)&&!this.state.frameAt(checkpoint.segment,checkpoint.offsetEnd))throw new Error('WAL_CHECKPOINT_INVALID');}
  private async createSegment(id:number){
    if(this.currentSize>0){const previous=await this.state.segmentAsync(this.currentSegment);if(previous)await this.state.saveSegment({...previous,closed:true});}
    const file=await open(join(this.directory,segmentName(id)),'wx',0o600);try{await file.sync();}finally{await file.close();}await fsyncDirectory(this.directory);
    await this.state.saveSegment({segment:id,bytes:0,indexedThrough:0,firstSequence:0,lastSequence:0,closed:false,archivePath:null,archiveHash:null,gcState:'hot'});this.currentSegment=id;this.currentSize=0;
  }
  private scanAll<T>(namespace:string):Array<{key:string;value:T}>{const result:Array<{key:string;value:T}>=[];let after:string|undefined;for(;;){const page=this.state.scan<T>(namespace,{limit:1000,...(after===undefined?{}:{after})});result.push(...page);if(page.length<1000)return result;after=page.at(-1)!.key;}}
  private async indexOperations(record:WalRecord):Promise<StateOperation[]>{
    if(record.kind!=='accepted')return[];
    const envelope=acceptedEnvelope(record);if(typeof record.sourceSystem!=='string')throw new Error('WAL_SOURCE_SYSTEM_INVALID');const key=identityKey(record.sourceSystem,envelope.recordId),existing=await this.state.getAsync<string>('accepted',key);
    if(existing!==undefined&&existing!==envelope.recordHash)throw new Error('WAL_ACCEPTED_IDENTITY_CONFLICT');
    const operations:StateOperation[]=[{type:'put',namespace:'accepted',key,value:envelope.recordHash}];
    if(existing===undefined)operations.push({type:'put',namespace:'accepted_metadata',key,value:{walEpoch:this.walEpoch,ingestSequence:object(record._wal).ingestSequence??await this.state.lastSequenceAsync()+1,recordHash:envelope.recordHash,receivedAt:record.receivedAt??null,providerQuality:record.providerQuality??null}});
    const identity=providerIdentity(envelope);if(identity===null)return operations;
    const revision=providerRevision(envelope);if(revision!==null)operations.push({type:'put',namespace:'provider_revision',key:`${identity}\u001f${revision}`,value:envelope.recordHash});
    const terminal=providerTerminal(envelope);if(terminal!==null)operations.push({type:'put',namespace:'provider_terminal',key:identity,value:terminal});
    const sequence=envelope.providerEventSequence;if(typeof sequence==='number'&&Number.isSafeInteger(sequence)){operations.push({type:'put',namespace:'provider_sequence',key:`${identity}\u001f${sequence}`,value:envelope.recordHash},{type:'put',namespace:'provider_sequence_max',key:identity,value:Math.max(sequence,(await this.state.getAsync<number>('provider_sequence_max',identity))??sequence)});}
    return operations;
  }
  classify(sourceSystem:string,recordId:string,recordHash:string):Classification{const existing=this.acceptedHash(sourceSystem,recordId);return existing===undefined?'new':existing===recordHash?'duplicate':'conflict';}
  acceptedHash(sourceSystem:string,recordId:string):string|undefined{this.assertOpen();return this.state.get<string>('accepted',identityKey(sourceSystem,recordId));}
  private serializeWrite<T>(operation:()=>Promise<T>):Promise<T>{
    try{this.assertOpen();if(this.closing)throw new Error('WAL_STORE_FENCED');}catch(error){return Promise.reject(error);}
    if(this.pendingWrites>=this.maxPendingWrites)return Promise.reject(Object.assign(new Error('WAL_WRITE_QUEUE_FULL'),{statusCode:503}));this.pendingWrites++;
    const result=this.writeTail.then(()=>{this.assertOpen();if(this.writeError)throw this.writeError;return operation();});this.writeTail=result.then(()=>undefined,()=>undefined);return result.finally(()=>{this.pendingWrites--;});
  }
  private remember(entry:WalEntry){const bytes=entry.offsetEnd-entry.offset;if(bytes>this.cacheMaxBytes)return;while(this.cache.size&&(this.cacheBytes+bytes>this.cacheMaxBytes||this.cache.size>=256)){const key=this.cache.keys().next().value!;const old=this.cache.get(key)!;this.cache.delete(key);this.cacheBytes-=old.offsetEnd-old.offset;}this.cache.set(entry.ingestSequence,structuredClone(entry));this.cacheBytes+=bytes;}
  private async appendUnlocked(record:WalRecord,maxTotalBytes=Infinity):Promise<WalEntry>{
    const ingestSequence=await this.state.lastSequenceAsync()+1,stored={...record,_wal:{epoch:this.walEpoch,ingestSequence}},payload=Buffer.from(JSON.stringify(stored),'utf8');
    if(payload.length>MAX_FRAME_BYTES)throw Object.assign(new Error('WAL_FRAME_TOO_LARGE'),{statusCode:413});
    const frame=Buffer.allocUnsafe(payload.length+8);frame.writeUInt32BE(payload.length,0);payload.copy(frame,4);const crc=crc32c(payload);frame.writeUInt32BE(crc,payload.length+4);
    if(this.totalBytes+frame.length>maxTotalBytes)throw Object.assign(new Error('WAL_HIGH_WATER'),{statusCode:503});
    await this.freeSpace.assertWritable(frame.length);
    try{
      if(this.currentSize>0&&this.currentSize+frame.length>this.segmentMaxBytes)await this.createSegment(this.currentSegment+1);
      const offset=this.currentSize,file=await open(join(this.directory,segmentName(this.currentSegment)),'a');try{await file.writeFile(frame);await file.sync();}finally{await file.close();}
      this.currentSize+=frame.length;this.totalBytes+=frame.length;this.freeSpace.consume(frame.length);
      const entry:WalEntry={segment:this.currentSegment,offset,offsetEnd:this.currentSize,record:stored,walEpoch:this.walEpoch,ingestSequence};
      await this.state.indexFrame({ingestSequence,segment:entry.segment,offset,offsetEnd:entry.offsetEnd,crc,kind:String(record.kind??'unknown')},await this.indexOperations(stored));this.remember(entry);return entry;
    }catch(error){this.writeError=Object.assign(new Error('WAL_WRITE_FAILED_RESTART_REQUIRED'),{statusCode:503,cause:error});throw this.writeError;}
  }
  append<T extends object>(record:T,{maxTotalBytes=Infinity}:{maxTotalBytes?:number}={}):Promise<WalEntry<T>>{return this.serializeWrite(()=>this.appendUnlocked(record as WalRecord,maxTotalBytes)) as Promise<WalEntry<T>>;}
  appendClassified({sourceSystem,recordId,recordHash,acceptedRecord,conflictRecord,maxTotalBytes=Infinity}:{sourceSystem:string;recordId:string;recordHash:string;acceptedRecord:WalRecord;conflictRecord:(acceptedRecordHash:string|undefined)=>WalRecord;maxTotalBytes?:number}){
    return this.serializeWrite(async()=>{
      const acceptedRecordHash=await this.state.getAsync<string>('accepted',identityKey(sourceSystem,recordId));const classification:Classification=acceptedRecordHash===undefined?'new':acceptedRecordHash===recordHash?'duplicate':'conflict';if(classification==='duplicate')return{classification,acceptedRecordHash,entry:null};
      const quality=classification==='new'?await this.assessProviderEvent(acceptedRecord.envelope):null;
      if(quality?.blockingCode){const entry=await this.appendUnlocked({...conflictRecord(acceptedRecordHash),errorCode:quality.blockingCode,providerQuality:quality},maxTotalBytes);return{classification:'semantic_conflict' as const,acceptedRecordHash,entry,semanticCode:quality.blockingCode};}
      const record=classification==='new'?{...acceptedRecord,providerQuality:quality}:conflictRecord(acceptedRecordHash);const entry=await this.appendUnlocked(record,maxTotalBytes);return{classification,acceptedRecordHash,entry};
    });
  }
  private async assessProviderEvent(input:unknown):Promise<{status:string;reasonCodes:string[];blockingCode?:string;observedSequence?:number;previousMaximum?:number;gapStart?:number;gapEnd?:number}>{
    const envelope=object(input),identity=providerIdentity(envelope),reasons:string[]=[];if(identity===null)return{status:'not_applicable',reasonCodes:reasons};
    const conflict=(code:string)=>({status:'conflict',reasonCodes:[code],blockingCode:code});const revision=providerRevision(envelope);
    if(revision!==null){const prior=await this.state.getAsync<string>('provider_revision',`${identity}\u001f${revision}`);if(prior!==undefined&&prior!==envelope.recordHash)return conflict('SMPP_PROVIDER_REVISION_CONFLICT');}
    const terminal=providerTerminal(envelope),priorTerminal=await this.state.getAsync<string>('provider_terminal',identity);if(terminal!==null&&priorTerminal!==undefined&&priorTerminal!==terminal)return conflict('SMPP_PROVIDER_TERMINAL_CONFLICT');
    const sequence=envelope.providerEventSequence;let details={};if(typeof sequence==='number'&&Number.isSafeInteger(sequence)){
      const prior=await this.state.getAsync<string>('provider_sequence',`${identity}\u001f${sequence}`);if(prior!==undefined&&prior!==envelope.recordHash)return conflict('SMPP_PROVIDER_EVENT_SEQUENCE_CONFLICT');
      const maximum=await this.state.getAsync<number>('provider_sequence_max',identity);details={observedSequence:sequence,...(maximum===undefined?{}:{previousMaximum:maximum})};
      if(maximum!==undefined&&sequence<maximum)reasons.push('SMPP_PROVIDER_EVENT_OUT_OF_ORDER');else if(maximum!==undefined&&sequence>maximum+1){reasons.push('SMPP_PROVIDER_EVENT_SEQUENCE_GAP');details={...details,gapStart:maximum+1,gapEnd:sequence-1};}
    }
    return{status:reasons.length?'accepted_with_quality_issue':'accepted',reasonCodes:reasons,...details};
  }
  checkpoint(id:string):WalCheckpoint{this.assertOpen();return this.checkpoints[id]??{segment:0,offsetEnd:0};}
  checkpointSequence(id:string):number{const cp=this.checkpoints[id];if(cp)return this.state.frameAt(cp.segment,cp.offsetEnd)?.ingestSequence??0;return this.state.get<TargetRegistration>('target',id)?.startSequence??0;}
  acceptedCount(after=0,through?:number):number{this.assertOpen();return this.state.frameCount(after,through,'accepted');}
  firstAcceptedAfter(sequence:number):WalEntry|undefined{this.assertOpen();const frame=this.state.framesAfter(sequence,1,undefined,'accepted')[0];return frame?this.entry(frame):undefined;}
  private entry(frame:IndexedFrame):WalEntry{
    const cached=this.cache.get(frame.ingestSequence);if(cached)return structuredClone(cached);
    const segment=this.state.segment(frame.segment);if(!segment)throw new Error('WAL_SEGMENT_UNKNOWN');const path=segment.gcState==='complete'?segment.archivePath:join(this.directory,segmentName(frame.segment));if(!path)throw new Error('WAL_ARCHIVE_MISSING');
    if(segment.gcState==='complete'){
      const info=statSync(path),verified=this.verifiedArchives.get(segment.segment);
      if(!verified||verified.hash!==segment.archiveHash||verified.size!==info.size||verified.mtimeMs!==info.mtimeMs||verified.ctimeMs!==info.ctimeMs){
        if(info.size!==segment.bytes||fileSha256Sync(path)!==segment.archiveHash)throw new Error('WAL_ARCHIVE_VERIFY_FAILED');
        if(this.verifiedArchives.size>=8)this.verifiedArchives.delete(this.verifiedArchives.keys().next().value!);
        this.verifiedArchives.set(segment.segment,{hash:segment.archiveHash!,size:info.size,mtimeMs:info.mtimeMs,ctimeMs:info.ctimeMs});
      }
    }
    const raw=readFrame(path,frame.offset,frame.offsetEnd);if(raw.crc!==frame.crc)throw new Error('WAL_INDEX_CRC_MISMATCH');const entry={segment:frame.segment,offset:frame.offset,offsetEnd:frame.offsetEnd,record:raw.record,walEpoch:this.walEpoch,ingestSequence:frame.ingestSequence};this.remember(entry);return structuredClone(entry);
  }
  readEntries(afterSequence=0,limit=200,throughSequence?:number):WalEntry[]{this.assertOpen();return this.state.framesAfter(afterSequence,Math.min(limit,10000),throughSequence).map(frame=>this.entry(frame));}
  private observeTarget(id:string):void{if(!this.observedTargets.has(id)){this.state.observeTarget(id);this.observedTargets.add(id);}}
  pending(id:string,limit=200):WalEntry[]{this.assertOpen();if(!Number.isSafeInteger(limit)||limit<1)throw new Error('WAL_READ_LIMIT_INVALID');this.observeTarget(id);return this.readEntries(this.checkpointSequence(id),Math.min(limit,10000));}
  pendingCount(id:string):number{this.assertOpen();this.observeTarget(id);return this.state.frameCount(this.checkpointSequence(id));}
  /** Legacy inspection accessor. Normal ingestion and recovery never materialize the complete history. */
  get entries():WalEntry[]{this.assertOpen();const result:WalEntry[]=[];let after=0;for(;;){const page=this.readEntries(after,1000);result.push(...page);if(page.length<1000)return result;after=page.at(-1)!.ingestSequence;}}
  async registerTarget(id:string,{start='beginning',generation='legacy'}:{start?:'beginning'|'current';generation?:string}={}):Promise<TargetRegistration>{
    this.assertOpen();if(!id||!generation)throw new Error('WAL_TARGET_ID_INVALID');const existing=this.state.get<TargetRegistration>('target',id);if(existing){if(existing.generation!==generation)throw new Error('WAL_TARGET_GENERATION_MISMATCH');if(existing.status==='retired')throw new Error('WAL_TARGET_RETIRED');return existing;}
    const value:TargetRegistration={id,generation,startSequence:start==='current'?this.state.lastSequence():0,status:'active',registeredAt:new Date().toISOString()};await this.state.transaction([{type:'check',namespace:'target',key:id,expected:null},{type:'put',namespace:'target',key:id,value},{type:'increment',namespace:'wal',key:'protectionRevision'}]);return value;
  }
  async retireTarget(id:string,reason:string):Promise<void>{this.assertOpen();if(!reason.trim())throw new Error('WAL_TARGET_RETIREMENT_REASON_REQUIRED');const current=this.state.get<TargetRegistration>('target',id);if(!current)throw new Error('WAL_TARGET_UNKNOWN');await this.state.transaction([{type:'put',namespace:'target',key:id,value:{...current,status:'retired',retiredAt:new Date().toISOString(),retirementReason:reason,unprocessedThrough:this.state.lastSequence()}},{type:'increment',namespace:'wal',key:'protectionRevision'}]);}
  async pin(pin:WalPin):Promise<void>{this.assertOpen();if(!pin.id||!pin.owner||!Number.isSafeInteger(pin.fromSequence)||!Number.isSafeInteger(pin.throughSequence)||pin.fromSequence<1||pin.throughSequence<pin.fromSequence||pin.throughSequence>this.state.lastSequence()||(pin.expiresAt!==undefined&&!Number.isFinite(Date.parse(pin.expiresAt))))throw new Error('WAL_PIN_INVALID');const revision=this.state.get<number>('wal','protectionRevision')??null;if(this.state.segments().some(s=>s.gcState==='planned'&&pin.fromSequence<=s.lastSequence&&pin.throughSequence>=s.firstSequence))throw new Error('WAL_GC_IN_PROGRESS');await this.state.transaction([{type:'check',namespace:'wal',key:'protectionRevision',expected:revision},{type:'put',namespace:'pin',key:pin.id,value:pin},{type:'increment',namespace:'wal',key:'protectionRevision'}]);}
  async releasePin(id:string):Promise<void>{this.assertOpen();await this.state.transaction([{type:'delete',namespace:'pin',key:id},{type:'increment',namespace:'wal',key:'protectionRevision'}]);}
  private serializeCheckpoint<T>(operation:()=>Promise<T>):Promise<T>{const result=this.checkpointTail.then(()=>{this.assertOpen();return operation();});this.checkpointTail=result.then(()=>undefined,()=>undefined);return result;}
  commit(id:string,entry:WalEntry<unknown>,{operations=[]}:{operations?:StateOperation[]}={}):Promise<WalCheckpoint>{
    if(this.closing)return Promise.reject(new Error('WAL_STORE_FENCED'));
    return this.serializeCheckpoint(async()=>{
      this.validateBoundary(entry);if(entry.walEpoch!==undefined&&entry.walEpoch!==this.walEpoch)throw new Error('WAL_CHECKPOINT_EPOCH_MISMATCH');
      const protection:StateOperation[]=operations.some(operation=>operation.namespace==='pin'||operation.namespace==='target')?[{type:'increment',namespace:'wal',key:'protectionRevision'}]:[];
      const current=this.checkpoint(id);if(entry.segment<current.segment||(entry.segment===current.segment&&entry.offsetEnd<=current.offsetEnd)){if(operations.length)await this.state.transaction([...operations,...protection]);return current;}
      const next={segment:entry.segment,offsetEnd:entry.offsetEnd,updatedAt:new Date().toISOString()};
      const target=this.state.get<TargetRegistration>('target',id);const registration:StateOperation[]=target?[]:[{type:'put',namespace:'target',key:id,value:{id,generation:'legacy',startSequence:0,status:'active',registeredAt:next.updatedAt} satisfies TargetRegistration},{type:'increment',namespace:'wal',key:'protectionRevision'}];
      await this.state.transaction([...registration,...operations,...protection,{type:'put',namespace:'checkpoint',key:id,value:next}]);this.checkpoints={...this.checkpoints,[id]:next};
      await atomicJson(this.directory,'checkpoints.json',this.checkpoints);return next;
    });
  }
  private serializeMaintenance<T>(operation:()=>Promise<T>):Promise<T>{const result=this.maintenanceTail.then(()=>{this.assertOpen();return operation();});this.maintenanceTail=result.then(()=>undefined,()=>undefined);return result;}
  archiveClosedSegments():Promise<SegmentState[]>{return this.serializeMaintenance(()=>this.archiveClosedSegmentsUnlocked());}
  private async archiveClosedSegmentsUnlocked():Promise<SegmentState[]>{
    this.assertOpen();await this.writeTail;const result:SegmentState[]=[];
    for(const segment of this.state.segments().filter(s=>s.closed&&s.gcState==='hot'&&!s.archivePath)){
      if(segment.indexedThrough!==segment.bytes)throw new Error('WAL_ARCHIVE_UNINDEXED_SEGMENT');
      const archived=await archiveSegment(join(this.directory,segmentName(segment.segment)),join(this.archiveDirectory,this.walEpoch),segmentName(segment.segment));
      if(archived.bytes!==segment.bytes)throw new Error('WAL_ARCHIVE_SIZE_MISMATCH');const next={...segment,archivePath:archived.path,archiveHash:archived.hash};await this.state.saveSegment(next);result.push(next);
    }
    return result;
  }
  compact({dryRun=true}:{dryRun?:boolean}={}):Promise<{dryRun:boolean;eligible:number[];reclaimedBytes:number;blocked:Array<{segment:number;reason:string}>}>{return this.serializeMaintenance(()=>this.compactUnlocked(dryRun));}
  private async compactUnlocked(dryRun:boolean):Promise<{dryRun:boolean;eligible:number[];reclaimedBytes:number;blocked:Array<{segment:number;reason:string}>}>{
    this.assertOpen();await this.writeTail;await this.checkpointTail;
    const protectionRevision=this.state.get<number>('wal','protectionRevision')??null;
    const targets=this.scanAll<TargetRegistration>('target').map(item=>item.value),pins=this.scanAll<WalPin>('pin').map(item=>item.value).filter(pin=>!pin.expiresAt||Date.parse(pin.expiresAt)>Date.now());
    const unknown=this.scanAll('observed_target').filter(item=>!targets.some(target=>target.id===item.key));if(!targets.length||unknown.length)throw new Error('WAL_GC_TARGET_REGISTRY_INCOMPLETE');
    const eligible:SegmentState[]=[],blocked:Array<{segment:number;reason:string}>=[];
    for(const segment of this.state.segments().filter(s=>s.gcState==='hot')){
      let reason='';if(!segment.closed)reason='open_segment';else if(segment.indexedThrough!==segment.bytes)reason='unindexed';else if(!segment.archiveHash||!segment.archivePath)reason='unarchived';else if(targets.some(t=>t.status!=='retired'&&Math.max(t.startSequence,this.checkpointSequence(t.id))<segment.lastSequence))reason='target_pending';else if(pins.some(pin=>pin.fromSequence<=segment.lastSequence&&pin.throughSequence>=segment.firstSequence))reason='pinned';
      if(reason)blocked.push({segment:segment.segment,reason});else eligible.push(segment);
    }
    if(dryRun)return{dryRun:true,eligible:eligible.map(s=>s.segment),reclaimedBytes:0,blocked};if(!this.gcEnabled)throw new Error('WAL_GC_DISABLED');
    for(const segment of eligible){if(await fileSha256(segment.archivePath!)!==segment.archiveHash)throw new Error('WAL_ARCHIVE_VERIFY_FAILED');}
    await this.state.planGc(eligible.map(s=>s.segment),[{type:'check',namespace:'wal',key:'protectionRevision',expected:protectionRevision},{type:'increment',namespace:'wal',key:'protectionRevision'},{type:'put',namespace:'wal',key:'compactedThrough',value:Math.max(this.state.get<number>('wal','compactedThrough')??0,...eligible.map(s=>s.lastSequence))}]);
    await this.recoverCompaction();for(const segment of eligible){for(const[key,entry]of this.cache){if(entry.segment===segment.segment){this.cache.delete(key);this.cacheBytes-=entry.offsetEnd-entry.offset;}}}
    return{dryRun:false,eligible:eligible.map(s=>s.segment),reclaimedBytes:eligible.reduce((sum,s)=>sum+s.bytes,0),blocked};
  }
  private async recoverCompaction():Promise<void>{
    for(const segment of this.state.segments().filter(s=>s.gcState==='planned'||s.gcState==='complete')){
      if(!segment.archivePath||!segment.archiveHash)throw new Error('WAL_ARCHIVE_MANIFEST_INVALID');
      if((await stat(segment.archivePath)).size!==segment.bytes)throw new Error('WAL_ARCHIVE_VERIFY_FAILED');
      if(segment.gcState==='planned'){if(await fileSha256(segment.archivePath)!==segment.archiveHash)throw new Error('WAL_ARCHIVE_VERIFY_FAILED');await unlink(join(this.directory,segmentName(segment.segment))).catch(error=>{if(!isMissing(error))throw error;});await fsyncDirectory(this.directory);await this.state.saveSegment({...segment,gcState:'complete'});if(this.initialized)this.totalBytes-=segment.bytes;}
    }
  }
  auditArchives():Promise<{segments:number;bytes:number}>{return this.serializeMaintenance(async()=>{let segments=0,bytes=0;for(const segment of this.state.segments()){if(!segment.archivePath)continue;if(!segment.archiveHash||await fileSha256(segment.archivePath)!==segment.archiveHash)throw new Error('WAL_ARCHIVE_VERIFY_FAILED');segments++;bytes+=segment.bytes;}return{segments,bytes};});}
  async drain():Promise<void>{await this.writeTail;await this.checkpointTail;if(this.writeError)throw this.writeError;}
  async close():Promise<void>{
    if(this.fenced)return;this.closing=true;await this.writeTail;await this.checkpointTail;await this.maintenanceTail;this.fenced=true;this.initialized=false;this.cache.clear();this.verifiedArchives.clear();this.cacheBytes=0;
    try{await this.freeSpace.close();await this.state?.close();}finally{await this.releaseLock();if(owners.get(this.directory)===this)owners.delete(this.directory);}
  }
  stats(){
    this.assertOpen();const segments=this.state.segments(),targets=this.scanAll<TargetRegistration>('target');let stateBytes=0;for(const name of['state.sqlite','state.sqlite-wal','state.sqlite-shm','owner.sqlite','owner.sqlite-journal']){try{stateBytes+=statSync(join(this.directory,name)).size;}catch(error){if(!isMissing(error))throw error;}}
    return{segments:segments.filter(s=>s.gcState!=='complete').length,entries:this.state.frameCount(),acceptedEntries:this.acceptedCount(),totalBytes:this.totalBytes,currentBytes:this.currentSize,pendingWrites:this.pendingWrites,maxPendingWrites:this.maxPendingWrites,writeFailed:this.writeError!==null,checkpoints:this.checkpoints,pendingByCheckpoint:Object.fromEntries(Object.keys(this.checkpoints).map(id=>[id,this.pendingCount(id)])),walEpoch:this.walEpoch,ingestSequence:this.state.lastSequence(),cacheEntries:this.cache.size,cacheBytes:this.cacheBytes,archiveBytes:segments.filter(s=>s.archivePath).reduce((sum,s)=>sum+s.bytes,0),stateBytes,dlqBytes:this.state.namespaceUsage('dlq').bytes,gcEnabled:this.gcEnabled,targetRegistry:targets.map(item=>item.value),...this.freeSpace.stats()};
  }
}
