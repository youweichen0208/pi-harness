# 核心架构

## OMP 子任务完整输出

子任务详情保留工具结果的调用 ID、工具名和失败标记，有界预览不改变原生历史。宿主在 `omp_task_response` 中给工具结果附上现有 `toolOutputUrl`；下载请求增加可选 `taskId`，浏览器只传宿主生成的任务 ID，不能选择原生文件路径。长输出的下载按钮位于预览前，复用主聊天的完整／部分捕获提示。

宿主根据当前可见分支的父调用与已观察到的子调用建立唯一祖先链，拒绝过期、歧义及超过 32 层的链。只读 Bun 进程逐级核对原生 `task` 声明和生成的子历史文件；文件／目录不能被符号链接替换。OMP Task 共享顶层 ArtifactManager，因此从子历史解析输出来源、从顶层会话的输出目录读取原生文件，不把每个子任务误当作独立输出目录。同名工具调用在不同子任务中独立解析。

停止后仍可使用已显示的任务下载链接，不启动 Agent、不发送模型请求；重开生成新任务 ID，旧链接失效。离开当前分支或切换原生会话后再次核对归属，拒绝旧任务下载。文件缺失返回 404，非法归属返回 403。该只读下载能力不修复原生 Task 内部会话未继承宿主存储保护的问题，参见 `omp-task-storage-gap.md`。

## 原生上下文边界

当前代理入口采用 OMP，工具、原生 Task、提示词保存与显式重载遵循 [OMP 接入契约](architecture-omp.md) 和 [系统提示词架构](architecture-system-prompt.md) 的 OMP 章节。下方涉及 Pi SDK／旧服务文件的描述保留为历史参考，不能据此恢复已退休的代理控制行为。宿主不自动重发正文中的工具描述。

Workspace 跨仓库与知识库分析通过内置 `subagent` 原生工具启动只读子会话，见 [子代理架构](architecture-subagents.md)。它由父模型显式调用、返回同一工具结果，不触发宿主自动续跑。发送目标可带 workspaceId，原生队列消费时绑定来源范围，不向用户消息插入范围说明或改变附件正文。

会话由 pi 1.5.0 原版 SDK 创建。WebUI 只桥接用户输入、原生事件和界面交互；不覆盖原生 bash，不注入终端状态消息。原生配置文件、技能、用户扩展和官方 MCP/Codemode/tool_search 由 pi 加载。WebUI 设置支持显示偏好、界面插件可见性及原生配置管理；Extensions 管理用户明确选择的包；系统提示词页编辑用户选择的原生 SYSTEM/APPEND/上下文文件，空闲时原生 reload，下一次请求由 SDK 应用变化；来源、文件校验与运行中保存见 [系统提示词架构](architecture-system-prompt.md)。新会话、切换、恢复和重载共用同一个原生运行时工厂。历史 transcript 不会改写。

> 改代码前必读。本文档覆盖快照驱动、协议单源、安全边界、多对话并发等全局架构决策。

## 快照驱动

OMP 协议 v66：原生 `command_output` 投影到所属会话的 `UiState.commandOutputs`，与模型消息分开。记录为有界内存缓存，包含 worker 代数／事件序号生成的 ID 和接收时间；不写入 SDK 消息或 JSONL，不送回模型。普通聊天与 Wiki 共用时间线渲染。原生 prompt 回执中的 `agentInvoked: false` 表示本地处理，宿主回传 `commandExecuted: true` 与 `attachmentsConsumed: false`，防止空等模型回复；这不是语义执行成功或后台任务结束的证明。异步扩展稍后发出的 `prompt_result` 仍需单独接入回执关联，详见 OMP 迁移文档。

OMP 初次启动可能在 worker 就绪前推送会话快照。前端接收 snapshot/snapshot_delta 时保留当前连接的 ready 状态，仅 `ready` 握手可开放发送与 Wiki HTTP 自动恢复；断线重置准入。这样仍能展示启动阶段会话与扩展对话归属，而不会提前请求尚未完成初始化的工作区。

Pi 1.0 工具结果的 `nestedCalls` 投影为独立子调用记录（参数、状态、耗时与错误），不会伪造成顶层助手调用。工具返回的 image 块作为图片保留；工具执行增量和结束事件传递 `parentToolCallId`。虚拟模型快照保留用户选择的 `model` 并附带 SDK `session.routedModel`，模型控件显示实际路由。

模型编辑器只修改聊天模型和表单拥有的字段；保存时保留 image/classifier 条目、operations、headers、采样及其他未知字段。不同 operation 可以使用相同模型 ID。已保存的密钥不回传表单，留空表示保留服务器上的密钥。`model-config-preservation-test.mjs` 覆盖实际读写路径。

账号登录由 `server/provider-auth.ts` 桥接公开 `ModelRuntime.login/logout`。浏览器仅收到授权 URL、设备码或请求提示，凭据由 SDK 保存；响应同时匹配 requestId/promptId，取消和 dispose 中断待处理请求。OpenAI ChatGPT 登录的稳定设备 ID 来自 SDK SettingsManager。模拟 OAuth 回归不证明真实账号授权成功；浏览器回归验证授权码提交、取消及中英文展示。

模型选择目录共用 `server/provider-catalog.ts` 的精确 provider ID 策略，仅过滤 `openai-codex`：`ModelAdminService` 的内置状态（管理与首次引导共用）及自定义目录、`ClientSession.listModels`、节点 Agent 的 models 投影、`/model` 枚举。策略不作用于 SDK 注册、配置读写、认证存储或当前／历史模型投影，不自动迁移或切换模型。普通 `openai` 的 ChatGPT OAuth 继续使用原生认证桥。回归：`tests/provider-catalog-test.mjs`；弹窗搜索、草稿与响应式布局见 `tests/model-config-ui-test.mjs`。

OpenAI 代理由 `server/openai-proxy.ts` 在服务启动时安装，默认关闭。配置经同源、共享口令保护的 `/api/openai-proxy` 读写，按版本拒绝过期保存，原子写入 `<dataDir>/openai-proxy.json`；不属于项目或对话，代理地址不进入模型上下文。仅接受不含凭据的 HTTP/HTTPS 代理 URL，用户自行填写端口。分流 Dispatcher 仅代理默认 TLS 端口上的 `api.openai.com`、`auth.openai.com`、`chatgpt.com`，其他地址交还原 Dispatcher；失败不自动回退直连。启用时在 Node 宿主使用同一 Undici 版本的 fetch、WebSocket 和 Dispatcher，不修改 SDK 或进程代理环境变量。OMP worker 现在通过宿主启动快照读取同一配置，在各自进程内建立带随机认证的 loopback 转发层，再使用 Bun／OMP 的原生 HTTP_PROXY 与 HTTPS_PROXY 接口。仅官方默认 TLS 端口走应用上游；其他目标沿用原有 HTTP／HTTPS／ALL_PROXY 或直连，原生 NO_PROXY 与显式请求代理仍有其原生优先级。两个协议入口区分 ws/http 与 wss/https，不改 SDK、全局 WebSocket 类或用户配置文件；worker 内的代理环境只指向本进程转发层，宿主环境不变。保存后需重启服务以清除 SDK 缓存的长连接，`/reload` 不生效；浏览器授权页仍使用浏览器自身网络。`tests/openai-proxy-test.mjs` 用隔离 CONNECT/TLS/WebSocket 夹具验证 Node 宿主 token 端点、网络分流、鉴权和重启持久化，`--browser` 验证表单；不验证真实账号登录或地区可用性。 OMP 原失败复现、修复与原生 HTTP／OAuth／双 WebSocket 回归见 [代理接线记录](omp-proxy-gap.md)；Windows／安装包与真实账户验收仍需单独完成。

