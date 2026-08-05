# 灵动岛桌面挂件 — 实现技术笔记

本文档是挂件的**实现级技术笔记**(面向维护者与想要深入理解实现的人):
架构、数据流、易踩坑点、调试与测试方法。用户使用指南见 [README.md](README.md)。
更细的开发约定(含逐条踩坑记录)见 [CLAUDE.md](CLAUDE.md)。

---

## 目录

- [架构总览](#架构总览)
- [双入口共享组件](#双入口共享组件)
- [数据源双轨(音乐模式)](#数据源双轨音乐模式)
- [SMTC 桥接](#smtc-桥接)
- [Electron 主进程](#electron-主进程)
- [歌词系统](#歌词系统)
- [Agent 引擎](#agent-引擎)
- [Agent 渲染端与 UI](#agent-渲染端与-ui)
- [调试工具与测试](#调试工具与测试)
- [打包与发布](#打包与发布)
- [已知技术债务](#已知技术债务)

---

## 架构总览

```
┌─────────────────────────────────────────────────────────┐
│                     Electron 主进程                       │
│  main.cjs:窗口 / 托盘 / 点击穿透 / 右键拖拽 / 模式切换 / IPC │
│                                                         │
│  ┌──────────────┐      ┌──────────────────────────────┐ │
│  │ SMTC 桥接     │      │ Agent 引擎(agent.cjs)          │ │
│  │ bridge.cjs   │      │ provider / tools / mcp /      │ │
│  │ (utilityProcess│     │ skills / memory / evolution  │ │
│  │  崩溃自动重启)  │      └──────────────────────────────┘ │
│  └──────┬───────┘                                        │
└─────────┼────────────────────────────────────────────────┘
          │ HTTP 127.0.0.1:8765(状态/控制/歌词代理)
┌─────────┴────────────────────────────────────────────────┐
│                     渲染进程(挂件)                         │
│  WidgetApp → useSystemMedia / useMediaPlayer / useLyrics  │
│  → DynamicIsland(两端共享岛体组件)→ AgentView / Settings  │
└──────────────────────────────────────────────────────────┘
```

- **主进程内运行 Agent 引擎**(非 utilityProcess):纯异步网络/文件 IO。
- **SMTC 桥接走 utilityProcess**(`electron/bridge.cjs`),崩溃自动重启
  (10s 内 3 次上限)。
- 渲染端与桥接/引擎之间全部走 `http://127.0.0.1:8765` 与 IPC
  (`window.desktop.*` + `agent:*` 事件)。
- 整个项目**零第三方运行时依赖**(React 之外无 UI 库;Agent 引擎为
  手写零依赖实现,esbuild 打包)。

---

## 双入口共享组件

- `src/` — Web 演示版入口(vite.config.ts),带完整演示页面。
- `widget/` — 桌面挂件入口(vite.widget.config.ts,`mode=widget`),
  只渲染灵动岛本体;`base='./'` 使产物可直接 file:// 加载。该构建模式下
  `src/media/tracks.ts` 返回空内置歌单、产物剔除 music 资源
  (**必须带 --mode widget,否则内置三首 MP3 会打进挂件歌单,而音频文件
  又被 closeBundle 删掉 → 播放列表出现"无法播放且无法删除"的损坏曲目**)。
- **`src/components/DynamicIsland/DynamicIsland.tsx` 是两端共享的岛体组件**,
  行为差异全部靠 CSS 覆盖(`widget/widget.css` 的 `.widget-stage` 选择器)
  与可选 props 区分。改动组件时必须同时考虑 Web 版(App.tsx)与挂件版
  (WidgetApp.tsx)两个调用方。
- `tsconfig.app.json` include 含 `src` + `widget`;`pnpm build` 的 `tsc -b`
  会检查两端。

---

## 数据源双轨(音乐模式)

`WidgetApp` / `App` 中 `useSystemMedia`(SMTC 外部平台)与 `useMediaPlayer`
(本地播放器)并存,`externalActive = system.active && system.track && useExternalSource`
决定数据与控制走哪一边。

### 切换语义

- 切换数据源时**双向暂停**(切走的一方自动暂停,避免双声齐响)。
- 进度 / 时长 / 播放模式 / 曲目都按当前数据源分支取数。
- SMTC 播放模式以系统真实状态为数据源(轮询校准);点击循环后 1.2s 检测
  是否跟随,没跟随则提示并回退。

### 位置平滑(useSystemMedia)

浏览器(Chrome/Edge 标签页音频)等平台的上报位置不可信(抖动或**阶梯式过期**:
冻结数秒后突然跳变,跟随会抽搐或周期性回跳)。模型:

- **显示进度 = 锚定基准 + 本地时钟流逝**,常规轮询不跟随上报位置;
- 重锚定仅于:① 曲目变化(标题 key);② 播放状态变化(暂停冻结在本地时钟
  位置、恢复继续,均不采信可能过期的上报);③ 位置偏离 > 5s **且**上报位置
  距上次轮询移动 ≥ 2s("活着"判定——真实外部 seek 才满足;浏览器冻结期
  移动≈0、更新瞬间偏差≈0,永远不满足);
- **恢复播放必须重置流逝基准**(`baseAtRef = now`):否则暂停时长会被算进
  `position`,恢复瞬间时间突跳(实测 bug,用户反馈);
- 乐观切歌(next/previous)base 归零。

### seek 支持记忆

用户 seek 在 `control()` 内立即乐观锚定,是否生效由**挂起验证**判定
(对照系统真实位置,±3s 或单次跳变 >5s 视为生效——后者覆盖浏览器阶梯式
更新);客户端明确拒绝或 **3s 超时**未跟随(QQ音乐"接受但未跳转")→ 回退显示、
判定该平台不支持 seek。**验证结果按 sourceAppId 持久化**
(localStorage `island-seek-support`),切换平台/重启不重学,已记忆的平台
零等待直接拒绝/放行。

### 歌词定位单独成轨(lyricPosition)

显示进度的 5s 偏离阈值对原生客户端(每秒 +1s 上报)永达不到——锚定后整曲
自由漂移,歌词与实际播放"偶尔快偶尔慢"的根因。因此:

- `useSystemMedia` 暴露**第二个位置轨道 `lyricPosition`**,每轮询重算:
  - 上报"活着"(移动 ≥ 0.5s,原生客户端每秒 +1s 天然满足)→ **直接采信
    上报位置**(1s 粒度对歌词行切换足够,杜绝漂移);
  - 上报冻结(浏览器阶梯式过期)→ 本地时钟插值兜底(平台实际在播);
  - 暂停停最后位置、流逝基准更新到暂停时刻(恢复后若上报未立即解冻,
    插值从暂停时刻继续,不把暂停时长计入);
- **歌词渲染用 lyricPosition**(useLyrics 第三参),**进度条仍用 position**
  (平滑优先);本地播放器路径不受影响(player.position 本就准确)。

---

## SMTC 桥接

`scripts/system-media-bridge.ts`(esbuild)→ `electron/bridge.cjs`。

- 读取端为 `electron/smtc-reader.ps1`,运行时用 `csc.exe` 编译
  `electron/smtc-bridge.cs`(Windows 11 26100 新版 API,引用
  System32\WinMetadata 契约 + System.Runtime facade),异步等待用轮询
  Status/GetResults(3s 超时防卡死)。
- **PS 5.1 无法绑定 WinRT 集合元素(__ComObject)**,所以必须走 C# 强类型桥接。
- 新版 API 差异:GetGlobalPropertiesAsync → TryGetMediaPropertiesAsync、
  GetPlaybackInfo/GetTimelineProperties 同步化、新增
  TryChangeAutoRepeatModeAsync/TryChangeShuffleActiveAsync。
- 桥接以 `utilityProcess` 启动,崩溃自动重启(10s 内 3 次上限)。

---

## Electron 主进程

### 窗口

- 透明无边框窗口 + `setIgnoreMouseEvents` 点击穿透:`widget-stage`(岛体)
  mouseenter/leave 经 IPC `widget:pointer` 切换"接收鼠标"。
- `app.disableHardwareAcceleration()`(避免半透明 alpha 突变)——改动渲染
  相关代码**不要重新引入硬件加速依赖**。
- 岛体背景全不透明(rgb(8,10,14));挂件版去掉毛玻璃(backdrop-filter 在
  透明窗口合成不稳)与逐帧 blur(卡顿主因)。

### 右键长按拖拽(移动挂件)

按住右键 ~0.4s(位移 < 8px)进入拖拽模式后拖动;快速右键点击/拖动无效果。
渲染端指针捕获 + IPC(`widget:drag-start/move/end`)→ 主进程
"窗口 = 鼠标 - 按下偏移"绝对定位,位置自由(不限制在屏幕内)。防漂移三件套:

1. 拖拽激活基准用长按期间的最新坐标(不是按下点,消除手抖偏移);
2. 渲染端 <0.5px 容差去重(窗口移动合成的亚像素事件不发送);
3. 主进程 setPosition 后校验实际落点,不一致就重算偏移(自校正,不累积
   相对偏移)。

**异常防线**:所有拖拽坐标过 ±10 万合理范围校验(真实屏幕坐标不可能超出),
非有限值或超界一律丢弃并打日志——`setPosition` 的 int32 参数转换对超界
有限值(|v| ≥ 2^31)会抛未捕获异常,绝不能把脏数据传进去。拖拽期间穿透
保持接收(鼠标移出岛体也持续响应),松手按指针位置恢复穿透。进度条/文字
手势均加 `button !== 0` 守卫,右键只属于拖拽。

### 配置与持久化

| 数据 | 位置 |
| --- | --- |
| 窗口置顶 / 模式 | `userData/settings.json`(仅 alwaysOnTop / mode) |
| 主题色 | localStorage `widget-theme-color` |
| 上传音乐 | IndexedDB `island-uploads` |
| 自定义背景图 | IndexedDB `island-background`(store 'library') |
| 背景透明度 / 裁切 | localStorage `widget-background-opacity` / `widget-background` |
| 自定义字体文件 | IndexedDB `island-font`(data URL,10MB 上限) |
| 字体参数 | localStorage `widget-font`(currentFontId / colorMode / colorValue) |
| 歌词源配置 | localStorage `widget-lyric-provider` / `widget-lyric-auto` |
| 文字颜色 | CSS 变量 `--text-color` / `--text-dim` 注入岛体 |

窗口位置每次启动顶部居中,不持久化。

**卸载删数据**:electron-builder.yml `nsis.deleteAppDataOnUninstall: true`,
NSIS 卸载器确认卸载后连同 `%APPDATA%\dynamic-island` 一并删除
(打包后 userData 目录名 = package.json 的 `name`,不是中文 productName)。
electron-builder 26 辅助安装不生成独立"卸载"快捷方式,由
`nsis.include: electron/nsis-custom.nsi` 补齐(customInstall 创建
「卸载 灵动岛挂件.lnk」,customUnInstall 卸载时删除)。

### 拖拽交互之外的守卫

- Agent 模式屏蔽单击岛体/点外/Esc 缩回(只保留长按收回 + 视图内交互区
  拦截左键 pointerdown 防误触,右键放行拖拽)。
- 设置类视图(settings/background/theme/help/font/font-color/font-library/
  image-library/agent-settings/lyric-api)一律屏蔽一切缩回操作,只能返回键退出。

---

## 歌词系统

`src/hooks/useLyrics.ts` + `src/media/lyricProviders.ts`。

- 查询 key = `provider|title|artist`(含 provider:切厂商即时重查,不含则
  需重播才有新歌词——实测 bug);响应按 `lastKeyRef` 校验,过期响应丢弃
  (外部监听短暂回落本地时误用本地首曲查询的竞态)。
- **预设厂家**:QQ音乐(默认,client_search_cp 搜索 songmid +
  fcg_query_lyric_new,**歌词字段 base64 解码**)/ 网易云(search/get/web +
  song/lyric)/ 酷狗(songsearch_v2 搜索 FileHash + m.kugou.com 明文 LRC)/
  酷我(search.kuwo.cn 返回**单引号非标准 JSON**,宽松替换后解析;
  歌词接口 m.kuwo.cn 已封闭 → **fallback 到 QQ 歌词兜底**)/ 自定义
  (LRC 文本或 {"lrc"} JSON,{title}/{artist} 占位)。
- **按监听平台自动切换**(默认开):`PLATFORM_LYRIC_MAP`
  (qqmusic→QQ / netease→网易云 / kugou→酷狗 / kuwo→酷我);浏览器等无公开
  歌词 API 的平台不映射,回退手动配置。
- **搜索匹配增强**:`pickBestHit` 相似度评分(标题精确 100/包含 60/前缀 20
  + 歌手互相包含 30),无脑取首条在歌名短/带副标题/歌手缺失时会对不上。
- 歌词代理走本地桥接(`/system-media/lyric`,Node 服务端无 CORS 限制)。
- 歌词查询中保持展开防闪动(lyricFold 折叠条件)。

---

## Agent 引擎

架构参照 opencode 源码(message parts 模型 / LLM 流式循环 / 工具注册语义)
与 MS Agent 参考后端(单 agent ReAct 循环,砍掉 multi-agent pipeline)。

### 引擎循环与状态

- `electron/agent/*.ts` → esbuild 打包 `electron/agent.cjs`(零第三方依赖,
  `electron` external;入口 engine.ts,evolution 经 re-export 打进同一产物)。
- **无状态**:渲染端每次 send 回传完整历史(参考后端"客户端持有历史"模式)。
- 循环:流式 → 有 function_call 则逐个执行(60s 兜底超时,失败结构化回填
  供 LLM 自纠)→ 回填历史续调,**迭代上限 25** 防死循环(原 10 轮实测太紧,
  用户反馈"试错成本太低"→ 放宽;上下文增长由 trimHistory 预算治理兜底)。
- **并行工具执行**:一轮多个工具调用 `Promise.all` 并发(结果按调用顺序
  回填,UI 卡片顺序一致;抽共享 `executeToolBatch`);`delegate` 子代理 =
  嵌套 agent 循环(独立上下文,事件静默,reasoning 仍累积满足回传要求)。
- 工具结果截断 8000 字符回填上下文。
- **预算治理**:`trimHistory` 按 token 粗估(中 1/字、英 4 字符/token,
  系数 0.6)裁剪历史,上限 200K、至少留 10 条,仅超限触发(不断缓存前缀);
  `max_output_tokens: 4096`(含思维链 token)。

### Provider 自动判定

`detectProvider`(provider.ts,engine 与 evolution 共用):地址含 "anthropic"
→ Anthropic Messages;含 "chat" → DeepSeek Chat Completions(备选);否则
(**默认**)→ DeepSeek Responses API。两个 provider 同构返回
`ProviderOutcome {calls, text, usage, aborted}`,引擎循环共用。

**DeepSeek Responses API(默认)**:裸 fetch + SSE,顶层参数 model / input
(字符串或 item 列表)/ instructions / stream / max_output_tokens /
tools / tool_choice / reasoning / text.format / temperature·top_p。
- `reasoning.effort` 值域:none / minimal / low / medium / high / xhigh /
  max(none = 关闭思考,设置页"思考强度"的"关");不传用模型默认(开启)。
- `text.format`:text(默认)/ json_object(JSON 模式,prompt 需含 "json"
  字样)/ json_schema(结构化输出)——总结标题走 json_object。
- 输入 items:message(角色 user/assistant/system/developer 视同 system;
  content 仅 input_text/output_text,**reasoning 内容块 400** "unknown
  variant" 实测)、function_call(call_id 必填唯一,每个 call 必须有对应
  function_call_output)、function_call_output(output 字段)、
  **reasoning(明文 content 归并相邻 assistant 消息;必须回传,缺失 400**
  "The reasoning_text in the thinking mode must be passed back")、
  web_search_call(原样回传自动恢复搜索结果)。
- usage:`input_tokens_details.cached_tokens`(上下文缓存命中)/
  `output_tokens_details.reasoning_tokens`(思维链 token)。
- **上下文硬盘缓存(DeepSeek 自动开启)**:请求前缀**完整匹配缓存前缀单元**
  才命中;多轮对话天然命中(完整历史回传 = 前缀递增)。**前缀必须稳定**:
  instructions 与历史序列化幂等、tools 顺序固定、reasoning item 固定回传,
  任何序列化抖动都会断缓存。命中价 0.02 元 vs 未命中 1 元(50 倍)。

**Anthropic Messages API**(`streamAnthropic`):x-api-key 鉴权
(anthropic-version 被忽略,保留头兼容原生);适用于 DeepSeek Anthropic
兼容端点或原生 anthropic.com;max_tokens 必填 4096;模型名 claude 前缀
由 DeepSeek 自动映射。格式已对照官方兼容性表:角色严格交替(相邻同角色
合并)、工具结果打包进下一条 user 消息的 tool_result 块、同一条助手消息
tool_use 之后不能再有文本、工具参数为流式 JSON delta、thinking 块需
signature 不可回放(已丢弃)。

### 工具系统(模块化)

`{name, description, parameters(JSON Schema), execute}` 注入 LLM 上下文
(LLM 据此生成参数,过程全程可知——执行前 tool-call 事件展示完整参数,
结果 tool-result 事件回显)。v1 工具:

| 工具 | 关键实现点 |
| --- | --- |
| exec_command / read_file / write_file / list_dir | 无沙箱;`tools.ts` 的 fs 只用 `promises as fs`,existsSync 在主模块(promises 没有 existsSync,实测报错) |
| open_url / open_file / web_search / get_time / system_info / notify | web_search 必须 **Bing 主用、DDG 回退**(duckduckgo 在中国不可达,实测 fetch failed) |
| bili | 调本机 bili-tool,**下载 cwd 固定 BILI_CWD**(不固定会落在 Electron 启动目录,用户和 LLM 都找不到,实测);完成通知与后台任务状态注入,绝对路径约定(LLM 准确告知"视频在哪个文件夹") |
| doc_convert | 对接本机 DocFlow 服务 http://127.0.0.1:5000(需先 `python server.py` 启动):探测 → multipart 上传 → /api/convert → 轮询 → 下载 |
| xxt | 超星学习通自动答题(spawn python 调 auto_answer.py,login 300s 超时其余 180s) |
| switch_to_music | 切回音乐模式(来源语义见"模式切换") |
| mcp_config / skills_config | LLM 自然语言自我配置(list/add/remove/test;写配置经 applyAgentConfigPatch 校验;新增服务/目录下一轮对话起生效) |
| remember / forget / list_memory / update_memory | 长期记忆读写(对话"记住:…"即沉淀) |
| evolve_memory | 触发记忆进化(后台任务语义) |
| delegate | 子代理(独立上下文,任务必填) |

### 模式切换的对话中止语义

托盘/手势切换(mode 'user')切回音乐时**中止当前轮**;Agent 工具
`switch_to_music`(source 'tool')属于对话流程——切回音乐时**不中止**正在
运行的本轮(引擎完成回复并落定消息;若中止,最终回复被丢弃,历史停在
未答复的用户消息,下一轮 LLM 把旧请求当"仍待执行"重复执行 = 上下文污染,
实测"打开B站"时又被自动切回音乐模式)。

### 静默总结标题

独立的总结后台 Sub Agent(`createSummaryAgent`,主进程独立单例,与主对话
引擎**零共享**——独立实例/AbortController/每次调用独立读配置;主对话的
发送/中止/清空/模式切换都打不断总结):

- 系统提示"对话标题生成器,**≤8 个汉字**"(紧凑态文字区约 6-9 字,长标题
  被岛体截成"开头几字"观感等同总结失败,实测);**强制 low effort 加速**;
- **45s→90s 超时**失败返回空串;输入压缩:最近 12 条消息,reasoning 截
  500 字、工具结果截 2000 字、tool-call 参数递归截 200 字;
- **json_mode 三级降级链**:JSON 措辞 A → 措辞 B → 纯文本兜底,每级最多
  尝试 2 次(调用失败重试一次后进入下一级),每级 noThinking(effort 'none');
- `sanitizeTitle`:去首尾引号/书名号 + 按 code point 截 10 码元;
- **每轮回复完成后自动总结**(message 事件落定即触发,后台静默),结果存
  `currentTitle`(localStorage `widget-agent-title`),紧凑态 idle 时优先
  显示标题;**会话版本号防竞态**(`sessionVersionRef`,仅 clear/loadSession
  时递增);排队追平(in-flight 时标记 pending,完成后补跑最新一轮);
  失败重试 1.5s 后同快照重试(retryLeft 预算 1),预算耗尽 10s 后补跑一次
  最新消息(仅此一次不连锁)。

### MCP 服务接入(零第三方依赖手写客户端)

- **双传输**:stdio(JSON-RPC 2.0、stdin/stdout **每行一条消息**——非 LSP
  的 Content-Length 帧)/ sse(GET 事件流 + POST 回传端点,ping 忽略);
  握手统一:initialize(2024-11-05)→ notifications/initialized → tools/list;
- **常驻进程/流复用**(参考 opencode internal/llm/agent/mcp-tools.go 的
  配置同构,但 opencode 每次调用独立连接,本项目连接一次反复调用,
  崩溃自动重启,调用间零握手开销);
- 工具命名 `mcp_<服务名>_<工具名>`(仅 [a-z0-9_],重名加序号);
  inputSchema → parameters(非 object 模式包一层 input 字段);结果 content
  文本块拼接、图片/二进制只标注大小不塞 base64、截 8000;
- **连接互斥 connectPromise**——并行工具调用(Promise.all)/delegate 子代理
  并发会对同一服务并发 connect,不加锁会拉起两个进程、旧进程泄漏挂起;
- **Windows cmd 宿主**:npx/npm 等 .cmd 命令必须经 `cmd.exe /d /c` 启动
  (CreateProcess 无法直接执行 .cmd);cmd /c 会把参数里的 `%VAR%` 当环境
  变量展开,路径含 % 需加引号;销毁走 `taskkill /pid /T /F` 连进程树。

### 技能系统

- 扫描 skillsDirs(目录内含 SKILL.md,frontmatter name/description + 正文
  使用文档);默认扫描源:`~/.claude/skills`、`~/.codex/skills`、
  `~/.config/opencode/skills`、`userData/skills`(挂件自有);
- 每个技能注册 `skill_<slug>` 工具(slug 仅 [a-z0-9-],重名加序号,
  **扫描按目录名字母序排序**——readdir 顺序不保证,同技能集不同运行
  工具名不同,破坏 LLM 工具记忆与缓存前缀);
- 调用时 SKILL.md 全文注入上下文(截 8000)+ 技能目录绝对路径;
  每次 listTools 实时重新扫描(配置变更即时生效);
- **技能排除**(`agent.excludedSkills`):LLM 对话 `skills_config` 的
  exclude/include + 设置界面逐条移除/恢复;
- **自然语言创建**:`skills_config` create action——LLM 提供
  name/description/content,引擎规范化写入 `userData/skills/<slug>/SKILL.md`,
  下一轮起可用(同名冲突基于实时扫描,overwrite=true 可覆盖);
- **技能分区**:sourceKind = created(灵动岛创建)/ imported(手动导入,
  目录有 .island-imported 标记)/ scanned(外部目录),设置界面三区展示;
  导入 = 选择技能包文件夹(fs.cpSync 整目录,排除 .git)或单个 .md 文件;
- **delegate 子代理继承外部工具**(tools 参数限制子集时只给列出的);
  技能工具无参数。

### 长期记忆系统

- 结构化长期记忆存 **userData/memory.json**(与 settings.json 分离:高频
  变更不污染配置,损坏不影响配置);条目 = `{id, type: preference|fact|
  workflow|lesson, content, source: manual|agent|evolution, createdAt,
  updatedAt}`,上限 200 条、单条 500 字,写盘串行队列防并行竞态;
- 系统提示拼装:`自定义提示词 + 记忆块(按类型分组、截 6000)+ 进化状态 +
  后台任务状态`(静态段——变更才断缓存前缀);
- **并发加载竞态**(实测缺陷):并发 add 同时触发 load,后完成的 catch 清空
  刚 push 的条目(loadPromise 互斥)。

### 自我进化 harness

按 [penguin-harness](https://github.com/Prism-Shadow/penguin-harness) 的
agent-optimization 技能与 snapshot-service 重构(本地参考仓库
`C:/Users/asus/Desktop/penguin-harness`):

- **评估委托独立 Sub Agent**(`createEvaluatorAgent()`,独立
  AbortController/60s 超时/失败自动重试一次/事件静默)——优化流程自身
  不直接调 LLM 评分(借鉴 penguin"评估必须委托子代理"语义);
- **版本化快照**:每个**接受**的版本存档
  `userData/memory-snapshots/v<N>.json`(同版本不重复打包);`memory-state.json`
  持久化当前版本号/评分;**回滚只到已接受版本**(防降级);
- **Reference 语义**:当前已接受版本 = Reference,每轮构造候选,接受后
  成为新 Reference;**假说驱动**:评审建议必须带 hypothesis(预测的可观察
  行为变化),无假说的建议一律不采纳(评估侧只给公开记忆内容,黑盒打分
  防自评偏差);
- **多轮候选循环**:每轮 评审(rubric = 冗余/一致/时效/可操作/价值,
  总分 0-100)→ 确保 Reference 快照 → 应用候选 → 复评(独立调用)→ 棘轮
  (新分**严格高于**原分才接受;否则从快照恢复)——轮数预算 rounds
  (默认 2 上限 4),评分 ≥92 达标提前停,LLM 调用失败不消耗轮数;
- **CONTRACT**:进化只改记忆(可编辑资产),不触碰引擎/工具代码;
- **后台任务语义**:完成发系统通知 + 状态注入系统提示(getStatus 块,
  LLM 对话中可感知进化结果);日志 evolution.json(上限 20 条,设置界面
  展示 + 回滚);「清除所有版本」= 删快照目录/日志/state,回 v1 初始状态。

### 手动调用(/ 与 @)

输入以 `/` 开头 = 调技能(完整名/去前缀/模糊唯一命中),`@` 开头 = 调 MCP
工具(如 `@mcp_filesystem_read_file`);引擎在循环前先执行工具,剩余文本是
合法 JSON 对象则作参数,结果以 tool-call/tool-result parts 入历史(事件
照常转发,UI 工具卡片一致);多命中/未找到给可读提示。输入框候选列表:
`/` 或 `@` 时浮出(最多 6 条,按输入 token 过滤)——↑↓ 导航 / Enter 选中
(替换前缀命令,不发送)/ Esc 关闭 / 点击选中。**数据源过滤**:
技能 = `skill_` 前缀;MCP = `mcp_` 前缀且名称含第二个下划线(内置工具
mcp_config 恰好以 mcp_ 开头,用双下划线区分——外部 MCP 工具名必有
`mcp_<服务>_<工具>` 两段,实测 @mcp_config 混入候选)。

### IPC 与渲染端状态机

- `agent:send(text, history)` / `agent:abort`;引擎事件经 `agent:event`
  转发;`agent:config-get/set`(agent 段配置,LLM 自我配置工具同用
  applyAgentConfigPatch 校验);`agent:tools` 异步(listAllTools = 内置 +
  MCP + 技能);`agent:mcp-test`;`agent:memory-get/set` / `agent:memory-export`;
  `agent:evolve` / `agent:evolution-log` / `agent:evolution-rollback` /
  `agent:evolution-reset`;`agent:summarize`(走 getSummaryAgent());
  `agent:skill-import`。
- `useAgent` 状态机: idle / thinking / running / error;流式累积未落定
  消息、`message` 事件为权威落定,中止丢弃流式消息;历史持久化
  localStorage(`widget-agent-messages`,**直接同步写不防抖**——防抖 300ms
  在页面刷新/渲染进程重启时会丢最后几秒消息,实测)。
- **历史契约**:send 回传的 history 末尾**即当前轮用户消息**——引擎不再
  追加(仅历史缺尾时防御性补一条);上一轮被中止/失败(历史以 user 消息
  结尾)时,新输入**合并进该未答复的用户消息**(防连续 user 消息污染)。
- **配置刷新**:useAgent 的 config 只在挂载时读一次——LLM 对话中写的配置
  设置界面看不到(实测 bug);切到 agent-settings 视图前触发
  `refreshConfig()`(不能在 AgentSettingsView 挂载后刷新:异步返回会重置
  用户正在编辑的表单,实测)。

---

## Agent 渲染端与 UI

### 面板与高度自适应

- 岛体高度 = `--agent-h` 变量驱动(AgentView 用 scrollHeight 测量内容
  自然高,clamp [200, 600];消息列表 max-height = `calc(var(--agent-h) -
  116px)` 与 AGENT_PANEL_FIXED_H 同源),窗口经 `onAgentPanelHeight`
  动态跟随(岛体 + 40,<4px 不 resize),收起回落 280;
- 流式回复中 80ms trailing 节流(逐字增长时高度瞬跳 + 低频重排,防卡);
- **展开首帧两阶段骨架屏**(AGENT_PHASE_IN_MS=120):骨架期不测量(保持
  岛体下限),延迟后挂载真实内容淡入并测量长高——形变动画期间 DOM 极小,
  展开更顺;
- **动画性能(易踩坑)**:① 流式回复中高度**禁用过渡**(`.island-agent-
  streaming` 去掉 transition 里的 height)——逐字增长时每帧启动 0.22s
  过渡 = 过渡永不稳定 + 每帧布局重排,是"加载文字卡"主因;② agent 面板
  进入动画改纯淡入(maskPanelIn);③ 收起为**单动画**(宽度/高度同时收缩 +
  压感回弹同 tick)——两阶段被用户否决;④ **Agent 模式禁用长按收回**
  (收起唯一入口 = ⋯ 菜单"收起面板");⑤ 展开宽度过渡用**无过冲缓动 0.3s**
  (紧凑 100px → 展开 400px 大跨度弹簧过冲在软件渲染下抖动明显);
- **输入框贴底**:消息列表 `flex: 1 1 auto` 拉伸填满剩余空间(内容不足时
  输入框贴底、欢迎语 margin auto 居中);
- **进入对话面板自动滚动到底**:自绘非线性滚动(easeInOutQuart 先加速再
  减速 + 动态高斯模糊按速度占比二次衰减——模糊是长消息列表滚动动画的
  性能优化);**新对话无历史消息不模糊**(smoothScrollTo 增 blur 参数,
  按 messages.length 经 ref 判定);**对话中发送跳转最新消息也不模糊**
  (send 路径 blur=false,实测对话中每次发送都触发模糊观感不佳)。

### 头部 ⋯ 菜单与快捷切换按钮

- ⋯ 下拉菜单:停止生成(运行中)/ 新对话(有历史时)/ 对话历史 / 工具列表 /
  收起面板;点外自动关闭(menuRef.contains 判定)。
- **快捷切换按钮**(`.island-agent-quick`):悬浮 ⋯ 时左侧浮现,默认显示
  "收起面板"(末项),滚轮在菜单各入口间逐格循环切换,单击执行当前项并
  复位默认;
  - **悬停不断开**:透明命中区自 ⋯ 左缘向左延伸(绝对定位,不参与头部
    布局),覆盖 8px 间隙——鼠标从 ⋯ 横移到按钮的过程始终处于容器
    `:hover` 内,按钮不消失;
  - **滚轮逐格步进**(共用 `useWheelSteps` 钩子,快捷按钮与记忆类型按钮
    手感一致):每 60px 一步(行模式 ×33)、步间 ≥100ms 冷却、350ms 无滚动
    重置累积——快速滚动也逐格推进,不连跳;
  - **内容交换动画**(`WheelSwap` 组件):旧内容滑出淡出 0.2s + 新内容回弹
    滑入 0.3s(`cubic-bezier(0.34,1.56,0.64,1)` 轻微过冲,与 island-ui-in
    同款),方向随滚轮(向前新内容自下而上);`.swap` 类仅在 tick>0 后加
    (首帧挂载不播动画);边框柔和强调 flash(强调色 45% 混底色,0.3s);
  - 菜单打开时(.open)隐藏(弹出面板已展开,快捷按钮冗余);
  - 菜单项与快捷按钮共用 menuItems 数组(条件项随 busy/messages,索引
    ref 跨渲染同步、渲染时钳制有效范围)。

### 记忆类型按钮的滚轮切换与页面滚动

- 添加框左侧类型按钮:**直接在本体按钮上滚轮**逐格循环切换
  (偏好/事实/工作流/教训),下拉菜单保留(点击展开,展开时不响应滚轮);
- **原生非 passive 滚轮监听吞掉默认滚动**:设置页是滚动容器,React
  onWheel 为 passive(preventDefault 无效)——悬浮在类型按钮上切换类型时
  页面不会跟着滚(下拉展开时放行)。

### 界面放大

100%/150%/200% 预设 + 自定义 100-300%,localStorage `widget-agent-scale`;
只放大面板/窗口尺寸,**UI 元素(文字/按钮/气泡)不缩放**(用户明确要求)。
实现:宽度 = expandedWidth × 缩放(JS,`.island-agent-view` 与
`island-agent-settings-view` 都要 `max-width: none` 放开 500px 上限),
高度仍由内容驱动(--agent-h,不乘缩放),面板本身不 transform/zoom;
窗口经 `onAgentPanelSize` / `onAgentPanelWidth` → IPC `widget:set-size`
跟随。

### 对话历史 / 工具列表视图

- 历史:标题 = 首条用户消息前 24 字,时间 = 今天 HH:MM / 昨天 / M月D日,
  点击加载 = 替换当前对话并从历史移除,行内删除**带离场动画**(高度折叠
  到 0 + 淡出上移 + 负 margin 抵消 gap,列表平滑上移无跳变,0.24s 后真正
  删除;多行可同时离场);
- 工具列表:引擎 `listTools()` 暴露名称/描述/参数 schema(卡片可展开);
- **预览框随岛体、可滚动**:tools/history 视图**不参与高度测量**
  (measureHeight 对 view === 'tools'/'history' 直接 return)——岛体高度
  保持进入前的聊天高度,列表在剩余空间滚动(进入前岛体越小预览框越小,
  聊天深入后预览框随之扩展)。

---

## 调试工具与测试

### 截图与巡检

- `WIDGET_SCREENSHOT=<path>` 加载后自动截图;`WIDGET_SCREENSHOT_QUIT=1`
  截图/巡检完成后优雅退出(app.quit)——**必须带**:应用托盘常驻不自退,
  测试命令若用 timeout/taskkill 强杀进程树,子进程(bridge/GPU/renderer)
  被杀会打出 `renderer gone: crashed` 假象(实测误导)。
- `WIDGET_SCREENSHOT_MODE`:
  - `expanded` / `layout`(输出面板各区域几何 JSON,验证布局用)/ `theme` /
    `stress` / `test`;
  - **`agent`**(Agent 功能严格 UI 巡检,两段式):
    段 1 进视图截图(`.agent1.png`);段 2 交互断言 JSON——MCP 双传输编辑 +
    真实连接 mock 服务器(env `WIDGET_MOCK_SERVER` 指向
    mock-mcp-stdio.cjs)→ 技能目录/移除/恢复 → 记忆增删 → **记忆类型按钮
    本体滚轮切换断言**(合成 `new WheelEvent('wheel')` 即可驱动 React
    onWheel——deltaY 符号与 DOM 一致;注意按钮每格重挂载,**每次操作后
    重新查询 DOM**,旧引用指向已卸载节点派发/读取都失效,实测)→ 进化触发
    → 保存 → 返回收起;段 4.5 **快捷切换按钮用 `sendInputEvent` 注入
    真实鼠标**(合成 MouseEvent 不触发 CSS :hover):悬浮 ⋯ → 浮现断言 +
    截图(`.agent-quick.png`)→ 横移过间隙中点不断开 → 双向滚轮逐格断言
    (期望序列由 DOM 推断的 menuItems 计算;**sendInputEvent 的 deltaY 符号
    与 DOM wheel 事件相反,实测 +120 → 反向一步**,正向注入 -120)→ 单击
    跳转断言;段 4 末停在对话历史视图,段 4.5 开头先返回聊天视图——也
    修复了段 5 自动回复在错误视图轮询的既有问题;段 5:后台任务完成自动
    回复全链路(真实 API)。

### 测试

- `node scripts/test-agent-core.mjs`(40 断言,后端直测不经 UI):esbuild
  打包测试 bundle(`electron` 别名 stub,Notification 记录到
  `global.__notifications` 供断言),mock MCP 服务器(`scripts/test-agent/`):
  stdio(新行 JSON-RPC,含自杀/慢响应/错误/图像工具)+ sse(GET 事件流 +
  POST 回传)。**测试抓到的真实缺陷(均已修)**:① MCP JSON-RPC id 错位
  (requestImpl 递增 nextId 而 send 回调重读 nextId → 改为把 id 传给
  send);② 技能重名分配不确定(→ 扫描按目录名字母序排序);③ 记忆并发
  加载竞态(→ loadPromise 互斥)。
- 实机验证约定:每次修改后 `pnpm dev:widget` 实机验证 + `tsc -b` +
  `pnpm lint`;`pnpm dist:win` 只在用户明确要求时执行。

---

## 打包与发布

```bash
pnpm dist:win   # = build:widget + build:electron + electron-builder --win
```

- 输出:便携版 + NSIS 安装版 → `release/`。
- 打包内容只含挂件页面与 Electron 侧脚本(不含演示页面与源码)。
- 桥接的 PowerShell 读取脚本与 C# 桥接源码放 **asar 外**(asar 内文件
  无法被 powershell/csc 直接打开);桥接进程避免从 asar 内 fork
  (asarUnpack: bridge.cjs)。
- `electronDist: node_modules/electron/dist`(直接复用本地已解压的
  Electron,跳过 zip 下载/解压——安全软件实时监控会锁住新解压的
  electron.exe 导致目录重命名失败)。
- 图标:项目根 `icon.png` 优先,`make-ico.cjs` 生成 16~256 多尺寸 ICO
  供 electron-builder 直接嵌入(绕过其 png→ico 转换缓存问题)。
- NSIS:oneClick false、可选安装目录、开始菜单快捷方式(「灵动岛挂件」
  与自定义 NSIS 脚本补的「卸载 灵动岛挂件」)、卸载删数据
  (`deleteAppDataOnUninstall: true`)。

---

## 已知技术债务

- 主题色 localStorage 与上传数据 IndexedDB 分开存储,卸载删数据由 NSIS
  保证(便携版手动删除 `%APPDATA%\dynamic-island`)。
- Agent 引擎为手写零依赖实现,协议细节(Responses items / Anthropic
  兼容)随上游 API 演进需跟进维护;核心测试覆盖协议层,但真实 API 行为
  依赖人工验证(巡检段 5 每次跑真实 LLM 调用)。
- 歌词来自各平台公开接口,厂商接口变动时可能失效(酷我已 fallback 到
  QQ 歌词)。
- 位置平滑模型对"上报不可信"的判定依赖启发式阈值(5s/2s/0.5s),
  极端平台可能需要调整。
