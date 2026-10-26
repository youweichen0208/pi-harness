# 内置 SSH 节点工作台

顶栏「节点」打开节点来源与分组详情，连接后提供 Agent 工作台和 SSH PTY/SFTP 手动工作台。Windows/macOS 客户端都由本机 Node 服务通过 `ssh2` 连接 Linux/macOS SSH 服务；远端账号或容器决定实际权限。

## 数据与认证

- `<dataDir>/nodes.json` 存节点 ID、分组、地址、端口、用户名、认证方式、私钥路径、默认目录与已信任的 SHA-256 主机密钥指纹。密码和私钥口令使用 `PluginSecrets` 写入 `<dataDir>/node-workbench/secrets.bin`，共享 `<dataDir>/secrets.key` 加密密钥。
- 「导入 Remote-SSH 配置」仅读取旧插件的 `ssh-hosts.json` 元数据，不删除原配置，也不读取或导入旧插件的加密凭据。需要重新填写密码或私钥口令。导入/导出 JSON 只传非机密字段。
- 首次连接先给浏览器展示主机密钥指纹；信任后才允许认证。已保存的指纹变化时服务端阻止连接。指纹在每台客户端各自保存，不跨设备同步。

## 连接、终端与 Agent

- `NodeWorkbench` 按 `clientId:nodeId` 保存连接，终端按 `terminalId` 定位，所有可变请求要求与节点和会话身份匹配。断线时保留浏览器的已断开标签。浏览器 WebSocket 重连恢复同一连接上的 Agent 状态；SSH 断开会终止该连接的 Agent 和终端；重新连接自动准备新的隔离 Agent 实例。
- SFTP 浏览、读取与 UTF-8 写入按远端账号权限执行；单次读写限制 512 KiB。工具结果与终端捕获输出限制 64 KiB。

## 协议与验证

`node_request`/`node_event` 承载 `requestId`、`nodeId`、`terminalId`、`conversationId`；`server/protocol.ts` 为唯一 wire 类型源，前端在 `use-chat.ts` 转发节点事件给按需加载的工作台组件。`tests/node-workbench-test.mjs` 使用本地 mock SSH 服务覆盖主机信任、指纹变化、认证失败、终端命令、SFTP 及节点隔离。

## 来源同步

节点页分为来源设置、节点列表/详情、连接工作台三种视图。`server/node-sources.ts` 扫描 Xshell `.xsh` 和 OpenSSH config，返回非敏感元数据及保存凭据是否存在，不执行 config 中的命令。Xshell 7 凭据由 `xshell-credentials.ts` 在连接时独立读取和校验。Windows 默认检测 Documents（含 OneDrive）下的 NetSarang Computer/7/Xshell/Sessions，各平台检测 `~/.ssh/config`；自定义路径指向运行服务的机器，可在来源页指定。

- `nodes.json` 同时保存 sources；持续同步每 5 秒扫描，单来源扫描串行，重启后恢复。支持立即同步、暂停/恢复与一次导入。最多 10 个来源，每来源 200 个节点。扫描失败保留上次完整节点数据并展示错误。
- 以 `sourceId + sourceKey`（Xshell 相对文件名或 SSH Host 别名）匹配节点。目录/文件重命名视为旧来源移除、新来源加入。源文件删除只标记不可连接，不删除历史记录；文件恢复后恢复节点。来源字段只读。
- 名称/分组/端口更新保留已补填凭据；主机地址、用户名、认证方式、私钥路径变化会清除凭据。地址/端口变化清除指纹，重新连接需核对身份。变更断开原连接并取消待确认操作。
- Xshell 支持 UTF-8、UTF-16 LE BOM、文本解码兜底；私钥必须是可直接读取的本机路径。跳板机、代理、非 SSH 会话标记为不可连接；缺失用户名、无法确定的私钥路径和未适配的认证资料允许导入，在连接时补填。
- SSH config 支持具体 Host、通配默认值、否定匹配及首值优先的 HostName/User/Port/IdentityFile。Include、Match、ProxyCommand、ProxyJump、转发等未支持的行为会标记并阻止连接，不能忽略后直连。没有 IdentityFile 时使用 SSH agent，服务进程需有 `SSH_AUTH_SOCK`。
- “在本机定位配置”打开服务所在机器的文件管理器；浏览器可复制来源路径，原配置由 Xshell/编辑器修改。不会通过文件关联自动启动远端连接。

