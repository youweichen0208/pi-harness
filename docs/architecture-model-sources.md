# 模型配置来源同步

pi-harness 使用内置 Pi SDK 执行对话，无需安装 Pi CLI。在「管理模型 → 配置来源」查看自动发现结果、立即同步、关闭来源或恢复已删除入口。首次引导共用该区域，提供 API Key 表单、模型管理和原生 OAuth 登录入口。就绪状态依据可选择的运行时模型目录，不再依据 auth.json 是否存在。

## 来源范围

| 来源 | 用户级位置与覆盖 | 支持范围 |
| --- | --- | --- |
| Pi | SDK agentDir / `PI_CODING_AGENT_DIR` | 保留原生配置、OAuth、扩展和会话。同步不迁移目录 |
| Claude Code | `~/.claude/settings.json` / `CLAUDE_CONFIG_DIR` | 显式 model、ANTHROPIC_MODEL、DEFAULT_*_MODEL、API_KEY、AUTH_TOKEN、BASE_URL、CUSTOM_HEADERS 与 settings.env |
| Codex | `~/.codex/config.toml`、`auth.json` / `CODEX_HOME` | 显式模型、model_providers、内联 profiles 及用户目录中的 `*.config.toml`、env_key、experimental_bearer_token、OPENAI_API_KEY、http_headers、env_http_headers、model_context_window |
| OpenCode | `~/.config/opencode/opencode.json[c]` / `XDG_CONFIG_HOME`、`OPENCODE_CONFIG_DIR`、`OPENCODE_CONFIG`；`~/.local/share/opencode/auth.json` / `XDG_DATA_HOME` | 显式 provider/models 与所选 model、API 类型凭据、options.baseURL/apiKey/headers、模型 limit/modalities/reasoning、`{env:NAME}` 和 `{file:path}` |

环境变量来自服务进程和来源配置，不执行 shell 启动文件。桌面应用从 Finder 启动时未必继承终端环境；缺少显式环境变量引用的条目会暂停，界面只显示同步状态，不展开失败原因。OpenCode 文件引用相对配置目录解析，并加入监听列表。只有内置 `openai` / `anthropic` 服务商使用对应的默认密钥环境变量；自定义服务商必须有明确的 apiKey、环境变量引用、文件引用或 API 凭据存储，缺失时显示需补充。

协议限定 Anthropic Messages、OpenAI Responses 和 OpenAI-compatible Chat Completions。Claude 的模型 ID 或显式别名映射支持末尾 `[1m]`：导入时去掉该后缀，并明确声明 1,000,000 token 上下文；请求使用去掉后缀的模型 ID。sonnet/opus 等未解析别名、云平台认证、modelOverrides、Codex 命令认证/gateway OAuth/query_params、OpenCode 未知 SDK 或无法转换的 options/variants 均报告不支持。不执行 apiKeyHelper、hooks、插件或远程配置；不读取项目配置、系统钥匙串和第三方订阅 token。不发现远程模型、不发起测试推理。

能力声明按字段区分“未声明”和明确值。接口、模型与认证一致的重复来源中，一个来源未声明而另一个明确声明时，采用明确值；多个明确声明存在冲突时保留独立入口，不取最大值，也不通过缺失值把冲突项合并。没有可采用的声明时使用保守文本模型配置（32768 上下文、4096 输出、不声明推理/图片）。可编辑为本地独立配置补充能力。费用字段不来自远程价格目录。

