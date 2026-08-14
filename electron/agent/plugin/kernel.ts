/**
 * 插件内核 —— 轻量服务/效果容器(Cordis 风格,零外部依赖)
 *
 * 设计哲学(参考 plugin-design-review.zh.md,不引入 Cordis 本体):
 * 1. **上下文 = 服务仓库**:服务认领稳定 key(ctx.get('llm') 等),插件之间
 *    按 key 发现服务,**永不 import 具体实现**;key 经 TS 声明合并类型化
 *    (各接缝模块 `declare module './kernel'` 扩展 ContextServices)。
 * 2. **注册即可逆效果**:服务/事件监听/瀑布监听/任意副作用统一经
 *    ctx.effect / ctx.register / ctx.on / ctx.waterfall 安装,每次注册返回
 *    disposer;ctx.dispose() 按注册**逆序**回滚一切。
 * 3. **插件声明依赖**:Plugin.inject 列出所需服务 key,缺失时**大声失败**
 *    (AGENT_PLUGIN_DEP_MISSING),绝不静默跳过。
 * 4. **类型化事件**:emit/on(即发即忘)、waterfall/runWaterfall(around
 *    中间件,监听器收 next——不调用即短路,短路本身也是设计)、
 *    serial/runSerial(按注册顺序逐个等待并收集返回值,观察/审计钩子)。
 *
 * 每引擎一份独立 ctx(per-agent 上下文):主对话与每个外部会话引擎各自
 * createContext,天然隔离,无需额外作用域机制。
 */

import { AGENT_CONTEXT_DISPOSED, AGENT_PLUGIN_DEP_MISSING, AGENT_SERVICE_MISSING, CodedError } from './errors'

/** 清理函数(可逆效果的撤销端) */
export type Disposer = () => void

/**
 * 服务键 → 服务类型(声明合并扩展)。
 * 接缝模块在自己的文件里:
 * ```ts
 * declare module './kernel' {   // 相对路径按所在目录调整
 *   interface ContextServices { llm: LlmRuntime }
 * }
 * ```
 * 编译期类型完整、运行期实现可替换。
 */
// oxlint-disable-next-line @typescript-eslint/no-empty-object-type -- 声明合并扩展点
export interface ContextServices {}

/** 事件名 → 参数元组(声明合并扩展,emit/on 通道) */
// oxlint-disable-next-line @typescript-eslint/no-empty-object-type -- 声明合并扩展点
export interface ContextEventMap {}

/** 瀑布名 → [值类型, 附加参数元组](声明合并扩展,waterfall 通道) */
// oxlint-disable-next-line @typescript-eslint/no-empty-object-type -- 声明合并扩展点
export interface ContextWaterfallMap {}

/** 串行钩子名 → [参数元组, 单监听器返回类型](声明合并扩展,serial 通道) */
// oxlint-disable-next-line @typescript-eslint/no-empty-object-type -- 声明合并扩展点
export interface ContextSerialMap {}

/**
 * 插件约定:带可选 inject(依赖的服务 key)与 apply(挂载逻辑)。
 * apply 返回的 disposer(或内部经 ctx.effect 注册的一切)在卸载时逆序回滚。
 */
export interface Plugin {
  /** 插件名(报错与调试标识) */
  name: string
  /** 依赖的服务 key 列表;任一缺失立即大声失败 */
  inject?: ReadonlyArray<string>
  apply(ctx: AgentContext): void | Disposer
}

type EventHandler = (...args: never[]) => void
type WaterfallHandler<V, E extends unknown[]> = (
  value: V,
  next: (value?: V) => Promise<V>,
  ...extra: E
) => Promise<V> | V
type SerialHandler<A extends unknown[], R> = (...args: A) => Promise<R> | R

export interface AgentContext {
  /** 上下文标识(报错定位用) */
  readonly name: string
  readonly disposed: boolean

  /** 注册服务(可重复注册:key 指向最后一次注册;返回 disposer 注销) */
  register<K extends keyof ContextServices & string>(key: K, service: ContextServices[K]): Disposer
  has(key: string): boolean
  /** 取服务;未注册大声失败(AGENT_SERVICE_MISSING) */
  get<K extends keyof ContextServices & string>(key: K): ContextServices[K]

