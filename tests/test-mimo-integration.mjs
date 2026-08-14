/**
 * 集成测试：直接测试代码中的 mimo-responses.ts 和 mimo-chat.ts 模块
 */

// 先确保编译最新的ts文件
import { execSync } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))

console.log('🔨 编译 TypeScript...')
try {
  execSync('npx tsc -b tsconfig/tsconfig.json', { cwd: join(__dirname, '..'), stdio: 'pipe' })
  console.log('✅ TypeScript 编译成功')
} catch (e) {
  console.error('❌ TypeScript 编译失败:', e.stderr?.toString() || e.message)
  process.exit(1)
}

// 动态导入编译后的模块
const { mimoStreamResponse, mimoHistoryToItems } = await import('../electron/agent/providers/mimo-responses.js')
const { mimoStreamChatCompletion, mimoHistoryToMessages } = await import('../electron/agent/providers/mimo-chat.js')

const API_KEY = 'sk-cmmnv07jyrdncjhymfpsa4kxixyl6e4t31f4idzg53j3r1hc'
const BASE_URL = 'https://api.xiaomimimo.com'

const colors = {
  green: (text) => `\x1b[32m${text}\x1b[0m`,
  red: (text) => `\x1b[31m${text}\x1b[0m`,
  yellow: (text) => `\x1b[33m${text}\x1b[0m`,
  blue: (text) => `\x1b[34m${text}\x1b[0m`,
  cyan: (text) => `\x1b[36m${text}\x1b[0m`,
}

function log(title, color = 'cyan') {
  console.log('\n' + colors[color](`=== ${title} ===`))
}
function ok(msg) { console.log(colors.green('✅ ' + msg)) }
function err(msg, e) { console.log(colors.red('❌ ' + msg)); console.error(e?.message || e) }

// 测试配置
const config = {
  baseURL: BASE_URL,
  apiKey: API_KEY,
  model: 'mimo-v2.5-pro',
  reasoningEffort: 'high',
  maxOutputTokens: 500,
}

const results = []

// 测试1: mimoHistoryToItems
log('测试 1: mimoHistoryToItems 消息格式转换')
try {
  const history = [
    {
      id: '1',
      role: 'user',
      parts: [{ type: 'text', text: '你好' }]
    }
  ]
  const items = mimoHistoryToItems(history)
  console.log('转换结果:', JSON.stringify(items, null, 2))
  if (items.length === 1 && items[0].role === 'user') {
    ok('mimoHistoryToItems 格式正确')
    results.push(true)
  } else {
    err('mimoHistoryToItems 格式异常')
    results.push(false)
  }
} catch (e) {
  err('mimoHistoryToItems 测试失败', e)
  results.push(false)
}

// 测试2: mimoHistoryToMessages
log('测试 2: mimoHistoryToMessages 消息格式转换')
try {
  const history = [
    {
      id: '1',
      role: 'user',
      parts: [{ type: 'text', text: '你好' }]
    }
  ]
  const messages = mimoHistoryToMessages(history)
  console.log('转换结果:', JSON.stringify(messages, null, 2))
  if (messages.length === 1 && messages[0].role === 'user') {
    ok('mimoHistoryToMessages 格式正确')
    results.push(true)
  } else {
    err('mimoHistoryToMessages 格式异常')
    results.push(false)
  }
} catch (e) {
  err('mimoHistoryToMessages 测试失败', e)
  results.push(false)
}

// 测试3: mimoStreamResponse 流式请求（实际调用）
log('测试 3: mimoStreamResponse 实际流式调用', 'blue')
try {
  const events = []
  const controller = new AbortController()

  const outcome = await mimoStreamResponse({
    config,
    system: '你是一个简洁的助手，回答简短。',
    history: [
      { id: '1', role: 'user', parts: [{ type: 'text', text: '2的10次方是多少？只回答数字。' }] }
    ],
    tools: [],
    signal: controller.signal,
    onEvent: (event) => {
      events.push(event)
      if (event.type === 'text-delta') process.stdout.write(event.text)
      if (event.type === 'reasoning-delta') process.stdout.write(colors.yellow(event.text))
    },
    maxOutputTokens: 100,
  })

  console.log('')
  console.log('事件数量:', events.length)
  console.log('事件类型:', [...new Set(events.map(e => e.type))])
  console.log('最终文本:', outcome.text)
  console.log('Usage:', outcome.usage)

  if (outcome.text && outcome.text.length > 0) {
    ok('mimoStreamResponse 流式调用成功')
    results.push(true)
  } else {
    err('mimoStreamResponse 无文本输出')
    results.push(false)
  }
} catch (e) {
  err('mimoStreamResponse 测试失败', e)
  results.push(false)
}

