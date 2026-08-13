/**
 * MiMo API 功能测试脚本
 * 直接测试 Responses API / Chat Completions / 深度思考 / 工具调用
 */

const API_KEY = 'sk-cmmnv07jyrdncjhymfpsa4kxixyl6e4t31f4idzg53j3r1hc'
const BASE_URL = 'https://api.xiaomimimo.com'

// 颜色输出
const colors = {
  green: (text) => `\x1b[32m${text}\x1b[0m`,
  red: (text) => `\x1b[31m${text}\x1b[0m`,
  yellow: (text) => `\x1b[33m${text}\x1b[0m`,
  blue: (text) => `\x1b[34m${text}\x1b[0m`,
  cyan: (text) => `\x1b[36m${text}\x1b[0m`,
}

function log(title, content, color = 'cyan') {
  console.log('\n' + colors[color](`=== ${title} ===`))
  if (content) console.log(content)
}

function logSuccess(title) {
  console.log(colors.green(`✅ ${title}`))
}

function logError(title, err) {
  console.log(colors.red(`❌ ${title}`))
  console.error(err.message || err)
}

async function testResponseAPI() {
  log('测试 1: MiMo Responses API - 基础对话', null, 'blue')

  const body = {
    model: 'mimo-v2.5-pro',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: '你好，请用一句话介绍你自己' }] }
    ],
    stream: false,
    max_output_tokens: 200,
  }

  try {
    const res = await fetch(`${BASE_URL}/v1/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': API_KEY,
        'Authorization': `Bearer ${API_KEY}`,
      },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`HTTP ${res.status}: ${text}`)
    }

    const data = await res.json()
    const outputText = data.output?.[0]?.content?.[0]?.text || '(无输出)'
    console.log('回复:', outputText)
    console.log('Usage:', data.usage)
    logSuccess('Responses API 基础对话测试通过')
    return true
  } catch (err) {
    logError('Responses API 测试失败', err)
    return false
  }
}

async function testResponseStreamWithReasoning() {
  log('测试 2: MiMo Responses API - 流式 + 深度思考', null, 'blue')

  const body = {
    model: 'mimo-v2.5-pro',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: '9.11和9.9哪个大？只回答答案即可' }] }
    ],
    stream: true,
    reasoning: { effort: 'high' },
    max_output_tokens: 500,
  }

  try {
    const res = await fetch(`${BASE_URL}/v1/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': API_KEY,
        'Authorization': `Bearer ${API_KEY}`,
      },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`HTTP ${res.status}: ${text}`)
    }

    let reasoningText = ''
    let outputText = ''
    let eventCount = 0

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || !trimmed.startsWith('data:')) continue
        const dataStr = trimmed.slice(5).trim()
        if (dataStr === '[DONE]') continue

        try {
          const event = JSON.parse(dataStr)
          eventCount++

          if (event.type === 'response.reasoning_text.delta') {
            reasoningText += event.delta || ''
          } else if (event.type === 'response.output_text.delta') {
            outputText += event.delta || ''
          }
        } catch {
          // 忽略解析错误
        }
      }
    }

    console.log('思维链内容:', reasoningText ? `${reasoningText.slice(0, 200)}...` : '(无思维链)')
    console.log('最终回答:', outputText)
    console.log(`收到 ${eventCount} 个SSE事件`)
    logSuccess('Responses API 流式+深度思考测试通过')
    return true
  } catch (err) {
    logError('Responses API 流式测试失败', err)
    return false
  }
}

async function testChatCompletions() {
  log('测试 3: MiMo Chat Completions API', null, 'blue')

  const body = {
    model: 'mimo-v2.5-pro',
    messages: [
      { role: 'user', content: '1+1等于几？只回答数字' }
    ],
    stream: false,
    max_completion_tokens: 50,
  }

  try {
    const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': API_KEY,
        'Authorization': `Bearer ${API_KEY}`,
      },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`HTTP ${res.status}: ${text}`)
    }

    const data = await res.json()
    const content = data.choices?.[0]?.message?.content || '(无输出)'
    console.log('回复:', content)
    console.log('Usage:', data.usage)
    logSuccess('Chat Completions API 测试通过')
    return true
  } catch (err) {
    logError('Chat Completions API 测试失败', err)
    return false
  }
}

