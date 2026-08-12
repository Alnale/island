/**
 * 记忆系统 —— 结构化长期记忆
 *
 * 借鉴 penguin-harness 的"可编辑资产"语义:记忆是 LLM 可读写的资产,
 * 对话中经 remember/forget/list_memory/update_memory 工具沉淀与修正,
 * 系统提示词自动附加记忆块(与用户自定义提示词并列)。
 *
 * 存储:userData/memory.json(main.cjs 注入路径,与 settings.json 分离:
 * 记忆高频变更,独立文件不污染配置,损坏不影响配置)。
 * 写入串行化(工具并行执行时防竞态):写队列。
 *
 * 记忆上限 200 条、单条 500 字;拼装截断 6000 字符(防上下文膨胀,
 * 记忆块是系统提示的静态段,变更才断 DeepSeek 前缀缓存)。
 */

import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { isProtectedEntry } from './constants'
import type { AgentTool, MemoryEntry, ToolParams } from './types'

const MAX_ENTRIES = 200
const MAX_CONTENT_CHARS = 500
/** 拼装进系统提示词的记忆块最大长度(截断防膨胀) */
const BLOCK_MAX = 6000

const TYPE_LABEL: Record<MemoryEntry['type'], string> = {
  preference: '偏好',
  fact: '事实',
  workflow: '工作流',
  lesson: '教训',
}

