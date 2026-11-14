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
import { isPersonaClassified, isProtectedEntry } from './constants'
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

/**
 * 误导教训修正(2026-09-22 两轮用户实测,load 迁移):旧教训教 LLM
 * 「no permit→重新扫码/重开登录窗」和「用 check 脚本实时验证 Credential
 * 再重试」——前者导致明明指令完成却反复开扫码窗让主人重验(一轮连开 5
 * 个),后者教出"重复验证个十几次"的死循环。文件外手改会被运行中缓存
 * 覆盖,必须在 load() 里迁移(与人设补锁迁移同款)。纯函数,单测钉死。
 * 返回改写后内容;无匹配原样返回。
 */
export function migrateMemoryContent(content: string): string {
  const t = String(content ?? '')
  // ① no-permit → 重扫码/重开登录窗类:根因是 home_owner 字段解析
  //   (2026-09-22 已修复),与登录态无关——改写为正确排查路径
  if (/no permit/i.test(t) && /(重新扫码|重新发起|重开扫码|重登)/.test(t)) {
    return '米家「no permit」/权限类报错**与登录无关**(status 显示已登录时禁止 mijia_login 重开扫码窗——login 已加 force 守卫):根因是 home_owner 字段解析,2026-09-22 已修复。正确排查 = mijia_devices refresh=true 重查,或按错误文案具体提示处理(规格不可用=规格侧、设备拒绝 code=设备侧);不要重复验证、不要反复查 status。'
  }
  // ② check 脚本实时验证 Credential 类:教出"重复验证十几次"死循环
  if (/实时验证Credential有效性|实时验证 Credential/.test(t)) {
    return '接口 404/认证失败:回查本机 JS 源码确认真实路径后**验证一次**凭证即可——禁止反复验证/多次重试(2026-09-22 实测"重复验证个十几次"根源);验证失败就停下报告主人,不要凭猜测重复调用。'
  }
  return t
}

// ---------------------------------------------------------------------------
// 近重复判定(2026-09-22 用户反馈"自动记录了特别多重复的"):
// 提取 Sub Agent 每轮沉淀 + 同一事实换措辞,原 add() 只做**全等**比对
// 拦不住同义改写 → 重复堆积。三层判定(归一化等价 / 包含 / 二元组相似)
// 命中即合并进已有条目,不新增。
// ---------------------------------------------------------------------------

/**
 * 记忆文本归一化(比对用):拉丁小写 + 剥全部空白/标点/符号 + 剥虚词「的」
 * (保留文字本体)。「的」是提取端最高频的措辞漂移("岛灵的名字叫鲸鱼" vs
 * "岛灵名字叫鲸鱼"、"喜欢简洁的回答" vs "用户喜欢简洁回答")——剥掉后
 * 等价/包含/相似度三层判定都稳;语义词(猫/狗、鲸鱼/海豚)不受影响。
 */
export function normalizeMemoryText(s: string): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '')
    .replace(/的/g, '')
}

/** 字符二元组集合(相似度用;单字串返回空集) */
function bigrams(s: string): Set<string> {
  const set = new Set<string>()
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2))
  return set
}

/** 最长公共子序列长度(DP;仅短串启用,见 memorySimilarity) */
function lcsLen(a: string, b: string): number {
  const n = a.length
  const m = b.length
  const dp = new Array<number>(m + 1).fill(0)
  for (let i = 1; i <= n; i++) {
    let prev = 0
    for (let j = 1; j <= m; j++) {
      const tmp = dp[j]!
      dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(dp[j]!, dp[j - 1]!)
      prev = tmp
    }
  }
  return dp[m]!
}

