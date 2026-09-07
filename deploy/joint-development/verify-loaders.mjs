import { mkdtempSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parseEnv } from "node:util";
import { catalog, template, validate } from "./catalog.mjs";
import { generate } from "./compose.mjs";
const root = resolve(import.meta.dirname, "../.."),
  smpp = resolve(root, "../sdar-mcp-provider-platform");
const state = mkdtempSync(resolve(root, "artifacts/joint-development/loader-"));
const specs = catalog(smpp),
  results = [];
for (const stage of [
  "development_debug",
  "integration_candidate",
  "qualification",
]) {
  const env = validate(
    {
      ...parseEnv(template(specs)),
      DEPLOY_STAGE: stage,
      DEPLOY_PROJECT: "joint-load-only",
      SHARED__URL: "http://unused.invalid:8123",
      SHARED__PASSWORD: "loader-test-only",
    },
    specs,
  );
  const compose = generate(env, {
    smpp,
    telemetry: root,
    state,
    envDir: state,
  });
  for (const [name, module, fn] of [
    ["runtime", "apps/runtime", "loadRuntimeConfig"],
    ["adapter", "apps/ugv-provider-adapter", "loadUgvProviderConfig"],
  ]) {
    const svc = compose.services[name];
    delete svc.build;
    delete svc.depends_on;
    delete svc.ports;
    delete svc.healthcheck;
    svc.image = `smpp-joint-verification-${name}:development`;
    svc.network_mode = "none";
    const file = resolve(state, `${stage}-${name}.json`);
    writeFileSync(
      file,
      JSON.stringify({
        name: `joint-loader-${name}`,
        services: { [name]: svc },
        volumes: compose.volumes,
      }),
      { mode: 0o600 },
    );
    const code = `try {const {${fn}}=await import('./dist/${module}/src/config.js'); const c=${fn}(process.env); console.log('CONFIG_LOAD_PASS');} catch(e) {console.error(e.message); process.exit(1);}`;
    const r = spawnSync(
      "docker",
      [
        "compose",
        "-f",
        file,
        "run",
        "--rm",
        "--no-deps",
        "--entrypoint",
        "node",
        name,
        "--input-type=module",
        "-e",
        code,
      ],
      { encoding: "utf8" },
    );
    if (r.status !== 0) throw Error(`${stage}/${name}: ${r.stderr}`);
    results.push({ stage, service: name, status: "PASS" });
  }
}
writeFileSync(
  resolve(state, "evidence.json"),
  JSON.stringify(results, null, 2),
);
console.log(JSON.stringify({ state, results }));
