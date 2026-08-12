# 灵动岛桌面挂件 — 部署与调试说明

本文档是**桌面挂件版**(widget/ 入口 + Electron 主进程)的运行、开发与
调试说明,面向维护者。用户使用指南见 [README.md](README.md);
完整技术文档(架构/实现/踩坑/测试,约 3000 行)见 [docs/TECH.md](docs/TECH.md);
引擎级操作手册(逐条踩坑实录)见 [CLAUDE.md](CLAUDE.md)。

---

## 目录

- [文档分工](#文档分工)
- [运行与退出](#运行与退出)
- [挂件版与 Web 演示版差异](#挂件版与-web-演示版差异)
- [开发调试](#开发调试)
- [UI 巡检(WIDGET_SCREENSHOT)](#ui-巡检widget_screenshot)
- [常见调试场景](#常见调试场景)
- [技术债务与明确不做项](#技术债务与明确不做项)

---

## 文档分工

| 文档 | 面向 | 内容 |
| --- | --- | --- |
| README.md | 用户 | 功能/使用指南/FAQ |
| **本文档** | 挂件维护者 | 运行、调试、巡检 |
| docs/TECH.md | 工程师 | 完整技术文档(架构/数据流/How-To/速查表) |
| CLAUDE.md | Claude Code | 引擎级操作手册(踩坑实录/测试断言/约束) |

---

## 运行与退出

- 挂件是**托盘常驻程序**:窗口隐藏到托盘后不会自退,退出必须右键托盘
  →「退出」(app.quit;before-quit 清理 Agent 引擎/子进程并 flush 配置)。
- 窗口位置每次启动顶部居中,不持久化。
- 单实例:重复启动会激活已有实例(锁文件)。

## 挂件版与 Web 演示版差异

| 项 | Web 版(src/) | 挂件版(widget/) |
| --- | --- | --- |
| 构建 | vite.config.ts | vite.widget.config.ts(`--mode widget`,`base='./'` file:// 可加载) |
| 内置歌单 | 完整 MP3 | **空**(产物剔除 music 资源;不带 --mode widget 会把 MP3 打进歌单而音频又被 closeBundle 删掉 → 损坏曲目) |
| 媒体数据 | 模拟/本地 | useSystemMedia(SMTC)+ useMediaPlayer 双轨 |
| 设置桥 | 不注册 | registerIslandSettingsBridge(LLM 设置工具入口) |
| 窗口 | 普通页面 | 透明无边框 + 点击穿透 + 右键长按拖拽 |
| 滚动动画 | 平滑 + 高斯模糊 | 直接跳底(软件渲染零动画成本) |

**行为差异全部靠 CSS 覆盖(widget.css 的 `.widget-stage` 选择器)与可选
props 区分**——改动共享组件时必须同时考虑两端调用方(App.tsx /
WidgetApp.tsx)。

---

## 开发调试

### 常用命令

```bash
dev.bat              # 一键重新构建并启动(双击即可):先结束残留旧实例
                     # (单实例锁,不结束则新启动只唤起旧窗口),再跑
                     # pnpm dev:widget;真实逻辑在 scripts/dev.mjs
                     # (bat 纯 ASCII 壳,中文逻辑在 Node——cmd 分块读
                     # 取批处理,chcp 65001 前缓冲的中文行会乱码,实测)
pnpm dev:widget      # 构建挂件页面 + 启动 Electron(日常调试主入口;
                     # 已前置 build:electron,改 electron/agent/*.ts 不会
                     # 静默跑旧 bundle)
pnpm watch:electron  # 热重建 Agent 引擎/桥(监听 electron/agent/*.ts,
                     # 自动 esbuild 重建 + 重启 electron)
pnpm bridge          # 独立运行系统媒体桥接脚本(单独调试 SMTC)
node scripts/apply-hevc-electron.mjs  # HEVC 解码补丁(2026-08-12):dev.bat
                     # [1.5/3] 自动检测应用——把自编译产物(C:\electron-hevc-dist,
                     # 与官方 43.2.0 同 tag 构建,ffmpeg 软解 + media 门控补丁)
                     # 的 7 个构建文件换进 node_modules/electron/dist;
                     # --restore 恢复官方版, --check 只查状态;重装
                     # node_modules 后 dev.bat 会自动重新应用
```

### 验证约定(用户要求)

每次优化/修改代码后,自动重新构建并启动实机验证:

1. `pnpm dev:widget`(构建 + 启动 Electron);
2. 实机验证用 `timeout` 包住 electron 在几十秒后自动退出(托盘常驻不会
   自退);
3. 需要截图时配 `WIDGET_SCREENSHOT=<path>`。

**巡检约定**:重新构建程序后**不要自动跑 WIDGET_SCREENSHOT 巡检**——完整
巡检(agent 模式等)只在用户明确要求时执行(每轮全量巡检耗时 8-10 分钟且
依赖真实 LLM);默认完成标准 = 构建 + dev:widget 启动 + 类型检查 + lint +
单测(`tsc -b tsconfig/tsconfig.json` / `pnpm lint` / `node tests/test-agent-core.mjs`)。

### 主进程 IPC 调试

- 所有渲染端可调通道统一 `safeHandle(channel, fn)` 包装,错误返回
  {error}(不再 unhandled rejection);
- 窗口 IPC 统一 isDestroyed 防护 + 主进程 uncaughtException/
  unhandledRejection 兜底(退出/销毁竞态下在途 IPC 会抛原生异常);
- 通道清单与参数见 [docs/TECH.md](docs/TECH.md) 附录 E。

### 杀残留进程

```powershell
powershell Stop-Process -Name electron
```

单实例锁 + 上轮 timeout 只杀 pnpm 不杀 electron 的残留进程时,先杀再跑。

---

## UI 巡检(WIDGET_SCREENSHOT)

主进程注入式 UI 巡检(`tests/screenshot-tests.cjs`,deps 注入;
WIDGET_SCREENSHOT 六种巡检模式 ~1160 行已从 main.cjs 抽离)。

### 环境变量

| 变量 | 说明 |
| --- | --- |
| WIDGET_SCREENSHOT | 截图输出路径(加载后自动截图) |
| WIDGET_SCREENSHOT_MODE | 巡检模式(见下表);**probe-clear** = 新对话后窗口扁平回归探针, **probe-evolve** = 记忆进化垂直细分整合实测探针(真实 LLM,4 轮) |
| WIDGET_SCREENSHOT_QUIT | **必须带 1**:巡检完成后优雅退出(app.quit)——应用托盘常驻不自退,用 timeout/taskkill 强杀进程树会让子进程(bridge/GPU/renderer)打出 "renderer gone: crashed" 假象(实测误导) |
| WIDGET_MOCK_SERVER | mock MCP 服务器路径(agent 巡检段 3 真实连接) |
| WIDGET_HEVC_VIDEO | hevc-frame 巡检的待测视频路径(缺省 bili Hi-res 20230404 HEVC 文件) |

### 巡检模式

| 模式 | 内容 |
| --- | --- |
| (默认) | mini:视频岛/图片岛 UI(封面/自定义控件/折叠模式/全屏泄漏/退出位置) |
| expanded | 展开态截图 |
| layout | 面板各区域几何 JSON(布局验证) |
| theme / stress / test | 主题 / 压力 / 基础 |
| agent | Agent 全链路:设置表单/四区断言/MCP mock 连接/记忆增删/记忆类型滚轮/进化/设置工具端到端(段 4.7)/快捷切换按钮(sendInputEvent 注入真实鼠标,段 4.5)/主动陪伴消息(段 4.8)/10 秒真实调度链路(段 4.9) |
| chat-media | 对话媒体:MediaRecorder 录真实 webm 注入 → 断言消息气泡/video/可见高度;优先扫描 `C:\Program Files\JiJiDown\Download` 真实 mp4/mp3(不可读回退 webm) |
| media-lib | 多媒体库:面板/试听自动播放/编辑动画/宽度对齐/右键菜单应用背景/视频 autoPlay(79 用例) |
| hevc-frame | HEVC/AV1 播放验证(2026-08-11 建为黑屏诊断,08-12 改断言):注入本地视频 → 轮询帧呈现(rVFC/总帧数/错误文案)——断言**帧数持续增长** = PASS(HEVC 走自编译 ffmpeg 软解,与 H.264/AV1 同判据);出现 code 9 错误文案 = 未应用 HEVC 补丁(apply-hevc-electron.mjs) |
| skill-delete-check | 技能彻底删除:预置测试技能 → agentSkillDelete → 断言目录已删/其它技能不受影响/非法 slug 被拒 |

### 运行示例

```bash
# mini 巡检(截图 + 退出)
WIDGET_SCREENSHOT=D:/tmp/shot.png WIDGET_SCREENSHOT_QUIT=1 pnpm dev:widget
# agent 全链路巡检(mock MCP + 退出)
WIDGET_SCREENSHOT=D:/tmp/agent WIDGET_SCREENSHOT_MODE=agent \
  WIDGET_SCREENSHOT_QUIT=1 WIDGET_MOCK_SERVER=tests/mocks/mock-mcp-stdio.cjs \
  pnpm dev:widget
```

### 巡检与真实 LLM

- agent 巡检段 3/4.9/5 依赖**真实 LLM**(巡检要求 API Key 已配置);
- 段 4.7 直接调主进程 runIslandSettings 绕开 LLM 保证确定性;前后状态
  备份恢复(设置项 + 背景双槽位 IndexedDB 原图,测试条目按「巡检测试」
  名前缀删除),不残留用户数据;
- 巡检"卡住"排查:agent 巡检部分段有静默轮询(真实 LLM 判断),每 10s
  输出进度日志。

---

## QQ 机器人(NapCat)调试

- 对话里"开启 QQ 机器人"→ 连接 ws://127.0.0.1:3001(可改);"QQ 连上了吗"查状态;
- 消息链路:QQ 消息 → 系统通知 + 对话窗口(带来源标签)→ LLM 处理 → 回复发回(群回复走 `send_group` 工具,文件走 `upload_group_file` 上传本体);
- 工具记忆:`userData/napcat-contacts.json`(联系人)/ `napcat-chats.json`(聊天记录备份)/ `napcat-personas.json`(会话人格);
- 启用前停用旧 Python 桥(`NapCatQQNode/bridge/qq_bridge.py` 进程),避免双回复。

## 常见调试场景

| 场景 | 做法 |
| --- | --- |
| 改了 electron/agent/*.ts 没生效 | 重跑 build:electron(dev:widget 已前置;或 watch:electron) |
| 窗口越拖越大 | 全屏期间 setWinSize 出口(fsLockedSize + resize 校正,见 TECH.md 6.11) |
| 透明窗口布局漂移 | 垂直居中用 transform: translateY(-50%),不用 translate 属性 |
| 点击穿透点不到 | 鼠标悬停岛体(岛体 mouseenter 切换接收鼠标) |
| 视频"无法播放" | HEVC 报错 = 未应用 HEVC 补丁(dev.bat 自动应用;手动 `node scripts/apply-hevc-electron.mjs`,回退 `--restore`);mkv/avi/flv 等容器/编码不支持;island-media 协议 Range 正常与否看主进程日志 |
| LLM 设置工具报「未知的操作」 | main.cjs ISLAND_SETTINGS_OPS 白名单漏加(新增操作三处同步:工具 op + 桥方法 + 白名单) |
| 歌词 API 切换不生效 | 检查 widget-lyric-auto 开关与 provider 选择(切换即刷新,key 含 provider) |
| 主动陪伴不触发 | 检查开关/间隔/模式/历史;judge 失败按 should:false(安全侧) |
| 全屏后退出位置不对 | preFsBounds 完整恢复;widget:fullscreen(fs, isMini) 仅 mini 扩展工作区 |

---

## 技术债务与明确不做项

- 手势/展开状态机未抽 hook(350 行,历史 bug 密集无测试,收益与风险不成
  比例);
- main.cjs 全量 CJS 拆分未做(先抽测试块,文件继续膨胀再拆);
- 双岛并存模式(dual)是**设计文档,未实现**——全仓库零匹配,勿按"已落地"
  推进(见 TECH.md 19.1);
- 明确不做:App/WidgetApp 宿主接线工厂、状态文案双源合并、面板视图注册表
  (收益<风险,记录在案避免反复评估)。

---

## 更新记录

- 2026-08-10:重写为挂件部署/调试说明(原"实现技术笔记"内容并入
  docs/TECH.md);新增 get_feature_guide 工具。
