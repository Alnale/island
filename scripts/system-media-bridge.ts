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

interface LyricResult {
  title: string
  artist: string
  lines: LyricLine[]
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'

/** 网易云搜索 + 歌词:歌名/歌手 → LRC 行 */
async function lookupLyric(title: string, artist: string): Promise<LyricResult | null> {
  const key = `${title}|${artist}`
  const hit = lyricCache.get(key)
  if (hit && Date.now() - hit.at < LYRIC_CACHE_MS) return hit.data
  const result = await lookupLyricRemote(title, artist)
  lyricCache.set(key, { at: Date.now(), data: result })
  return result
}

async function lookupLyricRemote(
  title: string,
  artist: string,
): Promise<LyricResult | null> {
  try {
    const q = encodeURIComponent(`${title} ${artist}`)
    const search = await fetch(
      `https://music.163.com/api/search/get/web?s=${q}&type=1&limit=3`,
      { headers: { 'User-Agent': UA, Referer: 'https://music.163.com' } },
    )
    const searchJson = (await search.json()) as {
      result?: { songs?: Array<{ id: number; name: string; artists?: Array<{ name: string }> }> }
    }
    const song = searchJson.result?.songs?.[0]
    if (!song) return null
    const lyric = await fetch(
      `https://music.163.com/api/song/lyric?id=${song.id}&lv=1&kv=1&tv=-1`,
      { headers: { 'User-Agent': UA, Referer: 'https://music.163.com' } },
    )
    const lyricJson = (await lyric.json()) as { lrc?: { lyric?: string } }
    const lrc = lyricJson.lrc?.lyric
    if (!lrc) return null
    const lines = parseLrc(lrc)
    if (lines.length === 0) return null
    return {
      title: song.name,
      artist: song.artists?.map((a) => a.name).join('/') ?? artist,
      lines,
    }
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
  ps.on('exit', (code) => {
    console.error(`[smtc-reader] exited with code ${code}, respawning...`)
    // 排队中的请求全部失败
    while (pending.length > 0) {
      const waiter = pending.shift()!
      clearTimeout(waiter.timer)
      waiter.resolve('{"error":"reader exited"}')
    }
    setTimeout(spawnReader, 2000)
  })
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
      // 歌词代理:按当前曲目(或查询参数)自动查网易云歌词
      const qTitle = url.searchParams.get('title')
      const qArtist = url.searchParams.get('artist')
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
      const lyric = await lookupLyric(title, artist)
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
