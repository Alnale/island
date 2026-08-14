/**
 * Electron 侧热重建(2026-08-06 架构优化):
 * 监听 electron/agent/*.ts 与 scripts/system-media-bridge.ts 变化 →
 * 自动重建 bridge.cjs / agent.cjs → 重启 electron(如已运行)。
 *
 * 用法:node scripts/watch-electron.mjs [--electron-args="..."]
 * (dev:widget 已前置 build:electron,本脚本解决"每次改引擎要手动重建"
 * 的痛点;渲染端仍用 pnpm dev:widget 的 vite 构建)
 */
import { watch } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const electronDir = path.join(root, 'electron')
const watchDirs = [path.join(electronDir, 'agent'), path.join(root, 'scripts')]

/** 重建 bridge.cjs + agent.cjs(与 build-electron.mjs 同款 esbuild 配置) */
async function rebuild() {
  const t0 = Date.now()
  await Promise.all([
    build({
      entryPoints: [path.join(root, 'scripts', 'system-media-bridge.ts')],
      outfile: path.join(electronDir, 'bridge.cjs'),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      logLevel: 'error',
    }),
    build({
      entryPoints: [path.join(electronDir, 'agent', 'engine', 'engine.ts')],
      outfile: path.join(electronDir, 'agent.cjs'),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      external: ['electron'],
      logLevel: 'error',
    }),
  ])
  console.log(`[watch-electron] rebuilt in ${Date.now() - t0}ms`)
}

let electronProc = null
function startElectron() {
  if (electronProc) {
    electronProc.kill()
    electronProc = null
  }
  // 以 node 运行 electron 的 cli.js(官方推荐方式,无需 shell/.cmd)
  electronProc = spawn(process.execPath, [path.join(root, 'node_modules', 'electron', 'cli.js'), '.'], {
    cwd: root,
    stdio: 'inherit',
  })
  console.log('[watch-electron] electron started')
}

let debounce = null
function scheduleRebuild() {
  clearTimeout(debounce)
  debounce = setTimeout(async () => {
    try {
      await rebuild()
      startElectron()
    } catch (err) {
      console.error('[watch-electron] rebuild failed:', err)
    }
  }, 300)
}

for (const dir of watchDirs) {
  watch(dir, { recursive: true }, (_event, file) => {
    if (!file?.endsWith('.ts')) return
    console.log(`[watch-electron] change: ${file}`)
    scheduleRebuild()
  })
}
console.log('[watch-electron] watching electron/agent + scripts/ (Ctrl+C 退出)')
await rebuild()
startElectron()
