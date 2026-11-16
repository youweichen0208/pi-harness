> OMP 迁移更新（2026-11-15）：生产入口不再使用下文 Pi 扩展服务。OMP 技能设置、原生扩展模块、个人 npm/Git 包及 Marketplace 个人/项目安装、包可选功能与包设置已接入。下文旧 Pi 章节暂作原功能对照。

## OMP 宿主扩展与更新回归（协议 v75）

旧 Pi `check_component_updates`／`update_component` 请求和 `component_updates` 响应已从协议与前端状态机移除，旧请求仍由服务端拒绝。无人引用的 ComponentUpdates、ComponentUpdatesPanel、ExtensionsPanel、ExtensionCatalogList 和 ExtensionJobResult 页面已删除。安装包内的 OMP 引擎随应用发行，不通过插件更新替换；应用自身更新仍使用独立桌面 updater／应用版本入口。

用户通过 Extensions 中的 OMP 安装包操作更新插件：先查看目标和目录，再明确执行。查看清单和预览不查询 registry、不执行工厂；真正升级使用原生 PluginManager，保留启停状态。失败标为失败，原生校验异常恢复旧版本；强杀等无法确认的结果保留 unknown，不自动重发。页面刷新恢复同一归属的任务记录，不将旧任务重新执行。OMP 的原生显式升级不沿用 Pi 的 pinned/manual 分类，也不伪造批量 partial 日志。

`component-updates-test.mjs` 保留完整冒烟入口，使用私有本地 registry 和真实 OMP 验证安装／升级、停用保留、加载失败回滚、registry 不可用、秘密日志不投影及旧命令拒绝。`--browser` 经生产 HTTP routes 和隔离 runner 验证真实界面确认、结果、刷新恢复及中英文／窄屏主题；只转发包端点，不修改用户个人插件。`extensions-update-browser-test.mjs` 复用同一真实场景，替代旧伪造批量消息。

`extensions-test.mjs` 保留宿主 HTTP／WebSocket 入口，验证真实原生发现、双客户端源码版本冲突、开关、保存与显式重载分离、技能配置、旧接口 410、停止后只读和兄弟会话隔离。`--browser` 检查当前五页设置外壳、焦点、源码草稿保护、实际保存与中英文窄屏；`--electron-node` 检查 Electron 的 Node 宿主。包安装、移除、Marketplace、功能和包设置继续由对应原生专项覆盖，未将这些能力删去以迁就旧断言。

这些本地回归不代表 Windows 原任务、全部桌面包或完整迁移已验收。下方旧 Pi 章节仅作为已退休行为对照。


## 应用数据库开关与旧接口退休（协议 v70）

