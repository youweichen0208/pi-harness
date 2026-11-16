# OMP Task 内部历史保护缺口

状态：2026-11-15，OMP 18.20.0 / Bun 1.4.4，macOS arm64 本地复现，**尚未修复**。这不是 Windows DeepSeek 原故障的根因结论。

## 可重现证据

先运行 `npm run build`，再单独运行：

```sh
node tests/diagnostics/omp-task-external-history-probe.mjs
```

脚本使用临时数据目录、真实 OMP Task 和本地 Anthropic 流式夹具，不使用真实项目或供应商凭据。父任务创建两个子任务；一个完成，另一个执行真实 read 后等待模型响应。脚本找到等待中的子任务原生历史，将工具结果标记作同字节长度的外部替换，再允许模型完成。

当前输出为：

```json
{"fileChangedAfterExternalEdit":true,"externalEditRetained":true,"laterOutputAppended":true,"parentPersistenceFailed":false,"taskStatuses":["completed","completed"]}
```

断言要求外部改写后不得继续写入，因此当前预期退出码为 **1**。这是保留的失败诊断，不加入通过型 smoke，也不将失败转换成通过。已有父会话外部修改保护测试不能证明子任务获得相同保护。

## 已检查的边界

主会话通过公开存储参数注入 `OmpSessionStorage`。锁定版本 `src/task/executor.ts` 的新建、fork/open 及 warm revive 路径，以及 `src/task/persisted-revive.ts` 的恢复路径，使用独立 SessionManager，未传递主会话自定义 storage。已检查的公开 create/session 参数没有向这些内部创建点转发存储工厂的接口。

没有修改 node_modules、替换原生 Task 或以轮询中止冒充写前保护。轮询可能在写入后才发现变化，不能满足本诊断的断言。修复需要继续查明可用公开接入点，或取得支持该能力的原生版本并完成升级验收；当前不宣称所有可能的扩展点均已排除。

后续验证至少应覆盖新建、fork、warm revive、持久化恢复、多层 Task、同长度外写、缺失文件、停止与兄弟任务隔离，并确认不自动重发已有副作用的任务。
