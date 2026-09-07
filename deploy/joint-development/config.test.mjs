import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { parseEnv } from "node:util";
import { catalog, template, validate } from "./catalog.mjs";
import { generate } from "./compose.mjs";
const telemetry = resolve(import.meta.dirname, "../.."),
  smpp = resolve(telemetry, "../sdar-mcp-provider-platform");
const specs = catalog(smpp);
function fixture(changes = {}) {
  const state = mkdtempSync(resolve(tmpdir(), "smpp-joint-config-"));
  const env = validate(
    {
      ...parseEnv(template(specs)),
      SHARED__URL: "http://shared-test.invalid:8123",
      SHARED__PASSWORD: "test-only",
      ...changes,
    },
    specs,
  );
  return {
    state,
    env,
    compose: generate(env, { smpp, telemetry, state, envDir: state }),
  };
}
test("template exactly matches current provider schemas and telemetry configuration readers", () => {
  assert.equal(
    readFileSync(resolve(import.meta.dirname, ".env.example"), "utf8"),
    template(specs),
  );
  for (const [prefix, path] of [
    ["PROCESSOR", "telemetry-processor/src/packages/config/config.ts"],
    ["QUERY", "telemetry-dashboard/query-api/src/index.ts"],
  ]) {
    const code = readFileSync(resolve(telemetry, path), "utf8");
    const names = new Set(
      [...code.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]),
    );
    if (prefix === "PROCESSOR")
      for (const m of code.matchAll(
        /(?:int|positiveInt|bool|secretValue)\('([A-Z][A-Z0-9_]*)'/g,
      ))
        names.add(m[1]);
    for (const name of names)
      assert.ok(specs[`${prefix}__${name}`], `${prefix}__${name} missing`);
  }
});
test("all host interfaces published; runtime and durable identities map to both targets", () => {
  const { compose, state } = fixture();
  assert.equal(
    Object.values(compose.services).flatMap((s) => s.ports ?? []).length,
    15,
  );
  const mappings = JSON.parse(
    readFileSync(resolve(state, "config/source-mappings.json"), "utf8"),
  ).mappings;
  assert.equal(mappings.length, 2);
  assert.ok(
    mappings.some((m) => m.instanceId === "smpp-runtime-postgres-authority"),
  );
  assert.ok(
    mappings.every(
      (m) => m.policyVersion === 2 && m.projectionRouteIds.length === 2,
    ),
  );
  assert.equal(compose.services.runtime.environment.OTEL_ENABLED, "true");
  assert.equal(
    compose.services.adapter.environment.PROVIDER_TELEMETRY_ENDPOINT,
    "runtime:7002",
  );
  assert.equal(
    compose.services["query-api"].environment.CLICKHOUSE_URL,
    "http://clickhouse:8123",
  );
  assert.equal(
    compose.services["query-api"].environment.AUTHORITY_CLICKHOUSE_URL,
    "http://shared-test.invalid:8123",
  );
});
test("reject unknown, empty, invalid number, conflicting ports and identities", () => {
  for (const values of [
    { TYPO: "x" },
    { SOURCE_ID: "" },
    { PORT_MCP: "65536" },
    { PORT_MCP: "1.5" },
    { DEPLOY_DEV_NO_AUTH: "yes" },
  ])
    assert.throws(() => validate(values, specs));
  assert.throws(() => fixture({ PORT_MCP: "4318" }), /DUPLICATE_HOST_PORT/);
  assert.throws(
    () => fixture({ RUNTIME__RUNTIME_INSTANCE_ID: "different" }),
    /INSTANCE_ID_MISMATCH/,
  );
});
test("custom ports, literal dollars and host environment pollution", () => {
  const old = process.env.PORT_MCP;
  process.env.PORT_MCP = "6666";
  try {
    const { compose } = fixture({
      PORT_MCP: "29100",
      PROCESSOR__PROCESSOR_PORT: "9443",
      ADAPTER__ADAPTER_PORT: "7011",
      RUNTIME__DATABASE_URL:
        "postgresql://ugv_runtime:p%24ss@runtime-db:5432/ugv_runtime",
    });
    assert.match(compose.services.runtime.ports[0], /:29100:8080$/);
    assert.equal(
      compose.services.runtime.environment.ADAPTER_ENDPOINT,
      "adapter:7011",
    );
    assert.equal(
      compose.services["runtime-db"].environment.POSTGRES_PASSWORD,
      "p$$ss",
    );
    assert.match(
      compose.services["telemetry-processor"].ports[0],
      /:8443:9443$/,
    );
  } finally {
    if (old === undefined) delete process.env.PORT_MCP;
    else process.env.PORT_MCP = old;
  }
});
test("secrets file wins and generated passwords survive regeneration", () => {
  const { state, env } = fixture();
  const password = readFileSync(
    resolve(state, "clickhouse-password.secret"),
    "utf8",
  );
  writeFileSync(resolve(state, "input-password"), "from-file-$literal");
  generate(
    { ...env, SHARED__PASSWORD_FILE: "input-password" },
    { smpp, telemetry, state, envDir: state },
  );
  assert.equal(
    readFileSync(resolve(state, "shared-password.secret"), "utf8"),
    "from-file-$literal",
  );
  assert.equal(
    readFileSync(resolve(state, "clickhouse-password.secret"), "utf8"),
    password,
  );
  assert.equal(statSync(state).mode & 0o777, 0o700);
});
test("development no-auth is explicit and incompatible keys fail", () => {
  assert.throws(() => fixture({ DEPLOY_DEV_NO_AUTH: "false" }), /AUTH_MODE/);
  assert.throws(
    () => fixture({ PROCESSOR__PROCESSOR_ADMIN_API_KEY: "key" }),
    /NO_AUTH_KEY_CONFLICT/,
  );
  for (const stage of [
    "development_debug",
    "integration_candidate",
    "qualification",
  ]) {
    const { compose } = fixture({ DEPLOY_STAGE: stage });
    assert.equal(
      compose.services.adapter.environment.UGV_DELIVERY_STAGE,
      stage,
    );
  }
});

