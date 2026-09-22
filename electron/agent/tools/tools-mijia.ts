/**
 * 米家智能家居工具簇(2026-09-22)
 *
 * 四工具:mijia_devices(查询)/ mijia_control(控制)/ mijia_scene(场景)/
 * mijia_login(登录管理)。WiFi 设备优先 miio 局域网直控(mijia-lan),
 * 失败/蓝牙(blt.)/远程自动走小米云(mijia-cloud miotspec 端点);
 * 能力友名经 mijia-spec 翻译到 siid/piid/aiid。
 *
 * 安全边界(用户拍板 2026-09-22):
 * - **门锁 unlock/开门、摄像头写入/动作/视频流:代码层硬禁**(不依赖提示词);
 * - **确认门:全部免确认**(不接 confirmAction/createTurnConfirmGate);
 * - **来源守卫**:写操作仅 window/panel/master-qq/master-group 放行(主人 QQ
 *   远程可控),读全放——判定优先 route.turnKind(classifyTurn 八值),
 *   getTurnSource 三值仅作兜底(分不了 master-qq 与 contact,勿单用);
 * - 凭证永不出现在工具返回/提示词(mijia-store 密文落盘)。
 *
 * 执行统一顺序:parse → 写守卫 → 设备硬禁 → loadAuth(null → 引导
 * mijia_login)→ LAN 优先失败降级云 → 每 await 查 ctx.signal。
 */

import type { AgentTool, ToolExecCtx, ToolParams } from '../types'
import { createMijiaStore, type MijiaAuth, type MijiaDeviceRecord, type MijiaRegion, type MijiaStore, MIJIA_REGIONS } from './mijia/mijia-store'
import { createMijiaCloud, type MijiaCloud, type MijiaSessionCreds } from './mijia/mijia-cloud'
import { createMijiaLan, type MijiaLan } from './mijia/mijia-lan'
import { createMijiaSpec, type MijiaSpec, type MiotInstanceSpec, type ResolvedTarget } from './mijia/mijia-spec'

// ---- 守卫(导出供单测;提示层不可绕过) ----

/** 写放行的轮次种类(classifyTurn 八值;主人 QQ 远程可控 = master-qq/master-group) */
export const MIJIA_WRITE_TURN_KINDS = new Set(['window', 'panel', 'master-qq', 'master-group'])

/**
 * 写操作来源守卫:kind(turnKind 八值)优先;仅 source 三值兜底时 window/panel
 * 放行(qq/group 分不清主人与否,安全侧拒)。读操作不走此门。
 */
export function assertMijiaWriteAllowed(kind: string | null | undefined, source?: string | null): void {
  if (kind != null) {
    if (MIJIA_WRITE_TURN_KINDS.has(kind)) return
    throw new Error(
      `当前轮次来源(${kind})无权操作米家设备——仅主人窗口/主人 QQ 远程可控;查询请用 mijia_devices(mijia 写守卫)`,
    )
  }
  if (source === 'window' || source === 'panel') return
  throw new Error('当前轮次来源无权操作米家设备——仅主人窗口/主人 QQ 远程可控;查询请用 mijia_devices(mijia 写守卫)')
}

export type MijiaBan = 'lock' | 'camera' | null

/** 硬禁设备分类(用户拍板硬禁,代码层拒绝,提示层不可绕过) */
export function classifyForbiddenDevice(d: { did: string; model: string }): MijiaBan {
  const text = `${d.model || ''} ${d.did || ''}`
  if (/(^|[.\s_-])lock|doorlock|magnet.*lock/i.test(text)) return 'lock'
  if (/camera|chuangmi\.camera|(^|[.\s_-])cam\./i.test(d.model || '')) return 'camera'
  return null
}

/** 硬禁断言:读放行;门锁/摄像头写与动作拒;「开锁/开门」类动作名双保险拒 */
export function assertMijiaDeviceAllowed(
  d: { did: string; model: string },
  op: 'read' | 'write' | 'invoke',
  actionName?: string,
): void {
  if (op === 'read') return
  if (actionName && /unlock|开锁|开门|开锁体/i.test(actionName)) {
    throw new Error(`「${actionName}」属于开锁/开门类动作,一律禁止执行(用户拍板硬禁,mijia 硬禁名单)`)
  }
  const ban = classifyForbiddenDevice(d)
  if (ban === 'lock') throw new Error(`门锁(${d.model || d.did})为安全敏感设备,禁止任何写操作/动作(用户拍板硬禁;状态查询可用)`)
  if (ban === 'camera') throw new Error(`摄像头(${d.model || d.did})为隐私敏感设备,禁止任何写操作/动作/视频流(用户拍板硬禁;状态查询可用)`)
}

