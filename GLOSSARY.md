# Glossary

## Wiki 对话（Wiki conversation）

绑定一篇工作区 Markdown 的问 pi 对话，拥有独立于普通聊天的历史。切换文档时进入目标文档自己的对话；可以在当前文档基础上追加一个 Workspace 项目／知识库进行分析，切换文档清空该追加选择。
_Avoid_: 临时 Wiki 会话、一次性会话

## 文档引用（document reference）

用户明确选定、供当前 Wiki 对话提问时参考的文档。当前文档引用固定对应此对话绑定的 Markdown。

## Wiki mode

在独立顶层窗口中阅读和编辑工作区文档、并通过 Wiki 对话向 pi 提问的工作模式。主窗口保持普通对话，退出 Wiki mode 即关闭文档窗口。

## Playground

挂在对话消息或小记代码块上的 Java 运行入口：把该代码块的内容交给宿主机器的 JDK 编译执行，并把输出展示回同一界面。它默认关闭、不是沙箱、结果不进入模型上下文。
_Avoid_: 沙箱、REPL、在线运行器、代码小记

## Run

Playground 的一次执行，有独立标识和终态（成功、失败、超时）。结果不持久化，代码块内容改变即失效。
_Avoid_: 任务、会话、进程
