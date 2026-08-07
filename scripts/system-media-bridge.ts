/**
 * System Media Bridge (TypeScript)
 *
 * Listens to Windows SMTC sessions (QQMusic / NetEase CloudMusic / KuGou /
 * KuWo / SodaMusic desktop clients) via a resident PowerShell reader
 * subprocess, and serves their playback state over a local HTTP endpoint
 * for the Dynamic Island front-end.
 *
 * SMTC (WinRT) is only reachable from PowerShell/C#, so the TS process
 * spawns scripts/smtc-reader.ps1 once and talks to it over stdin/stdout
 * (line-based JSON protocol) - the reader stays resident, no per-request
 * process spawn overhead.
 *
 * Usage: node scripts/system-media-bridge.ts   (Node 22+ runs TS directly)
 *   GET  http://127.0.0.1:8765/system-media/state   -> playback state JSON
 *   POST http://127.0.0.1:8765/system-media/control -> {action, position?}
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join } from 'node:path'

const PORT = 8765
/**
 * SMTC 读取脚本路径:默认 scripts/ 目录(直接运行时 cwd 为项目根);
 * Electron 挂件打包后通过 SMTC_READER_PATH 指向 resources 下的实际文件
 * (asar 内文件无法被 powershell 打开,必须解包到外部)
 */
const READER_SCRIPT = process.env.SMTC_READER_PATH ?? join(process.cwd(), 'scripts', 'smtc-reader.ps1')
/** 单条 PS 指令响应超时(ms) */
const PS_TIMEOUT_MS = 8000

// ---------------------------------------------------------------------------
// Lyrics lookup (NetEase API proxy) - no CORS restrictions server-side
// ---------------------------------------------------------------------------

interface LyricLine {
  time: number
  text: string
}

/** LRC 歌词解析:[mm:ss.xx] 行 → 按时间排序 */
function parseLrc(lrc: string): LyricLine[] {
  const out: LyricLine[] = []
  for (const line of lrc.split('\n')) {
    const m = line.match(/\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\](.*)/)
    if (m) {
      const min = Number(m[1])
      const sec = Number(m[2])
      const frac = Number(m[3] ?? '0')
      const text = (m[4] ?? '').trim()
      if (text) out.push({ time: min * 60 + sec + frac / 1000, text })
    }
  }
  return out.sort((a, b) => a.time - b.time)
}

/** 歌词缓存:key = title|artist,5 分钟过期 */
const lyricCache = new Map<string, { at: number; data: LyricResult | null }>()
const LYRIC_CACHE_MS = 5 * 60 * 1000
/** 歌词缓存容量上限:超出时淘汰最早存入的条目(常驻进程长期运行防无界增长) */
const LYRIC_CACHE_MAX = 100

