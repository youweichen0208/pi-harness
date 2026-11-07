# 数据库工作台

顶栏数据库入口打开与 Wiki 共用的三栏弹窗：连接树、数据／结构／SQL、原会话 Agent Chat。`ChatDock` 移动原消息列表和输入框，不创建会话；文档与数据库弹窗互斥。SQL 草稿按工作区与对话暂存 sessionStorage，关闭保留。密码仅停留在连接表单内存及服务端加密存储。

## 服务与连接

`server/database/` 将配置、来源解析、SQL 校验、驱动执行、会话授权和 HTTP 路由分开。内置 MySQL/MariaDB 使用 mysql2，PostgreSQL 使用 pg/pg-cursor，依赖随 npm/桌面包分发，不在打开界面时安装。旧 db-client 插件保持独立，不导入它的写操作或自动迁移配置。

`POST /api/database` 经过共享口令、同源、clientId、cwd、conversationId、quiesce 校验。协议类型在 protocol.ts；action 覆盖 list/sync/save/delete/test/scan/preview/import/grant/revoke/run/cancel。HTTP 断开会取消当前查询；完成后重验会话及配置版本，前端 AbortController 和请求序号丢弃迟到响应。

连接保存于 `<dataDir>/database/connections.json`，密码字段仅存 AES-256-GCM 密文，密钥为同目录 0600 的 key 文件。原子替换、随机配置版本和显式字段白名单避免覆盖及凭据回显；坏文件/无法解密直接报错，不回退明文。名称、host、port、user、db_name、driver 为核心字段，TLS 验证证书，允许提供 PEM CA。

## 自动发现与来源同步

扫描限制在当前项目 .idea/.dbeaver、DataGrip 常见配置／项目目录及 DBeaverData，最多 2500 个目录、100 个来源，不递归扫描整个 home，不跟随符号链接。另读取 macOS Application Support、Windows APPDATA、Linux XDG_CONFIG_HOME（默认 ~/.config）中 JetBrains/DataGrip*/options/recentProjects.xml，支持 additionalInfo 与旧版 recentPaths/openPaths，以及 $USER_HOME$ 路径。每次同步重新读取，最多 32 份注册表、每份 2 MiB、合计 200 个去重项目；只检查注册项目的 .idea/dataSources.xml，不递归扫描项目或任意盘符，最终来源仍不超过 100 个。坏文件与失效路径独立忽略，不影响其它版本。手动指定服务端配置文件路径或浏览器上传用于其它布局，路径输入旁说明需要完整文件路径及启用预览的条件。配置文件上限 2 MiB、200 个连接；XML 禁用 DTD/实体。

