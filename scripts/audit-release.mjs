/**
 * 发布物审计：默认只报告，--strict 时把规格超限视为失败。
 * 用法：node scripts/audit-release.mjs [--dir=release/灵动岛] [--strict]
 */
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs/promises'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const argDir = process.argv.find((arg) => arg.startsWith('--dir='))
const target = path.resolve(root, argDir ? argDir.slice('--dir='.length) : path.join('release', '灵动岛'))
const strict = process.argv.includes('--strict')
const MAX_RELEASE_BYTES = 450 * 1024 * 1024
const sensitiveName = /^(settings\.json(?:\.(?:bak|tmp))?|privacy\.json|session-log(?:\.\d+)?\.jsonl)$/i

async function walk(dir, result = []) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) await walk(full, result)
    else if (entry.isFile()) result.push({ full, size: (await fs.stat(full)).size })
  }
  return result
}

try {
  await fs.access(target)
} catch {
  throw new Error(`发布目录不存在:${target}`)
}

const files = await walk(target)
const totalBytes = files.reduce((sum, file) => sum + file.size, 0)
const runtimeExecutables = files.filter((file) => /^electron\.exe$/i.test(path.basename(file.full)))
const sensitiveFiles = files.filter((file) => sensitiveName.test(path.basename(file.full)))
const report = {
  target,
  totalMB: Number((totalBytes / 1024 / 1024).toFixed(1)),
  runtimeExecutables: runtimeExecutables.map((file) => path.relative(target, file.full)),
  sensitiveFiles: sensitiveFiles.map((file) => path.relative(target, file.full)),
  limits: { maxMB: MAX_RELEASE_BYTES / 1024 / 1024, maxRuntimeExecutables: 1 },
}
console.log(JSON.stringify(report, null, 2))

const violations = []
if (totalBytes > MAX_RELEASE_BYTES) violations.push(`体积 ${report.totalMB}MB 超过 ${report.limits.maxMB}MB`)
if (runtimeExecutables.length > 1) violations.push(`发现 ${runtimeExecutables.length} 套 Electron 运行时`)
if (sensitiveFiles.length > 0) violations.push(`发布物包含用户数据:${report.sensitiveFiles.join(', ')}`)
if (strict && violations.length > 0) throw new Error(`发布审计失败:\n- ${violations.join('\n- ')}`)
if (violations.length > 0) console.warn(`[release-audit] 警告:\n- ${violations.join('\n- ')}`)
