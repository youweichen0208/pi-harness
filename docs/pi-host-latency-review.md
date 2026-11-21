# 宿主快照与真实 Coding Agent 耗时归因

日期：2026-11-21；机器：Apple M2 Pro / macOS arm64 / Node v22.22.2 / pi SDK 1.5.2 / pi-harness 1.34.7。

证据：
- `docs/review-data/host-latency.json`：修正口径后的三轮零 token 快照基准，schema v2。
- `docs/review-data/host-latency-baseline.json`：旧口径数据，保留用于追溯，不与新分位数直接比较。
- `docs/review-data/agent-task-latency.json`：DeepSeek Flash 四类真实任务，每类一轮，全部执行完成且结果正确。
- `docs/review-data/agent-task-trace-mock.json`：本地 SSE 自检，不计入真实模型结果。

## 结论

1. **完整快照大，是因为历史工具正文本身大。** `mixed@2000` 的单份稳态 snapshot 为 51,427,111 bytes，其中 toolResult content 为 48,729,300 bytes，**占 94.75%**；整个 light state 的 JSON value 仅 2,095 bytes。不是树、统计或扩展元数据膨胀。
2. **3.24 GB 是 forced-full 压测生成的未压缩 JSON 总量，不是正常 Coding 任务网络流量。** 基准每轮主动执行 20 次 `get_state`，每次强制全量；permessage-deflate 后的实际网络字节不在该计数中。同基准观测到的 snapshot_delta 单份未压缩 JSON p50 约 1.9 KiB，与全量相差四个数量级；真实任务新增工具内容的 delta 大小仍取决于新增内容。
3. **本次四个真实短任务里，模型往返是绝对主导。** 模型区间占端到端 94.1%–98.2%；宿主 onEvent/快照/WS 的 wall-time 并集为 6.4–18.4ms，占 0.49%–0.89%。这些宿主 span 可能嵌套在模型或工具区间内，占比不能与其他类别相加，也不等于可直接节省的时间。
4. **本样本中的工具调度空档很小，但不命名为纯调度。** assistant end→tool start 约 0.98–1.05ms；tool end→下一次 provider hook 约 3.46–6.45ms。它们包含持久化、扩展、上下文准备和宿主处理。
5. 因此，对这四个 DeepSeek Flash 短任务，继续微优化 Map 查询或 metadata hash 不会解释秒级体感差异。长历史强制 resync 是另一个高成本场景，应针对历史工具结果的传输策略，而不是把 forced-full 结果当成每次工具调用的开销。

## 真实 Agent Execution Trace

模型：`deepseek/deepseek-flash`；每类一轮；无排队；样本中未发生重试或压缩；当前工作树工具配置。密钥只注入测试进程环境，没有写入配置、trace 或报告。

所有样本同时满足：
- 执行完成：hostRequest 与 run 唯一关联，run settle，非 aborted/error，无超时、未匹配 toolCall、running tool、恢复状态或待发队列。
- 任务正确：精确短答/bash canary/目标文件内容通过独立断言，非目标文件 manifest 不变，工具序列符合任务要求。
- 已识别 provider 请求覆盖率：text 1/1，其余任务各 2/2，均为 100%。该分母不包含 SDK 完全不可见的内部请求。

| 任务 | 端到端 wall | 模型区间并集 | 工具区间并集 | 宿主 wall 并集 | 宿主占比 | 未分类 wall |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 纯文本 | 1,321.85ms | 1,262.63ms（95.52%） | 0 | 6.44ms | 0.49% | 57.28ms |
| bash→回答 | 2,310.01ms | 2,173.75ms（94.10%） | 79.27ms | 14.58ms | 0.63% | 53.78ms |
| read→回答 | 2,063.18ms | 1,995.49ms（96.72%） | 8.93ms | 18.39ms | 0.89% | 54.73ms |
| write→回答 | 2,989.79ms | 2,936.31ms（98.21%） | 5.58ms | 16.42ms | 0.55% | 43.21ms |

“未分类”是扣除 queue/model/tool/host 区间并集后的 wall time，包含 SDK 上下文转换、扩展和其他尚未拆分的处理，不能全部归给宿主。

### 模型请求与工具边界

| 任务 | 各次 provider hook→message end | provider hook→headers | 首个原始事件→首个可见增量 | assistant→tool gap | tool→下一 provider gap |
| --- | --- | --- | --- | --- | --- |
| 纯文本 | 1,262.63ms | 458.89ms | 781.07ms | — | — |
| bash | 1,402.24 / 771.51ms | 676.62 / 414.64ms | 381.39 / 323.50ms | 1.05ms | 3.46ms |
| read | 1,010.85 / 984.63ms | 261.01 / 230.67ms | 383.90 / 729.80ms | 1.00ms | 5.47ms |
| write | 2,193.72 / 742.60ms | 1,575.13 / 125.00ms | 362.34 / 532.99ms | 0.98ms | 6.45ms |

