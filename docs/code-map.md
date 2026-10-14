# 代码地图

查找文件、组件或模块职责时读本文件。各主题的修改规则以 `AGENTS.md` 列出的 `docs/architecture-*.md` 为准；目录或组件职责变化时同步更新这里。

## 目录结构

```
pi-harness/
├── server/                     # 后端（Node ESM，编译到 dist/server/）
│   ├── index.ts                # 入口：express 静态 + /ws 端点、消息分发、心跳、优雅停机
│   ├── app-version.ts          # 运行中 pi-harness 包版本（区别于 pi SDK VERSION）
│   ├── protocol.ts             # ★ 唯一事实源：wire 协议类型（client↔server 消息）
│   ├── agent-service.ts        # 核心：ClientSession（每客户端一个会话组，可并行多个对话）+ AgentService
│   ├── serialize.ts            # SDK 消息 → UiMessage 序列化
│   ├── text-sniff.ts           # 文件预览纯函数（previewKind/looksLikeText/decodeText/sniffImageMime/hexDump/countLines）
│   ├── process-utils.ts        # 进程工具：snapshotListeningPorts/killPidTree/lookupProcessName
│   ├── client-state.ts         # ClientStateStore：<dataDir>/client-state.json 持久化
│   ├── uploads.ts              # 文件对话上传 + 保留期清理
│   ├── bg-servers.ts           # 后台任务跟踪（bash 前后端口快照 diff + 存活刷新）
│   ├── component-updates.ts    # pi Agent / 扩展版本检查、来源校验与包更新
│   ├── extension-module-cache.ts # /restart、/reload 与扩展重载刷新扩展模块缓存（registerHooks 代数 + require.cache 清理，issue #64）
│   ├── system-prompt-view.ts / system-prompt-files.ts / system-prompt-routes.ts # 原生提示词分段、文件编辑与 reload
│   ├── session-reload.ts         # 提示词、设置、MCP 与斜杠命令共用的按会话重载队列
│   ├── settings-service.ts     # 界面偏好与原生资源只读视图（扩展命名见 extension-display.ts）
│   ├── task-progress.ts        # 从当前轮次工具记录推断任务进度与显式计划
│   ├── plan/                   # 可选原生 plan 扩展、全局开关与分支快照投影；见 docs/architecture-plan.md
│   ├── slash-commands.ts       # 斜杠命令（NATIVE_COMMANDS 内置命令拦截执行 + 目录推送）
│   ├── model-admin.ts          # 模型/服务商配置管理
│   ├── model-config-merge.ts   # 聊天模型表单合并；保留 typed models 和未知字段
│   ├── native-mcp-config.ts    # 原生 MCP 配置版本校验与敏感值；修改时读 docs/architecture-plugins.md
│   ├── provider-auth.ts        # 官方 OAuth 登录桥；凭据由 SDK 保存，不下发浏览器
│   ├── native-tools.ts         # 原生 MCP/codemode/tool_search factories；见 docs/architecture-plugins.md
│   ├── attachments.ts          # 附件构建（inline/reference/lines/imageData/fileData）
│   ├── webui-context.ts        # 扩展 UI 桥（WebUIContext：widgets/statuses/dialog → 浏览器）
│   ├── plugins.ts              # 可选界面组件插件（扫描 <dataDir>/plugins/<id>/）
│   ├── files-service.ts        # 文件服务（readDirForUI/readFile/searchFiles/watcher）
│   ├── code-search.ts          # ripgrep 代码搜索（search_content 分批推送、取消、限额）与 rg --files 文件名搜索
│   ├── sqlite-preview.ts       # SQLite 只读预览调度（sqlite-worker/query：隔离进程与分页查询）
│   ├── scm.ts                  # SCM 只读 git 查询（execFile git status/branches/history/filediff/commit）
│   ├── patch-node-pty.ts       # node-pty × Node --watch 兼容自愈补丁
│   ├── ensure-bash.ts          # Windows 轻量 bash 兜底（busybox-w32）
│   ├── control-socket.ts       # 本地控制 socket（status / quiesce / unquiesce）
│   ├── terminals.ts            # TerminalManager（PTY 管理 + 增量输出/按键工具）
│   ├── node-agent.ts           # 本机隔离 pi 会话，仅通过 SSH 工具操作节点
│   ├── node-command.ts         # SSH 命令目录引用；共享 PTY、确认及输出解析见 architecture-nodes.md
│   ├── node-sources.ts         # Xshell / SSH config 元数据解析
│   └── node-workbench.ts       # 内置 SSH 节点：来源同步/凭据/确认/PTY/SFTP/手动终端和文件操作
├── web/                        # 前端（React + Vite，编译到 web/dist/）
│   ├── vite.config.ts          # dev 端口 5173，/ws 代理到后端
│   ├── src/
│   │   ├── App.tsx             # 顶层布局
│   │   ├── use-chat.ts         # ★ useChat()：WebSocket 连接管理、reducer 状态机、终端 bridge
│   │   ├── use-workspace-scm.ts # 顶栏与文件栏共用 Git 改动状态，按请求 ID 和 cwd 校验归属
│   │   ├── types.ts            # ★ wire 协议 re-export shim（`export type * from "../../server/protocol"`）
│   │   ├── i18n.tsx            # ★ 中英文案（zh 默认），新增 key 必须两处都加
│   │   ├── styles.css          # ★ 全部样式（按组件分区，带注释分隔线）；应用外观与独立代码配色
│   │   ├── theme.ts            # CSS 变量 → xterm 终端调色板桥接（THEME_CHANGE_EVENT + buildTermTheme）
│   │   ├── sounds.ts           # WebAudio 提示音
│   │   ├── download.ts         # 下载（fetch→blob，绕开 Chrome Safe Browsing）
│   │   ├── message-delta.ts    # message_delta 增量 patch 纯函数，有单测
│   │   ├── lazy-window.ts      # 消息列表惰性窗口化纯函数，有单测
│   │   ├── search-text.ts      # 会话内搜索索引纯函数，有单测
│   │   ├── skill-block.ts      # parseSkillBlock：<skill> 块解析，有单测
│   │   ├── auth-token.ts       # PI_WEB_TOKEN 口令注入，有单测
│   │   ├── image-paste.ts      # 粘贴图片等比缩放 ≤1568px + PNG/JPEG 转码
│   │   ├── uuid.ts             # randomUuid（crypto 兜底），有单测
│   │   ├── protocol-version.ts # 协议版本常量
│   │   ├── main.tsx            # 入口：initAuthToken
│   │   └── components/         # 见下
│   └── dist/                   # 构建产物（gitignore，但打进 npm 包）
├── bin/pi-harness.mjs          # CLI：前台启动 / server install|uninstall|start|stop|restart|status
├── deploy/                     # 部署示例：launchd plist / systemd unit / Windows 任务 XML
├── tests/                      # 全部测试脚本（自包含：独立端口 ≥8900 + 临时 data-dir）
│   ├── run-smoke.mjs           # 零 token 协议冒烟聚合跑器
│   ├── unit/                   # vitest 纯函数单测
│   ├── *-test.mjs              # 手写 Playwright E2E / WS 协议测试
│   └── scratch/                # 一次性调试脚本（gitignore，不入库）
├── scripts/check-protocol-sync.mjs  # 守护 types.ts shim 单源机制 + protocol.ts 纯类型约束
├── .github/workflows/ci.yml    # CI：lockfile 检查 → 安装 → 协议同步 → typecheck → build → vitest → 冒烟
├── extensions/                 # npm CLI 扩展：webui.ts（/webui 启动浏览器；Desktop 不打包）
├── electron/                   # Electron 桌面版壳子（main.mjs 主进程 + 沙箱兼容的 preload.cjs），本地构建，不进 npm 包
├── electron-builder.yml        # Electron 打包配置（mac dmg/zip、win nsis/portable、linux AppImage/deb）
├── build/                      # electron-builder 用的图标源文件（icon.png 1024x1024 + icon.ico）
├── dev/                        # 本地开发辅助（不入 npm 包）
├── Dockerfile / docker-compose.yml
├── docs/                       # 详细文档（AGENTS.md 的分拆；code-map.md 为本文件）
│   ├── architecture-core.md    # 核心架构：快照驱动、协议单源、安全边界、多对话并发
│   ├── architecture-attachments.md  # 附件、图片、文件上传/预览/下载
│   ├── architecture-terminal.md    # 终端架构：PTY 管理、SCM 查询
│   ├── architecture-plugins.md     # 插件系统：形态、协议、宿主扩展点、MCP 桥
│   ├── development.md          # 开发工作流、CI、编码约定、测试规范
│   ├── release.md              # 发布流程（GitHub + npm）
│   ├── deployment.md           # 部署（CLI / Docker）
│   └── env-vars.md             # 环境变量参考
├── tsconfig.server.json / tsconfig.extensions.json / tsconfig.tests.json / web/tsconfig.json
```

