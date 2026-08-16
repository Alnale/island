# 巨型文件拆分设计(SPLIT-DESIGN)

> 2026-08-16 起草。背景:2026-08-16 代码评审指出 7 个巨型文件(见下表),
> 本设计给出**行为中性**的拆分方案——纯搬移 + re-export,不改变任何运行逻辑;
> 每阶段独立提交、独立验证。实施后按项目约定同步 CLAUDE.md / TECH.md 结构段。

## 0. 现状与目标

| 文件 | 行数 | 拆分后目标 | 性质 |
| --- | --- | --- | --- |
| `electron/main.cjs` | 4140 | ≤200(引导)+ 13 个模块 | CJS 主进程,纯搬移 |
| `tests/screenshot-tests.cjs` | 5416 | ≤300(分发)+ 按模式分文件 | CJS 巡检,纯搬移 |
| `tests/test-agent-core.ts` | 4926 | ≤80(入口)+ 套件分文件 | TS 测试,纯搬移 |
| `src/components/DynamicIsland/DynamicIsland.tsx` | 2127 | ≤900(状态与手势)+ parts/ | TSX,渲染拆解 |
| `src/components/DynamicIsland/views/Markdown.tsx` | 2092 | ≤350 + media/ + markdown/ | TSX,渲染拆解 |
| `src/components/DynamicIsland/views/AgentSettingsView.tsx` | 1961 | ≤500(外壳)+ settings/ 按 tab | TSX,渲染拆解 |
| `src/components/DynamicIsland/views/AgentView.tsx` | 1719 | ≤600 + agent/ 子模块 | TSX,渲染拆解 |

**明确不做**(维持 CLAUDE.md「有意未做」结论):
- 手势/展开状态机抽 hook——历史 bug 密集且无单元测试,收益与风险不成比例;
- `electron/agent.cjs` / `bridge.cjs`——esbuild 产物,拆分在源码域做,产物不动;
- CSS 单文件拆分——行为中性但收益低,抽组件时顺手搬;
- `preload.cjs`(15KB)/ `settings-store.cjs`(4KB)/ 其余小文件——不达阈值。

## 1. 总体原则

1. **行为中性优先**:每一步 = 原文搬移 + 模块导出 + 原处 re-export/require,
   逻辑零改动(允许把内联 IPC 回调体原样提为具名函数,便于跨文件挂载)。
2. **依赖单向、无环**:域模块只依赖"下层"模块;跨域握手一律经**启动期注入**
   (见 §2.6),禁止 require 成环。
3. **公共 API 面不变**:外部 import 路径与导出名不动(views/index.ts、
   DynamicIsland/index.ts、main.cjs 的注入签名、agent.cjs 接口)。
4. **模块级状态归属**:可变模块状态(win、settings 缓存、engine 实例、
   sessionEngines Map、route、bridgeProc、quitting……)归各自域模块所有,
   跨模块访问全部走函数(现状已是函数式访问,签名不变)。
5. **每阶段验证门**:`pnpm build`(tsc -b)、`pnpm lint`、全部单测
   (`node tests/test-agent-core.mjs` + `node tests/test-markdown.mjs`)、
   `pnpm dev:widget` 启动冒烟 + 1-2 个截图模式(如 `expanded` / `agent`)。
6. **提交粒度**:每阶段一个 commit,message 按项目风格
   (`refactor: <标题>(<日期>)`),先记录基线(测试数、lint 清零)。

---

## 2. `electron/main.cjs`(4140 行)→ `electron/main/`

### 2.1 目标结构(依赖方向:叶 → 根)

