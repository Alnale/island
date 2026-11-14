# 灵动岛质量与可靠性整改 SPEC

> 状态：Proposed  
> 日期：2026-08-29  
> 建议目标版本：V3.2（P0/P1）与 V3.3（结构重构）  
> 适用范围：Electron 主进程、React/Vite 渲染端、Agent/MCP、安装与发行、测试与文档

## 1. 背景

当前版本已经具备完整的音乐挂件、Agent、MCP、技能、NapCat、多媒体库和安装器能力，但存在以下系统性问题：

1. “清除全部数据”未覆盖设置备份、会话审计日志和隐私配置，存在数据恢复与隐私残留。
2. 多供应商 API Key、MCP headers/env 等嵌套敏感字段没有完整加密。
3. MCP SSE 在初始化通知与销毁并发时可能产生未处理的 `AbortError`。
4. 主程序、安装器、卸载器重复携带 Electron，发行体积远超桌面挂件的合理范围。
5. Electron 主进程和多个 React 组件过度集中，严格类型、错误隔离和测试入口不足。
6. 隐藏手势、窗口位置恢复、多显示器与首次使用引导不完整。
7. 会话日志无限追加、主包缺乏明确性能预算、发行签名与更新链路。

本 SPEC 将这些问题收敛为可排期、可测试、可回滚的整改方案。

## 2. 产品原则与非目标

### 2.1 必须保持的产品原则

- Agent 是本机个人助手，默认拥有执行命令、读写用户文件、调用 MCP/技能的完整能力。
- 不新增逐命令确认，不把 `confirmExec` 改为默认开启，不引入文件系统或命令沙箱。
- 不删除 Agent、NapCat、主动陪伴、本地模型、MCP、技能或媒体控制能力。
- 音乐模式与 Agent 模式的现有视觉、动画和主要手势语义保持兼容。
- HEVC 能力继续可用，但补丁必须转为构建期产物，不在用户安装目录保留官方备份。

### 2.2 非目标

- 本期不重新设计 LLM 工具权限模型。
- 本期不更换 React、Vite 或 Electron 技术栈。
- 本期不把桌面应用改成 Web 服务，也不引入 React Server Components；Electron 渲染端仍是纯客户端应用。
- 本期不重写 Agent 插件内核，只修正外围生命周期、数据和测试问题。
- 本期不承诺 macOS/Linux；Windows x64 仍是主支持平台，ARM64 作为后续独立项目。

## 3. 成功指标

| 领域 | 当前问题 | 目标指标 |
| --- | --- | --- |
| 数据清除 | 备份、日志、privacy 残留 | 工厂重置后数据清单 100% 不存在，重启不得恢复 |
| 密钥 | 仅顶层 `agent.apiKey` 加密 | 所有 provider Key、MCP env/header 敏感值落盘均为密文 |
| 会话日志 | 单文件无限同步追加 | 最多 3 个文件、总量不超过 24 MB、默认保留不超过 7 天 |
| MCP SSE | Node 24 下出现未处理 AbortError | Node 22 与 Electron Node 24 全套核心测试 100% 完成 |
| 发行体积 | 当前安装目录约 1.16 GB | 默认安装目录不超过 450 MB，下降至少 60% |
| 安装器 | 当前目录约 1.73 GB | 单文件安装器不超过 300 MB，下降至少 80% |
| 运行时重复 | 主程序/安装器/卸载器各一套 Electron | 安装目录仅一套 Electron；安装/卸载器不携带 Electron |
| 类型安全 | `strict` 未启用，主进程 CJS 巨型文件 | 新模块全部 strict；最终主进程 TS strict 通过 |
| 前端可靠性 | 无 Error Boundary | Agent、Markdown、设置、媒体四个关键边界均可局部恢复 |
| 测试 | 无统一 `pnpm test`、无 CI | `pnpm check` 一条命令完成静态检查、单测、组件测试、核心测试 |
| 空闲性能 | 无正式预算 | 稳态 CPU 平均低于 1%，主进程+渲染端 RSS 目标低于 350 MB |
| 窗口体验 | 不恢复位置，可拖出屏幕 | 多显示器位置恢复；至少 32 px 可见；托盘可一键复位 |

体积与性能指标以 Windows 11 x64、正式 release 构建、默认工具集为测量基线。

## 4. 优先级与交付阶段