test("query password override does not change migration credentials; file paths are mounted", () => {
  const { compose } = fixture({
    QUERY__CLICKHOUSE_PASSWORD: "query-only",
    QUERY__AUTHORITY_CLICKHOUSE_PASSWORD: "shared-query-only",
  });
  assert.equal(
    compose.services["query-api"].environment.CLICKHOUSE_PASSWORD_FILE,
    "",
  );
  assert.equal(
    compose.services["query-api"].environment
      .AUTHORITY_CLICKHOUSE_PASSWORD_FILE,
    "",
  );
  assert.equal(
    compose.services["telemetry-migrate"].environment.CLICKHOUSE_PASSWORD_FILE,
    "/run/secrets/local-password",
  );
});

test("boolean spellings normalize and Collector identity mismatches fail early", () => {
  assert.equal(
    validate({ DEPLOY_DEV_NO_AUTH: "1" }, specs).DEPLOY_DEV_NO_AUTH,
    "true",
  );
  assert.throws(
    () => fixture({ PROCESSOR__PROCESSOR_ALLOWED_COLLECTOR_IDS: "unrelated" }),
    /COLLECTOR_ID_MISMATCH/,
  );
  assert.throws(
    () => fixture({ RUNTIME__AUTH_MODE: "jwt_hs256" }),
    /NO_AUTH_RUNTIME_MODE_CONFLICT/,
  );
});

