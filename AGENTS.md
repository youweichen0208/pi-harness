# AGENTS.md — pi-harness 项目指南

> 给 AI 编码助手的项目说明；细节按主题放在 `docs/`。修改本文件后在 pi 中运行 `/reload` 生效。

## 1. 项目

pi-harness 是 pi 编码智能体（`@earendil-works/pi-coding-agent` SDK，进程内运行，读 `~/.pi/agent`）的 Web / Electron 界面：对话、文件树与预览、附件、内置终端、Git、Wiki、数据库、SSH 节点和模型管理。后端 Node + Express + `ws`，前端 React 18 + Vite。

-   仓库 `git@github.com:youweichen0208/pi-harness.git`；npm 包 `@youweichen/pi-harness`（账号 `youweichen`）。
-   Node **>= 22.19.0**（SDK dist 使用 `import … with { type: "json" }`）。版本号在 `package.json` 与 `package-lock.json` 同步维护。
-   **代码地图**：查找文件、组件或模块职责时读 `docs/code-map.md`。

## 2. 原生代理边界

pi SDK 和 pi-ai 精确锁定 1.2.0，使用原版 SDK，不应用本项目的 SDK 补丁。会话加载 pi 原生配置、上下文文件、技能、扩展与官方 Codemode/tool_search/MCP；Codemode 与工具搜索使用原生 defaultTools 默认开启，已有原生配置优先。WebUI 不覆盖 bash，不自动续跑或发起额外模型调用；仅两个例外，界面均显示为自动提醒事件、每条用户请求最多 1 次：回复以“写成文本、未执行的工具调用”结尾时，请模型重新调用（见 `docs/architecture-core.md`「未执行的工具调用」）；本轮工具已全部完成但计划仍为 active 时，原生 plan 扩展在 settle 前提醒模型补一次终态调用。原生 plan 扩展默认开启（保留已保存的关闭选择），启用时由扩展提供工具规则与条件性历史背景。设置中的提示词支持原生文件编辑与空闲时 reload，技能支持原生发现、筛选和启停；Extensions 管理原生包声明及资源过滤规则，变更通过新会话或用户重载生效。界面偏好不改变模型上下文。SSH 工作台连接后自动准备本机隔离 pi 会话，复用本机模型、仅启用 SSH 节点工具；节点会话不加载本机上下文、扩展、技能或 MCP。

SDK 生命周期：以 `agent_settled` 判定整个任务结束，`agent_end` 只表示一次循环结束。

## 3. 修改前读取

| 修改内容 | 先读 |
| --- | --- |
| 任何界面 | `docs/ui-design.md`（以其为准；主界面沿用 v1.3.1 暖白／蓝色、IBM Plex Sans、贴边三栏；数据库、文档弹窗及内置扩展管理保留最新交互；颜色和圆角只用 CSS 变量，例外见该文档） |
| 快照与协议、安全边界、多对话并发、项目分组切换与缓存、队列／纠正、压缩／重试状态、运行静默状态、工具状态与完整输出下载、后台任务、扩展 UI 桥与对话隔离 | `docs/architecture-core.md` |
| 系统提示词分段来源、原生文件编辑或重载 | `docs/architecture-system-prompt.md` |
| 内置扩展清单／状态、包安装、启停、更新、作用域迁移、目录浏览、单文件编辑、技能 | `docs/architecture-extensions.md` |
| Codemode 卡片与 MCP/Codemode 设置（15a/15b）、状态、项目覆盖、费用、输出限制、插件 | `docs/architecture-plugins.md` |
| plan 工具、全局开关、压缩恢复、计划投影、任务进度、清单卡合并／替换／步骤跳转 | `docs/architecture-plan.md`（清单卡另读 `web/src/plan-presentation.ts`） |
| 附件、附件卡片、原生条目冻结恢复、模板附件、右栏编辑、保存冲突、草稿离开保护 | `docs/architecture-attachments.md` |
| 终端、SCM | `docs/architecture-terminal.md` |
| 对话改动面板（35a）范围、定位、折叠、搜索、轮次统计 | `docs/chat-diff-design.md` 与 `docs/architecture-terminal.md` |
| 命令卡合并／折叠／跳转；编辑与写入卡片 | `web/src/bash-groups.ts` 与 `docs/ui-design.md` 27a；`web/src/edit-write-presentation.ts` |
| Wiki 弹窗焦点／尺寸、聊天停靠与发送前保存、选区「问 pi」、保存与关闭保护、正文读取、索引／双链／搜索、改动记录、桌面默认应用打开 | `docs/architecture-wiki.md`（34a 工具栏 `WikiToolbar.tsx`；正文排版 `docs/wiki-doc-v2-design.md`；弹窗外壳 `docs/ui-design.md` 第 7 节） |
| 会话树过滤／搜索、分支切换／摘要／label、编辑重问、派生会话、外部修改检测、返回文本的草稿保护 | `docs/architecture-session-tree.md` |
| SSH 节点：Xshell/SSH config 同步、凭据、执行确认、终端引用、节点 Agent 启动／消息流／工具／断开清理 | `docs/architecture-nodes.md` |
| 数据库连接导入／同步、MySQL/PostgreSQL 查询、只读校验、Agent 授权 | `docs/architecture-database.md` |
| 跨仓来源、OpenViking 接入、本地评测（先验证检索收益，再增加产品界面） | `docs/engineering-context.md` |
| 桌面扩展子进程、打包、窗口顶栏、preload 接口、窄窗口布局、部署 | `docs/deployment.md` |
| 发布（npm、桌面版） | `docs/release.md` |
| 环境变量 | `docs/env-vars.md` |
| 开发流程、CI、编码约定、测试规范 | `docs/development.md` |

