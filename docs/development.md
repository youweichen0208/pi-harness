# 开发工作流

## 常用命令

```bash
npm run dev          # 并行：node --watch --import tsx 后端(:8788，dev:server 脚本，cross-env 固定 PORT=8788，
#                     避开全局 pi-harness 的默认 :8787) + vite 前端(:5173，代理 /ws 到 :8788)。
#                     注意：不要用 `tsx watch` 起后端——它在 Windows 下、stdio 为管道（concurrently 的 spawn 方式）
#                     时会静默挂死（tsx 上游 bug），改用 Node 原生 --watch。
npm run typecheck    # 双端 tsc --noEmit（提交前必跑）
npm run check:lockfile  # 安装前校验 lockfile 下载地址为 HTTPS npm 官方源
npm run check:protocol  # 守护协议单源 shim 机制（CI 必跑）
npm run build        # build:web (vite) + build:server (tsc)
npm start            # 跑编译产物 dist/server/index.js（生产）
npm run check:design # 设计令牌检查（硬编码颜色与非令牌圆角报错）
npm test             # 设计令牌检查 + vitest 纯函数单测（tests/unit/，毫秒级零 token）
npm run test:smoke   # 零 token 协议冒烟聚合跑器（tests/run-smoke.mjs，自包含测试）
npm run test:freeze  # 冻结/重连回归测试（Playwright，需要本机 chromium headless）
```

## CI

`omp-request-diagnostics-test.mjs` 纳入 smoke：本地 Anthropic／OpenAI 请求、工具配对、受限助手、关闭及写入失败、九个应用 Task 子会话、真实原生 CLI RPC 工作线程与隐私边界。环境变量 `HARNESS_TEST_OMP_CLI_MODE=print` 或 `print-control` 是单独的已知失败诊断，不作为默认通过项。原生请求及 MCP 连接诊断加入桌面三平台源码／打包门禁；门禁定义不等于平台已执行。

`node tests/omp-mcp-diagnostics-test.mjs` 已加入 smoke：真实原生连接失败／恢复、任意凭据回显隔离、慢启动、只读轮询、跨对话隔离与 Stop／重开；Bun 夹具补充缓冲上限、启动事件竞态及监听释放。现有 MCP 浏览器门禁同时检查中英文窄屏诊断与恢复后历史保留。

组件更新和扩展旧冒烟入口已保留并迁移：`node tests/component-updates-test.mjs --browser` 使用真实原生包升级／回滚；`node tests/extensions-test.mjs --browser` 验证实际宿主源码编辑、设置外壳和草稿。两种浏览器模式加入 Mac/Windows CI，扩展 HTTP 还可用 `--electron-node` 检查 Electron Node 宿主。`extensions-update-browser-test.mjs` 复用真实原生更新场景，不再注入 Pi 批量更新结果。SDK 更新仍随应用发布，包更新不更改内置引擎。

`node tests/model-sources-protocol-test.mjs --browser` 验证主聊天／Wiki 的 OMP 共享配置、运行中工具回合的凭据隔离、下一轮生效、重启历史和模型表单的明确／清空输出额度。旧跨客户端来源同步及统一额度已退休，保留同名冒烟入口。浏览器模式加入 Mac/Windows CI；本机通过不代表 Windows 已验收。

`node tests/codemode-mcp-test.mjs --browser` 验证 OMP 默认 MCP 虚拟路径调用、实际模型工具结果及图片保存／附加，并覆盖同目录跨对话拒绝与停止后的图片保存。该模式加入 Mac/Windows CI；未运行对应平台前不宣称跨平台验收通过。

`node tests/omp-mcp-auth-reconnect-test.mjs` 已纳入 smoke：12 个真实原生 OAuth 场景覆盖修改、删除、停用、范围覆盖、项目开关、全局规则和扩展来源，未修改／仅修改其他服务时仍正常登录。`node tests/diagnostics/omp-mcp-auth-conflict-probe.mjs same-server` 仍按期望行为断言失败，记录原生 OAuth 写回覆盖问题，不能纳入通过率分母后把失败忽略。

