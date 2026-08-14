/**
 * 工具参数解析(中性模块)
 * 与具体 LLM 供应商/协议无关——Responses 与 Chat Completions 的工具调用
 * args 都是 JSON 字符串,容错逻辑单份维护在这里。
 * 历史:原在 deepseek.ts,2026-08-14 插件化二期迁出,消除 loop/delegate
 * 对供应商实现的直连(deepseek.ts 保留兼容 re-export)。
 */

/** 解析工具参数 JSON(容错:非对象/空串 → {};解析失败 → { _raw: 原文 }) */
export function parseToolArgs(raw: string): Record<string, unknown> {
  const text = raw.trim()
  if (!text) return {}
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return { _raw: text }
  }
}
