import {canonicalizeJson} from '../canonical/canonical.js';
import {extractProviderOpsSemantics} from './provider-ops-payload-catalog.js';

export const SDAR_PROVIDER_PROJECTION_ID='smpp_provider_ops_to_sdar_core';
export const SDAR_RELATION_PROJECTION_ID='smpp_relations_to_sdar_core';
export const SDAR_PROJECTION_VERSION=1;

export const SDAR_TARGET_SCHEMAS=Object.freeze({
  'sdar_core.external_provider_fact':Object.freeze([
    ['tenant_id','String'],['project_id','String'],['environment','LowCardinality(String)'],
    ['smpp_source_id','String'],['source_deployment_id','String'],['source_runtime_instance_id','String'],
    ['fact_id','UUID'],['fact_hash','FixedString(64)'],['fact_type','LowCardinality(String)'],['fact_version','LowCardinality(String)'],
    ['source_system','LowCardinality(String)'],['source_product','String'],['source_record_id','String'],['source_record_hash','FixedString(64)'],['source_schema_name','LowCardinality(String)'],['source_schema_version','LowCardinality(String)'],
    ['provider_id','String'],['provider_instance_id','String'],['resource_id','String'],['external_task_id','String'],['external_execution_id','String'],['external_command_id','String'],['operation_name','String'],
    ['lifecycle_status','LowCardinality(String)'],['provider_substate','LowCardinality(String)'],['reason_code','String'],['runtime_revision','String'],['provider_revision','String'],['progress_percent','Nullable(Float64)'],
    ['correlation_id','String'],['causation_record_id','String'],['trace_id','String'],['span_id','String'],
    ['origin_sdar_runtime_ids','Array(String)'],['origin_sdar_task_ids','Array(String)'],['origin_sdar_invocation_ids','Array(String)'],
    ['entity_refs_json','String'],['payload_json','String'],['provenance_json','String'],
    ['occurred_at',"DateTime64(3, 'UTC')"],['observed_at',"Nullable(DateTime64(3, 'UTC'))"],['received_at',"DateTime64(3, 'UTC')"],['normalized_at',"DateTime64(3, 'UTC')"],['projected_at',"DateTime64(3, 'UTC')"],
    ['normalizer_id','LowCardinality(String)'],['normalizer_version','UInt32'],['mapping_version','UInt32'],['policy_version','UInt32'],['projection_id','LowCardinality(String)'],['projection_version','UInt32']
  ]),
  'sdar_core.external_entity_relation_fact':Object.freeze([
    ['tenant_id','String'],['project_id','String'],['environment','LowCardinality(String)'],['smpp_source_id','String'],
    ['relation_id','UUID'],['relation_type','LowCardinality(String)'],['relation_version','UInt32'],
    ['source_entity_urn','String'],['source_entity_type','LowCardinality(String)'],['source_entity_id','String'],
    ['target_entity_urn','String'],['target_entity_type','LowCardinality(String)'],['target_entity_id','String'],
    ['source_system','LowCardinality(String)'],['target_system','LowCardinality(String)'],
    ['valid_from',"DateTime64(3, 'UTC')"],['valid_to',"Nullable(DateTime64(3, 'UTC'))"],
    ['correlation_id','String'],['trace_id','String'],['causation_fact_id','Nullable(UUID)'],['route_id','String'],['attempt_no','Nullable(UInt32)'],
    ['evidence_fact_ids','Array(UUID)'],['binding_source','LowCardinality(String)'],['confidence_class','LowCardinality(String)'],
    ['source_record_id','String'],['source_record_hash','String'],['created_at',"DateTime64(3, 'UTC')"],['projected_at',"DateTime64(3, 'UTC')"],
    ['projection_id','LowCardinality(String)'],['projection_version','UInt32']
  ])
});

function requiredString(value,code){if(typeof value!=='string'||value.length===0)throw new Error(code);return value;}
function optionalString(value){return typeof value==='string'?value:'';}
function localId(fact,type){return fact.entityRefs.find((ref)=>ref.entityType===type)?.localId??'';}