`node tests/omp-mcp-browser-test.mjs` 验证配置导入（原子冲突、变量转换、项目范围、实际原生环境展开、不自动连接）、逐服务 stdio/HTTP/SSE 配置、凭据掩码与未知字段、全局启停／项目覆盖、实际重载、版本冲突、草稿／焦点保护、中英文窄屏及原生 OAuth。与 `omp-mcp-test`、`omp-mcp-auth-test` 配套运行；服务名称含 env/secret 时只能公开已知非敏感元数据，未知枚举及连接／凭据继续隐藏。源码浏览器入口加入 Mac/Windows CI，桌面发布沿用打包执行入口；门禁定义不等于平台已经通过。

`tool-text-continue-test.mjs` 和 `system-prompt-test.mjs` 保留冒烟入口，已迁移至 OMP：前者验证两种协议的正文不执行／不自动重发和真实工具正向路径，后者验证实际 HTTP 的提示词保存、显式重载、出站内容、历史、扩展覆盖及归属校验。提示词浏览器回归用 `node tests/system-prompt-test.mjs --browser` 或已有 `omp-prompt-browser-test.mjs`；本地通过不代表 Windows 原任务验收完成。

模型 HTML 表单的原生 RPC 回退用 `node tests/omp-ask-tool-test.mjs --browser` 验证，基础模式纳入 smoke，浏览器模式加入 Mac/Windows CI。真实本地 Anthropic 流触发 SDK 的 `ask` 工具，覆盖单选／多选、Other、Done、字段校验、工具结果、取消、Wiki Stop 和原生超时；不使用伪造 dialog 代替模型工具。worker 必须在创建会话前调用公开的 `ensureTheme()`，否则原生多选创建 Done 行时会失败。

数据库宿主工具用 `node tests/omp-database-test.mjs` 验证真实 OMP 工具声明与结果回传、客户端／对话／工作区授权隔离、已加载会话的开关与损坏配置拒绝、连接版本失效和凭据投影。TCP 监听器断言未授权查询及写入 SQL 在建立连接前被拒绝；该专项不替代真实数据库查询回归。真实 PG/MySQL 用 `node tests/database-integration-test.mjs --browser`，要求本地 Docker 和缓存镜像、仅创建并清理独有临时容器，见 `docs/architecture-database.md`；本地 OMP 验证记录在 `docs/review-data/omp-database-live.json`。数据库开关设置界面另由 `builtin-extensions-test.mjs --browser` 覆盖。扩展委派通知用 `node tests/delegate-notification-test.mjs --browser` 验证，其失败／完成识别另有投影单测。

扩展多问题请求在 `omp-extension-ui-test.mjs --browser` 中使用真实 SDK 验证，包含普通／Wiki、单选互斥、多选加自由文本、原生超时、重连、刷新、Escape 和 Stop。该模式沿用现有 Mac/Windows CI 门禁；本地验证不代表 Windows 已通过。单测拒绝乱序、未知或重复选项及单选混合答案。与模型 HTML 表单路径的区别见 [多问题专项记录](review-data/omp-ask-dialog.json)。

项目切换事件用 `node tests/conv-cwd-test.mjs --browser` 验证真实空会话时间线、项目隔离及刷新，浏览器模式加入 Mac/Windows CI。`omp-workspaces-test` 同时检查原生上下文不变、停止重开／客户端恢复及 `/new` 清空。公共搜索、代码搜索、聊天问答卡片和文件预览回归使用隔离 OMP 配置与绑定端口；不在测试内重建 dist。见 [宿主专项记录](review-data/omp-workspace-events.json)。