来源格式依据 [Codex 配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)、[Claude Code 设置](https://code.claude.com/docs/en/settings)、[OpenCode 配置](https://opencode.ai/docs/config/) 与 [OpenCode 凭据](https://opencode.ai/docs/providers/)。新格式必须增加夹具后适配，不能猜测协议或执行认证助手。

## 模块与存储

- `model-sources.ts`：只读适配器，接收可注入 home/env，输出服务端连接信息、安全状态和监听文件；JSONC 使用 jsonc-parser，TOML 使用 smol-toml。
- `model-source-sync.ts`：每个 dataDir/agentDir 一份共享目录，每个 ModelRuntime 有独立串行应用队列。首次绑定扫描，目录监听防抖 150ms，30 秒轮询补偿缺失目录和原子替换。
- `<dataDir>/model-sources.json`：来源开关、来源槽位到稳定 provider ID 的映射、删除墓碑及本地独立副本。默认映射不含密钥或凭据指纹；只有用户编辑脱离同步后才存储该副本所需凭据。私有目录 0700、文件 0600，原子替换。
- 协议 51：`sync_model_sources`、`models_config.sources` 和模型 `origin`。状态区分缺失、损坏、不可读、不完整、不支持和关闭。错误只发送分类，不发送原始解析错误或配置内容。单个模型、profile 或服务商错误只暂停对应项，其余有效项继续导入，来源显示“部分同步失败”，不展开原因明细；独立 profile 文件损坏不影响其他 profile。共享配置文件整体损坏或不可读时，暂停依赖该文件的全部项。

去重比较协议、URL、大小写敏感模型 ID、认证方式、密钥、大小写无关的 HTTP header 名及模型能力。只在内存比较凭据，不生成可外泄的凭据哈希。URL 使用标准 URL 序列化，保留路径、查询参数和尾斜杠差异。外部重复项在界面合并，但所有已发行的 provider 身份都保留为运行时别名；合并后再次分离时，原本独立的身份仍跟随各自来源。别名与来源槽位的关联持久化，不包含密钥，删除一个来源和服务重启后仍可解析历史身份。Pi 的可证明等价的字面 API 配置优先显示原生身份，外部别名保留在运行时以便已有引用继续解析；无法静态证明的原生认证/兼容设置保持独立。Pi 模型或凭据删除后，已确认的重复来源可通过 `model-source-alias.ts` 保留原 provider/model 身份：公开 SDK provider 注册将该模型请求转发至存活来源，清除原入口的认证请求选项，再由目标运行时解析认证。同服务商中未匹配的模型不会因此获得凭据。来源全失效时停止接收新请求；Pi 原配置恢复后撤销备用注册。

模型管理保留原生 Pi 文件编辑行为；外部同步条目每项对应一个模型，编辑生成独立副本，后续来源更新不覆盖。删除会抑制该入口所有已合并来源槽位；恢复同步清除删除墓碑，不覆盖仍存在的独立副本。来源文件始终只读。

## 执行边界

主聊天与独立 Wiki 客户端、SSH 节点绑定同一目录；子代理沿用父模型运行时。工具、扩展与 SSH 隔离不变。注册通过公开 registerProvider/setRuntimeApiKey，不把外部 apiKey 放入 SDK 命令解析字段；header 的 `$` 在注册边界转义为字面内容。

运行中的任务继续使用已应用的凭据和目录。准备发送时先等待串行同步，再持有准入租约；已进入 SDK 的任务以运行/恢复状态阻止更新，settled 后应用。来源的地址、协议、凭据和能力变更直接自动同步，无需确认；历史入口跟随来源更新，入口身份稳定不意味着底层连接不变。同步不自动替换会话所选模型。新请求发现入口已删除、来源关闭或配置损坏会提示选择其他模型；原生扩展命令在未配置模型时仍可运行。

## 验证

`tests/unit/model-sources.test.ts` 覆盖隔离发现、严格去重、来源删除与稳定身份、Pi 优先、原样密钥/header、不导入订阅、损坏配置、延后更新及独立副本。

`tests/model-sources-protocol-test.mjs` 自起隔离服务和本地模拟模型：没有 Pi 配置时自动发现、真实请求认证、执行中轮换、下一轮生效、WebSocket/日志/默认持久化不含密钥；`--browser` 检查模型管理和 390px 布局。

`tests/model-sources-test.mjs [appRoot]` 从指定生产目录加载适配器和 SDK。桌面发布工作流在 macOS、Windows、Linux 的解包应用中运行此脚本；本地运行不能替代其他操作系统的实际打包回归。测试环境公共辅助函数隔离外部 Agent 目录，避免现有冒烟读取开发者真实凭据。
