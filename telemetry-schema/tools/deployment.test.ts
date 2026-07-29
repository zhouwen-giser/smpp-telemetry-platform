import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
const root=new URL(`file://${process.cwd()}/`);
test('one-click deployment assets exist and include all containers',async()=>{
  const compose=await readFile(new URL('compose.yaml',root),'utf8');
  for(const service of ['clickhouse:','telemetry-processor:','otel-collector:','query-api:','grafana:']) assert.match(compose,new RegExp(`\\n  ${service}`));
  assert.match(compose,/config\/generated\/source-mappings\.json/);
  await access(new URL('deploy.sh',root));
  await access(new URL('docs/%E4%B8%AD%E6%96%87%E4%BD%BF%E7%94%A8%E8%AF%B4%E6%98%8E.md',root));
});
test('projection target output includes standalone and SDAR shadow targets',async()=>{
  const cfg=JSON.parse(await readFile(new URL('config/projection-targets.example.json',root),'utf8'));
  assert.equal(cfg.targets.find(x=>x.targetId==='standalone-smpp')?.enabled,true);
  assert.equal(cfg.targets.find(x=>x.targetId==='sdar-warehouse-shadow')?.enabled,false);
});
