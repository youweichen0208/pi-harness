# 数据库工作台

顶栏数据库入口打开与 Wiki 共用的三栏弹窗：连接树、数据／结构／SQL、原会话 Agent Chat。`ChatDock` 移动原消息列表和输入框，不创建会话；文档与数据库弹窗互斥。SQL 草稿按工作区与对话暂存 sessionStorage，关闭保留。密码仅停留在连接表单内存及服务端加密存储。

## 服务与连接

`server/database/` 将配置、来源解析、SQL 校验、驱动执行、会话授权和 HTTP 路由分开。内置 MySQL/MariaDB 使用 mysql2，PostgreSQL 使用 pg/pg-cursor，依赖随 npm/桌面包分发，不在打开界面时安装。旧 db-client 插件保持独立，不导入它的写操作或自动迁移配置。

`POST /api/database` 经过共享口令、同源、clientId、cwd、conversationId、quiesce 校验。协议类型在 protocol.ts；action 覆盖 list/sync/save/delete/test/scan/preview/import/grant/revoke/run/cancel，以及只读驱动发现 jdbc_drivers。HTTP 断开会取消当前查询；完成后重验会话及配置版本，前端 AbortController 和请求序号丢弃迟到响应。

连接保存于 `<dataDir>/database/connections.json`，密码字段仅存 AES-256-GCM 密文，密钥为同目录 0600 的 key 文件。原子替换、随机配置版本和显式字段白名单避免覆盖及凭据回显；坏文件/无法解密直接报错，不回退明文。名称、host、port、user、db_name、driver 为核心字段，TLS 验证证书，允许提供 PEM CA。

## 自动发现与来源同步

扫描限制在当前项目 .idea/.dbeaver、DataGrip 常见配置／项目目录及 DBeaverData，最多 2500 个目录、100 个来源，不递归扫描整个 home，不跟随符号链接。另读取 macOS Application Support、Windows APPDATA、Linux XDG_CONFIG_HOME（默认 ~/.config）中 JetBrains/DataGrip*/options/recentProjects.xml，支持 additionalInfo 与旧版 recentPaths/openPaths，以及 $USER_HOME$ 路径。每次同步重新读取，最多 32 份注册表、每份 2 MiB、合计 200 个去重项目；只检查注册项目的 .idea/dataSources.xml，不递归扫描项目或任意盘符，最终来源仍不超过 100 个。坏文件与失效路径独立忽略，不影响其它版本。手动指定服务端配置文件路径或浏览器上传用于其它布局，路径输入旁说明需要完整文件路径及启用预览的条件。配置文件上限 2 MiB、200 个连接；XML 禁用 DTD/实体。

