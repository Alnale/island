/**
 * 临时清理脚本(发布前清除本地已上传曲目记录):
 * 打开 Edge/Chrome 真实 profile,在本地 origin 下删除 IndexedDB 的
 * "island-uploads" 数据库。用完即删。
 *
 * 关键点:应用挂载时会长期持有 DB 连接(deleteDatabase 会被 onblocked 卡住),
 * 因此先加载 origin 拿到资源列表,再导航到该 origin 下某个 .js 资源
 * (非应用文档、同源、无 DB 连接),在此文档内执行删除。
 */
import puppeteer from 'puppeteer-core'

const DB = 'island-uploads'
const ORIGINS = ['http://localhost:5173', 'http://localhost:4173']
const BROWSERS = [
  {
    label: 'edge',
    exe: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    profile: 'C:/Users/asus/AppData/Local/Microsoft/Edge/User Data',
  },
  {
    label: 'chrome',
    exe: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    profile: 'C:/Users/asus/AppData/Local/Google/Chrome/User Data',
  },
]

/** 在当前文档内删除指定 DB,返回 {deleted, still} */
function deleteDbInDoc(dbName) {
  return new Promise((resolve) => {
    indexedDB.databases().then((dbs) => {
      if (!dbs.some((d) => d.name === dbName)) return resolve({ deleted: false })
      const req = indexedDB.deleteDatabase(dbName)
      const timer = setTimeout(() => resolve({ deleted: false, blocked: true }), 8000)
      req.onsuccess = () => {
        clearTimeout(timer)
        indexedDB.databases().then((after) => {
          resolve({ deleted: true, still: after.some((d) => d.name === dbName) })
        })
      }
      req.onerror = () => {
        clearTimeout(timer)
        resolve({ deleted: false, error: String(req.error) })
      }
      req.onblocked = () => {
        clearTimeout(timer)
        resolve({ deleted: false, blocked: true })
      }
    })
  })
}

for (const b of BROWSERS) {
  let browser
  try {
    browser = await puppeteer.launch({
      executablePath: b.exe,
      userDataDir: b.profile,
      headless: true,
      args: ['--no-first-run', '--no-default-browser-check', '--disable-extensions'],
    })
  } catch (err) {
    console.log(`${b.label}: 启动失败(profile 可能被占用): ${err.message}`)
    continue
  }
  const page = await browser.newPage()
  for (const origin of ORIGINS) {
    try {
      await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 20000 })
      // 取一个同源 .js 资源地址(应用自身资源;dev 为 /@vite/client)
      const jsUrl = await page.evaluate(() =>
        performance
          .getEntriesByType('resource')
          .map((r) => r.name)
          .find((n) => n.startsWith(location.origin) && n.includes('.js')),
      )
      if (jsUrl) {
        await page.goto(jsUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {})
      }
      const result = await page.evaluate(deleteDbInDoc, DB)
      const label = jsUrl ? `(经 ${jsUrl.replace(origin, '')})` : '(直接)'
      console.log(`${b.label} ${origin} ${label}:`, JSON.stringify(result))
    } catch (err) {
      console.log(`${b.label} ${origin}: 失败: ${err.message}`)
    }
  }
  await browser.close()
}
console.log('DONE')
