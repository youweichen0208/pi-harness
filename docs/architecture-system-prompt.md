# 原生系统提示词设置

## OMP 入口（2026-11-15）

主聊天和 Wiki 设置已使用 `OmpPromptPanel`、`server/omp/prompt-control.ts`。下面的 Pi 1.5.2 分段与 APPEND_SYSTEM 说明仅供旧实现参考，不能用作 OMP 的优先级或来源事实。

OMP 页面直接展示公开 `session.systemPrompt` 的完整块；上下文来源使用 `systemPromptSources` 和原生 `claimPromptSources`，只标记仍与实际块匹配的来源。不会重新拼装、猜测或覆盖原生提示词。`discoverSystemPromptOverride` 决定磁盘选择：界面明确区分磁盘选中的文件与实际加载的上下文及全文，文件保存并不代表已生效。

编辑目标由服务端限定：独立 agent 目录及项目 `.omp/` 中的 `SYSTEM.md` / `SYSTEM_TEMPLATE.md`、原生选中的其他来源、已加载上下文文件和当前 cwd 的 `AGENTS.md`。浏览器只提交不透明文件 ID。单文件 512 KiB，严格 UTF-8；拒绝文件和目录符号链接、非普通文件，版本包括固定路径与原始内容，原生跨进程文件锁内重新校验，随机临时文件原子替换并保留权限。可删除系统提示词或模板，不能在此删除上下文文件；删除后由原生发现决定回退来源。

保存与重载分开：保存只落盘，页面提示待重载。显式重载调用 OMP 公开 `refreshSkillsAndCommands`，它重建提示词并重新发现上下文；不调用模型、不重写 transcript，也不切换会话身份。其他会话保持独立，需各自重载或重新打开。运行中、压缩/重试中及 Stop 后的待写操作被拒绝；失败保留编辑草稿，文件冲突需重新读取。当前实现不提供旧 Pi 的运行中保存后自动重载队列。

HTTP `/api/system-prompt` 使用 OMP 的 get/read/save/delete/reload 操作，校验 Origin、JSON、客户端、工作区、对话与导航归属。受限 SSH/Playground 会话拒绝管理。get/read/save 不会隐式打开已停止 worker，只有显式 reload 可重新打开。界面切页、关闭和离开浏览器时保护草稿；元数据刷新不覆盖草稿，迟到回复不进入新对话。

HTTP 宿主契约由 `tests/system-prompt-test.mjs` 验证：鉴权、Origin、JSON、客户端／对话／工作区归属、不透明文件 ID、冲突、运行中及停止后拒绝写入、保存后下一次请求仍使用旧提示词、显式重载后实际出站内容与原始历史保留、扩展临时覆盖与下一次原生准备恢复。历史文件名保留在全量冒烟中，已不再要求 Pi APPEND_SYSTEM 或自动重载。`--browser` 串行运行同一 HTTP 回归与 OMP 浏览器专项。

真实 SDK 与浏览器/打包 Electron 回归分别在 `tests/omp-prompt-test.mjs` 和 `tests/omp-prompt-browser-test.mjs`；旧 Pi 专用测试不证明 OMP 行为。

## 旧 Pi 实现参考

设置 → 系统提示词对应设置 v2 设计。WebUI 读取当前会话的 Pi 1.5.2 提示词，提供原生文件编辑器；不保存一套 WebUI 提示词，也不向模型添加消息。

## 展示与来源

