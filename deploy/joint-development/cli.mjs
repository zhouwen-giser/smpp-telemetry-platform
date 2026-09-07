import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { randomUUID, createHash } from "node:crypto";
import { registryPath, resolveDeployment, saveDeployment, operationalArgs } from "./deployment-state.mjs";
import { generate } from "./compose.mjs";
import { writerProgram, readerProgram } from "./preflight.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const bundled = existsSync(resolve(here, "sources/smpp"));
const root = bundled ? here : resolve(here, "../..");
const smpp = bundled
  ? resolve(root, "sources/smpp")
  : resolve(root, "../sdar-mcp-provider-platform");
const telemetry = bundled ? resolve(root, "sources/telemetry") : root;
const action = process.argv[2] ?? "up";
const args = process.argv.slice(3);
const selector = args.indexOf("--deployment");
const deploymentId = selector >= 0 ? args[selector + 1] : undefined;
if (selector >= 0) args.splice(selector, 2);
const envPath = resolve(args[0] ?? resolve(bundled ? root : here, ".env"));
const registry = registryPath(envPath);
const templatePath = resolve(bundled ? root : here, ".env.example");
const run = (args, options = {}) => {
  const child = spawnSync("docker", args, { encoding: "utf8", ...options });
  // Docker errors may contain environment values. Never echo compose config/build argv or output on errors.
  if (child.status !== 0)
    throw Error(
      `DOCKER_COMMAND_FAILED:${args[0]}:${args[1] ?? ""} (check Docker access and local logs)`,
    );
  return child.stdout;
};
async function main() {
  if (args.length > 1 || (selector >= 0 && !deploymentId)) throw Error("Usage: deploy.sh up|status|logs|down|config|check [env-file] [--deployment <id>]");
  if (["status", "logs", "down"].includes(action)) {
    const descriptor = resolveDeployment({ registry, envPath, deploymentId });
    console.log(run(operationalArgs(descriptor, action)));
    if (action === "down") saveDeployment(registry, { ...descriptor, phase: "stopped" });
    return;
  }
  if (selector >= 0) throw Error("--deployment requires status, logs or down");
  const { catalog, template, validate } = await import("./catalog.mjs");
  const specs = catalog(smpp);
  if (action === "template") {
    writeFileSync(templatePath, template(specs));
    return;
  }
  if (!["up", "status", "logs", "down", "config", "check"].includes(action))
    throw Error("Usage: deploy.sh up|status|logs|down|config|check [env-file]");
  if (!existsSync(envPath))
    writeFileSync(envPath, template(specs), { mode: 0o600, flag: "wx" });
  if (readFileSync(templatePath, "utf8") !== template(specs))
    throw Error("ENV_TEMPLATE_DRIFT: regenerate from current repositories");
  const input = parseEnv(readFileSync(envPath, "utf8"));
  const env = validate(input, specs);
  const deploymentRoot = resolve(registry, env.DEPLOY_PROJECT);
  const configRevision = randomUUID();
  const state = resolve(deploymentRoot, 'revisions', configRevision);
  mkdirSync(state, { recursive: true, mode: 0o700 });
  let previous = null;
  try { previous = resolveDeployment({ registry, envPath, deploymentId: env.DEPLOY_PROJECT }); }
  catch (error) { if (error.message !== 'NO_GENERATED_DEPLOYMENT') throw error; }
  // Preserve auto-generated passwords while keeping each attempted configuration immutable.
  if (previous) for (const name of ['clickhouse-password.secret', 'shared-password.secret', 'grafana-admin_password.secret', 'query-query_cursor_key.secret']) {
    const source = resolve(dirname(previous.composePath), name);
    if (existsSync(source)) copyFileSync(source, resolve(state, name));
  }
  const manifest = existsSync(resolve(root, "release.json"))
    ? JSON.parse(readFileSync(resolve(root, "release.json"), "utf8"))
    : null;
  const compose = generate(env, {
    smpp,
    telemetry,
    state,
    envDir: dirname(envPath),
    revision: manifest?.buildIdentity ?? "local-development",
  });
  const file = resolve(state, "candidate-compose.json");
  writeFileSync(file, JSON.stringify(compose, null, 2), { mode: 0o600 });
  const base = ["compose", "--env-file", "/dev/null", "-p", env.DEPLOY_PROJECT, "-f", file];
  run([...base, "config", "--quiet"]);
  writeFileSync(
    resolve(state, "interfaces.json"),
    JSON.stringify(
      {
        host: env.DEPLOY_PUBLIC_HOST,
        ports: Object.fromEntries(
          Object.entries(env).filter(([k]) => k.startsWith("PORT_")),
        ),
        mode:
          env.DEPLOY_DEV_NO_AUTH === "true"
            ? "isolated-development-no-api-auth"
            : "authenticated",
      },
      null,
      2,
    ),
  );
  console.log(
    `CONFIG_PASS: ${Object.keys(specs).length} documented configuration entries; values redacted`,
  );
  if (action === "config") return;
  const arch = run(["info", "--format", "{{.Architecture}}"]).trim();
  if (!["x86_64", "aarch64", "amd64", "arm64"].includes(arch))
    throw Error("UNSUPPORTED_ARCHITECTURE");
  console.log(
    `Building for ${arch}; no device calls in configuration preflight.`,
  );
  run([...base, "build"], { stdio: "inherit" });
  run([
    ...base,
    "run",
    "--rm",
    "--no-deps",
    "otel-collector",
    "validate",
    "--config=/etc/otelcol/config.yaml",
  ]);
  for (const [service, module, fn] of [
    ["runtime", "apps/runtime/src/config.js", "loadRuntimeConfig"],
    [
      "adapter",
      "apps/ugv-provider-adapter/src/config.js",
      "loadUgvProviderConfig",
    ],
    [
      "telemetry-processor",
      "telemetry-processor/src/packages/config/config.js",
      "loadConfig",
    ],
  ]) {
    run([
      ...base,
      "run",
      "--rm",
      "--no-deps",
      "--entrypoint",
      "node",
      service,
      "--input-type=module",
      "-e",
      `try { const m=await import('./dist/${module}'); await m.${fn}(process.env); console.log('CONFIG_LOAD_PASS'); } catch { console.error('CONFIG_LOAD_FAILED'); process.exit(1); }`,
    ]);
  }
  run([
    ...base,
    "run",
    "--rm",
    "--no-deps",
    "--entrypoint",
    "node",
    "telemetry-processor",
    "--input-type=module",
    "-e",
    `try { const {loadConfig,loadTls}=await import('./dist/telemetry-processor/src/packages/config/config.js');const {SourceMappings}=await import('./dist/telemetry-processor/src/packages/source-mapping/source-mapping.js');const {loadProjectionTargets}=await import('./dist/telemetry-processor/src/packages/exporters/target-manager.js');const c=await loadConfig();await loadTls(c.tls);await new SourceMappings(c.sourceMappingsFile).load();await loadProjectionTargets(c.projectionTargetsFile);console.log('PROCESSOR_FILES_PASS');}catch{console.error('PROCESSOR_FILES_INVALID');process.exit(1);}`,
  ]);
  const preflight = () => {
    for (const [service, program] of [["telemetry-processor", writerProgram], ["query-api", readerProgram]])
      run([...base, "run", "--rm", "--no-deps", "--entrypoint", "node", service, "--input-type=module", "-e", program]);
  };
  if (action === "check") {
    preflight();
    console.log("CHECK_PASS (no services started; all actual reader/writer connections checked read-only)");
    return;
  }
  // Only ports already owned by this exact Compose project may be reused.
  const owned = run([...base, "ps", "-q"])
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const used = new Set(
    owned.length
      ? JSON.parse(run(["inspect", ...owned])).flatMap((c) =>
          Object.values(c.NetworkSettings.Ports ?? {}).flatMap((v) =>
            (v ?? []).map((p) => p.HostPort),
          ),
        )
      : [],
  );
  for (const [key, value] of Object.entries(env).filter(([key]) =>
    key.startsWith("PORT_"),
  )) {
    if (used.has(value)) continue;
    await new Promise((ok, fail) => {
      const server = createServer();
      server.once("error", () => fail(Error(`PORT_CONFLICT:${key}`)));
      server.listen(+value, env.DEPLOY_BIND_ADDRESS, () => server.close(ok));
    });
  }
  // Once deployment starts, operational commands must remain usable even if readiness later fails.
  const descriptor = { deploymentId: env.DEPLOY_PROJECT, project: env.DEPLOY_PROJECT, envPath, composePath: file,
    configRevision, composeSha256: createHash('sha256').update(readFileSync(file)).digest('hex'), phase: 'attempted',
    lastSuccessfulRevision: previous?.lastSuccessfulRevision ?? null };
  saveDeployment(registry, descriptor);
  // Initialize the managed standalone schema before checking actual writer and reader grants.
  run([...base, "up", "-d", "--wait", "--wait-timeout", env.DEPLOY_WAIT_SECONDS, "clickhouse"], { stdio: "inherit" });
  run([...base, "run", "--rm", "--no-deps", "telemetry-migrate"], { stdio: "inherit" });
  preflight();
  run(
    [...base, "up", "-d", "--wait", "--wait-timeout", env.DEPLOY_WAIT_SECONDS],
    { stdio: "inherit" },
  );
  // Query from the container network; published bind address may not include loopback.
  run([
    ...base,
    "exec",
    "-T",
    "query-api",
    "node",
    "--input-type=module",
    "-e",
    `import {readFileSync} from 'node:fs'; const key=process.env.QUERY_API_KEY_FILE?readFileSync(process.env.QUERY_API_KEY_FILE,'utf8').trim():process.env.QUERY_API_KEY; const r=await fetch('http://127.0.0.1:'+process.env.QUERY_API_PORT+'/health/ready',{headers:key?{authorization:'Bearer '+key}:{}}); if(!r.ok)process.exit(1);`,
  ]);
  run([
    ...base,
    "exec",
    "-T",
    "query-api",
    "node",
    "--input-type=module",
    "-e",
    `const until=Date.now()+${+env.DEPLOY_WAIT_SECONDS * 1000};const urls=['http://otel-collector:13133/','http://grafana:3000/api/health'];for(const url of urls){let ok=false;while(Date.now()<until){try{ok=(await fetch(url,{signal:AbortSignal.timeout(2000)})).ok;if(ok)break;}catch{}await new Promise(r=>setTimeout(r,1000));}if(!ok)process.exit(1);}console.log('COLLECTOR_GRAFANA_READY');`,
  ]);
  if (env.PROCESSOR__PROCESSOR_TLS_MODE === "disabled") {
    run([
      ...base,
      "exec",
      "-T",
      "query-api",
      "node",
      "--input-type=module",
      "-e",
      `const until=Date.now()+${+env.DEPLOY_WAIT_SECONDS * 1000}; let ok=false; while(Date.now()<until){try{const r=await fetch('http://telemetry-processor:${env.PROCESSOR__PROCESSOR_PORT}/health/ready'); const s=await r.json();ok=r.ok && s.targets.length===2 && s.targets.every(t=>t.pending===0&&!t.lastError);if(ok){console.log(JSON.stringify({projection:s.targets}));break;}}catch{} await new Promise(r=>setTimeout(r,1000));}if(!ok)process.exit(1);`,
    ]);
  } else {
    run([
      ...base,
      "exec",
      "-T",
      "telemetry-processor",
      "node",
      "--input-type=module",
      "-e",
      `import https from 'node:https';import {readFileSync} from 'node:fs';const options={ca:readFileSync(process.env.PROCESSOR_TLS_CA_FILE),cert:readFileSync(process.env.PROCESSOR_TLS_CERT_FILE),key:readFileSync(process.env.PROCESSOR_TLS_KEY_FILE)};const until=Date.now()+${+env.DEPLOY_WAIT_SECONDS * 1000};let ok=false;while(Date.now()<until){try{const s=await new Promise((resolve,reject)=>{https.get('https://telemetry-processor:'+process.env.PROCESSOR_PORT+'/health/ready',options,r=>{let text='';r.on('data',b=>text+=b);r.on('end',()=>{try{resolve(JSON.parse(text))}catch(e){reject(e)}})}).on('error',reject)});ok=s.status==='ready'&&s.targets.length===2&&s.targets.every(t=>t.pending===0&&!t.lastError);if(ok)break;}catch{}await new Promise(r=>setTimeout(r,1000));}if(!ok)process.exit(1);`,
    ]);
  }
  const ids = run([...base, "ps", "-q"])
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  writeFileSync(
    resolve(state, "identity.json"),
    JSON.stringify(
      {
        buildIdentity: manifest?.buildIdentity ?? "local-development",
        architecture: arch,
        instances: JSON.parse(run(["inspect", ...ids])).map((c) => ({
          name: c.Name,
          image: c.Image,
          startedAt: c.State.StartedAt,
          restartCount: c.RestartCount,
        })),
      },
      null,
      2,
    ),
  );
  saveDeployment(registry, { ...descriptor, phase: "active", lastSuccessfulRevision: configRevision });
  console.log(
    `READY: http://${env.DEPLOY_PUBLIC_HOST}:${env.PORT_MCP}/mcp ; http://${env.DEPLOY_PUBLIC_HOST}:${env.PORT_QUERY}/health/ready`,
  );
  console.log(
    `Interface manifest and credentials: ${state} (private directory; do not share).`,
  );
}
main().catch((error) => {
  console.error(
    error.message?.startsWith("DOCKER_")
      ? error.message
      : String(error.message).replace(
          /(https?:\/\/)[^\s/@]+:[^\s/@]+@/g,
          "$1[redacted]@",
        ),
  );
  process.exitCode = 1;
});
