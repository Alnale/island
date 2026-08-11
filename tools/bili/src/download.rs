//! 下载引擎：playurl 直链选择、Range 分片并发下载、断点续传、ffmpeg 转码/合并。
//! 纯 Rust 实现（reqwest），无 yt-dlp/python 依赖；唯一外部依赖 ffmpeg（转码）。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use tokio::io::AsyncWriteExt;

use crate::api::{ApiError, BiliApi};
use crate::utils;
use crate::video;

pub const CHUNK: u64 = 4 * 1024 * 1024; // 分片大小 4MB

#[derive(Clone)]
pub struct DownloadOptions {
    pub quality: String,
    pub audio_only: Option<String>, // None=视频, Some("wav"/"mp3"/...)
    pub parallel: usize,
    pub rate: Option<String>,
    pub danmaku: bool,
    pub dm_fmt: Vec<String>,
    pub subs: bool,
    pub cover: bool,
    pub force: bool,
    pub skip: bool,
    pub page: Option<i64>, // 分P：Some(n) 只下第 n P；None=全部
    /// 视频编码策略(2026-08-11,修复"HEVC 视频在挂件对话窗口播放全黑"):
    /// `auto`(缺省)= 视频流是 HEVC(H.265)/AV1 时自动转码为 H.264
    /// (libx264 veryfast,1080p 实测 ~17x 实时,33 分钟视频约 2 分钟)
    /// ——挂件窗口的 Chromium 在禁用硬件加速(透明窗口稳定需要)下无法
    /// 呈现 HEVC 帧,AV1 只能软件解码高码率掉帧;
    /// `copy` = 原样保留编码(旧行为,HEVC 文件在窗口内不可播)
    pub codec: String,
    /// 进度 JSON 文件路径(2026-08-11 实时进度):下载/转码期间持续写入
    /// `{"stage": "download"|"mux"|"transcode"|"done"|"error",
    ///  "label": "video"|"audio", "done": 字节, "total": 字节,
    ///  "percent": 0-100}`——引擎后台任务轮询读取,注入任务状态块,
    /// LLM 对话里可回答"下载到 68%"。None = 不写(缺省)
    pub progress_file: Option<String>,
}

impl Default for DownloadOptions {
    fn default() -> Self {
        DownloadOptions {
            quality: "best".into(),
            audio_only: None,
            parallel: 8,
            rate: None,
            danmaku: true,
            dm_fmt: vec!["xml".into()],
            subs: false,
            cover: true,
            force: false,
            skip: true,
            page: None,
            codec: "auto".into(),
            progress_file: None,
        }
    }
}

#[allow(dead_code)]
pub struct DownloadResult {
    pub bvid: String,
    pub title: String,
    pub path: Option<PathBuf>,
    pub files: Vec<PathBuf>,
    pub skipped: bool,
    pub error: Option<String>,
}

/// 限速 -> 每秒字节数
fn rate_bytes(s: Option<&str>) -> Option<u64> {
    let s = s?;
    let n = s.trim();
    let (num, mult) = if n.ends_with('M') || n.ends_with('m') {
        (n[..n.len() - 1].parse::<f64>().ok()?, 1024.0 * 1024.0)
    } else if n.ends_with('K') || n.ends_with('k') {
        (n[..n.len() - 1].parse::<f64>().ok()?, 1024.0)
    } else {
        (n.parse::<f64>().ok()?, 1.0)
    };
    Some((num * mult) as u64)
}

fn pick_video_stream<'a>(streams: &'a [video::Stream], quality: &str) -> Option<&'a video::Stream> {
    if streams.is_empty() {
        return None;
    }
    let limit = match quality {
        "480" => 480,
        "720" => 720,
        "1080" => 1080,
        "2160" => 2160,
        _ => i64::MAX,
    };
    let mut best: Option<&video::Stream> = None;
    for s in streams {
        if s.height > 0 && s.height <= limit {
            match best {
                None => best = Some(s),
                Some(b) => {
                    if s.height > b.height || (s.height == b.height && s.bandwidth > b.bandwidth) {
                        best = Some(s);
                    }
                }
            }
        }
    }
    // 全部超限时退回最低档
    best.or_else(|| streams.iter().min_by_key(|s| s.height))
}

