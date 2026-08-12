import http from 'node:http';
import { sqlString } from './clickhouse.js';

function json(res,status,value){const body=Buffer.from(JSON.stringify(value));res.writeHead(status,{'content-type':'application/json','content-length':body.length});res.end(body);}
const decode=(value)=>decodeURIComponent(value);

const EVENT_FILTERS = {
  tenantId:'tenant_id',projectId:'project_id',providerId:'provider_id',resourceId:'resource_id',
  taskId:'task_id',operationName:'operation_name',runtimeInstanceId:'runtime_instance_id',
  deploymentId:'deployment_id',recordId:'source_record_id',traceId:'trace_id',
  externalExecutionId:'external_execution_id',providerEventId:'provider_event_id',
  recordType:'record_type',eventCategory:'event_category',deliveryClass:'delivery_class'
};

function eventSearchSql(searchParams){
  const where=[];
  for(const [parameter,column] of Object.entries(EVENT_FILTERS)){
    const value=searchParams.get(parameter);
    if(value===null)continue;
    if(value.length===0||value.length>512)throw Object.assign(new Error(`INVALID_${parameter}`),{statusCode:400});
    where.push(`${column}=${sqlString(value)}`);
  }
  for(const [parameter,operator] of [['from','>='],['to','<=']]){
    const value=searchParams.get(parameter);
    if(value===null)continue;
    if(Number.isNaN(Date.parse(value)))throw Object.assign(new Error(`INVALID_${parameter}`),{statusCode:400});
    where.push(`occurred_at${operator}parseDateTime64BestEffort(${sqlString(value)},3)`);
  }
  const requestedLimit=Number(searchParams.get('limit')??100);
  if(!Number.isInteger(requestedLimit)||requestedLimit<1||requestedLimit>1000)throw Object.assign(new Error('INVALID_limit'),{statusCode:400});
  const clause=where.length?` WHERE ${where.join(' AND ')}`:'';
  return `SELECT * FROM telemetry_serving.provider_ops_activity${clause} ORDER BY occurred_at DESC,source_record_id DESC LIMIT ${requestedLimit}`;
}

export function createQueryServer({client,apiKey=''}){
  return http.createServer(async(req,res)=>{
    try{
      if(apiKey&&req.headers.authorization!==`Bearer ${apiKey}`)return json(res,401,{error:'UNAUTHORIZED'});
      const url=new URL(req.url,'http://query');
      if(req.method==='GET'&&url.pathname==='/health')return json(res,200,{status:'ok'});
      if(req.method==='GET'&&url.pathname==='/api/v1/events'){
        const result=await client.queryJson(eventSearchSql(url.searchParams));
        return json(res,200,{data:result.data,data_watermark:result.data[0]?.ingested_at??null,source_provenance:true});
      }
      let match;
      if(req.method==='GET'&&(match=url.pathname.match(/^\/api\/v1\/tasks\/(.+)\/timeline$/))){
        const urn=decode(match[1]);
        const result=await client.queryJson(`SELECT * FROM telemetry_serving.task_timeline WHERE task_entity_urn=${sqlString(urn)} ORDER BY occurred_at LIMIT 1000`);
        return json(res,200,{data:result.data,data_watermark:result.data.at(-1)?.projected_at??null,projection_lag:null,completeness:'best_known',source_provenance:true});
      }
      if(req.method==='GET'&&(match=url.pathname.match(/^\/api\/v1\/tasks\/(.+)\/relations$/))){
        const urn=decode(match[1]);
        const result=await client.queryJson(`SELECT * FROM telemetry_core.entity_relation_fact WHERE source_entity_urn=${sqlString(urn)} OR target_entity_urn=${sqlString(urn)} ORDER BY valid_from LIMIT 1000`);
        return json(res,200,{data:result.data,data_watermark:result.data.at(-1)?.created_at??null,relation_confidence:[...new Set(result.data.map(value=>value.confidence_class))]});
      }
      if(req.method==='GET'&&url.pathname==='/api/v1/topology/sdar-smpp'){
        const tenant=url.searchParams.get('tenantId');
        const where=tenant?` WHERE tenant_id=${sqlString(tenant)}`:'';
        const result=await client.queryJson(`SELECT * FROM telemetry_serving.sdar_smpp_execution_topology${where} ORDER BY valid_from DESC LIMIT 5000`);
        return json(res,200,{data:result.data,data_watermark:result.data[0]?.valid_from??null});
      }
      if(req.method==='GET'&&(match=url.pathname.match(/^\/api\/v1\/records\/([^/]+)\/(.+)$/))){
        const system=decode(match[1]),id=decode(match[2]);
        const result=await client.queryJson(`SELECT fact_id,fact_hash,fact_type,source_system,source_record_id,source_record_hash,tenant_id,project_id,occurred_at,payload_json,correlation_json,normalizer_id,normalizer_version FROM telemetry_normalized.canonical_fact_v1 WHERE source_system=${sqlString(system)} AND source_record_id=${sqlString(id)} LIMIT 10`);
        return json(res,200,{data:result.data,source_provenance:true});
      }
      if(req.method==='GET'&&url.pathname==='/api/v1/data-quality/summary'){
        const result=await client.queryJson('SELECT rule_id,severity,count() AS count,max(detected_at) AS last_detected_at FROM telemetry_serving.telemetry_data_quality GROUP BY rule_id,severity ORDER BY severity,rule_id');
        return json(res,200,{data:result.data});
      }
      if(req.method==='GET'&&url.pathname==='/api/v1/projections/watermarks'){
        const result=await client.queryJson('SELECT * FROM telemetry_serving.projection_watermark ORDER BY projection_id,projection_version');
        return json(res,200,{data:result.data});
      }
      if(req.method==='GET'&&(match=url.pathname.match(/^\/api\/v1\/providers\/(.+)\/health$/))){
        const urn=decode(match[1]);const result=await client.queryJson(`SELECT * FROM telemetry_serving.provider_current_health WHERE provider_entity_urn=${sqlString(urn)} LIMIT 1`);
        return json(res,200,{data:result.data,data_watermark:result.data[0]?.data_watermark??null});
      }
      if(req.method==='GET'&&(match=url.pathname.match(/^\/api\/v1\/resources\/(.+)\/state$/))){
        const urn=decode(match[1]);const result=await client.queryJson(`SELECT * FROM telemetry_serving.resource_current_state WHERE resource_entity_urn=${sqlString(urn)} LIMIT 1`);
        return json(res,200,{data:result.data,data_watermark:result.data[0]?.data_watermark??null});
      }
      return json(res,404,{error:'NOT_FOUND'});
    }catch(error){return json(res,error.statusCode??500,{error:error.message});}
  });
}
