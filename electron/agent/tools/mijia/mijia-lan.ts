/**
 * miio 局域网直控(UDP 54321,2026-09-22)
 *
 * 全仓首个 node:dgram 用例;传输纪律仿 napcat/wsclient.ts 手写传输:一调用
 * 一 socket(finally 必 close)、超时 AbortSignal.timeout 竞速、每等待点查
 * ctx.signal 抛 AbortError。协议干净室自写(OpenMiHome PROTOCOL.md + 干货
 * 核对;GPL 代码禁复制):
 * - Hello(32B):magic 0x2131(BE)+ len 0x0020(BE)+ 其余 28B 全 0xFF;
 *   应答 32B:did @0x08、stamp @0x0C、**16B token @0x10**(全 0 = 设备
 *   禁用局域网控制,报错引导云端);
 * - 数据包头 32B:magic(2) len(2) unknown(4)=0 did(4) stamp(4) checksum(16);
 *   checksum = MD5(header[0..16] ‖ token ‖ cipherPayload) 写回 @0x10
 *   (hello 包不校验;勿把 checksum 字段参与哈希——PROTOCOL.md 表述含糊,
 *   以实测可用实现的公式为准);
 * - payload = AES-128-CBC-PKCS7(utf8(JSON) + 0x00 终结符),key = MD5(token),
 *   iv = MD5(key ‖ token);解码 unpad 后剥尾部 NUL;
 * - JSON-RPC:{"id":N,"method":"get_properties|set_properties|action","params":[…]}。
 */

import { createDecipheriv, createCipheriv, createHash, randomBytes } from 'node:crypto'
import { createSocket } from 'node:dgram'

const MIIO_PORT = 54321
const HELLO = Buffer.alloc(32, 0xff)
HELLO.writeUInt16BE(0x2131, 0)
HELLO.writeUInt16BE(0x0020, 2)

export interface MijiaLanHello {
  /** 16B token(设备 hello 应答 @0x10) */
  token: Uint8Array
  deviceId: number
  stamp: number
}

export interface MijiaLanO {
  timeoutMs?: number
  signal?: AbortSignal
}

/** key = MD5(token);iv = MD5(key ‖ token) */
export function deriveLanKey(token: Uint8Array): { key: Buffer; iv: Buffer } {
  const key = createHash('md5').update(token).digest()
  const iv = createHash('md5').update(key).update(token).digest()
  return { key, iv }
}

/** 组加密 payload:utf8(JSON) + NUL → PKCS7 → AES-128-CBC */
export function encryptLanPayload(token: Uint8Array, json: string): Buffer {
  const { key, iv } = deriveLanKey(token)
  const plain = Buffer.concat([Buffer.from(json, 'utf8'), Buffer.from([0x00])])
  const cipher = createCipheriv('aes-128-cbc', key, iv)
  return Buffer.concat([cipher.update(plain), cipher.final()])
}

/** 解密 payload → 剥尾部 NUL → utf8 JSON 文本 */
export function decryptLanPayload(token: Uint8Array, data: Uint8Array): string {
  const { key, iv } = deriveLanKey(token)
  const decipher = createDecipheriv('aes-128-cbc', key, iv)
  const plain = Buffer.concat([decipher.update(Buffer.from(data)), decipher.final()])
  let end = plain.length
  while (end > 0 && plain[end - 1] === 0x00) end--
  return plain.subarray(0, end).toString('utf8')
}

/** 组完整数据包:32B 头 + cipher;checksum = MD5(header[0..16] ‖ token ‖ cipher) */
export function buildLanPacket(token: Uint8Array, deviceId: number, stamp: number, cipher: Buffer): Buffer {
  const pkt = Buffer.alloc(32 + cipher.length)
  pkt.writeUInt16BE(0x2131, 0)
  pkt.writeUInt16BE(32 + cipher.length, 2)
  pkt.writeUInt32BE(0, 4)
  pkt.writeUInt32BE(deviceId >>> 0, 8)
  pkt.writeUInt32BE(stamp >>> 0, 12)
  cipher.copy(pkt, 32)
  const md5 = createHash('md5').update(pkt.subarray(0, 16)).update(token).update(cipher).digest()
  md5.copy(pkt, 16)
  return pkt
}

