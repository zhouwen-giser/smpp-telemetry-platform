import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const root = resolve(import.meta.dirname, "../..");
const result = JSON.parse(
  execFileSync("node", ["deploy/joint-development/package.mjs"], {
    cwd: root,
    encoding: "utf8",
  }),
);
const extracted = mkdtempSync(
  resolve(root, "artifacts/joint-development/extracted-"),
);
execFileSync("tar", ["-xzf", result.archive, "-C", extracted]);
const files = execFileSync("tar", ["-tzf", result.archive], {
  encoding: "utf8",
}).split("\n");
assert.ok(
  !files.some((p) =>
    /(^|\/)(\.git|\.env|secrets|\.joint-state|node_modules)(\/|$)/.test(p),
  ),
);
const content =
  readFileSync(resolve(extracted, ".env.example"), "utf8") +
  '\nSHARED__URL="http://unused.invalid:8123"\nSHARED__PASSWORD="test-only"\nRUNTIME__DATABASE_URL="postgresql://ugv_runtime:p%24literal@runtime-db:5432/ugv_runtime"\n';
writeFileSync(resolve(extracted, ".env"), content, { mode: 0o600 });
const output = execFileSync("bash", ["deploy.sh", "config"], {
  cwd: extracted,
  encoding: "utf8",
  env: { ...process.env, PORT_MCP: "65500", CLICKHOUSE_USER: "host-pollution" },
});
const revisionsRoot = resolve(extracted, ".joint-state/smpp-telemetry-development/revisions");
const revisions = readdirSync(revisionsRoot);
assert.equal(revisions.length, 1);
const composePath = resolve(revisionsRoot, revisions[0], "candidate-compose.json");
const expanded = JSON.parse(
  execFileSync(
    "docker",
    ["compose", "-f", composePath, "config", "--format", "json"],
    { encoding: "utf8" },
  ),
);
// `compose config` preserves $$ for re-consumption. Verify the actual container value as well.
assert.equal(
  expanded.services["runtime-db"].environment.POSTGRES_PASSWORD,
  "p$$literal",
);
execFileSync(
  "docker",
  [
    "compose",
    "-p",
    `joint-package-${Date.now()}`,
    "-f",
    composePath,
    "run",
    "--rm",
    "--no-deps",
    "--entrypoint",
    "sh",
    "runtime-db",
    "-c",
    `test "$POSTGRES_PASSWORD" = 'p$literal'`,
  ],
  { encoding: "utf8" },
);
assert.equal(expanded.services.runtime.ports[0].published, "19100");
assert.match(
  expanded.services.clickhouse.healthcheck.test[1],
  /\$CLICKHOUSE_USER/,
);
assert.equal(readFileSync(resolve(extracted, ".env"), "utf8"), content);
console.log(
  JSON.stringify({
    status: "PASS",
    archive: result.archive,
    extracted,
    configuration: output.trim(),
    literalDollarPreserved: true,
    hostEnvironmentIgnored: true,
    originalEnvPreserved: true,
  }),
);
