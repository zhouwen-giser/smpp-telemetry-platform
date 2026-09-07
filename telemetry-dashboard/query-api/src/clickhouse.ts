import { readFile } from "node:fs/promises";

export interface QueryResult {
  data: Record<string, unknown>[];
}
export interface DiagnosticStore {
  queryJson(sql: string, options?: { signal?: AbortSignal }): Promise<QueryResult>;
}
export class QueryStoreError extends Error {
  constructor(readonly reason: "CONNECTION_FAILED" | "ACCESS_DENIED" | "SCHEMA_UNAVAILABLE" | "STORE_TIMEOUT" | "INVALID_RESPONSE") { super(reason); }
}
export class QueryClient implements DiagnosticStore {
  private readonly url: string;
  private readonly user: string;
  private password: string;
  private readonly passwordFile: string;
  constructor({
    url,
    user = "default",
    password = "",
    passwordFile = "",
  }: {
    url: string;
    user?: string;
    password?: string;
    passwordFile?: string;
  }) {
    this.url = url.replace(/\/$/u, "");
    this.user = user;
    this.password = password;
    this.passwordFile = passwordFile;
  }
  async initialize(): Promise<void> {
    if (this.passwordFile)
      this.password = (await readFile(this.passwordFile, "utf8")).trim();
  }
  async queryJson(sql: string, options: { signal?: AbortSignal } = {}): Promise<QueryResult> {
    const headers: Record<string, string> = {};
    if (this.user)
      headers["authorization"] =
        `Basic ${Buffer.from(`${this.user}:${this.password}`).toString("base64")}`;
    let response: Response;
    try { response = await fetch(
      `${this.url}/?query=${encodeURIComponent(sql + " FORMAT JSON")}`,
      {
        method: "POST",
        headers,
        signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
      },
    ); } catch (error) {
      throw new QueryStoreError(options.signal?.aborted || (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) ? "STORE_TIMEOUT" : "CONNECTION_FAILED");
    }
    if (!response.ok) {
      // ClickHouse emits only a numeric exception code into diagnostics, never its body.
      const code = Number(response.headers.get("x-clickhouse-exception-code"));
      await response.body?.cancel();
      throw new QueryStoreError([401, 403].includes(response.status) || [497, 516].includes(code) ? "ACCESS_DENIED" : [16, 47, 60, 81].includes(code) ? "SCHEMA_UNAVAILABLE" : "CONNECTION_FAILED");
    }
    const value: unknown = await response.json();
    if (
      typeof value !== "object" ||
      value === null ||
      !("data" in value) ||
      !Array.isArray(value.data) ||
      !value.data.every(
        (row: unknown) =>
          typeof row === "object" && row !== null && !Array.isArray(row),
      )
    )
      throw new QueryStoreError("INVALID_RESPONSE");
    return { data: value.data as Record<string, unknown>[] };
  }
}
export function sqlString(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}
