import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  chmodSync,
} from "node:fs";
import { resolve, dirname, isAbsolute } from "node:path";
import { randomBytes } from "node:crypto";

/** @typedef {{type:string,source:string,target:string,read_only:boolean}} BindMount */
/** @typedef {{context:string,dockerfile:string,target?:string,args:Record<string,string>}} Build */
/** @typedef {{test:string[],interval:string,timeout:string,retries:number}} Health */
/** @typedef {{image?:string,build?:Build,restart?:string,user?:string,init?:boolean,environment?:Record<string,string>,volumes?:(string|BindMount)[],ports?:string[],command?:string[],entrypoint?:string[],depends_on?:Record<string,{condition:string}>,healthcheck?:Health,ulimits?:Record<string,{soft:number,hard:number}>,network_mode?:string,working_dir?:string,mem_limit?:string,cpus?:number}} ComposeService */

/** @param {Record<string,string>} env */
export function generate(
  env,
  { smpp, telemetry, state, envDir, revision = "development", attached = false },
) {
  mkdirSync(state, { recursive: true, mode: 0o700 });
  chmodSync(state, 0o700);
  const generated = resolve(state, "config");
  mkdirSync(generated, { recursive: true, mode: 0o755 });
  const save = (name, value) => {
    const p = resolve(generated, name);
    writeFileSync(
      p,
      typeof value === "string" ? value : JSON.stringify(value, null, 2),
      { mode: 0o644 },
    );
    return p;
  };
  const file = (p) => {
    const path = resolve(envDir, p);
    if (!readFileSync(path).length) throw Error("EMPTY_CONFIG_FILE");
    return path;
  };
  const secret = (prefix, auto = false) => {
    const path = resolve(
      state,
      `${prefix.toLowerCase().replaceAll("__", "-")}.secret`,
    );
    const value = env[`${prefix}_FILE`]
      ? readFileSync(file(env[`${prefix}_FILE`]), "utf8").trim()
      : env[prefix];
    if (value) writeFileSync(path, value, { mode: 0o600 });
    else if (!existsSync(path)) {
      if (!auto) throw Error(`REQUIRED_SECRET:${prefix}[_FILE]`);
      writeFileSync(path, randomBytes(24).toString("hex"), { mode: 0o600 });
    }
    // Individual bind mount is readable by container UID 1000, parent directory remains 0700.
    chmodSync(path, 0o644);
    return path;
  };
  const mount = (source, target) => ({
    type: "bind",
    source,
    target,
    read_only: true,
  });
  const side = (name) =>
    Object.fromEntries(
      Object.entries(env)
        .filter(([key]) => key.startsWith(`${name}__`))
        .map(([key, v]) => [key.slice(name.length + 2), v]),
    );
  const runtime = side("RUNTIME"),
    adapter = side("ADAPTER"),
    processor = side("PROCESSOR"),
    query = side("QUERY");
  const noAuth = ["true", "1"].includes(env.DEPLOY_DEV_NO_AUTH);
  if (noAuth) {
    if (!["development", "anonymous"].includes(runtime.AUTH_MODE))
      throw Error("NO_AUTH_RUNTIME_MODE_CONFLICT");
    if ([runtime, adapter].some((v) => v.SIMULATOR_CREDENTIAL_FREE !== "true"))
      throw Error("DEVELOPMENT_NO_AUTH_REQUIRES_SIMULATOR_CREDENTIAL_FREE");
    if (
      processor.PROCESSOR_ADMIN_API_KEY ||
      processor.PROCESSOR_ADMIN_API_KEY_FILE ||
      query.QUERY_API_KEY ||
      query.QUERY_API_KEY_FILE
    )
      throw Error("NO_AUTH_KEY_CONFLICT");
  } else {
    if (["development", "anonymous"].includes(runtime.AUTH_MODE))
      throw Error("AUTH_MODE_REQUIRES_AUTHENTICATED_RUNTIME");
    if ([runtime, adapter].some((v) => v.SIMULATOR_CREDENTIAL_FREE !== "false"))
      throw Error("AUTH_MODE_REQUIRES_SIMULATOR_CREDENTIAL_FREE_FALSE");
    if (
      !(
        processor.PROCESSOR_ADMIN_API_KEY ||
        processor.PROCESSOR_ADMIN_API_KEY_FILE
      ) ||
      !(query.QUERY_API_KEY || query.QUERY_API_KEY_FILE)
    )
      throw Error("API_KEYS_REQUIRED");
  }
  adapter.UGV_DELIVERY_STAGE = env.DEPLOY_STAGE;
  runtime.SDAR_BUILD_REVISION ??= revision;
  // Defaults follow changed internal ports; explicit user values are validated below, never silently replaced.
  if (runtime.ADAPTER_ENDPOINT === "adapter:7010")
    runtime.ADAPTER_ENDPOINT = `adapter:${adapter.ADAPTER_PORT}`;
  if (adapter.PROVIDER_TELEMETRY_ENDPOINT === "runtime:7002")
    adapter.PROVIDER_TELEMETRY_ENDPOINT = `runtime:${runtime.PROVIDER_TELEMETRY_PORT}`;
  if (runtime.RUNTIME_INSTANCE_ID !== runtime.OTEL_SERVICE_INSTANCE_ID)
    throw Error("RUNTIME_INSTANCE_ID_MISMATCH");
  const ids = [
    runtime.PROVIDER_ID,
    runtime.RUNTIME_INSTANCE_ID,
    runtime.RUNTIME_DEPLOYMENT_ID,
    env.SOURCE_ID,
    env.COLLECTOR__COLLECTOR_ID,
    env.COLLECTOR__TRUST_DOMAIN,
  ];
  if (ids.some((v) => !v || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/.test(v)))
    throw Error("EXACT_SOURCE_IDENTITIES_REQUIRED");
  const sharedEnabled = !attached || Boolean(env.SHARED__URL);
  if (!attached && !env.SHARED__URL) throw Error("REQUIRED_CONFIGURATION:SHARED__URL");
  if (sharedEnabled) {
  const sharedUrl = new URL(env.SHARED__URL);
  if (
    !["http:", "https:"].includes(sharedUrl.protocol) ||
    sharedUrl.username ||
    sharedUrl.password
  )
    throw Error("SHARED_URL_INVALID");
  }
  const password = secret("CLICKHOUSE__PASSWORD", true),
    sharedPassword = sharedEnabled ? secret("SHARED__PASSWORD") : undefined,
    grafanaPassword = secret("GRAFANA__ADMIN_PASSWORD", true);
  const ports = Object.entries(env)
    .filter(([k]) => k.startsWith("PORT_"))
    .map(([, v]) => v);
  if (new Set(ports).size !== ports.length) throw Error("DUPLICATE_HOST_PORT");
  const port = (key, inner) =>
    `${env.DEPLOY_BIND_ADDRESS}:${env[`PORT_${key}`]}:${inner}`;
  const volumeFiles = (values) => {
    const mounts = [];
    for (const [key, value] of Object.entries(values)) {
      // Runtime-owned output paths are not configuration inputs.
      if (!/(?:_FILE|_PATH)$/.test(key) || key.endsWith("REPORT_PATH"))
        continue;
      if (!value) continue;
      const destination = `/run/config/${key.toLowerCase()}`;
      mounts.push(mount(file(value), destination));
      values[key] = destination;
    }
    return mounts;
  };
  const runtimeFiles = volumeFiles(runtime),
    adapterFiles = volumeFiles(adapter);
  const build = (root, dockerfile, target) => ({
    context: root,
    dockerfile,
    ...(target ? { target } : {}),
    args: { VCS_REF: revision, NODE_BASE_IMAGE: env.NODE_BASE_IMAGE },
  });
  const health = (url) => ({
    test: [
      "CMD",
      "node",
      "-e",
      `fetch('${url}').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`,
    ],
    interval: "5s",
    timeout: "3s",
    retries: 36,
  });
  /** @type {Record<string,ComposeService>} */
  const services = {};
  /** @type {[string,Record<string,string>,string][]} */
  const databases = [
    ["runtime", runtime, "DATABASE_URL"],
    ["adapter", adapter, "UGV_ADAPTER_DATABASE_URL"],
  ];
  if (!attached) {
  for (const [name, values, key] of databases) {
    const url = new URL(values[key]);
    if (
      url.hostname !== `${name}-db` ||
      (url.port && url.port !== "5432") ||
      !url.password
    )
      throw Error(`BUNDLED_DATABASE_URL_INVALID:${key}`);
    services[`${name}-db`] = {
      image: env.POSTGRES_IMAGE,
      restart: "unless-stopped",
      environment: {
        POSTGRES_USER: decodeURIComponent(url.username),
        POSTGRES_PASSWORD: decodeURIComponent(url.password),
        POSTGRES_DB: url.pathname.slice(1),
      },
      volumes: [`${name}-db:/var/lib/postgresql/data`],
      ports: [port(`${name.toUpperCase()}_DB`, 5432)],
      healthcheck: {
        test: [
          "CMD-SHELL",
          'pg_isready -U "$$POSTGRES_USER" -d "$$POSTGRES_DB"',
        ],
        interval: "3s",
        timeout: "3s",
        retries: 30,
      },
    };
    services[name] = {
      image: `${env.DEPLOY_PROJECT}-${name}:${revision}`,
      build: build(smpp, "Dockerfile", `ugv-real-${name}`),
      restart: "unless-stopped",
      init: true,
      environment: values,
      volumes: [
        `${name}-state:/var/lib/sdar`,
        ...(name === "runtime" ? runtimeFiles : adapterFiles),
      ],
      command: [
        "sh",
        "-c",
        `node dist/apps/${name === "runtime" ? "runtime" : "ugv-provider-adapter"}/src/migrate.js && exec node dist/apps/${name === "runtime" ? "runtime" : "ugv-provider-adapter"}/src/main.js`,
      ],
      depends_on: { [`${name}-db`]: { condition: "service_healthy" } },
    };
  }
  services.runtime.ports = [
    port("MCP", runtime.PORT),
    port("PROVIDER_TELEMETRY", runtime.PROVIDER_TELEMETRY_PORT),
  ];
  services.runtime.healthcheck = health(
    `http://127.0.0.1:${runtime.PORT}/health/ready`,
  );
  services.runtime.depends_on.adapter = { condition: "service_started" };
  services.runtime.depends_on["otel-collector"] = {
    condition: "service_started",
  };
  services.adapter.ports = [port("ADAPTER", adapter.ADAPTER_PORT)];
  }
  services.clickhouse = {
    image: env.CLICKHOUSE_IMAGE,
    restart: "unless-stopped",
    environment: {
      CLICKHOUSE_USER: env.CLICKHOUSE__USER,
      CLICKHOUSE_PASSWORD_FILE: "/run/secrets/local-password",
    },
    volumes: [
      "clickhouse-data:/var/lib/clickhouse",
      mount(password, "/run/secrets/local-password"),
    ],
    ports: [port("CLICKHOUSE_HTTP", 8123), port("CLICKHOUSE_NATIVE", 9000)],
    ulimits: { nofile: { soft: 262144, hard: 262144 } },
    healthcheck: {
      test: [
        "CMD-SHELL",
        `clickhouse-client --user "$CLICKHOUSE_USER" --password "$(cat /run/secrets/local-password)" --query 'SELECT 1'`.replaceAll(
          "$",
          "$$",
        ),
      ],
      interval: "5s",
      timeout: "3s",
      retries: 30,
    },
  };
  const telemetryBuild = build(telemetry, "telemetry-processor/Dockerfile");
  const localConnection = {
    CLICKHOUSE_URL: "http://clickhouse:8123",
    CLICKHOUSE_USER: env.CLICKHOUSE__USER,
    CLICKHOUSE_PASSWORD_FILE: "/run/secrets/local-password",
  };
  services["telemetry-migrate"] = {
    build: telemetryBuild,
    image: `${env.DEPLOY_PROJECT}-telemetry:${revision}`,
    environment: { ...localConnection, MIGRATION_LOCK_FILE: "/var/lib/smpp-telemetry/migrations/migration.sqlite" },
    volumes: ["migration-state:/var/lib/smpp-telemetry/migrations", mount(password, "/run/secrets/local-password")],
    command: ["node", "dist/telemetry-schema/tools/migrate.js"],
    depends_on: { clickhouse: { condition: "service_healthy" } },
    restart: "no",
  };
  const authoritySource = readFileSync(
    resolve(smpp, "packages/persistence-postgres/src/tasks.ts"),
    "utf8",
  ).match(/DURABLE_RUNTIME_AUTHORITY_INSTANCE_ID\s*=\s*"([^"]+)"/)?.[1];
  if (!authoritySource)
    throw Error("DURABLE_AUTHORITY_ID_NOT_FOUND_IN_CURRENT_SOURCE");
  const mappings = {
    version: 4,
    mappings: [...new Set([runtime.RUNTIME_INSTANCE_ID, authoritySource])].map(
      (instanceId) => ({
        collectorId: env.COLLECTOR__COLLECTOR_ID,
        trustDomain: env.COLLECTOR__TRUST_DOMAIN,
        deploymentId: runtime.RUNTIME_DEPLOYMENT_ID,
        providerId: runtime.PROVIDER_ID,
        instanceId,
        smppSourceId: env.SOURCE_ID,
        tenantId: env.TENANT_ID,
        projectId: env.PROJECT_ID,
        environment: "development",
        sourceProduct: "sdar-mcp-provider-platform",
        mappingVersion: 4,
        policyVersion: 2,
        projectionRouteIds: sharedEnabled ? ["standalone-smpp", "sdar-warehouse-shadow"] : ["standalone-smpp"],
        status: "active",
        validFrom: "2026-01-01T00:00:00Z",
        validTo: null,
      }),
    ),
  };
  const targets = {
    version: 1,
    targets: [
      {
        targetId: "standalone-smpp",
        snapshotEnabled: query.QUERY_SNAPSHOTS_ENABLED === "true",
        targetType: "standalone_smpp_clickhouse",
        enabled: true,
        required: true,
        writeLayers: ["landing", "normalized", "core", "relation"],
        connection: {
          url: localConnection.CLICKHOUSE_URL,
          user: env.CLICKHOUSE__USER,
          passwordFile: "/run/secrets/local-password",
        },
        tableMap: {},
        routeIds: ["standalone-smpp"],
      },
      {
        targetId: "sdar-warehouse-shadow",
        targetType: "sdar_shared_warehouse",
        enabled: true,
        required: true,
        writeLayers: ["core", "relation"],
        connection: {
          url: env.SHARED__URL,
          user: env.SHARED__USER,
          passwordFile: "/run/secrets/shared-password",
        },
        tableMap: {},
        routeIds: ["sdar-warehouse-shadow"],
      },
    ],
  };
  if (!sharedEnabled) targets.targets = targets.targets.filter(t => t.targetType === "standalone_smpp_clickhouse");
  const mappingFile = processor.SOURCE_MAPPINGS_FILE
    ? file(processor.SOURCE_MAPPINGS_FILE)
    : save("source-mappings.json", mappings);
  let targetFile = processor.PROJECTION_TARGETS_FILE
    ? file(processor.PROJECTION_TARGETS_FILE)
    : save("projection-targets.json", targets);
  const effectiveMappings = JSON.parse(readFileSync(mappingFile, "utf8"));
  for (const expected of mappings.mappings)
    if (
      !effectiveMappings.mappings?.some(
        (m) =>
          [
            "collectorId",
            "trustDomain",
            "deploymentId",
            "providerId",
            "instanceId",
            "smppSourceId",
          ].every((k) => m[k] === expected[k]) &&
          m.status === "active" &&
          expected.projectionRouteIds.every((id) =>
            m.projectionRouteIds?.includes(id),
          ),
      )
    )
      throw Error("SOURCE_MAPPING_IDENTITY_MISMATCH");
  const effectiveTargets = JSON.parse(readFileSync(targetFile, "utf8"));
  for (const expected of targets.targets)
    if (
      !effectiveTargets.targets?.some(
        (t) =>
          t.targetId === expected.targetId &&
          t.targetType === expected.targetType &&
          t.enabled &&
          typeof t.connection?.url === "string",
      )
    )
      throw Error("PROJECTION_TARGET_CONNECTION_MISMATCH");
  if (query.QUERY_SNAPSHOTS_ENABLED === "true" && !effectiveTargets.targets?.some(t => t.enabled && t.targetId === query.QUERY_SNAPSHOT_TARGET_ID && t.snapshotEnabled === true)) throw Error("QUERY_SNAPSHOT_WRITER_TARGET_MISMATCH");
  const targetSecretMounts = [];
  for (const target of effectiveTargets.targets) {
    const passwordFile = target.connection?.passwordFile;
    if (!passwordFile || ['/run/secrets/local-password', '/run/secrets/shared-password'].includes(passwordFile)) continue;
    if (!/^[a-zA-Z0-9_-]+$/.test(target.targetId)) throw Error('TARGET_ID_INVALID');
    const destination = `/run/config/target-${target.targetId}-password`;
    targetSecretMounts.push(mount(file(passwordFile), destination));
    target.connection.passwordFile = destination;
  }
  if (targetSecretMounts.length) targetFile = save('projection-targets.json', effectiveTargets);
  delete processor.SOURCE_MAPPINGS_FILE;
  delete processor.PROJECTION_TARGETS_FILE;
  const processorFiles = volumeFiles(processor);
  Object.assign(processor, {
    SOURCE_MAPPINGS_FILE: "/run/config/source-mappings.json",
    PROJECTION_TARGETS_FILE: "/run/config/projection-targets.json",
    PROCESSOR_ALLOWED_COLLECTOR_IDS:
      processor.PROCESSOR_ALLOWED_COLLECTOR_IDS ?? env.COLLECTOR__COLLECTOR_ID,
  });
  if (
    !processor.PROCESSOR_ALLOWED_COLLECTOR_IDS.split(",")
      .map((v) => v.trim())
      .includes(env.COLLECTOR__COLLECTOR_ID)
  )
    throw Error("ALLOWED_COLLECTOR_ID_MISMATCH");
  if (processor.PROCESSOR_TLS_MODE !== "disabled" && !env.COLLECTOR_CONFIG_FILE)
    throw Error("TLS_REQUIRES_COLLECTOR_CONFIG_FILE");
  if (!isAbsolute(processor.WAL_DIR)) throw Error("WAL_DIR_MUST_BE_ABSOLUTE");
  const commonMounts = [
    mount(password, "/run/secrets/local-password"),
    ...(sharedPassword ? [mount(sharedPassword, "/run/secrets/shared-password")] : []),
  ];
  services["wal-init"] = {
    build: telemetryBuild,
    image: `${env.DEPLOY_PROJECT}-telemetry:${revision}`,
    user: "0:0",
    restart: "no",
    volumes: ["processor-wal:/wal"],
    command: ["sh", "-c", "chown 1000:1000 /wal"],
  };
  services["telemetry-processor"] = {
    entrypoint: ["/bin/sh", "/run/telemetry/wal-reader-entrypoint.sh"],
    command: ["node", "dist/telemetry-processor/src/apps/index.js"],
    build: telemetryBuild,
    image: `${env.DEPLOY_PROJECT}-telemetry:${revision}`,
    restart: "unless-stopped",
    environment: { ...processor, WAL_MIN_READER_VERSION: "2" },
    volumes: [
      `processor-wal:${processor.WAL_DIR}`,
      mount(resolve(telemetry, "deploy/wal-reader-guard.mjs"), "/run/telemetry/wal-reader-guard.mjs"),
      mount(resolve(telemetry, "deploy/wal-reader-entrypoint.sh"), "/run/telemetry/wal-reader-entrypoint.sh"),
      ...commonMounts,
      ...processorFiles,
      ...targetSecretMounts,
      mount(mappingFile, processor.SOURCE_MAPPINGS_FILE),
      mount(targetFile, processor.PROJECTION_TARGETS_FILE),
    ],
    ports: [port("PROCESSOR", processor.PROCESSOR_PORT)],
    depends_on: {
      "telemetry-migrate": { condition: "service_completed_successfully" },
    },
    healthcheck:
      processor.PROCESSOR_TLS_MODE === "disabled"
        ? health(`http://127.0.0.1:${processor.PROCESSOR_PORT}/health/ready`)
        : undefined,
  };
  let collectorConfig = readFileSync(
    resolve(telemetry, "deploy/ugv-debug/collector.template.yaml"),
    "utf8",
  )
    .replace(
      "http://telemetry-processor:8443/internal/otlp",
      `http://telemetry-processor:${processor.PROCESSOR_PORT}/internal/otlp`,
    )
    .replace("ugv-debug-collector", "${env:COLLECTOR_ID}")
    .replace("local-development", "${env:TRUST_DOMAIN}")
    .replace("uap-p3-b01-runtime-1", "${env:SMPP_RUNTIME_INSTANCE_ID}")
    .replace("uap-p3-b01-runtime", "${env:SMPP_DEPLOYMENT_ID}")
    .replace("isr.vehicle.ugv.ugv1", "${env:SMPP_PROVIDER_ID}")
    .replace("ugv-agent-profile-runtime:8080", "${env:SMPP_METRICS_TARGET}")
    .replace("telemetry-processor:8443\"", `telemetry-processor:${processor.PROCESSOR_PORT}\"`)
    .replace("query-api:8088\"", `query-api:${query.QUERY_API_PORT}\"`)
    .replace(
      "scrape_interval: 15s",
      "scrape_interval: ${env:SMPP_METRICS_SCRAPE_INTERVAL}",
    )
    .replace("metrics_path: /metrics", "metrics_path: ${env:SMPP_METRICS_PATH}")
    .replace("username: default", "username: ${env:CLICKHOUSE_USER}")
    .replace("__UGV_DEBUG_CLICKHOUSE_PASSWORD__", "${env:CLICKHOUSE_PASSWORD}")
    .replace(/value: (\$\{env:[^}]+\})/g, 'value: "$1"');
  const queryMetricsKey = query.QUERY_API_KEY_FILE ? readFileSync(file(query.QUERY_API_KEY_FILE), 'utf8').trim() : query.QUERY_API_KEY;
  let queryMetricsKeyFile;
  if (queryMetricsKey) {
    queryMetricsKeyFile = save('query-metrics-key', queryMetricsKey);
    collectorConfig = collectorConfig.replace(`            - targets: ["query-api:${query.QUERY_API_PORT}"]`, `            - targets: ["query-api:${query.QUERY_API_PORT}"]\n          authorization:\n            credentials_file: /run/secrets/query-metrics-key`);
  }
  const collectorFile = env.COLLECTOR_CONFIG_FILE
    ? file(env.COLLECTOR_CONFIG_FILE)
    : save("collector.yaml", collectorConfig);
  services["otel-collector"] = {
    image: env.COLLECTOR_IMAGE,
    restart: "unless-stopped",
    command: ["--config=/etc/otelcol/config.yaml"],
    environment: {
      ...side("COLLECTOR"),
      SMPP_DEPLOYMENT_ID: runtime.RUNTIME_DEPLOYMENT_ID,
      SMPP_RUNTIME_INSTANCE_ID: runtime.RUNTIME_INSTANCE_ID,
      SMPP_PROVIDER_ID: runtime.PROVIDER_ID,
      SMPP_METRICS_TARGET: `runtime:${runtime.PORT}`,
    },
    volumes: [mount(collectorFile, "/etc/otelcol/config.yaml"), ...(queryMetricsKeyFile ? [mount(queryMetricsKeyFile, "/run/secrets/query-metrics-key")] : [])],
    ports: [
      port("OTLP_GRPC", 4317),
      port("OTLP_HTTP", 4318),
      port("COLLECTOR_HEALTH", 13133),
      port("COLLECTOR_METRICS", 8888),
      port("RUNTIME_METRICS", 9464),
    ],
    depends_on: {
      "telemetry-processor": {
        condition:
          processor.PROCESSOR_TLS_MODE === "disabled"
            ? "service_healthy"
            : "service_started",
      },
    },
  };
  if (!sharedEnabled) query.AUTHORITY_ENABLED = "false";
  const queryFiles = volumeFiles(query);
  if (!query.QUERY_CURSOR_KEY && !query.QUERY_CURSOR_KEY_FILE) {
    const cursorKeyFile = secret("QUERY__QUERY_CURSOR_KEY", true);
    query.QUERY_CURSOR_KEY_FILE = "/run/secrets/query-cursor-key";
    queryFiles.push(mount(cursorKeyFile, query.QUERY_CURSOR_KEY_FILE));
  }
  services["telemetry-processor"].depends_on["wal-init"] = {
    condition: "service_completed_successfully",
  };
  // An explicit inline password must not accidentally inherit the default file-backed credential.
  const queryLocalConnection = { ...localConnection };
  if (query.CLICKHOUSE_PASSWORD && !query.CLICKHOUSE_PASSWORD_FILE)
    queryLocalConnection.CLICKHOUSE_PASSWORD_FILE = "";
  services["query-api"] = {
    build: telemetryBuild,
    image: `${env.DEPLOY_PROJECT}-telemetry:${revision}`,
    restart: "unless-stopped",
    command: ["node", "dist/telemetry-dashboard/query-api/src/index.js"],
    environment: {
      ...queryLocalConnection,
      ...(sharedEnabled ? {
        AUTHORITY_CLICKHOUSE_URL: env.SHARED__URL,
        AUTHORITY_CLICKHOUSE_USER: env.SHARED__USER,
        AUTHORITY_CLICKHOUSE_PASSWORD_FILE: "/run/secrets/shared-password",
      } : { AUTHORITY_ENABLED: "false" }),
      ...query,
    },
    volumes: [...commonMounts, ...queryFiles],
    ports: [port("QUERY", query.QUERY_API_PORT)],
    healthcheck: {
      ...health(`http://127.0.0.1:${query.QUERY_API_PORT}/health/ready`),
      test: ["CMD", "node", "-e", `const fs=require('fs');const key=process.env.QUERY_API_KEY_FILE?fs.readFileSync(process.env.QUERY_API_KEY_FILE,'utf8').trim():process.env.QUERY_API_KEY;fetch('http://127.0.0.1:'+process.env.QUERY_API_PORT+'/health/ready',{headers:key?{authorization:'Bearer '+key}:{}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`],
    },
    depends_on: {
      "telemetry-migrate": { condition: "service_completed_successfully" },
    },
  };
  services.grafana = {
    image: env.GRAFANA_IMAGE,
    restart: "unless-stopped",
    environment: {
      ...Object.fromEntries(Object.entries(side("GRAFANA")).filter(([key]) => key.startsWith("ALERT_"))),
      GF_INSTALL_PLUGINS: "grafana-clickhouse-datasource 4.20.0",
      GF_SECURITY_ADMIN_USER: env.GRAFANA__ADMIN_USER,
      GF_SECURITY_ADMIN_PASSWORD__FILE: "/run/secrets/grafana-password",
      CLICKHOUSE_USER: env.CLICKHOUSE__USER,
    },
    entrypoint: [
      "/bin/sh",
      "-euc",
      'export CLICKHOUSE_PASSWORD="$$(cat /run/secrets/local-password)"; exec /bin/sh /etc/grafana/telemetry-start.sh',
    ],
    volumes: [
      "grafana-data:/var/lib/grafana",
      mount(resolve(telemetry, "telemetry-dashboard/grafana/start.sh"), "/etc/grafana/telemetry-start.sh"),
      mount(grafanaPassword, "/run/secrets/grafana-password"),
      mount(password, "/run/secrets/local-password"),
      mount(
        resolve(telemetry, "telemetry-dashboard/grafana/provisioning"),
        "/etc/grafana/provisioning",
      ),
      mount(
        resolve(telemetry, "telemetry-dashboard/grafana/dashboards"),
        "/var/lib/grafana/dashboards",
      ),
    ],
    ports: [port("GRAFANA", 3000)],
  };
  if (
    query.AUTHORITY_CLICKHOUSE_PASSWORD &&
    !query.AUTHORITY_CLICKHOUSE_PASSWORD_FILE
  )
    services["query-api"].environment.AUTHORITY_CLICKHOUSE_PASSWORD_FILE = "";
  services["otel-collector"].user = "0:0";
  services["otel-collector"].volumes.push(
    "collector-queue:/var/lib/otelcol/storage",
    ...processorFiles.filter((v) => v.target.includes("processor_tls_")),
  );
  Object.assign(services["otel-collector"].environment, {
    CLICKHOUSE_USER: env.CLICKHOUSE__USER,
    CLICKHOUSE_PASSWORD: readFileSync(password, "utf8"),
  });
  services.grafana.volumes.push(
    mount(
      save(
        "grafana-datasources.yaml",
        readFileSync(
          resolve(
            telemetry,
            "telemetry-dashboard/grafana/provisioning/datasources/clickhouse.yaml",
          ),
          "utf8",
        ).replace("username: default", "username: ${CLICKHOUSE_USER}"),
      ),
      "/etc/grafana/provisioning/datasources/clickhouse.yaml",
    ),
  );
  for (const service of Object.values(services)) {
    service.environment = Object.fromEntries(
      Object.entries(service.environment ?? {}).map(([key, value]) => [
        key,
        String(value).replaceAll("$", () => "$$"),
      ]),
    );
    if (service.build)
      service.build.context = service.build.context.replaceAll("$", () => "$$");
    service.volumes = (service.volumes ?? []).map((v) =>
      typeof v === "string"
        ? v.replaceAll("$", () => "$$")
        : {
            ...v,
            source: v.source.replaceAll("$", () => "$$"),
            target: v.target.replaceAll("$", () => "$$"),
          },
    );
  }
  services.clickhouse.healthcheck.test[1] =
    services.clickhouse.healthcheck.test[1].replaceAll("$", () => "$$");
  return {
    name: env.DEPLOY_PROJECT,
    services,
    volumes: Object.fromEntries(
      [
        "runtime-db",
        "migration-state",
        "adapter-db",
        "runtime-state",
        "adapter-state",
        "clickhouse-data",
        "processor-wal",
        "grafana-data",
        "collector-queue",
      ].filter(v => !attached || !["runtime-db", "adapter-db", "runtime-state", "adapter-state"].includes(v)).map((v) => [v, {}]),
    ),
  };
}
