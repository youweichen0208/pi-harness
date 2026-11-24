# AGENTS.md — pi-harness 项目指南

> 本文件是给 AI 编码助手（pi / Claude Code / Cursor 等）看的高层项目说明书。 详细文档按主题分拆在 `docs/` 目录下。 修改本文件后，在 pi 中运行 `/reload` 生效。

## 1. 项目是什么

pi-harness 是 pi 编码智能体（`@earendil-works/pi-coding-agent` SDK）的 Web 聊天界面：
浏览器里对话、查看文件树、附加文件、内置终端（xterm.js + node-pty）、模型管理、
声音提醒、中英文切换。一条命令可跑（`pi-harness`），可 Docker / systemd / launchd /
Windows 计划任务部署。

-   仓库（公开）：`git@github.com:youweichen0208/pi-harness.git`
-   npm 包：`@youweichen/pi-harness`（发布者 npm 账号 `youweichen`；当前项目独立维护）
-   Node 要求：**\>= 22.19.0**（pi SDK 的 dist 使用了 `import … with { type: "json" }` 语法）
-   版本：`package.json` 与 `package-lock.json` 两处同步维护。

## 2. 技术栈

| 层 | 技术 |
| --- | --- |
| 后端 | Node + Express（静态 + `/api/health`）+ `ws`（`/ws` WebSocket 协议） |
| 前端 | React 18 + Vite 6 + react-markdown + highlight.js + xterm.js |
| 智能体 | `@earendil-works/pi-coding-agent` SDK（进程内，读 `~/.pi/agent` 配置） |
| 终端 | node-pty（服务端 PTY）+ `@xterm/xterm`（浏览器渲染，经 terminal bridge 转发） |
| 样式 | 单文件 `web/src/styles.css`（浅色/深色/跟随系统，CSS 变量） |

SDK 与 pi-ai 精确锁定 1.6.0，不应用本项目的 SDK 补丁。升级契约与版本差异见 `docs/pi-1.6-upgrade.md`。Codemode 与工具搜索使用原生 defaultTools 默认开启，已有原生配置优先。
系统提示词：修改分段来源、原生文件编辑或重载时，读取 `docs/architecture-system-prompt.md`。
Extensions：修改内置扩展清单/状态、包安装、启停、更新、作用域迁移、目录浏览或单文件编辑时，读取 `docs/architecture-extensions.md`。
Codemode 卡片与 MCP/Codemode 设置遵循 15a/15b 设计；状态、项目覆盖、费用及输出限制读取 `docs/architecture-plugins.md`。
Playground：修改 Python 代码块运行入口、草稿页运行／用例保存、执行限制、Python 探测、编辑工具安装或总开关时，读取 `docs/architecture-playground.md`；首次检测到可用 Python 默认开启，保留已保存开关、明确非沙箱、结果不进模型上下文。草稿一次运行同时跑脚本与用例（服务端传 tests 时只跑用例，因此是串行的两次请求），用例面板是一行一条的表格，参数在该行下方展开。
工程上下文：修改跨仓来源、OpenViking 接入或本地评测时，读取 `docs/engineering-context.md`；先验证检索收益，再增加产品界面。

发送回执：普通聊天与 Wiki 共用持久化请求去重和重连查询；修改发送确认或重试前读 `docs/architecture-core.md`「发送回执」。Wiki 切换与发送准入共用 `wiki-coordinator.ts`，修改时读 `docs/architecture-wiki.md`。

SDK 生命周期：以 `agent_settled` 判定整个任务结束，`agent_end` 只表示一次循环结束。修改队列、纠正、压缩/重试状态、扩展 UI 对话隔离或工具完整输出下载前读 `docs/architecture-core.md`；修改桌面扩展子进程或打包前读 `docs/deployment.md`。

## 3. 目录结构

详细逐文件目录树和组件职责见 `docs/project-map.md`；它是源码导航，不替代实际代码与架构契约。

