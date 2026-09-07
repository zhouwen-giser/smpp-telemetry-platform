import http, {type IncomingMessage,type ServerResponse} from 'node:http';
import https from 'node:https';
import {gunzipSync} from 'node:zlib';
import {decodeOtlpJson} from '../packages/otlp/otlp-json.js';
import {decodeOtlpProtobuf} from '../packages/otlp/otlp-protobuf.js';
import {isRecord,type OtlpLogRecord,type CollectResult} from '../../../packages/telemetry-types/src/index.js';
import type {WalStore} from '../packages/wal/wal.js';
import type {Metrics} from '../packages/metrics/metrics.js';
import type {TargetManager} from '../packages/exporters/target-manager.js';
import {ReplayManager,type ReplayRequest,type ReplayExecutor,type ReplayJob} from '../packages/replay/replay.js';

async function readBody(req:IncomingMessage,maxBytes:number):Promise<Buffer>{
  const chunks:Buffer[]=[];let size=0;
  for await(const value of req){const chunk=Buffer.isBuffer(value)?value:Buffer.from(String(value));size+=chunk.length;if(size>maxBytes)throw Object.assign(new Error('REQUEST_TOO_LARGE'),{statusCode:413});chunks.push(chunk);}
  const body=Buffer.concat(chunks);
  return req.headers['content-encoding']==='gzip'?gunzipSync(body,{maxOutputLength:maxBytes}):body;
}
function json(res:ServerResponse,status:number,value:unknown){const body=Buffer.from(JSON.stringify(value));res.writeHead(status,{'content-type':'application/json','content-length':body.length});res.end(body);}
function authorized(req:IncomingMessage,key:string){return !key||req.headers.authorization===`Bearer ${key}`;}
interface ServerOptions {
  config:{maxRequestBytes:number;walMaxBytes:number;adminApiKey:string};
  tlsOptions:https.ServerOptions|null;
  processor:{collect(record:OtlpLogRecord):Promise<CollectResult>};
  wal:WalStore;targets:Pick<TargetManager,'pingRequired'|'statuses'|'flush'>;metrics:Metrics;
  replayExecutor?:(job:ReplayJob)=>Promise<ReplayExecutor>;
}
export function createServer({config,tlsOptions,processor,wal,targets,metrics,replayExecutor}:ServerOptions){
  const replays=new ReplayManager(wal);
  const ready=async()=>{
    let required=true;try{await targets.pingRequired();}catch{required=false;}
    const walStats=wal.stats(),high=walStats.totalBytes>=config.walMaxBytes*0.85;
    const ready=required&&!high&&!walStats.diskReserveRequired&&!walStats.writeFailed&&walStats.pendingWrites<walStats.maxPendingWrites;
    metrics.set('processor_ready',ready?1:0);
    return {ready,required,walStats};
  };
  const handler=async(req:IncomingMessage,res:ServerResponse)=>{
    try{
      const url=new URL(req.url??'/','http://internal');
      if(req.method==='GET'&&url.pathname==='/health/live')return json(res,200,{status:'live'});
      if(req.method==='GET'&&url.pathname==='/health/ready'){
        const result=await ready();return json(res,result.ready?200:503,{status:result.ready?'ready':'degraded',requiredTargets:result.required,wal:result.walStats,targets:targets.statuses()});
      }
      if(req.method==='GET'&&url.pathname==='/metrics'){
        const {walStats}=await ready();
        metrics.set('processor_wal_bytes',walStats.totalBytes);metrics.set('processor_wal_max_bytes',config.walMaxBytes);
        if(walStats.walFreeBytes!==null)metrics.set('processor_disk_free_bytes',walStats.walFreeBytes);metrics.set('processor_disk_reserve_bytes',walStats.minFreeBytes);
        metrics.set('processor_state_bytes',walStats.stateBytes);metrics.set('processor_dlq_bytes',walStats.dlqBytes);metrics.set('processor_archive_bytes',walStats.archiveBytes);
        metrics.set('processor_wal_write_queue_depth',walStats.pendingWrites);metrics.set('processor_wal_write_failed',walStats.writeFailed?1:0);
        for(const status of targets.statuses()){
          const labels={target:status.targetId};
          metrics.set('projection_target_pending',status.pending,labels);
          metrics.set('projection_target_publication_pending',status.publicationPending,labels);
          metrics.set('projection_target_oldest_pending_age_ms',status.oldestPendingAgeMs,labels);
          metrics.set('projection_target_quarantined',status.quarantined,labels);
          metrics.set('projection_target_error',status.lastError?1:0,labels);
        }
        res.writeHead(200,{'content-type':'text/plain; version=0.0.4'});return res.end(metrics.render());
      }
      if(url.pathname.startsWith('/debug/')||url.pathname.startsWith('/admin/')){
        if(!authorized(req,config.adminApiKey))return json(res,401,{error:'UNAUTHORIZED'});
        if(req.method==='GET'&&url.pathname==='/debug/wal')return json(res,200,wal.stats());
        if(req.method==='GET'&&url.pathname==='/debug/checkpoints')return json(res,200,wal.stats().checkpoints);
        if(req.method==='GET'&&url.pathname==='/debug/targets')return json(res,200,targets.statuses());
        if(req.method==='GET'&&url.pathname==='/debug/dlq')return json(res,200,{items:wal.state.scan('dlq',{limit:100,...(url.searchParams.has('after')?{after:url.searchParams.get('after')!}:{})})});
        if(req.method==='POST'&&url.pathname==='/admin/flush'){await targets.flush();return json(res,200,{targets:targets.statuses()});}
        // New state-changing maintenance routes require a configured administrator credential.
        if(url.pathname.startsWith('/admin/')&&!config.adminApiKey)return json(res,401,{error:'ADMIN_KEY_REQUIRED'});
        if(req.method==='POST'&&url.pathname==='/admin/wal/audit-archives')return json(res,200,await wal.auditArchives());
        if(req.method==='POST'&&url.pathname==='/admin/wal/archive')return json(res,200,{segments:await wal.archiveClosedSegments()});
        if(req.method==='POST'&&url.pathname==='/admin/wal/compact')return json(res,200,await wal.compact({dryRun:url.searchParams.get('apply')!=='true'}));
        if(req.method==='GET'&&url.pathname==='/admin/replays')return json(res,200,{items:replays.list({limit:100,...(url.searchParams.has('after')?{after:url.searchParams.get('after')!}:{})})});
        if(req.method==='POST'&&['/admin/replays','/admin/replays/plan'].includes(url.pathname)){
          const input:unknown=JSON.parse((await readBody(req,config.maxRequestBytes)).toString('utf8'));
          if(!isRecord(input))return json(res,400,{error:'REPLAY_REQUEST_INVALID'});
          const request=input as unknown as ReplayRequest;
          return json(res,200,url.pathname.endsWith('/plan')?replays.plan(request):await replays.create(request));
        }
        const dlqPath=/^\/admin\/dlq\/([a-f0-9-]{36})\/resolve$/.exec(url.pathname);
        if(req.method==='POST'&&dlqPath){
          const body:unknown=JSON.parse((await readBody(req,config.maxRequestBytes)).toString('utf8'));
          if(!isRecord(body)||typeof body.replayJobId!=='string'||typeof body.reason!=='string')return json(res,400,{error:'DLQ_RESOLUTION_INVALID'});
          return json(res,200,await replays.resolveDeadLetter(dlqPath[1]!,{replayJobId:body.replayJobId,reason:body.reason}));
        }
        const replayPath=/^\/admin\/replays\/([a-f0-9]{64})(?:\/(start|pause|resume|cancel|run))?$/.exec(url.pathname);
        if(replayPath){
          const id=replayPath[1]!,job=replays.get(id);if(!job)return json(res,404,{error:'REPLAY_JOB_NOT_FOUND'});
          if(req.method==='GET'&&!replayPath[2])return json(res,200,job);
          if(req.method==='POST'){
            const action=replayPath[2];
            if(action==='run'){
              if(!replayExecutor)return json(res,503,{error:'REPLAY_TARGET_CONFIGURATION_REQUIRED'});
              return json(res,200,await replays.runBatch(id,await replayExecutor(job)));
            }
            if(action==='start'||action==='pause'||action==='resume'||action==='cancel')return json(res,200,await replays.transition(id,action));
          }
        }
      }
      if(req.method==='POST'&&url.pathname==='/internal/otlp/v1/logs'){
        const body=await readBody(req,config.maxRequestBytes),type=String(req.headers['content-type']??'').split(';')[0];
        let records:OtlpLogRecord[],protobuf=false;
        if(type==='application/x-protobuf'||type==='application/protobuf'){records=decodeOtlpProtobuf(body);protobuf=true;}
        else if(type==='application/json')records=decodeOtlpJson(JSON.parse(body.toString('utf8')));
        else return json(res,415,{error:'UNSUPPORTED_CONTENT_TYPE'});
        if(!records.length)return json(res,400,{error:'NO_LOG_RECORDS'});
        const results:CollectResult[]=[];for(const record of records)results.push(await processor.collect(record));
        if(results.some(r=>r.status==='rejected_retryable'))return json(res,503,{results});
        if(results.some(r=>r.status==='conflict'))return json(res,409,{results});
        if(results.some(r=>r.status==='rejected_permanent'))return json(res,400,{results});
        if(protobuf){res.writeHead(200,{'content-type':'application/x-protobuf'});return res.end(Buffer.alloc(0));}
        return json(res,200,{accepted:results.length});
      }
      return json(res,404,{error:'NOT_FOUND'});
    }catch(error){
      metrics.inc('processor_http_errors_total');
      const code=error instanceof Error?error.message:'INTERNAL_ERROR';
      const status=isRecord(error)&&typeof error.statusCode==='number'?error.statusCode:(code.startsWith('REPLAY_')||code.startsWith('DLQ_'))?400:500;
      return json(res,status,{error:code});
    }
  };
  return tlsOptions?https.createServer(tlsOptions,handler):http.createServer(handler);
}
