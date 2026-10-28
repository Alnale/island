/**
 * NapCat WebUI 扫码登录客户端 + 自动换码状态机(2026-09-22)
 *
 * 用户实测病灶:「QQ 一直显示过期,且扫上了,也说没扫上」——根因 = 登录
 * 二维码是**一次性时效凭证**(~2 分钟),而 NapCat WebUI 页面把过期的旧码
 * 原样挂在屏幕上(loginError 为空不提示),用户扫到的一律是死码:手机 QQ
 * 报"二维码已过期";偶尔手快扫到活码确认后桌面又因轮询陈旧"没扫上";
 * 截图/转发的二维码更是落地即死。
 *
 * 修复 = 本模块的三条硬规则:
 * ① **永远只展示新鲜码**:取码后 ttlSec(默认 105s < 约 120s 有效期)到点
 *    自动 RefreshQRcode,手机扫到的码永远在有效期内;服务端 loginError 报
 *    「过期」时**立即换码**(5s 冷却),不等 ttl;
 * ② **秒级轮询绑定当前码**:pollMs(默认 1.5s)查 CheckLoginStatus,
 *    以服务端 qrcodeurl 为准跟随换码(他人在 WebUI 刷新也能跟上),
 *    isLogin 即报成功,loginError 原样透出("已扫码待确认"等);
 * ③ **权威码源 = CheckLoginStatus.qrcodeurl,过期码不落屏**(2026-09-22 实测):
 *    RefreshQRcode 是**异步铸码**(新码 ~1-2s 后才经状态接口落地),竞态窗口内
 *    GetQQLoginQrcode/状态接口可能回旧码(两接口"不一致"即此竞态);loginError
 *    报「过期」的码一律丢弃不展示(展示死码 = 扫到"已过期/没扫上"的根因),
 *    以占位文案顶住,等新码落地再画。
 * 另:API 前缀 /api(漏则 /auth/login 404 = 小窗白板,2026-09-22 修复)。
 *
 * 2026-10-22 补(用户截图「无法获取二维码 / fetch failed」):二维码不显示的
 * 根因不在编码/渲染,而是 **WebUI 根本连不上**(NapCat 未启动/未注入 QQ/
 * 端口不符)时旧实现把 TypeError: fetch failed 原样抛成 error 态并停死——
 * NapCat 之后起来也不会再取码,窗口永远一块"无法获取二维码"。修复:
 * ① 连接失败/轮询中掉线**不再进死错误态**:丢弃旧码、保持 waiting、按
 *    retryMs 自动重连,窗口开着等 NapCat 启动即自动出码;
 * ② 错误文案展开 fetch 的底层 cause(ECONNREFUSED / 超时 / 解析失败)+
 *    目标地址,不再只有 "fetch failed";
 * ③ 支持 baseUrls 多候选(127.0.0.1 / [::1]),WebUI 只绑 IPv6 也能连;
 * ④ 鉴权/接口错误仍进 error 态(需要用户粘贴 token),不做无意义重试。
 *
 * 纯逻辑 + 注入 fetch,零 node 依赖可单测(sha256 经 node:crypto 注入)。
 */

export interface NapcatLoginStatus {
  isLogin: boolean
  isOffline: boolean
  qrcodeurl: string
  loginError: string
}

export type LoginPhase = 'idle' | 'waiting' | 'done' | 'error'

export interface LoginState {
  phase: LoginPhase
  /** 当前登录码编码对象(txz 短链,展示方自行编码为二维码) */
  qrUrl: string
  /** 当前码已展示秒数(展示方画倒计时) */
  ageSec: number
  /** 当前码自动换码剩余秒数(无码 = 0,展示方显示占位) */
  remainSec: number
  /** 服务端状态文本(如"已扫码,待确认";空 = 等待扫码) */
  message: string
}

export interface NapcatLoginApiDeps {
  /** 主地址(默认 http://127.0.0.1:6099;可带 /api) */
  baseUrl?: string
  /** 追加候选地址(如 WebUI 只监听 IPv6 时的 http://[::1]:6099),依次尝试 */
  baseUrls?: string[]
  token: string
  fetchImpl?: typeof fetch
  sha256Hex(text: string): string
  now?: () => number
  ttlSec?: number
  pollMs?: number
  /** 连接失败后的自动重连间隔(ms,默认 2500;不会进死错误态) */
  retryMs?: number
  onUpdate(state: LoginState): void
}

