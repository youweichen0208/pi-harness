# Pi-Harness 宿主快照与工具输出性能归因

> 本文保留最初 M0–M2 的决策过程。最终计时边界、Agent Execution Trace 和真实 DeepSeek 任务数据以 `docs/pi-host-latency-review.md` 为准；早期“快照总耗时”“纯 stringify”“真实任务未测”等历史表述不再作为结论。

## Context

用户附带的《性能分析与优化建议》是静态审查（文档自称"不是实测性能报告"），要求"深度诊断和分析"。三轮后续 Review 已收敛出一条工作线：先在生产路径上拿到快照与实时输出的真实耗时，再由数据决定是否改代码；不得把宿主快照优化等同于"Pi-Harness 比 Claude Code/Codex 执行 Bash 慢"的答案。

本计划交付：在生产 `ClientSession` 里加一条**默认关闭、只读采样**的快照计时通道，新增零 token 基准脚本（微基准 + 生产快照路径实测），再用实测数据决定 M2 是否实施；M1（ANSI 展示层统一）独立实施。原始 Bash/模型往返问题明确不在本计划范围内。

### 已实测（本机 macOS arm64，Node 22.22.2，本轮已运行）

| 探针 | 结果 | 裁决 |
|---|---|---|
| `spawn('/bin/bash', ['-c', 'true'])` ×1 / ×20 | 5.4 ms / 49.8 ms | Shell 启动与上下文长度无关 |
| `bash -c 'git status --short'` | 19.4 ms | 慢的是 git 本身 |
| `buildSessionProjection()` @20000 msgs | 2.6 ms | 每 tool 调用 <0.1 ms → 原文 P2「增量投影」收益 ≈ 0 |
| JSONL 追加 6 万字符消息 @100/500/2000 entries | 0.024–0.027 ms | 持久化 O(1) |
| SDK `agent-loop.js:373-377` + `agent.js:147` | 默认 `toolExecution="parallel"`，仅同批含 `executionMode:"sequential"` 才串行 | 仓库唯一声明在 `server/database/extension.ts:8`，值 `"parallel"`；`server/subagents/` 为空 → **原文 P1「混合批次串行化」不成立** |
| `getShellConfig`（SDK `utils/shell.js:76`） | 无缓存；Unix 仅 `accessSync('/bin/bash')`；`where bash.exe` 仅 Windows 且已知路径未命中 | 条件性，仅 Windows 非标准路径 |
| 1.6 MB 字符串：`JSON.stringify` / `createHash+digest` / `Buffer.byteLength` / `split('\n')` | 3.62 / 1.64 / 0.99 / 0.04 ms | 仅字符串操作单价，**不代表它们出现在 toolResult 的真实缓存路径上** |

结论（本轮实测范围）：20 条短命令的宿主开销在 <100 ms 量级，不解释用户感知差距；差距在模型往返与工作流。

### 代码证据（本轮已读）

- `server/serialize.ts:289` `contentFingerprint` = `sha256(JSON.stringify(message))` + `WeakMap<消息对象>`。它在 `serializeCached`（`server/agent-service.ts`）与 `currentMessages` 中**只对非 toolResult 消息**调用（`m.role === "toolResult" ? `t:${m.toolCallId}` : ...`），因此工具输出正文不进入指纹。
- `serializeCached` 对 toolResult 每快照执行 `metadata = serializeMessage({ ...m, content: [] }, n)` + `sha256(JSON.stringify(metadata))`，在缓存查询**之前**；`content: []` 剔除正文，但 `nestedCalls`（≤256 条、含截断后的 `argumentsText`）与 `details` 仍在其中，真实字节数未测。
- `currentMessages()` 对每条消息再算一次与 `serializeCached` 相同的 key，另 `withSessionErrors` 与 `map(m => m.id).join()` 构造 `lastMessagesSig`（全仓无读者：`grep -n "lastMessagesSig" -r server web/src` 仅 3 处写 + 1 处声明）。
- `buildLightState()`：`estimateContextParts(session.messages, ...)` 全量遍历；`cacheWarmingView(session)`（`server/cache-warming.ts:56`）再遍历全部 entries；`getSessionStats()`（SDK `agent-session.js:3552`）遍历全部 entries 且再 `buildSessionProjection()`。
- `server/serialize.ts:174-200` 的 `toolResult` 分支直接取原始文本（不 strip ANSI）；`server/tool-output.ts` 的 `toolOutputUpdate()` 直接返回累计快照（`replace: true`，不 strip）。`bash_execution_update` 侧 SDK `bash-executor.js` 的 `appendText` 已 strip。SDK 包根未导出 `stripAnsi`（`dist/index.d.ts` 无该符号）。
- `server/run-recovery.ts:57-66` `rootId()` 已先判 `type`/`role` 再拼文本，无可删工作量。