Wiki 的 OMP 启动／跨目录／历史移交回归为 `node tests/omp-wiki-bootstrap-test.mjs --browser`，基础协议模式纳入 smoke，浏览器模式纳入 Mac/Windows CI。`wiki-bootstrap-model-test`、`wiki-modal-browser-test`、`wiki-thinking-level-test` 及公式／格式／插入编辑器回归已改用隔离 OMP 配置和动态绑定端口。模型继承的首次启动用未绑定文档构造夹具，避免把原生空历史恢复误当作首次创建；不移除初始实例复用、保存／撤销或窗口隔离断言。最新本地结果与全量基线区别见 [Wiki 专项记录](review-data/omp-wiki-bootstrap.json)。

OMP 迁移的实现边界和剩余验收见 [OMP 接入契约](architecture-omp.md)。`npm run check:engine` 从 `tsconfig.production.json` 的入口和独立 worker 遍历源码（含类型依赖）；同时拒绝生产／开发依赖及服务端、前端、测试、脚本中的旧 SDK 导入。`build:server` 清空生成目录后只编译入口依赖，再检查缺失及意外输出。新增独立 worker 须加入根文件清单。旧 Pi SDK 已卸载，退休文件、替代回归和待验证能力见 [退休清单](omp-retirement.json)。

公共宿主完整冒烟已在本地 macOS 通过 114/114（[验证记录](review-data/omp-smoke-proxy.json)）；之后代理认证头隔离补修通过最终 3/3 专项、构建、类型、单测与浏览器检查，未重复整套 114 项（[最终记录](review-data/omp-proxy-fix.json)）；这不替代剩余迁移缺口与 Windows／安装包验收。项目新建与 4096 条历史展示已改用 Bun 中的真实 OMP SessionManager 夹具；快速切换、历史恢复、草稿与滚动位置、终端保留及重连已通过真实 OMP 浏览器回归；其余尚未通过的检查保留，不通过删断言或跳过来视为完成。旧 Pi 性能报告仅代表历史版本，不能作为 OMP 性能验收。构建与读取 `dist/` 的测试必须串行，**包括 `npm test`**：其中的真实 JDBC 单测读取生成的桥接产物，构建清理目录期间会报 `JDBC_BRIDGE_MISSING`，不能与构建并行启动。

`prompt-receipts-test.mjs` 已迁移为 OMP 原生扩展，基础模式验证重启去重和两类崩溃窗口，`--browser` 验证断线／刷新只查询及草稿保留。原生扩展命令的 accepted 代表已路由，不能用它证明命令完成；未获得原生确认的输入钩子在崩溃后必须保持 unknown。`wiki-protocol-test.mjs`、`wiki-assistant-test.mjs` 和 `file-editor-protocol-test.mjs` 使用隔离 OMP 配置、绑定高端口和 ready 握手。`current-file-protocol-test.mjs --browser` 已通过原生技能、队列和模板附件回归；模板分隔符与无附件原生调用逐项对照，等待本次回复及最新空闲状态，避免把旧快照误作完成。`omp-template-attachments-test.mjs` 验证公开 RPC/prompt 边界、单次输入钩子、命令优先级、插队／follow-up、冻结重问和停止，原生插队的 CRLF 归一化与历史原文分别检查。

首次配置回归使用 `tests/omp-setup-browser-test.mjs`：真实 OMP、隔离数据和空 PATH，验证中英文首次配置、密钥保存及服务重启恢复，不需要外部 Pi/OMP CLI。旧 Pi CLI 探测和安装回归已退休。其余旧 Pi 专用冒烟仍在迁移；下方历史测试说明不代表它们已适配 OMP 或完整 CI 已通过。

跨仓代码与文档检索的本地评测见 [工程上下文：设计与验证](engineering-context.md)。开发工具位于 `dev/context-eval/`，确定性回归执行 `npm run test:context-eval`（也纳入零 token 冒烟）；真实模型和 OpenViking 对比在本机单独运行，开发夹具结果不作为检索收益结论。

GitHub Actions ubuntu-latest（`.github/workflows/ci.yml`，push/PR → main 或 develop 触发）：`check:lockfile → npm ci → check:protocol → typecheck → build → npm test（设计检查 + vitest）→ test:smoke`。

