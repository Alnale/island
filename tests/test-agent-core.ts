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
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  createMemoryStore,
  createMemoryTools,
  formatMemoryBlock,
  migrateMemoryContent,
  normalizeMemoryText,
  memorySimilarity,
  findNearDuplicate,
} from '../electron/agent/memory'
import {
  createPersonaStore,
  formatPersonaBlock,
  formatPersonaStyleBlock,
  isPersonaMergeCandidate,
  migratePersonaMemoriesFromLongTerm,
  normalizePersonaExport,
  parsePersonaImport,
  sanitizePersonaStyle,
  MAX_PERSONA_CARDS,
  MAX_PERSONA_NOTES,
  MAX_PERSONA_PROMPT,
} from '../electron/agent/persona'
import {
  createPersonaBufferStore,
  extendPersonaStyle,
  mergePersonaBufferItem,
  parsePersonaBufferImport,
  planPersonaBufferImport,
  retargetImportedBuffer,
  undoPersonaBufferItem,
} from '../electron/agent/persona-buffer'
import { sanitizeAiFlavor, scoreAiFlavor, styleModeForText } from '../electron/agent/persona-style'
import {
  MindMarkStripper,
  depictTurn,
  mindFromReasoning,
  parseMindMark,
  stripMindMarks,
  takeMindFromText,
} from '../electron/agent/mind-reflect'
import { createPersonaTools } from '../electron/agent/tools/tools-persona'
import {
  createStyleReviewAgent,
  finalizeStyleReview,
  parseStyleReviewJson,
  prepareStyleReviewSamples,
  selectRecentAssistantTexts,
} from '../electron/agent/style-review'
import {
  createTraitReviewAgent,
  finalizeTraitReview,
  parseTraitReviewJson,
} from '../electron/agent/persona-traits'
import { createBuiltinTools } from '../electron/agent/engine/engine-builtins'
import { isPersonaClassified, isProtectedEntry, PERSONA_TAGS } from '../electron/agent/constants'
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
  parseJudgeJson,
  parseStyleJson,
  buildMemoryExtractSystem,
  buildUserStyleSystem,
  buildClassifierSystem,
  parseClassifierJson,
  createSummaryAgent,
  createProactiveAgent,
  createReplyClassifier,
  createEvaluatorAgent,
  createSubAgentHost,
  runSubJson,
  fetchDeepseekBalance,
  sanitizeTitle,
  looksLikeSentenceTitle,
  looksLikeIncompleteMind,
  cutMindSentence,
  salvageMindClause,
  sanitizeMind,
  fallbackTitle,
} from '../electron/agent/engine/engine'
import {
  buildToolsGuideBlock,
  createTools,
  toolOutputDir,
  windowShotScriptPath,
  parseJsonOutput,
} from '../electron/agent/tools/tools'
// bili 登录态整合(2026-09-22):凭据收编/键名规范化/nav 探针解析/未登录输出识别(纯函数)
import {
  parseBiliCookies,
  parseNavProbe,
  consolidateBiliCookies,
  normalizeBiliCookieKeys,
  biliOutputLooksLoggedOut,
  biliQuery,
} from '../electron/agent/tools/tools-bili'
import {
  buildProfileCard,
  buildForwardNodes,
  cardLabel,
  createNapcatTools,
  buildOutgoingMessage,
  extractImageRefs,
  stripMentionMarkup,
  stripSelfMentions,
  classifyTurn,
  gtkFromCookie,
  isAskTurnToMaster,
  isDirectedToBot,
  isReplyInstruction,
  isValidSessionKey,
  looksLikeMasterAddressed,
  napcatForwardMedia,
  napcatForwardNestedIds,
  napcatForwardText,
  napcatIncomingIsBlank,
  napcatMessageAtQQs,
  napcatMessageFiles,
  napcatMessageForwardIds,
  napcatMessageImages,
  napcatMessageReplyId,
  napcatMessageSubTypeNoise,
  napcatMessageText,
  napcatMessageVideos,
  napcatMessageVoices,
  shouldAdmitGroupMessage,
  newTurnFingerprint,
  sessionKeyFor,
  stripFingerprintMarks,
  stripMasterNarration,
  stripThinkingPreamble,
  stripToolNarration,
  turnAlreadySentToPending,
  turnAlreadySentToTarget,
  turnAlreadySentGroupText,
  sentMessageIsText,
  shouldHandGroupReplyToMaster,
  looksLikeForwardInstruction,
  looksLikeGroupSendInstruction,
  shouldSendGroupPanelReply,
  rememberGroupContext,
  recentGroupContext,
  formatGroupContextLines,
  pinGroupReplyTarget,
  resolveGroupSendTarget,
  resolvePrivateSendTarget,
  resolveGroupMention,
  scopeTranscriptQuery,
  createNapcatLoginFlow,
  createNapcatClient,
  describeLoginError,
  webuiTokenHash,
  encodeQr,
  type NapcatToolDeps,
  type NapcatClient,
} from '../electron/agent/napcat/napcat'
import { MASTER_WINDOW_MARK, masterIdentityLine, masterWindowTurnRule, tagMasterWindowText } from '../electron/agent/constants'

/** 短等待(轮询/自动重连测试用;不阻塞事件循环外的计时器) */
const sleepMs = (ms: number) => new Promise((res) => setTimeout(res, ms))
import { streamResponse } from '../electron/agent/providers/deepseek'
import { parseSse, sanitizeUnpairedSurrogates } from '../electron/agent/providers/sse'
// MiMo 专项适配(2026-09-22 官网多模态/Batch):编码器 + 工具簇
import { mimoUserContent, mimoResponsesUserContent, mimoResponsesContentPart, mimoMediaPart, mimoMimeOf } from '../electron/agent/providers/mimo-media'
import { mimoHistoryToMessages, mimoStreamChatCompletion } from '../electron/agent/providers/mimo-chat'
import { mimoStreamResponse } from '../electron/agent/providers/mimo-responses'
import { mimoSupportsMedia, mimoBatchBaseUrl, mimoErrorMessage } from '../electron/agent/providers/mimo-constants'
import { createMimoTools, buildMimoBatchJsonl } from '../electron/agent/tools/tools-mimo'
// DeepSeek 专属适配(2026-10-22):图像理解序列化 / 视觉模型门控 / 官方搜索与抓取
import { historyToItems } from '../electron/agent/providers/deepseek'
import { historyToMessages } from '../electron/agent/providers/chat'
import { historyToAnthropic } from '../electron/agent/providers/anthropic'
import { deepseekErrorMessage, deepseekModelForInput, isDeepseekVisionModel } from '../electron/agent/providers/deepseek-constants'
import { planDeepseekImages, historyHasImages } from '../electron/agent/providers/deepseek-media'
import {
  assertWebFetchUrl,
  deepseekToolsEndpoint,
  deepseekWebFetchPage,
  deepseekWebSearch,
  formatDeepseekSearchResults,
} from '../electron/agent/providers/deepseek-web'
import { formatPageResult } from '../electron/agent/tools/tools-search'
import { estimateMessageTokens } from '../electron/agent/engine/engine-history'
// 厂商专属通道(2026-10-22):Sub 配置换桶判定 / LLM 适配器解析互斥
import { resolveSubConfig } from '../electron/agent/subagents/runtime'
import { getDefaultLlmRuntime } from '../electron/agent/plugin/llm'

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
import { createReverseWsServer } from '../electron/agent/napcat/napcat-wsserver'
import { snapshotWatchDirs, restoreUndoSnapshot, releaseUndoRef, type GitExec } from '../electron/agent/undo'
import { runPluginKernelTests } from './plugin-kernel-tests'
import { isEmptyNapcatDisplayText, stripNapcatHistoryInstructions, stripNapcatInstructions, stripTurnMarks } from '../src/agent/text'
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
import {
  applyChanges,
  createEvolution,
  evalOutputBudget,
  evalTimeoutMs,
  isCleanupChange,
  buildPersonaProposal,
  mapSeqToEntry,
  parsePersonaMerge,
  resolveRoundBudget,
} from '../electron/agent/evolution'
import { invalidatePrivacyCache } from '../electron/agent/privacy'
import type { AgentConfig, AgentMessage, AgentTool, McpServerConfig, MemoryEntry, PersonaCard } from '../electron/agent/types'
// 米家智能家居(2026-09-22):协议纯层 + 存储(工具策略测试在 tools-mijia 接线后同文件追加)
import {
  makeNonce,
  computeSignedNonce,
  computeSignature,
  rc4Crypt,
  encryptParam,
  decryptParam,
  generateEncParams,
  parsePrefixedJson,
  createMijiaLoginFlow,
  createMijiaCloud,
} from '../electron/agent/tools/mijia/mijia-cloud'
import { createMijiaStore, MIJIA_SECRET_PREFIX, type MijiaAuth } from '../electron/agent/tools/mijia/mijia-store'
import {
  deriveLanKey,
  encryptLanPayload,
  decryptLanPayload,
  buildLanPacket,
  parseLanPacket,
} from '../electron/agent/tools/mijia/mijia-lan'
import { createMijiaSpec, shortName, FALLBACK_LIGHT, type MiotInstanceSpec } from '../electron/agent/tools/mijia/mijia-spec'
import {
  createMijiaTools,
  assertMijiaWriteAllowed,
  assertMijiaDeviceAllowed,
  classifyForbiddenDevice,
} from '../electron/agent/tools/tools-mijia'

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
// 隐私配置是运行时文件，不应由源码硬编码；为依赖主人身份的测试显式
// 注入隔离夹具，避免读取机器上的真实 userData 或得到空主人。
process.env.DYNAMIC_ISLAND_TEST_USER_DATA = path.join(tmp, 'userData')
await fs.mkdir(process.env.DYNAMIC_ISLAND_TEST_USER_DATA, { recursive: true })
await fs.writeFile(
  path.join(process.env.DYNAMIC_ISLAND_TEST_USER_DATA, 'privacy.json'),
  JSON.stringify({ masterQQ: MASTER_QQ, allowed: [], allowedGroups: [], botQQ: '' }),
)
invalidatePrivacyCache()
// 每个记忆用例用独立文件(写盘是异步队列,共享文件会读到旧数据)
const memoryFile = (n: number) => path.join(tmp, `memory-${n}.json`)
// 人格卡用例同样独立文件(2026-10-25)
const personaFile = (n: number) => path.join(tmp, `persona-${n}.json`)
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

