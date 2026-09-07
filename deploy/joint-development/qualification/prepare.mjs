import {readFileSync,writeFileSync,mkdirSync,chmodSync,cpSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {parseEnv} from 'node:util';
import {catalog,template,validate} from '../catalog.mjs';
import {resolve} from 'node:path';
import {generate} from '../compose.mjs';
const root=resolve(import.meta.dirname,'../../..'),smpp=resolve(process.env.SMPP_CHECKOUT??resolve(root,'../sdar-mcp-provider-platform')),state=resolve(process.argv[2]??'');
if(!process.argv[2]||!process.argv[3]||existsSync(state))throw Error('Usage: node prepare.mjs <NEW-private-state-directory> <immutable-app-snapshot-directory>');
mkdirSync(state,{recursive:true,mode:0o700});cpSync(resolve(process.argv[3]),state+'/app',{recursive:true});
const project='smpp-remediation-qualification-'+Date.now();
const certdir=state+'/certs';mkdirSync(certdir,{recursive:true});
const openssl=(...args)=>execFileSync('openssl',args,{cwd:certdir,stdio:'ignore'});
for(const ca of ['runtime-ca','processor-ca','rogue-ca'])openssl('req','-x509','-newkey','rsa:2048','-nodes','-days','2','-keyout',ca+'.key','-out',ca+'.crt','-subj','/CN='+ca);
for(const [name,ca,kind,dns] of [['collector-server','runtime-ca','serverAuth','otel-collector'],['runtime-client','runtime-ca','clientAuth','runtime'],['processor-server','processor-ca','serverAuth','telemetry-processor'],['collector-client','processor-ca','clientAuth','e1-collector'],['rogue-client','rogue-ca','clientAuth','rogue']]){
  openssl('req','-newkey','rsa:2048','-nodes','-keyout',name+'.key','-out',name+'.csr','-subj','/CN='+dns);
  writeFileSync(certdir+'/'+name+'.ext',`extendedKeyUsage=${kind}\nsubjectAltName=DNS:${dns},DNS:localhost,IP:127.0.0.1\n`);
  openssl('x509','-req','-in',name+'.csr','-CA',ca+'.crt','-CAkey',ca+'.key','-CAcreateserial','-out',name+'.crt','-days','2','-extfile',name+'.ext');chmodSync(certdir+'/'+name+'.key',0o644);
}
let collector=readFileSync(root+'/telemetry-collector/config/gateway-mtls.yaml','utf8').replace('          authorization:\n            credentials_file: /run/secrets/query_api_key\n','');
writeFileSync(state+'/collector.yaml',collector);
const specs=catalog(smpp),env=validate({...parseEnv(template(specs)),DEPLOY_PROJECT:project,DEPLOY_BIND_ADDRESS:'127.0.0.1',SHARED__URL:'http://shared-test:8123',SHARED__USER:'default',SHARED__PASSWORD:'e1-isolated-only',CLICKHOUSE__PASSWORD:'e1-isolated-only',
  RUNTIME__RUNTIME_DEPLOYMENT_ID:'e1-remediation-20260907',RUNTIME__RUNTIME_INSTANCE_ID:'e1-runtime-20260907',RUNTIME__OTEL_SERVICE_INSTANCE_ID:'e1-runtime-20260907',COLLECTOR__COLLECTOR_ID:'e1-collector',COLLECTOR__TRUST_DOMAIN:'e1-simulation',
  RUNTIME__OTEL_EXPORTER_OTLP_ENDPOINT:'https://otel-collector:4318',RUNTIME__OTEL_EXPORTER_OTLP_TLS_MODE:'required',RUNTIME__OTEL_EXPORTER_OTLP_CA_PATH:certdir+'/runtime-ca.crt',RUNTIME__OTEL_EXPORTER_OTLP_CERT_PATH:certdir+'/runtime-client.crt',RUNTIME__OTEL_EXPORTER_OTLP_KEY_PATH:certdir+'/runtime-client.key',
  ADAPTER__UGV_EXECUTION_MODE:'simulation',ADAPTER__UGV_MQTT_WIRE_MODE:'ros_bridge_json',ADAPTER__UGV_MQTT_CLIENT_ID:project,
  PROCESSOR__PROCESSOR_TLS_MODE:'required',PROCESSOR__PROCESSOR_TLS_CA_FILE:certdir+'/processor-ca.crt',PROCESSOR__PROCESSOR_TLS_CERT_FILE:certdir+'/processor-server.crt',PROCESSOR__PROCESSOR_TLS_KEY_FILE:certdir+'/processor-server.key',COLLECTOR_CONFIG_FILE:state+'/collector.yaml',QUERY__QUERY_SNAPSHOTS_ENABLED:'true'},specs);
const compose=generate(env,{smpp,telemetry:root,state,envDir:state});
const bind=(source,target)=>({type:'bind',source,target,read_only:true});
for(const [name,svc]of Object.entries(compose.services)){
  svc.restart='no';
  if(svc.build){delete svc.build;if(['runtime','adapter'].includes(name))svc.image=process.env[name==='runtime'?'QUALIFICATION_RUNTIME_IMAGE':'QUALIFICATION_ADAPTER_IMAGE']??`smpp-remediation-${name}:20260907`;else{svc.image='node:22-bookworm-slim';svc.working_dir='/app';svc.volumes??=[];svc.volumes.push(bind(state+'/app','/app'));}}
  if(svc.ports)svc.ports=svc.ports.map(p=>`127.0.0.1::${p.split(':').at(-1)}`);
}
// Grafana remains configured for the full simulation chain; the telemetry-only command omits it.
const mt={'collector_server_cert':'collector-server.crt','collector_server_key':'collector-server.key','runtime_client_ca':'runtime-ca.crt','processor_server_ca':'processor-ca.crt','collector_client_cert':'collector-client.crt','collector_client_key':'collector-client.key'};
for(const [target,source]of Object.entries(mt))compose.services['otel-collector'].volumes.push(bind(certdir+'/'+source,'/run/secrets/'+target));
compose.services['otel-collector'].volumes.push(bind(state+'/clickhouse-password.secret','/run/secrets/clickhouse_password'));
const tunings=state+'/clickhouse-fixture.xml';writeFileSync(tunings,'<clickhouse><logger><level>warning</level></logger><max_server_memory_usage>2300000000</max_server_memory_usage><background_pool_size>4</background_pool_size><background_move_pool_size>2</background_move_pool_size><background_fetches_pool_size>2</background_fetches_pool_size><background_common_pool_size>2</background_common_pool_size><background_schedule_pool_size>8</background_schedule_pool_size><background_message_broker_schedule_pool_size>2</background_message_broker_schedule_pool_size><background_distributed_schedule_pool_size>2</background_distributed_schedule_pool_size><merge_tree><number_of_free_entries_in_pool_to_execute_mutation>2</number_of_free_entries_in_pool_to_execute_mutation><number_of_free_entries_in_pool_to_execute_optimize_entire_partition>2</number_of_free_entries_in_pool_to_execute_optimize_entire_partition><number_of_free_entries_in_pool_to_lower_max_size_of_merge>2</number_of_free_entries_in_pool_to_lower_max_size_of_merge></merge_tree></clickhouse>');
compose.services.clickhouse.volumes.push(bind(tunings,'/etc/clickhouse-server/config.d/qualification.xml'));compose.services.clickhouse.mem_limit='3g';compose.services.clickhouse.cpus=2;
compose.services['shared-test']=structuredClone(compose.services.clickhouse);compose.services['shared-test'].volumes=compose.services['shared-test'].volumes.map(v=>typeof v==='string'&&v.startsWith('clickhouse-data:')?v.replace('clickhouse-data:','shared-test-data:'):v);compose.volumes['shared-test-data']={};
writeFileSync(state+'/compose.json',JSON.stringify(compose,null,2));writeFileSync(state+'/environment.json',JSON.stringify(env,null,2));
writeFileSync(state+'/qualification.json',JSON.stringify({project,createdAt:new Date().toISOString(),externalSimulationHost:'192.168.2.63',externalRuntimeAdapterStarted:false},null,2));
console.log(state+'/compose.json');
