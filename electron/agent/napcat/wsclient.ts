/**
 * 手写 WebSocket 客户端(2026-08-13,替换 undici 全局 WebSocket)
 *
 * **背景(实测段错误根因)**:自编译 HEVC Electron(C:\electron-hevc-dist,
 * 与官方 43.2.0 同 tag,ffmpeg 软解 + media 门控补丁)的主进程里,undici
 * 全局 WebSocket(NapCat OneBot 连接)稳定触发 EXCEPTION_ACCESS_VIOLATION
 * ——崩溃栈 `llhttp_message_needs_eof` + node::CallbackScope(Node 22 内置
 * llhttp HTTP 解析器的 use-after-free,nodejs/node#62095,Node v25.8.1
 * 才修复;官方二进制不触发,故用户日常副本用官方版稳定)。二分定位:
 * 补丁二进制 + 静默假 OneBot 服务器(干净 101 握手、零消息、零 LLM
 * 调用)必崩;无 WS(死端口/关 napcat)必稳;官方二进制 + 同一服务器
 * 必稳——触发点 = undici WS 的 HTTP Upgrade 握手路径(llhttp 解析)。
 *
 * **方案**:不用 llhttp 的 WS——net.Socket 直连,手写 HTTP Upgrade 请求
 * (响应按行解析,纯字符串)、手写帧编解码(掩码/长度/分片/ping-pong/
 * close)。OneBot ws:// 为本地明文连接,无 TLS/压缩需求(不协商
 * permessage-deflate,NapCat 不会发压缩帧)。零依赖、零新进程,与项目
 * "手写 MCP 客户端/手写 SSE 解析"路线一致;LLM 流式 fetch 仍走 undici
 * (实测稳定),仅 WS 传输层替换。
 */

import { createHash, randomBytes } from 'node:crypto'
import net from 'node:net'

/** 与 undici WebSocket 对齐的最小接口(仅 napcat 客户端用到的部分) */
export interface WsConn {
  /** 发送文本帧(未连接/已关闭时抛错) */
  send(text: string): void
  /** 发送 close 帧并结束连接(优雅关闭) */
  close(): void
  /** 连接已建立(收到 101 且未关闭) */
  readonly open: boolean
}

export interface WsHandlers {
  onOpen(): void
  onMessage(text: string): void
  onError(message: string): void
  onClose(): void
}

/** 帧头部最小长度(2 字节基础头) */
const MIN_HEADER = 2
/** 握手超时(连接建立后 10s 内未收到 101 则断开走重连) */
const HANDSHAKE_TIMEOUT_MS = 10_000

/**
 * 编码客户端帧(客户端 → 服务端必须带掩码,4 字节随机掩码)
 * opcode:1 = 文本 / 8 = 关闭 / 9 = ping / 10 = pong
 */
export function encodeWsFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length
  let header: Buffer
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | len])
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  const mask = randomBytes(4)
  const masked = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]))
  return Buffer.concat([header, mask, masked])
}

/** 解析出的单帧(服务端 → 客户端,通常不掩码;掩码帧同样容错解析) */
export interface WsFrame {
  fin: boolean
  opcode: number
  payload: Buffer
}

/** 帧解析状态(累积半帧数据,每次喂入增量,返回完整帧) */
export class WsFrameParser {
  private buf = Buffer.alloc(0)

  push(chunk: Buffer): WsFrame[] {
    this.buf = Buffer.concat([this.buf, chunk])
    const frames: WsFrame[] = []
    while (true) {
      if (this.buf.length < MIN_HEADER) break
      const b0 = this.buf[0]
      const b1 = this.buf[1]
      const fin = (b0 & 0x80) !== 0
      const opcode = b0 & 0x0f
      const masked = (b1 & 0x80) !== 0
      let len = b1 & 0x7f
      let headerLen = 2
      if (len === 126) {
        if (this.buf.length < 4) break
        len = this.buf.readUInt16BE(2)
        headerLen = 4
      } else if (len === 127) {
        if (this.buf.length < 10) break
        const big = this.buf.readBigUInt64BE(2)
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) break // 超长帧(理论不会出现)
        len = Number(big)
        headerLen = 10
      }
      const maskLen = masked ? 4 : 0
      const total = headerLen + maskLen + len
      if (this.buf.length < total) break
      let payload = this.buf.subarray(headerLen + maskLen, total)
      if (masked) {
        const mask = this.buf.subarray(headerLen, headerLen + 4)
        payload = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]))
      }
      frames.push({ fin, opcode, payload })
      this.buf = this.buf.subarray(total)
    }
    return frames
  }
}

/** 解析 ws:// URL → {host, port, path}(缺省端口 80;OneBot 恒本机明文) */
export function parseWsUrl(url: string): { host: string; port: number; path: string } {
  const m = /^ws:\/\/([^/:]+)(?::(\d+))?(\/.*)?$/i.exec(String(url).trim())
  if (!m) throw new Error(`无效的 ws URL:${url}`)
  return { host: m[1], port: m[2] ? Number(m[2]) : 80, path: m[3] || '/' }
}

