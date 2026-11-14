# CLAUDE.md

> **V3.5(2026-10-26) · 人格卡版本**(当前)。**V3.2(2026-09-22)**:文档重构——本文件瘦身为**引擎级操作手册**(命令 / 架构速查 / 当前不变量 / 关键约束 / "改 X 前先读"),只记**现在是什么样、必须遵守什么**。历史叙事(N 轮实录、实测数据、设计演进)整体存档于 **CLAUDE-HISTORY.md**(2026-08-05 ~ 2026-09-22 逐条踩坑实录原文,含双岛并存设计文档)——查根因/复盘 bug 去那里;深度技术细节在 TECH.md。行为冲突以代码现状为准。

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 文档地图与架构速查

- **文档地图**:根目录 README.md = 用户向(功能/安装发行/含六域目录版图);WIDGET-README.md = 挂件部署调试;TECH.md = 技术全文(48 章 + 附录;**附录 H 是文档章节索引**,附录 D = 改功能后的文档同步清单;42 插件化 / 43 安装器发行 / 45 GLM·MiMo·LM Studio / 46 米家智能家居 / 47 NapCat QQ 机器人 / 48 人格卡 / 16 提示词约束 / 17 会话路由 / 10 踩坑 / 5.3 LM Studio 解析);CLAUDE-HISTORY.md = 踩坑实录原文存档;本文件 = 操作手册。
- **进程与构建边界**:渲染进程 `src/` + `widget/`(双入口共享 DynamicIsland.tsx);主进程 `electron/main.cjs`(+ settings-store / window-placement / data-manifest / napcat-login 独立小窗 napcat-login.cjs);Agent 引擎 = 主进程内 require `electron/agent.cjs`,esbuild 入口 **`electron/agent/engine/engine.ts`**;SMTC 桥 = utilityProcess `bridge.cjs`(← scripts/system-media-bridge.ts,底层 smtc-reader.ps1 + smtc-bridge.cs);外部进程 = MCP 子进程 / tools/bili(bili-tool)/ tools/docflow / tools/xxt / NapCat OneBot WS(`napcat/wsclient.ts` 手写传输)。
- **electron/agent/ 六域**(完整树见 README「架构版图:六域目录」):`engine/`(装配入口 engine.ts + loop/history/tool-execution/confirm-gate/manual-call/turn-text/builtins)· `plugin/`(插件内核 kernel + 声明式组合层 composition + 能力接缝 llm/tool-registry + host-bridge 唯一接触 EngineDeps + 工具/提示/子代理插件)· `providers/`(七协议适配器 + sse 公共层 + provider.ts 兼容导出)· `tools/`(tools.ts 主入口 + bili/search/media/docflow/glm/mimo/mijia/computer/env 分簇 + settingsTools 四文件 + configTools/sessionTools)· `napcat/`(napcat.ts 入口 + client/message/text/store/session + login/qr)· `subagents/`(总结/判断等 Sub Agent + 插件化宿主)+ 根层共享(types/constants/mcp/skills/memory/tasks/evolution/undo/notify/privacy)。
- **LLM 七协议**(`plugin/llm.ts` LlmProtocol,Base URL 判定 + 配置可显式指定;Consumer 永不 import 具体供应商,经 `ctx.get('llm').stream()`):`responses` DeepSeek Responses(默认)/ `chat` DeepSeek Chat Completions / `anthropic` Anthropic Messages / `mimo-responses`·`mimo-chat` 小米 MiMo(**Responses 第一优先**(用户定调,Chat 过旧):多模态原生进 /v1/responses input + Batch API,2026-09-22 官网适配见 TECH.md 5.3.5)/ `lmstudio-chat` LM Studio 本地(GLM-4-9B 专属档位)/ `glm-chat` 智谱 GLM 云端(glm_ocr/glm_file_parse 文档工具)。配置 = `agent.providers` 多供应商 + `activeProvider`,主 Agent 与 Sub Agent 可分工(云端强模型 + 本地小模型省额度)。
- **改代码前先读(TECH.md)**:插件内核/接缝/组合层 → 42 章;任何提示词 → 16.1-16.3;LM Studio 适配/文本工具调用 → 5.3;会话路由/归属 → 17 章;HEVC 补丁二进制 → 15 章 + 10.11;安装器发行 → 43 章;GLM 供应商 → 45 章;MiMo 多模态/Batch → 5.3.5;米家工具簇/登录/协议 → 46 章;媒体播放 → 6.2.2 / 19 章。
- **测试全景**:一键 `pnpm check`(typecheck + lint + 全部单测 + Electron Node≥22 基线)。核心 = `tests/test-agent-core.ts`(经 test-agent-core.mjs esbuild 打包直跑,electron→stub 别名);另有 plugin-kernel-tests.ts / test-glm4-tools.ts / test-settings-store.cjs / test-markdown.mjs / test-window-placement.cjs / test-bili-download.cjs / test-mimo-*;真实 API = test-title-live.cjs / test-agent-live / stress-lmstudio;QR 对拍 qr-crosscheck(qr.ts 与 python qrcode 逐格对拍,注意锁 MODE_8BIT_BYTE);UI 巡检 tests/screenshot-tests.cjs(`WIDGET_SCREENSHOT_MODE`:expanded/layout/theme/stress/test/hevc-frame/skill-delete-check/agent/chat-media/clear-data/media-lib/video-resume-check/session-debug 等)。tests/test-master-fp-live.cjs 已退役留桩(旧指纹协议的验证前提已不存在)。
- **CI**:`.github/workflows/verify.yml` 每 push/PR 在 windows-latest 跑 `pnpm check` + `build:electron` + `build:widget`。
- **常见误读提示**:历史文档里的「MASTER_QQ 硬编码」「【指纹:xxx】协议」均已退役(前者 → privacy.json 配置化,后者 → 归属判定 + turnTag 程序侧认证,见下文 Agent 模式);「工具清单 N 个」均为当时快照,现状以 `listAllTools`/TECH.md 附录 I 为准。

## 项目概述

灵动岛桌面挂件(Windows):Electron 透明无边框悬浮窗,复刻 iOS 灵动岛,通过 Windows SMTC 监听 QQ音乐/网易云等播放状态并控制(切歌/进度/模式),内置本地播放器兜底;Agent 模式 = 常驻桌面的 LLM"岛灵"(对话 + 本机工具执行 + 记忆/技能/MCP/进化/主动陪伴),接入 NapCat 后可接管 QQ(私聊/群聊自主回复、按人区分、远程控制)。技术栈:Electron 43 + React 19 + TypeScript + Vite,全部中文注释。

## 常用命令