| 优先级 | 工作包 | 建议版本 | 阻塞关系 |
| --- | --- | --- | --- |
| P0 | 数据清除、日志生命周期、密钥加密迁移 | V3.2.0 | 无，必须最先完成 |
| P0 | MCP SSE 生命周期与 Node 24 回归 | V3.2.0 | 先补测试再修改 |
| P1 | 单运行时发行、原生安装/卸载、签名基础 | V3.2.0 | 依赖稳定构建基线 |
| P1 | 统一测试入口与 CI | V3.2.0 | 各工作包共同依赖 |
| P1 | Electron 主进程域拆分、IPC 类型化 | V3.3.0 | 依赖 P0 回归测试 |
| P1 | React 组件拆分、Error Boundary、懒加载 | V3.3.0 | 依赖组件测试 |
| P2 | 多显示器、首次引导、手势可发现性 | V3.3.0 | 可与结构重构并行 |
| P2 | 性能预算、自动更新、文档与合规 | V3.3.x | 依赖新发行结构 |

## 5. 工作包 A：数据生命周期与工厂重置

### 5.1 目标

“清除灵动岛数据”必须成为真正的工厂重置：执行成功后，任何应用自有配置、身份信息、对话、记忆、日志、备份和渲染端存储都不能在重启后恢复。

### 5.2 单一数据清单

新增 `electron/data/data-manifest.ts`，成为应用数据所有权的唯一权威。禁止各处自行维护删除列表。

建议清单：

```ts
interface DataManifestEntry {
  id: string
  scope: 'factory' | 'tools'
  kind: 'file' | 'directory' | 'renderer-local-storage' | 'renderer-indexed-db'
  relativePath?: string
  databaseName?: string
  required: boolean
}
```

`factory` 至少包含：

- `settings.json`
- `settings.json.bak`
- `settings.json.tmp`
- `privacy.json`
- `memory.json`
- `memory-state.json`
- `memory-snapshots/`
- `evolution.json`
- `session-log.jsonl` 及全部轮转文件
- `napcat-contacts.json`
- `napcat-chats.json`
- `napcat-personas.json`
- `napcat-seen.json`
- `napcat-sessions.json`
- `napcat-media/`
- `undo-snapshots.json`
- 以后新增的应用数据文件
- 所有 `widget-*` localStorage
- 当前五个 IndexedDB 数据库及未来通过清单注册的数据库

`tools` 包含：

- `bili/`
- `xxt-profile/`
- `xxt-screenshots/`
- DocFlow 输出、临时文件、上传缓存和数据库
- 后续工具通过清单注册的运行时目录

### 5.3 工厂重置协议

新增 IPC：

```ts
type ResetScope = 'factory' | 'tools'

interface ResetRequest {
  scope: ResetScope
  requestId: string
}

interface ResetEntryResult {
  id: string
  status: 'deleted' | 'not-found' | 'failed'
  error?: string
}

interface ResetResult {
  ok: boolean
  requestId: string
  entries: ResetEntryResult[]
  restartRequired: boolean
}
```

执行顺序固定为：

1. 主进程设置 `resetInProgress`，拒绝新的 Agent 回合、配置写入和后台任务。
2. 发送 `data:prepare-reset` 给渲染端。
3. 渲染端停止播放器、关闭 IndexedDB 连接、清除 localStorage 和已登记数据库，返回逐项结果。
4. 主进程停止 NapCat、MCP、Agent、会话日志写入器、媒体桥和设置防抖写入。
5. 调用 `settingsStore.destroy()`，取消 pending flush 并清空内存明文。
6. 按数据清单逐项删除，所有路径先解析并验证位于 `app.getPath('userData')` 内。
7. 二次验证所有 `required` 项均不存在。
8. 成功时执行 `app.relaunch()` + `app.exit(0)`，不再仅刷新渲染页。
9. 失败时显示逐项失败原因；不得显示“已全部清除”。再次执行必须幂等。

不得使用模糊 glob 删除；目录删除只能针对数据清单中解析后的绝对路径。

### 5.4 UI 语义

数据管理页拆为两个明确动作：

- **恢复出厂设置**：清除全部灵动岛数据，包括 API Key、主人 QQ、对话审计日志和备份。
- **清除工具数据**：仅清理下载、登录态、截图和工具临时文件。

恢复出厂设置采用以下确认文本：

> 将删除全部配置、API Key、主人身份、对话、记忆、媒体库和本地审计日志。应用将自动重启，此操作不可恢复。

确认按钮仍采用两段式，但确认窗口由 3.5 秒调整为 10 秒，避免用户来不及阅读。

