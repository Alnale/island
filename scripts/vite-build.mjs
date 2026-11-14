/** Vite 构建使用项目内临时目录，避免 Windows esbuild 删除系统临时文件时被拒绝。 */
import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const tempDir = path.join(root, '.tmp', 'vite-build')
mkdirSync(tempDir, { recursive: true })

// 必须在启动 Vite/esbuild 前传入，使 JS 与原生子进程使用同一临时目录。
// 仅影响本次构建及其子进程，不修改用户的系统环境变量或文件权限。
const result = spawnSync(process.execPath, [
  path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'),
  'build',
  ...process.argv.slice(2),
], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true,
  env: { ...process.env, TEMP: tempDir, TMP: tempDir, TMPDIR: tempDir },
})

if (result.error) console.error('[vite-build]', result.error)
process.exit(result.status ?? 1)
