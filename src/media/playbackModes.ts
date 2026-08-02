/** 播放模式:顺序播放 / 单曲循环 / 随机播放 */
export type PlaybackMode = 'sequence' | 'repeat-one' | 'shuffle'

export const MODE_ORDER: readonly PlaybackMode[] = ['sequence', 'repeat-one', 'shuffle']

export const PLAY_MODES: Record<PlaybackMode, { label: string; color: string }> = {
  sequence: { label: '顺序播放', color: '#4ade80' },
  'repeat-one': { label: '单曲循环', color: '#60a5fa' },
  shuffle: { label: '随机播放', color: '#a78bfa' },
}
