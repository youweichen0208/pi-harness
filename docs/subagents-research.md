# 内置跨仓库与知识库子代理：源码调研

调研日期：2026-10-25。参考 `nicobailon/pi-subagents` 的 `main`，固定快照为 [`4f2a9892e6933fc4413c24577ab08be9478d9e7e`](https://github.com/nicobailon/pi-subagents/tree/4f2a9892e6933fc4413c24577ab08be9478d9e7e)，该快照包版本为 0.82.0。以下区分上游已有实现和适合 pi-harness 的建议；没有调用真实模型，也没有完成业务回答质量评测。

## 上游实现中值得借鉴的部分

| 主题 | 源码确认的行为 | 对本项目的含义 |
| --- | --- | --- |
| 子会话 | 前台子代理是进程内 `createAgentSession`；后台由独立 runner 进程持有相同的 Pi 会话。每个 child 独立 SessionManager、cwd、工具集、资源加载器和任务。 | Web 服务已经嵌入 SDK，先做进程内前台分析即可，无须安装或启动另一个 Pi CLI。 |
| 上下文 | 支持 `fresh` 与 `fork`。缺省最终回到 fresh；fork 复制父会话分支，需要处理父会话文件、leaf、cwd 和 thinking block。 | 对不同仓库的专项查证，使用 fresh 加明确任务，避免复制整段父历史和其他仓库的无关内容。 |
| 并发 | `Semaphore` 与 `mapConcurrent` 分离活动并发限制和结果顺序；全局并发是一次 run 内的限制。 | 必须另有 harness 进程级并发限制，否则多个浏览器对话可一起放大模型请求数。 |
| 工具范围 | child 的 `tools` 是完整允许列表，`excludeTools` 再缩小；缺失的必要工具会导致启动失败。MCP、动态扩展和嵌套委派均有单独处理。 | 首期只开放受范围约束的本地读取和搜索，不继承父会话所有工具。 |
| 生命周期 | `agent_end` 不能用于最终完成；`agent_settled`、压缩重试和 prompt promise 共同参与收尾。取消传递到启动等待和 child.abort，清理时发 session_shutdown 再 dispose。 | 主工具必须等待所有 child 收尾；停止父任务时取消尚未开始及正在运行的 children，不能留下静默后台工作。 |
| 预算 | 活动并发、每次 run 累计创建量、父 session 累计创建量、工具调用量、reported token/cost 是不同维度。run 累计预算默认 64，不因 child 完成而返还。 | 只设“最多同时 3 个”仍允许模型不断创建新子任务；需要每轮累计上限。 |
| 输出与费用 | 收集 message_end 的 input/output/cache/cost，结束时用持久消息核对；事件和完整产物与返回父模型的受限摘要分开。 | 父模型接收有界结论和证据，界面保留每个 child 的状态、错误和用量，避免把所有子 transcript 填进主上下文。 |

一手来源：会话创建与清理见 [child-session.ts](https://github.com/nicobailon/pi-subagents/blob/4f2a9892e6933fc4413c24577ab08be9478d9e7e/src/runs/shared/child-session.ts#L460-L710)；上下文见 [fork-context.ts](https://github.com/nicobailon/pi-subagents/blob/4f2a9892e6933fc4413c24577ab08be9478d9e7e/src/shared/fork-context.ts#L1-L95)；并发见 [parallel-utils.ts](https://github.com/nicobailon/pi-subagents/blob/4f2a9892e6933fc4413c24577ab08be9478d9e7e/src/runs/shared/parallel-utils.ts#L159-L242)；工具规划见 [child-tool-plan.ts](https://github.com/nicobailon/pi-subagents/blob/4f2a9892e6933fc4413c24577ab08be9478d9e7e/src/runs/shared/child-tool-plan.ts#L209-L218)。

生命周期与取消来源：[child-lifecycle.ts](https://github.com/nicobailon/pi-subagents/blob/4f2a9892e6933fc4413c24577ab08be9478d9e7e/src/runs/shared/child-lifecycle.ts)、[execution.ts](https://github.com/nicobailon/pi-subagents/blob/4f2a9892e6933fc4413c24577ab08be9478d9e7e/src/runs/foreground/execution.ts#L1003-L1142)。预算与费用来源：[run-fanout-budget.ts](https://github.com/nicobailon/pi-subagents/blob/4f2a9892e6933fc4413c24577ab08be9478d9e7e/src/runs/shared/run-fanout-budget.ts)、[usage-budget.ts](https://github.com/nicobailon/pi-subagents/blob/4f2a9892e6933fc4413c24577ab08be9478d9e7e/src/runs/shared/usage-budget.ts)、[usage-reconciliation.ts](https://github.com/nicobailon/pi-subagents/blob/4f2a9892e6933fc4413c24577ab08be9478d9e7e/src/runs/shared/usage-reconciliation.ts)、[配置中的各层限制](https://github.com/nicobailon/pi-subagents/blob/4f2a9892e6933fc4413c24577ab08be9478d9e7e/docs/configuration.md#globalconcurrencylimit)。

上游默认允许主会话 → 子代理 → 孙代理两层嵌套，但只有明确获得 `subagent` 工具的 child 才能继续分派；子级配置只能收紧继承限制。对于“每个仓库一个研究员，再由主会话串联”的需求，一层已经足够。[上游递归契约](https://github.com/nicobailon/pi-subagents/blob/4f2a9892e6933fc4413c24577ab08be9478d9e7e/docs/workflows.md#recursion-guard)

## 与锁定 SDK 1.4.0 的兼容结论

上游 README 声明最低 Pi 1.2.0；其当前开发依赖仍精确使用 1.2.0，peer 中 `pi-ai` 为 `>=1.2.0`。这能说明 API 基线，不能代替本项目在 1.4.0 上的集成验证。[上游 package.json](https://github.com/nicobailon/pi-subagents/blob/4f2a9892e6933fc4413c24577ab08be9478d9e7e/package.json)、[上游 README](https://github.com/nicobailon/pi-subagents/blob/4f2a9892e6933fc4413c24577ab08be9478d9e7e/README.md)

本地已安装的 1.4.0 声明与上游 v1.4.0 源码均有 `createAgentSession`、`ModelRuntime`、`SessionManager.inMemory`、显式 model/thinkingLevel/tools/customTools/resourceLoader 和 `agent_settled`。可以不改 SDK、不升级依赖实现最小方案。[SDK v1.4.0 创建参数](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/src/core/sdk.ts#L48-L110)、[SDK settled 发射位置](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/src/core/agent-session.ts#L1060-L1090)、[本项目升级契约](pi-1.4-upgrade.md)

需要注意三个实际边界：

1. `cwd` 只是工作目录和资源发现起点。原生路径工具明确支持绝对路径和 `~`，并不限制读取根目录；仅写“只读当前仓库”到提示词不构成范围约束。必须在实际文件操作中校验规范化路径与 `realpath`，并约束搜索中的符号链接行为。[SDK 原生路径解析](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/src/core/tools/path-utils.ts#L43-L57)
2. 上游为 ambient extensions、MCP、进程环境、扩展模块缓存和父 provider 注册表做了大量兼容处理。pi-harness 的专项只读 child 可以直接共享父 `ModelRuntime`，明确传递父会话当前 model/thinkingLevel，禁用 ambient extensions/skills/prompt templates/context files，并显式提供系统提示词及空 `appendSystemPrompt`，避免重新发现另一套默认模型或提示词。保留原生认证与网络初始化，不复制密钥。[上游资源与模型装配](https://github.com/nicobailon/pi-subagents/blob/4f2a9892e6933fc4413c24577ab08be9478d9e7e/src/runs/shared/child-session.ts#L484-L617)
3. reported usage 是服务商回报的计量，费用可能缺失或目录价格为零；不能声称是实时账单或绝对不会超额的硬预付费限制。时间、轮次、工具次数和累计启动量可以先做确定性边界。[上游 usage 计量来源](https://github.com/nicobailon/pi-subagents/blob/4f2a9892e6933fc4413c24577ab08be9478d9e7e/src/runs/shared/usage-budget.ts#L44-L58)

本项目的 [context-eval/session.mjs](../dev/context-eval/session.mjs) 已有真实 SDK 的 fresh 只读会话、范围守卫、settled 等待和清理范例。但评测先将材料复制进隔离目录；原始工作区可能有符号链接，因此不能原样照搬它的路径守卫后就宣称完成了文件范围隔离。

最小 child 的内存设置还应显式设 `cacheWarming: "off"`；1.4.0 的默认值是 `streaming`，保温器可能单独调用模型。若契约是不自动重试，也需同时设 `retry.enabled: false` 和 `retry.provider.maxRetries: 0`，两层重试分别读取。[SDK 默认设置](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/src/core/settings-defaults.ts)、[SDK 缓存保温器](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/src/core/cache-warmer.ts)、[SDK 请求选项](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/src/core/sdk.ts)

## 适合本次需求的最小内置方案

以下是设计建议，具体上线契约以实现文档为准。

主会话通过原生扩展注册一个“工作区研究”能力：先获得当前 Workspace 中可用项目和已配置知识库的来源列表，按问题拆成若干明确子任务，再显式调用工具。工具把任务分派给 fresh 子会话；每个 child 只负责一个来源。所有结果返回同一主会话，由主会话比较接口、调用链、业务术语和文档约定，并给出综合回答。不增加路由分类器模型调用或后台自动续跑。

来源复用已有 Workspace 项目登记与知识库根配置。项目和知识库使用稳定来源 ID、名称、类别、真实根目录；子任务选择来源 ID，由服务器解析根目录，不能让模型自行传任意 cwd。知识库未配置时明确显示不可用。知识库读取使用原文件，保持现有 Wiki 编辑与导航路径边界；不借此扩大 Wiki HTTP API 的范围。[现有知识库配置](architecture-wiki.md)、[工程上下文来源与证据要求](engineering-context.md#来源与证据契约)

每个 child 获得用户问题、明确调查角度和一份来源信息；允许受范围约束的列目录、查文件、内容搜索、按行读取，不提供 bash、edit、write、MCP、Codemode、网络请求或递归分派工具。共享父模型与思考档位；子输出至少包含“结论、文件及行号、跨仓接口线索、缺口/冲突”。父会话需要更多信息时可再次发起有界查证，不让 child 互相自由聊天。

建议初始限制为最多 3 个活动 child、单次调用最多 6 个任务，并设置单个父请求的累计任务上限及单 child 超时/工具次数上限；这些数值属于可调整的产品取舍，不是上游默认值。创建失败和一个 child 的资料不足不能丢掉其他已经完成的证据。取消父任务或释放父会话时取消整个任务组，返回清晰的 completed/failed/cancelled/timed-out 状态。

先复用工具卡展示子任务名称、来源、运行状态、耗时、用量和有限摘要，主模型只接收受长度限制的调查结论与引用。完整子轨迹是否持久化应独立确定；若第一版只保留内存状态，要明确刷新后只能恢复父工具结果、不能继续附着原来的 child。用户的问题可能只涉及一个文件，不应强制每次启动全体来源的 agents。

该方案沿用“先验证原生查证收益”的工程上下文方向，不引入 OpenViking、向量库、自动记忆、定时任务、跨设备 runner 或写代码 worktree。多代理会增加模型调用次数；应使用相同业务题比较单会话基线和分工方案的依据覆盖、冲突识别、正确性、耗时及报告用量，不能仅凭并行成功就宣称答案质量提升。[本项目验证原则](engineering-context.md#第一阶段可复现的验证)

## 最低回归范围

- 使用本地模拟模型证明多个独立 children 的确并发，并继承父会话选定模型与思考档位；不发送真实业务代码到测试模型。
- 验证 child 看不到主会话历史、其他子任务 transcript、写入工具、默认 MCP 与 ambient extensions；同名文件仍能追溯到正确来源。
- 验证 `../`、绝对路径、`~`、指向范围外的符号链接及恶意搜索输入不会越界；目录/文件变化按真实失败返回。
- 验证父取消在排队、创建中、模型流式中和工具读取中均释放 child；压缩/重试中出现 agent_end 不应过早完成，最终以 settled 收尾。
- 验证单 child 失败、超时、超输出和累计预算耗尽保留其他结果，状态与 reported usage 不误记为全部成功；引用能回读到对应来源原文。

本调研只借鉴上游架构，没有复制上游实现；若后续复制源码，应保留其 MIT 授权所需声明。[上游许可证](https://github.com/nicobailon/pi-subagents/blob/4f2a9892e6933fc4413c24577ab08be9478d9e7e/LICENSE)
