/**
 * 技能加载器 —— 把 SKILL.md 技能目录注册为 Agent 工具
 *
 * 约定(与 Claude Code 技能一致):每个技能 = 一个目录,内含 SKILL.md,
 * 文件头为 YAML frontmatter(name / description),正文为使用文档。
 * 扫描配置的 skillsDirs(如 C:/Users/xxx/.claude/skills),每个技能注册为
 * skill_<名字> 工具:调用时把完整文档载入上下文,LLM 按文档步骤执行
 * (技能附带的脚本在技能目录下,LLM 用 exec_command 运行)。
 *
 * 注意:工具名只保留 [a-z0-9-](LLM 工具名约束,中文/符号会触发
 * 400),frontmatter 名为中文时回退目录名。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { AgentTool } from './types'

/** 注入上下文的文档最大长度(与工具结果截断一致,防超大技能撑爆上下文) */
const DOC_MAX = 8000
/** 描述注入 LLM 上下文的最大长度 */
const DESC_MAX = 300

interface ParsedSkill {
  /** frontmatter name 或目录名(原始,仅展示) */
  title: string
  /** 描述(LLM 判断何时用该技能) */
  description: string
  /** SKILL.md 绝对路径 */
  mdPath: string
  /** 技能目录绝对路径(运行附带脚本用) */
  dir: string
}

/** 解析 YAML frontmatter(极简实现:只取 name/description 键,
 * 其余键忽略;无 frontmatter 时描述取正文首行) */
function parseFrontmatter(text: string): { name?: string; description?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  if (!m) return {}
  const meta: Record<string, string> = {}
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i <= 0) continue
    const key = line.slice(0, i).trim().toLowerCase()
    if (key !== 'name' && key !== 'description') continue
    const val = line.slice(i + 1).trim().replace(/^["']|["']$/g, '').trim()
    if (val) meta[key] = val
  }
  return meta
}

/** 名字 → 工具名 slug(仅 [a-z0-9-];空/纯符号回退 fallback) */
function toSlug(raw: string, fallback: string): string {
  const s = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return s || fallback
}

/** 扫描一组目录,返回全部技能(目录不存在/无 SKILL.md 静默跳过) */
async function scanDirs(dirs: string[]): Promise<ParsedSkill[]> {
  const skills: ParsedSkill[] = []
  const seen = new Set<string>()
  for (const dir of dirs) {
    if (!dir || seen.has(dir)) continue
    seen.add(dir)
    let entries: string[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true }).then((list) => list.map((e) => e.name))
    } catch {
      continue // 目录不存在/无权限:跳过
    }
    // 按目录名字母序扫描:重名技能的工具名分配**确定性**(readdir 顺序
    // 不保证——同技能集不同运行得到不同工具名会破坏 LLM 工具记忆
    // 与 DeepSeek 缓存前缀,实测)
    entries.sort()
    // 每级只扫一层:跳过隐藏目录(以 . 或 _ 开头)
    for (const name of entries) {
      if (name.startsWith('.') || name.startsWith('_')) continue
      const skillDir = path.join(dir, name)
      const mdPath = path.join(skillDir, 'SKILL.md')
      let text: string
      try {
        text = await fs.readFile(mdPath, 'utf8')
      } catch {
        continue // 无 SKILL.md(普通目录)
      }
      const meta = parseFrontmatter(text)
      // 描述缺省取正文首行(去掉 markdown 标题符号)
      const fallbackDesc =
        text
          .replace(/^---[\s\S]*?\n---\r?\n?/, '')
          .split('\n')
          .find((l) => l.trim() && !l.trim().startsWith('#'))
          ?.trim() ?? ''
      skills.push({
        title: meta.name?.trim() || name,
        description: meta.description?.trim() || fallbackDesc,
        mdPath,
        dir: skillDir,
      })
    }
  }
  return skills
}