export class SmppUrnParserV1{
  parse(value){
    const urn=requiredString(value,'SMPP_RELATION_URN_INVALID');
    const parts=urn.split(':');
    if(parts.length!==7||parts[0]!=='urn'||parts[1]!=='telemetry')throw new Error('SMPP_RELATION_URN_INVALID');
    const decode=(part)=>{try{const value=decodeURIComponent(part);if(value.length===0||encodeURIComponent(value)!==part)throw new Error();return value;}catch{throw new Error('SMPP_RELATION_URN_INVALID');}};
    const tenantId=decode(parts[2]);
    const sourceSystem=requiredString(parts[3],'SMPP_RELATION_URN_INVALID');
    const deploymentId=decode(parts[4]);
    const entityType=requiredString(parts[5],'SMPP_RELATION_URN_INVALID');
    const entityId=decode(parts[6]);
    if(!/^[a-z][a-z0-9_-]{0,63}$/.test(sourceSystem)||!/^[a-z][a-z0-9_-]{0,63}$/.test(entityType))throw new Error('SMPP_RELATION_URN_INVALID');
    return Object.freeze({version:1,urn,tenantId,sourceSystem,deploymentId,entityType,entityId});
  }
}

export class SdarWarehouseSchemaPreflight{
  async assert(client){
    const release=JSON.parse(await client.query("SELECT release_version,migration_range,release_descriptor_hash,schema_contract_hash FROM sdar_meta.v_schema_contract_release_current FORMAT JSON"));
    const row=release.data?.[0];
    if(row?.release_version!=='1.5.1-rc.2'||row?.migration_range!=='00..26'||row?.schema_contract_hash!=='sha256:78da6e9e511b7714b15a4f6ef5f2ba54578880493e2aa264f433ff1595a1d7b8'||row?.release_descriptor_hash!=='sha256:1610cf2a4cc9450193dd70abf7a516f0ea4792099ed0f34dcf2fad44d094b335')throw new Error('SMPP_SCHEMA_DRIFT');
    const names=Object.keys(SDAR_TARGET_SCHEMAS).map((name)=>name.split('.')[1]);
    const columns=JSON.parse(await client.query(`SELECT concat(database,'.',table) AS target,name,type FROM system.columns WHERE database='sdar_core' AND table IN (${names.map((name)=>`'${name}'`).join(',')}) ORDER BY target,position FORMAT JSON`)).data??[];
    for(const [target,expected] of Object.entries(SDAR_TARGET_SCHEMAS)){
      const actual=columns.filter((column)=>column.target===target).map((column)=>[column.name,column.type]);
      if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('SMPP_SCHEMA_DRIFT');
    }
    for(const view of ['v_smpp_provider_task_timeline','v_smpp_resource_current_state','v_smpp_resource_current_health','v_smpp_execution_latest_progress','v_sdar_smpp_task_reconciliation','v_sdar_smpp_execution_topology'])await client.query(`SELECT * FROM sdar_core.${view} LIMIT 0`);
    return true;
  }
}

