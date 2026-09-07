import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/packages/config/config.js';

test('runtime configuration rejects invalid capacity, timing and pressure values before starting',async()=>{
  for(const [name,value]of Object.entries({PROCESSOR_PORT:'65536',MAX_REQUEST_BYTES:'-1',WAL_SEGMENT_MAX_BYTES:'0',WAL_MAX_BYTES:'NaN',WAL_REJECT_THRESHOLD:'1.1',EXPORT_BATCH_SIZE:'0.5',EXPORT_INTERVAL_MS:'-10',WAL_GC_ENABLED:'ture',WAL_MIN_FREE_BYTES:'-1'})){
    const previous=process.env[name];process.env[name]=value;
    try{await assert.rejects(loadConfig(),new RegExp(`${name}_INVALID`));}
    finally{if(previous===undefined)delete process.env[name];else process.env[name]=previous;}
  }
});
