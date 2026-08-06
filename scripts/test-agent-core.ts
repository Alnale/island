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
import { createAgentEngine, createConfigTools, parseManualCall, findManualTool, compressArgs, parseTitleJson, extractJsonTitle } from '../electron/agent/engine'
import { createSettingsTools } from '../electron/agent/settingsTools'
import { createEvolution } from '../electron/agent/evolution'
import type { AgentTool, MemoryEntry } from '../electron/agent/types'

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
    const out = await echo.execute({ input: '你好世界' })
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
    const out = await image.execute({})
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
    const out = await echo.execute({ input: '重启后' })
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
    const out = await echo.execute({ text: 'sse你好' })
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
    const out = await echo.execute({ text: 'direct' })
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
    const out = await echo.execute({ text: 'bare' })
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
  const out = await note.execute({})
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
  initial: { mcpServers?: unknown[]; skillsDirs?: string[]; excludedSkills?: string[] } = {},
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
  const out = await mcp.execute({
    action: 'add',
    name: 'filesystem',
    command: 'npx -y @modelcontextprotocol/server-filesystem',
    args: ['C:/dir', 'D:/dir'],
    env: { TOKEN: 'abc' },
  })
  assert(out.includes('filesystem'), 'add 结果应含服务名')
  assert(writes.length === 1, '应写一次配置')
  const servers = writes[0].mcpServers as Array<Record<string, unknown>>
  assert(servers.length === 1 && servers[0].name === 'filesystem', '服务名应写入')
  assert(servers[0].type === 'stdio' && servers[0].command.includes('npx'), 'stdio 字段应写入')
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
  const out = await mcp.execute({ action: 'add', name: 'remote', type: 'sse', url: 'https://example.com/mcp/sse' })
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
  const out = await mcp.execute({ action: 'test', name: 'ok-server' })
  assert(out.includes('3 个工具'), `test 应返回工具数,实际:${out}`)
})

await test('skills_config add/remove/list', async () => {
  const { writes, tools } = makeConfigToolsDeps()
  const sc = tools.find((t) => t.name === 'skills_config')!
  const addOut = await sc.execute({ action: 'add', dir: 'C:/skills' })
  assert(addOut.includes('C:/skills'), 'add 结果应含目录')
  const lastWrite = writes[writes.length - 1]
  assert(lastWrite !== undefined, '应有写入记录')
  assert((lastWrite.skillsDirs as string[]).includes('C:/skills'), '应写入 skillsDirs')
  const dup = await sc.execute({ action: 'add', dir: 'C:/skills' })
  assert(dup.includes('已存在'), '重复 add 应提示已存在')
  const removeOut = await sc.execute({ action: 'remove', dir: 'C:/skills' })
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
  const listOut = await sc.execute({ action: 'list' })
  assert(listOut.includes('note-taking') && listOut.includes('trump-perspective'), 'list 应列出注册技能')
  // exclude 已注册技能 → 写入 excludedSkills
  const exOut = await sc.execute({ action: 'exclude', skill: 'note-taking' })
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
  const inOut = await sc.execute({ action: 'include', skill: 'note-taking' })
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
  const out = await sc.execute({
    action: 'create',
    name: 'My Great Skill',
    description: '处理XX任务的技能,用于XX场景',
    content: '# My Skill\n\n步骤 1: 做A\n步骤 2: 做B',
  })
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
  const overwriteOut = await sc.execute({
    action: 'create',
    name: 'my-great-skill',
    description: '新描述',
    content: '新内容',
    overwrite: true,
  })
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
  const out2 = await sc.execute({ action: 'create', name: '测试 SKILL X!', description: 'd', content: 'c' })
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
  globalThis.__notifications = []
  const { evo, events } = makeEvolutionDeps()
  const res = await evo.requestEvolve()
  assert(res.started === true, '应返回已启动')
  await waitFor(
    () => (globalThis.__notifications as Array<{ title?: string }>).some((n) => (n.title ?? '').includes('失败')),
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
  assert(deep.a.b.c.d.e === '(参数已截断)', '深度超 4 层应占位')
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
// 9. 灵动岛设置工具(createSettingsTools,mock 渲染端设置桥)
// ---------------------------------------------------------------------------

console.log('\n=== 灵动岛设置工具(createSettingsTools) ===')

await test('设置工具:未注入桥时不注册;注入后 8 个工具齐', () => {
  assert(createSettingsTools({}).length === 0, '无 runIslandSettings 不应注册')
  const tools = createSettingsTools({ runIslandSettings: async () => ({ ok: true }) })
  const names = tools.map((t) => t.name)
  assert(names.length === 8, `应有 8 个工具,实际 ${names.length}:${names.join(',')}`)
  for (const n of [
    'set_theme_color',
    'set_agent_scale',
    'import_font',
    'list_fonts',
    'rename_font',
    'import_background',
    'list_library_images',
    'rename_library_image',
  ]) {
    assert(names.includes(n), `应含工具 ${n}`)
  }
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
  const out = await tool.execute({ color: 'f87171' })
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
    const out = await tool.execute({ path: fontPath })
    assert(out.includes('test-font.ttf'), '输出应含字体名')
    assert(calls[0].op === 'importFont' && calls[0].args[0].startsWith('data:font/ttf;base64,'), '应调桥且 data URL 为 font/ttf')
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
    assert(calls[0].op === 'importBackground' && calls[0].args[0].startsWith('data:image/png;base64,'), '应调桥且 data URL 为 image/png')
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
  const out1 = await listFonts.execute({})
  assert(out1.includes('f-1 字体甲') && out1.includes('f-2 字体乙'), '列表应含 id 与名称')
  const listImgs = tools.find((t) => t.name === 'list_library_images')!
  const out2 = await listImgs.execute({})
  assert(out2.includes('i-1 图一'), '图片列表应含 id 与名称')
  const emptyTools = createSettingsTools({ runIslandSettings: async (op) => (op === 'listFonts' ? [] : []) })
  assert((await emptyTools.find((t) => t.name === 'list_fonts')!.execute({})).includes('为空'), '空库应有提示')
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
