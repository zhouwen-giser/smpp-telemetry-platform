import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { calculateProviderOpsRecordHash } from '../src/packages/canonical/canonical.js';
import { ALLOWED_DELIVERY_CLASSES, ALLOWED_EVENT_CATEGORIES, ALLOWED_TYPES, validateEnvelope } from '../src/packages/validation/validation.js';

const vectorPath=new URL('telemetry-schema/contracts/test-vectors/smpp-local-source-provider-resource-state-1.1.0.json',`file://${process.cwd()}/`);
const vector=JSON.parse(await readFile(vectorPath,'utf8'));
const sourceCapture=JSON.parse(await readFile(new URL('reports/smpp-stable-integration/SMPP_TELEMETRY_SOURCE_CAPTURE.json',`file://${process.cwd()}/`),'utf8'));
const envelope=vector.envelope;
const attributes={
  'sdar.schema.name':envelope.schemaName,'sdar.schema.version':envelope.schemaVersion,
  'sdar.record.id':envelope.recordId,'sdar.record.hash':envelope.recordHash,
  'telemetry.contract.version':envelope.schemaVersion
};

test('local SMPP source vector has exact canonical hash parity',()=>{
  assert.equal(calculateProviderOpsRecordHash(envelope),vector.expectedRecordHash);
  assert.equal(vector.expectedRecordHash,'57afebfcb2fcd7b2eb7a7ea2b79f7348d57b279ebf06cb87fe0a03621440dfee');
  assert.deepEqual(validateEnvelope(envelope,attributes),{ok:true});
});

test('schema copies remain byte-identical',async()=>{
  const [projectCopy,warehouseCopy]=await Promise.all([
    readFile(new URL('contracts/provider-ops-envelope.schema.json',`file://${process.cwd()}/`)),
    readFile(new URL('telemetry-schema/contracts/smpp/provider-ops-envelope-1.1.0.schema.json',`file://${process.cwd()}/`))
  ]);
  assert.deepEqual(projectCopy,warehouseCopy);
});

test('validator allowlists equal the current SMPP ProviderOps source capture',()=>{
  assert.deepEqual([...ALLOWED_TYPES],sourceCapture.recordTypes);
  assert.deepEqual([...ALLOWED_EVENT_CATEGORIES],sourceCapture.eventCategories);
  assert.deepEqual([...ALLOWED_DELIVERY_CLASSES],sourceCapture.deliveryClasses);
});

test('unknown schema major and OTLP/body mismatch fail closed',()=>{
  assert.equal(validateEnvelope({...envelope,schemaVersion:'2.0.0'},attributes).code,'SCHEMA_VERSION_UNSUPPORTED');
  assert.equal(validateEnvelope(envelope,{...attributes,'sdar.record.hash':'0'.repeat(64)}).code,'OTLP_RECORD_HASH_MISMATCH');
  const missing={...attributes};delete missing['sdar.schema.name'];
  assert.equal(validateEnvelope(envelope,missing).code,'OTLP_CONTRACT_ATTRIBUTE_MISSING');
});