桌面字体另有 macOS/Windows Electron CI job：`windows-rendering-test.mjs` 在 Mac 100% 和 Windows 100%／125%／150% 缩放下生成浅深色截图与字体测量，`compare-rendering-metrics.mjs` 比较包内字体文件、字号、字重、颜色、换行及字宽（容差 1 CSS px）。这是开发构建回归，正式发布仍执行安装包回归；不声称系统栅格化或屏幕显示像素完全一致。

SSH 节点另有 macOS/Windows CI job：两平台分别构建服务端并运行 `node-workbench-test.mjs` 的 mock SSH 测试。浏览器工作台交互可在 macOS 本地运行 `node tests/node-workbench-browser-test.mjs`（先 `npm run build`）。

冒烟清单（tests/run-smoke.mjs 的 ALL）只收**自包含、零 token、跨平台**的测试；attach 型（需外部 server）、需真模型、平台相关的脚本不进 CI，本地手动跑（分类见 run-smoke.mjs 头部注释）。

## OMP 部署回归

`tests/omp-service-config-test.mjs` 执行 CLI `server install --print`，验证应用 data-dir、参数优先级及移除旧 Pi 环境覆盖。三平台分支在生成层测试，禁止执行外部命令和写配置，不代表已在 Windows 安装服务。

