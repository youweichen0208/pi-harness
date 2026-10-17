# Glossary

## 临时 Wiki 会话（ephemeral wiki conversation）

在 Wiki mode 下由打开文档创建的一次性会话：不进入会话树、不出现在左侧会话列表，携带该文档的当前文件 chip。切换文档或退出 Wiki mode 时连同服务端 transcript 一并销毁；运行中任务须先中断（确认框）才能销毁。与「持久会话」（会话树管理的普通对话）相对。页面刷新时保留并重新挂载，直到显式切换/退出才删除。

## Wiki mode

替换主视图的全屏 Wiki 工作台视图，与 normal 视图经顶栏切换。锁定进入时的工作区，normal 视图切换项目不影响它；normal 视图的项目状态独立保存，退出 Wiki mode 回到进入前的最后项目。