### 5.5 验收标准

- 预置 `settings.json.bak` 后执行工厂重置，重启不得恢复设置。
- 预置 `privacy.json`、会话日志和五个 IndexedDB 后均被清除。
- 重置过程中故意锁定一个文件，UI 必须报告失败项，不能显示成功。
- 连续执行两次工厂重置均不抛异常。
- 所有删除目标均通过“位于 userData 内”的路径断言。
- 自动化测试不得访问真实用户目录，必须注入临时 userData。

## 6. 工作包 B：敏感配置完整加密

### 6.1 目标

在不改变运行时配置接口的前提下，保证所有应用托管的凭据在磁盘上均不可读。内存中的 `AgentConfig` 继续使用明文，避免修改所有 provider 接口。

### 6.2 设置格式 V4

新增：

```json
{
  "settingsSchemaVersion": 4,
  "agent": {
    "activeProvider": "deepseek",
    "providers": {
      "deepseek": {
        "apiKey": "enc:v1:<base64>",
        "baseURL": "https://api.deepseek.com",
        "model": "..."
      }
    }
  }
}
```

必须加密的字段：

- `agent.apiKey`（旧兼容镜像）
- `agent.providers.*.apiKey`
- `agent.mcpServers[*].env` 的全部 value
- `agent.mcpServers[*].headers` 的全部 value
- 后续在 `SECRET_PATHS` 注册的字段

不需要加密的字段：provider id、baseURL、model、MCP name/type/command/args/url、普通 UI 配置。

### 6.3 SecretCodec

新增 `electron/data/secret-codec.ts`：

```ts
interface SecretCodec {
  seal(value: string): string
  open(value: string): string
  isSealed(value: string): boolean
  redact(value: unknown): unknown
}
```

要求：

- 使用 Electron `safeStorage`；Windows 下由 DPAPI 提供用户级保护。
- 密文统一为 `enc:v1:` 前缀，预留算法版本。
- `seal`、`open` 失败必须返回结构化错误，不得静默回退明文。
- `safeStorage` 不可用时，非敏感配置仍可保存，密钥只保留当前会话并在 UI 明确提示“无法安全持久化”。
- 所有日志、异常和 IPC 诊断输出必须经过 `redact()`。

### 6.4 明文迁移

首次加载 V3 设置时：

1. 读取主文件和 `.bak`。
2. 识别所有明文敏感字段。
3. 在内存解出正常 `AgentConfig`。
4. 生成完整 V4 密文文档。
5. 写入 `.tmp`，fsync 后原子替换主文件。
6. 删除旧 `.bak`，用已经加密的主文件重新生成 `.bak`。
7. 扫描主文件、备份和临时文件，不得出现已知明文密钥。

迁移是幂等的；`enc:v1:` 字段不得二次加密。

### 6.5 验收标准

- 四个 provider 分别保存不同 Key，磁盘搜索不得出现任何明文。
- MCP headers/env 中放入测试 Token，主文件、备份、日志均不得出现明文。
- 从旧版明文配置升级后，功能配置保持一致。
- 更换 Windows 用户或 DPAPI 无法解密时，UI 引导重新输入，不得把密文当 Key 请求供应商。
- 工厂重置删除主文件、备份和临时文件。

## 7. 工作包 C：会话审计日志生命周期

### 7.1 保留的架构约束

继续保持“Model-visible ⟺ Logged”，但从无限单文件同步追加改为有界、异步、可清除的本地审计存储。

### 7.2 新日志存储

新增 `RotatingSessionLogSink`：

- 当前文件：`session-log.jsonl`
- 历史文件：`session-log.1.jsonl`、`session-log.2.jsonl`
- 单文件上限：8 MB
- 总上限：24 MB
- 默认保留：7 天
- 写入：内存队列 + 250 ms 批量异步 flush
- 队列上限：1000 条；超过上限时记录一次 dropped 计数，不阻塞 Agent 回合
- 退出：最多等待 1 秒 flush，超时则放弃剩余诊断日志

日志内容处理：

- 图片和二进制继续只记录长度占位符。
- 使用 `SecretCodec.redact()` 清除已知 API Key、Authorization、Cookie、MCP env/header 值。
- 工具输出超过 20 KB 时记录摘要、总长度和首尾片段，不重复写入完整大文件。
- 每条记录增加 `schemaVersion`、`appVersion` 和 `providerId`。

### 7.3 用户可见能力