## Approach

M0 → M1 →（按 M0 数据决定）M2。M0 与 M1 互不依赖；M2 每一条都有定量触发条件，不满足即跳过并在报告中写明。每阶段结束必须 `npm run typecheck` 通过，并按 Verification 对应条目验证。

### M0 — 生产路径采样 + 零 token 基准

#### M0a 生产快照计时通道（新增，默认关闭）

1. 新建 `server/snapshot-timings.ts`（仓库内无任何服务端计时容器：`grep -rn "performance.now()" server` 为空，故新建）：
   ```ts
   export interface TimingStat { count: number; totalMs: number; maxMs: number }
   export class SnapshotTimings {
       readonly enabled = process.env.PI_SNAPSHOT_TIMINGS === "1";   // 构造时读一次
       add(name: string, ms: number): void;   // !enabled 立即 return；names 上限 16
       count(name: string, n = 1): void;      // 计数型指标（命中/未命中）
       report(): { marks: Record<string, TimingStat>; counters: Record<string, number> };
       reset(): void;
   }
   ```
2. `ClientSession` 字段 `readonly timings = new SnapshotTimings();`。计时点（全部用 `const t = this.timings.enabled ? performance.now() : 0;` … `if (t) this.timings.add(name, performance.now() - t)`，`enabled=false` 时不调用 `performance.now()`）：
   - `snapshot_total`（`emitSnapshotNow` 整体）
   - `current_messages`（`currentMessages()`）
   - `light_state`（`buildLightState()`）
   - `serialize_cached`（`serializeCached` 整体）
   - `fingerprint`（`contentFingerprint` 调用处）
   - `metadata_hash`（metadata 构造 + sha256）
   - `cache_lookup`（key 计算 + `uiMessageCache.get`）
   - `stats`（`getSessionStats()` + `contextParts` + `cacheWarmingView`）
   - `codemode`（`CodemodeHistory.snapshot`）
   - `task_progress`（`deriveTaskProgress`）
   计数器：`cache_hit`、`cache_miss`、`metadata_bytes`（每次未命中累加 `JSON.stringify(metadata).length`）。
3. 输出：`server/index.ts` 的 `shutdown()`（`:1111`，`process.on("SIGINT"/"SIGTERM")` 均走它）中、`await service.disposeAll();` **之前** 加一段：
   ```ts
   const timingsOut = process.env.PI_SNAPSHOT_TIMINGS_OUT;
   if (timingsOut) writeFileSync(timingsOut, JSON.stringify(service.snapshotTimings()));
   ```
   其中 `AgentService.snapshotTimings()` 是新增公共方法，遍历 `this.clients`（`Map<clientId, ClientSession>`，见 `disposeAll` 的同款遍历）对每个 `cs.timings.report()` 做按名相加（`count`/`totalMs` 相加、`maxMs` 取最大），`ClientSession.timings` 为 `readonly timings = new SnapshotTimings()`。未设 `PI_SNAPSHOT_TIMINGS_OUT` 时不写文件。不使用 `process.on("exit")`（异步关闭流程下不可靠）。

#### M0b 基准脚本 `tests/host-latency-benchmark.mjs`

零 token、无浏览器。复用 `tests/native-resource-benchmark.mjs` 的既有约定与代码形态：`tests/lib/test-env.mjs` 的 `scrubHostEnv()`、`mkdtempSync` 临时 `PI_CODING_AGENT_DIR`、`arg(name, fallback)` 风格 `--` 参数、`--out` JSON、环境快照字段（复制 `arg()` 与 `usage` 常量）。