- `server/`：Node ESM 后端，编译到 `dist/server/`；`protocol.ts` 是 wire 协议唯一事实源，`agent-service.ts` 管理会话，`index.ts` 负责入口与消息分发。
- `web/src/`：React 前端；`use-chat.ts` 管理 WS 与 reducer，`types.ts` 是协议 re-export shim，`i18n.tsx` 管理中英文案，全部样式位于 `styles.css`，组件位于 `components/`。
- `tests/`：`unit/` 为 vitest 单测，`*-test.mjs` 为 Playwright E2E / WS 协议测试，`run-smoke.mjs` 聚合零 token 冒烟；测试使用独立端口和 data-dir。
- `bin/`、`extensions/`、`electron/`、`build/`、`deploy/`：分别承载 CLI、npm CLI 扩展、桌面壳与打包资源、部署示例；`scripts/` 和 `.github/workflows/` 承载检查与 CI。
- `docs/`：架构、UI、开发、发布、部署与环境变量的详细契约；`dev/` 为本地开发辅助。

组件专项阅读规则：修改命令合并／折叠／跳转前读 `web/src/bash-groups.ts` 和 `docs/ui-design.md` 的 27a 规则；修改改动面板范围、定位、折叠、搜索或轮次统计前读 `docs/chat-diff-design.md` 与 `docs/architecture-terminal.md`；修改 MCP 作用域或信任前读 `docs/architecture-plugins.md`；修改代码搜索交互前读 `docs/ui-design.md`「代码搜索」。其余主题及组件的必读规则在本文对应章节继续生效。

## 原生代理边界

会话由原版 SDK 创建，加载 pi 原生配置、上下文文件、技能、扩展与官方 Codemode/tool_search/MCP。普通会话默认通过可关闭的「后台命令」扩展包装原生 bash；自动动作由原生会话 API 执行并显示事件：正常正文或只有思考的输出截断最多续接 2 次，重复正文／思考隔离后最多恢复 1 次，未执行工具文本最多提醒 1 次，共享每条真实用户请求 3 次宿主自动动作上限；无效推断额度回退也计入该上限。普通用户不手动设置 maxTokens，缺失声明仅在运行时使用 8192 推断值，实际请求按最终物理模型与 Context 通过 SDK 原生裁剪计算。用户停止取消续接，原任务与已执行工具不重放。修改检测、停止、续接、队列或历史隔离前读取 `docs/architecture-core.md`「重复输出保护与有界续接」及「未执行的工具调用」。内置 plan 扩展、开关和自动收尾提醒已移除，不应重新注册。设置中的提示词支持原生文件编辑与空闲时 reload，技能支持原生发现、筛选和启停（见 docs/architecture-extensions.md）；Extensions 管理原生包声明及资源过滤规则，变更通过新会话或用户重载生效。界面偏好不改变模型上下文。网页操作统一使用桌面内置浏览器，由当前普通对话授权；桌面控制按普通会话独立授权，Wiki 不注入。SSH 工作台连接后自动准备本机隔离 pi 会话，复用本机模型、仅启用 SSH 节点工具；节点会话不加载本机上下文、扩展、技能或 MCP。修改启动、消息流、工具或断开清理时读取 `docs/architecture-nodes.md`。

## 4. 核心架构（摘要）

> 详细文档见 `docs/architecture-*.md`

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
| **SCM** | `docs/architecture-terminal.md` | 只读 git 查询走 spawn；同 cwd 状态合并与进程树超时；未跟踪文件限量预览；git-dir watcher；写操作走可见终端 tab |
| **插件** | `docs/architecture-plugins.md` | <dataDir>/plugins/<id>/ 目录（manifest.json + index.mjs + client/entry.mjs）；attach 时热重扫；MCP 工具桥 |
| **SSH 节点** | `docs/architecture-nodes.md` | 修改 Xshell 7 全量同步、保存密码/主密码复用、本机认证覆盖、SSH config、执行确认或终端引用时阅读；本机隔离 Agent 与 ssh2 节点工具 |
| **工具结束实时状态** | `docs/architecture-core.md` | tool_status 先于快照落盘，浏览器卡片立即从「执行中」→「已结束」 |
| **Agent Execution Trace** | `docs/architecture-core.md` | 默认开启 metadata-only 有界采集与本地 JSONL；`/trace` 可视化，`/trace-export` 导出；截断/归属失败必须降级为 unmeasured/ambiguous，不能写 0 |
| **原生会话导出** | `docs/architecture-core.md` | `/export` 导出完整会话树 HTML，`/export jsonl` 导出当前分支；Web 只接受格式参数，受控临时文件、归属/规模预检、单次 token 与流式清理 |
| **运行静默状态** | `docs/architecture-core.md` | 改模型无响应或长时间工具运行提示时，使用 conversationId 绑定的 agent_silence；恢复响应即清除，重试只适用于本轮未调用工具的纯文本请求 |
| **当前任务进度** | `docs/architecture-core.md`、`docs/ui-design.md` | 从本轮工具调用推导执行阶段；内置 plan 已移除，不注入计划工具或提醒 |
| **扩展 UI 桥** | `docs/architecture-core.md` | setWidget/setStatus/notify/select/confirm/input → 浏览器消息；dialog_response 回传 |
| **Playground（Python 运行）** | `docs/architecture-playground.md` | 修改代码块运行入口、限制或开关时阅读：宿主自备 Python 3.9+、裸子进程（非沙箱）、首次检测到可用 Python 默认开启，保留已保存开关、HTTP+SSE、结果不持久化、不进模型上下文 |

