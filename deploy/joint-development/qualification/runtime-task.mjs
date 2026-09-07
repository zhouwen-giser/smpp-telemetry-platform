import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';

// This command exercises the configured simulation game. It never inserts a task/outbox with SQL.
const state=resolve(process.argv[2]??''),output=resolve(process.argv[3]??'');
if(!process.argv[2]||!process.argv[3])throw Error('Usage: node runtime-task.mjs <qualification-state> <NEW-evidence-file>');
writeFileSync(output,JSON.stringify({status:'CLAIMED',claimedAt:new Date().toISOString()}),{flag:'wx',mode:0o600});
const compose=JSON.parse(readFileSync(state+'/compose.json','utf8'));
if(!/^smpp-remediation-(?:qualification|e1)-/.test(compose.name))throw Error('ISOLATED_QUALIFICATION_PROJECT_REQUIRED');
if(compose.services.adapter.environment.UGV_EXECUTION_MODE!=='simulation')throw Error('SIMULATION_MODE_REQUIRED');
const address=execFileSync('docker',['compose','--env-file','/dev/null','-p',compose.name,'-f',state+'/compose.json','port','runtime','8080'],{encoding:'utf8'}).trim();
const runId=compose.name+'-navigation-'+randomUUID();let id=0;
async function request(method,params,name='',key=''){
 const response=await fetch('http://'+address+'/mcp',{method:'POST',headers:{accept:'application/json, text/event-stream','content-type':'application/json','mcp-protocol-version':'2026-07-28','mcp-method':method,'x-sdar-subject':runId,'x-sdar-tenant':'ugv-qualification','x-sdar-execution-mode':'simulation','x-sdar-simulation-id':runId,...(name?{'mcp-name':name}:{})},body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params:{...params,_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientInfo':{name:'smpp-simulation-qualification',version:'1.0.0'},'io.modelcontextprotocol/clientCapabilities':{extensions:{'io.modelcontextprotocol/tasks':{}}},...(key?{'io.sdar/taskExecution':{profileVersion:'1.0',idempotencyKey:key}}:{})}}}),signal:AbortSignal.timeout(15000)});
 return {httpStatus:response.status,body:await response.json()};
}
const report={status:'RUNNING',runId,project:compose.name,startedAt:new Date().toISOString(),completedAt:'',taskId:'',arguments:null,initialRead:null,availability:null,dispatch:null,polls:[],error:''};
const save=()=>writeFileSync(output,JSON.stringify(report,null,2));
try{
 const ready=await fetch('http://'+address+'/health/ready',{signal:AbortSignal.timeout(5000)});if(!ready.ok)throw Error('RUNTIME_NOT_READY');
 report.initialRead=await request('tools/call',{name:'vehicle_get_state',arguments:{resourceId:'vehicle:ugv1'}},'vehicle_get_state',runId+'-read');
 const value=report.initialRead.body.result?.structuredContent;
 if(report.initialRead.httpStatus!==200||value?.identity?.executionMode!=='simulation'||value?.connectivity?.deviceAvailable!==true||value?.connectivity?.mqttConnected!==true||value?.connectivity?.deviceMcpConnected!==true)throw Error('CURRENT_SIMULATION_STATE_REQUIRED');
 const point=value.chassis?.position;if(!Number.isFinite(point?.latitude)||!Number.isFinite(point?.longitude))throw Error('CURRENT_POSITION_REQUIRED');
 report.arguments={resourceId:'vehicle:ugv1',mission:{type:'point',target:{latitude:point.latitude+0.000025,longitude:point.longitude,...(Number.isFinite(point.altitude)?{altitude:point.altitude}:{})}}};
 report.availability=await request('io.sdar/taskExecution/checkAvailability',{profileVersion:'1.0',checks:[{requestId:runId,operationName:'vehicle_navigate',arguments:{state:'complete',value:report.arguments}}]});
 if(report.availability.body.result?.results?.[0]?.availability!=='available')throw Error('NAVIGATION_UNAVAILABLE');
 save();report.dispatch=await request('tools/call',{name:'vehicle_navigate',arguments:report.arguments},'vehicle_navigate',runId);report.taskId=report.dispatch.body.result?.taskId??'';save();
 if(report.dispatch.body.result?.resultType!=='task'||!report.taskId)throw Error('REAL_TASK_REQUIRED');
 const deadline=Date.now()+180000;while(Date.now()<deadline){const response=await request('tasks/get',{taskId:report.taskId},report.taskId);report.polls.push({observedAt:new Date().toISOString(),...response});save();const result=response.body.result;if(['completed','failed','cancelled'].includes(result?.status)){report.status=result.status==='completed'?'PASS':'TASK_TERMINAL_FAILURE';break;}await new Promise(resolve=>setTimeout(resolve,2000));}
 if(report.status==='RUNNING')throw Error('TASK_TERMINAL_TIMEOUT');
}catch(error){report.status='FAIL';report.error=error instanceof Error?error.message:String(error);process.exitCode=1;}finally{if(report.status!=='PASS')process.exitCode=1;report.completedAt=new Date().toISOString();save();console.log(JSON.stringify({status:report.status,taskId:report.taskId,evidence:output,error:report.error}));}