1. **fixture 分层**（真实 `SessionManager`；Large 组只做 100 条，避免 GB 级数据）：
   | 组 | 条数 | 每条 `toolResult` 文本 | 附带内容 |
   |---|---|---|---|
   | `small` | 100 / 500 / 2000 | `"line of output\n".repeat(50)`（~750 B） | 一个 `bash` toolCall |
   | `medium` | 100 / 500 | 64 KB | 同上 |
   | `large` | 100 | 1.6 MB | 同上 |
   | `nested` | 500 | 1 KB | `nestedCalls.calls` 20 条、每条 `argumentsText` ~2 KB（复刻 codemode） |
   | `mixed` | 2000 | 60% small / 30% medium / 前 50 条 large | 同上 |
   `toolName` 在 `bash`/`read`/`codemode` 间轮换；`assistant` 消息带 300 字符正文 + 一个 toolCall。
2. **S1 `shell-spawn`**：`spawn('/bin/bash', ['-c', 'true'])` ×20 串行。
3. **S2 `bash-tool`**：`createBashToolDefinition(cwd, { operations })`，`operations.exec` 为本文件 fake（`onData(64KB)`、resolve `{ exitCode: 0 }`），跑一次完整 `execute`。
4. **S3 `micro-cache`**：复刻 `serializeCached` 的 key/缓存逻辑（`Map` + `WeakMap`，文件顶部注释"必须与 serializeCached 同步"），每组 20 轮，报告 `missRate`、逐轮 `hitMs`、`metadataBytes/轮`、`fingerprintMs`、`dupKeyMs`（模拟"每快照为每条消息重算一次 key"的额外耗时）。**这只是回归基线，不作为 M2 的唯一依据。**
5. **S4 `light-state`**：`estimateContextParts` / `deriveTaskProgress` / `CodemodeHistory.snapshot` 各 20 次（用组内真实数组）。
6. **S5 `tool-delta`**：按 8 KB chunk 喂 1 MB 彩色日志（`"\u001b[32m" + "x".repeat(60) + "\u001b[0m\n"` 重复），记录每个 chunk 的累计文本长度、`toolOutputUpdate` 耗时、`stripAnsi` 耗时（若已实施 M1）；统计「累计扫描字节 / 最终字节」比值以量化二次增长。再用不同 chunk 节奏（8 KB、64 KB、按 4 ms 节流）各跑一遍，报告 p50/p95 与 `process.memoryUsage().heapUsed` 前后差。
7. **S6 `server-snapshot`（生产路径）**：用 `dist/server/index.js` 起一个真实服务（`PI_WEB_CWD` 指向 fixture 项目目录、独立 `PI_WEB_DATA_DIR`、`PORT` ≥8900、`PI_WEB_NO_BROWSER=1`、`PI_CODING_AGENT_DIR` 指向 fixture agent 目录、`PI_SNAPSHOT_TIMINGS=1`、`PI_SNAPSHOT_TIMINGS_OUT=<tmp>/timings.json`），用 `ws` 连接并发送 `hello` + `get_state`，然后对每组会话（通过 `switch_history`/`list_sessions` 打开的与会话**等价的最小动作**是 `get_state` 反复触发全量快照；若无法在不调用模型的前提下打开历史会话，则只测当前会话的 `flushSnapshot`）——**实施简化**：S6 只测「进程启动后对当前空会话连续 `get_state` ×20」，再把 S3 的 fixture 消息集通过 `SessionManager.continueRecent` 预置为该项目的最近会话后重启服务，使首屏快照直接携带大型历史；两次都读到 `timings.json` 的 `snapshot_total`/`current_messages`/`serialize_cached`/`metadata_hash`/`cache_hit`/`cache_miss`。SIGTERM 结束服务前 `process.on("exit")` 会写文件（`server/index.ts` 已有优雅停机）。
8. 输出：`--out`（默认 `docs/review-data/host-latency.json`）+ stdout markdown 表（机器、Node、SDK 版本、commit）。
9. `package.json` 增 `"bench:host": "node tests/host-latency-benchmark.mjs"`；脚本启动时若 `dist/server/serialize.js` 不存在则 `execFileSync('npm', ['run', 'build:server'], { stdio: 'inherit' })`。
10. **M2 决策规则（由 S3 + S6 共同决定；写进脚本输出）**：
    - 第 1 条（每条消息只算一次 key）：`dupKeyMs`（S3）在 `large` p50 ≥ 2 ms，或 S6 的 `current_messages` 中 key 计算占比无法拆分但 `current_messages` p50 ≥ 5 ms → 执行。
    - 第 2 条（toolResult 元数据 hash 移出命中路径）：S6 的 `metadata_hash` p50 ≥ 1 ms **或** S3 的 `nested` 组 `metadataBytes/轮` ≥ 200 KB → 执行；否则跳过。
    - 第 3 条（删 `lastMessagesSig`）：无条件执行（死代码）。
    - 第 4 条（`estimateContextParts` 增量化）：S6 `stats` p50 ≥ 2 ms **且** S4 中 `estimateContextParts` 占 `stats` 一半以上 → 执行。
    - 第 5 条（`cacheWarmingView` 复用 entries 遍历）：S6 `stats` p50 ≥ 5 ms 且 `getSessionStats` 无法单独拆分 → 执行。
    - 补充约束（Review 要求）：若 S6 中 `current_messages` 命中路径与 `serialize_cached` 命中路径合计 p50 < 2 ms，则第 1、2、4、5 条全部跳过，且报告中必须写明"生产路径实测不支持快照去重"。