interface LyricResult {
  title: string
  artist: string
  lines: LyricLine[]
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'

/** 歌词查询入口:按 provider 分发(默认 QQ音乐)。
 * 酷我/酷狗搜索可用但歌词接口不稳定(酷我 m.kuwo.cn 已封闭)→ 搜索走
 * 本厂商(匹配准),歌词拉取失败时 **fallback 到 QQ 歌词兜底**(保证有歌词)
 */
async function lookupLyric(
  title: string,
  artist: string,
  provider = 'qq',
  customUrl = '',
): Promise<LyricResult | null> {
  // 缓存 key 含 provider:切换厂商后重新查询
  const key = `${provider}|${title}|${artist}`
  const hit = lyricCache.get(key)
  if (hit && Date.now() - hit.at < LYRIC_CACHE_MS) return hit.data
  let result: LyricResult | null = null
  switch (provider) {
    case 'qq':
      result = await lookupQqLyricRemote(title, artist)
      break
    case 'netease':
      result = await lookupNeteaseLyricRemote(title, artist)
      break
    case 'kugou':
      result = (await lookupKugouLyricRemote(title, artist)) ?? (await lookupQqLyricRemote(title, artist))
      break
    case 'kuwo':
      result = (await lookupKuwoLyricRemote(title, artist)) ?? (await lookupQqLyricRemote(title, artist))
      break
    case 'custom':
      result = customUrl ? await lookupCustomLyricRemote(title, artist, customUrl) : null
      break
    default:
      result = await lookupQqLyricRemote(title, artist)
  }
  lyricCache.set(key, { at: Date.now(), data: result })
  if (lyricCache.size > LYRIC_CACHE_MAX) {
    // Map 保持插入顺序,淘汰最早存入的条目(重复命中的条目位置不变)
    const oldestKey = lyricCache.keys().next().value
    if (oldestKey !== undefined) lyricCache.delete(oldestKey)
  }
  return result
}

/**
 * 搜索结果最佳匹配:标题精确/包含/前缀 + 歌手比对加权评分。
 * 无脑取第一条在歌名短(如"爱")/带副标题/歌手信息不完整时会对不上
 * (实测:QQ 音乐监听时歌词完全错)——搜索多条后按相似度选最佳
 */
interface SearchHit {
  name: string
  artists: string[]
  /** 歌词拉取所需标识(网易云 id / QQ songmid) */
  key: string
}

function pickBestHit(list: SearchHit[], title: string, artist: string): SearchHit | null {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, '')
  const t = norm(title)
  const a = norm(artist)
  let best: SearchHit | null = null
  let bestScore = -1
  for (const hit of list) {
    const st = norm(hit.name)
    const sa = norm(hit.artists.join('/'))
    let score = 0
    // 标题:精确 > 一方包含另一方 > 前缀(至少前 2 字)
    if (st === t) score += 100
    else if (st.includes(t) || t.includes(st)) score += 60
    else if (st.startsWith(t.slice(0, 2)) || t.startsWith(st.slice(0, 2))) score += 20
    // 歌手:互相包含加分(artist 缺失时纯标题匹配)
    if (a && sa && (sa.includes(a) || a.includes(sa))) score += 30
    if (score > bestScore) {
      bestScore = score
      best = hit
    }
  }
  return best ?? null
}

/** 网易云搜索 + 歌词:歌名/歌手 → LRC 行(多条搜索 + 相似度选最佳) */
async function lookupNeteaseLyricRemote(
  title: string,
  artist: string,
): Promise<LyricResult | null> {
  try {
    const q = encodeURIComponent(`${title} ${artist}`)
    const search = await fetch(
      `https://music.163.com/api/search/get/web?s=${q}&type=1&limit=10`,
      { headers: { 'User-Agent': UA, Referer: 'https://music.163.com' } },
    )
    const searchJson = (await search.json()) as {
      result?: { songs?: Array<{ id: number; name: string; artists?: Array<{ name: string }> }> }
    }
    const song = pickBestHit(
      (searchJson.result?.songs ?? []).map((s) => ({
        name: s.name,
        artists: s.artists?.map((a) => a.name) ?? [],
        key: String(s.id),
      })),
      title,
      artist,
    )
    if (!song) return null
    const lyric = await fetch(
      `https://music.163.com/api/song/lyric?id=${song.key}&lv=1&kv=1&tv=-1`,
      { headers: { 'User-Agent': UA, Referer: 'https://music.163.com' } },
    )
    const lyricJson = (await lyric.json()) as { lrc?: { lyric?: string } }
    const lrc = lyricJson.lrc?.lyric
    if (!lrc) return null
    const lines = parseLrc(lrc)
    if (lines.length === 0) return null
    return {
      title: song.name,
      artist: song.artists.join('/') || artist,
      lines,
    }
  } catch {
    return null
  }
}

/** QQ音乐搜索 + 歌词(歌词字段为 base64 编码的 LRC,需解码;
 *  多条搜索 + 相似度选最佳——监听 QQ 音乐时歌词对不上是首条匹配错) */
async function lookupQqLyricRemote(
  title: string,
  artist: string,
): Promise<LyricResult | null> {
  try {
    const q = encodeURIComponent(`${title} ${artist}`)
    const search = await fetch(
      `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?p=1&n=10&w=${q}&format=json&cr=1&t=0`,
      { headers: { 'User-Agent': UA, Referer: 'https://y.qq.com' } },
    )
    const searchJson = (await search.json()) as {
      data?: { song?: { list?: Array<{ songmid: string; songname: string; singer?: Array<{ name: string }> }> } }
    }
    const song = pickBestHit(
      (searchJson.data?.song?.list ?? []).map((s) => ({
        name: s.songname,
        artists: s.singer?.map((x) => x.name) ?? [],
        key: s.songmid,
      })),
      title,
      artist,
    )
    if (!song) return null
    const lyric = await fetch(
      `https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=${song.key}&format=json`,
      { headers: { 'User-Agent': UA, Referer: 'https://y.qq.com' } },
    )
    const lyricJson = (await lyric.json()) as { lyric?: string }
    const b64 = lyricJson?.lyric
    if (!b64) return null
    const lrc = Buffer.from(b64, 'base64').toString('utf8')
    const lines = parseLrc(lrc)
    if (lines.length === 0) return null
    return {
      title: song.name,
      artist: song.artists.join('/') || artist,
      lines,
    }
  } catch {
    return null
  }
}

