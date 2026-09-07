import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

// Explicitly isolated software fixtures. No existing Docker project, volume or application endpoint is used.
const root = resolve(import.meta.dirname, '../..');
const suffix = `${process.pid}-${Date.now()}`;
const network = `smpp-remediation-g6-${suffix}`;
const ch = `${network}-ch`, grafana = `${network}-grafana`;
const output = resolve(process.argv[2] ?? `${root}/reports/remediation-20260907/observability`);
mkdirSync(output, { recursive: true });
const docker = args => execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 300000, stdio: ['pipe','pipe','pipe'] });
const sql = query => docker(['exec', ch, 'clickhouse-client', '--password', 'g6-fixture-password', '--query', query]);
const report = { startedAt: new Date().toISOString(), status: 'RUNNING', validations: [] };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(callback, seconds = 60) { let last; for(let i=0;i<seconds;i++){ try { return callback(); } catch(error){ last=error; await pause(1000); } } throw last; }
const api = (path, payload) => JSON.parse(docker(['exec', grafana, 'wget', '-qO-', '--header', 'Authorization: Basic '+Buffer.from('admin:g6-fixture-admin').toString('base64'), ...(payload ? ['--header','Content-Type: application/json','--post-data',JSON.stringify(payload)] : []), `http://127.0.0.1:3000${path}`]));
const query = rawSql => {
  const result = api('/api/ds/query', { from: String(Date.now()-3600000), to: String(Date.now()), queries: [{ refId:'A', datasource:{uid:'clickhouse',type:'grafana-clickhouse-datasource'}, rawSql, editorType:'sql',queryType:'table',format:1,intervalMs:15000,maxDataPoints:1000 }] });
  if (result.results?.A?.error) throw Error(result.results.A.error);
  assert.ok(result.results?.A?.frames?.length, 'Datasource returned no frames');
  return result;
};
try {
  docker(['network', 'create', network]);
  docker(['run','-d','--name',ch,'--network',network,'--network-alias','clickhouse','--memory','2g','--cpus','2','--tmpfs','/var/lib/clickhouse:rw,size=1g','-e','CLICKHOUSE_PASSWORD=g6-fixture-password','clickhouse/clickhouse-server:25.3.14.14']);
  await until(() => assert.equal(sql('SELECT 1').trim(), '1'));
  for (const name of readdirSync(resolve(root,'telemetry-schema/migrations')).filter(f=>f.endsWith('.sql')).sort())
    execFileSync('docker',['exec','-i',ch,'clickhouse-client','--password','g6-fixture-password','--multiquery'],{ input:readFileSync(resolve(root,'telemetry-schema/migrations',name)), timeout:60000 });
  const fixture = (metric, value, seconds, protocol='prometheus', instance='runtime-a') => `INSERT INTO telemetry_observability.otel_metrics_gauge (ResourceAttributes,MetricName,TimeUnix,Value) VALUES (map('telemetry.collection.protocol','${protocol}','telemetry.source.deployment_id','simulation-fixture','service.instance.id','${instance}'),'${metric}',now()-INTERVAL ${seconds} SECOND,${value})`;
  for(const row of [['telemetry_audit_backlog',7,30],['telemetry_audit_backlog',0,10],['telemetry_audit_backlog',999,10,'otlp'],['telemetry_audit_backlog',3,10,'prometheus','runtime-b']])sql(fixture(...row));
  for(const metric of ['processor_wal_bytes','processor_state_bytes','processor_archive_bytes','processor_dlq_bytes','projection_target_oldest_pending_age_ms','projection_target_error'])sql(fixture(metric,0,0));
  sql(fixture('processor_ready',1,0));sql(fixture('query_ready',0,0));
  docker(['run','-d','--name',grafana,'--network',network,'--memory','768m','--cpus','1',
    '-e','GF_SECURITY_ADMIN_PASSWORD=g6-fixture-admin','-e','GF_INSTALL_PLUGINS=grafana-clickhouse-datasource 4.20.0',
    '--entrypoint','/bin/sh','-v',`${root}/telemetry-dashboard/grafana/start.sh:/etc/grafana/telemetry-start.sh:ro`,'-e','CLICKHOUSE_PASSWORD=g6-fixture-password',...['WAL_BYTES','STATE_BYTES','ARCHIVE_BYTES','DLQ_BYTES','PENDING_AGE_MS'].flatMap(k=>['-e',`ALERT_${k}=100`]),
    '-v',`${root}/telemetry-dashboard/grafana/provisioning:/etc/grafana/provisioning:ro`,
    '-v',`${root}/telemetry-dashboard/grafana/dashboards:/var/lib/grafana/dashboards:ro`,'grafana/grafana:12.1.0','/etc/grafana/telemetry-start.sh']);
  await until(() => assert.equal(api('/api/health').database, 'ok'), 180);
  report.validations.push({ name:'datasource-health', result:api('/api/datasources/uid/clickhouse/health') });
  const dashboard=JSON.parse(readFileSync(resolve(root,'telemetry-dashboard/grafana/dashboards/overview.json'),'utf8'));
  const panel=dashboard.panels.find(p=>p.title==='Runtime telemetry audit backlog');
  const actual=panel.targets[0].rawSql.replaceAll('${protocol:sqlstring}',"'prometheus'").replaceAll('${deployment:sqlstring}',"'simulation-fixture'").replaceAll('${runtime:sqlstring}',"'runtime-a'");
  const response=query(actual);
  const values=response.results.A.frames.flatMap(f=>f.data.values.at(-1));
  assert.ok(values.includes(7) && values.includes(0), JSON.stringify(values));
  assert.ok(!values.includes(999) && !values.includes(3));
  report.validations.push({name:'backlog-nonzero-to-zero-and-protocol-instance-isolation',result:response});
  for(const p of dashboard.panels) {
    const raw=p.targets[0].rawSql.replaceAll('${protocol:sqlstring}',"'prometheus'").replaceAll('${deployment:sqlstring}',"''").replaceAll('${runtime:sqlstring}',"''");
    // Empty metric result is valid; existing query/table contracts still have to execute without datasource error.
    const result=api('/api/ds/query',{from:String(Date.now()-3600000),to:String(Date.now()),queries:[{...p.targets[0],rawSql:raw,datasource:{uid:'clickhouse',type:'grafana-clickhouse-datasource'},intervalMs:15000,maxDataPoints:1000}]});
    assert.ok(!result.results?.A?.error, `${p.title}: ${result.results?.A?.error}`);
  }
  const rules=api('/api/v1/provisioning/alert-rules'); assert.equal(rules.length,8);
  report.validations.push({name:'alert-rules-provisioned',count:rules.length});
  for(const rule of rules) { assert.ok(!rule.data[0].model.rawSql.includes('${ALERT_')); query(rule.data[0].model.rawSql); }
  const allMetrics=['processor_wal_bytes','processor_state_bytes','processor_archive_bytes','processor_dlq_bytes','projection_target_oldest_pending_age_ms','projection_target_error'];
  let firingStates;
  for(let attempt=0;attempt<22;attempt++) {
    for(const metric of allMetrics)sql(fixture(metric,0,0));
    sql(fixture('processor_ready',1,0));sql(fixture('query_ready',0,0));
    firingStates=api('/api/prometheus/grafana/api/v1/rules');
    const actualRules=firingStates.data.groups.flatMap(g=>g.rules);
    assert.ok(actualRules.every(r=>r.health!=='error'),JSON.stringify(actualRules.map(r=>({uid:r.uid,health:r.health,lastError:r.lastError}))));
    if(actualRules.find(r=>r.uid==='smpp-query-unavailable')?.state==='firing')break;
    await pause(10000);
  }
  assert.equal(firingStates.data.groups.flatMap(g=>g.rules).find(r=>r.uid==='smpp-query-unavailable')?.state,'firing');
  report.validations.push({name:'grafana-alert-firing',result:firingStates});
  // Probe the exact provisioned expression: non-ready=>1 and ready=>0, with actual datasource evaluation.
  const readinessRule=rules.find(r=>r.uid==='smpp-query-unavailable');
  const firing=query(readinessRule.data[0].model.rawSql); assert.ok(firing.results.A.frames.some(f=>f.data.values.at(-1).includes(1)));
  await pause(1100);sql(fixture('query_ready',1,0));
  const recovered=query(readinessRule.data[0].model.rawSql);assert.ok(recovered.results.A.frames.some(f=>f.data.values.at(-1).includes(0)));
  report.validations.push({name:'query-alert-condition-trigger-and-recover',firing,recovered});
  let recoveredStates;
  for(let attempt=0;attempt<8;attempt++) {
    recoveredStates=api('/api/prometheus/grafana/api/v1/rules');
    if(recoveredStates.data.groups.flatMap(g=>g.rules).find(r=>r.uid==='smpp-query-unavailable')?.state==='inactive')break;
    await pause(10000);
  }
  assert.equal(recoveredStates.data.groups.flatMap(g=>g.rules).find(r=>r.uid==='smpp-query-unavailable')?.state,'inactive');
  report.validations.push({name:'grafana-alert-recovered',result:recoveredStates});
  report.status='PASS';
} catch(error) { report.status='FAIL';report.error=String(error.message).slice(0,2000); throw error; }
finally {
  try { writeFileSync(resolve(output,'grafana.log'),docker(['logs',grafana])); } catch {}
  report.finishedAt=new Date().toISOString();
  writeFileSync(resolve(output,'result.json'),JSON.stringify(report,null,2));
  for(const name of [grafana,ch])try{docker(['rm','-f',name]);}catch{}
  try{docker(['network','rm',network]);}catch{}
}
console.log(`OBSERVABILITY_PASS: ${resolve(output,'result.json')}`);
