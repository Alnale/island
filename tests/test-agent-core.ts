/**
 * Agent 引擎核心功能测试(后端直测,不经 UI)
 *
 * 覆盖:记忆系统 / MCP stdio+sse 双传输(真实 mock 服务器)/ skills 扫描 /
 * LLM 自我配置工具 / 自我进化(版本化快照/回滚防降级)/ 手动调用解析。
 *
 * electron 依赖经 esbuild 别名替换为 stub(tests/mocks/stub-electron.cjs,
 * Notification 记录到 global.__notifications 供断言)。
 *
 * 运行:node tests/test-agent-core.mjs
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createMemoryStore, createMemoryTools, formatMemoryBlock } from '../electron/agent/memory'
import { isProtectedEntry, PERSONA_TAGS } from '../electron/agent/constants'
import { createMCPManager } from '../electron/agent/mcp'
import { createSkillLoader } from '../electron/agent/skills'
import {
  createAgentEngine,
  createConfigTools,
  parseManualCall,
  findManualTool,
  matchManualToolPrefix,
  compressArgs,
  parseTitleJson,
  extractJsonTitle,
  validateRequiredArgs,
  parseMemoriesJson,
  parseStyleJson,
  buildMemoryExtractSystem,
  buildUserStyleSystem,
  buildClassifierSystem,
  parseClassifierJson,
  createSummaryAgent,
  createMindAgent,
  createReplyClassifier,
  fetchDeepseekBalance,
  sanitizeTitle,
  looksLikeSentenceTitle,
  looksLikeIncompleteMind,
  cutMindSentence,
  salvageMindClause,
  sanitizeMind,
  fallbackTitle,
} from '../electron/agent/engine/engine'
import { buildToolsGuideBlock, createTools, toolOutputDir } from '../electron/agent/tools/tools'
import {
  buildProfileCard,
  createNapcatTools,
  extractImageRefs,
  extractMasterFingerprint,
  extractReplyToStranger,
  extractTurnFingerprint,
  gtkFromCookie,
  isAskTurnToMaster,
  isValidSessionKey,
  napcatMessageImages,
  napcatMessageText,
  newTurnFingerprint,
  REPLY_TO_STRANGER_MARK,
  sessionKeyFor,
  stripFingerprintMarks,
  stripMasterNarration,
  stripThinkingPreamble,
  stripToolNarration,
  turnAlreadySentToPending,
  turnAlreadySentToTarget,
  routeForClassifierIntent,
  looksLikeForwardInstruction,
  type NapcatToolDeps,
  type NapcatClient,
} from '../electron/agent/napcat/napcat'
import { masterIdentityLine } from '../electron/agent/constants'
import { streamResponse } from '../electron/agent/providers/deepseek'
import { sanitizeUnpairedSurrogates } from '../electron/agent/providers/sse'

// 测试主人 QQ 夹具(2026-08-17 隐私配置化:主人 QQ 由 privacy.json 运行时
// 提供,测试改用假号,源码不再出现任何真实 QQ)
const MASTER_QQ = '10000'

// createNapcatTools 现签名收 { client, getSessionKey?, confirmDangerous? } 单参
// (engine.ts 以 deps.napcat 包成 client 注入);测试直接平铺 mock client 方法,
// 这里统一包一层,第二参并入 deps(旧两参调用兼容)
// Partial 让 mock 方法参数获得上下文类型推断(免逐个标注);
// 运行时 createNapcatTools 只调 mock 里实现了的方法,缺失方法不会命中
function napcatTools(mockClient: Partial<NapcatClient>, opts?: Omit<NapcatToolDeps, 'client'>) {
  return createNapcatTools({ ...(opts ?? {}), client: mockClient as NapcatClient })
}
import { createWsSocket, encodeWsFrame, parseWsUrl, WsFrameParser } from '../electron/agent/napcat/wsclient'
import { snapshotWatchDirs, restoreUndoSnapshot, releaseUndoRef, type GitExec } from '../electron/agent/undo'
import { runPluginKernelTests } from './plugin-kernel-tests'
import { hasMasterTurnMark, stripNapcatHistoryInstructions, stripNapcatInstructions, stripTurnMarks } from '../src/agent/text'
import {
  getTasksStatusBlock,
  listTasks,
  pruneTasks,
  registerTask,
  removeTask,
  setTaskDoneHandler,
  getTaskDoneHandler,
  updateTask,
  type AgentTask,
} from '../electron/agent/tasks'
import { createMusicControlTools, createSettingsTools } from '../electron/agent/tools/settingsTools'
import { createSessionTools } from '../electron/agent/tools/sessionTools'
import { applyChanges, createEvolution, evalOutputBudget, evalTimeoutMs, isCleanupChange, mapSeqToEntry, resolveRoundBudget } from '../electron/agent/evolution'
import type { AgentMessage, AgentTool, McpServerConfig, MemoryEntry } from '../electron/agent/types'

// exec_command 的 shell stub(2026-08-14):测试里 `start "some title"`/`dir`
// 等命令不再真起 cmd 进程——此前每次跑测试都弹一个标题为 some title
// 的终端窗口(runCommand 运行时读此变量,生产不设)
process.env.AGENT_TEST_STUB_SHELL = '1'

// 打包产物运行时路径会变(import.meta.url 指向 node_modules/.cache),
// mock 服务器目录由 esbuild define 注入(__ROOT__ = 项目根)
declare const __ROOT__: string
const mockDir = path.join(__ROOT__, 'tests', 'mocks')

/** 多供应商字段(AgentConfig 2026-08-14 新增;lmstudio 2026-08-18;
 * glm 2026-08-19):测试运行时不读取,纯满足类型检查 */
const MOCK_PROVIDERS = {
  activeProvider: 'deepseek' as const,
  providers: {
    deepseek: { apiKey: '', baseURL: '', model: '' },
    mimo: { apiKey: '', baseURL: '', model: '' },
    lmstudio: { apiKey: '', baseURL: '', model: '' },
    glm: { apiKey: '', baseURL: '', model: '' },
  },
}

// ---------------------------------------------------------------------------
// 测试框架(顺序执行,失败不中断)
// ---------------------------------------------------------------------------

let passed = 0
let failed = 0
const failures: string[] = []

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failed++
    failures.push(`${name}:\n    ${(err as Error).stack ?? err}`)
    console.error(`  ✗ ${name}\n    ${(err as Error).message}`)
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`断言失败:${msg}`)
}

/** 断言异步函数抛出(错误消息可选包含关键字) */
async function assertRejects(fn: () => Promise<unknown>, keyword?: string, msg = '应抛出'): Promise<void> {
  try {
    await fn()
  } catch (err) {
    const text = String((err as Error)?.message ?? err)
    if (keyword && !text.includes(keyword)) {
      throw new Error(`断言失败:${msg}(错误应含「${keyword}」,实际:${text})`)
    }
    return
  }
  throw new Error(`断言失败:${msg}`)
}

/** 轮询等待条件成立(最多 timeout ms) */
async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 8000, what = '条件'): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((r) => setTimeout(r, 60))
  }
  throw new Error(`等待超时:${what}`)
}

/** 读取文件(不存在抛错) */
async function readJson(p: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(p, 'utf8'))
}

// ---------------------------------------------------------------------------
// 准备:临时目录 + mock 服务器
// ---------------------------------------------------------------------------

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-test-'))
// 每个记忆用例用独立文件(写盘是异步队列,共享文件会读到旧数据)
const memoryFile = (n: number) => path.join(tmp, `memory-${n}.json`)
const memoryDir = tmp

/** 启动 SSE mock 服务器(自管理句柄),等待就绪,返回 {proc, port} */
async function startSseMock(env: Record<string, string>): Promise<{ proc: ChildProcess; port: number }> {
  const proc = spawn(process.execPath, [path.join(mockDir, 'mock-mcp-sse.cjs')], {
    env: { ...process.env, MOCK_PORT: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let port = 0
  proc.stdout?.on('data', (d: Buffer) => {
    const m = /MOCK_SSE_PORT=(\d+)/.exec(d.toString())
    if (m) port = Number(m[1])
  })
  proc.stderr?.on('data', (d: Buffer) => process.stderr.write(`[mock-sse] ${d}`))
  await waitFor(() => port > 0, 8000, 'SSE mock 端口就绪')
  await waitFor(async () => {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`)
      return r.ok
    } catch {
      return false
    }
  }, 8000, 'SSE mock health')
  return { proc, port }
}

function killProc(proc: ChildProcess | null) {
  if (!proc || proc.exitCode !== null) return
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } else {
      proc.kill()
    }
  } catch {
    proc.kill()
  }
}

console.log('准备 mock 服务器…')
const sseStd = await startSseMock({})
const ssePort = sseStd.port
const sseDirect = await startSseMock({ MOCK_DIRECT_RESPONSE: '1' })
const sseDirectPort = sseDirect.port
const sseBare = await startSseMock({ MOCK_PUSH_STYLE: 'bare' })
const sseBarePort = sseBare.port

// ---------------------------------------------------------------------------
// 1. 记忆系统
// ---------------------------------------------------------------------------

console.log('\n=== 记忆系统(memory.ts) ===')

await test('add/list:写入与读取', async () => {
  const store = createMemoryStore(() => memoryFile(1))
  await store.add({ content: '用户喜欢简洁回答', type: 'preference' })
  await store.add({ content: '项目在 D:/work', type: 'fact', tags: ['project'] })
  const list = await store.list()
  assert(list.length === 2, `应有 2 条,实际 ${list.length}`)
  const prefs = list.filter((e) => e.type === 'preference')
  assert(prefs.length === 1 && prefs[0].content === '用户喜欢简洁回答', 'preference 条目内容不符')
  assert(list[0].updatedAt >= list[1].updatedAt, '应按更新时间倒序')
  // 文件已落盘(写盘是异步队列,轮询等待)
  await waitFor(async () => {
    try {
      const onDisk = (await readJson(memoryFile(1))) as { entries: MemoryEntry[] }
      return onDisk.entries.length === 2
    } catch {
      return false
    }
  }, 5000, '记忆文件落盘')
})

await test('add:相同内容去重', async () => {
  const store = createMemoryStore(() => memoryFile(2))
  const r1 = await store.add({ content: '重复内容', type: 'fact' })
  const r2 = await store.add({ content: '重复内容', type: 'fact' })
  assert(r1.created === true && r2.created === false, '第二次应去重(created=false)')
  const list = await store.list()
  assert(list.filter((e) => e.content === '重复内容').length === 1, '不应重复出现')
})

await test('上限 200 条:淘汰最旧', async () => {
  const store = createMemoryStore(() => memoryFile(3))
  for (let i = 0; i < 205; i++) await store.add({ content: `批量条目 ${i}`, type: 'fact' })
  const list = await store.list()
  assert(list.length === 200, `应裁剪到 200,实际 ${list.length}`)
  assert(!list.some((e) => e.content === '批量条目 0'), '最旧的应被淘汰')
  assert(list.some((e) => e.content === '批量条目 204'), '最新的应保留')
})

await test('remove:按 id 与内容片段', async () => {
  const store = createMemoryStore(() => memoryFile(4))
  const added = await store.add({ content: '待删除一', type: 'fact' })
  await store.add({ content: '待删除二', type: 'fact' })
  const n1 = await store.remove(added.entry.id)
  assert(n1 === 1, '按 id 删除应删 1 条')
  const n2 = await store.remove('待删除二')
  assert(n2 === 1, '按内容片段删除应删 1 条')
  assert((await store.list()).length === 0, '应删光')
})

await test('update:改内容与类型', async () => {
  const store = createMemoryStore(() => memoryFile(5))
  const added = await store.add({ content: '旧内容', type: 'fact' })
  const updated = await store.update(added.entry.id, { content: '新内容', type: 'lesson' })
  assert(updated?.content === '新内容' && updated.type === 'lesson', 'update 应生效')
  assert((await store.update('不存在的id', { content: 'x' })) === null, '未知 id 返回 null')
})

await test('importEntries:按 id/内容去重合并,新导入置顶', async () => {
  const store = createMemoryStore(() => memoryFile(8))
  const existing = await store.add({ content: '已有条目', type: 'fact' })
  // 导入:1 条与现有 id 相同、1 条与现有内容相同、2 条全新
  const r = await store.importEntries([
    { id: existing.entry.id, type: 'fact', content: '已有条目(同 id)', createdAt: 1, updatedAt: 1 },
    { id: 'x2', type: 'preference', content: '已有条目', createdAt: 1, updatedAt: 1 },
    { id: 'x3', type: 'lesson', content: '导入的教训', createdAt: 1, updatedAt: 1 },
    { id: 'x4', type: 'workflow', content: '导入的工作流', createdAt: 1, updatedAt: 1 },
  ])
  assert(r.imported === 2 && r.skipped === 2, `应导入 2 跳过 2,实际 ${JSON.stringify(r)}`)
  const list = await store.list()
  // 新导入在前(list 按 updatedAt 倒序,导入的 updatedAt 未改时为旧值,
  // 置顶由合并顺序保证——entries 数组里 fresh 在 existing 前)
  assert(list[0].content === '导入的教训' || list[0].content === '导入的工作流', '新导入的应排最前')
  assert(list.length === 3, '合并后共 3 条(2 新 + 1 旧)')
})

await test('importEntries:总量超 200 时淘汰最旧,新导入保留', async () => {
  const store = createMemoryStore(() => memoryFile(9))
  // 用 replaceAll 造 195 条时间戳严格递增的旧数据(逐条 add 的
  // Date.now 可能同毫秒,排序不稳定,断言会误报)
  await store.replaceAll(
    Array.from({ length: 195 }, (_, i) => ({
      id: `old-${i}`,
      type: 'fact' as const,
      content: `旧条目 ${i}`,
      createdAt: 1000 + i,
      updatedAt: 1000 + i,
    })),
  )
  const r = await store.importEntries(
    Array.from({ length: 10 }, (_, i) => ({
      id: `imp-${i}`,
      type: 'fact' as const,
      content: `导入条目 ${i}`,
      createdAt: 1,
      updatedAt: 1,
    })),
  )
  assert(r.imported === 10 && r.skipped === 0, '10 条全新应全部导入')
  const list = await store.list()
  assert(list.length === 200, `应裁剪到 200,实际 ${list.length}`)
  assert(list.some((e) => e.content === '导入条目 0'), '新导入的应保留')
  assert(!list.some((e) => e.content === '旧条目 0'), '最旧的应被淘汰')
  assert(list.some((e) => e.content === '旧条目 194'), '最新的旧条目应保留')
})

await test('并发写:串行队列不丢数据', async () => {
  const store = createMemoryStore(() => memoryFile(6))
  await Promise.all(
    Array.from({ length: 10 }, (_, i) => store.add({ content: `并发条目 ${i}`, type: 'fact' })),
  )
  // 串行写队列:10 次并发 add 最终应全部落盘(轮询等待写盘链完成)
  await waitFor(async () => {
    try {
      const onDisk = (await readJson(memoryFile(6))) as { entries: MemoryEntry[] }
      return onDisk.entries.length === 10
    } catch {
      return false
    }
  }, 5000, '并发写全部落盘')
})

await test('formatMemoryBlock:分组顺序与空返回', () => {
  const entries: MemoryEntry[] = [
    { id: '1', type: 'workflow', content: '先读后写', createdAt: 1, updatedAt: 1 },
    { id: '2', type: 'preference', content: '喜欢简洁', createdAt: 2, updatedAt: 2 },
    { id: '3', type: 'fact', content: '项目路径', createdAt: 3, updatedAt: 3 },
  ]
  const block = formatMemoryBlock(entries)
  assert(block.includes('【长期记忆'), '应含标题')
  assert(block.indexOf('[偏好] 喜欢简洁') < block.indexOf('[事实] 项目路径'), '偏好应在事实前')
  assert(block.indexOf('[事实] 项目路径') < block.indexOf('[工作流] 先读后写'), '事实应在工作流前')
  assert(formatMemoryBlock([]) === '', '空列表返回空串')
})

await test('snapshot:备份文件内容一致', async () => {
  const store = createMemoryStore(() => memoryFile(7))
  await store.add({ content: '快照内容', type: 'fact' })
  const bak = path.join(tmp, 'snap.bak')
  await store.snapshot(bak)
  const snap = (await readJson(bak)) as { entries: MemoryEntry[] }
  assert(snap.entries.some((e) => e.content === '快照内容'), '快照应包含当前条目')
})

// ---------------------------------------------------------------------------
// 2. MCP stdio
// ---------------------------------------------------------------------------

console.log('\n=== MCP stdio 传输(mcp.ts) ===')

const mockStdio = path.join(mockDir, 'mock-mcp-stdio.cjs')
const pidFile = path.join(tmp, 'mock-stdio.pid')
const stdioCfg = {
  name: 'mock',
  type: 'stdio' as const,
  command: process.execPath,
  args: [mockStdio],
  env: { MOCK_PID_FILE: pidFile },
}

await test('握手 + 工具命名(mcp_ 前缀 + sanitize + 重名序号)', async () => {
  const mgr = createMCPManager()
  try {
    const tools = await mgr.listTools([stdioCfg])
    const names = tools.map((t) => t.name)
    assert(names.includes('mcp_mock_read_file'), `应含 mcp_mock_read_file,实际:${names.join(',')}`)
    assert(names.includes('mcp_mock_read_file_2'), 'read_file 与 read-file sanitize 后重名应加序号 _2')
    assert(names.includes('mcp_mock_echo'), '应含 mcp_mock_echo')
    assert(tools.length === 6, `应有 6 个工具,实际 ${tools.length}`)
    // 描述带服务名前缀
    const echo = tools.find((t) => t.name === 'mcp_mock_echo')!
    assert(echo.description.startsWith('[MCP 服务:mock]'), '描述应带服务名前缀')
  } finally {
    mgr.dispose()
  }
})

await test('非 object schema → parameters 包 input 字段', async () => {
  const mgr = createMCPManager()
  try {
    const tools = await mgr.listTools([stdioCfg])
    const echo = tools.find((t) => t.name === 'mcp_mock_echo')!
    assert(echo.parameters.type === 'object', 'parameters 必须是 object')
    assert('input' in (echo.parameters.properties as Record<string, unknown>), '字符串 schema 应包 input 字段')
    const readFile = tools.find((t) => t.name === 'mcp_mock_read_file')!
    assert(readFile.parameters.required?.includes('path'), 'object schema 的 required 应透传')
  } finally {
    mgr.dispose()
  }
})

await test('工具调用:参数往返', async () => {
  const mgr = createMCPManager()
  try {
    const tools = await mgr.listTools([stdioCfg])
    const echo = tools.find((t) => t.name === 'mcp_mock_echo')!
    const out = String(await echo.execute({ input: '你好世界' }))
    assert(out.includes('echo:') && out.includes('你好世界'), `echo 应回显参数,实际:${out}`)
  } finally {
    mgr.dispose()
  }
})

await test('服务端 isError → execute 抛错', async () => {
  const mgr = createMCPManager()
  try {
    const tools = await mgr.listTools([stdioCfg])
    const fail = tools.find((t) => t.name === 'mcp_mock_fail_always')!
    let threw = false
    try {
      await fail.execute({})
    } catch {
      threw = true
    }
    assert(threw, 'isError 应抛错')
  } finally {
    mgr.dispose()
  }
})

await test('图像内容块 → 文本标注', async () => {
  const mgr = createMCPManager()
  try {
    const tools = await mgr.listTools([stdioCfg])
    const image = tools.find((t) => t.name === 'mcp_mock_image')!
    const out = String(await image.execute({}))
    assert(out.includes('[图像结果') && out.includes('image/png'), `应标注图像,实际:${out}`)
  } finally {
    mgr.dispose()
  }
})

await test('进程崩溃自动重启', async () => {
  const mgr = createMCPManager()
  try {
    const tools = await mgr.listTools([stdioCfg])
    const crash = tools.find((t) => t.name === 'mcp_mock_crash_me')!
    let threw = false
    try {
      await crash.execute({})
    } catch {
      threw = true
    }
    assert(threw, 'crash_me 调用应失败(进程自杀)')
    // 同一工具列表里 echo 是同一客户端实例:调用触发自动重启
    const echo = tools.find((t) => t.name === 'mcp_mock_echo')!
    const out = String(await echo.execute({ input: '重启后' }))
    assert(out.includes('重启后'), `崩溃后应自动重启并成功,实际:${out}`)
  } finally {
    mgr.dispose()
  }
})

await test('并发 connect 互斥:只拉起一个进程', async () => {
  await fs.rm(pidFile, { force: true })
  const mgr = createMCPManager()
  try {
    const results = await Promise.all(
      Array.from({ length: 4 }, () => mgr.listTools([stdioCfg]).then((t) => t.length)),
    )
    assert(results.every((n) => n === 6), '4 次并发 listTools 应全部成功')
    const pids = (await fs.readFile(pidFile, 'utf8')).trim().split('\n').filter(Boolean)
    assert(pids.length === 1, `并发 connect 应只拉起一个进程,实际 pid 记录:${pids.join(',')}`)
  } finally {
    mgr.dispose()
  }
})

await test('配置变更 prune:旧客户端销毁,新配置生效', async () => {
  const mgr = createMCPManager()
  try {
    const a = await mgr.listTools([stdioCfg])
    assert(a.length === 6, '配置 A 应列出 6 个工具')
    const cfgB = { ...stdioCfg, name: 'mock2' }
    const b = await mgr.listTools([cfgB])
    assert(b.length === 6 && b[0].name.startsWith('mcp_mock2_'), '配置 B 应生效(mcp_mock2_ 前缀)')
  } finally {
    mgr.dispose()
  }
})

await test('dispose 后无异常(进程树清理)', async () => {
  const mgr = createMCPManager()
  await mgr.listTools([stdioCfg])
  mgr.dispose()
  mgr.dispose() // 幂等
})

// ---------------------------------------------------------------------------
// 3. MCP sse
// ---------------------------------------------------------------------------

console.log('\n=== MCP sse 传输(mcp.ts) ===')

const sseCfg = { name: 'mock-sse', type: 'sse' as const, command: '', url: `http://127.0.0.1:${ssePort}/sse` }

await test('握手(endpoint 事件)+ 工具映射', async () => {
  const mgr = createMCPManager()
  try {
    const tools = await mgr.listTools([sseCfg])
    const names = tools.map((t) => t.name)
    assert(names.includes('mcp_mock-sse_echo') || names.includes('mcp_mock_sse_echo'), `应含 echo 工具,实际:${names.join(',')}`)
    assert(tools.length === 2, `应有 2 个工具,实际 ${tools.length}`)
  } finally {
    mgr.dispose()
  }
})

await test('sse 工具调用(事件流推送路径)', async () => {
  const mgr = createMCPManager()
  try {
    const tools = await mgr.listTools([sseCfg])
    const echo = tools.find((t) => t.name.includes('echo'))!
    const out = String(await echo.execute({ text: 'sse你好' }))
    assert(out.includes('sse你好'), `sse echo 应回显,实际:${out}`)
  } finally {
    mgr.dispose()
  }
})

await test('sse isError → 抛错', async () => {
  const mgr = createMCPManager()
  try {
    const tools = await mgr.listTools([sseCfg])
    const fail = tools.find((t) => t.name.includes('fail_always'))!
    let threw = false
    try {
      await fail.execute({})
    } catch {
      threw = true
    }
    assert(threw, 'sse isError 应抛错')
  } finally {
    mgr.dispose()
  }
})

await test('sse 直接响应体变体(兼容路径)', async () => {
  const mgr = createMCPManager()
  try {
    const cfg = { name: 'direct', type: 'sse' as const, command: '', url: `http://127.0.0.1:${sseDirectPort}/sse` }
    const tools = await mgr.listTools([cfg])
    const echo = tools.find((t) => t.name.includes('echo'))!
    const out = String(await echo.execute({ text: 'direct' }))
    assert(out.includes('direct'), `直接响应路径应成功,实际:${out}`)
  } finally {
    mgr.dispose()
  }
})

await test('sse bare 推送变体(无 event 行)', async () => {
  const mgr = createMCPManager()
  try {
    const cfg = { name: 'bare', type: 'sse' as const, command: '', url: `http://127.0.0.1:${sseBarePort}/sse` }
    const tools = await mgr.listTools([cfg])
    assert(tools.length === 2, 'bare 推送也应能握手列工具')
    const echo = tools.find((t) => t.name.includes('echo'))!
    const out = String(await echo.execute({ text: 'bare' }))
    assert(out.includes('bare'), `bare 推送调用应成功,实际:${out}`)
  } finally {
    mgr.dispose()
  }
})

// ---------------------------------------------------------------------------
// 4. skills 扫描
// ---------------------------------------------------------------------------

console.log('\n=== 技能加载(skills.ts) ===')

const skillsDir = path.join(tmp, 'skills-root')
await fs.mkdir(path.join(skillsDir, 'note-taking'), { recursive: true })
await fs.mkdir(path.join(skillsDir, '中文技能'), { recursive: true })
await fs.mkdir(path.join(skillsDir, 'dup-skill'), { recursive: true })
await fs.mkdir(path.join(skillsDir, 'no-skill-dir'), { recursive: true })
await fs.mkdir(path.join(skillsDir, '.hidden-skill'), { recursive: true })
await fs.mkdir(path.join(skillsDir, '_private-skill'), { recursive: true })

await fs.writeFile(
  path.join(skillsDir, 'note-taking', 'SKILL.md'),
  '---\nname: note-taking\ndescription: 记笔记的技能,用于整理知识\n---\n\n# Note Taking\n\n步骤 1: 记录\n步骤 2: 整理',
  'utf8',
)
await fs.writeFile(path.join(skillsDir, '中文技能', 'SKILL.md'), '# 无 frontmatter\n\n直接正文内容\n', 'utf8')
await fs.writeFile(
  path.join(skillsDir, 'dup-skill', 'SKILL.md'),
  '---\nname: note-taking\ndescription: 与上面同名\n---\n\n# Dup\n\n重复技能',
  'utf8',
)
// 长描述截断用例
await fs.mkdir(path.join(skillsDir, 'long-desc'), { recursive: true })
await fs.writeFile(
  path.join(skillsDir, 'long-desc', 'SKILL.md'),
  `---\nname: long-desc\ndescription: ${'长'.repeat(500)}\n---\n\n# Long\n\n长描述技能`,
  'utf8',
)

await test('扫描:frontmatter 解析 + slug 规则 + 重名序号', async () => {
  const loader = createSkillLoader()
  const tools = await loader.listTools([skillsDir])
  const names = tools.map((t) => t.name)
  assert(names.includes('skill_note-taking'), `应含 skill_note-taking,实际:${names.join(',')}`)
  assert(names.includes('skill_note-taking_2'), '重名(frontmatter 同名)应加序号 _2')
  assert(names.includes('skill_skill'), '中文名(无 ASCII)应回退 skill')
  assert(names.includes('skill_long-desc'), '应含 long-desc')
  assert(!names.some((n) => n.includes('no-skill')), '无 SKILL.md 的目录应跳过')
  assert(!names.some((n) => n.includes('hidden') || n.includes('private')), '隐藏目录应跳过')
  assert(tools.length === 4, `应有 4 个技能,实际 ${tools.length}`)
})

await test('描述截断 300 + 压单行', async () => {
  const loader = createSkillLoader()
  const tools = await loader.listTools([skillsDir])
  const long = tools.find((t) => t.name === 'skill_long-desc')!
  // description = "技能:" + 截断 300 的 frontmatter 描述 + 尾注(约 340 字符)
  assert(long.description.length < 400, `描述应截断,实际长度 ${long.description.length}`)
  assert(!long.description.includes('长'.repeat(400)), '超长原文不应完整保留')
  assert(!long.description.includes('\n'), '描述应压单行')
})

await test('执行:返回文档 + 技能目录绝对路径', async () => {
  const loader = createSkillLoader()
  const tools = await loader.listTools([skillsDir])
  // 重名技能按目录名字母序分配名称,用描述区分(记笔记的才是 note-taking)
  const note = tools.find((t) => t.description.includes('记笔记'))!
  const out = String(await note.execute({}))
  assert(out.includes('步骤 1'), '应返回文档正文')
  assert(out.includes(path.join(skillsDir, 'note-taking')), '应含技能目录绝对路径')
})

await test('不存在的目录静默跳过', async () => {
  const loader = createSkillLoader()
  const tools = await loader.listTools([path.join(tmp, 'not-exists-dir')])
  assert(tools.length === 0, '不存在目录应返回空')
})

// ---------------------------------------------------------------------------
// 5. LLM 自我配置工具(createConfigTools)
// ---------------------------------------------------------------------------

console.log('\n=== LLM 自我配置工具(createConfigTools) ===')

function makeConfigToolsDeps(
  initial: { mcpServers?: McpServerConfig[]; skillsDirs?: string[]; excludedSkills?: string[] } = {},
  opts: { skillDir?: string } = {},
) {
  const state = {
    config: {
      ...MOCK_PROVIDERS,
      apiKey: '',
      baseURL: '',
      model: '',
      systemPrompt: '',
      reasoningEffort: 'high',
      mcpServers: initial.mcpServers ?? [],
      skillsDirs: initial.skillsDirs ?? [],
      excludedSkills: initial.excludedSkills ?? [],
      // 工具输出根目录(2026-08-12):get/set 测试
      outputDir: '',
    },
  }
  const writes: Array<Record<string, unknown>> = []
  const tools = createConfigTools({
    getConfig: () => state.config,
    updateAgentConfig: (patch) => {
      writes.push(patch as Record<string, unknown>)
      Object.assign(state.config, patch)
    },
    testMcp: async (server) => (server.name === 'ok-server' ? { ok: true, toolCount: 3 } : { ok: false, error: '连接失败' }),
    // 技能扫描:mock 固定技能(其它测试期望)+ **真实扫描创建目录**
    // (create 后同名冲突检查才能扫到刚创建的技能,与生产一致)
    listSkills: async (_dirs, excluded) => {
      const created = await createSkillLoader().listTools(
        [opts.skillDir ?? path.join(tmp, 'skill-create-dir')],
        excluded,
      )
      return [
        { name: 'skill_note-taking', description: '', parameters: { type: 'object', properties: {} }, execute: async () => '' },
        { name: 'skill_trump-perspective', description: '', parameters: { type: 'object', properties: {} }, execute: async () => '' },
        ...created,
      ]
    },
    getSkillDir: () => opts.skillDir ?? path.join(tmp, 'skill-create-dir'),
  })
  return { state, writes, tools }
}

await test('mcp_config add(stdio):写入配置并校验参数', async () => {
  const { state, writes, tools } = makeConfigToolsDeps()
  const mcp = tools.find((t) => t.name === 'mcp_config')!
  const out = String(await mcp.execute({
    action: 'add',
    name: 'filesystem',
    command: 'npx -y @modelcontextprotocol/server-filesystem',
    args: ['C:/dir', 'D:/dir'],
    env: { TOKEN: 'abc' },
  }))
  assert(out.includes('filesystem'), 'add 结果应含服务名')
  assert(writes.length === 1, '应写一次配置')
  const servers = writes[0].mcpServers as Array<Record<string, unknown>>
  assert(servers.length === 1 && servers[0].name === 'filesystem', '服务名应写入')
  assert(servers[0].type === 'stdio' && (servers[0].command as string).includes('npx'), 'stdio 字段应写入')
  assert((servers[0].env as Record<string, string>).TOKEN === 'abc', 'env 应写入')
  assert(state.config.mcpServers.length === 1, '状态应更新')
})

await test('mcp_config add(sse):url 校验', async () => {
  const { tools } = makeConfigToolsDeps()
  const mcp = tools.find((t) => t.name === 'mcp_config')!
  let threw = false
  try {
    await mcp.execute({ action: 'add', name: 'remote', type: 'sse', url: 'not-a-url' })
  } catch {
    threw = true
  }
  assert(threw, '非法 url 应抛错')
  const out = String(await mcp.execute({ action: 'add', name: 'remote', type: 'sse', url: 'https://example.com/mcp/sse' }))
  assert(out.includes('remote'), '合法 sse 应添加成功')
})

await test('mcp_config:重复 add / remove 不存在 → 抛错', async () => {
  const { tools } = makeConfigToolsDeps({ mcpServers: [{ name: 'existing', type: 'stdio', command: 'x' }] })
  const mcp = tools.find((t) => t.name === 'mcp_config')!
  let threw = false
  try {
    await mcp.execute({ action: 'add', name: 'existing', command: 'y' })
  } catch {
    threw = true
  }
  assert(threw, '重复 add 应抛错')
  threw = false
  try {
    await mcp.execute({ action: 'remove', name: 'nope' })
  } catch {
    threw = true
  }
  assert(threw, 'remove 不存在应抛错')
})

await test('mcp_config test:注入的 testMcp 被调用', async () => {
  const { tools } = makeConfigToolsDeps({ mcpServers: [{ name: 'ok-server', type: 'stdio', command: 'x' }] })
  const mcp = tools.find((t) => t.name === 'mcp_config')!
  const out = String(await mcp.execute({ action: 'test', name: 'ok-server' }))
  assert(out.includes('3 个工具'), `test 应返回工具数,实际:${out}`)
})

await test('skills_config add/remove/list', async () => {
  const { writes, tools } = makeConfigToolsDeps()
  const sc = tools.find((t) => t.name === 'skills_config')!
  const addOut = String(await sc.execute({ action: 'add', dir: 'C:/skills' }))
  assert(addOut.includes('C:/skills'), 'add 结果应含目录')
  const lastWrite = writes[writes.length - 1]
  assert(lastWrite !== undefined, '应有写入记录')
  assert((lastWrite.skillsDirs as string[]).includes('C:/skills'), '应写入 skillsDirs')
  const dup = String(await sc.execute({ action: 'add', dir: 'C:/skills' }))
  assert(dup.includes('已存在'), '重复 add 应提示已存在')
  const removeOut = String(await sc.execute({ action: 'remove', dir: 'C:/skills' }))
  assert(removeOut.includes('已移除'), 'remove 应成功')
  let threw = false
  try {
    await sc.execute({ action: 'remove', dir: 'C:/nope' })
  } catch {
    threw = true
  }
  assert(threw, 'remove 不存在应抛错')
})

await test('skills_config exclude/include:移除/恢复技能', async () => {
  const { state, writes, tools } = makeConfigToolsDeps()
  const sc = tools.find((t) => t.name === 'skills_config')!
  // list 应列出技能(含排除状态标注)
  const listOut = String(await sc.execute({ action: 'list' }))
  assert(listOut.includes('note-taking') && listOut.includes('trump-perspective'), 'list 应列出注册技能')
  // exclude 已注册技能 → 写入 excludedSkills
  const exOut = String(await sc.execute({ action: 'exclude', skill: 'note-taking' }))
  assert(exOut.includes('已移除技能 note-taking'), `exclude 结果:${exOut}`)
  const lastExclude = writes[writes.length - 1]
  assert(lastExclude !== undefined, '应有写入记录')
  assert((lastExclude.excludedSkills as string[]).includes('note-taking'), '应写入 excludedSkills')
  assert(state.config.excludedSkills.includes('note-taking'), '状态应更新')
  // 重复 exclude 幂等
  await sc.execute({ action: 'exclude', skill: 'note-taking' })
  assert(state.config.excludedSkills.filter((s: string) => s === 'note-taking').length === 1, '重复 exclude 不重复添加')
  // exclude 不存在的技能 → 抛错
  let threw = false
  try {
    await sc.execute({ action: 'exclude', skill: 'ghost-skill' })
  } catch {
    threw = true
  }
  assert(threw, 'exclude 不存在的技能应抛错')
  // include 恢复
  const inOut = String(await sc.execute({ action: 'include', skill: 'note-taking' }))
  assert(inOut.includes('已恢复技能 note-taking'), `include 结果:${inOut}`)
  assert(!state.config.excludedSkills.includes('note-taking'), '恢复后不在排除列表')
  // include 未排除的技能 → 抛错
  threw = false
  try {
    await sc.execute({ action: 'include', skill: 'note-taking' })
  } catch {
    threw = true
  }
  assert(threw, 'include 未排除技能应抛错')
})

await test('skills_config create:自然语言创建技能', async () => {
  const skillDir = path.join(tmp, 'skill-create-real')
  const { tools } = makeConfigToolsDeps({}, { skillDir })
  const sc = tools.find((t) => t.name === 'skills_config')!
  // 创建成功:文件落盘 + frontmatter 规范化
  const out = String(await sc.execute({
    action: 'create',
    name: 'My Great Skill',
    description: '处理XX任务的技能,用于XX场景',
    content: '# My Skill\n\n步骤 1: 做A\n步骤 2: 做B',
  }))
  assert(out.includes('已创建技能 my-great-skill'), `create 结果:${out}`)
  assert(out.includes('SKILL.md'), '应返回文件路径')
  const md = await fs.readFile(path.join(skillDir, 'my-great-skill', 'SKILL.md'), 'utf8')
  assert(md.startsWith('---\nname: my-great-skill\ndescription: 处理XX任务的技能,用于XX场景\n---\n'), 'frontmatter 应规范化')
  assert(md.includes('步骤 1: 做A'), '正文应完整写入')
  // 重名冲突:未 overwrite → 抛错
  let threw = false
  try {
    await sc.execute({ action: 'create', name: 'my-great-skill', description: 'x', content: 'y' })
  } catch {
    threw = true
  }
  assert(threw, '同名技能未 overwrite 应抛错')
  // overwrite 覆盖成功
  const overwriteOut = String(await sc.execute({
    action: 'create',
    name: 'my-great-skill',
    description: '新描述',
    content: '新内容',
    overwrite: true,
  }))
  assert(overwriteOut.includes('已创建技能 my-great-skill'), 'overwrite 应成功')
  const md2 = await fs.readFile(path.join(skillDir, 'my-great-skill', 'SKILL.md'), 'utf8')
  assert(md2.includes('新描述') && md2.includes('新内容'), '覆盖后内容为新版')
  // 参数校验:缺 name/description/content → 抛错
  for (const bad of [
    { action: 'create', description: 'd', content: 'c' },
    { action: 'create', name: 'n', content: 'c' },
    { action: 'create', name: 'n', description: 'd' },
  ]) {
    threw = false
    try {
      await sc.execute(bad)
    } catch {
      threw = true
    }
    assert(threw, `缺参应抛错:${JSON.stringify(bad)}`)
  }
  // slug 化:大写/空格/符号 → 小写连字符;中文按工具名约束丢弃
  // (LLM 工具名仅 ASCII,与 skills.ts toSlug 一致)
  const out2 = String(await sc.execute({ action: 'create', name: '测试 SKILL X!', description: 'd', content: 'c' }))
  assert(out2.includes('已创建技能 skill-x'), `slug 应规范化:${out2}`)
})

await test('skills.ts:来源三区(created/imported/scanned)', async () => {
  const loader = createSkillLoader()
  // 三个技能:ownDir 无标记(灵动岛创建)/ ownDir 有导入标记(手动导入)/ 外部目录(扫描)
  const ownDir = path.join(tmp, 'skills-own')
  const scanDir = path.join(tmp, 'skills-scan')
  await fs.mkdir(path.join(ownDir, 'my-skill'), { recursive: true })
  await fs.mkdir(path.join(ownDir, 'imported-skill'), { recursive: true })
  await fs.mkdir(path.join(scanDir, 'external-skill'), { recursive: true })
  await fs.writeFile(path.join(ownDir, 'my-skill', 'SKILL.md'), '---\nname: my-skill\n---\n\n# Mine', 'utf8')
  await fs.writeFile(path.join(ownDir, 'imported-skill', 'SKILL.md'), '---\nname: imported-skill\n---\n\n# Imported', 'utf8')
  await fs.writeFile(path.join(scanDir, 'external-skill', 'SKILL.md'), '---\nname: external-skill\n---\n\n# External', 'utf8')
  // 导入标记:imported-skill 目录写 .island-imported
  await fs.writeFile(path.join(ownDir, 'imported-skill', '.island-imported'), 'imported by user\n')
  // 不传 ownDirs:全部 scanned
  const noOwn = await loader.listTools([ownDir, scanDir])
  assert(noOwn.every((t) => t.sourceKind === 'scanned'), '未标记 ownDirs 时全部 scanned')
  // 传 ownDirs:无标记 = created;有导入标记 = imported;外部 = scanned
  const parted = await loader.listTools([ownDir, scanDir], [], [ownDir])
  const my = parted.find((t) => t.name === 'skill_my-skill')
  const imp = parted.find((t) => t.name === 'skill_imported-skill')
  const ext = parted.find((t) => t.name === 'skill_external-skill')
  assert(my?.sourceKind === 'created', 'ownDir 无标记应 created')
  assert(imp?.sourceKind === 'imported', '有导入标记应 imported')
  assert(ext?.sourceKind === 'scanned', '外部目录应 scanned')
  // 大小写不敏感(Windows 路径)
  const partedCase = await loader.listTools([ownDir, scanDir], [], [ownDir.toUpperCase()])
  assert(partedCase.find((t) => t.name === 'skill_my-skill')?.sourceKind === 'created', 'ownDirs 大小写不敏感')
})

await test('skills.ts:排除列表过滤(扫描跳过)', async () => {
  const loader = createSkillLoader()
  const dir = path.join(tmp, 'skills-exclude-test')
  await fs.mkdir(path.join(dir, 'skill-a'), { recursive: true })
  await fs.mkdir(path.join(dir, 'skill-b'), { recursive: true })
  await fs.writeFile(path.join(dir, 'skill-a', 'SKILL.md'), '---\nname: a\n---\n\n# A', 'utf8')
  await fs.writeFile(path.join(dir, 'skill-b', 'SKILL.md'), '---\nname: b\n---\n\n# B', 'utf8')
  const all = await loader.listTools([dir])
  assert(all.length === 2, `未排除应有 2 个技能,实际 ${all.length}`)
  const filtered = await loader.listTools([dir], ['a'])
  assert(filtered.length === 1 && filtered[0].name === 'skill_b', '排除 a 后应只剩 skill_b')
  const filteredBoth = await loader.listTools([dir], ['a', 'b'])
  assert(filteredBoth.length === 0, '全部排除后应为空')
})

// ---------------------------------------------------------------------------
// 6. 手动调用解析
// ---------------------------------------------------------------------------

console.log('\n=== 手动调用解析(/ 与 @) ===')

await test('parseManualCall:前缀/参数/普通文本', () => {
  const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
  assert(eq(parseManualCall('/skill_x'), { name: 'skill_x', rest: '' }), '/技能名 应解析')
  assert(eq(parseManualCall('/skill_x 附加说明'), { name: 'skill_x', rest: '附加说明' }), '附加文本应解析')
  assert(eq(parseManualCall('@mcp_srv_tool {"a":1}'), { name: 'mcp_srv_tool', rest: '{"a":1}' }), '@ 与 JSON 参数应解析')
  assert(parseManualCall('普通对话文本') === null, '普通文本不是手动调用')
  assert(parseManualCall('/') === null, '只有 / 不是手动调用')
  assert(parseManualCall('/   ') === null, '只有空白不是手动调用')
})

await test('findManualTool:精确/模糊唯一/多命中/未找到', () => {
  const tools: AgentTool[] = [
    { name: 'skill_trump-perspective', description: '', parameters: { type: 'object', properties: {} }, execute: async () => '' },
    { name: 'skill_note-taking', description: '', parameters: { type: 'object', properties: {} }, execute: async () => '' },
    { name: 'mcp_fs_read_file', description: '', parameters: { type: 'object', properties: {} }, execute: async () => '' },
    { name: 'mcp_fs_write_file', description: '', parameters: { type: 'object', properties: {} }, execute: async () => '' },
  ]
  assert(findManualTool(tools, 'skill_trump-perspective').tool?.name === 'skill_trump-perspective', '精确匹配')
  assert(findManualTool(tools, 'trump').tool?.name === 'skill_trump-perspective', '模糊唯一命中')
  assert(findManualTool(tools, 'fs').tool === null, 'fs 匹配多个应返回 null')
  assert(findManualTool(tools, 'fs').hint.includes('匹配到 2 个'), '多命中应给提示')
  assert(findManualTool(tools, 'ghost').tool === null && findManualTool(tools, 'ghost').hint.includes('未找到'), '未找到应给提示')
})

await test('matchManualToolPrefix:技能名与描述无空格分离', () => {
  const tools: AgentTool[] = [
    { name: 'skill_zhangxuefeng-perspective', description: '', parameters: { type: 'object', properties: {} }, execute: async () => '' },
    { name: 'skill_trump-perspective', description: '', parameters: { type: 'object', properties: {} }, execute: async () => '' },
  ]
  // 精确匹配走 findManualTool,不进前缀逻辑(前缀只处理"名字含描述"的形态)
  const hit = matchManualToolPrefix(tools, 'skill_zhangxuefeng-perspective帮我调用')
  assert(hit?.tool.name === 'skill_zhangxuefeng-perspective', `应命中技能,实际:${hit?.tool?.name}`)
  assert(hit?.rest === '帮我调用', `剩余文本应为描述,实际:${hit?.rest}`)
  // 带空格也兼容(rest 合并时去重)
  const hit2 = matchManualToolPrefix(tools, 'skill_trump-perspective 用懂王视角')
  assert(hit2?.tool.name === 'skill_trump-perspective' && hit2?.rest === '用懂王视角', '带空格前缀也应分离')
  // 非前缀/无匹配返回 null
  assert(matchManualToolPrefix(tools, 'some_random_text') === null, '无匹配返回 null')
  // 前缀重叠取最长
  const long = matchManualToolPrefix(tools, 'skill_zhangxuefeng-perspective')
  assert(long?.tool.name === 'skill_zhangxuefeng-perspective' && long?.rest === '', '完整技能名 + 空描述')
})

// ---------------------------------------------------------------------------
// 7. 自我进化(版本化快照 / 回滚防降级)
// ---------------------------------------------------------------------------

console.log('\n=== 自我进化(evolution.ts) ===')

function makeEvolutionDeps() {
  // 进化测试的 memory.json 必须与 memory-state.json / memory-snapshots 同目录
  const store = createMemoryStore(() => path.join(memoryDir, 'memory.json'))
  const config = { ...MOCK_PROVIDERS, apiKey: '', baseURL: '', model: '', systemPrompt: '提示词', reasoningEffort: 'high', mcpServers: [], skillsDirs: [] }
  const events: Array<{ type: string }> = []
  const evo = createEvolution({
    getConfig: () => config,
    getStore: () => store,
    getMemoryDir: () => memoryDir,
    onEvent: (e) => events.push({ type: e.type }),
  })
  return { store, evo, events }
}

await test('mapSeqToEntry:序号映射最新列表;越界/非法返回 null', () => {
  // 2026-08-10 回归:评审输出的 delete/update id 是 1 基序号,原 delete
  // 分支把序号当 key 传 store.remove(按内容 includes 匹配)删不中——
  // "评审发现重复却没合并"的直接根因
  const entries = [
    { id: 'a', type: 'preference' as const, content: '条目1', source: 'manual' as const, createdAt: 1, updatedAt: 1 },
    { id: 'b', type: 'fact' as const, content: '条目2', source: 'manual' as const, createdAt: 1, updatedAt: 1 },
  ]
  assert(mapSeqToEntry(entries, '1')?.id === 'a', '序号 1 → 首条')
  assert(mapSeqToEntry(entries, '2')?.id === 'b', '序号 2 → 次条')
  assert(mapSeqToEntry(entries, '3') === null, '越界返回 null')
  assert(mapSeqToEntry(entries, '0') === null, '0 越界返回 null')
  assert(mapSeqToEntry(entries, '-1') === null, '负数返回 null')
  assert(mapSeqToEntry(entries, 'abc') === null, '非法返回 null')
  assert(mapSeqToEntry(entries, undefined) === null, '缺省返回 null')
})

await test('isCleanupChange:delete 与 merge 整合 = 清理类(豁免假说);add/普通 update 不是', () => {
  // 2026-08-11 垂直细分整合:合并 update 与 delete 同例豁免 hypothesis
  assert(isCleanupChange({ op: 'delete', id: '1' }), 'delete 是清理类')
  assert(isCleanupChange({ op: 'update', id: '1', content: '整合', merge: true }), 'merge 整合是清理类')
  assert(!isCleanupChange({ op: 'update', id: '1', content: '改' }), '普通 update 不是清理类')
  assert(!isCleanupChange({ op: 'add', content: 'x' }), 'add 不是清理类')
})

await test('可扩展性预算:轮数/输出/超时按记忆规模自适应(40+ 条目崩溃修复)', () => {
  // 2026-08-14 用户实测"条目超过 40 个进化基本就崩了":评审输出缺省
  // 4096 token 被截断 + 固定 60s 超时 + 一轮清不完 → 三个预算自适应
  // 轮数:下限 = 请求轮数,约每 15 条一轮,上限 6
  assert(resolveRoundBudget(2, 10) === 2, '小记忆集保持请求轮数')
  assert(resolveRoundBudget(2, 45) === 3, '45 条 → 3 轮')
  assert(resolveRoundBudget(2, 90) === 6, '90 条 → 封顶 6 轮')
  assert(resolveRoundBudget(1, 900) === 6, '极端规模仍封顶 6')
  assert(resolveRoundBudget(5, 3) === 5, '请求轮数高于自动值时取请求值')
  assert(resolveRoundBudget(0, 3) === 2, '非法请求轮数回落默认 2')
  // 输出预算:下限 6144(高于缺省 4096),随输入放大,上限 16384
  assert(evalOutputBudget(500) === 6144, '小输入取下限 6144')
  assert(evalOutputBudget(9000) === 9000, '中等输入 ≈ 字符数')
  assert(evalOutputBudget(50000) === 16384, '大输入封顶 16384')
  assert(evalOutputBudget(-5) === 6144, '负输入不越界')
  // 超时:基础 60s + 每条 2s,上限 180s
  assert(evalTimeoutMs(10) === 80_000, '10 条 → 80s')
  assert(evalTimeoutMs(45) === 150_000, '45 条 → 150s')
  assert(evalTimeoutMs(200) === 180_000, '超大集封顶 180s')
})

await test('applyChanges:merge 整合 + delete 无假说也执行(垂直细分合并端到端)', async () => {
  // 2026-08-11 修复"明明很多冗余记忆却没整合":三条 TTG/小胖重复 →
  // 评审输出 1 条 merge update(整合内容,无 hypothesis)+ 2 条 delete
  // (无 hypothesis)→ 全部执行,最终只剩一条整合条目
  const store = createMemoryStore(() => path.join(memoryDir, 'memory.json'))
  await store.replaceAll([]) // 隔离:测试共用同一 memory.json,清空残留
  await store.add({ content: '用户关注KPL/TTG战队小胖,下载视频要1080P', type: 'preference', source: 'manual' })
  await store.add({ content: '用户关注TTG战队,收藏夹视频太多', type: 'preference', source: 'manual' })
  await store.add({ content: '用户常看KPL,T雨后小胖是选手', type: 'preference', source: 'manual' })
  const before = await store.list()
  assert(before.length === 3, '预置 3 条重复')
  const n = await applyChanges(
    [
      // 保留第 1 条并整合(merge:true,无假说)
      { op: 'update', id: '1', content: '用户关注KPL/TTG战队及选手小胖(太强野王),下载其比赛/收藏夹视频默认1080P', type: 'preference', merge: true },
      // 其余两条重复 delete(无假说)
      { op: 'delete', id: '2' },
      { op: 'delete', id: '3' },
    ],
    store,
  )
  assert(n === 3, `应应用 3 条(1 整合 + 2 删除),实际 ${n}`)
  const after = await store.list()
  assert(after.length === 1, `合并后应只剩 1 条,实际 ${after.length}`)
  assert(after[0].content.includes('1080P') && after[0].content.includes('小胖'), '整合内容应保留全部要点')
})

await test('applyChanges:普通 update 无假说跳过(假说驱动不放松)', async () => {
  // 合并豁免只针对 merge:true;普通 update 仍强制假说(防无意义措辞改写)
  const store = createMemoryStore(() => path.join(memoryDir, 'memory.json'))
  await store.replaceAll([]) // 隔离:测试共用同一 memory.json,清空残留
  await store.add({ content: '原始内容', type: 'fact', source: 'manual' })
  const n = await applyChanges([{ op: 'update', id: '1', content: '改写内容' }], store)
  assert(n === 0, '普通 update 无假说应跳过')
  const list = await store.list()
  assert(list.length === 1 && list[0].content === '原始内容', '内容不应被改写')
})

await test('applyChanges:带假说的普通 update 与 add 照常执行(回归)', async () => {
  const store = createMemoryStore(() => path.join(memoryDir, 'memory.json'))
  await store.replaceAll([]) // 隔离:测试共用同一 memory.json,清空残留
  await store.add({ content: '旧内容', type: 'fact', source: 'manual' })
  const n = await applyChanges(
    [
      { op: 'update', id: '1', content: '新内容', hypothesis: '更精确' },
      { op: 'add', content: '新增维度', type: 'workflow', hypothesis: '补全缺失' },
    ],
    store,
  )
  assert(n === 2, `应应用 2 条,实际 ${n}`)
  const list = await store.list()
  assert(list.length === 2, '更新 + 新增后共 2 条')
})

await test('无 API Key:进化后台启动 → 优雅失败(通知)', async () => {
  (globalThis as any).__notifications = []
  const { evo, events } = makeEvolutionDeps()
  const res = await evo.requestEvolve()
  assert(res.started === true, '应返回已启动')
  await waitFor(
    () => ((globalThis as any).__notifications as Array<{ title?: string }>).some((n) => (n.title ?? '').includes('失败')),
    15000,
    '进化失败通知',
  )
  await waitFor(() => events.some((e) => e.type === 'evolution-done'), 15000, 'evolution-done 事件')
  assert(!(await evo.getStatus()).includes('最近一轮'), '无成功结果时状态不含最近一轮')
})

await test('快照加载 + rollback 到已接受版本(防降级)', async () => {
  // 预置:当前版本 v2,快照 v1/v2
  const snapshotsDir = path.join(memoryDir, 'memory-snapshots')
  await fs.mkdir(snapshotsDir, { recursive: true })
  await fs.writeFile(
    path.join(snapshotsDir, 'v1.json'),
    JSON.stringify({ version: 1, entries: [{ id: 'e1', type: 'fact', content: 'v1 内容', createdAt: 1, updatedAt: 1 }] }),
  )
  await fs.writeFile(
    path.join(snapshotsDir, 'v2.json'),
    JSON.stringify({ version: 2, entries: [{ id: 'e2', type: 'fact', content: 'v2 内容', createdAt: 2, updatedAt: 2 }] }),
  )
  await fs.writeFile(
    path.join(memoryDir, 'memory-state.json'),
    JSON.stringify({ version: 2, score: 80, updatedAt: Date.now() }),
  )
  const { store, evo } = makeEvolutionDeps()
  await waitFor(async () => (await store.list()).length >= 0, 2000, 'store 加载')
  const rollbackMsg = await evo.rollback()
  assert(rollbackMsg.includes('v1'), `应回滚到 v1,实际:${rollbackMsg}`)
  const list = await store.list()
  assert(list.length === 1 && list[0].content === 'v1 内容', '回滚后记忆应为 v1 内容')
  const state = (await readJson(path.join(memoryDir, 'memory-state.json'))) as { version: number }
  assert(state.version === 1, `state 版本应回退到 1,实际 ${state.version}`)
})

await test('防降级:初始版本无可回滚', async () => {
  await fs.writeFile(path.join(memoryDir, 'memory-state.json'), JSON.stringify({ version: 1, score: null, updatedAt: 0 }))
  const { evo } = makeEvolutionDeps()
  const msg = await evo.rollback()
  assert(msg.includes('无可回滚'), `初始版本应提示无可回滚,实际:${msg}`)
})

await test('快照损坏 → 回滚失败提示', async () => {
  await fs.writeFile(path.join(memoryDir, 'memory-state.json'), JSON.stringify({ version: 2, score: 80, updatedAt: 0 }))
  await fs.writeFile(path.join(memoryDir, 'memory-snapshots', 'v1.json'), 'not-json{{{')
  const { evo } = makeEvolutionDeps()
  const msg = await evo.rollback()
  assert(msg.includes('回滚失败'), `损坏快照应提示失败,实际:${msg}`)
})

await test('resetAll:清除全部版本回到初始状态', async () => {
  // 预置:state v3 + 快照 v1/v2/v3 + 日志
  const snapshotsDir = path.join(memoryDir, 'memory-snapshots')
  await fs.mkdir(snapshotsDir, { recursive: true })
  for (const v of [1, 2, 3]) {
    await fs.writeFile(
      path.join(snapshotsDir, `v${v}.json`),
      JSON.stringify({ version: v, entries: [{ id: `e${v}`, type: 'fact', content: `v${v}`, createdAt: v, updatedAt: v }] }),
    )
  }
  await fs.writeFile(path.join(memoryDir, 'memory-state.json'), JSON.stringify({ version: 3, score: 85, updatedAt: 1 }))
  await fs.writeFile(
    path.join(memoryDir, 'evolution.json'),
    JSON.stringify({ logs: [{ at: 1, version: 3, before: 70, after: 85, applied: true, summary: 'v2→v3', changes: 1 }] }),
  )
  const { evo } = makeEvolutionDeps()
  await waitFor(async () => (await evo.getLog()).length === 1, 2000, '日志加载')
  const msg = await evo.resetAll()
  assert(msg.includes('清除全部版本'), `resetAll 结果:${msg}`)
  // 日志/状态/快照全部清除
  assert((await evo.getLog()).length === 0, '日志应清空')
  assert(!(await evo.getStatus()).includes('最近一轮'), '状态应重置')
  // 快照目录删除;state 文件重置为 v1(初始状态持久化,与首次使用一致)
  let snapGone = false
  try {
    await fs.access(snapshotsDir)
  } catch {
    snapGone = true
  }
  assert(snapGone, '快照目录应删除')
  const stateAfter = (await readJson(path.join(memoryDir, 'memory-state.json'))) as { version: number }
  assert(stateAfter.version === 1, `state 应重置为 v1,实际 ${stateAfter.version}`)
  // 回到 v1 后 rollback 应无可回滚
  const rb = await evo.rollback()
  assert(rb.includes('无可回滚'), '重置后应无可回滚')
})

await test('getLog 从磁盘加载', async () => {
  await fs.writeFile(
    path.join(memoryDir, 'evolution.json'),
    JSON.stringify({
      logs: [
        { at: 1, version: 3, before: 70, after: 82, applied: true, summary: 'v2→v3 评分 70 → 82', changes: 2 },
      ],
    }),
  )
  const { evo } = makeEvolutionDeps()
  await waitFor(async () => (await evo.getLog()).length === 1, 2000, '日志加载')
  const log = await evo.getLog()
  assert(log[0].version === 3 && log[0].applied === true, '日志应从磁盘加载')
})

// ---------------------------------------------------------------------------
// 7.4 受保护条目(2026-08-13,用户实测"自我进化总是丢失岛灵设定")
// ---------------------------------------------------------------------------

console.log('\n=== 受保护条目(人设/岛灵设定防丢失) ===')

await test('masterIdentityLine:窗口直发 = 主人,外部 QQ 消息不继承主人权限(2026-08-17 配置化)', () => {
  // 主人身份逐条按标记判定(2026-08-13 二轮收紧,用户澄清"不要把
  // 外部传入的消息也当成主人权限"):① 带 QQ 来源标注 = 外部消息,只有
  // 配置的主人 QQ 是主人;② 无来源标注的窗口直发 = 主人最高权限;
  // ③ 系统通知 = 系统事件。主人 QQ 来自 privacy.json(2026-08-17 配置化)
  const LINE = masterIdentityLine(MASTER_QQ)
  assert(LINE.includes(`QQ ${MASTER_QQ}`), '身份说明应含主人 QQ 号(来自隐私配置)')
  assert(LINE.includes('逐条消息'), '应按逐条消息判定身份')
  assert(LINE.includes('外部消息'), '带来源标注的 QQ 消息应声明为外部消息')
  assert(LINE.includes('不具主人权限'), '外部 QQ 消息不得继承主人权限')
  assert(LINE.includes('没有来源标注的用户消息') && LINE.includes('最高权限'), '无来源标注的窗口直发 = 主人最高权限')
  assert(LINE.includes('「先问主人」'), '窗口消息不应触发先问主人')
  assert(LINE.includes('【系统通知】'), '系统通知类消息应单独定性')
  assert(masterIdentityLine('').includes('未配置'), 'masterQQ 为空应降级为「未配置」')
})

await test('isProtectedEntry:protected 标记 / 人设标签 / 人设内容 / 普通条目', () => {
  assert(isProtectedEntry({ protected: true, content: '随便' }), 'protected 标记应受保护')
  assert(isProtectedEntry({ content: 'x', tags: ['人设'] }), '人设标签应受保护')
  assert(isProtectedEntry({ content: 'x', tags: ['人格'] }), '人格标签应受保护')
  assert(isProtectedEntry({ content: '用户为岛灵设定角色形象:鲸鱼娘', tags: [] }), '角色形象内容应受保护')
  assert(isProtectedEntry({ content: '主人指定人设:毒舌雌小鬼' }), '人设关键词内容应受保护')
  assert(isProtectedEntry({ content: '人设(主人指定):鲸鱼娘' }), '句首人设应受保护')
  assert(isProtectedEntry({ content: '群聊人设:鲸鱼娘高冷话少' }), '人设后跟冒号应受保护')
  assert(!isProtectedEntry({ content: '用户喜欢简洁回答', tags: ['偏好'] }), '普通条目不应受保护')
  assert(!isProtectedEntry({ content: '群成员特征:爱玩梗' }), '无关键词普通内容不应受保护')
  assert(!isProtectedEntry({ content: '群聊人设之外的普通条目' }), '字面含人设但无语境不应误判')
  // 显式解锁是权威:标签/内容命中也被覆盖
  assert(!isProtectedEntry({ protected: false, content: '主人指定人设:猫娘', tags: ['人设'] }), '显式解锁应覆盖标签/内容判定')
  assert(PERSONA_TAGS.includes('人设') && PERSONA_TAGS.includes('人格'), '人设类标签表应含人设/人格')
})

await test('store.add:人设条目自动锁定;显式 protected 覆盖;普通条目不锁', async () => {
  const store = createMemoryStore(() => memoryFile(11))
  const p1 = await store.add({ content: '人设:鲸鱼娘,高冷话少', type: 'preference', tags: ['人设'] })
  assert(p1.entry.protected === true, '人设标签条目应自动锁定')
  const p2 = await store.add({ content: '用户为岛灵设定角色形象:毒舌雌小鬼', type: 'fact' })
  assert(p2.entry.protected === true, '人设关键词内容应自动锁定(无标签)')
  const p3 = await store.add({ content: '主人指定人设:猫娘', type: 'fact', protected: false })
  assert(p3.entry.protected === false, '显式 protected:false 应豁免自动锁定')
  const n1 = await store.add({ content: '用户喜欢简洁回答', type: 'preference' })
  assert(n1.entry.protected !== true, '普通条目不应锁定')
  // update 可切换锁定状态
  const u = await store.update(n1.entry.id, { protected: true })
  assert(u?.protected === true, 'update 应可锁定')
  const u2 = await store.update(n1.entry.id, { protected: false })
  assert(u2?.protected === false, 'update 应可解锁')
})

await test('加载迁移:旧数据人设条目(无 protected)自动补锁并落盘', async () => {
  // 旧版 memory.json 的人设条目只有标签/关键词,无 protected 字段——
  // 加载时自动补锁(2026-08-13 迁移),此后 protected 是权威来源
  await fs.writeFile(
    memoryFile(12),
    JSON.stringify({
      entries: [
        { id: 'old-1', type: 'preference', content: '主人指定人设:鲸鱼娘', tags: ['人设'], createdAt: 1, updatedAt: 1 },
        { id: 'old-2', type: 'fact', content: '普通旧条目', createdAt: 2, updatedAt: 2 },
      ],
    }),
  )
  const store = createMemoryStore(() => memoryFile(12))
  const list = await store.list()
  const persona = list.find((e) => e.id === 'old-1')!
  const normal = list.find((e) => e.id === 'old-2')!
  assert(persona.protected === true, '旧人设条目应自动补锁')
  assert(normal.protected !== true, '旧普通条目不应补锁')
  // 迁移结果应落盘(轮询等待串行写队列)
  await waitFor(async () => {
    try {
      const onDisk = (await readJson(memoryFile(12))) as { entries: MemoryEntry[] }
      return onDisk.entries.some((e) => e.id === 'old-1' && e.protected === true)
    } catch {
      return false
    }
  }, 5000, '迁移补锁落盘')
})

await test('applyChanges:delete/update/merge 目标为受保护条目全部跳过(硬拦截)', async () => {
  // 2026-08-13 用户实测:清理类轮次免复评直接接受,评审把人设重写成
  // "整体切换为鲸鱼娘模式"——代码层必须拦截,LLM 无视提示词也不生效。
  // 显式时间戳定序:list 按 updatedAt 倒序 → 人设 = 序号 1
  const store = createMemoryStore(() => memoryFile(13))
  await store.replaceAll([
    { id: 'p', type: 'preference' as const, content: '主人指定人设:海澜之家=毒舌雌小鬼,异象局=鲸鱼娘', tags: ['人设'], protected: true, createdAt: 1, updatedAt: 3 },
    { id: 'g1', type: 'fact' as const, content: '海澜之家群成员:李天宇等', createdAt: 1, updatedAt: 2 },
    { id: 'g2', type: 'fact' as const, content: '异象局群成员特征:鹤翔叔叔爱整活', createdAt: 1, updatedAt: 1 },
  ])
  const before = await store.list()
  assert(before.length === 3 && before[0].id === 'p' && before[0].protected === true, '预置:序号 1 = 受保护人设')
  const n = await applyChanges(
    [
      // 评审改写人设(merge:true,免假说——最危险的清理路径)
      { op: 'update', id: '1', content: '人设(评审擅自改写):整体切换为鲸鱼娘模式,毒舌作废', merge: true },
      // 评审删除人设
      { op: 'delete', id: '1' },
      // 评审把成员条目合并进人设条目(update 目标 = 人设)
      { op: 'update', id: '1', content: '人设+成员大杂烩', merge: true },
      // 正常清理:删除成员条目(序号 2)
      { op: 'delete', id: '2' },
    ],
    store,
  )
  assert(n === 1, `应只应用 1 条(人设相关的 3 条全部硬跳过),实际 ${n}`)
  const after = await store.list()
  assert(after.length === 2, `人设不可删、成员删 1 → 剩 2 条,实际 ${after.length}`)
  const persona = after.find((e) => e.id === 'p')!
  assert(persona.content.includes('毒舌雌小鬼'), `人设内容应原样保留,实际:${persona.content}`)
})

await test('applyChanges:内容片段回退删除跳过受保护条目,普通条目照删', async () => {
  // 兼容路径:评审不传序号直接传内容片段——原实现 store.remove(fragment)
  // 会把包含片段的受保护条目一起删掉;现改为逐条按 id 删并过滤受保护
  const store = createMemoryStore(() => memoryFile(14))
  await store.replaceAll([
    { id: 'p', type: 'preference' as const, content: '群聊人设:鲸鱼娘高冷话少', tags: ['人设'], protected: true, createdAt: 1, updatedAt: 2 },
    { id: 'n', type: 'fact' as const, content: '群聊人设之外的普通条目', createdAt: 1, updatedAt: 1 },
  ])
  const n = await applyChanges([{ op: 'delete', content: '群聊人设' }], store)
  assert(n === 1, `片段命中的受保护条目应跳过、只删普通条目,实际 ${n}`)
  const after = await store.list()
  assert(after.length === 1 && after[0].id === 'p' && after[0].protected === true, '受保护人设应原样保留')
})

await test('formatMemoryBlock:锁定条目带·锁定标记', () => {
  const entries: MemoryEntry[] = [
    { id: '1', type: 'preference', content: '主人指定人设:鲸鱼娘', protected: true, createdAt: 1, updatedAt: 1 },
    { id: '2', type: 'fact', content: '普通条目', createdAt: 2, updatedAt: 2 },
  ]
  const block = formatMemoryBlock(entries)
  assert(block.includes('[偏好·锁定] 主人指定人设'), `锁定条目应有标记,实际:${block}`)
  assert(block.includes('[事实] 普通条目') && !block.includes('[事实·锁定]'), '普通条目不应有标记')
})

await test('记忆工具:remember 人设自动锁定 / forget 拒删锁定 / update_memory 解锁后可删', async () => {
  const store = createMemoryStore(() => memoryFile(15))
  await store.replaceAll([]) // 隔离:测试共用同一 memory.json,清空残留
  const tools = createMemoryTools(() => store)
  const remember = tools.find((t) => t.name === 'remember')!
  const forget = tools.find((t) => t.name === 'forget')!
  const updateMemory = tools.find((t) => t.name === 'update_memory')!
  // remember 带人设标签 → 自动锁定
  const out = String(await remember.execute({ content: '主人指定人设:毒舌雌小鬼', type: 'preference', tags: ['人设'] }))
  assert(out.includes('已锁定'), `remember 应提示已锁定,实际:${out}`)
  const entry = (await store.list()).find((e) => e.content.includes('毒舌雌小鬼'))!
  assert(entry.protected === true, 'remember 的人设条目应已锁定')
  // forget 直接删 → 拒绝
  let refused = false
  try {
    await forget.execute({ key: '毒舌雌小鬼' })
  } catch (err) {
    refused = String(err).includes('锁定') || String(err).includes('受保护')
  }
  assert(refused, 'forget 删除锁定条目应拒绝并提示解锁')
  assert((await store.list()).length === 1, '拒绝后条目应保留')
  // update_memory 解锁 → forget 成功
  const u = await updateMemory.execute({ id: entry.id, protected: false })
  assert(String(u).includes('已更新'), '解锁 update 应成功')
  const n = await forget.execute({ key: '毒舌雌小鬼' })
  assert(String(n).includes('已删除 1 条'), '解锁后 forget 应成功')
  assert((await store.list()).length === 0, '解锁删除后应清空')
})

// ---------------------------------------------------------------------------
// 7.5 总结输入压缩(compressArgs)
// ---------------------------------------------------------------------------

console.log('\n=== 总结输入压缩(compressArgs) ===')

await test('compressArgs:字符串截断/嵌套/数组/深度', () => {
  // 长字符串截断 200 字
  const long = compressArgs({ content: 'x'.repeat(500) }) as { content: string }
  assert(long.content.length <= 203, `长字符串应截断,实际长度 ${long.content.length}`)
  assert(long.content.includes('…'), '截断应带省略号')
  // 短字符串不动
  assert((compressArgs({ a: '短' }) as { a: string }).a === '短', '短字符串原样')
  // 嵌套对象与数组
  const nested = compressArgs({ a: { b: ['v'.repeat(300), 'ok'] } }) as { a: { b: string[] } }
  assert(nested.a.b[0].length <= 203, '嵌套数组内长字符串应截断')
  assert(nested.a.b[1] === 'ok', '短元素原样')
  // 深度超限 → 占位
  const deep = compressArgs({ a: { b: { c: { d: { e: { f: 'deep' } } } } } }) as Record<string, unknown>
  assert((deep as any).a.b.c.d.e === '(参数已截断)', '深度超 4 层应占位')
  // 非字符串/非对象原样
  assert(compressArgs(42) === 42, '数字原样')
  assert(compressArgs(null) === null, 'null 原样')
  // 数组截断 20 项
  const arr = compressArgs(Array.from({ length: 30 }, (_, i) => `v${i}`)) as string[]
  assert(arr.length === 20, `数组应截断到 20 项,实际 ${arr.length}`)
})

// ---------------------------------------------------------------------------
// 7.6 总结标题 JSON 解析(parseTitleJson)
// ---------------------------------------------------------------------------

console.log('\n=== 总结标题 JSON 解析(parseTitleJson) ===')

await test('parseTitleJson:标准 JSON / 代码块 / 前缀文本 / 非法', () => {
  // 标准 JSON
  assert(parseTitleJson('{"title": "下载视频"}') === '下载视频', '标准 JSON 应取 title')
  // markdown 代码块包裹(实测模型输出)
  assert(parseTitleJson('```json\n{"title": "代码块标题"}\n```') === '代码块标题', '代码块包裹应解析')
  assert(parseTitleJson('```\n{"title": "裸代码块"}\n```') === '裸代码块', '无 json 标注的代码块应解析')
  // 前导说明文本 + JSON(实测模型不守规矩)
  assert(parseTitleJson('好的,标题如下:{"title": "前缀标题"}') === '前缀标题', '前缀文本应解析')
  // 空 / 非法 JSON → 回退整串(交给 sanitizeTitle)
  assert(parseTitleJson('') === '', '空串返回空')
  assert(parseTitleJson('不是JSON文本') === '不是JSON文本', '非法 JSON 回退原文')
  // title 缺失 / 非字符串 → 回退原文
  assert(parseTitleJson('{"other": 1}') === '{"other": 1}', '无 title 字段回退原文')
  assert(parseTitleJson('{"title": 123}') === '{"title": 123}', 'title 非字符串回退原文')
  // 带尾随内容
  assert(parseTitleJson('{"title": "尾随"}后面还有') === '尾随', '尾随内容应解析')
})

await test('extractJsonTitle:严格解析,垃圾输出拒绝(回归 "[\'data\']")', () => {
  // 合法 JSON 正常取 title
  assert(extractJsonTitle('{"title": "下载视频"}') === '下载视频', '标准 JSON 应取 title')
  assert(extractJsonTitle('```json\n{"title": "代码块标题"}\n```') === '代码块标题', '代码块包裹应解析')
  assert(extractJsonTitle('好的:{"title": "前缀标题"}') === '前缀标题', '前缀文本应解析')
  // Python 风格单引号 dict(模型在 json 模式常输出;解析失败后单引号
  // 替换为双引号再试)
  assert(extractJsonTitle("{'title': '单引号标题'}") === '单引号标题', 'Python 风格 dict 应解析')
  // 值内含双引号时单引号归一化会破坏 JSON → 拒绝(安全侧)
  assert(extractJsonTitle("{'title': '[\"data\"]'}") === '', '值含双引号的单引号 dict 拒绝')
  // 垃圾输出(实测 bug:标题变成 "['data']")→ 严格模式拒绝返回空
  assert(extractJsonTitle("['data']") === '', 'Python 列表字面量应拒绝')
  assert(extractJsonTitle("['data'];") === '', '带分号的列表字面量应拒绝')
  assert(extractJsonTitle('["data"]') === '', '双引号列表字面量应拒绝')
  assert(extractJsonTitle('不是JSON文本') === '', '非法文本应拒绝(不兜底原文)')
  assert(extractJsonTitle('') === '', '空串返回空')
})

// ---------------------------------------------------------------------------
// 7.7 标题清洗与句子式判定(2026-08-12:用户实测"标题废话太多 + 截断"——
// 模型把回复原句/续写内容当标题,措辞三层 + 清洗/判效兜底)
// ---------------------------------------------------------------------------

console.log('\n=== 标题清洗与句子式判定(sanitizeTitle / looksLikeSentenceTitle) ===')

await test('sanitizeTitle:剥回应词前缀(模型把回复原句当标题)', () => {
  // 注意:原句 22 码元,剥前缀后仍超 20 码元上限 → 截断为 20 码元(断言
  // 期望值按截断后写——"门"在第 22 位被截掉)
  assert(sanitizeTitle('是的,exec_command 默认有执行确认门') === 'exec_command 默认有执行确认', '剥「是的,」')
  assert(sanitizeTitle('好的: 字体导入') === '字体导入', '剥「好的:」')
  assert(sanitizeTitle('有的,可以配置') === '可以配置', '剥「有的,」')
  assert(sanitizeTitle('可以行吧') === '行吧', '剥「可以」后剩余继续处理')
})

await test('sanitizeTitle:逗号截断兜底(摘抄整句不再被 20 码元截断)', () => {
  assert(
    sanitizeTitle('开心的事倒是有,中午食堂的土豆牛肉特别好') === '开心的事倒是有',
    '含逗号的句子取首个逗号前的前半短语',
  )
  assert(sanitizeTitle('公司楼下新开了一家火锅店') === '公司楼下新开了一家火锅店', '无逗号句子原样(交给句子式判定)')
  assert(sanitizeTitle('字体导入') === '字体导入', '正常短语不受影响')
})

await test('sanitizeTitle:终止标点截断(兜底长句不再 20 码元硬截)', () => {
  assert(sanitizeTitle('哈喽主人～看我干啥呀?我刚才一直陪你看视') === '哈喽主人', '终止标点(~)前截断')
  assert(sanitizeTitle('好。下面开始正式内容') === '下面开始正式内容', '回应词剥离后残留的开头标点剥掉')
  assert(sanitizeTitle('深夜B站热门视频盘点') === '深夜B站热门视频盘点', '无终止标点短语不受影响')
})

await test('fallbackTitle:跳过过短消息取实质内容(首条"你?"不再得到单字垃圾)', () => {
  const msgs: AgentMessage[] = [
    { id: 'u1', role: 'user', parts: [{ type: 'text', text: '你?' }] },
    { id: 'u2', role: 'user', parts: [{ type: 'text', text: '你猜呢' }] },
    { id: 'u3', role: 'user', parts: [{ type: 'text', text: '我要听二哥王力宏的需要你陪' }] },
  ]
  assert(fallbackTitle(msgs) === '我要听二哥王力宏的需要你陪', `应跳过过短消息取实质内容,实际:${fallbackTitle(msgs)}`)
  assert(fallbackTitle([{ id: 'u1', role: 'user', parts: [{ type: 'text', text: '你?' }] }]) === '', '全过短返回空')
})

await test('looksLikeSentenceTitle:完成体/句尾的/疑问词 = 句子式(判无效)', () => {
  assert(looksLikeSentenceTitle('公司楼下新开了一家火锅店') === true, '含「了」的叙述句应判句子')
  assert(looksLikeSentenceTitle('开心的事') === false, '短标题不计(≤6 码元)')
  assert(looksLikeSentenceTitle('文言文里有没有轻松好玩的句子') === true, '疑问词「有没有」应判句子')
  assert(looksLikeSentenceTitle('今天天气怎么样才好') === true, '疑问词「怎么样」应判句子')
  assert(looksLikeSentenceTitle('哈喽主人看我干啥呀我刚才一直陪你看视') === true, '口语疑问词「干啥」应判句子')
  assert(looksLikeSentenceTitle('字体导入') === false, '正常短语不是句子')
  assert(looksLikeSentenceTitle('B站下载与热点分析') === false, '并列短语不是句子')
  assert(looksLikeSentenceTitle('深夜加班闲聊') === false, '闲聊场景短语不是句子')
})

await test('looksLikeIncompleteMind:残句/过短判废(16 码元整却半句)', () => {
  assert(looksLikeIncompleteMind('收到,以后给你最精简的干货。你那') === true, '以「你那」收尾的半句应判废')
  assert(looksLikeIncompleteMind('哈哈,') === true, '逗号结尾应判废')
  assert(looksLikeIncompleteMind('心里嘀咕') === false, '4 码元以上完整短语不判废')
  assert(looksLikeIncompleteMind('嘴上说够,心里嘀咕:问倒我算了') === false, '完整揣测句不判废')
  assert(looksLikeIncompleteMind('') === true, '空串判废')
})

await test('cutMindSentence:超长 raw 取第一个句末标点前的完整小句', () => {
  // 实机样本(2026-08-12):模型超长输出 = 完整小句 + 续写
  assert(
    cutMindSentence('好,李文亚教授是吧!刚才那列表里正好看到《李文亚"噫噫……"》那条,我直接给你抓下来播放 🐳') ===
      '好,李文亚教授是吧',
    '取第一个！前的完整小句',
  )
  assert(
    cutMindSentence('主人这是又陷进旋律里了吧～那我不吵你,安静当个胖鲸鱼靠垫') === '主人这是又陷进旋律里了吧',
    '取第一个～前的完整小句',
  )
  assert(cutMindSentence('收到,以后我答嘢快狠准,唔会再长篇大论') === null, '无句末标点(只有逗号)返回 null 判废')
  assert(cutMindSentence('嘴上说够,心里嘀咕:问倒我算了') === null, '正常长度(≤16)不触发截取')
  assert(cutMindSentence('哈哈!') === null, '截取结果过短(<4)判废')
  assert(cutMindSentence('') === null, '空串返回 null')
})

await test('salvageMindClause:无句末标点的逗号串长句取 ≤16 码元最长前缀小句', () => {
  // 实机样本(2026-08-14):粤语人格持续输出逗号串,cutMindSentence 无从截取
  assert(
    salvageMindClause('收到,以后我答嘢快狠准,唔会再长篇大论') === '收到,以后我答嘢快狠准',
    '取 16 码元内最后一个逗号前的完整前缀小句',
  )
  assert(salvageMindClause('哈哈,') === null, '前缀小句过短(<4)返回 null')
  assert(salvageMindClause('心里在偷乐呢') === null, '无逗号返回 null')
  assert(salvageMindClause('就是,后面还有好多话要说') === null, '前缀收在连词上判废')
  assert(salvageMindClause('') === null, '空串返回 null')
})

await test('sanitizeMind:引号/首尾括号/前缀/尾随标点清洗', () => {
  // 实机样本(2026-08-14):开头全角左括号无闭合,原字符类不含括号透传显示
  assert(sanitizeMind('（这下总该明白了吧') === '这下总该明白了吧', '无闭合的开头全角左括号应剥除')
  assert(sanitizeMind('（心里在偷乐）') === '心里在偷乐', '成对全角括号首尾剥除')
  assert(sanitizeMind('「嘴上淡定」') === '嘴上淡定', '引号剥除不回归')
  assert(sanitizeMind('心理揣测:在慌') === '在慌', '前缀剥除')
  assert(sanitizeMind('这下明白了吧。') === '这下明白了吧', '尾随句末标点剥除')
  // 2026-08-18 实机修复:非白名单标签词(心情)带方括号,须整段剥除不留]残片
  assert(sanitizeMind('[心情]嘴上恭喜') === '嘴上恭喜', '带方括号标签(心情)整段剥除')
  assert(sanitizeMind('嘴上恭喜[心情]') === '嘴上恭喜', '尾部标签标注剥除')
  assert(sanitizeMind('喵～我已经瞄到主人了哦[揣测：表情…]') === '喵～我已经瞄到主人了哦', '中段标签标注剥除')
  // 防御:历史持久化的"标签]+"残片(无[ 开头)也兜底剥除
  assert(sanitizeMind('心情]嘴上恭喜') === '嘴上恭喜', '残留"标签]+"残片兜底剥除')
  // 2026-08-18 修复:非白名单标签(推测)带方括号,步骤①未匹配,步骤③剥"["后
  // 步骤③b兜底剥"推测]"(推测/猜测已加入白名单,此测试验证③b通用兜底)
  assert(sanitizeMind('[估计]她可能很高兴') === '她可能很高兴', '非白名单方括号标签(估计)③b兜底剥除')
  assert(sanitizeMind('估计]她可能很高兴') === '她可能很高兴', '无"["的"文字+]"残片③b兜底剥除')
  assert(sanitizeMind('[推测]嘴上说好') === '嘴上说好', '新加白名单标签(推测)步骤①直接剥除')
})

// ---------------------------------------------------------------------------
// 7.5 记忆提取 + 用户风格分析(2026-08-10 新增 Sub Agent 职能)
// ---------------------------------------------------------------------------

console.log('\n=== 记忆提取 + 用户风格分析 ===')

await test('parseMemoriesJson:合法数组逐条校验,垃圾拒绝', () => {
  const ok = parseMemoriesJson('{"memories": [{"content": "用户喜欢简洁回答", "type": "preference"}, {"content": "项目在 D:/work", "type": "fact"}]}')
  assert(ok.length === 2, `应解析 2 条,实际 ${ok.length}`)
  assert(ok[0].content === '用户喜欢简洁回答' && ok[0].type === 'preference', '首条内容/类型正确')
  assert(ok[1].type === 'fact', 'fact 类型正确')
  // 类型非法 → 回退 fact;content 缺失/空 → 丢弃
  const bad = parseMemoriesJson('{"memories": [{"content": "xx", "type": "nonsense"}, {"type": "fact"}, {"content": "  "}]}')
  assert(bad.length === 1 && bad[0].type === 'fact', `非法类型回退 fact、空内容丢弃,实际 ${JSON.stringify(bad)}`)
  // 垃圾输出 → 空数组(安全侧:不污染记忆)
  assert(parseMemoriesJson('不是JSON').length === 0, '非法文本返回空数组')
  assert(parseMemoriesJson('{"other": 1}').length === 0, '无 memories 字段返回空数组')
  assert(parseMemoriesJson('{"memories": "not-array"}').length === 0, 'memories 非数组返回空数组')
  // Python 风格单引号 dict 可解析
  const py = parseMemoriesJson("{'memories': [{'content': '单引号内容', 'type': 'workflow'}]}")
  assert(py.length === 1 && py[0].type === 'workflow', 'Python 风格 dict 应解析')
  // 超过 10 条截断
  const many = parseMemoriesJson(`{"memories": ${JSON.stringify(Array.from({ length: 15 }, (_, i) => ({ content: `记忆${i}`, type: 'fact' })))}}`)
  assert(many.length === 10, `单次最多 10 条,实际 ${many.length}`)
})

await test('parseStyleJson:合法 style 采信,空/垃圾拒绝', () => {
  assert(parseStyleJson('{"style": "喜欢用「嗯嗯」开头,句尾常带~"}') === '喜欢用「嗯嗯」开头,句尾常带~', '标准 JSON 取 style')
  assert(parseStyleJson("{'style': '单引号风格'}") === '单引号风格', 'Python 风格 dict 应解析')
  assert(parseStyleJson('{"style": ""}') === '', '空 style 返回空')
  assert(parseStyleJson('不是JSON') === '', '非法文本返回空')
  assert(parseStyleJson('{"other": 1}') === '', '无 style 字段返回空')
  assert(parseStyleJson('{"style": 123}') === '', 'style 非字符串返回空')
})

await test('buildMemoryExtractSystem / buildUserStyleSystem:拼装含指令,不炸', () => {
  const mem = buildMemoryExtractSystem(['自定义提示词', '记忆块内容'])
  assert(mem.includes('记忆沉淀师') && mem.includes('现有记忆') && mem.includes('记忆块内容'), '记忆提取系统提示应含指令与现有记忆块')
  assert(buildMemoryExtractSystem(['提示词', '']).includes('记忆沉淀师'), '无记忆块不炸')
  const style = buildUserStyleSystem(['自定义提示词'])
  assert(style.includes('风格观察师'), '风格分析系统提示应含指令')
})

await test('extractMemories / analyzeUserStyle:无 Key 优雅失败(零 LLM 调用)', async () => {
  const noKey = { ...MOCK_PROVIDERS, apiKey: '', baseURL: '', model: '', systemPrompt: '', reasoningEffort: 'high' as const, mcpServers: [], skillsDirs: [] }
  const summaryAgent = createSummaryAgent({ getConfig: () => noKey })
  const mindAgent = createMindAgent({ getConfig: () => noKey })
  const history = [{ id: 'u1', role: 'user' as const, parts: [{ type: 'text' as const, text: '你好' }] }]
  assert((await summaryAgent.extractMemories(history)).length === 0, '无 Key 返回空数组')
  assert((await summaryAgent.extractMemories([])).length === 0, '空历史返回空数组')
  assert((await mindAgent.analyzeUserStyle(history)) === '', '无 Key 返回空串')
  assert((await mindAgent.analyzeUserStyle([])) === '', '空历史返回空串')
})

// ---------------------------------------------------------------------------
// 7.5 回复意图判定器(2026-08-16 兜底路由)——双指纹协议依赖主 Agent 服从性,
// 忘带指纹 = 扣留(该发给主人的消息到不了主人)/ 误发(发给别人的话被发到
// 主人 QQ,用户实测两病)。落定路由对指纹缺失/歧义的轮次调用独立意图判定
// Sub Agent(master/other/hold)决定路由——判定器只做单一分类任务,比主
// Agent 边生成边记指纹可靠;失败回退原行为(不引入新的错误路径)
// ---------------------------------------------------------------------------

await test('routeForClassifierIntent:意图判定路由矩阵(2026-08-16)', () => {
  // 执行轮(pending 待回复对象存活):给主人的话发主人 / 发给对方的话发待
  // 回复对象 / hold 扣留——修复"该发给主人的消息因忘带主人指纹没发出去"
  assert(routeForClassifierIntent('exec', 'master') === 'send-master', 'exec+master 应发主人')
  assert(routeForClassifierIntent('exec', 'other') === 'send-pending', 'exec+other 应发待回复对象')
  assert(routeForClassifierIntent('exec', 'hold') === 'hold', 'exec+hold 应扣留')
  // 主人日常轮:给主人的话发主人;发给别人的话没有可发目标(发别人必须用
  // send 工具)→ 扣留防串台——修复"发给别人的消息被发到主人QQ"
  assert(routeForClassifierIntent('master-daily', 'master') === 'send-master', 'daily+master 应发主人')
  assert(routeForClassifierIntent('master-daily', 'other') === 'hold', 'daily+other 应扣留(无发送目标)')
  assert(routeForClassifierIntent('master-daily', 'hold') === 'hold', 'daily+hold 应扣留')
  // 群触发轮:汇报发主人 / 群友话发回群
  assert(routeForClassifierIntent('group', 'master') === 'send-master', 'group+master 应发主人')
  assert(routeForClassifierIntent('group', 'other') === 'send-group', 'group+other 应发回群')
  assert(routeForClassifierIntent('group', 'hold') === 'hold', 'group+hold 应扣留')
  // 扩展信任私聊轮:发给对方的话发回对方 / 汇报发主人
  assert(routeForClassifierIntent('contact', 'master') === 'send-master', 'contact+master 应发主人')
  assert(routeForClassifierIntent('contact', 'other') === 'send-target', 'contact+other 应发回对方')
  assert(routeForClassifierIntent('contact', 'hold') === 'hold', 'contact+hold 应扣留')
  // 面板轮:发给对方的话发回对方 / 给主人的话留在面板(主人正在面板查看)
  assert(routeForClassifierIntent('panel', 'master') === 'hold', 'panel+master 应留面板')
  assert(routeForClassifierIntent('panel', 'other') === 'send-target', 'panel+other 应发回对方')
  assert(routeForClassifierIntent('panel', 'hold') === 'hold', 'panel+hold 应扣留')
})

await test('parseClassifierJson:意图判定解析(2026-08-16)', () => {
  assert(parseClassifierJson('{"intent":"master","reason":"回答主人"}')?.intent === 'master', 'master 采信')
  assert(parseClassifierJson('{"intent":"other"}')?.intent === 'other', 'other 采信(无 reason)')
  assert(parseClassifierJson('{"intent":"hold","reason":"不回复"}')?.intent === 'hold', 'hold 采信')
  assert(parseClassifierJson('{"intent":"master"}')?.reason === undefined, '无 reason 字段不补')
  const r = parseClassifierJson('{"intent":"other","reason":"' + '长'.repeat(100) + '"}')
  assert(r !== null && (r.reason?.length ?? 0) <= 40, 'reason 截断 40 字')
  // 非法/垃圾输出拒绝(调用方回退原行为,安全侧)
  assert(parseClassifierJson('{"intent":"nope"}') === null, '非法意图拒绝')
  assert(parseClassifierJson('{"intent":123}') === null, '非字符串意图拒绝')
  assert(parseClassifierJson('{"intent":"master","reason":123}')?.intent === 'master', 'reason 非字符串可容忍(不采信 reason)')
  assert(parseClassifierJson('不是JSON') === null, '垃圾输出拒绝')
  assert(parseClassifierJson('') === null, '空输出拒绝')
  assert(parseClassifierJson('{"other":1}') === null, '无 intent 字段拒绝')
  assert(parseClassifierJson("{'intent': 'master'}")?.intent === 'master', 'Python 风格单引号 dict 应解析')
})

await test('buildClassifierSystem:判定提示词含回合背景与意图定义(2026-08-16)', () => {
  const sys = buildClassifierSystem('主人日常对话轮', '主人 QQ 10000', '帮我把"周末见"发给张三')
  assert(sys.includes('回复意图判定器'), '系统提示应含判定器身份')
  assert(sys.includes('主人日常对话轮') && sys.includes('主人 QQ 10000'), '应含回合背景(类型/对象)')
  assert(sys.includes('帮我把"周末见"发给张三'), '应含触发消息(判定关键)')
  assert(sys.includes('master') && sys.includes('other') && sys.includes('hold'), '应含三意图定义')
  assert(sys.includes('JSON'), '应含 JSON 字样(json_mode 官方要求)')
})

await test('createReplyClassifier:无 Key/空回复/垃圾输出回退 null,合法 JSON 采信(2026-08-16)', async () => {
  const base = { ...MOCK_PROVIDERS, apiKey: 'test', baseURL: 'http://mock', model: 'm', systemPrompt: '', reasoningEffort: 'high' as const, mcpServers: [], skillsDirs: [] }
  const input = { kindLabel: '群聊触发轮', targetLabel: '群 20000', trigger: '群友问在吗', reply: '在的' }
  // 无 Key:零 LLM 调用返回 null(调用方回退原行为)
  const noKey = createReplyClassifier({ getConfig: () => ({ ...base, apiKey: '' }) })
  assert((await noKey.classify(input)) === null, '无 Key 返回 null')
  // 空 content(json_mode 已知问题)重试后仍 null
  const empty = createReplyClassifier({
    getConfig: () => base,
    stream: async () => ({ text: '', calls: [], usage: null, aborted: false }),
  })
  assert((await empty.classify(input)) === null, '空 content 返回 null')
  // 垃圾输出(非 JSON)返回 null
  const garbage = createReplyClassifier({
    getConfig: () => base,
    stream: async () => ({ text: '我不知道怎么判定', calls: [], usage: null, aborted: false }),
  })
  assert((await garbage.classify(input)) === null, '垃圾输出返回 null')
  // 非法意图值返回 null
  const badIntent = createReplyClassifier({
    getConfig: () => base,
    stream: async () => ({ text: '{"intent":"someone"}', calls: [], usage: null, aborted: false }),
  })
  assert((await badIntent.classify(input)) === null, '非法意图返回 null')
  // 合法 JSON 采信(master/other/hold 各一)
  for (const intent of ['master', 'other', 'hold'] as const) {
    const ok = createReplyClassifier({
      getConfig: () => base,
      stream: async () => ({ text: JSON.stringify({ intent, reason: '测试' }), calls: [], usage: null, aborted: false }),
    })
    const v = await ok.classify(input)
    assert(v !== null && v.intent === intent, `${intent} 采信`)
  }
  // 首次垃圾重试后合法 → 采信(单措辞 + 一次重试)
  let n = 0
  const retry = createReplyClassifier({
    getConfig: () => base,
    stream: async () => {
      n += 1
      return { text: n === 1 ? '空' : '{"intent":"master"}', calls: [], usage: null, aborted: false }
    },
  })
  const v = await retry.classify(input)
  assert(v !== null && v.intent === 'master' && n === 2, '垃圾后重试采信')
  // stream 抛异常 → 重试后仍抛 → null
  let throws = 0
  const failStream = createReplyClassifier({
    getConfig: () => base,
    stream: async () => {
      throws += 1
      throw new Error('网络错误')
    },
  })
  assert((await failStream.classify(input)) === null && throws === 2, 'stream 异常两次后返回 null')
})

// ---------------------------------------------------------------------------
// 8. 引擎集成(listAllTools / testMCP)
// ---------------------------------------------------------------------------

console.log('\n=== 引擎集成(createAgentEngine) ===')

await test('listAllTools 含内置 + MCP + 技能;dispose 无异常', async () => {
  const cfg = {
    ...MOCK_PROVIDERS,
    apiKey: '',
    baseURL: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',
    systemPrompt: '测试',
    reasoningEffort: 'high',
    mcpServers: [{ name: 'mock', type: 'stdio' as const, command: process.execPath, args: [mockStdio], env: { MOCK_PID_FILE: pidFile } }],
    skillsDirs: [skillsDir],
  }
  const engine = createAgentEngine({
    getConfig: () => cfg,
    onEvent: () => {},
    onSwitchToMusic: () => {},
    getMemoryStore: () => null,
    getEvolution: () => null,
  })
  try {
    const builtin = engine.listTools()
    assert(builtin.some((t) => t.name === 'exec_command') && builtin.some((t) => t.name === 'delegate'), '内置工具应存在')
    // 外部工具前缀 mcp_<服务>_ / skill_<slug>(mcp_config/skills_config 自身以
    // mcp_/skill_ 开头,需用双下划线/完整外部形态区分)
    assert(!builtin.some((t) => t.name.startsWith('mcp_mock_') || t.name.startsWith('skill_note')), '内置清单不应含外部工具')
    const all = await engine.listAllTools()
    assert(all.some((t) => t.name === 'mcp_mock_read_file'), 'listAllTools 应含 MCP 工具')
    assert(all.some((t) => t.name.startsWith('skill_')), 'listAllTools 应含技能工具')
    assert(all.some((t) => t.name === 'mcp_config' || t.name === 'skills_config' || t.name === 'evolve_memory' || t.name === 'remember'), '应含自我配置/进化/记忆工具')
    // 连接失败的服务静默跳过,不影响其他工具
    // (死服务配置由 engine 以 cfg 创建;此处仅复列断言存活工具仍在)
    const all2 = await engine.listAllTools()
    assert(all2.some((t) => t.name === 'mcp_mock_read_file'), '存活服务工具仍在')
    assert(!all2.some((t) => t.name.startsWith('mcp_dead_')), '死服务工具应跳过')
  } finally {
    engine.dispose()
  }
})

await test('testMCP:真实 stdio 服务连通', async () => {
  const engine = createAgentEngine({
    getConfig: () => ({ ...MOCK_PROVIDERS, apiKey: '', baseURL: '', model: '', systemPrompt: '', reasoningEffort: 'high', mcpServers: [], skillsDirs: [] }),
    onEvent: () => {},
    onSwitchToMusic: () => {},
  })
  try {
    const r = await engine.testMCP(stdioCfg)
    assert(r.ok === true && r.toolCount === 6, `testMCP 应成功且 6 个工具,实际:${JSON.stringify(r)}`)
    const r2 = await engine.testMCP({ name: 'bad', type: 'stdio', command: 'definitely-not-exists-xyz', args: [] })
    assert(r2.ok === false && (r2.error ?? '').length > 0, `死服务应失败且带错误,实际:${JSON.stringify(r2)}`)
  } finally {
    engine.dispose()
  }
})

// ---------------------------------------------------------------------------
// 8.3 判定器失败回退启发式(2026-08-16 二轮修复"发给别人的消息被发到
// 主人QQ"):主人日常轮判定器不可用(API 失败/超时)时,原实现回退"直发
// 主人"——若回复是"替主人发给别人的话"就串台。looksLikeForwardInstruction
// 命中 + 回复较短 → 扣留提示用 send 工具;未命中 → 按原行为直发主人
// ---------------------------------------------------------------------------

await test('looksLikeForwardInstruction:发送/转达指令识别(2026-08-16 二轮)', () => {
  // 正向:显式发送/转达/回复某人
  assert(looksLikeForwardInstruction('帮我把"周末见"发给张三') === true, '把…发给…应命中')
  assert(looksLikeForwardInstruction('回复一下张三,说我在忙') === true, '回复一下某人应命中')
  assert(looksLikeForwardInstruction('告诉小李我明天到') === true, '告诉某人应命中')
  assert(looksLikeForwardInstruction('跟他说我同意了') === true, '跟他说应命中')
  assert(looksLikeForwardInstruction('替我给魔精转告一声') === true, '替我给…转告应命中')
  assert(looksLikeForwardInstruction('帮他回一句:周末见') === true, '帮他回一句应命中')
  assert(looksLikeForwardInstruction('把这条消息发给他') === true, '把这条消息发给他应命中')
  assert(looksLikeForwardInstruction('转发给群里的老王') === true, '转发给某人应命中')
  // 负向:日常聊天不含发送语义
  assert(looksLikeForwardInstruction('在吗') === false, '日常招呼不命中')
  assert(looksLikeForwardInstruction('今天天气怎么样') === false, '日常提问不命中')
  assert(looksLikeForwardInstruction('好的,我看看') === false, '应答不命中')
  assert(looksLikeForwardInstruction('帮我查一下B站排名') === false, '查询指令不命中(发给对象缺失)')
  assert(looksLikeForwardInstruction('') === false, '空串不命中')
})

// ---------------------------------------------------------------------------
// 8.4 后台任务完成通知会话路由(2026-08-16 修复"bili 下载完成消息没有
// 传递到发起会话(主对话之外)"):任务终态回调(doneHandler)是 tasks.ts
// 模块级单例,多会话引擎并存时被最后装配的引擎接管——事件原先带该
// 引擎的 currentSessionKey = 完成通知串到别的会话。修复:任务注册时
// 记录**发起会话键**(AgentTask.sessionKey),background-done 事件显式
// 携带它,引擎 emit 闭包不再用 currentSessionKey 覆盖显式键
// ---------------------------------------------------------------------------

await test('tasks:任务注册带 sessionKey,终态回调透传(2026-08-16)', () => {
  const captured: AgentTask[] = []
  const orig = getTaskDoneHandler()
  setTaskDoneHandler((t) => captured.push(t))
  const id1 = 't-sess-' + Date.now()
  const id2 = 't-nosess-' + Date.now()
  try {
    registerTask({ id: id1, title: 'B站下载', detail: '测试', sessionKey: 'private:222' })
    updateTask(id1, { status: 'done', detail: '已完成' })
    assert(captured.length === 1 && captured[0].sessionKey === 'private:222', `终态回调应透传 sessionKey,实际 ${JSON.stringify(captured.map((t) => t.sessionKey))}`)
    assert(captured[0].status === 'done' && captured[0].detail === '已完成', '终态载荷应正确')
    // 已终态任务再更新不重复回调
    updateTask(id1, { status: 'failed', detail: 'x' })
    assert(captured.length === 1, '终态任务不应重复回调')
    // 无 sessionKey 的任务 → 不携带(主对话语义)
    registerTask({ id: id2, title: 'B站扫码登录', detail: '等待扫码' })
    updateTask(id2, { status: 'failed', detail: '二维码过期' })
    const totalCb: number = captured.length
    assert(totalCb === 2 && captured[1].sessionKey === undefined, '无 sessionKey 任务不携带')
  } finally {
    setTaskDoneHandler(orig)
    removeTask(id1)
    removeTask(id2)
  }
})

await test('createAgentEngine:任务完成 → background-done 事件带发起会话键(2026-08-16)', async () => {
  const emitted: Array<Record<string, unknown>> = []
  const engine = createAgentEngine({
    getConfig: () => ({ ...MOCK_PROVIDERS, apiKey: '', baseURL: '', model: '', systemPrompt: '', reasoningEffort: 'high', mcpServers: [], skillsDirs: [] }),
    onEvent: (e) => emitted.push(e as unknown as Record<string, unknown>),
    onSwitchToMusic: () => {},
  })
  const t1 = 'bg-e2e-' + Date.now()
  const t2 = 'bg-e2e2-' + Date.now()
  try {
    // 引擎装配时 coreToolsPlugin → createTools 已把任务终态回调接到
    // tasks 注册表;直接驱动注册表 = 验证"工具 → events 服务 → engine
    // emit 闭包 → 宿主"全链路
    registerTask({ id: t1, title: 'B站下载', detail: '测试下载', sessionKey: 'private:222' })
    updateTask(t1, { status: 'done', detail: '已完成' })
    const ev = emitted.find((e) => e.type === 'background-done')
    assert(ev !== undefined, 'background-done 事件应发出')
    assert(ev.sessionKey === 'private:222', `事件应带任务发起会话键(private:222),实际 ${JSON.stringify(ev.sessionKey)}`)
    assert(String(ev.title).includes('B站下载') && String(ev.message).includes('已完成'), `title/message 应来自任务,实际 ${JSON.stringify(ev)}`)
    // 无 sessionKey 的任务 → 事件无显式键,emit 闭包 fallback 到引擎当前
    // 会话键(测试引擎刚创建 = main)——与修复前行为一致(主对话任务
    // 完成通知落在主对话);显式键优先的语义不受影响
    registerTask({ id: t2, title: 'B站扫码登录', detail: '等待扫码' })
    updateTask(t2, { status: 'failed', detail: '二维码过期' })
    const ev2 = emitted.filter((e) => e.type === 'background-done').pop()
    assert(ev2 !== undefined && ev2.sessionKey === 'main', `无键任务事件应 fallback 引擎当前会话键(main),实际 ${JSON.stringify(ev2?.sessionKey)}`)
    // 普通事件(引擎当前会话键注入)不受影响:send 一个回合(apiKey 空,
    // 引擎直接 error 事件),事件应带引擎当前会话键 main
    emitted.length = 0
    engine.send('你好', [], 's1')
    await new Promise((r) => setTimeout(r, 80))
    const st = emitted.find((e) => e.type === 'error')
    assert(st !== undefined && st.sessionKey === 'main', `普通事件应带引擎当前会话键(main),实际 ${JSON.stringify(st)}`)
  } finally {
    engine.dispose()
    removeTask(t1)
    removeTask(t2)
  }
})

// ---------------------------------------------------------------------------
// 8.5 输出预算动态调整(set_output_budget,2026-08-08 用户要求 LLM 自主修改)
// ---------------------------------------------------------------------------

console.log('\n=== 输出预算动态调整(set_output_budget) ===')

/** mock fetch 的 SSE 响应:第一轮返回工具调用(set_output_budget),
 * 后续轮返回纯文本回复。捕获请求体供断言 max_output_tokens */
function budgetSseServer(captured: Array<Record<string, unknown>>, call: Record<string, unknown> | null) {
  let count = 0
  return async (_url: string | URL | Request, opts?: RequestInit) => {
    count++
    try {
      captured.push(JSON.parse(String(opts?.body ?? '{}')) as Record<string, unknown>)
    } catch {
      // 忽略解析失败
    }
    if (call && count === 1) {
      const args = JSON.stringify(call)
      return sseResponse([
        { type: 'response.created', response: { id: `r${count}` } },
        {
          type: 'response.output_item.added',
          output_index: 0,
          item: { type: 'function_call', id: 'item_1', call_id: 'call_1', name: 'set_output_budget', arguments: '' },
        },
        { type: 'response.function_call_arguments.delta', output_index: 0, delta: args.slice(0, 10) },
        { type: 'response.function_call_arguments.delta', output_index: 0, delta: args.slice(10) },
        { type: 'response.function_call_arguments.done', item_id: 'item_1', arguments: args },
        {
          type: 'response.output_item.done',
          output_index: 0,
          item: { type: 'function_call', id: 'item_1', call_id: 'call_1', name: 'set_output_budget', arguments: args },
        },
        { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 5 } } },
      ])
    }
    return sseResponse([
      { type: 'response.created', response: { id: `r${count}` } },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: `item_${count}` } },
      { type: 'response.output_text.delta', output_index: 0, delta: '好的' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: `item_${count}` } },
      { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 5 } } },
    ])
  }
}

/** 构造引擎(可注入 updateAgentConfig) */
function budgetEngine(patched: Array<Record<string, unknown>>, maxOutputTokens?: number) {
  return createAgentEngine({
    getConfig: () => ({
      ...MOCK_PROVIDERS,
      apiKey: 'k',
      baseURL: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
      systemPrompt: '',
      reasoningEffort: 'high',
      maxOutputTokens,
      mcpServers: [],
      skillsDirs: [],
    }),
    onEvent: () => {},
    onSwitchToMusic: () => {},
    updateAgentConfig: (p) => patched.push(p),
    getMemoryStore: () => null,
  })
}

await test('引擎初始预算 = 配置 maxOutputTokens ?? 缺省 8192;越界回退', () => {
  const p: Array<Record<string, unknown>> = []
  const e1 = budgetEngine(p, 65536)
  assert(e1.outputBudget === 65536, `应取配置值 65536,实际 ${e1.outputBudget}`)
  e1.dispose()
  const e2 = budgetEngine(p)
  assert(e2.outputBudget === 8192, `缺省应 8192,实际 ${e2.outputBudget}`)
  e2.dispose()
  const e3 = budgetEngine(p, 999999999)
  assert(e3.outputBudget === 8192, `越界配置应回退缺省,实际 ${e3.outputBudget}`)
  e3.dispose()
})

await test('set_output_budget:action=get 查询不改预算不写配置;schema 正确', async () => {
  const patched: Array<Record<string, unknown>> = []
  const captured: Array<Record<string, unknown>> = []
  const engine = budgetEngine(patched)
  const origFetch = globalThis.fetch
  globalThis.fetch = budgetSseServer(captured, { action: 'get' })
  try {
    const t = engine.listTools().find((x) => x.name === 'set_output_budget')
    assert(t !== undefined, 'set_output_budget 应注册')
    assert((t!.parameters.required ?? []).includes('action'), 'action 应必填')
    const props = t!.parameters.properties as Record<string, { type?: string; enum?: string[] }>
    assert(props.action?.enum?.includes('get') && props.action?.enum?.includes('set'), 'action 应含 get/set')
    assert(props.maxOutputTokens?.type === 'number', 'maxOutputTokens 应为 number')
    assert(props.persist?.type === 'boolean', 'persist 应为 boolean')
    // LLM 调用 action=get:预算不变、不写配置
    engine.send('查看当前输出预算', [])
    await waitFor(() => captured.length >= 1 && !engine.busy, 10000, 'get 回合完成')
    assert(engine.outputBudget === 8192, 'get 不应改变预算')
    assert(patched.length === 0, 'get 不应写配置')
  } finally {
    globalThis.fetch = origFetch
    engine.dispose()
  }
})

await test('LLM 调用 set_output_budget(action=set,persist)→ 预算即时变 + 配置写入 + 后续请求带新预算', async () => {
  const patched: Array<Record<string, unknown>> = []
  const captured: Array<Record<string, unknown>> = []
  const engine = budgetEngine(patched)
  const origFetch = globalThis.fetch
  globalThis.fetch = budgetSseServer(captured, { action: 'set', maxOutputTokens: 65536, persist: true })
  try {
    engine.send('请把输出预算调到 65536 并保存', [])
    await waitFor(() => engine.outputBudget === 65536, 8000, '预算应调整为 65536')
    await waitFor(() => patched.length === 1, 8000, 'persist 应写配置')
    assert(patched[0]?.maxOutputTokens === 65536, `配置应写 65536,实际 ${JSON.stringify(patched[0])}`)
    await waitFor(() => captured.length >= 2, 8000, '应有第二轮请求')
    // 第二轮(工具执行后)请求体应带新预算
    const second = captured[1]
    assert(second?.max_output_tokens === 65536, `第二轮请求应带 65536,实际 ${String(second?.max_output_tokens)}`)
  } finally {
    globalThis.fetch = origFetch
    engine.dispose()
  }
})

await test('set_output_budget:越界钳制到 4096-262144', async () => {
  const patched: Array<Record<string, unknown>> = []
  const captured: Array<Record<string, unknown>> = []
  const engine = budgetEngine(patched)
  const origFetch = globalThis.fetch
  globalThis.fetch = budgetSseServer(captured, { action: 'set', maxOutputTokens: 999999999, persist: true })
  try {
    engine.send('把预算调到最大', [])
    await waitFor(() => engine.outputBudget === 262144, 8000, '应钳制到 262144')
    assert(patched[0]?.maxOutputTokens === 262144, '钳制后 persist 写 262144')
    await waitFor(() => !engine.busy, 10000, '回合结束')
  } finally {
    globalThis.fetch = origFetch
    engine.dispose()
  }
})

await test('预算不足提示:截断(response.incomplete)→ 下一轮请求注入 system 提示', async () => {
  const captured: Array<Record<string, unknown>> = []
  const engine = budgetEngine([])
  const origFetch = globalThis.fetch
  let count = 0
  globalThis.fetch = async (_url: string | URL | Request, opts?: RequestInit) => {
    count++
    try {
      captured.push(JSON.parse(String(opts?.body ?? '{}')) as Record<string, unknown>)
    } catch {
      // 忽略
    }
    if (count === 1) {
      // 第一轮:响应被 max_output_tokens 截断(无工具调用,纯文本被切)
      return sseResponse([
        { type: 'response.created', response: { id: 'r1' } },
        { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'item_1' } },
        { type: 'response.output_text.delta', output_index: 0, delta: '这是被截断的回复前' },
        { type: 'response.incomplete', reason: 'max_output_tokens', response_id: 'r1' },
      ])
    }
    // 第二轮:纯文本回复(引擎应已注入预算不足提示)
    return sseResponse([
      { type: 'response.created', response: { id: 'r2' } },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'item_2' } },
      { type: 'response.output_text.delta', output_index: 0, delta: '已收到提示' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'item_2' } },
      { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 5 } } },
    ])
  }
  try {
    engine.send('写一篇长文章', [])
    await waitFor(() => captured.length >= 2 && !engine.busy, 10000, '两轮完成')
    const second = captured[1]
    const input = (second?.input ?? []) as Array<Record<string, unknown>>
    const hintItem = input.find(
      (it) =>
        it.type === 'message' &&
        (it.role === 'system' || it.role === 'user') &&
        JSON.stringify(it.content).includes('输出预算'),
    )
    assert(hintItem !== undefined, `第二轮 input 应含预算不足提示,实际:${JSON.stringify(input).slice(0, 300)}`)
    assert(JSON.stringify(hintItem).includes('set_output_budget'), '提示应引导调 set_output_budget')
  } finally {
    globalThis.fetch = origFetch
    engine.dispose()
  }
})

// ---------------------------------------------------------------------------
// 9. 灵动岛设置工具(createSettingsTools,mock 渲染端设置桥)
// ---------------------------------------------------------------------------

console.log('\n=== 灵动岛设置工具(createSettingsTools) ===')

await test('设置工具:未注入桥时不注册;注入后 31 个工具齐', () => {
  assert(createSettingsTools({}).length === 0, '无 runIslandSettings 不应注册')
  const tools = createSettingsTools({ runIslandSettings: async () => ({ ok: true }) })
  const names = tools.map((t) => t.name)
  assert(names.length === 31, `应有 31 个工具,实际 ${names.length}:${names.join(',')}`)
  for (const n of [
    'set_theme_color',
    'set_agent_scale',
    'import_font',
    'list_fonts',
    'rename_font',
    'import_background',
    'list_library_images',
    'rename_library_image',
    'set_media_window_size',
    'list_audio_library',
    'import_audio_library',
    'add_audio_to_playlist',
    'remove_background',
    'rename_audio_library',
    'remove_audio_library',
    'list_video_library',
    'import_video_library',
    'rename_video_library',
    'remove_video_library',
    'set_background_crop',
    'set_lyric_provider',
    'set_font_weight',
    'list_playlist',
    'remove_playlist_item',
    'set_audio_config',
  ]) {
    assert(names.includes(n), `应含工具 ${n}`)
  }
})

await test('music_control:action 校验与桥透传,status 格式化', async () => {
  const calls: string[] = []
  const tools = createMusicControlTools(async (op, args) => {
    calls.push(`${op}:${args[0] ?? ''}`)
    if (op === 'status') {
      return { ok: true, external: true, playing: true, title: '晴天', artist: '周杰伦', position: 90, duration: 270 }
    }
    if (op === 'control' && args[0] === 'next') {
      return { ok: true, action: 'next', error: undefined }
    }
    return { ok: true, action: String(args[0]) }
  })
  const tool = tools.find((t) => t.name === 'music_control')!
  assert(tool !== undefined, 'music_control 应注册')
  const status = String(await tool.execute({ action: 'status' }))
  assert(status.includes('晴天') && status.includes('周杰伦') && status.includes('外部平台') && status.includes('播放中') && status.includes('1:30/4:30'), `status 应含曲目与进度,实际:${status}`)
  const pause = String(await tool.execute({ action: 'pause' }))
  assert(calls.includes('control:pause'), 'pause 应调桥 control')
  assert(pause.includes('已暂停'), `pause 应回显,实际:${pause}`)
  const next = String(await tool.execute({ action: 'next' }))
  assert(calls.includes('control:next'), 'next 应调桥 control')
  assert(next.includes('下一首'), `next 应回显,实际:${next}`)
  await assertRejects(() => tool.execute({ action: 'nope' }), 'action 仅支持')
})

await test('set_audio_config:volume 钳制/空参数拒绝/target 透传/playing', async () => {
  const calls: Array<{ op: string; args: unknown[] }> = []
  const tools = createSettingsTools({
    runIslandSettings: async (op, args) => {
      calls.push({ op, args })
      if (op === 'setAudioState') {
        return {
          ok: true,
          name: (args[0] as { name?: string }).name ?? undefined,
          playing: Boolean((args[0] as { playing?: boolean }).playing),
          volume: 60,
          loop: true,
        }
      }
      return { ok: true }
    },
  })
  const tool = tools.find((t) => t.name === 'set_audio_config')!
  // 空参数拒绝
  await assertRejects(() => tool.execute({}), '至少提供一个参数')
  // volume 越界拒绝
  await assertRejects(() => tool.execute({ volume: 1.5 }), 'volume 需要是 0-1')
  await assertRejects(() => tool.execute({ volume: -0.1 }), 'volume 需要是 0-1')
  // target + volume/loop/playing → 桥 setAudioState 透传
  const out = String(
    await tool.execute({ target: '测试歌.mp3', volume: 0.6, loop: true, playing: true }),
  )
  assert(calls.at(-1)?.op === 'setAudioState', '应调桥 setAudioState')
  const arg = calls.at(-1)?.args?.[0] as { name?: string; volume?: number; loop?: boolean; playing?: boolean }
  assert(arg.name === '测试歌.mp3' && arg.volume === 0.6 && arg.loop === true && arg.playing === true, '参数应透传')
  assert(out.includes('测试歌.mp3') && out.includes('60%') && out.includes('循环播放已开启') && out.includes('已播放'), `回复应含设置结果,实际:${out}`)
  // 无 target 只 playing(缺省 = 当前播放中音频)
  const out2 = String(await tool.execute({ playing: false }))
  const arg2 = calls.at(-1)?.args?.[0] as { name?: string } | undefined
  assert(arg2?.name === undefined, '无 target 时 name 应为空(桥取播放中音频)')
  assert(out2.includes('已暂停'), `回复应含已暂停,实际:${out2}`)
})

await test('播放列表:list_playlist 格式化 / remove_playlist_item 校验透传', async () => {
  const calls: Array<{ op: string; args: unknown[] }> = []
  const tools = createSettingsTools({
    runIslandSettings: async (op, args) => {
      calls.push({ op, args })
      if (op === 'listPlaylist') {
        return [
          { key: 'u-1', name: '测试歌.mp3', size: 3 * 1024 * 1024 },
          { key: 'u-2', name: '另一首.mp3', size: 2 * 1024 * 1024 },
        ]
      }
      return { ok: true }
    },
  })
  const list = tools.find((x) => x.name === 'list_playlist')!
  const out = String(await list.execute({}))
  assert(out.includes('测试歌') && out.includes('u-1') && out.includes('3.0MB'), `应格式化列表,实际:${out}`)
  assert(calls[0].op === 'listPlaylist', 'list 走 listPlaylist op')
  const remove = tools.find((x) => x.name === 'remove_playlist_item')!
  const out2 = String(await remove.execute({ key: 'u-1' }))
  assert(out2.includes('已从播放列表删除'), `应回复删除,实际:${out2}`)
  assert(calls[1].op === 'removePlaylistItem' && calls[1].args[0] === 'u-1', 'remove 透传 key')
  await assertRejects(() => remove.execute({}), 'key 不能为空', '空 key 应拒绝')
})

await test('背景取景:set_background_crop 校验与透传', async () => {
  const calls: Array<{ op: string; args: unknown[] }> = []
  const tools = createSettingsTools({
    runIslandSettings: async (op, args) => {
      calls.push({ op, args })
      return {
        ok: true,
        crop: {
          expanded: { zoom: 2, posX: 30, posY: 60 },
          compact: { zoom: 1, posX: 50, posY: 50 },
        },
        previous: {
          expanded: { zoom: 1, posX: 50, posY: 50 },
          compact: { zoom: 1, posX: 50, posY: 50 },
        },
      }
    },
  })
  const t = tools.find((x) => x.name === 'set_background_crop')!
  const out = String(await t.execute({ expanded: { zoom: 2, posX: 30, posY: 60 } }))
  assert(out.includes('展开态'), `应回复展开态,实际:${out}`)
  assert(calls[0].op === 'setBackgroundCrop', `op 应为 setBackgroundCrop,实际:${calls[0]?.op}`)
  const patch = calls[0].args[0] as { expanded?: { zoom?: number } }
  assert(patch.expanded?.zoom === 2, 'zoom 透传')
  await assertRejects(() => t.execute({}), '需要至少提供 expanded 或 compact 之一', '空参数应拒绝')
})

await test('歌词 API:set_lyric_provider 校验与透传', async () => {
  const calls: Array<{ op: string; args: unknown[] }> = []
  const tools = createSettingsTools({
    runIslandSettings: async (op, args) => {
      calls.push({ op, args })
      return { ok: true, id: String((args[0] as { id?: string })?.id), url: undefined, auto: Boolean(args[1]), previous: { id: 'qq', url: undefined, auto: true } }
    },
  })
  const t = tools.find((x) => x.name === 'set_lyric_provider')!
  const out = String(await t.execute({ provider: 'kugou', auto: false }))
  assert(out.includes('酷狗音乐'), `应回复酷狗,实际:${out}`)
  assert(calls[0].op === 'setLyricProvider', `op 应为 setLyricProvider,实际:${calls[0]?.op}`)
  const arg = calls[0].args[0] as { id?: string }
  assert(arg.id === 'kugou' && calls[0].args[1] === false, 'provider 与 auto 透传')
  await assertRejects(() => t.execute({ provider: 'x' }), 'provider 仅支持', '非法厂商应拒绝')
  await assertRejects(() => t.execute({ provider: 'custom' }), '需要 url 模板', 'custom 缺 url 应拒绝')
})

await test('字体粗细:set_font_weight 校验与透传', async () => {
  const calls: Array<{ op: string; args: unknown[] }> = []
  const tools = createSettingsTools({
    runIslandSettings: async (op, args) => {
      calls.push({ op, args })
      return { ok: true, weight: Number(args[0]), previous: 400 }
    },
  })
  const t = tools.find((x) => x.name === 'set_font_weight')!
  const out = String(await t.execute({ weight: 700 }))
  assert(out.includes('700'), `应回复 700,实际:${out}`)
  assert(calls[0].op === 'setFontWeight' && calls[0].args[0] === 700, 'op 与参数透传')
  await assertRejects(() => t.execute({}), 'weight 需要是数字', '缺参应拒绝')
})

await test('播放列表导入:add_audio_to_playlist 校验 ids 并透传', async () => {
  const calls: Array<{ op: string; args: unknown[] }> = []
  const tools = createSettingsTools({
    runIslandSettings: async (op, args) => {
      calls.push({ op, args })
      return { ok: true, count: 1, names: ['测试歌.mp3'] }
    },
  })
  const t = tools.find((x) => x.name === 'add_audio_to_playlist')!
  const out = String(await t.execute({ ids: ['a-1'] }))
  assert(out.includes('加入播放列表'), `应成功,实际:${out}`)
  assert(calls[0].op === 'addAudioLibraryToPlaylist', `op 应为 addAudioLibraryToPlaylist,实际:${calls[0]?.op}`)
  await assertRejects(() => t.execute({}), 'ids 需要至少一个音频条目 id', '空 ids 应拒绝')
  await assertRejects(() => t.execute({ ids: [] }), 'ids 需要至少一个音频条目 id', '空数组应拒绝')
})

await test('移除背景:remove_background 校验 scope 并透传', async () => {
  const calls: Array<{ op: string; args: unknown[] }> = []
  const tools = createSettingsTools({
    runIslandSettings: async (op, args) => {
      calls.push({ op, args })
      return { ok: true, removed: ['expanded', 'compact'] }
    },
  })
  const t = tools.find((x) => x.name === 'remove_background')!
  const out = String(await t.execute({}))
  assert(out.includes('移除'), `应成功,实际:${out}`)
  assert(calls[0].op === 'removeBackground' && calls[0].args[0] === 'both', '缺省 scope 应为 both')
  await t.execute({ scope: 'expanded' })
  assert(calls[1].args[0] === 'expanded', 'scope 透传')
  await assertRejects(() => t.execute({ scope: 'x' }), 'scope 只能是 both/expanded/compact', '非法 scope 应拒绝')
})

await test('多媒体库工具:音频导入(扩展名/大小校验 + data URL 传递)/ 视频导入(路径校验)', async () => {
  const calls: Array<{ op: string; args: unknown[] }> = []
  const tools = createSettingsTools({
    runIslandSettings: async (op, args) => {
      calls.push({ op, args })
      return { ok: true, id: 'x-1', name: String(args[1] ?? '') }
    },
  })
  const tmpAudio = path.join(tmp, 'lib-test.mp3')
  await fs.writeFile(tmpAudio, Buffer.from('fake-mp3-bytes'))
  // 音频导入:data URL 传递
  const ia = tools.find((t) => t.name === 'import_audio_library')!
  const out = String(await ia.execute({ path: tmpAudio }))
  assert(out.includes('导入音频库'), `应成功,实际:${out}`)
  assert(
    typeof calls[0]?.args[0] === 'string' && (calls[0].args[0] as string).startsWith('data:audio/mpeg;base64,'),
    '应传 audio/mpeg data URL',
  )
  // 音频:非法扩展名拒绝
  const bad = path.join(tmp, 'lib-test.xyz')
  await fs.writeFile(bad, 'x')
  await assertRejects(() => ia.execute({ path: bad }), '不支持', '非法扩展名应拒绝')
  // 音频:文件不存在拒绝
  await assertRejects(() => ia.execute({ path: path.join(tmp, 'nope.mp3') }), '不存在', '不存在应拒绝')
  // 视频导入:路径 + 大小传递
  const tmpVideo = path.join(tmp, 'lib-test.mp4')
  await fs.writeFile(tmpVideo, Buffer.from('fake-video'))
  const iv = tools.find((t) => t.name === 'import_video_library')!
  const vout = String(await iv.execute({ path: tmpVideo }))
  assert(vout.includes('导入视频库'), `应成功,实际:${vout}`)
  assert(calls[1]?.op === 'importVideoLibrary' && calls[1]?.args[0] === tmpVideo, '应传路径')
  // 视频:非法扩展名拒绝
  await assertRejects(() => iv.execute({ path: bad }), '不支持', '视频非法扩展名应拒绝')
  // 列表/改名/移除走桥
  const la = tools.find((t) => t.name === 'list_audio_library')!
  assert(String(await la.execute({})).includes('为空'), '空库提示')
  const lv = tools.find((t) => t.name === 'list_video_library')!
  assert(String(await lv.execute({})).includes('为空'), '空视频库提示')
  const ra = tools.find((t) => t.name === 'rename_audio_library')!
  await ra.execute({ id: 'a-1', name: '新名字' })
  assert(calls.some((c) => c.op === 'renameAudioLibrary' && c.args[0] === 'a-1' && c.args[1] === '新名字'), '改名应调桥')
  const rm = tools.find((t) => t.name === 'remove_audio_library')!
  await rm.execute({ id: 'a-1' })
  assert(calls.some((c) => c.op === 'removeAudioLibrary' && c.args[0] === 'a-1'), '移除应调桥')
})

await test('set_media_window_size:钳制 160-800 + previous 原值 + 已是目标值提示', async () => {
  const calls: Array<{ op: string; args: unknown[] }> = []
  const tools = createSettingsTools({
    runIslandSettings: async (op, args) => {
      calls.push({ op, args })
      if (op === 'setMediaWindowSize') return { ok: true, width: Number(args[0]), previous: 320 }
      return { ok: true }
    },
  })
  const tool = tools.find((t) => t.name === 'set_media_window_size')!
  // 正常调整
  const out = String(await tool.execute({ width: 480 }))
  assert(out.includes('480') && out.includes('320'), `输出应含新旧值,实际:${out}`)
  assert(calls[0]?.op === 'setMediaWindowSize' && calls[0]?.args[0] === 480, '应调桥且传宽')
  // 钳制:超出范围
  await tool.execute({ width: 9999 })
  assert(calls[1]?.args[0] === 800, `应钳制到 800,实际 ${String(calls[1]?.args[0])}`)
  await tool.execute({ width: 10 })
  assert(calls[2]?.args[0] === 160, `应钳制到 160,实际 ${String(calls[2]?.args[0])}`)
  // 非数字拒绝
  await assertRejects(() => tool.execute({ width: 'abc' }), '数字', '非数字应拒绝')
  // 已是目标值提示(桥返回 width === previous)
  const same = createSettingsTools({
    runIslandSettings: async () => ({ ok: true, width: 320, previous: 320 }),
  }).find((t) => t.name === 'set_media_window_size')!
  assert(String(await same.execute({ width: 320 })).includes('无需修改'), '已是目标值应提示无需修改')
})

await test('set_theme_color:hex 校验与归一化', async () => {
  const calls: Array<{ op: string; args: unknown[] }> = []
  const tools = createSettingsTools({
    runIslandSettings: async (op, args) => {
      calls.push({ op, args })
      return { ok: true }
    },
  })
  const tool = tools.find((t) => t.name === 'set_theme_color')!
  const out = String(await tool.execute({ color: 'f87171' }))
  assert(out.includes('#f87171'), '输出应含归一化后的颜色')
  assert(calls.length === 1 && calls[0].op === 'setThemeColor' && calls[0].args[0] === '#f87171', '应调桥且 hex 归一化为 # 前缀小写')
  await assertRejects(() => tool.execute({ color: 'red' }), '颜色格式不正确', '非法颜色应拒绝')
  await assertRejects(() => tool.execute({}), '颜色格式不正确', '缺 color 应拒绝')
  await assertRejects(() => tool.execute({ color: '#12345' }), '颜色格式不正确', '5 位 hex 应拒绝')
})

await test('set_agent_scale:钳制 100-400(2026-08-11 上限从 300 上调)', async () => {
  const calls: Array<{ op: string; args: unknown[] }> = []
  const tools = createSettingsTools({ runIslandSettings: async (op, args) => { calls.push({ op, args }); return { ok: true } } })
  const tool = tools.find((t) => t.name === 'set_agent_scale')!
  await tool.execute({ percent: 150 })
  await tool.execute({ percent: 50 })
  await tool.execute({ percent: 500 })
  await tool.execute({ percent: 400 })
  await tool.execute({ percent: 150.6 })
  const scales = calls.map((c) => c.args[0] as number)
  assert(
    scales[0] === 150 && scales[1] === 100 && scales[2] === 400 && scales[3] === 400 && scales[4] === 151,
    `钳制/取整错误:${scales.join(',')}`,
  )
  await assertRejects(() => tool.execute({ percent: 'abc' }), '需要是数字', '非数字应拒绝')
})

await test('import_font:扩展名/存在性/大小校验与 data URL 传递', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-font-test-'))
  try {
    const calls: Array<{ op: string; args: unknown[] }> = []
    const tools = createSettingsTools({ runIslandSettings: async (op, args) => { calls.push({ op, args }); return { ok: true } } })
    const tool = tools.find((t) => t.name === 'import_font')!
    // 成功:小 ttf → data URL 前缀正确
    const fontPath = path.join(tmpDir, 'test-font.ttf')
    await fs.writeFile(fontPath, Buffer.from([0x00, 0x01, 0x00, 0x00, 0x66, 0x6f, 0x6f, 0x74]))
    const out = String(await tool.execute({ path: fontPath }))
    assert(out.includes('test-font.ttf'), '输出应含字体名')
    assert(calls[0].op === 'importFont' && (calls[0].args[0] as string).startsWith('data:font/ttf;base64,'), '应调桥且 data URL 为 font/ttf')
    assert(typeof calls[0].args[1] === 'string' && calls[0].args[1].includes('test-font.ttf'), '缺省名称应为文件名')
    // 自定义名称
    await tool.execute({ path: fontPath, name: '我的字体' })
    assert(calls[1].args[1] === '我的字体', '自定义名称应传递')
    // 扩展名拒绝
    await assertRejects(() => tool.execute({ path: path.join(tmpDir, 'bad.exe') }), '不支持的文件类型', '非字体扩展名应拒绝')
    // 文件不存在
    await assertRejects(() => tool.execute({ path: path.join(tmpDir, 'missing.ttf') }), '文件不存在', '不存在应拒绝')
    // 空文件
    await fs.writeFile(path.join(tmpDir, 'empty.ttf'), '')
    await assertRejects(() => tool.execute({ path: path.join(tmpDir, 'empty.ttf') }), '文件为空', '空文件应拒绝')
    // 超 30MB
    await fs.writeFile(path.join(tmpDir, 'big.ttf'), Buffer.alloc(31 * 1024 * 1024))
    await assertRejects(() => tool.execute({ path: path.join(tmpDir, 'big.ttf') }), '文件过大', '超 30MB 应拒绝')
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
})

await test('import_background:图片扩展名校验与双槽位应用', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-img-test-'))
  try {
    const calls: Array<{ op: string; args: unknown[] }> = []
    const tools = createSettingsTools({ runIslandSettings: async (op, args) => { calls.push({ op, args }); return { ok: true } } })
    const tool = tools.find((t) => t.name === 'import_background')!
    const pngPath = path.join(tmpDir, 'bg.png')
    await fs.writeFile(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    await tool.execute({ path: pngPath })
    assert(calls[0].op === 'importBackground' && (calls[0].args[0] as string).startsWith('data:image/png;base64,'), '应调桥且 data URL 为 image/png')
    await assertRejects(() => tool.execute({ path: path.join(tmpDir, 'bg.avif') }), '不支持的文件类型', 'avif 应拒绝')
    await assertRejects(() => tool.execute({ path: path.join(tmpDir, 'missing.png') }), '文件不存在', '不存在应拒绝')
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
})

await test('list/rename:列表格式化与名称校验', async () => {
  const calls: Array<{ op: string; args: unknown[] }> = []
  const tools = createSettingsTools({
    runIslandSettings: async (op, args) => {
      calls.push({ op, args })
      if (op === 'listFonts') return [{ id: 'f-1', name: '字体甲' }, { id: 'f-2', name: '字体乙' }]
      if (op === 'listLibraryImages') return [{ id: 'i-1', name: '图一' }]
      return { ok: true }
    },
  })
  const listFonts = tools.find((t) => t.name === 'list_fonts')!
  const out1 = String(await listFonts.execute({}))
  assert(out1.includes('f-1 字体甲') && out1.includes('f-2 字体乙'), '列表应含 id 与名称')
  const listImgs = tools.find((t) => t.name === 'list_library_images')!
  const out2 = String(await listImgs.execute({}))
  assert(out2.includes('i-1 图一'), '图片列表应含 id 与名称')
  const emptyTools = createSettingsTools({ runIslandSettings: async (op) => (op === 'listFonts' ? [] : []) })
  assert(String(await emptyTools.find((t) => t.name === 'list_fonts')!.execute({})).includes('为空'), '空库应有提示')
  const renameImg = tools.find((t) => t.name === 'rename_library_image')!
  await renameImg.execute({ id: 'i-1', name: '新名字' })
  assert(calls.some((c) => c.op === 'renameLibraryImage' && c.args[0] === 'i-1' && c.args[1] === '新名字'), '改名应调桥')
  await assertRejects(() => renameImg.execute({ id: 'i-1', name: '' }), '名称不能为空', '空名称应拒绝')
  await assertRejects(() => renameImg.execute({ id: '', name: 'x' }), 'id 不能为空', '空 id 应拒绝')
  await assertRejects(() => renameImg.execute({ id: 'i-1', name: 'x'.repeat(60) }), '名称过长', '超长名称应拒绝')
  const renameFont = tools.find((t) => t.name === 'rename_font')!
  await renameFont.execute({ id: 'f-1', name: '字体甲新' })
  assert(calls.some((c) => c.op === 'renameFont' && c.args[1] === '字体甲新'), '字体改名应调桥')
})

await test('set_video_config:透传音量/速度/循环/全屏/宽度;空参数拒绝', async () => {
  // 2026-08-10 用户要求:调整对话窗口内正在观看视频的设置(播放速度/
  // 循环/全屏/媒体窗口默认宽)+ 灵动岛独立音量(与系统音量分离)
  const calls: Array<{ op: string; args: unknown[] }> = []
  const tools = createSettingsTools({
    runIslandSettings: async (op, args) => {
      calls.push({ op, args })
      if (op === 'setVideoPrefs') {
        const patch = (args[0] ?? {}) as { volume?: number; speed?: number; loop?: boolean }
        return {
          ok: true,
          volume: patch.volume ?? 1,
          speed: patch.speed ?? 1,
          loop: patch.loop ?? false,
          previous: { volume: 1, speed: 1, loop: false },
        }
      }
      if (op === 'setFullscreen') return { ok: true, fullscreen: Boolean(args[0]) }
      if (op === 'setMediaWindowSize') return { ok: true, width: Number(args[0]), previous: 320 }
      return { ok: true }
    },
  })
  const tool = tools.find((t) => t.name === 'set_video_config')
  assert(tool, '应注册 set_video_config')
  const out = String(
    await tool!.execute({ volume: 0.6, speed: 1.5, loop: true, fullscreen: true, width: 480 }),
  )
  const svp = calls.find((c) => c.op === 'setVideoPrefs')
  assert(svp, '应调桥 setVideoPrefs')
  const patch = (svp!.args[0] ?? {}) as { volume?: number; speed?: number; loop?: boolean }
  assert(patch.volume === 0.6 && patch.speed === 1.5 && patch.loop === true, '音量/速度/循环应透传')
  assert(calls.some((c) => c.op === 'setFullscreen' && c.args[0] === true), '应调桥 setFullscreen(true)')
  assert(calls.some((c) => c.op === 'setMediaWindowSize' && c.args[0] === 480), '应调桥 setMediaWindowSize(480)')
  assert(out.includes('音量') && out.includes('速度') && out.includes('循环') && out.includes('全屏'), '返回应列出各项变化')
  // 越界拒绝(LLM 自纠语义,与设置工具既有校验一致)
  await assertRejects(() => tool!.execute({ volume: 2 }), 'volume 需要是 0-1', '越界 volume 应拒绝')
  await assertRejects(() => tool!.execute({ speed: 5 }), 'speed 需要是 0.5-2', '越界 speed 应拒绝')
  // 空参数拒绝
  await assertRejects(() => tool!.execute({}), '至少提供一个参数', '空参数应拒绝')
})

await test('set_video_config:target 指定单视频(音量/速度/循环/播放暂停);playing 无 target 控制当前视频', async () => {
  // 2026-08-10 二轮用户要求:同时播两个视频,能独立调整单个视频的
  // 音量/播放模式/开关(播放暂停)
  const calls: Array<{ op: string; args: unknown[] }> = []
  const tools = createSettingsTools({
    runIslandSettings: async (op, args) => {
      calls.push({ op, args })
      if (op === 'setVideoState') {
        const input = (args[0] ?? {}) as { name?: string; volume?: number; playing?: boolean }
        if (input.name === '不存在的.mp4') throw new Error('对话窗口没有名为「不存在的.mp4」的视频(用 list_conversation_media 查看可用的名字)')
        return {
          ok: true,
          name: input.name,
          volume: input.volume !== undefined ? Math.round(input.volume * 100) : 60,
          speed: 1,
          loop: false,
          playing: input.playing ?? true,
        }
      }
      if (op === 'setVideoPrefs') {
        const patch = (args[0] ?? {}) as { volume?: number }
        return { ok: true, volume: patch.volume ?? 1, speed: 1, loop: false, previous: { volume: 1, speed: 1, loop: false } }
      }
      return { ok: true }
    },
  })
  const tool = tools.find((t) => t.name === 'set_video_config')
  assert(tool, '应注册 set_video_config')
  // target + 音量:调 setVideoState,不调 setVideoPrefs(个性化,不动全局)
  const out1 = String(await tool!.execute({ target: '视频A.mp4', volume: 0.3 }))
  const state = calls.filter((c) => c.op === 'setVideoState')
  assert(state.length === 1 && (state[0].args[0] as { name?: string }).name === '视频A.mp4', '应调桥 setVideoState 且带 name')
  assert(!calls.some((c) => c.op === 'setVideoPrefs'), 'target 指定时不应调全局 setVideoPrefs')
  assert(out1.includes('视频A.mp4') && out1.includes('30'), '返回应含视频名与调整后音量')
  // target + playing:false:暂停指定视频
  calls.length = 0
  const out2 = String(await tool!.execute({ target: '视频B.mp4', playing: false }))
  const st2 = calls.find((c) => c.op === 'setVideoState')
  assert(st2 && (st2.args[0] as { playing?: boolean }).playing === false, '应调桥 setVideoState 且 playing=false')
  assert(out2.includes('暂停'), '返回应含暂停')
  // playing 无 target:控制当前播放中的视频(桥 name 缺省语义)
  calls.length = 0
  const out3 = String(await tool!.execute({ playing: true }))
  const st3 = calls.find((c) => c.op === 'setVideoState')
  assert(st3 && (st3.args[0] as { name?: string }).name === undefined, '无 target 的 playing 不应带 name')
  assert(out3.includes('播放'), '返回应含播放')
  // 未知 target 时桥抛错(找不到视频)透传
  await assertRejects(
    () => tool!.execute({ target: '不存在的.mp4', volume: 0.5 }),
    '没有名为「不存在的.mp4」的视频',
    '未知 target 应报错',
  )
})

await test('switch_to_music:play 参数透传 onSwitchToMusic(听歌自动播放)', async () => {
  // 2026-08-11 用户"让 LLM 切换成音乐模式听歌,没有自动播放":工具带
  // play:true 时切换后立即开始播放当前播放列表
  const calls: Array<boolean | undefined> = []
  const tools = createTools({ onSwitchToMusic: (play) => calls.push(play) })
  const tool = tools.find((t) => t.name === 'switch_to_music')
  assert(tool, '应注册 switch_to_music')
  assert(tool!.parameters.properties?.play, '参数应含 play(布尔)')
  assert(tool!.description.includes('play:true'), '描述应引导听歌时带 play:true')
  const outPlay = String(await tool!.execute({ play: true }))
  assert(outPlay.includes('开始播放'), 'play:true 的返回应说明开始播放')
  const outPlain = String(await tool!.execute({}))
  assert(!outPlain.includes('开始播放'), '不带 play 的返回应只说明切换')
  assert(calls[0] === true && calls[1] === false, `onSwitchToMusic 应收到 play 透传:${calls}`)
})

await test('set_system_volume:注册与参数校验;不实际改系统音量', async () => {
  // 2026-08-10 用户要求"支持调整系统音量":winmm waveOut 脚本。
  // 测试只校验注册与错误路径(成功路径会真实改系统音量,不测)
  const tools = createTools({ onSwitchToMusic: () => {} })
  const tool = tools.find((t) => t.name === 'set_system_volume')
  assert(tool, '应注册 set_system_volume')
  const desc = tool!.description
  assert(desc.includes('系统') && desc.includes('set_video_config'), '描述应说明系统音量与独立音量的区分')
  await assertRejects(() => tool!.execute({ action: 'bogus' }), 'action 只能是 get 或 set', '非法 action 应拒绝')
  await assertRejects(() => tool!.execute({ action: 'set' }), 'volume 需要是数字', 'set 缺 volume 应拒绝')
  await assertRejects(() => tool!.execute({ action: 'set', volume: 'abc' }), 'volume 需要是数字', '非数字 volume 应拒绝')
})

await test('list_conversation_media:格式化视频播放状态;空清单兜底', async () => {
  // 2026-08-10 用户要求:LLM 能查对话窗口有哪些媒体附件、哪个在播放、
  // 视频的音量/速度/循环/全屏状态
  const tools = createSettingsTools({
    runIslandSettings: async (op) => {
      if (op === 'getConversationMedia') {
        return [
          { kind: 'video', name: '演唱会.mp4', playing: true, volume: 60, speed: 1.5, loop: true, fullscreen: false, position: 83, duration: 225 },
          { kind: 'audio', name: 'demo.mp3', playing: false },
          { kind: 'img', name: '封面.png', path: 'C:\\pics\\cover.png' },
        ]
      }
      return { ok: true }
    },
  })
  const tool = tools.find((t) => t.name === 'list_conversation_media')
  assert(tool, '应注册 list_conversation_media')
  const out = String(await tool!.execute({}))
  assert(out.includes('正在播放') && out.includes('音量 60%') && out.includes('速度 1.5x'), '视频应带播放状态/音量/速度')
  assert(out.includes('循环开') && out.includes('非全屏') && out.includes('1:23 / 3:45'), '视频应带循环/全屏/进度')
  assert(out.includes('已暂停') && out.includes('图片'), '音频与图片应列出')
  // 2026-08-19:对话中展示的图片带绝对路径,可传给 import_background 设背景
  assert(out.includes('C:\\pics\\cover.png'), '图片应带绝对路径(path)供设背景复用')
  const empty = createSettingsTools({ runIslandSettings: async () => [] })
  assert(
    String(await empty.find((t) => t.name === 'list_conversation_media')!.execute({})).includes('没有媒体附件'),
    '空清单应有兜底',
  )
})

await test('play_library_video:透传 id 并返回播放文本;空 id 拒绝', async () => {
  const calls: Array<{ op: string; args: unknown[] }> = []
  const tools = createSettingsTools({
    runIslandSettings: async (op, args) => {
      calls.push({ op, args })
      return op === 'playLibraryVideo' ? { ok: true, id: String(args[0]), name: '我的视频' } : { ok: true }
    },
  })
  const play = tools.find((t) => t.name === 'play_library_video')!
  assert(play, '应注册 play_library_video')
  const out = String(await play.execute({ id: 'v-1' }))
  assert(calls.some((c) => c.op === 'playLibraryVideo' && c.args[0] === 'v-1'), '应调桥 playLibraryVideo')
  assert(out.includes('我的视频'), '返回文本应含视频名称')
  await assertRejects(() => play.execute({ id: '' }), 'id 不能为空', '空 id 应拒绝')
})

// ---------------------------------------------------------------------------
// 通用后台任务注册表(tasks.ts;人工场景监控 + 对话反馈空间)
// ---------------------------------------------------------------------------

// 每例结束清空注册表与回调,防跨用例污染
function resetTasks() {
  setTaskDoneHandler(undefined)
  for (const t of listTasks()) removeTask(t.id)
}

await test('任务注册表:注册等待任务 → 状态块实时可见', async () => {
  resetTasks()
  registerTask({ id: 'login-1', title: 'B站扫码登录', status: 'waiting', detail: '等待用户扫码确认(二维码 2 分钟内有效)' })
  registerTask({ id: 'dl-1', title: 'B站下载', status: 'running', detail: '视频下载(BV1xx)(进程 42),输出目录 C:\\dl' })
  const block = getTasksStatusBlock()
  assert(block.includes('【后台任务状态'), '应有状态块标题')
  assert(block.includes('B站扫码登录:等待中,等待用户扫码确认'), '等待任务应显示等待中 + 细节')
  assert(block.includes('B站下载:进行中,视频下载(BV1xx)'), '进行中任务应显示进行中 + 细节')
  assert(block.includes('提醒用户当前需要做什么'), '状态块应指导 LLM 提醒用户人工操作')
  // 文案稳定(两次调用逐字一致,不破坏 DeepSeek 前缀缓存)
  assert(getTasksStatusBlock() === block, '状态不变时文案应逐字稳定')
})

await test('任务注册表:进入终态触发 done 回调一次;失败也有反馈', async () => {
  resetTasks()
  const events: AgentTask[] = []
  setTaskDoneHandler((t) => events.push(t))
  registerTask({ id: 'login-1', title: 'B站扫码登录', status: 'waiting', detail: '等待用户扫码确认' })
  updateTask('login-1', { status: 'done', detail: '用户已扫码确认,已登录 B 站' })
  assert(events.length === 1 && events[0].status === 'done', '完成应触发回调一次')
  assert(events[0].detail === '用户已扫码确认,已登录 B 站', '回调应携带终态细节')
  // 已终态再更新被忽略(防重复回调)
  updateTask('login-1', { status: 'failed', detail: 'x' })
  assert(events.length === 1, '已终态任务再更新不应重复触发')
  // 失败同样进入终态触发回调(登录失败/下载失败都有对话反馈空间)
  registerTask({ id: 'login-2', title: 'B站扫码登录', status: 'waiting', detail: '等待用户扫码确认' })
  updateTask('login-2', { status: 'failed', detail: '二维码已过期或未扫码确认,可重新生成' })
  assert(events.length >= 2 && events[1]?.status === 'failed', '失败应触发回调')
  const block = getTasksStatusBlock()
  assert(block.includes('B站扫码登录:已完成,用户已扫码确认'), '终态应出现在状态块')
  assert(block.includes('B站扫码登录:已失败,二维码已过期'), '失败状态应出现在状态块')
})

await test('任务注册表:终态回调载荷可拼 background-done 标题/消息', async () => {
  resetTasks()
  let fired: AgentTask | undefined
  setTaskDoneHandler((t) => {
    fired = t
  })
  registerTask({ id: 'dl-1', title: 'B站下载', status: 'running', detail: '视频下载(BV1xx)(进程 42),输出目录 C:\\dl' })
  updateTask('dl-1', { status: 'done', detail: '视频下载(BV1xx)已完成:\nC:\\dl\\video.mp4' })
  assert(fired, '终态应触发')
  const suffix = fired!.status === 'done' ? '完成' : '失败'
  const title = `${fired!.title}${suffix}`
  assert(title === 'B站下载完成', '标题应拼「任务名+完成/失败」(background-done 用)')
  assert(fired!.detail.includes('C:\\dl\\video.mp4'), '消息应含输出文件绝对路径')
})

await test('任务注册表:注册覆盖 + 移除 + 无任务空串', async () => {
  resetTasks()
  assert(getTasksStatusBlock() === '', '无任务应返回空串')
  registerTask({ id: 'a', title: 'A', status: 'waiting', detail: 'd1' })
  registerTask({ id: 'a', title: 'A2', status: 'waiting', detail: 'd2' })
  const block = getTasksStatusBlock()
  assert(block.includes('A2:等待中,d2') && !block.includes('d1'), '同 id 注册应覆盖')
  removeTask('a')
  assert(getTasksStatusBlock() === '', '移除后应无任务')
})

await test('任务注册表:pruneTasks 清理超 TTL 终态记录', async () => {
  resetTasks()
  const now = Date.now()
  // 注入时间戳模拟:old 已超 24h TTL(25h 前更新),fresh 仍在 TTL 内(12h 前)
  registerTask({ id: 'old', title: '旧任务', status: 'done', detail: '已完成', at: now })
  registerTask({ id: 'fresh', title: '新任务', status: 'done', detail: '已完成', at: now + 12 * 60 * 60 * 1000 })
  pruneTasks(now + 25 * 60 * 60 * 1000)
  const block = getTasksStatusBlock()
  assert(!block.includes('旧任务'), '超 TTL 终态应被清理')
  assert(block.includes('新任务'), 'TTL 内终态应保留')
})

// ---------------------------------------------------------------------------
// 工具参数校验与自主纠错(validateRequiredArgs,2026-08-08)
// ---------------------------------------------------------------------------

console.log('\n=== 工具参数校验与自主纠错(validateRequiredArgs) ===')

/** 复刻生产 write_file 的 schema(与 tools.ts 一致) */
const writeFileTool: AgentTool = {
  name: 'write_file',
  description: '写入本机文件',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件绝对路径' },
      content: { type: 'string', description: '要写入的完整内容' },
    },
    required: ['path', 'content'],
  },
  async execute() {
    return 'ok'
  },
}

await test('write_file 空参数 → 错误文本列出缺失参数名+类型+说明', () => {
  const err = validateRequiredArgs(writeFileTool, {})
  assert(err !== null, '空参数应校验失败')
  assert(err.includes('write_file'), '错误应含工具名')
  assert(err.includes('"path"') && err.includes('"content"'), '应列出两个缺失参数')
  assert(err.includes('文件绝对路径') && err.includes('要写入的完整内容'), '应带参数说明(LLM 可据此自纠)')
  assert(!err.includes('_raw'), '无解析失败原文时不应有 _raw 段')
})

await test('write_file 完整参数 → 校验通过', () => {
  const err = validateRequiredArgs(writeFileTool, { path: 'C:\\a.txt', content: '内容' })
  assert(err === null, '完整参数应通过')
})

await test('空字符串参数视为缺失(值存在但为空)', () => {
  const err = validateRequiredArgs(writeFileTool, { path: '', content: 'x' })
  assert(err !== null && err.includes('"path"') && !err.includes('"content"'), '仅缺 path')
})

await test('数值 0 / 布尔 false 是合法值(不误判缺失)', () => {
  const tool: AgentTool = {
    name: 't',
    description: 'd',
    parameters: { type: 'object', properties: { n: { type: 'number' }, b: { type: 'boolean' } }, required: ['n', 'b'] },
    async execute() {
      return 'ok'
    },
  }
  assert(validateRequiredArgs(tool, { n: 0, b: false }) === null, '0 与 false 不应判缺失')
})

await test('无 required 的工具(list_dir 等)不校验', () => {
  const tool: AgentTool = {
    name: 'list_dir',
    description: 'd',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: [] },
    async execute() {
      return 'ok'
    },
  }
  assert(validateRequiredArgs(tool, {}) === null, '空参数也通过(参数全可选)')
})

await test('解析失败原文(_raw)附带在错误文本里', () => {
  const err = validateRequiredArgs(writeFileTool, { _raw: '{"path": broken' })
  assert(err !== null && err.includes('无法解析为 JSON') && err.includes('{"path": broken'), '应附原始参数')
})

await test('enum 参数缺失时错误文本带可选值', () => {
  const tool: AgentTool = {
    name: 'bili',
    description: 'd',
    parameters: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['search', 'open'], description: '操作' } },
      required: ['action'],
    },
    async execute() {
      return 'ok'
    },
  }
  const err = validateRequiredArgs(tool, {})
  assert(err !== null && err.includes('search/open'), '应列出 enum 可选值')
})

// ---------------------------------------------------------------------------
// Responses SSE 工具参数累积(streamResponse + mock fetch,2026-08-08 回归:
// delta 按 output_index 匹配 / function_call_arguments.done 权威参数)
// ---------------------------------------------------------------------------

console.log('\n=== Responses SSE 工具参数累积(streamResponse) ===')

/** 构造 SSE 响应体(mock fetch 用) */
function sseResponse(frames: Array<Record<string, unknown>>): Response {
  const text = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('')
  return new Response(new Blob([text]), { status: 200 })
}

const mockConfig = {
  ...MOCK_PROVIDERS,
  apiKey: 'test-key',
  baseURL: 'https://api.deepseek.com',
  model: 'deepseek-v4-flash',
  systemPrompt: '',
  reasoningEffort: 'high',
  mcpServers: [],
  skillsDirs: [],
}

await test('delta 按 output_index 匹配累积(不带 call_id)+ done 权威参数', async () => {
  const origFetch = globalThis.fetch
  let capturedBody = ''
  globalThis.fetch = async (_url: string | URL | Request, opts?: RequestInit) => {
    capturedBody = String(opts?.body ?? '')
    const frames = [
      { type: 'response.created', response: { id: 'r1' } },
      // output_item.added:call_id 与 item.id / output_index 都记录
      {
        type: 'response.output_item.added',
        output_index: 2,
        item: { type: 'function_call', id: 'item_1', call_id: 'call_1', name: 'write_file', arguments: '' },
      },
      // 实测 delta 事件不带 call_id,只有 output_index(2026-08-08)
      { type: 'response.function_call_arguments.delta', output_index: 2, delta: '{"pa' },
      { type: 'response.function_call_arguments.delta', output_index: 2, delta: 'th": "C:\\\\a.txt", "content": "你好"}' },
      // 权威完整参数(item_id 匹配)
      {
        type: 'response.function_call_arguments.done',
        item_id: 'item_1',
        arguments: '{"path": "C:\\\\a.txt", "content": "你好"}',
      },
      // output_item.done 不带 arguments(旧兜底路径失效时也不丢参数)
      {
        type: 'response.output_item.done',
        output_index: 2,
        item: { type: 'function_call', id: 'item_1', call_id: 'call_1', name: 'write_file' },
      },
      { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 5 } } },
    ]
    return sseResponse(frames)
  }
  try {
    const partials: string[] = []
    const finals: string[] = []
    const outcome = await streamResponse({
      config: mockConfig,
      system: 's',
      history: [],
      tools: [writeFileTool],
      signal: new AbortController().signal,
      onEvent: (e) => {
        if (e.type === 'tool-partial-call') partials.push(e.args)
        if (e.type === 'tool-call') finals.push(e.args)
      },
    })
    assert(outcome.calls.length === 1, `应有 1 个调用,实际 ${outcome.calls.length}`)
    assert(outcome.calls[0].name === 'write_file', '工具名应为 write_file')
    assert(outcome.calls[0].args === '{"path": "C:\\\\a.txt", "content": "你好"}', `权威参数应完整,实际 ${outcome.calls[0].args}`)
    assert(partials.length >= 2 && partials[1]?.includes('你好'), `流式增量应按 output_index 累积,实际 ${partials.length} 条`)
    assert(finals.length >= 2 && finals[finals.length - 1] === outcome.calls[0].args, '最终 tool-call 事件应为完整参数')
    const body = JSON.parse(capturedBody) as Record<string, unknown>
    assert(body.max_output_tokens === 4096, '不传 maxOutputTokens 时缺省 4096')
  } finally {
    globalThis.fetch = origFetch
  }
})

await test('仅 output_item.done 带完整参数(无 delta/done 事件)→ 参数不丢', async () => {
  const origFetch = globalThis.fetch
  globalThis.fetch = async () =>
    sseResponse([
      { type: 'response.created', response: { id: 'r2' } },
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'function_call', id: 'item_1', call_id: 'call_1', name: 'write_file', arguments: '' },
      },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'function_call',
          id: 'item_1',
          call_id: 'call_1',
          name: 'write_file',
          arguments: '{"path": "C:\\\\a.txt", "content": "x"}',
        },
      },
      { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } },
    ])
  try {
    const outcome = await streamResponse({
      config: mockConfig,
      system: 's',
      history: [],
      tools: [writeFileTool],
      signal: new AbortController().signal,
      onEvent: () => {},
    })
    assert(outcome.calls[0]?.args === '{"path": "C:\\\\a.txt", "content": "x"}', 'output_item.done 参数应生效')
  } finally {
    globalThis.fetch = origFetch
  }
})

await test('maxOutputTokens 覆盖传入请求体(任意值透传)', async () => {
  const origFetch = globalThis.fetch
  let captured = ''
  globalThis.fetch = async (_url: string | URL | Request, opts?: RequestInit) => {
    captured = String(opts?.body ?? '')
    return sseResponse([{ type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } }])
  }
  try {
    await streamResponse({
      config: mockConfig,
      system: 's',
      history: [],
      tools: [],
      signal: new AbortController().signal,
      onEvent: () => {},
      maxOutputTokens: 8192,
    })
    const body = JSON.parse(captured) as Record<string, unknown>
    assert(body.max_output_tokens === 8192, `应传 8192,实际 ${String(body.max_output_tokens)}`)
  } finally {
    globalThis.fetch = origFetch
  }
})

await test('open_file:媒体文件拦截返回媒体附件(窗口内播放,不弹外部播放器)', async () => {
  // 2026-08-08:用户"说打开视频看看,结果打开的是外部播放器;LLM 回复
  // 已播放但窗口看不到视频气泡"——open_file 对媒体扩展名返回
  // { text, media } 附件,引擎注入 media part → 渲染端 MediaFrame
  // 窗口内播放;非媒体文件仍走 shell.openPath(stub 返回 '')
  // 2026-08-09:媒体拦截前校验文件存在(LLM 拼路径差一个字 → 协议 404
  // → 渲染端假报"格式不支持"),路径不存在直接抛错让 LLM 自纠
  const mediaDir = path.join(tmp, 'media-tools')
  await fs.mkdir(mediaDir, { recursive: true })
  const vid = path.join(mediaDir, 'clip.mp4')
  const aud = path.join(mediaDir, 'song.mp3')
  const img = path.join(mediaDir, 'photo.png')
  const txt = path.join(mediaDir, 'readme.txt')
  for (const f of [vid, aud, img, txt]) await fs.writeFile(f, 'x')
  const tools = createTools({ onSwitchToMusic: () => {} })
  const openFile = tools.find((t) => t.name === 'open_file')
  assert(openFile, 'open_file 工具应存在')
  const r1 = await openFile!.execute({ path: vid })
  assert(
    typeof r1 === 'object' && r1.media && r1.media[0]?.kind === 'video' && r1.media[0].url === vid,
    '视频应返回 video 媒体附件',
  )
  assert(typeof r1 === 'object' && r1.text.includes('附件'), '引导文本应提示已作为附件展示')
  const r2 = await openFile!.execute({ path: aud })
  assert(typeof r2 === 'object' && r2.media?.[0]?.kind === 'audio', '音频应返回 audio 媒体附件')
  const r3 = await openFile!.execute({ path: img })
  assert(typeof r3 === 'object' && r3.media?.[0]?.kind === 'img', '图片应返回 img 媒体附件')
  const r4 = await openFile!.execute({ path: txt })
  assert(typeof r4 === 'string' && r4.includes('已打开'), '非媒体文件应正常打开(走 shell.openPath)')
  // 2026-08-09:媒体扩展名但文件不存在 → 抛错(不下发 404 附件)
  await assertRejects(
    () => openFile!.execute({ path: path.join(mediaDir, '不存在但.mp4') }),
    '文件不存在',
    '不存在的媒体路径应抛错(含「文件不存在」)',
  )
})

await test('exec_command:start 打开媒体文件 → 拦截返回媒体附件(不弹外部播放器)', async () => {
  // 2026-08-08:LLM 播放视频常用 start 命令而非 open_file——exec_command
  // 对 `start "标题" "路径"` / `start 路径` 提取媒体路径返回附件
  // 2026-08-09:start 解析出的媒体路径同样校验存在(不存在 = 空格/引号
  // 截断,抛错引导 LLM 改用 open_file 传完整路径)
  const mediaDir = path.join(tmp, 'media-start')
  await fs.mkdir(mediaDir, { recursive: true })
  const vid = path.join(mediaDir, 'clip.mp4')
  const aud = path.join(mediaDir, 'song.mp3')
  for (const f of [vid, aud]) await fs.writeFile(f, 'x')
  const tools = createTools({ onSwitchToMusic: () => {} })
  const exec = tools.find((t) => t.name === 'exec_command')
  assert(exec, 'exec_command 工具应存在')
  const r1 = await exec!.execute({ command: `start "" "${vid}"` })
  assert(
    typeof r1 === 'object' && r1.media?.[0]?.kind === 'video' && r1.media[0].url === vid,
    `双引号形式应拦截返回 video 附件,实际 ${JSON.stringify(r1)}`,
  )
  const r2 = await exec!.execute({ command: `start ${aud}` })
  assert(typeof r2 === 'object' && r2.media?.[0]?.kind === 'audio', '裸 token 形式应返回 audio 附件')
  // 相对路径按 cwd 解析(path.resolve 在 Windows 返回反斜杠,归一化比较)
  const r3 = await exec!.execute({ command: 'start clip.mp4', cwd: mediaDir })
  assert(
    typeof r3 === 'object' && r3.media?.[0]?.url?.replaceAll('\\', '/') === mediaDir.replaceAll('\\', '/') + '/clip.mp4',
    `相对路径应按 cwd 解析,实际 ${JSON.stringify(typeof r3 === 'object' ? r3.media : r3)}`,
  )
  // 非媒体/非 start:正常执行(stub shell 返回空)
  const r4 = await exec!.execute({ command: 'dir' })
  assert(typeof r4 === 'string', '普通命令应正常执行')
  // 单引号串(纯标题,cmd 不打开文件):不拦截
  const r5 = await exec!.execute({ command: 'start "some title"' })
  assert(typeof r5 === 'string', '单引号串(纯标题)不应拦截')
  // 2026-08-09:媒体扩展名但路径不存在 → 抛错(含 open_file 引导;
  // 双引号两段形式才会拦截,单引号串 = 纯标题不拦截)
  await assertRejects(
    () => exec!.execute({ command: 'start "" "不存在但.mp4"' }),
    'open_file',
    'start 解析的媒体路径不存在应抛错(含 open_file 引导)',
  )
})

await test('get_feature_guide:读真实引导文档;话题过滤与目录;纯函数提取', async () => {
  // 2026-08-10:LLM 功能引导工具——读取 docs/TECH.md(仓库内,打包版
  // resources/docs/TECH.md),按话题返回章节,无 topic 返回目录
  const tools = createTools({ onSwitchToMusic: () => {} })
  const guide = tools.find((t) => t.name === 'get_feature_guide')
  assert(guide, 'get_feature_guide 工具应注册')
  // 无 topic → 目录(标题树)
  const toc = String(await guide!.execute({}))
  assert(toc.includes('第 1 章') || toc.includes('第 11 章'), `目录应含章节标题,实际前 80 字:${toc.slice(0, 80)}`)
  // 话题过滤 → 命中章节(多媒体库在功能引导第 11 章)
  const out = String(await guide!.execute({ topic: '多媒体库' }))
  assert(out.includes('多媒体库'), '按话题应返回含关键词的章节')
  assert(out.length > 50, '返回内容不应过短')
  // 空话题与无匹配的兜底
  const miss = String(await guide!.execute({ topic: '不存在的功能xyz' }))
  assert(miss.includes('未找到') && miss.includes('话题'), '无匹配应给可读兜底')
  // 纯函数:小样本切分/过滤/截断
  const { extractGuideSections } = await import('../electron/agent/tools/tools')
  const sample = [
    '# 章A',
    '## 节1 音乐',
    '音乐模式说明正文内容比较长',
    '## 节2 视频',
    '视频模式说明正文内容比较长',
    '# 章B',
    '## 节3 其他',
    '别的正文',
  ].join('\n')
  const hit1 = extractGuideSections(sample, '音乐')
  assert(hit1.includes('节1') && !hit1.includes('节2'), '应按话题精确命中章节')
  const hit2 = extractGuideSections(sample, '视频', { maxChars: 10 })
  assert(hit2.includes('已截断'), '章节过长应截断')
  const toc2 = extractGuideSections(sample, '')
  assert(toc2.includes('章A') && toc2.includes('节3'), '空话题应返回标题树')
})

await test('open_file 媒体拦截端到端:引擎执行后 message parts 含 media(窗口内播放)', async () => {
  // 2026-08-08 用户"要播放视频,LLM 总说已开始播放但看不到气泡":
  // 完整引擎链路——mock LLM 调 open_file(视频)→ 引擎执行返回媒体附件
  // → 注入 msgParts → message 事件 parts 应含 {type:'media', kind:'video'}
  // 2026-08-09:媒体路径须真实存在(工具层先校验,不存在抛错)
  const e2eDir = path.join(tmp, 'media-e2e')
  await fs.mkdir(e2eDir, { recursive: true })
  const e2eVideo = path.join(e2eDir, 'clip.mp4')
  await fs.writeFile(e2eVideo, 'x')
  const messages: Array<{ parts: Array<{ type: string; kind?: string; url?: string }> }> = []
  const engine = createAgentEngine({
    getConfig: () => ({
      ...MOCK_PROVIDERS,
      apiKey: 'k',
      baseURL: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'high',
      systemPrompt: '',
      mcpServers: [],
      skillsDirs: [],
    }),
    onEvent: (event) => {
      if (event.type === 'message') messages.push(event.message as never)
    },
    onSwitchToMusic: () => {},
  })
  const origFetch = globalThis.fetch
  let count = 0
  globalThis.fetch = async (_url: string | URL | Request, _opts?: RequestInit) => {
    count++
    if (count === 1) {
      const args = JSON.stringify({ path: e2eVideo })
      return sseResponse([
        { type: 'response.created', response: { id: 'r1' } },
        { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'item_1', call_id: 'call_1', name: 'open_file', arguments: '' } },
        { type: 'response.function_call_arguments.done', item_id: 'item_1', arguments: args },
        { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'item_1', call_id: 'call_1', name: 'open_file', arguments: args } },
        { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 5 } } },
      ])
    }
    return sseResponse([
      { type: 'response.created', response: { id: 'r2' } },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'item_2' } },
      { type: 'response.output_text.delta', output_index: 0, delta: '好的' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'item_2' } },
      { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 5 } } },
    ])
  }
  try {
    engine.send('播放视频', [])
    await waitFor(() => messages.length >= 1 && !engine.busy, 10000, 'message 落定')
    const mediaParts = messages[0]?.parts?.filter((p) => p.type === 'media')
    assert(
      mediaParts && mediaParts.length === 1 && mediaParts[0].kind === 'video' && mediaParts[0].url === e2eVideo,
      `应注入 video media part,实际 ${JSON.stringify(messages[0]?.parts ?? null)}`,
    )
  } finally {
    globalThis.fetch = origFetch
    engine.dispose()
  }
})

await test('exec_command start 拦截端到端:引擎执行后 message parts 含 media', async () => {
  // 与上一条同链路,但 LLM 用 start 命令打开视频
  // 2026-08-09:start 解析的媒体路径须真实存在
  const e2eDir2 = path.join(tmp, 'media-e2e2')
  await fs.mkdir(e2eDir2, { recursive: true })
  const e2eVideo2 = path.join(e2eDir2, 'clip.mp4')
  await fs.writeFile(e2eVideo2, 'x')
  const messages: Array<{ parts: Array<{ type: string; kind?: string; url?: string }> }> = []
  const engine = createAgentEngine({
    getConfig: () => ({
      ...MOCK_PROVIDERS,
      apiKey: 'k',
      baseURL: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'high',
      systemPrompt: '',
      mcpServers: [],
      skillsDirs: [],
    }),
    onEvent: (event) => {
      if (event.type === 'message') messages.push(event.message as never)
    },
    onSwitchToMusic: () => {},
  })
  const origFetch = globalThis.fetch
  let count = 0
  globalThis.fetch = async (_url: string | URL | Request, _opts?: RequestInit) => {
    count++
    if (count === 1) {
      const args = JSON.stringify({ command: `start "" "${e2eVideo2}"` })
      return sseResponse([
        { type: 'response.created', response: { id: 'r1' } },
        { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'item_1', call_id: 'call_1', name: 'exec_command', arguments: '' } },
        { type: 'response.function_call_arguments.done', item_id: 'item_1', arguments: args },
        { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'item_1', call_id: 'call_1', name: 'exec_command', arguments: args } },
        { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 5 } } },
      ])
    }
    return sseResponse([
      { type: 'response.created', response: { id: 'r2' } },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'item_2' } },
      { type: 'response.output_text.delta', output_index: 0, delta: '好的' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'item_2' } },
      { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 5 } } },
    ])
  }
  try {
    engine.send('播放视频', [])
    await waitFor(() => messages.length >= 1 && !engine.busy, 10000, 'message 落定')
    const mediaParts = messages[0]?.parts?.filter((p) => p.type === 'media')
    assert(
      mediaParts && mediaParts.length === 1 && mediaParts[0].kind === 'video',
      `start 拦截应注入 video media part,实际 ${JSON.stringify(messages[0]?.parts ?? null)}`,
    )
  } finally {
    globalThis.fetch = origFetch
    engine.dispose()
  }
})

await test('bili 批量下载确认门:用户拒绝则不启动下载', async () => {
  // 2026-08-10 用户要求"批量下载首先要征得用户同意":download_up 经
  // confirmAction 确认,拒绝 = 不 spawn(返回拒绝文本,LLM 可告知用户)
  let confirmed = false
  const tools = createTools({
    onSwitchToMusic: () => {},
    confirmAction: async (title, detail) => {
      assert(title.includes('B站'), `确认标题应含 B站,实际:${title}`)
      assert(detail.includes('批量下载'), `确认详情应含批量下载,实际:${detail}`)
      return false
    },
  })
  const bili = tools.find((t) => t.name === 'bili')!
  const out = String(await bili.execute({ action: 'download_up', query: '12345', limit: 3 }))
  assert(out.includes('拒绝'), `应返回拒绝文本,实际:${out}`)
  assert(!confirmed, '不应启动下载')
  // 确认通过 → 进入后台启动路径(返回"已后台启动",spawn 失败是异步的
  // 不影响返回文本;证明确认通过后确实启动了下载而非被拦下)
  const tools2 = createTools({
    onSwitchToMusic: () => {},
    confirmAction: async () => true,
  })
  const bili2 = tools2.find((t) => t.name === 'bili')!
  const out2 = String(await bili2.execute({ action: 'download_up', query: '12345' }))
  assert(out2.includes('已后台启动'), `确认通过应启动下载,实际:${out2.slice(0, 80)}`)
})

await test('手动调用端到端:技能名+描述无空格分离 + DeepSeek reasoning 回传(400 回归)', async () => {
  // 2026-08-10 用户实测两个 bug 的端到端回归:
  // ① /skill_zhangxuefeng-perspective帮我调用(无空格)→ 前缀分离出工具名;
  // ② 手动调用后的 assistant 消息必须带 reasoning part(Responses thinking
  // 模式缺失回传 = 400 "reasoning_text must be passed back")
  // 真实创建技能目录(技能经 skillLoader 扫描注册,非 config 注入)
  const skillDir = path.join(tmp, 'skills-e2e', 'zhangxuefeng-perspective')
  await fs.mkdir(skillDir, { recursive: true })
  await fs.writeFile(
    path.join(skillDir, 'SKILL.md'),
    '---\nname: zhangxuefeng-perspective\ndescription: 张雪峰视角分析\n---\n用张雪峰的思维框架分析问题。',
  )
  const capturedBodies: string[] = []
  const engine = createAgentEngine({
    getConfig: () => ({
      ...MOCK_PROVIDERS,
      apiKey: 'k',
      baseURL: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'high',
      systemPrompt: '',
      mcpServers: [],
      skillsDirs: [path.join(tmp, 'skills-e2e')],
      excludedTools: [],
      excludedSkills: [],
    }),
    onEvent: () => {},
    onSwitchToMusic: () => {},
    getSkillDir: () => path.join(tmp, 'skills-e2e'),
    getMemoryStore: () => null,
    getEvolution: () => null,
  })
  const origFetch = globalThis.fetch
  globalThis.fetch = async (_url: string | URL | Request, opts?: RequestInit) => {
    capturedBodies.push(String(opts?.body ?? ''))
    return sseResponse([
      { type: 'response.created', response: { id: 'r1' } },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'item_1' } },
      { type: 'response.output_text.delta', output_index: 0, delta: '已按张雪峰视角分析' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'item_1' } },
      { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 5 } } },
    ])
  }
  try {
    engine.send('/skill_zhangxuefeng-perspective帮我调用', [])
    await waitFor(() => !engine.busy, 10000, '手动调用回合结束')
    // 断言:第一次请求(手动调用后的 LLM 回合)input 里必须含
    // reasoning item(手动 assistant 消息回传)与 function_call +
    // function_call_output(工具结果)——缺失 reasoning 正是 400 根因
    const body = JSON.parse(capturedBodies[0] ?? '{}') as { input?: Array<{ type?: string }> }
    const input = body.input ?? []
    assert(
      input.some((i) => i.type === 'reasoning'),
      `手动调用后首请求应含 reasoning item,实际:${JSON.stringify(input.map((i) => i.type))}`,
    )
    assert(
      input.some((i) => i.type === 'function_call') && input.some((i) => i.type === 'function_call_output'),
      '应含 function_call 与 function_call_output',
    )
    // 用户消息完整(含描述文字,LLM 可理解意图)
    const userItem = input.find((i) => i.type === 'message' && (i as { role?: string }).role === 'user') as
      | { content?: Array<{ text?: string }> }
      | undefined
    const userText = userItem?.content?.map((c) => c.text ?? '').join('') ?? ''
    assert(userText.includes('帮我调用'), `用户消息应含描述文字,实际:${userText}`)
  } finally {
    globalThis.fetch = origFetch
    engine.dispose()
  }
})

await test('fetchDeepseekBalance:结构化余额/Anthropic 拒绝/未配置 Key/HTTP 错误', async () => {
  const origFetch = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = async (url: string | URL | Request) => {
    urls.push(String(url))
    return new Response(
      JSON.stringify({
        is_available: true,
        balance_infos: [
          { currency: 'CNY', total_balance: '12.34', granted_balance: '2.00', topped_up_balance: '10.34' },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }
  try {
    const res = await fetchDeepseekBalance({
      baseURL: 'https://api.deepseek.com',
      apiKey: 'k',
    })
    assert(res.isAvailable === true, 'isAvailable 透传')
    assert(res.balances.length === 1, 'balances 数量')
    assert(
      res.balances[0]?.total === 12.34 && res.balances[0]?.toppedUp === 10.34 && res.balances[0]?.granted === 2,
      `余额字段解析,实际 ${JSON.stringify(res.balances[0])}`,
    )
    assert(urls[0]?.endsWith('/user/balance'), '应请求 /user/balance')
    // Anthropic 端点:直接抛错(不请求)
    await assertRejects(
      () => fetchDeepseekBalance({ baseURL: 'https://api.deepseek.com/anthropic', apiKey: 'k' }),
      'Anthropic 兼容端点',
      'Anthropic 端点应拒绝',
    )
    // 未配置 Key:抛错(不请求)
    await assertRejects(
      () => fetchDeepseekBalance({ baseURL: 'https://api.deepseek.com', apiKey: '  ' }),
      '尚未配置 API Key',
      '空 Key 应拒绝',
    )
    // HTTP 错误 → apiErrorMessage 可读文案
    globalThis.fetch = async () => new Response('{"error":{"message":"Insufficient Balance"}}', { status: 402 })
    await assertRejects(
      () => fetchDeepseekBalance({ baseURL: 'https://api.deepseek.com', apiKey: 'k' }),
      '余额不足',
      '402 应映射为余额不足',
    )
  } finally {
    globalThis.fetch = origFetch
  }
})

await test('余额查询工具:get_deepseek_balance 注册并格式化余额', async () => {
  const engine = createAgentEngine({
    getConfig: () => ({
      ...MOCK_PROVIDERS,
      apiKey: 'k',
      baseURL: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'high',
      systemPrompt: '',
      mcpServers: [],
      skillsDirs: [],
    }),
    onEvent: () => {},
    onSwitchToMusic: () => {},
  })
  const origFetch = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = async (url: string | URL | Request) => {
    urls.push(String(url))
    return new Response(
      JSON.stringify({
        is_available: true,
        balance_infos: [
          { currency: 'CNY', total_balance: '12.34', granted_balance: '2.00', topped_up_balance: '10.34' },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }
  try {
    const balanceTool = engine.listTools().find((t) => t.name === 'get_deepseek_balance')
    assert(balanceTool, '应注册 get_deepseek_balance')
    // 经手动调用路径执行(与用户实际使用一致)
    engine.send('@get_deepseek_balance', [])
    await waitFor(() => !engine.busy, 10000, '余额查询回合结束')
    assert(urls[0]?.endsWith('/user/balance'), `应请求 /user/balance,实际:${urls[0]}`)
    assert(urls[0]?.startsWith('https://api.deepseek.com'), `应请求 DeepSeek API,实际:${urls[0]}`)
  } finally {
    globalThis.fetch = origFetch
    engine.dispose()
  }
  // Anthropic 兼容端点:工具报错提示(不请求)
  const engine2 = createAgentEngine({
    getConfig: () => ({
      ...MOCK_PROVIDERS,
      apiKey: 'k',
      baseURL: 'https://api.deepseek.com/anthropic',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'high',
      systemPrompt: '',
      mcpServers: [],
      skillsDirs: [],
    }),
    onEvent: () => {},
    onSwitchToMusic: () => {},
  })
  const origFetch2 = globalThis.fetch
  const urls2: string[] = []
  globalThis.fetch = async (url: string | URL | Request) => {
    urls2.push(String(url))
    return sseResponse([{ type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } }])
  }
  try {
    engine2.send('@get_deepseek_balance', [])
    await waitFor(() => !engine2.busy, 10000, 'anthropic 端点余额回合结束')
    // 工具层 detectProvider 判定为 anthropic → 抛错(不请求余额);
    // 后续 fetch 是 LLM 循环的正常请求,只需断言没有 /user/balance
    assert(
      !urls2.some((u) => u.includes('/user/balance')),
      `Anthropic 端点不应请求余额接口,实际:${urls2.join(',')}`,
    )
  } finally {
    globalThis.fetch = origFetch2
    engine2.dispose()
  }
})

// ---------------------------------------------------------------------------
// 孤立代理清洗(2026-08-11 修复 400 "unexpected end of hex escape":
// 历史文本含孤立代理 → JSON.stringify 原样输出 \udXXX → 服务器
// serde_json 解析失败;发送端(请求体)与接收端(SSE 帧)都清洗)
// ---------------------------------------------------------------------------

console.log('\n=== 孤立代理清洗(sanitizeUnpairedSurrogates + 发送/接收端) ===')

/** 深度扫描对象树:是否存在孤立代理码元(服务器 strict JSON 会炸的形态) */
function scanLoneSurrogates(value: unknown): boolean {
  if (typeof value === 'string') {
    return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value)
  }
  if (Array.isArray(value)) return value.some(scanLoneSurrogates)
  if (value && typeof value === 'object') return Object.values(value).some(scanLoneSurrogates)
  return false
}

await test('sanitizeUnpairedSurrogates:孤立代理替换 U+FFFD,合法 emoji 保留', () => {
  // 孤立高代理(流式回复在 emoji 中间被截断的典型形态)
  assert(sanitizeUnpairedSurrogates('a\ud83db') === 'a�b', '孤立高代理应替换为 U+FFFD')
  // 孤立低代理
  assert(sanitizeUnpairedSurrogates('\ude00') === '�', '孤立低代理应替换为 U+FFFD')
  // 合法代理对(完整 emoji)不受影响
  assert(sanitizeUnpairedSurrogates('好😀啊') === '好😀啊', '完整代理对应原样保留')
  // 相邻孤立代理(两个半截 emoji)
  assert(sanitizeUnpairedSurrogates('😀') === '😀', '成对码元拼接后为合法 emoji')
  // 空串/普通文本
  assert(sanitizeUnpairedSurrogates('') === '' && sanitizeUnpairedSurrogates('plain') === 'plain', '普通文本不变')
})

await test('发送端:历史含孤立代理(用户消息/工具结果/reasoning)回传请求体无孤立代理', async () => {
  const origFetch = globalThis.fetch
  const capturedBodies: string[] = []
  globalThis.fetch = async (_url: string | URL | Request, opts?: RequestInit) => {
    capturedBodies.push(String(opts?.body ?? ''))
    return sseResponse([
      { type: 'response.created', response: { id: 'r1' } },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'item_1' } },
      { type: 'response.output_text.delta', output_index: 0, delta: '好的' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'item_1' } },
      { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 5 } } },
    ])
  }
  try {
    const engine = createAgentEngine({
      getConfig: () => ({ ...mockConfig, mcpServers: [], skillsDirs: [] }),
      onEvent: () => {},
      onSwitchToMusic: () => {},
      getSkillDir: () => path.join(tmp, 'skills-e2e'),
      getMemoryStore: () => null,
      getEvolution: () => null,
    })
    // 三种毒源:用户消息(粘贴文本)、工具结果(MCP/命令输出)、
    // assistant reasoning(截断回复)——都含孤立代理
    const history = [
      { id: 'm1', role: 'user' as const, parts: [{ type: 'text' as const, text: '帮我看看\ud83d这个' }] },
      {
        id: 'm2',
        role: 'assistant' as const,
        parts: [
          { type: 'reasoning' as const, text: '思考到一半截断\ud83d' },
          { type: 'text' as const, text: '好' },
          { type: 'tool-call' as const, id: 'call_1', name: 'exec_command', args: { cmd: 'echo hi' } },
        ],
      },
      {
        id: 'm3',
        role: 'user' as const,
        parts: [{ type: 'tool-result' as const, id: 'call_1', result: '输出末尾\ude00' }],
      },
    ]
    engine.send('继续', history as never)
    await waitFor(() => !engine.busy, 10000, '发送端清洗回合结束')
    assert(capturedBodies.length >= 1, '应捕获到请求体')
    // 原始请求体里不允许出现裸孤立代理转义(清洗后输出的是字面 �;
    // 高代理后必须跟 \u(低代理对),低代理前必须已有 \u 高代理)
    assert(
      !/\\u[dD][89aAbB][0-9a-fA-F]{2}(?![\\u])|(?<!\\u[dD][89aAbB][0-9a-fA-F]{2})\\u[dD][cCeEfF][0-9a-fA-F]{2}/.test(
        capturedBodies[0] ?? '',
      ),
      `请求体含裸孤立代理转义(服务器会报 unexpected end of hex escape):${(capturedBodies[0] ?? '').slice(-200)}`,
    )
    // 解析后的字符串也不该有孤立代理码元
    assert(
      !scanLoneSurrogates(JSON.parse(capturedBodies[0] ?? '{}')),
      '请求体解析后仍含孤立代理码元',
    )
  } finally {
    globalThis.fetch = origFetch
  }
})

await test('接收端:SSE delta 含孤立代理(截断回复)→ 事件文本已清洗且合法 emoji 保留', async () => {
  const origFetch = globalThis.fetch
  const received: string[] = []
  globalThis.fetch = async () => {
    return sseResponse([
      { type: 'response.created', response: { id: 'r1' } },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'item_1' } },
      // 完整 emoji + 后一帧在代理对中间截断(孤立高代理)
      { type: 'response.output_text.delta', output_index: 0, delta: '今天天气不错😀' },
      { type: 'response.output_text.delta', output_index: 0, delta: '，明天下雨\ud83d' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'item_1' } },
      { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 5 } } },
    ])
  }
  try {
    // 直测 streamResponse(不经引擎):onEvent 收到的 delta 必须干净
    const outcome = await streamResponse({
      config: mockConfig as never,
      system: 's',
      history: [],
      tools: [],
      signal: new AbortController().signal,
      onEvent: (e) => {
        if (e.type === 'text-delta') received.push(e.text)
      },
    })
    assert(received.length === 2, `应收到两段 delta,实际 ${received.length}`)
    assert(!received.some(scanLoneSurrogates), '转发的事件文本不得含孤立代理')
    assert(received[0]?.includes('😀') === true, '合法 emoji 应原样保留')
    assert(received[1]?.includes('�') === true, '截断的孤立代理应替换为 U+FFFD')
    assert(outcome.text.includes('😀') && !scanLoneSurrogates(outcome.text), '汇总文本同样干净')
  } finally {
    globalThis.fetch = origFetch
  }
})

// ---------------------------------------------------------------------------
// 9. 工具输出目录(2026-08-12:Agent 设置里配置输出根目录,所有工具产出
//    按 <根>/<工具名>/[<会话ID>] 分类——每工具文件夹分类、文件按对话
//     ID 分类;未配置保持默认位置)
// ---------------------------------------------------------------------------

console.log('\n=== 工具路径清单(buildToolsGuideBlock) ===')

await test('buildToolsGuideBlock:包含各工具绝对路径与用法', () => {
  const block = buildToolsGuideBlock()
  assert(block.includes('bili-tool.exe'), '应包含 bili-tool 二进制路径')
  assert(block.includes('DocFlow') && block.includes('server.py'), '应包含 DocFlow 服务')
  assert(block.includes('auto_answer.py') && block.includes('xxt'), '应包含 xxt 脚本路径')
  assert(block.includes('system-volume.ps1'), '应包含系统音量脚本')
  assert(block.includes('memory.json'), '应包含长期记忆文件')
  assert(block.includes('TECH.md'), '应包含功能引导文档')
  assert(block.includes('downloads'), '应包含 bili 下载目录')
  // 文案稳定(缓存前缀):两次调用结果一致
  assert(buildToolsGuideBlock() === block, '工具清单文案应稳定(不断缓存前缀)')
})

console.log('\n=== 工具输出目录(toolOutputDir / set_output_dir) ===')

await test('toolOutputDir:未注入输出目录环境 = null(保持默认位置)', async () => {
  // 新创建 createTools(未注入 getOutputDir)后 outputEnv 复位为默认 null
  createTools({ onSwitchToMusic: () => {} })
  assert(toolOutputDir('bili') === null, '未配置输出根目录应返回 null')
})

await test('toolOutputDir:根目录 + 会话 ID → 分类路径', async () => {
  createTools({
    onSwitchToMusic: () => {},
    getOutputDir: () => 'D:/agent-output',
    getSessionId: () => 's-123-abc',
  })
  assert(
    toolOutputDir('bili') === path.join('D:/agent-output', 'bili', 's-123-abc'),
    `bili 应落在 根/bili/会话ID,实际:${toolOutputDir('bili')}`,
  )
  assert(
    toolOutputDir('doc_convert') === path.join('D:/agent-output', 'doc_convert', 's-123-abc'),
    `doc_convert 应落在 根/doc_convert/会话ID,实际:${toolOutputDir('doc_convert')}`,
  )
  assert(
    toolOutputDir('xxt') === path.join('D:/agent-output', 'xxt', 's-123-abc'),
    `xxt 应落在 根/xxt/会话ID,实际:${toolOutputDir('xxt')}`,
  )
})

await test('toolOutputDir:有根目录无会话 ID → 落在 根/工具名(不带会话层)', async () => {
  createTools({
    onSwitchToMusic: () => {},
    getOutputDir: () => 'D:/agent-output',
    getSessionId: () => null,
  })
  assert(
    toolOutputDir('bili') === path.join('D:/agent-output', 'bili'),
    `无会话 ID 应回退 根/工具名,实际:${toolOutputDir('bili')}`,
  )
})

await test('bili download_up:配置输出目录 → 后台任务带 --outdir 根/bili/会话ID', async () => {
  const tools = createTools({
    onSwitchToMusic: () => {},
    confirmAction: async () => true,
    getOutputDir: () => 'D:/agent-output',
    getSessionId: () => 's-456-xyz',
  })
  const bili = tools.find((t) => t.name === 'bili')!
  const out = String(await bili.execute({ action: 'download_up', query: '12345' }))
  const expected = path.join('D:/agent-output', 'bili', 's-456-xyz')
  assert(out.includes(expected), `后台任务应带输出目录 ${expected},实际:${out.slice(0, 200)}`)
  // LLM 显式传 outdir 恒优先于配置的根目录
  const out2 = String(
    await bili.execute({ action: 'download_up', query: '12345', outdir: 'E:/custom' }),
  )
  assert(out2.includes('E:/custom'), `显式 outdir 应优先,实际:${out2.slice(0, 200)}`)
})

await test('set_output_dir:get 查当前值 / set 写配置(经 updateAgentConfig)', async () => {
  const { state, writes, tools } = makeConfigToolsDeps()
  const dir = tools.find((t) => t.name === 'set_output_dir')!
  // 未配置 → get 提示未设置
  const getNone = String(await dir.execute({ action: 'get' }))
  assert(getNone.includes('未设置'), `未配置时 get 应提示未设置,实际:${getNone}`)
  // set → 写配置
  const setOut = String(await dir.execute({ action: 'set', dir: 'D:/agent-output' }))
  assert(setOut.includes('D:/agent-output'), `set 应回显目录,实际:${setOut}`)
  assert(writes.at(-1)?.outputDir === 'D:/agent-output', 'updateAgentConfig 应收到 outputDir 补丁')
  assert(state.config.outputDir === 'D:/agent-output', 'state 应同步 outputDir')
  // 已配置 → get 回显目录与目录结构说明
  const getSet = String(await dir.execute({ action: 'get' }))
  assert(getSet.includes('D:/agent-output'), `已配置时 get 应回显目录,实际:${getSet}`)
  // 空串 = 恢复默认位置
  const resetOut = String(await dir.execute({ action: 'set', dir: '' }))
  assert(resetOut.includes('恢复默认'), `空串应恢复默认,实际:${resetOut}`)
  assert(writes.at(-1)?.outputDir === '', '恢复默认应写空 outputDir')
})

// ---------------------------------------------------------------------------
// 10. NapCat QQ 机器人(2026-08-12)
// ---------------------------------------------------------------------------

console.log('\n=== NapCat QQ 机器人(napcat 工具 / set_napcat_config / 消息解析) ===')

await test('napcatMessageText:string 与段数组解析', () => {
  assert(napcatMessageText('你好') === '你好', 'string 原样')
  assert(
    napcatMessageText([
      { type: 'text', data: { text: '你好' } },
      { type: 'face', data: { id: '1' } },
      { type: 'image', data: { file: 'a.png' } },
    ]) === '你好[face][图片]',
    '段数组:text 拼接 + face 标注 + 图片标注',
  )
  assert(napcatMessageText(null) === '', '空返回空串')
})

await test('napcat 工具:status/recent 格式化,send/send_group 校验与透传', async () => {
  const calls: Array<{ kind: 'qq' | 'group'; target: string; text: string }> = []
  const contactWrites: Array<{ qq: string; name?: string; info?: string }> = []
  let contacts: Record<string, { qq: string; name?: string; info?: string; source?: 'private' | 'group'; updatedAt: number }> = {}
  const tools = napcatTools({
    status: () => ({ connected: true, url: 'ws://127.0.0.1:3001', lastError: '', receivedCount: 3, repliedCount: 2 }),
    sendToQQ: async (qq, text) => {
      calls.push({ kind: 'qq', target: qq, text })
      return 'msg-1'
    },
    sendToGroup: async (groupId, text) => {
      calls.push({ kind: 'group', target: groupId, text })
      return 'msg-2'
    },
    getRecentMessages: () => [
      { qq: '10001', text: '你好', messageId: 'm1', time: 1700000000, replied: true },
      { qq: '10002', text: '在吗', messageId: 'm2', time: 1700000000 },
    ],
    getContacts: async () => contacts,
    updateContact: async (patch) => {
      contactWrites.push({ qq: patch.qq, name: patch.name, info: patch.info })
      const next = {
        qq: patch.qq,
        name: patch.name,
        info: patch.info,
        source: patch.source,
        updatedAt: 1700000000,
      }
      contacts = { ...contacts, [patch.qq]: next }
      return next
    },
  })
  const tool = tools.find((t) => t.name === 'napcat')!
  assert(tool !== undefined, 'napcat 工具应注册')
  // 2026-08-14:file 发视频上传可达 180s,必须声明工具级 timeoutMs 覆盖
  // 引擎 60s 兜底超时——否则 QQ 实际收到了但工具报超时,LLM 误报没发成功
  assert((tool.timeoutMs ?? 0) >= 200_000, `napcat 工具应声明 >=200s 的 timeoutMs(覆盖上传),实际:${tool.timeoutMs}`)
  const status = String(await tool.execute({ action: 'status' }))
  assert(status.includes('已连接') && status.includes('3 条') && status.includes('2 条'), `status 应含连接与统计,实际:${status}`)
  const recent = String(await tool.execute({ action: 'recent' }))
  assert(recent.includes('10001') && recent.includes('[已回复]') && recent.includes('10002'), `recent 应列消息与回复标记,实际:${recent}`)
  const send = String(await tool.execute({ action: 'send', user_id: '10001', message: '下载完成' }))
  assert(calls.length === 1 && calls[0].kind === 'qq' && calls[0].target === '10001' && calls[0].text === '下载完成', 'send 应透传 QQ 号与文本')
  assert(send.includes('msg-1'), `send 应回显 message_id,实际:${send}`)
  const sendGroup = String(await tool.execute({ action: 'send_group', group_id: '20000', message: '大家好' }))
  const n: number = calls.length
  assert(n === 2 && calls[1].kind === 'group' && calls[1].target === '20000', 'send_group 应透传群号')
  assert(sendGroup.includes('msg-2'), `send_group 应回显 message_id,实际:${sendGroup}`)
  // send_group 带文件(2026-08-12:下载好的文件直接发群里)
  const sendFile = String(
    await tool.execute({ action: 'send_group', group_id: '20000', message: '关羽之歌下载好了', file: 'D:/music/关羽之歌.mp3' }),
  )
  const n2: number = calls.length
  assert(n2 === 3 && calls[2].target === '20000' && calls[2].text === '关羽之歌下载好了', 'send_group file 应透传群号与文本')
  assert(sendFile.includes('含文件'), `send_group 带文件应回显,实际:${sendFile}`)
  await assertRejects(() => tool.execute({ action: 'send', message: '缺 QQ 号' }), 'send 需要 user_id')
  await assertRejects(() => tool.execute({ action: 'send', user_id: '1' }), 'send 需要 message')
  await assertRejects(() => tool.execute({ action: 'send_group', message: '缺群号' }), 'send_group 需要 group_id')
})

await test('napcat 工具:send/send_group 缺省目标 = 当前会话对象(2026-08-13 指向性)', async () => {
  const calls: Array<{ kind: 'qq' | 'group'; target: string; text: string }> = []
  let sessionKey: string | null = 'private:222'
  const tools = napcatTools(
    {
      status: () => ({ connected: true, url: '', lastError: '', receivedCount: 0, repliedCount: 0 }),
      sendToQQ: async (qq, text) => {
        calls.push({ kind: 'qq', target: qq, text })
        return 'm1'
      },
      sendToGroup: async (groupId, text) => {
        calls.push({ kind: 'group', target: groupId, text })
        return 'm2'
      },
      getRecentMessages: () => [],
      getContacts: async () => ({}),
      updateContact: async (p) => ({ qq: p.qq, updatedAt: 0 }),
    },
    { getSessionKey: () => sessionKey },
  )
  const tool = tools.find((t) => t.name === 'napcat')!
  // 私聊会话:send 不传 user_id → 默认发给当前会话对象("发消息给他"直落到位)
  const r1 = String(await tool.execute({ action: 'send', message: '发消息给他' }))
  const n1: number = calls.length
  assert(
    n1 === 1 && calls[0].kind === 'qq' && calls[0].target === '222' && calls[0].text === '发消息给他',
    `私聊会话缺省应发当前会话对象,实际:${JSON.stringify(calls)}`,
  )
  assert(r1.includes('222'), `应回显目标 QQ,实际:${r1}`)
  // 群会话:send_group 不传 group_id → 默认发当前会话群
  sessionKey = 'group:999'
  const r2 = String(await tool.execute({ action: 'send_group', message: '发到群里' }))
  const n2: number = calls.length
  assert(n2 === 2 && calls[1].kind === 'group' && calls[1].target === '999', `群会话缺省应发当前会话群,实际:${JSON.stringify(calls)}`)
  assert(r2.includes('999'), `应回显目标群,实际:${r2}`)
  // 群会话里 send(私聊)无对应缺省 → 报错提示(LLM 可自纠)
  await assertRejects(() => tool.execute({ action: 'send', message: 'x' }), 'send 需要 user_id')
  // 主对话 / 无会话:无缺省 → 报错
  sessionKey = 'main'
  await assertRejects(() => tool.execute({ action: 'send', message: 'x' }), 'send 需要 user_id')
  await assertRejects(() => tool.execute({ action: 'send_group', message: 'x' }), 'send_group 需要 group_id')
  sessionKey = null
  await assertRejects(() => tool.execute({ action: 'send', message: 'x' }), 'send 需要 user_id')
  // 显式 user_id 仍优先于缺省
  sessionKey = 'private:222'
  await tool.execute({ action: 'send', user_id: '333', message: '显式目标' })
  const n3: number = calls.length
  assert(n3 === 3 && calls[2].target === '333', '显式 user_id 应优先于会话缺省')
  await assertRejects(() => tool.execute({ action: 'send_group', group_id: '1' }), 'send_group 需要 message/file/image 至少一个')
  await assertRejects(() => tool.execute({ action: 'nope' }), '未知action')
})

await test('napcat 工具:send/send_group 带图片与私聊文件透传', async () => {
  // 工具层会校验本地路径存在——用临时目录里真实创建的文件测透传
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'napcat-img-'))
  const imgPath = path.join(tmpDir, 'x.png')
  const imgPath2 = path.join(tmpDir, 'y.png')
  const filePath = path.join(tmpDir, 'x.mp3')
  await fs.writeFile(imgPath, 'i')
  await fs.writeFile(imgPath2, 'i')
  await fs.writeFile(filePath, 'm')
  const qqCalls: Array<{ qq: string; text: string; image?: string; file?: string }> = []
  const groupCalls: Array<{ groupId: string; text: string; file?: string; image?: string }> = []
  const tools = napcatTools({
    status: () => ({ connected: true, url: 'ws://127.0.0.1:3001', lastError: '', receivedCount: 0, repliedCount: 0 }),
    sendToQQ: async (qq, text, opts) => {
      qqCalls.push({ qq, text, image: opts?.image, file: opts?.file })
      return 'qq-img'
    },
    sendToGroup: async (groupId, text, filePath2, image) => {
      groupCalls.push({ groupId, text, file: filePath2, image })
      return 'group-img'
    },
    getRecentMessages: () => [],
    getContacts: async () => ({}),
    updateContact: async (p) => ({ qq: p.qq, source: p.source, updatedAt: 0 }),
  })
  const tool = tools.find((t) => t.name === 'napcat')!
  // send 带本地图片:透传 image(工具层校验路径存在通过)
  const r1 = String(await tool.execute({ action: 'send', user_id: '10001', message: '看图', image: imgPath }))
  const n1: number = qqCalls.length
  assert(n1 === 1 && qqCalls[0].image === imgPath, 'send 应透传 image')
  assert(r1.includes('含图片'), `send 带图应回显,实际:${r1}`)
  // send 带 URL 图片(http(s) 不校验存在直接放行)
  const r2 = String(await tool.execute({ action: 'send', user_id: '10001', message: '链接图', image: 'https://example.com/a.png' }))
  const n2: number = qqCalls.length
  assert(n2 === 2 && qqCalls[1].image === 'https://example.com/a.png', 'send 应透传 http(s) 图片链接')
  void r2
  // send 带文件(私聊发文件,2026-08-12)
  const r3 = String(await tool.execute({ action: 'send', user_id: '10001', message: '文件', file: filePath }))
  const n3: number = qqCalls.length
  assert(n3 === 3 && qqCalls[2].file === filePath, 'send 应透传 file')
  assert(r3.includes('含文件'), `send 带文件应回显,实际:${r3}`)
  // send_group 带图片
  const r4 = String(await tool.execute({ action: 'send_group', group_id: '20000', message: '群图', image: imgPath2 }))
  const n4: number = groupCalls.length
  assert(n4 === 1 && groupCalls[0].image === imgPath2, 'send_group 应透传 image')
  assert(r4.includes('含图片'), `send_group 带图应回显,实际:${r4}`)
  // 本地路径图片不存在 → 报错(LLM 可自纠)
  await assertRejects(() => tool.execute({ action: 'send', user_id: '10001', image: path.join(tmpDir, 'missing.png') }), '图片不存在')
  // send_group 本地路径图片不存在 → 同样报错
  await assertRejects(() => tool.execute({ action: 'send_group', group_id: '1', image: path.join(tmpDir, 'missing.png') }), '图片不存在')
  // 什么都不给 → 报错
  await assertRejects(() => tool.execute({ action: 'send', user_id: '10001' }), 'send 需要 message')
  await fs.rm(tmpDir, { recursive: true, force: true })
})

await test('napcat 工具:recall / members(自动补档案) / friends / profile / group_info / group_manage', async () => {
  const recalled: string[] = []
  const banned: Array<{ groupId: string; qq: string; duration: number }> = []
  const kicked: Array<{ groupId: string; qq: string }> = []
  const wholeBans: Array<{ groupId: string; enable: boolean }> = []
  const nameMerges: Array<{ qq: string; name?: string }> = []
  const tools = napcatTools({
    status: () => ({ connected: true, url: 'ws://127.0.0.1:3001', lastError: '', receivedCount: 0, repliedCount: 0 }),
    sendToQQ: async () => '',
    sendToGroup: async () => '',
    getRecentMessages: () => [],
    getContacts: async () => ({}),
    updateContact: async (p) => ({ qq: p.qq, source: p.source, updatedAt: 0 }),
    recallMessage: async (messageId) => {
      recalled.push(messageId)
    },
    mergeContactNames: async (entries) => {
      for (const e of entries) nameMerges.push({ qq: e.qq, name: e.name })
    },
    getGroupMembers: async () => [
      { user_id: '20001', nickname: '群友A', card: '阿A' },
      { user_id: '20002', nickname: '群友B' },
      { user_id: '20003' },
    ],
    getFriendList: async () => [
      { user_id: '30001', nickname: '好友X', remark: '老X' },
      { user_id: '30002', nickname: '好友Y' },
    ],
    getStrangerInfo: async () => ({ nickname: '神秘人', age: 25, sex: 'male' }),
    getGroupInfo: async () => ({ groupName: '测试群', memberCount: 42 }),
    setGroupBan: async (groupId, qq, duration) => {
      banned.push({ groupId, qq, duration })
    },
    setGroupKick: async (groupId, qq) => {
      kicked.push({ groupId, qq })
    },
    setGroupWholeBan: async (groupId, enable) => {
      wholeBans.push({ groupId, enable })
    },
  })
  const tool = tools.find((t) => t.name === 'napcat')!
  // 撤回
  const rRecall = String(await tool.execute({ action: 'recall', message_id: 'm-42' }))
  assert(recalled.length === 1 && recalled[0] === 'm-42', 'recall 应透传 message_id')
  assert(rRecall.includes('已撤回'), `recall 应回显,实际:${rRecall}`)
  await assertRejects(() => tool.execute({ action: 'recall' }), 'recall 需要 message_id')
  // 群成员 + 自动补档案(群名片优先)
  const rMembers = String(await tool.execute({ action: 'members', group_id: '20000' }))
  assert(
    rMembers.includes('20001') && rMembers.includes('阿A') && rMembers.includes('20002') && rMembers.includes('20003'),
    `members 应列成员与昵称,实际:${rMembers}`,
  )
  assert(nameMerges.length === 3 && nameMerges[0].name === '阿A' && nameMerges[1].name === '群友B', 'members 应自动补档案(群名片优先)')
  await assertRejects(() => tool.execute({ action: 'members' }), 'members 需要 group_id')
  // 好友列表
  const rFriends = String(await tool.execute({ action: 'friends' }))
  assert(rFriends.includes('30001') && rFriends.includes('老X') && rFriends.includes('30002'), `friends 应列好友,实际:${rFriends}`)
  // 资料查询
  const rProfile = String(await tool.execute({ action: 'profile', user_id: '40001' }))
  assert(rProfile.includes('40001') && rProfile.includes('神秘人') && rProfile.includes('25'), `profile 应含资料,实际:${rProfile}`)
  await assertRejects(() => tool.execute({ action: 'profile' }), 'profile 需要 user_id')
  // 群信息
  const rInfo = String(await tool.execute({ action: 'group_info', group_id: '20000' }))
  assert(rInfo.includes('测试群') && rInfo.includes('42'), `group_info 应含群信息,实际:${rInfo}`)
  await assertRejects(() => tool.execute({ action: 'group_info' }), 'group_info 需要 group_id')
  // 群管理:禁言 / 解除(duration 0)/ 踢人 / 全员禁言
  const rBan = String(await tool.execute({ action: 'group_manage', group_id: '20000', op: 'ban', user_id: '20001', duration: 600 }))
  const banN: number = banned.length
  assert(banN === 1 && banned[0].duration === 600 && rBan.includes('600秒'), `ban 应透传时长,实际:${rBan}`)
  const rUnban = String(await tool.execute({ action: 'group_manage', group_id: '20000', op: 'ban', user_id: '20001', duration: 0 }))
  const unbanN: number = banned.length
  assert(unbanN === 2 && banned[1].duration === 0 && rUnban.includes('解除'), `unban(duration 0)应透传,实际:${rUnban}`)
  const rKick = String(await tool.execute({ action: 'group_manage', group_id: '20000', op: 'kick', user_id: '20002' }))
  const kickN: number = kicked.length
  assert(kickN === 1 && kicked[0].qq === '20002' && rKick.includes('移出'), `kick 应透传,实际:${rKick}`)
  const rWhole = String(await tool.execute({ action: 'group_manage', group_id: '20000', op: 'whole_ban', enable: true }))
  const wholeN: number = wholeBans.length
  assert(wholeN === 1 && wholeBans[0].enable === true && rWhole.includes('全员禁言'), `whole_ban 应透传,实际:${rWhole}`)
  const rWholeOff = String(await tool.execute({ action: 'group_manage', group_id: '20000', op: 'whole_ban', enable: false }))
  const wholeOffN: number = wholeBans.length
  assert(wholeOffN === 2 && wholeBans[1].enable === false && rWholeOff.includes('解除'), `whole_ban 关闭应透传,实际:${rWholeOff}`)
  // 参数校验
  await assertRejects(() => tool.execute({ action: 'group_manage', group_id: '1', op: 'ban' }), 'ban 需要 user_id')
  await assertRejects(() => tool.execute({ action: 'group_manage', group_id: '1', op: 'ban', user_id: '2' }), 'ban 需要 duration')
  await assertRejects(() => tool.execute({ action: 'group_manage', group_id: '1', op: 'nope' }), 'op 仅支持')
  await assertRejects(() => tool.execute({ action: 'group_manage', group_id: '1' }), 'group_manage 需要 op')
  await assertRejects(() => tool.execute({ action: 'group_manage', group_id: '1', op: 'whole_ban' }), 'whole_ban 需要 enable')
})

await test('napcatMessageImages:图片段提取(收图链路)', () => {
  assert(napcatMessageImages(null).length === 0, 'null 无图片')
  assert(napcatMessageImages('文本').length === 0, 'string 无图片')
  const imgs = napcatMessageImages([
    { type: 'text', data: { text: '看这个' } },
    { type: 'image', data: { file: 'abc.image', url: 'https://gimg2.baidu.com/x.png' } },
    { type: 'image', data: { file: 'def.image' } },
    { type: 'face', data: { id: '1' } },
  ])
  assert(imgs.length === 2, `应提取 2 张图片,实际 ${imgs.length}`)
  assert(imgs[0].file === 'abc.image' && imgs[0].url === 'https://gimg2.baidu.com/x.png', '第一张应带 file 与 url')
  assert(imgs[1].file === 'def.image' && imgs[1].url === undefined, '第二张应只带 file')
  assert(napcatMessageImages([{ type: 'text', data: { text: 'x' } }]).length === 0, '纯文本段无图片')
})

await test('stripNapcat 双通道:显示剥离档案卡/历史保留档案卡(消息隔离)', () => {
  // 2026-08-13 用户澄清"档案卡与消息分类是给历史消息隔离的":
  // 显示层剥离一切指令段(档案卡经 profileCard 字段展示,不重复);
  // 历史回传保留【档案卡】(LLM 跨轮次区分人),只剥当轮指令段
  const msg =
    '【QQ私聊 · QQ 1536057397 · 魔精】你好\n' +
    '【图片已下载】1. D:/x.png\n' +
    '【档案卡】\n称呼:魔精\n已知:喜欢王者/KPL\n' +
    '【回复规则】\n① 岛灵的主人 = QQ 10000(唯一,privacy.json 配置);当前对方不是主人。\n② 你的回复就是直接发给对方的话…'
  // 显示剥离:档案卡与回复规则都去掉,保留类别行 + 原文 + 图片行
  const shown = stripNapcatInstructions(msg)
  assert(shown.startsWith('【QQ私聊 · QQ 1536057397 · 魔精】你好'), `显示应保留类别行与原文,实际:${shown.slice(0, 40)}`)
  assert(!shown.includes('档案卡') && !shown.includes('回复规则'), '显示应剥离档案卡与回复规则')
  assert(shown.includes('【图片已下载】'), '图片标注应保留')
  // 历史剥离:档案卡保留,回复规则剥离(当轮指令不累积)
  const hist = stripNapcatHistoryInstructions(msg)
  assert(hist.includes('【档案卡】') && hist.includes('称呼:魔精') && hist.includes('已知:喜欢王者/KPL'), `历史应保留档案卡,实际:${hist.slice(0, 60)}`)
  assert(!hist.includes('回复规则') && !hist.includes('岛灵的主人'), '历史应剥离回复规则')
  // 旧格式兼容:【私聊指令】/【群聊指令】/【主人消息】两函数都剥
  const old = '【QQ 123 发来私聊消息】你好\n【私聊指令】先问主人再回复'
  assert(stripNapcatInstructions(old) === '【QQ 123 发来私聊消息】你好', '显示剥离旧私聊指令')
  assert(stripNapcatHistoryInstructions(old) === '【QQ 123 发来私聊消息】你好', '历史剥离旧私聊指令')
  // 群聊模板:【群聊上下文】与【回复规则】剥,档案卡留(历史)
  const group =
    '【QQ群聊 · 群 20000 · QQ 20001】消息\n【档案卡】\n称呼:群友\n【回复规则】\n① …\n最近群聊记录:\n20001: 你好'
  assert(stripNapcatHistoryInstructions(group).includes('称呼:群友') && !stripNapcatHistoryInstructions(group).includes('最近群聊记录'), '群聊历史保留档案卡剥规则与群上下文')
  // 空输入
  assert(stripNapcatInstructions('') === '' && stripNapcatHistoryInstructions('  ') === '', '空输入返回空')
})

await test('extractReplyToStranger:执行回复标记判定(串台根治,2026-08-13 回归)', () => {
  // 用户实测"串台后陌生人收不到消息":只有带标记的回复才路由给
  // 待回复陌生人并消费 pending;无标记回复留在主人侧且 pending 保留
  const marked = extractReplyToStranger('【回复对方】哼,刚认识就要赶人家走')
  assert(marked === '哼,刚认识就要赶人家走', `标记应剥离且保留正文,实际:${marked}`)
  assert(extractReplyToStranger('【回复对方】') === '', '仅标记无正文应返回空串')
  assert(extractReplyToStranger('好的主人,我知道了') === null, '无标记回复应返回 null(留在主人侧)')
  assert(extractReplyToStranger('嗯,让我想想') === null, '主人应答不应触发路由')
  assert(extractReplyToStranger('回复对方:你好') === null, '不含标记格式(缺【】)不触发')
  assert(REPLY_TO_STRANGER_MARK === '【回复对方】', '标记常量一致')
})

await test('sessionKeyFor / isValidSessionKey:会话键(会话隔离,2026-08-13)', () => {
  assert(sessionKeyFor('10000') === 'private:10000', '私聊键')
  assert(sessionKeyFor('20001', '20000') === 'group:20000', '群聊键')
  assert(isValidSessionKey('private:1536057397'), '合法私聊键')
  assert(isValidSessionKey('group:20000'), '合法群聊键')
  assert(!isValidSessionKey('main'), 'main 不是外部会话键(mutedSessions 校验拒收)')
  assert(!isValidSessionKey('private:abc'), '非法 QQ 号拒收')
  assert(!isValidSessionKey('../etc/passwd'), '路径穿越拒收')
  assert(!isValidSessionKey('group:20000;rm -rf'), '注入拒收')
})

await test('turnAlreadySentToPending:防重发判定(对方收到 2-3 条,2026-08-13 回归)', () => {
  // 本轮开始前快照 before = 0;本轮中 LLM 已用 send 工具发过 1 条 → 跳过路由
  const sent = [
    { type: 'private', target: '1536057397' },
    { type: 'group', target: '20000' },
  ]
  assert(turnAlreadySentToPending(sent, 0, '1536057397') === true, '本轮已发过 → 跳过 pending 路由')
  assert(turnAlreadySentToPending(sent, 0, '20002') === false, '未发给该陌生人 → 照常路由')
  assert(turnAlreadySentToPending(sent, 1, '1536057397') === false, '快照已含该条(本轮未新发)→ 照常路由')
  assert(turnAlreadySentToPending(sent, 1, '20000') === false, '群消息不计入私聊防重发')
})

await test('napcat 工具 sessions/session_mute/session_bind:sessions 直查列表,mute/bind 引导 manage_sessions(2026-08-14)', async () => {
  // 2026-08-13 旧版在 napcat 工具内直接实现会话管理;2026-08-14 起增删
  // 监听/屏蔽/绑定迁到 manage_sessions 工具(main.cjs 注入实现);
  // sessions action 改为直查列表(未注入 listSessions 时回空列表引导)
  const tools = napcatTools({
    status: () => ({ connected: false, url: '', lastError: '', receivedCount: 0, repliedCount: 0 }),
    sendToQQ: async () => '',
    sendToGroup: async () => '',
    getRecentMessages: () => [],
    getContacts: async () => ({}),
    updateContact: async (p) => ({ qq: p.qq, source: p.source, updatedAt: 0 }),
  })
  const napcatTool = tools.find((t) => t.name === 'napcat')!
  const sessionsOut = String(await napcatTool.execute({ action: 'sessions' }))
  assert(sessionsOut.includes('manage_sessions'), `sessions 空列表应引导到 manage_sessions,实际:${sessionsOut}`)
  const muteOut = String(await napcatTool.execute({ action: 'session_mute', key: 'private:1' }))
  assert(muteOut.includes('manage_sessions'), `session_mute 应引导到 manage_sessions,实际:${muteOut}`)
  const bindOut = String(await napcatTool.execute({ action: 'session_bind', key: 'group:1' }))
  assert(bindOut.includes('manage_sessions'), `session_bind 应引导到 manage_sessions,实际:${bindOut}`)
})

await test('manage_sessions 工具:list/watch/unwatch/mute/bind 直接新建监听会话(2026-08-14)', async () => {
  // 用户要求"灵动岛设置工具支持接入会话面板,LLM 直接将监听会话在
  // 会话面板中新建":watch 写监听名单(主进程广播种子 → 面板立即建
  // 条目);list/mute/unmute/bind 透传 client 会话管理回调
  const calls: Array<unknown[]> = []
  const tools = napcatTools({
    status: () => ({ connected: false, url: '', lastError: '', receivedCount: 0, repliedCount: 0 }),
    listSessions: () => [
      { key: 'private:1536057397', title: '魔精', kind: 'private' as const, muted: false },
      { key: 'group:20000', title: '群 20000', kind: 'group' as const, muted: true },
    ],
    muteSession: (key: string, muted: boolean) => calls.push(['mute', key, muted]),
    bindSession: (key: string) => calls.push(['bind', key]),
    watchSession: (kind: string, id: string) => calls.push(['watch', kind, id]),
    unwatchSession: (kind: string, id: string) => calls.push(['unwatch', kind, id]),
  })
  const tool = tools.find((t) => t.name === 'manage_sessions')
  assert(!!tool, 'manage_sessions 工具应注册')
  // list:列表 + 屏蔽标记
  const list = String(await tool!.execute({ action: 'list' }))
  assert(list.includes('private:1536057397') && list.includes('魔精'), `list 应含会话条目,实际:${list}`)
  assert(list.includes('[已屏蔽]'), `屏蔽会话应带标记,实际:${list}`)
  // watch 私聊/群:回调透传 + 成功文案
  const watchPrivate = String(await tool!.execute({ action: 'watch', kind: 'private', id: '123456' }))
  assert(watchPrivate.includes('监听名单'), `watch 应回报成功,实际:${watchPrivate}`)
  assert(calls.some((c) => c[0] === 'watch' && c[1] === 'private' && c[2] === '123456'), 'watch 私聊应透传 watchSession')
  const watchGroup = String(await tool!.execute({ action: 'watch', kind: 'group', id: '987654' }))
  assert(watchGroup.includes('群 987654'), `watch 群应带群号,实际:${watchGroup}`)
  assert(calls.some((c) => c[0] === 'watch' && c[1] === 'group' && c[2] === '987654'), 'watch 群应透传 watchSession')
  // 参数校验:非数字 id / 缺 kind / 非法 key
  await assertRejects(() => tool!.execute({ action: 'watch', kind: 'private', id: 'abc' }), 'id', '非数字 id 应拒绝')
  await assertRejects(() => tool!.execute({ action: 'watch', id: '123' }), 'kind', '缺 kind 应拒绝')
  await assertRejects(() => tool!.execute({ action: 'mute', key: 'bad' }), 'key', '非法会话键应拒绝')
  // mute/unmute/bind 透传
  const muteOut = String(await tool!.execute({ action: 'mute', key: 'private:123456' }))
  assert(muteOut.includes('屏蔽'), `mute 应回报成功,实际:${muteOut}`)
  assert(calls.some((c) => c[0] === 'mute' && c[1] === 'private:123456' && c[2] === true), 'mute 应透传 muteSession(true)')
  const unmuteOut = String(await tool!.execute({ action: 'unmute', key: 'private:123456' }))
  assert(unmuteOut.includes('解除'), `unmute 应回报成功,实际:${unmuteOut}`)
  const unwatchOut = String(await tool!.execute({ action: 'unwatch', kind: 'group', id: '987654' }))
  assert(unwatchOut.includes('移出'), `unwatch 应回报成功,实际:${unwatchOut}`)
  assert(calls.some((c) => c[0] === 'unwatch' && c[1] === 'group' && c[2] === '987654'), 'unwatch 应透传 unwatchSession')
  const bindOut = String(await tool!.execute({ action: 'bind', key: 'main' }))
  assert(bindOut.includes('打开'), `bind 应回报成功,实际:${bindOut}`)
  assert(calls.some((c) => c[0] === 'bind' && c[1] === 'main'), 'bind 应透传 bindSession')
  // 未知 action 拒绝
  await assertRejects(() => tool!.execute({ action: 'nope' }), '仅支持', '未知 action 应拒绝')
})

await test('buildProfileCard:档案卡聚合(联系人/人格/记忆相关/空档案)', () => {
  // 2026-08-13 用户要求"将不同 QQ 号的所有涉及发言汇总成一个档案卡":
  // 称呼 + 已知信息 + 会话人格 + 长期记忆相关条目(按 QQ 号/称呼过滤)
  const full = buildProfileCard('1536057397', {
    contact: { qq: '1536057397', name: '魔精', info: '喜欢王者/KPL,可玩KPL梗', source: 'private', updatedAt: 1 },
    persona: '毒舌傲娇',
    memories: [
      { content: '魔精(QQ 1536057397)是私聊白名单成员,喜欢王者/KPL' },
      { content: '与本题无关的普通记忆' },
      { content: '魔精今晚约了打王者' },
    ],
  })
  assert(full.includes('称呼:魔精'), `应有称呼,实际:${full}`)
  assert(full.includes('已知:喜欢王者/KPL'), '应有已知信息')
  assert(full.includes('会话人格:毒舌傲娇'), '应有会话人格')
  assert(full.includes('记忆相关:'), '应有记忆相关段')
  assert(full.includes('魔精(QQ 1536057397)') && full.includes('魔精今晚约了打王者'), '记忆应按 QQ 号/称呼过滤')
  assert(!full.includes('与本题无关的普通记忆'), '无关记忆不应进档案卡')
  // 记忆相关最多 4 条
  const many = buildProfileCard('1', {
    memories: Array.from({ length: 6 }, (_, i) => ({ content: `QQ 1 相关记忆 ${i}` })),
  })
  assert((many.match(/相关记忆/g) ?? []).length <= 4, '记忆相关条目应截断到 4 条')
  // 空档案:只有称呼行 → 兜底提示
  const empty = buildProfileCard('9', {})
  assert(empty.includes('称呼:(未知)') && empty.includes('尚无已知信息'), `空档案应给兜底提示,实际:${empty}`)
  // **主人称呼兜底(2026-08-13 用户实测"我是主人但称呼未知")**:主人
  // 缺档案名字时称呼恒为「主人」;档案里记过名字则名字优先
  const masterCard = buildProfileCard(MASTER_QQ, {})
  assert(masterCard.includes('称呼:主人') && !masterCard.includes('(未知)'), `主人缺名应兜底「主人」,实际:${masterCard}`)
  const masterNamed = buildProfileCard(MASTER_QQ, { contact: { qq: MASTER_QQ, name: '小岛', source: 'private', updatedAt: 1 } })
  assert(masterNamed.includes('称呼:小岛'), '主人档案有名字时名字优先')
  // 无人格/无联系人不崩
  const bare = buildProfileCard('8', { memories: [{ content: '普通内容' }] })
  assert(bare.includes('称呼:(未知)') && !bare.includes('会话人格'), '缺项不崩且不输出空段')
  // 最近发言(2026-08-13 用户要求"群聊里的各个消息也能正确计入个人的
  // 档案卡"):聊天记录备份计入档案卡,私聊/群聊标渠道,当前消息排除
  const withChats = buildProfileCard('20001', {
    chats: [
      { id: 'm1', text: '早前的发言', type: 'group' },
      { id: 'm2', text: '今晚开黑吗', type: 'group' },
      { id: 'm3', text: '当前消息', type: 'group' },
    ],
    excludeId: 'm3',
  })
  assert(withChats.includes('最近发言:'), `应有最近发言段,实际:${withChats}`)
  assert(withChats.includes('[群聊] 早前的发言') && withChats.includes('[群聊] 今晚开黑吗'), '群聊发言应按 QQ 计入档案卡')
  assert(!withChats.includes('当前消息'), '当前消息应排除(卡内不重复)')
  // 私聊渠道标记 + 最多 3 条(取最近)
  const priv = buildProfileCard('9', {
    chats: [
      { id: 'a', text: '1', type: 'private' },
      { id: 'b', text: '2', type: 'private' },
      { id: 'c', text: '3', type: 'private' },
      { id: 'd', text: '4', type: 'private' },
    ],
  })
  assert(priv.includes('[私聊] 2') && !priv.includes('[私聊] 1'), '应取最近 3 条且带私聊渠道标记')
})

await test('napcat 工具:contacts 档案查询与 contact_update 记录', async () => {
  const contactWrites: Array<{ qq: string; name?: string; info?: string }> = []
  let contacts: Record<string, { qq: string; name?: string; info?: string; source?: 'private' | 'group'; updatedAt: number }> = {
    '10001': { qq: '10001', name: '阿白', info: '群友,喜欢猫', source: 'group', updatedAt: 1700000000 },
  }
  const tools = napcatTools({
    status: () => ({ connected: false, url: 'ws://127.0.0.1:3001', lastError: '', receivedCount: 0, repliedCount: 0 }),
    sendToQQ: async () => '',
    sendToGroup: async () => '',
    getRecentMessages: () => [],
    getContacts: async () => contacts,
    updateContact: async (patch) => {
      contactWrites.push({ qq: patch.qq, name: patch.name, info: patch.info })
      const next = { qq: patch.qq, name: patch.name, info: patch.info, source: patch.source, updatedAt: 1700000001 }
      contacts = { ...contacts, [patch.qq]: next }
      return next
    },
  })
  const tool = tools.find((t) => t.name === 'napcat')!
  const list = String(await tool.execute({ action: 'contacts' }))
  assert(list.includes('10001') && list.includes('阿白') && list.includes('喜欢猫') && list.includes('[群聊]'), `contacts 应列档案,实际:${list}`)
  const up = String(await tool.execute({ action: 'contact_update', qq: '10002', name: '老王', info: '私聊联系人,做设计的' }))
  assert(contactWrites.length === 1 && contactWrites[0].qq === '10002' && contactWrites[0].info?.includes('设计'), 'contact_update 应透传')
  assert(up.includes('10002') && up.includes('老王'), `应回显档案,实际:${up}`)
  const empty = String(await tool.execute({ action: 'contacts' }))
  void empty
  await assertRejects(() => tool.execute({ action: 'contact_update', name: '缺 QQ' }), 'contact_update 需要 qq')
})

await test('napcat 工具:chats 聊天记录备份查询与过滤', async () => {
  const chats = [
    { id: 'p1', type: 'private' as const, target: '10001', qq: '10001', text: '你好呀', time: 1700000000 },
    { id: 'g1', type: 'group' as const, target: '20000', qq: '20001', text: '今天天气不错', atMe: true, time: 1700000100 },
    { id: 'g2', type: 'group' as const, target: '20000', qq: '20002', text: '哈哈', time: 1700000200 },
  ]
  const tools = napcatTools({
    status: () => ({ connected: false, url: '', lastError: '', receivedCount: 0, repliedCount: 0 }),
    sendToQQ: async () => '',
    sendToGroup: async () => '',
    getRecentMessages: () => [],
    getContacts: async () => ({}),
    updateContact: async (p) => ({ qq: p.qq, source: p.source, updatedAt: 0 }),
    getChats: async () => chats,
  })
  const tool = tools.find((t) => t.name === 'napcat')!
  const all = String(await tool.execute({ action: 'chats' }))
  assert(all.includes('10001') && all.includes('20000') && all.includes('你好呀') && all.includes('@鲸鱼娘'), `chats 应列全部记录,实际:${all}`)
  const byQq = String(await tool.execute({ action: 'chats', user_id: '10001' }))
  assert(byQq.includes('你好呀') && !byQq.includes('今天天气不错'), '按 QQ 过滤应只剩私聊')
  const byGroup = String(await tool.execute({ action: 'chats', group_id: '20000' }))
  assert(byGroup.includes('今天天气不错') && !byGroup.includes('你好呀'), '按群过滤应只剩群聊')
  const none = String(await tool.execute({ action: 'chats', user_id: '999' }))
  assert(none.includes('为空'), '无匹配应提示为空')
})

await test('napcat 工具:persona 会话人格查询与 persona_set 设置/删除', async () => {
  let personas: Record<string, { persona: string; updatedAt: number }> = {
    'group:20000': { persona: '群聊高冷版,话少但偶尔毒舌', updatedAt: 1700000000 },
  }
  const writes: string[] = []
  const tools = napcatTools({
    status: () => ({ connected: false, url: '', lastError: '', receivedCount: 0, repliedCount: 0 }),
    sendToQQ: async () => '',
    sendToGroup: async () => '',
    getRecentMessages: () => [],
    getContacts: async () => ({}),
    updateContact: async (p) => ({ qq: p.qq, source: p.source, updatedAt: 0 }),
    getPersonas: async () => personas,
    setPersona: async (scope, persona) => {
      writes.push(`${scope}:${persona}`)
      if (!persona) {
        delete personas[scope]
        return null
      }
      const next = { persona, updatedAt: 1700000001 }
      personas = { ...personas, [scope]: next }
      return next
    },
  })
  const tool = tools.find((t) => t.name === 'napcat')!
  const list = String(await tool.execute({ action: 'persona' }))
  assert(list.includes('group:20000') && list.includes('高冷版'), `persona 应列会话人格,实际:${list}`)
  const set = String(await tool.execute({ action: 'persona_set', scope: 'private:10000', persona: '私聊亲近版,黏人撒娇' }))
  assert(writes.includes('private:10000:私聊亲近版,黏人撒娇'), 'persona_set 应写入')
  assert(set.includes('private:10000') && set.includes('黏人撒娇'), `应回显设置,实际:${set}`)
  // scope 校验
  await assertRejects(() => tool.execute({ action: 'persona_set', scope: 'bad', persona: 'x' }), 'scope 需要是 private:<QQ> 或 group:<群号>')
  // 空 persona = 删除
  const del = String(await tool.execute({ action: 'persona_set', scope: 'group:20000', persona: '' }))
  assert(writes.includes('group:20000:'), '空 persona 应删除')
  assert(del.includes('已删除'), `应回显删除,实际:${del}`)
})

await test('napcatMessageText:群消息 @ 与图片/回复段解析', () => {
  assert(
    napcatMessageText(
      [
        { type: 'at', data: { qq: '30000' } },
        { type: 'text', data: { text: ' 在吗' } },
        { type: 'image', data: { file: 'x.png' } },
        { type: 'reply', data: { id: '1' } },
      ],
      '30000',
    ) === '@鲸鱼娘 在吗[图片][回复]',
    '群消息:@ 机器人标注 + 图片/回复段',
  )
  assert(
    napcatMessageText([{ type: 'at', data: { qq: '123' } }, { type: 'text', data: { text: ' hi' } }], '30000') === '@123 hi',
    '@ 他人标注 QQ 号',
  )
})

await test('set_napcat_config:enabled/wsUrl/allowed/allowedGroups 校验与写配置', async () => {
  const { writes, tools } = makeConfigToolsDeps()
  const tool = tools.find((t) => t.name === 'set_napcat_config')!
  const out = String(
    await tool.execute({ enabled: true, wsUrl: 'ws://127.0.0.1:3001', allowed: ['10001', '10002'], allowedGroups: ['20000', '22222222'] }),
  )
  assert(out.includes('已开启'), `应回显开启,实际:${out}`)
  const patch = writes.at(-1) as { napcatEnabled?: boolean; napcatAllowed?: string[]; napcatAllowedGroups?: string[] }
  assert(patch?.napcatEnabled === true && patch?.napcatAllowed?.length === 2, '配置应写入')
  // 换群监听(2026-08-12 修复"换群后消息收不到"):allowedGroups 必须可改
  assert(patch?.napcatAllowedGroups?.length === 2 && patch?.napcatAllowedGroups?.includes('22222222'), 'allowedGroups 应写入')
  assert(out.includes('监听群'), `应回显监听群,实际:${out}`)
  const outEmpty = String(await tool.execute({ allowedGroups: [] }))
  assert(outEmpty.includes('监听所有群'), `空数组应监听所有群,实际:${outEmpty}`)
  await assertRejects(() => tool.execute({ wsUrl: 'http://bad' }), 'wsUrl 需要是 ws:// 开头')
  await assertRejects(() => tool.execute({}), '至少提供一个参数')
  await assertRejects(() => tool.execute({ allowedGroups: 'not-array' }), 'allowedGroups 需要是群号字符串数组')
  const out2 = String(await tool.execute({ enabled: false }))
  assert(out2.includes('已关闭'), `关闭应回显,实际:${out2}`)
})

await test('napcat 工具:sent(机器人发出的消息带 ID 可撤回)与 zone(查看 QQ 空间动态)', async () => {
  const sentList = [
    { messageId: 'm-sent-1', type: 'private' as const, target: '10001', text: '下载好了', time: 1700000000 },
    { messageId: 'm-sent-2', type: 'group' as const, target: '20000', text: '大家好', time: 1700000100 },
  ]
  const zoneCalls: Array<{ qq: string; num: number }> = []
  const tools = napcatTools({
    status: () => ({ connected: false, url: '', lastError: '', receivedCount: 0, repliedCount: 0 }),
    sendToQQ: async () => '',
    sendToGroup: async () => '',
    getRecentMessages: () => [],
    getContacts: async () => ({}),
    updateContact: async (p) => ({ qq: p.qq, source: p.source, updatedAt: 0 }),
    getSentMessages: () => sentList,
    getQzoneFeeds: async (qq, num) => {
      zoneCalls.push({ qq, num })
      return [
        { tid: 'tid-1', content: '今天天气不错', createTime: 1700000000, picnum: 2, commentnum: 3, likenum: 5 },
        { tid: 'tid-2', content: '晒个猫', createTime: 1700000100, picnum: 0, commentnum: 0, likenum: 0 },
      ]
    },
  })
  const tool = tools.find((t) => t.name === 'napcat')!
  // sent:列出机器人发出的消息(2026-08-12 撤回修复),带 message_id(撤回用 action=recall + message_id)
  const sent = String(await tool.execute({ action: 'sent' }))
  assert(sent.includes('m-sent-1') && sent.includes('QQ10001') && sent.includes('message_id m-sent-1'), `sent 应列消息与 ID,实际:${sent}`)
  assert(sent.includes('m-sent-2') && sent.includes('群20000'), `sent 应含群消息,实际:${sent}`)
  // sent 空列表兜底
  const emptyTools = napcatTools({
    status: () => ({ connected: false, url: '', lastError: '', receivedCount: 0, repliedCount: 0 }),
    sendToQQ: async () => '',
    sendToGroup: async () => '',
    getRecentMessages: () => [],
    getContacts: async () => ({}),
    updateContact: async (p) => ({ qq: p.qq, source: p.source, updatedAt: 0 }),
    getSentMessages: () => [],
  })
  const sentEmpty = String(await emptyTools.find((t) => t.name === 'napcat')!.execute({ action: 'sent' }))
  assert(sentEmpty.includes('还没有发出过'), `sent 空应兜底,实际:${sentEmpty}`)
  // zone:缺省 qq = 主人(MASTER_QQ,即用户自己的空间),num 缺省 10
  const zone = String(await tool.execute({ action: 'zone' }))
  assert(zoneCalls.length === 1 && zoneCalls[0].qq === MASTER_QQ && zoneCalls[0].num === 10, `zone 缺省应查主人空间,实际:${JSON.stringify(zoneCalls)}`)
  assert(zone.includes('今天天气不错') && zone.includes('[图片×2]') && zone.includes('👍5') && zone.includes('💬3'), `zone 应格式化动态,实际:${zone}`)
  // 显式 qq/num 透传
  await tool.execute({ action: 'zone', qq: '10001', num: 5 })
  // 注:assert 是 asserts 类型守卫,前面 length===1 断言后 TS 把 length 收窄为
  // 字面量 1,再用 ===2 报 2367 无重叠——用 >= 表达"经过一次调用后至少 2"
  assert(zoneCalls.length >= 2 && zoneCalls[1].qq === '10001' && zoneCalls[1].num === 5, 'zone 应透传 qq 与 num')
  // num 越界校验
  await assertRejects(() => tool.execute({ action: 'zone', num: 0 }), 'num 需要在 1-20')
  await assertRejects(() => tool.execute({ action: 'zone', num: 21 }), 'num 需要在 1-20')
})

await test('gtkFromCookie:QQ Cookie 计算 g_tk(QQ 空间接口认证)', () => {
  assert(gtkFromCookie('uin=o123456789; p_skey=abc123; ') !== '', 'p_skey 应能计算 g_tk')
  assert(gtkFromCookie('uin=o123; skey=xyz;') !== '', 'skey 兜底应能计算 g_tk')
  assert(gtkFromCookie('uin=o123; p_skey=abc;') === gtkFromCookie('p_skey=abc'), '只取 p_skey 值,与其它 cookie 无关')
  assert(gtkFromCookie('no keys here') === '', '无 p_skey/skey 返回空串')
})

await test('stripThinkingPreamble:剥离回复开头的思考腔(QQ 收到带思考过程)', () => {
  // 语气词 + 思考动词开头 → 剥第一段
  assert(
    stripThinkingPreamble('好的,我先梳理一下你的需求。然后我给你下载链接。') === '然后我给你下载链接。',
    '语气词+思考动词应剥离第一段',
  )
  // 冒号段尾的思考腔
  assert(
    stripThinkingPreamble('嗯,让我想想:你的视频下载到 D 盘了。') === '你的视频下载到 D 盘了。',
    '冒号段尾应剥离',
  )
  // 直接以思考动词开头
  assert(
    stripThinkingPreamble('让我先分析一下这个问题。答案是 X。') === '答案是 X。',
    '思考动词直接开头应剥离',
  )
  // 正常回复(无思考腔)不动
  assert(stripThinkingPreamble('好的,我会帮你下载。') === '好的,我会帮你下载。', '正常回复不应误剥')
  assert(stripThinkingPreamble('下载完成了。') === '下载完成了。', '直接结论不应误剥')
  // 剥后为空 → 保留原文(不把结论误删光)
  assert(stripThinkingPreamble('好的,我先想想。') === '好的,我先想想。', '剥空应保留原文')
  // 超长第一段不剥(长句多为正式开场)
  const longThink = '好的,我先梳理一下' + '非常长'.repeat(15) + '的细节,然后给出结论。'
  assert(stripThinkingPreamble(longThink) === longThink, '超长段不应剥')
  // 空输入
  assert(stripThinkingPreamble('') === '' && stripThinkingPreamble('  ') === '', '空输入返回空')
})

await test('stripToolNarration:剥离工具调用过程叙述(和外人聊天不暴露内部动作)', () => {
  // 用户实测例子:连续叙述句全删 → 空 → 保留原文(不把回复删没)
  const full = '我来找实时数据源,先探测 KPL 数据中心的接口。找到了 API 路径,现在探测实时数据端点。'
  assert(stripToolNarration(full) === full, '叙述段全删光应保留原文')
  // 叙述句 + 结论混合:只删叙述句,结论保留
  assert(
    stripToolNarration('我来找实时数据源,先探测接口。拿到了实时数据!现在 SYG 1:0 KSG。') === '现在 SYG 1:0 KSG。',
    '应删除叙述句保留结论',
  )
  // 连续三句叙述段删除
  assert(
    stripToolNarration('我先探测接口。然后拼接 URL。最后绘制曲线图。后面是结论。') === '后面是结论。',
    '连续叙述段应整段删除',
  )
  // 单句叙述(正常口吻)不删——"我刚帮你查了下比分"是自然的
  assert(stripToolNarration('我刚帮你查了下比分,现在 KSG 领先。') === '我刚帮你查了下比分,现在 KSG 领先。', '单句叙述不应误删')
  // 正常回复不删
  assert(stripToolNarration('比分 2:1,KSG 暂时领先。第二局还在打。') === '比分 2:1,KSG 暂时领先。第二局还在打。', '正常回复不应误删')
  // 多行回复换行保留(2026-08-13 修复:原 .trim() 把段尾 \n 剥掉,
  // join('') 后行与行粘连——QQ 收到的多行回复换行全部丢失)
  assert(
    stripToolNarration('已收到\n\n称呼:魔精\n(尚无已知信息)') === '已收到\n\n称呼:魔精\n(尚无已知信息)',
    '多行回复换行应保留',
  )
  // 空输入
  assert(stripToolNarration('') === '' && stripToolNarration('   ') === '', '空输入返回空')
})

await test('wsclient:帧编解码/长度/分片/掩码(手写 WS 传输,2026-08-13)', () => {
  // 客户端帧必须带掩码(0x80),载荷掩码还原后一致
  const f = encodeWsFrame(0x1, Buffer.from('你好'))
  assert((f[1] & 0x80) !== 0, '客户端帧应带掩码位')
  const parser = new WsFrameParser()
  const frames = parser.push(f)
  assert(frames.length === 1 && frames[0].opcode === 0x1 && frames[0].fin, '掩码帧应解析成功')
  assert(frames[0].payload.toString('utf8') === '你好', '掩码还原后载荷一致')
  // 126(2 字节扩展长度)与 127(8 字节扩展长度)
  const big126 = Buffer.alloc(200, 0x61)
  const f126 = parser.push(encodeWsFrame(0x1, big126))
  assert(f126.length === 1 && f126[0].payload.length === 200, '126 长度帧解析正确')
  const big127 = Buffer.alloc(70000, 0x62)
  const f127 = parser.push(encodeWsFrame(0x1, big127))
  assert(f127.length === 1 && f127[0].payload.length === 70000, '127 长度帧解析正确')
  // 半帧累积:分两次喂入,第二次才出帧
  const split = encodeWsFrame(0x1, Buffer.from('半帧测试'))
  const p2 = new WsFrameParser()
  assert(p2.push(split.subarray(0, 5)).length === 0, '半帧不应出结果')
  const done = p2.push(split.subarray(5))
  assert(done.length === 1 && done[0].payload.toString('utf8') === '半帧测试', '补齐后应解析出完整帧')
  // 服务端不掩码帧(fin=0 分片 + 续帧)
  const unfragmented = Buffer.concat([
    Buffer.from([0x01, 0x03]), Buffer.from('abc'),
    Buffer.from([0x80, 0x03]), Buffer.from('def'),
  ])
  const p3 = new WsFrameParser()
  const ff = p3.push(unfragmented)
  assert(ff.length === 2 && ff[0].fin === false && ff[1].opcode === 0x0 && ff[1].fin === true, '分片帧应逐帧解析')
  // URL 解析
  const u1 = parseWsUrl('ws://127.0.0.1:3001')
  assert(u1.host === '127.0.0.1' && u1.port === 3001 && u1.path === '/', `ws URL 解析,实际:${JSON.stringify(u1)}`)
  const u2 = parseWsUrl('ws://localhost:8080/onebot')
  assert(u2.host === 'localhost' && u2.port === 8080 && u2.path === '/onebot', '带路径 URL 解析')
  let threw = false
  try {
    parseWsUrl('not-a-url')
  } catch {
    threw = true
  }
  assert(threw, '非法 URL 应抛错')
})

await test('wsclient:端到端连接假 OneBot 服务器(握手/收发/ping-pong/关闭)', async () => {
  // 本地 net 服务器模拟 OneBot:101 握手 → 推送文本帧 + ping → 收客户端帧
  const net = await import('node:net')
  const crypto = await import('node:crypto')
  const received: string[] = [] // 服务器收到的客户端帧(payload 文本 / PONG:)
  const server = net.createServer((sock) => {
    let upgraded = false
    let buf = Buffer.alloc(0)
    sock.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk])
      if (!upgraded) {
        const idx = buf.indexOf('\r\n\r\n')
        if (idx === -1) return
        const req = buf.subarray(0, idx).toString('utf8')
        const key = /Sec-WebSocket-Key:\s*(.+)\r?\n/i.exec(req)?.[1]?.trim() ?? ''
        const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
        sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
        buf = buf.subarray(idx + 4)
        upgraded = true
        // 推送一条文本消息 + 一个 ping(期望客户端回 pong);
        // 帧头长度 = UTF-8 字节数(不能用字符数,中文 3 字节/字)
        const payload = Buffer.from(
          JSON.stringify({ post_type: 'message', message_type: 'private', user_id: 10000, raw_message: '集成测试' }),
          'utf8',
        )
        sock.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]))
        sock.write(Buffer.from([0x89, 0x00]))
        return
      }
      const parser = new WsFrameParser()
      const frames = parser.push(buf)
      buf = Buffer.alloc(0)
      for (const f of frames) {
        if (f.opcode === 0x1) received.push(f.payload.toString('utf8'))
        if (f.opcode === 0xa) received.push('PONG:' + f.payload.toString('utf8'))
        if (f.opcode === 0x8) sock.end()
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as { port: number }).port
  const events: string[] = []
  const messages: string[] = []
  const conn = createWsSocket(`ws://127.0.0.1:${port}`, {
    onOpen: () => events.push('open'),
    onMessage: (text) => messages.push(text),
    onError: (m) => events.push(`error:${m}`),
    onClose: () => events.push('close'),
  })
  // 握手 + 收到服务器推送
  await waitFor(() => events.includes('open'), 5000, 'WS 握手成功')
  assert(messages.length === 1 && messages[0].includes('集成测试'), `应收到服务器推送,实际:${JSON.stringify(messages)}`)
  // 客户端发送(掩码帧,服务器侧解析出载荷);ping → pong 由服务器侧确认
  conn.send('客户端问候')
  await waitFor(() => received.some((r) => r.includes('客户端问候')), 5000, '服务器应收到客户端文本帧')
  await waitFor(() => received.some((r) => r.startsWith('PONG:')), 5000, '服务器应收到 pong')
  // 关闭:客户端发 close 帧,服务器 end → onClose
  conn.close()
  await waitFor(() => events.includes('close'), 5000, '关闭回调')
  server.close()
  assert(!events.some((e) => e.startsWith('error')), `不应有错误事件,实际:${JSON.stringify(events)}`)
  assert(events[0] === 'open' && events[events.length - 1] === 'close', '事件顺序 open→close')
})

await test('stripMasterNarration:主人视角汇报剥离(私聊窗口泄露,2026-08-13 实测原文)', () => {
  // 用户实测泄露原文:给扩展信任联系人(魔精)的回复整体是向主人汇报
  // 的口吻——全部叙述句删除后,提取「回他「…」」引号里的真正回复
  const leaked =
    '魔精发来一张图片,我先展示给你看,同时识别一下图里的内容。' +
    '识别出来了,魔精发的是张写着「晚 上 好」的图——他在回我之前那句「晚上好」。' +
    '我回他一句,顺便把临时文件清理掉。' +
    '魔精回你了——他发了张写着「晚上好」的图(回应之前那句),我认出来后就回他「晚上好呀~图收到啦,今晚是打王者还是看KPL呀」,顺带把识别用的临时文件清了。' +
    '图片已经展示在窗口里了,你可以看看。'
  assert(
    stripMasterNarration(leaked) === '晚上好呀~图收到啦,今晚是打王者还是看KPL呀',
    `应提取引号里的真回复,实际:${stripMasterNarration(leaked)}`,
  )
  // 叙述段 + 真回复混合:删叙述段,保留直接对对方说的话
  assert(
    stripMasterNarration('魔精发来一张图,我先识别一下。顺便把临时文件清理了。图上的「晚上好」收到啦~今晚打王者还是看KPL呀?') ===
      '图上的「晚上好」收到啦~今晚打王者还是看KPL呀?',
    '应删除叙述段保留对对方的回复',
  )
  // 第三人称转述对方(连续 ≥2 句)整段删除
  assert(
    stripMasterNarration('他回你了——他发了张图。他回你说今晚要上分。好的,那我帮你约他组队。') ===
      '好的,那我帮你约他组队。',
    '转述对方的叙述段应整段删除',
  )
  // 向主人汇报口吻(识别/展示在窗口/你可以看看,连续 ≥2 句)删除
  assert(
    stripMasterNarration('识别出来了,是张写着「晚上好」的图。图片已经展示在窗口里了,你可以看看。图收到啦,写的是「晚上好」。') ===
      '图收到啦,写的是「晚上好」。',
    '向主人汇报叙述段应删除',
  )
  // 单句叙述(正常口吻)不删——"我刚帮你查了下比分"是自然的
  assert(
    stripMasterNarration('我刚帮你查了下比分,现在 KSG 领先。') === '我刚帮你查了下比分,现在 KSG 领先。',
    '单句不应误删',
  )
  // 正常回复不删(你/你的 是对对方说话,不是汇报)
  assert(
    stripMasterNarration('你发的图收到啦,写的是「晚上好」。今晚打王者还是看KPL呀?') ===
      '你发的图收到啦,写的是「晚上好」。今晚打王者还是看KPL呀?',
    '正常回复不应误删',
  )
  // 全叙述且无引号 → 保留原文兜底
  const noQuote = '魔精发来一张图,我先展示给你看。图片已经展示在窗口里了。'
  assert(stripMasterNarration(noQuote) === noQuote, '无引号兜底应保留原文')
  // 多行回复换行保留(与 stripToolNarration 同款 2026-08-13 修复)
  assert(
    stripMasterNarration('已收到\n\n称呼:魔精\n(尚无已知信息)') === '已收到\n\n称呼:魔精\n(尚无已知信息)',
    '多行回复换行应保留',
  )
  // 空输入
  assert(stripMasterNarration('') === '' && stripMasterNarration('   ') === '', '空输入返回空')
})

await test('isAskTurnToMaster:询问轮判定(2026-08-13 泄露根治——LLM 征求主人意见的回复绝不能发回对方)', () => {
  // 用户实测泄露原文:询问主人怎么回复(扩展信任联系人,应当拦截)
  const ask = '魔精又补了一句:「要被零封了」——原来是在说 AG 这场比赛要被打零封了(所以你说"AG少人了"他回的是这茬)。 要不要我回他一句调侃?比如:「哈哈你们AG今天这阵容确实拉胯,少人+零封预定,心疼你一秒」之类的。你说回啥,我马上发~'
  assert(isAskTurnToMaster(ask), '用户实测询问原文应判询问轮(拦截)')
  // 用户实测第二条:执行后的汇报(不应判询问,靠 pending+标记 拦截)
  assert(
    isAskTurnToMaster('好嘞,那我自由发挥啦~(っ˘з(˘⌣˘ ) ♡) 发出去了~调侃他一句,等他回话我再转告你(｡♡‿♡｡)') === false,
    '执行后的汇报不应判询问轮',
  )
  // 常见询问措辞
  assert(isAskTurnToMaster('要不要我回他一句?'), '要不要我回他一句应判询问')
  assert(isAskTurnToMaster('要不要我发给他一份资料?'), '要不要我发给他(第三人称)应判询问')
  // 2026-08-14:第二人称"你" = 发给对方的话(自问自答式建议),不应误判
  assert(isAskTurnToMaster('要不要我把链接发给你?') === false, '要不要我发给你(第二人称)不应判询问')
  assert(isAskTurnToMaster('要不要我回你一句?') === false, '要不要我回你(第二人称)不应判询问')
  assert(isAskTurnToMaster('要不要我发你一份资料?') === false, '要不要我发你(第二人称)不应判询问')
  assert(isAskTurnToMaster('你说回啥,我马上发~'), '你说回啥应判询问')
  assert(isAskTurnToMaster('你想怎么回他?'), '你想怎么回应判询问')
  assert(isAskTurnToMaster('等你指示,主人'), '等你指示应判询问')
  assert(isAskTurnToMaster('我先问问主人的意见。'), '问主人应判询问')
  assert(isAskTurnToMaster('我建议回他一句调侃,你觉得呢?'), '我建议回他+你觉得呢应判询问')
  assert(isAskTurnToMaster('回他什么好呢'), '回他什么好呢应判询问')
  // 直接回复(应放行,绝不能误判扣留)
  assert(isAskTurnToMaster('哈哈确实拉胯,少人+零封预定,心疼你一秒') === false, '直接回复不应判询问')
  assert(isAskTurnToMaster('哈哈你们AG今天这阵容确实拉胯,心疼你一秒') === false, '直接回复(含调侃原文)不应判询问')
  assert(isAskTurnToMaster('嗯,知道了') === false, '简短应答不应判询问')
  assert(isAskTurnToMaster('好的,我这就告诉他怎么回。') === false, '陈述句「怎么回」不应判询问(非疑问收尾)')
  assert(isAskTurnToMaster('好的,等你消息~') === false, '「等你消息」是对对方说的话,不应判询问')
  assert(isAskTurnToMaster('我问你一下,今晚打王者还是看KPL呀?') === false, '「我问你」是对对方说话,不应判询问')
  assert(isAskTurnToMaster('哈哈你觉得呢?') === false, '「你觉得呢」可能问对方,弱模式不拦(宁漏勿误伤)')
  // 空输入
  assert(isAskTurnToMaster('') === false && isAskTurnToMaster('   ') === false, '空输入返回 false')
})

await test('turnAlreadySentToTarget:防重发通用判定(私聊/群聊共用,2026-08-13)', () => {
  const sent = [
    { type: 'private', target: '222', messageId: '1' },
    { type: 'private', target: '333', messageId: '2' },
    { type: 'group', target: '999', messageId: '3' },
  ]
  // before = 本轮开始前已发给目标的数量
  assert(turnAlreadySentToTarget(sent, 0, 'private', '222') === true, '本轮已发过私聊 → 应判已发(跳过路由)')
  assert(turnAlreadySentToTarget(sent, 1, 'private', '222') === false, '快照数量相等 → 本轮没发过')
  assert(turnAlreadySentToTarget(sent, 0, 'private', '333') === true, '发给其它目标也计数')
  assert(turnAlreadySentToTarget(sent, 0, 'group', '999') === true, '群聊 send_group 同款判定')
  assert(turnAlreadySentToTarget(sent, 0, 'private', '404') === false, '未发过目标 → false')
  // 旧签名兼容(私聊专用)
  assert(turnAlreadySentToPending(sent, 0, '222') === true, '旧签名仍按私聊判定')
})

await test('newTurnFingerprint:轮次指纹生成(2026-08-13,每个轮唯一)', () => {
  const f1 = newTurnFingerprint()
  const f2 = newTurnFingerprint()
  assert(/^[2-9A-HJ-NP-Z]{6}$/.test(f1), `指纹应为 6 位安全字母表(无 0O1Il),实际:${f1}`)
  assert(f1 !== f2, '两次生成应不同')
  // 30 次无重复(概率断言,防实现退化)
  const seen = new Set(Array.from({ length: 30 }, () => newTurnFingerprint()))
  assert(seen.size === 30, '30 次生成应全唯一')
})

await test('extractTurnFingerprint:指纹提取与匹配(2026-08-13 指纹协议,对不上就不发送)', () => {
  const fp = 'A1B2C3'
  const ok = extractTurnFingerprint(`【指纹:${fp}】哈哈确实拉胯,心疼你一秒`, fp)
  assert(ok !== null && ok.content === '哈哈确实拉胯,心疼你一秒', '指纹开头应提取并剥离')
  assert(extractTurnFingerprint('哈哈确实拉胯,心疼你一秒', fp) === null, '无指纹 = 给主人的话,不发送')
  assert(extractTurnFingerprint(`【指纹:XXXXXX】哈哈确实拉胯`, fp) === null, '指纹对不上 = 不发送')
  assert(extractTurnFingerprint(`  【指纹:${fp}】哈哈`, fp) !== null, '容忍先导空白')
  assert(extractTurnFingerprint(`【回复对方】【指纹:${fp}】哈哈`, fp) !== null, '容忍先导旧【回复对方】标记')
  assert(extractTurnFingerprint(`【指纹:${fp}】`, fp)?.content === '', '仅指纹返回空正文')
  assert(extractTurnFingerprint('', fp) === null && extractTurnFingerprint('  ', fp) === null, '空输入')
  // ---- 语气词前缀容忍(2026-08-14 修复"偶现没发出去"——LLM 偶发在
  // 指纹前加语气词,严格开头匹配被扣留;白名单词 + ≤2 标点/空白后仍
  // 紧跟本轮指纹才提取,指纹值验证不变)----
  assert(extractTurnFingerprint(`好的~【指纹:${fp}】哈哈`, fp)?.content === '哈哈', '容忍语气词+~')
  assert(extractTurnFingerprint(`好的,【指纹:${fp}】哈哈`, fp)?.content === '哈哈', '容忍好的+逗号')
  assert(extractTurnFingerprint(`收到 【指纹:${fp}】哈哈`, fp)?.content === '哈哈', '容忍收到+空格')
  assert(extractTurnFingerprint(`回复:【指纹:${fp}】哈哈`, fp)?.content === '哈哈', '容忍回复:')
  assert(extractTurnFingerprint(`好的,已按【指纹:${fp}】回复他`, fp) === null, '汇报引用指纹(白名单词后是"已"非标点)不误提取')
  assert(extractTurnFingerprint(`知道了【指纹:${fp}】哈哈`, fp) === null, '非白名单语气词不匹配')
  // ---- 严格性对抗用例(2026-08-13 二轮)----
  // 指纹必须在开头:非白名单内容前置 = 不发送(规则明确"指纹前面不要加任何话")
  assert(extractTurnFingerprint(`哈哈【指纹:${fp}】哈哈`, fp) === null, '指纹在中间不应匹配')
  // 旧轮次指纹对不上本轮(历史里抄来的 = 不发送)
  assert(extractTurnFingerprint('【指纹:OLDOLD】哈哈', fp) === null, '旧轮次指纹对不上本轮')
  // 指纹行后换行:正文保留(多行回复)
  const multi = extractTurnFingerprint(`【指纹:${fp}】\n哈哈确实拉胯`, fp)
  assert(multi !== null && multi.content === '哈哈确实拉胯', '指纹后换行正文应保留')
  // 指纹重复出现:取第一个指纹后的内容(第二个属正文)
  const twice = extractTurnFingerprint(`【指纹:${fp}】哈哈【指纹:${fp}】x`, fp)
  assert(twice !== null && twice.content === `哈哈【指纹:${fp}】x`, '第二个指纹应留在正文')
})

await test('stripTurnMarks:轮次标记剥离(2026-08-13,指纹不进历史/显示)', () => {
  // 指纹前缀剥离(旧指纹残留进上下文会被 LLM 抄到 → 验证对不上 → 发不出去)
  assert(stripTurnMarks('【指纹:A2B3C4】哈哈确实拉胯') === '哈哈确实拉胯', '指纹前缀应剥离')
  assert(stripTurnMarks('【指纹:A2B3C4】\n哈哈') === '哈哈', '指纹后换行应剥离')
  assert(stripTurnMarks('【回复对方】哈哈') === '哈哈', '旧【回复对方】标记应剥离')
  assert(stripTurnMarks('  【指纹:A2B3C4】哈哈') === '哈哈', '先导空白应剥离')
  // 无标记 / 标记不在开头 / 非安全字母表 → 原样(防误伤正文)
  assert(stripTurnMarks('哈哈【指纹:A2B3C4】') === '哈哈【指纹:A2B3C4】', '正文中间的指纹不应剥离')
  assert(stripTurnMarks('【指纹:0O1IlA】哈哈') === '【指纹:0O1IlA】哈哈', '非安全字母表的指纹不应剥离(不是指纹协议格式)')
  assert(stripTurnMarks('哈哈确实拉胯') === '哈哈确实拉胯', '无标记原样')
  assert(stripTurnMarks('') === '' && stripTurnMarks('  ') === '', '空输入')
})

await test('extractMasterFingerprint:主人指纹提取与匹配(2026-08-15 双指纹机制,不再以没有指纹为主人消息)', () => {
  const fp = 'A1B2C3'
  const ok = extractMasterFingerprint(`【主人指纹:${fp}】好的,已帮他发了`, fp)
  assert(ok !== null && ok.content === '好的,已帮他发了', '主人指纹开头应提取并剥离')
  assert(extractMasterFingerprint('好的,已帮他发了', fp) === null, '无主人指纹 = 不发送(不再当主人消息)')
  assert(extractMasterFingerprint(`【主人指纹:XXXXXX】好的`, fp) === null, '主人指纹对不上本轮 = 不发送')
  assert(extractMasterFingerprint(`  【主人指纹:${fp}】好的`, fp) !== null, '容忍先导空白')
  assert(extractMasterFingerprint(`【回复对方】【主人指纹:${fp}】好的`, fp) !== null, '容忍先导旧【回复对方】标记')
  assert(extractMasterFingerprint(`【主人指纹:${fp}】`, fp)?.content === '', '仅主人指纹返回空正文')
  assert(extractMasterFingerprint('', fp) === null && extractMasterFingerprint('  ', fp) === null, '空输入')
  // 语气词前缀容忍(与他人指纹同款,LLM 偶发在指纹前加语气词)
  assert(extractMasterFingerprint(`好的~【主人指纹:${fp}】好的`, fp)?.content === '好的', '容忍语气词+~')
  assert(extractMasterFingerprint(`收到 【主人指纹:${fp}】好的`, fp)?.content === '好的', '容忍收到+空格')
  // 双通道互斥:他人指纹【指纹:xxx】不被主人指纹提取命中,反之亦然——
  // 同一条回复带哪个指纹由开头标记唯一决定
  assert(extractMasterFingerprint(`【指纹:${fp}】好的`, fp) === null, '他人指纹不被主人指纹提取命中(双通道互斥)')
  assert(extractTurnFingerprint(`【主人指纹:${fp}】好的`, fp) === null, '主人指纹不被他人指纹提取命中(双通道互斥)')
  // 汇报引用主人指纹(白名单词后是"已"非标点)不误提取
  assert(extractMasterFingerprint(`好的,已按【主人指纹:${fp}】回复他`, fp) === null, '汇报引用主人指纹不误提取')
  // 主人指纹在中间不匹配(规则明确"指纹前面不要加任何话");
  // 非白名单语气词不匹配(「好的」是白名单容忍形态,剥后紧跟指纹 = 合法)
  assert(extractMasterFingerprint(`中间【主人指纹:${fp}】好的`, fp) === null, '主人指纹在中间不应匹配')
  assert(extractMasterFingerprint(`知道了【主人指纹:${fp}】好的`, fp) === null, '非白名单语气词不匹配')
})

await test('stripFingerprintMarks:发送边界双剥(2026-08-15 主人指纹+他人指纹,任一标记到不了聊天对象)', () => {
  assert(stripFingerprintMarks('【指纹:A2B3C4】哈哈') === '哈哈', '他人指纹应剥')
  assert(stripFingerprintMarks('【主人指纹:A2B3C4】好的') === '好的', '主人指纹应剥')
  assert(stripFingerprintMarks('哈哈【指纹:A2B3C4】【主人指纹:A2B3C4】') === '哈哈', '正文内两种标记都应剥')
  assert(stripFingerprintMarks('【指纹:A2B3C4】【主人指纹:A2B3C4】好的') === '好的', '连续两种标记都应剥')
  assert(stripFingerprintMarks('哈哈') === '哈哈' && stripFingerprintMarks('') === '', '无标记原样')
})

await test('stripTurnMarks:主人指纹剥离(2026-08-15 双指纹,主人指纹不进历史/显示)', () => {
  assert(stripTurnMarks('【主人指纹:A2B3C4】好的,已回复他') === '好的,已回复他', '主人指纹前缀应剥离')
  assert(stripTurnMarks('  【主人指纹:A2B3C4】好的') === '好的', '先导空白+主人指纹应剥离')
  assert(stripTurnMarks('【主人指纹:A2B3C4】\n好的') === '好的', '主人指纹后换行应剥离')
  assert(stripTurnMarks('【主人指纹:0O1IlA】好的') === '【主人指纹:0O1IlA】好的', '非安全字母表的主人指纹不剥离(防误伤正文)')
  assert(stripTurnMarks('好的【主人指纹:A2B3C4】') === '好的【主人指纹:A2B3C4】', '正文中间的主人指纹不剥离')
})

await test('hasMasterTurnMark:主人指纹 UI 检测(2026-08-15,与 hasTurnMark 双通道互斥)', () => {
  assert(hasMasterTurnMark('【主人指纹:A2B3C4】好的') === true, '主人指纹开头命中')
  assert(hasMasterTurnMark('  【主人指纹:A2B3C4】好的') === true, '容忍先导空白')
  // 双通道互斥:他人指纹/旧标记不是主人指纹
  assert(hasMasterTurnMark('【指纹:A2B3C4】哈哈') === false, '他人指纹不命中主人检测(互斥)')
  assert(hasMasterTurnMark('【回复对方】哈哈') === false, '旧【回复对方】标记不命中')
  // 非安全字母表 / 中间位置 / 普通文本 / 空
  assert(hasMasterTurnMark('【主人指纹:0O1IlA】好的') === false, '非安全字母表不命中')
  assert(hasMasterTurnMark('好的【主人指纹:A2B3C4】') === false, '中间位置不命中')
  assert(hasMasterTurnMark('哈哈确实拉胯') === false, '普通文本不命中')
  assert(hasMasterTurnMark('') === false && hasMasterTurnMark('  ') === false, '空输入不命中')
})

await test('会话管理工具:get/set_session_note + clear_session_context(2026-08-13 LLM 自己管理会话)', async () => {
  const notes = new Map<string, string>()
  const calls: string[] = []
  const tools = createSessionTools({
    getSessionKey: () => 'private:222',
    getNote: async (k) => notes.get(k) ?? '',
    setNote: async (k, n) => {
      notes.set(k, n)
      calls.push(`set:${k}:${n}`)
    },
    clearContext: async (k) => {
      calls.push(`clear:${k}`)
    },
  })
  const names = tools.map((t) => t.name)
  assert(
    names.includes('get_session_note') && names.includes('set_session_note') && names.includes('clear_session_context'),
    `三个工具应注册,实际:${names.join(',')}`,
  )
  const getTool = tools.find((t) => t.name === 'get_session_note')!
  const setTool = tools.find((t) => t.name === 'set_session_note')!
  const clearTool = tools.find((t) => t.name === 'clear_session_context')!
  // 设置 → 透传会话键 + 截 500
  const r1 = String(await setTool.execute({ note: '魔精是好友,喜欢电竞' }))
  assert(r1.includes('private:222') && notes.get('private:222') === '魔精是好友,喜欢电竞', `应写入,实际:${r1}`)
  await setTool.execute({ note: 'x'.repeat(600) })
  assert(notes.get('private:222')!.length === 500, '超长应截 500')
  // 空串 = 清除
  await setTool.execute({ note: '  ' })
  assert(!notes.get('private:222'), '空串应清除记录')
  // 读取
  await setTool.execute({ note: '电竞' })
  const r2 = String(await getTool.execute({}))
  assert(r2.includes('电竞'), `读取应返回记录,实际:${r2}`)
  // 清空上下文 → 透传会话键
  const r3 = String(await clearTool.execute({}))
  assert(r3.includes('private:222') && calls.includes('clear:private:222'), `清空应透传,实际:${r3}`)
  // 无会话键 → 拒绝(工具返回提示,不抛错)
  const tools2 = createSessionTools({
    getSessionKey: () => null,
    getNote: async () => '',
    setNote: async () => {},
    clearContext: async () => {},
  })
  assert(String(await tools2.find((t) => t.name === 'set_session_note')!.execute({ note: 'x' })).includes('没有可操作'), '无会话键设置应拒绝')
  assert(String(await tools2.find((t) => t.name === 'clear_session_context')!.execute({})).includes('没有可操作'), '无会话键清空应拒绝')
  assert(String(await tools2.find((t) => t.name === 'get_session_note')!.execute({})).includes('没有可操作'), '无会话键读取应拒绝')
})

await test('extractImageRefs:文本夹带的图片路径自动提取转 image 段(发真图不是路径)', async () => {
  // 本地路径 + URL 混合提取,文本清理
  const r1 = extractImageRefs('图在这: D:/x.png 和 https://a.com/b.jpg 都发一下')
  assert(r1.images.length === 2 && r1.images[0] === 'D:/x.png' && r1.images[1] === 'https://a.com/b.jpg', `应提取本地路径与 URL,实际:${JSON.stringify(r1)}`)
  assert(!r1.text.includes('D:/x.png') && !r1.text.includes('https://a.com/b.jpg'), '提取后文本应移除路径')
  assert(r1.text.includes('图在这') && r1.text.includes('都发一下'), '文本其余内容保留')
  // 括号包裹的路径
  const r2 = extractImageRefs('封面(D:/cover.jpg)已下载')
  assert(r2.images.length === 1 && r2.images[0] === 'D:/cover.jpg', `括号包裹应提取,实际:${JSON.stringify(r2)}`)
  assert(r2.text === '封面已下载', `括号移除后文本,实际:${r2.text}`)
  // URL 带查询参数完整保留
  const r3 = extractImageRefs('看这里 https://a.com/1.png?x=1&y=2 不错')
  assert(r3.images.length === 1 && r3.images[0] === 'https://a.com/1.png?x=1&y=2', `带查询参数 URL 应完整提取,实际:${JSON.stringify(r3)}`)
  // 无图片路径 → 原样
  const r4 = extractImageRefs('今天的比分 2:1')
  assert(r4.images.length === 0 && r4.text === '今天的比分 2:1', '无图片路径应原样')
  // 扩展名不匹配(如 .mp4)不提取
  const r5 = extractImageRefs('视频 D:/x.mp4 看')
  assert(r5.images.length === 0, '非图片扩展名不应提取')
  // 空输入
  assert(extractImageRefs('').images.length === 0 && extractImageRefs('  ').text === '', '空输入')
})

// ---------------------------------------------------------------------------
// 撤销 git 快照(2026-08-14 停止与撤销分离):注入式 git 执行器直测
// ---------------------------------------------------------------------------

/** 脚本化 git 执行器:按 args[0](+次参)匹配 handler,记录全部调用 */
function scriptedExec(
  handlers: Array<{ match: (args: string[]) => boolean; reply: (args: string[], cwd: string, env?: Record<string, string>) => string }>,
) {
  const calls: Array<{ args: string[]; cwd: string; env?: Record<string, string> }> = []
  const exec: GitExec = async (args, cwd, env) => {
    calls.push({ args, cwd, env })
    const h = handlers.find((x) => x.match(args))
    if (!h) throw new Error(`意外 git 命令:${args.join(' ')}`)
    return h.reply(args, cwd, env)
  }
  return { exec, calls }
}

await test('undo 快照:临时索引隐藏快照提交的命令序列与记录', async () => {
  const { exec, calls } = scriptedExec([
    { match: (a) => a[0] === 'rev-parse', reply: () => 'HEADSHA\n' },
    { match: (a) => a[0] === 'ls-files', reply: () => 'keep.txt\nsub/old.txt\n' },
    { match: (a) => a[0] === 'read-tree', reply: () => '' },
    { match: (a) => a[0] === 'add', reply: () => '' },
    { match: (a) => a[0] === 'write-tree', reply: () => 'TREESHA\n' },
    { match: (a) => a.includes('commit-tree'), reply: () => 'SNAPSHA\n' },
    { match: (a) => a[0] === 'update-ref', reply: () => '' },
  ])
  const recs = await snapshotWatchDirs(['/repo/a'], 'u-test-1', exec)
  assert(recs.length === 1 && recs[0].ok, `快照应成功,实际:${JSON.stringify(recs)}`)
  assert(recs[0].headSha === 'HEADSHA' && recs[0].snapSha === 'SNAPSHA', '应记录 headSha/snapSha')
  assert(JSON.stringify(recs[0].untracked) === JSON.stringify(['keep.txt', 'sub/old.txt']), '应记录未跟踪清单')
  // 命令顺序:基准 → 临时索引重建 → 快照提交 → 私有引用钉住
  // (commit-tree 带 -c 身份前缀,按 args 包含判定)
  const order = calls.map((c) => (c.args.includes('commit-tree') ? 'commit-tree' : c.args[0])).join(',')
  assert(
    order === 'rev-parse,ls-files,read-tree,add,write-tree,commit-tree,update-ref',
    `命令序列不符,实际:${order}`,
  )
  // 临时索引:read-tree/add/write-tree/commit-tree 都带 GIT_INDEX_FILE
  for (const c of calls.slice(2, 6)) {
    assert(!!c.env?.GIT_INDEX_FILE, `${c.args[0]} 应携带 GIT_INDEX_FILE(不碰用户真实索引)`)
  }
  // commit-tree 自带身份 + 挂 HEAD 为父;update-ref 钉到私有命名空间
  const ct = calls.find((c) => c.args.includes('commit-tree'))!.args
  assert(ct.includes('-p') && ct[ct.indexOf('-p') + 1] === 'HEADSHA', 'commit-tree 应挂 HEAD 为父')
  assert(ct.includes('user.name=island-undo') || ct.some((x) => x.startsWith('user.name=')), 'commit-tree 应自带身份')
  const ur = calls.find((c) => c.args[0] === 'update-ref')!.args
  assert(ur[1] === 'refs/island-undo/u-test-1' && ur[2] === 'SNAPSHA', `私有引用钉住快照,实际:${ur.join(' ')}`)
})

await test('undo 快照:非 git 目录/命令失败记 ok:false 不阻断其余目录', async () => {
  const { exec } = scriptedExec([
    { match: (a) => a[0] === 'rev-parse', reply: () => { throw new Error('fatal: not a git repository') } },
  ])
  const recs = await snapshotWatchDirs(['/not/repo'], 'u-test-2', exec)
  assert(recs.length === 1 && !recs[0].ok, '非 git 目录应 ok:false')
  assert(!!recs[0].reason && recs[0].reason.includes('not a git repository'), `应带原因,实际:${recs[0].reason}`)
  // 空目录列表直接返回空
  const empty = await snapshotWatchDirs([], 'u-test-2b', exec)
  assert(empty.length === 0, '空列表应返回空数组')
})

await test('undo 回滚:三步序列 + 未跟踪差集删除(只删该轮新建)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'island-undo-test-'))
  // 快照时的未跟踪文件 keep.txt 仍在;该轮新建 new-turn.txt 应被删
  await fs.writeFile(path.join(dir, 'keep.txt'), '快照前已有')
  await fs.writeFile(path.join(dir, 'new-turn.txt'), '该轮新建')
  const { exec, calls } = scriptedExec([
    { match: (a) => a[0] === 'reset' && a[1] === '--hard', reply: () => '' },
    { match: (a) => a[0] === 'restore', reply: () => '' },
    { match: (a) => a[0] === 'ls-files', reply: () => 'keep.txt\nnew-turn.txt\n' },
    { match: (a) => a[0] === 'update-ref', reply: () => '' },
  ])
  const rec = { dir, ok: true, headSha: 'HEADSHA', snapSha: 'SNAPSHA', untracked: ['keep.txt'] }
  const out = await restoreUndoSnapshot({ id: 'u-test-3', dirs: [rec] }, exec)
  assert(out.length === 1 && out[0].ok, `回滚应成功,实际:${JSON.stringify(out)}`)
  const order = calls.map((c) => c.args[0]).join(',')
  assert(order === 'reset,restore,ls-files,update-ref', `回滚序列不符,实际:${order}`)
  assert(JSON.stringify(calls[0].args) === JSON.stringify(['reset', '--hard', 'HEADSHA']), '第一步 reset 回快照前 HEAD')
  assert(calls[1].args.includes('--source=SNAPSHA') && calls[1].args.includes('--worktree'), '第二步 restore 还原脏改动')
  // 差集删除:new-turn.txt 被删,keep.txt 保留(不用 git clean)
  assert(!(await fs.access(path.join(dir, 'new-turn.txt')).then(() => true).catch(() => false)), '该轮新建文件应被删除')
  assert(await fs.access(path.join(dir, 'keep.txt')).then(() => true).catch(() => false), '快照时已有的未跟踪文件应保留')
  // 第四步释放私有引用
  assert(JSON.stringify(calls[3].args) === JSON.stringify(['update-ref', '-d', 'refs/island-undo/u-test-3']), '回滚后应释放私有引用')
  await fs.rm(dir, { recursive: true, force: true })
})

await test('undo 回滚:旧版 git 无 restore 回退 checkout + reset 复位索引', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'island-undo-test-'))
  const { exec, calls } = scriptedExec([
    { match: (a) => a[0] === 'reset' && a[1] === '--hard', reply: () => '' },
    { match: (a) => a[0] === 'restore', reply: () => { throw new Error('git: restore is not a git command') } },
    { match: (a) => a[0] === 'checkout', reply: () => '' },
    { match: (a) => a[0] === 'reset', reply: () => '' },
    { match: (a) => a[0] === 'ls-files', reply: () => '' },
    { match: (a) => a[0] === 'update-ref', reply: () => '' },
  ])
  const rec = { dir, ok: true, headSha: 'H', snapSha: 'S', untracked: [] }
  const out = await restoreUndoSnapshot({ id: 'u-test-4', dirs: [rec] }, exec)
  assert(out.length === 1 && out[0].ok, `兜底回滚应成功,实际:${JSON.stringify(out)}`)
  const order = calls.map((c) => c.args[0]).join(',')
  assert(order === 'reset,restore,checkout,reset,ls-files,update-ref', `兜底序列不符,实际:${order}`)
  const co = calls.find((c) => c.args[0] === 'checkout')!.args
  assert(co[1] === 'S' && co.includes('.'), `checkout 应还原快照提交,实际:${co.join(' ')}`)
  await fs.rm(dir, { recursive: true, force: true })
})

await test('undo 回滚:快照不完整(无 headSha/snapSha)拒绝执行不动仓库', async () => {
  const { exec, calls } = scriptedExec([])
  const out = await restoreUndoSnapshot(
    { id: 'u-test-5', dirs: [{ dir: '/repo/x', ok: false, reason: 'not a git repository' }] },
    exec,
  )
  assert(out.length === 1 && !out[0].ok && !!out[0].reason, '不完整记录应拒绝回滚')
  assert(calls.length === 0, '拒绝回滚不应发起任何 git 命令')
  // releaseUndoRef 尽力而为:失败不抛错
  await releaseUndoRef('/repo/x', 'u-gone', async () => { throw new Error('ref not found') })
})

// ---------------------------------------------------------------------------
// 插件内核与能力接缝(kernel / llm / tools / prompt,2026-08-14 插件化重构)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// LM Studio 文本工具调用幻觉解析(2026-08-19 修复本地模型不调工具)
// ---------------------------------------------------------------------------

await test('lms 文本工具解析:lfm2.5 特殊 token Python kwargs 格式', async () => {
  const { parseTextToolCalls } = await import('../electron/agent/providers/lmstudio-chat')
  const tools: AgentTool[] = [
    {
      name: 'bili',
      description: 'B站',
      execute: async () => 'ok',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['up_info', 'search', 'saved'] },
          query: { type: 'string' },
        },
      },
    },
  ]
  const text =
    "我来看看下载目录的情况。\n<|tool_call_start|>bili_tool(action='saved', params={'path': 'C:\\\\Users\\\\downloads'})<|tool_call_end|>"
  const parsed = parseTextToolCalls(text, tools)
  assert(parsed, '应解析出调用')
  assert(parsed!.calls.length === 1, '应有一个调用')
  assert(parsed!.calls[0]!.name === 'bili', 'bili_tool 应模糊匹配到 bili')
  assert(parsed!.calls[0]!.args.action === 'saved', 'action 应为 saved')
  assert(!('path' in parsed!.calls[0]!.args), '幻觉键 path 应被过滤')
  assert(parsed!.text.includes('我来看看'), '前导文本保留')
  assert(!parsed!.text.includes('tool_call'), '调用片段应从文本剥离')
})

await test('lms 文本工具解析:nanbeige markdown JSON 块 + 编造结果截断', async () => {
  const { parseTextToolCalls } = await import('../electron/agent/providers/lmstudio-chat')
  const tools: AgentTool[] = [
    {
      name: 'bili',
      description: 'B站',
      execute: async () => 'ok',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['up_info', 'search', 'saved'] },
          query: { type: 'string' },
          type: { type: 'string' },
        },
      },
    },
  ]
  const text =
    '好的,我来查看B站的本地下载目录～\n\n正在调用 Bili 工具:\n\n' +
    '```json\n{"action": "search", "params": {"type": "download_dir"}}\n```\n\n' +
    '---\n**结果**:\n- 本地下载目录路径(编造的假结果)\n\n✅ 已为你查看!'
  const parsed = parseTextToolCalls(text, tools)
  assert(parsed, '应解析出调用')
  assert(parsed!.calls[0]!.name === 'bili', 'action 枚举反查应命中 bili')
  assert(parsed!.calls[0]!.args.action === 'search', 'action 应提升平铺')
  assert(parsed!.calls[0]!.args.type === 'download_dir', 'params 应展开')
  assert(parsed!.text.includes('好的'), '前导文本保留')
  assert(!parsed!.text.includes('编造'), '编造结果应截断丢弃')
})

await test('lms 文本工具解析:普通 JSON 展示块不误判 / 无工具不介入', async () => {
  const { parseTextToolCalls } = await import('../electron/agent/providers/lmstudio-chat')
  const tools: AgentTool[] = [
    {
      name: 'bili',
      description: 'B站',
      execute: async () => 'ok',
      parameters: { type: 'object', properties: { action: { type: 'string', enum: ['search'] } } },
    },
  ]
  // 无工具特征键的 JSON 块(如配置展示)不应被解析为调用
  const a = parseTextToolCalls('配置如下:\n```json\n{"theme": "dark", "font": 14}\n```', tools)
  assert(a === null, '无 action/name 线索的 JSON 块不应误判')
  // 普通文本
  const b = parseTextToolCalls('今天天气不错,出去玩吧!', tools)
  assert(b === null, '普通文本不应误判')
  // tools 为空(Sub Agent jsonMode)不介入
  const c = parseTextToolCalls('{"action": "search"}', [])
  assert(c === null, '无注册工具时不介入')
})

await test('lms 文本工具解析:action 不在任何枚举时不强制匹配', async () => {
  const { parseTextToolCalls } = await import('../electron/agent/providers/lmstudio-chat')
  const tools: AgentTool[] = [
    {
      name: 'bili',
      description: 'B站',
      execute: async () => 'ok',
      parameters: { type: 'object', properties: { action: { type: 'string', enum: ['search'] } } },
    },
  ]
  const parsed = parseTextToolCalls('```json\n{"action": "nonexistent_action"}\n```', tools)
  assert(parsed === null, 'action 不在枚举内且无名称匹配时应放弃(不乱调)')
})

await test('lms 文本工具解析:lfm2.5 数组包裹 + Windows 路径反斜杠保留(实测回归)', async () => {
  const { parseTextToolCalls } = await import('../electron/agent/providers/lmstudio-chat')
  const tools: AgentTool[] = [
    {
      name: 'bili',
      description: 'B站',
      execute: async () => 'ok',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['up_info', 'search', 'saved'] },
          path: { type: 'string' },
        },
      },
    },
  ]
  // 用户实测原文(lfm2.5-2.6b):调用被方括号数组包裹 + 单反斜杠 Windows 路径
  const text =
    "<|tool_call_start|>[bili_tool(action='up_info', params={'path': 'C:\\Users\\asus\\AppData\\Roaming\\dynamic-island\\bili\\downloads'})]<|tool_call_end|>"
  const parsed = parseTextToolCalls(text, tools)
  assert(parsed, '数组包裹的 Python 调用应解析成功(旧解析器被前导 [ 卡住)')
  assert(parsed!.calls.length === 1 && parsed!.calls[0]!.name === 'bili', 'bili_tool 应模糊匹配 bili')
  assert(parsed!.calls[0]!.args.action === 'up_info', 'action 应为 up_info')
  assert(
    parsed!.calls[0]!.args.path === 'C:\\Users\\asus\\AppData\\Roaming\\dynamic-island\\bili\\downloads',
    'Windows 路径反斜杠应完整保留(旧实现丢反斜杠成 C:Users...)',
  )
  assert(parsed!.text === '', '整条消息即调用,正文应为空')
  // JSON 数组体同样支持:[{"name":"bili","arguments":{...}}]
  const arr = parseTextToolCalls(
    '<|tool_call_start|>[{"name": "bili", "arguments": {"action": "saved"}}]<|tool_call_end|>',
    tools,
  )
  assert(arr && arr.calls.length === 1 && arr.calls[0]!.name === 'bili', 'JSON 数组体应解析')
  assert(arr!.calls[0]!.args.action === 'saved', 'JSON 数组体参数应展开')
})

await test('lms 文本工具解析:通用包装 tool_call(name=..., arguments=裸字符串)(实测回归)', async () => {
  const { parseTextToolCalls } = await import('../electron/agent/providers/lmstudio-chat')
  const tools: AgentTool[] = [
    {
      name: 'bili',
      description: 'B站',
      execute: async () => 'ok',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['up_info', 'search', 'saved'] },
          query: { type: 'string' },
        },
      },
    },
  ]
  // 用户实测原文(lfm2.5-2.6b 二轮):通用包装函数 + 裸字符串 arguments
  const text = "<|tool_call_start|>[tool_call(name='bili-tool', arguments='up_info')]<|tool_call_end|>"
  const parsed = parseTextToolCalls(text, tools)
  assert(parsed, '通用包装格式应解析成功')
  assert(parsed!.calls.length === 1 && parsed!.calls[0]!.name === 'bili', 'name= 参数应提升为工具名并模糊匹配')
  assert(parsed!.calls[0]!.args.action === 'up_info', '裸字符串 arguments 应转为 action 值')
  // dict 形式的包装参数
  const dict = parseTextToolCalls(
    "<|tool_call_start|>[tool_call(name='bili', arguments={'action': 'search', 'query': 'test'})]<|tool_call_end|>",
    tools,
  )
  assert(dict && dict.calls[0]!.args.query === 'test', 'dict 形式 arguments 应展开')
  // JSON 字符串形式
  const jsonStr = parseTextToolCalls(
    `<|tool_call_start|>[tool_call(name='bili', arguments='{"action": "saved"}')]<|tool_call_end|>`,
    tools,
  )
  assert(jsonStr && jsonStr.calls[0]!.args.action === 'saved', 'JSON 字符串 arguments 应解析')
})

await test('lms 文本工具解析:引号键+冒号分隔+杂散引号(实测回归)', async () => {
  const { parseTextToolCalls } = await import('../electron/agent/providers/lmstudio-chat')
  const tools: AgentTool[] = [
    {
      name: 'read_file',
      description: '读文件',
      execute: async () => 'ok',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  ]
  // 用户实测原文(lfm2.5-2.6b 三轮):键带引号 + 冒号分隔 + 'arguments= 杂散引号
  const text =
    "<|tool_call_start|>[tool_call('name': 'read_file', 'arguments={'path': 'C:\\Users\\asus\\AppData\\Roaming\\dynamic-island\\memory.json'})]<|tool_call_end|>"
  const parsed = parseTextToolCalls(text, tools)
  assert(parsed, '引号键+冒号分隔格式应解析成功')
  assert(parsed!.calls.length === 1 && parsed!.calls[0]!.name === 'read_file', '应精确命中 read_file')
  assert(
    parsed!.calls[0]!.args.path === 'C:\\Users\\asus\\AppData\\Roaming\\dynamic-island\\memory.json',
    '路径反斜杠应完整保留',
  )
  // 混合:裸 kwargs 与引号键混用 + dict 风格冒号
  const mixed = parseTextToolCalls(
    "<|tool_call_start|>[tool_call(action='search', 'query': \"测试\")]<|tool_call_end|>",
    [{ name: 'bili', description: 'B站', execute: async () => 'ok', parameters: { type: 'object', properties: { action: { type: 'string', enum: ['search'] }, query: { type: 'string' } } } }],
  )
  assert(mixed && mixed.calls[0]!.name === 'bili' && mixed.calls[0]!.args.query === '测试', '混合键风格应解析')
})

await test('lms 流式标记过滤:工具调用指令不暴露到对话窗口(SSE)', async () => {
  const { StreamCallFilter } = await import('../electron/agent/providers/lmstudio-chat')
  // 模拟 SSE delta 序列:<tool_call> 跨 delta 分割 + 正文前后包裹
  const deltas = [
    '我来看看。',
    '<tool_', 'call>\n{"name": "bili", ', '"arguments": {"action": "up_info"}}\n', '</tool_', 'call>',
    '结果出来了。',
  ]
  const filter = new StreamCallFilter()
  const shown = deltas.map((d) => filter.feed(d)).join('') + filter.flush()
  assert(shown === '我来看看。结果出来了。', `调用段应被抑制,实际:${JSON.stringify(shown)}`)
})

await test('lms 流式标记过滤:特殊 token 与多段抑制', async () => {
  const { StreamCallFilter } = await import('../electron/agent/providers/lmstudio-chat')
  const filter = new StreamCallFilter()
  const shown =
    filter.feed('前文<|tool_call_start|>[bili(action=') +
    filter.feed("'up_info')]<|tool_call_end|>中文") +
    filter.feed('<tool_call>{"name":"x"}</tool_call>后文') +
    filter.flush()
  assert(shown === '前文中文后文', `两段调用都应抑制,实际:${JSON.stringify(shown)}`)
})

await test('lms 流式标记过滤:```json fence 闭合抑制/未闭合补发/普通文本直通', async () => {
  const { StreamCallFilter } = await import('../electron/agent/providers/lmstudio-chat')
  // 闭合 fence:抑制
  const a = new StreamCallFilter()
  const shownA = a.feed('看这个:\n```json\n{"action": "search"}\n```\n完事') + a.flush()
  assert(shownA === '看这个:\n\n完事', `闭合 fence 应抑制,实际:${JSON.stringify(shownA)}`)
  // 未闭合 fence:flush 补发(可能是普通展示块,不能丢)
  const b = new StreamCallFilter()
  const shownB = b.feed('配置:\n```json\n{"theme": "dark"}') + b.flush()
  assert(shownB === '配置:\n```json\n{"theme": "dark"}', '未闭合 fence 应补发不丢内容')
  // 普通文本(含反引号/代码块其他语言)直通
  const c = new StreamCallFilter()
  const shownC = c.feed('代码:\n```python\nprint(1)\n```\n完') + c.flush()
  assert(shownC === '代码:\n```python\nprint(1)\n```\n完', '非 json fence 不应误伤')
  // 无标记纯文本
  const d = new StreamCallFilter()
  const shownD = d.feed('今天天气') + d.feed('不错') + d.flush()
  assert(shownD === '今天天气不错', '普通文本直通')
})

await test('lms 流式标记过滤:未闭合调用标记丢弃 + parseTextToolCalls 一致剥离', async () => {
  const { StreamCallFilter, parseTextToolCalls } = await import('../electron/agent/providers/lmstudio-chat')
  const tools: AgentTool[] = [
    {
      name: 'bili',
      description: 'B站',
      execute: async () => 'ok',
      parameters: { type: 'object', properties: { action: { type: 'string', enum: ['search'] } } },
    },
  ]
  // 流截断:tool_call 只输出一半(流被 max tokens 掐断)
  const filter = new StreamCallFilter()
  const shown = filter.feed('我来查。<tool_call>\n{"name": "bi') + filter.flush()
  assert(shown === '我来查。', '未闭合调用标记应丢弃(半截调用无意义)')
  // parseTextToolCalls 对同款全文的剥离与 UI 一致
  const parsed = parseTextToolCalls('我来查。<tool_call>\n{"name": "bi', tools)
  assert(parsed === null, '未闭合段无法解析出调用')
  // 前面有闭合段 + 尾部未闭合:只剥尾部,闭合段正常解析(首片段在开头,
  // 其后正文按"截断到首个片段前"语义一并丢弃——防编造结果)
  const mixed = parseTextToolCalls(
    '<tool_call>{"name": "bili", "arguments": {"action": "search"}}</tool_call>正文<tool_call>{"na',
    tools,
  )
  assert(mixed && mixed.calls.length === 1 && mixed.text === '', '闭合段解析 + 未闭合尾部剥离')
})

await test('lms 工具闭环:<tool_call> 规范格式解析(指引引导输出)', async () => {
  const { parseTextToolCalls } = await import('../electron/agent/providers/lmstudio-chat')
  const tools: AgentTool[] = [
    {
      name: 'bili',
      description: 'B站',
      execute: async () => 'ok',
      parameters: {
        type: 'object',
        properties: { action: { type: 'string', enum: ['search', 'saved'] }, query: { type: 'string' } },
      },
    },
  ]
  const text = '我来查一下。\n<tool_call>\n{"name": "bili", "arguments": {"action": "search", "query": "花花卡"}}\n</tool_call>'
  const parsed = parseTextToolCalls(text, tools)
  assert(parsed, '应解析出调用')
  assert(parsed!.calls.length === 1 && parsed!.calls[0]!.name === 'bili', '应命中 bili')
  assert(parsed!.calls[0]!.args.action === 'search', 'arguments 应展开')
  assert(parsed!.calls[0]!.args.query === '花花卡', '参数应保留')
  assert(parsed!.text === '我来查一下。', '正文应截断到调用前')
  // Python 风格混用兜底
  const py = parseTextToolCalls('<tool_call>bili(action="search", query="x")</tool_call>', tools)
  assert(py && py.calls[0]!.name === 'bili', '非 JSON 的 Python 风格也应解析')
})

await test('lms 工具闭环:历史回传分流(伪调用转文本,协议调用保持原生)', async () => {
  const { lmstudioHistoryToMessages, TEXT_CALL_ID_PREFIX } = await import(
    '../electron/agent/providers/lmstudio-chat'
  )
  const history: AgentMessage[] = [
    {
      id: 'u1',
      role: 'user',
      parts: [{ type: 'text', text: '看看B站' }],
    },
    {
      id: 'a1',
      role: 'assistant',
      parts: [
        { type: 'text', text: '好的,我来查看' },
        // 文本解析伪调用(id 前缀标记)
        { type: 'tool-call', id: `${TEXT_CALL_ID_PREFIX}100-0`, name: 'bili', args: { action: 'search' } },
        { type: 'tool-result', id: `${TEXT_CALL_ID_PREFIX}100-0`, name: 'bili', ok: true, result: '真实工具结果', durationMs: 5 },
        // 协议通道真调用(无前缀)
        { type: 'tool-call', id: 'call-abc', name: 'web_search', args: { q: 'test' } },
        { type: 'tool-result', id: 'call-abc', name: 'web_search', ok: true, result: '协议工具结果', durationMs: 3 },
      ],
    },
  ]
  const msgs = await lmstudioHistoryToMessages(history)
  // assistant 消息:伪调用展开为 <tool_call> 回放,协议调用保留 tool_calls
  const assistant = msgs.find((m) => m.role === 'assistant') as Record<string, unknown>
  assert(assistant, '应有 assistant 消息')
  assert(String(assistant.content).includes('<tool_call>'), '伪调用应回放为 <tool_call> 文本')
  assert(String(assistant.content).includes('"bili"'), '回放应含工具名')
  const tcs = assistant.tool_calls as Array<Record<string, unknown>> | undefined
  assert(tcs && tcs.length === 1 && (tcs[0]!.id as string) === 'call-abc', '协议调用应保留 tool_calls 原生格式')
  // 伪调用结果 → user 消息 <tool_result>(template 不支持 role:'tool')
  const resultUser = msgs.find((m) => m.role === 'user' && String(m.content).includes('<tool_result>'))
  assert(resultUser && String(resultUser.content).includes('真实工具结果'), '伪调用结果应转 user 消息回传')
  // 协议调用结果 → role:'tool'
  const toolMsg = msgs.find((m) => m.role === 'tool') as Record<string, unknown> | undefined
  assert(toolMsg && toolMsg.tool_call_id === 'call-abc', '协议调用结果应保持 role:tool + tool_call_id')
})

// ---------------------------------------------------------------------------
// LM Studio GLM-4-9B 系适配(2026-08-19 GLM-4-9B-0414 实测:裸 Python 调用
// 当正文 + 编造工具结果;lmstudio-glm4.ts 独立档位,不影响其它模型)
// ---------------------------------------------------------------------------

/** GLM 测试用工具集(exec_command/bili/read_file——与真实 schema 对齐) */
function glm4TestTools(): AgentTool[] {
  return [
    {
      name: 'exec_command',
      description: '执行命令',
      execute: async () => 'ok',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          cwd: { type: 'string' },
          timeout: { type: 'number' },
        },
        required: ['command'],
      },
    },
    {
      name: 'bili',
      description: 'B站',
      execute: async () => 'ok',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['up_info', 'search', 'saved'] },
          query: { type: 'string' },
        },
      },
    },
    {
      name: 'read_file',
      description: '读文件',
      execute: async () => 'ok',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  ]
}

await test('lms GLM-4-9B:模型识别(glm49b 系命中,其它系不误判)', async () => {
  const { isGlm4Model } = await import('../electron/agent/providers/lmstudio-glm4')
  assert(isGlm4Model('glm-4-9b-chat-0414'), 'glm-4-9b-chat-0414 应命中')
  assert(isGlm4Model('glm-4-9b-chat'), 'glm-4-9b-chat 应命中')
  assert(isGlm4Model('THUDM/glm-4-9b-chat-0414'), '厂商前缀变体应命中')
  assert(isGlm4Model('glm-4-9b'), '基础名应命中')
  assert(!isGlm4Model('glm-4.6v-flash'), 'glm-4.6v 视觉系不应命中(独立档位)')
  assert(!isGlm4Model('glm-4.5-air'), 'glm-4.5 不应命中')
  assert(!isGlm4Model('qwen3-8b'), 'qwen 不应命中')
  assert(!isGlm4Model('nanbeige4.2-3b'), 'nanbeige 不应命中')
  assert(!isGlm4Model('lfm2.5-2.6b'), 'lfm 不应命中')
})

await test('lms GLM-4-9B:裸调用解析(用户实测原文:调用 + 编造结果 + 残片标签)', async () => {
  const { glm4ParseBareCalls } = await import('../electron/agent/providers/lmstudio-glm4')
  const tools = glm4TestTools()
  // 用户实测原文(GLM-4-9B-0414,问「我B站登录了吗」):
  // 裸 Python 调用 + 编造的 bili-tool.exe 输出 + </tool_result> 残片
  const text =
    'exec_command("bili-tool login/whoami")ili-tool.exe: -352, 二维码过期,请重新生成并扫码确认\n</tool_result>'
  const parsed = glm4ParseBareCalls(text, tools)
  assert(parsed, '裸调用应解析成功')
  assert(parsed!.calls.length === 1 && parsed!.calls[0]!.name === 'exec_command', '应命中 exec_command')
  assert(parsed!.calls[0]!.args.command === 'bili-tool login/whoami', '位置参数应映射主参数 command')
  assert(parsed!.text === '', '正文应截断到调用前(编造结果与残片全丢)')
})

await test('lms GLM-4-9B:kwargs / 位置参数 / 路径反斜杠 / 嵌套提升', async () => {
  const { glm4ParseBareCalls } = await import('../electron/agent/providers/lmstudio-glm4')
  const tools = glm4TestTools()
  // kwargs 风格
  const a = glm4ParseBareCalls('我来查。exec_command(command="bili-tool whoami")', tools)
  assert(a && a.calls[0]!.name === 'exec_command' && a.calls[0]!.args.command === 'bili-tool whoami', 'kwargs 应解析')
  assert(a!.text === '我来查。', '前导文本保留')
  // 位置参数 + Windows 路径(单反斜杠原样保留)
  const b = glm4ParseBareCalls('read_file("C:\\Users\\asus\\bili\\downloads")', tools)
  assert(b && b.calls[0]!.args.path === 'C:\\Users\\asus\\bili\\downloads', '位置参数→path,反斜杠完整保留')
  // params 嵌套提升 + 单引号 dict
  const c = glm4ParseBareCalls("bili(action='search', params={'query': '花花卡'})", tools)
  assert(c && c.calls[0]!.name === 'bili' && c.calls[0]!.args.query === '花花卡', '嵌套 params 应展开')
  // 同义词归一(read_file(file_path=...) → path)
  const d = glm4ParseBareCalls('read_file(file_path="C:\\test.txt")', tools)
  assert(d && d.calls[0]!.args.path === 'C:\\test.txt', 'file_path 同义词应归一到 path')
  // 混合:kwargs + 前导中文文本 + 调用后编造结果截断
  const e = glm4ParseBareCalls('好的。\nbili(action="search", query="天气")\n结果: sunny(编造)', tools)
  assert(e && e.text === '好的。', '调用后编造结果应截断')
})

await test('lms GLM-4-9B:防误判(未注册名/散文括号/带空格括号/未闭合)', async () => {
  const { glm4ParseBareCalls } = await import('../electron/agent/providers/lmstudio-glm4')
  const tools = glm4TestTools()
  // 未注册工具名(print)不触发
  assert(glm4ParseBareCalls('print("hello world")', tools) === null, '未注册名不应误判')
  // 工具名与括号间有空白(散文形态)不触发——防真实命令误执行
  assert(glm4ParseBareCalls('exec_command (see docs) 是一个工具', tools) === null, '带空格括号不应触发')
  // 词中拼接(notexec_command)不触发
  assert(glm4ParseBareCalls('notexec_command("x")', tools) === null, '词中拼接不应触发')
  // 未闭合(流截断半截调用)返回 null,交上层剥离路径
  assert(glm4ParseBareCalls('exec_command("bili-tool who', tools) === null, '未闭合调用不应产出')
  // 普通文本
  assert(glm4ParseBareCalls('今天天气不错', tools) === null, '普通文本不误判')
})

await test('lms GLM-4-9B:流式防护(裸调用段抑制 + 标记对抑制 + 一致性)', async () => {
  const { Glm4StreamGuard } = await import('../electron/agent/providers/lmstudio-glm4')
  const names = ['exec_command', 'bili', 'read_file']
  // ① 裸调用跨 delta 分割:调用段抑制,前后正文照常
  const a = new Glm4StreamGuard(names)
  const shownA =
    a.feed('我查一下。\nexec_') +
    a.feed('command("bili-tool login/whoami")ili-tool.exe: -352, 二维码过期') +
    a.feed('\n</tool_result>') +
    a.flush()
  assert(shownA === '我查一下。\n', `裸调用段应抑制,实际:${JSON.stringify(shownA)}`)
  assert(a.suppressedChars > 0, '抑制字符应计数(防静默空回复)')
  // ② <tool_call> 标记对抑制(与共享过滤器同款行为)
  const b = new Glm4StreamGuard(names)
  const shownB =
    b.feed('前文<tool_') +
    b.feed('call>{"name": "bili", "arguments": {"action": "search"}}</tool_') +
    b.feed('call>后文') +
    b.flush()
  assert(shownB === '前文后文', `标记对应抑制,实际:${JSON.stringify(shownB)}`)
  // ③ 未闭合裸调用(流截断):flush 丢弃,与落定解析返回 null 一致
  const c = new Glm4StreamGuard(names)
  const shownC = c.feed('我来查。exec_command("bili-tool who') + c.flush()
  assert(shownC === '我来查。', '未闭合裸调用应丢弃')
  // ④ 伪边界防护:"not"+"exec_command(" 跨 delta 拼接不得命中
  const d = new Glm4StreamGuard(names)
  const shownD = d.feed('not') + d.feed('exec_command("x")') + d.flush()
  assert(shownD === 'notexec_command("x")', '词尾拼接的伪边界不应抑制')
  // ⑤ 普通文本直通(含 ```python 代码示例不误伤)
  const e = new Glm4StreamGuard(names)
  const shownE = e.feed('代码:\n```python\nprint(1)\n```\n完') + e.flush()
  assert(shownE === '代码:\n```python\nprint(1)\n```\n完', '普通代码示例不应误伤')
  // ⑥ 未闭合 ```json fence:flush 补发(展示块不能丢)
  const f = new Glm4StreamGuard(names)
  const shownF = f.feed('配置:\n```json\n{"theme": "dark"}') + f.flush()
  assert(shownF === '配置:\n```json\n{"theme": "dark"}', '未闭合 fence 应补发')
})

await test('lms GLM-4-9B:正文残片清洗(编造结果整对丢弃 + 孤立标签移除)', async () => {
  const { glm4SanitizeText } = await import('../electron/agent/providers/lmstudio-glm4')
  // 整对 <tool_result>(编造结果):内容 + 标签整体丢弃
  const a = glm4SanitizeText('根据查询:\n<tool_result>\nbili-tool.exe: 登录成功\n</tool_result>\n以上')
  assert(a === '根据查询:\n\n以上', `编造结果整对应丢弃,实际:${JSON.stringify(a)}`)
  // 孤立残片标签移除(实测 </tool_result> 回声)
  const b = glm4SanitizeText('查询完成。</tool_result>')
  assert(b === '查询完成。', '孤立闭合标签应移除')
  // 混合残片
  const c = glm4SanitizeText('好的。</tool_call><|tool_call_end|><tool_result>')
  assert(c === '好的。', '各类残片标签应移除')
  // 无标签文本不动
  const d = glm4SanitizeText('正常回复,含 100% 与 <b>HTML</b>')
  assert(d === '正常回复,含 100% 与 <b>HTML</b>', '普通文本不应误伤')
})

await test('lms GLM-4-9B:裸 bili-tool CLI 转写为 bili 工具调用(二轮实测回归)', async () => {
  const { glm4ParseBareCalls, GLM4_TOOL_GUIDE_ADDON } = await import(
    '../electron/agent/providers/lmstudio-glm4'
  )
  const tools = glm4TestTools()
  // 二轮实测形态:模型受系统提示 CLI 用法引导,输出 exec_command 包装的
  // 裸 bili-tool 命令(不在 PATH 必失败)——转写为 bili 工具调用
  // 无 bili 工具注册(仅 exec_command):不转写,保持原调用
  const a = glm4ParseBareCalls('exec_command("bili-tool login --json")', [tools[0]!])
  assert(a && a.calls[0]!.name === 'exec_command', '无 bili 工具注册时不应转写')
  // 真实同款工具集(bili 含 login/whoami 枚举)
  const realBili: AgentTool = {
    name: 'bili',
    description: 'B站',
    execute: async () => 'ok',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['login', 'whoami', 'search', 'saved'] },
        query: { type: 'string' },
      },
    },
  }
  const b = glm4ParseBareCalls('exec_command("bili-tool login --json")', [tools[0]!, realBili])
  assert(b && b.calls[0]!.name === 'bili' && b.calls[0]!.args.action === 'login', '裸 login CLI 应转写为 bili(action=login)')
  assert(!('query' in (b!.calls[0]!.args ?? {})), '--json flag 应丢弃')
  const c = glm4ParseBareCalls('exec_command("bili-tool.exe whoami")', [tools[0]!, realBili])
  assert(c && c.calls[0]!.name === 'bili' && c.calls[0]!.args.action === 'whoami', '.exe 变体也应转写')
  const d = glm4ParseBareCalls('exec_command("bili-tool search 花花卡 --json")', [tools[0]!, realBili])
  assert(
    d && d.calls[0]!.name === 'bili' && d.calls[0]!.args.action === 'search' && d.calls[0]!.args.query === '花花卡',
    '位置参数应映射 query',
  )
  // 不转写的边界:幻觉 action / 带完整路径(模型已写全路径,执行可成功)
  const e = glm4ParseBareCalls('exec_command("bili-tool notanaction")', [tools[0]!, realBili])
  assert(e && e.calls[0]!.name === 'exec_command', '幻觉 action 不应转写')
  const f = glm4ParseBareCalls(
    'exec_command("C:\\tools\\bili\\bili-tool.exe login")',
    [tools[0]!, realBili],
  )
  assert(f && f.calls[0]!.name === 'exec_command', '完整路径命令应保持原样(可执行成功)')
  // 指引防回归:不得再示范 exec_command 跑 bili-tool CLI(禁止性说明除外)
  assert(
    !/exec_command\((command\s*=\s*)?"bili-tool/.test(GLM4_TOOL_GUIDE_ADDON),
    '指引不得示范 exec_command 跑 bili-tool CLI(防有害示范回归)',
  )
  assert(GLM4_TOOL_GUIDE_ADDON.includes('bili(action='), '指引示例应示范直接调用注册工具')
})

await test('lms GLM-4-9B:适配独立(共享解析器对 GLM 形态保持原行为不受影响)', async () => {
  const { parseTextToolCalls } = await import('../electron/agent/providers/lmstudio-chat')
  const tools = glm4TestTools()
  // 共享四通道(特殊 token/<tool_call>/fence/裸 JSON 行)对裸 Python 调用
  // 不命中(这正是 GLM 档位第五通道存在的原因)——确认共享解析不被改动
  const bare = 'exec_command("bili-tool login/whoami")ili-tool.exe: -352'
  assert(parseTextToolCalls(bare, tools) === null, '共享解析器对裸调用应保持不命中(GLM 档位接管)')
  // 共享通道的既有行为不受 GLM 模块影响(<tool_call> 规范格式照常解析)
  const xml = parseTextToolCalls('<tool_call>{"name": "bili", "arguments": {"action": "search"}}</tool_call>', tools)
  assert(xml && xml.calls[0]!.name === 'bili', '共享 <tool_call> 通道应不受影响')
  // 普通文本/普通 JSON 展示块不误判(回归)
  assert(parseTextToolCalls('今天天气不错', tools) === null, '普通文本不误判(回归)')
  assert(
    parseTextToolCalls('配置:\n```json\n{"theme": "dark"}\n```', tools) === null,
    '普通 JSON 展示块不误判(回归)',
  )
})

await test('lms 视觉消息构造:vision 模型图片 → content 数组,文本模型保持纯文本', async () => {
  const { lmstudioHistoryToMessages, isVisionModel } = await import(
    '../electron/agent/providers/lmstudio-chat'
  )
  // 模型识别:视觉系命中 / 文本系不误判
  assert(isVisionModel('glm-4.6v-flash'), 'glm-4.6v 应识别为视觉模型')
  assert(isVisionModel('Qwen2.5-VL-7B-Instruct'), 'qwen vl 应识别为视觉模型')
  assert(isVisionModel('zai-org/glm-4.6v-flash'), '带 org 前缀也应命中')
  assert(!isVisionModel('glm-4.7-flash'), 'glm-4.7-flash 文本模型不应误判')
  assert(!isVisionModel('lfm2.5-2.6b'), 'lfm 不应误判')
  assert(!isVisionModel('qwen3-8b'), 'qwen3-8b 不应误判')
  // 本地图片文件(1x1 PNG)→ media part;image part 直取 dataUrl
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  )
  const imgPath = path.join(tmp, 'vision-test.png')
  await fs.writeFile(imgPath, png)
  const history: AgentMessage[] = [
    {
      id: 'u1',
      role: 'user',
      parts: [
        { type: 'text', text: '看看这张图' },
        { type: 'media', kind: 'img', url: imgPath, name: '附件1' },
        { type: 'image', dataUrl: 'data:image/png;base64,aGVsbG8=' },
        // 非图片媒体不参与
        { type: 'media', kind: 'video', url: path.join(tmp, 'v.mp4') },
      ],
    },
  ]
  // vision 模型:content 数组(text + 2 个 image_url,video 不参与)
  const vmsgs = await lmstudioHistoryToMessages(history, 'glm-4.6v-flash')
  const vuser = vmsgs[0] as { role: string; content: Array<Record<string, unknown>> }
  assert(Array.isArray(vuser.content), 'vision 模型 content 应为数组')
  const textPart = vuser.content.find((c) => c.type === 'text') as { text: string }
  assert(textPart && textPart.text === '看看这张图', 'text part 应保留')
  const imgParts = vuser.content.filter((c) => c.type === 'image_url')
  assert(imgParts.length === 2, 'media(img)+image 两图都应构造 image_url,video 不参与')
  const firstUrl = (imgParts[0]!.image_url as { url: string }).url
  assert(firstUrl.startsWith('data:image/png;base64,'), '本地图片应读文件转 dataUrl')
  assert(firstUrl.endsWith(png.toString('base64')), 'base64 内容应与源文件一致')
  const secondUrl = (imgParts[1]!.image_url as { url: string }).url
  assert(secondUrl === 'data:image/png;base64,aGVsbG8=', 'image part 的 dataUrl 应直取')
  // 纯文本消息(vision 模型无图):保持字符串
  const pure = await lmstudioHistoryToMessages(
    [{ id: 'u2', role: 'user', parts: [{ type: 'text', text: '你好' }] }],
    'glm-4.6v-flash',
  )
  assert(typeof pure[0]!.content === 'string', 'vision 模型无图消息应保持纯字符串 content')
  // 文本模型(有图):保持纯字符串(现状不破坏)
  const tmsgs = await lmstudioHistoryToMessages(history, 'glm-4.7-flash')
  assert(typeof tmsgs[0]!.content === 'string', '非 vision 模型应保持纯字符串 content')
  assert((tmsgs[0]!.content as string).includes('看看这张图'), '文本内容应保留')
  // 路径不存在的图:跳过不报错,退回纯文本
  const bad = await lmstudioHistoryToMessages(
    [
      {
        id: 'u3',
        role: 'user',
        parts: [
          { type: 'text', text: '坏图' },
          { type: 'media', kind: 'img', url: path.join(tmp, 'not-exist.png') },
        ],
      },
    ],
    'glm-4.6v-flash',
  )
  assert(typeof bad[0]!.content === 'string' && (bad[0]!.content as string) === '坏图', '读失败的图应跳过并退回纯文本')
})

// === 智谱 GLM 云端文档工具 execute 层严格回归(2026-08-19 补齐) ===
// tools-glm.ts 内部用全局 fetch(glmPostForm/glmGet)。测试临时替换
// globalThis.fetch 返回假响应,验证凭据/文件/参数校验与成功路径(含
// glm_ocr 格式化、glm_file_parse sync/async 与 12000 截断)。execute 层是
// test-agent-core 此前唯一未覆盖这两个新增工具的缺口。

/** 覆盖全局 fetch,mock 一个 URL → Response 映射 */
function mockFetch(routes: Record<string, () => unknown>): () => void {
  const orig = globalThis.fetch
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input)
    const hit = routes[url.split('?')[0]!]
    if (!hit) return new Response(JSON.stringify({ error: { code: '4040', message: 'no route' } }), { status: 404, headers: { 'content-type': 'application/json' } })
    const body = hit()
    // 非 2xx 用 status 错误映射验证
    const isFail = body === '__FAIL_503__'
    return new Response(isFail ? JSON.stringify({ error: { code: '', message: 'busy' } }) : JSON.stringify(body), {
      status: isFail ? 503 : 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  return () => {
    globalThis.fetch = orig
  }
}

await test('glm_ocr:未配置 API Key → 报错引导在设置页填写(不隐藏工具)', async () => {
  const tools = createTools({ onSwitchToMusic: () => {}, getGlmCreds: () => null })
  const t = tools.find((x) => x.name === 'glm_ocr')
  assert(t, '应注册 glm_ocr')
  await assertRejects(() => t!.execute({ path: 'C:\\a.png' }), 'API Key 未配置', '缺凭据应引导填写')
})
await test('glm_file_parse:未配置 API Key → 同样引导报错', async () => {
  const tools = createTools({ onSwitchToMusic: () => {}, getGlmCreds: () => null })
  const t = tools.find((x) => x.name === 'glm_file_parse')
  assert(t, '应注册 glm_file_parse')
  await assertRejects(() => t!.execute({ path: 'C:\\a.pdf' }), 'API Key 未配置', '缺凭据应引导填写')
})
await test('glm_ocr:path 为空/文件不存在/非法 language_type 校验', async () => {
    const tools = createTools({
      onSwitchToMusic: () => {},
      getGlmCreds: () => ({ apiKey: 'sk-test', baseURL: 'https://open.bigmodel.cn/api/paas/v4' }),
    })
    const t = tools.find((x) => x.name === 'glm_ocr')!
    // 以下校验均在发起 fetch 前抛出,不需要 mock 路由
    await assertRejects(() => t.execute({ path: '' }), 'path 不能为空', '空 path 应拒绝')
    await assertRejects(() => t.execute({ path: path.join(tmp, 'nope.png') }), '文件不存在', '不存在应拒绝')
    await assertRejects(() => t.execute({ path: path.join(tmp, 'nope.png'), language_type: 'XX' }), 'language_type', '非法语言应拒绝')
  })
await test('glm_file_parse:不支持扩展名/超 50MB/不存在的约束', async () => {
  const restore = mockFetch({})
  try {
    const tools = createTools({
      onSwitchToMusic: () => {},
      getGlmCreds: () => ({ apiKey: 'sk-test', baseURL: 'https://open.bigmodel.cn/api/paas/v4' }),
    })
    const t = tools.find((x) => x.name === 'glm_file_parse')!
    await assertRejects(() => t.execute({ path: path.join(tmp, 'a.xyz') }), '不支持的文件类型', '未知扩展名应拒绝')
    await assertRejects(() => t.execute({ path: path.join(tmp, 'not-exist.pdf') }), '文件不存在', '不存在应拒绝')
    // 超 50MB
    const bigPdf = path.join(tmp, 'big.pdf')
    await fs.writeFile(bigPdf, Buffer.alloc(51 * 1024 * 1024))
    await assertRejects(() => t.execute({ path: bigPdf }), '文件过大', '超 50MB 应拒绝')
    await fs.rm(bigPdf, { force: true }).catch(() => {})
  } finally {
    restore()
  }
})
await test('glm_ocr:成功路径格式化(逐块文字 + 置信度);服务端 failed 报错', async () => {
  const api = 'https://open.bigmodel.cn/api/paas/v4'
  const restore = mockFetch({
    [`${api}/files/ocr`]: () => ({
      status: 'done',
      words_result_num: 2,
      words_result: [
        { words: '你好世界' },
        { words: '手写笔记', probability: { average: 0.92 } },
      ],
    }),
  })
  try {
    const tools = createTools({
      onSwitchToMusic: () => {},
      getGlmCreds: () => ({ apiKey: 'sk-test', baseURL: api }),
    })
    const t = tools.find((x) => x.name === 'glm_ocr')!
    await fs.writeFile(path.join(tmp, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const out = String(await t.execute({ path: path.join(tmp, 'shot.png'), probability: true }))
    assert(out.includes('你好世界') && out.includes('手写笔记'), '应输出识别文字')
    assert(out.includes('92%'), '应输出置信度(average 0.92)')
  } finally {
    await fs.rm(path.join(tmp, 'shot.png'), { force: true }).catch(() => {})
    restore()
  }
})
await test('glm_file_parse:sync 成功 + 12000 字符截断;async 轮询 succeeded/failed', async () => {
  const api = 'https://open.bigmodel.cn/api/paas/v4'
  const longText = 'x'.repeat(20000)
  const routes: Record<string, () => unknown> = {
    [`${api}/files/parser/sync`]: () => ({ status: 'done', content: longText }),
    [`${api}/files/parser/create`]: () => ({ status: 'created', task_id: 'task-1' }),
    [`${api}/files/parser/result/task-1/text`]: () => ({ status: 'succeeded', content: 'PDF 摘要文本' }),
  }
  const restore = mockFetch(routes)
  try {
    const tools = createTools({
      onSwitchToMusic: () => {},
      getGlmCreds: () => ({ apiKey: 'sk-test', baseURL: api }),
    })
    const t = tools.find((x) => x.name === 'glm_file_parse')!
    await fs.writeFile(path.join(tmp, 'doc.pdf'), Buffer.from([0x25, 0x50, 0x44, 0x46]))
    // sync:超长截断
    const out = String(await t.execute({ path: path.join(tmp, 'doc.pdf'), mode: 'sync' }))
    assert(out.includes('已截断到 12000 字符') && !out.includes('x'.repeat(13000)), 'sync 超长应截断到 12000')
    // async:轮询成功
    const aout = String(await t.execute({ path: path.join(tmp, 'doc.pdf'), mode: 'async', tool_type: 'lite' }))
    assert(aout.includes('PDF 摘要文本'), 'async 应轮询返回解析文本')
  } finally {
    await fs.rm(path.join(tmp, 'doc.pdf'), { force: true }).catch(() => {})
    restore()
  }
})
await test('glm_file_parse:async 服务端 failed → 报错;expert 仅 PDF', async () => {
  const api = 'https://open.bigmodel.cn/api/paas/v4'
  const restore = mockFetch({
    [`${api}/files/parser/create`]: () => ({ status: 'failed', message: '解析引擎错误' }),
  })
  try {
    const tools = createTools({
      onSwitchToMusic: () => {},
      getGlmCreds: () => ({ apiKey: 'sk-test', baseURL: api }),
    })
    const t = tools.find((x) => x.name === 'glm_file_parse')!
    await fs.writeFile(path.join(tmp, 'ex.pdf'), Buffer.from([0x25, 0x50, 0x44, 0x46]))
    await fs.writeFile(path.join(tmp, 'ex.txt'), 'hello')
    // expert 仅 PDF
    await assertRejects(() => t.execute({ path: path.join(tmp, 'ex.txt'), mode: 'async', tool_type: 'expert' }), 'expert', 'expert 非 PDF 应拒绝')
    // 服务端 failed(create 阶段返回 failed → 任务创建失败)
    await assertRejects(() => t.execute({ path: path.join(tmp, 'ex.pdf'), mode: 'async', tool_type: 'lite' }), '任务创建失败', '服务端 failed 应报错')
  } finally {
    await fs.rm(path.join(tmp, 'ex.pdf'), { force: true }).catch(() => {})
    await fs.rm(path.join(tmp, 'ex.txt'), { force: true }).catch(() => {})
    restore()
  }
})

await runPluginKernelTests({ test, assert, assertRejects })

// ---------------------------------------------------------------------------
// 收尾
// ---------------------------------------------------------------------------

killProc(sseStd.proc)
killProc(sseDirect.proc)
killProc(sseBare.proc)
// 清理临时目录
await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})

console.log(`\n===== 测试结果:${passed} 通过 / ${failed} 失败 =====`)
if (failed > 0) {
  console.error('\n失败用例:')
  for (const f of failures) console.error(`- ${f}`)
  process.exitCode = 1
}
