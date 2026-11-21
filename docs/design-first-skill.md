# Design First Skill 最小交付

这次交付是 pi-harness 内置的文档工作流。沿用当前普通会话的模型与原生工具，默认可用，不要求 ChangeStore、受管理执行或设计工作台。面向使用的命令示例见 [Design First 使用指南](design-first-usage.md)。

## 使用

- `/bug-fix <错误现象和预期行为>`：复现、诊断、保存修复方案与任务，确认后修复并执行回归检查。
- `/feat <小功能>`：保存新增行为、兼容边界、验收和任务，确认后实现与测试。
- `/design <需求>`：完整设计流程；`/design 恢复 <change-id>` 从文档和当前源码恢复。

确认属于 Skill 约定，不是强制工具锁。创建和恢复共用“明确指定位置 → 项目约定（如 OpenSpec）→ `docs/changes/` 回退”的顺序。简单改动采用 Quick，可把设计、任务、进度和结果合在一份 `design.md`；Standard/Deep 使用独立文件。需求以稳定 Req ID 和可观察 Scenario 贯穿任务、实现与结果，分级升级或降级记录原因和证据。确认前先保存完整提案；`/feat`、`/bug-fix` 或 `/design` 本身不构成实施授权，当前会话确认必须对应已保存并展示的 design/spec 版本，历史确认不作为新会话的执行授权。

实现前读取验证指引；有合适公共测试边界时按 vertical slice 执行 red → minimal green，没有时记录原因并验证真实 HTTP/CLI/浏览器等行为。完成后分别审查代码质量与设计/spec 符合度。项目已有 OpenSpec 约定时使用其 Requirement/Scenario delta 和校验方式；未安装或不能校验时记为 not_run/pending，不自动安装或归档。新增或补齐契约时更新 spec；修回已有准确契约则保留正文，在变更记录解释原因；有未决事项则记为 pending。测试记录真实命令、时间、环境、退出码及输入身份。源码发生变化后，旧通过结论只作为历史证据。

开关在设置的 Skills 和内置扩展列表共用，变更后新建会话或 reload。已明确关闭的设置保留；同名用户 Skill/模板/扩展沿用原生优先级。Wiki、SSH 节点和 Playground 不加载此资源。用户扩展或模板占用 `/design` 时保留用户实现，内置卡片显示冲突并禁用准备动作。

## 实现边界

- `assets/skills/design-first/`：1 个入口、11 份按需指引、6 份文档模板、3 份原生命令模板，共 21 个资源。
- `server/design-first-resources.ts`：定位随包资源、开关和 reload、命令模板路径填充。
- 复用既有原生命令目录、会话创建、设置和输入框，不增加模型、源码执行服务或后台任务。
- 协议 60 只为新增内置资源标识协调两端缓存版本，无 Workflow 消息或数据库。

## 验收依据与限制

本独立分支已验证资源加载、默认开关、同名覆盖、命令展开、原生工具执行、Wiki 重建排除和打包资源；具体环境与结果记录在下方。

真实 Harness 配置模型 `deepseek-v4.1-flash` 的样本：小功能确认后实现、6 项测试通过并更新 spec；Bug 修复 3 项测试通过，正确保留原 spec；新会话识别测试后的源码变化，不沿用旧 Passed；再次复验确认点，方案/任务落盘后才请求确认，新会话恢复未实施状态。样本不是所有模型的保证，完整人工质量评价与跨平台实机覆盖仍未完成。

本分支仅整理 Skill 最小交付，不包含 M2/M3 的 ChangeStore、审批快照、执行许可或工作台。这些仍保留在原工作区，未宣称整体架构完成。没有发布、安装或重启现有服务。

## 本分支验证

2026-11-17，macOS / Node v26.0.0：

