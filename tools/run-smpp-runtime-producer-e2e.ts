import type { ProviderOpsEnvelope } from '../packages/telemetry-types/src/index.js';
interface SqlSession { query<Row = Record<string,unknown>>(sql:string, values?:unknown[]):Promise<{rows:Row[]}> }
interface SqlConnection extends SqlSession { release():void }
interface SqlPool extends SqlSession { connect():Promise<SqlConnection>; end():Promise<void> }
interface PoolModule { Pool:new(options:{connectionString:string;max:number;options?:string})=>SqlPool }
interface TaskRepositoryApi {
  markAdmissionUncertain(taskId:string,reason:string,operations:string[],now:Date):Promise<unknown>;
  recordReconciliationResult(taskId:string,result:string,executionId:string|null,retry:boolean,now:Date):Promise<unknown>;
}
interface PersistenceModule {
  runMigrations(pool:SqlPool):Promise<void>;
  TaskRepository:new(pool:SqlPool)=>TaskRepositoryApi;
  insertCommittedTaskEvent(client:SqlConnection,taskId:string,type:string,payload:Record<string,unknown>,key:string):Promise<unknown>;
}
interface TelemetryModule { ProviderTelemetryIngress:new(pool:SqlPool,identity:{providerId:string;instanceId:string})=>{
  emit(providerId:string,request:{providerId:string;events:ReturnType<typeof providerEvent>[]}):Promise<{results:{accepted:boolean;reasonCode?:string}[]}>;
} }
import type { OtlpJsonAnyValue } from '../telemetry-processor/src/packages/otlp/otlp-types.js';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {calculateProviderOpsRecordHash} from '../telemetry-processor/src/packages/canonical/canonical.js';

const producerRepo=resolve(process.env.SMPP_PRODUCER_REPO??'../sdar-mcp-provider-platform');
const expectedCommit=process.env.SMPP_PRODUCER_COMMIT;
const databaseUrl=process.env.TEST_DATABASE_URL;
const endpoint=process.env.OTLP_ENDPOINT??'http://127.0.0.1:4318/v1/logs';
if(!expectedCommit||!/^[0-9a-f]{40}$/.test(expectedCommit))throw new Error('SMPP_PRODUCER_COMMIT_REQUIRED');
if(!databaseUrl)throw new Error('TEST_DATABASE_URL_REQUIRED');
const actualCommit=execFileSync('git',['rev-parse','HEAD'],{cwd:producerRepo,encoding:'utf8'}).trim();
if(actualCommit!==expectedCommit)throw new Error('SMPP_PRODUCER_COMMIT_MISMATCH');

const pg: PoolModule=await import(pathToFileURL(resolve(producerRepo,'node_modules/pg/esm/index.mjs')).href);
const persistence: PersistenceModule=await import(pathToFileURL(resolve(producerRepo,'packages/persistence-postgres/src/index.ts')).href);
const providerTelemetry: TelemetryModule=await import(pathToFileURL(resolve(producerRepo,'packages/provider-telemetry/src/index.ts')).href);
const {Pool}=pg;
const {runMigrations,TaskRepository,insertCommittedTaskEvent}=persistence;
const {ProviderTelemetryIngress}=providerTelemetry;

const schema=`smpp_runtime_sync_${randomUUID().replaceAll('-','')}`;
const admin=new Pool({connectionString:databaseUrl,max:1});
const pool=new Pool({connectionString:databaseUrl,max:4,options:`-c search_path=${schema}`});
const snapshotId=randomUUID();
const recoveryTaskId=randomUUID();
const terminalTaskId=randomUUID();
const executionId=`execution-${randomUUID()}`;
const now=Date.now();

