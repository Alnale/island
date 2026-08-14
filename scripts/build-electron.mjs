/**
 * Electron 侧构建:
 * 1. esbuild 将 scripts/system-media-bridge.ts 打包为 CJS(electron/bridge.cjs),
 *    Electron 主进程以 utilityProcess 启动它;
 * 2. esbuild 将 electron/agent/engine/engine.ts 打包为 CJS(electron/agent.cjs),
 *    主进程直接 require 的 Agent 引擎(DeepSeek Responses provider +
 *    工具系统,零第三方依赖;'electron' 保持外部);
 * 3. 用 Electron 离屏渲染把 public/favicon.svg 转成 PNG 图标(electron/icon.png),
 *    供托盘/窗口/打包使用。
 *
 * 用法:node scripts/build-electron.mjs
 */
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const electronDir = path.join(root, 'electron')

// ---- 1. 打包桥接进程 -------------------------------------------------------
await build({
  entryPoints: [path.join(root, 'scripts', 'system-media-bridge.ts')],
  outfile: path.join(electronDir, 'bridge.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  // 桥接仅监听 127.0.0.1,无外部依赖
  sourcemap: false,
  logLevel: 'info',
})
console.log('[build-electron] bridge.cjs done')

// ---- 1.5 打包 Agent 引擎(主进程内运行,工具系统需 electron API) -----------
await build({
  entryPoints: [path.join(electronDir, 'agent', 'engine', 'engine.ts')],
  outfile: path.join(electronDir, 'agent.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
  sourcemap: false,
  logLevel: 'info',
})
console.log('[build-electron] agent.cjs done')

// ---- 2. 生成图标(SVG → PNG) ------------------------------------------------
// 以 node 运行 electron 的 cli.js(官方推荐方式,无需 shell/.cmd)
const makeIcon = path.join(root, 'scripts', 'make-icon.cjs')
const electronCli = path.join(root, 'node_modules', 'electron', 'cli.js')
const result = spawnSync(process.execPath, [electronCli, makeIcon], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
})
if (result.status !== 0) {
  console.error('[build-electron] icon generation failed')
  process.exit(result.status ?? 1)
}
console.log('[build-electron] icon.png done')
