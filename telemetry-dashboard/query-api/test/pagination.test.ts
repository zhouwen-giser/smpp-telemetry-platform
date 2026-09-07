import test from "node:test";
import assert from "node:assert/strict";
import { CursorCodec, PageRequestError, requestFingerprint } from "../src/cursor.js";
import { createPagination } from "../src/pagination.js";
import { scopedEntityUrn } from "../src/scope.js";
import { authorityScope } from "./query-fixtures.js";

const url = (path: string) => new URL(path, "http://query");
const key = "simulation-query-cursor-key-32-bytes-minimum";

test("cursor integrity, request binding and expiration are enforced", () => {
  let now = 100;
  const codec = new CursorCodec(key, () => now), fingerprint = requestFingerprint({ route: "events", tenant: "one" });
  const token = codec.encode({ version: 1, fingerprint, mode: "best_known", expiresAt: 200, last: ["2026-09-07T00:00:00.000Z", "record-1", 1, "a".repeat(64)] });
  assert.equal(codec.decode(token, fingerprint).last[1], "record-1");
  assert.throws(() => codec.decode("x" + token, fingerprint), (error: unknown) => error instanceof PageRequestError && error.code === "CURSOR_INVALID");
  assert.throws(() => codec.decode(token, requestFingerprint({ route: "relations" })), /CURSOR_QUERY_MISMATCH/u);
  now = 201; assert.throws(() => codec.decode(token, fingerprint), (error: unknown) => error instanceof PageRequestError && error.statusCode === 410);
});

test("legacy pagination is explicit, bounded, half-open, and preserves a stable next-page tuple", async () => {
  const seen: string[] = [];
  let count = 0;
  const page = createPagination({ cursorKey: key, client: { queryJson: async (sql) => {
    seen.push(sql); count++;
    return { data: count === 1 ? [1, 2, 3].map((i) => ({ source_record_id: `record-${i}`, __sort_time: "2026-09-07 00:00:00.000", __logical_id: `record-${i}`, __revision_version: 1, __revision_key: String(i).repeat(64) })) : [] };
  } } });
  const path = "/api/v1/events?limit=2&order=asc&from=2026-09-07&to=2026-09-08";
  const first = await page(url(path)); assert.ok(first); assert.equal(first.completeness, "legacy_best_known"); assert.equal(first.hasMore, true); assert.equal((first.data as unknown[]).length, 2);
  assert.match(seen[0]!, /occurred_at>=parseDateTime64BestEffort/u); assert.match(seen[0]!, /occurred_at<parseDateTime64BestEffort/u); assert.match(seen[0]!, /LIMIT 3$/u);
  const next = await page(url(path + "&cursor=" + encodeURIComponent(String(first.nextCursor)))); assert.equal(next?.hasMore, false);
  assert.match(seen[1]!, /tuple\(__sort_time,__logical_id,__revision_version,__revision_key\) >/u); assert.ok(seen[1]?.includes("record-2"));
  await assert.rejects(page(url(path.replace("limit=2", "limit=3") + "&cursor=" + encodeURIComponent(String(first.nextCursor)))), /CURSOR_QUERY_MISMATCH/u);
});

test("every paginated route validates request shape and prevents unsupported legacy scope from being ignored", async () => {
  const seen: string[] = [];
  const page = createPagination({ client: { queryJson: async (sql) => { seen.push(sql); return { data: [] }; } } });
  const urn = encodeURIComponent(scopedEntityUrn(authorityScope, "task", "task-1"));
  for (const path of ["/api/v1/events", `/api/v1/tasks/${urn}/timeline`, `/api/v1/tasks/${urn}/relations`, "/api/v1/topology/sdar-smpp"]) {
    const value = await page(url(path + "?limit=25&order=desc")); assert.ok(value); assert.match(seen.at(-1)!, /LIMIT 26$/u);
    for (const suffix of ["?limit=1001", "?limit=2&limit=3", "?order=evil", "?from=2026-02-30", "?from=2026-09-08&to=2026-09-07"]) await assert.rejects(page(url(path + suffix)), PageRequestError);
  }
  await assert.rejects(page(url(`/api/v1/tasks/${urn}/relations?deploymentId=other`)), /LEGACY_SCOPE_UNAVAILABLE/u);
  await assert.rejects(page(url("/api/v1/events?consistency=snapshot")), /SNAPSHOT_DISABLED/u);
  assert.equal(await page(url("/api/v1/records/smpp/one")), undefined);
});

test("missing, stale, legacy and retired snapshot metadata never promise a complete snapshot", async () => {
  const now = Date.parse("2026-09-07T00:00:00Z"), base = { target_id: "standalone-smpp", generation: "g1", wal_epoch: "w1", ingest_through: "0", publication_through: "0", published_revision_count: "0", retention_policy_epoch: "r1", lifecycle_status: "active", readable_until: new Date(now + 600000).toISOString(), progress_observed_at: new Date(now).toISOString(), legacy_coverage: 0 };
  for (const [row, code] of [[undefined, "SNAPSHOT_NOT_READY"], [{ ...base, progress_observed_at: "2026-09-06T00:00:00Z" }, "SNAPSHOT_PROGRESS_STALE"], [{ ...base, legacy_coverage: 1 }, "SNAPSHOT_LEGACY_COVERAGE"], [{ ...base, lifecycle_status: "retired" }, "SNAPSHOT_RETIRED"]] as const) {
    const page = createPagination({ snapshotEnabled: true, now: () => now, client: { queryJson: async () => ({ data: row ? [row] : [] }) } });
    await assert.rejects(page(url("/api/v1/events?consistency=snapshot")), new RegExp(code));
  }
});
