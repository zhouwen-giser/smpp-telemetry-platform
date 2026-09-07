// Opt-in harness: only an isolated project and test databases; never starts Runtime/Adapter.
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parseEnv } from "node:util";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { catalog, template, validate } from "./catalog.mjs";
import { generate } from "./compose.mjs";

const root = resolve(import.meta.dirname, "../.."),
  smpp = resolve(root, "../sdar-mcp-provider-platform");
// Check source types before build; load the compiled implementation only when running.
/** @type {typeof import('../../telemetry-processor/src/packages/projection/sdar-shared-warehouse-projection.js')} */
const projection = await import(new URL('../../dist/telemetry-processor/src/packages/projection/sdar-shared-warehouse-projection.js', import.meta.url).href);
/** @type {typeof import('../../telemetry-processor/test/helpers.js')} */
const helpers = await import(new URL('../../dist/telemetry-processor/test/helpers.js', import.meta.url).href);
const { SDAR_TARGET_SCHEMAS } = projection;
const { envelope } = helpers;
const state = mkdtempSync(resolve(root, "artifacts/joint-development/verify-"));
const project = `joint-verify-${randomUUID().slice(0, 8)}`;
const specs = catalog(smpp),
  env = validate(
    {
      ...parseEnv(template(specs)),
      DEPLOY_PROJECT: project,
      SHARED__URL: "http://shared-test:8123",
      SHARED__USER: "default",
      SHARED__PASSWORD: "isolated-test-only",
      CLICKHOUSE__PASSWORD: "isolated-test-only",
    },
    specs,
  );
const compose = generate(env, { smpp, telemetry: root, state, envDir: state });
for (const name of ["runtime", "adapter"]) {
  const svc = structuredClone(compose.services[name]);
  delete svc.build;
  delete svc.ports;
  delete svc.healthcheck;
  svc.image = `smpp-joint-verification-${name}:development`;
  svc.restart = "no";
  svc.depends_on = { [`${name}-db`]: { condition: "service_healthy" } };
  svc.command = [
    "node",
    `dist/apps/${name === "runtime" ? "runtime" : "ugv-provider-adapter"}/src/migrate.js`,
  ];
  compose.services[`migration-${name}`] = svc;
  compose.services["query-api"].depends_on[`migration-${name}`] = {
    condition: "service_completed_successfully",
  };
  delete compose.services[name];
}
compose.services["shared-test"] = structuredClone(compose.services.clickhouse);
compose.services["shared-test"].volumes = [
  "shared-test-data:/var/lib/clickhouse",
  ...compose.services.clickhouse.volumes.filter((v) => typeof v !== "string"),
];
compose.volumes["shared-test-data"] = {};
for (const service of Object.values(compose.services)) {
  if (service.build) {
    delete service.build;
    service.image = "smpp-joint-verification-telemetry:development";
  }
  if (service.ports)
    service.ports = service.ports.map(
      (p) => `127.0.0.1::${p.split(":").at(-1)}`,
    );
}
const file = resolve(state, "compose.json");
writeFileSync(file, JSON.stringify(compose, null, 2), { mode: 0o600 });
const base = ["compose", "-f", file];
const docker = (args, options = {}) => {
  const r = spawnSync("docker", args, {
    encoding: "utf8",
    timeout: 240000,
    ...options,
  });
  if (r.status !== 0)
    throw Error(
      `DOCKER_FAILED ${args.slice(0, 2).join(" ")} ${r.stderr?.slice(-1500)}`,
    );
  return r.stdout;
};
const sql = (query, service = "shared-test") =>
  docker(
    [
      ...base,
      "exec",
      "-T",
      service,
      "clickhouse-client",
      "--password",
      "isolated-test-only",
      "--multiquery",
    ],
    { input: query },
  );
