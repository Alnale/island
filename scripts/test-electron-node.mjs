/** 运行时基线：确保 Electron 自带的 Node 满足 Agent/MCP 支持版本。 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const electron = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const run = spawnSync(electron, ['-p', 'process.versions.node'], {
  encoding: 'utf8',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
})
if (run.status !== 0) throw new Error(run.stderr || '无法启动 Electron Node')
const version = run.stdout.trim()
const major = Number(version.split('.')[0])
if (!Number.isInteger(major) || major < 22) throw new Error(`Electron Node 版本过低:${version}，需要 >= 22`)
console.log(`Electron Node runtime: ${version}`)
