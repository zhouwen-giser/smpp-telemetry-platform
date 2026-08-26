import { readFile } from "node:fs/promises";

export interface QueryResult {
  data: Record<string, unknown>[];
}
export interface DiagnosticStore {
  queryJson(sql: string): Promise<QueryResult>;
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
  async queryJson(sql: string): Promise<QueryResult> {
    const headers: Record<string, string> = {};
    if (this.user)
      headers["authorization"] =
        `Basic ${Buffer.from(`${this.user}:${this.password}`).toString("base64")}`;
    const response = await fetch(
      `${this.url}/?query=${encodeURIComponent(sql + " FORMAT JSON")}`,
      {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!response.ok) throw new Error(`CLICKHOUSE_${response.status}`);
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
      throw new Error("CLICKHOUSE_RESPONSE_INVALID");
    return { data: value.data as Record<string, unknown>[] };
  }
}
export function sqlString(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}
