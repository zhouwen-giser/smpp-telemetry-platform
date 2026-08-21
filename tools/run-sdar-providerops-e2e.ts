import {readFile} from 'node:fs/promises';
import {calculateProviderOpsRecordHash,uuidV5} from '../telemetry-processor/src/packages/canonical/canonical.js';

const endpoint=process.env.OTLP_ENDPOINT??'http://127.0.0.1:14318/v1/logs';
const runId=process.env.SMPP_E2E_RUN_ID;
if(!runId||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(runId))throw new Error('SMPP_E2E_RUN_ID_REQUIRED');
const fixtures=JSON.parse(await readFile('contracts/provider-ops-payload-fixtures.v1.1.json','utf8'));
const category=(recordType)=>recordType.startsWith('provider.business_event.')?'business_event.lifecycle':recordType.slice('provider.'.length);
const occurredBase=Date.parse('2026-08-18T02:32:07.000Z');
const envelopes=fixtures.valid.map((fixture,index)=>{
  const envelope={
    schemaName:'sdar.provider.ops.event',schemaVersion:'1.1.0',
    recordId:uuidV5(`${runId}|source|${fixture.recordType}`),recordHash:'',
    recordType:fixture.recordType,eventCategory:category(fixture.recordType),deliveryClass:'audit',
    providerId:'warehouse-provider',runtimeVersion:'2.0.0-rc.1',instanceId:'runtime-replica-1',
    taskId:`provider-task-${runId}`,resourceId:`resource-${runId}`,resourceType:'smpp-resource',
    externalExecutionId:`execution-${runId}`,operationName:'providerops.integration',
    providerEventId:`provider-event-${runId}`,
    providerEventSequence:index===1?3:index===2?2:index+1,
    occurredAt:new Date(occurredBase+index*1000).toISOString(),
    emittedAt:new Date(occurredBase+index*1000+100).toISOString(),
    attributes:{correlation:{originSystem:'sdar',originDeploymentId:'runtime-test',originTaskIds:[`sdar-task-${runId}-a`,`sdar-task-${runId}-b`],originInvocationIds:[`sdar-invocation-${runId}`],routeId:`route-${runId}`,attemptNo:1}},
    payload:fixture.payload
  };
  envelope.recordHash=calculateProviderOpsRecordHash(envelope);
  return envelope;
});

const first=await send(envelopes);
if(first.status!==200)throw new Error(`SMPP_E2E_INITIAL_SEND_FAILED_${first.status}`);
const duplicate=await send(envelopes);
if(duplicate.status!==200)throw new Error(`SMPP_E2E_DUPLICATE_SEND_FAILED_${duplicate.status}`);
const conflict={...envelopes[0],payload:{currentState:'failed',terminalStatus:'failed',providerSubstate:'error',providerRevision:'8',observedAt:'2026-08-18T02:32:07.000Z'}};
conflict.recordHash=calculateProviderOpsRecordHash(conflict);
const conflictResponse=await send([conflict]);
if(conflictResponse.status<400)throw new Error('SMPP_E2E_CONFLICT_NOT_REJECTED');
console.log(JSON.stringify({event:'smpp_providerops.e2e_send',status:'passed',runId,recordTypes:envelopes.length,recordIds:envelopes.map((value)=>value.recordId),recordHashes:envelopes.map((value)=>value.recordHash),initialHttpStatus:first.status,duplicateHttpStatus:duplicate.status,conflictHttpStatus:conflictResponse.status,outOfOrderSequence:true,originTaskCount:2,originInvocationCount:1}));

async function send(values){
  const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(otlp(values))});
  return {status:response.status,body:await response.text()};
}

function otlp(values){return{resourceLogs:[{resource:{attributes:attributes({'service.name':'sdar-mcp-provider-runtime','deployment.environment':'test','sdar.provider.id':'warehouse-provider'})},scopeLogs:[{scope:{name:'sdar.provider.ops'},logRecords:values.map((envelope)=>({timeUnixNano:String(BigInt(Date.parse(envelope.emittedAt))*1000000n),body:anyValue(envelope),attributes:attributes({'sdar.record.id':envelope.recordId,'sdar.record.hash':envelope.recordHash,'sdar.schema.name':envelope.schemaName,'sdar.schema.version':envelope.schemaVersion})}))}]}]};}
function attributes(value){return Object.entries(value).map(([key,item])=>({key,value:anyValue(item)}));}
function anyValue(value){if(typeof value==='string')return{stringValue:value};if(typeof value==='boolean')return{boolValue:value};if(typeof value==='number')return Number.isInteger(value)?{intValue:String(value)}:{doubleValue:value};if(Array.isArray(value))return{arrayValue:{values:value.map(anyValue)}};if(value&&typeof value==='object')return{kvlistValue:{values:attributes(value)}};return{stringValue:''};}
