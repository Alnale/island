/**
 * Mock MCP SSE 服务器 —— 测试专用
 * 标准 MCP SSE 传输:
 * - GET /sse → 事件流长连接,立即发 endpoint 事件(POST 回传端点 /mcp)
 * - POST /mcp → 请求响应经事件流推送(event: message);env MOCK_DIRECT_RESPONSE=1
 *   时改为在 POST 响应体直接返回(覆盖生产客户端"兼容直接响应"路径)
 * - GET /health → 200(测试等待就绪)
 * 工具集与 stdio mock 一致(echo / fail_always)
 */
const http = require('node:http')

// port 必须可变:listen 回调里回写实际端口(endpoint 事件用真实端口,
// 否则 MOCK_PORT=0 随机分配时 endpoint 会通知 :0 导致客户端连不上)
let port = Number(process.env.MOCK_PORT) || 0
/** 推送风格:event = 带 event: message 行;bare = 只发 data 行(兼容变体) */
const pushStyle = process.env.MOCK_PUSH_STYLE || 'event'
const directResponse = process.env.MOCK_DIRECT_RESPONSE === '1'

let pushSink = null // 当前连接的响应写入器

const TOOLS = [
  { name: 'echo', description: 'mock sse echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
  { name: 'fail_always', description: 'mock sse failing', inputSchema: { type: 'object', properties: {} } },
]

function sendFrame(res, event, data) {
  if (pushStyle === 'bare') res.write(`data: ${JSON.stringify(data)}\n\n`)
  else res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

const server = http.createServer((req, res) => {
  const url = req.url || ''
  if (url === '/health') {
    res.writeHead(200)
    res.end('ok')
    return
  }
  if (url === '/sse') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    pushSink = res
    const endpoint = `http://127.0.0.1:${port}/mcp`
    res.write(`event: endpoint\ndata: ${endpoint}\n\n`)
    req.on('close', () => {
      if (pushSink === res) pushSink = null
    })
    return
  }
  if (url === '/mcp') {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      let msg
      try {
        msg = JSON.parse(body)
      } catch {
        res.writeHead(400)
        res.end('bad json')
        return
      }
      let result
      if (msg.method === 'initialize') {
        result = { id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'mock-sse', version: '1.0.0' } } }
      } else if (msg.method === 'tools/list') {
        result = { id: msg.id, result: { tools: TOOLS } }
      } else if (msg.method === 'tools/call') {
        const name = msg.params?.name
        if (name === 'fail_always') result = { id: msg.id, result: { content: [{ type: 'text', text: 'sse boom' }], isError: true } }
        else result = { id: msg.id, result: { content: [{ type: 'text', text: `sse echo:${JSON.stringify(msg.params?.arguments ?? {})}` }] } }
      } else if (typeof msg.id === 'number') {
        result = { id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } }
      }
      if (directResponse) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result ?? {}))
        return
      }
      res.writeHead(200)
      res.end('')
      if (pushSink && result && typeof result.id === 'number') {
        sendFrame(pushSink, 'message', result)
      }
    })
    return
  }
  res.writeHead(404)
  res.end()
})

server.listen(port, '127.0.0.1', () => {
  port = server.address().port
  console.log(`MOCK_SSE_PORT=${port}`)
})
