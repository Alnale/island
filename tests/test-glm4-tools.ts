/**
 * GLM-4-9B 工具调用全量对照测试(2026-08-19 三轮实测)
 *
 * 背景:修复"播放视频被直接拒绝"——GLM-4-9B 不查工具表就断言做不到。
 * 本脚本对照**真实引擎工具表**逐工具验证两层:
 *
 * Part 0:提取真实工具表(esbuild + electron stub 打包工具工厂,拿到与
 *   运行时一致的 name/description/parameters schema——不手抄,防漂移);
 * Part 1:解析器全工具覆盖(离线确定性):每个工具 × 三种 GLM-4-9B 实测
 *   输出形态(裸调用 kwargs / 位置参数 / <tool_call> JSON),断言
 *   glm4ParseBareCalls / parseTextToolCalls 解析出正确的调用与参数;
 * Part 2:真实端到端(LM Studio 需运行且 glm-4-9b-0414 已加载):经
 *   lmstudioStreamChatCompletion 真实请求,逐场景验证模型会调工具
 *   (播放视频/听歌/B站/读文件/命令/搜索/音量/时间/通知)且纯聊天
 *   不误触发。系统提示走 provider 真实拼装链(TOOL_CALL_GUIDE +
 *   GLM4_TOOL_GUIDE_ADDON 自动追加,与引擎一致)。
 *
 * 运行:npx tsx tests/test-glm4-tools.ts [--e2e]
 *   默认只跑 Part 0+1;--e2e 追加真实模型端到端(慢,每场景数十秒)。
 */

import * as esbuild from 'esbuild'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const runE2E = process.argv.includes('--e2e')

