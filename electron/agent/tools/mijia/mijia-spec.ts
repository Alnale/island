/**
 * MIoT-Spec-V2 规格拉取 + 友名映射(2026-09-22)
 *
 * `GET https://miot-spec.org/miot-spec-v2/instance?type=<spec URN>` → services[]
 * (iid/type/description + properties[{piid,format,access,value-list,value-range}]
 * + actions[{aiid,in,out}]);LLM 用**友名**操作(`light:on` / `brightness`),
 * 本模块翻译到 siid/piid/aiid。缓存 = 内存 Map + userData/mijia-spec-cache.json
 * (非密钥,登记 data-manifest)。
 * 端点实测(2026-09-22):**只收完整 URN,不收 model**;旧端点
 * home.miot-spec.com/spec/instance 已 404 整站下线(曾致「规格不可用」、
 * 只剩灯光 FALLBACK)。URN 取 home_device_list 的 spec_type(设备记录
 * specType 字段),拿不到时用 model 探 URN 直查失败 → 走 ④ 兜底。
 *
 * 映射规则(代码内钉死):
 * ① `service:member` —— 服务短名(urn …:service:light:… → light)与
 *    属性/动作短名双段匹配,不区分大小写;
 * ② 裸名(`brightness`)—— 全 services 唯一命中才用;多义 → 报错列候选;
 * ③ FRIEND_ALIASES 别名归一(on|power|switch → on 等);
 * ④ spec 拉取失败且 model 含 light → FALLBACK_LIGHT 最小兜底(标注建议核对);
 * ⑤ 写需 access 含 write、读需含 read。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

export interface MiotPropSpec {
  piid: number
  type: string
  description: string
  format: string
  access: string[]
  valueList?: Array<{ value: number | string; description: string }>
  valueRange?: [number, number, number]
}

export interface MiotActionSpec {
  aiid: number
  type: string
  description: string
  in: number[]
  out: number[]
}

export interface MiotServiceSpec {
  iid: number
  type: string
  description: string
  properties: MiotPropSpec[]
  actions: MiotActionSpec[]
}

export interface MiotInstanceSpec {
  type: string
  description: string
  services: MiotServiceSpec[]
}

export type ResolvedTarget =
  | { kind: 'property'; siid: number; piid: number; format: string; access: string[]; valueList?: MiotPropSpec['valueList']; valueRange?: MiotPropSpec['valueRange']; note?: string }
  | { kind: 'action'; siid: number; aiid: number; in: number[]; note?: string }

export interface ResolveError {
  error: string
}

/** urn 短名:urn:miot-spec-v2:service:light:00007802:… → light;描述兜底 */
export function shortName(typeUrn: string, description: string): string {
  const m = /^urn:miot-spec-v2:(?:service|property|action):([a-z0-9-]+):/i.exec(typeUrn || '')
  if (m) return m[1].toLowerCase()
  return (description || '')
    .toLowerCase()
    .replace(/[()[\]（）【】\s._]/g, '')
    .trim()
}

/** 别名归一(硬编码;改表时保持注释同步) */
export const FRIEND_ALIASES: Record<string, string> = {
  on: 'on',
  power: 'on',
  switch: 'on',
  开关: 'on',
  开: 'on',
  brightness: 'brightness',
  亮度: 'brightness',
  'color-temperature': 'color-temperature',
  ct: 'color-temperature',
  色温: 'color-temperature',
  'target-temperature': 'target-temperature',
  目标温度: 'target-temperature',
  temperature: 'temperature',
  温度: 'temperature',
  mode: 'mode',
  模式: 'mode',
  'fan-level': 'fan-level',
  风速: 'fan-level',
}

/** spec 失败时 model 含 light 的最小兜底(MIoT 灯类通用 siid=2) */
export const FALLBACK_LIGHT: Record<string, { siid: number; piid: number; format: string }> = {
  on: { siid: 2, piid: 1, format: 'bool' },
  brightness: { siid: 2, piid: 2, format: 'uint8' },
  'color-temperature': { siid: 2, piid: 3, format: 'uint32' },
}

function normalizeMember(name: string): string {
  const n = (name || '').toLowerCase().trim()
  return FRIEND_ALIASES[n] ?? n
}

export interface MijiaSpec {
  /** specType = 设备 spec_type 完整 URN(规格端点只收 URN;缓存键仍是 model) */
  getInstance(model: string, o?: { signal?: AbortSignal; specType?: string }): Promise<MiotInstanceSpec | null>
  resolve(spec: MiotInstanceSpec, friend: string, want: 'read' | 'write' | 'invoke'): ResolvedTarget | ResolveError
  listFriendNames(spec: MiotInstanceSpec): Array<{ friend: string; kind: 'property' | 'action'; siid: number; piid?: number; aiid?: number }>
  /** spec 拉取失败的最小兜底(model 含 light 才给;其余 null) */
  fallbackFor(model: string, friend: string, want: 'read' | 'write'): ResolvedTarget | ResolveError | null
}