DBeaver 另读取各数据目录的 UTF-8 `.workspaces` 最近工作区记录，按行解析绝对路径，支持 Windows 换行、中文与空格并去重；支持服务进程继承的 `DBEAVER_WORKSPACE`、`DBEAVER_DATA` 绝对路径及 Linux `XDG_DATA_HOME`。每轮最多 32 个工作区、2500 个项目目录，历史文件最大 2 MiB；只检查工作区及直接子项目的 `.dbeaver/data-sources.json`，不沿历史路径递归扫描其它目录、不跟随符号链接，最终仍受 100 个来源上限限制。历史缺失、过大或工作区被删除时独立忽略。只有其它启动进程可见的环境变量、没有写入 `.workspaces` 的路径、Eclipse 外部链接项目和自定义安装配置仍需手动导入；一旦导入本地来源，即参与后续同步。依据：[DBeaver 工作区记录实现](https://github.com/dbeaver/dbeaver/blob/devel/plugins/org.jkiss.dbeaver.ui.app.standalone/src/org/jkiss/dbeaver/ui/app/standalone/DBeaverWorkspaces.java)、[工作区位置文档](https://github.com/dbeaver/dbeaver/wiki/Workspace-Location)。

打开工作台立即执行 `sync`，打开期间每 15 秒及窗口重新获得焦点时检查一次；关闭后停止轮询，下次打开重新同步。同步只读取服务所在机器的配置，不连接数据库，不授权 Agent，也不写回第三方配置。已导入的本地自定义路径会一并检查；上传文件不自动重读。未识别的路径仍可通过手动导入加入。当前实现不在关闭工作台后运行后台文件监控。

前端同步使用独立请求通道，前台操作期间跳过检查，10 秒超时后释放请求并在下一周期重试；按会话生命周期及前台操作序号丢弃迟到响应。同步不覆盖编辑表单及 SQL 草稿；配置版本变化时清除旧表树与查询结果。连接版本变化会使旧授权失效并取消对应进行中的查询；需要重新测试的连接显示提示。同步错误保留列表并显示重试提示，不覆盖前台操作错误。

来源丢失、格式损坏或重复 ID 时保留已导入记录并禁用连接；恢复后自动重新核对。不支持的驱动／认证／隧道不自动导入。不支持驱动的同步条目带可选 category=unsupported-driver，界面以默认折叠的信息行展示跳过数量与明细，不计入来源警告；其它来源错误保持警告。轮询不自动展开信息行，旧端缺少 category 时仍按警告展示。用户删除来源连接后，`excluded-sources.json` 保存来源标识摘要，后续自动发现不再添加；手动预览导入可恢复。未变化的记录保留版本，避免反复撤销授权。密码首次导入可读取配置中明确提供的密码，后续同步始终保留本地密码，加密密码库仍需用户补填。

DataGrip 从 dataSources.xml 读取连接，并合并相邻 dataSources.local.xml 中的用户名及明确提供的密码；DBeaver 从 data-sources.json 提取参数和 URL。未知驱动、连接属性、认证、代理或隧道不静默转为直连；预览列出原因且不能导入；缺少 host 仅在没有其它来源问题时报告，避免覆盖不支持驱动、无效 URL 或隧道配置等具体原因（#153）。支持 MySQL/MariaDB/PostgreSQL，密码缺失需补填，不读取系统钥匙串或破解第三方加密凭据。

预览 ticket 绑定运行会话，10 分钟有效，最多 100 个。确认时校验整个连接集合版本。来源路径＋原连接 ID 标识同一个连接；上传来源以前缀 upload: 区分，重新上传同名文件可同步。无变化同步保留版本；主机/端口/用户/驱动变化要求重新测试；来源删除标记失效，保留配置和历史。来源字段不可直接编辑，复制为手动连接后可修改；同步不覆盖本地密码。

## 只读执行与 Agent

数据库工具通过可关闭、可替换的原生 inline extension `pi-harness-database` 注册 `database_read`，不修改 SDK、不由界面插件注入工具。内置扩展清单的开关复用版本化扩展设置；关闭立即拒绝执行，开启按原生 reload 生效。

点击问 pi 只追加有 ID 去重的引用和连接 chip，不自动发送。发送前 grant 对应连接及引用时的配置版本；授权单位为整个连接，表/数据库只是分析定位。授权使用客户端、工作区、SessionManager 实例和原生 session ID 的组合，不能靠复制引用文本获得权限；不落盘，恢复历史或重启需重新附加。移除 chip 或撤销访问取消对应会话进行中的查询。工具只能列举/查询已授权且版本未改变的连接，凭据从不进入模型参数或结果。关闭弹窗不撤销授权。

所有用户 SQL 经 node-sql-parser 完整解析及重新序列化，仅允许单条 SELECT（含只读 CTE），拒绝写入、SELECT INTO、锁定、多语句和非白名单分析函数。无法解析的语法直接拒绝。每次查询独立连接、独立只读事务；PostgreSQL 固定 pg_catalog/public search_path，不复用数据库切换状态。内建元数据查询使用转义标识符和字面量。

最多 8 个并发查询，默认 30 秒。数据库 statement timeout 与 AbortController 配合，取消通过同账号控制连接调用 pg_cancel_backend 或 KILL QUERY，并关闭执行连接。MySQL 流式读取，PostgreSQL 游标按批读取；普通结果最多 1000 行，数据页 50 行，最多 2 MiB 结果，单元格文本最多 4000 字符，超限标记截断。BIGINT/NUMERIC 保留字符串避免精度丢失。数据库错误使用固定的网络、认证失败、TLS 验证及认证协议不兼容提示，其它错误仅回传校验过的错误代码，不透出可能含凭据或查询字面量的驱动消息。PostgreSQL 连接阶段的异常 SASL 顺序及 pg SASL 内部 TypeError 提示认证协议不兼容；普通查询 TypeError 不作此归类。GaussDB 可使用下述 DataGrip 本地 JDBC 通道；不替换原生 pg 驱动，厂商私有认证兼容性仍取决于实际 jar 和服务端版本。标准 SASL 顺序参考 [PostgreSQL 协议文档](https://www.postgresql.org/docs/17/sasl-authentication.html)。

当前不支持写数据、DDL、SSH、代理、任意第三方驱动导入或密码库解密。表预览不是一致性快照，外部修改可能改变翻页结果；分析总量应使用聚合 SQL。

## 验证

- `tests/database-tls-test.mjs`：隔离 Docker PostgreSQL 验证自签 CA、可信连接与未知 CA 拒绝。
- `tests/unit/database-sync.test.ts`：自动发现、持续同步、缺失恢复、删除排除、密码保留，以及虚拟时钟下的超时、前台操作和迟到响应隔离。
- `tests/database-sync-browser-test.mjs`：本地模拟接口验证自动同步、表单草稿保留、立即同步和关闭清理，不连接数据库或调用模型。
- `tests/unit/database.test.ts`：来源解析、SQL 拒绝边界、凭据加密、版本冲突、同步幂等、来源删除及授权隔离。
- `tests/database-test.mjs --browser`：真实 MySQL/PostgreSQL、表结构/索引、跨 Schema、分页、BIGINT、写操作拒绝、查询取消；真实 SDK＋本地模型验证未授权拒绝、授权查询、撤销；浏览器验证弹窗、原聊天草稿/附件、引用、同步、焦点和小屏。
- 集成测试仅针对临时测试数据库：默认 localhost:9277 PostgreSQL（postgres）及 :9278 MySQL（root），数据库 analytics，密码 pi_test_only；可用 PI_TEST_PG_PORT / PI_TEST_MYSQL_PORT 覆盖隔离端口。不要指向业务数据库，夹具会创建/重置测试表。

#152 回归：`tests/unit/datagrip-discovery.test.ts` 覆盖三平台配置根、非默认目录、注册表动态变化、Windows 路径、旧版列表、home 宏、去重、坏文件隔离及资源上限。注册格式参考 [JetBrains RecentProjectsManagerBase](https://github.com/JetBrains/intellij-community/blob/master/platform/platform-impl/src/com/intellij/ide/RecentProjectsManagerBase.kt)。

DBeaver 自定义工作区回归：`tests/unit/dbeaver-discovery.test.ts` 覆盖三平台数据根、`.workspaces` 动态变化、中文/空格/换行、去重、环境路径、无效/过大文件和发现上限。

#155/#156 回归：`tests/database-sync-browser-test.mjs` 验证跳过提示与警告分开、明细折叠及轮询不重开；`tests/unit/database-auth.test.ts` 使用真实 pg 驱动与本地模拟 PostgreSQL 服务发送提前的 SASL Final，覆盖两种密码、错误脱敏及分类边界，不连接真实业务库。

## DataGrip 本地 GaussDB JDBC

同一台机器上可引用 DataGrip 已配置的 GaussDB 驱动，不复制、下载或分发厂商 jar。只读取已发现的 DataGrip 配置目录中 `options/databaseDrivers.xml` / `jdbc-drivers.xml`，按数据源 driver-ref 匹配类和完整本地 classpath；尊重数据源 jdbc-driver 覆盖。支持 USER_HOME、APPLICATION_CONFIG_DIR、PROJECT_DIR 宏及带空格/中文的 Windows 路径。多个 IDE 配置命中时优先使用 recentProjects 中明确注册该项目的配置；仍歧义则要求在导入预览中选择配置目录、驱动及目标连接，不猜测最新 jar。同一来源中的连接分别保留映射。

仅支持单主机 `jdbc:gaussdb`、`jdbc:opengauss`、`jdbc:postgresql` URL 的直连和系统 VPN；原生 MySQL/PostgreSQL 仍走原驱动。属性使用白名单，TLS 支持 disable / verify-ca / verify-full（ssl=true 默认 verify-full），不接受会降级的 require/prefer。证书必须是本机可读文件。IDE SSH、代理、独立 SSL 配置块、初始化 SQL、VM 参数、native library 和需要下载的 artifact 均明确拒绝；DBeaver JDBC 不在此范围。上传 XML 无法解析另一台机器的本地 jar，须使用服务所在机器上的文件路径。

完整 JDBC URL、属性和绝对 classpath 以 AES-256-GCM 加密保存，仅按需解密到执行进程。浏览器只获取驱动类、jar 文件名、配置目录和摘要，不获取完整 URL/属性。配置、jar 或证书内容变化使连接版本变化，撤销旧会话授权并要求重新测试；文件缺失保留记录并禁用，恢复后重新测试。首次导入也要求测试。同步保留用户已保存密码，不读取 DataGrip Password Safe。JDBC 连接不提供“复制为手动连接”，修改由 DataGrip 来源管理。

每次测试/查询启动独立 Java 进程，标准输入输出采用有界二进制帧，参数和环境不携带密码，驱动日志不回传。Java 按 PI_WEB_JAVA、DataGrip bundled runtime、JAVA_HOME、PATH 顺序探测（至少 Java 8，驱动可要求更高版本），不自动安装。显式 PI_WEB_JAVA 无效时报错，不静默换用其它运行时。桥接 jar 随应用打包，厂商 jar 仍引用原路径，执行前后重新核对文件摘要。设置 allowReadOnly=true，并在执行 SQL 前发送 BEGIN READ ONLY、核验 transaction_read_only，再设置事务级 search_path 和 statement_timeout；只读条件无法建立就拒绝执行。共享原有 SQL 白名单、8 并发/30 秒预算和结果上限；取消先发送 JDBC cancel，1 秒未结束则终止进程树。

`tests/unit/database-jdbc.test.ts` 用真实 Java + 本地假驱动验证解析、加密、映射、同步、授权失效、只读核验、取消、结果精度与截断；`tests/packaged-jdbc-test.mjs [executable] [appRoot]` 验证构建/桌面包内的桥接产物，CI 在 macOS/Windows/Linux 执行。`tests/database-jdbc-browser-test.mjs` 使用本地 HTTP 夹具验证界面。以上不替代目标 Windows 机器上的厂商 jar、认证、TLS、目录查询和真实 GaussDB 验证；发布兼容性结论前仍需该环境验收，不调用付费模型。

### #158：手动驱动文件与错误归属

DataGrip 来源的连接详情、连接设置及 JDBC 同步警告提供“配置 JDBC 驱动”入口。导入预览可选择手动模式，按目标 sourceId 保存 Driver 类名和最多 32 个本机 jar 绝对路径；每行一个路径，保留中文和空格，引用文件而不上传。手动模式不依赖 IDE 驱动定义，使用来源 URL 和来源连接属性，完整连接配置仍加密存储；本地路径作为来源映射保留。每次同步仍检查文件摘要和 URL/属性，不绕过只读核验、重新测试或会话授权。手动配置只应用于目标连接，不覆盖同文件其它连接。

驱动文件不存在、无读取权限、总大小超过 128 MiB、无法复用的 IDE 库配置分别返回固定错误码，中英文提示给出修复方向。首次手动指定后需应用并测试连接；#160 的“保存并测试连接”将预览和按单个 sourceId 应用整合为一次操作。来源缺失或文件损坏时保留记录并禁用，不把失败隐藏成成功。

切换连接、新建/导入、进入连接设置或驱动配置时取消旧前台请求并清除该操作的错误；连接版本变化清除旧结果及错误。成功重试清除先前失败。应用导入后立即同步，清除已恢复的来源警告；未恢复的来源继续显示当前状态。普通同步成功不能证明数据库认证已恢复，因此不会单凭配置读取成功清除仍然有效的认证错误。

## #159：自动匹配与一键恢复

DataGrip 同步/本地导入在连接 URL、类名、引用或对应注册项出现 GaussDB/gsjdbc 特征时尝试匹配。优先精确 driver-ref；没有对应 Gauss 注册项时，只在 IDE 明确注册的 Gauss 驱动中查找唯一候选。没有 Gauss 特征的普通 PostgreSQL 连接继续使用 pg，不因机器上安装了 Gauss 驱动而自动切换。多候选保留歧义，不猜最新版本；成功匹配保存 configDir、driverId 和 sourceId，后续同步保留每项连接的选择。

HTTP `jdbc_configure` 仅供用户界面，按连接 ID/版本校验，重读本地来源，保存加密 profile 并撤销旧版本执行。认证协议错误处提供「自动配置 JDBC 驱动并重试」；此显式操作允许为原 PostgreSQL 来源寻找 Gauss 驱动。歧义返回候选列表，不更改连接；用户选一次即可配置和重测。尚未导入的歧义来源在 syncIssues 中带 sourceId，入口复用 preview/import ticket，只导入所选连接。配置保存不执行 jar；首次测试显示类名和 jar 名称确认，取消不发测试请求，needsTest 阻止用户查询及 Agent 授权。成功测试后按配置版本记住；文件指纹或连接配置变化重新要求测试。

移除操作清除 profile 并保存按 sourceId 隔离的 disabled 选择，连接停用，后续同步不重新挂载；可用自动配置恢复。移除不静默改用另一种驱动连接。Java 探测仍只检查可执行文件候选，配置界面提前提示 missing；detected 不代表版本或业务库兼容性验证通过。

回归：database-jdbc 单测覆盖旧 ID 唯一匹配、普通 PostgreSQL 保持原驱动、显式修复、多候选不更改状态、目录记忆、移除/恢复及旧版本拒绝；JDBC 浏览器回归覆盖取消首次确认不执行、错误处选择并重试、恢复后清除旧错误、配置前显示 Java 缺失。真实厂商 jar/Windows 业务库仍需目标环境验证。

## #160：本地 jar 配置主入口

“配置 JDBC 驱动”默认展开本地 jar 路径和 Driver 类名，按来源 ID 预选连接；已有手动配置回填路径及类名，没有已知类名时提供可修改的 org.postgresql.Driver 默认值。“保存并测试连接”内部沿用 preview/import 的版本校验，只应用目标连接，然后按既有确认规则测试。仍需提供全部依赖 jar 的完整文件路径（每行一个），不扫描目录、不上传或下载驱动；URL、认证和证书仍来自连接来源。

“尝试从 DataGrip 读取”为辅助入口，不清空手动草稿；读取失败保持手动输入框可见。已有连接的一键自动配置失败时直接展开该连接的手动表单和错误提示；来源警告入口携带 sourceId。IDE 目录、驱动选择及目标选择放在可展开的匹配选项中。

驱动定义同时识别 driver-class XML 属性与子元素，属性优先；无两者时保留 PostgreSQL 内置默认类。artifact 元数据与显式本地 library 并存时仅使用本地文件，忽略 artifact 元数据，不解析或下载 Maven 依赖。只有 artifact 没有本地 library、文件缺失、VM 参数和 native library 仍按原规则拒绝。单测覆盖属性格式、artifact 与本地库并存后的真实 Java 测试及拒绝边界；浏览器覆盖默认手动表单、辅助读取失败保留草稿、保存并测试及自动失败转手动。
