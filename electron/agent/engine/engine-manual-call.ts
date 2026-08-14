/**
 * 手动调用(/工具名 或 @工具名)解析与匹配
 *
 * 2026-08-14 插件化三期从 engine-loop.ts 拆出:用户在输入框以
 * `/技能名` 或 `@MCP工具名` 直接触发工具执行的语法解析与工具匹配。
 */

import type { AgentTool } from '../types'

/**
 * 手动调用解析:识别 `/name rest` / `@name rest` 语法,非手动调用返回 null
 */
export function parseManualCall(text: string): { name: string; rest: string } | null {
  if (!text.startsWith('/') && !text.startsWith('@')) return null
  const m = /^[/@]\s*(\S+)\s*([\s\S]*)$/.exec(text.trim())
  if (!m || !m[1]) return null
  return { name: m[1], rest: m[2] ?? '' }
}

/**
 * 手动调用匹配:精确名 → 唯一子串 → 多匹配/未找到给出引导提示
 */
export function findManualTool(
  tools: AgentTool[],
  name: string,
): { tool: AgentTool | null; hint: string } {
  const exact = tools.find((t) => t.name === name)
  if (exact) return { tool: exact, hint: '' }
  const lower = name.toLowerCase()
  const matches = tools.filter((t) => t.name.includes(lower))
  if (matches.length === 1) return { tool: matches[0], hint: '' }
  if (matches.length > 1) {
    return {
      tool: null,
      hint: `「${name}」匹配到 ${matches.length} 个工具(${matches.map((t) => t.name).join('、')}),请指定完整工具名`,
    }
  }
  return {
    tool: null,
    hint: `未找到「${name}」。技能用 /技能名,如 /trump-perspective;MCP 工具用 @完整工具名,如 @mcp_filesystem_read_file(可用工具列表查看现有工具)`,
  }
}

/**
 * 手动调用前缀分离:`/技能名附加参数串` 无空格时的最长前缀匹配
 */
export function matchManualToolPrefix(
  tools: AgentTool[],
  name: string,
): { tool: AgentTool; rest: string } | null {
  let best: AgentTool | null = null
  let bestLen = 0
  for (const t of tools) {
    if (name.startsWith(t.name) && t.name.length > bestLen) {
      best = t
      bestLen = t.name.length
    }
  }
  if (!best) return null
  return { tool: best, rest: name.slice(bestLen).trim() }
}
