# 部署说明

## 开发环境

```bash
cp config/source-mappings.example.json config/source-mappings.json
cp config/projection-targets.example.json config/projection-targets.json
printf %s change-me > secrets/clickhouse_password.txt
printf %s change-admin-key > secrets/processor_admin_key.txt
docker compose up --build -d
npm run send:sample
```

OTLP/HTTP 按部署要求绑定 `0.0.0.0:4318`。OTLP/gRPC、Query API、ClickHouse 和 Grafana 使用 `TELEMETRY_BIND_ADDRESS`，Collector 管理/指标端口仅绑定回环地址；Processor 的 `8443` 只在 Compose 网络暴露。跨主机使用时应启用 qualification mTLS 配置并配置主机防火墙。

## 生产必须调整

- Runtime→Collector 和 Collector→Processor 启用 mTLS。
- 每个部署使用固定的 `SMPP_DEPLOYMENT_ID`，不得从 Runtime 自报值决定租户。
- ClickHouse 使用 migration、ingest、projection、query 四类独立账户。
- 将 Processor WAL 放在有备份和磁盘告警的持久卷。
- 移除 ClickHouse 公网端口，Query API 启用认证。
- Grafana 密码通过环境/Secret provisioning，不使用示例值。

当前执行环境未提供 Docker，因此最终容器 E2E 必须在部署机运行。