Wiki：左栏「知识库」配置一个本地文件夹，在**独立窗口**打开 Wiki mode（Web 弹窗 / 桌面第二 BrowserWindow，URL 契约 `?wiki-window=1&cwd=&doc=&client=&model=&thinking=`（后两项可选），见 ADR-0003），主窗口留在 normal 对话并行工作；新窗口先通过现有 `set_model`／`set_thinking` 继承打开方的模型与思考档位，再创建会话；Wiki 对话按工作区保存在独立目录，每篇 Markdown 恢复自己的 chat，切换文档清空所选 Workspace 项目／知识库，支持新建与历史恢复／重命名／删除；媒体／代码等非文档文件只切换只读预览、沿用当前会话（不绑定、不清项目、不需中断确认）；退出即关窗，运行实例可清理、历史保留，运行中切换先确认中断。修改视图布局、左侧目录栏「打开文件夹」跨目录切换、Wiki 历史与运行实例生命周期、中断确认、刷新恢复、发送前保存、选区「问 pi」回填、保存与关闭保护、正文读取、索引／双链／搜索、改动记录或桌面默认应用打开时，读取 `docs/architecture-wiki.md`。专用窗口壳为 `WikiWindowShell.tsx`：不再渲染主 TopBar／FooterBar，文档标题栏与面包屑是桌面连续拖动区（控件 `no-drag`），右栏默认显示正文目录，「问 pi」默认浮动（Desktop 为独立窗口）、可固定替换目录，在当前文档基础上可追加一个 Workspace 项目／知识库进行分析，最近改动为覆盖抽屉；34a 工具栏为 `WikiToolbar.tsx`，正文排版见 `docs/wiki-doc-v2-design.md`。入口为 `App.tsx`（wiki view）+ `WikiWindowShell.tsx`、`WikiAssistantWindow.tsx`、`WikiProjectPicker.tsx`、`WikiWorkbench.tsx`、`wiki-window.ts`、`wiki-routes.ts`、`wiki-chat-store.ts` 与 `wiki-service.ts`；`WikiDocumentModal.tsx` 用于普通 Markdown 单文件弹窗；普通文件入口使用主聊天，当前文件自动引用随弹窗关闭清除。知识库打开与恢复由 `wiki-window-session.ts` 管理，`use-wiki-window-session.ts` 连接窗口与传输；修改知识库配置与恢复时读取 `docs/architecture-wiki.md`，修改单文件自动保存与聊天归属时读取 `docs/architecture-attachments.md`。

会话树：修改树过滤/搜索、分支切换/摘要/label、编辑重问、派生会话、外部修改检测或返回文本的草稿保护时，读取 `docs/architecture-session-tree.md`。树状态由原生 SDK 管理，协议 v40，默认编辑重问留在同一会话文件。修改附件卡片、原生条目冻结恢复或模板附件时，读取 `docs/architecture-attachments.md`。

## 5. 开发工作流

> 详细文档见 `docs/development.md`

```bash
npm run dev          # 并行：node --watch 后端(:8788) + vite 前端(:5173)
npm run typecheck    # 双端 tsc --noEmit（提交前必跑）
npm run build        # build:web (vite) + build:server (tsc)
npm start            # 跑编译产物 dist/server/index.js（生产）
npm test             # 设计令牌检查 + vitest 纯函数单测
npm run test:smoke   # 零 token 协议冒烟聚合跑器
```

依赖安装前先运行 `npm run check:lockfile`，确保下载地址全部使用 HTTPS npm 官方源且与声明版本一致；安装验证流程见 `docs/development.md`。