// ---- 值转换(友名 value ↔ spec 格式) ----

function coerceValue(
  target: Extract<ResolvedTarget, { kind: 'property' }>,
  raw: unknown,
): { value: unknown } | { error: string } {
  const fmt = (target.format || '').toLowerCase()
  // value-list:枚举值精确匹配或 description 模糊匹配("auto"/"自动" → value)
  if (target.valueList?.length) {
    for (const item of target.valueList) {
      if (item.value === raw) return { value: item.value }
    }
    const s = String(raw ?? '').trim().toLowerCase()
    for (const item of target.valueList) {
      const d = String(item.description || '').trim().toLowerCase()
      if (d && (d === s || d.includes(s))) return { value: item.value }
    }
    return {
      error: `「${String(raw)}」不在可选值内:${target.valueList.map((i) => `${i.description}=${i.value}`).join(' / ')}`,
    }
  }
  if (fmt === 'bool') {
    if (typeof raw === 'boolean') return { value: raw }
    const s = String(raw ?? '').trim().toLowerCase()
    if (['1', 'true', 'on', '开', '打开', 'yes'].includes(s)) return { value: true }
    if (['0', 'false', 'off', '关', '关闭', 'no'].includes(s)) return { value: false }
    return { error: `「${String(raw)}」不是合法布尔值(true/false/on/off/开/关)` }
  }
  if (fmt.startsWith('uint') || fmt.startsWith('int') || fmt === 'float' || fmt === 'double') {
    const n = Number(raw)
    if (!Number.isFinite(n)) return { error: `「${String(raw)}」不是数字(${fmt})` }
    const range = target.valueRange
    if (range && (n < range[0] || n > range[1])) {
      return { error: `值 ${n} 超出范围 [${range[0]}, ${range[1]}]` }
    }
    return { value: fmt === 'float' || fmt === 'double' ? n : Math.round(n) }
  }
  return { value: String(raw ?? '') }
}

function formatValue(target: Extract<ResolvedTarget, { kind: 'property' }>, raw: unknown): string {
  if (target.valueList?.length) {
    const hit = target.valueList.find((i) => i.value === raw)
    if (hit) return `${hit.description}(${String(raw)})`
  }
  return String(raw)
}

// ---- 运行时(LAN hello 结果短缓存;测试可整体注入替换) ----

interface MijiaToolDeps {
  getTurnKind?(): string | null
  getTurnSource?(): string | null
  openLogin?(region?: string): void
  store?: MijiaStore
  cloud?: MijiaCloud
  lan?: MijiaLan
  spec?: MijiaSpec
  now?(): number
}

interface LanEndpoint {
  ip: string
  deviceId: number
  tokenHex: string
  at: number
}

const lanEndpointCache = new Map<string, LanEndpoint>()
const LAN_CACHE_TTL_MS = 60_000

export function resetMijiaRuntime(): void {
  lanEndpointCache.clear()
}

function throwIfAborted(ctx?: ToolExecCtx): void {
  if (ctx?.signal?.aborted) throw new DOMException('aborted', 'AbortError')
}

function maskId(id: string): string {
  const s = String(id ?? '')
  return s.length <= 3 ? '***' : `***${s.slice(-3)}`
}

function credsOf(auth: MijiaAuth): MijiaSessionCreds {
  return {
    userId: auth.userId,
    cUserId: auth.cUserId,
    ssecurity: auth.ssecurity,
    serviceToken: auth.serviceToken,
    deviceId: auth.deviceId,
    region: auth.region,
  }
}

/** 云 RPC(serviceToken 失效自动刷新一次后重试) */
async function cloudCall<T>(
  cloud: MijiaCloud,
  auth: MijiaAuth,
  store: MijiaStore,
  path: string,
  data: Record<string, unknown>,
  ctx?: ToolExecCtx,
): Promise<T> {
  throwIfAborted(ctx)
  try {
    return await cloud.call<T>(credsOf(auth), path, data, { signal: ctx?.signal })
  } catch (e) {
    const msg = (e as Error)?.message || String(e)
    if (!/登录态已失效|code=3/.test(msg)) throw e
    throwIfAborted(ctx)
    const serviceToken = await cloud.refreshServiceToken(auth, { signal: ctx?.signal })
    const next: MijiaAuth = { ...auth, serviceToken }
    await store.saveAuth(next)
    Object.assign(auth, next) // 调用方持有的同一对象同步更新
    return cloud.call<T>(credsOf(next), path, data, { signal: ctx?.signal })
  }
}