/** 记忆存储:内存态 + 串行写盘 */
export function createMemoryStore(getPath: () => string) {
  let entries: MemoryEntry[] = []
  /** 写盘串行队列(并行工具调用时防竞态覆盖) */
  let writeChain: Promise<void> = Promise.resolve()
  let loaded = false
  /** 加载互斥:并发 add 会同时触发 load,后完成的 catch 会把刚 push 的
   * 条目清空(实测:10 并发 add 只剩 1 条)——所有调用共享同一加载 */
  let loadPromise: Promise<void> | null = null

  function load() {
    if (loadPromise) return loadPromise
    loadPromise = (async () => {
      try {
        const raw = await fs.readFile(getPath(), 'utf8')
        const data = JSON.parse(raw) as { entries?: unknown }
        if (Array.isArray(data.entries)) {
          entries = data.entries
            .filter(
              (e): e is MemoryEntry =>
                !!e && typeof e === 'object' && typeof (e as MemoryEntry).content === 'string',
            )
            .slice(0, MAX_ENTRIES)
          // **人设条目加载迁移(2026-08-13,用户实测"进化总是丢失岛灵
          // 设定")**:旧数据的人设条目无 protected 标记(只带人设标签/
          // 人设关键词内容)——加载时自动补锁并落盘,此后 protected
          // 是唯一权威来源(自我进化/forget 都按它拦截)
          let migrated = false
          for (const e of entries) {
            if (!e.protected && isProtectedEntry(e)) {
              e.protected = true
              migrated = true
            }
          }
          if (migrated) scheduleWrite()
        }
      } catch {
        entries = []
      }
      loaded = true
    })().finally(() => {
      loadPromise = null
    })
    return loadPromise
  }

  /** 排队写盘(串行,后写覆盖前写) */
  function scheduleWrite() {
    const payload = JSON.stringify({ entries }, null, 2)
    writeChain = writeChain.then(() => fs.writeFile(getPath(), payload, 'utf8')).catch(() => {})
    return writeChain
  }

  async function ensureLoaded() {
    if (loaded) return
    await load()
  }

  return {
    /** 全部条目(按更新时间倒序) */
    async list(): Promise<MemoryEntry[]> {
      await ensureLoaded()
      return [...entries].sort((a, b) => b.updatedAt - a.updatedAt)
    },
    async add(input: {
      content: string
      type: MemoryEntry['type']
      source?: MemoryEntry['source']
      tags?: string[]
      protected?: boolean
    }): Promise<{ entry: MemoryEntry; created: boolean }> {
      await ensureLoaded()
      const content = input.content.trim().slice(0, MAX_CONTENT_CHARS)
      if (!content) throw new Error('记忆内容不能为空')
      // 去重:完全相同的已有条目不重复添加
      const dup = entries.find((e) => e.content === content)
      if (dup) return { entry: dup, created: false }
      if (entries.length >= MAX_ENTRIES) {
        // 超限:删最旧(按 createdAt),保持总量上限
        const oldest = entries.find((e) => e.createdAt === Math.min(...entries.map((e) => e.createdAt)))
        if (oldest) entries = entries.filter((e) => e.id !== oldest.id)
      }
      const now = Date.now()
      // **人设条目自动锁定(2026-08-13,集中在此,所有写入路径统一)**:
      // 未显式传 protected 时,人设类标签/内容(主人指定的岛灵设定)
      // 自动 protected:true——remember 工具/静默记忆提取/手动添加
      // 都受益;显式 protected:false 可豁免
      const locked =
        typeof input.protected === 'boolean'
          ? input.protected
          : isProtectedEntry({ content, tags: input.tags })
      const entry: MemoryEntry = {
        id: randomUUID(),
        type: input.type || 'fact',
        content,
        tags: input.tags?.slice(0, 8),
        source: input.source ?? 'agent',
        protected: locked,
        createdAt: now,
        updatedAt: now,
      }
      entries.push(entry)
      scheduleWrite()
      return { entry, created: true }
    },
    /** 按 id 或内容片段删除;返回删除条数 */
    async remove(key: string): Promise<number> {
      await ensureLoaded()
      const before = entries.length
      entries = entries.filter((e) => e.id !== key && !e.content.includes(key))
      const removed = before - entries.length
      if (removed > 0) scheduleWrite()
      return removed
    },
    async update(
      id: string,
      patch: { content?: string; type?: MemoryEntry['type']; tags?: string[]; protected?: boolean },
    ): Promise<MemoryEntry | null> {
      await ensureLoaded()
      const target = entries.find((e) => e.id === id)
      if (!target) return null
      if (typeof patch.content === 'string') {
        const c = patch.content.trim().slice(0, MAX_CONTENT_CHARS)
        if (!c) throw new Error('记忆内容不能为空')
        target.content = c
      }
      if (patch.type) target.type = patch.type
      if (patch.tags) target.tags = patch.tags.slice(0, 8)
      if (typeof patch.protected === 'boolean') target.protected = patch.protected
      target.updatedAt = Date.now()
      scheduleWrite()
      return { ...target }
    },
    /** 整组替换(自我进化提交时用);返回新列表 */
    async replaceAll(next: MemoryEntry[]): Promise<MemoryEntry[]> {
      await ensureLoaded()
      entries = next.slice(0, MAX_ENTRIES)
      scheduleWrite()
      return [...entries]
    },
    /** 导入合并(设置界面"导入"按钮):按 id 与内容去重(已存在跳过);
     * 导入的条目 updatedAt 置为当前(列表按更新时间倒序 → 置顶可见);
     * 总量超 MAX_ENTRIES 时淘汰最旧(与 add 一致,新导入总是保留)。
     * 返回导入/跳过计数 */
    async importEntries(next: MemoryEntry[]): Promise<{ imported: number; skipped: number }> {
      await ensureLoaded()
      const seenIds = new Set(entries.map((e) => e.id))
      const seenContents = new Set(entries.map((e) => e.content))
      const fresh: MemoryEntry[] = []
      let skipped = 0
      for (const e of next) {
        if (seenIds.has(e.id) || seenContents.has(e.content)) {
          skipped += 1
          continue
        }
        seenIds.add(e.id)
        seenContents.add(e.content)
        fresh.push({ ...e, updatedAt: Date.now() })
      }
      const existingSorted = [...entries].sort((a, b) => b.updatedAt - a.updatedAt)
      entries = [...fresh, ...existingSorted].slice(0, MAX_ENTRIES)
      scheduleWrite()
      return { imported: fresh.length, skipped }
    },
    /** 快照备份(进化提交前写 .bak;回滚用) */
    async snapshot(backupPath: string) {
      await ensureLoaded()
      await fs.writeFile(backupPath, JSON.stringify({ entries }, null, 2), 'utf8')
    },
  }
}

