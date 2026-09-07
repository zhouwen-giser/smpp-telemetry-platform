import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const root=resolve(import.meta.dirname,'../..');
const id=`smpp-remediation-collector-${process.pid}-${Date.now()}`;
const names={ch:`${id}-ch`,runtime:`${id}-runtime`,collector:`${id}-collector`};
const state=mkdtempSync(resolve(tmpdir(),'smpp-collector-storage-'));
const output=resolve(root,'reports/remediation-20260907/collector-storage');mkdirSync(output,{recursive:true});
writeFileSync(resolve(state,'password'),'collector-storage-fixture');
const docker=(args, input)=>execFileSync('docker',args,{encoding:'utf8',maxBuffer:4*1024*1024,timeout:60000,stdio:['pipe','pipe','pipe'],...(input?{input}:{})});
const sql=query=>docker(['exec',names.ch,'clickhouse-client','--password','collector-storage-fixture','--query',query]);
async function until(predicate){let error;for(let i=0;i<45;i++){try{return predicate();}catch(e){error=e;await new Promise(r=>setTimeout(r,1000));}}throw error;}
const report={status:'RUNNING',startedAt:new Date().toISOString()};
try {
  docker(['network','create',id]);
  docker(['run','-d','--name',names.ch,'--network',id,'--network-alias','clickhouse','--tmpfs','/var/lib/clickhouse:rw,size=1g','--memory','2g','--cpus','2','-e','CLICKHOUSE_PASSWORD=collector-storage-fixture','clickhouse/clickhouse-server:25.3.14.14']);
  await until(()=>assert.equal(sql('SELECT 1').trim(),'1'));
  docker(['exec','-i',names.ch,'clickhouse-client','--password','collector-storage-fixture','--multiquery'],readFileSync(resolve(root,'telemetry-schema/migrations/008_otel_diagnostics.sql'),'utf8'));
  const mock="let value=7;require('node:http').createServer((req,res)=>{if(req.url==='/clear')value=0;res.end('# HELP telemetry_audit_backlog queued fixture records\\n# TYPE telemetry_audit_backlog gauge\\ntelemetry_audit_backlog '+value+'\\n')}).listen(8080,'0.0.0.0')";
  docker(['run','-d','--name',names.runtime,'--network',id,'--network-alias','runtime-fixture','--memory','128m','--entrypoint','node','sdar-development-deployer:node22','-e',mock]);
  docker(['run','-d','--name',names.collector,'--network',id,'--user','0:0','--memory','512m','--tmpfs','/var/lib/otelcol/storage:rw,size=64m',
    '-v',`${root}/telemetry-collector/config/gateway.yaml:/config.yaml:ro`,'-v',`${state}/password:/run/secrets/clickhouse_password:ro`,
    ...Object.entries({COLLECTOR_ID:'g6-live-collector',TRUST_DOMAIN:'fixture',SMPP_DEPLOYMENT_ID:'simulation-fixture',SMPP_RUNTIME_INSTANCE_ID:'runtime-a',SMPP_PROVIDER_ID:'fixture-provider',SMPP_METRICS_TARGET:'runtime-fixture:8080',SMPP_METRICS_PATH:'/metrics',SMPP_METRICS_SCRAPE_INTERVAL:'1s'}).flatMap(([key,value])=>['-e',`${key}=${value}`]),
    'otel/opentelemetry-collector-contrib:0.157.0','--config=/config.yaml']);
  const where="FROM telemetry_observability.otel_metrics_gauge WHERE MetricName='telemetry_audit_backlog' AND ResourceAttributes['telemetry.collection.protocol']='prometheus' AND ResourceAttributes['telemetry.source.collector_id']='g6-live-collector'";
  await until(()=>assert.ok(Number(sql(`SELECT count() ${where} AND Value=7`).trim())>0));
  docker(['exec',names.runtime,'node','-e',"fetch('http://127.0.0.1:8080/clear',{method:'POST'}).then(r=>{if(!r.ok)process.exit(1)})"]);
  await until(()=>assert.ok(Number(sql(`SELECT count() ${where} AND Value=0`).trim())>0));
  report.samples=JSON.parse(sql(`SELECT ResourceAttributes,MetricName,TimeUnix,Value ${where} ORDER BY TimeUnix FORMAT JSON`)).data;
  assert.ok(report.samples.every(row=>row.ResourceAttributes['service.instance.id']==='runtime-a'));
  report.status='PASS';
} catch(error) {report.status='FAIL';report.error=String(error.message);throw error;}
finally {
  try{writeFileSync(resolve(output,'collector.log'),docker(['logs',names.collector]));}catch{}
  report.finishedAt=new Date().toISOString();writeFileSync(resolve(output,'result.json'),JSON.stringify(report,null,2));
  for(const name of [names.collector,names.runtime,names.ch])try{docker(['rm','-f',name]);}catch{}
  try{docker(['network','rm',id]);}catch{}
}
console.log(`COLLECTOR_STORAGE_PASS: ${resolve(output,'result.json')}`);