```bash
dev.bat                # 一键重新构建并启动桌面开发版(项目根双击即可):先结束残留旧实例
                       # (单实例锁——不结束则新启动只会唤起旧窗口加载旧代码;按 electron.exe
                       # 路径过滤只杀本项目,不影响其它 Electron 应用),再跑 pnpm dev:widget。
                       # 纯 ASCII 壳 + chcp 65001,真实逻辑在 scripts/dev.mjs(Node 原生 UTF-8)
                       # ——cmd 分块读取批处理文件,chcp 切换代码页前已缓冲的中文行会按旧
                       # 代码页解码成乱码命令(实测),中文逻辑不能进 bat
node scripts/brand-electron-icon.mjs  # 图标烙进自编译 exe(2026-08-13):electron/icon.ico 多尺寸
                       # (16-256,make-icon 自动产出)经 rcedit(devDependency)写入
                       # C:\electron-hevc-dist\electron.exe 资源——修复弹窗/进程图标(原仅
                       # 32×32 默认构建图标);烙源后 apply 自然携带;重新编译 Electron 后需重烙
node scripts/build-release.mjs     # 绿色发布打包(2026-08-17):产出 release/灵动岛/
                       # (electron/ 运行时 + resources/app 应用,绿色版结构);安装管理器的安装源
node scripts/build-manager.mjs     # 安装管理器打包(2026-10-23 安装/卸载合一):产出
                       # release/灵动岛安装管理器/(灵动岛安装管理器.exe + resources/app 向导
                       # + resources/release/灵动岛 安装源);需先跑 build-release.mjs;
                       # 开发期可 npx electron manager/main.cjs 预览
                       # (启动自动识别安装/卸载,带 --uninstall 直接进卸载页;
                       #  安装时把管理器自身复制到 <安装目录>/uninstaller,卸载独立于主应用)
node scripts/apply-hevc-electron.mjs  # HEVC(H.265)解码补丁(2026-08-12):官方 Electron 无 HEVC 解码能力
                       # (ffmpeg 无解码器 + media 层门控,详见 TECH.md 10.3)。dev.bat 的
                       # [1.5/3] 步会自动检测并应用——把 C:\electron-hevc-dist 自编译产物(源码树
                       # C:\electron-gn,与官方 43.2.0 同一 tag,ffmpeg 软解 + 门控补丁)的 7 个
                       # 构建文件(electron.exe/ffmpeg.dll/快照/pak)换进 node_modules/electron/
                       # dist,官方版备份 *.official 可回退:--restore 恢复官方、--check 只查状态;
                       # 重装 node_modules 后 dev.bat 会自动重新应用。AV1 无需本补丁(官方版即可软解)
pnpm dev             # 仅 Vite Web 演示版(浏览器调试,不进 Electron)
pnpm dev:widget      # 构建挂件页面并启动 Electron(日常调试主入口;**已前置 pnpm build:electron**——dev:widget 自动重建 agent.cjs/bridge.cjs,改 electron/agent/**/*.ts 不再静默跑旧 bundle(2026-08-06 修复,曾实测新工具在对话里调不到、LLM 拿旧工具凑合);必须带 --mode widget,
                     # 否则 tracks.ts 的内置三首 MP3 会打进挂件歌单,而音频文件又被
                     # closeBundle 删掉 → 播放列表出现"无法播放且无法删除"的损坏曲目)
pnpm build           # tsc -b 类型检查 + Web 版构建
pnpm build:widget    # 仅构建挂件页面 → dist-widget/
pnpm build:electron  # esbuild 打包 SMTC 桥接(→ electron/bridge.cjs)+ Agent 引擎(→ electron/agent.cjs)+ 生成图标(icon.png/icon.ico 已存在时跳过;FORCE_ICON=1 强制重建)
pnpm lint            # oxlint
pnpm typecheck       # tsc -b 全部 tsconfig(app/electron/node)
pnpm test            # 全部单测 = test:unit + test:core
pnpm test:unit       # test:settings + test:markdown
pnpm test:settings   # 设置持久化单测(tests/test-settings-store.cjs:原子写/加密/.bak)
pnpm test:core       # 同 node tests/test-agent-core.mjs(引擎核心)
pnpm test:runtime    # Electron 自带 Node ≥22 运行时基线(scripts/test-electron-node.mjs)
pnpm check           # 一键全量校验 = typecheck + lint + test + test:runtime(本地门槛 = CI 同款)
pnpm audit:release   # 发布目录审计(scripts/audit-release.mjs --strict)
pnpm bridge          # 独立运行系统媒体桥接脚本(单独调试 SMTC)
pnpm watch:electron # 热重建 Agent 引擎/桥(监听 electron/agent/**/*.ts 与 scripts/,自动 esbuild 重建 + 重启 electron;渲染端仍用 dev:widget)
npx electron --disable-gpu tests/test-title-live.cjs   # 后台标签(总结标题)真实 API 测试(2026-08-12):electron 主进程跑——内嵌 esbuild 打包最新 agent.cjs(不跑完整 build-electron,其 make-icon 会再 spawn electron 离屏渲染互锁)+ safeStorage 解密 settings.json 的 apiKey(**必须 ready 前 app.setPath('userData', %APPDATA%/dynamic-island)——Electron 43 safeStorage app-bound 熵绑定 userData 路径,实测不设解不开密文**)+ 5 段真实风格对话历史:① summarize 断言非空/≤20 码元/非句子式;② 风格验证段(标题 4 文风 + 自定义,断言输出互不相同);结果双写 tests/title-test-result.log(stdout 管道缓冲吞掉,实测);迭代措辞 = 改 subagents/subagents.ts 重跑
pnpm test:markdown    # 消息气泡 Markdown 解析器测试(esbuild 打包纯解析器直测)
```

**验证约定(用户要求,2026-08-04 更新;2026-08-07 再更新;2026-09-22 并入 pnpm check)**:每次优化/修改代码后,自动重新构建并启动实机验证——默认执行 `pnpm dev:widget`(构建挂件页面并启动 Electron)确认改动生效,此前的"默认不自动验证"约定已废止。实机验证用 `timeout` 包住 electron 在几十秒后自动退出(应用托盘常驻不会自退,见下方调试工具),需要截图时配 `WIDGET_SCREENSHOT=<path>`;**巡检约定(2026-08-07 用户要求):重新构建程序后不要自动跑 WIDGET_SCREENSHOT 巡检**——完整巡检(agent 模式等)只在用户明确要求时执行(每轮全量巡检耗时 8-10 分钟且依赖真实 LLM,频繁自动跑不划算);默认完成标准 = `pnpm check`(typecheck + lint + 全部单测 + Electron Node≥22 基线,与 CI `.github/workflows/verify.yml` 同款)+ 构建 + dev:widget 启动实机验证。

## 架构

### 双入口共享一个组件

- `src/` — Web 演示版入口(vite.config.ts),带完整演示页面;`widget/` — 桌面挂件入口(vite.widget.config.ts,`mode=widget`),只渲染灵动岛本体,`base='./'` 产物可直接 file:// 加载;widget 模式下 `src/media/tracks.ts` 返回空内置歌单、产物剔除 music 资源。
- **`src/components/DynamicIsland/DynamicIsland.tsx` 是两端共享的岛体组件**,行为差异全部靠 CSS 覆盖(widget/widget.css 的 `.widget-stage` 选择器)与可选 props 区分。改动组件时务必同时考虑 Web 版(App.tsx)与挂件版(WidgetApp.tsx)两个调用方。
- `tsconfig/tsconfig.app.json` include 含 `src` + `widget`;`tsc -b tsconfig/tsconfig.json` 会检查两端;electron 侧 TS 由 tsconfig.electron.json 并入 tsc -b(esbuild 不查类型)。