export function createMijiaSpec(o?: {
  fetchImpl?: typeof fetch
  userDataPath?: () => string
}): MijiaSpec {
  const fetchImpl: typeof fetch = o?.fetchImpl ?? ((...a) => fetch(...a))
  const userDataPath =
    o?.userDataPath ??
    (() => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { app } = require('electron') as typeof import('electron')
        return app.getPath('userData')
      } catch {
        return path.join(process.env.APPDATA ?? '', 'dynamic-island')
      }
    })

  const memCache = new Map<string, MiotInstanceSpec>()
  let diskCache: Record<string, MiotInstanceSpec> | null = null
  let diskLoaded = false
  let writeChain: Promise<unknown> = Promise.resolve()

  const cachePath = () => path.join(userDataPath(), 'mijia-spec-cache.json')

  async function loadDisk(): Promise<Record<string, MiotInstanceSpec>> {
    if (diskLoaded && diskCache) return diskCache
    try {
      const raw = await fs.readFile(cachePath(), 'utf8')
      const obj = JSON.parse(raw) as Record<string, MiotInstanceSpec>
      diskCache = obj && typeof obj === 'object' ? obj : {}
    } catch {
      diskCache = {}
    }
    diskLoaded = true
    for (const [model, spec] of Object.entries(diskCache)) {
      if (spec?.services) memCache.set(model, spec)
    }
    return diskCache
  }

  function saveDisk(model: string, spec: MiotInstanceSpec): void {
    writeChain = writeChain
      .then(async () => {
        try {
          const cache = (await loadDisk()) as Record<string, MiotInstanceSpec>
          cache[model] = spec
          const p = cachePath()
          await fs.mkdir(path.dirname(p), { recursive: true })
          const tmp = p + '.tmp'
          await fs.writeFile(tmp, JSON.stringify(cache), 'utf8')
          await fs.rename(tmp, p)
        } catch {
          // 缓存写失败静默(下次重拉)
        }
      })
      .catch(() => {})
  }

  function parseInstance(json: Record<string, unknown>): MiotInstanceSpec | null {
    const services = Array.isArray(json?.services) ? json.services : null
    if (!services) return null
    const out: MiotServiceSpec[] = []
    for (const raw of services) {
      if (!raw || typeof raw !== 'object') continue
      const s = raw as Record<string, unknown>
      const properties: MiotPropSpec[] = []
      for (const pr of Array.isArray(s.properties) ? s.properties : []) {
        if (!pr || typeof pr !== 'object') continue
        const p = pr as Record<string, unknown>
        properties.push({
          piid: Number(p.iid ?? 0),
          type: String(p.type ?? ''),
          description: String(p.description ?? ''),
          format: String(p.format ?? ''),
          access: Array.isArray(p.access) ? p.access.map(String) : [],
          valueList: Array.isArray(p['value-list'])
            ? (p['value-list'] as Array<Record<string, unknown>>).map((v) => ({
                value: (typeof v.value === 'number' || typeof v.value === 'string' ? v.value : 0) as number | string,
                description: String(v.description ?? ''),
              }))
            : undefined,
          valueRange: Array.isArray(p['value-range'])
            ? ([...p['value-range']] as [number, number, number])
            : undefined,
        })
      }
      const actions: MiotActionSpec[] = []
      for (const ar of Array.isArray(s.actions) ? s.actions : []) {
        if (!ar || typeof ar !== 'object') continue
        const a = ar as Record<string, unknown>
        actions.push({
          aiid: Number(a.iid ?? 0),
          type: String(a.type ?? ''),
          description: String(a.description ?? ''),
          in: Array.isArray(a.in) ? a.in.map(Number) : [],
          out: Array.isArray(a.out) ? a.out.map(Number) : [],
        })
      }
      out.push({
        iid: Number(s.iid ?? 0),
        type: String(s.type ?? ''),
        description: String(s.description ?? ''),
        properties,
        actions,
      })
    }
    return { type: String(json?.type ?? ''), description: String(json?.description ?? ''), services: out }
  }

  return {
    async getInstance(model, opt) {
      const hit = memCache.get(model)
      if (hit) return hit
      await loadDisk()
      const cached = memCache.get(model)
      if (cached) return cached
      // 端点只收完整 URN(实测 2026-09-22:model 直查 404「data not found」)
      const type = (opt?.specType || '').trim() || model
      try {
        const res = await fetchImpl(`https://miot-spec.org/miot-spec-v2/instance?type=${encodeURIComponent(type)}`, {
          signal: opt?.signal ?? AbortSignal.timeout(10_000),
        })
        if (!res.ok) return null
        const json = (await res.json()) as Record<string, unknown>
        const spec = parseInstance(json)
        if (spec) {
          memCache.set(model, spec)
          saveDisk(model, spec)
        }
        return spec
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') throw e
        return null
      }
    },

    resolve(spec, friend, want) {
      const raw = (friend || '').trim()
      if (!raw) return { error: '友名不能为空' }
      const [seg1, seg2] = raw.includes(':') ? raw.split(':').map((s) => s.trim()) : ['', raw]
      const member = normalizeMember(seg2 || seg1)
      const serviceWant = seg2 ? normalizeMember(seg1) : ''

      type Hit =
        | { kind: 'property'; siid: number; prop: MiotPropSpec }
        | { kind: 'action'; siid: number; act: MiotActionSpec }
      const hits: Hit[] = []
      for (const svc of spec.services) {
        const svcName = shortName(svc.type, svc.description)
        if (serviceWant && svcName !== serviceWant) continue
        for (const p of svc.properties) {
          if (shortName(p.type, p.description) === member || normalizeMember(p.description) === member) {
            hits.push({ kind: 'property', siid: svc.iid, prop: p })
          }
        }
        for (const a of svc.actions) {
          if (shortName(a.type, a.description) === member || normalizeMember(a.description) === member) {
            hits.push({ kind: 'action', siid: svc.iid, act: a })
          }
        }
      }
      if (hits.length === 0) {
        return { error: `未找到「${raw}」对应的能力;可用:${this.listFriendNames(spec).map((f) => f.friend).join(' / ') || '(无)'}` }
      }
      if (hits.length > 1) {
        const names = hits
          .map((h) =>
            h.kind === 'property'
              ? `${shortName(spec.services.find((s) => s.iid === h.siid)?.type ?? '', '')}:${shortName(h.prop.type, h.prop.description)}`
              : `${shortName(spec.services.find((s) => s.iid === h.siid)?.type ?? '', '')}:${shortName(h.act.type, h.act.description)}`,
          )
          .join(' / ')
        return { error: `「${raw}」有多个含义:${names};请用 service:member 形式指定` }
      }
      const hit = hits[0]
      if (hit.kind === 'property') {
        if (want === 'invoke') return { error: `「${raw}」是属性不是动作;设置请 action=set` }
        if (want === 'write' && !hit.prop.access.includes('write')) return { error: `「${raw}」是只读属性,不能设置` }
        if (want === 'read' && !hit.prop.access.includes('read')) return { error: `「${raw}」不可读` }
        return {
          kind: 'property',
          siid: hit.siid,
          piid: hit.prop.piid,
          format: hit.prop.format,
          access: hit.prop.access,
          valueList: hit.prop.valueList,
          valueRange: hit.prop.valueRange,
        }
      }
      if (want !== 'invoke') return { error: `「${raw}」是动作不是属性;执行请 action=invoke` }
      return { kind: 'action', siid: hit.siid, aiid: hit.act.aiid, in: hit.act.in }
    },

    listFriendNames(spec) {
      const out: Array<{ friend: string; kind: 'property' | 'action'; siid: number; piid?: number; aiid?: number }> = []
      for (const svc of spec.services) {
        const svcName = shortName(svc.type, svc.description) || `service-${svc.iid}`
        for (const p of svc.properties) {
          const name = shortName(p.type, p.description)
          if (name) out.push({ friend: `${svcName}:${name}`, kind: 'property', siid: svc.iid, piid: p.piid })
        }
        for (const a of svc.actions) {
          const name = shortName(a.type, a.description)
          if (name) out.push({ friend: `${svcName}:${name}`, kind: 'action', siid: svc.iid, aiid: a.aiid })
        }
      }
      return out
    },

    fallbackFor(model, friend, _want) {
      if (!/light/i.test(model || '')) return null
      const member = normalizeMember(friend.includes(':') ? friend.split(':')[1] : friend)
      const hit = FALLBACK_LIGHT[member]
      if (!hit) return { error: `规格暂不可用,兜底映射仅支持:${Object.keys(FALLBACK_LIGHT).join('/')} (设备 ${model})` }
      return {
        kind: 'property',
        siid: hit.siid,
        piid: hit.piid,
        format: hit.format,
        access: ['read', 'write'],
        note: '兜底映射(规格拉取失败),建议核对 siid/piid',
      }
    },
  }
}
