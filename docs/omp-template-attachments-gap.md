# OMP 模板与附件的输入边界

状态：2026-11-15，OMP 18.20.0。模板参数改变附件连续空格的缺口已修复，原生及浏览器回归通过；Windows/Linux 真机与正式包仍待验收。

另一个可执行命令边界：宿主向不带参数的 `/命令名` 直接追加换行附件时，OMP 按首个空格解析的命令名会包含附件头，错误地进入模型调用。真实回执夹具复现一次模型请求且扩展未执行；宿主现仅在无空白的完整命令名后追加文本附件时补上参数分隔空格。附件正文、有参数输入、无附件输入以及原本包含换行／Tab 的输入不重写，也不解析附件正文里的命令。`omp-command-receipts-test.mjs --browser` 验证实际扩展收到正文且模型请求为零，单测覆盖拼接边界；原生模板、输入钩子和队列回归继续保留。

## 故障与修复

原故障由 `node tests/current-file-protocol-test.mjs` 复现：`/fixture-review "one two" three` 携带 Markdown 附件，文件中的 `const s = "a  b";` 被当成模板参数解析，连续空格和引号发生变化。原有保真断言保留，修复后通过。模板名避开 OMP 内置 `/review`，不以覆盖内置命令的方式测试。

`server/omp/rpc-session.ts` 为原生 `runRpcMode` 提供公开会话接口的转发视图。所有 getter、setter 和方法均在原始 SDK 实例执行，实例、原型和 node_modules 均不修改；只有 RPC 最终调用 `prompt` 时，对完整宿主附件块做参数分离。输入钩子、技能和内置命令在到达这个边界前仍由原生 RPC 分派，准入、扩展发起消息的完成跟踪、停止和稳定结束也沿用原实现。

适配器先检查同名可执行扩展、自定义 TypeScript/MCP 命令，交给原生处理；随后使用公开 `slashCommands`、`promptTemplates` 和原生 `expandSlashCommand`、`expandPromptTemplate` 按原顺序展开问题正文，再附回附件，以公开的 `expandPromptTemplates:false` 调用原实例。展开生成的斜杠正文不会再次执行命令。没有附件、未命中文件命令／模板或已关闭展开时直接转发。可执行自定义命令仍自行决定返回什么，宿主不向其结果强行追加附件。

这避免了在 RPC 前预展开导致输入钩子观察错误正文或执行两次的问题，也不需要复制 RPC 的私有输入分派、票据或队列实现。模板原生历史保存展开后的正文，编辑器沿用这一行为；技能原始调用草稿则使用原生 custom_message 详情恢复。

## 原生行为对照

- 空格触发模板名／参数分隔，换行、Tab、CRLF 不替代空格。公共回归先运行同一条不带附件的原生调用，再逐项比较带附件结果，不保留旧 Pi 的不同分隔语义。
- 普通发送和 follow-up 保留测试文件中的连续空格、引号、Tab、换行、CRLF 和模板样式文本，附件不会重复追加。
- OMP 原生 steer 的用户插队提示会把提供给模型的 CRLF 归一化为 LF。测试先采集不带模板的原生 steer，再比较模板 steer 的附件段完全相同；两者历史卡片均回读到原始 CRLF。不能把原生插队格式化描述成请求字节完全不变。
- 公共测试等待本次唯一回复标记和最新空闲状态；仅等待旧快照中的 isStreaming=false 会把下一条误发成插队，不能用该竞态判断模板输出。

## 验证

`npm run build` 后执行：

```sh
node tests/omp-template-attachments-test.mjs
node tests/current-file-protocol-test.mjs --browser
node tests/omp-attachments-browser-test.mjs --template
node tests/omp-skill-history-test.mjs
```

本地真实 OMP 和本地模型协议覆盖：普通模板／无参数模板、文件命令再展开模板、扩展／自定义／内置命令优先级、输入钩子只执行一次及变换／处理／挂起、生成斜杠不执行、扩展发起模型工作的完成、排队撤回与实际 follow-up／steer、停止重开、删除源文件后的冻结重问和准入前停止。浏览器实际操作卡片、编辑器、提交和刷新。专项加入 smoke、Mac/Windows 浏览器 CI 和三平台源码／包内门禁，门禁配置不代表远程真机已执行。

Task 内部历史保护、其余公共宿主迁移、Windows 原 DeepSeek 故障和三平台包验收仍未完成，不能据本项通过宣称全面迁移或原模型故障已经解决。
