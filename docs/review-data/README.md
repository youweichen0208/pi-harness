# Pi 1.0.4 审查证据

入口：[主报告](../pi-native-resource-review.md)。所有负载使用本地模型/MCP/OAuth 夹具，无真实模型计费。Windows/Linux 的本机资源指标不在此目录中。

## 文件

- `build.json`：干净安装方式、锁文件及关键生产产物 SHA-256、macOS 与 Pi 版本。环境文件里的 commit 是升级前基线提交；实际升级构建由这里的产物哈希和最终 v0.99.8 源码标识。
- `summary.json` / `resource-metrics.md`：三轮阶段统计、自然峰值、显式 GC 后留存、延迟分位数、长循环首末分钟及采样错误。
- `web-interaction.json` / `electron-interaction.json`：独立启动、真实 DOM click 后内容可见及两次动画帧的样本。不是物理输入到屏幕扫描输出的延迟。
- `package-size.json`：npm dry-run、唯一生产依赖文件、本机 macOS 包体积与哈希；未发布 npm。
- `native-tools-summary.json`：独立 SDK + MCP/Codemode 三轮加载/调用/释放；表中 parent 进程指标不包含子进程 RSS，子进程原始记录仍保留。
- `cleanup-audit.json`：所有采样中出现的 PID 在全部负载结束后的核对，按当前进程启动时间排除 PID 复用。检测范围不包含从未采到的进程。
- `native-reproductions.json` / `message-cache-reproductions.json`：已知缺陷的受控复现，PASS 表示证明问题存在，不是正常行为验收。
- `pi-104-upstream-fixes.json`：上游 1.0.4 专项回归。
- `upstream-comparison.json`：官方 v1.0.3 → v1.0.4 变更清单。
- `validation/`：本机功能验证日志。
- `release-verification.json`：正式发布状态、三平台工作流结果、附件体积及 GitHub API 提供的摘要；未重新下载附件计算哈希。
- `archive-manifest.json`：归档及其中 69 个原始文件的 SHA-256 校验清单。
- `environments.json`：各测量模式的环境元数据，便于不解压直接核对。
- `host-latency-baseline.json` / `host-latency.json`：宿主快照与工具输出基准（`npm run bench:host`，零 token）的旧口径/修正后结果，见 [宿主快照与工具输出性能归因](../pi-host-latency-review.md)。只含聚合时间、未压缩 JSON 体积、次数和单份快照字段拆解，不含会话正文；forced-full 压测字节不代表正常任务网络流量。
- `agent-task-trace-mock.json`：本地 SSE 的四类完整任务自检（`npm run bench:task -- --mock`），验证 run/request/tool 关联、执行完成与任务正确性，不是真实模型性能数据。
- `agent-task-latency*.json`：显式模型的真实短任务 Execution Trace 与耗时分布。主文件汇总 DeepSeek 四类成功任务，分文件保留各次运行，Anthropic failure 文件单独保留失败样本。只含模型/工具标识、时间、状态和环境元数据，不含提示词、工具参数或响应正文；mock 与真实结果不混算。
- `trace-overhead-acceptance.json`：`npm run accept:trace` 的正式 off/summary 对照。相同本地 Mock 下 AB/BA 交错、多次重复纯文本、单 Bash、连续 20 工具、长历史和反复创建 session；记录端到端延迟、服务进程 RSS/Heap、post-GC 留存、JSONL append/压缩次数与文件体积。结果只有数值指标，不含 transcript；没有未约定的性能阈值。

## 原始采样

`raw-samples.tar.gz` 保存 `sdk/`、`web/`、`electron/`、`web-default/`、`electron-default/`、`web-history/`、`electron-history/`、`native-tools/`。主负载使用显式空工具配置；`*-default` 是额外启用原生默认 Codemode/tool_search 的独立空闲基线；`*-history` 等待目标消息行数和身份稳定后测量长历史。

主负载各模式的 `events.jsonl` 记录阶段和结束时清理结果，`environment.json` 记录环境与锁文件哈希。每轮 `process.jsonl` 是后端每秒样本，`samples.jsonl` 是进程树及页面/桌面主进程采样。`gc:true` 与自然运行分开分析；未消费的 `gc-PID` 控制文件不是测量数据，不归档。MCP 补充测量的多个 Node 进程写在同一 `process.jsonl`，须按 pid/argv 区分。

在仓库根目录重新汇总：

```bash
tar -xzf docs/review-data/raw-samples.tar.gz -C docs/review-data
node tests/summarize-native-resources.mjs
```

清理核对只在本次测试机器、负载退出后运行才有意义，不能拿历史 PID 在另一台机器验证。新的正式测量应使用空输出目录；重用目录会追加 JSONL。探针只存在于测试进程，不进入应用构建。
