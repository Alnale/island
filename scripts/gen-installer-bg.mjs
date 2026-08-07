/**
 * 生成安装向导整窗背景图(2026-08-07 用户要求:安装界面背景 = 一张大
 * 自定义图片,而非框架式布局)。
 *
 * 读取项目根 bg.png(用户提供的 1536×1024 背景图)→ 缩放为 800×533
 * 24bit BMP → electron/installer-bg.bmp。NSIS 侧(见 nsis-custom.nsi
 * 的 IslandGUIInit)经 LoadImage 按窗口客户区尺寸拉伸铺满主对话框,
 * 所有向导页面共享同一整窗背景。
 *
 * 缩放:NSIS 侧会拉伸到客户区(~504×392,比例 1.28 vs 原图 1.5,
 * 轻微横向拉伸;渐变背景无感知),800×533 足够清晰(BMP ≈ 1.2MB,
 * 打进安装器压缩后更小)。
 *
 * 转换经 PowerShell System.Drawing(Windows 专用环境;PNG 解码 +
 * 缩放 + BMP 编码一步完成)。
 * 用法:node scripts/gen-installer-bg.mjs [输入png] [输出bmp]
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const input = path.resolve(process.argv[2] ?? path.join(root, 'bg.png'))
const output = path.resolve(process.argv[3] ?? path.join(root, 'electron', 'installer-bg.bmp'))

if (!fs.existsSync(input)) {
  console.error(`✗ 背景图不存在:${input}(默认读取项目根 bg.png)`)
  process.exit(1)
}

const W = 800
const H = 533
const ps = [
  'Add-Type -AssemblyName System.Drawing;',
  `$src=[System.Drawing.Image]::FromFile(${JSON.stringify(input)});`,
  `$bmp=New-Object System.Drawing.Bitmap ${W},${H};`,
  '$g=[System.Drawing.Graphics]::FromImage($bmp);',
  '$g.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic;',
  '$g.SmoothingMode=[System.Drawing.Drawing2D.SmoothingMode]::HighQuality;',
  `$g.DrawImage($src,0,0,${W},${H});`,
  `$bmp.Save(${JSON.stringify(output)},[System.Drawing.Imaging.ImageFormat]::Bmp);`,
  '$g.Dispose();$bmp.Dispose();$src.Dispose()',
].join('')
execFileSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'inherit' })
console.log(`✓ 安装向导背景图已生成:${output}(${W}×${H} 24bit BMP)`)
