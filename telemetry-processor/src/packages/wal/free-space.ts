import { statfs } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export type WalFilesystemProbe=(path:string)=>Promise<{availableBytes:number}>;
const defaultProbe:WalFilesystemProbe=async path=>{
  let current=resolve(path);
  for(;;){
    try{const info=await statfs(current);return{availableBytes:Number(info.bavail)*Number(info.bsize)};}
    catch(error){const parent=dirname(current);if(parent===current||!(error&&typeof error==='object'&&'code'in error&&error.code==='ENOENT'))throw error;current=parent;}
  }
};

/** Admission threshold, not a reservation guaranteeing all future control transactions. */
export class WalFreeSpace {
  private walBytes:number|null=null;
  private archiveBytes:number|null=null;
  private sampledAt:number|null=null;
  private lastError:string|null=null;
  private debitedBytes=0;
  private inFlight:Promise<void>|undefined;
  private timer:ReturnType<typeof setInterval>|undefined;
  constructor(private walPath:string,private archivePath:string,readonly minFreeBytes:number,private sampleMs=1000,private probe:WalFilesystemProbe=defaultProbe){
    if(!Number.isSafeInteger(minFreeBytes)||minFreeBytes<0)throw new Error('WAL_DISK_RESERVE_INVALID');
    if(!Number.isSafeInteger(sampleMs)||sampleMs<1)throw new Error('WAL_SPACE_SAMPLE_INTERVAL_INVALID');
  }
  async start():Promise<void>{await this.sample(true);this.timer=setInterval(()=>{void this.sample();},this.sampleMs);this.timer.unref();}
  private sample(force=false):Promise<void>{
    if(this.inFlight)return this.inFlight;
    if(!force&&this.sampledAt!==null&&Date.now()-this.sampledAt<this.sampleMs)return Promise.resolve();
    const debitedAtStart=this.debitedBytes;
    this.inFlight=(async()=>{
      try{
        const[wal,archive]=await Promise.all([this.probe(this.walPath),this.probe(this.archivePath)]);
        if(!Number.isFinite(wal.availableBytes)||wal.availableBytes<0||!Number.isFinite(archive.availableBytes)||archive.availableBytes<0)throw new Error('WAL_SPACE_PROBE_INVALID');
        this.walBytes=Math.max(0,wal.availableBytes-(this.debitedBytes-debitedAtStart));this.archiveBytes=archive.availableBytes;this.lastError=null;
      }catch(error){this.walBytes=null;this.archiveBytes=null;this.lastError=error instanceof Error?error.message:String(error);}
      this.sampledAt=Date.now();
    })().finally(()=>{this.inFlight=undefined;});
    return this.inFlight;
  }
  private insufficient(frameBytes=0):boolean{return this.minFreeBytes>0&&(this.walBytes===null||this.archiveBytes===null||this.walBytes<this.minFreeBytes+frameBytes||this.archiveBytes<this.minFreeBytes);}
  async assertWritable(frameBytes:number):Promise<void>{
    if(this.minFreeBytes===0)return;
    await this.sample();if(this.insufficient(frameBytes))await this.sample(true);
    if(this.insufficient(frameBytes))throw Object.assign(new Error('WAL_DISK_RESERVE_REQUIRED'),{statusCode:503,retryable:true,...(this.lastError?{cause:new Error(this.lastError)}:{})});
  }
  consume(bytes:number):void{this.debitedBytes+=bytes;if(this.walBytes!==null)this.walBytes=Math.max(0,this.walBytes-bytes);}
  stats(){return{walFreeBytes:this.walBytes,archiveFreeBytes:this.archiveBytes,freeSpaceSampledAt:this.sampledAt===null?null:new Date(this.sampledAt).toISOString(),minFreeBytes:this.minFreeBytes,diskReserveRequired:this.insufficient()};}
  async close():Promise<void>{if(this.timer)clearInterval(this.timer);this.timer=undefined;await this.inFlight;}
}
