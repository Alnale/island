/**
 * 图标生成:
 * - 项目根目录存在 icon.png(用户指定的图标)→ 缩放到 256x256 输出
 * - 否则用 Electron 离屏渲染把 public/favicon.svg 栅格化
 * 输出:
 * - electron/icon.png(256x256,含透明通道,托盘/窗口/打包共用)
 * - electron/icon.ico(2026-08-13:多尺寸 16/24/32/48/64/128/256 的
 *   PNG-in-ICO,纯手写组装——供 rcedit 烙进自编译 electron.exe,
 *   修复"弹窗图标分辨率低 + 进程无(默认)图标")
 * 运行方式:pnpm exec electron scripts/make-icon.cjs
 */
const { app, BrowserWindow, nativeImage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const outDir = path.join(root, 'electron')
fs.mkdirSync(outDir, { recursive: true })

const userIcon = path.join(root, 'icon.png')

/** 组装 PNG-in-ICO(Vista+ 支持 PNG 压缩图标条目;无需 BMP 转换)。
 * ICONDIR(6B)+ ICONDIRENTRY×N(每项 16B)+ PNG 数据块。
 * 256 尺寸在条目里写 0(0 = 256 的 ICO 惯例) */
function assembleIco(pngs) {
  const count = pngs.length
  const header = Buffer.alloc(6 + count * 16)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type = icon
  header.writeUInt16LE(count, 4)
  let offset = header.length
  const blobs = []
  pngs.forEach((png, i) => {
    const e = 6 + i * 16
    header[e] = png.size >= 256 ? 0 : png.size // 宽(0 = 256)
    header[e + 1] = png.size >= 256 ? 0 : png.size // 高
    header[e + 2] = 0 // 调色板色数(32bpp 无)
    header[e + 3] = 0 // reserved
    header.writeUInt16LE(1, e + 4) // planes
    header.writeUInt16LE(32, e + 6) // bitCount
    header.writeUInt32LE(png.buffer.length, e + 8) // 数据大小
    header.writeUInt32LE(offset, e + 12) // 数据偏移
    offset += png.buffer.length
    blobs.push(png.buffer)
  })
  return Buffer.concat([header, ...blobs])
}

/** 生成多尺寸 PNG-in-ICO(2026-08-13,弹窗/进程图标分辨率修复) */
function writeIconIco(img) {
  const sizes = [16, 24, 32, 48, 64, 128, 256]
  const pngs = sizes.map((s) => ({
    size: s,
    buffer: img.resize({ width: s, height: s, quality: 'best' }).toPNG(),
  }))
  fs.writeFileSync(path.join(outDir, 'icon.ico'), assembleIco(pngs))
  console.log('[make-icon] wrote electron/icon.ico (16-256 multi-size)')
}

app.whenReady().then(async () => {
  // 用户指定图标优先(项目根 icon.png)
  if (fs.existsSync(userIcon)) {
    try {
      const img = nativeImage.createFromPath(userIcon)
      if (!img.isEmpty()) {
        const resized = img.getSize().width === 256 && img.getSize().height === 256
          ? img
          : img.resize({ width: 256, height: 256 })
        fs.writeFileSync(path.join(outDir, 'icon.png'), resized.toPNG())
        writeIconIco(img)
        console.log('[make-icon] used user icon (project root icon.png)')
        app.exit(0)
        return
      }
    } catch {
      // 用户图标读取失败,回退 SVG
    }
  }

  const svg = fs.readFileSync(path.join(root, 'public', 'favicon.svg'), 'utf8')
  const svgDataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`

  const win = new BrowserWindow({
    show: false,
    width: 256,
    height: 256,
    transparent: true,
    frame: false,
    webPreferences: { offscreen: true },
  })
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}</style></head><body><img src="${svgDataUrl}" width="256" height="256" style="display:block;width:256px;height:256px"></body></html>`
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  // 等 SVG 栅格化完成
  await new Promise((resolve) => setTimeout(resolve, 800))
  const image = await win.webContents.capturePage()
  fs.writeFileSync(path.join(outDir, 'icon.png'), image.toPNG())
  writeIconIco(image)
  console.log('[make-icon] wrote electron/icon.png (from favicon.svg)')
  app.exit(0)
})
