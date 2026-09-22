/**
 * 小米云 API 客户端 + QR 登录流(2026-09-22)
 *
 * 干净室自写(算法对齐 MIT 参考实现 PiotrMachowski/Xiaomi-cloud-tokens-extractor;
 * GPL 代码 python-miio / mijiaAPI 禁止翻译复制)。协议要点:
 * - 登录只走 **QR 流**(密码登录有 captcha + 邮件 2FA,弃用):
 *   GET account.xiaomi.com/longPolling/loginUrl → {qr 图源, loginUrl, lp 长轮询, timeout}
 *   → 长轮询 lp 得 userId/ssecurity/cUserId/passToken/location
 *   → GET location 取 Set-Cookie serviceToken;
 * - 请求签名(ENCRYPT-RC4 变体):
 *   nonce = base64(8 随机字节 ‖ 4B BE 分钟数);
 *   signed_nonce = base64(SHA256(b64d(ssecurity) ‖ b64d(nonce)));
 *   rc4_hash__ = 签名(明文 params,此时仅 data)→ 与 data 一起 RC4 加密
 *   (密钥 = b64d(signed_nonce),丢弃前 1024 字节密钥流);
 *   signature = 签名(密文 params = data + rc4_hash__ 插入序)→ 连同
 *   ssecurity / _nonce 以 **query string** 发出(signed_nonce 本体不发);
 * - 签名串 = `METHOD&url去/app/&k=v…&signed_nonce`,SHA1 后 base64;
 * - 响应 = 整包 base64 → RC4 解密(密钥 = 本次 signed_nonce)→ JSON。
 *
 * 纯逻辑 + 注入 fetch/randBytes/now,零 node 依赖(哈希/密码学注入)可单测;
 * 短请求传 AbortSignal.timeout(engine-tool-execution 先例;仅 LLM SSE 流禁传 signal)。
 */

import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto'
import type { MijiaAuth, MijiaRegion } from './mijia-store'

// ---- 纯函数:签名与 RC4(字节向量单测钉死) ----

/** nonce = base64(8B 随机 ‖ 4B BE uint32(floor(nowMs/60000))) */
export function makeNonce(rand: Uint8Array, nowMs: number): string {
  const buf = Buffer.alloc(12)
  Buffer.from(rand.subarray(0, 8)).copy(buf, 0)
  buf.writeUInt32BE(Math.floor(nowMs / 60000), 8)
  return buf.toString('base64')
}

/** signed_nonce = base64(SHA256(b64d(ssecurity) ‖ b64d(nonce))),返回 base64 字符串 */
export function computeSignedNonce(ssecurityB64: string, nonceB64: string): string {
  const h = createHash('sha256')
  h.update(Buffer.from(ssecurityB64, 'base64'))
  h.update(Buffer.from(nonceB64, 'base64'))
  return h.digest('base64')
}

/**
 * 签名串 = `METHOD&url去/app/后的path&k=v…&signed_nonce`,SHA1 后 base64。
 * path 变换对齐参考实现:url.split('com')[1].replace('/app/','/')
 * (如 https://de.api.io.mi.com/app/v2/x → /v2/x);params 按插入序。
 */
export function computeSignature(
  signedNonceB64: string,
  method: string,
  url: string,
  params: Record<string, string>,
): string {
  const parts = [String(method).toUpperCase(), url.split('com')[1].replace('/app/', '/')]
  for (const [k, v] of Object.entries(params)) parts.push(`${k}=${v}`)
  parts.push(signedNonceB64)
  return createHash('sha1').update(parts.join('&'), 'utf8').digest('base64')
}

/** RC4(KSA+PRGA),可跳过前 skipBytes 字节密钥流;加解密同函数(OpenSSL3 无 RC4,手写) */
export function rc4Crypt(key: Uint8Array, data: Uint8Array, skipBytes = 0): Uint8Array {
  const s = new Uint8Array(256)
  for (let i = 0; i < 256; i++) s[i] = i
  let j = 0
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 0xff
    const t = s[i]
    s[i] = s[j]
    s[j] = t
  }
  let i = 0
  j = 0
  const out = new Uint8Array(data.length)
  for (let n = 0; n < skipBytes + data.length; n++) {
    i = (i + 1) & 0xff
    j = (j + s[i]) & 0xff
    const t = s[i]
    s[i] = s[j]
    s[j] = t
    const k = s[(s[i] + s[j]) & 0xff]
    if (n >= skipBytes) out[n - skipBytes] = data[n - skipBytes] ^ k
  }
  return out
}

