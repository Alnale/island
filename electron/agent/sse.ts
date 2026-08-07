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
 * 解析 SSE 字节流:按空行分帧,取 data: 行的 JSON(OpenAI 兼容格式)。
 * 非 JSON 帧 / 无 type 字段 / 注释心跳跳过;中止抛 AbortError。
 * 三个 provider(deepseek / chat / anthropic)共用
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
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
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
            yield { type: parsed.type, data: parsed }
          }
        } catch {
          // 非 JSON 帧(注释/心跳)跳过
        }
      }
      if (signal.aborted) throw new DOMException('aborted', 'AbortError')
    }
  } finally {
    reader.releaseLock()
  }
}

/** 工具结果/长文本截断回填(8000 字符,三个 provider 一致;原逐字 ×3) */
export function truncateResult(text: string): string {
  return text.length > 8000 ? text.slice(0, 8000) + '\n…(已截断)' : text
}
