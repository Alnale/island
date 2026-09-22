/**
 * 米家云「no permit」实探脚本(2026-09-22)
 *
 * 背景:mijia_devices 拉设备报 `code=-1:no permit`、缓存 0 台。本脚本
 * 用本机已扫码登录的凭证(mijia-auth.json,safeStorage 解密)实测:
 *   ① /v2/homeroom/gethome 原始字段(钉死 home 的 owner/id 真实字段名与类型);
 *   ② /v2/home/home_device_list 多组载荷变体(home_owner/home_id 类型、
 *      support_smart_home 取值、字段来源),哪组能通 = 根因。
 *
 * 运行:npx electron --disable-gpu tests/test-mijia-home-live.cjs
 * 结果双写 tests/mijia-home-live.log(stdout 管道缓冲可能吞输出,实测)。
 * 隐私:凭证字段(serviceToken/ssecurity/passToken/token)一律 *** 打码。
 */
const { app } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const LOG_FILE = path.join(__dirname, 'mijia-home-live.log')
fs.writeFileSync(LOG_FILE, '', 'utf8')
function log(...args) {
  const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
  fs.appendFileSync(LOG_FILE, line + '\n', 'utf8')
  console.log(line)
}

const SECRET_KEY = /token|security|pass/i
function redact(obj) {
  return JSON.parse(
    JSON.stringify(obj, (k, v) => (SECRET_KEY.test(k) && typeof v === 'string' && v.length > 4 ? '***' : v)),
  )
}

// safeStorage 与 userData 路径绑定(Electron 43 app-bound 熵)——必须 ready 前 setPath
app.setPath('userData', path.join(process.env.APPDATA || '', 'dynamic-island'))