/**
 * 归一化相似度(0-1,完全等价 = 1)= max(二元组 Jaccard, LCS-Dice):
 * - Jaccard 抓措辞集合重叠;LCS-Dice(2·LCS/(lenA+lenB))抓**一字级插删**
 *   ("岛灵名字叫鲸鱼" vs "岛灵的名字叫鲸鱼" = 0.93,单靠 Jaccard 仅 0.63
 *   会漏——用户实测"自动记录特别多重复"的一类);
 * - 语义翻转("…叫海豚" vs "…叫鲸鱼" = 0.75、"喜欢猫" vs "喜欢狗" =
 *   0.80)低于 0.85 阈值,不误合并;
 * - LCS 仅在两串归一化后各 ≤200 字且长度比 ≥0.5 时计算(防 O(n·m)
 *   在长条目上发热;200 条 × 500 字的最坏集由提取上限与进化清理兜底)。
 */
export function memorySimilarity(a: string, b: string): number {
  const na = normalizeMemoryText(a)
  const nb = normalizeMemoryText(b)
  if (!na || !nb) return 0
  if (na === nb) return 1
  let jac = 0
  const A = bigrams(na)
  const B = bigrams(nb)
  if (A.size > 0 && B.size > 0) {
    let inter = 0
    for (const g of A) if (B.has(g)) inter++
    jac = inter / (A.size + B.size - inter)
  }
  let dice = 0
  const [short, long] = na.length <= nb.length ? [na, nb] : [nb, na]
  if (long.length <= 200 && short.length / long.length >= 0.5) {
    dice = (2 * lcsLen(na, nb)) / (na.length + nb.length)
  }
  return Math.max(jac, dice)
}

/** 归一化文本中的数字串(QQ/编号/数量是身份的一部分,不同即不同条目) */
function digitSeq(s: string): string {
  return s.replace(/\D+/g, '')
}

/**
 * 在已有条目里找近重复(纯函数,测试用导出):
 * ⓪ 数字串硬门——QQ/编号/数量不同的绝不算重复("条目 1" ≠ "条目 10");
 * ① 归一化等价(标点/空白/大小写差异);② 一方完整包含另一方(短串 ≥4
 * 字符防误伤);③ 相似度 ≥0.85(二元组 Jaccard / LCS-Dice,抓一字级改写)。
 */