`provider_hook_to_headers` 不是纯网络 RTT；`first_event_to_first_visible_delta` 从原始 provider event 到规范化可见增量。两者都按 SDK 实际 hook 边界命名。`performance.now()` 测的是 wall time；本报告没有把它写成 CPU time，process CPU 归因标记为 unmeasured。

样本量只有每类一次，不能据此比较模型、推断稳定分位数或宣称所有长任务都只有同样比例。连续 10–20 次 bash、长历史、慢网络和其他 provider 仍需单独测量。

## 正式 Trace Off / Summary 验收

命令：`npm run accept:trace`。同一本地 OpenAI 兼容 SSE Mock 固定 20ms 到响应头、20ms 到正文；每种模式独立新服务，按场景和轮次 AB/BA 交错，五类场景各 3 轮，共 30 个对照单元。Off 同时设置 `PI_TASK_TIMINGS=off`、`PI_SNAPSHOT_TIMINGS=off`；Summary 设置 `PI_TASK_TIMINGS=1`、`PI_SNAPSHOT_TIMINGS=summary`。长历史使用真实 SDK `SessionManager` 生成的 400 turn / 1600 message 会话；表中耗时是已恢复 session 上的一次新任务，不是启动恢复耗时。churn 在同一客户端依次创建 40 个独立工作区 session，覆盖 32-session registry 淘汰边界，不代表数小时 soak。

所有 30 个单元均通过最终 canary、工具次数与完成状态断言。Off 的 Trace 写入和体积均为 0；Summary 的 append 次数精确等于 run_start/run_settled + provider_request + tool_end。延迟是 WS prompt 发出到正确最终答案且快照 settle，包含 Mock 固定延迟；下表为每组 3 轮的 p50，不设未约定的性能通过阈值。

| 场景 | Off p50 | Summary p50 | 差值 | Summary/Off | JSONL append | Trace 文件体积 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 纯文本 | 109.98ms | 110.77ms | +0.80ms | +0.73% | 3 | 5.40KiB / 1 文件 |
| 单次 Bash | 216.01ms | 225.82ms | +9.82ms | +4.54% | 5 | 10.25KiB / 1 文件 |
| 连续 20 次工具 | 2,250.03ms | 2,285.86ms | +35.83ms | +1.59% | 43 | 98.25KiB / 1 文件 |
| 长历史新任务 | 108.02ms | 111.40ms | +3.38ms | +3.13% | 3 | 5.40KiB / 1 文件 |
| 40-session churn | 2,410.34ms | 2,344.84ms | −65.50ms | −2.72% | 120 | 211.10KiB / 40 文件 |

测试专用 preload 在真实服务进程内每秒记录 `process.memoryUsage()`，并在任务前后主动 GC；不包含 Bash 子进程或浏览器。下表均为 MiB：post-GC Heap 是任务后的绝对值，Heap/RSS Δ 是任务前后 post-GC 样本之差。

| 场景 | post-GC Heap Off / Summary | Heap Δ Off / Summary | RSS Δ Off / Summary |
| --- | ---: | ---: | ---: |
| 纯文本 | 63.62 / 63.74 | 4.55 / 4.63 | 3.50 / 3.39 |
| 单次 Bash | 64.08 / 64.19 | 5.01 / 5.08 | 12.11 / 11.89 |
| 连续 20 次工具 | 66.01 / 66.32 | 6.94 / 7.23 | 16.72 / 18.97 |
| 长历史新任务 | 63.61 / 63.74 | 4.55 / 4.62 | 3.41 / 3.78 |
| 40-session churn | 70.32 / 70.96 | 11.24 / 11.84 | −4.09 / −35.39 |

Summary 相对 Off 的 post-GC Heap 绝对值高 0.11–0.63MiB；20 次工具的差异约 0.31MiB，40-session churn 约 0.63MiB。churn 的 Trace 磁盘增长约 5.28KiB/session，最终 40 文件、120 次 append。RSS Δ 出现负值，反映 GC、分配器与采样噪声，不能据此宣称 Summary 降低内存。每类只有 3 轮，结果用于验收当前实现和后续回归，不是稳定分位数或所有 provider 的保证。完整逐轮、自然/主动 GC、checkpoint 与磁盘数据见 `docs/review-data/trace-overhead-acceptance.json`。

## 快照体积与 forced-full 成本

### 单份稳态 snapshot 字段拆解

| 类别 | bytes | 说明 |
| --- | ---: | --- |
| toolResult content | 48,729,300 | 94.75%；主要来源 |
| 其他消息 content | 1,042,224 | user/assistant 正文与 toolCall 参数 |
| message remainder | 1,548,780 | id、role、模型、usage 等 |
| JSON keys/array syntax | 103,359 | 键名、分隔符与外层消息数组 |
| light state | 2,095 | tree/stats/model/taskProgress 等合计 |
| details / nestedCalls / envelope | 1,353 | 本夹具几乎为空 |
| **合计** | **51,427,111** | 8,000 条消息 |

