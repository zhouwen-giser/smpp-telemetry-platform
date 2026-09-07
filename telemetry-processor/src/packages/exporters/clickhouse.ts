import type { AcceptedWalRecord } from '../../../../packages/telemetry-types/src/index.js';
import { normalizeProviderCorrelation } from '../validation/provider-correlation-policy.js';
import { readFile } from 'node:fs/promises';
import { StandaloneSchemaPreflight, standaloneTargetTables, sqlIdentifier, type StandaloneTarget } from './standalone-schema.js';
import type { WalEntry } from '../wal/wal.js';
import type { SmppProviderOpsNormalizerV1 } from '../normalization/smpp-provider-ops-v1.js';
export interface ClickHouseConnection { url: string; user?: string; userEnv?: string; password?: string; passwordFile?: string; passwordEnv?: string; timeoutMs?: number }
export class ClickHouseError extends Error { constructor(readonly status: number, readonly databaseCode: number | null) { super(`CLICKHOUSE_${status}:${databaseCode ?? 'UNKNOWN'}`); } }
async function secret(file: string,fallback=''){if(!file)return fallback;return(await readFile(file,'utf8')).trim();}
export class ClickHouseClient{
  url: string; user: string; userEnv: string; inlinePassword: string; password: string; passwordFile: string; passwordEnv: string; timeoutMs: number;
  constructor({url,user='default',userEnv='',password='',passwordFile='',passwordEnv='',timeoutMs=10000}: ClickHouseConnection){this.timeoutMs=timeoutMs;this.url=url.replace(/\/$/,'');this.user=user;this.userEnv=userEnv;this.inlinePassword=password;this.password=password;this.passwordFile=passwordFile;this.passwordEnv=passwordEnv;}
  async initialize(){
    if(this.userEnv){if(!/^[A-Z][A-Z0-9_]{0,127}$/.test(this.userEnv))throw new Error('CLICKHOUSE_USER_ENV_INVALID');const user=process.env[this.userEnv];if(!user)throw new Error('CLICKHOUSE_USER_ENV_MISSING');this.user=user;}
    const sources=[this.inlinePassword!==''?'inline':'',this.passwordFile!==''?'file':'',this.passwordEnv!==''?'env':''].filter(Boolean);
    if(sources.length>1)throw new Error('CLICKHOUSE_CREDENTIAL_AMBIGUOUS');
    if(this.passwordEnv){if(!/^[A-Z][A-Z0-9_]{0,127}$/.test(this.passwordEnv))throw new Error('CLICKHOUSE_PASSWORD_ENV_INVALID');const value=process.env[this.passwordEnv];if(!value)throw new Error('CLICKHOUSE_PASSWORD_ENV_MISSING');this.password=value;return;}
    this.password=await secret(this.passwordFile,this.inlinePassword);
  }
  #headers(contentType='text/plain'){const h: Record<string,string>={'content-type':contentType};if(this.user)h.authorization=`Basic ${Buffer.from(`${this.user}:${this.password}`).toString('base64')}`;return h;}
  async query(sql: string,body=''): Promise<string>{const response=await fetch(`${this.url}/?query=${encodeURIComponent(sql)}`,{method:'POST',headers:this.#headers(body?'application/x-ndjson':'text/plain'),body,signal:AbortSignal.timeout(this.timeoutMs)});if(!response.ok){const detail=await response.text();const code=/^Code: (\d+)/.exec(detail);throw new ClickHouseError(response.status,code?Number(code[1]):null);}return response.text();}
  async ping(){await this.query('SELECT 1');return true;}
  async preflightWritePermissions(tables:readonly string[]){for(const table of tables){if((await this.query(`CHECK GRANT SELECT, INSERT ON ${sqlIdentifier(table)}`)).trim()!=='1')throw new Error(`TARGET_WRITE_PERMISSION_MISSING:${table}`);}}
  async preflightStandalone(target: StandaloneTarget) { await new StandaloneSchemaPreflight().assert(this,target);await this.preflightWritePermissions(standaloneTargetTables(target)); }
  async insert(table: string,rows: readonly Record<string, unknown>[]){if(!rows.length)return;const body=`${rows.map(r=>JSON.stringify(r)).join('\n')}\n`;await this.query(`INSERT INTO ${table} SETTINGS date_time_input_format='best_effort' FORMAT JSONEachRow`,body);}
}
export function landingRow(entry: WalEntry<AcceptedWalRecord>){
  const {envelope,mapping,receivedAt,trustedContext}=entry.record;
  const correlation=normalizeProviderCorrelation(envelope);
  return {
    tenant_id:mapping.tenantId,project_id:mapping.projectId,environment:mapping.environment,
    mapping_version:mapping.mappingVersion,policy_version:mapping.policyVersion,
    source_system:'smpp',source_product:mapping.sourceProduct,source_record_id:envelope.recordId,
    source_record_hash:envelope.recordHash,source_schema_name:envelope.schemaName,
    source_schema_version:envelope.schemaVersion,record_type:envelope.recordType,
    event_category:envelope.eventCategory,delivery_class:envelope.deliveryClass,
    priority:String(envelope.priority??'P2'),runtime_version:envelope.runtimeVersion,
    runtime_instance_id:envelope.instanceId,deployment_id:trustedContext.deploymentId,
    collector_id:trustedContext.collectorId,provider_id:envelope.providerId,
    provider_instance_id:envelope.instanceId,task_id:envelope.taskId??null,
    resource_id:envelope.resourceId??null,resource_type:envelope.resourceType??null,
    external_execution_id:envelope.externalExecutionId??null,
    operation_name:envelope.operationName??null,provider_event_id:envelope.providerEventId??null,
    provider_event_sequence:envelope.providerEventSequence??null,event_type:envelope.eventType??null,
    execution_mode:envelope.executionMode??null,simulation_id:envelope.simulationId??null,
    adapter_revision:envelope.adapterRevision==null?null:String(envelope.adapterRevision),
    observation_revision:envelope.observationRevision??null,command_sequence:envelope.commandSequence??null,
    correlation_id:correlation.correlationId,
    causation_record_id:correlation.causationRecordId,
    trace_id:correlation.traceId,
    span_id:correlation.spanId,
    occurred_at:envelope.occurredAt,emitted_at:envelope.emittedAt,received_at:receivedAt,
    provider_quality_json:JSON.stringify(entry.record.providerQuality??{status:'legacy_unknown',reasonCodes:[]}),
    ingested_at:new Date().toISOString(),attributes_json:JSON.stringify(envelope.attributes??{}),
    payload_json:JSON.stringify(envelope.payload??null),envelope_json:JSON.stringify(envelope),
    wal_segment:entry.segment,wal_offset:entry.offset,ingest_version:Date.now()
  };
}
export function canonicalRow(fact: ReturnType<SmppProviderOpsNormalizerV1['normalize']>[number]){return {fact_id:fact.factId,fact_hash:fact.factHash,fact_type:fact.factType,fact_version:fact.factVersion,source_system:fact.sourceSystem,source_product:fact.sourceProduct,source_record_id:fact.sourceRecordId,source_record_hash:fact.sourceRecordHash,source_schema_name:fact.sourceSchemaName,source_schema_version:fact.sourceSchemaVersion,tenant_id:fact.tenantId,project_id:fact.projectId,environment:fact.environment,source_instance_urn:fact.sourceInstanceUrn,occurred_at:fact.occurredAt,received_at:fact.receivedAt,normalized_at:fact.normalizedAt,entity_refs_json:JSON.stringify(fact.entityRefs),relations_json:JSON.stringify(fact.relations),correlation_json:JSON.stringify(fact.correlation),payload_json:JSON.stringify(fact.payload),normalizer_id:fact.provenance.normalizerId,normalizer_version:fact.provenance.normalizerVersion,mapping_version:fact.provenance.mappingVersion,policy_version:fact.provenance.policyVersion,provenance_json:JSON.stringify(fact.provenance)};}
