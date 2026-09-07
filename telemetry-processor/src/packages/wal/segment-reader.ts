import { openSync, readSync, closeSync } from 'node:fs';
import { open, stat, truncate } from 'node:fs/promises';
import { crc32c } from './crc32c.js';

export const MAX_FRAME_BYTES=16*1024*1024;
export const segmentName=(id:number)=>`segment-${String(id).padStart(12,'0')}.wal`;
export interface RawFrame {offset:number;offsetEnd:number;crc:number;record:Record<string,unknown>}
function decode(frame:Buffer,offset:number):RawFrame{
  const length=frame.readUInt32BE(0),crc=frame.readUInt32BE(4+length),payload=frame.subarray(4,4+length);
  if(crc32c(payload)!==crc)throw new Error(`WAL_CRC_MISMATCH:${offset}`);
  let record:unknown;try{record=JSON.parse(payload.toString('utf8'));}catch{throw new Error(`WAL_FRAME_JSON_INVALID:${offset}`);}
  if(record===null||typeof record!=='object'||Array.isArray(record))throw new Error(`WAL_FRAME_RECORD_INVALID:${offset}`);
  return{offset,offsetEnd:offset+frame.length,crc,record:record as Record<string,unknown>};
}
export function readFrame(path:string,offset:number,offsetEnd:number):RawFrame{
  const size=offsetEnd-offset;if(size<8||size>MAX_FRAME_BYTES+8)throw new Error('WAL_FRAME_SIZE_INVALID');
  const file=openSync(path,'r');try{
    const frame=Buffer.allocUnsafe(size);let read=0;
    while(read<size){const n=readSync(file,frame,read,size-read,offset+read);if(n===0)throw new Error('WAL_INDEXED_FRAME_MISSING');read+=n;}
    if(frame.readUInt32BE(0)+8!==size)throw new Error('WAL_INDEXED_FRAME_MISMATCH');
    return decode(frame,offset);
  }finally{closeSync(file);}
}
/** Streams at most one frame at a time; only an unindexed open-segment tail may be repaired. */
export async function* scanFrames(path:string,start:number,repairPartialTail:boolean):AsyncGenerator<RawFrame>{
  const size=(await stat(path)).size;if(start>size)throw new Error('WAL_INDEXED_FRAME_MISSING');
  const file=await open(path,'r');let offset=start;
  try{while(offset<size){
    const header=Buffer.alloc(4);const {bytesRead}=await file.read(header,0,4,offset);
    if(bytesRead<4){if(!repairPartialTail)throw new Error('WAL_CLOSED_SEGMENT_TRUNCATED');await truncate(path,offset);const writable=await open(path,'r+');try{await writable.sync();}finally{await writable.close();}break;}
    const length=header.readUInt32BE(0);if(length>MAX_FRAME_BYTES)throw new Error(`WAL_FRAME_SIZE_INVALID:${offset}`);
    const end=offset+length+8;
    if(end>size){if(!repairPartialTail)throw new Error('WAL_CLOSED_SEGMENT_TRUNCATED');await truncate(path,offset);const writable=await open(path,'r+');try{await writable.sync();}finally{await writable.close();}break;}
    const frame=Buffer.allocUnsafe(length+8);header.copy(frame);let read=4;
    while(read<frame.length){const part=await file.read(frame,read,frame.length-read,offset+read);if(part.bytesRead===0)throw new Error('WAL_FRAME_TRUNCATED');read+=part.bytesRead;}
    const decoded=decode(frame,offset);yield decoded;offset=end;
  }}finally{await file.close();}
}
