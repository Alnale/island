/**
 * 图标生成:
 * - 项目根目录存在 icon.png(用户指定的图标)→ 缩放到 256x256 输出
 * - 否则用 Electron 离屏渲染把 public/favicon.svg 栅格化
 * 输出:electron/icon.png(256x256,含透明通道,托盘/窗口/打包共用)
 * 运行方式:pnpm exec electron scripts/make-icon.cjs
 */
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const outDir = path.join(root, 'electron')
fs.mkdirSync(outDir, { recursive: true })

const userIcon = path.join(root, 'icon.png')

app.whenReady().then(async () => {
  // 用户指定图标优先(项目根 icon.png)
  if (fs.existsSync(userIcon)) {
    try {
      const img = require('electron').nativeImage.createFromPath(userIcon)
      if (!img.isEmpty()) {
        const resized = img.getSize().width === 256 && img.getSize().height === 256
          ? img
          : img.resize({ width: 256, height: 256 })
        fs.writeFileSync(path.join(outDir, 'icon.png'), resized.toPNG())
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
  console.log('[make-icon] wrote electron/icon.png (from favicon.svg)')
  app.exit(0)
})
