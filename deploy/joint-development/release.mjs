import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {copyFileSync,mkdirSync,mkdtempSync,openSync,closeSync,readFileSync,writeFileSync,rmSync,readdirSync,lstatSync} from 'node:fs';
import {resolve,join,basename,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {parseArgs} from 'node:util';

const {values}=parseArgs({options:{smpp:{type:'string'},output:{type:'string'},'clickhouse-image':{type:'string'},'skip-checks':{type:'boolean',default:false},help:{type:'boolean',default:false}},strict:true});
if(values.help){console.log('Usage: npm run package:joint -- [--smpp PATH] [--output NEW_DIRECTORY] [--clickhouse-image TAG_OR_DIGEST] [--skip-checks]\nDefault: package current worktrees, extract, npm ci and npm run check, publish SHA256 and delivery.json. No deployment or game task is performed.');process.exit(0);}
const root=resolve(import.meta.dirname,'../..');
const smpp=resolve(values.smpp??join(root,'../sdar-mcp-provider-platform'));
const output=resolve(values.output??join(root,'artifacts/joint-development',`release-${new Date().toISOString().replaceAll(/[:.]/g,'-')}`));
if(values['clickhouse-image']&&!/^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/.test(values['clickhouse-image']))throw Error('INVALID_CLICKHOUSE_IMAGE');
// Never overwrite a previous delivery, including its failure evidence.
mkdirSync(dirname(output),{recursive:true});
mkdirSync(output,{recursive:false});
const temp=mkdtempSync(join(tmpdir(),'smpp-joint-release-'));
const sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const manifest={status:'RUNNING',startedAt:new Date().toISOString(),scope:'Simulation-game software; SMPP live mode. Packaging does not deploy or submit game tasks.',checks:[],qualification:{nativeArm64:'NOT_RUN',gameIntegration:'NOT_RUN',historicalReports:'Reference only; not qualification of this generated archive.'}};
const save=()=>writeFileSync(join(output,'delivery.json'),JSON.stringify(manifest,null,2)+'\n');
const runCheck=(name,command,args,cwd)=>{
 const logfile=join(output,`${name}.log`),fd=openSync(logfile,'w',0o600),entry={name,status:'RUNNING',log:basename(logfile)};manifest.checks.push(entry);save();
 try{execFileSync(command,args,{cwd,stdio:['ignore',fd,fd],env:{...process.env,CI:'true'}});entry.status='PASS';}
 catch(error){entry.status='FAIL';throw error;}
 finally{closeSync(fd);save();}
};
try{
 console.error('Packaging current SMPP and Telemetry worktrees…');
 const packed=JSON.parse(execFileSync(process.execPath,[join(root,'deploy/joint-development/package.mjs'),smpp,join(temp,'package')],{encoding:'utf8',maxBuffer:8*1024*1024}));
 if(sha(packed.archive)!==packed.sha256)throw Error('INITIAL_ARCHIVE_HASH_MISMATCH');
 const extracted=join(temp,'extracted');mkdirSync(extracted);execFileSync('tar',['-xzf',packed.archive,'-C',extracted]);
 const release=JSON.parse(readFileSync(join(extracted,'release.json'),'utf8'));
 const envPath=join(extracted,'.env.example');let env=readFileSync(envPath,'utf8');
 const replace=(key,value)=>{const regex=new RegExp(`^\\s*#?\\s*${key}=.*$`,'gm');const matches=env.match(regex);if(matches?.length!==1)throw Error(`TEMPLATE_KEY_NOT_UNIQUE:${key}`);env=env.replace(regex,`${key}=${JSON.stringify(value)}`);};
 // Explicitly retain the software transport mode, independent of the word simulation in project scope.
 replace('ADAPTER__UGV_EXECUTION_MODE','live');
 if(values['clickhouse-image'])replace('CLICKHOUSE_IMAGE',values['clickhouse-image']);
 // The stock template is also a loader contract. Keep it untouched and ship a separate editable deployment profile.
 writeFileSync(join(extracted,'deployment.env.example'),env);
 writeFileSync(join(extracted,'PACKAGE_USAGE.md'),'# Generated joint release\n\nSimulation-game software; SMPP uses live mode.\n\nCopy deployment.env.example to .env, configure the shared schema endpoint/credentials and host ports, then run bash deploy.sh config .env followed by bash deploy.sh up .env.\n\nAn explicitly selected local ClickHouse image must already exist and be qualified on the destination CPU. This packaging run does not verify or transfer Docker images.\n\nSee README.md for configuration and lifecycle commands.\n');
 const configEnv=env.replace(/^\s*#?\s*SHARED__URL=.*$/m,'SHARED__URL="http://unused.invalid:8123"').replace(/^\s*#?\s*SHARED__PASSWORD=.*$/m,'SHARED__PASSWORD="package-config-check-only"');
 writeFileSync(join(extracted,'package-check.env'),configEnv,{mode:0o600});
 runCheck('package-config',process.execPath,['cli.mjs','config','package-check.env'],extracted);
 if(!values['skip-checks']){
  console.error('Checking the extracted archive (npm ci, npm run check)…');
  runCheck('install','npm',['ci','--ignore-scripts','--no-audit','--no-fund'],join(extracted,'sources/telemetry'));
  runCheck('check','npm',['run','check'],join(extracted,'sources/telemetry'));
 }else manifest.checks.push({name:'check',status:'SKIPPED',log:null});
 // Build from a pristine extraction: verification must never ship node_modules, dist or generated test state.
 const publish=join(temp,'publish');mkdirSync(publish);execFileSync('tar',['-xzf',packed.archive,'-C',publish]);
 for(const name of ['deployment.env.example','PACKAGE_USAGE.md'])copyFileSync(join(extracted,name),join(publish,name));
 const inventory=[];
 const walk=(dir,prefix='')=>{for(const name of readdirSync(dir).sort()){const path=join(dir,name),relative=prefix+name,stat=lstatSync(path);if(stat.isDirectory())walk(path,relative+'/');else if(stat.isFile())inventory.push({path:relative,bytes:stat.size,sha256:sha(path)});}};
 walk(publish);writeFileSync(join(publish,'files.sha256'),inventory.map(f=>`${f.sha256}  ${f.path}`).join('\n')+'\n');
 const archive=join(temp,basename(packed.archive));execFileSync('tar',['-czf',archive,'-C',publish,'.']);
 const hash=sha(archive);copyFileSync(archive,join(output,basename(archive)));writeFileSync(join(output,basename(archive)+'.sha256'),`${hash}  ${basename(archive)}\n`);
 Object.assign(manifest,{status:values['skip-checks']?'UNVERIFIED':'PASS',completedAt:new Date().toISOString(),buildIdentity:release.buildIdentity,archive:basename(archive),sha256:hash,bytes:lstatSync(archive).size,repositories:release.repositories,profile:{executionMode:'live',clickhouseImage:values['clickhouse-image']??'package default',imageVerification:'destination host required'},files:inventory.length});
 save();console.log(JSON.stringify({status:manifest.status,output,archive:join(output,basename(archive)),sha256:hash,manifest:join(output,'delivery.json')},null,2));
}catch(error){Object.assign(manifest,{status:'FAIL',completedAt:new Date().toISOString(),error:error instanceof Error?error.message:String(error)});save();console.error(`Joint release failed. See ${join(output,'delivery.json')}`);process.exitCode=1;}
finally{rmSync(temp,{recursive:true,force:true});}
