# Pi 1.5.0 升级契约

本次将 `@earendil-works/pi-coding-agent`、`@earendil-works/pi-ai` 精确锁定到 1.5.0，宿主 `undici` 锁定到 8.12.3。内部 agent-core、schema、tui 同步为 1.5.0；生产 SDK 与宿主共用 undici 8.12.3。Electron 保持 41.10.7，适配验证时应用版本为 1.11.1，随后按用户发布请求纳入 v1.12.0 GitHub 桌面 Release；不发布 npm。

## 变化与接入

依据安装产物的 `CHANGELOG.md`、`dist/auth/types.d.ts`、`dist/utils/validation.js`、扩展兼容入口以及[官方 v1.5.0 发布说明](https://github.com/earendil-works/pi/releases/tag/v1.5.0)。前一轮契约见 [1.4 升级记录](pi-1.4-upgrade.md)。

| 上游变化 | 宿主处理 |
| --- | --- |
| pi-schema 校验取代 TypeBox 校验 | 保留现有 TypeBox JSON Schema 定义及业务层权限检查；测试普通 Schema 和 TypeBox 的执行准入、转换和错误边界，不匹配完整错误文案 |
| pi-ai 根入口不再导出 TypeBox | 本项目继续直接从 typebox 导入；用户扩展由 SDK 的 pi-ai-extension-view 兼容 Type/StringEnum，包内首次加载和 reload 都做验证 |
| 提示词精简 | 两个内部适配器的精确保护更新为 1.5.0；仍使用原生构建结果和全文一致性校验；不匹配时只读回退，模板失败保留草稿 |
| 设备码操作标志 | ProviderAuthState 增加 openBrowserOnConfirm/copyCodeOnConfirm，协议 49 → 50；缺省均为 true，只在按钮点击时执行，阶段切换清除旧设备码及标志 |
| 扩展安装失败诊断 | 读取资源加载器 warnings/errors；首次连接前缓存，连接和重载后通过现有带会话归属的 notice 显示 |
| MCP OAuth 注册策略 | 原生 JSON 校验接受 auto/dcr/cimd，省略字段不写回默认值；保留凭据掩码、版本冲突和项目覆盖机制 |
| 流式参数、搜索、持久化及服务商修复 | 随原版 SDK 获得，复用消息投影、恢复、取消和 agent_settled 生命周期；大参数预览仍受宿主长度限制 |
| 新模型、费用和实际响应模型 | 使用原生目录与费用，不改变选定模型或 openai-codex 展示过滤策略 |
| TUI、CLI 自更新、扩展更新日志 | 不移植到宿主界面，不改变 Electron 更新流程 |

没有 SDK 补丁，没有自动改写用户扩展、凭据或历史会话。未新增宿主自动重试或模型调用。

## 第三方扩展迁移

工具参数必须是可表达为 JSON Schema 的约束。`Type.Refine()`、`Type.BigInt()`、`Type.Undefined()`、codecs 和 `Format.Set()` 自定义格式不再参与原生工具校验；需要改成标准 JSON Schema，并将不能表达的检查放入执行前业务校验。普通 JSON Schema／MCP 同样会发生类型转换，因此执行层不能假定收到的是模型原始 JSON。

扩展仍可通过原生加载器从 pi-ai 导入旧式 Type/StringEnum；这不表示 pi-ai 的普通 Node 根入口恢复这些导出。扩展对宿主提供的 Pi 包应声明 `peerDependencies: "*"`，避免自身安装的副本绕过兼容入口。

## 验证记录（2026-11-03，macOS arm64）

所有运行测试使用临时配置、数据和本地模拟服务，未调用付费模型，未停止用户实例。

- `check:lockfile`、`check:protocol`（v50）、`check:testenv`、`typecheck`、`build`：通过。
- 零 token 冒烟：原清单 91/91 通过；新增 schema／扩展诊断脚本另跑 2/2 通过，共 93 项。覆盖原生提示词、Codemode 排队/取消、子代理报告、会话恢复、MCP 配置/脱敏、代理 CONNECT/OAuth/WebSocket、发送回执和终端。
- `npm test`：155 个测试文件通过；1006 项通过、1 项跳过。包含模板投递、提示词一致性及新增 MCP 注册策略保留测试。
- `pi-150-sdk-test.mjs`：TypeBox 和纯 JSON Schema 的必填缺失、类型、枚举、长度、可选/null、数字字符串和单值数组；通过真实 runToolCall 证明非法参数不执行；大规模 Unicode/转义分片参数和有界 WebUI 投影通过。
- `extension-diagnostics-test.mjs`：注入原生包解析安装失败及真实扩展加载失败，验证首次 attach 和 reload 通知；没有访问 registry。以上两个脚本已加入默认冒烟清单。
- `provider-auth-test.mjs`：五组操作标志（含缺省）、重放、阶段清理、取消、过期响应和凭据隔离通过。
- `native-features-browser-test.mjs`：中英文设备码确认、四组显式标志及缺省、重放无副作用、剪贴板拒绝后的手动复制提示、授权码提交和取消通过。
- `current-file-protocol-test.mjs --browser`：冻结编辑器快照、附件实际投递、历史与编辑重问通过，文件磁盘内容不变。
- `electron-builder build --mac --publish never`：arm64 DMG 和 ZIP 构建通过。`asar: false`、服务子进程及原生模块构建方式保持。
- macOS 包内 `native-tools-desktop-test.mjs`、`packaged-server-start-test.mjs`、`provider-auth-test.mjs`：通过。验证包内 ESM 依赖解析（含 pi-schema）、Codemode worker/WASM、SDK 文档和模型运行资源、旧 Type/StringEnum 扩展首次加载/reload、懒加载 OAuth、终端与服务启动；依赖定位不得借用开发仓库。

Windows、Linux 真机安装包、Windows 路径大小写与旧版安装程序升级恢复未在本机执行，须由对应平台 CI 及升级验收验证；已有三平台发布工作流会执行增强后的包内测试。v1.12.0 发布阶段由 GitHub 工作流执行上述平台检查，结果以对应 Actions 运行为准。真实服务商 OAuth/MCP 注册和账号计费未验证，模拟测试不代表真实账号授权成功。macOS 安装包为原有 ad-hoc 签名，未公证。
