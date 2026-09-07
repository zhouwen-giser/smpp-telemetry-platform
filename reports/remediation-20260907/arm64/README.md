# 原生 ARM64 验收记录

**原生 Node、严格构建、核心回归和所选 ClickHouse 数据库资格 PASS。完整 ARM64 Runtime/Adapter 游戏链与七天持续运行未执行。** 本项目及测试均用于仿真游戏软件，不控制真实物理设备。

用户指定开发服务器 `cwsz@192.168.1.7`，专用公钥免密登录已验证，本机可运行 `ssh smpp-arm64-dev`。宿主和 Docker daemon 均为 aarch64，CPU 为 Kunpeng-920，支持 crc32。测试未使用 QEMU 或 amd64 容器冒充原生结果。

## Node 与源码验证

固定 Node 22.23.2 镜像已核验 OCI index → ARM64 manifest → config 摘要链，实际运行报告 `arm64 / v22.23.2 / SQLite 3.51.3`。因远端既有 Docker 代理不可达，使用唯一资格标签离线导入，未改变代理或已有服务。

严格 TypeScript、部署 JavaScript 检查和严格构建通过。先运行完整核心 175 项，再对最终业务事件及类型修复补跑 27 项；两组去重覆盖 179 个命名用例，不能写成单次 179 项 TAP。部署 24 项、类型守卫 6 项、Python 发布元信息 6 项与已有镜像合同 4 项通过，均无跳过。已验核心源码/测试/合同与最终交付包另作逐文件 hash 核对。

## 用户选择的 ClickHouse 复用验收

用户确认复用可运行的自编译镜像，实际版本为 **25.3.14.1**。镜像 ID：

`sha256:42ebc5b1c20c40e5745e53a2cf764dc97ff56bbeb2f594416f53efb944e3024c`

已创建并核验明确实际版本的复用标签 `smpp-clickhouse-qualified:25.3.14.1-42ebc5b1`，指向上述镜像 ID，旧标签保留。联合部署 `.env` 可使用 `CLICKHOUSE_IMAGE="smpp-clickhouse-qualified:25.3.14.1-42ebc5b1"`。

其旧标签为 `smpp-telemetry-clickhouse:25.3.14.14-arm64v8-source`。实际二进制报告 `ClickHouse local version 25.3.14.1.`，`VERSION_DESCRIBE=v25.3.14.1-lts`，`VERSION_GITHASH=d6202689cb5af95ff6e44f27ee892381b12f8279`。镜像 label 声明的 25.3.14.14 / 84d6b30 与这些值不同，差异完整保留；本次按 `reuse-25.3.14.1` 做兼容性验收，`releaseQualification=false`，未把它算作 25.3.14.14 发布通过。

| 实际资格 | 结果 |
|---|---|
| 两个独立数据库实例 | 各 13 项迁移首次全部 applied；再次运行 0 applied、13 skipped |
| 不可变查询快照 | 10,000 条记录、31 页无漏重，终态可达；迟到、DLQ 补发和游标边界通过 |
| 精确只读 reader | 真实 SELECT 权限与 ready/live 变化通过 |
| 生产 TargetManager | 实际 WAL/SQLite/ClickHouse 投影、ACK 丢失和恢复资格通过 |
| 两实例 generation | 重建、切换、恢复、回退屏障及旧游标资格通过 |
| 清理 | 两个唯一命名资格容器均已移除，无对应残留 |

测试从 `cwsz` 宿主用户进程运行，Node 可执行文件仅从已验证镜像通过普通 create/cp 提取到本次独立 `/tmp/smpp-arm64-20260907-8U2TSfi7`。未安装全局 Node，也未向测试容器挂载宿主 Docker socket 或 CLI。每套数据库使用无网络、2 GiB 内存、1 CPU、512 进程上限和 1 GiB tmpfs 数据目录；仅挂载本任务只读资源 XML，缩小后台线程池并限制 server 内存。正式部署配置未因此改变。

第一次实例启动受默认 512 个后台调度线程影响，触及测试进程上限并中止。原始 FAIL 与内部 fatal 日志保存在 attempts；修正资格资源 XML 后，完整数据库断言全部通过。不能用调整前的失败日志代替最终结论，也不能删除失败过程。完整分项见 `clickhouse-reuse-25.3.14.1/result.json`、四组查询日志、资源 XML 和清理记录。

## 保留的失败与边界

- 官方 `clickhouse/clickhouse-server:25.3.10.19` 在该主机上执行 `--version` 即退出 132 / SIGILL；没有以该镜像完成数据库验收。
- 默认 25.3.14.14 源码发布门禁保持不变。固定上游源码携带旧发布元信息，源码制包与 Docker 构建已修复生成和编译后实际身份校验，6 项 Python 测试通过；新版本编译按用户选择停止，未宣称该发布构建通过。
- 曾实际尝试独立源码构建，预算为 4 CPU、24 GiB、4096 进程、并行编译数 2。既有代理导致 Dockerfile 前端/基础镜像解析失败，固定官方 ARM64 Debian 镜像离线导入后已进入依赖安装。停止本次构建时只处理本任务客户端和预算容器，保留既有构建缓存。
- 自动审批曾拒绝将宿主 Docker socket 挂入 Node 测试容器；该方式未重试。随后获准使用上述普通宿主用户进程方案，实际数据库资格据此完成。
- 完整 ARM64 Runtime/Adapter 业务链、原 E1 取消/fault/丢响应场景和至少七天观察仍需单独完成。amd64 导航成功不替代这些结果。

主机、镜像、源码、命名 TAP 和分项状态见本目录各清单及 `result.json`。只使用本任务源码副本、公共配对配置、临时目录或 tmpfs；既有服务、业务卷、Docker daemon 配置没有更改。私钥、口令和私有运行配置不进入源码包或证据包。
