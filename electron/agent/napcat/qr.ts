/**
 * 零依赖 QR 编码器(byte mode,纠错等级 M,版本 1-10)(2026-09-22)
 *
 * 为 NapCat/米家扫码登录而建:登录码 = 登录短链(57-136 字节),需要在
 * 本地把链接编码成二维码画到登录小窗上。依赖纪律:引擎侧零第三方依赖
 * ——手写 ISO/IEC 18004 编码器(比引入 qrcode 库更符合项目约定,且可与
 * python qrcode 的 get_matrix() 逐格对拍验证)。
 *
 * 范围:byte mode(全部字节 0x00-0xFF)、纠错 M、版本 1-10(容量 14-213
 * 字节)。米家 loginUrl 实测 136 字节 → 版本 8(2026-09-22 扩表修「QR
 * 数据过长」);版本 ≥7 含版本信息块(BCH(18,6),与 python qrcode 对拍
 * 向量 v7=0x07C94/v8=0x085BC/v9=0x09A99/v10=0x0A4D3)与多校正图形
 * (中间坐标压定时图形,模块值天然一致,照放);v8+ 数据块两组不等长,
 * 交织按列取各块、短块提前耗尽自然跳过。
 * 矩阵 row×col 布局,modules[r][c] = true 表示黑格。
 */

// ---- GF(256)(RS 纠错用,本原多项式 0x11D) ----
const GF_EXP = new Uint8Array(512)
const GF_LOG = new Uint8Array(256)
;(() => {
  let x = 1
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x
    GF_LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255]
})()

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0
  return GF_EXP[GF_LOG[a] + GF_LOG[b]]
}

/** RS 生成多项式:g(x) = ∏(x - α^i),i ∈ [0, n)(系数高位在前,首项恒 1) */
function rsGenerator(n: number): Uint8Array {
  let poly = new Uint8Array([1])
  for (let i = 0; i < n; i++) {
    const next = new Uint8Array(poly.length + 1)
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= gfMul(poly[j], GF_EXP[i])
      next[j + 1] ^= poly[j]
    }
    // 上式按 (x + α^i) 展开时次序相反,统一为标准形式:重排为高位在前
    poly = next
  }
  // 观察:next[j] 放 x·系数、next[j+1] 放 α^i·系数 的布局会得到低次在前;
  // 直接反转成标准 g(x) 系数数组(首项 1 在 index 0)
  return poly.reverse()
}

/** 数据块 RS 纠错码(data 高位在前,返回 n 个纠错码字) */
export function rsEncode(data: Uint8Array, eccLen: number): Uint8Array {
  const gen = rsGenerator(eccLen)
  const res = new Uint8Array(eccLen)
  for (const d of data) {
    const factor = d ^ res[0]
    res.copyWithin(0, 1)
    res[eccLen - 1] = 0
    for (let i = 0; i < eccLen; i++) res[i] ^= gfMul(gen[i + 1], factor)
  }
  return res
}

// ---- 版本表(纠错等级 M)----
// blocks: [[块数, 每块数据码字], …](短块组在前,v8+ 两组不等长);
// eccPerBlock 各块相同;byteCap 见 byteCapacity(v10 起计数位 16bit)
const VERSIONS_M = [
  null,
  { total: 26, data: 16, blocks: [[1, 16]], eccPerBlock: 10 }, // v1: 1×(26,16)
  { total: 44, data: 28, blocks: [[1, 28]], eccPerBlock: 16 }, // v2: 1×(44,28)
  { total: 70, data: 44, blocks: [[1, 44]], eccPerBlock: 26 }, // v3: 1×(70,44)
  { total: 100, data: 64, blocks: [[2, 32]], eccPerBlock: 18 }, // v4: 2×(50,32)
  { total: 134, data: 86, blocks: [[2, 43]], eccPerBlock: 24 }, // v5: 2×(67,43)
  { total: 172, data: 108, blocks: [[4, 27]], eccPerBlock: 16 }, // v6: 4×(43,27)
  { total: 196, data: 124, blocks: [[4, 31]], eccPerBlock: 18 }, // v7: 4×(49,31)
  { total: 242, data: 154, blocks: [[2, 38], [2, 39]], eccPerBlock: 22 }, // v8: 2×(60,38)+2×(61,39)
  { total: 292, data: 182, blocks: [[3, 36], [2, 37]], eccPerBlock: 22 }, // v9: 3×(58,36)+2×(59,37)
  { total: 346, data: 216, blocks: [[4, 43], [1, 44]], eccPerBlock: 26 }, // v10: 4×(69,43)+1×(70,44)
] as const