```
electron/main/
  shared.cjs            # 叶:win 引用、sendToWidget、quitting、iconImage、asArray
  settings.cjs          # 叶:settings.json 读写(原子写/防抖/bak)、resetSettingsCache、
                        #     currentMode / setWidgetMode
  config.cjs            # 叶:MASTER_QQ、AGENT_CONFIG_DEFAULTS、MIMO_DEFAULTS、
                        #     DEFAULT_SKILLS_DIRS、currentAgentConfig、applyAgentConfigPatch
  notify.cjs            # 叶:通知队列(排程/合并/丢弃),balloon 经 setBalloonSink 注入
  memory.cjs            # 叶:startMemoryMonitor
  undo.cjs              # 叶:撤销快照注册表(load/persist/release)
  window.cjs            # shared/config:createWindow/showWindow/toggleWindow/窗口常量
  window-geometry.cjs   # shared:尺寸合帧/位置补偿/拖拽/穿透轮询/全屏/set-size 等
  bridge.cjs            # shared/settings:startBridge/守护/音乐控制
  sessions.cjs          # shared:会话键体系、session ops、会话记录
  agent-runtime.cjs     # config/settings/sessions/shared/notify:引擎实例、会话引擎 Map、
                        #     buildEngineDeps、confirm 门、sub agents、主动陪伴调度
  napcat/               # sessions/config/notify/shared/agent-runtime:
    route.cjs           #     newRoute/routeFor/getNapcatClient/PENDING_QQ
    fingerprint.cjs     #     turnFingerprint* 系列 + logFpGate
    messages.cjs        #     handleEngineMessageForNapcat/handleNapcatSendError
    lifecycle.cjs       #     composeProfileCard/syncNapcatLifecycle/startNapcatMaintenance
                        #     /resolveGroupName/broadcastSessionSeed
  island-settings.cjs   # shared:ISLAND_SETTINGS_OPS/runIslandSettings
  skills.cjs            # config/shared:技能扫描/导入/删除
  media-protocol.cjs    # shared:island-media:// 协议
  tray.cjs              # shared/config/settings/notify:createTray/rebuildTrayMenu
  ipc.cjs               # 装配层:safeHandle + 全部 35 处 ipcMain 注册(实现取自各域)
  app.cjs               # 根:单实例锁、ready 编排、before-quit、window-all-closed
```

`main.cjs` 收口为 ≈150 行引导:require 各域 + `app.cjs` 启动。

### 2.2 行数分布(按现文件行号切片)

| 切片 | 现行号 | 去向 |
| --- | --- | --- |
| 通知队列 | 59-137 | notify.cjs |
| QQ 名片 | 137-244 | napcat/lifecycle.cjs |
| 内存监控 | 244-269 | memory.cjs |
| 窗口常量 | 269-300 | window.cjs |
| settings 持久化 + mode | 300-350 | settings.cjs |
| 配置默认值/currentAgentConfig/applyAgentConfigPatch | 350-812 | config.cjs |
| memory store/evolution 取用 | 532-562 | agent-runtime.cjs |
| 用户确认/群名/会话种子 | 812-947 | agent-runtime / napcat |
| 引擎 deps 构建 | 947-1086 | agent-runtime.cjs |
| 会话 ops | 995-1090 | sessions.cjs |
| 音乐控制 | 1086-1123 | bridge.cjs |
| QQ 路由 + 指纹 + 消息处理 + 生命周期 | 1123-2287 | napcat/(四个文件) |
| 灵动岛设置 op | 2287-2339 | island-settings.cjs |
| sub agents | 2339-2446 | agent-runtime.cjs |
| 桥路径/启动 | 2446-2516 | bridge.cjs |
| 窗口创建/显示/切换 | 2516-2784 | window.cjs |
| 尺寸合帧/拖拽/穿透/全屏 | 2784-3285 | window-geometry.cjs |
| 撤销注册表 | 3285-3402 | undo.cjs |
| 主动陪伴调度 | 3402-3590 | agent-runtime.cjs |
| safeHandle + IPC 注册 | 3590-3653 | ipc.cjs |
| 媒体协议 | 3653-3794 | media-protocol.cjs |
| 技能 | 3794-3980 | skills.cjs |
| 托盘 + ready 生命周期 | 3980-4140 | tray.cjs / app.cjs |