`web/src/components/` 速览：

| 组件 | 职责 |
| --- | --- |
| `FilePreview.tsx` | 右栏代码高亮编辑与媒体/SQLite 只读预览；Markdown 点击自动进入 Wiki；当前文件 chip 严格镜像预览面板，发送时携带编辑器快照（含未保存改动）；版本校验保存与离开保护（详见 docs/architecture-attachments.md） |
| `LeftPanel.tsx` / `WorkspaceSwitcher.tsx` | 全高项目栏：品牌、Workspace 切换器（自定义弹出菜单）、可折叠项目及会话、悬停更多菜单（重命名／删除）、连接／语言／设置；布局见 `docs/ui-design.md` |
| `RightPanel.tsx` / `TaskProgressPanel.tsx` | 可展开目录树、Git 改动标记、文件预览；当前任务进度由服务端 transcript 推断，右栏展示合并后的任务阶段和结果；布局见 `docs/ui-design.md` |
| `ChatInput.tsx` | 输入框 + 附件 chips（inline/reference/lines 三色）+ 当前文件 chip（镜像预览面板，发送取编辑器快照）；全窗口拖放目标；followUp 排队/steer 插队；斜杠命令选择器 |
| `Message.tsx` / `MessageList.tsx` / `WorkingStatus.tsx` | 消息渲染、流式等待标题与静默状态、tool 结果关联；编辑重问、惰性窗口化、问题导航；等待态切换与间距见 `docs/ui-design.md` |
| `PlanChecklist.tsx` | Web/桌面共用清单卡和变化行；修改计划更新合并、替换隔离或步骤跳转时，读取 `web/src/plan-presentation.ts`、`docs/architecture-plan.md` 和 `docs/ui-design.md` |
| `ToolCallBlock.tsx` / `BashGroup.tsx` / `EditWriteCard.tsx` / `ThinkingBlock.tsx` | 通用工具卡片、连续命令分组、编辑与写入的逐行 diff 卡片、思考块；修改命令合并/折叠/跳转时读取 `web/src/bash-groups.ts` 和 `docs/ui-design.md` 的 27a 规则；编辑卡片的数据整理在 `web/src/edit-write-presentation.ts`，交互规则见 `docs/ui-design.md` |
| `ChangesPanel.tsx` / `ChangeSummaryCard.tsx` | 35a 对话改动面板及每轮汇总；修改范围、定位、折叠、搜索或轮次统计前读取 `docs/chat-diff-design.md` 与 `docs/architecture-terminal.md`；本轮共用 `task-outputs.ts`，Git 范围走 `scm_diff`（协议 v41） |
| `TerminalPanel.tsx` / `TermXterm.tsx` | 终端视图 + xterm 实例桥接 |
| `SCMPanel.tsx` | 源代码管理（Git）视图：status/branch/diff；提交/推送/拉取/切换分支 |
| `TopBar.tsx` / `FooterBar.tsx` | 顶栏（项目／会话标题、后台任务、视图切换、文件栏开关）、状态栏（连接／版本／分支／工作目录及扩展状态）；模型与思考强度在 `ChatInput.tsx` 底部 |
| `Dialog.tsx` | 扩展 `ui.select/confirm/input` → 浏览器弹窗 |
| `ModelConfigModal.tsx` / `PiSetupModal.tsx` | models.json 管理 / 首次配置引导 |
| `SystemPromptPanel.tsx` | 原生提示词分段、全文复制、SYSTEM/APPEND/上下文文件编辑；见 `docs/architecture-system-prompt.md` |
| `SettingsModal.tsx` | 设置面板（原生提示词/技能/扩展/MCP/更新；更新页不显示 pi-harness 本身；默认打开原生提示词，各页使用设置 v2 带用途说明的分组列表，MCP 常用控件自动保存；见 docs/ui-design.md） |
| `BgTasksModal.tsx` | 后台任务弹窗：AI 启动的监听端口进程列表 |
| `ModelThinking.tsx` | 模型 + 思考强度下拉（模型下拉顶部有搜索过滤框；输入工具栏思考档位为带说明的四档菜单：关闭／极简／标准／深度） |
| `GlobalSearchModal.tsx` | 全局搜索弹窗（Ctrl+K）：搜历史对话/最近项目/工作区文件名 |
| `CodeSearchModal.tsx` | 代码搜索弹窗（⌘P）：代码 / 文件名两种模式、按文件分组、右侧预览、Enter 打开到行；见 `docs/ui-design.md`「代码搜索」 |
| `PluginView.tsx` | 插件视图宿主：薄 React 壳 + 动态 import client bundle |
| `NativeMcpPanel.tsx` | 原生 MCP 与 Codemode 设置；修改作用域或信任时读 `docs/architecture-plugins.md` |
| `NodeWorkbench.tsx` / `node-terminal.tsx` | SSH 节点工作台：来源同步、详情/凭据、节点 Agent Chat 与手动终端；修改时阅读 `docs/architecture-nodes.md` |
| `CollapsedMessage.tsx` / `LazyMount.tsx` | 消息折叠摘要行 / 消息级惰性挂载包装 |
| `SearchBar.tsx` | 会话内搜索栏（Ctrl+F，CSS Custom Highlight API 高亮） |
| `Markdown.tsx` / `Dropdown.tsx` / `copy-button.tsx` / `SoundSettings.tsx` | 通用件 |

