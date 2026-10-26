# Workspace 只读子代理

`server/subagents/` 提供可替换的原生 inline extension `pi-harness-subagents`。主模型通过 `subagent` 工具列出来源、分配任务并等待报告，随后自行串联业务流程与证据。实现参考 [pi-subagents 源码调研](subagents-research.md)，使用项目锁定的 Pi SDK，不增加 npm 依赖或 SDK 补丁。

## 使用

1. 在左栏 Workspace 中加入相关代码仓，并从其中一个项目发起对话。
2. 如需结合文档，通过现有「知识库」入口配置本地资料文件夹。
3. 在设置 → Extensions → 内置扩展中查看「Workspace 子代理」，默认开启。例如提问：

   > 退款流程是怎样的？

也可以直接问“这个项目的登录链路是怎样的？”、“修改会员等级会影响哪些地方？”或“文档说支持部分退款，实际代码实现了吗？”。用户无需提及子代理、点名仓库或预先知道问题跨仓。

开关开启时，原生工具的 description 和 promptGuidelines 指导主模型根据问题及对话语境自动判断：项目业务、架构、职责、接口、数据/状态流、原因排查、影响范围和实现/文档核对，在需要实质调查时先发现来源，再决定分工。判断来自本次主模型请求，不增加关键词分类器、额外分类请求或宿主自动续跑。

| 情况 | 默认处理 |
| --- | --- |
| 需要深入项目调查 | 默认每个 Workspace 仓库一个只读子代理，另加一个已配置知识库子代理，主模型综合依据 |
| 仓库职责不清楚 | 先小范围探查或安排发现任务，再确定深入分析的范围 |
| 已知文件的小问题、已有证据足够的追问 | 直接读取或回答 |
| 通用知识、闲聊 | 直接回答 |
| 用户限定来源或明确要求不用子代理 | 遵循用户限制 |

第二版补齐选仓依据和报告引用核验：仓库职责不清楚时，主模型可先用 `inspect` 读取选定来源的根目录、README 和项目清单摘要，再决定派工。子代理提交结构化报告，将代码实现、文档描述和推断分开；引用必须来自本次实际读到的完整行，并在提交时重新核对文件指纹。跨仓关联及实现/文档差异仍由主模型判断，须引用两侧依据，不能仅凭相同名称认定存在调用关系。

进入深入调查后，默认覆盖当前 Workspace 的每个仓库与已配置知识库，每个来源一个子代理；同一来源的多个任务合并。无关来源报告检查范围及未发现相关证据。用户明确限定来源或针对缺口补查时使用 `scope=selected`。知识库尚未配置时仍可分析代码。模型遵循规则的效果受所选模型影响，模拟测试只验证规则送达与调用链，不证明真实语义判断准确率。每个子代理沿用调用时父会话的模型、思考档位及凭据；它有独立上下文，主模型需要在 task 中给足问题背景。子代理分析会产生额外模型用量，工具结果逐项报告 token、缓存 token 与 cost；这些数值没有混入父会话 SDK 的上下文窗口统计。

## 来源与请求归属

`sources.ts` 读取现有 ProjectWorkspaceStore 和 KnowledgeLibrary：当前仓库、当前 Workspace 的项目，以及可用的全局知识库。最近使用项目不会自动变成来源。来源 ID 由类别和规范化根路径计算，同名文件夹仍能区分。目录失效保留到执行时报告失败，知识库不可用时不加入可读来源。

浏览器在点击发送时捕获本窗口的 Workspace ID，随 `prompt.target.workspaceId` 投递；发送回执指纹包含该字段。catalog 已加载时仅附带当前 cwd 所属的所选分组；尚未加载时保留捕获的 ID，由服务器按已登记来源最终校验，不能把未知成员关系当成不匹配。异步保存期间改选或其他标签页修改偏好不覆盖已捕获的目标。每个原生 SessionManager 的作用域由 `scope.ts` 管理：started 绑定，queued 仅保存原生转换后的文本与范围，实际 `message_start` 消费时才更新。排队或切换界面不改变正在执行的工具已经捕获的来源。原生 all 队列模式逐条消费消息，下一次模型请求使用最后消费的范围。撤回清除待发范围，settled 释放待发记录及事件订阅。

