/**
 * 心理刻画的纯文本判断与剥离。零依赖,渲染端可以直接用,
 * 不把子代理/NapCat 模块拖进挂件的类型检查。
 *
 * 2026-10-26 二轮:等回复落定再判断——心理从回复落定那一刻起才判定,
 * 不从流式中途、不从工具中间步抢先采信。原「心理揣测」Sub Agent 已
 * 彻底取消;这里只做确定性判断:她写下的心理行,或她落定思考里
 * 没说出口的那句。
 */

const OPERATIONAL_LINE =
  /工具|艾特|@|规则|persona|QQ|截图|私聊|群聊|点名|触发|整合区|备注|好友|发不出去|set_|edit|写入|人格卡|不艾特/

/** 她在思考里商量格式时写下的说明,不是要印出来的那句。 */
const META_LINE = /底字|岛上|心迹|心行|不复述|不要引号|4\s*[-~到至]\s*16|8\s*[-~到至]\s*36|大概\d|字数|格式|选[说望纯]|种类/

/**
 * 真心话标记(2026-10-28):黑名单词是子串匹配,「想给好友发个消息」
 * 这类心事会沾上 好友/@ 字样——命中真心话标记就不按操作/格式说明判废,
 * 只杀纯机制句(「按规则不艾特」没有任何感受词)。
 */
const PERSONAL_LINE =
  /心里|内心|心口|胸口|想|念|盼|慌|紧张|开心|高兴|难过|失落|委屈|别扭|窃喜|偷乐|咯噔|脸红|心跳|安心|踏实|空落落|不是滋味|在意|惦记|期待|心动|吃醋|嘴硬|服软|叹气|咬唇|甜|酸|疼|痛|暖|怕|馋|烦|闷|爽|乐|笑|哭/

/** 「加心一行」类格式自述:模型把"要写心理行"的动作旁白当内容写出来。 */
const MIND_META_CORE =
  '(?:只|再|另)?\\s*(?:加|补|写|附)?\\s*(?:上|个|这)?\\s*一?\\s*(?:心(?:一)?行|心迹|心行|心理行|心理刻画|心)\\s*一?\\s*(?:行|句)?\\s*字?'
/** 整行就是一句格式旁白:「加心一行」「再加心一行」「补上心迹一行」 */
export const MIND_META_LINE = new RegExp(`^\\s*[（(【\\[]?\\s*${MIND_META_CORE}\\s*[:：]?\\s*[）)】\\]]?\\s*$`)
/** 「加心一行:」类前缀旁白,后面跟的内容也整行算旁白 */
const MIND_META_PREFIX_LINE = new RegExp(`^\\s*[（(【\\[]?\\s*${MIND_META_CORE}\\s*[:：]`)
/** 括在括号里的行内旁白:「好想咬你(加心一行)」 */
const MIND_META_BRACKETED = new RegExp(`[（(【\\[]\\s*${MIND_META_CORE}\\s*[:：]?\\s*[）)】\\]]`, 'g')

/** 这句是「加心一行」类格式旁白,不是要说出口的话 */
export function isMindMeta(text: string): boolean {
  return MIND_META_LINE.test(String(text ?? '').trim())
}

/**
 * 裸协议行:她没写 ‹心|…› 包装,字段直接以「标签:值」整行落下。
 * 种类 行只有值是 说/望/纯 才算协议行(「种类:火锅」是正文,不能动)。
 */
export const MIND_BARE_FIELD_RE =
  /^\s*(岛上一句|岛上|底字|心迹行|心迹|心行|种类|心理刻画|心理揣测)\s*[:：]\s*(.*?)\s*$/

/** 整行是裸协议行 → 从正文剥掉(值仍可作心理字段回收) */
export function isMindBareLine(line: string): boolean {
  const m = MIND_BARE_FIELD_RE.exec(String(line ?? ''))
  if (!m) return false
  if (m[1] === '种类') return /^(?:说|望|纯|说或望或纯)$/.test(m[2].trim())
  return true
}

/** 整行是协议残渣(裸协议行 / 格式旁白行)→ 不该出现在正文里 */
export function isMindDebrisLine(line: string): boolean {
  return isMindBareLine(line) || MIND_META_LINE.test(String(line ?? '')) || MIND_META_PREFIX_LINE.test(String(line ?? ''))
}

