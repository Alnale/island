/**
 * 灵动岛发布打包脚本 —— 产出可安装的绿色版发布目录
 *
 * 产出 release/灵动岛/(供 installer/main.cjs 安装):
 *   electron/                  ← 复制 node_modules/electron/dist(electron.exe + dll + resources)
 *     resources/app/           ← 主应用文件(应用加载同目录 resources/app)
 *       electron/              ← 主进程(electron/ 目录整体)
 *       dist-widget/           ← 渲染端构建产物(vite --mode widget)
 *       tests/                 ← main.cjs 顶层 require 的截图巡检
 *       package.json
 *
 * 安装后快捷方式指向 <安装目录>/electron/electron.exe;
 * electron.exe 启动时自动加载同目录 resources/app = 主应用。
 *
 * 用法:node scripts/build-release.mjs
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const releaseDir = path.join(root, 'release', '灵动岛')

async function rmrf(p) {
  await fsp.rm(p, { recursive: true, force: true })
}

async function ensureWidgetBuild() {
  const html = path.join(root, 'dist-widget', 'widget', 'widget.html')
  if (fs.existsSync(html)) {
    console.log('[release] dist-widget 已存在,跳过构建')
    return
  }
  console.log('[release] 构建渲染端(vite --mode widget)…')
  const r = spawnSync('npx', ['vite', 'build', '--mode', 'widget', '--config', 'vite.widget.config.ts'], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  })
  if (r.status !== 0) {
    console.error('[release] dist-widget 构建失败')
    process.exit(r.status ?? 1)
  }
}

async function ensureElectronBin() {
  const dist = path.join(root, 'node_modules', 'electron', 'dist')
  if (!fs.existsSync(path.join(dist, 'electron.exe'))) {
    console.error('[release] 未找到 node_modules/electron/dist/electron.exe,请先安装依赖')
    process.exit(1)
  }
  return dist
}

async function main() {
  console.log('[release] ===== 灵动岛发布打包 =====')
  await rmrf(releaseDir)
  await fsp.mkdir(releaseDir, { recursive: true })

  await ensureWidgetBuild()
  const electronDist = await ensureElectronBin()

  // 1. electron 运行时
  console.log('[release] 复制 electron 运行时…')
  await fsp.cp(electronDist, path.join(releaseDir, 'electron'), { recursive: true })

  // 2. 应用文件 → electron/resources/app
  const appDir = path.join(releaseDir, 'electron', 'resources', 'app')
  await fsp.mkdir(appDir, { recursive: true })

  console.log('[release] 复制主进程(electron/)…')
  await fsp.cp(path.join(root, 'electron'), path.join(appDir, 'electron'), { recursive: true })

  console.log('[release] 复制渲染端(dist-widget/)…')
  await fsp.cp(path.join(root, 'dist-widget'), path.join(appDir, 'dist-widget'), { recursive: true })

  console.log('[release] 复制 tests/(main.cjs 顶层 require)…')
  if (fs.existsSync(path.join(root, 'tests'))) {
    await fsp.cp(path.join(root, 'tests'), path.join(appDir, 'tests'), { recursive: true })
  }

  await fsp.copyFile(path.join(root, 'package.json'), path.join(appDir, 'package.json'))

  // 3. 校验
  const exe = path.join(releaseDir, 'electron', 'electron.exe')
  const appMain = path.join(appDir, 'electron', 'main.cjs')
  if (!fs.existsSync(exe) || !fs.existsSync(appMain)) {
    console.error('[release] 校验失败:electron.exe 或 app main.cjs 缺失')
    process.exit(1)
  }

  // 统计体积
  let total = 0
  const walk = async (dir) => {
    const ents = await fsp.readdir(dir, { withFileTypes: true })
    for (const e of ents) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) await walk(p)
      else if (e.isFile()) total += (await fsp.stat(p)).size
    }
  }
  await walk(releaseDir)

  console.log(`[release] 完成 → ${releaseDir} (${(total / 1024 / 1024).toFixed(1)} MB)`)
  console.log('[release] 现在可运行: npx electron installer/main.cjs 打开安装向导')
}

main().catch((e) => {
  console.error('[release] 失败:', e)
  process.exit(1)
})
