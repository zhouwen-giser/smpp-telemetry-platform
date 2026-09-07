import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {migrate,acquireMigrationLock,type MigrationClient} from './migrate.js';
import {splitSql,assertMigrationSchema} from './migration-schema.js';

const ddl='CREATE TABLE IF NOT EXISTS telemetry_fixture.events (id UInt32, label String) ENGINE=MergeTree ORDER BY id';
interface Event {migration_name:string;file_sha256:string;status:string}
class FixtureClient implements MigrationClient {
  events:Event[]=[]; statements:string[]=[]; columnType='UInt32';engine='MergeTree'; failOnce=false; loseFailureEvent=false;
  async query(sql:string,body?:string):Promise<string>{
    if(sql.startsWith('INSERT INTO telemetry_meta.schema_migration_ledger_v1')){const event=JSON.parse(body!) as Event;if(this.loseFailureEvent&&event.status==='failed')throw Error('OFFLINE');this.events.push(event);return '';}
    if(sql.startsWith('SELECT migration_name'))return this.events.map(value=>JSON.stringify(value)).join('\n');
    if(sql.startsWith('CREATE DATABASE IF NOT EXISTS telemetry_meta')||sql.startsWith('CREATE TABLE IF NOT EXISTS telemetry_meta.schema_migration_ledger_v1'))return '';
    if(sql.startsWith('DESCRIBE TABLE'))return JSON.stringify({data:[{name:'id',type:this.columnType},{name:'label',type:'String'},{name:'extra',type:'String'}]});
    if(sql.startsWith('SELECT engine'))return this.engine;
    this.statements.push(sql);if(this.failOnce){this.failOnce=false;throw Error('INJECTED_STATEMENT_FAILURE');}return '';
  }
}
async function fixture(){const directory=await mkdtemp(join(tmpdir(),'smpp-migration-test-'));await writeFile(join(directory,'001_fixture.sql'),ddl+';');return {directory,lockFile:join(directory,'lock.sqlite'),client:new FixtureClient()};}

test('SQL strings and comments preserve semicolons and escaped quotes',()=>{
  assert.deepEqual(splitSql("-- skip;\nSELECT 'a;b', 'it''s'; /* ignored; */ SELECT 'x\\\';y';"),["SELECT 'a;b', 'it''s'","SELECT 'x\\\';y'"]);
  assert.throws(()=>splitSql("SELECT 'unfinished"),/UNTERMINATED/);
});
test('ClickHouse Boolean aliases compare by storage type without accepting wider integers',async()=>{
  const client=new FixtureClient();client.columnType='Bool';
  const sql=['CREATE TABLE IF NOT EXISTS telemetry_fixture.events (id Boolean) ENGINE=MergeTree ORDER BY id'];
  await assertMigrationSchema(client,sql);client.columnType='UInt8';await assertMigrationSchema(client,sql);
  client.columnType='UInt16';await assert.rejects(()=>assertMigrationSchema(client,sql),/MIGRATION_COLUMN_DRIFT/);
});
test('completed migration skips DDL but rechecks actual column and engine shape',async()=>{
  const f=await fixture();try{
    assert.deepEqual(await migrate(f),{applied:['001_fixture.sql'],skipped:[]});
    assert.deepEqual(f.client.events.map(e=>e.status),['started','completed']);
    const executions=f.client.statements.length;
    assert.deepEqual(await migrate(f),{applied:[],skipped:['001_fixture.sql']});assert.equal(f.client.statements.length,executions);
    f.client.columnType='String';await assert.rejects(()=>migrate(f),/MIGRATION_COLUMN_DRIFT/);
    f.client.columnType='UInt32';f.client.engine='Memory';await assert.rejects(()=>migrate(f),/MIGRATION_ENGINE_DRIFT/);
  }finally{await rm(f.directory,{recursive:true,force:true});}
});
test('failed attempt and lost failure response are retryable with the same file hash',async()=>{
  for(const loseFailureEvent of [false,true]){
    const f=await fixture();try{f.client.failOnce=true;f.client.loseFailureEvent=loseFailureEvent;
      await assert.rejects(()=>migrate(f),/INJECTED_STATEMENT_FAILURE/);assert.equal(f.client.events[0]?.status,'started');
      assert.deepEqual(await migrate(f),{applied:['001_fixture.sql'],skipped:[]});
      assert.equal(f.client.events.at(-1)?.status,'completed');assert.equal(new Set(f.client.events.map(e=>e.file_sha256)).size,1);
    }finally{await rm(f.directory,{recursive:true,force:true});}
  }
});
test('hash drift and missing historical migrations reject before new DDL',async()=>{
  const f=await fixture();try{await migrate(f);const count=f.client.statements.length;
    await writeFile(join(f.directory,'001_fixture.sql'),ddl+'; -- edited');await writeFile(join(f.directory,'002_new.sql'),ddl+';');
    await assert.rejects(()=>migrate(f),/MIGRATION_HASH_DRIFT/);assert.equal(f.client.statements.length,count);
    await rm(join(f.directory,'001_fixture.sql'));await assert.rejects(()=>migrate(f),/MIGRATION_HISTORY_MISSING/);assert.equal(f.client.statements.length,count);
  }finally{await rm(f.directory,{recursive:true,force:true});}
});
test('non-idempotent SQL is rejected before touching a database',async()=>{
  const f=await fixture();try{await writeFile(join(f.directory,'001_fixture.sql'),'DROP DATABASE telemetry_fixture;');await assert.rejects(()=>migrate(f),/MIGRATION_RETRY_SAFE_DDL_REQUIRED/);assert.deepEqual(f.client.events,[]);assert.deepEqual(f.client.statements,[]);}finally{await rm(f.directory,{recursive:true,force:true});}
});
test('independent process lock prevents overlap and survives owner crash without unlinking inode',async()=>{
  const f=await fixture();let child:ReturnType<typeof spawn>|undefined;
  try{
    child=spawn(process.execPath,['--input-type=module','-e',`import {acquireMigrationLock} from ${JSON.stringify(new URL('./migrate.js',import.meta.url).href)};await acquireMigrationLock(${JSON.stringify(f.lockFile)});console.log('LOCKED');setInterval(()=>{},1000);`],{stdio:['ignore','pipe','pipe']});
    let failure='';child.stderr?.on('data',value=>failure+=String(value));
    assert.ok(child.stdout);const [message]=await Promise.race([once(child.stdout,'data',{signal:AbortSignal.timeout(5000)}),once(child,'exit').then(()=>{throw Error('LOCK_CHILD_EXIT:'+failure);})]);assert.match(String(message),/LOCKED/);const inode=(await stat(f.lockFile)).ino;
    await assert.rejects(()=>acquireMigrationLock(f.lockFile),/MIGRATION_LOCAL_LOCK_HELD/);
    const exited=once(child,'exit');child.kill('SIGKILL');await exited;child=undefined;
    const release=await acquireMigrationLock(f.lockFile);release();assert.equal((await stat(f.lockFile)).ino,inode);
  }finally{if(child&&child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}await rm(f.directory,{recursive:true,force:true});}
});