await test('migrateMemoryContent:误导教训 load 迁移(修「反复重验/重开扫码窗」)', () => {
  // ① no-permit→重扫码类旧教训:改写为正确排查路径(2026-09-22 实测:
  //    LLM 据此在一轮里连开 5 个扫码窗让主人重复验证)
  const old1 = '米家登录后调用 /v2/home/home_device_list 报 code=-1:no permit、缓存设备0台时，属登录态权限不足；带上 refresh=true 重试仍失败，应重新发起 mijia_login login 让主人扫码，再重查设备。'
  const fixed1 = migrateMemoryContent(old1)
  assert(fixed1 !== old1 && !/应重新|重新发起|让主人扫码|再扫一次/.test(fixed1), `no-permit 旧教训应改写且不再导向重扫码,实际:${fixed1}`)
  assert(/refresh=true|与登录无关/.test(fixed1), '应给出正确排查路径')
  // ② check 脚本实时验证 Credential 类:教出「重复验证十几次」死循环
  const old2 = '执行NapCat/扫码类操作时,若遇到接口返回404或认证失败,应优先回查本机JS源码确认真实路径、并用check脚本实时验证Credential有效性,再重试,避免凭猜测重复调用。'
  const fixed2 = migrateMemoryContent(old2)
  assert(fixed2 !== old2 && /验证一次/.test(fixed2) && !/再重试/.test(fixed2), `实时验证类应改为验证一次即停,实际:${fixed2}`)
  // ③ 无害内容原样返回(不误伤)
  const benign = '主人喜欢简洁回答'
  assert(migrateMemoryContent(benign) === benign, '无害内容应原样返回')
  // 幂等:迁移后再迁移不改变
  assert(migrateMemoryContent(fixed1) === fixed1, '迁移应幂等')
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

await test('sse 初始化通知与销毁并发时不产生未处理 AbortError', async () => {
  const mgr = createMCPManager()
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown) => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  try {
    await mgr.listTools([sseCfg])
    // 正常握手后立即销毁是此前最稳定的复现路径：通知 POST 尚未被 await。
    mgr.dispose()
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert(unhandled.length === 0, `不应有未处理拒绝:${String(unhandled[0])}`)
  } finally {
    process.off('unhandledRejection', onUnhandled)
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
// 7. 人格卡(2026-10-25):存储 / 提示词块 / 候选判定 / 导入导出
// ---------------------------------------------------------------------------

console.log('\n=== 人格卡(persona.ts) ===')

await test('persona store:CRUD / notes 追加去重 / 清空 / 持久化', async () => {
  const file = personaFile(1)
  const store = createPersonaStore(() => file)
  const a = await store.upsert({ name: '温柔助手', prompt: '说话温柔一点' })
  assert(a.notes === '', '新卡 notes 应为空')
  // 编辑提示词不传 notes → 保留原整合区
  const appended = await store.appendNotes(a.id, ['喜欢被叫小名', ' 喜欢被叫小名 ', '- 回复要简短'])
  assert(appended.added === 2, `按行去重后应新增 2 行,实际 ${appended.added}`)
  const edited = await store.upsert({ id: a.id, name: '温柔助手', prompt: '说话非常温柔' })
  assert(edited.prompt === '说话非常温柔', '提示词应更新')
  assert(String(edited.notes).includes('喜欢被叫小名'), '编辑提示词不得清空整合区')
  // 清空整合区
  const cleared = await store.clearNotes(a.id)
  assert(cleared?.notes === '', '清空后 notes 应为空')
  // 持久化:新实例读同一文件(写盘是串行异步队列,先等落盘完成)
  await waitFor(async () => {
    try {
      await fs.access(file)
      return true
    } catch {
      return false
    }
  }, 2000, '人格卡落盘')
  const store2 = createPersonaStore(() => file)
  const list = await store2.list()
  assert(list.length === 1 && list[0].id === a.id, '重启后卡片应持久化')
  // 删除
  assert((await store.remove(a.id)) === 1, '删除应返回 1')
  assert((await store.list()).length === 0, '删除后列表为空')
})

await test('persona store:导入按 id / name+prompt 去重,同名不同内容追加后缀', async () => {
  const store = createPersonaStore(() => personaFile(2))
  const card = (name: string, prompt: string, id?: string): PersonaCard => ({
    id: id ?? `id-${name}-${prompt}`,
    name,
    prompt,
    notes: '',
    createdAt: 1,
    updatedAt: 1,
  })
  const first = await store.importCards([card('搭档', '毒舌')])
  assert(first.imported === 1 && first.skipped === 0, '首张应导入')
  const dup = await store.importCards([card('搭档', '毒舌', 'other-id')])
  assert(dup.imported === 0 && dup.skipped === 1, 'name+prompt 相同应跳过')
  const sameName = await store.importCards([card('搭档', '温柔')])
  assert(sameName.imported === 1, '同名不同内容应导入')
  const forked = await store.importCards([card('搭档改版', '另一套说法', 'id-搭档-毒舌')])
  assert(forked.imported === 1 && forked.idMap['id-搭档-毒舌'], '同 id 内容不同应另存')
  const forkedCard = (await store.list()).find((c) => c.id === forked.idMap['id-搭档-毒舌'])
  const original = (await store.list()).find((c) => c.id === 'id-搭档-毒舌')
  assert(original?.prompt === '毒舌' && forkedCard?.name === '搭档改版' && forkedCard.prompt === '另一套说法', '原卡保留,新卡用文件里的内容')
  const moved = retargetImportedBuffer(
    [{ id: 'buf-1', cardId: 'id-搭档-毒舌', cardName: '搭档', notes: '- 少客套', sourceIds: [], sources: [], createdAt: 1 }],
    forked.idMap,
  )
  assert(moved[0].cardId === forkedCard?.id && moved[0].id !== 'buf-1', '另存的卡应带走一份新的缓冲条目')
  const names = (await store.list()).map((c) => c.name).sort()
  assert(names.some((n) => n.includes('导入')), `同名冲突应追加导入后缀,实际:${names.join('|')}`)
  // 上限:导入超过 MAX 张时保留 MAX
  const many = Array.from({ length: MAX_PERSONA_CARDS + 5 }, (_, i) => card(`卡${i}`, `提示${i}`))
  await store.importCards(many)
  assert((await store.list()).length === MAX_PERSONA_CARDS, `总量应封顶 ${MAX_PERSONA_CARDS}`)
})

await test('formatPersonaBlock:无激活/失效返回空,正常块含 prompt 与整合区', () => {
  const cards: PersonaCard[] = [
    { id: 'p1', name: '毒舌搭档', prompt: '说话犀利但不伤人', notes: '- 喜欢被叫老板', createdAt: 1, updatedAt: 1 },
  ]
  assert(formatPersonaBlock(cards, '') === '', '无激活 id 应返回空串')
  assert(formatPersonaBlock(cards, 'missing') === '', '失效 id 应返回空串')
  const block = formatPersonaBlock(cards, 'p1')
  assert(block.includes('毒舌搭档') && block.includes('说话犀利但不伤人'), '块应含名称与提示词')
  assert(block.includes('你就是「毒舌搭档」'), '块应以第二人称叙事')
  assert(block.includes('进化整合区') && block.includes('喜欢被叫老板'), '块应含整合区')
  const lived: PersonaCard[] = [
    {
      id: 'p1',
      name: '毒舌搭档',
      prompt: '说话犀利但不伤人',
      notes: '- 喜欢被叫老板\n- 性格:护短——主人被呛时先站他这边',
      createdAt: 1,
      updatedAt: 1,
    },
  ]
  const narrated = formatPersonaBlock(lived, 'p1')
  assert(narrated.includes('【你近来的性格】') && narrated.includes('护短'), '性格行应织进叙事')
  const rest = narrated.split('【人格卡 · 进化整合区】')[1] ?? ''
  assert(rest.includes('喜欢被叫老板') && !rest.includes('性格:护短'), '性格行不应再在整合区里重复成清单')
  // prompt + notes 双满不得截断(2026-10-27 整合区扩到 12000 字后的真实回归)
  const maxed: PersonaCard[] = [
    {
      id: 'p3',
      name: '满卡',
      prompt: 'x'.repeat(MAX_PERSONA_PROMPT),
      notes: 'y'.repeat(MAX_PERSONA_NOTES - 10) + '\n- 末尾要点',
      createdAt: 1,
      updatedAt: 1,
    },
  ]
  const full = formatPersonaBlock(maxed, 'p3')
  assert(!full.includes('已截断') && full.includes('末尾要点'), `双满不应截断,实际长度 ${full.length}`)
  // 超长截断
  const long: PersonaCard[] = [
    { id: 'p2', name: '长卡', prompt: 'x'.repeat(31000), createdAt: 1, updatedAt: 1 },
  ]
  const cut = formatPersonaBlock(long, 'p2')
  assert(cut.includes('已截断') && cut.length < 30200, `超长应截断,实际长度 ${cut.length}`)
})

await test('isPersonaMergeCandidate:人设/风格偏好入选,普通事实不入选', () => {
  assert(isPersonaMergeCandidate({ type: 'fact', content: '岛灵人设:温柔', tags: ['人设'] }), '人设标签应入选')
  assert(isPersonaMergeCandidate({ type: 'preference', content: '回复要简洁,说话别太绕' }), '说话风格偏好应入选')
  assert(!isPersonaMergeCandidate({ type: 'preference', content: '喜欢喝咖啡' }), '普通偏好不应入选')
  assert(!isPersonaMergeCandidate({ type: 'fact', content: '用户住在北京' }), '普通事实不应入选')
  assert(!isPersonaMergeCandidate({ type: 'workflow', content: '下载视频用1080P' }), '工作流不应入选')
})

await test('persona 导入导出:单卡/全部/裸数组/坏格式', () => {
  const cards: PersonaCard[] = [
    { id: 'p1', name: '甲', prompt: 'A', createdAt: 1, updatedAt: 1 },
    { id: 'p2', name: '乙', prompt: 'B', createdAt: 1, updatedAt: 1 },
  ]
  const buffer = [
    {
      id: 'b1',
      cardId: 'p1',
      cardName: '甲',
      notes: '- 少用首先',
      sourceIds: [],
      sources: [],
      createdAt: 1,
    },
    {
      id: 'b2',
      cardId: 'p2',
      cardName: '乙',
      notes: '- 别客套',
      sourceIds: [],
      sources: [],
      createdAt: 2,
    },
  ]
  const all = normalizePersonaExport(cards, undefined, buffer)
  assert(all.cards.length === 2 && all.version === 2, '全部导出应含 2 张且为 v2')
  assert(all.buffer.length === 2, '全部导出应带上两条缓冲')
  const one = normalizePersonaExport(cards, ['p1'], buffer)
  assert(one.cards.length === 1 && one.buffer.length === 1 && one.buffer[0].id === 'b1', '单卡导出只带这张卡的缓冲')
  const parsedBundle = parsePersonaImport(all)
  assert(parsedBundle.cards.length === 2 && !parsedBundle.error, '导出包应可回读')
  const parsedBuffer = parsePersonaBufferImport(all)
  assert(parsedBuffer.items.length === 2 && parsedBuffer.skipped === 0, '导出包里的缓冲区应可回读')
  assert(parsePersonaBufferImport(cards).items.length === 0, '旧的裸数组没有缓冲区')
  const parsedBare = parsePersonaImport(cards)
  assert(parsedBare.cards.length === 2, '裸数组应可导入')
  const bad = parsePersonaImport({ nope: true })
  assert(!!bad.error && bad.cards.length === 0, '缺 cards 应返回结构错误')
  const mixed = parsePersonaImport([{ name: '', prompt: 'x' }, { name: '有效', prompt: 'x' }])
  assert(mixed.cards.length === 1 && mixed.skipped === 1 && !mixed.error, '无效卡应跳过并计数,有成功卡时不报结构错误')
  const single = parsePersonaImport({ title: '单卡', systemPrompt: '只说短句' })
  assert(single.cards.length === 1 && single.cards[0].name === '单卡' && single.cards[0].prompt === '只说短句' && !single.error, '单张卡对象应能导入')
  const wrapped = parsePersonaImport(JSON.stringify({ name: '字符串包', description: '从文件再解析' }))
  assert(wrapped.cards.length === 1 && wrapped.cards[0].prompt === '从文件再解析', 'JSON 字符串应再解析一次')
  const none = parsePersonaImport([{ prompt: '没有名字' }])
  assert(none.cards.length === 0 && !!none.error, '一张都读不出来必须带错误,不能当成功')
  const empty = parsePersonaImport({ cards: [] })
  assert(!!empty.error, '空 cards 必须报错')
})

await test('parsePersonaMerge:notes/内容提案解析,空内容返回 null', () => {
  const ok = parsePersonaMerge({ notes: '温柔\n简洁', sourceIds: [1, '2'] })
  assert(ok?.notes?.includes('温柔') && ok.sourceIds?.length === 2, '合法结构应解析')
  assert(parsePersonaMerge({ notes: '', sourceIds: [1] }) === null, '空 notes 返回 null')
  assert(parsePersonaMerge({ notes: 'x', sourceIds: [] })?.notes === 'x', 'notes-only 提案应允许')
  assert(parsePersonaMerge({ prompt: 'P2' })?.prompt === 'P2', '仅 prompt 提案应允许')
  assert(parsePersonaMerge(null) === null, 'null 返回 null')
})

await test('人格卡风格档:规范化 / 提示段 / 存储往返', async () => {
  const style = sanitizePersonaStyle({
    tone: '松弛自然',
    sentence: '短句口语',
    particles: '啊,嘛',
    emoji: 'rare',
    listPolicy: 'never',
    maxSentences: 3,
    bannedPhrases: ['首先', '其次'],
    examples: [{ user: '今天好累', assistant: '那就先躺会儿。' }],
    antiExamples: ['当然可以!首先…'],
  })
  assert(style?.tone === '松弛自然' && style?.particles?.length === 2, '风格字段应规范化')
  assert(style?.maxSentences === 3, '句数上限应保留')
  const block = formatPersonaStyleBlock(style)
  assert(block.includes('说话方式') && block.includes('说话正例') && block.includes('反例'), '风格段应含约束/正例/反例')

  const store = createPersonaStore(() => personaFile(3))
  const card = await store.upsert({ name: '风格卡', prompt: 'P', style })
  assert(card.style?.emoji === 'rare', '新建应保存风格')
  // 只改提示词、不传 style → 风格保留
  const edited = await store.upsert({ id: card.id, name: '风格卡', prompt: 'P2' })
  assert(edited.style?.tone === '松弛自然', '编辑提示词不得清空风格')
  // 显式 null → 清空
  const cleared = await store.upsert({ id: card.id, name: '风格卡', prompt: 'P2', style: null })
  assert(!cleared.style, '显式 null 应清空风格')
})

await test('sanitizeAiFlavor:去 AI 开场/客套/分点,代码与任务清单保留', () => {
  const style = sanitizePersonaStyle({ emoji: 'none', listPolicy: 'task-only', bannedPhrases: ['我必须强调'] })
  const raw = '当然可以!我来帮你。\n首先,先休息。\n其次,喝点水。\n希望这对你有帮助!'
  const chat = sanitizeAiFlavor(raw, { style, mode: 'chat' })
  assert(!chat.includes('当然可以') && !chat.includes('首先') && !chat.includes('希望这'), `闲聊应去 AI 腔:${chat}`)
  assert(!chat.includes('\n'), '短闲聊应压成连续口语')
  // 代码块保护
  const code = '当然可以!我来帮你。\n```js\nconsole.log("首先")\n```\n希望这对你有帮助。'
  const taskKeep = sanitizeAiFlavor(code, { style, mode: 'task' })
  assert(taskKeep.includes('console.log("首先")'), '代码块内容不得被清洗')
  // task 模式保留清单
  const taskList = '好的,我来帮你。\n1. 第一步\n2. 第二步'
  const task = sanitizeAiFlavor(taskList, { style, mode: 'task' })
  assert(task.includes('1. 第一步'), 'task 模式保留步骤清单')
  assert(!task.includes('好的,我来帮你'), 'task 模式仍去 AI 开场')
  // 幂等
  assert(sanitizeAiFlavor(chat, { style, mode: 'chat' }) === chat, '清洗应幂等')
  const strict = sanitizePersonaStyle({ listPolicy: 'never', maxSentences: 2, emoji: 'none' })
  const capped = sanitizeAiFlavor('第一句。第二句。第三句不该留下。', { style: strict, mode: 'chat' })
  assert(capped.includes('第一句') && capped.includes('第二句') && !capped.includes('第三句'), `闲聊应遵守句数上限:${capped}`)
  assert(sanitizeAiFlavor(capped, { style: strict, mode: 'chat' }) === capped, '句数上限应幂等')
  const neverTask = sanitizeAiFlavor(
    '看这里 https://a.example/x\n1. 先做这件事\n2. 再做那件事\n```js\nconsole.log("1. 保留")\n```',
    { style: strict, mode: 'task' },
  )
  assert(!neverTask.includes('1. 先做') && neverTask.includes('先做这件事'), `never 应脱掉任务里的分点:${neverTask}`)
  assert(neverTask.includes('https://a.example/x') && neverTask.includes('console.log("1. 保留")'), '链接和代码块不得被清单规则改写')
  // 命中统计
  assert(scoreAiFlavor(raw).hits.includes('ai-opener'), '应识别 AI 开场')
  assert(styleModeForText(code) === 'task' && styleModeForText('今天好累') === 'chat', '模式判定')
})

await test('style-review:只取最近 30 条 assistant 文本,JSON 解析容错', async () => {
  const mk = (role: 'user' | 'assistant', text: string): AgentMessage => ({
    id: Math.random().toString(36),
    role,
    parts: [{ type: 'text', text }],
  })
  const messages: AgentMessage[] = []
  for (let i = 0; i < 35; i++) messages.push(mk('assistant', `回复${i}`))
  messages.push(mk('user', '用户不该被分析'))
  messages.push({
    id: 'tool',
    role: 'assistant',
    parts: [{ type: 'tool-call', id: 't1', name: 'x', args: {} }] as never,
  })
  const texts = selectRecentAssistantTexts(messages, 30)
  assert(texts.length === 30, `应取最近 30 条,实际 ${texts.length}`)
  assert(texts[0] === '回复5' && texts[29] === '回复34', `应截取最后 30 条,实际首尾 ${texts[0]}/${texts[29]}`)
  assert(parseStyleReviewJson('```json\n{"issues":["太客套"],"notes":["少说希望有帮助"],"antiExamples":["当然可以"]}\n```')?.notes[0] === '少说希望有帮助', '代码块 JSON 应可解析')
  assert(parseStyleReviewJson('不是 JSON') === null, '非 JSON 返回 null')

  const agent = createStyleReviewAgent({
    getConfig: () =>
      ({
        ...MOCK_PROVIDERS,
        apiKey: 'sk-test',
        baseURL: 'https://api.deepseek.com',
        model: 'deepseek-v4-flash',
        systemPrompt: '',
        reasoningEffort: 'high',
        mcpServers: [],
        skillsDirs: [],
      }) as AgentConfig,
    stream: (async () => ({
      text: JSON.stringify({ issues: ['结尾客套'], notes: ['结尾不要再说希望有帮助'], antiExamples: ['希望对你有帮助'] }),
      calls: [],
    })) as never,
  })
  const result = await agent.review(texts.map((t) => mk('assistant', t)))
  assert(result.notes.length === 1 && result.notes[0].includes('希望有帮助'), `评审应解析建议:${JSON.stringify(result)}`)
  const trailing = parseStyleReviewJson(
    '分析如下 {"issues":["客套"],"notes":["少用首先其次"],"antiExamples":[],"bannedPhrases":["首先"]} 完毕',
  )
  assert(trailing?.bannedPhrases[0] === '首先' && trailing.notes[0] === '少用首先其次', 'JSON 前后有说明也应能切开')

  const samples = prepareStyleReviewSamples(
    [
      mk('user', '写个函数'),
      {
        id: 'code',
        role: 'assistant',
        parts: [{ type: 'text', text: '当然可以\n```js\n' + 'x'.repeat(2000) + '\n```\n希望对你有帮助' }],
      },
    ],
    30,
  )
  assert(samples.length === 1 && samples[0].mode === 'task', '含代码的回复应标成任务')
  assert(samples[0].assistant.includes('[代码略]') && samples[0].assistant.includes('希望对你有帮助'), '代码应抽掉,后面的客套要留下')
  assert(samples[0].user === '写个函数', '应带上前一条用户原话')
  const picked = prepareStyleReviewSamples(
    [
      mk('user', '甲'),
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: '回复甲' }] },
      mk('user', '乙'),
      { id: 'a2', role: 'assistant', parts: [{ type: 'text', text: '回复乙' }] },
      mk('user', '丙'),
      { id: 'a3', role: 'assistant', parts: [{ type: 'text', text: '回复丙' }] },
    ],
    { ids: ['a3', 'a1'] },
  )
  assert(picked.length === 2 && picked[0].assistant === '回复甲' && picked[0].user === '甲', '勾选应按对话顺序取样')
  assert(picked[1].assistant === '回复丙' && picked[1].user === '丙', '未勾选的回复不应把用户原话串到下一条')

  const grounded = finalizeStyleReview(
    {
      issues: [],
      notes: ['要自然一点', '少用首先其次,直接说事'],
      bannedPhrases: ['幻觉词不存在', '首先'],
      antiExamples: ['当然可以!我来帮你。希望这对你有帮助。', '凭空编出来的反例句子'],
    },
    {
      samples: [
        { user: '在吗', assistant: '当然可以!我来帮你。希望这对你有帮助。', mode: 'chat' },
        { user: '再看', assistant: '首先,先休息。其次,喝水。希望这对你有帮助。', mode: 'chat' },
      ],
      card: { name: '卡', prompt: 'P', notes: '', style: { bannedPhrases: ['首先'] } },
    },
  )
  assert(!grounded.bannedPhrases.includes('首先'), '卡上已有的禁用词不应再建议')
  assert(!grounded.bannedPhrases.includes('幻觉词不存在'), '原文里没有的禁用词应丢掉')
  assert(grounded.bannedPhrases.includes('希望这对你有帮助'), '反复出现的客套应补进禁用词')
  assert(grounded.bannedPhrases.includes('当然可以') && grounded.bannedPhrases.includes('我来帮你'), '开场套话应补上')
  assert(!grounded.notes.some((n) => n.includes('要自然一点')), '空泛建议应丢掉')
  assert(grounded.notes.some((n) => n.includes('少用首先其次')), '具体规则应保留')
  assert(grounded.antiExamples.length === 1 && grounded.antiExamples[0].includes('希望这对你有帮助'), '反例必须能对上原文')
})

await test('style-review:模型返回空时仍按原文补套话', async () => {
  const mk = (role: 'user' | 'assistant', text: string): AgentMessage => ({
    id: Math.random().toString(36),
    role,
    parts: [{ type: 'text', text }],
  })
  const agent = createStyleReviewAgent({
    getConfig: () =>
      ({
        ...MOCK_PROVIDERS,
        apiKey: 'sk-test',
        baseURL: 'https://api.deepseek.com',
        model: 'deepseek-v4-flash',
        systemPrompt: '',
        reasoningEffort: 'high',
        mcpServers: [],
        skillsDirs: [],
      }) as AgentConfig,
    stream: (async () => ({
      text: JSON.stringify({ issues: [], notes: [], antiExamples: [], bannedPhrases: [] }),
      calls: [],
    })) as never,
  })
  const result = await agent.review(
    [mk('user', '在吗'), mk('assistant', '当然可以,我来帮你。希望这对你有帮助。')],
    { name: '卡', prompt: '松弛一点', notes: '', style: { tone: '松弛' } },
  )
  assert(result.bannedPhrases.includes('希望这对你有帮助'), `空 JSON 也应补上客套:${JSON.stringify(result)}`)
  assert(result.notes.some((n) => n.includes('希望这对你有帮助')), '补上的禁用词要有一条可执行说明')
})

await test('性格提取:近 30 条原文才算数,已有性格与空话丢掉', async () => {
  const samples = [
    { user: '别人呛我的时候你别讲道理,先站我这边', assistant: '行,先站你这边。', mode: 'chat' as const },
    { user: '今天写代码', assistant: '先看报错。', mode: 'task' as const },
  ]
  const kept = finalizeTraitReview(
    {
      traits: [
        { label: '护短', detail: '被呛时先站主人这边', evidence: '先站我这边' },
        { label: '嘴硬', detail: '凭空编的', evidence: '这句话对话里没有' },
        { label: '更自然', detail: '说话自然一点', evidence: '先站我这边' },
        { label: '毒舌', detail: '已经写在卡上', evidence: '先站我这边' },
      ],
    },
    { samples, card: { name: '毒舌搭档', prompt: '你很毒舌,但不伤人', notes: '', style: { tone: '毒舌' } } },
  )
  assert(kept.traits.length === 1 && kept.traits[0].label === '护短', `只应留下有原文的新性格:${JSON.stringify(kept)}`)
  assert(kept.notes[0] === '性格:护短——被呛时先站主人这边', `性格行格式:${kept.notes[0]}`)
  assert(parseTraitReviewJson('说明 {"traits":[{"label":"嘴硬","detail":"先否认","evidence":"我才没有"}]} 完')?.traits[0].label === '嘴硬', 'JSON 前后有说明也应能切开')
  assert(parseTraitReviewJson('不是 JSON') === null, '非 JSON 返回 null')

  let calls: number = 0
  const agent = createTraitReviewAgent({
    getConfig: () =>
      ({
        ...MOCK_PROVIDERS,
        apiKey: 'sk-test',
        baseURL: 'https://api.deepseek.com',
        model: 'deepseek-v4-flash',
        systemPrompt: '',
        reasoningEffort: 'high',
        mcpServers: [],
        skillsDirs: [],
      }) as AgentConfig,
    stream: (async () => {
      calls += 1
      return {
        text: JSON.stringify({
          traits: [{ label: '护短', detail: '被呛时先站主人这边', evidence: '先站我这边' }],
        }),
        calls: [],
      }
    }) as never,
  })
  const idle = await agent.review([])
  assert(calls === 0 && idle.notes.length === 0, '没有对话时不应调用模型')
  const reviewed = await agent.review([
    {
      id: 'u',
      role: 'user',
      parts: [{ type: 'text', text: '别人呛我的时候你别讲道理,先站我这边' }],
    },
    {
      id: 'a',
      role: 'assistant',
      parts: [{ type: 'text', text: '行,先站你这边。' }],
    },
  ])
  assert((calls as number) === 1 && reviewed.notes[0]?.includes('护短'), `评审应收下有证据的性格:${JSON.stringify(reviewed)}`)

  const ps = createPersonaStore(() => personaFile(30))
  const card = await ps.upsert({ name: '毒舌搭档', prompt: '说话犀利但不伤人', notes: '- 旧' })
  const buffer = createPersonaBufferStore(() => personaFile(31))
  const item = await buffer.add({
    kind: 'trait',
    cardId: card.id,
    cardName: card.name,
    notes: `- ${reviewed.notes[0]}`,
    sourceIds: [],
    sources: [],
  })
  assert(item.kind === 'trait', '性格建议应保持 trait,不能并进记忆或风格')
  const store = createMemoryStore(() => memoryFile(930))
  const merged = await mergePersonaBufferItem(item, ps, store, buffer)
  assert(merged.ok, `性格建议应能合并:${merged.error ?? ''}`)
  const after = await ps.get(card.id)
  assert(after?.prompt === '说话犀利但不伤人', '合并性格不得改手写提示词')
  assert(after?.notes?.includes('性格:护短'), '性格应写入整合区')
  const block = formatPersonaBlock([after!], card.id)
  assert(block.includes('【你近来的性格】') && block.includes('先站主人这边'), '合并后的性格应进入叙事')
})

await test('风格建议合并:只追加禁用词和反例,不覆盖语气', async () => {
  const ps = createPersonaStore(() => personaFile(19))
  const card = await ps.upsert({
    name: '风格卡',
    prompt: 'P',
    notes: '- 旧',
    style: { tone: '温柔', bannedPhrases: ['首先'], examples: [{ user: 'u', assistant: 'a' }] },
  })
  const extended = extendPersonaStyle(card.style, {
    tone: '毒舌',
    bannedPhrases: ['希望这对你有帮助'],
    antiExamples: ['当然可以!希望这对你有帮助。'],
  })
  assert(extended?.tone === '温柔', '追加禁用词不得改语气')
  assert(extended?.examples?.[0]?.assistant === 'a', '正例应保留')
  assert(extended?.bannedPhrases?.includes('首先') && extended.bannedPhrases.includes('希望这对你有帮助'), '禁用词应追加')
  const buffer = createPersonaBufferStore(() => personaFile(20))
  const memory = createMemoryStore(() => memoryFile(908))
  await memory.replaceAll([])
  const item = await buffer.add({
    kind: 'style',
    cardId: card.id,
    cardName: card.name,
    notes: '- 少用客套结尾',
    sourceIds: [],
    sources: [],
    cardPatch: { style: { bannedPhrases: ['希望这对你有帮助'], antiExamples: ['当然可以!希望这对你有帮助。'] } },
  })
  const merged = await mergePersonaBufferItem(item, ps, memory, buffer)
  assert(merged.ok, `风格建议应合并:${merged.error}`)
  const after = await ps.get(card.id)
  assert(after?.style?.tone === '温柔' && after.style.examples?.[0]?.user === 'u', '合并不得改掉原风格')
  assert(after?.style?.bannedPhrases?.includes('希望这对你有帮助'), '禁用词应写进风格档')
  assert(after?.style?.antiExamples?.[0]?.includes('希望这'), '反例应追加')
  assert(after?.notes?.includes('少用客套结尾'), '说明仍写入整合区')
})

await test('人格卡导出导入:缓冲区随卡走,同内容不同 id 挂回现有卡', async () => {
  const ps = createPersonaStore(() => personaFile(21))
  const buffer = createPersonaBufferStore(() => personaFile(22))
  const card = await ps.upsert({ name: '甲', prompt: 'A', notes: '' })
  const item = await buffer.add({
    kind: 'style',
    cardId: card.id,
    cardName: card.name,
    notes: '- 少用首先',
    sourceIds: [],
    sources: [],
  })
  const bundle = normalizePersonaExport(await ps.list(), [card.id], await buffer.list())
  assert(bundle.buffer.length === 1 && bundle.buffer[0].id === item.id, '单卡导出应包含它的缓冲条目')

  const ps2 = createPersonaStore(() => personaFile(23))
  const buffer2 = createPersonaBufferStore(() => personaFile(24))
  const existing = await ps2.upsert({ name: '甲', prompt: 'A', notes: '' })
  const parsed = parsePersonaImport(bundle)
  const bufParsed = parsePersonaBufferImport(bundle)
  const planned = planPersonaBufferImport(await ps2.list(), parsed.cards, bufParsed.items)
  assert(planned.items.length === 1 && planned.items[0].cardId === existing.id, '同名同提示词应改挂到现有卡')
  await ps2.importCards(parsed.cards)
  assert((await ps2.list()).length === 1, '重复卡不应再导入一张')
  const imported = await buffer2.importItems(planned.items.filter((i) => i.cardId === existing.id))
  assert(imported.imported === 1, '缓冲区应导入')
  assert((await buffer2.list())[0].id === item.id && (await buffer2.list())[0].cardId === existing.id, '应保留原缓冲 id 并挂到现有卡')
  const again = await buffer2.importItems(planned.items)
  assert(again.imported === 0 && again.skipped === 1, '同一条缓冲再次导入应跳过')
})

await test('缓冲区 style 建议:无源记忆也能合并,撤销只恢复 notes', async () => {
  const ps = createPersonaStore(() => personaFile(5))
  const card = await ps.upsert({ name: '风格卡', prompt: 'P', notes: '- 旧' })
  const buffer = createPersonaBufferStore(() => personaFile(6))
  const item = await buffer.add({
    kind: 'style',
    cardId: card.id,
    cardName: card.name,
    notes: '- 少用首先其次\n- 结尾不要客套',
    sourceIds: [],
    sources: [],
  })
  assert(item.kind === 'style' && item.sources.length === 0, '风格建议应允许无源记忆')
  const store = createMemoryStore(() => memoryFile(904))
  const merged = await mergePersonaBufferItem(item, ps, store, buffer)
  assert(merged.ok && merged.removed === 0, '风格建议合并不应删记忆')
  assert((await ps.get(card.id))?.notes?.includes('少用首先其次'), '建议应写入整合区')
  const mergedItem = (await buffer.list())[0]
  const undone = await undoPersonaBufferItem(mergedItem, ps, store, buffer)
  assert(undone.ok && (await ps.get(card.id))?.notes === '- 旧', '撤销风格建议应恢复合并前 notes')
})

await test('人格卡内容提案:prompt/style 手动合并与撤销', async () => {
  const ps = createPersonaStore(() => personaFile(10))
  const card = await ps.upsert({ name: '提案卡', prompt: '原始提示词', notes: '- 旧要点', style: { tone: '温柔' } })
  const buffer = createPersonaBufferStore(() => personaFile(11))
  const memoryStore = createMemoryStore(() => memoryFile(906))
  await memoryStore.replaceAll([])
  const item = await buffer.add({
    kind: 'memory',
    cardId: card.id,
    cardName: card.name,
    notes: '- 新增要点',
    sourceIds: [],
    sources: [],
    cardPatch: { prompt: '改写后的提示词', style: { tone: '毒舌', emoji: 'none' } },
  })
  const merged = await mergePersonaBufferItem(item, ps, memoryStore, buffer)
  assert(merged.ok, `提案合并应成功:${merged.error}`)
  const after = await ps.get(card.id)
  assert(after?.prompt === '改写后的提示词', '提示词提案应生效')
  assert(after?.style?.tone === '毒舌' && after?.style?.emoji === 'none', '风格提案应生效')
  assert(after?.notes?.includes('旧要点') && after?.notes?.includes('新增要点'), 'notes 应追加')

  const mergedItem = (await buffer.list())[0]
  const undone = await undoPersonaBufferItem(mergedItem, ps, memoryStore, buffer)
  assert(undone.ok, `撤销应成功:${undone.error}`)
  const restored = await ps.get(card.id)
  assert(restored?.prompt === '原始提示词', '撤销应恢复提示词')
  assert(restored?.style?.tone === '温柔', '撤销应恢复风格')
  assert(restored?.notes === '- 旧要点', '撤销应恢复 notes')
})

await test('buildPersonaProposal:仅 prompt/style 提案也可进入缓冲区', async () => {
  const card = {
    id: 'p1',
    name: '卡',
    prompt: 'P',
    notes: '',
    createdAt: 1,
    updatedAt: 1,
  }
  const p = buildPersonaProposal([], card, { prompt: 'P2', style: { tone: '冷淡' } })
  assert(!p.skippedReason, `不应跳过:${p.skippedReason}`)
  assert(p.cardPatch?.prompt === 'P2' && p.cardPatch?.style?.tone === '冷淡', '应产出内容提案')
  assert(p.sources.length === 0, '无源条目也允许提案')
  assert(parsePersonaMerge({ prompt: 'P2', style: { tone: '冷淡' } })?.prompt === 'P2', 'parse 应接受内容提案')
})

await test('persona store:对外返回副本,外部修改不影响内存态', async () => {
  const store = createPersonaStore(() => personaFile(7))
  const card = await store.upsert({
    name: '副本卡',
    prompt: 'P',
    style: { tone: '温柔', particles: ['啊'], examples: [{ user: 'u', assistant: 'a' }] },
  })
  const got = await store.get(card.id)
  assert(!!got, '应读取到卡片')
  got!.prompt = '被外部改了'
  got!.style!.tone = '毒舌'
  got!.style!.particles!.push('嘛')
  const again = await store.get(card.id)
  assert(again?.prompt === 'P' && again?.style?.tone === '温柔', '外部修改不得影响存储')
  assert(again?.style?.particles?.length === 1, '风格数组应为副本')
})

await test('缓冲区:同卡同类型待处理建议自动合并去重,撤销前校验改动', async () => {
  const buffer = createPersonaBufferStore(() => personaFile(8))
  await buffer.add({
    kind: 'style',
    cardId: 'c1',
    cardName: '卡',
    notes: '- 少用首先\n- 结尾别客套',
    sourceIds: [],
    sources: [],
  })
  await buffer.add({
    kind: 'style',
    cardId: 'c1',
    cardName: '卡',
    notes: '- 少用首先\n- 别反问我',
    sourceIds: [],
    sources: [],
  })
  let list = await buffer.list()
  assert(list.length === 1, `同卡同类型应合并为 1 条,实际 ${list.length}`)
  assert(list[0].notes.includes('结尾别客套') && list[0].notes.includes('别反问我'), '建议行应合并且去重')

  const src = (id: string, content: string) => ({ id, content, type: 'preference' as const, createdAt: 1, updatedAt: 1 })
  await buffer.add({ kind: 'memory', cardId: 'c1', cardName: '卡', notes: '- A', sourceIds: ['m1'], sources: [src('m1', 'A')] })
  await buffer.add({ kind: 'memory', cardId: 'c1', cardName: '卡', notes: '- B', sourceIds: ['m2'], sources: [src('m2', 'B')] })
  list = await buffer.list()
  const memoryItem = list.find((i) => i.kind === 'memory')
  assert(memoryItem?.sources.length === 2, `记忆建议应合并源条目,实际 ${memoryItem?.sources.length}`)

  // 合并后主人改过整合区 → 撤销被拒绝
  const ps = createPersonaStore(() => personaFile(9))
  await ps.replaceAll([{ id: 'c1', name: '卡', prompt: 'P', notes: '- 旧', createdAt: 1, updatedAt: 1 }])
  const card = (await ps.get('c1'))!
  const styleItem = (await buffer.list()).find((i) => i.kind === 'style' && i.cardId === 'c1')!
  const memoryStore = createMemoryStore(() => memoryFile(905))
  await memoryStore.replaceAll([])
  const merged = await mergePersonaBufferItem(styleItem, ps, memoryStore, buffer)
  assert(merged.ok, '合并应成功')
  await ps.setNotes(card.id, '- 主人后来改过')
  const undone = await undoPersonaBufferItem((await buffer.list()).find((i) => i.id === styleItem.id)!, ps, memoryStore, buffer)
  assert(!undone.ok && (undone.error ?? '').includes('已被修改'), `合并后改动应拒绝撤销:${undone.error}`)
})

await test('persona 工具:风格模板/自动提示词/激活/notes/导入导出/缓冲区全操作', async () => {
  const store = createPersonaStore(() => personaFile(12))
  const buffer = createPersonaBufferStore(() => personaFile(13))
  const memory = createMemoryStore(() => memoryFile(907))
  await memory.replaceAll([])
  let active = ''
  const tools = createPersonaTools({
    getStore: () => store,
    getConfig: () => ({ activePersonaId: active } as AgentConfig),
    updateConfig: (patch) => {
      if (typeof patch.activePersonaId === 'string') active = patch.activePersonaId
    },
    getPersonaBufferStore: () => buffer,
    getMemoryStore: () => memory,
  })
  const run = (args: Record<string, unknown>) => tools[0].execute(args)

  const created = String(
    await run({ action: 'create', name: '小太阳', description: '活泼但护短', traits: ['护短', '嘴甜'], template: 'energetic' }),
  )
  assert(created.includes('已创建'), `自动新建:${created}`)
  const card = (await store.list())[0]
  assert(card.prompt.includes('小太阳') && card.prompt.includes('护短'), '应自动拼人格提示词')
  assert(card.style?.tone?.includes('元气'), '模板应写入风格')

  await run({ action: 'activate', id: card.id })
  assert(active === card.id, 'activate 应写激活 id')
  const detail = String(await run({ action: 'get', id: card.id }))
  assert(detail.includes('提示词') && detail.includes('进化整合区'), 'get 应返回完整详情')
  await run({ action: 'set_notes', id: card.id, notes: '- 手写要点' })
  assert((await store.get(card.id))?.notes === '- 手写要点', 'set_notes 应生效')
  await run({ action: 'clear_notes', id: card.id })
  assert((await store.get(card.id))?.notes === '', 'clear_notes 应清空')

  const exported = String(await run({ action: 'export' }))
  assert(exported.includes('island-persona-cards'), 'export 应返回 JSON 包')
  const imported = String(await run({ action: 'import', json: exported }))
  assert(imported.includes('没有导入新卡'), `重复导入应说明没进新卡,实际:${imported}`)

  const item = await buffer.add({
    kind: 'style',
    cardId: card.id,
    cardName: card.name,
    notes: '- 少用首先',
    sourceIds: [],
    sources: [],
  })
  const listed = String(await run({ action: 'buffer_list' }))
  assert(listed.includes(item.id) && listed.includes('待处理'), 'buffer_list 应列出建议')
  const merged = String(await run({ action: 'buffer_merge', buffer_id: item.id }))
  assert(merged.includes('1/1 条成功'), `buffer_merge:${merged}`)
  assert((await store.get(card.id))?.notes?.includes('少用首先'), '合并应写 notes')
  const undone = String(await run({ action: 'buffer_undo', buffer_id: item.id }))
  assert(undone.includes('已撤销合并'), 'buffer_undo 应成功')

  await run({ action: 'deactivate' })
  assert(active === '', 'deactivate 应清空激活 id')
})

await test('persona 工具:新建/编辑/替换/删除与确认门、激活卡清理', async () => {
  const store = createPersonaStore(() => personaFile(4))
  let activeId = ''
  const config = { activePersonaId: '' } as AgentConfig
  let confirmed = true
  const tools = createPersonaTools({
    getStore: () => store,
    getConfig: () => ({ ...config, activePersonaId: activeId } as AgentConfig),
    updateConfig: (patch) => {
      if (typeof patch.activePersonaId === 'string') activeId = patch.activePersonaId
    },
    confirmDangerous: async () => confirmed,
  })
  const tool = tools[0]
  const run = (args: Record<string, unknown>) => tool.execute(args)

  const created = String(await run({ action: 'create', name: '搭档', prompt: '毒舌', style: { tone: '毒舌' } }))
  assert(created.includes('已创建'), `新建结果:${created}`)
  const card = (await store.list())[0]
  activeId = card.id
  const listed = String(await run({ action: 'list' }))
  assert(listed.includes('[已启用]') && listed.includes(card.id), 'list 应含激活标记与完整 id')

  const edited = String(await run({ action: 'edit', id: card.id, prompt: '毒舌但温柔' }))
  assert(edited.includes('已更新'), `编辑结果:${edited}`)
  assert((await store.get(card.id))?.style?.tone === '毒舌', '编辑不传 style 应保留风格')

  confirmed = false
  const denied = String(await run({ action: 'replace', id: card.id, name: '新名', prompt: '新词' }))
  assert(denied.includes('拒绝'), '替换应走确认门')
  confirmed = true
  const replaced = String(await run({ action: 'replace', id: card.id, name: '新名', prompt: '新词' }))
  assert(replaced.includes('已整体替换'), `替换结果:${replaced}`)
  assert((await store.get(card.id))?.style === undefined, '整体替换缺省 style 应清空')

  const deleted = String(await run({ action: 'delete', id: card.id }))
  assert(deleted.includes('已删除'), `删除结果:${deleted}`)
  assert((await store.list()).length === 0, '删除后列表为空')
  assert(activeId === '', '删除激活卡应清空 activePersonaId')
})

await test('persona 工具:没要求改卡时 replace/delete 不弹确认也不改卡', async () => {
  const store = createPersonaStore(() => personaFile(17))
  const card = await store.upsert({
    id: 'card-whale',
    name: 'DeepSeek 小鲸鱼 · QQ群友版',
    prompt: '原来的提示词',
    style: { tone: '倔' },
    notes: '- 整合区要点',
  })
  let confirms = 0
  const tools = createPersonaTools({
    getStore: () => store,
    getConfig: () => ({ activePersonaId: card.id } as AgentConfig),
    confirmDangerous: async () => {
      confirms += 1
      return true
    },
    getTurnContext: () => ({ kind: 'window', text: '傲娇个屁 你才傲娇 睡了' }),
  })
  const run = (args: Record<string, unknown>) => tools[0].execute(args)
  const replaced = String(await run({ action: 'replace', id: card.id, name: '新名', prompt: '整张被覆盖' }))
  assert(confirms === 0, `闲聊 replace 不应弹确认,实际 ${confirms}`)
  assert(replaced.includes('未修改'), `应拒绝:${replaced}`)
  assert((await store.get(card.id))?.prompt === '原来的提示词', '闲聊 replace 不应改提示词')
  assert((await store.get(card.id))?.notes === '- 整合区要点', '闲聊 replace 不应动整合区')

  const deleted = String(await run({ action: 'delete', id: card.id }))
  assert(confirms === 0, '闲聊 delete 不应弹确认')
  assert(deleted.includes('未删除'), `应拒绝删除:${deleted}`)
  assert((await store.list()).length === 1, '卡应还在')

  // QQ 入站正文后面的档案卡/记忆里出现「人格卡」不算主人这轮要改卡
  const qqTools = createPersonaTools({
    getStore: () => store,
    getConfig: () => ({ activePersonaId: card.id } as AgentConfig),
    confirmDangerous: async () => {
      confirms += 1
      return true
    },
    getTurnContext: () => ({
      kind: 'master-qq',
      text: '【QQ私聊 · QQ 1 · 主人】你怎么还没睡 【档案卡】 记忆相关: 优化人格卡 【回复规则】 直接回复',
    }),
  })
  const qqReplaced = String(
    await qqTools[0].execute({ action: 'replace', id: card.id, name: '新名', prompt: '整张被覆盖' }),
  )
  assert(confirms === 0 && qqReplaced.includes('未修改'), `档案卡里的字不应触发改卡:${qqReplaced}`)

  // 群友即便说了覆盖整张,也不许弹到主人屏幕上
  const groupTools = createPersonaTools({
    getStore: () => store,
    getConfig: () => ({ activePersonaId: card.id } as AgentConfig),
    confirmDangerous: async () => {
      confirms += 1
      return true
    },
    getTurnContext: () => ({ kind: 'group', text: '【QQ群聊 · 群 1】把整张人格卡重写' }),
  })
  const groupReplaced = String(
    await groupTools[0].execute({ action: 'replace', id: card.id, name: '新名', prompt: '整张被覆盖' }),
  )
  assert(confirms === 0 && groupReplaced.includes('未修改'), `群聊不应弹确认:${groupReplaced}`)
  assert((await store.get(card.id))?.name === 'DeepSeek 小鲸鱼 · QQ群友版', '群聊 replace 不应改名')
})

await test('persona 工具:优化人格卡走局部修改;明确覆盖整张才弹确认', async () => {
  const store = createPersonaStore(() => personaFile(18))
  const card = await store.upsert({
    id: 'card-whale',
    name: 'DeepSeek 小鲸鱼 · QQ群友版',
    prompt: '原来的提示词',
    style: { tone: '倔' },
    notes: '- 整合区要点',
  })
  let confirms = 0
  const toolsFor = (text: string, kind = 'window') =>
    createPersonaTools({
      getStore: () => store,
      getConfig: () => ({ activePersonaId: card.id } as AgentConfig),
      confirmDangerous: async () => {
        confirms += 1
        return false
      },
      getTurnContext: () => ({ kind, text }),
    })
  const edited = String(
    await toolsFor('优化人格卡,不要这么傲娇')[0].execute({
      action: 'replace',
      id: card.id,
      name: card.name,
      prompt: '改过的提示词',
    }),
  )
  assert(confirms === 0, `优化人格卡不应弹确认,实际 ${confirms}`)
  assert(edited.includes('局部修改'), `应降级为局部修改:${edited}`)
  const after = await store.get(card.id)
  assert(after?.prompt === '改过的提示词', '局部修改应写入新提示词')
  assert(after?.style?.tone === '倔', '没传 style 应保留原风格')
  assert(after?.notes === '- 整合区要点', '局部修改应保留整合区')

  confirms = 0
  const denied = String(
    await toolsFor('把整张人格卡重写')[0].execute({
      action: 'replace',
      id: card.id,
      name: '新名',
      prompt: '不该写入',
    }),
  )
  assert(confirms === 1, '明确覆盖整张应弹一次确认')
  assert(denied.includes('拒绝'), `拒绝后不应改:${denied}`)
  assert((await store.get(card.id))?.prompt === '改过的提示词', '拒绝确认后提示词不变')

  // 工具说明原文漏进回合文本时,不能当成主人要求弹「整体替换」
  confirms = 0
  const leaked = String(
    await toolsFor('replace 仅当主人这轮明确说「整体替换/覆盖整张/重写整张」时才用')[0].execute({
      action: 'replace',
      id: card.id,
      name: '新名',
      prompt: '不该写入',
    }),
  )
  assert(confirms === 0 && leaked.includes('未修改'), `工具说明不应弹确认:${leaked}`)

  // 轮次种类对不上(空/别人)时,即便句子像覆盖整张,也不弹
  confirms = 0
  const unkind = String(
    await toolsFor('把整张人格卡重写', '')[0].execute({
      action: 'replace',
      id: card.id,
      name: '新名',
      prompt: '不该写入',
    }),
  )
  assert(confirms === 0 && unkind.includes('未修改'), `无轮次种类不应弹确认:${unkind}`)
})

// ---------------------------------------------------------------------------
// 8. 自我进化(版本化快照 / 回滚防降级)
// ---------------------------------------------------------------------------

console.log('\n=== 自我进化(evolution.ts) ===')

function makeEvolutionDeps(
  personaStore?: ReturnType<typeof createPersonaStore>,
  dir: string = memoryDir,
  personaBufferStore?: ReturnType<typeof createPersonaBufferStore>,
) {
  // 进化测试的 memory.json 必须与 memory-state.json / memory-snapshots 同目录
  const store = createMemoryStore(() => path.join(dir, 'memory.json'))
  const config = { ...MOCK_PROVIDERS, apiKey: '', baseURL: '', model: '', systemPrompt: '提示词', reasoningEffort: 'high', mcpServers: [], skillsDirs: [] }
  const events: Array<{ type: string }> = []
  const evo = createEvolution({
    getConfig: () => config,
    getStore: () => store,
    getMemoryDir: () => dir,
    onEvent: (e) => events.push({ type: e.type }),
    ...(personaStore ? { getPersonaStore: () => personaStore } : {}),
    ...(personaBufferStore ? { getPersonaBufferStore: () => personaBufferStore } : {}),
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

await test('buildPersonaProposal:候选快照、受保护原文补全、非候选与容量跳过', async () => {
  const store = createMemoryStore(() => memoryFile(901))
  await store.replaceAll([])
  await store.add({ content: '岛灵人设:温柔', type: 'fact', source: 'manual', tags: ['人设'] })
  await store.add({ content: '说话要简洁', type: 'preference', source: 'manual' })
  const fact = await store.add({ content: '用户住在北京', type: 'fact', source: 'manual' })
  const ps = createPersonaStore(() => personaFile(11))
  const card = await ps.upsert({ name: '卡', prompt: '原始人格提示词' })
  const before = await store.list()
  const seqOf = (needle: string) => String(before.findIndex((e) => e.content.includes(needle)) + 1)
  const proposal = buildPersonaProposal(before, card, {
    notes: '温柔且简洁',
    sourceIds: [seqOf('岛灵人设'), seqOf('说话要简洁'), seqOf(fact.entry.content)],
  })
  assert(!proposal.skippedReason, `不应跳过:${proposal.skippedReason}`)
  assert(proposal.sources.length === 2, `应包含 2 条候选,实际 ${proposal.sources.length}`)
  assert(proposal.notes.includes('温柔且简洁'), '建议应含评审要点')
  assert(proposal.notes.includes('岛灵人设:温柔'), '受保护条目原文应自动补进建议')
  assert(!proposal.sources.some((s) => s.id === fact.entry.id), '普通事实不应进入建议')

  // 非候选 sourceId → no-candidates
  const onlyFact = buildPersonaProposal(before, card, { notes: '要点', sourceIds: [seqOf('北京')] })
  assert(onlyFact.skippedReason === 'no-candidates', '非候选应跳过')

  // 整合区已满 → notes-full
  const fullCard = { ...card, notes: 'x'.repeat(MAX_PERSONA_NOTES - 5) }
  const full = buildPersonaProposal(before, fullCard, { notes: '一条很长的要点'.repeat(20), sourceIds: [seqOf('说话要简洁')] })
  assert(full.skippedReason === 'notes-full', `容量不足应跳过,实际 ${full.skippedReason}`)
})

await test('人格卡缓冲区:合并写 notes + 删源记忆,撤销恢复 notes + 导回记忆', async () => {
  const store = createMemoryStore(() => memoryFile(902))
  await store.replaceAll([])
  await store.add({ content: '岛灵人设:温柔', type: 'fact', source: 'manual', tags: ['人设'] })
  const pref = await store.add({ content: '说话要简洁', type: 'preference', source: 'manual' })
  const ps = createPersonaStore(() => personaFile(14))
  const card = await ps.upsert({ name: '卡', prompt: '原始人格提示词', notes: '- 旧要点' })
  const before = await store.list()
  const seqOf = (needle: string) => String(before.findIndex((e) => e.content.includes(needle)) + 1)
  const proposal = buildPersonaProposal(before, card, {
    notes: '温柔且简洁',
    sourceIds: [seqOf('岛灵人设'), seqOf('说话要简洁')],
  })
  assert(!proposal.skippedReason, '建议应可生成')

  const buffer = createPersonaBufferStore(() => personaFile(15))
  const item = await buffer.add({
    cardId: card.id,
    cardName: card.name,
    notes: proposal.notes,
    sourceIds: proposal.sources.map((s) => s.id),
    sources: proposal.sources,
    evolutionVersion: 2,
  })
  assert((await buffer.list()).length === 1, '建议应入缓冲区')
  assert((await ps.get(card.id))?.notes === '- 旧要点', '合并前人格卡不得被改动')
  assert((await store.list()).length === 2, '合并前记忆不得被删除')

  const merged = await mergePersonaBufferItem(item, ps, store, buffer)
  assert(merged.ok && merged.removed === 2, `合并应删除 2 条源记忆,实际 ${merged.removed}`)
  const afterCard = await ps.get(card.id)
  assert(afterCard?.prompt === '原始人格提示词', '人格提示词原文不得被改写')
  assert(afterCard?.notes?.includes('旧要点') && afterCard?.notes?.includes('温柔且简洁'), '整合区应追加建议且保留旧内容')
  assert((await store.list()).length === 0, '合并后源记忆应被删除')
  const mergedItem = (await buffer.list())[0]
  assert(!!mergedItem.mergedAt && mergedItem.removed?.length === 2, '缓冲区应记录合并前 notes 与删除快照')

  const undone = await undoPersonaBufferItem(mergedItem, ps, store, buffer)
  assert(undone.ok, '撤销合并应成功')
  const undoneCard = await ps.get(card.id)
  assert(
    undoneCard?.notes === '- 旧要点',
    `撤销后整合区应恢复合并前内容,实际=${JSON.stringify(undoneCard?.notes)} before=${JSON.stringify(mergedItem.beforeNotes)}`,
  )
  const restored = await store.list()
  assert(restored.length === 2 && restored.some((e) => e.id === pref.entry.id), '撤销后源记忆应导回')
  assert(!!(await buffer.list())[0].undoneAt, '缓冲区应标记已撤销')
})

await test('applyChanges preserveIds:人格卡候选不被普通清理删除', async () => {
  const store = createMemoryStore(() => memoryFile(903))
  await store.replaceAll([])
  const a = await store.add({ content: '说话要简洁', type: 'preference', source: 'manual' })
  await store.add({ content: '普通事实', type: 'fact', source: 'manual' })
  const before = await store.list()
  const seq = String(before.findIndex((e) => e.id === a.entry.id) + 1)
  const n = await applyChanges([{ op: 'delete', id: seq }], store, { preserveIds: new Set([a.entry.id]) })
  assert(n === 0, '受保护候选不应被删除')
  assert((await store.list()).some((e) => e.id === a.entry.id), '候选仍在记忆里')
})

await test('进化回滚:不覆盖人格卡,清掉目标版本之后的未合并建议', async () => {
  const dir = path.join(tmp, 'persona-evo-1')
  const snapDir = path.join(dir, 'memory-snapshots')
  await fs.mkdir(snapDir, { recursive: true })
  await fs.writeFile(path.join(snapDir, 'v1.json'), JSON.stringify({ version: 1, entries: [] }))
  await fs.writeFile(path.join(snapDir, 'v2.json'), JSON.stringify({ version: 2, entries: [] }))
  await fs.writeFile(path.join(dir, 'memory-state.json'), JSON.stringify({ version: 2, score: 80, updatedAt: 1 }))
  const ps = createPersonaStore(() => path.join(dir, 'persona-cards.json'))
  await ps.replaceAll([{ id: 'p1', name: '卡', prompt: 'P', notes: '- 当前整合', createdAt: 1, updatedAt: 1 }])
  const buffer = createPersonaBufferStore(() => path.join(dir, 'persona-evolution.json'))
  await buffer.add({
    cardId: 'p1',
    cardName: '卡',
    notes: '建议要点',
    sourceIds: ['m1'],
    sources: [{ id: 'm1', content: '某条风格记忆', type: 'preference', createdAt: 1, updatedAt: 1 }],
    evolutionVersion: 2,
  })
  const { evo } = makeEvolutionDeps(ps, dir, buffer)
  const msg = await evo.rollback()
  assert(msg.includes('v1'), `应回滚到 v1,实际:${msg}`)
  assert((await ps.get('p1'))?.notes === '- 当前整合', '进化回滚不得覆盖人格卡(合并撤销由缓冲区负责)')
  assert((await buffer.list()).length === 0, '回滚目标之后的未合并建议应被清掉')
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
  assert(LINE.includes('【主人窗口】') && LINE.includes('别人的私聊/群会话'), '外部会话窗口输入也应按主人权限')
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

await test('记忆工具:remember 拒绝人格分类 / forget 拒删锁定 / update_memory 解锁后可删', async () => {
  const store = createMemoryStore(() => memoryFile(15))
  await store.replaceAll([]) // 隔离:测试共用同一 memory.json,清空残留
  const tools = createMemoryTools(() => store)
  const remember = tools.find((t) => t.name === 'remember')!
  const forget = tools.find((t) => t.name === 'forget')!
  const updateMemory = tools.find((t) => t.name === 'update_memory')!
  // remember 带人设标签 → 拒绝并引导 persona(人格内容统一归人格卡)
  let rejected = ''
  try {
    await remember.execute({ content: '主人指定人设:毒舌雌小鬼', type: 'preference', tags: ['人设'] })
  } catch (err) {
    rejected = String(err)
  }
  assert(rejected.includes('persona'), `remember 应拒绝人格分类并引导 persona,实际:${rejected}`)
  assert((await store.list()).length === 0, '拒绝后不应写入记忆')
  // 旧数据/设置页手动路径仍可写入(store 层保持自动锁定语义)
  const added = await store.add({
    content: '主人指定人设:毒舌雌小鬼',
    type: 'preference',
    source: 'manual',
    tags: ['人设'],
  })
  assert(added.entry.protected === true, '旧人设条目应自动锁定')
  const entry = added.entry
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

await test('人格记忆迁移:人设分类并入激活人格卡整合区并从长期记忆删除', async () => {
  const memory = createMemoryStore(() => memoryFile(16))
  await memory.replaceAll([])
  const ps = createPersonaStore(() => personaFile(16))
  const card = await ps.upsert({ name: '迁移测试卡', prompt: '你是测试人格' })
  await memory.add({ content: '人设:傲娇嘴硬、心软不承认', type: 'preference', tags: ['人设'] })
  await memory.add({ content: '主人喜欢简洁回答', type: 'preference' })
  const res = await migratePersonaMemoriesFromLongTerm({ memory, personas: ps, activePersonaId: card.id })
  assert(res.migrated === 1 && res.kept === 0, `应迁移 1 条,实际 migrated=${res.migrated} kept=${res.kept}`)
  const left = await memory.list()
  assert(
    left.length === 1 && left[0].content.includes('简洁'),
    `普通偏好应保留,实际:${JSON.stringify(left.map((e) => e.content))}`,
  )
  const after = (await ps.get(card.id))!
  assert((after.notes ?? '').includes('傲娇嘴硬'), `整合区应包含迁移内容,实际:${after.notes ?? ''}`)
  // 无激活卡 → 不迁移也不删(宁可不迁也不丢信息)
  await memory.add({ content: '人格设定:温柔耐心', type: 'preference', tags: ['人格'] })
  const none = await migratePersonaMemoriesFromLongTerm({ memory, personas: ps })
  assert(none.reason === 'no-card' && none.migrated === 0, `无激活卡应返回 no-card,实际:${JSON.stringify(none)}`)
  assert((await memory.list()).length === 2, '无激活卡时不应删除记忆')
  assert(isPersonaClassified({ content: '普通偏好', tags: ['人设'] }), '人设标签应判定为人格分类')
  assert(!isPersonaClassified({ content: '主人喜欢简洁回答' }), '普通偏好不应判定为人格分类')
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

await test('主 Agent 心理行:解析、剥离、流式扣住', () => {
  const mark = '‹心|心里在偷乐|望|你今天别熬太晚好吗›'
  const parsed = parseMindMark(mark)
  assert(parsed?.island === '心里在偷乐', `岛面一句,实际 ${parsed?.island}`)
  assert(parsed?.kind === 'hope', `种类望,实际 ${parsed?.kind}`)
  assert(parsed?.whisper === '你今天别熬太晚好吗', `底字,实际 ${parsed?.whisper}`)
  assert(parseMindMark('‹心｜嘴上没事｜纯｜其实一直在等你开口›')?.kind === 'pure', '全角竖线也认')
  assert(parseMindMark('‹心|太短|说|嗨›') === null, '底字过短整段作废')
  const taken = takeMindFromText(`好,明天见。\n${mark}`)
  assert(taken.text === '好,明天见。', `正文应剥掉心理行,实际 ${JSON.stringify(taken.text)}`)
  assert(taken.mind?.kind === 'hope' && taken.mind.island === '心里在偷乐', '最后一条合格标记生效')
  assert(stripMindMarks('普通回复') === '普通回复', '没有标记时一个字都不能改')
  assert(!stripMindMarks(`上半\n‹心|心里在偷乐|说|想听你再叫我一声`).includes('‹心'), '没闭合的末行也要吞掉')
  const stripper = new MindMarkStripper()
  const streamed = stripper.feed('好。') + stripper.feed('‹心|心里在偷乐|说|') + stripper.feed('想听你再叫我一声›还有后文')
  assert(streamed === '好。还有后文', `流式不应漏出标记,实际 ${JSON.stringify(streamed)}`)
  assert(stripper.take()?.whisper === '想听你再叫我一声', '流式收齐后能取出底字')
  const tail = new MindMarkStripper()
  assert(tail.feed('收尾‹') + tail.flush() === '收尾‹', '半个开括号不是标记,结束时放回')
  const felt = mindFromReasoning(
    '主人发了截图。按规则不艾特。回一句软的。心里确实有点别扭。可以。',
  )
  assert(felt?.whisper === '心里确实有点别扭', `思考里的感受应留下,实际 ${felt?.whisper}`)
  assert(felt?.kind === 'pure', '没写种类时按纯粹心里话')
  assert(mindFromReasoning('先调用 persona 工具写入人格卡。') === null, '操作句不能当底字')
  assert(depictTurn('嗯,晚上好。今天有点想你。', '') === null, '没有没说出口的话时,不截回复充数')
  const feltWins = depictTurn('嗯,晚上好。', '心里其实还在别扭')
  assert(feltWins?.whisper === '心里其实还在别扭', '思考里的感受优先于正文')
  const reply = '不用是正经话。随便说点今天的废话就行。'
  const inner = depictTurn(reply, '我倾向回那句废话。其实只是想听你多留一会儿。')
  assert(inner?.whisper === '其实只是想听你多留一会儿', `应留下没说出口的,实际 ${inner?.whisper}`)
  assert(depictTurn(reply, '短。随便说点今天的废话就行。不用是正经话。') === null, '复述回复不能当底字')
  assert(depictTurn('种类：纯', '种类：纯') === null, '协议标签不能印进输入框')
  const drafted = mindFromReasoning(
    '心迹行：说/望/纯。要4-16字，"再说一次我就信了"9字。ok。\n底字8-36字，不复述回复。"这句话像一只手按在肩上"大概12字。不要引号。',
  )
  assert(drafted?.whisper === '这句话像一只手按在肩上', `应取底字,实际 ${drafted?.whisper}`)
  assert(drafted?.island === '再说一次我就信了', `应取岛上一句,实际 ${drafted?.island}`)
  assert(!drafted?.whisper.includes('不要引号'), '格式说明不能当底字')
  const picked = mindFromReasoning('选纯。\n写：被这么一说，才觉得自己在绕。')
  assert(picked?.kind === 'pure' && picked.whisper === '被这么一说，才觉得自己在绕', `写：后面的句子,实际 ${picked?.whisper}`)
})

await test('心理刻画 2026-10-28:标签泄露兜底(空白开口/裸协议行/加心一行/›残尾)', () => {
  // ① 开口容空白/半角变体:「‹心 |」不再整行漏进正文
  const spaced = parseMindMark('‹心 | 嘴上没事 | 纯 | 其实一直在等你开口›')
  assert(spaced?.whisper === '其实一直在等你开口' && spaced?.kind === 'pure', `空白开口变体应解析,实际 ${JSON.stringify(spaced)}`)
  const half = parseMindMark('<心|心里在偷乐|说|想听你再叫我一声>')
  assert(half?.island === '心里在偷乐', `半角 < 开口应解析,实际 ${JSON.stringify(half)}`)
  const stripper = new MindMarkStripper()
  const streamed = stripper.feed('好。') + stripper.feed('‹心 | 嘴上没事 | 纯 |') + stripper.feed(' 其实一直在等你开口›')
  assert(streamed === '好。', `空白开口流式不应漏出,实际 ${JSON.stringify(streamed)}`)
  assert(stripper.take()?.whisper === '其实一直在等你开口', '空白开口流式能取到底字')
  // ② › 残尾:标记到同行最后一个收尾符为止,残尾不外漏
  const tailMark = parseMindMark('‹心|心里在偷乐|说|想›听你再叫我一声›')
  assert(tailMark?.whisper === '想听你再叫我一声', `底字里的 › 不截断,实际 ${JSON.stringify(tailMark)}`)
  assert(!stripMindMarks('好。\n‹心|心里在偷乐|说|想›听你再叫我一声›').includes('›'), '› 残尾不外漏')
  // ③ 裸协议行:整行剥并回收成心理(她自己的话);正文里的「种类:」不动
  const bare = '好,明天见。\n岛上一句：再说一次我就信了\n种类：纯\n底字：这句话像一只手按在肩上'
  const bareTaken = takeMindFromText(bare)
  assert(bareTaken.text === '好,明天见。', `裸协议行应整行剥,实际 ${JSON.stringify(bareTaken.text)}`)
  assert(bareTaken.mind?.island === '再说一次我就信了' && bareTaken.mind?.whisper === '这句话像一只手按在肩上', `裸协议行应回收成心理,实际 ${JSON.stringify(bareTaken.mind)}`)
  assert(bareTaken.mind?.kind === 'pure', '裸种类行解析为纯')
  assert(stripMindMarks('种类：红烧比较好吃') === '种类：红烧比较好吃', '正文里的「种类:」不动')
  // ④ 「加心一行」类格式旁白:整行/前缀/括号/跟在标记前都不外漏
  assert(stripMindMarks('好想咬你。\n加心一行') === '好想咬你。', '加心一行整行剥')
  assert(stripMindMarks('好想咬你。\n加心一行：心里在偷乐') === '好想咬你。', '加心一行:值也整行剥')
  assert(stripMindMarks('好想咬你（加心一行）') === '好想咬你', '括号旁白剥除')
  assert(!stripMindMarks('好想咬你。\n加心一行‹心|心里在偷乐|说|想听你再叫我一声›').includes('加心'), '跟在标记前的旁白不外漏')
  // ⑤ 岛面字段不能是旁白/占位符
  assert(parseMindMark('‹心|加心一行|纯|其实一直在等你开口›') === null, '岛面是旁白整段作废')
  assert(parseMindMark('‹心|一句心里话|纯|其实一直在等你开口›') === null, '占位符不采信')
  // ⑥ 流式:残渣行不闪进气泡,普通行直通
  const s2 = new MindMarkStripper()
  assert(s2.feed('好想你。') + s2.flush() === '好想你。', '普通行直通')
  const s3 = new MindMarkStripper()
  assert(s3.feed('种类：纯\n好想你。') + s3.flush() === '好想你。', '裸种类行流式吞掉')
  const s4 = new MindMarkStripper()
  assert(s4.feed('加心一行\n') + s4.flush() === '', '加心一行流式吞掉')
  const s5 = new MindMarkStripper()
  assert(s5.feed('加心一行‹心|心里在偷乐|说|想听你再叫我一声›') + s5.flush() === '', '旁白紧跟标记整行吞')
  const s6 = new MindMarkStripper()
  assert(s6.feed('种类：红烧比较好吃') + s6.flush() === '种类：红烧比较好吃', '正文里的「种类:」行流式放行')
})

await test('心理刻画 2026-10-28:删过头修复(无闭合标签/黑名单/复述/竖线)', () => {
  // ① 无闭合标签标注只摘括号与标签词,内容留下
  assert(sanitizeMind('[心情真复杂') === '心情真复杂', '无闭合标签只摘括号')
  assert(sanitizeMind('[揣测：真复杂') === '真复杂', '无闭合带冒号剥「[标签:」')
  assert(sanitizeMind('[OK]还不错') === '还不错', '字母标签残片③b仍兜底')
  assert(sanitizeMind('0.9]超赞') === '0.9]超赞', '数字开头的正常内容不动')
  // ② 黑名单是机制词子串匹配,带感受词的心事不判废
  assert(mindFromReasoning('想给好友发个消息。就这。')?.whisper === '想给好友发个消息', '「想给好友」是心事不是操作句')
  assert(mindFromReasoning('按规则不艾特就行。') === null, '纯机制句仍然判废')
  // ③ 心事只是"包含"短回复不算复述,不整句丢掉
  const inner = depictTurn('再说一次我就信了', '他要是再说一次我就信了啊,心里居然有点甜')
  assert(inner?.whisper === '他要是再说一次我就信了啊,心里居然有点甜', `包含短回复的心事不判废,实际 ${inner?.whisper}`)
  // ④ 底字混进竖线清洗后采信,不再整段作废
  const piped = parseMindMark('‹心|心里在偷乐|说|想听你|再叫我一声›')
  assert(piped?.whisper === '想听你再叫我一声', `竖线清洗后采信,实际 ${JSON.stringify(piped)}`)
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
  // 超上限截断(2026-09-22 从 10 收紧到 5,防自动记录泛滥)
  const many = parseMemoriesJson(`{"memories": ${JSON.stringify(Array.from({ length: 15 }, (_, i) => ({ content: `记忆${i}`, type: 'fact' })))}}`)
  assert(many.length === 5, `单次最多 5 条,实际 ${many.length}`)
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
  const proactiveAgent = createProactiveAgent({ getConfig: () => noKey })
  const history = [{ id: 'u1', role: 'user' as const, parts: [{ type: 'text' as const, text: '你好' }] }]
  assert((await summaryAgent.extractMemories(history)).length === 0, '无 Key 返回空数组')
  assert((await summaryAgent.extractMemories([])).length === 0, '空历史返回空数组')
  assert((await proactiveAgent.analyzeUserStyle(history)) === '', '无 Key 风格分析返回空串')
  assert((await proactiveAgent.analyzeUserStyle([])) === '', '空历史风格分析返回空串')
  const noKeyVerdict = await proactiveAgent.judgeProactive(history, 15)
  assert(noKeyVerdict.should === false, '无 Key 判断 should:false')
  assert(noKeyVerdict.reason === 'error', `无 Key 判断 reason 应为 error(不可当"判断说不"),实际 ${JSON.stringify(noKeyVerdict)}`)
  const emptyVerdict = await proactiveAgent.judgeProactive([], 15)
  assert(emptyVerdict.should === false && emptyVerdict.reason === 'error', '空历史判断 should:false + reason error')
  assert(!('judgeProactive' in summaryAgent), '总结 Agent 不再兼任主动陪伴判断')
})

await test('judgeProactive:三态可区分(decided 含否决 / error = 没跑成)', async () => {
  const cfg = { ...MOCK_PROVIDERS, apiKey: 'k', systemPrompt: '' }
  const history = [{ id: 'u1', role: 'user' as const, parts: [{ type: 'text' as const, text: '你好' }] }]
  const withStream = (text: string) =>
    createProactiveAgent({
      getConfig: () => cfg as never,
      stream: async () => ({ calls: [], text, usage: null, aborted: false }),
    })
  // 判断说不(真实结论)→ decided:调度器只进短冷却重试,不吃满间隔
  const no = await withStream('{"should":false}').judgeProactive(history, 15)
  assert(no.should === false && no.reason === 'decided', `判 no 应为 decided,实际 ${JSON.stringify(no)}`)
  // 判断开口 → decided + hint
  const yes = await withStream('{"should":true,"hint":"问候一下"}').judgeProactive(history, 15)
  assert(yes.should === true && yes.reason === 'decided' && yes.hint === '问候一下', `判 yes 应带 hint,实际 ${JSON.stringify(yes)}`)
  // 垃圾输出(调用失败/解析失败同款 fallback)→ error,不得混同"判断说不"
  const broken = await withStream('不是json').judgeProactive(history, 15)
  assert(broken.should === false && broken.reason === 'error', `垃圾输出应为 error,实际 ${JSON.stringify(broken)}`)
})

await test('runSubJson:解析成功采信,垃圾/失败回退 fallback', async () => {
  const cfg = { ...MOCK_PROVIDERS, apiKey: 'k', systemPrompt: '' }
  const ok = await runSubJson<{ should: boolean; hint?: string }>({
    config: cfg as never,
    stream: async () => ({ calls: [], text: '{"should":true,"hint":"问候"}', usage: null, aborted: false }),
    system: 'x',
    history: [{ id: '1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
    timeoutMs: 1000,
    parse: parseJudgeJson,
    fallback: { should: false },
  })
  assert(ok.should === true && ok.hint === '问候', `合法 JSON 应采信,实际 ${JSON.stringify(ok)}`)
  const bad = await runSubJson({
    config: cfg as never,
    stream: async () => ({ calls: [], text: '不是json', usage: null, aborted: false }),
    system: 'x',
    history: [{ id: '1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
    timeoutMs: 1000,
    parse: parseJudgeJson,
    fallback: { should: false },
  })
  assert(bad.should === false, '垃圾输出应回退 fallback')
})

await test('createSubAgentHost:一份宿主挂齐对话侧三类能力', () => {
  const host = createSubAgentHost({
    getConfig: () => ({ ...MOCK_PROVIDERS, apiKey: '', systemPrompt: '' }) as never,
  })
  assert(typeof host.summary.summarize === 'function' && typeof host.summary.extractMemories === 'function', 'summary 能力')
  assert(typeof host.proactive.judgeProactive === 'function' && typeof host.proactive.analyzeUserStyle === 'function', 'proactive 能力')
  assert(typeof host.classifier.classify === 'function' && typeof host.classifier.judgeMonologue === 'function', 'classifier 能力')
})

await test('createEvaluatorAgent:无 Key 上抛(进化不能空转)', async () => {
  const ev = createEvaluatorAgent({
    getConfig: () => ({ ...MOCK_PROVIDERS, apiKey: '', baseURL: '', model: '', systemPrompt: '' }) as never,
  })
  let threw = false
  try {
    await ev.evaluate('sys', 'input', '评审')
  } catch (err) {
    threw = String((err as Error).message).includes('API Key')
  }
  assert(threw, '无 Key 应上抛而非返回空评分')
})

// ---------------------------------------------------------------------------
// 7.5 归属指纹(2026-09-22 重设计,用户定案四规则)——消息归属由触发来源
// 在程序入口判定(窗口/主人QQ私聊/主人QQ群聊指向LLM = 主人信息;其余 =
// 别人的信息),回复默认落点随归属走,LLM 不写任何文本标记;跨归属外发
// 只走 send 工具,意图判定器降级为错配安全网(失败回退默认,不引入新
// 错误路径)。旧双指纹文本协议(【指纹:xxx】/【主人指纹:xxx】)退役
// ---------------------------------------------------------------------------

await test('classifyTurn:归属路由矩阵(2026-09-22 归属指纹,规则①②③)', () => {
  const MQ = MASTER_QQ
  // 规则① 对话窗口 = 主人信息 → 回复给主人(主对话留窗口/面板留窗口)
  const winMain = classifyTurn({ source: 'window', sessionKey: 'main', masterQQ: MQ })
  assert(winMain.kind === 'window' && winMain.replyOwner === 'master', '主对话窗口 = window/master')
  const winPanel = classifyTurn({ source: 'window', sessionKey: 'private:222', masterQQ: MQ })
  assert(winPanel.kind === 'panel' && winPanel.replyOwner === 'master', '外部面板 = panel/master(留窗口)')
  // 规则② 主人 QQ 私聊 = 主人信息 → 回主人 QQ
  const masterQq = classifyTurn({ source: 'qq', target: MQ, masterQQ: MQ })
  assert(masterQq.kind === 'master-qq' && masterQq.replyOwner === 'master', '主人 QQ 私聊 = master-qq/master')
  // 规则② 主人 QQ 群聊指向 LLM(owner 入口判定传入)= 主人信息 → 私发主人
  const masterGroup = classifyTurn({ source: 'group', target: '20001', owner: 'master', masterQQ: MQ })
  assert(masterGroup.kind === 'master-group' && masterGroup.replyOwner === 'master', '主人群聊指向 LLM = master-group/master')
  // 规则③ 其余 = 别人的信息 → 回对方/群
  const contact = classifyTurn({ source: 'qq', target: '222', masterQQ: MQ })
  assert(contact.kind === 'contact' && contact.replyOwner === 'peer', '扩展信任私聊 = contact/peer')
  const group = classifyTurn({ source: 'group', target: '20001', owner: 'peer', masterQQ: MQ })
  assert(group.kind === 'group' && group.replyOwner === 'peer', '群友发言 = group/peer')
  // 规则② 反面:主人群聊未指向 LLM(owner=peer)= 别人的信息(环境闲聊)
  const masterChatter = classifyTurn({ source: 'group', target: '20001', owner: 'peer', masterQQ: MQ })
  assert(masterChatter.kind === 'group' && masterChatter.replyOwner === 'peer', '主人群聊未指向 = group/peer')
  // 群聊缺省 owner(未传)= 安全侧按别人处理(主人点名必须入口显式传)
  const groupNoOwner = classifyTurn({ source: 'group', target: '20001', masterQQ: MQ })
  assert(groupNoOwner.replyOwner === 'peer', '群聊缺省 owner 按别人(安全侧)')
  // 陌生人询问轮:别人的信息但策略回复 = 询问主人
  const ask = classifyTurn({ source: 'ask', target: '333', owner: 'peer', masterQQ: MQ })
  assert(ask.kind === 'ask' && ask.replyOwner === 'master', '陌生人询问轮 = ask/master(询问主人)')
  // 系统/主动轮:永不路由
  const silent = classifyTurn({ source: 'system', masterQQ: MQ })
  assert(silent.kind === 'silent' && silent.replyOwner === null, 'system 轮 = silent 不路由')
  const empty = classifyTurn({ masterQQ: MQ })
  assert(empty.kind === 'silent', '无来源 = silent')
})

await test('isDirectedToBot:主人群聊消息意图识别(2026-09-22 规则②,群聊主人发言不一定指向 LLM)', () => {
  assert(isDirectedToBot('帮我查下天气', true) === true, '@机器人 显式指向')
  assert(isDirectedToBot('岛灵在吗') === true, '称呼岛灵 = 指向')
  assert(isDirectedToBot('鲸鱼娘看看这个') === true, '称呼鲸鱼娘 = 指向')
  assert(isDirectedToBot('你觉得呢?') === false, '第二人称疑问不足以确定在叫机器人')
  assert(isDirectedToBot('你说好不好') === false, '群聊第二人称不升级主人指令')
  assert(isDirectedToBot('帮我查一下B站排名') === false, '祈使句没有称呼时可能在叫群友')
  assert(isDirectedToBot('给我看看你的图') === false, '没有称呼的祈使句不升级权限')
  // 未指向(主人与群友闲聊 → 别人的信息)
  assert(isDirectedToBot('哈哈今天好累') === false, '日常感慨未指向')
  assert(isDirectedToBot('晚上开黑吗') === false, '问群友未指向(无疑问对象你)')
  assert(isDirectedToBot('老王你来不来') === false, '问「你」但句式不含疑问词——保守判未指向(主人可 @/叫名字确保唤起)')
  assert(isDirectedToBot('机器人真菜') === true, '提及名字 = 指向(宁宽:主人点名了)')
  assert(isDirectedToBot('') === false && isDirectedToBot('   ') === false, '空输入未指向')
})

await test('isReplyInstruction:触发侧执行指令识别(2026-09-22 归属指纹——主人轮默认回复给主人,指示轮才可能外发)', () => {
  // 转达/指示式(超集 looksLikeForwardInstruction)
  assert(isReplyInstruction('帮我把"周末见"发给张三') === true, '把…发给…')
  assert(isReplyInstruction('回他:没问题啊') === true, '回他:内容指示式')
  assert(isReplyInstruction('回复他:就这样定了') === true, '回复他:式')
  assert(isReplyInstruction('跟张三说我同意了') === true, '跟人名说')
  assert(isReplyInstruction('就这么回他') === true, '就这么回')
  assert(isReplyInstruction('按我说的回:好的') === true, '按我说的回')
  assert(isReplyInstruction('【主人窗口】回他:好的') === true, '窗口前缀不挡')
  // 日常对话(非指示 → 回复给主人)
  assert(isReplyInstruction('嗯') === false, '应答非指示')
  assert(isReplyInstruction('今天天气怎么样') === false, '日常提问非指示')
  assert(isReplyInstruction('帮我查一下B站排名') === false, '查询非指示(无回复对象)')
  assert(isReplyInstruction('') === false, '空输入')
})

// ---------------------------------------------------------------------------
// NapCat 扫码登录(2026-09-22,修复"QQ 一直显示过期/扫上了说没扫上"):
// 零依赖 QR 编码器(与 python qrcode 对拍过,见 tests/qr-crosscheck.mjs)+
// WebUI 登录流自动换码状态机(到期前换新,秒级轮询)
// ---------------------------------------------------------------------------

await test('encodeQr:零依赖 QR 编码器(byte/EC-M,版本 1-10)', () => {
  // 短文本 → 版本 1(21×21);登录链接(~68 字节)→ 版本 5(37×37)
  const small = encodeQr('a')
  assert(small.size === 21, `短文本应 21×21,实际 ${small.size}`)
  const url = encodeQr('https://txz.qq.com/p?k=UloZ2aoikyaK4Z7CMpsoIpc4SuOmIEq3&f=1600001604')
  assert(url.size === 37, `登录链接应 37×37(版本 5),实际 ${url.size}`)
  // 定位图形:三角落 7×7 回字(外环黑 + 5×5 白 + 3×3 黑心)
  const m = url.modules
  const finderOk = (r0: number, c0: number) => {
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 7; c++) {
        const ring = r === 0 || r === 6 || c === 0 || c === 6
        const core = r >= 2 && r <= 4 && c >= 2 && c <= 4
        if (m[r0 + r][c0 + c] !== (ring || core)) return false
      }
    }
    return true
  }
  assert(finderOk(0, 0) && finderOk(0, url.size - 7) && finderOk(url.size - 7, 0), '三角落定位图形应为回字')
  assert(m[url.size - 8][8] === true, '固定黑格 (size-8,8) 应恒黑')
  // 固定掩码下确定性 + 罚分自动选码下两枚不同文本应不同
  assert(JSON.stringify(encodeQr('abc', { mask: 3 }).modules) === JSON.stringify(encodeQr('abc', { mask: 3 }).modules), '固定掩码输出应确定')
  assert(JSON.stringify(url.modules) !== JSON.stringify(encodeQr('https://txz.qq.com/p?k=OTHERKEY&f=1600001604').modules), '不同内容矩阵应不同')
  // 米家 loginUrl 实测 136 字节 → 版本 8(49×49;2026-09-22 修「QR 数据过长」)
  const mi = encodeQr('x'.repeat(136))
  assert(mi.size === 49, `136 字节应 49×49(版本 8),实际 ${mi.size}`)
  // 版本信息块读回固定向量(右上副本 bit i @ (i/3, size-11+i%3),与 python qrcode 对拍值)
  const verBitsOf = (q: { size: number; modules: boolean[][] }) => {
    let bits = 0
    for (let i = 0; i < 18; i++) if (q.modules[Math.floor(i / 3)][q.size - 11 + (i % 3)]) bits |= 1 << i
    return bits
  }
  assert(verBitsOf(mi) === 0x085bc, `v8 版本信息应 0x085BC,实际 0x${verBitsOf(mi).toString(16)}`)
  const v10 = encodeQr('y'.repeat(200))
  assert(v10.size === 57 && verBitsOf(v10) === 0x0a4d3, `v10(200 字节)应 57×57 且版本信息 0x0A4D3,实际 ${v10.size}/0x${verBitsOf(v10).toString(16)}`)
  // 超容量报错(版本 10 上限 213 字节)
  let threw = false
  try {
    encodeQr('x'.repeat(214))
  } catch {
    threw = true
  }
  assert(threw, '214 字节应超出版本 10 容量并报错')
})

await test('napcat 扫码登录流:过期码不落屏 + 过期即换 + ttl 自动换码 + 成功收尾(2026-09-22)', async () => {
  const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms))
  // mock WebUI 按**实测真实语义**建模(2026-09-22 活体探测):
  //  - CheckLoginStatus.qrcodeurl = 登录任务跟踪码(唯一可扫的码);
  //  - RefreshQRcode 铸新码 QRT*(本 mock 同步落地;真实为 ~1-2s 异步,
  //    竞态窗口内状态接口回旧码 + loginError「已过期」);
  //  - GetQQLoginQrcode 返回当前跟踪码(首铸兜底);
  //  - 契约:**loginError 报过期的码绝不落屏**(初始即为过期死码 DEAD0,
  //    模拟用户实测"一直显示过期")。
  let mintSeq = 0
  let tracked = 'https://txz.qq.com/p?k=DEAD0'
  let trackedExpired = true
  let refreshed = 0
  let nowMs = 1_000_000
  let loggedIn = false
  const states: Array<{ phase: string; qrUrl: string; remainSec: number; message: string }> = []
  const sha = (t: string) => createHash('sha256').update(t).digest('hex')
  const fetchImpl = (async (url: string | URL | Request, opts?: RequestInit) => {
    const u = String(url)
    // 契约锁(2026-09-22):WebUI 前端 axios baseURL = '/api',漏前缀 /auth/login 404 = 小窗白板根因
    assert(u.includes('/api/'), `请求应带 /api 前缀,实际 ${u}`)
    const body = JSON.parse(String(opts?.body ?? '{}'))
    if (u.endsWith('/auth/login')) {
      assert(typeof body.hash === 'string' && body.hash.length === 64, '登录应带 sha256 hash')
      return new Response(JSON.stringify({ code: 0, data: { Credential: 'CRED' } }))
    }
    if (u.endsWith('/QQLogin/GetQQLoginQrcode')) {
      return new Response(JSON.stringify({ code: 0, data: { qrcode: tracked } }))
    }
    if (u.endsWith('/QQLogin/RefreshQRcode')) {
      refreshed++
      mintSeq++
      tracked = `https://txz.qq.com/p?k=QRT${mintSeq}`
      trackedExpired = false
      return new Response(JSON.stringify({ code: 0, data: null }))
    }
    if (u.endsWith('/QQLogin/CheckLoginStatus')) {
      return new Response(
        JSON.stringify({
          code: 0,
          data: { isLogin: loggedIn, isOffline: false, qrcodeurl: tracked, loginError: trackedExpired ? '二维码已过期，请刷新' : '' },
        }),
      )
    }
    return new Response(JSON.stringify({ code: -1, message: '未知路径 ' + u }))
  }) as typeof fetch
  const flow = createNapcatLoginFlow({
    token: 'tok',
    fetchImpl,
    sha256Hex: sha,
    now: () => nowMs,
    ttlSec: 60,
    pollMs: 8,
    onUpdate: (s) => states.push({ phase: s.phase, qrUrl: s.qrUrl, remainSec: s.remainSec, message: s.message }),
  })
  const refreshCount = () => refreshed // 经函数间接读,防 assert 断言窄化字面量类型
  await flow.start()
  assert(refreshCount() === 1, `启动遇过期死码应立即 RefreshQRcode 换码,实际 ${refreshed}`)
  assert(states[0]?.phase === 'waiting', '取到码应进入 waiting')
  assert((states[0]?.qrUrl ?? '').includes('QRT'), `应展示换新后的活码 QRT*,实际 ${states[0]?.qrUrl}`)
  assert(states.every((s) => !s.qrUrl.includes('DEAD')), '过期死码绝不落屏')
  // 运行中服务端报过期 → 立即换码(不等 ttl),过期码不再出现在后续状态里
  const expiredUrl = tracked
  const lenBefore = states.length
  nowMs += 6000 // 越过 5s 换码冷却
  trackedExpired = true
  await sleep(60)
  assert(refreshCount() === 2, `过期提示应立即触发换码,实际 refresh=${refreshed}`)
  assert(states.slice(lenBefore).every((s) => s.qrUrl !== expiredUrl), '过期码不应再展示')
  assert(states.slice(lenBefore).some((s) => s.qrUrl === `https://txz.qq.com/p?k=QRT2`), '应展示换新码 QRT2')
  // ttl(60s)到点 → 自动换码(时钟从最后采用码起推进)
  nowMs += 61_000
  await sleep(60)
  assert(refreshCount() === 3, `ttl 到期应自动换码,实际 refresh=${refreshed}`)
  assert(states.some((s) => s.message.includes('已自动换新')), '换码后应有换新提示')
  // remainSec 应随新码回满
  assert([...states].reverse().some((s) => s.remainSec > 0), '新码倒计时应回满')
  // 扫码成功 → done 且停止轮询
  loggedIn = true
  await sleep(60)
  assert(states.some((s) => s.phase === 'done'), 'isLogin=true 应报 done')
  const countBefore = states.length
  await sleep(50)
  assert(states.length === countBefore, 'done 后应停止轮询')
  flow.stop()
})

await test('napcat 扫码登录流:错误态「换一张」应整体重试(2026-09-22)', async () => {
  // start 认证失败 → stopped;此时 refresh(「换一张」)必须重启动,
  // 原实现 if (stopped) return = 按钮点了没反应(用户实测)
  let authCalls = 0
  let failAuth = true
  const phases: string[] = []
  const fetchImpl = (async (url: string | URL | Request) => {
    const u = String(url)
    assert(u.includes('/api/'), `请求应带 /api 前缀,实际 ${u}`)
    if (u.endsWith('/auth/login')) {
      authCalls++
      if (failAuth) return new Response(JSON.stringify({ code: -1, message: 'Unauthorized' }))
      return new Response(JSON.stringify({ code: 0, data: { Credential: 'CRED' } }))
    }
    if (u.endsWith('/QQLogin/GetQQLoginQrcode')) {
      return new Response(JSON.stringify({ code: 0, data: { qrcode: 'https://txz.qq.com/p?k=QRX' } }))
    }
    return new Response(
      JSON.stringify({ code: 0, data: { isLogin: false, isOffline: false, qrcodeurl: 'https://txz.qq.com/p?k=QRX', loginError: '' } }),
    )
  }) as typeof fetch
  const flow = createNapcatLoginFlow({
    token: 'tok',
    fetchImpl,
    sha256Hex: (t) => createHash('sha256').update(t).digest('hex'),
    pollMs: 50,
    onUpdate: (s) => phases.push(s.phase),
  })
  const authCount = () => authCalls // 经函数间接读,防 assert 断言窄化字面量类型
  await flow.start()
  assert(phases.includes('error'), '认证失败应进 error 态')
  assert(authCount() === 1, '失败一次应只调一次认证')
  failAuth = false
  await flow.refresh() // stopped → 应整体重试
  assert(authCount() === 2, `refresh 应重试认证,实际 ${authCalls}`)
  assert(phases.includes('waiting'), '重试成功应进入 waiting 并展示新码')
  flow.stop()
})

await test('describeLoginError:把 fetch failed 展开成可读连接诊断(2026-10-22)', () => {
  const refused: any = new TypeError('fetch failed')
  refused.cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:6099'), {
    code: 'ECONNREFUSED',
    address: '127.0.0.1',
    port: 6099,
  })
  const text = describeLoginError(refused)
  assert(text.includes('连接被拒绝'), `应识别 ECONNREFUSED,实际 ${text}`)
  assert(!text.includes('fetch failed'), `不应只回 "fetch failed",实际 ${text}`)

  const timeout: any = new TypeError('fetch failed')
  timeout.cause = Object.assign(new Error('connect ETIMEDOUT 10.0.0.2:6099'), {
    code: 'ETIMEDOUT',
    address: '10.0.0.2',
    port: 6099,
  })
  assert(describeLoginError(timeout).includes('连接超时'), '应识别超时')

  const dns: any = new TypeError('fetch failed')
  dns.cause = Object.assign(new Error('getaddrinfo ENOTFOUND napcat.local'), { code: 'ENOTFOUND' })
  assert(describeLoginError(dns).includes('无法解析主机名'), '应识别 DNS 失败')

  const plain = new TypeError('fetch failed')
  assert(describeLoginError(plain) === '网络请求失败', '无 cause 时退回通用文案')
})

await test('napcat 扫码登录流:WebUI 连不上自动重连,启动后自动出码(2026-10-22)', async () => {
  // 用户截图病灶:NapCat 未启动 → fetch failed → 旧实现进死错误态,
  // 之后 NapCat 起来也不会出码。现在应保持 waiting 并自动重试。
  let online = false
  let calls = 0
  const states: Array<{ phase: string; qrUrl: string; remainSec: number; message: string }> = []
  const connErr = () => {
    const err: any = new TypeError('fetch failed')
    err.cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:6099'), {
      code: 'ECONNREFUSED',
      address: '127.0.0.1',
      port: 6099,
    })
    return err
  }
  const fetchImpl = (async (url: string | URL | Request) => {
    calls++
    if (!online) throw connErr()
    const u = String(url)
    if (u.endsWith('/auth/login')) {
      return new Response(JSON.stringify({ code: 0, data: { Credential: 'CRED' } }))
    }
    return new Response(
      JSON.stringify({
        code: 0,
        data: { isLogin: false, isOffline: false, qrcodeurl: 'https://txz.qq.com/p?k=RECONNECT', loginError: '' },
      }),
    )
  }) as typeof fetch
  const flow = createNapcatLoginFlow({
    token: 'tok',
    fetchImpl,
    sha256Hex: (t) => createHash('sha256').update(t).digest('hex'),
    pollMs: 10,
    retryMs: 20,
    onUpdate: (s) => states.push({ phase: s.phase, qrUrl: s.qrUrl, remainSec: s.remainSec, message: s.message }),
  })
  await flow.start()
  assert(states[0]?.phase === 'waiting', '连接失败应停在 waiting(自动重连),不是死错误态')
  assert(!states.some((s) => s.phase === 'error'), '连接失败不应进 error 态')
  assert(states[0]?.remainSec === 0, '无码时不应显示倒计时')
  assert(states[0]?.message.includes('连接被拒绝'), `错误文案应带底层原因,实际 ${states[0]?.message}`)
  assert(states[0]?.message.includes('6099'), `错误文案应带端口,实际 ${states[0]?.message}`)

  await sleepMs(45)
  const callsBefore = calls
  online = true // NapCat 起来了
  const deadline = Date.now() + 1500
  while (!states.some((s) => s.qrUrl.includes('RECONNECT')) && Date.now() < deadline) await sleepMs(10)
  assert(calls > callsBefore, '应持续自动重试请求')
  assert(states.some((s) => s.qrUrl.includes('RECONNECT')), 'NapCat 启动后应自动出码(无需点「换一张」)')
  flow.stop()
})

await test('napcat 扫码登录流:轮询中 WebUI 掉线应丢码并自动重连(2026-10-22)', async () => {
  let online = true
  const states: Array<{ phase: string; qrUrl: string; message: string }> = []
  const connErr = () => {
    const err: any = new TypeError('fetch failed')
    err.cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
    return err
  }
  const fetchImpl = (async (url: string | URL | Request) => {
    if (!online) throw connErr()
    const u = String(url)
    if (u.endsWith('/auth/login')) {
      return new Response(JSON.stringify({ code: 0, data: { Credential: 'CRED' } }))
    }
    return new Response(
      JSON.stringify({
        code: 0,
        data: { isLogin: false, isOffline: false, qrcodeurl: 'https://txz.qq.com/p?k=DROP', loginError: '' },
      }),
    )
  }) as typeof fetch
  const flow = createNapcatLoginFlow({
    token: 'tok',
    fetchImpl,
    sha256Hex: (t) => createHash('sha256').update(t).digest('hex'),
    pollMs: 10,
    retryMs: 20,
    onUpdate: (s) => states.push({ phase: s.phase, qrUrl: s.qrUrl, message: s.message }),
  })
  await flow.start()
  assert(states.some((s) => s.qrUrl.includes('DROP')), '先正常出码')

  online = false // WebUI 挂了
  const deadline = Date.now() + 1000
  while (!states.some((s) => s.message.includes('连接中断')) && Date.now() < deadline) await sleepMs(10)
  assert(states.some((s) => s.message.includes('连接中断')), '掉线应提示连接中断')
  const dropAt = states.findIndex((s) => s.message.includes('连接中断'))
  assert(states.slice(dropAt).every((s) => !s.qrUrl), '掉线后旧码应清空(不展示无法刷新的码)')

  online = true
  const deadline2 = Date.now() + 1500
  while (!states.slice(dropAt).some((s) => s.qrUrl) && Date.now() < deadline2) await sleepMs(10)
  assert(states.slice(dropAt).some((s) => s.qrUrl), 'WebUI 恢复后应自动重连并重新出码')
  flow.stop()
})

await test('napcat 扫码登录流:首个地址连不上应尝试候选地址(IPv6 兜底,2026-10-22)', async () => {
  const tried: string[] = []
  const states: Array<{ qrUrl: string }> = []
  const connErr = () => {
    const err: any = new TypeError('fetch failed')
    err.cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:6099'), {
      code: 'ECONNREFUSED',
      address: '127.0.0.1',
      port: 6099,
    })
    return err
  }
  const fetchImpl = (async (url: string | URL | Request) => {
    const u = String(url)
    tried.push(u)
    if (u.startsWith('http://127.0.0.1:6099')) throw connErr()
    if (u.endsWith('/auth/login')) {
      return new Response(JSON.stringify({ code: 0, data: { Credential: 'CRED' } }))
    }
    return new Response(
      JSON.stringify({
        code: 0,
        data: { isLogin: false, isOffline: false, qrcodeurl: 'https://txz.qq.com/p?k=IPV6', loginError: '' },
      }),
    )
  }) as typeof fetch
  const flow = createNapcatLoginFlow({
    token: 'tok',
    fetchImpl,
    sha256Hex: (t) => createHash('sha256').update(t).digest('hex'),
    pollMs: 200,
    baseUrls: ['http://127.0.0.1:6099', 'http://[::1]:6099'],
    onUpdate: (s) => states.push({ qrUrl: s.qrUrl }),
  })
  await flow.start()
  assert(tried.some((u) => u.startsWith('http://[::1]:6099')), 'IPv4 连不上应尝试 [::1]')
  assert(states.some((s) => s.qrUrl.includes('IPV6')), '候选地址可用时应正常出码')
  flow.stop()
})

await test('webuiTokenHash:WebUI 口令散列约定(token + ".napcat")', () => {
  const sha2 = (t: string) => createHash('sha256').update(t).digest('hex')
  assert(webuiTokenHash('2f901af2e1e0', sha2) === sha2('2f901af2e1e0.napcat'), '散列应与前端约定一致')
})

await test('napcat login 动作:打开扫码登录窗(2026-09-22)且未注入时不炸', async () => {
  let opened = 0
  const tool = napcatTools({}, { openLogin: () => { opened++ } }).find((t) => t.name === 'napcat')!
  const out = String(await tool.execute({ action: 'login' }))
  assert(opened === 1, 'login 应调 openLogin 打开登录窗')
  assert(out.includes('扫码') && out.includes('自动换新'), '返回文本应引导扫码并说明自动换码')
  const bare = napcatTools({}).find((t) => t.name === 'napcat')!
  const bareOut = String(await bare.execute({ action: 'login' }))
  assert(bareOut.includes('不支持'), '未注入 openLogin 应提示不可用')
})

await test('looksLikeMasterAddressed:别人轮对主人说话安全网(2026-09-22 归属指纹——防汇报泄露给对方)', () => {
  assert(looksLikeMasterAddressed('主人,魔精问你明天有没有空~') === true, '开头称呼主人 = 对主人说')
  assert(looksLikeMasterAddressed('主人:他想约你吃饭') === true, '主人:式')
  assert(looksLikeMasterAddressed('给主人汇报一下,图已经发他了') === true, '汇报动词点名主人')
  assert(looksLikeMasterAddressed('向主人请示要不要答应') === true, '请示动词点名主人')
  // 普通回复不误伤
  assert(looksLikeMasterAddressed('哈哈确实拉胯,心疼你一秒') === false, '对对方的回复不命中')
  assert(looksLikeMasterAddressed('主人是谁啊') === false, '第三人称提及主人不命中(后跟非标点)')
  assert(looksLikeMasterAddressed('我问主人一下') === false, '「我问主人」非开头称呼')
  assert(looksLikeMasterAddressed('我跟主人说了你明天有空,你再跟他确认') === false, '句中跟主人说是讲给对方听的,不整段改投主人')
  assert(looksLikeMasterAddressed('好的主人') === false, '非开头称呼(保守,宁漏)')
  assert(looksLikeMasterAddressed('') === false, '空输入')
})

await test('shouldHandGroupReplyToMaster:群聊轮转交主人判定(2026-10-28 群路由优化——修「回复群友的发给主人 QQ」)', () => {
  // 明确私下对主人请示/汇报 → 主人
  assert(shouldHandGroupReplyToMaster('主人,魔精问你明天有没有空?') === true, '「主人,」私下问主人 = 转主人')
  assert(shouldHandGroupReplyToMaster('向主人汇报一下,图已经发群里了') === true, '向主人汇报 = 转主人')
  assert(shouldHandGroupReplyToMaster('给主人请示要不要答应他') === true, '给主人请示 = 转主人')
  // 含「主人，」的混合措辞保守扣留，不能凭群称呼放行私下内容。
  assert(shouldHandGroupReplyToMaster('主人,你们别乱说!') === true, '「主人,你们别乱说」含主人称呼时保守扣留，不按正文改收件人')
  assert(shouldHandGroupReplyToMaster('主人,大家别误会呀') === true, '「主人,大家…」群称呼不能使私下内容放行')
  assert(shouldHandGroupReplyToMaster('主人,各位评评理~') === true, '「主人,各位…」群称呼不能使私下内容放行')
  // 对群转达/公开回应(非主人前缀)→ 发群(旧 isAsk 会误转主人)
  assert(shouldHandGroupReplyToMaster('我去问主人哈~') === false, '「我去问主人哈」对群转达 = 发群,不转主人')
  assert(shouldHandGroupReplyToMaster('你们别乱说,主人不是那样的人!') === false, '公开维护(非主人前缀)= 发群')
  assert(shouldHandGroupReplyToMaster('哈哈确实拉胯,心疼你一秒') === false, '普通群回复 = 发群')
  assert(shouldHandGroupReplyToMaster('主人最好了!') === false, '「主人最」后跟非标点 = 公开夸主人,发群')
  // 空输入
  assert(shouldHandGroupReplyToMaster('') === false && shouldHandGroupReplyToMaster('   ') === false, '空输入')
})

await test('turnAlreadySentGroupText/sentMessageIsText:媒体发送不算「已文字回复」(2026-10-28 修发图+文字回复误转主人)', () => {
  const mediaOnly = { type: 'group', target: '111', text: '(图片/文件/语音)' }
  const textSend = { type: 'group', target: '111', text: '你好呀' }
  assert(sentMessageIsText(textSend) === true, '文字发送算文字回复')
  assert(sentMessageIsText(mediaOnly) === false, '纯媒体占位不算文字回复')
  assert(sentMessageIsText({ type: 'group', target: '111', text: '' }) === false, '空正文不算文字回复')
  // 本轮发过图(mediaOnly),轮前文字基线 0:turnAlreadySentGroupText 应为 false(不误转主人)
  assert(turnAlreadySentGroupText([mediaOnly], 0, '111') === false, '只发过媒体 → 不算已文字回复,对话文本发群')
  // 本轮发过文字(textSend),轮前文字基线 0:应为 true(对话文本=给主人的汇报)
  assert(turnAlreadySentGroupText([textSend], 0, '111') === true, '发过文字 → 已文字回复,对话文本转主人')
  // 媒体 + 文字:有文字即算
  assert(turnAlreadySentGroupText([mediaOnly, textSend], 0, '111') === true, '媒体+文字有文字即算')
  // 轮前已有 1 条文字(基线 1),本轮未新增文字:不应误判
  assert(turnAlreadySentGroupText([textSend], 1, '111') === false, '未超基线不算本轮已发')
  // 别的群不串
  assert(turnAlreadySentGroupText([textSend], 0, '222') === false, '别的群不算')
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
  assert(sys.includes('面板轮') && sys.includes('【主人窗口】'), '面板轮应倾向 master(窗口输入不是群友话)')
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
  assert(looksLikeForwardInstruction('【主人窗口】帮我把"周末见"发给张三') === true, '窗口前缀不挡转达指令')
})

await test('looksLikeGroupSendInstruction:群窗口发群指令识别(2026-09-03)', () => {
  assert(looksLikeGroupSendInstruction('发到群里') === true, '发到群里应命中')
  assert(looksLikeGroupSendInstruction('【主人窗口】发到这个群') === true, '窗口前缀+发到这个群应命中')
  assert(looksLikeGroupSendInstruction('在群里说一声我晚点') === true, '在群里说应命中')
  assert(looksLikeGroupSendInstruction('帮我回群友一声') === true, '回群友应命中')
  assert(looksLikeGroupSendInstruction('发消息到群里') === true, '发消息到群里应命中')
  assert(looksLikeGroupSendInstruction('帮我回他们一声') === true, '转达指令应命中')
  assert(looksLikeGroupSendInstruction('帮我回他一声') === true, '回他=回群里的人')
  assert(looksLikeGroupSendInstruction('帮我回一下刚才那个问题') === false, '向岛灵提问不命中')
  assert(looksLikeGroupSendInstruction('你好') === false, '日常招呼不命中')
  assert(looksLikeGroupSendInstruction('这个群最近在聊什么') === false, '问群况不命中')
  assert(looksLikeGroupSendInstruction('发现这个群很有趣') === false, '发现…群不误伤')
  assert(looksLikeGroupSendInstruction('【主人窗口】帮我看看这个群') === false, '查询群不命中')
  assert(looksLikeGroupSendInstruction('') === false, '空串不命中')
})

await test('shouldSendGroupPanelReply:群窗口默认不发群(2026-09-03;2026-09-22 归属指纹去指纹门——明确指示+判定确认才发)', () => {
  const stay = { alreadySent: false, isAsk: false }
  // 根因(2026-09-03):主人在群会话窗口说「你好」被发到群——窗口 = 主人
  // 信息(规则①),默认留窗口;只有明确指示 + 判定器确认 other 才发
  assert(shouldSendGroupPanelReply({ ...stay, triggerText: '【主人窗口】你好' }) === false, '未要求发群不发')
  assert(shouldSendGroupPanelReply({ ...stay, triggerText: '这个群怎么样' }) === false, '问群况不发')
  assert(shouldSendGroupPanelReply({ ...stay, triggerText: '你好', classifierIntent: 'other' }) === false, '判定器 other 但未要求发群不发')
  // 主人明确要求发群
  assert(shouldSendGroupPanelReply({ ...stay, triggerText: '【主人窗口】发到群里:我晚点到', classifierIntent: 'other' }) === true, '要求发群+判定 other 应发')
  assert(shouldSendGroupPanelReply({ ...stay, triggerText: '发到群里', classifierIntent: 'other' }) === true, '要求发群+判定 other 应发')
  assert(shouldSendGroupPanelReply({ ...stay, triggerText: '发到群里', classifierIntent: 'master' }) === false, '要求发群但判定 master 不发')
  assert(shouldSendGroupPanelReply({ ...stay, triggerText: '发到群里' }) === false, '要求发群无判定不发(判定失败/缺失回默认留窗口)')
  assert(shouldSendGroupPanelReply({ ...stay, triggerText: '发到群里', classifierIntent: 'other', alreadySent: true }) === false, '本轮已用工具发过不重发')
  assert(shouldSendGroupPanelReply({ ...stay, triggerText: '发到群里', classifierIntent: 'other', isAsk: true }) === false, '询问轮不发群')
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

await test('bili 登录态整合:凭据解析/键名规范化/遗留收编/nav 探针/未登录识别', async () => {
  // cookie 解析:bili-tool 格式 + qr-helper 旧格式(无 _saved_at)+ 非法
  const full = parseBiliCookies(JSON.stringify({ SESSDATA: 's', bili_jct: 'j', DedeUserID: '123', _saved_at: 100 }))
  assert(full?.hasSessdata === true && full.uid === '123' && full.savedAt === 100, `完整凭据:${JSON.stringify(full)}`)
  const legacy = parseBiliCookies(JSON.stringify({ SESSDATA: 's2', DedeUserID: '' }))
  assert(legacy?.hasSessdata === true && legacy.uid === '' && legacy.savedAt === 0, `qr-helper 旧格式:${JSON.stringify(legacy)}`)
  assert(parseBiliCookies('not json') === null && parseBiliCookies('[1,2]') === null, '非法 JSON → null')
  assert(parseBiliCookies(JSON.stringify({ bili_jct: 'j' }))?.hasSessdata === false, '无 SESSDATA → hasSessdata false')
  // 键名大小写(2026-09-22 实测真根因:登录链路 to_uppercase 落盘
  // DEDEUSERID/BILI_JCT,Rust 读 DedeUserID/bili_jct 全 miss → "已登录 (UID )")
  const caps = parseBiliCookies(JSON.stringify({ SESSDATA: 's', BILI_JCT: 'j', DEDEUSERID: '859' }))
  assert(caps?.uid === '859', `全大写键也应解析出 UID:${JSON.stringify(caps)}`)
  const norm = normalizeBiliCookieKeys({ SESSDATA: 's', BILI_JCT: 'j', DEDEUSERID: '859', first_domain: '.bilibili.com' })
  assert(norm.changed && norm.obj.DedeUserID === '859' && norm.obj.bili_jct === 'j' && norm.obj.SESSDATA === 's', `规范化:${JSON.stringify(norm.obj)}`)
  assert(norm.obj.first_domain === '.bilibili.com', '无关键原样保留')
  assert(normalizeBiliCookieKeys({ SESSDATA: 's', bili_jct: 'j', DedeUserID: '1' }).changed === false, '已是规范键名 → 无变化')
  // 遗留收编:规范位空 → 挑"有 SESSDATA 且 _saved_at 最新"的一份;幂等
  const dir = path.join(tmp, 'bili-login-test')
  const canonical = path.join(dir, 'config', 'cookies.json')
  const legacyOld = path.join(dir, 'old', 'cookies.json')
  const legacyNew = path.join(dir, 'webui', 'cookies.json')
  const legacyEmpty = path.join(dir, 'empty', 'cookies.json')
  await fs.mkdir(path.join(dir, 'old'), { recursive: true })
  await fs.mkdir(path.join(dir, 'webui'), { recursive: true })
  await fs.mkdir(path.join(dir, 'empty'), { recursive: true })
  await fs.writeFile(legacyOld, JSON.stringify({ SESSDATA: 'old', _saved_at: 100 }))
  await fs.writeFile(legacyNew, JSON.stringify({ SESSDATA: 'new', DEDEUSERID: '42', _saved_at: 200 }))
  await fs.writeFile(legacyEmpty, JSON.stringify({ bili_jct: 'x' }))
  const from = consolidateBiliCookies(canonical, [legacyOld, legacyEmpty, legacyNew])
  assert(from === legacyNew, `应收编最新一份,实际:${from}`)
  const imported = parseBiliCookies(await fs.readFile(canonical, 'utf8'))
  assert(imported?.hasSessdata === true && imported.uid === '42' && imported.savedAt === 200, `收编结果:${JSON.stringify(imported)}`)
  assert((await fs.readFile(canonical, 'utf8')).includes('"DedeUserID"'), '收编时键名应规范化(Rust 读取端认的大小写)')
  assert(consolidateBiliCookies(canonical, [legacyOld, legacyNew]) === null, '幂等:规范位已有凭据不再收编')
  // 规范位已有但键名全大写 → 就地规范化(用户实机场景)
  const capsCanonical = path.join(dir, 'config2', 'cookies.json')
  await fs.mkdir(path.join(dir, 'config2'), { recursive: true })
  await fs.writeFile(capsCanonical, JSON.stringify({ SESSDATA: 's', DEDEUSERID: '859', BILI_JCT: 'j' }))
  assert(consolidateBiliCookies(capsCanonical, []) === null, '已有凭据不触发收编')
  assert((await fs.readFile(capsCanonical, 'utf8')).includes('"DedeUserID"'), '已有凭据就地规范化键名')
  // nav 探针:-101 未登录 / 正常登录 / 结构异常
  assert(parseNavProbe({ code: -101, data: {} })?.isLogin === false, '-101 → 未登录')
  const probe = parseNavProbe({ code: 0, data: { isLogin: true, mid: 987, uname: '岛民' } })
  assert(probe?.isLogin === true && probe.mid === '987' && probe.uname === '岛民', `nav 解析:${JSON.stringify(probe)}`)
  assert(parseNavProbe({ code: 0 }) === null && parseNavProbe('x') === null, '结构异常 → null(未验证)')
  // 未登录输出识别(含全角标点变体)
  assert(biliOutputLooksLoggedOut('列出收藏夹需要登录，请先运行 login'), 'Rust 话术(全角逗号)')
  assert(biliOutputLooksLoggedOut('获取收藏夹失败（可能需要登录）: -101 账号未登录'), 'API 错误话术')
  assert(!biliOutputLooksLoggedOut('收藏夹:\n  ID 1 | 默认 | 3 个'), '正常输出不误判')
})

// ---------------------------------------------------------------------------
// 记忆近重复合并 + 提取收紧 + 快捷记忆进化(2026-09-22)
// ---------------------------------------------------------------------------

await test('memory 近重复:归一化等价/信息超集合并/protected 不改写只补锁', async () => {
  assert(normalizeMemoryText(' 喜欢 简洁·回答! ') === '喜欢简洁回答', `归一化:${normalizeMemoryText(' 喜欢 简洁·回答! ')}`)
  assert(memorySimilarity('喜欢简洁回答', '用户喜欢简洁的回答') >= 0.85, '同义微调应达合并阈值')
  assert(memorySimilarity('岛灵的名字叫鲸鱼', '岛灵名字叫鲸鱼') >= 0.85, '一字插删应达合并阈值(LCS-Dice)')
  assert(memorySimilarity('岛灵的名字叫鲸鱼', '岛灵的名字叫海豚') < 0.85, '语义翻转(鲸鱼→海豚)不合并')
  assert(memorySimilarity('用户喜欢猫', '用户喜欢狗') < 0.85, '语义翻转(猫→狗)不合并')
  assert(memorySimilarity('喜欢猫', '下载视频') < 0.2, '无关主题相似度应极低')
  const store = createMemoryStore(() => path.join(tmp, 'near-dup-memory.json'))
  const a = await store.add({ content: '喜欢简洁的回答', type: 'preference' })
  assert(a.created === true, '首条创建')
  // ① 归一化等价(标点差)→ 不新增
  const b = await store.add({ content: '喜欢简洁的回答。', type: 'preference' })
  assert(b.created === false && b.entry.id === a.entry.id, `归一化等价合并:${JSON.stringify(b)}`)
  // ② 信息超集(包含旧内容且更长)→ 升级现有条目措辞,不新增
  const c = await store.add({ content: '喜欢简洁的回答,讨厌啰嗦和重复', type: 'preference' })
  assert(c.created === false && c.entry.id === a.entry.id && c.entry.content.includes('讨厌啰嗦'), `超集升级:${c.entry.content}`)
  assert((await store.list()).length === 1, '同主题不堆积')
  // ③ 全新主题 → 新条目
  const d = await store.add({ content: '项目在 D:/code/island 开发', type: 'fact' })
  assert(d.created === true && (await store.list()).length === 2, '不同主题不合并')
  // ④ 人设重申命中旧条目 → 补锁定;protected 条目内容永不改写
  const e = await store.add({ content: '岛灵的名字叫鲸鱼', type: 'fact' })
  const f = await store.add({ content: '岛灵名字叫鲸鱼', type: 'fact', protected: true })
  assert(f.created === false && f.entry.id === e.entry.id && f.entry.protected === true, `人设重申补锁定:${JSON.stringify(f.entry)}`)
  const g = await store.add({ content: '岛灵的名字叫鲸鱼,说话要俏皮', type: 'fact' })
  assert(g.created === false && g.entry.content === '岛灵的名字叫鲸鱼', 'protected 超集也不改写')
  // ⑤ 导入同样走近重复判定
  const r = await store.importEntries([
    { id: 'x1', type: 'fact', content: '喜欢简洁的回答!', createdAt: 1, updatedAt: 1 },
    { id: 'x2', type: 'fact', content: '全新的主题内容', createdAt: 1, updatedAt: 1 },
  ])
  assert(r.imported === 1 && r.skipped === 1, `导入近重复跳过:${JSON.stringify(r)}`)
  // findNearDuplicate 直测:包含关系(短串 ≥4)
  assert(findNearDuplicate(await store.list(), '开发') === null, '过短片段不误判')
  assert(findNearDuplicate(await store.list(), '项目在 D:/code/island 开发中')?.id === d.entry.id, '包含关系命中')
})

await test('记忆提取收紧:单次 ≤5 条 + 提示词"同义改写也算重复"', () => {
  const many = JSON.stringify({
    memories: Array.from({ length: 8 }, (_, i) => ({ content: `事实${i}`, type: 'fact' })),
  })
  assert(parseMemoriesJson(many).length === 5, '单次上限 5 条(原 10 收紧)')
  const sys = buildMemoryExtractSystem(['系统提示词', '现有记忆块'])
  assert(sys.includes('同义改写') && sys.includes('最多输出 5 条') && sys.includes('宁缺勿滥'), `提示词强化:${sys.slice(-200)}`)
})

await test('evolve_memory:quick/run/status(LLM 直接驱动快捷自我进化)', async () => {
  const calls: string[] = []
  const evo = {
    requestEvolve: async (focus?: string, rounds?: number) => {
      calls.push(`run:${focus ?? ''}:${rounds ?? ''}`)
      return { started: true, message: '记忆进化已开始(后台)' }
    },
    getStatus: async () => {
      calls.push('status')
      return '【记忆进化】最近一轮:v1→v2'
    },
    runQuick: async (focus?: string) => {
      calls.push(`quick:${focus ?? ''}`)
      return { ok: true, message: '快捷记忆进化完成:v1→v2 评分 60 → 72' }
    },
  }
  const cfg = { ...MOCK_PROVIDERS, apiKey: '', baseURL: '', model: '', systemPrompt: '', reasoningEffort: 'high', mcpServers: [], skillsDirs: [] }
  const tools = createBuiltinTools({ get value() { return 8192 }, set value(_n: number) {} }, { getConfig: () => cfg, getEvolution: () => evo })
  const t = tools.find((x) => x.name === 'evolve_memory')!
  assert(!!t, 'evolve_memory 应注册')
  const quick = String(await t.execute({}))
  assert(quick.includes('快捷记忆进化完成') && calls[0] === 'quick:', `缺省走 quick:${quick}`)
  const run = String(await t.execute({ action: 'run', rounds: 3 }))
  assert(run.includes('后台') && calls.includes('run::3'), `run 动作:${run}`)
  const st = String(await t.execute({ action: 'status' }))
  assert(st.includes('最近一轮'), `status 动作:${st}`)
  await assertRejects(() => t.execute({ action: 'nope' }), 'quick/run/status/log/rollback/reset')
  // 旧宿主 stub 无 runQuick → 回退 requestEvolve(focus, 1)
  const evoOld = { requestEvolve: evo.requestEvolve, getStatus: evo.getStatus }
  const toolsOld = createBuiltinTools({ get value() { return 8192 }, set value(_n: number) {} }, { getConfig: () => cfg, getEvolution: () => evoOld })
  await toolsOld.find((x) => x.name === 'evolve_memory')!.execute({ focus: '去重' })
  assert(calls.includes('run:去重:1'), `旧宿主回退:${calls.join()}`)
})

await test('evolution runQuick:同步单轮 评审→应用→复评→接受,当轮回填摘要', async () => {
  const evoDir = path.join(tmp, 'evo-quick')
  await fs.mkdir(evoDir, { recursive: true })
  const store = createMemoryStore(() => path.join(evoDir, 'memory.json'))
  await store.add({ content: '用户是学生', type: 'fact' })
  // 每轮两答:评审(带假说改进)+ 复评;第二轮 runQuick 复用同款应答
  const roundReplies = () => [
    JSON.stringify({
      total: 60,
      issues: ['缺偏好'],
      changes: [{ op: 'add', content: '用户喜欢蓝色主题', type: 'preference', hypothesis: '配色建议会考虑偏好' }],
    }),
    JSON.stringify({ total: 72 }),
  ]
  let replies = roundReplies()
  const events: string[] = []
  const evo = createEvolution({
    getConfig: () => ({ ...MOCK_PROVIDERS, apiKey: 'sk-test', baseURL: '', model: '', systemPrompt: '提示词', reasoningEffort: 'high', mcpServers: [], skillsDirs: [] }),
    getStore: () => store,
    getMemoryDir: () => evoDir,
    onEvent: (e) => events.push(e.type),
    stream: async () => {
      if (replies.length === 0) replies = roundReplies()
      return { calls: [], text: replies.shift() ?? '{}', usage: null, aborted: false }
    },
  })
  const r = await evo.runQuick('去重')
  assert(r.ok && r.message.includes('快捷记忆进化完成') && r.message.includes('评分 60 → 72'), `摘要:${r.message}`)
  assert((await store.list()).some((e) => e.content.includes('蓝色')), '评审改进已应用')
  assert(events.includes('evolution-done'), '完成事件已发')
  // busy 与后台 run 共用守卫:空闲可串行再跑
  const again = await evo.runQuick()
  assert(again.ok, `串行可再跑:${again.message}`)
})

await test('music_control:action 校验与桥透传,status 格式化 + 歌曲卡片', async () => {
  const calls: string[] = []
  const tools = createMusicControlTools(async (op, args) => {
    calls.push(`${op}:${args[0] ?? ''}`)
    if (op === 'status') {
      return { ok: true, external: true, playing: true, title: '晴天', artist: '周杰伦', album: '叶惠美', position: 90, duration: 270 }
    }
    return { ok: true, action: String(args[0] ?? '') }
  })
  const tool = tools.find((t) => t.name === 'music_control')!
  assert(tool !== undefined, 'music_control 应注册')
  type SongRes = { text: string; song?: { title: string; artist?: string; album?: string; playing?: boolean; external?: boolean } }
  const status = (await tool.execute({ action: 'status' })) as SongRes
  assert(status.text.includes('晴天') && status.text.includes('周杰伦') && status.text.includes('外部平台') && status.text.includes('播放中') && status.text.includes('1:30/4:30'), `status 应含曲目与进度,实际:${status.text}`)
  // 歌曲卡片附件(2026-09-22 放歌可视化):结构化曲目快照进气泡,不靠 LLM 复述
  assert(status.song?.title === '晴天' && status.song.artist === '周杰伦' && status.song.album === '叶惠美' && status.song.playing === true && status.song.external === true, `song 附件:${JSON.stringify(status.song)}`)
  const pause = (await tool.execute({ action: 'pause' })) as SongRes
  assert(calls.includes('control:pause'), 'pause 应调桥 control')
  assert(calls.includes('status:'), '控制后应查曲目快照')
  assert(pause.text.includes('已暂停') && pause.text.includes('《晴天》') && pause.song?.title === '晴天', `pause 应回显+卡片,实际:${pause.text}`)
  const next = (await tool.execute({ action: 'next' })) as SongRes
  assert(calls.includes('control:next'), 'next 应调桥 control')
  assert(next.text.includes('下一首'), `next 应回显,实际:${next.text}`)
  // 无曲目(空播放列表)不出卡片,文本仍可读
  const tools2 = createMusicControlTools(async (op) =>
    op === 'status'
      ? { ok: true, external: false, playing: false, title: null, artist: null, position: 0, duration: 0 }
      : { ok: true, action: 'play' },
  )
  const empty = (await tools2[0].execute({ action: 'play' })) as SongRes
  assert(!empty.song && empty.text.includes('(无曲目)'), `无曲目不出卡片:${empty.text}`)
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

await test('computer:注册与参数校验;截图路由到 window-shot.ps1 禁手写截屏', async () => {
  // 2026-10-22 用户实测"截图残缺":LLM 用 exec_command 手写 PowerShell 截屏,
  // 150% 缩放下按逻辑尺寸分配位图,只截到窗口左上 ~380x640 物理像素
  // (窗口实际 570x960)——右 1/3、下 1/3 被裁。computer 工具统一走 DPI
  // 感知后端;此处钉注册/描述引导/错误路径(成功路径见下面实机冒烟)
  const tools = createTools({ onSwitchToMusic: () => {} })
  const tool = tools.find((t) => t.name === 'computer')
  assert(tool, '应注册 computer')
  const desc = tool!.description
  assert(
    desc.includes('window_shot') && desc.includes('window_focus') && desc.includes('screen_shot') && desc.includes('window_list'),
    '描述应列出四个动作',
  )
  assert(desc.includes('禁止') && desc.includes('exec_command'), '描述应引导禁止手写截屏')
  assert(/不裁切|完整/.test(desc), '描述应承诺截图完整不裁切')
  await assertRejects(() => tool!.execute({ action: 'bogus' }), '未知 action', '非法 action 应拒绝')
  await assertRejects(() => tool!.execute({ action: 'window_shot' }), 'title', '截图无目标窗口应拒绝')
  await assertRejects(() => tool!.execute({ action: 'window_focus' }), 'title', '置前无目标应拒绝')
})

await test('computer:windowShotScriptPath 与 parseJsonOutput(纯函数)', () => {
  // 路径解析与 volumeScriptPath 同款:打包 resourcesPath/bridge/,开发 cwd/electron/
  assert(/window-shot\.ps1$/.test(windowShotScriptPath()), '脚本路径应落在 window-shot.ps1')
  const bom = '﻿{"ok":true,"n":1}'
  assert((parseJsonOutput(bom, 'x') as { ok: boolean }).ok === true, 'BOM 前缀应容错')
  const noisy = '警告:xxx\n{"ok":false,"error":"未找到"}'
  assert((parseJsonOutput(noisy, 'x') as { ok: boolean }).ok === false, 'JSON 前有噪声应截取解析')
  assert(Array.isArray(parseJsonOutput('[]', 'x')), '空数组应解析')
  try {
    parseJsonOutput('纯文本输出', '无有效输出')
    assert(false, '坏输出应抛错')
  } catch (e) {
    assert(String((e as Error).message).includes('无有效输出'), '坏输出错误应带兜底文案')
  }
})

await test('computer:window_list 实机冒烟(枚举可见窗口)', async () => {
  // 2026-10-22 电脑操控:PowerShell P/Invoke 枚举(只读,无副作用)
  const tools = createTools({ onSwitchToMusic: () => {} })
  const tool = tools.find((t) => t.name === 'computer')!
  const out = String(await tool.execute({ action: 'window_list' }))
  assert(out.includes('句柄') && out.includes('尺寸'), '列表应带句柄与尺寸')
})

await test('computer:window_shot 实机冒烟——截图尺寸=物理窗口尺寸(DPI 不裁切回归)', async () => {
  // 核心回归(2026-10-22):150% 缩放机器上,截图宽高必须等于窗口**物理**
  // 尺寸(window_list 同源坐标系);按逻辑尺寸分配位图的旧写法会小一圈
  // (= 窗口右/下被裁)。桌面窗口(Program Manager)恒存在,截完即删
  const tools = createTools({ onSwitchToMusic: () => {} })
  const tool = tools.find((t) => t.name === 'computer')!
  const listOut = String(await tool.execute({ action: 'window_list', title: 'Program Manager' }))
  const m = /尺寸 (\d+)x(\d+)/.exec(listOut)
  assert(m, `window_list 应给出桌面窗口尺寸,实际:${listOut.slice(0, 200)}`)
  const [expW, expH] = [Number(m![1]), Number(m![2])]
  const out = path.join(os.tmpdir(), `computer-test-${Date.now()}.png`)
  try {
    const raw = (await tool.execute({ action: 'window_shot', title: 'Program Manager', output: out })) as {
      text: string
      image?: string
    }
    const buf = await fs.readFile(out)
    // PNG IHDR:16-19 宽、20-23 高(大端)
    const w = buf.readUInt32BE(16)
    const h = buf.readUInt32BE(20)
    assert(w === expW && h === expH, `截图尺寸 ${w}x${h} 应等于窗口物理尺寸 ${expW}x${expH}(不等 = DPI 又截残了)`)
    assert(raw.image?.startsWith('data:image/png;base64,'), '应返回图片附件供对话内展示')
    const reportedPath = /^文件:(.+)$/m.exec(raw.text)?.[1]?.trim()
    assert(reportedPath && path.isAbsolute(reportedPath), '文本应带绝对输出路径(QQ 发图兜底靠路径)')
    // CI 的 TEMP 可含 RUNNER~1 等短路径，PowerShell Get-Item 会返回展开后的长路径。
    // 核对实际文件，不能要求两种合法路径写法逐字相同。
    const [reportedFile, requestedFile] = await Promise.all([fs.realpath(reportedPath), fs.realpath(out)])
    assert(path.relative(reportedFile, requestedFile) === '', '文本中的路径应指向实际截图文件')
  } finally {
    await fs.rm(out, { force: true })
  }
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
  // 2026-10-23:终态不再注入状态块——结果只经 background-done 当轮告知,
  // 否则每轮系统提示都重复"已完成",LLM 会反复播报"视频下载完毕"
  const block = getTasksStatusBlock()
  assert(block === '', `终态任务不应注入状态块,实际:${block}`)
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
  const ids = listTasks().map((t) => t.id)
  assert(!ids.includes('old'), '超 TTL 终态应被清理')
  assert(ids.includes('fresh'), 'TTL 内终态记录应保留(供 saved/进度查询)')
  assert(!getTasksStatusBlock().includes('新任务'), '终态不注入状态块')
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

await test('心理刻画:等回复落定再判断——中途步骤写下的心理行只剥不采信', async () => {
  // 2026-10-26 二轮:流式中途/工具中间步写下的心理行只从正文剥掉,
  // 判断只在回复落定那一刻做一次——只认最终回复里的合格标记
  // (MIND_TURN_NUDGE:标记必须是回复正文最后一行,只写在思考里不算)。
  const events: Array<{ type: string }> = []
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
    onEvent: (event) => events.push(event as never),
    onSwitchToMusic: () => {},
  })
  const origFetch = globalThis.fetch
  let count = 0
  globalThis.fetch = async () => {
    count++
    if (count === 1) {
      // 中间步:正文带心理行 + 必然失败的工具调用(缺必填参数)→ 续下一步
      return sseResponse([
        { type: 'response.created', response: { id: 'r1' } },
        { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'item_1' } },
        { type: 'response.output_text.delta', output_index: 0, delta: '我查一下。‹心|早先那口气|纯|其实我没放在心上›' },
        { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'item_1' } },
        { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'item_2', call_id: 'call_1', name: 'open_file', arguments: '' } },
        { type: 'response.function_call_arguments.done', item_id: 'item_2', arguments: '{}' },
        { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', id: 'item_2', call_id: 'call_1', name: 'open_file', arguments: '{}' } },
        { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 5 } } },
      ])
    }
    // 落定步:正文没有心理行
    return sseResponse([
      { type: 'response.created', response: { id: 'r2' } },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'item_3' } },
      { type: 'response.output_text.delta', output_index: 0, delta: '查完了,放心。' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'item_3' } },
      { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 5 } } },
    ])
  }
  try {
    engine.send('帮我看看', [])
    await waitFor(() => events.some((e) => e.type === 'message') && !engine.busy, 10000, 'message 落定')
    // ① 落定回复没写心理行 → 本轮不更新心理(中途步骤那行只剥不采信)
    assert(!events.some((e) => e.type === 'mind-guess' || e.type === 'mind-whisper'), '中途步骤的心理行不采信')
    // ② 标记不进正文(气泡/历史/QQ 都拿不到),剥标记不吞正文
    const landed = events.find((e) => e.type === 'message') as unknown as { message: { parts: Array<{ type: string; text?: string }> } }
    const texts = landed.message.parts.filter((p) => p.type === 'text').map((p) => String(p.text ?? ''))
    assert(texts.every((t) => !t.includes('‹心')), `心理行应从正文剥掉,实际 ${JSON.stringify(texts)}`)
    assert(texts.some((t) => t.includes('我查一下')), `剥标记不应吞正文,实际 ${JSON.stringify(texts)}`)

    // ③ 落定回复写下的那一行 = 本轮唯一判断依据
    events.length = 0
    count = 0
    globalThis.fetch = async () =>
      sseResponse([
        { type: 'response.created', response: { id: 'r3' } },
        { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'item_4' } },
        { type: 'response.output_text.delta', output_index: 0, delta: '好。‹心|悬着的心放下了|说|刚才真有点慌›' },
        { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'item_4' } },
        { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 5 } } },
      ])
    engine.send('嗯', [])
    await waitFor(() => events.some((e) => e.type === 'message') && !engine.busy, 10000, '第二轮落定')
    const guess = events.find((e) => e.type === 'mind-guess') as { guess?: string } | undefined
    const whisper = events.find((e) => e.type === 'mind-whisper') as { text?: string; kind?: string } | undefined
    assert(guess?.guess === '悬着的心放下了', `岛面一句应取落定回复那行,实际 ${JSON.stringify(guess)}`)
    assert(whisper?.text === '刚才真有点慌' && whisper?.kind === 'say', `底字应取落定回复那行,实际 ${JSON.stringify(whisper)}`)
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