export interface LanParsedPacket {
  deviceId: number
  stamp: number
  /** hello 应答的 token(仅 32B 包携带) */
  token?: Uint8Array
  /** 数据包密文(剥 32B 头) */
  cipher?: Buffer
}

/** 解析应答包(32B hello 或 数据包);magic 不符返回 null */
export function parseLanPacket(pkt: Buffer): LanParsedPacket | null {
  if (pkt.length < 32 || pkt.readUInt16BE(0) !== 0x2131) return null
  const deviceId = pkt.readUInt32BE(8)
  const stamp = pkt.readUInt32BE(12)
  if (pkt.length === 32) {
    return { deviceId, stamp, token: pkt.subarray(16, 32) }
  }
  return { deviceId, stamp, cipher: pkt.subarray(32) }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
}

export interface MijiaLan {
  hello(ip: string, o?: MijiaLanO): Promise<MijiaLanHello>
  rpc(ip: string, tokenHex: string, deviceId: number, payload: { method: string; params: unknown; id?: number }, o?: MijiaLanO): Promise<unknown>
  getProperties(
    ip: string,
    tokenHex: string,
    deviceId: number,
    props: Array<{ siid: number; piid: number }>,
    o?: MijiaLanO,
  ): Promise<Array<{ code: number; value?: unknown }>>
  setProperties(
    ip: string,
    tokenHex: string,
    deviceId: number,
    props: Array<{ siid: number; piid: number; value: unknown }>,
    o?: MijiaLanO,
  ): Promise<Array<{ code: number }>>
  invokeAction(
    ip: string,
    tokenHex: string,
    deviceId: number,
    a: { siid: number; aiid: number; in?: unknown[] },
    o?: MijiaLanO,
  ): Promise<{ code: number; out: unknown[] }>
}

