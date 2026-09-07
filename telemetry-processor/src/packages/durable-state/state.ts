import { Worker, MessageChannel, receiveMessageOnPort, type MessagePort } from 'node:worker_threads';
import type { IndexedFrame, SegmentState, StateItem, StateOperation, StateScanOptions } from './types.js';
export type { StateItem, StateOperation, StateScanOptions } from './types.js';

/** The worker owns the only SQLite connection. Bounded point reads retain the legacy synchronous WAL API. */
export class DurableState {
  private worker: Worker;
  private port: MessagePort;
  private signal = new Int32Array(new SharedArrayBuffer(4));
  private requests = new Map<number,{resolve:(value:unknown)=>void;reject:(error:Error)=>void}>();
  private counter = 0;
  private closed = false;
  private failure: Error | undefined;
  readonly ready: Promise<void>;
  constructor(path: string) {
    const channel=new MessageChannel();this.port=channel.port1;
    const env={...process.env};delete env.NODE_TEST_CONTEXT;
    this.worker=new Worker(new URL('./worker.js',import.meta.url),{workerData:{path,syncPort:channel.port2,signal:this.signal.buffer},transferList:[channel.port2],execArgv:process.execArgv.filter(arg=>!arg.startsWith('--input-type')),env});
    this.ready=new Promise((resolve,reject)=>{
      this.worker.on('message',(message:{ready?:boolean;id:number;value?:unknown;error?:string})=>{
        if(message.ready){resolve();if(this.requests.size===0)this.worker.unref();return;}
        const request=this.requests.get(message.id);if(!request)return;this.requests.delete(message.id);
        if(message.error)request.reject(new Error(message.error));else request.resolve(message.value);
        if(this.requests.size===0)this.worker.unref();
      });
      this.worker.on('error',(error:Error)=>{this.failure=error;reject(error);for(const request of this.requests.values())request.reject(error);this.requests.clear();});
      this.worker.on('exit',(code)=>{if(!this.closed){const error=new Error(`WAL_STATE_WORKER_EXIT:${code}`);this.failure=error;reject(error);for(const request of this.requests.values())request.reject(error);this.requests.clear();}});
    });
    this.port.unref();
  }
  private assertOpen(){if(this.closed)throw new Error('WAL_STATE_CLOSED');if(this.failure)throw this.failure;}
  private sync<T>(method:string,args:unknown={}):T{
    this.assertOpen();const id=++this.counter;Atomics.store(this.signal,0,0);this.port.postMessage({id,method,args});
    const deadline=Date.now()+30000;
    while(Date.now()<deadline){
      const response=receiveMessageOnPort(this.port)?.message as {id:number;value:T;error?:string}|undefined;
      if(response){if(response.id!==id)throw new Error('WAL_STATE_RPC_ORDER_INVALID');if(response.error)throw new Error(response.error);return response.value;}
      // Keep the notification set until its MessagePort payload is visible. Resetting
      // here can lose a wakeup when delivery and the atomic signal race.
      Atomics.wait(this.signal,0,0,100);
    }
    this.failure=new Error('WAL_STATE_RPC_TIMEOUT');throw this.failure;
  }
  private async request<T>(method:string,args:unknown={}):Promise<T>{
    this.assertOpen();await this.ready;this.assertOpen();const id=++this.counter;this.worker.ref();
    return new Promise<unknown>((resolve,reject)=>{this.requests.set(id,{resolve,reject});this.worker.postMessage({id,method,args});}) as Promise<T>;
  }
  meta():{walEpoch:string;version:number}{return this.sync('meta');}
  get<T=unknown>(namespace:string,key:string):T|undefined{return this.sync('get',{namespace,key});}
  getAsync<T=unknown>(namespace:string,key:string):Promise<T|undefined>{return this.request('get',{namespace,key});}
  metaAsync():Promise<{walEpoch:string;version:number}>{return this.request('meta');}
  namespaceUsage(namespace:string):{bytes:number;entries:number}{return this.sync('namespaceUsage',{namespace});}
  observeTarget(id:string):void{this.sync('observeTarget',{key:id});}
  scan<T=unknown>(namespace:string,options:StateScanOptions={}):StateItem<T>[]{return this.sync('scan',{namespace,...options});}
  transaction(operations:StateOperation[]):Promise<unknown[]>{return this.request('transaction',{operations});}
  async put(namespace:string,key:string,value:unknown):Promise<void>{await this.transaction([{type:'put',namespace,key,value}]);}
  async delete(namespace:string,key:string):Promise<void>{await this.transaction([{type:'delete',namespace,key}]);}
  indexFrame(frame:IndexedFrame,operations:StateOperation[]):Promise<boolean>{return this.request('indexFrame',{frame,operations});}
  frameAt(segment:number,offsetEnd:number):IndexedFrame|undefined{return this.sync('frameAt',{segment,offsetEnd});}
  framesAfter(sequence:number,limit=200,through?:number,kind?:string):IndexedFrame[]{return this.sync('framesAfter',{sequence,limit,through,kind});}
  frameCount(after=0,through?:number,kind?:string):number{return this.sync('frameCount',{afterSequence:after,through,kind});}
  lastSequence():number{return this.sync('lastSequence');}
  lastSequenceAsync():Promise<number>{return this.request('lastSequence');}
  segments():SegmentState[]{return this.sync('segments');}
  segment(segment:number):SegmentState|undefined{return this.sync('segment',{segment});}
  segmentAsync(segment:number):Promise<SegmentState|undefined>{return this.request('segment',{segment});}
  saveSegment(segment:SegmentState):Promise<void>{return this.request('saveSegment',{segmentState:segment});}
  planGc(segments:number[],operations:StateOperation[]):Promise<void>{return this.request('gcPlan',{segments,operations});}
  async close():Promise<void>{if(this.closed)return;await this.request('close');this.closed=true;this.port.close();await this.worker.terminate();}
}
