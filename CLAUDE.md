# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

灵动岛桌面挂件(Windows):Electron 透明无边框悬浮窗,复刻 iOS 灵动岛,通过 Windows SMTC 监听 QQ音乐/网易云等播放状态并控制(切歌/进度/模式),内置本地播放器兜底。技术栈:Electron 43 + React 19 + TypeScript + Vite,全部中文注释。

## 常用命令

```bash
pnpm dev             # 仅 Vite Web 演示版(浏览器调试,不进 Electron)
pnpm dev:widget      # 构建挂件页面并启动 Electron(日常调试主入口)
pnpm build           # tsc -b 类型检查 + Web 版构建
pnpm build:widget    # 仅构建挂件页面 → dist-widget/
pnpm build:electron  # esbuild 打包 SMTC 桥接(→ electron/bridge.cjs)+ 生成图标
pnpm dist:win        # 完整打包(electron-builder:便携版 + NSIS 安装版 → release/)
pnpm lint            # oxlint
pnpm bridge          # 独立运行系统媒体桥接脚本(单独调试 SMTC)
```

**验证约定(用户要求)**:除非用户明确要求打包,修改代码后默认都要**重新构建并启动程序**验证(优先 `pnpm dev:widget` 或 `pnpm build:widget` 后运行 electron),只跑类型检查/lint 不算完成;只有用户明确说出打包/出安装包时才执行 `pnpm dist:win`。

## 架构

### 双入口共享一个组件

- `src/` — Web 演示版入口(vite.config.ts),带完整演示页面。
- `widget/` — 桌面挂件入口(vite.widget.config.ts,`mode=widget`),只渲染灵动岛本体;`base='./'` 使产物可直接 file:// 加载。该构建模式下 `src/media/tracks.ts` 返回空内置歌单、产物剔除 music 资源。
- **`src/components/DynamicIsland/DynamicIsland.tsx` 是两端共享的岛体组件**,行为差异全部靠 CSS 覆盖(widget/widget.css 的 `.widget-stage` 选择器)与可选 props 区分。改动组件时务必同时考虑 Web 版(App.tsx)与挂件版(WidgetApp.tsx)两个调用方。
- `tsconfig.app.json` include 含 `src` + `widget`;`pnpm build` 的 `tsc -b` 会检查两端。

### 数据源双轨

`WidgetApp` / `App` 中 `useSystemMedia`(SMTC 外部平台)与 `useMediaPlayer`(本地播放器)并存,`externalActive = system.active && system.track && useExternalSource` 决定数据与控制走哪一边。切换数据源时**双向暂停**(切走的一方自动暂停,避免双声齐响)。进度/时长/播放模式/曲目都按此分支取数。SMTC 播放模式以系统真实状态为数据源(轮询校准),点击循环后 1.2s 检测是否跟随,没跟随则提示并回退。

### Electron 主进程(electron/main.cjs)