export function createMijiaLan(o?: {
  /** 测试注入 dgram 假实现 */
  createSocketImpl?: typeof createSocket
  now?: () => number
}): MijiaLan {
  const mkSocket = o?.createSocketImpl ?? createSocket
  const now = o?.now ?? (() => Date.now())
  let rpcId = Math.floor(now() / 1000)

  /** 一调用一 socket:发一个包、等一个应答、finally close */
  function once(ip: string, msg: Buffer, waitBytes: number, opt?: MijiaLanO, retry = 0): Promise<Buffer> {
    const timeoutMs = opt?.timeoutMs ?? (waitBytes <= 32 ? 3000 : 5000)
    return new Promise<Buffer>((resolve, reject) => {
      throwIfAborted(opt?.signal)
      const sock = mkSocket('udp4')
      let settled = false
      const timer = setTimeout(() => {
        finish(() => {
          if (retry > 0) {
            once(ip, msg, waitBytes, opt, retry - 1).then(resolve, reject)
          } else {
            reject(new Error(`米家局域网 ${ip}:${MIIO_PORT} 响应超时(检查同一局域网/路由器 AP 隔离/Windows 防火墙;可自动改走云端)`))
          }
        })
      }, timeoutMs)
      const onAbort = () => {
        finish(() => reject(new DOMException('aborted', 'AbortError')))
      }
      const finish = (fn: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        opt?.signal?.removeEventListener('abort', onAbort)
        try {
          sock.close()
        } catch {
          // close 竞态静默
        }
        fn()
      }
      opt?.signal?.addEventListener('abort', onAbort, { once: true })
      sock.on('error', (err) => {
        finish(() =>
          reject(new Error(`米家局域网 ${ip}:${MIIO_PORT} 通信失败:${err.message}(检查同一局域网/路由器 AP 隔离/Windows 防火墙)`)),
        )
      })
      sock.on('message', (buf) => {
        finish(() => resolve(buf))
      })
      sock.send(msg, MIIO_PORT, ip, (err) => {
        if (err) finish(() => reject(new Error(`米家局域网 ${ip} 发送失败:${err.message}`)))
      })
      void waitBytes // 预留:部分应答长度校验,当前不过滤(宽松收包)
    })
  }

  async function hello(ip: string, opt?: MijiaLanO): Promise<MijiaLanHello> {
    const buf = await once(ip, HELLO, 32, { ...opt, timeoutMs: opt?.timeoutMs ?? 3000 }, 1)
    const parsed = parseLanPacket(buf)
    if (!parsed || !parsed.token) throw new Error(`米家设备 ${ip} hello 应答格式异常`)
    const token = parsed.token
    if (token.every((b) => b === 0)) {
      throw new Error(
        `米家设备 ${ip} 未启用局域网控制(token 全 0):请在米家 App 设备页 → 更多设置 → 局域网通信协议(开发者选项)开启后重试;未开启将自动走云端`,
      )
    }
    return { token, deviceId: parsed.deviceId, stamp: parsed.stamp }
  }

  async function rpc(
    ip: string,
    tokenHex: string,
    deviceId: number,
    payload: { method: string; params: unknown; id?: number },
    opt?: MijiaLanO,
  ): Promise<unknown> {
    throwIfAborted(opt?.signal)
    const token = Buffer.from(tokenHex, 'hex')
    if (token.length !== 16) throw new Error('米家局域网 token 格式异常(应为 32 位 hex)')
    const id = payload.id ?? ++rpcId
    const cipher = encryptLanPayload(token, JSON.stringify({ id, method: payload.method, params: payload.params }))
    const pkt = buildLanPacket(token, deviceId, Math.floor(now() / 1000), cipher)
    const buf = await once(ip, pkt, pkt.length + 32, opt)
    throwIfAborted(opt?.signal)
    const parsed = parseLanPacket(buf)
    if (!parsed?.cipher) throw new Error(`米家设备 ${ip} RPC 应答格式异常`)
    const text = decryptLanPayload(token, parsed.cipher)
    type RpcReply = { id?: number; result?: unknown; error?: { message?: string } }
    let json: RpcReply | null = null
    try {
      json = JSON.parse(text) as RpcReply
    } catch {
      throw new Error(`米家设备 ${ip} RPC 应答非 JSON:${text.slice(0, 120)}`)
    }
    if (json?.error) throw new Error(`米家设备 ${ip} RPC ${payload.method} 报错:${json.error.message || text.slice(0, 120)}`)
    return json?.result
  }

  return {
    hello,
    rpc,
    async getProperties(ip, tokenHex, deviceId, props, opt) {
      const result = await rpc(
        ip,
        tokenHex,
        deviceId,
        { method: 'get_properties', params: props.map((p) => ({ did: String(deviceId), siid: p.siid, piid: p.piid })) },
        opt,
      )
      return Array.isArray(result) ? (result as Array<{ code: number; value?: unknown }>) : []
    },
    async setProperties(ip, tokenHex, deviceId, props, opt) {
      const result = await rpc(
        ip,
        tokenHex,
        deviceId,
        {
          method: 'set_properties',
          params: props.map((p) => ({ did: String(deviceId), siid: p.siid, piid: p.piid, value: p.value })),
        },
        opt,
      )
      return Array.isArray(result) ? (result as Array<{ code: number }>) : []
    },
    async invokeAction(ip, tokenHex, deviceId, a, opt) {
      const result = await rpc(
        ip,
        tokenHex,
        deviceId,
        { method: 'action', params: { did: String(deviceId), siid: a.siid, aiid: a.aiid, in: a.in ?? [] } },
        opt,
      )
      const r = (result ?? {}) as { code?: number; out?: unknown[] }
      return { code: typeof r.code === 'number' ? r.code : -1, out: Array.isArray(r.out) ? r.out : [] }
    },
  }
}

/** 测试向量辅助:随机 token(生产 token 一律来自 hello/云端,不用随机) */
export function randomLanToken(): Buffer {
  return randomBytes(16)
}
