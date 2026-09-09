#!/usr/bin/env python3
"""Add telemetry source and lifecycle entrypoints to an intact upstream union."""
import re,argparse,hashlib,io,json,pathlib,subprocess,tarfile,tempfile,gzip,os
ROOT=pathlib.Path(__file__).resolve().parents[2]
def sha(b):return hashlib.sha256(b).hexdigest()
def members(data):
 with tarfile.open(fileobj=io.BytesIO(data),mode='r:gz') as t:
  out={}
  for m in t:
   p=pathlib.PurePosixPath(m.name)
   if p.is_absolute() or '..' in p.parts or '\\' in m.name or not(m.isfile() or m.isdir()):raise ValueError('UNSAFE_ARCHIVE')
   if m.isfile():
    if m.name in out:raise ValueError('DUPLICATE_ARCHIVE_MEMBER')
    out[m.name]=t.extractfile(m).read()
  return out
def archive(files):
 out=io.BytesIO()
 with gzip.GzipFile(fileobj=out,filename='',mode='wb',mtime=0) as gz,tarfile.open(fileobj=gz,mode='w') as t:
  for name,data in sorted(files.items()):
   m=tarfile.TarInfo(name);m.size=len(data);m.mode=0o644;m.mtime=0;t.addfile(m,io.BytesIO(data))
 return out.getvalue()
def main():
 p=argparse.ArgumentParser();p.add_argument('--upstream',required=True,type=pathlib.Path);p.add_argument('--output',type=pathlib.Path,default=ROOT/'artifacts/united-telemetry');p.add_argument('--sdar-schema',type=pathlib.Path);p.add_argument('--sdar-release',type=pathlib.Path);a=p.parse_args()
 if bool(a.sdar_schema)!=bool(a.sdar_release):p.error('--sdar-schema and --sdar-release must be supplied together')
 data=a.upstream.read_bytes();expected=pathlib.Path(str(a.upstream)+'.sha256').read_text().split();assert len(expected)==2 and expected[0]==sha(data) and expected[1].lstrip('*')==a.upstream.name,'UPSTREAM_HASH_MISMATCH'
 upstream=members(data);roots={k.split('/')[0] for k in upstream};assert len(roots)==1;prefix=roots.pop();u=json.loads(upstream[prefix+'/UNION.json'])
 for line in upstream[prefix+'/SHA256SUMS'].decode().splitlines():
  h,n=line.split('  ',1);assert sha(upstream[prefix+'/'+n])==h,'UPSTREAM_INVENTORY_MISMATCH'
 assert sha(upstream[prefix+'/upstream/smpp.tar.gz'])==u['smpp']['sha256']
 paths=set(subprocess.check_output(['git','ls-files','-z','--cached','--others','--exclude-standard'],cwd=ROOT).decode().split('\0'))-{''};files={}
 blocked={'.git','.codex','.agents','artifacts','node_modules','dist','.joint-state','state','secrets','vendor','coverage','__pycache__'}
 for name in sorted(paths):
  pp=pathlib.PurePosixPath(name)
  if blocked.intersection(pp.parts) or (name.startswith('reports/') and name!='reports/smpp-stable-integration/SMPP_TELEMETRY_SOURCE_CAPTURE.json') or (pp.name.startswith('.env') and pp.name!='.env.example') or pp.suffix in {'.key','.pem','.p12','.pfx','.log','.gz','.zip','.db','.sqlite','.pyc'}:continue
  f=ROOT/name
  if not f.exists():continue
  if f.is_symlink() or not f.is_file():raise ValueError('NON_REGULAR_SOURCE:'+name)
  b=f.read_bytes()
  if re.search(rb'^-----BEGIN (?:OPENSSH |RSA |EC )?PRIVATE KEY-----$',b,re.M):raise ValueError('PRIVATE_KEY_REFUSED')
  files[name]=b
 source=archive(files);revision=subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT).decode().strip()+'-worktree-'+sha(source)[:12]
 manifest={'schemaVersion':1,'upstream':{'archive':a.upstream.name,'sha256':sha(data),'root':prefix,'smppRevision':u['smpp']['revision'],'baseSourceSha256':u['baseSourceSha256']},'telemetry':{'sha256':sha(source),'revision':revision,'files':len(files)},'storage':{'business':'existing GOWM, unchanged','telemetry':'standalone ClickHouse; optional SDAR ClickHouse authority requires explicit configuration'},'executionMode':'live'}
 if a.sdar_schema:
  schema=a.sdar_schema.read_bytes();definition=json.loads(schema);assert definition['version']==1 and definition['objects'];manifest['sdarSchema']={'sha256':sha(schema),'objects':len(definition['objects']),'source':definition['source']};manifest['storage']['telemetry']='standalone ClickHouse plus managed SDAR ClickHouse; Authority enabled'
 if a.sdar_release:manifest['sdarSchema']['releaseSeed']={'sha256':sha(a.sdar_release.read_bytes()),'source':'smpp-arm64-dev:smpp-remediation-e1-arm64-20260907-shared-test-1:sdar_meta.v_schema_contract_release_current'}
 content={'UNION.json':json.dumps(manifest,indent=2).encode()+b'\n','upstream/smpp-united.tar.gz':data,'upstream/telemetry.tar.gz':source}
 if a.sdar_schema:
  content['sdar/schema.json']=schema;content['sdar/schema-contract-release.jsonl']=a.sdar_release.read_bytes()
 for name in ['deploy.mjs','deploy.sh','extract.py','README.md']:content[name]=(ROOT/'deploy/united-telemetry'/name).read_bytes()
 content['SHA256SUMS']=''.join(f'{sha(v)}  {k}\n' for k,v in sorted(content.items())).encode()
 name='smpp-gowm-gdps-gsap-telemetry-'+sha(content['UNION.json'])[:16];blob=archive({name+'/'+k:v for k,v in content.items()});a.output.mkdir(parents=True,exist_ok=True);target=a.output/(name+'.tar.gz')
 with target.open('xb') as f:f.write(blob)
 pathlib.Path(str(target)+'.sha256').write_text(f'{sha(blob)}  {target.name}\n');pathlib.Path(str(target)+'.json').write_text(json.dumps(manifest,indent=2)+'\n');print(json.dumps({'archive':str(target),'sha256':sha(blob),'revision':revision}))
if __name__=='__main__':main()
