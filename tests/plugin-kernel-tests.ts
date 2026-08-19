/**
 * 插件内核与能力接缝测试(kernel / llm / tools / prompt)
 *
 * 覆盖:服务注册与大声失败、注册即可逆效果(逆序 dispose)、插件 inject
 * 依赖校验、waterfall 中间件链与短路、serial 串行钩子、LLM 接缝四种
 * 错误码与协议判定一致性、工具注册表排除过滤与动态源、pre-step 提示
 * 拼装顺序、工具执行链能力事件(tools/pre-execute + post-execute)、
 * turn/step 生命周期事件(全出口覆盖与顺序)。
 *
 * 由 tests/test-agent-core.ts 引入执行(共享其 test/assert 框架)。
 */

import { createContext, type AgentContext, type Plugin } from '../electron/agent/plugin/kernel'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  AGENT_CONTEXT_DISPOSED,
  AGENT_PLUGIN_DEP_MISSING,
  AGENT_SERVICE_MISSING,
  CodedError,
  LLM_ADAPTER_AMBIGUOUS,
  LLM_ADAPTER_MISSING,
  LLM_ADAPTER_UNAVAILABLE,
} from '../electron/agent/plugin/errors'
import {
  ALL_LLM_ADAPTERS,
  createLlmRuntime,
  getDefaultLlmRuntime,
  protocolOf,
  type LlmAdapter,
} from '../electron/agent/plugin/llm'
import { createToolRegistry, toolRegistryPlugin } from '../electron/agent/plugin/tool-registry'
import { delegateToolPlugin } from '../electron/agent/plugin/tool-plugins'
import { TOOL_POST_EXECUTE, TOOL_PRE_EXECUTE, toolExecHooksOf } from '../electron/agent/plugin/tool-events'
import { recordLifecycle, type TurnUsage } from '../electron/agent/plugin/lifecycle-events'
import {
  createFileSessionLog,
  createMemorySessionLog,
  sessionLogPlugin,
  type AssistantMessagePayload,
  type ModelRequestPayload,
  type SessionLogEntry,
} from '../electron/agent/plugin/session-log'
import {
  applyPatch,
  assertLinesValid,
  composeProfile,
  defaultProfile,
  dumpComposition,
  PLUGIN_REGISTRY,
  type CompositionEnv,
  type CompositionLine,
} from '../electron/agent/plugin/composition'
import { AGENT_COMPOSITION_ID_DUP, AGENT_COMPOSITION_LINE_UNKNOWN } from '../electron/agent/plugin/errors'
import { createDelegateTool, executeToolBatch } from '../electron/agent/engine/engine-tool-execution'
import { createRunTurn } from '../electron/agent/engine/engine-loop'
import { createSummaryAgent } from '../electron/agent/subagents/subagents'
import { detectProvider } from '../electron/agent/providers/provider'
import type {} from '../electron/agent/plugin/host'
import type {} from '../electron/agent/plugin/prompt'
import type {} from '../electron/agent/plugin/tool-events'
import type { AgentEvent, AgentTool } from '../electron/agent/types'

/** 测试用瀑布键与事件键(仅本文件生效) */
declare module '../electron/agent/plugin/kernel' {
  interface ContextWaterfallMap {
    'test/wf': [string, [number]]
  }
  interface ContextEventMap {
    'test-evt': [string]
  }
  interface ContextSerialMap {
    'test/serial': [[string], number]
  }
}

interface Harness {
  test(name: string, fn: () => void | Promise<void>): Promise<void> | void
  assert(cond: unknown, msg: string): void
  assertRejects(fn: () => Promise<unknown>, keyword?: string, msg?: string): Promise<void>
}

function fakeTool(name: string): AgentTool {
  return {
    name,
    description: `测试工具 ${name}`,
    parameters: { type: 'object', properties: {} },
    async execute() {
      return name
    },
  }
}

