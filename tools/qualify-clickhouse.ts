/** Reproducible local database gate. Creates and removes only uniquely named, network-isolated test containers. */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

const names=[`smpp-qualification-${randomUUID()}`,`smpp-qualification-${randomUUID()}`];
const created:string[]=[];
async function run(command:string,args:string[],capture=false):Promise<string>{
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{stdio:['ignore',capture?'pipe':'inherit','pipe']});let output='',error='';
    child.stdout?.setEncoding('utf8');child.stderr?.setEncoding('utf8');
    child.stdout?.on('data',(chunk:string)=>{output+=chunk;});child.stderr?.on('data',(chunk:string)=>{error+=chunk;});
    child.once('error',reject);child.once('close',code=>code===0?resolve(output):reject(new Error(`${command} exited ${code}: ${error.slice(-2000)}`)));
  });
}
try{
  for(const [index,name]of names.entries()){
    const password=index===1?'e1-isolated-only':'';
    await run('docker',['run','--detach','--name',name,'--network','none','--memory','2g','--cpus','2',
      '--tmpfs','/var/lib/clickhouse:rw,size=1g','--env','CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1',...(password?['--env',`CLICKHOUSE_PASSWORD=${password}`]:['--env','CLICKHOUSE_SKIP_USER_SETUP=1']),
      'clickhouse/clickhouse-server:25.3.14.14'],true);created.push(name);
    const query=(sql:string)=>run('docker',['exec',name,'clickhouse-client',...(password?['--password',password]:[]),'--multiquery','--query',sql],true);
    let ready=false;
    for(let attempt=0;attempt<60;attempt++){try{await query('SELECT 1');ready=true;break;}catch{await new Promise(resolve=>setTimeout(resolve,500));}}
    if(!ready)throw new Error('QUALIFICATION_CLICKHOUSE_NOT_READY');
    for(const file of (await readdir('telemetry-schema/migrations')).filter(name=>name.endsWith('.sql')).sort())await query(await readFile(`telemetry-schema/migrations/${file}`,'utf8'));
  }
  for(const qualifier of ['snapshot','reader','target-manager','generation']){
    console.log(JSON.stringify({stage:qualifier,status:'running',environment:'isolated-simulation-telemetry'}));
    await run(process.execPath,[`dist/telemetry-dashboard/query-api/test/${qualifier}-clickhouse.qualification.js`,names[0]!,...(qualifier==='generation'?[names[1]!]:[])]);
  }
  await run(process.execPath,['dist/telemetry-schema/tools/migration-clickhouse.qualification.js']);
  console.log(JSON.stringify({status:'PASS',qualifiers:5,externalGameServiceUsed:false}));
}finally{
  for(const name of created.reverse())await run('docker',['rm','--force',name],true);
}