**界面规则**：修改界面前读取 `docs/ui-design.md`，以其为准；最新视觉按 2026-10-19 语雀桌面参考使用简白正文、浅灰导航、系统无衬线字体和贴边三栏布局，主要操作绿色、链接蓝色；保留石墨深色与其他底色选择。文档弹窗及内置扩展管理保留最新交互；颜色和圆角只能用 CSS 变量，例外见该文档。

**关键约定**：缩进用 Tab；i18n 走 `useT()`（zh/en 同时加）；样式全部在 `styles.css`；新增协议消息只改 `protocol.ts` 再两端 switch 加分支。

**测试规范**：端口隔离（≥8900）；data-dir 隔离（`mkdtempSync`）；精确清理自己进程；不允许 `pkill -f` 杀全局。

## 6. 发布流程

> 详细文档见 `docs/release.md`

```bash
# 升版本 → 自检构建 → git commit → git push → npm publish
npm run typecheck && npm run build
git add -A && git commit -m "feat(xxx): 描述"
git push origin develop
npm publish --access public
```

注意事项：版本号必须高于 npm registry；提交信息不要带 `Co-authored-by`；升级后需手动重启服务 `pi-harness server restart`；发布前检查示例文件不泄密。

桌面版发布是独立的一条线（跟 npm 发布不绑在一起）：打一个 `v*` tag push 上去，`.github/workflows/release-desktop.yml` 先创建草稿，在 mac/win/linux 真机 runner 上构建、执行打包产物回归，再上传附件；三个平台全部成功且附件齐全后才公开。使用 GitHub 自带的 `GITHUB_TOKEN`，带 `-` 的 beta tag 标记 prerelease。mac 只有 ad-hoc 签名、未公证：macOS 14 及更早右键「打开」，macOS 15 及以后需在「系统设置 → 隐私与安全性」点「仍要打开」；Windows 未签名，SmartScreen 点「更多信息 → 仍要运行」。正式签名需要修改 `electron-builder.yml`，仅加 Secrets 不会生效。手动单平台重建只更新附件，不单独公开草稿。
Windows job 的终端冒烟测试必须通过才能上传安装包；`AttachConsole failed` 清理竞态由 `server/patch-node-pty.ts` 处理，不能以 `continue-on-error` 跳过终端读写失败。

## 7. 环境变量

> 完整列表见 `docs/env-vars.md`

| 变量 | 默认 | 一句话作用 |
| --- | --- | --- |
| `PORT` | `8787` | HTTP 端口 |
| `PI_WEB_HOST` | `127.0.0.1` | 监听地址（默认只绑 loopback） |
| `PI_WEB_CWD` | `process.cwd()` | 智能体工作区 |
| `PI_WEB_DATA_DIR` | `~/.pi-web` | 数据目录（client-state / uploads / plugins） |
| `PI_WEB_TOKEN` | 空 | 可选共享口令鉴权 |

## 8. 部署

> 详细文档见 `docs/deployment.md`

- **CLI 前台**：`pi-harness --port 9000 --cwd /path`
- **开机自启**：`pi-harness server install`（macOS→launchd / Linux→systemd / Windows→计划任务）
- **Docker**：`docker compose up -d`
- **桌面版（Electron）**：`npm run build && npm run dev:electron` 本地跑；`npm run build:electron:mac/:win/:linux` 出安装包（`release/`，未发布，需真机构建）。改窗口顶栏、preload 接口或窄窗口布局时看 `docs/deployment.md` 的桌面窗口外壳说明。

## 9. 常见坑

