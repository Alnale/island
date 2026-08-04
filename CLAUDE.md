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

**验证约定(用户要求,2026-08-04 更新)**:每次优化/修改代码后,自动重新构建并启动实机验证——默认执行 `pnpm dev:widget`(构建挂件页面并启动 Electron)确认改动生效,此前的"默认不自动验证"约定已废止。实机验证用 `timeout` 包住 electron 在几十秒后自动退出(应用托盘常驻不会自退,见下方调试工具),需要截图时配 `WIDGET_SCREENSHOT=<path>`;完成标准 = 实机验证 + 类型检查 + lint(`tsc -b` / `pnpm lint`)。例外:`pnpm dist:win` 打包出安装包仍只在用户明确要求时执行。

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
- 配置持久化 `userData/settings.json`(仅 alwaysOnTop);主题色 localStorage(`widget-theme-color`);上传音乐 IndexedDB(`island-uploads`);自定义背景图 IndexedDB(`island-background`)+ 透明度 localStorage(`widget-background-opacity`);自定义字体文件 IndexedDB(`island-font`,data URL,10MB 上限,ttf/otf/woff/woff2)+ 参数 localStorage(`widget-font`)。窗口位置每次启动顶部居中,不持久化。**卸载删数据**:electron-builder.yml `nsis.deleteAppDataOnUninstall: true`,NSIS 卸载器(辅助安装模式自带,会先杀运行中的应用)确认卸载后连同 `%APPDATA%\dynamic-island` 一并删除(打包后 userData 目录名 = package.json 的 `name`,不是中文 productName;v26 卸载模板无勾选框,直接删)。**开始菜单卸载入口**:electron-builder 26 辅助安装不生成独立的"卸载"快捷方式,由 `nsis.include: electron/installer.nsi` 补齐(customInstall 创建「卸载 灵动岛挂件.lnk」指向 `$INSTDIR\Uninstall 灵动岛挂件.exe`,customUnInstall 卸载时删除;宏体内 `${UNINSTALL_FILENAME}`/`${SHORTCUT_NAME}` 调用时才展开,安全)。
- 托盘"设置…"经 IPC `widget:open-settings`(preload 的 `onOpenSettings` 订阅)通知渲染端,`DynamicIsland` 的 `requestSettingsSeq` prop(seq 递增触发)展开面板并切换到**设置视图**。背景编辑器 / 帮助手册 / 主题色 / 字体均从设置视图内部进入(控制区不再有主题色按钮;Web 演示版入口 = 控制区 `settingsButton`)。**设置类视图**(`settings`/`background`/`theme`/`help`/`font`/`font-color`/`font-library`/`image-library`,组件内 `SETTINGS_VIEWS` 常量)一律屏蔽单击岛体、长按、Esc、点击面板外等一切缩回操作,只能通过返回键退出(子视图返回回设置视图,设置返回收起)。**蒙版为岛体层持久层 `.island-panel-mask`**(`expanded && panelView !== 'control'` 时挂载,z-index 0 在岛体背景之上、面板之下,`rgba(8,10,14,0.55)` 不透明度恒为 1):面板自身不再带蒙版背景,否则面板的 `maskPanelIn` 淡入动画会连蒙版一起透明,视图切换瞬间背景图透出闪烁。蒙版 0.55 为调低后的值(原 0.78 背景图几乎全黑、控件发黑)。**蒙版下控件统一"中性胶囊"设计**(参考背景编辑器"更换图片"等按钮,`island-bg-actions .island-ctl`):返回键 `island-bg-back` 与上传键 `island-ctl--upload` 不用强调色(transparent 混色叠在蒙版上成"黑洞",实底混色又太黑),统一为半透明白底 `rgba(255,255,255,0.09)` + 细白描边 `rgba(255,255,255,0.24)` + 白字,悬停加深(0.12/0.32)。面板进入动画统一纯淡入(`maskPanelIn`),不做位移回弹(蒙版随 translateX 回弹会像整块甩动)。四个子视图返回键 UI 统一(扁平 `island-bg-back`,占满整行、强调色描边)。
- **字体库与图片库(font / font-library / image-library 视图)**:字体与图片都支持多条目库(IndexedDB 按 id 存条目,`island-font` store 'fonts'、`island-background` store 'library',旧单键数据自动迁移;参数 localStorage `widget-font` 存 currentFontId/colorMode/colorValue)。库页面为**大面板**(`island-lib-view`,岛体 440px,宿主窗口同步 480,与背景编辑器共用 TALL 高度机制):搜索框按名称过滤、列表/网格点击应用、行内编辑名称(Enter 提交/Esc 取消/失焦提交)、删除(删当前应用字体则回退默认)、上传(自动入库并应用;同一 dataUrl 不重复添加)。**图片库网格行高必须显式 `grid-auto-rows: 128px`**:auto 行高 + `align-content: start` 时,内容一旦超高(卡片实高约 125px)Chromium 会把行压缩到恰好填满容器((高度-间距)/行数,实测 17 张 → 26px/行),卡片压扁、名称被 overflow:hidden 裁掉、内容永不过高也无法滚动;字体列表 `.island-lib-row` 同理需 `flex-shrink: 0` 防 flex 压缩。背景上传/选择经宿主 `handleBackgroundChange` **自动入库**(命名"背景图 N"),字体上传在组件内查重后 `onFontAdd`。上传的字体注入 @font-face(组件内动态 style 标签 `island-font-face`,字体族 `island-font-custom`,岛体 inline font-family 覆盖、fallback 取运行时 body 字体栈;按钮/输入 font-family: inherit 跟随)。颜色模式 `auto` = **合成亮度算法**:背景图以 opacity 叠加在岛体深底 rgb(8,10,14) 上,可读性取决于合成后亮度(像素 × opacity + 深底 × (1-opacity)),取**当前形态**背景图(展开态用展开图、紧凑态用紧凑图,缺图退另一形态),32×32 采样平均 >140 判亮 → 黑字 `#0b0b0f`,否则白字;`custom` = **独立颜色页**(`font-color` 视图,字体视图"自定义"入口):色板 + **岛内自绘取色器** + hex 输入(防抖 200ms)。取色器为可复用组件 `IslandColorPicker`(SV 面:横向饱和/纵向明度,色相条横向渐变,pointer capture 拖动取色,`hsvToHex` 实时提交;**不弹系统 `<input type=color>` 对话框**,UI 不出岛;**字体颜色与主题色共用**);拖拽期间 `pickingRef` 屏蔽 prop 回读(避免 8bit 量化往返换算导致光标抖动),非拖拽时从当前色同步归位。**SV 面明度黑渐变必须拆成独立 `::after` 层**(两层渐变叠在同一 background 时黑渐变会在底边提前淡出,底部露出一条亮色带,像素实测;独立层 + inset:0 铺满,底部实黑)。**取色面/色相条不带边框**:1px 边框 + `inset:0` 的 ::after 只覆盖到 padding box,边框内侧会露出一圈底色渐变(底部为亮色环,像素实测),去掉边框后 ::after 全覆盖、无线条。颜色页(字体 `font-color` / 主题色 `theme` 视图共用 `island-color-main` 布局)岛体 352px(挂件窗口 364,宿主 `VIEW_WINDOW_H` 登记;SV 面 flex:1 吃满剩余高度);字体视图本身固定 200px 紧凑高度。文字颜色经 CSS 变量注入岛体:`--text-color`(主文字,原 `#fff` 全部替换为 `var(--text-color, #fff)`)、`--text-dim`(次级文字,原白色系 rgba 透明度 0.3~0.75 全部替换为 `var(--text-dim, …)`,值为主色 55% 透明度);无设置时变量缺省 → CSS fallback 白色系,外观不变。背景状态 = `{expandedImage, compactImage, opacity: {expanded, compact}, expanded: {zoom,posX,posY}, compact: {zoom,posX,posY}}` — **展开态与紧凑态各有独立的图片、不透明度与裁切**(图片 IndexedDB 双槽位 `expanded`/`compact`,旧版单图自动迁移到两个槽位;opacity 旧版单一数值自动迁移为双槽位同值;参数 localStorage `widget-background`,旧版单形态参数迁移到展开态)。背景图层经 CSS 变量按形态切换(`--bg-img-e/--bg-size-e/--bg-pos-e`、`--bg-img-c/--bg-size-c/--bg-pos-c`),不透明度在组件内按 `expanded` 取对应槽位,参考比例:展开 400×244、紧凑 280×56;编辑器分段切换编辑目标(上传/移除/不透明度滑杆均作用于当前形态)。视口切形态时圆角**瞬切**(不做圆角动画,避免"矩形裁切到圆角"观感),高度与取景弹簧过渡。背景编辑器蒙版由岛体层 `.island-panel-mask` 统一提供(编辑控件压在自定义背景图上保证可读性),裁切视口(预览框)自身不透明显示原图、不受蒙版影响。背景视图需要更高空间:岛体加 `island-bg-view` 类(440px),切紧凑态编辑时折叠为 `island-bg-view--compact`(288px,折叠掉多余岛体,高度弹簧过渡),宿主经 `onPanelViewChange` → IPC `widget:set-height` 调整窗口高度(480 ↔ 280),离开视图回落。**背景图必须经 `downscaleBackgroundImage` 降采样(长边 ≤1024px)**:岛体形变逐帧重栅格化大图是带背景切换卡顿的主因,上传与旧图加载都走该函数。
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
