// Chromium src 浅镜像预填脚本(2026-08-11):git init --bare + 循环 fetch 续传。
// 用 --depth 1 浅 fetch 单个 tag(electron v43.2.0 的 chromium 150.0.7871.129):
// 只含该 commit 的树+blob(~15G),无 40G 完整历史——全量镜像 + 构建产物
// 会爆磁盘(实测 38G 全量镜像后磁盘仅剩 40G)。gclient 只 checkout 固定
// revision 的工作树,不需要历史。
// fetch 是增量续传,断线后同一目录继续拉缺失对象。
// 源用 GitHub 官方镜像(github.com/chromium/chromium,与 googlesource 同步;
// 国内网络下 googlesource 直连/经代理均不通,GitHub 可达)。
// 镜像目录名 = gclient 对 googlesource URL 的 UrlToCacheDir 命名,
// gclient 只按目录名找缓存,不校验镜像内容来源。
// 用法:node scripts/prefetch-chromium-mirror.mjs
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs'

const CACHE = 'C:\\electron-gn\\git-cache'
const MIRROR = 'chromium.googlesource.com-chromium-src' // git_cache.UrlToCacheDir 规则
const MIRROR_PATH = `${CACHE}\\${MIRROR}`
const URL = 'https://github.com/chromium/chromium.git' // GitHub 官方镜像
const TAG = '150.0.7871.129' // electron v43.2.0 的 chromium 版本(DEPS)
const LOG = 'C:\\electron-gn\\mirror.log'
const proxy = 'http://127.0.0.1:7897'
const env = {
  ...process.env,
  https_proxy: proxy,
  http_proxy: proxy,
  GIT_CACHE_PATH: CACHE,
}
const log = (m) => {
  appendFileSync(LOG, `[${new Date().toISOString()}] ${m}\n`)
  console.log(m)
}

mkdirSync(CACHE, { recursive: true })
log(`mirror path: ${MIRROR_PATH}`)

const started = Date.now()
// 首次:init --bare + remote add(幂等;后续循环只 fetch)
if (!existsSync(MIRROR_PATH)) {
  log('initializing bare repo')
  let r = spawnSync('git', ['init', '--bare', MIRROR_PATH], {
    cwd: CACHE,
    env,
    stdio: 'inherit',
    timeout: 60 * 1000,
  })
  if (r.status !== 0) {
    log('git init failed')
    process.exit(1)
  }
  r = spawnSync(
    'git',
    ['remote', 'add', 'origin', URL],
    { cwd: MIRROR_PATH, env, stdio: 'inherit', timeout: 60 * 1000 }
  )
  if (r.status !== 0) {
    log('git remote add failed')
    process.exit(1)
  }
}

for (let i = 1; i <= 100; i++) {
  const startedOnce = Date.now()
  log(`attempt ${i}: git fetch shallow tag ${TAG} (incremental resume)`)
  // 浅 fetch 指定 tag:--depth 1 只拉该 commit 的树+blob;增量续传,失败保留进度
  const r = spawnSync(
    'git',
    [
      'fetch', '--depth', '1', '--progress', 'origin',
      `refs/tags/${TAG}:refs/tags/${TAG}`,
    ],
    {
      cwd: MIRROR_PATH,
      env,
      stdio: 'inherit',
      timeout: 60 * 60 * 1000,
    }
  )
  const mins = ((Date.now() - startedOnce) / 60000).toFixed(1)
  if (r.status === 0) {
    log(`attempt ${i} OK (${mins} min)`)
    break
  }
  log(`attempt ${i} failed (${r.status ?? 'killed'}) after ${mins} min, sleeping 5s`)
  await new Promise((res) => setTimeout(res, 5000))
}

const total = ((Date.now() - started) / 60000).toFixed(1)
if (existsSync(MIRROR_PATH)) {
  // 校验 tag 存在,并让 HEAD 可解析(gclient clone --shared 需要)
  const ok = spawnSync(
    'git', ['rev-parse', `refs/tags/${TAG}^{commit}`],
    { cwd: MIRROR_PATH, env, stdio: 'pipe' }
  )
  if (ok.status !== 0) {
    log(`FAILED: tag ${TAG} not fetched after ${total} min`)
    process.exit(1)
  }
  const hash = ok.stdout.toString().trim()
  spawnSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/master'], { cwd: MIRROR_PATH, env })
  spawnSync('git', ['update-ref', 'refs/heads/master', hash], { cwd: MIRROR_PATH, env })
  writeFileSync(`${MIRROR_PATH}\\.mirror_init`, '') // INIT_SENTIENT_FILE
  log(`DONE after ${total} min. tag=${TAG} hash=${hash} ready marker written. size:`)
  spawnSync('du', ['-sh', MIRROR_PATH], { stdio: 'inherit' })
  process.exit(0)
}
log('FAILED: mirror dir not created')
process.exit(1)