数据管理页增加：

- 当前日志占用大小。
- “清除审计日志”按钮。
- “本地审计日志”开关，默认开启；关闭时使用有界内存 sink，退出即丢弃。
- 简短隐私说明：日志可能包含对话和模型可见上下文，仅保存在本机。

### 7.4 验收标准

- 连续写入 100 MB 模拟数据，磁盘最终不超过 24 MB + 一个写入缓冲文件。
- 主进程事件循环不得因 `appendFileSync` 出现明显阻塞。
- 日志中不得出现测试 API Key、Authorization 或 Cookie。
- 工厂重置和“清除审计日志”均覆盖所有轮转文件。

## 8. 工作包 D：MCP SSE 生命周期修复

### 8.1 根因

当前握手函数把 `notifications/initialized` 定义成同步通知，但 SSE 实现实际返回异步 `post()`；该 Promise 没有等待或捕获。客户端销毁时 AbortController 中止请求，形成未处理的 `AbortError`。

### 8.2 生命周期状态机

每个 transport 使用显式状态：

```ts
type TransportState = 'idle' | 'connecting' | 'ready' | 'closing' | 'closed' | 'failed'
```

规则：

- `connect()` 只允许 `idle/failed → connecting → ready`。
- 并发 `connect()` 共享同一个 Promise。
- `close()` 幂等，先进入 `closing`，再中止请求、取消 reader、拒绝 pending，最后进入 `closed`。
- `closing/closed` 期间产生的 `AbortError` 视为预期终止；其他错误必须上报。
- 每次连接分配 generation id，旧连接事件不得写入新连接状态。

### 8.3 API 调整

将握手通知改为异步：

```ts
protected async handshake(
  doInitialize: () => Promise<unknown>,
  notify: (method: string) => Promise<void>,
  doList: () => Promise<unknown>,
): Promise<void> {
  await doInitialize()
  await notify('notifications/initialized')
  // 然后 tools/list
}
```

同时：

- 保存 `readLoopPromise`，关闭时 `await Promise.allSettled()`。
- `post()` 捕获 AbortError 时检查 state，仅在非 closing 状态抛出。
- `MCPManager.dispose()` 改为返回 `Promise<void>`。
- `AgentEngine.dispose()` 同步升级为异步。
- 主进程退出流程设置 2 秒上限等待 Agent、MCP、日志和设置落盘；超时后强制退出。

### 8.4 测试矩阵

必须覆盖：

- 初始化后立即 dispose。
- initialized POST 尚未完成时 dispose。
- GET SSE 流先断开。
- POST 先失败。
- 四个并发 connect，只产生一个会话。
- dispose 两次。
- dispose 后重新 connect。
- Node 22 CLI。
- Electron 43 `ELECTRON_RUN_AS_NODE=1` 对应的 Node 24。

任何测试不得遗留未处理 rejection、活动端口或子进程。

## 9. 工作包 E：发行结构与体积治理

### 9.1 新发行拓扑

安装目录只允许一套 Electron：

```text
灵动岛/
├── 灵动岛.exe
├── *.dll / locales/
├── resources/
│   ├── app.asar
│   ├── app.asar.unpacked/
│   │   ├── system-media-bridge.cjs
│   │   ├── *.ps1 / smtc-bridge.exe
│   │   └── native-tools/
│   └── tools/
│       ├── bili/bili-tool.exe
│       └── docflow/<运行所需文件>
└── uninstall.exe
```

禁止进入正式产物：

- `electron.exe.official`
- `*.official`
- 第二套 Electron runtime
- Electron 版安装器或 Electron 版卸载器
- `tests/`、截图巡检代码
- TypeScript 源码、工具开发源码、构建脚本
- 调试日志、下载记录、Cookie、模型缓存
- 非目标架构二进制和不需要的 locale

### 9.2 HEVC 产物

- HEVC Electron 在构建机生成并做 SHA-256 校验。
- 发布 staging 直接使用已经补丁化的 runtime。
- 不再在用户机器上执行 apply/restore，也不携带官方 runtime 备份。
- 发布清单记录 Electron tag、补丁 commit、ffmpeg 配置和所有替换文件哈希。
- HEVC 许可与分发义务在 release gate 中由维护者确认，结果记录在 `docs/THIRD_PARTY_NOTICES.md`。

### 9.3 原生安装/卸载

改用原生 Windows 安装器工具生成单文件安装包：

