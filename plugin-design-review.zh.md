# DeepSeek Harness 插件设计哲学审查报告

> 审查对象：`deepseek-harness` 仓库（vendored Cordis 之上的插件化 Agent Harness）
> 审查方式：架构文档 + Cordis 框架源码 + 典型插件实现代码的交叉验证

## 一句话总结

**"Everything is a plugin"**——模型适配器、工具注册表、会话日志、甚至 agent loop 本身全都是插件，因此每一个部分都可以从配置中替换。整个产品没有一个需要打补丁的"特权核心"：扩展方式永远是"在其他插件旁边挂载一个新插件"。

---

## 1. 哲学基石：Cordis 框架的五个核心概念

Harness 的插件机制完全构建在 vendored 的 Cordis 框架之上（源码在 [vendor/cordis/src](vendor/cordis/src)），其哲学可以浓缩为五个概念：

### 1.1 插件 = 实现 Service 的对象

一个插件要么是一个带可选 `inject` 和 `apply(ctx)` 字段的函数/命名空间，要么是 `Service` 的子类。Cordis 负责把它挂载到当前上下文。

代码证据——[vendor/cordis/src/service.ts](vendor/cordis/src/service.ts)：

```ts
export abstract class Service<out T = never> {
  constructor(protected ctx: Context, name: string) {
    // ...
    self.ctx.reflect.provide(name, self, this[symbols.check])
    return self
  }
}
```

`Service` 子类在构造时立即以 `name` 注册进上下文，并随所属 fiber 卸载时自动注销——注册与生命周期由框架统一托管，插件从不自己管理"何时下线"。

### 1.2 上下文 = 服务仓库，按 key 查找而非按实现导入

服务认领一个稳定的 `ctx.<key>`（如 `ctx.tools`、`ctx.llm`、`ctx.sessions`）。其他插件通过 key 发现服务，**永远不 import 具体实现**。

这是解耦的关键手法：TypeScript 声明合并把服务类型"贴"到 `Context` 接口上，例如 [packages/web/web/src/index.ts](packages/web/web/src/index.ts)：

```ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    web: WebRuntime
  }
}
```

任何插件都能以 `ctx.web` 访问该服务，而编译期类型完整、运行期实现可替换。

### 1.3 依赖通过 `inject` 声明，加载顺序由服务可用性驱动

插件声明自己需要哪些服务，Cordis 会等到这些服务存在才激活它。加载顺序不是手工编排的启动序列，而是服务依赖的自然结果。

代码证据——[packages/web/web-search-exa/src/index.ts](packages/web/web-search-exa/src/index.ts)：

```ts
export const inject = ['web']   // 等待 ctx.web 存在才激活

export function apply(ctx: Context, config: Config): void {
  ctx.web.registerSearchProvider(new ExaSearchProvider({ ... }))
}
```

### 1.4 类型化事件作为通信通道

事件名通过 TypeScript 声明合并扩展，按语义选用四种分发模式之一（见 [docs/cordis-primer.md](docs/cordis-primer.md)）：

| 模式 | 是否等待 | 分发顺序 | 有返回值 |
|---|---|---|---|
| `emit` | 否 | 注册顺序观察 | 否 |
| `waterfall` | 否 | 注册顺序包裹 | 是 |
| `parallel` | 是 | 所有监听器并行 | 否 |
| `serial` | 是 | 注册顺序执行 | 是 |

`waterfall` 是 around-middleware 语义：监听器收到 `(...args, next)`，**必须调用 `next()` 委托**，不调用即短路——短路本身也是设计（策略监听器拥有决策权时可以短路）。

### 1.5 注册即可逆效果（Registrations are reversible effects）

提示词段落、工具 schema、适配器、provider、事件监听器，全部通过 `ctx.effect()` / `ctx.on()` 安装，每个注册都返回 disposer；fiber 卸载时按注册的逆序撤销（[vendor/cordis/src/fiber.ts](vendor/cordis/src/fiber.ts)）。这让热重载与拆除可以可预测地回滚一切副作用。

实际例子——web seam 注册 provider 时（[packages/web/web/src/index.ts](packages/web/web/src/index.ts)）：

```ts
const dispose = this.ctx.effect(function* () {
  store.set(provider.id, provider)
  yield () => store.delete(provider.id)   // disposer：自动注销
}, 'web.registerProvider()')
```

---

## 2. 能力接缝（Capability Seam）：三角色模型

这是本仓库最核心的插件设计模式。一个 **seam** 是一个可替换的能力，由三个角色组成，且**三者缺一不可**：

1. **Service Definition**——声明接口（拥有 `ctx.<key>`）
2. **Service Provider**——实现接口
3. **Consumer**——使用该能力（通常是面向模型的工具）