try{
  await admin.query(`CREATE SCHEMA ${schema}`);
  await runMigrations(pool);
  await pool.query(
    `INSERT INTO operation_snapshot
       (snapshot_id,provider_id,provider_version,operation_name,manifest_hash,definition)
     VALUES ($1,'provider-a','1.0.0','navigate',$2,$3::jsonb)`,
    [snapshotId,'a'.repeat(64),JSON.stringify({resourceBinding:{mode:'ARGUMENT_REFERENCE',resourceIdJsonPointer:'/target/id'}})]
  );
  for(const [taskId,state] of [[recoveryTaskId,'PENDING'],[terminalTaskId,'PUBLISHED']]){
    await pool.query(
      `INSERT INTO admission_intent
         (task_id,provider_id,operation_name,operation_snapshot_id,
          authorization_context_hash,execution_mode,simulation_id,arguments,
          argument_hash,state,accepted_at,not_before,latest_start_at,timing)
       VALUES ($1,'provider-a','navigate',$2,$3,'simulation','sim-1',$4::jsonb,$5,$6,
               clock_timestamp(),clock_timestamp(),clock_timestamp(),$7::jsonb)`,
      [taskId,snapshotId,'b'.repeat(64),JSON.stringify({target:{id:'vehicle-7'}}),'c'.repeat(64),state,
       JSON.stringify({start:{mode:'immediate',startToleranceMs:0},maxElapsedMs:null})]
    );
  }

  const repository=new TaskRepository(pool);
  await repository.markAdmissionUncertain(
    recoveryTaskId,'response_lost_after_adapter_success',['adapter.startOperation'],new Date(now)
  );
  await repository.recordReconciliationResult(recoveryTaskId,'not_found',null,false,new Date(now+1));
  await repository.recordReconciliationResult(recoveryTaskId,'transient_unavailable',null,false,new Date(now+2));
  await repository.recordReconciliationResult(recoveryTaskId,'conflict','conflicting-execution',false,new Date(now+3));
  await repository.recordReconciliationResult(recoveryTaskId,'found',executionId,true,new Date(now+4));

  await pool.query(
    `INSERT INTO provider_task
       (task_id,provider_id,operation_name,operation_snapshot_id,
        authorization_context_hash,execution_mode,simulation_id,arguments,argument_hash,
        external_execution_id,internal_state,mcp_status,substate,status_message,result,
        adapter_revision,accepted_at,timing,not_before,latest_start_at,invocation_attempt,
        observation_revision,terminal_at,handle_expires_at)
     SELECT task_id,provider_id,operation_name,operation_snapshot_id,
            authorization_context_hash,execution_mode,simulation_id,arguments,argument_hash,
            $2,'TERMINAL_COMPLETED','completed',NULL,'qualification',$3::jsonb,
            7,accepted_at,timing,not_before,latest_start_at,1,9,
            clock_timestamp(),clock_timestamp()+interval '1 day'
     FROM admission_intent WHERE task_id=$1`,
    [terminalTaskId,executionId,JSON.stringify({isError:false})]
  );
  const client=await pool.connect();
  try{
    await insertCommittedTaskEvent(
      client,terminalTaskId,'task.completed',{occurredAt:new Date(now+5).toISOString()},
      `${terminalTaskId}:qualification:terminal`
    );
  }finally{client.release();}

  const ingress=new ProviderTelemetryIngress(pool,{providerId:'provider-a',instanceId:'ugv-adapter-qualification'});
  for(const input of [
    providerEvent(`position-${terminalTaskId}`,'position',now+6,{state:'observed',reasonCode:'POSITION_OBSERVED'}),
    providerEvent(`mission-${terminalTaskId}`,'mission',now+7,{state:'running',reasonCode:'MISSION_OBSERVED'},{'sdar.device.mission_id':'mission-7'})
  ]){
    const response=await ingress.emit('provider-a',{providerId:'provider-a',events:[input]});
    if(response.results[0]?.accepted!==true)throw new Error(`PRODUCER_TELEMETRY_REJECTED_${response.results[0]?.reasonCode??'UNKNOWN'}`);
  }

  const query=await pool.query<{record_body:ProviderOpsEnvelope}>('SELECT record_body FROM provider_ops_delivery ORDER BY created_at,record_id');
  const envelopes=query.rows.map((row)=>row.record_body);
  const families=new Set(envelopes.map((value)=>
    value.attributes?.semantic??value.attributes?.['sdar.fact.kind']??value.attributes?.['sdar.evidence.kind']??
    (value.payload && typeof value.payload==='object' && 'mcpTaskStatus' in value.payload ?'business_terminal':value.recordType)
  ));
  for(const required of ['dispatch.uncertainty','task.reconciliation','business_terminal','position','mission','mission_relation']){
    if(!families.has(required))throw new Error(`PRODUCER_SEMANTIC_MISSING_${required}`);
  }
  const initial=await send(envelopes);
  if(initial.status!==200)throw new Error(`SMPP_RUNTIME_SYNC_INITIAL_SEND_FAILED_${initial.status}_${initial.body}`);
  const duplicate=await send(envelopes);
  if(duplicate.status!==200)throw new Error(`SMPP_RUNTIME_SYNC_DUPLICATE_SEND_FAILED_${duplicate.status}`);
  const firstEnvelope=envelopes[0];if(!firstEnvelope)throw new Error('PRODUCER_ENVELOPES_EMPTY');
  const conflict=structuredClone(firstEnvelope);
  conflict.payload={...(typeof conflict.payload==='object' && conflict.payload!==null?conflict.payload:{}),qualificationConflict:true};
  conflict.recordHash=calculateProviderOpsRecordHash(conflict);
  const conflictResponse=await send([conflict]);
  if(conflictResponse.status<400)throw new Error('SMPP_RUNTIME_SYNC_HASH_CONFLICT_NOT_REJECTED');
  console.log(JSON.stringify({
    event:'smpp_runtime_sync.producer_e2e',status:'passed',producerCommit:actualCommit,schema,
    recordCount:envelopes.length,recordIds:envelopes.map((value)=>value.recordId),
    recordHashes:envelopes.map((value)=>value.recordHash),families:[...families].sort(),
    initialHttpStatus:initial.status,duplicateHttpStatus:duplicate.status,
    conflictHttpStatus:conflictResponse.status,recoveryTaskId,terminalTaskId,executionId
  }));
}finally{
  await pool.end();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
}

