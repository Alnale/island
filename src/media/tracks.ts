import type { TrackInfo } from '../data/islandStates'

/**
 * 内置测试曲目:三首本地 MP3(位于 public/music,由 Vite 以静态资源提供),
 * 仅网页演示构建(mode=dev/production)使用。
 * Electron 挂件构建(--mode widget)清空:本地播放列表只保留用户上传的音乐。
 * 曲目地址用 BASE_URL 拼接:网页版构建 base='/' 时为绝对路径;
 * Electron 挂件构建 base='./' 后为相对路径(file:// 下可正常加载)
 */
const TRACK_DEFS: ReadonlyArray<{ file: string; title: string; artist: string }> =
  import.meta.env.MODE === 'widget'
    ? []
    : [
        { file: `${import.meta.env.BASE_URL}music/1-体面-于文文.mp3`, title: '体面', artist: '于文文' },
        { file: `${import.meta.env.BASE_URL}music/2-虚拟-陈粒.mp3`, title: '虚拟', artist: '陈粒' },
        { file: `${import.meta.env.BASE_URL}music/3-我不曾忘记-花园百合玲.mp3`, title: '我不曾忘记', artist: '花园百合玲' },
      ]

let tracksPromise: Promise<TrackInfo[]> | null = null

/** 懒加载曲目列表(整个会话只解析一次) */
export function loadTracks(): Promise<TrackInfo[]> {
  if (!tracksPromise) {
    tracksPromise = Promise.resolve(
      TRACK_DEFS.map((t) => ({
        title: t.title,
        artist: t.artist,
        url: t.file,
        duration: 0,
        source: 'builtin' as const,
      })),
    )
  }
  return tracksPromise
}
