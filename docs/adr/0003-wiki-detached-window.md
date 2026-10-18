# 3. Wiki mode 独立窗口

日期：2026-10

## 状态

已接受（取代 ADR-0002 第 1 条的「同窗口全屏视图」，临时会话等其余决策不变）

## 背景

ADR-0002 把 Wiki 从模态弹窗改为替换主视图的全屏视图，目标是「一边写文档、一边在 normal 对话里干活」。但全屏视图仍在**同一个窗口**里：进入 Wiki mode 后主窗口的 normal 对话被整个替换，切项目、看其他会话都得先退出 Wiki——窗口层面并没有分离，初衷并未真正达成。

## 决策

进入 Wiki mode 打开一个**独立顶层窗口**，主窗口停留在 normal 对话：

1. URL 即窗口契约：`/?wiki-window=1&cwd=<工作区>&doc=<文档路径>`（`web/src/wiki-window.ts`）。Web 端 `window.open` 弹出式窗口（命名目标 `pi-wiki`，重复进入复用并导航到新文档）；桌面版主进程创建第二个 `BrowserWindow`，同一时刻只保留一个。
2. 每个窗口是独立客户端：Web 端靠 sessionStorage 天然隔离；桌面版 preload 注入的 clientId 全 app 固定，Wiki 窗口的 `getClientId()` 忽略它改用窗口级 sessionStorage，避免两个窗口挂到同一 ClientSession 互为镜像（issue #10）。
3. Wiki 窗口启动后按 URL 参数自举：工作区不符先 `set_cwd`，再创建临时 Wiki 会话进入 Wiki 视图；刷新仍走 sessionStorage `pi-wiki-view` 恢复。
4. 退出 Wiki mode = 关闭窗口（不做锚点回切）；脏草稿守卫与运行中断确认照旧。窗口关闭后客户端断开，临时会话由闲置客户端逐出（`evictIdleClients`）清理。
5. Electron 主进程泛化为多窗口：窗口集合 + 按窗口的关闭守卫与全屏状态，IPC 归属按 `BrowserWindow.fromWebContents` 校验而不再硬编码主窗口。

## 后果

- 用户可以同时编辑文档并在主窗口（任意项目）继续对话，达成 ADR-0002 的初衷。
- 应用内全屏 Wiki 视图不再是主窗口可达状态；Wiki 视图代码由独立窗口复用，同一套 `WikiWorkbench`、保存与守卫逻辑不变。
- Electron 主进程需要维护窗口集合；新增窗口类型时沿用 `wireAppWindow` 接线。
- 回归更新：`tests/wiki-modal-browser-test.mjs` 入口断言改为弹窗；新增桌面多窗口回归。
