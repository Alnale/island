/**
 * 米家凭证/设备缓存持久化域(2026-09-22)
 *
 * 落盘纪律参照 napcat-store.ts(内存缓存 + 串行写队列 + tmp+rename 原子写)
 * 与 settings-store.cjs 的密钥语义(密钥字段 DPAPI 加密 `enc:v1:` 前缀落盘):
 * ① **绝不写明文密钥**——encrypt 不可用时密钥字段直接丢弃,本次运行仅内存
 *    保留(与 settings-store「不能加密 = 不落盘」同款);解密失败 = 当作未登录,
 *    引导重新扫码,绝不拿密文当凭证用;
 * ② ssecurity / passToken / serviceToken / 设备 LAN token 全部按密钥处理;
 * ③ 损坏文件静默回空(登录态丢失只影响米家功能,不炸引擎)。
 *
 * 加密与 userData 路径经 deps 注入(测试注入 stub;生产缺省从 electron 懒取
 * safeStorage/app——注意 Electron 43 safeStorage 与 userData 路径绑定,
 * 外部脚本解密必须先 app.setPath('userData') 到同一路径)。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

/** 与 settings-store.cjs 同款前缀语义(enc:v1: + base64 密文) */
export const MIJIA_SECRET_PREFIX = 'enc:v1:'

export type MijiaRegion = 'cn' | 'de' | 'us' | 'ru' | 'tw' | 'sg' | 'in' | 'i2'
export const MIJIA_REGIONS: readonly MijiaRegion[] = ['cn', 'de', 'us', 'ru', 'tw', 'sg', 'in', 'i2']

const AUTH_FILE = 'mijia-auth.json'
const DEVICES_FILE = 'mijia-devices.json'
const MAX_DEVICES = 500

/** 小米账号登录会话(内存明文;落盘时 ★ 字段经 DPAPI 加密) */
export interface MijiaAuth {
  userId: string
  cUserId: string
  /** ★ base64(ssecurity)——云 API 签名根密钥 */
  ssecurity: string
  /** ★ 刷新 serviceToken 用 */
  passToken: string
  /** ★ 云 API cookie 值 */
  serviceToken: string
  region: MijiaRegion
  /** 16 hex 稳定随机(请求头/签名用;非密钥但不进工具返回) */
  deviceId: string
  updatedAt: number
}

/** 设备缓存条目(token 为 miio LAN 16B token 的 hex,按密钥处理) */
export interface MijiaDeviceRecord {
  did: string
  model: string
  name: string
  room?: string
  localip?: string
  /** ★ miio 局域网 token(32 hex;全 0 = 设备禁用局域网控制) */
  token?: string
  isOnline?: boolean
  /** 网关/多模下的子设备宿主 did */
  parentDid?: string
  fwVersion?: string
  /** 完整 spec URN(home_device_list 的 spec_type;规格端点按 URN 查询必需) */
  specType?: string
}

export interface MijiaStoreDeps {
  /** 返回 enc:v1: 密文;不可用返回 null(调用方丢弃密钥字段,绝不落明文) */
  encrypt(plain: string): string | null
  /** 接受 enc:v1:/enc: 密文;失败返回 null */
  decrypt(enc: string): string | null
  userDataPath(): string
  now?(): number
}

export interface MijiaStore {
  /** 损坏/密钥字段缺失或不可解密 → null(引导重新登录) */
  loadAuth(): Promise<MijiaAuth | null>
  saveAuth(auth: MijiaAuth): Promise<void>
  clearAuth(): Promise<void>
  loadDevices(): Promise<MijiaDeviceRecord[]>
  saveDevices(list: MijiaDeviceRecord[]): Promise<void>
  /** 清内存缓存(清除数据后调用,防旧缓存"复活"已删文件) */
  resetMijiaStore(): void
  /** 最近一次 saveAuth 密钥是否成功落盘(false = 仅内存,重启需重登) */
  didSecretPersist(): boolean
}

/** 生产缺省:DPAPI 加密(语义对齐 settings-store.cjs encryptSecret/decryptSecret) */
function defaultEncrypt(plain: string): string | null {
  try {
    // electron 为 esbuild external;懒 require 防测试桩在 import 期缺 safeStorage
    const { safeStorage } = require('electron') as typeof import('electron')
    if (!safeStorage?.isEncryptionAvailable?.()) return null
    return MIJIA_SECRET_PREFIX + safeStorage.encryptString(plain).toString('base64')
  } catch {
    return null
  }
}

