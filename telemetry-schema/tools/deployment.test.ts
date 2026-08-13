import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
const root=new URL(`file://${process.cwd()}/`);
test('one-click deployment assets exist and include all containers',async()=>{
  const compose=await readFile(new URL('compose.yaml',root),'utf8');
  for(const service of ['clickhouse:','telemetry-migrate:','telemetry-processor:','otel-collector:','query-api:','grafana:']) assert.match(compose,new RegExp(`\\n  ${service}`));
  assert.match(compose,/config\/generated\/source-mappings\.json/);
  assert.match(compose,/service_completed_successfully/);
  assert.match(compose,/TELEMETRY_BIND_ADDRESS/);
  assert.match(compose,/\$\{OTLP_HTTP_BIND_ADDRESS:-0\.0\.0\.0\}:\$\{OTLP_HTTP_PORT:-4318\}:4318/);
  assert.doesNotMatch(compose,/ports: \["\$\{OTLP_GRPC_PORT/);
  await access(new URL('deploy.sh',root));
  await access(new URL('docs/SMPP_%E9%81%A5%E6%B5%8B%E5%B9%B3%E5%8F%B0%E4%B8%AD%E6%96%87%E4%BD%BF%E7%94%A8%E8%AF%B4%E6%98%8E.md',root));
});
test('ClickHouse DateTime64 retention expressions are compatible with the pinned image',async()=>{
  for(const name of ['003_landing.sql','005_core.sql']){
    const sql=await readFile(new URL(`telemetry-schema/migrations/${name}`,root),'utf8');
    assert.match(sql,/TTL toDateTime\(/);
    assert.doesNotMatch(sql,/TTL (?:occurred_at|received_at) \+/);
  }
});
test('projection target output includes standalone and SDAR shadow targets',async()=>{
  const cfg=JSON.parse(await readFile(new URL('config/projection-targets.example.json',root),'utf8'));
  assert.equal(cfg.targets.find(x=>x.targetId==='standalone-smpp')?.enabled,true);
  assert.equal(cfg.targets.find(x=>x.targetId==='sdar-warehouse-shadow')?.enabled,false);
});
