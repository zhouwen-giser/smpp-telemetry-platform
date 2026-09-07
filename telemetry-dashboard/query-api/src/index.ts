import { readFile } from "node:fs/promises";
import { QueryClient } from "./clickhouse.js";
import { createQueryServer } from "./server.js";
import { validateAuthorityScope } from "./scope.js";
import { loadReaderRegistry } from "./reader-registry.js";
const configuredAuthorityEnabled = process.env.AUTHORITY_ENABLED;
if (configuredAuthorityEnabled !== undefined && !["true", "false"].includes(configuredAuthorityEnabled)) throw new Error("AUTHORITY_ENABLED_INVALID");
const authorityEnabled = configuredAuthorityEnabled === undefined ? Boolean(process.env.AUTHORITY_CLICKHOUSE_URL) : configuredAuthorityEnabled === "true";
const authorityDefaultScope = process.env.AUTHORITY_DEFAULT_SCOPE_JSON ? validateAuthorityScope(JSON.parse(process.env.AUTHORITY_DEFAULT_SCOPE_JSON)) : undefined;
const readerRegistry = process.env.QUERY_READER_REGISTRY_FILE ? await loadReaderRegistry(process.env.QUERY_READER_REGISTRY_FILE) : undefined;
const client = readerRegistry ? readerRegistry.clients[readerRegistry.registry.activeTargetId]! : new QueryClient({
  url: process.env.CLICKHOUSE_URL ?? "http://127.0.0.1:8123",
  user: process.env.CLICKHOUSE_USER ?? "default",
  password: process.env.CLICKHOUSE_PASSWORD ?? "",
  passwordFile: process.env.CLICKHOUSE_PASSWORD_FILE ?? "",
});
// Keep the legacy single-store configuration working when no shared endpoint is set.
const authorityClient = authorityEnabled && process.env.AUTHORITY_CLICKHOUSE_URL
  ? new QueryClient({
      url: process.env.AUTHORITY_CLICKHOUSE_URL,
      user: process.env.AUTHORITY_CLICKHOUSE_USER ?? "default",
      password: process.env.AUTHORITY_CLICKHOUSE_PASSWORD ?? "",
      passwordFile: process.env.AUTHORITY_CLICKHOUSE_PASSWORD_FILE ?? "",
    })
  : client;
await client.initialize();
if (authorityClient !== client) await authorityClient.initialize();
const apiKey = process.env.QUERY_API_KEY_FILE
  ? (await readFile(process.env.QUERY_API_KEY_FILE, "utf8")).trim()
  : (process.env.QUERY_API_KEY ?? "");
const cursorKey = process.env.QUERY_CURSOR_KEY_FILE ? (await readFile(process.env.QUERY_CURSOR_KEY_FILE, "utf8")).trim() : process.env.QUERY_CURSOR_KEY;
if (readerRegistry && !cursorKey) throw new Error("QUERY_READER_REGISTRY_REQUIRES_PERSISTENT_CURSOR_KEY");
if (process.env.QUERY_SNAPSHOTS_ENABLED !== undefined && !["true", "false"].includes(process.env.QUERY_SNAPSHOTS_ENABLED)) throw new Error("QUERY_SNAPSHOTS_ENABLED_INVALID");
const host = process.env.QUERY_API_HOST ?? "0.0.0.0";
const port = Number(process.env.QUERY_API_PORT ?? 8088);
createQueryServer({ client, authorityClient, apiKey, authorityEnabled,
  ...(authorityDefaultScope ? { authorityDefaultScope } : {}),
  readinessTimeoutMs: Number(process.env.QUERY_READINESS_TIMEOUT_MS ?? 2000),
  readinessCacheMs: Number(process.env.QUERY_READINESS_CACHE_MS ?? 1000),
  pagination: { ...(cursorKey ? { cursorKey } : {}), snapshotEnabled: process.env.QUERY_SNAPSHOTS_ENABLED === "true", snapshotTargetId: readerRegistry?.registry.activeTargetId ?? process.env.QUERY_SNAPSHOT_TARGET_ID ?? "standalone-smpp", ...(readerRegistry ? { snapshotReaders: readerRegistry.clients } : {}) },
}).listen(port, host, () =>
  console.log(
    JSON.stringify({ level: "info", message: "query_api_started", host, port }),
  ),
);
