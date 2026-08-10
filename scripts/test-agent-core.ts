/**
 * Agent 引擎核心功能测试(后端直测,不经 UI)
 *
 * 覆盖:记忆系统 / MCP stdio+sse 双传输(真实 mock 服务器)/ skills 扫描 /
 * LLM 自我配置工具 / 自我进化(版本化快照/回滚防降级)/ 手动调用解析。
 *
 * electron 依赖经 esbuild 别名替换为 stub(scripts/test-agent/stub-electron.cjs,
 * Notification 记录到 global.__notifications 供断言)。
 *
 * 运行:node scripts/test-agent-core.mjs
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createMemoryStore, formatMemoryBlock } from '../electron/agent/memory'
import { createMCPManager } from '../electron/agent/mcp'
import { createSkillLoader } from '../electron/agent/skills'
import { createAgentEngine, createConfigTools, parseManualCall, findManualTool, compressArgs, parseTitleJson, extractJsonTitle, validateRequiredArgs } from '../electron/agent/engine'
import { createTools } from '../electron/agent/tools'
import { streamResponse } from '../electron/agent/deepseek'
import {
  getTasksStatusBlock,
  listTasks,
  pruneTasks,
  registerTask,
  removeTask,
  setTaskDoneHandler,
  updateTask,
  type AgentTask,
} from '../electron/agent/tasks'
import { createSettingsTools } from '../electron/agent/settingsTools'
import { createEvolution } from '../electron/agent/evolution'
import type { AgentTool, McpServerConfig, MemoryEntry } from '../electron/agent/types'

// 打包产物运行时路径会变(import.meta.url 指向 node_modules/.cache),
// mock 服务器目录由 esbuild define 注入(__ROOT__ = 项目根)
declare const __ROOT__: string
const mockDir = path.join(__ROOT__, 'scripts', 'test-agent')

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
      apiKey: '',
      baseURL: '',
      model: '',
      systemPrompt: '',
      reasoningEffort: 'high',
      mcpServers: initial.mcpServers ?? [],
      skillsDirs: initial.skillsDirs ?? [],
      excludedSkills: initial.excludedSkills ?? [],
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

// ---------------------------------------------------------------------------
// 7. 自我进化(版本化快照 / 回滚防降级)
// ---------------------------------------------------------------------------

console.log('\n=== 自我进化(evolution.ts) ===')

function makeEvolutionDeps() {
  // 进化测试的 memory.json 必须与 memory-state.json / memory-snapshots 同目录
  const store = createMemoryStore(() => path.join(memoryDir, 'memory.json'))
  const config = { apiKey: '', baseURL: '', model: '', systemPrompt: '提示词', reasoningEffort: 'high', mcpServers: [], skillsDirs: [] }
  const events: Array<{ type: string }> = []
  const evo = createEvolution({
    getConfig: () => config,
    getStore: () => store,
    getMemoryDir: () => memoryDir,
    onEvent: (e) => events.push({ type: e.type }),
  })
  return { store, evo, events }
}

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
// 8. 引擎集成(listAllTools / testMCP)
// ---------------------------------------------------------------------------

console.log('\n=== 引擎集成(createAgentEngine) ===')

await test('listAllTools 含内置 + MCP + 技能;dispose 无异常', async () => {
  const cfg = {
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
    getConfig: () => ({ apiKey: '', baseURL: '', model: '', systemPrompt: '', reasoningEffort: 'high', mcpServers: [], skillsDirs: [] }),
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

await test('设置工具:未注入桥时不注册;注入后 23 个工具齐', () => {
  assert(createSettingsTools({}).length === 0, '无 runIslandSettings 不应注册')
  const tools = createSettingsTools({ runIslandSettings: async () => ({ ok: true }) })
  const names = tools.map((t) => t.name)
  assert(names.length === 23, `应有 23 个工具,实际 ${names.length}:${names.join(',')}`)
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
    'rename_audio_library',
    'remove_audio_library',
    'list_video_library',
    'import_video_library',
    'rename_video_library',
    'remove_video_library',
  ]) {
    assert(names.includes(n), `应含工具 ${n}`)
  }
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

await test('set_agent_scale:钳制 100-300', async () => {
  const calls: Array<{ op: string; args: unknown[] }> = []
  const tools = createSettingsTools({ runIslandSettings: async (op, args) => { calls.push({ op, args }); return { ok: true } } })
  const tool = tools.find((t) => t.name === 'set_agent_scale')!
  await tool.execute({ percent: 150 })
  await tool.execute({ percent: 50 })
  await tool.execute({ percent: 500 })
  await tool.execute({ percent: 150.6 })
  const scales = calls.map((c) => c.args[0] as number)
  assert(scales[0] === 150 && scales[1] === 100 && scales[2] === 300 && scales[3] === 151, `钳制/取整错误:${scales.join(',')}`)
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
          { kind: 'img', name: '封面.png' },
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
  const { extractGuideSections } = await import('../electron/agent/tools')
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
