# v0.2.0 验收清单

- [x] 官方 OTel Collector 是外部 OTLP 唯一入口。
- [x] ProviderOps Pipeline 禁用 batch、queue 和 retry，Processor 状态可传回 Runtime。
- [x] Processor 在 WAL file sync 后返回 accepted。
- [x] recordId/hash 幂等与冲突隔离。
- [x] 独立 Target Checkpoint，单 Target 故障不阻塞其他 Target。
- [x] Landing、Canonical、source-neutral Core、Relation、Serving DDL。
- [x] 2 SDAR × 2 SMPP N×N 测试。
- [x] Query API 和 Grafana provisioning。
- [ ] 真实 Docker/ClickHouse/Collector E2E（当前构建环境无 Docker 时需部署机执行）。
- [ ] 生产 mTLS、独立 ClickHouse 账户、SDAR Warehouse Target 联调。
