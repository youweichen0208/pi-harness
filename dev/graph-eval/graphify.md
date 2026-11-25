# Graphify 本地图谱实验

在固定的 SDK 与宿主源码切片上，Graphify 找到了五个目标方法和两处与目标有关的仓内调用。它的原生合并图未给出从 SDK 发布 `agent_settled` 到宿主写入 `conv.lastTaskEndedAt` 的跨仓事件链。该结果适用于本次切片和本地 AST 模式。[固定数据集](./corpus.json) · [实际导出的节点与调用](./graphify-owners.json)

## 复现

在仓库根目录运行。开发实验使用独立 Python 环境。Graphify 的 Python 发行名是 `graphifyy`，命令名是 `graphify`。[固定版本的上游说明](https://github.com/Graphify-Labs/graphify/blob/v0.9.119/README.md)

```sh
node dev/graph-eval/prepare.mjs
uv venv --python 3.12 .scratch/graph-eval/graphify-env
uv pip install --python .scratch/graph-eval/graphify-env/bin/python 'graphifyy==0.9.119'
python3 dev/graph-eval/graphify.py --cli .scratch/graph-eval/graphify-env/bin/graphify \
  --owners .scratch/graph-eval/graphify-owners.json > .scratch/graph-eval/graphify-result.json
```

脚本逐文件核对 SHA-256 并复制到临时目录。每个仓库独立运行 `graphify extract <repo> --code-only --max-workers 1`，再用官方 `merge-graphs` 合并两份索引。整个实验设置 `GRAPHIFY_BACKEND=none`，使用默认的增量 manifest。无变化刷新会扫描两个仓库，修改单个 SDK 文件时则重用宿主索引。输出 JSON 保留各次命令耗时、RSS、两仓与合并图大小、跨仓边及其来源行。[实验脚本](./graphify.py)

## 实测

macOS 26.5 arm64，Python 3.12.13，Graphify 0.9.119。表中为一次连续测量。冷构建从空图索引启动，不计安装、语料复制和操作系统文件缓存。耗时含串行提取与合并。RSS 是各 CLI 命令的最高观测值。字节数是磁盘文件逻辑大小之和，含增量缓存、分析文件和合并图。

| 操作 | 总耗时 | 峰值 RSS | 输出字节 | 合并节点 / 边 |
| --- | ---: | ---: | ---: | ---: |
| 首次构建两个仓库 | 0.945 s | 78.33 MiB | 1,762,190 | 856 / 1,504 |
| 源码不变，刷新两仓 | 0.534 s | 63.59 MiB | 1,760,486 | 854 / 1,502 |
| 将 SDK 会话通道的事件键改为 `alternate` | 0.453 s | 71.78 MiB | 1,761,161 | 855 / 1,503 |
| 进一步移除这一处发布调用 | 0.454 s | 71.58 MiB | 1,760,392 | 855 / 1,502 |

两次独立执行得到相同的五个目标节点及起始行。一次无变化刷新后，合并图中 `harness::node_fs` 和 `harness::node_path` 两个节点消失，而目标节点与三个目标方法间的调用条目维持一致。评测索引更新时应比较语义和证据锚点。

## 原生图对这条链的覆盖

- SDK 的 `_emitAgentSettled → _emit` 给出真实调用行 1150。相邻的 `_extensionRunner.emit` 被单独记为 `ExtensionRunner.emit` 待解析调用，来源行 1149。图中这两个位置有不同的接收者。
- 宿主的 `bindSession → onEvent` 给出转交事件的调用行 938。此外 `bindSession` 有一条自身调用，来源行 878。方法节点只有起始行，没有完整方法范围。
- 首次合并生成 9 条跨仓边，均是 Graphify 标记为 `INFERRED` 的方法调用，涉及模型、思考档位和会话统计等。它们均未连通本题的会话注册、事件分派和终态写入。可以利用五个方法来定位源码。当前样本的原生输出尚需按接收者类型、监听器和事件键补证。
- 将会话通道的事件键改为 `alternate` 后，1150 行的 `calls` 边继续存在，源码确实仍调用 `_emit`，但目标业务事件已经改变。继续移除该调用后，增量提取与合并清除了这条调用边。两个变体都保留扩展通道同名事件。这区分了语法调用更新和业务关系失效。