function providerEvent(providerEventId:string,evidenceKind:string,time:number,payload:Record<string,unknown>,extraAttributes:Record<string,string>={}){
  return {
    providerEventId,providerEventSequence:evidenceKind==='position'?10:11,
    eventType:'RESOURCE_STATE',resourceId:'vehicle-7',resourceType:'ugv',
    taskId:terminalTaskId,externalExecutionId:executionId,operationName:'navigate',
    occurredAt:{seconds:Math.floor(time/1000),nanos:(time%1000)*1_000_000},
    attributes:{'sdar.evidence.kind':evidenceKind,...extraAttributes},payload,
    traceparent:'',tracestate:''
  };
}

async function send(envelopes: ProviderOpsEnvelope[]){
  const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(otlp(envelopes))});
  return {status:response.status,body:await response.text()};
}

function otlp(envelopes: ProviderOpsEnvelope[]){
  return {resourceLogs:[{resource:{attributes:attributes({'service.name':'sdar-mcp-provider-runtime'})},scopeLogs:[{scope:{name:'sdar.provider.ops'},logRecords:envelopes.map((envelope)=>({
    timeUnixNano:String(BigInt(Date.parse(envelope.emittedAt))*1_000_000n),body:anyValue(envelope),
    attributes:attributes({'sdar.record.id':envelope.recordId,'sdar.record.hash':envelope.recordHash,'sdar.schema.name':envelope.schemaName,'sdar.schema.version':envelope.schemaVersion})
  }))}]}]};
}
function attributes(value: object){return Object.entries(value).map(([key,item])=>({key,value:anyValue(item)}));}
function anyValue(value: unknown): OtlpJsonAnyValue{
  if(typeof value==='string')return {stringValue:value};
  if(typeof value==='boolean')return {boolValue:value};
  if(typeof value==='number')return Number.isInteger(value)?{intValue:String(value)}:{doubleValue:value};
  if(Array.isArray(value))return {arrayValue:{values:value.map(anyValue)}};
  if(value&&typeof value==='object')return {kvlistValue:{values:attributes(value)}};
  return {stringValue:''};
}
