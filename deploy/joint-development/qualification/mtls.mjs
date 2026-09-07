import https from 'node:https';import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';import {execFileSync} from 'node:child_process';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';import {pathToFileURL} from 'node:url';
if(!process.argv[2]||!process.argv[3])throw Error('Usage: node mtls.mjs <qualification-state> <evidence-directory>');
const state=resolve(process.argv[2]),output=resolve(process.argv[3]);mkdirSync(output,{recursive:true});
const identity=JSON.parse(readFileSync(state+'/compose.json','utf8'));if(!/^smpp-remediation-(?:qualification|e1)-/.test(identity.name))throw Error('ISOLATED_QUALIFICATION_PROJECT_REQUIRED');
const {envelope}=await import(pathToFileURL(state+'/app/dist/telemetry-processor/test/helpers.js').href);
const env=JSON.parse(readFileSync(state+'/environment.json','utf8'));
const docker=(args,input)=>execFileSync('docker',['compose','-f',state+'/compose.json',...args],{input,encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024});
const port=(svc,p)=>Number(docker(['port',svc,String(p)]).trim().split(':').at(-1));
const ports={collector:port('otel-collector',4318),processor:port('telemetry-processor',8443),query:port('query-api',8088)};
const file=name=>readFileSync(state+'/certs/'+name);
const sql=(q,svc='clickhouse')=>docker(['exec','-T',svc,'clickhouse-client','--password','e1-isolated-only','--query',q]).trim();
function request(p,path,auth,body){return new Promise((resolve,reject)=>{const req=https.request({hostname:'127.0.0.1',port:p,path,method:body?'POST':'GET',ca:file(auth.ca+'.crt'),...(auth.cert?{cert:file(auth.cert+'.crt'),key:file(auth.cert+'.key')}:{}),headers:body?{'content-type':'application/json'}:{},timeout:10000},res=>{let data='';res.on('data',d=>data+=d);res.on('end',()=>resolve({status:res.statusCode,body:data}));});req.on('error',reject);req.on('timeout',()=>req.destroy(Error('REQUEST_TIMEOUT')));req.end(body?JSON.stringify(body):undefined);});}
const runtime={ca:'runtime-ca',cert:'runtime-client'},processor={ca:'processor-ca',cert:'collector-client'};
const any=v=>v===null?{}:typeof v==='string'?{stringValue:v}:typeof v==='boolean'?{boolValue:v}:typeof v==='number'?{doubleValue:v}:Array.isArray(v)?{arrayValue:{values:v.map(any)}}:{kvlistValue:{values:Object.entries(v).map(([key,value])=>({key,value:any(value)}))}};
const otlp=e=>({resourceLogs:[{resource:{attributes:[]},scopeLogs:[{scope:{name:'remediation-mtls-transport-fixture'},logRecords:[{body:any(e),attributes:Object.entries({'sdar.schema.name':e.schemaName,'sdar.schema.version':e.schemaVersion,'sdar.record.id':e.recordId,'sdar.record.hash':e.recordHash}).map(([key,value])=>({key,value:any(value)}))}]}]}]});
const event=()=>envelope({recordId:randomUUID(),providerId:env.RUNTIME__PROVIDER_ID,instanceId:env.RUNTIME__RUNTIME_INSTANCE_ID,taskId:randomUUID(),occurredAt:new Date().toISOString(),emittedAt:new Date().toISOString()});
async function until(fn){let last;for(let i=0;i<60;i++){try{return await fn();}catch(e){last=e;await new Promise(r=>setTimeout(r,1000));}}throw last;}
const report={status:'RUNNING',evidenceClass:'isolated_collector_processor_mtls_fixture',actualRuntimeAdapter:false,startedAt:new Date().toISOString(),cases:[]};
const ready=async()=>{const r=await request(ports.processor,'/health/ready',processor);assert.equal(r.status,200,r.body);return JSON.parse(r.body);};
try{
 await until(ready);assert.equal((await fetch(`http://127.0.0.1:${ports.query}/health/ready`)).status,200);
 for(const [name,p,path,auth]of [['collector_missing_client',ports.collector,'/v1/logs',{ca:'runtime-ca'}],['collector_rogue_client',ports.collector,'/v1/logs',{ca:'runtime-ca',cert:'rogue-client'}],['collector_untrusted_server',ports.collector,'/v1/logs',{ca:'rogue-ca',cert:'runtime-client'}],['processor_missing_client',ports.processor,'/internal/otlp/v1/logs',{ca:'processor-ca'}],['processor_rogue_client',ports.processor,'/internal/otlp/v1/logs',{ca:'processor-ca',cert:'rogue-client'}],['processor_untrusted_server',ports.processor,'/internal/otlp/v1/logs',{ca:'rogue-ca',cert:'collector-client'}]]){
   let failure;try{const r=await request(p,path,auth,otlp(event()));assert.fail('UNEXPECTED_HTTP_'+r.status);}catch(e){if(String(e.message).startsWith('UNEXPECTED_HTTP_'))throw e;failure=e.code??e.message;}report.cases.push({name,status:'PASS',transportError:failure});
 }
 const first=event();let ack=await request(ports.collector,'/v1/logs',runtime,otlp(first));assert.equal(ack.status,200,ack.body);
 await until(async()=>{const r=await ready();assert.ok(r.targets.every(t=>t.pending===0&&!t.lastError));assert.equal(Number(sql(`SELECT count() FROM telemetry_landing.smpp_provider_ops_v1 FINAL WHERE source_record_id='${first.recordId}'`)),1);assert.equal(sql(`SELECT source_record_hash FROM telemetry_landing.smpp_provider_ops_v1 FINAL WHERE source_record_id='${first.recordId}'`),first.recordHash.replace(/^sha256:/,''));return r;});
 ack=await request(ports.collector,'/v1/logs',runtime,otlp(first));assert.equal(ack.status,200,ack.body);report.cases.push({name:'valid_mtls_ack_and_duplicate',status:'PASS',recordId:first.recordId,recordHash:first.recordHash});
 const originalCert=file('collector-client.crt'),originalKey=file('collector-client.key');
 const next=event();try{
   writeFileSync(state+'/certs/collector-client.crt',file('runtime-client.crt'));writeFileSync(state+'/certs/collector-client.key',file('runtime-client.key'));docker(['restart','otel-collector']);ports.collector=port('otel-collector',4318);
   const bad=await until(async()=>{const r=await request(ports.collector,'/v1/logs',runtime,otlp(next));assert.notEqual(r.status,200,r.body);return r;});
   assert.equal(Number(sql(`SELECT count() FROM telemetry_landing.smpp_provider_ops_v1 WHERE source_record_id='${next.recordId}'`)),0);report.cases.push({name:'collector_processor_bad_client_no_false_ack',status:'PASS',httpStatus:bad.status});
 }finally{writeFileSync(state+'/certs/collector-client.crt',originalCert);writeFileSync(state+'/certs/collector-client.key',originalKey);docker(['restart','otel-collector']);ports.collector=port('otel-collector',4318);}
 await until(async()=>{const r=await request(ports.collector,'/v1/logs',runtime,otlp(next));assert.equal(r.status,200,r.body);return r;});
 await until(async()=>{const r=await ready();assert.ok(r.targets.every(t=>t.pending===0&&!t.lastError));assert.equal(Number(sql(`SELECT count() FROM sdar_core.external_provider_fact FINAL WHERE source_record_id='${next.recordId}'`,'shared-test')),1);return r;});
 report.cases.push({name:'collector_processor_certificate_recovery',status:'PASS',recordId:next.recordId});
 const q=await fetch(`http://127.0.0.1:${ports.query}/api/v1/events?consistency=snapshot&tenantId=${env.TENANT_ID}&projectId=${env.PROJECT_ID}&limit=1`);const page=await q.json();assert.equal(q.status,200,JSON.stringify(page));assert.ok(page.data?.length===1,JSON.stringify(page));assert.equal(page.completeness,'snapshot_of_published_inputs');assert.ok(page.snapshot?.walEpoch);report.querySnapshot=page;report.readiness=await ready();report.status='PASS';
}catch(e){report.status='FAIL';report.error=e.stack;process.exitCode=1;}
finally{for(const svc of ['telemetry-processor','otel-collector','query-api'])try{writeFileSync(output+'/'+svc+'.log',docker(['logs','--no-color',svc]));}catch{}report.finishedAt=new Date().toISOString();writeFileSync(output+'/mtls.json',JSON.stringify(report,null,2));}
console.log(JSON.stringify({status:report.status,cases:report.cases,error:report.error},null,2));
