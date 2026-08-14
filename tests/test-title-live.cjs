/**
 * 总结标题真实 API 测试(electron 主进程直接跑,2026-08-12)
 *
 * 用途:调 DeepSeek API 实测标题总结的**实际输出质量**——用户反馈
 * "标题总结废话太多(一句话总结完事)+ 文本截断"。本脚本:
 * 1. 内嵌 esbuild 打包最新 agent.cjs(只打包 engine.ts,不跑完整
 *    build-electron.mjs——其 make-icon 步骤会再 spawn electron 离屏渲染,
 *    在本脚本已运行的 electron 内互锁卡死实测;改 subagents.ts 措辞后
 *    重跑本脚本即生效,不用起挂件);
 * 2. safeStorage(DPAPI)解密 settings.json 里的 apiKey(safeStorage 只在
 *    electron 主进程可用,普通 node 读 settings.json 只能拿到 enc: 密文);
 * 3. require agent.cjs 的 createSummaryAgent,用多段真实风格对话历史
 *    调 summarize,打印每个标题(码元数 ≤20 = 无截断)与耗时。
 *
 * 运行:npx electron --disable-gpu tests/test-title-live.cjs
 * 结果双写 scripts/title-test-result.log(stdout 管道可能被缓冲吞掉,实测)。
 * 迭代措辞:改 electron/agent/subagents/subagents.ts → 重跑本脚本。
 */