/** WebUI 登录口令散列(前端约定:SHA256(token + '.napcat') 十六进制) */
export function webuiTokenHash(token: string, sha256Hex: (t: string) => string): string {
  return sha256Hex(String(token ?? '') + '.napcat')
}

/** fetch 底层常见错误码(可重试的连接层故障,不是鉴权/接口错误) */
const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
])

/** 展开 error.cause 链(undici 把真正的 ECONNREFUSED 藏在 TypeError.cause) */
function errorChain(err: unknown): any[] {
  const out: any[] = []
  const seen = new Set<unknown>()
  let cur: any = err
  while (cur && typeof cur === 'object' && !seen.has(cur) && out.length < 5) {
    seen.add(cur)
    out.push(cur)
    const firstAggregate = Array.isArray(cur.errors) ? cur.errors[0] : null
    cur = cur.cause ?? firstAggregate ?? null
  }
  return out
}

/**
 * 把 fetch 的 TypeError 翻成人能看懂的连接诊断(2026-10-22):
 * "fetch failed" 单看毫无信息量——展开 cause 后带上 ECONNREFUSED/超时/主机名
 * 与目标地址,小窗才可能提示"NapCat 未启动"而不是让用户对着报错猜。
 */
export function describeLoginError(err: unknown): string {
  const chain = errorChain(err)
  const code = String(chain.find((e) => e && e.code)?.code || '')
  switch (code) {
    case 'ECONNREFUSED':
      // 地址由调用方前缀(displayBase)给出,这里不再重复
      return '连接被拒绝(WebUI 未启动或端口不对)'
    case 'ETIMEDOUT':
    case 'UND_ERR_CONNECT_TIMEOUT':
      return '连接超时'
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return '无法解析主机名'
    case 'ECONNRESET':
      return '连接被重置'
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return '主机不可达'
    default:
      break
  }
  // 没有错误码时退回底层 message;丢掉 undici 的 "fetch failed" 空壳
  const detail = chain
    .map((e) => String(e?.message || '').trim())
    .find((m) => m && !/^(fetch failed|failed to fetch)$/i.test(m))
  if (code) return `网络错误(${code})`
  if (detail) return `网络请求失败(${detail})`
  return '网络请求失败'
}

function tagNetwork(err: unknown): Error {
  const e = err instanceof Error ? err : new Error(String(err))
  ;(e as any).napcatNetwork = true
  return e
}

function tagApi(err: Error): Error {
  ;(err as any).napcatApi = true
  return err
}

/** fetch 拒绝/读 body 失败 = 连接层故障(可自动重连);接口 code≠0 = 鉴权/服务端错误 */
function isNetworkError(err: unknown): boolean {
  if ((err as any)?.napcatApi === true) return false
  return (err as any)?.napcatNetwork === true || NETWORK_CODES.has(String((err as any)?.code || ''))
}

/** 统一 API 前缀(NapCat WebUI 前端 axios baseURL = '/api');已带则不重复拼 */
function normalizeBase(raw: string): string {
  const root = String(raw || '').trim().replace(/\/+$/, '')
  if (!root) return ''
  return /\/api$/i.test(root) ? root : `${root}/api`
}

export interface NapcatLoginFlow {
  start(): Promise<void>
  refresh(): Promise<void>
  stop(): void
}