export async function runPluginKernelTests({ test, assert, assertRejects }: Harness): Promise<void> {
  // -------------------------------------------------------------------------
  // 内核:服务仓库
  // -------------------------------------------------------------------------

  await test('kernel:register/has/get 服务按 key 发现', () => {
    const ctx = createContext('t1')
    assert(!ctx.has('config'), '注册前 has 应为 false')
    ctx.register('config', { getConfig: () => ({}) as never })
    assert(ctx.has('config'), '注册后 has 应为 true')
    assert(typeof ctx.get('config').getConfig === 'function', 'get 应返回注册的服务')
    ctx.dispose()
  })

  await test('kernel:get 未注册服务大声失败(AGENT_SERVICE_MISSING)', async () => {
    const ctx = createContext('t2')
    await assertRejects(
      async () => ctx.get('memoryStore' as never),
      'memoryStore',
      '未注册服务应大声失败',
    )
    try {
      ctx.get('memoryStore' as never)
    } catch (err) {
      assert((err as CodedError).code === AGENT_SERVICE_MISSING, '错误码应为 AGENT_SERVICE_MISSING')
    }
    ctx.dispose()
  })

  await test('kernel:注册即可逆效果——dispose 按注册逆序回滚', () => {
    const ctx = createContext('t3')
    const order: string[] = []
    ctx.effect(() => () => order.push('first'), 'a')
    ctx.effect(() => () => order.push('second'), 'b')
    ctx.register('evolution', null)
    ctx.effect(() => () => order.push('third'), 'c')
    ctx.dispose()
    assert(order.join(',') === 'third,second,first', `逆序回滚,实际 ${order.join(',')}`)
    assert(ctx.disposed, 'dispose 后 disposed 应为 true')
  })

  await test('kernel:dispose 后再注册大声失败(AGENT_CONTEXT_DISPOSED)', async () => {
    const ctx = createContext('t4')
    ctx.dispose()
    await assertRejects(
      async () => ctx.register('evolution', null),
      AGENT_CONTEXT_DISPOSED,
      '销毁后注册应大声失败',
    )
  })

  await test('kernel:disposer 提前注销服务(可逆性)', () => {
    const ctx = createContext('t5')
    const dispose = ctx.register('evolution', null)
    assert(ctx.has('evolution'), '注册后应存在')
    dispose()
    assert(!ctx.has('evolution'), 'disposer 调用后应注销')
    dispose() // 幂等:重复调用不报错
    ctx.dispose()
  })

  await test('kernel:plugin inject 缺失大声失败(AGENT_PLUGIN_DEP_MISSING)', async () => {
    const ctx = createContext('t6')
    const plugin: Plugin = {
      name: 'needs-tools',
      inject: ['tools'],
      apply() {},
    }
    await assertRejects(
      async () => ctx.plugin(plugin),
      'needs-tools',
      'inject 依赖缺失应大声失败',
    )
    try {
      ctx.plugin(plugin)
    } catch (err) {
      assert((err as CodedError).code === AGENT_PLUGIN_DEP_MISSING, '错误码应为 AGENT_PLUGIN_DEP_MISSING')
    }
    ctx.dispose()
  })

  await test('kernel:plugin 挂载执行 apply,卸载回滚其效果', () => {
    const ctx = createContext('t7')
    let applied = false
    let cleaned = false
    ctx.register('tools', {} as never)
    const plugin: Plugin = {
      name: 'p1',
      inject: ['tools'],
      apply(c) {
        applied = true
        c.effect(() => () => {
          cleaned = true
        }, 'p1-effect')
      },
    }
    ctx.plugin(plugin)
    assert(applied, 'apply 应立即执行')
    assert(!cleaned, '卸载前效果不应回滚')
    ctx.dispose()
    assert(cleaned, 'ctx.dispose 应回滚插件效果')
  })

  await test('kernel:on/emit 类型化事件', () => {
    const ctx = createContext('t8')
    const got: string[] = []
    // 事件键经声明合并(见文件头 ContextEventMap 扩展)
    const dispose = ctx.on('test-evt', (msg) => got.push(msg))
    ctx.emit('test-evt', 'hello')
    dispose()
    ctx.emit('test-evt', 'world')
    assert(got.length === 1 && got[0] === 'hello', '注销后不再收事件')
    ctx.dispose()
  })

  await test('kernel:waterfall 按注册顺序包裹(next 委托链)', async () => {
    const ctx = createContext('t9')
    ctx.waterfall('test/wf', async (v, next) => next(`${v}+A`))
    ctx.waterfall('test/wf', async (v, next) => next(`${v}+B`))
    const out = await ctx.runWaterfall('test/wf', 'start', 0)
    assert(out === 'start+A+B', `顺序包裹,实际 ${out}`)
    ctx.dispose()
  })

  await test('kernel:waterfall 不调用 next 即短路(策略监听器的决策权)', async () => {
    const ctx = createContext('t10')
    let reached = false
    ctx.waterfall('test/wf', async () => 'blocked') // 短路:不调用 next
    ctx.waterfall('test/wf', async (v, next) => {
      reached = true
      return next(v)
    })
    const out = await ctx.runWaterfall('test/wf', 'start', 0)
    assert(out === 'blocked', '短路值应为监听器的决定')
    assert(!reached, '短路后后续监听器不应执行')
    ctx.dispose()
  })

  await test('kernel:serial 钩子按注册顺序串行执行并收集返回值', async () => {
    const ctx = createContext('t11')
    const order: string[] = []
    ctx.serial('test/serial', async (v) => {
      order.push('a')
      await new Promise((r) => setTimeout(r, 5))
      return v.length
    })
    ctx.serial('test/serial', (v) => {
      order.push('b')
      return v.length * 2
    })
    const res = await ctx.runSerial('test/serial', 'abc')
    assert(order.join(',') === 'a,b', `按注册顺序,实际 ${order.join(',')}`)
    assert(res.length === 2 && res[0] === 3 && res[1] === 6, `收集返回值,实际 ${JSON.stringify(res)}`)
    ctx.dispose()
  })

  await test('kernel:serial 单监听器异常不中断后续(观察钩子不阻断主流程)', async () => {
    const ctx = createContext('t12')
    ctx.serial('test/serial', async () => {
      throw new Error('审计钩子异常')
    })
    let ran = false
    const dispose = ctx.serial('test/serial', () => {
      ran = true
      return 1
    })
    const res = await ctx.runSerial('test/serial', 'x')
    assert(ran, '异常监听器之后仍应执行')
    assert(res.length === 2 && res[0] === undefined && res[1] === 1, '异常槽位为 undefined')
    dispose()
    const after = await ctx.runSerial('test/serial', 'x')
    assert(after.length === 1, 'disposer 注销后监听器不再执行')
    ctx.dispose()
  })

  // -------------------------------------------------------------------------
  // Seam 1:LLM 接缝
  // -------------------------------------------------------------------------

  await test('llm 接缝:protocolOf 与 detectProvider 判定一致(全协议样本)', () => {
    const samples = [
      'https://api.deepseek.com',
      'https://api.deepseek.com/chat',
      'https://api.deepseek.com/anthropic',
      'https://api.xiaomimimo.com',
      'https://api.xiaomimimo.com/chat',
      'https://mimo.mi.com/api',
      'https://mimo.mi.com/anthropic',
      'https://open.bigmodel.cn/api/paas/v4',
      '',
      'https://my-proxy.example.com',
    ]
    for (const url of samples) {
      assert(protocolOf(url) === detectProvider(url), `判定不一致:${url}`)
    }
  })

  await test('llm 接缝:默认运行时七适配器预注册,按 baseURL 唯一解析', () => {
    const rt = getDefaultLlmRuntime()
    assert(rt.adapters().length === 7, `应预注册 7 个适配器,实际 ${rt.adapters().length}`)
    assert(rt.resolve('https://api.deepseek.com').id === 'responses', 'deepseek 默认 → responses')
    assert(rt.resolve('https://api.deepseek.com/chat').id === 'chat', 'deepseek chat → chat')
    assert(rt.resolve('https://api.deepseek.com/anthropic').id === 'anthropic', 'anthropic 端点 → anthropic')
    assert(rt.resolve('https://api.xiaomimimo.com').id === 'mimo-responses', 'mimo → mimo-responses')
    assert(rt.resolve('https://api.xiaomimimo.com/chat').id === 'mimo-chat', 'mimo chat → mimo-chat')
    assert(rt.resolve('http://127.0.0.1:1234').id === 'lmstudio-chat', 'lmstudio 本地端口 → lmstudio-chat')
    assert(rt.resolve('http://localhost:1234/v1').id === 'lmstudio-chat', 'lmstudio localhost → lmstudio-chat')
    assert(rt.resolve('https://open.bigmodel.cn/api/paas/v4').id === 'glm-chat', '智谱云端 → glm-chat')
    assert(rt.resolve('https://open.bigmodel.cn/api/paas/v4/chat/completions').id === 'glm-chat', '智谱云端含 chat → glm-chat(不落 deepseek chat)')
  })

  await test('llm 接缝:零匹配大声失败(LLM_ADAPTER_UNAVAILABLE)', async () => {
    const ctx = createContext('llm-1')
    const rt = createLlmRuntime(ctx)
    rt.registerAdapter({ ...ALL_LLM_ADAPTERS[0], match: () => false })
    try {
      rt.resolve('https://nowhere.example.com')
      throw new Error('不应到达这里')
    } catch (err) {
      assert((err as CodedError).code === LLM_ADAPTER_UNAVAILABLE, '错误码应为 LLM_ADAPTER_UNAVAILABLE')
    }
    ctx.dispose()
  })

  await test('llm 接缝:多匹配大声失败(LLM_ADAPTER_AMBIGUOUS,不依赖注册顺序)', async () => {
    const ctx = createContext('llm-2')
    const rt = createLlmRuntime(ctx)
    rt.registerAdapter({ id: 'responses', label: 'a', match: () => true, stream: async () => ({}) as never })
    rt.registerAdapter({ id: 'chat', label: 'b', match: () => true, stream: async () => ({}) as never })
    try {
      rt.resolve('https://api.deepseek.com')
      throw new Error('不应到达这里')
    } catch (err) {
      assert((err as CodedError).code === LLM_ADAPTER_AMBIGUOUS, '错误码应为 LLM_ADAPTER_AMBIGUOUS')
    }
    ctx.dispose()
  })

  await test('llm 接缝:配置指定未注册适配器大声失败(LLM_ADAPTER_MISSING)', async () => {
    const ctx = createContext('llm-3')
    const rt = createLlmRuntime(ctx)
    try {
      rt.resolve('https://api.deepseek.com', 'pi-ai')
      throw new Error('不应到达这里')
    } catch (err) {
      assert((err as CodedError).code === LLM_ADAPTER_MISSING, '错误码应为 LLM_ADAPTER_MISSING')
    }
    ctx.dispose()
  })

  await test('llm 接缝:stream 分发到解析出的适配器;适配器注册可逆', async () => {
    const ctx = createContext('llm-4')
    const rt = createLlmRuntime(ctx)
    let called = ''
    const adapter: LlmAdapter = {
      id: 'responses',
      label: 'mock',
      match: () => true,
      stream: async () => {
        called = 'mock'
        return { calls: [], text: '', usage: null, aborted: false }
      },
    }
    const dispose = rt.registerAdapter(adapter)
    await rt.stream({ config: { baseURL: '' } as never, system: '', history: [], tools: [], signal: new AbortController().signal, onEvent: () => {} })
    assert(called === 'mock', '应分发到已注册适配器')
    dispose()
    assert(rt.adapters().length === 0, 'disposer 注销后注册表应为空')
    ctx.dispose()
  })

  // -------------------------------------------------------------------------
  // Seam 2:工具注册表
  // -------------------------------------------------------------------------

  await test('tools 接缝:register/listTurn 按配置 excludedTools 过滤', async () => {
    const ctx = createContext('tools-1')
    ctx.register('config', {
      getConfig: () => ({ excludedTools: ['b_tool'] }) as never,
    })
    const reg = createToolRegistry(ctx)
    reg.register(fakeTool('a_tool'))
    reg.register(fakeTool('b_tool'))
    reg.registerTools([fakeTool('c_tool')])
    assert(reg.builtin().length === 3, 'builtin 应为 3 个')
    const turn = await reg.listTurn()
    assert(turn.length === 2 && !turn.some((t) => t.name === 'b_tool'), 'excludedTools 应被过滤')
    assert(reg.get('a_tool')?.name === 'a_tool', 'get 按名命中')
    assert(reg.get('nope') === null, 'get 未命中返回 null')
    ctx.dispose()
  })

  await test('tools 接缝:动态源每步实时解析,加载失败不阻断其余', async () => {
    const ctx = createContext('tools-2')
    ctx.register('config', { getConfig: () => ({}) as never })
    const reg = createToolRegistry(ctx)
    reg.register(fakeTool('static_tool'))
    let extra = 0
    reg.registerSource(async () => (extra > 0 ? [fakeTool('dyn_tool')] : []), 'dyn')
    reg.registerSource(async () => {
      throw new Error('源加载失败')
    }, 'broken')
    assert((await reg.all()).length === 1, '首轮动态源为空')
    extra = 1
    const all = await reg.all()
    assert(all.length === 2 && all.some((t) => t.name === 'dyn_tool'), '动态源变更下一步即生效')
    ctx.dispose()
  })

  await test('tools 接缝:注册可逆——disposer 注销工具', async () => {
    const ctx = createContext('tools-3')
    ctx.register('config', { getConfig: () => ({}) as never })
    const reg = createToolRegistry(ctx)
    const d1 = reg.register(fakeTool('x_tool'))
    const d2 = reg.registerSource(async () => [fakeTool('y_tool')], 'y')
    assert((await reg.all()).length === 2, '注销前共 2 个')
    d1()
    d2()
    assert((await reg.all()).length === 0, '注销后应为空')
    ctx.dispose()
  })

  // -------------------------------------------------------------------------
  // Seam 3:pre-step 提示拼装
  // -------------------------------------------------------------------------

  await test('prompt 接缝:pre-step 瀑布按挂载顺序拼装段落', async () => {
    const ctx = createContext('prompt-1')
    const blocks = ['记忆块', '进化状态', '后台任务']
    for (const b of blocks) {
      ctx.waterfall('agent/pre-step', async (system, next) => next(`${system}\n\n${b}`))
    }
    const out = await ctx.runWaterfall('agent/pre-step', 'base', {
      config: {} as never,
      proactive: false,
    })
    assert(out === 'base\n\n记忆块\n\n进化状态\n\n后台任务', `拼装顺序,实际 ${out}`)
    ctx.dispose()
  })

  // -------------------------------------------------------------------------
  // 能力事件:工具执行链(tools/pre-execute + tools/post-execute)
  // -------------------------------------------------------------------------

  /** 记录实际执行参数的测试工具 */
  function execRecorder(): { tool: AgentTool; ran: number; args: Record<string, unknown>[] } {
    const rec = { tool: null as unknown as AgentTool, ran: 0, args: [] as Record<string, unknown>[] }
    rec.tool = {
      name: 'echo',
      description: '测试工具',
      parameters: { type: 'object', properties: {} },
      async execute(args) {
        rec.ran++
        rec.args.push(args as Record<string, unknown>)
        return `out:${String((args as Record<string, unknown>).msg ?? '')}`
      },
    }
    return rec
  }

  async function runBatch(ctx: AgentContext, rec: { tool: AgentTool }, args: Record<string, unknown>) {
    const [r] = await executeToolBatch(
      [{ id: 'c1', name: 'echo', args }],
      new Map([[rec.tool.name, rec.tool]]),
      [rec.tool],
      undefined,
      undefined,
      toolExecHooksOf(ctx),
    )
    return r
  }

  await test('能力事件:tools/pre-execute 改写参数(策略插件平行挂载不改执行链)', async () => {
    const ctx = createContext('cap-1')
    const rec = execRecorder()
    ctx.waterfall(TOOL_PRE_EXECUTE, async (plan, next) => next({ ...plan, args: { ...plan.args, msg: '改写后' } }))
    const r = await runBatch(ctx, rec, { msg: '原始' })
    assert(r.ok && r.out === 'out:改写后', `执行应使用改写后参数,实际 ${r.out}`)
    assert(rec.args[0].msg === '改写后', '工具收到的应是瀑布改写后的参数')
    ctx.dispose()
  })

  await test('能力事件:tools/pre-execute deny 短路拒绝(大声失败,工具不执行)', async () => {
    const ctx = createContext('cap-2')
    const rec = execRecorder()
    // 短路:不调用 next,直接返回带 deny 的计划(策略监听器的决策权)
    ctx.waterfall(TOOL_PRE_EXECUTE, async (plan) => ({ ...plan, deny: '敏感命令' }))
    const r = await runBatch(ctx, rec, { msg: '原始' })
    assert(!r.ok && r.out.includes('工具执行被拒绝') && r.out.includes('敏感命令'), `拒绝理由应回流,实际 ${r.out}`)
    assert(rec.ran === 0, 'deny 后工具不应执行')
    ctx.dispose()
  })

  await test('能力事件:tools/post-execute 改写结果(裁剪/标注/审计)', async () => {
    const ctx = createContext('cap-3')
    const rec = execRecorder()
    ctx.waterfall(TOOL_POST_EXECUTE, async (outcome, next) => next({ ...outcome, out: `${outcome.out}[已审计]` }))
    const r = await runBatch(ctx, rec, { msg: 'x' })
    assert(r.ok && r.out === 'out:x[已审计]', `结果应被瀑布改写,实际 ${r.out}`)
    ctx.dispose()
  })

  await test('能力事件:无监听器时钩子透明(行为与旧版一致)', async () => {
    const ctx = createContext('cap-4')
    const rec = execRecorder()
    const r = await runBatch(ctx, rec, { msg: 'y' })
    assert(r.ok && r.out === 'out:y', `无监听器应原样通过,实际 ${r.out}`)
    ctx.dispose()
  })

  // -------------------------------------------------------------------------
  // 接缝消费方:delegate 子代理经注入的 stream 调用(不直连供应商实现)
  // -------------------------------------------------------------------------

  const mockOutcome = (text: string) => ({
    calls: [],
    text,
    usage: null,
    aborted: false,
  })

  await test('delegate 工具:子代理使用注入的 stream,结果文本回流', async () => {
    const calls: number[] = []
    const tool = createDelegateTool({
      getConfig: () => ({ apiKey: 'sk-test', excludedTools: [] }) as never,
      getOutputBudget: () => 1000,
      getAllTools: async () => [],
      stream: async (params) => {
        calls.push(params.maxOutputTokens ?? -1)
        return mockOutcome('子任务结果') as never
      },
    })
    const out = await tool.execute({ task: '做点什么' })
    assert(out === '子任务结果', `子代理结果回流,实际 ${out}`)
    assert(calls.length === 1 && calls[0] === 1000, 'stream 收到注入的输出预算')
  })

  await test('delegate 插件:经接缝装配后注册进工具注册表并走接缝调用', async () => {
    const ctx = createContext('delegate-1')
    ctx.plugin(toolRegistryPlugin())
    ctx.register('config', { getConfig: () => ({ apiKey: 'sk-test', excludedTools: [] }) as never })
    ctx.register('outputBudget', { value: 512 })
    let streamed = 0
    ctx.register('llm', {
      registerAdapter: () => () => {},
      resolve: () => {
        throw new Error('mock')
      },
      stream: async () => {
        streamed++
        return mockOutcome('经接缝的子代理结果') as never
      },
      adapters: () => [],
    })
    ctx.plugin(delegateToolPlugin())
    const reg = ctx.get('tools')
    const delegate = reg.get('delegate')
    assert(!!delegate, 'delegate 工具应注册进工具注册表')
    const out = await delegate!.execute({ task: '子任务' })
    assert(out === '经接缝的子代理结果', `经接缝调用,实际 ${out}`)
    assert(streamed === 1, 'stream 应经 ctx.llm 接缝调用一次')
    ctx.dispose()
    assert(reg.builtin().length === 0, 'dispose 后工具注册应逆序回滚')
  })

  await test('总结子代理:标题总结使用注入的 stream(不直连供应商)', async () => {
    let calls = 0
    const agent = createSummaryAgent({
      getConfig: () => ({ apiKey: 'sk-test', systemPrompt: '' }) as never,
      stream: async () => {
        calls++
        return mockOutcome('{"title":"周末徒步计划"}') as never
      },
    })
    const title = await agent.summarize([
      { id: '1', role: 'user', parts: [{ type: 'text', text: '周末一起去徒步吧' }] },
    ])
    assert(title === '周末徒步计划', `注入 stream 的标题回流,实际 ${title}`)
    assert(calls === 1, 'stream 应只被调用一次(首次措辞即成功)')
  })

  await test('能力事件:delegate 子代理同享 tools/pre-execute 扩展点', async () => {
    const ctx = createContext('cap-5')
    ctx.waterfall(TOOL_PRE_EXECUTE, async (plan) => ({ ...plan, deny: '子代理禁用该工具' }))
    const rec = execRecorder()
    let step = 0
    const tool = createDelegateTool({
      getConfig: () => ({ apiKey: 'sk-test', excludedTools: [] }) as never,
      getOutputBudget: () => 1000,
      getAllTools: async () => [rec.tool],
      stream: async () => {
        step++
        if (step === 1) {
          return { calls: [{ id: 'c1', name: 'echo', args: '{}' }], text: '', usage: null, aborted: false } as never
        }
        return mockOutcome('子代理完成') as never
      },
      hooks: toolExecHooksOf(ctx),
    })
    const out = await tool.execute({ task: '子任务' })
    assert(rec.ran === 0, '子代理内被 deny 的工具不应执行')
    assert(out === '子代理完成', `子代理继续推进并返回结果,实际 ${out}`)
    ctx.dispose()
  })

  // -------------------------------------------------------------------------
  // 生命周期事件:turn/step 全链路(agent/turn-* + agent/step-*)
  // -------------------------------------------------------------------------

  /** 组装最小 runTurn 测试环境(events/tools/llm/outputBudget/sessionLog 全 mock 注入) */
  function turnHarness(id: string, streamResults: Array<Record<string, unknown>>) {
    const ctx = createContext(id)
    const hostEvents: AgentEvent[] = []
    ctx.register('events', { emit: (e: AgentEvent) => hostEvents.push(e) })
    ctx.register('outputBudget', { value: 512 })
    ctx.register('sessionState', { getSessionId: () => null, getSessionKey: () => 'main' })
    const log = createMemorySessionLog()
    ctx.plugin(sessionLogPlugin(log))
    ctx.register('tools', { listTurn: async () => [fakeTool('echo')] } as never)
    const streamCalls: Array<Record<string, unknown>> = []
    ctx.register('llm', {
      registerAdapter: () => () => {},
      resolve: () => {
        throw new Error('mock')
      },
      stream: async (params: unknown) => {
        streamCalls.push(params as Record<string, unknown>)
        return streamResults.shift()!
      },
      adapters: () => [],
    } as never)
    const ctrl = new AbortController()
    const turn = {
      signal: ctrl.signal,
      config: { apiKey: 'sk-test', systemPrompt: 'base' } as never,
    }
    return { ctx, hostEvents, ctrl, log, streamCalls, runTurn: createRunTurn(ctx), turn }
  }

  await test('生命周期事件:单步回合——turn/step 事件顺序与用量载荷', async () => {
    const h = turnHarness('life-1', [
      { calls: [], text: '你好', usage: { input_tokens: 10, output_tokens: 5 }, aborted: false } as never,
    ])
    const rec = recordLifecycle(h.ctx)
    let usageOut: TurnUsage | null = null
    h.ctx.on('agent/turn-end', (i) => {
      usageOut = i.usage
    })
    await h.runTurn('你好', [], h.turn)
    assert(
      rec.seq.join('|') === 'turn-start:1|step-start:1|step-end:1:calls=0|turn-end:ok=true:steps=1:aborted=false',
      `事件顺序,实际 ${rec.seq.join(' | ')}`,
    )
    assert(usageOut!.input === 10 && usageOut!.output === 5, 'turn-end 应携带累计用量')
    rec.dispose()
    h.ctx.dispose()
  })

  await test('生命周期事件:两步工具循环——每步各自成对发出', async () => {
    const h = turnHarness('life-2', [
      { calls: [{ id: 'c1', name: 'echo', args: '{}' }], text: '', usage: null, aborted: false } as never,
      { calls: [], text: '完成', usage: null, aborted: false } as never,
    ])
    const rec = recordLifecycle(h.ctx)
    await h.runTurn('调用 echo', [], h.turn)
    assert(
      rec.seq.join('|') ===
        'turn-start:1|step-start:1|step-end:1:calls=1|step-start:2|step-end:2:calls=0|turn-end:ok=true:steps=2:aborted=false',
      `两步事件序列,实际 ${rec.seq.join(' | ')}`,
    )
    rec.dispose()
    h.ctx.dispose()
  })

  await test('生命周期事件:中断回合 turn-end 仍发出(finally 语义)', async () => {
    const h = turnHarness('life-3', [])
    h.ctrl.abort()
    const rec = recordLifecycle(h.ctx)
    await h.runTurn('x', [], h.turn)
    assert(
      rec.seq.join('|') === 'turn-start:1|turn-end:ok=false:steps=0:aborted=true',
      `中断应仅余 turn 对,实际 ${rec.seq.join(' | ')}`,
    )
    rec.dispose()
    h.ctx.dispose()
  })

  await test('生命周期事件:手动调用失败回合——ok=false 且步数为 0', async () => {
    const h = turnHarness('life-4', [])
    const rec = recordLifecycle(h.ctx)
    await h.runTurn('/no_such_tool', [], h.turn)
    assert(
      rec.seq.join('|') === 'turn-start:1|turn-end:ok=false:steps=0:aborted=false',
      `失败回合事件序列,实际 ${rec.seq.join(' | ')}`,
    )
    assert(h.hostEvents.some((e) => e.type === 'error'), '未找到工具应经宿主事件出口报错')
    rec.dispose()
    h.ctx.dispose()
  })

  // -------------------------------------------------------------------------
  // 会话日志:Model-visible⟺Logged(模型可见输入可从日志重建)
  // -------------------------------------------------------------------------

  /** 收窄出 model-request 条目(带 ts/sessionKey) */
  function requestEntries(log: { entries(): SessionLogEntry[] }) {
    return log.entries().filter((e): e is SessionLogEntry & ModelRequestPayload => e.kind === 'model-request')
  }
  function messageEntries(log: { entries(): SessionLogEntry[] }) {
    return log.entries().filter((e): e is SessionLogEntry & AssistantMessagePayload => e.kind === 'assistant-message')
  }

  await test('会话日志:每步调 LLM 前记录完整模型可见集(system/history/tools)', async () => {
    const h = turnHarness('slog-1', [{ calls: [], text: '回复', usage: null, aborted: false } as never])
    await h.runTurn('你好', [], h.turn)
    const reqs = requestEntries(h.log)
    assert(reqs.length === 1, `单步回合应记 1 条 model-request,实际 ${reqs.length}`)
    const r = reqs[0]
    assert(r.step === 1, '步号正确')
    assert(r.system.includes('base'), `system 含用户提示词,实际:${r.system}`)
    assert(r.history.some((m) => m.parts.some((p) => p.type === 'text' && p.text === '你好')), '历史含本轮用户消息')
    assert(r.tools.includes('echo'), '可见工具名被记录')
    assert(r.sessionKey === 'main', 'sessionKey 由服务补全')
    h.ctx.dispose()
  })

  await test('会话日志:图片 dataUrl 落盘前清洗为占位符(不搬二进制)', async () => {
    const big = 'data:image/png;base64,' + 'A'.repeat(4096)
    const h = turnHarness('slog-2', [{ calls: [], text: 'ok', usage: null, aborted: false } as never])
    await h.runTurn('看图', [
      { id: 'm1', role: 'user', parts: [{ type: 'image', dataUrl: big }] },
    ], h.turn)
    const reqs = requestEntries(h.log)
    assert(reqs.length === 1, '记录一条')
    const imgMsg = reqs[0].history.find((m) => m.parts.some((p) => p.type === 'image'))
    assert(!!imgMsg, '历史含图片消息')
    const imgPart = imgMsg!.parts.find((p) => p.type === 'image')!
    const dataUrl = (imgPart as { dataUrl: string }).dataUrl
    assert(dataUrl.startsWith('[image:') && !dataUrl.includes('AAAA'), `dataUrl 应清洗为占位符,实际 ${dataUrl.slice(0, 32)}`)
    h.ctx.dispose()
  })

  await test('会话日志:助手消息落定记录一条 assistant-message', async () => {
    const h = turnHarness('slog-3', [{ calls: [], text: '最终回复', usage: null, aborted: false } as never])
    await h.runTurn('你好', [], h.turn)
    const msgs = messageEntries(h.log)
    assert(msgs.length === 1, `落定应记 1 条 assistant-message,实际 ${msgs.length}`)
    assert(msgs[0].message.role === 'assistant', '角色为 assistant')
    assert(
      msgs[0].message.parts.some((p) => p.type === 'text' && p.text === '最终回复'),
      '消息文本与模型输出一致',
    )
    h.ctx.dispose()
  })

  await test('会话日志:多步工具循环——每步各记一条 model-request', async () => {
    const h = turnHarness('slog-4', [
      { calls: [{ id: 'c1', name: 'echo', args: '{}' }], text: '', usage: null, aborted: false } as never,
      { calls: [], text: '完成', usage: null, aborted: false } as never,
    ])
    await h.runTurn('调用 echo', [], h.turn)
    const reqs = requestEntries(h.log)
    assert(reqs.length === 2, `两步应各记一条,实际 ${reqs.length}`)
    assert(reqs[0].step === 1 && reqs[1].step === 2, '步号递增')
    // 第二步的历史必须含第一步的工具调用与结果(可重建模型输入)
    assert(
      reqs[1].history.some((m) => m.parts.some((p) => p.type === 'tool-call' && p.name === 'echo')),
      '第二步历史含第一步的工具调用,保证可从日志重建',
    )
    h.ctx.dispose()
  })

  await test('会话日志:文件 sink 按 JSONL 逐行落盘且可回放', async () => {
    const file = path.join(os.tmpdir(), `slog-test-${Date.now()}.jsonl`)
    const sink = createFileSessionLog(() => file)
    sink.write({ ts: 1, sessionKey: 'main', kind: 'assistant-message', message: { id: 'x', role: 'assistant', parts: [{ type: 'text', text: 'hi' }] } })
    sink.write({ ts: 2, sessionKey: 'main', kind: 'model-request', step: 1, system: 's', history: [], tools: [] })
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n')
    assert(lines.length === 2, `应两行 JSONL,实际 ${lines.length}`)
    const first = JSON.parse(lines[0]) as SessionLogEntry
    assert(first.kind === 'assistant-message', '首行可回放为 assistant-message')
    fs.rmSync(file, { force: true })
  })

  // -------------------------------------------------------------------------
  // 声明式组合层:Profile → Patch 配置驱动装配
  // -------------------------------------------------------------------------

  /** 最小组合环境(host-bridge 工厂只在 apply 时才用 deps,构造期安全) */
  function compEnv(): CompositionEnv {
    return {
      deps: {} as never,
      emit: () => {},
      outputBudget: { value: 512 },
      sessionState: { getSessionId: () => null, getSessionKey: () => 'main' },
    }
  }

  await test('组合层:缺省 Profile 解析为全量插件树且 dump 可见', async () => {
    const plugins = composeProfile(compEnv())
    assert(plugins.length === defaultProfile().lines.length, `缺省装配应满 ${defaultProfile().lines.length} 行,实际 ${plugins.length}`)
    const dump = dumpComposition()
    assert(dump.length === plugins.length, 'dump 行数 = 装配行数')
    assert(dump.every((l) => l.enabled), '缺省全部启用')
    assert(dump[0].name === 'host-bridge', `首行应为 host-bridge,实际 ${dump[0].name}`)
  })

  await test('组合层:每个缺省行 name 都在工厂注册表(无特权核心)', async () => {
    for (const line of defaultProfile().lines) {
      assert(!!PLUGIN_REGISTRY[line.name], `name 已注册:${line.name}`)
    }
  })

  await test('组合层:patch 按 id 整体替换某行(换实现 = 换 name)', async () => {
    const patch: CompositionLine[] = [{ id: 'tools-napcat', name: 'tools-music-control', enabled: false }]
    const dump = dumpComposition(undefined, patch)
    const line = dump.find((l) => l.id === 'tools-napcat')!
    assert(line.name === 'tools-music-control', `该行 name 被整体替换,实际 ${line.name}`)
    assert(line.enabled === false, '该行的 enabled 一并被替换')
  })

  await test('组合层:patch 对未命中的 id 追加为新行', async () => {
    const patch: CompositionLine[] = [{ id: 'my-extra', name: 'tools-core' }]
    const dump = dumpComposition(undefined, patch)
    assert(dump.some((l) => l.id === 'my-extra'), '新行被追加')
    assert(dump[dump.length - 1].id === 'my-extra', '追加在末尾')
  })

  await test('组合层:enabled:false 的行在装配时被跳过', async () => {
    const patch: CompositionLine[] = [{ id: 'tools-napcat', name: 'tools-napcat', enabled: false }]
    const plugins = composeProfile(compEnv(), undefined, patch)
    assert(plugins.length === defaultProfile().lines.length - 1, '禁用行不计入装配')
    assert(!plugins.some((p) => p.name === 'tools-napcat'), 'tools-napcat 插件未被装配')
  })

  await test('组合层:未知 name 大声失败(AGENT_COMPOSITION_LINE_UNKNOWN)', async () => {
    const bad: CompositionLine[] = [{ id: 'x', name: 'not-registered' }]
    try {
      assertLinesValid(bad)
      assert(false, '应抛出未知 name 错误')
    } catch (err) {
      assert((err as CodedError).code === AGENT_COMPOSITION_LINE_UNKNOWN, '错误码应为 AGENT_COMPOSITION_LINE_UNKNOWN')
    }
  })

  await test('组合层:重复 id 大声失败(AGENT_COMPOSITION_ID_DUP)', async () => {
    const dup: CompositionLine[] = [
      { id: 'tools-core', name: 'tools-core' },
      { id: 'tools-core', name: 'tools-memory' },
    ]
    try {
      assertLinesValid(dup)
      assert(false, '应抛出重复 id 错误')
    } catch (err) {
      assert((err as CodedError).code === AGENT_COMPOSITION_ID_DUP, '错误码应为 AGENT_COMPOSITION_ID_DUP')
    }
  })

  await test('组合层:applyPatch 不改 base(返回新数组)', async () => {
    const base: CompositionLine[] = [{ id: 'a', name: 'tools-core' }]
    const out = applyPatch(base, [{ id: 'a', name: 'tools-memory' }])
    assert(base[0].name === 'tools-core', 'base 未被改动')
    assert(out[0].name === 'tools-memory', 'patch 结果生效')
  })
}