export function findNearDuplicate(entries: MemoryEntry[], content: string): MemoryEntry | null {
  const n = normalizeMemoryText(content)
  if (!n) return null
  const nDigits = digitSeq(n)
  for (const e of entries) {
    const m = normalizeMemoryText(e.content)
    if (!m) continue
    if (digitSeq(m) !== nDigits) continue
    if (m === n) return e
    const short = m.length <= n.length ? m : n
    const long = m.length <= n.length ? n : m
    if (short.length >= 4 && long.includes(short)) return e
    if (memorySimilarity(e.content, content) >= 0.85) return e
  }
  return null
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
            // 误导教训修正迁移(2026-09-22):no-permit→重扫码 / 反复验证
            // Credential 类旧教训教出"重复开扫码窗、重复验证十几次"循环,
            // 加载即改写为正确结论(纯函数 migrateMemoryContent,单测钉死)
            const fixed = migrateMemoryContent(e.content)
            if (fixed !== e.content) {
              e.content = fixed
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
      // 近重复合并(2026-09-22):归一化等价/包含/高相似都算重复——
      // 提取的同义改写不再堆积;新内容是旧内容的**信息超集**(归一化后
      // 包含且明显更长)才升级现有条目措辞,否则原样返回(防措辞来回翻烙)
      const near = findNearDuplicate(entries, content)
      if (near) {
        const locked =
          typeof input.protected === 'boolean' ? input.protected : isProtectedEntry({ content, tags: input.tags })
        const nNew = normalizeMemoryText(content)
        const nOld = normalizeMemoryText(near.content)
        const superset = nNew.length >= nOld.length + 4 && nNew.includes(nOld)
        if (superset && !near.protected && !locked) {
          near.content = content
          if (input.type) near.type = input.type
          near.updatedAt = Date.now()
          scheduleWrite()
          return { entry: { ...near }, created: false }
        }
        // 主人重申人设且命中旧条目:把锁定补上(人设自动锁定语义,别因
        // 近重复合并漏锁);内容不动(protected 条目永不改写)
        if (!near.protected && locked) {
          near.protected = true
          near.updatedAt = Date.now()
          scheduleWrite()
        }
        return { entry: near, created: false }
      }
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
    /** 导入合并(设置界面"导入"按钮):按 id 与内容去重(已存在跳过,
     * 2026-09-22 起内容去重用近重复判定——同义改写也算重复);
     * 导入的条目 updatedAt 置为当前(列表按更新时间倒序 → 置顶可见);
     * 总量超 MAX_ENTRIES 时淘汰最旧(与 add 一致,新导入总是保留)。
     * 返回导入/跳过计数 */
    async importEntries(next: MemoryEntry[]): Promise<{ imported: number; skipped: number }> {
      await ensureLoaded()
      const seenIds = new Set(entries.map((e) => e.id))
      const pool: MemoryEntry[] = [...entries]
      const fresh: MemoryEntry[] = []
      let skipped = 0
      for (const e of next) {
        const content = String(e.content ?? '').trim().slice(0, MAX_CONTENT_CHARS)
        if (!content || seenIds.has(e.id) || findNearDuplicate(pool, content)) {
          skipped += 1
          continue
        }
        seenIds.add(e.id)
        const item = { ...e, content, updatedAt: Date.now() }
        pool.push(item)
        fresh.push(item)
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
  return `【长期记忆(对话中遵守,别自相矛盾;与你对话的是同一用户;标注「锁定」的条目是主人指定的设定,不得擅自修改或删除;人设/人格类内容归人格卡,不要写进这里;**记忆条目对所有会话全局生效**——某会话独有的行为要求如"在某个群闭嘴"不是全局知识,不得据此影响其它会话,也不得新增此类条目)】\n${body}`
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
        '学到的教训。注意:可复用的规律才记,一次性信息不要记;**内容相同或高度相似会自动合并进已有记忆,不会重复堆积**——记之前先看现有记忆里是否已有同一主题。' +
        '**会话级行为要求禁止写入**:某个会话里提出的说话量/风格/是否回复要求' +
        '("在这个群闭嘴""这边活跃一点")只对该会话有效——长期记忆会注入所有会话,' +
        '写入即跨会话污染(A 群闭嘴导致 B 群也不说话);此类要求用 set_session_note ' +
        '记到该会话的情况记录。**人设/人格/角色/岛灵类设定不要写入长期记忆**——' +
        '人格内容统一归人格卡,请用 persona 工具创建或编辑人格卡。',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: '记忆内容,一句话为宜' },
          type: {
            type: 'string',
            enum: ['preference', 'fact', 'workflow', 'lesson'],
            description: '类型:preference 偏好 / fact 事实 / workflow 工作流 / lesson 教训,缺省 fact',
          },
          tags: { type: 'array', items: { type: 'string' }, description: '可选:标签(人格类内容不要写这里,走 persona 工具)' },
          protected: {
            type: 'boolean',
            description: '可选:锁定该记忆(受保护,自我进化不可修改/删除)',
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
        // 人格分类不再进长期记忆(2026-10-26 用户定案):人设/人格/角色/岛灵
        // 标签或人设内容 → 拒绝并引导 persona 工具(人格卡才是唯一归属)
        if (isPersonaClassified({ content, tags })) {
          throw new Error(
            '人设/人格/角色/岛灵类设定不写入长期记忆,请用 persona 工具创建或编辑人格卡(action="create"/"edit"/"set_notes")',
          )
        }
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
        '受保护(锁定)条目不能直接删除——如确需删除,先用 update_memory 设 protected:false 解锁。',
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
            '该记忆是受保护(锁定)条目,不能删除;' +
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
        '主人明确要求改动锁定条目时直接改写内容(锁定保持),确需删除锁定条目先 protected:false 解锁。',
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
