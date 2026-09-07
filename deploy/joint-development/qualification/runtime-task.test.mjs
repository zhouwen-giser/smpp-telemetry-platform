import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';

async function fixture() {
 const dir=await mkdtemp(resolve(tmpdir(),'smpp-runtime-qualification-test-'));
 let dispatches=0,terminal='failed';
 const server=createServer((req,res)=>{if(req.url==='/health/ready'){res.end(JSON.stringify({status:'ready'}));return;}let text='';req.on('data',chunk=>text+=chunk);req.on('end',()=>{const rpc=JSON.parse(text);let result;
 if(rpc.method==='tools/call'&&rpc.params.name==='vehicle_get_state')result={structuredContent:{identity:{executionMode:'simulation'},connectivity:{deviceAvailable:true,mqttConnected:true,deviceMcpConnected:true},chassis:{position:{latitude:20,longitude:100}}}};
 else if(rpc.method==='io.sdar/taskExecution/checkAvailability')result={results:[{availability:'available'}]};
 else if(rpc.method==='tools/call'){dispatches++;result={resultType:'task',taskId:'test-task-'+dispatches};}
 else result={status:terminal};res.setHeader('content-type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result}));});});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(undefined)));
 const address=server.address();assert(address&&typeof address==='object');
 await writeFile(dir+'/compose.json',JSON.stringify({name:'smpp-remediation-qualification-fixture',services:{adapter:{environment:{UGV_EXECUTION_MODE:'simulation'}}}}));
 await writeFile(dir+'/docker','#!/usr/bin/env node\nprocess.stdout.write(process.env.QUALIFICATION_TEST_RUNTIME_ADDRESS);\n',{mode:0o700});
 /** @returns {Promise<{code:number,stderr:string}>} */
 const run=(file)=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,[new URL('./runtime-task.mjs',import.meta.url).pathname,dir,file],{env:{...process.env,PATH:dir+':'+process.env.PATH,QUALIFICATION_TEST_RUNTIME_ADDRESS:'127.0.0.1:'+address.port},stdio:['ignore','ignore','pipe']});let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);child.on('error',reject);child.on('exit',code=>resolve({code:code??-1,stderr}));});
 return{dir,run,dispatches:()=>dispatches,setTerminal:value=>{terminal=value;},close:async()=>{await new Promise(resolve=>server.close(()=>resolve(undefined)));await rm(dir,{recursive:true,force:true});}};
}
test('same evidence path has one atomic owner and failed terminal returns nonzero',async()=>{const f=await fixture();try{const file=f.dir+'/report.json';const results=await Promise.all([f.run(file),f.run(file)]);assert.equal(results.filter(r=>r.stderr.includes('EEXIST')).length,1);assert(results.every(r=>r.code!==0));assert.equal(f.dispatches(),1);const report=JSON.parse(await readFile(file,'utf8'));assert.equal(report.status,'TASK_TERMINAL_FAILURE');assert.match(report.runId,/-navigation-[0-9a-f-]{36}$/);const repeat=await f.run(file);assert.notEqual(repeat.code,0);assert.equal(f.dispatches(),1);}finally{await f.close();}});
test('a completed task returns zero and retains terminal evidence',async()=>{const f=await fixture();try{f.setTerminal('completed');const file=f.dir+'/report.json',result=await f.run(file);assert.equal(result.code,0,result.stderr);assert.equal(f.dispatches(),1);const report=JSON.parse(await readFile(file,'utf8'));assert.equal(report.status,'PASS');assert.equal(report.polls.at(-1).body.result.status,'completed');}finally{await f.close();}});
