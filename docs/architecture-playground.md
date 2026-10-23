# Playground（Java 代码运行）

> 决策背景见 `docs/adr/0004-playground-execution-model.md`；术语见 `GLOSSARY.md` 的 **Playground** / **Run**；界面规范见 `docs/ui-design.md`。

一句话：对话消息、小记、右栏文件预览里的 Java 代码块与左栏 Playground 草稿页上的运行入口，把代码交给**宿主机器的 JDK** 编译执行，输出流式回到同一界面。默认关闭、**不是沙箱**、结果不进入模型上下文、不持久化。

## 定位与边界

- **核心功能，不是插件**：插件只能加顶栏 tab + 独立 client bundle，无法内联进消息渲染与小记正文。
- **默认关闭**，由服务端全局配置强制；客户端界面偏好**不改变执行能力**。
- **不是沙箱**：执行的是宿主机上的任意 Java 代码，拥有服务进程的用户权限。UI 与文档都明说这一点。
- **不挂载工作区**：代码看不到项目文件、`uploads/`、`notes/assets`。**三个入口都适用**——右栏文件预览里的 `.java` 文件同样在隔离临时目录里单独编译，不拿工作区当 classpath。
- **不进入模型上下文**：WebUI 不自动发起额外模型调用。对话里有显式的「把结果发给 pi」，把输出作为 fenced block 追加进输入框、**不自动发送**；小记与草稿页没有 agent 会话，只有复制按钮。

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
- **裸语句自动包 `Main`**（jshell 风格）：源码里没有任何顶层类型声明（注释/字符串里的假声明不算）时，`import` 提到 scaffold 外、其余语句成为 `public static void main(String[] args) throws Exception` 的函数体（`throws Exception` 让 `Thread.sleep` 之类不改就能编译）。已声明任何类型（含包私有）的源码原样不动。规则在 `wrapBareStatements`（纯函数，有单测），对四个入口统一生效。
- javac 固定以 `-J-Duser.language=en -J-Duser.country=US` 运行：诊断文本会被解析（见下）并原样展示，**不能随宿主 locale 变化**——中文 macOS 会输出 `错误: 需要<标识符>`，那条规则会静默失效。程序自身的输出不受影响。
- 从代码解析第一个 **public 顶层类型**（`class` / `record` / `enum` / `interface`），无 public 类型时用 `Main`；**支持 `package` 声明**（写到 `<tmp>/com/x/Foo.java`，主类用全限定名）。解析必须忽略注释与字符串/文本块里的假声明。
- **只编译单个用户源文件（方法测试另加内部调用器）**，`-cp` 只指向 `<tmp>`：不挂工作区、不加 `--source-path`。引用项目其他类会编译失败——这是刻意选择，失败时由 `needsProject` 给出人话解释（见「传输」）。
- 每次运行独立 `mkdtemp`，**无论成功、失败、超时、取消都删除**。
- stdin 是 `/dev/null`，`System.in.read()` 立即得到 EOF，不会挂到超时。
- 超时 / 取消 / 超输出上限一律 `killPidTree` 整个进程树（子进程 `detached`，否则拿不到进程组）。
- 超过 `maxOutputBytes` **直接杀进程**并标记 `truncated`——否则 `while(true) System.out.println()` 会一直写到超时。
- 并发：每客户端 1、全局 2，超出返回 429「忙」。

## 传输

HTTP + SSE，**不新增 WS 消息、`PROTOCOL_VERSION` 不变**：

- `GET /api/playground/status` → `{ enabled, locked, jdk: { available, version?, path?, reason? }, limits }`；`?refresh=1` 强制重新探测。
- `POST /api/playground/config` → 同上的状态体。
- `GET/PUT /api/playground/scratch` → `{content, updatedAt}`，左栏草稿页的唯一持久化（`<dataDir>/playground-scratch.json`，`writeFileAtomic` + 私有权限）。PUT 接受 `{content: string, tests?: PlaygroundTestConfig}`，拒绝未知顶层字段；省略 `tests` 保留已存用例（空串 = 清空，超 `MAX_SOURCE_BYTES` 拒绝）；**草稿读写不受总开关限制**——写代码不是运行代码。文件损坏降级为空草稿，绝不崩服务。
- `POST /api/playground/run`，body `{ code, tests?: {methodId, cases} }`，响应体就是流（`text/event-stream`）。**单请求、无 runId 注册表**。
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
- **草稿页**（`PlaygroundScratch.tsx`，2026-10-22）：左栏「对话／Playground／小记」的中间入口，**不受总开关隐藏**；运行复用 `playground-run-store`（key 前缀 `scratch`），结果区共用 `PlaygroundResult`（stale 标记用精确比对——这里文本完全由本页拥有）。自动保存 600ms 去抖 + 卸载 flush；首访（`updatedAt === 0` 且空）种入模板。页面刷新仍清空运行结果，与其它入口一致。
- **草稿编辑器与补全**（`scratch-editor.tsx`）：草稿页正文是 CodeMirror 6 + `@codemirror/lang-java`，提供语法高亮、行号、括号匹配与**词级补全**——Java 关键字 + 当前草稿里已出现的标识符，输入单词或 `.` 后弹出。**没有语义引擎**（不上 JDT language server，也不维护静态 API 成员词表）：`System.out.` 后弹的是文档词，不是真成员。编辑器与补全是编辑辅助，**不受总开关限制**（同草稿读写）。⌘/Ctrl+Enter 用 `Prec.highest` 键位永远优先运行、不被补全弹窗拦截；可用性检查留在页面层，与 Run 按钮同一套 `reason`。主题从 CSS 变量生成、监听 `THEME_CHANGE_EVENT` 重建（语法配色复用 `--code-*`，同 highlight.js 调色板）。编辑器经 `React.lazy` 懒加载（约 466KB 独立 chunk，主包不涨）。补全只在草稿页：对话代码块只读，右栏 `.java` 预览用通用编辑器，均不涉及。