const port = (name, p) => docker([...base, "port", name, String(p)]).trim();
const wait = async (fn) => {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fn();
      if (r) return r;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw Error("WAIT_TIMEOUT");
};
let evidence = {
  project,
  state,
  architecture: docker(["info", "--format", "{{.Architecture}}"]).trim(),
  controlsExecuted: 0,
};
try {
  docker([...base, "config", "--quiet"]);
  docker([...base, "up", "-d", "--wait", "clickhouse", "shared-test"]);
  const ddl = ["CREATE DATABASE sdar_core", "CREATE DATABASE sdar_meta"];
  for (const [table, columns] of Object.entries(SDAR_TARGET_SCHEMAS))
    ddl.push(
      `CREATE TABLE ${table} (${columns.map(([n, t]) => `${n} ${t}`).join(",")}) ENGINE=ReplacingMergeTree ORDER BY ${table.endsWith("external_provider_fact") ? "fact_id" : "relation_id"}`,
    );
  ddl.push(
    "CREATE VIEW sdar_meta.v_schema_contract_release_current AS SELECT '1.5.1-rc.2' AS release_version, '00..26' AS migration_range, 'sha256:1610cf2a4cc9450193dd70abf7a516f0ea4792099ed0f34dcf2fad44d094b335' AS release_descriptor_hash, 'sha256:78da6e9e511b7714b15a4f6ef5f2ba54578880493e2aa264f433ff1595a1d7b8' AS schema_contract_hash",
  );
  for (const view of [
    "v_smpp_provider_task_timeline",
    "v_smpp_resource_current_state",
    "v_smpp_resource_current_health",
    "v_smpp_execution_latest_progress",
    "v_sdar_smpp_task_reconciliation",
    "v_sdar_smpp_execution_topology",
  ])
    ddl.push(`CREATE VIEW sdar_core.${view} AS SELECT 1`);
  // Schema fixture DDL only, on our newly created labeled container. No direct INSERT facts.
  sql(ddl.join(";\n"));
  docker([...base, "up", "-d", "--wait", "--wait-timeout", "180"]);
  const processor = `http://${port("telemetry-processor", 8443)}`,
    collector = `http://${port("otel-collector", 4318)}`,
    query = `http://${port("query-api", 8088)}`;
  await wait(
    async () => (await fetch(`http://${port("otel-collector", 13133)}/`)).ok,
  );
  await wait(
    async () => (await fetch(`http://${port("grafana", 3000)}/api/health`)).ok,
  );
  for (const table of [
    "external_provider_fact",
    "external_entity_relation_fact",
  ])
    assert.equal(
      sql(`CHECK GRANT SELECT, INSERT ON sdar_core.${table}`).trim(),
      "1",
    );
  const record = envelope({
    recordId: randomUUID(),
    providerId: env.RUNTIME__PROVIDER_ID,
    instanceId: env.RUNTIME__RUNTIME_INSTANCE_ID,
    taskId: randomUUID(),
    occurredAt: new Date().toISOString(),
    emittedAt: new Date().toISOString(),
  });
  const any = (v) =>
    v === null
      ? {}
      : typeof v === "string"
        ? { stringValue: v }
        : typeof v === "boolean"
          ? { boolValue: v }
          : typeof v === "number"
            ? { doubleValue: v }
            : Array.isArray(v)
              ? { arrayValue: { values: v.map(any) } }
              : {
                  kvlistValue: {
                    values: Object.entries(v).map(([key, value]) => ({
                      key,
                      value: any(value),
                    })),
                  },
                };
  const attrs = {
    "sdar.schema.name": record.schemaName,
    "sdar.schema.version": record.schemaVersion,
    "sdar.record.id": record.recordId,
    "sdar.record.hash": record.recordHash,
  };
  const request = {
    resourceLogs: [
      {
        resource: { attributes: [] },
        scopeLogs: [
          {
            scope: { name: "isolated-joint-fixture" },
            logRecords: [
              {
                body: any(record),
                attributes: Object.entries(attrs).map(([key, value]) => ({
                  key,
                  value: any(value),
                })),
              },
            ],
          },
        ],
      },
    ],
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch(collector + "/v1/logs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    assert.equal(r.status, 200, await r.text());
  }
  const ready = await wait(async () => {
    const r = await fetch(processor + "/health/ready"),
      v = await r.json();
    return r.ok && v.targets.every((t) => t.pending === 0 && !t.lastError)
      ? v
      : null;
  });
  const count = await wait(() => {
    const n = Number(
      sql(
        `SELECT count() FROM sdar_core.external_provider_fact WHERE source_record_id='${record.recordId}'`,
      ),
    );
    return n > 0 ? n : null;
  });
  assert.equal(count, 1);
  const landing = Number(
    sql(
      `SELECT count() FROM telemetry_landing.smpp_provider_ops_v1 WHERE source_record_id='${record.recordId}'`,
      "clickhouse",
    ),
  );
  assert.equal(landing, 1);
  for (const path of [
    "/health",
    "/api/v1/events",
    "/api/v1/data-quality/summary",
    "/api/v1/projections/watermarks",
    `/api/v1/tasks/${record.taskId}/current-authority?externalExecutionId=none`,
  ])
    assert.equal((await fetch(query + path)).status, 200, path);
  for (const path of [
    "/health/live",
    "/health/ready",
    "/metrics",
    "/debug/wal",
    "/debug/checkpoints",
    "/debug/targets",
  ])
    assert.equal((await fetch(processor + path)).status, 200, path);
  evidence = {
    ...evidence,
    recordId: record.recordId,
    collectorAck: 200,
    sharedFactCount: count,
    landingCount: landing,
    targets: ready.targets,
  };
  docker([...base, "down"]);
  docker([...base, "up", "-d", "--wait", "--wait-timeout", "180"]);
  assert.equal(
    Number(
      sql(
        `SELECT count() FROM sdar_core.external_provider_fact WHERE source_record_id='${record.recordId}'`,
      ),
    ),
    1,
  );
  await wait(async () => {
    const r = await fetch(
      `http://${port("telemetry-processor", 8443)}/health/ready`,
    );
    const v = await r.json();
    return (
      r.ok &&
      v.targets.every(
        (t) =>
          t.pending === 0 &&
          !t.lastError &&
          t.checkpoint.offsetEnd >= ready.targets[0].checkpoint.offsetEnd,
      )
    );
  });
  evidence.restartPreserved = true;
  evidence.status = "PASS";
} catch (error) {
  evidence.status = "FAIL";
  evidence.error = error.message;
  writeFileSync(
    resolve(state, "failure.log"),
    docker([...base, "logs", "--tail", "80"]),
  );
  throw error;
} finally {
  writeFileSync(
    resolve(state, "evidence.json"),
    JSON.stringify(evidence, null, 2),
  );
  docker([...base, "down"]);
  console.log(JSON.stringify(evidence));
}