### 2.1 以 `ctx.web` 为例的完整三角色

| 角色 | 包 | 职责 |
|---|---|---|
| Service Definition | [packages/web/web](packages/web/web/src/index.ts) | `WebRuntime extends Service`，拥有 `ctx.web` key，维护 provider 注册表与选择逻辑 |
| Service Provider | [packages/web/web-search-exa](packages/web/web-search-exa/src/index.ts) 等 4 个 | 函数式插件，`inject: ['web']`，向 seam 注册 provider，**不拥有** key |
| Consumer | `dsh-tool-web` | 面向模型的 `web_search`/`web_fetch` 工具 |

Provider 包的模块注释直接点破了哲学：

> *"a search provider does not own the `ctx.web` key — it registers INTO the seam's provider registry, exactly as `dsh-llm-deepseek` registers an adapter into `ctx.llm`. The key is owned by `dsh-web`."*

### 2.2 seam 的选择语义：执行时解析、永不依赖注册顺序、错误配置大声失败

`WebRuntime` 在**调用时**解析 provider，规则完备且每种失败都有专属错误码：

- 配置了 id 但未注册 → `WEB_PROVIDER_CONFIGURED_MISSING`
- 配置了 id 但不可用 → `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`
- 未配置且多个可用 → `WEB_PROVIDER_AMBIGUOUS`（选择永不依赖注册顺序）
- 未配置且零个可用 → `WEB_PROVIDER_UNAVAILABLE`
- 未配置且恰好一个可用 → 自动选中

这体现了两条仓库级约定：**"Misconfiguration fails loud"**（配置错误在最早可解析点大声失败，绝不静默跳过）与 **"Explicit > implicit"**（默认值是拥有方实现里显式的 `resolve(request): Spec` 步骤，而不是 `run()` 里隐藏的 `?? default`）。

### 2.3 seam 的威力：换掉一个 provider，改变整个产品

完整的 seam 图由脚本生成于 [docs/capability-seams.md](docs/capability-seams.md)，涵盖约 50 个 `ctx.*` 服务。其中最能说明问题的例子：

- **文件系统与子进程共享同一个执行世界**：`ctx.fs` 和 `ctx.subprocess` 同时指向 E2B 远程沙箱（`fs-e2b` + `subprocess-e2b`）时，Bash、PTY、LSP 全部跟着迁移到远程 Linux 运行时，**没有任何 provider 需要分叉**。
- **`ctx.subagents` 背后的实现跨度极大**：从进程内新建子 agent（`subagent-spawn-in-process`）到委托给另一款产品的一个回合（`subagent-codex`、`subagent-claude-code`、`subagent-acp`），全都实现同一个接口。
- **`ctx.sessionPersistence` 双后端**：JSONL 与 SQLite 持久化同一套 `SessionEvent` 词汇，应用在组合时选择后端。

---

## 3. 事件即扩展点：三个领域

架构文档（[docs/architecture.md](docs/architecture.md)）把事件定义为"扩展点，选对领域是大多数变更的第一个决策"：

| 领域 | 特征 | 典型事件 |
|---|---|---|
| **Session 事件** | 持久事实，追加进日志并经 `session/event` 广播；必须能在重载后存活 | `turn/*`、`step/*`、`user/message`、`assistant/*`、`tool/*` |
| **Agent 事件** | 携带活的 `Agent`，用于观察或拦截进行中的工作 | `agent/pre-step`、`agent/request`、`agent/turn-stopping` |
| **Capability 事件** | 不导入 loop 即可给 seam 附加策略与适配器 | `fs/*`、`tools/*`、`telemetry/*` |

一个回合的执行流全程由事件串起（waterfall 监听器必须调用 `next()`）：

```text
agent/pre-step          （决定模型看到什么：可改写或拒绝输入）
  step/start
  agent/request → llm/stream → assistant/chunk* → assistant/message
  tool/call* → tools/pre-execute → tools/execute → tools/post-execute → tool/result*
  step/end
agent/turn-stopping     （serial，可终止回合）
```

**"Plugins, not loop changes"**：新行为必须挂在文档化的扩展点上；直接修改 `agent-loop` 本身必须同步更新架构文档。`ctx.agentLoop` 是唯一的具体 loop 插件，扩展包依赖的是事件和服务，而不是这个包。

配套的强约束 **"Model-visible ⟺ Logged"**：任何能到达模型请求的内容必须可以从会话日志重建。这保证了插件注入的一切模型可见输入都可审计、可回放、可 fork。

---

## 4. 组合层：Profile → Bundle → Patch 的配置化装配

运行中的 `dsh` 是启动时由**有序层**组合出来的插件树，完全由声明式配置驱动：

