# Playground（Python 代码运行）

## Playground「问 pi」（协议 v55）

右栏提供参数、输出、问 pi 三个页签；顶栏仅保留运行／停止操作，不显示问 pi、折叠按钮和快捷键徽标；结果面板常驻，通过问 pi 页签打开助手。编辑器持续显示，窄屏上下排列。独立输入不接主聊天附件、项目或终端；普通代码块仅复制。关闭运行或没有 Python 仍可问答。界面复用文档助手的欢迎文案和品牌标识，历史选择默认收起，消息独立滚动、输入框固定底部；Enter 发送，Shift+Enter 换行，输入法组合期间不提交。

`server/playground-chat.ts` 管理安装级共享助手，历史、当前对话、模型及建议位于 `<dataDir>/playground-chat/`，原生 transcript 按独立对话目录保存。首次继承打开方模型与思考设置，之后独立保存。`playground_chat` 请求覆盖 open/send/stop/new/switch/model/thinking/receipt；独立 state/result/error 消息不修改主聊天快照。多标签页共享当前对话；运行期间禁止切换、新建或改模型。离开不停止任务，重启保留中断标记，不续跑。

原生资源加载关闭上下文文件、技能、扩展与模板，内存设置关闭预热；工具白名单仅 `propose_playground_code`，排除 MCP，创建后核验 active tools。认证和模型声明沿用原生文件；独立 runtime 接入共用 ModelSourceSync，保留来源开关与外部来源模型，并在关闭时解除绑定。发送前先确认所选模型属于可用目录；SDK 的 unknown 占位模型不得参与容量判断或下发为当前模型。首段流式消息包含角色，以 `agent_settled` 判定完成。使用独立目录下的 `PromptReceipts`，发送前持久化占位；重连查询，不自动重发。已接收后的模型错误不把回执改为拒绝。

发送冻结未保存代码（≤256 KiB）、当前函数/参数和最近结果。输出按 UTF-8 截到 64 KiB，附部分、过期、截断标记与独立运行 ID，引用可展开。服务端用源码 SHA-256 绑定建议基准，保守检查上下文容量；拒绝时保留问题，不静默删除源码。结果仅显式发送时进入助手。

建议包含说明、完整代码和本轮基准，以差异卡片展示。应用同时检查 React 草稿和 CodeMirror 实际文档；基准不符仅允许复制或重新提问。应用使用隔离历史的单次事务，可一次撤销，沿用自动保存及签名参数迁移，不执行代码。草稿冲突后停止自动重试，保留本地编辑，提供复制和显式重新加载。

验证：`node tests/playground-chat-test.mjs --browser` 使用本地模拟模型检查隔离、冻结、建议、去重、历史/重启、停止及浏览器应用/撤销；相关单测覆盖 UTF-8 输出边界及保存冲突。`node --import tsx tests/playground-model-admission-test.mjs` 覆盖无模型时 hello 的误报回归及外部来源目录同步，不调用真实模型。

Playground 使用宿主 Python 3.9+ 运行聊天、小记中的 `python` / `py` / `python3` 代码块、右栏 `.py` 文件缓冲区以及左栏草稿。首次检测到可用解释器默认开启，保留已保存开关；`PI_WEB_PLAYGROUND=off` 硬关闭且锁定设置。运行结果默认不进入模型上下文、不持久化；Playground 问 pi 仅在显式发送时冻结结果到专属对话；显式「把结果发给 pi」仅追加到输入框。

## 运行环境

代码块入口标注「运行此代码块」，可展开说明独立进程不继承其他代码块变量、生成代码未经预验证。文档问 pi 的普通请求追加完整 Python 示例要求（含导入、变量与示例数据；示意片段需标注），不覆盖原生系统提示词；斜杠及 shell 命令不追加。Playground 隔离助手也遵循此要求。

代码块运行失败后「请 pi 修复」将原始源码、退出码、超时/截断标记与最多 64 KiB 的输出摘要追加到当前输入草稿。保留原草稿，不自动发送、不再次执行、不自动改文件。回归：`node tests/playground-repair-test.mjs` 使用真实 Python NameError 和本地模拟模型验证回填及调用次数。