- 安装器只负责解压/复制、快捷方式、开机自启和卸载项。
- 卸载器由安装器工具原生生成，不携带 Chromium/Electron。
- 安装前校验包哈希，安装后校验主程序和资源文件。
- 升级安装保留 userData，卸载页提供“同时删除个人数据”复选框，默认不勾选。
- 卸载选择删除个人数据时，调用与工作包 A 同一份数据清单，不能维护第二套列表。

### 9.4 app.asar 与 unpack

打入 `app.asar`：

- `electron/main` 编译产物
- preload 编译产物
- Agent 编译产物
- `dist-widget`
- package metadata

必须 unpack：

- 被 `spawn` 的 exe、PowerShell、C# 编译产物
- 需要随机读写或被外部程序访问的工具文件
- 自定义协议直接流式读取的用户媒体不属于安装目录，不受 asar 影响

### 9.5 体积门禁

新增 `scripts/audit-release.mjs`：

- 输出总大小和按目录 Top 30。
- 按 SHA-256 查找大于 1 MB 的重复文件。
- 检测 `.official`、tests、源码和敏感运行时文件。
- 校验安装目录仅存在一个 Electron 主程序。
- 超预算直接令 release 构建失败。

预算：

- 默认安装目录 ≤ 450 MB。
- 完整工具安装目录 ≤ 520 MB。
- 单文件默认安装器 ≤ 300 MB。
- 任意两个大于 10 MB 的同哈希文件不得重复存在，明确白名单除外。

### 9.6 签名与更新

发布通道分为：

- `dev`：允许未签名，仅本机使用。
- `release`：必须 Authenticode 签名；缺少证书时构建失败。

自动更新最小版本：

- HTTPS 获取签名 manifest。
- manifest 包含 version、channel、URL、SHA-256、size、minimumVersion、releaseNotes。
- 下载完成后验证哈希和签名，再交给原生更新器替换。
- 默认仅提示，不静默强制更新；设置页支持手动检查。
- 首版可采用完整包更新，差分更新后续实现。

## 10. 工作包 F：Electron 主进程与 IPC 重构

### 10.1 目标目录

```text
electron/
├── main/
│   ├── bootstrap.ts
│   ├── app-lifecycle.ts
│   ├── window/
│   ├── tray/
│   ├── ipc/
│   ├── data/
│   ├── media/
│   ├── agent-host/
│   └── napcat-host/
├── preload/
│   ├── index.ts
│   └── desktop-api.ts
└── agent/
```

边界：

- `bootstrap.ts` 仅装配，不写业务逻辑，目标不超过 250 行。
- 窗口尺寸、拖拽、全屏、显示器属于 `window/`。
- settings/secrets/reset/log 属于 `data/`。
- Agent 引擎不直接 import BrowserWindow、Tray 或 ipcMain。
- NapCat 路由和会话持久化不放在 bootstrap。
- preload 只暴露类型化 API，不允许任意 channel 透传。

### 10.2 IPC 合约

新增 `shared/ipc-contract.ts`，主进程、preload、渲染端共用：

```ts
interface InvokeChannels {
  'agent:config-get': { request: void; response: AgentConfig }
  'data:reset': { request: ResetRequest; response: ResetResult }
  // ...
}
```

要求：

- 每个 invoke/send channel 都有 request/response 类型。
- 主进程入口对 renderer 参数做运行时校验，未知字段拒绝。
- IPC 错误统一为 `{ code, message, retryable, details? }`。
- 配置与敏感数据 IPC 返回前必须经过显式 DTO 转换；不得把 settings 原对象直接暴露。
- 所有 handler 注册返回 disposer，窗口/测试销毁时可完整卸载。

### 10.3 TypeScript 严格化

分阶段开启：

1. 新目录立即启用 `strict: true`。
2. 迁移 main/preload 到 TS 编译产物。
3. 全项目开启 `noImplicitAny`、`strictNullChecks`。
4. 最后开启 `noUncheckedIndexedAccess` 和 `exactOptionalPropertyTypes`。

迁移期间禁止在新代码加入 `any`；Electron IPC 外部输入使用 `unknown` 后校验。

文件预算：

- 普通模块目标 ≤ 400 行。
- React 容器目标 ≤ 500 行。
- 单文件硬上限 800 行；超过必须在 PR 中说明并获批准。

## 11. 工作包 G：React 架构与错误隔离

### 11.1 组件拆分

`DynamicIsland` 拆为：