### 2.3 关键设计点

1. **内联 IPC 回调体提为具名函数**:现有 35 处 `ipcMain.on/handle` 里不少是
   内联实现(如 `widget:drag-start/move`、`agent:send`)。拆分时把函数体原样
   提到所属域模块导出(如 `window-geometry.cjs` 导出 `handleDragStart(sx, sy)`),
   ipc.cjs 只做注册。函数体逐字搬移,零逻辑改动。
2. **模块级状态归属**(防止拆完出现"到处 require 状态"):
   - `win` / `quitting` / `sendToWidget` → shared.cjs(所有域经它向渲染端发事件);
   - `settingsCache` → settings.cjs;`agentEngine`/`sessionEngines`/`route`/
     `napcatClientState`/`bridgeProc` → 各自域模块。
3. **启动期注入解环**(本项目最容易踩的坑,明确如下):
   - `getNapcatClient()`(napcat)被 `buildEngineDeps`(agent-runtime)使用 →
     agent-runtime 导出 `setNapcatClientProvider(fn)`,app.cjs 启动时注册;
   - `tray.displayBalloon`(tray)被通知队列(notify)使用 → notify 导出
     `setBalloonSink(fn)`,tray.cjs 注册;
   - 引擎事件回渲染端统一走 shared.sendToWidget,不注入。
4. **agent.cjs 的 require 前置校验**(现 39-42 行)留在 main.cjs 引导里。

### 2.4 风险

- 循环 require 是最大风险,§2.3-3 的注入点必须在动工前逐一标注;
- `handleEngineMessageForNapcat`(~440 行)内部状态多(防重发快照/确认槽),
  整块搬移,不在搬移时"顺手优化";
- 拆分后 `agent:send` 等回调里的闭包变量(原 main.cjs 模块作用域变量)
  必须随函数体一起搬入目标模块,靠 tsc/lint 与 dev:widget 冒烟兜住。

---

## 3. `tests/screenshot-tests.cjs`(5416 行)→ `tests/screenshot/`

### 3.1 目标结构

```
tests/screenshot/
  helpers.cjs        # 注入 deps 上下文 ctx、waitFor/assert/sleep、真实鼠标
                     # (sendInputEvent)、终端进程监控(termWatch)、evalInPage、
                     # 备份恢复、common 断言库
  index.cjs          # runScreenshotTests({...deps}) = 起点计时 + termWatch +
                     # MODES 注册表分发(签名与现 main.cjs 注入调用完全一致)
  modes/
    expanded.cjs     # expanded + layout(67-284 段)
    theme.cjs        # theme(103-119)
    stress.cjs       # stress(119-169)
    test.cjs         # test(169-284)
    probe-tools-height.cjs   # 284-408
    probe-clear.cjs          # 408-591(场景 B-E)
    probe-evolve.cjs         # 591-673
    agent.cjs        # 673-2056(~1400 行,内部按「段」再分小节或子文件)
    media-lib.cjs    # 2056-2464
    chat-media.cjs   # 2464-3136
    hevc-frame.cjs   # 3136-3223
    skill-delete-check.cjs   # 3223-3251
    clear-data.cjs   # 3251-3647
    mini.cjs         # 3647-4145
    session-cleanup.cjs      # 4145-4178
    video-resume-check.cjs   # 4178-4382
    session-debug.cjs        # 4382-4835
    napcat-session.cjs       # 4835-5416(场景 A-J)
```

### 3.2 关键设计点

1. **模式注册表**:`MODES = { expanded: async (h) => {...}, ... }`,
   `index.cjs` 按 `process.env.WIDGET_SCREENSHOT_MODE` 分发;未知模式仍报错。