- 透明无边框窗口 + `setIgnoreMouseEvents` 点击穿透:`widget-stage`(岛体)mouseenter/leave 经 IPC `widget:pointer` 切换"接收鼠标"。
- **移动挂件 = 右键长按拖拽**(WidgetApp 的 stage 层):按住右键 ~0.4s(位移 < 8px)进入拖拽模式后拖动,快速右键点击/拖动无效果。渲染端指针捕获 + IPC(`widget:drag-start/move/end`)→ 主进程用"窗口 = 鼠标 - 按下偏移"绝对定位,位置自由(不限制在屏幕内)。防漂移三件套:① 拖拽激活基准用长按期间的最新坐标(不是按下点,消除手抖偏移);② 渲染端 <0.5px 容差去重(窗口移动合成的亚像素事件不发送);③ 主进程 setPosition 后校验实际落点,不一致就重算偏移(自校正,不累积相对偏移)。**异常防线**:所有拖拽坐标过 ±10 万合理范围校验(真实屏幕坐标不可能超出),非有限值或超界一律丢弃并打日志 — `setPosition` 的 int32 参数转换对超界有限值(|v| ≥ 2^31)会抛未捕获异常,绝不能把脏数据传进去。拖拽期间穿透保持接收(鼠标移出岛体也持续响应),松手按指针位置恢复穿透。进度条/文字手势均加了 `button !== 0` 守卫,右键只属于拖拽。
- SMTC 桥接以 `utilityProcess` 启动 `electron/bridge.cjs`(由 `scripts/system-media-bridge.ts` 经 esbuild 打包),崩溃自动重启(10s 内 3 次上限)。
- 配置持久化 `userData/settings.json`(仅 alwaysOnTop);主题色 localStorage(`widget-theme-color`);上传音乐 IndexedDB(`island-uploads`);自定义背景图 IndexedDB(`island-background`)+ 透明度 localStorage(`widget-background-opacity`)。窗口位置每次启动顶部居中,不持久化。
- 托盘"自定义背景…"经 IPC `widget:open-background-editor`(preload 的 `onOpenBackgroundEditor` 订阅)通知渲染端,`DynamicIsland` 的 `requestBackgroundSeq` prop(seq 递增触发)展开面板并切换到背景视图。背景状态 = `{expandedImage, compactImage, opacity, expanded: {zoom,posX,posY}, compact: {zoom,posX,posY}}` — **展开态与紧凑态各有独立图片与独立裁切**(图片 IndexedDB 双槽位 `expanded`/`compact`,旧版单图自动迁移到两个槽位;参数 localStorage `widget-background`,旧版单形态参数迁移到展开态)。背景图层经 CSS 变量按形态切换(`--bg-img-e/--bg-size-e/--bg-pos-e`、`--bg-img-c/--bg-size-c/--bg-pos-c`),参考比例:展开 400×244、紧凑 280×56;编辑器分段切换编辑目标(上传/移除作用于当前形态)。视口切形态时圆角**瞬切**(不做圆角动画,避免"矩形裁切到圆角"观感),高度与取景弹簧过渡。背景视图需要更高空间:岛体加 `island-bg-view` 类(440px),宿主经 `onPanelViewChange` → IPC `widget:set-height` 调整窗口高度(480 ↔ 280),离开视图回落。**背景图必须经 `downscaleBackgroundImage` 降采样(长边 ≤1024px)**:岛体形变逐帧重栅格化大图是带背景切换卡顿的主因,上传与旧图加载都走该函数。
- 调试工具:`WIDGET_SCREENSHOT=<path>` 加载后自动截图;`WIDGET_SCREENSHOT_MODE` 支持 `expanded` / `layout`(输出面板各区域几何 JSON,验证布局用)/ `theme` / `stress` / `test`。跑实机验证时配合 `timeout` 启动 electron 并在几十秒后自动退出(应用托盘常驻不会自退)。

### SMTC 桥接

`scripts/system-media-bridge.ts` → `electron/bridge.cjs`;读取端为 `electron/smtc-reader.ps1`,运行时用 `csc.exe` 编译 `electron/smtc-bridge.cs`(Windows 11 26100 新版 API,引用 System32\WinMetadata),异步等待用轮询 Status/GetResults(3s 超时防卡死)。PS 5.1 无法绑定 WinRT 集合元素,所以必须走 C# 强类型桥接。

## 关键约束(容易踩坑)