```text
DynamicIsland/
├── DynamicIslandShell.tsx
├── CompactIsland.tsx
├── ExpandedIsland.tsx
├── gestures/useIslandGestures.ts
├── state/islandReducer.ts
├── panels/MusicPanel.tsx
├── panels/AgentPanel.tsx
└── panels/SettingsPanel.tsx
```

`AgentSettingsView` 每个 tab 独立组件：

- `AccountSettings`
- `ModelRoutingSettings`
- `BehaviorSettings`
- `ToolsSettings`
- `MemorySettings`
- `SubAgentSettings`
- `DataManagementSettings`

`Markdown.tsx` 拆为 parser、block renderer、code、image、audio、video、mermaid 等域。媒体状态必须由独立 hook 管理，避免一个组件持有 20+ effect。

### 11.2 状态管理

不引入 Redux。采用 React `Context + useReducer`：

- `IslandUiContext`：展开、面板路由、动画阶段、手势状态。
- `AgentSettingsReducer`：设置草稿、保存状态、测试结果和危险操作确认状态。
- 播放器、Agent、系统媒体继续通过领域 hook 暴露稳定接口。
- 持久化副作用集中在 effect/service，不在 reducer 内直接访问 localStorage 或 IPC。

### 11.3 懒加载

以下面板使用 `React.lazy`：

- Agent 设置
- 多媒体库
- 背景/字体/图片库
- Mermaid 渲染器

紧凑态与基础音乐控制保持首包同步加载。新增 chunk 预算：

- 首屏 JS（不含 React runtime）≤ 350 KB 原始大小。
- 首屏 CSS ≤ 100 KB。
- Mermaid 不得进入首屏依赖图。

### 11.4 Error Boundary

至少建立四个边界：

- 应用根边界：提供“重新加载界面”。
- Agent 面板边界：保留音乐模式可用。
- Markdown/消息边界：单条消息渲染失败时回退纯文本。
- 设置/媒体库边界：提供“重试”与“返回”。

错误边界记录经过脱敏的错误码、组件栈和版本；不得记录 API Key 或完整用户消息。

### 11.5 验收标准

- 人为让 Mermaid、视频组件、设置 tab 抛错，其他功能仍可使用。
- 主要视图视觉截图与当前基线一致，允许已批准的引导改动。
- `DynamicIsland` props 数量显著减少，跨域参数改由领域上下文提供。
- 所有新组件 Props 使用 interface，禁止 `any`。
- StrictMode 下订阅、计时器和 IPC listener 不重复。

## 12. 工作包 H：测试、CI 与可复现基线

### 12.1 统一命令

建议 package scripts：

```json
{
  "test": "pnpm test:unit && pnpm test:core",
  "test:unit": "vitest run",
  "test:component": "vitest run --project component",
  "test:core": "node tests/test-agent-core.mjs",
  "test:runtime": "node scripts/test-electron-node.mjs",
  "test:e2e": "playwright test",
  "typecheck": "tsc -b tsconfig/tsconfig.json",
  "check": "pnpm typecheck && pnpm lint && pnpm test && pnpm test:runtime"
}
```

### 12.2 测试层次

- 单元测试：secret codec、settings migration、data manifest、日志轮转、位置计算、reducers。
- 核心集成：Agent、MCP stdio/SSE、技能、记忆、provider parser。
- 组件测试：设置保存、工厂重置确认、错误边界、消息 Markdown、手势替代入口。
- Electron E2E：首次启动、托盘、展开/收起、跨重启位置恢复、工厂重置、升级安装。
- 发行审计：体积、重复 runtime、敏感文件、签名和启动 smoke。

### 12.3 CI

新增 Windows CI：

1. Node 22 安装依赖。
2. typecheck + oxlint。
3. unit/component/core。
4. 使用 Electron 自带 Node 24 运行 runtime suite。
5. 构建 widget 和 Electron。
6. 无网络 smoke。
7. release 分支执行发行审计和签名校验。

真实 API、真实 QQ、真实 LM Studio 测试全部 opt-in，不进入默认 CI。

### 12.4 覆盖率门槛

- 数据、密钥、MCP 生命周期：语句/分支均 ≥ 90%。
- Agent core：语句 ≥ 80%，分支 ≥ 75%。
- React reducers/hooks：语句 ≥ 80%。
- 纯视觉 CSS 不设覆盖率要求，以截图回归补充。

README 不再手写“当前共有 N 个测试”；由测试命令在 CI artifact 中生成基线报告。

