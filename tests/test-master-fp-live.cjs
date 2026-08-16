/**
 * 主人 QQ 轮主人指纹真实 API 测试(2026-08-15,用户实测"通过主人QQ发消息
 * 没有回复"——排查 LLM 是否遵守【主人指纹:xxx】前缀协议)
 *
 * 复刻 main.cjs 主人 QQ 轮的完整注入:用户消息(【QQ私聊】类别行 + 档案卡
 * + 回复规则)+ turnMasterFingerprintRule 主人指纹系统指令 → 真实引擎 send
 * → 检查落定回复是否以「【主人指纹:<本轮 fp>】」开头(合规 = 能发回主人,
 * 不合规 = master-no-fp 扣留 = 用户"没有回复消息"的根因)。
 *
 * 运行:npx electron --disable-gpu tests/test-master-fp-live.cjs
 * 结果双写 tests/master-fp-result.log
 */
const { app, safeStorage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const LOG_FILE = path.join(__dirname, 'master-fp-result.log')
fs.writeFileSync(LOG_FILE, '', 'utf8')
function log(...args) {
  const line = args.join(' ')
  fs.appendFileSync(LOG_FILE, line + '\n', 'utf8')
  console.log(line)
}

const MASTER_QQ = '1178821869'

async function buildAgent() {
  const esbuild = require('esbuild')
  await esbuild.build({
    entryPoints: [path.join(root, 'electron', 'agent', 'engine', 'engine.ts')],
    outfile: path.join(root, 'electron', 'agent.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['electron'],
    sourcemap: false,
    logLevel: 'warning',
  })
}

app.setPath('userData', path.join(process.env.APPDATA || '', 'dynamic-island'))

app.whenReady().then(async () => {
  log('[master-fp-test] 打包最新 agent.cjs …')
  try {
    await buildAgent()
  } catch (err) {
    log('[master-fp-test] 打包失败:', err.message)
    process.exit(1)
  }
  const settingsPath = path.join(process.env.APPDATA || '', 'dynamic-island', 'settings.json')
  let settings = {}
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
  } catch {
    log('[master-fp-test] 读取 settings.json 失败(路径:', settingsPath, ')')
    process.exit(1)
  }
  let apiKey = settings.agent?.apiKey ?? ''
  if (apiKey.startsWith('enc:')) {
    try {
      apiKey = safeStorage.decryptString(Buffer.from(apiKey.slice(4), 'base64'))
    } catch (err) {
      log('[master-fp-test] 解密 apiKey 失败:', err.message)
      process.exit(1)
    }
  }
  if (!apiKey) {
    log('[master-fp-test] 未配置 API Key(settings.json agent.apiKey 为空)')
    process.exit(1)
  }
  await run({ ...(settings.agent ?? {}), apiKey })
  app.quit()
})

// ---- 测试样本与断言 -------------------------------------------------------
// 复刻 main.cjs turnMasterDirectRule 文案(2026-08-15 二轮:主人日常轮
// 不要求指纹,回复直接发回主人;发给别人必须用 send 工具)
function turnMasterDirectRule() {
  return (
    `你正在与主人(QQ ${MASTER_QQ})对话:你的回复会直接发送到主人 QQ,直接正常回复即可。` +
    `要给别人(其它 QQ/群)发消息,必须用 napcat send/send_group 工具真实发送,不要只写在对话回复里` +
    `(不调工具只在回复里说"已发送" = 对方实际收不到,2026-08-14 用户实测)。`
  )
}

// 复刻 main.cjs trusted 分支的回复规则注入(主人版)
function masterReplyRules() {
  return (
    `【QQ私聊 · QQ ${MASTER_QQ} · 主人】` +
    `\n【档案卡】\n主人:昵称未知 · 已知信息:无\n` +
    `\n【回复规则】\n` +
    `① 岛灵的主人 = QQ ${MASTER_QQ}(唯一,硬编码)——当前对方就是主人本人。` +
    `直接正常回复,不要「先问主人」「按指示回复他」——主人就在说话,不需要问任何人。` +
    `② 历史里与其它 QQ 的对话(陌生人的询问链路/指令)是过去的事,与当前消息无关,不要沿用那个语境。`
  )
}

async function run(config) {
  const mod = require(path.join(root, 'electron', 'agent.cjs'))
  const { newTurnFingerprint, extractMasterFingerprint } = mod
  const samples = [
    { label: 'S1 日常问候', userText: '你好' },
    { label: 'S2 普通闲聊', userText: '今天天气怎么样' },
    { label: 'S3 要求办点小事', userText: '帮我看看现在几点了' },
    { label: 'S4 指示回复他人', userText: '帮我回复魔精:好的,明天见' },
  ]
  let pass = 0
  for (const s of samples) {
    const fp = newTurnFingerprint()
    const hist = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: masterReplyRules() }] },
      { id: 's1', role: 'system', parts: [{ type: 'text', text: turnMasterDirectRule() }] },
    ]
    let reply = ''
    let err = null
    const engine = mod.createAgentEngine({
      getConfig: () => config,
      onEvent: (ev) => {
        if (ev.type === 'message' && !ev.message?.proactive) {
          reply = (ev.message?.parts ?? [])
            .filter((p) => p && p.type === 'text')
            .map((p) => String(p.text))
            .join('\n')
            .trim()
        }
      },
      getMemoryStore: () => null,
      getEvolution: () => null,
      updateAgentConfig: () => {},
      getSkillDir: () => '',
      confirmCommand: () => Promise.resolve(true),
      confirmAction: () => Promise.resolve(true),
      napcat: {},
      externalTools: async () => [],
    })
    await new Promise((resolve) => {
      engine.send(s.userText, hist, 'sess-' + fp)
      const t = setInterval(() => {
        if (reply || err || !engine.busy) {
          clearInterval(t)
          resolve()
        }
      }, 500)
      setTimeout(() => {
        clearInterval(t)
        if (!reply) {
          err = new Error('超时(60s)未收到回复')
          resolve()
        }
      }, 60000)
    })
    // 新语义(2026-08-15 二轮):非执行主人轮不要求指纹,回复无条件发回
    // 主人——只有 LLM 回复存在歧义(执行轮/询问轮/群触发轮)才用指纹门控。
    // 断言:能拿到回复即可送达;主人指纹若带则提取正常(双通道仍兼容)
    const ok = !!reply
    if (ok) pass++
    log(`\n===== ${s.label} =====`)
    log(`用户消息: ${s.userText}`)
    log(`回复原文: ${JSON.stringify((reply || err?.message || '(无)').slice(0, 300))}`)
    if (reply) {
      const extracted = extractMasterFingerprint(reply, fp)
      log(extracted
        ? `✅ 可直接送达主人(另:回复带主人指纹,剥后 = ${JSON.stringify(extracted.content.slice(0, 60))})`
        : '✅ 可直接送达主人(无指纹,日常轮不要求)')
    }
  }
  log(`\n===== 结果:${pass}/${samples.length} 轮可送达 =====`)
  if (pass < samples.length) log('⚠️ 结论:仍有轮次拿不到回复(引擎/网络层问题)')
  else log('✅ 结论:主人 QQ 日常轮全部可直接送达,不再依赖 LLM 带指纹')
}