export function createNapcatLoginFlow(deps: NapcatLoginApiDeps): NapcatLoginFlow {
  // 地址候选(2026-10-22):WebUI host 为 "::" 时可能只监听 IPv6,主进程会把
  // 127.0.0.1 / [::1] 都传进来;一次调用内依次尝试,成功后记住可用地址。
  const baseList: string[] = []
  for (const raw of [...(deps.baseUrls ?? []), deps.baseUrl || 'http://127.0.0.1:6099']) {
    const base = normalizeBase(raw)
    if (base && !baseList.includes(base)) baseList.push(base)
  }
  if (baseList.length === 0) baseList.push('http://127.0.0.1:6099/api')
  let activeBase = 0

  const fetchImpl: typeof fetch = (async (...args: Parameters<typeof fetch>) => {
    try {
      return await (deps.fetchImpl ?? fetch)(...args)
    } catch (err) {
      throw tagNetwork(err)
    }
  }) as typeof fetch
  const now = deps.now ?? (() => Date.now())
  const ttlSec = deps.ttlSec ?? 105
  const pollMs = deps.pollMs ?? 1500
  const retryMs = Math.max(50, deps.retryMs ?? 2500)

  let cred = ''
  let qrUrl = ''
  let qrAt = 0
  let lastRefreshAt = 0
  let stopped = true
  let starting = false
  let timer: ReturnType<typeof setInterval> | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null

  const emit = (phase: LoginPhase, message: string) => {
    const ageSec = qrUrl ? Math.max(0, Math.floor((now() - qrAt) / 1000)) : 0
    deps.onUpdate({
      phase,
      qrUrl,
      ageSec,
      // 无码时不报 ttl:旧实现让错误态也显示 105s 倒计时,像还有码可扫
      remainSec: qrUrl ? Math.max(0, ttlSec - ageSec) : 0,
      message,
    })
  }

  const displayBase = () => baseList[activeBase].replace(/\/api$/i, '').replace(/^https?:\/\//i, '')

  const callOn = async (base: string, path: string, body?: unknown): Promise<any> => {
    let res: Response
    try {
      res = await fetchImpl(base + path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(cred ? { Authorization: `Bearer ${cred}` } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : '{}',
      })
    } catch (err) {
      throw tagNetwork(err)
    }
    let text = ''
    try {
      text = await res.text()
    } catch (err) {
      throw tagNetwork(err)
    }
    let json: { code?: number; message?: string; data?: any } | null = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null // HTML 404 页等非 JSON 响应 → 走下方兜底文案
    }
    if (!json || json.code !== 0) {
      const detail =
        json?.message ||
        (text ? text.slice(0, 120).replace(/\s+/g, ' ') : `HTTP ${res.status}`)
      throw tagApi(new Error(`NapCat WebUI ${path} 调用失败:${detail}`))
    }
    return json.data
  }

  /** 依次尝试候选地址;只有连接层故障才换地址,鉴权/接口错误立即上抛 */
  const call = async (path: string, body?: unknown): Promise<any> => {
    let lastErr: unknown = null
    for (let step = 0; step < baseList.length; step++) {
      const idx = (activeBase + step) % baseList.length
      try {
        const data = await callOn(baseList[idx], path, body)
        activeBase = idx
        return data
      } catch (err) {
        if (!isNetworkError(err)) throw err
        lastErr = err
      }
    }
    throw lastErr ?? tagNetwork(new Error('无法连接 NapCat WebUI'))
  }

  const login = async () => {
    const data = await call('/auth/login', { hash: webuiTokenHash(deps.token, deps.sha256Hex) })
    cred = String(data?.Credential ?? '')
    if (!cred) throw tagApi(new Error('NapCat WebUI 登录失败:未返回 Credential(token 是否正确?)'))
  }

  /** 采用服务端跟踪码并重置该码的展示计时(换码/跟随同款) */
  const adoptCode = (url: string) => {
    if (url && url !== qrUrl) {
      qrUrl = url
      qrAt = now()
    }
  }

  const isExpired = (st: NapcatLoginStatus) => String(st.loginError || '').includes('过期')

  const pullStatus = async (): Promise<NapcatLoginStatus> => call('/QQLogin/CheckLoginStatus', {})

  const doRefresh = async () => {
    lastRefreshAt = now()
    try {
      await call('/QQLogin/RefreshQRcode', {})
    } catch (err) {
      if (isNetworkError(err)) lastRefreshAt = 0 // 连不上不算"换过码",重连后立即补一次
      throw err
    }
    // 异步铸码:立即回读多半还是旧码 → 只在"未过期"时采用(过期码不落屏),
    // 新码由后续轮询(≤1.5s)从状态接口采用;回读失败不致命
    await pullStatus()
      .then((st) => {
        if (!st.isLogin && !isExpired(st)) adoptCode(st.qrcodeurl || '')
      })
      .catch((err) => {
        if (isNetworkError(err)) lastRefreshAt = 0
      })
  }

  /**
   * 连接失败/掉线:不进死错误态,丢旧码 + waiting + 定时重连(2026-10-22)。
   * 小窗开着等 NapCat 启动即可自动出码——旧实现这里 stopped=true,
   * 用户只能对着 "fetch failed" 干瞪眼,点「换一张」也常常还是没启动。
   */
  const scheduleReconnect = (err: unknown, prefix: string) => {
    stop()
    stopped = false
    qrUrl = ''
    qrAt = 0
    emit('waiting', `${prefix}:${describeLoginError(err)} · 自动重连中,请确认 NapCat 已启动`)
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = setTimeout(() => {
      retryTimer = null
      if (!stopped) void start()
    }, retryMs)
  }

  const tick = async () => {
    if (stopped) return
    try {
      const st = await pullStatus()
      if (stopped) return
      if (st.isLogin) {
        emit('done', 'QQ 登录成功')
        stop()
        return
      }
      // ① 过期码/无码:丢弃不落屏 + 立即换码(5s 冷却防打爆;不等 ttl——
      //    用户实测"一直显示过期"就是对着死码干等)
      if (isExpired(st) || !st.qrcodeurl) {
        qrUrl = ''
        if (now() - lastRefreshAt >= 5000) {
          await doRefresh()
          emit('waiting', qrUrl ? '已自动换新二维码' : '正在换新二维码…')
        } else {
          emit('waiting', '正在换新二维码…')
        }
        return
      }
      adoptCode(st.qrcodeurl)
      // ② 到点自动换码:手机扫到的永远是活码
      if (now() - qrAt >= ttlSec * 1000) {
        await doRefresh()
        emit('waiting', '已自动换新二维码')
        return
      }
      emit('waiting', st.loginError || '')
    } catch (err) {
      if (stopped) return
      if (isNetworkError(err)) {
        scheduleReconnect(err, `与 NapCat WebUI 的连接中断(${displayBase()})`)
        return
      }
      emit('waiting', `轮询异常:${(err as Error)?.message || err}`)
    }
  }

  async function start(): Promise<void> {
    if (starting) return
    starting = true
    stop()
    stopped = false
    try {
      await login()
      if (stopped) return
      let st = await pullStatus()
      if (stopped) return
      if (st.isLogin) {
        emit('done', 'QQ 登录成功')
        stop()
        return
      }
      if (!st.qrcodeurl || isExpired(st)) {
        // 初始码缺失/已过期 → RefreshQRcode 铸新码;异步落地前不落屏
        qrUrl = ''
        await doRefresh()
        if (stopped) return
        st = await pullStatus()
        if (stopped) return
        if (st.isLogin) {
          emit('done', 'QQ 登录成功')
          stop()
          return
        }
        if (st.qrcodeurl && !isExpired(st)) adoptCode(st.qrcodeurl)
        else if (!st.qrcodeurl) {
          // 冷启动兜底:服务端从未出码时 GetQQLoginQrcode 触发首铸(返回即当前跟踪码)
          await call('/QQLogin/GetQQLoginQrcode')
            .then((data: any) => {
              const u = String(data?.qrcode ?? '')
              if (u) {
                qrUrl = u
                qrAt = now()
              }
            })
            .catch(() => {})
        }
      } else {
        adoptCode(st.qrcodeurl)
      }
    } catch (err) {
      if (isNetworkError(err)) {
        scheduleReconnect(err, `无法连接 NapCat WebUI(${displayBase()})`)
        return
      }
      stopped = true
      emit('error', (err as Error)?.message || String(err))
      return
    } finally {
      starting = false
    }
    if (stopped) return
    emit('waiting', qrUrl ? '' : '正在换新二维码…')
    timer = setInterval(() => void tick(), pollMs)
  }

  async function refresh(): Promise<void> {
    // 错误态(start 失败后 stopped)或自动重连等待中 = 「换一张」立即整体重试
    // (原实现错误态直接 return,小窗按钮点了没反应,用户实测 2026-09-22)
    if (stopped || retryTimer) {
      await start()
      return
    }
    try {
      await doRefresh()
      emit('waiting', qrUrl ? '已换新二维码' : '正在换新二维码…')
    } catch (err) {
      if (isNetworkError(err)) {
        scheduleReconnect(err, `与 NapCat WebUI 的连接中断(${displayBase()})`)
        return
      }
      emit('waiting', `换码失败:${(err as Error)?.message || err}`)
    }
  }

  function stop(): void {
    stopped = true
    if (timer) clearInterval(timer)
    timer = null
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = null
  }

  return { start, refresh, stop }
}
