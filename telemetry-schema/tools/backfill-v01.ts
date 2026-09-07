import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { ClickHouseClient } from '../../telemetry-processor/src/packages/exporters/clickhouse.js';
import { planBackfill, exportBackfill, validateBackfill, runBackfill, backfillStatus, type BackfillConfiguration } from '../../telemetry-processor/src/packages/replay/backfill.js';
export async function backfillCli(args:string[]):Promise<unknown>{
  const[action,file]=args;if(!action||!file||args.length!==2||!['plan','export','validate','run','status'].includes(action))throw new Error('Usage: backfill:v01 plan|export|validate|run|status <configuration.json>');
  const config=JSON.parse(await readFile(file,'utf8')) as BackfillConfiguration;
  if(action==='validate')return validateBackfill(config);if(action==='run')return runBackfill(config);if(action==='status')return backfillStatus(config);
  const client=new ClickHouseClient({url:process.env.CLICKHOUSE_URL??'http://127.0.0.1:8123',user:process.env.CLICKHOUSE_USER??'default',password:process.env.CLICKHOUSE_PASSWORD??'',passwordFile:process.env.CLICKHOUSE_PASSWORD_FILE??''});await client.initialize();
  return action==='plan'?planBackfill(client,config):exportBackfill(client,config);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){backfillCli(process.argv.slice(2)).then(value=>{console.log(JSON.stringify(value));if(value&&typeof value==='object'&&'status'in value&&(value.status==='partial'||value.status==='failed'))process.exitCode=2;}).catch(error=>{console.error(JSON.stringify({error:error instanceof Error?error.message:'BACKFILL_FAILED'}));process.exitCode=1;});}
