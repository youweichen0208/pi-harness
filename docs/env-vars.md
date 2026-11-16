# 环境变量

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `PORT` | `8787` | HTTP 端口 |
| `PI_WEB_CWD` | `process.cwd()` | 智能体工作区（读/写/终端都以此为根） |
| `PI_WEB_DATA_DIR` | `~/.pi-web` | 应用数据（client-state.json、上传等）；OMP 配置位于其 `omp/agent` 子目录，会话按用途及工作目录隔离在 `omp/sessions`，不与旧 Pi CLI/TUI 共享历史 |
| `PI_WEB_WORKSPACES_FILE` | `<PI_WEB_DATA_DIR>/project-workspaces.json` | Workspace 列表文件；桌面版默认指向 `~/.pi-web/project-workspaces.json`，与命令行版共用，并一次性并入数据目录里的旧列表 |
| `PI_WEB_INLINE_FILE_MAX` | `12288` (12KB) | inline 附件的内联阈值，超过自动降级为路径引用 |
| `PI_WEB_VISION_TIMEOUT_MS` | `90000` | 视觉桥单次转写（整批图片）超时，防止慢视觉模型拖住 prompt |
| `PI_WEB_STALL_NOTIFY_MS` | `180000` | 模型无进展看门狗：流式运行中 N 毫秒无任何 SDK 事件则发 warning 提示可能失联（不自动 abort——深度思考可合法静默数分钟）；0 = 关闭 |
| `PI_WEB_MODEL_DIAGNOSTICS_DIR` | 空（关闭） | OMP 宿主事件元数据的本地目录；每个运行实例最多 8 MiB，不记录项目原文、参数、签名或凭据。同步写入会影响计时，见 `deepseek-windows-validation.md` |
| `PI_WEB_UPLOAD_RETENTION_DAYS` | `14` | 上传文件保留天数（`<dataDir>/uploads/`，启动时扫一次 + 每 6 小时一次）；0 = 关闭清理 |
| `PI_WEB_SHELL` | 自动探测 | Windows 终端面板（node-pty）的 shell：默认优先 Git Bash（与 SDK bash 工具一致），可用此变量显式指定（如 `powershell.exe` / `cmd.exe`） |
| `PATH`（macOS 自动补全） | 追加 `/opt/homebrew/bin`、`/opt/homebrew/sbin`、`/usr/local/bin`、`/usr/local/sbin` | 桌面版从 Dock / Spotlight / launchd 启动时不经过登录 shell，`~/.zprofile` 的 `brew shellenv` 不执行，PATH 只剩 `/usr/bin:/bin:/usr/sbin:/sbin`，终端里 `npm`/`node`/`git` 全是 command not found。服务启动时**追加**（不前置、不重复、不存在的目录跳过）这几个系统标准目录；用户自己配的目录始终优先。nvm / volta / asdf / fnm 等版本管理器**不猜**，仍需用户在 `~/.zshenv` 里导出。见 `server/shell-path.ts` |
| `PI_CODING_AGENT_DIR` | 由应用设置 | OMP worker 内部指向 `<PI_WEB_DATA_DIR>/omp/agent`；继承的旧值不控制应用配置，使用 `PI_WEB_DATA_DIR` 选择应用数据目录 |
| `PI_WEB_HOST` | `127.0.0.1` | 监听地址。**默认只绑 loopback**（本地个人工具，不暴露到网络）；局域网/容器访问需显式 `0.0.0.0`（docker-compose 已内置，并同时设置 `PI_WEB_ALLOW_HOSTS`） |
| `PI_WEB_ALLOW_ORIGINS` | 空 | 逗号分隔的额外 Origin 白名单（如 `http://localhost:5173` dev 代理、反代场景），用于绕过 WS 的 Origin/Host 同权威校验 |
| `PI_WEB_ALLOW_HOSTS` | 空 | 请求 Host 的 hostname 白名单（逗号分隔）。**未设置且绑定 loopback 时默认只放行 `localhost` / `127.0.0.1` / `[::1]`**，防 DNS rebinding；绑定 `0.0.0.0` 或走反代时需自行设置（否则只做 Origin/Host 同权威校验） |
| `PI_WEB_TOKEN` | 空 | **可选共享口令鉴权**：设置后所有 HTTP/WS 请求必须携带（`Authorization: Bearer` / `X-PI-Token` 头、`?token=` 参数或 `pi_web_token` cookie 任一匹配；浏览器首次经 `?token=xxx` 进入后存 localStorage 并下发 HttpOnly cookie）；`/api/health` 保持开放供探针。前端 `web/src/auth-token.ts` 统一注入；口令变化（或换端口重启）时服务端会重发 cookie，不会被旧 cookie 挡住；比较用常量时间；`/api/health` 不再返回工作区路径。**桌面版每次启动自动生成随机口令**（`electron/server-auth.mjs`），无需配置；回归：`tests/token-auth-test.mjs`（端口 8975）、`tests/desktop-server-auth-test.mjs` |
| `PI_WEB_PLAYGROUND` | 空 | 设为 `off`（或 `0`/`false`）时**硬关闭 Python 代码运行（Playground）并在设置页锁定为不可修改**，用于 Docker/共享部署；不设置时由 `<PI_WEB_DATA_DIR>/playground.json` 的 `enabled` 决定（首次检测到 Python 默认开启，保留已保存选择）。见 `docs/architecture-playground.md` |
| `PI_WEB_CLIENT_IDLE_MINUTES` | `30` | 客户端（浏览器标签页）断开且 OMP 任务、输入队列、恢复、请求和活终端均空闲后，超过 N 分钟回收运行时；已退出终端不阻止回收，最近项目和原生历史选择保留，同一 clientId 重连会等待旧 worker 关闭后恢复，不重发请求。0 = 不回收，非法值回退 30 分钟。`client-state.json` 另外最多保留 200 个客户端条目 |