## 功能入口

- **Wiki**：`WikiDocumentModal.tsx` / `WikiWorkbench.tsx`（34a 工具栏 `WikiToolbar.tsx`），服务端 `server/wiki-routes.ts` 与 `server/wiki-service.ts`。
- **数据库**：顶栏打开三栏弹窗，右侧复用原 Agent Chat；后端 `server/database/`，界面 `DatabaseWorkbench.tsx`；旧 db-client 界面插件保持独立。

## 架构主题速查

| 主题 | 文档 | 要点 |
| --- | --- | --- |
| **快照驱动** | `docs/architecture-core.md` | 服务端是唯一事实源，60ms 节流推快照；增量快照（snapshot_delta）；message_delta 实时增量通道不经 snapshot 通道；WS permessage-deflate 压缩；多标签页序列化共享；协议版本协商 |
| **项目分组与切换缓存** | `docs/architecture-core.md` | 修改 workspace 分组、切换、缓存或异步归属时阅读：请求确认、权威状态与展示分离、3 项目/32MiB LRU、隐藏视图刷新策略；界面切换不弹成功通知，命令切换在目标会话保留事件 |
| **协议单源** | `docs/architecture-core.md` | `server/protocol.ts` 是唯一事实源；`web/src/types.ts` 是 `export type *` shim；新增消息只改 protocol.ts，两端 switch 各加分支 |
| **安全边界** | `docs/architecture-core.md` | 默认只绑 loopback；WS Origin/Host 同权威校验；quiesce 准入控制；控制 socket；provider headers 不下发浏览器 |
| **多对话并发** | `docs/architecture-core.md` | 每对话手动终端和文件操作SessionRuntime；对话按项目归属；set_cwd 切到目标项目对话；8 个上限/项目；共享同一个 ModelRuntime |
| **附件** | `docs/architecture-attachments.md` | 三种模式（inline/reference/lines）；图片问答（base64 + 缩放）；文件上传（fileData 落盘） |
| **文件预览** | `docs/architecture-attachments.md` | 修改右栏编辑、保存冲突或草稿离开保护时阅读；512KB 预览、媒体 HTTP Range、下载 |
| **终端** | `docs/architecture-terminal.md` | 每 Conversation 一个 TerminalManager；spawn 统一准入；按键编码纯函数；输出微批合并；node-pty × --watch 兼容自愈 |
| **SCM** | `docs/architecture-terminal.md` | 只读 git 查询走 execFile；未跟踪文件显示限量内容；git-dir watcher；写操作走可见终端 tab |
| **插件** | `docs/architecture-plugins.md` | <dataDir>/plugins/<id>/ 目录（manifest.json + index.mjs + client/entry.mjs）；attach 时热重扫；MCP 工具桥 |
| **SSH 节点** | `docs/architecture-nodes.md` | 修改 Xshell/SSH config 同步、凭据、执行确认或终端引用时阅读；本机隔离 Agent 与 ssh2 节点工具 |
| **工具结束实时状态** | `docs/architecture-core.md` | tool_status 先于快照落盘，浏览器卡片立即从「执行中」→「已结束」 |
| **运行静默状态** | `docs/architecture-core.md` | 改模型无响应或长时间工具运行提示时，使用 conversationId 绑定的 agent_silence；恢复响应即清除，重试只适用于本轮未调用工具的纯文本请求 |
| **当前任务进度** | `docs/architecture-core.md`、`docs/ui-design.md` | 修改任务判定、提纲布局或计划触发时阅读：可选原生 `plan` 管理分支版本化计划，尊重用户／skill 的执行与等待规则；步骤按工具 ID 展开记录，暂停不自动完成，兼容历史 `task_plan`；历史任务列表尚未实现 |
| **后台任务列表** | `docs/architecture-core.md` | bash 前后端口快照 diff；按客户端持久；单停/全部关闭 |
| **扩展 UI 桥** | `docs/architecture-core.md` | setWidget/setStatus/notify/select/confirm/input → 浏览器消息；dialog_response 回传 |
