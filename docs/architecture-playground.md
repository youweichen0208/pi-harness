# Playground（Java 代码运行）

> 决策背景见 `docs/adr/0004-playground-execution-model.md`；术语见 `GLOSSARY.md` 的 **Playground** / **Run**；界面规范见 `docs/ui-design.md`。

一句话：对话消息、小记与右栏文件预览里的 Java 代码块上的运行入口，把代码交给**宿主机器的 JDK** 编译执行，输出流式回到同一界面。默认关闭、**不是沙箱**、结果不进入模型上下文、不持久化。

## 定位与边界

- **核心功能，不是插件**：插件只能加顶栏 tab + 独立 client bundle，无法内联进消息渲染与小记正文。
- **默认关闭**，由服务端全局配置强制；客户端界面偏好**不改变执行能力**。
- **不是沙箱**：执行的是宿主机上的任意 Java 代码，拥有服务进程的用户权限。UI 与文档都明说这一点。
- **不挂载工作区**：代码看不到项目文件、`uploads/`、`notes/assets`。**三个入口都适用**——右栏文件预览里的 `.java` 文件同样在隔离临时目录里单独编译，不拿工作区当 classpath。
- **不进入模型上下文**：WebUI 不自动发起额外模型调用。对话里有显式的「把结果发给 pi」，把输出作为 fenced block 追加进输入框、**不自动发送**；小记没有 agent 会话，只有复制按钮。

## 依赖与探测

- 宿主自备 JDK，**不打包运行时**：Docker 镜像与 Electron 安装包都不含。
- 命令来源：`JAVA_HOME/bin/javac`、`JAVA_HOME/bin/java` 优先，否则 PATH。
- **懒探测 + TTL**（默认 60s），另有「重新检测」入口（`?refresh=1`）——用户常在服务已经跑着时才装 JDK。
- 需要 `javac` 与 `java` **两者**。仅凭「文件存在」不够：macOS 的 `/usr/bin/javac` 占位 stub 存在且可执行，但一跑就报 `Unable to locate a Java Runtime`；探测会把这个信息原样带到 UI。
- 探测失败只表现为「功能不可用 + 原因」，绝不影响服务启动。

## 配置

`<dataDir>/playground.json`（`writeFileAtomic` + 私有权限）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | 总开关；设置页写入，**路由处理器强制校验** |
| `timeoutMs` | `10000` | 墙钟超时，设置页可调 1–60s |
| `maxOutputBytes` | `262144` | stdout + stderr 合计上限 |
| `maxHeapMb` | `256` | 传给 `java -Xmx` 的软堆上限 |
| `maxConcurrent` | `2` | 全局并发上限（每客户端另限 1） |

- `POST /api/playground/config` 是**严格**的部分写入：只覆盖传入的字段，但类型错误、未知字段和**空 body** 一律 400——静默把调用方没提过的字段重置掉，比拒绝更糟。
- 环境变量 `PI_WEB_PLAYGROUND=off`（或 `0` / `false`）**硬关闭并在设置页锁定**：状态报 `locked`，**写入路径也 403**，所以设了它的部署无法从页面解锁。
- 文件损坏或字段类型不对时读取降级为默认值（即「关」），绝不 fail open。

## 执行

- 两步：`javac -d <tmp> <源文件>` → `java -Xmx<maxHeapMb>m -cp <tmp> <主类全名>`。
- javac 固定以 `-J-Duser.language=en -J-Duser.country=US` 运行：诊断文本会被解析（见下）并原样展示，**不能随宿主 locale 变化**——中文 macOS 会输出 `错误: 需要<标识符>`，那条规则会静默失效。程序自身的输出不受影响。
- 从代码解析第一个 **public 顶层类型**（`class` / `record` / `enum` / `interface`），无 public 类型时用 `Main`；**支持 `package` 声明**（写到 `<tmp>/com/x/Foo.java`，主类用全限定名）。解析必须忽略注释与字符串/文本块里的假声明。
- **只编译单个源文件**，`-cp` 只指向 `<tmp>`：不挂工作区、不加 `--source-path`。引用项目其他类会编译失败——这是刻意选择，失败时由 `needsProject` 给出人话解释（见「传输」）。
- 每次运行独立 `mkdtemp`，**无论成功、失败、超时、取消都删除**。
- stdin 是 `/dev/null`，`System.in.read()` 立即得到 EOF，不会挂到超时。
- 超时 / 取消 / 超输出上限一律 `killPidTree` 整个进程树（子进程 `detached`，否则拿不到进程组）。
- 超过 `maxOutputBytes` **直接杀进程**并标记 `truncated`——否则 `while(true) System.out.println()` 会一直写到超时。
- 并发：每客户端 1、全局 2，超出返回 429「忙」。

## 传输

HTTP + SSE，**不新增 WS 消息、`PROTOCOL_VERSION` 不变**：

- `GET /api/playground/status` → `{ enabled, locked, jdk: { available, version?, path?, reason? }, limits }`；`?refresh=1` 强制重新探测。
- `POST /api/playground/config` → 同上的状态体。
- `POST /api/playground/run`，body `{ code }`，响应体就是流（`text/event-stream`）。**单请求、无 runId 注册表**。
- 事件：`start{runId}` / `out{stream:"stdout"|"stderr", text}` / `end{exitCode, durationMs, truncated, timedOut, compileError, needsProject}` / `error{message}`。
- `needsProject` 由服务端从 stderr 尾部判定（`looksLikeMissingProjectDependency`）。放在服务端而不是浏览器，是因为 web 无法 import `playground-source.ts`——它用 `Buffer` 记账，浏览器里不存在；规则留在一处，三个入口都拿到同一句解释。
- 取消：**监听 `res` 的 `close`**（`!res.writableEnded` 时 abort）→ `killPidTree`。不能监听 `req`：`express.json()` 在进入 handler 前已经把请求流读完，`req` 的 `close` 早已发生，取消会静默失效并留下孤儿进程。
- 鉴权与 Origin/Host 校验沿用 Notes；响应头 `Cache-Control: no-store, no-transform` + `X-Accel-Buffering: no` + `res.flushHeaders()`。
- **路由必须注册在 `app.use(compression())` 之前**，否则压缩中间件会缓冲事件流。
- 输入校验在能力检查**之前**：body 不合法是 400，与机器上有没有 JDK 无关。
- 类型（`PlaygroundStatus` / `PlaygroundEvent` / `PlaygroundConfigPatch` 等）只定义在 `server/protocol.ts`，且必须保持**纯类型**（`scripts/check-protocol-sync.mjs` 守护）。