- `system-prompt-view.ts` 是锁定版本的只读适配器。SDK 暂无公开的结构化 prompt getter，因此读取当前运行／基础构建参数，调用 SDK 自己的 `buildSystemPromptSections()`。生成全文必须与公开 `session.systemPrompt` 完全一致，版本不符或无法匹配时退化为只读全文。
- 不修改 SDK 内部字段、不执行扩展回调来推测提示词。升级 SDK 必须验证适配器与原生上下文回归。
- 身份、工具、规则、文档、追加、项目上下文按原生顺序排列。技能、cwd 隐藏于分段界面，全文与复制仍完整包含。额外原生 section 保留只读展示。
- Pi 1.0.4 起的 `hiddenTools` 从工具声明和规则来源中排除；仍通过隐藏 read/bash 可访问的技能由 SDK 保留。
- 规则默认收起，展开时按来源分组，组内保留原文与原生去重顺序，标记内置、工具或扩展来源。SDK 不提供逐个扩展的规则归属，界面统一标为扩展，不能猜测扩展名称。
- `forceSystemPrompt` 有效期间显示只读全文，禁用文件编辑。SDK 在任务结束后恢复基础提示词，页面相应恢复。Token 是字符粗估，不是模型计费数。

## 文件和优先级

`system-prompt-files.ts` 从 ResourceLoader 的实际来源读取文件信息。SYSTEM.md / APPEND_SYSTEM.md 各提供个人和项目两个范围：当前 SDK SettingsManager 信任项目且项目 `.pi/` 存在同名文件时，项目优先，否则回退 agentDir；每类只选一份，不合并两份 APPEND。

信任状态以会话的 `settingsManager.isProjectTrusted()` 为准，页面不改变信任。Pi SDK 的 `createAgentSessionServices()` 默认 SettingsManager 信任项目；这与 MCP 的独立 TrustStore 记录不是同一个状态，不能用 MCP 信任标记推断当前 prompt 的来源。

项目上下文允许编辑 `getAgentsFiles()` 当前实际加载的文件；受信任项目尚无已加载上下文且 cwd/AGENTS.md 不存在时，额外提供固定路径的新建候选。新建复用文件版本与规范化目标路径校验，不接受客户端自定义路径。已有上下文兼容 AGENTS.override.md / AGENTS.md / CLAUDE.md 等原生候选与祖先目录。修改共享文件会影响其他读取该文件的项目。上下文 token 以加载内容计算，磁盘与加载内容不同显示星号。编辑器读取磁盘版本，完整提示词显示当前运行时版本。

SYSTEM.md 替换内置身份、工具说明、规则和文档，不移除追加、上下文、技能。保存前明确提醒。移除替换只删除选定的 SYSTEM.md；如果另一范围还有 SYSTEM.md，会原生回退到它，不能宣称一定恢复内置默认。

## 保存与重载

POST `/api/system-prompt` 位于已有鉴权之后，校验同源、JSON、clientId、cwd、conversationId。文件 ID 由服务端清单限定，不接受任意路径；512 KiB、严格 UTF-8、内容和规范化目标路径版本校验，临时文件原子替换，保留现有权限。符号链接改指向会使旧版本失效；删除替换时移除链接自身。

保存后，对读取同一文件的本进程会话安排原生 `session.reload()`：
- 空闲时立即 reload；运行中保存只标记待加载，在 `agent_settled` 后加载。
- 下一条用户 prompt 先等待待处理 reload，失败时拒绝该请求并显示错误；设置页提供重试。手动压缩后也可由页面刷新或下一条 prompt 补做 reload。
- reload 保留 session ID 和 transcript；不新开会话、不调用模型。下一次请求由 SDK 对比 section 并提交原生变化。
- 提示词保存、设置、MCP 和 `/reload` 共用按原生 session 排队的 `session-reload.ts`；前次失败不阻断后续重载，不同 session 独立执行。手动重载事件只引用发起时的会话资源。
- 页面区分保存待加载、加载完成待下次请求、加载失败。切页／关闭／浏览器离开时保护未保存草稿；文件冲突要求重新读取，不能自动覆盖。
- 其他独立 Pi/WebUI 进程遵循各自的原生 reload 生命周期，不承诺跨进程实时重载。

验证：`tests/unit/system-prompt.test.ts`、`tests/system-prompt-test.mjs --browser`，另跑 `new-chat-context-test.mjs --protocol-only` 确认原生上下文一致。
