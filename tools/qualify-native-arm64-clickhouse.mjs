/** Explicit native ARM64 gate for a reviewed local source-built ClickHouse image. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {selectContract,validateImageIdentity,validateBinaryIdentity} from './native-arm64-clickhouse-contract.mjs';

if(process.arch!=='arm64'||process.version!=='v22.23.2')throw Error('NATIVE_NODE_22_23_2_REQUIRED');
if(process.env.ARM64_QUALIFICATION_ISOLATED!=='1')throw Error('ISOLATED_QUALIFICATION_DIRECTORY_REQUIRED');
const image=process.env.ARM64_CLICKHOUSE_IMAGE;
if(!image)throw Error('REVIEWED_ARM64_CLICKHOUSE_IMAGE_REQUIRED');
const contract=selectContract(process.env.ARM64_CLICKHOUSE_MODE);
const output=resolve(`reports/remediation-20260907/arm64/${contract.releaseQualification?'clickhouse':`clickhouse-${contract.mode}`}`);await mkdir(output,{recursive:true});
/** @type {string[]} */
const created=[];
const id=randomUUID(),names=[`smpp-arm64-db-${id}-a`,`smpp-arm64-db-${id}-b`];
/** @type {{status:string,contract:import('./native-arm64-clickhouse-contract.mjs').ClickHouseContract,runId:string,node:string,architecture:string,image:string,cases:Array<Record<string,unknown>>,containers:Array<{name:string,network:string,memoryLimit:string,cpuLimit:number,pidsLimit:number,data:string}>,cleanup:Array<{name:string,removed:boolean,alreadyAbsent?:boolean,error?:string}>,resourceConfiguration:{backgroundSchedulePoolSize:number,backgroundPoolSize:number,maxServerMemoryBytes:number},imageId?:string,sourceLabels?:Record<string,string>,embeddedBuildOptions?:Record<string,string>,availableMemoryMiB?:number,version?:string,error?:string}} */
const report={status:'RUNNING',runId:id,node:process.version,architecture:process.arch,image,cases:[],containers:[],cleanup:[],contract,resourceConfiguration:{backgroundSchedulePoolSize:8,backgroundPoolSize:4,maxServerMemoryBytes:1500000000}};
/** @type {Set<ReturnType<typeof spawn>>} */
const children=new Set();
/** @type {string|null} */
let stopping=null;
for(const signal of['SIGINT','SIGTERM','SIGHUP'])process.on(signal,()=>{if(stopping)return;stopping=signal;process.exitCode=1;for(const child of children)child.kill('SIGTERM');});
/** @param {string} command @param {string[]} args @param {{input?:string,timeout?:number,cleanup?:boolean}} [options] @returns {Promise<string>} */
async function run(command,args,{input,timeout=120000,cleanup=false}={}){
  if(stopping&&!cleanup)throw Error(`QUALIFICATION_INTERRUPTED:${stopping}`);
  return new Promise((resolveRun,reject)=>{
    const child=spawn(command,args,{stdio:['pipe','pipe','pipe']});children.add(child);let stdout='',stderr='';
    const timer=setTimeout(()=>child.kill('SIGTERM'),timeout);timer.unref();
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});
    child.once('error',error=>{clearTimeout(timer);children.delete(child);reject(error);});child.stdin.once('error',error=>{if(!('code'in error)||error.code!=='EPIPE')reject(error);});
    child.once('close',(code,signal)=>{clearTimeout(timer);children.delete(child);code===0?resolveRun(stdout):reject(Object.assign(Error(`${command} failed: code=${code} signal=${signal}: ${stderr.slice(-3000)}`),{stdout,stderr}));});
    child.stdin.end(input);
  });
}
/** @param {string[]} args @param {{input?:string,timeout?:number,cleanup?:boolean}} [options] */
const docker=(args,options)=>run('docker',args,options);
/** @param {string} name @param {string} password @returns {import('../telemetry-schema/tools/migrate.js').MigrationClient} */
const client=(name,password)=>({query:(sql,body)=>docker(['exec','-i',name,'clickhouse-client',...(password?['--password',password]:[]),'--date_time_input_format=best_effort','--query',sql],{input:body})});
try{
  assert.match((await docker(['info','--format','{{.Architecture}}'])).trim(),/^(arm64|aarch64)$/);
  const info=JSON.parse(await docker(['image','inspect',image]))[0];validateImageIdentity(info,contract);
  const labels=info.Config?.Labels??{};
  report.imageId=info.Id;report.sourceLabels=labels;
  const cpu=await readFile('/proc/cpuinfo','utf8');assert.match(cpu,/Features\s*:[^\n]*\bcrc32\b/);
  const memory=await readFile('/proc/meminfo','utf8'),availableMiB=Number(memory.match(/^MemAvailable:\s+(\d+)/m)?.[1]??0)/1024;
  report.availableMemoryMiB=Math.floor(availableMiB);
  if(availableMiB<7168)throw Error('ARM64_CLICKHOUSE_RESOURCE_RESERVE_REQUIRED');
  report.version=(await docker(['run','--rm','--platform','linux/arm64','--network','none','--memory','512m','--cpus','1','--pids-limit','128','--entrypoint','clickhouse',image,'--version'])).trim();
  /** @type {{data:Array<{name:string,value:string}>}} */
  const buildOptions=JSON.parse(await docker(['run','--rm','--platform','linux/arm64','--network','none','--memory','768m','--cpus','1','--pids-limit','256','--entrypoint','clickhouse',image,'local','--query',"SELECT name,value FROM system.build_options WHERE name IN ('VERSION_FULL','VERSION_GITHASH','VERSION_DESCRIBE') FORMAT JSON"]));
  report.embeddedBuildOptions=Object.fromEntries(buildOptions.data.map(row=>[row.name,row.value]));
  validateBinaryIdentity(report.version,report.embeddedBuildOptions,contract);
  /** @type {typeof import('../telemetry-schema/tools/migrate.js')} */
  const migrationApi=await import(pathToFileURL(resolve('dist/telemetry-schema/tools/migrate.js')).href);
  const {migrate,loadMigrations}=migrationApi;
  const migrations=resolve('telemetry-schema/migrations'),expected=(await loadMigrations(migrations)).length;
  const resourceConfig=join(output,'qualification-resources.xml');
  await writeFile(resourceConfig,'<clickhouse><logger><level>warning</level></logger><max_server_memory_usage>1500000000</max_server_memory_usage><background_pool_size>4</background_pool_size><background_move_pool_size>2</background_move_pool_size><background_fetches_pool_size>2</background_fetches_pool_size><background_common_pool_size>2</background_common_pool_size><background_schedule_pool_size>8</background_schedule_pool_size><background_message_broker_schedule_pool_size>2</background_message_broker_schedule_pool_size><background_distributed_schedule_pool_size>2</background_distributed_schedule_pool_size><merge_tree><number_of_free_entries_in_pool_to_execute_mutation>2</number_of_free_entries_in_pool_to_execute_mutation><number_of_free_entries_in_pool_to_execute_optimize_entire_partition>2</number_of_free_entries_in_pool_to_execute_optimize_entire_partition><number_of_free_entries_in_pool_to_lower_max_size_of_merge>2</number_of_free_entries_in_pool_to_lower_max_size_of_merge></merge_tree></clickhouse>\n',{mode:0o644});
  for(const[index,name]of names.entries()){
    const password=index===1?'e1-isolated-only':'';
    created.push(name);
    await docker(['run','--detach','--platform','linux/arm64','--name',name,'--network','none','--memory','2g','--cpus','1','--pids-limit','512',
      '--label',`io.smpp.qualification=${id}`,'--tmpfs','/var/lib/clickhouse:rw,size=1g','--mount',`type=bind,src=${resourceConfig},dst=/etc/clickhouse-server/config.d/zzzz-qualification-resources.xml,readonly`,'--env','CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1',
      ...(password?['--env',`CLICKHOUSE_PASSWORD=${password}`]:['--env','CLICKHOUSE_SKIP_USER_SETUP=1']),image]);
    report.containers.push({name,network:'none',memoryLimit:'2g',cpuLimit:1,pidsLimit:512,data:'tmpfs, max 1g'});
    const connection=client(name,password);let ready=false;
    for(let attempt=0;attempt<120;attempt++){try{await connection.query('SELECT 1');ready=true;break;}catch{await new Promise(resolveWait=>setTimeout(resolveWait,500));}}
    assert.ok(ready,'ARM64_CLICKHOUSE_NOT_READY');
    const lockFile=join(output,`migration-${index}.sqlite`),first=await migrate({client:connection,directory:migrations,lockFile}),second=await migrate({client:connection,directory:migrations,lockFile});
    assert.equal(first.applied.length,expected);assert.equal(second.applied.length,0);assert.equal(second.skipped.length,expected);
    report.cases.push({name:`native_migration_${index}`,first,second});
  }
  for(const qualifier of['snapshot','reader','target-manager','generation']){
    try{
      const text=await run(process.execPath,[`dist/telemetry-dashboard/query-api/test/${qualifier}-clickhouse.qualification.js`,names[0],...(qualifier==='generation'?[names[1]]:[])],{timeout:600000});
      await writeFile(join(output,`${qualifier}.txt`),text);report.cases.push({name:qualifier,status:'PASS'});
    }catch(error){await writeFile(join(output,`${qualifier}.txt`),(error.stdout??'')+'\n'+(error.stderr??String(error)));throw error;}
  }
  report.status='PASS';
}catch(error){report.status='FAIL';report.error=error instanceof Error?(error.stack??error.message):String(error);process.exitCode=1;}
finally{
  if(stopping){report.status='FAIL';report.error=`QUALIFICATION_INTERRUPTED:${stopping}`;}
  for(const name of created.reverse())try{
    let candidate;
    for(let attempt=0;attempt<(stopping?3:1);attempt++){
      candidate=JSON.parse(await docker(['container','ls','--all','--filter',`name=^/${name}$`,'--filter',`label=io.smpp.qualification=${id}`,'--format','{{json .}}'],{cleanup:true})||'null');
      if(candidate)break;if(stopping)await new Promise(resolveWait=>setTimeout(resolveWait,300));
    }
    if(candidate){
      // These log paths belong only to our freshly created containers. Preserve
      // startup failures before removing the isolated writable container layer.
      try{await docker(['cp',`${name}:/var/log/clickhouse-server/clickhouse-server.err.log`,join(output,`server-${names.indexOf(name)}.error.log`)],{cleanup:true});}catch{}
      await docker(['rm','--force','--volumes',name],{cleanup:true});
    }report.cleanup.push({name,removed:true,alreadyAbsent:!candidate});
  }catch(error){report.cleanup.push({name,removed:false,error:String(error)});report.status='FAIL';process.exitCode=1;}
  await writeFile(join(output,'result.json'),JSON.stringify(report,null,2)+'\n');
}
console.log(JSON.stringify(report,null,2));
