# 灵动岛挂件 (Dynamic Island Widget) — Windows

把 iOS 灵动岛带到 Windows 桌面的独立小程序:一个悬浮在屏幕顶部的灵动岛,
自动显示当前正在播放的音乐(QQ音乐 / 网易云 / 酷狗 / 酷我 / 汽水音乐等),
可展开成控制面板,进度、切歌、播放模式一手掌控。

基于 **Electron + React 19 + TypeScript + Vite**,通过 Windows 系统媒体会话
(SMTC)与系统媒体交互,打包为免安装的便携版与 NSIS 安装版。

## 快速开始

打包产物在 `release/` 目录(或从 [Releases](../../releases) 下载):

- **灵动岛挂件-便携版-1.0.0.exe** —— 免安装,双击即用(推荐)
- **灵动岛挂件-安装版-1.0.0.exe** —— NSIS 安装程序

启动后:

| 操作 | 功能 |
| --- | --- |
| 悬停岛体 | 展开进度条,可点击/拖动跳转播放进度 |
| 长按岛体 | 展开成控制面板 |
| 单击岛体(展开时) | 收起面板 |
| 双击文字 | 播放 / 暂停 |
| 左右滑动文字 | 上一首 / 下一首 |
| **按住右键拖动岛体** | 移动挂件位置(窗口不超出屏幕,每次启动默认顶部居中) |
| 托盘图标 | 显示/隐藏、总在最前、开机自启、退出 |

挂件平时是"点击穿透"的:鼠标在岛体之外时直接穿透到下层窗口;
鼠标移入岛体后才接收点击。

## 功能

- **系统媒体监听**:通过 Windows 系统媒体会话(SMTC)实时读取 QQ音乐、
  网易云音乐、酷狗、酷我、汽水音乐等客户端的播放状态(曲目/进度/播放状态/
  播放模式),并可直接控制(上一首/播放暂停/下一首)。点击岛体音乐图标在
  "系统监听 ↔ 本地播放器" 间切换,切换时**双向暂停**(切走的一方自动暂停,
  避免双声齐响)。
- **本地播放器**:播放列表只含用户上传的音乐(内置测试曲目已移除);
  展开面板主体在空列表时直接显示上传入口。支持顺序/单曲循环/随机模式,
  上传曲目持久化保存。
- **主题色自定义**:展开面板 → 调色盘按钮进入主题色视图——左侧预设色板
  (跟随播放模式 + 7 常用色),右侧常驻 RGB 数字输入(输入即生效,无弹出层);
  切换颜色时岛体触发柔和涟漪动画。主题色持久化。
- **歌词字幕**:展开面板自动查询网易云歌词,当前句高亮。
- **时间粒子**:拖动进度条时文字区显示粒子拼成的时间(高密度粒子,清晰)。

## 已知限制

- 进度条拖动跳转依赖客户端支持 SMTC 跳转(QQ音乐不支持,操作后底部提示)。
- 播放模式(循环/随机):本地播放器始终有效;外部平台走 SMTC 新版 API
  (TryChangeAutoRepeatModeAsync/TryChangeShuffleActiveAsync),客户端不支持时
  指令被拒并提示,灵动岛显示系统真实模式状态。
- **播放列表无法与外部平台双向同步**:SMTC 系统 API 不提供播放列表读取/
  写入能力(仅当前曲目/进度/控制),播放列表只对本地播放器有效。
- 系统媒体读取依赖 Windows 10/11 的 WinMetadata(System32\WinMetadata)。

## 开发与构建

要求:Node.js(见 `.nvmrc`)+ [pnpm](https://pnpm.io)

```bash
pnpm install
pnpm dev            # 仅 Vite 开发服务器(浏览器调试挂件页面)
pnpm dev:widget     # 构建挂件页面并启动 Electron(调试用,任务栏图标为 Electron 默认)
pnpm dist:win       # 完整打包:挂件页面 + 桥接 + 图标 → release/
```

常用脚本:

| 命令 | 作用 |
| --- | --- |
| `pnpm build` | 类型检查 + 构建 Web 版 |
| `pnpm lint` | Oxlint 静态检查 |
| `pnpm bridge` | 运行系统媒体桥接脚本(独立调试 SMTC) |
| `pnpm build:widget` | 仅构建挂件页面 |
| `pnpm make:icon` | 由 `icon.png` 重新生成应用图标 |

## 目录结构

```
dynamic-island/
├── src/                     Web 版 React 应用(演示/开发用)
├── widget/                  挂件 React 入口(仅渲染灵动岛)
│   └── WidgetApp.tsx        数据源切换/主题色/穿透/右键拖拽/提示
├── electron/
│   ├── main.cjs             Electron 主进程(窗口/托盘/穿透/拖拽/桥接调度)
│   ├── preload.cjs          预加载脚本(window.desktop API)
│   ├── bridge.cjs           系统媒体桥接(esbuild 打包产物)
│   ├── smtc-reader.ps1      PS 5.1 + csc 编译 C# 的 SMTC 读取器
│   ├── smtc-bridge.cs       强类型 SMTC 桥接(Windows 11 26100 新版 API)
│   └── icon.ico             exe 图标(由 icon.png 生成的多尺寸 ICO)
├── scripts/
│   ├── build-electron.mjs   桥接打包 + 图标生成
│   ├── make-icon.cjs        用户图标(项目根 icon.png)优先,否则 favicon.svg
│   └── make-ico.cjs         生成多尺寸 ICO(绕开 electron-builder 图标转换缓存)
├── public/                  静态资源(favicon、示例音乐)
├── vite.config.ts           Web 版构建配置
├── vite.widget.config.ts    挂件构建(mode=widget:空内置歌单、剔除 music 资源)
├── electron-builder.yml     打包配置(NSIS + portable)
└── WIDGET-README.md         挂件内部实现的技术笔记(详见下文)
```

## 技术备注

- **SMTC 读取**:Windows 11 26100 的 SMTC API 已重构(GetGlobalPropertiesAsync →
  TryGetMediaPropertiesAsync,GetPlaybackInfo/GetTimelineProperties 同步化,
  新增 TryChangeAutoRepeatModeAsync/TryChangeShuffleActiveAsync)。PS 5.1 无法
  绑定 WinRT 集合元素(__ComObject),桥接用 csc.exe 编译强类型 C#
  (引用 System32\WinMetadata 契约 + System.Runtime facade),
  异步等待用轮询 Status/GetResults(3s 超时防卡死)。
- **播放状态同步**:SMTC PlaybackStatus 双向校准(新版 API 实测可信),
  切歌乐观更新播放态。
- **图标**:用户指定的项目根 `icon.png` 优先,`make-ico.cjs` 生成 16~256
  多尺寸 ICO 供 electron-builder 直接嵌入(绕过其 png→ico 转换缓存问题)。
- **透明窗口稳定性**:禁用硬件加速(避免半透明区域 alpha 突变),
  岛体背景全不透明,动画去掉逐帧 blur(卡顿主因)。
- **拖拽**:绝对定位(窗口 = 鼠标 - 按下偏移)+ 过滤合成事件,防止
  "鼠标没动窗口自平移";屏幕工作区钳制。

更详细的实现笔记见 [WIDGET-README.md](WIDGET-README.md)。

## License

Copyright © 2026。仅供个人学习与使用。