## 留痕

服务端记一行日志：`runId`、耗时、退出码、编译错误/超时/截断/取消标记；**不记代码内容**。

## 测试

- **纯函数单测**（`tests/unit/playground-*.test.ts`，共 32 条）：public 类型名解析（注释/字符串/文本块里的假声明、`record`/`enum`/`interface`、无 public 类型、多个顶层类型）、`package` 解析、输出截断（按字节、不切断多字节字符）、`looksLikeMissingProjectDependency`、配置归一化与边界钳制、环境锁、JDK 命令解析（`JAVA_HOME` 优先、JRE-only 目录跳过、win32 的 `.exe` 与分隔符）、探测 TTL、并发闸门。
- **集成 + 浏览器**：`tests/playground-test.mjs`（加入 `run-smoke.mjs` 清单）。无 `javac` 时执行类断言自动 skip（CI 与 Docker 构建机都不装 JDK）。有 JDK 时覆盖：真实编译执行、stdout/stderr 分离、`package`、stdin EOF、编译错误 vs 运行错误、`needsProject`、超时、超输出、取消（断开即杀且不留进程/临时目录）、并发忙、配置写入与拒绝、环境锁；`--browser` 覆盖对话入口（含工具卡片没有按钮）、小记入口（不动 body/version、改代码后 stale、切小记清除）、文件预览入口（跑缓冲区、不保存、单文件解释、切文件清除）、设置页与锁定只读态。
- 脚本用**净化过的环境**启动服务：会删掉继承来的所有 `PI_*`。否则在 pi-harness/Electron 宿主里跑测试时，`PI_WEB_PKG_ROOT` 会让被测服务去伺服**宿主自己的** `web/dist`（浏览器测的是另一个应用），`PI_WEB_WORKSPACES_FILE` / `PI_SESSION_FILE` 还会指向开发者真实的工作区与会话。

## 回归

`npm run typecheck && npm run build && npm test`；`node tests/playground-test.mjs --browser`（需要 `JAVA_HOME` 指向 JDK 才会执行真实运行的那部分）。

## 草稿页方法测试（2026-10-22）