2. **共享上下文**:每个模式文件 `module.exports = async (h) => {}`,
   `h` = { win, app, fs, path, settingsPath, runIslandSettings, ...deps,
   ...helpers }——helpers.cjs 提供现 runScreenshotTests 内部定义的公共工具
   (真实鼠标注入、waitFor、断言、场景 B-E 的备份恢复等),从函数体内抽到
   模块层,签名不变。
3. **agent 模式(~1400 行)**:若单文件仍超阈值,按巡检「段」(段 1 截图 /
   段 2 交互 / 段 4.5 快捷菜单 / 段 4.7 设置工具 / 段 5 自动回复)拆为
   `agent/part1.cjs` … 或按内部大注释块分文件;不改变执行顺序与断言语义。
4. **时序语义不变**:did-finish-load → setTimeout 入口 → 模式分发,原样保留。

### 3.3 风险

- 模式间共享的局部 helper 抽到 helpers.cjs 时,注意它们闭包捕获的变量
  (termWatch 的 execFileSync 等)——以「逐字搬移」为准;
- 输出路径/日志格式(.png 命名、result.log 文本)不变,巡检脚本与
  WIDGET-SCREENSHOT 外部用法不受影响。

---

## 4. `tests/test-agent-core.ts`(4926 行)→ `tests/agent-core/`

### 4.1 目标结构(按现文件区块标题)

```
tests/agent-core/
  harness.ts         # test/assert/assertRejects/waitFor/readJson、临时目录、
                     # startSseMock/killProc、budgetSseServer/budgetEngine、
                     # sseResponse、scanLoneSurrogates、napcatTools、MOCK_PROVIDERS
  memory.ts          # 区块 1(记忆系统)
  mcp.ts             # 区块 2 stdio + 3 sse
  skills.ts          # 区块 4
  config-tools.ts    # 区块 5(createConfigTools)+ 区块 6(手动调用解析)
  evolution.ts       # 区块 7 及 7.4/7.5(压缩/JSON 解析/标题清洗/记忆提取/意图判定)
  engine-integration.ts    # 区块 8/8.3/8.4/8.5
  settings-tools.ts  # 区块 9(灵动岛设置工具)
  tasks.ts           # 通用后台任务注册表
  validate-args.ts   # 工具参数校验与自主纠错
  sse-accum.ts       # Responses SSE 工具参数累积
  surrogates.ts      # 孤立代理清洗
  tool-output-dir.ts # 工具输出目录
  napcat.ts          # 区块 10(NapCat QQ 机器人)
  undo.ts            # 撤销 git 快照
  plugin-kernel.ts   # 插件内核与能力接缝
test-agent-core.ts   # 收口:import 全部套件 + 收尾(≤80 行)
```

### 4.2 关键设计点

1. **runner 不动**:`test-agent-core.mjs` 仍 esbuild 打包 `tests/test-agent-core.ts`
   入口,入口 import 各套件后 bundle 天然工作;`electron` stub 别名不变。
2. **harness 收敛共享设施**:mock 服务器、budget 引擎、SSE 响应构造、
   napcat mock 全部进 harness.ts;套件之间**不互相 import**(除 harness)。
3. **共享全局状态显式 reset**:临时目录、mock 端口、`resetTasks()` 等由
   harness 提供;测试总数只增不减(先记录基线 137+)。

### 4.3 风险

- 区块 7 标题下有编号错乱的历史注释(7.4/7.5 重复),搬移时保留原注释文本,
  不顺手改编号;
- 套件拆分后若发现套件间隐藏依赖(某套件用到前面定义的 mock),把该 mock
  提升到 harness,不做"套件 A import 套件 B"。

---

## 5. `views/Markdown.tsx`(2092 行)→ `views/media/` + `views/markdown/`

### 5.1 目标结构