- 不捆绑解释器。`PI_WEB_PYTHON` 指定解释器可执行文件路径（不是 shell 命令）；未指定时按 `VIRTUAL_ENV`、PATH 的 `python3` / `python`、Windows `py -3` 顺序探测。显式路径失败不偷偷回退。探测验证版本与实际 `sys.executable`，缓存 60 秒，支持重新检测。
- 执行与语言辅助共用选中的解释器。推荐虚拟环境；第三方库在该环境中安装，Playground 不隐式安装依赖；用户可通过按钮安装可选编辑工具。运行使用 `-I -X utf8 -u`，忽略 `PYTHONPATH` 和用户 site-packages，虚拟环境自身的包仍可用。规则依据 [Python 命令行文档](https://docs.python.org/3/using/cmdline.html)。
- **不是沙箱**。临时目录不自动加入项目路径，但代码仍有服务用户的文件、网络和进程权限，不能宣称无法访问工作区。
- 超时、输出预算、并发限制沿用原配置。移除 Java 专属 `maxHeapMb`；旧配置中的该字段读取时忽略，API 不再接受它。Python 内存没有跨平台硬限制。

## 执行与 HTTP

`server/playground-run.ts` 先用 Python `compile` 检查语法，再运行脚本或测试用例；内部程序以 TS 字符串随服务端构建，无额外资源拷贝。每批独立临时目录，stdin 立即 EOF，UTF-8 stdout/stderr 分离并流式返回。超时、断开、取消、超输出杀进程树并清理临时目录；POSIX 正常退出也清理后台子进程。

- `GET /api/playground/status` 返回 `{enabled, locked, python: {available, version?, path?, command?, args?, reason?}, limits: {timeoutMs, maxOutputBytes}}`；`?refresh=1` 重探。
- `POST /api/playground/config` 严格部分写入 `enabled`、`timeoutMs`、`maxOutputBytes`、`maxConcurrent`；默认 10 秒、256 KiB、全局 2／每客户端 1。环境锁写入 403，错误／空字段 400；损坏配置保持关闭。
- `POST /api/playground/run` 接受 `{code, tests?: {methodId, cases}}`，256 KiB 源码限制。SSE `start` / `out` / `case_start` / `case_result` / `end` / `error` 保持；历史字段 `compileError` 现在表示 Python 语法检查失败，`needsProject` 表示缺少导入依赖。
- 取消监听 `res.close`，不是已经读完的 `req.close`。路由仍在 compression 之前，复用鉴权、Origin/Host 检查和 SSE 禁缓冲头。HTTP 类型位于 `server/protocol.ts`，不新增 WebSocket 消息。
- 服务日志只记运行 ID、状态、耗时，不记源码。

## 草稿与函数测试

新草稿保存到 `<dataDir>/playground-python-scratch.json`；旧 Java 的 `playground-scratch.json` 原样保留作备份，不自动翻译或覆盖。GET scratch 返回的 updatedAt 同时作为保存版本；PUT 必须携带 expectedVersion，版本不匹配（含未提供）返回 409，不写入磁盘。成功保存返回严格递增的 updatedAt，客户端串行队列使用最新确认版本。冲突保留本地草稿。执行关闭时仍可编辑保存。600ms 去抖、串行保存、失败内存保留与卸载 flush 由 `playground-scratch-store.ts` 统一管理。

草稿不再有「运行脚本」与「函数测试」两种模式，运行也不是二选一。一次运行同时跑脚本和使用例：服务端 `/api/playground/run` 传 `tests` 时只跑用例、不传时只跑脚本，所以合并运行是客户端串行的两次请求，各自一个 run key。脚本先跑，输出先出现，用例批次随后。服务端对每个客户端只放行一个 Run（`gate.acquire(clientId, maxConcurrent, 1)`），两个请求不能并行，否则第二个会被拒为「已有运行在进行」。草稿仍保存 `tests.mode` 字段以兼容旧草稿，但界面不再读取它。

- Lezer Python 语法树发现顶层 `def` / `async def`，不包含类方法和嵌套函数；服务端执行前重新发现和校验，Python 负责最终语法检查。
- 签名为 `函数名(参数名列表)`，代码变化后旧签名的用例保留。普通位置参数均需填写（即使声明默认值）；可变参数与 keyword-only 参数明确标注不支持，仍可通过脚本调用。异步返回值使用 `asyncio.run`。
- `str` 注解参数／返回值直接输入文本；其他类型使用 JSON 值：数字、字符串、布尔、数组、对象、null。JSON 原文交给 Python 解析，保留大整数精度；null 对应 None。注解不是运行时类型强制转换。
- 每批 1–50 条用例，每条使用全新 Python 进程，隔离模块全局状态。断言使用 Python `==`，结果展示 `repr`；异常记录 traceback 并继续下一条。超时、输出超限或取消停止整批，余下用例标为未执行。
- 结构化结果走独立限长文件，计入整批输出预算，不解析 stdout。源码、用例或模式变化标记旧结果过期；输出保留在页面运行 store，刷新清空。

## 编辑器、补全和格式化

CodeMirror Python 高亮、Tab 接受补全／缩进，Shift+Tab 反缩进，⌘/Ctrl+Enter 运行；源码栏「注释」按钮或 ⌘/Ctrl+/ 切换当前行／所选行的 `#` 注释，支持撤销、自动保存，无需语言服务。实时补全、签名与语法诊断通过选中解释器中的 **Jedi**，格式化通过 **Black**；都只分析代码，不执行提交源码。可选依赖缺失时显示「安装补全与格式化工具」按钮，独立代码运行设置页已移除，源码区保留此入口；点击下载 Jedi / Black 到应用数据目录，输入、自动保存与运行仍可用。

```sh
# 在用于 Playground 的虚拟环境中安装可选编辑辅助
/path/to/venv/bin/python -m pip install jedi black
# 启动服务前设置解释器（Windows 指向 venv\Scripts\python.exe）
export PI_WEB_PYTHON=/path/to/venv/bin/python
```

`POST /api/playground/language` 只允许 completion / diagnostics / signature / close，UTF-16 offset 与浏览器一致；`POST /api/playground/format` 接受 `{code}`。每次请求独立临时分析目录，最多 3 个并发、20 秒超时、1 MiB 输出上限；断开中止，结束清理。Jedi 使用显式临时项目与解释器路径，不扫描 Workspace。API 依据 [Jedi Script 文档](https://jedi.readthedocs.io/en/latest/docs/api.html)。

格式化可撤销，迟到结果不覆盖新输入；⌘/Ctrl+S 先尝试自动缩进全文，再格式化并保存；缩进失败保存原文，格式化失败保存已缩进的代码。关闭运行不禁止分析和格式化，但仍需解释器及相应可选依赖。

## 界面与验证

聊天只为 Python 围栏提供运行，工具输出／流式片段仍不提供入口。小记不改正文，文件预览运行未保存缓冲区、不自动保存；Java 围栏／文件不再显示运行。结果维持 stdout/stderr 分离、过期标记、取消和复制。

回归：`npm run typecheck && npm run build && npm test`；`node tests/playground-test.mjs` 验证真实 Python 与 HTTP 边界，`node tests/playground-methods-test.mjs --browser` 验证函数用例、合并运行、脚本输出和草稿保存，`node tests/playground-merged-run-test.mjs` 验证一次点击产生脚本与用例两次请求以及当前参数编辑、无效输入禁用、精简输出和异常展示。无 Python 时执行测试明确 skip，浏览器模式要求 Python。`tests/playground-python-language-test.mjs` 需选择装有 Jedi / Black 的解释器，验证真实分析与格式化。

## 一键安装编辑工具

`POST /api/playground/tools/install` 仅接受空 JSON 对象，复用鉴权和来源校验；不接受包名、命令或路径。使用选定解释器的 `-I -m pip install --target` 安装固定的 Jedi / Black，不使用 sudo、`--user` 或 `--break-system-packages`，不修改宿主环境。工具按解释器命令分目录存放于 `<dataDir>/python-tools/`；每次安装独立代数目录，真实导入验证通过后原子更新 current 指针，失败删除未完成目录，旧代数保留供进行中的分析使用。仅分析／格式化子进程添加此目录，代码执行环境不变。

同一服务最多一个安装，180 秒超时、1 MiB 输出上限；断开与服务关闭杀进程树，失败可重试。界面显示安装中和失败原因，成功后自动重试语言诊断。Python 或 pip 本身缺失时返回错误，不下载解释器、不隐式引导 pip。

## 自动缩进

`POST /api/playground/indent` 接受 `{code, fromLine?, toLine?}`（1 起始，包含末行，未传为全文），返回 `{code}`，共用分析的大小、鉴权、并发、超时与取消限制。使用 Python 标准库，不依赖 Jedi/Black、不执行源码。支持两类局部修复：unexpected indent 前一条语句的缩进断裂（要求前后缩进一致），以及 expected an indented block 时紧随块头的首条简单语句缺少缩进。后者只移动首条逻辑语句，不猜测后续语句归属或拍平的嵌套复合语句；不修改选区外的行。最多 16 次。校验后以 tokenize 归一化逻辑语句为 4 空格，保留续行和字符串内容，再验证编译与 AST 一致。失败返回 422；前端只修改行首空白、保留选区、可撤销，源文变化则丢弃迟到结果。

函数参数区使用“参数／输出”页签，每个函数仅编辑和运行当前一组参数，不提供用例列表、新增或删除入口。旧草稿的额外用例保留存储但不参与执行；无参数记录时自动建立一组空参数。顶部统一“运行”按钮并内嵌平台快捷键，参数无效时禁止运行。脚本与当前函数仍串行执行，停止脚本时不继续启动函数。输出仅显示一次整体状态、返回值、非空 stdout 及必要错误，保留过期标记；不显示批次统计、输入回显、解释器和入口等重复信息。运行完成表示执行结束，不代表通过断言。运行使用独立 key 避免闪现上次输出。

函数选择随签名变化自动更新：停止编辑 500ms 后，当前签名失效时优先匹配同名函数；仅有一个旧函数消失和一个新函数出现时跟随重命名。新增无关函数不抢占有效选择，多个候选不猜测。参数按名称迁移，新增参数留空；目标签名已有记录时优先恢复，旧记录保留。

新增参数初始值按注解生成：int/float 为 0，bool 为 false，str 为空文本，list 为 []，dict 为 {}，未识别或无注解为 null。非字符串输入清空后失焦恢复该初始值；已有非空值保留。此为可编辑的界面初始值，不读取 Python 签名中的默认表达式，不对自定义类型作实例化保证。
