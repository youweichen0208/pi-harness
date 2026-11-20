# Design First 使用指南

Design First 让 AI 先把需求、方案和验收条件保存成项目文档，等你确认后再修改业务代码、运行验证并核对 spec。普通聊天中的模型可以按技能描述选用这套流程，沿用当前模型和原生工具。

在普通聊天输入 `/skill:` 可查找这三个内置技能，也可以直接输入下表中的调用方式。

## 选择入口

| 命令 | 适用场景 |
| --- | --- |
| `/skill:feat <功能描述>` | 局部、新增或调整行为的小功能 |
| `/skill:bug-fix <错误现象和预期行为>` | 需要先复现、诊断和回归验证的 Bug |
| `/skill:design-first <需求>` | 需要更完整设计、涉及多个模块或重要取舍的需求 |

三个命令都只选择工作流，**不代表你已经批准实施方案**。如果调查后发现影响超出局部，AI 应从 Quick 升级到 Standard/Deep，并记录原因；反向简化也应留下记录。

## 一次完整示例

### 1. 提出需求

```text
/skill:feat 为列表增加名称筛选
```

AI 会先读取相关实现、测试和项目约定，保存包含 Req ID、可观察 Scenario、任务、验收和 spec 影响的提案。确认前可以写入这些变更文档，但不应修改业务源码。

### 2. 审阅并确认

查看回复中给出的文档路径、版本、推荐方案和待决问题。确认应指向当前已保存并展示的版本，例如：

```text
确认 docs/changes/add-name-filter/design.md 的当前版本，请实现并测试
```

如果方案或关键契约发生实质变化，应先审阅新版本再确认。只有“/skill:feat 这个需求”或历史会话里的一句“同意”不构成当前实施授权。

### 3. 实现与验证

确认后，AI 使用当前会话的编辑和命令工具实现任务。有合适的公共测试边界时，按一个 vertical slice 执行 red → minimal green：先实际观察行为测试失败，再完成最小实现并观察通过。

没有合适测试路径时，应记录原因，并通过真实 HTTP、CLI、浏览器或其他可观察交付物验证原始需求。静态阅读、任务勾选或“看起来正确”不等于验证通过。

## 文档保存在哪里

变更位置按以下顺序选择：

1. 你明确指定的目录。
2. 项目已有约定，例如 `openspec/changes/<change-id>/`。
3. 没有既有约定时回退到 `docs/changes/<change-id>/`。

Quick 可以把设计、任务、进度和结果合并到一份 `design.md`；Standard/Deep 通常分别保存 `design.md`、`tasks.md`、`progress.md` 和 `outcome.md`。沿用项目已有文件，不另建重复的规范事实源。

## 跨会话恢复

在新会话中输入明确的 change ID 或文档路径：

```text
/skill:design-first 恢复 add-name-filter
```

AI 会回读文档、当前源码和验证证据，区分已完成、已实现但未验证、剩余工作和偏差。旧测试结果在相关输入变化后只作为历史证据；恢复上下文也不会自动恢复实施授权。

## 完成后检查什么

- 每个 Req ID 是否都能追到 Scenario、任务、实现和实际证据。
- 测试是否记录真实命令、时间、环境、退出码和被测输入；未运行或失败是否明确标注。
- 是否分别完成代码质量审查和设计/spec 符合度审查。
- spec 是否明确标为 `updated`、`unchanged（附原因）` 或 `pending（附下一步）`。

已有 OpenSpec 项目沿用其 Requirement/Scenario delta 和校验约定。AI 不自动安装 OpenSpec；要求的校验无法运行时记为 `not_run/pending`，实现完成也不会自动触发归档。

## 开关与边界

Design First 默认可用，可在设置的 Skills 或内置扩展列表关闭；变更在新会话或 `/reload` 后生效，已明确关闭的设置会保留。Wiki、SSH 节点、只读子代理和 Playground 不加载这套资源。

确认属于 Skill 工作流约定，不是技术工具锁。它帮助组织决策和证据，但不能替代人工审阅，也不保证所有模型始终正确遵守流程。

实现边界和实际验证记录见 [Design First Skill 最小交付](design-first-skill.md)；模型执行契约位于 [随包 Skill](../assets/skills/design-first/SKILL.md)。
