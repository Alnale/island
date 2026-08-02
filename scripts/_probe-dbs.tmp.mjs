/** 临时探查:列出 Edge 真实 profile 在本地 origin 下现存的所有 IndexedDB 数据库 */
import puppeteer from 'puppeteer-core'

const ORIGINS = ['http://localhost:5173', 'http://localhost:4173']
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  userDataDir: 'C:/Users/asus/AppData/Local/Microsoft/Edge/User Data',
  headless: true,
  args: ['--no-first-run', '--no-default-browser-check', '--disable-extensions'],
})
const page = await browser.newPage()
for (const origin of ORIGINS) {
  try {
    await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 20000 })
    const jsUrl = await page.evaluate(() =>
      performance
        .getEntriesByType('resource')
        .map((r) => r.name)
        .find((n) => n.startsWith(location.origin) && n.includes('.js')),
    )
    if (jsUrl) {
      await page.goto(jsUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {})
    }
    const dbs = await page.evaluate(() =>
      indexedDB.databases().then((list) => list.map((d) => `${d.name}@v${d.version}`)),
    )
    console.log(`${origin}: ${dbs.length ? dbs.join(', ') : '(无数据库)'}`)
  } catch (err) {
    console.log(`${origin}: 失败 ${err.message}`)
  }
}
await browser.close()
console.log('DONE')
