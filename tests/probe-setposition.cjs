/** 复现 drag-move setPosition "conversion failure":逐一试探哪种实参会抛 */
const { app, BrowserWindow } = require('electron')

app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 200, height: 200, show: false })
  const tryIt = (label, fn) => {
    try {
      fn()
      console.log('OK  ', label)
    } catch (e) {
      console.log('FAIL', label, '->', e && e.message)
    }
  }
  tryIt('setPosition(-174, 0)', () => win.setPosition(-174, 0))
  tryIt('setPosition(-174, -0)', () => win.setPosition(-174, -0))
  tryIt('setPosition(-0, -0)', () => win.setPosition(-0, -0))
  tryIt('setPosition(10, -0)', () => win.setPosition(10, -0))
  tryIt('setPosition(-174, 58.666)', () => win.setPosition(-174, 58.666))
  tryIt('setPosition(-174.5, 0)', () => win.setPosition(-174.5, 0))
  tryIt('setPosition(-174, NaN)', () => win.setPosition(-174, NaN))
  tryIt('setPosition(-174, undefined)', () => win.setPosition(-174, undefined))
  tryIt('setBounds x=-174,y=-0', () => win.setBounds({ x: -174, y: -0, width: 200, height: 200 }))
  win.destroy()
  tryIt('destroyed setPosition(-174, 0)', () => win.setPosition(-174, 0))
  tryIt('destroyed setPosition(-174, -0)', () => win.setPosition(-174, -0))
  setTimeout(() => app.quit(), 100)
})