fn pick_audio_stream(streams: &[video::Stream]) -> Option<&video::Stream> {
    streams.iter().max_by_key(|s| s.bandwidth)
}

/// 写进度 JSON(2026-08-11 实时进度):tmp + rename 原子写,轮询方
/// (引擎)读不到半截 JSON;percent: -1 = 该阶段无百分比概念
pub fn write_progress(path: Option<&str>, stage: &str, label: &str, done: u64, total: u64) {
    let Some(p) = path else { return };
    let percent = if total > 0 { (done as f64 / total as f64 * 100.0).round() as i64 } else { -1 };
    let json = format!(
        "{{\"stage\":\"{}\",\"label\":\"{}\",\"done\":{},\"total\":{},\"percent\":{}}}\n",
        stage, label, done, total, percent
    );
    let tmp = format!("{p}.tmp");
    if std::fs::write(&tmp, &json).is_ok() {
        let _ = std::fs::rename(&tmp, p);
    }
}

/// 下载一个 URL 到文件（Range 分片并发 + 断点续传 + 进度）
pub async fn download_url(
    api: BiliApi,
    url: &str,
    dest: &Path,
    tmpdir: &Path,
    parallel: usize,
    rate_limit: Option<u64>,
    label: &str,
    progress_path: Option<&Path>,
) -> Result<u64, ApiError> {
    std::fs::create_dir_all(tmpdir).map_err(|e| ApiError(format!("创建目录失败: {e}")))?;

    // 探测大小与 Range 支持
    let probe = api.get_bytes(url, Some((0, 0))).await?;
    let total: u64 = probe
        .headers()
        .get(reqwest::header::CONTENT_RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split('/').nth(1))
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let mut probe_stream = probe.bytes_stream();
    // 读取探测的 1 字节（0-0 的响应体）
    use futures::StreamExt;
    while let Some(Ok(chunk)) = probe_stream.next().await {
        if !chunk.is_empty() {
            break;
        }
    }
    drop(probe_stream);

    if total == 0 {
        // 不支持 Range：整文件下载
        let resp = api.get_bytes(url, None).await?;
        let mut f = tokio::fs::File::create(dest).await.map_err(|e| ApiError(format!("创建文件失败: {e}")))?;
        let mut written: u64 = 0;
        use futures::StreamExt;
        let mut stream = resp.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(ApiError::from)?;
            f.write_all(&chunk).await.map_err(|e| ApiError(format!("写文件失败: {e}")))?;
            written += chunk.len() as u64;
        }
        return Ok(written);
    }

    let chunks = total.div_ceil(CHUNK);
    let done = Arc::new(AtomicU64::new(0));       // 已完成分片数
    let done_total = Arc::new(AtomicU64::new(0)); // 已完成字节数
    let max_concurrent = rate_limit
        .map(|r| (r / (CHUNK / 8)).max(1) as usize)
        .unwrap_or(parallel)
        .max(1);
    let semaphore = Arc::new(tokio::sync::Semaphore::new(max_concurrent));
    let mut tasks = Vec::new();

    for i in 0..chunks {
        let start = i * CHUNK;
        let end = ((i + 1) * CHUNK - 1).min(total - 1);
        let part_path = tmpdir.join(format!("{label}_part_{i}.tmp"));
        // 断点续传：已完整存在的分片跳过
        if part_path.exists() && std::fs::metadata(&part_path).map(|m| m.len() == end - start + 1).unwrap_or(false) {
            done.fetch_add(1, Ordering::SeqCst);
            done_total.fetch_add(end - start + 1, Ordering::SeqCst);
            continue;
        }
        let api = api.clone();
        let url = url.to_string();
        let part_path2 = part_path.clone();
        let sem = semaphore.clone();
        let done = done.clone();
        let done_total = done_total.clone();
        tasks.push(tokio::spawn(async move {
            let _perm = sem.acquire_owned().await; // 并发限制/限速
            for attempt in 0..4 {
                match download_chunk(&api, &url, start, end, &part_path2).await {
                    Ok(n) => {
                        done.fetch_add(1, Ordering::SeqCst);
                        done_total.fetch_add(n, Ordering::SeqCst);
                        return;
                    }
                    Err(_) => {
                        tokio::time::sleep(std::time::Duration::from_secs(2 + attempt)).await;
                    }
                }
            }
            // 最终失败：留下缺口，拼接时检测
        }));
    }

    // 进度打印（每 1.5s）+ 进度文件(2026-08-11 实时进度:引擎轮询读取)
    let d = done.clone();
    let dt = done_total.clone();
    let tt = total;
    let total_chunks = chunks;
    let label_owned = label.to_string();
    let pp = progress_path.map(|p| p.to_path_buf());
    let progress_task = tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
            let bytes = dt.load(Ordering::SeqCst);
            let pct = bytes as f64 / tt as f64 * 100.0;
            print!("\r{label_owned}: {:.1}% ({}/{})", pct, bytes, tt);
            use std::io::Write;
            std::io::stdout().flush().ok();
            if let Some(p) = pp.as_deref() {
                write_progress(p.to_str(), "download", &label_owned, bytes, tt);
            }
            if d.load(Ordering::SeqCst) >= total_chunks {
                break;
            }
        }
    });

    for t in tasks {
        let _ = t.await;
    }
    let _ = progress_task.await;
    println!();

    // 拼接分片
    let mut out = tokio::fs::File::create(dest).await.map_err(|e| ApiError(format!("创建输出失败: {e}")))?;
    let mut written: u64 = 0;
    for i in 0..chunks {
        let part_path = tmpdir.join(format!("{label}_part_{i}.tmp"));
        if !part_path.exists() {
            return Err(ApiError(format!("分片 {i} 下载失败（{label}），已保留部分分片在 {tmpdir:?}")));
        }
        // **拼接完整性校验(2026-08-11 修复"静默损坏")**:4 次重试后仍失败
        // 的分片可能留下**部分数据**(如 4MB 只下了 2MB),原实现直接拼接
        // → 输出"看似成功"的损坏文件(播放到缺口处花屏/中断)。断点续传
        // 跳过逻辑有大小校验,拼接这里必须同款校验,不匹配即报错(用户
        // 重新下载即可,不产出坏文件)
        let start = i * CHUNK;
        let end = ((i + 1) * CHUNK - 1).min(total - 1);
        let meta = tokio::fs::metadata(&part_path).await.map_err(|e| ApiError(format!("读取分片失败: {e}")))?;
        if meta.len() != end - start + 1 {
            return Err(ApiError(format!(
                "分片 {i} 不完整({}/{} 字节,下载中断),请重新下载",
                meta.len(),
                end - start + 1
            )));
        }
        let data = tokio::fs::read(&part_path).await.map_err(|e| ApiError(format!("读取分片失败: {e}")))?;
        out.write_all(&data).await.map_err(|e| ApiError(format!("拼接失败: {e}")))?;
        written += data.len() as u64;
        let _ = tokio::fs::remove_file(&part_path).await;
    }
    Ok(written)
}