function defaultDecrypt(enc: string): string | null {
  try {
    const { safeStorage } = require('electron') as typeof import('electron')
    if (!safeStorage?.isEncryptionAvailable?.()) return null
    const b64 = enc.startsWith(MIJIA_SECRET_PREFIX)
      ? enc.slice(MIJIA_SECRET_PREFIX.length)
      : enc.startsWith('enc:')
        ? enc.slice(4)
        : null
    if (b64 === null) return null // 明文旧格式一律拒绝当凭证(防降级后明文复活)
    return safeStorage.decryptString(Buffer.from(b64, 'base64'))
  } catch {
    return null
  }
}

function defaultUserDataPath(): string {
  try {
    const { app } = require('electron') as typeof import('electron')
    return app.getPath('userData')
  } catch {
    return path.join(process.env.APPDATA ?? '', 'dynamic-island')
  }
}

function isSecretValue(v: unknown): v is string {
  return typeof v === 'string' && v.startsWith('enc:')
}

export function createMijiaStore(deps?: Partial<MijiaStoreDeps>): MijiaStore {
  const encrypt = deps?.encrypt ?? defaultEncrypt
  const decrypt = deps?.decrypt ?? defaultDecrypt
  const userDataPath = deps?.userDataPath ?? defaultUserDataPath
  const now = deps?.now ?? (() => Date.now())

  const authPath = () => path.join(userDataPath(), AUTH_FILE)
  const devicesPath = () => path.join(userDataPath(), DEVICES_FILE)

  let authCache: MijiaAuth | null | undefined // undefined = 未加载
  let devicesCache: MijiaDeviceRecord[] | null = null
  let devicesLoaded = false
  let secretPersistOk = true
  let authWriteChain: Promise<unknown> = Promise.resolve()
  let devicesWriteChain: Promise<unknown> = Promise.resolve()

  async function writeJson(p: string, obj: unknown): Promise<void> {
    await fs.mkdir(path.dirname(p), { recursive: true })
    const tmp = p + '.tmp'
    await fs.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8')
    await fs.rename(tmp, p)
  }

  function serializeAuth(auth: MijiaAuth): Record<string, unknown> {
    // 密钥字段:能加密 → 密文;不能 → 字段整个丢弃(secretPersistOk=false)
    const enc = (v: string): string | null => {
      const out = encrypt(v)
      if (out == null) {
        secretPersistOk = false
        return null
      }
      return out
    }
    const out: Record<string, unknown> = {
      mijiaSchemaVersion: 1,
      userId: auth.userId,
      cUserId: auth.cUserId,
      region: auth.region,
      deviceId: auth.deviceId,
      updatedAt: auth.updatedAt,
    }
    const ssecurity = enc(auth.ssecurity)
    const passToken = enc(auth.passToken)
    const serviceToken = enc(auth.serviceToken)
    if (ssecurity != null) out.ssecurity = ssecurity
    if (passToken != null) out.passToken = passToken
    if (serviceToken != null) out.serviceToken = serviceToken
    return out
  }

  function deserializeAuth(obj: Record<string, unknown>): MijiaAuth | null {
    // 密钥字段必须是密文且可解密——缺一即视为未登录(不拿密文/半套凭证凑合)
    const dec = (v: unknown): string | null => (isSecretValue(v) ? decrypt(v) : null)
    const ssecurity = dec(obj.ssecurity)
    const passToken = dec(obj.passToken)
    const serviceToken = dec(obj.serviceToken)
    if (!ssecurity || !passToken || !serviceToken) return null
    const region = obj.region
    return {
      userId: typeof obj.userId === 'string' ? obj.userId : '',
      cUserId: typeof obj.cUserId === 'string' ? obj.cUserId : '',
      ssecurity,
      passToken,
      serviceToken,
      region: (MIJIA_REGIONS as readonly string[]).includes(String(region)) ? (region as MijiaRegion) : 'cn',
      deviceId: typeof obj.deviceId === 'string' && obj.deviceId ? obj.deviceId : '',
      updatedAt: typeof obj.updatedAt === 'number' ? obj.updatedAt : 0,
    }
  }

  function serializeDevice(d: MijiaDeviceRecord): Record<string, unknown> {
    const out: Record<string, unknown> = {
      did: d.did,
      model: d.model,
      name: d.name.slice(0, 80),
      isOnline: d.isOnline ?? false,
    }
    if (d.room) out.room = d.room.slice(0, 40)
    if (d.localip) out.localip = d.localip
    if (d.parentDid) out.parentDid = d.parentDid
    if (d.fwVersion) out.fwVersion = d.fwVersion.slice(0, 40)
    if (d.specType) out.specType = d.specType.slice(0, 120)
    if (d.token) {
      const enc = encrypt(d.token)
      if (enc != null) out.token = enc
      else secretPersistOk = false // token 缺席时 LAN 通道不可用,自动走云(可接受降级)
    }
    return out
  }

  function deserializeDevice(obj: Record<string, unknown>): MijiaDeviceRecord | null {
    if (typeof obj.did !== 'string' || !obj.did) return null
    if (typeof obj.model !== 'string' || typeof obj.name !== 'string') return null
    const rec: MijiaDeviceRecord = {
      did: obj.did,
      model: obj.model,
      name: obj.name.slice(0, 80),
      isOnline: obj.isOnline === true,
    }
    if (typeof obj.room === 'string') rec.room = obj.room.slice(0, 40)
    if (typeof obj.localip === 'string') rec.localip = obj.localip
    if (typeof obj.parentDid === 'string') rec.parentDid = obj.parentDid
    if (typeof obj.fwVersion === 'string') rec.fwVersion = obj.fwVersion.slice(0, 40)
    if (typeof obj.specType === 'string') rec.specType = obj.specType.slice(0, 120)
    if (isSecretValue(obj.token)) {
      const token = decrypt(obj.token)
      if (token) rec.token = token
    }
    return rec
  }

  return {
    async loadAuth(): Promise<MijiaAuth | null> {
      if (authCache !== undefined) return authCache
      try {
        const raw = await fs.readFile(authPath(), 'utf8')
        const obj = JSON.parse(raw) as Record<string, unknown>
        authCache = obj && typeof obj === 'object' ? deserializeAuth(obj) : null
      } catch {
        authCache = null
      }
      return authCache
    },

    async saveAuth(auth: MijiaAuth): Promise<void> {
      authCache = { ...auth, updatedAt: now() }
      secretPersistOk = true
      const payload = serializeAuth(authCache)
      authWriteChain = authWriteChain
        .then(async () => {
          try {
            await writeJson(authPath(), payload)
          } catch (e) {
            console.warn('[mijia] save auth failed:', (e as Error)?.message)
          }
        })
        .catch(() => {})
      await authWriteChain
    },

    async clearAuth(): Promise<void> {
      authCache = null
      authWriteChain = authWriteChain
        .then(async () => {
          try {
            await fs.rm(authPath(), { force: true })
          } catch {
            // 删除失败静默(下次 save 覆盖)
          }
        })
        .catch(() => {})
      await authWriteChain
    },

    async loadDevices(): Promise<MijiaDeviceRecord[]> {
      if (devicesLoaded && devicesCache) return devicesCache.slice()
      try {
        const raw = await fs.readFile(devicesPath(), 'utf8')
        const obj = JSON.parse(raw) as { devices?: unknown }
        const arr = Array.isArray(obj?.devices) ? obj.devices : []
        devicesCache = arr
          .map((d) => (d && typeof d === 'object' ? deserializeDevice(d as Record<string, unknown>) : null))
          .filter((d): d is MijiaDeviceRecord => d != null)
          .slice(0, MAX_DEVICES)
      } catch {
        devicesCache = []
      }
      devicesLoaded = true
      return devicesCache.slice()
    },

    async saveDevices(list: MijiaDeviceRecord[]): Promise<void> {
      devicesCache = list.slice(0, MAX_DEVICES)
      devicesLoaded = true
      secretPersistOk = true
      const payload = { mijiaSchemaVersion: 1, devices: devicesCache.map(serializeDevice) }
      devicesWriteChain = devicesWriteChain
        .then(async () => {
          try {
            await writeJson(devicesPath(), payload)
          } catch (e) {
            console.warn('[mijia] save devices failed:', (e as Error)?.message)
          }
        })
        .catch(() => {})
      await devicesWriteChain
    },

    resetMijiaStore(): void {
      authCache = undefined
      devicesCache = null
      devicesLoaded = false
    },

    didSecretPersist(): boolean {
      return secretPersistOk
    },
  }
}
