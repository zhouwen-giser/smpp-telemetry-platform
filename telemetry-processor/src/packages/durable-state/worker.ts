import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData, type MessagePort } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { IndexedFrame, SegmentState, StateOperation } from './types.js';
import { buildStateScanQuery } from './scan-query.js';

const data = workerData as { path: string; syncPort: MessagePort; signal: SharedArrayBuffer };
const signal = new Int32Array(data.signal);
// Keep this inode permanently: SQLite's OS advisory lock works across PID namespaces
// and is automatically released when a worker/process exits, including SIGKILL.
const lease=new DatabaseSync(join(dirname(data.path),'owner.sqlite'));
try{lease.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; CREATE TABLE IF NOT EXISTS owner(singleton INTEGER PRIMARY KEY); BEGIN EXCLUSIVE;');}
catch(error){lease.close();if(error instanceof Error&&/locked|busy/i.test(error.message))throw new Error('WAL_DIRECTORY_ALREADY_OPEN');throw error;}
const db = new DatabaseSync(data.path);
db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
  CREATE TABLE IF NOT EXISTS state_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS state_kv(namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(namespace,key)) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS state_namespace_usage(namespace TEXT PRIMARY KEY,bytes INTEGER NOT NULL,entries INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS wal_frames(sequence INTEGER PRIMARY KEY, segment INTEGER NOT NULL, offset INTEGER NOT NULL, offset_end INTEGER NOT NULL, crc INTEGER NOT NULL, kind TEXT NOT NULL, UNIQUE(segment,offset_end));
  CREATE INDEX IF NOT EXISTS wal_frames_position ON wal_frames(segment,offset_end);
  CREATE TABLE IF NOT EXISTS wal_frame_kind(sequence INTEGER PRIMARY KEY,kind TEXT NOT NULL,ordinal INTEGER NOT NULL);
  CREATE UNIQUE INDEX IF NOT EXISTS wal_kind_ordinal ON wal_frame_kind(kind,ordinal);
  CREATE INDEX IF NOT EXISTS wal_kind_position ON wal_frame_kind(kind,sequence);
  CREATE TABLE IF NOT EXISTS wal_segments(segment INTEGER PRIMARY KEY, bytes INTEGER NOT NULL DEFAULT 0, indexed_through INTEGER NOT NULL DEFAULT 0, first_sequence INTEGER NOT NULL DEFAULT 0, last_sequence INTEGER NOT NULL DEFAULT 0, closed INTEGER NOT NULL DEFAULT 0, archive_path TEXT, archive_hash TEXT, gc_state TEXT NOT NULL DEFAULT 'hot');`);
const integrity = db.prepare('PRAGMA quick_check').get();
if (integrity === undefined || Object.values(integrity)[0] !== 'ok') throw new Error('WAL_STATE_INTEGRITY_FAILED');
db.prepare('INSERT OR IGNORE INTO state_meta VALUES (?,?)').run('walEpoch', randomUUID());
db.prepare('INSERT OR IGNORE INTO state_meta VALUES (?,?)').run('version', '2');
if (db.prepare('SELECT value FROM state_meta WHERE key=?').get('version')?.value !== '2') throw new Error('WAL_STATE_VERSION_UNSUPPORTED');
if(Number(db.prepare('SELECT coalesce(max(sequence),0) AS n FROM wal_frames').get()?.n)>Number(db.prepare('SELECT coalesce(max(sequence),0) AS n FROM wal_frame_kind').get()?.n))db.exec('INSERT OR IGNORE INTO wal_frame_kind(sequence,kind,ordinal) SELECT sequence,kind,row_number() OVER(PARTITION BY kind ORDER BY sequence) FROM wal_frames');
if(db.prepare('SELECT value FROM state_meta WHERE key=?').get('namespaceUsage')?.value!=='1'){
  db.exec("BEGIN IMMEDIATE; DELETE FROM state_namespace_usage; INSERT INTO state_namespace_usage SELECT namespace,sum(length(CAST(value AS BLOB))),count(*) FROM state_kv GROUP BY namespace; INSERT OR REPLACE INTO state_meta VALUES ('namespaceUsage','1'); COMMIT;");
}

function get(namespace: string, key: string): unknown {
  const row = db.prepare('SELECT value FROM state_kv WHERE namespace=? AND key=?').get(namespace,key);
  return row === undefined ? undefined : JSON.parse(String(row.value));
}
function operation(op: StateOperation): unknown {
  if (typeof op.namespace !== 'string' || !op.namespace || typeof op.key !== 'string') throw new Error('STATE_KEY_INVALID');
  switch (op.type) {
    case 'put': {
      const value = JSON.stringify(op.value);
      if (value === undefined) throw new Error('STATE_VALUE_INVALID');
      const prior=db.prepare('SELECT length(CAST(value AS BLOB)) AS bytes FROM state_kv WHERE namespace=? AND key=?').get(op.namespace,op.key);
      db.prepare('INSERT INTO state_kv VALUES (?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value').run(op.namespace,op.key,value);
      db.prepare('INSERT INTO state_namespace_usage VALUES (?,?,?) ON CONFLICT(namespace) DO UPDATE SET bytes=bytes+excluded.bytes,entries=entries+excluded.entries').run(op.namespace,Buffer.byteLength(value)-Number(prior?.bytes??0),prior===undefined?1:0);
      return null;
    }
    case 'delete': {const prior=db.prepare('SELECT length(CAST(value AS BLOB)) AS bytes FROM state_kv WHERE namespace=? AND key=?').get(op.namespace,op.key);db.prepare('DELETE FROM state_kv WHERE namespace=? AND key=?').run(op.namespace,op.key);if(prior)db.prepare('UPDATE state_namespace_usage SET bytes=bytes-?,entries=entries-1 WHERE namespace=?').run(Number(prior.bytes),op.namespace);return null;}
    case 'check': if (JSON.stringify(get(op.namespace,op.key) ?? null) !== JSON.stringify(op.expected)) throw new Error('STATE_COMPARE_FAILED'); return null;
    case 'increment': {
      const current = get(op.namespace,op.key) ?? 0;
      const next = Number(current) + (op.amount ?? 1);
      if (!Number.isSafeInteger(current) || !Number.isSafeInteger(next) || next < 0) throw new Error('STATE_COUNTER_INVALID');
      operation({type:'put',namespace:op.namespace,key:op.key,value:next}); return next;
    }
  }
}
function transaction<T>(fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const value = fn(); db.exec('COMMIT'); return value; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
const frame = (row: Record<string, unknown>): IndexedFrame => ({ingestSequence:Number(row.sequence),segment:Number(row.segment),offset:Number(row.offset),offsetEnd:Number(row.offset_end),crc:Number(row.crc),kind:String(row.kind)});
const segment = (row: Record<string, unknown>): SegmentState => ({segment:Number(row.segment),bytes:Number(row.bytes),indexedThrough:Number(row.indexed_through),firstSequence:Number(row.first_sequence),lastSequence:Number(row.last_sequence),closed:row.closed===1,archivePath:row.archive_path===null?null:String(row.archive_path),archiveHash:row.archive_hash===null?null:String(row.archive_hash),gcState:String(row.gc_state) as SegmentState['gcState']});
interface WorkerArguments {
  namespace:string;key:string;operations:StateOperation[];frame:IndexedFrame;segment:number;offsetEnd:number;
  segmentState:SegmentState;segments:number[];limit:number;prefix?:string;after?:string;
  afterSequence?:number;sequence:number;through?:number;kind?:string;
}
function dispatch(method: string, input: unknown): unknown {
  const args=input as WorkerArguments;
  switch(method) {
    case 'meta': return {walEpoch:db.prepare('SELECT value FROM state_meta WHERE key=?').get('walEpoch')?.value,version:2};
    case 'get': return get(args.namespace,args.key);
    case 'namespaceUsage': {const row=db.prepare('SELECT bytes,entries FROM state_namespace_usage WHERE namespace=?').get(args.namespace);return{bytes:Number(row?.bytes??0),entries:Number(row?.entries??0)};}
    case 'observeTarget': return transaction(()=>{
      if(get('target',args.key)===undefined&&get('observed_target',args.key)===undefined){
        operation({type:'put',namespace:'observed_target',key:args.key,value:{observedAt:new Date().toISOString()}});
        operation({type:'increment',namespace:'wal',key:'protectionRevision'});
      }
      return null;
    });
    case 'scan': {
      const query=buildStateScanQuery(args.namespace,{limit:args.limit,...(args.prefix===undefined?{}:{prefix:args.prefix}),...(args.after===undefined?{}:{after:args.after})});
      return db.prepare(query.sql).all(...query.bindings).map(row=>({key:String(row.key),value:JSON.parse(String(row.value))}));
    }
    case 'transaction': return transaction(()=> (args.operations as StateOperation[]).map(operation));
    case 'indexFrame': return transaction(()=>{
      const f = args.frame as IndexedFrame;
      const existing = db.prepare('SELECT * FROM wal_frames WHERE segment=? AND offset_end=?').get(f.segment,f.offsetEnd);
      if (existing !== undefined) {
        if (JSON.stringify(frame(existing)) !== JSON.stringify(f)) throw new Error('WAL_INDEX_FRAME_MISMATCH');
        return false;
      }
      const last = Number(db.prepare('SELECT coalesce(max(sequence),0) AS n FROM wal_frames').get()?.n);
      if (f.ingestSequence !== last + 1) throw new Error('WAL_INGEST_SEQUENCE_INVALID');
      db.prepare('INSERT INTO wal_frames VALUES (?,?,?,?,?,?)').run(f.ingestSequence,f.segment,f.offset,f.offsetEnd,f.crc,f.kind);
      const ordinal=Number(db.prepare('SELECT coalesce(max(ordinal),0)+1 AS n FROM wal_frame_kind WHERE kind=?').get(f.kind)?.n);
      db.prepare('INSERT INTO wal_frame_kind VALUES (?,?,?)').run(f.ingestSequence,f.kind,ordinal);
      db.prepare('INSERT INTO wal_segments(segment,bytes,indexed_through,first_sequence,last_sequence) VALUES (?,?,?,?,?) ON CONFLICT(segment) DO UPDATE SET bytes=excluded.bytes,indexed_through=excluded.indexed_through,first_sequence=CASE WHEN wal_segments.first_sequence=0 THEN excluded.first_sequence ELSE wal_segments.first_sequence END,last_sequence=excluded.last_sequence').run(f.segment,f.offsetEnd,f.offsetEnd,f.ingestSequence,f.ingestSequence);
      (args.operations as StateOperation[]).forEach(operation);
      return true;
    });
    case 'frameAt': { const row=db.prepare('SELECT * FROM wal_frames WHERE segment=? AND offset_end=?').get(args.segment,args.offsetEnd); return row===undefined?undefined:frame(row); }
    case 'framesAfter': {
      if (!Number.isSafeInteger(args.limit)||args.limit<1||args.limit>10000) throw new Error('WAL_READ_LIMIT_INVALID');
      return(args.kind===undefined?db.prepare('SELECT * FROM wal_frames WHERE sequence>? AND sequence<=? ORDER BY sequence LIMIT ?').all(args.sequence,args.through??Number.MAX_SAFE_INTEGER,args.limit):db.prepare('SELECT f.* FROM wal_frame_kind k JOIN wal_frames f ON f.sequence=k.sequence WHERE k.kind=? AND k.sequence>? AND k.sequence<=? ORDER BY k.sequence LIMIT ?').all(args.kind,args.sequence,args.through??Number.MAX_SAFE_INTEGER,args.limit)).map(frame);
    }
    case 'frameCount': {
      const after=Math.max(0,args.afterSequence??0),through=args.through??Number.MAX_SAFE_INTEGER;
      if(through<=after)return 0;
      if(args.kind===undefined){const maximum=Number(db.prepare('SELECT coalesce(max(sequence),0) AS n FROM wal_frames').get()?.n);return Math.max(0,Math.min(maximum,through)-Math.min(maximum,after));}
      const at=(position:number)=>Number(db.prepare('SELECT ordinal FROM wal_frame_kind WHERE kind=? AND sequence<=? ORDER BY sequence DESC LIMIT 1').get(args.kind!,position)?.ordinal??0);
      return at(through)-at(after);
    }
    case 'lastSequence': return Number(db.prepare('SELECT coalesce(max(sequence),0) AS n FROM wal_frames').get()?.n);
    case 'segments': return db.prepare('SELECT * FROM wal_segments ORDER BY segment').all().map(segment);
    case 'segment': {const row=db.prepare('SELECT * FROM wal_segments WHERE segment=?').get(args.segment);return row===undefined?undefined:segment(row);}
    case 'saveSegment': {
      const s=args.segmentState;
      db.prepare('INSERT INTO wal_segments VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(segment) DO UPDATE SET bytes=excluded.bytes,indexed_through=excluded.indexed_through,first_sequence=excluded.first_sequence,last_sequence=excluded.last_sequence,closed=excluded.closed,archive_path=excluded.archive_path,archive_hash=excluded.archive_hash,gc_state=excluded.gc_state').run(s.segment,s.bytes,s.indexedThrough,s.firstSequence,s.lastSequence,s.closed?1:0,s.archivePath,s.archiveHash,s.gcState);
      return null;
    }
    case 'gcPlan': return transaction(()=>{
      if(db.prepare("SELECT 1 FROM state_kv observed WHERE observed.namespace='observed_target' AND NOT EXISTS (SELECT 1 FROM state_kv registered WHERE registered.namespace='target' AND registered.key=observed.key) LIMIT 1").get())throw new Error('WAL_GC_TARGET_REGISTRY_INCOMPLETE');
      const segments=args.segments as number[];
      for(const id of segments) {
        const row=db.prepare('SELECT * FROM wal_segments WHERE segment=?').get(id);
        if(row===undefined||row.closed!==1||!row.archive_hash||!row.archive_path||row.bytes!==row.indexed_through)throw new Error('WAL_GC_SEGMENT_UNSAFE');
        db.prepare("UPDATE wal_segments SET gc_state='planned' WHERE segment=?").run(id);
      }
      (args.operations as StateOperation[]).forEach(operation);
      return null;
    });
    case 'close': db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.close();lease.exec('ROLLBACK');lease.close();return null;
    default: throw new Error('STATE_METHOD_UNKNOWN');
  }
}
type Request = {id:number;method:string;args:unknown};
function reply(request: Request, port: MessagePort, synchronous: boolean): void {
  try { port.postMessage({id:request.id,value:dispatch(request.method,request.args)}); }
  catch(error) { port.postMessage({id:request.id,error:error instanceof Error?error.message:String(error)}); }
  if(synchronous){Atomics.store(signal,0,1);Atomics.notify(signal,0);}
}
data.syncPort.on('message',(request:Request)=>reply(request,data.syncPort,true));
parentPort!.on('message',(request:Request)=>reply(request,parentPort!,false));
parentPort!.postMessage({ready:true});
