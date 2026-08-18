import {ClickHouseClient} from '../telemetry-processor/src/packages/exporters/clickhouse.js';
import {compareSdarShadowParity} from '../telemetry-processor/src/packages/projection/sdar-shadow-parity.js';

const runId=process.env.SMPP_E2E_RUN_ID;
if(!runId)throw new Error('SMPP_E2E_RUN_ID_REQUIRED');
const projectId=`smpp-s8-${runId.slice('codex-smpp-s8-'.length).toLowerCase()}`;
const smppSourceId=`smpp.codex.s8.${runId.slice('codex-smpp-s8-'.length).toLowerCase()}`;
const standalone=new ClickHouseClient({url:process.env.SMPP_E2E_STANDALONE_URL??'http://127.0.0.1:18125',user:'default',password:process.env.SMPP_E2E_STANDALONE_PASSWORD??'codex-e2e-local-only-20260818'});
const sdar=new ClickHouseClient({url:process.env.CLICKHOUSE_URL,user:process.env.CLICKHOUSE_USER,password:process.env.CLICKHOUSE_PASSWORD});
await standalone.initialize();await sdar.initialize();
const scope=`tenant_id='codex-integration' AND project_id='${projectId}'`;
const sourceScope=`${scope} AND smpp_source_id='${smppSourceId}'`;
const standaloneFacts=await rows(standalone,`SELECT toString(fact_id) AS fact_id,fact_hash,fact_type,toString(normalized_at) AS projected_at FROM telemetry_normalized.canonical_fact_v1 FINAL WHERE ${scope} ORDER BY fact_id FORMAT JSON`);
const sdarFacts=await rows(sdar,`SELECT toString(fact_id) AS fact_id,fact_hash,fact_type,toString(projected_at) AS projected_at,source_schema_version,projection_id,projection_version FROM sdar_core.external_provider_fact FINAL WHERE ${sourceScope} ORDER BY fact_id FORMAT JSON`);
const standaloneRelations=await rows(standalone,`SELECT toString(relation_id) AS relation_id,arrayMap(value -> toString(value),evidence_fact_ids) AS evidence_fact_ids FROM telemetry_core.entity_relation_fact FINAL WHERE ${scope} ORDER BY relation_id FORMAT JSON`);
const sdarRelations=await rows(sdar,`SELECT toString(relation_id) AS relation_id,arrayMap(value -> toString(value),evidence_fact_ids) AS evidence_fact_ids,projection_id,projection_version FROM sdar_core.external_entity_relation_fact FINAL WHERE ${sourceScope} ORDER BY relation_id FORMAT JSON`);
const parity=compareSdarShadowParity({
  standaloneFacts:standaloneFacts.map((row)=>({factId:row.fact_id,factHash:row.fact_hash,projectedAt:row.projected_at})),
  sdarFacts:sdarFacts.map((row)=>({factId:row.fact_id,factHash:row.fact_hash,projectedAt:row.projected_at})),
  relations:sdarRelations.map((row)=>({evidenceFactIds:row.evidence_fact_ids})),
  expectedRelationFactIds:[...new Set(standaloneRelations.flatMap((row)=>row.evidence_fact_ids))],
  maxWatermarkLagMs:5000,minimumRelationCoverage:1
});
const recordTypes=[...new Set(sdarFacts.map((row)=>row.fact_type))].sort();
const checks={
  sixteenRecordTypes:standaloneFacts.length>=16&&sdarFacts.length>=16&&recordTypes.length===16,
  countParity:parity.checks.countParity,
  factHashParity:parity.checks.factHashParity,
  watermarkParity:parity.checks.watermarkParity,
  relationCoverage:parity.checks.relationCoverage,
  relationIdentityParity:standaloneRelations.length>=48&&standaloneRelations.length===sdarRelations.length&&JSON.stringify(standaloneRelations.map((row)=>row.relation_id))===JSON.stringify(sdarRelations.map((row)=>row.relation_id)),
  sourceRelease:sdarFacts.every((row)=>row.source_schema_version==='1.1.0'),
  projectionIdentity:sdarFacts.every((row)=>row.projection_id==='smpp_provider_ops_to_sdar_core'&&Number(row.projection_version)===1)&&sdarRelations.every((row)=>row.projection_id==='smpp_relations_to_sdar_core'&&Number(row.projection_version)===1)
};
if(!Object.values(checks).every(Boolean))throw Object.assign(new Error('SMPP_E2E_PARITY_FAILED'),{details:{checks,parity,standaloneRelationCount:standaloneRelations.length,sdarRelationCount:sdarRelations.length}});
console.log(JSON.stringify({event:'smpp_providerops.e2e_parity',status:'passed',runId,projectId,smppSourceId,checks,recordTypes,standaloneFactCount:standaloneFacts.length,sdarFactCount:sdarFacts.length,standaloneRelationCount:standaloneRelations.length,sdarRelationCount:sdarRelations.length,watermarkLagMs:parity.watermarkLagMs,maxWatermarkLagMs:5000,relationCoverage:parity.relationCoverage}));

async function rows(client,sql){const result=JSON.parse(await client.query(sql));if(!Array.isArray(result.data))throw new Error('SMPP_E2E_QUERY_INVALID');return result.data;}
