/**
 * 真实 LLM 集成测试 —— 打包并运行
 * 同 test-agent-core.mjs:esbuild 打包(electron 别名 stub),node 运行。
 * API 配置读用户 settings.json(真实 Key),数据写隔离临时目录。
 * 用法:node tests/test-agent-live.mjs
 */
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const entry = path.join(root, 'tests', 'test-agent-live.ts')
const outfile = path.join(root, 'node_modules', '.cache', 'test-agent-live.mjs')
fs.mkdirSync(path.dirname(outfile), { recursive: true })

const electronStub = path.join(root, 'tests', 'mocks', 'stub-electron.cjs')
const aliasPlugin = {
  name: 'alias-electron',
  setup(build) {
    build.onResolve({ filter: /^electron$/ }, () => ({ path: electronStub }))
  },
}

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  plugins: [aliasPlugin],
  logLevel: 'warning',
})

const result = spawnSync(process.execPath, [outfile], { stdio: 'inherit', env: process.env, timeout: 600000 })
process.exit(result.status ?? 1)