  /** 注册即可逆效果:fn 立即执行并返回清理函数;dispose 时逆序调用 */
  effect(fn: () => void | Disposer, label?: string): Disposer

  /** 订阅类型化事件(即发即忘) */
  on<E extends keyof ContextEventMap & string>(name: E, handler: (...args: ContextEventMap[E]) => void): Disposer
  emit<E extends keyof ContextEventMap & string>(name: E, ...args: ContextEventMap[E]): void

  /** 订阅瀑布(around 中间件:必须调用 next 委托,不调用即短路) */
  waterfall<W extends keyof ContextWaterfallMap & string>(
    name: W,
    handler: WaterfallHandler<ContextWaterfallMap[W][0], ContextWaterfallMap[W][1]>,
  ): Disposer
  /** 执行瀑布:按注册顺序包裹,返回最终值 */
  runWaterfall<W extends keyof ContextWaterfallMap & string>(
    name: W,
    value: ContextWaterfallMap[W][0],
    ...extra: ContextWaterfallMap[W][1]
  ): Promise<ContextWaterfallMap[W][0]>

  /** 订阅串行钩子(按注册顺序逐个等待,适合必须完成才继续的观察/审计) */
  serial<S extends keyof ContextSerialMap & string>(
    name: S,
    handler: SerialHandler<ContextSerialMap[S][0], ContextSerialMap[S][1]>,
  ): Disposer
  /** 执行串行钩子:按注册顺序逐个 await,收集各返回值(单监听器异常
   *  记日志不中断后续——观察钩子不阻断主流程,与 emit 语义一致) */
  runSerial<S extends keyof ContextSerialMap & string>(
    name: S,
    ...args: ContextSerialMap[S][0]
  ): Promise<Array<ContextSerialMap[S][1]>>

  /** 挂载插件(inject 校验 → apply;其效果随 ctx 卸载回滚) */
  plugin(plugin: Plugin): Disposer

  /** 逆序回滚一切注册;之后任何注册大声失败(AGENT_CONTEXT_DISPOSED) */
  dispose(): void
}

interface Cleanup {
  label: string
  fn: Disposer
}

