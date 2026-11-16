# OMP worker 的 OpenAI 代理接线缺口

状态：2026-11-16，OMP 18.20.0 / Bun 1.4.4，原失败已经修复并通过 macOS 本地真实传输回归；Windows／安装包与真实账户验收仍待完成。这不是 Windows DeepSeek 复读根因的结论。修复执行结果见 [验证记录](review-data/omp-proxy-fix.json)。

## 修复前的实际请求证据

在已构建的隔离副本中运行，不覆盖正在服务用户的 checkout dist：

```sh
node tests/diagnostics/omp-openai-proxy-probe.mjs
node tests/diagnostics/omp-openai-proxy-probe.mjs --native-control
```

修复前，第一条使用实际 `OpenAIProxySettings.install()`、OMP worker 和 OpenAI-compatible 模型请求。两次结果一致：代理 CONNECT 为 0，模型服务收到请求为 0，官方域名直连尝试被夹具阻止，助手以 error 结束，断言退出码为 1。

第二条只在隔离诊断 worker 的 preload 中设置原生 `PI_PROXY`。相同模型、任务、证书和代理得到 1 次 CONNECT、1 次模型请求、零官方域名直连，真实原生响应为 `OMP_PROXY_VERIFIED`，退出码为 0。它证明原生传输支持代理，不是生产修复。Node 宿主原有代理回归也通过。

所有供应商凭据均为夹具值。preload 拦截未显式走夹具代理的非 loopback fetch；代理仅允许 `api.openai.com:443` 并映射到本地 TLS 服务。原生启动时其他 catalog fetch 同样被阻止，计数与官方 OpenAI 请求分开，不将后台目录探测误算为这个功能的请求。日志仅输出目的主机、计数和状态，不输出头、令牌或项目内容。详细日志摘要与哈希见 [验证记录](review-data/omp-proxy-probe.json)。

## 修复前确认的边界

- `server/index.ts` 安装的是 Node 进程里的 Undici dispatcher。OMP 模型、OAuth 和后台子任务在 Bun 进程里执行。
- `OmpBootstrap` 没有应用代理配置；`prepareLaunch` 也没有相应接线，并会移除继承的 `PI_*` 环境选择器。设置面板成功保存不表示原生模型请求使用该代理。
- OMP 的 `getProxyForProvider` / `getProxyForUrl` 使用原生环境配置；测试中的显式原生配置可以工作。
- 原生 Responses 的 `inspectUpgradeResponse` 分支使用 Bun 内建 `require("ws")`；它不通过 `globalThis.WebSocket`。另有普通全局 WebSocket 路径。只替换 fetch 或全局 WebSocket 都不足以覆盖完整传输。

原失败结果保留于 omp-proxy-probe.json。修复后的原入口转到 tests/omp-openai-proxy-test.mjs，仍要求真实模型请求经过代理并完成；它已加入通过型 smoke，没有将原失败改为“预期失败”。

## 修复必须保留的行为

应用代理当前只针对默认 TLS 端口的 `api.openai.com`、`auth.openai.com` 和 `chatgpt.com`。直接把上游代理 URL 写入全局 `PI_PROXY` 会扩大路由范围，不能直接作为迁移完成；自定义网关、其他供应商和本地回调需要保留现有网络路径。

接线需使用公开 SDK／运行时接口，覆盖模型 HTTP/SSE、原生 OAuth、普通 WebSocket 及 inspectable `ws`，不修改 SDK 模块。代理不可用时不得自动直连；保存配置后的重启语义应对现有和新建 worker 一致，不能因创建新对话或 `/reload` 提前部分生效。还需验证普通、Wiki、受限业务、后台子任务的归属，以及 Stop／退出后的连接和子进程清理。

真实账户 OAuth、Windows 网络、原 DeepSeek 任务和当前安装包验收仍需单独完成。


## 当前接线

宿主在启动时捕获配置，传给之后创建的 worker；保存设置不会改变该快照，需重启服务。每个启用代理的 worker 建立两个只绑定 127.0.0.1、使用随机认证值的临时转发入口，通过 Bun／OMP 原生 HTTP_PROXY 与 HTTPS_PROXY 使用它们。两个入口分别处理 HTTP／ws 和 HTTPS／wss，即使 WebSocket 使用 CONNECT 且目标为非默认端口，也不会混淆原本的 HTTP 与 HTTPS 代理。

默认 TLS 端口的三个官方域名连接配置的应用上游代理，TLS 字节原样转发；其他目标依照该 worker 启动时已有的 HTTP(S)_PROXY／ALL_PROXY 与原生旁路规则处理。HTTP 请求去除本地转发认证头；私有认证值不进入模型或界面事件。上游拒绝或连接失败返回失败，不再尝试直连。关闭时销毁所属请求和连接，另一 worker 独立运行。

原生 NO_PROXY 和显式每请求代理仍保持原生优先级，因此明确的旁路配置可以绕过此转发层；这与代理失败后的自动直连不同。没有修改用户环境、系统代理或 SDK 文件，只在 OMP 子进程内设置临时原生网络入口。

当前回归覆盖实际 OMP 请求、保存后新建的 Wiki／SSH／Playground／认证 worker 仍沿用启动配置、停止会话隔离，以及原生 OAuth refresh、普通与 inspectable WebSocket、明文自定义 WebSocket、HTTP/HTTPS 上游、非默认端口、自定义环境代理、重定向、无认证拒绝和失败关闭。旧宿主浏览器夹具同步改为 OMP models.yml/config.yml 和当前模型菜单文案，保留设置保存、重启提示与鉴权检查。真实账户登录和三平台包验收不由这些本地夹具替代。

补充验证：完整本地冒烟 114/114 通过后，额外发现带认证的环境代理 URL 会让 Node-compatible http.request 自动生成目标 Authorization。现已对传入地址清除用户名密码，仅在 Proxy-Authorization 中发送上游凭据，保留原本的目标 Authorization；真实 HTTP 转发与 CONNECT 失败／修复回归已纳入专项。最终构建、类型、1061 项单测（1 跳过）、3/3 代理专项和浏览器再次通过。未完成 TLS 模型流的 Stop 及另一 worker 继续也已加入回归；整套 114 项未在此补修后重跑。
