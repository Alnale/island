/**
 * 截图/巡检测试模式(WIDGET_SCREENSHOT env)——从 main.cjs 抽出
 * (2026-08-06 架构优化:原内嵌 ~1160 行,占主进程一半以上)。
 * 仅当设置了 WIDGET_SCREENSHOT 时经 deps 注入调用,不参与正常运行路径。
 * 依赖全部注入(win / app / fs / path / settingsPath / runIslandSettings),
 * 保持 main.cjs 与测试代码零耦合。
 */

function runScreenshotTests({ win, app, fs, path, settingsPath, runIslandSettings, resetSettingsCache, runProactiveGuess, startProactiveTurn, getLastProactiveTick, requestEvolution }) {
    // 巡检起点时刻(完成日志总耗时用)
    if (global.__screenshotT0 === undefined) global.__screenshotT0 = Date.now()
    // 终端进程监控(2026-08-08 用户报告"巡检约 40 秒弹新终端"):
    // 每 2s 快照**带窗口标题**的 conhost/cmd/powershell/pwsh(弹窗的
    // 终端必有 MainWindowTitle),记录新增进程与相对时刻;巡检结束输出。
    // 监控自身(powershell -Command)用 windowsHide 无窗口,不误报
    const { execFileSync } = require('node:child_process')
    const startTermWatch = () => {
      const seen = new Set()
      const events = []
      const startedAt = Date.now()
      let snapshots = 0
      const snapshot = () => {
        try {
          const out = execFileSync(
            'powershell',
            [
              '-NoProfile',
              '-Command',
              "Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle } | Select-Object Id,ProcessName,MainWindowTitle | ConvertTo-Json -Compress",
            ],
            { encoding: 'utf8', windowsHide: true, timeout: 5000 },
          )
          snapshots++
          const list = JSON.parse(out.trim() || '[]')
          const rows = Array.isArray(list) ? list : [list]
          for (const r of rows) {
            const key = String(r.Id)
            if (!seen.has(key)) {
              seen.add(key)
              events.push({
                atSec: Math.round((Date.now() - startedAt) / 100) / 10,
                pid: key,
                name: r.ProcessName,
                title: String(r.MainWindowTitle || '').slice(0, 60),
              })
            }
          }
        } catch {
          // 快照失败忽略
        }
      }
      const timer = setInterval(snapshot, 2000)
      snapshot()
      return {
        stop: () => {
          clearInterval(timer)
          return { events, snapshots }
        },
      }
    }
    const termWatch = startTermWatch()

    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        console.log('[widget] screenshot mode:', process.env.WIDGET_SCREENSHOT_MODE, 'shot:', process.env.WIDGET_SCREENSHOT)
        try {
          if (process.env.WIDGET_SCREENSHOT_MODE === 'expanded' || process.env.WIDGET_SCREENSHOT_MODE === 'layout') {
            await win.webContents.executeJavaScript(`(async () => {
              const island = document.querySelector('.island-demo')
              if (!island) return 'no island'
              const r = island.getBoundingClientRect()
              const x = r.left + r.width / 2
              const y = r.top + r.height / 2
              const down = new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y, pointerId: 1, isPrimary: true, button: 0 })
              const up = new PointerEvent('pointerup', { bubbles: true, clientX: x, clientY: y, pointerId: 1, isPrimary: true, button: 0 })
              island.dispatchEvent(down)
              await new Promise((res) => setTimeout(res, 600))
              island.dispatchEvent(up)
              await new Promise((res) => setTimeout(res, 800))
              return 'expanded=' + island.classList.contains('expanded')
            })()`)
          }
          if (process.env.WIDGET_SCREENSHOT_MODE === 'layout') {
            // 布局诊断:输出展开面板各区域的位置
            const layout = await win.webContents.executeJavaScript(`(() => {
              const q = (sel) => {
                const el = document.querySelector(sel)
                if (!el) return null
                const r = el.getBoundingClientRect()
                return { top: Math.round(r.top), height: Math.round(r.height), bottom: Math.round(r.bottom) }
              }
              return JSON.stringify({
                panel: q('.island-panel'),
                head: q('.island-panel-head'),
                lyric: q('.island-panel-lyric-inline'),
                progressRow: q('.island-panel-progress-row'),
                controls: q('.island-panel-controls'),
                island: q('.island-demo'),
              })
            })()`)
            console.log('[widget] layout:', layout)
          }
          if (process.env.WIDGET_SCREENSHOT_MODE === 'theme') {
            // 展开 + 打开取色面板(视觉验证)
            await win.webContents.executeJavaScript(`(async () => {
              const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
              const island = document.querySelector('.island-demo')
              const r = island.getBoundingClientRect()
              const x = r.left + r.width / 2
              const y = r.top + r.height / 2
              island.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y, pointerId: 1, isPrimary: true, button: 0 }))
              setTimeout(() => island.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x, clientY: y, pointerId: 1, isPrimary: true, button: 0 })), 600)
              await sleep(1100)
              document.querySelector('.island-ctl--theme')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(500)
              return 'theme view open: ' + !!document.querySelector('.island-panel-theme')
            })()`)
          }
          if (process.env.WIDGET_SCREENSHOT_MODE === 'stress') {
            // 压力测试:10 轮 展开→操作→收起,采样动画帧间隔,检测卡死/卡顿
            const result = await win.webContents.executeJavaScript(`(async () => {
              const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
              const out = { rounds: [] }
              const island = document.querySelector('.island-demo')
              const r = island.getBoundingClientRect()
              const x = r.left + r.width / 2
              const y = r.top + r.height / 2
              const pressIsland = () => {
                island.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y, pointerId: 1, isPrimary: true, button: 0 }))
                setTimeout(() => island.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x, clientY: y, pointerId: 1, isPrimary: true, button: 0 })), 600)
              }
              // 采样 RAF 间隔(动画流畅度)
              const sampleFps = (ms) => new Promise((res) => {
                const gaps = []
                let last = performance.now()
                const tick = (now) => {
                  gaps.push(now - last)
                  last = now
                  if (performance.now() - start < ms) requestAnimationFrame(tick)
                  else res(Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length))
                }
                const start = performance.now()
                requestAnimationFrame(tick)
              })
              let slowFrames = 0
              for (let i = 0; i < 10; i++) {
                const t0 = performance.now()
                pressIsland()
                await sleep(1000)
                const mid = await sampleFps(600)
                // 展开中点模式按钮
                document.querySelector('.island-ctl--mode')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
                await sleep(200)
                // 点面板外收起
                document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 60, pointerId: 2, isPrimary: true, button: 0 }))
                await sleep(900)
                const collapsed = !island.classList.contains('expanded')
                const dt = Math.round(performance.now() - t0)
                if (mid > 80) slowFrames++
                out.rounds.push({ i, collapsed, avgFrameMs: mid, roundMs: dt })
                await sleep(200)
              }
              out.slowFrames = slowFrames
              out.rendererAlive = true
              return JSON.stringify(out)
            })()`)
            console.log('[widget] stress:', result)
          }
          if (process.env.WIDGET_SCREENSHOT_MODE === 'test') {
            // 综合交互测试(全视图巡检):长按展开 → 托盘设置 → 主题色(应用/恢复)
            // → 字体 → 字体库 → 背景 → 帮助 → 逐级返回收起(设置类视图只能经返回键退出)
            const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
            const expanded = await win.webContents.executeJavaScript(`(async () => {
              const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
              const island = document.querySelector('.island-demo')
              const r = island.getBoundingClientRect()
              const x = r.left + r.width / 2
              const y = r.top + r.height / 2
              island.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y, pointerId: 1, isPrimary: true, button: 0 }))
              setTimeout(() => island.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x, clientY: y, pointerId: 1, isPrimary: true, button: 0 })), 600)
              await sleep(1100)
              return island.classList.contains('expanded')
            })()`)
            console.log('[widget] test expanded:', expanded)
            // 歌词开关提示:默认已开,先关再开,播放键下方显示来源提示
            const lyricHint = await win.webContents.executeJavaScript(`(async () => {
              const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
              const btn = document.querySelector('.island-ctl--lyric')
              if (!btn) return false
              btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(150)
              btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(150)
              const hintEl = document.querySelector('.island-hint-play')
              return !!hintEl && hintEl.textContent.includes('网易云')
            })()`)
            console.log('[widget] test lyricHint:', lyricHint)
            // 托盘"设置"入口:展开并切换到设置视图(渲染端 requestSettingsSeq)
            win.webContents.send('widget:open-settings')
            await sleep(600)
            const result = await win.webContents.executeJavaScript(`(async () => {
              const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
              const out = {}
              const island = document.querySelector('.island-demo')
              const settingsItem = (text) =>
                [...document.querySelectorAll('.island-settings-item')].find((s) => s.textContent.includes(text))
              // 1. 设置视图
              out.settingsShown = !!document.querySelector('.island-settings-items')
              // 2. 主题色视图:取色器渲染 + 应用/恢复
              settingsItem('主题色').dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(400)
              out.pickerShown = !!document.querySelector('.island-theme-view .island-font-sv')
              const swatch = [...document.querySelectorAll('.island-theme-swatch')].find((s) => s.title === '#f87171')
              swatch.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(400)
              out.themeApplied = island.style.getPropertyValue('--state-color') === '#f87171'
              document.querySelector('.island-theme-swatch--follow').dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(400)
              out.themeReset = island.style.getPropertyValue('--state-color') !== '#f87171'
              document.querySelector('.island-theme-view .island-bg-back').dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(400)
              out.backToSettings = !!document.querySelector('.island-settings-items')
              // 3. 字体视图 → 字体库 → 返回
              settingsItem('字体').dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(400)
              out.fontShown = !!document.querySelector('.island-font-view')
              const libBtn = [...document.querySelectorAll('.island-font-actions .island-ctl')].find((s) => s.textContent.includes('字体库'))
              libBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(400)
              out.fontLibraryShown = !!document.querySelector('.island-lib-view .island-lib-search')
              document.querySelector('.island-lib-foot .island-ctl--back').dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(400)
              out.backToFont = !!document.querySelector('.island-font-view')
              document.querySelector('.island-font-foot .island-bg-back').dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(400)
              out.backToSettings2 = !!document.querySelector('.island-settings-items')
              // 4. 背景视图 → 不透明度按形态独立(紧凑态改滑杆,展开态不受影响)→ 返回
              settingsItem('自定义图片背景').dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(400)
              out.bgShown = !!document.querySelector('.island-panel-bg')
              out.bgSegShown = !!document.querySelector('.island-bg-seg')
              const opSlider = () => document.querySelectorAll('.island-bg-slider input[type=range]')[1]
              const segBtn = (text) => [...document.querySelectorAll('.island-bg-seg button')].find((b) => b.textContent.includes(text))
              if (opSlider()) {
                const setVal = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
                const dragTo = async (v) => {
                  setVal.call(opSlider(), v)
                  opSlider().dispatchEvent(new Event('input', { bubbles: true }))
                  opSlider().dispatchEvent(new Event('change', { bubbles: true }))
                  await sleep(300)
                }
                // 展开态改 40
                await dragTo('40')
                const expandedA = opSlider().value
                // 切紧凑态:滑杆应显示紧凑态原值(≠ 40,不受展开态改动影响)
                segBtn('紧凑态').dispatchEvent(new MouseEvent('click', { bubbles: true }))
                await sleep(300)
                const compactShown = opSlider().value
                // 紧凑态改 70
                await dragTo('70')
                const compactB = opSlider().value
                // 切回展开态:应仍为 40(紧凑态的改动不生效于展开态)
                segBtn('展开态').dispatchEvent(new MouseEvent('click', { bubbles: true }))
                await sleep(300)
                const expandedB = opSlider().value
                out.opacityIndependent =
                  compactShown !== expandedA && compactB === '70' && expandedB === expandedA
                out.opacityDebug = JSON.stringify({ expandedA, compactShown, compactB, expandedB })
              } else {
                out.opacityIndependent = 'n/a (无背景图时无滑杆)'
              }
              document.querySelector('.island-panel-bg .island-bg-back').dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(400)
              out.backToSettings3 = !!document.querySelector('.island-settings-items')
              // 5. 设置 → 返回收起(设置视图只能经返回键退出;帮助手册
              // 已移除 2026-08-10)
              document.querySelector('.island-panel-list:has(.island-settings-items) .island-bg-back').dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(900)
              out.collapsed = !island.classList.contains('expanded')
              return JSON.stringify(out)
            })()`)
            console.log('[widget] test:', result)
          }
          if (process.env.WIDGET_SCREENSHOT_MODE === 'probe-tools-height') {
            // 诊断探针(2026-08-14):工具列表视图打开/返回/收起时窗口高度
            // 响应时序——每 100ms 采样 win.getSize(),记录高度变化何时发生
            const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
            const timeline = []
            const startedAt = Date.now()
            const sampler = () => {
              const t = Date.now() - startedAt
              const [w, h] = win.getSize()
              timeline.push([t, w, h])
            }
            // 备份用户消息与模式,结束时恢复
            let msgsBackup = null
            try {
              msgsBackup = await win.webContents.executeJavaScript(
                `(localStorage.getItem('widget-agent-messages') ?? '')`,
              )
            } catch { /* 忽略 */ }
            // 切 Agent 模式
            win.webContents.send('widget:set-mode', { mode: 'agent', source: 'user' })
            await sleep(600)
            // 注入几条消息(localStorage 写后 reload,useAgent 载入)使聊天
            // 有一定高度,测工具列表打开/关闭时窗口高度的响应
            await win.webContents.executeJavaScript(`(() => {
              const now = Date.now()
              const msgs = [
                { id: 'p1', role: 'user', parts: [{ type: 'text', text: '帮我看看有什么工具' }], createdAt: now - 60000 },
                { id: 'p2', role: 'assistant', parts: [{ type: 'text', text: '好的,我可以帮你完成本机操作。' }], createdAt: now - 59000 },
                { id: 'p3', role: 'user', parts: [{ type: 'text', text: '再详细点' }], createdAt: now - 58000 },
                { id: 'p4', role: 'assistant', parts: [{ type: 'text', text: '我支持执行命令、读写文件、网页搜索、B站下载等能力,也可以打开媒体文件。' }], createdAt: now - 57000 },
              ]
              localStorage.setItem('widget-agent-messages', JSON.stringify(msgs))
              location.reload()
            })()`)
            await sleep(2500)
            // 长按展开
            const expanded = await win.webContents.executeJavaScript(`(async () => {
              const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
              const island = document.querySelector('.island-demo')
              const r = island.getBoundingClientRect()
              const x = r.left + r.width / 2
              const y = r.top + r.height / 2
              island.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y, pointerId: 1, isPrimary: true, button: 0 }))
              setTimeout(() => island.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x, clientY: y, pointerId: 1, isPrimary: true, button: 0 })), 600)
              await sleep(2200)
              return island.classList.contains('expanded')
            })()`)
            console.log('[probe] expanded:', expanded, '| win:', win.getSize())
            // 基线采样(展开稳定后)
            for (let i = 0; i < 5; i++) { sampler(); await sleep(100) }
            // 打开工具列表(⋯ 菜单项)
            const toolsOpened = await win.webContents.executeJavaScript(`(async () => {
              const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
              const item = [...document.querySelectorAll('.island-agent-head .island-quick-menu-item')].find((b) => b.textContent.includes('工具列表'))
              if (!item) return false
              item.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(100)
              return !!document.querySelector('.island-agent-history-list')
            })()`)
            console.log('[probe] tools opened:', toolsOpened)
            // 采样 2.5s:工具列表打开后的窗口高度时序
            for (let i = 0; i < 25; i++) { sampler(); await sleep(100) }
            // 返回对话
            const backOk = await win.webContents.executeJavaScript(`(async () => {
              const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
              document.querySelector('.island-agent-history-back')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(300)
              return !!document.querySelector('.island-agent-messages')
            })()`)
            console.log('[probe] back to chat:', backOk)
            for (let i = 0; i < 20; i++) { sampler(); await sleep(100) }
            // 收起为灵动岛(带渲染端状态细采样:expanded 类 / --agent-h / 面板视图)
            const rendererLog = []
            const rSampler = () =>
              win.webContents
                .executeJavaScript(`(() => {
                  const island = document.querySelector('.island-demo')
                  return JSON.stringify({
                    expanded: island ? island.classList.contains('expanded') : null,
                    agentH: island ? island.style.getPropertyValue('--agent-h') : null,
                    hasChat: !!document.querySelector('.island-agent-messages'),
                    hasTools: !!document.querySelector('.island-agent-history-list'),
                    hasSettings: !!document.querySelector('.island-settings-items'),
                    qmOpen: !!document.querySelector('.island-quick-menu.open'),
                  })
                })()`)
                .then((s) => { try { return JSON.parse(s) } catch { return null } })
                .catch(() => null)
            const collapseClick = await win.webContents.executeJavaScript(`(async () => {
              const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
              const items = [...document.querySelectorAll('.island-agent-head .island-quick-menu-item')]
              const item = items.find((b) => b.textContent.includes('收起为灵动岛'))
              if (!item) return 'no-item'
              item.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(100)
              return 'clicked'
            })()`)
            console.log('[probe] collapse click:', collapseClick)
            for (let i = 0; i < 22; i++) {
              const t = Date.now() - startedAt
              const [w, h] = win.getSize()
              timeline.push([t, w, h])
              rendererLog.push({ t, ...(await rSampler()) })
              await sleep(100)
            }
            const fmt = (from, to) =>
              timeline.filter(([t]) => t >= from && t <= to).map(([t, w, h]) => `${t}ms:${w}x${h}`).join(' | ')
            const t0 = timeline[0]?.[0] ?? 0
            console.log('[probe] baseline..toolsOpen:', fmt(t0, t0 + 1200))
            console.log('[probe] tools open 2.5s:', fmt(t0 + 1200, t0 + 3900))
            console.log('[probe] back-to-chat 2s:', fmt(t0 + 3900, t0 + 5900))
            console.log('[probe] collapse 2.2s:', fmt(t0 + 5900, t0 + 8100))
            console.log(
              '[probe] renderer:',
              rendererLog.map((r) => `${r.t}ms:${r.expanded ? 'exp' : '---'} h=${r.agentH} chat=${r.hasChat ? 1 : 0} tools=${r.hasTools ? 1 : 0} st=${r.hasSettings ? 1 : 0} qm=${r.qmOpen ? 1 : 0}`).join(' | '),
            )
            // 恢复模式与消息
            win.webContents.send('widget:set-mode', { mode: 'music', source: 'user' })
            if (msgsBackup !== null) {
              await win.webContents.executeJavaScript(
                `(() => { localStorage.setItem('widget-agent-messages', ${JSON.stringify(JSON.stringify(msgsBackup))}) })()`,
              )
            }
          }
          if (process.env.WIDGET_SCREENSHOT_MODE === 'probe-clear') {
            // 诊断探针(2026-08-11):新对话后 Agent 面板窗口应缩回扁平
            // (~176),实测仍 16:9。多场景:① 长对话直接清空 ② 含视频的
            // 对话清空 ③ 空白新会话展开 ④ 收起为多媒体岛 → 展开 → 清空。
            // 不调 LLM;mode 由 settings.json 决定
            const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
            const snapshot = () => win.webContents.executeJavaScript(`(() => {
              const island = document.querySelector('.island-demo')
              const msgs = (() => { try { return JSON.parse(localStorage.getItem('widget-agent-messages') || '[]') } catch { return [] } })()
              const quickBtn = document.querySelector('.island-quick-menu-btn')
              const qr = quickBtn ? quickBtn.getBoundingClientRect() : null
              const items = [...(document.querySelectorAll('.island-quick-menu-item') ?? [])].map((b) => b.textContent)
              return JSON.stringify({
                expanded: island?.classList.contains('expanded'),
                agentView: !!document.querySelector('.island-agent'),
                mini: island?.classList.contains('island-agent-mini') ?? false,
                agentH: island ? getComputedStyle(island).getPropertyValue('--agent-h') : null,
                islandRect: island ? { x: island.getBoundingClientRect().x, y: island.getBoundingClientRect().y, w: island.getBoundingClientRect().width, h: island.getBoundingClientRect().height } : null,
                msgCount: msgs.length,
                welcome: !!document.querySelector('.island-agent-welcome'),
                mediaFrames: document.querySelectorAll('.island-media-frame').length,
                quickBtn: qr ? { x: Math.round(qr.left + qr.width / 2), y: Math.round(qr.top + qr.height / 2) } : null,
                quickLabel: quickBtn?.textContent ?? null,
                menuItems: items,
              })
            })()`)
            const winState = async (tag) => {
              console.log('[widget] probe', tag, '→', await snapshot(), '| win:', win.getSize())
            }
            const longPress = async (x, y) => {
              win.webContents.sendInputEvent({ type: 'mouseMove', x, y })
              win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
              await sleep(650)
              win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
              await sleep(1600)
            }
            const click = async (x, y) => {
              win.webContents.sendInputEvent({ type: 'mouseMove', x, y })
              win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
              await sleep(120)
              win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
              await sleep(1200)
            }
            const center = async () => {
              const s = await snapshot()
              const j = JSON.parse(s)
              return j.islandRect
                ? { x: Math.round(j.islandRect.x + j.islandRect.w / 2), y: Math.round(j.islandRect.y + j.islandRect.h / 2) }
                : { x: 260, y: 28 }
            }
            const clickQuickItem = async (label) => {
              // 悬浮打开 QuickMenu → 点菜单项
              const s = JSON.parse(await snapshot())
              const qb = s.quickBtn
              if (!qb) return false
              win.webContents.sendInputEvent({ type: 'mouseMove', x: qb.x, y: qb.y })
              await sleep(500)
              const s2 = JSON.parse(await snapshot())
              const item = s2.menuItems.map((t, i) => [t, i]).find(([t]) => t.includes(label))
              if (!item) return false
              const els = await win.webContents.executeJavaScript(`(() => {
                const btns = [...document.querySelectorAll('.island-quick-menu-item')]
                const b = btns.find((x) => x.textContent.includes(${JSON.stringify(label)}))
                if (!b) return null
                const r = b.getBoundingClientRect()
                return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
              })()`)
              if (!els) return false
              await click(els.x, els.y)
              return true
            }
            const seedMsgs = (withMedia) => win.webContents.executeJavaScript(`(() => {
              const mk = (role, text, extra) => ({
                id: 'probe-' + role + '-' + Math.random().toString(36).slice(2),
                role,
                parts: extra ? [{ type: 'text', text }, ...extra] : [{ type: 'text', text }],
                usage: null,
                createdAt: Date.now(),
              })
              const msgs = []
              for (let i = 0; i < 8; i++) {
                msgs.push(mk('user', '探针问题 ' + (i + 1) + ':帮我处理一下这个任务'))
                msgs.push(mk('assistant', '这是第 ' + (i + 1) + ' 条探针回复。' + '详细内容 '.repeat(60) + '结尾 ' + i))
              }
              ${
                withMedia
                  ? `msgs.push(mk('assistant', '下面是视频:', [{ type: 'media', kind: 'video', url: 'island-media://local/test.mp4', name: '测试视频.mp4' }]))`
                  : ''
              }
              localStorage.setItem('widget-agent-messages', JSON.stringify(msgs))
              localStorage.setItem('widget-agent-scale', '200')
              localStorage.setItem('widget-agent-sessions', '[]')
              return { msgs: msgs.length }
            })()`)
            const resetStorage = () => win.webContents.executeJavaScript(`(() => {
              localStorage.removeItem('widget-agent-messages')
              localStorage.removeItem('widget-agent-sessions')
              localStorage.setItem('widget-agent-scale', '200')
              return true
            })()`)
            // ===== 场景 B:长对话(含视频)→ 展开 → 新对话 =====
            console.log('[widget] probe ==== 场景 B:含视频长对话 → 新对话 ====')
            await seedMsgs(true)
            win.webContents.reload()
            await sleep(2000)
            {
              const p = await center()
              await longPress(p.x, p.y)
            }
            await winState('B1 展开(含视频)')
            {
              const s = JSON.parse(await snapshot())
              if (s.quickBtn) {
                await click(s.quickBtn.x, s.quickBtn.y) // 单击 = 执行当前项(新对话)
              }
            }
            await winState('B2 新对话后')
            // ===== 场景 C:空白新会话 → 展开 =====
            console.log('[widget] probe ==== 场景 C:空白新会话展开 ====')
            await resetStorage()
            win.webContents.reload()
            await sleep(2000)
            {
              const p = await center()
              await longPress(p.x, p.y)
            }
            await winState('C1 空白展开')
            // ===== 场景 D:收起为多媒体岛 → 展开 → 新对话 =====
            console.log('[widget] probe ==== 场景 D:媒体岛 → 展开 → 新对话 ====')
            await seedMsgs(true)
            win.webContents.reload()
            await sleep(2000)
            {
              const p = await center()
              await longPress(p.x, p.y)
            }
            await winState('D1 展开(含视频)')
            await clickQuickItem('收起为多媒体岛')
            await sleep(1000)
            await winState('D2 媒体岛')
            {
              const p = await center()
              await longPress(p.x, p.y)
            }
            await winState('D3 从媒体岛展开')
            {
              const s = JSON.parse(await snapshot())
              if (s.quickBtn) {
                await click(s.quickBtn.x, s.quickBtn.y)
              }
            }
            await winState('D4 新对话后')
            {
              const image = await win.webContents.capturePage()
              fs.writeFileSync(process.env.WIDGET_SCREENSHOT + '.probe-d4.png', image.toPNG())
            }
            // ===== 场景 E:真实 LLM 回复中点击新对话 =====
            // clear 必须中止引擎回合:否则孤儿回复落进新对话 + status 停在
            // thinking(思考占位行把空对话测高顶过下限 → 16:9 封顶)
            console.log('[widget] probe ==== 场景 E:回复中点新对话 ====')
            await resetStorage()
            win.webContents.reload()
            await sleep(2000)
            {
              const p = await center()
              await longPress(p.x, p.y)
            }
            await winState('E1 空白展开')
            // 真实发送(settings.json 已配 apiKey;history 末尾 = 本轮用户消息)
            await win.webContents.executeJavaScript(`window.desktop?.agentSend?.('只回复四个字:你好世界', [{ id: 'probe-u-e', role: 'user', parts: [{ type: 'text', text: '只回复四个字:你好世界' }], usage: null, createdAt: Date.now() }])`)
            await sleep(1800)
            await winState('E2 流式/思考中')
            // 悬浮展开 QuickMenu → 点「新对话」菜单项(按钮当前项可能是
            // 收起等其它项——按钮执行的是当前 wheel 项,必须点具体菜单项)
            await clickQuickItem('新对话')
            await winState('E3 回复中点新对话')
            await sleep(5000) // 等引擎 abort 收敛
            await winState('E4 稳定后(应 0 消息 + 扁平)')
            {
              const image = await win.webContents.capturePage()
              fs.writeFileSync(process.env.WIDGET_SCREENSHOT + '.probe-e4.png', image.toPNG())
            }
          }
          if (process.env.WIDGET_SCREENSHOT_MODE === 'probe-evolve') {
            // 记忆进化实测探针(2026-08-11 用户要求"后台测试,什么时候能
            // 真正整合有效信息,要求垂直细分,关键词不能散落重复出现在
            // 那么多记忆里"):① 备份记忆/状态/日志 ② 统计"关键词散落"
            // (每个主题词出现在几条记忆,应趋向 1 = 垂直细分整合)
            // ③ 触发真实进化(主进程 getEvolution,4 轮上限,真实 LLM)
            // ④ 轮询日志直到完成 ⑤ 复统计 + 日志摘要 + 增删明细
            const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
            const dir = path.dirname(settingsPath())
            const file = (name) => path.join(dir, name)
            const readJson = async (name) => {
              try {
                return JSON.parse(await fs.promises.readFile(file(name), 'utf8'))
              } catch {
                return null
              }
            }
            const memoryEntries = async () => {
              const d = await readJson('memory.json')
              return Array.isArray(d) ? d : d?.entries ?? []
            }
            const KEYWORDS = ['小胖', 'TTG', '1080P', 'B站', '收藏夹', '夜间', '凌晨', '夜猫', 'MV']
            const scatter = (entries) => {
              const out = {}
              for (const k of KEYWORDS) out[k] = entries.filter((e) => e.content.includes(k)).length
              return out
            }
            // 备份(进化接受的新版本可经设置界面回滚;这里双保险)
            for (const n of ['memory.json', 'memory-state.json', 'evolution.json']) {
              try {
                await fs.promises.copyFile(file(n), file(n + '.probe-bak'))
              } catch {
                // 无此文件
              }
            }
            const before = await memoryEntries()
            console.log(
              '[widget] probe-evolve before:',
              JSON.stringify({ count: before.length, scatter: scatter(before) }),
            )
            const logBefore = (await readJson('evolution.json'))?.logs?.length ?? 0
            const res = await requestEvolution(4)
            console.log('[widget] probe-evolve start:', JSON.stringify(res))
            let done = false
            const t0 = Date.now()
            while (Date.now() - t0 < 240_000) {
              await sleep(3000)
              const logNow = (await readJson('evolution.json'))?.logs?.length ?? 0
              if (logNow > logBefore) {
                done = true
                break
              }
            }
            await sleep(2000) // 等最后一轮日志落盘
            const after = await memoryEntries()
            const logAfter = (await readJson('evolution.json'))?.logs ?? []
            const newLogs = logAfter.slice(0, Math.max(0, logAfter.length - logBefore))
            console.log(
              '[widget] probe-evolve done:',
              JSON.stringify({
                done,
                count: after.length,
                scatter: scatter(after),
                logCount: logAfter.length,
                rounds: newLogs.map((l) => l.summary),
              }),
            )
            const c1 = before.map((e) => e.content)
            const c2 = after.map((e) => e.content)
            console.log(
              '[widget] probe-evolve deleted:',
              JSON.stringify(c1.filter((c) => !c2.includes(c)).map((c) => c.slice(0, 70))),
            )
            console.log(
              '[widget] probe-evolve added:',
              JSON.stringify(c2.filter((c) => !c1.includes(c)).map((c) => c.slice(0, 100))),
            )
            console.log(
              '[widget] probe-evolve final entries:',
              JSON.stringify(after.map((e, i) => `${i + 1}. [${e.type}] ${e.content.slice(0, 110)}`)),
            )
          }
          if (process.env.WIDGET_SCREENSHOT_MODE === 'agent') {
            // Agent 功能巡检(严格 UI 测试):托盘设置 → Agent 设置视图 →
            // 表单/MCP 双传输编辑/测试连接/技能目录/记忆增删/进化/保存。
            // 分两段:段 1 进入 agent-settings 视图停留(主进程截图),
            // 段 2 逐项交互断言(React 受控输入用原生 value setter)。
            // env WIDGET_MOCK_SERVER = mock MCP stdio 服务器路径(测试命令
            // 先以保活 stdin 方式启动;command 用 node,由 PATH 解析)
            const mockServer = process.env.WIDGET_MOCK_SERVER || ''
            // 巡检会点击"保存配置"(表单状态写回 settings.json)——备份
            // 用户配置,巡检结束恢复(实测:巡检保存覆盖了用户 siyuan 配置)
            const settingsFile = settingsPath()
            let settingsBackup = null
            try {
              settingsBackup = fs.readFileSync(settingsFile, 'utf8')
            } catch {
              // 无配置可备份
            }
            // 托盘"设置"入口:展开并切换到设置视图(与 test 模式一致)
            win.webContents.send('widget:open-settings')
            await new Promise((r) => setTimeout(r, 800))
            // 段 0:歌词 API 接入点(设置 → 歌词 API:预设厂家选择 + 保存)
            const lyricApiResult = await win.webContents.executeJavaScript(`(async () => {
              const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
              const out = {}
              const settingsItem = (text) =>
                [...document.querySelectorAll('.island-settings-item')].find((s) => s.textContent.includes(text))
              out.lyricApiEntry = !!settingsItem('歌词 API')
              settingsItem('歌词 API')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(400)
              const view = document.querySelector('.island-lyric-api')
              out.lyricApiViewShown = !!view
              out.presetCount = view?.querySelectorAll('.island-lyric-provider').length ?? 0
              // 选 QQ音乐 → 保存 → localStorage 校验。
              // 注意:保存后 React 重渲染可能替换节点,每次操作**实时查询**
              // (缓存引用会失效,与 MCP 填表同问题)
              const providerBtn = (text) =>
                [...(document.querySelectorAll('.island-lyric-provider') ?? [])].find((b) => b.textContent.includes(text))
              const saveBtn = () =>
                [...(document.querySelectorAll('.island-lyric-api button') ?? [])].find((b) => b.textContent.includes('保存歌词 API'))
              providerBtn('QQ音乐')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(200)
              saveBtn()?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(300)
              out.savedProvider = localStorage.getItem('widget-lyric-provider') ?? '(无)'
              out.savedQq = (localStorage.getItem('widget-lyric-provider') ?? '').includes('qq')
              // 恢复默认(网易云)并返回设置(返回键也实时查询)
              providerBtn('网易云')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(200)
              saveBtn()?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(300)
              out.restoredProvider = localStorage.getItem('widget-lyric-provider') ?? '(无)'
              // 自动切换开关:默认开启 → 点击关闭 → localStorage 校验 → 恢复开启
              const toggle = document.querySelector('.island-lyric-api .island-toggle')
              out.toggleShown = !!toggle
              out.toggleDefaultOn = toggle?.classList.contains('on') ?? false
              out.autoDefault = localStorage.getItem('widget-lyric-auto') ?? '(未设置=默认开)'
              toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(300)
              out.autoAfterOff = localStorage.getItem('widget-lyric-auto') ?? '(无)'
              toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(300)
              out.autoRestored = localStorage.getItem('widget-lyric-auto') ?? '(无)'
              // 返回键在 .island-panel-list 根部(BackFoot 在 .island-lyric-api 外)
              const backBtn = document.querySelector('.island-panel-list:has(.island-lyric-api) .island-bg-back')
              out.backBtnFound = !!backBtn
              out.backBtnText = backBtn?.textContent ?? '(无)'
              backBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(400)
              out.backToSettings = !!document.querySelector('.island-settings-items')
              out.lyricApiStillShown = !!document.querySelector('.island-lyric-api')
              return JSON.stringify(out)
            })()`)
            console.log('[widget] agent-lyric-api:', lyricApiResult)
            // 段 1:展开 → 设置视图 → Agent 设置视图
            const enterResult = await win.webContents.executeJavaScript(`(async () => {
              const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
              const out = {}
              const island = document.querySelector('.island-demo')
              const settingsItem = (text) =>
                [...document.querySelectorAll('.island-settings-item')].find((s) => s.textContent.includes(text))
              out.openSettings = !!document.querySelector('.island-settings-items')
              const agentEntry = settingsItem('Agent 设置')
              out.agentEntryShown = !!agentEntry
              agentEntry?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(500)
              const view = document.querySelector('.island-agent-settings')
              out.agentSettingsShown = !!view
              if (view) {
                const form = view.querySelector('.island-agent-form')
                out.formShown = !!form
                out.apiKeyInput = !!form?.querySelector('input[placeholder*="sk-"]')
                // Base URL 无 placeholder;2026-08-07 布局重构后 tab 0(连接)
                // 含 3 个 input(API Key/Base URL/模型)
                const formInputs = form?.querySelectorAll('input') ?? []
                out.baseUrlInput = formInputs.length >= 3
                out.modelInput = !!form?.querySelector('input[value="deepseek-v4-flash"]')
                // 2026-08-07 布局重构:提示词移入"行为与界面"菜单、section
                // 移入"工具与能力"/"记忆与进化"菜单——tab 0 只含连接字段,
                // 以下断言改为"菜单条存在 + 确实移走"(段 2 逐 tab 详测)
                out.tabsShown = !!view.querySelector('.island-quick-menu')
                out.promptTextareaMoved = !form?.querySelector('textarea')
                out.sectionTitlesMoved = view.querySelectorAll('.island-agent-section-title').length === 0
                // 缩放 % 按钮移入"行为与界面"(思考强度按钮同用
                // island-agent-scale-btn 类但无 %,限定 % 按钮统计)
                out.scaleBtnsMoved = [...form.querySelectorAll('.island-agent-scale-btn')].filter((b) =>
                  b.textContent.includes('%'),
                ).length === 0
              // 2026-08-07 布局重构:MCP 服务已移入"工具与能力"菜单——
              // tab 0(连接)不应出现;配置刷新验证由段 2 在工具菜单断言
              // (MCP 卡 + 真实连接测试,覆盖 onRefresh 拉取)
              out.mcpCardsMoved = view.querySelectorAll('.island-mcp-card').length === 0
              }
              out.expanded = island.classList.contains('expanded')
              return JSON.stringify(out)
            })()`)
            console.log('[widget] agent-enter:', enterResult)
            console.log('[widget] window size at agent-settings:', win.getSize())
            // 截图 1:agent-settings 视图(独立文件名,避免被末尾通用截图覆盖)
            {
              const image = await win.webContents.capturePage()
              fs.writeFileSync(process.env.WIDGET_SCREENSHOT + '.agent1.png', image.toPNG())
              console.log('[widget] screenshot(agent-settings) saved')
            }
            // 段 2:交互断言
            const interactResult = await win.webContents.executeJavaScript(`(async () => {
              const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
              const out = {}
              const view = document.querySelector('.island-agent-settings')
              const form = view?.querySelector('.island-agent-form')
              if (!view || !form) return JSON.stringify({ fatal: 'agent-settings 视图未打开' })
              // React 受控输入赋值(原生 setter + input 事件);元素不存在时
              // 记录并跳过(选择器与 DOM 不匹配时报错不如继续断言)
              const setInput = (el, value) => {
                if (!el) return false
                const proto = el.tagName === 'TEXTAREA'
                  ? window.HTMLTextAreaElement.prototype
                  : window.HTMLInputElement.prototype
                const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
                setter.call(el, value)
                el.dispatchEvent(new Event('input', { bubbles: true }))
                return true
              }
              const scrollInto = async (el) => {
                el?.scrollIntoView({ block: 'center' })
                await sleep(150)
              }
              const btnByText = (text) => [...view.querySelectorAll('.island-agent-scale-btn, .island-ctl')].find((b) => b.textContent.includes(text))
              // 分组菜单(2026-08-07 布局重构):悬浮展开(React onMouseEnter
              // 由 mouseover 模拟,relatedTarget null = 从外部进入;合成事件
              // 对 CSS :hover 无效但对 React 状态有效)→ 点击菜单项切换。
              // 悬浮不生效时 fallback 点击整合按钮(onClick 也是 toggle 展开)
              const switchTab = async (name) => {
                const tabs = view.querySelector('.island-quick-menu')
                if (!tabs) return false
                tabs.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: null }))
                await sleep(250)
                if (!view.querySelector('.island-quick-menu-pop')) {
                  tabs
                    .querySelector('.island-quick-menu-btn')
                    ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
                  await sleep(250)
                }
                const item = [...(view.querySelectorAll('.island-quick-menu-item') ?? [])].find(
                  (b) => b.textContent.trim() === name,
                )
                if (!item) return false
                item.dispatchEvent(new MouseEvent('click', { bubbles: true }))
                await sleep(400) // 内容重挂载动画
                return true
              }

              // ---- 分组菜单断言(2026-08-07):整合按钮 + 悬浮展开四项 + 滚轮逐格 ----
              const tabsBar = view.querySelector('.island-quick-menu')
              // 按钮文字读 .island-wheel-swap-in(新值层)——textContent 会
              // 把交换动画的旧值层也算进去(动画期间两层都在 DOM,实测)
              const tabsBtnText = () =>
                tabsBar?.querySelector('.island-wheel-swap-in')?.textContent?.trim() ?? '(无)'
              out.tabsBarShown = !!tabsBar
              out.tabsBtnText = tabsBtnText()
              // 滚轮正向一格(连接 → 行为与界面;WheelEvent deltaY 与 DOM 一致)
              tabsBar?.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 120 }))
              await sleep(300)
              out.tabsWheelFwd = tabsBtnText()
              // 滚轮反向一格回连接
              tabsBar?.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -120 }))
              await sleep(300)
              out.tabsWheelBack = tabsBtnText()
              // 悬浮展开断言(四项菜单名 + 当前项高亮)
              view
                .querySelector('.island-quick-menu')
                ?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: null }))
              await sleep(300)
              const tabItems = [...(view.querySelectorAll('.island-quick-menu-item') ?? [])].map((b) => ({
                text: b.textContent.trim(),
                on: b.classList.contains('on'),
              }))
              out.tabsItemCount = tabItems.length
              out.tabsItems = tabItems.map((t) => t.text)
              out.tabsCurrentOn = tabItems.find((t) => t.on)?.text ?? '(无)'

              // ---- 账号功能(2026-08-11 用户要求"Agent 设置添加账号余额
              // 查询,API 配置集成到账号功能") ----tab 0(账号)余额卡片 +
              // 刷新按钮;点刷新触发**真实余额查询**(巡检环境有真实 API
              // Key,GET /user/balance 只读安全);断言余额行渲染或明确错误
              const accountCard = view.querySelector('.island-agent-account')
              out.accountCardShown = !!accountCard
              if (accountCard) {
                // 去充值按钮(2026-08-11:DeepSeek 无充值 API,跳转网页端
                // 充值中心;openExternal stub 捕获 URL 断言接线)
                const topupBtn = accountCard.querySelector('.island-agent-account-topup')
                out.accountTopupShown = !!topupBtn
                const openCalls = []
                const origOpen = window.desktop.openExternal
                window.desktop.openExternal = (url) => openCalls.push(url)
                topupBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
                window.desktop.openExternal = origOpen
                out.accountTopupUrl = openCalls[0] ?? null
                out.accountTopupOk = openCalls[0] === 'https://platform.deepseek.com/top_up'
                const refreshBtn = accountCard.querySelector('.island-agent-account-refresh')
                out.accountRefreshShown = !!refreshBtn
                refreshBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
                // 真实查询等待(网络往返 + 引擎 fetch)
                await sleep(3000)
                const rows = [...accountCard.querySelectorAll('.island-agent-account-row')].map((r) =>
                  r.textContent.replace(/[ \t\r\n]+/g, ' ').trim(),
                )
                const errEl = accountCard.querySelector('.island-agent-account-error')
                out.accountRows = rows
                out.accountError = errEl ? errEl.textContent.trim() : null
                out.accountOk =
                  rows.length > 0 || (errEl !== null && (errEl.textContent || '').length > 0)
              }

              // ---- MCP 服务编辑(工具与能力菜单) ----
              await switchTab('工具与能力')
              const addBtn = btnByText('添加服务')
              await scrollInto(addBtn)
              addBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(200)
              // 取**最后一张**卡(刚添加的)——第一张可能是用户已有配置
              // (实测:填写时误改已有 siyuan 卡,覆盖了用户配置!)
              const cards = view.querySelectorAll('.island-mcp-card')
              const card = cards[cards.length - 1]
              out.mcpCardShown = !!card
              out.mcpCardCountBefore = cards.length
              // 类型切换:stdio → sse(sse 显示 URL/请求头,隐藏 command)
              const sseBtn = [...card.querySelectorAll('.island-mcp-type-row button')].find((b) => b.textContent.includes('sse'))
              sseBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(200)
              const urlInput = card.querySelector('input[placeholder*="https://"]')
              out.mcpSseUrlShown = !!urlInput
              out.mcpSseCommandHidden = ![...card.querySelectorAll('.island-agent-field span')].some((s) => s.textContent.includes('启动命令'))
              // 切回 stdio 并填入 mock 配置(只操作新添加的卡)
              const stdioBtn = [...card.querySelectorAll('.island-mcp-type-row button')].find((b) => b.textContent.includes('stdio'))
              stdioBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(200)
              // 填表:每次填写后等 React 渲染并**重新查询 DOM**——受控输入
              // 触发重渲染可能替换节点,旧引用的事件不再冒泡(实测:旧引用
              // 只生效第一个字段,其余丢失)
              const fillCard = async (selector, value) => {
                const cardNow = (() => {
                  const cs = view.querySelectorAll('.island-mcp-card')
                  return cs[cs.length - 1]
                })()
                const input = cardNow.querySelector(selector)
                await scrollInto(input)
                setInput(input, value)
                await sleep(200)
              }
              await fillCard('input[placeholder="如 filesystem"]', 'ui-mock')
              await fillCard('input[placeholder*="npx"]', 'node')
              await fillCard('textarea', ${JSON.stringify(mockServer)})
              // 测试连接(真实连 mock stdio 服务器,断言 6 个工具)
              // 重新查询当前卡片(React 重渲染可能替换 DOM)后点击测试
              const freshCard = (() => {
                const cs = view.querySelectorAll('.island-mcp-card')
                return cs[cs.length - 1]
              })()
              const freshTestBtn = [...freshCard.querySelectorAll('.island-mcp-actions button')].find((b) => b.textContent.includes('测试'))
              out.testBtnDisabled = freshTestBtn?.disabled ?? 'n/a'
              await scrollInto(freshTestBtn)
              freshTestBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(3000)
              const testResultEl = freshCard.querySelector('.island-mcp-test-result')
              out.mcpTestText = testResultEl?.textContent ?? '(无结果)'
              out.mcpTestOk = (testResultEl?.textContent ?? '').includes('连接成功')

              // ---- 技能目录 ----
              const skillsSection = [...view.querySelectorAll('.island-agent-section')].find((s) => s.textContent.includes('技能目录'))
              const skillsRows = skillsSection?.querySelectorAll('.island-skills-dir-row') ?? []
              out.skillsDirRows = [...skillsRows].map((r) => r.textContent.trim().slice(0, 60))
              out.skillsDefaultScanned = [...skillsRows].some((r) => r.textContent.includes('.claude'))
              // 已注册技能预览(全部技能目录扫描结果,不截断)
              const regRows = skillsSection?.querySelectorAll('.island-skills-reg-row') ?? []
              out.skillsRegisteredCount = regRows.length
              out.skillsRegisteredShown = regRows.length >= 8
              out.skillsRegisteredSample = [...regRows].slice(0, 3).map((r) => r.textContent.trim().slice(0, 40))
              // 技能移除/恢复:点第一行的"移除" → 行消失 + 已排除区出现 → 恢复。
              // 注意:已排除区也复用 .island-skills-reg-row 类,限定直接子行
              const skillRows = () => [
                ...(skillsSection?.querySelectorAll('.island-skills-registered > .island-skills-reg-row') ?? []),
              ]
              const firstRm = skillRows()[0]?.querySelector('.island-skills-reg-rm')
              const firstSlug = skillRows()[0]?.querySelector('.island-skills-reg-name')?.textContent
              await scrollInto(firstRm)
              firstRm?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(400)
              out.skillRemoved = skillRows().length === regRows.length - 1
              out.excludedSectionShown = !!skillsSection?.querySelector('.island-skills-excluded')
              out.excludedSlug = skillsSection?.querySelector('.island-skills-excluded .island-skills-reg-name')?.textContent
              // 分区断言:扫描到的区(用户无自建技能时"自己创建"区不存在)
              const regCounts = [...(skillsSection?.querySelectorAll('.island-skills-reg-count') ?? [])].map(
                (c) => c.textContent,
              )
              out.skillPartition = regCounts
              out.scannedPartitionShown = regCounts.some((c) => c.includes('扫描到的'))
              out.ownPartitionShown = regCounts.some((c) => c.includes('自己创建'))
              // 恢复(已排除区第一行的"恢复")
              const restoreBtn = skillsSection?.querySelector('.island-skills-excluded .island-agent-scale-btn')
              await scrollInto(restoreBtn)
              restoreBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(400)
              out.skillRestored = skillRows().length === regRows.length
              out.skillRestoredSlug = firstSlug ?? ''

              // ---- 记忆管理器(记忆与进化菜单;添加按钮按文本匹配——
              // 记忆条目的"改/删"按钮也在区里,querySelector 第一个会选错) ----
              await switchTab('记忆与进化')
              const memSection = [...view.querySelectorAll('.island-agent-section')].find((s) => s.textContent.includes('长期记忆'))
              const memDraftInput = memSection?.querySelector('input[placeholder*="我喜欢"]')
              const memAddBtn = [...(memSection?.querySelectorAll('.island-agent-scale-btn') ?? [])].find((b) => b.textContent === '添加')
              out.memAddBtnText = memAddBtn?.textContent ?? '(无)'
              out.memBtnAll = [...(memSection?.querySelectorAll('.island-agent-scale-btn') ?? [])].map((b) => b.textContent)
              await scrollInto(memDraftInput)
              const memInputSet = setInput(memDraftInput, 'UI 测试记忆条目')
              out.memInputFound = memInputSet
              await sleep(250) // 等 React 提交输入(立即点击会读到旧 state 空内容)
              memAddBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(400)
              out.memErrorText = memSection?.querySelector('.island-mcp-test-result.fail')?.textContent ?? '(无错误)'
              const memRows = memSection?.querySelectorAll('.island-memory-row') ?? []
              out.memoryAdded = [...memRows].some((r) => r.textContent.includes('UI 测试记忆条目'))
              out.memoryCount = memRows.length
              // 删除刚添加的条目
              const addedRow = [...memRows].find((r) => r.textContent.includes('UI 测试记忆条目'))
              const delBtn = addedRow?.querySelector('.island-mcp-remove')
              await scrollInto(delBtn)
              delBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(400)
              const memRows2 = memSection?.querySelectorAll('.island-memory-row') ?? []
              out.memoryRemoved = ![...memRows2].some((r) => r.textContent.includes('UI 测试记忆条目'))

              // ---- 新增控件断言(2026-08-06):主动陪伴折叠 / 缩放步进器 / 已保存徽标 ----
              // (行为与界面菜单;exec_command 确认门设置已移除,2026-08-07)
              await switchTab('行为与界面')
              // 主动陪伴折叠(2026-08-07 用户要求):默认开启 → 间隔设置展开;
              // 关闭开关 → 折叠(0fr 动画),再开启恢复
              const proactiveToggle = view.querySelector('.island-agent-field--toggle .island-toggle')
              out.proactiveToggleShown = !!proactiveToggle
              out.proactiveConfigOpenDefault = !!view.querySelector('.island-proactive-config.open')
              proactiveToggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(400)
              out.proactiveConfigCollapsed = !view.querySelector('.island-proactive-config.open')
              proactiveToggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(400)
              out.proactiveConfigReopened = !!view.querySelector('.island-proactive-config.open')
              // 缩放步进器(定制 UI):值徽标 + ▲▼;点击 ▲ 值 +1,滚轮切换。
              // 2026-08-07 起页面有两个步进器(界面放大 + 主动陪伴间隔,
              // 间隔在前)——**必须按「界面放大」字段定位**,否则 querySelector
              // 取到第一个(间隔步进器),缩放步进器失去巡检覆盖(实测)
              const scaleField = [...view.querySelectorAll('.island-agent-field')].find((f) =>
                f.textContent.includes('界面放大'),
              )
              const stepper = scaleField?.querySelector('.island-scale-stepper')
              const stepperVal = () =>
                stepper?.querySelector('.island-wheel-swap-in')?.textContent?.trim() ?? '(无)'
              out.stepperShown = !!stepper
              if (stepper) {
                out.stepperDefault = stepperVal()
                const upBtn = stepper.querySelector('.island-scale-stepper-arrows button:first-child')
                upBtn?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
                await sleep(200)
                out.stepperUp = stepperVal()
                // 滚轮一格(正向 = +1,与箭头同向)
                stepper
                  .querySelector('.island-scale-stepper-value')
                  ?.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 120 }))
                await sleep(250)
                const stepperAfter = scaleField?.querySelector('.island-scale-stepper')
                out.stepperWheel = stepperAfter?.querySelector('.island-wheel-swap-in')?.textContent?.trim()
                out.stepperTickClass = stepperAfter
                  ?.querySelector('.island-scale-stepper-value')
                  ?.classList.contains('tick')
              }
              // 主动陪伴间隔步进器(2026-08-07):存在性 + 默认值断言
              // (步进行为与缩放共用组件,段 4.8 已覆盖设置工具链路)
              const proactiveField = [...view.querySelectorAll('.island-agent-field')].find((f) =>
                f.textContent.includes('触发间隔'),
              )
              const intervalStepper = proactiveField?.querySelector('.island-scale-stepper')
              out.intervalStepperShown = !!intervalStepper
              out.intervalStepperDefault =
                intervalStepper?.querySelector('.island-wheel-swap-in')?.textContent?.trim() ?? '(无)'
              // 单位选择(2026-08-07):秒/分钟/小时按钮;切换单位**数值不变
              // 仅换后缀**(用户约定);测完切回分钟,保存不污染用户配置
              const unitBtns = [...(proactiveField?.querySelectorAll('.island-agent-scale-btn') ?? [])].filter(
                (b) => ['秒', '分钟', '小时'].includes(b.textContent.trim()),
              )
              out.unitBtnsShown = unitBtns.length === 3
              out.unitDefault = proactiveField?.querySelector('.island-agent-scale-hint')?.textContent?.trim() ?? '(无)'
              unitBtns.find((b) => b.textContent.trim() === '小时')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(250)
              out.unitAfterHour = proactiveField?.querySelector('.island-agent-scale-hint')?.textContent?.trim() ?? '(无)'
              out.unitValueUnchanged =
                (proactiveField?.querySelector('.island-scale-stepper-value')?.textContent?.trim() ?? '') === '60'
              unitBtns.find((b) => b.textContent.trim() === '分钟')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(250)
              // 保存配置按钮内联"已保存"(2026-08-07 用户要求:不弹绿勾
              // 气泡,按钮文字变"已保存"回弹淡入,2.2s 后恢复"保存配置")
              const confirmSaveBtn = [...view.querySelectorAll('button')].find((b) => b.textContent.includes('保存配置'))
              out.saveBtnShown = !!confirmSaveBtn
              if (confirmSaveBtn) {
                confirmSaveBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
                await sleep(350)
                const savedLabel = view.querySelector('.island-save-label')
                out.savedInline = savedLabel?.textContent?.trim() === '已保存'
                out.savedInlineGreen = view.querySelector('.island-save-btn.saved') !== null
                await sleep(2300)
                out.savedInlineRestored =
                  (view.querySelector('.island-save-label')?.textContent ?? '').includes('保存配置')
              }

              // ---- 记忆类型按钮滚轮切换(记忆与进化菜单) ----
              await switchTab('记忆与进化')
              // 记忆类型下拉(2026-08-07 重构:通用 QuickMenu——整合按钮 +
              // 同行联通展开 + 滚轮逐格循环 + 高亮滑块;**默认选中的类型是
              // 偏好**)。页面有两个 QuickMenu(设置菜单 + 记忆类型),经
              // 记忆类型徽标 .island-memory-type 的祖先定位(设置菜单无徽标)
              // 合成 WheelEvent(deltaY 与 DOM 一致:正向 = 下一项)即可驱动
              // React onWheel;每格重挂载——每次操作后**重新查询 DOM**
              const queryTypeMenu = () => {
                // 记忆条目行的徽标不在 QuickMenu 里(条目行无下拉)——遍历
                // 全部徽标,取第一个位于 QuickMenu 内的(即添加行的下拉)
                const badges = [...document.querySelectorAll('.island-memory-type')]
                for (const b of badges) {
                  const m = b.closest('.island-quick-menu')
                  if (m) return m
                }
                return null
              }
              const queryTypeBtn = () => queryTypeMenu()?.querySelector('.island-quick-menu-btn')
              // 读 .island-wheel-swap-in 层的徽标(交换动画的旧层仍在 DOM)
              const typeLabel = (btn) =>
                btn?.querySelector('.island-wheel-swap-in .island-memory-type')?.textContent?.trim() ??
                '(无)'
              let typeBtn = queryTypeBtn()
              await scrollInto(typeBtn)
              out.typeBtnShown = !!typeBtn
              out.typeDefault = typeLabel(typeBtn)
              if (typeBtn) {
                // 正向一格(默认偏好 → 事实;MEMORY_TYPES 顺序 preference 在前)
                queryTypeMenu()?.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 120 }))
                await sleep(250)
                typeBtn = queryTypeBtn()
                out.typeFwd = typeLabel(typeBtn)
                out.typeFwdOk = typeLabel(typeBtn) === '事实'
                out.typeTickClass = typeBtn?.classList.contains('tick') ?? false
                // 反向一格(事实 → 偏好)
                queryTypeMenu()?.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -120 }))
                await sleep(250)
                typeBtn = queryTypeBtn()
                out.typeBwd = typeLabel(typeBtn)
                out.typeBwdOk = typeLabel(typeBtn) === '偏好'
                // 展开:点击按钮 → 4 个选项(QuickMenu 无点外关闭,再次点击收起)
                typeBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
                await sleep(300)
                out.typePopShown = !!queryTypeMenu()?.classList.contains('open')
                out.typeOptCount = queryTypeMenu()?.querySelectorAll('.island-quick-menu-item').length ?? 0
                queryTypeMenu()?.querySelector('.island-quick-menu-btn')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
                await sleep(400)
                out.typePopClosed = !queryTypeMenu()?.classList.contains('open')
              }

              // ---- 自我进化区(按标题元素匹配——记忆区提示文本也含"自我进化") ----
              const evoSection = [...view.querySelectorAll('.island-agent-section')].find(
                (s) => s.querySelector('.island-agent-section-title')?.textContent.includes('自我进化'),
              )
              out.evoSectionShown = !!evoSection
              out.evoSectionText = evoSection?.textContent?.slice(0, 60) ?? '(无)'
              out.evoBtns = [...(evoSection?.querySelectorAll('button') ?? [])].map((b) => b.textContent)
              const evolveBtn = [...(evoSection?.querySelectorAll('.island-agent-scale-btn') ?? [])].find((b) => b.textContent.includes('运行记忆进化'))
              out.evolveBtnShown = !!evolveBtn
              // 新功能:导入技能按钮 + 清除所有版本按钮 + 空态初始化提示
              out.importBtnShown = [...view.querySelectorAll('button')].some((b) => b.textContent.includes('导入技能'))
              out.resetBtnShown = [...(evoSection?.querySelectorAll('button') ?? [])].some((b) => b.textContent.includes('清除所有版本'))
              out.initialStateShown = (evoSection?.textContent ?? '').includes('暂无进化记录')
              const rollbackBtn = [...(evoSection?.querySelectorAll('.island-agent-scale-btn') ?? [])].find((b) => b.textContent.includes('回滚'))
              out.rollbackBtnShown = !!rollbackBtn
              // 触发进化(无 API Key → 后台失败通知,按钮变"进化中…"后恢复)
              await scrollInto(evolveBtn)
              evolveBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(300)
              out.evolveClicked = (evolveBtn?.textContent ?? '').includes('进化中') || (evoSection?.querySelector('.island-mcp-test-result')?.textContent ?? '').includes('已开始')

              // ---- Sub Agent 设置(2026-08-07):文风/人格预设 + 自定义 ----
              await switchTab('Sub Agent')
              const summaryField = [...view.querySelectorAll('.island-agent-section')].find((s) =>
                s.textContent.includes('总结标题文风'),
              )
              const mindField = [...view.querySelectorAll('.island-agent-section')].find((s) =>
                s.textContent.includes('心理揣测人格'),
              )
              out.subAgentSectionsShown = !!summaryField && !!mindField
              const presetNames = (field) =>
                [...(field?.querySelectorAll('.island-agent-scale-btn') ?? [])].map((b) => b.textContent.trim())
              const summaryPresets = presetNames(summaryField)
              const mindPresets = presetNames(mindField)
              out.summaryPresetCount = summaryPresets.filter((t) =>
                ['简洁明了', '活泼俏皮', '文艺诗意', '正式稳重'].includes(t),
              ).length
              out.mindPresetCount = mindPresets.filter((t) =>
                ['俏皮猫娘', '温柔贴心', '高冷克制', '知性风趣'].includes(t),
              ).length
              // 自定义输入框(≤100 字,两个区各一个)
              out.subAgentCustomInputs = view.querySelectorAll('.island-agent-field input[maxlength="100"]').length
              // 选预设 → 按钮高亮;输入自定义 → 预设取消高亮(输入即切换)
              const literary = summaryField ? [...summaryField.querySelectorAll('.island-agent-scale-btn')].find((b) => b.textContent.trim() === '文艺诗意') : null
              literary?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(250)
              out.summaryPresetSelected = literary?.classList.contains('on') ?? false
              const summaryInput = view.querySelector('.island-agent-field input[maxlength="100"]')
              if (summaryInput) {
                const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
                setter.call(summaryInput, '自定义测试文风')
                summaryInput.dispatchEvent(new Event('input', { bubbles: true }))
                await sleep(250)
                out.summaryCustomActive = !literary?.classList.contains('on')
                // 恢复默认(防保存污染用户配置;restore 双保险)
                summaryField?.querySelector('.island-agent-scale-btn')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
                await sleep(200)
              }

              // ---- 保存 ----
              const saveBtn = btnByText('保存配置')
              await scrollInto(saveBtn)
              saveBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(400)
              out.saved = (view.querySelector('.island-save-label')?.textContent ?? '').includes('已保存')

              // ---- 返回 → 设置 → 收起 ----
              const backBtn = view.querySelector('.island-bg-back')
              backBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(400)
              out.backToSettings = !!document.querySelector('.island-settings-items')
              document.querySelector('.island-panel-list:has(.island-settings-items) .island-bg-back')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(900)
              out.collapsed = !document.querySelector('.island-demo').classList.contains('expanded')
              return JSON.stringify(out)
            })()`)
            console.log('[widget] agent-interact:', interactResult)
            // 段 2.5:技能同步与三区——模拟 LLM 创建(无标记 → 灵动岛创建区)
            // 与手动导入(带 .island-imported 标记 → 手动导入区),重进设置立即可见
            const syncSkillDir = path.join(app.getPath('userData'), 'skills', 'ui-sync-test')
            const impSkillDir = path.join(app.getPath('userData'), 'skills', 'ui-import-test')
            try {
              fs.mkdirSync(syncSkillDir, { recursive: true })
              fs.writeFileSync(
                path.join(syncSkillDir, 'SKILL.md'),
                '---\nname: ui-sync-test\ndescription: UI 同步验证技能\n---\n\n# Sync Test\n\n步骤 1\n',
                'utf8',
              )
              fs.mkdirSync(impSkillDir, { recursive: true })
              fs.writeFileSync(
                path.join(impSkillDir, 'SKILL.md'),
                '---\nname: ui-import-test\ndescription: UI 导入验证技能\n---\n\n# Import Test\n\n步骤 1\n',
                'utf8',
              )
              fs.writeFileSync(path.join(impSkillDir, '.island-imported'), 'imported by user\n')
            } catch (err) {
              console.error('[widget] sync skill write failed:', err)
            }
            // 收起 → 重新打开设置 → Agent 设置
            win.webContents.send('widget:open-settings')
            await new Promise((r) => setTimeout(r, 800))
            const syncResult = await win.webContents.executeJavaScript(`(async () => {
              const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
              const settingsItem = (text) =>
                [...document.querySelectorAll('.island-settings-item')].find((s) => s.textContent.includes(text))
              settingsItem('Agent 设置')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(600)
              const rows = [...document.querySelectorAll('.island-skills-registered > .island-skills-reg-row')]
              const out = { skillRows: rows.length }
              out.syncSkillShown = rows.some((r) => r.textContent.includes('ui-sync-test'))
              // 分区:自己创建的技能进入"自己创建"区(不在"扫描到的"区)
              const regCounts = [...document.querySelectorAll('.island-skills-reg-count')].map((c) => c.textContent)
              out.createdCount = regCounts.find((c) => c.includes('灵动岛创建')) ?? '(无创建区)'
              out.importedCount = regCounts.find((c) => c.includes('手动导入')) ?? '(无导入区)'
              out.scannedCount = regCounts.find((c) => c.includes('扫描到的')) ?? '(无扫描区)'
              out.createdRowShown = !!document.querySelector('.island-skills-registered > .island-skills-reg-row')
                ?.textContent.includes('ui-sync-test')
              out.importedRowShown = [...document.querySelectorAll('.island-skills-registered > .island-skills-reg-row')]
                .some((r) => r.textContent.includes('ui-import-test'))
              // 收起:当前在 agent-settings 视图(设置类,屏蔽长按)→
              // 先返回设置视图,再返回收起(否则段 3 长按被屏蔽,输入框找不到)
              document
                .querySelector('.island-agent-settings .island-bg-back')
                ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(400)
              document
                .querySelector('.island-panel-list:has(.island-settings-items) .island-bg-back')
                ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(900)
              return JSON.stringify(out)
            })()`)
            console.log('[widget] agent-skill-sync:', syncResult)
            // 删除测试技能文件(用户数据零残留)
            try {
              fs.rmSync(path.join(app.getPath('userData'), 'skills', 'ui-sync-test'), { recursive: true, force: true })
              fs.rmSync(path.join(app.getPath('userData'), 'skills', 'ui-import-test'), { recursive: true, force: true })
            } catch {
              // 忽略
            }
            // 段 3:聊天输入框的 / 与 @ 候选列表(切 Agent 模式 → 长按展开
            // → 输入前缀 → 断言技能/MCP 候选、过滤、Enter 选中、Esc 关闭)
            win.webContents.send('widget:set-mode', { mode: 'agent', source: 'user' })
            await new Promise((r) => setTimeout(r, 600))
            const suggestResult = await win.webContents.executeJavaScript(`(async () => {
              const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
              const out = {}
              try {
              // 段 3 主体(包 try:抛错时返回错误详情,不中断整轮巡检)

              const island = document.querySelector('.island-demo')
              // 长按展开(Agent 模式紧凑态长按展开)
              const r = island.getBoundingClientRect()
              const x = r.left + r.width / 2
              const y = r.top + r.height / 2
              island.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y, pointerId: 1, isPrimary: true, button: 0 }))
              setTimeout(() => island.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x, clientY: y, pointerId: 1, isPrimary: true, button: 0 })), 600)
              // 2026-08-11:400% 缩放下软件渲染展开慢,1100ms 不够(诊断
              // 读到 56px 紧凑态),加长到 2500ms
              await sleep(2500)
              out.expanded = island.classList.contains('expanded')
              const ta = document.querySelector('.island-agent-input textarea')
              out.inputShown = !!ta
              // 调试:展开后面板实际视图
              out.settingsShown = !!document.querySelector('.island-settings-items')
              out.agentViewShown = !!document.querySelector('.island-agent-view')
              out.panelHtml = document.querySelector('.island-panel')?.className ?? '(无面板)'
              out.panelContent = (document.querySelector('.island-panel')?.innerHTML ?? '').replace(/<[^>]+>/g, ' ').trim().slice(0, 120)
              // 2026-08-11 临时诊断:新对话高度(0 消息应矮小,不乘缩放)
              out.agentHVar = island.style.getPropertyValue('--agent-h') || '(空)'
              out.agentScaleVar = island.style.getPropertyValue('--agent-s') || '(空)'
              out.islandRectH = Math.round(island.getBoundingClientRect().height)
              out.islandRectW = Math.round(island.getBoundingClientRect().width)
              out.winH = window.innerHeight
              out.msgCount = document.querySelectorAll('.island-agent-msg-assistant, .island-agent-msg-user').length
              if (!ta) return JSON.stringify(out)
              const setVal = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
              const type = async (v) => {
                setVal.call(ta, v)
                ta.dispatchEvent(new Event('input', { bubbles: true }))
                await sleep(250)
              }
              // 输入 '/':候选列表应列出**全部**技能(不截断;用户技能
              // 远多于 6 个,超高滚动)
              await type('/')
              const items = () => [...document.querySelectorAll('.island-agent-suggest-item')]
              const suggestBox = () => document.querySelector('.island-agent-suggest')
              out.suggestSlashCount = items().length
              out.suggestSlashTexts = items().map((i) => i.querySelector('.island-agent-suggest-cmd')?.textContent).slice(0, 4)
              out.skillListed = items().some((i) => i.textContent.includes('skill_'))
              out.skillsAllListed = items().length >= 8
              // 候选列表高度跟随岛体:200px 岛体时列表可视高应远小于
              // 全展开(~192px),且超高可滚动
              if (suggestBox()) {
                out.suggestBoxH = suggestBox().clientHeight
                out.suggestScrollable = suggestBox().scrollHeight > suggestBox().clientHeight + 2
              }
              // 输入 '/darwin':过滤出 darwin 技能
              await type('/darwin')
              const filtered = items()
              out.suggestFiltered = filtered.length
              out.filterMatches = filtered.length > 0 && filtered.every((i) => i.textContent.includes('darwin'))
              // 输入 '@':MCP 候选(siyuan 服务若连接成功;内置 mcp_config 应排除)
              await type('@')
              const atItems = items()
              out.suggestAtCount = atItems.length
              out.atTexts = atItems.map((i) => i.querySelector('.island-agent-suggest-cmd')?.textContent).slice(0, 4)
              out.mcpConfigExcluded = !atItems.some((i) => i.textContent.includes('@mcp_config'))
              // Enter 选中第一个候选(不发送)
              const firstCmd = atItems[0]?.querySelector('.island-agent-suggest-cmd')?.textContent ?? ''
              ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
              await sleep(250)
              out.afterEnter = ta.value.slice(0, 50)
              out.enterApplied = ta.value === firstCmd
              // Esc 关闭候选(收起动画:160 + 卡片数×30ms 后卸载,等足)
              await type('/darwin')
              ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
              await sleep(200)
              out.escClosing = document.querySelector('.island-agent-suggest.closing') !== null
              await sleep(700)
              out.escClosed = items().length === 0
              return JSON.stringify(out)
              } catch (err) {
                return JSON.stringify({ fatal: String((err && err.stack) || err) })
              }
            })()`)
            console.log('[widget] agent-suggest:', suggestResult)
            // 段 4:工具列表预览框(岛体高度由聊天驱动,列表滚动)
            // 2026-08-09:executeJavaScript 曾在此处 "Script failed to
            // execute"(段内 try 未接住)——包一层保护,失败打出错误详情
            // + 渲染进程状态,不中断整轮巡检
            let toolsResult = 'EXEC_NOT_RUN'
            try {
            toolsResult = await win.webContents.executeJavaScript(`(async () => {
              const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
              const out = {}
              try {
              // 段 4 主体(包 try:抛错时返回错误详情,不中断整轮巡检)
              const island = document.querySelector('.island-demo')
              const panel = document.querySelector('.island-agent-view')
              out.islandHBefore = island?.offsetHeight ?? 0
              // 清空输入框(候选测试残留),打开 ⋯ 菜单 → 工具列表
              const ta = document.querySelector('.island-agent-input textarea')
              if (ta) {
                const setVal = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
                setVal.call(ta, '')
                ta.dispatchEvent(new Event('input', { bubbles: true }))
              }
              await sleep(200)
              // 2026-08-07 重构:⋯ 菜单 = 通用 QuickMenu(悬浮展开 + 点击菜单项)
              const headMenu = () => document.querySelector('.island-agent-head .island-quick-menu')
              headMenu()?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: null }))
              await sleep(300)
              const toolsItem = [...document.querySelectorAll('.island-agent-head .island-quick-menu-item')].find((b) => b.textContent.includes('工具列表'))
              toolsItem?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(500)
              const list = document.querySelector('.island-agent-history-list')
              out.toolsListShown = !!list
              out.islandHAfter = island?.offsetHeight ?? 0
              // 高度未撑大:进入 tools 前后岛体高度基本一致(聊天高度驱动)
              out.heightStable = Math.abs((island?.offsetHeight ?? 0) - out.islandHBefore) < 40
              if (list) {
                out.listScrollable = list.scrollHeight > list.clientHeight + 4
                out.listClientH = list.clientHeight
                out.listScrollH = list.scrollHeight
                // 滚动生效:滚到底再回顶
                list.scrollTop = list.scrollHeight
                await sleep(150)
                out.scrolledDown = list.scrollTop > 0
                list.scrollTop = 0
              }
              // 返回对话(切回 chat 应重测高度)
              document.querySelector('.island-agent-history-back')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(500)
              out.backToChat = !!document.querySelector('.island-agent-input textarea')
              // 对话历史视图:与工具列表相同设计(岛体高度保持,列表滚动)。
              // 2026-08-07 重构:⋯ 菜单 = 通用 QuickMenu(悬浮展开 + 点击菜单项)
              // 2026-08-09 修复:headMenu 在上方工具列表段已声明,同作用域
              // 重复 const = 语法错误 → executeJavaScript 整段 reject
              // ("Script failed to execute",内部 try 接不住解析错误)
              const hBefore = island?.offsetHeight ?? 0
              const headMenu2 = () => document.querySelector('.island-agent-head .island-quick-menu')
              headMenu2()?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: null }))
              await sleep(300)
              const histItem = [...document.querySelectorAll('.island-agent-head .island-quick-menu-item')].find((b) => b.textContent.includes('对话历史'))
              histItem?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(500)
              const hList = document.querySelector('.island-agent-history-list')
              out.historyListShown = !!hList
              out.historyHeightStable = Math.abs((island?.offsetHeight ?? 0) - hBefore) < 40
              out.historyScrollable = hList ? hList.scrollHeight > hList.clientHeight + 4 : false
              return JSON.stringify(out)
              } catch (err) {
                return JSON.stringify({ fatal: String((err && err.stack) || err) })
              }
            })()`)
            } catch (execErr) {
              toolsResult =
                'EXEC_ERR:' +
                String((execErr && execErr.stack) || execErr) +
                ' | destroyed:' +
                win.isDestroyed() +
                ' | crashed:' +
                win.webContents.isCrashed() +
                ' | url:' +
                win.webContents.getURL()
            }
            console.log('[widget] agent-tools-preview:', toolsResult)
            // 段 4.5:右上角快捷菜单(2026-08-07 重构:通用 QuickMenu
            // 取代 ⋯ 弹出菜单与悬浮快捷按钮——整合按钮**默认"新对话"**,
            // 悬浮展开菜单项,滚轮逐格循环切换,单击菜单项执行)。
            // 合成事件即可驱动(QuickMenu 的 onMouseEnter/onWheel/onClick
            // 都是 React 事件,mouseover 模拟悬浮——段 2 switchTab 同款)
            {
              // 段 4 末停在对话历史视图:先返回聊天(快捷菜单只在聊天视图头部)
              await win.webContents.executeJavaScript(`(() => {
                document.querySelector('.island-agent-history-back')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              })()`)
              await new Promise((r) => setTimeout(r, 500))
              const probe = () =>
                win.webContents.executeJavaScript(`(() => {
                  const menu = document.querySelector('.island-agent-head .island-quick-menu')
                  const btn = menu?.querySelector('.island-quick-menu-btn')
                  const label =
                    btn?.querySelector('.island-wheel-swap-in')?.textContent?.trim() ??
                    btn?.textContent ??
                    '(无)'
                  return {
                    menuShown: !!menu,
                    label,
                    open: menu?.classList.contains('open') ?? false,
                    itemCount: menu?.querySelectorAll('.island-quick-menu-item').length ?? 0,
                    items: [...(menu?.querySelectorAll('.island-quick-menu-item') ?? [])].map((i) => i.textContent.trim()),
                  }
                })()`)
              const init = await probe()
              console.log('[widget] agent-quick-init:', JSON.stringify(init))
              // 悬浮展开(合成 mouseover 触发 React onMouseEnter)
              await win.webContents.executeJavaScript(`(() => {
                document.querySelector('.island-agent-head .island-quick-menu')
                  ?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: null }))
              })()`)
              await new Promise((r) => setTimeout(r, 400))
              const hover = await probe()
              console.log('[widget] agent-quick-hover:', JSON.stringify(hover))
              // 截图:悬浮展开态
              const quickImg = await win.webContents.capturePage()
              fs.writeFileSync(process.env.WIDGET_SCREENSHOT + '.agent-quick.png', quickImg.toPNG())
              console.log('[widget] screenshot(agent-quick hover) saved')
              // 滚轮逐格:正向一格(默认"新对话" → 下一项;DOM 推断期望序列)
              const items = hover.items
              const defIdx = Math.max(0, items.indexOf('新对话'))
              const fwdIdx = (defIdx + 1) % items.length
              const sendWheel = async (deltaY) => {
                await win.webContents.executeJavaScript(`(() => {
                  document.querySelector('.island-agent-head .island-quick-menu')
                    ?.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: ${deltaY} }))
                })()`)
                await new Promise((r) => setTimeout(r, 300))
                return probe()
              }
              const s1 = await sendWheel(120)
              console.log(
                '[widget] agent-quick-fwd:',
                JSON.stringify({ ...s1, expect: items[fwdIdx], ok: s1.label === items[fwdIdx] }),
              )
              const s2 = await sendWheel(-120)
              console.log(
                '[widget] agent-quick-bwd:',
                JSON.stringify({ ...s2, expect: items[defIdx], ok: s2.label === items[defIdx] }),
              )
              // 滚轮切到"对话历史"并单击菜单项 → 进入历史视图
              const toHistory = (items.indexOf('对话历史') - defIdx + items.length) % items.length
              let s3 = s2
              for (let i = 0; i < toHistory; i++) s3 = await sendWheel(120)
              console.log(
                '[widget] agent-quick-to-history:',
                JSON.stringify({ ...s3, expect: '对话历史', ok: s3.label === '对话历史' }),
              )
              if (s3.label === '对话历史') {
                await win.webContents.executeJavaScript(`(() => {
                  const item = [...document.querySelectorAll('.island-agent-head .island-quick-menu-item')].find((b) => b.textContent.includes('对话历史'))
                  item?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
                })()`)
                await new Promise((r) => setTimeout(r, 700))
                const q5 = await win.webContents.executeJavaScript(`(() => ({
                  historyShown: !!document.querySelector('.island-agent-history-list'),
                  backBtn: !!document.querySelector('.island-agent-history-back'),
                  chatGone: !document.querySelector('.island-agent-input textarea'),
                }))()`)
                console.log('[widget] agent-quick-click:', JSON.stringify(q5))
              } else {
                console.log('[widget] agent-quick-click: skipped(滚轮步进未达预期)')
              }
              // 返回对话(后续段 5 需要聊天视图)
              await win.webContents.executeJavaScript(`(() => {
                document.querySelector('.island-agent-history-back')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              })()`)
              await new Promise((r) => setTimeout(r, 500))
            }
            // 段 4.6:工具列表视图(搜索 / 禁用 / 禁用区 / 恢复,动画)。
            // 从聊天视图 ⋯ 菜单进工具列表,合成事件驱动(React 受控输入
            // 用原生 value setter;禁用/恢复先播离场动画再提交,等足 300ms)
            {
              const toolsResult = await win.webContents.executeJavaScript(`(async () => {
                const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
                const out = {}
                // 2026-08-07 重构:⋯ 菜单 = 通用 QuickMenu(悬浮展开 + 点击菜单项)
                const headMenu = () => document.querySelector('.island-agent-head .island-quick-menu')
                headMenu()?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: null }))
                await sleep(300)
                const toolsItem = [...document.querySelectorAll('.island-agent-head .island-quick-menu-item')].find((b) => b.textContent.includes('工具列表'))
                toolsItem?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
                await sleep(500)
                const list = document.querySelector('.island-agent-history-list')
                out.toolsShown = !!list
                // 搜索框:输入过滤(受控输入原生 setter + input 事件)
                const search = document.querySelector('.island-tools-search input')
                out.searchShown = !!search
                const rows = () => [...(list?.querySelectorAll('.island-agent-tools-item') ?? [])]
                out.rowsBefore = rows().length
                if (search) {
                  const setVal = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
                  const target = rows()[0]?.querySelector('.island-agent-tools-name')?.textContent ?? ''
                  setVal.call(search, target.slice(0, Math.max(1, Math.floor(target.length / 2))))
                  search.dispatchEvent(new Event('input', { bubbles: true }))
                  await sleep(300)
                  out.rowsAfterFilter = rows().length
                  out.filterWorked = rows().length > 0 && rows().length <= out.rowsBefore
                  setVal.call(search, '')
                  search.dispatchEvent(new Event('input', { bubbles: true }))
                  await sleep(200)
                }
                // 禁用第一个工具:离场动画(0.24s)+ 移入禁用区(入场动画)
                const first = rows()[0]
                const firstName = first?.querySelector('.island-agent-tools-name')?.textContent ?? ''
                const disableBtn = first?.querySelector('.island-tools-disable')
                await sleep(200)
                disableBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
                await sleep(120)
                out.disableLeaving = !!first?.classList.contains('island-ui-leave')
                await sleep(400)
                const excludedRows = () => [...(list?.querySelectorAll('.island-tools-excluded-row') ?? [])]
                const excludedNames = excludedRows().map((r) => r.querySelector('.island-tools-excluded-name')?.textContent)
                out.excludedSection = !!list?.querySelector('.island-tools-excluded')
                out.disabledName = excludedNames[0] ?? '(无)'
                out.disableMoved = excludedNames.includes(firstName)
                out.enteringInExcluded = excludedRows()[0]?.classList.contains('island-ui-enter') ?? false
                // 恢复:同样先离场再回到可用区
                const restoreBtn = excludedRows()[0]?.querySelector('.island-tools-restore')
                await sleep(200)
                restoreBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
                await sleep(400)
                out.restoreBack = rows().some((r) => r.querySelector('.island-agent-tools-name')?.textContent === firstName)
                out.excludedEmpty = excludedRows().length === 0
                return JSON.stringify(out)
              })()`)
              console.log('[widget] agent-tools-actions:', toolsResult)
              // 返回对话(后续段 5 需要聊天视图)
              await win.webContents.executeJavaScript(`(() => {
                document.querySelector('.island-agent-history-back')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              })()`)
              await new Promise((r) => setTimeout(r, 500))
            }
            // 段 4.7:灵动岛设置工具端到端(设置桥 → 存储 → 事件 → UI 即时生效)。
            // 直接调主进程 runIslandSettings(与引擎设置工具同一条链路,绕开
            // LLM 调度保证确定性):主题色 / 缩放 / 背景导入+改名 / 字体导入
            // +改名,断言 UI 即时生效(--state-color / 岛宽比例 / 库条目)。
            // 前后状态备份,结束后恢复(不残留用户数据);IndexedDB 背景槽位
            // 用原生事务读写(桥未暴露槽位读取)
            {
              const js = (code) => win.webContents.executeJavaScript(code)
              const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
              const out = {}
              // IndexedDB 背景库槽位读写('island-background' v2,store 'bg';
              // put null = 清空槽位,加载器按 typeof string 判定)
              const bgSlotJs = (slot, op, value) => `(async () => {
                const db = await new Promise((res, rej) => {
                  const r = indexedDB.open('island-background', 2)
                  r.onsuccess = () => res(r.result)
                  r.onerror = () => rej(r.error)
                })
                return await new Promise((res) => {
                  const tx = db.transaction('bg', '${op === 'get' ? 'readonly' : 'readwrite'}')
                  const req = ${op === 'get'
                    ? `tx.objectStore('bg').get(${JSON.stringify(slot)})`
                    : `tx.objectStore('bg').put(${JSON.stringify(value)}, ${JSON.stringify(slot)})`}
                  req.onsuccess = () => res(typeof req.result === 'string' ? req.result : null)
                  req.onerror = () => res(null)
                })
              })()`
              // 备份:localStorage 设置项 + 背景双槽位图片(恢复时写回)
              const backup = {
                theme: await js(`localStorage.getItem('widget-theme-color')`),
                scale: await js(`localStorage.getItem('widget-agent-scale')`),
                bgParams: await js(`localStorage.getItem('widget-background')`),
                fontSettings: await js(`localStorage.getItem('widget-font')`),
                bgExpanded: await js(bgSlotJs('expanded', 'get')),
                bgCompact: await js(bgSlotJs('compact', 'get')),
              }
              const TEST_PNG =
                'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
              try {
                // 1. 主题色:写存储 → 事件 → --state-color 即时生效
                await runIslandSettings('setThemeColor', ['#f87171'])
                await sleep(500)
                out.themeApplied = await js(
                  `document.querySelector('.island-demo').style.getPropertyValue('--state-color') === '#f87171'`,
                )
                // 2. 缩放:岛宽按比例即时变化(当前缩放 A → 150)
                const scaleBefore = Number((await js(`localStorage.getItem('widget-agent-scale')`)) ?? '200') || 200
                const widthBefore = await js(`document.querySelector('.island-demo').offsetWidth`)
                await runIslandSettings('setAgentScale', [150])
                await sleep(500)
                const scaleAfter = await js(`localStorage.getItem('widget-agent-scale')`)
                const widthAfter = await js(`document.querySelector('.island-demo').offsetWidth`)
                out.scaleStored = scaleAfter
                out.scaleRatioOk =
                  Math.abs(widthAfter - Math.round((widthBefore * 150) / scaleBefore)) < 10
                out.scaleDebug = JSON.stringify({ scaleBefore, widthBefore, widthAfter })
                // 3. 背景导入 + 改名:导入(双槽位应用 + 入库)→ 改名 → 断言
                const imgRes = await runIslandSettings('importBackground', [TEST_PNG, '巡检测试背景'])
                await sleep(500)
                // --bg-img-e 设置在 .island-bg-image 子元素上(背景层),
                // 不在 .island-demo 主元素(实测断言选择器踩坑)
                const bgVar = await js(
                  `document.querySelector('.island-bg-image')?.style.getPropertyValue('--bg-img-e') ?? '(无背景层)'`,
                )
                out.bgApplied = typeof bgVar === 'string' && bgVar.startsWith('url("data:image/png')
                const imgs = (await runIslandSettings('listLibraryImages', [])) ?? []
                out.bgInLibrary = imgs.some((i) => i.id === imgRes.id && i.name === '巡检测试背景')
                await runIslandSettings('renameLibraryImage', [imgRes.id, '巡检测试背景-改名'])
                await sleep(300)
                const imgs2 = (await runIslandSettings('listLibraryImages', [])) ?? []
                out.bgRenamed = imgs2.some((i) => i.id === imgRes.id && i.name === '巡检测试背景-改名')
                // 4. 字体导入 + 改名:入库并应用为当前字体
                const fontRes = await runIslandSettings('importFont', [
                  'data:font/ttf;base64,QUFBQUFBQUE=',
                  '巡检测试字体',
                ])
                await sleep(400)
                const fontSettings = await js(`localStorage.getItem('widget-font')`)
                out.fontApplied = typeof fontSettings === 'string' && fontSettings.includes(fontRes.id)
                const fonts = (await runIslandSettings('listFonts', [])) ?? []
                out.fontInLibrary = fonts.some((f) => f.id === fontRes.id)
                await runIslandSettings('renameFont', [fontRes.id, '巡检测试字体-改名'])
                await sleep(300)
                const fonts2 = (await runIslandSettings('listFonts', [])) ?? []
                out.fontRenamed = fonts2.some((f) => f.id === fontRes.id && f.name === '巡检测试字体-改名')
                // 5. 非法操作拒绝:不存在的图片 id 改名应报错
                let renamedError = ''
                try {
                  await runIslandSettings('renameLibraryImage', ['i-not-exist', 'x'])
                } catch (err) {
                  renamedError = (err && err.message) || String(err)
                }
                out.renameInvalidRejected = renamedError.includes('图片不存在')
              } catch (err) {
                out.error = String((err && err.stack) || err)
                console.error('[widget] agent-settings-tools failed:', err)
              } finally {
                // 恢复用户数据:localStorage 设置项(缺失的 removeItem)
                const setOrRemove = (key, value) =>
                  value === null
                    ? js(`localStorage.removeItem(${JSON.stringify(key)})`)
                    : js(`localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})`)
                await setOrRemove('widget-theme-color', backup.theme)
                await setOrRemove('widget-agent-scale', backup.scale)
                await setOrRemove('widget-background', backup.bgParams)
                await setOrRemove('widget-font', backup.fontSettings)
                // 背景槽位恢复原图(原无则清空)
                await js(bgSlotJs('expanded', 'put', backup.bgExpanded))
                await js(bgSlotJs('compact', 'put', backup.bgCompact))
                // 删除测试入库条目(图片/字体;按「巡检测试」名前缀定位)
                const imgs3 = (await runIslandSettings('listLibraryImages', []).catch(() => [])) ?? []
                for (const img of imgs3) {
                  if (String(img.name).startsWith('巡检测试')) {
                    await runIslandSettings('deleteLibraryImage', [img.id]).catch(() => {})
                  }
                }
                const fonts3 = (await runIslandSettings('listFonts', []).catch(() => [])) ?? []
                for (const f of fonts3) {
                  if (String(f.name).startsWith('巡检测试')) {
                    await runIslandSettings('deleteFontItem', [f.id]).catch(() => {})
                  }
                }
                // 恢复后的存储重读(恢复走原生 js 写,未触发桥事件;手动补发)
                await js(
                  `window.dispatchEvent(new CustomEvent('island-settings-changed', { detail: { scopes: ['theme','scale','font','background','imageLibrary'] } }))`,
                )
                await sleep(400)
              }
              console.log('[widget] agent-settings-tools:', JSON.stringify(out))
            }
            // 段 4.8:主动陪伴(2026-08-07)。注入主动消息事件 → 助手气泡
            // 落定;直接调主进程 **runProactiveGuess**(onEvent 钩子的具名
            // 抽取,巡检绕开引擎事件链路的确定性测试,同 runIslandSettings
            // 先例)——真实 LLM 心理揣测(巡检环境有真实 API Key,同段 5)
            // → ① **Windows 系统通知**(临时 stub Notification.prototype
            // .show 捕获)② mind-proactive 事件 → 紧凑态文字区(localStorage
            // widget-agent-mind)与通知同一句。注入文本必须 ≤10 字:段 5
            // 以"末条 assistant 文本 >10 字"判定自动回复,防误判。不 reload
            // (段 5 依赖展开的聊天视图);备份恢复三键,不残留。
            // 注意:不能靠注入 agent:event 触发主进程钩子——测试的注入
            // 直接走 webContents.send 到渲染端,绕过 main.cjs onEvent(实测)
            console.log('[widget] 段4.8 开始:主动陪伴(真实 LLM 揣测 + 主动回合,最长 ~5 分钟,窗口可能静止属正常)')
            {
              const js = (code) => win.webContents.executeJavaScript(code)
              const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
              const out = {}
              // 长轮询进度日志(2026-08-09 用户报告"巡检最后一直卡住,无可视操作":
              // 段 4.8/4.9 是真实 LLM 调用 + 静默轮询,最坏合计 6-8 分钟无输出——
              // 每 10s 打一条等待进度,证明巡检在动)
              const logEvery = (t0, limitMs, what) => {
                const el = Math.round((Date.now() - t0) / 1000)
                if (el % 10 === 0) {
                  console.log(`[widget] 段4.8 ${what}: ${el}s/${Math.round(limitMs / 1000)}s …`)
                }
              }
              const backup = {
                messages: await js(`localStorage.getItem('widget-agent-messages')`),
                mind: await js(`localStorage.getItem('widget-agent-mind')`),
                sessions: await js(`localStorage.getItem('widget-agent-sessions')`),
              }
              // 临时 stub 系统通知(捕获 title/body;段末 restore,不弹真实
              // 通知;主进程 require('electron').Notification 的实例方法)
              const { Notification: ElectronNotification } = require('electron')
              const origShow = ElectronNotification.prototype.show
              const captured = []
              ElectronNotification.prototype.show = function () {
                captured.push({ title: this.title, body: this.body })
                return this
              }
              try {
                // 1. 注入主动消息(完整落定,proactive 标记;text ≤10 字)
                const proactiveMessage = {
                  id: 'proactive-test-1',
                  role: 'assistant',
                  parts: [{ type: 'text', text: '在呢' }],
                  proactive: true,
                }
                win.webContents.send('agent:event', {
                  type: 'message',
                  message: proactiveMessage,
                  usage: { input: 1, output: 1 },
                })
                await sleep(800)
                const bubble = await js(`(() => {
                  const msgs = document.querySelectorAll('.island-agent-msg-assistant')
                  const last = msgs[msgs.length - 1]
                  return JSON.stringify({ count: msgs.length, lastText: last?.textContent ?? '' })
                })()`)
                out.bubble = JSON.parse(bubble)
                // 2. 直接调主进程主动揣测(与引擎 onEvent 钩子同一函数):
                // 真实 LLM,最长 ~70s 含重试。**不能轮询 localStorage 判断
                // 完成**——widget-agent-mind 跨运行持久化,残留旧值非空
                // 会立即返回,断言全部落空(实测坑)
                console.log('[widget] 段4.8 心理揣测(真实 LLM,最长 ~70s)…')
                const guessT0 = Date.now()
                const g = await runProactiveGuess(proactiveMessage)
                console.log(`[widget] 段4.8 揣测完成: ${Math.round((Date.now() - guessT0) / 1000)}s,结果: ${g ? g.slice(0, 30) : '(空)'}`)
                // 事件与通知同一 .then 发出;再多等一会儿让渲染端
                // setMindGuess → 持久化 effect 落盘 localStorage
                await sleep(1500)
                const mind = await js(`localStorage.getItem('widget-agent-mind')`)
                out.mind = mind
                out.capturedNotifications = captured
                // 3. 断言:气泡落定 + 系统通知弹出 + 文字区与通知同一句
                out.guessReturned = typeof g === 'string' && g.length > 0
                out.bubbleLanded = out.bubble.count >= 1 && String(out.bubble.lastText).includes('在呢')
                out.notificationShown = captured.length >= 1 && captured.some((n) => n.body && n.body.trim())
                out.mindMatchesNotification = !!mind && captured.some((n) => n.body === mind)
                out.mindPersisted = !!mind
                // 4. 真实主动回合端到端(2026-08-07):引擎 proactiveTurn
                // 走完整链路——思考/流式/工具 → 消息落定(带 proactive
                // 标记)→ 渲染端气泡 → 主进程钩子 → 揣测通知 + 事件。
                // judge 不是本段职责(单测 parseJudgeJson 覆盖),直接调
                // 回合;真实 LLM 回复,最长 ~90s
                const bubbleBefore = out.bubble.count
                console.log('[widget] 段4.8 主动回合(真实 LLM,最长 ~120s)…')
                startProactiveTurn([proactiveMessage], { hint: '巡检测试' })
                // 回合落定轮询放主进程打进度(原渲染端 while 内联循环静默 120s)
                const turnT0 = Date.now()
                const turnDeadline = Date.now() + 120000
                let realBubble = { landed: false }
                while (Date.now() < turnDeadline) {
                  const st = await js(`(() => {
                    const msgs = document.querySelectorAll('.island-agent-msg-assistant')
                    const last = msgs[msgs.length - 1]
                    return JSON.stringify({ count: msgs.length, text: (last?.textContent ?? '').slice(0, 80) })
                  })()`)
                  const s = JSON.parse(st)
                  logEvery(turnT0, 120000, `等待主动回合落定(助手气泡 ${s.count} 条)`)
                  if (s.count > bubbleBefore && !s.text.includes('在呢')) {
                    realBubble = { landed: true, text: s.text }
                    break
                  }
                  await sleep(2000)
                }
                console.log(`[widget] 段4.8 回合结果: ${realBubble.landed ? '落定' : '超时未落定'}(${Math.round((Date.now() - turnT0) / 1000)}s)`)
                out.realTurnLanded = realBubble.landed
                out.realTurnText = realBubble.text ?? ''
                // 回合落定后主进程钩子自动跑揣测 → 第二条系统通知
                // (与回合消息同链,最长 ~70s)
                const realNoticeDeadline = Date.now() + 70000
                const noticeT0 = Date.now()
                while (Date.now() < realNoticeDeadline && captured.length < 2) {
                  logEvery(noticeT0, 70000, `等待第 2 条揣测通知(已捕获 ${captured.length}/2)`)
                  await sleep(2000)
                }
                const mindAfterReal = await js(`localStorage.getItem('widget-agent-mind')`)
                out.realNotificationShown = captured.length >= 2
                out.realMindMatches =
                  !!mindAfterReal && captured.slice(1).some((n) => n.body === mindAfterReal)
              } catch (err) {
                out.error = String((err && err.stack) || err)
                console.error('[widget] agent-proactive failed:', err)
              } finally {
                ElectronNotification.prototype.show = origShow
                // 恢复用户数据(缺失的 removeItem;不 reload——段 5 依赖
                // 展开的聊天视图,React 内存 state 由后续段自行覆盖)
                const setOrRemove = (key, value) =>
                  value === null
                    ? js(`localStorage.removeItem(${JSON.stringify(key)})`)
                    : js(`localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})`)
                await setOrRemove('widget-agent-messages', backup.messages)
                await setOrRemove('widget-agent-mind', backup.mind)
                await setOrRemove('widget-agent-sessions', backup.sessions)
              }
              console.log('[widget] agent-proactive:', JSON.stringify(out))
            }
            // 渲染端自动 send → LLM 主动回复,真实 API)
            await win.webContents.executeJavaScript(`(async () => {
              const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
              const before = document.querySelectorAll('.island-agent-msg-assistant').length
              return JSON.stringify({ before })
            })()`)
            win.webContents.send('agent:event', {
              type: 'background-done',
              title: 'B站下载完成',
              message: '视频《测试视频》已完成,输出目录 C:/test/downloads',
            })
            await new Promise((r) => setTimeout(r, 4000))
            const eventDebug = await win.webContents.executeJavaScript(`(() => {
              return JSON.stringify({
                userCount: document.querySelectorAll('.island-agent-msg-user').length,
                errorText: document.querySelector('.island-agent-error')?.textContent ?? '(无错误)',
                statusText: document.querySelector('.island-agent-head')?.textContent?.slice(0, 40) ?? '(无头部)',
              })
            })()`)
            console.log('[widget] agent-auto-reply-debug:', eventDebug)
            // 轮询:LLM 应自动回复(存在文本非空的助手消息;刚初始化可能
            // 只有 1 条回复,不能按"数量增长"判断——debug 已确认回复
            // 数秒内完成,此时轮询才启动,startCount 早已是 1)
            const autoReply = await win.webContents.executeJavaScript(`(async () => {
              const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
              const deadline = Date.now() + 60000
              while (Date.now() < deadline) {
                const msgs = document.querySelectorAll('.island-agent-msg-assistant')
                const last = msgs[msgs.length - 1]
                const text = last?.textContent ?? ''
                if (text.length > 10 && !text.includes('正在思考') && !text.includes('【系统通知】')) {
                  return JSON.stringify({ replied: true, count: msgs.length, text: text.slice(0, 120) })
                }
                await sleep(2000)
              }
              return JSON.stringify({ replied: false, count: document.querySelectorAll('.island-agent-msg-assistant').length })
            })()`)
            console.log('[widget] agent-auto-reply:', autoReply)
            // 段 4.9:主动陪伴 **10 秒真实调度链路**(2026-08-07 优化,
            // 用户要求"测试主动陪伴时,间隔时间改为 10 秒")。配置间隔 10 秒
            // (agentSetConfig)→ 进 agent-settings 视图触发 useAgent onRefresh
            // (config 重读)→ 返回并长按展开回聊天 → 渲染端调度器(60s 周期
            // 检查,idle > 10s)发 tick → 总结 Sub Agent 判断(真实 LLM)→
            // should 则主 Agent 完整回合 → 消息落定 → 主进程钩子 → 揣测
            // 系统通知 + 文字区同步。**调度触发判定不依赖 judge 结果**:
            // 主进程 lastProactiveTick(judge-no 也证明调度链路通了)。
            // 配置改动由下方 settingsBackup 恢复兜底
            console.log('[widget] 段4.9 开始:真实调度链路(间隔 10s,最长 ~4 分钟,窗口静止属正常)')
            {
              const js = (code) => win.webContents.executeJavaScript(code)
              const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
              const out = {}
              // 段 4.9 进度日志(同段 4.8:调度器 60s 周期 + 真实 judge + 回合,
              // 静默轮询最长 90+120s,无输出会像卡死)
              const logEvery = (t0, limitMs, what) => {
                const el = Math.round((Date.now() - t0) / 1000)
                if (el % 10 === 0) {
                  console.log(`[widget] 段4.9 ${what}: ${el}s/${Math.round(limitMs / 1000)}s …`)
                }
              }
              const backup = {
                messages: await js(`localStorage.getItem('widget-agent-messages')`),
                mind: await js(`localStorage.getItem('widget-agent-mind')`),
              }
              // 临时 stub 系统通知(捕获 title/body;段末 restore)
              const { Notification: ElectronNotification } = require('electron')
              const origShow = ElectronNotification.prototype.show
              const captured = []
              ElectronNotification.prototype.show = function () {
                captured.push({ title: this.title, body: this.body })
                return this
              }
              try {
                // 1. 间隔改 10 秒(数值不变,单位 = 秒)
                await js(
                  `window.desktop.agentSetConfig({ proactiveEnabled: true, proactiveInterval: 10, proactiveIntervalUnit: 's' })`,
                )
                // 2. 进 agent-settings 触发 useAgent onRefresh(config 重读 10s)
                win.webContents.send('widget:open-settings')
                await sleep(800)
                await js(
                  `[...document.querySelectorAll('.island-settings-item')].find((s) => s.textContent.includes('Agent 设置'))?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`,
                )
                await sleep(1000)
                // 返回:agent-settings → 设置 → 收起(设置类视图只能返回键
                // 退出;循环点返回直到没有返回键。**在渲染端执行**——
                // document 只在 executeJavaScript 里可用(主进程无 DOM,实测坑)
                for (let i = 0; i < 3; i++) {
                  const hasBack = await js(`(() => {
                    const backs = [...document.querySelectorAll('.island-bg-back')]
                    if (backs.length === 0) return false
                    backs[backs.length - 1]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
                    return true
                  })()`)
                  if (!hasBack) break
                  await sleep(500)
                }
                // 长按展开回 Agent 聊天视图(agent 模式长按展开保留)
                await js(`(async () => {
                  const island = document.querySelector('.island-demo')
                  const r = island.getBoundingClientRect()
                  island.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, pointerId: 3, isPrimary: true, button: 0 }))
                  await new Promise((res) => setTimeout(res, 600))
                  island.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, pointerId: 3, isPrimary: true, button: 0 }))
                })()`)
                await sleep(1200)
                // 3. 轮询主进程 tick 结果(≤90s:调度器 60s 周期 + judge)
                console.log('[widget] 段4.9 等待渲染端调度器 tick(60s 周期,最长 ~90s)…')
                const tickDeadline = Date.now() + 90000
                const tickT0 = Date.now()
                while (Date.now() < tickDeadline && !getLastProactiveTick()) {
                  logEvery(tickT0, 90000, '等待调度 tick')
                  await sleep(2000)
                }
                const tick = getLastProactiveTick()
                out.tickTriggered = !!tick
                out.tickReason = tick?.reason ?? '(未触发)'
                console.log(`[widget] 段4.9 tick: ${out.tickTriggered ? '触发(' + (tick.reason ?? '') + ')' : '超时未触发'}(${Math.round((Date.now() - tickT0) / 1000)}s)`)
                // 4. judge 通过:等通知(回合落定 → 钩子 → 揣测通知;≤120s)
                if (tick?.started) {
                  console.log('[widget] 段4.9 judge 通过,等待主动回合通知(最长 ~120s)…')
                  const noticeDeadline = Date.now() + 120000
                  const noticeT0 = Date.now()
                  while (Date.now() < noticeDeadline && captured.length === 0) {
                    logEvery(noticeT0, 120000, '等待主动回合通知')
                    await sleep(2000)
                  }
                  out.realChainNotification = captured.length >= 1
                  out.realChainBody = captured[0]?.body ?? ''
                  // 揣测同步紧凑态文字区(localStorage;事件与通知同句)
                  await sleep(1500)
                  out.realChainMind = await js(`localStorage.getItem('widget-agent-mind')`)
                  out.realChainMindMatches = !!out.realChainMind && captured.some((n) => n.body === out.realChainMind)
                  // 主动回复消息落定在历史(末条 assistant 有文本)
                  const history = JSON.parse((await js(`localStorage.getItem('widget-agent-messages')`)) || '[]')
                  const lastAsst = [...history].reverse().find((m) => m.role === 'assistant')
                  const lastText = lastAsst?.parts?.filter((p) => p.type === 'text').map((p) => p.text).join('') ?? ''
                  out.realChainReplied = !!lastAsst && lastText.trim().length > 0
                  out.realChainLastText = lastText.slice(0, 60)
                }
              } catch (err) {
                out.error = String((err && err.stack) || err)
                console.error('[widget] agent-proactive-schedule failed:', err)
              } finally {
                ElectronNotification.prototype.show = origShow
                // 恢复 localStorage(不 reload;React 内存 state 由段末退出接管)
                const setOrRemove = (key, value) =>
                  value === null
                    ? js(`localStorage.removeItem(${JSON.stringify(key)})`)
                    : js(`localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})`)
                await setOrRemove('widget-agent-messages', backup.messages)
                await setOrRemove('widget-agent-mind', backup.mind)
              }
              console.log('[widget] agent-proactive-schedule:', JSON.stringify(out))
            }
          // 恢复用户配置(巡检的"保存配置"把表单状态写回了 settings.json;
            // 测试服务(ui-mock 等)不残留,用户原配置原样恢复)。
            // **必须先丢内存缓存**(审计 P0-2):巡检期间 saveSettings 已改
            // 缓存,磁盘恢复对缓存无效——退出瞬间 before-quit flushSettings
            // 会用旧缓存覆盖刚恢复的文件,残留测试配置(confirmExec 等)
            if (settingsBackup !== null) {
              try {
                fs.writeFileSync(settingsFile, settingsBackup, 'utf8')
                resetSettingsCache()
                console.log('[widget] settings restored')
              } catch (err) {
                console.error('[widget] settings restore failed:', err)
              }
            }
          }
          if (process.env.WIDGET_SCREENSHOT_MODE === 'media-lib') {
            // 分支起始时刻(总耗时核对用)
            const mediaLibT0 = Date.now()
            // 多媒体库 UI 巡检(2026-08-08 用户要求 UI 层面验证):
            // 面板打开 → 注入测试数据(音频 wav/图片/视频路径)→
            // 音频试听自动播放(play 被调用)→ 编辑动画(animationName)
            // + 改名提交 ✓ 徽标 → 宽度对齐搜索栏 → 图片右键菜单 → 应用
            // 背景跳转编辑器 → 视频展开 autoPlay → 清理测试数据
            const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
            const js = (code) => win.webContents.executeJavaScript(code)
            const shot = async (suffix) => {
              const image = await win.webContents.capturePage()
              fs.writeFileSync(process.env.WIDGET_SCREENSHOT + suffix, image.toPNG())
            }
            // 最小静音 wav(8kHz 8bit mono,0.1s):可真实解码播放
            const makeWavBase64 = (seconds = 0.1, rate = 8000) => {
              const dataLen = Math.floor(rate * seconds)
              const buf = Buffer.alloc(44 + dataLen)
              buf.write('RIFF', 0)
              buf.writeUInt32LE(36 + dataLen, 4)
              buf.write('WAVE', 8)
              buf.write('fmt ', 12)
              buf.writeUInt32LE(16, 16)
              buf.writeUInt16LE(1, 20)
              buf.writeUInt16LE(1, 22)
              buf.writeUInt32LE(rate, 24)
              buf.writeUInt32LE(rate, 28)
              buf.writeUInt16LE(1, 32)
              buf.writeUInt16LE(8, 34)
              buf.write('data', 36)
              buf.writeUInt32LE(dataLen, 40)
              return buf.toString('base64')
            }
            const wavBase64 = makeWavBase64()
            // 1x1 红色 PNG(data URL)
            const png1x1 =
              'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
            const testVideoPath = path.join(__dirname, '..', 'bg.png')
            // 1. 打开多媒体库(托盘通道 → seq → 展开切视图)
            win.webContents.send('widget:open-media-library')
            await sleep(1200)
            const opened = await js(`!!document.querySelector('.island-demo.island-media-lib-view')`)
            console.log('[media-lib] panel opened:', opened)
            // 1.5 备份当前背景(双槽位 IDB + localStorage 参数)——图片
            // 注入走桥 importBackground(正规路径)会改已应用背景,巡检后恢复
            const bgBackup = await js(`(async () => {
              const db = await new Promise((res, rej) => {
                const r = indexedDB.open('island-background')
                r.onsuccess = () => res(r.result)
                r.onerror = () => rej(r.error)
              })
              const read = (key) =>
                new Promise((res, rej) => {
                  const tx = db.transaction('bg', 'readonly')
                  const req = tx.objectStore('bg').get(key)
                  req.onsuccess = () => res(req.result ?? null)
                  req.onerror = () => rej(req.error)
                })
              return JSON.stringify({
                expanded: await read('expanded'),
                compact: await read('compact'),
                params: localStorage.getItem('widget-background'),
              })
            })()`)
            console.log('[media-lib] bg backup:', bgBackup)
            // 2. 注入测试数据 + play stub(合成事件无 user activation,
            // autoplay 会被拒——stub 记录 play() 调用证明自动播放触发)。
            // 分步 try/catch 返回详细结果定位失败步骤
            const inject = await js(`(async () => {
              const out = { bridge: typeof window.__islandSettings }
              try {
                window.__playCalls = []
                const origPlay = HTMLMediaElement.prototype.play
                HTMLMediaElement.prototype.play = function () {
                  window.__playCalls.push(this.currentSrc || this.src)
                  return origPlay.call(this).catch(() => {})
                }
                const b = window.__islandSettings
                if (!b) return JSON.stringify(out)
                await b.importAudioLibrary('data:audio/wav;base64,${wavBase64}', '巡检测试音频.wav')
                out.audio = 'ok'
                await b.importVideoLibrary(${JSON.stringify(testVideoPath)}, '巡检测试视频.mp4', 12345)
                out.video = 'ok'
                // 图片:经桥 importBackground 正规入库(与设置界面同路径,
                // 顺带应用到背景——巡检后由 bgBackup 恢复)
                await b.importBackground(${JSON.stringify(png1x1)}, '巡检测试图片.png')
                out.image = 'ok'
                // 手写读回诊断:library / bg / 音频库 tracks 各 store
                const probe = async (dbName, storeName) => {
                  try {
                    const db = await new Promise((res, rej) => {
                      const r = indexedDB.open(dbName)
                      r.onsuccess = () => res(r.result)
                      r.onerror = () => rej(r.error)
                    })
                    return await new Promise((res, rej) => {
                      const tx = db.transaction(storeName, 'readonly')
                      const req = tx.objectStore(storeName).getAll()
                      req.onsuccess = () => res('ok:' + req.result.length)
                      req.onerror = () => rej(req.error)
                    })
                  } catch (e) {
                    return 'ERR:' + String((e && e.name) || e)
                  }
                }
                out.probeLib = await probe('island-background', 'library')
                out.probeBg = await probe('island-background', 'bg')
                out.probeAudio = await probe('island-audio-library', 'tracks')
                // 实验:向 library store put 一条干净字符串记录并立即 getAll
                try {
                  const db2 = await new Promise((res, rej) => {
                    const r = indexedDB.open('island-background')
                    r.onsuccess = () => res(r.result)
                    r.onerror = () => rej(r.error)
                  })
                  await new Promise((res, rej) => {
                    const tx = db2.transaction('library', 'readwrite')
                    tx.objectStore('library').put({ id: 'probe-clean-1', name: 'probe', dataUrl: 'data:image/png;base64,AAAA', createdAt: 1 }, 'probe-clean-1')
                    tx.oncomplete = () => res()
                    tx.onerror = () => rej(tx.error)
                  })
                  out.probeCleanPut = 'ok'
                  const getAll2 = await new Promise((res, rej) => {
                    const tx = db2.transaction('library', 'readonly')
                    const req = tx.objectStore('library').getAll()
                    req.onsuccess = () => res('ok:' + req.result.length)
                    req.onerror = () => rej(req.error)
                  })
                  out.probeCleanGetAll = getAll2
                  const get1 = await new Promise((res, rej) => {
                    const tx = db2.transaction('library', 'readonly')
                    const req = tx.objectStore('library').get('probe-clean-1')
                    req.onsuccess = () => res('ok:' + (req.result ? req.result.name : 'null'))
                    req.onerror = () => rej(req.error)
                  })
                  out.probeCleanGet = get1
                } catch (e) {
                  out.probeCleanErr = String((e && e.name) || e)
                }
                window.dispatchEvent(new CustomEvent('island-settings-changed', { detail: { scopes: ['mediaLibrary', 'imageLibrary'] } }))
                out.event = 'ok'
                return JSON.stringify(out)
              } catch (e) {
                out.error = String((e && e.stack) || e)
                return JSON.stringify(out)
              }
            })()`)
            console.log('[media-lib] inject:', inject)
            await sleep(700)
            await shot('.media-lib-1-injected.png')
            // 3. 音频 tab(默认):试听点击 → 播放条出现 + play 自动调用
            const audio = await js(`(async () => {
              const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
              const row = [...document.querySelectorAll('.island-media-lib-row')].find((r) => r.textContent.includes('巡检测试音频'))
              if (!row) return JSON.stringify({ row: false })
              row.querySelector('.island-lib-row-act[title="试听"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(500)
              const bar = document.querySelector('.island-media-playbar')
              return JSON.stringify({
                row: true,
                bar: !!bar,
                audio: bar ? !!bar.querySelector('audio') : false,
                autoPlayCalled: (window.__playCalls || []).length > 0,
                time: bar && bar.querySelector('.island-media-playbar-time') ? bar.querySelector('.island-media-playbar-time').textContent : null,
              })
            })()`)
            console.log('[media-lib] audio playbar:', audio)
            // 宽度对齐搜索栏(左缘差 < 2px)
            const widthAlign = await js(`(() => {
              const search = document.querySelector('.island-lib-search')
              const row = document.querySelector('.island-media-lib-row')
              if (!search || !row) return JSON.stringify({ ok: false })
              const sr = search.getBoundingClientRect()
              const rr = row.getBoundingClientRect()
              return JSON.stringify({ leftGap: Math.round(Math.abs(sr.left - rr.left)), ok: Math.abs(sr.left - rr.left) < 2 })
            })()`)
            console.log('[media-lib] width align:', widthAlign)
            // 3.5 勾选框动画 + 批量导入按钮亮起/熄灭(2026-08-08):
            // 勾选 → label.on + 对勾描线(offset 0)+ 按钮非禁用 + 呼吸光;
            // 取消 → 反向
            const checkAnim = await js(`(async () => {
              const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
              const row = [...document.querySelectorAll('.island-media-lib-row')].find((r) => r.textContent.includes('巡检测试音频'))
              const label = row.querySelector('.island-media-lib-check')
              label.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(300)
              const on = label.classList.contains('on')
              const offset = label.querySelector('svg') ? getComputedStyle(label.querySelector('svg')).strokeDashoffset : null
              const batchBtn = document.querySelector('.island-media-lib-batch .island-ctl')
              const btnGlow = batchBtn && !batchBtn.disabled ? getComputedStyle(batchBtn).animationName : 'disabled'
              label.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(300)
              const off = !label.classList.contains('on')
              return JSON.stringify({ on, offset, btnGlow, off })
            })()`)
            console.log('[media-lib] check anim:', checkAnim)
            await shot('.media-lib-2-audio.png')
            // 4. 编辑动画:进入编辑(animationName = island-ui-in)→ 改名提交 → ✓ 徽标
            const edit = await js(`(async () => {
              const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
              const row = [...document.querySelectorAll('.island-media-lib-row')].find((r) => r.textContent.includes('巡检测试音频'))
              row.querySelector('.island-lib-row-act[title="编辑名称"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(200)
              const input = row.querySelector('.island-lib-edit-input')
              const anim = input ? getComputedStyle(input).animationName : null
              const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
              setter.call(input, '巡检测试音频-已改名.wav')
              input.dispatchEvent(new Event('input', { bubbles: true }))
              input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
              await sleep(350)
              return JSON.stringify({
                anim,
                saved: !!row.querySelector('.island-media-lib-saved'),
                renamed: row.textContent.includes('巡检测试音频-已改名'),
              })
            })()`)
            console.log('[media-lib] edit anim:', edit)
            await shot('.media-lib-3-edit.png')
            // 5. 切图片 tab(QuickMenu 点击 → pop 项)→ 右键菜单 → 应用背景跳转
            const imgTab = await js(`(async () => {
              const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
              const menu = document.querySelector('.island-media-lib-menu')
              menu.querySelector('.island-quick-menu-btn').dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(250)
              const items = [...menu.querySelectorAll('.island-quick-menu-item')]
              const img = items.find((b) => b.textContent.includes('图片'))
              if (!img) return JSON.stringify({ menuItems: items.map((b) => b.textContent) })
              img.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(400)
              const card = [...document.querySelectorAll('.island-lib-card')].find((c) => c.textContent.includes('巡检测试图片'))
              const lib = (await window.__islandSettings.listLibraryImages()).map((i) => i.name)
              return JSON.stringify({
                card: !!card,
                btnText: menu.querySelector('.island-quick-menu-btn')?.textContent,
                lib,
              })
            })()`)
            console.log('[media-lib] image tab:', imgTab)
            await shot('.media-lib-4-images.png')
            const ctx = await js(`(async () => {
              const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
              const card = [...document.querySelectorAll('.island-lib-card')].find((c) => c.textContent.includes('巡检测试图片'))
              if (!card) return JSON.stringify({ card: false })
              const r = card.getBoundingClientRect()
              card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }))
              await sleep(250)
              const menu = document.querySelector('.island-ctx-menu')
              if (!menu) return JSON.stringify({ menu: false })
              // 可见性断言(2026-08-08 修复"菜单看不见"):菜单 rect 必须
              // 在面板可视范围内(原 fixed 定位被岛体 transform 错位 +
              // overflow 裁剪,元素存在但不可见 = 右键"没反应"的假阳性)
              const mr = menu.getBoundingClientRect()
              const panel = document.querySelector('.island-panel-list')
              const pr = panel ? panel.getBoundingClientRect() : null
              const visible =
                !!pr &&
                mr.width > 0 &&
                mr.left >= pr.left - 2 &&
                mr.right <= pr.right + 2 &&
                mr.top >= pr.top - 2 &&
                mr.bottom <= pr.bottom + 2
              const btn = [...menu.querySelectorAll('button')].find((b) => b.textContent.includes('展开态'))
              btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(500)
              const island = document.querySelector('.island-demo')
              // --bg-img-e 变量在背景图图层(.island-bg-image)上,不在根
              const bgLayer = document.querySelector('.island-bg-image')
              const bgApplied = ((bgLayer && bgLayer.style.getPropertyValue('--bg-img-e')) || '').includes('data:image/png')
              // 返回验证(2026-08-08 用户要求):背景编辑器返回键 → 直接
              // 回多媒体库(backgroundBackRef),而非设置视图
              const backBtn = document.querySelector('.island-bg-back')
              if (backBtn) backBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(500)
              const backToMediaLib = island.classList.contains('island-media-lib-view')
              return JSON.stringify({
                menu: true,
                menuVisible: visible,
                bgView: island.classList.contains('island-bg-view'),
                bgApplied,
                backToMediaLib,
              })
            })()`)
            console.log('[media-lib] ctx menu → bg:', ctx)
            await shot('.media-lib-5-bg-view.png')
            // 6. 视频:重开多媒体库 → 视频 tab → 播放 → video 挂载 + autoPlay
            win.webContents.send('widget:open-media-library')
            await sleep(1000)
            const video = await js(`(async () => {
              const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
              const menu = document.querySelector('.island-media-lib-menu')
              menu.querySelector('.island-quick-menu-btn').dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(250)
              const items = [...menu.querySelectorAll('.island-quick-menu-item')]
              const vid = items.find((b) => b.textContent.includes('视频'))
              if (!vid) return JSON.stringify({ tabItem: false })
              vid.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(300)
              const row = [...document.querySelectorAll('.island-media-lib-row')].find((r) => r.textContent.includes('巡检测试视频'))
              if (!row) return JSON.stringify({ row: false })
              row.querySelector('.island-lib-row-act[title="播放"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(450)
              const video = row.querySelector('video.island-media-lib-preview')
              const openState = !!row.querySelector('.island-media-preview.open')
              // 收起动画(2026-08-08):点击收起后 150ms 内内容应仍保留
              // (closingId 延迟卸载,grid 过渡在播)**且已暂停**(声音立即
              // 停,画面保留播收起动画),350ms 后卸载
              row.querySelector('.island-lib-row-act[title="收起播放"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(150)
              const closingVideo = row.querySelector('video.island-media-lib-preview')
              const closingRetained = !!closingVideo
              const closingPaused = closingVideo ? closingVideo.paused : true
              await sleep(350)
              const closed = !row.querySelector('video.island-media-lib-preview')
              return JSON.stringify({
                row: true,
                previewOpen: openState,
                video: !!video,
                autoPlay: video ? video.autoplay : false,
                closingRetained,
                closingPaused,
                closed,
              })
            })()`)
            console.log('[media-lib] video:', video)
            // 6.5 收起动画帧采样(2026-08-09 用户"动画还是瞬间关闭"):
            // 只断言 DOM 存在性测不出动画是否在播——重新展开再收起,
            // 每 100ms 采样 preview 行高 + video opacity,断言**渐变**
            // (首末高度不同且存在中间值 = 高度过渡在播,非瞬间跳变)
            const collapseFrames = await js(`(async () => {
              const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
              // 上一段收起动画(closingId 730ms)未结束时,行按钮 title 仍
              // 是"播放",此时点击会走"再次收起"分支而不是展开
              // (2026-08-09 实测踩坑)——先等收起完全结束再重新展开
              await sleep(900)
              const row = [...document.querySelectorAll('.island-media-lib-row')].find((r) => r.textContent.includes('巡检测试视频'))
              if (!row) return JSON.stringify({ row: false })
              const playBtn = row.querySelector('.island-lib-row-act[title="播放"]')
              if (!playBtn) {
                return JSON.stringify({ playBtn: false, title: row.querySelector('.island-lib-row-act')?.getAttribute('title') })
              }
              playBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(500)
              const preview = row.querySelector('.island-media-preview')
              if (!preview) return JSON.stringify({ preview: false })
              row.querySelector('.island-lib-row-act[title="收起播放"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))
              const frames = []
              for (let i = 0; i < 12; i++) {
                const v = row.querySelector('video.island-media-lib-preview')
                frames.push({
                  t: i * 100,
                  h: Math.round(preview.getBoundingClientRect().height),
                  op: v ? Math.round(parseFloat(getComputedStyle(v).opacity) * 100) / 100 : -1,
                })
                await sleep(100)
              }
              const hs = frames.map((f) => f.h)
              const h0 = hs[0]
              const hn = hs[hs.length - 1]
              // 渐变判定:起始有内容高度、结尾收拢,且中途存在中间值
              const gradual =
                h0 > 30 && hn < 30 && hs.some((h) => h > 20 && h < h0 - 20)
              // 淡出判定:video opacity 出现过中间值(0 < op < 1)
              const faded = frames.some((f) => f.op > 0.05 && f.op < 0.95)
              return JSON.stringify({ frames, h0, hn, gradual, faded })
            })()`)
            console.log('[media-lib] collapse frames:', collapseFrames)
            await shot('.media-lib-6-video.png')
            // 7. 清理测试数据(名称带"巡检测试"的条目)+ 恢复背景备份
            await js(`(async () => {
              const b = window.__islandSettings
              const audioItems = await b.listAudioLibrary()
              for (const a of audioItems) if (a.name.includes('巡检测试')) await b.removeAudioLibrary(a.id)
              const videoItems = await b.listVideoLibrary()
              for (const v of videoItems) if (v.name.includes('巡检测试')) await b.removeVideoLibrary(v.id)
              const imgItems = await b.listLibraryImages()
              for (const im of imgItems) if (im.name.includes('巡检测试') || im.id === 'probe-clean-1') await b.deleteLibraryImage(im.id)
              // 恢复背景双槽位 + 参数(importBackground 已改背景)
              const backup = JSON.parse(${JSON.stringify(bgBackup)})
              const db = await new Promise((res, rej) => {
                const r = indexedDB.open('island-background')
                r.onsuccess = () => res(r.result)
                r.onerror = () => rej(r.error)
              })
              const write = (key, val) =>
                new Promise((res, rej) => {
                  const tx = db.transaction('bg', 'readwrite')
                  const s = tx.objectStore('bg')
                  if (val === null) s.delete(key)
                  else s.put(val, key)
                  tx.oncomplete = () => res()
                  tx.onerror = () => rej(tx.error)
                })
              await write('expanded', backup.expanded)
              await write('compact', backup.compact)
              if (backup.params === null) localStorage.removeItem('widget-background')
              else localStorage.setItem('widget-background', backup.params)
              window.dispatchEvent(new CustomEvent('island-settings-changed', { detail: { scopes: ['mediaLibrary', 'imageLibrary', 'background'] } }))
              return 'cleaned'
            })()`)
            console.log('[media-lib] cleanup done')
            // 巡检期间新增的带窗口进程(定位"约 40 秒弹新终端")
            const termWatchResult = termWatch.stop()
            console.log(
              `[media-lib] 窗口监控:快照 ${termWatchResult.snapshots} 次,新增 ${termWatchResult.events.length} 个`,
              termWatchResult.events.length > 0 ? JSON.stringify(termWatchResult.events) : '',
            )
            console.log(`[media-lib] 巡检耗时 ${Math.round((Date.now() - mediaLibT0) / 1000)}s(自分支开始)`)
          }
          if (process.env.WIDGET_SCREENSHOT_MODE === 'chat-media') {
            // 对话媒体巡检(2026-08-08 用户要求"播放视频看不到视频,请
            // UI 测试"):切 Agent 模式 → 展开 → MediaRecorder 录一段
            // 真实 webm → 注入 agent:event message(media part)→ 断言
            // 消息气泡 + video 元素 + **可见高度(核心:aspect 未加载时
            // 16/9 兜底,原容器高度 0 = 视频不可见)** + 播放中
            const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
            const js = (code) => win.webContents.executeJavaScript(code)
            // 备份对话消息(结束恢复,不残留测试消息)
            const msgBackup = await js(`localStorage.getItem('widget-agent-messages')`)
            // 清理上次巡检残留(2026-08-10 严格测试:巡检超时被杀时消息未
            // 恢复,下次启动带旧消息重挂载 → 自动播放断言混入旧消息污染);
            // reload 清内存消息,再走下方"切 Agent + 展开 + 注入"流程
            await js(`localStorage.removeItem('widget-agent-messages')`)
            win.webContents.reload()
            await sleep(3000)
            // 1. 切 Agent 模式(托盘同款 payload)+ 长按展开
            win.webContents.send('widget:set-mode', { mode: 'agent', source: 'user' })
            await sleep(1600)
            const expanded = await js(`(async () => {
              const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
              const island = document.querySelector('.island-demo')
              const r = island.getBoundingClientRect()
              const x = r.left + r.width / 2
              const y = r.top + r.height / 2
              island.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y, pointerId: 1, isPrimary: true, button: 0 }))
              setTimeout(() => island.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x, clientY: y, pointerId: 1, isPrimary: true, button: 0 })), 600)
              await sleep(1300)
              return island.classList.contains('expanded')
            })()`)
            console.log('[chat-media] expanded:', expanded)
            // 2. 生成真实 webm 视频 data URL(MediaRecorder 录 canvas)
            const videoDataUrl = await js(`(async () => {
              try {
                const canvas = document.createElement('canvas')
                canvas.width = 320
                canvas.height = 180
                const ctx = canvas.getContext('2d')
                ctx.fillStyle = '#4d6bfe'
                ctx.fillRect(0, 0, 320, 180)
                ctx.fillStyle = '#fff'
                ctx.font = '26px sans-serif'
                ctx.fillText('UI TEST', 100, 100)
                const stream = canvas.captureStream(10)
                const rec = new MediaRecorder(stream, { mimeType: 'video/webm' })
                const chunks = []
                rec.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data) }
                const done = new Promise((res) => { rec.onstop = () => res() })
                rec.start()
                await new Promise((r) => setTimeout(r, 900))
                rec.stop()
                await done
                const blob = new Blob(chunks, { type: 'video/webm' })
                const dataUrl = await new Promise((res) => {
                  const fr = new FileReader()
                  fr.onload = () => res(fr.result)
                  fr.readAsDataURL(blob)
                })
                return String(dataUrl)
              } catch (e) {
                return 'ERR:' + String((e && e.message) || e)
              }
            })()`)
            console.log('[chat-media] video data url:', videoDataUrl ? (videoDataUrl.startsWith('data:') ? 'len=' + videoDataUrl.length : videoDataUrl) : 'null')
            // 3. 注入 message 事件(media part → MediaFrame 渲染路径,与
            // open_file 媒体附件同链路)。**两条消息**:data URL + 本地
            // 路径(island-media:// 协议流式)——本地协议是真实场景
            // (LLM 打开本地视频),必须验证真实解码
            // 真实文件优先(2026-08-08 用户要求用 JiJiDown 下载的真实
            // 音视频测试):目录第一个 mp4(视频)/ mp3(音频)走本地协议;
            // 目录不可读或为空则回退 MediaRecorder 生成的 webm
            const JIJI_DIR = 'C:\\Program Files\\JiJiDown\\Download'
            let realVideoPath = null
            let realAudioPath = null
            try {
              const jijiFiles = fs.readdirSync(JIJI_DIR)
              realVideoPath = jijiFiles.find((f) => /\.mp4$/i.test(f)) ? path.join(JIJI_DIR, jijiFiles.find((f) => /\.mp4$/i.test(f))) : null
              realAudioPath = jijiFiles.find((f) => /\.mp3$/i.test(f)) ? path.join(JIJI_DIR, jijiFiles.find((f) => /\.mp3$/i.test(f))) : null
            } catch {
              // 目录不可读:回退
            }
            console.log('[chat-media] real files:', realVideoPath ? path.basename(realVideoPath) : 'none', '|', realAudioPath ? path.basename(realAudioPath) : 'none')
            const tmpVideo = path.join(app.getPath('temp'), 'ui-test-media.webm')
            if (videoDataUrl && videoDataUrl.startsWith('data:')) {
              // data URL 消息(对照基线)
              win.webContents.send('agent:event', {
                type: 'message',
                message: {
                  id: 'ui-test-msg-1',
                  role: 'assistant',
                  parts: [
                    { type: 'text', text: '巡检测试视频' },
                    { type: 'media', kind: 'video', url: videoDataUrl, name: 'ui-test.webm' },
                  ],
                },
                usage: { input: 1, output: 1 },
              })
              // 撑高消息列表(滚动跟随断言用:15 条文本让列表可滚动,
              // 视频在底部,拖大后 followMediaInView 应把视频底部滚入可视区)
              for (let i = 0; i < 15; i++) {
                win.webContents.send('agent:event', {
                  type: 'message',
                  message: {
                    id: `ui-test-fill-${i}`,
                    role: 'assistant',
                    parts: [{ type: 'text', text: `巡检测试填充消息 ${i} `.repeat(12) }],
                  },
                  usage: { input: 1, output: 1 },
                })
              }
              // 本地路径消息(island-media:// 协议):真实文件优先
              let localVideo = realVideoPath
              if (!localVideo) {
                const b64 = videoDataUrl.slice(videoDataUrl.indexOf(',') + 1)
                fs.writeFileSync(tmpVideo, Buffer.from(b64, 'base64'))
                localVideo = tmpVideo
              }
              win.webContents.send('agent:event', {
                type: 'message',
                message: {
                  id: 'ui-test-msg-2',
                  role: 'assistant',
                  parts: [
                    { type: 'text', text: '巡检测试本地视频' },
                    { type: 'media', kind: 'video', url: localVideo, name: path.basename(localVideo) },
                  ],
                },
                usage: { input: 1, output: 1 },
              })
              // 真实音频消息(音频库同款 VoiceBubble 渲染,mp3 本地协议)
              if (realAudioPath) {
                win.webContents.send('agent:event', {
                  type: 'message',
                  message: {
                    id: 'ui-test-msg-audio',
                    role: 'assistant',
                    parts: [
                      { type: 'text', text: '巡检测试音频' },
                      { type: 'media', kind: 'audio', url: realAudioPath, name: path.basename(realAudioPath) },
                    ],
                  },
                  usage: { input: 1, output: 1 },
                })
              }
            }
            await sleep(2000)
            // 4. 断言:气泡 + video 元素 + 可见高度 + 真实解码(本地协议);
            // err 区分"没渲染"与"渲染成 MediaError"
            const check = await js(`(async () => {
              const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
              const msg = [...document.querySelectorAll('.island-agent-msg-assistant')].find((m) => m.textContent.includes('巡检测试本地视频'))
              if (!msg) return JSON.stringify({ msg: false })
              const video = msg.querySelector('video')
              if (!video) {
                return JSON.stringify({
                  msg: true,
                  video: false,
                  errText: msg.querySelector('.island-agent-media-err') ? msg.querySelector('.island-agent-media-err').textContent : null,
                })
              }
              const r = video.getBoundingClientRect()
              await sleep(600)
              // readyState >= 1 = 元数据已加载(真实解码通过);
              // error 非 null = 解码失败
              return JSON.stringify({
                msg: true,
                video: true,
                visible: r.height > 10 && r.width > 10,
                h: Math.round(r.height),
                w: Math.round(r.width),
                src: (video.currentSrc || video.src || '').slice(0, 40),
                readyState: video.readyState,
                decodeError: video.error ? video.error.code : null,
                playing: !video.paused,
              })
            })()`)
            // 4.3 定制播放器 + 右下角手柄 + 拖拽缩放(2026-08-08)
            const player = await js(`(async () => {
              const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
              const msg = [...document.querySelectorAll('.island-agent-msg-assistant')].find((m) => m.textContent.includes('巡检测试本地视频'))
              if (!msg) return JSON.stringify({ msg: false })
              const frame = msg.querySelector('.island-media-frame')
              const video = frame ? frame.querySelector('video') : null
              if (!frame || !video) return JSON.stringify({ msg: true, frame: !!frame, video: !!video })
              const controls = !!frame.querySelector('.island-video-controls')
              const playBtn = !!frame.querySelector('.island-video-play')
              const bar = !!frame.querySelector('.island-video-bar')
              const fsBtn = !!frame.querySelector('.island-video-fs')
              const nativeControls = video.controls
              // 滚动容器先声明(2026-08-09 修复 TDZ:此前声明在下方,
              // listRect/滚动断言引用时抛 "Cannot access 'scroller'
              // before initialization",整段巡检直接失败)
              const scroller = msg.closest('.island-agent-messages')
              // 手柄在 wrap(气泡外)里,不在 frame 内(2026-08-08)
              const resizeHandle = msg.querySelector('.island-media-resize')
              const handles = msg.querySelectorAll('.island-media-resize').length
              // 手柄不被裁切(2026-08-08 二轮修复):手柄 rect 应完整在
              // 消息列表可视区内(bottom/right 不超出滚动容器)
              const handleRect = resizeHandle ? resizeHandle.getBoundingClientRect() : null
              const listRect = scroller ? scroller.getBoundingClientRect() : null
              const handleVisible =
                !!resizeHandle &&
                !!listRect &&
                handleRect.width > 0 &&
                handleRect.bottom <= listRect.bottom + 2 &&
                handleRect.right <= listRect.right + 2
              const w0 = frame.getBoundingClientRect().width
              // 滚动跟随(2026-08-08 用户要求"拖多大自动往下滚多少"):
              // 记录消息列表滚动位置,拖大后视频底部应滚入可视区
              const scroll0 = scroller ? scroller.scrollTop : -1
              // 全屏按钮触发 stub(合成事件无 user activation,requestFullscreen
              // 会被拒——stub 记录调用证明按钮接线)
              let fsCalled = false
              const origFs = Element.prototype.requestFullscreen
              Element.prototype.requestFullscreen = function () {
                fsCalled = true
                return Promise.resolve()
              }
              // 拖拽右下角手柄放大 100px(合成 pointer 序列;等比例缩放)
              const h = resizeHandle
              const hr = h.getBoundingClientRect()
              h.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: hr.left + 4, clientY: hr.top + 4, pointerId: 7, button: 0 }))
              h.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: hr.left + 104, clientY: hr.top + 4, pointerId: 7, button: 0 }))
              h.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: hr.left + 104, clientY: hr.top + 4, pointerId: 7, button: 0 }))
              await sleep(250)
              const w1 = frame.getBoundingClientRect().width
              // 跟随滚动本质断言:拖大后视频底部应滚入可视区(岛体高度
              // 自适应吸收部分增长,scrollTop 数值变化非唯一判据)
              const vr2 = video.getBoundingClientRect()
              const cr2 = scroller ? scroller.getBoundingClientRect() : null
              const bottomInView = cr2 ? vr2.bottom <= cr2.bottom + 2 : false
              // 点全屏按钮(stub 下应触发 requestFullscreen 调用)
              frame.querySelector('.island-video-fs').dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(150)
              Element.prototype.requestFullscreen = origFs
              return JSON.stringify({
                msg: true,
                controls,
                playBtn,
                bar,
                fsBtn,
                nativeControls,
                handles,
                handleVisible,
                w0: Math.round(w0),
                w1: Math.round(w1),
                grew: w1 > w0,
                bottomInView,
                scroll0: Math.round(scroll0),
                fsCalled,
              })
            })()`)
            console.log('[chat-media] player:', player)
            // 4.4 真实音频断言(语音气泡 + 本地协议解码)
            const audioCheck = await js(`(async () => {
              const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
              const msg = [...document.querySelectorAll('.island-agent-msg-assistant')].find((m) => m.textContent.includes('巡检测试音频'))
              if (!msg) return JSON.stringify({ msg: false })
              const voice = msg.querySelector('.island-agent-voice')
              if (!voice) return JSON.stringify({ msg: true, voice: false })
              const audio = voice.querySelector('audio')
              if (!audio) return JSON.stringify({ msg: true, voice: true, audio: false })
              await sleep(600)
              const duration = audio.duration || 0
              // 进度条拖拽 seek(2026-08-08 用户要求"音频气泡支持拖拽
              // 进度"):拖到 50% → currentTime ≈ duration×0.5
              const bar = voice.querySelector('.island-agent-voice-progress')
              let seeked = false
              let seekErr = null
              if (bar && duration > 0) {
                try {
                  const br = bar.getBoundingClientRect()
                  const midX = br.left + br.width * 0.5
                  bar.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: midX, clientY: br.top + br.height / 2, pointerId: 5, button: 0 }))
                  bar.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: midX, clientY: br.top + br.height / 2, pointerId: 5, button: 0 }))
                  await sleep(300)
                  seeked = Math.abs(audio.currentTime - duration * 0.5) < 6
                } catch (e) {
                  seekErr = String((e && e.message) || e)
                }
              }
              return JSON.stringify({
                msg: true,
                voice: true,
                audio: true,
                readyState: audio.readyState,
                decodeError: audio.error ? audio.error.code : null,
                dur: voice.querySelector('.island-agent-voice-dur') ? voice.querySelector('.island-agent-voice-dur').textContent : null,
                src: (audio.currentSrc || audio.src || '').slice(0, 40),
                seeked,
                seekErr,
                currentTime: Math.round(audio.currentTime),
              })
            })()`)
            console.log('[chat-media] real audio:', audioCheck)
            // 4.5 不支持的格式(mkv)→ MediaError 明确提示格式原因
            // (2026-08-08 用户"显示无法播放该文件"——Chromium 只支持
            // H.264 mp4/webm/ogg,HEVC/mkv/avi 无法窗口内解码是硬限制,
            // 文案按 error.code 4 区分 + 系统播放器降级按钮)
            const tmpMkv = path.join(app.getPath('temp'), 'ui-test-unsupported.mkv')
            fs.writeFileSync(tmpMkv, Buffer.from('not a real video file'))
            win.webContents.send('agent:event', {
              type: 'message',
              message: {
                id: 'ui-test-msg-3',
                role: 'assistant',
                parts: [
                  { type: 'text', text: '巡检测试不支持格式' },
                  { type: 'media', kind: 'video', url: tmpMkv, name: 'ui-test.mkv' },
                ],
              },
              usage: { input: 1, output: 1 },
            })
            await sleep(1200)
            const unsupported = await js(`(() => {
              const msg = [...document.querySelectorAll('.island-agent-msg-assistant')].find((m) => m.textContent.includes('巡检测试不支持格式'))
              if (!msg) return JSON.stringify({ msg: false })
              const err = msg.querySelector('.island-agent-media-err')
              if (!err) return JSON.stringify({ msg: true, err: false })
              return JSON.stringify({
                msg: true,
                err: true,
                text: err.textContent.slice(0, 60),
                hasExternalBtn: !!msg.querySelector('.island-agent-media-external'),
              })
            })()`)
            console.log('[chat-media] unsupported format:', unsupported)
            // 清理临时视频文件
            try {
              fs.rmSync(tmpVideo, { force: true })
              fs.rmSync(tmpMkv, { force: true })
            } catch {
              // 忽略清理失败
            }
            console.log('[chat-media] check:', check)
            // 4.10 自动播放严格断言(2026-08-10 用户实测"让 LLM 找歌来听
            // 没自动播放"):注入的每条消息第一个音频/视频媒体(media part)
            // 应**自动播放**(paused === false)——媒体落定(mediaAutoPlay
            // Set)+ canplay 后 play;被自动播放策略拦截 = 静默失败 =
            // paused 仍 true。等足 canplay(本地协议流式 + 元数据)。
            // **必须放在 4.8(reload + 60 条滚动消息)之前**(reload 后
            // localStorage 被替换,注入消息消失)与 **4.6(切音乐模式、
            // Agent 面板卸载)之前**;且只统计本次注入的「巡检测试」消息
            // (开头已清残留,防旧消息重挂载干扰)
            await sleep(2500)
            // 注意:音频自动播放断言必须先于诊断(诊断的手动 play 会
            // 污染"自动播放"判定——2026-08-10 实测假阳性)
            const autoplay = await js(`(async () => {
              const msgs = [...document.querySelectorAll('.island-agent-msg-assistant')].filter((m) => m.textContent.includes('巡检测试'))
              const videos = [...msgs].flatMap((m) => [...m.querySelectorAll('.island-media-frame video')])
              const audios = [...msgs].flatMap((m) => [...m.querySelectorAll('.island-agent-voice audio')])
              return JSON.stringify({
                // played = 播放中或已播完(短媒体如 0.9s webm 在检查前
                // 可能已 ended——ended 同样证明自动播放发生过)
                videos: videos.map((v) => ({
                  played: !v.paused || v.ended,
                  ended: v.ended,
                  readyState: v.readyState,
                  name: v.closest('.island-media-frame')?.getAttribute('data-media-name') || '',
                })),
                audios: audios.map((a) => ({ played: !a.paused || a.ended, readyState: a.readyState })),
              })
            })()`)
            console.log('[chat-media] autoplay:', autoplay)
            const autoState = JSON.parse(autoplay)
            if (autoState.videos.length >= 2 && autoState.videos.every((v) => v.played)) {
              console.log('[chat-media] AUTOPLAY-VIDEO: PASS')
            } else {
              console.error(`[chat-media] AUTOPLAY-VIDEO: FAIL 对话视频应自动播放(每条消息第一个媒体):${autoplay}`)
            }
            if (realAudioPath) {
              if (autoState.audios.length === 1 && autoState.audios[0].played) {
                console.log('[chat-media] AUTOPLAY-AUDIO: PASS')
              } else {
                console.error(`[chat-media] AUTOPLAY-AUDIO: FAIL 音频应自动播放(找歌来听场景):${autoplay}`)
              }
            } else {
              console.log('[chat-media] AUTOPLAY-AUDIO: SKIP(无真实 mp3)')
            }
            // 4.11 对话媒体清单端到端(2026-08-10,list_conversation_media
            // 工具数据源):桥直接查 DOM → 视频带播放状态/音量/速度/循环/
            // 全屏;音频带播放状态。清单覆盖全 DOM(含非测试消息)——
            // 断言用 some() 校验本次注入的视频/音频条目存在且字段齐全
            const mediaList = await js(`window.__islandSettings.getConversationMedia()`)
            console.log('[chat-media] conversation media:', JSON.stringify(mediaList).slice(0, 400))
            const list = Array.isArray(mediaList) ? mediaList : []
            const vids = list.filter((i) => i.kind === 'video')
            const vidOk =
              list.length >= 2 &&
              vids.some(
                (v) =>
                  v.playing &&
                  typeof v.volume === 'number' &&
                  typeof v.speed === 'number' &&
                  typeof v.loop === 'boolean' &&
                  typeof v.fullscreen === 'boolean' &&
                  typeof v.position === 'number',
              )
            if (vidOk) {
              console.log('[chat-media] CONV-MEDIA: PASS')
            } else {
              console.error(`[chat-media] CONV-MEDIA: FAIL 视频清单应带播放状态/音量/速度/循环/全屏:${JSON.stringify(mediaList).slice(0, 400)}`)
            }
            if (realAudioPath) {
              if (list.some((i) => i.kind === 'audio' && i.playing)) {
                console.log('[chat-media] CONV-MEDIA-AUDIO: PASS')
              } else {
                console.error(`[chat-media] CONV-MEDIA-AUDIO: FAIL 音频清单应带播放状态:${JSON.stringify(mediaList).slice(0, 400)}`)
              }
            }
            // 4.6 音频移交端到端(2026-08-09 五轮修复 + UI 验证):收起
            // 面板时对话音频应加载进音乐模式继续播放——注入真实 mp3
            // 媒体消息(触发挂载上报)→ 长按消息区收起面板(doCollapse
            // 触发 onAgentAudioHandoff)→ 断言:模式切回音乐 + 音频进
            // 播放列表(音频库自动入库,与 addTracks 同路径)→ 清理
            const handoffName = '巡检测试移交音频.mp3'
            win.webContents.send('agent:event', {
              type: 'message',
              message: {
                id: 'ui-test-msg-handoff',
                role: 'assistant',
                parts: [
                  { type: 'text', text: '巡检测试移交' },
                  { type: 'media', kind: 'audio', url: realAudioPath, name: handoffName },
                ],
              },
              usage: { input: 1, output: 1 },
            })
            await sleep(1000)
            // 模拟真实播放(2026-08-09 修复后仅在面板内**正在播放**的
            // 音频才移交——未播放/已暂停的音频不再自动移交):直接调
            // VoiceBubble 的 audio.play();Electron 默认 autoplayPolicy
            // = no-user-gesture-required,页面脚本 play() 放行
            const handoffPlayed = await js(`(async () => {
              const msg = [...document.querySelectorAll('.island-agent-msg-assistant')].find((m) => m.textContent.includes('巡检测试移交'))
              const audio = msg ? msg.querySelector('.island-agent-voice audio') : null
              if (!audio) return 'no-audio'
              try {
                await audio.play()
                return 'played'
              } catch (e) {
                return 'ERR:' + String((e && e.message) || e)
              }
            })()`)
            console.log('[chat-media] handoff voice play:', handoffPlayed)
            await sleep(800)
            // 触发收起:经模式切换链路(托盘/手势同款)——collapseSeq →
            // changeExpanded(false) → doCollapse → 音频移交。
            // **不能用长按消息区**:Agent 展开态长按收回已禁用(只能经
            // ⋯ 菜单"收起面板"),合成长按不会收起(2026-08-09 实测
            // 断言一直读到移交未触发)
            await js(`(() => {
              window.desktop?.setMode?.('music')
              return 'switch'
            })()`)
            // 移交:fetch(协议流式 3.7MB 实测 >4s)+ addTracks(文件拷贝/
            // 入库/播放)+ 切音乐模式——给足时间(2026-08-09 实测
            // 4000ms 不够,断言读到移交未完成)
            await sleep(8000)
            const handoffResult = await js(`(async () => {
              const mode = localStorage.getItem('widget-mode') || ''
              let inLibrary = false
              let libNames = ''
              try {
                const items = await window.__islandSettings?.listAudioLibrary?.() || []
                libNames = items.map((it) => it.name || '').join('|').slice(0, 100)
                inLibrary = items.some((it) => (it.name || '').includes('巡检测试移交音频'))
              } catch (e) { libNames = 'ERR:' + String(e) }
              const text = document.querySelector('.island-text')?.textContent || ''
              return JSON.stringify({ mode, inLibrary, libNames, text: text.slice(0, 30) })
            })()`)
            console.log('[chat-media] audio handoff:', handoffResult)
            // 4.7 音乐模式展开/收回不重复移交(2026-08-09 用户报告"进入
            // 音乐模式后长按展开再收回,自动从头播放之前记录的歌"):
            // doCollapse 是音乐模式收起也走的公共路径,agentLastMedia
            // (最近 Agent 音频)不随模式清除——旧实现每次收起都重复
            // handoff → 同一首歌再次 addTracks 并从 0 自动播。修复 =
            // 媒体快照/移交只在 Agent 模式收起时处理,且仅面板内正在
            // 播放的音频才移交。断言:首次移交后,音乐模式长按展开
            // 再单击收回,island-uploads 中该音频仍只有 1 条(无重复
            // 移交 = 不会从头再播)、模式仍为 music、无媒体小窗
            const tracksCountBefore = await js(`(async () => {
              const db = await new Promise((res, rej) => {
                const req = indexedDB.open('island-uploads')
                req.onsuccess = () => res(req.result)
                req.onerror = () => rej(req.error)
              })
              const tracks = await new Promise((res) => {
                const tx = db.transaction('tracks', 'readonly')
                const req = tx.objectStore('tracks').getAll()
                req.onsuccess = () => res(req.result || [])
                req.onerror = () => res([])
              })
              db.close()
              return (tracks || []).filter((t) => (t.name || '').includes('巡检测试移交音频')).length
            })()`)
            // 长按展开音乐模式面板(与 Agent 长按同款 600ms 手势;
            // handoff 已把模式切为 music,此时 agent prop 已卸载)
            await js(`(() => {
              const island = document.querySelector('.island-demo')
              const r = island.getBoundingClientRect()
              const x = r.left + r.width / 2
              const y = r.top + r.height / 2
              island.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y, pointerId: 11, isPrimary: true, button: 0 }))
              setTimeout(() => island.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x, clientY: y, pointerId: 11, isPrimary: true, button: 0 })), 600)
              return 'press'
            })()`)
            await sleep(1500)
            const expandedAfterPress = await js(`document.querySelector('.island-demo').classList.contains('expanded')`)
            // 收回(单击岛体:音乐模式展开态收起走 React onClick——
            // **合成 PointerEvent 不产生 click**,必须派发真实 click
            // 事件;长按展开的 suppress 标记 600ms 已过,不吞 click)
            await js(`(() => {
              const island = document.querySelector('.island-demo')
              island.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              return 'clicked'
            })()`)
            await sleep(1500)
            const handoffRecheck = await js(`(async () => {
              const db = await new Promise((res, rej) => {
                const req = indexedDB.open('island-uploads')
                req.onsuccess = () => res(req.result)
                req.onerror = () => rej(req.error)
              })
              const tracks = await new Promise((res) => {
                const tx = db.transaction('tracks', 'readonly')
                const req = tx.objectStore('tracks').getAll()
                req.onsuccess = () => res(req.result || [])
                req.onerror = () => res([])
              })
              db.close()
              return JSON.stringify({
                mode: localStorage.getItem('widget-mode') || '',
                handoffTracks: (tracks || []).filter((t) => (t.name || '').includes('巡检测试移交音频')).length,
                expanded: document.querySelector('.island-demo').classList.contains('expanded'),
                hasMini: !!document.querySelector('.island-agent-mini'),
                text: (document.querySelector('.island-text')?.textContent || '').slice(0, 16),
              })
            })()`)
            console.log('[chat-media] music expand/collapse no re-handoff:', JSON.stringify({ tracksCountBefore, expandedAfterPress, after: handoffRecheck }))
            // 4.8 大量消息滚动抖动验证(2026-08-09 用户"信息多时滚动条
            // 中间部分滚动抖动"):注入 60 条文本消息(写 localStorage 后
            // reload 恢复会话,60 次事件注入太慢)→ 切 Agent 长按展开
            // → 分批/测量稳定 → 滚动到中部 → 采样 scrollHeight 与 thumb
            // 比例,判断 content-visibility 估算(120px)与真实高度差异
            // 导致的"真实化 → 高度反复修正"是否成立(抖动)
            const scrollBackup = await js(`localStorage.getItem('widget-agent-messages')`)
            const bigHistory = []
            for (let i = 0; i < 60; i++) {
              bigHistory.push({
                id: 'ui-scroll-' + i,
                role: i % 2 ? 'assistant' : 'user',
                parts: [{ type: 'text', text: `滚动测试消息 ${i}:灵动岛桌面挂件复刻 iOS 灵动岛,通过 SMTC 监听播放状态,内置本地播放器兜底。` }],
              })
            }
            await js(
              `localStorage.setItem('widget-agent-messages', ${JSON.stringify(JSON.stringify(bigHistory))})`,
            )
            win.webContents.reload()
            await sleep(4000)
            win.webContents.send('widget:set-mode', { mode: 'agent', source: 'user' })
            await sleep(1500)
            const scrollProbe = await js(`(async () => {
              try {
              const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
              const island = document.querySelector('.island-demo')
              const r = island.getBoundingClientRect()
              island.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, pointerId: 21, isPrimary: true, button: 0 }))
              setTimeout(() => island.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, pointerId: 21, isPrimary: true, button: 0 })), 600)
              await sleep(3500)
              const list = document.querySelector('.island-agent-messages')
              if (!list) return JSON.stringify({ list: false })
              const total = list.children.length
              // **诊断(2026-08-09)**:--msg-h 是否写入(内联 style)、
              // computed contain-intrinsic-size 是否生效、与真实高度
              // (强制布局)的差异——定位滚动中 scrollHeight 修正来源
              // settled 标记 = 宽度动画后重测是否执行(2026-08-09)
              const settled = list.dataset.msgHSettled === '1'
              const listW = list.clientWidth
              const cv = list.classList.contains('cv')
              // 诊断:估算(--msg-h)与真实高度一致性(强制布局)
              const diag = []
              for (let i = 0; i < Math.min(3, total); i++) {
                const c = list.children[i]
                const inline = c.style.getPropertyValue('--msg-h') || '(空)'
                const prevCv = c.style.contentVisibility
                c.style.contentVisibility = 'visible'
                const real = c.offsetHeight
                c.style.contentVisibility = prevCv || ''
                diag.push({ i, inline, real })
              }
              list.scrollTop = 0
              await sleep(400)
              // **滚动过程中采样**:content-visibility 的真实化发生在滚动
              // 时(元素滚入视口瞬间布局),滚动停止后已稳定(上版静止采样
              // drift 0 = 假阴性)。分段滚动(每段 0.8 屏,跳过顶部真实化
              // 区),每段滚动后立即采样 3 帧抓真实化引起的高度修正
              const frames = []
              const marks = []
              for (let seg = 0; seg < 6; seg++) {
                list.scrollTop += list.clientHeight * 0.8
                await sleep(60)
                for (let f = 0; f < 3; f++) {
                  frames.push({
                    sh: list.scrollHeight,
                    st: Math.round(list.scrollTop),
                    ratio: Math.round((list.scrollTop / list.scrollHeight) * 10000) / 10000,
                  })
                  await sleep(16)
                }
                marks.push({ sh: list.scrollHeight, st: Math.round(list.scrollTop) })
              }
              // 抖动判定:滚动过程中 scrollHeight 波动幅度(真实化修正
              // 量化——估算 120px vs 短文本真实 ~45px,顶部估算区真实化
              // 时 scrollHeight 持续缩小)
              const shs = frames.map((f) => f.sh)
              const drift = Math.max(...shs) - Math.min(...shs)
              return JSON.stringify({ list: true, total, settled, listW, cv, diag, frames, marks, drift, jittery: drift > 80 })
              } catch (err) {
                return JSON.stringify({ fatal: String((err && err.stack) || err) })
              }
            })()`)
            console.log('[chat-media] scroll jitter probe:', scrollProbe)
            // 恢复大消息历史(后续 5. 恢复用 msgBackup)
            await js(
              `if (${JSON.stringify(scrollBackup)} === null) localStorage.removeItem('widget-agent-messages')
               else localStorage.setItem('widget-agent-messages', ${JSON.stringify(scrollBackup)})`,
            )
            // 清理:移除音频库条目 + island-uploads 上传记录(直接 IndexedDB)
            await js(`(async () => {
              try {
                const items = await window.__islandSettings?.listAudioLibrary?.() || []
                for (const it of items) {
                  if ((it.name || '').includes('巡检测试移交音频')) {
                    await window.__islandSettings?.removeAudioLibrary?.(it.id).catch(() => {})
                  }
                }
              } catch { /* 忽略 */ }
              try {
                const db = await new Promise((res, rej) => {
                  const req = indexedDB.open('island-uploads')
                  req.onsuccess = () => res(req.result)
                  req.onerror = () => rej(req.error)
                })
                await new Promise((res) => {
                  const tx = db.transaction('tracks', 'readwrite')
                  const st = tx.objectStore('tracks')
                  const req = st.getAll()
                  req.onsuccess = () => {
                    for (const it of req.result || []) {
                      if ((it.name || '').includes('巡检测试移交音频')) st.delete(it.key)
                    }
                    res()
                  }
                  req.onerror = () => res()
                })
                db.close()
              } catch { /* 忽略 */ }
              return 'cleaned'
            })()`)
            const chatImg = await win.webContents.capturePage()
            fs.writeFileSync(process.env.WIDGET_SCREENSHOT + '.chat-media.png', chatImg.toPNG())
            // 5. 恢复:清测试消息 + 切回音乐模式
            await js(`(async () => {
              if (${JSON.stringify(msgBackup)} === null) localStorage.removeItem('widget-agent-messages')
              else localStorage.setItem('widget-agent-messages', ${JSON.stringify(msgBackup)})
              localStorage.removeItem('widget-agent-mind')
              return 'restored'
            })()`)
            win.webContents.send('widget:set-mode', { mode: 'music', source: 'user' })
            console.log('[chat-media] done')
          }
          if (process.env.WIDGET_SCREENSHOT_MODE === 'hevc-frame') {
            // HEVC/AV1 播放验证巡检(2026-08-11 建,黑屏诊断;2026-08-12 改断言):
            // 真实应用内注入本地视频文件 → 轮询 rVFC 帧计数(帧是否真正呈现;
            // readyState/decodeError 检查不出"播放中但零帧呈现"= 全黑)。
            // 2026-08-12 起 HEVC 走自编译 ffmpeg 软解(apply-hevc-electron.mjs
            // 换装 electron.exe+ffmpeg.dll,media 层门控补丁 enable-hevc-ffmpeg-
            // decoding.patch)——断言改为:HEVC/AV1/H.264 全部帧数持续增长。
            // 未应用补丁时(官方 Electron)HEVC 显示 code 9 文案,黑屏检测仍在。
            // WIDGET_HEVC_VIDEO = 待测视频路径(缺省 bili Hi-res 20230404 HEVC)
            const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
            const js = (code) => win.webContents.executeJavaScript(code)
            const videoPath = process.env.WIDGET_HEVC_VIDEO
            const msgBackup = await js(`localStorage.getItem('widget-agent-messages')`)
            await js(`localStorage.removeItem('widget-agent-messages')`)
            win.webContents.reload()
            await sleep(3000)
            win.webContents.send('widget:set-mode', { mode: 'agent', source: 'user' })
            await sleep(1600)
            const expanded = await js(`(async () => {
              const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
              const island = document.querySelector('.island-demo')
              const r = island.getBoundingClientRect()
              const x = r.left + r.width / 2
              const y = r.top + r.height / 2
              island.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y, pointerId: 1, isPrimary: true, button: 0 }))
              setTimeout(() => island.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x, clientY: y, pointerId: 1, isPrimary: true, button: 0 })), 600)
              await sleep(1300)
              return island.classList.contains('expanded')
            })()`)
            console.log('[hevc-frame] expanded:', expanded, '| video:', videoPath)
            win.webContents.send('agent:event', {
              type: 'message',
              message: {
                id: 'hevc-frame-msg-1',
                role: 'assistant',
                parts: [
                  { type: 'text', text: 'HEVC 帧呈现测试' },
                  { type: 'media', kind: 'video', url: videoPath, name: path.basename(videoPath) },
                ],
              },
              usage: { input: 1, output: 1 },
            })
            const frHistory = []
            for (let i = 0; i < 8; i++) {
              await sleep(1500)
              const s = await js(`(async () => {
                const msg = [...document.querySelectorAll('.island-agent-msg-assistant')].find((m) => m.textContent.includes('HEVC 帧呈现测试'))
                if (!msg) return JSON.stringify({ msg: false })
                const video = msg.querySelector('video')
                if (!video) {
                  // 黑屏检测触发后 video 被替换为 MediaError(2026-08-11):
                  // 报错文案 = code 9(零帧/无法解码)的明确提示
                  const errEl = msg.querySelector('.island-agent-media-err')
                  return JSON.stringify({ msg: true, video: false, errText: errEl ? errEl.textContent.slice(0, 40) : null })
                }
                return JSON.stringify({
                  t: +video.currentTime.toFixed(1),
                  rs: video.readyState,
                  paused: video.paused,
                  err: video.error ? video.error.code : null,
                  vw: video.videoWidth,
                  vh: video.videoHeight,
                  fr: video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality().totalVideoFrames : -1,
                  dropped: video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality().droppedVideoFrames : -1,
                  visible: video.offsetWidth > 0 && video.offsetHeight > 0,
                })
              })()`)
              frHistory.push(JSON.parse(s))
              console.log('[hevc-frame]', s)
            }
            // 2026-08-12 断言:视频已解码并持续出帧(HEVC 走 ffmpeg 软解后与
            // H.264/AV1 同判据;code 9 文案出现 = 未应用 HEVC 补丁,诊断用)
            // 注意:找到 video 时返回的 JSON 无 msg/video 键(有 fr 即视频存在),
            // 仅 errText 分支带 {msg:true, video:false}
            const grown = frHistory.filter((p) => typeof p.fr === 'number' && p.fr >= 0)
            const framesGrow = grown.length >= 2 && grown[grown.length - 1].fr > grown[0].fr && grown[grown.length - 1].fr >= 10
            const errSeen = frHistory.some((p) => p.msg && !p.video && p.errText)
            console.log(`[hevc-frame] 断言:${framesGrow ? 'PASS' : 'FAIL'}(${grown.length ? `fr ${grown[0].fr} → ${grown[grown.length - 1].fr}` : '无视频元素'})${errSeen ? ' | 出现错误文案(未应用 HEVC 补丁?)' : ''}`)
            await js(`(async () => {
              if (${JSON.stringify(msgBackup)} === null) localStorage.removeItem('widget-agent-messages')
              else localStorage.setItem('widget-agent-messages', ${JSON.stringify(msgBackup)})
              localStorage.removeItem('widget-agent-mind')
              return 'restored'
            })()`)
            win.webContents.send('widget:set-mode', { mode: 'music', source: 'user' })
            console.log('[hevc-frame] done')
          }
          if (process.env.WIDGET_SCREENSHOT_MODE === 'skill-delete-check') {
            // 技能彻底删除巡检(2026-08-11 用户要求"灵动岛创建分区支持
            // 彻底删除,不在恢复区"):预置 userData/skills 测试技能 →
            // executeJavaScript 调 agentSkillDelete → 断言目录已删 +
            // 非自有目录不被误删
            const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
            const js = (code) => win.webContents.executeJavaScript(code)
            const ud = path.dirname(typeof settingsPath === 'function' ? settingsPath() : settingsPath)
            const skillsRoot = path.join(ud, 'skills')
            const delSlug = 'test-del-skill-20260811'
            const keepSlug = 'test-keep-skill-20260811'
            fs.mkdirSync(path.join(skillsRoot, delSlug), { recursive: true })
            fs.mkdirSync(path.join(skillsRoot, keepSlug), { recursive: true })
            fs.writeFileSync(path.join(skillsRoot, delSlug, 'SKILL.md'), '---\nname: test-del-skill\n---\n测试技能\n')
            fs.writeFileSync(path.join(skillsRoot, keepSlug, 'SKILL.md'), '---\nname: test-keep-skill\n---\n测试技能\n')
            await sleep(500)
            const res = await js(`window.desktop.agentSkillDelete(${JSON.stringify(delSlug)})`)
            const delGone = !fs.existsSync(path.join(skillsRoot, delSlug))
            const keepIntact = fs.existsSync(path.join(skillsRoot, keepSlug))
            console.log('[skill-delete-check] res:', JSON.stringify(res), '| delGone:', delGone, '| keepIntact:', keepIntact)
            // 非法 slug 拒绝(路径穿越防护)
            const bad = await js(`window.desktop.agentSkillDelete('..')`)
            console.log('[skill-delete-check] bad slug res:', JSON.stringify(bad))
            // 清理
            fs.rmSync(path.join(skillsRoot, delSlug), { recursive: true, force: true })
            fs.rmSync(path.join(skillsRoot, keepSlug), { recursive: true, force: true })
            console.log('[skill-delete-check] done')
          }
          if (process.env.WIDGET_SCREENSHOT_MODE === 'clear-data') {
            // 清除数据重启可交互性巡检(2026-08-10 用户实测"清除灵动岛
            // 数据后重启无法交互"):完整走 AgentSettingsView doClear 同款
            // 链路(localStorage.clear + 删 5 库 + agentClearData('app')
            // 删 userData 文件)→ 800ms 后 reload → 断言:页面加载 /
            // 岛体存在可展开 / IndexedDB 可重建 / 设置桥注册 / 模式正常;
            // **用户数据备份恢复**(userData 文件 + localStorage + IDB 记录)
            const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
            const js = (code) => win.webContents.executeJavaScript(code)
            // settingsPath 是函数(与 agent 巡检同款约定,返回路径字符串)
            const ud = path.dirname(typeof settingsPath === 'function' ? settingsPath() : settingsPath)
            const backupDir = path.join(app.getPath('temp'), 'island-clear-backup')
            fs.mkdirSync(backupDir, { recursive: true })
            // 备份 userData 数据文件 + localStorage
            for (const f of ['settings.json', 'memory.json', 'memory-state.json', 'evolution.json']) {
              try {
                fs.copyFileSync(path.join(ud, f), path.join(backupDir, f))
              } catch {
                // 不存在跳过
              }
            }
            try {
              fs.cpSync(path.join(ud, 'memory-snapshots'), path.join(backupDir, 'memory-snapshots'), { recursive: true })
            } catch {
              // 不存在跳过
            }
            const lsBackup = await js(`JSON.stringify(localStorage)`)
            // 基线对照(2026-08-10):清除前真实鼠标单击——区分"清除导致
            // 无法交互"与"巡检点击方式/挂件展开路径本身"
            const baseRect = await js(`(() => {
              const island = document.querySelector('.island-demo')
              if (!island) return null
              const r = island.getBoundingClientRect()
              return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
            })()`)
            // 基线:单击(120ms)与长按(600ms)对照——验证 sendInputEvent
            // 交互链路本身 + 挂件版展开路径(单击走 handleClick→onChange,
            // 长按走 450ms timer→changeExpanded)
            const baseClick = await (async () => {
              if (!baseRect) return 'no-island'
              win.webContents.sendInputEvent({ type: 'mouseMove', x: baseRect.x, y: baseRect.y })
              await sleep(300)
              win.webContents.sendInputEvent({ type: 'mouseDown', x: baseRect.x, y: baseRect.y, button: 'left', clickCount: 1 })
              await sleep(120)
              win.webContents.sendInputEvent({ type: 'mouseUp', x: baseRect.x, y: baseRect.y, button: 'left', clickCount: 1 })
              await sleep(1300)
              return js(`document.querySelector('.island-demo')?.classList.contains('expanded') ? 'expanded' : 'not-expanded'`)
            })()
            console.log('[clear-data] baseline click (before clear):', baseClick)
            // 长按展开对照(600ms > 450ms 阈值)
            const baseLong = await (async () => {
              if (!baseRect) return 'no-island'
              win.webContents.sendInputEvent({ type: 'mouseMove', x: baseRect.x, y: baseRect.y })
              await sleep(300)
              win.webContents.sendInputEvent({ type: 'mouseDown', x: baseRect.x, y: baseRect.y, button: 'left', clickCount: 1 })
              await sleep(600)
              win.webContents.sendInputEvent({ type: 'mouseUp', x: baseRect.x, y: baseRect.y, button: 'left', clickCount: 1 })
              await sleep(1300)
              return js(`document.querySelector('.island-demo')?.classList.contains('expanded') ? 'expanded' : 'not-expanded'`)
            })()
            console.log('[clear-data] baseline long-press (before clear):', baseLong)
            // 若基线已展开,先收起(避免影响后续注入)
            if (baseClick === 'expanded' || baseLong === 'expanded') {
              await js(`window.desktop?.setMode?.('music')`)
              await sleep(1000)
            }
            // 执行清除(与 AgentSettingsView doClear 同款)
            await js(`(async () => {
              localStorage.clear()
              const DB_NAMES = ['island-uploads', 'island-background', 'island-font', 'island-audio-library', 'island-video-library']
              for (const db of DB_NAMES) {
                await new Promise((res) => {
                  const req = indexedDB.deleteDatabase(db)
                  req.onsuccess = req.onerror = req.onblocked = () => res()
                })
              }
              return 'cleared'
            })()`)
            await js(`window.desktop?.agentClearData?.('app')`)
            await sleep(800)
            win.webContents.reload()
            await sleep(4000)
            // 检查:页面/岛体/桥/IDB 可重建/模式
            const check = await js(`(async () => {
              const island = document.querySelector('.island-demo')
              const idbOk = await new Promise((res) => {
                let done = false
                const finish = (v) => { if (!done) { done = true; res(v) } }
                const req = indexedDB.open('island-uploads')
                req.onsuccess = () => finish(true)
                req.onerror = () => finish(false)
                req.onblocked = () => finish(false)
                req.onupgradeneeded = () => finish(true)
                setTimeout(() => finish(false), 5000)
              })
              return JSON.stringify({
                body: !!document.body,
                island: !!island,
                islandRect: island ? (() => { const r = island.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) } })() : null,
                bridge: !!window.__islandSettings,
                idbOk,
                mode: localStorage.getItem('widget-mode'),
              })
            })()`)
            console.log('[clear-data] check:', check)
            // 交互:真实鼠标点击展开(sendInputEvent 注入——合成事件不经
            // 命中测试,点击穿透问题(岛体点不到)只能靠真实鼠标暴露)
            const rect = await js(`(() => {
              const island = document.querySelector('.island-demo')
              if (!island) return null
              const r = island.getBoundingClientRect()
              return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
            })()`)
            let expanded = 'no-island'
            if (rect) {
              win.webContents.sendInputEvent({ type: 'mouseMove', x: rect.x, y: rect.y })
              await sleep(300)
              win.webContents.sendInputEvent({ type: 'mouseDown', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
              await sleep(600)
              win.webContents.sendInputEvent({ type: 'mouseUp', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
              await sleep(1300)
              expanded = await js(`document.querySelector('.island-demo')?.classList.contains('expanded') ? 'expanded' : 'not-expanded'`)
            }
            console.log('[clear-data] real-mouse expand after clear:', expanded)
            // 交互 helper:确保紧凑态(展开则单击收起)+ 取岛体中心坐标
            const islandCenter = () =>
              js(`(() => {
                const island = document.querySelector('.island-demo')
                if (!island) return null
                const r = island.getBoundingClientRect()
                return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
              })()`)
            const isExpanded = () =>
              js(`document.querySelector('.island-demo')?.classList.contains('expanded') ? 'expanded' : 'not-expanded'`)
            const ensureCompact = async () => {
              if ((await isExpanded()) === 'expanded') {
                const c = await islandCenter()
                if (c) {
                  win.webContents.sendInputEvent({ type: 'mouseMove', x: c.x, y: c.y })
                  await sleep(300)
                  win.webContents.sendInputEvent({ type: 'mouseDown', x: c.x, y: c.y, button: 'left', clickCount: 1 })
                  await sleep(120)
                  win.webContents.sendInputEvent({ type: 'mouseUp', x: c.x, y: c.y, button: 'left', clickCount: 1 })
                  await sleep(1300)
                }
              }
            }
            // 长按展开(清除后,独立交互:先确保紧凑态)
            await ensureCompact()
            const longAfter = await (async () => {
              const c = await islandCenter()
              if (!c) return 'no-island'
              win.webContents.sendInputEvent({ type: 'mouseMove', x: c.x, y: c.y })
              await sleep(300)
              win.webContents.sendInputEvent({ type: 'mouseDown', x: c.x, y: c.y, button: 'left', clickCount: 1 })
              await sleep(600)
              win.webContents.sendInputEvent({ type: 'mouseUp', x: c.x, y: c.y, button: 'left', clickCount: 1 })
              await sleep(1300)
              return isExpanded()
            })()
            console.log('[clear-data] long-press expand after clear:', longAfter)
            // Agent 模式同样验证(用户清除前在 Agent 设置里操作;清除后
            // mode 回 music,切回 Agent 应可交互)——Agent 模式同样**长按**
            // 展开(单击留给文字区手势,不展开,2026-08-10 用户澄清)
            win.webContents.send('widget:set-mode', { mode: 'agent', source: 'user' })
            await sleep(1500)
            await ensureCompact()
            const agentLong = await (async () => {
              const c = await islandCenter()
              if (!c) return 'no-island'
              win.webContents.sendInputEvent({ type: 'mouseMove', x: c.x, y: c.y })
              await sleep(300)
              win.webContents.sendInputEvent({ type: 'mouseDown', x: c.x, y: c.y, button: 'left', clickCount: 1 })
              await sleep(600)
              win.webContents.sendInputEvent({ type: 'mouseUp', x: c.x, y: c.y, button: 'left', clickCount: 1 })
              await sleep(1300)
              return isExpanded()
            })()
            console.log('[clear-data] agent-mode expand after clear:', agentLong)
            if (
              expanded === 'expanded' &&
              longAfter === 'expanded' &&
              agentLong === 'expanded' &&
              check.includes('"island":true') &&
              check.includes('"idbOk":true')
            ) {
              console.log('[clear-data] INTERACT-AFTER-CLEAR: PASS')
            } else {
              console.error(`[clear-data] INTERACT-AFTER-CLEAR: FAIL check=${check} expand=${expanded} long=${longAfter} agentLong=${agentLong}`)
            }
            // 收起后交互(2026-08-10 用户实测"清除后收起,鼠标悬浮无响应、
            // 点击无响应"):长按收起时岛体/窗口收缩,鼠标在收缩掉的区域
            // 滑出岛体 → mouseleave → 穿透开启;穿透态 OS 不再投递鼠标
            // 事件,移回时 mouseenter 可能永不触发 = 穿透死锁。
            // **必须用真实 OS 鼠标(SetCursorPos)**——sendInputEvent 直接
            // 注入页面绕过穿透,是假阴性(实测 PASS 误报)。
            // 复现:边缘长按收起(鼠标滑出岛体)→ 真实鼠标移出窗口 →
            // 移回岛体 → 断言 hover 恢复(轮询校正 600ms 兜底)
            // 真实鼠标移动(SetCursorPos)与真实点击(mouse_event down/up)——
            // sendInputEvent 注入绕过穿透是假阴性;SetCursorPos 只移动不
            // 按下,真实点击必须 user32 mouse_event(2026-08-10 实测:
            // 只移动光标时页面收不到 down/up,click 计数 0 是假阳性)
            const psMouse = (script) => {
              try {
                require('node:child_process').execFileSync(
                  'powershell.exe',
                  ['-NoProfile', '-Command', script],
                  { windowsHide: true, timeout: 15000 },
                )
                return true
              } catch {
                return false
              }
            }
            const realMouse = (x, y) =>
              psMouse(
                `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${Math.round(x)}, ${Math.round(y)})`,
              )
            const realClick = (x, y) =>
              psMouse(
                `Add-Type -AssemblyName System.Windows.Forms; ` +
                  `Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class M { [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, System.UIntPtr e); }'; ` +
                  `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${Math.round(x)}, ${Math.round(y)}); ` +
                  `[M]::mouse_event(0x0002, 0, 0, 0, [System.UIntPtr]::Zero); Start-Sleep -Milliseconds 80; ` +
                  `[M]::mouse_event(0x0004, 0, 0, 0, [System.UIntPtr]::Zero)`,
              )
            win.webContents.send('widget:set-mode', { mode: 'music', source: 'user' })
            await sleep(1500)
            await ensureCompact()
            // 窗口屏幕 bounds + 岛体中心(屏幕坐标)
            const winBounds = win.getBounds()
            const c0 = await islandCenter()
            const screenCenter = c0
              ? { x: winBounds.x + c0.x, y: winBounds.y + c0.y }
              : null
            // 展开(长按)
            if (screenCenter) {
              realMouse(screenCenter.x, screenCenter.y)
              await sleep(400)
              win.webContents.sendInputEvent({ type: 'mouseDown', x: c0.x, y: c0.y, button: 'left', clickCount: 1 })
              await sleep(600)
              win.webContents.sendInputEvent({ type: 'mouseUp', x: c0.x, y: c0.y, button: 'left', clickCount: 1 })
              await sleep(1300)
            }
            const expAfterLong = await isExpanded()
            // 展开态面板宽(鼠标移到右缘再长按收起——收起后鼠标在岛外)
            const rightEdge = await js(`(() => {
              const island = document.querySelector('.island-demo')
              if (!island) return null
              const r = island.getBoundingClientRect()
              return { x: Math.round(r.right - 8), y: Math.round(r.top + r.height / 2) }
            })()`)
            if (expAfterLong === 'expanded' && rightEdge) {
              realMouse(winBounds.x + rightEdge.x, winBounds.y + rightEdge.y)
              await sleep(400)
              win.webContents.sendInputEvent({ type: 'mouseDown', x: rightEdge.x, y: rightEdge.y, button: 'left', clickCount: 1 })
              await sleep(600)
              win.webContents.sendInputEvent({ type: 'mouseUp', x: rightEdge.x, y: rightEdge.y, button: 'left', clickCount: 1 })
              await sleep(1500)
            }
            const collapsed = await isExpanded()
            console.log('[clear-data] collapse at edge:', collapsed)
            // 展开态交互(2026-08-10 用户实测"清除后长按呼出展开态就无法
            // 交互"):长按展开后面板内点击无响应——真实鼠标移到面板内
            // 按钮,断言 hover(穿透死锁/事件丢失时 hover false)
            win.webContents.send('widget:set-mode', { mode: 'music', source: 'user' })
            await sleep(1500)
            await ensureCompact()
            const cE = await islandCenter()
            if (cE) {
              realMouse(winBounds.x + cE.x, winBounds.y + cE.y)
              await sleep(400)
              win.webContents.sendInputEvent({ type: 'mouseDown', x: cE.x, y: cE.y, button: 'left', clickCount: 1 })
              await sleep(600)
              win.webContents.sendInputEvent({ type: 'mouseUp', x: cE.x, y: cE.y, button: 'left', clickCount: 1 })
              await sleep(1500)
            }
            const expState = await isExpanded()
            // 面板内第一个按钮(播放键/进度条等)中心 → 屏幕坐标
            const btnRect = await js(`(() => {
              const btn = document.querySelector('.island-demo .island-panel button') || document.querySelector('.island-demo .island-panel [role="slider"]')
              if (!btn) return null
              const r = btn.getBoundingClientRect()
              return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
            })()`)
            if (expState === 'expanded' && btnRect) {
              realMouse(winBounds.x + btnRect.x, winBounds.y + btnRect.y)
              await sleep(900)
            }
            const btnHover = await js(`(() => {
              const btn = document.querySelector('.island-demo .island-panel button') || document.querySelector('.island-demo .island-panel [role="slider"]')
              return btn ? (btn.matches(':hover') ? 'hovered' : 'not-hovered') : 'no-btn'
            })()`)
            console.log('[clear-data] panel button hover (expanded):', btnHover)
            // 真实鼠标点击面板按钮(播放键等):事件计数证明点击到达页面
            // (穿透死锁时点击事件被 OS 拦截,计数不增)
            // 返回值 'armed' 不用,仅副作用(挂监听器)必要
            await js(`(() => {
              window.__panelClickDiag = { down: 0, up: 0 }
              document.addEventListener('pointerdown', () => window.__panelClickDiag.down++)
              document.addEventListener('pointerup', () => window.__panelClickDiag.up++)
              return 'armed'
            })()`)
            if (btnRect) {
              realMouse(winBounds.x + btnRect.x, winBounds.y + btnRect.y)
              await sleep(500)
              realMouse(winBounds.x + btnRect.x + 1, winBounds.y + btnRect.y)
              await sleep(200)
              // 真实点击:user32 mouse_event down → up(穿透拦截时事件
              // 到不了页面,计数不增)
              realClick(winBounds.x + btnRect.x, winBounds.y + btnRect.y)
              await sleep(400)
            }
            const panelClick = await js(`JSON.stringify(window.__panelClickDiag || null)`)
            console.log('[clear-data] panel click diag:', panelClick)
            const clickOk = panelClick && panelClick.includes('"down":1') && panelClick.includes('"up":1')
            if (btnHover === 'hovered' && clickOk) {
              console.log('[clear-data] PANEL-INTERACT: PASS')
            } else {
              console.error(`[clear-data] PANEL-INTERACT: FAIL 展开态面板交互异常 expState=${expState} btnHover=${btnHover} click=${panelClick}`)
            }
            // 真实鼠标移出窗口(屏幕坐标窗口外)
            realMouse(winBounds.x + winBounds.width + 200, winBounds.y + winBounds.height + 200)
            await sleep(800)
            // 真实鼠标移回岛体中心 → 等轮询校正(600ms×3)
            if (collapsed === 'not-expanded' && screenCenter) {
              realMouse(screenCenter.x, screenCenter.y)
              await sleep(2000)
            }
            const hoverAfter = await js(`(() => {
              const island = document.querySelector('.island-demo')
              return island ? (island.matches(':hover') ? 'hovered' : 'not-hovered') : 'no-island'
            })()`)
            console.log('[clear-data] hover after move-back:', hoverAfter)
            // 若轮询校正了穿透(接收),主进程补发的 mousemove 已让 hover
            // 恢复;兜底对照:真实鼠标 1px 抖动(模拟用户微动)后 hover
            // 应恢复——两者任一恢复即证明穿透已校正(非死锁)
            if (hoverAfter !== 'hovered' && screenCenter) {
              realMouse(screenCenter.x + 1, screenCenter.y)
              await sleep(500)
              realMouse(screenCenter.x, screenCenter.y)
              await sleep(500)
            }
            const hoverAfterJitter = await js(`(() => {
              const island = document.querySelector('.island-demo')
              return island ? (island.matches(':hover') ? 'hovered' : 'not-hovered') : 'no-island'
            })()`)
            console.log('[clear-data] hover after jitter:', hoverAfterJitter)
            // 单击(双击播放/暂停语义)应有效:文字区手势
            const clickAfter = await (async () => {
              const c = await islandCenter()
              if (!c) return 'no-island'
              win.webContents.sendInputEvent({ type: 'mouseDown', x: c.x, y: c.y, button: 'left', clickCount: 1 })
              await sleep(80)
              win.webContents.sendInputEvent({ type: 'mouseUp', x: c.x, y: c.y, button: 'left', clickCount: 1 })
              await sleep(300)
              return js(`(async () => {
                const island = document.querySelector('.island-demo')
                // 单击(120ms)不应展开(长按才展开)——若事件未到达页面,
                // 双击语义无从谈起;这里断言事件仍能触发文字区(点击后
                // 无展开 = 事件到达但按设计不展开)
                return island ? 'click-sent' : 'no-island'
              })()`)
            })()
            console.log('[clear-data] click after collapse:', clickAfter)
            if (hoverAfter === 'hovered' || hoverAfterJitter === 'hovered') {
              console.log('[clear-data] HOVER-AFTER-COLLAPSE: PASS')
            } else {
              console.error(`[clear-data] HOVER-AFTER-COLLAPSE: FAIL 收起后移回岛体 hover 未恢复(穿透死锁) collapsed=${collapsed} hover=${hoverAfter} jitter=${hoverAfterJitter}`)
            }
            // 恢复用户数据(localStorage + userData 文件 + snapshots),再 reload
            await js(`(async () => {
              try {
                const saved = ${lsBackup}
                localStorage.clear()
                for (const k of Object.keys(saved)) localStorage.setItem(k, saved[k])
              } catch (e) { /* 忽略 */ }
              return 'ls-restored'
            })()`)
            for (const f of ['settings.json', 'memory.json', 'memory-state.json', 'evolution.json']) {
              try {
                fs.copyFileSync(path.join(backupDir, f), path.join(ud, f))
              } catch {
                // 备份不存在跳过
              }
            }
            try {
              fs.cpSync(path.join(backupDir, 'memory-snapshots'), path.join(ud, 'memory-snapshots'), { recursive: true })
            } catch {
              // 备份不存在跳过
            }
            resetSettingsCache()
            win.webContents.reload()
            await sleep(3000)
            console.log('[clear-data] restored & reloaded')
          }
          if (process.env.WIDGET_SCREENSHOT_MODE === 'mini') {
            // 视频岛小窗巡检(2026-08-09 用户要求 UI 验证):切 Agent →
            // 展开 → 注入视频 → 播放(进度上报)→ 收起 → 小窗断言:
            // 进度条存在且随播放前进 / 全屏进入 / **全屏中右键拖拽
            // 移动窗口尺寸不变**(回归"全屏拖拽窗口越来越大")。
            // 合成事件即可驱动(React 事件系统,无需 sendInputEvent)
            const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
            const js = (code) => win.webContents.executeJavaScript(code)
            const msgBackup = await js(`localStorage.getItem('widget-agent-messages')`)
            const tmpVideo = path.join(app.getPath('temp'), 'ui-test-mini.webm')
            const out = {}
            try {
              // 1. 切 Agent 模式 + 长按展开
              win.webContents.send('widget:set-mode', { mode: 'agent', source: 'user' })
              await sleep(1600)
              out.expanded = await js(`(async () => {
                const island = document.querySelector('.island-demo')
                const r = island.getBoundingClientRect()
                island.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, pointerId: 31, isPrimary: true, button: 0 }))
                await new Promise((res) => setTimeout(res, 600))
                island.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, pointerId: 31, isPrimary: true, button: 0 }))
                await new Promise((res) => setTimeout(res, 1300))
                return island.classList.contains('expanded')
              })()`)
              // 2. 视频源:优先 JiJiDown 真实 mp4(有正确 duration,播放/seek
              // 正常);回退 MediaRecorder webm(2026-08-09 实测坑:canvas
              // 录制的 webm 在 Chromium 中 duration 异常 ≈0,play() 立即
              // "interrupted by end of playback",收起时 playing 恒 false)
              let miniVideoPath = null
              try {
                const jijiFiles = fs.readdirSync('C:\\Program Files\\JiJiDown\\Download')
                const mp4 = jijiFiles.find((f) => /\.mp4$/i.test(f))
                miniVideoPath = mp4 ? path.join('C:\\Program Files\\JiJiDown\\Download', mp4) : null
              } catch {
                // 目录不可读:回退
              }
              let videoDataUrl = null
              if (!miniVideoPath) {
                videoDataUrl = await js(`(async () => {
                  try {
                    const canvas = document.createElement('canvas')
                    canvas.width = 320; canvas.height = 180
                    const ctx = canvas.getContext('2d')
                    ctx.fillStyle = '#4d6bfe'; ctx.fillRect(0, 0, 320, 180)
                    ctx.fillStyle = '#fff'; ctx.font = '26px sans-serif'; ctx.fillText('MINI', 120, 100)
                    const stream = canvas.captureStream(10)
                    const rec = new MediaRecorder(stream, { mimeType: 'video/webm' })
                    const chunks = []
                    rec.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data) }
                    const done = new Promise((res) => { rec.onstop = () => res() })
                    rec.start()
                    await new Promise((r) => setTimeout(r, 3000))
                    rec.stop()
                    await done
                    const blob = new Blob(chunks, { type: 'video/webm' })
                    return await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(blob) })
                  } catch (e) {
                    return 'ERR:' + String((e && e.message) || e)
                  }
                })()`)
              }
              out.videoSource = miniVideoPath ? 'jiji:' + path.basename(miniVideoPath) : 'recorder'
              out.videoDataOk = miniVideoPath !== null || (typeof videoDataUrl === 'string' && videoDataUrl.startsWith('data:'))
              if (out.videoDataOk) {
                if (!miniVideoPath) {
                  fs.writeFileSync(tmpVideo, Buffer.from(videoDataUrl.slice(videoDataUrl.indexOf(',') + 1), 'base64'))
                  miniVideoPath = tmpVideo
                }
                // 挂载事件监听统计(诊断 2026-08-09:渲染端 console 不转发,
                // 从巡检侧统计 AGENT_MEDIA_EVENT 派发情况)
                await js(`(() => {
                  window.__mediaEvents = []
                  document.addEventListener('island:agent-media', (e) => {
                    window.__mediaEvents.push({ type: e.detail.type, kind: e.detail.media?.kind, playing: e.detail.media?.playing, pos: e.detail.media?.position, src: String(e.detail.media?.src ?? '').slice(0, 50) })
                  })
                })()`)
                // 注入媒体消息:视频先、**图片后**(2026-08-10 需求验证:
                // 数据顺序最后媒体 = 图片,播放中的视频在中——收起应触发
                // 视频岛而非图片岛,证明"播放中媒体优先")
                win.webContents.send('agent:event', {
                  type: 'message',
                  message: {
                    id: 'ui-test-mini-msg',
                    role: 'assistant',
                    parts: [
                      { type: 'text', text: '巡检测试小窗视频' },
                      { type: 'media', kind: 'video', url: miniVideoPath, name: path.basename(miniVideoPath) },
                    ],
                  },
                  usage: { input: 1, output: 1 },
                })
                win.webContents.send('agent:event', {
                  type: 'message',
                  message: {
                    id: 'ui-test-mini-img',
                    role: 'assistant',
                    parts: [
                      { type: 'text', text: '巡检测试小窗图片' },
                      {
                        type: 'media',
                        kind: 'img',
                        url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
                        name: 'mini.png',
                      },
                    ],
                  },
                  usage: { input: 1, output: 1 },
                })
                await sleep(1800)
                // 2.5 视频封面断言(2026-08-10 用户要求"默认展示第一帧
                // 作为封面"):注入后未播放,canvas 抓帧转 dataURL 应已
                // 渲染为 .island-video-poster(黑色画面不再难辨认);
                // 抓帧需 loadeddata + seek(0.05) + seeked 完成,等足
                // 诊断:play 事件来源(2026-08-10 曾出现视频自动播放,
                // 封面被 !paused 条件拦截)
                await js(`(() => {
                  window.__playEv = []
                  document.addEventListener('play', (e) => {
                    if (e.target && e.target.tagName === 'VIDEO') {
                      window.__playEv.push({ t: Date.now(), src: String(e.target.currentSrc || '').slice(0, 40) })
                    }
                  }, true)
                })()`)
                await sleep(2000)
                out.posterCheck = await js(`(async () => {
                  const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
                  const msg = [...document.querySelectorAll('.island-agent-msg-assistant')].find((m) => m.textContent.includes('巡检测试小窗视频'))
                  const v = msg?.querySelector('video')
                  const poster = msg?.querySelector('.island-video-poster')
                  const src = poster?.getAttribute('src') ?? ''
                  // 手动抓帧诊断(组件逻辑 vs 视频帧本身)
                  let manual = null
                  if (v) {
                    try {
                      const restore = v.currentTime
                      v.currentTime = 0.05
                      await sleep(250)
                      const c = document.createElement('canvas')
                      c.width = 160
                      c.height = 90
                      c.getContext('2d')?.drawImage(v, 0, 0, 160, 90)
                      const d = c.toDataURL('image/jpeg', 0.7)
                      manual = { len: d.length, prefix: d.slice(0, 30) }
                      v.currentTime = restore
                    } catch (e) {
                      manual = { err: String((e && e.message) || e) }
                    }
                  }
                  return {
                    found: !!poster,
                    srcLen: src.length,
                    dataUrl: src.startsWith('data:image/jpeg'),
                    readyState: v?.readyState ?? -1,
                    cur: v ? Math.round(v.currentTime * 100) / 100 : -1,
                    paused: v?.paused ?? true,
                    hasError: v ? !!v.error : false,
                    manual,
                    playEv: (window.__playEv || []).slice(0, 5),
                  }
                })()`)
                // 3. 播放(触发 onMediaSnapshot 数据上报 + 播放事件进度上报)。
                // **必须按注入消息文本定位**(2026-08-09 实测坑:用户历史
                // 消息含 JiJiDown 真实视频,querySelector 取第一个 = 旧消息
                // 视频,播放事件 src 与收起快照不匹配,playing 恒 false)
                const played = await js(`(async () => {
                  const msg = [...document.querySelectorAll('.island-agent-msg-assistant')].find((m) => m.textContent.includes('巡检测试小窗视频'))
                  const v = msg ? msg.querySelector('video') : null
                  if (!v) return 'no-video'
                  try { await v.play(); return 'played' } catch (e) { return 'ERR:' + String((e && e.message) || e) }
                })()`)
                // 3.5 **对话窗口内媒体全屏范围(2026-08-10 需求:对话内全屏
                // 只覆盖 Agent 窗口,不放大到屏幕——isMini=false 路径)**:
                // 展开态点击消息气泡视频全屏按钮,窗口尺寸应不变
                const panelSize0 = win.getSize()
                await js(`(() => {
                  const msg = [...document.querySelectorAll('.island-agent-msg-assistant')].find((m) => m.textContent.includes('巡检测试小窗视频'))
                  msg?.querySelector('.island-video-fs')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
                })()`)
                await sleep(800)
                const panelFs = await js(`!!document.fullscreenElement`)
                const panelSize1 = win.getSize()
                await js(`(() => { document.exitFullscreen?.().catch(() => {}) })()`)
                await sleep(600)
                out.panelFs = panelFs
                out.panelFsWindowStable = panelSize0[0] === panelSize1[0] && panelSize0[1] === panelSize1[1]
                out.panelFsSize0 = panelSize0
                out.panelFsSize1 = panelSize1
                // 3.6 独立收起按钮已移除(2026-08-10 用户要求:仅 ⋯ 菜单
                // 两项收起;独立按钮冗余已删)
                out.collapseBtnRemoved = await js(`!document.querySelector('.island-agent-collapse-btn')`)
                // 3.7 图片全屏按钮(2026-08-10 需求:对话窗口图片支持全屏)
                out.imgFsBtn = await js(`(() => {
                  const msg = [...document.querySelectorAll('.island-agent-msg-assistant')].find((m) => m.textContent.includes('巡检测试小窗图片'))
                  return !!msg?.querySelector('.island-video-fs')
                })()`)
                // 3.8 定制视频控件(2026-08-10 用户要求:音量 + 更多选项,
                // 对话播放器定制 UI;收起后视频岛同款)
                out.dialogExtras = await js(`(() => {
                  const msg = [...document.querySelectorAll('.island-agent-msg-assistant')].find((m) => m.textContent.includes('巡检测试小窗视频'))
                  const ex = msg?.querySelector('.island-video-extras')
                  return {
                    extras: !!ex,
                    volSlider: !!ex?.querySelector('.island-video-vol-pop'),
                    moreBtn: !!ex?.querySelector('.island-video-more-btn'),
                    prefs: localStorage.getItem('widget-video-prefs'),
                  }
                })()`)
                out.played = played
                // 播后 600ms 即收起(2026-08-09:视频 3s,确保播放事件已
                // 派发且未播完——播完 playing 变 false,小窗不自动续播)
                await sleep(600)
                // 播放事件统计(诊断):收起前事件是否派发 + 快照依据
                out.mediaEvents = await js(`JSON.stringify((window.__mediaEvents || []).slice(0, 8))`)
                // 4. 收起为灵动岛(2026-08-10:⋯ 菜单项 = 收起成 Agent
                // 紧凑态,**不生成媒体岛**;独立按钮已移除)
                const collapsed = await js(`(async () => {
                  const menu = document.querySelector('.island-agent-head .island-quick-menu')
                  menu?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: null }))
                  await new Promise((res) => setTimeout(res, 300))
                  const item = [...(document.querySelectorAll('.island-agent-head .island-quick-menu-item') ?? [])].find((b) => b.textContent.includes('收起为灵动岛'))
                  item?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
                  await new Promise((res) => setTimeout(res, 1500))
                  return {
                    itemFound: !!item,
                    collapsed: !document.querySelector('.island-demo').classList.contains('expanded'),
                    // 紧凑态:无媒体岛
                    mini: !!document.querySelector('.island-agent-mini'),
                  }
                })()`)
                out.collapsedMini = collapsed
                // 4.5 收起为多媒体岛(⋯ 菜单):重新展开 → 菜单项 → 应触发
                // **视频岛**(播放中视频优先,数据最后媒体是图片)
                const expandedAgain = await js(`(async () => {
                  const island = document.querySelector('.island-demo')
                  const r = island.getBoundingClientRect()
                  island.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, pointerId: 32, isPrimary: true, button: 0 }))
                  await new Promise((res) => setTimeout(res, 600))
                  island.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, pointerId: 32, isPrimary: true, button: 0 }))
                  await new Promise((res) => setTimeout(res, 1400))
                  return island.classList.contains('expanded')
                })()`)
                const collapseMedia = await js(`(async () => {
                  if (!${JSON.stringify(expandedAgain)}) return { expanded: false }
                  const menu = document.querySelector('.island-agent-head .island-quick-menu')
                  menu?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: null }))
                  await new Promise((res) => setTimeout(res, 300))
                  const item = [...(document.querySelectorAll('.island-agent-head .island-quick-menu-item') ?? [])].find((b) => b.textContent.includes('收起为多媒体岛'))
                  item?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
                  await new Promise((res) => setTimeout(res, 1500))
                  return {
                    itemFound: !!item,
                    mini: !!document.querySelector('.island-agent-mini'),
                    // 播放中视频优先:小窗应为视频(video 元素),非最后
                    // 媒体的图片(img)
                    isVideo: !!document.querySelector('.island-agent-mini video'),
                    isImage: !!document.querySelector('.island-agent-mini img'),
                  }
                })()`)
                out.collapseMedia = collapseMedia
                // 5.0 小窗状态截图 + DOM 几何诊断(2026-08-13 边缘 UI
                // 巡检:圆角外矩形残留检查)——与最终截图错开保存
                out.miniGeom = await js(`(() => {
                  const island = document.querySelector('.island-demo')
                  const mini = document.querySelector('.island-agent-mini')
                  const v = document.querySelector('.island-agent-mini video')
                  const cs = island ? getComputedStyle(island) : null
                  const r = (el) => el ? el.getBoundingClientRect() : null
                  const ir = r(island); const mr = r(mini); const vr = r(v)
                  return {
                    islandRect: ir ? { x: Math.round(ir.x), y: Math.round(ir.y), w: Math.round(ir.width), h: Math.round(ir.height) } : null,
                    islandRadius: cs ? cs.borderRadius : null,
                    islandOverflow: cs ? cs.overflow : null,
                    islandPadding: cs ? cs.padding : null,
                    islandBg: cs ? cs.backgroundColor : null,
                    miniRect: mr ? { w: Math.round(mr.width), h: Math.round(mr.height) } : null,
                    miniRadius: mini ? getComputedStyle(mini).borderRadius : null,
                    miniOverflow: mini ? getComputedStyle(mini).overflow : null,
                    videoRect: vr ? { w: Math.round(vr.width), h: Math.round(vr.height) } : null,
                    videoNatural: v ? v.videoWidth + 'x' + v.videoHeight : null,
                    classes: island ? island.className : null,
                  }
                })()`)
                try {
                  const miniImg = await win.webContents.capturePage()
                  const shotPath = process.env.WIDGET_SCREENSHOT
                  const miniShotPath = shotPath
                    ? shotPath.replace(/\.png$/i, '') + '-mini.png'
                    : path.join(app.getPath('temp'), 'mini-island.png')
                  fs.writeFileSync(miniShotPath, miniImg.toPNG())
                  console.log(`[widget] screenshot(mini-island) saved → ${miniShotPath}`)
                } catch {
                  // 截图失败不影响巡检
                }
                // 截图后再取一次几何(诊断:截图与 DOM 状态是否一致)
                out.miniGeomAfter = await js(`(() => {
                  const island = document.querySelector('.island-demo')
                  const v = document.querySelector('.island-agent-mini video')
                  const ir = island?.getBoundingClientRect()
                  const vr = v?.getBoundingClientRect()
                  return {
                    islandRect: ir ? { x: Math.round(ir.x), y: Math.round(ir.y), w: Math.round(ir.width), h: Math.round(ir.height) } : null,
                    videoRect: vr ? { x: Math.round(vr.x), y: Math.round(vr.y), w: Math.round(vr.width), h: Math.round(vr.height) } : null,
                    bodyW: document.body.getBoundingClientRect().width,
                    bodyH: document.body.getBoundingClientRect().height,
                  }
                })()`)
                out.miniWindowSize = win.getSize()
                // 5. 小窗断言:进度条存在 + 播放中 + 进度条填充随播放前进
                const miniProbe1 = JSON.parse(await js(`(() => {
                  const bar = document.querySelector('.island-agent-mini-bar')
                  const video = document.querySelector('.island-agent-mini video')
                  const fill = document.querySelector('.island-agent-mini-fill')
                  return JSON.stringify({
                    bar: !!bar,
                    time: document.querySelector('.island-agent-mini-time')?.textContent ?? '(无)',
                    fillW: fill ? Math.round(fill.getBoundingClientRect().width) : 0,
                    playing: video ? !video.paused : false,
                    cur: video ? Math.round(video.currentTime * 10) / 10 : -1,
                  })
                })()`))
                await sleep(2500)
                const miniProbe2 = JSON.parse(await js(`(() => {
                  const video = document.querySelector('.island-agent-mini video')
                  const fill = document.querySelector('.island-agent-mini-fill')
                  return JSON.stringify({
                    fillW: fill ? Math.round(fill.getBoundingClientRect().width) : 0,
                    cur: video ? Math.round(video.currentTime * 10) / 10 : -1,
                  })
                })()`))
                out.mini = { ...miniProbe1, ...miniProbe2 }
                out.progressBarShown = miniProbe1.bar
                out.progressAdvancing = miniProbe2.cur > miniProbe1.cur
                // 视频岛定制控件(2026-08-10:与对话播放器同款音量/更多)
                out.miniExtras = await js(`(() => {
                  const w = document.querySelector('.island-agent-mini')
                  const ex = w?.querySelector('.island-video-extras')
                  return {
                    extras: !!ex,
                    volSlider: !!ex?.querySelector('.island-video-vol-pop'),
                    moreBtn: !!ex?.querySelector('.island-video-more-btn'),
                  }
                })()`)
                // 5.5 全屏键命中测试(2026-08-09 用户报告"全屏键点不到,
                // 只有小部分可点":进度条 z 3 覆盖按钮 z 2,合成事件不经
                // 命中测试——elementFromPoint 验证按钮中心真实可点)
                out.fsHit = await js(`(() => {
                  const btn = document.querySelector('.island-agent-mini-fs')
                  if (!btn) return { found: false }
                  const r = btn.getBoundingClientRect()
                  const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
                  return {
                    found: true,
                    hitIsBtn: el === btn || btn.contains(el),
                    hitClass: el ? el.className : '(无)',
                    btnZ: getComputedStyle(btn).zIndex,
                    barZ: document.querySelector('.island-agent-mini-bar') ? getComputedStyle(document.querySelector('.island-agent-mini-bar')).zIndex : '(无进度条)',
                  }
                })()`)
                // 6. 全屏进入(记录进入前小窗位置,退出回原位断言用)
                const fsPrePos = win.getPosition()
                await js(`(() => {
                  document.querySelector('.island-agent-mini-fs')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
                })()`)
                await sleep(900)
                out.fullscreen = await js(`!!document.fullscreenElement`)
                // 7. **全屏期间 set-size 泄漏回归(2026-08-09"全屏拖拽
                // 越来越大"根因测试)**:全屏层 = 100% viewport,全屏期间
                // 任何 setWindowSize(布局变化/拖拽触发的泄漏路径)都会
                // 让全屏层跟随 resize 放大。验证防护:全屏中直接注入
                // setWindowSize(900,700)——渲染端 setWinSize fullscreenRef
                // 守卫 + 主进程 widgetFullscreen 兜底,**窗口尺寸应不变**;
                // 退出全屏后再次注入,尺寸应正常跟随(守卫只在全屏期间)
                // **注意:不模拟真实右键拖拽**(2026-08-09 实测:合成
                // PointerEvent 的 pointerId 未注册活跃指针,setPointerCapture
                // 抛错;sendInputEvent 的 screenX/screenY 恒为 0,pressOffset
                // 成负窗口位置,setPosition 恒回原位——两种方式都走不通
                // 真实拖拽;拖拽本身只 setPosition 不动尺寸,泄漏路径 =
                // 拖拽期间被触发的 set-size,直接注入等价覆盖)
                const sizeBefore = win.getSize()
                await js(`(() => {
                  // 渲染端守卫路径(setWinSize)
                  window.desktop?.setWindowSize?.(900, 700)
                })()`)
                await sleep(500) // 主进程合帧 100ms + 余量
                const sizeAfterLeak = win.getSize()
                out.sizeBefore = sizeBefore
                out.sizeAfterLeak = sizeAfterLeak
                out.leakBlocked =
                  sizeBefore[0] === sizeAfterLeak[0] && sizeBefore[1] === sizeAfterLeak[1]
                out.stillFullscreen = await js(`!!document.fullscreenElement`)
                // 7.5 **窗口移动尺寸稳定测试(2026-08-09 用户复现"拖拽
                // 移动越来越大"**:setPosition 移动窗口本身是否触发尺寸
                // 变化——真实拖拽 = 移动 + 期间可能的 set-size;这里直接
                // 用主进程 setPosition 模拟移动,观察尺寸与 set-size 日志)
                const posM = win.getPosition()
                const sizeM0 = win.getSize()
                win.setPosition(posM[0] + 90, posM[1] + 50)
                await sleep(400)
                const sizeM1 = win.getSize()
                win.setPosition(posM[0] + 200, posM[1] + 110)
                await sleep(400)
                const sizeM2 = win.getSize()
                out.moveSize0 = sizeM0
                out.moveSize1 = sizeM1
                out.moveSize2 = sizeM2
                out.moveSizeStable =
                  sizeM0[0] === sizeM1[0] && sizeM0[1] === sizeM1[1] &&
                  sizeM1[0] === sizeM2[0] && sizeM1[1] === sizeM2[1]
                // 7.6 **sendInputEvent 完整右键拖拽序列**(诊断 2026-08-09
                // 用户复现:拖拽期间是否触发 set-size——主进程全量日志
                // 会打出任何泄漏;sendInputEvent 的 screenX 恒 0 导致
                // setPosition 回原位,但渲染端事件流(pointerdown → 长按
                // → dragStart → dragMove)完整驱动,泄漏路径同等触发)
                const dragPt = await js(`(() => {
                  const wrap = document.querySelector('.island-agent-mini')
                  const r = wrap ? wrap.getBoundingClientRect() : null
                  return r ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : null
                })()`)
                const sizeD0 = win.getSize()
                if (dragPt) {
                  win.webContents.sendInputEvent({ type: 'mouseDown', x: dragPt.x, y: dragPt.y, button: 'right', clickCount: 1 })
                  await sleep(700)
                  for (let i = 1; i <= 8; i++) {
                    win.webContents.sendInputEvent({ type: 'mouseMove', x: dragPt.x + i * 10, y: dragPt.y + i * 5 })
                    await sleep(60)
                  }
                  win.webContents.sendInputEvent({ type: 'mouseUp', x: dragPt.x + 80, y: dragPt.y + 40, button: 'right', clickCount: 1 })
                  await sleep(600)
                }
                const sizeD1 = win.getSize()
                out.dragSeqSize0 = sizeD0
                out.dragSeqSize1 = sizeD1
                out.dragSeqSizeStable = sizeD0[0] === sizeD1[0] && sizeD0[1] === sizeD1[1]
                // 7.7 **全屏层尺寸漂移检测(2026-08-09 用户"窗口越来越大"
                // 的最后疑点**:窗口尺寸不变但全屏视频画面变大 = 用户感知
                // 为窗口变大——全屏层(wrap)rect 在窗口移动后是否漂移,
                // Electron 透明窗口 + DOM 全屏 + setPosition 组合的已知
                // 风险点)
                const wrapRect0 = JSON.parse(await js(`(() => {
                  const w = document.querySelector('.island-agent-mini')
                  const r = w ? w.getBoundingClientRect() : null
                  return r ? JSON.stringify({ w: Math.round(r.width), h: Math.round(r.height) }) : 'null'
                })()`))
                const posW = win.getPosition()
                win.setPosition(posW[0] + 120, posW[1] + 70)
                await sleep(500)
                const wrapRect1 = JSON.parse(await js(`(() => {
                  const w = document.querySelector('.island-agent-mini')
                  const r = w ? w.getBoundingClientRect() : null
                  return r ? JSON.stringify({ w: Math.round(r.width), h: Math.round(r.height) }) : 'null'
                })()`))
                win.setPosition(posW[0], posW[1])
                await sleep(500)
                out.wrapRect0 = wrapRect0
                out.wrapRect1 = wrapRect1
                out.wrapRectStable =
                  !!wrapRect0 && !!wrapRect1 && wrapRect0.w === wrapRect1.w && wrapRect0.h === wrapRect1.h
                // 退出全屏:注入应正常生效(守卫只在全屏期间,不误伤
                // 正常路径)
                await js(`(() => { document.exitFullscreen?.().catch(() => {}) })()`)
                await sleep(600)
                // 退出全屏回原位断言(2026-08-10 用户要求"缩回到原来展开
                // 时的小窗位置"):主进程恢复 preFsBounds(位置 + 尺寸),
                // 小窗应回到**进入全屏前**的位置(巡检 7.5 在全屏中移动过
                // 窗口,退出后不得停留全屏位置,必须回到进入前位置)
                const posAfterExit = win.getPosition()
                out.posAfterExit = posAfterExit
                out.exitRestoredPos =
                  posAfterExit[0] === fsPrePos[0] && posAfterExit[1] === fsPrePos[1]
                await js(`(() => {
                  window.desktop?.setWindowSize?.(700, 500)
                })()`)
                await sleep(500)
                const sizeAfterExit = win.getSize()
                out.sizeAfterExit = sizeAfterExit
                out.resumeFollows = sizeAfterExit[0] === 700 && sizeAfterExit[1] === 500
                // 8. 退出全屏(防御:已退出则 no-op)
                await js(`(() => { document.exitFullscreen?.().catch(() => {}) })()`)
                await sleep(600)
              }
            } catch (err) {
              out.error = String((err && err.stack) || err)
            } finally {
              // 恢复:删临时文件 + 恢复消息 + 切回音乐模式
              try {
                fs.rmSync(tmpVideo, { force: true })
              } catch {
                // 忽略
              }
              await js(`(async () => {
                if (${JSON.stringify(msgBackup)} === null) localStorage.removeItem('widget-agent-messages')
                else localStorage.setItem('widget-agent-messages', ${JSON.stringify(msgBackup)})
                localStorage.removeItem('widget-agent-mind')
              })()`)
              win.webContents.send('widget:set-mode', { mode: 'music', source: 'user' })
            }
            console.log('[widget] mini-test:', JSON.stringify(out))
          }
          if (process.env.WIDGET_SCREENSHOT_MODE === 'session-cleanup') {
            // 一次性清理(2026-08-13 session-debug 巡检期间污染了用户真实
            // localStorage):移除 mock LLM 回显/测试输入消息与测试会话键
            const result = await win.webContents.executeJavaScript(`(() => {
              const out = { removedMain: 0, removedKeys: [] }
              const TEST_MARKS = ['$$napcat-send$$', '会话里输入的消息B', '【已收到】']
              try {
                const raw = localStorage.getItem('widget-agent-messages')
                if (raw) {
                  let msgs = JSON.parse(raw)
                  if (Array.isArray(msgs)) {
                    const before = msgs.length
                    msgs = msgs.filter((m) => {
                      const text = (m && m.parts || []).map((p) => (p && p.type === 'text' ? p.text : '')).join('')
                      return !TEST_MARKS.some((t) => text.includes(t))
                    })
                    out.removedMain = before - msgs.length
                    localStorage.setItem('widget-agent-messages', JSON.stringify(msgs))
                  }
                }
                for (const key of ['widget-agent-session:private:222', 'widget-agent-session:private:333']) {
                  if (localStorage.getItem(key) !== null) {
                    localStorage.removeItem(key)
                    out.removedKeys.push(key)
                  }
                }
              } catch (e) {
                return JSON.stringify({ error: String((e && e.stack) || e) })
              }
              return JSON.stringify(out)
            })()`)
            console.log('[widget] session-cleanup:', result)
          }
          if (process.env.WIDGET_SCREENSHOT_MODE === 'video-resume-check') {
            // 视频续播标记回归巡检(2026-08-13 用户实测"从 Agent 设置回到
            // 对话窗口时自动播放视频,不需要"):对话窗口播视频(loop 保活,
            // 标记已设)→ 进 Agent 设置(面板卸载,播放停止,标记残留)→
            // 返回对话窗口 → 断言**不自动播放**(位置恢复但保持暂停)。
            // 不产生真实 LLM 调用;媒体消息注入后结束恢复。
            const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
            const js = (code) => win.webContents.executeJavaScript(code)
            const out = { asserts: [] }
            const log = (k, v) => {
              out[k] = v
              console.log('[widget] video-resume-check', k, JSON.stringify(v))
            }
            const assert = (name, ok, detail) => {
              out.asserts.push({ name, ok, detail })
              console.log(`[widget] video-resume-check ASSERT ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + JSON.stringify(detail) : ''}`)
            }
            const msgBackup = await js(`localStorage.getItem('widget-agent-messages')`)
            await js(`localStorage.removeItem('widget-agent-messages')`)
            win.webContents.reload()
            await sleep(3000)
            try {
              // 1. 切 Agent 模式 + 长按展开
              win.webContents.send('widget:set-mode', { mode: 'agent', source: 'user' })
              await sleep(1600)
              await js(`(async () => {
                const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
                const island = document.querySelector('.island-demo')
                const r = island.getBoundingClientRect()
                const x = r.left + r.width / 2
                const y = r.top + r.height / 2
                island.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y, pointerId: 1, isPrimary: true, button: 0 }))
                setTimeout(() => island.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x, clientY: y, pointerId: 1, isPrimary: true, button: 0 })), 600)
                await sleep(2000)
              })()`)
              // 2. 真实 mp4 优先(JiJiDown 下载目录第一个 mp4,有真实时长/
              // 可 seek,currentTime 正常推进——MediaRecorder webm 无时长
              // 元数据,currentTime 恒 0,位置缓存与 seek 断言无法验证);
              // 不可读则回退 MediaRecorder webm(位置断言跳过)
              const JIJI_DIR = 'C:\\Program Files\\JiJiDown\\Download'
              let realVideoPath = null
              try {
                const files = fs.readdirSync(JIJI_DIR)
                realVideoPath = files.find((f) => /\.mp4$/i.test(f)) ? path.join(JIJI_DIR, files.find((f) => /\.mp4$/i.test(f))) : null
              } catch {
                // 目录不可读:回退
              }
              let mediaUrl = realVideoPath
              if (!mediaUrl) {
                const videoDataUrl = await js(`(async () => {
                  try {
                    const canvas = document.createElement('canvas')
                    canvas.width = 320
                    canvas.height = 180
                    const ctx = canvas.getContext('2d')
                    ctx.fillStyle = '#4d6bfe'
                    ctx.fillRect(0, 0, 320, 180)
                    ctx.fillStyle = '#fff'
                    ctx.font = '26px sans-serif'
                    ctx.fillText('RESUME TEST', 90, 100)
                    const stream = canvas.captureStream(10)
                    const rec = new MediaRecorder(stream, { mimeType: 'video/webm' })
                    const chunks = []
                    rec.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data) }
                    const done = new Promise((res) => { rec.onstop = () => res() })
                    rec.start()
                    await new Promise((r) => setTimeout(r, 5000))
                    rec.stop()
                    await done
                    const blob = new Blob(chunks, { type: 'video/webm' })
                    const dataUrl = await new Promise((res) => {
                      const fr = new FileReader()
                      fr.onload = () => res(fr.result)
                      fr.readAsDataURL(blob)
                    })
                    return String(dataUrl)
                  } catch (e) {
                    return 'ERR:' + String((e && e.message) || e)
                  }
                })()`)
                if (!videoDataUrl.startsWith('data:')) {
                  assert('测试媒体生成', false, videoDataUrl)
                  return
                }
                mediaUrl = videoDataUrl
              }
              log('media', { real: !!realVideoPath, name: realVideoPath ? path.basename(realVideoPath) : 'webm-fallback' })
              // 3. 注入 media 消息(自动播放机制:落定消息首条媒体自动播,
              // play 事件 → dispatchAgentMedia playing:true → 标记设置)
              win.webContents.send('agent:event', {
                type: 'message',
                message: {
                  id: 'vr-msg-1',
                  role: 'assistant',
                  parts: [
                    { type: 'text', text: '续播巡检测试' },
                    { type: 'media', kind: 'video', url: mediaUrl, name: realVideoPath ? path.basename(realVideoPath) : 'vr-test.webm' },
                  ],
                },
              })
              await sleep(2500)
              // 4. 设 loop 保活 + 轮询等播放 ≥2s(1Hz 进度上报把位置写进
              // agentMediaPositions 缓存,返回后的 seek 断言才有意义)
              const s1 = await js(`(async () => {
                const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
                const v0 = document.querySelector('.island-media-frame video')
                if (!v0) return JSON.stringify({ hasVideo: false })
                v0.loop = true
                if (v0.paused) v0.play().catch(() => {})
                // 每轮**重新查询**(元素可能被重挂载替换)+ 记录诊断
                let last = null
                for (let i = 0; i < 30; i++) {
                  await sleep(300)
                  const v = document.querySelector('.island-media-frame video')
                  if (!v) return JSON.stringify({ hasVideo: false, gone: true, i })
                  last = {
                    paused: v.paused,
                    t: Math.round(v.currentTime * 10) / 10,
                    rs: v.readyState,
                    err: v.error ? v.error.code : 0,
                    sameEl: v === v0,
                    frames: v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality().totalVideoFrames : -1,
                    vw: v.videoWidth,
                  }
                  if (v.currentTime >= 2) break
                }
                return JSON.stringify({ hasVideo: true, ...last })
              })()`)
              const p1 = JSON.parse(s1)
              log('before-settings', p1)
              assert('视频已挂载且在播(≥2s,标记已设)', p1.hasVideo === true && p1.paused === false && p1.t >= 2, p1)
              // 5. ⋯ 菜单 → 设置(AgentView onOpenSettings → agent-settings 视图)
              await js(`(async () => {
                const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
                const menu = document.querySelector('.island-agent-head .island-quick-menu')
                menu?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: null }))
                await sleep(400)
                const item = [...document.querySelectorAll('.island-quick-menu-item')].find((el) => (el.textContent || '').includes('设置'))
                item?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
                await sleep(900)
                return !!document.querySelector('.island-agent-settings')
              })()`)
              const inSettings = await js(`!!document.querySelector('.island-agent-settings')`)
              log('in-settings', inSettings)
              assert('已进入 Agent 设置视图(面板卸载)', inSettings === true)
              // 6. 返回:agent-settings → settings → 收起 → 长按重新展开
              await js(`(async () => {
                const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
                // agent-settings 返回键 → settings
                const back1 = [...document.querySelectorAll('.island-agent-settings button, .island-panel-list:has(.island-agent-settings) .island-bg-back')].find((b) => (b.textContent || '').includes('返回'))
                if (back1) {
                  back1.dispatchEvent(new MouseEvent('click', { bubbles: true }))
                  await sleep(700)
                }
                // settings 返回键 → 收起
                const back2 = [...document.querySelectorAll('.island-panel-list:has(.island-settings-view) .island-bg-back, .island-settings-view button')].find((b) => (b.textContent || '').includes('返回'))
                if (back2) {
                  back2.dispatchEvent(new MouseEvent('click', { bubbles: true }))
                  await sleep(1200)
                }
                // 长按重新展开 → agent 视图
                const island = document.querySelector('.island-demo')
                const r = island.getBoundingClientRect()
                const x = r.left + r.width / 2
                const y = r.top + r.height / 2
                island.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y, pointerId: 1, isPrimary: true, button: 0 }))
                setTimeout(() => island.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x, clientY: y, pointerId: 1, isPrimary: true, button: 0 })), 600)
                await sleep(2600)
              })()`)
              // 7. 断言:回到对话窗口后视频**不自动播放**(位置恢复、保持暂停)
              const s2 = await js(`(() => {
                const v = document.querySelector('.island-media-frame video')
                if (!v) return JSON.stringify({ hasVideo: false, agentView: !!document.querySelector('.island-agent-view') })
                return JSON.stringify({
                  hasVideo: true,
                  paused: v.paused,
                  t: Math.round(v.currentTime * 10) / 10,
                  agentView: !!document.querySelector('.island-agent-view'),
                })
              })()`)
              const p2 = JSON.parse(s2)
              log('after-return', p2)
              assert('回到 Agent 对话视图且视频已重挂载', p2.agentView === true && p2.hasVideo === true, p2)
              assert('视频不自动播放(保持暂停)', p2.paused === true, p2)
              // 位置恢复断言仅真实 mp4 有意义(MediaRecorder webm 无时长
              // 元数据,currentTime 恒 0;其恢复语义本身也无法验证)
              if (realVideoPath) {
                assert('播放位置已恢复(seek 到缓存位置)', p2.t > 0, p2)
              } else {
                assert('播放位置已恢复(webm 回退跳过,无时长元数据)', true, p2)
              }
            } catch (err) {
              log('error', String((err && err.stack) || err))
            } finally {
              // 恢复:消息备份 + 切回音乐模式
              await js(`(() => {
                if (${JSON.stringify(msgBackup)} === null) localStorage.removeItem('widget-agent-messages')
                else localStorage.setItem('widget-agent-messages', ${JSON.stringify(msgBackup)})
                return 'ok'
              })()`).catch(() => {})
              win.webContents.send('widget:set-mode', { mode: 'music', source: 'user' })
              log('asserts-summary', out.asserts.filter((x) => !x.ok).map((x) => x.name))
            }
          }
          if (process.env.WIDGET_SCREENSHOT_MODE === 'session-debug') {
            // 会话隔离三 bug 复现巡检(2026-08-13):
            // ① 切会话(单条消息)收起面板后消息被截断(布局);
            // ② 会话里发送的消息 LLM 不知道(mock LLM 回显验证);
            // ③ 主对话让 LLM 发的消息切到会话看不到(mock LLM 工具调用
            //    + 假 OneBot 服务器 ACK send_private_msg → onSent 回显链路);
            // ④ 场景 E(2026-08-13 泄露根治):LLM 询问主人意见的询问轮 +
            //    执行轮汇报绝不发回对方——询问轮拦截留窗口 + 同步主人 QQ,
            //    执行回复标记化发回。
            // ⑤ 场景 F(2026-08-13 二轮指纹严格验证):负向路径——无指纹直接
            //    回复(忘带指纹的自主回复)/ 错误过期指纹 全部扣留不发送
            //    (指纹对不上就不发送,自主回复同样指纹门控),扣留原因经
            //    global.__fpGate 可归因,各轮指纹互不相同(每轮唯一)。
            // ⑥ 场景 E0/G(2026-08-13 会话情况记录 + 快捷清空):记录经
            //    agent:send 回传主进程注入引擎输入(每轮参考);横幅 UI
            //    记录/清空按钮 → 编辑保存落盘 + 两段式清空擦除历史
            //    (记录保留)。
            // 全部走假服务器:mock LLM(Responses API SSE,回显最后一条用户
            // 消息 = 证明 LLM 收到) + 假 OneBot WS(手写握手/帧,ACK 动作)。
            // 不产生真实 LLM 调用与真实 QQ 消息。
            const http = require('node:http')
            const crypto = require('node:crypto')
            const net = require('node:net')
            const out = { asserts: [] }
            const log = (k, v) => {
              out[k] = v
              console.log('[widget] session-debug', k, JSON.stringify(v))
            }
            const assert = (name, ok, detail) => {
              out.asserts.push({ name, ok, detail })
              console.log(`[widget] session-debug ASSERT ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + JSON.stringify(detail) : ''}`)
            }
            const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
            const js = (code) => win.webContents.executeJavaScript(code)
            // 诊断采样:每 5s 记录 set-size IPC 计数与主进程堆(定位 OOM/死循环)
            const sampleTimer = setInterval(() => {
              const mem = process.memoryUsage()
              console.log('[session-debug] SAMPLE setSize=' + (global.__dbgSetSize || 0) + ' last=' + JSON.stringify(global.__dbgLastSetSize || null) + ' heapMB=' + Math.round(mem.heapUsed / 1048576) + ' rssMB=' + Math.round(mem.rss / 1048576))
            }, 5000)
            // 设置与渲染端存储备份(巡检结束恢复)
            const settingsFile = settingsPath()
            let settingsBackup = null
            // **崩溃安全侧备份(2026-08-13 实测:OOM 崩溃的运行跳过 finally,
            // 污染版 settings 落盘后,下一轮把它当"备份"恢复 → 用户真实
            // 配置(含 apiKey)永久丢失)。侧备份文件在**污染前**写一次、
            // 永不覆盖;运行开始若发现上次崩溃残留(现文件 ≠ 侧备份),
            // 先用侧备份恢复,再以之为本轮基线
            const sideBackupFile = settingsFile + '.session-debug-bak'
            try {
              const side = fs.existsSync(sideBackupFile) ? fs.readFileSync(sideBackupFile, 'utf8') : null
              const current = fs.readFileSync(settingsFile, 'utf8')
              // 仅当现文件是**测试污染版**(baseURL 指向本机 mock)才从侧备份
              // 恢复——用户两次巡检之间正常改的配置绝不回滚
              let currentIsPolluted = false
              try {
                currentIsPolluted = String(JSON.parse(current).agent?.baseURL ?? '').startsWith('http://127.0.0.1')
              } catch {}
              if (side !== null && currentIsPolluted && side !== current) {
                fs.writeFileSync(settingsFile, side)
                resetSettingsCache()
                console.log('[widget] session-debug 检测到上次崩溃残留设置,已从侧备份恢复')
              }
              settingsBackup = side !== null && currentIsPolluted ? side : current
              // 侧备份保持新鲜:首次播种或现文件是合法配置时刷新
              // (用户正常改配置后崩溃,恢复的也是最新合法版)
              if (side === null || !currentIsPolluted) fs.writeFileSync(sideBackupFile, current)
            } catch {
              // 读取失败走原逻辑
              try { settingsBackup = fs.readFileSync(settingsFile, 'utf8') } catch {}
            }
            const storageBackup = await js(`(() => {
              const out = {}
              for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i)
                if (k && k.indexOf('widget-agent') === 0) out[k] = localStorage.getItem(k)
              }
              return out
            })()`)
            log('storage-keys-at-start', Object.keys(storageBackup))
            // ---- mock LLM(Responses API SSE,data-only 帧 + JSON 内 type)----
            const llmRequests = []
            const llmServer = http.createServer((req, res) => {
              let body = ''
              req.on('data', (c) => { body += c })
              req.on('end', () => {
                let parsed = null
                try { parsed = JSON.parse(body) } catch {}
                const items = Array.isArray(parsed && parsed.input) ? parsed.input : []
                const users = items.filter((it) => it && it.type === 'message' && it.role === 'user')
                const lastUser = users.length > 0
                  ? String((users[users.length - 1].content ?? []).map((c) => (c && c.text) || '').join('\n'))
                  : ''
                // **标记检测只看本条消息文本(2026-08-13 实测)**:消息注入的
                // 【档案卡】段里"最近发言"会逐字引用历史消息——历史消息
                // 自带的测试标记($$ask-turn$$ 等)会让分支误触发;原始
                // 消息文本在【档案卡】之前,检测用它
                const msgText = lastUser.split('【档案卡】')[0]
                // 工具轮标记:仅当输入**最后一项**是带标记的用户消息时发
                // 工具调用(工具执行后的续轮输入以 function_call_output 结尾,
                // 不会再触发——用户真实历史里本就有历史 napcat 调用,
                // 不能按"出现过 napcat 调用"判定)
                const lastItem = items[items.length - 1]
                const markerTurn = lastItem && lastItem.type === 'message' && lastItem.role === 'user'
                const jsonMode = !!(parsed && parsed.text && parsed.text.format && parsed.text.format.type === 'json_object')
                // **意图判定器请求(2026-08-16 兜底路由)**:独立 Sub Agent 判定
                // 无指纹回复的发送意图——系统提示(instructions)含「回复意图
                // 判定器」;mock 按触发消息里的场景标记返回意图(缺省 hold =
                // 老场景保持"扣留"语义,不改变既有断言)
                const isClassifier = String(JSON.stringify(parsed?.instructions ?? '')).includes('回复意图判定器')
                // **本轮指纹(2026-08-13 指纹协议,用户要求"指纹对不上就不
                // 发送")**:从系统指令提取本轮唯一指纹——取**最后一个**匹配
                // (历史里可能出现旧指纹残留,当轮系统指令在 input 末尾);
                // mock 模拟遵守协议的 LLM——发给对方的话必须以「【指纹:xxxx】」
                // 开头回显(路由层剥指纹发送;询问/汇报不带指纹 = 路由层不发送)
                const fpMatches = [...String(JSON.stringify(parsed?.input ?? [])).matchAll(/【指纹:([2-9A-HJ-NP-Z]{6})】/g)]
                const turnFp = fpMatches.length > 0 ? fpMatches[fpMatches.length - 1][1] : ''
                // **本轮主人指纹(2026-08-16 二轮)**:【主人指纹 = xxx】在系统
                // 指令里——场景 J5(mock LLM 把发给对方的话误打主人指纹)回显用
                const masterFpMatches = [...String(JSON.stringify(parsed?.input ?? [])).matchAll(/【主人指纹 = ([2-9A-HJ-NP-Z]{6})】/g)]
                const masterFp = masterFpMatches.length > 0 ? masterFpMatches[masterFpMatches.length - 1][1] : ''
                // 会话情况记录(2026-08-13):输入里是否带【本会话情况记录】
                // 系统项——验证主进程注入链路
                const noteSeen = String(JSON.stringify(parsed?.input ?? [])).includes('本会话情况记录')
                // 当前会话对象(2026-08-13 指向性):外部会话输入是否带
                // 【当前会话对象】注入——LLM 知道"他/对方"指谁
                const sessObjSeen = String(JSON.stringify(parsed?.input ?? [])).includes('当前会话对象')
                llmRequests.push({ lastUser: lastUser.slice(0, 120), markerTurn, jsonMode, turnFp, noteSeen, sessObjSeen })
                res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
                const frame = (obj) => res.write('data: ' + JSON.stringify(obj) + '\n\n')
                ;(async () => {
                  try {
                    frame({ type: 'response.created', response: {} })
                    await sleep(20)
                    if (isClassifier) {
                      // 意图判定器 mock(2026-08-16):按触发消息(在系统提示
                      // instructions 里)的场景标记返回意图——判定结果驱动
                      // 落定路由(场景 J 断言);缺省 hold 保持老场景扣留语义
                      const clsAll = String(JSON.stringify(parsed?.instructions ?? ''))
                      let intent = 'hold'
                      let reason = '测试缺省:扣留'
                      if (clsAll.includes('$$master-daily-other$$')) { intent = 'other'; reason = '发给别人的话' }
                      else if (clsAll.includes('$$master-daily-master$$')) { intent = 'master'; reason = '给主人的应答' }
                      else if (clsAll.includes('$$exec-no-fp-other$$')) { intent = 'other'; reason = '执行回复发给对方' }
                      else if (clsAll.includes('$$exec-no-fp-master$$')) { intent = 'master'; reason = '执行汇报给主人' }
                      else if (clsAll.includes('$$exec-master-fp-mislabel$$')) { intent = 'other'; reason = '主人指纹复核:发给对方的话' }
                      frame({ type: 'response.output_text.delta', delta: JSON.stringify({ intent, reason }) })
                    } else if (jsonMode) {
                      frame({ type: 'response.output_text.delta', delta: '{"title":"测试会话"}' })
                    } else if (msgText.includes('$$napcat-send$$') && markerTurn) {
                      const m = /\$\$napcat-send\$\$\s*([\s\S]*)$/.exec(lastUser)
                      const msgText = (m && m[1] ? m[1] : '测试消息C').trim()
                      const args = { action: 'send', user_id: '222', message: msgText }
                      frame({ type: 'response.output_item.added', output_index: 0, item: { id: 'item_1', type: 'function_call', call_id: 'call_1', name: 'napcat', arguments: '' } })
                      await sleep(10)
                      frame({ type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'item_1', delta: JSON.stringify(args) })
                      await sleep(10)
                      frame({ type: 'response.function_call_arguments.done', output_index: 0, item_id: 'item_1', arguments: JSON.stringify(args) })
                    } else if (msgText.includes('$$ask-turn$$')) {
                      // 询问轮场景(2026-08-13 泄露根治,用户实测"LLM 询问我
                      // 意见时把本应给我的消息全部发给了别人"):mock LLM 回复 =
                      // 征求主人意见,遵守指纹协议**不带指纹**——路由层必须
                      // 拦截(指纹对不上 = 不发送),绝不能发回对方
                      frame({ type: 'response.output_text.delta', delta: '要不要我回他一句调侃?你说回啥,我马上发~' })
                    } else if (msgText.includes('$$mark-reply$$')) {
                      // 执行轮场景:主人指示后的执行回复,带本轮指纹 = 发给
                      // 对方的话(路由层剥指纹发送,展示层显示剥离后的正文)
                      frame({ type: 'response.output_text.delta', delta: '【指纹:' + turnFp + '】哈哈确实拉胯,心疼你一秒' })
                    } else if (msgText.includes('$$no-fp$$')) {
                      // 负向验证(2026-08-13 二轮严格验证):**不遵守指纹协议**
                      // 的 LLM——直接回复但不带指纹 → 路由层必须扣留
                      // (指纹对不上就不发送)
                      frame({ type: 'response.output_text.delta', delta: '好的,这事包在我身上啦' })
                    } else if (msgText.includes('$$wrong-fp$$')) {
                      // 负向验证:LLM 用了**错误的/过期的指纹** → 对不上本轮
                      // → 不发送(历史里抄来的旧指纹同样对不上)
                      frame({ type: 'response.output_text.delta', delta: '【指纹:ZZZZZZ】错指纹也能发吗?' })
                    } else if (msgText.includes('$$ask-fp$$')) {
                      // 防御层验证:LLM **误把询问内容带指纹** → isAsk 拦截
                      // (不发给对方)+ 记 pending + 同步主人 QQ
                      frame({ type: 'response.output_text.delta', delta: '【指纹:' + turnFp + '】要不要我回他一句?你说回啥,我马上发~' })
                    } else if (msgText.includes('$$session-note-tool$$') && markerTurn) {
                      // LLM 会话工具(2026-08-13):set_session_note 工具调用
                      // → 主进程桥写 localStorage。**markerTurn 守卫(2026-08-13
                      // 二轮实测)**:工具执行后的续轮请求 lastUser 仍是带标记
                      // 的消息,不守卫会无限重发工具调用 → 引擎 busy 卡死,
                      // 后续消息(场景 I)被 busy 拒绝
                      const args = { note: 'LLM 生成的情况记录:魔精是电竞好友,回复要懂梗' }
                      frame({ type: 'response.output_item.added', output_index: 0, item: { id: 'item_1', type: 'function_call', call_id: 'call_1', name: 'set_session_note', arguments: '' } })
                      await sleep(10)
                      frame({ type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'item_1', delta: JSON.stringify(args) })
                      await sleep(10)
                      frame({ type: 'response.function_call_arguments.done', output_index: 0, item_id: 'item_1', arguments: JSON.stringify(args) })
                    } else if (msgText.includes('$$clear-context-tool$$') && markerTurn) {
                      // LLM 会话工具:clear_session_context 工具调用 → 主进程
                      // 擦除持久化历史 + 派发 session-context-cleared 事件
                      frame({ type: 'response.output_item.added', output_index: 0, item: { id: 'item_1', type: 'function_call', call_id: 'call_1', name: 'clear_session_context', arguments: '' } })
                      await sleep(10)
                      frame({ type: 'response.function_call_arguments.done', output_index: 0, item_id: 'item_1', arguments: '{}' })
                    } else if (msgText.includes('$$session-send$$') && markerTurn) {
                      // 指向性(2026-08-13 用户要求"发消息给他 = 直接给私聊
                      // 会话这个 QQ 发"):mock LLM 调 napcat send **不带
                      // user_id** → 工具缺省 = 当前会话对象(private:222)
                      const args = { action: 'send', message: '消息直接发给会话对象' }
                      frame({ type: 'response.output_item.added', output_index: 0, item: { id: 'item_1', type: 'function_call', call_id: 'call_1', name: 'napcat', arguments: '' } })
                      await sleep(10)
                      frame({ type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'item_1', delta: JSON.stringify(args) })
                      await sleep(10)
                      frame({ type: 'response.function_call_arguments.done', output_index: 0, item_id: 'item_1', arguments: JSON.stringify(args) })
                    } else if (msgText.includes('$$master-daily-other$$')) {
                      // 场景 J1(2026-08-16):主人日常轮,LLM 把"替主人发给
                      // 别人的话"直接写进回复(不调 send 工具、不带指纹)→
                      // 意图判定 other → 扣留+通知,不再发主人(原实现无条件
                      // 直发主人 = 串台根源)
                      frame({ type: 'response.output_text.delta', delta: '周末见,你也早点休息~' })
                    } else if (msgText.includes('$$master-daily-master$$')) {
                      // 场景 J2:主人日常轮正常应答(无指纹)→ 判定 master →
                      // 直发主人(原行为不回归)
                      frame({ type: 'response.output_text.delta', delta: '好的,这就去办' })
                    } else if (msgText.includes('$$exec-no-fp-other$$')) {
                      // 场景 J3:执行轮,主人指示后的执行回复但**忘带指纹** →
                      // 意图判定 other → 发回待回复对象(原实现 master-no-fp
                      // 扣留 = 该发给对方的消息发不出去)
                      frame({ type: 'response.output_text.delta', delta: '行,那明天晚上八点见!' })
                    } else if (msgText.includes('$$exec-no-fp-master$$')) {
                      // 场景 J4:执行轮,忘带主人指纹的汇报 → 意图判定 master
                      // → 发主人(原实现扣留 = 主人收不到执行汇报)
                      frame({ type: 'response.output_text.delta', delta: '已经帮他回复了,他让我谢谢主人' })
                    } else if (msgText.includes('$$exec-master-fp-mislabel$$')) {
                      // 场景 J5(2026-08-16 二轮):执行轮 LLM 把**发给对方的话
                      // 误打主人指纹**(内容 = 发给对方的话)→ 主人指纹复核 →
                      // 判定 other → 发回待回复对象(原实现无条件发主人 =
                      // 串台,别人收不到)
                      frame({ type: 'response.output_text.delta', delta: '【主人指纹:' + masterFp + '】明天中午十二点见!' })
                    } else {
                      // 直接回复:遵守指纹协议——发给对方的话以本轮指纹开头
                      const echo = '【已收到】' + lastUser.replace(/【[^】]*】/g, '').trim().slice(0, 40)
                      frame({ type: 'response.output_text.delta', delta: (turnFp ? '【指纹:' + turnFp + '】' : '') + echo })
                    }
                    await sleep(10)
                    frame({ type: 'response.completed', response: { usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: {} } } })
                    res.end()
                  } catch {
                    try { res.end() } catch {}
                  }
                })()
              })
            })
            await new Promise((r) => llmServer.listen(0, '127.0.0.1', r))
            const llmUrl = `http://127.0.0.1:${llmServer.address().port}`
            // ---- 假 OneBot WS 服务器(手写握手/帧;ACK 动作;可推消息)----
            const onebotReceived = []
            const wsState = { socket: null, buf: Buffer.alloc(0), upgraded: false, connCount: 0, upgradedCount: 0 }
            let msgSeq = 0
            const wsFrame = (text) => {
              const payload = Buffer.from(text, 'utf8')
              let header
              if (payload.length < 126) header = Buffer.from([0x81, payload.length])
              else if (payload.length < 65536) {
                header = Buffer.alloc(4)
                header[0] = 0x81
                header[1] = 126
                header.writeUInt16BE(payload.length, 2)
              } else {
                header = Buffer.alloc(10)
                header[0] = 0x81
                header[1] = 127
                header.writeBigUInt64BE(BigInt(payload.length), 2)
              }
              return Buffer.concat([header, payload])
            }
            const wsSend = (obj) => {
              if (wsState.socket && wsState.upgraded) wsState.socket.write(wsFrame(JSON.stringify(obj)))
            }
            const wsServer = net.createServer((socket) => {
              wsState.connCount += 1
              log('ws-conn', { n: wsState.connCount, at: Date.now() })
              wsState.socket = socket
              wsState.buf = Buffer.alloc(0)
              wsState.upgraded = false
              const processFrames = () => {
                // **循环条件与解析每轮都读最新 wsState.buf(2026-08-13
                // 实测 OOM 修复):原实现 const b = wsState.buf 捕获在循环
                // 外,消费后 b 仍是旧引用 → while(b.length>=2) 恒真、
                // 同一帧无限重解析 + 每轮 slice 分配 → 主进程事件循环
                // 卡死 + 堆 3.9GB OOM(首次收到客户端帧即触发)
                while (wsState.buf.length >= 2) {
                  const b = wsState.buf
                  const b0 = b[0]
                  const b1 = b[1]
                  const opcode = b0 & 0x0f
                  const masked = (b1 & 0x80) !== 0
                  let len = b1 & 0x7f
                  let off = 2
                  if (len === 126) {
                    if (b.length < 4) return
                    len = b.readUInt16BE(2)
                    off = 4
                  } else if (len === 127) {
                    if (b.length < 10) return
                    len = Number(b.readBigUInt64BE(2))
                    off = 10
                  }
                  const maskLen = masked ? 4 : 0
                  if (b.length < off + maskLen + len) return
                  let payload = b.slice(off + maskLen, off + maskLen + len)
                  if (masked) {
                    const mask = b.slice(off, off + 4)
                    payload = Buffer.from(payload.map((x, i) => x ^ mask[i % 4]))
                  }
                  wsState.buf = b.slice(off + maskLen + len)
                  if (opcode === 8) {
                    try { socket.end() } catch {}
                    return
                  }
                  if (opcode === 9) {
                    socket.write(Buffer.from([0x8a, 0]))
                    continue
                  }
                  if (opcode !== 1) continue
                  let obj = null
                  try { obj = JSON.parse(payload.toString('utf8')) } catch { continue }
                  if (obj && typeof obj.echo === 'string' && obj.action) {
                    onebotReceived.push({ action: obj.action, params: obj.params, at: Date.now() })
                    if (obj.action === 'send_private_msg') {
                      wsSend({ status: 'ok', retcode: 0, data: { message_id: 111222 }, echo: obj.echo })
                    } else if (obj.action === 'send_group_msg') {
                      wsSend({ status: 'ok', retcode: 0, data: { message_id: 222333 }, echo: obj.echo })
                    } else {
                      wsSend({ status: 'ok', retcode: 0, data: {}, echo: obj.echo })
                    }
                  }
                }
              }
              socket.on('data', (chunk) => {
                wsState.buf = Buffer.concat([wsState.buf, chunk])
                if (!wsState.upgraded) {
                  const idx = wsState.buf.indexOf('\r\n\r\n')
                  if (idx === -1) return
                  const head = wsState.buf.slice(0, idx).toString('utf8')
                  const keyM = /Sec-WebSocket-Key:\s*(.+)\r?\n/i.exec(head)
                  const key = keyM ? keyM[1].trim() : ''
                  const accept = crypto
                    .createHash('sha1')
                    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
                    .digest('base64')
                  socket.write(
                    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' +
                      accept +
                      '\r\n\r\n',
                  )
                  wsState.upgraded = true
                  wsState.upgradedCount += 1
                  log('ws-upgraded', { n: wsState.upgradedCount, keyOk: !!keyM })
                  wsState.buf = wsState.buf.slice(idx + 4)
                  if (wsState.buf.length > 0) processFrames()
                  return
                }
                processFrames()
              })
              socket.on('error', () => {})
              socket.on('close', () => {
                if (wsState.socket === socket) {
                  wsState.socket = null
                  wsState.upgraded = false
                }
              })
            })
            await new Promise((r) => wsServer.listen(0, '127.0.0.1', r))
            const wsUrl = `ws://127.0.0.1:${wsServer.address().port}`
            // **推送 message_id 加运行盐(2026-08-16 修复"重跑巡检推送全部
            // 被吞")**:客户端的私聊/群聊去重集合**持久化到 userData/
            // napcat-seen.json(TTL 1 小时)**——假服务器从 1 递增的 message_id
            // 与上一轮巡检(1 小时内)写入的 id 完全重合,seenHas 命中 →
            // 本轮所有推送静默丢弃(实测:同一轮次内重跑,场景 A/D/E1/F/J
            // 的推送全部到不了引擎,只有窗口输入/工具发送正常)。加随机
            // 10 位运行盐(与真实 QQ 的大 id、前次运行的盐均不冲突)
            const runSalt = 1000000000 + Math.floor(Math.random() * 9000000000)
            const pushPrivate = (qq, text) => {
              msgSeq += 1
              wsSend({
                post_type: 'message',
                message_type: 'private',
                user_id: Number(qq),
                message_id: runSalt + msgSeq,
                message: [{ type: 'text', data: { text } }],
                raw_message: text,
                time: Math.floor(Date.now() / 1000),
              })
            }
            try {
              // ---- 改写设置 → mock 端点 + 触发 NapCat 连接 ----
              let settings = {}
              try { settings = JSON.parse(settingsBackup ?? '{}') } catch {}
              settings.agent = {
                ...(settings.agent ?? {}),
                // **多供应商镜像(2026-08-16 修复)**:currentAgentConfig 的顶层
                // apiKey/baseURL/model 始终从 providers[activeProvider] 读出
                // (顶层 = 镜像)——巡检此前只改写顶层字段,引擎实际仍用
                // providers.deepseek 的真实凭据 = 巡检一直在连真实 LLM
                // (回复是真人风格、mock 的 llmRequests 恒空、场景断言随
                // 真实 LLM 行为漂移)。必须同步改写 providers.deepseek。
                activeProvider: 'deepseek',
                providers: {
                  ...(settings.agent?.providers ?? {}),
                  deepseek: { apiKey: 'test-key', baseURL: llmUrl, model: 'deepseek-v4-flash' },
                },
                apiKey: 'test-key',
                baseURL: llmUrl,
                model: 'deepseek-v4-flash',
                napcatEnabled: true,
                napcatWsUrl: wsUrl,
                napcatAllowed: ['222', '333'],
                napcatAllowedGroups: [],
                mutedSessions: ['private:333'],
                mcpServers: [],
                proactiveEnabled: false,
              }
              fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2))
              resetSettingsCache()
              // **两段式重连(2026-08-13 实测坑)**:用户真实配置
              // napcatEnabled=true → whenReady 已连上**真实 NapCat**(3001)。
              // syncNapcatLifecycle 只在 !active 时启动,直接改 wsUrl 不会
              // 重连——且场景 C 的工具调用会经真实 NapCat 发出真消息!
              // 先 disable 断开真实连接,再 enable 连上假 OneBot 服务器
              await js(`window.desktop?.agentSetConfig?.({ napcatEnabled: false })`)
              await sleep(900)
              await js(`window.desktop?.agentSetConfig?.({ napcatEnabled: true })`)
              // 等假服务器收到升级(最多 5s)
              for (let i = 0; i < 25 && wsState.upgradedCount === 0; i++) await sleep(200)
              const cfgCheck = await js(`window.desktop?.agentGetConfig?.()`)
              log('cfg-check', { napcatEnabled: cfgCheck?.napcatEnabled, napcatWsUrl: cfgCheck?.napcatWsUrl, napcatAllowed: cfgCheck?.napcatAllowed, wsUpgraded: wsState.upgradedCount })
              await sleep(500)
              // 安全闸:假连接未建立 → 跳过一切会发 QQ 的场景(防真实 NapCat 发出真消息)
              const wsReady = wsState.upgradedCount >= 1
              // 切 Agent 模式 + 长按展开(与段 3 同款)
              win.webContents.send('widget:set-mode', { mode: 'agent', source: 'user' })
              await sleep(800)
              const enterResult = await js(`(async () => {
                const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
                const island = document.querySelector('.island-demo')
                if (!island) return JSON.stringify({ fatal: 'no island' })
                const r = island.getBoundingClientRect()
                const x = r.left + r.width / 2
                const y = r.top + r.height / 2
                island.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y, pointerId: 1, isPrimary: true, button: 0 }))
                setTimeout(() => island.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x, clientY: y, pointerId: 1, isPrimary: true, button: 0 })), 600)
                await sleep(2500)
                return JSON.stringify({
                  expanded: island.classList.contains('expanded'),
                  agentView: !!document.querySelector('.island-agent-view'),
                })
              })()`)
              log('enter', JSON.parse(enterResult))
              // ===== A0:监听会话启动即入面板(2026-08-13 用户要求"只要是
              // 监听的,自动加入"——原只预注册群,私聊要等消息到达才建
              // 会话,每次进程序只有两个群没有私聊)=====
              await js(`(async () => {
                const fold = document.querySelector('.island-session-fold')
                if (!document.querySelector('.island-session-dock.open')) fold?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
                return 'ok'
              })()`)
              await sleep(500)
              const a0Result = await js(`(() => {
                const items = [...document.querySelectorAll('.island-session-item')].map((el) => (el.textContent || '').replace(/\\s+/g, ' '))
                return JSON.stringify(items)
              })()`)
              const a0Items = JSON.parse(a0Result)
              log('seed-items', a0Items)
              // 注意:本断言在巡检改写设置**之前**的应用启动种子(真实配置)已
              // 广播——面板此时是用户真实配置的监听会话(222/333 是巡检设置,
              // 应用启动时尚未生效,随后由消息到达注册)。判定 = 特性本身:
              // **私聊监听(QQ 号 caption)+ 群监听启动即入面板,无需任何消息**
              assert(
                'A0 监听私聊/群启动即入面板(无需消息)',
                a0Items.some((t) => /QQ \d+/.test(t)) && a0Items.some((t) => t.includes('群 ')),
                a0Items,
              )
              // ===== 场景 A:假 OneBot 推私聊(QQ 222 信任)→ 全链路 =====
              if (!wsReady) {
                assert('A0 假 OneBot 连接就绪', false, { upgraded: wsState.upgradedCount, conn: wsState.connCount })
              }
              pushPrivate('222', '在吗')
              await sleep(3000)
              const aResult = await js(`(() => {
                const out = {}
                const raw = localStorage.getItem('widget-agent-session:private:222')
                let msgs = []
                try { msgs = JSON.parse(raw || '[]') } catch {}
                out.count = msgs.length
                out.roles = msgs.map((m) => m.role)
                out.lastText = msgs.length
                  ? (msgs[msgs.length - 1].parts ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('')
                  : ''
                out.dockItems = [...document.querySelectorAll('.island-session-item')].map((el) => (el.textContent || '').replace(/\\s+/g, ' '))
                const rawMain = localStorage.getItem('widget-agent-messages')
                out.mainHasLeak = (rawMain || '').indexOf('【已收到】在吗') !== -1
                out.allTexts = msgs.map((m) => (m.parts ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('').slice(0, 30))
                return JSON.stringify(out)
              })()`)
              const a = JSON.parse(aResult)
              log('scenarioA', a)
              assert('A1 会话 private:222 已创建(会话坞条目)', a.dockItems.some((t) => t.indexOf('222') !== -1), a.dockItems)
              assert('A2 会话历史含用户消息(QQ 在吗)', a.roles.includes('user'), a.roles)
              assert('A3 会话历史含助手回显(LLM 收到消息)', a.roles.includes('assistant') && a.lastText.includes('在吗'), a.lastText)
              assert('A4 回复回发 QQ(假 OneBot 收到 send_private_msg)', onebotReceived.some((r) => r.action === 'send_private_msg' && String(r.params && r.params.user_id) === '222'), onebotReceived.map((r) => r.action + ':' + (r.params && r.params.user_id)))
              assert('A5 回复未串进主对话历史', !a.mainHasLeak)
              log('llm-requests-A', llmRequests.map((r) => ({ u: r.lastUser.slice(0, 60), call: r.hasCall, json: r.jsonMode })))
              // ===== 场景 B:会话视图里输入 → LLM 收到 + 回复发对方 =====
              if (wsReady) {
              await js(`(async () => {
                const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
                const fold = document.querySelector('.island-session-fold')
                if (!document.querySelector('.island-session-dock.open')) fold?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
                await sleep(600)
                const item = [...document.querySelectorAll('.island-session-item')].find((el) => (el.textContent || '').indexOf('222') !== -1)
                item?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
                await sleep(900)
                const ta = document.querySelector('.island-agent-input textarea')
                if (!ta) return JSON.stringify({ fatal: 'no input' })
                const setVal = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
                setVal.call(ta, '会话里输入的消息B')
                ta.dispatchEvent(new Event('input', { bubbles: true }))
                await sleep(150)
                ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
                return JSON.stringify({ ok: true })
              })()`)
              await sleep(3000)
              const bResult = await js(`(() => {
                const out = {}
                const raw = localStorage.getItem('widget-agent-session:private:222')
                let msgs = []
                try { msgs = JSON.parse(raw || '[]') } catch {}
                out.count = msgs.length
                out.roles = msgs.map((m) => m.role)
                out.lastText = msgs.length
                  ? (msgs[msgs.length - 1].parts ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('')
                  : ''
                out.bannerShown = !!document.querySelector('.island-session-current')
                out.bannerText = document.querySelector('.island-session-current')?.textContent ?? ''
                out.winShownMsgs = [...document.querySelectorAll('.island-msgs-window .island-agent-text, .island-msgs-window .island-agent-msg-user-text')].map((el) => (el.textContent || '').slice(0, 40))
                return JSON.stringify(out)
              })()`)
              const b = JSON.parse(bResult)
              log('scenarioB', b)
              assert('B1 会话历史新增用户消息(我发的)', b.roles.filter((r) => r === 'user').length >= 2, b.roles)
              assert('B2 助手回显含我输入的消息(LLM 完全知道)', b.lastText.includes('消息B'), b.lastText)
              assert('B3 回复发回 QQ 222', onebotReceived.some((r) => r.action === 'send_private_msg' && String(r.params && r.params.message).includes('消息B')), onebotReceived.map((r) => r.action + ':' + (r.params && r.params.message)))
              assert('B4 会话横幅显示(当前查看 222)', b.bannerShown, b.bannerText)
              }
              // ===== 场景 C:主对话让 LLM 发消息 → 对应会话可见 =====
              if (!wsReady) {
                assert('C0 假 OneBot 连接就绪(跳过工具调用防真实发送)', false, { upgraded: wsState.upgradedCount })
              } else {
              await js(`(async () => {
                const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
                const item = [...document.querySelectorAll('.island-session-item')].find((el) => (el.textContent || '').indexOf('主对话') !== -1)
                item?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
                await sleep(900)
                const ta = document.querySelector('.island-agent-input textarea')
                if (!ta) return JSON.stringify({ fatal: 'no input' })
                const setVal = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
                setVal.call(ta, '$$napcat-send$$测试消息C')
                ta.dispatchEvent(new Event('input', { bubbles: true }))
                await sleep(150)
                ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
                return JSON.stringify({ ok: true })
              })()`)
              await sleep(4000)
              const cResult = await js(`(() => {
                const out = {}
                const raw = localStorage.getItem('widget-agent-session:private:222')
                let msgs = []
                try { msgs = JSON.parse(raw || '[]') } catch {}
                out.sessionTexts = msgs.map((m) => (m.parts ?? []).map((p) => (p.type === 'text' ? p.text : '')).join(''))
                return JSON.stringify(out)
              })()`)
              const c = JSON.parse(cResult)
              log('scenarioC', c)
              assert('C1 假 OneBot 收到 send_private_msg(消息=测试消息C)', onebotReceived.some((r) => r.action === 'send_private_msg' && String(r.params && r.params.message).includes('测试消息C')), onebotReceived.map((r) => r.action + ':' + (r.params && r.params.message)))
              assert('C2 对应会话历史含已发消息(切会话可见)', c.sessionTexts.some((t) => t.includes('测试消息C')), c.sessionTexts)
              }
              // ===== 场景 D:单条消息会话收起面板 → 布局断言 =====
              // QQ 333 信任 + muted → 仅一条用户消息、无回复(精确复现单消息场景)
              pushPrivate('333', '你好呀')
              await sleep(3000)
              await js(`(async () => {
                const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
                const fold = document.querySelector('.island-session-fold')
                if (!document.querySelector('.island-session-dock.open')) fold?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
                await sleep(600)
                const item = [...document.querySelectorAll('.island-session-item')].find((el) => (el.textContent || '').indexOf('333') !== -1)
                item?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
                await sleep(1000)
                // 收起会话面板(复现用户步骤)
                document.querySelector('.island-session-fold')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
                return 'ok'
              })()`)
              await sleep(1800)
              const dResult = await js(`(() => {
                const rect = (el) => {
                  if (!el) return null
                  const r = el.getBoundingClientRect()
                  return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) }
                }
                const msgs = document.querySelector('.island-agent-messages')
                const items = [...document.querySelectorAll('.island-msgs-item')]
                const last = items[items.length - 1]
                const island = document.querySelector('.island-demo')
                const out = {
                  island: rect(island),
                  banner: rect(document.querySelector('.island-session-current')),
                  head: rect(document.querySelector('.island-agent-head')),
                  msgs: rect(msgs),
                  input: rect(document.querySelector('.island-agent-input')),
                  lastMsg: last ? rect(last) : null,
                  msgsScroll: msgs ? { sh: msgs.scrollHeight, ch: msgs.clientHeight } : null,
                  agentHVar: island ? island.style.getPropertyValue('--agent-h') : '',
                  dockOpen: !!document.querySelector('.island-session-dock.open'),
                  winH: window.innerHeight,
                }
                return JSON.stringify(out)
              })()`)
              const d = JSON.parse(dResult)
              log('scenarioD', d)
              if (d.lastMsg && d.msgs && d.input) {
                const cut = d.lastMsg.bottom - d.msgs.bottom
                const gapToInput = d.input.top - d.msgs.bottom
                assert('D1 消息未被截断(最后消息底 ≤ 消息区底 + 2px)', cut <= 2, { cut, lastMsg: d.lastMsg, msgs: d.msgs })
                assert('D2 消息与输入框之间留空(≥6px)', gapToInput >= 6, { gapToInput })
                assert('D3 消息区无溢出滚动(单条消息应完整可见)', d.msgsScroll && d.msgsScroll.sh <= d.msgsScroll.ch, d.msgsScroll)
              } else {
                assert('D1 消息未被截断', false, d)
                assert('D2 消息与输入框之间留空', false, d)
                assert('D3 消息区无溢出滚动', false, d)
              }
              // 截图(布局视觉确认)
              {
                const image = await win.webContents.capturePage()
                fs.writeFileSync(process.env.WIDGET_SCREENSHOT + '.session-debug.png', image.toPNG())
                console.log('[widget] session-debug screenshot saved')
              }
              // ===== 场景 E:LLM 询问主人意见 → 询问与汇报绝不发回对方 =====
              // (2026-08-13 用户实测"LLM 询问我意见时,在回复别人消息之后又
              // 向别人发送本应对我的消息"——扩展信任联系人(222)的回复 =
              // 征求主人意见,原实现整条发回对方;执行轮向主人的汇报(已用
              // send 工具发出)也被面板路径整条发回)。修复:询问轮判定
              // isAskTurnToMaster 拦截 + 记 pending + 同步主人 QQ;执行轮
              // 标记化(只有【回复对方】才发回)+ 防重发。
              // **会话情况记录(2026-08-13)**:为 222 会话写记录 → 主进程
              // 注入引擎输入(E/F 各轮的 mock 请求都应看到【本会话情况记录】)
              if (wsReady) {
                await js(`localStorage.setItem('widget-agent-session-note:private:222', '测试情况记录:魔精是好友,喜欢电竞,回复简短活泼')`)
                pushPrivate('222', '魔精要被零封了$$ask-turn$$')
                await sleep(3000)
                const e1Result = await js(`(() => {
                  const out = {}
                  const raw = localStorage.getItem('widget-agent-session:private:222')
                  let msgs = []
                  try { msgs = JSON.parse(raw || '[]') } catch {}
                  out.lastText = msgs.length
                    ? (msgs[msgs.length - 1].parts ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('')
                    : ''
                  return JSON.stringify(out)
                })()`)
                const e1 = JSON.parse(e1Result)
                log('scenarioE1', { e1, to222: onebotReceived.filter((r) => r.action === 'send_private_msg' && String(r.params && r.params.user_id) === '222') })
                assert('E0 会话情况记录注入引擎输入(每轮参考)', llmRequests.slice(-3).some((r) => r.noteSeen), llmRequests.slice(-3).map((r) => ({ noteSeen: r.noteSeen, u: r.lastUser.slice(0, 30) })))
                assert('E1 询问轮回复未发回对方(222 未收到询问内容)', !onebotReceived.some((r) => r.action === 'send_private_msg' && String(r.params && r.params.user_id) === '222' && String(r.params && r.params.message).includes('要不要我回他')), onebotReceived.map((r) => r.action + ':' + (r.params && r.params.user_id)))
                assert('E1b 询问内容留在会话历史(对话窗口可见)', e1.lastText.includes('要不要我回他'), e1.lastText)
                assert('E1c 询问同步到主人 QQ(1178821869)', onebotReceived.some((r) => r.action === 'send_private_msg' && String(r.params && r.params.user_id) === '1178821869' && String(r.params && r.params.message).includes('要不要我回他')), onebotReceived.map((r) => r.action + ':' + (r.params && r.params.user_id)))
                // 主人在 222 会话面板指示 → 执行回复带标记 → 剥离标记发回
                await js(`(async () => {
                  const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
                  const fold = document.querySelector('.island-session-fold')
                  if (!document.querySelector('.island-session-dock.open')) fold?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
                  await sleep(600)
                  const item = [...document.querySelectorAll('.island-session-item')].find((el) => (el.textContent || '').indexOf('222') !== -1)
                  item?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
                  await sleep(900)
                  const ta = document.querySelector('.island-agent-input textarea')
                  if (!ta) return JSON.stringify({ fatal: 'no input' })
                  const setVal = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
                  setVal.call(ta, '$$mark-reply$$你自由发挥吧')
                  ta.dispatchEvent(new Event('input', { bubbles: true }))
                  await sleep(150)
                  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
                  return JSON.stringify({ ok: true })
                })()`)
                await sleep(3500)
                const e2Result = await js(`(() => {
                  const out = {}
                  out.winTexts = [...document.querySelectorAll('.island-msgs-window .island-agent-text')].map((el) => (el.textContent || ''))
                  return JSON.stringify(out)
                })()`)
                const e2 = JSON.parse(e2Result)
                log('scenarioE2', { e2, to222: onebotReceived.filter((r) => r.action === 'send_private_msg' && String(r.params && r.params.user_id) === '222').map((r) => r.params && r.params.message) })
                assert('E2 执行回复发回对方(剥离标记的调侃原文)', onebotReceived.some((r) => r.action === 'send_private_msg' && String(r.params && r.params.user_id) === '222' && String(r.params && r.params.message).includes('哈哈确实拉胯') && !String(r.params && r.params.message).includes('【回复对方】') && !String(r.params && r.params.message).includes('你自由发挥')), onebotReceived.map((r) => r.action + ':' + (r.params && r.params.message)))
                assert('E2b 对话窗口展示剥离标记后的执行回复', e2.winTexts.some((t) => t.includes('哈哈确实拉胯') && !t.includes('【回复对方】')), e2.winTexts)
                // ===== 场景 F:指纹负向严格验证(2026-08-13 二轮)=====
                // 指纹协议的核心保证 = "对不上就不发送":F1 无指纹直接回复
                // (不遵守协议的 LLM)、F2 错误/过期指纹(从历史抄来的旧指纹
                // 同样对不上)、F3 询问误带指纹(防御层 isAsk 拦截)——三种
                // 都必须扣留,绝不能发回对方;F4 各轮指纹互不相同(每轮
                // 唯一,历史里的旧指纹抄不到)
                pushPrivate('222', '$$no-fp$$在吗?')
                await sleep(3000)
                pushPrivate('222', '$$wrong-fp$$在吗?')
                await sleep(3000)
                pushPrivate('222', '$$ask-fp$$魔精要零封了')
                await sleep(3000)
                const fResult = await js(`(() => {
                  const out = {}
                  const raw = localStorage.getItem('widget-agent-session:private:222')
                  let msgs = []
                  try { msgs = JSON.parse(raw || '[]') } catch {}
                  out.texts = msgs.map((m) => (m.parts ?? []).map((p) => (p.type === 'text' ? p.text : '')).join(''))
                  return JSON.stringify(out)
                })()`)
                const f = JSON.parse(fResult)
                const to222F = onebotReceived.filter((r) => r.action === 'send_private_msg' && String(r.params && r.params.user_id) === '222').map((r) => String(r.params && r.params.message))
                const fpGates = (global.__fpGate || []).map((g) => g.reason)
                const fpsAll = llmRequests.map((r) => r.turnFp).filter(Boolean)
                log('scenarioF', { f, to222F, fpGates, fpsAll, fpsUnique: new Set(fpsAll).size })
                // 2026-08-13 二轮语义(用户要求"给 LLM 自主回复也加上指纹"):
                // 无指纹直接回复(忘带指纹的自主回复)/ 错误过期指纹 **不发送**
                // (指纹对不上就不发送);错配指纹即便进入发送路径也被发送
                // 边界剥离(恶性泄露根治);询问误带指纹 isAsk 拦截
                assert('F1 无指纹直接回复不发送(留在窗口)', !to222F.some((m) => m.includes('包在我身上')) && f.texts.some((t) => t.includes('包在我身上')), { to222F })
                assert('F2 错误/过期指纹不发送', !to222F.some((m) => m.includes('错指纹')) && f.texts.some((t) => t.includes('错指纹')), { to222F })
                assert('F3 询问误带指纹被拦截(不发给对方)', !to222F.some((m) => m.includes('要不要我回他')), { to222F })
                assert('F3b 询问误带指纹同步主人 QQ', onebotReceived.some((r) => r.action === 'send_private_msg' && String(r.params && r.params.user_id) === '1178821869' && String(r.params && r.params.message).includes('要不要我回他')), onebotReceived.map((r) => r.action + ':' + (r.params && r.params.user_id)))
                assert('F3c 指纹扣留原因可归因(global.__fpGate)', fpGates.includes('classify-hold') && fpGates.includes('qq-ask-with-fp'), fpGates)
                assert('F4 各轮指纹互不相同(每轮唯一)', new Set(fpsAll).size === fpsAll.length, { count: fpsAll.length })
                // ===== 场景 G:会话情况记录 UI + 快捷清空上下文(2026-08-13)=====
                // 横幅操作:「记录」→ 编辑态(textarea + 保存/取消)→ 写
                // localStorage;「清空」→ 两段式确认(首次点击进入确认态,
                // 再次点击执行)→ 该会话消息历史擦除
                await js(`(async () => {
                  const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
                  const fold = document.querySelector('.island-session-fold')
                  if (!document.querySelector('.island-session-dock.open')) fold?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
                  await sleep(600)
                  const item = [...document.querySelectorAll('.island-session-item')].find((el) => (el.textContent || '').indexOf('222') !== -1)
                  item?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
                  await sleep(900)
                  return 'ok'
                })()`)
                const g1Result = await js(`(() => {
                  const out = {}
                  out.banner = !!document.querySelector('.island-session-current')
                  out.ctlBtns = [...document.querySelectorAll('.island-session-current .island-session-ctl')].map((el) => (el.textContent || '').trim())
                  return JSON.stringify(out)
                })()`)
                const g1 = JSON.parse(g1Result)
                log('scenarioG1', g1)
                assert('G1 会话横幅显示 记录/清空 按钮', g1.banner && g1.ctlBtns.includes('记录') && g1.ctlBtns.includes('清空'), g1.ctlBtns)
                // 进入编辑态 → 输入 → 保存 → localStorage 落盘
                await js(`(() => {
                  const btns = [...document.querySelectorAll('.island-session-current .island-session-ctl')]
                  btns.find((el) => (el.textContent || '').includes('记录'))?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
                  return 'ok'
                })()`)
                await sleep(300)
                const g2Result = await js(`(() => {
                  const out = {}
                  out.editor = !!document.querySelector('.island-session-note-input')
                  out.hasSave = !!document.querySelector('.island-session-note-actions')
                  return JSON.stringify(out)
                })()`)
                const g2 = JSON.parse(g2Result)
                log('scenarioG2', g2)
                assert('G2 点击记录进入编辑态(输入框 + 保存/取消)', g2.editor && g2.hasSave, g2)
                await js(`(async () => {
                  const ta = document.querySelector('.island-session-note-input')
                  if (!ta) return 'no-ta'
                  const setVal = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
                  setVal.call(ta, 'UI 测试:魔精是同学,别太正式')
                  ta.dispatchEvent(new Event('input', { bubbles: true }))
                  await new Promise((res) => setTimeout(res, 100))
                  ;[...document.querySelectorAll('.island-session-note-actions .island-session-ctl')].find((el) => (el.textContent || '').includes('保存'))?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
                  return 'ok'
                })()`)
                await sleep(400)
                const g3Result = await js(`(() => {
                  const out = {}
                  out.note = localStorage.getItem('widget-agent-session-note:private:222') ?? ''
                  out.editorGone = !document.querySelector('.island-session-note-input')
                  out.btnTitle = document.querySelector('.island-session-current .island-session-ctl')?.getAttribute('title') ?? ''
                  return JSON.stringify(out)
                })()`)
                const g3 = JSON.parse(g3Result)
                log('scenarioG3', g3)
                assert('G3 保存情况记录 → localStorage 落盘 + 退出编辑态', g3.note.includes('UI 测试') && g3.editorGone, g3)
                // 两段式清空:首次点击进入确认态,再次点击执行 → 历史擦除
                await js(`(() => {
                  const btns = [...document.querySelectorAll('.island-session-current .island-session-ctl')]
                  btns.find((el) => (el.textContent || '').includes('清空'))?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
                  return 'ok'
                })()`)
                await sleep(300)
                const g4Armed = await js(`(() => {
                  const btns = [...document.querySelectorAll('.island-session-current .island-session-ctl')]
                  return btns.some((el) => (el.textContent || '').includes('确认清空'))
                })()`)
                log('scenarioG4-armed', g4Armed)
                assert('G4 首次点击清空进入确认态', g4Armed === true, g4Armed)
                await js(`(() => {
                  const btns = [...document.querySelectorAll('.island-session-current .island-session-ctl')]
                  btns.find((el) => (el.textContent || '').includes('确认清空'))?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
                  return 'ok'
                })()`)
                await sleep(800)
                const g5Result = await js(`(() => {
                  const out = {}
                  const raw = localStorage.getItem('widget-agent-session:private:222')
                  let msgs = []
                  try { msgs = JSON.parse(raw || '[]') } catch {}
                  out.count = msgs.length
                  out.noteKept = (localStorage.getItem('widget-agent-session-note:private:222') ?? '').includes('UI 测试')
                  // 窗口内对话记录(2026-08-13 用户实测"清空后窗口内对话记录
                  // 没有清空"):消息列表 DOM 与空态(.island-agent-welcome)
                  out.domItems = document.querySelectorAll('.island-msgs-window .island-msgs-item').length
                  out.domEmpty = !!document.querySelector('.island-agent-welcome')
                  out.streamText = document.querySelector('.island-msgs-window')?.textContent ?? ''
                  return JSON.stringify(out)
                })()`)
                const g5 = JSON.parse(g5Result)
                log('scenarioG5', g5)
                assert('G5 再次点击清空 → 会话历史擦除(记录保留)', g5.count === 0 && g5.noteKept, g5)
                assert('G5b 窗口内对话记录同步清空(DOM 消息数为 0 + 空态)', g5.domItems === 0 && g5.domEmpty, g5)
                // ===== 场景 H:LLM 自己生成记录 / 自己清空当前会话上下文 =====
                // (2026-08-13 用户要求"支持放 LLM 自己生成记录,自己清空
                // 当前会话上下文"):set_session_note 工具 → 主进程桥写
                // localStorage;clear_session_context 工具 → 擦除持久化
                // 历史 + session-context-cleared 事件 → 渲染端清消息状态
                pushPrivate('222', '$$session-note-tool$$帮我看下记录')
                await sleep(3500)
                const h1Note = await js(`localStorage.getItem('widget-agent-session-note:private:222') ?? ''`)
                log('scenarioH1', { h1Note })
                assert('H1 LLM set_session_note 工具生成记录(localStorage 落盘)', String(h1Note).includes('LLM 生成'), h1Note)
                pushPrivate('222', '$$clear-context-tool$$上下文太长了,清空吧')
                await sleep(3500)
                const h2Result = await js(`(() => {
                  const out = {}
                  const raw = localStorage.getItem('widget-agent-session:private:222')
                  let msgs = []
                  try { msgs = JSON.parse(raw || '[]') } catch {}
                  out.stored = msgs.map((m) => (m.parts ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('')).join(' ')
                  out.note = localStorage.getItem('widget-agent-session-note:private:222') ?? ''
                  out.domText = document.querySelector('.island-msgs-window')?.textContent ?? ''
                  return JSON.stringify(out)
                })()`)
                const h2 = JSON.parse(h2Result)
                log('scenarioH2', h2)
                assert('H2 LLM clear_session_context 清空上下文(旧记录消失)', !h2.stored.includes('包在我身上') && !h2.domText.includes('包在我身上'), h2)
                assert('H2b 清空上下文不清除情况记录', h2.note.includes('LLM 生成'), h2.note)
                // ===== 场景 I:会话指向性(2026-08-13 用户要求"发消息给他 =
                // 直接给私聊会话这个 QQ 发")=====
                // I1:外部会话输入带【当前会话对象】注入(LLM 知道"他/对方"
                // 指谁);I2:mock LLM 调 napcat send **不带 user_id** → 工具
                // 缺省 = 当前会话对象(private:222)→ 直接发给 222
                assert('I1 外部会话输入带【当前会话对象】注入', llmRequests.some((r) => r.sessObjSeen), llmRequests.slice(-6).map((r) => ({ s: r.sessObjSeen, u: r.lastUser.slice(0, 20) })))
                pushPrivate('222', '$$session-send$$发消息给他')
                await sleep(3500)
                const i2Sends = onebotReceived.filter((r) => r.action === 'send_private_msg' && String(r.params && r.params.message).includes('消息直接发给会话对象'))
                log('scenarioI2', { i2Sends })
                assert('I2 不带 user_id 的 send → 缺省发给当前会话对象(222)', i2Sends.some((r) => String(r.params && r.params.user_id) === '222'), i2Sends.map((r) => r.params && r.params.user_id))
                // ===== 场景 J:意图判定器兜底路由(2026-08-16)=====
                // 用户实测两病:① 该发给主人的消息因忘带主人指纹没发出去
                // (执行轮/群汇报的 master-no-fp/group-no-master-fp 扣留);
                // ② 发给别人的消息被发到主人 QQ(主人日常轮无指纹回复
                // 无条件直发主人)。修复:指纹缺失/歧义的轮次落定后调用独立
                // 意图判定 Sub Agent(master/other/hold)决定路由,判定失败
                // 回退原行为。
                // J0:先消费 F3 遗留的 pending(主人经 QQ 给执行轮带指纹回复
                //     → 发回 222),让后续主人日常轮处于无 pending 状态
                pushPrivate('1178821869', '$$mark-reply$$先回他一句')
                await sleep(3500)
                // J1:主人日常轮,回复 = 发给别人的话且无指纹 → 判定 other →
                //     扣留+通知,不再发主人(原实现无条件直发主人 = 串台根源)
                pushPrivate('1178821869', '帮我把"周末见"发给张三$$master-daily-other$$')
                await sleep(3500)
                // J2:主人日常轮,正常应答(无指纹)→ 判定 master → 直发主人
                pushPrivate('1178821869', '在吗$$master-daily-master$$')
                await sleep(3500)
                // J3:执行轮,主人指示后的执行回复忘带指纹 → 判定 other →
                //     发回待回复对象(原实现 master-no-fp 扣留 = 对方收不到)
                pushPrivate('222', '$$ask-turn$$魔精又要零封了')
                await sleep(3500)
                pushPrivate('1178821869', '$$exec-no-fp-other$$你看着办吧')
                await sleep(3500)
                // J4:执行轮,忘带主人指纹的汇报 → 判定 master → 发主人
                //     (原实现扣留 = 主人收不到执行汇报)
                pushPrivate('222', '$$ask-turn$$再来一轮')
                await sleep(3500)
                pushPrivate('1178821869', '$$exec-no-fp-master$$继续')
                await sleep(3500)
                // J5(2026-08-16 二轮):执行轮 LLM 把发给对方的话**误打主人
                //     指纹** → 主人指纹复核 → 判定 other → 发回待回复对象
                //     (原实现 masterFpResult 无条件发主人 = 串台,别人收不到)
                pushPrivate('222', '$$ask-turn$$魔精还要零封?')
                await sleep(3500)
                pushPrivate('1178821869', '$$exec-master-fp-mislabel$$继续回他')
                await sleep(3500)
                const toMasterJ = onebotReceived.filter((r) => r.action === 'send_private_msg' && String(r.params && r.params.user_id) === '1178821869').map((r) => String(r.params && r.params.message))
                const to222J = onebotReceived.filter((r) => r.action === 'send_private_msg' && String(r.params && r.params.user_id) === '222').map((r) => String(r.params && r.params.message))
                const fpGatesJ = (global.__fpGate || []).map((g) => g.reason)
                log('scenarioJ', { toMasterJ, to222J, fpGatesJ })
                assert('J0 消费 F3 遗留 pending(执行轮带指纹回复发回 222)', to222J.some((m) => m.includes('哈哈确实拉胯')), to222J)
                assert('J1 主人日常轮发给别人的话(无指纹)不发主人(判定 other 扣留)', !toMasterJ.some((m) => m.includes('周末见')), toMasterJ)
                assert('J1b 扣留原因可归因(master-other-no-target)', fpGatesJ.includes('master-other-no-target'), fpGatesJ)
                assert('J2 主人日常轮正常应答(判定 master)直发主人', toMasterJ.some((m) => m.includes('好的,这就去办')), toMasterJ)
                assert('J3 执行轮忘带指纹的执行回复(判定 other)发回待回复对象', to222J.some((m) => m.includes('明天晚上八点见')), to222J)
                assert('J4 执行轮忘带主人指纹的汇报(判定 master)发主人', toMasterJ.some((m) => m.includes('他让我谢谢主人')), toMasterJ)
                assert('J5 执行轮误打主人指纹的发给对方的话(复核 other)发回待回复对象', to222J.some((m) => m.includes('明天中午十二点见')), to222J)
                assert('J5b 复核后不再发主人(不串台)', !toMasterJ.some((m) => m.includes('明天中午十二点见')), toMasterJ)
                // J6(2026-08-16 二轮):判定器路由补标——J5 的回复(判定器
                // 路由,文本无指纹)气泡应带 qq-peer 类(sentToPeer 经
                // message-routed 补标,指纹 UI 标识不丢失);J2 的日常应答
                // (判定 master 发主人)气泡应带 master 标签
                await js(`(async () => {
                  const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
                  const fold = document.querySelector('.island-session-fold')
                  if (!document.querySelector('.island-session-dock.open')) fold?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
                  await sleep(600)
                  const item = [...document.querySelectorAll('.island-session-item')].find((el) => (el.textContent || '').indexOf('222') !== -1)
                  item?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
                  await sleep(1200)
                  return 'ok'
                })()`)
                await sleep(800)
                const routedResult = await js(`(() => {
                  const out = {}
                  const bubbles = [...document.querySelectorAll('.island-msgs-window .island-agent-msg-assistant')]
                  const hit = bubbles.find((b) => (b.textContent || '').includes('明天中午十二点见'))
                  out.found = !!hit
                  out.qqPeer = !!hit && hit.classList.contains('qq-peer')
                  return JSON.stringify(out)
                })()`)
                const routed = JSON.parse(routedResult)
                log('scenarioJ-routed', routed)
                assert('J6 判定器路由的回复补标(气泡带"发给对方"标识)', routed.found && routed.qqPeer, routed)
              }
            } catch (err) {
              log('error', String((err && err.stack) || err))
            } finally {
              // ---- 恢复:设置文件 + 渲染端存储 + 模式 ----
              let settingsRestoredOk = false
              try {
                if (settingsBackup !== null) fs.writeFileSync(settingsFile, settingsBackup)
                resetSettingsCache()
                // 校验恢复确实落盘(2026-08-13:静默失败让污染版残留,
                // 下一轮把它当备份 = 用户真实配置永久丢失)
                settingsRestoredOk = fs.readFileSync(settingsFile, 'utf8') === settingsBackup
                log('settings-restore', settingsRestoredOk ? 'ok' : 'MISMATCH')
              } catch (e) {
                log('settings-restore', 'error:' + String(e && e.message))
              }
              const restoreResult = await js(`(async () => {
                try {
                  for (const key of ['widget-agent-session:private:222', 'widget-agent-session:private:333']) localStorage.removeItem(key)
                  const backup = ${JSON.stringify(storageBackup)}
                  if (backup) {
                    for (let i = 0; i < localStorage.length; i++) {
                      const k = localStorage.key(i)
                      if (k && k.indexOf('widget-agent') === 0 && !(k in backup)) localStorage.removeItem(k)
                    }
                    for (const k of Object.keys(backup)) {
                      if (backup[k] === null) localStorage.removeItem(k)
                      else localStorage.setItem(k, backup[k])
                    }
                  }
                } catch (e) { return 'err:' + String(e && e.stack || e) }
                return 'restored'
              })()`).catch((e) => 'rejected:' + String(e && e.stack || e))
              log('restore', restoreResult)
              win.webContents.send('widget:set-mode', { mode: 'music', source: 'user' })
              // 清测试 QQ(222/333)在工具记忆里的痕迹(联系人档案/聊天备份
              // 自动落盘在主进程,不经 localStorage;不清理会残留进用户数据)
              try {
                const userData = path.dirname(settingsFile)
                const contactsP = path.join(userData, 'napcat-contacts.json')
                const chatsP = path.join(userData, 'napcat-chats.json')
                try {
                  const c = JSON.parse(fs.readFileSync(contactsP, 'utf8'))
                  for (const k of ['222', '333']) delete c[k]
                  fs.writeFileSync(contactsP, JSON.stringify(c, null, 2), 'utf8')
                } catch {}
                try {
                  const c = JSON.parse(fs.readFileSync(chatsP, 'utf8'))
                  const list = c.records || c || []
                  const kept = list.filter((r) => !(String(r.qq ?? r.target ?? '') === '222' || String(r.qq ?? r.target ?? '') === '333'))
                  if (kept.length !== list.length) {
                    if (Array.isArray(c.records)) {
                      c.records = kept
                      fs.writeFileSync(chatsP, JSON.stringify(c, null, 2), 'utf8')
                    } else {
                      fs.writeFileSync(chatsP, JSON.stringify(kept, null, 2), 'utf8')
                    }
                  }
                } catch {}
              } catch {}
              try { llmServer.close() } catch {}
              try { wsServer.close() } catch {}
              clearInterval(sampleTimer)
              log('asserts-summary', out.asserts.filter((x) => !x.ok).map((x) => x.name))
            }
          }

          const image = await win.webContents.capturePage()
          fs.writeFileSync(process.env.WIDGET_SCREENSHOT, image.toPNG())
          console.log('[widget] screenshot saved')
          // WIDGET_SCREENSHOT_QUIT=1:截图/巡检完成后优雅退出(不走托盘
          // 常驻;避免测试命令强杀进程树导致 renderer gone: crashed 假象)。
          // 直接 app.quit()(审计 P2-4:此前的 quitting = true 是 sloppy-mode
          // 全局赋值,main.cjs 模块作用域的 quitting 未被修改——退出靠
          // app.quit() → before-quit 自置位)
          // 2026-08-09:巡检完成必须可见——未带 QUIT 时应用托盘常驻,观感
          // 是"一直卡住";打完成日志 + 明确提示(用户报告"巡检最后卡住")
          const totalSec = Math.round((Date.now() - (global.__screenshotT0 || Date.now())) / 1000)
          console.log(`[widget] 巡检全部完成,总耗时 ${totalSec}s`)
          if (process.env.WIDGET_SCREENSHOT_QUIT === '1') {
            console.log('[widget] WIDGET_SCREENSHOT_QUIT=1 → 300ms 后 app.quit() 退出')
            setTimeout(() => app.quit(), 300)
          } else {
            console.log('[widget] 未设置 WIDGET_SCREENSHOT_QUIT=1 → 应用托盘常驻,不会自动退出(属正常,非卡住)')
          }
        } catch (err) {
          console.error('[widget] screenshot failed:', err)
        }
      }, 3000)
    })
}

module.exports = { runScreenshotTests }