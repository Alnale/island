# HEVC(H.265) Electron 补丁源文件

> 2026-09-23 自 `C:\electron-gn\patches\` 备份;源码树 `C:\electron-gn` 已删除(仅为腾空间,
> 补丁已编译固化在 `C:\electron-hevc-dist` 产物里)。**本目录是补丁文件的唯一备份。**
> 背景与踩坑全文见 docs/TECH.md 10.3 / 10.10 / 10.11 / 15 章。

## 文件说明

| 文件 | 作用 |
| --- | --- |
| `enable-hevc-ffmpeg-decoding.patch` | media 层门控补丁:`supported_types.cc` 改 `ENABLE_FFMPEG_VIDEO_DECODERS → true`、ffmpeg 解码器白名单 `"h264,hevc"`、`ffmpeg_video_decoder` 线程放开 |
| `add-hevc-ffmpeg-decoder-parser.patch` | ffmpeg 侧解码器/解析器配置补丁(HEVC decoder/parser 进 ffmpeg 构建) |
| `add-hevc-ffmpeg-decoder-parser.cjs` | 配套应用脚本(生成/施加 ffmpeg 补丁) |

## 何时才需要它们

- 日常开发/发行**不需要**:补丁版产物在 `C:\electron-hevc-dist`,`scripts/apply-hevc-electron.mjs`
  从那里把 7 个文件换装进 `node_modules/electron/dist`(dev.bat 自动;`--restore` 回退官方)。
- 只有**升级 Electron 大版本、需要重新编译补丁版**时才用到:克隆官方源码(与目标版本同 tag,
  原构建为 43.2.0)、套用上述两份 .patch、gn/ninja 构建,产物拷入 `C:\electron-hevc-dist`
  覆盖后重跑 `node scripts/brand-electron-icon.mjs`(图标重烙)。

## 已知连带约束(重编前必读)

补丁版 Electron 的两大段错误坑(TECH.md 10.10/10.11):

1. 主进程禁用 `new Notification().show()`(+ 并发网络 = EXCEPTION_ACCESS_VIOLATION),一律走 `showNotify`(tray.displayBalloon)。
2. 内置 Node 22 llhttp use-after-free(nodejs#62095):**fetch 不传 signal**,流中止在 sse.ts parseSse 安全点处理。