/** 酷狗音乐搜索 + 歌词(songsearch_v2 + krc.php,返回明文 LRC) */
async function lookupKugouLyricRemote(
  title: string,
  artist: string,
): Promise<LyricResult | null> {
  try {
    const q = encodeURIComponent(`${title} ${artist}`)
    const search = await fetch(
      `https://songsearch.kugou.com/song_search_v2?keyword=${q}&page=1&pagesize=10&platform=WebFilter`,
      { headers: { 'User-Agent': UA, Referer: 'https://www.kugou.com/' } },
    )
    const sj = (await search.json()) as {
      data?: { lists?: Array<{ SongName: string; SingerName: string; FileHash: string }> }
    }
    const hit = pickBestHit(
      (sj?.data?.lists ?? []).map((s) => ({
        name: s.SongName,
        artists: [s.SingerName],
        key: s.FileHash,
      })),
      title,
      artist,
    )
    if (!hit?.key) return null
    const r2 = await fetch(
      `https://m.kugou.com/app/i/krc.php?cmd=100&hash=${hit.key}&timelength=100000`,
      { headers: { 'User-Agent': UA, Referer: 'https://m.kugou.com/' } },
    )
    const lrc = await r2.text()
    const lines = parseLrc(lrc)
    if (lines.length === 0) return null
    return { title: hit.name, artist: hit.artists.join('/') || artist, lines }
  } catch {
    return null
  }
}

/** 酷我音乐搜索 + 歌词(search.kuwo.cn 返回**单引号非标准 JSON**,宽松替换后
 * 解析;歌词接口 m.kuwo.cn 已封闭 → 返回 null 由上层 fallback 到 QQ) */
