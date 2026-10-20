# Playground（Java 代码运行）

> 状态：**设计已定，尚未实现**（2026-10-21）。本文是待实现的规范；实现落地后把「状态」一行删掉。
> 决策背景见 `docs/adr/0004-playground-execution-model.md`；术语见 `GLOSSARY.md` 的 **Playground** / **Run**。

一句话：对话消息、小记与右栏文件预览里的 Java 代码块上的运行入口，把代码交给**宿主机器的 JDK** 编译执行，输出流式回到同一界面。默认关闭、**不是沙箱**、结果不进入模型上下文、不持久化。

## 定位与边界

- **核心功能，不是插件**：插件只能加顶栏 tab + 独立 client bundle，无法内联进消息渲染与小记正文。
- **默认关闭**，由服务端全局配置强制；客户端界面偏好**不改变执行能力**。
- **不是沙箱**：执行的是宿主机上的任意 Java 代码，拥有服务进程的用户权限。UI 与文档必须明说。
- **不挂载工作区**：代码看不到项目文件、`uploads/`、`notes/assets`（v1 明确不做）。**三个入口都适用**——包括右栏文件预览里的 `.java` 文件，它也在隔离临时目录里单独编译，不拿工作区当 classpath。
- **不进入模型上下文**：WebUI 不自动发起额外模型调用；结果只给用户看。另有一个显式的「把结果发给 pi」按钮：把输出作为一条 **inline 附件**插入输入框、**不自动发送**（复用现有三种附件模式里的 inline），由用户确认后再发；小记没有 agent 会话，该按钮退化为「复制到剪贴板」。

## 依赖与探测

- 宿主自备 JDK，**不打包运行时**：Docker 镜像与 Electron 安装包都不含。
- 命令来源：`JAVA_HOME/bin/javac`、`JAVA_HOME/bin/java` 优先，否则 PATH。
- **懒探测 + TTL**，另有「重新检测」入口——用户很可能在服务已经跑着的时候才去装 JDK，纯启动探测会一直显示不可用。
- 需要 `javac` 与 `java` **两者**：只有 JRE 时报「未检测到 JDK」，不要报「未找到 Java」。
- 探测失败只表现为「功能不可用 + 原因」，绝不能让服务启动失败。

## 配置

`<dataDir>/playground.json`（`writeFileAtomic` + 私有权限，照 `notes.ts` / `private-file.ts`）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | 总开关；设置页写入，**路由处理器强制校验** |
| `timeoutMs` | `10000` | 墙钟超时，设置页可调 1–60s |
| `maxOutputBytes` | `262144` | stdout + stderr 合计上限 |
| `maxHeapMb` | `256` | 传给 `java -Xmx` 的软堆上限 |
| `maxConcurrent` | `2` | 全局并发上限（每客户端另限 1） |

环境变量 `PI_WEB_PLAYGROUND=off`（或 `0` / `false`）**硬关闭并在设置页锁定为不可修改**，用于 Docker / 共享部署——配置文件本身是能被页面改写的，挡不住持有口令的人。

## 执行

- 两步：`javac -d <tmp> <源文件路径>` → `java -Xmx<maxHeapMb>m -cp <tmp> <主类全名>`。
- 从代码解析第一个 **public 顶层类型**（`class` / `record` / `enum` / `interface`）；没有 public 类型时用 `Main`。解析必须忽略注释与字符串字面量里的假声明。
- **支持 `package` 声明**：解析出 `package com.x;` 后写到 `<tmp>/com/x/<Type>.java`，主类全名用 `com.x.<Type>`；没有 package 时写 `<tmp>/<Type>.java`。练习代码常常一上来就带 package，不支持会大面积失败。
- **只编译单个源文件**，`-cp` 只指向 `<tmp>`：不挂工作区、不加 `--source-path`。引用工作区里其他类会编译失败——这是刻意选择（见「定位与边界」），失败时必须给出人话解释（见「前端」）。
- 每次运行独立 `mkdtemp`，**无论成功、失败、超时、取消都删除**。
- stdin **立即 EOF**（不挂终端），避免 `new Scanner(System.in)` 挂到超时。
- 超时 / 取消 / 超输出上限一律 `killPidTree` 整个进程树（复用 `server/process-utils.ts`）。
- 超过 `maxOutputBytes` **直接杀进程**并标记 `truncated`——否则 `while(true) System.out.println()` 会一直写到超时。
- 并发：每客户端 1、全局 2，超出返回「忙」。
- 退出码语义：编译失败 → 运行阶段不执行；`end` 里区分 `compileError` / `runtimeError` / `timedOut` / `truncated`。

## 传输

HTTP + SSE，**不新增 WS 消息、`PROTOCOL_VERSION` 不变**（沿用 notes 的先例）：

- `GET /api/playground/status` → `{ enabled, locked, jdk: { available, version?, path?, reason? }, limits }`
- `POST /api/playground/run`，body `{ code }`，响应体就是流（`text/event-stream`）。**单请求、无 runId 注册表**。
- 取消：前端 `AbortController` 断开 → 服务端 `req.on("close")` → `killPidTree`。
- 事件：`start{runId}` / `out{stream:"stdout"|"stderr", text}` / `end{exitCode, durationMs, truncated, timedOut, compileError}` / `error{message}`。
- 鉴权与 Origin/Host 校验沿用 Notes；响应头 `Cache-Control: no-store, no-transform` + `X-Accel-Buffering: no` + `res.flushHeaders()`。
- **路由必须注册在 `app.use(compression())` 之前**（`server/index.ts` 里 notes 等路由的位置），否则压缩中间件会缓冲 SSE。
- 类型（`PlaygroundStatus` / `PlaygroundEvent` 等）只定义在 `server/protocol.ts`，且必须保持**纯类型**（`scripts/check-protocol-sync.mjs` 守护）。