- **服务端是唯一事实源**：每次 SDK 事件后节流 60ms 推快照（`UiState`），浏览器只按快照渲染。重连只需重发 `get_state`。
- **增量快照**：OMP `flushSnapshot` 用 O(n) 引用比较检测持久消息的追加式增长，发送 `snapshot_delta`（轻字段 + `appended` 尾部，baseRev 链）。原生元数据刷新时，仅内容完全相同的 UI 消息复用引用；工具下载链接的投影也缓存，不修改原生消息。基准使用独立数组，原生事件追加不能回头改变旧基准。中途修改／截断、切换 conversationId 或原生 sessionId、新连接及强制 resync 返回全量 `snapshot`。前端按 rev 链合并，缺口触发防抖 `get_state`；`get_state` 和背压延迟补发恒返全量。回归：`snapshot-delta-test` 使用真实 OMP 工具及流式模型夹具，`--browser` 额外验证实际浏览器丢失增量后请求恢复；新连接的首个快照恒为全量。**测试适配**：持续观察状态的测试须处理两种消息，公共助手位于 `tests/lib/snapshots.mjs`；不能把最后一条全量快照当成当前状态。
- **WS permessage-deflate**：WebSocketServer 开启压缩（threshold 16KB），大会话多 MB snapshot 线上传输降数倍；小消息（notice/心跳）不压省 CPU。
- `/restart` 仅重建当前对话的原生运行环境，重新加载扩展代码并清除扩展内存状态；复用原 SessionManager，保留当前历史分支、模型、思考档位和手动终端，其他对话继续运行。任务或恢复操作进行中时拒绝重启；准备新运行环境失败时保留旧会话。重启期间拒绝项目/会话切换，新环境就绪后重新绑定扩展 UI 并推送快照。它不会重启服务端进程，也不会发起模型请求。
- `/reload` 使用带 `conversationId`、`requestId` 的 `reload_status` 事件发送运行中及完成状态，包含资源数量、名称、耗时和加载诊断；前端按请求更新同一条对话事件，不通过通用 notice 浮层。事件保存在当前标签页的 sessionStorage，刷新后仍可查看，不写入 Agent 上下文。
- **多标签页序列化共享**：emit 把同一消息对象发给客户端的所有 socket，index.ts 用 WeakMap 按对象身份缓存 stringify 结果——N 个标签页共享一次序列化，新 snapshot 即新对象自动失效。
- 序列化时**对象引用稳定**：`uiMessageCache` + 消息数组签名比对，消息没变就不重建数组，前端 `React.memo` 因此能跳过整条消息——**不要**破坏这个缓存（stable id、引用复用）。缓存使用完整内容指纹与原生 entry ID；同时间戳、相同前缀或内容相同的不同条目保持独立身份。指纹按不可变原生消息对象复用，plan 历史投影使用相同 entry 身份。
- 强停恢复在销毁、创建和绑定扩展的异步边界检查对话是否仍有效；删除或关闭期间失效的 runtime 会清理，异步 `session_start` 晚到的资源也会收到最终 shutdown。
- `UiState` 携带 `thinkingLevel`（当前生效）和 `availableThinkingLevels`（当前模型实际支持的级别，SDK 会把集合外的请求静默就近钳制——UI 只能启用这些，否则用户点"低/中"看起来"改不了"）。

### `message_delta` 实时增量通道

`message_update` 事件 → 只对**活动对话**推 `message_delta`（`conversationId` + 每对话单调 `seq` + `messageId = stream-<ts>`（与 `serializeStreamingMessage` 的稳定 id 一致）+ 实时 usage + 剥离 `partial` 后的 thinking/text delta）。它**不经 snapshot 通道**——`send()` 背压只丢 snapshot，增量永远可达，大会话不再因背压停更。前端 `applyMessageDelta`（`web/src/message-delta.ts` 纯函数、不可变——StrictMode 双调 reducer 会把原地 mutation 加倍）patch `streamingMessage` + `stats.tokens`；seq 缺口触发防抖 `get_state` 重同步；snapshot 权威收敛。首个增量先于快照到达时，新建流式消息必须带 `role: "assistant"`，确保思考块和命令归入同一回复，避免快照补齐前出现空白头部与间距跳变。

输入框用量入口使用 SDK `getSessionStats()` 的当前上下文总量、窗口大小和累计 token 用量；每条 assistant 消息仍序列化其模型返回的 `input/cacheRead/cacheWrite/output`。弹窗只显示上下文窗口总量与缓存命中率，后者按 `cacheRead / (input + cacheRead + cacheWrite)` 计算。模型接口不返回「系统提示、工具、对话、附件」四类上下文精确值；`server/context-breakdown.ts` 保留归一化估算供协议数据使用，界面不展示分类估算。缓存数据不能推断服务商缓存失效的具体原因。

同时：delta 活跃期（1.5s 内有增量）snapshot 降为**事件驱动检查点**——agent_settled / tool_execution_end 立即 flush，其余事件走 2s 兜底定时器（增量负责流畅度、快照只做边界校准）。单测：`tests/unit/message-delta.test.ts`。

### Codemode 持久展示记录

协议 v52 的 `UiState.codemode` 从当前持久分支定位最近真实用户请求，保留压缩前的调用元数据与当前运行详情。它不属于模型上下文，不修改 `messages` 或原生 JSONL。新请求替换记录，自动提醒不重置；切分支、恢复及刷新以权威快照为准。详情见 architecture-plugins.md「原生 Codemode 卡片」。

### `tool_delta` 同协议

SDK `tool_execution_update.partialResult` 是累计输出快照，服务端发送 `replace: true`，前端替换当前工具输出（包括空快照），避免重复拼接。`bash_execution_update` 才是真正的增量，保持追加。两条路径均保留浏览器输出长度上限。协议版本 22 要求旧前端刷新。

协议 v47 起，`tool_delta` 可携带 `subagents` 结构化进度。服务端只从原生 `subagent` 工具提取白名单字段（sourceId、来源名、根目录、任务、阶段和当前 source 工具），最多 8 项并限制字符串长度，不透传扩展的任意 details 或完整子会话。`tool_execution_end` 清除当前工具动作，避免仍显示旧读取状态。普通文本增量省略该字段时保留已有进度，空数组则替换旧快照；生命周期及最终报告投影见 [子代理架构](architecture-subagents.md)。

也带 `conversationId` + `seq`，与 message_delta 共享同一每对话单调序列（`conv.deltaSeq`）；前端按对话 Map 追踪 seq，仅活动对话缺口触发重同步（后台对话切回时 snapshot 收敛）。

### 协议版本协商