```text
profile 中各 bundle（按声明顺序）→ profile 的 cordis.patch.yml → home 级 patch → --patch overlay
```

### 4.1 自描述的分发格式

每个包在 `package.json` 的 `dsh` 字段里声明自己是 profile 还是 bundle，例如 [packages/bundle/base/package.json](packages/bundle/base/package.json)：

```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

### 4.2 patch 的行语义

[packages/bundle/base/cordis.patch.yml](packages/bundle/base/cordis.patch.yml) 的头部注释阐明了层叠规则：

- patch 按 **id** 定位行，**整体替换该行的 config**（不是合并）或插入新行；
- **行顺序不携带加载语义**——激活完全由服务可用性驱动；
- 一条行最多属于一个 bundle 层加用户层，随模式变化的配置归各模式 bundle 所有。

### 4.3 可运行的组合示例

[examples/headless-agent/cordis.yml](examples/headless-agent/cordis.yml) 是一个完整的声明式装配：settings、credentials、llm 适配器、subprocess、bash、持久化后端、compaction、subagent provider、各种工具……全部以 `id + name + config` 的行罗列。**想换掉 DeepSeek 官方适配器？把一行改成 `@deepseek-ai/dsh-llm-pi-ai` 即可**——这正是"每一部分都可从配置替换"的落地。

用户可用 `dsh --profile web --dump-config` 查看真实启动树，任何一行都可以用自己的 patch 替换。

---

## 5. 作用域与隔离：per-agent 上下文

除了全局插件树，Cordis 提供 `extend()` / `isolate()` / `intercept()` 创建子上下文（[vendor/cordis/src/context.ts](vendor/cordis/src/context.ts)）：

- **isolate map**：`service name → scope label`，同名服务在不同 label 内各自解析——多个 agent 可以拥有各自独立的同名服务实例；
- **intercept map**：`service name → config`，沿上下文链合并进目标服务的配置，实现无侵入的配置覆盖；
- 每个 agent 拥有自己的 `agent.ctx`，把注册作用域限定到单个 agent（`core/scope` 包提供该原语）。

这让"给某一个会话一套不同的能力集"成为纯组合操作：agent preset 在创建时挂载一份 preset `cordis.yml` 到 agent scope 下即可。

---

## 6. 哲学落地的配套纪律

设计哲学能成立，靠的是仓库级约定（AGENTS.md）把它变成可执行的纪律：

| 纪律 | 对插件哲学的意义 |
|---|---|
| **Registrations are effects** | 一切贡献经 `ctx.effect()`/`ctx.on()`，注册表 `register()` 返回 disposer——可逆性是热重载与测试的前提 |
| **插件内不硬编码可调参数** | 随部署变化的选择必须是校验过的 `Config` 字段，可从 cordis.yml 修改；协议常量与安全不变量除外 |
| **跨边界的不透明 id 必须 branded** | `Branded<B>` 而非裸 `string`，防止插件之间以字符串互相污染 |
| **运行时不变量断言"拥有的关系"** | 检查权威事件流或可变数据，而非服务/方法是否存在——插件可替换，但关系必须保持 |
| **信任类型系统** | 同进程类型化边界不加运行时校验；在 parser/config、队列、模型/工具 JSON、持久化、worker、进程、wire 边界才校验 |
| **能力接缝要么完整、要么不拆** | 三角色独立演进时才分包；单角色不构成 seam |
| **非平凡变更必须附 Agent Note** | 设计决策随代码进 PR，哲学不会只活在文档里 |

---

## 7. 结论：这套哲学换来了什么

1. **彻底的可替换性**：从 LLM 适配器到持久化后端、从本地 bash 到远程沙箱、从进程内子 agent 到第三方 CLI，全部是"换一个 provider 包"的配置级操作。
2. **无特权核心**：没有需要 fork 或打补丁的内核，扩展永远是平行挂载；唯一的 loop 实现也只是插件之一。
3. **可预测的生命周期**：注册即效果、卸载即回滚，`inject` 声明依赖、激活由服务可用性驱动，不存在手工启动序列。
4. **可审计的模型输入**："model-visible ⟺ logged" 把插件系统注入模型的一切约束到会话日志这一条权威数据流上，fork、回放、遥测全部从同一条流派生。
5. **声明式组合**：profile/bundle/patch 三层让"一台机器上真实启动的是什么"完全透明（`--dump-config`），且任何一行都可被用户覆盖。

这套设计的本质是：**把 agent harness 的每一个关注点都降维成"一个挂载在共享上下文上、声明依赖、效果可逆的插件"，再用类型化的服务 key 与事件作为唯一的耦合面**。