/** 创建一个插件上下文(每引擎一份) */
export function createContext(name = 'agent'): AgentContext {
  const services = new Map<string, unknown>()
  const listeners = new Map<string, EventHandler[]>()
  const waterfalls = new Map<string, WaterfallHandler<unknown, unknown[]>[]>()
  const serials = new Map<string, SerialHandler<unknown[], unknown>[]>()
  const cleanups: Cleanup[] = []
  let disposed = false

  function assertActive(action: string): void {
    if (disposed) {
      throw new CodedError(AGENT_CONTEXT_DISPOSED, `上下文 ${name} 已销毁,不能再${action}`)
    }
  }

  /** 入栈一条清理记录,返回提前注销用的 disposer(幂等) */
  function track(label: string, fn: Disposer): Disposer {
    const entry: Cleanup = { label, fn }
    cleanups.push(entry)
    let done = false
    return () => {
      if (done) return
      done = true
      const i = cleanups.indexOf(entry)
      if (i >= 0) cleanups.splice(i, 1)
      try {
        fn()
      } catch (err) {
        console.error(`[plugin:${name}] 清理失败(${label}):`, (err as Error).message)
      }
    }
  }

  const ctx: AgentContext = {
    name,
    get disposed() {
      return disposed
    },

    register(key, service) {
      assertActive(`注册服务 ${key}`)
      const prev = services.has(key) ? (services.get(key) as unknown) : undefined
      const hadPrev = services.has(key)
      services.set(key, service)
      return track(`service:${key}`, () => {
        // 只在该 key 仍指向本注册时还原(后注册者先注销时还原前一实现)
        if (services.get(key) === service) {
          if (hadPrev) services.set(key, prev)
          else services.delete(key)
        }
      })
    },
    has(key) {
      return services.has(key)
    },
    get(key) {
      if (!services.has(key)) {
        throw new CodedError(AGENT_SERVICE_MISSING, `服务未注册:${key}(上下文 ${name})`)
      }
      return services.get(key) as never
    },

    effect(fn, label = 'effect') {
      assertActive(`注册效果 ${label}`)
      const cleanup = fn()
      return track(label, typeof cleanup === 'function' ? cleanup : () => {})
    },

    on(name, handler) {
      assertActive(`订阅事件 ${name}`)
      const list = listeners.get(name) ?? []
      // 泛型事件元组与 EventHandler 不充分重叠,经 unknown 中转(运行时同构)
      list.push(handler as unknown as EventHandler)
      listeners.set(name, list)
      return track(`on:${name}`, () => {
        const arr = listeners.get(name)
        if (!arr) return
        const i = arr.indexOf(handler as unknown as EventHandler)
        if (i >= 0) arr.splice(i, 1)
      })
    },
    emit(name, ...args) {
      const arr = listeners.get(name)
      if (!arr) return
      for (const h of [...arr]) {
        try {
          ;(h as (...a: unknown[]) => void)(...(args as unknown[]))
        } catch (err) {
          console.error(`[plugin:${name}] 事件监听异常(${name}):`, (err as Error).message)
        }
      }
    },

    waterfall(name, handler) {
      assertActive(`订阅瀑布 ${name}`)
      const list = waterfalls.get(name) ?? []
      list.push(handler as WaterfallHandler<unknown, unknown[]>)
      waterfalls.set(name, list)
      return track(`waterfall:${name}`, () => {
        const arr = waterfalls.get(name)
        if (!arr) return
        const i = arr.indexOf(handler as WaterfallHandler<unknown, unknown[]>)
        if (i >= 0) arr.splice(i, 1)
      })
    },
    async runWaterfall(name, value, ...extra) {
      const handlers = [...(waterfalls.get(name) ?? [])]
      function compose(i: number, current: unknown): Promise<unknown> {
        if (i >= handlers.length) return Promise.resolve(current)
        const h = handlers[i]
        let delegated: Promise<unknown> | null = null
        const next = (v?: unknown) => {
          if (!delegated) delegated = compose(i + 1, v === undefined ? current : v)
          return delegated
        }
        return Promise.resolve()
          .then(() => h(current, next, ...(extra as unknown[])))
          .then(async (out) => {
            if (out !== undefined) return out // 监听器的决定(改写值或短路)
            if (delegated) return delegated   // 调用了 next 但未显式返回
            return current                    // 无返回值且未委托 = 短路保留原值
          })
      }
      return (await compose(0, value)) as never
    },

    serial(name, handler) {
      assertActive(`订阅串行钩子 ${name}`)
      const list = serials.get(name) ?? []
      list.push(handler as SerialHandler<unknown[], unknown>)
      serials.set(name, list)
      return track(`serial:${name}`, () => {
        const arr = serials.get(name)
        if (!arr) return
        const i = arr.indexOf(handler as SerialHandler<unknown[], unknown>)
        if (i >= 0) arr.splice(i, 1)
      })
    },
    async runSerial(name, ...args) {
      const out: unknown[] = []
      for (const h of [...(serials.get(name) ?? [])]) {
        try {
          out.push(await h(...(args as unknown[])))
        } catch (err) {
          console.error(`[plugin:${name}] 串行钩子异常(${name}):`, (err as Error).message)
          out.push(undefined)
        }
      }
      return out as never
    },

    plugin(plugin) {
      assertActive(`挂载插件 ${plugin.name}`)
      for (const key of plugin.inject ?? []) {
        if (!services.has(key)) {
          throw new CodedError(
            AGENT_PLUGIN_DEP_MISSING,
            `插件 ${plugin.name} 依赖的服务未注册:${key}(上下文 ${name})`,
          )
        }
      }
      const cleanup = plugin.apply(ctx)
      return track(`plugin:${plugin.name}`, typeof cleanup === 'function' ? cleanup : () => {})
    },

    dispose() {
      if (disposed) return
      disposed = true
      // 注册即可逆效果:按注册逆序回滚一切
      while (cleanups.length > 0) {
        const entry = cleanups.pop() as Cleanup
        try {
          entry.fn()
        } catch (err) {
          console.error(`[plugin:${name}] 销毁清理失败(${entry.label}):`, (err as Error).message)
        }
      }
      services.clear()
      listeners.clear()
      waterfalls.clear()
      serials.clear()
    },
  }
  return ctx
}