范围是运行时内存状态，不另行写入 transcript。历史恢复后下一次 WebUI 发送会重新绑定；无显式选择时仅能推断唯一所属分组，多组返回候选并要求工具调用明确 workspaceId，不合并所有分组。Wiki 专用窗口继续遵守现有文档/项目引用契约；本工具不把单文档引用扩展成任意 Workspace 授权。

每次工具调用重新校验来源；`run` 只接受当前可用的 sourceId。选择与工具调用已明确后，整个批次使用固定来源快照，后台其他对话不影响它。工具参数 workspaceId 也必须是当前 cwd 所属的登记分组。

## 工具与生命周期

`subagent` 是 `model-only`、`sequential` 工具，可被用户同名扩展替换，不嵌套进 Codemode。`sources` 只返回来源；`inspect` 接收当前来源内的 `sourceIds`，只执行受限本地读取，不创建模型会话、不消耗 child 数量预算；`run` 接收自包含 `question`（省略时取最近真实用户消息）和可选 `{sourceId, task}` 补充说明；默认 `scope=workspace` 按来源去重并分批覆盖，`scope=selected` 仅调查 tasks 中的来源。带补充说明的来源优先进入本批，避免说明在翻页时丢失。每批返回 `remainingSourceIds`，主模型用相同 question 继续调用直到为空；同一用户请求不重复派发已尝试来源，失败补查须显式 selected。主会话等待批次收尾，报告顺序与分配后的来源顺序一致，单项失败保留其他项。

`inspect.ts` 每次最多 8 个来源，每来源列根目录最多 60 项、读取最多 3 个简介文件，每文件最多 40 行/1800 字节摘要，返回的每来源 JSON 最多 8 KiB。优先 README、项目清单和 AGENTS.md；资料一律作为不可信证据，不执行其中指令。不支持的或未出现在有界目录清单中的简介不代表仓库与问题无关，缺失/不可读/截断明确报告，必要时再安排小范围调查。结果逐来源隔离，取消后不继续读取后续来源。

每个 child 使用进程内 `createAgentSession` 和内存 SessionManager，共享父 ModelRuntime；只注册 `source_list`、`source_search`、`source_read` 和只提交报告的 `source_report`。关闭扩展、技能、上下文文件、模板、主题、自动压缩、自动重试、provider 重试及缓存保温；不继承父 transcript、原生 bash/edit/write/MCP 或递归委派工具。原始资料作为证据读取，不自动执行仓库代码。子代理结果由主工具回到父会话，不额外安排后台总结请求。

运行限制集中在 runner / extension：每批最多 8 项，批内并发 3，服务级并发 6，等待槽上限 24；父请求累计最多 `max(12, 当前来源数 + 4)` 个 child，确保大 Workspace 可分批覆盖并留出补查预算；每 child 最多 32 次工具启动、16 轮、180 秒合作式超时。停止、会话 shutdown 和超时传递 AbortSignal；取消发生在原生认证 preflight 时，在 started/agent_start 再次传递 abort，避免 idle abort 被后续启动覆盖。完成以 `agent_settled` 和 prompt promise 为准，最后清理监听、定时器、slot 与 child session。超时依赖 SDK/provider 响应取消，并非独立进程强杀。

最终自由文本每项最多 12000 字符，截断显式标记；空回复且没有已接受的结构化报告、错误与取消不会标记完成。现有工具卡展示累计进度、结果与错误，报告随父工具结果保留。子会话 transcript 不写入用户会话目录，不提供后台恢复、单个 child 聊天窗口或代码写入。

