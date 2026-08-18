import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(process.argv[2] ?? '.');
const envFile = path.resolve(process.argv[3] ?? path.join(root, '.env'));
const envText = await readFile(envFile, 'utf8');
const env = Object.fromEntries(envText.split(/\r?\n/).filter(x => x && !x.startsWith('#') && x.includes('=')).map(line => { const i=line.indexOf('='); const raw=line.slice(i+1); const value=(raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"'))?raw.slice(1,-1):raw; return [line.slice(0,i), value]; }));
const services = (env.SMPP_SERVICES ?? '').split(',').map(x=>x.trim()).filter(Boolean).map((item,index)=>{
  if(item.includes('|')){const [name,address]=item.split('|'); if(!name||!address) throw new Error(`SMPP_SERVICES 第 ${index+1} 项格式错误`); return {name,address};}
  return {name:`smpp-${index+1}`,address:item};
});
if(!services.length) throw new Error('SMPP_SERVICES 至少配置一个 SMPP 服务地址');
for(const s of services){new URL(s.address);}
const collectorId=env.COLLECTOR_ID || 'smpp-gateway-1';
const trustDomain=env.TRUST_DOMAIN || 'local-compose';
const deploymentId=env.SMPP_DEPLOYMENT_ID || 'development';
const providerId=env.SMPP_PROVIDER_ID || '';
const instanceId=env.SMPP_RUNTIME_INSTANCE_ID || '';
const smppSourceId=env.SMPP_SOURCE_ID || '';
if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(providerId)||providerId==='*') throw new Error('SMPP_PROVIDER_ID 必须是精确 Provider 标识，禁止通配符');
if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(instanceId)||instanceId==='*') throw new Error('SMPP_RUNTIME_INSTANCE_ID 必须是精确 Runtime 实例标识，禁止通配符');
if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(smppSourceId)||smppSourceId==='*') throw new Error('SMPP_SOURCE_ID 必须是显式稳定来源标识，禁止缺失、派生或通配符');
if([collectorId,trustDomain,deploymentId].some(value=>!value||value==='*')) throw new Error('Collector、trust domain 和 deployment 标识必须精确且非通配');
const mapping={collectorId,trustDomain,deploymentId,providerId,instanceId,smppSourceId,tenantId:env.TELEMETRY_TENANT_ID||'tenant-local',projectId:env.TELEMETRY_PROJECT_ID||'smpp-local',environment:env.TELEMETRY_ENVIRONMENT||'development',sourceProduct:'sdar-mcp-provider-platform',mappingVersion:4,policyVersion:1,projectionRouteIds:['standalone-smpp','sdar-warehouse-shadow'],status:'active',validFrom:'2026-01-01T00:00:00Z',validTo:null};
await mkdir(path.join(root,'config','generated'),{recursive:true});
await writeFile(path.join(root,'config','generated','source-mappings.json'),JSON.stringify({version:4,serviceInventory:services,mappings:[mapping]},null,2)+'\n');
const host=env.TELEMETRY_PUBLIC_HOST||'127.0.0.1';
const port=env.OTLP_HTTP_PORT||'4318';
const qualification=env.TELEMETRY_TRANSPORT_MODE==='qualification';
const scheme=qualification?'https':'http';
const lines=['# SMPP Runtime OTLP 配置（自动生成）','',`生成的精确来源身份：Provider \`${providerId}\`，Runtime 实例 \`${instanceId}\`。`,'','OpenTelemetry 是主动推送模型。Prometheus 指标由本平台从 Runtime `/metrics` 主动拉取。',''];
for(const s of services){lines.push(`## ${s.name}`,`SMPP 服务地址：${s.address}`,'','```env','OTEL_ENABLED=true',`OTEL_EXPORTER_OTLP_ENDPOINT=${scheme}://${host}:${port}`,`OTEL_EXPORTER_OTLP_TLS_MODE=${qualification?'required':'disabled'}`,'OTEL_EXPORTER_OTLP_TIMEOUT_MS=10000',`OTEL_SERVICE_INSTANCE_ID=${instanceId}`,...(qualification?['OTEL_EXPORTER_OTLP_CA_PATH=/run/secrets/otel/ca.pem','OTEL_EXPORTER_OTLP_CERT_PATH=/run/secrets/otel/tls.crt','OTEL_EXPORTER_OTLP_KEY_PATH=/run/secrets/otel/tls.key','# Optional file-backed exporter headers:','# OTEL_EXPORTER_OTLP_HEADERS_FILE=/run/secrets/otel/headers.json']:[]),'```','');}
lines.push(`Prometheus scrape: \`${env.SMPP_METRICS_TARGET||'192.168.1.7:19100'}${env.SMPP_METRICS_PATH||'/metrics'}\`, interval \`${env.SMPP_METRICS_SCRAPE_INTERVAL||'15s'}\`.`);
await writeFile(path.join(root,'config','generated','SMPP_RUNTIME_OTEL_CONFIG.md'),lines.join('\n')+'\n');
console.log(`已登记 ${services.length} 个 SMPP 服务并生成接入配置。`);
