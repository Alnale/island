/**
 * 临时测试脚本:Agent 引擎端到端 —— B站搜索 + 下载
 * 直接驱动 electron/agent.cjs(主进程同款引擎),stub 掉 electron 依赖
 * (Notification/shell 在纯 Node 下不可用)。
 *
 * 用法:node scripts/test-bili-download.cjs ["测试文本"]
 * 缺省文本:打开B站搜索极客湾,下载第一条视频
 */
const Module = require('module')
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return {
      Notification: class Notification {
        constructor() {}
        show() {}
      },
      shell: { openPath: async () => {}, openExternal: async () => {} },
    }
  }
  return origLoad.apply(this, arguments)
}

const path = require('path')
const os = require('os')
const fs = require('fs')

// 读取主进程 Agent 配置(userData/settings.json)
const settingsPath = path.join(os.homedir(), 'AppData', 'Roaming', 'dynamic-island', 'settings.json')
let agentCfg = {}
try {
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
  agentCfg = settings.agent || {}
} catch {
  console.warn('[warn] 未找到 settings.json,将使用空配置(引擎会提示未配置 API Key)')
}

const { createAgentEngine } = require('../electron/agent.cjs')

const engine = createAgentEngine({
  getConfig: () => ({
    apiKey: agentCfg.apiKey || '',
    baseURL: agentCfg.baseURL || 'https://api.deepseek.com',
    model: agentCfg.model || 'deepseek-v4-flash',
    systemPrompt: agentCfg.systemPrompt || '',
    reasoningEffort: agentCfg.reasoningEffort || 'high',
  }),
  onEvent: (e) => {
    if (e.type === 'status') console.log(`\n[status] ${e.status}`)
    else if (e.type === 'text-delta') process.stdout.write(e.text)
    else if (e.type === 'tool-call') console.log(`\n[tool-call] ${e.name} args=${e.args}`)
    else if (e.type === 'tool-result')
      console.log(`\n[tool-result] ${e.name} ok=${e.ok} -> ${String(e.result).slice(0, 300)}`)
    else if (e.type === 'error') console.log(`\n[error] ${e.message}`)
    else if (e.type === 'message') console.log(`\n[message] 落定 parts=${e.message.parts.length}`)
  },
  onSwitchToMusic: () => {},
})

const text = process.argv[2] || '打开B站搜索极客湾,下载第一条视频'
console.log('=== 测试文本:', text, '===')
console.log('API:', agentCfg.baseURL || '(默认)', '模型:', agentCfg.model || '(默认)')
engine.send(text, [])

// 引擎无完成事件:轮询 busy 或超时兜底(工具循环最多 25 轮)
const deadline = Date.now() + 240000
const poll = setInterval(() => {
  if (!engine.busy || Date.now() > deadline) {
    clearInterval(poll)
    console.log('\n=== 引擎结束 ===')
    process.exit(0)
  }
}, 500)
