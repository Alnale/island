/**
 * 灵动岛安装管理器打包 —— 安装 / 卸载合一的单 exe 发行包
 *
 * 产出 release/灵动岛安装管理器/(绿色自包含结构,发给别人无需 node_modules):
 *   灵动岛安装管理器.exe        ← WinForms 安装器(manager/Installer.cs)
 *   resources/release/灵动岛/   ← 主应用发布产物(安装时复制的源)
 *
 * 安装器本身不带 Electron。仓库目录里的 Electron 会在窗口出现前以 0x80000003 退出。
 * 安装时只把这个 exe 复制到 <安装目录>/uninstaller,卸载不依赖主应用。
 *
 * 用法:node scripts/build-manager.mjs(需先运行 build-release.mjs)
 */
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const outDir = path.join(root, 'release', '灵动岛安装管理器')
const exeName = '灵动岛安装管理器.exe'

// 清理旧输出目录:个别文件被杀毒/索引临时锁定时跳过残留,不阻断打包
// (新文件随后覆盖;锁定释放后下次打包即干净)
async function rmOutDir() {
  try {
    await fsp.rm(outDir, { recursive: true, force: true })
    return
  } catch (e) {
    console.warn(`[manager] 清理旧目录部分文件被占用(可能为杀毒/索引扫描),跳过残留:${e.code || e.message}`)
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
  if (!fs.existsSync(path.join(root, 'release', '灵动岛', 'electron', 'electron.exe'))) {
    console.error('[manager] 缺少发布产物 release/灵动岛,请先运行: node scripts/build-release.mjs')
    process.exit(1)
  }

  console.log('[manager] ===== 灵动岛安装管理器打包 =====')
  await rmOutDir()
  await fsp.mkdir(outDir, { recursive: true })

  console.log('[manager] 装入发布产物(resources/release/灵动岛)…')
  const releaseSource = path.join(root, 'release', '灵动岛')
  await fsp.cp(
    releaseSource,
    path.join(outDir, 'resources', 'release', '灵动岛'),
    {
      recursive: true,
      // 兼容旧发布目录:拒绝把旧版安装器写回的卸载器与 Electron *.official
      // 备份带入新包。正常 release 构建本身不会产生它们。
      filter: (src) => {
        const name = path.basename(src)
        const rel = path.relative(releaseSource, src).replace(/\\/g, '/')
        return !name.endsWith('.official') && rel !== '灵动岛卸载器.exe' && rel !== `uninstaller/${exeName}`
      },
    },
  )
  // 列出已打包的外部工具(由 build-release --tools 决定;安装时可选装)
  const toolsDir = path.join(releaseSource, 'electron', 'resources', 'tools')
  if (fs.existsSync(toolsDir)) {
    const names = (await fsp.readdir(toolsDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
    console.log(`[manager]   已打包外部工具:${names.length ? names.join('、') : '(无)'}(安装时可选)`)
  }

  console.log('[manager] 编译安装器 →', exeName)
  const csc = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
  if (!fs.existsSync(csc)) {
    console.error('[manager] 缺少 csc.exe,无法编译安装器')
    process.exit(1)
  }
  const icon = path.join(root, 'electron', 'icon.ico')
  const cscArgs = [
    '/nologo',
    '/target:winexe',
    '/optimize+',
    '/codepage:65001',
    '/utf8output',
    '/reference:System.Windows.Forms.dll',
    '/reference:System.Drawing.dll',
    `/out:${path.join(outDir, exeName)}`,
    path.join(root, 'manager', 'Installer.cs'),
  ]
  if (fs.existsSync(icon)) cscArgs.splice(5, 0, `/win32icon:${icon}`)
  const compiled = spawnSync(csc, cscArgs, { encoding: 'utf8' })
  if (compiled.status !== 0) {
    console.error(compiled.stdout || '')
    console.error(compiled.stderr || '')
    console.error('[manager] 安装器编译失败')
    process.exit(compiled.status || 1)
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
  await walk(outDir)

  console.log(`[manager] 完成 → ${outDir} (${(total / 1024 / 1024).toFixed(1)} MB)`)
  console.log('[manager] 将整个 release/灵动岛安装管理器 目录打包发给别人,双击「灵动岛安装管理器.exe」即可安装/卸载')
}

main().catch((e) => {
  console.error('[manager] 失败:', e)
  process.exit(1)
})