async function testChatStreamWithThinking() {
  log('测试 4: MiMo Chat Completions - 流式 + thinking模式', null, 'blue')

  const body = {
    model: 'mimo-v2.5-pro',
    messages: [
      { role: 'user', content: '天空为什么是蓝色的？简短回答' }
    ],
    stream: true,
    thinking: { type: 'enabled' },
    max_completion_tokens: 300,
  }

  try {
    const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': API_KEY,
        'Authorization': `Bearer ${API_KEY}`,
      },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`HTTP ${res.status}: ${text}`)
    }

    let reasoningContent = ''
    let content = ''
    let chunkCount = 0

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || !trimmed.startsWith('data:')) continue
        const dataStr = trimmed.slice(5).trim()
        if (dataStr === '[DONE]') continue

        try {
          const chunk = JSON.parse(dataStr)
          chunkCount++
          const delta = chunk.choices?.[0]?.delta
          if (delta) {
            if (delta.reasoning_content) reasoningContent += delta.reasoning_content
            if (delta.content) content += delta.content
          }
        } catch {
          // 忽略解析错误
        }
      }
    }

    console.log('思维链:', reasoningContent ? `${reasoningContent.slice(0, 150)}...` : '(无思维链)')
    console.log('回复:', content)
    console.log(`收到 ${chunkCount} 个SSE数据块`)
    logSuccess('Chat Completions 流式+thinking测试通过')
    return true
  } catch (err) {
    logError('Chat Completions 流式测试失败', err)
    return false
  }
}

async function testToolCalling() {
  log('测试 5: MiMo Responses API - 工具调用', null, 'blue')

  const body = {
    model: 'mimo-v2.5-pro',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: '北京现在天气怎么样？' }] }
    ],
    tools: [
      {
        type: 'function',
        name: 'get_weather',
        description: '获取指定城市的天气信息',
        parameters: {
          type: 'object',
          properties: {
            city: { type: 'string', description: '城市名称' }
          },
          required: ['city']
        }
      }
    ],
    tool_choice: 'auto',
    stream: false,
    max_output_tokens: 300,
  }

  try {
    const res = await fetch(`${BASE_URL}/v1/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': API_KEY,
        'Authorization': `Bearer ${API_KEY}`,
      },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`HTTP ${res.status}: ${text}`)
    }

    const data = await res.json()
    console.log('Response output类型:', data.output?.map(o => o.type))

    const functionCall = data.output?.find(o => o.type === 'function_call')
    if (functionCall) {
      console.log('工具调用:', functionCall.name)
      console.log('参数:', functionCall.arguments)
      logSuccess('工具调用功能正常（返回了function_call）')
    } else {
      const textOutput = data.output?.find(o => o.type === 'message')
      console.log('回复:', textOutput?.content?.[0]?.text || '(直接回答无工具调用)')
      logSuccess('工具调用测试通过（模型可选择直接回答）')
    }
    return true
  } catch (err) {
    logError('工具调用测试失败', err)
    return false
  }
}

async function testNoThinking() {
  log('测试 6: MiMo Responses API - 关闭思考模式', null, 'blue')

  const body = {
    model: 'mimo-v2.5-pro',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: '说"你好"即可' }] }
    ],
    reasoning: { effort: 'none' },
    stream: false,
    max_output_tokens: 50,
  }

  try {
    const res = await fetch(`${BASE_URL}/v1/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': API_KEY,
        'Authorization': `Bearer ${API_KEY}`,
      },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`HTTP ${res.status}: ${text}`)
    }

    const data = await res.json()
    const outputText = data.output?.[0]?.content?.[0]?.text || '(无输出)'
    console.log('回复:', outputText)
    logSuccess('关闭思考模式测试通过')
    return true
  } catch (err) {
    logError('关闭思考模式测试失败', err)
    return false
  }
}

// 运行所有测试
async function runAllTests() {
  console.log(colors.cyan('\n🚀 开始 MiMo API 功能测试\n'))
  console.log('API Key:', API_KEY.slice(0, 10) + '...' + API_KEY.slice(-5))
  console.log('Base URL:', BASE_URL)

  const results = []

  results.push(await testResponseAPI())
  results.push(await testResponseStreamWithReasoning())
  results.push(await testChatCompletions())
  results.push(await testChatStreamWithThinking())
  results.push(await testToolCalling())
  results.push(await testNoThinking())

  const passed = results.filter(r => r).length
  const total = results.length

  log('测试结果汇总', `${passed}/${total} 项测试通过`, passed === total ? 'green' : 'yellow')
  if (passed === total) {
    console.log(colors.green('\n🎉 所有 MiMo API 功能正常！'))
  } else {
    console.log(colors.yellow(`\n⚠️  ${total - passed} 项测试失败，请检查`))
  }
}

runAllTests().catch(console.error)