`hello` 可带 `protocolVersion`，`ready.serverVersion` 回带运行中 pi-harness 包的版本（不是 pi SDK 的 `VERSION`，底栏也显示此值）；前端比对协议不一致时显示持久刷新横幅（应用原地更新后「界面新的/WS 旧的」混跑防护）。常量在 server/ 与 web/ 各一份 protocol-version.ts，`check:protocol` 校验两份一致——改协议时必须同步 bump。

## 全局缓存预热（Pi 1.5.2）

`cache-warming.ts` 只调整原生全局 `cacheWarming` 的缺省读取：没有明确值时使用 `streaming`，显式 `off` / `streaming` / `idle` 保留；项目配置不能开启付费预热。界面通过 `set_cache_warming` 请求原生 SettingsManager 持久化，并串行同步普通、Wiki、后台及 SSH 的已加载会话；新创建与替换的会话也登记，dispose 时注销。子代理继续使用独立显式 `off`。原生 SDK 负责调度，宿主不增加预热模型请求。

快照 `runSettings.cacheWarming` 是全局模式，`stats.cacheWarming` 投影原生状态、原因、nextWarmAt 与本会话费用。费用只从原生 SessionManager 的 `usage/kind=cache_warm` 累计，范围与原生 `getSessionStats()` 一致，已包含在总费用中；不会写第二份账本或插入聊天记录。`entry_appended` 更新快照，但预热用量不能重置任务静默计时或伪造任务活动。输入框用量详情打开时，每 5 秒发送所属 conversationId 的 `get_cache_warming`；关闭、切会话或卸载即取消，隐藏页面不发送。

回归：`tests/cache-warming-test.mjs`（原生设置优先级、并发写入、普通/Wiki/SSH 同步、费用与活动隔离、持久历史及 SSH 退出竞态，零模型请求）。

## 协议单源（types.ts 是 re-export shim，不再手工同步）

`server/protocol.ts` 是唯一事实源；`web/src/types.ts` 用 `export type * from "../../server/protocol"` 全量再导出（纯类型，构建时擦除），前端本地类型（FileListing/ToolStatus）附在 shim 下方；FileContent 直接从 ServerMessage 提取。

新增/修改任何消息：只改 `protocol.ts`，然后在 `server/index.ts` 的 `dispatch` switch 和 `web/src/use-chat.ts` 的 `onmessage` switch 各加一个分支。注意 protocol.ts 必须保持**纯类型导出**（不能加 const/function 等运行时代码，否则破坏 type-only 前提）；`npm run check:protocol` 守护这两个不变量。

## 安全边界

- **默认只绑 loopback**（`PI_WEB_HOST`，默认 `127.0.0.1`）：本地个人工具不暴露到网络；局域网/容器需显式 `PI_WEB_HOST=0.0.0.0`（docker-compose.yml 已内置，Docker 端口映射才能工作）。
- **WS 升级做 Origin/Host 同权威校验**（`server/index.ts` 的 `originAllowed`，`WebSocketServer({ noServer: true })` + 手动 `handleUpgrade`）：Origin 存在时其 hostname+**有效端口**必须与请求 Host 一致（浏览器里 `example-host:8445` 与 `example-host:9443` 是不同源）；非浏览器客户端（无 Origin）放行；`PI_WEB_ALLOW_ORIGINS` 白名单绕过（dev:server 已内置 `http://localhost:5173,http://127.0.0.1:5173`，反代场景自配）；`PI_WEB_ALLOW_HOSTS` 可选严格 hostname 白名单。**不要**加回「本地任意端口放行」——那正是提案要修的洞。
- **OMP quiesce 准入控制**（`OmpChatService.quiesce/unquiesce`）：进入排空后拒绝新 prompt（含斜杠输入，不推断扩展命令是否调用模型）、新运行实例、编辑分支／派生及新 PTY／命令运行；原生存量任务继续跑完，读取、已有连接重连及停止终端仍可用。已在内存中的 clientId 可以 attach 查看存量，**全新客户端 attach 抛 `QuiesceRejectedError` → index.ts 以 4403 关 WS**；unquiesce 后恢复接入。`tests/quiesce-test.mjs` 使用真实 OMP 和本地模型验证拒绝回执不会进入队列或随后执行、存量任务完成、终端准入、Origin 校验和凭据不下发。
- **控制 socket**（`server/control-socket.ts`）：CLI 的 `server status|quiesce|unquiesce` 经本地 mode-0600 unix socket / Windows 命名管道（`\\.\pipe\pi-harness-<port>`）与运行中进程通信，`status` 报告真实 socket 数（`noteSocketOpen/Close`，index.ts 维护）、active/pending 计数、quiesce 状态；无鉴权 HTTP 端点。
- **provider headers 不下发浏览器**（`models_config` 不再携带 `headers` 字段，可能含 Authorization/API key）：`saveModelConfig` 保存时若 config 无 headers 则保留旧值（`prevHeaders`）。`UiProviderConfig.headers` 已从 protocol.ts / types.ts 删除，前端没有任何地方编辑 headers（仅 apiKey 经独立消息 `set_provider_api_key` 走浏览器）。
- **dev 兼容**：vite :5173 代理 /ws 到 :8788 时 Origin(:5173) ≠ Host(:8788)，靠 `PI_WEB_ALLOW_ORIGINS`（dev:server 内置）放行，勿删。

控制 socket 的运行中对话计数包含主聊天／Wiki 原生 `busy`、共享 Playground 以及 SSH 工作。初始化、待处理 RPC、排队、原生恢复和停止清理均按原生忙碌状态计入，不能仅以 `running` 判断已排空。Playground 在多个浏览器订阅下只计一次；SSH 从连接表移除后，尚未结束的 Agent 清理仍单独计入。清理完成后计数归零，不长期把已关闭实例计为忙碌。

排空期间 `playground_chat/open` 只返回现有状态投影并订阅后续事件，不打开／刷新 worker；首次查看、停止后查看、服务重启后查看均遵守此规则。已有任务可完成，停止、恢复取消和回执查询仍可用；发送、新建、切换、模型／思考修改和重新读取历史被拒绝，排空解除后由下一次明确操作恢复。实际控制 socket／原生 worker 回归见 `tests/playground-drain-test.mjs`；SSH 断开清理与原生取消边界继续由 `node-workbench-test.mjs`、`omp-restricted-recovery-test.mjs` 覆盖。

OMP 的独立包写任务由控制 socket / CLI 另报 `activePackageOperations`，不能仅凭运行中对话为零判定可退出；排空拒绝新包写任务，已有包任务继续执行。服务关闭会停止独立包 worker，无法确认完成的操作保留为结果未知，详见扩展架构的 OMP 个人包管理。

## 主题

只有一套固定主题，写死在 `web/src/styles.css`（浅色底 + Inter/IBM Plex Mono 自带字体 + 深色代码/终端区块），没有主题选择、切换事件、`/api/themes` 路由或用户自定义主题目录。`web/src/theme.ts` 现在只保留 `buildTermTheme()`（把 `--term-*` CSS 变量转成 xterm 调色板）供 `TermXterm.tsx` 在终端初始化时读取，以及一个未使用的 `THEME_CHANGE_EVENT` 常量占位。

## 多对话并发

