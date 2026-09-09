import {readFileSync,existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {resolve} from 'node:path';
import {parseEnv} from 'node:util';
import {generate} from '../joint-development/compose.mjs';
export function attachedCompose({telemetry,smpp,state,revision,runtime,network,overrides=/** @type {Record<string,string>} */ ({}),managedSchema=false}){
 if(managedSchema){
  if(overrides.SHARED__URL||overrides.SHARED__USER||overrides.SHARED__PASSWORD_FILE)throw Error('MANAGED_SDAR_EXTERNAL_OVERRIDE_CONFLICT');
  mkdirSync(state,{recursive:true,mode:0o700});
  const secret=resolve(state,'shared-password.secret');
  if(!existsSync(secret))writeFileSync(secret,randomBytes(24).toString('hex'),{mode:0o600});
  overrides={...overrides,SHARED__URL:'http://sdar-clickhouse:8123',SHARED__USER:'sdar',SHARED__PASSWORD_FILE:secret};
 }
 const env={...parseEnv(readFileSync(resolve(telemetry,'deploy/joint-development/.env.example'),'utf8')),
 DEPLOY_PROJECT:'smpp-telemetry',DEPLOY_BIND_ADDRESS:'0.0.0.0',DEPLOY_PUBLIC_HOST:'17.26.1.20',
 SOURCE_ID:'smpp.sz-gowm.ugv',RUNTIME__RUNTIME_INSTANCE_ID:runtime.RUNTIME_INSTANCE_ID,RUNTIME__OTEL_SERVICE_INSTANCE_ID:runtime.RUNTIME_INSTANCE_ID,RUNTIME__RUNTIME_DEPLOYMENT_ID:runtime.RUNTIME_DEPLOYMENT_ID,RUNTIME__PROVIDER_ID:runtime.PROVIDER_ID,
 QUERY__QUERY_SNAPSHOTS_ENABLED:'true',PORT_GRAFANA:'23000',PORT_QUERY:'28088',PORT_PROCESSOR:'28443',PORT_CLICKHOUSE_HTTP:'28123',PORT_CLICKHOUSE_NATIVE:'29000',PORT_OTLP_HTTP:'24318',PORT_OTLP_GRPC:'24317',PORT_COLLECTOR_HEALTH:'23133',PORT_COLLECTOR_METRICS:'28888',PORT_RUNTIME_METRICS:'29464',...overrides};
 const c=generate(env,{smpp,telemetry,state,envDir:state,revision,attached:true});
 Object.assign(c,{networks:{default:{},smpp:{external:true,name:network}}});
 Object.assign(c.services['otel-collector'],{networks:{default:{},smpp:{aliases:['smpp-telemetry-collector']}}});
 c.services['otel-collector'].environment.SMPP_METRICS_TARGET='smpp-gowm-runtime-1:8080';
 if(managedSchema){
  const shared=structuredClone(c.services.clickhouse);
  shared.environment={CLICKHOUSE_USER:'sdar',CLICKHOUSE_PASSWORD_FILE:'/run/secrets/shared-password'};
  shared.volumes=['sdar-clickhouse-data:/var/lib/clickhouse',{type:'bind',source:resolve(state,'shared-password.secret'),target:'/run/secrets/shared-password',read_only:true}];
  delete shared.ports;
  shared.healthcheck.test[1]=shared.healthcheck.test[1].replaceAll('/run/secrets/local-password','/run/secrets/shared-password');
  c.services['sdar-clickhouse']=shared;c.volumes['sdar-clickhouse-data']={};
  for(const service of ['telemetry-processor','query-api'])c.services[service].depends_on['sdar-clickhouse']={condition:'service_healthy'};
  // Replay retained standalone WAL through the normal shared projection, preserving provenance.
  const targetFile=resolve(state,'config/projection-targets.json');
  const targets=JSON.parse(readFileSync(targetFile,'utf8'));
  targets.targets.find(t=>t.targetId==='sdar-warehouse-shadow').routeIds=['standalone-smpp','sdar-warehouse-shadow'];
  writeFileSync(targetFile,JSON.stringify(targets,null,2));
 }
 return c;
}
