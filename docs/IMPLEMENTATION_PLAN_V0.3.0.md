# v0.3.0 TypeScript 实施计划与完成状态

## 目标

把 v0.2.1 的 JavaScript 实现迁移为可持续开发的 TypeScript Monorepo，并保持四层架构、数据合同和部署方式不变。

## 实施项

| 工作项 | 状态 |
|---|---|
| 全部 Node.js `.mjs` 迁移为 `.ts` | 完成 |
| 增加根 TypeScript 构建配置 | 完成 |
| 增加公共 Types 与 Contracts 包 | 完成 |
| Processor TypeScript 编译与测试 | 完成 |
| Query API TypeScript 编译与测试 | 完成 |
| Schema/部署工具 TypeScript 化 | 完成 |
| Docker Builder Stage 编译 TS | 完成 |
| 一键部署脚本适配 TS 配置生成器 | 完成 |
| 中文使用与开发文档 | 完成 |
| 最终源码 ZIP 不包含 dist | 完成 |

## 保持不变的合同

- SMPP 输入：ProviderOpsEnvelope 1.1.0；
- Collector→Processor：同步严格 ACK；
- Processor 可靠边界：WAL `fsync`；
- ClickHouse：Landing→Normalized→Core/Relation→Serving；
- SDAR↔SMPP：通过独立 Relation Fact 表达 N×N；
- Projection Target：独立 checkpoint 与失败隔离。