async function lookupKuwoLyricRemote(
  title: string,
  artist: string,
): Promise<LyricResult | null> {
  try {
    const q = encodeURIComponent(`${title} ${artist}`)
    const search = await fetch(
      `https://search.kuwo.cn/r.s?all=${q}&ft=music&itemset=web_2013&client=kt&pn=0&rn=20&encoding=utf8&rformat=json`,
      { headers: { 'User-Agent': UA, Referer: 'https://www.kuwo.cn/' } },
    )
    const text = await search.text()
    // 酷我响应是单引号 JSON(字段值一般不含引号字符),替换后标准解析
    const obj = JSON.parse(text.replace(/'/g, '"')) as {
      abslist?: Array<{ NAME: string; ARTIST: string; MUSICRID: string }>
    }
    const hit = pickBestHit(
      (obj.abslist ?? []).map((s) => ({
        name: s.NAME,
        artists: [s.ARTIST],
        key: String(s.MUSICRID ?? ''),
      })),
      title,
      artist,
    )
    if (!hit?.key) return null
    // 歌词接口:尝试 m.kuwo.cn(可能封闭 404);失败返回 null → fallback QQ
    const rid = hit.key.replace('MUSIC_', '')
    const r2 = await fetch(`https://m.kuwo.cn/newh5/singles/songinfo?musicId=${rid}`, {
      headers: { 'User-Agent': UA, Referer: 'https://www.kuwo.cn/' },
    })
    const lj = (await r2.json()) as { htmlLyric?: string }
    // htmlLyric 是 <p>…</p> 包裹的 LRC:段落换行 + 剥离标签
    const lrc = (lj?.htmlLyric ?? '').replace(/<\/p>|<\/div>/g, '\n').replace(/<[^>]+>/g, '').trim()
    const lines = parseLrc(lrc)
    if (lines.length === 0) return null
    return { title: hit.name, artist: hit.artists.join('/') || artist, lines }
  } catch {
    return null
  }
}

/** 自定义歌词 API:URL 模板替换 {title}/{artist} → LRC 文本或 {"lrc": "…"} JSON */
async function lookupCustomLyricRemote(
  title: string,
  artist: string,
  urlTemplate: string,
): Promise<LyricResult | null> {
  try {
    const url = urlTemplate
      .replace('{title}', encodeURIComponent(title))
      .replace('{artist}', encodeURIComponent(artist ?? ''))
    const res = await fetch(url, { headers: { 'User-Agent': UA } })
    if (!res.ok) return null
    const text = await res.text()
    let lrc = text
    try {
      const json = JSON.parse(text) as { lrc?: string; lyric?: string }
      if (typeof json.lrc === 'string') lrc = json.lrc
      else if (typeof json.lyric === 'string') lrc = json.lyric
    } catch {
      // 纯文本 LRC
    }
    const lines = parseLrc(lrc)
    if (lines.length === 0) return null
    return { title, artist, lines }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Resident PowerShell reader subprocess
// ---------------------------------------------------------------------------

let ps: ChildProcessWithoutNullStreams
let psBuffer = ''
/** 等待响应的回调队列(FIFO) */
const pending: Array<{ resolve: (line: string) => void; timer: NodeJS.Timeout }> = []
// smtc-reader 重启上限:10 秒内连续退出达到 3 次则放弃(脚本缺失/环境
// 不可用),避免每 2s 无限 respawn 刷日志;窗口滑动重置(与主进程对桥的
// 重启策略同款——主进程的 3 次上限只管桥进程本身,管不到桥内部循环)
const READER_RESTART_WINDOW_MS = 10_000
const READER_MAX_RESTARTS = 3
let readerRestartCount = 0
let readerFirstCrashAt = 0
let readerRespawnScheduled = false

function scheduleReaderRespawn(): void {
  // error 与 exit 可能双发,防重复调度
  if (readerRespawnScheduled) return
  readerRespawnScheduled = true
  const now = Date.now()
  if (now - readerFirstCrashAt > READER_RESTART_WINDOW_MS) {
    readerFirstCrashAt = now
    readerRestartCount = 0
  }
  readerRestartCount += 1
  if (readerRestartCount > READER_MAX_RESTARTS) {
    console.error('[smtc-reader] respawn limit reached, giving up (restart the widget to retry)')
    readerRespawnScheduled = false
    return
  }
  setTimeout(() => {
    readerRespawnScheduled = false
    spawnReader()
  }, 2000)
}

function spawnReader(): void {
  ps = spawn(
    'powershell',
    // -Mta:PS 5.1 默认 STA,WinRT async 在 STA 控制台下等待存在死锁风险
    ['-Mta', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', READER_SCRIPT],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
  )
  psBuffer = ''
  ps.stdout.setEncoding('utf8')
  ps.stdout.on('data', (chunk: string) => {
    psBuffer += chunk
    let idx: number
    // PS Write-Output 每条命令一行 JSON
    while ((idx = psBuffer.indexOf('\n')) >= 0) {
      const line = psBuffer.slice(0, idx).replace(/\r$/, '').trim()
      psBuffer = psBuffer.slice(idx + 1)
      if (!line) continue
      const waiter = pending.shift()
      if (waiter) {
        clearTimeout(waiter.timer)
        waiter.resolve(line)
      }
    }
  })
  ps.stderr.on('data', (chunk: Buffer) => {
    console.error('[smtc-reader]', chunk.toString().trim())
  })
  // 脚本缺失等启动失败:spawn 只发 error 不发 exit——不处理会"桥活着但
  // SMTC 永久死"(请求 8s 超时),按崩溃走同一重启判定
  ps.on('error', (err) => {
    console.error('[smtc-reader] spawn failed:', err.message)
    scheduleReaderRespawn()
  })
  ps.on('exit', (code) => {
    console.error(`[smtc-reader] exited with code ${code}, respawning...`)
    // 排队中的请求全部失败
    while (pending.length > 0) {
      const waiter = pending.shift()!
      clearTimeout(waiter.timer)
      waiter.resolve('{"error":"reader exited"}')
    }
    scheduleReaderRespawn()
  })
  // 管道写入错误兜底(审计 P2-6):崩溃重启间隙的 write 触发 EPIPE 等,
  // 吞掉避免未捕获异常杀死桥进程(重启流程自会处理;requestPS 写前也已
  // 判进程存活)
  ps.stdin.on('error', () => {})
}

/** 向 PS reader 发指令并等待一行 JSON 响应 */
function requestPS(command: string): Promise<string> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const idx = pending.findIndex((p) => p.resolve === onLine)
      if (idx >= 0) pending.splice(idx, 1)
      resolve('{"error":"timeout"}')
    }, PS_TIMEOUT_MS)
    const onLine = (line: string) => resolve(line)
    pending.push({ resolve: onLine, timer })
    // 审计 P2-6:reader 崩溃后 2s 重启间隙收到 HTTP 请求 → 向已关闭管道
    // write 触发无监听的 error 事件,桥进程被未捕获异常杀死(可达 3 次
    // 重启上限后 SMTC 永久失联)——写前判进程存活 + 注册 error 兜底
    if (ps.stdin.destroyed || ps.exitCode !== null || ps.signalCode !== null) {
      const idx = pending.findIndex((p) => p.resolve === onLine)
      if (idx >= 0) pending.splice(idx, 1)
      clearTimeout(timer)
      resolve('{"error":"reader not ready"}')
      return
    }
    ps.stdin.write(`${command}\n`)
  })
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  })
  res.end(data)
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (c: Buffer) => (data += c.toString('utf8')))
    req.on('end', () => resolve(data))
  })
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    })
    res.end()
    return
  }
  try {
    if (url.pathname === '/system-media/state') {
      const line = await requestPS('state')
      let state: unknown
      try {
        state = JSON.parse(line)
      } catch {
        state = { error: 'bad reader response' }
      }
      sendJson(res, 200, state)
      return
    }
    if (url.pathname === '/system-media/control' && req.method === 'POST') {
      let body: { action?: string; position?: number } = {}
      try {
        body = JSON.parse(await readBody(req)) as typeof body
      } catch {
        // ignore malformed body
      }
      const action = body.action ?? ''
      const SIMPLE_ACTIONS = [
        'previous',
        'play',
        'pause',
        'next',
        'repeat-one',
        'repeat-all',
        'shuffle',
        'shuffle-off',
      ]
      let line = '{"ok":true}'
      if (action === 'seek' && typeof body.position === 'number') {
        line = await requestPS(`control seek ${body.position}`)
      } else if (SIMPLE_ACTIONS.includes(action)) {
        line = await requestPS(`control ${action}`)
      }
      let parsed: unknown = { ok: true }
      try {
        parsed = JSON.parse(line)
      } catch {
        // keep default
      }
      sendJson(res, 200, parsed)
      return
    }
    if (url.pathname === '/system-media/lyric') {
      // 歌词代理:按当前曲目(或查询参数)查歌词。
      // provider = 网易云(默认)/ qq / custom(custom 带 url 模板,
      // {title}/{artist} 占位替换)——多厂商可切换,缓存按 provider 隔离
      const qTitle = url.searchParams.get('title')
      const qArtist = url.searchParams.get('artist')
      const qProvider = url.searchParams.get('provider') ?? 'netease'
      const qCustomUrl = url.searchParams.get('url') ?? ''
      let title = qTitle ?? ''
      let artist = qArtist ?? ''
      if (!title) {
        const line = await requestPS('state')
        try {
          const st = JSON.parse(line) as { track?: { title?: string; artist?: string } }
          title = st.track?.title ?? ''
          artist = st.track?.artist ?? ''
        } catch {
          // ignore
        }
      }
      if (!title) {
        sendJson(res, 404, { error: 'no track' })
        return
      }
      const lyric = await lookupLyric(title, artist, qProvider, qCustomUrl)
      if (!lyric) {
        sendJson(res, 404, { error: 'lyric not found' })
        return
      }
      sendJson(res, 200, lyric)
      return
    }
    sendJson(res, 404, { error: 'not found' })
  } catch (err) {
    console.error('[bridge] request error:', err)
    sendJson(res, 500, { error: String(err) })
  }
})

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    // 端口已被占用(已有桥接实例在跑):这是正常状态,干净退出(退出码 0,
    // 宿主(如 Electron 挂件)不会因此重启桥接)
    console.error(`[bridge] port ${PORT} already in use, another bridge instance is running`)
    process.exit(0)
  }
  console.error('[bridge] server error:', err)
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`System media bridge (TS) started: http://127.0.0.1:${PORT}/system-media/state`)
  console.log('Press Ctrl+C to stop.')
})

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

function shutdown(): void {
  try {
    ps.stdin.write('quit\n')
  } catch {
    // already gone
  }
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 500).unref()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

spawnReader()
