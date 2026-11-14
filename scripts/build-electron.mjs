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
import fs from 'node:fs'
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
// 2026-10-23 修复:图标是**可复用产物**,没必要每次 dev:widget 都起一个离屏
// Electron 去 capturePage——该步骤依赖 GPU/离屏合成,实测在受限环境或偶发
// 显卡状态下会以 0x80000003(STATUS_BREAKPOINT)崩掉,而 build-electron 把它
// 当致命错误 → 整个 pnpm dev:widget 退出码 2147483651,应用根本没机会启动。
// 现在:icon.png + icon.ico 都在 → 默认跳过(要改图标用 pnpm make:icon 或
// FORCE_ICON=1);生成失败但已有可用图标 → 告警并继续,不再阻断启动。
const iconPng = path.join(electronDir, 'icon.png')
const iconIco = path.join(electronDir, 'icon.ico')
const hasUsableIcon = () => {
  try {
    return fs.statSync(iconPng).size > 0 && fs.statSync(iconIco).size > 0
  } catch {
    return false
  }
}
if (process.env.FORCE_ICON !== '1' && hasUsableIcon()) {
  console.log('[build-electron] icon.png/icon.ico 已存在,跳过离屏渲染(设 FORCE_ICON=1 可强制重建)')
} else {
  // 以 node 运行 electron 的 cli.js(官方推荐方式,无需 shell/.cmd)
  const makeIcon = path.join(root, 'scripts', 'make-icon.cjs')
  const electronCli = path.join(root, 'node_modules', 'electron', 'cli.js')
  const result = spawnSync(process.execPath, [electronCli, makeIcon], {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      // 与 launch-dev-electron.mjs 同一原因:补丁 exe 必须从
      // C:\electron-hevc-dist 拉起,否则离屏渲染同样 0x80000003。
      ...(fs.existsSync('C:\\electron-hevc-dist\\electron.exe')
        ? { ELECTRON_OVERRIDE_DIST_PATH: 'C:\\electron-hevc-dist' }
        : {}),
    },
  })
  if (result.status !== 0) {
    const code = result.status ?? result.signal ?? 'unknown'
    if (hasUsableIcon()) {
      console.warn(`[build-electron] 图标生成失败(退出码 ${code}),沿用现有图标继续`)
    } else {
      console.error(`[build-electron] icon generation failed (exit ${code},无现有图标可沿用)`)
      process.exit(result.status ?? 1)
    }
  } else {
    console.log('[build-electron] icon.png done')
  }
}
