// QR 编码器对拍驱动(开发期验证,2026-09-22):
// 对每个样例 × 每个掩码,把 qr.ts 的矩阵与 python qrcode 的矩阵逐格比对。
// 运行: node tests/qr-crosscheck.mjs(python + qrcode 库需可用)
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// esbuild 打包 qr.ts → 临时 CJS(与 test-agent-core 同款方式)
require('esbuild').buildSync({
  entryPoints: [path.join(root, 'electron', 'agent', 'napcat', 'qr.ts')],
  outfile: path.join(root, 'tests', '.qr-bundle.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  logLevel: 'warning',
})
const { encodeQr } = require(path.join(root, 'tests', '.qr-bundle.cjs'))

const CASES = [
  'https://txz.qq.com/p?k=UloZ2aoikyaK4Z7CMpsoIpc4SuOmIEq3&f=1600001604',
  'https://txz.qq.com/p?k=ahq3mgJOLUkTym2UYSevKgl3jXtUSdZV&f=1600001604',
  'HELLO',
  'a',
  'https://example.com/' + 'x'.repeat(30),
  // 米家 loginUrl 实测 136 字节 → 版本 8(压版本信息块 + 多校正图形 + 非等长块)
  'https://account.xiaomi.com/longPolling/login/callback?ticket=ST-1234-abcd' + 'x'.repeat(65),
  // 200 字节 → 版本 10(16bit 计数指示器)
  'm'.repeat(200),
]

let fail = 0
for (const text of CASES) {
  for (let mask = 0; mask < 8; mask++) {
    const mine = encodeQr(text, { mask })
    const out = execFileSync('python', ['tests/qr-crosscheck.py'], {
      input: JSON.stringify({ text, mask }),
      encoding: 'utf8',
    })
    const ref = JSON.parse(out)
    let ok = mine.size === ref.size
    if (ok) {
      outer: for (let r = 0; r < mine.size; r++) {
        for (let c = 0; c < mine.size; c++) {
          const a = mine.modules[r][c] ? '1' : '0'
          if (a !== ref.rows[r][c]) {
            ok = false
            console.log(`✗ text=${text.slice(0, 30)} mask=${mask} 首个失配 @(${r},${c}) mine=${a} ref=${ref.rows[r][c]} size=${mine.size}/ref=${ref.size}`)
            break outer
          }
        }
      }
    } else {
      console.log(`✗ text=${text.slice(0, 30)} mask=${mask} 尺寸不符 mine=${mine.size} ref=${ref.size}`)
    }
    if (!ok) fail++
  }
}
console.log(fail === 0 ? '✓ 全部对拍通过' : `✗ ${fail} 组对拍失败`)
try {
  require('node:fs').unlinkSync(path.join(root, 'tests', '.qr-bundle.cjs'))
} catch {
  // 清理失败无妨(gitignore 已拦截)
}
process.exit(fail === 0 ? 0 : 1)
