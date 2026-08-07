/**
 * 截图/巡检测试模式(WIDGET_SCREENSHOT env)——从 main.cjs 抽出
 * (2026-08-06 架构优化:原内嵌 ~1160 行,占主进程一半以上)。
 * 仅当设置了 WIDGET_SCREENSHOT 时经 deps 注入调用,不参与正常运行路径。
 * 依赖全部注入(win / app / fs / path / settingsPath / runIslandSettings),
 * 保持 main.cjs 与测试代码零耦合。
 */

function runScreenshotTests({ win, app, fs, path, settingsPath, runIslandSettings, resetSettingsCache, runProactiveGuess, startProactiveTurn, getLastProactiveTick }) {

    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
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
              // 5. 帮助视图 → 返回
              settingsItem('帮助手册').dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(400)
              out.helpShown = !!document.querySelector('.island-help-items')
              document.querySelector('.island-panel-list:has(.island-help-items) .island-bg-back').dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(400)
              out.backToSettings4 = !!document.querySelector('.island-settings-items')
              // 6. 设置 → 返回收起(设置视图只能经返回键退出)
              document.querySelector('.island-panel-list:has(.island-settings-items) .island-bg-back').dispatchEvent(new MouseEvent('click', { bubbles: true }))
              await sleep(900)
              out.collapsed = !island.classList.contains('expanded')
              return JSON.stringify(out)
            })()`)
            console.log('[widget] test:', result)
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
              await sleep(1100)
              out.expanded = island.classList.contains('expanded')
              const ta = document.querySelector('.island-agent-input textarea')
              out.inputShown = !!ta
              // 调试:展开后面板实际视图
              out.settingsShown = !!document.querySelector('.island-settings-items')
              out.agentViewShown = !!document.querySelector('.island-agent-view')
              out.panelHtml = document.querySelector('.island-panel')?.className ?? '(无面板)'
              out.panelContent = (document.querySelector('.island-panel')?.innerHTML ?? '').replace(/<[^>]+>/g, ' ').trim().slice(0, 120)
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
            const toolsResult = await win.webContents.executeJavaScript(`(async () => {
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
              const hBefore = island?.offsetHeight ?? 0
              const headMenu = () => document.querySelector('.island-agent-head .island-quick-menu')
              headMenu()?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: null }))
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
            {
              const js = (code) => win.webContents.executeJavaScript(code)
              const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
              const out = {}
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
                const g = await runProactiveGuess(proactiveMessage)
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
                startProactiveTurn([proactiveMessage], { hint: '巡检测试' })
                const realBubble = JSON.parse(
                  await js(`(async () => {
                    const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
                    // 120s:真实回合含思考模式 + 可能工具,LLM 偶发慢
                    // (实测 90s 曾超时;文本可为空——落定判定只看气泡数增长)
                    const deadline = Date.now() + 120000
                    while (Date.now() < deadline) {
                      const msgs = document.querySelectorAll('.island-agent-msg-assistant')
                      const last = msgs[msgs.length - 1]
                      const text = last?.textContent ?? ''
                      if (msgs.length > ${bubbleBefore} && !text.includes('在呢')) {
                        return JSON.stringify({ landed: true, text: text.slice(0, 80) })
                      }
                      await sleep(2000)
                    }
                    return JSON.stringify({ landed: false })
                  })()`),
                )
                out.realTurnLanded = realBubble.landed
                out.realTurnText = realBubble.text ?? ''
                // 回合落定后主进程钩子自动跑揣测 → 第二条系统通知
                // (与回合消息同链,最长 ~70s)
                const realNoticeDeadline = Date.now() + 70000
                while (Date.now() < realNoticeDeadline && captured.length < 2) {
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
            {
              const js = (code) => win.webContents.executeJavaScript(code)
              const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
              const out = {}
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
                const tickDeadline = Date.now() + 90000
                while (Date.now() < tickDeadline && !getLastProactiveTick()) {
                  await sleep(2000)
                }
                const tick = getLastProactiveTick()
                out.tickTriggered = !!tick
                out.tickReason = tick?.reason ?? '(未触发)'
                // 4. judge 通过:等通知(回合落定 → 钩子 → 揣测通知;≤120s)
                if (tick?.started) {
                  const noticeDeadline = Date.now() + 120000
                  while (Date.now() < noticeDeadline && captured.length === 0) {
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
          const image = await win.webContents.capturePage()
          fs.writeFileSync(process.env.WIDGET_SCREENSHOT, image.toPNG())
          console.log('[widget] screenshot saved')
          // WIDGET_SCREENSHOT_QUIT=1:截图/巡检完成后优雅退出(不走托盘
          // 常驻;避免测试命令强杀进程树导致 renderer gone: crashed 假象)。
          // 直接 app.quit()(审计 P2-4:此前的 quitting = true 是 sloppy-mode
          // 全局赋值,main.cjs 模块作用域的 quitting 未被修改——退出靠
          // app.quit() → before-quit 自置位)
          if (process.env.WIDGET_SCREENSHOT_QUIT === '1') {
            setTimeout(() => app.quit(), 300)
          }
        } catch (err) {
          console.error('[widget] screenshot failed:', err)
        }
      }, 3000)
    })
}

module.exports = { runScreenshotTests }