- lockfile、协议单源（v60）、测试环境检查通过。
- `npm run typecheck`、前后端构建通过。
- `npm test`：196 个测试文件通过，1346 项通过、1 项跳过；包含设计令牌检查。
- `node tests/builtin-extensions-test.mjs --browser`：隔离服务及浏览器的默认资源、快捷目录、双设置开关、重载、草稿保留、中文/英文和窄布局通过。
- `node tests/force-reset-session-test.mjs`：强停重建保持普通/Wiki 资源范围通过。
- `node tests/new-chat-context-test.mjs --protocol-only`：关闭内置 Skill 时，系统提示与工具保持原生基线；新会话和历史恢复通过。
- 本地 `npm pack` 生成 616 文件、约 9.36 MB 的应用包；包含全部 20 个 Skill 资源和加载器，不包含 `dist/server/design-first/` 受管理执行引擎。

上述首轮检查使用同机依赖；后续干净安装、Linux 容器及桌面目录包验证分别记录如下。没有发布或替换现有服务。


### 干净目录安装验证

2026-11-17，在仓库外的全新临时目录，通过本地 tgz 执行 npm install，安装 343 个包并成功退出；依赖来自该安装目录，未复用开发工作区 node_modules。CLI --help 通过，SDK/pi-ai 均解析为 1.5.2。

安装目录的实际服务器通过 health/PID、三个默认命令、关闭/reload与开启/reload检查；`/feat` 发往本地夹具模型的文本包含安装包内 Skill 的绝对路径，模型保持不变。只有一次本地夹具模型请求，没有外部模型用量。测试服务和临时会话数据已清理。

本地包与本次结果保存在主工作区 `.scratch/skill-delivery/`：`youweichen-pi-harness-1.34.2.tgz`、`installation-result.json`、安装锁文件和检查脚本。包仍使用开发基线版本号，仅用于本地验收，未发布到 npm。可评审补丁已经在独立索引中通过相对基线的正向应用检查。


### 最低 Node 版本验证

2026-11-17，在 `node:22.19.0` Debian 容器（Linux ARM64）从同一 tgz 干净安装成功。实际包内服务通过默认命令、开关/reload、模型保持与安装路径展开检查；另直接调用安装 SDK 的原生 write/edit/read/bash，在临时项目真实执行测试失败→修改源码→测试通过→保存结果，退出码分别为 1 与 0。没有外部模型请求，只有应用检查的一次本地夹具模型请求，容器结束自动清理。

本次范围是该容器镜像、架构和 Node 版本；不外推为所有 Linux 发行版、Windows 或 Electron 已通过。镜像 ID、实际包哈希、环境及结构化结果保存在主工作区 `.scratch/skill-delivery/linux-installation-result.json`，对应日志及脚本同目录保留。

### macOS 桌面目录包验证

2026-11-18，使用独立工作树依赖构建 macOS ARM64 目录包 `release/mac-arm64/pi.app`（Electron 41.10.7，内嵌 Node 24.18.0），ad-hoc 签名完成。包内全部 20 个 Skill 文件与源码哈希一致，加载器与本分支构建产物一致，包内无受管理执行引擎。

- `packaged-server-start-test.mjs`：包内依赖、Skill/快捷入口、模板参数与实际包内路径、关闭/开启后的 reload、服务/WS 和已有原生扩展加载通过。
- `native-tools-desktop-test.mjs`：原生 MCP、Codemode worker、嵌套调用和 reload/resume 通过。
- `provider-auth-test.mjs`：使用包内 Electron runtime 的本地 OAuth 夹具通过，没有真实登录或外部模型请求。

首次打包遇到工作树依赖链接/临时复制目录问题，隔离依赖后重建成功；补强路径断言后也发现测试环境原先指向源码，已将 Skill 检查明确绑定实际包目录后重跑通过。测试日志和结构化记录位于主工作区 `.scratch/skill-delivery/desktop-*.log` 与 `desktop-installation-result.json`。

本次验证目录包的资源与后台运行能力；没有启动 GUI、制作或验证 DMG/ZIP 安装流程，也没有 Windows 实机验收。没有安装替换现有桌面应用或发布。

