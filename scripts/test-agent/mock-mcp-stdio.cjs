/**
 * Mock MCP stdio 服务器 —— 测试专用
 * 新行分隔 JSON-RPC 2.0(与生产客户端协议一致):
 * - initialize → protocolVersion 2024-11-05
 * - tools/list → 固定工具集(含 object/非 object schema、重名 sanitize 用例、
 *   错误工具、自杀工具、图像工具)
 * - tools/call → 按工具名返回:echo 回显参数 / fail_always 服务端 isError /
 *   crash_me 自杀(测客户端自动重启)/ image 返回图像内容块
 * - 首次启动把 pid 写入 MOCK_PID_FILE(测并发 connect 只拉起一个进程)
 */
const readline = require('node:readline')

const pidFile = process.env.MOCK_PID_FILE
if (pidFile) {
  const fs = require('node:fs')
  fs.writeFileSync(pidFile, String(process.pid))
}

const TOOLS = [
  { name: 'read_file', description: 'mock read file', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'echo', description: 'mock echo text', inputSchema: { type: 'string', description: '任意文本' } },
  { name: 'fail_always', description: 'mock failing tool', inputSchema: { type: 'object', properties: {} } },
  { name: 'crash_me', description: 'mock crash tool', inputSchema: { type: 'object', properties: {} } },
  { name: 'image', description: 'mock image tool', inputSchema: { type: 'object', properties: {} } },
  { name: 'read-file', description: 'sanitize 重名用例(与 read_file 同名)', inputSchema: { type: 'object', properties: {} } },
]

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (!line.trim()) return
  if (process.env.MOCK_DEBUG === '1') console.error(`[mock] <= ${line.slice(0, 120)}`)
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg.method === 'initialize') {
    send({ id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'mock-stdio', version: '1.0.0' } } })
    return
  }
  if (msg.method === 'notifications/initialized') return
  if (msg.method === 'tools/list') {
    send({ id: msg.id, result: { tools: TOOLS } })
    return
  }
  if (msg.method === 'tools/call') {
    const { name, arguments: args } = msg.params ?? {}
    if (name === 'crash_me') {
      process.exit(1) // 自杀:测客户端进程退出检测与自动重启
      return
    }
    if (name === 'echo') {
      send({ id: msg.id, result: { content: [{ type: 'text', text: `echo:${JSON.stringify(args ?? {})}` }] } })
      return
    }
    if (name === 'fail_always') {
      send({ id: msg.id, result: { content: [{ type: 'text', text: 'boom' }], isError: true } })
      return
    }
    if (name === 'image') {
      send({ id: msg.id, result: { content: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }] } })
      return
    }
    send({ id: msg.id, result: { content: [{ type: 'text', text: `called:${name}` }] } })
    return
  }
  // 未知方法:Method not found
  send({ id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } })
})

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}