/** miotspec 云 RPC:属性读/写/动作(与 LAN JSON-RPC 同语义) */
// 响应结构实测(2026-09-22):`result` **直接是逐项数组**([{code,value?,…}]),
// 不是 result.props——旧解析取 result.props 恒空 → 成功也报「设置失败 code=-」
// (code ?? '-' 的空值文案),LLM 误判登录失效反复重开扫码窗(实测复盘)。
function resultItems(out: unknown): unknown[] {
  const r = (out as { result?: unknown } | null)?.result
  if (Array.isArray(r)) return r
  const props = (r as { props?: unknown } | null)?.props
  return Array.isArray(props) ? props : []
}

async function cloudPropGet(
  cloud: MijiaCloud,
  auth: MijiaAuth,
  store: MijiaStore,
  did: string,
  props: Array<{ siid: number; piid: number }>,
  ctx?: ToolExecCtx,
): Promise<Array<{ code: number; value?: unknown }>> {
  const out = await cloudCall(
    cloud,
    auth,
    store,
    '/miotspec/prop/get',
    { params: props.map((p) => ({ did, siid: p.siid, piid: p.piid })) },
    ctx,
  )
  return resultItems(out).map((r) => {
    const o = (r ?? {}) as { code?: number; value?: unknown }
    return { code: typeof o.code === 'number' ? o.code : -1, value: o.value }
  })
}

async function cloudPropSet(
  cloud: MijiaCloud,
  auth: MijiaAuth,
  store: MijiaStore,
  did: string,
  props: Array<{ siid: number; piid: number; value: unknown }>,
  ctx?: ToolExecCtx,
): Promise<Array<{ code: number }>> {
  const out = await cloudCall(
    cloud,
    auth,
    store,
    '/miotspec/prop/set',
    { params: props.map((p) => ({ did, siid: p.siid, piid: p.piid, value: p.value })) },
    ctx,
  )
  return resultItems(out).map((r) => ({
    code: typeof (r as { code?: number })?.code === 'number' ? (r as { code: number }).code : -1,
  }))
}

async function cloudAction(
  cloud: MijiaCloud,
  auth: MijiaAuth,
  store: MijiaStore,
  did: string,
  a: { siid: number; aiid: number; in?: unknown[] },
  ctx?: ToolExecCtx,
): Promise<{ code: number; out: unknown[] }> {
  const out = await cloudCall(
    cloud,
    auth,
    store,
    '/miotspec/action',
    { params: { did, siid: a.siid, aiid: a.aiid, in: a.in ?? [] } },
    ctx,
  )
  // result 兼容对象 {code,out} 与数组 [{code,out}] 两种形态
  const raw = (out as { result?: unknown } | null)?.result
  const r = (Array.isArray(raw) ? raw[0] : raw) ?? {}
  return { code: typeof (r as { code?: number }).code === 'number' ? (r as { code: number }).code : -1, out: Array.isArray((r as { out?: unknown[] }).out) ? (r as { out: unknown[] }).out : [] }
}

/** LAN 端点解析(hello 拿 deviceId 并校验 token;短缓存) */
async function lanEndpoint(
  lan: MijiaLan,
  dev: MijiaDeviceRecord,
  now: () => number,
  ctx?: ToolExecCtx,
): Promise<LanEndpoint | null> {
  if (!dev.localip || !dev.token || dev.did.startsWith('blt')) return null
  const hit = lanEndpointCache.get(dev.did)
  if (hit && now() - hit.at < LAN_CACHE_TTL_MS) return hit
  throwIfAborted(ctx)
  try {
    const hello = await lan.hello(dev.localip, { signal: ctx?.signal })
    const ep: LanEndpoint = {
      ip: dev.localip,
      deviceId: hello.deviceId,
      tokenHex: Buffer.from(hello.token).toString('hex'),
      at: now(),
    }
    lanEndpointCache.set(dev.did, ep)
    return ep
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw e
    return null // LAN 不通 → 调用方降级云
  }
}