```
views/media/
  media-utils.ts     # resolveMediaSrc、MEDIA_MIN_W/MEDIA_MAX_W、openMediaExternally、
                     #     followMediaInView、fmtMediaTime、VIDEO_SPEEDS
  mediaEvents.ts     # AGENT_MEDIA_EVENT、AgentMediaReport、dispatchAgentMedia、
                     #     readAgentMediaPosition/Size、clearAgentVideoResume、
                     #     agentMediaPositions/Sizes(模块级 Map 归此)
  VideoPlayer.tsx    # VideoPlayer(668-1133,~465 行)
  VoiceBubble.tsx    # VoiceBubble(241-651,~410 行)
  MediaFrame.tsx     # MediaFrame + MediaError(1515-1765 + 147-240 段)
views/markdown/
  MarkdownBlocks.tsx # renderBlock/renderInlines/LinkNode/CodeBlock/alignStyle
                     #     (1765-2061)
  MermaidBlock.tsx   # loadMermaid/MermaidBlock/mermaidSvgCache/mermaidFailCache
                     #     (1860-1975)
views/Markdown.tsx   # 保留:CopyButton、AgentImage、Markdown、takeMdAutoPlay、
                     #     解析器 glue(~350 行)+ re-export 全部公共 API
```

### 5.2 关键设计点

1. **公共导出面不变**:现导出 `CopyButton / AgentImage / VideoExtras /
   MediaFrame / resolveMediaSrc / AGENT_MEDIA_EVENT / AgentMediaReport /
   readAgentMediaPosition / readAgentMediaSize / clearAgentVideoResume /
   dispatchAgentMedia / Markdown`,全部由 Markdown.tsx re-export,
   `views/index.ts` 与所有调用方(AgentMessages、MessageWindow、桥的
   getConversationMedia 依赖 DOM 而非 import)零改动。
