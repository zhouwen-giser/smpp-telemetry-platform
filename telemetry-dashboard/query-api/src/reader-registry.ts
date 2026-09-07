import { readFile } from "node:fs/promises";
import { QueryClient } from "./clickhouse.js";

export interface ReaderConnection { url: string; user?: string; password?: string; passwordFile?: string }
export interface ReaderRegistry {
  version: 1;
  revision: number;
  activeTargetId: string;
  readers: Record<string, ReaderConnection>;
}
export function validateReaderRegistry(input: unknown): ReaderRegistry {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("QUERY_READER_REGISTRY_INVALID");
  const value = input as Record<string, unknown>;
  if (value.version !== 1 || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1 || typeof value.activeTargetId !== "string" || !value.readers || typeof value.readers !== "object" || Array.isArray(value.readers)) throw new Error("QUERY_READER_REGISTRY_INVALID");
  const entries = Object.entries(value.readers);
  if (entries.length < 1 || entries.length > 16) throw new Error("QUERY_READER_REGISTRY_INVALID");
  for (const [targetId, connection] of entries) {
    if (!/^[A-Za-z0-9_.:-]{1,128}$/u.test(targetId) || !connection || typeof connection !== "object" || Array.isArray(connection)) throw new Error("QUERY_READER_REGISTRY_INVALID");
    const row = connection as Record<string, unknown>;
    if (typeof row.url !== "string" || !["http:", "https:"].includes(new URL(row.url).protocol) || Object.keys(row).some((key) => !["url", "user", "password", "passwordFile"].includes(key)) || Object.values(row).some((field) => typeof field !== "string")) throw new Error("QUERY_READER_REGISTRY_INVALID");
    if (row.password && row.passwordFile) throw new Error("QUERY_READER_CREDENTIAL_AMBIGUOUS");
  }
  if (!Object.hasOwn(value.readers, value.activeTargetId)) throw new Error("QUERY_READER_REGISTRY_INVALID");
  return structuredClone(value) as unknown as ReaderRegistry;
}
export async function loadReaderRegistry(path: string): Promise<{ registry: ReaderRegistry; clients: Record<string, QueryClient> }> {
  const registry = validateReaderRegistry(JSON.parse(await readFile(path, "utf8")));
  const clients: Record<string, QueryClient> = Object.create(null) as Record<string, QueryClient>;
  await Promise.all(Object.entries(registry.readers).map(async ([targetId, connection]) => { const client = new QueryClient(connection); await client.initialize(); clients[targetId] = client; }));
  return { registry, clients };
}
