/**
 * Agent 引擎核心功能测试 —— 打包并运行
 *
 * 1. esbuild 把 scripts/test-agent-core.ts 打包为 CJS(platform: node),
 *    'electron' 依赖别名替换为 stub(scripts/test-agent/stub-electron.cjs,
 *    Notification 记录到 global.__notifications 供断言);
 * 2. node 运行产物(真实 mock MCP stdio/sse 服务器,协议级验证)。
 *
 * 用法:node scripts/test-agent-core.mjs
 */
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const entry = path.join(root, 'scripts', 'test-agent-core.ts')
const outfile = path.join(root, 'node_modules', '.cache', 'test-agent-core.mjs')
fs.mkdirSync(path.dirname(outfile), { recursive: true })

/** electron → stub(测试环境无真实 Electron 主进程) */
const electronStub = path.join(root, 'scripts', 'test-agent', 'stub-electron.cjs')
const aliasPlugin = {
  name: 'alias-electron',
  setup(build) {
    build.onResolve({ filter: /^electron$/ }, () => ({ path: electronStub }))
  },
}

// ESM 输出(测试源码用顶层 await;node 24 直接运行 .mjs)
await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  plugins: [aliasPlugin],
  define: { __ROOT__: JSON.stringify(root) },
  logLevel: 'warning',
})

const result = spawnSync(process.execPath, [outfile], { stdio: 'inherit', env: process.env })
process.exit(result.status ?? 1)