- 每客户端 `convs: Map<convId, Conversation>`，**每个对话一个独立 `AgentSessionRuntime`**：`new_chat` 新建 runtime + 新 session 文件（旧对话继续在后台跑，不中断）；`switch_conversation` 只换 `activeId`（不碰其他 runtime）；`runtime`/`session` 访问器指向当前活动对话。**对话按项目归属**：`conv.cwd` 即所属项目，每个项目各自的活动对话互不干扰。
- **`set_cwd` 不再重建当前对话**——改为切到目标项目自己的对话（该项目最近活动的那个；没有则新建一个并恢复该项目最近的持久会话）。
- **「运行的对话」列表生命周期**（每个对话 `listed` / `promptedSinceActive` / `lastActiveAt` 三字段）：
  - 入列：活动对话**正在流式输出时**被挤到后台（new_chat / switch_conversation / set_cwd）→ `listed=true`；
  - 留在列表：后台跑完不移出（用户可能还没看结果）；
  - 移出：打开它（切为活动）→ 没有继续对话（期间没发过 prompt）→ 切走时 `displaceActive()` 返回它，`removeConversation` 释放 runtime（会话已持久化，历史列表仍可恢复）。
- 新建普通会话只复用当前项目的空白会话；其它项目缓存的空白运行实例不参与复用，避免新建时跳回先前项目。浏览器回归：`tests/project-new-chat-test.mjs`。
- 上限 `MAX_OPEN_CONVERSATIONS = 8` **按项目计**，超出时 new_chat 发 warning notice。
- 所有对话共享**一个 ModelRuntime**（首个对话创建时播种，`makeRuntimeFactory` 传入复用）——顶栏换模型对全部对话生效。**消息序列化缓存（msgIds/uiMessageCache/签名）按对话隔离**：两个对话可能产生相同的 (role, timestamp) 键，共享会串号。
- `snapshot` 带 `conversationId`；`conversations`（ServerMessage）推当前活动对话及当前项目已入列的后台对话。新对话尚未落盘时，活动项仍可在左栏显示；`switch_conversation`（ClientMessage）只在同项目内切换。
- 删除历史会话（`delete_session`）的保护条件按“真实占用”区分：活动对话永远拒绝（先切换到别的对话）；后台对话仍在流式输出或有待发队列时拒绝；**只有仍在运行的 PTY 才因终端拒绝**，并点名终端标题。已退出终端只剩滚动回放，它的 tab 在别的对话里无法关闭，因此不再阻塞删除——否则一个已退出的 shell 会让该会话永久无法删除。退出终端仍参与 `displaceActive()` 的保活判断（用户可能还要看输出）。回归：`tests/delete-session-terminal-test.mjs`（已退出终端可删、活终端拒绝并点名、活动对话拒绝）。
- `switch_session`（恢复持久会话）会为目标会话创建独立 runtime，再按上述生命周期把当前对话移到后台；若目标会话已在运行列表中则直接复用其 conversation，绝不因打开历史记录中断当前生成。回归测试：`tests/switch-session-background-test.mjs`。`edit_message` 默认在同一会话文件内分支重问，用户可选择派生新文件（见 [会话树](architecture-session-tree.md)）；`dispose` 遍历销毁全部对话；attachSink 重连时补推 conversations。
- 前端：左栏「运行的对话」区（≥1 个时显示，活跃高亮、流式绿点），MessageList 以 conversationId 为 key 强制切换重挂载。
- `/new` 是宿主保留命令，通过 OMP 公开 RPC `new_session` 切换当前原生会话，复用 conversationId、worker 和手动终端；新 ID／文件、上下文与用量重置、旧历史保留及扩展 `session_before_switch` 取消均由 SDK 负责。OMP 18.20.0 的文本 `/new` 只有 TUI handler，不能将它当普通 RPC prompt，否则会进入模型。宿主不执行该命令的 input hook，仍执行原生会话切换 hooks；参数拒绝、附件不消耗，不配置模型也可使用。操作持有导航权，取消不改变会话，结果未知不重发；成功回执携带原 sessionId 和 commandExecuted，供输入框清除所属草稿。新建空会话由原生 SessionManager 落盘，Stop／宿主重启后可以恢复。“新对话”按钮仍创建独立 runtime，允许原对话后台继续。原生 `/compact` 保持 OMP RPC 文本分发，摘要和取消由 SDK 负责；其他命令目录／输出的完整迁移仍待完成。回归：`tests/native-session-commands-test.mjs`（本地模型、真实 OMP／PTY、扩展取消与挂起、运行中及后台隔离）；`tests/new-session-draft-browser-test.mjs`（真实 WS、延迟回执、新草稿与刷新保护）。
  `/new` 的 RPC 还需进入元数据串行队列：后台 refresh 会同步原生配置并占用 worker 写入准入。出队重新核对 Stop／代数，不能让被撤销的切换在新 worker 上执行；锁定配置的竞态与排队中 Stop 有原生回归，见 `docs/review-data/omp-new-session-race.json`。

## 其他桥接

### 工具结束实时状态（`tool_status`）

服务端 `onEvent` 监听 `tool_execution_start/end`（AI 调工具路径，注意区别于 `bash_execution_update`——那是 `!cmd`/终端直接执行路径专属）。`tool_execution_end` 触发时立即推 `tool_status`（toolCallId/toolName/isError/exitCode/durationMs），**先于** toolResult 快照落盘——浏览器 tool 卡片随即从「执行中」切到「已结束 · 等模型 · 耗时」，一眼区分「命令还在跑」vs「命令完了在等模型响应」。退出码统一优先读取 `structuredContent.exit_code`（含 0），其次是旧 `details.exitCode`，仅旧错误结果回退文本正则；`tool_execution_start` 时刻记在 `conv.toolStartTimes`（按对话隔离）算真实执行耗时。前端状态回落到权威 toolResult；`toolStatuses` 在结果落盘后清除，仅为 27a 命令卡保留当前 transcript 中 bash 的实测耗时，切换会话或工具移出 transcript 时清除。历史无计时记录时显示未知，不估算执行用时。

### 模型／工具静默状态（`agent_silence`）

服务端在运行中连续 3 分钟没有 SDK 事件时，按 `conversationId` 推送 `agent_silence`，并根据正在执行的工具区分模型等待和工具运行。任意后续 SDK 事件会发送 `active` 清除状态；重连时重放仍有效的静默状态。浏览器忽略工具静默事件，只为模型静默在输入框上方显示状态行，同步输入框和底栏，并持续更新时间。浏览器只为纯文本、无工具调用的模型静默轮次提供用户点击的手动重试；宿主不自动重发。前后端排除原生压缩和重试阶段，服务端核对当前用户轮次及工具记录，中断后再次检查归属才发送。WebSocket 心跳只表示浏览器与本机服务连接正常，不代表模型接口已响应。

长时间持续输出思考时不再显示额外时长警告（#126），用户仍可使用输入框的停止按钮；真正没有 SDK 事件的静默状态继续按上述规则显示。思考菜单单独提供「关闭」档：「极简」仍开启思考预算，部分 Anthropic 兼容服务会忽略预算。

### 思考复读保护（#173）

