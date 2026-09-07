import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const root=resolve(import.meta.dirname,'../..');
const read=p=>readFileSync(resolve(root,p),'utf8');
test('all collector profiles persist diagnostic metrics without changing synchronous ProviderOps ACK',()=>{
  for(const path of ['telemetry-collector/config/gateway.yaml','telemetry-collector/config/gateway-mtls.yaml','deploy/ugv-debug/collector.template.yaml']){
    const y=read(path),provider=y.split('  otlphttp/processor_provider_ops:')[1].split('  clickhouse/diagnostics:')[0];
    assert.match(provider,/sending_queue:[\s\S]*enabled: false/);assert.match(provider,/retry_on_failure:[\s\S]*enabled: false/);
    assert.match(y,/storage: file_storage\/diagnostics/);assert.match(y,/metrics\/platform:/);assert.match(y,/metrics\/otlp:/);assert.match(y,/metrics\/prometheus:/);
    assert.match(y,/telemetry.collection.protocol, value: prometheus|telemetry.collection.protocol,\s*value: prometheus/);
  }
  for(const path of ['compose.yaml','deploy/compose/compose.yaml']){
    const y=read(path);assert.match(y,/collector-queue:\/var\/lib\/otelcol\/storage/);assert.match(y,/collector-storage-init/);assert.match(y,/health\/ready/);
  }
});
test('Grafana uses real ClickHouse SQL, full series and separate protocol filters; missing metrics remain NoData',()=>{
  const datasource=read('telemetry-dashboard/grafana/provisioning/datasources/clickhouse.yaml');
  assert.doesNotMatch(datasource,/type: prometheus|url: http:\/\/otel-collector:9464/);
  const dashboard=JSON.parse(read('telemetry-dashboard/grafana/dashboards/overview.json'));
  for(const panel of dashboard.panels){assert.equal(panel.datasource.uid,'clickhouse');assert.ok(panel.targets[0].rawSql);}
  const backlog=dashboard.panels.find(p=>p.title==='Runtime telemetry audit backlog').targets[0].rawSql;
  assert.match(backlog,/argMax\(Value, TimeUnix\)/);assert.doesNotMatch(backlog,/sum\(Value\)/);assert.match(backlog,/telemetry.collection.protocol/);assert.match(backlog,/mapSort\(Attributes\)/);assert.match(backlog,/ScopeAttributes/);
  const alerts=JSON.parse(read('telemetry-dashboard/grafana/provisioning/alerting/telemetry.json')).groups[0].rules;
  assert.equal(alerts.length,8);for(const rule of alerts){assert.equal(rule.noDataState,'NoData');assert.equal(rule.execErrState,'Error');assert.equal(rule.data[0].datasourceUid,'clickhouse');}
});
