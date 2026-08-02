/**
 * 从 electron/icon.png 生成多尺寸标准 ICO(electron/icon.ico)。
 * 绕开 electron-builder 的 png→ico 转换缓存(该缓存对图标内容变化
 * 偶发不失效,导致 exe 嵌入旧图标)。
 * ICO 帧直接嵌入 PNG(Windows Vista+ 支持),尺寸 16/32/48/64/128/256。
 * 运行:node scripts/make-ico.cjs
 */
const { execSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const root = path.join(__dirname, '..')
const src = path.join(root, 'electron', 'icon.png')
const out = path.join(root, 'electron', 'icon.ico')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'icon-frames-'))

const sizes = [16, 32, 48, 64, 128, 256]

const ps1 = path.join(tmp, 'resize.ps1')
for (const s of sizes) {
  const frame = path.join(tmp, `frame-${s}.png`)
  // 脚本含中文路径,必须带 UTF-8 BOM(PS 5.1 无 BOM 按 GBK 解码会乱码)
  fs.writeFileSync(
    ps1,
    '﻿' +
      `Add-Type -AssemblyName System.Drawing\n` +
      `$src = [System.Drawing.Bitmap]::FromFile('${src}')\n` +
      `$bmp = New-Object System.Drawing.Bitmap($src, ${s}, ${s})\n` +
      `$bmp.Save('${frame}', [System.Drawing.Imaging.ImageFormat]::Png)\n` +
      `$bmp.Dispose(); $src.Dispose()\n`,
  )
  execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${ps1}"`, { stdio: 'pipe' })
}

// 拼 ICO:header(6) + 目录项(16×N) + PNG 帧
const frames = sizes.map((s) => fs.readFileSync(path.join(tmp, `frame-${s}.png`)))
const header = Buffer.alloc(6)
header.writeUInt16LE(1, 2) // type = icon
header.writeUInt16LE(frames.length, 4)
const entries = []
let offset = 6 + frames.length * 16
frames.forEach((png, i) => {
  const s = sizes[i]
  const e = Buffer.alloc(16)
  e.writeUInt8(s >= 256 ? 0 : s, 0) // width(0 = 256)
  e.writeUInt8(s >= 256 ? 0 : s, 1) // height
  e.writeUInt8(0, 2) // palette
  e.writeUInt8(0, 3) // reserved
  e.writeUInt16LE(1, 4) // planes
  e.writeUInt16LE(32, 6) // bitcount
  e.writeUInt32LE(png.length, 8)
  e.writeUInt32LE(offset, 12)
  offset += png.length
  entries.push(e)
})
fs.writeFileSync(out, Buffer.concat([header, ...entries, ...frames]))

console.log(`[make-ico] wrote ${out} (${fs.statSync(out).size} bytes)`)
