# 灵动岛挂件 V3.1 (Dynamic Island Widget) — Windows

> **V3.1(2026-08-17)** 本版重点是**安装器与发行**:自绘安装向导
> (Apple 设计语言重绘) + 绿色版发布打包 + 独立安装器 exe 打包,项目从
> "源码运行"走向"可安装发行"。Agent 引擎继续沿用 V3.0 的插件化架构重构。
> 详见 [安装与发行](#安装与发行)与
> [docs/TECH.md 第 43 章](docs/TECH.md)。

把 iOS 灵动岛带到 Windows 桌面的独立小程序:一个悬浮在屏幕顶部的灵动岛,
自动感知当前正在播放的音乐(QQ音乐 / 网易云音乐 / 酷狗 / 酷我 / 汽水音乐 /
浏览器标签页音频等),展开为控制面板,进度、切歌、播放模式一手掌控;也可以
切换到 **Agent 模式**,变成"岛灵"——一个常驻桌面的 LLM 助手,直接对话就能
让它执行本机操作;接入 NapCat 后更可**接管 QQ**:收到私聊/群聊消息自主回复、
按人区分、按主人指令远程控制电脑与音乐。

- **音乐模式**:SMTC 系统媒体监听 + 本地播放器双轨,歌词字幕、主题色、
  自定义背景、字体库、时间粒子,复刻 iOS 灵动岛的观感与手感。
- **Agent 模式**:LLM 对话 + 本机工具执行(命令 / 文件 / 浏览器 / 搜索 /
  通知 / B站下载 / 文档转换 / 超星答题),可挂 MCP 服务、技能、长期记忆,
  记忆自我进化;主动陪伴、心理揣测、多媒体库、对话内播放音视频。
- **QQ 机器人**:NapCat 接入后私聊/群聊消息进入对话窗口,LLM 按人区分、
  调用长期记忆与当次对话上下文自主回复;主人身份硬编码,外人消息分级
  (自主回复 / 先询问主人),信息隔离防泄露。
- **对话即功能引导**:问岛灵"你有什么功能",它会读取内置技术文档
  (docs/TECH.md)按你的兴趣介绍和引导使用。

技术栈:**Electron 43 + React 19 + TypeScript + Vite**,通过 Windows 系统媒体
会话(SMTC)与系统媒体交互。项目支持两种形态:**源码运行/开发**与
**打包发行**(绿色发布目录 + 独立安装器 exe),见
[安装与发行](#安装与发行)与[快速开始](#快速开始)。

> 开发者与详细技术说明见 [docs/TECH.md](docs/TECH.md)(第 42 章 插件化
> 架构重构 / 第 43 章 安装器与发行)与
> [WIDGET-README.md](WIDGET-README.md)(挂件部署/调试说明)。

---

## 目录

- [快速开始](#快速开始)
- [插件化架构重构(V3.0 重点)](#插件化架构重构v30-重点)
- [架构版图:六域目录](#架构版图六域目录)
- [HEVC 补丁工程(V2.0 重点)](#hevc-补丁工程v20-重点)
- [提示词约束工程(V2.0 重点)](#提示词约束工程v20-重点)
- [界面与基础操作](#界面与基础操作)
- [音乐模式使用指南](#音乐模式使用指南)
- [Agent 模式使用指南](#agent-模式使用指南)
- [QQ 机器人](#qq-机器人)
- [多媒体库](#多媒体库)
- [个性化外观](#个性化外观)
- [安装与发行](#安装与发行)
- [常见问题](#常见问题)
- [开发与构建](#开发与构建)
- [更新日志](#更新日志)
- [License](#license)

---

## 快速开始

### 获取与运行

两种形态:

- **源码运行/开发**(需要 Node.js):`pnpm install` 后双击项目根目录的
  **`dev.bat`**(一键重新构建并启动:自动结束残留旧实例 → 自动检测并应用
  HEVC 补丁 → 重新构建 → 启动 Electron,灵动岛出现在屏幕顶部居中);
- **打包发行(免环境安装)**:见 [安装与发行](#安装与发行)——绿色发布目录
  或独立安装器 exe,对方无需 Node 环境,双击即可安装运行。

开发版窗口透明无边框、置顶、可右键长按拖拽,系统托盘常驻。

### 单实例与重启

程序为单实例:重复启动只会唤起旧窗口(旧代码)。改完代码后用 `dev.bat`
重启(`dev.bat` 会先按路径过滤结束本项目旧实例)。若提示"检测到
dynamic-island-official 副本实例在运行",请先关闭日常副本再启动本项目。

---

## 插件化架构重构(V3.0 重点)

V3.0 把 Agent 引擎从"巨型工厂 + 扁平文件"改造为 **"一切皆插件"** 的
组合式架构(设计哲学对齐 deepseek-harness 审查报告
[plugin-design-review.zh.md](plugin-design-review.zh.md),内核自研、零外部
依赖)。没有需要打补丁的"特权核心":引擎主循环、LLM 适配、工具注册、
提示拼装、会话日志**全都是插件**,每一部分都可以从配置替换——扩展方式
永远是"在其他插件旁边挂载一个新插件"。

### 七大支柱

| 支柱 | 落地 | 一句话 |
| --- | --- | --- |
| 服务接缝(Seam) | `plugin/llm.ts` / `plugin/tool-registry.ts` | 可替换能力 = 接口 + 提供者 + 消费者三角色,按 key 发现、永不 import 实现 |
| 注册即可逆效果 | `kernel.ts` `ctx.effect` | 一切注册返回 disposer,卸载按逆序回滚全部副作用 |
| 类型化事件 | `kernel.ts` `emit/on` | 声明合并扩展事件表,即发即忘的观察通道 |
| 能力事件 | `plugin/tool-events.ts` | `tools/pre-execute`(瀑布,可改写/否决)/ `tools/post-execute`,不碰循环即可给工具执行挂策略 |
| 生命周期事件 | `plugin/lifecycle-events.ts` | `agent/turn-start/end`、`agent/step-start/end` 全链路观察,turn-end 具 finally 语义(全出口必发) |
| 会话日志约束 | `plugin/session-log.ts` | **Model-visible ⟺ Logged**:能到达模型的内容必可从会话日志重建(JSONL sink,图片清洗) |
| 声明式组合层 | `plugin/composition.ts` | Profile/Patch 驱动装配,"想换实现,把那一行的 name 换掉即可",dump 即见真实启动树 |

### 插件内核(kernel.ts)

轻量服务/效果容器(Cordis 风格,零依赖)。每个引擎一份独立上下文
(per-agent ctx:主对话与每个外部会话各自隔离):

- **服务仓库**:`ctx.register('llm', …)` / `ctx.get('llm')`——key 经 TS
  声明合并类型化(`ContextServices` 扩展点),缺失大声失败;
- **四种通道**:`emit/on`(即发即忘)、`waterfall`(around 中间件,监听器
  必须调用 `next` 委托,不调用即短路——短路本身也是设计)、`serial`
  (按注册顺序逐个等待,观察/审计钩子);
- **插件约定**:`{ name, inject?, apply(ctx) }`——`inject` 声明依赖的服务
  key,缺失立即大声失败(`AGENT_PLUGIN_DEP_MISSING`),绝不静默跳过;
- **配置错误大声失败**:服务缺失、装配重复 id、未知工厂名均有专属错误码,
  在最早可解析点抛出。

### 能力接缝示例:ctx.llm 三角色

- **Service Definition**:`llm.ts` 的 `LlmRuntime` 拥有 `ctx.llm` key,维护
  适配器注册表,**执行时解析**(指定 id 未注册 / 零个可用 / 多个歧义各有
  专属错误码,唯一可用自动选中——选择永不依赖注册顺序);
- **Service Provider**:五个适配器实现同一 `LlmAdapter` 接口——DeepSeek
  Responses(默认)/ DeepSeek Chat / Anthropic Messages / MiMo Responses /
  MiMo Chat,注册进接缝,**不拥有** key;
- **Consumer**:引擎主循环、delegate 子代理、subagents、evolution 经
  `ctx.get('llm').stream()` 调用,从不 import 具体供应商实现。

工具接缝 `ctx.tools` 同构:静态注册工具 + 动态源(MCP/技能,每轮执行时
实时解析),注册即逆效果。

### 声明式组合层(composition.ts)

引擎启动树不再由硬编码序列决定,而由一份**有序 Profile(行清单)**声明,
每行 `id + name + config`:

- 工厂注册表 `PLUGIN_REGISTRY`(18 个工厂:name → factory)是唯一实现
  解析点;**换实现 = 换行的 name**;
- `applyPatch` 按 id 整体替换某行或插入新行;`enabled: false` 跳过;
- 未知 name / 重复 id 大声失败;`dumpComposition` 导出真实启动树;
- 缺省装配(`defaultProfile`,18 行:host-bridge → seam-llm → seam-tools →
  session-log → 10 个工具组插件 → 4 个提示段落插件)与重构前硬编码序列
  **逐位一致,行为零变化**。

新增能力的纪律:**在对应领域文件写一个插件 + 注册工厂 + Profile 加一行,
不改 loop、不改其他插件**。

### 事件模型(扩展点选型)

- **能力事件用于决策/改写**(瀑布):`agent/pre-step`(决定模型看到什么,
  提示段落按注册顺序拼装)、`tools/pre-execute`(可改写 args / `deny` 否决
  执行)、`tools/post-execute`(可改写结果做记账/备注);
- **生命周期事件为纯观察**(只读载荷,不阻塞执行流):turn/step 四事件
  覆盖回合全出口,统计/埋点/日志挂在这里,永不改 engine-loop;
- **"Plugins, not loop changes"**:新行为必须挂在文档化扩展点上,直接改
  主循环必须同步更新架构文档。

---

## 架构版图:六域目录

V3.0 同步完成**域目录化整合**:`electron/agent` 下所有扁平文件按域
收编,导入路径经批量改写,构建入口改为 `engine/engine.ts`:

```
electron/agent/
├── engine/       # 引擎核心(8 文件):engine.ts 装配入口 + loop(主循环)/
│                 # builtins(内置工具)/ tool-execution(工具执行)/
│                 # confirm-gate(确认门)/ history / manual-call / turn-text
├── plugin/       # ★ 插件内核与接缝(14 文件):kernel/composition/host/
│                 # host-bridge/llm/tool-registry/tool-plugins/prompt-plugins/
│                 # tool-events/lifecycle-events/session-log/prompt/errors/index
├── providers/    # LLM 供应商(9 文件):deepseek/chat/anthropic/mimo-* +
│                 # sse 公共层 + provider 分发入口
├── tools/        # 工具族(13 文件):tools.ts 主入口 + env/bili/docflow/
│                 # search/media 分簇 + settingsTools 四文件 + session/config
├── napcat/       # QQ 通道(7 文件):napcat.ts 入口 + client/message/
│                 # session/store/text + wsclient(手写 WS 传输)
├── subagents/    # 后台子代理(2 文件):总结标题/心理揣测/主动陪伴判断
└── (根层)         # constants/evolution/mcp/memory/notify/skills/tasks/
                  # types/undo —— 跨域共享模块
```

配套的十四期重构节奏(一期内核 → 各接缝 → 各事件 → 会话日志 → 组合层 →
目录化收官)全程测试驱动:**tsc 0 错、核心测试 221/221 通过、build 与
smoke 全绿**,re-export 与装配顺序保证行为零变化。

---

## HEVC 补丁工程(V2.0 重点)

官方 Electron **没有 HEVC(H.265)解码能力**(ffmpeg 默认配置排除专有编码 +
media 层平台能力门控)——bili 下载的 HEVC 高清视频在对话窗口里"播放中全黑"。
V2.0 的正解 = **自编译 Electron**(ffmpeg 补入 HEVC 解码器,media 门控放行
软解),构建产物经换装脚本应用:

```bash
node scripts/apply-hevc-electron.mjs            # 应用补丁(幂等;dev.bat 自动执行)
node scripts/apply-hevc-electron.mjs --restore  # 恢复官方版(7 个文件全量回退)
node scripts/apply-hevc-electron.mjs --check    # 只报告状态,不修改
```

换装内容 = 7 个构建相关文件(electron.exe / ffmpeg.dll / V8 快照 ×2 / pak ×3,
**必须与 exe 同源**),官方版全量备份为 `*.official`;多尺寸图标经
`scripts/brand-electron-icon.mjs` 烙入自编译 exe。bili 下载默认自动转码
H.264 兜底;补丁未应用时 HEVC 视频显示明确提示并可降级系统播放器。
细节见 [TECH.md 第 15 章](docs/TECH.md)。

## 提示词约束工程(V2.0 重点)

V2.0 把提示词当作**工程对象**管理——分层拼装、逐条身份判定、注入/剥离
双通道、防泄露硬约束。用户可见的行为保证:

- **主人身份(逐条判定)**:主人 = QQ 1178821869,硬编码,任何配置不能
  改变;对话窗口直接输入 = 主人本人;带【QQ私聊/QQ群聊 · QQ 号】标注的
  外部消息只有标注主人的才具主人权限;【系统通知】= 系统事件。
- **QQ 消息分级与信息隔离**:主人自主回复(带长期记忆)、扩展信任联系人
  自主回复(按隐私边界)、陌生人**先询问主人**、群聊看场合回复。防泄露
  硬约束每次回复注入(不输出思考过程、不泄露隐私、教唆操控一律拒绝并
  告知主人),对外回复经三段剥离链 + 发送前兜底清洗,回复路由三分类
  保证窗口聊天永不串到 QQ。
- **档案卡**:每条 QQ 消息携带发送者档案卡(称呼/已知信息/会话人格/
  相关记忆/最近发言),历史消息同样保留,LLM 跨轮次正确区分"谁说过什么"。
- **Sub Agent 约束**:总结标题、心理揣测、主动陪伴判断、记忆提取等全部
  走独立 Sub Agent(无工具单轮、关思考加速、严格解析 + 判效 + 兜底链)。

工程细节见 [TECH.md 第 16 章](docs/TECH.md)。

---

## 界面与基础操作

- **紧凑态**:顶部小胶囊,显示歌名/歌手(音乐模式)或 AI 回复的心理揣测
  (Agent 模式);
- **展开**:长按岛体(450ms)展开控制面板 / Agent 对话面板;
- **拖拽移动**:右键长按岛体拖拽(约 0.4s 进入拖拽模式,位移 < 8px);
- **快捷手势**(音乐模式文字区):双击播放/暂停、三连击切 Agent、左滑右滑
  切歌;
- **托盘菜单**:模式切换(音乐 ↔ Agent)、设置、多媒体库、置顶、退出。

## 音乐模式使用指南

播放 QQ音乐 / 网易云 / 酷狗 / 酷我 / 浏览器标签页音频时,岛体自动显示
歌名/歌手/进度,展开为控制面板:播放暂停、上一首/下一首、进度拖拽、
循环模式、歌词字幕(按平台自动切换歌词源,可手动选择 QQ/网易/酷狗/酷我/
自定义 API)。本地播放器兜底:音频库导入的音乐可直接播放。

## Agent 模式使用指南

托盘切到 Agent 模式 → 长按展开对话面板:

- 直接对话:让岛灵执行本机操作(命令/文件/浏览器/搜索/B站下载/文档转换
  /超星答题等),工具调用过程在窗口内可见(仅主人);
- 记住偏好:说"记住:…"写入长期记忆,自动附加到每轮系统提示;
- 记忆进化:设置 → 自我进化,自动整合重复记忆;**人设类记忆自动锁定**
  (🔒),进化不会改动主人指定的人设;
- 主动陪伴:无操作满 N 分钟岛灵主动开口(可关/调间隔);
- API 配置:设置 → Agent 设置(API Key / Base URL / 模型 / 思考强度 /
  输出预算 / MCP 服务 / 技能目录)。

## QQ 机器人

1. 前置:NapCat 已登录并开放 OneBot WS(默认 `ws://127.0.0.1:3001`);
2. 开启:Agent 设置里开启 NapCat,或对话中说"开启 QQ 机器人";
3. 私聊/群聊消息会以系统通知提示,并进入对话窗口(气泡带来源与档案卡),
   岛灵按上文分级规则自主回复;
4. 对话中可指挥:"只回复我自己的 QQ""帮我回魔精说…";napcat 工具支持
   主动发消息/发图/发文件/撤回/查成员/查好友/群管理/看 QQ 空间动态。

主人 QQ(1178821869)消息 = 最高权限,可直接远程控制(如"暂停音乐"
"打开B站")。

## 多媒体库

托盘或 Agent 面板呼出多媒体库:图片(可作背景)、音频(导入即入播放列表)、
视频(路径引用,窗口内流式播放,支持 H.264/AV1 与补丁后的 HEVC)。对话窗口
内的音视频可直接播放、缩放、全屏、独立音量/倍速/循环。

## 个性化外观

设置 → 背景编辑器(展开/紧凑两套背景图与裁切)、主题色、字体库(上传自定义
字体、文字颜色自动/自定义)、歌词 API。界面缩放(100-300%)放大面板不放大
文字。

## 安装与发行

项目提供**自绘安装向导**(零 UI 框架,Apple 设计语言重绘,深色玻璃拟态 +
原始背景图/图标)与两级发行产物:

### 产物结构

| 产物 | 路径 | 用途 |
| --- | --- | --- |
| 绿色发布目录 | `release/灵动岛/` | `electron.exe + resources/app` 绿色版,拷走即用 |
| 独立安装器 | `release/灵动岛安装器/` | 双击「灵动岛安装器.exe」启动向导,可发给任何人 |

### 打包命令

```bash
node scripts/build-release.mjs     # ① 生成绿色发布目录 release/灵动岛
node scripts/build-installer.mjs   # ② 生成独立安装器 release/灵动岛安装器(内含 ① 作为安装源)
npx electron installer/main.cjs    # 开发期直接运行安装向导(不打包,便于预览)
```

安装向导([installer/](installer/))会:逐文件复制发布产物到所选安装目录 →
校验主程序 → 创建桌面/开始菜单快捷方式 → 可选开机自启 → 写入卸载项并生成
`uninstall.cmd`。默认安装目录不可写时自动回退到可写位置;快捷方式/自启等
附加项失败降级为警告,不阻断核心安装。

> 完整技术说明(安装逻辑、asar 复制坑、沙箱兼容、UI 细节)见
> [TECH.md 第 43 章](docs/TECH.md)。

## 常见问题

- **窗口点不动 / 悬浮无反应**:重新用 `dev.bat` 启动(穿透自校正 + 单实例
  锁问题);
- **HEVC 视频黑屏**:`node scripts/apply-hevc-electron.mjs --check` 查补丁
  状态;未应用则跑 apply 或对 bili 下载用自动转码;
- **QQ 机器人不回复**:检查 NapCat 是否在线(WS 端口)、napcatEnabled、
  白名单配置;
- **通知不弹**:确认托盘存在(通知走托盘气泡通道);Windows 通知设置勿禁用;
- **岛灵回复里看到指令/档案卡文本**:对话窗口只显示原文与来源,指令段只
  给 LLM 看(设计如此);历史里的档案卡是为 LLM 区分人保留的;
- **插件装配报错(AGENT_* / LLM_ADAPTER_* 错误码)**:这是组合层"大声
  失败"设计——按错误码定位(依赖服务缺失/重复 id/未知工厂名/适配器歧义),
  见 [TECH.md 第 42 章](docs/TECH.md)。

## 开发与构建

```bash
dev.bat                # 一键构建 + 启动(自动应用 HEVC 补丁)
pnpm dev               # 仅 Web 演示版
pnpm build             # 类型检查 + Web 版构建
pnpm build:electron    # esbuild 打包 Agent 引擎(入口 engine/engine.ts)/SMTC 桥/图标
pnpm lint              # oxlint
pnpm test:markdown     # Markdown 解析器测试
node tests/test-agent-core.mjs   # 引擎核心测试(221 用例,含插件内核/接缝/事件套件)
node scripts/build-release.mjs   # ① 打包绿色发布目录 release/灵动岛
node scripts/build-installer.mjs # ② 打包独立安装器 release/灵动岛安装器(需先跑 ①)
```

验证基线(V3.0 收官):`tsc -b` 0 错、核心测试 221/221 通过、
`pnpm build:electron` 与冒烟会话全绿、oxlint 无告警。

架构与踩坑记录见 [docs/TECH.md](docs/TECH.md)(第 42 章 插件化架构重构);
部署与调试见 [WIDGET-README.md](WIDGET-README.md)。

## 更新日志

### V3.1(2026-08-17)

- **安装器与发行**:新增自绘安装向导 `installer/`(零 UI 框架,Apple 设计语言
  重绘——深色玻璃拟态、克制的排版/动效、原始背景图与图标;四步向导:欢迎/
  安装选项/安装中/完成);新增绿色发布打包 `scripts/build-release.mjs`
  (产出 `release/灵动岛/` 绿色版)与独立安装器打包 `scripts/build-installer.mjs`
  (产出 `release/灵动岛安装器/`,双击「灵动岛安装器.exe」即可安装);
- **安装健壮性修复**:复制文件改用 `original-fs`(修复 Electron 主进程复制
  `.asar` 被自动解包导致的 ENOENT);默认安装目录/userData 可写性预检与自动
  回退;桌面快捷方式/开机自启/卸载项等附加项失败降级为警告不阻断安装;
  安装失败留在安装页直接显示错误(不再闪回造成"没反应"假象)。

### V3.0(2026-08-14)

- **插件化架构重构(十四期收官)**:自研插件内核 kernel.ts(服务容器 +
  可逆效果 + 类型化四通道,零外部依赖);能力接缝 ctx.llm(五适配器:
  DeepSeek Responses/Chat、Anthropic、MiMo Responses/Chat)与 ctx.tools
  (静态注册 + 动态源);能力事件 tools/pre-execute/post-execute(瀑布,
  可改写/否决)与生命周期事件 agent/turn-start/end、step-start/end
  (turn-end finally 全出口);会话日志约束 Model-visible⟺Logged(JSONL
  sink + 图片清洗,sink 可替换);声明式组合层 composition.ts(Profile/
  Patch/dump,18 工厂,缺省装配与既往硬编码逐位一致);
- **域目录化整合**:electron/agent 扁平文件收编为 engine/plugin/providers/
  tools/napcat/subagents 六域目录,构建入口改 engine/engine.ts;
- **测试**:plugin-kernel-tests.ts 并入核心测试(221 用例),覆盖内核、
  接缝、事件、组合层全链路。

### V2.0(2026-08-13)

- **HEVC 补丁工程**:自编译 Electron 软解 HEVC(apply/restore/check 三命令,
  dev.bat 自动应用);多尺寸图标烙入自编译 exe(进程/弹窗/托盘图标);
  补丁版段错误根治(通知走托盘气泡通道、流式请求软中止规避 Node llhttp
  UAF、NapCat 手写 WS 传输);恢复硬件加速(透明窗口硬化);
- **提示词约束工程**:主人身份逐条判定(窗口直发 = 主人,外部 QQ 不继承
  主人权限);QQ 注入统一模板(类别行 + 档案卡 + 编号回复规则,含安全红线);
  档案卡按 QQ 聚合全部已知信息 + 最近发言,历史消息隔离;Sub Agent 提示词
  精简重构(标题 2 级链、揣测 4 规则);受保护记忆(人设锁定,进化不改);
  防泄露剥离链三段(思考腔/工具叙述/主人视角) + 发送前兜底;
- **会话隔离与并发**:会话键体系(主/private/group),每会话独立引擎与
  路由状态,渲染端 SessionHost 多实例 + 会话坞;撤销与停止分离(git 快照
  私有引用,撤销只回滚上下文、停止只中止回合);MiMo 第三供应商接入。

### V1.0(2026-08-10 前)

音乐模式 SMTC 双轨、Agent 模式全套能力(工具/MCP/技能/记忆/进化/主动陪伴
/多媒体库)、个性化外观、帮助手册(后移除)。

## License

MIT
