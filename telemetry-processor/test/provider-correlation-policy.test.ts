// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import {calculateProviderOpsRecordHash} from '../src/packages/canonical/canonical.js';
import {normalizeProviderCorrelation} from '../src/packages/validation/provider-correlation-policy.js';
import {validateEnvelope} from '../src/packages/validation/validation.js';
import {envelope,logRecord} from './helpers.js';

function validate(e){return validateEnvelope(e,logRecord(e).attributes);}
function changed(overrides){const e=envelope(overrides);e.recordHash=calculateProviderOpsRecordHash(e);return e;}

test('canonical origin claims are bounded, deduplicated and stable-sorted',()=>{
  const e=changed({attributes:{correlation:{originSystem:'sdar',originDeploymentId:'dep-1',originTaskIds:['b','a','b'],originInvocationIds:['i-1']}}});
  assert.deepEqual(validate(e),{ok:true});
  const value=normalizeProviderCorrelation(e);
  assert.deepEqual(value.originTaskIds,['a','b']);
  assert.equal(value.semanticClass,'source_declared_reconciliation_claim');
  assert.equal(value.authoritative,false);
  assert.equal(value.maySelectFacts,false);
});

test('legacy aliases and evaluation-domain identity are rejected during development cutover',()=>{
  const legacy=changed({attributes:{originSystem:'sdar',originTaskIds:['task-1']}});
  assert.equal(validate(legacy).code,'SMPP_ORIGIN_METADATA_INVALID');
  const evaluation=changed({payload:{currentState:'working',episodeId:'episode-1'}});
  assert.equal(validate(evaluation).code,'SMPP_EVALUATION_DOMAIN_IDENTITY_FORBIDDEN');
});

test('origin identity requires system and SDAR deployment',()=>{
  const missingSystem=changed({attributes:{correlation:{originTaskIds:['task-1']}}});
  assert.equal(validate(missingSystem).code,'SMPP_ORIGIN_SYSTEM_MISSING');
  const missingDeployment=changed({attributes:{correlation:{originSystem:'sdar',originTaskIds:['task-1']}}});
  assert.equal(validate(missingDeployment).code,'SMPP_ORIGIN_DEPLOYMENT_MISSING');
});

test('provider-local identity and event time fail closed',()=>{
  const task=envelope();delete task.taskId;task.recordHash=calculateProviderOpsRecordHash(task);
  assert.equal(validate(task).code,'PROVIDER_LOCAL_IDENTITY_MISSING');
  const backwards=changed({occurredAt:'2026-07-18T03:12:11.000Z',emittedAt:'2026-07-18T03:12:10.000Z'});
  assert.equal(validate(backwards).code,'SMPP_EVENT_TIME_INVALID');
});