## 13. 工作包 I：窗口、引导与多显示器体验

### 13.1 窗口位置模型

新增：

```ts
interface WindowPlacementV1 {
  version: 1
  displayId: string
  workArea: { x: number; y: number; width: number; height: number }
  normalizedX: number
  normalizedY: number
  width: number
  height: number
}
```

规则：

- 拖拽结束后防抖 300 ms 保存。
- 启动优先匹配 displayId；匹配失败则选择与旧 workArea 重叠最多的显示器，再失败回主显示器。
- 使用 normalizedX/Y 适配分辨率和缩放变化。
- 恢复后钳制位置，至少保证 32×32 px 岛体可见。
- 监听 display-added、display-removed、display-metrics-changed，必要时自动迁回可见区域。
- 托盘增加“重置到主屏顶部中央”。

### 13.2 手势可发现性

保留长按、三连击、滑动和右键长按，不改变熟练用户习惯，同时增加：

- 首次启动非模态三步提示：长按展开、托盘切模式、右键长按移动。
- 提示可跳过，并可从托盘“快捷操作说明”重新打开。
- Agent/音乐切换在托盘和设置中始终有可见入口。
- 键盘 Enter/Space 可展开，Esc 可收起；所有图标按钮有 aria-label。
- 首次引导完成状态使用明确字段 `onboardingVersion`，不再保留无消费者的 `firstRun`。

### 13.3 验收标准

- 双显示器拔掉副屏后，岛体在 1 秒内回到可见区域。
- 125%/150% DPI 切换后位置不跳到屏幕外。
- 工厂重置后首次引导重新出现。
- 关闭再启动恢复同一显示器的相对位置。

## 14. 工作包 J：性能、资源与稳定性预算

### 14.1 可观测指标

新增开发/诊断指标，不默认输出高频日志：

- 启动到 ready-to-show 时间。
- 主进程/渲染端 RSS、heapUsed。
- 10 分钟空闲 CPU 平均值。
- 首包与懒加载 chunk 大小。
- 会话日志写入队列长度和 dropped 数。
- MCP 活动连接、子进程和 pending request 数。

### 14.2 优化动作

- 日志改异步轮转，移除主进程同步大对象追加。
- 设置、媒体库、Mermaid 懒加载。
- 会话列表长到阈值后使用虚拟化或分页，阈值建议 200 条消息。
- 视频/音频组件离开可视区后释放不再需要的 source、timer 和 object URL。
- 审核 `--max-old-space-size=2048`、`--expose-gc` 和手动 GC；在压力测试通过后优先恢复 V8 默认策略。
- 后台节流按功能细分：SMTC/主动陪伴留在主进程，非必要渲染动画在不可见时暂停。
- 生产构建禁用 session-debug、高频窗口尺寸日志和测试模式入口。

### 14.3 性能验收场景

- 空闲 10 分钟。
- 连续播放音乐 30 分钟。
- 500 条 Agent 消息、20 个 Mermaid、10 个视频卡片。
- 4 个 MCP 服务同时连接。
- NapCat 连续接收 1000 条模拟消息。
- 全屏视频与窗口拖拽交替 100 次。

每个场景必须无 OOM、无 renderer crash、无持续增长的 timer/listener/子进程。

## 15. 文档与合规交付

新增或补齐：

- 根目录 `LICENSE`，内容与 README 的 MIT 声明一致。
- `docs/PRIVACY.md`：说明云端 provider、QQ、日志、记忆和本地工具分别处理什么数据。
- `docs/SECURITY.md`：说明高权限 Agent 产品原则、漏洞报告方式和支持版本。
- `docs/THIRD_PARTY_NOTICES.md`：Electron、FFmpeg/HEVC、工具依赖和字体/媒体资源声明。
- `docs/DATA-LIFECYCLE.md`：数据清单、路径、保留周期和工厂重置语义。
- `docs/RELEASE.md`：构建、签名、体积门禁、更新和回滚流程。

正式 release 必须生成 SBOM 或至少依赖与许可证清单，并保存构建哈希。

## 16. 迁移与兼容策略

### 16.1 首次升级顺序

1. 启动最小设置迁移器，不启动 Agent/MCP/NapCat。
2. 迁移并加密 settings V4。
3. 清理旧明文 `.bak/.tmp`。
4. 将旧 session log 纳入轮转；超过上限只保留最新部分，并提示一次。
5. 迁移窗口位置；没有旧数据则保持主屏顶部中央。
6. 完成后才创建窗口和后台服务。