/** 云 API 用:丢弃前 1024 字节密钥流的 RC4(对齐参考实现 encrypt_rc4) */
export function rc4Skip1024Crypt(key: Uint8Array, data: Uint8Array): Uint8Array {
  return rc4Crypt(key, data, 1024)
}

/** RC4 加密参数值(密钥 = b64d(signed_nonce))→ base64 密文 */
export function encryptParam(signedNonceB64: string, plain: string): string {
  const key = Buffer.from(signedNonceB64, 'base64')
  return Buffer.from(rc4Skip1024Crypt(key, Buffer.from(plain, 'utf8'))).toString('base64')
}

/** RC4 解密(base64 密文 → utf8 明文);响应整包解密同用 */
export function decryptParam(signedNonceB64: string, cipherB64: string): string {
  const key = Buffer.from(signedNonceB64, 'base64')
  const out = rc4Skip1024Crypt(key, Buffer.from(cipherB64, 'base64'))
  return Buffer.from(out).toString('utf8')
}

/**
 * 组装云请求 query 参数(顺序即参考实现语义):
 * ① rc4_hash__ = 签名(明文 params = {data})② data/rc4_hash__ 全加密
 * ③ signature = 签名(密文 params)④ 附 ssecurity / _nonce。
 */
export function generateEncParams(o: {
  url: string
  method: string
  signedNonce: string
  nonce: string
  dataJson: string
  ssecurity: string
}): Record<string, string> {
  const params: Record<string, string> = { data: o.dataJson }
  params.rc4_hash__ = computeSignature(o.signedNonce, o.method, o.url, params)
  for (const [k, v] of Object.entries(params)) params[k] = encryptParam(o.signedNonce, v)
  params.signature = computeSignature(o.signedNonce, o.method, o.url, params)
  params.ssecurity = o.ssecurity
  params._nonce = o.nonce
  return params
}

// ---- 云 API 客户端 ----

export interface MijiaSessionCreds {
  userId: string
  cUserId: string
  ssecurity: string
  serviceToken: string
  deviceId: string
  region: MijiaRegion
}

export type MijiaQrLoginResult =
  | { status: 'pending' }
  | {
      status: 'done'
      userId: string
      cUserId: string
      ssecurity: string
      passToken: string
      location: string
    }
  | { status: 'error'; message: string }