### 数据源双轨

`useSystemMedia`(SMTC 外部平台)与 `useMediaPlayer`(本地播放器)并存,`externalActive = system.active && system.track && useExternalSource` 决定数据与控制走哪一边,切换时**双向暂停**。SMTC 播放模式以系统真实状态为数据源(轮询校准),点击循环后 1.2s 检测跟随,未跟随提示并回退。**SMTC 位置/歌词双轨、seek 支持记忆化等关键约束见「关键约束」**。

### Electron 主进程(electron/main.cjs)

当前不变量(演化史见 CLAUDE-HISTORY.md「Electron 主进程」段):

- **点击穿透**:收起时 `setIgnoreMouseEvents` 穿透开启;三层防穿透死锁——① 轮询校正(`widget:pointer-poll`,穿透开启 200ms 高频/关闭 600ms 低频,按窗口 bounds + 光标屏幕位置核对岛体 rect,状态不符即校正;拖拽期间跳过);② 切接收补发 mousemove(恢复 hover 重算);③ 事件与轮询共用意图状态(lastPointerPollRef 同步更新)。穿透态下 OS 不再投递鼠标事件,任何"悬浮失灵"先查这三层。
- **移动挂件 = 右键长按拖拽**(~0.4s、位移 < 8px 才进入拖拽;右键不参与任何点击手势,进度条/文字手势均有 `button !== 0` 守卫)。防漂移三件套(长按期间最新坐标作基准 / <0.5px 容差去重 / setPosition 后自校正)+ pointermove rAF 合帧 + 自校正 getPosition 降频 ~10Hz;拖拽期间穿透保持接收。
- **展开位置补偿**:set-size handler 在 setSize 后按 `dx = (旧宽-新宽)/2` 补偿 setPosition(**宽度变化保持窗口中心 X 不动,高度变化保持顶部不动**);**只按请求宽度变化补偿**——`lastSetSizeW` 记忆请求宽,`|cw - lastSetSizeW| >= 2` 才做 X 补偿(Windows 实际宽比请求宽 ~2px,逐帧补偿会累积 80px+ 漂移,实测);set-size/set-height 100ms trailing 合帧。
- **异常防线**:拖拽坐标 ±10 万合理范围校验,非有限值/超界丢弃(setPosition int32 转换对 |v| ≥ 2^31 会抛未捕获异常);窗口 IPC 统一 isDestroyed 防护;主进程 uncaughtException/unhandledRejection 兜底;render-process-gone crashed/oom 自动 reload。
- **持久化**:`userData/settings.json` 原子写(tmp+rename+.bak 损坏恢复)+ 150ms 防抖 + before-quit flush + 内存缓存;apiKey 经 safeStorage(DPAPI,enc: 前缀)加密落盘;主题色/背景参数/字体参数 localStorage,上传音乐/背景图/字体/音频库 IndexedDB,视频库**路径引用**;窗口位置不持久化(启动顶部居中)。
- **设置类视图**(`settings/background/theme/font/font-color/font-library/image-library/agent-settings/lyric-api/media-library` 等)一律屏蔽单击岛体/长按/Esc/点外缩回,只能返回键退出;蒙版 = 岛体层 `.island-panel-mask`(rgba(8,10,14,0.55)),面板自身不带蒙版背景(防 maskPanelIn 连蒙版一起透明闪烁);面板进入统一纯淡入。
- **通知统一走 `showNotify`**(tray.displayBalloon 通道,Win10+ 自动转 toast 样式)——**严禁主进程 `new Notification().show()`**:补丁版 Electron 上 Chromium toast + 并发网络 = EXCEPTION_ACCESS_VIOLATION 段错误(TECH.md 10.10/10.11)。engine 侧 evolution/tools 同通道。
- 托盘:设置/多媒体库/模式 radio/退出;单实例锁;`app.setAppUserModelId('com.dynamic-island.widget')` 必须设(否则 Windows 通知静默失败)。

### SMTC 桥接

