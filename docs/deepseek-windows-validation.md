# DeepSeek Windows 对照验证（尚未完成）

目前没有 Windows 原故障任务、Claude Code 请求或网关响应证据，不能确定根因。用户后续要求已改为全面迁移 OMP，输出额度采用 OMP 模型默认值；显式配置仍可覆盖。没有按猜测修改网关适配或原生历史回传。

## 本地事件与请求诊断

OMP 生产会话已接入 `model-diagnostics.ts` 的事件元数据记录。复读处理采用 OMP 原生 `ThinkingLoop` 错误标记，在 worker 内通过公开 API 撤回队列、中止运行，再关闭所属进程；没有把旧 Pi 的阈值检测器叠加到 OMP 上。原生 Loop Guard 的开启和正文检查设置仍然有效。

在 PowerShell 启动桌面程序前设置：

```powershell
$env:PI_WEB_MODEL_DIAGNOSTICS_DIR = "$env:LOCALAPPDATA\pi-harness-diagnostics"
# 完全退出旧桌面进程后，从此终端启动本次测试构建
```

启用后写两类 JSONL 文件，默认关闭、不上传：

- `model-events-*.jsonl`：宿主消费侧 SDK 事件、相对时间、分片字符数、停止原因、token 用量和原生复读中止标记。`scope` 区分普通聊天、Wiki、SSH 和 Playground。
- `provider-events-*.jsonl`：公开 `before_provider_request`／`after_provider_response` 扩展钩子的请求结构和响应状态，以及原生解析后的流式事件。记录实际请求中可识别的输出额度、thinking budget／effort、消息角色／块类型／数量、工具定义摘要和工具调用／结果关联。`runId` 与宿主日志关联，另有会话和代理匿名标识、主／子代理身份、观察顺序及线程位置。

请求原文、工具参数／定义正文、签名、模型 ID、服务商名和地址只保留使用本地密钥的 HMAC 摘要；响应 headers、request ID、正文和错误原文不记录。`.request-diagnostics-key` 是目录内的随机私有密钥，不能上传或纳入诊断附件；同目录复跑可比较摘要，换目录后摘要不可直接比较。摘要相同可以帮助定位结构差异，不代表能还原请求，也不替代人工记录模型 ID、网关和完整 schema。JSON 对象键顺序变化也可能改变摘要。

每个记录文件最多 8 MiB；provider 文件达到上限时追加 `diagnostics_limit`，数组裁剪有显式标记。宿主事件文件达到上限后尾部可能缺失。多次运行和 Task 会生成多个文件，目录累计空间不自动清理。同步写入和摘要计算会影响计时，对比时统一开启，并额外验证关闭后的表现；存储不可写时停止诊断，不中断任务。Windows 文件权限继承用户目录 ACL。

应用通过原生文件扩展覆盖普通会话、受限助手和 Task 子会话，不改模型输入或原生工具。OMP 18.20.0 SDK 嵌入模式按上游设计不启用 CLI 专用 Task 工作线程；真正的原生 CLI RPC 线程路径已有独立本地验证。九子任务的 CLI JSON/print 对照在启用／关闭诊断时均以事件循环提前退出报错，尚未修复，不能以 RPC 验证替代该模式的完成验收；见 [请求诊断记录](review-data/omp-request-diagnostics.json)。

这些是公开钩子观察点，不是网络抓包：后续扩展或 provider 的转换仍可能改变最终出站内容；响应／流式事件没有可靠的并行请求关联 ID，不以最近请求编号强行配对；目前不是原始 SSE。Anthropic messages 与 OpenAI completions 的真实本地请求已核对，Responses 结构仅有纯函数回归，其他协议不宣称等价覆盖。真实 Windows／网关以及原故障任务仍需执行下方对照。

OMP 原生复读错误的终态 content 为空，错误记录由原生 SessionManager 保存；宿主不补写失败思考、不改写原始历史。有效 thinking、签名和工具结果继续遵循 OMP 原生回传。复读中止是失败恢复，不是任务完成，也不能用其提前停止或隐藏失败内容证明 Windows 原问题已修复。

测试后关闭：

```powershell
Remove-Item Env:PI_WEB_MODEL_DIAGNOSTICS_DIR
```

## 待执行对照

在 Windows 记录各客户端版本、模型 ID、网关（移除查询参数及凭据）、协议、thinking/effort、实际输出额度和主/子任务身份。为 Claude Code、原生 OMP、OMP 版 pi-harness 准备相同项目副本与初始文件，原生 Pi 保留作旧故障基线，分别执行原故障任务、多轮工具任务、长历史继续，每项三次。每次记录：是否真正完成、首次工具耗时、总耗时、输入/输出 token、终止原因及实际可用的本地证据文件。

复读中止、额度截断均记失败，不自动重发。旧对话用编辑重问或分支恢复，保留原始记录。对首次不同请求补采经人工脱敏的网关请求与流式响应，核查 thinking 参数、工具 schema/参数分片/结束原因、历史工具结果配对。不得把正文工具描述执行为命令。

Windows 测试安装包须在 Windows 构建并执行桌面产物回归；当前本地 Mac 验证不替代此步骤，不进行正式发布。只有原故障任务正常完成及对照结果核对后，才能讨论已验证组合的修正与发布。

## OMP 本机初步试验（2026-11-14）

独立安装 OMP 18.20.0、Bun 1.4.4 至 `tests/scratch/omp-eval/`（gitignore），未更换项目依赖或全局 CLI。安装 lockfile 通过官方 HTTPS registry 检查。启动 `--help` 成功。

使用本机 Claude Code 配置中的网关与凭据（不输出密钥），显式指定 `deepseek-v4.1-flash`、Anthropic messages、medium thinking。模型配置声明 maxTokens=128000；尚未抓取出站请求，不能证明实际发送额度或网关执行了 thinking 参数。本机 Claude Code 同时配置 opus→GLM 别名，所以本次没有依赖其当前默认选择。

任务：读取 `[3,7,11]` 的 JSON 文件，写入求和结果，再读取核验。每次删除结果文件并新建进程启动，三次结果均为 21，退出码均为 0，墙钟耗时分别 4.64s、5.17s、4.50s。检查第一与第三次事件，均为 read→write→read，助手结束原因依次 toolUse→toolUse→toolUse→stop；第三次累计输出 221 tokens。

试验仅启用 read/write，禁用扩展、技能、规则、上下文文件、LSP 与标题生成，以建立最小真实工具链基线。没有测试默认完整工具集、Codemode、长历史、中止恢复、原故障任务或 Windows；没有做原生 Pi 同任务对照。因此只能证明这个本机组合可完成简单多轮工具调用，不能证明 OMP 比 Pi 稳定或已修复原 issue。首次工具时间未采集。

本地复跑脚本为 `tests/scratch/omp-eval/run.py`，只适用于当前 Mac 配置；原始合成任务事件与配置留在忽略入库目录，凭据通过子进程环境传递。请勿将该目录打包上传。Windows 下一步须使用原故障模型 ID 与任务重复验证，不能用本机模型代替。
