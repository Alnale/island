/**
 * 灵动岛安装器独立打包 —— 产出可分发、双击即用的安装器 exe
 *
 * 产出 release/灵动岛安装器/(绿色自包含结构,发给别人无需 node_modules):
 *   灵动岛安装器.exe            ← 重命名自 electron.exe,双击启动安装向导
 *   resources/app/              ← 安装向导(installer/ 内容)
 *   resources/release/灵动岛/   ← 发布产物(安装器复制的源)
 *
 * main.cjs 中 releaseDir = path.join(__dirname, '..', 'release', '灵动岛'),
 * __dirname = resources/app → .. = resources → 恰好匹配 resources/release/灵动岛,
 * 开发(npx electron installer/main.cjs)与打包两种形态无需改动代码。
 *
 * 用法:node scripts/build-installer.mjs(需先运行 build-release.mjs)
 */
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const dist = path.join(root, 'node_modules', 'electron', 'dist')
const outDir = path.join(root, 'release', '灵动岛安装器')
const exeName = '灵动岛安装器.exe'

// 清理旧输出目录:个别文件被杀毒/索引临时锁定时跳过残留,不阻断打包
// (新文件随后覆盖;锁定释放后下次打包即干净)
async function rmOutDir() {
  try {
    await fsp.rm(outDir, { recursive: true, force: true })
    return
  } catch (e) {
    console.warn(`[installer] 清理旧目录部分文件被占用(可能为杀毒/索引扫描),跳过残留:${e.code || e.message}`)
  }
  if (fs.existsSync(outDir)) {
    const walk = async (dir) => {
      let ents
      try {
        ents = await fsp.readdir(dir, { withFileTypes: true })
      } catch { return /* 目录可能已被删/不存在,跳过 */ }
      for (const ent of ents) {
        const p = path.join(dir, ent.name)
        if (ent.isDirectory()) await walk(p)
        try { await fsp.unlink(p) } catch { /* 锁定,跳过 */ }
      }
      try { await fsp.rmdir(dir) } catch { /* 忽略 */ }
    }
    await walk(outDir)
  }
}

async function main() {
  if (!fs.existsSync(path.join(dist, 'electron.exe'))) {
    console.error('[installer] 缺少 node_modules/electron/dist/electron.exe,请先安装依赖')
    process.exit(1)
  }
  if (!fs.existsSync(path.join(root, 'release', '灵动岛', 'electron', 'electron.exe'))) {
    console.error('[installer] 缺少发布产物 release/灵动岛,请先运行: node scripts/build-release.mjs')
    process.exit(1)
  }

  console.log('[installer] ===== 灵动岛安装器独立打包 =====')
  await rmOutDir()
  await fsp.mkdir(outDir, { recursive: true })

  console.log('[installer] 复制 Electron 运行时…')
  // default_app.asar 若被杀毒/索引临时锁定(EBUSY),跳过覆盖沿用旧文件——
  // 其内容固定;安装器走 resources/app 应用,default_app.asar 非必需
  await fsp.cp(dist, outDir, {
    recursive: true,
    filter: (src) => !(src && path.basename(src) === 'default_app.asar'),
  })

  console.log('[installer] 装入安装向导(resources/app)…')
  await fsp.cp(path.join(root, 'installer'), path.join(outDir, 'resources', 'app'), { recursive: true })
  // 独立 exe 自动加载 resources/app 时依赖 package.json 的 main 字段定位入口
  await fsp.writeFile(
    path.join(outDir, 'resources', 'app', 'package.json'),
    JSON.stringify({ name: 'lingdong-island-installer', version: '3.1.0', description: '灵动岛 安装向导', main: 'main.cjs', private: true }, null, 2),
    'utf8',
  )

  // 独立卸载器:由 build-uninstaller.mjs 产出完整自包含目录(exe + resources/app
  // + locales + 运行时文件),整体复制进发行包根——卸载器是独立 Electron 应用,
  // 仅复制 exe 会导致缺少 resources/app(uninstall.html)而无法正常加载界面。
  // 之后复制发布目录时随之装入安装器,安装时再复制进安装目录,系统设置卸载
  // 入口指向它。
  const uninsDir = path.join(root, 'release', '灵动岛卸载器')
  const uninsExe = path.join(uninsDir, '灵动岛卸载器.exe')
  if (!fs.existsSync(uninsExe)) {
    console.error('[installer] 缺少独立卸载器,请先运行: node scripts/build-uninstaller.mjs')
    process.exit(1)
  }
  console.log('[installer] 装入独立卸载器(发行包根 完整目录)…')
  await fsp.cp(uninsDir, path.join(root, 'release', '灵动岛'), { recursive: true })

  console.log('[installer] 装入发布产物(resources/release/灵动岛)…')
  await fsp.cp(
    path.join(root, 'release', '灵动岛'),
    path.join(outDir, 'resources', 'release', '灵动岛'),
    { recursive: true },
  )
  // 列出已打包的外部工具(由 build-release --tools 决定;安装器按此呈现
  // 可选安装的工具,源码 + 编译 exe 已一并打入 release)
  const toolsDir = path.join(root, 'release', '灵动岛', 'electron', 'resources', 'tools')
  if (fs.existsSync(toolsDir)) {
    const names = (await fsp.readdir(toolsDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
    console.log(`[installer]   已打包外部工具:${names.length ? names.join('、') : '(无)'}(安装时可选)` )
  }

  console.log('[installer] 重命名入口 →', exeName)
  await fsp.rename(path.join(outDir, 'electron.exe'), path.join(outDir, exeName))

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
  await walk(outDir)

  console.log(`[installer] 完成 → ${outDir} (${(total / 1024 / 1024).toFixed(1)} MB)`)
  console.log('[installer] 将整个 release/灵动岛安装器 目录打包发给别人,双击「灵动岛安装器.exe」即可安装')
}

main().catch((e) => {
  console.error('[installer] 失败:', e)
  process.exit(1)
})