/** 技能工具工厂(每次 listTools 重新扫描,配置变更即时生效) */
export function createSkillLoader() {
  // 扫描缓存(审计 P2 #8):引擎每轮循环**每步**都拉工具清单(10 技能 ×
  // 10 步 ≈ 100 次文件读/轮);按 dirs 键缓存 ~1s——配置变更下一轮生效
  // 的语义不受影响(下一轮至少间隔数秒),连续轮内零重复读盘。
  // excluded 只影响过滤不影响扫描,不进缓存键
  let scanCache: { key: string; skills: ParsedSkill[]; at: number } | null = null
  const SCAN_CACHE_TTL_MS = 1000
  return {
    /**
     * 扫描并注册技能工具。excluded:已排除技能 slug 列表(设置/LLM 对话
     * 中移除的技能扫描跳过,对话中不可用)——slug = 工具名去 skill_ 前缀。
     * ownDirs:标记为"灵动岛目录"的目录(引擎传入 userData/skills)——
     * 技能来自这些目录时按目录内标记区分 sourceKind:
     * - 有 .island-imported 标记(手动导入的)→ 'imported'(手动导入区)
     * - 无标记(引擎 create / 自然语言创建)→ 'created'(灵动岛创建区)
     * - 其他目录 → 'scanned'(扫描区)
     */
    async listTools(
      skillsDirs: string[],
      excluded: string[] = [],
      ownDirs: string[] = [],
    ): Promise<AgentTool[]> {
      const key = JSON.stringify(skillsDirs ?? [])
      const now = Date.now()
      if (!scanCache || scanCache.key !== key || now - scanCache.at >= SCAN_CACHE_TTL_MS) {
        scanCache = { key, skills: await scanDirs(skillsDirs ?? []), at: now }
      }
      const skills = scanCache.skills
      const excludedSet = new Set(excluded)
      // 归一化 ownDirs(比较用:绝对路径统一小写,Windows 大小写不敏感)
      const ownSet = new Set(ownDirs.map((d) => d.toLowerCase()))
      // 手动导入标记:导入技能时在技能目录写 .island-imported(区分
      // 灵动岛创建 vs 手动导入,设置界面三区展示)
      const importedMark = (dir: string) => path.join(dir, '.island-imported')
      const tools: AgentTool[] = []
      const used = new Set<string>()
      for (const skill of skills) {
        let slug = toSlug(skill.title, 'skill')
        // 已排除的技能跳过(不注册工具;用户要求:对话/设置里移除的技能
        // 不再出现在候选与工具列表)
        if (excludedSet.has(slug)) continue
        let name = `skill_${slug}`
        let n = 2
        while (used.has(name)) name = `skill_${slug}_${n++}`
        used.add(name)
        // 来源分区:灵动岛目录内按导入标记区分;其他目录 = 扫描到
        const inOwn = ownSet.has(path.dirname(skill.dir).toLowerCase())
        const imported = inOwn && (await fs.access(importedMark(skill.dir)).then(() => true).catch(() => false))
        const sourceKind: 'created' | 'imported' | 'scanned' = inOwn
          ? imported
            ? 'imported'
            : 'created'
          : 'scanned'
        // 描述:压缩换行为单行(多行描述会打乱工具列表排版),截断防超长
        const desc = skill.description.replace(/\s+/g, ' ').trim().slice(0, DESC_MAX)
        tools.push({
          name,
          description:
            `技能:${desc || skill.title}。` +
            `调用本技能会载入它的完整使用文档(步骤/脚本目录),` +
            `之后按文档执行任务;技能附带的脚本在其目录下,用 exec_command 运行。`,
          parameters: { type: 'object', properties: {} },
          sourceKind,
          async execute() {
            let text: string
            try {
              text = await fs.readFile(skill.mdPath, 'utf8')
            } catch (err) {
              throw new Error(`技能文档读取失败:${(err as Error).message}`)
            }
            const body = text.length > DOC_MAX ? text.slice(0, DOC_MAX) + `\n…(文档过长,已截断到 ${DOC_MAX} 字符)` : text
            return `技能目录:${skill.dir}(运行附带脚本用)\n\n${body}`
          },
        })
      }
      return tools
    },
  }
}