### 16.2 失败处理

- 设置迁移失败：保留原文件的只读副本，进入配置修复页，不启动 Agent。
- 密钥解密失败：保留非敏感设置，清空对应 Key 并提示重新输入。
- 日志迁移失败：隔离为 `.corrupt-<timestamp>`，不阻塞主功能。
- 窗口位置损坏：回退主屏顶部中央。

### 16.3 回滚

- V3.2 写入 settings V4 前保存一次加密后的迁移快照，不保存明文快照。
- 回滚旧版本时 provider 基本配置可读，但旧版本不认识的密文 Key 不应被当作真实 Key发送。
- 因旧版本无法安全理解 V4，正式升级前提示“升级后如回退需重新填写 API Key”。

## 17. 实施顺序与预估

以下为单人开发的粗略工程量，不含代码签名证书采购和 HEVC 法务确认：

1. 测试护栏与复现脚本：1–2 人日。
2. 数据清单、工厂重置、设置 V4、SecretCodec：3–5 人日。
3. 日志轮转与隐私 UI：2–3 人日。
4. MCP SSE 生命周期：1–2 人日。
5. 单运行时 staging、原生安装/卸载、体积审计：4–7 人日。
6. CI、release smoke、签名门禁：2–4 人日。
7. 主进程 TS 域拆分：7–12 人日，分多个小 PR。
8. React 组件拆分与 Error Boundary：7–12 人日，分多个小 PR。
9. 多显示器、首次引导、性能收尾：3–5 人日。

P0/P1 可先在 V3.2 交付，结构重构不得阻塞数据和 MCP 修复。

## 18. PR 拆分建议

每个 PR 必须可独立验证并保持主分支可运行：

1. `test: add data/mcp/runtime regression harness`
2. `fix: encrypt nested provider and mcp secrets`
3. `fix: make factory reset authoritative and complete`
4. `feat: rotate and redact local session logs`
5. `fix: make mcp sse shutdown race-free`
6. `build: stage one electron runtime and audit release size`
7. `build: replace electron installer/uninstaller with native package`
8. `refactor: extract typed main-process data and ipc domains`
9. `refactor: split dynamic island and agent settings state`
10. `feat: restore multi-display placement and onboarding`
11. `build: add signed release and update manifest`

禁止把数据迁移、安装器替换和大型 React 重构放进同一个 PR。

## 19. 总体验收清单

发布 V3.2 前必须全部满足：

- [ ] Agent 默认高权限行为未改变。
- [ ] 工厂重置后主文件、备份、privacy、会话日志和渲染存储全部消失。
- [ ] 所有 provider 与 MCP 敏感值落盘均为密文。
- [ ] Node 22 和 Electron Node 24 核心测试完整通过，无未处理 rejection。
- [ ] 默认安装目录 ≤ 450 MB，安装器 ≤ 300 MB。
- [ ] 安装目录只有一套 Electron，不含 `.official` 和测试源码。
- [ ] `pnpm check` 可在干净环境一条命令完成。
- [ ] release 产物通过敏感文件、体积、重复文件和启动 smoke 审计。

发布 V3.3 前追加满足：

- [ ] Electron 新主进程模块全部 strict TypeScript。
- [ ] 四个 React Error Boundary 生效。
- [ ] 关键巨型组件完成域拆分，无新增超过 800 行文件。
- [ ] 多显示器位置恢复和托盘复位通过 E2E。
- [ ] 首次引导可跳过、可重开、工厂重置后重新出现。
- [ ] 空闲 CPU、RSS 和长会话压力测试达到预算。
- [ ] LICENSE、PRIVACY、SECURITY、THIRD_PARTY_NOTICES、RELEASE 文档齐全。

## 20. 关键决策摘要

- 不削弱 Agent 权限；整改重点是数据、生命周期、发行和工程可靠性。
- 工厂重置由单一数据清单驱动，主程序与卸载器共用。
- 敏感字段使用显式路径加密，安全存储不可用时不明文持久化。
- 会话审计继续保留，但必须有界、脱敏、异步、可清除。
- MCP 生命周期显式状态化，所有异步任务都可等待、可取消、无悬空 Promise。
- 安装目录只保留一套 Electron，安装器和卸载器必须原生化。
- 主进程和 React 重构采用渐进式小 PR，不与 P0 修复绑在一起。
- 测试基线同时覆盖开发 Node 22 与实际 Electron Node 24。
