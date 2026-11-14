/**
 * 单曲循环进度折回 —— 纯函数直测
 *
 * 回归:QQ 音乐单曲循环播第二遍时,曲目键不变,时间线停在结尾,
 * 本地时钟越过时长后进度条卡满、右上角计时一直涨(5:27 的歌显示 7:06)。
 *
 * 用法:node tests/test-repeat-position.mjs
 */
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const result = await build({
  entryPoints: [path.join(root, 'src', 'media', 'repeatPosition.ts')],
  bundle: true,
  write: false,
  format: 'esm',
  logLevel: 'warning',
})
const mod = await import(
  'data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64')
)
const { reconcileRepeatLoop } = mod

const DUR = 5 * 60 + 27 // 5:27
const PAST = 7 * 60 + 6 // 7:06,第二轮 1:39

let passed = 0
let failed = 0
function check(name, cond) {
  if (cond) {
    passed++
    console.log(`  ok  ${name}`)
  } else {
    failed++
    console.log(`  FAIL ${name}`)
  }
}

const base = {
  duration: DUR,
  durationTrusted: true,
  mode: 'repeat-one',
  sameTrack: true,
  playing: true,
  staleEnd: null,
}

// 第一遍播到中途:不动
{
  const d = reconcileRepeatLoop({
    ...base,
    displayed: 100,
    reported: 100,
    prevReported: 99,
  })
  check('曲中不折回', d.base === null && d.suppressDiverge === false)
}

// 截图:本地 7:06,上报停在 5:27
{
  const d = reconcileRepeatLoop({
    ...base,
    displayed: PAST,
    reported: DUR,
    prevReported: DUR - 1,
  })
  check('越过时长折成 1:39', d.base === PAST % DUR)
  check('折回后抑制拉回结尾', d.suppressDiverge === true && d.staleEnd === DUR)
}

// 下一拍:显示已在第二轮,上报仍贴结尾
{
  const d = reconcileRepeatLoop({
    ...base,
    displayed: 100,
    reported: DUR - 1,
    prevReported: DUR,
    staleEnd: DUR,
  })
  check('结尾残留不改基准', d.base === null && d.suppressDiverge === true)
  check('残留标记保留', d.staleEnd === DUR)
}

// 时间线真的跳回曲首
{
  const d = reconcileRepeatLoop({
    ...base,
    displayed: 110,
    reported: 8,
    prevReported: DUR,
    staleEnd: DUR,
  })
  check('跳回曲首采信上报', d.base === 8 && d.staleEnd === null)
}

// 顺序模式刚过结尾 1 秒:可能是切歌前夕,不折
{
  const d = reconcileRepeatLoop({
    ...base,
    mode: 'sequence',
    displayed: DUR + 1,
    reported: DUR,
    prevReported: DUR - 1,
  })
  check('顺序模式刚过结尾不折', d.base === null)
}

// 顺序模式同一首仍在播且越过 2 秒:客户端没写单曲循环
{
  const d = reconcileRepeatLoop({
    ...base,
    mode: 'sequence',
    displayed: DUR + 3,
    reported: DUR,
    prevReported: DUR,
  })
  check('未声明循环但越过 2 秒仍折回', d.base === (DUR + 3) % DUR)
}

// 暂停不把进度折走,残留标记留着
{
  const d = reconcileRepeatLoop({
    ...base,
    playing: false,
    displayed: PAST,
    reported: DUR,
    prevReported: DUR,
    staleEnd: DUR,
  })
  check('暂停不折回', d.base === null && d.staleEnd === DUR && d.suppressDiverge === true)
}

// 时长不可信:不折
{
  const d = reconcileRepeatLoop({
    ...base,
    durationTrusted: false,
    displayed: PAST,
    reported: DUR + 20,
    prevReported: DUR + 19,
  })
  check('时长不可信不折回', d.base === null && d.suppressDiverge === false)
}

// 换曲不折(交给曲目变化重锚定)
{
  const d = reconcileRepeatLoop({
    ...base,
    sameTrack: false,
    displayed: PAST,
    reported: 2,
    prevReported: DUR,
  })
  check('换曲不折回', d.base === null)
}

// 正好播完:折到 0,进度条从满格回到起点
{
  const d = reconcileRepeatLoop({
    ...base,
    displayed: DUR,
    reported: DUR,
    prevReported: DUR - 0.5,
  })
  check('正好播完折到 0', d.base === 0)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
