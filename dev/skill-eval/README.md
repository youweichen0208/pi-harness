# skill-eval — Engineering 技能自动触发 A/B 评测

本地开发辅助（非产品代码、不随包发布）。验证「随口一句话的小需求/小 bug」能否让模型自动读取
engineering 技能并按实际风险选择路由，同时不误触发只读/问答任务。

## 三组对照

| 组 | 运行方式 | 含义 |
| --- | --- | --- |
| Baseline（当前发布版） | `git worktree add ../pi-harness-baseline v2.0.2`，在其内 `npm ci && npm run build` 后跑同一 runner | 旧 description、无路由规则 |
| Approach B（description-only） | `PI_WEB_ENGINEERING_ROUTE=description node dev/skill-eval/run.mjs --mode description` | 只强化 description |
| Approach A（full，默认） | `node dev/skill-eval/run.mjs --mode full` | description + addendum 路由规则 |

`--mode off` 完全不加载随包技能也不注入规则，作为「无 Engineering Skills」的参照点；
`--mode all`（默认）依次跑 off / description / full 并对比。评测开关语义见 `docs/env-vars.md`。

## 运行

```bash
npm run build          # runner 直接 import dist/server/engineering-skills.js
node dev/skill-eval/run.mjs --mode all
node dev/skill-eval/run.mjs --mode full --only qf-zh-1,ro-en-2   # 只跑部分任务
```

- 模型与凭据：复制当前 Pi 配置目录（`PI_CODING_AGENT_DIR` 或 `~/.pi/agent`）的
  `auth.json` / `models.json` / `settings.json` 到临时 agentDir，不修改用户配置；
  `noSkills: true` 隔离个人/项目技能，只加载随包副本。同一轮评测必须用同一模型，三组才有可比性。
- 每个任务在临时目录展开 `fixture-project/`（一个带小 bug 的 Node 示例项目），跑完即删。
- 判定口径（启发式、全部记录在报告里）：read 工具路径命中 `skills/engineering/SKILL.md` 记为触发；
  读到 architect / domain-modeling / grilling 判 complex，写了 `docs/changes/` 判 feature，其余判 quick-fix。
  多轮任务检查模型是否复用已加载的技能指令而非重复读取。

## 验收目标（初始目标，非已验证数据）

- Engineering 正确触发率 ≥ 95%（expect=engineering 的任务）
- 工程路由准确率 ≥ 90%（触发后 quick-fix / feature / complex 判定正确）
- 非工程任务正确跳过率 ≥ 95%（expect=none 的只读/问答任务）
- Quick Fix 耗时与输出 token 增幅 ≤ 15%（相对 off 组）

若 description-only 已达标，按计划下线 addendum 注入只保留 description；full 胜出则保留注入。

## 产物

`results/skill-eval-<时间戳>.json`：逐任务的触发、路由、专家技能读取、耗时与 token，
以及各组汇总（`console.table` 同时打印）。results 目录不入库。
