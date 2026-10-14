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

跨仓代码与文档检索的本地评测见 [工程上下文：设计与验证](engineering-context.md)。开发工具位于 `dev/context-eval/`，确定性回归执行 `npm run test:context-eval`（也纳入零 token 冒烟）；真实模型和 OpenViking 对比在本机单独运行，开发夹具结果不作为检索收益结论。

GitHub Actions ubuntu-latest（`.github/workflows/ci.yml`，push/PR → main 或 develop 触发）：`check:lockfile → npm ci → check:protocol → typecheck → build → npm test（设计检查 + vitest）→ test:smoke`。

SSH 节点另有 macOS/Windows CI job：两平台分别构建服务端并运行 `node-workbench-test.mjs` 的 mock SSH 测试。浏览器工作台交互可在 macOS 本地运行 `node tests/node-workbench-browser-test.mjs`（先 `npm run build`）。

冒烟清单（tests/run-smoke.mjs 的 ALL）只收**自包含、零 token、跨平台**的测试；attach 型（需外部 server）、需真模型、平台相关的脚本不进 CI，本地手动跑（分类见 run-smoke.mjs 头部注释）。

## 编码约定

- **缩进用 Tab**；前端组件小写文件名（`copy-button.tsx` 例外）；代码注释中英混写，UI 文案默认中文。
- **i18n**：所有用户可见字符串走 `useT()`；改 `i18n.tsx` 必须同时加 `zh` 和 `en` 两个 key（`en` 的类型是 `Record<keyof typeof zh, string>`，漏一个会编译报错，这是特性不是 bug）。
- **通知文案**：服务端 notice 直接写中文，不需要 i18n。
- **样式**：全部在 `styles.css`，按 `/* ---- 组件名 ---- */` 分区；颜色用 CSS 变量（`--bg-elev*`、`--border*`、`--text*`、`--accent*`、`--yellow-fg`、`--green`、`--red`）。
- 文件列表 `IGNORED_ENTRIES`（node_modules/.git/dist 等）在 `files-service.ts` 顶部维护（分平台两套）。
- 新增协议消息 → 只改 server/protocol.ts（见 `docs/architecture-core.md`「协议单源」），再在两端 dispatch/onmessage switch 各加分支。

## 斜杠命令目录

服务端 `pushSlashCommands()` 收集当前活动会话的扩展命令（`session.extensionRunner.getRegisteredCommands()`）+ 模板（`promptTemplates`）+ 技能（`resourceLoader.getSkills()` → `skill:<name>`）加上 10 个内置命令（NATIVE_COMMANDS：/new /model /compact /cwd /thinking /resume /reload /help /copy /pi-harness:quit），经 `slash_commands` 消息推送（attach / set_cwd / new_chat / switch_conversation / switch_session / get_commands 时刷新）；内置命令在 `prompt()` 里拦截（`execNativeCommand`，含 /model 模糊匹配、/thinking 中英别名、`/reload` 调 `session.reload()` 重新发现扩展/技能/模板后重推目录），其余透传 SDK（SDK 会展开扩展/技能/模板命令）。

注意 SDK 的 `getSkills()` 返回的是会话创建时的内存快照——删除/新增 skill 文件后必须 `/reload`（或 /new / 切项目重建 runtime）才生效。改动时保持 `NATIVE_COMMANDS` 与 `execNativeCommand()` 同步。回归：`slash-commands-test.mjs`。

## 验证清单

1. `npm run typecheck` 零错误
2. 涉及 UI → `npm run dev` 手动过一遍交互
3. 涉及 ws 协议 → `tests/` 下有现成脚本可参照：先跑 `npm run test:smoke`（自包含协议测试全量），单个用 `node tests/xxx-test.mjs`（需先 `npm run build`；浏览器 E2E 的 Chrome 由 `tests/lib/chrome.mjs` 自动探测，可用 `PI_WEB_CHROME` 指定）

## 测试规范

### 全局 vs 本地

用户日常可能正用**全局安装**的 `pi-harness`（`~/.local/share/fnm/node-versions/…/lib/node_modules/pi-harness`，默认端口 `8787`）跑着对话/工作。开发改造对象永远是**本地仓库**（你的 pi-harness 检出目录）。用户会在自己测试时手动关闭全局 dev、切到本地。

**绝对不要杀全局进程/占 8787**：禁止 `pkill -f "dist/server/index.js"`——它会命中全局 server（端口 8787），把用户正在用的会话打断。清理只针对**自己启动的测试 server**。

### 隔离端口

每个 `*-test.mjs` 用独立端口（≥8900，避开 8787/5173/3300），并在启动 server 前先 `lsof -ti :PORT -sTCP:LISTEN` 确认空闲；若被占，改端口而非硬杀。

### 精确清理自己起的进程

spawn 后记录 `server.pid`，测试收尾（含异常 catch 路径）用 `process.kill(pid, 'SIGTERM')` 只杀自己启动的。多开几个 server 时用各自 PID 逐个杀，别用宽泛模式匹配。

### data-dir 隔离

测试 server 设 `PI_WEB_DATA_DIR` 为 `mkdtempSync(tmpdir…)`，`PI_WEB_CWD` 指本地仓库——避免污染真实 user data / client-state / session。

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