export function createMijiaTools(deps: MijiaToolDeps): AgentTool[] {
  // 生产缺省:模块级惰性单例(引擎内共享缓存);测试经 deps 整体注入
  const store = deps.store ?? createMijiaStore()
  const cloud = deps.cloud ?? createMijiaCloud()
  const lan = deps.lan ?? createMijiaLan()
  const spec = deps.spec ?? createMijiaSpec()
  const now = deps.now ?? (() => Date.now())

  const guardWrite = () => assertMijiaWriteAllowed(deps.getTurnKind?.() ?? null, deps.getTurnSource?.() ?? null)

  /** 需要登录的所有操作入口 */
  const requireAuth = async (): Promise<MijiaAuth> => {
    const auth = await store.loadAuth()
    if (!auth) throw new Error('米家未登录或登录态不可用:请先 mijia_login action=login 扫码登录(mijia_login)')
    return auth
  }

  /** 刷新/读取设备缓存 */
  const loadDevices = async (refresh: boolean, auth: MijiaAuth | null, ctx?: ToolExecCtx): Promise<MijiaDeviceRecord[]> => {
    const cached = await store.loadDevices()
    if (!refresh && cached.length > 0) return cached
    if (!auth) return cached
    throwIfAborted(ctx)
    const homes = await cloud.getHome(credsOf(auth), { signal: ctx?.signal })
    const roomOf = new Map<string, string>()
    for (const h of homes) for (const r of h.rooms) roomOf.set(r.id, r.name)
    const devs: MijiaDeviceRecord[] = []
    const seen = new Set<string>()
    for (const h of homes) {
      throwIfAborted(ctx)
      const raws = await cloud.homeDeviceList(credsOf(auth), { id: h.id, owner: h.owner }, { signal: ctx?.signal })
      for (const r of raws) {
        if (seen.has(r.did)) continue
        seen.add(r.did)
        devs.push({
          did: r.did,
          model: r.model,
          name: r.name,
          localip: r.localip,
          token: r.token,
          isOnline: r.isOnline,
          parentDid: r.parentDid,
          fwVersion: r.fwVersion,
          specType: r.specType,
          room: r.roomId ? roomOf.get(r.roomId) : h.name,
        })
      }
    }
    if (devs.length > 0) await store.saveDevices(devs)
    return devs
  }

  /** 设备寻址:did 精确 → 名称精确 → 名称/房间模糊唯一 */
  const findDevice = (devs: MijiaDeviceRecord[], query: string): MijiaDeviceRecord => {
    const q = (query || '').trim()
    if (!q) throw new Error('device 不能为空(可用 mijia_devices action=list 查设备名/did)')
    const byDid = devs.find((d) => d.did === q)
    if (byDid) return byDid
    const lq = q.toLowerCase()
    const exact = devs.filter((d) => d.name.toLowerCase() === lq)
    if (exact.length === 1) return exact[0]
    const fuzzy = devs.filter(
      (d) => d.name.toLowerCase().includes(lq) || `${d.room ?? ''}${d.name}`.toLowerCase().includes(lq) || d.did.includes(q),
    )
    if (fuzzy.length === 1) return fuzzy[0]
    if (fuzzy.length === 0) throw new Error(`未找到设备「${q}」;可用 mijia_devices action=list 查看设备列表`)
    throw new Error(`「${q}」匹配到多台:${fuzzy.slice(0, 5).map((d) => `${d.name}(${d.did})`).join(' / ')};请用 did 或更完整的名字`)
  }

  /** 拉 spec(失败给 light 兜底注记;按 specType URN 查——端点不收 model) */
  const specOf = async (dev: MijiaDeviceRecord, ctx?: ToolExecCtx): Promise<MiotInstanceSpec | null> => {
    throwIfAborted(ctx)
    return spec.getInstance(dev.model, { signal: ctx?.signal, specType: dev.specType })
  }

  // ---- 工具 1:mijia_devices ----
  const devicesTool: AgentTool = {
    name: 'mijia_devices',
    description:
      '米家智能家居设备查询(自研直连):列出账号下设备/查单个设备实时状态/按名称或房间过滤。' +
      '适合用户问「家里有哪些设备」「客厅灯开着吗」「空调多少度」。只读安全,任何会话来源可用;' +
      '控制设备用 mijia_control,场景用 mijia_scene;门锁/摄像头按安全策略禁用控制(查询可用)。未登录时引导 mijia_login。',
    timeoutMs: 45_000,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'status'], description: 'list=设备清单(缺省);status=查单设备属性' },
        query: { type: 'string', description: '过滤:设备名/房间名/did(status 时 = 目标设备,模糊匹配需唯一)' },
        props: {
          type: 'array',
          items: { type: 'string' },
          description: 'status 要查的友名列表(如 ["light:on","light:brightness"]);缺省查该设备全部可读属性',
        },
        refresh: { type: 'boolean', description: 'true=强制刷新云设备列表(默认走缓存)' },
      },
      required: ['action'],
    },
    async execute(params: ToolParams, ctx?: ToolExecCtx) {
      const action = String(params.action ?? 'list')
      const query = typeof params.query === 'string' ? params.query.trim() : ''
      const refresh = params.refresh === true
      const auth = await store.loadAuth().catch(() => null)
      if (!auth) return '米家未登录:请先 mijia_login action=login 扫码登录(mijia_devices)'
      const devs = await loadDevices(refresh, auth, ctx)
      if (action === 'list') {
        const q = query.toLowerCase()
        const filtered = q
          ? devs.filter(
              (d) =>
                d.name.toLowerCase().includes(q) ||
                (d.room ?? '').toLowerCase().includes(q) ||
                d.did.includes(query) ||
                d.model.toLowerCase().includes(q),
            )
          : devs
        if (filtered.length === 0) return query ? `没有匹配「${query}」的设备(refresh=true 可强制刷新)` : '账号下暂无设备(refresh=true 可强制刷新;这不是登录问题,禁止 mijia_login 重开扫码窗)'
        const lines = filtered.slice(0, 200).map((d) => {
          const ban = classifyForbiddenDevice(d)
          const conn = d.did.startsWith('blt') ? 'ble' : d.token && d.localip ? 'lan|cloud' : 'cloud'
          return `- [${d.did}] ${d.name}(${d.room ?? '未分房'}) ${d.model} ${d.isOnline === false ? '离线' : '在线'} 通道=${conn}${ban ? ` 禁控=${ban}` : ''}`
        })
        return `共 ${filtered.length} 台设备:\n${lines.join('\n')}`
      }
      // status
      const dev = findDevice(devs, query)
      assertMijiaDeviceAllowed(dev, 'read')
      const s = await specOf(dev, ctx)
      let targets: Array<{ friend: string; target: ResolvedTarget }> = []
      const wanted = Array.isArray(params.props) ? params.props.map((p) => String(p)).filter(Boolean) : []
      if (wanted.length > 0) {
        for (const w of wanted) {
          const t = s ? spec.resolve(s, w, 'read') : spec.fallbackFor(dev.model, w, 'read')
          if (!t || 'error' in t) {
            targets.push({ friend: w, target: { kind: 'property', siid: -1, piid: -1, format: '', access: [] } })
            continue
          }
          targets.push({ friend: w, target: t })
        }
      } else if (s) {
        targets = spec
          .listFriendNames(s)
          .filter((f) => f.kind === 'property' && f.piid != null)
          .slice(0, 16)
          .map((f) => {
            const t = spec.resolve(s, f.friend, 'read')
            return { friend: f.friend, target: t && !('error' in t) ? t : { kind: 'property' as const, siid: f.siid, piid: f.piid!, format: '', access: [] } }
          })
      } else {
        return `设备 ${dev.name}(${dev.model})的规格暂不可用,无法解析属性;可显式给 props 友名或稍后再试(规格拉取失败与登录无关,禁止 mijia_login 重开扫码窗)`
      }
      // 取值:LAN 优先,失败降级云
      const valid = targets.filter((t) => t.target.kind === 'property' && t.target.siid > 0)
      const invalid = targets.filter((t) => !(t.target.kind === 'property' && t.target.siid > 0))
      const props = valid.map((t) => ({
        siid: (t.target as Extract<ResolvedTarget, { kind: 'property' }>).siid,
        piid: (t.target as Extract<ResolvedTarget, { kind: 'property' }>).piid,
      }))
      let values: Array<{ code: number; value?: unknown }> = []
      let channel = 'cloud'
      const ep = await lanEndpoint(lan, dev, now, ctx)
      if (ep && props.length > 0) {
        try {
          values = await lan.getProperties(ep.ip, ep.tokenHex, ep.deviceId, props, { signal: ctx?.signal })
          channel = 'lan'
        } catch (e) {
          if ((e as Error)?.name === 'AbortError') throw e
          values = []
        }
      }
      if (channel !== 'lan' && props.length > 0) {
        values = await cloudPropGet(cloud, auth, store, dev.did, props, ctx)
      }
      const rows: string[] = valid.map((t, i) => {
        const target = t.target as Extract<ResolvedTarget, { kind: 'property' }>
        const v = values[i]
        if (!v || v.code !== 0) return `${t.friend}=(读取失败 code=${v?.code ?? '-'})`
        return `${t.friend}=${formatValue(target, v.value)}`
      })
      for (const t of invalid) rows.push(`${t.friend}=(无法解析)`)
      return `${dev.name}(${dev.model},${dev.did},通道 ${channel}):\n${rows.join(' / ')}`
    },
  }

  // ---- 工具 2:mijia_control ----
  const controlTool: AgentTool = {
    name: 'mijia_control',
    description:
      '米家设备控制(自研直连):设置属性(action=set,如开关 on/亮度 brightness/目标温度)或执行动作(action=invoke,如扫地 start-sweep)。' +
      '**仅主人来源可写**(对话窗口/主人 QQ 远程);门锁与摄像头按安全策略**禁止**任何控制(代码层拒绝,含开锁/开门类动作名)。' +
      '查询请用 mijia_devices。免确认,一次调用可带多项属性。参数用友名 light:on / light:brightness,或显式 siid/piid(value 建议按规格取值)。',
    timeoutMs: 30_000,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['set', 'invoke'], description: 'set=设属性;invoke=执行动作' },
        device: { type: 'string', description: '设备名/房间+名/did(模糊匹配需唯一)' },
        set: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              prop: { type: 'string', description: '属性友名(如 on/brightness/light:mode)' },
              value: { description: '设置值(布尔/数字/字符串;枚举属性可给描述如 "auto")' },
              siid: { type: 'number', description: '显式服务 ID(与 prop 二选一)' },
              piid: { type: 'number', description: '显式属性 ID(与 prop 二选一)' },
            },
          },
          description: 'action=set 时的属性列表',
        },
        invoke: {
          type: 'object',
          properties: {
            prop: { type: 'string', description: '动作友名(如 light:toggle / start-sweep)' },
            siid: { type: 'number', description: '显式服务 ID' },
            aiid: { type: 'number', description: '显式动作 ID' },
            in: { type: 'array', description: '动作入参列表(按规格 in 顺序)' },
          },
          description: 'action=invoke 时的动作',
        },
      },
      required: ['action', 'device'],
    },
    async execute(params: ToolParams, ctx?: ToolExecCtx) {
      guardWrite()
      const action = String(params.action ?? '')
      const auth = await requireAuth()
      const devs = await loadDevices(false, auth, ctx)
      const dev = findDevice(devs, String(params.device ?? ''))
      if (action === 'set') {
        assertMijiaDeviceAllowed(dev, 'write')
        const items = Array.isArray(params.set) ? params.set : []
        if (items.length === 0) throw new Error('set 需要非空属性列表(如 [{prop:"on", value:true}])')
        const s = await specOf(dev, ctx)
        const prepared: Array<{ friend: string; siid: number; piid: number; value: unknown }> = []
        const failures: string[] = []
        for (const raw of items) {
          const item = (raw ?? {}) as { prop?: string; value?: unknown; siid?: number; piid?: number }
          const friend = item.prop ? String(item.prop) : `siid=${item.siid},piid=${item.piid}`
          if (item.prop) {
            const t = s ? spec.resolve(s, item.prop, 'write') : spec.fallbackFor(dev.model, item.prop, 'write')
            if (!t || 'error' in t) {
              failures.push(`${friend}:${t && 'error' in t ? t.error : '规格不可用'}`)
              continue
            }
            if (t.kind !== 'property') {
              failures.push(`${friend}:是动作不是属性(action=invoke)`)
              continue
            }
            const v = coerceValue(t, item.value)
            if ('error' in v) {
              failures.push(`${friend}:${v.error}`)
              continue
            }
            prepared.push({ friend: item.prop, siid: t.siid, piid: t.piid, value: v.value })
          } else if (typeof item.siid === 'number' && typeof item.piid === 'number') {
            assertMijiaDeviceAllowed(dev, 'write', friend) // 显式 ID 也过动作名双保险(friend 文本)
            prepared.push({ friend, siid: item.siid, piid: item.piid, value: item.value })
          } else {
            failures.push(`${friend}:需要 prop 或 siid+piid`)
          }
        }
        if (prepared.length === 0) return `全部设置失败:\n${failures.join('\n')}`
        // LAN 优先,失败降级云
        let codes: Array<{ code: number }> = []
        let channel = 'cloud'
        const ep = await lanEndpoint(lan, dev, now, ctx)
        if (ep) {
          try {
            codes = await lan.setProperties(
              ep.ip,
              ep.tokenHex,
              ep.deviceId,
              prepared.map((p) => ({ siid: p.siid, piid: p.piid, value: p.value })),
              { signal: ctx?.signal },
            )
            channel = 'lan'
          } catch (e) {
            if ((e as Error)?.name === 'AbortError') throw e
            codes = []
          }
        }
        if (channel !== 'lan') {
          codes = await cloudPropSet(
            cloud,
            auth,
            store,
            dev.did,
            prepared.map((p) => ({ siid: p.siid, piid: p.piid, value: p.value })),
            ctx,
          )
        }
        const done: string[] = []
        prepared.forEach((p, i) => {
          const code = codes[i]?.code
          if (code === 0) done.push(`${p.friend}=${JSON.stringify(p.value)}`)
          else if (code === undefined) failures.push(`${p.friend}:响应缺逐项结果(结构异常,可重试一次)`)
          else failures.push(`${p.friend}:设备拒绝 code=${code}(规格值/设备侧原因,与登录无关)`)
        })
        const head = done.length > 0 ? `已设置 ${dev.name}:${done.join('、')}(通道 ${channel})` : `设置均失败(通道 ${channel})`
        return failures.length > 0 ? `${head}\n失败项:\n${failures.join('\n')}` : head
      }
      if (action === 'invoke') {
        const inv = (params.invoke ?? {}) as { prop?: string; siid?: number; aiid?: number; in?: unknown[] }
        const actionName = inv.prop ? String(inv.prop) : `siid=${inv.siid},aiid=${inv.aiid}`
        assertMijiaDeviceAllowed(dev, 'invoke', actionName)
        let siid = inv.siid
        let aiid = inv.aiid
        let input: unknown[] = Array.isArray(inv.in) ? inv.in : []
        if (inv.prop) {
          const s = await specOf(dev, ctx)
          const t = s ? spec.resolve(s, inv.prop, 'invoke') : null
          if (!t || 'error' in t) {
            throw new Error(`动作「${inv.prop}」解析失败:${t && 'error' in t ? t.error : '规格不可用'}`)
          }
          if (t.kind !== 'action') throw new Error(`「${inv.prop}」是属性不是动作(设置请 action=set)`)
          siid = t.siid
          aiid = t.aiid
          if (input.length === 0 && t.in.length > 0) {
            // 无入参但规格要求入参 → 明确报缺(结构化,LLM 自纠)
            throw new Error(`动作「${inv.prop}」需要 ${t.in.length} 个入参(in 数组),规格要求先给参数`)
          }
        }
        if (typeof siid !== 'number' || typeof aiid !== 'number') {
          throw new Error('invoke 需要 prop 或 siid+aiid')
        }
        let result: { code: number; out: unknown[] } = { code: -1, out: [] }
        let channel = 'cloud'
        const ep = await lanEndpoint(lan, dev, now, ctx)
        if (ep) {
          try {
            result = await lan.invokeAction(ep.ip, ep.tokenHex, ep.deviceId, { siid, aiid, in: input }, { signal: ctx?.signal })
            channel = 'lan'
          } catch (e) {
            if ((e as Error)?.name === 'AbortError') throw e
            result = { code: -1, out: [] }
          }
        }
        if (channel !== 'lan') {
          result = await cloudAction(cloud, auth, store, dev.did, { siid, aiid, in: input }, ctx)
        }
        if (result.code !== 0) throw new Error(`动作 ${actionName} 执行失败 code=${result.code}(设备 ${dev.name};设备侧原因,与登录无关)`)
        return `已执行 ${dev.name} 动作 ${actionName}(通道 ${channel},code=0${result.out.length ? `,输出 ${JSON.stringify(result.out).slice(0, 200)}` : ''})`
      }
      throw new Error(`未知 action:${action}(可用 set/invoke)`)
    },
  }

  // ---- 工具 3:mijia_scene ----
  const sceneTool: AgentTool = {
    name: 'mijia_scene',
    description:
      '米家智能场景:列出手动场景 / 运行指定场景(「回家模式」「观影模式」…)。run **仅主人来源**(窗口/主人 QQ 远程)。' +
      '请勿运行含门锁开锁的场景(名字含开锁/开门/unlock 会被拒绝;场景内容无法逐设备审计,安全敏感场景请勿创建)。' +
      '自动化(条件触发)v1 只读列表元数据。',
    timeoutMs: 30_000,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'run'], description: 'list=列出场景;run=运行' },
        scene: { type: 'string', description: 'run:场景名或 id(模糊匹配需唯一)' },
        include_auto: { type: 'boolean', description: 'list 是否包含自动化场景(缺省 false 只列手动)' },
      },
      required: ['action'],
    },
    async execute(params: ToolParams, ctx?: ToolExecCtx) {
      const action = String(params.action ?? 'list')
      const auth = await requireAuth()
      if (action === 'list') {
        try {
          const scenes = await cloud.sceneList(credsOf(auth), { signal: ctx?.signal })
          const includeAuto = params.include_auto === true
          const filtered = includeAuto ? scenes : scenes.filter((s) => s.kind !== 'auto')
          if (filtered.length === 0) return '没有可用场景(include_auto=true 可看自动化)'
          return `共 ${filtered.length} 个场景:\n${filtered.map((s) => `- [${s.id}] ${s.name}(${s.enable ? '启用' : '停用'}${s.kind === 'auto' ? ',自动化' : ''})`).join('\n')}`
        } catch (e) {
          return `场景列表获取失败:${(e as Error)?.message};可用 mijia_control 手动操作设备(mijia_scene)`
        }
      }
      if (action === 'run') {
        guardWrite()
        const q = String(params.scene ?? '').trim()
        if (!q) throw new Error('run 需要 scene(场景名或 id)')
        // 场景名开锁/开门双保险(场景内容无法逐设备审计)
        if (/开锁|开门|unlock/i.test(q)) throw new Error(`场景「${q}」名含开锁/开门,拒绝执行(用户拍板硬禁)`)
        const scenes = await cloud.sceneList(credsOf(auth), { signal: ctx?.signal }).catch(() => [])
        const exact = scenes.filter((s) => s.id === q || s.name === q)
        const fuzzy = exact.length > 0 ? exact : scenes.filter((s) => s.name.includes(q) || s.id.includes(q))
        if (fuzzy.length === 0) throw new Error(`未找到场景「${q}」;mijia_scene action=list 可查`)
        if (fuzzy.length > 1) {
          throw new Error(`「${q}」匹配多个场景:${fuzzy.slice(0, 5).map((s) => `${s.name}(${s.id})`).join(' / ')};请用 id`)
        }
        const scene = fuzzy[0]
        try {
          await cloud.sceneRun(credsOf(auth), scene.id, { signal: ctx?.signal })
        } catch (e) {
          throw new Error(`场景执行失败:${(e as Error)?.message}(若端点暂不可用,可用 mijia_control 手动操作)`)
        }
        return `已运行场景「${scene.name}」`
      }
      throw new Error(`未知 action:${action}(可用 list/run)`)
    },
  }

  // ---- 工具 4:mijia_login ----
  const loginTool: AgentTool = {
    name: 'mijia_login',
    description:
      '米家账号登录管理:status 查登录态 / login 打开扫码登录小窗(米家 App 扫码确认,登录成功自动关闭)/ logout 退出登录并清本地凭证。' +
      '**login 仅当 status 显示未登录、或工具明确报「登录态已失效」时才用**;' +
      '「规格不可用」「设备拒绝 code=」「写守卫拒绝」等错误都**与登录无关,禁止重开扫码窗**' +
      '(2026-09-22 实测教训:误判登录失效反复重验十几次)。' +
      '已登录时再 login 需 force=true(换账号/确要重登)。login/logout 仅主人来源(status 随处可用)。',
    timeoutMs: 20_000,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'login', 'logout'], description: 'status=登录状态;login=打开扫码登录窗;logout=退出' },
        region: {
          type: 'string',
          enum: [...MIJIA_REGIONS],
          description: '登录区域,缺省 cn(login 前可先指定)',
        },
        force: {
          type: 'boolean',
          description: '已登录时强制重开扫码窗(换账号/确要重登才用;缺省 false 会拦下不必要的重验)',
        },
      },
      required: ['action'],
    },
    async execute(params: ToolParams) {
      const action = String(params.action ?? 'status')
      const region = typeof params.region === 'string' && (MIJIA_REGIONS as readonly string[]).includes(params.region)
        ? (params.region as MijiaRegion)
        : undefined
      if (action === 'status') {
        const auth = await store.loadAuth().catch(() => null)
        if (!auth) return '未登录:请 mijia_login action=login 扫码登录(米家 App 扫码确认)'
        const devs = await store.loadDevices().catch(() => [])
        return `已登录(账号 ${maskId(auth.userId)},region=${auth.region},缓存设备 ${devs.length} 台${store.didSecretPersist() ? '' : ';注意:本次凭证仅内存保留,重启需重登'})`
      }
      if (action === 'login') {
        guardWrite()
        if (!deps.openLogin) return '本环境不支持打开登录窗口(仅桌面主进程可用)'
        // 已登录时拦下非强制重开(2026-09-22:LLM 把非登录错误误判成登录失效,
        // 反复开窗让主人重验十几次——force 之外一律拒绝)
        const auth = await store.loadAuth().catch(() => null)
        if (auth && params.force !== true) {
          const devs = await store.loadDevices().catch(() => [])
          return (
            `已登录(账号 ${maskId(auth.userId)},缓存设备 ${devs.length} 台),无需重新扫码。` +
            '若设备/控制报错,那是规格/设备侧问题,与登录无关——先 mijia_devices refresh=true 或看错误里的提示排查;' +
            '确要换账号/重新登录才用 login force=true'
          )
        }
        deps.openLogin(region)
        return `已打开米家扫码登录窗口${region ? `(region=${region})` : ''}…请用米家 App 扫码,在手机上确认登录`
      }
      if (action === 'logout') {
        guardWrite()
        await store.clearAuth()
        resetMijiaRuntime()
        return '已退出米家登录并清除本地凭证'
      }
      throw new Error(`未知 action:${action}(可用 status/login/logout)`)
    },
  }

  return [devicesTool, controlTool, sceneTool, loginTool]
}