## 凭据

“测试并保存”先核对主机指纹并验证当前节点认证，成功后才保存凭据；可选择同组同认证方式的节点复用（其余节点在各自连接时验证）。不勾选持久化时只保存在服务内存中，按 client/node 隔离。本机覆盖优先于 Xshell 来源；没有覆盖时每次连接读取最新源密码，原工具改密码不需要重复导入。源密码变化不打断现有连接。自动读取的凭据不重复持久化。

### Xshell 7 自动认证与手动补填（协议 v46）

- `XshellCredentials` 只读取请求节点所属来源内的 `.xsh`；规范化真实路径并拒绝越界链接。来源地址、端口、用户名、认证方式和私钥路径必须与当前节点一致，异步期间配置或连接请求变化则终止。
- 默认密码解码使用当前 Windows 用户名与 SID（SHA-256 派生 RC4 密钥）；密文必须通过内置 SHA-256 摘要校验和严格 UTF-8 解码后才用于 SSH。支持 Xshell 7 会话格式；明确标记其他版本时要求手动补填。没有 Version 字段的旧会话仍校验 Xshell 7 格式，不按目录名猜测算法。
- 读取来源祖先目录的 `Common/MasterPassword.mpw` 判断主密码状态；`xshell_unlock` 验证用户输入的主密码后，按 client/source 缓存在服务内存。错误主密码不进入缓存，服务销毁清空缓存；不向客户端返回任何解密结果。无法读取身份或不兼容格式可补填，识别到主密码时先提示解锁。
- `Password` 与 `Passphrase` 分别用于密码和私钥认证；私钥路径和格式由 SSH 客户端校验，专用密钥库名称、Xagent、认证配置及硬件密钥未适配时引导补填。网络失败仍显示网络错误，认证失败返回 `credentialRequired`，不自动循环重试。
- 界面按 Xshell 7 的 SSH 用户身份验证组织方法、用户名、密码、用户密钥/浏览、口令与记住密码。`local_key_browse` 仅返回本机目录条目，最多 500 条；不返回文件内容。用户名以 `localUsername` 覆盖，原来源字段不改写，验证失败保留之前保存的绑定。
- 节点 `authStatus` 为非敏感状态（source/local/missing/locked/unsupported）；它不保证远端认证成功。密码、口令和密文不进入节点快照、导出、日志或模型上下文。`xshell_unlock` 受 quiesce 准入约束。

## 验证补充

`tests/unit/node-sources.test.ts` 覆盖来源解析和敏感字段剔除；`tests/node-workbench-test.mjs` 覆盖同步合并、删除/失败保留、手动终端、SFTP 和隔离。浏览器测试覆盖 UTF-16 Xshell 导入、凭据验证、自动更新、节点切换和窄屏布局，不调用真实模型。`tests/unit/xshell-credentials.test.ts` 使用公开参考向量及独立 OpenSSL 合成向量覆盖解码、损坏数据、主密码隔离和路径边界；节点协议测试使用注入的合成 Windows 身份和真实本地 SSH 认证。它们不等同于 Xshell 实机验收。Windows Xshell 7 实际生成会话（保存密码、主密码、私钥口令、中文用户/密码、自定义目录）尚需实测；记录具体版本后才可宣称对应格式兼容。

Xshell 公钥登录节点可在凭据弹窗指定本机 OpenSSH 私钥路径（不是 `.pub` 公钥或 Xshell 密钥名称）；私钥口令允许留空。测试通过后保存 `localKeyPath` 本机绑定，来源配置仍只读，正常同步不会覆盖绑定；来源主机、用户或认证资料改变则清除绑定。绑定只解除私钥路径缺失限制，不会绕过代理等不支持项。错误路径或验证失败不覆盖已保存绑定。

来源节点的「认证设置」可在密码与公钥认证间切换。测试使用候选配置，成功后保存 `localAuth`，来源 `auth` 保留原值用于同步比较；失败不覆盖已保存选择。连接和界面使用本机选择，普通同步和重启保留；来源主机、用户或认证资料变化时与本机私钥绑定一起清除。切换方式会清理旧凭据和其他客户端连接，避免把服务器密码当成私钥口令。

## 节点 Agent Chat（#54）

