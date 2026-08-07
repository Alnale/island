/**
 * MCP(Model Context Protocol)客户端 —— 零第三方依赖手写实现,双传输
 *
 * 参考 opencode 源码(internal/llm/agent/mcp-tools.go)的 MCP 设计:
 * - 支持 stdio(本地进程)与 sse(远程端点)两种传输,配置同构
 *   (type/command/args/env/url/headers);
 * - 工具命名 <服务名>_<工具名>(本项目加 mcp_ 前缀防与内置工具冲突);
 * - 每次调用独立连接是 opencode 的做法——本项目改为**常驻进程/流复用**
 *   (连接一次反复调用,崩溃自动重启,调用间零握手开销,更适合桌面常驻)。
 *
 * 协议:JSON-RPC 2.0。
 * - stdio:stdin/stdout 每行一条消息(换行分隔,非 LSP 的 Content-Length 帧);
 * - sse:GET 端点建立事件流(endpoint 事件给出 POST 回传端点),请求 POST
 *   回传端点,响应经同一事件流推送(按 id 匹配)。
 * 握手:initialize → notifications/initialized → tools/list;调用 tools/call。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { MCP_SERVICE_LABEL_PREFIX } from './constants'
import type { AgentTool, McpServerConfig } from './types'

/** 握手初始化超时(ms):npx 首次运行 / 服务器启动慢 */
const INIT_TIMEOUT_MS = 15_000
/** 工具调用超时(ms):引擎层还有 60s 兜底,这里是 JSON-RPC 响应超时 */
const CALL_TIMEOUT_MS = 55_000
/** 工具调用结果文本最大长度(防超大输出撑爆上下文/UI) */
const RESULT_MAX = 8000
/** 工具描述注入 LLM 上下文的最大长度 */
const DESC_MAX = 400

/** 服务/工具名 → 安全工具名(仅 [a-z0-9_],LLM 工具名约束) */
function sanitizeName(raw: string, fallback: string): string {
  const s = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return s || fallback
}

/** JSON-RPC 响应回调 */
interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

/** 服务端原始工具 */
interface RawTool {
  name: string
  description: string
  inputSchema: unknown
}

/** 传输客户端公共接口(stdio 子进程 / sse 远程端点) */
interface Transport {
  /** 是否已连接且存活(进程/流) */
  readonly alive: boolean
  /** 启动/重连并完成握手 */
  connect(): Promise<void>
  /** 调用工具(返回格式化文本) */
  callTool(name: string, args: Record<string, unknown>): Promise<string>
  /** 返回已缓存的工具清单(连接后) */
  listRawTools(): Promise<RawTool[]>
  /** 彻底关闭(销毁进程/断开流) */
  kill(): void
}

/** JSON-RPC 公共请求/响应逻辑(stdio 与 sse 复用) */
class RpcCore {
  private nextId = 1
  protected pending = new Map<number, PendingRequest>()
  protected ready = false
  protected tools: RawTool[] = []
  /** 连接互斥:并行工具调用会并发 connect,不加锁会重复拉起连接 */
  protected connectPromise: Promise<void> | null = null