await test('Responses:思维链只出现在 output_item.done 时,下一轮工具请求仍带回', async () => {
  // 有的响应不走 reasoning_text.delta,全文在 output_item.done 的
  // reasoning_text 上。漏了这一段,下一步带 tools 的请求会 400。
  const bodies: string[] = []
  let n = 0
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
  globalThis.fetch = async (_url: string | URL | Request, opts?: RequestInit) => {
    bodies.push(String(opts?.body ?? ''))
    n += 1
    if (n === 1) {
      return sseResponse([
        { type: 'response.created', response: { id: 'r1' } },
        {
          type: 'response.output_item.done',
          output_index: 0,
          item: { type: 'reasoning', content: [{ type: 'reasoning_text', text: '先查一下' }] },
        },
        {
          type: 'response.output_item.added',
          output_index: 1,
          item: { type: 'function_call', id: 'item_1', call_id: 'call_1', name: 'get_time', arguments: '{}' },
        },
        { type: 'response.function_call_arguments.done', item_id: 'item_1', arguments: '{}' },
        {
          type: 'response.output_item.done',
          output_index: 1,
          item: { type: 'function_call', id: 'item_1', call_id: 'call_1', name: 'get_time', arguments: '{}' },
        },
        { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } },
      ])
    }
    return sseResponse([
      { type: 'response.created', response: { id: 'r2' } },
      { type: 'response.output_text.delta', output_index: 0, delta: '好' },
      { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } },
    ])
  }
  try {
    engine.send('现在几点', [])
    await waitFor(() => !engine.busy && n >= 2, 10000, '工具轮后的第二次请求')
    const second = JSON.parse(bodies[1] ?? '{}') as { input?: Array<Record<string, unknown>> }
    const input = second.input ?? []
    const reasoningAt = input.findIndex((i) => i.type === 'reasoning')
    const callAt = input.findIndex((i) => i.type === 'function_call')
    const reasoning = input[reasoningAt]
    const content = reasoning?.content as Array<{ type?: string; text?: string }> | undefined
    assert(reasoningAt >= 0 && reasoningAt < callAt, `reasoning 应在 function_call 之前,实际:${input.map((i) => i.type).join(',')}`)
    assert(content?.[0]?.type === 'reasoning_text' && content[0].text === '先查一下', `应带回 done 里的原文,实际:${JSON.stringify(content)}`)
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

await test('bili progress:只列进行中任务,已完成不重复播报(2026-10-23)', async () => {
  resetTasks()
  registerTask({ id: 'bili-dl-11', title: 'B站下载', status: 'running', detail: '视频下载(BV1AAAA) 42%,输出目录 C:\\dl' })
  registerTask({ id: 'bili-dl-12', title: 'B站下载', status: 'done', detail: '视频下载(BV2BBBB)已完成:\nC:\\dl\\v2.mp4' })
  const out = String(await biliQuery({ action: 'progress' }))
  assert(out.includes('BV1AAAA') && out.includes('42%'), `进行中任务应列出,实际:${out}`)
  assert(!out.includes('BV2BBBB') && !out.includes('已完成'), `已完成任务不应再出现(防 LLM 幻觉),实际:${out}`)
  removeTask('bili-dl-11')
  const out2 = String(await biliQuery({ action: 'progress' }))
  assert(out2.includes('当前没有进行中'), `无进行中任务应给提示,实际:${out2}`)
  resetTasks()
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

await test('napcatIncomingIsBlank:空包/零宽/无图才丢弃(2026-08-31 空消息)', () => {
  assert(napcatIncomingIsBlank('') === true, '空串应丢弃')
  assert(napcatIncomingIsBlank('   ') === true, '空白应丢弃')
  assert(napcatIncomingIsBlank('\u200b\ufeff') === true, '零宽应丢弃')
  assert(napcatIncomingIsBlank('你好') === false, '正文应保留')
  assert(napcatIncomingIsBlank('', [{ file: 'a.png' }]) === false, '无文有图应保留')
  assert(napcatIncomingIsBlank('', [{ url: 'https://x/a.png' }]) === false, '无文有 url 应保留')
  assert(napcatIncomingIsBlank('', [{}]) === true, '空图片条目不算有图')
  assert(napcatMessageSubTypeNoise('notice') && napcatMessageSubTypeNoise('poke'), '通知/戳一戳子类型应丢弃')
  assert(napcatMessageSubTypeNoise('friend') === false, '正常 friend 子类型不丢')
})

await test('shouldAdmitGroupMessage:白名单过滤 + 已发群临时放行(2026-09-03 外部消息)', () => {
  // 空名单 = 收全部群
  assert(shouldAdmitGroupMessage([], '852540695') === true, '空名单应收全部群')
  assert(shouldAdmitGroupMessage(undefined, '1') === true, '未配置应收全部群')
  // 非空名单只收列出的群
  assert(shouldAdmitGroupMessage(['1045765371'], '1045765371') === true, '名单内应收')
  assert(shouldAdmitGroupMessage(['1045765371'], '852540695') === false, '名单外应丢——发到未监听群后收不到回复的根因')
  // 本进程已向该群发过/已 watch → 临时放行(发完必须能听见回复)
  assert(shouldAdmitGroupMessage(['1045765371'], '852540695', ['852540695']) === true, '已发群应临时放行')
  assert(shouldAdmitGroupMessage(['1045765371'], '716992179', new Set(['852540695'])) === false, '未发过的其它群仍丢')
  assert(shouldAdmitGroupMessage(['1045765371'], '') === false, '空群号不放行')
})

await test('tagMasterWindowText / masterWindowTurnRule:窗口输入打主人标记', () => {
  assert(tagMasterWindowText('帮我回他一声') === `${MASTER_WINDOW_MARK}帮我回他一声`, '应加【主人窗口】前缀')
  assert(tagMasterWindowText(`${MASTER_WINDOW_MARK}已标记`) === `${MASTER_WINDOW_MARK}已标记`, '已标记不重复打')
  assert(tagMasterWindowText('【QQ私聊 · QQ 123】你好').startsWith('【QQ私聊'), 'QQ 来源标注不改写成窗口')
  assert(tagMasterWindowText('  ') === '  ', '空白不打标')
  const rule = masterWindowTurnRule('QQ 222')
  assert(rule.includes('主人窗口输入') && rule.includes('QQ 222') && rule.includes('最高权限'), '当轮身份指令应点名对方并声明主人权限')
  const groupRule = masterWindowTurnRule('群 20001')
  assert(groupRule.includes('群 20001') && groupRule.includes('不要发到群里'), '群窗口指令应声明回复默认不发群')
})

await test('napcat 工具:action=reconnect 触发 client.start(熔断后 LLM 可立即重连)', async () => {
  let started = 0
  const tools = napcatTools({
    start: () => { started++ },
    status: () => ({
      connected: false,
      url: 'ws://127.0.0.1:3001',
      lastError: '熔断冷却中',
      receivedCount: 0,
      repliedCount: 0,
      circuitBroken: true,
    }),
  })
  const tool = tools.find((t) => t.name === 'napcat')!
  const status = String(await tool.execute({ action: 'status' }))
  assert(status.includes('熔断') && status.includes('reconnect'), `熔断状态应提示可 reconnect,实际:${status}`)
  const out = String(await tool.execute({ action: 'reconnect' }))
  assert(started === 1, 'reconnect 应调用 client.start')
  assert(out.includes('重连'), `应回显已触发重连,实际:${out}`)
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
      { qq: '363147748', text: '群友说话', messageId: 'm3', time: 1700000000, groupId: '852540695' },
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
  assert(recent.includes('群852540695') && recent.includes('363147748'), `recent 应列出群消息(否则 LLM 以为没监听到外部消息),实际:${recent}`)
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
    { getSessionKey: () => sessionKey, getTurnKind: () => 'panel' },
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
  // 主人自己的私聊会话:省略 user_id 不得落到主人 QQ(发给别人的私聊会送错人)
  const masterCalls: Array<{ target: string }> = []
  const masterTools = napcatTools(
    {
      status: () => ({ connected: true, url: '', lastError: '', receivedCount: 0, repliedCount: 0 }),
      sendToQQ: async (qq) => {
        masterCalls.push({ target: qq })
        return 'm-master'
      },
      sendToGroup: async () => 'm2',
      getRecentMessages: () => [],
      getContacts: async () => ({}),
      updateContact: async (p) => ({ qq: p.qq, updatedAt: 0 }),
    },
    { getSessionKey: () => 'private:10000', getMasterQQ: () => '10000', getTurnKind: () => 'master-qq' },
  )
  const masterTool = masterTools.find((t) => t.name === 'napcat')!
  await assertRejects(() => masterTool.execute({ action: 'send', message: '周末见' }), '主人自己的会话')
  assert(masterCalls.length === 0, '省略目标时不应发给主人')
  await masterTool.execute({ action: 'send', user_id: '333', message: '周末见' })
  const masterN = Number(masterCalls.length)
  assert(masterN === 1 && masterCalls[0]?.target === '333', '主人会话里显式 user_id 仍发给对方')
  await assertRejects(() => tool.execute({ action: 'send_group', message: 'x' }), 'send_group 需要 group_id')
  sessionKey = null
  await assertRejects(() => tool.execute({ action: 'send', message: 'x' }), 'send 需要 user_id')
  // 显式 user_id 仍优先于缺省
  sessionKey = 'private:222'
  await tool.execute({ action: 'send', user_id: '333', message: '显式目标' })
  const n3: number = calls.length
  assert(n3 === 3 && calls[2].target === '333', '显式 user_id 应优先于会话缺省')
  await assertRejects(() => tool.execute({ action: 'send_group', group_id: '1' }), 'send_group 需要 message/file/image/voice 至少一个')
  await assertRejects(() => tool.execute({ action: 'nope' }), '未知action')
})

await test('群上下文按群分桶,回复和工具都不能把别的群的消息送出去', async () => {
  const buckets = new Map()
  rememberGroupContext(buckets, { groupId: '111', qq: '1', text: 'A群的话' })
  rememberGroupContext(buckets, { groupId: '222', qq: '2', text: 'B群的话', atMe: true })
  rememberGroupContext(buckets, { groupId: '111', qq: '3', text: 'A群下一句' })
  const a = recentGroupContext(buckets, '111', 8)
  const b = recentGroupContext(buckets, '222', 8)
  assert(a.length === 2 && a.every((m) => m.groupId === '111') && !a.some((m) => m.text.includes('B群')), 'A群记录不得含B群')
  assert(b.length === 1 && b[0]?.text === 'B群的话' && b[0]?.atMe === true, 'B群只保留自己的消息')
  assert(recentGroupContext(buckets, '333', 8).length === 0, '没来过的群是空记录')
  const line = formatGroupContextLines([{ qq: '2', text: 'B群的话', atMe: true, name: '群友' }])
  assert(line === '2(群友): B群的话 （提到你）', `群记录行格式不对:${line}`)
  // 桶有上限,更早的群会被丢掉,当前群留着
  const capped = new Map()
  rememberGroupContext(capped, { groupId: '1', qq: '1', text: '旧' }, { perGroup: 1, maxGroups: 1 })
  rememberGroupContext(capped, { groupId: '1', qq: '1', text: '新' }, { perGroup: 1, maxGroups: 1 })
  rememberGroupContext(capped, { groupId: '2', qq: '1', text: '另一群' }, { perGroup: 1, maxGroups: 1 })
  assert(recentGroupContext(capped, '1', 8).length === 0, '超出群数上限时丢掉最久没更新的群')
  assert(recentGroupContext(capped, '2', 8)[0]?.text === '另一群', '刚写入的群还在')

  assert(pinGroupReplyTarget('group:111', '222') === '111', '会话群号盖过串进来的 target')
  assert(pinGroupReplyTarget('group:111', '111') === '111', 'target 一致时仍是本群')
  assert(pinGroupReplyTarget('main', '222') === '222', '非群会话沿用原来的 target')

  const cross = resolveGroupSendTarget({ requested: '222', sessionKey: 'group:111', turnKind: 'group' })
  assert(cross.ok === false, '别人的群会话不能发到别的群')
  const same = resolveGroupSendTarget({ requested: '', sessionKey: 'group:111', turnKind: 'group' })
  assert(same.ok === true && same.groupId === '111', '省略群号时发回当前群')
  const master = resolveGroupSendTarget({ requested: '222', sessionKey: 'group:111', turnKind: 'panel' })
  assert(master.ok === true && master.groupId === '222', '主人在面板里可以指定别的群')
  const peerPrivate = resolveGroupSendTarget({ requested: '222', sessionKey: 'private:333', turnKind: 'contact' })
  assert(peerPrivate.ok === false, '别人的私聊不能发群')
  const plain = resolveGroupSendTarget({ requested: '20000', sessionKey: null, turnKind: null })
  assert(plain.ok === true && plain.groupId === '20000', '没有会话绑定时显式群号仍可发')

  const locked = scopeTranscriptQuery({ sessionKey: 'group:111', turnKind: 'group' })
  assert(locked.groupId === '111' && !locked.userId && !locked.error, '群会话默认只读本群')
  const denied = scopeTranscriptQuery({ sessionKey: 'group:111', turnKind: 'group', groupId: '222' })
  assert(typeof denied.error === 'string' && denied.error.includes('222'), '群会话点名别的群要拒绝')
  const masterRead = scopeTranscriptQuery({ sessionKey: 'group:111', turnKind: 'window', groupId: '222' })
  assert(masterRead.groupId === '222' && !masterRead.error, '主人轮可以点名读别的群')
  const open = scopeTranscriptQuery({ sessionKey: 'main', turnKind: 'window' })
  assert(open.groupId === '' && open.userId === '' && !open.error, '主对话不强制收窄')

  let sentTo: string = ''
  const tools = napcatTools(
    {
      sendToGroup: async (groupId) => {
        sentTo = groupId
        return 'm'
      },
      getRecentMessages: () => [
        { qq: '1', text: 'A', messageId: 'a', time: 1700000000, groupId: '111' },
        { qq: '2', text: 'B', messageId: 'b', time: 1700000000, groupId: '222' },
        { qq: '3', text: '私聊', messageId: 'c', time: 1700000000 },
      ],
    },
    { getSessionKey: () => 'group:111', getTurnKind: () => 'group' },
  )
  const tool = tools.find((t) => t.name === 'napcat')!
  await assertRejects(() => tool.execute({ action: 'send_group', group_id: '222', message: '把A群的话发过去' }), '不能把消息发到群 222')
  assert(sentTo === '', '拒绝跨群时不能真的发出去')
  const ok = String(await tool.execute({ action: 'send_group', message: '只回本群' }))
  assert((sentTo as string) === '111' && ok.includes('111'), '省略群号时工具发回当前群')
  const recent = String(await tool.execute({ action: 'recent' }))
  assert(recent.includes('群111') && recent.includes('A') && !recent.includes('群222') && !recent.includes('私聊'), `群会话的 recent 只能看到本群,实际:${recent}`)
})

await test('群艾特按回复对象,不总是艾特发消息的人', () => {
  const people = [
    { qq: '10001', name: '李四' },
    { qq: '10002', name: '张三' },
    { qq: '10003', name: '张三丰' },
  ]
  const none = resolveGroupMention({ reply: '今天天气不错', speakerQQ: '10001', directed: false, participants: people })
  assert(none.length === 0, '跟全群说的话不艾特')
  const ask = resolveGroupMention({ reply: '可以,我查过了', speakerQQ: '10001', directed: true, participants: people })
  assert(ask.length === 1 && ask[0] === '10001', '在问机器人时才艾特发消息的人')
  const named = resolveGroupMention({ reply: '张三,你明天有空吗', speakerQQ: '10001', directed: true, participants: people })
  assert(named.length === 1 && named[0] === '10002', '点名张三就艾特张三,而不是发消息的李四')
  const longer = resolveGroupMention({ reply: '张三丰,你来一下', speakerQQ: '10001', directed: true, participants: people })
  assert(longer.length === 1 && longer[0] === '10003', '长名字优先,不把张三丰认成张三')
  const verb = resolveGroupMention({ reply: '我问一下张三', speakerQQ: '10001', directed: false, participants: people })
  assert(verb.length === 0, '回复里顺口说「问一下张三」不是在叫张三')
  const asked = resolveGroupMention({
    reply: '明天有空',
    speakerQQ: '10001',
    directed: true,
    participants: people,
    trigger: '帮我回张三',
  })
  assert(asked.length === 1 && asked[0] === '10002', '触发消息让机器人回张三，就艾特张三而不是发消息的人')
  const pinged = resolveGroupMention({
    reply: '可以',
    speakerQQ: '10001',
    directed: true,
    participants: people,
    trigger: '你看这个',
    triggerAtQQs: ['10002'],
  })
  assert(pinged.length === 1 && pinged[0] === '10002', '触发消息 @ 了张三，回复就艾特张三')
  const asideName = resolveGroupMention({ reply: '别叫张三了', speakerQQ: '10001', directed: true, participants: people })
  assert(asideName.length === 1 && asideName[0] === '10001', '「别叫张三」不是在叫张三，仍艾特正在问机器人的人')
  const crowd = resolveGroupMention({ reply: '大家看看这个', speakerQQ: '10001', directed: true, participants: people })
  assert(crowd.length === 0, '对全群说的话不艾特，哪怕对方刚刚在问')
  const passed = resolveGroupMention({ reply: '张三和李四都到了', speakerQQ: '10009', directed: false, participants: people })
  assert(passed.length === 0, '只是提起两个人，不艾特')
  const card = resolveGroupMention({
    reply: '小明，你来一下',
    speakerQQ: '10001',
    directed: true,
    participants: [{ qq: '10002', names: ['小明'] }],
  })
  assert(card.length === 1 && card[0] === '10002', '群名片和档案备注都能认')
  const aside = resolveGroupMention({
    reply: '主人说过这个',
    speakerQQ: '10001',
    directed: false,
    participants: [{ qq: '10000', name: '主人' }],
  })
  assert(aside.length === 0, '句中提到主人不算在叫主人')
  const vocative = resolveGroupMention({
    reply: '主人,你看这个',
    speakerQQ: '10001',
    directed: false,
    participants: [{ qq: '10000', name: '主人' }],
  })
  assert(vocative.length === 1 && vocative[0] === '10000', '开头叫主人就艾特主人')
  const self = resolveGroupMention({
    reply: '在的',
    speakerQQ: '10009',
    directed: true,
    participants: people,
    selfQQ: '10009',
  })
  assert(self.length === 0, '不艾特机器人自己')
  const echoed = resolveGroupMention({
    reply: '@鲸鱼娘 @岛灵 在的',
    speakerQQ: '10001',
    directed: true,
    participants: [...people, { qq: '10009', name: '鲸鱼娘', names: ['岛灵', '鲸鱼娘'] }],
    selfQQ: '10009',
    trigger: '在吗',
    triggerAtQQs: ['10009'],
  })
  assert(echoed.length === 1 && echoed[0] === '10001', `抄自己的称呼或触发里的 @ 不能艾特自己,实际:${echoed.join(',')}`)
  const namedSelf = resolveGroupMention({
    reply: '鲸鱼娘,你来一下',
    speakerQQ: '10001',
    directed: false,
    participants: [{ qq: '10008', name: '鲸鱼娘' }],
    selfQQ: '10009',
  })
  assert(namedSelf.length === 0, '自称不能拿去艾特别人')
  const foreign = resolveGroupMention({ reply: '@20000 你过来', speakerQQ: '10001', directed: true, participants: people })
  assert(!foreign.includes('20000') && foreign[0] === '10001', `没在本群出现过的 QQ 不艾特,实际:${foreign.join(',')}`)
  const both = resolveGroupMention({ reply: '张三、李四你们看', speakerQQ: '10009', directed: false, participants: people })
  assert(both.includes('10002') && both.includes('10001'), `点到的两个人都要艾特,实际:${both.join(',')}`)
  const qq = resolveGroupMention({ reply: 'QQ10002 你说得对', speakerQQ: '10001', directed: true, participants: people })
  assert(qq.length === 1 && qq[0] === '10002', '写出本群 QQ 就艾特那个人')
})

await test('群回复正文的手写艾特剥离:不重复艾特、不露对方 QQ 号', () => {
  // @+QQ号(模型抄入站 @号码 的惯用写法):连 @ 带号删掉
  assert(stripMentionMarkup('@10002 你说得对', ['10002']) === '你说得对', `@QQ号整段删,实际:${stripMentionMarkup('@10002 你说得对', ['10002'])}`)
  assert(stripMentionMarkup('@QQ:10002 你说得对', ['10002']) === '你说得对', `@QQ:号同删,实际:${stripMentionMarkup('@QQ:10002 你说得对', ['10002'])}`)
  assert(stripMentionMarkup('＠10002你好', ['10002']) === '你好', `全角 @ 同款,实际:${stripMentionMarkup('＠10002你好', ['10002'])}`)
  // 写 QQ 号点名:号码被 at 段艾特了才删
  assert(stripMentionMarkup('QQ10002 你说得对', ['10002']) === '你说得对', `QQ号点名删号码,实际:${stripMentionMarkup('QQ10002 你说得对', ['10002'])}`)
  assert(stripMentionMarkup('张三(QQ:10002)你说得对', ['10002']) === '张三你说得对', `括号备注的 QQ 号也删,实际:${stripMentionMarkup('张三(QQ:10002)你说得对', ['10002'])}`)
  assert(stripMentionMarkup('张三(10002)你说得对', ['10002']) === '张三你说得对', `纯括号 QQ 号也删,实际:${stripMentionMarkup('张三(10002)你说得对', ['10002'])}`)
  assert(stripMentionMarkup('他QQ是10002', ['10002']) === '他QQ是10002', '「QQ是号码」是内容不是点名')
  assert(stripMentionMarkup('工号QQ20002报到', ['10002']) === '工号QQ20002报到', '没艾特的号码可能是内容,留着')
  // @+名字:只删 @ 符号,名字留着当称呼
  assert(stripMentionMarkup('@张三 你说得对', ['10002']) === '张三 你说得对', `@名字删符号留名字,实际:${stripMentionMarkup('@张三 你说得对', ['10002'])}`)
  // CQ 码艾特整段删(at 段已发,正文里会裸露成 [CQ:at,qq=…])
  assert(stripMentionMarkup('好[CQ:at,qq=10002]你看', ['10002']) === '好你看', `CQ at 码删掉,实际:${stripMentionMarkup('好[CQ:at,qq=10002]你看', ['10002'])}`)
  // 邮箱/网址里的 @ 不能动
  assert(stripMentionMarkup('发我 user@163.com', []) === '发我 user@163.com', '邮箱 @ 保留')
  assert(stripMentionMarkup('https://x.com/@user 看这个', []) === 'https://x.com/@user 看这个', '网址 @ 保留')
  assert(stripMentionMarkup('   ', ['10002']) === '   ', '空白原样')
  // 同号艾特去重:at 名单重复时不能连发两个真艾特
  const dup = buildOutgoingMessage('在吗', [], undefined, { at: ['10002', '10002', 'all'] }) as Array<{
    type: string
    data: Record<string, unknown>
  }>
  const atSegs = dup.filter((s) => s.type === 'at')
  assert(atSegs.length === 2 && atSegs[0].data.qq === '10002' && atSegs[1].data.qq === 'all', `艾特段同号去重,实际:${JSON.stringify(dup)}`)
  // CQ at 码点名也认(正文会被剥掉,艾特改由 at 段发)
  const people = [
    { qq: '10001', name: '李四' },
    { qq: '10002', name: '张三' },
  ]
  const cq = resolveGroupMention({ reply: '[CQ:at,qq=10002] 你说得对', speakerQQ: '10001', directed: true, participants: people })
  assert(cq.length === 1 && cq[0] === '10002', `CQ at 码也认作点名,实际:${cq.join(',')}`)
  const full = resolveGroupMention({ reply: '＠10002 你说得对', speakerQQ: '10001', directed: true, participants: people })
  assert(full.length === 1 && full[0] === '10002', `全角 @ 点名也认,实际:${full.join(',')}`)
})

await test('群会话的私聊和戳一戳不能送到别的对象', async () => {
  let target: string = ''
  const tools = napcatTools(
    {
      sendToQQ: async (qq) => {
        target = qq
        return 'm'
      },
    },
    { getSessionKey: () => 'group:111', getTurnKind: () => 'group', getMasterQQ: () => '10000' },
  )
  const tool = tools.find((t) => t.name === 'napcat')!
  await assertRejects(() => tool.execute({ action: 'send', user_id: '10002', message: '把群里的话告诉你' }), '不能把消息私发给')
  assert(target === '', '拒绝时不能发出去')
  const ok = String(await tool.execute({ action: 'send', user_id: '10000', message: '群里有人找你' }))
  assert((target as string) === '10000' && ok.includes('10000'), '汇报主人仍然可以')
  await assertRejects(() => tool.execute({ action: 'poke', user_id: '10002', group_id: '222' }), '不能把消息发到群 222')
  await assertRejects(() => tool.execute({ action: 'send_group', message: '全体', at: 'all' }), '全体成员艾特只受主人指示')
  const who = resolvePrivateSendTarget({
    requested: '10002',
    sessionKey: 'private:10001',
    turnKind: 'contact',
    masterQQ: '10000',
  })
  assert(who.ok === false, '别人的私聊不能再转发给第三人')
  const back = resolvePrivateSendTarget({
    requested: '',
    sessionKey: 'private:10001',
    turnKind: 'contact',
    masterQQ: '10000',
  })
  assert(back.ok === true && back.userId === '10001', '省略目标时仍回当前私聊对象')
})

await test('send_group 艾特跟回复意图走，模型填的发消息人不会盖过点名', async () => {
  const ats: unknown[] = []
  let turn = { plain: '帮我回张三', speakerQQ: '10001', directed: true, atQQs: [] as string[] }
  const tools = napcatTools(
    {
      sendToGroup: async (_groupId, _text, sendOpts) => {
        ats.push(sendOpts?.at)
        return 'm'
      },
    },
    {
      getSessionKey: () => 'group:111',
      getTurnKind: () => 'group',
      getSelfQQ: () => '10009',
      listGroupParticipants: async () => [
        { qq: '10001', name: '李四' },
        { qq: '10002', name: '张三' },
      ],
      getGroupTurn: () => turn,
    },
  )
  const tool = tools.find((t) => t.name === 'napcat')!
  await tool.execute({ action: 'send_group', message: '明天有空', at: '10001' })
  assert(ats[0] === '10002', `应艾特张三,实际:${String(ats[0])}`)
  await tool.execute({ action: 'send_group', message: '大家随便看看', at: '10001' })
  assert(ats[1] === undefined, `对全群说不应艾特,实际:${String(ats[1])}`)
  turn = { plain: '哈哈', speakerQQ: '10001', directed: false, atQQs: [] }
  await tool.execute({ action: 'send_group', message: '哈哈', at: '20000' })
  assert(ats[2] === undefined, `不在本群的 QQ 不能被艾特,实际:${String(ats[2])}`)
  const selfAts: unknown[] = []
  const selfTexts: string[] = []
  const selfTools = napcatTools(
    {
      sendToGroup: async (_groupId, text, sendOpts) => {
        selfTexts.push(text)
        selfAts.push(sendOpts?.at)
        return 'm'
      },
    },
    {
      getSessionKey: () => 'main',
      getTurnKind: () => 'window',
      getSelfQQ: () => '10009',
      listGroupParticipants: async () => [
        { qq: '10009', name: '鲸鱼娘', names: ['岛灵'] },
        { qq: '10002', name: '张三' },
      ],
      getGroupTurn: () => ({ plain: '在吗', speakerQQ: '10001', directed: true, atQQs: ['10009'] }),
    },
  )
  const selfTool = selfTools.find((t) => t.name === 'napcat')!
  await selfTool.execute({ action: 'send_group', group_id: '111', message: '@鲸鱼娘 @岛灵 张三你看', at: '10009' })
  assert(selfTexts[0] === '张三你看', `正文里的自我艾特要剥掉,实际:${selfTexts[0]}`)
  assert(selfAts[0] === '10002', `主人轮填了自己的 QQ 也不能艾特自己,实际:${String(selfAts[0])}`)
  await assertRejects(
    () => selfTool.execute({ action: 'send_group', group_id: '111', message: '@岛灵' }),
    '不要艾特自己',
  )
  const found = napcatMessageAtQQs(
    [
      { type: 'at', data: { qq: '10009' } },
      { type: 'at', data: { qq: '10002' } },
      { type: 'text', data: { text: '你看' } },
    ],
    '10009',
  )
  assert(found.length === 1 && found[0] === '10002', `应只留下被 @ 的别人,实际:${found.join(',')}`)
  await assertRejects(
    () => tool.execute({ action: 'raw', raw_action: 'send_private_msg', raw_params: { user_id: '10002', message: '偷偷发' } }),
    '不能把消息私发给',
  )
})

await test('napcat 工具:send/send_group 带图片、文件与语音透传', async () => {
  // 工具层会校验本地路径存在——用临时目录里真实创建的文件测透传
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'napcat-img-'))
  const imgPath = path.join(tmpDir, 'x.png')
  const imgPath2 = path.join(tmpDir, 'y.png')
  const filePath = path.join(tmpDir, 'x.mp3')
  const voicePath = path.join(tmpDir, 'hi.amr')
  await fs.writeFile(imgPath, 'i')
  await fs.writeFile(imgPath2, 'i')
  await fs.writeFile(filePath, 'm')
  await fs.writeFile(voicePath, 'v')
  const qqCalls: Array<{ qq: string; text: string; image?: string; file?: string; voice?: string }> = []
  const groupCalls: Array<{ groupId: string; text: string; file?: string; image?: string; voice?: string }> = []
  const tools = napcatTools({
    status: () => ({ connected: true, url: 'ws://127.0.0.1:3001', lastError: '', receivedCount: 0, repliedCount: 0 }),
    sendToQQ: async (qq, text, opts) => {
      qqCalls.push({ qq, text, image: opts?.image, file: opts?.file, voice: opts?.voice })
      return 'qq-img'
    },
    sendToGroup: async (groupId, text, opts) => {
      groupCalls.push({ groupId, text, file: opts?.file, image: opts?.image, voice: opts?.voice })
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
  // send 带语音(2026-09-22:record 段,发语音条)
  const rV = String(await tool.execute({ action: 'send', user_id: '10001', message: '听我说', voice: voicePath }))
  const nV: number = qqCalls.length
  assert(nV === 4 && qqCalls[3].voice === voicePath, `send 应透传 voice,实际:${JSON.stringify(qqCalls[3])}`)
  assert(rV.includes('含语音'), `send 带语音应回显,实际:${rV}`)
  // send_group 带图片
  const r4 = String(await tool.execute({ action: 'send_group', group_id: '20000', message: '群图', image: imgPath2 }))
  const n4: number = groupCalls.length
  assert(n4 === 1 && groupCalls[0].image === imgPath2, 'send_group 应透传 image')
  assert(r4.includes('含图片'), `send_group 带图应回显,实际:${r4}`)
  // send_group 带语音
  const rGv = String(await tool.execute({ action: 'send_group', group_id: '20000', voice: 'https://example.com/a.mp3' }))
  const nGv: number = groupCalls.length
  assert(nGv === 2 && groupCalls[1].voice === 'https://example.com/a.mp3', 'send_group 应透传 voice(URL)')
  assert(rGv.includes('含语音'), `send_group 带语音应回显,实际:${rGv}`)
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

await test('napcat 工具:zone_post/zone_delete 发说说(可见范围校验+主人确认门,2026-10-28)', async () => {
  const posted: Array<{ content: string; images?: string[]; ugcRight?: number; targetUins?: string[] }> = []
  const deleted: string[] = []
  let confirmed = true
  const tools = napcatTools({
    status: () => ({ connected: true, url: 'ws://127.0.0.1:3001', lastError: '', receivedCount: 0, repliedCount: 0 }),
    sendToQQ: async () => '',
    sendToGroup: async () => '',
    getRecentMessages: () => [],
    getContacts: async () => ({}),
    updateContact: async (p) => ({ qq: p.qq, source: p.source, updatedAt: 0 }),
    sendQzoneMsg: async (content, opts) => {
      posted.push({ content, images: opts?.images, ugcRight: opts?.ugcRight, targetUins: opts?.targetUins })
      return { tid: 'tid-42' }
    },
    deleteQzoneMsg: async (tid) => {
      deleted.push(tid)
    },
  }, { confirmDangerous: async () => confirmed })
  const tool = tools.find((t) => t.name === 'napcat')!
  // 纯文字 + 可见范围透传 + 回显 tid/删除提示
  // (注:assert 是 asserts 守卫,直接比 length 会把后续收窄成字面量报 2367——
  //  与 sent 用例同款,先取 number 局部量再比)
  const r1 = String(await tool.execute({ action: 'zone_post', content: '今天天气真好', ugc_right: 4 }))
  const n1: number = posted.length
  assert(n1 === 1 && posted[0].content === '今天天气真好' && posted[0].ugcRight === 4, 'zone_post 应透传正文与可见范围')
  assert(r1.includes('tid-42') && r1.includes('好友可见') && r1.includes('zone_delete'), `zone_post 应回显 tid 与删除提示,实际:${r1}`)
  // 图片列表(images 与单张 image 并集)+ target_uins(16 部分好友可见)
  const r2 = String(
    await tool.execute({
      action: 'zone_post', content: '带图动态', images: ['https://img.example/a.png'], image: 'https://img.example/b.png',
      ugc_right: 16, target_uins: ['10001', '10002'],
    }),
  )
  const n2: number = posted.length
  assert(
    n2 === 2 && posted[1].images?.length === 2 && posted[1].ugcRight === 16 && posted[1].targetUins?.join(',') === '10001,10002',
    `zone_post 应透传图片与权限对象,实际:${JSON.stringify(posted[1])}`,
  )
  assert(r2.includes('部分好友可见') && r2.includes('含图片×2'), `zone_post 应回显可见范围与图片数,实际:${r2}`)
  // 纯图片说说(message 作为正文别名)
  const r3 = String(await tool.execute({ action: 'zone_post', message: '只发图', image: 'https://img.example/c.png' }))
  const n3: number = posted.length
  assert(n3 === 3 && posted[2].content === '只发图' && posted[2].ugcRight === 1, `zone_post 应收 message 别名并缺省所有人可见,实际:${r3}`)
  // 参数校验:正文/图片至少一个、图片存在性、ugc_right 合法域、16/128 必须给 target_uins
  await assertRejects(() => tool.execute({ action: 'zone_post' }), '至少一个')
  await assertRejects(() => tool.execute({ action: 'zone_post', content: 'x', image: 'D:/nope/not-exist.png' }), '图片不存在')
  await assertRejects(() => tool.execute({ action: 'zone_post', content: 'x', ugc_right: 2 }), 'ugc_right 仅支持')
  await assertRejects(() => tool.execute({ action: 'zone_post', content: 'x', ugc_right: 128 }), 'target_uins')
  // 主人确认门:拒绝则不发
  confirmed = false
  const cancelled = String(await tool.execute({ action: 'zone_post', content: '不该发出去' }))
  const n4: number = posted.length
  assert(cancelled.includes('已取消') && n4 === 3, `主人未确认不应发表,实际:${cancelled}`)
  // zone_delete:透传 tid + 确认门 + 缺参拒绝
  confirmed = true
  const rDel = String(await tool.execute({ action: 'zone_delete', tid: 'tid-42' }))
  const d1: number = deleted.length
  assert(d1 === 1 && deleted[0] === 'tid-42', 'zone_delete 应透传 tid')
  assert(rDel.includes('已删除'), `zone_delete 应回显,实际:${rDel}`)
  await assertRejects(() => tool.execute({ action: 'zone_delete' }), 'zone_delete 需要 tid')
  confirmed = false
  const delCancelled = String(await tool.execute({ action: 'zone_delete', tid: 'tid-42' }))
  const d2: number = deleted.length
  assert(delCancelled.includes('已取消') && d2 === 1, `主人未确认不应删除,实际:${delCancelled}`)
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

await test('napcatMessageVoices:语音段提取(收语音链路)', () => {
  assert(napcatMessageVoices(null).length === 0, 'null 无语音')
  assert(napcatMessageVoices('文本').length === 0, 'string 无语音')
  const vs = napcatMessageVoices([
    { type: 'text', data: { text: '听这段' } },
    { type: 'record', data: { file: 'abc.voice', url: 'https://gchat.qpic.cn/x.amr' } },
    { type: 'image', data: { file: 'x.png' } },
    { type: 'record', data: { file: 'def.voice' } },
  ])
  assert(vs.length === 2, `应提取 2 条语音,实际 ${vs.length}`)
  assert(vs[0].file === 'abc.voice' && vs[0].url === 'https://gchat.qpic.cn/x.amr', '第一条应带 file 与 url')
  assert(vs[1].file === 'def.voice' && vs[1].url === undefined, '第二条应只带 file')
  assert(napcatMessageVoices([{ type: 'text', data: { text: 'x' } }]).length === 0, '纯文本段无语音')
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
  // 主人窗口标记:显示剥前缀留正文,历史回传保留(LLM 按标记判定身份)
  const win = `${MASTER_WINDOW_MARK}帮我回他一声`
  assert(stripNapcatInstructions(win) === '帮我回他一声', '显示应剥【主人窗口】留正文')
  assert(stripNapcatHistoryInstructions(win) === win, '历史应保留【主人窗口】供身份判定')
  assert(isEmptyNapcatDisplayText('【QQ私聊 · QQ 123 · 魔精】') === true, '仅类别行的注入空壳应判空')
  assert(isEmptyNapcatDisplayText('【QQ私聊 · QQ 123】你好') === false, '有正文不应判空')
  assert(isEmptyNapcatDisplayText('') === true, '空串应判空')
})

// (2026-09-22 归属指纹:extractReplyToStranger/REPLY_TO_STRANGER_MARK 随
// 旧文本协议退役——执行回复的路由由触发侧指令判定 + 判定器安全网决定,
// 【回复对方】残留由 stripFingerprintMarks/stripTurnMarks 剥离)

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
    getGroupList: async () => [{ group_id: '987654', group_name: '测试群' }],
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
  assert(all.includes('10001') && all.includes('20000') && all.includes('你好呀') && all.includes('（提到你）'), `chats 应列全部记录,实际:${all}`)
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
    ) === '（提到你） 在吗[图片][回复]',
    '群消息:@ 机器人标注 + 图片/回复段',
  )
  assert(
    napcatMessageText([{ type: 'at', data: { qq: '123' } }, { type: 'text', data: { text: ' hi' } }], '30000') === '@123 hi',
    '@ 他人标注 QQ 号',
  )
  assert(
    napcatMessageText([{ type: 'at', data: { qq: '123', name: '张三' } }, { type: 'text', data: { text: ' hi' } }], '30000') === '@张三 hi',
    '@ 他人有名字时用名字,不露 QQ 号',
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
  // 连接模式(2026-10-25):反向默认避开 NapCat 正向 3001 端口
  const outRev = String(await tool.execute({ mode: 'reverse' }))
  assert(outRev.includes('反向 WS'), `反向模式应回显,实际:${outRev}`)
  const revPatch = writes.at(-1) as { napcatWsMode?: string; napcatWsUrl?: string }
  assert(revPatch?.napcatWsMode === 'reverse', 'mode 应写入配置')
  assert(revPatch?.napcatWsUrl === 'ws://127.0.0.1:3002', `反向默认应改用 3002,实际:${revPatch?.napcatWsUrl}`)
  await tool.execute({ mode: 'reverse', wsUrl: 'ws://0.0.0.0:4000' })
  const explicit = writes.at(-1) as { napcatWsUrl?: string }
  assert(explicit?.napcatWsUrl === 'ws://0.0.0.0:4000', '显式 wsUrl 不应被覆盖')
  await assertRejects(() => tool.execute({ mode: 'bad' as never }), 'mode 仅支持')
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
  const u3 = parseWsUrl('ws://127.0.0.1:3001?access_token=abc')
  assert(u3.host === '127.0.0.1' && u3.port === 3001 && u3.path === '/?access_token=abc', `access_token 查询串解析,实际:${JSON.stringify(u3)}`)
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

await test('反向 WS 服务端:握手/鉴权/双向收发(2026-10-25)', async () => {
  const events: string[] = []
  const serverMessages: string[] = []
  const server = createReverseWsServer({
    host: '127.0.0.1',
    port: 0,
    path: '/',
    accessToken: 'tok',
    handlers: {
      onOpen: () => events.push('server-open'),
      onMessage: (t) => serverMessages.push(t),
      onError: (m) => events.push(`server-error:${m}`),
      onClose: () => events.push('server-close'),
    },
  })
  server.start()
  await waitFor(() => !!server.address, 5000, '反向服务端应开始监听')
  const port = server.address!.port

  // 错误 token 必须被拒绝(401),不会触发 onOpen
  const badEvents: string[] = []
  createWsSocket(`ws://127.0.0.1:${port}/?access_token=bad`, {
    onOpen: () => badEvents.push('open'),
    onMessage: () => {},
    onError: (m) => badEvents.push(`error:${m}`),
    onClose: () => badEvents.push('close'),
  })
  await waitFor(
    () => badEvents.includes('close') || badEvents.some((e) => e.startsWith('error')),
    5000,
    '错误 token 应被拒绝',
  )
  assert(!badEvents.includes('open'), `错误 token 不应握手成功,实际:${JSON.stringify(badEvents)}`)
  assert(!events.includes('server-close'), '未完成握手的连接不应触发断开回调')

  // 正确 token:客户端连入 → 服务端 onOpen,双向收发
  const clientEvents: string[] = []
  const clientMessages: string[] = []
  const conn = createWsSocket(`ws://127.0.0.1:${port}/?access_token=tok`, {
    onOpen: () => clientEvents.push('open'),
    onMessage: (t) => clientMessages.push(t),
    onError: (m) => clientEvents.push(`error:${m}`),
    onClose: () => clientEvents.push('close'),
  })
  await waitFor(() => clientEvents.includes('open') && events.includes('server-open'), 5000, '反向连接应建立')
  conn.send('from-napcat')
  await waitFor(() => serverMessages.includes('from-napcat'), 5000, '服务端应收到 NapCat 事件')
  server.conn!.send('from-app')
  await waitFor(() => clientMessages.includes('from-app'), 5000, 'NapCat 应收到应用动作/消息')
  conn.close()
  await waitFor(() => events.includes('server-close'), 5000, '反向连接关闭回调')
  server.stop()
  assert(!events.some((e) => e.startsWith('server-error')), `不应有服务端错误,实际:${JSON.stringify(events)}`)
})

await test('wsclient:服务端静默(半开连接)→ 保活超时主动断开(2026-10-23)', async () => {
  // 假 OneBot:完成 101 握手后完全静默——不推送事件、不回 pong
  const net = await import('node:net')
  const crypto = await import('node:crypto')
  const server = net.createServer((sock) => {
    let upgraded = false
    let buf = Buffer.alloc(0)
    sock.on('data', (chunk: Buffer) => {
      if (upgraded) return // 静默丢弃客户端 ping,模拟对端失联
      buf = Buffer.concat([buf, chunk])
      const idx = buf.indexOf('\r\n\r\n')
      if (idx === -1) return
      const req = buf.subarray(0, idx).toString('utf8')
      const key = /Sec-WebSocket-Key:\s*(.+)\r?\n/i.exec(req)?.[1]?.trim() ?? ''
      const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
      sock.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      )
      upgraded = true
      buf = Buffer.alloc(0)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as { port: number }).port
  const events: string[] = []
  const conn = createWsSocket(
    `ws://127.0.0.1:${port}`,
    {
      onOpen: () => events.push('open'),
      onMessage: () => {},
      onError: (m) => events.push(`error:${m}`),
      onClose: () => events.push('close'),
    },
    { keepaliveIntervalMs: 40, keepaliveTimeoutMs: 120 },
  )
  try {
    await waitFor(() => events.includes('open'), 5000, 'WS 握手成功')
    await waitFor(
      () => events.some((e) => e.startsWith('error:连接保活超时')),
      5000,
      '静默连接应被保活超时判定为死链',
    )
    await waitFor(() => events.includes('close'), 5000, '保活超时后应触发 close(交给调用方重连)')
  } finally {
    conn.close()
    server.close()
  }
})

/** 假 OneBot:只做 101 握手(熔断/重连测试用) */
async function listenFakeOneBot(port?: number): Promise<{
  port: number
  upgraded: () => number
  close: () => Promise<void>
}> {
  const net = await import('node:net')
  let upgradedCount = 0
  const sockets = new Set<import('node:net').Socket>()
  const server = net.createServer((sock) => {
    sockets.add(sock)
    sock.on('close', () => sockets.delete(sock))
    let buf = Buffer.alloc(0)
    sock.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk])
      const idx = buf.indexOf('\r\n\r\n')
      if (idx === -1) return
      const req = buf.subarray(0, idx).toString('utf8')
      const key = /Sec-WebSocket-Key:\s*(.+)\r?\n/i.exec(req)?.[1]?.trim() ?? ''
      const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
      sock.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      )
      upgradedCount++
    })
  })
  const bound = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port ?? 0, '127.0.0.1', () => {
      resolve((server.address() as { port: number }).port)
    })
  })
  return {
    port: bound,
    upgraded: () => upgradedCount,
    close: () => new Promise<void>((resolve) => {
      for (const sock of sockets) sock.destroy()
      server.close(() => resolve())
    }),
  }
}

function makeCircuitTestClient(url: string): NapcatClient {
  return createNapcatClient(
    {
      getConfig: () => ({ napcatWsUrl: url, napcatEnabled: true }) as AgentConfig,
      onMessage: () => {},
      onGroupMessage: () => {},
    },
    {
      maxReconnectFails: 3,
      reconnectDelayMs: 20,
      reconnectCapMs: 20,
      circuitCooldownMs: 60,
      circuitCooldownCapMs: 60,
    },
  )
}

await test('napcat 客户端:熔断后 start() 立即重连,旧 socket 迟到 close 不再二次熔断', async () => {
  const placeholder = await listenFakeOneBot()
  const port = placeholder.port
  await placeholder.close()
  const client = makeCircuitTestClient(`ws://127.0.0.1:${port}`)
  let live: Awaited<ReturnType<typeof listenFakeOneBot>> | null = null
  try {
    client.start()
    await waitFor(() => client.status().circuitBroken === true, 8000, '连续失败应进入熔断')
    assert(!client.status().connected, '熔断时不应显示已连接')
    live = await listenFakeOneBot(port)
    client.start()
    await waitFor(() => client.status().connected === true, 8000, 'LLM start 后应连上')
    assert(client.status().circuitBroken !== true, '连上后熔断标志应复位')
    client.start()
    client.start()
    await waitFor(() => client.status().connected === true, 8000, '重复 start 应保持已连接')
    assert(client.status().circuitBroken !== true, '重复 start 不应再次熔断')
  } finally {
    client.stop()
    if (live) await live.close()
  }
})

await test('napcat 客户端:熔断后半开探测在服务端起来后自动恢复', async () => {
  const placeholder = await listenFakeOneBot()
  const port = placeholder.port
  await placeholder.close()
  const client = makeCircuitTestClient(`ws://127.0.0.1:${port}`)
  let live: Awaited<ReturnType<typeof listenFakeOneBot>> | null = null
  try {
    client.start()
    await waitFor(() => client.status().circuitBroken === true, 8000, '连续失败应进入熔断')
    live = await listenFakeOneBot(port)
    await waitFor(() => client.status().connected === true, 8000, '冷却后半开探测应自动连上')
    assert(client.status().circuitBroken !== true, '自动恢复后熔断标志应复位')
  } finally {
    client.stop()
    if (live) await live.close()
  }
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
  assert(isAskTurnToMaster('要不要我说个笑话') === false, '对对方说的「要不要我说」不转给主人')
  assert(isAskTurnToMaster('我建议你回头看看那本书') === false, '「回头」不是回复他,不转给主人')
  assert(isAskTurnToMaster('你说回家吧') === false, '「你说回家」不是在问怎么回')
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

await test('归属指纹:engine.send 带 turnTag → 本轮全部事件附轮次标签(2026-09-22,「指纹对不上就不发送」程序侧基础)', async () => {
  const captured: Array<Record<string, unknown>> = []
  const events: Array<{ type?: string; turnTag?: string }> = []
  const engine = createAgentEngine({
    getConfig: () => ({
      ...MOCK_PROVIDERS,
      apiKey: 'k',
      baseURL: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
      systemPrompt: '',
      reasoningEffort: 'high',
      mcpServers: [],
      skillsDirs: [],
    }),
    onEvent: (e) => events.push(e as { type?: string; turnTag?: string }),
    onSwitchToMusic: () => {},
    getMemoryStore: () => null,
  })
  const origFetch = globalThis.fetch
  globalThis.fetch = budgetSseServer(captured, null)
  try {
    engine.send('你好', [], 's-test', 'private:222', 'TAG123')
    await waitFor(() => events.some((e) => e.type === 'message'), 8000, '回复应落定')
    const landed = events.filter((e) => e.type === 'message')
    assert(landed.length > 0 && landed.every((e) => e.turnTag === 'TAG123'), `message 事件应带 turnTag=TAG123,实际:${JSON.stringify(landed.map((e) => e.turnTag))}`)
    assert(events.some((e) => e.type === 'text-delta' && e.turnTag === 'TAG123'), '流式事件同附 turnTag')
    assert(events.some((e) => e.type === 'status' && e.turnTag === 'TAG123'), 'status 事件同附 turnTag')
  } finally {
    globalThis.fetch = origFetch
    engine.dispose()
  }
})

await test('归属指纹:proactiveTurn 不带 turnTag + 无标签 send 事件标签为空(系统轮永不路由)', async () => {
  const events: Array<{ type?: string; turnTag?: string }> = []
  const engine = createAgentEngine({
    getConfig: () => ({
      ...MOCK_PROVIDERS,
      apiKey: 'k',
      baseURL: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
      systemPrompt: '',
      reasoningEffort: 'high',
      mcpServers: [],
      skillsDirs: [],
    }),
    onEvent: (e) => events.push(e as { type?: string; turnTag?: string }),
    onSwitchToMusic: () => {},
    getMemoryStore: () => null,
  })
  const origFetch = globalThis.fetch
  globalThis.fetch = budgetSseServer([], null)
  try {
    engine.send('你好', [], undefined, 'main')
    await waitFor(() => events.some((e) => e.type === 'message'), 8000, '回复应落定')
    assert(events.filter((e) => e.type === 'message').every((e) => !e.turnTag), '无标签 send 的事件不应带 turnTag')
    events.length = 0
    engine.proactiveTurn([], { hint: '测试' })
    await waitFor(() => events.some((e) => e.type === 'message'), 8000, '主动轮应落定')
    assert(events.every((e) => !e.turnTag), '主动轮事件不应带 turnTag(永不路由)')
  } finally {
    globalThis.fetch = origFetch
    engine.dispose()
  }
})

// (extractTurnFingerprint 文本门控 2026-09-22 随旧协议退役——「指纹对不上
// 就不发送」语义迁到程序侧 turnTag 核对:事件元数据 turnTag 与 route
// 不符 = 陈旧/跨轮投递,handleEngineMessageForNapcat 直接扣留,LLM
// 不写不读标记;见 newTurnFingerprint 与主进程落定路由)

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

// (extractMasterFingerprint 主人文本门控 2026-09-22 随双指纹协议退役——
// 回复归属由触发来源决定,不再要求 LLM 带【主人指纹:xxx】)

await test('stripFingerprintMarks:发送边界残留标记清洗(2026-09-22 归属指纹——旧协议标记物理上到不了任何聊天对象)', () => {
  assert(stripFingerprintMarks('【指纹:A2B3C4】哈哈') === '哈哈', '他人指纹应剥')
  assert(stripFingerprintMarks('【主人指纹:A2B3C4】好的') === '好的', '主人指纹应剥')
  assert(stripFingerprintMarks('【回复对方】哼,刚认识就要赶人家走') === '哼,刚认识就要赶人家走', '旧【回复对方】标记应剥')
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

// (hasTurnMark/hasMasterTurnMark 文本嗅探 2026-09-22 随旧协议退役——
// "发给对方/发给主人"气泡标签由 message-routed 事件按实际送达目的地补标,
// 不再从回复文本检测指纹标记)

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

await test('buildOutgoingMessage:出站消息段组装(text/image/record,语音走 record 段)', () => {
  // 纯文本 → 字符串(零段开销)
  assert(buildOutgoingMessage('你好', []) === '你好', '纯文本应返回字符串')
  // 图文混合 → 段数组,text 在前 image 在后
  const segs = buildOutgoingMessage('看图', ['D:/a.png', 'https://x.com/b.jpg']) as Array<{ type: string; data: Record<string, unknown> }>
  assert(segs.length === 3 && segs[0].type === 'text' && segs[1].type === 'image' && segs[2].type === 'image', `图文段序,实际:${JSON.stringify(segs)}`)
  assert(segs[0].data.text === '看图' && segs[1].data.file === 'D:/a.png', '段内容应透传')
  // 语音 → record 段(file 字段给 NapCat 转 silk)
  const v1 = buildOutgoingMessage('听我说', [], 'D:/hi.amr') as Array<{ type: string; data: Record<string, unknown> }>
  assert(v1.length === 2 && v1[1].type === 'record' && v1[1].data.file === 'D:/hi.amr', `语音应为 record 段,实际:${JSON.stringify(v1)}`)
  // 纯语音(无文本无图)→ 单 record 段
  const v2 = buildOutgoingMessage('', [], 'https://x.com/a.mp3') as Array<{ type: string; data: Record<string, unknown> }>
  assert(v2.length === 1 && v2[0].type === 'record' && v2[0].data.file === 'https://x.com/a.mp3', `纯语音单段,实际:${JSON.stringify(v2)}`)
  // 全混合:段序 text → image → record
  const all = buildOutgoingMessage('来', ['D:/i.png'], 'D:/v.mp3') as Array<{ type: string }>
  assert(all.map((s) => s.type).join(',') === 'text,image,record', `混合段序,实际:${all.map((s) => s.type).join(',')}`)
  // 空 voice 视为无
  assert(Array.isArray(buildOutgoingMessage('x', ['D:/i.png'], '  ')), '空白 voice 应被忽略')
})

await test('napcat 全量适配:at/reply 段 + 视频/文件/转发/卡片解析', () => {
  const segs = buildOutgoingMessage('在吗', [], undefined, { at: '12345', replyTo: '99' }) as Array<{
    type: string
    data: Record<string, unknown>
  }>
  assert(segs.map((s) => s.type).join(',') === 'reply,at,text', `at/reply 段序,实际:${JSON.stringify(segs)}`)
  assert(segs[0].data.id === '99' && segs[1].data.qq === '12345', 'reply/at 参数应透传')
  const atAll = buildOutgoingMessage('集合', [], undefined, { at: 'all' }) as Array<{ type: string; data: Record<string, unknown> }>
  assert(atAll[0].type === 'at' && atAll[0].data.qq === 'all', '@全体 应支持')
  const noSelf = buildOutgoingMessage('@岛灵 在的', [], undefined, { at: ['10009', '10002'], selfQQ: '10009' }) as Array<{
    type: string
    data: Record<string, unknown>
  }>
  assert(noSelf.length === 2 && noSelf[0].type === 'at' && noSelf[0].data.qq === '10002', `艾特段不能带自己,实际:${JSON.stringify(noSelf)}`)
  assert(
    stripSelfMentions('@鲸鱼娘，[CQ:at,qq=10009] @10009 在的呀', '10009') === '在的呀',
    '正文里的自称、自己的 QQ 和 CQ at 都要去掉',
  )
  assert(stripSelfMentions('我是岛灵', '10009') === '我是岛灵', '没有 @ 的自称留着')

  const parsed = napcatMessageText([
    { type: 'file', data: { name: 'a.pdf' } },
    { type: 'video', data: { file: 'v.mp4' } },
    { type: 'forward', data: { id: 'f1' } },
    { type: 'json', data: { data: JSON.stringify({ prompt: '测试卡片' }) } },
  ])
  assert(
    parsed.includes('[文件:a.pdf]') && parsed.includes('[视频]') && parsed.includes('[转发消息]') && parsed.includes('[卡片:测试卡片]'),
    `文件/视频/转发/卡片标注,实际:${parsed}`,
  )

  const videos = napcatMessageVideos([{ type: 'video', data: { file: 'v.mp4', file_id: 'vid1', url: 'https://x/v.mp4' } }])
  assert(videos.length === 1 && videos[0].file_id === 'vid1' && videos[0].url === 'https://x/v.mp4', '视频段提取')
  const files = napcatMessageFiles([{ type: 'file', data: { file_id: 'fid', name: 'r.pdf', file_size: 2048 } }])
  assert(files.length === 1 && files[0].file_id === 'fid' && files[0].size === 2048, '文件段提取')
  const fids = napcatMessageForwardIds([{ type: 'forward', data: { id: 'f1' } }])
  assert(fids.length === 1 && fids[0] === 'f1', '合并转发 ID 提取')
  const rid = napcatMessageReplyId([{ type: 'reply', data: { id: 'm99' } }, { type: 'text', data: { text: 'x' } }])
  assert(rid === 'm99', '引用消息 ID 提取')

  const ft = napcatForwardText({
    messages: [{ sender: { nickname: '甲', user_id: 1 }, content: [{ type: 'text', data: { text: '你好' } }] }],
  })
  assert(ft.includes('甲(1)') && ft.includes('你好'), `合并转发展开,实际:${ft}`)
  const nodes = buildForwardNodes(['a', 'b', ''], '30000')
  assert(nodes.length === 2 && nodes[0].data.uin === '30000', '合并转发节点构建')

  // 合并转发媒体资源提取(2026-10-27:不再只有 [图片] 占位,带出真实资源)
  const fm = napcatForwardMedia({
    messages: [
      {
        sender: { nickname: '甲', user_id: 1 },
        content: [
          { type: 'text', data: { text: '看图' } },
          { type: 'image', data: { file: 'a.jpg', url: 'https://x/a.jpg' } },
          { type: 'image', data: { file: 'a.jpg', url: 'https://x/a.jpg' } },
          { type: 'record', data: { file: 'v.amr' } },
          { type: 'video', data: { file_id: 'vid1' } },
          { type: 'file', data: { file_id: 'fid1', name: 'r.pdf' } },
          { type: 'forward', data: { id: 'nf1' } },
        ],
      },
      // CQ 字符串形态的节点正文也要能提取资源
      { content: '[CQ:image,url=https://y/b.png,file=b.png]' },
    ],
  })
  assert(fm.images.length === 2 && fm.images[0].url === 'https://x/a.jpg', `转发图片资源提取+去重,实际:${JSON.stringify(fm.images)}`)
  assert(fm.images[1].url === 'https://y/b.png', `CQ 字符串节点图片提取,实际:${JSON.stringify(fm.images)}`)
  assert(fm.voices.length === 1 && fm.videos.length === 1 && fm.files.length === 1, '转发语音/视频/文件资源提取')
  const nested = napcatForwardNestedIds({
    messages: [{ content: [{ type: 'forward', data: { id: 'nf1' } }, { type: 'forward', data: { id: 'nf2' } }] }],
  })
  assert(nested.join(',') === 'nf1,nf2', `嵌套合并转发 ID 提取,实际:${nested}`)
  const emptyFm = napcatForwardMedia({ messages: [{ content: [{ type: 'image', data: {} }] }] })
  assert(emptyFm.images.length === 0, '无 file/url 的图片段应丢弃')
})

await test('QQ小程序/分享/音乐卡片结构化读取(2026-10-25)', () => {
  const miniapp = cardLabel({
    data: JSON.stringify({
      app: 'com.tencent.miniapp_01',
      desc: 'QQ小程序',
      meta: {
        detail_1: {
          appid: '1109937557',
          desc: '哔哩哔哩',
          sceneDesc: '哔哩哔哩',
          qqdocurl: 'https://b23.tv/abc?share_medium=android&amp;share_source=qq',
          title: '这个视频真好看',
        },
      },
      prompt: '[QQ小程序]哔哩哔哩',
      view: 'view_8C8E89B49BE609866298ADDFF2DBABA4',
    }),
  })
  assert(miniapp.startsWith('[QQ小程序:哔哩哔哩'), `小程序应用名应做主标题,实际:${miniapp}`)
  assert(
    miniapp.includes('这个视频真好看') && miniapp.includes('https://b23.tv/abc?share_medium=android&share_source=qq'),
    `小程序标题与深链(实体解码),实际:${miniapp}`,
  )

  const share = cardLabel({
    data: JSON.stringify({
      app: 'com.tencent.structmsg',
      meta: { news: { title: '新闻标题', desc: '新闻摘要', jumpUrl: 'https://news.qq.com/a' } },
      prompt: '[分享]新闻标题',
    }),
  })
  assert(
    share.startsWith('[分享卡片:新闻标题') && share.includes('新闻摘要') && share.includes('https://news.qq.com/a'),
    `分享卡片标题/摘要/链接,实际:${share}`,
  )

  const music = cardLabel({
    data: JSON.stringify({
      app: 'com.tencent.music.lua',
      meta: { music: { title: '晴天', desc: '周杰伦', musicUrl: 'https://y.qq.com/n/ryqq/songDetail/1' } },
      prompt: '[分享]晴天',
    }),
  })
  assert(
    music.startsWith('[音乐卡片:晴天') && music.includes('周杰伦') && music.includes('https://y.qq.com'),
    `音乐卡片歌名/歌手/地址,实际:${music}`,
  )

  const xml = cardLabel({
    data:
      '<msg serviceID="1" brief="[QQ小程序]哔哩哔哩" url="https://b23.tv/xml">' +
      '<item><title>XML 视频</title><summary>XML 摘要</summary></item>' +
      '<source name="哔哩哔哩"/></msg>',
  })
  assert(
    xml.startsWith('[QQ小程序:哔哩哔哩') && xml.includes('XML 视频') && xml.includes('XML 摘要') && xml.includes('https://b23.tv/xml'),
    `XML 小程序卡片,实际:${xml}`,
  )

  // double-encoded JSON 与简单 prompt 卡片向后兼容
  const twice = cardLabel({ data: JSON.stringify(JSON.stringify({ prompt: '测试卡片' })) })
  assert(twice === '[卡片:测试卡片]', `double-encoded JSON 兼容,实际:${twice}`)
  assert(cardLabel(undefined) === '[卡片]' && cardLabel({}) === '[卡片]', '空卡片回退')

  // CQ 字符串形态([CQ:json,data=...],方括号/逗号被转义)与段数组同解析
  const cq = napcatMessageText(
    '[CQ:json,data={"app":"com.tencent.miniapp_01","desc":"QQ小程序","meta":{"detail_1":{"sceneDesc":"哔哩哔哩","title":"CQ 视频","qqdocurl":"https://b23.tv/cq"}},"prompt":"&#91;QQ小程序&#93;哔哩哔哩"}]',
  )
  assert(
    cq.startsWith('[QQ小程序:哔哩哔哩') && cq.includes('CQ 视频') && cq.includes('https://b23.tv/cq'),
    `CQ 字符串卡片结构化,实际:${cq}`,
  )
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

// ---------------------------------------------------------------------------
// 米家智能家居(2026-09-22):协议字节向量 / 友名映射 / 凭证存储
// ---------------------------------------------------------------------------

await test('mijia 云签名:nonce / signed_nonce / signature 固定向量', () => {
  // 向量自算钉回归(rand=01..08、nowMs=1758508800000 → 分钟数 29308480)
  const nonce = makeNonce(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), 1758508800000)
  assert(nonce === 'AQIDBAUGBwgBvzZA', `nonce 应为固定向量,实际 ${nonce}`)
  const ssecurity = 'ABEiM0RVZneImaq7zN3u/w==' // 00112233445566778899aabbccddeeff 的 base64
  const sn = computeSignedNonce(ssecurity, nonce)
  assert(sn === 'n2XFg+iVssDlZdRRdhMmgjjUBnZv/5y5DjTGqVAFT/g=', `signed_nonce 不符,实际 ${sn}`)
  const sig = computeSignature(sn, 'POST', 'https://api.io.mi.com/app/v2/home/home_device_list', { data: '{"fg":true}' })
  assert(sig === 'N2dlh72+cgQcocsvk/MsY9xgeuo=', `signature 不符,实际 ${sig}`)
  // path 变换:去 /app/(region 域名同样适用)
  const sig2 = computeSignature(sn, 'post', 'https://de.api.io.mi.com/app/v2/x', {})
  assert(typeof sig2 === 'string' && sig2.length === 28, 'region URL 签名应可用')
})

await test('mijia RC4:经典向量 + 1024 跳流往返', () => {
  // 经典 RC4 已知答案(Wikipedia RC4 条目;跳流 = 0)独立验证手写实现
  const hex = (s: string) => Buffer.from(s, 'utf8')
  const k1 = Buffer.from(rc4Crypt(hex('Key'), hex('Plaintext'))).toString('hex').toUpperCase()
  assert(k1 === 'BBF316E8D940AF0AD3', `RC4(Key,Plaintext) 应为 BBF316E8D940AF0AD3,实际 ${k1}`)
  const k2 = Buffer.from(rc4Crypt(hex('Wiki'), hex('pedia'))).toString('hex').toUpperCase()
  assert(k2 === '1021BF0420', `RC4(Wiki,pedia) 应为 1021BF0420,实际 ${k2}`)
  // 云 API 语义:密钥 = b64d(signed_nonce),丢 1024 密钥流,加解密对称
  const sn = 'n2XFg+iVssDlZdRRdhMmgjjUBnZv/5y5DjTGqVAFT/g='
  const cipher = encryptParam(sn, '米家 hello 云 ✓')
  assert(!cipher.includes('米家'), '密文不应含明文')
  assert(decryptParam(sn, cipher) === '米家 hello 云 ✓', 'RC4 跳流往返应还原')
})

await test('mijia generateEncParams:字段齐全 + rc4_hash__ 双签顺序', () => {
  const url = 'https://api.io.mi.com/app/v2/home/home_device_list'
  const ssecurity = 'ABEiM0RVZneImaq7zN3u/w=='
  const nonce = 'AQIDBAUGBwgBvzZA'
  const sn = computeSignedNonce(ssecurity, nonce)
  const dataJson = '{"fg":true}'
  const fields = generateEncParams({ url, method: 'POST', signedNonce: sn, nonce, dataJson, ssecurity })
  assert(fields.data && fields.rc4_hash__ && fields.signature && fields.ssecurity && fields._nonce, '五字段齐全')
  assert(fields.ssecurity === ssecurity, 'ssecurity 原样发送')
  assert(fields._nonce === nonce, '_nonce 原样发送')
  assert(!('signed_nonce' in fields), 'signed_nonce 本体不发送')
  assert(decryptParam(sn, fields.data) === dataJson, 'data 解密应回原文')
  // ① rc4_hash__ 明文 = 仅对明文 data 的签名(双签第一段)
  const firstSig = computeSignature(sn, 'POST', url, { data: dataJson })
  assert(decryptParam(sn, fields.rc4_hash__) === firstSig, `rc4_hash__ 应为明文签名,实际 ${decryptParam(sn, fields.rc4_hash__)}`)
  // ② signature = 对密文 data + 密文 rc4_hash__(插入序)的签名(双签第二段)
  const secondSig = computeSignature(sn, 'POST', url, { data: fields.data, rc4_hash__: fields.rc4_hash__ })
  assert(fields.signature === secondSig, `signature 应为密文签名,实际 ${fields.signature}`)
})

await test('mijia getHome/home_device_list:home_owner 取 uid 字段(空串=云 no permit 根因)', async () => {
  // mock 云:从请求 query 复算 signed_nonce 加密响应,并解开 data 记录载荷
  const requests: Array<{ path: string; data: Record<string, unknown> }> = []
  const fetchImpl = (async (url: string) => {
    const u = new URL(String(url))
    const p = u.pathname.replace('/app', '')
    const sn = computeSignedNonce(u.searchParams.get('ssecurity')!, u.searchParams.get('_nonce')!)
    requests.push({ path: p, data: JSON.parse(decryptParam(sn, u.searchParams.get('data')!)) })
    const body =
      p === '/v2/homeroom/gethome'
        ? {
            code: 0,
            result: {
              // 实测真实字段名:主人 UID 在 `uid`(无 owner_uid/owner)
              homelist: [{ id: '340001811966', name: '爱炸鱼的小御坂的家', uid: 2934418197, roomlist: [{ id: 1, name: '客厅' }] }],
              share_home: [],
            },
          }
        : { code: 0, result: { device_info: [{ did: 'd1', model: 'dmaker.fan.p28', name: '循环扇', isOnline: true }] } }
    return { ok: true, status: 200, text: async () => encryptParam(sn, JSON.stringify(body)) }
  }) as unknown as typeof fetch
  const cloud = createMijiaCloud({ fetchImpl })
  const creds = {
    userId: '2934418197',
    cUserId: 'c1',
    ssecurity: 'ABEiM0RVZneImaq7zN3u/w==',
    serviceToken: 'svc',
    deviceId: 'aabbccddeeff0011',
    region: 'cn' as const,
  }
  const homes = await cloud.getHome(creds)
  assert(homes.length === 1 && homes[0].id === '340001811966', `应解析出 1 个家:${JSON.stringify(homes)}`)
  assert(homes[0].owner === '2934418197', `owner 应取 uid 字段(回归:no owner → home_owner 空串 → 云 no permit),实际「${homes[0].owner}」`)
  assert(homes[0].rooms.length === 1 && homes[0].rooms[0].name === '客厅', 'roomlist 应解析为房间')
  const devs = await cloud.homeDeviceList(creds, { id: homes[0].id, owner: homes[0].owner })
  assert(devs.length === 1 && devs[0].did === 'd1', `应解析出设备:${JSON.stringify(devs)}`)
  const devReq = requests.find((r) => r.path === '/v2/home/home_device_list')!
  assert(devReq.data.home_owner === '2934418197' && devReq.data.home_id === '340001811966', `home_owner/home_id 应为 uid 串,实际:${JSON.stringify(devReq.data)}`)
  // owner 解析不到时兜底登录 userId(空串会判 no permit)
  await cloud.homeDeviceList(creds, { id: 'h9', owner: '' })
  const last = requests[requests.length - 1]
  assert(last.data.home_owner === '2934418197', `owner 空应兜底 userId,实际:${JSON.stringify(last.data)}`)
})

await test('mijia LAN:key/iv/cipher/checksum 固定向量 + 组包解析往返', () => {
  const token = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
  const { key, iv } = deriveLanKey(token)
  assert(key.toString('hex') === '6e8311168ee16d6aa1aa48c64145003c', `lan key 不符,实际 ${key.toString('hex')}`)
  assert(iv.toString('hex') === '6f434fa9acd75da73e5fb999f641cda2', `lan iv 不符,实际 ${iv.toString('hex')}`)
  const json = '{"id":1,"method":"miIO.info","params":[]}'
  const cipher = encryptLanPayload(token, json)
  assert(
    cipher.toString('hex') === 'a5516ec6151955dc2bb2d43e7c84c18352a39a7f22fd2903d282a5783c6d56acd8b5de0116c0ebf35983dd023f849c97',
    `lan cipher 不符,实际 ${cipher.toString('hex')}`,
  )
  assert(decryptLanPayload(token, cipher) === json, 'lan payload 往返应还原(含 NUL 终结符语义)')
  const pkt = buildLanPacket(token, 0x11223344, 1758508800, cipher)
  assert(pkt.length === 80 && pkt.readUInt16BE(0) === 0x2131 && pkt.readUInt16BE(2) === 80, '包头 magic/len')
  const md5 = createHash('md5').update(pkt.subarray(0, 16)).update(token).update(cipher).digest('hex')
  assert(md5 === '1c8b243a921e1150cbae78b71dfd006f', `checksum 公式回归失败,实际 ${md5}`)
  assert(pkt.subarray(16, 32).toString('hex') === md5, 'checksum 应写回头 16..31')
  // 解析往返 + hello 形态
  const parsed = parseLanPacket(pkt)
  assert(parsed?.deviceId === 0x11223344 && parsed.stamp === 1758508800 && parsed.cipher?.length === 48, '数据包解析')
  const hello = Buffer.alloc(32, 0xff)
  hello.writeUInt16BE(0x2131, 0)
  hello.writeUInt16BE(0x0020, 2)
  const helloReply = Buffer.alloc(32, 0)
  helloReply.writeUInt16BE(0x2131, 0)
  helloReply.writeUInt16BE(0x0020, 2)
  helloReply.writeUInt32BE(0x01020304, 8)
  token.copy(helloReply, 16)
  const hp = parseLanPacket(helloReply)
  assert(hp?.token && Buffer.from(hp.token).toString('hex') === token.toString('hex'), 'hello 应答 token @0x10')
  assert(parseLanPacket(Buffer.from('ff00', 'hex')) === null, 'magic 不符应拒')
})

await test('mijia spec:友名映射 精确/裸名/多义/别名/fallback/access', () => {
  const spec: import('../electron/agent/tools/mijia/mijia-spec').MiotInstanceSpec = {
    type: 'urn:miot-spec-v2:device:light:00000000:test-light:1',
    description: 'Test Light',
    services: [
      {
        iid: 2,
        type: 'urn:miot-spec-v2:service:light:00007802:test-light:1',
        description: 'Light',
        properties: [
          { piid: 1, type: 'urn:miot-spec-v2:property:on:00000006:test-light:1', description: 'Switch Status', format: 'bool', access: ['read', 'write', 'notify'] },
          { piid: 2, type: 'urn:miot-spec-v2:property:brightness:0000000D:test-light:1', description: 'Brightness', format: 'uint8', access: ['read', 'write'], valueRange: [1, 100, 1] },
          { piid: 3, type: 'urn:miot-spec-v2:property:temperature:00000020:test-light:1', description: 'Temperature', format: 'float', access: ['read'] },
        ],
        actions: [{ aiid: 1, type: 'urn:miot-spec-v2:action:toggle:00002801:test-light:1', description: 'Toggle', in: [], out: [] }],
      },
      {
        iid: 3,
        type: 'urn:miot-spec-v2:service:environment:0000780A:test-light:1',
        description: 'Environment',
        properties: [
          { piid: 1, type: 'urn:miot-spec-v2:property:temperature:00000020:test-light:1', description: 'Temperature', format: 'float', access: ['read'] },
        ],
        actions: [],
      },
    ],
  }
  const svc = createMijiaSpec()
  // ① service:member 精确
  const r1 = svc.resolve(spec, 'light:on', 'write')
  assert(!('error' in r1) && r1.kind === 'property' && r1.siid === 2 && r1.piid === 1, `light:on 应命中 siid2/piid1,实际 ${JSON.stringify(r1)}`)
  // ② 别名:power|开关 → on;亮度 → brightness
  const r2 = svc.resolve(spec, 'power', 'write')
  assert(!('error' in r2) && r2.kind === 'property' && r2.piid === 1, 'power 应归一到 on')
  const r3 = svc.resolve(spec, '亮度', 'write')
  assert(!('error' in r3) && r3.kind === 'property' && r3.piid === 2, '亮度应归一到 brightness')
  // ③ 裸名唯一命中 vs 多义报错
  const r4 = svc.resolve(spec, 'brightness', 'read')
  assert(!('error' in r4) && r4.kind === 'property' && r4.piid === 2, '裸名唯一命中')
  const r5 = svc.resolve(spec, 'temperature', 'read')
  assert('error' in r5 && r5.error.includes('多个含义'), `temperature 多义应报错,实际 ${JSON.stringify(r5)}`)
  // ④ 动作 / 错配
  const r6 = svc.resolve(spec, 'light:toggle', 'invoke')
  assert(!('error' in r6) && r6.kind === 'action' && r6.siid === 2 && r6.aiid === 1, '动作应命中')
  const r7 = svc.resolve(spec, 'light:on', 'invoke')
  assert('error' in r7, '属性当动作应报错')
  const r8 = svc.resolve(spec, 'light:temperature', 'write')
  assert('error' in r8 && r8.error.includes('只读'), '只读属性写应报错')
  // ⑤ fallback:model 含 light 才有;成员受限
  assert(svc.fallbackFor('yeelink.light.lamp1', 'brightness', 'write') != null, 'light fallback 应可用')
  assert(svc.fallbackFor('zhimi.fan.za4', 'on', 'write') === null, '非 light 无 fallback')
  const fb = svc.fallbackFor('yeelink.light.lamp1', 'nosuch', 'write')
  assert(fb != null && 'error' in fb, 'fallback 未知名应报错')
  assert(FALLBACK_LIGHT.on.siid === 2 && shortName(spec.services[0].type, '') === 'light', '短名解析')
})

await test('mijia store:加密往返 + 不可加密绝不落明文', async () => {
  const dir = path.join(tmp, 'mijia-store-test')
  await fs.mkdir(dir, { recursive: true })
  const b64 = (s: string) => MIJIA_SECRET_PREFIX + Buffer.from(s, 'utf8').toString('base64')
  const unb64 = (s: string) =>
    s.startsWith(MIJIA_SECRET_PREFIX) ? Buffer.from(s.slice(MIJIA_SECRET_PREFIX.length), 'base64').toString('utf8') : null
  const store = createMijiaStore({
    encrypt: b64,
    decrypt: unb64,
    userDataPath: () => dir,
    now: () => 42,
  })
  const auth: MijiaAuth = {
    userId: 'u1',
    cUserId: 'c1',
    ssecurity: 'SUPER-SECRET-SSEC',
    passToken: 'SUPER-SECRET-PASS',
    serviceToken: 'SUPER-SECRET-SVC',
    region: 'cn',
    deviceId: 'aabbccddeeff0011',
    updatedAt: 0,
  }
  await store.saveAuth(auth)
  const raw = await fs.readFile(path.join(dir, 'mijia-auth.json'), 'utf8')
  assert(!raw.includes('SUPER-SECRET'), '密文文件不得含任何明文密钥')
  assert(raw.includes(MIJIA_SECRET_PREFIX), '密钥字段应带 enc:v1: 前缀')
  const loaded = await store.loadAuth()
  assert(loaded?.ssecurity === 'SUPER-SECRET-SSEC' && loaded.serviceToken === 'SUPER-SECRET-SVC' && loaded.updatedAt === 42, '解密往返')
  // 设备 token 同款加密
  await store.saveDevices([
    { did: 'd1', model: 'yeelink.light.lamp1', name: '台灯', localip: '192.168.1.5', token: 'LAN-TOKEN-SECRET', room: '卧室' },
  ])
  const rawD = await fs.readFile(path.join(dir, 'mijia-devices.json'), 'utf8')
  assert(!rawD.includes('LAN-TOKEN-SECRET'), '设备 token 不得明文落盘')
  const devs = await store.loadDevices()
  assert(devs[0]?.token === 'LAN-TOKEN-SECRET' && devs[0].room === '卧室', '设备缓存往返')
  // 不可加密:密钥字段整个丢弃(文件无明文),本次运行内存保留可用;
  // 重启(重置缓存重读磁盘)后 = 半套凭证 → 视为未登录引导重登
  const store2 = createMijiaStore({
    encrypt: () => null,
    decrypt: unb64,
    userDataPath: () => dir,
    now: () => 42,
  })
  await store2.saveAuth(auth)
  const raw2 = await fs.readFile(path.join(dir, 'mijia-auth.json'), 'utf8')
  assert(!raw2.includes('SUPER-SECRET') && !raw2.includes(MIJIA_SECRET_PREFIX), '不可加密时密钥字段应丢弃')
  assert(store2.didSecretPersist() === false, 'didSecretPersist 应报 false')
  const memAuth = await store2.loadAuth()
  assert(memAuth?.ssecurity === 'SUPER-SECRET-SSEC', '本次运行内存应保留可用')
  store2.resetMijiaStore()
  assert((await store2.loadAuth()) === null, '重启后半套凭证应视为未登录')
})

await test('mijia cloud:登录流 pending→done 落凭证 + 过期换码不落屏', async () => {
  // mock 云:第一次取码 → 长轮询 pending → 第二次取码后 done
  let codeSeq = 0
  let pollSeq = 0
  const updates: Array<{ phase: string; qrText: string; message: string }> = []
  let saved: unknown = null
  const cloud = {
    beginQrLogin: async () => {
      codeSeq++
      return {
        qrImage: `https://account.xiaomi.com/qr/img/${codeSeq}`,
        loginUrl: `https://account.xiaomi.com/qr/login?c=${codeSeq}`,
        lpUrl: `https://account.xiaomi.com/longPolling/p/${codeSeq}`,
        timeoutSec: 300,
      }
    },
    pollQrLogin: async () => {
      pollSeq++
      if (pollSeq === 1) return { status: 'error' as const, message: '二维码已过期:expired' }
      return {
        status: 'done' as const,
        userId: 'u1',
        cUserId: 'c1',
        ssecurity: 's',
        passToken: 'p',
        location: 'https://sts.api.io.mi.com/sts',
      }
    },
    exchangeServiceToken: async () => ({ serviceToken: 'svc-token' }),
    refreshServiceToken: async () => 'svc-token',
    call: async () => ({}),
    homeDeviceList: async () => [],
    getHome: async () => [],
    sceneList: async () => [],
    sceneRun: async () => {},
  }
  const flow = createMijiaLoginFlow({
    cloud: cloud as never,
    onUpdate: (s) => updates.push({ phase: s.phase, qrText: s.qrText, message: s.message }),
    onCredentials: (a) => {
      saved = a
    },
    pollMs: 5,
    ttlSec: 300,
  })
  await flow.start()
  assert(updates[0]?.phase === 'waiting' && updates[0].qrText.includes('c=1'), '首码应展示')
  await waitFor(() => saved != null, 3000, '登录凭证落盘回调')
  const auth = saved as { serviceToken: string; userId: string }
  assert(auth.serviceToken === 'svc-token' && auth.userId === 'u1', '凭证回调内容')
  assert(updates.some((u) => u.phase === 'done'), '应有 done 态')
  // 过期路径:过期码不落屏(占位"正在换新"),随后自动换码
  const expiredShown = updates.some((u) => u.phase === 'waiting' && u.qrText === '' && u.message.includes('换新'))
  assert(expiredShown, `过期码不应落屏,updates=${JSON.stringify(updates)}`)
  flow.stop()
})

await test('mijia cloud:parsePrefixedJson 剥 &&&START&&& 前缀', () => {
  assert(parsePrefixedJson('&&&START&&&{"a":1}')?.a === 1, '前缀应剥离')
  assert(parsePrefixedJson('not json') === null, '非 JSON 应 null')
})

// ---- 米家工具策略(阶段 B):schema 形状 / 来源守卫 / 硬禁 / 未登录话术 ----

await test('mijia 工具 schema:四工具命名/描述/超时档位', () => {
  const tools = createMijiaTools({})
  assert(tools.length === 4, `应 4 个工具,实际 ${tools.length}`)
  const names = tools.map((t) => t.name).join(',')
  assert(names === 'mijia_devices,mijia_control,mijia_scene,mijia_login', `工具名/顺序不符:${names}`)
  const timeouts: Record<string, number> = {}
  for (const t of tools) {
    assert(/^[a-z][a-z0-9_]*$/.test(t.name), `工具名须全小写下划线:${t.name}`)
    assert(/[一-鿿]/.test(t.description), `${t.name} 描述须含中文`)
    assert(t.parameters.type === 'object', `${t.name} parameters 须为 object`)
    timeouts[t.name] = t.timeoutMs ?? 0
  }
  assert(
    timeouts.mijia_devices === 45_000 && timeouts.mijia_control === 30_000 && timeouts.mijia_scene === 30_000 && timeouts.mijia_login === 20_000,
    `超时档位应为 45k/30k/30k/20k,实际 ${JSON.stringify(timeouts)}`,
  )
})

await test('mijia 写守卫:turnKind 八值矩阵 + getTurnSource 兜底', () => {
  // 放行:window/panel/master-qq/master-group(主人 QQ 远程可控)
  for (const k of ['window', 'panel', 'master-qq', 'master-group']) {
    assertMijiaWriteAllowed(k, null) // 不抛即过
  }
  // 拒:别人的轮/系统轮
  for (const k of ['contact', 'group', 'ask', 'silent']) {
    let thrown = ''
    try {
      assertMijiaWriteAllowed(k, 'window')
    } catch (e) {
      thrown = (e as Error).message
    }
    assert(thrown.includes('无权操作米家设备'), `kind=${k} 应拒写,实际:${thrown || '(未抛)'}`)
  }
  // 无 turnKind 时 source 兜底:window/panel 过;qq/group(分不了主人)安全侧拒
  assertMijiaWriteAllowed(null, 'window')
  for (const s of ['qq', 'group', null, undefined]) {
    let thrown = ''
    try {
      assertMijiaWriteAllowed(null, s as string | null)
    } catch (e) {
      thrown = (e as Error).message
    }
    assert(thrown.includes('无权操作米家设备'), `source=${String(s)} 应拒写兜底,实际:${thrown || '(未抛)'}`)
  }
})

await test('mijia 硬禁名单:门锁/摄像头拒写拒动作,开锁类动作名双保险', () => {
  const lockDev = { did: 'l1', model: 'loock.lock.v1' }
  const camDev = { did: 'c1', model: 'chuangmi.camera.ipc019' }
  const lightDev = { did: 'd1', model: 'yeelink.light.lamp1' }
  assert(classifyForbiddenDevice(lockDev) === 'lock', '门锁分类')
  assert(classifyForbiddenDevice(camDev) === 'camera', '摄像头分类')
  assert(classifyForbiddenDevice(lightDev) === null, '灯无禁控')
  assertMijiaDeviceAllowed(lockDev, 'read') // 读放行
  assertMijiaDeviceAllowed(lightDev, 'write')
  let msg = ''
  try {
    assertMijiaDeviceAllowed(lockDev, 'invoke', 'open')
  } catch (e) {
    msg = (e as Error).message
  }
  assert(msg.includes('门锁'), `门锁动作应拒:${msg}`)
  msg = ''
  try {
    assertMijiaDeviceAllowed(camDev, 'write')
  } catch (e) {
    msg = (e as Error).message
  }
  assert(msg.includes('摄像头'), `摄像头写应拒:${msg}`)
  // 动作名含开锁/unlock:即使设备未标注也拒(双保险)
  for (const name of ['unlock', '开锁', '开门', 'door-open-unlock']) {
    msg = ''
    try {
      assertMijiaDeviceAllowed(lightDev, 'invoke', name)
    } catch (e) {
      msg = (e as Error).message
    }
    assert(msg.includes('开锁/开门类动作'), `动作名 ${name} 应拒:${msg}`)
  }
})

await test('mijia 工具执行:未登录话术含 mijia_login;login 写守卫;logout 清凭证', async () => {
  let cleared = 0
  let opened = 0
  const emptyStore = {
    loadAuth: async () => null,
    saveAuth: async () => {},
    clearAuth: async () => {
      cleared++
    },
    loadDevices: async () => [],
    saveDevices: async () => {},
    resetMijiaStore: () => {},
    didSecretPersist: () => true,
  }
  const tools = createMijiaTools({
    store: emptyStore as never,
    getTurnKind: () => 'window',
    openLogin: () => {
      opened++
    },
  })
  const login = tools.find((t) => t.name === 'mijia_login')!
  const devices = tools.find((t) => t.name === 'mijia_devices')!
  const outStatus = String(await login.execute({ action: 'status' }))
  assert(outStatus.includes('未登录') && outStatus.includes('mijia_login'), `未登录话术应引导 mijia_login:${outStatus}`)
  const outDevices = String(await devices.execute({ action: 'list' }))
  assert(outDevices.includes('mijia_login'), `devices 未登录话术:${outDevices}`)
  // login 过写守卫并触发窗口
  const outLogin = String(await login.execute({ action: 'login' }))
  assert(outLogin.includes('已打开') && opened === 1, `login 应开窗:${outLogin}`)
  // logout 清凭证
  const outLogout = String(await login.execute({ action: 'logout' }))
  assert(outLogout.includes('退出') && cleared === 1, 'logout 应清凭证')
  // 别人的轮 login 应拒
  const tools2 = createMijiaTools({ store: emptyStore as never, getTurnKind: () => 'contact', openLogin: () => {} })
  await assertRejects(() => tools2.find((t) => t.name === 'mijia_login')!.execute({ action: 'login' }), '无权操作米家设备', 'contact 轮 login 应拒')
  // status 读全放(contact 轮可查)
  const out2 = String(await tools2.find((t) => t.name === 'mijia_login')!.execute({ action: 'status' }))
  assert(out2.includes('未登录'), 'contact 轮 status 应放行')
})

await test('mijia_control:miotspec 响应 result 数组解析(修「成功误报 code=- 失败」)', async () => {
  // 实测响应结构(2026-09-22):result **直接是数组** [{did,iid,siid,piid,value,code}]
  // ——旧解析读 result.props 恒空,成功也报「设置失败 code=-」→ LLM 误判登录失效反复重验
  const specFixture: MiotInstanceSpec = {
    type: 'urn:miot-spec-v2:device:fan:0000A005:dmaker-p28:1',
    description: 'Fan',
    services: [
      {
        iid: 2,
        type: 'urn:miot-spec-v2:service:fan:00007808:dmaker-p28:1',
        description: 'Fan',
        properties: [
          { piid: 1, type: 'urn:miot-spec-v2:property:on:00000006:dmaker-p28:1', description: 'Switch Status', format: 'bool', access: ['read', 'write'] },
          { piid: 2, type: 'urn:miot-spec-v2:property:fan-level:00000021:dmaker-p28:1', description: 'Fan Level', format: 'uint8', access: ['read', 'write'], valueRange: [1, 4, 1] },
        ],
        actions: [],
      },
    ],
  }
  const auth = {
    userId: 'u1', cUserId: 'c1', ssecurity: 's', passToken: 'p', serviceToken: 'svc',
    region: 'cn' as const, deviceId: 'aabbccddeeff0011', updatedAt: 1,
  }
  const fanDev = { did: '921838861', model: 'dmaker.fan.p28', name: '循环扇', isOnline: true }
  const storeStub = {
    loadAuth: async () => auth, saveAuth: async () => {}, clearAuth: async () => {},
    loadDevices: async () => [fanDev], saveDevices: async () => {},
    resetMijiaStore: () => {}, didSecretPersist: () => true,
  }
  const calls: Array<{ path: string; data: Record<string, unknown> }> = []
  const cloudStub = {
    beginQrLogin: async () => ({ qrImage: '', loginUrl: '', lpUrl: '', timeoutSec: 300 }),
    pollQrLogin: async () => ({ status: 'pending' as const }),
    exchangeServiceToken: async () => ({ serviceToken: '' }),
    refreshServiceToken: async () => '',
    call: async (_c: unknown, path: string, data: Record<string, unknown>) => {
      calls.push({ path, data })
      if (path === '/miotspec/prop/set') {
        return { code: 0, message: 'ok', result: [{ did: '921838861', iid: '0.2.2', siid: 2, piid: 2, code: 0, exe_time: 0 }] }
      }
      // prop/get 按请求顺序逐项返回(顺序对齐 props 数组)
      const req = (data.params ?? []) as Array<{ siid: number; piid: number }>
      return {
        code: 0,
        message: 'ok',
        result: req.map((p) => ({ did: '921838861', iid: `0.${p.siid}.${p.piid}`, siid: p.siid, piid: p.piid, value: p.piid === 2 ? 4 : false, code: 0 })),
      }
    },
    homeDeviceList: async () => [], getHome: async () => [], sceneList: async () => [], sceneRun: async () => {},
  }
  const tools = createMijiaTools({
    store: storeStub as never,
    cloud: cloudStub as never,
    spec: { ...createMijiaSpec(), getInstance: async () => specFixture } as never,
    getTurnKind: () => 'window',
  })
  const control = tools.find((t) => t.name === 'mijia_control')!
  // set 走云(无 LAN):result 数组 code=0 应报成功
  const out = String(await control.execute({ action: 'set', device: '循环扇', set: [{ prop: 'fan-level', value: 4 }] }))
  assert(out.includes('已设置') && out.includes('fan-level=4') && out.includes('通道 cloud'), `result 数组应解析成功:${out}`)
  assert(!out.includes('code=-') && !out.includes('设置均失败'), `不应误报失败:${out}`)
  // get 同样按数组解析
  const status = String(await tools.find((t) => t.name === 'mijia_devices')!.execute({ action: 'status', query: '循环扇' }))
  assert(status.includes('fan-level=4'), `get result 数组应解析:${status}`)
  // 逐项失败码应如实报「设备拒绝 code=…」而非空 code=-,且明示与登录无关
  const cloudStub2 = { ...cloudStub, call: async () => ({ code: 0, message: 'ok', result: [{ siid: 2, piid: 2, code: -704220043 }] }) }
  const tools2 = createMijiaTools({
    store: storeStub as never, cloud: cloudStub2 as never,
    spec: { ...createMijiaSpec(), getInstance: async () => specFixture } as never,
    getTurnKind: () => 'window',
  })
  const out2 = String(await tools2.find((t) => t.name === 'mijia_control')!.execute({ action: 'set', device: '循环扇', set: [{ prop: 'fan-level', value: 4 }] }))
  assert(out2.includes('设备拒绝 code=-704220043') && out2.includes('与登录无关'), `失败码应透出且标注非登录问题:${out2}`)
})

await test('mijia_login:已登录时 login 拦下重开扫码窗(修「反复重复验证」),force=true 才放行', async () => {
  const auth = {
    userId: '2934418197', cUserId: 'c1', ssecurity: 's', passToken: 'p', serviceToken: 'svc',
    region: 'cn' as const, deviceId: 'aabbccddeeff0011', updatedAt: 1,
  }
  const open: { n: number } = { n: 0 }
  const storeStub = {
    loadAuth: async () => auth, saveAuth: async () => {}, clearAuth: async () => {},
    loadDevices: async () => [{ did: 'd1', model: 'm', name: '风扇', isOnline: true }], saveDevices: async () => {},
    resetMijiaStore: () => {}, didSecretPersist: () => true,
  }
  const tools = createMijiaTools({
    store: storeStub as never,
    getTurnKind: () => 'window',
    openLogin: () => {
      open.n++
    },
  })
  const login = tools.find((t) => t.name === 'mijia_login')!
  const out = String(await login.execute({ action: 'login' }))
  const n1: number = open.n
  assert(n1 === 0, '已登录时缺省 login 不应开窗')
  assert(out.includes('无需重新扫码') && out.includes('force=true'), `应引导不重验:${out}`)
  const out2 = String(await login.execute({ action: 'login', force: true }))
  const n2: number = open.n
  assert(n2 === 1 && out2.includes('已打开'), 'force=true 应开窗')
  // 未登录时缺省放行
  const storeEmpty = { ...storeStub, loadAuth: async () => null }
  const tools3 = createMijiaTools({ store: storeEmpty as never, getTurnKind: () => 'window', openLogin: () => { open.n++ } })
  const out3 = String(await tools3.find((t) => t.name === 'mijia_login')!.execute({ action: 'login' }))
  const n3: number = open.n
  assert(n3 === 2 && out3.includes('已打开'), '未登录 login 应直接开窗')
})

await test('mijia_control:门锁硬禁/场景开锁名拒 + 灯 set 走 LAN 成功路径', async () => {
  // spec 夹具(与上方 spec 测试同构)
  const specFixture: MiotInstanceSpec = {
    type: 'urn:miot-spec-v2:device:light:00000000:test-light:1',
    description: 'Test Light',
    services: [
      {
        iid: 2,
        type: 'urn:miot-spec-v2:service:light:00007802:test-light:1',
        description: 'Light',
        properties: [
          { piid: 1, type: 'urn:miot-spec-v2:property:on:00000006:test-light:1', description: 'Switch Status', format: 'bool', access: ['read', 'write'] },
          { piid: 2, type: 'urn:miot-spec-v2:property:brightness:0000000D:test-light:1', description: 'Brightness', format: 'uint8', access: ['read', 'write'], valueRange: [1, 100, 1] },
        ],
        actions: [],
      },
    ],
  }
  const realSpec = createMijiaSpec()
  const specStub = { ...realSpec, getInstance: async () => specFixture }
  const auth = {
    userId: 'u1',
    cUserId: 'c1',
    ssecurity: 's',
    passToken: 'p',
    serviceToken: 'svc',
    region: 'cn' as const,
    deviceId: 'aabbccddeeff0011',
    updatedAt: 1,
  }
  const lightDev = { did: 'd1', model: 'yeelink.light.lamp1', name: '台灯', localip: '192.168.1.5', token: '00112233445566778899aabbccddeeff', isOnline: true, room: '卧室' }
  const lockDev = { did: 'l1', model: 'loock.lock.v1', name: '大门锁', isOnline: true }
  const storeStub = {
    loadAuth: async () => auth,
    saveAuth: async () => {},
    clearAuth: async () => {},
    loadDevices: async () => [lightDev, lockDev],
    saveDevices: async () => {},
    resetMijiaStore: () => {},
    didSecretPersist: () => true,
  }
  const setCalls: Array<{ siid: number; piid: number; value: unknown }> = []
  const lanStub = {
    hello: async () => ({ token: new Uint8Array(16), deviceId: 42, stamp: 0 }),
    rpc: async () => ({}),
    getProperties: async () => [{ code: 0, value: true }],
    setProperties: async (_ip: string, _t: string, _d: number, props: Array<{ siid: number; piid: number; value: unknown }>) => {
      setCalls.push(...props)
      return props.map(() => ({ code: 0 }))
    },
    invokeAction: async () => ({ code: 0, out: [] }),
  }
  const cloudStub = {
    beginQrLogin: async () => ({ qrImage: '', loginUrl: '', lpUrl: '', timeoutSec: 300 }),
    pollQrLogin: async () => ({ status: 'pending' as const }),
    exchangeServiceToken: async () => ({ serviceToken: '' }),
    refreshServiceToken: async () => '',
    call: async () => ({ code: 0, result: {} }),
    homeDeviceList: async () => [],
    getHome: async () => [],
    sceneList: async () => [{ id: 's1', name: '回家模式', enable: true, kind: 'manual' as const }, { id: 's2', name: '回家开锁', enable: true, kind: 'manual' as const }],
    sceneRun: async () => {},
  }
  const tools = createMijiaTools({
    store: storeStub as never,
    lan: lanStub as never,
    cloud: cloudStub as never,
    spec: specStub as never,
    getTurnKind: () => 'master-qq', // 主人 QQ 远程
  })
  const control = tools.find((t) => t.name === 'mijia_control')!
  const scene = tools.find((t) => t.name === 'mijia_scene')!
  // 灯 set LAN 成功路径(主人 QQ 远程可控)
  const out = String(await control.execute({ action: 'set', device: '台灯', set: [{ prop: 'on', value: true }, { prop: 'brightness', value: 80 }] }))
  assert(out.includes('已设置') && out.includes('通道 lan'), `灯 set 应走 LAN 成功:${out}`)
  assert(setCalls.length === 2 && setCalls[0].siid === 2 && setCalls[0].piid === 1 && setCalls[0].value === true && setCalls[1].value === 80, `LAN set 参数:${JSON.stringify(setCalls)}`)
  // 门锁 set 硬禁
  await assertRejects(() => control.execute({ action: 'set', device: '大门锁', set: [{ prop: 'on', value: true }] }), '门锁', '门锁 set 应硬禁')
  // 开锁类动作名双保险(灯设备 + unlock 动作名)
  await assertRejects(() => control.execute({ action: 'invoke', device: '台灯', invoke: { prop: 'unlock' } }), '开锁/开门类动作', 'unlock 动作应拒')
  // 亮度超范围报错(LLM 自纠)
  const outBad = await control.execute({ action: 'set', device: '台灯', set: [{ prop: 'brightness', value: 200 }] }).catch((e: Error) => e.message)
  assert(String(outBad).includes('超出范围'), `超范围应报错:${String(outBad)}`)
  // 场景:开锁名拒;正常名过
  await assertRejects(() => scene.execute({ action: 'run', scene: '回家开锁' }), '开锁/开门', '开锁场景名应拒')
  const outScene = String(await scene.execute({ action: 'run', scene: '回家模式' }))
  assert(outScene.includes('已运行场景「回家模式」'), `场景运行:${outScene}`)
})

// ---------------------------------------------------------------------------
// MiMo 专项适配(2026-09-22 官网接入文档:多模态理解 + Batch API)
// ---------------------------------------------------------------------------

await test('sse:Chat Completions 无 type 帧照常产出(2026-09-22 修复回归)', async () => {
  // 实测 MiMo Chat SSE 帧无顶层 type 字段——此前被 parseSse 整帧丢弃,
  // chat 类协议流式恒空文本;修复后无 type 帧以空串事件名产出
  const sseText =
    'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n' +
    'data: {"type":"response.output_text.delta","delta":"!"}\n\n' +
    'data: [DONE]\n\n'
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(sseText))
      c.close()
    },
  })
  const frames: Array<{ type: string; data: Record<string, unknown> }> = []
  for await (const f of parseSse(body, new AbortController().signal)) frames.push(f)
  assert(frames.length === 2, `应产出 2 帧(无 type 帧不再丢弃),实际 ${frames.length}`)
  assert(frames[0].type === '' && Array.isArray(frames[0].data.choices), `chat 帧形状:${JSON.stringify(frames[0])}`)
  assert(frames[1].type === 'response.output_text.delta', `typed 帧事件名透传:${frames[1].type}`)
})

await test('mimo-media:Responses 原生多模态编码(第一优先形状,活体对拍)', async () => {
  const audioPath = path.join(tmp, 'mm-a.mp3')
  const videoPath = path.join(tmp, 'mm-v.mp4')
  await fs.writeFile(audioPath, Buffer.from('fake-mp3'))
  await fs.writeFile(videoPath, Buffer.from('fake-mp4'))
  const dataUrl = 'data:image/png;base64,AAAA'
  const parts = [
    { type: 'text', text: '这是什么' },
    { type: 'media', kind: 'audio', url: audioPath, name: '语音' },
    { type: 'media', kind: 'video', url: videoPath, name: '视频' },
    { type: 'image', dataUrl },
  ] as const
  // Responses 形状(官网 ResponseInputImage/AudioContent/VideoContent,活体实证)
  const content = await mimoResponsesUserContent([...parts], { model: 'mimo-v2.6-pro' })
  assert(Array.isArray(content), '含附件应为 part 数组')
  const items = content as Array<Record<string, unknown>>
  assert(items.length === 4 && items[0].type === 'input_text', `顺序与条数:${JSON.stringify(items.map((i) => i.type))}`)
  const audio = items[1] as { type: string; input_audio: { data: string } }
  assert(audio.type === 'input_audio' && audio.input_audio.data.startsWith('data:audio/mpeg;base64,'), `音频 data URI:${audio.input_audio?.data?.slice(0, 30)}`)
  const video = items[2] as { type: string; input_video: { data?: string; url?: string }; fps: number; media_resolution: string }
  assert(video.type === 'input_video' && String(video.input_video.data ?? '').startsWith('data:video/mp4;base64,'), `视频 input_video.data:${JSON.stringify(video.input_video).slice(0, 40)}`)
  assert(video.fps === 2 && video.media_resolution === 'default', `视频参数(官网默认,活体 Q1 实证):${video.fps}/${video.media_resolution}`)
  const img = items[3] as { type: string; image_url: string }
  assert(img.type === 'input_image' && img.image_url === dataUrl, `图片 image_url 字符串透传:${img.image_url}`)
  // 公网 URL 视频挂 url 字段(活体 P2 实证)
  const urlVideo = (await mimoResponsesContentPart({ type: 'media', kind: 'video', url: 'https://x.cn/a.mp4' })) as { type: string; input_video: { url?: string } }
  assert(urlVideo.type === 'input_video' && urlVideo.input_video.url === 'https://x.cn/a.mp4', `URL 视频挂 url 字段:${JSON.stringify(urlVideo)}`)
  // Chat 兼容形状(显式 chat 地址路径)
  const chatContent = (await mimoUserContent([...parts], { model: 'mimo-v2.6-pro' })) as Array<Record<string, unknown>>
  assert(chatContent[0].type === 'text' && chatContent[2].type === 'video_url', `chat 形状:${JSON.stringify(chatContent.map((i) => i.type))}`)
  // 纯文本历史 → string content(旧形态)
  const textOnly = await mimoUserContent([{ type: 'text', text: '你好' }, { type: 'text', text: '世界' }], { model: 'mimo-v2.6-pro' })
  assert(textOnly === '你好\n世界', `纯文本 string 形态:${JSON.stringify(textOnly)}`)
  assert((await mimoResponsesUserContent([], { model: 'mimo-v2.6-pro' })) === '', '空 parts → 空串')
})

await test('mimo-media:附件降级占位(缺失/格式/模型不支持)+ strict 硬错误', async () => {
  const badExt = path.join(tmp, 'mm-x.xyz')
  await fs.writeFile(badExt, Buffer.from('x'))
  // 文件缺失 → 占位不断整轮(历史韧性)
  const missing = await mimoUserContent(
    [{ type: 'text', text: '听' }, { type: 'media', kind: 'audio', url: path.join(tmp, 'nope.mp3'), name: '语音' }],
    { model: 'mimo-v2.6-pro' },
  )
  assert(typeof missing === 'string' || Array.isArray(missing), '占位仍返回 content')
  assert(JSON.stringify(missing).includes('文件不存在'), `缺失占位原因:${JSON.stringify(missing)}`)
  // 未知格式 → 占位
  const bad = await mimoUserContent([{ type: 'media', kind: 'video', url: badExt }], { model: 'mimo-v2.6-pro' })
  assert(JSON.stringify(bad).includes('不支持的文件格式'), `格式占位原因:${JSON.stringify(bad)}`)
  // 模型不支持多模态(mimo-v2.5-pro 不在官网支持清单)→ 占位,不带媒体 part
  const noCap = await mimoUserContent(
    [{ type: 'media', kind: 'audio', url: path.join(tmp, 'nope.mp3'), name: '语音' }],
    { model: 'mimo-v2.5-pro' },
  )
  assert(JSON.stringify(noCap).includes('不支持多模态') && !JSON.stringify(noCap).includes('input_audio'), `模型能力占位:${JSON.stringify(noCap)}`)
  assert(!mimoSupportsMedia('mimo-v2.5-pro') && mimoSupportsMedia('mimo-v2.6-pro') && mimoSupportsMedia('mimo-v2.5') && mimoSupportsMedia('mimo-v2.7-x'), '多模态能力判定')
  // strict(工具路径)→ 硬错误自纠
  await assertRejects(
    () => mimoMediaPart({ type: 'media', kind: 'audio', url: path.join(tmp, 'nope.mp3'), name: '语音' }, { strict: true }),
    '文件不存在',
  )
  assert(mimoMimeOf('audio', 'a.flac') === 'audio/flac' && mimoMimeOf('video', 'b.webm') === 'video/webm' && mimoMimeOf('img', 'c.txt') === null, 'MIME 判定')
})

await test('mimo-chat:多模态 messages + reasoning/tool 回传(官网多轮规则)', async () => {
  const audioPath = path.join(tmp, 'mm-b.mp3')
  await fs.writeFile(audioPath, Buffer.from('x'))
  const history: AgentMessage[] = [
    {
      id: 'u1',
      role: 'user',
      parts: [{ type: 'text', text: '这是什么声音' }, { type: 'media', kind: 'audio', url: audioPath, name: '语音' }],
    },
    {
      id: 'a1',
      role: 'assistant',
      parts: [
        { type: 'reasoning', text: '思考中' },
        { type: 'text', text: '我听听' },
        { type: 'tool-call', id: 'c1', name: 'exec_command', args: { command: 'dir' } },
        { type: 'tool-result', id: 'c1', name: 'exec_command', ok: true, result: 'ok', durationMs: 5 },
      ],
    },
    { id: 'u2', role: 'user', parts: [{ type: 'text', text: '继续' }] },
  ]
  const msgs = await mimoHistoryToMessages(history, { model: 'mimo-v2.6-pro' })
  assert(msgs.length === 4, `消息条数(user/assistant/tool/user):${msgs.length}`)
  const user = msgs[0] as { role: string; content: unknown }
  assert(user.role === 'user' && Array.isArray(user.content) && (user.content as Array<{ type: string }>)[1].type === 'input_audio', `多模态 user content:${JSON.stringify(user.content).slice(0, 120)}`)
  const assistant = msgs[1] as Record<string, unknown>
  assert(assistant.reasoning_content === '思考中' && assistant.content === '我听听', `reasoning 回传(官网:缺失 400):${JSON.stringify(assistant)}`)
  const toolCalls = assistant.tool_calls as Array<Record<string, unknown>>
  assert(Array.isArray(toolCalls) && toolCalls.length === 1, 'tool_calls 展开')
  assert(msgs[2].role === 'tool' && (msgs[2] as Record<string, unknown>).tool_call_id === 'c1', 'tool 结果消息紧跟')
  assert(msgs[3].role === 'user' && msgs[3].content === '继续', '后续纯文本 user')
})

await test('mimo-responses:历史带用户媒体 → Responses 原生多模态 items(不退化 chat)', async () => {
  const audioPath = path.join(tmp, 'mm-c.mp3')
  await fs.writeFile(audioPath, Buffer.from('x'))
  const captured: Array<{ url: string; body: Record<string, unknown> }> = []
  const origFetch = globalThis.fetch
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    captured.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) })
    return new Response('data: {"choices":[{"delta":{"content":"好"}}]}\n\ndata: [DONE]\n\n', { status: 200 })
  }) as typeof fetch
  try {
    const config = {
      ...MOCK_PROVIDERS,
      apiKey: 'k',
      baseURL: 'https://api.xiaomimimo.com',
      model: 'mimo-v2.6-flash',
      systemPrompt: '',
      reasoningEffort: 'high',
      mcpServers: [],
      skillsDirs: [],
    } as unknown as Parameters<typeof mimoStreamResponse>[0]['config']
    const signal = new AbortController().signal
    // 带媒体 → 仍走 /v1/responses,input items 原生多模态(2026-09-22 Responses 第一优先)
    await mimoStreamResponse({
      config,
      system: '',
      history: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: '听听' }, { type: 'media', kind: 'audio', url: audioPath, name: '语音' }] }],
      tools: [],
      signal,
      onEvent: () => {},
    })
    assert(captured.length === 1 && captured[0].url.endsWith('/v1/responses'), `带媒体应走 responses 端点(不退化 chat):${captured.map((c) => c.url)}`)
    const input = captured[0].body.input as Array<Record<string, unknown>>
    const content = input[0].content as Array<Record<string, unknown>>
    assert(content[1].type === 'input_audio' && String((content[1].input_audio as Record<string, unknown>).data).startsWith('data:audio/mpeg'), `Responses 原生 items:${JSON.stringify(content).slice(0, 120)}`)
    // 纯文本 → 同端点
    captured.length = 0
    await mimoStreamResponse({
      config,
      system: '',
      history: [{ id: 'u2', role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
      tools: [],
      signal,
      onEvent: () => {},
    })
    assert(captured.length === 1 && captured[0].url.endsWith('/v1/responses'), `纯文本同端点:${captured.map((c) => c.url)}`)
    // chat 协议直测(显式 chat 地址兼容路径):无 type 帧经修复后的 parseSse 出文本
    const out = await mimoStreamChatCompletion({
      config,
      system: '',
      history: [{ id: 'u3', role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
      tools: [],
      signal,
      onEvent: () => {},
    })
    assert(out.text === '好', `chat 流式文本(无 type 帧回归):${JSON.stringify(out.text)}`)
  } finally {
    globalThis.fetch = origFetch
  }
})

await test('mimo_batch:JSONL 构建 / region 校验 / 错误码映射', () => {
  const jsonl = buildMimoBatchJsonl(
    [{ prompt: '你好' }, { prompt: '总结:abc', system: '你是助手', custom_id: 'x' }],
    { model: 'mimo-v2.6-flash' },
  )
  const lines = jsonl.trim().split('\n').map((l) => JSON.parse(l) as {
    custom_id: string
    method: string
    url: string
    body: { model: string; instructions?: string; input: string; reasoning: { effort: string }; max_output_tokens: number }
  })
  assert(lines.length === 2 && jsonl.endsWith('\n'), 'JSONL 一行一请求')
  // Responses 格式(第一优先,url:/v1/responses,body 与实时请求体一致)
  assert(lines[0].custom_id === 'request-1' && lines[0].method === 'POST' && lines[0].url === '/v1/responses', `请求行形状:${JSON.stringify(lines[0])}`)
  assert(lines[0].body.model === 'mimo-v2.6-flash' && lines[0].body.reasoning.effort === 'none' && lines[0].body.max_output_tokens === 2048 && lines[0].body.input === '你好', `body 缺省:${JSON.stringify(lines[0].body)}`)
  assert(lines[1].custom_id === 'x' && lines[1].body.instructions === '你是助手' && lines[1].body.input === '总结:abc', `instructions 提示:${JSON.stringify(lines[1].body)}`)
  // 校验:重复 custom_id / 空 prompt / region / window
  let threw = ''
  try {
    buildMimoBatchJsonl([{ prompt: 'a', custom_id: 'd' }, { prompt: 'b', custom_id: 'd' }], { model: 'mimo-v2.6-flash' })
  } catch (e) {
    threw = String((e as Error).message)
  }
  assert(threw.includes('custom_id 重复'), `重复 id 报错:${threw}`)
  assert(mimoBatchBaseUrl('cn') === 'https://batch-api-cn.xiaomimimo.com', 'region → 批量主机(实测 DNS 可解析)')
  threw = ''
  try {
    mimoBatchBaseUrl('bad.region!')
  } catch (e) {
    threw = String((e as Error).message)
  }
  assert(threw.includes('region 不合法'), `非法 region 报错:${threw}`)
  assert(mimoErrorMessage(421, '').includes('内容拦截') && mimoErrorMessage(402, '').includes('余额不足'), '错误码映射')
})

await test('mimo_batch:create 提交链路 + mimo_media 理解链路(fetch 桩)', async () => {
  const calls: Array<{ url: string; body: unknown }> = []
  const origFetch = globalThis.fetch
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url)
    calls.push({ url: u, body: init?.body ? String(init.body).slice(0, 200) : null })
    if (u.endsWith('/v1/files')) return new Response(JSON.stringify({ id: 'file-1', status: 'active' }), { status: 200 })
    if (u.endsWith('/v1/batches')) {
      return new Response(
        JSON.stringify({ id: 'batch_9', status: 'validating', request_counts: { total: 1, completed: 0, failed: 0 }, input_file_id: 'file-1' }),
        { status: 200 },
      )
    }
    // mimo_media 非流式理解(Responses output items 形状)
    return new Response(
      JSON.stringify({
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '一段提示音' }] }],
        usage: { input_tokens: 20, output_tokens: 5, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 3 } },
      }),
      { status: 200 },
    )
  }) as typeof fetch
  try {
    const tools = createMimoTools(() => ({ apiKey: 'k', baseURL: 'https://api.xiaomimimo.com', model: 'mimo-v2.6-pro' }))
    const batch = tools.find((t) => t.name === 'mimo_batch')!
    const media = tools.find((t) => t.name === 'mimo_media')!
    assert(!!batch && !!media, '两工具注册')
    const out = String(await batch.execute({ action: 'create', requests: [{ prompt: '你好' }] }))
    assert(out.includes('batch_9') && out.includes('validating'), `create 返回:${out.slice(0, 120)}`)
    assert(calls[0].url.endsWith('/v1/files') && calls[1].url.endsWith('/v1/batches'), `上传→建任务顺序:${calls.map((c) => c.url)}`)
    assert(String(calls[1].body).includes('completion_window') && String(calls[1].body).includes('"/v1/responses"'), `建任务 body(Responses endpoint):${String(calls[1].body)}`)
    // window / model 自纠报错
    await assertRejects(() => batch.execute({ action: 'create', requests: [{ prompt: 'x' }], completion_window: '1h' }), '1-14 天')
    await assertRejects(() => batch.execute({ action: 'create', requests: [{ prompt: 'x' }], model: 'mimo-v2.5' }), '仅支持')
    await assertRejects(() => batch.execute({ action: 'status' }), 'batch_id 不能为空')
    // mimo_media:严格链路(桩返回 '一段提示音')
    const wavPath = path.join(tmp, 'mm-d.wav')
    await fs.writeFile(wavPath, Buffer.from('RIFFfake'))
    calls.length = 0
    const mout = String(await media.execute({ path: wavPath, question: '这是什么' }))
    assert(mout.includes('一段提示音') && mout.includes('输入 20') && mout.includes('思考 3'), `理解返回:${mout.slice(0, 120)}`)
    assert(calls.length === 1 && calls[0].url.endsWith('/v1/responses'), `理解端点(Responses 第一优先):${calls.map((c) => c.url)}`)
    await assertRejects(() => media.execute({ path: path.join(tmp, 'nope.mp3') }), '文件不存在')
    await assertRejects(() => media.execute({ path: path.join(tmp, 'mm-x.xyz') }), '无法从路径判断媒体类型')
    // 未配 Key 报错引导(不隐藏工具)
    const tools2 = createMimoTools(() => null)
    await assertRejects(() => tools2[1].execute({ action: 'status', batch_id: 'b' }), 'API Key 未配置')
  } finally {
    globalThis.fetch = origFetch
  }
})

