# Pi 1.2.0 → 1.4.0 升级

pi-harness 的 `@earendil-works/pi-coding-agent` 与 `@earendil-works/pi-ai` 精确锁定 1.4.0，保持原版 SDK、Node >=22.19.0。SDK 升级最初在应用 1.4.1／协议 v43 上验证；现随应用 1.5.0 发布，并因发送回执升级至协议 v44。应用版本与内核版本是两条独立版本线，不修改真实用户配置或历史会话。

上游正式发布顺序为 [1.2.0](https://github.com/earendil-works/pi/releases/tag/v1.2.0) → [1.3.0](https://github.com/earendil-works/pi/releases/tag/v1.3.0) → [1.4.0](https://github.com/earendil-works/pi/releases/tag/v1.4.0)，中间没有 1.2.x 补丁版。以下是集成映射；“随 SDK”表示采用上游实现，不代表已经连接真实服务商逐一验证。

## 1.3.0 更新映射

| 上游变化 | pi-harness 处理 |
| --- | --- |
| Pi 内部包精确锁版 | lockfile 中七个 Pi 包（含 telemetry）统一为 1.4.0 |
| 提示词模板保留空引号参数，避免位置参数错位 | 更新内部适配器版本保护；测试单／双引号空参数、位置默认值及附件原文 |
| 恢复 transcript 中的活动工具并应用默认工具增减项 | 随 SDK；验证已记录的禁用工具、已发现 MCP 工具在恢复后保留 |
| Codemode 取消／超时以及残留 worker 上限 | 随 SDK；结合 1.4 排队回归验证资源释放 |
| Kimi Code 切换 Chat Completions，动态增加工具保留缓存 | 随 SDK；自定义配置迁移说明见下文 |
| 模型切换丢弃其他模型的历史 thinking；GPT-6 API key 模式切换思考档位保留缓存 | 随 SDK；宿主继续保存原始历史，仅原生请求投影变化 |
| 多 provider 模型匹配优先凭据，模糊匹配歧义提示 | 随 SDK；Web 模型选择继续使用 provider/id |
| 工具参数中的无效 Unicode 转义、最终畸形 JSON 校验 | 随 SDK；不在宿主重新解析或修复模型工具参数 |
| Anthropic/Bedrock 错误工具结果含图片导致 400 | 随 SDK 的请求转换 |
| OpenCode Go Gemini、MiniMax 协议及端点修复 | 随 SDK 模型目录和适配器 |
| 网关 upstream stream、暂时不可用重试 | 随 SDK；会话重试开关仍由原生 getter 读取 |
| 同一流片段含 reasoning/content 时输出顺序 | 随 SDK 流式事件 |
| Gemini 4 Argon、MiMo、Haiku/Opus 思考档位修复 | 使用 SDK 可用档位；保留 Web 四档菜单的映射 |
| openai-codex 上下文窗口修正 | 内核获得修复；保留既有目录过滤策略，不主动切换历史模型 |
| read 行号标签修复 | 上游 TUI/导出渲染修复；Web 保持自己的展示 |
| sessionShareDestination、overlay 关闭归属、Nix 构建与 PATH | CLI/TUI/Nix 专属；本次不增加分享上传入口或移植终端组件 |

## 1.4.0 更新映射

| 上游变化 | pi-harness 处理 |
| --- | --- |
| classifier 图片输入、新模型与 Workers AI 定价 | 原生 `models.classify()` 获得能力；实际 Codemode 测试图片透传和卡片完成状态 |
| provider/classifier `compat`、imageInput、sendImageOptInHeader | 模型表单保存保留这些字段和非聊天模型；不增加分类器配置页 |
| models.json schema 说明及生成的参考文档 | 随包更新；编辑器保留 `$schema`、未知字段 |
| 压缩／分支摘要改用模型输出上限，reserveTokens 只影响压缩触发 | 随 SDK；不在宿主增加摘要输出限制 |
| Codemode worker 繁忙时排队，PI_CODEMODE_MAX_WORKERS | 随 SDK；新增跨会话排队和取消回归，环境变量见 env-vars.md |
| provider attribution headers 来自 pi-ai client identity | 随 SDK；宿主不重建这些头，不向浏览器下发凭据头 |
| MiniMax M3.1 Flash、Copilot/NVIDIA/Xiaomi 默认模型、Grok xhigh | 随 SDK 目录和可用思考档位 |
| ChatGPT Business 用量限制不重试 | 随 SDK；保留原生错误信息 |
| mcp.json 带 UTF-8 BOM | 同步修复 Web 设置服务的读取、保存及项目继承解析 |
| 扩展导入 pi-ai/models | 随 SDK 扩展加载器 |
| /compact 指令传递到被拆分轮次的摘要 | 随 SDK；不拦截或重写原生摘要指令 |
| 恢复／树导航时迟注册扩展工具激活 | 随 SDK；宿主 plan 开关仍在导航后协调 |
| 输出截断恢复时工具调用与结果成对移除 | 随 SDK；宿主不改写 transcript |
| grep 忽略 RIPGREP_CONFIG_PATH | 随 SDK 原生工具；Web 代码搜索是独立实现 |
| Windows Store shell alias、PowerShell 和非 C 盘系统检测 | 随 SDK；Windows 真机验证由桌面 CI 承担 |
| Copilot 大请求 413、空白工具输出导致 provider 400 | 随 SDK 请求／错误处理 |
| 网关错误、代理断流、Vertex OAuth 暂时失败的重试匹配 | 随 SDK；不增加宿主重试循环 |
| OpenAI Responses deferred tools 缓存、openai-codex 无效模型 | 随 SDK；现有 provider 目录过滤保持不变 |
| Rex、终端退出恢复、并发 TUI 对话框、Linux 剪贴板、@ 补全 | 终端 UI 专属；Web 对话框与文件搜索继续使用自己的实现 |
| CJK Markdown 强调、未关闭数学块影响表格、HTML 导出 | 上游渲染修复；Web React Markdown 不直接使用该渲染器 |
| managed-install.json BOM 更新修复 | 原生 CLI 更新器；不改变桌面应用更新流程 |

## 接入契约和配置迁移

- 实际 npm 包比较：`system-prompt.js`、`mcp-servers.js` 与 1.2.0 一致；`prompt-templates.js` 新增空 token 跟踪。两个精确版本保护更新到 1.4.0，模板加载失败仍拒绝投递并保留草稿；提示词全文不匹配时仍只读展示。
- MCP 解析只剥离开头 BOM；版本 hash 使用原始文本。全局配置、项目覆盖、继承的 autoEnableCodemode 和保存前旧文档均支持 BOM。保存输出标准 UTF-8 JSON，保留未知字段和掩码对应的原始密钥。
- Kimi Code 默认端点是 `https://api.kimi.com/coding/v1`，使用 `openai-completions`。已在 models.json 覆盖 `kimi-coding.baseUrl` 的用户，需要自行确认地址包含 `/v1`；显式覆盖旧协议的配置也需要核对。第三方代理路径及协议由代理契约决定，升级不会猜测或自动改写。
- 会话恢复使用 transcript 已记录的工具集。仅调用 setActiveToolsByName 而尚未发起下一次请求的内存修改，不保证已记入 transcript；回归先投递请求，再恢复并断言工具集。
- 原生 defaultTools、模型过滤、plan 开关、SSH 工具隔离和 agent_settled 生命周期保持宿主现有契约。无新增公共类型、HTTP/WS 消息或协议版本变化。

## 验证记录（2026-10-22，macOS arm64）

验证使用隔离目录和本地模拟服务，无真实模型费用，不证明所有服务商线上账号可用性。

| 检查 | 结果 |
| --- | --- |
| lockfile、协议、测试环境、typecheck、build | 全部通过；协议保持 v43 |
| npm test | 124 个文件通过，739 项通过、1 项跳过 |
| 完整零 token 冒烟 | 原清单 86/86 通过 |
| 新增及最终修改的专项 | pi-140-sdk、native-tools-desktop、model-config-preservation 3/3 通过；新专项已加入默认冒烟清单 |
| 附件、系统提示词、MCP 浏览器回归 | 三项 --browser 均通过 |
| 模型设置浏览器回归 | 模型读写、中英文、窄屏及缩放布局全部通过；移除测试中已失效的旧 Workspace 导航步骤 |
| macOS arm64 本地目录打包 | electron-builder --mac --dir --publish never 成功 |
| 包内服务及原生工具 | packaged-server-start、native-tools-desktop 通过；codesign --verify --deep --strict 通过 |
| Windows/Linux 打包 | 本机未执行；现有三平台 CI 继续运行同一原生工具契约测试 |

专项覆盖：

- `pi-140-sdk-test.mjs`：四个真实会话争用两个 worker，验证排队、取消不执行、释放后复用、工具卡终态和 agent_settled；原生摘要不再由 reserveTokens 限制输出、拆分轮次保留自定义指令；真实恢复请求和重新打开后的上下文均无截断调用的孤立工具结果。
- `native-tools-desktop-test.mjs`：空参数模板、图片生成和分类透传、MCP 发现、reload、已记录工具集恢复、新注册扩展工具和 defaultActive:false。普通 Node、Electron Node 模式和本地打包产物均通过。
- `codemode-mcp-test.mjs --browser`：带 BOM 配置、只增加 BOM 的冲突版本、项目覆盖、秘密掩码、真实执行及设置界面。
- `model-config-preservation-test.mjs`：真实模型编辑服务读写保留 classifier/model/provider compat 及未知字段。

上述升级专项验证时，本地目录产物位于 `release/mac-arm64/pi.app`（gitignore），当时未发布安装包；后续 1.5.0 发布按 `docs/release.md` 的三平台流程执行，不重启用户本机服务。
