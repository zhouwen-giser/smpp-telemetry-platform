# 仿真游戏遥测版本切换

这些命令管理仿真遥测的查询数据版本，不控制真实设备。命令是离线管理工具：先停止摄取并正常关闭持有同一 WAL 的 Processor。CLI 会打开独占 WAL；Processor 仍运行时不能取得所有权。它不自动停止或重新配置服务，也不自动删除数据。

Query 配置 `QUERY_SNAPSHOTS_ENABLED=true`、`QUERY_READER_REGISTRY_FILE=/config/readers.json` 和持久 `QUERY_CURSOR_KEY_FILE`（至少 32 字节，所有重启保持相同内容）。注册表最多 16 个可信 reader，不接受游标指定的网络地址：

```json
{
  "version": 1,
  "revision": 1,
  "activeTargetId": "standalone-v1",
  "readers": {
    "standalone-v1": {
      "url": "http://original-clickhouse:8123",
      "user": "query_reader",
      "passwordFile": "/run/secrets/original-query-reader"
    }
  }
}
```

新的 `next-reader.json` 只包含单个 reader 的 `url/user/passwordFile`。路径与主机名必须在执行管理 CLI 和 Query 的环境中分别可用；凭据不会写入命令输出。推荐凭据文件，注册表与 WAL 均需私有权限。执行管理 CLI 的注册表父目录必须可写，以便同目录原子 rename；不要在容器内替换单文件 bind mount，宜由宿主管理或挂载整个配置目录。Query 可只读挂载该目录。注册表保留旧 target→reader 映射，重启后的旧签名游标仍按自身 target/generation/epoch 读取旧实例。

先使用现有 `replay` CLI 将完整 WAL（`fromSequence=1`、`throughSequence=当前末尾`、无 scope 筛选）重建到独立 ClickHouse 实例的全新 target/generation。新 target 需 `snapshotEnabled: true`；原 target 与新 target 的 writer 配置分别保留在管理用 `writers.json`。重放工具验证实例及数据库 UUID 隔离。作用于部分范围的重放可用于修复指定输入，但不能声明整个查询版本已完整重建。

以下命令路径以整仓编译输出 `dist` 为例；所有管理命令都需要 `--wal/--registry/--targets`：

```sh
node dist/telemetry-processor/src/packages/replay/generation-cli.js inspect REPLAY_ID --target standalone-v2 --wal /data/wal --registry /config/readers.json --targets /config/writers.json --next-reader /config/next-reader.json
node dist/telemetry-processor/src/packages/replay/generation-cli.js promote REPLAY_ID --target standalone-v2 --wal /data/wal --registry /config/readers.json --targets /config/writers.json --next-reader /config/next-reader.json
```

`inspect` 核对 completed ReplayJob、源 manifest、版本和 target 合同、逐输入完整输出与发布证据、无未发布 outbox，以及 reader 的真实 schema、数据库 UUID、完整快照计数和边界。`promote` 再核对旧 active reader 身份与原路由/写入层覆盖，持久化切换意图及生命周期，发布旧版本 `draining`/新版本 `active`，然后将注册表以私有临时文件、fsync、rename 和目录 fsync 原子替换。输入源和注册表变化会拒绝切换。

如果写入成功但确认丢失，或进程中途退出，使用输出或 WAL `generation:switch` 记录中的 switch ID 恢复。恢复会重试相同意图，已经提交的意图直接返回原结果：

```sh
node dist/telemetry-processor/src/packages/replay/generation-cli.js resume SWITCH_ID --wal /data/wal --registry /config/readers.json --targets /config/writers.json
```

切换成功后，以新 target 的 Processor 配置重启，移除旧 target 的主动消费配置；其他无关 target 保持正常配置。重启 Query 使其加载同一原子注册表与原有签名密钥，再恢复摄取。CLI 不提供不停机热切换；旧 Query 配置仍指向 draining 版本时，新首屏可能暂时返回 503。旧页游标在自己的有效期内仍可继续读取。

回退同样需要停止摄取并取得独占 WAL。以下命令仅在两代都完整覆盖当前 WAL 末尾、无未发布输出、旧代未退休且两 reader 的真实快照检查通过时执行。新代已接收旧代没有的输入时返回 `GENERATION_ROLLBACK_INPUT_BARRIER`，必须先通过独立重建/追平取得完整证据；不会丢弃新增输入直接回退。

```sh
node dist/telemetry-processor/src/packages/replay/generation-cli.js rollback SWITCH_ID --wal /data/wal --registry /config/readers.json --targets /config/writers.json
```

回退也生成可 `resume` 的持久切换意图、增加 registry revision，并保留两边历史 reader。成功后按相同顺序重启 Processor 和 Query。两代已有的合法游标继续定位各自实例。

active 发布器持续续签十分钟读租约。切换时 draining 版本保留至少十分钟读租约，覆盖最长五分钟游标；draining/retired 发布器刷新或重启不会重新激活自身，也不能继续投影业务输出。租约结束后才允许退休，退休同时解除旧 WAL consumer 对未来源段的保留责任：

```sh
node dist/telemetry-processor/src/packages/replay/generation-cli.js retire standalone-v1 --generation g1 --wal /data/wal --registry /config/readers.json --targets /config/writers.json
node dist/telemetry-processor/src/packages/replay/generation-cli.js gc-dry-run standalone-v1 --generation g1 --wal /data/wal --registry /config/readers.json --targets /config/writers.json
```

`gc-dry-run` 只在 retired、读租约已过且没有 snapshot outbox 时输出四条按精确 target/generation/epoch 限定的 ClickHouse 删除语句；它从不执行删除。保留期未过、时间无效或状态不明时不生成语句。schema 没有独立自动 TTL，以免破坏旧游标。实际数据库回收、归档生命周期和 WAL 状态维护仍需管理流程，不能声称总磁盘恒定。读租约结束且退休后，才可从后续注册表中移除历史 reader；在此之前不要停旧 reader 或移除其凭据。