## 前端

- 状态用 app 级 `usePlayground`（照 `use-notes`），在**加载 / 窗口聚焦 / online / WS 重连**时刷新；经 `PlaygroundProvider` 下发。设置页与运行入口用**同一份**状态，所以改设置后所有运行入口立即跟上，无需刷新。取不到状态时是 `null`（「问不到」），不会谎报为「已关闭」。
- **Run 状态放在 React 之外**（`playground-run-store.ts`，`useSyncExternalStore`，按「会话/小记/文件 + 源码」为键）。对话里的助手消息在**从流式槽位移入已落定列表时会被重新挂载**，组件内的 Run 会被卸载时中止而凭空消失——这是实际踩到的 bug。页面刷新仍然清空。
- **对话**：`Markdown` 的 `pre` 组件按 `mermaid` / `design-tree` 先例分流，`java` 围栏块渲染 `PlaygroundRun`。`runnable` 是**按渲染点显式开启**的：`Markdown` 有 5 个调用点，`StreamMarkdown` 的围栏内代码本来就是朴素 `<pre>`，所以「工具卡片没有按钮」和「流式期间没有按钮」都是这个选择的自然结果，不是特例判断。
- **小记**：`RichEditorHost` 增加可选 `runCode`，`RichMarkdownEditor` 的命令式代码块 chrome 每轮按需增删运行按钮；结果渲染在编辑器**下方**，不写进 body（`rich-content.ts` 白名单本来也拒绝 `iframe`/`script`），不参与版本。**Wiki 宿主不传 `host`，因此没有运行按钮**——这是构造上的保证，不是运行时判断。
- **文件预览**：`.java` 文件的按钮在 `fp-header-actions`，运行的是**编辑器缓冲区（含未保存改动）且不保存**；按钮标题直接写明这一点。因为不保存，运行后文件仍是 dirty 状态，离开时**既有的未保存保护会照常生效**——这是 ADR-0001 的直接后果。
- **结果呈现**：stdout / stderr **两个独立区块**。两个 pipe 的读取时序本来就不保真，合并会制造「顺序可信」的假象；分离还能让编译错误自然落在 stderr 区。`PlaygroundResult` 由三个入口共用，`sendToPi` 可选（小记不传）。`needsProject` 时显示「只支持自包含单文件」。
- **失效**：小记与文件预览记住「这次运行的源码」，源码被改掉后结果**不消失**，而是打上「代码已改变」标记——让结果凭空消失会让人怀疑自己到底跑没跑过。对话里的代码块不可编辑，所以只有这两处需要。
- 不可用时显示**禁用态 + tooltip 说明原因**（对话入口），不隐藏——隐藏会让人以为功能不存在。
- 开启时弹一次二次确认，文案明确「不是沙箱」。
- **不进**顶栏「后台任务」面板（那是给长期存活的服务进程用的）。

## 留痕

服务端记一行日志：`runId`、耗时、退出码、编译错误/超时/截断/取消标记；**不记代码内容**。

## 测试

- **纯函数单测**（`tests/unit/playground-*.test.ts`，共 32 条）：public 类型名解析（注释/字符串/文本块里的假声明、`record`/`enum`/`interface`、无 public 类型、多个顶层类型）、`package` 解析、输出截断（按字节、不切断多字节字符）、`looksLikeMissingProjectDependency`、配置归一化与边界钳制、环境锁、JDK 命令解析（`JAVA_HOME` 优先、JRE-only 目录跳过、win32 的 `.exe` 与分隔符）、探测 TTL、并发闸门。
- **集成 + 浏览器**：`tests/playground-test.mjs`（加入 `run-smoke.mjs` 清单）。无 `javac` 时执行类断言自动 skip（CI 与 Docker 构建机都不装 JDK）。有 JDK 时覆盖：真实编译执行、stdout/stderr 分离、`package`、stdin EOF、编译错误 vs 运行错误、`needsProject`、超时、超输出、取消（断开即杀且不留进程/临时目录）、并发忙、配置写入与拒绝、环境锁；`--browser` 覆盖对话入口（含工具卡片没有按钮）、小记入口（不动 body/version、改代码后 stale、切小记清除）、文件预览入口（跑缓冲区、不保存、单文件解释、切文件清除）、设置页与锁定只读态。
- 脚本用**净化过的环境**启动服务：会删掉继承来的所有 `PI_*`。否则在 pi-harness/Electron 宿主里跑测试时，`PI_WEB_PKG_ROOT` 会让被测服务去伺服**宿主自己的** `web/dist`（浏览器测的是另一个应用），`PI_WEB_WORKSPACES_FILE` / `PI_SESSION_FILE` 还会指向开发者真实的工作区与会话。

## 回归

`npm run typecheck && npm run build && npm test`；`node tests/playground-test.mjs --browser`（需要 `JAVA_HOME` 指向 JDK 才会执行真实运行的那部分）。