type VersionInfo = { total: number; data: number; blocks: ReadonlyArray<readonly [number, number]>; eccPerBlock: number }

/** byte 模式字符计数指示器位宽:v1-9 = 8bit,v10-26 = 16bit */
function countBits(v: number): number {
  return v <= 9 ? 8 : 16
}

/** byte mode 数据容量(字节):floor((数据码字×8 - 4bit 模式 - 计数位)/8) */
function byteCapacity(v: number): number {
  return Math.floor(((VERSIONS_M[v] as VersionInfo).data * 8 - 4 - countBits(v)) / 8)
}

// ---- 码字流 ----
function buildCodewords(bytes: Uint8Array, v: number): Uint8Array {
  const info = VERSIONS_M[v] as VersionInfo
  const bits: number[] = []
  const push = (val: number, n: number) => {
    for (let i = n - 1; i >= 0; i--) bits.push((val >> i) & 1)
  }
  push(0b0100, 4) // byte mode
  push(bytes.length, countBits(v)) // 计数位宽:v1-9=8bit,v10+=16bit
  for (const b of bytes) push(b, 8)
  // 终止符 + 补齐到字节 + 交替填充码字
  const capBits = info.data * 8
  for (let i = 0; i < 4 && bits.length < capBits; i++) bits.push(0)
  while (bits.length % 8 !== 0) bits.push(0)
  const data = new Uint8Array(info.data)
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j]
    data[i / 8] = b
  }
  const pads = [0xec, 0x11]
  for (let i = bits.length / 8, p = 0; i < info.data; i++, p++) data[i] = pads[p % 2]
  // 分块 RS + 交织(短块组在前;交织按列取各块,短块提前耗尽自然跳过)
  const dataBlocks: Uint8Array[] = []
  const eccBlocks: Uint8Array[] = []
  let off = 0
  for (const [count, perBlock] of info.blocks) {
    for (let i = 0; i < count; i++) {
      const block = data.slice(off, off + perBlock)
      off += perBlock
      dataBlocks.push(block)
      eccBlocks.push(rsEncode(block, info.eccPerBlock))
    }
  }
  const out = new Uint8Array(info.total)
  let k = 0
  const maxData = Math.max(...dataBlocks.map((b) => b.length))
  for (let i = 0; i < maxData; i++) for (const b of dataBlocks) if (i < b.length) out[k++] = b[i]
  for (let i = 0; i < info.eccPerBlock; i++) for (const b of eccBlocks) out[k++] = b[i]
  return out
}

// ---- 矩阵 ----
// 校正图形中心坐标(每版本升序,首 6 尾 size-7;组合去掉三角 = 与定位图形重叠)
const ALIGN_POS = [
  null,
  null,
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
] as const

function newGrid(size: number): Uint8Array {
  // 0 = 空, 1 = 黑, 2 = 白;功能图形直接写入,数据位写入前保持 -1
  const g = new Uint8Array(size * size).fill(255)
  return g
}