DBeaver 另读取各数据目录的 UTF-8 `.workspaces` 最近工作区记录，按行解析绝对路径，支持 Windows 换行、中文与空格并去重；支持服务进程继承的 `DBEAVER_WORKSPACE`、`DBEAVER_DATA` 绝对路径及 Linux `XDG_DATA_HOME`。每轮最多 32 个工作区、2500 个项目目录，历史文件最大 2 MiB；只检查工作区及直接子项目的 `.dbeaver/data-sources.json`，不沿历史路径递归扫描其它目录、不跟随符号链接，最终仍受 100 个来源上限限制。历史缺失、过大或工作区被删除时独立忽略。只有其它启动进程可见的环境变量、没有写入 `.workspaces` 的路径、Eclipse 外部链接项目和自定义安装配置仍需手动导入；一旦导入本地来源，即参与后续同步。依据：[DBeaver 工作区记录实现](https://github.com/dbeaver/dbeaver/blob/devel/plugins/org.jkiss.dbeaver.ui.app.standalone/src/org/jkiss/dbeaver/ui/app/standalone/DBeaverWorkspaces.java)、[工作区位置文档](https://github.com/dbeaver/dbeaver/wiki/Workspace-Location)。

打开工作台立即执行 `sync`，打开期间每 15 秒及窗口重新获得焦点时检查一次；关闭后停止轮询，下次打开重新同步。同步只读取服务所在机器的配置，不连接数据库，不授权 Agent，也不写回第三方配置。已导入的本地自定义路径会一并检查；上传文件不自动重读。未识别的路径仍可通过手动导入加入。当前实现不在关闭工作台后运行后台文件监控。

前端同步使用独立请求通道，前台操作期间跳过检查，10 秒超时后释放请求并在下一周期重试；按会话生命周期及前台操作序号丢弃迟到响应。同步不覆盖编辑表单及 SQL 草稿；配置版本变化时清除旧表树与查询结果。连接版本变化会使旧授权失效并取消对应进行中的查询；需要重新测试的连接显示提示。同步错误保留列表并显示重试提示，不覆盖前台操作错误。

来源丢失、格式损坏或重复 ID 时保留已导入记录并禁用连接；恢复后自动重新核对。不支持的驱动／认证／隧道列在来源问题中，不自动导入。用户删除来源连接后，`excluded-sources.json` 保存来源标识摘要，后续自动发现不再添加；手动预览导入可恢复。未变化的记录保留版本，避免反复撤销授权。密码首次导入可读取配置中明确提供的密码，后续同步始终保留本地密码，加密密码库仍需用户补填。

DataGrip 从 dataSources.xml 读取连接，并合并相邻 dataSources.local.xml 中的用户名及明确提供的密码；DBeaver 从 data-sources.json 提取参数和 URL。未知驱动、连接属性、认证、代理或隧道不静默转为直连；预览列出原因且不能导入；缺少 host 仅在没有其它来源问题时报告，避免覆盖不支持驱动、无效 URL 或隧道配置等具体原因（#153）。支持 MySQL/MariaDB/PostgreSQL，密码缺失需补填，不读取系统钥匙串或破解第三方加密凭据。

预览 ticket 绑定运行会话，10 分钟有效，最多 100 个。确认时校验整个连接集合版本。来源路径＋原连接 ID 标识同一个连接；上传来源以前缀 upload: 区分，重新上传同名文件可同步。无变化同步保留版本；主机/端口/用户/驱动变化要求重新测试；来源删除标记失效，保留配置和历史。来源字段不可直接编辑，复制为手动连接后可修改；同步不覆盖本地密码。

## 只读执行与 Agent

数据库工具通过可关闭、可替换的原生 inline extension `pi-harness-database` 注册 `database_read`，不修改 SDK、不由界面插件注入工具。内置扩展清单的开关复用版本化扩展设置；关闭立即拒绝执行，开启按原生 reload 生效。

点击问 pi 只追加有 ID 去重的引用和连接 chip，不自动发送。发送前 grant 对应连接及引用时的配置版本；授权单位为整个连接，表/数据库只是分析定位。授权使用客户端、工作区、SessionManager 实例和原生 session ID 的组合，不能靠复制引用文本获得权限；不落盘，恢复历史或重启需重新附加。移除 chip 或撤销访问取消对应会话进行中的查询。工具只能列举/查询已授权且版本未改变的连接，凭据从不进入模型参数或结果。关闭弹窗不撤销授权。

所有用户 SQL 经 node-sql-parser 完整解析及重新序列化，仅允许单条 SELECT（含只读 CTE），拒绝写入、SELECT INTO、锁定、多语句和非白名单分析函数。无法解析的语法直接拒绝。每次查询独立连接、独立只读事务；PostgreSQL 固定 pg_catalog/public search_path，不复用数据库切换状态。内建元数据查询使用转义标识符和字面量。

最多 8 个并发查询，默认 30 秒。数据库 statement timeout 与 AbortController 配合，取消通过同账号控制连接调用 pg_cancel_backend 或 KILL QUERY，并关闭执行连接。MySQL 流式读取，PostgreSQL 游标按批读取；普通结果最多 1000 行，数据页 50 行，最多 2 MiB 结果，单元格文本最多 4000 字符，超限标记截断。BIGINT/NUMERIC 保留字符串避免精度丢失。数据库错误仅回传错误代码，不透出可能含凭据或查询字面量的驱动消息。

当前不支持写数据、DDL、SSH、代理、第三方驱动、密码库解密。表预览不是一致性快照，外部修改可能改变翻页结果；分析总量应使用聚合 SQL。

## 验证

- `tests/database-tls-test.mjs`：隔离 Docker PostgreSQL 验证自签 CA、可信连接与未知 CA 拒绝。
- `tests/unit/database-sync.test.ts`：自动发现、持续同步、缺失恢复、删除排除、密码保留，以及虚拟时钟下的超时、前台操作和迟到响应隔离。
- `tests/database-sync-browser-test.mjs`：本地模拟接口验证自动同步、表单草稿保留、立即同步和关闭清理，不连接数据库或调用模型。
- `tests/unit/database.test.ts`：来源解析、SQL 拒绝边界、凭据加密、版本冲突、同步幂等、来源删除及授权隔离。
- `tests/database-test.mjs --browser`：真实 MySQL/PostgreSQL、表结构/索引、跨 Schema、分页、BIGINT、写操作拒绝、查询取消；真实 SDK＋本地模型验证未授权拒绝、授权查询、撤销；浏览器验证弹窗、原聊天草稿/附件、引用、同步、焦点和小屏。
- 集成测试仅针对临时测试数据库：默认 localhost:9277 PostgreSQL（postgres）及 :9278 MySQL（root），数据库 analytics，密码 pi_test_only；可用 PI_TEST_PG_PORT / PI_TEST_MYSQL_PORT 覆盖隔离端口。不要指向业务数据库，夹具会创建/重置测试表。

#152 回归：`tests/unit/datagrip-discovery.test.ts` 覆盖三平台配置根、非默认目录、注册表动态变化、Windows 路径、旧版列表、home 宏、去重、坏文件隔离及资源上限。注册格式参考 [JetBrains RecentProjectsManagerBase](https://github.com/JetBrains/intellij-community/blob/master/platform/platform-impl/src/com/intellij/ide/RecentProjectsManagerBase.kt)。

DBeaver 自定义工作区回归：`tests/unit/dbeaver-discovery.test.ts` 覆盖三平台数据根、`.workspaces` 动态变化、中文/空格/换行、去重、环境路径、无效/过大文件和发现上限。