export interface MijiaCloud {
  /** GET /longPolling/loginUrl → {qr 图源, loginUrl(扫码内容), lp 长轮询, timeoutSec} */
  beginQrLogin(o?: { signal?: AbortSignal }): Promise<{ qrImage: string; loginUrl: string; lpUrl: string; timeoutSec: number }>
  /** 长轮询 lp:超时/无结论 → pending;扫描确认 → done(凭证);服务端报错 → error */
  pollQrLogin(lpUrl: string, o?: { signal?: AbortSignal }): Promise<MijiaQrLoginResult>
  /** GET location → Set-Cookie serviceToken */
  exchangeServiceToken(
    auth: { location: string; userId: string; cUserId: string; ssecurity: string; passToken: string },
    o?: { signal?: AbortSignal },
  ): Promise<{ serviceToken: string }>
  /** passToken 换新 serviceToken(登录流 location 复用语义;401 自动刷新用) */
  refreshServiceToken(auth: MijiaAuth, o?: { signal?: AbortSignal }): Promise<string>
  /** 通用云 RPC(dataJson = JSON.stringify(业务参数))→ 解密后 JSON */
  call<T = unknown>(
    creds: MijiaSessionCreds,
    path: string,
    data: Record<string, unknown>,
    o?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<T>
  homeDeviceList(creds: MijiaSessionCreds, home: { id: string; owner: string }, o?: { signal?: AbortSignal }): Promise<MijiaCloudDevice[]>
  getHome(creds: MijiaSessionCreds, o?: { signal?: AbortSignal }): Promise<MijiaCloudHome[]>
  sceneList(creds: MijiaSessionCreds, o?: { signal?: AbortSignal }): Promise<MijiaCloudScene[]>
  sceneRun(creds: MijiaSessionCreds, sceneId: string, o?: { signal?: AbortSignal }): Promise<void>
}

export interface MijiaCloudHome {
  id: string
  name: string
  owner: string
  rooms: Array<{ id: string; name: string }>
}

export interface MijiaCloudDevice {
  did: string
  model: string
  name: string
  localip?: string
  token?: string
  isOnline?: boolean
  parentDid?: string
  fwVersion?: string
  roomId?: string
  /** 完整 spec URN(规格端点按 URN 查询,model 不被接受) */
  specType?: string
}

export interface MijiaCloudScene {
  id: string
  name: string
  enable: boolean
  /** st = 手动场景;auto/automation = 自动化(v1 只读) */
  kind: 'manual' | 'auto' | 'unknown'
}

const UA = 'Android-7.1.1-1.0.0-ONEPLUS A3010-136-3f4b7b0a'

function regionBase(region: MijiaRegion): string {
  return region === 'cn' ? 'https://api.io.mi.com/app' : `https://${region}.api.io.mi.com/app`
}

/** account.xiaomi.com 响应带 &&&START&&& 前缀,剥后按 JSON 解析 */
export function parsePrefixedJson(text: string): Record<string, unknown> | null {
  const t = text.trim().replace(/^&&&START&&&/, '')
  try {
    const obj = JSON.parse(t)
    return obj && typeof obj === 'object' ? (obj as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function joinSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal | undefined {
  const t = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([t, signal]) : t
}

export function createMijiaCloud(o?: {
  fetchImpl?: typeof fetch
  now?: () => number
  randBytes?: (n: number) => Uint8Array
}): MijiaCloud {
  const fetchImpl: typeof fetch = o?.fetchImpl ?? ((...a) => fetch(...a))
  const now = o?.now ?? (() => Date.now())
  const randBytes = o?.randBytes ?? ((n: number) => new Uint8Array(nodeRandomBytes(n)))

  async function call<T>(
    creds: MijiaSessionCreds,
    path: string,
    data: Record<string, unknown>,
    opt?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<T> {
    const url = regionBase(creds.region) + path
    const nonce = makeNonce(randBytes(8), now())
    const signedNonce = computeSignedNonce(creds.ssecurity, nonce)
    const fields = generateEncParams({
      url,
      method: 'POST',
      signedNonce,
      nonce,
      dataJson: JSON.stringify(data),
      ssecurity: creds.ssecurity,
    })
    const qs = new URLSearchParams(fields).toString()
    const res = await fetchImpl(`${url}?${qs}`, {
      method: 'POST',
      headers: {
        'Accept-Encoding': 'identity',
        'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded',
        'x-xiaomi-protocal-flag-cli': 'PROTOCAL-HTTP2',
        'MIOT-ENCRYPT-ALGORITHM': 'ENCRYPT-RC4',
        Cookie: `userId=${creds.userId}; serviceToken=${creds.serviceToken}; yetAnotherServiceToken=${creds.serviceToken}; locale=en_GB; timezone=GMT+02:00; is_daylight=1; dst_offset=3600000; channel=MI_APP_STORE`,
      },
      // 短请求可传 signal(llhttp UAF 仅 LLM SSE 流禁传;2026-08-13 约定)
      signal: joinSignal(opt?.timeoutMs ?? 15_000, opt?.signal),
    })
    const text = await res.text().catch(() => '')
    if (!res.ok && res.status !== 200) {
      throw new Error(`米家云接口 ${path} HTTP ${res.status}:${text.slice(0, 200).replace(/\s+/g, ' ')}`)
    }
    let decoded: string
    try {
      // 响应 = 整包 base64 → RC4 解密(密钥 = 本次 signed_nonce)
      decoded = decryptParam(signedNonce, text.trim())
    } catch (e) {
      throw new Error(
        `米家云接口 ${path} 响应解密失败(登录态可能失效,可 mijia_login 重登):${(e as Error)?.message};原始响应 ${text.slice(0, 200).replace(/\s+/g, ' ')}`,
      )
    }
    let json: Record<string, unknown> | null = null
    try {
      json = JSON.parse(decoded) as Record<string, unknown>
    } catch {
      throw new Error(
        `米家云接口 ${path} 响应非 JSON(登录态可能失效):${decoded.slice(0, 200).replace(/\s+/g, ' ')}`,
      )
    }
    if (!json || typeof json.code !== 'number' || json.code !== 0) {
      const code = typeof json?.code === 'number' ? json.code : -1
      const message = typeof json?.message === 'string' ? json.message : ''
      if (code === 3) {
        // code=3 = serviceToken 失效
        throw new Error(`米家登录态已失效,请 mijia_login action=login 重新扫码登录(${message || 'code=3'})`)
      }
      throw new Error(`米家云接口 ${path} 调用失败 code=${code}:${message || decoded.slice(0, 200)}`)
    }
    return json as T
  }

  async function beginQrLogin(opt?: { signal?: AbortSignal }) {
    const qs = new URLSearchParams({
      _qrsize: '480',
      qs: '%3Fsid%3Dxiaomiio%26_json%3Dtrue',
      callback: 'https://sts.api.io.mi.com/sts',
      _hasLogo: 'false',
      sid: 'xiaomiio',
      serviceParam: '',
      _locale: 'en_GB',
      _dc: String(now()),
    })
    const res = await fetchImpl(`https://account.xiaomi.com/longPolling/loginUrl?${qs}`, {
      method: 'GET',
      headers: { 'User-Agent': UA },
      signal: joinSignal(15_000, opt?.signal),
    })
    const text = await res.text().catch(() => '')
    const json = parsePrefixedJson(text)
    const qr = String(json?.qr ?? '')
    const loginUrl = String(json?.loginUrl ?? '')
    const lp = String(json?.lp ?? '')
    const timeoutSec = Number(json?.timeout ?? 300)
    if (!qr && !loginUrl) {
      throw new Error(`米家登录取码失败:${text.slice(0, 200).replace(/\s+/g, ' ') || `HTTP ${res.status}`}`)
    }
    return { qrImage: qr, loginUrl, lpUrl: lp, timeoutSec: Number.isFinite(timeoutSec) && timeoutSec > 0 ? timeoutSec : 300 }
  }

  async function pollQrLogin(lpUrl: string, opt?: { signal?: AbortSignal }): Promise<MijiaQrLoginResult> {
    // 长轮询:请求侧 10s 超时 = 尚无结论(pending),由状态机重拉
    let res: Response
    try {
      res = await fetchImpl(lpUrl, {
        method: 'GET',
        headers: { 'User-Agent': UA },
        signal: joinSignal(12_000, opt?.signal),
      })
    } catch (e) {
      if (opt?.signal?.aborted) throw new DOMException('aborted', 'AbortError')
      // 超时/网络抖动 = 还没扫,pending 重拉
      if ((e as Error)?.name === 'TimeoutError' || (e as Error)?.name === 'AbortError') return { status: 'pending' }
      return { status: 'error', message: `米家登录轮询失败:${(e as Error)?.message || e}` }
    }
    const text = await res.text().catch(() => '')
    const json = parsePrefixedJson(text)
    if (!json) return { status: 'pending' }
    const userId = json.userId != null ? String(json.userId) : ''
    const ssecurity = json.ssecurity != null ? String(json.ssecurity) : ''
    const location = json.location != null ? String(json.location) : ''
    if (userId && ssecurity && location) {
      return {
        status: 'done',
        userId,
        cUserId: json.cUserId != null ? String(json.cUserId) : '',
        ssecurity,
        passToken: json.passToken != null ? String(json.passToken) : '',
        location,
      }
    }
    if (typeof json.description === 'string' && /expired|过期/i.test(json.description)) {
      return { status: 'error', message: `二维码已过期:${json.description}` }
    }
    // 已扫码待确认等中间态 → pending(message 由状态机透出)
    return { status: 'pending' }
  }

  async function exchangeServiceToken(
    auth: { location: string; userId: string; cUserId: string; ssecurity: string; passToken: string },
    opt?: { signal?: AbortSignal },
  ): Promise<{ serviceToken: string }> {
    const res = await fetchImpl(auth.location, {
      method: 'GET',
      headers: { 'User-Agent': UA },
      redirect: 'manual',
      signal: joinSignal(15_000, opt?.signal),
    })
    const cookie = res.headers.get('set-cookie') ?? res.headers.get('Set-Cookie') ?? ''
    const m = /serviceToken=([^;,\s]+)/i.exec(cookie)
    const serviceToken = m?.[1] ?? ''
    if (!serviceToken) {
      // 部分环境 location 直接 200 且 cookie 在 jar 里;redirect:manual 下 3xx 的 set-cookie 也在此头里
      throw new Error('米家登录成功但未取到 serviceToken(风控拦截?可稍后重试或换网络)')
    }
    return { serviceToken }
  }

  async function refreshServiceToken(auth: MijiaAuth, opt?: { signal?: AbortSignal }): Promise<string> {
    // passToken 保活:重走一次 location 换新 serviceToken(location 每次登录一次性,
    // 刷新失败 → 引导重登;不做密码流)
    const res = await fetchImpl(`https://account.xiaomi.com/pass/serviceLogin?sid=xiaomiio&_json=true`, {
      method: 'GET',
      headers: {
        'User-Agent': UA,
        Cookie: `userId=${auth.userId}; passToken=${auth.passToken};`,
      },
      redirect: 'manual',
      signal: joinSignal(15_000, opt?.signal),
    })
    const text = await res.text().catch(() => '')
    const json = parsePrefixedJson(text)
    const location = String(json?.location ?? '')
    if (!location) throw new Error('米家凭证刷新失败(需重新扫码登录)')
    return (await exchangeServiceToken(
      { location, userId: auth.userId, cUserId: auth.cUserId, ssecurity: auth.ssecurity, passToken: auth.passToken },
      opt,
    )).serviceToken
  }

  return {
    beginQrLogin,
    pollQrLogin,
    exchangeServiceToken,
    refreshServiceToken,
    call,
    async homeDeviceList(creds, home, opt) {
      const out = await call<{ result?: { device_info?: unknown } }>(
        creds,
        '/v2/home/home_device_list',
        {
          // home_owner 空串会被云判无权限("no permit",实测 2026-09-22)——
          // owner 解析不到时兜底登录 userId(自家家庭实测可通)
          home_owner: home.owner || String(creds.userId),
          home_id: home.id,
          limit: 200,
          get_split_device: true,
          support_smart_home: true,
        },
        opt,
      )
      const arr = Array.isArray(out?.result?.device_info) ? out.result.device_info : []
      const devices: MijiaCloudDevice[] = []
      for (const raw of arr) {
        if (!raw || typeof raw !== 'object') continue
        const d = raw as Record<string, unknown>
        const did = String(d.did ?? '')
        const model = String(d.model ?? '')
        if (!did || !model) continue
        devices.push({
          did,
          model,
          name: String(d.name ?? did),
          localip: typeof d.localip === 'string' ? d.localip : undefined,
          token: typeof d.token === 'string' && d.token ? d.token : undefined,
          isOnline: typeof d.isOnline === 'boolean' ? d.isOnline : undefined,
          parentDid: typeof d.parent_id === 'string' && d.parent_id ? d.parent_id : undefined,
          fwVersion:
            typeof d.extra === 'object' && d.extra && typeof (d.extra as Record<string, unknown>).fw_version === 'string'
              ? ((d.extra as Record<string, unknown>).fw_version as string)
              : undefined,
          specType: typeof d.spec_type === 'string' && d.spec_type ? d.spec_type : undefined,
        })
      }
      // isOnline 字段命名在不同版本间漂移(isOnline/online),兜底读 online
      arr.forEach((raw, i) => {
        const d = raw as Record<string, unknown> | null
        if (d && typeof d.online === 'boolean' && devices[i]) devices[i].isOnline = d.online
      })
      return devices
    },
    async getHome(creds, opt) {
      const out = await call<{ result?: { homelist?: unknown; share_home?: unknown } }>(
        creds,
        '/v2/homeroom/gethome',
        { fg: true, fetch_share: true, fetch_net: true, limit: 300 },
        opt,
      )
      const lists: unknown[] = [
        ...(Array.isArray(out?.result?.homelist) ? out.result.homelist : []),
        ...(Array.isArray(out?.result?.share_home) ? out.result.share_home : []),
      ]
      const homes: MijiaCloudHome[] = []
      for (const raw of lists) {
        if (!raw || typeof raw !== 'object') continue
        const h = raw as Record<string, unknown>
        const id = h.id != null ? String(h.id) : h.home_id != null ? String(h.home_id) : ''
        if (!id) continue
        const rooms: Array<{ id: string; name: string }> = []
        const roomArr = Array.isArray(h.roomlist) ? h.roomlist : Array.isArray(h.rooms) ? h.rooms : []
        for (const rr of roomArr) {
          if (!rr || typeof rr !== 'object') continue
          const r = rr as Record<string, unknown>
          const rid = r.id != null ? String(r.id) : ''
          if (rid) rooms.push({ id: rid, name: String(r.name ?? '') })
        }
        homes.push({
          id,
          name: String(h.name ?? ''),
          // 实测(2026-09-22):gethome 条目主人 UID 字段名是 `uid`(无 owner_uid/owner
          // ——按旧字段名解析落空 → home_owner:'' → 云回 "no permit",0 设备)
          owner: String(h.owner_uid ?? h.uid ?? h.owner ?? h.user_id ?? ''),
          rooms,
        })
      }
      return homes
    },
    async sceneList(creds, opt) {
      // 场景端点为实现期占位(研究受阻则工具层降级文案;devices/control 不依赖此)
      const out = await call<{ result?: { scenelist?: unknown; scene_info?: unknown } }>(
        creds,
        '/v2/scene/list',
        { pid: 3, allow_cross: false },
        opt,
      )
      const arr = Array.isArray(out?.result?.scenelist)
        ? out.result.scenelist
        : Array.isArray(out?.result?.scene_info)
          ? out.result.scene_info
          : []
      const scenes: MijiaCloudScene[] = []
      for (const raw of arr) {
        if (!raw || typeof raw !== 'object') continue
        const s = raw as Record<string, unknown>
        const id = s.id != null ? String(s.id) : s.scene_id != null ? String(s.scene_id) : ''
        if (!id) continue
        const st = String(s.st ?? s.type ?? '')
        scenes.push({
          id,
          name: String(s.name ?? id),
          enable: s.enable !== false,
          kind: st === 'st' || st === 'manual' ? 'manual' : st === 'auto' || st === 'automation' ? 'auto' : 'unknown',
        })
      }
      return scenes
    },
    async sceneRun(creds, sceneId, opt) {
      await call(creds, '/v2/scene/start', { scene_id: sceneId }, opt)
    },
  }
}

// ---- 登录流状态机(小窗用;纯逻辑 + 注入,仿 napcat-login.ts 三契约) ----

export type MijiaLoginPhase = 'idle' | 'waiting' | 'done' | 'error'

export interface MijiaLoginState {
  phase: MijiaLoginPhase
  /** 服务端 QR 图源(小窗 <img> 直显;权威码源) */
  qrImage: string
  /** 扫码内容(encodeQr 兜底渲染;服务端图源失败时用) */
  qrText: string
  /** 当前码已展示秒数 */
  ageSec: number
  /** 当前码自动换码剩余秒数 */
  remainSec: number
  /** 状态文本("请用米家 App 扫码并确认" / "已扫码,待确认" / 错误详情) */
  message: string
}

export interface MijiaLoginFlow {
  start(): Promise<void>
  /** 换一张:错误态 = 整体重试(对齐 napcat-login 修复) */
  refresh(): Promise<void>
  stop(): void
}

export function createMijiaLoginFlow(deps: {
  cloud: MijiaCloud
  onUpdate(state: MijiaLoginState): void
  /** 拿到登录凭证(已换 serviceToken)后回调落盘 */
  onCredentials(auth: {
    userId: string
    cUserId: string
    ssecurity: string
    passToken: string
    serviceToken: string
  }): Promise<void> | void
  pollMs?: number
  ttlSec?: number
  now?: () => number
}): MijiaLoginFlow {
  const pollMs = deps.pollMs ?? 1500
  const ttlSec = deps.ttlSec ?? 240 // 服务端 timeout 缺省约 300s,提前换不死码
  const now = deps.now ?? (() => Date.now())

  let qrImage = ''
  let qrText = ''
  let qrAt = 0
  let lpUrl = ''
  let stopped = true
  let timer: ReturnType<typeof setInterval> | null = null

  const emit = (phase: MijiaLoginPhase, message: string) => {
    const ageSec = qrText || qrImage ? Math.max(0, Math.floor((now() - qrAt) / 1000)) : 0
    deps.onUpdate({
      phase,
      qrImage,
      qrText,
      ageSec,
      remainSec: Math.max(0, ttlSec - ageSec),
      message,
    })
  }

  /** 采用新码并重置展示计时 */
  const adoptCode = (img: string, text: string, lp: string) => {
    qrImage = img
    qrText = text
    lpUrl = lp
    qrAt = now()
  }

  const fetchNewCode = async (): Promise<void> => {
    const c = await deps.cloud.beginQrLogin()
    adoptCode(c.qrImage, c.loginUrl, c.lpUrl)
  }

  const tick = async () => {
    if (stopped || !lpUrl) return
    try {
      const r = await deps.cloud.pollQrLogin(lpUrl)
      if (stopped) return
      if (r.status === 'error') {
        // 过期/服务端报错:过期码不落屏 → 立即换新
        qrImage = ''
        qrText = ''
        emit('waiting', /过期|expired/i.test(r.message) ? '正在换新二维码…' : r.message)
        if (/过期|expired/i.test(r.message)) {
          await fetchNewCode().catch(() => {})
          if (!stopped) emit('waiting', '已自动换新二维码')
        }
        return
      }
      if (r.status === 'done') {
        const serviceToken = await deps.cloud.exchangeServiceToken({
          location: r.location,
          userId: r.userId,
          cUserId: r.cUserId,
          ssecurity: r.ssecurity,
          passToken: r.passToken,
        })
        await deps.onCredentials({
          userId: r.userId,
          cUserId: r.cUserId,
          ssecurity: r.ssecurity,
          passToken: r.passToken,
          serviceToken: serviceToken.serviceToken,
        })
        emit('done', '米家登录成功')
        stop()
        return
      }
      // pending:到点自动换码(手机扫到的永远是活码)
      if (now() - qrAt >= ttlSec * 1000) {
        qrImage = ''
        qrText = ''
        emit('waiting', '正在换新二维码…')
        await fetchNewCode().catch(() => {})
        if (!stopped) emit('waiting', '已自动换新二维码')
        return
      }
      emit('waiting', '')
    } catch (err) {
      if (!stopped) emit('waiting', `轮询异常:${(err as Error)?.message || err}`)
    }
  }

  async function start(): Promise<void> {
    stop()
    stopped = false
    try {
      await fetchNewCode()
    } catch (err) {
      stopped = true
      emit('error', (err as Error)?.message || String(err))
      return
    }
    emit('waiting', '请用米家 App 扫码,在手机上确认登录')
    timer = setInterval(() => void tick(), pollMs)
  }

  async function refresh(): Promise<void> {
    if (stopped) {
      await start()
      return
    }
    try {
      qrImage = ''
      qrText = ''
      emit('waiting', '正在换新二维码…')
      await fetchNewCode()
      emit('waiting', '已换新二维码')
    } catch (err) {
      emit('waiting', `换码失败:${(err as Error)?.message || err}`)
    }
  }

  function stop(): void {
    stopped = true
    if (timer) clearInterval(timer)
    timer = null
  }

  return { start, refresh, stop }
}