/** 元话语生长形态:一切都还可能长成「加心一行」类旁白(流式扣留判定) */
const MIND_META_GROW = new RegExp(
  `^\\s*[（(【\\[]?\\s*(?:只|再|另)?\\s*(?:加|补|写|附)?\\s*(?:上|个|这)?\\s*一?\\s*(?:心(?:一)?行|心迹|心行|心理行|心理刻画|心)?\\s*一?\\s*(?:行|句)?\\s*字?\\s*[:：]?\\s*[）)】\\]]?\\s*$`,
)
/** 裸协议行标签词的生长判定:标签还在长 / 标签后等着冒号 */
const MIND_BARE_LABELS = ['岛上一句', '岛上', '底字', '心迹行', '心迹', '心行', '种类', '心理刻画', '心理揣测']
const MIND_BARE_GROW = /^(?:岛上一句|岛上|底字|心迹行|心迹|心行|种类|心理刻画|心理揣测)\s*[:：]/
const MIND_BARE_LABEL_ONLY = /^(?:岛上一句|岛上|底字|心迹行|心迹|心行|种类|心理刻画|心理揣测)\s*$/

/**
 * 这行还可能长成协议残渣(流式扣留用):标签词还在生长、标签后等着冒号、
 * 或旁白还没写完——都不是定论,扣住等下一个码元;一旦定论为普通行就直通。
 */
export function couldBeMindDebrisLine(line: string): boolean {
  const t = String(line ?? '').replace(/^\s+/, '')
  if (!t) return true
  if (MIND_BARE_LABELS.some((l) => l.startsWith(t))) return true
  if (MIND_BARE_LABEL_ONLY.test(t) || MIND_BARE_GROW.test(t)) return true
  return MIND_META_GROW.test(t) || MIND_META_PREFIX_LINE.test(t)
}

/** 旁白写完后紧跟标记开口(「加心一行‹心|…」):整行都是残渣 */
const MIND_META_THEN_OPEN_RE = new RegExp(
  `^\\s*[（(【\\[]?\\s*${MIND_META_CORE}\\s*[:：]?\\s*[）)】\\]]?\\s*[‹<〈]`,
)
export function isMindMetaBeforeMark(line: string): boolean {
  return MIND_META_THEN_OPEN_RE.test(String(line ?? ''))
}

export interface TurnDepiction {
  island: string
  kind: 'say' | 'hope' | 'pure'
  whisper: string
}

/** 协议标签,不是她的话。模型常把「种类：纯」原样漏进思考或正文。 */
export function isMindLabel(text: string): boolean {
  const t = String(text ?? '').replace(/\s/g, '')
  return /^(种类[:：]?)?(说|望|纯)$/.test(t) || t === '说或望或纯' || t === '一句心里话' || t === '一句没说出口的话' || t === '岛上一句'
}

/** 心理行码元上限(岛面一句;紧凑态文字区随字数扩展岛宽,超出截断) */
export const MIND_MAX_LEN = 16

/** 模型可能照抄的示例词(照抄 = 无效,重试/判废) */
export const MIND_LITERAL_EXAMPLES = new Set(['表面淡定,内心在慌', '表面淡定内心在慌'])

function cleanLine(raw: string): string {
  return raw
    .trim()
    .replace(/^[\s\d.、）)]+/, '')
    .replace(/^[「『"'“]+|[」』"”]+$/g, '')
    .replace(/[。！？!?…]+$/g, '')
    .trim()
}

function clipChars(text: string, max: number): string {
  return Array.from(text).slice(0, max).join('')
}

function fitIsland(text: string): string | null {
  const chars = Array.from(cleanLine(text))
  if (chars.length < 4) return null
  const island = chars.length <= 16 ? chars.join('') : chars.slice(0, 16).join('')
  if (/[,，、;；:：]$/.test(island) || isMindLabel(island) || isMindMeta(island)) return null
  if (!PERSONAL_LINE.test(island) && META_LINE.test(island)) return null
  return island
}

function quotesAfter(source: string, label: RegExp): string | null {
  let found: string | null = null
  for (const hit of source.matchAll(new RegExp(label.source, 'g'))) {
    const window = source.slice(hit.index ?? 0, (hit.index ?? 0) + hit[0].length + 80)
    const quoted = /[「『"“]([^」』"”\n]{4,40})[」』"”]/.exec(window)
    if (!quoted) continue
    const text = cleanLine(quoted[1])
    if (Array.from(text).length < 4 || isMindLabel(text) || META_LINE.test(text)) continue
    found = text
  }
  return found
}