原生上下文回归：`tests/new-chat-context-test.mjs` 在显式关闭可选 plan 的基线下，用本地模拟模型核对 WebUI 与独立 pi 会话的系统提示词和工具列表，并覆盖新建、恢复及浏览器切换。`tests/settings-test.mjs` 检查显示偏好持久化与旧提示词覆盖参数失效。节点浏览器回归只验证手动终端、SFTP 与节点隔离，不创建节点代理。

原生结果/运行状态回归：`extension-ui-test.mjs` 验证真实扩展的跨对话请求、重连、取消、reload 和内存设置（`--browser` 加测多行编辑、后台来源跳转及恢复阶段）；`tool-output-test.mjs` 验证真实 SDK 截断输出恢复、鉴权下载和路径限制；`recovery-service-test.mjs` 在宿主事件边界模拟压缩/529 退避、摘要取消、过期操作与元数据缓存。这三项均为零模型调用，纳入完整冒烟。

## SDK 升级契约检查

SDK / pi-ai 当前精确锁定 1.2.0。升级前必须验证内部 prompt-templates 适配器：`tests/unit/prompt-delivery.test.ts` 覆盖 `$@`、位置参数、无占位符、带引号参数、空格/换行/Tab/CRLF 分隔、同名扩展优先级、input 钩子一次、原生两种队列模式及撤回；`tests/current-file-protocol-test.mjs --browser` 验证模型实际输入和冻结附件编辑。`tests/native-tools-desktop-test.mjs` 在普通 Node 和三平台打包产物中验证模块定位与展开契约。只有这些检查通过才能更新适配器版本保护；加载或版本不兼容时保留失败和草稿保护，禁止回退到独立 custom message 投递。

1.0.4 → 1.2.0 升级（2026-10-13）：`dist/core/prompt-templates.js`、`system-prompt.js`、`mcp-servers.js` 与 1.0.4 字节一致，两处版本保护随之改为 1.2.0。适配：`agent_settled.aborted` 为真时不触发未执行工具调用提醒；工具耗时优先使用 SDK 记录的 `durationMs`（`tool_execution_end` 与持久化的 toolResult，重载后保留，UiMessage 新增可选字段）；codemode 运行中显示经过时间；模型配置写回保留 `$schema` 等顶层字段。

附件围栏回归使用真实 buildAttachmentMessages → promptWithAttachments → parseUserAttachments 链路。工具输出回归包含 600 MiB 稀疏日志的清单及原字节流式校验，不把大文件读为完整字符串；单测覆盖扫描上限和跨块标记。

Pi 1.0.4 起的专项（1.2.0 继续适用，文件名保留 `pi-104-`）：`pi-104-prompt-contract-test.mjs` 核对 Codemode on/only 的模型请求、getter、隐藏规则和技能；`pi-104-upstream-fixes-test.mjs` 验证初始化中的 MCP 关闭、Codemode 内建对象修改后结算及 read 图片，均进入零 token 冒烟。资源基准与已知问题复现另见 [原生能力与资源审查](pi-native-resource-review.md)，不在 CI 中运行长时间性能场景。

原生计划回归：`plan-sdk-test.mjs` 与 `plan-settings-test.mjs` 纳入零 token 冒烟；浏览器单独执行 `node tests/plan-chat-browser-test.mjs`。均使用隔离目录与本地模拟模型，不调用真实服务。

内置扩展回归：`builtin-extensions-test.mjs` 纳入零 token 冒烟，验证清单、数据库开关、重载及转换／OKF 入口缺失。原生上下文基线关闭 plan 内置工具。


### 数据库工作台回归

`npx vitest run tests/unit/database.test.ts` 无外部服务。真实驱动与浏览器回归使用专用测试实例，不可指向业务数据库：

```bash
docker run --rm -d --name pi-db-test-pg -e POSTGRES_PASSWORD=pi_test_only -e POSTGRES_DB=analytics -p 127.0.0.1:9277:5432 postgres:17-alpine
docker run --rm -d --name pi-db-test-mysql -e MYSQL_ROOT_PASSWORD=pi_test_only -e MYSQL_DATABASE=analytics -p 127.0.0.1:9278:3306 mysql:8.0
npm run build
node tests/database-test.mjs --browser
node tests/database-tls-test.mjs
docker rm -f pi-db-test-pg pi-db-test-mysql
```

先等待两个数据库完成初始化；端口冲突时使用其它 ≥8900 的端口，并以 PI_TEST_PG_PORT / PI_TEST_MYSQL_PORT 传给测试。协议/浏览器测试另使用 9274/9275，TLS 测试使用 9280，启动前检查端口；临时应用 data-dir、模型夹具及 TLS 容器由测试自行清理。MariaDB 可替换 MySQL 测试实例，用相同 PI_TEST_MYSQL_PORT 运行。

3a/4a 回复回归：`node tests/chat-redesign-ui-test.mjs` 验证分段问题汇总、推荐／其他回答与发送；5a 的 `node tests/node-terminal-pty-test.mjs` 在本机 POSIX PTY 验证中文、包装过滤、退出码、取消、超时和手动占用保护（Windows 跳过，跨平台 SSH 模拟回归由 node-agent/node-workbench 测试承担）。两者纳入冒烟。节点浏览器另运行 `node tests/node-agent-test.mjs --browser`，核对执行确认、终端定位及窄屏布局。

代码搜索：`tests/code-search-ui-test.mjs` 覆盖真实 WS/ripgrep 的高亮、预览、打开定位、输入取消、过期批次、正则及文件名切换；桌面启动回归还核对包内 rg 路径和可执行性。
