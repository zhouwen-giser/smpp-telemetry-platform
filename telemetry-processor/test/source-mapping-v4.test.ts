import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SourceMappings} from '../src/packages/source-mapping/source-mapping.js';

const base={collectorId:'c1',trustDomain:'td1',deploymentId:'dep1',providerId:'provider-1',instanceId:'runtime-1',smppSourceId:'smpp.test.provider-1',tenantId:'t1',projectId:'p1',environment:'test',mappingVersion:4,policyVersion:1,projectionRouteIds:['standalone-smpp','sdar-warehouse-shadow'],status:'active',validFrom:'2026-01-01T00:00:00Z',validTo:null};

async function load(document){const root=await mkdtemp(join(tmpdir(),'mapping-v4-'));const file=join(root,'mappings.json');await writeFile(file,JSON.stringify(document));const mappings=new SourceMappings(file);await mappings.load();return mappings;}

test('Source Mapping v4 returns the explicit stable smppSourceId',async()=>{
  const mappings=await load({version:4,mappings:[base]});
  const value=mappings.resolve({collectorId:'c1',trustDomain:'td1',deploymentId:'dep1',providerId:'provider-1',instanceId:'runtime-1',receivedAt:new Date('2026-08-18T00:00:00Z')});
  assert.equal(value.smppSourceId,'smpp.test.provider-1');
  assert.equal(value.mappingVersion,4);
});

test('v3, missing source identity, and derived-looking blank identity fail closed',async()=>{
  await assert.rejects(()=>load({version:3,mappings:[{...base,mappingVersion:3}]}),/SOURCE_MAPPINGS_V4_REQUIRED/);
  const {smppSourceId:_,...missing}=base;
  await assert.rejects(()=>load({version:4,mappings:[missing]}),/SMPP_SOURCE_MAPPING_ID_MISSING/);
  await assert.rejects(()=>load({version:4,mappings:[{...base,smppSourceId:''}]}),/SMPP_SOURCE_MAPPING_ID_MISSING/);
});
