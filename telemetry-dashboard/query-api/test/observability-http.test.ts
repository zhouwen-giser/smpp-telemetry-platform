import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createQueryServer } from "../src/server.js";

test("anonymous diagnostics are bounded, typed and retain source fields; SQL injection never reaches store", async () => {
  const queries: string[] = [];
  const row = {
    TraceId: "a".repeat(32),
    SpanId: "b".repeat(16),
    ResourceAttributes: {
      "service.instance.id": "real-instance",
      "telemetry.collection.protocol": "otlp",
    },
  };
  const server = createQueryServer({
    client: {
      queryJson: (sql) => {
        queries.push(sql);
        return Promise.resolve({ data: [row, row] });
      },
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    for (const path of [
      "/api/v1/metrics?type=sum&limit=1",
      "/api/v1/traces?limit=1",
      `/api/v1/traces/${"a".repeat(32)}?limit=1`,
    ]) {
      const response = await fetch(base + path);
      assert.equal(response.status, 200);
      const body = (await response.json()) as {
        data: unknown[];
        nextOffset: number;
        retentionDays: number;
      };
      assert.deepEqual(body.data, [row]);
      assert.equal(body.nextOffset, 1);
      assert.equal(body.retentionDays, 7);
    }
    const before = queries.length;
    for (const path of [
      "/api/v1/metrics?type=DROP",
      "/api/v1/traces?limit=1001",
      "/api/v1/traces/invalid",
    ])
      assert.equal((await fetch(base + path)).status, 400);
    assert.equal(queries.length, before);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("diagnostic storage failure returns a stable 503 without leaking SQL or credentials", async () => {
  const server = createQueryServer({
    client: {
      queryJson: () => Promise.reject(new Error("private SQL/password")),
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/v1/metrics`,
    );
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: "DIAGNOSTIC_STORE_UNAVAILABLE",
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
