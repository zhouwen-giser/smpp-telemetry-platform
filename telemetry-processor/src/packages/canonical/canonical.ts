import { createHash } from 'node:crypto';

export function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new TypeError('Canonical JSON numbers must be finite'); return JSON.stringify(value); }
  if (Array.isArray(value)) return `[${value.map(canonicalizeJson).join(',')}]`;
  if (typeof value !== 'object') throw new TypeError('Value is outside the JSON data model');
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => {
    if (object[key] === undefined) throw new TypeError('Canonical JSON cannot contain undefined');
    return `${JSON.stringify(key)}:${canonicalizeJson(object[key])}`;
  }).join(',')}}`;
}
export function sha256Canonical(value: unknown): string { return createHash('sha256').update(canonicalizeJson(value), 'utf8').digest('hex'); }
export function calculateProviderOpsRecordHash(envelope: Record<string, unknown>): string {
  const excluded = new Set(['recordHash', 'emittedAt', 'instanceId', 'exportRetryCount', 'collectorTimestamp', 'exporterHost']);
  return sha256Canonical(Object.fromEntries(Object.entries(envelope).filter(([key]) => !excluded.has(key))));
}
const UUID_NAMESPACE = Buffer.from('6ba7b8109dad11d180b400c04fd430c8', 'hex');
export function uuidV5(name: string, namespace = UUID_NAMESPACE): string {
  const hash = createHash('sha1').update(namespace).update(String(name), 'utf8').digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50; hash[8] = (hash[8]! & 0x3f) | 0x80;
  const h = hash.subarray(0,16).toString('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`;
}