## 4. 开发

```bash
npm run dev          # node --watch 后端(:8788) + vite 前端(:5173)
npm run typecheck    # 双端 tsc --noEmit（提交前必跑）
npm run build        # vite + tsc
npm test             # 设计令牌检查 + vitest 单测
npm run test:smoke   # 零 token 协议冒烟
```

-   依赖安装前先运行 `npm run check:lockfile`。
-   **约定**：缩进用 Tab；i18n 走 `useT()`，zh/en 同时加；样式全部在 `web/src/styles.css`；新增协议消息只改 `server/protocol.ts`（`web/src/types.ts` 是 `export type *` shim），再在两端 switch 加分支。
-   **测试**：端口 ≥8900；data-dir 用 `mkdtempSync` 隔离；只清理自己启动的进程，禁止 `pkill -f` 杀全局。
-   **提交与发布**：提交信息不带 `Co-authored-by`；npm 版本号必须高于 registry；升级后手动 `pi-harness server restart`；发布前检查示例文件不泄密。

## 5. 常见坑

-   **改了 `protocol.ts` 后忘了在两端 switch 加分支** → 前端静默丢弃未知消息，表现为"没反应"。先跑 `npm run typecheck`。
-   **快照 60ms 节流**：调试时 `get_state` 可立即推一次（`cs.flushSnapshot()`）。
-   **snapshot 发送背压**：`send()` 在序列化前检查 `ws.bufferedAmount`，超阈值丢弃 snapshot（全量幂等），并安排 250ms 重试。
-   **`hello` 前／会话未就绪时的命令**：`server/index.ts` 的 `pending` 队列缓存，attach 后重放。
-   **clientId 每标签页独立**（issue #10）：`getClientId()` 存 sessionStorage，同源多标签页是多个客户端。回归：`multi-tab-test.mjs`。
-   **socket 半开**：服务端 10s 心跳，客户端 30s 无消息主动重连（退避 1s→10s）。
-   **项目顺序**：左侧项目按 `lastUsed` 与最近对话活动排序；`firstAdded` 仅作同时间的补充排序。
-   **断线时停止**：浏览器保留停止意图，重连拿到完整快照后仅在同一对话仍运行时补发；离线期间不显示模型计时。Electron 服务子进程意外退出后在原端口最多重启 3 次。
-   **预览与附件行号**：`countLines` 不算尾随换行；前端 `split("\n")` 后也要 pop 掉末尾空串。
-   **Windows 老中文文件乱码**：预览／内联附件／行附件统一走 `decodeText`（UTF-8 → GBK → latin1）。
-   **Electron `fork()` 必须显式带 `ipc`**：自定义 `stdio` 不含 `'ipc'` 会抛 `ERR_CHILD_PROCESS_IPC_REQUIRED`（`electron/main.mjs` 用 `["ignore", "pipe", "pipe", "ipc"]`）。
-   **Electron 沙箱 preload 用 CommonJS**：保持 `preload.cjs` 与 `require("electron")`，ESM `import` 在默认沙箱不执行，桌面标记与窗口控制接口都不会注入。
-   **node-pty 没有 linux 预编译包**（只有 darwin/win32 的 arm64/x64）：纯 Linux 环境跑 server 会在加载终端时崩，这是环境限制。

---
*结构／流程变更时同步更新本文件、`docs/code-map.md` 及相关 `docs/` 文档。*