连接成功后左侧显示 SSH 终端与文件，右侧直接显示 Agent Chat；窄屏上下排列。`node-agent.ts` 使用本机原版 pi 1.4.0 SDK、本机模型和凭据创建隔离会话。连接只准备会话，用户发送消息才调用模型；节点不需要 Node、pi 或模型配置。手动关闭 Agent 后不会立即重开，右侧保留重开和目录选择入口。初始化失败只影响聊天，SSH 终端仍可用。

每个 client/node 的会话位于 `<dataDir>/node-sessions/<clientId 的 SHA-256>/<nodeId>/`。同一服务重连后恢复最近历史，新的实例 ID 拒绝旧请求；新对话新建历史文件；SDK 在首条回复后才写文件，`fresh-session.json` 记住尚未写入的新对话，重连或重开时继续该空对话，不回到上一段历史（#74）。模型只返回思考就结束时，聊天区提示可发送「继续」。模型切换只影响该节点会话，不写本机默认模型。浏览器只接收模型名称等白名单字段，本机凭据不进入 SSH 命令或节点文件。

这是主聊天原生上下文规则的明确例外：节点会话使用限定节点职责的提示词，只启用 `remote_command`、`remote_read`、`remote_write`。不加载本机项目上下文、用户扩展、技能、模板或 MCP，也不暴露本机 bash/read/write，防止误操作本机。主聊天保持原有工具、提示词与配置。

### 5a 共享终端与执行确认

`remote_command` 在当前选择的手动 SSH PTY 中运行；没有终端时打开一个。`node-command.ts` 引用保护默认绝对目录，每次命令仍从 Agent 的 cwd 开始，cd 不跨命令保留。终端初始化为 Bash / Zsh / POSIX shell 安装不可见提示符标记；Agent 只在确认空闲时写入，不打断已有手动进程。执行期间服务端拒绝普通输入，前端也锁定输入；Ctrl+C、停止、超时或断开取消当前等待。用户在终端执行过的命令结束时会重新打印提示符，Agent 短暂等待后即可接管。`sudo`/`su`/子 shell 或用户覆盖 `PS1` 会永久丢掉标记，此时 Agent 在确认用户没有未提交输入、也没有全屏程序占用（备用屏幕）后，向空闲 shell 写入一次不带 Ctrl+C 的探针重新安装标记（#120）；探针被前台进程吃掉时保持「手动终端正忙」错误，不打断手动进程、也不在界面留下探针回显。终端不能确认提示符时仍可手动使用，Agent 命令返回明确错误。

`node-terminal-output.ts` 按随机开始／结束标记跨数据包解析输出，过滤 shell 包装回显，持续转发真正输出并保留最多 64 KiB 给模型。超时默认 120 秒，可设 1–600 秒。Agent 结果卡展示实际命令、状态和行数；成功结果保存经过白名单序列化的 terminalId/commandId/lines/durationMs，运行中和失败状态由 NodeAgentState.terminalCommands 补充。终端用 OSC 标记定位，重挂载从缓存重建，超出滚动缓存时说明记录已不可定位。登录信息默认折叠，更新和重启提示单独保留。

`node-command-policy.ts` 在服务端按命令及参数分类，只读 Linux 查询默认执行：基础文件／进程／磁盘查询、systemctl status/show/list-*、journalctl 日志查询、ss 连接查询、ip show/list、find 查找、sort/uniq 标准输出及 sed 按行查看。支持只读管道、`&&`／`||`／`;`／换行组合，以及限定 sudo 参数包裹的只读查询；切换到 root 后分类规则不变。多用途命令逐项校验参数：find 删除／执行、sort 输出文件、uniq 第二个文件、日志清理、服务启停、网络变更等均须确认。未知选项、未适配程序、命令展开、重定向、后台执行、解释器及无法可靠判定的脚本仍须确认；这是一层交互确认策略，不是对远端自定义命令或 shell 环境的沙箱保证。

删除、写入、系统状态变更和 remote_write **每次单独确认**，允许／拒绝按一次性 UUID 绑定当前 Agent 实例；不再提供命令族免询问，旧客户端传入 remember 也不授权后续操作。关闭、取消、断开及新对话清理等待。手动终端和手动文件保存仍由用户直接操作。