- 草稿页仅提供方法测试，不再显示运行模式切换；支持只写非 private 方法片段（自动包 `Main`，import/package 留在类外），或完整普通类。发现与参数校验在浏览器可用的 `server/playground-methods.ts`，使用 `@lezer/java` 语法树，服务端在执行前重新校验；完整代码仍由 javac 最终检查。
- 只列顶层普通类显式声明的非 private 方法，排除标准 main、构造器、继承和嵌套类方法。签名为 `全限定类名#方法名(参数类型列表)`，重载独立保存用例；不支持的类型、泛型类／方法、抽象方法或缺少无参构造时给出原因。实例方法使用默认或非 private 无参构造，static 不构造对象。
- 参数／返回值支持八种基本类型、包装类型、String、多维数组（varargs 按数组），以及 `List<T>`／`java.util.List<T>`（元素为包装类型、String 或嵌套 List）；void 只检查执行成功。文本直接输入，数组和 List 使用 JSON 数组，引用类型有显式 null；断言为可选 `expected`，因此空字符串和不做断言可以区分。long 使用 BigInt 校验并生成十进制 Java 字面量，JSON 数组内超安全整数必须写成字符串。精确按 Java 类型比较，数组递归比较，List 按顺序递归比较且不要求实现类一致；没有浮点容差、对象映射或 JUnit。
- List 支持空列表、null 元素及 null 子列表；每层输入构造为可修改的 `ArrayList`，调用器使用擦除后的 `java.util.List.class` 反射查找。结果递归格式化并计入原有输出预算。类型归一化识别 `java.lang` 包装类型及 String，List 嵌套最多 64 层；不支持原始 List、通配符、自定义元素、其他集合或 List 与数组混用。用户源码需自行 import 或使用全限定名；private 辅助方法保留在源码中，由非 private 方法正常调用。
- 每批最多 50 用例、配置 256 KiB。一批编译一次，每条用例使用独立 JVM（静态状态也隔离）；调用器通过精确参数类型反射调用，仅注入校验后的值。生成源码在临时目录，既不改用户代码也不保存 main。Java 调用器源码由 `playground-method-runner.ts` 提供，随服务端 JS 打包，不依赖额外 jar。
- 原有 `/run` 的 `{code}` 行为保留。`tests` 包含所选方法 ID 和用例列表；新增 `case_start{id}`、`case_result{result}` SSE。每条结果包含 ID、状态、返回值／预期值／异常文本及耗时。结构化结果走每条独立的限长内部文件，不从 stdout 猜测；采用 Base64 字段封装，结果也计入整批输出预算。普通断言失败和异常继续，编译错误、超时、超输出或取消中止整批，其余用例记为未执行。
- 一批共用现有并发名额、墙钟超时、堆限制和输出预算，超时包括编译与所有 JVM 启动开销。中断杀进程树，最后清理临时目录。程序结束时 POSIX 进程组中的后台子进程也清理。
- 草稿增加可选 `tests: {mode, selectedMethod, casesByMethod}`；旧文档保留代码和用例，草稿页加载时将模式归一化为 methods 并自动保存；首次使用填入 public 方法示例。服务端仍兼容旧 program 值，旧客户端只写 content 保留用例配置。代码、模式和用例按 600ms 去抖串行保存，卸载 flush，重入先等待已排队写入；加载失败不覆盖旧草稿。签名消失保留用例，重新出现后可继续使用。
- Run 键包含代码、方法及本次用例；当前草稿结果引用保存在组件外，离开重入仍可见，刷新清空。代码、模式或用例变化标记过期；结果不自动发给模型。
- 回归：`tests/unit/playground-methods.test.ts` 覆盖识别、片段包装、精度和参数验证；`node tests/playground-methods-test.mjs --browser` 自起隔离服务，覆盖真实 JDK、保存兼容、用例编辑、快捷键、结果过期与窄屏。无 JDK 时默认冒烟跳过执行部分，浏览器模式要求 JDK。

### 方法测试界面（2026-10-22）

草稿页采用左代码、右方法与用例的并排布局；可用宽度不足时上下排列。用例支持展开编辑，收起显示参数摘要和状态；执行结果按方法签名和用例 ID 就近展示，切换方法不将旧结果映射到新用例。日志与整次运行汇总仍共用 `PlaygroundResult`。界面布局和展开状态不写入草稿或模型上下文，保存与执行协议不变。

### 草稿保存 module（2026-10-23）

`web/src/playground-scratch-store.ts` 的 `PlaygroundScratchStore` 统一拥有草稿、已确认基线、串行保存队列和 600ms 去抖；`use-playground-scratch.ts` 连接 HTTP 与 React 订阅，页面只编辑和展示。最后一个订阅视图离开时 flush；重新进入先等待已排队写入，再读取持久草稿。写失败保留内存草稿，重入不以旧服务器内容覆盖；后续编辑或 flush 可以恢复。读取失败不写入模板，已离开视图的读取结果以及读取期间发生编辑的旧结果均不应用。

保存确认只推进对应写入基线；有后续写入时不能提前显示已保存。写入失败不会阻断后续队列。Run 状态仍归现有 `playground-run-store.ts`，不与持久草稿合并；跨窗口仍沿用原有最后写入行为，不增加版本冲突协议。

回归：`tests/unit/playground-scratch-store.test.ts` 通过同一 interface 控制传输确认与时间，验证回退、失败恢复、卸载重入和迟到读取；`tests/playground-methods-test.mjs --browser` 验证页面保存、模式迁移及等待写入确认期间离开重入。

草稿编辑器提供「格式化」按钮和 Shift+Alt+F 快捷键（#127）：服务端使用 Prettier Java，仅调整代码、不执行；支持方法片段和完整 class，执行关闭或没有 JDK 时仍可使用。解析失败保留原文；请求期间编辑过代码时不应用旧结果，离开页面取消请求，格式化可撤销。`POST /api/playground/format` 接受 `{code}` 并返回 `{code}`，沿用鉴权与 256 KiB 源码限制。方法识别支持 public、protected 和默认访问权限，private 方法保持作为辅助方法；旧签名的用例保留，选择新方法后可添加新用例。