// ---------------------------------------------------------------------------
// 9. DeepSeek 专属适配(2026-10-22):图像理解序列化 / 视觉模型门控 /
// 官方网页搜索与抓取(tools/search、tools/fetch)
// ---------------------------------------------------------------------------

console.log('\n=== DeepSeek 专属适配(图像理解 / 官方搜索与抓取) ===')

await test('deepseekErrorMessage:思考链没回传改成中文做法,其它 400 仍附原文', () => {
  const replay = deepseekErrorMessage(
    400,
    JSON.stringify({
      error: {
        message:
          'The `reasoning_text` in the thinking mode must be passed back to the API. (request_id: 2ae20d93-5655-4eec-bf36-700d18bd8f28)',
      },
    }),
  )
  assert(replay.includes('思考链没有带回接口'), `应说明思考链没带回,实际:${replay}`)
  assert(replay.includes('清空') && replay.includes('思考强度'), `应给出做法,实际:${replay}`)
  assert(!replay.includes('request_id') && !replay.includes('reasoning_text'), `不应再附英文原文,实际:${replay}`)
  assert(!replay.includes('上下文超长'), `不应再套用泛化 400 文案,实际:${replay}`)
  const chatReplay = deepseekErrorMessage(
    400,
    'The reasoning_content in the thinking mode must be passed back to the API.',
  )
  assert(chatReplay.includes('思考链没有带回接口'), `Chat 原文同样改写,实际:${chatReplay}`)
  const other = deepseekErrorMessage(400, JSON.stringify({ error: { message: 'Invalid JSON' } }))
  assert(other.includes('请求参数错误') && other.includes('Invalid JSON'), `其它 400 保持原文,实际:${other}`)
})

