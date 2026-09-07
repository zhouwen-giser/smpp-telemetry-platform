import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,writeFile,copyFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import assert from 'node:assert/strict';
import {migrate,loadMigrations,type MigrationClient} from './migrate.js';
const root=process.cwd(),state=await mkdtemp(join(tmpdir(),'smpp-migration-qualification-'));
const name=`smpp-remediation-migration-${process.pid}-${Date.now()}`,password='isolated-migration-only';
const output=resolve(process.env.QUALIFICATION_OUTPUT??'reports/remediation-20260907/migration');await mkdir(output,{recursive:true});
const docker=(args:string[],input?:string)=>execFileSync('docker',args,{encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024,...(input===undefined?{}:{input})});
const client:MigrationClient={query:async(sql,body)=>docker(['exec',...(body===undefined?[]:['-i']),name,'clickhouse-client','--password',password,'--query',sql],body)};
const full=join(state,'full'),old=join(state,'old'),lockFile=join(state,'lock.sqlite');await mkdir(full);await mkdir(old);
for(const file of (await readdir(resolve(root,'telemetry-schema/migrations'))).filter(name=>name.endsWith('.sql'))){await copyFile(resolve(root,'telemetry-schema/migrations',file),join(full,file));if(Number(file.slice(0,3))<=6)await copyFile(join(full,file),join(old,file));}
const report:{status:string;cases:Record<string,unknown>[];error?:string}={status:'RUNNING',cases:[]};
try{
 docker(['run','-d','--name',name,'--network','none','--tmpfs','/var/lib/clickhouse:rw,size=2g','--memory','3g','--cpus','2','-e',`CLICKHOUSE_PASSWORD=${password}`,'clickhouse/clickhouse-server:25.3.14.14']);
 for(let i=0;i<60;i++){try{await client.query('SELECT 1');break;}catch(error){if(i===59)throw error;await new Promise(r=>setTimeout(r,500));}}
 // Simulate a pre-ledger install, with actual old DDL and no forged completion rows.
 for(const file of await loadMigrations(old))for(const sql of file.statements)await client.query(sql);
 const adoption=await migrate({client,directory:old,lockFile});assert.equal(adoption.applied.length,6);report.cases.push({name:'adopt_existing_001_006',...adoption});
 const repeated=await migrate({client,directory:old,lockFile});assert.equal(repeated.applied.length,0);assert.equal(repeated.skipped.length,6);report.cases.push({name:'repeat_completed_install',...repeated});
 let interrupted=false;
 const failing:MigrationClient={query:async(sql,body)=>{if(!interrupted&&sql.startsWith('ALTER TABLE telemetry_landing')&&sql.includes('delivery_class')){interrupted=true;throw Error('QUALIFICATION_INTERRUPTION');}return client.query(sql,body);}};
 await assert.rejects(()=>migrate({client:failing,directory:full,lockFile}),/QUALIFICATION_INTERRUPTION/);
 const upgraded=await migrate({client,directory:full,lockFile});assert.equal(upgraded.applied.length,(await loadMigrations(full)).length-6);report.cases.push({name:'partial_upgrade_retry',...upgraded});
 const again=await migrate({client,directory:full,lockFile});assert.equal(again.applied.length,0);report.cases.push({name:'repeat_full_schema_verified',skipped:again.skipped.length});
 const finalName=(await loadMigrations(full)).at(-1)!.name;await writeFile(join(full,finalName),(await readFile(join(full,finalName),'utf8'))+'\n-- drift');
 await assert.rejects(()=>migrate({client,directory:full,lockFile}),/MIGRATION_HASH_DRIFT/);report.cases.push({name:'historical_hash_drift',rejected:true});
 await copyFile(resolve(root,'telemetry-schema/migrations',finalName),join(full,finalName));
 await client.query('ALTER TABLE telemetry_meta.source_mapping DROP COLUMN source_product');
 await assert.rejects(()=>migrate({client,directory:full,lockFile}),/MIGRATION_COLUMN_DRIFT/);report.cases.push({name:'actual_schema_drift',rejected:true});
 report.cases.push({name:'ledger',rows:JSON.parse(await client.query('SELECT migration_name,status,count() AS events FROM telemetry_meta.schema_migration_ledger_v1 GROUP BY migration_name,status ORDER BY migration_name,status FORMAT JSON'))});
 report.status='PASS';
}catch(error){report.status='FAIL';report.error=error instanceof Error?(error.stack??error.message):String(error);process.exitCode=1;}
finally{try{docker(['rm','-f',name]);}catch{}await writeFile(join(output,'result.json'),JSON.stringify(report,null,2));await rm(state,{recursive:true,force:true});}
console.log(JSON.stringify(report,null,2));