### M1 — ANSI 清理统一到展示层（风险 LOW–MEDIUM）

层次：**原始层不动**（SDK `toolResult.content`、`bashExecution.output`、下载的全量日志保持原样）；**展示层统一**（实时 `tool_delta` 与持久化 `UiMessage` 用同一函数）；**传输层不变**（`replace: true`、`seq`、前端 200,000 字符上限都不动）。

1. 新建 `server/ansi.ts`：
   ```ts
   const ANSI = /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
   export function stripAnsi(text: string): string {
       return text.includes("\u001b") || text.includes("\u009b") ? text.replace(ANSI, "") : text;
   }
   ```
2. 实时路径：`server/agent-service.ts` 的 `case "tool_execution_update"`，在 `const update = toolOutputUpdate(event.partialResult);` 之后把 `update.delta` 换成 `stripAnsi(update.delta)`（`replace` 保持）。`bash_execution_update` 分支不加。
3. 持久化路径：`server/serialize.ts` 的 `toolResult` 分支，`raw` 改为 `stripAnsi(m.content.map((c) => (c.type === "text" ? c.text : "")).join("\n"))`；`truncate`/`nestedCalls`/`details` 不变。`bashExecution` 分支（`m.output`）保持原样（SDK 已 strip）。
4. 截断语义分开校验：实时层受前端 200,000 字符裁剪（`web/src/live-tool-output.ts`），持久化层受 `TOOL_OUTPUT_CAP = 100_000`（`server/serialize.ts:17`）——两者不统一，也不改。
5. 高频输出成本：M1 不引入额外缓冲或去重；若 S5 实测 `stripAnsi` 在 8 KB chunk 下的 p50 ≥ 0.2 ms 或「累计扫描字节/最终字节」> 50，报告中标注为已知的累计快照放大成本，不在此计划内改协议。**`replace: true` 截断不可行**：前端 `mergeLiveToolOutput` 以整段替换语义，截断会让内容错序。

风险与回退：`stripAnsi` 使持久化 `UiMessage` 文本与 SDK 原文不同。若 `npm run test:smoke` 出现依赖原始转义文本的断言，改为仅当 `m.toolName !== "bash"` 时 strip，并在报告中记录差异。

### M2 — 只执行 M0 规则命中的子项（风险 MEDIUM）

全部缓存仍归 `Conversation`（`msgIds`/`userSeqByTs`/`userSeqByKey`/`uiMessageCache`/`toolContentIds`/`toolContentSeq` 留在 `server/conversation.ts`，不迁移、不跨 Conversation 复用）。