### 边界问题修订与复验

2026-11-18，独立审查发现并修正三处问题：创建与恢复对 OpenSpec/指定目录的选择不一致；安装路径中的 `$1` 等字符被原生模板当作参数替换；用户扩展覆盖快捷命令后，内置卡片仍错误列出该命令。主入口被覆盖时，卡片现在显示冲突并禁用准备动作，原生扩展优先级保持。

路径回归先复现两个失败，再验证修复；资源/原生闭环/编辑器/打包钩子共 19 项通过，类型检查和服务端构建通过。真实服务验证同名扩展的目录归属、实际 handler、零模型调用及移除后恢复。恢复规则经独立回读确认，20 个资源中的 19 条相对链接全部可解析；这项只读检查不冒充新的真实模型恢复试点。

修订后的 tgz 已重新构建，并在实际含 `$1` 和空格的 macOS 安装目录通过完整命令/开关/路径展开检查；桌面目录包已重建并通过三项包后回归。此前产物和记录保存在主工作区 `.scratch/skill-delivery/revisions/before-20261118-boundary-fixes/`，当前产物及哈希以同目录顶层 manifest 为准。

修订后的同一 tgz 也已在 Linux ARM64 / Debian Node 22.19 容器完成干净安装、原生读写/失败与通过测试、命令和开关重载验证；结构化结果见当前交付目录 linux-installation-result.json。

### 合入 develop 前复验

2026-11-18，对最小 Skill 工作树重新执行完整类型检查、前后端构建和 `npm test`，全部通过：196 个测试文件、1348 项通过、1 项跳过。协议单源（v60）、测试环境和 diff 格式检查通过。

构建后的 `builtin-extensions-test.mjs --browser` 验证默认资源、快捷入口、同名命令优先级、开关/重载、中文/英文及窄屏；`force-reset-session-test.mjs` 和 `new-chat-context-test.mjs --protocol-only` 验证强停恢复、原生会话与上下文隔离，均通过。此轮未重新运行真实模型质量试点，也未发布 npm 或桌面安装包。复验日志保存在开发工作区 `.scratch/skill-delivery/develop-*.log`。

### SDD 契约加固复验

2026-11-18，在包含后续 M2/M3 未提交改动的当前工作树，为 Req ID/Scenario 追踪、双审查、确认版本、OpenSpec 降级和资源清单增加契约回归。新增源资源漏打包与新增契约检查均先失败后通过；四个定向测试文件共 23 项通过。

协议单源、双端 typecheck、完整 build、测试环境及 diff 格式检查通过。最终全量为 201 个测试文件、1371 项通过、1 项跳过；内置扩展浏览器回归和完整新会话上下文回归通过；npm dry-run 包含 20 个非空 Skill 资源。afterPack 真实钩子单测覆盖新增资源缺失、空文件和意外文件。

本轮未调用外部真实模型，未制作或替换桌面包，也未发布、安装或重启服务。这些结果证明文档契约、原生接线与当前工作树回归，不证明跨模型行为或完整 M1 Go。

### `/design` 快捷入口复验

2026-11-18，新增第三个原生 Prompt Template `/design`，完整流程和恢复均复用随包指导文件；最终只保留 `/design`，不注册原生 Skill 或旧命令别名。设置页与设计工作台的准备动作使用 `/design`，扩展或用户模板占用主入口时显示冲突并禁用准备动作。

资源发现/路径/开关用例及真实服务清单均先失败后通过。四个定向测试文件 25 项通过；协议检查、双端 typecheck、完整 build、测试环境和 diff 格式检查通过；全量 201 个测试文件、1373 项通过、1 项跳过。`builtin-extensions-test.mjs --browser` 验证扩展/用户模板冲突、恢复、草稿保留和准备按钮；npm dry-run 包含 21 个非空资源及 `commands/design.md`。未调用外部真实模型或制作桌面包。
