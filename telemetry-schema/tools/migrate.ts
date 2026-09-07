import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, chmod } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { ClickHouseClient } from '../../telemetry-processor/src/packages/exporters/clickhouse.js';
import { assertMigrationSchema, splitSql, validateMigrationStatements } from './migration-schema.js';

export interface MigrationClient { query(sql: string, body?: string): Promise<string> }
export interface MigrationFile { name: string; sha256: string; statements: string[] }
interface LedgerEvent { migration_name: string; file_sha256: string; status: 'started'|'completed'|'failed' }
const ledger='telemetry_meta.schema_migration_ledger_v1';
const ledgerDdl=`CREATE TABLE IF NOT EXISTS ${ledger} (
  migration_name String, file_sha256 FixedString(64), attempt_id UUID,
  status Enum8('started'=1,'completed'=2,'failed'=3),
  started_at DateTime64(3,'UTC'), finished_at Nullable(DateTime64(3,'UTC')), error_code String
) ENGINE=MergeTree ORDER BY (migration_name,started_at,attempt_id,status)`;

/** Same-host advisory lock only. Every migrator for a deployment must share this inode.
 * Never unlink it: SQLite's OS lock and rollback journal are released on process death. */
export async function acquireMigrationLock(path: string): Promise<() => void> {
  await mkdir(dirname(path),{recursive:true,mode:0o700});
  const db=new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS migration_guard (id INTEGER)');
    await chmod(path,0o600);
  } catch(error) {
    db.close();
    if(error instanceof Error && /(?:locked|busy)/i.test(error.message))throw new Error('MIGRATION_LOCAL_LOCK_HELD');
    throw error;
  }
  let released=false;
  return ()=>{if(!released){released=true;db.close();}};
}

export async function loadMigrations(directory: string): Promise<MigrationFile[]> {
  const names=(await readdir(directory)).filter(name=>name.endsWith('.sql')).sort();
  if(!names.length)throw new Error('MIGRATION_FILES_REQUIRED');
  const versions=new Set<string>();
  const files:MigrationFile[]=[];
  for(const name of names){
    const match=/^(\d{3})_[A-Za-z0-9_-]+\.sql$/.exec(name);
    if(!match || versions.has(match[1]!))throw new Error('MIGRATION_FILENAME_INVALID');
    versions.add(match[1]!);
    const bytes=await readFile(join(directory,name));
    const statements=splitSql(bytes.toString('utf8'));validateMigrationStatements(statements);
    files.push({name,sha256:createHash('sha256').update(bytes).digest('hex'),statements});
  }
  return files;
}

function historyRows(raw: string): LedgerEvent[] {
  return raw.trim().split('\n').filter(Boolean).map(line=>{
    const value:unknown=JSON.parse(line);
    if(!value || typeof value!=='object' || !('migration_name'in value) || typeof value.migration_name!=='string'
      || !('file_sha256'in value) || typeof value.file_sha256!=='string' || !/^[a-f0-9]{64}$/.test(value.file_sha256)
      || !('status'in value) || !['started','completed','failed'].includes(String(value.status)))throw new Error('MIGRATION_LEDGER_INVALID');
    return {migration_name:value.migration_name,file_sha256:value.file_sha256,status:value.status as LedgerEvent['status']};
  });
}
export async function migrate({client,directory,lockFile,log=()=>{}}:{client:MigrationClient;directory:string;lockFile:string;log?:(value:{migration:string;status:string;sha256:string})=>void}):Promise<{applied:string[];skipped:string[]}> {
  const release=await acquireMigrationLock(lockFile);
  try {
    const files=await loadMigrations(directory);
    await client.query('CREATE DATABASE IF NOT EXISTS telemetry_meta');
    await client.query(ledgerDdl);
    const history=historyRows(await client.query(`SELECT migration_name,file_sha256,status FROM ${ledger} FORMAT JSONEachRow`));
    const byName=new Map(files.map(file=>[file.name,file]));
    // Check all historical hashes before executing any new DDL, including interrupted attempts.
    for(const event of history){
      const file=byName.get(event.migration_name);
      if(!file)throw new Error(`MIGRATION_HISTORY_MISSING:${event.migration_name}`);
      if(file.sha256!==event.file_sha256)throw new Error(`MIGRATION_HASH_DRIFT:${file.name}`);
    }
    const result:{applied:string[];skipped:string[]}={applied:[],skipped:[]};
    const completed=new Set(history.filter(event=>event.status==='completed').map(event=>event.migration_name));
    for(const file of files){
      if(completed.has(file.name)){
        await assertMigrationSchema(client,file.statements);
        result.skipped.push(file.name);log({migration:file.name,status:'verified_completed',sha256:file.sha256});continue;
      }
      const attempt={migration_name:file.name,file_sha256:file.sha256,attempt_id:randomUUID(),started_at:new Date().toISOString()};
      const record=async(status:LedgerEvent['status'],error_code='')=>client.query(`INSERT INTO ${ledger} SETTINGS date_time_input_format='best_effort' FORMAT JSONEachRow`,JSON.stringify({...attempt,status,finished_at:status==='started'?null:new Date().toISOString(),error_code})+'\n');
      await record('started');
      try {
        for(const statement of file.statements)await client.query(statement);
        await assertMigrationSchema(client,file.statements);
        await record('completed');
        result.applied.push(file.name);log({migration:file.name,status:'completed',sha256:file.sha256});
      }catch(error){
        const reason=error instanceof Error && /^[A-Z][A-Z0-9_:.-]{0,200}$/.test(error.message)?error.message:'MIGRATION_EXECUTION_FAILED';
        try{await record('failed',reason);}catch{/* A durable started event makes an interrupted attempt retryable. */}
        throw error;
      }
    }
    return result;
  }finally{release();}
}

export async function main():Promise<void>{
  const client=new ClickHouseClient({url:process.env.CLICKHOUSE_URL??'http://127.0.0.1:8123',user:process.env.CLICKHOUSE_USER??'default',password:process.env.CLICKHOUSE_PASSWORD??'',passwordFile:process.env.CLICKHOUSE_PASSWORD_FILE??''});
  await client.initialize();
  await migrate({client,directory:resolve(process.env.MIGRATION_DIRECTORY??'telemetry-schema/migrations'),lockFile:resolve(process.env.MIGRATION_LOCK_FILE??'var/migration-lock/migration.sqlite'),log:value=>console.log(JSON.stringify(value))});
}
if(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url)await main();