function plainAfter(source: string, label: RegExp): string | null {
  let found: string | null = null
  for (const hit of source.matchAll(new RegExp(label.source, 'g'))) {
    const rest = source.slice((hit.index ?? 0) + hit[0].length, (hit.index ?? 0) + hit[0].length + 48)
    const text = cleanLine(rest.split(/[。\n]/)[0] ?? '')
    const len = Array.from(text).length
    if (len < 4 || len > 40 || isMindLabel(text) || META_LINE.test(text)) continue
    found = text
  }
  return found
}

function fold(text: string): string {
  return text.replace(/[\s，。！？、,.!?:：;；"'“”「」『』…—\-《》]/g, '')
}

/**
 * 这句话已经在回复里出现过,再印进输入框就只是截了一句。
 * 心事比短回复长、只是顺带引了回复时不判废——只有回复占了心事大半
 * (近似复述)才丢,防「删过头」把真话删掉。
 */
function echoesReply(text: string, reply: string): boolean {
  const candidate = fold(text)
  const spoken = fold(reply)
  if (candidate.length < 4 || spoken.length < 4) return false
  const shorter = Math.min(candidate.length, spoken.length)
  if (shorter < 6) return false
  if (spoken.includes(candidate)) return true
  return candidate.includes(spoken) && spoken.length >= Math.ceil(candidate.length * 0.6)
}

function usable(text: string, reply: string): boolean {
  const len = Array.from(text).length
  if (len < 4 || len > 40) return false
  if (isMindLabel(text) || isMindMeta(text)) return false
  // 黑名单是机制词子串匹配;带真心话标记的句子不按机制判废(见 PERSONAL_LINE)
  if (!PERSONAL_LINE.test(text) && (META_LINE.test(text) || OPERATIONAL_LINE.test(text))) return false
  if (echoesReply(text, reply)) return false
  return true
}

function kindChoice(source: string): TurnDepiction['kind'] | null {
  const hits = [...source.matchAll(/(?:选|偏|种类\s*[:：]?)\s*[「『"“']?(说|望|纯)/g)]
  for (let i = hits.length - 1; i >= 0; i--) {
    const hit = hits[i]
    if (hit.index == null) continue
    const around = source.slice(Math.max(0, hit.index - 4), hit.index + 16)
    if (/或/.test(around)) continue
    if (hit[1] === '说') return 'say'
    if (hit[1] === '望') return 'hope'
    return 'pure'
  }
  return null
}

/**
 * 超长 raw 的语义截取:模型超长输出通常是「完整小句 + 续写」——取第一个
 * 句子终止标点(。！？；…～)前的完整小句。结果 4-16 码元且非残句结尾
 * 才采用;否则返回 null。
 */
export function cutMindSentence(raw: string): string | null {
  // 终止标点:全角(。！？；…～)+ 半角(!.?)(实机模型常输出半角感叹号)
  const m = /^[\s\S]{0,30}?[。！？；…～!?.]/.exec(raw)
  if (!m) return null
  const head = m[0].slice(0, -1).trim()
  const len = Array.from(head).length
  if (len < 4 || len > MIND_MAX_LEN) return null
  if (looksLikeIncompleteMind(head)) return null
  return head
}

/**
 * 超长且无句末标点的二级兜底截取:人格风格(粤语/猫娘等)常输出逗号串
 * 长句、全程无句末标点——取 ≤16 码元范围内、以逗号/顿号收尾的最长
 * 前缀小句,4-16 码元且非残句才采用,否则返回 null。
 */
export function salvageMindClause(raw: string): string | null {
  const chars = Array.from(raw)
  let best: string | null = null
  // 逐码元扫描前 16 码元内的逗号/顿号,保留最后一个(= 最长)合规前缀小句
  for (let i = 0; i < Math.min(chars.length, MIND_MAX_LEN); i++) {
    if (/[,，、]/.test(chars[i])) {
      const head = chars.slice(0, i).join('').trim()
      if (Array.from(head).length >= 4) best = head
    }
  }
  if (!best) return null
  if (looksLikeIncompleteMind(best)) return null
  return best
}

/**
 * 心理行残句判定(测试用导出):以逗号/顿号/冒号等未完成标点结尾、
 * 或收在连词上 = 句子没说完——过短(<4 码元)同样判废。
 * 命中 = 判无效,防「16 码元整却半句」的截断观感。
 */
export function looksLikeIncompleteMind(guess: string): boolean {
  const t = guess.trim()
  if (!t) return true
  if (Array.from(t).length < 4) return true
  return /[,，、;；:：]$/.test(t) || /(你那|就是|因为|但是|然后|所以|还有|这边|之后|接着|反正)$/.test(t)
}

/**
 * 心理行清洗(测试用导出):去引号/首尾括号/「心理刻画:」前缀/尾随标点、
 * 剥离 [刻画：xxx] / 【刻画：xxx】 括号标注,按码元截 16。
 * 2026-10-28 防删过头:标签标注只在括号闭合时整段剥;无闭合时只摘
 * 「括号+标签词(+冒号)」,后面的内容是正文要留下(「[心情真复杂」→
 * 「心情真复杂」),不能像旧实现那样一路吞到结尾。
 */
export function sanitizeMind(raw: string): string {
  const text = raw
    .trim()
    // ①a 闭合的标签标注整段剥:[心情] / [揣测：表情…] / 【内心】……
    //    标签词覆盖 心理刻画/揣测/心态/心情/心里/内心/心声/心理/想法/推测/猜测
    .replace(/[[【]\s*(?:心理刻画|心理揣测|揣测|刻画|心态|心情|心里|内心|心声|心理|想法|推测|猜测)\s*[:：]?[^\]】]*[\]】]/g, '')
    // ①b 无闭合但带冒号的标签标注:剥「[标签:」,保留后面的内容
    .replace(/[[【]\s*(?:心理刻画|心理揣测|揣测|刻画|心态|心情|心里|内心|心声|心理|想法|推测|猜测)\s*[:：]\s*/, '')
    // ①c 无闭合也不带冒号:只摘孤立的「[」,标签词当正文留下
    .replace(/[[【](?=\s*(?:心理刻画|心理揣测|揣测|刻画|心态|心情|心里|内心|心声|心理|想法|推测|猜测))/, '')
    // ①d 残留标签兜底:开头"标签词+]"残片(防御 ① 已漏、或历史持久化的坏值)
    .replace(/^(?:心情|心里|内心|心声|心理|想法|心态|推测|猜测)[\]】]/, '')
    // ② 前缀「心理刻画:」等
    .replace(/^(?:心理刻画|心理揣测|揣测|刻画|心态)\s*[:：]?\s*/, '')
    // ③ 首尾括号/引号
    .replace(/^[「『"'《<（(【[]+|[」』"'》>）)】\]]+$/g, '')
    // ③b 兜底:步骤③剥离了开头"["但标签未匹配步骤①列表,残留"文字+]"。
    //    只认「≤6 个汉字或字母 + ]」的标签残片(估计]/OK]),数字开头的
    //    正常内容(0.9]超赞)不动——旧实现一刀切是删过头
    .replace(/^(?:[一-龥]{1,6}|[A-Za-z]{1,6})[\]】]/, '')
    // ④ 尾随标点
    .replace(/[。！？!?…]+$/, '')
    .trim()
  return Array.from(text).slice(0, 16).join('')
}

/**
 * 她没写心理行时,从她落定的思考里收一句没说出口的话(回复落定后
 * 才调用)。已经出现在回复里的句子丢掉,避免输入框只是把正文再截一段。
 */
export function mindFromReasoning(reasoning: string, reply = ''): TurnDepiction | null {
  const source = String(reasoning ?? '')
  const spoken = String(reply ?? '')
  const labeled =
    quotesAfter(source, /底字/) ??
    plainAfter(source, /写[:：]/) ??
    quotesAfter(source, /写[:：]/)
  const whisper = labeled && usable(labeled, spoken) ? labeled : unspokenLine(source, spoken)
  if (!whisper) return null
  const text = clipChars(whisper, 40)
  const islandRaw =
    quotesAfter(source, /岛上/) ??
    quotesAfter(source, /4\s*[-~到至]\s*16/) ??
    shortAside(source, spoken, text)
  const island = (islandRaw && usable(islandRaw, spoken) ? fitIsland(islandRaw) : null) ?? fitIsland(text)
  if (!island) return null
  return { island, kind: kindChoice(source) ?? 'pure', whisper: text }
}

/** 思考里另起的短句,通常是岛上那一句,不要拿底字去截。 */
function shortAside(source: string, reply: string, whisper: string): string | null {
  let found: string | null = null
  for (const hit of source.matchAll(/[「『"“]([^」』"”\n]{4,16})[」』"”]/g)) {
    const text = cleanLine(hit[1] ?? '')
    if (Array.from(text).length > 16 || text === whisper || !usable(text, reply)) continue
    found = text
  }
  return found
}

/** 思考里最后一句没写进回复的话。草稿、格式说明不算。 */
function unspokenLine(source: string, reply: string): string | null {
  const kept: string[] = []
  for (const raw of source.split(/[。！？\n；;]+/)) {
    const text = cleanLine(raw)
    if (!usable(text, reply)) continue
    if (Array.from(text).length > 36) continue
    if (/^(回|可以|行了|好|嗯|先|再|然后|或者|不过|如果|那我|试试|简短|别太|注意|要呆|要软|短就|两行|或者直说|我倾向)/.test(text)) continue
    kept.push(text)
  }
  for (let i = kept.length - 1; i >= 0; i--) {
    if (/其实|心里|想|有点|还在|没说/.test(kept[i])) return kept[i]
  }
  // 二档偏好(2026-10-28 人格味道):兜底选句偏向带自称/口癖的行,
  // 别拿一句平铺直叙的分析腔充数
  for (let i = kept.length - 1; i >= 0; i--) {
    if (/我|咱|人家|本喵|本小姐|奴家|啦|嘛|呀|呢|哼|呜|喵|诶|咯|呗|哈|嘞/.test(kept[i])) return kept[i]
  }
  return kept.length ? kept[kept.length - 1] : null
}

/**
 * 这一轮该印在输入框里的心理。等回复落定再判断:只在回复落定后调用。
 * 只用她没说出口的那句。回复本身不再拿来截一句充数。
 */
export function depictTurn(reply: string, reasoning: string): TurnDepiction | null {
  return mindFromReasoning(reasoning, reply)
}

/** 标记开口(与 mind-reflect 同一套宽容规则:‹/< /〈 + 空白 + 心 + 竖线) */
const MARK_OPEN_RE = /[‹<〈]\s*心\s*[|｜]/
/** 整行以标记开口 = 标记行(协议:独占末行),整行吞(含没写完的) */
const MARK_LINE_RE = /^[ \t]*[‹<〈]\s*心\s*[|｜]/
/** 行内完整标记:到同行最后一个收尾符,含两侧水平空白 */
const SPAN_INLINE_RE = /[ \t]*[‹<〈]\s*心\s*[|｜][^\n]*[›》〉>][ \t]*/g
/** 没闭合的标记尾巴:从开口吞到行末 */
const OPEN_TO_EOL_RE = /[ \t]*[‹<〈]\s*心\s*[|｜][^\n]*$/

/** 脏文本快检:标记 / 裸协议行 / 格式旁白都没有时,一个字都不动 */
const MIND_DIRTY_RE = new RegExp(
  [
    MARK_OPEN_RE.source,
    MIND_META_LINE.source,
    MIND_META_PREFIX_LINE.source,
    MIND_META_BRACKETED.source,
    '^\\s*(?:岛上一句|岛上|底字|心迹行|心迹|心行|心理刻画|心理揣测)\\s*[:：]',
    '^\\s*种类\\s*[:：]\\s*(?:说|望|纯|说或望或纯)\\s*$',
  ].join('|'),
  'm',
)

/**
 * 没有标记时原样返回。有标记时(2026-10-28 全量兜底):
 * - ‹心|…› 标记行整行吞(含空白/半角开口变体、没写完的、› 残尾的);
 * - 裸协议行(「种类:纯」「底字:…」没写包装)整行吞;
 * - 「加心一行」类格式旁白行/括号旁白吞掉。
 */
export function stripMindMarks(text: string): string {
  const src = String(text ?? '')
  if (!MIND_DIRTY_RE.test(src)) return src
  const kept: string[] = []
  for (const line of src.split('\n')) {
    if (MARK_LINE_RE.test(line)) continue
    // 先剥行内标记再判旁白/裸协议行——「加心一行‹心|…›」剥完标记
    // 剩下的才是旁白行,顺序反了会把「加心一行」留在正文里
    const cleaned = line
      .replace(SPAN_INLINE_RE, '')
      .replace(OPEN_TO_EOL_RE, '')
      .replace(MIND_META_BRACKETED, '')
    if (isMindBareLine(cleaned)) continue
    if (MIND_META_LINE.test(cleaned) || MIND_META_PREFIX_LINE.test(cleaned)) continue
    kept.push(cleaned)
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n+$/g, '')
}