  protected requestImpl(
    send: (id: number) => void,
    timeoutMs: number,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      // id 由本方法分配并传给 send:调用方发送与等待必须用同一个 id
      // (重构时曾出现 send 回调里重读 nextId → 发送 id 与 pending id
      // 错位,所有响应匹配不上、请求挂到超时,测试实测)
      const id = this.nextId++
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP 请求超时(${Math.round(timeoutMs / 1000)}s)`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        send(id)
      } catch (err) {
        // 发送前同步失败(进程未运行/端点未就绪):立即拒绝
        this.pending.delete(id)
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  protected failAll(message: string) {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error(message))
      this.pending.delete(id)
    }
  }

  protected settle(id: number, result: unknown, error: unknown) {
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    clearTimeout(p.timer)
    if (error) p.reject(new Error(formatRpcError(error)))
    else p.resolve(result)
  }

  /** 握手 + 拉取工具清单(initialize → initialized → tools/list) */
  protected async handshake(
    doInitialize: () => Promise<unknown>,
    notify: (method: string) => void,
    doList: () => Promise<unknown>,
  ): Promise<void> {
    await doInitialize()
    notify('notifications/initialized')
    const listRes = (await doList()) as { tools?: unknown[] }
    this.tools = Array.isArray(listRes?.tools)
      ? listRes.tools
          .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
          .map((t) => ({
            name: String(t.name ?? ''),
            description: typeof t.description === 'string' ? t.description : '',
            inputSchema: t.inputSchema ?? { type: 'object' },
          }))
          .filter((t) => t.name)
      : []
    this.ready = true
  }
}

// ---------------------------------------------------------------------------
// stdio 传输:子进程,每行一条 JSON-RPC
// ---------------------------------------------------------------------------

class StdioClient extends RpcCore implements Transport {
  private child: ChildProcess | null = null
  private buf = ''
  private lastError = ''
  private spawnError = false

  constructor(
    private cfg: McpServerConfig,
    private onLog: (msg: string) => void,
  ) {
    super()
  }

  get alive(): boolean {
    return this.child !== null && this.child.exitCode === null && !this.spawnError
  }

  connect(): Promise<void> {
    if (this.ready && this.alive) return Promise.resolve()
    if (!this.connectPromise) this.connectPromise = this.doConnect()
    return this.connectPromise.finally(() => {
      this.connectPromise = null
    })
  }

  private async doConnect(): Promise<void> {
    if (!this.cfg.command.trim()) throw new Error('MCP 服务缺少启动命令')
    this.buf = ''
    this.ready = false
    this.spawnError = false
    this.tools = []
    this.lastError = ''

    // Windows 上 .cmd/.bat(如 npx/npm)必须经 cmd.exe 宿主启动
    // (CreateProcess 无法直接执行 .cmd);node/python/绝对路径 .exe 直接起。
    // 裸命令名不带 .exe 后缀(如 npx)也走 cmd 宿主,由 PATH 解析。
    // 注意:cmd /c 会把参数里的 %VAR% 当环境变量展开,路径含 % 需用引号
    const cmd = this.cfg.command.trim()
    const needCmdHost = process.platform === 'win32' && !/\.exe$/i.test(cmd)
    const command = needCmdHost ? 'cmd.exe' : cmd
    const args = needCmdHost ? ['/d', '/c', cmd, ...(this.cfg.args ?? [])] : (this.cfg.args ?? [])
    this.onLog(`[mcp] 启动服务 ${this.cfg.name}:${command} ${args.join(' ')}`)

    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(this.cfg.env ?? {}) },
    })
    this.child = child
    child.stderr?.on('data', (d: Buffer) => this.onLog(`[mcp:${this.cfg.name}] stderr:${d.toString().trim()}`))
    child.on('error', (err: Error) => {
      // 启动失败(ENOENT 等):标记错误,拒绝所有挂起请求
      this.spawnError = true
      this.lastError = `无法启动 MCP 服务进程:${err.message}`
      this.onLog(`[mcp:${this.cfg.name}] 启动失败:${err.message}`)
      this.failAll(this.lastError)
      this.child = null
    })
    child.on('exit', (code, signal) => {
      this.onLog(`[mcp:${this.cfg.name}] 进程退出(code=${code}, signal=${signal})`)
      this.ready = false
      // 进程意外退出:挂起的请求立刻失败(等待中的调用不至于干等超时)
      this.failAll(`MCP 服务进程已退出(退出码 ${code ?? signal ?? '?'}),将自动重启`)
      if (this.child === child) this.child = null
    })
    child.stdout?.on('data', (d: Buffer) => this.onData(d.toString()))

    try {
      await this.handshake(
        () => this.request('initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'dynamic-island-agent', version: '1.0.0' },
        }),
        (method) => this.sendLine(JSON.stringify({ jsonrpc: '2.0', method })),
        () => this.request('tools/list', {}),
      )
      this.onLog(`[mcp:${this.cfg.name}] 握手成功,${this.tools.length} 个工具`)
    } catch (err) {
      // 握手失败(超时/协议错误):清理子进程,上层可重试
      this.ready = false
      this.failAll((err as Error).message)
      this.kill()
      throw err
    }
  }

  /** stdout 换行分隔解析:每行一条 JSON-RPC 消息 */
  private onData(chunk: string) {
    this.buf += chunk
    for (;;) {
      const nl = this.buf.indexOf('\n')
      if (nl === -1) break
      const line = this.buf.slice(0, nl).trim()
      this.buf = this.buf.slice(nl + 1)
      if (!line) continue
      let msg: { id?: unknown; method?: string; result?: unknown; error?: unknown; params?: unknown }
      try {
        msg = JSON.parse(line)
      } catch {
        // 非 JSON 行(如 npx 的横幅输出):忽略,不打断协议
        this.onLog(`[mcp:${this.cfg.name}] 忽略非 JSON 输出:${line.slice(0, 120)}`)
        continue
      }
      if (typeof msg?.id === 'number' && msg.method === undefined) {
        this.settle(msg.id, msg.result, msg.error)
      } else if (msg?.method === 'notifications/message') {
        // 服务端日志通知:打日志,不回响应
        const p = msg.params as { level?: string; message?: string }
        this.onLog(`[mcp:${this.cfg.name}] ${p?.level ?? 'log'}:${String(p?.message ?? '')}`)
      } else if (typeof msg?.id !== 'undefined' && msg?.method) {
        // 服务端发来的请求:本客户端不支持,回 Method not found
        this.sendLine(
          JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32601, message: `Method not found: ${msg.method}` },
          }),
        )
      }
    }
  }

  /** 发送 JSON-RPC 请求并等待响应(超时按类型区分) */
  private request(method: string, params: unknown, timeoutMs = INIT_TIMEOUT_MS): Promise<unknown> {
    return this.requestImpl((id) => {
      if (!this.child || !this.child.stdin || this.child.stdin.destroyed) {
        throw new Error(this.spawnError ? this.lastError : 'MCP 服务进程未运行')
      }
      this.sendLine(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          method,
          params: params === undefined ? {} : params,
        }),
      )
    }, timeoutMs)
  }

  private sendLine(line: string) {
    try {
      this.child?.stdin?.write(line + '\n')
    } catch {
      // stdin 已损坏:忽略,上层超时兜底
    }
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    await this.connect()
    const res = (await this.request('tools/call', { name, arguments: args ?? {} }, CALL_TIMEOUT_MS)) as {
      content?: unknown[]
      isError?: boolean
    }
    return settleToolResult(res)
  }

  async listRawTools(): Promise<RawTool[]> {
    await this.connect()
    return this.tools
  }

  kill() {
    this.ready = false
    this.failAll('MCP 服务已关闭')
    const child = this.child
    this.child = null
    if (!child || child.exitCode !== null) return
    // Windows 上 npx 经 cmd 宿主启动,直接 kill 只能杀 cmd,子进程树残留;
    // taskkill /T 连子孙进程一起结束(进程是自己启动的,杀树安全)
    try {
      if (process.platform === 'win32') {
        const { execFileSync } = require('node:child_process') as typeof import('node:child_process')
        execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      } else {
        child.kill()
      }
    } catch {
      child.kill()
    }
  }
}

// ---------------------------------------------------------------------------
// sse 传输:GET 建立事件流(endpoint 事件),请求 POST 回传端点
// (参考 opencode 的 mark3labs/mcp-go SSE 语义)
// ---------------------------------------------------------------------------

class SseClient extends RpcCore implements Transport {
  private aborter: AbortController | null = null
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  private endpoint = ''
  private streamEnded = false

  constructor(
    private cfg: McpServerConfig,
    private onLog: (msg: string) => void,
  ) {
    super()
  }

  get alive(): boolean {
    return this.reader !== null && !this.streamEnded
  }

  connect(): Promise<void> {
    if (this.ready && this.alive) return Promise.resolve()
    if (!this.connectPromise) this.connectPromise = this.doConnect()
    return this.connectPromise.finally(() => {
      this.connectPromise = null
    })
  }

  private async doConnect(): Promise<void> {
    const url = String(this.cfg.url ?? '').trim()
    if (!/^https?:\/\//i.test(url)) throw new Error('sse 服务需要 http/https 端点 URL')
    this.endpoint = ''
    this.ready = false
    this.streamEnded = false
    this.tools = []
    this.aborter = new AbortController()
    this.onLog(`[mcp] 连接 sse 服务 ${this.cfg.name}:${url}`)

    // 1. GET 建立事件流(endpoint 事件携带 POST 回传端点,通常带 session)
    let res: Response
    try {
      res = await fetch(url, {
        headers: { Accept: 'text/event-stream', ...(this.cfg.headers ?? {}) },
        signal: this.aborter.signal,
      })
    } catch (err) {
      throw new Error(`sse 连接失败:${(err as Error).message}`)
    }
    if (!res.ok) throw new Error(`sse 端点返回 HTTP ${res.status}`)
    if (!res.body) throw new Error('sse 端点无响应流')
    const reader = res.body.getReader()
    this.reader = reader
    void this.readLoop(reader)

    // 2. 等 endpoint(握手前置;轮询 50ms,总超时 INIT_TIMEOUT)
    const deadline = Date.now() + INIT_TIMEOUT_MS
    while (!this.endpoint) {
      if (Date.now() > deadline) {
        this.kill()
        throw new Error('sse 连接超时:未收到 endpoint(确认端点支持 MCP SSE)')
      }
      if (this.streamEnded) {
        this.kill()
        throw new Error('sse 连接已断开(端点未发送 endpoint)')
      }
      await new Promise((r) => setTimeout(r, 50))
    }

    // 3. 握手(与 stdio 相同语义)
    try {
      await this.handshake(
        () => this.request('initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'dynamic-island-agent', version: '1.0.0' },
        }),
        (method) => this.post({ jsonrpc: '2.0', method }),
        () => this.request('tools/list', {}),
      )
      this.onLog(`[mcp:${this.cfg.name}] sse 握手成功,${this.tools.length} 个工具`)
    } catch (err) {
      this.ready = false
      this.failAll((err as Error).message)
      this.kill()
      throw err
    }
  }

  /** 事件流读取循环:按空行分帧,event/data 解析 */
  private async readLoop(reader: ReadableStreamDefaultReader<Uint8Array>) {
    const decoder = new TextDecoder()
    let frame = ''
    let currentEvent = ''
    let dataLines: string[] = []
    for (;;) {
      let done = false
      let value: Uint8Array | undefined
      try {
        const r = await reader.read()
        done = r.done
        value = r.value
      } catch {
        done = true
      }
      if (done) {
        this.streamEnded = true
        this.failAll('sse 连接已断开,将自动重连')
        this.onLog(`[mcp:${this.cfg.name}] sse 流结束`)
        break
      }
      frame += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = frame.indexOf('\n\n')) !== -1) {
        const block = frame.slice(0, nl)
        frame = frame.slice(nl + 2)
        // 兼容 \r\n\r\n 分帧
        const clean = block.replace(/\r\n/g, '\n')
        for (const line of clean.split('\n')) {
          if (line.startsWith('event:')) currentEvent = line.slice(6).trim()
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
        }
        if (dataLines.length > 0) {
          this.handleFrame(currentEvent, dataLines.join('\n'))
          currentEvent = ''
          dataLines = []
        }
      }
    }
  }

  private handleFrame(event: string, data: string) {
    if (event === 'endpoint') {
      this.endpoint = data.trim()
      return
    }
    if (event === 'ping') return
    // 响应消息:多数实现 event: message;兼容无 event 时 data 即 JSON
    let msg: { id?: unknown; method?: string; result?: unknown; error?: unknown }
    try {
      msg = JSON.parse(data)
    } catch {
      return // 非 JSON 数据忽略
    }
    if (typeof msg?.id === 'number' && msg.method === undefined) {
      this.settle(msg.id, msg.result, msg.error)
    }
  }

  /** POST 回传端点(请求;响应走事件流) */
  private request(method: string, params: unknown, timeoutMs = INIT_TIMEOUT_MS): Promise<unknown> {
    return this.requestImpl((id) => {
      this.post({ jsonrpc: '2.0', id, method, params: params === undefined ? {} : params })
        .catch((err: Error) => {
          const p = this.pending.get(id)
          if (!p) return
          this.pending.delete(id)
          clearTimeout(p.timer)
          p.reject(new Error(`sse 请求失败:${err.message}`))
        })
    }, timeoutMs)
  }

  /** POST 发送(通知无响应;请求的响应走事件流,响应体通常为空) */
  private async post(body: Record<string, unknown>): Promise<void> {
    if (!this.endpoint) throw new Error('sse 端点未就绪')
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(this.cfg.headers ?? {}) },
      body: JSON.stringify(body),
      signal: this.aborter?.signal,
    })
    if (!res.ok) throw new Error(`sse 回传 HTTP ${res.status}`)
    // 部分实现直接返回结果体:有 id 的 JSON 就按响应处理
    const text = await res.text()
    if (text.trim() && typeof body.id === 'number') {
      try {
        const m = JSON.parse(text) as { id?: unknown; result?: unknown; error?: unknown }
        if (m && m.id === body.id) this.settle(body.id, m.result, m.error)
      } catch {
        // 响应体非 JSON,忽略
      }
    }
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    await this.connect()
    const res = (await this.request('tools/call', { name, arguments: args ?? {} }, CALL_TIMEOUT_MS)) as {
      content?: unknown[]
      isError?: boolean
    }
    return settleToolResult(res)
  }

  async listRawTools(): Promise<RawTool[]> {
    await this.connect()
    return this.tools
  }

  kill() {
    this.ready = false
    this.endpoint = ''
    this.failAll('MCP 服务已关闭')
    this.aborter?.abort()
    this.aborter = null
    const reader = this.reader
    this.reader = null
    reader?.cancel().catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// 公共:结果格式化 / 参数转换 / 管理器
// ---------------------------------------------------------------------------

/** MCP content 块 → 文本(文本块拼内容;图片/二进制资源只标注,不塞 base64) */
function formatToolResult(content: unknown[] | undefined): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const b = block as { type?: string; text?: unknown; mimeType?: unknown; data?: unknown; resource?: unknown }
    if (b.type === 'text' && typeof b.text === 'string') {
      parts.push(b.text)
    } else if (b.type === 'image') {
      const len = typeof b.data === 'string' ? Math.ceil((b.data.length * 3) / 4) : 0
      parts.push(`[图像结果 ${String(b.mimeType ?? '')} 约 ${len} 字节]`)
    } else if (b.type === 'resource') {
      const r = (b.resource ?? {}) as { uri?: unknown; text?: unknown; blob?: unknown }
      const uri = String(r.uri ?? '')
      if (typeof r.text === 'string') parts.push(`${uri}:${r.text}`)
      else {
        parts.push(
          `[资源 ${uri} ${String((b as { mimeType?: unknown }).mimeType ?? '')} 二进制 ${typeof r.blob === 'string' ? r.blob.length : 0}]`,
        )
      }
    } else {
      parts.push(JSON.stringify(block))
    }
  }
  return parts.join('\n').slice(0, RESULT_MAX)
}

/** tools/call 结果收口:格式化 + isError 抛错(引擎按"工具执行失败"回填) */
function settleToolResult(res: { content?: unknown[]; isError?: boolean }): string {
  const text = formatToolResult(res?.content)
  if (res?.isError) throw new Error(text || 'MCP 工具返回失败(无错误信息)')
  return text || '(工具返回空)'
}

/** JSON-RPC 错误对象 → 可读文本 */
function formatRpcError(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { code?: unknown; message?: unknown; data?: unknown }
    const data = e.data !== undefined ? `:${JSON.stringify(e.data).slice(0, 200)}` : ''
    return `MCP 错误(${String(e.code ?? '?')})${e.message ? `:${String(e.message)}` : ''}${data}`
  }
  return `MCP 错误:${String(err)}`
}

/** MCP inputSchema → 引擎 AgentTool.parameters(确保 object + properties) */
function toToolParameters(inputSchema: unknown): AgentTool['parameters'] {
  if (inputSchema && typeof inputSchema === 'object' && !Array.isArray(inputSchema)) {
    const schema = inputSchema as Record<string, unknown>
    if (schema.type === 'object' && schema.properties && typeof schema.properties === 'object') {
      return {
        type: 'object',
        properties: schema.properties as Record<string, unknown>,
        required: Array.isArray(schema.required) ? (schema.required as string[]) : undefined,
      }
    }
    // 非 object 模式(如纯字符串入参):包一层 input 字段
    return {
      type: 'object',
      properties: { input: { ...schema, description: `入参(${String(schema.description ?? '')})` } },
    }
  }
  return { type: 'object', properties: {} }
}

/**
 * MCP 管理器:按配置持有各服务客户端,把服务端工具注册为
 * mcp_<服务名>_<工具名> 的 AgentTool(execute 委托 tools/call)。
 */
export function createMCPManager() {
  /** 服务配置 → 客户端(配置变化即断开重连) */
  const clients = new Map<string, Transport>()
  const log = (msg: string) => console.log(msg)

  const keyOf = (cfg: McpServerConfig) =>
    JSON.stringify([cfg.name, cfg.type, cfg.command, cfg.args ?? [], cfg.env ?? {}, cfg.url ?? '', cfg.headers ?? {}])

  /** 当前配置的客户端;配置变更(增删改)时旧客户端销毁 */
  function prune(servers: McpServerConfig[]) {
    const keys = new Set(servers.map(keyOf))
    for (const [key, client] of clients) {
      if (!keys.has(key)) {
        client.kill()
        clients.delete(key)
      }
    }
  }

  function clientFor(cfg: McpServerConfig): Transport {
    const key = keyOf(cfg)
    let client = clients.get(key)
    if (!client) {
      // 双传输:opencode 同构配置 —— type=sse 走远程端点,否则本地进程
      client = cfg.type === 'sse' ? new SseClient(cfg, log) : new StdioClient(cfg, log)
      clients.set(key, client)
    }
    return client
  }

  /** 合并全部服务工具为 AgentTool[];失败的服务静默跳过(调用时报错) */
  async function listTools(servers: McpServerConfig[]): Promise<AgentTool[]> {
    prune(servers)
    const tools: AgentTool[] = []
    const usedNames = new Set<string>()
    for (const cfg of servers) {
      const serverName = sanitizeName(cfg.name, 'server')
      let raw: RawTool[] = []
      try {
        raw = await clientFor(cfg).listRawTools()
      } catch (err) {
        log(`[mcp] 服务 ${cfg.name} 连接失败:${(err as Error).message}`)
        continue
      }
      for (const t of raw) {
        const toolName = sanitizeName(t.name, 'tool')
        if (!toolName) continue
        // 重名兜底:同工具名加序号(理论不会出现,防御)
        let full = `mcp_${serverName}_${toolName}`
        let n = 2
        while (usedNames.has(full)) full = `mcp_${serverName}_${toolName}_${n++}`
        usedNames.add(full)
        const desc = String(t.description ?? '').trim().replace(/\s+/g, ' ').slice(0, DESC_MAX)
        tools.push({
          name: full,
          // 描述前缀与渲染端剥除共用常量(垂直解耦:格式变更只改 constants)
          description: `${MCP_SERVICE_LABEL_PREFIX}${cfg.name}] ${desc || '(无描述)'}。调用参数按 JSON Schema 填写,结果由服务端返回。`,
          parameters: toToolParameters(t.inputSchema),
          async execute(params) {
            // 每次调用前确保连接(崩溃自动重启;sse 断流自动重连)
            const c = clientFor(cfg)
            await c.connect()
            return c.callTool(t.name, params)
          },
        })
      }
    }
    return tools
  }

  /** 测试服务连通(独立连接 → 列工具 → 立即销毁;不进入常驻缓存) */
  async function test(cfg: McpServerConfig): Promise<{ ok: boolean; error?: string; toolCount?: number }> {
    const client = cfg.type === 'sse' ? new SseClient(cfg, log) : new StdioClient(cfg, log)
    try {
      const tools = await client.listRawTools()
      return { ok: true, toolCount: tools.length }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    } finally {
      client.kill()
    }
  }

  /** 销毁全部客户端(应用退出/引擎销毁时调用) */
  function dispose() {
    for (const client of clients.values()) client.kill()
    clients.clear()
  }

  return { listTools, test, dispose }
}

export type MCPManager = ReturnType<typeof createMCPManager>