夹具中截断后的工具正文理论值为 48,573,400 字符：50 条 large 各 capped 到 100,000，650 条 medium 各 65,536，1300 条 small 各 750；实际 JSON content bytes 还包含转义与数组结构。

### 修正后的耗时口径

| 指标 | p50 | p95 | 样本/说明 |
| --- | ---: | ---: | --- |
| forced-full build | 23.19ms | 188.26ms | n=66；含 currentMessages、append 检测、buildLightState 与装配，不含 WS |
| delta build | 15.72ms | 29.50ms | n=6，仅作量级参考 |
| currentMessages | 18.53ms | 26.21ms | 嵌套于 build |
| light state | 4.59ms | 165.23ms | 嵌套于 build；少数首轮样本拉高 p95 |
| metadata hash / snapshot | 2.91ms | 5.10ms | 每次快照汇总，不再使用每条调用伪 p50 |
| 冷 JSON.stringify | 125.91ms | — | 不含采样 byteLength |
| 采样 Buffer.byteLength | 43.49ms | — | 仅采样开启时发生 |
| 客户端 JSON.parse | 65.61ms | — | 大快照接收侧解析 |
| get_state 整体往返 | 620.27ms | — | 采样开；采样关为 575.86ms |
| detail 采样开/关往返比 | 1.077× | — | 观测到约 7.7% 逐报文字节扫描开销，因此 detail 不应长期开启；默认 summary 不执行此扫描 |

这轮数据只描述 forced-full/resync。旧报告把 `snapshot_total` 在 light state 之前截断的值称为完整构建、把无样本分位数写成 0、把 stringify+byteLength 合并，这些结论已撤回。

稳定性复核：第二次同参数三轮跑的 forced-full build p50/p95 为 23.32/190.00ms，与第一次相差均小于 1%；冷 stringify p50 为 125.67ms，工具正文字段占比仍为 94.75%，采样比为 1.074×。这说明本轮口径可复现，但不代表相对旧代码有性能改善。

## Review 修正与回归

- `snapshot_total` 现在覆盖 light state 与消息装配，WS 单独计时。
- 未采样分位数输出 `null`；metadata hash 使用每次快照汇总；reset 后保留核心 byte slots。
- WS 字节统一称 uncompressed JSON bytes，新增客户端 parse 与单份快照字段拆解。
- S6c mock 已改为“工具调用→匹配 toolResult→最终回答”，三轮均有 user/toolCall/toolResult/final answer，无重复结果或 notice。
- Agent Execution Trace 通过真实 SDK 契约测试：200ms headers 延迟、500ms 首事件延迟和约 1s bash 能分别恢复。SDK 1.5.2 的 message_start/update/end 对象身份不同，使用稳定 assistant timestamp 回退；并发/乱序请求标为 ambiguous/unmeasured。
- 四类真实任务与四类 mock 任务均分离 executionComplete/taskCorrect；Anthropic 旧投影的失败尝试保留在 `agent-task-latency-anthropic-failure.json`，不混入 DeepSeek 成功样本。
- ANSI 增加 C1 CSI 修复；toolResult identity 测试不再声称能检测原地改写。
- Trace 现默认开启并持久化有界 metadata，支持 `/trace` 时间线、崩溃恢复和 `/export` 静态 HTML／metadata JSON；默认快照采样为 summary，detail 才做逐报文 byteLength。
- Trace Store 可靠性验收使用真实文件系统覆盖 120-run 反复压缩与重开、活跃 run 保留、append/compact/prune 故障及后续恢复；失败不会中断 Agent/SDK 事件链。
- `/export` 安全验收覆盖闭合标签、script/iframe/meta/img、javascript URL、扩展/工具/模型字段和恶意文件名；真实浏览器离线打开下载 HTML 后，无脚本执行、外部请求、弹窗或 pageerror，攻击文本仍按原文可见。
- 最终检查：typecheck、协议同步、测试环境检查、设计令牌、双端 build 通过；`npm test` 为 186 文件 / 1,245 通过、1 跳过；Trace 浏览器回归通过。
- 完整 smoke 为 97/103。其中 5 项在干净 HEAD 同样失败；`wiki-assistant-test` 原脚本在当前树失败、HEAD 单跑通过，但其“等待旧答案”条件存在竞态，使用未入库 scratch 副本仅增加 1.5 秒等待后完整通过。原测试未修改，不能把 97/103 写成全绿。

复跑：

```bash
npm run bench:host -- --rounds=3 --out=docs/review-data/host-latency.json
npm run bench:task -- --mock --out=docs/review-data/agent-task-trace-mock.json
npm run accept:trace
node tests/execution-trace-test.mjs
# 真实请求会产生费用；密钥只从本地环境注入，不写入命令或报告。
DEEPSEEK_API_KEY=<local-secret> npm run bench:task -- --model=deepseek/deepseek-flash --tasks=text,read,bash,write --rounds=1
```

完整 typecheck/unit/smoke 结果见最终交付说明；本报告不把尚未运行的检查写成通过。
