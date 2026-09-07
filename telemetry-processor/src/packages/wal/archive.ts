import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, openSync, readSync, closeSync } from 'node:fs';
import { copyFile, mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
export async function fsyncDirectory(path:string):Promise<void>{const dir=await open(path,'r');try{await dir.sync();}finally{await dir.close();}}
export async function durableMkdir(path:string):Promise<void>{const first=await mkdir(path,{recursive:true});if(first===undefined)return;const boundary=dirname(resolve(first));let current=resolve(path);for(;;){await fsyncDirectory(current);if(current===boundary)break;const parent=dirname(current);if(parent===current)break;current=parent;}}
export async function fileSha256(path:string):Promise<string>{const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex');}
export function fileSha256Sync(path:string):string{const hash=createHash('sha256'),file=openSync(path,'r'),buffer=Buffer.allocUnsafe(64*1024);try{for(;;){const size=readSync(file,buffer,0,buffer.length,null);if(size===0)return hash.digest('hex');hash.update(buffer.subarray(0,size));}}finally{closeSync(file);}}
export type ArchiveBoundary='copied'|'file_synced'|'renamed'|'directory_synced';
export async function archiveSegment(source:string,directory:string,name:string,onBoundary?:(phase:ArchiveBoundary)=>Promise<void>):Promise<{path:string;hash:string;bytes:number}>{
  await durableMkdir(directory);await fsyncDirectory(directory);
  const destination=join(directory,name),temp=join(directory,`.${name}.${randomUUID()}.tmp`);
  const sourceHash=await fileSha256(source),bytes=(await stat(source)).size;
  try{
    try{await stat(destination);if(await fileSha256(destination)!==sourceHash)throw new Error('WAL_ARCHIVE_CONFLICT');return{path:destination,hash:sourceHash,bytes};}
    catch(error){if(!(error&&typeof error==='object'&&'code'in error&&error.code==='ENOENT'))throw error;}
    await copyFile(source,temp);await onBoundary?.('copied');const file=await open(temp,'r+');try{await file.sync();}finally{await file.close();}await onBoundary?.('file_synced');
    if((await stat(temp)).size!==bytes||await fileSha256(temp)!==sourceHash)throw new Error('WAL_ARCHIVE_VERIFY_FAILED');
    await rename(temp,destination);await onBoundary?.('renamed');await fsyncDirectory(directory);await onBoundary?.('directory_synced');return{path:destination,hash:sourceHash,bytes};
  }finally{await unlink(temp).catch(()=>{});}
}