**失效契约（定稿）**：
- *已证实不可变*：`state.messages` 中已持久化的 `AgentMessage` 对象（SDK `_appendEntry` 追加、从不原地改写；`agent-loop.js` 的流式 `partialMessage` 是新对象且不进入 `state.messages`）。对它们按对象身份缓存。
- *未证实不可变*：`nestedCalls`、`details`、`isError`、`durationMs`、`timestamp` 以及 `content` 数组内部。**这些字段不依赖身份判断：命中路径仍计算 `sha256(JSON.stringify(metadata))`**，只有 `content` 正文的序列化被 `content: []` 剔除在外的部分继续被覆盖。即：第 2 条**只把 metadata 的构造+hash 从"命中前"挪到"未命中后"，不改变它的存在性**——命中路径用 `Conversation.toolMeta: Map<string, { ref: object; sha: string }>`（key=`${key}#${n}`）缓存上一次的 `metadata` 浅引用与 hash；命中时比较 `metadata` 对象的 **5 个字段引用**（`m.nestedCalls`/`m.details`/`m.isError`/`m.durationMs`/`m.timestamp`），任一变化即视为未命中并重算。嵌套对象内部原地变化**无法被检测**——这是本条唯一残留盲区，缓解措施见下。
- 缓解：命中路径的 5 字段比对能捕获 `nestedCalls` 整体对象被替换（SDK 的 `tool_execution_update` 是替换式的）；对"同一 `nestedCalls` 对象内部原地改 `status`"这一理论路径，`metadata` 的 hash 不再重算——因此**第 2 条实施时必须同时加上下文**：`Conversation.toolMeta` 的条目在 `tool_execution_end`（`onEvent` 已处理该事件）时对相应 `toolCallId` 强制失效，确保工具结束后的第一次快照走未命中路径，重新读取 `nestedCalls.status === "done"`。
- `contentId`：`toolContentIds` 从"数组身份 → id"改为"数组身份 → `{ id, len, firstLen }`"，`len`（块数）或 `firstLen`（首个 text 块长度）变化即分配新 id；捕获原地改写与追加块。

子项（触发器来自 M0 第 10 条）：
1. **每条消息只算一次 key**：`serializeCached(m, entryId?, occurrence = 0, key?: string)`；`currentMessages` 的 `messageKey`/`contentKey` 合并为 `messageKey(m)` 只调用一次并传参；`CodemodeHistory`、`withSessionErrors` 回调等调用点不改（不传 `key` 走原逻辑）。
2. **metadata hash 移到未命中路径** + `Conversation.toolMeta` 5 字段比对 + `tool_execution_end` 强制失效。

### M2b — 删 `lastMessagesSig`（无条件）

删 `server/conversation.ts` 的字段声明、`makeConversation` 的初始化、`currentMessages` 末尾的 `const sig = rawMessages.map((m) => m.id).join("\u0001")` 与赋值、`agent-service.ts` 中 `conv.lastMessagesSig = "";`（同段 `conv.uiMessageCache.clear()` 保留）。

## Critical files & anchors

- `server/agent-service.ts` — `serializeCached` / `currentMessages` / `buildLightState` / `emitSnapshotNow` / `onEvent`（`tool_execution_update`、`tool_execution_end`）。
- `server/serialize.ts` — `contentFingerprint`（:289）、`toolResult` 分支（:174-200）。
- `server/conversation.ts` — `Conversation` 缓存字段组（`lastMessagesSig` 删除、`toolMeta` 新增）。
- `server/index.ts` — 退出钩子写 `PI_SNAPSHOT_TIMINGS_OUT`。
- `tests/native-resource-benchmark.mjs` — fixture、`arg()`、环境隔离、`--out` 的模板。

## Verification

前置：`npm run typecheck`。单测统一 `npm run test:unit -- <文件…>`。