function buildMatrix(v: number, codewords: Uint8Array, mask: number): boolean[][] {
  const size = 17 + 4 * v
  const grid = newGrid(size)
  const at = (r: number, c: number) => r * size + c
  const set = (r: number, c: number, dark: boolean) => {
    grid[at(r, c)] = dark ? 1 : 0
  }
  const reserved = new Uint8Array(size * size)

  // 定位图形 + 分隔带(三个角)
  const finder = (r0: number, c0: number) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const r1 = r0 + r
        const c1 = c0 + c
        if (r1 < 0 || r1 >= size || c1 < 0 || c1 >= size) continue
        const inRing = (r >= 0 && r <= 6 && (c === 0 || c === 6)) || (c >= 0 && c <= 6 && (r === 0 || r === 6))
        const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4
        set(r1, c1, inRing || inCore)
        reserved[at(r1, c1)] = 1
      }
    }
  }
  finder(0, 0)
  finder(0, size - 7)
  finder(size - 7, 0)

  // 定时图形
  for (let i = 8; i < size - 8; i++) {
    set(6, i, i % 2 === 0)
    set(i, 6, i % 2 === 0)
    reserved[at(6, i)] = 1
    reserved[at(i, 6)] = 1
  }

  // 校正图形(坐标两两组合,唯三位于定位图形上的角落组合不放)
  // 注:中间坐标(如 v7 的 6,22)压定时图形时照放——校正图形中线与定时
  // 图形同相(10101),实测 python qrcode 一致,不能用 reserved 跳过
  const align = ALIGN_POS[v] as readonly number[] | null
  if (align) {
    const first = align[0] as number
    const last = align[align.length - 1] as number
    for (const r of align) {
      for (const c of align) {
        if ((r === first && c === first) || (r === first && c === last) || (r === last && c === first)) continue
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            const ring = Math.max(Math.abs(dr), Math.abs(dc))
            set(r + dr, c + dc, ring !== 1)
            reserved[at(r + dr, c + dc)] = 1
          }
        }
      }
    }
  }

  // 版本信息(版本 ≥7):BCH(18,6),6bit 版本号 + 12bit 纠错(G=0x1F25),
  // 右上(行 0-5 × 列 size-11..size-9)与左下两份副本,bit i 低位居先
  if (v >= 7) {
    let rem = v
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ (((rem >>> 11) & 1) * 0x1f25)
    const bits = (v << 12) | rem
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >> i) & 1) === 1
      const a = size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      set(b, a, dark) // 副本 1:右上
      reserved[at(b, a)] = 1
      set(a, b, dark) // 副本 2:左下
      reserved[at(a, b)] = 1
    }
  }

  // 固定黑格(规格: (4v+9, 8) 恒黑)+ 格式信息保留区
  set(size - 8, 8, true)
  reserved[at(size - 8, 8)] = 1
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) {
      reserved[at(8, i)] = 1
      reserved[at(i, 8)] = 1
    }
  }
  for (let i = 0; i < 8; i++) {
    reserved[at(8, size - 1 - i)] = 1
    reserved[at(size - 1 - i, 8)] = 1
  }

  // 数据位 zigzag 布置(右下起,双列一组跳过第 6 列)
  let bitIdx = 0
  const totalBits = codewords.length * 8
  const bitAt = (i: number) => (codewords[i >> 3] >> (7 - (i & 7))) & 1
  let up = true
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col = 5 // 跳过定时列
    for (let i = 0; i < size; i++) {
      const row = up ? size - 1 - i : i
      for (const dc of [0, -1]) {
        const c = col + dc
        if (c < 0 || reserved[at(row, c)]) continue
        let dark = false
        if (bitIdx < totalBits) dark = bitAt(bitIdx) === 1
        bitIdx++
        // 掩码只作用于数据区
        const m = maskBit(mask, row, c)
        set(row, c, m ? !dark : dark)
      }
    }
    up = !up
  }

  // 格式信息(BCH 15,5)
  const format = formatBits(mask)
  const fbit = (i: number) => ((format >> (14 - i)) & 1) === 1
  // 副本 1(左上)
  for (let i = 0; i <= 5; i++) set(8, i, fbit(i))
  set(8, 7, fbit(6))
  set(8, 8, fbit(7))
  set(7, 8, fbit(8))
  for (let i = 9; i <= 14; i++) set(14 - i, 8, fbit(i))
  // 副本 2(右上 + 左下)
  for (let i = 0; i <= 6; i++) set(size - 1 - i, 8, fbit(i))
  for (let i = 7; i <= 14; i++) set(8, size - 15 + i, fbit(i))

  return Array.from({ length: size }, (_, r) =>
    Array.from({ length: size }, (_, c) => grid[at(r, c)] === 1),
  )
}