- **提示文本必须渲染在灵动岛体内部,紧凑态与展开态均不允许超出岛体轮廓**(用户明确要求)。实现:`DynamicIsland` 的 `hint` prop(纯文本)——紧凑态直接注入左侧文字区(与歌名同款字体、同套切换动画),展开态渲染在播放键下方(`island-hint-play`,面板次级文字同款、无气泡)。**禁止**气泡式 Toast UI,也禁止渲染到岛体外(如窗口底部)的提示。
- **透明窗口渲染稳定性**:widget/widget.css 去掉岛体毛玻璃(backdrop-filter 在透明窗口合成不稳)与逐帧 blur(卡顿主因);岛体背景全不透明(rgb(8,10,14));展开面板高度 244px(覆盖组件默认 208px;控制区 flex: none 贴进度条,无居中留白);歌词在挂件版改回文档流(static),歌词行 42px 高(两行 0.78rem×1.4 歌词 + 底部余量,防 j/g/y 下沿裁切)。**垂直居中用 `transform: translateY(-50%)`,不要用 `translate` 属性**(透明窗口下偶发失效导致元素整体偏下,`.island-extra`/`.island-time-particles` 都为此改过)。
- **歌词折叠**:折叠条件 `lyricFold = !lyricShown || (歌词查询完成且无结果)`(查询中保持展开防闪动)。折叠时岛体加 `island-lyric-off` 类,挂件版高度 244→202px;动画为**方向性过渡**——展开用回弹曲线(scaleY 过冲,`cubic-bezier(0.34,1.56,0.64,1)`),收起用无过冲缓动(scaleY 过冲会翻转为负值镜像)。挂件版静态定位,折叠 transform 是纯 `scaleY(0)`(不能带基础版的 translateX(-50%) 居中位移);基础版歌词是绝对定位,只淡出不收高度。
- **歌词查询竞态(useLyrics)**:本地播放器 idle 时 `player.track` 仍指向列表首曲(index 默认 0);外部监听短暂回落本地(externalActive 瞬时为 false)会误用本地首曲发起歌词查询。useLyrics 的响应在应用前按 `lastKeyRef` 校验,过期响应(曲目已切换)一律丢弃,否则旧响应会覆盖新曲目歌词且不会重查。
- 主进程已 `app.disableHardwareAcceleration()`(避免半透明 alpha 突变),改动渲染相关代码不要重新引入硬件加速依赖。
- 组件内宽度/布局靠 JS 测量 + px→px 过渡(弹簧曲线),文字切换/悬停伸缩/展开收起的时序常量集中在 DynamicIsland.tsx 顶部,改动画同步时两边(CSS transition 与 JS setTimeout)要一致。
- 已知平台限制:QQ音乐等客户端可能不支持 SMTC 跳转/模式控制,点击后 1.2s 检测未生效 → 岛内提示并回退(UI 显示系统真实状态)。
- **SMTC 位置平滑(useSystemMedia)**:浏览器(Chrome/Edge 标签页音频)等平台的上报位置不可信(抖动或**阶梯式过期**——冻结数秒后突然跳变,跟随会抽搐或周期性回跳)。显示进度 = 锚定基准 + 本地时钟流逝,常规轮询不跟随上报位置,仅重锚定于:① 曲目变化(标题 key);② 播放状态变化(暂停冻结在本地时钟位置、恢复继续,均不采信可能过期的上报);③ 位置偏离 > 5s **且**上报位置距上次轮询移动 ≥ 2s("活着"判定,真实外部 seek 才满足;浏览器冻结期移动≈0、更新瞬间偏差≈0,永远不满足)。用户 seek 在 `control()` 内立即乐观锚定,是否生效由**挂起验证**判定(对照系统真实位置,±3s 或单次跳变 >5s 视为生效——后者覆盖浏览器阶梯式更新,其位置块状前进可能永远不在目标 ±3s 内):客户端明确拒绝(`accepted === false`)或 8s 超时未跟随(QQ音乐"接受但未跳转")→ 回退显示、判定该平台不支持 seek 并返回 `false`,宿主据此提示。**验证结果按 sourceAppId 持久化**(localStorage `island-seek-support`),切换平台/重启都不重学,已记忆的平台零等待直接拒绝/放行。暂停点击瞬间由 control() 冻结位置。
- **岛体悬停校准(DynamicIsland 布局 effect)**:点击穿透窗口下 mouseleave 偶发丢失,JS 记录的悬停态(hoveredRef)会滞留,导致"宽岛无进度条"(宽度被设成悬停扩展宽,但进度条可见性由 CSS :hover 驱动)。布局 effect 每次重算宽度前用 `island.matches(':hover')` 校准,悬停态滞留就回落自然宽。
