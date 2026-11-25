# 源码导航

> 本文档是源码导航快照，实际代码及对应架构文档为事实源。新增、移动或删除重要模块时同步维护本地图；修改前的必读规则统一保留在根 `AGENTS.md`。

## 目录结构

```
pi-harness/
├── server/                     # 后端（Node ESM，编译到 dist/server/）
│   ├── index.ts                # 入口：express 静态 + /ws 端点、消息分发、心跳、优雅停机
│   ├── app-version.ts          # 运行中 pi-harness 包版本（区别于 pi SDK VERSION）
│   ├── protocol.ts             # ★ 唯一事实源：wire 协议类型（client↔server 消息）
│   ├── wiki-conversations.ts   # Wiki 对话生命周期：文档绑定、历史操作、占用与运行实例编排；见 docs/architecture-wiki.md
│   ├── agent-service.ts        # 核心：ClientSession（每客户端一个会话组，可并行多个对话）+ AgentService
│   ├── serialize.ts            # SDK 消息 → UiMessage 序列化
│   ├── snapshot-timings.ts     # 默认 summary 的快照构建/WS 采样；detail 才逐报文扫描 bytes
│   ├── execution-trace.ts / trace-store.ts # 默认开启的 Agent Execution Trace：有界归因、metadata JSONL 与崩溃恢复
│   ├── session-export.ts       # 原生 HTML/JSONL 受控导出：权限/规模预检、单次下载 token、TTL 与流式清理
│   ├── text-sniff.ts           # 文件预览纯函数（previewKind/looksLikeText/decodeText/sniffImageMime/hexDump/countLines）
│   ├── process-utils.ts        # 进程工具：killPidTree
│   ├── client-state.ts         # ClientStateStore：<dataDir>/client-state.json 持久化
│   ├── uploads.ts              # 文件对话上传 + 保留期清理
│   ├── playground.ts           # Playground 路由：status/config/run（HTTP+SSE）；见 docs/architecture-playground.md
│   ├── playground-config.ts    # Playground 全局开关：归一化、环境锁与 <dataDir>/playground.json 存储
│   ├── playground-python.ts       # Python 探测：命令解析（PI_WEB_PYTHON 优先）、懒探测 + TTL、失败只降级不崩服务
│   ├── playground-run.ts       # Run 执行：语法检查后运行、临时目录、超时/超输出杀进程树、并发闸门
│   ├── playground-source.ts    # 纯函数：Python 导入错误判定、输出限额、needs-the-project 判定
│   ├── component-updates.ts    # pi Agent / 扩展版本检查、来源校验与包更新
│   ├── extension-module-cache.ts # /restart、/reload 与扩展重载刷新扩展模块缓存（registerHooks 代数 + require.cache 清理，issue #64）
│   ├── knowledge-*.ts           # Learn / Ask 请求、登记来源、证据、调查与审批写入，见 architecture-knowledge.md
│   ├── engineering-skills.ts     # 普通会话的十一项随包 Skills：路径、同名覆盖、诊断与会话隔离
│   ├── system-prompt-view.ts / system-prompt-files.ts / system-prompt-routes.ts # 原生提示词分段、文件编辑与 reload
│   ├── session-reload.ts         # 提示词、设置、MCP 与斜杠命令共用的按会话重载队列
│   ├── settings-service.ts     # 界面偏好与原生资源只读视图（扩展命名见 extension-display.ts）
│   ├── task-progress.ts        # 从当前轮次工具记录推断任务进度与显式计划
│   ├── slash-commands.ts       # 斜杠命令（NATIVE_COMMANDS 内置命令拦截执行 + 目录推送）
│   ├── model-admin.ts          # 模型/服务商配置管理
│   ├── model-config-merge.ts   # 聊天模型表单合并；保留 typed models 和未知字段
│   ├── native-mcp-config.ts    # 原生 MCP 配置版本校验与敏感值；修改时读 docs/architecture-plugins.md
│   ├── provider-auth.ts        # 官方 OAuth 登录桥；凭据由 SDK 保存，不下发浏览器
│   ├── openai-proxy.ts / openai-proxy-routes.ts # 本机可配置 OpenAI 代理；修改分流、持久化或网络初始化时读 docs/architecture-core.md
│   ├── native-tools.ts         # 原生 MCP/codemode/tool_search factories；见 docs/architecture-plugins.md
│   ├── attachments.ts          # 附件构建（inline/reference/lines/imageData/fileData）
│   ├── webui-context.ts        # 扩展 UI 桥（WebUIContext：widgets/statuses/dialog → 浏览器）
│   ├── plugins.ts              # 可选界面组件插件（扫描 <dataDir>/plugins/<id>/）
│   ├── files-service.ts        # 文件服务（readDirForUI/readFile/searchFiles/watcher）
│   ├── code-search.ts          # ripgrep 代码搜索（search_content 分批推送、取消、限额）与 rg --files 文件名搜索
│   ├── sqlite-preview.ts       # SQLite 只读预览调度（sqlite-worker/query：隔离进程与分页查询）
│   ├── scm.ts                  # SCM 只读 git 查询（spawn、同 cwd 状态合并、进程树超时）
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
│   │   ├── playground-scratch-store.ts / use-playground-scratch.ts # 草稿状态、保存队列与 React/HTTP 接线；见 docs/architecture-playground.md
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
├── build/                      # electron-builder 用的图标源文件（icon.png 1024x1024 + icon.ico）；installer.nsh 为 NSIS 安装/卸载前运行中实例检测
├── assets/skills/              # 十三项随包 Skills、必要参考、固定上游记录与 MIT License
├── dev/                        # 本地开发辅助（不入 npm 包）
├── Dockerfile / docker-compose.yml
├── docs/                       # 详细文档（本文件的分拆）
│   ├── architecture-core.md    # 核心架构：快照驱动、协议单源、安全边界、多对话并发
│   ├── architecture-attachments.md  # 附件、图片、文件上传/预览/下载
│   ├── architecture-terminal.md    # 终端架构：PTY 管理、SCM 查询
│   ├── architecture-plugins.md     # 插件系统：形态、协议、宿主扩展点、MCP 桥
│   ├── architecture-playground.md  # Python 代码块运行（Playground）：首次检测到可用 Python 默认开启，保留已保存开关、非沙箱、Python 探测与执行限制
│   ├── development.md          # 开发工作流、CI、编码约定、测试规范
│   ├── release.md              # 发布流程（GitHub + npm）
│   ├── deployment.md           # 部署（CLI / Docker）
│   └── env-vars.md             # 环境变量参考
├── tsconfig.server.json / tsconfig.extensions.json / tsconfig.tests.json / web/tsconfig.json
```