export type MemoryStore = ReturnType<typeof createMemoryStore>

/** 记忆 → 系统提示词块(按类型分组;截断防膨胀) */
export function formatMemoryBlock(entries: MemoryEntry[]): string {
  if (entries.length === 0) return ''
  const lines: string[] = []
  for (const type of ['preference', 'fact', 'workflow', 'lesson'] as const) {
    for (const e of entries.filter((x) => x.type === type)) {
      // 锁定标记(2026-08-13):主人指定的人设/岛灵设定,对话中也不得擅自
      // 修改——LLM 从记忆块就能看到哪些是受保护的
      const lock = isProtectedEntry(e) ? '·锁定' : ''
      lines.push(`- [${TYPE_LABEL[type]}${lock}] ${e.content}`)
    }
  }
  let body = lines.join('\n')
  if (body.length > BLOCK_MAX) {
    body = body.slice(0, BLOCK_MAX) + `\n…(记忆过长,已截断)`
  }
  return `【长期记忆(对话中遵守,别自相矛盾;与你对话的是同一用户;标注「锁定」的条目是主人指定的人设/岛灵设定,不得擅自修改或删除)】\n${body}`
}

/** 记忆工具(LLM 对话中读写记忆,自然语言沉淀)
 * getStore **惰性实时获取**(2026-08-10 修复"LLM 列出记忆 id 但设置视图
 * 长期记忆为空"):引擎 tools 在创建时组装一次,若传入固定 store 实例,
 * 清除数据(main.cjs 置 memoryStore=null 重建)后 LLM 工具仍操作旧实例
 * (清除前的记忆),渲染端 agent:memory-get 读新实例 → 两处永久不一致;
 * execute 时实时取,永远拿主进程最新实例 */
