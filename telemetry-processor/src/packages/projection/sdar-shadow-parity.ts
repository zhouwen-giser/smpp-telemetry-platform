function requiredIdentity(value,code){if(typeof value!=='string'||value.length===0)throw new Error(code);return value;}
function latestMillis(rows,field){if(!rows.length)return null;const values=rows.map((row)=>Date.parse(requiredIdentity(row[field],'SMPP_PARITY_WATERMARK_INVALID')));if(values.some((value)=>!Number.isFinite(value)))throw new Error('SMPP_PARITY_WATERMARK_INVALID');return Math.max(...values);}

export function compareSdarShadowParity({standaloneFacts,sdarFacts,relations,expectedRelationFactIds,maxWatermarkLagMs,minimumRelationCoverage}){
  if(!Number.isSafeInteger(maxWatermarkLagMs)||maxWatermarkLagMs<0)throw new Error('SMPP_PARITY_BOUND_INVALID');
  if(typeof minimumRelationCoverage!=='number'||minimumRelationCoverage<0||minimumRelationCoverage>1)throw new Error('SMPP_PARITY_BOUND_INVALID');
  const index=(rows)=>{const values=new Map();for(const row of rows){const id=requiredIdentity(row.factId,'SMPP_PARITY_IDENTITY_INVALID'),hash=requiredIdentity(row.factHash,'SMPP_PARITY_HASH_INVALID');const previous=values.get(id);if(previous!==undefined&&previous!==hash)throw new Error('SMPP_FACT_CONTENT_CONFLICT');values.set(id,hash);}return values;};
  const standalone=index(standaloneFacts),sdar=index(sdarFacts);
  const missingFactIds=[...standalone.keys()].filter((id)=>!sdar.has(id)).sort();
  const unexpectedFactIds=[...sdar.keys()].filter((id)=>!standalone.has(id)).sort();
  const hashMismatchFactIds=[...standalone].filter(([id,hash])=>sdar.has(id)&&sdar.get(id)!==hash).map(([id])=>id).sort();
  const standaloneWatermark=latestMillis(standaloneFacts,'projectedAt');
  const sdarWatermark=latestMillis(sdarFacts,'projectedAt');
  const watermarkLagMs=standaloneWatermark===null||sdarWatermark===null?null:Math.max(0,standaloneWatermark-sdarWatermark);
  const actualRelationFacts=new Set(relations.flatMap((relation)=>relation.evidenceFactIds??[]));
  const expectedRelations=new Set(expectedRelationFactIds);
  const coveredRelationFactIds=[...expectedRelations].filter((id)=>actualRelationFacts.has(id)).sort();
  const relationCoverage=expectedRelations.size===0?1:coveredRelationFactIds.length/expectedRelations.size;
  const checks=Object.freeze({
    countParity:standalone.size===sdar.size,
    factHashParity:missingFactIds.length===0&&unexpectedFactIds.length===0&&hashMismatchFactIds.length===0,
    watermarkParity:watermarkLagMs!==null&&watermarkLagMs<=maxWatermarkLagMs,
    relationCoverage:relationCoverage>=minimumRelationCoverage
  });
  return Object.freeze({
    status:Object.values(checks).every(Boolean)?'passed':'failed',
    checks,
    standaloneCount:standalone.size,sdarCount:sdar.size,
    missingFactIds:Object.freeze(missingFactIds),unexpectedFactIds:Object.freeze(unexpectedFactIds),hashMismatchFactIds:Object.freeze(hashMismatchFactIds),
    standaloneWatermark,sdarWatermark,watermarkLagMs,maxWatermarkLagMs,
    expectedRelationFactCount:expectedRelations.size,coveredRelationFactCount:coveredRelationFactIds.length,relationCoverage,minimumRelationCoverage
  });
}
