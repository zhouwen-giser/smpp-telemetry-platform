import catalog from '../../../../contracts/provider-ops-payload-catalog.v1.1.json' with {type:'json'};

const RECORD_TYPES=Object.freeze([
  'provider.task.lifecycle','provider.command.lifecycle','provider.scheduler.decision',
  'provider.recovery.lifecycle','provider.ttl.lifecycle','provider.resource.state',
  'provider.resource.metric','provider.resource.health','provider.execution.progress',
  'provider.business_event.source.lifecycle','provider.business_event.ingest.lifecycle',
  'provider.business_event.publication.lifecycle','provider.business_event.stream.lifecycle',
  'provider.business_event.continuity','provider.business_event.delivery.lifecycle',
  'provider.business_event.relation.lifecycle'
]);

function isPlainObject(value){return value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;}
function validUtc(value){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value))return false;const parsed=Date.parse(value);return Number.isFinite(parsed);}
function validateValue(type,value){
  if(type==='string')return typeof value==='string'&&value.length>0&&value.length<=512;
  if(type==='utc')return validUtc(value);
  if(type==='percent')return typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=100;
  return false;
}

export function providerOpsRecordTypes(){return [...RECORD_TYPES];}

export function assertPayloadCatalog(){
  if(catalog.contract!=='smpp.providerops-payload-catalog/v1.1'||catalog.catalogVersion!==1)throw new Error('SMPP_PAYLOAD_CONTRACT_INVALID');
  const actual=Object.keys(catalog.recordTypes).sort();
  const expected=[...RECORD_TYPES].sort();
  if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('SMPP_PAYLOAD_CONTRACT_MISSING');
  return catalog;
}

export function extractProviderOpsSemantics(recordType,payload){
  assertPayloadCatalog();
  const definition=catalog.recordTypes[recordType];
  if(!definition)throw new Error('SMPP_PAYLOAD_CONTRACT_MISSING');
  if(!isPlainObject(payload))throw new Error('SMPP_PAYLOAD_CONTRACT_INVALID');
  const semantics={};
  for(const [target,rule] of Object.entries(definition.fields)){
    const value=payload[rule.source];
    if(value===undefined)continue;
    if(!validateValue(rule.type,value))throw new Error('SMPP_PAYLOAD_CONTRACT_INVALID');
    semantics[target]=value;
  }
  return Object.freeze(semantics);
}