Extensions 页顶部的「数据库对话访问」是独立宿主设置，使用 `/api/database` 的 agent_settings / set_agent_settings，按版本保存并立即影响现有会话的下一次调用，无需原生重载。它不依赖扩展清单读取成功，详见 [数据库工作台](architecture-database.md#只读执行与-agent)。后面的模块、包和技能仍按各自原生生效规则运行。

`/api/extensions` 只保留 omp-resources / omp-reload / omp-save-skills；旧 skills-list、builtin-list、builtin-toggle 及其他退休操作返回 410，不执行任何 OMP 命令。此前兼容分支为了返回空清单而调用 command，真实计数器复现其会重开已停止 worker；该分支已移除。无人引用的 Pi SkillsPanel、BuiltinExtensionsPanel 与专用协议类型一并退休。包管理和源码编辑的 OMP 替代及旧测试映射见上方 v75 章节；跨平台与整体迁移验收仍分别进行。

## OMP 扩展与包目录入口（协议 v72）

个人扩展目录显示实际 `<dataDir>/omp/agent/extensions`，不再使用旧 `PI_CODING_AGENT_DIR` 或 Pi 目录。读取目录信息不创建文件夹；点击桌面打开／浏览器复制时才准备这个固定目录。已有同名文件不覆盖，错误独立于模块与包清单，修复后可重试。停止聊天 worker 后仍可访问个人目录，不创建或恢复 agent。

`/api/omp-paths` 使用当前 client/cwd/conversation 及同源检查，模块通过原生清单 ID 解析文件，个人包通过安装名解析目录，Marketplace 通过插件 ID、安装范围和当前清单中的路径选择副本。浏览器不能传任意目录让服务器创建或打开。异步清单返回后重新检查会话归属；不存在、类型不符或已移除的目标拒绝。包清单读取运行独立的只读原生包 worker，不导入工厂，不请求模型。

桌面 `openOmpPath` 只允许本应用主 frame，通过带认证的本机接口取得确认路径。目录交给文件管理器打开，模块文件仅在文件管理器中显示，不能作为程序执行；窗口已关闭时不执行后续 OS 操作。旧 `openExtensionPath` IPC 明确拒绝，不再调用退休的 Pi HTTP 接口。浏览器先解析当前有效目标，再复制服务端路径，失败不复制陈旧缓存。

`extensions-directory-desktop-test.mjs` 已迁移到 OMP，覆盖 Unicode 路径、缺失目录、同名文件保留、键盘打开、模块定位、错误身份、旧接口拒绝和 Stop 后不重开。资源浏览器回归验证复制固定目录；原生包和包浏览器回归验证已安装目录、链接源、个人/项目插件副本、伪造路径及异步归属变化。真实 Electron IPC 回归已加入 Mac/Windows CI；本地结果与尚未执行的平台验收分开记录。

## OMP 本地扩展源码编辑（协议 v71）

原生模块列表中可编辑的本地 JS/TS 入口提供「编辑文件」。目标必须来自 OMP 当前发现结果，并位于个人 extensions、当前项目 `.omp/extensions` 或原生显式配置的本地路径中。已安装插件入口和 node_modules 不开放源码写入；这里不是包目录浏览器，不允许客户端提交任意路径，也不会创建或删除文件。目录打开／定位入口已由 v72 的 OMP 路径接口接管。

`harness_extensions` 增加 read-file / save-file，由 `/api/omp-extensions` 继续按 client/cwd/conversation、同源和 JSON 类型准入。读取仅使用现存 worker，停止后不会重开；保存还要求空闲、非受限、非排空并持有会话导航操作权。读取和保存均不导入工厂、不发送模型请求，也不自动重载。保存成功后的待重载提示只属于当前 worker，不代表其他已运行会话已经载入新代码。

读取最多 512 KiB，拒绝非普通文件、替换后的符号链接、无效 UTF-8 与 NUL；保留 BOM。版本绑定实际路径、权限和文件内容。保存取得 OMP 公开文件锁后重查目标及版本，用同目录临时文件和公开 Windows rename retry 接口替换，保留权限；应用内两个 worker 使用同一旧版本时只有一个成功。外部编辑器不一定遵守该锁，版本检查不是跨进程文件系统事务。保存失败不自动重试。

编辑器不受清单轮询覆盖；冲突保留草稿，重新读取前确认丢弃。切页、关闭设置和页面刷新沿用草稿保护；关闭编辑器恢复触发按钮的焦点。代码作为纯文本显示，窄屏使用 16px 等宽输入框，保存与重载是不同动作。

回归扩展现有 `omp-extension-settings-test.mjs` 和 `omp-resources-desktop-test.mjs`：原生文件读取、外写冲突、跨 worker 并发、权限/BOM、非法编码/大小/目标替换、停止后禁止打开、保存不执行，以及界面草稿、冲突恢复、显式重载、中英文及窄屏。测试仍使用原版 OMP，不改 SDK 文件；平台实际运行结果见专项验证记录。

## OMP 包设置

`server/omp/package-settings.ts` 只读包 manifest 中的原生 string/number/boolean/enum 声明，使用 SDK 的 `validateSetting` 验证；读取不执行包模块。设置以 manifest 的包名为键，共用个人 `omp-plugins.lock.json` 和项目 `plugin-overrides.json`。设置范围与 Marketplace 安装范围独立，项目安装条目不会把设置写进其安装缓存锁文件；个人与项目安装的同名包共用设置。项目查找按运行时 loader 的原生发现顺序，页面显示实际文件路径。

秘密字段只返回类型、是否配置与来源，不回显存储值、默认值或秘密 enum 候选；环境声明只显示变量名，不读取其值。普通字段区分此范围的值、项目覆盖与 manifest 声明默认，保留 false、0 和空字符串。保存使用单独的 HTTP/短期 Bun worker 操作，秘密输入通过 HTTP 请求体与子进程 stdin 传递，不进入包预览、持久化任务或原始错误日志。

保存持有包管理锁，重读 manifest、个人配置及全部项目候选文件并检查版本；完整 patch 验证后一次原子写入，保留未知字段和其他包设置。个人配置用 SDK 的私有文件 writer；项目配置以随机 0600 临时文件和公开的 Windows rename retry 接口提交。未知键、类型/范围错误、非法秘密声明和非对象项目文件拒绝写入。删除覆盖只删除所选范围的字段。运行中/排空/切换会话时拒绝保存；不重启或自动打开 agent。

界面按需读取，每个字段明确选择保留、设置或删除覆盖。错误保留草稿；切设置页、关闭窗口、切范围及重读前保护草稿，成功后清除输入中的秘密。保存成功不代表当前扩展已重新读取，用户需显式重载或新建会话。原生读取与持久化回归为 `omp-package-settings-test.mjs`，界面回归并入 `omp-packages-browser-test.mjs`，后者可接受桌面 executable 与 resources/app 两个参数。

## OMP 原生扩展模块

`server/omp/extension-settings.ts` 调用 `discoverExtensionPaths` / `listPackageExtensionModules` 做只读发现，不导入工厂；当前加载与活跃状态来自公开 extension runner。清单同时显示配置是否启用、模块是否加载及是否活跃，不能仅凭设置保存成功显示已运行。原生新来源需要重启，已导入模块可由 SDK 的 settings listener 停用/恢复；浏览和恢复不重新执行模块顶层代码。

开关使用 OMP `extension-module:<name>` 标识，同名模块共用规则；原生显式文件路径绕过名称开关，因此页面不提供无效开关，可在原生 `extensions` 路径中移除。个人 `extensions` / `disabledExtensions` 通过公开 Settings 定义、writeValue/unsetGlobalValue/flush 保存，保留未知字段，允许删除覆盖恢复默认。有效值与来源单独展示，项目/运行时/环境覆盖下禁止声称个人开关可直接控制当前模块。只开放两个数组字段，限制数量、长度和请求大小。

保存有设置版本、应用 worker 间的文件锁与原生落盘锁；先重读检查冲突，再保存并核对字段。其他空闲 worker 经公开 reloadFromDisk 同步，运行中等待下一次刷新；不强制重启它们。受限会话、运行中、压缩/重试及停止后的写入被拒绝，失败保留草稿。清单轮询不重置草稿，切页/关闭/刷新前保护未保存内容。

设置页重载和 `extensions_reload` 使用 `OmpSession.reloadResources`：导航操作权覆盖停止旧 worker、打开同一原生历史、重新绑定宿主工具和推送元数据。OMP 的会话级 `session.reload()` 不重新导入模块，不能代替这个操作。保留模型、思考、运行偏好与会话身份，不重发任务；正常空闲重载保留原有任务错误/中断状态，不能制造一次假中断。排队输入和原生恢复操作期间拒绝重载。用户 Stop 取消操作权，禁止晚到的初始化继续重开；下一次显式重载才可继续。

资源清单、扩展列表和 MCP 配置读取均只使用现存 worker，停止后返回不可用。MCP 的 `workerAvailable` 与 manager 的 `available` 分开，避免把禁用 MCP 当成 worker 已停止。只有明确的重载允许打开新 worker。

OMP 18.20.0 的 PluginManager 使用独立 config-root 下的 plugins 目录；仅设置 `PI_CODING_AGENT_DIR` 不会把它移动到 agentDir/plugins。页面显示 SDK 实际返回的目录，与采用相同原生目录配置的 OMP CLI 共用个人包。应用覆盖 agentDir 并清除继承的 profile/config-dir 选择；不同 profile 或 XDG 布局的 CLI 可能使用另一目录，以界面实际路径为准。包管理不访问旧 Pi 包目录。

回归：`omp-extension-settings-test.mjs` 使用真实模块计数器和命令验证只读发现、停用/恢复、重启后加载新代码、跨会话隔离、显式文件语义、冲突/默认值/校验与项目覆盖。`omp-resources-desktop-test.mjs` 通过浏览器及实际 Electron 覆盖开关、路径编辑、代码刷新、错误/草稿和窄屏；`omp-stop-metadata-test.mjs` 验证重载中 Stop 与停止后的被动读取。

## OMP 个人包管理

`/api/omp-packages` 沿用同源、JSON、client/cwd/conversation 归属检查。`OmpPackages` 启动独立 Bun `package-worker`，调用公开 PluginManager 的 list/install(dryRun)/install/link/upgrade/uninstall/setEnabled。只读清单和预览不导入工厂、不访问 registry；真正安装/更新遵循原生 SDK 的扩展加载校验和失败回滚，可能执行第三方代码。UI 先显示目标与实际个人目录，用户点击执行后才变更。不打开聊天 worker，不调用模型，不自动重载已有会话。

新建本地链接拒绝覆盖已有 runtime 路径；移除链接沿用原生卸载，只删除注册和链接，不删除源文件。更新使用原生来源与状态保留逻辑；本地链接不能更新。个人启用与当前项目的有效启用分别投影，项目覆盖不会被个人开关偷偷删除。安装包清单只投影名称、版本、路径、启用及功能名，不返回 manifest/settings、凭据或任意工厂日志。

写入前重新读取包清单、原生 manifests/lockfile/当前项目 override，核对预览版本；链接额外核对源 manifest。应用 package workers 在实际包根目录共用写锁，不宣称外部 OMP CLI 也遵守该锁。用户指定来源在安装过程中仍按原生语义解析，预览不是 registry 版本或代码快照。

长操作立即返回 job ID，最长 20 分钟，与聊天 RPC 的 30 秒期限分离。`<dataDir>/omp/package-jobs` 持久化操作、归属及状态，同一请求 ID 不重复执行；同一客户端和对话可在切页/刷新后恢复记录，列表最多返回最近 50 条。不同对话不能读取/取消对方操作。quiesce 和当前模型任务运行中拒绝启动新包写操作；关闭设置页不取消后台包操作，显式停止包操作或服务关闭才结束 worker 进程树。聊天 Stop 不影响独立包任务。

正常原生返回才记成功；原生错误记失败，强杀、超时或无法确认执行结果记 unknown。宿主重启发现原任务宿主 PID 已消失也记 unknown；不能确认 PID 已退出时不假定任务停止。未知结果和失败均要求检查本地状态后手动决定，绝不自动重发。同一请求 ID 即使失败也不能用于重试新操作。原生安装的正常异常回滚有测试；进程强杀不保证回滚，写锁可能等待 stale 期限才释放。

`omp-packages-test.mjs` 通过临时本地 npm registry 和原生 config-root 隔离，验证真实安装、更新、失败回滚、启停、移除、链接源保留、读取不执行、预览冲突、实际 HTTP 权限/准入、持久化去重和停止。测试不修改 HOME，不触碰真实个人包。`omp-packages-browser-test.mjs` 将产品包 API 转发到使用生产 routes 和真实 worker 的隔离测试服务，验证界面写操作、冲突、记录恢复和窄屏；不是用户个人目录的写入验收。资源桌面测试另验证真实应用端点的列表及无副作用预览。

## OMP Marketplace 与项目范围

`marketplace-packages.ts` 在独立 package worker 内调用公开 `MarketplaceManager`，原生 helpers 决定个人 registry/cache 与 `resolveOrDefaultProjectRegistryPath(cwd)` 的项目位置。嵌套工作目录沿用原生项目锚点，不接受浏览器自选安装根目录。OMP 18.20.0 的直接 npm/Git/link 管理仍是个人范围，原生 CLI 对这些操作忽略 project scope，因此应用明确拒绝而非假装项目安装；Marketplace 插件通过原生接口支持个人/项目两种范围。

来源支持原生本地目录、Git/GitHub 和 JSON 地址。查看列表读取缓存，不刷新网络；添加远端来源的预览只核对格式，确认执行后才获取。添加本地来源时原生解析 catalog，核对重复名称并绑定内容版本。来源刷新与已安装插件升级是两个动作；移除 Marketplace 仅移除来源及 catalog 缓存，保留已安装插件，仍可单独启停或移除它们。损坏或丢失的单个 catalog 标为不可读，保留来源管理入口。

清单投影插件 ID、版本、说明、安装路径、范围及原生 enabled/shadowed 状态，不返回嵌入的 MCP/工具配置、manifest 设置或凭据。已有来源 URL 隐藏身份信息、query 和 fragment；新的带凭据/query URL 被拒绝，避免写入任务记录。启用状态是原生配置，不能替代当前会话已经加载的状态。显式重载后的原生发现与加载决定实际使用哪个副本。

操作预览显示目标范围、实际目录、脱敏来源和可确定的升级前后版本。版本指纹包含个人/项目 registry、runtime 配置、项目引用索引和 catalog；本地安装源还绑定 package/plugin manifest。执行重读核对完整计划，目录或来源变化不继续使用旧预览。项目操作在共享个人包锁之外再取得项目目录锁；个人操作可能改变同 ID 的项目引用时也取得项目锁。原生同版本缓存跨范围共享，强制重装/升级可能同时影响引用它的副本，界面提前说明。应用锁不宣称覆盖外部 OMP CLI。

所有变更共用既有持久化 job、身份/同源/quiesce 检查、去重和独立停止。项目/个人副本在列表中分别操作，不静默选择同 ID 的其他范围。已有聊天不自动重载或重发；UI 完成只代表包管理任务完成。

`omp-marketplace-test.mjs` 使用独立临时 config 名称（不修改 HOME、不写 ~/.omp）和本地/HTTP 来源，验证只读/脱敏、嵌套项目定位、双范围安装、真正的原生扩展发现/加载、停用项目后的个人代码回退、按范围升级、跨项目缓存引用保留、版本冲突和缺失 catalog 恢复。`omp-packages-browser-test.mjs` 的隔离原生端点回归覆盖来源管理、scope 预览、覆盖/回退、按范围升级/移除和窄屏主题。远端 Git 托管服务和 Windows/Linux 实机仍须各自验证。

## OMP 包可选功能

个人 npm/Git/link 与 Marketplace 的个人/项目副本均按 manifest 展示可选功能。`null` 表示包默认，`[]` 表示不启用任何可选功能，非空数组表示明确选择；基础入口始终保留。当前安装范围的选择、项目覆盖后的选择与模块是否已加载分开，保存不重载会话。项目 `plugin-overrides.json` 的优先级使用 SDK 公开 `getConfigDirPaths` 顺序；不改写项目覆盖规则。

功能变更仍使用 `/api/omp-packages` 的预览和持久化任务：旧表单版本在预览时拒绝，确认执行时再次检查安装状态、完整 manifest 与覆盖文件指纹，未知/重复功能名拒绝。个人范围调用 `PluginManager.setEnabledFeatures`；项目范围通过公开 `normalizePluginRuntimeConfig` / `writePluginRuntimeConfig` 更新对应运行目录，保留启停、版本、其他包、设置和未知顶层字段。项目写入同时取得个人包锁与项目目录锁，SDK 用私有权限的临时文件原子替换。共享缓存中的 manifest 和代码不变，不执行工厂。

浏览器功能表单保留失败和外部变更时的草稿，切页/关闭/刷新页面保护未保存选择；预览显示确切选择和范围，确认后按任务记录恢复状态。只投影功能名、描述与默认标记，不发送包设置 schema、默认密钥或保存值。无可选功能的包不显示空表单；损坏或多个版本并存的 Marketplace 副本仍可移除，但不提供无法确定目标的功能编辑。

`omp-package-features-test.mjs` 用真实原生加载器验证默认/全关/自选实际导入的模块、两个范围共享代码而分别保存功能、项目覆盖与停用回退、冲突和凭据不下发。`omp-packages-browser-test.mjs` 用真实生产包端点和隔离目录验证草稿、预览冲突、两个范围写入和窄屏浅深主题。

# Extensions 原生包管理

文档转 Markdown 与 OKF 知识蒸馏扩展均已移除，不再提供聊天工具、命令或设置条目；实现、Python 资源和打包支持也已删除。

设置 › Extensions 对接 Pi 1.5.2 的 `DefaultPackageManager`、`SettingsManager` 和 `ProjectTrustStore`。安装、移除、更新与资源发现运行在独立 Node worker；浏览页面不执行扩展入口，缺失依赖采用 `resolve(() => "skip")`，不会因浏览自动安装。包变更在新会话生效，当前会话仅在用户点击重载时通过已有 `extensions_reload` 生效。宿主不向模型注册工具、注入消息或系统提示词。

扩展代码刷新（issue #64）：jiti 对原生 .js/.mjs 走 Node import()/require()，进程内缓存会让 `/restart`、`/reload` 和 `extensions_reload` 重建扩展工厂后仍命中旧代码——扩展内的 MCP 连接等顶层状态也随之遗留。`server/extension-module-cache.ts` 在每次创建 runtime 前注册受控目录（agentDir/extensions、agentDir/npm、cwd/.pi/extensions、cwd/.pi/npm，realpath 双形式匹配），并仅在用户显式触发的重建前（restartSession、`/reload` 命令、`reloadExtensions`）bump 代数——ESM 缓存不可释放，每次刷新多留一份模块实例，所以设置、提示词、MCP 保存共用的 `session.reload()` 不刷新；代数进程全局，刷新后其他对话懒加载受控模块也拿到新实例。bump 机制：resolve 钩子给受控模块 URL 追加 `?piextgen=<代数>` 绕开 ESM loader 永久缓存（CJS 的 require 会剥掉 search，无副作用），同时清空受控目录下的 require.cache 条目刷新 CJS 本体；`module.registerHooks` 不可用时 ESM 优雅降级为旧行为。.ts 由 jiti 每次实例化重新转译，天然新鲜。回归：`tests/restart-extension-cache-test.mjs` 覆盖 .ts 文件、npm CJS 包、npm ESM 包在 /restart、二次重启与 reloadExtensions() 下拿到新代码与新状态，普通 session.reload() 保持旧代码。

## 本地扩展与外部工具

无需单独安装 pi。管理页独立请求 `open-info` 的固定 ID `extensions:user`，创建并展示 `getAgentDir()/extensions`；默认 macOS/Linux 为 `~/.pi/agent/extensions/`，Windows 为 `%USERPROFILE%\.pi\agent\extensions\`，尊重 `PI_CODING_AGENT_DIR`。Desktop 打开目录，Web 复制服务端目录路径；请求沿用同源、clientId/cwd 和 quiesce 检查，不接受自定义创建路径。目录失败独立展示并可重试，不阻断包列表；已有内容不覆盖，项目级 `.pi/extensions/` 不自动创建，继续遵循项目信任规则。

普通 `.ts`/`.js` 本地扩展由现有运行时加载，无需系统 Node.js、npm 或 Git。放入目录后重载或新建会话生效。社区 package 仍走原生包声明和安装路径，不直接复制进个人 extensions 目录；安装第三方依赖或调用外部命令的扩展可能需要宿主工具。

不额外打包或自动安装 Node.js/npm/Git。包写操作和更新检查在实际需要时，以参数数组执行所需命令的 `--version`（5 秒、16 KB 上限，同一次 worker 去重），尊重原生 `npmCommand` 及其前缀参数。单包更新仅检查目标范围；离线检查保留原生跳过语义。Windows 使用 cross-spawn 处理 `.cmd`。探测进程由父 worker 调度器登记并清理。失败区分命令缺失、无法运行和普通包错误；安装日志中明确的 node/npm/git 缺失诊断也提供中英文提示，普通网络、编译等错误保留原样。没有永久探测缓存，环境补齐后可重试；应用 PATH 变更可能需要重启。不能静态预判任意扩展调用的全部外部程序。

回归：`extensions-local-test.mjs` 在工具 PATH 清空时验证自定义目录、固定路径接口、目录失败隔离、文件保留与真实 SDK 加载/重载；支持指定打包 app 根目录。`extensions-worker-test.mjs` 验证缺失工具不会改配置、工具恢复后操作成功；浏览器回归覆盖目录入口、中英文和缺失工具提示及重试；`extensions-directory-desktop-test.mjs` 通过真实 Electron 验证打开目录 IPC，仅替换系统文件管理器调用。

## 内置扩展清单

已安装页按内置扩展、安装包、单文件分组。六个内置条目由 `nativeExtensionRegistry` 与会话资源共同投影；包页签数量只统计安装包。内置清单独立请求，即使包 worker 失败仍能展示；不提供包更新、卸载或源码编辑。Workspace 子代理默认开启，独立全局开关与只读分工规则见 [子代理架构](architecture-subagents.md)，工具可被用户同名扩展替换。

`/api/extensions` 的 `builtin-list`、`builtin-toggle` 都绑定活动 conversationId，并沿用 cwd/clientId、同源与 quiesce 校验。清单读取已有资源，不执行工厂、不加载包。工具来源必须匹配具名 inline/builtin 路径；第三方同名工具显示冲突。状态区分加载、关闭、待生效、不可用和配置/加载失败，MCP 的加载状态不代表服务器连接成功。查看设置跳转已有 MCP/Codemode 页。

计划开关移入内置条目，继续使用现有计划协议和延迟生效规则。数据库开关复用 document-extensions.json（保存时清除已移除扩展的旧键），使用版本校验避免覆盖其他客户端的修改；关闭立即拒绝后续执行，开启后按会话实际工具状态提示重载或新建会话。内置页重载按钮仅在连接正常、空闲且会话可写时可用。页面打开时轮询轻量清单，切换会话和关闭页面取消请求，迟到结果不覆盖新状态。

回归：`tests/builtin-extensions-test.mjs` 使用隔离 WebSocket 服务、真实 SDK 和本地模型夹具验证清单、关闭拒绝、跨客户端配置、版本冲突、新会话/重载；`--browser` 覆盖五个条目、开关、转换与 OKF 入口缺失、设置跳转、包列表失败、中英文与窄屏。它不证明外部模型的自主语义能力。

## 请求与运行边界

`/api/extensions` 位于公共鉴权中间件之后，校验同源、已连接 clientId、活动 cwd、工作区切换和 quiesce。HTTP 类型集中在 protocol.ts；独立于聊天 WebSocket 消息。来源预览返回绑定 clientId/cwd、20 分钟有效的 ticket；确认安装必须提交 ticket。列表与预览是只读操作，写任务全服务串行；日志有界 128 KB，关闭面板后可按任务 ID 恢复轮询。

worker 保留原生 npmCommand，项目和个人作用域使用相同原生安装路径。同一工作区和动作的并发读取共享 worker，响应各自复制；读 worker 最多 4 个，超时 2 分钟；写任务超时 20 分钟。worker 是独立进程组，超时和服务退出仅终止其所属进程树。写任务先等待已经开始的包读取结束，再执行原生操作。worker 在异步操作和最终 IPC 回传完成前保持 message 监听，父进程等待 close 确保管道排空；异常退出显示退出码与信号。Electron 通过 ELECTRON_RUN_AS_NODE 加载相同 worker。

Desktop 不打包应用自己的 `extensions/` 或声明其扩展入口。会话使用 Pi 原生用户目录与受信任项目资源发现，保留原生 Codemode/tool_search/MCP 工厂。CLI 的可选 `/webui` 入口只属于 npm 包；用户已配置的扩展不被 Desktop 删除或迁移。打包钩子拒绝夹带应用扩展，`wiki-electron-test.mjs` 验证用户扩展在启动和新会话中执行，并遵循原生禁用规则。

## 配置语义

包开关以原生四类资源过滤数组 `[]` 禁用全部资源，启用时恢复原配置。原过滤规则备份在 agentDir/webui-extension-filters.json；个人范围的备份跨项目共享。关闭项目 autoload delta 时显式改成完整禁用声明，重新启用恢复原 delta。单文件开关写入原生 `+absolutePath` / `-absolutePath`，不删除文件。

设置摘要在写任务开始及安装完成前校验，防止覆盖外部修改。SettingsManager 自身保留不相关字段并锁定写入；长安装遇到冲突时保留已安装文件并报告配置未覆盖。移到另一范围先安装并保存目标声明，再移除原声明，保留过滤规则；迁移不会清理原托管缓存。本地来源只移除引用。应用本身和内嵌 SDK 由应用升级流程管理。

未信任项目仅显示 settings.json 中的包声明，不读取项目包安装目录，不安装或启用。Extensions 不隐式授予信任。信任需要在原生 Pi 或已有 MCP 设置中明确操作。

更新检查、更新操作使用按范围隔离的原生内存 SettingsManager，避免原生 update(source) 同时更新两个范围或检查时被项目声明去重。SDK 判断版本和 ref 可更新性；固定 npm 版本、带 Git ref 的来源及本地文件不纳入更新。Git 工作树有未提交改动时阻止更新。范围/tag npm 来源只显示可更新标记，不把 registry/latest 当成满足范围的目标版本。

Pi 1.5.2 更新结果由 `extension-updates.ts` 按包收集：更新前后读取实际安装版本或 Git HEAD，保留原生 `result` 和警告事件；离线、锁定、未信任、本地及受保护包明确标记跳过。更新动作直接交给原生 update 做版本判断，不用另一次检查过滤掉无变化或警告结果。一个包失败后继续处理其余包，增量结果经 worker IPC 保留在任务中；`partial` 表示部分失败，崩溃时也保留已收到结果。界面每包一行摘要，警告/错误保留说明，详细日志默认收起，版本未验证不声称更新成功。

## 目录和展示

独立文件的名称统一由 `extensionDisplay` 派生：index/main/extension/plugin 入口使用所属目录名，跳过 src/dist 等中间目录，兼容 Windows 路径。完整路径保留供区分，开关与编辑继续使用原生文件身份。

pi.dev 当前通过服务端 HTML 提供目录，没有依赖未公开 JSON API。extensions-catalog.ts 从 data-package-* 和文本中提取名称、类型、下载量、日期与版本，支持原站搜索、排序和分页。只渲染文本及校验后的 HTTP(S) 链接，不注入远程 HTML。目录格式变化时展示错误及原站入口。联网请求 15 秒超时、5 分钟缓存，缓存有界。安装预览从 npm registry 读取显式资源清单；Git 来源确认前不克隆，因此清单未知时明确提示审查源码。版本说明从仓库的 GitHub latest release 提取至多三条，并显示实际 release tag，不伪造包 changelog。

用户进入管理页后注册该工作区的后台更新检查，服务运行期间每 6 小时检查；最多记忆 32 个工作区。自动检查开关存放 agentDir/webui-extensions.json，关闭后停止后台检查。关闭设置不会自动安装或更新任何包。

单文件编辑仅允许资源发现结果中的受信任 standalone JS/TS 文件，最大 512 KB，严格 UTF-8；SHA-256 文件版本校验后原子保存，保留文件权限。浏览器编辑草稿有离开保护。桌面固定 IPC `openExtensionPath` 由本机服务将当前目录的包 ID 解析为已安装路径，主进程仅 reveal，不执行任意文件；浏览器提供复制路径。

## 验证

- tests/unit/extensions.test.ts：原生过滤恢复、单文件开关、未信任项目、范围迁移、本地移除、配置冲突、目录文本解析。
- tests/extensions-test.mjs：隔离配置和端口 9210，真实 SDK/HTTP 安装本地夹具、启停、卸载、编辑、鉴权和同源；`--browser` 覆盖中英文、安装确认、列表、目录、编辑与窄屏布局。目录 UI 使用确定性响应，真实 pi.dev 搜索另作联网验证。
- 原生上下文边界沿用 tests/new-chat-context-test.mjs。

## 设置 v2 的技能与更新

技能页通过 `/api/extensions` 的 `skills-list` / `skills-toggle` 读取 `NativeSkillsState`，`skills-service.ts` 使用原生包管理器发现资源并读取技能元数据，不执行扩展入口、不安装缺失依赖。技能名称与描述可搜索，并按个人、项目和包筛选。桌面使用已有固定目录 IPC 展示个人技能目录（服务端固定 ID `skills:user`，目录不存在时展示 agentDir）；浏览器提供复制路径。开关写入所属范围的原生 `skills` 过滤器，包技能仅修改对应包的 skills 字段，保留 extensions/prompts/themes 等字段。空过滤数组的禁用基线在启用一个技能时保留，避免误启用同包其他技能。涉及多个技能的同一自定义资源目录保持只读；临时资源和未信任项目不能写入。请求沿用工作区、来源、JSON、quiesce 与配置版本校验，和包操作共用写入互斥。写入后由用户点击原生 reload 或新建会话生效。

更新页复用 Extensions 的持久任务、更新所有包、检查和服务器自动检查偏好；管理页提供安装、启停、编辑与重载，v3 同时允许针对单个包使用已有原生更新动作。隐藏应用自己的 pi-harness 项和 standalone 文件；Pi 只展示 Desktop 内置版本，不允许独立升级锁定 SDK。自动检查在管理页进入后按已有六小时间隔执行；安装策略明确为手动，未增加后台安装行为。浏览器回归覆盖开关实际落盘、更新页项目过滤、MCP JSON 编辑以及 390px 布局。


## Extensions v3（第 8 版设计）

浏览 pi.dev 改为紧凑列表，点击行展开唯一详情，按钮独立触发预览或原生更新。搜索按 300ms 防抖提交名称、作者或描述关键字，分类与排序、翻页均通过目录服务。总数来自原站计数，缺失时只显示本页数量。描述有中文字段时优先使用中文，否则保留原文；自动翻译尚未启用，不额外调用模型。

只读 `details` 动作复用来源校验及 npm 元数据读取，返回 `ExtensionPackageDetails`，不签发安装 ticket、不安装或执行包。展开资源标签统计 manifest 显式声明项；目录或通配符不推断实际文件数量，未提供声明时提示未知。许可证未声明时显示未知。请求带 AbortSignal，切换展开项忽略迟到响应。来源预览仍独立签发 ticket，并保留作用域、信任、版本与写任务互斥校验。

包安装状态按原生 npm 声明匹配，同名多作用域时优先选择可更新的受信任、未固定且非保护条目，按钮将其 ID 传给原生更新流程。其他已安装项只显示已安装，不从目录 latest 推断更新资格。安装确认保持 480px 弹窗，展示资源声明、个人/项目设置路径及命令预览；未信任项目不可选择。任务运行时保留弹窗并锁定操作，失败保留日志末尾，重试重新预览获取 ticket，成功后返回已安装列表并标注新包。

已安装页签数量仅统计包，不包括单文件；文件保留路径、打开/复制、重载、开关和展开编辑。键盘支持页签方向键、弹窗焦点循环及关闭后焦点恢复。更新页继续隐藏 pi-harness 和单文件。扩展回归同时覆盖失败重试、详情只读权限、中英文、深色与 390px 窄屏。

#46 回归：`tests/extensions-worker-test.mjs` 在真实 npm 卸载后的 SettingsManager.reload 注入无活跃句柄的异步等待，证明 IPC 不会提前退出；这用于生命周期故障注入，不表示已还原用户原始机器的具体触发条件。另有普通 Node / Electron 原生卸载和并发 HTTP 列表测试。

数据库查询由原生内置扩展 `pi-harness-database` 提供 `database_read`，权限绑定显式附加连接的当前会话；连接与只读执行见 [数据库工作台](architecture-database.md)。

Pi 1.5 的包安装失败会出现在原生资源加载器 warnings 中。会话首次绑定和重载后，WebUI 将 warnings/errors 发送到带 conversationId 的通知；首次 socket attach 前暂存通知。兼容入口仍支持用户扩展从 pi-ai 导入 Type/StringEnum，迁移限制见 [升级说明](pi-1.5-upgrade.md)。

## 独立 Pi CLI 检测与安装

管理页调用只读 `cli-status` 动作，检测服务主机的 Pi、Node.js、npm；探测固定 `--version` 参数，5 秒／16 KB 限制，过滤 PATH 中的相对目录和依赖 `.bin` 目录，避免将内置 SDK 当成外部 CLI。不缓存结果，打开页面或重新检测即刷新。缺失与无法运行分开显示，Node.js 至少 22.19 且 npm 可用才开放安装。

用户点击后通过现有终端桥运行 `npm install -g --ignore-scripts @earendil-works/pi-coding-agent@latest`，安装独立 CLI，不改变内置 SDK 或社区包。当前对话已有同安装命令的运行中终端时只定位，不重启；终端结束后可重新运行。安装日志保持可见，返回管理页重新检测，不以输出文本或终端创建判定成功。权限／网络／PATH 提示不自动提权、不改系统 PATH、不捆绑或自动安装工具。HTTP 类型定义在 protocol.ts，不新增 WebSocket 消息。