const { app, safeStorage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')

// 日志双写:electron 的 stdout 在 Windows 重定向到管道时可能被缓冲吞掉
// (实测管道输出为空),结果文件保底;测试完打印文件路径
const LOG_FILE = path.join(__dirname, 'title-test-result.log')
fs.writeFileSync(LOG_FILE, '', 'utf8')
function log(...args) {
  const line = args.join(' ')
  fs.appendFileSync(LOG_FILE, line + '\n', 'utf8')
  console.log(line)
}

// ---- 0. 先打包最新 agent.cjs(改措辞后无需手动 build) ----------------------
// 只做 esbuild 打包(与 build-electron.mjs 同款配置):不能跑完整
// build-electron.mjs——其 make-icon 步骤会再 spawn electron 离屏渲染,
// 在本脚本已运行的 electron 内互锁卡死(实测)
async function buildAgent() {
  const esbuild = require('esbuild')
  await esbuild.build({
    entryPoints: [path.join(root, 'electron', 'agent', 'engine.ts')],
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

// ---- 1. 解密真实 API Key,然后跑测试 ------------------------------------------
// 关键:必须在 ready 前 setPath('userData', 挂件 userData)——Electron 43
// safeStorage 的 app-bound 熵与 userData 路径绑定,不设置则解不开挂件
// 写的密文(实测:ready 前 setPath 后默认上下文直接解密成功)
app.setPath('userData', path.join(process.env.APPDATA || '', 'dynamic-island'))

app.whenReady().then(async () => {
  log('[title-test] 打包最新 agent.cjs …')
  try {
    await buildAgent()
  } catch (err) {
    log('[title-test] 打包失败:', err.message)
    process.exit(1)
  }
  const settingsPath = path.join(process.env.APPDATA || '', 'dynamic-island', 'settings.json')
  let settings = {}
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
  } catch {
    log('[title-test] 读取 settings.json 失败(路径:', settingsPath, ')')
    process.exit(1)
  }
  let apiKey = settings.agent?.apiKey ?? ''
  if (apiKey.startsWith('enc:')) {
    try {
      apiKey = safeStorage.decryptString(Buffer.from(apiKey.slice(4), 'base64'))
    } catch (err) {
      log('[title-test] 解密 apiKey 失败:', err.message)
      process.exit(1)
    }
  }
  if (!apiKey) {
    log('[title-test] 未配置 API Key(settings.json agent.apiKey 为空)')
    process.exit(1)
  }
  await run({ ...(settings.agent ?? {}), apiKey })
  app.quit()
})

// ---- 2. 测试样本与断言 -------------------------------------------------------
async function run(config) {
  const { createSummaryAgent } = require(path.join(root, 'electron', 'agent.cjs'))
  // 可变配置引用:风格段切换 summaryStyle/mindPersona 时替换对象,
  // Sub Agent 每次调用独立读 getConfig(与主进程"每次调用独立读配置"一致)
  let currentConfig = config
  const agent = createSummaryAgent({ getConfig: () => currentConfig })

  const histories = [
    {
      name: 'A:纯问答(简单主题)',
      messages: [
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: '在吗,今天天气怎么样' }] },
        { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: '今天晴,25 度,适合出门。' }] },
        { id: 'u2', role: 'user', parts: [{ type: 'text', text: '好的,那穿短袖出门够吗' }] },
      ],
    },
    {
      name: 'B:多轮工具调用(B站下载 + 技能)',
      messages: [
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
      ],
    },
    {
      name: 'C:长问题/多个话题混杂',
      messages: [
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: '帮我看看怎么配置 MCP 服务器,我想连接本地文件系统,还有顺便问一下怎么把背景图换成自定义图片,另外 Agent 的字体能不能也改一下' }] },
        { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: '可以,我来分别说明:1. MCP 服务器在 Agent 设置的"工具与能力"里配置…2. 背景图在设置→背景…3. 字体在设置→字体…' }] },
        { id: 'u2', role: 'user', parts: [{ type: 'text', text: '字体设置里怎么导入自定义字体文件?' }] },
        { id: 'a2', role: 'assistant', parts: [{ type: 'text', text: '在字体库页面点上传,支持 ttf/otf/woff/woff2,10MB 以内。' }] },
      ],
    },
    {
      name: 'D:技术问答(复杂主题)',
      messages: [
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: '灵动岛的 Agent 模式支持哪些工具?我想让它帮我管理文件、执行命令、还能联网搜索' }] },
        { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: '支持 exec_command、read_file、write_file、list_dir、web_search 等工具,可以完全在对话里完成这些操作。' }] },
        { id: 'u2', role: 'user', parts: [{ type: 'text', text: '那 exec_command 有确认门吗?我怕它乱执行命令' }] },
        { id: 'a2', role: 'assistant', parts: [{ type: 'text', text: '有,默认关闭,开启后每轮首个命令需要你确认。在设置里的 Agent 设置可以开关。' }] },
      ],
    },
    {
      name: 'E:闲聊/情感(无主题变化)',
      messages: [
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: '我好累啊,今天加班到十点' }] },
        { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: '辛苦了,早点休息,别太拼。' }] },
        { id: 'u2', role: 'user', parts: [{ type: 'text', text: '嗯嗯,你真好,陪我聊会儿吧' }] },
        { id: 'a2', role: 'assistant', parts: [{ type: 'text', text: '好啊,想聊什么?今天有没有什么开心的事?' }] },
      ],
    },
  ]

  let bad = 0
  log(`\n=== 标题总结真实 API 测试(${config.baseURL} / ${config.model}) ===`)
  for (const h of histories) {
    const t0 = Date.now()
    try {
      const title = await agent.summarize(h.messages)
      const elapsed = Math.round((Date.now() - t0) / 1000)
      const len = Array.from(title).length
      const problems = []
      if (!title) problems.push('空')
      if (len > 20) problems.push(`超长 ${len} 码元(截断)`)
      if (len > 0 && len < 3) problems.push('过短(回应词残渣?)')
      // 废话检测:句子式标题(回应词/废话词开头 = 摘抄回复原句的信号;
      // 「与」「和」是并列连接词,正常短语可用,不误报)
      if (/^(用户|对话|关于|如何|询问|讨论|是的|好的|可以|没问题|嗯)[，,:：、]/.test(title)) problems.push('句子式/回应词开头')
      if (/^(用户|对话|关于|如何|询问|讨论|是的|好的|可以|没问题|嗯)[^，,:：、]{2,}$/.test(title)) problems.push('疑似句子式废话')
      // 完成体"了"/句尾"的" = 摘抄/续写原句(与引擎 looksLikeSentenceTitle 同款)
      if (len > 6 && (/了/.test(title) || /.+的$/.test(title))) problems.push('句子式(了/的)')
      const mark = problems.length ? `✗ ${problems.join(' / ')}` : '✓'
      if (problems.length) bad++
      log(`  ${mark} [${h.name}]「${title}」(${len} 码元,${elapsed}s)`)
    } catch (err) {
      bad++
      log(`  ✗ [${h.name}] 调用失败:${err.message}`)
    }
  }
  log(bad === 0 ? '\n全部合格' : `\n${bad}/${histories.length} 段不合格`)

  // ---- 心理揣测(createMindAgent.guess):同 5 段历史,断言 ≤16 码元
  // 无截断、非空;失败(超长重试耗尽/调用失败)回退标题 = 展示缺陷 ----
  const mind = require(path.join(root, 'electron', 'agent.cjs')).createMindAgent({
    getConfig: () => currentConfig,
  })
  let mindBad = 0
  log(`\n=== 心理揣测真实 API 测试(默认人格,≤16 码元不截断) ===`)
  for (const h of histories) {
    const t0 = Date.now()
    try {
      const g = await mind.guess(h.messages)
      const elapsed = Math.round((Date.now() - t0) / 1000)
      const len = Array.from(g).length
      const problems = []
      if (!g) problems.push('空(重试耗尽回退标题)')
      if (len > 16) problems.push(`超长 ${len} 码元(截断)`)
      if (len > 0 && len < 3) problems.push('过短')
      const mark = problems.length ? `✗ ${problems.join(' / ')}` : '✓'
      if (problems.length) mindBad++
      log(`  ${mark} [${h.name}]「${g}」(${len} 码元,${elapsed}s)`)
    } catch (err) {
      mindBad++
      log(`  ✗ [${h.name}] 调用失败:${err.message}`)
    }
  }
  log(mindBad === 0 ? '全部合格' : `${mindBad}/${histories.length} 段不合格`)
  if (mindBad) bad = 1

  // ---- 风格验证:同一段历史分别跑各预设 + 自定义,断言输出有差异 ----
  const styleHist = histories[1] // B 段(工具调用 + 话题),风格差异最明显
  const SUMMARY_STYLES = [
    ['concise', '简洁明了'],
    ['lively', '活泼俏皮'],
    ['literary', '文艺诗意'],
    ['formal', '正式稳重'],
    ['custom', '用网络流行语,像短视频标题'],
  ]
  const MIND_PERSONAS = [
    ['catgirl', '俏皮猫娘'],
    ['tender', '温柔贴心'],
    ['aloof', '高冷克制'],
    ['witty', '知性风趣'],
    ['custom', '用粤语夹杂英语,像港片台词'],
  ]
  const summaryOuts = []
  const mindOuts = []
  log(`\n=== 风格影响验证(同一段历史,各预设 + 自定义) ===`)
  for (const [id, label] of SUMMARY_STYLES) {
    currentConfig = { ...config, summaryStyle: id === 'custom' ? '用网络流行语,像短视频标题' : id }
    const t0 = Date.now()
    const out = await agent.summarize(styleHist.messages)
    const elapsed = Math.round((Date.now() - t0) / 1000)
    summaryOuts.push(out)
    log(`  [标题 文风=${label}]「${out}」(${Array.from(out).length} 码元,${elapsed}s)`)
    if (!out || Array.from(out).length > 20) bad = 1
  }
  const uniqueSummary = new Set(summaryOuts).size
  log(`  标题 5 种风格输出互不相同:${uniqueSummary === 5 ? '✓' : `✗ 仅 ${uniqueSummary} 种`}(不同 = 风格确实影响生成)`)
  if (uniqueSummary < 3) bad = 1
  for (const [id, label] of MIND_PERSONAS) {
    currentConfig = { ...config, mindPersona: id === 'custom' ? '用粤语夹杂英语,像港片台词' : id }
    const t0 = Date.now()
    const out = await mind.guess(styleHist.messages)
    const elapsed = Math.round((Date.now() - t0) / 1000)
    mindOuts.push(out)
    log(`  [揣测 人格=${label}]「${out}」(${Array.from(out).length} 码元,${elapsed}s)`)
    if (!out || Array.from(out).length > 16) bad = 1
  }
  const uniqueMind = new Set(mindOuts).size
  log(`  揣测 5 种人格输出互不相同:${uniqueMind === 5 ? '✓' : `✗ 仅 ${uniqueMind} 种`}`)
  if (uniqueMind < 3) bad = 1
  // 自定义人格应带明显特征(粤语/英语词)——软断言,日志人工核验
  const customMind = mindOuts[4] ?? ''
  log(`  自定义人格(粤语+英语)特征词核验:${/(香港|港|粤|冇|咁|咖|啦|OK|bye|好嘢|顶|咗|搞掂|唔|啱|哋|喺|講|識|廢話|靜|咩|係|嘅|嚟|嘢)/.test(customMind) ? '✓ 命中' : '△ 未命中(需人工确认输出是否体现自定义)'}`)

  log(bad === 0 ? '\n全部合格' : `\n存在不合格项`)
  log(`完整结果已写入:${LOG_FILE}`)
}
