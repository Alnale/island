/**
 * 灵动岛卸载器独立打包 —— 产出自包含、双击即用的卸载器 exe
 *
 * 产出 release/灵动岛卸载器/(与安装器同构的绿色自包含结构):
 *   灵动岛卸载器.exe          ← 重命名自 electron.exe,双击启动卸载向导
 *   resources/app/            ← 卸载向导(uninstaller/ 内容)
 *
 * 安装器(build-installer.mjs)会把这个 exe 放进发行包,安装时复制到
 * 安装目录根;系统设置卸载入口(UninstallString)与安装目录双击都指向它。
 *
 * 用法:node scripts/build-uninstaller.mjs(需先安装依赖)
 */
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const dist = path.join(root, 'node_modules', 'electron', 'dist')
const outDir = path.join(root, 'release', '灵动岛卸载器')
const exeName = '灵动岛卸载器.exe'

// 清理旧输出目录:个别文件被杀毒/索引临时锁定时跳过残留,不阻断打包
// (新文件随后覆盖;锁定释放后下次打包即干净)
async function rmOutDir() {
  try {
    await fsp.rm(outDir, { recursive: true, force: true })
    return
  } catch (e) {
    console.warn(`[uninstaller] 清理旧目录部分文件被占用(可能为杀毒/索引扫描),跳过残留:${e.code || e.message}`)
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
    console.error('[uninstaller] 缺少 node_modules/electron/dist/electron.exe,请先安装依赖')
    process.exit(1)
  }

  console.log('[uninstaller] ===== 灵动岛卸载器独立打包 =====')
  await rmOutDir()
  await fsp.mkdir(outDir, { recursive: true })

  console.log('[uninstaller] 复制 Electron 运行时…')
  // default_app.asar 若被杀毒/索引临时锁定(EBUSY),跳过覆盖沿用旧文件——
  // 其内容固定;卸载器走 resources/app 应用,default_app.asar 非必需
  await fsp.cp(dist, outDir, {
    recursive: true,
    filter: (src) => !(src && path.basename(src) === 'default_app.asar'),
  })

  console.log('[uninstaller] 装入卸载向导(resources/app)…')
  await fsp.cp(path.join(root, 'uninstaller'), path.join(outDir, 'resources', 'app'), { recursive: true })
  // 独立 exe 自动加载 resources/app 时依赖 package.json 的 main 字段定位入口
  await fsp.writeFile(
    path.join(outDir, 'resources', 'app', 'package.json'),
    JSON.stringify({ name: 'lingdong-island-uninstaller', version: '3.1.0', description: '灵动岛 卸载向导', main: 'main.cjs', private: true }, null, 2),
    'utf8',
  )

  console.log('[uninstaller] 重命名入口 →', exeName)
  await fsp.rename(path.join(outDir, 'electron.exe'), path.join(outDir, exeName))

  const sizeMB = await calcSize(outDir)
  console.log(`[uninstaller] 完成 → ${outDir} (${sizeMB} MB)`)
  console.log('[uninstaller] 该 exe 由安装器装入安装目录,系统设置卸载入口指向它')
}

async function calcSize(dir) {
  let sum = 0
  const walk = async (d) => {
    const entries = await fsp.readdir(d, { withFileTypes: true })
    for (const ent of entries) {
      const p = path.join(d, ent.name)
      if (ent.isDirectory()) await walk(p)
      else if (ent.isFile()) sum += (await fsp.stat(p)).size
    }
  }
  await walk(dir)
  return (sum / 1024 / 1024).toFixed(1)
}

main()