分类参考：[GNU find 的执行／删除动作](https://www.gnu.org/software/findutils/manual/html_mono/find.html)、[GNU sort 输出文件选项](https://www.gnu.org/software/coreutils/manual/html_node/sort-invocation.html)、[journalctl 查询与维护选项](https://www.freedesktop.org/software/systemd/man/256/journalctl.html)。

读写文件走现有 SFTP，UTF-8 文件限制 512 KiB；所有工具捕获原连接，不能在异步期间改投到新节点。中断写入可能留下部分内容。

运行结束以 `agent_settled` 为准，`agent_end` 不清除工作状态。SDK 提供流式回复、原生工具记录、排队/纠正、停止和模型切换，界面发送确认后才清空输入。节点任务计入应用更新的忙碌检查；quiesce 拒绝连接、凭据验证及新 Agent 工作，允许停止和断开。普通 WebSocket 重连恢复同一 Agent 状态；SSH 断开取消该会话任务。历史由本机 SDK 保存，界面保留最多 200 条或约 4 MiB 的最近消息。

原生远端 RPC 方案已由上述本机 Agent + SSH 工具方案替换。现有远端 pi 历史保持原处，本次不会下载或迁移；此前本机 `node-sessions` 下的历史可继续使用。

回归：`tests/node-agent-test.mjs` 使用本机原版 SDK、本地模型 HTTP 夹具及无 pi/模型配置的 SSH 服务夹具，验证连接即就绪、工具和凭据隔离、共享 SSH PTY/SFTP、确认与拒绝、排队、取消、超时和重连历史；`--browser` 验证连接即聊天、左右分栏及窄屏。命令引用与错误目录由 `tests/unit/node-command.test.ts` 验证；真实生产 Linux 节点仍需实际环境验收。

节点添加页仅展示 SSH 连接与 Xshell 导入两个入口。SSH 表单提供导入 SSH config 的次级入口；来源管理默认折叠，同步和 JSON 导入导出按需展开。来源导入只保留一个提交按钮，通过自动同步复选框选择后续同步行为。节点详情突出连接操作，认证及元数据放在「连接设置与详情」折叠区；缺少凭据时连接操作仍主动引导填写，原有主机信任与认证校验不变。

节点极简重设计：添加页水平居中双卡片，来源管理原地向下展开，标题和卡片位置及尺寸保持不变。SSH 表单按名称、地址与端口同行、用户名、密码排列，认证方式／分组／默认目录折叠；新增节点保存成功后继续连接并保持主机信任确认，连接失败保留已保存配置。Xshell 7 通过只读 `source_preview` 预览后接入整个目录，后续新增节点自动加入；既有 Xshell 来源的 `selectedKeys` 在加载时移除，保留暂停状态。不支持的节点保留在列表中并说明原因。SSH config 继续使用 `selectedKeys` 选择导入和同步。目录浏览复用服务端文件夹选择器。

### 手动中断与 Xshell 路径（#129、#131）

终端 `onData` 同时包含用户输入和终端自动回报。服务端 `node-terminal-input.ts` 将完整焦点进入／离开通知与有对应远端查询的光标位置回报从输入状态判断中剔除，原始字节仍转发给 SSH；自动回报不修改 `promptReady` 和 `manualTyped`，避免从手动终端切到聊天框后误报忙碌，也不能清除已有半行输入。光标查询支持跨输出包，按普通／扩展查询分别一次性匹配，5 秒过期、最多保留 16 个；遇到用户输入清除剩余查询，未请求的回报形状仍按输入处理，避免误吞功能键。混合消息中的真实输入、粘贴和未知序列保留原有保护。真实 PTY 与节点 Agent 浏览器测试覆盖手动命令完成后的焦点切换交接。

手动终端 Ctrl+C 的 `interrupt` 消息清除未提交输入标记，并等待新的提示符或已有恢复探针确认空闲；不依赖普通 `terminal_input` 路径。未提交文字和全屏程序仍阻止 Agent 接管。真实 Bash PTY 回归覆盖输入半行 → Ctrl+C → Agent 命令。

Xshell 显式 PrivateKey／PublicKeyFile 路径优先于 UserKey 密钥名称；路径去除外围双引号，展开环境变量，`./` 和 `../`（含 Windows 分隔符）相对于 `.xsh` 文件解析。扫描只读取配置元数据，不读取私钥内容；仅有密钥名称或不能解析的路径仍要求本机绑定。
