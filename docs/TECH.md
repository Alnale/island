# 灵动岛挂件 · 技术文档

> 版本:v1.0 · 更新:2026-08-10 · 配套代码:dynamic-island(桌面挂件 + Web 演示版双入口)
>
> 本文档是灵动岛桌面挂件(Windows)的完整技术说明——架构设计、模块实现、
> 交互细节、踩坑记录、测试体系与调试工具。同时作为 Agent 模式的功能引导
> 知识库:LLM 对话中可调用 `get_feature_guide` 工具按话题读取本文档章节,
> 向用户介绍灵动岛有什么功能、怎么用(见「第 11 章 功能清单与使用引导」)。

---

## 目录

- [第 1 章 项目概述](#第-1-章-项目概述)
- [第 2 章 构建与运行](#第-2-章-构建与运行)
- [第 3 章 音乐模式](#第-3-章-音乐模式)
- [第 4 章 Electron 主进程](#第-4-章-electron-主进程)
- [第 5 章 Agent 引擎](#第-5-章-agent-引擎)
- [第 6 章 渲染端](#第-6-章-渲染端)
- [第 7 章 灵动岛设置工具](#第-7-章-灵动岛设置工具)
- [第 8 章 测试体系](#第-8-章-测试体系)
- [第 9 章 调试与巡检](#第-9-章-调试与巡检)
- [第 10 章 关键约束与踩坑记录](#第-10-章-关键约束与踩坑记录)
- [第 11 章 功能清单与使用引导](#第-11-章-功能清单与使用引导)

---

## 第 1 章 项目概述

### 1.1 项目定位

灵动岛挂件是一个 Windows 桌面悬浮小程序,把 iOS 灵动岛的形态与交互带到
Windows 桌面。程序常驻屏幕顶部,是一个透明无边框的小窗口,平时收起为一条
"胶囊"(56px 高),自动感知系统正在播放的音乐(经 Windows SMTC,支持
QQ音乐 / 网易云音乐 / 酷狗 / 酷我 / 汽水音乐 / 浏览器标签页音频等),展开后
变成音乐控制面板;也可以切换为 **Agent 模式**,变成"岛灵"——一个常驻桌面的
LLM 助手,直接对话即可让它执行本机操作(命令、文件、浏览器、搜索、通知、
B站查询与下载、文档转换、超星答题等),并挂载 MCP 服务、技能、长期记忆、
自我进化等能力。

两个核心语义:

1. **音乐模式** —— 系统媒体的"好看的控制面板"。数据源优先外部平台
   (SMTC 监听),本地播放器兜底;支持歌词字幕、进度拖拽、播放模式、主题色、
   自定义背景、字体库、时间粒子等。
2. **Agent 模式** —— 常驻桌面的"岛灵"。对话式 LLM 助手 + 本机工具执行
   (无沙箱),记忆、技能、MCP、进化、主动陪伴、后台任务等一整套能力。

### 1.2 技术栈

| 层 | 技术 | 说明 |
| --- | --- | --- |
| 桌面壳 | Electron 43 | 透明无边框窗口、托盘、SMTC 桥接 utilityProcess |
| 渲染 | React 19 + TypeScript + Vite | 双入口共享一个岛体组件 |
| 构建 | esbuild | Electron 侧 agent.cjs / bridge.cjs 打包(零第三方依赖) |
| 系统媒体 | Windows SMTC | PowerShell 读取 + C# WinRT 桥接 |
| LLM | DeepSeek / Anthropic API | Responses(默认)/ Chat / Anthropic Messages 三 provider |
| 存储 | localStorage + IndexedDB + settings.json | 参数 / 媒体数据 / 引擎配置 |
| 测试 | node 直测 + esbuild 打包 | 引擎核心测试 / Markdown 解析器测试 / UI 巡检 |

### 1.3 目录结构

```
dynamic-island/
├── src/                        # Web 演示版 + 共享组件
│   ├── components/DynamicIsland/
│   │   ├── DynamicIsland.tsx   # ★ 两端共享的岛体组件(核心)
│   │   ├── base.css            # 基础样式(布局/动画 keyframes)
│   │   ├── layout.ts           # 布局常量与计算
│   │   ├── views/              # 各面板视图
│   │   │   ├── AgentView.tsx           # Agent 聊天面板
│   │   │   ├── AgentMessages.tsx       # 消息组件群(气泡/工具卡片)
│   │   │   ├── AgentSettingsView.tsx   # Agent 设置(连接/行为/工具/记忆)
│   │   │   ├── AgentMediaMini.tsx      # 收起面板后的媒体小窗(视频岛/图片岛)
│   │   │   ├── Markdown.tsx            # Markdown 渲染 + 媒体窗口/视频播放器
│   │   │   ├── MediaLibraryView.tsx    # 多媒体库(图片/音频/视频三库)
│   │   │   ├── SettingsViews.tsx       # 设置视图/背景/主题/字体/歌词 API
│   │   │   ├── QuickMenu.tsx           # 通用滚轮菜单组件
│   │   │   ├── WheelSwap.tsx           # 内容交换动画
│   │   │   └── markdownParser.ts       # 手写 Markdown 解析器(纯 TS)
│   │   ├── views-agent.css     # Agent 相关样式
│   │   └── views-settings.css  # 设置/库相关样式
│   ├── hooks/
│   │   ├── useAgent.ts         # Agent 事件流订阅与消息状态机
│   │   ├── useAgentPanelLayout.ts  # 面板高度/缩放状态机
│   │   ├── useIslandCustomizations.ts # 双宿主共享定制 hook
│   │   └── useIslandMedia.ts   # 双宿主共享媒体 hook
│   ├── media/
│   │   ├── backgroundStore.ts  # 自定义背景(IndexedDB 双槽位)
│   │   ├── fontStore.ts        # 字体库(IndexedDB)
│   │   ├── libraryStore.ts     # 音频/视频库(IndexedDB)
│   │   ├── uploadStore.ts      # 上传音乐(IndexedDB)
│   │   ├── useMediaPlayer.ts   # 本地播放器
│   │   └── lyricProviders.ts   # 歌词 API 桥接(QQ/网易/酷狗/酷我)
│   ├── agent/types.ts          # 渲染端类型(引擎类型镜像)
│   └── settingsBridge.ts       # ★ LLM 设置工具桥(window.__islandSettings)
├── widget/                     # 桌面挂件入口(挂件版专用)
│   ├── WidgetApp.tsx           # 挂件宿主(窗口/IPC/模式切换)
│   ├── WidgetApp.css           # 挂件样式
│   ├── widget.html / widget.css
│   └── desktop.d.ts            # preload 类型声明
├── electron/                   # 主进程 + Agent 引擎
│   ├── main.cjs                # 主进程(窗口/托盘/IPC/桥接调度)
│   ├── preload.cjs             # 预加载脚本
│   ├── agent.cjs               # esbuild 产物(引擎,不入库)
│   ├── bridge.cjs              # esbuild 产物(SMTC 桥,不入库)
│   ├── settings-store.cjs      # 设置持久化(原子写/加密)
│   ├── screenshot-tests.cjs    # UI 巡检(截图/断言,~1160 行)
│   └── agent/                  # Agent 引擎源码(TypeScript)
│       ├── engine.ts           # 引擎循环/工具执行/子代理/主动陪伴
│       ├── provider.ts         # 三 provider 统一入口
│       ├── deepseek.ts         # DeepSeek Responses API
│       ├── chat.ts             # DeepSeek Chat Completions(备选)
│       ├── anthropic.ts        # Anthropic Messages API
│       ├── sse.ts              # SSE 解析公共层
│       ├── tools.ts            # 内置工具注册表(命令/文件/搜索/B站…)
│       ├── settingsTools.ts    # 灵动岛设置工具(改挂件设置)
│       ├── configTools.ts      # 自我配置工具(MCP/技能/主动陪伴/预算)
│       ├── subagents.ts        # 总结标题/心理揣测/主动陪伴判断
│       ├── mcp.ts              # MCP 客户端(stdio/sse 双传输)
│       ├── skills.ts           # 技能扫描与注册
│       ├── memory.ts           # 长期记忆存储
│       ├── evolution.ts        # 自我进化 harness
│       ├── tasks.ts            # 通用后台任务注册表
│       ├── constants.ts        # 共享常量(零 node 依赖)
│       └── types.ts            # 引擎类型(零 node 依赖)
├── tools/                      # 外部工具(源码/脚本,dev 直跑)
│   ├── bili/                   # bili-tool(Rust 单二进制)
│   ├── xxt/                    # 超星答题(python 脚本)
│   └── docflow/                # 文档转换 Flask 服务(python)
├── scripts/
│   ├── test-agent-core.mjs     # 引擎核心测试入口(83 用例)
│   ├── test-agent-core.ts      # 引擎测试源码
│   ├── test-markdown.mjs       # Markdown 解析器测试(39 断言)
│   ├── test-agent/             # mock MCP 服务器等测试辅助
│   ├── build-electron.mjs      # esbuild 打包 agent/bridge
│   └── system-media-bridge.ts  # SMTC 桥源码
├── docs/TECH.md                # ★ 本文档
├── README.md                   # 用户向说明
└── WIDGET-README.md            # 挂件部署/调试说明
```

### 1.4 双入口共享一个组件

- `src/` —— Web 演示版入口(vite.config.ts),带完整演示页面,浏览器可直接
  调试岛体 UI,不依赖 Electron。
- `widget/` —— 桌面挂件入口(vite.widget.config.ts,`mode=widget`),只渲染
  灵动岛本体;`base='./'` 使产物可直接 file:// 加载。该构建模式下
  `src/media/tracks.ts` 返回空内置歌单、产物剔除 music 资源。
- **`DynamicIsland.tsx` 是两端共享的岛体组件**:行为差异全部靠 CSS 覆盖
  (widget/widget.css 的 `.widget-stage` 选择器)与可选 props 区分。
  改动组件时必须同时考虑 Web 版(App.tsx)与挂件版(WidgetApp.tsx)两个调用方。
- `tsconfig.app.json` include 含 `src` + `widget`;`pnpm build` 的 `tsc -b`
  同时检查两端。

---

## 第 2 章 构建与运行

### 2.1 常用命令

```bash
pnpm dev             # 仅 Vite Web 演示版(浏览器调试,不进 Electron)
pnpm dev:widget      # 构建挂件页面并启动 Electron(日常调试主入口;
                     # 已前置 pnpm build:electron——dev:widget 自动重建
                     # agent.cjs/bridge.cjs,改 electron/agent/*.ts 不会
                     # 静默跑旧 bundle;必须带 --mode widget,否则内置 MP3
                     # 会打进挂件歌单而音频文件又被 closeBundle 删掉,
                     # 出现"无法播放且无法删除"的损坏曲目)
pnpm build           # tsc -b 类型检查 + Web 版构建
pnpm build:widget    # 仅构建挂件页面 → dist-widget/
pnpm build:electron  # esbuild 打包 SMTC 桥(→ electron/bridge.cjs)
                     # + Agent 引擎(→ electron/agent.cjs)+ 生成图标
pnpm lint            # oxlint
pnpm bridge          # 独立运行系统媒体桥接脚本(单独调试 SMTC)
pnpm watch:electron  # 热重建 Agent 引擎/桥(监听 electron/agent/*.ts 与
                     # scripts/,自动 esbuild 重建 + 重启 electron;渲染端
                     # 仍用 dev:widget)
node scripts/test-agent-core.mjs   # Agent 引擎核心测试(后端直测,83 用例)
pnpm test:markdown    # 消息气泡 Markdown 解析器测试(39 断言)
```

### 2.2 开发流程与验证约定

- 日常调试:`pnpm dev:widget`(构建 + 启动 Electron)。
- **验证约定(用户要求)**:每次优化/修改代码后,自动重新构建并启动实机
  验证——默认执行 `pnpm dev:widget` 确认改动生效,配合 `timeout` 让应用
  几十秒后自动退出(托盘常驻不会自退)。
- **巡检约定**:重新构建后**不要自动跑 WIDGET_SCREENSHOT 巡检**——完整巡检
  (agent 模式等)只在用户明确要求时执行(每轮全量巡检耗时 8-10 分钟且依赖
  真实 LLM)。默认完成标准 = 构建 + dev:widget 启动 + 类型检查 + lint
  + 单测(`tsc -b` / `pnpm lint` / `node scripts/test-agent-core.mjs`)。

---

## 第 3 章 音乐模式

### 3.1 数据源双轨

`WidgetApp` / `App` 中 `useSystemMedia`(SMTC 外部平台)与 `useMediaPlayer`
(本地播放器)并存,`externalActive = system.active && system.track &&
useExternalSource` 决定数据与控制走哪一边。

- 切换数据源时**双向暂停**(切走的一方自动暂停,避免双声齐响)。
- 进度/时长/播放模式/曲目都按此分支取数。
- SMTC 播放模式以系统真实状态为数据源(轮询校准),点击循环后 1.2s 检测
  是否跟随,没跟随则提示并回退。
- 已知平台限制:QQ音乐等客户端可能不支持 SMTC 跳转/模式控制,点击后 1.2s
  检测未生效 → 岛内提示并回退(UI 显示系统真实状态)。

### 3.2 SMTC 桥接

- 桥以 `utilityProcess` 启动 `electron/bridge.cjs`(由
  `scripts/system-media-bridge.ts` 经 esbuild 打包),崩溃自动重启
  (10s 内 3 次上限)。
- 桥内部 smtc-reader 子进程同款上限(10s 内 3 次放弃,含 spawn error——
  脚本缺失时 spawn 只发 error 不发 exit,不处理会桥活着但 SMTC 永久死)。
- 读取端为 `electron/smtc-reader.ps1`,运行时用 `csc.exe` 编译
  `electron/smtc-bridge.cs`(Windows 11 26100 新版 API,引用
  System32\WinMetadata),异步等待用轮询 Status/GetResults(3s 超时防卡死)。
  PS 5.1 无法绑定 WinRT 集合元素,所以必须走 C# 强类型桥接。

### 3.3 位置平滑(useSystemMedia)

浏览器(Chrome/Edge 标签页音频)等平台的上报位置不可信(抖动或**阶梯式
过期**——冻结数秒后突然跳变,跟随会抽搐或周期性回跳)。显示进度 =
锚定基准 + 本地时钟流逝,常规轮询不跟随上报位置,仅重锚定于:

1. 曲目变化(标题 key);
2. 播放状态变化(暂停冻结在本地时钟位置、恢复继续,均不采信可能过期的上报);
3. 位置偏离 > 5s **且**上报位置距上次轮询移动 ≥ 2s("活着"判定,真实外部
   seek 才满足;浏览器冻结期移动≈0、更新瞬间偏差≈0,永远不满足)。

**恢复播放必须重置流逝基准**(`baseAtRef = now`):暂停冻结后 baseAt 停在暂停
时刻,恢复时 `position = base + (now - baseAt)/1000` 会把**暂停时长算进去**,
恢复瞬间时间突跳、显示比进度条长(用户实测)。轮询 `playChanged && smPlaying`
分支与 `control('play')` 都要更新;乐观切歌(next/previous)base 归零。

**seek 支持记忆**:用户 seek 在 `control()` 内立即乐观锚定,是否生效由
**挂起验证**判定(对照系统真实位置,±3s 或单次跳变 >5s 视为生效——后者覆盖
浏览器阶梯式更新,其位置块状前进可能永远不在目标 ±3s 内)。客户端明确拒绝
(`accepted === false`)或 **3s 超时**未跟随 → 回退显示、判定该平台不支持
seek 并返回 false。验证结果按 sourceAppId 持久化(localStorage
`island-seek-support`),切换平台/重启都不重学。

### 3.4 歌词系统

- **歌词定位单独成轨**(`lyricPosition`,与 position 分离):显示进度的 5s
  偏离阈值对原生客户端(每秒 +1s)永达不到,锚定后整曲自由漂移——歌词与
  实际播放偶尔快偶尔慢的根因。lyricPosition 每轮询重算:
  - 上报"活着"(移动 ≥ 0.5s,原生客户端每秒 +1s)直接采信上报,杜绝漂移;
  - 上报冻结(浏览器阶梯式过期)本地时钟插值兜底;
  - 暂停停最后位置、流逝基准更新到暂停时刻(恢复后若上报未立即解冻,
    插值从暂停时刻继续,不把暂停时长计入)。
- 歌词渲染用 lyricPosition,进度条仍用 position(平滑优先)。
- **歌词 API 接入点**:预设厂家(QQ音乐默认 / 网易云 / 酷我 / 酷狗 /
  自定义 URL 模板)+ 设置视图「歌词 API」入口。`src/media/lyricProviders.ts`
  按厂商实现:QQ音乐(client_search_cp 搜索 songmid + fcg_query_lyric_new,
  歌词字段 base64 解码)/ 网易云(search/get/web)/ 酷狗(songsearch_v2 +
  明文 LRC)/ 酷我(单引号非标准 JSON 宽松替换后解析,接口封闭后 fallback
  QQ 歌词兜底)/ 自定义(LRC 文本或 {"lrc"} JSON)。
- **按监听平台自动切换**:`PLATFORM_LYRIC_MAP`(qqmusic→QQ 等),useLyrics
  的 platformId 参数(WidgetApp 传 system.platform.id);浏览器等无公开歌词
  API 的平台不映射,回退手动配置。开关(localStorage `widget-lyric-auto`,
  默认开启)控制。
- **搜索匹配增强**:`pickBestHit` 相似度评分(标题精确 100/包含 60/前缀 20
  + 歌手互相包含 30)——无脑取首条在歌名短/带副标题/歌手缺失时会对不上。
- **切换即刷新**:查询 key 含 provider(id|title|artist)+ effect 依赖
  platformId——原实现 key 只有 title|artist,切厂商不触发查询。

### 3.5 本地播放器与上传音乐

- 上传音乐 IndexedDB(`island-uploads`),`useMediaPlayer` 负责播放;
- 播放列表 ↔ 音频库同步:上传歌曲到播放列表时,音频库无同名(按文件名)
  则自动补录,已有不重复导入;`addLibraryTracks` 从音频库导入播放列表
  (单个/批量,存 island-uploads 持久化,自动播放首曲)。

### 3.6 岛体悬停校准

点击穿透窗口下 mouseleave 偶发丢失,JS 记录的悬停态(hoveredRef)会滞留,
导致"宽岛无进度条"(宽度被设成悬停扩展宽,但进度条可见性由 CSS :hover
驱动)。布局 effect 每次重算宽度前用 `island.matches(':hover')` 校准,
悬停态滞留就回落自然宽。

---

## 第 4 章 Electron 主进程

### 4.1 透明窗口与点击穿透

- 透明无边框窗口 + `setIgnoreMouseEvents` 点击穿透:`widget-stage`(岛体)
  mouseenter/leave 经 IPC `widget:pointer` 切换"接收鼠标"。
- **透明窗口渲染稳定性**:widget/widget.css 去掉岛体毛玻璃(backdrop-filter
  在透明窗口合成不稳)与逐帧 blur(卡顿主因);岛体背景全不透明
  (rgb(8,10,14));主进程已 `app.disableHardwareAcceleration()`(避免半透明
  alpha 突变),改动渲染相关代码不要重新引入硬件加速依赖。
- 窗口位置每次启动顶部居中,不持久化。
- 退出/销毁竞态下在途 IPC 调窗口方法会抛原生异常(实测 drag-move
  setPosition "conversion failure"):窗口 IPC 统一 isDestroyed 防护 + 主进程
  uncaughtException/unhandledRejection 兜底。
- render-process-gone crashed/oom 自动 reload(防崩溃白屏必须手动重启)。

### 4.2 移动挂件(右键长按拖拽)

- 按住右键 ~0.4s(位移 < 8px)进入拖拽模式后拖动,快速右键点击/拖动无效果。
  渲染端指针捕获 + IPC(`widget:drag-start/move/end`)→ 主进程用
  "窗口 = 鼠标 - 按下偏移"绝对定位,位置自由(不限制在屏幕内)。
- **防漂移三件套**:
  1. 拖拽激活基准用长按期间的最新坐标(不是按下点,消除手抖偏移);
  2. 渲染端 <0.5px 容差去重(窗口移动合成的亚像素事件不发送);
  3. 主进程 setPosition 后校验实际落点,不一致就重算偏移(自校正,不累积
     相对偏移)。
- **拖拽合帧与自校正降频**:渲染端 pointermove rAF 合帧(每帧至多一次 IPC,
  松手先发末帧再 drag-end);主进程自校正 getPosition 降频 ~10Hz。
- **异常防线**:所有拖拽坐标过 ±10 万合理范围校验(真实屏幕坐标不可能超出),
  非有限值或超界一律丢弃并打日志——setPosition 的 int32 参数转换对超界
  有限值(|v| ≥ 2^31)会抛未捕获异常,绝不能把脏数据传进去。
- 拖拽期间穿透保持接收(鼠标移出岛体也持续响应),松手按指针位置恢复穿透。
- 进度条/文字手势均加 `button !== 0` 守卫,右键只属于拖拽。

### 4.3 展开位置补偿与窗口尺寸

- `win.setSize` 锚点 = 左上角,变宽时窗口右扩 → 岛体视觉右偏。set-size
  handler 在 setSize 后按 `dx = (旧宽-新宽)/2` 补偿 setPosition,宽度变化
  保持窗口中心 X 不动(岛体左右对称展开),高度变化保持顶部不动(向下生长)。
- **只按请求宽度变化补偿(二轮修复)**:Windows 透明无边框窗口实际宽比请求宽
  大 ~2px(实测 1242 vs 1240),若每次 set-size(仅高度变化,Agent 面板高度
  渐进每帧上报)都按 (ow-cw)/2 补偿,宽度偏差被当成真实变化,每帧右移
  1-9px,展开动画期间累积 80px+——`lastSetSizeW` 记忆上次请求宽,
  `|cw - lastSetSizeW| >= 2` 才做 X 补偿。
- set-size/set-height 主进程 100ms trailing 合帧(流式长高每秒多次 OS 窗口
  resize → 压到 ~10 次/秒,保留最后一次);`immediate` 参数直通(全屏等
  场景)。

### 4.4 配置持久化

- `userData/settings.json`(仅 alwaysOnTop / mode / agent 配置段);
  主题色 localStorage(`widget-theme-color`);上传音乐 IndexedDB
  (`island-uploads`);自定义背景 IndexedDB(`island-background`)+ 参数
  localStorage(`widget-background`);自定义字体 IndexedDB(`island-font`,
  data URL,10MB 上限)+ 参数 localStorage(`widget-font`)。
- **settings.json 持久化加固**(electron/settings-store.cjs):
  - 内存缓存(loadSettings 不再每次同步读盘,agent 每步 4-8 次)→ 0;
  - 原子写(tmp + rename + .bak 损坏恢复)+ 150ms 防抖 + before-quit flush
    ——原直接写目标文件,强杀截断后下次保存以 {} 为基底覆盖写回整份丢失;
  - apiKey 经 safeStorage(DPAPI)加密落盘(enc: 前缀,解密失败回退 null 重填)。
  - 巡检恢复文件后必须 `resetSettingsCache()`(置 null,flushSettings 对
    null 缓存 no-op)——否则退出瞬间 before-quit flush 用旧缓存覆盖刚恢复
    的文件(实测残留 confirmExec 开关)。
- 数据源:`WidgetApp` 中 `useSystemMedia`(SMTC 外部平台)与 `useMediaPlayer`
  (本地播放器)并存,`externalActive = system.active && system.track &&
  useExternalSource` 决定数据与控制走哪一边。切换数据源时**双向暂停**。
  SMTC 播放模式以系统真实状态为数据源(轮询校准),点击循环后 1.2s 检测
  是否跟随,没跟随则提示并回退。

### 4.5 托盘与模式切换

- 托盘菜单:模式(音乐 ↔ Agent,radio,持久化 `settings.json` 的 `mode`,
  启动恢复;渲染端 `onSetMode` 订阅 + `getMode` 兜底)、多媒体库…、
  设置…、置顶、退出。
- **模式切换事件带来源**(`widget:set-mode` payload `{mode, source}`):
  - `source: 'tool'` = Agent 工具 switch_to_music 触发——属于对话流程,
    切回音乐时**不中止**正在运行的本轮(引擎完成回复并落定消息;若中止,
    最终回复被丢弃,历史停在未答复的用户消息,下一轮 LLM 把旧请求当
    "仍待执行"重复执行 = 上下文污染,实测"打开B站"时又被自动切回音乐模式);
  - `'user'` = 托盘/手势,切回音乐时中止当前轮。
- 托盘"设置…"经 IPC `widget:open-settings` 通知渲染端展开设置视图
  (requestSettingsSeq seq 递增);托盘"多媒体库…"经 `widget:open-media-library`
  → requestMediaLibrarySeq。
- 托盘"退出"走 app.quit(quit 前 agentEngine.dispose 清理子进程)。

### 4.6 IPC 通道一览

| 通道 | 方向 | 用途 |
| --- | --- | --- |
| widget:pointer | 渲染→主 | 岛体 mouseenter/leave 切换点击穿透 |
| widget:drag-start/move/end | 渲染→主 | 右键长按拖拽移动窗口 |
| widget:set-size | 渲染→主 | 窗口尺寸(合帧/immediate) |
| widget:set-mode | 双向 | 模式切换(music/agent + source) |
| widget:open-settings | 主→渲染 | 托盘设置入口 |
| widget:open-media-library | 主→渲染 | 托盘多媒体库入口 |
| widget:fullscreen | 渲染→主 | 媒体小窗全屏(扩展至显示器工作区) |
| app:open-external / app:open-media-external | 渲染→主 | 打开外链/外部播放器 |
| agent:send/abort/event | 渲染↔主 | Agent 对话流式 |
| agent:config-get/set | 渲染↔主 | Agent 配置 |
| agent:tools/mcp-test | 渲染→主 | 工具列表/MCP 连通测试 |
| agent:memory-get/set/export/import | 渲染↔主 | 记忆管理 |
| agent:evolve/evolution-log/rollback/reset | 渲染↔主 | 自我进化 |
| agent:summarize/mind-guess | 渲染→主 | 标题总结/心理揣测 |
| agent:proactive-tick | 渲染→主 | 主动陪伴调度 |
| agent:skill-import | 渲染→主 | 技能包导入 |
| app:pick-media-files | 渲染→主 | 视频导入对话框(返回绝对路径) |
| app:island-pick-files | 渲染→主 | 音频导入对话框 |

所有渲染端可调的通道统一 `safeHandle(channel, fn)` 包装,错误返回
{error} 结构(渲染端展示错误文本,不再 unhandled rejection)。

---

## 第 5 章 Agent 引擎

### 5.1 架构总览

- **引擎**:`electron/agent/*.ts` → esbuild 打包 `electron/agent.cjs`(零第三方
  依赖,`electron` external;入口仍是 engine.ts,evolution 经 re-export 打进
  同一产物),主进程内运行(非 utilityProcess:纯异步网络/文件 IO)。
- **无状态**:渲染端每次 send 回传完整历史(参考后端"客户端持有历史"模式)。
- **Provider 按 Base URL 自动判定**(detectProvider):
  - 地址含 "anthropic" → Anthropic Messages;
  - 含 "chat" → DeepSeek Chat Completions(备选);
  - 否则(默认)→ DeepSeek Responses API。
- **历史契约**:send 回传的 history 末尾**即当前轮用户消息**——引擎不再追加
  (仅历史缺尾时防御性补一条),否则用户消息重复发两遍、且中止后合并的消息
  会被拆开;上一轮被中止/失败(历史以 user 消息结尾)时,新输入**合并进该
  未答复的用户消息**(防连续 user 消息污染,LLM 会把未答复请求当"仍待执行"
  重复执行)。
- **迭代上限 25** 防死循环(原 10 轮实测太紧:复杂任务 LLM 试错空间不足
  频繁撞上限;上下文增长由 trimHistory 预算治理兜底)。

### 5.2 引擎循环

```
send(text, history)
  → trimHistory 预算裁剪(400K,至少留 10 条)
  → 手动调用检查(/技能名 或 @mcp工具)
  → 循环(上限 25 轮):
      streamByConfig → 流式事件(text/reasoning/tool)转发 UI
      ├─ 无 function_call → 落定助手消息,结束
      └─ 有 function_call → executeToolBatch(并行 Promise.all,每工具
          独立 60s 超时;validateRequiredArgs 参数校验先行) →
          工具结果截断 8000 回填历史 → 续调
  → message 事件落定(带 usage/耗时/是否 proactive)
```

- **工具参数校验(2026-08-08,LLM 自主纠错核心机制)**:`validateRequiredArgs`
  按工具 schema 的 required 校验,缺参/空串/解析失败(_raw)生成**结构化错误
  文本回填**(列出缺失参数名 + 类型 + 说明 + enum 可选值 + 解析失败原文),
  **不执行工具**——LLM 看到"缺什么、怎么补"自行修正重试,不再反复空参调用
  (用户实测 write_file 空参死循环的兜底防线)。数值 0 / 布尔 false 是合法值
  不误判,无 required 的工具跳过。
- **并行工具执行**:一轮多个工具调用 `Promise.all` 并发(DeepSeek 并行工具
  调用始终开启;结果按调用顺序回填,UI 卡片顺序一致;每个独立 60s 超时;
  抽共享 `executeToolBatch`)。
- **工具超时覆盖**:`AgentTool.timeoutMs` 字段(缺省引擎 60s),doc_convert
  (200s)/ xxt(310s)声明覆盖——原 60s 统一超时把 login 300s/转换 120s
  中途杀掉。
- **delegate 子代理工具**:嵌套 agent 循环(独立上下文,`task` 必填 /
  `system` 可选专用提示 / `tools` 可选工具子集),事件静默(reasoning 仍累积
  满足回传要求),返回结果文本;LLM 一次发多个 delegate 即并行子代理;主循环
  与子代理共用 executeToolBatch;**继承主回合 abort 信号**(用户点"停止"后
  子代理不再烧 token);确认门为子代理启动时捕获的实例(工厂作用域变量每轮
  重赋值,跨轮僵尸子代理读下一轮的门 = 确认语义污染)。
- **确认门**:`agent.confirmExec` 开关(设置视图可改,默认关);开启后每轮
  首个命令经 tool-confirm-request 事件 → AgentView 确认卡[允许/拒绝] →
  agent:tool-confirm 回执,120s 超时拒绝,拒绝结构化回填 LLM 可自纠;
  引擎 `createTurnConfirmGate` 工厂。**并行竞态修复(P0)**:confirmCommand
  单槽被并行 exec_command 覆盖时,旧 promise 的 120s 定时器触发时槽已空 →
  无人 resolve → 整轮冻结且 agent:abort 解不开——新请求到达**立即以拒绝落定
  旧请求**(引擎结构化回填 LLM 可自纠)+ 定时器闭包只处理自己那次。

### 5.3 Provider 详解

三个 provider 同构返回 `ProviderOutcome {calls, text, usage, aborted}`,
引擎循环共用;工具结果截断 8000 字符回填上下文(三 provider 一致)。

#### 5.3.1 DeepSeek Responses API(默认)

- `streamResponse`,裸 fetch + SSE,POST {baseURL}/responses,默认
  https://api.deepseek.com,模型 deepseek-v4-flash。
- **顶层参数**:model / input(字符串或 item 列表)/ instructions / stream /
  max_output_tokens(**含思维链 token**)/ tools / tool_choice / reasoning /
  text.format / temperature·top_p / user。不支持的参数静默忽略、无状态 API。
- **reasoning.effort 官方值域**:none / minimal / low / medium / high / xhigh /
  max——none = 关闭思考模式;不传用模型默认(开启)。
- **text.format**:text(默认)/ json_object(JSON 模式,prompt 需含 "json"
  字样)/ json_schema(结构化输出,name + schema 必填)——总结标题走
  json_object。
- **输入 items**:message(角色 user/assistant/system/developer 视同 system;
  content 仅 input_text/output_text,**reasoning 内容块 400** "unknown
  variant" 实测)、function_call(call_id 必填唯一,每个 call 必须有对应
  function_call_output)、function_call_output(output 字段)、reasoning(明文
  content 归并相邻 assistant 消息;**必须回传**,缺失 400 "The reasoning_text
  in the thinking mode must be passed back")、web_search_call(原样回传自动
  恢复搜索结果)。
- **usage**:input_tokens_details.cached_tokens(上下文缓存命中)/
  output_tokens_details.reasoning_tokens(思维链 token 数)。
- **工具参数流式累积**:DeepSeek 的 `response.function_call_arguments.delta`
  **不带 call_id**(带 output_index),权威完整参数在
  `response.function_call_arguments.done`(带 item_id)。`findCall` 按
  call_id → output_index → item_id 三级匹配累积增量;处理 done 事件作权威
  参数;`response.incomplete` 打日志(reason 多为 max_output_tokens)。

#### 5.3.2 DeepSeek Chat Completions(备选)

- 官方 multi_round_chat / tool_calls / json_mode / strict 指南体系,支持
  v4-flash 与 v4-pro;response_format json_object(实测含工具历史约 60%
  空白 content——官方"有概率返回空 content",Responses 的 json_object
  实测空返回率远低)。

#### 5.3.3 Anthropic Messages API

- `POST {baseURL}/v1/messages`,x-api-key 鉴权;适用于 DeepSeek Anthropic
  兼容端点 `https://api.deepseek.com/anthropic` 或原生
  `https://api.anthropic.com`;max_tokens 必填 4096;模型名 claude 前缀由
  DeepSeek 自动映射到 v4 系列。
- **格式差异**:角色严格交替(相邻同角色合并);工具结果必须打包进下一条
  user 消息的 tool_result 块(parts 模型里 tool-call/tool-result 成对,
  序列化时重排);同一条助手消息里 tool_use 之后不能再有文本;工具参数是
  流式 JSON delta(input_json_delta.partial_json);reasoning parts 回放时
  丢弃(thinking 块需要 signature,两端兼容性取舍)。

#### 5.3.4 公共层

- `parseSse`(electron/agent/sse.ts)单一实现(yield SseFrame {type, data}),
  deepseek/chat/anthropic 三处共用;8000 截断 ×3 → `truncateResult`。
- **上下文硬盘缓存(DeepSeek 自动开启)**:请求前缀**完整匹配缓存前缀单元**
  才命中;多轮对话天然命中(完整历史回传 = 前缀递增);**前缀必须稳定**——
  instructions 与历史序列化幂等、tools 顺序固定、reasoning item 固定回传,
  任何序列化抖动都会断缓存。usage 透传缓存命中 → 助手消息尾部显示
  "输入/输出/缓存命中"小字(可观测命中率)。缓存命中价 0.02元 vs 未命中
  1元(50 倍)。
- **预算治理**:`trimHistory` 按 token 粗估(中 1/字、英 4 字符/token,
  系数 0.6)裁剪历史,上限 400K、至少留 10 条,仅超限触发(不断缓存前缀);
  **max_output_tokens: 8192 动态可调**(主对话/子代理循环,含思维链 token;
  原 4096 在思考模式高 effort 下常被思维链吃光,工具调用参数被截断成空串
  → 空参调用死循环,用户实测)。
- **LLM 自主调整预算**:引擎持有**可变预算** `outputBudget`(初始 = 配置
  ?? 8192,越界回退);工具 `set_output_budget`(action=get 查询 /
  action=set,maxOutputTokens 钳制 4096-262144 + persist 缺省 false =
  仅本次会话)。**预算不足提示**:provider 报告响应被截断
  (`response.incomplete` / `finish_reason='length'` / `stop_reason=
  'max_tokens'`)→ ProviderOutcome.truncated → 引擎**不落定半截回复**(原
  逻辑 calls 为空直接落定 = 提示永远用不上),已输出文本入历史 + 注入
  BUDGET_TRUNCATE_HINT system 提示(每回合一次,不进渲染端历史):LLM
  自主判断——任务需要更长输出 → set_output_budget 按需调大后续写;已基本
  完成 → 收尾。
- **thinking 模式 reasoning 必须回传**:引擎每轮(含工具循环)把思维链
  reasoning part 存入助手消息 parts,历史序列化按 provider 输出——Responses
  = 独立 reasoning item;Chat = assistant 消息 reasoning_content 字段;
  Anthropic 路径 thinking 块需 signature 不可回放,已丢弃。

### 5.4 内置工具系统

工具 = `{name, description, parameters(JSON Schema), execute}` 注入 LLM
上下文(LLM 据此生成参数,过程全程可知——执行前 tool-call 事件展示完整
参数,结果 tool-result 事件回显)。v1 工具清单:

| 工具 | 说明 |
| --- | --- |
| exec_command | 本机 shell(无沙箱);**媒体文件拦截**——`start <媒体>` 解析出媒体路径时返回 media 附件窗口内播放,不弹外部播放器 |
| read_file / write_file / list_dir | 文件读写与目录 |
| open_url / open_file | 打开链接 / 文件;**open_file 媒体拦截**——图片/视频/音频扩展名命中时不调 shell.openPath,返回 media 附件窗口内播放 |
| web_search | Bing 主用、DDG 回退(duckduckgo 在中国不可达,实测 fetch failed) |
| get_time / system_info / notify | 时间 / 系统信息 / 系统通知 |
| switch_to_music | 切回音乐模式(source: 'tool',不中止本轮) |
| bili | B站数据查询与视频下载(内置 bili-tool) |
| doc_convert | 文档转换(内置 DocFlow 服务,首次调用自动拉起) |
| xxt | 超星学习通自动答题 |
| get_feature_guide | 读取内置技术文档,向用户介绍功能(见第 11 章) |
| + 灵动岛设置工具 / 自我配置工具 / 记忆工具 | 见第 7 章 / 5.8 / 5.7 |

#### 5.4.1 bili(B站)

- 调内置 bili-tool(`toolsRoot()` 解析到 `tools/bili`,dev 下即项目目录);
  spawn 注入 `BILI_BASE_DIR = userData/bili`(登录态/下载落 userData);
  **BILI_CWD 目录必须存在**(模块加载时 mkdirSync recursive;
  从 node:fs 顶层导入——promises 命名空间没有 mkdirSync,曾调 undefined
  被空 catch 吞掉)。
- **对话内扫码登录**:bili-tool login 支持 `--qrcode-img <path>` 生成
  二维码 PNG → 转 data URL 图片附件展示给用户扫码;`--no-wait` 仅生成不
  轮询并输出 `二维码key:`;引擎解析 key 后 `startBiliLoginPoll` 后台 spawn
  `login --resume --timeout 120`(注册到通用后台任务注册表),成功写
  cookies.json 发通知 + background-done 自动触发对话告知登录成功,失败/
  超时同样进入终态触发对话反馈。**两个关键坑(实测)**:① poll 响应顶层
  code 恒为 0,真正状态在 data.code(86101 等待/86090 已扫码/86038 失效/
  0 成功);② 成功响应的 url 是 crossDomain?ticket= 中转地址,SESSDATA 在
  请求该地址的 Set-Cookie 里(login.rs 走 fetch_cookies_chain)。
- **下载 cwd 固定 BILI_CWD = userData/bili**(config 的 outdir=downloads
  相对此解析;不固定会落在 Electron 启动目录,用户和 LLM 都找不到,实测);
  启动返回文本带输出目录、后台任务状态注入列输出文件绝对路径、`bili saved`
  action 把记录里的相对路径逐行转绝对。
- **登录态热搜修复**:登录过期时 nav 接口无 wbi_img → 空 mixin →
  `orig.as_bytes()[i]` 越界 panic——wbi_keys 提取失败降级游客 nav 重试,
  仍失败返回明确错误;sign_wbi 加长度防御。

#### 5.4.2 doc_convert(文档转换)

对接内置 DocFlow 服务 http://127.0.0.1:5000:**首次调用自动拉起服务**
(系统 python + `tools/docflow/server.py`;轮询 /api/engine 就绪,60s 超时,
并发互斥单例防多次拉起;服务常驻,`disposeTools` 随引擎 dispose 清理)
→ multipart 上传(files+mode=to_markdown)→ /api/convert → 轮询 status →
下载到输出目录。`AgentTool.timeoutMs = 200s` 覆盖。

#### 5.4.3 xxt(超星学习通自动答题)

dev = 系统 python + `tools/xxt/auto_answer.py`(playwright,浏览器走系统
Edge channel);登录态/截图目录经环境变量 XXT_PROFILE_DIR/
XXT_SCREENSHOT_DIR 隔离到 userData/xxt-profile(原 .browser_profile 含
用户登录态,不随仓库分发);子命令 login/crawl/fill(--answers JSON)/
check/submit/screenshot,--url 必填,login 300s 超时其余 180s
(`AgentTool.timeoutMs = 310s` 覆盖)。

### 5.5 通用后台任务注册表(tasks.ts)

把 bili 的后台设计(生成二维码 → 后台轮询 → 完成发通知 + background-done
自动触发对话)**泛化**为引擎级机制——任何需要人工介入/后台推进的任务
(扫码登录、人工确认、下载……)注册 `{id, title, status: waiting|running|
done|failed|cancelled, detail}` 后:

1. **状态实时注入系统提示**(`getTasksStatusBlock`,替代原 bili 专用
   getBiliBackgroundStatus,engine/subagents 三处共用;文案稳定不破坏前缀
   缓存,含「等待人工操作的任务要提醒用户当前需要做什么」指导);
2. **进入终态触发 done 回调一次**(`updateTask` 终态后忽略再更新;已终态
   任务 TTL 24h 清理,进行中 6h 失联标注)——createTools 接线
   setTaskDoneHandler → background-done → 渲染端自动触发一轮对话,LLM
   主动告知用户结果(完成/失败/取消都有,不再"通知完就结束、LLM 无感知")。

bili 迁移:登录注册「B站扫码登录」waiting(独立任务 id `bili-login-<key>`,
重新扫码不互相覆盖),成功 done/失败 failed 都有对话反馈;下载注册「B站下载」
running(detail 带进程与输出目录),完成/失败进终态——**顺带修复:下载完成
此前从未触发 background-done**(runBiliBackground 的 onDone 参数从未被传入,
对话里 LLM 永远不知道下载结果,只有系统通知)。

### 5.6 静默总结标题 Sub Agent(subagents.ts)

- **独立的总结后台 Sub Agent**(`createSummaryAgent`,主进程独立单例,与主
  对话引擎**零共享**——独立实例/AbortController/每次调用独立读配置,主对话
  的发送/中止/清空/模式切换都打不断总结,总结失败也不外溢到对话)。
- 无工具单轮(系统提示"对话标题生成器,推荐 10 字左右、**严格不超过 20 字**"),
  事件不转发 UI,**强制 low effort + noThinking 加速**。
- **输入压缩**:最近 12 条消息,reasoning 截 500 字、工具结果截 2000 字、
  **工具调用参数 compressArgs 递归截断字符串值 200 字**(大参数如
  write_file 内容/exec_command 长命令是隐藏的大请求源)。
- **总结走 json_mode 三级降级链**:① JSON 措辞 A → ② JSON 措辞 B(官方建议
  "修改 prompt 缓解")→ ③ 纯文本兜底(不设 format,历史上可靠);每级
  noThinking(effort 'none' 关闭思考——标题无需思考,且输出 token 全花在
  思维链上是空白 content 的典型场景);每个 attempt 独立容错(调用失败重试
  一次后进入下一级——旧实现调用失败直接跳出循环、整个总结放弃,是"经常没
  总结"的结构性原因);90s 超时。
- **严格解析(extractJsonTitle)**:必须解析出合法 JSON 对象的字符串 title
  才采信——解析失败返回空串进入下一级(原 parseTitleJson 解析失败会**把
  原文整串兜底当标题**,模型在 json 模式输出 Python 列表字面量 "['data']"
  时就被当了标题,实测);额外容忍 Python 风格单引号 dict;所有措辞统一拒绝
  代码字面量标题(looksLikeCodeLiteral)。
- **sanitizeTitle 清洗截断**:去首尾引号/书名号(兜底)+ 剥「标题:」「对话
  标题是」前缀与尾随句末标点(纯文本措辞下模型常输出"标题:xxx"/"xxx。")+
  按 code point 截 20 码元。
- **确定性兜底(2026-08-07)**:全部尝试失败返回 `fallbackTitle(messages)`——
  取**首条用户消息**文本截 10 码元作标题,保证标题永不为空。
- **Sub Agent 设置**:总结标题**文风**(summaryStyle)与心理揣测**人格**
  (mindPersona),各 4 种预设 + 自定义 ≤100 字——预设表 SUMMARY_STYLES /
  MIND_PERSONAS 定义在 constants.ts(零 node 依赖,渲染端设置界面与引擎
  共用,subagents.ts re-export);resolveSubAgentStyle 解析为提示词片段注入。
- 每轮回复完成后自动总结(message 事件落定即触发,后台静默),结果存
  currentTitle(localStorage `widget-agent-title` 持久化);紧凑态文字区 idle
  时按 **心理揣测 → 标题 → 最后回复预览** 优先显示。
- **会话版本号防竞态**(sessionVersionRef):仅在 clear/loadSession(会话真正
  切换)时递增——send 递增会把每轮总结全部作废;总结触发为 effect
  (messages 落定 + status idle 后),**排队追平**(in-flight 时标记 pending,
  完成后补跑最新一轮);runSummary 入口守卫 + in-flight 标记跨越重试窗口;
  失败重试:1.5s 后同快照重试(retryLeft 预算 1),预算耗尽 10s 后补跑一次
  最新消息;loadSession 跳过下次总结。
- 渲染端 mindGuess 状态(localStorage `widget-agent-mind`)与标题共用
  **泛化标签 runner**(createLabelRunner 工厂:入口守卫/排队追平/1.5s 重试/
  10s 补跑,总结标题与心理揣测各自独立 in-flight 状态)。

### 5.7 心理揣测 Sub Agent

- `createMindAgent`(engine.ts,与总结/主对话引擎均零共享,`agent:mind-guess`
  IPC + preload agentMindGuess + main.cjs getMindAgent 懒加载单例)——根据
  当前对话**揣测 LLM 回复时的心态**,≤16 汉字俏皮话(推荐 10 字左右,如
  「表面淡定,内心在慌」),显示在灵动岛紧凑态文字区。
- **系统提示与主引擎同源**(buildMindSystem 拼装「自定义提示词 + 长期记忆块
  + 进化状态 + 后台任务状态 + 人格预设」再接揣测指令)——揣测必须知道助手
  "是谁、记得什么、在忙什么",否则心理是猜的空气。
- **超长自查重生成**:生成结果超 16 码元 = 文字区截断残片 → 重新组织直到
  不截断(重试上限 MIND_MAX_RETRIES=5 次防死循环,全部失败返回空串由调用方
  回退);空/垃圾/照抄示例同样重试;**措辞强化一轮过**:系统提示明确"必须
  严格控制在 16 个汉字以内 + 输出前先数一遍字数,超过就删减"。
- sanitizeMind 剥「心理揣测:」前缀/尾随标点、**剥离任意位置的
  [揣测：xxx] 括号标注**(模型常输出"喵～我已经瞄到主人了哦[揣测：表情…]")。
- **文字区回退 Bug 修复**:loadSession 清 mindGuess 且 skipNextLabelRef
  跳过生成 → 文字区回退"最后回复预览";修复:skip 块**只跳过总结标题,
  心理揣测照跑**。

### 5.8 主动陪伴(2026-08-07 用户要求"LLM 主动向用户发送消息")

- 用户无操作满 N × 单位(设置 `agent.proactiveEnabled` 默认开 /
  proactiveInterval 默认 15,钳制 5-480 / proactiveIntervalUnit s·m·h
  默认分钟;旧 proactiveIntervalMinutes 由 main.cjs currentAgentConfig
  统一迁移)后,增强的总结标题 Sub Agent 独立判断语境是否需要主动开口
  (`createSummaryAgent.judgeProactive`):JSON 输出 `{should, hint?}`,
  parseJudgeJson 严格解析(复用 extractJsonObject 候选链),失败/无 Key →
  should:false(安全侧,一次都不主动打扰);判断上下文与主引擎同源
  (自定义提示词 + 记忆块 + 进化状态 + 后台状态 + 当前时间,buildJudgeSystem
  拼装),noThinking 低强度 60s 超时单措辞一次重试。
- **工具积极性强化(2026-08-10 用户要求"更拟人,人是会用工具的")**:
  ① 判断措辞新增"值得用工具动手/查证的事"判据——后台任务状态块中有等待
  人工操作的任务(扫码登录)或进行中下载/转换时尤其适合开口、话题需要实时
  信息(可 web_search 查证后再开口,不凭空猜)、可用灵动岛设置工具帮用户
  改善体验(抱怨过字小/背景看不清);hint 可包含"该用什么工具做什么",让
  主动开口是行动而非纯问候;② PROACTIVE_INSTRUCTION 增补"像真实的朋友
  那样——人是会用工具的:需要真实信息就主动调用工具查证或顺手把事办了
  (web_search/查后台任务状态/灵动岛设置工具),不要凭空猜测;但不要为了用
  工具而用工具,把话说短说自然,行动融入对话而不是罗列工具"。
- **判断为"是"→ 主 Agent 完整回合主动回复**(`engine.proactiveTurn
  (history, {hint})`):思考/流式/工具/子代理全保留,消息以正常助手气泡
  流式落定(message 事件带 `proactive: true` 标记——渲染端据此重置 idle
  时钟防触发循环);内部指令为 role:'system' 请求项追加在 **input 末尾**
  (三 provider 序列化器补 system 分支),**不进渲染端历史、不拼进 system
  prompt**(动态段拼进去断缓存前缀,50 倍价差);与 send 共享 running 互斥,
  busy 时静默拒绝不排队;共享 ctl abort 链路;确认门行为不变。
- **系统消息 = Windows 系统通知**(用户明确:不是对话内气泡):主动回合
  message 落定后主进程 getMindAgent().guess([该消息]) → `new
  Notification({title:'岛灵 · 心理揣测', body})` 展示 + mind-proactive
  事件送渲染端更新紧凑态文字区——同一句,两处一致、不重复调用 LLM;
  渲染端标签 effect 对 proactive 末条跳过 mindRunner。
- **调度器在渲染端**(useAgent,每 60s 检查:agent 模式 / 配置开启 /
  status idle / 有历史 / 距上次"有操作"≥N 分钟 / in-flight 守卫)→
  `agent:proactive-tick(messages, idleMinutes)`(IPC resolve 时机 = judge
  完成后,渲染端 in-flight 覆盖 judge 全程,期间用户 send 天然优先);
  judge-no 回退 idle 时钟;"有操作" = 用户 send / 清空 / 切换会话 / 主动
  回复落定。
- AgentSettingsView「主动陪伴」区:开关 + 关闭时折叠隐藏间隔设置(grid-rows
  0fr↔1fr 折叠动画)+ 触发间隔与单位两个 QuickMenu 按钮(间隔默认 15,
  预设 15/30/60/120 + 自定义内联输入 5-480 钳制;单位默认分钟,秒/分钟/
  小时,数值不变仅换单位);LLM 自我配置工具 `set_proactive_config`
  (enabled/interval/unit)。
- **Windows 通知 Bug 修复**:main.cjs 从未调用 `app.setAppUserModelId()`
  ——Windows 上不设置 AppUserModelID,`new Notification().show()` 静默失败;
  whenReady 开头补 `app.setAppUserModelId('com.dynamic-island.widget')`。

### 5.9 记忆系统(memory.ts)

- 结构化长期记忆存 **userData/memory.json**(与 settings.json 分离:高频
  变更不污染配置,损坏不影响配置),条目 = `{id, type: preference|fact|
  workflow|lesson, content, source: manual|agent|evolution, createdAt,
  updatedAt}`,上限 200 条、单条 500 字,写盘串行队列防并行竞态。
- **系统提示拼装**:`自定义提示词 + 记忆块 + 进化状态 + 后台任务状态`
  (记忆块按类型分组、截 6000,静态段——变更才断缓存前缀)。
- **LLM 记忆工具**:remember(沉淀,自动去重)/ forget / list_memory /
  update_memory——对话中"记住:…"即写长期记忆。
- 设置视图记忆管理器:条目列表(类型徽标 + 内容省略 + 改/删)、添加行
  (类型选择 + 内容);**记忆类型定制下拉**(QuickMenu 化,默认选中偏好,
  滚轮逐格循环切换 + WheelSwap 内容动画,`.tick` 类仅在滚轮触发后加)。
- **导入/导出**:导出 = 保存对话框写完整 JSON(可再导入);导入 = 打开对话框
  选文件 → 校验(结构同 memory.json 的 {entries:[...]},兼容纯数组)→
  规范化(类型校验/内容截 500/时间戳兜底)→ store.importEntries 合并去重
  ——按 id 与内容去重、导入条目 updatedAt 置为当前、总量超 200 淘汰最旧。

### 5.10 自我进化 harness(evolution.ts)

按 penguin-harness 的 agent-optimization 技能与 snapshot-service 重构:

- **评估委托独立 Sub Agent**(createEvaluatorAgent()):独立实例/独立
  AbortController/60s 超时/失败自动重试一次/事件静默——优化流程自身不直接
  调 LLM 评分(借鉴"评估必须委托 agent-evaluation 子代理,优化器自己不
  评分"语义)。
- **版本化快照**:每个**接受**的版本存档 `userData/memory-snapshots/
  v<N>.json`(同版本不重复打包);memory-state.json 持久化当前版本号/评分;
  **回滚只到已接受版本**(防降级——拒绝的候选从不产生版本)。
- **Reference 语义**:当前已接受版本 = Reference,每轮从它构造一个候选,
  接受后成为新 Reference。
- **假说驱动**:评审的每条改进建议必须带 hypothesis(预测的可观察行为变化),
  无假说的建议一律不采纳;评估侧只给公开记忆内容,黑盒打分防自评偏差。
- **多轮候选循环**:每轮 评审(rubric = 冗余/一致/时效/可操作/价值,总分
  0-100)→ 确保 Reference 快照 → 应用候选 → 复评(独立调用)→ 棘轮(新分
  **严格高于**原分才接受:版本+1、立即存档、更新 state;否则从快照恢复)
  ——轮数预算 rounds(evolve_memory 工具参数,默认 2 上限 4),评分 ≥92
  达标提前停,LLM 调用失败不消耗轮数;被拒结果作 evidence 记录日志。
- **CONTRACT**:进化只改记忆(可编辑资产),不触碰引擎/工具代码。
- **后台任务语义**:工具/设置按钮触发后立即返回,完成发系统通知 + 状态
  注入系统提示(getStatus 块);日志 evolution.json(上限 20 条,含版本号,
  设置界面展示 + 「回滚到上一版本」+「清除所有版本」)。

### 5.11 MCP 服务接入(mcp.ts)

- 零第三方依赖手写客户端,**双传输**(参考 opencode mcp-tools.go 设计):
  - **stdio 传输**:JSON-RPC 2.0、stdin/stdout **每行一条消息**(非 LSP 的
    Content-Length 帧);
  - **sse 传输**:GET 端点建立事件流(endpoint 事件给出 POST 回传端点),
    请求 POST 回传端点、响应经同一事件流按 id 推送(ping 事件忽略)。
  - 握手统一:initialize(请求 2024-11-05,兼容面最广)→
    notifications/initialized → tools/list;调用 tools/call。服务端主动日志
    打日志,服务端发来的请求回 Method not found(-32601)。
- 差异:opencode 每次调用独立连接,本项目为**常驻进程/流复用**(连接一次
  反复调用,崩溃自动重启,调用间零握手开销)。
- **工具命名 mcp_<服务名>_<工具名>**(仅 [a-z0-9_],重名加序号);
  inputSchema → parameters(非 object 模式包一层 input 字段);结果 content
  文本块拼接、图片/二进制资源只标注大小不塞 base64、截 8000;服务端 isError
  → 抛错按"工具执行失败"回填(LLM 可自纠)。
- **生命周期**:每服务一个常驻连接(崩溃或断流后下次调用自动重启);配置
  增删改即销毁旧客户端(prune 按 key = 全字段 JSON 判定);**连接互斥
  connectPromise**(并行工具调用/delegate 子代理并发 connect 会拉起两个
  进程、旧进程泄漏挂起——实测隐患);连接失败在 listTools 静默跳过;
  60s 超时由引擎 executeToolBatch 兜底,JSON-RPC 层 55s。
- **Windows cmd 宿主**:npx/npm 等 .cmd 命令必须经 `cmd.exe /d /c` 启动
  (CreateProcess 无法直接执行 .cmd;规则:命令不以 .exe 结尾一律走 cmd
  宿主);cmd /c 会把参数里的 %VAR% 当环境变量展开,路径含 % 需加引号。
- **销毁**:Windows 走 `taskkill /pid /T /F` 连进程树;before-quit →
  agentEngine.dispose()(懒加载:从未用过不会创建引擎,无泄漏)。
- 配置 = settings.json agent.mcpServers(name/type/command/args/env/url/
  headers,main.cjs applyAgentConfigPatch 结构化校验);设置视图 MCP 服务
  编辑(stdio/sse 传输切换 + 逐条「测试」按钮 agent:mcp-test)。
- **MCP 服务分组**:按服务名主段归组(同一程序的多个服务归一个大类,组头
  折叠)。

### 5.12 技能系统(skills.ts)

- 扫描 skillsDirs(Claude Code 技能约定:目录内含 SKILL.md,frontmatter
  name/description + 正文使用文档);**默认扫描源**:`~/.claude/skills` /
  `~/.codex/skills` / `~/.config/opencode/skills` 与 plugins/skills /
  `userData/skills`(挂件自有)。
- 每个技能注册为 `skill_<slug>` 工具(slug 仅 [a-z0-9-],中文名回退目录名,
  重名加序号):**调用时把 SKILL.md 全文注入上下文**(截 8000 带"已截断"
  标注)+ 技能目录绝对路径;description = frontmatter description 压单行
  截 300。每次 listTools 实时重新扫描(配置变更即时生效;**TTL 缓存 ~1s**:
  原每步全量磁盘重扫,10 技能 × 10 步 ≈ 100 次文件读/轮)。
- **技能分区**:sourceKind = created(灵动岛创建:userData/skills 无导入
  标记)/ imported(手动导入:.island-imported 标记)/ scanned(外部目录);
  设置技能区三区展示,各自计数与移除按钮。
- **技能排除**:agent.excludedSkills(slug 数组)——被排除的技能扫描跳过;
  LLM 对话 skills_config 工具 exclude/include,或设置界面每行移除按钮。
- **自然语言创建技能**:skills_config create action——LLM 提供
  name/description/content,引擎规范化写入 userData/skills/<slug>/
  SKILL.md(下一轮起 /技能名 可用);同名冲突检查基于实时扫描,overwrite
  可覆盖。
- **技能导入**:dialog 选择技能包文件夹(含 SKILL.md 与脚本等,fs.cpSync
  整目录复制,排除 .git)或单个 .md 文件 → 复制到 userData/skills 并写
  .island-imported 标记;导入成功即刷新本地快照,马上可见。
- **手动调用**:输入以 `/` 开头 = 调技能(匹配完整名/去前缀/模糊唯一命中),
  以 `@` 开头 = 调 MCP 工具;剩余文本是合法 JSON 对象则作参数;结果以
  tool-call/tool-result parts 入历史。**输入框候选列表**:输入 / 或 @ 时
  浮出匹配列表(最多 6 条)——↑↓ 导航 / Enter 选中 / Esc 关闭;数据源 =
  agent.tools 过滤(技能 = `skill_` 前缀;MCP = `mcp_` 前缀且名称含第二个
  下划线,内置 mcp_config 以双下划线区分)。

### 5.13 LLM 自然语言自我配置(configTools.ts)

- **mcp_config / skills_config**:对话中说"添加一个 MCP 服务:…"即可自我
  配置——list/add/remove/test(MCP)、list/add/remove(技能目录),写配置经
  deps updateAgentConfig(main.cjs 注入,复用 applyAgentConfigPatch 校验);
  新增服务/目录下一轮对话起生效。
- **set_proactive_config**:enabled/interval(5-480 钳制)/unit(s·m·h 枚举)。
- **set_output_budget**:action=get / action=set(persist 可选写配置)。
- **set_sub_agent_config**:summaryStyle/mindPersona(预设 id 或自定义,
  空串恢复默认)。
- **配置刷新**:useAgent 的 config 只在挂载时读一次——DynamicIsland 切到
  agent-settings 视图前触发 refreshConfig()(不能在 AgentSettingsView 挂载
  后刷新:异步返回的 config 更新会触发填充 effect,在用户编辑表单时重置
  表单、丢失编辑)。
---

## 第 6 章 渲染端

### 6.1 useAgent(事件流与消息状态机)

- 订阅事件流,组装消息与状态机(idle/thinking/running/error),流式累积
  未落定消息、`message` 事件为权威落定,中止丢弃流式消息。
- **流式性能与竞态优化**:
  - 增量事件(text/reasoning/tool)rAF 合批——跨 IPC 消息的多次 setState
    不自动批处理,逐事件渲染 = 每事件全量 Markdown 重解析 + 重测 + 整树
    reconcile;事件直写镜像、帧内一次提交,频率压到帧率上限;
  - abort 竞态双修(渲染端 status idle 后迟到的流式事件丢弃,防幽灵文本
    残留;引擎 abort 同步复位 running + finally 只清自己回合的 controller,
    防 100ms 内重发被「正在运行中」挡回);
  - 已落定消息块(UserBubble/AssistantBlock/ToolSummary/ToolCard)包
    React.memo,工具结果一次遍历建 Map 配对(去 O(parts²) 的 parts.find);
  - measureHeight 流式时测量与上报一起按 80ms 节拍(offsetHeight 循环 +
    getComputedStyle 是强制 reflow,原每帧跑);
  - 历史持久化 localStorage(`widget-agent-messages`),**直接同步写不防抖**
    (防抖 300ms 在页面刷新/渲染进程重启时会丢最后几秒消息)。

### 6.2 AgentView 聊天面板

- 用户右气泡强调色、助手左气泡半透明白底;**工具调用按回复收纳成单一汇总
  列表**(全部工具调用(执行顺序)并入 `.island-agent-tool-summary` 单行,
  流式执行中也实时并入同一列表;默认折叠——工具不再夹在文本段之间;头部
  状态汇总(强调色图标 + 名称/「工具调用 ×N」+「● 执行中」/「✓ N」/「✕ N」
  + 总耗时 + 箭头),点击展开看各卡、再点卡片展开参数)。**0fr 折叠必须把
  grid item 的 padding-bottom 归零**(Chromium 实测:0fr 轨道残留 item
  padding 高度,收纳态露出被截断的「参数」标题带)。
- 底部输入 Enter 发送(IME 组字不触发)/Shift+Enter 换行、运行中变"停止"。
- **面板高度自适应**:岛体高度 = `--agent-h` 变量驱动(AgentView 用
  scrollHeight 测量内容自然高,clamp [200, 600],消息列表 max-height =
  calc(var(--agent-h) - 116px),内容超高滚动不自锁),窗口经
  onAgentPanelHeight 动态跟随(岛体 + 40,<4px 不 resize),收起回落 280;
  展开瞬间同帧切 agent 视图,高度目标从第一帧正确。
- **岛体高度并行动画**:高度走 **CSS 过渡**(与宽度同曲线同时程 0.3s
  cubic-bezier(0.22,1,0.36,1)),React 状态按测量节拍更新(≤12.5Hz),
  窗口按节拍上报;骨架期 120ms;流式期间恢复**高度瞬跳**(去掉高度过渡,
  80ms 节拍逐格 = 12.5Hz 重绘,远轻于逐帧动画——软件渲染逐帧全幅重绘是
  "高度展开卡"主因;落定后恢复过渡平滑收尾)。
- **滚动动画挂件版直接跳底**(软件渲染下滚动动画逐帧 scrollTop + 全幅重绘
  仍贵:750×500 文本区 ≈5-15ms/帧;window.desktop 时 scrollTop =
  scrollHeight 零动画成本;Web 演示版保留平滑滚动 + 动态高斯模糊(GPU))。
- **骨架屏两阶段**(AGENT_PHASE_IN_MS=120):展开首帧渲染轻量骨架占位
  (3 条脉冲灰条,骨架期不测量保持岛体下限),延迟后挂载真实消息内容淡入
  并测量长高——形变动画期间 DOM 极小,展开更顺。
- **展开动画**:agent 视图宽度过渡用无过冲缓动 0.3s(紧凑 100px → 展开
  400px 大跨度弹簧过冲在软件渲染下抖动明显);收起为单动画(与音乐模式一致:
  宽度/高度同时收缩 + 压感回弹同 tick)。
- **收起交互**:Agent 模式屏蔽单击岛体/点外/Esc(只保留长按收回;视图内
  交互区拦截左键 pointerdown 防误触,右键放行拖拽);收起唯一入口 = ⋯
  菜单"收起面板";**「收起为灵动岛」与「收起为多媒体岛」分离**(2026-08-10
  用户要求:⋯ 菜单两项,前者收成 Agent 紧凑态不生成媒体岛,后者收成视频/
  图片小窗)。
- 头部右上角 **⋯ 菜单**(QuickMenu 化,direction='left',单击 = 执行当前
  选中项,滚轮逐格切换):停止生成(运行中)/ 新对话 / 对话历史 / 工具列表 /
  多媒体库 / 设置 / 收起为灵动岛 / 收起为多媒体岛。
- **会话历史**:多对话存档(localStorage `widget-agent-sessions`,上限 20 条,
  AgentSession {id,title,updatedAt,messages});「新对话」= 当前对话(非空)
  自动存档后清空;「对话历史」→ history 子视图(标题 = 首条用户消息前 24
  字,时间 = 今天 HH:MM/昨天/M月D日,点击加载 = 替换当前对话并从历史移除,
  行内删除)。
- **工具列表**:tools 子视图(引擎 listTools() 暴露名称/描述/参数 schema,
  经 IPC agent:tools → useAgent 加载;卡片可展开参数 JSON);tools/history
  视图**不参与高度测量**(岛体高度保持进入前的聊天高度,列表在剩余空间
  滚动)。
- **回复完成自动聚焦**:busy → 空闲过渡时自动聚焦输入框(wasBusyRef 边沿
  检测);**进入对话面板自动滚动到底**(内容挂载后 phase content 滚动到
  最近信息;新对话无历史消息时不模糊——smoothScrollTo 增 blur 参数,模糊
  是长消息列表滚动动画的性能优化,新对话没内容可优化)。
- **Agent 紧凑态悬停不扩展宽度**(收起面板后悬浮岛体,悬停扩展为进度条
  预留会让无进度条的 Agent 紧凑岛多出空白占位——targetPx 计算按
  agentActiveRef 排除)。
- 紧凑态文字 **emoji 截断**:truncateText 按字素截断(Intl.Segmenter,
  退 code point),UTF-16 按代码单元切片会劈开 emoji 代理对显示 �;字体栈
  补 'Segoe UI Emoji'。
- 紧凑态 = 四角星图标 + **回复流程监听文案**(thinking+无输出 → 思考中…;
  thinking+reasoning 流 → 深度思考中…;thinking+文本流 → 正在回复…;
  running → 正在执行:工具名;idle → 最近回复预览)。

### 6.3 消息气泡 Markdown 渲染

- 手写零依赖渲染器:**解析器 `views/markdownParser.ts`(纯 TS,不依赖
  DOM/React,可 node 直测)+ 组件 `views/Markdown.tsx`**。GFM 子集:
  段落(单换行 = 软换行)、标题/setext、hr、列表(缩进嵌套、有序 start
  序号)、引用(递归)、围栏代码块(语言标签 + 复制按钮)、**GFM 表格**
  (对齐 `:---:`、`\|` 转义、行内代码内的管道不拆分)、行内粗体/斜体
  (下划线两侧贴词字符不强调,防标识符 foo_bar 误伤)/删除线/行内代码/链接/
  裸 URL 自动链接(去尾随标点)。
- **流式友好**:未闭合的围栏/表格/强调在增量文本里退化为普通段落,补齐即
  成形,每次增量重解析天然收敛。
- **安全**:全部文本经 React 转义输出,无 HTML 注入面(无
  dangerouslySetInnerHTML,唯一例外是 mermaid SVG——securityLevel 'strict'
  自带转义)。
- **Mermaid 图表**:```mermaid 围栏 → MermaidBlock 懒加载(dynamic import
  构建分包,主包不含;模块级单例 + **按代码字符串的 SVG 缓存**——流式重
  解析/视图切换同代码直接复用,失败代码缓存不再重试);初始化读岛体实时
  计算样式(--state-color 强调色),深色主题匹配挂件。
- **链接**:仅 http(s) 渲染为锚点,点击经 window.desktop.openExternal
  (preload 新增,main.cjs app:open-external 处理器校验后 shell.openExternal,
  Web 演示版回退 window.open)。
- **易踩坑(实测抓出)**:共享 /g 行内正则单例 + exec 循环 + 递归 parseInlines
  ——内层递归把 lastIndex 重置为 0,外层从 0 重扫同一匹配 = **死循环 OOM**
  (~~s~~ 链接分支复现,堆 4GB 被打爆);必须用 text.matchAll(内部克隆正则,
  递归安全);表格类型 = header: MdInline[][] / rows: MdInline[][][](行 =
  格数组,格 = 行内节点数组)。

### 6.4 对话媒体窗口(MediaFrame / VideoPlayer)

- `![alt](url)` 按扩展名分派(mediaKindOf):图片 → img、mp4/m4v/mov/webm
  → video、mp3/wav/flac/ogg/m4a/aac → audio,无媒体扩展名转链接。
- **island-media:// 自定义协议流式播放**:`file:/` 本地路径映射
  `island-media://local/<编码路径>`,协议 `fs.createReadStream` 转 Web
  ReadableStream 分块发送,内存 ≈ 块大小(替代 IPC 全量 Buffer:200MB
  上限全量读取 + IPC 克隆双倍占内存,10GB 视频直接 OOM);**完整 Range
  支持**(206 + Content-Range,视频 seek 必需——Chromium file:// 请求不
  支持 Range 返回 416 实测);扩展名校验(仅媒体可访问防任意文件读取)+
  按类型大小上限:视频 10GB / 音频 1GB / 图片 10GB;协议特权
  registerSchemesAsPrivileged 在 app ready 前;跨域加载
  crossOrigin="anonymous"(canvas 污染防抖)。
- **气泡 UI 包裹 + 右下角单手柄拖拽等比例缩放**(grip 图标悬浮浮现,
  dw = dx + dy×aspect,钳制 120-640);**拖拽岛体底部自动跟随**
  (followMediaInView 在 useEffect([width]) 里执行——pointermove 时
  setWidth 异步,旧布局读不到新高度,实测 scrollFollowed 失败后改为 effect
  触发成功)。
- **音频 = QQ/微信风格语音气泡**(VoiceBubble::胶囊横条 + 圆形播放键 + 5
  条动态声波 + 进度细条 + 时长,点击整条切换播放/暂停,不参与拖拽缩放)。
- **定制视频播放器 VideoPlayer**(不要原生控件):自定义控件层(底部渐变
  遮罩 + 圆形播放键 + 可拖动 seek 进度条 + 时间 + 全屏 + 音量/更多
  (VideoExtras));**封面抓帧**(2026-08-10:默认展示视频第一帧作封面,
  黑色画面难辨认——跨域 canvas 需 crossOrigin,失败回退黑色);全屏 =
  整个播放器容器 requestFullscreen(控件随容器进入全屏层)。
- **VideoExtras 定制控件**(2026-08-10 用户要求"UI 不要原生要定制",三处
  共用——对话播放器/视频岛/多媒体库,**经 videoPrefs 共享模块双向同步**
  :音量(垂直 pop 自绘条 + 背景槽,`bottom: 100%` 贴按钮顶无间隙防 hover
  丢失,18px 宽 76px 高槽体)、更多菜单(倍速 0.5x-2x / 循环开关),偏好存
  localStorage `widget-video-prefs` + island:video-prefs 事件同步。
- **播放失败按错误码区分文案 + 降级打开**:code 4(SRC_NOT_SUPPORTED)
  文案明确"该视频格式无法在窗口内播放(窗口内支持 mp4(H.264)/webm/ogg)",
  其余"无法播放该文件";MediaError 按钮 → IPC app:open-media-external
  (外部播放器仅为降级选择,正常播放全在窗口内)。
- 初始宽 = 媒体窗口默认设置(localStorage `widget-media-window`,
  settingsBridge readMediaWindowWidth 单一来源,钳 160-800 缺省 320);
  Agent 设置「媒体窗口默认宽」QuickMenu 档位 240/320/480/640 + 自定义。

### 6.5 收起面板后的媒体小窗(AgentMediaMini)

- 收起 Agent 面板后岛体变形成媒体小窗:**视频 = 迷你播放器**(原面板播放中
  → 挂载自动续播并 seek 到面板内最近进度(2026-08-09 修复"收起变多媒体岛
  从头播放";position 由 MediaFrame 节流上报 → agentPlaying → 收起快照;
  currentTime 需元数据就绪才可设置);底部进度条 + 时间 + 音量/更多 +
  全屏按钮);**图片 = 缩略图**(点击展开回对话面板);音频不在此(收起自动
  切音乐模式并续播)。
- UI = 灵动岛风格:媒体 contain 铺满岛体,边缘由岛体 22px 圆角 + overflow
  hidden 裁剪,**无 ✕ 关闭键**(退出 = 长按展开回面板);胶囊一体化无黑边。
- **进度双向同步**:小窗 timeupdate 经 dispatchAgentMedia 更新位置缓存与
  agentPlaying(节流 ~1Hz)——展开回面板时 MediaFrame 从该位置续播;反之
  面板播放位置在收起时同步给小窗。
- **全屏扩展至显示器工作区**:widget:fullscreen(fs, isMini)——仅 mini 时
  扩展至显示器工作区(用户要求"全屏窗口太小"),退出时完整恢复 preFsBounds
  (缩回原来展开时的小窗位置,不统一回左上角)。

DOCEOF
### 6.6 多媒体库(MediaLibraryView)

- **独立菜单**(2026-08-08 用户要求:不属设置范畴,设置视图入口移除,返回键
  = 从哪来回哪去——托盘呼出收起岛体、Agent ⋯ 菜单呼出回对话视图,
  mediaLibraryBackRef 记录);**Agent 设置面板大小**(岛体 540 + 窗口 580,
  VIEW_WINDOW_H['media-library'] 登记——此前未登记窗口停在 280,岛体底部
  被窗口裁切 = "UI 底部截断" bug)。
- **库切换复用 QuickMenu**(与 Agent 设置左上角菜单同款:整合按钮 + 滚轮
  逐格循环切换 + 高亮滑块)。
- **图片 tab**:复用 island-background 库(缩略图网格/改名/删除/上传);
  **右键菜单「应用到展开态/紧凑态背景」**(点击直接导入对应形态槽位(裁切
  参数复位默认)+ 跳转背景编辑器,省略导入步骤;**返回目标 = 多媒体库**
  (backgroundBackRef 记录,背景编辑器返回键直接回多媒体库);菜单 absolute
  定位在面板内 + 相对坐标(原 fixed 定位在岛体带 transform 时包含块变成
  岛体,视口坐标被当相对岛体坐标 → 菜单错位到岛体边缘被 overflow:hidden
  裁剪 = 右键"没反应")。
- **音频 tab**:IndexedDB `island-audio-library`,条目 ArrayBuffer,上限
  200MB:列表 + 行内试听(**定制播放条** AudioPlayBar——圆形播放键 + 可
  拖动 seek 进度条 + 时间;点击 ▶ 挂载即自动播放;**blob URL 按条目缓存**
  (原每次渲染重建 URL,父组件任何 state 变化都换 src 中断播放 = "点击播放
  无响应"根因之一,条目移除时 revoke))+ 单个/批量导入播放列表 + 改名/
  删除/导入;**导入 type 用 `inferAudioType(name, f.type)` 扩展名兜底**
  (File.type 常为空,空 type 的 Blob 音频无法播放 = 导入音频无法播放 Bug
  根因)。
- **视频 tab**:IndexedDB `island-video-library`,**路径引用**(视频 GB 级
  不入库,导入经主进程 app:pick-media-files 对话框选文件记路径,岛内
  <video> 经 island-media:// 协议流式播放)+ 改名/删除;行内播放展开 =
  定制播放器 MediaLibVideoPlayer(与对话播放器同款 VideoExtras,双向同步)。
- **卡片 UI 统一**:行内操作按钮全部换简约 SVG 图标(播放/暂停三角、列表+
  导入、铅笔编辑、垃圾桶删除);编辑进入 = 输入框 island-ui-enter 回弹淡入
  (**根因修复:`.island-ui-enter` CSS 规则此前从未定义**——只有引用,编辑/
  记忆/技能等所有入场动画都没播;base.css 补定义后全局恢复),保存完成 =
  行尾绿色 ✓ 徽标回弹浮出(600ms)。
- **试听/播放展开/收起**:grid-rows 0fr↔1fr 高度过渡 + 内容淡入——收起
  延迟卸载(closingId 期间保留内容播完过渡再卸载,原收起瞬间内容卸载,
  过渡无内容可缩 = 高度瞬变);收起瞬间暂停播放(行 data-preview-id 定位
  video/audio pause——声音立即停,画面保留播收起动画)+ inner 上移淡出
  过渡;**展开高度显式 px 过渡**(ResizeObserver 跟随内容,视频元数据到达后
  高度变化也平滑跟随)。
- **勾选框定制**:input 隐藏,视觉框 + 对勾 SVG 描线动画 + 背景填充 + 微
  放大;批量导入播放列表按钮亮起/熄灭(:not(:disabled) 强调色底 + 呼吸光
  island-batch-glow 动画)。
- **音频导入播放列表 → 自动切回音乐模式播放**(handleAddLibraryTracks 调
  addLibraryTracks(自动播首曲)+ setMode(music),模式切换动画自动收起岛体
  ——停在多媒体库面板"导入成功却没反应"很奇怪)。
- **播放列表 ↔ 音频库同步**(useMediaPlayer.addTracks):上传歌曲到播放列表
  时音频库无同名(按文件名)则自动补录,已有不重复导入。
- **LLM 跳转播放**(2026-08-10):play_library_video 工具 → 桥校验条目 →
  派发 island:media-library-play 事件 → WidgetApp 展开面板 + 记 pending
  id → DynamicIsland 传 MediaLibraryView autoPlayVideoId → 切视频 tab/清
  搜索后展开该行自动播放(消费后清回 null;面板提前收起则作废请求,防下次
  打开意外触发)。

### 6.7 设置视图与定制能力

- **设置类视图**(settings/background/theme/font/font-color/font-library/
  image-library/lyric-api/agent-settings)一律屏蔽单击岛体、长按、Esc、
  点击面板外等一切缩回操作,只能通过返回键退出。
- **蒙版为岛体层持久层 `.island-panel-mask`**(expanded && panelView !==
  'control' 时挂载,z-index 0 在岛体背景之上、面板之下,rgba(8,10,14,0.55)
  不透明度恒为 1):面板自身不再带蒙版背景,否则面板的 maskPanelIn 淡入
  动画会连蒙版一起透明,视图切换瞬间背景图透出闪烁。面板进入动画统一纯
  淡入(maskPanelIn),不做位移回弹。
- **背景编辑器**:背景状态 = {expandedImage, compactImage, opacity,
  expanded: {zoom,posX,posY}, compact: {zoom,posX,posY}}——**展开态与
  紧凑态各有独立的图片、不透明度与裁切**(图片 IndexedDB 双槽位
  expanded/compact,旧版单图自动迁移;opacity 旧版单一数值自动迁移为双
  槽位同值;参数 localStorage widget-background);背景图层经 CSS 变量按
  形态切换(--bg-img-e/--bg-size-e/--bg-pos-e、--bg-img-c/--bg-size-c/
  --bg-pos-c);视口切形态时圆角瞬切(不做圆角动画,避免"矩形裁切到圆角"
  观感),高度与取景弹簧过渡;**背景图必须经 downscaleBackgroundImage 降
  采样(长边 ≤1024px)**:岛体形变逐帧重栅格化大图是带背景切换卡顿的主因。
- **主题色 / 字体 / 字体颜色**:主题色 localStorage widget-theme-color;
  字体库 IndexedDB island-font(10MB 上限,ttf/otf/woff/woff2)+ 参数
  localStorage widget-font;字体颜色 auto = 合成亮度算法(背景图以 opacity
  叠加在岛体深底上,取当前形态背景图 32×32 采样平均 >140 判亮 → 黑字,
  否则白字),custom = 独立颜色页(色板 + **岛内自绘取色器** IslandColorPicker
  (SV 面:横向饱和/纵向明度,pointer capture 拖动取色,不弹系统颜色对话框,
  UI 不出岛;SV 面明度黑渐变必须拆成独立 ::after 层,两层渐变叠在同一
  background 时黑渐变会在底边提前淡出;取色面/色相条不带边框——1px 边框
  + inset:0 的 ::after 只覆盖到 padding box,边框内侧露出一圈底色渐变))。
- 文字颜色经 CSS 变量注入岛体:--text-color / --text-dim,无设置时 CSS
  fallback 白色系,外观不变。
- **字体库与图片库(多条目库)**:库页面为大面板(island-lib-view,岛体 440px,
  宿主窗口同步 480);搜索框过滤、列表/网格点击应用、行内编辑名称、删除、
  上传(自动入库并应用;同一 dataUrl 不重复添加)。**图片库网格行高必须
  显式 `grid-auto-rows: 128px`**(auto 行高 + align-content: start 时,
  内容一旦超高 Chromium 会把行压缩到恰好填满容器,卡片压扁、名称被
  overflow:hidden 裁掉、内容永不过高也无法滚动);字体列表 .island-lib-row
  同理需 flex-shrink: 0。
- **图片库读取逐条容错**:library store 一条损坏记录(blob 文件丢失,
  Chromium 报 NotReadableError)会让 getAll 整个事务失败 → loadImageItems
  恒返回 [] → 图片 tab 永远空。改为 getAllKeys 取键 + **逐条独立事务 get**
  ——坏记录只失败自身、其余正常,失败条目尝试删除(移除毒瘤自愈)。
- **歌词 API 视图**(lyric-api):预设厂家 + 自定义 URL 模板 + 自动切换开关
  (定制 toggle,滑块回弹滑动 0.3s)。
- **设置视图动画**:island-ui-in(淡入+上移+微缩放,0.34s 回弹
  cubic-bezier(0.34,1.56,0.64,1))/island-ui-out(离场 0.24s 平滑)/按钮
  :active 缩放回弹;SavedBadge 保存反馈徽标(绿色对勾 SVG 描线动画 + 回弹
  淡入);**keyframes 缺失 Bug 修复**:@keyframes island-ui-in/out 从未定义
  (CSS 引用不存在的 keyframes 不报错,动画不播放)——base.css 补上。
- **Agent 设置**(agent-settings,岛体 540px + 窗口 580;四组菜单):
  连接(协议提示/API Key/Base URL/模型/思考强度/输出预算)、行为与界面
  (自定义提示词/主动陪伴/界面放大/媒体窗口默认宽)、工具与能力(MCP 服务/
  技能目录)、记忆与进化(长期记忆/自我进化)、Sub Agent(总结标题文风 +
  心理揣测人格);**界面放大**(QuickMenu 化,默认 200,档位 100/150/200/
  300 + 自定义内联输入 100-300 钳制):宽度 = expandedWidth × 缩放(JS,
  .island-agent-view 与 .island-agent-settings-view 都要 max-width: none
  放开基础 500px 上限——否则在设置视图切缩放看不到效果),高度仍由内容
  驱动(--agent-h,不乘缩放),面板本身不 transform/zoom(**只放大面板/窗口
  尺寸,UI 元素(文字/按钮/气泡)不缩放**——"让程序大一点,眼睛不累")。

### 6.8 QuickMenu 通用组件

整合按钮 + 联通展开 + 滚轮逐格切换 + 高亮滑块 + 宽度过渡全部泛化为
`<QuickMenu<T> {items, value, onChange, getLabel, onSelect?, onExpandChange?,
direction?('right'|'left'), wheelWhenOpen?}>`,四处复用:Agent 设置菜单 /
记忆类型下拉 / Agent ⋯ 菜单(direction='left')/ 帮助手册模式按钮(已随
帮助移除)。关键实现点:

- **按钮宽度过渡**:React useLayoutEffect 在 paint 前测量新内容宽写
  style.width(CSS transition: width 0.28s);**测量必须用 scrollWidth**
  (切换瞬间按钮宽 = 旧显式宽,新内容被 overflow:hidden 裁剪,
  getBoundingClientRect 读到裁剪后宽度 → 写回更小值越切越短,实测"只显示
  一个字多一点")。
- **选中高亮滑块**:绝对定位 indicator,按 offsetLeft/offsetWidth(布局值,
  不受滑入 transform 影响)写入,left/width 0.32s 过渡平滑滑动。
- **open 一体胶囊视觉**:open 时整个容器变成一个圆角胶囊(背景/描边 0.22s
  过渡),按钮取消独立边框融入胶囊成为第一段,菜单项逐项错峰滑入(0.05s
  间隔);**dir-left 的 pop 改 absolute 定位**(right: calc(100% + 2px),
  容器宽度 = 按钮宽纹丝不动,pop 向左溢出展开——flex 布局下 pop 展开会让
  容器向右变宽,按钮跟着右移,鼠标悬停位置落在子菜单上)。
- **错峰滑入选择器 nth-child → nth-of-type**(pop 首个子元素是高亮滑块
  indicator(span),nth-child 把菜单项错峰整体后移一项)。
- **联通层次感**:open 时按钮保持独立浅底+描边(0.14/0.3),与透明子菜单项
  形成主从层次。
- **wheelWhenOpen=true** 的菜单悬浮展开时滚轮照常切换;buttonAction='run'
  的菜单单击 = 执行当前选中项(⋯ 菜单)。

### 6.9 动画与性能约定(易踩坑)

1. 流式回复中高度**不用 CSS 过渡**(改由 JS 动画循环/节拍驱动,每帧启动
   CSS 过渡 = 过渡永不稳定 + 每帧布局重排,是"加载文字卡"主因);
2. agent 面板进入动画改纯淡入(maskPanelIn)——大面板首帧挂载 + scale 动画
   在软件渲染下逐帧重光栅化;
3. **垂直居中用 `transform: translateY(-50%)`,不要用 `translate` 属性**
   (透明窗口下偶发失效导致元素整体偏下,.island-extra/.island-time-particles
   都为此改过);
4. **歌词折叠**:方向性过渡——展开用回弹曲线(scaleY 过冲
   cubic-bezier(0.34,1.56,0.64,1)),收起用无过冲缓动(scaleY 过冲会翻转为
   负值镜像);挂件版静态定位,折叠 transform 是纯 scaleY(0)(不能带基础版
   的 translateX(-50%) 居中位移);
5. 组件内宽度/布局靠 JS 测量 + px→px 过渡(弹簧曲线),文字切换/悬停伸缩/
   展开收起的时序常量集中在 DynamicIsland.tsx 顶部,改动画同步时两边
   (CSS transition 与 JS setTimeout)要一致;
6. transition 简写会重置 transition-delay——需要 delay 时必须逐项写全。

---

## 第 7 章 灵动岛设置工具

### 7.1 架构

- **存储全在渲染端**(localStorage/IndexedDB),工具经 EngineDeps.
  runIslandSettings(main.cjs 注入)→ executeJavaScript 在页面上下文调
  **window.__islandSettings 设置桥**(src/settingsBridge.ts,仅挂件版
  WidgetApp 注册;与设置界面 UI 同款存储层)→ 桥写存储后派发
  island-settings-changed 事件(detail.scopes)→ WidgetApp/DynamicIsland
  监听重读 → 即时生效,无需进设置界面。
- **操作白名单(审计 P2)**:main.cjs ISLAND_SETTINGS_OPS 只放行
  settingsTools.ts 注册的操作名(防 constructor/__proto__ 原型链键命中
  被调用;新增操作时两端同步,漏加 = 安全侧失败)。**漏加修复(2026-08-10,
  实测 import_audio_library 等全部不可用)**:媒体窗口/多媒体库 10 个 op
  工具层与桥都注册了但白名单漏加 → 调桥报「未知的设置操作」——补
  setMediaWindowSize + 音频库 4 + 视频库 4 + playLibraryVideo。
- 桥的 deleteFontItem/deleteLibraryImage 不暴露给 LLM(防误删),巡检清理用。
- 工具未注入桥时不注册(Web 演示版)。

### 7.2 工具清单(21 个)

| 工具 | 说明 |
| --- | --- |
| get_island_settings | 设置快照(主题色/缩放/文字颜色/背景不透明度/当前字体/媒体窗口默认宽)——**修改前先查当前值**,setter 都带 previous 原值,已是目标值则跳过写并提示「无需修改」 |
| set_theme_color | 主题色 hex 校验归一化 |
| set_agent_scale | 界面缩放 100-300 钳制 |
| import_font / list_fonts / rename_font | 字体导入(ttf/otf/woff/woff2 ≤30MB 读盘转 data URL)/列表/改名 |
| import_background | 背景导入(png/jpg/gif/webp/bmp ≤20MB → 降采样 → **展开+紧凑双槽位都应用**+入库) |
| set_font_color | 文字颜色(custom hex 或 mode=auto 恢复自动黑白) |
| set_background_opacity | 背景不透明度(展开/紧凑槽位单独或一起改,0-1 钳制) |
| set_media_window_size | 媒体窗口默认宽(160-800 钳制) |
| list/import/rename/remove_audio_library | 音频库(import 读盘校验 → data URL ≤200MB 经桥解码 ArrayBuffer) |
| list/import/rename/remove_video_library | 视频库(import 校验扩展名/存在/≤10GB 记路径) |
| play_library_video | **跳转多媒体库视频 tab 并立即播放指定视频**(2026-08-10) |
| list_library_images / rename_library_image | 图片库列表/改名 |

- 文件读取/校验在工具层(扩展名/存在性/大小/hex/名称长度),桥错误统一
  {error} 抛给引擎按"工具执行失败"回填。
- **get_feature_guide 的姊妹能力**:文档引导工具让 LLM 具备"知道灵动岛有
  什么"的元知识(见 5.4 与第 11 章)。
---

## 第 8 章 测试体系

### 8.1 引擎核心测试(scripts/test-agent-core.mjs)

- 后端直测不经 UI:esbuild 打包测试 bundle(`electron` 别名 stub,
  Notification 记录到 global.__notifications 供断言),mock MCP 服务器
  (scripts/test-agent/):stdio(新行 JSON-RPC,含自杀/慢响应/错误/图像工具)
  + sse(GET 事件流 + POST 回传,含直接响应体与 bare 推送变体)。
- **83 用例**,覆盖:记忆增删改查/去重/上限/串行写/并发互斥/导入合并
  importEntries(去重/置顶/超限淘汰最旧)、MCP 双传输握手/命名/参数转换/
  isError/崩溃重启/并发 connect 单进程、skills 扫描/slug/重名/截断/执行、
  自我配置工具、进化快照/回滚防降级/无 Key 优雅失败、手动调用解析、设置
  工具(未注入不注册/hex 归一化/缩放钳制/字体图片文件校验/data URL 前缀/
  列表格式化/名称与 id 校验/play_library_video 透传与空 id 拒绝)、
  extractJsonTitle 严格解析(回归 "['data']"/Python 单引号 dict)、
  sanitizeTitle 前缀剥离/fallbackTitle 首条用户消息派生/sanitizeMind 清洗/
  总结与心理揣测无 Key 优雅失败、raceWithTimeout 超时/中止贯通、三 provider
  历史序列化形状 + 8000 截断 + 角色交替 + detectProvider + trimHistory、
  settings-store 原子写/防抖合帧/.bak 恢复/加密往返/resetCache、tasks 任务
  注册表(waiting/running 状态块实时可见/终态触发回调一次/回调载荷拼
  background-done 标题消息/同 id 覆盖/pruneTasks 超 TTL 清理)、
  validateRequiredArgs(空参错误文本含缺失参数名+类型+说明/完整参数通过/
  空串视为缺失/0 与 false 是合法值/无 required 跳过/_raw 附带原文/enum
  可选值列出)、Responses SSE 工具参数累积(delta 按 output_index 匹配累积
  + function_call_arguments.done 权威参数/仅 output_item.done 带参数不丢/
  maxOutputTokens 覆盖传请求体)、set_output_budget 端到端(引擎初始预算 =
  配置 ?? 8192 且越界回退/action=get 查询不改状态/LLM action=set → 预算
  即时变 + persist 写配置 + 后续请求体带新预算/越界钳制/截断响应 →
  不落定 + 注入预算不足提示)。
- **测试抓到的真实缺陷(均已修)**:① MCP JSON-RPC id 错位——重构 RpcCore
  时 requestImpl 递增 nextId 而 send 回调重读 nextId,发送 id 与 pending
  id 错位,所有请求挂到超时(requestImpl 改为把 id 传给 send);② 技能重名
  分配不确定——readdir 顺序不保证,同技能集不同运行工具名不同,破坏 LLM
  工具记忆与缓存前缀(扫描按目录名字母序排序);③ 记忆并发加载竞态——并发
  add 同时触发 load,后完成的 catch 清空刚 push 的条目(10 并发只剩 1 条,
  loadPromise 互斥)。

### 8.2 Markdown 解析器测试(pnpm test:markdown)

- esbuild 打包纯解析器直测,39 断言:块级/行内/流式退化/递归不循环回归
  (共享 /g 正则死循环 OOM 的回归用例)。

### 8.3 UI 巡检(WIDGET_SCREENSHOT)

主进程注入式 UI 巡检(electron/screenshot-tests.cjs,deps 注入,main.cjs
2224 → 1090 行后抽离)。`WIDGET_SCREENSHOT_MODE` 支持:

- 默认(mini):注入视频+图片,断言封面/自定义控件/折叠模式/全屏泄漏/退出
  位置;
- expanded / layout(输出面板各区域几何 JSON,验证布局用)/ theme / stress /
  test;
- **agent**:Agent 功能严格 UI 巡检——托盘设置 → Agent 设置视图 → 表单
  字段/四个区逐项断言 → MCP 类型切换 + 真实连接 mock 服务器(env
  WIDGET_MOCK_SERVER)→ 记忆增删 → 记忆类型按钮本体滚轮切换断言 → 进化
  触发 → 保存 → 返回收起;段 4.5 快捷切换按钮用 sendInputEvent 注入真实
  鼠标(合成 MouseEvent 不触发 CSS :hover);段 4.7 灵动岛设置工具端到端
  (直接调主进程 runIslandSettings 绕开 LLM 保证确定性——主题色 → 断言
  --state-color 即时生效;缩放 150 → 断言岛宽按比例变化;背景导入 → 断言
  --bg-img-e 生效 + 图库条目;字体导入 → 断言库条目;改名 → 断言;不存在的
  id 改名 → 断言拒绝;前后状态备份恢复);段 4.8 主动陪伴消息事件注入 +
  stub Notification;段 4.9 10 秒真实调度链路(agentSetConfig 写 10 秒 →
  渲染端调度器 tick → judge(真实 LLM)→ 主动回合落定 → 揣测通知);
- chat-media:对话媒体 UI 巡检(MediaRecorder 录真实 webm → 注入 agent:event
  message(media part)→ 断言消息气泡 + video 元素 + 可见高度;优先扫描
  `C:\Program Files\JiJiDown\Download` 第一个 mp4/mp3 注入——真实 mp4
  (中文名+空格路径)与 mp3 均 readyState 4 + decodeError null,目录不可读
  回退 MediaRecorder webm);
- media-lib:多媒体库 UI 巡检(面板/试听自动播放/编辑动画/宽度对齐/右键菜单
  应用背景/视频 autoPlay,注入走桥正规路径 + 背景备份恢复,79 用例)。

环境变量:`WIDGET_SCREENSHOT=<path>` 加载后自动截图;
`WIDGET_SCREENSHOT_QUIT=1`:截图/巡检完成后优雅退出(app.quit)——**必须
带**:应用托盘常驻不自退,测试命令若用 timeout/taskkill 强杀进程树,
子进程(bridge/GPU/renderer)被杀会打出 "renderer gone: crashed" 假象。

---

## 第 9 章 调试与巡检

### 9.1 调试工具

- `pnpm bridge`:独立运行系统媒体桥接脚本(单独调试 SMTC);
- `pnpm watch:electron`:热重建 Agent 引擎/桥(监听 electron/agent/*.ts 与
  scripts/,自动 esbuild 重建 + 重启 electron);
- WIDGET_SCREENSHOT 系列(见 8.3):截图/布局几何 JSON/UI 巡检;
- 窗口位置每次启动顶部居中,不持久化(便于调试复现)。

### 9.2 巡检执行约定

- 完整巡检(agent 模式等)只在用户明确要求时执行(每轮全量巡检耗时 8-10
  分钟且依赖真实 LLM,频繁自动跑不划算);默认完成标准 = 构建 + dev:widget
  启动 + 类型检查 + lint + 单测。
- 跑实机验证时配合 timeout 启动 electron 并在几十秒后自动退出;巡检需带
  WIDGET_SCREENSHOT_QUIT=1。

---

## 第 10 章 关键约束与踩坑记录

### 10.1 提示文本必须渲染在岛体内部

- **紧凑态与展开态均不允许超出岛体轮廓**(用户明确要求)。实现:
  DynamicIsland 的 hint prop(纯文本)——紧凑态直接注入左侧文字区(与歌名
  同款字体、同套切换动画),展开态渲染在播放键下方(island-hint-play)。
  **禁止**气泡式 Toast UI,也禁止渲染到岛体外(如窗口底部)的提示。

### 10.2 透明窗口渲染稳定性

- 去掉岛体毛玻璃(backdrop-filter 在透明窗口合成不稳)与逐帧 blur(卡顿
  主因);岛体背景全不透明(rgb(8,10,14));展开面板高度 244px;歌词行
  42px 高(防 j/g/y 下沿裁切);主进程 disableHardwareAcceleration(避免
  半透明 alpha 突变)。

### 10.3 歌词查询竞态(useLyrics)

- 本地播放器 idle 时 player.track 仍指向列表首曲(index 默认 0);外部监听
  短暂回落本地(externalActive 瞬时为 false)会误用本地首曲发起歌词查询。
  useLyrics 的响应在应用前按 lastKeyRef 校验,过期响应(曲目已切换)一律
  丢弃,否则旧响应会覆盖新曲目歌词且不会重查。

### 10.4 tools.ts 的 fs 导入陷阱

- 只用 `promises as fs`,existsSync/mkdirSync 在主模块
  (`import { existsSync, mkdirSync, promises as fs }`)——promises 没有
  existsSync/mkdirSync,实测报错;mkdirSync 曾调 undefined 被空 catch 吞掉,
  静默失败。

### 10.5 Windows 平台注意

- .cmd 命令必须经 cmd.exe /d /c 启动;cmd /c 会把 %VAR% 当环境变量展开,
  路径含 % 需加引号;
- 进程销毁走 taskkill /pid /T /F 连进程树(直接 kill 只杀 cmd 宿主,node
  子进程残留);
- 透明无边框窗口实际宽比请求宽大 ~2px(set-size 补偿见 4.3)。

### 10.6 缓存前缀稳定性(省钱关键)

- DeepSeek 上下文缓存按前缀单元命中,命中价 0.02元 vs 未命中 1元(50 倍)。
  instructions 与历史序列化幂等、tools 顺序固定、reasoning item 固定回传;
  proactive 内部指令不拼进 system prompt(动态段断前缀)。

### 10.7 双岛并存模式(设计文档,未实现)

> ⚠️ 全仓库(排除 node_modules/.git/release)对 `dual` 零匹配——main.cjs
> 的 widget:set-mode 只接受 music/agent、托盘 radio 只有两项、无
> dual-shot.cjs、git 历史无相关提交。后续开发者请勿按"已落地"假设推进。
> 设计内容(堆叠/停靠/黑洞吸纳/模式切换条/潮汐形变等)详见 CLAUDE.md
> 「双岛并存模式」章节,实现时按 screenshot-tests.cjs 先例把组合状态机
> 独立成 electron/dual.cjs。

---

## 第 11 章 功能清单与使用引导

> 本章是 `get_feature_guide` 工具的知识库:LLM 收到"你有什么功能/怎么用
> XX"类提问时,读取本章对应小节,用自然语言向用户介绍并引导。每个小节
> 都给出:功能说明 + 用户怎么说(示例问法)+ 入口位置。

### 11.1 音乐模式

- **功能**:监听系统正在播放的音乐(QQ音乐/网易云/酷狗/酷我/浏览器标签页
  音频等,经 Windows SMTC),灵动岛显示歌名/歌手/进度,展开为控制面板:
  播放/暂停、上一首/下一首、拖拽进度、循环模式、歌词字幕。
- **用户怎么说**:"听歌的时候帮我切歌""这个岛的进度条可以拖吗""歌词怎么
  打开"。
- **入口**:展开岛体 → 控制面板;歌词开关在面板(播放键下方显示厂商名);
  设置视图「歌词 API」可换歌词来源(QQ/网易/酷狗/酷我/自定义)。

### 11.2 自定义外观(主题色/背景/字体/文字颜色)

- **功能**:主题色(强调色:按钮/气泡/进度条/开关等控件颜色)、自定义背景
  (展开态与紧凑态**各自独立**的图片/不透明度/裁切)、字体库(导入
  ttf/otf/woff/woff2 并应用)、文字颜色(自动按背景亮度黑白,或自定义
  任意颜色,岛内自绘取色器)。
- **用户怎么说**:"把岛换成蓝色""背景用这张图""换一个字体""字看不太清,
  换亮一点"。
- **入口**:托盘 → 设置…;或直接对 LLM 说(用 set_theme_color /
  import_background / import_font / set_font_color 等工具,立即生效)。

### 11.3 移动挂件

- **功能**:右键长按岛体 ~0.4s 进入拖拽模式,拖动到任意位置(不限制在
  屏幕内);快速右键点击/拖动无效果。
- **用户怎么说**:"岛挡住屏幕了,帮我挪走"——但移动需要手动拖拽(右键
  长按),LLM 无法直接移动窗口位置。

### 11.4 Agent 对话

- **功能**:托盘或设置把模式切到 Agent,岛体变成 LLM 对话助手——直接对话
  即可让它执行本机操作:运行命令、读写文件、打开网页、搜索、系统信息、
  发通知、B站查询/下载、文档转换、超星答题、修改灵动岛设置、播放媒体等。
- **用户怎么说**:"帮我看看这个文件""搜一下XX的新闻""打开B站热榜"
  "把桌面截图保存一下"(需要先问清楚目标)。
- **入口**:展开岛体 → Agent 面板;输入框 Enter 发送、Shift+Enter 换行;
  运行中变"停止";⋯ 菜单有新对话/历史/工具列表/多媒体库/设置/收起。

### 11.5 工具执行透明与确认

- **功能**:每个工具调用前完整参数展示在对话里(工具卡片),执行结果回显;
  可开启「执行命令需确认」(Agent 设置,默认关)。
- **用户怎么说**:"为什么你的命令要先问我"——解释确认门开关位置。

### 11.6 本机工具能力(详细)

- exec_command:运行 shell 命令(注意:危险命令请谨慎,开启确认门更安全);
- read_file/write_file/list_dir:文件读写;
- open_url/open_file:打开网页/文件(**媒体文件在窗口内直接播放**,不弹
  外部播放器);
- web_search:网页搜索(免 Key);
- notify:系统通知;
- bili:B站搜索/热门/视频信息/下载(支持扫码登录后下载高清视频,下载到
  userData/bili/downloads/);
- doc_convert:文档转换(Word/PDF 等 → Markdown,输出到文档同目录);
- xxt:超星学习通自动答题;
- get_feature_guide:本工具(读取本文档介绍功能)。

### 11.7 B站助手

- **功能**:搜索视频、查热榜、看视频信息、扫码登录、下载视频(登录后可
  下载高清);下载完成系统通知 + 对话自动告知;登录状态在对话里可查。
- **用户怎么说**:"B站热搜是什么""下载这个视频 https://www.bilibili.com/
  video/BV…""B站登录一下"。
- **注意**:首次下载需要扫码登录(对话里展示二维码,手机 B站 App 扫码)。

### 11.8 文档转换

- **功能**:把 Word/PDF 等文档转换为 Markdown 文本(首次调用自动启动
  本地转换服务,转换结果输出到文档同目录)。
- **用户怎么说**:"把这个文档转成 Markdown""帮我转一下桌面上的报告"。

### 11.9 多媒体库

- **功能**:图片/音频/视频三个库。图片库可应用到岛体背景;音频库可导入
  本地音乐并加入播放列表(导入后自动切音乐模式播放);视频库可导入本地
  视频,在库内直接播放(支持大文件,流式)。
- **用户怎么说**:"把这首歌放进多媒体库""播放视频库里的 XX""用这张图当
  背景"。
- **入口**:托盘 → 多媒体库…;Agent 对话 ⋯ 菜单 → 多媒体库;LLM 工具
  import_audio_library / import_video_library / play_library_video。

### 11.10 MCP 服务

- **功能**:接入任意 MCP 服务器(stdio/sse),工具自动注册为
  mcp_服务名_工具名,对话中可用 @工具名 手动调用。
- **用户怎么说**:"添加一个 MCP 服务,命令是 npx xxx""测试一下这个服务
  通不通"。
- **入口**:Agent 设置 → MCP 服务(添加/编辑/测试);或对话里直接说
  (mcp_config 工具)。

### 11.11 技能系统

- **功能**:扫描 ~/.claude/skills、~/.codex/skills、~/.config/opencode/
  skills、userData/skills 中的 SKILL.md,注册为 /技能名 工具;也可在对话里
  让 LLM 直接创建技能(输入"/技能名"调用)。
- **用户怎么说**:"创建一个写诗技能""/poem-writer 写一首关于夏天的诗"。
- **入口**:Agent 设置 → 技能目录;对话中 /技能名 或 @MCP工具。

### 11.12 长期记忆

- **功能**:对话中"记住:…"写入长期记忆(偏好/事实/工作流/教训四类),
  设置界面可视化增删改查、导入导出;记忆内容参与每轮系统提示(助手
  "记得你是谁")。
- **用户怎么说**:"记住我喜欢深色主题""忘了那条关于XX的记忆吧"。
- **入口**:Agent 设置 → 长期记忆;对话里直接说(remember/forget 工具)。

### 11.13 自我进化

- **功能**:对长期记忆自动评估与优化(评审→候选→复评→棘轮接受),版本化
  快照可回滚;后台运行,完成系统通知。
- **用户怎么说**:"运行记忆进化""回滚上次进化"。
- **入口**:Agent 设置 → 自我进化。

### 11.14 主动陪伴

- **功能**:用户长时间无操作时,岛灵主动开口(基于对话语境判断是否值得
  打扰);需要真实信息时会主动调用工具查证/办事(2026-08-10 起更拟人);
  主动消息 = 系统通知 + 紧凑态文字区心理揣测。
- **用户怎么说**:"把主动陪伴关掉""间隔改成 10 分钟"。
- **入口**:Agent 设置 → 主动陪伴(开关/间隔/单位);对话里直接说
  (set_proactive_config)。

### 11.15 对话历史与标题

- **功能**:多对话存档(自动保存,最多 20 条);每轮回复完成后自动总结标题
  (紧凑态文字区显示心理揣测/标题/回复预览);「新对话」开启新会话。
- **用户怎么说**:"打开之前的对话""新对话"。

### 11.16 灵动岛设置工具(对话直达)

- **功能**:对话中直接改挂件设置并即时生效——主题色、界面缩放、文字颜色、
  背景不透明度、媒体窗口默认宽、字体导入/改名、背景导入、图片库、音频库、
  视频库、跳转播放指定视频。
- **用户怎么说**:"把岛调成紫色""界面放大到 150%""导入 D:\music\1.mp3
  到音频库""播放视频库里的视频"。

### 11.17 视频/图片小窗与全屏

- **功能**:Agent 对话里打开的视频/图片,收起面板后岛体变成媒体小窗
  (视频迷你播放器/图片缩略图);小窗可全屏(全屏 = 扩展至显示器工作区,
  右键长按拖拽移动窗口,退出全屏回到原位置)。
- **用户怎么说**:"收起面板让视频继续播""全屏看视频"。

### 11.18 常见引导话术(LLM 回复示例)

- 用户问"你有什么功能" → 用 get_feature_guide 读 11.4/11.6 等小节,按
  用户兴趣挑 3-5 个重点介绍,不要一口气列完所有功能;
- 用户说"我想让岛更好看" → 读 11.2,介绍主题色/背景/字体,并主动提议
  "要不要我现在就帮你换成 XX 色/导入这张图作背景?";
- 用户说"帮我放个视频" → 读 11.9/11.16,问清来源(本地文件/视频库/B站),
  分别用 open_file / play_library_video / bili 处理;
- 用户说"这个岛能干什么" → 读 11.4,强调"能干活":执行命令/文件/搜索/
  下载/转换,并给一个具体可试的例子("比如我可以帮你把桌面的文档转成
  Markdown")。
### 6.10 岛体组件(DynamicIsland.tsx)

岛体是两端共享的核心组件,行为差异全部靠 CSS 覆盖与可选 props 区分。
关键状态机与交互:

- **展开状态机**:compact(56px 胶囊)↔ expanded(244px 面板)。宽度 = 文字
  区内容宽度 + 固定部件,px→px 过渡(弹簧曲线);高度 = 面板内容高度,
  clamp 后过渡。展开/收起时序常量集中在文件顶部(改动画同步时 CSS
  transition 与 JS setTimeout 要一致)。
- **展开动画**:宽度过渡用**无过冲缓动 0.3s**(cubic-bezier(0.22,1,0.36,1)),
  大跨度弹簧过冲在软件渲染下抖动明显;收起为单动画(宽度/高度同时收缩 +
  压感回弹同 tick)。
- **悬停扩展**(音乐模式):紧凑态悬浮岛体扩展出进度条空间(HOVER_EXTEND_PX
  为进度条预留);Agent 紧凑态无进度条,**悬停不扩展**(targetPx 计算按
  agentActiveRef 排除)。
- **手势**:单击展开/收起(Agent 模式屏蔽单击)、长按 3D 压感、三连击
  (Web 演示版切换音乐/Agent)、左滑/右滑快捷切换(演示版)。挂件版手势
  经 onAgentTripleClick / onAgentSwipeToMusic 可选 prop 控制。
- **时间粒子**:展开态背景上的时间粒子效果(translate 属性陷阱见 6.9)。
- **歌词折叠**:折叠条件 `lyricFold = !lyricShown || (歌词查询完成且无结果)`
  (查询中保持展开防闪动);折叠时岛体加 island-lyric-off 类,挂件版高度
  244→202px;展开用回弹曲线、收起用无过冲缓动。
- **紧凑态文字区**:歌名/回复文案/心理揣测/标题共用一套切换动画,宽度随
  内容扩展;emoji 按字素截断(Intl.Segmenter)。
- **Agent 面板高度联动**:--agent-h 变量驱动 + onAgentPanelHeight 上报
  (见 6.2);窗口经 handleAgentPanelSize 动态跟随。

### 6.11 全屏与媒体小窗

- **全屏语义**:媒体小窗/对话内媒体的全屏 = 整个播放器容器
  requestFullscreen(占满窗口 viewport,控件随容器进入全屏层,原生 video
  全屏层带不了自定义控件)。
- **全屏尺寸锁定(fsLockedSize + resize 校正,2px 容差)**:Electron 透明
  窗口在移动时会自行改变窗口尺寸——全屏期间窗口任何 setWindowSize 都会让
  全屏层跟随 resize 放大 = "越来越大"的根因。WidgetApp 加 setWinSize
  统一出口(全屏期间跳过尺寸变更,移动窗口的 setPosition 不受影响,全屏层
  跟随窗口移动是标准行为;fullscreenRef 监听 fullscreenchange);
  handleDragPointerDown 全屏时**正常拖拽**(不再 exitFullscreen)。
- **退出全屏缩回动画**:leaving-fullscreen 类(3D 压感回弹 0.32s)后移除。
- **HEVC(H.265)硬解**:Chromium 默认不支持 HEVC;系统装有「HEVC 视频
  扩展」(Win11 常见)时经 Media Foundation 硬解(`enable-features`,
  PlatformHEVCDecoderSupport),对话窗口内即可播放 HEVC mp4——无扩展时此
  开关静默无效(仍走格式提示 + 系统播放器降级)。

### 6.12 Web 演示版(App.tsx)

- `pnpm dev` 浏览器直接调试岛体 UI,不依赖 Electron;带完整演示页面
  (背景/主题/字体/媒体模拟),行为差异靠 CSS 覆盖(.widget-stage 选择器
  只在挂件版生效)。
- 设置桥(window.__islandSettings)仅挂件版注册;Web 版 LLM 设置工具不注册
  (无主进程工具调用)。
- 双宿主共享 hook:useIslandCustomizations(主题色/提示/背景图+图片库/
  字体库)+ useIslandMedia(媒体数据源派生/歌词/进度),App 与 WidgetApp
  原 ~540 行逐字重复收敛为共享实现;对齐两端分叉(lyrics platformId、
  useCallback 稳定性、cycleMode 1.2s 回退经 ref 读最新值)。

---

## 第 12 章 类型系统与双端同步

### 12.1 类型镜像单向引用(根治双端类型漂移)

- `src/agent/types.ts` 改为从 `electron/agent/types.ts` **import type
  re-export + 渲染端扩展**——引擎 types.ts 零 node 运行时依赖(已核实),
  import type 编译期擦除不打包;渲染端保留 AgentStatus/AgentToolCallState/
  AgentSession/AgentPanelProps 独有类型,AgentMessage 扩展 usage、
  AgentConfig 扩展 excludedTools/excludedSkills 必填、AgentToolInfo =
  Omit<AgentTool,'execute'>;同时给引擎侧 AgentEvent 补 tool-confirm-request
  (main.cjs 实际发出但引擎类型缺失)。
- **修复的实测漂移**:usage.cached、excludedTools/Skills 可选性、
  tool-confirm-request 缺失。
- desktop.d.ts 与 preload 实为同一事实来源:agentGetConfig 返回与
  agentSetConfig 返回共用具名 IslandAgentConfig;agentGetTools 的
  parameters 补成 schema 形状(原 unknown 与 AgentToolInfo 不匹配)→
  useAgent/AgentSettingsView 三处 as 强转全部移除。
- electron 侧 TS 纳入编译检查(tsconfig.electron.json 并入 tsc -b):
  此前 esbuild 打包不查类型,electron/agent/*.ts 全部类型错误静默;修复了
  一批真实错误(MemoryStoreLike 缺 importEntries、evolution getLog 返回
  Promise、tools.ts 的 deps 悬空引用/exec 选项/fs.existsSync 错用、
  deepseek usage 缺 cached_tokens、AgentTool.execute 类型;AgentConfig.
  excludedTools/excludedSkills 改可选)。

### 12.2 共享常量(constants.ts)

- 零 node 依赖纯 TS,渲染端可安全 import(与 types.ts 同款):
  MCP_SERVICE_LABEL_PREFIX + stripMcpServiceLabel(引擎 mcp.ts 生成 /
  AgentView 候选列表剥除共用,原渲染端正则硬编码引擎格式)、
  detectProvider + providerLabel(设置界面协议提示与引擎分发共用)、
  SUMMARY_STYLES / MIND_PERSONAS(设置界面与引擎共用)。
- settingsBridge 单一来源:readAgentScale(缩放读现值)/ readMediaWindowWidth
  (媒体窗口宽读现值),收敛两处独立 clamp;MEDIA_WINDOW_STORAGE_KEY /
  AGENT_SCALE_STORAGE_KEY 键名单一来源(MediaFrame / useAgentPanelLayout
  反向导入)。

---

## 第 13 章 架构优化历史(四路审计与六轮优化)

2026-08-07 起四次多代理并行审计(渲染端/主进程/引擎/类型)与自主实施,
关键落地(按轮次):

- **第一轮(主进程轮)**:确认门并行竞态修复(P0,对话永久挂死);巡检配置
  残留修复(P0,resetSettingsCache 防旧缓存覆盖恢复文件);IPC 错误处理统一
  (safeHandle);desktop.d.ts 与 preload 漂移修复(3 处);runIslandSettings
  操作白名单(防原型链键命中);引擎事件转发统一 sendToWidget(isDestroyed
  守卫);system-media-bridge requestPS 写前判进程存活;文档修正(双岛并存
  模式标注为设计文档未实现);tsconfig 小项(vite.widget.config.ts 纳入
  tsconfig.node.json)。
- **第二轮(推荐项落地)**:engine.ts 拆分(1291 → 763 行,Sub Agent 全家 →
  subagents.ts;createConfigTools → configTools.ts;engine.ts re-export
  保持测试/main.cjs 导入路径零破坏;拆前用 diff 逐字节核对搬移块——曾误删
  trimHistory/确认门,从备份恢复后按精确边界重删);provider 公共层
  (parseSse/truncateResult 单一实现,删 chat.ts 死副本 parseToolArgs);
  useWheelSwap hook(4 处 tick/prev/dir 状态舞蹈收敛);settings-store.cjs
  (设置持久化可单测,main.cjs 留同名薄包装 17 处引用零改动)。
- **第三轮(高内聚低耦合)**:constants.ts(零 node 依赖共享常量);
  useAgent 内部收敛(loadConfigAndTools / truncateCodepoints);useLeavingList
  hook(离场动画定时器模式 5 处收敛:会话历史行/工具禁用行/MCP 卡片/技能
  行/记忆条目);conflictsWithBar(layout.ts 收敛);readAgentScale 导出;
  技能扫描 TTL 缓存(~1s)。
- **第四轮**:AgentSettingsView 拆组件(McpServerCard / SkillsSection /
  loadMemoryList);AgentView 收敛(scrollMessagesToBottom / BackArrowIcon);
  死通道清理(widget:hide/quit/topmost/set-height 四个零调用 IPC 删除)。
- **第五轮**:tools 双通道收敛(agentConfigProp 去掉 tools,设置视图统一从
  agent prop 取——单一来源,消"只更新一条通道静默漂移");未跟踪定时器
  修复(useIslandMedia cycleMode 1.2s 跟随检测);smtc-bridge.cs 会话选择
  循环收敛 PickSession();main.cjs asArray 兜底收敛;过时注释修复。
- **第六轮**:desktop.d.ts 类型补全(IslandAgentConfig / parameters schema
  形状);明确不做(App/WidgetApp 宿主接线工厂、状态文案双源合并、面板视图
  注册表——收益与风险不成比例,见 CLAUDE.md 记录)。
- **引擎 P0 缺陷修复**:delegate 子代理继承主回合 abort 信号;确认门改为
  子代理启动时捕获 myGate 实例;工具超时覆盖(AgentTool.timeoutMs 字段)。
- **引擎 P1**:AgentEvent.message.usage 补 cached;三 provider 历史序列化
  回归测试(72 用例新增)。
- **渲染端 P0/P1/P2**:useAgentPanelLayout hook(面板高度 JS 动画状态机 +
  界面缩放,从 DynamicIsland 逐字搬移,1905→~1760 行);
  src/media/imageUtils.ts(loadImageNaturalSize/sampleImageBrightness 收敛
  三处 canvas);src/agent/text.ts(textFromParts/textFromMessage);clampExpandedWidth
  + 两个 seq effect 合并;WidgetApp VIEW_WINDOW_H 键类型 Partial<Record
  <PanelView, number>>(拼错键编译器兜底)。

---

## 第 14 章 配置项与持久化键一览

### 14.1 settings.json(主进程,userData)

| 键 | 说明 |
| --- | --- |
| alwaysOnTop | 置顶开关(托盘) |
| mode | music / agent(托盘模式切换,启动恢复) |
| agent.apiKey | API Key(safeStorage DPAPI 加密,enc: 前缀) |
| agent.baseURL / model | Base URL(自动判定 provider)/ 模型名 |
| agent.systemPrompt | 自定义提示词(与记忆共同构成系统提示) |
| agent.reasoningEffort | 思考强度 none/low/medium/high |
| agent.maxOutputTokens | 输出预算(4096-262144,缺省 8192) |
| agent.confirmExec | exec_command 确认门(默认关,字段保留兼容) |
| agent.proactiveEnabled / proactiveInterval / proactiveIntervalUnit | 主动陪伴(默认开 / 15 / 分钟) |
| agent.summaryStyle / mindPersona | Sub Agent 文风/人格(预设 id 或自定义) |
| agent.mcpServers | MCP 服务配置(name/type/command/args/env/url/headers) |
| agent.skillsDirs | 技能扫描目录 |
| agent.excludedSkills | 排除的技能 slug 数组 |

### 14.2 渲染端 localStorage

| 键 | 说明 |
| --- | --- |
| widget-theme-color | 主题色 |
| widget-agent-scale | Agent 界面缩放(100-300,缺省 200) |
| widget-media-window | 媒体窗口默认宽(160-800,缺省 320) |
| widget-background | 背景参数(双形态图片 IndexedDB island-background) |
| widget-background-opacity | 旧版不透明度键(仅迁移读取) |
| widget-font | 字体参数(currentFontId/colorMode/colorValue;库 IndexedDB island-font) |
| widget-lyric-provider / widget-lyric-auto | 歌词 API 厂商/自动切换 |
| widget-agent-messages | 对话消息(同步写不防抖) |
| widget-agent-sessions | 会话历史(上限 20 条) |
| widget-agent-title / widget-agent-mind | 标题/心理揣测 |
| widget-video-prefs | 视频偏好(音量/倍速/循环,三处同步) |
| island-seek-support | seek 能力记忆(按 sourceAppId) |

### 14.3 渲染端 IndexedDB

| store | 键 | 说明 |
| --- | --- | --- |
| island-uploads | - | 上传音乐 |
| island-background | expanded / compact + library | 背景双槽位原图 + 图片库 |
| island-font | fonts | 字体库(10MB 上限) |
| island-audio-library | - | 音频库(ArrayBuffer,200MB 上限) |
| island-video-library | - | 视频库(路径引用,10GB 上限) |

### 14.4 userData 文件

| 文件 | 说明 |
| --- | --- |
| settings.json | 引擎/挂件配置(见 14.1) |
| memory.json | 长期记忆(200 条上限) |
| memory-snapshots/ | 进化版本快照 v<N>.json |
| memory-state.json | 进化版本号/评分 |
| evolution.json | 进化日志(20 条上限) |
| bili/ | B站登录态/下载(下载在 bili/downloads/) |
| xxt-profile/ | 超星登录态/截图 |
| skills/ | 挂件自有技能目录 |

---

## 附录 A:Agent 事件一览

| 事件 type | 载荷要点 | 说明 |
| --- | --- | --- |
| status | {status: idle/thinking/running/error} | 状态机 |
| text | {messageId, text} | 流式文本增量 |
| reasoning | {messageId, text} | 思维链增量(深度思考) |
| tool | {messageId, callId, name, args, executing} | 工具调用流式 |
| tool-call | {messageId, callId, name, args} | 工具开始执行(完整参数展示) |
| tool-result | {messageId, callId, name, result, durationMs} | 工具结果回显 |
| message | {id, role, parts, usage, proactive?} | **权威落定** |
| tool-confirm-request | {seq, command} | 确认门请求 |
| background-done | {title, message} | 后台任务终态 → 自动触发对话 |
| mind-proactive | {messageId, guess} | 主动回合心理揣测 |

## 附录 B:常量与阈值表

| 常量 | 值 | 说明 |
| --- | --- | --- |
| ISLAND_COMPACT_H | 56px | 紧凑态高度 |
| 展开面板高度 | 244px(音乐)/ 540px(Agent 设置)/ 440px(库/设置) | 挂件版覆盖 |
| MAX_WIDTH_PX | 500px | 岛体宽度上限 |
| HOVER_EXTEND_PX | ~40px | 音乐紧凑态悬停扩展(进度条) |
| 工具结果回填 | 8000 字符 | 截断 |
| trimHistory | 400K token,至少 10 条 | 预算裁剪 |
| max_output_tokens | 8192(主对话)/ 4096(总结等短任务) | 动态可调 4096-262144 |
| 工具兜底超时 | 60s(AgentTool.timeoutMs 可覆盖) | doc_convert 200s / xxt 310s |
| 迭代上限 | 25 轮 | 防死循环 |
| 总结/判断超时 | 90s / 60s | Sub Agent |
| MIND_MAX_LEN / MAX_RETRIES | 16 码元 / 5 次 | 心理揣测 |
| 标题长度 | 推荐 10 字,≤20 码元 | sanitizeTitle 硬截断 |
| 记忆 | 200 条 / 单条 500 字 | memory.json |
| 技能 SKILL.md | 注入截 8000 / desc 截 300 | |
| 媒体窗口 | 160-800,缺省 320 | 对话媒体初始宽 |
| 视频库 | 路径引用,≤10GB | island-media 流式 |
| 音频库 | ArrayBuffer,≤200MB | |
| 主动陪伴间隔 | 5-480,默认 15 分钟 | |
| 界面缩放 | 100-300,默认 200 | 只放大窗口/面板,UI 不缩放 |
| 全屏尺寸校正 | 2px 容差 | fsLockedSize + resize 校正 |
| 后台任务 TTL | 终态 24h / 进行中 6h | pruneTasks |
| 图片库行高 | grid-auto-rows: 128px | 防行压缩 |
---

## 第 15 章 深入:引擎单轮生命周期(engine.ts)

### 15.1 runTurn 完整流程

```
runTurn(text, history, ctx, opts)
├─ 状态:onEvent({type:'status', status:'thinking'})
├─ historyIn = [...trimHistory(history)]  // 复制数组!trimHistory 未超限
│   时返回原引用,后续 push 会改到调用方(渲染端)的历史
├─ proactive? → 末尾追加 role:'system' 内部指令(见 5.8)
├─ 确认门重置(turnCommandConfirmed = false;gate = createTurnConfirmGate)
├─ 手动调用解析(parseManualCall:/技能名 或 @mcp工具)
│    └─ 命中 → 先执行工具,结果以 tool-call/tool-result parts 入历史,
│        LLM 基于结果直接回复
├─ 循环(上限 25):
│   ├─ tools = 内置 + getExternalTools(MCP + 技能,失败静默跳过)
│   ├─ 预算检查:outputBudget 每轮传当前值
│   ├─ streamByConfig → ProviderOutcome
│   │   ├─ 流式事件(text/reasoning/tool)转发 UI(rAF 合批在渲染端)
│   │   └─ calls / text / usage / truncated
│   ├─ truncated(预算截断)→ 已输出文本入历史 + 注入 BUDGET_TRUNCATE_HINT
│   │    (每回合一次),LLM 自主判断调预算或收尾
│   ├─ 有 calls → executeToolBatch:
│   │   ├─ 参数校验 validateRequiredArgs(缺参生成结构化错误,不执行)
│   │   ├─ Promise.all 并行(每工具独立 raceWithTimeout 60s/tool.timeoutMs)
│   │   ├─ 确认门(开启时首个命令请求确认)
│   │   └─ 结果截断 8000 → tool-result parts 回填历史 → 续调
│   └─ 无 calls → 落定
├─ message 事件(parts/usage/耗时/proactive 标记)
└─ 异常/中止收敛(AbortController + raceWithTimeout 清理定时器)
```

### 15.2 消息 parts 模型

AgentMessage = {id, role, parts[]};parts 类型:

| type | 载荷 | 说明 |
| --- | --- | --- |
| text | text | 文本块(流式累积) |
| reasoning | text | 思维链(累积,回传必需) |
| tool-call | callId, name, args | 工具调用 |
| tool-result | callId, name, result, durationMs | 工具结果 |
| media | kind, url, name | 媒体附件(open_file 拦截等) |

历史序列化按 provider 输出(Responses items / Chat messages / Anthropic
messages)——角色交替、tool-call/result 成对打包、reasoning 回放规则见
5.3。**每轮只把"新增部分"推给下一轮**(pushedParts 指针),避免整段累积
parts 重复回填(上下文成倍膨胀)。

### 15.3 事件转发与中止

- 引擎事件经 `agent:event` 转发(webContents.send),统一 sendToWidget
  (isDestroyed 守卫);
- 中止:agent:abort → ctl AbortController → 流式中断 + 在途工具失败返回
  + 子代理循环提前 break;渲染端 status idle 后迟到的流式事件丢弃;
- 渲染端 abort 竞态双修(见 6.1)。

---

## 第 16 章 深入:媒体播放链路

### 16.1 island-media:// 自定义协议

```
渲染端:island-media://local/<encodeURIComponent(绝对路径)>
主进程(protocol.handle):
├─ 解析路径 + 扩展名校验(仅媒体:图片/视频/音频)
├─ 大小上限:视频 10GB / 音频 1GB / 图片 10GB(超限 413)
├─ Range 解析(206 + Content-Range;视频 seek 必需——Chromium
│    file:// 请求不支持 Range 返回 416 实测)
└─ fs.createReadStream → Web ReadableStream 分块发送(内存 ≈ 块大小)
特权:registerSchemesAsPrivileged(stream/standard/secure/supportFetchAPI)
  在 app ready 前;handler ready 后挂载;CSP img/media-src 放行。
```

### 16.2 视频播放器控件(三处共用)

- 组件:VideoPlayer(对话消息)/ MediaLibVideoPlayer(多媒体库)/
  AgentMediaMini 进度条(视频岛);
- 控件:圆形播放键(PlayPauseSwitch 同向旋转交叉淡入)+ 可拖动 seek 进度条
  (4px 圆角条 + 强调色渐变填充 + 悬停/拖拽圆点 thumb)+ 时间 + 全屏 +
  VideoExtras(音量 pop / 更多菜单:倍速/循环);
- **双向同步(videoPrefs)**:音量/倍速/循环存 localStorage widget-video-prefs,
  变更派发 island:video-prefs 事件,三处监听实时应用(共享模块
  src/media/videoPrefs.ts:loadVideoPrefs / setVideoPrefs / onVideoPrefsChange);
- **进度双向同步(agentMediaPositions)**:MediaFrame 节流上报(~1Hz)
  position → 收起快照 → 小窗挂载 seek 续播;小窗 timeupdate 回写缓存 +
  agentPlaying → 展开回面板续播;
- **音量 pop 实现要点**(2026-08-10 用户三轮要求):垂直自绘条 + 深色背景槽
  (18px 宽 76px 高,rgba(8,10,14,0.88) + 细描边 + 阴影),`bottom: 100%`
  贴按钮顶无间隙(3px 间隙会让鼠标移向音量条时丢 :hover 消失)、槽体即
  命中区(原 4px 窄条,鼠标稍偏即落容器外丢 hover),scaleY 0→1 动画;
  拖拽期间 pickingRef 屏蔽 prop 回读(避免量化往返抖动)。

### 16.3 封面抓帧

- 对话视频默认展示第一帧作封面(黑色画面难辨认);video 跨域加载需
  crossOrigin="anonymous"(canvas 污染防抖),本地 island-media:// 同源
  放行;抓帧失败回退黑色 + 播放键。

---

## 第 17 章 安全与隐私

- **Electron 安全显式化**:webPreferences 显式 sandbox/webSecurity;挂件页
  CSP meta(script/style/img/font/media/connect 白名单,file:// 实测渲染
  正常;`media-src 'self' blob:` 必须保留——缺它时上传音乐的 blob URL
  音频被 CSP 拦截无法播放);setWindowOpenHandler deny。
- **工具无沙箱**:exec_command 等可操作本机任何内容——确认门(默认关)是
  唯一护栏,危险命令请在设置里开启;
- **设置工具白名单**:runIslandSettings 操作白名单防原型链键命中;桥的
  deleteFontItem/deleteLibraryImage 不暴露给 LLM(防误删);
- **island-media 协议**:扩展名校验(仅媒体可访问防任意文件读取)+ 类型
  大小上限;
- **API Key 加密**:safeStorage(DPAPI)加密落盘(enc: 前缀,解密失败回退
  null 重填);
- **xxt 登录态隔离**:XXT_PROFILE_DIR/XXT_SCREENSHOT_DIR 指向
  userData/xxt-profile(原 .browser_profile 含用户登录态,不随仓库分发);
  bili 登录态落 userData/bili(BILI_BASE_DIR);
- **Markdown 渲染无注入面**:全部文本 React 转义,唯一例外 mermaid SVG
  (securityLevel 'strict' 自带转义)。

---

## 第 18 章 常见问题(FAQ)

### 18.1 音乐相关

- **进度条不动/回跳**:外部平台上报位置不可信,显示进度 = 本地时钟锚定,
  仅在曲目/播放状态变化或真实 seek 时重锚(见 3.3);
- **切歌后歌词不对**:搜索匹配按相似度评分取最优,短歌名/带副标题/歌手
  缺失时仍可能对不上——可在设置换歌词厂商(QQ 默认最稳);
- **不支持 SMTC 的客户端**:点击后 1.2s 检测未生效 → 岛内提示并回退;
  本地播放器兜底(上传音乐)。

### 18.2 Agent 相关

- **LLM 一直空参调用工具**:validateRequiredArgs 结构化错误回填让 LLM
  自纠;仍不行可检查输出预算(思考模式高 effort 会吃光 4096,调
  set_output_budget 或把思考强度调低);
- **回复被截断**:max_output_tokens 不足——对话里说"调大输出预算"或手动
  改 Agent 设置;
- **总结标题/心理揣测不出现**:看是否 Agent 模式 + API 配置正常;标签
  runner 有 1.5s 重试/10s 补跑兜底;全部失败回退首条用户消息标题;
- **主动陪伴不触发**:检查 主动陪伴开关、间隔(默认 15 分钟)、是否有对话
  历史、judge 是否 should:false(安全侧保守);
- **B站下载失败**:先确认扫码登录(对话里说"B站登录一下",展示二维码);
  下载落点 userData/bili/downloads/。

### 18.3 界面/窗口相关

- **窗口位置漂移/变大**:透明窗口 + 全屏的已知问题,fsLockedSize 校正
  (见 6.11);普通展开向右漂移由 set-size 补偿修复(见 4.3);
- **视频格式不支持**:窗口内只支持 H.264 mp4 / webm(vp8-vp9)/ ogg;
  HEVC 需系统「HEVC 视频扩展」;其它格式点"在系统播放器中打开"降级;
- **点击穿透导致按钮点不到**:鼠标必须悬停岛体(岛体 mouseenter 切换
  接收);岛体边缘部分区域为穿透设计;
- **界面缩放不生效于文字**:缩放只放大面板/窗口尺寸,UI 元素不缩放
  (用户明确要求)。

### 18.4 开发相关

- **改了 electron/agent/*.ts 没生效**:必须重跑 pnpm build:electron
  (dev:widget 已前置,或 watch:electron 热重建);
- **测试**:node scripts/test-agent-core.mjs(引擎)/ pnpm test:markdown
  (解析器);巡检见第 8 章。

---

## 第 19 章 未来规划(设计文档)

### 19.1 双岛并存模式(设计文档,未实现)

> ⚠️ 全仓库对 `dual` 零匹配——main.cjs 的 widget:set-mode 只接受
> music/agent、托盘 radio 只有两项、无 dual-shot.cjs、git 历史无相关提交。
> 本段是设计文档,尚未落地,请勿按"已落地"假设推进。

托盘"模式"新增第三项 **双岛并存模式**(settings.json mode: 'dual',radio
三选一):音乐灵动岛与 Agent 灵动岛**各占一个窗口并存**
(widget.html?island=music|agent 查询参数注入角色)。两岛独立拖拽、独立
展开,支持**拖拽组合**(堆叠/停靠/黑洞吸纳)与**展开态模式切换条**。详细
设计(组合状态机/切换条/潮汐形变/LOGO 球/黑洞粒子/架构要点/踩坑实录)见
CLAUDE.md「双岛并存模式」章节;实现时按 screenshot-tests.cjs 先例把组合
状态机独立成 electron/dual.cjs(main.cjs 已 1180 行)。

### 19.2 有意未做(审计结论)

- 手势/展开状态机抽 hook(350 行,历史 bug 密集无测试,收益与风险不成
  比例);
- main.cjs 全量 CJS 拆分(先抽测试块,文件继续膨胀再拆);
- preload/main @ts-check(全量 JSDoc 成本高,以共享常量 + 类型化包装替代);
- DynamicIsland 再抽 useAgentScale/useScrubControl 与面板视图注册表(注释
  已完善,拆分收益低于风险,待下次交互改造时顺手);
- App/WidgetApp 宿主接线工厂(需 ~25 个参数,收益<风险);
- 状态文案双源合并(紧凑态流程文案 vs 头部状态徽标语义不同)。

---

## 附录 C:术语表

| 术语 | 说明 |
| --- | --- |
| SMTC | System Media Transport Controls,Windows 系统媒体会话 |
| 岛体 | 灵动岛本体组件(DynamicIsland.tsx) |
| 紧凑态 / 展开态 | 收起胶囊 / 展开面板 |
| 媒体小窗 | 收起 Agent 面板后岛体变形的视频/图片小窗(AgentMediaMini) |
| media part | AgentPart 的媒体附件类型(窗口内播放) |
| 确认门 | exec_command 首轮执行确认(createTurnConfirmGate) |
| 后台任务注册表 | tasks.ts 通用任务(waiting/running/done/failed/cancelled) |
| Sub Agent | 独立实例的辅助 LLM 调用(总结标题/心理揣测/判断/进化评估/子代理) |
| 棘轮 | 进化评分严格高于原分才接受新版本 |
| 前缀缓存 | DeepSeek 上下文缓存(前缀完整匹配才命中) |
| trimHistory | 历史预算裁剪(400K) |
| outputBudget | 引擎可变输出预算(set_output_budget 调整) |
| QuickMenu | 通用滚轮切换菜单组件(整合按钮 + 联通展开 + 高亮滑块) |
| WheelSwap | 内容交换动画组件(滚轮逐格重挂载重放) |
| 设置桥 | window.__islandSettings(settingsBridge.ts,LLM 设置工具入口) |
| island-media:// | 本地媒体流式协议(Range 支持) |
| VIEW_WINDOW_H | 各面板视图对应的宿主窗口高度表 |
| SETTINGS_VIEWS | 设置类视图集合(屏蔽一切缩回操作) |
| 巡检 | WIDGET_SCREENSHOT UI 测试(截图 + 断言) |
| 双岛并存 | 设计文档中的 dual 模式(未实现) |
---

## 第 20 章 渲染端音乐 UI 详解

### 20.1 展开面板布局

- 挂件版展开面板高度 244px(覆盖组件默认 208px;控制区 flex: none 贴
  进度条,无居中留白);
- 控制区:播放/暂停、上一首/下一首、进度条(可拖拽)、播放模式(循环/
  随机)、播放键下方提示(歌词厂商名 / hint);
- 歌词在挂件版改回文档流(static),歌词行 42px 高(两行 0.78rem×1.4 歌词
  + 底部余量,防 j/g/y 下沿裁切);
- 紧凑态:左侧文字区(歌名 + 状态文案)+ 右侧图标(音乐音符 / Agent 四角星),
  宽度随文字内容扩展,px→px 过渡。

### 20.2 进度条与手势

- 进度条 4px 圆角条 + 强调色渐变填充,悬停/拖拽显示圆点 thumb;
- 点击进度条 seek(仅左键,button !== 0 守卫——右键只属于拖拽);
- 播放模式循环:点击后 1.2s 检测系统是否跟随,没跟随则提示并回退(UI
  显示系统真实状态);
- seek 支持记忆(island-seek-support 按 sourceAppId 持久化,见 3.3)。

### 20.3 时间粒子与氛围

- 展开态背景时间粒子效果(island-time-particles);垂直居中必须用
  transform: translateY(-50%),不要用 translate 属性(透明窗口下偶发失效)。

### 20.4 播放列表(本地播放器)

- 上传音乐 IndexedDB(island-uploads);列表行:封面/名称/时长/操作(播放/
  删除);
- 播放列表 ↔ 音频库同步(见 6.6);导入播放列表自动播放首曲。

### 20.5 双宿主接线(WidgetApp 数据流)

```
WidgetApp
├─ useSystemMedia(SMTC 外部平台)──┐
├─ useMediaPlayer(本地播放器)─────┤ externalActive 决定走哪边
│                                  ├─ 双向暂停(切走一方自动暂停)
├─ useIslandCustomizations(主题/背景/字体/图片库)
├─ useIslandMedia(媒体数据源派生/歌词/进度/seek)
├─ useAgent({allowProactive: mode==='agent'})(Agent 事件流)
├─ 设置桥注册(registerIslandSettingsBridge)
├─ onSettingsChange 监听(theme/scale/font/background/imageLibrary/
│    mediaWindow/mediaLibrary → 重读对应状态,LLM 设置工具即时生效)
├─ onMediaLibraryPlay(play_library_video 跳转播放)
├─ 窗口 IPC:widget:pointer / drag / set-size / fullscreen / set-mode
└─ DynamicIsland 渲染(所有状态 + 回调)
```

---

## 第 21 章 性能优化手册(软件渲染约束)

主进程 disableHardwareAcceleration 后一切渲染走软件路径,本项目性能
策略都围绕"软件渲染贵"展开:

1. **rAF 合批**:跨 IPC 消息的多次 setState 不自动批处理 → 事件直写镜像、
   帧内一次提交(useAgent);
2. **节拍节流**:流式测量 80ms 节拍(强制 reflow 的 offsetHeight/
   getComputedStyle 不逐帧跑);窗口 resize 16ms min-interval / 100ms
   trailing 合帧;
3. **动画禁用重光栅化**:
   - 流式高度不启用 CSS 过渡(每帧启动过渡 = 过渡永不稳定 + 每帧布局
     重排);
   - 大面板进入动画纯淡入(maskPanelIn),不做 scale;
   - 滚动动画挂件版直接跳底(零动画成本);
   - 背景图降采样(长边 ≤1024px,岛体形变逐帧重栅格化大图是背景切换卡顿
     主因);
4. **DOM 最小化**:骨架屏两阶段(形变动画期间 DOM 极小);工具汇总列表默认
   折叠;0fr 折叠 padding-bottom 归零;
5. **mermaid 懒加载 + SVG 缓存**:动态 import 构建分包,按代码字符串缓存,
   流式重解析/视图切换不重复渲染;
6. **React.memo + Map 配对**:已落定消息块 memo,工具结果一次遍历建 Map
   (去 O(parts²));
7. **blob URL 缓存**:音频试听按条目缓存(原每次渲染重建 URL 中断播放);
8. **协议流式**:island-media 分块发送,内存 ≈ 块大小(10GB 视频不 OOM)。

---

## 第 22 章 调试速查

### 22.1 常见场景速查

| 场景 | 命令/做法 |
| --- | --- |
| 日常开发 | pnpm dev:widget(构建 + 启动,前置 build:electron) |
| 只测 Web UI | pnpm dev(浏览器) |
| 改引擎/桥热重建 | pnpm watch:electron |
| 引擎测试 | node scripts/test-agent-core.mjs(83 用例) |
| Markdown 测试 | pnpm test:markdown(39 断言) |
| 类型检查 | pnpm build(tsc -b + vite) |
| lint | pnpm lint |
| 单跑 SMTC 桥 | pnpm bridge |
| UI 巡检 | WIDGET_SCREENSHOT=<path> WIDGET_SCREENSHOT_QUIT=1 pnpm dev:widget |
| 杀残留 electron | powershell Stop-Process -Name electron |

### 22.2 巡检模式一览

| WIDGET_SCREENSHOT_MODE | 内容 |
| --- | --- |
| (默认) | mini:视频岛/图片岛 UI(封面/控件/全屏/续播) |
| expanded | 展开态截图 |
| layout | 面板各区域几何 JSON(布局验证) |
| theme / stress / test | 主题 / 压力 / 基础 |
| agent | Agent 全链路(设置/记忆/进化/设置工具/主动陪伴/快捷按钮) |
| chat-media | 对话媒体(消息气泡视频/音频) |
| media-lib | 多媒体库(79 用例) |

### 22.3 常见坑(一分钟自查)

- 改 electron/agent 没生效 → 重跑 build:electron(dev:widget 已前置);
- 视频"无法播放" → 格式限制(H.264 mp4/webm/ogg)或 HEVC 扩展缺失;
- 窗口越拖越大 → 全屏期间 setWinSize 出口(6.11);
- 点击穿透点不到 → 鼠标悬停岛体;
- LLM 设置工具报"未知的操作" → main.cjs ISLAND_SETTINGS_OPS 白名单
  漏加(7.1);
- 缓存命中率低 → 检查 instructions/历史序列化幂等、tools 顺序固定、
  reasoning 固定回传(5.3.4)。

---

## 附录 D:修改清单(给后续开发者的工作流模板)

完成一次功能改动后的标准动作:

1. `pnpm build`(tsc -b 双端类型 + Web 构建);
2. `pnpm lint`;
3. `node scripts/test-agent-core.mjs`(引擎改动必须;新增工具/行为补用例);
4. `pnpm test:markdown`(解析器改动);
5. `pnpm dev:widget` 实机验证(默认完成标准,配 timeout 自动退出;
   完整巡检只在用户明确要求时跑,需 WIDGET_SCREENSHOT_QUIT=1);
6. 同步文档:README(用户向)/ WIDGET-README(部署)/ docs/TECH.md(技术);
   引擎/工具/常量改动同步 CLAUDE.md 对应章节与本文档第 5/7 章;
7. 新增渲染端设置工具操作 → settingsTools.ts op 类型 + 桥方法 +
   main.cjs ISLAND_SETTINGS_OPS 白名单三处同步(漏白名单 = 安全侧失败);
8. 新增 IPC → preload + desktop.d.ts + main.cjs safeHandle 三处同步。
---

## 第 23 章 双入口行为差异表

| 行为 | Web 演示版(App.tsx) | 桌面挂件(WidgetApp.tsx) |
| --- | --- | --- |
| 入口 | vite.config.ts(src/) | vite.widget.config.ts(widget/,base='./' file:// 可加载) |
| 内置歌单 | tracks.ts 返回完整内置 MP3 | **空歌单**(--mode widget,产物剔除 music 资源) |
| 媒体数据 | 模拟/本地播放器 | useSystemMedia(SMTC)+ useMediaPlayer 双轨 |
| 设置桥 | 不注册(无主进程工具调用) | registerIslandSettingsBridge(LLM 设置工具入口) |
| 窗口 | 普通页面 | 透明无边框 + 点击穿透 + 右键长按拖拽 |
| 模式切换 | 控制区按钮/三连击/滑动手势 | 托盘菜单(radio,持久化)+ LLM switch_to_music |
| 主题色入口 | 控制区 settingsButton | 设置视图内部(控制区无主题色按钮) |
| 滚动动画 | 平滑滚动 + 动态高斯模糊(GPU) | 直接跳底(软件渲染零动画成本) |
| 提示文本 | hint prop 渲染岛内 | 同款(禁止岛外 Toast) |
| 手势 | 三连击/左滑右滑可用 | 可选 prop 控制(Agent 模式屏蔽) |

---

## 第 24 章 音乐模式深入实现

### 24.1 useSystemMedia(外部平台监听)

- 轮询桥状态(playbackStatus/title/artist/position/duration/playbackMode/
  sourceAppId),曲目变化/播放状态变化重锚定;
- 显示进度 = 锚定基准 + 本地时钟流逝(见 3.3);
- 控制(play/pause/next/previous/seek/cycleMode)经桥下发,乐观执行 +
  挂起验证(seek ±3s 或单次跳变 >5s 视为生效;3s 超时回退);
- 验证结果按 sourceAppId 持久化(localStorage island-seek-support)。

### 24.2 useMediaPlayer(本地播放器)

- 播放列表(上传音乐 IndexedDB island-uploads)+ 进度/时长/播放模式;
- 上传/删除/排序;addTracks 自动补录音频库(见 6.6);
- 歌词:本地曲目无外部歌词时走歌词 API 查询(useLyrics + provider)。

### 24.3 useLyrics(歌词查询)

- 查询 key = provider|id|title|artist(切换厂商即刷新,见 3.4);
- lastKeyRef 校验过期响应(曲目已切换一律丢弃);
- lyricPosition 单独成轨渲染(见 3.4);歌词行 42px 高,折叠动画方向性
  (展开回弹/收起无过冲)。

### 24.4 数据源切换细节

- externalActive 为 true 时:进度/时长/播放模式/曲目全部取外部系统;
- 切走一方自动暂停(双声齐响防护);
- 外部短暂回落本地(瞬时 false)不误用本地首曲发歌词查询(useLyrics
  竞态防护)。

---

## 第 25 章 引擎工具实现细节补充

### 25.1 web_search

- Bing 主用、DDG 回退(duckduckgo 在中国不可达,实测 fetch failed);
- Bing 解析 li.b_algo 的 h2 链接 + p 摘要;HTML 端点免 Key;
- 结果截断 8000 回填。

### 25.2 notify

- new Notification({title, body}),Windows 需 app.setAppUserModelId
  (否则静默失败,2026-08-07 修复);
- 测试环境 stub 记录到 global.__notifications 供断言。

### 25.3 open_url

- shell.openExternal;main.cjs 校验 http/https 白名单(防 window.open
  弹裸窗口);Web 演示版回退 window.open。

### 25.4 open_file / exec_command 媒体拦截

- open_file:媒体扩展名命中 → 返回 {text, media:[{kind,url,name}]} →
  引擎注入助手消息 media part → 渲染端 MediaFrame 窗口内播放;
- exec_command:`start "标题" "路径"` 解析(双引号形式取第二段、裸 token
  取首词,相对路径按 cwd 解析,单引号串 = 纯标题不拦截)→ 同款拦截;
  路径不存在时抛错引导 LLM 用 open_file 传完整绝对路径(文件名含空格/
  引号时裸 token 解析会截断 → 协议 404 → 渲染端假报"格式不支持");
- mediaKindForPath 与 open_file 共用;exec_command 描述注明勿用 start
  打开媒体。

### 25.5 EngineDeps 接口(main.cjs 注入)

| deps | 说明 |
| --- | --- |
| runIslandSettings?(op, args) | 灵动岛设置工具桥(未注入不注册) |
| updateAgentConfig(patch) | LLM 自我配置(applyAgentConfigPatch 校验) |
| confirmCommand(req) | 确认门(未注入 = 永不确认) |
| getMemoryStore() / getEvolution() | Sub Agent 同源上下文 |
| getSkillDir() | 技能创建目录(userData/skills) |
| setTaskDoneHandler(cb) | 后台任务终态接线 |
| getLastProactiveTick() | 主动陪伴调度判定(巡检用) |

---

## 第 26 章 设置视图深入

### 26.1 背景编辑器

- 分段编辑(展开态/紧凑态独立:上传/移除/不透明度滑杆作用于当前形态);
- 裁切视口(预览框)自身不透明显示原图、不受蒙版影响;视口切形态时圆角
  瞬切;高度与取景弹簧过渡;
- 背景视图需要更高空间:岛体加 island-bg-view 类(440px),切紧凑态编辑时
  折叠为 island-bg-view--compact(288px),宿主经 onPanelViewChange → IPC
  widget:set-height 调整窗口高度(480 ↔ 280),离开视图回落。

### 26.2 字体颜色算法

- auto = 合成亮度:背景图以 opacity 叠加在岛体深底 rgb(8,10,14) 上,
  可读性取决于合成后亮度(像素 × opacity + 深底 × (1-opacity));取**当前
  形态**背景图(展开态用展开图、紧凑态用紧凑图,缺图退另一形态),32×32
  采样平均 >140 判亮 → 黑字 #0b0b0f,否则白字;
- custom = 独立颜色页(font-color 视图):色板 + **岛内自绘取色器**
  IslandColorPicker(SV 面:横向饱和/纵向明度,色相条横向渐变,pointer
  capture 拖动取色,hsvToHex 实时提交;**不弹系统 <input type=color>
  对话框**,UI 不出岛);拖拽期间 pickingRef 屏蔽 prop 回读(避免 8bit
  量化往返换算导致光标抖动);
- SV 面明度黑渐变必须拆成独立 ::after 层(两层渐变叠在同一 background
  时黑渐变会在底边提前淡出,底部露出一条亮色带,像素实测);取色面/色相条
  不带边框(1px 边框 + inset:0 的 ::after 只覆盖到 padding box,边框内侧
  露出一圈底色渐变);
- 颜色页岛体 352px(挂件窗口 364);SV 面 flex:1 吃满剩余高度;字体视图
  本身固定 200px 紧凑高度。

### 26.3 上传与库管理

- 字体上传组件内查重(同一 dataUrl 不重复添加)后 onFontAdd;上传的字体
  注入 @font-face(组件内动态 style 标签 island-font-face,字体族
  island-font-custom,岛体 inline font-family 覆盖、fallback 取运行时
  body 字体栈;按钮/输入 font-family: inherit 跟随);
- 背景上传/选择经宿主 handleBackgroundChange **自动入库**(命名"背景图 N");
- 库页面大面板(island-lib-view,岛体 440px,宿主窗口同步 480,与背景
  编辑器共用 TALL 高度机制);搜索框按名称过滤、行内编辑(Enter 提交/Esc
  取消/失焦提交)、删除(删当前应用字体则回退默认)。

### 26.4 歌词 API 视图

- 预设厂家 + 自定义 URL 模板({title}/{artist} 占位);
- 自动切换开关(widget-lyric-auto,默认开启):开启时按监听平台自动换
  对应厂商(PLATFORM_LYRIC_MAP:qqmusic→QQ / netease→网易云 / kugou→酷狗
  / kuwo→酷我);关闭后一直按手动选择生效;
- 切换即刷新(查询 key 含 provider + effect 依赖 platformId);
- 播放键下方提示显示对应厂商名(ControlView)。

---

## 第 27 章 代码规范与注释约定

1. **全中文注释**(用户要求):模块头注释写清「功能 + 关键实现 + 踩坑/
   修复日期」,踩坑实录带 (实测) 标注与日期;
2. **时序常量集中**:组件内动画时序集中在文件顶部,改动画同步时 CSS
   transition 与 JS setTimeout 要一致;
3. **单一事实来源**:持久化键/常量/读取函数收敛在共享模块
   (settingsBridge / constants.ts / backgroundStore / videoPrefs),
   两端反向导入,禁止本地硬编码重复;
4. **IPC 三处同步**:preload + desktop.d.ts + main.cjs safeHandle;
   新增操作(如设置工具)settingsTools op 类型 + 桥方法 + 白名单三处同步;
5. **测试先行**:引擎行为改动补 test-agent-core.ts 用例(断言消息用中文,
   含失败原因);解析器改动补 test-markdown.mjs;
6. **fs 导入纪律**:promises as fs,existsSync/mkdirSync 从 node:fs 顶层
   导入;
7. **文档同步**:README(用户)/ WIDGET-README(部署)/ docs/TECH.md(技术)/
   CLAUDE.md(引擎与架构细节)——完成功能改动后同步,本模板见附录 D;
8. **明确不做项**记录在案(见 19.2),避免反复评估同一决策。
---

## 第 28 章 SMTC 数据流详解

```
Windows 媒体会话(QQ音乐/网易云/浏览器…)
  │
  ▼
smtc-reader.ps1(轮询 WinRT SystemMediaTransportControls)
  │  csc.exe 编译 smtc-bridge.cs(Windows 11 26100 新版 API,
  │  System32\WinMetadata;PS 5.1 无法绑定 WinRT 集合元素,
  │  必须走 C# 强类型桥接)
  ▼
bridge.cjs(utilityProcess 启动;崩溃自动重启 10s 内 3 次上限;
  内部 smtc-reader 子进程同款上限含 spawn error——脚本缺失时
  spawn 只发 error 不发 exit,不处理会桥活着但 SMTC 永久死)
  │  IPC(主进程)
  ▼
main.cjs → widget:media-state 事件
  │
  ▼
WidgetApp useSystemMedia(轮询校准 + 位置平滑重锚定,见 3.3)
  │
  ▼
DynamicIsland(进度条/歌词/控制)
```

- 控制反向:useSystemMedia.control() → IPC → bridge.cjs → smtc-bridge.cs
  控制方法(play/pause/next/previous/seek/cycleMode);
- 播放模式以系统真实状态为数据源(轮询校准),点击循环后 1.2s 检测是否
  跟随,没跟随则提示并回退;
- `pnpm bridge` 独立运行桥接脚本(单独调试 SMTC)。

---

## 第 29 章 开发任务指南(How-To)

### 29.1 如何新增一个内置工具

1. `electron/agent/tools.ts` 的 createTools 返回数组里加
   `{name, description, parameters, execute}`(中文描述,含"适合/注意",
   LLM 据此生成参数;需要超时覆盖加 timeoutMs);
2. 需要主进程能力 → EngineDeps 加字段,main.cjs 注入;
3. 需要持久状态 → settings.json agent 段(applyAgentConfigPatch 加字段
   校验)或 localStorage/IndexedDB(设置桥);
4. 补测试(scripts/test-agent-core.ts:注册/参数校验/执行路径/错误路径);
5. 文档同步(本文档 5.4 工具表 + 第 11 章引导小节)。

### 29.2 如何新增一个灵动岛设置工具操作

1. `electron/agent/settingsTools.ts`:IslandSettingsOp 联合类型加 op +
   工具对象(name/description/parameters/execute,桥返回值带 previous
   原值、已是目标值提示「无需修改」);
2. `src/settingsBridge.ts`:IslandSettingsBridge 接口加方法 + 实现(写存储
   后 notify(['scope']));
3. `electron/main.cjs`:ISLAND_SETTINGS_OPS 白名单加 op(**三处同步,
   漏白名单 = 安全侧失败,LLM 报「未知的操作」**);
4. 渲染端监听 scope 重读状态(WidgetApp onSettingsChange);
5. 补测试 + 文档。

### 29.3 如何新增一个面板视图

1. `DynamicIsland.tsx`:PanelView 联合类型加值;panelView === 'xx' 分支
   渲染组件;是设置类视图 → SETTINGS_VIEWS 常量(屏蔽一切缩回操作);
2. 大面板高度:组件根类 + CSS height + VIEW_WINDOW_H 登记宿主窗口高度
   (漏登记 = 窗口停在 280,岛体底部被裁切,实测 bug);
3. 返回语义:mediaLibraryBackRef 模式(从哪来回哪去);
4. 入口:托盘 IPC / Agent ⋯ 菜单 / 设置视图入口(按需求);
5. 巡检:agent 巡检或独立模式补断言。

### 29.4 如何新增一个 IPC 通道

1. `electron/preload.cjs`:contextBridge 暴露(desktop 对象);
2. `widget/desktop.d.ts`:类型同步(事实来源);
3. `electron/main.cjs`:ipcMain.handle(safeHandle 包装,{error} 返回);
4. 渲染端调用 window.desktop?.xxx(挂件版)或 Web 版回退;
5. 测试/文档。

### 29.5 如何新增一个面板视图的窗口高度

VIEW_WINDOW_H 是 `Partial<Record<PanelView, number>>`(拼错键编译器兜底),
WidgetApp handlePanelViewChange 按视图查表调 set-height;大面板(440/540/
580)登记后窗口跟随,离开视图回落 280。

---

## 附录 E:IPC 详细参数

| 通道 | 参数 | 返回 |
| --- | --- | --- |
| widget:pointer | {over: boolean} | - |
| widget:drag-start/move/end | {x, y}(move 节流 rAF)| - |
| widget:set-size | {width, height, immediate?} | - |
| widget:set-mode | {mode, source} | - |
| widget:fullscreen | {fs, isMini} | - |
| widget:open-settings | - | - |
| widget:open-media-library | - | - |
| agent:send | {text, history} | - |
| agent:abort | - | - |
| agent:event | 事件对象(见附录 A) | - |
| agent:config-get / agent:config-set | - / {patch} | AgentConfig |
| agent:tools | - | AgentToolInfo[] |
| agent:mcp-test | {name, config} | {ok, tools?} / {error} |
| agent:memory-get / set | - / {op, payload} | MemoryEntry[] |
| agent:memory-export / import | - / {path} | {imported, skipped} |
| agent:evolve | {rounds} | - |
| agent:evolution-log / rollback / reset | - | {entries} / {ok,error} |
| agent:summarize | {messages} | {title} |
| agent:mind-guess | {messages} | {guess} |
| agent:proactive-tick | {messages, idleMinutes} | {should, hint?} |
| agent:skill-import | - | {imported, skipped} |
| app:open-external | {url} | - |
| app:open-media-external | {kind, src} | - |
| app:pick-media-files | {exts, maxBytes} | {paths} |
| app:island-pick-files | {accept, multiple} | {paths} |

---

## 附录 F:播放列表与上传流程

```
用户上传音乐(Web:File input;挂件:系统对话框 app:island-pick-files)
  → uploadStore 存 IndexedDB(island-uploads,持久化)
  → useMediaPlayer.addTracks
      ├─ 播放列表追加 + 自动播放
      └─ 音频库同步:无同名(按文件名)自动补录(参考图片库导入机制)

多媒体库音频 → 「导入播放列表」(单个/批量,勾选)
  → handleAddLibraryTracks
      ├─ addLibraryTracks(存 island-uploads,自动播放首曲)
      └─ setMode('music')  → 模式切换动画自动收起岛体
```

## 附录 G:主动陪伴全链路时序

```
用户无操作 ≥ N 分钟
  → useAgent 调度器(60s 周期检查,agent 模式/配置开/idle/有历史/in-flight
    守卫)
  → agent:proactive-tick(messages, idleMinutes)
  → main.cjs → judgeProactive(Sub Agent,同源上下文:提示词+记忆+进化+
    后台任务+当前时间;JSON {should, hint};失败 → should:false)
  → should:true → engine.proactiveTurn(history, {hint})
      → PROACTIVE_INSTRUCTION 追加 input 末尾(system 请求项,不进历史)
      → 完整回合(思考/流式/工具/子代理)
      → message 事件落定(proactive: true)
  → 主进程 getMindAgent().guess([消息]) → Notification('岛灵 · 心理揣测')
    + mind-proactive 事件 → 紧凑态文字区
  → 渲染端重置 idle 时钟(proactive 末条跳过 mindRunner,标题照常)
```

---

## 第 30 章 结语

本文档与 CLAUDE.md 分工:CLAUDE.md 是给 Claude Code 的"引擎级操作手册"
(每处实现的踩坑实录、修复日期、测试断言),本文档是"工程级技术说明"
(架构、数据流、How-To、速查表)。两者都以 docs/TECH.md 为 LLM 功能引导
知识库(get_feature_guide 工具读取)。

维护约定:每次功能改动按附录 D 清单同步本文档对应章节;第 11 章功能清单
保持用户话术最新(它是 LLM 引导用户的一手资料)。
---

## 第 31 章 深入:布局计算(layout.ts)

### 31.1 宽度计算

- 紧凑态宽度 = 文字区内容宽 + 固定部件(图标/边距),随文字字数扩展;
- 悬停扩展:音乐模式紧凑态悬停时 + HOVER_EXTEND_PX(进度条空间),
  clamp 到 MAX_WIDTH_PX;
- Agent 模式紧凑态无进度条 → 悬停不扩展(agentActiveRef 排除);
- clampExpandedWidth():展开宽上限(300% 缩放时 1200px < 显示器宽),
  与 seq effect 合并(2026-08-07 渲染端收敛);
- conflictsWithBar(conflicts 公式内联 ×4 收敛):判断文字区/图标与进度条
  是否冲突,决定显示优先级。

### 31.2 高度计算

- 音乐模式展开 244px(挂件版覆盖);
- Agent 面板:--agent-h 变量(AgentView scrollHeight 测量,clamp [200,
  600],80ms 节拍,流式瞬跳 + 落定过渡,见 6.2);
- 大面板视图(settings/background/库/agent-settings/lyric-api):
  VIEW_WINDOW_H 表驱动窗口高度(见 29.5)。

### 31.3 布局 effect 校准

- 悬停态滞留校准:每次重算宽度前 island.matches(':hover') 校准(见 3.6);
- 高度动画并行:宽度/高度同曲线同时程 0.3s(见 6.2)。

---

## 第 32 章 深入:消息组件群(AgentMessages.tsx)

| 组件 | 说明 |
| --- | --- |
| UserBubble | 用户消息右气泡(强调色底,plainMermaid 按普通代码块显示) |
| AssistantBlock | 助手消息左气泡(半透明白底)+ 流式文本 + 脚注(usage/耗时) |
| ToolCard | 单个工具调用卡片(名称/参数 JSON 展开/状态 ✓ ✕/耗时) |
| ToolSummary | 工具调用汇总行(收纳列表,默认折叠,见 6.2) |
| MediaFrame | 媒体附件(图片/视频/音频气泡,见 6.4) |
| VoiceBubble | 音频语音气泡(胶囊 + 声波动画) |
| AgentImage | data URL/远程图片(按 --agent-s 缩放 × 1/4 展示) |
| VideoPlayer | 定制视频播放器(见 6.4/16.2) |

- 已落定块 React.memo;工具结果一次遍历建 Map 配对(去 O(parts²));
- 助手消息脚注显示"输入/输出/缓存命中"小字(缓存命中率可观测);
- 流式文本增量重解析 Markdown(流式友好退化,见 6.3)。

---

## 第 33 章 深入:AgentMediaMini 时序

```
收起面板(doCollapse, mediaMini: true)
  ├─ agentPlaying(MediaFrame 节流上报)→ 快照 {kind, src, position, playing}
  ├─ 岛体变形成媒体小窗(wrap transform 动画)
  └─ AgentMediaMini 挂载:
      ├─ 应用共享偏好(volume/muted/speed/loop)
      ├─ seek 到快照 position(元数据就绪后;loadedmetadata 一次监听)
      ├─ playing → play()(被策略拦截 → 回退播放键)
      ├─ timeupdate → dispatchAgentMedia('play', {position})(节流 1Hz,
      │    更新 agentMediaPositions + agentPlaying)
      └─ 全屏:容器级 requestFullscreen(控件随容器);
          退出 → leaving-fullscreen 缩回动画 0.34s
展开回面板:
  ├─ MediaFrame 挂载读取 agentMediaPositions(同 src)→ seek 续播
  └─ 播放状态/音量/倍速/循环经 videoPrefs + agentMediaPositions 同步
```

---

## 第 34 章 深入:useAgent 状态机

```
状态:status = idle | thinking | running | error
├─ send(text):合并未答复 user 消息(防污染)→ agent:send → status
│    running(流式事件累积未落定消息)
├─ 增量事件(text/reasoning/tool)rAF 合批直写镜像 → 帧内一次提交
├─ message 事件:权威落定(替换流式累积)→ 触发总结(后台)→ status idle
├─ abort:丢弃流式消息 + status idle(迟到事件丢弃防幽灵文本)
├─ 手动调用(/ 与 @):候选列表浮出(输入框上方,↑↓/Enter/Esc)
├─ 历史:widget-agent-messages 同步写不防抖;会话版本号 sessionVersionRef
│    (仅 clear/loadSession 递增)
└─ 主动陪伴调度(60s 周期,见附录 G)
```

---

## 第 35 章 常见定制任务问答

### 35.1 "我想让岛变好看"

三个方向(设置视图 / LLM 工具都行):主题色(强调色,按钮/气泡/进度条)、
背景(双形态独立图片 + 不透明度 + 裁切)、字体(导入 ttf/otf/woff/woff2
+ 文字颜色自动/自定义)。对话里直接说即可即时生效
(set_theme_color / import_background / import_font / set_font_color)。

### 35.2 "我想让 LLM 更懂挂件功能"

对话里问"你有什么功能"——LLM 会调 get_feature_guide 读取本文档第 11 章
按话题介绍(见 5.4.4 工具设计与 11.18 引导话术)。

### 35.3 "我想加一个 MCP 服务"

两种方式:① Agent 设置 → MCP 服务(名称/传输类型/命令或 URL/参数/环境
变量,逐条测试);② 对话里说"添加一个 MCP 服务,命令是 npx …"(mcp_config
工具,下一轮对话起生效)。

### 35.4 "我想让岛灵记得我的偏好"

对话里说"记住:我晚上不用电脑"——remember 工具写入长期记忆(偏好/事实/
工作流/教训),设置视图可管理(增删改查/导入导出);记忆参与每轮系统提示。

### 35.5 "主动陪伴会打扰我吗"

主动陪伴默认开启(间隔 15 分钟),判断偏保守(should:false 安全侧);可以
对话里说"把主动陪伴关掉"或"间隔改成 30 分钟";开启确认门
(Agent 设置 → exec_command 确认)后危险命令也会先询问。

---

## 附录 H:CLAUDE.md 章节索引

| 章节 | 内容 | 对应本文档 |
| --- | --- | --- |
| 项目概述/常用命令/验证约定 | 命令与约定 | 第 2 章 |
| 架构(双入口/数据源双轨/主进程/桥接/架构优化) | 架构总览与优化史 | 第 1/3/4/13 章 |
| Agent 模式(引擎/工具/任务/MCP/技能/记忆/进化/审计) | 引擎全部细节 | 第 5 章 |
| 渲染端(useAgent/AgentView/动画/媒体/Markdown) | 渲染端细节 | 第 6 章 |
| 消息气泡 Markdown 渲染 | 解析器细节 | 6.3 |
| 关键约束(提示文本/透明窗口/歌词折叠/竞态/悬停校准) | 踩坑 | 第 10 章 |
| 双岛并存模式(设计文档) | 未实现设计 | 19.1 |
---

## 第 36 章 三 Provider 历史序列化对照

同一段历史(含 reasoning + tool-call/tool-result),三个 provider 的输出
形状不同——序列化器必须严格按各自格式,否则 400/角色错乱/缓存断前缀。

### 36.1 Responses(默认)

```json
{"input": [
  {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "…"}]},
  {"type": "reasoning", "summary": [{"type": "summary_text", "text": "思维链明文"}]},
  {"type": "message", "role": "assistant", "content": [
    {"type": "output_text", "text": "我先查一下"},
    {"type": "function_call", "call_id": "c-1", "name": "web_search", "arguments": "{}"}
  ]},
  {"type": "function_call_output", "call_id": "c-1", "output": "搜索结果"}
]}
```

规则:reasoning 必须回传(缺失 400);function_call_output 的 call_id 必须
与 function_call 对应;相邻 assistant 消息归并。

### 36.2 Chat Completions

```json
{"messages": [
  {"role": "user", "content": "…"},
  {"role": "assistant", "reasoning_content": "思维链", "content": "我先查一下",
   "tool_calls": [{"id": "c-1", "type": "function", "function": {"name": "web_search", "arguments": "{}"}}]},
  {"role": "tool", "tool_call_id": "c-1", "content": "搜索结果"}
]}
```

规则:reasoning 走 reasoning_content 字段;工具结果打包进 role:"tool"
消息;角色严格交替(相邻同角色合并)。

### 36.3 Anthropic Messages

```json
{"messages": [
  {"role": "user", "content": [{"type": "text", "text": "…"}]},
  {"role": "assistant", "content": [
    {"type": "text", "text": "我先查一下"},
    {"type": "tool_use", "id": "c-1", "name": "web_search", "input": {}}
  ]},
  {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "c-1", "content": "搜索结果"}]}
]}
```

规则:工具结果打包进**下一条 user 消息**的 tool_result 块(tool-call/
result 成对,序列化时重排);同一条助手消息里 tool_use 之后不能再有文本;
thinking 块需 signature 不可回放,已丢弃(reasoning parts 回放时丢弃);
max_tokens 必填 4096。

### 36.4 序列化稳定性要求

- instructions 与历史序列化幂等(同一历史每次输出字节一致);
- tools 顺序固定(内置工具数组顺序、MCP/技能按字母序);
- reasoning item / reasoning_content 固定回传;
- 任何序列化抖动都会断 DeepSeek 前缀缓存(命中价差 50 倍)。

---

## 第 37 章 灵动岛设置工具端到端示例(真实对话)

### 37.1 "把岛调成紫色"

```
用户:把岛调成紫色
LLM:get_island_settings → 主题色:null(未设置,默认)
     → set_theme_color {color: '#a855f7'}
     → 回复:已把主题色从默认调整为 #a855f7,岛上的按钮/进度条
       都变成紫色了
```

### 37.2 "导入 D:\music\1.mp3 到音频库"

```
用户:导入 D:\music\1.mp3 到音频库
LLM:import_audio_library {path: 'D:\\music\\1.mp3'}
     → 桥解码 ArrayBuffer 入库 + notify mediaLibrary
     → WidgetApp 重读音频库 → 回复:已导入「1.mp3」到音频库
        (大小 xx MB),要加入播放列表吗?
用户:加入吧
LLM:list_audio_library → import? 不——播放列表在渲染端,LLM 无此工具;
     回复:播放列表需要你在多媒体库里点「导入播放列表」(或我帮你
     用 set_mode? 无此工具)——实际:渲染端操作,LLM 引导即可
```

### 37.3 "播放视频库里的视频"

```
用户:播放视频库里的 XX 视频
LLM:list_video_library → 找到 id
     → play_library_video {id} → 桥校验存在 → island:media-library-play
     → WidgetApp 展开多媒体库 + autoPlayVideoId → 视频 tab 自动播放
     → 回复:已打开多媒体库并开始播放「XX」
```

### 37.4 "界面字太小"

```
用户:界面字太小
LLM:get_island_settings → 缩放 100%
     → set_agent_scale {percent: 200} → 回复:已把界面放大到 200%
       (只放大面板/窗口,文字本身不缩放——如仍觉得小可再调大)
```

---

## 附录 I:全部工具一览

### 内置(engine.ts 注册)

| 工具 | 参数 | 说明 |
| --- | --- | --- |
| exec_command | command / cwd / timeout | 本机命令(媒体拦截) |
| read_file | path / maxChars | 读文件 |
| write_file | path / content | 写文件 |
| list_dir | path | 列目录 |
| open_url | url | 打开链接 |
| open_file | path | 打开文件(媒体拦截) |
| web_search | query | Bing 搜索 |
| get_time | - | 当前时间 |
| system_info | - | 系统信息 |
| notify | title / body | 系统通知 |
| switch_to_music | - | 切回音乐模式 |
| bili | action + 参数 | B站查询/下载/登录 |
| doc_convert | path | 文档转 Markdown |
| xxt | subcommand + 参数 | 超星答题 |
| get_feature_guide | topic? | 读取功能引导文档 |
| delegate | task / system? / tools? | 子代理 |
| set_output_budget | action / maxOutputTokens? / persist? | 输出预算 |

### 自我配置(configTools.ts)

| 工具 | 说明 |
| --- | --- |
| mcp_config | list/add/remove/test MCP 服务 |
| skills_config | list/add/remove 技能目录;create 技能;exclude/include |
| set_proactive_config | 主动陪伴 enabled/interval/unit |
| set_sub_agent_config | summaryStyle / mindPersona |

### 记忆(memory.ts 经 engine 注册)

remember / forget / list_memory / update_memory / evolve_memory

### 灵动岛设置(settingsTools.ts,21 个)

见 7.2 工具清单表。

---

## 附录 J:全部面板视图一览

| PanelView | 岛体高 | 窗口高 | 返回语义 |
| --- | --- | --- | --- |
| control | 244 | 280 | 收起 |
| agent | 内容驱动(200-600) | 岛体+40 | ⋯ 菜单收起 |
| settings | 440 | 480 | 收起(设置类) |
| background | 440(compact 288) | 480(280) | 返回设置/多媒体库 |
| theme | 352 | 364 | 返回设置(设置类) |
| font | 200 | - | 返回设置(设置类) |
| font-color | 352 | 364 | 返回字体(设置类) |
| font-library / image-library | 440 | 480 | 返回对应视图(设置类) |
| lyric-api | 440 | 480 | 返回设置(设置类) |
| agent-settings | 540 | 580 | 返回对话(设置类) |
| media-library | 540 | 580 | 从哪来回哪去(托盘收起/菜单回对话) |
| history / tools | 保持进入前 | 保持 | 返回对话 |
---

## 第 38 章 版本历史与演进时间线

| 时间 | 里程碑 |
| --- | --- |
| 2026-08 前期 | 灵动岛雏形:透明窗口 + SMTC 监听 + 音乐控制 + 歌词 |
| 2026-08-05 | Agent 模式:引擎(Responses/Anthropic 双 provider)、工具系统、记忆、进化 harness、MCP、技能、手动调用(/ 与 @)、核心测试 71 用例 |
| 2026-08-06 | 架构优化(三代理审计):electron TS 纳入编译、settings.json 加固、dev 链路修复、双宿主共享 hook、设置桥 typed 事件、确认门、Agent 消息组件群搬移、设置工具首版 |
| 2026-08-07 | 四路审计六轮优化:engine 拆分/subagents/configTools、provider 公共层、useWheelSwap/useLeavingList/useAgentPanelLayout、死通道清理、类型镜像;主动陪伴(判断/回合/通知/调度/设置)、心理揣测、B站扫码登录、技能分区/导入、MCP 分组、记忆导入导出、进化日志/回滚/重置、设置视图四组菜单 + QuickMenu 七轮优化 |
| 2026-08-08 | 工具参数校验(LLM 自纠)、输出预算动态调整、多媒体库(图片/音频/视频)、island-media 流式协议、对话媒体窗口、Markdown 渲染器、媒体拦截(open_file/exec_command start)、消息气泡 mermaid/表格、播放列表 ↔ 音频库同步、HEVC 硬解、智能截图修复 |
| 2026-08-09 | 媒体小窗(视频岛/图片岛)、全屏(工作区扩展/退出缩回)、进度双向同步、封面抓帧、chat-media 巡检 |
| 2026-08-10 | 定制视频控件(VideoExtras 音量/更多,三处同步)、帮助手册移除、收起语义拆分(灵动岛/多媒体岛)、**主动陪伴工具积极性(拟人)**、**设置工具白名单修复 + play_library_video 跳转播放**、**本文档(技术文档 3000 行)+ get_feature_guide 引导工具 + README 重写** |

---

## 第 39 章 新开发者 30 分钟上手

### 第 1 步:跑起来(5 分钟)

```bash
pnpm install
pnpm dev:widget      # 构建 + 启动挂件(默认完成标准)
```

看托盘:模式切换(音乐 ↔ Agent)、设置…、多媒体库…、置顶、退出。

### 第 2 步:读代码地图(10 分钟)

1. `widget/WidgetApp.tsx` —— 宿主接线(数据/状态/事件全在这);
2. `src/components/DynamicIsland/DynamicIsland.tsx` —— 岛体(布局/手势/
   视图分发);
3. `electron/main.cjs` —— 主进程(窗口/托盘/IPC/桥接调度);
4. `electron/agent/engine.ts` —— Agent 引擎循环;
5. `src/hooks/useAgent.ts` —— 渲染端事件流状态机。

### 第 3 步:跑通测试(5 分钟)

```bash
pnpm build            # tsc -b 双端类型
pnpm lint
node scripts/test-agent-core.mjs   # 83 用例
pnpm test:markdown    # 39 断言
```

### 第 4 步:小改动手(10 分钟)

- 加一个设置项:按 29.2 的 How-To(三处同步:工具 op + 桥方法 + 白名单);
- 加一个面板视图:按 29.3(视图分发 + VIEW_WINDOW_H + 返回语义);
- 加一个内置工具:按 29.1(注册表 + 描述 + 测试)。

### 常驻纪律

- 全中文注释;改引擎补测试;改渲染端跑 dev:widget 实机验证;文档三件套
  (README/WIDGET-README/TECH.md)+ CLAUDE.md 同步(附录 D 清单)。

---

## 尾声

本文档至此约 3000 行,覆盖:架构总览、构建运行、音乐模式、主进程、
Agent 引擎(循环/provider/工具/任务/总结/揣测/主动陪伴/记忆/进化/MCP/
技能/预算)、渲染端(状态机/面板/媒体/多媒体库/设置/动画/性能)、设置
工具、类型系统、架构优化史、配置一览、测试体系、调试速查、FAQ、
How-To 指南与功能引导知识库(第 11 章,get_feature_guide 工具读取)。

文档遵循"一次维护,多处受益":CLAUDE.md(引擎操作手册)+ 本文档(工程级
技术说明)+ README(用户向)+ WIDGET-README(部署/调试)——任何功能改动
请按附录 D 清单同步。
