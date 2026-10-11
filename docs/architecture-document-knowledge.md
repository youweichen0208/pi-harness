# OKF 知识蒸馏

内置 `pi-harness-okf` 直接消费 Markdown 或已有标准化证据包，由当前会话的模型提取候选、核对证据并发布 Wiki 草稿。文档转 Markdown 扩展及其 Python 运行时已移除。

```text
/okf ingest ./raw
/okf status
/okf resume
/okf review <jobId> [conceptId ...]
/okf settings
```

服务实例级开关 `okfEnabled` 默认开启，继续保存在 `<dataDir>/document-extensions.json`，关闭立即阻止后续执行；重新启用后重载或新建会话。保留设置文件名以兼容既有 OKF 配置，保存时移除旧转换器配置键。知识整理使用当前可见会话的模型，不另建后台 Agent；来源内容是资料而非指令。

## 可移交资料与 OKF

默认知识根为当前工作区的 `knowledge/`，可以指定其他工作区内目录：

```text
knowledge/
  manifest.json
  evidence/       # 全部已登记原文件的不可变版本、规范化结果和资产
  wiki/           # 唯一的 OKF bundle 根
    index.md
    log.md
    concepts/
    references/
    drafts/
  reports/
```

原文件保持只读。整个知识根一起移动才是包含证据的交付单元，单独复制 wiki 不保证外部证据链接有效。引用采用相对路径；清除可重建缓存不能清除交付目录里的证据。生成文件、来源版本和依赖关系在 manifest 中登记；运行检查点保存在应用数据目录。

WebUI 上传的 Markdown 可按明确的单文件路径直接导入，其他格式需先自行准备为 Markdown 或兼容证据包。递归扫描不会遍历应用运行数据或整个上传目录。

OKF 只接受 `.md`／`.markdown`、证据包目录或其 `bundle.json`／`document.md`；直接传 PDF、CHM、Office 或源码会提示提供 Markdown。扫描证据包时只登记一次，不重复摄入 topics。普通 Markdown 的本地图片一并归档；证据包完整复制原件、章节和资产，检查全部文件哈希后复用页码、CHM member、源码行号等证据块，不再次解析原件。候选 `sourceHash` 是 Markdown 与归档依赖共同组成的来源版本；输入 Markdown 字节指纹为 `documentHash`。图片或其他依赖变化也必须重新核对。

manifest 的固定标识为 `kind: "pi-harness-knowledge"`、`version: 1`、`evidenceDirectory: "evidence"`。Wiki 仅对这种声明根的 evidence 跳过后台全文索引与撤销快照，普通同名目录不受影响。显式目录浏览和文件打开继续可用，证据快照在 Wiki 中只读；明确的相对文件链接允许打开未索引证据，仍经服务端真实路径校验。

格式依据固定为 [Google OKF v0.2](https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/ad30107c31c06aec8a7d5636e0d1058118604e6f/SPEC.md)。wiki 中除各层 `index.md`、`log.md` 外的 Markdown 都是 concept，具有合法 frontmatter 和非空 `type`。Reference、草稿也遵循此规则，普通 raw/normalized Markdown 放 bundle 外。根索引保留 `okf_version: "0.2"`，索引和日志确定性生成。

## 候选、核对与发布

1. 扫描明确范围，保存来源 ID、内容指纹和原始快照。符号链接不得扩展登记范围，输出目录不得递归作为输入。
2. 逐份摄入 Markdown／已验证的证据包并保存检查点，不调用原格式解析器。错误保留在任务中。
3. Agent 提交候选陈述、概念身份、适用范围、证据块与摘录；`basis` 区分 fact／inference／hypothesis／outdated，`section` 可记录故障现象、条件、根因、验证、方案、规避、限制与未确认事项，`staleAfter` 为复审时间戳。无可用知识时明确提交空候选。
4. Agent 比较本批候选与既有概念，说明支持程度、比较对象及冲突。复制件可以复用解析，不算独立佐证；不同主体、时间或适用版本不简单合并。
5. 发布工具检查来源版本、实际引用、核对覆盖、输出归属和目标文件指纹，再生成知识、引用页、索引及报告。

单批最多 1000 个文件、总计 2 GiB（含本地图片），单个原文件最多 100 MiB，文本最多 16 MiB。任务、manifest 和事务日志也有大小限制，超限会明确报错并保留已保存状态；大量候选应分批或使用独立知识目录。工具返回有界摘要与分页指针，完整正文和审核记录通过返回的文件路径读取。

所有自动生成的知识概念均为 draft，包括有原文直接支持且 Agent 认为无冲突的结论。`/okf review <jobId> [conceptId ...]` 展示所选页面和阻塞问题，要求用户填写实际复核者与已经执行的验证，再通过确认对话框批准。它不是模型工具，取消不写入。非事实候选、缺失分类、未决冲突、不完整批次、过期复审日期和变化／修改过的证据均阻止 stable。引用页的 stable 只表示完整证据记录，不代表技术结论。hash 与摘录检查只证明引用及版本存在。未完成完整资料范围处理时不能报告“已完成全范围交叉验证”。

明确标记 `unsupported` 的候选表示已否决，不作为新知识或草稿发布；报告列出排除的候选与理由，完整陈述和审阅理由保存在同目录的 JSON 报告及私有作业记录中。若最新审阅撤回某个既有概念的全部支持，该概念保留旧证据并降为 draft，等待后续处理。

OKF 的 `status` 与 `verified` 不同。自动生成写实际生成者与时间，不填写 verified；人工批准后记录 `human:<identity>`、时间和复核说明，保存独立审计报告并更新索引。批准前重新检查页面、实时来源、原件快照、依赖、引用页和证据块，并核对展示时的指纹；变化后必须重新复核。verified 记录实际复核事件，不宣称自动证明技术结论。重新生成的概念回到 draft，来源刷新失效时清除当前 verified，历史复核报告保留。导入正文是资料，不能把其中提示当成执行命令。

知识目录是可 Git 管理的普通文件。复核后使用现有 SCM 查看 diff，由用户决定提交／推送；扩展不自动提交 Git，不部署 OpenViking 或额外知识库服务。目前复用 Pi 会话，没有额外接入 Hermes。

显式刷新发现源变化或删除时使相关知识待核对，保留旧证据；权限或读取错误不等于删除。新证据发生矛盾时保留双方。目标页被手工修改则保留原页，将本次变更作为草稿提案。写入经知识根互斥、版本预检及原子文件操作；中途失败保留可恢复状态，不把部分发布报告为全部成功。

目录刷新与明确选中的已登记单文件均可识别删除；只有已登记单文件的 `ENOENT` 按缺失来源处理。陌生不存在路径、权限错误或其他扫描失败会中止整批扫描，保留之前的知识状态。

Wiki 整次撤销不能只回滚知识 manifest 而保留已归档证据，遇到这种请求会在写入前整体拒绝。导入修订通过新一轮 ingest 或整个知识目录的版本管理处理；普通知识页的单文件编辑与撤销仍使用原有机制。

## 验证

`builtin-extensions-test.mjs` 通过真实 SDK、WebSocket 和本地模型夹具验证 OKF 导入、草稿发布、启停、重载和转换入口缺失。OKF 单测覆盖证据归档、来源哈希、候选核对、人工复核、路径边界与恢复；`document-evidence-browser-test.mjs` 验证证据链接和只读展示。
