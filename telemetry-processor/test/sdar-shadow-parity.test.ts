import test from 'node:test';
import assert from 'node:assert/strict';
import {compareSdarShadowParity} from '../src/packages/projection/sdar-shadow-parity.js';

const facts=[
  {factId:'fact-a',factHash:'a'.repeat(64),projectedAt:'2026-08-18T01:00:00.000Z'},
  {factId:'fact-b',factHash:'b'.repeat(64),projectedAt:'2026-08-18T01:00:01.000Z'}
];

test('shadow parity freezes count, hash, watermark and relation coverage gates',()=>{
  const result=compareSdarShadowParity({standaloneFacts:facts,sdarFacts:facts.map((fact)=>({...fact,projectedAt:'2026-08-18T01:00:00.500Z'})),relations:[{evidenceFactIds:['fact-a','fact-b']}],expectedRelationFactIds:['fact-a','fact-b'],maxWatermarkLagMs:1000,minimumRelationCoverage:1});
  assert.equal(result.status,'passed');
  assert.deepEqual(result.checks,{countParity:true,factHashParity:true,watermarkParity:true,relationCoverage:true});
  assert.equal(result.watermarkLagMs,500);
  assert.equal(result.relationCoverage,1);
});

test('shadow parity fails closed for hash, lag and relation gaps',()=>{
  const result=compareSdarShadowParity({standaloneFacts:facts,sdarFacts:[{...facts[0],factHash:'c'.repeat(64),projectedAt:'2026-08-18T00:59:00.000Z'}],relations:[],expectedRelationFactIds:['fact-a','fact-b'],maxWatermarkLagMs:1000,minimumRelationCoverage:1});
  assert.equal(result.status,'failed');
  assert.deepEqual(result.checks,{countParity:false,factHashParity:false,watermarkParity:false,relationCoverage:false});
  assert.deepEqual(result.missingFactIds,['fact-b']);
  assert.deepEqual(result.hashMismatchFactIds,['fact-a']);
});

test('same identity with different hash is an explicit content conflict',()=>{
  assert.throws(()=>compareSdarShadowParity({standaloneFacts:[facts[0],{...facts[0],factHash:'c'.repeat(64)}],sdarFacts:[],relations:[],expectedRelationFactIds:[],maxWatermarkLagMs:1000,minimumRelationCoverage:1}),/SMPP_FACT_CONTENT_CONFLICT/);
});
