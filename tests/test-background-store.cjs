/* backgroundStore 背景参数读写回归测试;不触碰真实 localStorage/IndexedDB。
 *
 * 重点回归 2026-10-22「自定义图片背景导入后无法正确应用」:
 * 旧读取逻辑对缺失的旧版键做 Number(localStorage.getItem(...))——
 * getItem 缺键返回 null 而 Number(null) === 0,通过 0~1 校验后把默认
 * 不透明度 0.4 覆写成 0,背景图层 opacity 恒 0 完全不可见。 */
const assert = require('node:assert/strict')
const path = require('node:path')
const esbuild = require('esbuild')

/** 极简 localStorage 替身(仅 getItem/setItem/removeItem 走到的部分) */
function makeLocalStorage() {
  const map = new Map()
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(String(k), String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
    get length() {
      return map.size
    },
  }
}

/** 把 TS 模块编译成 CJS 后在假 localStorage 环境里加载 */
function loadStore(localStorage) {
  const built = esbuild.buildSync({
    entryPoints: [path.join(__dirname, '..', 'src', 'media', 'backgroundStore.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'neutral',
    write: false,
  })
  const code = built.outputFiles[0].text
  const mod = { exports: {} }
  const fn = new Function('module', 'exports', 'localStorage', 'window', code)
  fn(mod, mod.exports, localStorage, {})
  return mod.exports
}

function test(name, fn) {
  try {
    fn()
    console.log(`PASS ${name}`)
  } catch (err) {
    console.error(`FAIL ${name}:`, err)
    process.exitCode = 1
  }
}

test('全新存储(无任何键)读到默认 0.4,不再被 Number(null) 覆写成 0', () => {
  const store = loadStore(makeLocalStorage())
  const { opacity } = store.readBackgroundParams()
  assert.equal(opacity.expanded, 0.4)
  assert.equal(opacity.compact, 0.4)
})

test('旧版单独键存在时迁移到双槽位(保留用户值)', () => {
  const ls = makeLocalStorage()
  ls.setItem('widget-background-opacity', '0.25')
  const store = loadStore(ls)
  const { opacity } = store.readBackgroundParams()
  assert.equal(opacity.expanded, 0.25)
  assert.equal(opacity.compact, 0.25)
})

test('旧版单独键为非法值时不覆盖默认', () => {
  const ls = makeLocalStorage()
  ls.setItem('widget-background-opacity', 'not-a-number')
  const store = loadStore(ls)
  const { opacity } = store.readBackgroundParams()
  assert.equal(opacity.expanded, 0.4)
  assert.equal(opacity.compact, 0.4)
})

test('被误写成 0 的旧版数据(无 v 标记)自愈回默认,部分槽位同样修复', () => {
  const ls = makeLocalStorage()
  ls.setItem(
    'widget-background',
    JSON.stringify({
      opacity: { expanded: 0, compact: 0 },
      expanded: { zoom: 1, posX: 50, posY: 50 },
      compact: { zoom: 2, posX: 30, posY: 70 },
    }),
  )
  const store = loadStore(ls)
  const params = store.readBackgroundParams()
  assert.equal(params.opacity.expanded, 0.4)
  assert.equal(params.opacity.compact, 0.4)
  // 裁切参数不受自愈影响
  assert.equal(params.compact.zoom, 2)
  assert.equal(params.compact.posX, 30)
})

test('旧版单数值 0 同样自愈;非 0 值原样保留', () => {
  const ls = makeLocalStorage()
  ls.setItem('widget-background', JSON.stringify({ opacity: 0 }))
  assert.equal(loadStore(ls).readBackgroundParams().opacity.expanded, 0.4)

  const ls2 = makeLocalStorage()
  ls2.setItem('widget-background', JSON.stringify({ opacity: 0.6 }))
  assert.equal(loadStore(ls2).readBackgroundParams().opacity.expanded, 0.6)
})

test('saveBackgroundParams 落盘带 v 标记,之后有意设置的 0 被尊重', () => {
  const ls = makeLocalStorage()
  const store = loadStore(ls)
  store.saveBackgroundParams({
    opacity: { expanded: 0, compact: 0.7 },
    expanded: store.DEFAULT_BG_CROP,
    compact: store.DEFAULT_BG_CROP,
  })
  const saved = JSON.parse(ls.getItem('widget-background'))
  assert.equal(saved.v, store.BACKGROUND_PARAMS_VERSION)
  const reread = store.readBackgroundParams()
  assert.equal(reread.opacity.expanded, 0)
  assert.equal(reread.opacity.compact, 0.7)
})

test('backgroundVeilColor:不透明度收成深色蒙层,90% 只压暗一成', () => {
  const store = loadStore(makeLocalStorage())
  assert.equal(store.backgroundVeilColor(1), 'rgba(8, 10, 14, 0)')
  assert.equal(store.backgroundVeilColor(0.9), 'rgba(8, 10, 14, 0.1)')
  assert.equal(store.backgroundVeilColor(0), 'rgba(8, 10, 14, 1)')
  assert.equal(store.backgroundVeilColor(undefined), 'rgba(8, 10, 14, 0)')
})

test('revealBackgroundOpacity:新图落到 0 不透明度槽位时抬回默认', () => {
  const store = loadStore(makeLocalStorage())
  const hidden = { expanded: 0, compact: 0.2 }
  assert.deepEqual(store.revealBackgroundOpacity(hidden, 'expanded'), { expanded: 0.4, compact: 0.2 })
  assert.deepEqual(store.revealBackgroundOpacity(hidden, 'compact'), hidden)
})

test('backgroundCssUrl:data URL 收成短 blob URL,不把整段 base64 写进 CSS 变量', () => {
  const store = loadStore(makeLocalStorage())
  const png =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  const css = store.backgroundCssUrl(png)
  assert.equal(css.startsWith('url("blob:'), true)
  assert.equal(css.includes('iVBORw0KGgo'), false)
  assert.equal(css.length < 200, true)
  assert.equal(store.backgroundCssUrl(png), css)
  assert.equal(store.backgroundCssUrl(null), 'none')
  assert.equal(store.backgroundCssUrl(''), 'none')
  store.releaseBackgroundDisplayUrls([])
  const again = store.backgroundCssUrl(png)
  assert.equal(again.startsWith('url("blob:'), true)
  assert.notEqual(again, css)
  store.releaseBackgroundDisplayUrls([png])
  assert.equal(store.backgroundCssUrl(png), again)
})

test('保存再读回:任意合法参数无损往返', () => {
  const ls = makeLocalStorage()
  const store = loadStore(ls)
  const params = {
    opacity: { expanded: 0.8, compact: 0.1 },
    expanded: { zoom: 1.5, posX: 10, posY: 90 },
    compact: { zoom: 4, posX: 0, posY: 100 },
  }
  store.saveBackgroundParams(params)
  assert.deepEqual(store.readBackgroundParams(), params)
})
