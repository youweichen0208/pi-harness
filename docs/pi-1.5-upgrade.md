# Pi 1.5.2 升级契约

`@earendil-works/pi-coding-agent` 与 `@earendil-works/pi-ai` 精确锁定 1.5.2，内部 agent-core、schema、tui、mcp、codemode 同步为 1.5.2。Node 最低版本仍为 22.19.0，Electron 与 undici 保持原版本。使用原版 SDK，无补丁。依据官方 [1.5.1](https://github.com/earendil-works/pi/releases/tag/v1.5.1)、[1.5.2](https://github.com/earendil-works/pi/releases/tag/v1.5.2) 发布说明及本次安装产物。

## 适用能力与宿主接入

| 能力 | 实现与边界 |
| --- | --- |
| 缓存预热 | 模型菜单全局三态：off / streaming / idle。未配置时由宿主 getter 保持 streaming，不在启动时写配置；尊重原有显式值，项目配置不能开启全局预热。已打开普通/Wiki/SSH 会话同步，调查子代理保持 off。费用详情按需每 5 秒读取原生状态，原生 usage 只计费一次，不插入聊天或重置任务看门狗。见 [核心架构](architecture-core.md) |
| Anthropic message threads | 由原生提供官方端点默认策略、增量续接及历史/系统提示/工具变化后的完整上下文回退。模型配置兼容选项可显式覆盖，不改写已有配置 |
| OpenAI 兼容项 | 服务商及模型提供 `promptCacheKeyMode`、`requiresNonNullAssistantContent`、`requiresToolsWithToolHistory`，并提供 `supportsMessageThreads`；缺省继承、布尔三态，白名单投影，未知字段与凭据保留。见 [模型来源](architecture-model-sources.md) |
| 扩展更新摘要 | 按实际版本或 Git HEAD 展示更新/无变化/跳过/警告/失败，保留原生结果与诊断；部分失败保留已完成项，日志默认收起。见 [扩展架构](architecture-extensions.md) |
| 新模型与分类 | 使用原生模型目录、Qwen China 等服务商及最新费用；Microsoft-Decision-1 经 `models.classify` 使用，分类/图像模型不混入聊天列表，不替用户切换默认模型 |
| 内容展示 | Markdown、工具输出、读取和差异共用 Dart/Nix/Groovy/Gradle 高亮；现有 Mermaid 验证饼图和 class 样式，保留 strict 安全模式，禁用脚本回调 |
| OAuth 与生命周期 | 获得原生 Anthropic OAuth 请求标识及凭据刷新修复；SSH 的 close/替换/服务退出等待 abort、dispose 和凭据落盘。见 [节点架构](architecture-nodes.md) |
| 原生工具修复 | 获得流式有界 read、UTF-8/取消处理、grep 上下文/glob、edit 混合换行保留、图片队列、MCP 连接清理、运行中重载保护等原版修复 |
| Schema | 1.5.2 恢复 `Type.BigInt()` / `Type.Undefined()` 校验与转换；BigInt 仍不可直接序列化为 JSON，工具返回和 wire 数据必须可序列化。`Type.Void()`、Refine/codecs/自定义 Format 不能据此视为支持 |

CLI 的 `pi auth login/logout`、Radius MCP、TUI 快捷键/终端图表及示例扩展不另造 Web 对应界面；保留现有官方登录与 MCP 配置入口。上游 plan/subagent 示例不会替换宿主 Workspace 子代理，也不会恢复已移除的 plan 扩展。

1.5.2 初次接入使用协议 v53；v54 已移除宿主的失效目录历史恢复入口。`protocol.ts` 保持唯一类型源。两个提示词私有入口继续精确保护 1.5.2，并校验原生输出与分段全文一致；MCP 校验使用 SDK 兼容入口，不直接复制其实现。原生 JSONL 保持不变；缓存费用不另建账本。

## 1.5.2 验证（2026-11-12）

测试使用临时配置、隔离端口、本地模型/SSH/HTTP 夹具，不访问真实账号，不产生模型费用。新增回归：

- `cache-warming-test.mjs` / `cache-warming-browser-test.mjs`：全局与项目优先级、多会话同步、原生费用持久化、SSH 凭据等待、详情轮询生命周期及窄屏。
- `pi152-model-compat-test.mjs`：本地 HTTP 检查实际 null/空字符串、tools 省略/空列表和 prompt cache key；Anthropic thread 首次创建、增量续接、系统/工具变化回退与显式关闭。
- `pi152-model-ui-test.mjs`：三态/继承/保存/重开、中英文、375px 明暗模式、新语言与原语言并存、Mermaid 饼图/样式/安全回调。
- `pi-152-sdk-test.mjs`：原生 BigInt/Undefined 精度与执行准入、read 分块 UTF-8/范围/截断/取消，edit BOM 与混合换行保持。
- `unit/extension-updates.test.ts`、`extensions-worker-test.mjs`、`extensions-update-browser-test.mjs`：实际版本摘要、失败后继续、原生警告、离线跳过、worker IPC、日志折叠与窄屏。

本地验收结果：

- `check:lockfile`、`check:protocol`（v53）、`check:testenv`、`typecheck`、`build` 和设计令牌检查通过。
- `npm test`：188 个测试文件通过，1259 项通过、1 项跳过。
- 默认冒烟清单现有 101 项，已完成覆盖：全量首轮 98/100；修复旧 provider catalog 夹具和代理测试固定端口冲突后，连同新增的模型兼容用例及相关回归，定向 9/9 通过。
- 恢复、预热、模型兼容项与扩展摘要的浏览器回归通过，检查中英文、375px/1440px 和明暗模式；命令分组及当前文件附件浏览器回归也通过。
- macOS arm64 `electron-builder build --mac --dir --publish never` 通过；包内 `native-tools-desktop-test.mjs`、`packaged-server-start-test.mjs`、`provider-auth-test.mjs` 通过，确认新增 pi-mcp/pi-codemode 从包内解析。验证使用未压缩 `.app`，未生成或发布 DMG/ZIP。
- 打包发现本地隐藏工作树含旧 `.app`，已显式排除 `.claude`、`.playwright-mcp`、`.scratch` 和 npm 压缩包，并在包内启动检查中验证开发目录未被带入；不删除本地工作树。

真实服务商 OAuth、真实模型计费及 Windows/Linux 真机安装包仍由对应环境验证；本地模拟通过不代表真实账号授权成功。三平台打包验收继续使用现有 CI 工作流，不自动发布。

## 1.5.0 历史升级记录

此前将 `@earendil-works/pi-coding-agent`、`@earendil-works/pi-ai` 精确锁定到 1.5.0，宿主 `undici` 锁定到 8.12.3。内部 agent-core、schema、tui 同步为 1.5.0；生产 SDK 与宿主共用 undici 8.12.3。Electron 保持 41.10.7，适配验证时应用版本为 1.11.1，随后按用户发布请求纳入 v1.12.0 GitHub 桌面 Release；不发布 npm。

## 变化与接入

依据安装产物的 `CHANGELOG.md`、`dist/auth/types.d.ts`、`dist/utils/validation.js`、扩展兼容入口以及[官方 v1.5.0 发布说明](https://github.com/earendil-works/pi/releases/tag/v1.5.0)。前一轮契约见 [1.4 升级记录](pi-1.4-upgrade.md)。

| 上游变化 | 宿主处理 |
| --- | --- |
| pi-schema 校验取代 TypeBox 校验 | 保留现有 TypeBox JSON Schema 定义及业务层权限检查；测试普通 Schema 和 TypeBox 的执行准入、转换和错误边界，不匹配完整错误文案 |
| pi-ai 根入口不再导出 TypeBox | 本项目继续直接从 typebox 导入；用户扩展由 SDK 的 pi-ai-extension-view 兼容 Type/StringEnum，包内首次加载和 reload 都做验证 |
| 提示词精简 | 两个内部适配器的精确保护更新为 1.5.0；仍使用原生构建结果和全文一致性校验；不匹配时只读回退，模板失败保留草稿 |
| 设备码操作标志 | ProviderAuthState 增加 openBrowserOnConfirm/copyCodeOnConfirm，协议 49 → 50；缺省均为 true，只在按钮点击时执行，阶段切换清除旧设备码及标志 |
| 扩展安装失败诊断 | 读取资源加载器 warnings/errors；首次连接前缓存，连接和重载后通过现有带会话归属的 notice 显示 |
| MCP OAuth 注册策略 | 原生 JSON 校验接受 auto/dcr/cimd，省略字段不写回默认值；保留凭据掩码、版本冲突和项目覆盖机制 |
| 流式参数、搜索、持久化及服务商修复 | 随原版 SDK 获得，复用消息投影、恢复、取消和 agent_settled 生命周期；大参数预览仍受宿主长度限制 |
| 新模型、费用和实际响应模型 | 使用原生目录与费用，不改变选定模型或 openai-codex 展示过滤策略 |
| TUI、CLI 自更新、扩展更新日志 | 不移植到宿主界面，不改变 Electron 更新流程 |

没有 SDK 补丁，没有自动改写用户扩展、凭据或历史会话。未新增宿主自动重试或模型调用。

## 第三方扩展迁移

在 1.5.0 中，工具参数必须是可表达为 JSON Schema 的约束，`Type.Refine()`、`Type.BigInt()`、`Type.Undefined()`、codecs 和 `Format.Set()` 自定义格式不再参与原生工具校验；**1.5.2 已恢复 BigInt/Undefined，当前规则以上文为准**。其他不能表达的检查放入执行前业务校验。普通 JSON Schema／MCP 同样会发生类型转换，因此执行层不能假定收到的是模型原始 JSON。

扩展仍可通过原生加载器从 pi-ai 导入旧式 Type/StringEnum；这不表示 pi-ai 的普通 Node 根入口恢复这些导出。扩展对宿主提供的 Pi 包应声明 `peerDependencies: "*"`，避免自身安装的副本绕过兼容入口。

## 验证记录（2026-11-03，macOS arm64）

所有运行测试使用临时配置、数据和本地模拟服务，未调用付费模型，未停止用户实例。

- `check:lockfile`、`check:protocol`（v50）、`check:testenv`、`typecheck`、`build`：通过。
- 零 token 冒烟：原清单 91/91 通过；新增 schema／扩展诊断脚本另跑 2/2 通过，共 93 项。覆盖原生提示词、Codemode 排队/取消、子代理报告、会话恢复、MCP 配置/脱敏、代理 CONNECT/OAuth/WebSocket、发送回执和终端。
- `npm test`：155 个测试文件通过；1006 项通过、1 项跳过。包含模板投递、提示词一致性及新增 MCP 注册策略保留测试。
- `pi-150-sdk-test.mjs`：TypeBox 和纯 JSON Schema 的必填缺失、类型、枚举、长度、可选/null、数字字符串和单值数组；通过真实 runToolCall 证明非法参数不执行；大规模 Unicode/转义分片参数和有界 WebUI 投影通过。
- `extension-diagnostics-test.mjs`：注入原生包解析安装失败及真实扩展加载失败，验证首次 attach 和 reload 通知；没有访问 registry。以上两个脚本已加入默认冒烟清单。
- `provider-auth-test.mjs`：五组操作标志（含缺省）、重放、阶段清理、取消、过期响应和凭据隔离通过。
- `native-features-browser-test.mjs`：中英文设备码确认、四组显式标志及缺省、重放无副作用、剪贴板拒绝后的手动复制提示、授权码提交和取消通过。
- `current-file-protocol-test.mjs --browser`：冻结编辑器快照、附件实际投递、历史与编辑重问通过，文件磁盘内容不变。
- `electron-builder build --mac --publish never`：arm64 DMG 和 ZIP 构建通过。`asar: false`、服务子进程及原生模块构建方式保持。
- macOS 包内 `native-tools-desktop-test.mjs`、`packaged-server-start-test.mjs`、`provider-auth-test.mjs`：通过。验证包内 ESM 依赖解析（含 pi-schema）、Codemode worker/WASM、SDK 文档和模型运行资源、旧 Type/StringEnum 扩展首次加载/reload、懒加载 OAuth、终端与服务启动；依赖定位不得借用开发仓库。

Windows、Linux 真机安装包、Windows 路径大小写与旧版安装程序升级恢复未在本机执行，须由对应平台 CI 及升级验收验证；已有三平台发布工作流会执行增强后的包内测试。v1.12.0 发布阶段由 GitHub 工作流执行上述平台检查，结果以对应 Actions 运行为准。真实服务商 OAuth/MCP 注册和账号计费未验证，模拟测试不代表真实账号授权成功。macOS 安装包为原有 ad-hoc 签名，未公证。