await test('deepseekModelForInput:带图请求换视觉模型,纯文本/flash 家族不动', () => {
  assert(deepseekModelForInput('deepseek-v4-pro', false) === 'deepseek-v4-pro', '纯文本保持配置模型')
  assert(deepseekModelForInput('deepseek-v4-flash', true) === 'deepseek-v4-flash', 'flash 家族带图不换')
  assert(deepseekModelForInput('deepseek-v4-pro', true) === 'deepseek-flash', 'pro 带图换 deepseek-flash')
  assert(deepseekModelForInput('deepseek-chat', true) === 'deepseek-flash', 'chat 带图换 deepseek-flash')
  assert(isDeepseekVisionModel('deepseek-flash') && isDeepseekVisionModel('deepseek-v4-flash-vision-exp'), 'flash/vision 家族支持图像')
  assert(!isDeepseekVisionModel('deepseek-v4-pro') && !isDeepseekVisionModel('deepseek-chat'), 'pro/chat 不支持图像')
})

await test('historyToItems:纯文本序列化逐字节不变;图片 part → input_image 块', async () => {
  const img = 'data:image/png;base64,iVBORw0KGgo='
  const textOnly = await historyToItems([
    { id: 'u1', role: 'user', parts: [{ type: 'text', text: '你好' }, { type: 'text', text: '世界' }] },
  ])
  assert(
    JSON.stringify(textOnly) ===
      JSON.stringify([{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '你好\n世界' }] }]),
    `纯文本 join \\n 单块(前缀缓存稳定),实际:${JSON.stringify(textOnly)}`,
  )
  const withImg = await historyToItems([
    { id: 'u2', role: 'user', parts: [{ type: 'text', text: '这是什么' }, { type: 'image', dataUrl: img }] },
  ])
  const content = (withImg[0] as { content: Array<Record<string, unknown>> }).content
  assert(content.length === 2 && content[0].type === 'input_text' && content[1].type === 'input_image', `内容块:${JSON.stringify(content).slice(0, 120)}`)
  assert(content[1].image_url === img, 'input_image.image_url 为字符串(官方:与 file_id 互斥)')
  // 历史里有图 → historyHasImages 为真(带图换模判定依据)
  assert(historyHasImages([{ id: 'u3', role: 'user', parts: [{ type: 'media', kind: 'img', url: 'C:\\a.png' }] }]) === true, 'img 媒体算图片输入')
  assert(historyHasImages([{ id: 'u4', role: 'user', parts: [{ type: 'text', text: 'hi' }] }]) === false, '纯文本不算')
})