## OMP 配置目录与旧变量

前台、系统服务和桌面版均由应用数据目录确定 `omp/agent` 和 `omp/sessions`。CLI `server install` 将显式 `--data-dir` 或 `PI_WEB_DATA_DIR` 保存到服务配置，不再写入旧 Pi agent 目录。OMP worker 会剥离继承的 Pi/OMP profile 和会话选择变量，避免恢复旧 Pi 历史。

原生 OMP 个人包目录由 SDK 独立确定，通常位于 `~/.omp/plugins`，并不会随 agentDir 改变。Docker 镜像通过 `~/.omp` 到 `/data/omp-native` 的链接将其纳入持久卷，详见 [部署](deployment.md#docker)。

旧 `PI_CODEMODE_MAX_WORKERS` 不再控制应用工具；OMP 原生工具与并发策略由当前 OMP 配置决定。旧强制输出额度变量也已移除，模型额度遵循原生目录或用户显式覆盖。

`PI_WEB_PYTHON`：Playground 的 Python 3.9+ 解释器路径，可指向虚拟环境；不接受 shell 参数。未设置时探测 VIRTUAL_ENV、PATH 和 Windows py -3。Jedi 补全与 Black 格式化也使用该环境。见 `architecture-playground.md`。

### JDBC 运行时

`PI_WEB_JAVA`：可选，指定 GaussDB JDBC 使用的 `java` / `java.exe` 完整路径；设置后优先使用且不回退。未设置时探测本机 DataGrip bundled runtime、JAVA_HOME 与 PATH。不自动安装 Java。

OMP output limits follow the native model catalog or an explicit models.yml maxTokens override. PI_MAX_TOKENS and PI_MAX_TOKENS_FLOOR are retired. Clear the model editor field to restore the native default.


### OMP 本地请求诊断

`PI_WEB_MODEL_DIAGNOSTICS_DIR` 默认空。设置后启用宿主事件和公开 provider 钩子观察，主／子会话生成独立 JSONL，单文件最多 8 MiB。原文／参数／schema／模型和端点标识以本地 HMAC 摘要代替，密钥 `.request-diagnostics-key` 留在本机，不共享、不提交。采集有性能开销，目录累计空间需测试后手动清理；不支持的协议字段和实际网关行为仍需另行核验。范围、PowerShell 启用方式和限制见 [Windows 对照文档](deepseek-windows-validation.md)。
