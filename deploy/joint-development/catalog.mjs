import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

const str = (value, description, extra = {}) => ({
  type: "string",
  value,
  description,
  ...extra,
});
const number = (value, description, maximum = Number.MAX_SAFE_INTEGER) => ({
  type: "integer",
  value,
  minimum: 1,
  maximum,
  description,
});
export function catalog(smpp) {
  const out = {};
  const defaults = parseEnv(
    readFileSync(
      resolve(smpp, "deploy/development/server/.env.example"),
      "utf8",
    ),
  );
  for (const [side, groups] of Object.entries({
    RUNTIME: [
      "runtime.bootstrap",
      "runtime.observability",
      "runtime.workerEvents",
    ],
    ADAPTER: ["provider.ugv"],
  })) {
    for (const group of groups) {
      const schema = JSON.parse(
        readFileSync(resolve(smpp, `schemas/config/${group}.schema.json`), "utf8"),
      );
      for (const [key, spec] of Object.entries(schema.properties))
        out[`${side}__${key}`] = {
          ...spec,
          value: defaults[`${side}__${key}`],
          description: spec.description ?? `${side} ${key}（${group}）`,
        };
    }
  }
  // Bootstrap identity/registration is deliberately outside configuration-center schemas.
  for (const key of [
    "PMS_RUNTIME_REGISTRATION_URL",
    "PMS_RUNTIME_REGISTRATION_TOKEN_FILE",
    "PMS_DEPLOYMENT_ID",
    "PMS_INSTANCE_ID",
    "RUNTIME_DEPLOYMENT_ID",
    "RUNTIME_INSTANCE_ID",
    "SDAR_BUILD_REVISION",
  ])
    out[`RUNTIME__${key}`] = str(undefined, `Runtime bootstrap ${key}`);
  out.RUNTIME__PMS_RUNTIME_HEARTBEAT_INTERVAL_MS = number(
    undefined,
    "PMS 心跳间隔，毫秒",
    120000,
  );
  Object.assign(out, {
    DEPLOY_PROJECT: str(
      "smpp-telemetry-development",
      "独立 Compose 项目名；更改会创建另一套卷",
      { pattern: "^[a-z0-9][a-z0-9_-]*$" },
    ),
    DEPLOY_BIND_ADDRESS: str(
      "0.0.0.0",
      "宿主监听 IP；仅隔离开发网络，禁止公网",
    ),
    DEPLOY_PUBLIC_HOST: str(
      "localhost",
      "访问清单中的服务器 IP/DNS；部署服务器供他人访问时必须修改",
    ),
    DEPLOY_STAGE: str("development_debug", "SMPP 阶段，不表示资格认证", {
      enum: ["development_debug", "integration_candidate", "qualification"],
    }),
    DEPLOY_DEV_NO_AUTH: {
      type: "boolean",
      value: "true",
      description:
        "显式开发免凭证；false 时必须配置两侧原生鉴权与 Telemetry API keys",
    },
    DEPLOY_WAIT_SECONDS: number(180, "服务与投影等待上限，秒", 3600),
    NODE_BASE_IMAGE: str("node:22-bookworm-slim", "SMPP 双架构构建基础镜像"),
    POSTGRES_IMAGE: str("postgres:17-alpine", "双架构 PostgreSQL 镜像"),
    CLICKHOUSE_IMAGE: str(
      "clickhouse/clickhouse-server:25.3.14.14",
      "双架构开发 ClickHouse；不替代 ARM64 release 源码构建门禁",
    ),
    COLLECTOR_IMAGE: str(
      "otel/opentelemetry-collector-contrib:0.157.0",
      "Collector 双架构镜像",
    ),
    GRAFANA_IMAGE: str("grafana/grafana:12.1.0", "Grafana 双架构镜像"),
    COLLECTOR__COLLECTOR_ID: str(
      "joint-development-collector",
      "精确可信 Collector ID",
    ),
    COLLECTOR__TRUST_DOMAIN: str("joint-development", "精确信任域"),
    COLLECTOR__SMPP_METRICS_PATH: str(
      "/metrics",
      "Runtime Prometheus HTTP 路径",
    ),
    COLLECTOR__SMPP_METRICS_SCRAPE_INTERVAL: str(
      "15s",
      "Prometheus 拉取周期，例如 15s",
    ),
    SOURCE_ID: str(
      "smpp.joint-development.ugv1",
      "稳定精确 SMPP Source ID，不允许通配",
    ),
    TENANT_ID: str("tenant-local", "Telemetry 数据租户"),
    PROJECT_ID: str("smpp-development", "Telemetry 数据项目"),
    SHARED__URL: str(
      undefined,
      "必填：已有 SDAR ClickHouse HTTP(S) 地址；不得填入 URL 凭证",
      { format: "uri" },
    ),
    SHARED__USER: str(
      "telemetry_projection_writer",
      "已有共享库账号；需要 SELECT、两事实表 INSERT，脚本只读预检",
    ),
    SHARED__PASSWORD: str(undefined, "已有共享库密码；建议使用 PASSWORD_FILE", {
      writeOnly: true,
    }),
    SHARED__PASSWORD_FILE: str(
      undefined,
      "共享库密码文件，宿主路径，相对于 .env 目录；优先于明文",
      { writeOnly: true },
    ),
    CLICKHOUSE__USER: str("default", "独立 ClickHouse 用户"),
    CLICKHOUSE__PASSWORD: str(
      undefined,
      "独立库密码；省略则首次自动生成并持久保存",
      { writeOnly: true },
    ),
    CLICKHOUSE__PASSWORD_FILE: str(
      undefined,
      "独立库密码宿主文件，优先于明文",
      { writeOnly: true },
    ),
    GRAFANA__ALERT_WAL_BYTES: number(912680550, "WAL 空间告警字节阈值"),
    GRAFANA__ALERT_STATE_BYTES: number(1073741824, "持久索引空间告警字节阈值"),
    GRAFANA__ALERT_ARCHIVE_BYTES: number(10737418240, "归档空间告警字节阈值"),
    GRAFANA__ALERT_DLQ_BYTES: number(268435456, "DLQ 空间告警字节阈值"),
    GRAFANA__ALERT_PENDING_AGE_MS: number(300000, "最老未处置记录等待告警毫秒阈值"),
    GRAFANA__ADMIN_USER: str("admin", "Grafana 管理员"),
    GRAFANA__ADMIN_PASSWORD: str(
      undefined,
      "省略则首次生成并保存，不输出到控制台",
      { writeOnly: true },
    ),
    GRAFANA__ADMIN_PASSWORD_FILE: str(
      undefined,
      "Grafana 密码宿主文件，优先于明文",
      { writeOnly: true },
    ),
  });
  for (const [key, value] of Object.entries({
    MCP: 19100,
    ADAPTER: 17010,
    PROVIDER_TELEMETRY: 17002,
    RUNTIME_DB: 15432,
    ADAPTER_DB: 15433,
    OTLP_GRPC: 4317,
    OTLP_HTTP: 4318,
    PROCESSOR: 8443,
    QUERY: 8088,
    GRAFANA: 3000,
    CLICKHOUSE_HTTP: 8123,
    CLICKHOUSE_NATIVE: 9000,
    COLLECTOR_HEALTH: 13133,
    COLLECTOR_METRICS: 8888,
    RUNTIME_METRICS: 9464,
  }))
    out[`PORT_${key}`] = number(
      value,
      `${key} 宿主端口，与容器内部端口区分`,
      65535,
    );
  const processor = {
    PROCESSOR_HOST: str("0.0.0.0", "Processor 容器监听 IP"),
    PROCESSOR_PORT: number(8443, "Processor 容器端口", 65535),
    MAX_REQUEST_BYTES: number(4194304, "入口请求最大解压后字节数"),
    WAL_DIR: str(
      "/var/lib/smpp-telemetry/wal",
      "容器 WAL 路径；自动挂载持久卷",
    ),
    WAL_SEGMENT_MAX_BYTES: number(67108864, "WAL 单段字节数"),
    WAL_MAX_BYTES: number(10737418240, "WAL 总字节上限"),
    WAL_MAX_PENDING_WRITES: number(1024, "最大待写入数"),
    WAL_MIN_FREE_BYTES: number(67108864, "WAL 文件系统停收预留字节数"),
    WAL_CACHE_MAX_BYTES: number(8388608, "WAL 内存缓存字节上限"),
    WAL_ARCHIVE_DIR: str(undefined, "WAL 归档目录；部署时使用 WAL 持久卷内路径"),
    WAL_GC_ENABLED: { type: "boolean", value: "false", description: "启用满足确认门禁的 WAL 归档及回收" },
    WAL_MAINTENANCE_INTERVAL_MS: number(60000, "WAL 维护周期，毫秒"),
    REPLAY_TARGETS_FILE: str(undefined, "独立重放目标注册配置文件"),
    WAL_REJECT_THRESHOLD: {
      type: "number",
      minimum: 0.01,
      maximum: 1,
      value: 0.98,
      description: "WAL 拒绝阈值比例 (0,1]",
    },
    EXPORT_BATCH_SIZE: number(200, "每批投影条数"),
    EXPORT_INTERVAL_MS: number(1000, "投影轮询毫秒"),
    PROCESSOR_SHUTDOWN_TIMEOUT_MS: number(10000, "关闭等待毫秒"),
    SOURCE_MAPPINGS_FILE: str(
      undefined,
      "高级覆盖：完整映射 JSON，宿主文件；省略自动生成",
    ),
    PROJECTION_TARGETS_FILE: str(
      undefined,
      "高级覆盖：完整 target JSON，宿主文件；省略自动生成",
    ),
    PROCESSOR_REQUIRE_COLLECTOR_ID: {
      type: "boolean",
      value: "true",
      description: "保留精确 Collector 身份校验",
    },
    PROCESSOR_ALLOWED_COLLECTOR_IDS: str(
      undefined,
      "允许的 Collector ID，逗号分隔；省略使用 COLLECTOR__COLLECTOR_ID",
    ),
    PROCESSOR_ADMIN_API_KEY: str(undefined, "非免凭证模式管理 API key", {
      writeOnly: true,
    }),
    PROCESSOR_ADMIN_API_KEY_FILE: str(
      undefined,
      "管理 key 宿主文件，优先于明文",
      { writeOnly: true },
    ),
    PROCESSOR_TLS_MODE: str(
      "disabled",
      "开发默认明文；required 时需配置证书以及自定义 Collector 配置",
      { enum: ["disabled", "required"] },
    ),
  };
  for (const suffix of ["CA", "CERT", "KEY"])
    processor[`PROCESSOR_TLS_${suffix}_FILE`] = str(
      undefined,
      "TLS PEM 宿主文件",
      { writeOnly: true },
    );
  for (const [key, spec] of Object.entries(processor))
    out[`PROCESSOR__${key}`] = spec;
  for (const [key, spec] of Object.entries({
    AUTHORITY_ENABLED: { type: "boolean", value: true, description: "启用共享权威查询；就绪检查要求共享库可读" },
    AUTHORITY_DEFAULT_SCOPE_JSON: str(undefined, "固定权威范围 JSON：tenantId/projectId/environment/smppSourceId/deploymentId"),
    QUERY_READINESS_TIMEOUT_MS: number(2000, "每个查询存储就绪探测超时毫秒"),
    QUERY_READINESS_CACHE_MS: number(1000, "查询就绪缓存毫秒"),
    QUERY_SNAPSHOTS_ENABLED: { type: "boolean", value: false, description: "启用013查询快照；必须与Target snapshotEnabled同时开启" },
    QUERY_SNAPSHOT_TARGET_ID: str("standalone-smpp", "查询快照目标身份"),
    QUERY_CURSOR_KEY: str(undefined, "至少32字节的游标签名密钥；未指定由联合部署生成并持久保存", { writeOnly: true }),
    QUERY_CURSOR_KEY_FILE: str(undefined, "游标签名密钥文件；优先于明文", { writeOnly: true }),
    QUERY_READER_REGISTRY_FILE: str(undefined, "离线切代 reader 注册文件，按实际宿主路径只读挂载"),
    QUERY_API_HOST: str("0.0.0.0", "Query 容器监听地址"),
    QUERY_API_PORT: number(8088, "Query 容器端口", 65535),
    QUERY_API_KEY: str(undefined, "非免凭证模式查询 key", { writeOnly: true }),
    QUERY_API_KEY_FILE: str(undefined, "查询 key 宿主文件", {
      writeOnly: true,
    }),
    ...Object.fromEntries(
      ["CLICKHOUSE", "AUTHORITY_CLICKHOUSE"].flatMap((prefix) =>
        ["URL", "USER", "PASSWORD", "PASSWORD_FILE"].map((suffix) => [
          `${prefix}_${suffix}`,
          str(
            undefined,
            `高级查询连接覆盖；默认继承${prefix === "CLICKHOUSE" ? "独立库" : "共享库"}；FILE 为宿主路径`,
            { writeOnly: suffix.startsWith("PASSWORD") },
          ),
        ]),
      ),
    ),
  }))
    out[`QUERY__${key}`] = spec;
  out.COLLECTOR_CONFIG_FILE = str(
    undefined,
    "高级 Collector YAML 宿主文件；必须维持 ProviderOps trusted ingress 与路由",
  );
  const integration = {
    RUNTIME__OTEL_ENABLED: "true",
    RUNTIME__OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel-collector:4318",
    RUNTIME__OTEL_SERVICE_INSTANCE_ID: "smpp-joint-development-1",
    RUNTIME__RUNTIME_INSTANCE_ID: "smpp-joint-development-1",
    RUNTIME__RUNTIME_DEPLOYMENT_ID: "joint-development",
    RUNTIME__PROVIDER_TELEMETRY_HOST: "0.0.0.0",
    RUNTIME__PROVIDER_TELEMETRY_INGRESS_ENABLED: "true",
    ADAPTER__PROVIDER_TELEMETRY_ENDPOINT: "runtime:7002",
  };
  for (const [key, value] of Object.entries(integration))
    out[key] = { ...out[key], value };
  return out;
}
export function template(specs) {
  return (
    "# SMPP + Telemetry 联合开发环境；仅隔离纯软件仿真网络。\n# Node >=22，Linux amd64/arm64；修改后执行 up 重建容器。\n# 唯一输入本文件，不 source shell，不继承宿主同名变量。FILE 参数为宿主路径。\n# 可选项保持注释；SHARED__URL 和 SHARED__PASSWORD[_FILE] 必须填写。\n\n" +
    Object.entries(specs)
      .map(([key, spec]) => {
        const { value, description, ...rules } = spec;
        const unit = key.endsWith("_MS")
          ? "单位毫秒；"
          : key.endsWith("_BYTES")
            ? "单位字节；"
            : key.endsWith("_SECONDS")
              ? "单位秒；"
              : "";
        return `# ${description}；${unit}规则 ${JSON.stringify(rules)}；默认 ${value === undefined ? "不传入/自动派生（见说明）" : JSON.stringify(value)}；重启生效。\n${value === undefined ? "# " : ""}${key}=${value === undefined ? "" : JSON.stringify(String(value))}\n`;
      })
      .join("\n")
  );
}
export function validate(input, specs) {
  for (const [key, value] of Object.entries(input)) {
    const s = specs[key];
    if (!s) throw Error(`UNKNOWN_CONFIGURATION:${key}`);
    if (value === "")
      throw Error(`EMPTY_CONFIGURATION:${key}: omit optional entries instead`);
    if (s.enum && !s.enum.map(String).includes(value))
      throw Error(`INVALID_ENUM:${key}`);
    if (s.type === "boolean" && !["true", "false", "1", "0"].includes(value))
      throw Error(`INVALID_BOOLEAN:${key}`);
    if (
      ["integer", "number"].includes(s.type) &&
      (!Number.isFinite(+value) ||
        (s.type === "integer" && !Number.isInteger(+value)) ||
        +value < (s.minimum ?? -Infinity) ||
        +value > (s.maximum ?? Infinity))
    )
      throw Error(`INVALID_NUMBER:${key}`);
    if (
      (s.minLength && value.length < s.minLength) ||
      (s.maxLength && value.length > s.maxLength) ||
      (s.pattern && !new RegExp(s.pattern).test(value))
    )
      throw Error(`INVALID_STRING:${key}`);
    if (s.format === "uri") {
      try {
        new URL(value);
      } catch {
        throw Error(`INVALID_URL:${key}`);
      }
    }
  }
  const result = Object.assign(
    Object.fromEntries(
      Object.entries(specs)
        .filter(([, s]) => s.value !== undefined)
        .map(([k, s]) => [k, String(s.value)]),
    ),
    input,
  );
  for (const [key, s] of Object.entries(specs))
    if (s.type === "boolean" && result[key] !== undefined)
      result[key] = ["true", "1"].includes(result[key]) ? "true" : "false";
  return result;
}