## 进度与报告界面

沿用现有 `subagent` 工具卡，不增加子会话聊天窗口、后台任务或宿主总结请求。运行参数提供排队任务占位；`extension.ts` 在原有文本 fallback 外附 `details.subagents` 结构化快照，保留来源、根目录、任务、阶段和当前 source 工具。`runner.ts` 在 `tool_execution_end` 发出不带工具动作的更新，界面随即从「读取／搜索」转为「整理回答」，不残留上一个动作。

协议 v47 的 `tool_delta.subagents` 由 `server/subagent-presentation.ts` 白名单投影：最多 8 项，限制来源与任务字符串长度，过滤非法阶段和未知工具。`agent-service.ts` 只处理原生 `subagent` 工具，不透传任意扩展 details 或完整 `details.subagents`。前端普通文本增量保留同一 toolCallId 的最近进度，空数组可替换；只收到部分进度时仍显示剩余排队任务，同一 sourceId 的多个任务按任务序号合并。

`web/src/subagent-presentation.ts` 解析最终 `toolResult.content` 的既有有界 JSON 投影（结果执行状态字段为 `status`，与实时进度的 `phase` 对应），`SubagentToolOutput.tsx` 按来源展开摘要、finding 类型、引用原文、关联、待确认问题、用量和警告。首份报告及失败／取消项默认展开；部分失败保留其他报告，原始参数和输出仍可查看。`sources`、`inspect`、非法或不兼容的历史数据回退通用 JSON 工具卡。来源标题的完成只表示执行结束；报告内单独显示引用核验，并直接可见「只核对原文及指纹，不代表结论正确」的边界说明，而非仅提供悬停提示。摘要与证据先于根目录、核验时间和用量等元数据。

## 结构化报告与引用核验

`report.ts` 在工具实际返回的文本上建立有界证据记录。证据 ID 绑定来源、相对路径与内容 SHA-256；只登记已经输出的行，不把内部加载但被行数/字节上限截掉的内容视为已读。搜索的行片段和过长行明确标为不完整，不能用作完整行引用；可重新读取完整行后再提交。

`source_report` 接收 summary、findings、connections 和 openQuestions。每条 finding 明确属于 implementation、documentation 或 inference，包含 evidenceId 和起止行号。服务端拒绝未知证据、未读行、不完整行和伪造的路径/摘录，并通过原先固定根目录的读取器回读引用文件、比较指纹。修改、删除、符号链接替换或来源根替换均不能沿用旧引用。失败后模型可在既有预算内修正，后一次失败的提交会清除前一次成功报告。

每份报告最多 8 条 finding，每条最多 3 个引用，每个引用最多 100 行，含真实摘录的完整 JSON 最多 24 KiB。无证据时允许空 findings 并保留缺口说明。接受的报告带 checkedAt；`evidenceStatus=checked` 仅表示结构化报告的引用文本在该时间核验通过，**不证明结论正确、跨仓关系成立、自由文本回复均有依据或文件此后未变**。没有提交有效报告或没有引用的结果标为 unverified 并给出说明，宿主不为补报告自动追加模型请求。

`results.ts` 将批次返回主模型的紧凑 JSON 控制在 60 KiB 内（另预留 Workspace 信息空间），保留每个来源的身份、状态与用量。各来源共享总预算，没有单来源证据配额；总量未超限时完整保留报告及证据，仅限制重复 task 的回显长度。超限时先遍历各来源缩短非证据文本；仍超限才整条移除 finding，保留的引用及摘录不裁切，并返回 omittedFindings 等计数和显式警告。全部引用被省略时降为 unverified。完整有界结果保存在原生 tool details 中；浏览器现有工具卡显示投影后的内容，不新增完整报告下载入口。

## 文件读取

