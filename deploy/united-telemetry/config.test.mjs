import test from 'node:test';import assert from 'node:assert/strict';import{mkdtempSync,readFileSync,rmSync,mkdirSync,writeFileSync}from'node:fs';import{tmpdir}from'node:os';import{resolve}from'node:path';import{attachedCompose}from'./config.mjs';
test('attached telemetry reuses SMPP network and creates no business DB or shared warehouse',()=>{
 const telemetry=resolve(import.meta.dirname,'../..'),state=mkdtempSync(resolve(tmpdir(),'united-config-')),smpp=resolve(state,'smpp');
 mkdirSync(resolve(smpp,'packages/persistence-postgres/src'),{recursive:true});writeFileSync(resolve(smpp,'packages/persistence-postgres/src/tasks.ts'),'const DURABLE_RUNTIME_AUTHORITY_INSTANCE_ID = "smpp-runtime-postgres-authority";');
 try{const c=attachedCompose({telemetry,smpp,state,revision:'test',runtime:{RUNTIME_INSTANCE_ID:'sz-runtime',RUNTIME_DEPLOYMENT_ID:'sz-deployment',PROVIDER_ID:'isr.vehicle.ugv.ugv1'},network:'smpp-gowm_default'});
 for(const n of ['runtime','adapter','runtime-db','adapter-db','shared-test'])assert.equal(c.services[n],undefined);
 assert.equal(c.volumes['runtime-db'],undefined);assert.equal(c.services['query-api'].environment.AUTHORITY_ENABLED,'false');
 const targets=JSON.parse(readFileSync(resolve(state,'config/projection-targets.json'),'utf8'));assert.equal(targets.targets.length,1);assert.equal(targets.targets[0].targetType,'standalone_smpp_clickhouse');
 assert.equal(c['networks'].smpp.name,'smpp-gowm_default');assert.equal(c.services['otel-collector'].environment.SMPP_METRICS_TARGET,'smpp-gowm-runtime-1:8080');
 assert.ok(JSON.parse(readFileSync(resolve(state,'config/source-mappings.json'),'utf8')).mappings.every(m=>m.deploymentId==='sz-deployment'&&m.projectionRouteIds.length===1));
 }finally{rmSync(state,{recursive:true,force:true});}
});

test('managed SDAR enables Authority and retained WAL replay without exposing a database port',()=>{
 const telemetry=resolve(import.meta.dirname,'../..'),state=mkdtempSync(resolve(tmpdir(),'united-managed-')),smpp=resolve(state,'smpp');
 mkdirSync(resolve(smpp,'packages/persistence-postgres/src'),{recursive:true});writeFileSync(resolve(smpp,'packages/persistence-postgres/src/tasks.ts'),'const DURABLE_RUNTIME_AUTHORITY_INSTANCE_ID = "smpp-runtime-postgres-authority";');
 const options={telemetry,smpp,state,revision:'test',runtime:{RUNTIME_INSTANCE_ID:'sz-runtime',RUNTIME_DEPLOYMENT_ID:'sz-deployment',PROVIDER_ID:'isr.vehicle.ugv.ugv'},network:'smpp-gowm_default',managedSchema:true};
 try{
 const c=attachedCompose(options);assert.equal(c.services['query-api'].environment.AUTHORITY_ENABLED,'true');assert.equal(c.services['query-api'].environment.AUTHORITY_CLICKHOUSE_URL,'http://sdar-clickhouse:8123');assert.equal(c.services['sdar-clickhouse'].ports,undefined);
 const secret=readFileSync(resolve(state,'shared-password.secret'),'utf8');assert.equal(secret.length,48);assert.ok(!JSON.stringify(c).includes(secret));attachedCompose(options);assert.equal(readFileSync(resolve(state,'shared-password.secret'),'utf8'),secret);
 const targets=JSON.parse(readFileSync(resolve(state,'config/projection-targets.json'),'utf8'));assert.deepEqual(targets.targets.find(t=>t.targetId==='sdar-warehouse-shadow').routeIds,['standalone-smpp','sdar-warehouse-shadow']);
 assert.throws(()=>attachedCompose({...options,overrides:{SHARED__URL:'http://external:8123'}}),/CONFLICT/);
 }finally{rmSync(state,{recursive:true,force:true});}
});
