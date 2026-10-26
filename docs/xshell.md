# Xshell 7 与 SSH 连接手册

Xshell 是 Windows 上独立的 SSH 客户端。它可以连接与 pi-harness 内置 SSH 节点工作台相同的 Linux/macOS 服务器，pi-harness 可读取并同步 Xshell 7 会话，手动补填的认证信息由本应用单独保存。Xshell 不承载 pi-harness 的节点 Agent 对话。

## 用 Xshell 建立会话

1. 打开 Xshell，选择「文件 → 新建」（File → New）。
2. 协议选择 SSH，填写会话名称、远端主机名或 IP，以及 SSH 端口（通常为 `22`）。
3. 在会话属性的「连接 → 用户身份验证」填写用户名，并选择密码或公钥认证。若用公钥认证，在 Xshell 中指定**Xshell 客户端本机**可用的私钥；远端账号需已安装对应公钥。
4. 连接时，核对服务器主机密钥指纹，再决定是否接受。服务器换钥时先独立核实，不要直接覆盖旧信任。
5. 登录后可在 Xshell 的终端中运行 `pwd` 和 `whoami`，确认当前目录与远端账号。

界面名称可能随 Xshell 版本和语言变化。具体菜单和认证选项以 [Xshell 官方手册](https://www.netsarang.com/docs/Xshell7_manual.pdf) 为准。

## 与 pi-harness 工作台并用

在 pi-harness 顶栏打开「SSH 节点」，选择「Xshell 7 导入」。同一台 Windows 上会检测当前用户 Documents（含 OneDrive）下的默认会话目录；自定义目录可点「浏览」选择。预览后接入全部节点，开启自动同步时每 5 秒刷新，后续新建的会话也会加入。

点击节点的「打开工作台」时，优先使用 Xshell 7 保存的密码或可读取的兼容私钥。运行服务的 Windows 用户需与保存会话的用户相同。启用主密码时输入一次以解锁当前来源；解锁信息仅保存在当前服务内存，重启后需要重新输入。首次连接仍需核对主机指纹。

缺少信息或格式不兼容时，在「SSH 用户身份验证」中选择密码或公钥，填写用户名、密码或用户密钥及口令。用户密钥支持浏览本机文件，也可输入 OpenSSH 私钥路径；不能选择 `.pub` 公钥。勾选「记住」后，验证成功的凭据加密保存在 pi-harness，不修改 Xshell。这里保存的设置优先于自动读取；没有本机覆盖时，Xshell 中修改密码会用于下一次连接。

专用密钥库、Xagent、身份验证配置、代理和跳板机尚未完整适配，界面会说明原因。自动解码已有合成向量和本地 SSH 回归；Windows Xshell 7 实机导出会话的兼容验收仍待完成，不保证所有构建和字符编码均兼容。

两者可以同时连接同一台服务器，但各自打开的 shell 拥有独立的目录与环境。在 Xshell 中执行的 `cd` 不会改变 pi-harness 标签的目录；pi-harness Agent 只使用工作台中当前选中的终端。

## 不使用 Xshell 时

Windows 与 macOS 都可以直接使用 pi-harness 的内置工作台。系统 SSH 命令也可用于先验证网络和账号：

```bash
ssh -p 22 user@your-host
```

更多工作台操作见 [内置 SSH 节点工作台手册](ssh-workbench.md)。