function maskBit(mask: number, r: number, c: number): boolean {
  switch (mask) {
    case 0: return (r + c) % 2 === 0
    case 1: return r % 2 === 0
    case 2: return c % 3 === 0
    case 3: return (r + c) % 3 === 0
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0
    case 5: return ((r * c) % 2) + ((r * c) % 3) === 0
    case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0
    default: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0
  }
}

/** 格式信息 15bit:高 5 位 = 00(等级 M)+ 掩码 3bit + BCH(15,5) 10bit,再异或 0x5412 */
function formatBits(mask: number): number {
  const data = (0b00 << 3) | mask // 等级 M = 00
  let rem = data << 10
  for (let i = 14; i >= 10; i--) {
    if ((rem >> i) & 1) rem ^= 0x537 << (i - 10)
  }
  return (((data << 10) | rem) ^ 0x5412) & 0x7fff
}

/** 掩码罚分(ISO 18004 规则 1-4,选最优掩码) */
function penalty(grid: boolean[][]): number {
  const size = grid.length
  let score = 0
  // 规则 1:同色连续 ≥5
  for (let i = 0; i < size; i++) {
    for (const axis of [0, 1]) {
      let run = 1
      for (let j = 1; j < size; j++) {
        const a = axis === 0 ? grid[i][j] : grid[j][i]
        const b = axis === 0 ? grid[i][j - 1] : grid[j - 1][i]
        if (a === b) {
          run++
          if (j === size - 1 && run >= 5) score += 3 + run - 5
        } else {
          if (run >= 5) score += 3 + run - 5
          run = 1
        }
      }
    }
  }
  // 规则 2:同色 2×2
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = grid[r][c]
      if (v === grid[r][c + 1] && v === grid[r + 1][c] && v === grid[r + 1][c + 1]) score += 3
    }
  }
  // 规则 3:类似定位图形的 1011101 0000 / 0000 1011101
  const pat = [true, false, true, true, true, false, true, false, false, false, false]
  for (let i = 0; i < size; i++) {
    for (let j = 0; j + 11 <= size; j++) {
      for (const axis of [0, 1]) {
        let hit = true
        let hitR = true
        for (let k = 0; k < 11; k++) {
          const a = axis === 0 ? grid[i][j + k] : grid[j + k][i]
          if (a !== pat[k]) hit = false
          if (a !== pat[10 - k]) hitR = false
        }
        if (hit) score += 40
        if (hitR) score += 40
      }
    }
  }
  // 规则 4:黑白比例偏离
  let dark = 0
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (grid[r][c]) dark++
  const pct = (dark * 100) / (size * size)
  score += Math.floor(Math.abs(pct - 50) / 5) * 10
  return score
}

export interface QrCode {
  size: number
  modules: boolean[][]
}

/**
 * 编码文本为二维码矩阵(自动选版本 1-6 与最优掩码)。
 * opts.mask 固定掩码(测试对拍用;缺省按罚分选)
 */
export function encodeQr(text: string, opts?: { mask?: number }): QrCode {
  const bytes = new TextEncoder().encode(String(text ?? ''))
  let v = 0
  for (let cand = 1; cand <= 10; cand++) {
    if (bytes.length <= byteCapacity(cand)) {
      v = cand
      break
    }
  }
  if (!v) throw new Error(`QR 数据过长(byte mode 上限 ${byteCapacity(10)} 字节,实际 ${bytes.length})`)
  const codewords = buildCodewords(bytes, v)
  if (opts?.mask !== undefined) {
    const m = buildMatrix(v, codewords, opts.mask)
    return { size: m.length, modules: m }
  }
  let best: boolean[][] | null = null
  let bestScore = Infinity
  for (let mask = 0; mask < 8; mask++) {
    const m = buildMatrix(v, codewords, mask)
    const s = penalty(m)
    if (s < bestScore) {
      bestScore = s
      best = m
    }
  }
  return { size: (best as boolean[][]).length, modules: best as boolean[][] }
}