`tests/omp-container-test.mjs <本地镜像>` 验证真实 Linux 镜像及两个容器之间的数据卷恢复，使用隔离的本地模型／包 registry，不使用真实账号。需要本机 Docker，故不加入默认 smoke；独立 CI 容器 job 先构建镜像再执行。详情见 [容器部署](deployment.md#docker)。

## 编码约定

- **缩进用 Tab**；前端组件小写文件名（`copy-button.tsx` 例外）；代码注释中英混写，UI 文案默认中文。
- **i18n**：所有用户可见字符串走 `useT()`；改 `i18n.tsx` 必须同时加 `zh` 和 `en` 两个 key（`en` 的类型是 `Record<keyof typeof zh, string>`，漏一个会编译报错，这是特性不是 bug）。
- **通知文案**：服务端 notice 直接写中文，不需要 i18n。
- **样式**：全部在 `styles.css`，按 `/* ---- 组件名 ---- */` 分区；颜色用 CSS 变量（`--bg-elev*`、`--border*`、`--text*`、`--accent*`、`--yellow-fg`、`--green`、`--red`）。
- 文件列表 `IGNORED_ENTRIES`（node_modules/.git/dist 等）在 `files-service.ts` 顶部维护（分平台两套）。
- 新增协议消息 → 只改 server/protocol.ts（见 `docs/architecture-core.md`「协议单源」），再在两端 dispatch/onmessage switch 各加分支。

## 斜杠命令目录

服务端 `OmpClientSession.pushSlashCommands()` 读取 OMP 原生 `get_available_commands`，投影名称与说明。代理命令随用户输入交给 OMP；宿主不再使用已退休的 `NATIVE_COMMANDS`／`execNativeCommand`，也不复制 Pi 的私有模板展开器。资源变更通过原生 reload 生效。当前原生提示词、技能与扩展回归分别为 `omp-prompt-test.mjs`、`omp-skill-settings-test.mjs` 和 `omp-extension-settings-test.mjs`；模板／技能展开与冻结附件组合见 `omp-template-attachments-test.mjs`、`omp-skill-history-test.mjs` 及附件浏览器的 `--template`／`--skill` 模式。

## 验证清单

1. `npm run typecheck` 零错误
2. 涉及 UI → `npm run dev` 手动过一遍交互
3. 涉及 ws 协议 → `tests/` 下有现成脚本可参照：先跑 `npm run test:smoke`（自包含协议测试全量），单个用 `node tests/xxx-test.mjs`（需先 `npm run build`；浏览器 E2E 需要本机 Playwright 的 chrome-headless-shell，路径写在各脚本的 `HEADLESS` 常量里，换机时按需修改）

## 测试规范

### 全局 vs 本地

用户日常可能正用**全局安装**的 `pi-harness`（`~/.local/share/fnm/node-versions/…/lib/node_modules/pi-harness`，默认端口 `8787`）跑着对话/工作。开发改造对象永远是**本地仓库**（你的 pi-harness 检出目录）。用户会在自己测试时手动关闭全局 dev、切到本地。

**绝对不要杀全局进程/占 8787**：禁止 `pkill -f "dist/server/index.js"`——它会命中全局 server（端口 8787），把用户正在用的会话打断。清理只针对**自己启动的测试 server**。

### 隔离端口

每个 `*-test.mjs` 用独立端口（≥8900，避开 8787/5173/3300），并在启动 server 前先 `lsof -ti :PORT -sTCP:LISTEN` 确认空闲；若被占，改端口而非硬杀。

随机端口测试不能先开探测 socket 再释放后启动服务，这会产生占用竞态。`tests/lib/isolated-server.mjs` 提供直接绑定高端口的 `listenIsolated` 和 `startIsolatedHarness`：仅占用冲突换端口重试，启动必须核对自身绑定日志与健康响应 PID，失败/超时只清理本次子进程。子代理和内置扩展测试已使用该入口；`isolated-server-test.mjs` 确定性覆盖被占端口、非占用错误和超时清理。

### 精确清理自己起的进程

spawn 后记录 `server.pid`，测试收尾（含异常 catch 路径）用 `process.kill(pid, 'SIGTERM')` 只杀自己启动的。多开几个 server 时用各自 PID 逐个杀，别用宽泛模式匹配。

### data-dir 隔离

测试 server 设 `PI_WEB_DATA_DIR` 为 `mkdtempSync(tmpdir…)`，`PI_WEB_CWD` 指本地仓库——避免污染真实 user data / client-state / session。

### 宿主环境隔离

自起 server 的测试不得直接展开 `process.env`：从 pi-harness/Electron 宿主里跑测试时，宿主自己的 `PI_*` 会泄进被测 server——`PI_WEB_PKG_ROOT` 让它伺服宿主自己的 web/dist（浏览器测的就成了另一个应用），`PI_WEB_WORKSPACES_FILE` / `PI_SESSION_FILE` 指向真实工作区与会话。统一用 `tests/lib/test-env.mjs`：展开式写 `env: { ...testEnv(), PORT, … }`；「先改 `process.env.PI_*` 再让子进程继承」的旧式测试在文件头 `scrubHostEnv()` 一次（此后 `PI_*` 命名空间归测试所有，`testEnv()` 不再剥）。`scripts/check-test-env.mjs`（CI 独立一步）强制这三条。

### 自包含 vs 外部依赖

能进 `tests/run-smoke.mjs` 清单的测试必须**自起 server + 自清理**；不进清单的分两类（原因写在 run-smoke.mjs 头部注释）：
- ①attach 型需外部已运行 server——ws-session-test / file-upload-test / image-paste-test / commands-test(8791) / edit-reask-test / projects-test

### 验证项

每改完一版，`npm run check:protocol` + `npm test` → 本地 server（隔离端口+独立 data-dir）→ 对应 `tests/*-test.mjs` 或 `npm run test:smoke` → `npm run typecheck` → 涉及 UI 再用 `playwright` 浏览器测试（chromium 路径见各测试文件 HEADLESS 常量）。

### 测试家族速查

| 测试组 | 说明 |
| --- | --- |
| **settings 家族** | `settings-test.mjs`（端口 8931）：设置面板协议冒烟——settings_state 推送 / get_settings / set_settings / save_preset / apply_preset / delete_preset / 重连持久化 |
| **global-search 家族** | `global-search-test.mjs`（端口 8962）=search_files 协议冒烟；`global-search-ui-test.mjs`（端口 8963）=真 Chrome headless UI 测试 |
| **scm 家族** | `scm-features-test.mjs`=SCM v2 功能协议测试（懒加载 history / 远程分支 / git-dir watcher）；`scm-test.mjs`=SCM 面板 E2E（真 Chrome headless） |

**Playwright 脚本**：headless shell 路径写死在本机，CI/换机需要改 `HEADLESS` 常量。

**测试脚本里禁止在 try 块内直接 `process.exit`**：`process.exit` 会跳过 `finally`，spawn 的 server 永远不会被杀 → 每次运行泄漏一个进程，下次跑同端口测试报 "port busy — abort"（steer-queue-smoke 踩过，已修：设 ok 标志 + finally 里杀进程并等端口释放再 exit）。

## OMP 升级契约检查

OMP 和 Bun 版本以 `package.json` 精确锁定值为准。修改版本必须核对 `server/omp/bootstrap.ts` 的握手版本并完成源码及三平台打包产物回归。Node 宿主不加载原生 SDK；Bun worker 通过公开接口运行，不修改 node_modules。旧 Pi 版本文档和性能报告仅作为历史记录，不是当前升级门禁。

- 入口与调用：`omp-runtime-test.mjs`、`omp-entry-test.mjs`、`omp-model-config-test.mjs`、`omp-model-catalog-test.mjs`，覆盖真实 worker、工具调用、原生默认输出额度和显式覆盖。
- 项目导航：`omp-workspaces-test.mjs` 覆盖原生最近历史、已保存选择优先、串行合并、准备失败回退和失败历史隔离；`project-switch-test.mjs` 通过浏览器验证延迟确认、缓存内容、草稿、滚动、终端保留和重连。
- 历史与恢复：`omp-tree-test.mjs`、`omp-persistence-test.mjs`、`omp-persistence-restart-test.mjs`、`omp-external-history-test.mjs`、`omp-session-storage-test.mjs`、`omp-stop-metadata-test.mjs` 与 `omp-recovery-test.mjs`。浏览器恢复见 `omp-persistence-browser-test.mjs`。
- 附件：`omp-attachments-browser-test.mjs` 与 `tests/unit/user-attachments.test.ts` 使用真实附件构建和 OMP 投影。`omp-skill-history-test.mjs` 验证技能条目、完整冻结附件、重启与原生编辑草稿；浏览器加 `--skill` 验证技能卡片、编辑提交及刷新。模板组合见 `omp-template-attachments-test.mjs` 和浏览器 `--template`，保留输入钩子、原生展开顺序与停止；插队提供给模型的文本遵循原生 CRLF 归一化，历史保留原文。
- 资源：`omp-prompt-test.mjs`、技能／扩展、`omp-packages-test.mjs`、Marketplace、包功能与包设置，以及 `omp-mcp-test.mjs`／`omp-mcp-auth-test.mjs`。真实供应商 OAuth 账号仍须单独验收。
- 子任务：`omp-tasks-test.mjs` 使用 OMP 原生 Task。旧 Pi 只读 subagent 实现及专属测试已退休；内部历史保护存在已复现的缺口，见 [Task 存储诊断](omp-task-storage-gap.md)。子任务输出及压缩后目录仍待验收。
- 工具输出：`node tests/omp-tool-output-test.mjs --browser` 验证主会话原生日志、600 MiB 服务端传输、分支历史、停止后下载及真实卡片；再加 `--partial` 验证 OMP 保存额度截断提示。基础回归加入 smoke，浏览器两种模式加入 Mac/Windows CI；配置门禁不等于真机已通过。

旧源码与专属测试的逐项替代和缺口见 [退休清单](omp-retirement.json)。公共宿主完整 smoke 的本地 114/114 记录见 [验证结果](review-data/omp-smoke-proxy.json)，不能据此声称全面迁移完成。

### 数据库工作台回归

`npx vitest run tests/unit/database.test.ts` 无外部服务。真实驱动与浏览器回归由入口创建专用容器，不接受业务数据库连接；要求本地 Docker context 与已缓存的 `postgres:17-alpine`、`mysql:8.0` 镜像：

```bash
npm run build
node tests/database-integration-test.mjs --browser
```

若当前应用正在使用此检出的 dist，先在隔离检出中构建和运行。入口按缓存镜像 ID 启动两个独有临时容器，等待数据库就绪、自动传入 loopback 随机端口，随后执行 OMP/浏览器回归并按所属标签清理。不会自动拉取镜像、挂载用户数据、连接旧固定端口或删除其它容器。HTTP／模型端口同样动态绑定，应用 data-dir 隔离。没有本地 Docker 或缓存镜像时明确失败，不跳过。

`node tests/database-tls-test.mjs` 是独立的 PostgreSQL TLS 回归，使用自身临时容器和端口 9280，需另行运行；上述 OMP 实库测试不替代 TLS、MariaDB 或厂商 JDBC/GaussDB 验收。

3a/4a 回复回归：`node tests/chat-redesign-ui-test.mjs` 验证分段问题汇总、推荐／其他回答与发送；5a 的 `node tests/node-terminal-pty-test.mjs` 在本机 POSIX PTY 验证中文、包装过滤、退出码、取消、超时和手动占用保护（Windows 跳过，跨平台 SSH 模拟回归由 node-agent/node-workbench 测试承担）。两者纳入冒烟。节点浏览器另运行 `node tests/node-agent-test.mjs --browser`，核对执行确认、终端定位及窄屏布局。

代码搜索：`tests/code-search-ui-test.mjs` 覆盖真实 WS/ripgrep 的高亮、预览、打开定位、输入取消、过期批次、正则及文件名切换；桌面启动回归还核对包内 rg 路径和可执行性。

### JDBC 桥接构建

`npm run build:server` 同时运行 `build:jdbc`，需要 JDK 17+（JAVA_HOME 或 PATH）；桥接使用 Java 8 字节码，仅依赖标准库。首次直接运行 `dev:server` 前执行 `npm run build:jdbc`，`npm run dev` 自动准备桥接。单测中的 JDBC 测试同样需要 javac/jar。无 Java 的终端用户仍可使用原生 MySQL/PostgreSQL。

本地验证：`npm run typecheck`、`npm run build`、`npm test`、`node tests/packaged-jdbc-test.mjs`、`node tests/database-jdbc-browser-test.mjs`。不需要真实数据库或模型服务；厂商驱动与目标 Windows 的兼容性单独验收。

### OMP 子任务输出回归

`node tests/omp-task-output-test.mjs` 验证真实原生溢出、共享输出目录、兄弟任务同名调用、嵌套祖先、停止后下载、历史恢复、分支归属、丢失／符号链接拒绝及 HTTP 鉴权。设置 `HARNESS_TEST_BROWSER=1` 同时验证真实浏览器下载与窄屏入口；CI 使用独立 env 字段设置此值。该脚本支持桌面门禁的 `<executable> <resources/app>` 参数，但本机 Node 验证不等于 Windows 或打包产物通过。

`extension-ui-test.mjs` 在扩展重载后等待 `settings_state` 之后、同一对话的空闲快照，再发送下一条命令。设置消息早于重载操作权释放，不能作为发送准入完成的信号；命令执行和内置命令优先级断言保持不变。证据见 [重载时序记录](review-data/omp-extension-reload-readiness.json)。

编辑器与 SSH 插件测试使用 `ensurePluginSsh2Dep` 从仓库已安装的锁定依赖复制 ssh2 子集，缺失时失败，不回退安装 latest。`vscode-editor-plugin-test` 保留严格目录清理并检查依赖已就绪；`ssh-plugin-ui-test` 使用当前 tab 角色、独立 OMP 夹具和所属服务器退出等待。此覆盖不替代生产自动安装器的取消／退出生命周期验收。