export class SdarSharedWarehouseProjectionV1{
  constructor({urnParser=new SmppUrnParserV1()}={}){this.urnParser=urnParser;this.projectionId=SDAR_PROVIDER_PROJECTION_ID;this.projectionVersion=SDAR_PROJECTION_VERSION;}
  project(fact){
    const smppSourceId=requiredString(fact.sourceInstance?.smppSourceId,'SMPP_SOURCE_MAPPING_ID_MISSING');
    if(fact.provenance?.mappingVersion!==4)throw new Error('SMPP_SOURCE_MAPPING_ID_MISSING');
    const rawPayload=fact.payload?.payload;
    const semantics=extractProviderOpsSemantics(fact.factType,rawPayload);
    const provider={
      tenant_id:fact.tenantId,project_id:fact.projectId,environment:fact.environment,
      smpp_source_id:smppSourceId,source_deployment_id:fact.sourceInstance.deploymentId,source_runtime_instance_id:fact.sourceInstance.runtimeInstanceId,
      fact_id:fact.factId,fact_hash:fact.factHash,fact_type:fact.factType,fact_version:fact.factVersion,
      source_system:fact.sourceSystem,source_product:fact.sourceProduct,source_record_id:fact.sourceRecordId,source_record_hash:fact.sourceRecordHash,source_schema_name:fact.sourceSchemaName,source_schema_version:fact.sourceSchemaVersion,
      provider_id:localId(fact,'provider'),provider_instance_id:fact.sourceInstance.runtimeInstanceId,resource_id:localId(fact,'resource'),external_task_id:localId(fact,'task'),external_execution_id:localId(fact,'execution'),external_command_id:optionalString(semantics.externalCommandId),operation_name:optionalString(fact.payload?.operationName),
      lifecycle_status:optionalString(semantics.lifecycleStatus),provider_substate:optionalString(semantics.providerSubstate),reason_code:optionalString(semantics.reasonCode),runtime_revision:optionalString(semantics.runtimeRevision)||optionalString(fact.sourceInstance.runtimeVersion),provider_revision:optionalString(semantics.providerRevision)||(fact.payload?.observationRevision==null?'':String(fact.payload.observationRevision)),progress_percent:typeof semantics.progressPercent==='number'?semantics.progressPercent:null,
      correlation_id:optionalString(fact.correlation?.correlationId),causation_record_id:optionalString(fact.correlation?.causationRecordId),trace_id:optionalString(fact.correlation?.traceId),span_id:optionalString(fact.correlation?.spanId),
      origin_sdar_runtime_ids:fact.correlation?.originSystem==='sdar'?[...(fact.correlation.originRuntimeInstanceIds??[])]:[],origin_sdar_task_ids:fact.correlation?.originSystem==='sdar'?[...(fact.correlation.originTaskIds??[])]:[],origin_sdar_invocation_ids:fact.correlation?.originSystem==='sdar'?[...(fact.correlation.originInvocationIds??[])]:[],
      entity_refs_json:canonicalizeJson(fact.entityRefs??[]),payload_json:canonicalizeJson(fact.payload),provenance_json:canonicalizeJson({normalizerId:fact.provenance.normalizerId,normalizerVersion:fact.provenance.normalizerVersion,mappingVersion:4,policyVersion:fact.provenance.policyVersion,targetAdapter:'SdarSharedWarehouseProjectionV1',payloadCatalog:'smpp.providerops-payload-catalog/v1.1',terminalStatus:semantics.terminalStatus??null,providerTerminalIsGoalSuccess:false}),
      occurred_at:fact.occurredAt,observed_at:semantics.observedAt??fact.observedAt??fact.occurredAt,received_at:fact.receivedAt,normalized_at:fact.normalizedAt,
      normalizer_id:fact.provenance.normalizerId,normalizer_version:fact.provenance.normalizerVersion,mapping_version:4,policy_version:fact.provenance.policyVersion,projection_id:SDAR_PROVIDER_PROJECTION_ID,projection_version:SDAR_PROJECTION_VERSION
    };
    const rows=[{table:'sdar_core.external_provider_fact',row:provider}];
    for(const relation of fact.relations??[])rows.push({table:'sdar_core.external_entity_relation_fact',row:this.#relation(fact,relation,smppSourceId)});
    return rows;
  }
  #relation(fact,relation,smppSourceId){
    const source=this.urnParser.parse(relation.sourceEntityUrn);const target=this.urnParser.parse(relation.targetEntityUrn);
    return {tenant_id:fact.tenantId,project_id:fact.projectId,environment:fact.environment,smpp_source_id:smppSourceId,relation_id:relation.relationId,relation_type:relation.relationType,relation_version:relation.relationVersion,source_entity_urn:source.urn,source_entity_type:source.entityType,source_entity_id:source.entityId,target_entity_urn:target.urn,target_entity_type:target.entityType,target_entity_id:target.entityId,source_system:relation.sourceSystem,target_system:relation.targetSystem,valid_from:relation.validFrom,valid_to:relation.validTo,correlation_id:optionalString(relation.correlationId),trace_id:optionalString(relation.traceId),causation_fact_id:relation.causationFactId??null,route_id:optionalString(relation.routeId),attempt_no:relation.attemptNo??null,evidence_fact_ids:[...(relation.evidenceFactIds??[])],binding_source:requiredString(relation.bindingSource,'SMPP_RELATION_AMBIGUOUS'),confidence_class:requiredString(relation.confidenceClass,'SMPP_RELATION_AMBIGUOUS'),source_record_id:fact.sourceRecordId,source_record_hash:fact.sourceRecordHash,created_at:relation.createdAt,projection_id:SDAR_RELATION_PROJECTION_ID,projection_version:SDAR_PROJECTION_VERSION};
  }
}