app.whenReady().then(async () => {
  // ---- 0. 打包 mijia 模块(store 的 electron require 懒加载,external) ----
  try {
    require('esbuild').buildSync({
      stdin: {
        contents:
          "export * from './electron/agent/tools/mijia/mijia-store'\n" +
          "export * from './electron/agent/tools/mijia/mijia-cloud'",
        resolveDir: root,
        loader: 'ts',
        sourcefile: 'mijia-probe-entry.ts',
      },
      outfile: path.join(__dirname, '.mijia-probe-bundle.cjs'),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      external: ['electron'],
      logLevel: 'warning',
    })
  } catch (err) {
    log('[probe] 打包 mijia 模块失败:', err.message)
    process.exit(1)
  }
  const mod = require(path.join(__dirname, '.mijia-probe-bundle.cjs'))

  // ---- 1. 载入本机登录态 ----
  const store = mod.createMijiaStore()
  const auth = await store.loadAuth()
  if (!auth) {
    log('[probe] 未登录(mijia-auth.json 缺失或密钥不可解密)——先扫码登录再跑')
    process.exit(1)
  }
  log(`[probe] 已登录 userId=***${String(auth.userId).slice(-3)} region=${auth.region}`)
  const creds = {
    userId: auth.userId,
    cUserId: auth.cUserId,
    ssecurity: auth.ssecurity,
    serviceToken: auth.serviceToken,
    deviceId: auth.deviceId,
    region: auth.region,
  }
  const cloud = mod.createMijiaCloud()

  // ---- 2. gethome 原始字段(字段名/类型是 no permit 的第一嫌疑) ----
  log('\n===== ① /v2/homeroom/gethome 原始结构 =====')
  let homeResp
  try {
    homeResp = await cloud.call(creds, '/v2/homeroom/gethome', {
      fg: true,
      fetch_share: true,
      fetch_net: true,
      limit: 300,
    })
  } catch (err) {
    log('[probe] gethome 失败:', err.message)
    process.exit(1)
  }
  const homelist = homeResp?.result?.homelist ?? []
  const shareHome = homeResp?.result?.share_home ?? []
  log(`homelist ${homelist.length} 个 / share_home ${shareHome.length} 个`)
  for (const [i, h] of [...homelist, ...shareHome].slice(0, 3).entries()) {
    const label = i < homelist.length ? `homelist[${i}]` : `share_home[${i - homelist.length}]`
    const flat = {}
    for (const [k, v] of Object.entries(h ?? {})) {
      flat[k] = v !== null && typeof v === 'object' ? `${Array.isArray(v) ? 'array' : 'object'}(${Object.keys(v).join(',')})` : v
    }
    log(`${label} 字段:`, redact(flat))
  }
  // 我们 getHome 解析层的输出(对照字段名猜对没有)
  const parsedHomes = await cloud.getHome(creds)
  log('getHome 解析层输出:', redact(parsedHomes.map((h) => ({ id: h.id, owner: h.owner, name: h.name }))))

  // ---- 3. home_device_list 载荷变体 ----
  const home = homelist[0] ?? shareHome[0]
  if (!home) {
    log('[probe] 账号下无任何家庭条目——no permit 应属账号无家庭,非载荷问题')
    process.exit(0)
  }
  const rawId = home.id ?? home.home_id
  const rawOwner = home.owner ?? home.owner_uid ?? home.uid ?? home.user_id ?? home.owner_id ?? ''
  log(`\n===== ② /v2/home/home_device_list 载荷变体(用 home id=${rawId}) =====`)

  const variants = [
    ['A 现状(id/owner 都转 str + support_smart_home:true)', '/v2/home/home_device_list', {
      home_owner: String(rawOwner), home_id: String(rawId), limit: 200, get_split_device: true, support_smart_home: true,
    }],
    ['B 数字类型(home_owner/home_id 保持 JSON 原类型)', '/v2/home/home_device_list', {
      home_owner: typeof rawOwner === 'number' ? rawOwner : Number(rawOwner), home_id: typeof rawId === 'number' ? rawId : Number(rawId),
      limit: 200, get_split_device: true, support_smart_home: true,
    }],
    ['C support_smart_home:2', '/v2/home/home_device_list', {
      home_owner: String(rawOwner), home_id: String(rawId), limit: 200, get_split_device: true, support_smart_home: 2,
    }],
    ['D 数字 + support_smart_home:2', '/v2/home/home_device_list', {
      home_owner: typeof rawOwner === 'number' ? rawOwner : Number(rawOwner), home_id: typeof rawId === 'number' ? rawId : Number(rawId),
      limit: 200, get_split_device: true, support_smart_home: 2,
    }],
    ['E 最小载荷(数字,无开关)', '/v2/home/home_device_list', {
      home_owner: typeof rawOwner === 'number' ? rawOwner : Number(rawOwner), home_id: typeof rawId === 'number' ? rawId : Number(rawId),
      limit: 200,
    }],
    ['F home_owner=登录 userId(数字)', '/v2/home/home_device_list', {
      home_owner: Number(auth.userId), home_id: typeof rawId === 'number' ? rawId : Number(rawId),
      limit: 200, get_split_device: true, support_smart_home: true,
    }],
    ['G 旧端点 /v2/home/device_list', '/v2/home/device_list', { getVirtual: false, getHuamiDevices: 0 }],
    ['H 旧端点 空载荷', '/v2/home/device_list', {}],
  ]
  for (const [label, p, data] of variants) {
    try {
      const out = await cloud.call(creds, p, data)
      const arr = out?.result?.device_info ?? out?.result?.list ?? []
      log(`✓ ${label} → code=0,设备 ${Array.isArray(arr) ? arr.length : '?'} 台`)
      if (Array.isArray(arr) && arr[0]) {
        log(`  首台字段:`, redact(arr[0]))
        log('  → 胜出载荷 data =', JSON.stringify(data))
      }
    } catch (err) {
      log(`✗ ${label} → ${err.message}`)
    }
  }
  log('\n[probe] 完成')
  process.exit(0)
}).catch((err) => {
  log('[probe] 未捕获异常:', err?.stack || err?.message || String(err))
  process.exit(1)
})
