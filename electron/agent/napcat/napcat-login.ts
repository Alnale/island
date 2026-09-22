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
  /** 当前码自动换码剩余秒数 */
  remainSec: number
  /** 服务端状态文本(如"已扫码,待确认";空 = 等待扫码) */
  message: string
}

export interface NapcatLoginApiDeps {
  baseUrl?: string
  token: string
  fetchImpl?: typeof fetch
  sha256Hex(text: string): string
  now?: () => number
  ttlSec?: number
  pollMs?: number
  onUpdate(state: LoginState): void
}

/** WebUI 登录口令散列(前端约定:SHA256(token + '.napcat') 十六进制) */
export function webuiTokenHash(token: string, sha256Hex: (t: string) => string): string {
  return sha256Hex(String(token ?? '') + '.napcat')
}

export interface NapcatLoginFlow {
  start(): Promise<void>
  refresh(): Promise<void>
  stop(): void
}

export function createNapcatLoginFlow(deps: NapcatLoginApiDeps): NapcatLoginFlow {
  // API 前缀(2026-09-22 实测修复):NapCat WebUI 前端 axios baseURL = '/api',
  // 登录/取码/状态/换码全在 /api 之下——漏前缀时 /auth/login 404,登录流从未
  // 取到码 = 小窗白板根因(用户实测)。baseUrl 已带 /api 时不重复拼接。
  const root = (deps.baseUrl || 'http://127.0.0.1:6099').replace(/\/+$/, '')
  const base = /\/api$/i.test(root) ? root : `${root}/api`
  const fetchImpl: typeof fetch = deps.fetchImpl ?? ((...a) => fetch(...a))
  const now = deps.now ?? (() => Date.now())
  const ttlSec = deps.ttlSec ?? 105
  const pollMs = deps.pollMs ?? 1500

  let cred = ''
  let qrUrl = ''
  let qrAt = 0
  let lastRefreshAt = 0
  let stopped = true
  let timer: ReturnType<typeof setInterval> | null = null

  const emit = (phase: LoginPhase, message: string) => {
    const ageSec = qrUrl ? Math.max(0, Math.floor((now() - qrAt) / 1000)) : 0
    deps.onUpdate({
      phase,
      qrUrl,
      ageSec,
      remainSec: Math.max(0, ttlSec - ageSec),
      message,
    })
  }

  const call = async (path: string, body?: unknown): Promise<any> => {
    const res = await fetchImpl(base + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cred ? { Authorization: `Bearer ${cred}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : '{}',
    })
    const text = await res.text().catch(() => '')
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
      throw new Error(`NapCat WebUI ${path} 调用失败:${detail}`)
    }
    return json.data
  }

  const login = async () => {
    const data = await call('/auth/login', { hash: webuiTokenHash(deps.token, deps.sha256Hex) })
    cred = String(data?.Credential ?? '')
    if (!cred) throw new Error('NapCat WebUI 登录失败:未返回 Credential(token 是否正确?)')
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
    await call('/QQLogin/RefreshQRcode', {})
    // 异步铸码:立即回读多半还是旧码 → 只在"未过期"时采用(过期码不落屏),
    // 新码由后续轮询(≤1.5s)从状态接口采用;回读失败不致命
    await pullStatus()
      .then((st) => {
        if (!st.isLogin && !isExpired(st)) adoptCode(st.qrcodeurl || '')
      })
      .catch(() => {})
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
      if (!stopped) emit('waiting', `轮询异常:${(err as Error)?.message || err}`)
    }
  }

  async function start(): Promise<void> {
    stop()
    stopped = false
    try {
      await login()
      let st = await pullStatus()
      if (st.isLogin) {
        emit('done', 'QQ 登录成功')
        stop()
        return
      }
      if (!st.qrcodeurl || isExpired(st)) {
        // 初始码缺失/已过期 → RefreshQRcode 铸新码;异步落地前不落屏
        qrUrl = ''
        await doRefresh()
        st = await pullStatus()
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
      stopped = true
      emit('error', (err as Error)?.message || String(err))
      return
    }
    emit('waiting', qrUrl ? '' : '正在换新二维码…')
    timer = setInterval(() => void tick(), pollMs)
  }

  async function refresh(): Promise<void> {
    // 错误态(start 失败后 stopped)下「换一张」= 整体重试——原实现直接 return,
    // 小窗的「换一张」按钮在认证失败后点了没反应(用户实测,2026-09-22 修复)
    if (stopped) {
      await start()
      return
    }
    try {
      await doRefresh()
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