## `web/src/components/` 速览

| 组件 | 职责 |
| --- | --- |
| `FilePreview.tsx` | 右栏代码高亮编辑与媒体/SQLite 只读预览；Markdown 点击打开单文件弹窗并复用主聊天，正文共用 `DocumentReading`（见 `docs/architecture-wiki.md`「共用阅读画布」）；保存生命周期位于 `file-document.ts`，React 接线为 `use-file-document.ts`；当前文件 chip 严格镜像预览面板，发送时携带编辑器快照（含未保存改动）；版本校验保存与离开保护（详见 docs/architecture-attachments.md） |
| `DocumentReading.tsx` / `UnsavedChangesDialog.tsx` | 知识库与单文件弹窗共用的阅读画布（标题、chips、属性表、富文本与反链，能力全部由 props 注入）与未保存确认框（纯 UI，状态机在各自宿主） |
| `LeftPanel.tsx` | 240px 单栏导航与 56px 收起态：顶部 Workspace 搜索切换浮层、小记入口、项目及会话、分组管理和底部设置；布局见 `docs/ui-design.md` |
| `RightPanel.tsx` / `TaskProgressPanel.tsx` | 可展开目录树、Git 改动标记、文件预览；当前任务进度由服务端 transcript 推断，右栏只展示执行阶段与 Codemode 记录（不显示请求标题、生命周期状态文字，也没有本轮文件分区），展开阶段按顺序列出全部命令与编辑；布局见 `docs/ui-design.md` |
| `ChatInput.tsx` | 输入框 + 附件 chips（inline/reference/lines 三色）+ 当前文件 chip（镜像预览面板，发送取编辑器快照）；全窗口拖放目标；followUp 排队/steer 插队；斜杠命令选择器 |
| `TraceWorkbench.tsx` | 顶栏 Trace 与 `/trace` 的 run 列表、模型／工具／宿主时间线和请求明细；`/trace-export` 下载安全静态 HTML 或 metadata JSON；数据契约见 `docs/architecture-core.md` |
| `Message.tsx` / `MessageList.tsx` / `WorkingStatus.tsx` | 消息渲染、流式等待标题与静默状态、tool 结果关联；编辑重问、惰性窗口化、问题导航；等待态切换与间距见 `docs/ui-design.md` |
| `ToolCallBlock.tsx` / `BashGroup.tsx` / `EditWriteCard.tsx` / `ThinkingBlock.tsx` | 通用工具卡片、读取行式（与命令行同款单行，正文仅预览 `READ_PREVIEW_LINES` 行）、连续命令分组、编辑与写入的逐行 diff 卡片、思考块；修改命令合并/折叠/跳转时读取 `web/src/bash-groups.ts` 和 `docs/ui-design.md` 的 27a 规则；编辑卡片的数据整理在 `web/src/edit-write-presentation.ts`（内联 diff 预览上限 `EDIT_WRITE_PREVIEW_LINES` 与 `clampDiffPreview`），交互规则见 `docs/ui-design.md` |
| `ChangesPanel.tsx` / `ChangeSummaryCard.tsx` | 35a 对话改动面板及每轮汇总；修改范围、定位、折叠、搜索或轮次统计前读取 `docs/chat-diff-design.md` 与 `docs/architecture-terminal.md`；本轮共用 `task-outputs.ts`，Git 范围走 `scm_diff`（协议 v41） |
| `TerminalPanel.tsx` / `TermXterm.tsx` | 终端视图 + xterm 实例桥接 |
| `SCMPanel.tsx` | 源代码管理（Git）视图：status/branch/diff；提交/推送/拉取/切换分支 |
| `TopBar.tsx` / `FooterBar.tsx` | 顶栏（项目／会话标题、视图切换、文件栏开关）、状态栏（连接／版本／分支／工作目录及扩展状态）；模型与思考强度在 `ChatInput.tsx` 底部 |
| `Dialog.tsx` | 扩展 `ui.select/confirm/input` → 浏览器弹窗 |
| `ModelConfigModal.tsx` / `PiSetupModal.tsx` | models.json 管理 / 首次配置引导 |
| `SystemPromptPanel.tsx` | 原生提示词分段、全文复制、SYSTEM/APPEND/上下文文件编辑；见 `docs/architecture-system-prompt.md` |
| `SettingsModal.tsx` | 设置面板（原生提示词/技能/扩展/MCP/更新；更新页不显示 pi-harness 本身；默认打开原生提示词，各页使用设置 v2 带用途说明的分组列表，MCP 常用控件自动保存；见 docs/ui-design.md） |
| `ModelThinking.tsx` | 模型 + 思考强度下拉（模型下拉顶部有搜索过滤框；输入工具栏思考档位为带说明的四档菜单：关闭／极简／标准／深度） |
| `GlobalSearchModal.tsx` | 全局搜索弹窗（Ctrl+K）：搜历史对话/最近项目/工作区文件名 |
| `CodeSearchModal.tsx` | 代码搜索弹窗（⌘P）：代码 / 文件名两种模式、按文件分组、右侧预览、Enter 打开到行；见 `docs/ui-design.md`「代码搜索」 |
| `PluginView.tsx` | 插件视图宿主：薄 React 壳 + 动态 import client bundle |
| `NativeMcpPanel.tsx` | 原生 MCP 与 Codemode 设置；修改作用域或信任时读 `docs/architecture-plugins.md` |
| `NodeWorkbench.tsx` / `node-terminal.tsx` | SSH 节点工作台：来源同步、详情/凭据、节点 Agent Chat 与手动终端；修改时阅读 `docs/architecture-nodes.md` |
| `CollapsedMessage.tsx` / `LazyMount.tsx` | 消息折叠摘要行 / 消息级惰性挂载包装 |
| `SearchBar.tsx` | 会话内搜索栏（Ctrl+F，CSS Custom Highlight API 高亮） |
| `Markdown.tsx` / `Dropdown.tsx` / `copy-button.tsx` / `SoundSettings.tsx` | 通用件 |
| `PlaygroundRun.tsx` / `PlaygroundScratch.tsx` | Python 代码块运行控件与结果区、左栏极简草稿页；Run 状态在 `playground-run-store.ts`（组件重挂载不丢）；详见 `docs/architecture-playground.md` |