1. **M0a**：`PI_SNAPSHOT_TIMINGS=1 PI_SNAPSHOT_TIMINGS_OUT=/tmp/t.json npm start` → 浏览器/`ws` 发一次 `get_state` → 停服务 → `/tmp/t.json` 中 `marks.snapshot_total.count ≥ 1`；不设 `PI_SNAPSHOT_TIMINGS` 时该文件不含任何 `marks`（验证 `enabled=false` 零成本路径）。
2. **M0b 基线**：`npm run build:server && npm run bench:host -- --out=docs/review-data/host-latency-baseline.json`。记录 S3 `dupKeyMs`/`metadataBytes`、S5 比值与耗时、S6 `snapshot_total`/`current_messages`/`serialize_cached`/`metadata_hash` p50 与命中率；按第 10 条规则逐项写下"执行/跳过 + 依据数值"。
3. **M1 单测**：新增 `tests/unit/ansi.test.ts`：`stripAnsi("\u001b[31mred\u001b[0m ✓") === "red ✓"`；`stripAnsi("a\u001b]0;title\u0007b") === "ab"`；`stripAnsi("a\r\u001b[Kb") === "a\rb"`；`stripAnsi("plain") === "plain"`；1 MB 彩色文本 ×100 < 300 ms。
4. **M1 一致性**：新增 `tests/unit/tool-output-ansi.test.ts`：同一份带 ANSI 的 `toolResult` 经 `serializeMessage` 后 `content[0].text` 不含 `\u001b`；同一文本经 `toolOutputUpdate` + `stripAnsi` 的前 500 字符与 `serializeMessage` 输出的前 500 字符一致。`npm run test:unit -- tests/unit/tool-output.test.ts tests/unit/live-tool-output.test.ts` 原样通过（`replace`/截断语义未变）。
5. **M1 真实 UI**：`npm run dev`，在长会话跑 `npm run build 2>&1 | tail -50`：执行中预览与执行后卡片均为纯文本；再跑 `printf '\033[31mred\033[0m\n'` 结果文本为 `red`；`git status --short` 输出与改前逐字一致。`npm run bench:host` 的 S5 累计字节 ≤ 基线 60%，且 `stripAnsi` p50 < 0.2 ms。
6. **M2 单测**：扩展 `tests/unit/serialize-cache.test.ts`（已存在）新增 test，用 1.6 MB toolResult + `nestedCalls` fixture：200 次遍历对象引用稳定；同 timestamp 两条 user 得 seq 1/2；改 `m.isError` → 新对象；原地改 `m.content[0].text` 同长度 → 新对象（`firstLen` 不变量不足时改长度）；替换 `m.nestedCalls` 对象 → 新对象；`tool_execution_end` 后同一消息 → 新对象。
7. **M2 协议回归**：`npm run test:smoke`（零 token）。判定标准（Review 要求）：**不**以"完整快照数量增加"为回归；而是确认 (a) 无数据变化时不产生新的完整快照，(b) 内容变化后前端在下一个 `snapshot_delta`/`snapshot` 内可见更新（smoke 已有编辑重问与会话切换用例）。
8. **报告**：`docs/pi-host-latency-review.md`（新文件，格式对齐 `docs/pi-resource-static-review.md`），三栏：实测（S1–S6 + 每项决定与数值依据）、未实测（模型往返 / Codemode / Windows 路径 / 跨产品对比 / 真实 Coding 任务端到端时间线）、定位声明（"本工作只回答宿主快照与工具输出开销，不回答 Bash 体感差异"）。

## Assumptions & contingencies

- 若 S6 无法在不调用模型的前提下打开历史会话（`list_sessions` 为空或切换需要 `prompt`）：改为用 `SessionManager.continueRecent(cwd)` 在启动前写好大型会话文件，使服务首屏即加载它；仍失败则 S6 只用当前会话并标记"生产路径历史会话样本缺失"。
- 若 M1 的 `stripAnsi` 使 `npm run test:smoke` 有断言依赖原始转义文本：按 M1 风险回退为仅 `toolName !== "bash"` 时 strip，并把差异写入报告。
- 若 M2 第 2 条实施后 smoke 出现"内容已变但前端未更新"：立即回退该子项（恢复命中路径重算 hash），保留第 1 条；报告中记录回退原因。
- 若 M0 第 10 条的补充约束触发（命中路径合计 p50 < 2 ms）：M2 只做第 1 条与 M2b，其余写入报告"未执行，生产数据不支持"。
- Windows `getShellConfig` 每次 `where bash.exe`：本机不可测，报告标注"条件性、仅 Windows 非标准路径、未实测"，不缓存（属 SDK，`AGENTS.md` 明确不改 SDK）。
