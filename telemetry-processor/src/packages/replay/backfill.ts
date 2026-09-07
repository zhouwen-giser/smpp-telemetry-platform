import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { dirname, resolve } from 'node:path';
import { isRecord, type ProviderOpsEnvelope, type SourceMappingSnapshot, type TrustedIngressContext } from '../../../../packages/telemetry-types/src/index.js';
import { calculateProviderOpsRecordHash, sha256Canonical } from '../canonical/canonical.js';
import { SourceMappings } from '../source-mapping/source-mapping.js';
import { validateEnvelope } from '../validation/validation.js';
import { projectionTimestamp } from '../validation/timestamp.js';
import { fsyncDirectory, fileSha256 } from '../wal/archive.js';
import { WalStore } from '../wal/wal.js';
import { ReplayManager, type ReplayRequest } from './replay.js';
import { createReplayExecutor } from './executor.js';
import { loadProjectionTargets } from '../exporters/target-manager.js';

export interface BackfillConfiguration {
  sourceTable:string;sealedSource:boolean;exportFile:string;walDirectory:string;
  sourceMappingsFile:string;trustedContext:TrustedIngressContext;
  replay:Omit<ReplayRequest,'fromSequence'|'throughSequence'>;
  isolatedTargetsFile:string;liveTargetsFile:string;
}
export interface BackfillSource {query(sql:string):Promise<string>}
export interface BackfillManifest {version:1;sourceTable:string;sourceEngine:string;rows:number;sha256:string;exportedAt:string;sourceSealed:true}
export interface BackfillReport {status:'validated'|'completed'|'partial'|'failed';read:number;valid:number;invalid:number;duplicates:number;errors:Record<string,number>;replayId?:string}
function quoted(value:string):string{return`'${value.replaceAll('\\','\\\\').replaceAll("'","\\'")}'`;}
function tableParts(table:string):[string,string]{if(!/^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/u.test(table))throw new Error('BACKFILL_SOURCE_TABLE_INVALID');return table.split('.') as[string,string];}
function data(text:string):Array<Record<string,unknown>>{const value:unknown=JSON.parse(text);if(!isRecord(value)||!Array.isArray(value.data)||!value.data.every(isRecord))throw new Error('BACKFILL_SOURCE_RESPONSE_INVALID');return value.data;}
export async function planBackfill(source:BackfillSource,config:BackfillConfiguration):Promise<{status:'ready'|'skipped';reason?:string;sourceTable:string;engine?:string;rows?:number}>{
  const[database,table]=tableParts(config.sourceTable),tables=data(await source.query(`SELECT engine FROM system.tables WHERE database=${quoted(database)} AND name=${quoted(table)} FORMAT JSON`));
  if(!tables.length)return{status:'skipped',reason:'legacy_table_not_found',sourceTable:config.sourceTable};
  const engine=String(tables[0]!.engine);if(engine.includes('View'))return{status:'skipped',reason:'compatibility_view_is_not_a_legacy_source',sourceTable:config.sourceTable,engine};
  const columns=new Set(data(await source.query(`SELECT name FROM system.columns WHERE database=${quoted(database)} AND table=${quoted(table)} FORMAT JSON`)).map(row=>row.name));
  for(const name of['record_id','record_hash','envelope_json','received_at'])if(!columns.has(name))throw new Error(`BACKFILL_SOURCE_COLUMN_MISSING:${name}`);
  const rows=Number(data(await source.query(`SELECT count() AS rows FROM ${config.sourceTable} FORMAT JSON`))[0]?.rows);if(!Number.isSafeInteger(rows)||rows<0)throw new Error('BACKFILL_SOURCE_COUNT_INVALID');
  return{status:'ready',sourceTable:config.sourceTable,engine,rows};
}
export async function exportBackfill(source:BackfillSource,config:BackfillConfiguration):Promise<BackfillManifest>{
  if(config.sealedSource!==true)throw new Error('BACKFILL_SEALED_SOURCE_REQUIRED');
  const plan=await planBackfill(source,config);if(plan.status!=='ready')throw new Error(`BACKFILL_SOURCE_UNAVAILABLE:${plan.reason}`);
  const output=resolve(config.exportFile),temp=`${output}.${randomUUID()}.tmp`,file=await open(temp,'wx',0o600);let count=0,afterId='',afterHash='';
  try{
    for(;;){const after=count?` WHERE (toString(record_id),record_hash)>(${quoted(afterId)},${quoted(afterHash)})`:'';
      const rows=data(await source.query(`SELECT toString(record_id) AS record_id,record_hash,envelope_json,concat(replaceOne(toString(toTimeZone(received_at,'UTC')),' ','T'),'Z') AS received_at FROM ${config.sourceTable}${after} ORDER BY record_id,record_hash LIMIT 1000 FORMAT JSON`));
      for(const row of rows){if(typeof row.record_id!=='string'||typeof row.record_hash!=='string')throw new Error('BACKFILL_SOURCE_ID_INVALID');await file.writeFile(`${JSON.stringify(row)}\n`);count++;afterId=row.record_id;afterHash=row.record_hash;}
      if(rows.length<1000)break;
    }
    const end=await planBackfill(source,config);if(end.rows!==plan.rows||count!==plan.rows)throw new Error('BACKFILL_SOURCE_CHANGED_OR_DUPLICATE_IDENTITY');
    await file.sync();await file.close();const hash=await fileSha256(temp);await rename(temp,output);await fsyncDirectory(dirname(output));
    const manifest:BackfillManifest={version:1,sourceTable:config.sourceTable,sourceEngine:plan.engine!,rows:count,sha256:hash,exportedAt:new Date().toISOString(),sourceSealed:true};
    const manifestFile=await open(`${output}.manifest.json`,'w',0o600);try{await manifestFile.writeFile(JSON.stringify(manifest,null,2));await manifestFile.sync();}finally{await manifestFile.close();}await fsyncDirectory(dirname(output));return manifest;
  }catch(error){await file.close().catch(()=>{});throw error;}finally{await unlink(temp).catch(()=>{});}
}
interface ValidatedRow {envelope:ProviderOpsEnvelope;mapping:SourceMappingSnapshot;receivedAt:string}
async function loadManifest(config:BackfillConfiguration):Promise<BackfillManifest>{
  const manifest=JSON.parse(await readFile(`${config.exportFile}.manifest.json`,'utf8')) as BackfillManifest;
  if(manifest.version!==1||manifest.sourceTable!==config.sourceTable||await fileSha256(config.exportFile)!==manifest.sha256)throw new Error('BACKFILL_MANIFEST_MISMATCH');return manifest;
}
function validateRow(row:unknown,mappings:SourceMappings,context:TrustedIngressContext):ValidatedRow{
  if(!isRecord(row)||typeof row.envelope_json!=='string')throw new Error('BACKFILL_ORIGINAL_ENVELOPE_MISSING');
  let envelope:unknown;try{envelope=JSON.parse(row.envelope_json);}catch{throw new Error('BACKFILL_ORIGINAL_ENVELOPE_INVALID');}
  if(!isRecord(envelope)||typeof envelope.recordId!=='string'||typeof envelope.recordHash!=='string'||row.record_id!==envelope.recordId||row.record_hash!==envelope.recordHash||calculateProviderOpsRecordHash(envelope)!==envelope.recordHash)throw new Error('BACKFILL_SOURCE_HASH_MISMATCH');
  const result=validateEnvelope(envelope,{'sdar.record.id':envelope.recordId,'sdar.record.hash':envelope.recordHash,'sdar.schema.name':envelope.schemaName,'sdar.schema.version':envelope.schemaVersion});if(!result.ok)throw new Error(`BACKFILL_CONTRACT_INVALID:${result.code}`);
  if(!context.collectorId||!context.deploymentId)throw new Error('BACKFILL_TRUSTED_CONTEXT_REQUIRED');
  const receivedAt=projectionTimestamp(row.received_at),typed=envelope as unknown as ProviderOpsEnvelope;
  const mapping=mappings.resolve({...context,providerId:typed.providerId,instanceId:typed.instanceId,receivedAt:new Date(receivedAt)});if(!mapping)throw new Error('BACKFILL_SOURCE_UNMAPPED');
  return{envelope:typed,mapping,receivedAt};
}
export async function validateBackfill(config:BackfillConfiguration,onValid?:(row:ValidatedRow,line:number)=>Promise<void>,onInvalid?:(evidence:{line:number;code:string;raw:string})=>Promise<void>):Promise<BackfillReport>{
  const manifest=await loadManifest(config),mappings=new SourceMappings(config.sourceMappingsFile);await mappings.load();
  const report:BackfillReport={status:'validated',read:0,valid:0,invalid:0,duplicates:0,errors:{}};
  for await(const raw of createInterface({input:createReadStream(config.exportFile),crlfDelay:Infinity})){
    if(!raw.trim())continue;report.read++;let validated:ValidatedRow;
    try{validated=validateRow(JSON.parse(raw),mappings,config.trustedContext);}
    catch(error){const code=error instanceof Error?error.message:'BACKFILL_INPUT_INVALID';report.invalid++;report.errors[code]=(report.errors[code]??0)+1;if(onInvalid)await onInvalid({line:report.read,code,raw});continue;}
    // Storage/IO failures are not source defects: stop and retain the existing import checkpoint.
    if(onValid)await onValid(validated,report.read);report.valid++;
  }
  if(report.read!==manifest.rows)throw new Error('BACKFILL_EXPORT_COVERAGE_MISMATCH');if(report.invalid)report.status='partial';return report;
}
export async function runBackfill(config:BackfillConfiguration,{executorFactory=createReplayExecutor}:{executorFactory?:typeof createReplayExecutor}={}):Promise<BackfillReport>{
  const manifest=await loadManifest(config),wal=new WalStore({directory:config.walDirectory,gcEnabled:false});await wal.initialize();
  const manifestId=sha256Canonical({manifest,context:config.trustedContext,mappingFile:await fileSha256(config.sourceMappingsFile)});let duplicates=0;
  try{
    const original=wal.state.get<string>('backfill','manifestId');if(!original&&(wal.state.lastSequence()>0||wal.state.scan('target',{limit:1}).length))throw new Error('BACKFILL_DEDICATED_WAL_REQUIRED');if(original&&original!==manifestId)throw new Error('BACKFILL_WAL_INPUT_MISMATCH');await wal.state.put('backfill','manifestId',manifestId);
    const report=await validateBackfill(config,async(row)=>{
      const acceptedRecord={kind:'accepted',sourceSystem:'smpp',receivedAt:row.receivedAt,trustedContext:config.trustedContext,mapping:row.mapping,envelope:row.envelope,providerQuality:{status:'unknown_legacy',reasonCodes:[]}};
      const previous=wal.classify('smpp',row.envelope.recordId,row.envelope.recordHash);if(previous==='duplicate'){duplicates++;return;}if(previous==='conflict')throw new Error('BACKFILL_SOURCE_IDENTITY_CONFLICT');
      await wal.append(acceptedRecord);
    },async(evidence)=>{await wal.state.put('backfill:invalid',String(evidence.line).padStart(12,'0'),evidence);});
    report.duplicates=duplicates;await wal.state.put('backfill','report',report);
    if(wal.state.lastSequence()>0){
      const manager=new ReplayManager(wal),request:ReplayRequest={...config.replay,fromSequence:1,throughSequence:wal.state.lastSequence()};let job=await manager.create(request);report.replayId=job.id;
      const executor=await executorFactory({wal,job,targets:await loadProjectionTargets(config.isolatedTargetsFile),liveTargets:await loadProjectionTargets(config.liveTargetsFile)});
      if(job.status==='planned')job=await manager.transition(job.id,'start');else if(job.status==='paused'||job.status==='failed')job=await manager.transition(job.id,'resume');
      while(job.status==='running')job=await manager.runBatch(job.id,executor);
      report.status=job.status==='failed'?'failed':report.invalid||job.quarantined?'partial':'completed';
    }else report.status=report.invalid?'partial':'completed';
    await wal.state.put('backfill','report',report);return report;
  }finally{await wal.close();}
}
export async function backfillStatus(config:BackfillConfiguration):Promise<BackfillReport|undefined>{const wal=new WalStore({directory:config.walDirectory});await wal.initialize();try{return wal.state.get<BackfillReport>('backfill','report');}finally{await wal.close();}}