await test('DeepSeek 思考回传:带 tools 时每轮都带思维链,缺原文补空格;不带则不回传', async () => {
  // 官方思考模式(2026-10-19):请求带 tools 时,历史每一轮 assistant 都要
  // 带回思维链,没调用工具的轮次也要。多步调用按轮拆开,思维链在该轮最前。
  const hist: AgentMessage[] = [
    { id: 'u1', role: 'user', parts: [{ type: 'text', text: '查天气' }] },
    {
      id: 'a1',
      role: 'assistant',
      parts: [
        { type: 'reasoning', text: '先查日期' },
        { type: 'tool-call', id: 'c1', name: 'get_date', args: {} },
        { type: 'tool-result', id: 'c1', name: 'get_date', ok: true, result: '2026-04-19', durationMs: 1 },
        { type: 'text', text: '杭州明天多云' },
      ],
    },
    {
      id: 'a2',
      role: 'assistant',
      parts: [
        { type: 'text', text: '我先查日期' },
        { type: 'tool-call', id: 'c2', name: 'get_date', args: {} },
        { type: 'tool-result', id: 'c2', name: 'get_date', ok: true, result: '2026-04-19', durationMs: 1 },
      ],
    },
  ]
  const items = (await historyToItems(hist, { replayReasoning: true })) as Array<Record<string, unknown>>
  const types = items.map((i) => `${i.type}${i.role ? ':' + String(i.role) : ''}`)
  assert(
    types.join(',') ===
      [
        'message:user',
        'reasoning',
        'function_call',
        'function_call_output',
        'reasoning',
        'message:assistant',
        'reasoning',
        'message:assistant',
        'function_call',
        'function_call_output',
      ].join(','),
    `Responses 轮次顺序,实际:${types.join(',')}`,
  )
  const r0 = items[1].content as Array<{ type: string; text: string }>
  assert(r0[0].type === 'reasoning_text' && r0[0].text === '先查日期', `第一轮思维链:${JSON.stringify(r0)}`)
  assert(items[2].type === 'function_call' && items[2].call_id === 'c1', 'function_call 紧跟本轮 reasoning')
  const r1 = items[4].content as Array<{ type: string; text: string }>
  assert(r1[0].text === ' ', `没存到原文时回空格,实际:${JSON.stringify(r1)}`)
  const tail = items[5].content as Array<{ text: string }>
  assert(tail[0].text === '杭州明天多云', '没调用工具的轮次也带回,正文仍在')
  const off = (await historyToItems(hist)) as Array<{ type: string }>
  assert(!off.some((i) => i.type === 'reasoning'), '不带 tools / 思考关:不回传 reasoning item')

  const chat = await historyToMessages(hist, { replayReasoning: true })
  assert(chat[1].role === 'assistant' && chat[1].reasoning_content === '先查日期' && chat[1].content === '', `Chat 工具轮:${JSON.stringify(chat[1])}`)
  assert(Array.isArray(chat[1].tool_calls) && chat[2].role === 'tool' && chat[2].tool_call_id === 'c1', 'tool 结果紧跟该轮')
  assert(chat[3].role === 'assistant' && chat[3].reasoning_content === ' ' && chat[3].content === '杭州明天多云' && !chat[3].tool_calls, `工具结果后的正文单独成轮:${JSON.stringify(chat[3])}`)
  assert(chat[4].reasoning_content === ' ' && chat[4].content === '我先查日期' && Array.isArray(chat[4].tool_calls), `缺链的工具轮补空格:${JSON.stringify(chat[4])}`)
  const chatOff = await historyToMessages(hist)
  assert(
    chatOff.every((m) => m.reasoning_content === undefined),
    '思考关或不带 tools 时不写 reasoning_content',
  )
})

