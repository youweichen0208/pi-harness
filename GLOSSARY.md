# Glossary

## Wiki 对话（Wiki conversation）

绑定一篇工作区 Markdown 的问 pi 对话，拥有独立于普通聊天的历史。切换文档时进入目标文档自己的对话；可以在当前文档基础上追加一个 Workspace 项目／知识库进行分析，切换文档清空该追加选择。
_Avoid_: 临时 Wiki 会话、一次性会话

## 文档引用（document reference）

用户明确选定、供当前 Wiki 对话提问时参考的文档。当前文档引用固定对应此对话绑定的 Markdown。

## Wiki mode

在独立顶层窗口中阅读和编辑工作区文档、并通过 Wiki 对话向 pi 提问的工作模式。主窗口保持普通对话，退出 Wiki mode 即关闭文档窗口。

## 发送回执（prompt receipt）

普通聊天与 Wiki 对话中，一次发送请求的接收结果记录；它说明请求的接收事实，不表示模型任务已完成或排队请求能在重启后继续。无法确认接收结果时记为未知，不等同于发送失败。
_Avoid_: 完成回执、任务结果

## Playground

用于编辑、运行 Python 脚本和测试函数的工作台，也提供对话与小记代码块的运行入口。结果展示在界面中，不自动进入模型上下文。
_Avoid_: 沙箱、REPL、在线运行器、代码小记

## Run

Playground 的一次执行，有独立标识和终态（成功、失败、超时）。结果不持久化，代码块内容改变即失效。
_Avoid_: 任务、会话、进程

## Playground 草稿（Playground scratch draft）

Playground 草稿页中保存的 Python 代码、运行模式及函数测试用例。每个安装共享一份，离开草稿页后仍可继续编辑；Run 的输出不属于草稿。
_Avoid_: Run 历史、项目源文件

## 本地知识库（local knowledge base）

一个单独配置的本地文件夹及其文档内容，在独立 Wiki 窗口中浏览和编辑，不依赖 Workspace 项目分组；子目录是文档分类，不是独立知识库。
_Avoid_: Workspace 知识库项目

## 表格结构编辑（table structure editing）

在富文本编辑器里改变表格形状的操作：增加或删除行、增加或删除列，以及删除整张表格。它只改变结构，不改单元格文字。
_Avoid_: 表格编辑（与“编辑格子里的文字”混淆；这个含混曾让入口被当成冗余删除）

## 表格目标（table target）

一次表格结构编辑所作用的对象：整张表格、某一行或某一列。表格目标是独立于文本选区的编辑器状态，选择它不移动光标，也不改变文档内容。
_Avoid_: 选区（文本选区是另一回事）、当前单元格

## 富文本片段（rich document fragment）

富文本编辑中一个可编辑单元所对应的连续源切片。多数情况下就是一个 Markdown 顶层节点；手写 `<details>` 这类跨多个节点的构造会合并成一个片段，因此片段边界不等于 AST 节点边界。
_Avoid_: 块（块在代码里特指挂载用的 wrapper）、节点

## 单文件文档弹窗（single-document dialog）

普通对话中打开一篇 Markdown 的编辑弹窗；其中的 Agent Chat 属于主聊天，通过引用当前文档进行讨论和修改。正文与 Wiki 共用 `DocumentReading` 阅读画布，但不含对话归属信息（大纲、反链、属性表、“问 pi”）。
_Avoid_: 独立文档会话、知识库窗口

## 模型配置来源（Model configuration source）

用户已有模型连接信息的来源，例如 Pi、Claude Code、Codex 或 OpenCode 的配置。同一个模型连接可以同时具有多个配置来源。
_Avoid_: 模型服务商（配置来源不一定提供模型服务）

## 模型连接（Model connection）

通过特定接口和认证身份使用某个模型的配置，包含影响请求行为的协议、地址与能力声明。同名模型不一定是同一个模型连接。
_Avoid_: 模型名称（名称不足以区分连接）

## 本地独立配置（Local independent configuration）

由 pi-harness 用户单独维护、不再跟随原配置来源更新的模型连接配置。
_Avoid_: 同步副本（独立配置不再参与来源同步）

## Codemode 执行记录（Codemode execution record）

一次 Codemode 脚本执行过程中，实际发起的内部工具或模型调用及其执行状态。记录随调用发生而增加，不代表尚未执行的计划，也不等同于用户目标级任务。
_Avoid_: Codemode 待办清单、预计任务队列