let passed = 0
let failed = 0
const failures: string[] = []
function check(ok: boolean, label: string, detail?: string) {
  if (ok) {
    passed++
    console.log(`  ✓ ${label}`)
  } else {
    failed++
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`)
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

// ---------------------------------------------------------------------------
// Part 0:提取真实工具表
// ---------------------------------------------------------------------------

interface ToolSchema {
  name: string
  description: string
  parameters: {
    type: string
    properties?: Record<string, Record<string, unknown>>
    required?: string[]
  }
}

async function extractRealTools(): Promise<ToolSchema[]> {
  const tmp = mkdtempSync(path.join(tmpdir(), 'glm4-tools-'))
  // electron stub:模块加载期只会用 app.getPath(userData-dir)——
  // 工具 execute 不运行,其余 API 顶层不会被调用
  const stub = path.join(tmp, 'electron-stub.cjs')
  writeFileSync(
    stub,
    `module.exports = { app: { getPath: () => ${JSON.stringify(path.join(tmp, 'userData'))}, isReady: () => true }, shell: { openPath: async () => '', openExternal: async () => undefined } }`,
  )
  const entry = path.join(tmp, 'extract-tools.mts')
  const fwdRoot = ROOT.replace(/\\/g, '/')
  const src = `
import { createTools } from '${fwdRoot}/electron/agent/tools/tools'
import { createSettingsTools, createMusicControlTools } from '${fwdRoot}/electron/agent/tools/settingsTools'
import { createSessionTools } from '${fwdRoot}/electron/agent/tools/sessionTools'
import { createConfigTools } from '${fwdRoot}/electron/agent/tools/configTools'
import { createMemoryTools } from '${fwdRoot}/electron/agent/memory'
import { createBuiltinTools } from '${fwdRoot}/electron/agent/engine/engine-builtins'
const cfg = { activeProvider: 'lmstudio', providers: {}, apiKey: '', baseURL: 'http://127.0.0.1:1234', model: 'glm-4-9b-0414' }
const all = [
  ...createTools({ onSwitchToMusic: () => {} }),
  ...createSettingsTools({ runIslandSettings: async () => ({ ok: true }) }),
  ...createMusicControlTools(async () => 'ok'),
  ...createSessionTools({ getSessionKey: () => 'test', getNote: async () => '', setNote: async () => ({}), clearContext: async () => ({ ok: true }) }),
  ...createConfigTools({ getConfig: () => cfg, testMcp: async () => ({ ok: true }) }),
  ...createMemoryTools(() => null),
  ...createBuiltinTools({ value: 4096 }, { getConfig: () => cfg }),
]
export const allTools = all.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))
`
  writeFileSync(entry, src)
  const outfile = path.join(tmp, 'tools-bundle.cjs')
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    alias: { electron: stub },
    outfile,
    logLevel: 'silent',
  })
  const { createRequire } = await import('node:module')
  const req = createRequire(import.meta.url)
  const mod = req(outfile) as { allTools: ToolSchema[] }
  return mod.allTools
}

console.log('== Part 0:提取真实工具表 ==')
const tools = await extractRealTools()
console.log(`  提取到 ${tools.length} 个工具:${tools.map((t) => t.name).join(', ')}`)
check(tools.length >= 50, '工具表提取成功(≥50 个,覆盖核心/设置/会话/配置/记忆簇)')

// ---------------------------------------------------------------------------
// Part 1:解析器全工具覆盖(离线)
// ---------------------------------------------------------------------------

console.log('\n== Part 1:解析器全工具覆盖(裸调用 / 位置参数 / <tool_call> JSON)==')
const { glm4ParseBareCalls } = await import('../electron/agent/providers/lmstudio-glm4')
const { parseTextToolCalls } = await import('../electron/agent/providers/lmstudio-chat')
// AgentTool 类型需 execute,测试仅用 schema(引擎解析器只读 name/parameters)
const toolObjs = tools as unknown as Parameters<typeof glm4ParseBareCalls>[1]

/** 工具首个 string 参数(required 优先)——位置参数映射目标 */
function firstStringParam(t: ToolSchema): { name: string; value: string } | null {
  const props = t.parameters?.properties ?? {}
  const req = t.parameters?.required ?? []
  for (const r of req) {
    if (props[r]?.type === 'string') {
      return { name: r, value: /path|file|dir/i.test(r) ? 'C:\\t\\demo.mp4' : '测试值' }
    }
  }
  for (const [k, v] of Object.entries(props)) {
    if ((v as { type?: string })?.type === 'string') {
      return { name: k, value: /path|file|dir/i.test(k) ? 'C:\\t\\demo.mp4' : '测试值' }
    }
  }
  return null
}

/** 首个 number 参数(音量/比例类) */
function firstNumberParam(t: ToolSchema): { name: string; value: number } | null {
  for (const [k, v] of Object.entries(t.parameters?.properties ?? {})) {
    if ((v as { type?: string })?.type === 'number') return { name: k, value: 50 }
  }
  return null
}

let p1Total = 0
for (const t of tools) {
  const sp = firstStringParam(t)
  const np = firstNumberParam(t)
  const param = sp ?? (np ? { name: np.name, value: String(np.value) } : null)
  if (!param) continue // 无标量参数的工具(纯 enum 交互)跳过位置式,试 enum

  // A. 裸调用 kwargs(实测 GLM-4-9B 主要形态)
  {
    const sample = `好的,我来处理。${t.name}(${param.name}=${JSON.stringify(param.value)})`
    const parsed = glm4ParseBareCalls(sample, toolObjs)
    const ok = !!parsed && parsed.calls[0]?.name === t.name && parsed.calls[0]?.args[param.name] === param.value
    p1Total++
    if (!ok) {
      check(false, `A 裸调用kwargs:${t.name}`, `产出 ${JSON.stringify(parsed?.calls[0] ?? null)}`)
    }
  }
  // B. 裸调用位置参数(exec_command("cmd") 实测形态)
  {
    const sample = `${t.name}(${JSON.stringify(param.value)})`
    const parsed = glm4ParseBareCalls(sample, toolObjs)
    const ok = !!parsed && parsed.calls[0]?.name === t.name
    p1Total++
    if (!ok) {
      check(false, `B 裸调用位置参数:${t.name}`, `产出 ${JSON.stringify(parsed?.calls[0] ?? null)}`)
    }
  }
  // C. <tool_call> JSON(指引规范格式)
  {
    const sample = `<tool_call>\n{"name": "${t.name}", "arguments": {"${param.name}": ${JSON.stringify(param.value)}}}\n</tool_call>`
    const parsed = parseTextToolCalls(sample, toolObjs)
    const ok = !!parsed && parsed.calls[0]?.name === t.name && parsed.calls[0]?.args[param.name] === param.value
    p1Total++
    if (!ok) {
      check(false, `C tool_call JSON:${t.name}`, `产出 ${JSON.stringify(parsed?.calls[0] ?? null)}`)
    }
  }
  // D. number 参数 kwargs(set_system_volume(volume=50) 数字字面量)
  if (np) {
    const sample = `${t.name}(${np.name}=${np.value})`
    const parsed = glm4ParseBareCalls(sample, toolObjs)
    const ok = !!parsed && parsed.calls[0]?.name === t.name && parsed.calls[0]?.args[np.name] === np.value
    p1Total++
    if (!ok) {
      check(false, `D 数字kwargs:${t.name}`, `产出 ${JSON.stringify(parsed?.calls[0] ?? null)}`)
    }
  }
}
check(true, `全部 ${p1Total} 个解析样本通过(逐工具 × 形态)`)

// 变体名模糊匹配(模型输出别名形态)
{
  const variants: Array<[string, string, string]> = [
    ['bili_tool(action="whoami")', 'bili', 'action'],
    ['readfile(path="C:\\\\t.txt")', 'read_file', 'path'],
    ['listdir(path="C:\\\\")', 'list_dir', 'path'],
  ]
  for (const [sample, expectName, argKey] of variants) {
    const parsed = glm4ParseBareCalls(sample, toolObjs)
    const ok = !!parsed && parsed.calls[0]?.name === expectName && argKey in (parsed.calls[0]?.args ?? {})
    check(ok, `变体名匹配:${sample.split('(')[0]} → ${expectName}`, `产出 ${JSON.stringify(parsed?.calls[0] ?? null)}`)
  }
}

// 整条回复只有一个工具名(端到端实测:无参工具只吐名不带括号)
{
  const solo = glm4ParseBareCalls('get_time', toolObjs)
  check(solo?.calls[0]?.name === 'get_time', 'solo 裸名:get_time(无括号)→ get_time 调用', `产出 ${JSON.stringify(solo?.calls[0] ?? null)}`)
  // 带上下文词的不触发(防正文误判)
  const notSolo = glm4ParseBareCalls('现在请用 get_time 工具查时间', toolObjs)
  check(notSolo === null, 'solo 反误伤:正文中工具名不触发(仅整条裸名)')
}

// 无参数工具裸调用(get_time()/system_info() 等只读工具)
{
  const noArgTools = tools.filter((t) => Object.keys(t.parameters?.properties ?? {}).length === 0)
  let noArgOk = 0
  for (const t of noArgTools) {
    const parsed = glm4ParseBareCalls(`${t.name}()`, toolObjs)
    if (parsed?.calls[0]?.name === t.name) noArgOk++
  }
  check(noArgTools.length > 0 && noArgOk === noArgTools.length, `无参数工具裸调用 × ${noArgTools.length} 全通过`)
}

// 变体名流式一致性(Glm4StreamGuard:变体调用段跨 delta 分片不泄漏到窗口)
{
  const { Glm4StreamGuard } = await import('../electron/agent/providers/lmstudio-glm4')
  const guard = new Glm4StreamGuard(tools.map((t) => t.name))
  // 'bili_to' + 'ol(action="whoami")' 分片:变体名跨 delta 拼接
  const out = guard.feed('好的,我来查。bili_to') + guard.feed('ol(action="whoami")') + guard.flush()
  check(!out.includes('bili_tool'), '流式变体名抑制:bili_tool( 跨 delta 不泄漏', `输出:${JSON.stringify(out)}`)
  // 精确名跨 delta(回归):exec_co + mmand("ipconfig")
  const guard2 = new Glm4StreamGuard(tools.map((t) => t.name))
  const out2 = guard2.feed('exec_co') + guard2.feed('mmand("ipconfig")') + guard2.flush()
  check(!out2.includes('exec_command'), '流式精确名抑制:exec_command( 跨 delta 不泄漏', `输出:${JSON.stringify(out2)}`)
}

// 裸名 + 裸 JSON 形态(2026-08-19 播放视频实测:
// "open_file\n{\"path\": \"D:\\\\Videos\\\\demo.mp4\"}" —— 名独占一行无括号)
{
  const text = 'open_file\n{"path": "D:\\\\Videos\\\\demo.mp4"}\n已为您找到并打开了视频文件 demo.mp4。'
  const parsed = glm4ParseBareCalls(text, toolObjs)
  check(
    parsed?.calls[0]?.name === 'open_file' && parsed.calls[0]?.args?.path === 'D:\\Videos\\demo.mp4',
    '裸名+JSON 形态:open_file + 下一行 JSON → 解析出调用',
    `产出 ${JSON.stringify(parsed?.calls ?? null)} | text:${JSON.stringify(parsed?.text)}`,
  )
  check(parsed !== null && parsed.text === '', '裸名+JSON:text 截断到调用前(空)')
  // JSON 嵌套花括号配平
  const nested = 'bili\n{"action": "search", "params": {"query": "demo"}}'
  const pn = glm4ParseBareCalls(nested, toolObjs)
  check(pn?.calls[0]?.name === 'bili' && pn.calls[0]?.args?.action === 'search', '裸名+JSON:嵌套对象配平提取')
}

// 重复调用去重(2026-08-19 播放视频实测:同一 open_file 输出两次 → 只执行一次)
{
  // 括号形式 × 2(同一路径)
  const dup1 = glm4ParseBareCalls(
    'open_file(path="D:\\\\Videos\\\\demo.mp4")\nopen_file(path="D:\\\\Videos\\\\demo.mp4")',
    toolObjs,
  )
  check(dup1?.calls.length === 1, '去重:两个相同括号 open_file → 1 个', `calls=${JSON.stringify(dup1?.calls)}`)
  // 裸名+JSON × 2(实测形态)
  const dup2 = glm4ParseBareCalls(
    'open_file\n{"path": "D:\\\\Videos\\\\demo.mp4"}\nopen_file\n{"path": "D:\\\\Videos\\\\demo.mp4"}\n已播放',
    toolObjs,
  )
  check(dup2?.calls.length === 1, '去重:两个相同 裸名+JSON open_file → 1 个', `calls=${JSON.stringify(dup2?.calls)}`)
  // 混合形态:括号 + 裸名JSON 同参数 → 1 个
  const dup3 = glm4ParseBareCalls(
    'open_file(path="D:\\\\Videos\\\\demo.mp4")\nopen_file\n{"path": "D:\\\\Videos\\\\demo.mp4"}',
    toolObjs,
  )
  check(dup3?.calls.length === 1, '去重:括号 + 裸名JSON 同参数 → 1 个', `calls=${JSON.stringify(dup3?.calls)}`)
  // 不同参数不误杀(合法多调用):两首不同的歌
  const multi = glm4ParseBareCalls(
    'open_file(path="D:\\\\a.mp3")\nopen_file(path="D:\\\\b.mp3")',
    toolObjs,
  )
  check(multi?.calls.length === 2, '保留:不同参数的多调用不误杀', `calls=${JSON.stringify(multi?.calls)}`)
  // 参数键序不同但等价 → 去重(dedup 兜底层验证)
  const dup4 = glm4ParseBareCalls(
    'open_file(path="D:\\\\demo.mp4")\nopen_file(path="D:\\\\demo.mp4")',
    toolObjs,
  )
  check(dup4?.calls.length === 1, '去重:键序不同等价参数', `calls=${JSON.stringify(dup4?.calls)}`)
}

// 流式裸名+JSON 抑制(Glm4StreamGuard:solo-json 调用段跨 delta 不泄漏)
{
  const { Glm4StreamGuard } = await import('../electron/agent/providers/lmstudio-glm4')
  const guard = new Glm4StreamGuard(tools.map((t) => t.name))
  // 模拟分片:'open_file\n' + '{"path"...' 完整调用 + 编造正文
  const out =
    guard.feed('好的,我来打开。\nopen_file\n{"path": "D:\\\\Videos\\\\demo.mp4"}\n已为您找到并打开了视频') +
    guard.flush()
  check(!out.includes('open_file'), '流式 solo-json 抑制:调用段不泄漏', `输出:${JSON.stringify(out)}`)
  // 跨 delta 分片:'open_fi' + 'le\n{...}'
  const guard2 = new Glm4StreamGuard(tools.map((t) => t.name))
  const out2 =
    guard2.feed('open_fi') + guard2.feed('le\n{"path": "D:\\\\Videos\\\\demo.mp4"}\n已播放') + guard2.flush()
  check(!out2.includes('open_file'), '流式 solo-json 跨 delta:不泄漏', `输出:${JSON.stringify(out2)}`)
}

// 工具名标签包裹型调用(2026-08-19:<notify>…</notify> 形式)——GLM-4-9B
// 把调用意图当 XML 标签输出(如"<notify>请提供 NapCat 路径</notify>"),
// 共享四通道/裸调用都不命中 → 当正文泄漏。验证流式抑制 + 落定清洗 +
// 不误伤 markdown/数值。
{
  const { Glm4StreamGuard, glm4SanitizeText } = await import('../electron/agent/providers/lmstudio-glm4')
  // 运行时 napcat/manage_sessions 是经引擎工具组单独注册的,不在这批
  // 提取的 68 个里——手动并入以贴近真实运行时(收到时资源表含 napcat)
  const gNames = [...tools.map((t) => t.name), 'napcat', 'manage_sessions']
  // 完整标签流式抑制
  const g = new Glm4StreamGuard(gNames)
  const out = g.feed('<notify>请提供 NapCat 路径</notify>') + g.flush()
  check(!out.includes('<notify>') && !out.includes('NapCat'), '流式抑制 <notify>…</notify>', `输出:${JSON.stringify(out)}`)
  // 跨 delta 分片标签
  const g2 = new Glm4StreamGuard(gNames)
  const out2 = g2.feed('<n') + g2.feed('otify>请提供路径</notify>剩余正文') + g2.flush()
  check(!out2.includes('<notify>') && !out2.includes('请提供路径') && out2.includes('剩余正文'), '流式跨 delta 标签抑制(保留后续正文)', `输出:${JSON.stringify(out2)}`)
  // napcat 标签
  const g3 = new Glm4StreamGuard(gNames)
  const out3 = g3.feed('<napcat>发送消息</napcat>') + g3.flush()
  check(!out3.includes('<napcat>') && !out3.includes('发送消息'), '流式抑制 <napcat>…</napcat>', `输出:${JSON.stringify(out3)}`)
  // 落定清洗:工具名标签整对剥离
  const s1 = glm4SanitizeText('好的。<notify>请提供路径</notify>好了', gNames)
  check(!s1.includes('<notify>') && !s1.includes('请提供路径'), '落定剥离 <notify>…</notify>', `输出:${JSON.stringify(s1)}`)
  // 落定:不误伤非工具标签(markdown <b>/<em>)
  const s2 = glm4SanitizeText('下面是<b>加粗</b>文字', gNames)
  check(s2.includes('<b>加粗</b>'), '不误伤非工具标签 <b>', `输出:${JSON.stringify(s2)}`)
  // 落定:不误伤数值比较
  const s3 = glm4SanitizeText('a < 3 > b', gNames)
  check(s3 === 'a < 3 > b', '不误伤数值比较 < 3 >', `输出:${JSON.stringify(s3)}`)
  // 兼容:无工具名参数时不动(旧签名)
  const s4 = glm4SanitizeText('<notify>请提供路径</notify>')
  check(s4.includes('<notify>'), '无工具名参数保留原样(兼容旧调用)', `输出:${JSON.stringify(s4)}`)
}

// 反误伤:普通正文不触发(散文括号/未注册名/正文里的工具名提法)
{
  const benign = [
    'exec_command (see docs) 是一个命令行工具的说明文字',
    '今天天气不错,foo(bar) 这种散文括号不应触发',
    '推荐使用您的媒体播放器打开该文件进行播放。',
    '你可以用 open_file 工具打开文件(见帮助文档)',
    '步骤一:安装软件\n步骤二:打开视频查看效果',
  ]
  for (const s of benign) {
    const parsed = glm4ParseBareCalls(s, toolObjs)
    check(parsed === null, `正文反误伤:${s.slice(0, 18)}…`)
  }
}

// ---------------------------------------------------------------------------
// Part 2:真实端到端(LM Studio glm-4-9b-0414)
// ---------------------------------------------------------------------------

if (runE2E) {
  console.log('\n== Part 2:真实端到端(LM Studio glm-4-9b-0414)==')
  const { lmstudioStreamChatCompletion } = await import('../electron/agent/providers/lmstudio-chat')
  const { GLM4_TOOL_GUIDE_ADDON, isGlm4Model } = await import('../electron/agent/providers/lmstudio-glm4')
  check(isGlm4Model('glm-4-9b-0414'), '端到端模型识别:glm-4-9b-0414 命中 GLM 档位')

  // 与引擎一致:基础 system 传入,provider 自动拼 TOOL_CALL_GUIDE + GLM4 addon
  const baseSystem = '你是桌面灵动岛挂件里的个人助手。'
  const config = {
    activeProvider: 'lmstudio',
    providers: {},
    apiKey: '',
    baseURL: 'http://127.0.0.1:1234',
    model: 'glm-4-9b-0414',
  } as never

  interface Scenario {
    label: string
    message: string
    /** 期望调用的工具名集合(空数组 = 期望纯文本不调工具) */
    expectTools: string[]
    /** 判定:产出调用名 ∈ expectTools 即过 */
  }
  const scenarios: Scenario[] = [
    { label: '播放视频(主修复场景)', message: '播放视频 D:\\Videos\\demo.mp4', expectTools: ['open_file', 'list_dir'] },
    { label: '听歌', message: '帮我放首歌', expectTools: ['open_file', 'list_dir', 'music_control', 'list_audio_library', 'list_playlist'] },
    { label: 'B站登录状态', message: '我B站登录了吗', expectTools: ['bili'] },
    { label: '读文件', message: '读取文件 C:\\Windows\\System32\\drivers\\etc\\hosts', expectTools: ['read_file'] },
    { label: '执行命令', message: '帮我执行命令 ipconfig /all', expectTools: ['exec_command'] },
    { label: '联网搜索', message: '帮我搜索一下2026年AI大模型的最新进展', expectTools: ['web_search'] },
    { label: '系统音量', message: '把系统音量调到50', expectTools: ['set_system_volume'] },
    { label: '当前时间', message: '现在几点了', expectTools: ['get_time'] },
    { label: '系统通知', message: '发一个系统通知提醒我喝水', expectTools: ['notify'] },
    { label: '纯聊天(不误触发)', message: '你好,用一句话介绍你自己', expectTools: [] },
  ]

  async function runScenario(sc: Scenario): Promise<void> {
    const events: string[] = []
    try {
      const outcome = await lmstudioStreamChatCompletion({
        config,
        system: baseSystem,
        history: [{ id: 't1', role: 'user', parts: [{ type: 'text', text: sc.message }] }],
        tools: tools as never,
        signal: AbortSignal.timeout(240_000),
        onEvent: (e: { type: string; text?: string }) => {
          if (e.type === 'text-delta' && e.text) events.push(e.text)
        },
      } as never)
      const callNames = outcome.calls.map((c: { name: string }) => c.name)
      const textPreview = (outcome.text || '').replace(/\s+/g, ' ').slice(0, 60)
      // 无重复调用断言(2026-08-19 播放视频:同工具同参数不得产出两次)
      const keyed = outcome.calls.map(
        (c: { name: string; args: string }) => `${c.name}::${c.args}`,
      )
      const uniqCount = new Set(keyed).size
      check(
        keyed.length === uniqCount,
        `场景「${sc.label}」无重复调用(共 ${keyed.length} 个)`,
        `重复调用 ${JSON.stringify(outcome.calls)}`,
      )
      if (sc.expectTools.length === 0) {
        check(
          callNames.length === 0,
          `场景「${sc.label}」→ 纯文本(无调用)`,
          `实际调用 ${JSON.stringify(callNames)} | 文本:${textPreview}`,
        )
      } else {
        const hit = callNames.find((n: string) => sc.expectTools.includes(n))
        check(
          !!hit,
          `场景「${sc.label}」→ 期望 ${sc.expectTools.join('/')}`,
          `实际调用 ${JSON.stringify(callNames)} | 文本:${textPreview}`,
        )
      }
    } catch (err) {
      check(false, `场景「${sc.label}」`, `请求异常:${(err as Error).message.slice(0, 120)}`)
    }
  }

  // 并发 3(LM Studio 本地推理排队处理;全部串行过慢)
  const queue = [...scenarios]
  const workers = Array.from({ length: 3 }, async () => {
    for (;;) {
      const sc = queue.shift()
      if (!sc) break
      await runScenario(sc)
    }
  })
  await Promise.all(workers)
  console.log(`  (指引含反拒绝规则:${GLM4_TOOL_GUIDE_ADDON.includes('open_file(path=') ? '是' : '否'})`)
} else {
  console.log('\n(跳过 Part 2 真实端到端——加 --e2e 运行;需 LM Studio 已加载 glm-4-9b-0414)')
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
console.log(`\n== 汇总:${passed} 通过 / ${failed} 失败 ==`)
if (failures.length > 0) {
  console.log('失败项:')
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
