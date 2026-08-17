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
 * 用法:node scripts/build-release.mjs [--tools=bili,docflow]
 *   --tools 逗号分隔要打包的外部工具(缺省 = 全部 bili,docflow);
 *   每个工具目录整体复制 = **源码 + 编译的 exe 一并打包**(便于后续修改迭代)。
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const releaseDir = path.join(root, 'release', '灵动岛')

// 外部工具清单(缺省全部;--tools=bili,docflow 可只打包指定工具)
const ALL_TOOLS = ['bili', 'docflow']
const toolArg = process.argv.find((a) => a.startsWith('--tools='))
const TOOLS = toolArg
  ? toolArg
      .slice('--tools='.length)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  : ALL_TOOLS
for (const t of TOOLS) {
  if (!ALL_TOOLS.includes(t)) {
    console.error(`[release] 未知工具「${t}」,可选:${ALL_TOOLS.join('、')}`)
    process.exit(1)
  }
}

async function rmrf(p) {
  try {
    await fsp.rm(p, { recursive: true, force: true })
    return
  } catch (e) {
    // 个别文件被杀毒/索引/运行中的 Electron 实例锁定(EBUSY):逐文件删除,
    // 跳过锁定项,不中断打包——新文件随后覆盖,锁定释放后下次即干净
    if (e && e.code !== 'EBUSY') throw e
  }
  if (fs.existsSync(p)) {
    const walk = async (dir) => {
      let ents
      try {
        ents = await fsp.readdir(dir, { withFileTypes: true })
      } catch { return /* 目录可能已被删/不存在,跳过 */ }
      for (const ent of ents) {
        const q = path.join(dir, ent.name)
        if (ent.isDirectory()) await walk(q)
        try { await fsp.unlink(q) } catch { /* 锁定/占用,跳过 */ }
      }
      try { await fsp.rmdir(dir) } catch { /* 忽略 */ }
    }
    await walk(p)
  }
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
  // default_app.asar 非必需(应用加载同目录 resources/app),若被运行中的
  // 实例/杀毒锁定(EBUSY)跳过覆盖沿用旧文件,避免阻断打包
  await fsp.cp(electronDist, path.join(releaseDir, 'electron'), {
    recursive: true,
    filter: (src) => !(src && path.basename(src) === 'default_app.asar'),
  })

  // 2. 应用文件 → electron/resources/app
  const appDir = path.join(releaseDir, 'electron', 'resources', 'app')
  await fsp.mkdir(appDir, { recursive: true })

  console.log('[release] 复制主进程(electron/)…')
  await fsp.cp(path.join(root, 'electron'), path.join(appDir, 'electron'), { recursive: true })

  console.log('[release] 复制渲染端(dist-widget/)…')
  await fsp.cp(path.join(root, 'dist-widget'), path.join(appDir, 'dist-widget'), { recursive: true })

  console.log('[release] 复制 tests/screenshot-tests.cjs(main.cjs 顶层 require 的截图巡检)…')
  // 只复制主进程真正 require 的巡检文件,其余测试夹具(含示例 QQ/群号)不随发行,
  // 避免安装器携带任何个人身份信息
  if (fs.existsSync(path.join(root, 'tests', 'screenshot-tests.cjs'))) {
    await fsp.mkdir(path.join(appDir, 'tests'), { recursive: true })
    await fsp.copyFile(
      path.join(root, 'tests', 'screenshot-tests.cjs'),
      path.join(appDir, 'tests', 'screenshot-tests.cjs'),
    )
  }

  console.log(`[release] 复制外部工具(--tools=${TOOLS.join(',')} → electron/resources/tools)…`)
  // Agent 工具经 toolsRoot() 定位:打包后 process.resourcesPath/tools =
  // electron/resources/tools(bili-tool / docflow);整体复制 = 源码 +
  // 编译的 exe 一并打包。bili 排除 config/(本机登录态 cookies/store,
  // 含敏感凭据,不随发行)
  const toolsSrc = path.join(root, 'tools')
  if (fs.existsSync(toolsSrc)) {
    const toolsDst = path.join(releaseDir, 'electron', 'resources', 'tools')
    await fsp.mkdir(toolsDst, { recursive: true })
    for (const t of TOOLS) {
      const src = path.join(toolsSrc, t)
      if (!fs.existsSync(src)) {
        console.warn(`[release]   工具 ${t} 不存在(${src}),跳过`)
        continue
      }
      await fsp.cp(src, path.join(toolsDst, t), {
        recursive: true,
        filter: (s) => !(t === 'bili' && s.replace(/\\/g, '/').includes('/config')),
      })
      console.log(`[release]   ✓ ${t} → resources/tools/${t}`)
    }
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
