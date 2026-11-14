/** QQ 路由的轮次状态。异步工具、审核和发送共享同一份快照，不读取下一轮状态。 */
const { AsyncLocalStorage } = require('node:async_hooks')
const { randomUUID } = require('node:crypto')

function createNapcatRouting({ now = Date.now, pendingTimeoutMs = 30 * 60 * 1000 } = {}) {
  const storage = new AsyncLocalStorage()
  const pending = new Map()

  function prunePending() {
    let removed = 0
    for (const [qq, item] of pending) {
      if (now() - item.at >= pendingTimeoutMs) {
        pending.delete(qq)
        removed++
      }
    }
    return removed
  }

  function rememberPending(qq, text) {
    const item = Object.freeze({ id: randomUUID(), qq: String(qq), text: String(text), at: now() })
    pending.set(item.qq, item)
    return item
  }

  function selectPending(sessionKey, text) {
    prunePending()
    const privateQQ = /^private:(\d+)$/.exec(sessionKey)?.[1]
    if (privateQQ) return pending.get(privateQQ) ?? null
    // 群会话里的「他」由本群上下文决定，不能借用私聊待办。
    if (String(sessionKey).startsWith('group:')) return null
    // 显式 QQ 优先；提到别的号码也不能回退到唯一待办。多人待办不猜「他」是谁。
    const ids = [...String(text).matchAll(/(?<!\d)\d{5,12}(?!\d)/g)].map((m) => m[0])
    if (ids.length) {
      const unique = [...new Set(ids)]
      return unique.length === 1 ? pending.get(unique[0]) ?? null : null
    }
    // 单个待办也不能劫持「回复张三」「发到群里」等另有对象的指令。
    const refersToPending = /(?:回|回复|告诉|转告|发给|发)(?:给|一下|一声)?(?:他|她|对方)|(?:就这么|按[我你]说的|照[我你]说的)(?:回|发|说)/.test(String(text))
    return pending.size === 1 && refersToPending ? pending.values().next().value : null
  }

  function consumePending(item) {
    if (item && pending.get(item.qq)?.id === item.id) pending.delete(item.qq)
  }

  function begin(route, input) {
    const group = input.groupTurn ?? {}
    const turn = {
      ...input,
      turnTag: randomUUID(),
      turnGroupSpeakerQQ: String(group.speakerQQ ?? ''),
      turnGroupDirected: !!group.directed,
      turnGroupPlain: String(group.plain ?? ''),
      turnGroupAtQQs: Object.freeze(Array.isArray(group.atQQs) ? group.atQQs.filter((q) => typeof q === 'string') : []),
      pendingReply: input.turnOwner === 'master' && input.turnKind !== 'ask'
        ? selectPending(input.sessionKey, input.triggerRaw)
        : null,
      sent: [],
      routed: false,
      cancelled: false,
    }
    route.activeTurn = turn
    return turn
  }

  function take(route, tag) {
    const turn = route?.activeTurn
    // 先核对再消费。旧事件绝不能清掉新轮；重复事件也不再投递。
    if (!tag || !turn || turn.turnTag !== tag || turn.routed || turn.cancelled) return null
    turn.routed = true
    return turn
  }

  function current(sessionKey) {
    const turn = storage.getStore()
    return turn && !turn.cancelled && (!sessionKey || turn.sessionKey === sessionKey) ? turn : null
  }

  function recordSent(message) {
    const turn = current()
    if (turn) turn.sent.push({ type: message.type, target: String(message.target), text: String(message.text ?? '') })
  }

  function alreadySent(turn, type, target, textOnly = false) {
    return !!turn?.sent.some((m) => m.type === type && m.target === target &&
      (!textOnly || (m.text.trim() && m.text !== '(图片/文件/语音)')))
  }

  return {
    begin, take, current, recordSent, alreadySent,
    run: (turn, fn) => storage.run(turn, fn),
    cancel(route) { if (route?.activeTurn) route.activeTurn.cancelled = true },
    rememberPending, selectPending, consumePending, prunePending,
    pendingList() { prunePending(); return [...pending.values()] },
    forgetPending(qq) { pending.delete(String(qq)) },
  }
}

module.exports = { createNapcatRouting }