export function createMemoryTools(getStore: () => MemoryStore | null): AgentTool[] {
  return [
    {
      name: 'remember',
      description:
        '把用户偏好/事实/工作流/教训写入长期记忆(永久生效,后续所有对话都遵守)。' +
        '适合:用户表达的偏好("我喜欢简洁回答")、重要事实("我的项目在 D:/xxx")、' +
        '学到的教训。注意:可复用的规律才记,一次性信息不要记;已有相同内容不会重复添加。' +
        '用户指定的人设/岛灵设定(角色形象、说话风格、人格)应带「人设」标签写入——' +
        '这类条目会自动锁定(受保护),自我进化不会修改或删除它。',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: '记忆内容,一句话为宜' },
          type: {
            type: 'string',
            enum: ['preference', 'fact', 'workflow', 'lesson'],
            description: '类型:preference 偏好 / fact 事实 / workflow 工作流 / lesson 教训,缺省 fact',
          },
          tags: { type: 'array', items: { type: 'string' }, description: '可选:标签;人设类条目用「人设」标签' },
          protected: {
            type: 'boolean',
            description: '可选:锁定该记忆(受保护,自我进化不可修改/删除);人设/岛灵设定应锁定,缺省时带人设标签自动锁定',
          },
        },
        required: ['content'],
      },
      async execute(params: ToolParams) {
        const store = getStore()
        if (!store) throw new Error('记忆功能不可用(未注入记忆存储)')
        const type = String(params.type ?? 'fact') as MemoryEntry['type']
        if (!['preference', 'fact', 'workflow', 'lesson'].includes(type)) {
          throw new Error('type 仅支持 preference/fact/workflow/lesson')
        }
        const content = String(params.content ?? '')
        const tags = Array.isArray(params.tags) ? params.tags.map(String) : undefined
        // 人设条目自动锁定(2026-08-13,store.add 内集中判定):带人设标签/
        // 人设关键词内容 = 主人指定的岛灵设定——除非 LLM 显式传
        // protected:false
        const r = await store.add({
          content,
          type,
          source: 'agent',
          tags,
          protected: typeof params.protected === 'boolean' ? params.protected : undefined,
        })
        return r.created
          ? `已写入长期记忆([${TYPE_LABEL[type]}] ${r.entry.content}${r.entry.protected ? ',已锁定(受保护,自我进化不会改动)' : ''})`
          : '(记忆已存在相同内容,未重复添加)'
      },
    },
    {
      name: 'forget',
      description:
        '删除长期记忆(按内容片段或条目 id;记错/过时的记忆用它修正)。' +
        '受保护(锁定)的人设/岛灵设定条目不能直接删除——如确需删除,先用 update_memory 设 protected:false 解锁。',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: '记忆内容片段或条目 id' },
        },
        required: ['key'],
      },
      async execute(params: ToolParams) {
        const store = getStore()
        if (!store) throw new Error('记忆功能不可用(未注入记忆存储)')
        const key = String(params.key ?? '').trim()
        // 锁定拦截(2026-08-13):匹配到受保护条目即整体拒绝——人设/岛灵
        // 设定不能经 LLM 工具误删(自我进化同样拦截,见 evolution.ts)
        const matches = (await store.list()).filter((e) => e.id === key || e.content.includes(key))
        if (matches.some(isProtectedEntry)) {
          throw new Error(
            '该记忆是受保护(锁定)的主人指定人设/岛灵设定,不能删除;' +
              '如主人确要删除,请先用 update_memory 设 protected:false 解锁',
          )
        }
        const n = await store.remove(key)
        if (n === 0) throw new Error('未找到匹配的记忆')
        return `已删除 ${n} 条记忆`
      },
    },
    {
      name: 'list_memory',
      description: '查看长期记忆(按类型过滤或关键词搜索;回答涉及用户偏好/历史约定时先查记忆)。',
      parameters: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['preference', 'fact', 'workflow', 'lesson'],
            description: '只列该类型,缺省全部',
          },
          keyword: { type: 'string', description: '只列含该关键词的记忆' },
        },
      },
      async execute(params: ToolParams) {
        const store = getStore()
        if (!store) throw new Error('记忆功能不可用(未注入记忆存储)')
        const entries = await store.list()
        const type = params.type ? String(params.type) : ''
        const keyword = params.keyword ? String(params.keyword) : ''
        const filtered = entries.filter(
          (e) => (!type || e.type === type) && (!keyword || e.content.includes(keyword)),
        )
        if (filtered.length === 0) return '(无匹配的记忆)'
        return filtered
          .map((e) => `- [${TYPE_LABEL[e.type]}] ${e.content}(id:${e.id.slice(0, 8)}${e.source === 'manual' ? ',手动' : ''})`)
          .join('\n')
      },
    },
    {
      name: 'update_memory',
      description:
        '修改已有记忆(按 id;纠正措辞、合并重复、换类型)。protected 参数可切换锁定状态:' +
        '主人明确要求改动人设时直接改写内容(锁定保持),确需删除锁定条目先 protected:false 解锁。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '条目 id(list_memory 可查到)' },
          content: { type: 'string', description: '新内容' },
          type: {
            type: 'string',
            enum: ['preference', 'fact', 'workflow', 'lesson'],
            description: '新类型',
          },
          protected: { type: 'boolean', description: '可选:锁定(true)/解锁(false)' },
        },
        required: ['id'],
      },
      async execute(params: ToolParams) {
        const store = getStore()
        if (!store) throw new Error('记忆功能不可用(未注入记忆存储)')
        const updated = await store.update(String(params.id ?? ''), {
          content: params.content ? String(params.content) : undefined,
          type: params.type as MemoryEntry['type'] | undefined,
          protected: typeof params.protected === 'boolean' ? params.protected : undefined,
        })
        if (!updated) throw new Error(`未找到条目 ${String(params.id ?? '')}`)
        return `已更新:${updated.content}${updated.protected ? '(锁定,受保护)' : ''}`
      },
    },
  ]
}
