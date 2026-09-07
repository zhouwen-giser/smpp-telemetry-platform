import type { DecodedOtlpLog, OtlpScope } from './otlp-types.js';
interface ParseState { offset: number }
type ProtobufField = { number: number; wire: 0; value: bigint } | { number: number; wire: 1 | 2 | 5; value: Buffer };
function varint(buffer: Buffer, state: ParseState): bigint {
  let value = 0n;
  let shift = 0n;
  while (state.offset < buffer.length) {
    const byte = buffer[state.offset++]!;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return value;
    shift += 7n;
    if (shift > 70n) throw new Error('PROTO_VARINT_TOO_LONG');
  }
  throw new Error('PROTO_TRUNCATED_VARINT');
}

function bytes(buffer: Buffer, state: ParseState): Buffer {
  const length = Number(varint(buffer, state));
  const end = state.offset + length;
  if (!Number.isSafeInteger(length) || end > buffer.length) throw new Error('PROTO_TRUNCATED_BYTES');
  const value = buffer.subarray(state.offset, end);
  state.offset = end;
  return value;
}

function field(buffer: Buffer, state: ParseState): ProtobufField {
  const tag = Number(varint(buffer, state));
  const number = tag >>> 3;
  const wire = tag & 7;
  if (number === 0) throw new Error('PROTO_INVALID_FIELD');
  if (wire === 0) return { number, wire, value: varint(buffer, state) };
  if (wire === 1) {
    if (state.offset + 8 > buffer.length) throw new Error('PROTO_TRUNCATED_FIXED64');
    const value = buffer.subarray(state.offset, state.offset + 8); state.offset += 8;
    return { number, wire, value };
  }
  if (wire === 2) return { number, wire, value: bytes(buffer, state) };
  if (wire === 5) {
    if (state.offset + 4 > buffer.length) throw new Error('PROTO_TRUNCATED_FIXED32');
    const value = buffer.subarray(state.offset, state.offset + 4); state.offset += 4;
    return { number, wire, value };
  }
  throw new Error(`PROTO_UNSUPPORTED_WIRE_${wire}`);
}

function parseMessage(buffer: Buffer, handler: (field: ProtobufField) => void): void {
  const state = { offset: 0 };
  while (state.offset < buffer.length) handler(field(buffer, state));
}

function decodeAnyValue(buffer: Buffer): unknown {
  let output: unknown = null;
  parseMessage(buffer, (f) => {
    if (f.number === 1 && f.wire === 2) output = f.value.toString('utf8');
    else if (f.number === 2 && f.wire === 0) output = f.value !== 0n;
    else if (f.number === 3 && f.wire === 0) {
      const signed = BigInt.asIntN(64, f.value);
      const n = Number(signed); output = Number.isSafeInteger(n) ? n : signed.toString();
    } else if (f.number === 4 && f.wire === 1) output = f.value.readDoubleLE(0);
    else if (f.number === 5 && f.wire === 2) output = decodeArrayValue(f.value);
    else if (f.number === 6 && f.wire === 2) output = decodeKeyValueList(f.value);
    else if (f.number === 7 && f.wire === 2) output = f.value.toString('base64');
  });
  return output;
}

function decodeArrayValue(buffer: Buffer): unknown[] {
  const values: unknown[] = [];
  parseMessage(buffer, (f) => { if (f.number === 1 && f.wire === 2) values.push(decodeAnyValue(f.value)); });
  return values;
}

function decodeKeyValue(buffer: Buffer): [string, unknown] {
  let key = ''; let value: unknown = null;
  parseMessage(buffer, (f) => {
    if (f.number === 1 && f.wire === 2) key = f.value.toString('utf8');
    else if (f.number === 2 && f.wire === 2) value = decodeAnyValue(f.value);
  });
  return [key, value];
}

function decodeKeyValueList(buffer: Buffer): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  parseMessage(buffer, (f) => { if (f.number === 1 && f.wire === 2) { const [k, v] = decodeKeyValue(f.value); output[k] = v; } });
  return output;
}

