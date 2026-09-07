import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { WalStore } from '../wal/wal.js';
import { loadProjectionTargets } from '../exporters/target-manager.js';
import { ReplayManager, type ReplayRequest } from './replay.js';
import { createReplayExecutor } from './executor.js';

/** Offline CLI requires the WAL writer to be stopped. Live deployments use the authenticated admin API. */
export async function replayCli(args:string[],write:(value:unknown)=>void=value=>console.log(JSON.stringify(value))):Promise<void>{
  const[action,subject,...rest]=args;
  if(!action||!subject)throw new Error('Usage: replay plan|create <request.json> --wal <directory>; replay status|start|pause|resume|cancel|run <id> --wal <directory> [--targets <isolated-targets.json> --live-targets <live-targets.json>]');
  const options:Record<string,string>={};for(let index=0;index<rest.length;index+=2){const key=rest[index],value=rest[index+1];if(!key?.startsWith('--')||!value||!['--wal','--targets','--live-targets','--batch-size'].includes(key)||options[key]!==undefined)throw new Error('REPLAY_CLI_ARGUMENT_INVALID');options[key]=value;}
  if(!options['--wal'])throw new Error('REPLAY_WAL_DIRECTORY_REQUIRED');
  const wal=new WalStore({directory:options['--wal'],gcEnabled:false});await wal.initialize();
  try{
    const replays=new ReplayManager(wal);
    if(action==='plan'||action==='create'){const request=JSON.parse(await readFile(subject,'utf8')) as ReplayRequest;write(action==='plan'?replays.plan(request):await replays.create(request));return;}
    if(action==='status'){const job=replays.get(subject);if(!job)throw new Error('REPLAY_JOB_NOT_FOUND');write(job);return;}
    if(action==='start'||action==='pause'||action==='resume'||action==='cancel'){write(await replays.transition(subject,action));return;}
    if(action!=='run')throw new Error('REPLAY_CLI_ACTION_INVALID');
    if(!options['--targets']||!options['--live-targets'])throw new Error('REPLAY_TARGET_FILES_REQUIRED');
    let job=replays.get(subject);if(!job)throw new Error('REPLAY_JOB_NOT_FOUND');if(job.status==='completed'){write(job);return;}
    const targets=await loadProjectionTargets(options['--targets']),liveTargets=await loadProjectionTargets(options['--live-targets']);
    const executor=await createReplayExecutor({wal,job,targets,liveTargets});
    if(job.status==='planned')job=await replays.transition(job.id,'start');else if(job.status==='paused'||job.status==='failed')job=await replays.transition(job.id,'resume');
    const limit=Number(options['--batch-size']??200);if(!Number.isSafeInteger(limit)||limit<1||limit>10000)throw new Error('REPLAY_BATCH_LIMIT_INVALID');
    while(job.status==='running')job=await replays.runBatch(job.id,executor,limit);
    write(job);if(job.status==='failed')throw new Error(`REPLAY_FAILED:${job.errorCode??'unknown'}`);
  }finally{await wal.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){replayCli(process.argv.slice(2)).catch(error=>{console.error(JSON.stringify({error:error instanceof Error?error.message:'REPLAY_FAILED'}));process.exitCode=1;});}