OMP 使用原生 Loop Guard，保留 `model.loopGuard.enabled` 和 `checkAssistantContent` 设置；默认也检查正文。`worker-control.ts` 在原生 message_end 订阅内用公开 `AIError.Flag.ThinkingLoop` 判断，立即清空队列并调用公开 abort，阻止本轮错误后的重试与排队续跑。只在 Node 收到事件后发 abort 会晚于原生队列处理，因此中止准入放在 worker 内。宿主收到专用元数据事件后通知所属 conversationId，并关闭该 OMP 运行实例及其后台工作；其他对话继续运行。错误和额度截断不显示为成功，手动继续才会打开新实例。

OMP 的该错误原生 content 为空，原生失败记录保留，宿主不改写历史。旧 Pi 的 `ReasoningRepetitionWatchdog` 仅留在旧对照源码，未用于 OMP 生产入口。输出额度遵循 OMP 模型默认值或用户显式覆盖。`reasoning-repetition-test.mjs` 已改为真实 OMP + 本地 Anthropic/OpenAI 流，覆盖后台与兄弟对话、开启重试时不自动续跑、原生开关、有效 thinking/工具结果、停止后继续和恢复历史。诊断开关与验收边界见 `deepseek-windows-validation.md`。

### 当前任务进度（`taskProgress`）

服务端只在当前用户轮次至少调用一次工具后，从权威 transcript 推断当前任务；纯聊天的 taskProgress 可以为空，右栏任务页保持空白，不显示无任务占位说明；运行但尚无工具步骤时显示 Running 与尚无步骤说明，不创建任务。任务概览使用服务端 title/status，保留未完成计划等待、失败和截断语义；仅有 Codemode 记录时不推断整体成功。相邻工具调用组成步骤，工具结果决定完成或失败；流式回复期间工具已完成但模型尚未继续时保留“正在分析请求”步骤；settle 后仍无结果的调用视为已结束但未执行（中断或丢失），所在步骤记为失败（提示“有工具未执行”），不显示完成，也不再停留“执行中”。短句“继续”等沿用上一条实际任务请求作标题。任务耗时从用户消息时间算到 `agent_settled`；恢复历史时用消息时间回退。`taskProgress` 随全量和增量快照传递，ID 来源于原消息 ID，切换对话不会串进度。前端右栏优先展示原生或兼容历史计划的清单；无计划的任务按工具步骤归并为阶段行（task-progress-view.ts 的 progressPhases/phaseSummary，复用计划行样式），不虚构计划。进度与输出始终挂载并共用滚动区域；输出通过 task-outputs.ts 从当前任务步骤的成功 write/edit 工具结果收集，按工具 ID 去重、按路径合并，不包含只读文件和工作区其他改动。详情见 ui-design.md「进度与输出」。

任务展示由本轮工具调用归并出的执行阶段推导，不推断完成；已移除内置 plan 扩展；可识别的旧内置 plan 调用及结果不再显示卡片，原始会话保留，第三方同名工具继续显示。

### 输出长度上限（#143）

最后一条助手消息的 `stopReason === "length"` 表示回答被输出额度截断；有正文、只有思考或完全空内容均保留可见提示。`agent_settled` 仍表示运行结束，但不代表回答完成：有任务时复用 `failed` 状态，已成功的工具步骤不改为失败，原生计划快照不改写。后续正常助手回复可清除本轮截断失败判定。纯聊天不虚构任务。

提示区显示本轮实际输出 token 用量，并提供按 conversationId 打开当前输入框模型管理的「调整输出额度」。只有部分正文的最新、已停止回复提供「准备继续」，追加普通后续请求到草稿，保留已有输入，由用户发送；不承诺断点续写。只有思考或空回复时，明确说明继续可能再次截断，优先引导提高额度或降低思考强度后重试原问题。宿主不因 `length` 自动调用模型或提高额度。

#145 验证边界：SDK 1.5.0 在同模型、未发生压缩的普通后续请求中回传 thinking；Anthropic 有签名块原样保留，无签名块按适配器规则转换。普通「继续」不会提高预算；模型切换或原生压缩／溢出恢复仍可能改变上下文，WebUI 不绕过原生处理。已退休的 `output-limit-context-test.mjs` 使用本地 Anthropic 兼容接口验证签名／无签名回传、相同预算反复截断，以及显式提高同步额度后的请求。回归：`tests/output-limit-test.mjs`（真实 SDK、本地模拟接口、中英文浏览器）、任务进度与空消息过滤单测。

### 工具挂死看门狗

每个 `tool_execution_start` 都会为 toolCallId arm 一个 `TOOL_WATCHDOG_TIMEOUT_MS`（默认 20 分钟，环境变量 `PI_WEB_TOOL_TIMEOUT_MS`（毫秒）覆盖）的 timer——超时仍在跑就 `session.abort()`（杀进程树）+ warning notice，`tool_execution_end` / `removeConversation` / `dispose` 都会清掉对应 timer。恢复重建 + 重绑会话（同一 conv 记录，UI 不掉线）；旧 runtime 释放后到新会话绑定前标记 `rebuilding`，拒绝提示（issue #65）。重建失败时保持标记、不改用新会话文件，仅放行 `/restart`——它从原会话文件重新打开，不再释放已死的 runtime；看门狗超时也走同一 `interruptRun`。中断仅作用于当前运行。


### 扩展 UI 桥

OMP 通过 `server/omp/extension-ui.ts` 将原生 RPC UI 事件投影为宿主协议。每个 Conversation、每代 Bun worker 独立保存 widget、status、临时标题及待答弹窗；通知保留原生 info/warning/error 等级并带 conversationId。浏览器只显示当前对话的状态和弹窗，后台请求显示项目/对话来源，点击后经既有 Wiki/文件草稿保护切换。临时标题不改持久会话名称，运行时使用原生 `PI_RPC_EMIT_TITLE=1` 允许 RPC 发出标题事件。

浏览器弹窗 ID 由宿主分配 UUID，再映射到所属 worker 的原生 ID，避免不同进程使用相同 ID 时串答。响应必须属于活动对话、当前 worker，且符合 confirm 布尔值、select 已提供选项、input/editor 字符串或 null 取消的类型契约；错误、过期和重复响应不会消费原请求。select/confirm/input 的 signal/timeout 由 OMP 原生处理，其 cancel 事件关闭浏览器弹窗。editor 支持多行确认；原生 `set_editor_text` 只回填所属对话草稿，按宿主事件 ID 消费一次，不发送消息。

断线不解决服务端请求。重连只向新连接重放仍有效的弹窗、widget、status 和标题，通知和编辑器写入不重放。Stop、资源重载、会话释放及进程退出时清除所属 worker 的 UI 状态，使旧弹窗 ID 失效；另一对话保持不变。浏览器收到 reset 时清除该对话的弹窗、状态与标题，并丢弃尚未应用的编辑事件。原生 widget 工厂／自定义 TUI 组件仍遵循 RPC 自身限制。

协议 v68：主聊天和 Wiki 在 RPC 握手后显式启用 `set_ask_dialog`，扩展 `ctx.ui.askDialog` 的问题按原生顺序投影为单个面板，保留标题、说明、预览、多选和推荐索引。回答按问题 ID／顺序校验；未知选项、重复选项、单选混合文字与选项等非法回复不消费请求。用户可留空、填写自由文本或取消；原生超时推荐答案由 OMP 决定，宿主只显示超时说明，不另建计时器或伪造用户提交。未发送的表单草稿只在当前挂载期间保留；刷新重放问题但不自动提交。