test("advanced writer targets preserve independent endpoints and mount their real password files", () => {
  const { env, state } = fixture();
  const targets = JSON.parse(readFileSync(resolve(state, 'config/projection-targets.json'), 'utf8'));
  targets.targets[1].connection = { url: 'http://independent-writer.invalid:8123', user: 'writer-only', passwordFile: 'writer.secret' };
  writeFileSync(resolve(state, 'writer.secret'), 'writer-test-only');
  writeFileSync(resolve(state, 'advanced-targets.json'), JSON.stringify(targets));
  const compose = generate({ ...env, PROCESSOR__PROJECTION_TARGETS_FILE: 'advanced-targets.json', QUERY__AUTHORITY_CLICKHOUSE_URL: 'http://readonly-replica.invalid:8123' }, { smpp, telemetry, state, envDir: state });
  const rewritten = JSON.parse(readFileSync(resolve(state,'config/projection-targets.json'),'utf8'));
  assert.equal(rewritten.targets[1].connection.url, 'http://independent-writer.invalid:8123');
  assert.equal(rewritten.targets[1].connection.passwordFile, '/run/config/target-sdar-warehouse-shadow-password');
  assert.ok(compose.services['telemetry-processor'].volumes.some(v=>typeof v !== 'string' && v.target === '/run/config/target-sdar-warehouse-shadow-password'));
  assert.equal(compose.services['query-api'].environment.AUTHORITY_CLICKHOUSE_URL,'http://readonly-replica.invalid:8123');
});

test("generated diagnostics use persisted ClickHouse metrics, distinct platform scrape and actual ready health", () => {
  const { compose, state } = fixture({ PROCESSOR__PROCESSOR_PORT: '9443', QUERY__QUERY_API_PORT:'9088' });
  const collector = readFileSync(resolve(state,'config/collector.yaml'),'utf8');
  assert.match(collector, /targets: \["telemetry-processor:9443"\]/);
  assert.match(collector, /targets: \["query-api:9088"\]/);
  assert.match(collector, /storage: file_storage\/diagnostics/);
  assert.match(compose.services['query-api'].healthcheck.test.at(-1), /health\/ready/);
  assert.ok(compose.services.grafana.environment.ALERT_WAL_BYTES);
});

test("snapshot configuration requires a matching published writer", () => {
  const { compose, state, env } = fixture({ QUERY__QUERY_SNAPSHOTS_ENABLED:'true' });
  const target=JSON.parse(readFileSync(resolve(state,'config/projection-targets.json'),'utf8')).targets[0];
  assert.equal(target.snapshotEnabled,true);
  assert.equal(compose.services['query-api'].environment.QUERY_SNAPSHOT_TARGET_ID,target.targetId);
  assert.throws(()=>generate({...env,QUERY__QUERY_SNAPSHOT_TARGET_ID:'missing'},{smpp,telemetry,state,envDir:state}),/QUERY_SNAPSHOT_WRITER_TARGET_MISMATCH/);
});

test("WAL maintenance scalar configuration reaches Processor and replay registry is mounted", () => {
  const { env, state }=fixture();writeFileSync(resolve(state,'replays.json'),'[]');
  const compose=generate({...env,PROCESSOR__WAL_CACHE_MAX_BYTES:'1048576',PROCESSOR__WAL_GC_ENABLED:'true',PROCESSOR__WAL_MAINTENANCE_INTERVAL_MS:'12000',PROCESSOR__REPLAY_TARGETS_FILE:'replays.json'},{smpp,telemetry,state,envDir:state});
  const svc=compose.services['telemetry-processor'];assert.equal(svc.environment.WAL_CACHE_MAX_BYTES,'1048576');assert.equal(svc.environment.WAL_GC_ENABLED,'true');assert.equal(svc.environment.WAL_MAINTENANCE_INTERVAL_MS,'12000');assert.equal(svc.environment.REPLAY_TARGETS_FILE,'/run/config/replay_targets_file');assert.ok(svc.volumes.some(v=>typeof v !== 'string' && v.target===svc.environment.REPLAY_TARGETS_FILE));
});

test("migrators share a persistent lock volume within the same deployment", () => {
  const {compose}=fixture();const migration=compose.services['telemetry-migrate'];
  assert.equal(migration.environment.MIGRATION_LOCK_FILE,'/var/lib/smpp-telemetry/migrations/migration.sqlite');
  assert.ok(migration.volumes.includes('migration-state:/var/lib/smpp-telemetry/migrations'));
  assert.ok(Object.hasOwn(compose.volumes,'migration-state'));
});
