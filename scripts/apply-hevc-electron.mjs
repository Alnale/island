// 应用自编译 HEVC Electron 二进制到官方 dist(2026-08-12):
// 官方 Electron 的 ffmpeg 不含 HEVC(H.265)解码器(专有编码,Chromium
// 默认排除),且 media 层把 HEVC 门控在"平台解码器能力"上(Windows 上
// 必须 GPU 进程枚举到 HEVC profile 才放行,见 supported_types.cc 的
// IsDecoderHevcProfileSupported)——挂件禁用硬件加速(透明窗口稳定)时
// 该门控恒 false,HEVC 视频"播放中但零帧呈现"全黑,换 ffmpeg.dll 无效。
//
// 正解 = 自编译 electron.exe(C:\electron-hevc-dist,源码树 C:\electron-gn):
// ① 带 HEVC ffmpeg 软解(add-hevc-ffmpeg-decoder-parser 补丁,ffmpeg 侧
//    解码器/解析器配置);② media 层门控补丁(enable-hevc-ffmpeg-decoding
//    .patch:supported_types.cc 改 ENABLE_FFMPEG_VIDEO_DECODERS → true,
//    ffmpeg 解码器白名单 "h264,hevc"、ffmpeg_video_decoder 线程放开)。
//    与官方 43.2.0 同一 tag 构建(git describe = v43.2.0),二进制兼容。
//
// 只换 7 个构建相关文件(配套快照/pak 必须与 exe 同源,V8 快照不匹配
// 启动即崩),其余(icudtl/locales/GL dll/version 等)保持官方原版——
// 换装面最小,官方版全量备份,一行命令回退。electron.exe 之外的替换
// 均经官方备份可回退(2026-08-12;AV1 自始支持无需本补丁)。
//
// 用法:
//   node scripts/apply-hevc-electron.mjs            # 应用(幂等,缺哪个补哪个)
//   node scripts/apply-hevc-electron.mjs --restore  # 恢复官方原版(全部文件)
//   node scripts/apply-hevc-electron.mjs --check    # 只报告状态不修改
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC_DIR = 'C:\\electron-hevc-dist'
const DIST_DIR = path.join(ROOT, 'node_modules', 'electron', 'dist')

// 必须与 exe 同源的构建产物(快照/pak 不匹配官方 exe 会启动异常)
const FILES = [
  'electron.exe',
  'ffmpeg.dll',
  'snapshot_blob.bin',
  'v8_context_snapshot.bin',
  'chrome_100_percent.pak',
  'chrome_200_percent.pak',
  'resources.pak',
]

const mode = process.argv[2] === '--restore' ? 'restore' : process.argv[2] === '--check' ? 'check' : 'apply'

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** 返回各文件状态:{name, src: bool(源存在), applied: bool(已是源版本)} */
function fileStates() {
  return FILES.map((name) => {
    const src = path.join(SRC_DIR, name)
    const dist = path.join(DIST_DIR, name)
    const srcExists = existsSync(src)
    const distExists = existsSync(dist)
    return {
      name,
      src: srcExists,
      applied: srcExists && distExists && sha256(src) === sha256(dist),
      dist: distExists,
    }
  })
}

if (mode === 'restore') {
  let restored = 0
  for (const st of fileStates()) {
    const backup = path.join(DIST_DIR, st.name + '.official')
    if (existsSync(backup)) {
      copyFileSync(backup, path.join(DIST_DIR, st.name))
      restored++
    }
  }
  console.log(`[hevc-ffmpeg] 已恢复 ${restored} 个官方文件(HEVC 播放退回不可用;备份文件保留)`)
  process.exit(0)
}

if (mode === 'check') {
  const states = fileStates()
  const appliedCount = states.filter((s) => s.applied).length
  const missingSrc = states.filter((s) => !s.src).map((s) => s.name)
  console.log(
    `[hevc-ffmpeg] ${appliedCount === FILES.length ? '已应用——HEVC(H.265)可窗口内软解播放' : `部分应用 ${appliedCount}/${FILES.length}${missingSrc.length ? '(源缺失: ' + missingSrc.join(', ') + ')' : ''}——HEVC 不可播`}`
  )
  process.exit(appliedCount === FILES.length ? 0 : 1)
}

// apply 模式:逐文件换装(幂等;源缺失的文件跳过并提示)
let applied = 0
for (const st of fileStates()) {
  if (!st.src) {
    console.warn(`[hevc-ffmpeg] 源缺失,跳过:${SRC_DIR}\\${st.name}(需先在 C:\\electron-gn 构建)`)
    continue
  }
  if (st.applied) {
    applied++
    continue
  }
  const dist = path.join(DIST_DIR, st.name)
  const backup = dist + '.official'
  // 备份官方原版(首次;恢复命令 = --restore)
  if (st.dist && !existsSync(backup)) {
    copyFileSync(dist, backup)
  }
  try {
    copyFileSync(path.join(SRC_DIR, st.name), dist)
  } catch (err) {
    console.error(`[hevc-ffmpeg] ${st.name} 应用失败:`, err.code === 'EBUSY' ? '有 electron 实例正在运行,文件被占用——先退出挂件再执行(dev.bat 会自动处理)' : err.message)
    process.exit(1)
  }
  applied++
  console.log(`[hevc-ffmpeg] 已换装 ${st.name}`)
}
console.log(`[hevc-ffmpeg] 完成 ${applied}/${FILES.length}——HEVC(H.265)现可窗口内软解播放`)
console.log('[hevc-ffmpeg] 恢复官方版:node scripts/apply-hevc-electron.mjs --restore')