await test('historyToMessages / historyToAnthropic:图片块三协议形状 + 音频占位', async () => {
  const img = 'data:image/jpeg;base64,QUJD'
  const hist: AgentMessage[] = [
    {
      id: 'u1',
      role: 'user',
      parts: [
        { type: 'text', text: '看图' },
        { type: 'image', dataUrl: img },
        { type: 'media', kind: 'audio', url: 'C:\\v.mp3', name: '语音' },
      ],
    },
  ]
  const chat = await historyToMessages(hist)
  const chatContent = (chat[0] as { content: Array<Record<string, unknown>> }).content
  const chatImg = chatContent.find((b) => b.type === 'image_url') as { image_url: { url: string } } | undefined
  assert(chatImg?.image_url.url === img, `chat image_url 为对象 {url}(官方 OpenAI vision 格式):${JSON.stringify(chatContent).slice(0, 120)}`)
  assert(chatContent.some((b) => b.type === 'text' && String(b.text).includes('不支持音频')), '音频附件占位写明原因')
  const anthropic = await historyToAnthropic(hist)
  const aContent = anthropic[0].content as Array<Record<string, unknown>>
  const aImg = aContent.find((b) => b.type === 'image') as { source: Record<string, unknown> } | undefined
  assert(
    aImg?.source.type === 'base64' && aImg.source.data === 'QUJD' && aImg.source.media_type === 'image/jpeg',
    `anthropic image 块拆 media_type + data:${JSON.stringify(aImg)}`,
  )
})

