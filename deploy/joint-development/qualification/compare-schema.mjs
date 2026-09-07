import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';import {execFileSync} from 'node:child_process';import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
if(process.argv.length!==6)throw Error('Usage: node compare-schema.mjs <qualification-state> <all.sql> <locked-schema-snapshot-directory> <evidence-directory>');
const state=resolve(process.argv[2]),schemaSource=resolve(process.argv[3]),source=resolve(process.argv[4]),output=resolve(process.argv[5]);mkdirSync(output,{recursive:true});
const identity=JSON.parse(readFileSync(state+'/compose.json','utf8'));if(!/^smpp-remediation-(?:qualification|e1)-/.test(identity.name))throw Error('ISOLATED_QUALIFICATION_PROJECT_REQUIRED');
const sql=q=>JSON.parse(execFileSync('docker',['compose','-f',state+'/compose.json','exec','-T','shared-test','clickhouse-client','--password','e1-isolated-only','--query',q+' FORMAT JSONEachRow'],{encoding:'utf8',maxBuffer:32*1024*1024}).trim().split('\n').filter(Boolean).map(x=>JSON.parse(x)).map(x=>JSON.stringify(x)).join(',').replace(/^/,'[').replace(/$/,']'));
const report={status:'RUNNING',schemaSource,packageByteLockMatched:process.env.EXPECTED_SCHEMA_SQL_SHA256?createHash('sha256').update(readFileSync(schemaSource)).digest('hex')===process.env.EXPECTED_SCHEMA_SQL_SHA256:null};report.schemaSourceSha256=createHash('sha256').update(readFileSync(report.schemaSource)).digest('hex');
for(const kind of ['tables','columns']){
const expected=JSON.parse(readFileSync(source+'/'+kind+'.json','utf8')),keys=Object.keys(expected[0]);
const actual=sql(`SELECT ${keys.join(',')} FROM system.${kind} WHERE database IN ('sdar_meta','sdar_core','sdar_commander','sdar_npc','sdar_embodied','sdar_mart') ORDER BY database,${kind==='tables'?'name':'table,position'}`);
const normal=row=>Object.fromEntries(keys.map(k=>[k,String(row[k])]));const key=row=>kind==='tables'?row.database+'.'+row.name:row.database+'.'+row.table+'.'+row.name;
const map=new Map(actual.map(r=>[key(r),normal(r)])),diff=[];for(const row of expected){const id=key(row),value=map.get(id);if(JSON.stringify(normal(row))!==JSON.stringify(value))diff.push({id,expected:normal(row),actual:value});map.delete(id);}for(const [id,actual]of map)diff.push({id,actual});
report[kind]={expected:expected.length,actual:actual.length,differenceCount:diff.length,differences:diff.slice(0,20)};
}
report.release=sql('SELECT release_version,migration_range,release_descriptor_hash,schema_contract_hash FROM sdar_meta.v_schema_contract_release_current');report.status=report.tables.differenceCount===0&&report.columns.differenceCount===0?'SCHEMA_MATCH':'SCHEMA_DIFFERENCES';writeFileSync(output+'/shared-schema.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));if(report.status!=='SCHEMA_MATCH')process.exitCode=1;
