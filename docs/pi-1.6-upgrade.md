# Pi 1.6.0 升级契约

`@earendil-works/pi-coding-agent` 与 `@earendil-works/pi-ai` 精确锁定 1.6.0，内部 agent-core、schema、tui、mcp、codemode 同步为 1.6.0，宿主 `undici` 升级为 8.12.4。Node 最低版本仍为 22.19.0，Electron 保持原版本。使用原版 SDK，无补丁。依据官方 [v1.6.0 发布说明](https://github.com/earendil-works/pi/releases/tag/v1.6.0) 及本次安装产物。前一轮契约见 [Pi 1.5 升级记录](pi-1.5-upgrade.md)。

## 变化与宿主接入

| 上游变化 | 宿主处理 |
| --- | --- |
| 原生 `/export` 与 HTML 链接修复 | 原 Trace 命令改名 `/trace-export [html|json]`；`/export [html|jsonl]` 调用原生导出，OSC 8 自定义工具链接由 SDK 转换，不复制导出器 |
| HTML / JSONL 范围 | HTML 使用完整会话树，包含系统提示词和工具定义/结果，可能含其他分支与敏感上下文；JSONL 只含当前分支，可经原生 import 恢复。内存 Session 的 HTML 导出明确报错 |
| Web 导出安全 | 不开放 CLI 任意 `[path]`。生成前校验 client/conversation/session 归属、源文件大小、Entry 数和单客户端并发；写入 `<dataDir>/exports/` 唯一私有文件并限制最终大小。短期单次 token 绑定三类归属，HTTP 原子消费后 attachment 流式下载；完成、中断、超时、替换或 TTL 清理，禁止应用 Origin 内预览执行 |
| Runtime Diagnostics | 会话创建和 Runtime 替换后使用 `takeUnreportedDiagnostics()`，按原生 type/message 去重并保留 conversation 归属；`modelFallbackMessage` 独立消费，reload 仍走扩展资源诊断 |
| 扩展 render 只读数组 | `WebUIContext` 的 widget render 类型改为 `readonly string[]`，不原地修改上游数组；其他组件由 typecheck 和扩展回归覆盖 |
| GPT-6.2 Astra / Sol | 使用原生模型目录和默认模型，不改写用户选择。快照继续使用 `getAvailableThinkingLevels()`；GPT-6.2 Sol 不允许 `off`，Codex 的 `minimal` 映射由原生目录决定，不在宿主硬编码 |
| Qwen 与 Anthropic 策略 | 新模型、网关、密钥变量和官方 Anthropic 端点 message threads 默认策略随 SDK 获得，不复制模型清单或重写已有配置 |
| OpenAI reasoning notice | 不将 reasoning items dropped / cache miss 诊断视为截断错误，不触发 RunRecovery；传输重试和 MCP 工具恢复复用 SDK，不增加宿主自动动作 |
| find glob 语义 | 路径相对搜索目录；专项覆盖 `src/*.ts`、`**/src/*.ts` 和 `./` 前缀 |
| read / MCP / retry 等修复 | 随原版 SDK 获得，保留宿主事件投影、恢复、取消和 `agent_settled` 生命周期，不重复实现 |
| 私有提示词适配器 | 两个精确版本保护更新为 1.6.0；模板展开和系统提示词全文一致性测试通过后开放结构化编辑，不匹配仍 opaque/read-only |

协议 v64 新增 `session_export` 和受控 `/api/session-export` 下载；`protocol.ts` 保持唯一类型源。原生 JSONL、模型配置、凭据和历史会话不被升级改写。输出预算、Thinking-only/正文有界续接、重复输出隔离、Execution Trace 字段和恢复机制保持宿主实现，不用上游升级覆盖。

## 验证（2026-11-23，macOS arm64）

测试使用临时配置、隔离端口、本地模型/HTTP 夹具，不访问真实账号，不产生模型费用，不停止用户实例。

- `check:lockfile`、实际依赖树、`check:protocol`（v64）、`check:testenv`、`typecheck`、`build` 和设计令牌检查通过。SDK/pi-ai/内部包均为 1.6.0，生产 undici 为 8.12.4；Electron 构建工具自身的旧 undici 传递依赖不属于 Pi 生产请求链。
- `npm test`：190 个测试文件通过，1276 项通过、1 项跳过。包含新增 `session-export` 的归属、过期、重放、规模与并发测试，以及既有输出预算、来源、恢复和提示词契约。
- `pi-160-sdk-test.mjs`：原生 HTML 全树与 OSC 8 链接、当前分支 JSONL 和 Runtime import、诊断去重、内存 HTML 失败、GPT-6.2 Thinking 可用性及 find glob 新语义通过；已加入默认冒烟清单。
- `trace-browser-test.mjs`：真实浏览器中 `/export`、`/export jsonl`、`/trace-export json` 下载、非法路径拒绝、零模型请求、安全离线 HTML、重启和中断恢复通过。
- `session-export-protocol-test.mjs`：真实 WS/HTTP 下跨客户端/会话拒绝、同一 token 并发仅一次成功、重放与中途取消后的再次下载拒绝、替换失效及临时文件清理通过；已加入默认冒烟清单。
- `output-limit-test.mjs`、`output-limit-context-test.mjs`、`output-budget-responses-test.mjs`、`run-recovery-test.mjs`、`execution-trace-test.mjs`：当前本地输出预算、Thinking-only/正文续接、重复隔离、Trace 归因回归通过。
- 普通 Node `native-tools-desktop-test.mjs`：MCP/Codemode/reload/resume 与实际 HTML/JSONL 导出资源通过。
- macOS arm64 `electron-builder build --mac --dir --publish never` 通过；包内 `native-tools-desktop-test.mjs`（含 HTML/JSONL 导出）、`packaged-server-start-test.mjs`、`provider-auth-test.mjs` 通过。验证使用未压缩 `.app`，未生成或发布 DMG/ZIP。
- 完整 `npm run test:smoke`：107/107 通过，0 失败、0 超时、0 跳过、0 中断。首轮暴露的三处旧测试把 1.6 新增“无模型”诊断误当业务结果，已改为匹配各自错误/探针文本并复验，没有隐藏 Runtime 诊断。
- Windows/Linux 和真实 OAuth、模型计费仍由对应环境验证，不以本地模拟代替。

本次不提升应用版本、不发布 npm/Desktop Release，不提交或重启用户服务。
