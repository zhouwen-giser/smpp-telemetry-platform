import { readFile } from 'node:fs/promises';
const match=(expected,actual)=>expected==='*'||expected===actual;
const stableSourceId=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
export class SourceMappings {
  constructor(file,{allowWildcards=false}={}){ this.file=file; this.allowWildcards=allowWildcards; this.version=0; this.mappings=[]; }
  async load(){ const data=JSON.parse(await readFile(this.file,'utf8')); if(!Array.isArray(data.mappings)||Number(data.version)!==4) throw new Error('SOURCE_MAPPINGS_V4_REQUIRED'); if(!this.allowWildcards&&data.mappings.some(item=>[item.collectorId,item.trustDomain,item.deploymentId,item.providerId,item.instanceId].some(value=>value==='*')))throw new Error('SOURCE_MAPPING_WILDCARD_FORBIDDEN'); for(const item of data.mappings){if(!stableSourceId.test(String(item.smppSourceId??'')))throw new Error('SMPP_SOURCE_MAPPING_ID_MISSING');if(Number(item.mappingVersion)!==4)throw new Error('SOURCE_MAPPING_VERSION_INVALID');} this.version=4; this.mappings=data.mappings; }
  resolve({ collectorId='', trustDomain='', deploymentId='', providerId, instanceId, receivedAt=new Date() }){
    const when=receivedAt.getTime();
    const mapping=this.mappings.find(item=>item.status==='active'&&match(item.collectorId??'*',collectorId)&&match(item.trustDomain??'*',trustDomain)&&match(item.deploymentId??'*',deploymentId)&&match(item.providerId,providerId)&&match(item.instanceId??'*',instanceId)&&Date.parse(item.validFrom??'1970-01-01T00:00:00Z')<=when&&(item.validTo==null||Date.parse(item.validTo)>when));
    if(!mapping) return null;
    return { tenantId:mapping.tenantId, projectId:mapping.projectId, environment:mapping.environment, smppSourceId:mapping.smppSourceId, mappingVersion:4, policyVersion:Number(mapping.policyVersion??1), sourceProduct:mapping.sourceProduct??'sdar-mcp-provider-platform', projectionRouteIds:[...(mapping.projectionRouteIds??['standalone-smpp'])] };
  }
}
