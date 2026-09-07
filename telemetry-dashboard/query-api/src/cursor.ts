import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export class PageRequestError extends Error {
  constructor(readonly code: string, readonly statusCode: 400 | 409 | 410 | 503 = 400) { super(code); }
}
export interface PageCursor {
  version: 1;
  fingerprint: string;
  mode: "snapshot" | "best_known";
  expiresAt: number;
  last: readonly [string, string, number, string];
  positionKind?: "event_time" | "publication_sequence";
  snapshot?: {
    targetId: string; generation: string; walEpoch: string; ingestThrough: string; publicationThrough: string;
    retentionPolicyEpoch: string; publishedRevisionCount: string;
  };
}
export const requestFingerprint = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export class CursorCodec {
  constructor(private readonly key: string, private readonly now: () => number = Date.now) {
    if (Buffer.byteLength(key) < 32) throw new Error("QUERY_CURSOR_KEY_TOO_SHORT");
  }
  encode(value: PageCursor): string {
    const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
    return payload + "." + createHmac("sha256", this.key).update(payload).digest("base64url");
  }
  decode(token: string, fingerprint: string): PageCursor {
    if (token.length > 8192 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(token)) throw new PageRequestError("CURSOR_INVALID");
    const [payload, signature] = token.split(".") as [string, string];
    const actual = Buffer.from(signature, "base64url"), expected = createHmac("sha256", this.key).update(payload).digest();
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new PageRequestError("CURSOR_INVALID");
    let value: unknown;
    try { value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { throw new PageRequestError("CURSOR_INVALID"); }
    if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1 || !("fingerprint" in value) || value.fingerprint !== fingerprint)
      throw new PageRequestError("CURSOR_QUERY_MISMATCH");
    const cursor = value as PageCursor;
    if (!["snapshot", "best_known"].includes(cursor.mode) || !Array.isArray(cursor.last) || cursor.last.length !== 4 ||
      typeof cursor.last[0] !== "string" || (cursor.positionKind === "publication_sequence" ? !/^(0|[1-9]\d{0,19})$/u.test(cursor.last[0]) : !Number.isFinite(Date.parse(cursor.last[0]))) || typeof cursor.last[1] !== "string" ||
      !Number.isSafeInteger(cursor.last[2]) || typeof cursor.last[3] !== "string" || !Number.isSafeInteger(cursor.expiresAt)) throw new PageRequestError("CURSOR_INVALID");
    if (cursor.expiresAt <= this.now()) throw new PageRequestError("CURSOR_EXPIRED", 410);
    return cursor;
  }
}