- **改了 `protocol.ts` 后忘了在两端 dispatch/onmessage switch 加分支** → 前端收到未知消息类型被 switch 静默丢弃，表现为"没反应"。先跑 `npm run typecheck`。
- **快照 60ms 节流**：调试时 `get_state` 可立即推一次（`cs.flushSnapshot()`）。
- **snapshot 发送背压**：`send()` 在序列化之前检查 `ws.bufferedAmount`，超过阈值时丢弃 snapshot（全量幂等且稍后必有更新）；丢弃时安排 250ms 重试 timer。
- **`hello` 前/会话未就绪时的命令**：`server/index.ts` 的 `pending` 队列会缓存并在 attach 后重放。
- **clientId 每标签页独立**（issue #10）：前端 `getClientId()` 存 sessionStorage（非 localStorage），同源多标签页是多个独立客户端。回归：`multi-tab-test.mjs`。
- **socket 半开**：服务端 10s 心跳，客户端 30s 无消息主动断开重连（指数退避 1s→10s）。
- **项目顺序**：左侧项目按 `lastUsed` 与最近对话活动排序，再次打开会移到前面；`firstAdded` 仅作时间相同的排序补充。
- **断线时停止**：浏览器保留当前对话的停止意图，重连拿到完整快照后仅在同一对话仍运行时补发；离线期间不继续显示模型计时。Electron 服务子进程意外退出后在原端口最多重启 3 次。
- **预览与附件行号**：`countLines` 不算尾随换行；前端 `split("\n")` 后也要 pop 掉末尾空串。
- **问题卡片的选项分隔**：`❓ **Q…**` 卡片的行内选项优先按分号切分（`web/src/question-cards.ts` 的 `parseOptions`）。整段没有分号时，只在三条都成立才按空格回退切分：标记 ≥3 个、字母从 `a` 起逐个递增、且没有选项正文以 `(b)` 这类括号字母或 `+`／`和`／`或`／`and`／`or` 开头（那属于引用或叙述）。不满足时整段退化成问题说明，`➡️ 推荐 (b)。理由` 会成为唯一选项——表现为「卡片只显示一个选项」。首选写法 `(a) 甲;(b) 乙;(c) 丙`，也支持每行一项 `- A. 甲` 或 `A) 甲`。
- **Windows 老中文文件乱码**：预览/内联附件/行附件统一走 `decodeText`（严格 UTF-8 失败 → GBK → latin1）。
- **macOS 桌面版终端没有 `npm`/`node`**：从 Dock / Spotlight / launchd 启动**不经过登录 shell**，`~/.zprofile` 的 `brew shellenv` 不执行，继承到的 PATH 只有 `/usr/bin:/bin:/usr/sbin:/sbin`；同一用户在 Terminal.app 里却正常。服务启动时由 `ensureMacosShellPath()`（`server/shell-path.ts`）追加 `/opt/homebrew/{bin,sbin}`、`/usr/local/{bin,sbin}`，追加不前置、不重复、不存在的目录跳过。nvm / volta / asdf / fnm 不猜（路径随版本变化），由用户 `~/.zshenv` 导出。排查时先看服务进程的 PATH（`ps eww <pid>`），不要以为终端没继承环境。
- **Playwright 脚本**：headless shell 路径写死在本机，CI/换机需要改 `HEADLESS` 常量。

- **Electron `fork()` 必须显式带 `ipc`**：`child_process.fork()` 传自定义 `stdio` 数组时，不含 `'ipc'` 会直接抛 `ERR_CHILD_PROCESS_IPC_REQUIRED`（`electron/main.mjs` 里是 `stdio: ["ignore", "pipe", "pipe", "ipc"]`，别漏了最后一项）。
- **Electron 沙箱 preload 用 CommonJS**：`BrowserWindow` 默认沙箱不执行 preload 中的 ESM `import`；保持 `preload.cjs` 与 `require("electron")`，否则桌面标记与窗口控制接口均不会注入。
- **node-pty 没有 linux 预编译包**：`node_modules/node-pty/prebuilds/` 只有 darwin-arm64/x64 和 win32-arm64/x64，本项目目标平台是 mac/win 桌面机；在纯 Linux 环境（比如某些 CI/沙箱）直接跑 server 会在加载终端功能时崩，与 Electron 改动无关，是环境限制。

---
*结构/流程变更时同步更新本文件及相关 `docs/` 文档。修改后运行 `/reload` 生效。*

共用格式命令目录与选区执行顺序位于 `web/src/rich-commands.ts`，两种工具栏仅负责展示。小记：修改共用富文本格式、图片资源、链接卡片抓取、独立存储、HTTP 接口、自动保存、跨窗口冲突或导航时，读取 `docs/architecture-notes.md`。小记保存在服务数据目录，不自动进入模型上下文。

## Agent skills

### Issue tracker

Issue 与 spec 是仓库根目录 `.scratch/<feature>/` 下的 markdown 文件，本地维护、不入库（`.scratch/` 已 gitignore）。见 `docs/agents/issue-tracker.md`。

### Triage labels

五个 triage 角色沿用默认标签名：`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`。见 `docs/agents/triage-labels.md`。

### Domain docs

单上下文（single-context）：根 `GLOSSARY.md` + `docs/adr/`。见 `docs/agents/domain.md`。