锁定的 OMP 18.20.0 模型 `ask` 工具使用 HTML 表单，在 RPC 下走原生逐字段 select/input/editor 回退，与扩展 `askDialog` 是两条接口。协议 v69 透传白名单选项说明、初始焦点、radio/checkbox 标记、已勾选索引及可勾选行数，操作行（如 Done）不伪装为选项；秘密输入使用 password 控件。浏览器每次选择仍回答一个原生 RPC 请求，勾选状态、Other 自由输入、验证重问、结束选择、超时默认值和取消语义都由 SDK 管理，不在宿主解析或执行 HTML。

worker 在创建会话前通过公开 `ensureTheme()` 初始化原生主题符号，不启动主题监听器。CLI 原本会执行这一步，直接嵌入 SDK 时遗漏会导致多选问题创建 Done 行时报 `theme.status` 未定义；真实模型工具回归复现并验证修复。`omp-ask-tool-test.mjs --browser` 覆盖选中状态与刷新、键盘焦点、Other、文本/数值验证、最终工具结果、取消、Wiki Stop、原生超时默认值和迟到回答。RPC 的逐字段文本呈现不等同于 TUI 的整表、图片或 SVG 呈现能力。

回归 `omp-extension-ui-test.mjs --browser` 使用真实原生扩展、WebSocket 和浏览器，验证双对话归属、同名状态、类型校验、选择／编辑／超时、重连、Stop／重载、旧代拒绝、后台导航和草稿回填。异步命令回执由 `omp-command-receipts-test.mjs --browser` 单独验证。`extension-ui-test.mjs` 已迁移到隔离 OMP 配置及资源重载，保留双对话、模型／思考切换后的内存运行设置、浏览器编辑和恢复状态检查；其“不向可执行扩展传附件”的旧 Pi 语义改为验证 OMP 实际收到附件，原生边界见 `omp-template-attachments-gap.md`。

ACP 第三方扩展的固定 `acp_delegate` 通知通过 `sendUserMessage` 注入时，OMP 的 `presentation.ts` 调用 `delegate-notification.ts`，仅在界面投影层识别完整通知标记与运行 ID，投影为 `custom/acp-delegate`。失败／完成状态常显，原文可展开；保留条目 ID，不修改原生消息、模型输入或触发新的模型调用。回归：`delegate-notification-test.mjs`，`--browser` 核对真实扩展注入、原始历史、键盘展开、窄屏与刷新。模型请求允许 OMP 原生环境提醒前缀，但通知正文必须完整保留；不把原生前缀误判成宿主改写。

### 原生恢复状态

SDK 用 `context_edit replacement:null` 移除失败回复时，`session-errors.ts` 从当前分支补充仅供界面显示的错误消息（issue #121）。保留错误文本及原顺序，去重且不跨分支，不恢复被移除的正文／工具内容，不写回 SDK 模型上下文。投影按 SessionManager 与 leaf 缓存。回归：`tests/gateway-error-test.mjs`。

`recovery` 快照分别保存 compaction、auto retry 和 summary retry 的生命周期、操作 ID、原因、次数、截止时间和最长 500 字符错误。摘要重试结束只清理其子状态；agent_settled 清理整轮状态。切换及重连从权威快照恢复，恢复期间不触发静默提示或宿主重发。

普通聊天和 Wiki 显示阶段与退避倒计时。取消携带 conversationId 和 operationId，仅匹配当前操作时调用原生 abortCompaction/abortRetry/abortBranchSummary。当前对话运行菜单的自动压缩和自动重试开关保存在每实例独立的内存映射中，由 SettingsManager 的 getCompactionEnabled/getRetryEnabled 在读取时优先应用（包括显式 false）；原生 setter、reload 和信任变化不会清除覆盖，getSettings() 仍返回原生配置，新对话重新继承原生配置；切换开关不取消正在执行的操作。

### 原生工具结果与下载

OMP 的 `presentation.ts` 仅投影工具结果白名单，包括退出码和原生截断标记；原生 artifact 路径及任意 details 不透传。普通聊天工具卡使用所属 clientId/conversationId/toolCallId 的下载链接，原生记录不被 UI 投影修改。

`/api/tool-output` 与按需清单 `/api/tool-output-list` 受通用口令、Origin 和会话归属校验，下载可再带 outputId；浏览器不提供文件路径。独立 Bun 元数据进程用公开 `visitEntriesFromFile` 读取所有原生条目，匹配真实 assistant toolCall 与 toolResult，按 `details.meta.minimized/truncation/source.artifactId` 解析引用。读取不创建 Agent、不取得会话写所有权，停止后下载不重开任务。元数据传输上限为 16 MiB，溢出报错而不静默截断；日志内容不经 RPC 返回。

文件仅限所属历史的原生 artifact 目录下、有匹配引用的数字 ID 日志；不解析正文中的路径标记。清单只返回 ID、文件名、默认项和 partial 标记。下载校验真实路径、文件身份、普通文件类型及符号链接，再从打开的句柄传输原字节；缺失日志不降级成截断预览。没有 artifact 引用时返回原生文本块。401 为认证失败，403 为身份/路径拒绝，404 为文件不存在，其他错误为 500。

OMP 的 `artifactElidedBytes` 大于零时，下载文件名增加 partial 前缀，界面说明保存内容已截断；“下载输出”不承诺捕获了全部原始内容。真实 bash 溢出、600 MiB 服务端流式传输、分支切换、Stop 后读取和 HTTP/浏览器回归见 `omp-tool-output-test.mjs`（`--partial` 验证原生捕获额度，`--browser` 验证卡片下载）。浏览器仍使用 fetch/blob，未据此声称大文件浏览器内存有界。Task 子历史、非日志 artifact 和压缩后的完整目录仍待单独验收。

`snapshot` 里 `streamingMessage` 是进行中的消息（60ms 粒度流式），`messages` 是已落盘的。

## Workspace 项目分组

Workspace 是共享的项目分组，不是 SDK 工作目录或多根 Agent 会话。`server/project-workspaces.ts` 独立保存 `<dataDir>/project-workspaces.json`（原子写入）；同一项目允许属于多个分组，删除分组和移除成员只改索引。每组最多 1000 个路径、最多 100 组，添加时校验绝对路径和目录存在，失效路径仍可移除。

协议 v42：`list_project_workspaces` 返回 `project_workspaces` 并订阅该服务的后续变化；`project_workspace_action` 提交 create/rename/delete/add/remove，携带 revision 和 requestId，`project_workspace_result` 确认结果。过期 revision 拒绝写入并返回当前 catalog。写入失败不提交内存状态；损坏索引保留并报错，避免覆盖用户数据。断线取消订阅，重连重新读取。分组操作不访问 SDK、不生成模型调用，项目切换期间也可处理。

浏览器本地保存当前分组选择，服务器 catalog 在各客户端共享。`web/src/project-workspaces.ts` 合并最近项目与分组成员，确保超过最近项目 20 条限制的成员仍可见。过滤及搜索不改变 cwd；点击项目仍使用 `set_cwd` 和原有草稿保护。移动端分组操作和目录浏览保持抽屉打开。

回归：`tests/unit/project-workspaces.test.ts`（持久化、超过 20 项、过期写入、损坏/写入失败、非破坏删除），`tests/project-workspaces-test.mjs`（双客户端协议），加 `--browser` 验证侧栏交互。

