import { createHash } from 'node:crypto';
import { WalStore, type WalEntry, type WalPin } from '../wal/wal.js';
import type { StateOperation } from '../durable-state/types.js';
import { outputPlanKey, type OutputPlan, type ProjectionDeadLetter } from '../exporters/output-plan.js';

export interface ReplayScope { tenantId?:string;projectId?:string;environment?:string;deploymentId?:string;smppSourceId?:string }
export interface ReplayRequest {
  idempotencyKey:string;
  generation:string;
  targetIds:string[];
  targetMappings?:Record<string,string>;
  fromSequence:number;
  throughSequence:number;
  scope?:ReplayScope;
  normalizerVersion:number;
  projectionVersion:number;
  mappingVersion:number;
  policyVersion:number;
}
export interface ReplayPlan {
  walEpoch:string;
  request:ReplayRequest;
  manifestHash:string;
  scanned:number;
  selected:number;
  invalidInputs:number;
  firstSequence:number|null;
  lastSequence:number|null;
}
export type ReplayStatus='planned'|'running'|'paused'|'completed'|'failed'|'cancelled';
export interface ReplayJob {
  id:string;status:ReplayStatus;plan:ReplayPlan;afterSequence:number;
  processed:number;projected:number;quarantined:number;notRouted:number;
  createdAt:string;updatedAt:string;errorCode:string|null;
}
export interface ReplayExecutor {
  /** Revalidate source hash, retained mapping and version contract before projecting. */
  validate(entry:WalEntry,job:ReplayJob):Promise<void>;
  /** Use a generation-isolated target and stable output plan; never call collect or rewind live checkpoints. */
  project(entry:WalEntry,job:ReplayJob):Promise<'projected'|'quarantined'|'not-routed'>;
}
interface ReplayTargetContract {manifestHash:string;generation:string;targets:ReplayTargetDescription[];liveTargets:ReplayTargetDescription[]}
interface ReplayTargetDescription {targetId:string;targetType:string;generation:string;routeIds:string[];acceptAllMappings:boolean;writeLayers:string[]}
interface ReplayOutputEvidence {targetId:string;generation:string;walEpoch:string;ingestSequence:number;planKey:string;revisionKeys:string[];publication:'snapshot_published'|'insert_confirmed';verifiedAt:string}
export interface DeadLetterReplayResolution {kind:'isolated_generation_replay';replayJobId:string;reason:string;sourceTargetId:string;sourceGeneration:string;replacementTargetId:string;replacementGeneration:string;publicationEvidence:ReplayOutputEvidence;resolvedAt:string;originalTargetDisposition:'quarantined'}
function object(value:unknown):Record<string,unknown>{return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};}
function stable(value:unknown):string{
  if(Array.isArray(value))return`[${value.map(stable).join(',')}]`;
  if(value!==null&&typeof value==='object')return`{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>`${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  const encoded=JSON.stringify(value);if(encoded===undefined)throw new Error('REPLAY_REQUEST_INVALID');return encoded;
}
function matches(entry:WalEntry,scope:ReplayScope={}):boolean{
  if(!['accepted','conflict','rejected'].includes(String(entry.record.kind)))return false;
  const mapping=object(entry.record.mapping),trusted=object(entry.record.trustedContext);
  const fields={tenantId:mapping.tenantId,projectId:mapping.projectId,environment:mapping.environment,smppSourceId:mapping.smppSourceId,deploymentId:trusted.deploymentId};
  return Object.entries(scope).every(([key,value])=>fields[key as keyof typeof fields]===value);
}
function validateRequest(wal:WalStore,input:ReplayRequest):ReplayRequest{
  const request=structuredClone(input);
  if(!request.idempotencyKey||request.idempotencyKey.length>512||!request.generation||!/^[-a-zA-Z0-9_.]{1,128}$/u.test(request.generation)||request.generation==='legacy')throw new Error('REPLAY_REQUEST_INVALID');
  if(!Array.isArray(request.targetIds)||!request.targetIds.length||request.targetIds.some(id=>typeof id!=='string'||!id)||new Set(request.targetIds).size!==request.targetIds.length)throw new Error('REPLAY_TARGETS_INVALID');
  request.targetIds.sort();
  for(const[source,destination]of Object.entries(request.targetMappings??{}))if(!source||typeof destination!=='string'||!request.targetIds.includes(destination))throw new Error('REPLAY_TARGET_MAPPING_INVALID');
  if(!Number.isSafeInteger(request.fromSequence)||!Number.isSafeInteger(request.throughSequence)||request.fromSequence<1||request.throughSequence<request.fromSequence||request.throughSequence>wal.state.lastSequence())throw new Error('REPLAY_RANGE_INVALID');
  for(const value of[request.normalizerVersion,request.projectionVersion,request.mappingVersion,request.policyVersion])if(!Number.isSafeInteger(value)||value<1)throw new Error('REPLAY_VERSION_INVALID');
  for(const[key,value]of Object.entries(request.scope??{}))if(!['tenantId','projectId','environment','deploymentId','smppSourceId'].includes(key)||typeof value!=='string'||!value)throw new Error('REPLAY_SCOPE_INVALID');
  return request;
}
const activeJobs=new WeakMap<WalStore,Set<string>>();

/** Durable job and source pin lifecycle. HTTP and physical projection adapters are injected by the application. */
export class ReplayManager {
  private readonly running:Set<string>;
  constructor(readonly wal:WalStore){let running=activeJobs.get(wal);if(!running){running=new Set();activeJobs.set(wal,running);}this.running=running;}
  plan(input:ReplayRequest):ReplayPlan{
    const request=validateRequest(this.wal,input),hash=createHash('sha256');hash.update(stable({walEpoch:this.wal.walEpoch,request}));
    let after=request.fromSequence-1,scanned=0,selected=0,invalidInputs=0,firstSequence:number|null=null,lastSequence:number|null=null;
    for(;;){const entries=this.wal.readEntries(after,200,request.throughSequence);if(!entries.length)break;
      for(const entry of entries){
        scanned++;hash.update(stable({sequence:entry.ingestSequence,record:entry.record}));after=entry.ingestSequence;
        if(!matches(entry,request.scope))continue;selected++;firstSequence??=entry.ingestSequence;lastSequence=entry.ingestSequence;
        const envelope=object(entry.record.envelope);
        if(!Object.keys(object(entry.record.trustedContext)).length||(entry.record.kind!=='rejected'&&(typeof envelope.recordId!=='string'||typeof envelope.recordHash!=='string'||!Object.keys(object(entry.record.mapping)).length)))invalidInputs++;
      }
    }
    if(scanned!==request.throughSequence-request.fromSequence+1)throw new Error('REPLAY_INPUT_COVERAGE_GAP');
    return{walEpoch:this.wal.walEpoch,request,manifestHash:hash.digest('hex'),scanned,selected,invalidInputs,firstSequence,lastSequence};
  }
  get(id:string):ReplayJob|undefined{return this.wal.state.get<ReplayJob>('replay_job',id);}
  list({after,limit=100}:{after?:string;limit?:number}={}):ReplayJob[]{return this.wal.state.scan<ReplayJob>('replay_job',{...(after===undefined?{}:{after}),limit}).map(item=>item.value);}
  async resolveDeadLetter(id:string,{replayJobId,reason}:{replayJobId:string;reason:string}):Promise<ProjectionDeadLetter&{resolution:DeadLetterReplayResolution}>{
    if(!reason.trim()||reason.length>1024)throw new Error('DLQ_RESOLUTION_REASON_REQUIRED');
    const issue=this.wal.state.get<ProjectionDeadLetter&{resolution?:DeadLetterReplayResolution}>('dlq',id);if(!issue)throw new Error('DLQ_NOT_FOUND');
    if(issue.status==='resolved'){if(issue.resolution?.replayJobId===replayJobId)return issue as ProjectionDeadLetter&{resolution:DeadLetterReplayResolution};throw new Error('DLQ_RESOLUTION_CONFLICT');}
    const job=this.get(replayJobId);if(!job||job.status!=='completed')throw new Error('DLQ_REPLAY_NOT_COMPLETED');
    if(issue.walEpoch!==job.plan.walEpoch||issue.ingestSequence<job.plan.request.fromSequence||issue.ingestSequence>job.plan.request.throughSequence)throw new Error('DLQ_REPLAY_SOURCE_NOT_COVERED');
    const entry=this.wal.readEntries(issue.ingestSequence-1,1,issue.ingestSequence)[0];
    if(!entry||!matches(entry,job.plan.request.scope))throw new Error('DLQ_REPLAY_SCOPE_NOT_COVERED');
    const envelope=object(entry.record.envelope);if(envelope.recordId!==issue.sourceRecordId||envelope.recordHash!==issue.sourceRecordHash)throw new Error('DLQ_REPLAY_SOURCE_IDENTITY_MISMATCH');
    const contract=this.wal.state.get<ReplayTargetContract>('replay:contracts',job.id);if(!contract||contract.manifestHash!==job.plan.manifestHash)throw new Error('DLQ_REPLAY_TARGET_CONTRACT_REQUIRED');
    const original=contract.liveTargets.find(target=>target.targetId===issue.targetId);if(!original)throw new Error('DLQ_REPLAY_TARGET_MAPPING_REQUIRED');
    const explicit=job.plan.request.targetMappings?.[issue.targetId];
    const candidates=contract.targets.filter(target=>(!explicit||target.targetId===explicit)&&target.targetType===original.targetType&&original.writeLayers.every(layer=>target.writeLayers.includes(layer))&&(target.acceptAllMappings||(!original.acceptAllMappings&&original.routeIds.every(route=>target.routeIds.includes(route)))));
    if(candidates.length!==1)throw new Error('DLQ_REPLAY_TARGET_MAPPING_AMBIGUOUS');const replacement=candidates[0]!;
    const key=outputPlanKey(replacement.targetId,job.plan.request.generation,entry),plan=this.wal.state.get<OutputPlan>('plan',key),evidence=this.wal.state.get<ReplayOutputEvidence>('replay:output-evidence',`${job.id}/${replacement.targetId}/${entry.ingestSequence}`);
    if(!plan||plan.disposition!=='projected'||!plan.outputs.length||plan.completedOutputs!==plan.outputs.length||!evidence||evidence.planKey!==key||JSON.stringify(evidence.revisionKeys)!==JSON.stringify(plan.outputs.map(output=>output.revisionKey)))throw new Error('DLQ_REPLAY_PUBLICATION_EVIDENCE_REQUIRED');
    if(evidence.publication==='snapshot_published'&&this.wal.state.get('snapshot:done',key)!==true)throw new Error('DLQ_REPLAY_PUBLICATION_EVIDENCE_REQUIRED');
    const resolvedAt=new Date().toISOString(),resolution:DeadLetterReplayResolution={kind:'isolated_generation_replay',replayJobId,reason,sourceTargetId:issue.targetId,sourceGeneration:issue.generation,replacementTargetId:replacement.targetId,replacementGeneration:job.plan.request.generation,publicationEvidence:evidence,resolvedAt,originalTargetDisposition:'quarantined'};
    const resolved={...issue,status:'resolved' as const,resolvedAt,resolution};
    await this.wal.state.transaction([{type:'check',namespace:'dlq',key:id,expected:issue},{type:'put',namespace:'dlq',key:id,value:resolved},{type:'put',namespace:'dlq:resolution',key:id,value:resolution},{type:'put',namespace:'outbox:dlq',key:id,value:resolved},{type:'delete',namespace:'pin',key:`dlq:${id}`},{type:'increment',namespace:'wal',key:'protectionRevision'}]);return resolved;
  }
  async create(input:ReplayRequest):Promise<ReplayJob>{
    const request=validateRequest(this.wal,input),id=createHash('sha256').update(`${this.wal.walEpoch}\u001f${request.idempotencyKey}`).digest('hex');
    const prior=this.get(id);if(prior){if(stable(prior.plan.request)!==stable(request))throw new Error('REPLAY_IDEMPOTENCY_CONFLICT');return prior;}
    const protection=this.wal.state.get<number>('wal','protectionRevision')??null,plan=this.plan(request);if(plan.invalidInputs)throw new Error('REPLAY_INPUT_CONTRACT_INVALID');
    if(this.wal.state.segments().some(segment=>segment.gcState==='planned'&&segment.firstSequence<=request.throughSequence&&segment.lastSequence>=request.fromSequence))throw new Error('WAL_GC_IN_PROGRESS');
    const now=new Date().toISOString(),job:ReplayJob={id,status:'planned',plan,afterSequence:request.fromSequence-1,processed:0,projected:0,quarantined:0,notRouted:0,createdAt:now,updatedAt:now,errorCode:null};
    const pin:WalPin={id:`replay:${id}`,owner:id,kind:'replay',fromSequence:request.fromSequence,throughSequence:request.throughSequence};
    await this.wal.state.transaction([{type:'check',namespace:'replay_job',key:id,expected:null},{type:'check',namespace:'wal',key:'protectionRevision',expected:protection},{type:'put',namespace:'replay_job',key:id,value:job},{type:'put',namespace:'pin',key:pin.id,value:pin},{type:'increment',namespace:'wal',key:'protectionRevision'}]);return job;
  }
  async transition(id:string,action:'start'|'pause'|'resume'|'cancel'):Promise<ReplayJob>{
    const current=this.get(id);if(!current)throw new Error('REPLAY_JOB_NOT_FOUND');
    const desired:ReplayStatus=action==='cancel'?'cancelled':action==='pause'?'paused':'running';if(current.status===desired)return current;
    const allowed:Record<typeof action,ReplayStatus[]>={start:['planned'],pause:['running'],resume:['paused','failed'],cancel:['planned','running','paused','failed']};if(!allowed[action].includes(current.status))throw new Error('REPLAY_TRANSITION_INVALID');
    if(action==='start'||action==='resume'){const plan=this.plan(current.plan.request);if(plan.manifestHash!==current.plan.manifestHash)throw new Error('REPLAY_SOURCE_MANIFEST_CHANGED');}
    const next={...current,status:desired,updatedAt:new Date().toISOString(),errorCode:null};const operations:StateOperation[]=[{type:'check',namespace:'replay_job',key:id,expected:current},{type:'put',namespace:'replay_job',key:id,value:next}];
    if(desired==='cancelled')operations.push({type:'delete',namespace:'pin',key:`replay:${id}`},{type:'increment',namespace:'wal',key:'protectionRevision'});
    await this.wal.state.transaction(operations);return next;
  }
  async runBatch(id:string,executor:ReplayExecutor,limit=200):Promise<ReplayJob>{
    if(!Number.isSafeInteger(limit)||limit<1||limit>10000)throw new Error('REPLAY_BATCH_LIMIT_INVALID');if(this.running.has(id))throw new Error('REPLAY_JOB_ALREADY_RUNNING');
    this.running.add(id);
    try{
      let job=this.get(id);if(!job)throw new Error('REPLAY_JOB_NOT_FOUND');if(job.status!=='running')return job;
      const entries=this.wal.readEntries(job.afterSequence,limit,job.plan.request.throughSequence);
      for(const entry of entries){
        job=this.get(id)!;if(job.status!=='running')return job;
        let disposition:'projected'|'quarantined'|'not-routed'='not-routed';
        try{if(matches(entry,job.plan.request.scope)){await executor.validate(entry,job);disposition=await executor.project(entry,job);}}
        catch(error){const current=this.get(id)!;if(current.status==='cancelled')return current;const failed:ReplayJob={...current,status:'failed',updatedAt:new Date().toISOString(),errorCode:error instanceof Error?error.message:'REPLAY_EXECUTION_FAILED'};await this.wal.state.transaction([{type:'check',namespace:'replay_job',key:id,expected:current},{type:'put',namespace:'replay_job',key:id,value:failed}]);return failed;}
        const current=this.get(id)!;if(current.status==='cancelled')return current;
        const next:ReplayJob={...current,afterSequence:entry.ingestSequence,processed:current.processed+1,projected:current.projected+(disposition==='projected'?1:0),quarantined:current.quarantined+(disposition==='quarantined'?1:0),notRouted:current.notRouted+(disposition==='not-routed'?1:0),updatedAt:new Date().toISOString()};
        if(entry.ingestSequence===job.plan.request.throughSequence&&next.status==='running')next.status='completed';
        const operations:StateOperation[]=[{type:'check',namespace:'replay_job',key:id,expected:current},{type:'put',namespace:'replay_job',key:id,value:next}];if(next.status==='completed')operations.push({type:'delete',namespace:'pin',key:`replay:${id}`},{type:'increment',namespace:'wal',key:'protectionRevision'});
        await this.wal.state.transaction(operations);job=next;
      }
      return this.get(id)!;
    }finally{this.running.delete(id);}
  }
}
