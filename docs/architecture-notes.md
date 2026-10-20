# 全局小记

小记以当前服务的 `PI_WEB_DATA_DIR/notes` 为范围，跨 Workspace、浏览器窗口共享。每条记录一个 UUID JSON 文件，包含 title、body、pinned、createdAt、updatedAt 和递增 version。`server/notes.ts` 使用原子写入，文件权限沿用私有数据写入助手。同步读取、版本核对与写入使单服务进程内请求串行提交；不支持多个独立服务同时写同一数据目录。

`/api/notes` GET 返回 `{notes}`，可带 `q` 搜索标题与正文；POST 接受 `NoteInput` 并返回 `{note}`。`/api/notes/:id` GET 读取，PUT 接受 `NoteUpdate`，DELETE 接受 `NoteDelete` 并返回 `{ok:true}`。类型以 `server/protocol.ts` 为单一来源，不新增 WS 消息或改变协议版本。HTTP 沿用通用口令鉴权，每个请求另校验 Host/Origin，写入要求 application/json；响应 no-store。标题上限 500 字符、正文 100 万字符。无记录返回 404、版本冲突 409、输入错误 400、存储故障 500。损坏文件保留并报错。

`use-notes.ts` 为应用级状态，按小记 ID 保存本地草稿和版本。600ms 防抖，切换记录或返回对话时提交；同一记录写请求串行，保存期间继续输入通过 generation 区分，回包只更新其版本，不覆盖新输入。失败保留草稿和离开保护；409/404 停止自动写入，用户可重新读取或另存副本。请求提交成功但回包丢失也可能产生版本冲突，按相同流程恢复。草稿保存在页面内存，未成功保存时刷新/关闭需确认。

打开、焦点恢复、网络 online 及 WS 重连刷新列表；未保存或正在保存的编辑器不被刷新覆盖。远端删除的脏记录仍保留供另存。列表按置顶、最近修改排序；搜索同时匹配标题和正文。小记默认使用共用富文本编辑器，保留 Markdown 源码与预览模式。预览与编辑使用同一文档编解码器，复选框修改后走相同版本化保存。任意 HTML 作为受保护源码保留，仅渲染下文列出的受控格式。

`App.tsx` 用独立展示状态打开小记，聊天组件保持挂载。小记没有 Agent 会话、工具或自动附件，不调用 prompt，不改变 cwd。导航和项目树复用既有 Workspace 协议；点击分组只改变目录筛选。导航合并为 240px 单栏，顶部浮层承载分组搜索与管理，小记列表替换项目区。收起为 56px 图标栏，悬停或聚焦展开覆盖面板，1100px 以下以抽屉覆盖。

验证：`tests/unit/notes.test.ts` 覆盖持久化、排序、搜索、过期更新/删除、损坏与写入失败。`node tests/notes-test.mjs` 是自包含鉴权/API/重启回归，加入冒烟清单；加 `--browser` 验证自动保存、待办、聊天草稿、冲突另存、断线重试、离开保护及布局。Workspace 回归见 `tests/project-workspaces-test.mjs --browser`。

## 共用编辑与资源（2026-10-20）

`RichMarkdownEditor` 的 `RichEditorHost` 提供图片上传和解析；Wiki 使用项目内 `.assets`，小记使用独立 HTTP 宿主。小记不传 cwd 或 Wiki/Agent 回调。精简工具栏默认展开常用格式及插入，表格、代码、字号、颜色、对齐、行距和格式刷放入“更多”。修改文档序列化时同时验证 Wiki 和小记，不能只验证编辑 DOM。

普通格式保存为 Markdown；蓝／绿／黄高亮块使用 `[!NOTE]`／`[!TIP]`／`[!WARNING]`。特殊格式由 `rich-content.ts` 的白名单处理：字号、文字颜色、背景、对齐、行距、下划线及上下标；折叠块为 `<details data-rich-collapse><summary>…</summary>…</details>`；链接卡片为 `<figure data-rich-card="1">`，内部保存链接、标题、摘要和可选图片。未知 HTML 保留源码，不执行脚本或事件属性。编辑态折叠块使用普通 div/p，规避 Chromium insertHTML 拆散 summary；保存时还原 details，展开状态不持久化。浏览器生成的兄弟嵌套列表仅在序列化副本中归一化，保留原生撤销记录。

`POST /api/notes/assets` 接受 `{data}`（Base64），返回 `{path}`；`GET /api/notes/assets/:asset` 读取资源。图片存于 `notes/assets`，UUID 文件、原子落盘、内容嗅探，PNG/JPEG/GIF/WebP 上限 5MiB；鉴权与 Origin/Host 校验沿用 Notes。资源在正文中使用不含口令的相对 API 路径，展示时才附加鉴权。副本共享稳定资源 ID，删除小记不自动删除资源；本版尚无孤立图片清理。

`POST /api/link-preview` 接受 `{url}`，仅用户主动“获取网页信息”时执行，返回标题、摘要及可选 Base64 封面。仅访问公共 HTTP/HTTPS 80/443，DNS 结果固定到连接，重定向逐次检查（最多 3 次），总超时 8 秒、HTML 2MiB、封面 5MiB、最多 4 个并发请求。不转发口令、Cookie 或其他用户请求头。获取失败可手动填写；确认插入后封面通过当前宿主持久化，卡片为快照，重开不重新请求目标网页。新增 HTTP 类型仍只定义于 protocol.ts。

回归：`tests/rich-notes-test.mjs` 验证格式往返、嵌套列表、折叠、图片、卡片及副本资源；`tests/unit/rich-resources.test.ts` 验证地址范围、网页元数据和图片校验。`notes-test.mjs --browser` 继续覆盖保存失败、离线及跨窗口冲突。测试卡片成功抓取使用受控响应，不依赖外站可用性。
