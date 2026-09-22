# 数据生命周期

应用自有持久化文件由 `electron/data-manifest.cjs` 统一登记。恢复出厂设置会删除：

- `settings.json`、`.bak`、`.tmp` 和 `privacy.json`
- 记忆、进化、会话、NapCat 联系人/聊天/媒体与撤销快照
- `session-log.jsonl` 及两个轮转文件
- 渲染端 localStorage 与已登记 IndexedDB 媒体库

会话日志采用 8 MB 单文件、最多 3 个文件、默认保留 7 天的轮转策略；
关闭开关后只留在有界内存，退出即丢弃。工具数据独立处理，包含下载目录、
工具登录态、截图目录和 DocFlow 运行时目录。

恢复出厂设置由主进程编排：先通知渲染端关闭 IndexedDB 并清除
localStorage，再停止 Agent/MCP/NapCat/日志写入，最后按清单删除
userData 内路径并二次核验。成功则重启应用；任一项失败时不得显示
「已全部清除」。
