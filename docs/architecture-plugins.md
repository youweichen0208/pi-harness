> OMP 迁移更新（2026-11-15）：生产 MCP 已使用 OMP 原生配置路径、文件锁/校验/写入和会话 manager。全局/项目 JSON 配置、脱敏、连接状态、工具目录及显式重载/重连见 [OMP 迁移契约](architecture-omp.md#原生-mcp-配置与连接2026-11-15)。下文 Pi/Codemode 配置和命令仅保留为原功能对照，不是当前生产入口；OMP OAuth 登录、取消、手动回调和清除登录已接入，详见该契约末尾 MCP OAuth 章节；逐服务配置表单已接入（见下文），配置导入已接入（见下文），连接诊断已接入（见末尾章节），工具请求及网关诊断仍未完整验收。工具级 OAuth challenge 的宿主处理器及原生参数传递缺口已有真实调用证据，见 [对照记录](review-data/omp-mcp-tool-auth-probe.json)；手动登录通过不代表该路径已完成。

# 插件系统

OMP 原生执行回归：`tests/codemode-mcp-test.mjs` 保留历史冒烟入口，使用模型请求里实际声明的 `write` 工具和原生提示词提供的 `xd://` MCP 路径，验证分片参数、成功／失败／图片结果回传；不强制把 MCP 改成旧式直接工具注册。`--browser` 验证图片操作与会话归属，Mac/Windows CI 纳入该门禁。本地结果不代表 Windows 已通过。旧 Codemode 的 mode、inlineBudget、QuickJS 脚本与 exposure/trust 设置属于已退休的 Pi 行为，原生 MCP 配置／项目范围／冲突／OAuth 和完整输出由现有 OMP 专项继续覆盖。

> 可选界面组件，存放在 `<dataDir>/plugins/`。不装即不存在，attach 时热重扫。

## 形态

一个插件 = `<dataDir>/plugins/<id>/` 目录：

- `manifest.json`（name/version/description）
- `index.mjs` 服务端入口（可选，`export default { activate(host) → deactivate? }`）
- `client/entry.mjs` 视图入口（可选，`export default { mount(el, ctx) → cleanup? }`）

**不装即不存在**——目录不在就没有任何协议/UI 痕迹；attach 时重扫目录，新丢进来的插件无需重启服务即出现在顶栏视图 tab（import 每进程一次并缓存；删除目录 → 下次 attach 反激活）。

## 协议

| 方向 | 消息 | 作用 |
| --- | --- | --- |
| 上行 | `plugin_message` | 路由到该插件的 onMessage 处理器，回调第二参为 clientId；未知/非法 id 静默丢弃 |
| 上行 | `plugins_reload` | 服务端热重载：反激活全部→重扫激活→epoch+1→重推清单 |
| 下行 | `plugins` | attach 时推清单（plugins, epoch），epoch 用作前端 import 缓存击穿参数 `?e=` |
| 下行 | `plugin_data` | 默认广播给所有 socket，前端按 pluginId 扇出给已加载视图 |

## 宿主扩展点

| 方法 | 作用 |
| --- | --- |
| `host.notify(level, text)` | 发系统通知条（notice，前端 toast） |
| `host.sendTo(clientId, payload)` | 定向发给单个 socket |
| `host.onToolEvent(h)` | 订阅 SDK 工具执行事件（phase:start\|end, toolName, conversationId?, durationMs?, isError?） |
| `host.onAttach(h)` | 注册「新客户端接入」钩子（每次浏览器 attach，含 plugins_reload 后的重接入） |
| `host.route(method, path, handler)` | 挂载 HTTP 路由（`/plugins-api/:id/*`） |
| `host.fs` | 受限工作区文件访问（WorkspaceFS，路径锚定活 cwd 根，越界拒绝） |
| `host.getSettings()` | 读取声明式设置（manifest.settings schema） |
| `host.onSettingsChanged(h)` | 订阅设置变更 |
| `host.notifyCwd(cwd)` | 当主应用 set_cwd 成功后通知插件（幂等去重，异常隔离） |

### 宿主设施（plugin-facilities.ts）

| 设施 | 说明 |
| --- | --- |
| `storage` | `<pluginDir>/storage.json` 原子 KV |
| `secrets` | AES-256-GCM 加密机密，密钥 `<dataDir>/secrets.key`，拷机 fail closed |
| `ensureDeps` | npm 自动补装单飞 |

### 能力声明与强制（manifest.permissions）

## manifest 可选字段

- `icon`（emoji/单字符，顶栏 tab 替代通用拼图图标）
- `description`（tab 悬浮提示）
- `version`
- `apiVersion`（与 `PLUGIN_API_VERSION` 比较，> 则拒绝激活并提示升级）
- `permissions`（能力声明数组）
- `settings`（声明式设置 schema → ⚙ 面板自动渲染表单）

## 前端集成

App 按 chat.plugins 动态 import 各插件的 client bundle（`/* @vite-ignore */`），TopBar 为每个插件加一个 🧩 tab（激活失败的置灰）；插件不共享 React 实例，与主应用只有 ctx.send/onData 两条窄通道。

`syncPluginViews(plugins, epoch)` 统一同步注册表：清单消失/被禁用即卸载视图（调 cleanup）、epoch 变化清 failed 重拉 bundle。

设置面板 ⚙ 有「界面插件」开关区（`set_settings.disabledPlugins`，持久化 client-state、纯 UI 隐藏不触发 runtime reload）+ **每行「更新/卸载」按钮**（更新需 CLI install 记录的来源 `.pi-source.json` → `UiPluginInfo.source`；两个操作都走可见终端 tab，退出后 App 观察器发 `plugins_reload` 热重载）。

## 静态服务

`GET /plugins/:id/client/*` 映射到插件目录的 client/ 子树（**只暴露这个子树**——manifest 与服务端 index.mjs 可能含凭据，绝不下载；id 校验 + resolve 前缀防穿越）。dev 模式 vite 已代理 /plugins。

## 真实插件

| 插件 | 目录 | 说明 |
| --- | --- | --- |
| demo-mailbox | `dev/plugins/demo-mailbox/` | 内存邮箱 demo，plugin-test 夹具 |
| webmail | `dev/plugins/webmail/` | 📬 网页邮箱，IMAP/SMTP 邮件管理 |
| vscode-editor | `dev/plugins/vscode-editor/` | 📝 编辑器 + SSH（原独立插件合并） |
| db-client | `dev/plugins/db-client/` | 🗄️ 数据库连接管理（mysql2/pg/mssql/sqlite/mongodb/redis） |

## 回归测试

| 测试文件 | 端口 | 说明 |
| --- | --- | --- |
| `plugin-test.mjs` | 8978 | 清单推送 / message 回环 / 静默丢弃 / 静态服务 / 路径穿越拒绝 |
| `plugin-http-test.mjs` | 8981 | host.route 全链路（GET/POST/404/500） |
| `plugin-settings-test.mjs` | 8983 | 声明式设置 schema 校验/持久化/回显 |
| `plugin-cwd-test.mjs` | 8989 | set_cwd→notifyCwd→广播全链路 |
| `plugin-update-test.mjs` | — | install/check-updates/rollback 全链路 |
| `ssh-plugin-test.mjs` | 8964 | SSH 远程文件/终端全链路（mock SSH 服务端） |
| `db-client-test.mjs` | 8968 | SQLite 全链路协议冒烟 |
| 单测 `plugin-facilities.test.ts` | — | storage/secrets/deps/apiVersion 门控 |
| 单测 `plugin-settings.test.ts` | — | schema 解析/校验/持久化 |
| 单测 `plugin-updater.test.ts` | — | 备份/回滚/prune/资源解析 |

## 原生 MCP 管理

设置页「原生 MCP」编辑 `<agentDir>/mcp.json` 或 `<cwd>/.pi/mcp.json`，保留未知字段，按文件 SHA-256 校验版本后原子保存。headers、env、secret/token 字段以掩码下发；原掩码保留，替换字符串或删除字段修改/清除。项目 provider auth 被拒绝；项目保存不授予信任，「信任当前项目」调用官方 ProjectTrustStore，并在 reload 时更新 SettingsManager 信任状态。

配置变化对所有已加载会话应用：空闲会话立即 reload，运行会话按 conversationId 延迟到 agent_settled。连接状态、登录、退出、重连执行 sourceInfo 属于 builtin:mcp 的官方命令；替换命令明确不可用。OAuth 链接以 HTTP(S) 链接显示，回调输入/取消走扩展 dialog；重连重放待答 dialog。旧桥保持 data-dir/mcp.json 独立配置。

界面插件只提供 Web 展示及用户交互，不向代理注册工具、斜杠命令或提示词。代理扩展和 MCP 由 pi 原生配置加载。

### 第三方 pi-mcp-adapter 迁移提示

`pi-mcp-adapter no longer reads …/mcp.json` 来自第三方扩展，不是 Windows 目录错误。原生 pi 同时使用 mcp.json，WebUI 不执行提示中的 mv、不自动迁移或禁用扩展。遇到这一明确的迁移提示时，通知提供中英文说明和 Extensions 入口：使用内置 MCP 的用户可以关闭旧适配器并重载，保留原生配置；继续使用适配器的用户按其文档维护独立的 mcp-adapter.json。原始提示折叠保留，其他错误原样展示。回归：`notices.test.ts` 与 `notice-drop-browser-test.mjs`。

### Pi 1.5.2 MCP / Codemode 工作台

原生 MCP 与 Codemode 的底层依赖已拆分为同版本 `pi-mcp` / `pi-codemode`，宿主继续使用 coding-agent 的公开工厂和原生配置校验入口；桌面依赖闭包由包内原生工具回归验证。分类模型（含 Microsoft-Decision-1）通过原生 `models.classify` 使用并计入既有 Codemode 费用展示，不作为聊天模型提供选择。

设置页「MCP 与 Codemode」直接维护原生配置，连接状态按需要处理的项目优先排序。全局/项目范围分别使用自己的文件版本；两种范围的 `mcp.json` 均支持开头的 UTF-8 BOM，文件版本仍按原始内容计算，保存时输出无 BOM 的 JSON；新增和导入在完成编辑后立即保存，启停、暴露方式和单工具覆盖修改后立即保存；原始 JSON 从标题区「编辑 mcp.json」打开，保留草稿并由用户显式保存。请求串行，期间禁用其他修改，仍使用原生版本校验、凭据掩码和会话生命周期；失败保留草稿并提供重试/重新加载，关闭和切页保护未完成编辑。Codemode 用分段选项并立即保存，已有非预设预算仍显示。导入支持 Claude/Cursor、VS Code 和 OpenCode JSON，拒绝重名覆盖及未转换的 `${input:...}`。Codex TOML 需要先转换为 `mcpServers` JSON。

1.0.1 的项目覆盖允许 `.pi/mcp.json` 中只写 `enabled`、`exposure`、`toolExposure`，沿用同名全局服务器的连接和凭据。Web 服务按 SDK 的规则校验覆盖，不复制凭据、不隐式授予项目信任。项目范围中可以为当前运行的全局服务器新增启停覆盖。

官方 `/mcp` 在 RPC 模式输出连接状态，但会等待首次后台连接完成。Web 以每会话缓存、单飞查询适配此接口：配置立即返回，浏览器每 3 秒刷新；首次尚无状态时显示连接中，不阻塞输入。连接完成后使用官方状态，不从工具数量推断成功。服务诊断在对应服务行展开，完整日志通过标题区按需读取；SDK 未提供结构化的额外 scope 状态，因此统一显示「需要登录」，不会猜测请求的权限。登录/退出/重连仍调用官方命令，远程 OAuth 回调与取消走原生 WebUI dialog。工具名称、annotations 和实际 exposure 来自 `session.getAllTools()`；单工具覆盖另写原生 `toolExposure`。

`codemode.mode`、`codemode.inlineBudget` 写入对应范围的 `settings.json`，保留未知字段并独立校验文件版本；界面显示当前会话实际生效值。`autoEnableCodemode` 写在 `mcp.json`，不代替 `defaultTools`，关闭自动启用不会关闭已经启用的工具。全部变更复用运行中会话的 `agent_settled` 延后 reload。`mcp.log` 按用户点击读取末尾 32,000 字符。

### 原生 Codemode 卡片

`server/codemode-presentation.ts` 对 SDK `CodemodeToolDetails` 做展示字段白名单：calls（含模型调用）、status、durationMs、cost、error、fullOutputPath。完成记录随 `UiMessage.codemode` 下发，执行中随 `tool_delta.codemode` 下发；不向模型加入任何消息。每张卡最多传输 256 条调用，保留实际总数并提示省略；默认展示最后 8 条，可展开其余已传输调用。旧 transcript 没有 details 时回退到 `nestedCalls`。

右栏任务面板在步骤之后独立展示「Codemode 执行记录」，按外层调用分组，不嵌入或修改计划。`server/codemode-history.ts` 从当前原生持久分支提取本轮元数据，通过协议 v52 的 `UiState.codemode` 下发；`web/src/codemode-records.ts` 结合流式消息、原生 details 和内部工具状态推导记录，自动提醒及工具文本恢复不切换请求边界；优先使用 details，旧历史回退到 nestedCalls，不合并重复来源。组件为 `CodemodeRecords.tsx`。临时内部调用 ID 可能重复且结束时改变，因此行标识采用组内追加序号。

持久投影按 SessionManager、leafId 和条目数量缓存，不依赖 plan 是否开启；快照只携带本轮调用元数据，不包含脚本、输出正文或图片。每个运行中外层调用的最新有界原生详情保存在对话内，快照重连时覆盖旧的浏览器详情，结果持久化后清除。聊天卡片使用独立的 `runActive` 判断生命周期，连接状态只控制本地计时，断线不产生结束状态。

运行中分组默认展开、仅显示最后 8 条已收到记录，手动折叠和结束时的展开状态保留；历史已结束分组初始折叠。点击记录跳到聊天中的外层卡片并展开调用页签；目标已被压缩时，通过 `tree_content.codemodeToolCallId` 按需读取并在只读弹窗复用卡片，不导航分支或恢复模型上下文。顶栏任务入口在仅剩持久 Codemode 记录时仍保留。内部失败保留，外层成功仍显示 Completed · contains failed calls；明确取消显示 Cancelled，外层已结束但内部缺少终态显示 Unfinished。传输省略与界面折叠分别提示，旧历史不完整时只报告已收到数量，不推断未收到调用成功。仅增加展示协议字段，不添加模型消息或额外模型调用。完整决策见 [Codemode 执行记录设计](codemode-task-records-design.md)。

卡片提供调用／脚本／输出页签，费用仅汇总 SDK 实际报告的值；没有费用时不显示虚构的 $0。脚本错误保留输出及调用列表，并提示已执行调用不会撤销。1.0.1 在输出超过 16 Mi 字符或 100,000 项时失败；界面原样呈现 SDK 错误。`max_output_tokens` 导致文本截断时，仅展示 SDK 实际提供的 `fullOutputPath`，不假定每种失败都有完整输出文件。

图片保持原生结果的 data URL；「附加到下一条消息」使用现有图片附件路径，用户发送前不进入上下文。「保存到当前目录」走鉴权及同源保护的 `/api/codemode-image`，校验活动工作区与图片签名，以随机文件名、`wx` 创建，不覆盖已有文件；单张保存上限 6 MiB。保存是用户文件操作，不注册额外工具，也不把生成结果自动注入下一轮。图片超过此保存上限时仍可使用浏览器图片下载。

验证：`codemode-mcp-test.mjs`（9204/9205、隔离配置和工作区、本地 mock 模型）验证真实 SDK 状态、凭据掩码、CAS、项目覆盖、配置生效、实时调用、部分失败、输出限制和图片安全；加 `--browser` 校验实际卡片、图片操作及设置交互。`native-tools-desktop-test.mjs` 覆盖 Node/Electron 的原生工具执行，`native-features-browser-test.mjs` 覆盖历史回退及 OAuth 界面。相关纯函数测试在 `tests/unit/codemode-presentation.test.ts` 与 `tests/unit/codemode-records.test.ts`；`codemode-records-browser-test.mjs` 使用模拟接口覆盖右栏实时更新、折叠、跳转、历史恢复、失败及传输限额，并检查 Web/macOS/Windows 窗口布局。

原生 Pi 包与 standalone 扩展由设置 › Extensions 管理，接口、过滤恢复、作用域、目录与编辑规则见 [Extensions 架构](architecture-extensions.md)。这里的界面插件仍是独立的展示插件系统。

## 原生默认值和可替换内置扩展

每个对话的 SettingsManager 在 getDefaultTools() 读取时优先使用原生返回值，仅 undefined 时返回由 SettingsManager.inMemory 公开 getter 解析的 Codemode/tool_search 默认列表，每次返回副本。显式空数组、禁用项和项目配置保留原生语义；getSettings() 保留原生配置。对话压缩/重试开关同样由 getter 读取内存覆盖，不包装 reload/信任方法，不改变原生 setter、持久化和加载错误处理，不修改 SDK 或私有字段。codemode、tool-search、mcp 的 InlineExtension 标记 replaceable:true，用户扩展可以接管同名工具或命令。pi 1.4.0 未公开导出 llama.cpp 工厂，宿主暂不通过内部路径补装。

## 可选原生计划扩展


后台任务面板与注册接口已移除；插件在自身 deactivate 中清理计时器、连接与 worker。

MCP OAuth 的 `oauth.clientRegistration` 接受 `auto`、`dcr`、`cimd`，通过原生验证和现有 JSON 编辑器保存；缺省由 SDK 使用 auto，宿主不将默认值写回用户配置。

Codemode 压缩回归：`tests/unit/codemode-history.test.ts` 使用真实 SDK 验证 split-turn／整轮压缩、分支及请求边界、缓存和只读读取；`tests/codemode-history-browser-test.mjs` 使用真实持久会话与生产快照／树接口验证刷新、分支隔离及历史卡片，无模型调用。


### ChatGPT / Kimi 账号模型入口

共用模型菜单在滚动区顶部显示 ChatGPT（openai）与 Kimi Code（kimi-coding）。账号状态来自原生 SDK 认证类型与不含敏感信息的凭据元数据，API Key 不标为账号登录。登录成功不切换模型、不发送聊天请求；目录不代表逐项验证订阅权限。已保存原生密钥时先确认替换，服务端再次检查；来源停用时提供管理入口。协议 v56 的 models 携带 accounts 状态摘要，login_provider 支持 confirmReplaceKey。

## OMP 逐服务配置表单

设置 › OMP 工具 › 原生 MCP 在运行连接之外，单独列出当前全局或项目文件的服务。表单支持 stdio／HTTP／SSE、命令、工作目录、JSON 参数／环境变量／headers、超时及启停；高级字段保留在原始 JSON 中。已有名称只读，避免把掩码移到另一服务的恢复位置。保存仍调用既有原生校验／文件锁／版本校验接口，不自动启动、重载或重发模型任务。删除只移除本范围服务定义，保留原生全局规则与 OAuth 凭据；其他来源可能在重载后再次出现。

表单只改明确编辑的配置，保留未知字段和同一位置的凭据掩码。全局启停显示原生优先级：disabledServers 优先于 enabledServers，再考虑服务的 enabled。明确改变全局启停会同步该名称的两份列表；选择原生默认会删除该服务的 enabled 与两份全局覆盖。未改变启停而编辑其它字段时不改规则。项目只写服务 enabled，不能绕过全局停用或强制启用，也不打开被禁用的项目配置。列表配置与当前会话实际连接状态分别展示。

表单与 JSON 编辑互斥；读取、关闭设置、切页或切范围保护未保存内容，窗口关闭使用 beforeunload。轮询只更新运行状态；冲突、原生校验或网络失败保留输入。保存或取消后焦点返回原按钮。JSON 字段使用明确的可访问名称，避免 textarea 内容进入标签定位；按钮／控件至少 44px、输入文字 16px，沿用现有主题变量。

配置投影只开放已知的连接类型、请求 ID／env／header 策略枚举，以及布尔 enabled/instructions 和非负有限 timeout。服务名称含 env/secret/token 不再把这些公共元数据变成掩码；未知枚举值、连接字符串、参数、凭据与未知字段仍隐藏。失败复现和最终回归见 [表单验证记录](review-data/omp-mcp-form.json)。该功能不解决工具级 OAuth challenge 缺口，未宣称 Windows／安装包验收。

## OMP MCP 配置导入

设置中的「导入 MCP 配置」接受严格 JSON：原生／通用 `mcpServers`、VS Code `servers`、OpenCode v1 `mcp` 服务表和 v2 `mcp.servers`。仅导入服务，不导入其它产品设置或已保存的登录记录。先预览服务名单，再明确保存到当前范围；保存走同一原生版本校验／文件锁接口，不连接服务、不重发模型任务。旧服务、未知字段与同位置凭据掩码保持原样。项目保存不改全局文件，仍受原生项目配置开关和全局规则约束。

转换将 OpenCode local 的命令数组拆成 command/args，environment 改为 env，remote 改为 HTTP；v2 disabled 取反为 enabled。VS Code `${env:VAR}` 与 OpenCode `{env:VAR}` 转为 OMP `${VAR}`，原生 `${VAR:-default}` 保留；浏览器不展开变量，由 OMP worker 环境读取；宿主已有隔离规则仍剥除 PI_／OMP_ 前缀，外部变量应使用普通业务名称。只有 URL 且缺省类型时识别为 HTTP。原生源文件的启停列表折叠到所导入服务的 enabled，禁用优先；引用导入集合外名称的源列表拒绝导入，避免丢失发现规则。目标范围已有同名定义或启停规则时整批拒绝，不覆盖。

不自动转换输入提示、envFile、工作区／文件／配置引用、OpenCode 显式 OAuth、timeout 对象、codemode/protocol/pool，以及未知字段。OMP 插件专用 envPolicy/envLiteralKeys/headerPolicy 虽在 SDK 类型里，但当前普通配置加载器不保留，故导入拒绝；已有文件的这些字段仍由原始编辑器保留。原生 oauth 客户端配置可导入，auth 中的外部凭据引用不导入。错误说明不回显配置值。用户须核对目标主机路径和认证设置；不声称任意客户端配置完全等价。

输入限制 1 Mi 字符、合并后至多 256 个服务、语法树深度 32；重复 JSON 键、`__proto__` 键、无效连接及脱敏占位符整批拒绝。导入草稿与表单／原始编辑器互斥，轮询不改输入；冲突保留草稿，切范围／重新读取／设置导航／实际刷新沿用未保存保护。保存或取消清除输入并归还焦点，不把输入存入 localStorage。沿用逐服务表单的主题、窄屏和可访问控件。

格式依据：[VS Code 配置参考](https://code.visualstudio.com/docs/agents/reference/mcp-configuration)、[OpenCode MCP 配置](https://opencode.ai/docs/mcp-servers)，以及锁定的 OMP 18.20.0 `discovery/builtin.ts`、`discovery/helpers.ts`、`mcp/config.ts`。回归与限制见 [导入记录](review-data/omp-mcp-import.json)。

## OMP OAuth 外部配置并发缺口

授权流程打开后，外部编辑器或另一会话仍可更改配置。原生 helper 在需要持久化 auth 时，把流程开始时的定义交给原生 writer；writer 虽锁住读改写，却未比较所选服务的旧版本，因此同一服务的新字段会丢失。其他服务和文件根字段保留。修正前，定义本身不需写回时，文件编辑被保留，但宿主仍用旧选择重连并显示 complete，包括服务已停用或换地址。两条问题均以真实本地 PKCE、明确的授权中编辑时点重复复现，见 [诊断记录](review-data/omp-mcp-auth-conflict.json)。

协议 v77 已在重连前重新核对生效定义与来源；这不等于修复原生写回覆盖。完整并发保护需要原生 writer 锁内比较预期定义或公开 prepare/commit 接口。现有 onFlowComplete 在凭据写入后、配置 writer 前同步调用，不能提供跨后续写入的原子校验。不能声称提前轮询／检查等于 CAS，也不能伪造 ACP 所有权来跳过默认持久化。冲突时凭据可能已保存，不能暗示已回滚或盲删共享凭据。

协议 v77 的重连保护使用公开 Settings.loadReadOnly、findMcpServerForAuth 和 loadAllMCPConfigs，不重写原生发现／启停优先级、不加载模型或执行工具。原生流程自己的 auth 写回与 undefined 字段省略按返回 outcome 比较，其他服务修改不会阻止正常登录。文件被删、改地址、停用、增加项目覆盖、全局禁用、项目开关变化以及扩展来源配置变化会阻止自动重连；读取异常同样要求用户重载。检查后仍核对 Stop／dispose。configuration_changed 状态与普通授权失败分开，说明凭据可能已保存，不删除凭据或声称回滚；既有连接仍遵循显式 reload 的原生规则。

这是一项重连前检查，不是覆盖任意编辑器及后续网络操作的事务。原生写回若已丢失外部修改，事后检查不能恢复它。见 [最终重连验证](review-data/omp-mcp-auth-reconnect.json) 与仍失败的 same-server 诊断。

官方 npm 的 18.20.2 包已校验 SHA-512 并与当前安装的 18.20.0 比较：oauth-reauth.ts、config-writer.ts、manager.ts 均逐字节相同，因此该发布版本不包含上述写回 CAS 或工具级 challenge 参数修复；没有据此更改依赖。见 [上游核验记录](review-data/omp-oauth-upstream.json)。这仅是发布源码比较，不是新版本运行验收。


## OMP MCP 连接诊断（协议 v78）

设置中的当前连接显示原生失败类别及 HTTP 状态码；下方「连接诊断」默认折叠，以最新在前显示最近 100 条连接事件。每个 worker 独立保存记录，显示移出的记录数量；读取不连接服务器、不调用模型、不影响配置草稿。停止后不重开 worker，重启清空记录。重新连接成功后当前错误消失，历史失败保留。删除服务后保留历史事件，当前服务列表仍由原生 manager 决定。

实现使用公开 MCPManager.addConnectionStatusListener 和一次性的 waitForStartup(1)。后者仅补齐监听安装前的启动状态，标记为「启动快照」，时间为观察时间；不能传入表示无限等待的 0。Stop／输入结束时解除监听。原生事件中被字符串化的错误由 normalizeMCPTransportError 分类；结构化信息已丢失时可能为 unknown，不推测不存在的细节。

浏览器只接收有界服务名称、事件序号／观察时间、原生事件类型、传输类别、失败枚举及有效 HTTP 状态码。不会下发原始错误正文、response body、traceId、命令、环境变量或连接参数；凭据无需依赖文本正则脱敏。诊断不持久化、不进入模型上下文、不自动重试。这不是工具请求追踪或原始网关／DeepSeek 请求对照。

验证见 [诊断记录](review-data/omp-mcp-diagnostics.json)：实际本地 HTTP 失败／恢复、初始状态、慢启动、跨对话隔离、Stop／重开、有界缓冲及监听清理，中英文窄屏、配置／OAuth 关联回归。Windows、安装包与原故障任务仍待验收。