## 项目切换与展示缓存

`set_cwd` 可携带 `requestId`，服务端通过 `cwd_result` 明确确认成功或失败。界面手动切换还携带 `source: "ui"`，成功后只更新工作区状态；命令切换在目标会话的 transcript 中追加不进入模型上下文的 custom entry，快照通过 `cwdEvents` 传给前端并以居中事件显示，不弹成功通知。
同一 ClientSession 串行准备和提交项目切换；尚未开始的请求合并为最后一次选择，
被替代请求收到 `superseded`。目录校验、运行时创建和扩展绑定成功后才改变活动会话。
切换期间前后端均阻止会话操作；前端允许继续选择项目和请求权威快照。
成功提交优先推送全量快照及确认，再刷新项目相关目录。文件树由可见面板请求。

`use-chat` 的 reducer 始终保存权威状态，展示层临时覆盖目标项目的消息、历史和文件列表。
`project-cache.ts` 是内存 LRU：最多 3 个项目，以 JSON UTF-16 长度估算总预算 32MiB，
单项超预算不保留；刷新页面后重建。缓存不参与快照 rev 或消息增量校验。
只有匹配最新请求的确认及目标权威快照到达后，才恢复操作。失败显示重试入口。
断线撤销待确认展示，重连重新请求权威状态。

`sessions`、`files`、`file_content`、`scm_data`、`search_files_result` 携带捕获于请求开始时的
`cwd`，前端丢弃旧工作区结果。查询缓存复用进行中的扫描：项目 30 秒、历史 5 秒，
过期时先返回缓存并后台刷新；历史查询缓存上限 24 个项目、每项目 200 条摘要，项目列表只缓存路径/时间聚合，不保留 SDK 的全文检索字符串。项目按最近使用或对话活动时间排列；再次打开会移到前面，历史的首次添加时间只用于同一时间的排序。新建、删除、重命名会话及移除项目清除相关缓存。
文件扫描仅合并进行中的相同工作区/路径请求，不缓存文件内容。

聊天输入草稿和附件按会话隔离；文件编辑草稿按工作区/路径保护离开（见 architecture-attachments.md）。消息列表保留有限的滚动位置、折叠状态及窗口化高度数据，
不保留各项目的消息 DOM。终端、Git、插件宿主首次访问后才挂载；隐藏文件栏停止
轮询，隐藏 Chat 跳过消息列表更新，隐藏终端继续接收输出，仅在显示时适配尺寸。

回归：`tests/project-switch-test.mjs`（隔离真实服务及 Chrome，固定短/长会话、延迟确认、
缓存内容首帧、草稿与视图保留），`tests/project-switch-electron-test.mjs`（隔离桌面壳），
`tests/unit/project-cache.test.ts`（LRU、预算、扫描合并及失效）。

## Wiki 文档工作区

Wiki 复用当前工作区，使用原生内存会话，离开后释放，不写入聊天历史；返回普通聊天时创建普通原生会话。输入范围可查看，文件改动记录保存在界面数据目录。修改用户消息构建、任务结束记录或文件恢复时读 [Wiki 架构](architecture-wiki.md)。

## 原生会话树

协议 v38 的树投影、原地切换、摘要与取消、label、编辑重问、派生、外部修改检测和草稿保护见 [会话树架构](architecture-session-tree.md)。原生 JSONL 是唯一事实来源，树请求按活动对话和 reqId 归属。

重试倒计时：服务端仅内部保留 deadline，快照通过 `recoverySnapshot` 采样 remainingMs，不下发绝对时间。浏览器接收完整或增量快照时，用 performance.now() 建立本地截止时间；重连重新采样，不依赖两端系统时钟一致。

### 待发撤回与附件分组（协议 v38）

每个问题及其文件上下文合为一条原生用户输入，图片通过 SDK prompt(images) 附加；尊重用户的 steeringMode/followUpMode，不直接改写 agent 队列模式。扩展命令保留原始文本并交由 SDK 拦截。历史独立 custom file 卡片继续兼容；新消息编辑时保留问题内部的文件上下文及图片。队列快照先将完整技能调用转成 skill:name 与用户指令摘要，再限制每条 2000 字符；普通文本保留换行。旧服务截断的技能块由前端仅提取技能名，避免铺开技能原文。取回内容仍使用原生完整文本。

待发摘要固定在输入框上方，单条显示摘要，多条显示数量并可展开；不进入消息流，不在状态栏重复计数。“全部撤回编辑”发送 conversationId/requestId，服务端只允许活动对话调用公开 clearQueue，不中断当前回复。公开 SDK 无单条删除接口，暂不提供多条队列中的单条撤回；仅一条待发且输入为空时，↑ 等同全部撤回编辑。宿主仅临时跟踪尚未消费的 WebUI 图片，以便与原生返回文本一起恢复；不建立第二套运行队列。结果 queue_recalled 经现有草稿保护选择替换、追加或保留，并按对话隔离；浏览器确认 queue_recall_ack 前服务端保留结果，断线重连重放，同一 requestId 幂等。内存待确认结果最多 8 份，达到上限拒绝新的撤回，避免丢失此前取回内容。

### 压缩结果展示

普通聊天和 Wiki 的压缩进行态改为无边框紧凑行，共用 Thinking 的 RunningIndicator 绿色呼吸灯并保留取消入口；断线时不显示活动绿灯且禁用取消。成功或取消后状态行消失，不再显示独立结果卡；失败仍保留可关闭错误反馈。compaction_end 的 completed/aborted/error、原因和 token 数仍保留在快照供重连恢复，不修改原生压缩数据。lastCompaction 不阻止后续 Working 状态；SDK agent_settled 仍是运行结束的唯一判据。

## 未执行的工具调用

OMP 下，`<invoke>`、DSML、`<tool_call>` 或残缺 `<parameter>…</invoke>` 正文仍是模型文字。宿主不会把它转成真实工具调用，也不会在任务结算后自动发送提醒、重试或继续。只有原生协议识别出的工具调用交给 OMP 执行；原生工具结果引起的后续模型请求属于同一次工具循环。

`server/tool-text.ts` 与界面的异常卡片继续用于识别和展示未执行的描述，用户可以明确发起重问。识别规则不参与执行，不修改 native transcript；旧 `origin: "auto-reminder"` 展示兼容不代表新会话会产生提醒。旧 Pi 每请求一次自动提醒策略已退休。

`tests/tool-text-continue-test.mjs` 保留历史文件名并继续纳入全量冒烟，现使用真实 OMP、隔离本地 OpenAI／Anthropic 流，验证：正文和重复描述不执行、无文件副作用或自动模型请求、真实工具的分片参数可正常执行及回传、工具执行后的描述也不续跑、Stop 后显式继续保留历史。OMP 会将 OpenAI 正文中 `</think>` 前的内容拆为 thinking；测试保留并检查原生拆分，不要求整段仍在正文里。此回归不证明真实网关不再产生错误工具描述。

### 工作区代码搜索（协议 v43）

