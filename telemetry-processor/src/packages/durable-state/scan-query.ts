import type { StateScanOptions } from './types.js';

/** Exclusive upper bound for valid Unicode strings under SQLite BINARY/UTF-8 order. */
export function prefixSuccessor(prefix:string):string|undefined{
  const points=Array.from(prefix,character=>character.codePointAt(0)!);
  for(let index=points.length-1;index>=0;index--){
    const point=points[index]!;
    if(point<0x10ffff){let next=point+1;if(next===0xd800)next=0xe000;return String.fromCodePoint(...points.slice(0,index),next);}
  }
  return undefined;
}

/** Use one tight lower bound so later pages seek instead of scanning from the prefix. */
export function buildStateScanQuery(namespace:string,{prefix='',after,limit=200}:StateScanOptions={}):{sql:string;bindings:Array<string|number>}{
  if(!Number.isSafeInteger(limit)||limit<1||limit>10000)throw new Error('STATE_SCAN_LIMIT_INVALID');
  const useAfter=after!==undefined&&Buffer.compare(Buffer.from(after),Buffer.from(prefix))>=0;
  const lower=useAfter?after!:prefix,upper=prefixSuccessor(prefix);
  const bindings:Array<string|number>=[namespace,lower];
  let sql=`SELECT key,value FROM state_kv WHERE namespace=? AND key${useAfter?'>':'>='}?`;
  if(upper!==undefined){sql+=' AND key<?';bindings.push(upper);}
  sql+=' ORDER BY key LIMIT ?';bindings.push(limit);
  return{sql,bindings};
}
