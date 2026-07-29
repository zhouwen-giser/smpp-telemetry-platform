# SDAR 遥测仓库投影指南

## 边界

SMPP Landing 不直接复制到 SDAR 仓库。稳定路径为：

```text
ProviderOpsEnvelope → SMPP Landing → Canonical Fact → source-neutral Core/Relation → SDAR Target
```

## 启用步骤

1. 在 `config/projection-targets.json` 中启用 `sdar_shared_warehouse` Target。
2. 将 Target 的 `routeIds` 加入相应 Source Mapping 的 `projectionRouteIds`。
3. 用 `tableMap` 把本项目 Core 表映射到 SDAR 仓库实际表。
4. SDAR 仓库必须以 `fact_id + projection_id + projection_version` 幂等。
5. 对独立库和 SDAR Shadow 库比较数量、`fact_hash`、水位与 Relation 覆盖率。
6. 验证完成后才把 SDAR 仓库切为主查询目标。

## N×N 约束

不得在任一 Core 表增加唯一的 `sdar_task_id` 或 `smpp_task_id`。所有跨系统绑定写入 `entity_relation_fact`，并保留有效时间、证据、路由、尝试次数和置信等级。