`scripts/system-media-bridge.ts` → `electron/bridge.cjs`,utilityProcess 启动、崩溃自动重启(10s 内 3 次上限,桥内 smtc-reader 子进程同款上限含 spawn error);读取端 `electron/smtc-reader.ps1` 运行时用 csc.exe 编译 `electron/smtc-bridge.cs`(PS 5.1 无法绑定 WinRT 集合元素,必须走 C# 强类型桥;异步轮询 Status/GetResults 3s 超时防卡死)。

### Agent 模式

托盘"模式"在 音乐 ↔ Agent 间切换(radio,持久化 settings.json `mode`)。**模式切换事件带来源**(`widget:set-mode` payload `{mode, source}`):`source:'tool'`(switch_to_music 触发)切回音乐**不中止**本轮(防止历史停在未答复 user 消息 → 下一轮重复执行 = 上下文污染);`'user'`(托盘/手势)切回音乐中止当前轮。

#### 消息归属与回复路由(2026-09-22 现行规则,改路由前必读 TECH.md 17 章)

**四规则**:① 对话窗口发给 LLM 的信息永远是主人信息;② 主人 QQ 私聊/群聊发给 LLM 的信息永远是主人信息(群聊需意图识别 `isDirectedToBot`:@机器人 / 句首明确称呼(岛灵·鲸鱼娘·鲸鱼·机器人) → 指向 LLM;未指向 = 别人的信息=环境闲聊,缺省按别人);③ 其它都是别人的信息;④ **归属由触发来源在程序入口判定,回复默认落点随归属走,LLM 不写不读任何文本标记**;跨归属外发(替主人转达/向主人汇报)只走 napcat send/send_group 工具,意图判定器(createReplyClassifier)降级为错配安全网(失败回退默认,非主路由)。

- **轮次上下文(2026-11-03)**:`electron/napcat-routing.cjs` 为每轮创建 UUID `turnTag`、来源/目标/主人 QQ/群发言人/待回复对象快照。引擎与工具经 AsyncLocalStorage 保留原轮身份；中止后的事件不再送出。落定先验标签再领取，旧事件与重复事件不消费新轮。
- **询问轮**:`ask` 与推理引擎都在对应 `private:<QQ>` 会话，默认回复仍私发主人，不借用 mainRoute。工具缺少轮次时按会话类型限制私发范围。
- **群元数据**:`groupTurn` 随入站消息、前端队列、preload 和 `agent:send` 一起传递，不读取「最近发言人」。
- **默认路由表**:窗口/面板留窗口；主人 QQ 私聊/群点名私发主人；联系人回对方；群聊回本群；ask 请示主人；system 不外发。跨对象外发走明确的 send/send_group。疑似私下汇报扣留，文本措辞不能自动更换收件人。
- **待回复与发送回执**:待办按 QQ 保存 30 分钟，执行轮绑定唯一对象（多人且不明确则不猜），成功后按待办 ID 消费，不删除后来新增的待办。防重发只看本轮成功回执；群工具已发文字则正文留窗口，不转给主人，纯媒体不抑制群正文。收到发送成功回执后才发 `message-routed` 和「已回复」通知；失败保留待办并提示。
- **执行兜底**:主人明确转达指令 + 固定待办/会话对象 + 判定器确认 other 才能代发；其余走默认落点或扣留。正则只用于粗筛，不把「你/帮我」自动提升为群里的主人指令。
- **triggerRaw 踩坑**:QQ/群触发文本是注入模板(含「回复对方/发给」字样)会误命中触发侧指令识别——启发式与判定器一律剥【QQxx】类别行 + 【档案卡】后的正文。
- **已退役**(勿再参考历史文档实现):【指纹:xxx】/【主人指纹:xxx】/【回复对方】整套文本协议、extractTurnFingerprint/extractMasterFingerprint/hasTurnMark/hasMasterTurnMark/routeForClassifierIntent 等;`stripFingerprintMarks` 降级为**历史残留清洗**(旧 localStorage 标记会被 LLM 抄到输出,发送边界剥除);**UI 标签(发给对方纸飞机/发给主人皇冠)唯一来源 = `message-routed` 事件按实际送达目的地补标**(AgentView 不嗅探文本)。
- **行为变化(留意)**:① 群触发轮"回复自动私发主人汇报"取消(单归属制,群回复给群即止);② 无标记回复不再扣留(默认落点必达);③ 私聊面板回复留窗口(明确指示 + 判定才发对方)。

#### 引擎与 LLM 接缝

- 引擎 = 六域目录 esbuild 打包 `electron/agent.cjs`(零第三方依赖,`electron` external;入口 `engine/engine.ts`),主进程内运行。**无状态**:渲染端每次 send 回传完整历史;**会话隔离**:主进程 sessionEngines Map(每会话独立引擎实例 = 并行,上限 12 丢最旧),会话键 main / `private:<QQ>` / `group:<群号>`;引擎 emit 给所有事件附 sessionKey,useAgent 按键过滤(main 接受无键后台标签事件)。
- **插件纪律(V3.0,TECH.md 42)**:新能力 = 写插件 + 注册工厂 + Profile 加一行,**不改 engine-loop、不改其他插件**;host-bridge 是唯一接触 EngineDeps 的插件;装配清单在 defaultProfile 单点声明、dump 可见。
- **七协议经接缝**:`plugin/llm.ts` LlmRuntime 注册适配器、执行时解析(未注册/无匹配/多匹配各有编码错误,选择不依赖注册顺序);`providers/provider.ts` 保留兼容导出(detectProvider→protocolOf / providerLabel / streamByConfig)。改适配器前读 TECH.md 5.3(LM Studio:parseTextToolCalls 文本调用解析 + StreamCallFilter 流式标记过滤——小模型格式多变,有实测格式全家福回归)/ 42 / 45(GLM4 工具名标签包裹型调用的流式抑制 + 落定清洗)。
- **厂商专属通道(2026-10-22,改路由前必读)**:每家厂商只走自家适配器与自家实现——① 适配器按 baseURL **互斥**解析(protocolOf:anthropic→mimo→lmstudio→glm→deepseek 兜底,DeepSeek 地址永不会解析到 mimo 适配器,反之亦然,有测试锁死);② 序列化/图像编码/错误映射**互不借用**(deepseek-media / mimo-media / lmstudio 各一套,deepseekModelForInput 换模只在 DeepSeek 适配器内);③ 厂商专属工具固定走**自家凭据桶**(web_search/web_fetch/get_deepseek_balance → providers.deepseek;glm_ocr/glm_file_parse → providers.glm;mimo_media/mimo_batch → providers.mimo),与激活供应商无关;④ Sub Agent 跨厂商换桶(subProvider)时**丢弃 llmAdapter**(resolveSubConfig:llmAdapter 是协议 id,preferId 命中不校验地址——不丢会把 DeepSeek 的 'responses' 强绑到 MiMo/GLM 的 baseURL)。
- **协议级硬约束**:① thinking 模式在**请求带 tools 时**每一轮助手消息都要回传思维链,没调用工具的轮次也要(Responses = 该轮最前的 reasoning item,content 为 `reasoning_text`,不用 summary;Chat = `reasoning_content`;空串同样 400,没存到原文时回一个空格)。不带 tools 或思考关闭时不回传。Anthropic thinking 块需 signature 不可回放已丢弃——工具循环中途丢思维链 = 400;② **前缀缓存要求序列化幂等**(instructions/历史/tools 顺序/reasoning 回传全稳定,动态指令走 input 末尾的 system 请求项、**不进 system prompt**——拼进去断缓存,50 倍价差);③ 孤立代理清洗 `sanitizeUnpairedSurrogates`(**发送端 stringify 前 + 接收端 parseSse 帧数据**双保险,防截断 emoji/上游 JSON 毒化历史 → 400 "unexpected end of hex escape");④ Responses 工具参数以 `function_call_arguments.done` 为权威(delta 不带 call_id,按 output_index/item_id 三级匹配累积);⑤ 工具结果截断 8000 回填;`trimHistory` 400K 预算(仅超限触发,不断缓存);`maxOutputTokens` 可变预算(缺省 8192,`set_output_budget` 工具自主调整 4096-262144,截断时注入 BUDGET_TRUNCATE_HINT 不落定半截回复);⑥ **图像理解(2026-10-22)**:user 消息图片 part 序列化进请求(Responses `input_image` / Chat `image_url` / Anthropic `image` 块,`deepseek-media.ts` 三形状统一编码;**仅 user 可带图**),内联图片 32MiB 预算**新图优先**(请求体 48MiB 硬上限,预算外旧图降级文本占位),带图请求配置模型非视觉系自动换 `deepseek-flash`(官方:图片仅该模型支持),图片 token 按 1024/张计入 trimHistory。
- **手动调用**:输入以 `/` 开头 = 技能、`@` 开头 = MCP 工具;剩余文本是合法 JSON 则作参数;输入框 `/`/`@` 浮出候选列表(↑↓/Enter/Esc,技能 = `skill_` 前缀,MCP = `mcp_` 且名称含第二段下划线——以此区分内置 mcp_config)。

#### 工具系统

`{name, description, parameters(JSON Schema), execute, timeoutMs?}`;形状与注册语义参照 opencode。关键语义:

- **参数校验**:`validateRequiredArgs` 缺参/空串/解析失败生成**结构化错误文本回填**(缺失参数名+类型+说明+enum),不执行工具——LLM 自纠;数值 0/布尔 false 是合法值;**迭代上限 25** 防死循环。
- **超时**:`tool.timeoutMs ?? 60s`(doc_convert 200s / xxt 310s 显式覆盖);execute 第二参 `ctx?: {signal}`(delegate 消费主回合 abort)。
- **媒体拦截**:open_file 与 exec_command 的 `start` 打开媒体都拦截为 **media part**(引擎注入助手消息,渲染端 MediaFrame 窗口内播放)——LLM 只回"已播放"不展示是常见假象;exec 描述注明勿用 start 打开媒体。
- **工具输出目录**:`agent.outputDir` 空 = 默认位置;`toolOutputDir(tool)` = `<根>/<工具名>/<会话ID>`(bili outdir / xxt 截图 / doc_convert 接入;write_file/exec_command 用户指定路径不重定向);`buildToolsGuideBlock()` 把工具绝对路径清单注入系统提示(稳定不断缓存)。
- **工具族**(现状以 listAllTools / TECH.md 附录 I 为准):基础(exec/read/write/list_dir/open_url/open_file/web_search DeepSeek 官方搜索优先·Bing 主 DDG 回退/web_fetch 网页抓取 DeepSeek 官方 fetch 优先·直连兜底/get_time/system_info/notify/switch_to_music(play 参数)/set_system_volume/set_output_budget/delegate)· bili(数据查询/下载/转码/登录扫码/logout/config/progress/fav 收藏夹等,下载 cwd 固定 userData/bili,自动转码 HEVC→H.264,进度文件轮询;**登录态整合**(2026-09-22):凭据单源 userData/bili/config/cookies.json + 键名规范化 + nav 探针 biliLoginState 全 action 统一,详见 TECH.md 5.4.1)· doc_convert / xxt / get_feature_guide / glm(glm_ocr/glm_file_parse)· MiMo 专项(mimo_media 多模态理解 / mimo_batch 批量推理,mimo 桶惰性凭据同 GLM 先例)· 灵动岛设置(settingsTools 一族 + music_control(放歌自动附歌曲卡片气泡 `type:'song'`,2026-09-22)+ get_island_settings 快照——**修改前先查当前值**,setter 返回 previous)· 多媒体库 9 工具 · sessionTools(get/set_session_note/clear_session_context)· configTools(mcp_config/skills_config/set_proactive_config/set_sub_agent_config/set_output_dir/set_napcat_config/set_owner_qq 等)· napcat(17+ action)· 米家(mijia_devices/mijia_control/mijia_scene/mijia_login——写守卫 turnKind 八值仅主人可写 + 门锁/摄像头硬禁 + 凭证 enc:v1 密文,见 46 章)· MCP `mcp_<服务>_<工具>` · 技能 `skill_<slug>`。
- **设置工具链路**:工具层文件校验(扩展名/大小/hex)→ `EngineDeps.runIslandSettings` → executeJavaScript 调 `window.__islandSettings` 设置桥(src/settingsBridge.ts,与设置 UI 同存储层)→ 派发 `island-settings-changed`(detail.scopes)→ WidgetApp/DynamicIsland 监听重读即时生效。桥的删除类 op 不暴露给 LLM。

#### 后台任务 / MCP / 技能

- **任务注册表**(`tasks.ts` 零 node 依赖):注册 `{id, title, status: waiting|running|done|failed|cancelled, detail, sessionKey}` → 状态注入系统提示(文案稳定不断缓存)+ 终态触发 done 回调一次(background-done 自动触发对话告知结果);**任务记发起 sessionKey**(detached 完成时引擎 currentSessionKey 可能已变),事件显式携带 sessionKey 不被覆盖;coreToolsPlugin dispose 恢复旧 doneHandler(防指向已销毁 ctx)。
- **MCP**(`mcp.ts` 手写零依赖,双传输 stdio/sse,常驻连接 + connectPromise 互斥,崩溃自动重启):命名 `mcp_<服务名>_<工具名>`;握手 initialize(2024-11-05);**Windows .cmd 必须经 `cmd.exe /d /c`**(路径含 % 加引号);销毁 `taskkill /pid /T /F` 杀树;配置增删改即 prune 旧客户端。
- **技能**(`skills.ts`):扫描 skillsDirs(CLAUDE.md 约定 SKILL.md);默认源 ~/.claude、~/.codex、~/.config/opencode(含 plugins/skills)、userData/skills;注册 `skill_<slug>`(扫描按目录名排序稳定命名);三区 created/imported(.island-imported)/scanned;`excludedSkills` 跳过扫描;**删除只限 userData/skills(slug 白名单 + path.relative 防穿越),不进恢复区**;skills_config create 规范化写 SKILL.md;扫描 ~1s TTL 缓存。

#### 记忆与自我进化

- **记忆**(`memory.ts`):userData/memory.json,条目 `{id, type: preference|fact|workflow|lesson, content, source, protected, createdAt, updatedAt}`,上限 200 条 / 单条 500 字,写盘串行队列;**受保护条目**(人设/岛灵设定):`isProtectedEntry` 判定(显式 protected 标记优先),store.add 自动锁定,forget 拒删(先 update_memory 解锁),记忆块标 `[类型·锁定]`;导入按 id+内容去重;**近重复合并**(2026-09-22 治"自动记录特别多重复":findNearDuplicate 三层判定 = 数字串硬门/归一化等价(剥标点虚词「的」)/包含/LCS-Dice·Jaccard ≥0.85,超集升级措辞、protected 只补锁不改写;提取单次上限 5 条);**惰性 getter**(createMemoryTools/getMemoryStore execute 时实时取,清除数据重建后不持旧引用)。
- **进化**(`evolution.ts`,CONTRACT:只改记忆,不动引擎/工具代码):**快捷自我进化**(2026-09-22:`evolve_memory` 三动作 quick(缺省,同步单轮当轮回填摘要)/run(后台多轮)/status;runQuick 与后台 run 共 busy 守卫);评估委托 `createEvaluatorAgent`(低强度 + noThinking——思维链吃光输出预算会恒空,实测);**假说驱动**(改进建议必须带 hypothesis,delete/merge 清理类豁免);清理类轮次**免复评直接接受**(复评分数噪声大);受保护条目 applyChanges 代码层硬跳过(提示层挡不住幻觉);快照 `memory-snapshots/v<N>.json` + 回滚只到已接受版本(防降级);空轮次永不接受(JSON 解析失败降级链:jsonMode → 纯文本 → 上抛)。

#### Sub Agents / 主动陪伴

总结标题 / 判定 / 评估均为**零共享独立单例**(独立 AbortController、每次调用独立读配置,主对话发送/中止/清空/模式切换打不断它们;已插件化,宿主在 `subagents/`)。

- **总结标题**:json 2 级降级(JSON 主措辞 → 纯文本兜底)+ 严格解析 extractJsonTitle(Python 单引号 dict 容忍,失败**不**把原文兜底当标题)+ 示例词判废 + `sanitizeTitle` 三层清洗(回应词前缀/逗号截断取前半/`looksLikeSentenceTitle` 句子式判废)+ 截 20 码元 + `fallbackTitle` 确定性兜底(首条用户消息,标题永不为空);输入压缩最近 12 条;每级独立重试。
- **心理刻画**:她自己在回复末行写 `‹心|岛上一句|种类|底字›`,引擎**等回复落定再判断**(只认最终回复全文那一行;工具中途步骤只剥不采信),没写下时才从落定思考里收「没说出口的话」(mind-mark depictTurn);`looksLikeIncompleteMind` 残句判废 + `sanitizeMind` 清洗截 16;**无心理 Sub Agent**。
- **主动陪伴**:`agent.proactiveEnabled/Interval/Unit`(钳 5-480);渲染端 useAgent 60s 调度 → `agent:proactive-tick`(resolve = judge 完成后)→ judgeProactive(JSON {should,hint?},失败 should:false 安全侧)→ 主引擎 `proactiveTurn`(完整回合;内部指令 = input 末尾 system 请求项;busy 静默拒绝;abort 链路共享)→ **系统消息 = showNotify 通知 + mind-guess 事件同一句**(心理刻画,落定后判断);judge-no 回退 idle 时钟;QQ/群触发轮强制记忆提取(不限 proactiveEnabled)。
- **风格**:`analyzeUserStyle` 与 judge 并行,拼进 hint;`SUMMARY_STYLES` 预设在 constants.ts(渲染端设置与引擎共用)。

#### NapCat QQ 机器人

- **隐私配置(2026-08-17 起,取代早期 MASTER_QQ 硬编码)**:`userData/privacy.json` 运行时提供 masterQQ / allowed(扩展信任)/ allowedGroups / botQQ(`privacy.ts` + main.cjs 同源读取,`set_owner_qq` 工具可写;**masterQQ 为空 = 主人功能不启用**;安装包不携带隐私)。
- **消息链路**:OneBot 11 WS(`napcat/wsclient.ts` 手写传输:net.Socket + 手写 Upgrade/帧编解码,不经 llhttp)→ 消息解析(段数组/图片/回复/@)→ 系统通知 + 转发渲染端 → useAgent send(带 source/qq/profileCard/msgOwner)→ 回复按归属路由(见上);**剥离双通道**:显示层 `stripNapcatInstructions` 全剥指令段(档案卡经 profileCard 字段展示),历史回传 `stripNapcatHistoryInstructions` **保留【档案卡】**只剥当轮指令。
- **发送边界清洗**(任何路径指纹/标记物理上到不了聊天对象):`stripThinkingPreamble`(思考腔)/ `stripToolNarration`(工具叙述,连续 ≥2 句才删)/ `stripMasterNarration`(主人视角转述/汇报,删空时提取「回他「…」」引号内真回复)/ `stripFingerprintMarks`(旧协议残留)/ `extractImageRefs`(文本夹带路径自动转 image 段真发图,显式 image 参数校验存在)。
- **防重发/限流**:`turnAlreadySentToTarget` 快照(本轮工具发过 → 面板回复不自动发回);`waitSendSlot` 同目标 800ms 限流**等待重试**(25 条/分钟全局硬上限仍抛错防刷屏)。
- **会话体验**:会话键体系 + SessionHost 多实例(useAgent 代理稳定引用;**onTick 必须 useCallback 稳定引用**——内联箭头 = 无限重渲染卡死渲染进程,实测)+ 会话坞(未读红点/删除/静默 mute/绑定)+ **情况记录**(`widget-agent-session-note:<key>`,横幅「记录」编辑,每轮注入「【本会话情况记录】」+ LLM get/set_session_note;「清空」= clear() 不清记录;外部会话清空**不归档**主对话历史)+ `clear_session_context`(LLM 清上下文,不中止当前回合)。
- **QQ 扫码登录小窗**(`napcat-login.cjs` + napcat-login.ts/qr.ts):WebUI 实时登录流,QR **一次性 ~2 分钟时效,到期自动换码 + 服务端报「过期」立即换码**(WebUI 挂旧码是"扫码总过期"根因);**三条硬契约(2026-09-22 活体实测)**:① API 前缀必须带 `/api`(axios baseURL,漏则 `/auth/login` 404 = 小窗白板);② 权威码源 = `CheckLoginStatus.qrcodeurl`,RefreshQRcode 是**异步铸码**(~1-2s 落地,竞态窗口各接口回旧码);③ **过期码不落屏**(loginError 报过期的码丢弃、占位"正在换新"直到新码落地——展示死码 = 扫到"已过期"根因);④ **连接层故障不停死(2026-10-22)**:WebUI 连不上/轮询中掉线 = 丢码 + waiting + 自动重连(retryMs 2.5s),错误文案展开 fetch 的 cause(ECONNREFUSED/超时/DNS)并带地址;地址从 webui.json 的 host/port 发现并同时尝试 127.0.0.1/[::1]——旧版把 `fetch failed` 抛成 error 态后停死,NapCat 起来也不出码(用户截图根因)。另:错误态「换一张」= 整体重试(refresh 在 stopped 时转 start,原直接 return 按钮死)。托盘「QQ 扫码登录…」+ LLM `napcat login`;QR 编码器零依赖手写(qr.ts,tests/qr-crosscheck.mjs 与 python qrcode 对拍);小窗预览验证 = `npx electron tests/preview-napcat-login.cjs`(直连真实 WebUI 出码截图)。
- napcat 工具 action:status/reconnect(熔断后立即重连 OneBot,丢弃旧 socket、迟到 onClose 不计失败)/recent/sent/contacts/contact_update/chats/persona/persona_set/send(send_group 对称,缺省目标 = 当前会话对象)/send_group/recall/zone/zone_post/zone_delete(发/删 QQ 空间说说,走 NapCat 原生 send_qzone_msg/delete_qzone_msg;公开发动态与群公告同级需主人确认,ugc_right 可见范围 1/4/16/64/128)/members/friends/profile/group_info/group_manage/login/sessions/session_mute/session_bind 等(TECH.md 附录 I 为准);群上下文最近 20 条注入;联系人档案 `napcat-contacts.json` 主进程自动落盘 + LLM 补充。`set_napcat_config` 把 enabled 再设 true 或改 wsUrl 同样强制 `start()`(工具写配置不经 `agent:config-set` IPC,补丁须在 `applyAgentConfigPatch` 里同步生命周期)。

#### 渲染端(src/ + widget/)

- **useAgent 状态机**(idle/thinking/running/error)+ 流式累积(rAF 合批 + **50ms 降频**)+ `message` 事件权威落定、中止丢弃流式;**历史契约**:**send 回传的 history 末尾即当前轮用户消息**(引擎不再追加,否则重复发两遍);上一轮被中止/失败(history 以 user 结尾)时新输入**合并进未答复的 user 消息**(防连续 user 消息污染);历史 localStorage 同步写不防抖;abort 竞态双修(迟到流式事件按 statusRef 丢弃 + 引擎 abort 同步复位)。
- **面板高度**:`min(内容测高, 宽×9/16)`(1:1 跟随内容,16:9 封顶),AGENT_PANEL_MAX_H 700、下限 176;骨架两阶段 120ms;流式期间高度瞬跳(`.island-agent-streaming` 无高度过渡)落定后恢复过渡;窗口经 onAgentPanelSize 节拍上报(非逐帧)。
- **消息列表虚拟滚动** `MessageWindow`(窗口化挂载 ± overscan + spacer 数学恒等虚拟总高 + 贴底保持 + **scrollTop 钲制到 [0, total−clientH]**——测量收敛令 total 瞬时变小是"滚动停中间"根因);媒体消息常驻不卸载(播放态不丢);屏外卸载取舍:工具卡展开态不保留、桥 list_conversation_media 只列可视区。
- **性能纪律**(软件渲染/低配约束,详见 TECH.md 6.2.2/24):播放进度 **DOM 直写零 React 重渲染**(timeupdate 不 setState);agentPlaying 用 ref;ToolCard 折叠不渲染 body;MutationObserver 跳过媒体内部 class;测量上报 80ms 节流;滚动动画挂件版直接跳底。
- **Markdown 与对话媒体**:手写零依赖 markdownParser(纯函数可 node 直测)+ Markdown.tsx;GFM 子集 + 表格 + mermaid(SVG 按代码缓存)+ MediaFrame(`![alt](url)` 按扩展名分派 img/video/audio);本地文件走 **`island-media://local/` 协议**(流式 + 完整 Range 206;扩展名 + 按类型大小上限:视频 10GB/音频 1GB/图片 10GB);VideoPlayer 自绘控件(空闲 2.5s 自动隐藏/全屏容器级 requestFullscreen + document 监听/全屏拖拽不禁尺寸变更 `setWinSize`)、右下角 grip 等比缩放、拖宽 effect 自动跟随滚动;VoiceBubble 语音气泡 + 独立音量;**HEVC 零帧检测**(播放 2.5s videoWidth===0 无 error → onError(9) 提示补丁/转码,防静默全黑);自动播放 = `mediaAutoPlay` 一次性(当次对话首条,含 markdown 内嵌;readyState≥1 即 play)与**续播同步**(`lastPlayingVideoSrc`,视频岛⇄面板)分离;离开 agent 视图清续播标记。
- **库与外观**:背景**展开/紧凑双槽位**(图+不透明度+裁切独立,旧数据自动迁移;上传必经 `downscaleBackgroundImage` 长边 ≤1024);文字颜色 CSS 变量 `--text-color/--text-dim`,auto 亮度 = 合成采样(图×opacity+深底);字体库/图片库大面板(库页 `island-lib-view` 440px);**图片库网格 `grid-auto-rows: 128px` 必须显式**(auto 行高超高会被压扁,实测 26px/行),字体行 `flex: shrink 0`;图片库读取**逐条容错**(getAllKeys + 单条 get,坏记录自愈删除);blob URL 按条目缓存(重建 URL = 播放中断);音频导入 `inferAudioType` 扩展名兜底(File.type 常空);IslandColorPicker 岛内自绘(SV 面黑渐变拆独立 ::after 层、面/条不带边框——见关键约束)。
- **复用件**:QuickMenu(整合按钮 + 悬浮联通展开 + 滚轮逐格 useWheelSteps + WheelSwap 交换动画 + 高亮滑块 + 宽度 scrollWidth 测量过渡;buttonAction='run')/ useLeavingList(离场动画)/ SavedBadge / 设置视图 island-ui-in/out 动画(0.34s 回弹,base.css keyframes 曾缺失致全局静默失效——改动画先确认 keyframes 存在)/ 内容区切换交叉时序。

## 关键约束(容易踩坑)

- **提示文本必须渲染在灵动岛体内部,紧凑态与展开态均不允许超出岛体轮廓**(用户明确要求)。实现:`DynamicIsland` 的 `hint` prop(纯文本)——紧凑态直接注入左侧文字区(与歌名同款字体、同套切换动画),展开态渲染在播放键下方(`island-hint-play`,面板次级文字同款、无气泡)。**禁止**气泡式 Toast UI,也禁止渲染到岛体外(如窗口底部)的提示。
- **透明窗口渲染稳定性**:widget/widget.css 去掉岛体毛玻璃(backdrop-filter 在透明窗口合成不稳)与逐帧 blur(卡顿主因);岛体背景全不透明(rgb(8,10,14));展开面板高度 244px(覆盖组件默认 208px;控制区 flex: none 贴进度条,无居中留白);歌词在挂件版改回文档流(static),歌词行 42px 高(两行 0.78rem×1.4 歌词 + 底部余量,防 j/g/y 下沿裁切)。**垂直居中用 `transform: translateY(-50%)`,不要用 `translate` 属性**(透明窗口下偶发失效导致元素整体偏下,`.island-extra`/`.island-time-particles` 都为此改过)。
- **歌词折叠**:折叠条件 `lyricFold = !lyricShown || (歌词查询完成且无结果)`(查询中保持展开防闪动)。折叠时岛体加 `island-lyric-off` 类,挂件版高度 244→202px;动画为**方向性过渡**——展开用回弹曲线(scaleY 过冲,`cubic-bezier(0.34,1.56,0.64,1)`),收起用无过冲缓动(scaleY 过冲会翻转为负值镜像)。挂件版静态定位,折叠 transform 是纯 `scaleY(0)`(不能带基础版的 translateX(-50%) 居中位移);基础版歌词是绝对定位,只淡出不收高度。
- **歌词查询竞态(useLyrics)**:本地播放器 idle 时 `player.track` 仍指向列表首曲(index 默认 0);外部监听短暂回落本地(externalActive 瞬时为 false)会误用本地首曲发起歌词查询。useLyrics 的响应在应用前按 `lastKeyRef` 校验,过期响应(曲目已切换)一律丢弃,否则旧响应会覆盖新曲目歌词且不会重查。
- 组件内宽度/布局靠 JS 测量 + px→px 过渡(弹簧曲线),文字切换/悬停伸缩/展开收起的时序常量集中在 DynamicIsland.tsx 顶部,改动画同步时两边(CSS transition 与 JS setTimeout)要一致。
- 已知平台限制:QQ音乐等客户端可能不支持 SMTC 跳转/模式控制,点击后 1.2s 检测未生效 → 岛内提示并回退(UI 显示系统真实状态)。
- **SMTC 位置平滑(useSystemMedia)**:浏览器(Chrome/Edge 标签页音频)等平台的上报位置不可信(抖动或**阶梯式过期**——冻结数秒后突然跳变,跟随会抽搐或周期性回跳)。显示进度 = 锚定基准 + 本地时钟流逝,常规轮询不跟随上报位置,仅重锚定于:① 曲目变化(标题 key);② 播放状态变化(暂停冻结在本地时钟位置、恢复继续,均不采信可能过期的上报);③ 位置偏离 > 5s **且**上报位置距上次轮询移动 ≥ 2s("活着"判定,真实外部 seek 才满足;浏览器冻结期移动≈0、更新瞬间偏差≈0,永远不满足);④ **单曲循环折回**:同一首越过时长后按时长取模(QQ 音乐循环不换曲目、时间线常停在结尾,不折回则进度条卡满、右上角计时一直涨);折回后时长末尾 8s 内的上报视为残留不再拉回,时间线真跳回曲首则采信上报。**恢复播放必须重置流逝基准**(`baseAtRef = now`):暂停冻结后 baseAt 停在暂停时刻,恢复时 `position = base + (now - baseAt)/1000` 会把**暂停时长算进去**,恢复瞬间时间突跳、显示比进度条长(用户实测反馈)——轮询 `playChanged && smPlaying` 分支与 `control('play')` 都要更新;乐观切歌(next/previous)base 归零。用户 seek 在 `control()` 内立即乐观锚定,是否生效由**挂起验证**判定(对照系统真实位置,±3s 或单次跳变 >5s 视为生效——后者覆盖浏览器阶梯式更新,其位置块状前进可能永远不在目标 ±3s 内):客户端明确拒绝(`accepted === false`)或 **3s 超时**未跟随(QQ音乐"接受但未跳转")→ 回退显示、判定该平台不支持 seek 并返回 `false`,宿主据此提示。**验证结果按 sourceAppId 持久化**(localStorage `island-seek-support`),切换平台/重启都不重学。暂停点击瞬间由 control() 冻结位置。**歌词定位单独成轨**(`lyricPosition`,与 position 分离):显示进度的 5s 偏离阈值对原生客户端(每秒 +1s)永达不到,锚定后整曲自由漂移——歌词与实际播放偶尔快偶尔慢的根因。lyricPosition 每轮询重算:**上报"活着"(移动 ≥ 0.5s)直接采信上报**;上报冻结本地时钟插值兜底;暂停停最后位置、流逝基准更新到暂停时刻(不把暂停时长计入)。**歌词渲染用 lyricPosition**,进度条仍用 position(平滑优先);本地播放器路径不受影响(player.position 本就准确)。
- **歌词 API 接入点**(2026-08-06):预设厂家(**QQ音乐默认** / 网易云 / 酷我 / 酷狗 / 自定义 URL 模板)+ 设置视图「歌词 API」(`lyric-api` 视图)——`src/media/lyricProviders.ts`(localStorage `widget-lyric-provider`);桥接按厂商实现(QQ base64 解码 / 网易云 / 酷狗明文 LRC / **酷我搜索单引号非标准 JSON 宽松解析 + 歌词接口已封闭 → fallback QQ 歌词兜底** / 自定义)。**按监听平台自动切换** `PLATFORM_LYRIC_MAP`(无公开 API 平台回退手动配置),useLyrics 带 `platformId`;**自动切换开关** `widget-lyric-auto`(默认开);**切换即刷新**(查询 key 含 provider——原 key 只有 title|artist,切厂商不触发查询);**搜索匹配 `pickBestHit` 相似度评分**(标题精确 100/包含 60/前缀 20 + 歌手互含 30,取搜索 10-20 条最优——无脑取首条歌名短/带副标题会对不上)。
- **岛体悬停校准(DynamicIsland 布局 effect)**:点击穿透窗口下 mouseleave 偶发丢失,JS 悬停态(hoveredRef)滞留 → "宽岛无进度条"。布局 effect 每次重算宽度前用 `island.matches(':hover')` 校准,滞留就回落自然宽。
- **渲染模式(2026-08-13 起恢复硬件加速)**:早期 GPU 合成下透明窗口 alpha 偶发突变曾一刀切 `disableHardwareAcceleration`;Electron 43 下恢复硬件加速 + 窗口硬化(`roundedCorners: false`/`thickFrame: false`/`backgroundColor: '#00000000'` 保留)实测稳定。若个别机器 alpha 突变回归:退路 = `disable-gpu-compositing`(保留 GPU 栅格化/解码)或回退 disableHardwareAcceleration(两处注释已写)。改动渲染相关代码**不要重新引入硬件加速依赖的假设**。
- **HEVC(H.265)**:主方案 = 自编译 ffmpeg 软解(apply-hevc-electron.mjs 换装 7 个构建产物,dev.bat 自动);官方 Electron 无解码能力(ffmpeg 无解码器 + media 层门控,TECH.md 10.3)。**补丁版两大致命坑(TECH.md 10.10/10.11)**:① 主进程 `new Notification().show()` + 并发网络 = 段错误(llhttp 崩溃栈是堆损坏殃及表象)——全部通知走 `showNotify`;② 补丁版内置 Node 22 llhttp use-after-free(nodejs#62095)流式 abort 触发——**fetch 不传 signal**,中止判定在 sse.ts parseSse 安全点(read 返回 = 解析已出栈才 cancel)。
- **布局选择器陷阱**:`.island-panel-list` 上**禁止任何 `position: relative` 覆盖**(包括收窄到 `.island-lib-view` 的版本):基类 absolute + inset:0 既是高度约束也是右键菜单定位祖先(absolute 同样建立包含块,relative 对菜单零收益);relative 会**废掉 inset:0 定高**(top/bottom 对 relative 只位移)→ 面板被内容撑高 → 内部滚动容器(flex:1 + overflow-y:auto)高度 = 内容高度永不超高 → 越过岛体 overflow:hidden 被裁且**无法滚动、底部按钮被顶出**——2026-08-10「记忆与进化无法滚动」与 2026-09-22「图片库图片多时无法滚动翻寻并返回」同一根因(后者即当年收窄版残留坑到多媒体库自己);滚动容器还须显式 `min-height: 0`(flex 列表缺省 min-height:auto 不收缩)。右键菜单用面板内相对坐标(absolute + clientX − 面板 rect,fixed 定位在带 transform 的岛体下包含块漂移)。
- **CSS 易踩坑**:0fr 轨道残留 item padding(折叠露内容,padding-bottom 与 grid-template-rows 同节奏过渡);QuickMenu 滚轮 **无条件 preventDefault**(放行会被默认滚动抢走);`scrollWidth` 测内容宽(getBoundingClientRect 读到的是裁剪后宽度,越切越窄);SV 面黑渐变拆独立 `::after` 层 + 取色面不带边框(::after 只盖 padding box 露底色环);`@keyframes` 缺失时 CSS 动画**静默不播**(改动画先确认定义存在)。

## 双岛并存模式(设计文档,未实现)

> ⚠ 全仓库对 `dual` 零匹配(main.cjs `widget:set-mode` 只收 music/agent、无 dual-shot.cjs)。**勿按"已落地"假设推进**;完整设计(组合状态机/模式切换条/潮汐形变/黑洞吸纳/架构要点/选择器陷阱)已存档于 CLAUDE-HISTORY.md 文末「双岛并存模式」。实现时按 screenshot-tests.cjs 先例把组合状态机独立成 `electron/dual.cjs`(main.cjs 已过大)。