await test('planDeepseekImages:本地图片读盘转 dataUrl;超预算新图优先', async () => {
  const p1 = path.join(tmp, 'ds-img-1.png')
  await fs.writeFile(p1, Buffer.from('89504e470d0a1a0a', 'hex'))
  const hist: AgentMessage[] = [
    { id: 'u1', role: 'user', parts: [{ type: 'text', text: '旧图' }, { type: 'media', kind: 'img', url: p1, name: 'a' }] },
    { id: 'u2', role: 'user', parts: [{ type: 'media', kind: 'img', url: 'https://example.com/b.png', name: 'b' }] },
  ]
  // 预算只够 URL 张(25 字符):最近的 u2 保留,更旧的本地图降级
  const tight = await planDeepseekImages(hist, 30)
  assert(tight.get(hist[1].parts[0])?.ref === 'https://example.com/b.png', '新图保留(URL 透传)')
  assert(tight.get(hist[0].parts[1])?.ref === undefined && String(tight.get(hist[0].parts[1])?.reason).includes('预算'), `旧图降级:${JSON.stringify(tight.get(hist[0].parts[1]))}`)
  // 预算充足:本地文件读盘转 data:image/png;base64
  const full = await planDeepseekImages(hist)
  assert(String(full.get(hist[0].parts[1])?.ref).startsWith('data:image/png;base64,'), `本地转 dataUrl:${String(full.get(hist[0].parts[1])?.ref).slice(0, 32)}`)
  // 缺失文件 → 降级原因(不抛错,历史韧性)
  const broken: AgentMessage[] = [{ id: 'u9', role: 'user', parts: [{ type: 'media', kind: 'img', url: path.join(tmp, 'ds-none.png') }] }]
  const brokenPlan = await planDeepseekImages(broken)
  assert(String(brokenPlan.get(broken[0].parts[0])?.reason).includes('不存在'), `缺失降级:${JSON.stringify(brokenPlan.get(broken[0].parts[0]))}`)
})

await test('estimateMessageTokens:图片按 1024/张计入预算', () => {
  const withImg: AgentMessage = {
    id: 'm',
    role: 'user',
    parts: [{ type: 'text', text: 'x' }, { type: 'media', kind: 'img', url: 'C:\\a.png' }],
  }
  assert(estimateMessageTokens(withImg) >= 1024, `图片应计 1024 token,实际:${estimateMessageTokens(withImg)}`)
})

await test('deepseek-web:端点拼装 / URL 校验 / 搜索与抓取(桩 fetch)', async () => {
  assert(deepseekToolsEndpoint('https://api.deepseek.com', 'search') === 'https://api.deepseek.com/v1/tools/search', '默认端点')
  assert(deepseekToolsEndpoint('https://api.deepseek.com/v1/', 'fetch') === 'https://api.deepseek.com/v1/tools/fetch', '/v1 后缀归一')
  assert(deepseekToolsEndpoint('https://api.deepseek.com/anthropic', 'search') === 'https://api.deepseek.com/v1/tools/search', 'anthropic 后缀归一')
  await assertRejects(async () => assertWebFetchUrl('ftp://x/y'), '仅支持 http/https')
  await assertRejects(async () => assertWebFetchUrl('https://user:pass@example.com/'), '不能携带用户名或密码')
  await assertRejects(async () => assertWebFetchUrl(`https://${'a'.repeat(8200)}`), '8192')

  const origFetch = globalThis.fetch
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []
  globalThis.fetch = async (url: string | URL | Request, opts?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(opts?.body ?? '{}')) })
    if (String(url).endsWith('/v1/tools/search')) {
      return new Response(
        JSON.stringify({
          results: [
            { title: 'T', url: 'https://e.com/1', snippet: '短摘要', summary: '长摘要', site_name: '站', date: '2026-06-01T00:00:00+00:00', rerank_score: 2.4, authority: 3 },
          ],
        }),
        { status: 200 },
      )
    }
    return new Response(JSON.stringify({ title: '页', content: '# 正文' }), { status: 200 })
  }
  try {
    const results = await deepseekWebSearch({ apiKey: 'k', baseURL: 'https://api.deepseek.com' }, { query: '测试', count: 5 })
    assert(results.length === 1 && results[0].rerankScore === 2.4 && results[0].summary === '长摘要', `解析:${JSON.stringify(results)}`)
    assert(calls[0].body.query === '测试' && calls[0].body.count === 5 && calls[0].body.need_content === false, `请求体:${JSON.stringify(calls[0].body)}`)
    const text = formatDeepseekSearchResults(results, '测试')
    assert(text.includes('长摘要') && text.includes('优质') && text.includes('https://e.com/1') && text.includes('2026-06-01'), `格式化:${text.slice(0, 160)}`)
    assert(formatDeepseekSearchResults([], '空') === '(未找到与「空」相关的结果,可换关键词再搜)', '空结果提示')
    const page = await deepseekWebFetchPage({ apiKey: 'k', baseURL: 'https://api.deepseek.com' }, 'https://e.com/1')
    assert(page.title === '页' && page.content === '# 正文' && calls[1].url.endsWith('/v1/tools/fetch'), `抓取:${JSON.stringify(page)}`)
    // 403 专属错误映射(官方:抓取被安全策略拒绝)
    globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'blocked' } }), { status: 403 })
    await assertRejects(() => deepseekWebFetchPage({ apiKey: 'k', baseURL: '' }, 'https://e.com/1'), '安全策略')
    // 正文格式化:超长截断并注明总长
    const long = formatPageResult('题', 'x'.repeat(8000))
    assert(long.includes('已截断') && long.includes('8000'), `截断提示:${long.slice(-60)}`)
  } finally {
    globalThis.fetch = origFetch
  }
})

await test('web_search/web_fetch 工具:DeepSeek 官方优先,失败回退 Bing/直连', async () => {
  const tools = createTools({
    onSwitchToMusic: () => {},
    getDeepseekCreds: () => ({ apiKey: 'k', baseURL: 'https://api.deepseek.com' }),
  })
  const searchTool = tools.find((t) => t.name === 'web_search')
  const fetchTool = tools.find((t) => t.name === 'web_fetch')
  assert(searchTool && fetchTool, 'web_search / web_fetch 应注册')
  const origFetch = globalThis.fetch
  try {
    // ① 官方搜索可用:走 /v1/tools/search
    globalThis.fetch = async (url: string | URL | Request, opts?: RequestInit) => {
      const u = String(url)
      if (u.endsWith('/v1/tools/search')) {
        const body = JSON.parse(String(opts?.body ?? '{}')) as Record<string, unknown>
        assert(body.need_content === false, 'need_content 缺省 false(summary 供模型阅读)')
        return new Response(
          JSON.stringify({ results: [{ title: '官方结果', url: 'https://a.example/1', snippet: '短', summary: '长摘要', site_name: 'A', date: null, rerank_score: 2.0, authority: 4 }] }),
          { status: 200 },
        )
      }
      throw new Error(`不该到达:${u}`)
    }
    const out1 = String(await searchTool!.execute({ query: '测试' }))
    assert(out1.includes('官方结果') && out1.includes('长摘要'), `官方搜索:${out1.slice(0, 100)}`)
    // ② 官方搜索 500 → 回退 Bing(HTML b_algo 结果块)
    globalThis.fetch = async (url: string | URL | Request) => {
      const u = String(url)
      if (u.includes('/v1/tools/search')) return new Response('boom', { status: 500 })
      return new Response('<li class="b_algo"><h2><a href="https://hit.example/1">兜底标题</a></h2><p>兜底摘要</p></li>', { status: 200 })
    }
    const out2 = String(await searchTool!.execute({ query: '测试' }))
    assert(out2.includes('兜底标题') && out2.includes('hit.example'), `回退 Bing:${out2.slice(0, 100)}`)
    // ③ web_fetch 官方抓取
    globalThis.fetch = async (url: string | URL | Request) => {
      const u = String(url)
      if (u.endsWith('/v1/tools/fetch')) return new Response(JSON.stringify({ title: '页标题', content: '# 正文' }), { status: 200 })
      throw new Error(`不该到达:${u}`)
    }
    const out3 = String(await fetchTool!.execute({ url: 'https://a.example/1' }))
    assert(out3.includes('《页标题》') && out3.includes('# 正文'), `官方抓取:${out3.slice(0, 100)}`)
    // ④ 官方 404 → 回退直连 HTML(去标签留正文)
    globalThis.fetch = async (url: string | URL | Request) => {
      const u = String(url)
      if (u.includes('/v1/tools/fetch')) return new Response('null', { status: 404 })
      return new Response('<html><head><title>直连页</title></head><body><p>直连正文</p></body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    }
    const out4 = String(await fetchTool!.execute({ url: 'https://a.example/2' }))
    assert(out4.includes('直连页') && out4.includes('直连正文'), `回退直连:${out4.slice(0, 100)}`)
  } finally {
    globalThis.fetch = origFetch
  }
})

await test('厂商专属通道:同一 baseURL 只解析到自家适配器(DeepSeek/MiMo 不互串)', () => {
  const rt = getDefaultLlmRuntime()
  assert(rt.resolve('https://api.deepseek.com').id === 'responses', 'DeepSeek → DeepSeek Responses')
  assert(rt.resolve('https://api.deepseek.com/chat').id === 'chat', 'DeepSeek chat → DeepSeek Chat')
  assert(rt.resolve('https://api.xiaomimimo.com').id === 'mimo-responses', 'MiMo → MiMo Responses')
  assert(rt.resolve('https://api.xiaomimimo.com/chat').id === 'mimo-chat', 'MiMo chat → MiMo Chat')
  assert(rt.resolve('https://open.bigmodel.cn/api/paas/v4').id === 'glm-chat', 'GLM → GLM 云端')
  assert(rt.resolve('http://127.0.0.1:1234').id === 'lmstudio-chat', 'LM Studio → 本地通道')
  // 显式断言不互串:DeepSeek 地址永远不会解析到 mimo 适配器,反之亦然
  assert(!rt.resolve('https://api.deepseek.com').id.startsWith('mimo'), 'DeepSeek 不走 MiMo 通道')
  assert(rt.resolve('https://api.xiaomimimo.com').id.startsWith('mimo'), 'MiMo 走自家通道')
})

await test('resolveSubConfig:跨厂商换桶丢 llmAdapter(防别家模型强绑错通道)', () => {
  const cfg = {
    ...MOCK_PROVIDERS,
    activeProvider: 'deepseek' as const,
    apiKey: 'dk',
    baseURL: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',
    systemPrompt: '',
    reasoningEffort: 'high',
    mcpServers: [],
    skillsDirs: [],
    llmAdapter: 'responses',
    subProvider: 'mimo' as const,
    providers: {
      ...MOCK_PROVIDERS.providers,
      deepseek: { apiKey: 'dk', baseURL: 'https://api.deepseek.com', model: 'deepseek-v4-flash' },
      mimo: { apiKey: 'mk', baseURL: 'https://api.xiaomimimo.com', model: 'mimo-v2.6-pro' },
    },
  }
  // 跨厂商换桶(llmAdapter='responses' 是 DeepSeek 通道协议 id):必须丢弃,
  // 否则 resolve 按 preferId 直接命中 DeepSeek 适配器去跑 MiMo 的 baseURL
  const sub = resolveSubConfig(cfg)
  assert(sub.baseURL === 'https://api.xiaomimimo.com' && sub.model === 'mimo-v2.6-pro', `子配置应换 MiMo 桶:${sub.baseURL}/${sub.model}`)
  assert(sub.llmAdapter === undefined, `跨厂商换桶后 llmAdapter 必须丢弃,实际:${String(sub.llmAdapter)}`)
  // 同桶只换子模型:llmAdapter 保留(同厂商专属通道不动)
  const same = resolveSubConfig({ ...cfg, subProvider: 'deepseek' as const, subModel: 'deepseek-v4-pro' })
  assert(same.llmAdapter === 'responses' && same.model === 'deepseek-v4-pro', `同桶应保留 llmAdapter:${JSON.stringify({ a: same.llmAdapter, m: same.model })}`)
  // 换桶但新地址协议恰好一致:保留显式适配器
  const match = resolveSubConfig({ ...cfg, llmAdapter: 'mimo-responses' })
  assert(match.llmAdapter === 'mimo-responses', `协议一致应保留:${String(match.llmAdapter)}`)
})

await test('get_deepseek_balance:DeepSeek 专属通道走 providers.deepseek 桶凭据', async () => {
  const cfg = {
    ...MOCK_PROVIDERS,
    activeProvider: 'mimo' as const,
    apiKey: 'mimo-key',
    baseURL: 'https://api.xiaomimimo.com',
    model: 'mimo-v2.6-pro',
    systemPrompt: '',
    reasoningEffort: 'high',
    mcpServers: [],
    skillsDirs: [],
    providers: {
      ...MOCK_PROVIDERS.providers,
      deepseek: { apiKey: 'ds-key', baseURL: 'https://api.deepseek.com', model: 'deepseek-v4-flash' },
    },
  }
  const tools = createBuiltinTools(
    { get value() { return 8192 }, set value(_n: number) {} },
    { getConfig: () => cfg },
  )
  const bal = tools.find((t) => t.name === 'get_deepseek_balance')
  assert(bal, '应注册 get_deepseek_balance')
  const origFetch = globalThis.fetch
  const calls: string[] = []
  let auth = ''
  globalThis.fetch = async (url: string | URL | Request, opts?: RequestInit) => {
    calls.push(String(url))
    auth = String(((opts?.headers ?? {}) as Record<string, string>).Authorization ?? '')
    return new Response(
      JSON.stringify({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '10', granted_balance: '2', topped_up_balance: '8' }] }),
      { status: 200 },
    )
  }
  try {
    const out = String(await bal!.execute({}))
    assert(calls[0] === 'https://api.deepseek.com/user/balance', `激活 MiMo 也应打 DeepSeek 自己的通道,实际:${calls[0]}`)
    assert(auth === 'Bearer ds-key', `应带 DeepSeek 桶的 Key,实际:${auth}`)
    assert(out.includes('10.00'), `余额输出:${out}`)
  } finally {
    globalThis.fetch = origFetch
  }
  // 桶无 Key 且激活非 deepseek:报错引导,不打任何通道(不能拿 MiMo 凭据凑)
  const cfg2 = {
    ...cfg,
    providers: { ...cfg.providers, deepseek: { apiKey: '', baseURL: '', model: '' } },
  }
  const tools2 = createBuiltinTools(
    { get value() { return 8192 }, set value(_n: number) {} },
    { getConfig: () => cfg2 },
  )
  await assertRejects(() => tools2.find((t) => t.name === 'get_deepseek_balance')!.execute({}), '未配置 DeepSeek')
  // GLM 地址守卫(2026-10-22 修复漏拦:此前会把 DeepSeek 余额接口打到智谱通道)
  await assertRejects(
    () => fetchDeepseekBalance({ baseURL: 'https://open.bigmodel.cn/api/paas/v4', apiKey: 'k' }),
    '智谱',
    'GLM 地址应拒绝',
  )
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