function decodeAttributes(buffer: Buffer): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  parseMessage(buffer, (f) => { if (f.number === 1 && f.wire === 2) { const [k, v] = decodeKeyValue(f.value); output[k] = v; } });
  return output;
}

function fixed64ToString(value: Buffer): string { return value.readBigUInt64LE(0).toString(); }

function decodeLogRecord(buffer: Buffer, resource: Record<string, unknown>, scope: OtlpScope): DecodedOtlpLog {
  const output: DecodedOtlpLog = { resource, scope, eventName: '', body: null, attributes: {}, timeUnixNano: '0', traceId: '', spanId: '' };
  parseMessage(buffer, (f) => {
    if (f.number === 1 && f.wire === 1) output.timeUnixNano = fixed64ToString(f.value);
    else if (f.number === 5 && f.wire === 2) output.body = decodeAnyValue(f.value);
    else if (f.number === 6 && f.wire === 2) { const [k, v] = decodeKeyValue(f.value); output.attributes[k] = v; }
    else if (f.number === 9 && f.wire === 2) output.traceId = f.value.toString('hex');
    else if (f.number === 10 && f.wire === 2) output.spanId = f.value.toString('hex');
    else if (f.number === 12 && f.wire === 2) output.eventName = f.value.toString('utf8');
  });
  return output;
}

function decodeScope(buffer: Buffer): OtlpScope {
  const output = { name: '', version: '' };
  parseMessage(buffer, (f) => {
    if (f.number === 1 && f.wire === 2) output.name = f.value.toString('utf8');
    else if (f.number === 2 && f.wire === 2) output.version = f.value.toString('utf8');
  });
  return output;
}

function decodeScopeLogs(buffer: Buffer, resource: Record<string, unknown>): DecodedOtlpLog[] {
  let scope = { name: '', version: '' }; const recordBuffers: Buffer[] = [];
  parseMessage(buffer, (f) => {
    if (f.number === 1 && f.wire === 2) scope = decodeScope(f.value);
    else if (f.number === 2 && f.wire === 2) recordBuffers.push(f.value);
  });
  return recordBuffers.map((record) => decodeLogRecord(record, resource, scope));
}

function decodeResource(buffer: Buffer): Record<string, unknown> { return decodeAttributes(buffer); }

function decodeResourceLogs(buffer: Buffer): DecodedOtlpLog[] {
  let resource: Record<string, unknown> = {}; const scopes: Buffer[] = [];
  parseMessage(buffer, (f) => {
    if (f.number === 1 && f.wire === 2) resource = decodeResource(f.value);
    else if (f.number === 2 && f.wire === 2) scopes.push(f.value);
  });
  return scopes.flatMap((scope) => decodeScopeLogs(scope, resource));
}

export function decodeOtlpProtobuf(buffer: Buffer): DecodedOtlpLog[] {
  const records: DecodedOtlpLog[] = [];
  parseMessage(buffer, (f) => { if (f.number === 1 && f.wire === 2) records.push(...decodeResourceLogs(f.value)); });
  return records;
}

export function encodePartialSuccess(rejected: number, message = ''): Buffer {
  const pushVarint = (n: number): Buffer => { let v = BigInt(n); const out=[]; do { let b=Number(v & 0x7fn); v >>= 7n; if(v) b|=0x80; out.push(b); } while(v); return Buffer.from(out); };
  const field1 = Buffer.concat([Buffer.from([0x08]), pushVarint(rejected)]);
  const msg = Buffer.from(message, 'utf8');
  const field2 = msg.length ? Buffer.concat([Buffer.from([0x12]), pushVarint(msg.length), msg]) : Buffer.alloc(0);
  const nested = Buffer.concat([field1, field2]);
  return Buffer.concat([Buffer.from([0x0a]), pushVarint(nested.length), nested]);
}
