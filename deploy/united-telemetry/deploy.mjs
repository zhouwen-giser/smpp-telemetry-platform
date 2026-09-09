import fs from 'node:fs';import path from 'node:path';import{fileURLToPath}from'node:url';import{spawnSync}from'node:child_process';import{createHash}from'node:crypto';import{parseEnv}from'node:util';
const root=path.dirname(fileURLToPath(import.meta.url));const [action='status',...args]=process.argv.slice(2);let smppRoot='/mnt/data/smpp-united-current',state='/mnt/data/smpp-telemetry-state',prebuilt=false;
for(let i=0;i<args.length;i++){if(args[i]==='--smpp-root')smppRoot=args[++i];else if(args[i]==='--state-root')state=args[++i];else if(args[i]==='--prebuilt')prebuilt=true;else throw Error('UNKNOWN_OPTION');}
if(!['verify','build-images','up','status','logs','upstream'].includes(action))throw Error('Use verify|build-images|up|status|logs|upstream');
const hash=b=>createHash('sha256').update(b).digest('hex');const manifest=JSON.parse(fs.readFileSync(path.join(root,'UNION.json'),'utf8'));
function run(command,argv,options={}){const r=spawnSync(command,argv,{cwd:root,stdio:'inherit',...options});if(r.error||r.status!==0)throw Error('COMMAND_FAILED:'+command+':'+r.status);return r.stdout;}
const capture=(cmd,argv)=>run(cmd,argv,{encoding:'utf8',stdio:['ignore','pipe','inherit']}).toString().trim();
const verify=()=>{for(const line of fs.readFileSync(path.join(root,'SHA256SUMS'),'utf8').trim().split('\n')){const m=/^([a-f0-9]{64})  (.+)$/.exec(line);if(!m||m[2].includes('..')||path.isAbsolute(m[2])||hash(fs.readFileSync(path.join(root,m[2])))!==m[1])throw Error('PACKAGE_INTEGRITY_FAILED');}};verify();
const telemetry=path.join(root,'telemetry'),union=path.join(root,'upstream-extracted',manifest.upstream.root);
if(!fs.existsSync(telemetry))run('python3',[path.join(root,'extract.py'),path.join(root,'upstream/telemetry.tar.gz'),telemetry]);
if(!fs.existsSync(union))run('python3',[path.join(root,'extract.py'),path.join(root,'upstream/smpp-united.tar.gz'),path.join(root,'upstream-extracted')]);
const upstream=JSON.parse(fs.readFileSync(path.join(union,'UNION.json'),'utf8'));
if(action==='verify'){console.log('UNITED_TELEMETRY_PACKAGE_PASS');process.exit(0);}
if(action==='upstream'){run('bash',[path.join(union,'deploy.sh'),'up',...(prebuilt?['--prebuilt']:[])]);process.exit(0);}
const image='smpp-telemetry:'+manifest.telemetry.revision;
function build(){run('docker',['build','--network','host','--build-arg','VCS_REF='+manifest.telemetry.revision,'-t',image,'-f',path.join(telemetry,'telemetry-processor/Dockerfile'),telemetry]);}
if(action==='build-images'){build();process.exit(0);}
state=path.resolve(state);const composeFile=path.join(state,'compose.json');const docker=(...a)=>run('docker',['compose','--env-file','/dev/null','-p','smpp-telemetry','-f',composeFile,...a]);
if(['status','logs'].includes(action)){if(!fs.existsSync(composeFile))throw Error('DEPLOYMENT_NOT_FOUND');docker(...(action==='status'?['ps','--all']:['logs','--tail','100']));process.exit(0);}
smppRoot=fs.realpathSync(smppRoot);
if(hash(fs.readFileSync(path.join(smppRoot,'UNION.json')))!==hash(fs.readFileSync(path.join(union,'UNION.json'))))throw Error('DEPLOYED_UPSTREAM_DIFFERS_FROM_PINNED_PACKAGE');
const smpp=path.join(smppRoot,'smpp'),server=path.join(smpp,'deploy/development/server');
const inspect=names=>JSON.parse(capture('docker',['inspect',...names]));const runtime=inspect(['smpp-gowm-runtime-1'])[0];
if(runtime.Config.Labels['com.docker.compose.project']!=='smpp-gowm'||runtime.Config.Labels['org.opencontainers.image.revision']!==upstream.smpp.revision)throw Error('SMPP_RUNTIME_OWNER_OR_REVISION_MISMATCH');
const smppCompose=path.join(server,'state/compose.json');if(fs.realpathSync(runtime.Config.Labels['com.docker.compose.project.config_files'])!==fs.realpathSync(smppCompose))throw Error('SMPP_COMPOSE_OWNER_MISMATCH');
const oldCompose=JSON.parse(fs.readFileSync(smppCompose,'utf8'));
if(oldCompose.services['runtime-db']||oldCompose.services['adapter-db']||oldCompose.services.runtime.environment.SMPP_STORAGE_MODE!=='gowm-shared')throw Error('GOWM_SHARED_STORAGE_REQUIRED');
fs.mkdirSync(state,{recursive:true,mode:0o700});fs.chmodSync(state,0o700);const lock=path.join(state,'deploy.lock');const fd=fs.openSync(lock,'wx',0o600);fs.writeSync(fd,String(process.pid));
const envPath=path.join(server,'.env');const beforeEnv=fs.readFileSync(envPath);const beforeCompose=fs.readFileSync(smppCompose);let runtimeChanged=false;
try{
 const ownerFile=path.join(state,'owner.json');if(fs.existsSync(ownerFile)){const owner=JSON.parse(fs.readFileSync(ownerFile,'utf8'));if(owner.project!=='smpp-telemetry'||owner.smppProject!=='smpp-gowm')throw Error('TELEMETRY_STATE_OWNER_MISMATCH');}
 else{const existing=capture('docker',['ps','-aq','--filter','label=com.docker.compose.project=smpp-telemetry']);if(existing)throw Error('UNOWNED_TELEMETRY_PROJECT_EXISTS');fs.writeFileSync(ownerFile,JSON.stringify({project:'smpp-telemetry',smppProject:'smpp-gowm'}),{mode:0o600});}
 const all=inspect(capture('docker',['ps','-q']).split(/\s+/));const preserved=all.filter(c=>c.Name!=='/smpp-gowm-runtime-1'&&c.Config.Labels?.['com.docker.compose.project']!=='smpp-telemetry').map(c=>({id:c.Id,name:c.Name,startedAt:c.State.StartedAt}));
 const env=Object.fromEntries(runtime.Config.Env.map(e=>e.split(/=(.*)/s).slice(0,2)));
 const identity={RUNTIME_INSTANCE_ID:env.RUNTIME_INSTANCE_ID||'smpp-sz-gowm-runtime',RUNTIME_DEPLOYMENT_ID:env.RUNTIME_DEPLOYMENT_ID||'smpp-sz-gowm',PROVIDER_ID:env.PROVIDER_ID||'isr.vehicle.ugv.ugv1'};
 const {attachedCompose}=await import(path.join(telemetry,'deploy/united-telemetry/config.mjs'));const overridesFile=path.join(root,'telemetry.env');const overrides=fs.existsSync(overridesFile)?parseEnv(fs.readFileSync(overridesFile,'utf8')):{};
 if(Object.keys(overrides).some(k=>!['CLICKHOUSE_IMAGE','COLLECTOR_IMAGE','GRAFANA_IMAGE','DEPLOY_BIND_ADDRESS','DEPLOY_PUBLIC_HOST','SHARED__URL','SHARED__USER','SHARED__PASSWORD_FILE'].includes(k)&&!/^PORT_[A-Z_]+$/.test(k)))throw Error('UNSUPPORTED_TELEMETRY_OVERRIDE');
 const c=attachedCompose({telemetry,smpp,state,revision:manifest.telemetry.revision,runtime:identity,network:'smpp-gowm_default',overrides,managedSchema:Boolean(manifest.sdarSchema)});
 for(const svc of Object.values(c.services)){if(svc.build){svc.image=image;delete svc.build;}}
 fs.writeFileSync(composeFile,JSON.stringify(c,null,2)+'\n',{mode:0o600});docker('config','--quiet');
 if(!prebuilt)build();const built=inspect([image])[0];if(built.Config.Labels['org.opencontainers.image.revision']!==manifest.telemetry.revision)throw Error('TELEMETRY_IMAGE_REVISION_MISMATCH');
 const arch=capture('docker',['info','--format','{{.Architecture}}']);if(built.Architecture!==({x86_64:'amd64',aarch64:'arm64'}[arch]??arch))throw Error('IMAGE_ARCHITECTURE_MISMATCH');
 docker('up','-d','--wait','--wait-timeout','180','clickhouse',...(manifest.sdarSchema?['sdar-clickhouse']:[]));
 if(manifest.sdarSchema)run('python3',[path.join(telemetry,'deploy/united-telemetry/schema.py'),'restore',path.join(root,'sdar/schema.json'),state,composeFile,path.join(root,'sdar/schema-contract-release.jsonl')]);docker('run','--rm','--no-deps','telemetry-migrate');
 const {writerProgram,readerProgram}=await import(path.join(telemetry,'deploy/joint-development/preflight.mjs'));
 for(const [service,program]of [['telemetry-processor',writerProgram],['query-api',readerProgram]])docker('run','--rm','--no-deps','--entrypoint','node',service,'--input-type=module','-e',program);
 docker('run','--rm','--no-deps','otel-collector','validate','--config=/etc/otelcol/config.yaml');docker('up','-d','--no-build','--wait','--wait-timeout','240');
 const backup=path.join(state,'runtime-before-'+Date.now());fs.writeFileSync(backup+'.env',beforeEnv,{mode:0o600});fs.writeFileSync(backup+'.compose.json',beforeCompose,{mode:0o600});
 let next=beforeEnv.toString();for(const [k,v]of Object.entries({RUNTIME__OTEL_ENABLED:'true',RUNTIME__OTEL_EXPORTER_OTLP_ENDPOINT:'http://smpp-telemetry-collector:4318',RUNTIME__OTEL_SERVICE_INSTANCE_ID:identity.RUNTIME_INSTANCE_ID,RUNTIME__RUNTIME_INSTANCE_ID:identity.RUNTIME_INSTANCE_ID,RUNTIME__RUNTIME_DEPLOYMENT_ID:identity.RUNTIME_DEPLOYMENT_ID})){const regex=new RegExp('^\\s*#?\\s*'+k+'=.*$','m');if(!regex.test(next))throw Error('SMPP_TEMPLATE_KEY_MISSING:'+k);next=next.replace(regex,k+'='+JSON.stringify(v));}
 runtimeChanged=true;fs.writeFileSync(envPath,next,{mode:0o600});run(process.execPath,[path.join(server,'package.mjs'),'config']);
 run('docker',['compose','-p','smpp-gowm','-f',smppCompose,'up','-d','--no-deps','--no-build','--wait','--wait-timeout','240','runtime']);
 const after=inspect(preserved.map(c=>c.id));if(after.some((c,i)=>c.State.StartedAt!==preserved[i].startedAt))throw Error('UPSTREAM_SERVICE_RESTARTED');
 const report={status:'PASS',at:new Date().toISOString(),upstream:manifest.upstream,telemetry:manifest.telemetry,smppRoot,composeFile,runtimeIdentity:identity,executionMode:'live',businessStorage:'existing GOWM; no business migrations or credentials changed',preservedContainers:preserved.length,authority:manifest.sdarSchema?'managed SDAR ClickHouse; Authority enabled':overrides.SHARED__URL?'configured SDAR ClickHouse':'disabled (no shared ClickHouse configured)',runtimeBackup:backup};
 fs.writeFileSync(path.join(state,'deployment.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(report));
}catch(error){if(runtimeChanged){fs.writeFileSync(envPath,beforeEnv);fs.writeFileSync(smppCompose,beforeCompose);try{run('docker',['compose','-p','smpp-gowm','-f',smppCompose,'up','-d','--no-deps','--no-build','runtime']);}catch{console.error('RUNTIME_RESTORE_REQUIRES_ATTENTION');}}throw error;}
finally{fs.closeSync(fd);fs.unlinkSync(lock);}
