# v0.3.0 测试报告

- TypeScript 源文件：76
- 遗留 `.mjs` 文件：0
- 源码目录 `.js` 文件：0
- TypeScript 编译：通过
- 自动化测试：19/19 通过
- Shell 语法检查：通过
- JSON 配置解析：通过

完整 TAP 输出：`docs/test-output-v0.3.0.tap`

说明：当前执行环境没有 Docker，因此尚未实际启动 ClickHouse、Collector、Processor、Query API 与 Grafana 容器；容器端到端联调需在安装 Docker Compose v2 的部署机完成。
