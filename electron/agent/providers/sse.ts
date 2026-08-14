/**
 * SSE 解析公共层(2026-08-07 审计 P1:parseSse 原在 deepseek/chat/
 * anthropic 三处逐字重复,仅 yield 形态不同——收敛为单一实现)
 */

/** 单个 SSE 事件(OpenAI 兼容格式:data: JSON 帧,type 字段作事件名) */
export interface SseFrame {
  type: string
  data: Record<string, unknown>
}

/**
 * 读取一块数据,期间中止则返回 aborted 标记(**不销毁 socket**——销毁由
 * 调用方在安全点执行)。中止与 read() 竞态时,先到者胜;read() 被
 * 取消产生的 AbortError 拒绝被吞掉(由 abort 分支完成结算)
 */
async function readOrAborted(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<{ aborted: true } | { aborted: false; done: boolean; value?: Uint8Array }> {
  if (signal.aborted) return { aborted: true }
  return await new Promise((resolve) => {
    let settled = false
    const finish = (r: { aborted: true } | { aborted: false; done: boolean; value?: Uint8Array }) => {
      if (settled) return
      settled = true
      resolve(r)
    }
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort)
      finish({ aborted: true })
    }
    signal.addEventListener('abort', onAbort, { once: true })
    reader.read().then(
      (r) => {
        signal.removeEventListener('abort', onAbort)
        finish({ aborted: false, done: r.done, value: r.value })
      },
      () => {
        // 取消产生的 AbortError 拒绝:中止分支已结算则忽略;未结算
        // (异常情况)按中止处理
        signal.removeEventListener('abort', onAbort)
        finish({ aborted: true })
      },
    )
  })
}

/**
 * 解析 SSE 字节流:按空行分帧,取 data: 行的 JSON(OpenAI 兼容格式)。
 * 非 JSON 帧 / 无 type 字段 / 注释心跳跳过;中止时在安全点取消读取并
 * 正常结束(不再抛 AbortError——调用方按 signal.aborted 判定中止)。
 * 三个 provider(deepseek / chat / anthropic)共用
 *
 * **中止安全点(2026-08-13,Electron 43 内置 Node 22 llhttp UAF 规避)**:
 * Node 的 llhttp HTTP 解析器存在 use-after-free(nodejs/node#62095,
 * Node v25.8.1 才修复):解析执行(llhttp_execute)在栈上时销毁连接
 * (freeParser)会 EXCEPTION_ACCESS_VIOLATION。fetch(url, {signal})
 * 的中止恰好在解析中途销毁 socket——实测挂件主进程段错误(崩溃栈
 * llhttp_message_needs_eof,流量越大越频繁)。规避:fetch 不再传
 * signal(见三个 provider),中止判定移到这里——read() 返回即当前
 * 分块解析完毕(execute 不在栈上),此刻 cancel 销毁 socket 安全;
 * 中止时 read() 挂起(无数据到达,解析器空闲)同样安全。语义不变:
 * 中止后流立即结束,provider 按 signal.aborted 返回 aborted 结果。
 */
export async function* parseSse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<SseFrame> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      if (signal.aborted) {
        // 安全点取消:上一块已解析完(或尚未开始),销毁 socket 不撞 UAF
        await reader.cancel()
        break
      }
      const r = await readOrAborted(reader, signal)
      if (r.aborted) {
        // 中止先于数据到达:取消挂起的读取(解析器空闲,安全)
        await reader.cancel()
        break
      }
      if (r.done) break
      buffer += decoder.decode(r.value!, { stream: true })
      let sep: number
      while ((sep = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const frame = buffer.slice(0, sep)
        buffer = buffer.slice(sep + 2)
        const dataLine = frame
          .split(/\r?\n/)
          .map((l) => l.trim())
          .find((l) => l.startsWith('data:'))
        if (!dataLine) continue
        const payload = dataLine.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        try {
          const parsed = JSON.parse(payload) as Record<string, unknown>
          if (parsed && typeof parsed === 'object' && typeof parsed.type === 'string') {
            // 帧数据深度清洗孤立代理(2026-08-11):流式回复在 emoji 代理对
            // 中间被截断(max_output_tokens)时,delta 会含孤立代理——不清洗
            // 就进历史,下轮回传触发 400 unexpected end of hex escape
            yield { type: parsed.type, data: sanitizeJsonStrings(parsed) }
          }
        } catch {
          // 非 JSON 帧(注释/心跳)跳过
        }
      }
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // 已 cancel 的 reader 可能处于 released 状态,忽略
    }
  }
}

/** 工具结果/长文本截断回填(8000 字符,三个 provider 一致;原逐字 ×3) */
export function truncateResult(text: string): string {
  return text.length > 8000 ? text.slice(0, 8000) + '\n…(已截断)' : text
}

/**
 * 清洗孤立代理码元(2026-08-11,修复 400 "unexpected end of hex escape"):
 * JS 字符串里不成对的 \uD800-\uDFFF(孤立代理,如流式回复被
 * max_output_tokens 截断在 emoji 中间、或上游 JSON 自带)经
 * JSON.stringify 会**原样输出为 \udXXX 转义**——DeepSeek 服务器
 * (serde_json)解析到孤立高代理后期待一个 \uDC00-\uDFFF 低代理,
 * 找不到即报 400 "input[N].output: unexpected end of hex escape at
 * line 1 column M"(实测:上下文较长时回传历史必炸)。孤立码元替换为
 * U+FFFD(与无效 UTF-8 的替换符一致),合法代理对不受影响。
 */
export function sanitizeUnpairedSurrogates(s: string): string {
  return s.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    '�',
  )
}

/** 深度清洗对象树中所有字符串的孤立代理(发送端请求体 / 接收端帧数据共用) */
export function sanitizeJsonStrings<T>(value: T): T {
  if (typeof value === 'string') return sanitizeUnpairedSurrogates(value) as unknown as T
  if (Array.isArray(value)) return value.map((v) => sanitizeJsonStrings(v)) as unknown as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>)) {
      out[key] = sanitizeJsonStrings((value as Record<string, unknown>)[key])
    }
    return out as unknown as T
  }
  return value
}
