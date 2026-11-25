# GitNexus 候选实测

使用 npm 发布的 `gitnexus@1.6.12`（gitHead `c4ecf398de637cf779ab2238e69958cfd5d601ce`），Node 26.0.0、macOS arm64。npm 标明 PolyForm-Noncommercial-1.0.0。当前评测作为开发者可选本地实验。商用分发需另行解决授权。[包元数据](https://registry.npmjs.org/gitnexus/1.6.12) · [该提交的许可证](https://github.com/abhigyanpatwari/GitNexus/blob/c4ecf398de637cf779ab2238e69958cfd5d601ce/LICENSE)

## 复现

先从仓库根目录运行共用的 `node dev/graph-eval/prepare.mjs`，再在独立目录安装 CLI。默认安装成功，无需补丁或重试。以下命令只将运行结果写入新建的实验目录。指定 `--output dev/graph-eval` 可重新生成已记录的两个 JSON。

```sh
tools_dir="$PWD/.scratch/graph-eval/gitnexus-tools"
mkdir -p "$tools_dir/home"
env HOME="$tools_dir/home" npm_config_cache="$tools_dir/npm-cache" \
  npm install --prefix "$tools_dir" --registry=https://registry.npmjs.org \
  --no-audit --no-fund --save-exact gitnexus@1.6.12
python3 dev/graph-eval/gitnexus.py
```

程序按清单校验八个文件的 SHA-256，每次复制到两个独立 Git 仓库。使用隔离的 HOME、GITNEXUS_HOME 和 `--index-only` 分别索引，创建 group，添加两个成员，执行 group sync、contracts、impact、限定 SDK 子组 impact 和分仓 Cypher 查询。未启用 embeddings。LadybugDB FTS 扩展未预装，CLI 依默认离线策略跳过 BM25，无需 FTS 的图查询均成功。解析器对执行流程采样有截断，不能将未出现的流程作为不存在的证明。

## 实测

| 步骤 | 墙钟 | 命令峰值 RSS |
| --- | ---: | ---: |
| 首次分析 SDK | 4.646 s | 888.1 MiB |
| 首次分析宿主 | 4.691 s | 925.1 MiB |
| 初次 group sync | 1.196 s | 543.7 MiB |
| 更改一个宿主事件分支后分析宿主 | 4.873 s | 938.6 MiB |
| 再次 group sync | 1.184 s | 538.3 MiB |

每次运行都使用新的候选索引，系统文件缓存未清空。上述首次分析加同步耗时 10.533 秒，单次变更加同步耗时 6.057 秒。另有一次有效运行，两者为 16.599 秒和 6.029 秒。`du -sk` 统计两个索引和 group 注册目录的实际磁盘分配量，首次 30,793,728 字节，变更后 32,890,880 字节，均不计 CLI 安装。CLI 依赖目录约 1.4 GiB。峰值取每次独立命令的系统 `time` 统计，同一步骤内不累加子进程。全部测量与查询返回见 [gitnexus-result.json](./gitnexus-result.json)。

SDK、宿主分别产生 611 和 584 个节点。五个目标方法都能用原生查询定位，导出时将索引的零基行号转换为一基并与原文核对。SDK 有 `_emitAgentSettled → _emit` 的调用边，`_emit` 与 `subscribe` 都访问 `_eventListeners`。宿主的路径经过回调节点 `bindSession.unsubscribe` 到达 `onEvent`，随后有 `ACCESSES → Conversation.lastTaskEndedAt`。属性访问边未给出具体写入行及其控制条件。[五个方法](./gitnexus-owners.json)

两个成员都完成索引并参加 group sync，原生结果是 0 条契约、0 条跨仓连接。全组及仅 SDK 的下游 impact 均返回 0 个跨仓命中。没有足够的原生关系把这两个局部结果组成目标事件链。通过宿主样本中的 `case "agent_settled"` 改名验证增量执行，工具识别 1 个文件变更并保留另外 2 个文件的行；变更后的 group 仍有 0 条跨仓边。初建时没有目标边，因此这一步只能测更新成本。