每个工具固定一个 canonical root，参数仅接受源内相对路径，逐级检查并拒绝符号链接、越界路径及依赖/生成目录。读取用文件句柄验证 inode/device、文件类型与上限，返回相对路径、原文行号和 SHA-256。搜索使用现有 bundled ripgrep，不运行 shell、不跟随符号链接；rg 只提供候选位置，命中文本必须重新通过受限读取校验。

单文件上限 1 MiB，单次输出 24 KiB；读取最多 300 行、列表 200 项、搜索 100 项且最多 5 秒。截断和跳过明确报告。这是特定工具的文件访问约束，不是操作系统沙箱；对同一用户恶意并发替换目录不提供内核级隔离。仅阅读磁盘文本、代码和 Markdown；编辑器未保存草稿、媒体内容和 PDF 解析不自动进入子上下文。引用仍需主模型核实，模拟模型测试不证明真实业务问答质量。

## 配置与验证

`<dataDir>/subagents.json` 保存独立全局 enabled，缺省 true。设置页通过每条内置扩展的 settingsVersion 做版本校验；关闭立即拒绝后续工具调用，已开始批次继续由原取消信号管理。关闭状态下创建的会话，重新开启后需重载或新建会话以恢复工具曝光；原生工具过滤和第三方同名工具优先。

原生过滤读取合并配置 `getSettings().defaultTools`，保留原始 allowlist 与 `+/-` 顺序；空数组、未包含 subagent 的 allowlist 和精确 `-subagent` 会隐藏并拒绝该工具，只有 modifiers 且未排除时保留默认开启。创建与重载重新计算曝光，执行时再次校验；不会通过 SDK 扩展默认激活绕过过滤。Codemode only 模式下它仍为独立 model-only 工具，不变成可嵌套调用。

- `tests/unit/subagent-sources.test.ts`：Workspace 歧义、跨组限制、共享目录与知识库配置。
- `tests/unit/subagent-inspect.test.ts`：实际受限文件读取的来源简介、缺失/不可读、符号链接、取消和输出限额。
- `tests/unit/subagent-report.test.ts`、`subagent-results.test.ts`：未读行/伪造/截断/跨来源引用、文件与根目录变化、报告修正、无证据结果、取消及有界批次投影。
- `tests/unit/subagent-scope.test.ts`：原生文本转换、排队/撤回、初始同文竞态和多会话隔离。
- `tests/unit/subagent-read-tools.test.ts`：路径/符号链接限制、文本行号、取消与资源上限。
- `tests/unit/subagent-runner.test.ts`、`subagent-extension.test.ts`、`subagent-planning.test.ts`：并发、结果顺序、失败隔离、默认全 Workspace 一仓一代理、同仓任务合并、超 12 来源分页、明确限定范围、每条用户消息预算及关闭准入。
- `tests/unit/subagent-activation.test.ts`：真实 SDK 的原生工具过滤、重载、Codemode only、设置状态，以及仅在工具启用时注入研究指导。
- `tests/unit/subagent-wire.test.ts`、`subagent-ui-presentation.test.ts`：进度白名单与限额、运行参数和按序号合并、部分快照保留排队任务、报告／引用／用量投影及非法数据回退。
- `tests/subagents-test.mjs`：真实 SDK、WebSocket 及本地模拟模型的自然问题 sources → inspect → run → source_report 调用链、规则送达、默认覆盖全部来源、明确限定范围时未选来源不启动模型、直接回答无额外模型请求、跨仓和知识库引用、未核验退化、失败及取消；`--browser` 加测真实输入框的 Workspace 归属、结构化工具进度和结束动作清除、按来源报告与引用展开、原始 JSON、键盘、中英文、深色、窄屏、200% 缩放等效视口及减少动态效果。模拟模型按固定脚本选工具，不评估语义判断、来源选择或文档差异分析质量。
- `tests/builtin-extensions-test.mjs --browser`：内置清单、跨客户端开关、版本冲突、中英文和窄屏。