`search_content` 以请求 ID 关联 `search_content_result` 批次，后者带 cwd、done、截断和错误状态。每个 ClientSession 只保留一个 rg 子进程；空查询取消，新查询替换，dispose 终止。浏览器在输入变化时立即取消，300ms 后发新查询，按跨弹窗唯一 ID 与当前 cwd 接收批次；旧批次不进入新搜索。文件名搜索优先使用包内 `rg --files`，不可用时保留有预算的遍历回退。

### Wiki 客户端直达初始化（#114）

可选 `hello.wikiCwd` 只用于创建新客户端：校验目录后，在目标工作区用 `SessionManager.inMemory` 创建首个 Wiki 会话；不恢复最近普通聊天。已有客户端重连忽略该参数，避免覆盖活动会话。快照可选 `wiki` 字段标识会话类型，前端首次进入直接复用，不再新建第二个运行环境。普通 hello 行为不变。

## 全局导航与小记

Workspace 列表与项目目录分为两栏，选择分组保持当前会话与工作目录。小记使用独立 HTTP 存储，不生成 Agent 会话或模型上下文；保存、冲突和测试约定见 [全局小记](architecture-notes.md)。

### 发送回执（协议 v44）

OMP 运行中输入使用原生 `prompt` RPC 加 `streamingBehavior: steer/followUp`，沿用已有发送／撤回串行准入。直接调用低层 `steer`／`follow_up` 会绕过 RPC 的技能分派，不能作为用户输入入口。队列 chip 和撤回结果使用 OMP 原生表示；技能撤回恢复 `/skill:name 参数`，不恢复内部生成的技能正文。

普通聊天与 Wiki 的 `OmpClientSession.prompt` 共用 `server/prompt-receipts.ts`；WebSocket 和 Wiki HTTP 入口都先占用请求 ID，再执行附件、扩展或原生命令。浏览器 prompt 携带 cwd、运行中 conversationId 与稳定的原生 sessionId，异步保存期间切换或重建会话不能把旧输入送进新会话。SSH 节点聊天不使用这条路径。

回执以 clientId + requestId 隔离，原子写入 `<dataDir>/prompt-receipts.json`（目录 0700、文件 0600）。记录只含身份、载荷摘要、时间与结果；不保存输入正文、附件或凭据。重复 ID 返回已有状态，载荷或目标不一致返回 conflict。`query_prompt_receipt` 使用同一个 `prompt_result` 返回 processing / accepted / rejected / unknown / missing / expired / conflict；结果成功落盘后才发回客户端。损坏或写入失败时不继续接收新请求，不能把异常当成空存储。

OMP RPC 准入确认只证明当时接收，**不表示模型或扩展命令完成、transcript 已落盘或内存队列能在重启后继续**。锁定版本在扩展命令路由成功后、handler 完成前即可确认，最终结果另由原生 prompt_result/session_settled 报告；宿主保持此原生语义，不将已接收显示为任务完成。输入钩子已有副作用、但 RPC 尚未确认时，进程恢复后的处理记录为 unknown；已持久化 accepted 的命令即使执行中崩溃，仍返回 accepted，均不自动重放。SDK 副作用与本地回执不构成原子事务，因此不承诺 exactly-once；当前文件原子替换保障进程重启，不承诺断电耐久。

传输层以原生 RPC ID 关联迟到的 `prompt_result`，不改变即时准入；关闭 worker 时清除该代观察者。原生结果确认 `agentInvoked:false` 且 completed 后，账本补充 `commandExecuted:true`，供显式查询／重连使用，不再次主动推送同 ID 的准入回执，以免干扰后续请求。该字段表示本地处理，不证明扩展执行成功：OMP 可能捕获 handler 异常后仍报告本地 completed；`extension_error` 单独显示所属对话的通用错误，不下发原始异常，也不撤销 accepted 或自动重发。

用户明确附加的文件仍验证、构建并交给原生扩展，准入后仅消费本次发送的附件；新草稿和新附件保留。浏览器根据发送时的原生命令目录，对扩展命令暂不生成乐观用户消息，等待真实历史，避免无模型调用的命令留下虚假消息。目录只用于这一显示决策，不用于推断完成或绕过附件校验。专项 `omp-command-receipts-test.mjs --browser` 覆盖准入先于完成、重复 ID、迟到结果查询／账本重载、附件正文、原生失败、无虚假回显及新草稿／附件保护；不访问真实模型。

终态结果可查询 7 天；之后返回 expired，并在下一次写入时移除结果、保留请求 ID 和摘要墓碑，避免旧 ID 再次执行。处理中记录不按时间淘汰。当前容量上限为 10,000 个 ID，达到后拒绝新请求并报告错误；不可把删除账本当作正常清理操作，这会失去去重依据。

浏览器保留 pending request 身份到标签页 sessionStorage，断线/刷新后只查询、不重发。等待最多 30 秒；unknown、missing、expired 或查询超时解除界面操作锁并保留草稿、显示核对提示。明确接收后只清除与原发送文本相同的草稿，期间输入的新内容保留；恢复后的回执不按可复用的 conversationId 清除另一原生会话的输入。再次发送是用户显式操作，使用新 ID。已确认接收但对话已变化时，输入框提示显示 5 秒后自动关闭，草稿保留与请求去重逻辑不受影响；接收状态未知的核对提示继续保留。

回归：`prompt-receipts-test.mjs` 使用真实 OMP 扩展验证副作用计数、重复 ID、过期目标、客户端隔离和进程重启；可控挂起命令验证 accepted 不等于完成，可控输入钩子验证执行中 SIGKILL 后 unknown 且不重放。加 `--browser` 验证真实断线/刷新后的查询、新草稿保留及显式重试；该模式加入 Mac/Windows CI。单测覆盖容量、损坏、写失败、过期与客户端隔离。

模型来源自动同步（Pi / Claude Code / Codex / OpenCode）、内存凭据、独立副本和协议 51 见 [模型配置来源](architecture-model-sources.md)。

`/new` 的成功回执可能晚于新原生 session 的快照。当前挂载的输入框发出该命令且回执确认 commandExecuted、请求原 sessionId 与运行中 conversationId 均匹配时，允许清除仍等于发送原文的命令草稿；后续新输入不清除。此例外不持久化，刷新恢复的旧回执仍遵守跨原生会话草稿保护。回归：`tests/new-session-draft-browser-test.mjs`（真实 `/new`、延迟回执、零模型调用）。


OMP 停止后的元数据读取（2026-11-15）：重连初始化、设置/历史/命令目录读取使用 OmpSession 的 `readMetadata`，现存 worker 不可用时返回最近的所属会话元数据；不得通过通用 `command` 自动 open。MCP 状态轮询使用 `requestIfOpen`，Stop 中及 Stop 后返回不可用，迟到回复按运行实例归属丢弃。显式发送/重载仍可打开原生会话。回归为 `omp-stop-metadata-test.mjs` 与实际 MCP 页面。

OMP 原生资源重载进一步使用 `reloadResources` 创建新的 Bun 模块实例，沿用同一 session 文件、模型/思考与运行偏好。导航操作权跨越停止/重开，Stop 在模块初始化期间取消后也不能自动恢复。正常空闲重载不新增任务中断错误。资源/扩展/MCP 文件的 get 只查现存 worker，写操作采用 `command(..., {open:false})` 或同等 requestIfOpen 保护；停止后可显式重载，浏览页面不能重开进程。
