// 编码支持探针(临时诊断,2026-08-11):最小 Electron 入口,
// 渲染进程内查 mediaCapabilities.decodingInfo 对比 HEVC/AV1/H264/VP9。
// 用法:electron scripts/probe-codecs.cjs
const { app, BrowserWindow } = require('electron')

// 与 main.cjs 保持一致:透明窗口禁用硬件加速
app.disableHardwareAcceleration()

// 命令行透传的 --enable-features 由 Chromium 消费;这里再显式补一条,
// 保证无论入口如何都带上(实验用)
if (process.env.PROBE_FEATURES) {
  app.commandLine.appendSwitch('enable-features', process.env.PROBE_FEATURES)
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true },
  })
  await win.loadURL(
    'data:text/html,<html><body><video id="v"></video></body></html>'
  )
  const res = await win.webContents.executeJavaScript(`(async () => {
    const probe = async (codec) => {
      try {
        const info = await navigator.mediaCapabilities.decodingInfo({
          type: 'file',
          video: { contentType: codec, width: 1920, height: 1080, bitrate: 5000000, framerate: 30 },
        })
        return { codec, supported: info.supported, smooth: info.smooth, powerEfficient: info.powerEfficient }
      } catch (e) { return { codec, error: String(e) } }
    }
    return JSON.stringify({
      hev1: await probe('video/mp4; codecs="hev1.1.6.L93.B0"'),
      hvc1: await probe('video/mp4; codecs="hvc1.1.6.L93.B0"'),
      av1: await probe('video/mp4; codecs="av01.0.04M.08"'),
      h264: await probe('video/mp4; codecs="avc1.42E01E"'),
      vp9: await probe('video/webm; codecs="vp09.00.10.08"'),
    })
  })()`)
  console.log('PROBE:', res)
  app.quit()
})
