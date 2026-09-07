import test from "node:test";
import assert from "node:assert/strict";
import { createQueryServer } from "../src/server.js";
import { authorityScope } from "./query-fixtures.js";
test("ordinary queries use standalone; current authority exclusively uses shared", async () => {
  const local: string[] = [],
    shared: string[] = [];
  const server = createQueryServer({
    authorityDefaultScope: authorityScope,
    client: {
      queryJson: async (sql) => {
        local.push(sql);
        return { data: [] };
      },
    },
    authorityClient: {
      queryJson: async (sql) => {
        shared.push(sql);
        return { data: [] };
      },
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw Error("address");
    const base = `http://127.0.0.1:${address.port}`;
    assert.equal((await fetch(base + "/api/v1/events")).status, 200);
    assert.equal(
      (
        await fetch(
          base +
            "/api/v1/tasks/task/current-authority?externalExecutionId=exec",
          // Scope is explicit so the data reads themselves remain exactly two queries.
        )
      ).status,
      200,
    );
    assert.equal(local.length, 1);
    assert.match(local[0]!, /telemetry_serving/);
    assert.equal(shared.length, 2);
    assert.ok(shared.every((sql) => sql.includes("sdar_core.")));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
