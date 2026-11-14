/**
 * 单曲循环的进度折回。
 *
 * QQ 音乐单曲循环时曲目键不变,SMTC 时间线又经常停在结尾、轮询间
 * 几乎不动(移动 < 2s)。显示进度 = 锚定基准 + 本地时钟,重锚定要求
 * 「偏离 > 5s 且上报大幅移动」,两条都不满足,本地时钟就越过时长
 * 一直涨:进度条卡满,右上角计时继续走。
 *
 * 本函数不改钩子状态,只给出这一拍要不要改写基准。
 */

/** 非单曲循环时,同一首仍在播且越过时长这么多秒,也视为循环重播
 *  (有的客户端不把单曲循环写进 SMTC)。顺序切歌通常 1 秒内就会换
 *  曲目键或停下,留出这个余量避免把「即将切歌」折回成 0。 */
export const REPEAT_PAST_END_GRACE_SEC = 2

/** 折回之后,上报仍落在时长末尾这段里,当成没跟上的旧结尾,
 *  不要把已经折回的进度再拉回去。 */
export const STALE_END_WINDOW_SEC = 8

export interface RepeatLoopInput {
  /** 这一拍的本地显示进度(秒) */
  displayed: number
  /** 本拍 SMTC 上报位置 */
  reported: number
  /** 上一拍上报;没有则为 null */
  prevReported: number | null
  duration: number
  /** 上报没有明显超过时长。超过时时长本身不可信,不能拿来折回。 */
  durationTrusted: boolean
  mode: string | undefined
  sameTrack: boolean
  playing: boolean
  /** 折回时记下的结尾位置;null = 不在保持期 */
  staleEnd: number | null
}

export interface RepeatLoopDecision {
  /** 非 null:把显示基准改成该值,并把流逝起点设为当前时刻 */
  base: number | null
  staleEnd: number | null
  /** 为 true 时跳过「偏离且上报活着」重锚定 */
  suppressDiverge: boolean
}

/** 上报是不是还贴在上一轮结尾(折回后不能采信) */
function reportedStuckAtEnd(reported: number, duration: number, staleEnd: number | null): boolean {
  if (staleEnd === null || !(duration > 0)) return false
  return reported > duration - STALE_END_WINDOW_SEC && reported <= duration + 5
}

/**
 * 决定单曲循环这一拍的显示基准。
 * 返回的 base 已经落在 [0, duration) 内。
 */
export function reconcileRepeatLoop(input: RepeatLoopInput): RepeatLoopDecision {
  const { displayed, reported, prevReported, duration, durationTrusted, mode, sameTrack, playing } =
    input
  let staleEnd = input.staleEnd

  // 暂停只是停住,结尾残留还在;清掉的话一恢复就会被旧结尾拉回去。
  if (!playing) {
    return {
      base: null,
      staleEnd,
      suppressDiverge: reportedStuckAtEnd(reported, duration, staleEnd),
    }
  }
  if (!sameTrack || !durationTrusted || !(duration > 0) || !Number.isFinite(displayed)) {
    return { base: null, staleEnd: null, suppressDiverge: false }
  }

  // 时间线真的跳回曲首(循环或大幅回退):直接采信,不再靠本地取模。
  const jumpedBack =
    prevReported !== null &&
    reported < prevReported - 5 &&
    reported < duration * 0.5 &&
    prevReported > duration * 0.5
  if (jumpedBack) {
    return { base: Math.max(0, reported), staleEnd: null, suppressDiverge: true }
  }

  const repeatOne = mode === 'repeat-one'
  const pastEnd = displayed >= duration + (repeatOne ? 0 : REPEAT_PAST_END_GRACE_SEC)
  if (pastEnd) {
    const wrapped = displayed % duration
    // 上报已经回到新一轮前半,比取模更接近真实播放点。
    const reportedInNewLoop = reported < duration * 0.5 && reported + 5 < displayed
    if (reportedInNewLoop) {
      return { base: Math.max(0, reported), staleEnd: null, suppressDiverge: true }
    }
    return { base: wrapped, staleEnd: reported, suppressDiverge: true }
  }

  // 已经折回:结尾附近的上报还是上一轮的残留。
  if (reportedStuckAtEnd(reported, duration, staleEnd)) {
    return { base: null, staleEnd, suppressDiverge: true }
  }
  if (staleEnd !== null) staleEnd = null
  return { base: null, staleEnd, suppressDiverge: false }
}
