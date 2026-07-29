import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(process.argv[2] ?? '.');
const envText = await readFile(path.join(root, '.env'), 'utf8');
const env = Object.fromEntries(envText.split(/\r?\n/).filter(x => x && !x.startsWith('#') && x.includes('=')).map(line => { const i=line.indexOf('='); return [line.slice(0,i), line.slice(i+1)]; }));
const services = (env.SMPP_SERVICES ?? '').split(',').map(x=>x.trim()).filter(Boolean).map((item,index)=>{
  if(item.includes('|')){const [name,address]=item.split('|'); if(!name||!address) throw new Error(`SMPP_SERVICES 第 ${index+1} 项格式错误`); return {name,address};}
  return {name:`smpp-${index+1}`,address:item};
});
if(!services.length) throw new Error('SMPP_SERVICES 至少配置一个 SMPP 服务地址');
for(const s of services){new URL(s.address);}
const collectorId=env.COLLECTOR_ID || 'smpp-gateway-1';
const trustDomain=env.TRUST_DOMAIN || 'local-compose';
const deploymentId=env.SMPP_DEPLOYMENT_ID || 'development';
const mapping={collectorId,trustDomain,deploymentId,providerId:'*',instanceId:'*',tenantId:env.TELEMETRY_TENANT_ID||'tenant-local',projectId:env.TELEMETRY_PROJECT_ID||'smpp-local',environment:env.TELEMETRY_ENVIRONMENT||'development',sourceProduct:'sdar-mcp-provider-platform',mappingVersion:2,policyVersion:1,projectionRouteIds:['standalone-smpp'],status:'active',validFrom:'2026-01-01T00:00:00Z',validTo:null};
await mkdir(path.join(root,'config','generated'),{recursive:true});
await writeFile(path.join(root,'config','generated','source-mappings.json'),JSON.stringify({version:2,serviceInventory:services,mappings:[mapping]},null,2)+'\n');
const host=env.TELEMETRY_PUBLIC_HOST||'127.0.0.1';
const port=env.OTLP_HTTP_PORT||'4318';
const lines=['# SMPP Runtime 遥测接入配置（自动生成）','','OpenTelemetry 是主动推送模型。请在下列 SMPP 服务中把 OTLP Endpoint 指向本平台：',''];
for(const s of services){lines.push(`## ${s.name}`,`SMPP 服务地址：${s.address}`,'','```env','OTEL_ENABLED=true',`OTEL_EXPORTER_OTLP_ENDPOINT=http://${host}:${port}`,'OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf','```','');}
lines.push('> 服务地址仅用于资产登记和生成接入清单，Collector 不会轮询 SMPP HTTP 服务。');
await writeFile(path.join(root,'config','generated','SMPP_RUNTIME_OTEL_CONFIG.md'),lines.join('\n')+'\n');
console.log(`已登记 ${services.length} 个 SMPP 服务并生成接入配置。`);
