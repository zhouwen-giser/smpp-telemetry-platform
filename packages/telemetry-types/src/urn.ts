export interface TelemetryEntityUrn {tenantId:string;sourceSystem:string;deploymentId:string;entityType:string;entityId:string}
function identity(value:unknown):asserts value is string {
  if(typeof value!=='string'||!value||value.length>512||/[\u0000-\u001f\u007f]/u.test(value))throw new Error('TELEMETRY_URN_INVALID');
  try{encodeURIComponent(value);}catch{throw new Error('TELEMETRY_URN_INVALID');}
}
export function encodeEntityUrn(value:TelemetryEntityUrn):string {
  const {tenantId,sourceSystem,deploymentId,entityType,entityId}=value;
  for(const part of [tenantId,sourceSystem,deploymentId,entityType,entityId])identity(part);
  if(!/^[a-z][a-z0-9_-]{0,63}$/u.test(sourceSystem)||!/^[a-z][a-z0-9_-]{0,63}$/u.test(entityType))throw new Error('TELEMETRY_URN_INVALID');
  return `urn:telemetry:${encodeURIComponent(tenantId)}:${sourceSystem}:${encodeURIComponent(deploymentId)}:${entityType}:${encodeURIComponent(entityId)}`;
}
export function parseEntityUrn(value:unknown):TelemetryEntityUrn {
  if(typeof value!=='string')throw new Error('TELEMETRY_URN_INVALID');
  const parts=value.split(':');
  if(parts.length!==7||parts[0]!=='urn'||parts[1]!=='telemetry')throw new Error('TELEMETRY_URN_INVALID');
  try{
    const result={tenantId:decodeURIComponent(parts[2]!),sourceSystem:parts[3]!,deploymentId:decodeURIComponent(parts[4]!),entityType:parts[5]!,entityId:decodeURIComponent(parts[6]!)};
    if(encodeEntityUrn(result)!==value)throw new Error();
    return result;
  }catch{throw new Error('TELEMETRY_URN_INVALID');}
}