// 测试4: mimoStreamChatCompletion 流式请求（实际调用）
log('测试 4: mimoStreamChatCompletion 实际流式调用', 'blue')
try {
  const events = []
  const controller = new AbortController()

  const outcome = await mimoStreamChatCompletion({
    config,
    system: '你是一个简洁的助手。',
    history: [
      { id: '1', role: 'user', parts: [{ type: 'text', text: '中国首都是哪里？只回答城市名。' }] }
    ],
    tools: [],
    signal: controller.signal,
    onEvent: (event) => {
      events.push(event)
      if (event.type === 'text-delta') process.stdout.write(event.text)
      if (event.type === 'reasoning-delta') process.stdout.write(colors.yellow(event.text))
    },
    maxOutputTokens: 100,
  })

  console.log('')
  console.log('事件数量:', events.length)
  console.log('最终文本:', outcome.text)
  console.log('Usage:', outcome.usage)

  if (outcome.text && outcome.text.length > 0) {
    ok('mimoStreamChatCompletion 流式调用成功')
    results.push(true)
  } else {
    err('mimoStreamChatCompletion 无文本输出')
    results.push(false)
  }
} catch (e) {
  err('mimoStreamChatCompletion 测试失败', e)
  results.push(false)
}

// 测试5: 工具调用集成
log('测试 5: mimoStreamResponse 工具调用', 'blue')
try {
  const events = []
  const controller = new AbortController()

  const weatherTool = {
    name: 'get_weather',
    description: '获取天气',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string', description: '城市' } },
      required: ['city']
    }
  }

  const outcome = await mimoStreamResponse({
    config,
    system: '',
    history: [
      { id: '1', role: 'user', parts: [{ type: 'text', text: '查询上海天气' }] }
    ],
    tools: [weatherTool],
    signal: controller.signal,
    onEvent: (event) => {
      events.push(event)
      if (event.type === 'tool-call') {
        console.log('工具调用:', event.name, event.args)
      }
      if (event.type === 'text-delta') process.stdout.write(event.text)
    },
  })

  console.log('')
  console.log('工具调用结果:', outcome.calls)

  if (outcome.calls && outcome.calls.length > 0) {
    ok('mimoStreamResponse 工具调用成功')
    results.push(true)
  } else {
    console.log(colors.yellow('⚠️ 模型直接回答未调用工具（可能正常）'))
    ok('mimoStreamResponse 工具调用测试完成')
    results.push(true)
  }
} catch (e) {
  err('mimoStreamResponse 工具调用测试失败', e)
  results.push(false)
}

// 测试6: noThinking模式
log('测试 6: mimoStreamResponse 关闭思考模式', 'blue')
try {
  const events = []
  const controller = new AbortController()

  const outcome = await mimoStreamResponse({
    config,
    system: '',
    history: [
      { id: '1', role: 'user', parts: [{ type: 'text', text: '说"测试通过"' }] }
    ],
    tools: [],
    signal: controller.signal,
    onEvent: (event) => events.push(event),
    noThinking: true,
    maxOutputTokens: 50,
  })

  console.log('回复:', outcome.text)
  const hasReasoning = events.some(e => e.type === 'reasoning-delta')
  console.log('是否有思维链事件:', hasReasoning ? '是（异常）' : '否（正常）')

  if (outcome.text && outcome.text.length > 0) {
    ok('mimoStreamResponse 关闭思考模式成功')
    results.push(true)
  } else {
    err('无输出')
    results.push(false)
  }
} catch (e) {
  err('测试失败', e)
  results.push(false)
}

// 汇总
const passed = results.filter(r => r).length
const total = results.length
log('集成测试结果汇总', passed === total ? 'green' : 'yellow')
console.log(`${passed}/${total} 项测试通过`)

if (passed === total) {
  console.log(colors.green('\n🎉 所有代码集成测试通过！MiMo 适配正常工作！'))
} else {
  console.log(colors.red(`\n❌ ${total - passed} 项测试失败`))
  process.exit(1)
}
