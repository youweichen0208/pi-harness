# Glossary

## 临时 Wiki 会话（ephemeral wiki conversation）

在 Wiki mode 下由打开文档创建的一次性会话：不进入会话树、不出现在左侧会话列表，携带该文档的当前文件 chip。切换文档或退出 Wiki mode 时连同服务端 transcript 一并销毁；运行中任务须先中断（确认框）才能销毁。与「持久会话」（会话树管理的普通对话）相对。页面刷新时保留并重新挂载，直到显式切换/退出才删除。

## Wiki mode

在独立顶层窗口中阅读和编辑工作区文档、并通过临时 Wiki 会话向 pi 提问的工作模式。主窗口保持普通对话，退出 Wiki mode 即关闭文档窗口。
