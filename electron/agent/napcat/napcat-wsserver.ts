/**
 * 反向 WebSocket 服务端(2026-10-25)
 *
 * NapCat 反向 WS 模式:本机监听端口,NapCat 主动连入(OneBot 11 双向通道:
 * 事件与动作都走同一条连接)。零依赖,复用 wsclient 的帧解析器,服务端
 * 帧按 RFC6455 不掩码输出。只保留一个活跃连接:新连接到达时静默关闭旧
 * 连接,避免旧 socket 的迟到 close 覆盖新连接状态。
 */

import { createHash } from 'node:crypto'
import net from 'node:net'
import {
  WsFrameParser,
  encodeServerFrame,
  type WsCloseInfo,
  type WsConn,
  type WsFrame,
  type WsHandlers,
  type WsTuning,
} from './wsclient'

const HANDSHAKE_TIMEOUT_MS = 10_000
const KEEPALIVE_INTERVAL_MS = 20_000
const KEEPALIVE_TIMEOUT_MS = 65_000

export interface ReverseWsOptions {
  host: string
  port: number
  /** 期望的 Upgrade 路径(不含查询串) */
  path: string
  /** 期望的 access_token(空 = 不校验) */
  accessToken?: string
  handlers: WsHandlers
  tuning?: WsTuning
}

export interface ReverseWsServer {
  start(): void
  stop(): void
  readonly listening: boolean
  readonly conn: WsConn | null
  /** 实际监听地址(port=0 时取系统分配的端口) */
  readonly address: { host: string; port: number } | null
}

function headerLines(raw: string): { line: string; headers: Map<string, string> } {
  const lines = raw.split('\r\n')
  const headers = new Map<string, string>()
  for (const l of lines.slice(1)) {
    const i = l.indexOf(':')
    if (i <= 0) continue
    headers.set(l.slice(0, i).trim().toLowerCase(), l.slice(i + 1).trim())
  }
  return { line: lines[0] ?? '', headers }
}

function tokenOf(path: string, headers: Map<string, string>): string {
  const q = path.indexOf('?')
  if (q >= 0) {
    const m = /(?:^|&)access_token=([^&]+)/.exec(path.slice(q + 1))
    if (m) return decodeURIComponent(m[1])
  }
  const auth = headers.get('authorization') ?? ''
  const b = /^Bearer\s+(.+)$/i.exec(auth)
  return b ? b[1].trim() : ''
}

