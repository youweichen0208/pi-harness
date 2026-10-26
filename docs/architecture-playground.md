# Playground（Python 代码运行）

Playground 使用宿主 Python 3.9+ 运行聊天、小记中的 `python` / `py` / `python3` 代码块、右栏 `.py` 文件缓冲区以及左栏草稿。首次检测到可用解释器默认开启，保留已保存开关；`PI_WEB_PLAYGROUND=off` 硬关闭且锁定设置。运行结果不进入模型上下文、不持久化；显式「把结果发给 pi」仅追加到输入框。

## 运行环境

- 不捆绑解释器。`PI_WEB_PYTHON` 指定解释器可执行文件路径（不是 shell 命令）；未指定时按 `VIRTUAL_ENV`、PATH 的 `python3` / `python`、Windows `py -3` 顺序探测。显式路径失败不偷偷回退。探测验证版本与实际 `sys.executable`，缓存 60 秒，支持重新检测。
- 执行与语言辅助共用选中的解释器。推荐虚拟环境；第三方库在该环境中安装，Playground 不自动下载或安装依赖。运行使用 `-I -X utf8 -u`，忽略 `PYTHONPATH` 和用户 site-packages，虚拟环境自身的包仍可用。规则依据 [Python 命令行文档](https://docs.python.org/3/using/cmdline.html)。
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

新草稿保存到 `<dataDir>/playground-python-scratch.json`；旧 Java 的 `playground-scratch.json` 原样保留作备份，不自动翻译或覆盖。GET/PUT scratch 保持原接口，执行关闭时仍可编辑保存。600ms 去抖、串行保存、失败内存保留与卸载 flush 由 `playground-scratch-store.ts` 统一管理。

草稿有「运行脚本」和「函数测试」两种模式，默认脚本，模式随草稿保存。运行脚本以 `__name__ == "__main__"` 执行；函数测试以独立模块名加载，因此 main guard 不执行，其他顶层语句正常执行。

- Lezer Python 语法树发现顶层 `def` / `async def`，不包含类方法和嵌套函数；服务端执行前重新发现和校验，Python 负责最终语法检查。
- 签名为 `函数名(参数名列表)`，代码变化后旧签名的用例保留。普通位置参数均需填写（即使声明默认值）；可变参数与 keyword-only 参数明确标注不支持，仍可通过脚本调用。异步返回值使用 `asyncio.run`。
- `str` 注解参数／返回值直接输入文本；其他类型使用 JSON 值：数字、字符串、布尔、数组、对象、null。JSON 原文交给 Python 解析，保留大整数精度；null 对应 None。注解不是运行时类型强制转换。
- 每批 1–50 条用例，每条使用全新 Python 进程，隔离模块全局状态。断言使用 Python `==`，结果展示 `repr`；异常记录 traceback 并继续下一条。超时、输出超限或取消停止整批，余下用例标为未执行。
- 结构化结果走独立限长文件，计入整批输出预算，不解析 stdout。源码、用例或模式变化标记旧结果过期；输出保留在页面运行 store，刷新清空。

## 编辑器、补全和格式化

CodeMirror Python 高亮、Tab 接受补全／缩进，Shift+Tab 反缩进，⌘/Ctrl+Enter 运行；源码栏「注释」按钮或 ⌘/Ctrl+/ 切换当前行／所选行的 `#` 注释，支持撤销、自动保存，无需语言服务。实时补全、签名与语法诊断通过选中解释器中的 **Jedi**，格式化通过 **Black**；都只分析代码，不执行提交源码。可选依赖缺失时显示安装提示，输入、自动保存与运行仍可用。

```sh
# 在用于 Playground 的虚拟环境中安装可选编辑辅助
/path/to/venv/bin/python -m pip install jedi black
# 启动服务前设置解释器（Windows 指向 venv\Scripts\python.exe）
export PI_WEB_PYTHON=/path/to/venv/bin/python
```

`POST /api/playground/language` 只允许 completion / diagnostics / signature / close，UTF-16 offset 与浏览器一致；`POST /api/playground/format` 接受 `{code}`。每次请求独立临时分析目录，最多 3 个并发、20 秒超时、1 MiB 输出上限；断开中止，结束清理。Jedi 使用显式临时项目与解释器路径，不扫描 Workspace。API 依据 [Jedi Script 文档](https://jedi.readthedocs.io/en/latest/docs/api.html)。

格式化可撤销，迟到结果不覆盖新输入；⌘/Ctrl+S 尝试格式化后保存，即使格式化失败也保存原文。关闭运行不禁止分析和格式化，但仍需解释器及相应可选依赖。

## 界面与验证

聊天只为 Python 围栏提供运行，工具输出／流式片段仍不提供入口。小记不改正文，文件预览运行未保存缓冲区、不自动保存；Java 围栏／文件不再显示运行。结果维持 stdout/stderr 分离、过期标记、取消和复制。

回归：`npm run typecheck && npm run build && npm test`；`node tests/playground-test.mjs` 验证真实 Python 与 HTTP 边界，`node tests/playground-methods-test.mjs --browser` 验证函数用例、脚本模式和草稿保存。无 Python 时执行测试明确 skip，浏览器模式要求 Python。`tests/playground-python-language-test.mjs` 需选择装有 Jedi / Black 的解释器，验证真实分析与格式化。
