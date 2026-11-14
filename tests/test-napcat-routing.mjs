/** 路由集成回归：执行真实 IPC 入口和出站处理器，QQ/LLM 均用内存替身。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { AsyncLocalStorage } from 'node:async_hooks'
import { test } from 'node:test'
import { build } from 'esbuild'
import ts from 'typescript'
import { createNapcatRouting } from '../electron/napcat-routing.cjs'

const require = createRequire(import.meta.url)
const bundle = await build({ entryPoints: ['electron/agent/napcat/napcat-session.ts'], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent' })
const mod = { exports: {} }
vm.runInNewContext(bundle.outputFiles[0].text, { module: mod, exports: mod.exports, require })
const helpers = mod.exports
const source = ts.createSourceFile('main.cjs', fs.readFileSync('electron/main.cjs', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
const needed = ['newRoute', 'asArray', 'handleEngineMessageForNapcat', 'turnAlreadySentToPending', 'turnAlreadySentToTarget', 'turnAlreadySentGroupText', 'turnRuleAsk', 'turnRuleGroup', 'turnRuleContact', 'turnRuleToMaster']
const functions = source.statements.filter((s) => ts.isFunctionDeclaration(s) && needed.includes(s.name?.text)).map((s) => s.getText(source)).join('\n')
const ipc = source.statements.find((s) => ts.isExpressionStatement(s) && ts.isCallExpression(s.expression) && s.expression.expression.getText(source) === 'ipcMain.on' && s.expression.arguments[0]?.text === 'agent:send').expression.arguments[1].getText(source)
const message = (text = '你好', id = 'reply') => ({ id, parts: [{ type: 'text', text }] })
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }

function fixture() {
  const routing = createNapcatRouting()
  const entries = new Map()
  const sends = [], events = [], gates = [], failures = [], starts = []
  const client = {
    async sendToQQ(target, text) {
      if (client.wait) await client.wait
      if (client.fail) throw new Error('mock offline')
      sends.push({ type: 'private', target, text })
      routing.recordSent({ type: 'private', target, text })
    },
    async sendToGroup(target, text, opts) {
      if (client.wait) await client.wait
      if (client.fail) throw new Error('mock offline')
      sends.push({ type: 'group', target, text, opts })
      routing.recordSent({ type: 'group', target, text })
    },
  }
  const ctx = vm.createContext({
    process: { env: {} }, console, napcatRouting: routing, sessionEngines: entries,
    masterQQ: () => '10000', napcatClientState: { client }, PENDING_QQ_TIMEOUT_MS: 1800000, lastQQTurnAt: 0,
    agentEngineModule: { ...helpers, stripThinkingPreamble: (t) => t, isSuspectedMonologue: () => false,
      tagMasterWindowText: (t) => `【主人窗口】${t}`, masterWindowTurnRule: () => '主人窗口' },
    logFpGate: (key, reason) => gates.push({ key, reason }),
    showMainNotify: (title) => events.push({ type: 'notification', title }),
    sendToWidget: (_, e) => events.push(e), handleNapcatSendError: (e) => failures.push(e.message),
    classifyReplyIntent: async () => 'other',
    groupMentionOpts: async (_g, _t, speaker, directed, plain, atQQs) => ({ speaker, directed, plain, atQQs }),
    getSessionEngine: (key) => {
      if (!entries.has(key)) entries.set(key, {
        route: key === 'main' ? ctx.mainRoute : ctx.newRoute(),
        engine: { busy: false, send: (...args) => starts.push({ args, turn: routing.current(key) }) },
      })
      return key === 'main' ? entries.get(key).engine : entries.get(key)
    },
  })
  vm.runInContext(functions, ctx)
  ctx.mainRoute = ctx.newRoute()
  ctx.ingress = vm.runInContext(`(${ipc})`, ctx)
  const start = (key, src, text = '你好', owner = 'peer', groupTurn) => {
    const target = src === 'group' ? key.split(':')[1] : key === 'main' ? '10000' : key.split(':')[1]
    ctx.ingress(null, text, [], 'test-session', src, target, key, null, owner, groupTurn)
    return starts.at(-1).turn
  }
  const land = (turn, text, id) => routing.run(turn, () => ctx.handleEngineMessageForNapcat(message(text, id), turn.sessionKey, turn.turnTag))
  return { routing, entries, ctx, start, land, client, sends, events, gates, failures, starts }
}

test('ask 使用私聊自身路由，请示发给主人且不覆盖正在运行的主人轮', async () => {
  const f = fixture()
  const master = f.start('main', 'qq', '主人消息', 'master')
  const ask = f.start('private:20001', 'ask')
  assert.equal(ask.turnKind, 'ask')
  assert.equal(f.ctx.mainRoute.activeTurn, master)
  await f.land(ask, '主人，请问怎么回复？')
  await f.land(master, '收到主人消息')
  assert.deepEqual(f.sends.map((s) => s.target), ['10000', '10000'])
  assert.equal(helpers.resolvePrivateSendTarget({ requested: '30001', sessionKey: 'private:20001', turnKind: ask.turnKind, masterQQ: '10000' }).ok, false)
  assert.equal(helpers.resolvePrivateSendTarget({ requested: '30001', sessionKey: 'private:20001', turnKind: null, masterQQ: '10000' }).ok, false)
})

test('迟到或重复回复不能消费新轮路由，也不会重复发送', async () => {
  const f = fixture()
  const old = f.start('private:20001', 'qq')
  const live = f.start('private:20001', 'qq')
  await f.land(old, '过期回复')
  assert.equal(live.routed, false)
  await f.land(live, '正常回复')
  await f.land(live, '重复回复')
  assert.deepEqual(f.sends.map((s) => s.text), ['正常回复'])
})

test('生成期间新来待办不改变原收件人；完成旧待办不能删除同人新待办', async () => {
  const f = fixture()
  f.routing.rememberPending('20001', 'A 原问题')
  assert.equal(f.routing.selectPending('main', '发到群里：你好'), null)
  assert.equal(f.routing.selectPending('main', '回复张三：你好'), null)
  assert.equal(f.routing.selectPending('group:50001', '回他：你好'), null)
  const turn = f.start('main', 'window', '回他：好的', 'master')
  const newerA = f.routing.rememberPending('20001', 'A 新问题')
  f.routing.rememberPending('30001', 'B 问题')
  await f.land(turn, '好的')
  assert.equal(f.sends[0].target, '20001')
  assert.equal(f.routing.pendingList().length, 2)
  assert.equal(f.routing.selectPending('private:20001', ''), newerA)
  const ambiguous = f.start('main', 'window', '回他：收到', 'master')
  assert.equal(ambiguous.pendingReply, null)
  await f.land(ambiguous, '收到')
  assert.equal(f.sends.length, 1)
  const explicit = f.start('main', 'window', '回复 QQ 30001：收到', 'master')
  assert.equal(explicit.pendingReply.qq, '30001')
  assert.equal(f.routing.selectPending('main', '回复 QQ 40001：收到'), null)
})

test('群轮使用随消息传来的元数据，不使用会话后来发言的人', async () => {
  const f = fixture()
  const group = { speakerQQ: '20001', plain: 'A 的问题', directed: true, atQQs: ['30001'] }
  const turn = f.start('group:50001', 'group', 'A 的问题', 'peer', group)
  group.speakerQQ = '40001'; group.atQQs.push('40001')
  await f.land(turn, '回答 A')
  assert.equal(f.sends[0].opts.speaker, '20001')
  assert.equal(f.sends[0].opts.plain, 'A 的问题')
  assert.deepEqual(Array.from(f.sends[0].opts.atQQs), ['30001'])
})

test('同目标的其它轮发送不抑制本轮；本轮文字工具发送不转投主人', async () => {
  const f = fixture()
  const turn = f.start('group:50001', 'group')
  const other = f.start('main', 'window', '向群发送', 'master')
  await f.routing.run(other, () => f.client.sendToGroup('50001', '其它轮的消息'))
  await f.land(turn, '本轮正常回答')
  assert.equal(f.sends.at(-1).type, 'group')
  const toolTurn = f.start('group:50001', 'group')
  await f.routing.run(toolTurn, () => f.client.sendToGroup('50001', '工具已回复'))
  // 即使全局滚动记录淘汰了全部旧消息，本轮回执仍然有效。
  for (let i = 0; i < 60; i++) await f.routing.run(other, () => f.client.sendToGroup('60001', `其它消息 ${i}`))
  const before = f.sends.length
  await f.land(toolTurn, '工具后的总结')
  assert.equal(f.sends.length, before)
  assert.equal(f.sends.some((s) => s.target === '10000'), false)
})

test('纯媒体回执不会抑制本轮文字，已发私聊不会重复发送', async () => {
  const f = fixture()
  const group = f.start('group:50001', 'group')
  f.routing.run(group, () => f.routing.recordSent({ type: 'group', target: '50001', text: '' }))
  await f.land(group, '图片说明')
  assert.equal(f.sends.at(-1).text, '图片说明')
  const peer = f.start('private:20001', 'qq')
  await f.routing.run(peer, () => f.client.sendToQQ('20001', '工具已回复'))
  const before = f.sends.length
  await f.land(peer, '重复正文')
  assert.equal(f.sends.length, before)
})

test('发送成功回执之前不标送达；失败保留待办，成功后再消费', async () => {
  const f = fixture()
  const pending = f.routing.rememberPending('20001', '问题')
  const turn = f.start('main', 'window', '回他：好的', 'master')
  const gate = deferred(); f.client.wait = gate.promise; f.client.fail = true
  const task = f.land(turn, '好的')
  await Promise.resolve(); await Promise.resolve()
  assert.equal(f.events.some((e) => e.type === 'message-routed'), false)
  gate.resolve(); await task
  assert.equal(f.events.some((e) => e.type === 'message-routed'), false)
  assert.equal(f.routing.selectPending('private:20001', ''), pending)
  assert.equal(f.failures.length, 1)
  f.client.fail = false; f.client.wait = null
  const retry = f.start('main', 'window', '回他：好的', 'master')
  await f.land(retry, '好的')
  assert.equal(f.events.filter((e) => e.type === 'message-routed').length, 1)
  assert.equal(f.routing.pendingList().length, 0)
})

test('中止发生在异步审核期间也不会发出，后续轮不受影响', async () => {
  const f = fixture()
  f.routing.rememberPending('20001', '问题')
  const gate = deferred()
  f.ctx.classifyReplyIntent = () => gate.promise
  const turn = f.start('main', 'window', '回他：好的', 'master')
  const task = f.land(turn, '好的')
  f.routing.cancel(f.ctx.mainRoute)
  gate.resolve('other'); await task
  assert.equal(f.sends.length, 0)
  assert.equal(f.routing.pendingList().length, 1)
})

test('称呼筛查只阻止疑似私下内容，不凭大家/你们或工具计数换收件人', async () => {
  assert.equal(helpers.isDirectedToBot('你明天有空吗'), false)
  assert.equal(helpers.isDirectedToBot('帮我下载一下'), false)
  assert.equal(helpers.isDirectedToBot('岛灵帮我下载一下'), true)
  assert.equal(helpers.isDirectedToBot('你好', true), true)
  assert.equal(helpers.isDirectedToBot('我在讨论机器人'), false)
  const f = fixture()
  const turn = f.start('group:50001', 'group')
  await f.land(turn, '主人，大家刚才说的密码是 123456，请私下处理。')
  assert.equal(f.sends.length, 0)
  assert.equal(f.gates.at(-1).reason, 'private-content-held')
})

test('真实引擎入口：旧轮异步落定/报错不冒用新标签，也不把新轮设为 idle', async () => {
  const file = ts.createSourceFile('engine.ts', fs.readFileSync('electron/agent/engine/engine.ts', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const entry = file.statements.find((s) => ts.isFunctionDeclaration(s) && s.name?.text === 'createAgentEngine')
  const code = ts.transpileModule(entry.getText(file), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const events = [], turns = [], services = new Map()
  let emit
  const agentContext = { plugin() {}, register: (k, v) => services.set(k, v), get: (k) => services.get(k), dispose() {} }
  const exports = {}
  const sandbox = vm.createContext({ exports, AsyncLocalStorage, AbortController,
    MIN_OUTPUT_TOKENS: 1, MAX_OUTPUT_TOKENS: 262144, MAIN_MAX_OUTPUT_TOKENS: 8192,
    localFreeKey: () => true, createContext: () => agentContext,
    builtinPlugins: (_deps, eventSink) => { emit = eventSink; return [] },
    createRunTurn: () => async (text) => {
      const gate = deferred(); turns.push(gate)
      await gate.promise
      emit({ type: 'message', message: message(text) })
      emit({ type: 'status', status: 'idle' })
      if (text === 'old') throw new Error('late old error')
    },
  })
  vm.runInContext(code, sandbox)
  const engine = exports.createAgentEngine({ getConfig: () => ({}), onEvent: (e) => events.push(e) })
  engine.send('old', [], 'one', 'main', 'OLD')
  engine.abort()
  engine.send('new', [], 'two', 'main', 'NEW')
  events.length = 0
  turns[0].resolve()
  await new Promise((r) => setImmediate(r))
  assert.equal(events.length, 0)
  assert.equal(engine.busy, true)
  turns[1].resolve()
  await new Promise((r) => setImmediate(r))
  assert.equal(events[0].message.parts[0].text, 'new')
  assert.ok(events.every((e) => e.turnTag === 'NEW'))
  assert.equal(engine.busy, false)
  engine.dispose()
})

test('真实渲染消息队列：A/B 连续入队，各自的群元数据完整出队', () => {
  const file = ts.createSourceFile('useAgent.ts', fs.readFileSync('src/hooks/useAgent.ts', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  let receive, drain
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === 'processNapcatGroupMessage') receive = node.initializer.arguments[0]
    if (ts.isCallExpression(node) && node.expression.getText(file) === 'useEffect' && node.arguments[0]?.getText(file).includes('const napcat = napcatQueueRef.current.shift()')) drain = node.arguments[0]
    ts.forEachChild(node, visit)
  }
  visit(file)
  assert.ok(receive && drain)
  const queue = { current: [] }, sent = [], statusRef = { current: 'running' }
  const ctx = vm.createContext({ statusRef, napcatQueueRef: queue, MAX_NAPCAT_QUEUE: 50, myKey: 'group:50001',
    isEmptyNapcatDisplayText: () => false, dedupNapcatMsg: () => false,
    setMessages: () => {}, send: (text, options) => sent.push({ text, options }),
    status: 'idle', silentQueueRef: { current: [] },
  })
  const compile = (fn) => ts.transpileModule(`var callback = ${fn.getText(file)}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  vm.runInContext(compile(receive), ctx)
  for (const qq of ['20001', '30001']) ctx.callback({ text: `问题 ${qq}`, qq, groupId: '50001', groupTurn: { speakerQQ: qq, plain: `原文 ${qq}`, atQQs: [qq], directed: true } })
  assert.equal(queue.current.length, 2)
  vm.runInContext(compile(drain), ctx)
  ctx.callback(); ctx.callback()
  assert.equal(sent[0].options.groupTurn.speakerQQ, '20001')
  assert.equal(sent[1].options.groupTurn.speakerQQ, '30001')
  assert.equal(sent[0].options.groupTurn.plain, '原文 20001')
  assert.equal(sent[1].options.groupTurn.atQQs[0], '30001')
})