async fn download_chunk(api: &BiliApi, url: &str, start: u64, end: u64, dest: &Path) -> Result<u64, ApiError> {
    let resp = api.get_bytes(url, Some((start, end))).await?;
    let mut f = tokio::fs::File::create(dest).await.map_err(|e| ApiError(format!("创建分片失败: {e}")))?;
    let mut n: u64 = 0;
    use futures::StreamExt;
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(ApiError::from)?;
        f.write_all(&chunk).await.map_err(|e| ApiError(format!("写分片失败: {e}")))?;
        n += chunk.len() as u64;
    }
    Ok(n)
}

/// ffmpeg 是否可用
pub fn ffmpeg_exists() -> bool {
    std::process::Command::new("ffmpeg")
        .arg("-version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn run_ffmpeg(args: &[&str]) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        return std::process::Command::new("ffmpeg")
            .args(args)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .creation_flags(0x08000000) // CREATE_NO_WINDOW：不弹出命令行窗口
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("ffmpeg")
            .args(args)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
}

/// 下载单个视频（含伴随文件）
pub async fn download_one(
    api: &BiliApi,
    bvid: &str,
    outdir: &Path,
    opts: &DownloadOptions,
    progress: Option<&(dyn Fn(&str) + Send + Sync)>,
) -> DownloadResult {
    let report = |title: String, path: Option<PathBuf>, files: Vec<PathBuf>, skipped: bool, error: Option<String>| DownloadResult {
        bvid: bvid.to_string(), title, path, files, skipped, error,
    };
    let log = |s: String| {
        if let Some(p) = progress {
            p(&s);
        }
    };

    let detail = match video::get_detail(api, bvid).await {
        Ok(d) => d,
        Err(e) => return report(String::new(), None, vec![], false, Some(e.to_string())),
    };
    let title = utils::sanitize_filename(&detail.title, 120);
    let date = utils::fmt_date(detail.pubdate);

    let main_ext = match &opts.audio_only {
        Some(f) => f.as_str(),
        None => "mp4",
    };
    let final_path = outdir.join(format!("{date}_{title}.{main_ext}"));
    if opts.skip && !opts.force && final_path.exists() {
        return report(detail.title.clone(), Some(final_path.clone()), vec![final_path], true, None);
    }

    let mut files: Vec<PathBuf> = Vec::new();
    let _ = std::fs::create_dir_all(outdir);
    if let Err(e) = std::fs::create_dir_all(outdir) {
        return report(detail.title.clone(), None, vec![], false, Some(format!("创建目录失败: {e}")));
    }

    // ---------------- 伴随文件
    if opts.danmaku && detail.cid > 0 {
        match crate::danmaku::fetch_danmaku(api, detail.cid, detail.duration).await {
            Ok(dms) if !dms.is_empty() => {
                for fmt in &opts.dm_fmt {
                    let text = match fmt.as_str() {
                        "xml" => crate::danmaku::to_xml(&dms),
                        "ass" => crate::danmaku::to_ass(&dms, 1920, 1080, 36),
                        "txt" => crate::danmaku::to_txt(&dms),
                        _ => crate::danmaku::to_json(&dms),
                    };
                    let p = outdir.join(format!("{date}_{title}.danmaku.{fmt}"));
                    if std::fs::write(&p, text).is_ok() {
                        files.push(p);
                    }
                }
                log(format!("弹幕 {} 条", dms.len()));
            }
            _ => {}
        }
    }
    if opts.subs {
        match video::get_subtitles(api, bvid, detail.cid).await {
            Ok(subs) if !subs.is_empty() => {
                for sub in subs {
                    if let Ok(segs) = video::download_subtitle_json(api, &sub.url).await {
                        if !segs.is_empty() {
                            let p = outdir.join(format!("{date}_{title}.{}.srt", sub.lan));
                            if std::fs::write(&p, video::subtitles_to_srt(&segs)).is_ok() {
                                files.push(p);
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }
    if opts.cover && !detail.pic.is_empty() {
        let mut pic = detail.pic.clone();
        if let Some(stripped) = pic.strip_prefix("//") {
            pic = format!("https:{stripped}");
        }
        if let Ok(resp) = api.get_bytes(&pic, None).await {
            if let Ok(bytes) = resp.bytes().await {
                let p = outdir.join(format!("{date}_{title}.jpg"));
                if std::fs::write(&p, &bytes).is_ok() {
                    files.push(p);
                }
            }
        }
    }

    // ---------------- 本体下载（支持分P）
    let pages: Vec<(i64, String, i64)> = if let Some(p) = opts.page {
        match detail.pages.get((p - 1).max(0) as usize) {
            Some(pg) => vec![(pg.cid, pg.title.clone(), pg.duration)],
            None => vec![(detail.cid, String::new(), detail.duration)],
        }
    } else if detail.pages.is_empty() {
        vec![(detail.cid, String::new(), detail.duration)]
    } else {
        detail.pages.iter().map(|p| (p.cid, p.title.clone(), p.duration)).collect()
    };
    let multi = pages.len() > 1;
    let p_ext = match &opts.audio_only {
        Some(f) => f.clone(),
        None => "mp4".to_string(),
    };
    let mut errors = Vec::new();
    for (i, (cid, ptitle, pdur)) in pages.iter().enumerate() {
        let suffix = if multi { format!("_P{}", i + 1) } else { String::new() };
        let name = if multi && !ptitle.is_empty() {
            format!("{date}_{title}{suffix}_{}", utils::sanitize_filename(ptitle, 60))
        } else {
            format!("{date}_{title}{suffix}")
        };
        let final_path = outdir.join(format!("{name}.{p_ext}"));
        if opts.skip && !opts.force && final_path.exists() {
            log(format!("分P {} 已存在，跳过", i + 1));
            files.push(final_path);
            continue;
        }
        log(format!("下载分P {}（{}s）...", i + 1, pdur));
        match download_page_body(api, bvid, *cid, outdir, &name, opts).await {
            Ok(p) => files.push(p),
            Err(e) => errors.push(format!("分P {}: {}", i + 1, e)),
        }
    }
    if files.is_empty() && !errors.is_empty() {
        return report(detail.title.clone(), None, files, false, Some(errors.join("; ")));
    }
    let main = files
        .iter()
        .find(|f| {
            f.extension()
                .map(|e| {
                    matches!(
                        e.to_str().unwrap_or(""),
                        "mp4" | "wav" | "mp3" | "flac" | "m4a" | "opus" | "aac"
                    )
                })
                .unwrap_or(false)
        })
        .cloned();
    report(
        detail.title.clone(),
        main,
        files,
        false,
        if errors.is_empty() { None } else { Some(errors.join("; ")) },
    )
}

/// 下载单个分P 的本体（playurl 直链 + 分片并发 + 转码/合并）
async fn download_page_body(
    api: &BiliApi,
    bvid: &str,
    cid: i64,
    outdir: &Path,
    name: &str,
    opts: &DownloadOptions,
) -> Result<PathBuf, String> {
    let tmpdir = outdir.join(format!(".tmp_{bvid}_{cid}"));
    let log = |m: String| println!("  {m}");
    // 实时进度(2026-08-11):下载开始阶段标记(percent 由 download_url 更新)
    write_progress(opts.progress_file.as_deref(), "download", "start", 0, 0);
    let playurl = video::get_playurl(api, bvid, cid).await.map_err(|e| e.to_string())?;
    let rate = rate_bytes(opts.rate.as_deref());
    let audio_stream = pick_audio_stream(&playurl.audio);
    let final_path: PathBuf;

    if let Some(audio_fmt) = &opts.audio_only {
        // ---------- 仅音频
        let Some(a_stream) = audio_stream else {
            return Err("未找到音频流".into());
        };
        log(format!("下载音频 ({} kbps) ...", a_stream.bandwidth / 1000));
        let src_audio = tmpdir.join("audio.m4a");
        if let Err(e) = download_url(api.clone(), &a_stream.base_url, &src_audio, &tmpdir, opts.parallel, rate, "audio", opts.progress_file.as_deref().map(std::path::Path::new)).await {
            let _ = std::fs::remove_dir_all(&tmpdir);
            return Err(format!("音频下载失败: {e}"));
        }
        if audio_fmt == "m4a" || audio_fmt == "aac" {
            final_path = outdir.join(format!("{name}.{audio_fmt}"));
            std::fs::rename(&src_audio, &final_path).ok();
        } else {
            // ffmpeg 转码
            if !ffmpeg_exists() {
                let _ = std::fs::remove_dir_all(&tmpdir);
                return Err("需要 ffmpeg 转码（未找到 ffmpeg，可用 --audio m4a 保留原始格式）".into());
            }
            final_path = outdir.join(format!("{name}.{audio_fmt}"));
            log(format!("转码为 {audio_fmt} ..."));
            let ok = run_ffmpeg(&["-y", "-i", src_audio.to_str().unwrap(), "-vn", "-ac", "2", final_path.to_str().unwrap()]);
            let _ = std::fs::remove_file(&src_audio);
            if !ok {
                let _ = std::fs::remove_dir_all(&tmpdir);
                return Err("ffmpeg 转码失败".into());
            }
        }
    } else {
        // ---------- 视频模式
        if !playurl.durl.is_empty() {
            // 非 dash 单文件（少见，未登录低清兜底）
            final_path = outdir.join(format!("{name}.mp4"));
            log("下载视频（单文件模式）...".into());
            if let Err(e) = download_url(api.clone(), &playurl.durl[0].base_url, &final_path, &tmpdir, opts.parallel, rate, "video", opts.progress_file.as_deref().map(std::path::Path::new)).await {
                let _ = std::fs::remove_dir_all(&tmpdir);
                return Err(format!("视频下载失败: {e}"));
            }
        } else {
            let Some(v_stream) = pick_video_stream(&playurl.video, &opts.quality) else {
                return Err("未找到视频流".into());
            };
            let Some(a_stream) = audio_stream else {
                return Err("未找到音频流".into());
            };
            log(format!("下载视频 {}p ({} kbps) + 音频 ...", v_stream.height, v_stream.bandwidth / 1000));
            let src_v = tmpdir.join("video.m4v");
            let src_a = tmpdir.join("audio.m4a");
            let (rv, ra) = tokio::join!(
                download_url(api.clone(), &v_stream.base_url, &src_v, &tmpdir, opts.parallel, rate, "video", opts.progress_file.as_deref().map(std::path::Path::new)),
                download_url(api.clone(), &a_stream.base_url, &src_a, &tmpdir, opts.parallel, rate, "audio", opts.progress_file.as_deref().map(std::path::Path::new)),
            );
            match (rv, ra) {
                (Ok(_), Ok(_)) => {}
                (Err(e), _) | (_, Err(e)) => {
                    let _ = std::fs::remove_dir_all(&tmpdir);
                    return Err(format!("下载失败: {e}"));
                }
            }
            if !ffmpeg_exists() {
                let _ = std::fs::remove_dir_all(&tmpdir);
                return Err("需要 ffmpeg 合并音视频（未找到 ffmpeg）".into());
            }
            final_path = outdir.join(format!("{name}.mp4"));
            // 编码策略(2026-08-11):codec=auto 且视频流是 HEVC/AV1 →
            // 转码 H.264(挂件窗口:HEVC 在禁用硬件加速下零帧全黑、AV1
            // 只能软件解码 4K 掉帧——ffmpeg libx264 veryfast 实测
            // ~17x 实时,大文件几分钟内完成,保留画质)
            let codecs_lc = v_stream.codecs.to_lowercase();
            let needs_transcode = codecs_lc.starts_with("hev") || codecs_lc.starts_with("av01");
            let transcode = opts.codec != "copy" && needs_transcode;
            write_progress(opts.progress_file.as_deref(), if transcode { "transcode" } else { "mux" }, "video", 0, 0);
            if transcode {
                log("视频为 HEVC/AV1 编码,转码为 H.264(挂件窗口可直接播放,需几分钟)...".into());
            } else {
                log("合并音视频 ...".into());
            }
            let mut args: Vec<String> = vec![
                "-y".into(),
                "-i".into(), src_v.to_str().unwrap().to_string(),
                "-i".into(), src_a.to_str().unwrap().to_string(),
            ];
            if transcode {
                args.extend(["-c:v".into(), "libx264".into(), "-preset".into(), "veryfast".into(), "-crf".into(), "23".into(), "-c:a".into(), "copy".into()]);
            } else {
                args.extend(["-c".into(), "copy".into()]);
            }
            args.extend(["-movflags".into(), "+faststart".into(), final_path.to_str().unwrap().to_string()]);
            let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
            let ok = run_ffmpeg(&arg_refs);
            let _ = std::fs::remove_file(&src_v);
            let _ = std::fs::remove_file(&src_a);
            if !ok {
                let _ = std::fs::remove_dir_all(&tmpdir);
                return Err("ffmpeg 合并失败".into());
            }
        }
    }
    let _ = std::fs::remove_dir_all(&tmpdir);
    write_progress(opts.progress_file.as_deref(), "done", "video", 100, 100);
    Ok(final_path)
}


// ================================================================
// 编码探测与就地转码(2026-08-11,convert 子命令:把已有 HEVC 视频转成
// H.264——挂件对话窗口在禁用硬件加速下无法呈现 HEVC 帧(全黑),转码后
// 窗口内直接可播;ffprobe 不是依赖(只有 ffmpeg),用 ffmpeg -i 的 stderr
// 探测编码)
// ================================================================

/// 用 ffmpeg -i 探测视频流编码(返回 "hevc"/"h264"/"av1"...;失败 None)
pub fn probe_video_codec(path: &str) -> Option<String> {
    #[cfg(windows)]
    let output = {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("ffmpeg")
            .arg("-i").arg(path)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .output().ok()?
    };
    #[cfg(not(windows))]
    let output = {
        std::process::Command::new("ffmpeg")
            .arg("-i").arg(path)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .output().ok()?
    };
    let err = String::from_utf8_lossy(&output.stderr);
    // "  Stream #0:0[0x1](und): Video: hevc (Main) (hev1 / 0x31766568), ..."
    for line in err.lines() {
        let t = line.trim();
        if t.contains("Video: ") && !t.contains("attached pic") {
            let rest = &t[t.find("Video: ").unwrap() + 7..];
            let codec = rest.split([' ', ',', '(', ')']).next().unwrap_or("").to_string();
            if !codec.is_empty() {
                return Some(codec);
            }
        }
    }
    None
}

/// 就地转码 HEVC → H.264(先写临时文件,成功后再替换原文件;非 HEVC 跳过)。
/// 返回 (是否已转码, 说明文本)
pub fn convert_to_h264(path: &str) -> Result<(bool, String), String> {
    if !ffmpeg_exists() {
        return Err("需要 ffmpeg(未找到 ffmpeg)".into());
    }
    let p = std::path::Path::new(path);
    if !p.is_file() {
        return Err(format!("文件不存在: {path}"));
    }
    // **磁盘空间预检(2026-08-11)**:输出 H.264 体积 ≈ 源文件(veryfast
    // crf 23 实测相近),预留 1.2 倍;空间不足提前报错,避免转码到一半
    // 失败留下半截临时文件(用户实测大视频转码失败的常见原因)
    if let Some(free) = free_disk_bytes(p) {
        let need = std::fs::metadata(p).map(|m| m.len() as f64 * 1.2).unwrap_or(0.0) as u64;
        if free < need {
            return Err(format!("磁盘空间不足(可用 {}/{} 字节,预计需要 {}),请清理磁盘后重试", free, fmt_bytes(free), fmt_bytes(need)));
        }
    }
    let codec = match probe_video_codec(path) {
        Some(c) => c,
        None => return Err(format!("无法识别视频编码: {path}")),
    };
    if codec != "hevc" {
        return Ok((false, format!("已是 {codec} 编码,无需转换")));
    }
    let tmp = p.with_extension("tmp_h264.mp4");
    let ok = run_ffmpeg(&[
        "-y", "-i", path,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
        "-c:a", "copy", "-movflags", "+faststart",
        tmp.to_str().unwrap(),
    ]);
    if !ok {
        let _ = std::fs::remove_file(&tmp);
        return Err("转码失败(可检查磁盘空间/文件是否被占用)".into());
    }
    let _ = std::fs::remove_file(path);
    std::fs::rename(&tmp, p).map_err(|e| format!("替换原文件失败: {e}"))?;
    Ok((true, format!("HEVC → H.264 转码完成: {path}")))
}

/// 路径所在磁盘的可用字节数(2026-08-11 转码预检;Windows 用
/// GetDiskFreeSpaceExW,非 Windows 返回 None 跳过检查)
fn free_disk_bytes(p: &std::path::Path) -> Option<u64> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
        let root: Vec<u16> = p
            .ancestors()
            .filter_map(|a| a.to_str())
            .find(|s| s.len() >= 2 && s.as_bytes()[1] == b':')
            .map(|s| format!("{}\\", &s[..2]))
            .unwrap_or_else(|| "C:\\".to_string())
            .encode_utf16()
            .collect();
        let mut free: u64 = 0;
        let mut total: u64 = 0;
        let mut free_total: u64 = 0;
        let ok = unsafe {
            GetDiskFreeSpaceExW(
                root.as_ptr(),
                &mut free,
                &mut total,
                &mut free_total,
            )
        };
        if ok != 0 { Some(free) } else { None }
    }
    #[cfg(not(windows))]
    {
        let _ = p;
        None
    }
}

/// 人类可读字节数(MB/GB)
fn fmt_bytes(n: u64) -> String {
    if n >= 1024 * 1024 * 1024 {
        format!("{:.1}GB", n as f64 / 1024.0 / 1024.0 / 1024.0)
    } else {
        format!("{:.1}MB", n as f64 / 1024.0 / 1024.0)
    }
}