/**
 * 建立 WebSocket 连接(手写传输,不用 undici)。
 * 连接过程:net.connect → 发 HTTP Upgrade 请求 → 等 101(校验
 * Sec-WebSocket-Accept)→ open;期间错误/超时统一走 onError + onClose
 * (onClose 恰好一次,重连由调用方 onClose 里调度)
 */
export function createWsSocket(url: string, handlers: WsHandlers): WsConn {
  let socket: net.Socket | null = null
  let state: 'connecting' | 'open' | 'closed' = 'connecting'
  let closedFired = false
  /** 分片累积(0 = 无进行中的分片消息;1 = 文本分片) */
  let fragmentOpcode = 0
  let fragments: Buffer[] = []
  const parser = new WsFrameParser()
  /** 握手响应累积(纯字符串按行解析,不经 llhttp) */
  let handshakeBuf = ''

  const { host, port, path } = parseWsUrl(url)

  const fireClose = () => {
    if (closedFired) return
    closedFired = true
    state = 'closed'
    handlers.onClose()
  }

  const fail = (message: string) => {
    if (state === 'closed') return
    handlers.onError(message)
    socket?.destroy()
  }

  socket = net.connect(port, host)
  socket.setTimeout(HANDSHAKE_TIMEOUT_MS, () => fail('连接超时(NapCat 未响应握手)'))
  socket.on('connect', () => {
    // HTTP Upgrade 请求(客户端密钥随机 16 字节 base64;不协商压缩)
    const key = randomBytes(16).toString('base64')
    socket!.write(
      `GET ${path} HTTP/1.1\r\n` +
        `Host: ${host}:${port}\r\n` +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Key: ${key}\r\n` +
        'Sec-WebSocket-Version: 13\r\n' +
        '\r\n',
    )
    // 握手密钥供 101 校验
    socket!.on('data', (chunk: Buffer) => {
      if (state === 'open') {
        // 已升级:按帧解析
        for (const f of parser.push(chunk)) handleFrame(f)
        return
      }
      handshakeBuf += chunk.toString('latin1')
      const idx = handshakeBuf.indexOf('\r\n\r\n')
      if (idx === -1) {
        if (handshakeBuf.length > 65536) fail('握手响应异常(超长)')
        return
      }
      const head = handshakeBuf.slice(0, idx)
      const tail = handshakeBuf.slice(idx + 4) // 101 后同包携带的帧数据
      handshakeBuf = ''
      const status = /^HTTP\/1\.[01]\s+(\d{3})/i.exec(head)
      if (!status || status[1] !== '101') {
        fail(`NapCat 握手失败(${status ? status[1] : '非 HTTP 响应'})`)
        return
      }
      const accept = /^sec-websocket-accept:\s*([^\r\n]+)/im.exec(head)
      const expected = createHash('sha1')
        .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64')
      if (!accept || accept[1].trim() !== expected) {
        fail('NapCat 握手失败(Sec-WebSocket-Accept 不匹配)')
        return
      }
      // 101 后剩余数据(若有)按帧解析
      state = 'open'
      socket!.setTimeout(0)
      const rest = Buffer.from(tail, 'latin1')
      if (rest.length > 0) {
        for (const f of parser.push(rest)) handleFrame(f)
      }
      handlers.onOpen()
    })
  })
  socket.on('error', (err: Error) => {
    handlers.onError(`连接错误:${err.message}`)
    // close 事件随后触发(onClose 恰好一次)
  })
  socket.on('close', () => fireClose())
  socket.on('timeout', () => {
    if (state !== 'open') fail('连接超时(NapCat 未响应握手)')
  })

  function handleFrame(f: WsFrame) {
    switch (f.opcode) {
      case 0x1: // 文本(开始或整帧)
        fragmentOpcode = 0x1
        fragments = [f.payload]
        if (f.fin) deliverText()
        break
      case 0x0: // 续帧(累积;NapCat 不分片,此处为协议健壮性)
        if (fragmentOpcode === 0x1) {
          fragments.push(f.payload)
          if (f.fin) deliverText()
        }
        break
      case 0x8: // 关闭帧:回 close 后结束
        try {
          socket!.write(encodeWsFrame(0x8, f.payload.subarray(0, 2)))
        } catch {
          // 忽略
        }
        socket!.end()
        break
      case 0x9: // ping → pong(回显负载)
        try {
          socket!.write(encodeWsFrame(0xa, f.payload))
        } catch {
          // 忽略
        }
        break
      case 0xa: // pong:忽略
        break
      default:
        // 其它控制帧忽略
        break
    }
  }

  function deliverText() {
    const text = Buffer.concat(fragments).toString('utf8')
    fragments = []
    fragmentOpcode = 0
    handlers.onMessage(text)
  }

  return {
    send(text: string) {
      if (state !== 'open' || !socket) throw new Error('NapCat 未连接')
      socket.write(encodeWsFrame(0x1, Buffer.from(String(text), 'utf8')))
    },
    close() {
      if (state === 'open' && socket) {
        try {
          socket.write(encodeWsFrame(0x8, Buffer.alloc(0)))
        } catch {
          // 忽略
        }
        socket.end()
      } else {
        socket?.destroy()
      }
    },
    get open() {
      return state === 'open'
    },
  }
}
