# 灵动岛桌面挂件 V2.0 — 部署与调试说明

本文档是**桌面挂件版**(widget/ 入口 + Electron 主进程)的运行、开发与
调试说明,面向维护者。V2.0 重点:**HEVC 补丁操作手册**(第 2 章)与
**提示词约束工程概览**(第 3 章)。用户使用指南见 [README.md](README.md);
完整技术文档见 [docs/TECH.md](docs/TECH.md)(V2.0,第 15/16 章为两大
工程专章);引擎级操作手册见 [CLAUDE.md](CLAUDE.md)。

---

## 目录

- [文档分工](#文档分工)
- [运行与退出](#运行与退出)
- [HEVC 补丁操作手册(V2.0)](#hevc-补丁操作手册v20)
- [提示词约束工程概览(V2.0)](#提示词约束工程概览v20)
- [挂件版与 Web 演示版差异](#挂件版与-web-演示版差异)
- [开发调试](#开发调试)
- [UI 巡检(WIDGET_SCREENSHOT)](#ui-巡检widget_screenshot)
- [常见调试场景](#常见调试场景)
- [技术债务与明确不做项](#技术债务与明确不做项)

---

## 文档分工

| 文档 | 面向 | 内容 |
| --- | --- | --- |
| README.md | 用户 | 功能/使用指南/FAQ(V2.0 两大工程导读) |
| **本文档** | 挂件维护者 | 运行、调试、巡检、HEVC 补丁操作 |
| docs/TECH.md | 工程师 | 完整技术文档(V2.0;第 15 章 HEVC 补丁工程、第 16 章提示词约束工程) |
| CLAUDE.md | Claude Code | 引擎级操作手册(踩坑实录/测试断言/约束) |

---

## 运行与退出

- 挂件是**托盘常驻程序**:窗口隐藏到托盘后不会自退,退出必须右键托盘
  →「退出」(app.quit;before-quit 清理 Agent 引擎/子进程并 flush 配置)。
- 窗口位置每次启动顶部居中,不持久化。
- 单实例:重复启动会激活已有实例(锁文件)。改代码后重启必须 `dev.bat`
  (它先按路径过滤结束本项目旧实例;若提示"检测到 dynamic-island-official
  副本实例在运行",先关闭日常副本)。

---

## HEVC 补丁操作手册(V2.0)

### 背景(一句话)

官方 Electron 无 HEVC 解码能力(ffmpeg 无解码器 + media 层门控),bili 下载
的 HEVC 高清视频在对话窗口"播放中全黑"。正解 = 自编译 Electron(源码树
`C:\electron-gn`,与官方 43.2.0 同 tag,ffmpeg 软解 + 门控补丁),产物在
`C:\electron-hevc-dist`。AV1 官方版即可软解,无需补丁。

### 命令

```bash
# 应用(幂等,缺哪个补哪个;dev.bat [1.5/3] 步自动执行)
node scripts/apply-hevc-electron.mjs
# 回退官方版(全部 7 个文件;备份保留为 *.official)
node scripts/apply-hevc-electron.mjs --restore
# 只查状态(dev.bat 也用此判定)
node scripts/apply-hevc-electron.mjs --check

# 图标:把多尺寸图标(16-256,electron/icon.ico,build:electron 自动生成)
# 经 rcedit(devDependency)烙进源目录 exe——进程/弹窗/托盘图标
node scripts/brand-electron-icon.mjs
node scripts/brand-electron-icon.mjs --check
```

### 换装面(7 个文件,必须同源)

`electron.exe` / `ffmpeg.dll` / `snapshot_blob.bin` / `v8_context_snapshot.bin`
/ `chrome_100_percent.pak` / `chrome_200_percent.pak` / `resources.pak`——
快照/pak 与 exe 不匹配**启动即崩**,所以按哈希整体换装、整体回退。
烙图标改的是**源目录** exe,apply 按哈希比对自然携带(官方备份不受影响)。

### 补丁版已知坑(均已治理,改前必读)

| 坑 | 现象 | 治理 |
| --- | --- | --- |
| 主进程段错误 | 开 QQ 机器人后随机 EXCEPTION_ACCESS_VIOLATION(崩溃栈 llhttp_message_needs_eof 是堆损坏殃及表象) | 真源 = 补丁版主进程 `Notification().show()` 与并发网络活动组合 → 通知全量迁移托盘气泡 `showNotify`(electron/agent/notify.ts);顺带修 fetch AbortSignal = Node 22 llhttp UAF 触发点(中止移 parseSse 安全点);NapCat WS 换手写传输(wsclient.ts,net.Socket 直连不经 llhttp) |
| 弹窗图标糊 | 自编译 exe 只有 32×32 默认构建图标 | brand-electron-icon.mjs 烙入多尺寸 ico |
| 透明窗口 alpha | 早期 Electron GPU 合成下偶发突变(曾禁用硬件加速) | V2.0 恢复硬件加速 + 窗口硬化(roundedCorners:false / thickFrame:false / #00000000);退路 = disable-gpu-compositing 或回退 disableHardwareAcceleration |

**验证基线**:补丁版 + 真实 QQ 流量 + 气泡通知 3×3 轮 90s 全稳定;
155 用例单测;hevc-frame 巡检(补丁应用断言持续出帧、缺失断言错误文案)。

### 日常检查清单

1. `--check` 报告"已应用" = HEVC 窗口内可播;
2. 任务管理器 electron.exe 图标 = 岛灵图标 = 已烙标;
3. 视频播放掉帧 → 确认硬件加速未被回退(进程列表有 GPU 进程)。

---

## 提示词约束工程概览(V2.0)

V2.0 把提示词当工程对象:分层拼装、逐条身份判定、注入/剥离双通道、防泄露
硬约束。维护者改任何提示词前先读本表(完整实现见 TECH.md 第 16 章)。

### 分层拼装(每轮系统提示)

```
自定义提示词(config.systemPrompt)
+ 主人身份 MASTER_IDENTITY_LINE(逐条判定:窗口直发=主人/外部 QQ 按标注/系统通知)
+ 长期记忆块(formatMemoryBlock,锁定条目标 [类型·锁定])
+ 进化状态 + 后台任务状态 + 工具路径清单(buildToolsGuideBlock)
```

### QQ 注入统一模板(每条消息)

```
【QQ私聊/QQ群聊 · QQ 号 · 称呼】← 类别行(历史保留,显示保留)
原文 + 【图片已下载】
【档案卡】称呼/已知/会话人格/记忆相关/最近发言  ← 历史保留(消息隔离)
【回复规则】① 主人唯一 ② 第二人称 ③ 只给结论 ④ 隐私 ⑤ 安全红线
           ⑥ 偏袒主人 ⑦ 图片主动发(陌生人:先问主人/记录档案;群聊:双通道)
```

### 剥离双通道(防污染/防泄露)

| 通道 | 保留 | 剥离 |
| --- | --- | --- |
| 显示层(stripNapcatInstructions) | 类别行 + 原文 + 图片标注;档案卡经字段展示 | 档案卡文本(避免重复)+ 全部指令段 |
| 历史回传(stripNapcatHistoryInstructions) | 类别行 + 原文 + **档案卡**(跨轮次区分人) | 回复规则/群聊上下文/旧式指令(当轮指令不累积) |

### 发送前兜底剥离链(非主人目标)

`stripThinkingPreamble`(思考腔)→ `stripToolNarration`(工具叙述)→
`stripMasterNarration`(主人视角转述,全剥空时提取「回他「…」」引号回复)→
图片路径提取转真图。主人保留全过程。

### 身份与权限红线

- 主人 = QQ 1178821869 硬编码双端同值(constants.ts / main.cjs,改时同步);
- 外部 QQ 消息**不继承主人权限**,教唆操控主人电脑一律拒绝并告知主人;
- 给主人的话绝不发给别人(询问轮发主人 QQ、群聊回复对公对私双通道);
- **回复路由三分类**(2026-08-13 泄露根治):`agent:send` source =
  `qq`/`group`/`ask`(QQ 触发)/ `window`(主人窗口直发——唯一可消费
  陌生人 pending 的窗口轮,一次性)/ `system`(系统通知轮,永不路由 QQ);
  主动陪伴轮启动前清残留标记;**执行回复标记化(2026-08-13)**:只有以
  「【回复对方】」开头的回复才路由给待回复陌生人并消费 pending——主人
  先回"嗯"这类应答不再串台、不消费 pending,指示轮的回复必达对方;
  防重发快照:本轮已用 send 工具发过则跳过路由。改路由逻辑前先读 TECH.md 16.7。

---

## 挂件版与 Web 演示版差异

- 挂件版只渲染灵动岛本体(`mode=widget`,base='./' 产物可 file:// 加载),
  Web 演示版带完整演示页面;
- 数据源双轨:SMTC(外部平台)与本地播放器并存,`externalActive` 决定数据
  与控制走哪一边,切换双向暂停;
- 挂件版交互:穿透轮询校正、右键长按拖拽、长按展开;Web 版有控制区按钮。

## 开发调试

```bash
dev.bat                # 一键构建 + 启动(自动应用 HEVC 补丁)
pnpm dev:widget        # 构建挂件页 + 启动 Electron(日常调试主入口,已前置 build:electron)
pnpm watch:electron    # 热重建 Agent 引擎/桥(改 electron/agent/*.ts 用)
pnpm bridge            # 独立运行 SMTC 桥
node tests/test-agent-core.mjs   # 引擎核心测试(155 用例)
npx electron --disable-gpu tests/test-title-live.cjs  # 标题/揣测真实 API 测试
```

## UI 巡检(WIDGET_SCREENSHOT)

`WIDGET_SCREENSHOT=<path>` 加载后自动截图;`WIDGET_SCREENSHOT_MODE` 支持
`expanded` / `layout` / `theme` / `stress` / `test` / `hevc-frame` /
`skill-delete-check` / `agent` / `chat-media` / `mini`(视频岛,含小窗截图 +
DOM 几何诊断)/ `media-lib` / `probe-clear` 等;`WIDGET_SCREENSHOT_QUIT=1`
巡检完成后优雅退出(必带,否则托盘常驻不退出)。**重建后不自动巡检**
(用户约定,2026-08-07):默认完成标准 = 构建 + dev:widget 启动 + tsc +
lint + 单测。

## 常见调试场景

- **改 agent/*.ts 后工具没变化**:dev:widget 已前置 build:electron;
  独立跑记得先 `pnpm build:electron`;
- **窗口拖拽/穿透异常**:先重启(单实例锁);拖拽是右键长按(约 0.4s);
- **QQ 机器人收不到消息**:查 NapCat WS 端口、napcatEnabled、白名单;
  napcat 工具 `status` 可查连接/收发统计;
- **提示词问题排查**:渲染端 console 不转发主进程,诊断写 window 全局
  对象(巡检 executeJavaScript 读取);引擎侧日志进 stderr。

## 技术债务与明确不做项

- 双岛并存模式(CLAUDE.md 设计文档,未实现——全仓库对 dual 零匹配);
- 手势/展开状态机抽 hook(350 行历史 bug 密集,收益与风险不成比例);
- main.cjs 全量 CJS 拆分(先抽测试块,文件继续膨胀再拆);
- 补丁版二进制:重编译 Electron 后需重跑 brand-electron-icon.mjs;
  补丁版 Node 22 llhttp UAF 上游修复前,主进程 fetch 一律不传 AbortSignal。