2. **依赖方向**:Markdown.tsx → markdown/* → media/*;media 模块不反向引用。
3. `takeMdAutoPlay`(全局单次标志)留在 Markdown.tsx。

### 5.3 风险

- VoiceBubble/VideoPlayer 内部 ref 多、事件订阅密(音量/进度/循环),逐字搬移,
  不做任何"顺手的清理";
- mermaid 缓存 Map 是模块级,随 MermaidBlock.tsx 走。

---

## 6. `views/AgentSettingsView.tsx`(1961 行)→ `views/settings/`

### 6.1 目标结构

```
views/settings/
  constants.ts       # SETTINGS_TABS、BUDGET_PRESETS、REASONING_OPTIONS/LABELS、
                     #     PROACTIVE_PRESETS/UNITS、SCALE_PRESETS、
                     #     MEDIA_WINDOW_PRESETS、MEMORY_TYPES、
                     #     SUMMARY_STYLE_ITEMS、MIND_PERSONA_ITEMS、formatBudget、
                     #     summaryStyleLabel/mindPersonaLabel、EMPTY_DEEPSEEK/EMPTY_MIMO
  mcp-form.ts        # McpServerForm、parseEnvLine、toConfigServer、fromConfigServer(纯函数)
  McpServerCard.tsx  # 64-214
  MemoryTypeSelect.tsx      # 228-253(+typeBadgeNode)
  SkillRow.tsx / SkillsSection.tsx   # 299-399
  AccountTab.tsx     # 账号(provider 切换/凭据/余额查询 switchProvider 相关 JSX)
  BehaviorTab.tsx    # 行为与界面
  ToolsTab.tsx       # 工具与能力(工具列表/过滤/技能区)
  MemoryTab.tsx      # 记忆与进化(记忆列表/类型滚轮/进化区)
  SubAgentTab.tsx    # Sub Agent(总结/揣测风格与人格)
  DataTab.tsx        # 数据管理(clearConfirm 计时器/确认交互)
views/AgentSettingsView.tsx   # 保留:tab 外壳 + 共享表单状态 + switchProvider/
                              #     queryBalance 等跨 tab 逻辑(~500 行)
```

### 6.2 关键设计点

1. **tab 组件化**:每个 tab = `(props) => JSX`,props 取
   `{ config, onPatch, ...该 tab 专属状态 }`;`AgentSettingsViewProps`
   与导出面不变。
2. **本地状态随 tab 走**:`leavingRef`/`clearConfirmTimerRef`/`memoryLeave`/
   `skillsLeave`/`mcpLeave` 等只被单个 tab 用的状态与回调,直接搬进该 tab
   组件,是拆分的主要收益点。
3. **跨 tab 共享**:config 单一对象(单一 useState)与 `onPatch` 由外壳持有;
   switchProvider/queryBalance 留在外壳(被账号 tab 通过 props 使用)。
4. `AgentSettingsViewProps`(25-44)不动;`views/index.ts` 导出不变。

### 6.3 风险

- 先确认 config 的 state 形态(单一对象 vs 分散 state)再定 props 契约——
  若分散,把「读」收敛成外壳计算后下传,不改变写路径;
- 记忆/技能区有 useLeavingList 动画时序,搬移后动画行为必须一致
  (用 mini/media-lib 截图模式冒烟)。

---

## 7. `views/AgentView.tsx`(1719 行)→ `agent/` 子模块

### 7.1 目标结构

```
views/agent/
  chat-scroll.ts     # smoothScrollTo、jumpToBottom、scrollMessagesToBottom、
                     #     findLastMdMedia、formatSessionTime(纯函数,可单测)
  QuickMenu.tsx      # QUICK_MENU_ICONS + 快捷菜单 JSX(63-191 + 菜单渲染段)
  ToolsItem.tsx      # ToolsItem(323-372)
  SessionDock.tsx    # 会话坞:dockRef/bannerRef、会话列表、备注编辑、清空确认
                     #     (427-533 相关状态 + JSX)
views/AgentView.tsx  # 主组件编排(~900 行):消息列表、输入、路由到各子组件
```

### 7.2 关键设计点

1. **滚动/时间工具先拆**(纯函数,风险最低,可加单测);
2. **会话坞 props 化**:`sessionOpen`/`setSessionOpen`、备注编辑状态、
   清空确认回调由 AgentView 持有、经 props 下传——**useCallback 稳定性
   照项目既有惯例对齐**(双宿主共享 hook 已立过这个规矩),避免子组件
   无谓重渲染;
3. 快捷菜单滚轮拦截/悬浮断开等交互逻辑随 QuickMenu.tsx 走;
4. `AgentViewProps`(372)与 views/index.ts 导出不变。

### 7.3 风险

- 会话坞与主组件状态交错最密,放 Phase 2 里最后做;
- AgentView 内 renderMessage 等大 useCallback 留在主组件,不强行下沉。

---

## 8. `DynamicIsland.tsx`(2127 行)→ `parts/` + `island-utils.ts`

### 8.1 目标结构

```
src/components/DynamicIsland/
  island-utils.ts    # 纯函数:normMediaSrc、cutLabel、agentCompactLabel、
                     #     mediaTextFor、islandWidth 计算、背景 CSS 变量构建、
                     #     文本颜色解析(resolvedTextColor/textDimColor/
                     #     islandFontFamily/islandFontWeight)等(可单测)
  parts/
    CompactContent.tsx   # 图标 + 文字区 + 省略号 + thinking dots(1775-1801)
    BackgroundLayer.tsx  # 自定义背景层 + CSS 变量注入(1742-1763)
    ScrubOverlay.tsx     # ParticleTime 包装(1802-1809)
    Panel.tsx            # 展开面板:按 panelView 分发(1810-2127,~320 行)
                         #     视图注册表 PANEL_VIEWS + 面板 JSX
  DynamicIsland.tsx      # 状态机/手势/尺寸逻辑 + 组装(目标 ~800-900 行)
```

### 8.2 关键设计点

1. **纯函数先抽**:island-utils.ts 全部无副作用,新增
   `tests/test-island-utils.ts`(或并入现有单测脚本)覆盖 cutLabel/mediaTextFor/
   背景参数计算——这是本文件拆分唯一能附带测试收益的部分。
2. **渲染 JSX 拆解**:把 430 行大 JSX 按 DOM 层拆成 parts/ 展示组件,
   全部 props 化(事件回调由 DynamicIsland 传入),parts 不 import 组件本体;
3. **面板分发注册表**:Panel.tsx 内 `PANEL_VIEWS: Record<PanelView, ...>`
   收敛 1810-2127 的 view 分支(视图组件已独立成文件,只剩开关逻辑);
   `isSettingsView` 的缩回屏蔽逻辑留在组件(行为相关);
4. **手势/状态机/尺寸计算不动**:refs、press/swipe/tripleClick、长按、
   高度动画循环、makeSnapshot、scrub 全留在 DynamicIsland.tsx——
   维持「有意未做」结论,不为拆分引入行为风险;
5. 导出面不变:`DynamicIsland`、`IslandSnapshot`、`DynamicIslandHandle`
   由 DynamicIsland.tsx re-export(IslandSnapshot/Handle 可移入 island-utils
   或独立 types 文件后 re-export)。

### 8.3 风险

- 本文件是两端(Web/挂件)共享核心,拆分后必须 Web 演示版(`pnpm dev`)
  与挂件版(`dev:widget`)双端冒烟;
- 背景层/蒙版的 DOM 层级与 class 名一个都不能变(巡检断言依赖 class);
- 面板 JSX 里有大量计算好的变量(可见文本/动画类),搬移时把「计算」留在
  组件、把「渲染」交给 parts,避免把计算误搬进展示组件。

---

## 9. 阶段计划与验证门

| 阶段 | 内容 | 验证门 |
| --- | --- | --- |
| Phase 0 | 记录基线:测试数、lint/tsc 全绿、git 基线提交 | 全绿快照 |
| Phase 1 | main.cjs → electron/main/(§2);screenshot-tests.cjs → tests/screenshot/(§3);test-agent-core.ts → tests/agent-core/(§4) | tsc + lint + 全部单测 + dev:widget 启动 + `WIDGET_SCREENSHOT_MODE=expanded` 冒烟 |
| Phase 2 | Markdown.tsx(§5)→ AgentSettingsView.tsx(§6)→ AgentView.tsx(§7)→ DynamicIsland.tsx(§8) | tsc + lint + 全部单测 + dev:widget + `agent`/`mini`/`clear-data` 截图模式实机一轮 |
| Phase 3(可选) | island-utils 单测补强;CSS 顺手拆分 | 同上 |

**验收标准**
- 各文件达到 §0 目标行数;测试数只增不减;lint/tsc 清零;
- git log 每阶段一个 commit,message 按项目风格;
- 实施后同步 CLAUDE.md(「有意未做」段更新、目录结构段)与
  docs/TECH.md(目录结构/第 2 章命令不变,新增拆分记录)。

## 10. 风险总览与对策

| 风险 | 对策 |
| --- | --- |
| CJS 循环 require | §2.3-3 注入点清单先行;tsc 不查 CJS 环,靠 node 启动冒烟兜 |
| 内联 IPC 闭包变量搬家漏带 | 逐字搬移 + dev:widget 全通道冒烟(托盘设置/模式切换/拖拽) |
| 巡检断言依赖 DOM/class 名 | 渲染拆解禁止改 class;§8.3 双端冒烟 |
| 测试拆分引入隐藏依赖 | 套件只依赖 harness;先跑基线对比测试数 |
| 拆完又膨胀 | §0 目标行数作为 PR 门槛;新增逻辑先进新文件 |

---

*附:本设计对应 2026-08-16 评审结论「下一步的挑战是学会不做」——拆分本身
也只做行为中性的部分,把「手势状态机抽 hook」这类高风险重构继续留在
「有意未做」清单,直到有交互测试覆盖。*
