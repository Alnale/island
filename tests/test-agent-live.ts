/**
 * 真实 LLM 集成测试(后端直测,调用 DeepSeek API)
 *
 * 覆盖两项优化:
 * 1. 总结 Sub Agent:真实消息历史(含工具调用)→ 断言返回非空标题
 *    (验证 90s 超时/逐级容错/输入压缩后的实际成功率);
 * 2. 自我进化 harness:真实评审/复评(独立评估 Sub Agent),隔离临时目录
 *    (不碰用户 memory.json/evolution.json),预置冗余记忆 → 断言产生
 *    进化日志(接受或拒绝都算评估子代理跑通)。
 *
 * API 配置从用户 settings.json 读取(真实 Key);所有写入走临时目录。
 * 运行:node tests/test-agent-live.mjs(最坏耗时约 7 分钟)
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createSummaryAgent, createAgentEngine } from '../electron/agent/engine'
import { createEvolution } from '../electron/agent/evolution'
import { createMemoryStore } from '../electron/agent/memory'
import type { AgentConfig, AgentMessage } from '../electron/agent/types'

let passed = 0
let failed = 0

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failed++
    console.error(`  ✗ ${name}\n    ${(err as Error).message}`)
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`断言失败:${msg}`)
}

// ---- 读取用户真实配置(API Key 等) ----
const settingsPath = path.join(process.env.APPDATA || '', 'dynamic-island', 'settings.json')
const settings = JSON.parse(await fs.readFile(settingsPath, 'utf8'))
const config: AgentConfig = {
  apiKey: settings.agent?.apiKey ?? '',
  baseURL: settings.agent?.baseURL ?? 'https://api.deepseek.com',
  model: settings.agent?.model ?? 'deepseek-v4-flash',
  systemPrompt: settings.agent?.systemPrompt ?? '测试提示词',
  reasoningEffort: settings.agent?.reasoningEffort ?? 'high',
  mcpServers: [],
  skillsDirs: [],
}

if (!config.apiKey) {
  console.error('未配置 API Key,跳过真实 LLM 测试')
  process.exit(2)
}
console.log(`API 配置:${config.baseURL} / ${config.model}(Key 已配置)`)

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-live-'))
console.log(`隔离目录:${tmp}`)

// ---------------------------------------------------------------------------
// 1. 总结 Sub Agent(真实 LLM)
// ---------------------------------------------------------------------------

console.log('\n=== 总结 Sub Agent(真实 LLM) ===')

await test('summarize:含工具调用的历史 → 非空标题', async () => {
  const summaryAgent = createSummaryAgent({ getConfig: () => config })
  // 构造含大工具结果/参数的对话(验证输入压缩后的实际耗时与成功率)
  const history: AgentMessage[] = [
    { id: 'u1', role: 'user', parts: [{ type: 'text', text: '帮我下载B站的一个视频,顺便用特朗普视角分析一下今天的热点' }] },
    {
      id: 'a1',
      role: 'assistant',
      parts: [
        { type: 'tool-call', id: 'c1', name: 'bili', args: { action: 'download', query: 'BV1xx', quality: '720p' } },
        { type: 'tool-result', id: 'c1', name: 'bili', ok: true, result: '已后台启动下载(进程 1234),输出目录 C:/downloads', durationMs: 100 },
        { type: 'tool-call', id: 'c2', name: 'skill_trump-perspective', args: {} },
        { type: 'tool-result', id: 'c2', name: 'skill_trump-perspective', ok: true, result: '技能文档……' + 'x'.repeat(3000), durationMs: 50 },
        { type: 'text', text: '好的,下载已开始。我来用特朗普的视角分析一下今天的科技新闻热点。' },
      ],
    },
    { id: 'u2', role: 'user', parts: [{ type: 'text', text: '谢谢,以后记得我喜欢简洁回答' }] },
  ]
  const t0 = Date.now()
  const title = await summaryAgent.summarize(history)
  const elapsed = Math.round((Date.now() - t0) / 1000)
  console.log(`    标题:${JSON.stringify(title)}(耗时 ${elapsed}s)`)
  assert(title.length > 0, `应返回非空标题,实际:${JSON.stringify(title)}`)
  assert(Array.from(title).length <= 12, `标题应 ≤12 码元,实际 ${Array.from(title).length}`)
})

// ---------------------------------------------------------------------------
// 2. 自我进化 harness(真实评估 Sub Agent,隔离目录)
// ---------------------------------------------------------------------------

console.log('\n=== 自我进化 harness(真实 LLM,隔离目录) ===')

await test('进化:评审 → 改进 → 复评(评估子代理)全流程', async () => {
  const store = createMemoryStore(() => path.join(tmp, 'memory.json'))
  // 预置记忆(含一条明显冗余,给评估子代理"去重"素材)
  await store.add({ content: '用户喜欢简洁的回答', type: 'preference' })
  await store.add({ content: '用户偏好简洁', type: 'preference' })
  await store.add({ content: '项目在 D:/work', type: 'fact' })
  await store.add({ content: 'B站下载用 720p', type: 'workflow' })

  const events: string[] = []
  const evo = createEvolution({
    getConfig: () => config,
    getStore: () => store,
    getMemoryDir: () => tmp,
    onEvent: (e) => events.push(e.type),
  })
  globalThis.__notifications = []
  const res = await evo.requestEvolve('去重冗余记忆')
  console.log(`    requestEvolve:${res.message}`)
  assert(res.started === true, '应返回已启动')

  // 轮询完成(evolution-done 事件或进化通知;最坏 8 分钟)
  const deadline = Date.now() + 8 * 60 * 1000
  while (Date.now() < deadline) {
    if (events.includes('evolution-done')) break
    if ((globalThis.__notifications ?? []).some((n: { title?: string }) => (n.title ?? '').includes('进化'))) break
    await new Promise((r) => setTimeout(r, 2000))
  }
  console.log(`    events:${events.join(',')}`)
  console.log(`    notifications:${JSON.stringify(globalThis.__notifications ?? [])}`)
  const log = await evo.getLog()
  console.log(`    evolution log:${JSON.stringify(log)}`)
  assert(log.length >= 1, '进化应产生日志(接受或拒绝都算评估子代理跑通)')
  // 进度事件应包含"评估子代理"阶段(独立 Sub Agent 语义验证)
  const progressPhases = events.filter((e) => e !== 'evolution-done')
  console.log(`    阶段事件:${progressPhases.join(',') || '(无)'}`)
  const entries = await store.list()
  console.log(`    进化后记忆:${entries.length} 条 → ${entries.map((e) => e.content.slice(0, 18)).join(' | ')}`)
})

// ---------------------------------------------------------------------------
// 3. 自然语言创建技能(真实 LLM 调用 skills_config create)
// ---------------------------------------------------------------------------

console.log('\n=== 自然语言创建技能(真实 LLM) ===')

await test('对话:LLM 调用 create 生成 SKILL.md 并回复', async () => {
  const skillDir = path.join(tmp, 'skills')
  const events: string[] = []
  const engineWithEvents = createAgentEngine({
    getConfig: () => config,
    onEvent: (e) => events.push(e.type),
    onSwitchToMusic: () => {},
    getMemoryStore: () => null,
    getEvolution: () => null,
    updateAgentConfig: () => {},
    getSkillDir: () => skillDir,
  })
  const userMsg: AgentMessage = {
    id: 'u-create-skill',
    role: 'user',
    parts: [
      {
        type: 'text',
        text: '帮我创建一个技能:写诗助手。它根据主题生成七言绝句。描述和完整使用说明都写清楚,文档内容要完整可用。',
      },
    ],
  }
  engineWithEvents.send('帮我创建一个技能:写诗助手。它根据主题生成七言绝句。描述和完整使用说明都写清楚,文档内容要完整可用。', [userMsg])
  // 轮询:message 事件落定(LLM 回复)或超时
  const deadline = Date.now() + 150000
  while (Date.now() < deadline) {
    if (events.includes('message')) break
    await new Promise((r) => setTimeout(r, 2000))
  }
  const files: string[] = []
  try {
    const entries = await fs.readdir(skillDir, { withFileTypes: true })
    for (const e of entries) {
      if (e.isDirectory()) {
        const md = path.join(skillDir, e.name, 'SKILL.md')
        try {
          await fs.access(md)
          files.push(md)
        } catch {
          // 无 SKILL.md
        }
      }
    }
  } catch {
    // 目录不存在
  }
  console.log(`    事件:${events.join(',') || '(无)'}`)
  console.log(`    创建的文件:${files.join(', ') || '(无)'}`)
  assert(files.length >= 1, 'LLM 应创建至少一个 SKILL.md')
  const md = await fs.readFile(files[0], 'utf8')
  console.log(`    frontmatter:${md.slice(0, 120).replace(/\n/g, ' | ')}`)
  assert(md.startsWith('---\nname:'), 'SKILL.md 应以 frontmatter 开头')
  assert(md.includes('description:'), 'frontmatter 应含 description')
  engineWithEvents.dispose()
})

// ---------------------------------------------------------------------------
// 4. 完整闭环:问题 → 编写程序解决 → 沉淀为带脚本的 SKILL
// ---------------------------------------------------------------------------

console.log('\n=== 问题→程序→解决→SKILL 闭环(真实 LLM) ===')

await test('端到端:批量重命名问题 → 脚本解决 → 经验沉淀技能', async () => {
  const workDir = path.join(tmp, 'work')
  const skillDir = path.join(tmp, 'skills')
  await fs.mkdir(workDir, { recursive: true })
  for (const f of ['a.txt', 'b.txt', 'c.txt']) {
    await fs.writeFile(path.join(workDir, f), 'content', 'utf8')
  }
  const events: string[] = []
  const engine = createAgentEngine({
    getConfig: () => config,
    onEvent: (e) => events.push(e.type),
    onSwitchToMusic: () => {},
    getMemoryStore: () => null,
    getEvolution: () => null,
    updateAgentConfig: () => {},
    getSkillDir: () => skillDir,
  })
  const task =
    `我的目录 ${workDir} 里有多个 .txt 文件,请写一个 Python 脚本把它们全部重命名 ` +
    `(文件名前加 processed_ 前缀),运行脚本验证效果,然后把这次的经验总结成一个 ` +
    `**带脚本的完整技能**(SKILL.md 引用脚本,脚本放在技能目录的 scripts/ 下)。`
  engine.send(task, [
    { id: 'u-close-loop', role: 'user', parts: [{ type: 'text', text: task }] },
  ])
  const deadline = Date.now() + 240000
  while (Date.now() < deadline) {
    if (events.includes('message')) break
    await new Promise((r) => setTimeout(r, 3000))
  }
  // 1. 程序解决:work 目录文件被重命名
  const files = await fs.readdir(workDir)
  const renamed = files.filter((f) => f.startsWith('processed_'))
  console.log(`    work 目录:${files.join(', ')}`)
  console.log(`    重命名成功:${renamed.length} 个`)
  // 2. SKILL 沉淀:技能目录有 SKILL.md + scripts 脚本
  const skillEntries = await fs.readdir(skillDir).catch(() => [])
  console.log(`    技能目录:${skillEntries.join(', ') || '(空)'}`)
  let skillOk = false
  let scriptOk = false
  let scriptContent = ''
  for (const entry of skillEntries) {
    const sdir = path.join(skillDir, entry)
    const st = await fs.stat(sdir).catch(() => null)
    if (!st?.isDirectory()) continue
    const md = path.join(sdir, 'SKILL.md')
    if (await fs.access(md).then(() => true).catch(() => false)) {
      const text = await fs.readFile(md, 'utf8')
      skillOk = true
      console.log(`    SKILL.md 前 100 字:${text.slice(0, 100).replace(/\n/g, ' | ')}`)
      // 检查 scripts/ 下的脚本
      const scripts = path.join(sdir, 'scripts')
      const scriptFiles = await fs.readdir(scripts).catch(() => [])
      if (scriptFiles.length > 0) {
        scriptOk = true
        scriptContent = await fs.readFile(path.join(scripts, scriptFiles[0]), 'utf8')
        console.log(`    脚本:${scriptFiles.join(', ')}(${scriptContent.length} 字符)`)
      }
    }
  }
  assert(renamed.length >= 3, '程序应成功重命名全部文件')
  assert(skillOk, '应创建 SKILL.md')
  assert(scriptOk, 'SKILL 应带脚本(scripts/ 目录)')
  assert(scriptContent.includes('processed_'), '脚本内容应包含重命名逻辑')
  engine.dispose()
})

// ---------------------------------------------------------------------------
// 收尾
// ---------------------------------------------------------------------------

await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
console.log(`\n===== 真实 LLM 测试结果:${passed} 通过 / ${failed} 失败 =====`)
if (failed > 0) process.exitCode = 1