## 前端

- 状态用 app 级 context（照 `use-notes`），在**加载 / 窗口聚焦 / WS 重连**时刷新 `status`。
- **对话**：`web/src/components/Markdown.tsx` 的 `pre` 组件已按 `mermaid` / `design-tree` 先例分流，`java` 围栏块照此加运行按钮与结果区。
- **小记**：`web/src/components/RichMarkdownEditor.tsx` 的代码块 chrome（`.fp-code-language`）加运行按钮；结果渲染在编辑器**下方临时区**，不写进 body——`web/src/rich-content.ts` 的白名单本来就会拒绝 `iframe`/`script`，而且结果按定义不该持久化。
- **共享接缝**：给 `RichEditorHost` 增加可选 `runCode` 能力，Wiki 宿主不传即没有运行按钮（照 `RichEditorHost` 的「一个组件、两种宿主」模式）。
- **文件预览**：`web/src/components/FilePreview.tsx` 的 `fp-header-actions`（或「更多」菜单）里给 `.java` 文件加运行按钮；`CodeFileEditor` 只是 textarea + 高亮层，不放按钮。
  - 运行的是**编辑器缓冲区**（含未保存改动），**不保存**。「运行」不是写操作，不触发落盘冲突/离开保护流程；tooltip 必须写明「运行编辑器中的内容（含未保存改动）」，避免有人以为磁盘也更新了。
  - 复用 `server/editor-snapshot.ts` 的既有校验（工作区内文本文件、512 KiB 上限）。
  - 只支持自包含单文件：编译失败且代码含 `package`/`import` 时，除可展开的原始 `javac` 输出外，必须显示「Playground 只支持自包含单文件，完整项目请用终端」。
  - 切换文件即清空结果（结果不持久化）。
- **结果呈现**：stdout / stderr **两个独立区块**。两个 pipe 的读取时序本来就不保真，合并会制造「顺序可信」的假象；分离还能让编译错误自然落在 stderr 区。按 chunk 转发，前端 **60ms 微批合并渲染**（照 `server/terminals.ts` 的既有做法）。
- 小记里**代码块文本一变，旧结果立即失效**并标记「代码已改变」。
- 不可用时显示**禁用态 + tooltip 说明原因**，不隐藏——隐藏会让用户以为功能不存在。
- 开启时弹一次二次确认，文案明确「不是沙箱」。
- **不进**顶栏「后台任务」面板（那是给长期存活的服务进程用的，10 秒级运行放进去只会刷屏）。

## 留痕

服务端记一行日志：`runId`、耗时、退出码、输出字节数、是否截断/超时；**不记代码内容**。

## i18n 文案草稿（zh / en 两处都要加）

| key | zh | en |
| --- | --- | --- |
| `playgroundRun` | 运行 | Run |
| `playgroundRunning` | 运行中 | Running |
| `playgroundStop` | 停止 | Stop |
| `playgroundRerun` | 重新运行 | Run again |
| `playgroundStdout` | 标准输出 | Standard output |
| `playgroundStderr` | 标准错误 | Standard error |
| `playgroundExitCode` | 退出码 | Exit code |
| `playgroundDuration` | 耗时 | Duration |
| `playgroundTimedOut` | 超时终止 | Timed out |
| `playgroundTruncated` | 输出超过上限，已终止 | Output limit exceeded, stopped |
| `playgroundCodeChanged` | 代码已改变 | Code changed |
| `playgroundSendToPi` | 把结果发给 pi | Send result to pi |
| `playgroundRunEditorBuffer` | 运行编辑器中的内容（含未保存改动） | Run editor contents (including unsaved changes) |
| `playgroundSingleFileOnly` | Playground 只支持自包含单文件，完整项目请用终端 | Playground runs self-contained single files; use the terminal for full projects |
| `playgroundCopyOutput` | 复制输出 | Copy output |
| `playgroundNoJdk` | 未检测到 JDK（需要 javac 与 java） | No JDK found (needs javac and java) |
| `playgroundDisabled` | 代码运行已在设置中关闭 | Code execution is off in settings |
| `playgroundLocked` | 已被环境变量 PI_WEB_PLAYGROUND 锁定 | Locked by PI_WEB_PLAYGROUND |
| `playgroundBusy` | 已有运行在进行 | A run is already in progress |
| `playgroundEnableWarning` | 代码运行**不是沙箱**：执行的是你自己机器上的任意 Java 代码。确定开启？ | Code execution is **not a sandbox**: it runs arbitrary Java on your machine. Enable? |

## 测试

- **纯函数单测**（`tests/unit/`）：public 类型名解析（注释/字符串里的假声明、`record`/`enum`/`interface`、无 public 类型、多个顶层类型）、输出截断、编译错误 vs 运行错误分类。
- **集成**：`tests/playground-test.mjs`，**无 `javac` 时自动 skip**（CI 与 Docker 构建机都不装 JDK）。有 JDK 时覆盖：真实编译执行、编译错误、超时、取消（断开连接即杀）、超输出、并发忙、开关关闭时 403、环境变量锁定、SSE 帧顺序。
- 加入 `tests/run-smoke.mjs` 清单（无 JDK 环境自动跳过）。测试规范照旧：端口 ≥8900、`mkdtempSync` 隔离 data-dir、只清理自己的进程。

## 回归

`npm run typecheck && npm run build && npm test`；`node tests/playground-test.mjs`；有 JDK 的机器上再跑一次 `node tests/playground-test.mjs` 确认集成分支真的执行了（不是被 skip）。
