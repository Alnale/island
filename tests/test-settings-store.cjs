/* settings-store 与 data-manifest 回归测试；不读取真实 userData。 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createSettingsStore } = require('../electron/settings-store.cjs')
const { APP_DATA_ENTRIES, TOOL_DATA_ENTRIES, clearManagedData, resolveManagedPath } = require('../electron/data-manifest.cjs')

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dynamic-island-settings-'))
const secretStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`sealed:${value}`),
  decryptString: (value) => value.toString('utf8').replace(/^sealed:/, ''),
}
const makeStore = () => createSettingsStore({ safeStorage: secretStorage, getUserDataPath: () => temp })

function test(name, fn) {
  try {
    fn()
    console.log(`PASS ${name}`)
  } catch (err) {
    console.error(`FAIL ${name}:`, err)
    process.exitCode = 1
  }
}

test('所有嵌套密钥均以 enc:v1 加密，主文件与备份不含明文', () => {
  const store = makeStore()
  const token = 'provider-secret-123'
  const mcpToken = 'mcp-token-456'
  store.save({
    agent: {
      apiKey: token,
      providers: { deepseek: { apiKey: token }, glm: { apiKey: 'glm-secret' } },
      mcpServers: [{ name: 'remote', headers: { Authorization: `Bearer ${mcpToken}` }, env: { API_TOKEN: mcpToken } }],
    },
  })
  store.flush()
  // 第二次保存会生成安全的 backup，覆盖旧版写入路径。
  store.save({ mode: 'agent' })
  store.flush()
  const main = fs.readFileSync(path.join(temp, 'settings.json'), 'utf8')
  const backup = fs.readFileSync(path.join(temp, 'settings.json.bak'), 'utf8')
  for (const text of [main, backup]) {
    assert(!text.includes(token))
    assert(!text.includes(mcpToken))
    assert(text.includes('enc:v1:'))
  }
  const loaded = makeStore().load()
  assert.equal(loaded.agent.apiKey, token)
  assert.equal(loaded.agent.providers.deepseek.apiKey, token)
  assert.equal(loaded.agent.mcpServers[0].headers.Authorization, `Bearer ${mcpToken}`)
})

test('旧版明文与 enc: 前缀会在下一次写入时迁移', () => {
  const oldToken = 'old-plaintext-token'
  fs.writeFileSync(path.join(temp, 'settings.json'), JSON.stringify({ agent: { apiKey: oldToken, providers: { mimo: { apiKey: 'enc:' + Buffer.from('sealed:legacy-token').toString('base64') } } } }))
  const store = makeStore()
  const loaded = store.load()
  assert.equal(loaded.agent.apiKey, oldToken)
  assert.equal(loaded.agent.providers.mimo.apiKey, 'legacy-token')
  store.save({ mode: 'music' })
  store.flush()
  const disk = fs.readFileSync(path.join(temp, 'settings.json'), 'utf8')
  assert(!disk.includes(oldToken))
  assert(!disk.includes('legacy-token'))
  assert(disk.includes('enc:v1:'))
})

test('工厂重置覆盖数据清单及 settings 主、备、临时文件', () => {
  for (const entry of APP_DATA_ENTRIES) {
    const target = path.join(temp, entry)
    if (path.extname(entry)) fs.mkdirSync(path.dirname(target), { recursive: true })
    if (entry.includes('.') && !entry.endsWith('snapshots')) fs.writeFileSync(target, 'fixture')
    else fs.mkdirSync(target, { recursive: true })
  }
  const result = clearManagedData(temp, 'app')
  assert.equal(result.ok, true)
  for (const entry of APP_DATA_ENTRIES) assert.equal(fs.existsSync(path.join(temp, entry)), false, entry)
  const again = clearManagedData(temp, 'app')
  assert.equal(again.ok, true)
})

test('清单路径不得逃出 userData', () => {
  assert.throws(() => resolveManagedPath(temp, path.join('..', 'outside.txt')))
  assert.throws(() => resolveManagedPath(temp, ''))
})

test('单项删除失败时报告失败且不宣称成功', () => {
  fs.writeFileSync(path.join(temp, 'privacy.json'), 'x')
  fs.writeFileSync(path.join(temp, 'memory.json'), 'x')
  const result = clearManagedData(temp, 'app', (target, opts) => {
    if (target.endsWith('privacy.json')) throw new Error('EPERM: locked')
    fs.rmSync(target, opts)
  })
  assert.equal(result.ok, false)
  assert.ok(result.failures.some((item) => item.entry === 'privacy.json'))
  assert.equal(fs.existsSync(path.join(temp, 'privacy.json')), true)
})

test('清除工具数据只删数据子路径:工具本体与 bili 根目录必须保留', () => {
  const bili = path.join(temp, 'bili')
  fs.mkdirSync(path.join(bili, 'config'), { recursive: true })
  fs.writeFileSync(path.join(bili, 'config', 'cookies.json'), '{}')
  fs.mkdirSync(path.join(bili, 'downloads'), { recursive: true })
  fs.writeFileSync(path.join(bili, 'downloads', 'video.mp4'), 'video')
  fs.mkdirSync(path.join(bili, '.progress'), { recursive: true })
  fs.writeFileSync(path.join(bili, '.progress', 'p.json'), '{}')
  // 极端场景:工具本体被放进 userData(旧安装布局),也不得被当数据删除
  fs.writeFileSync(path.join(bili, 'bili-tool.exe'), 'MZ')
  fs.mkdirSync(path.join(temp, 'docflow', 'output'), { recursive: true })
  fs.writeFileSync(path.join(temp, 'docflow', 'output', 'a.pdf'), 'pdf')

  const result = clearManagedData(temp, 'tools')
  assert.equal(result.ok, true)
  for (const entry of TOOL_DATA_ENTRIES) {
    assert.equal(fs.existsSync(path.join(temp, entry)), false, `${entry} 应被清除`)
  }
  assert.equal(fs.existsSync(bili), true, 'bili 根目录必须保留(bili-tool 的 cwd)')
  assert.equal(fs.existsSync(path.join(bili, 'bili-tool.exe')), true, '工具本体不得被删除')
})

test('无法加密时不把密钥写成明文，内存仍保留', () => {
  const dir = path.join(temp, 'no-enc')
  fs.mkdirSync(dir, { recursive: true })
  const store = createSettingsStore({
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: () => { throw new Error('unavailable') },
      decryptString: () => '',
    },
    getUserDataPath: () => dir,
  })
  store.save({ agent: { apiKey: 'plain-secret' } })
  store.flush()
  const disk = fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')
  assert.ok(!disk.includes('plain-secret'))
  assert.ok(disk.includes('"settingsSchemaVersion": 4'))
  assert.equal(store.load().agent.apiKey, 'plain-secret')
  assert.equal(store.didSecretPersist(), false)
})

test('destroy 后不再写盘，revive 可再读', () => {
  const dir = path.join(temp, 'destroy')
  fs.mkdirSync(dir, { recursive: true })
  const store = createSettingsStore({ safeStorage: secretStorage, getUserDataPath: () => dir })
  store.save({ mode: 'agent' })
  store.flush()
  store.destroy()
  store.save({ mode: 'music' })
  store.flush()
  const disk = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'))
  assert.equal(disk.mode, 'agent')
  store.revive()
  assert.equal(store.load().mode, 'agent')
})

fs.rmSync(temp, { recursive: true, force: true })
if (!process.exitCode) console.log('settings-store tests: all passed')