export function createReverseWsServer(opts: ReverseWsOptions): ReverseWsServer {
  const handshakeTimeoutMs = opts.tuning?.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS
  const keepaliveIntervalMs = opts.tuning?.keepaliveIntervalMs ?? KEEPALIVE_INTERVAL_MS
  const keepaliveTimeoutMs = opts.tuning?.keepaliveTimeoutMs ?? KEEPALIVE_TIMEOUT_MS
  let server: net.Server | null = null
  let current: WsConn | null = null
  let listening = false
  let stopped = false
  let boundPort = opts.port
  let boundHost = opts.host

  function accept(socket: net.Socket) {
    socket.setNoDelay(true)
    socket.setTimeout(handshakeTimeoutMs, () => {
      if (!opened) socket.destroy()
    })
    let handshaken = false
    let opened = false
    let closedFired = false
    let silentClose = false
    let handshakeBuf = ''
    let closeInfo: WsCloseInfo = {}
    let lastInboundAt = Date.now()
    let keepaliveTimer: ReturnType<typeof setInterval> | null = null
    let fragmentOpcode = 0
    let fragments: Buffer[] = []
    const parser = new WsFrameParser()
    const conn: WsConn = {
      send(text: string) {
        if (!opened || !handshaken) throw new Error('NapCat 反向连接未就绪')
        socket.write(encodeServerFrame(0x1, Buffer.from(String(text), 'utf8')))
      },
      close() {
        silentClose = true
        if (opened && handshaken) {
          try { socket.write(encodeServerFrame(0x8, Buffer.alloc(0))) } catch { /* 已关闭 */ }
          socket.end()
        } else {
          socket.destroy()
        }
      },
      get open() {
        return opened
      },
    }

    const stopKeepalive = () => {
      if (keepaliveTimer) {
        clearInterval(keepaliveTimer)
        keepaliveTimer = null
      }
    }
    const fireClose = () => {
      if (closedFired) return
      closedFired = true
      const wasOpen = opened
      opened = false
      stopKeepalive()
      if (current === conn) current = null
      // 未完成握手的连接(401/404/端口探测)不算“NapCat 断开”,不通知上层
      if (!silentClose && wasOpen) opts.handlers.onClose(closeInfo)
    }
    const startKeepalive = () => {
      stopKeepalive()
      lastInboundAt = Date.now()
      keepaliveTimer = setInterval(() => {
        if (!opened) return
        if (Date.now() - lastInboundAt > keepaliveTimeoutMs) {
          opts.handlers.onError('NapCat 反向连接保活超时')
          socket.destroy()
          return
        }
        try { socket.write(encodeServerFrame(0x9, Buffer.alloc(0))) } catch { /* 已关闭 */ }
      }, keepaliveIntervalMs)
    }

    const deliver = () => {
      const text = Buffer.concat(fragments).toString('utf8')
      fragments = []
      fragmentOpcode = 0
      opts.handlers.onMessage(text)
    }
    const handleFrame = (f: WsFrame) => {
      switch (f.opcode) {
        case 0x1:
          fragmentOpcode = 0x1
          fragments = [f.payload]
          if (f.fin) deliver()
          break
        case 0x0:
          if (fragmentOpcode === 0x1) {
            fragments.push(f.payload)
            if (f.fin) deliver()
          }
          break
        case 0x8:
          if (f.payload.length >= 2) closeInfo.code = f.payload.readUInt16BE(0)
          if (f.payload.length > 2) {
            try { closeInfo.reason = f.payload.subarray(2).toString('utf8') } catch { /* 忽略 */ }
          }
          try { socket.write(encodeServerFrame(0x8, f.payload.subarray(0, 2))) } catch { /* 忽略 */ }
          stopKeepalive()
          socket.end()
          break
        case 0x9:
          try { socket.write(encodeServerFrame(0xa, f.payload)) } catch { /* 忽略 */ }
          break
        case 0xa:
          break
        default:
          break
      }
    }

    socket.on('data', (chunk: Buffer) => {
      lastInboundAt = Date.now()
      if (handshaken) {
        for (const f of parser.push(chunk)) handleFrame(f)
        return
      }
      handshakeBuf += chunk.toString('latin1')
      const idx = handshakeBuf.indexOf('\r\n\r\n')
      if (idx === -1) {
        if (handshakeBuf.length > 65536) socket.destroy()
        return
      }
      const head = handshakeBuf.slice(0, idx)
      const tail = Buffer.from(handshakeBuf.slice(idx + 4), 'latin1')
      handshakeBuf = ''
      const { line, headers } = headerLines(head)
      const req = /^GET\s+(\S+)\s+HTTP\/1\.[01]$/i.exec(line)
      const upgrade = (headers.get('upgrade') ?? '').toLowerCase()
      const key = headers.get('sec-websocket-key') ?? ''
      const path = (req?.[1] ?? '/').split('?')[0]
      if (!req || upgrade !== 'websocket' || !key) {
        socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
        return
      }
      if (path !== opts.path) {
        socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
        return
      }
      if (opts.accessToken && tokenOf(req[1], headers) !== opts.accessToken) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
        return
      }
      const accept = createHash('sha1')
        .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64')
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      )
      // 新连接替换旧连接:旧 socket 静默关闭,不触发 onClose(避免覆盖新状态)
      if (current && current !== conn) current.close()
      current = conn
      handshaken = true
      opened = true
      socket.setTimeout(0)
      if (tail.length > 0) {
        for (const f of parser.push(tail)) handleFrame(f)
      }
      startKeepalive()
      opts.handlers.onOpen()
    })
    socket.on('error', (err: Error) => {
      if (opened) opts.handlers.onError(`NapCat 反向连接错误:${err.message}`)
    })
    socket.on('close', fireClose)
  }

  return {
    start() {
      if (server) return
      stopped = false
      server = net.createServer(accept)
      server.on('listening', () => {
        const addr = server?.address()
        if (addr && typeof addr === 'object') {
          boundPort = addr.port
          boundHost = addr.address
        }
        listening = true
      })
      server.on('error', (err: Error) => {
        listening = false
        opts.handlers.onError(`反向 WS 监听失败(${opts.host}:${opts.port}):${err.message}`)
        try { server?.close() } catch { /* 已关闭 */ }
        server = null
      })
      server.listen(opts.port, opts.host)
    },
    stop() {
      stopped = true
      listening = false
      if (current) {
        current.close()
        current = null
      }
      try { server?.close() } catch { /* 已关闭 */ }
      server = null
    },
    get listening() {
      return listening && !stopped
    },
    get conn() {
      return current
    },
    get address() {
      return listening ? { host: boundHost, port: boundPort } : null
    },
  }
}
