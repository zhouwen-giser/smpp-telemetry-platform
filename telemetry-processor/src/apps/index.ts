import {createReplayExecutor} from '../packages/replay/executor.js';
import {loadConfig,loadTls} from '../packages/config/config.js';
import {WalStore} from '../packages/wal/wal.js';
import {SourceMappings} from '../packages/source-mapping/source-mapping.js';
import {Metrics} from '../packages/metrics/metrics.js';
import {loadProjectionTargets,TargetManager} from '../packages/exporters/target-manager.js';
import {TelemetryProcessor} from './processor.js';
import {createServer} from './server.js';

const config=await loadConfig(),tlsOptions=await loadTls(config.tls),metrics=new Metrics();
const wal=new WalStore({directory:config.walDir,segmentMaxBytes:config.walSegmentMaxBytes,maxPendingWrites:config.walMaxPendingWrites,minFreeBytes:config.walMinFreeBytes,cacheMaxBytes:config.walCacheMaxBytes,gcEnabled:config.walGcEnabled,...(config.walArchiveDir?{archiveDirectory:config.walArchiveDir}:{})});
await wal.initialize();
const mappings=new SourceMappings(config.sourceMappingsFile);await mappings.load();
const targetConfigs=await loadProjectionTargets(config.projectionTargetsFile);
const targets=new TargetManager({targets:targetConfigs,wal,metrics,batchSize:config.exportBatchSize});
await targets.initialize();targets.start(config.exportIntervalMs);
const processor=new TelemetryProcessor({wal,mappings,metrics,requireCollectorId:config.requireCollectorId,allowedCollectorIds:config.allowedCollectorIds,walMaxBytes:config.walMaxBytes,walRejectThreshold:config.walRejectThreshold});
const replayTargets=config.replayTargetsFile?await loadProjectionTargets(config.replayTargetsFile):null;
const server=createServer({config,tlsOptions,processor,wal,targets,metrics,...(replayTargets?{replayExecutor:async(job:import('../packages/replay/replay.js').ReplayJob)=>createReplayExecutor({wal,job,targets:replayTargets,liveTargets:targetConfigs})}:{})});
let maintenanceTask:Promise<unknown>|null=null;
const maintenance=setInterval(()=>{if(maintenanceTask||!config.walGcEnabled)return;maintenanceTask=wal.archiveClosedSegments().then(()=>wal.compact({dryRun:false})).catch(error=>{metrics.inc('processor_wal_maintenance_failures_total');console.error(JSON.stringify({level:'error',message:'wal_maintenance_failed',code:error instanceof Error?error.message:'UNKNOWN'}));}).finally(()=>{maintenanceTask=null;});},config.walMaintenanceIntervalMs);maintenance.unref();
server.listen(config.port,config.host,()=>console.log(JSON.stringify({level:'info',message:'telemetry_processor_started',host:config.host,port:config.port,targets:targets.statuses().map(x=>x.targetId)})));

let shuttingDown=false;
async function shutdown(){
  if(shuttingDown)return;
  shuttingDown=true;
  clearInterval(maintenance);
  targets.pause();
  const deadline=Date.now()+config.shutdownTimeoutMs;
  let timer;
  const timeout=new Promise((_,reject)=>{
    timer=setTimeout(()=>{
      server.closeAllConnections?.();
      reject(new Error('PROCESSOR_SHUTDOWN_TIMEOUT'));
    },config.shutdownTimeoutMs);
  });
  const drain=(async()=>{
    await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    await wal.drain();
    await targets.stop(Math.max(1,deadline-Date.now()));
    await maintenanceTask;
    await wal.close();
  })();
  try{await Promise.race([drain,timeout]);process.exit(0);}
  catch(error){console.error(JSON.stringify({level:'error',message:'telemetry_processor_shutdown_failed',code:error instanceof Error?error.message:'UNKNOWN'}));process.exit(1);}
  finally{clearTimeout(timer);}
}
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>void shutdown());
