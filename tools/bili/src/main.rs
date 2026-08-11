#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
//! bili-tool (Rust)：B站爬取工具——UP视频批量下载/弹幕/字幕/评论/搜索/订阅/登录。
//! 纯 Rust 实现，单二进制；唯一外部依赖 ffmpeg（转码/合并）。

mod api;
mod config;
mod danmaku;
mod download;
mod login;
mod search;
mod serve;
mod store;
mod user;
mod utils;
mod video;

use std::path::PathBuf;
use std::sync::Arc;

use clap::{Parser, Subcommand};
use serde_json::Value;

use api::BiliApi;
use download::DownloadOptions;

fn base_dir() -> PathBuf {
    // 环境变量 BILI_BASE_DIR 覆盖(2026-08-07 随挂件打包发行:exe 在
    // 安装目录(只读),cookies.json/配置写不进——引擎 spawn 时注入
    // userData/bili,登录态/配置落到可写目录;下载 outdir 相对 cwd 同理)
    if let Ok(d) = std::env::var("BILI_BASE_DIR") {
        let t = d.trim();
        if !t.is_empty() {
            return PathBuf::from(t);
        }
    }
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
}

fn init() {
    #[cfg(windows)]
    unsafe {
        // 终端 UTF-8 输出（Windows）
        windows_sys::Win32::System::Console::SetConsoleOutputCP(65001);
    }
}

/// Windows 弹窗提示错误（release 版无控制台，双击运行时错误必须可见）
#[cfg(all(windows, not(debug_assertions)))]
fn show_error(msg: &str) {
    use windows_sys::Win32::UI::WindowsAndMessaging::*;
    let title: Vec<u16> = "bili-tool".encode_utf16().chain(std::iter::once(0)).collect();
    let text: Vec<u16> = format!("错误: {msg}").encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        MessageBoxW(std::ptr::null_mut(), text.as_ptr(), title.as_ptr(), MB_OK | MB_ICONERROR);
    }
}

#[cfg(not(all(windows, not(debug_assertions))))]
fn show_error(_msg: &str) {}

// ================================================================ CLI 定义

#[derive(Parser)]
#[command(name = "bili-tool", version = "1.0.0", about = "B站爬取工具：UP视频批量下载/弹幕/字幕/评论/搜索/订阅/登录")]
struct Cli {
    /// 不指定子命令时默认启动 Web 界面（serve），方便双击 exe 直接使用
    #[command(subcommand)]
    cmd: Option<Cmd>,
}

#[derive(Subcommand)]
enum Cmd {
    /// 查看 UP 主信息（mid 或 space 链接）
    Info {
        mid: String,
        /// 输出 JSON 到 stdout（供外部工具程序化调用）
        #[arg(long)] json: bool,
    },
    /// 列出 UP 主全部视频（时间/正则过滤）
    List {
        mid: String,
        #[arg(long)] since: Option<String>,
        #[arg(long)] until: Option<String>,
        #[arg(long)] days: Option<i64>,
        #[arg(long)] regex: Option<String>,
        #[arg(long)] exclude: Option<String>,
        #[arg(long)] limit: Option<i64>,
        #[arg(long)] json: bool,
        #[arg(long)] csv: bool,
        #[arg(long)] md: bool,
        #[arg(long)] out: Option<String>,
    },
    /// 批量下载一个或多个 UP 主视频
    Download {
        #[arg(required = true)] mid: Vec<String>,
        #[arg(long)] since: Option<String>,
        #[arg(long)] until: Option<String>,
        #[arg(long)] days: Option<i64>,
        #[arg(long)] regex: Option<String>,
        #[arg(long)] exclude: Option<String>,
        #[arg(long)] latest: Option<i64>,
        #[arg(long)] limit: Option<i64>,
        #[arg(long)] new_only: bool,
        #[arg(long)] audio: Option<String>,
        #[arg(long)] quality: Option<String>,
        #[arg(long)] codec: Option<String>,
        #[arg(long)] progress_file: Option<String>,
        #[arg(long)] jobs: Option<i64>,
        #[arg(long)] parallel: Option<i64>,
        #[arg(long)] rate: Option<String>,
        #[arg(long)] page: Option<i64>,
        #[arg(long)] outdir: Option<String>,
        #[arg(long)] no_danmaku: bool,
        #[arg(long)] dm_fmt: Option<String>,
        #[arg(long)] subs: bool,
        #[arg(long)] no_cover: bool,
        #[arg(long)] force: bool,
        #[arg(long)] no_skip: bool,
        #[arg(long)] dry_run: bool,
    },
    /// 下载单个/多个视频（BV 号或链接）
    Get {
        #[arg(required = true)] bvid: Vec<String>,
        #[arg(long)] audio: Option<String>,
        #[arg(long)] quality: Option<String>,
        #[arg(long)] codec: Option<String>,
        #[arg(long)] progress_file: Option<String>,
        #[arg(long)] page: Option<i64>,
        #[arg(long)] outdir: Option<String>,
        #[arg(long)] no_danmaku: bool,
        #[arg(long)] dm_fmt: Option<String>,
        #[arg(long)] subs: bool,
        #[arg(long)] no_cover: bool,
        #[arg(long)] force: bool,
        #[arg(long)] no_skip: bool,
        #[arg(long)] info: bool,
        #[arg(long)] json: bool,
    },
    /// 下载视频弹幕（XML/ASS/TXT/JSON）
    Danmaku {
        bvid: String,
        #[arg(long)] fmt: Option<String>,
        #[arg(long)] out: Option<String>,
    },
    /// 下载 CC 字幕（srt）
    Subtitle { bvid: String, #[arg(long)] out: Option<String> },
    /// 爬取视频评论区
    Comments {
        bvid: String,
        #[arg(long)] pages: Option<i64>,
        #[arg(long)] json: bool,
        #[arg(long)] csv: bool,
        #[arg(long)] out: Option<String>,
    },
    /// 搜索视频/用户/番剧
    Search {
        keyword: String,
        #[arg(long, default_value = "video")] r#type: String,
        #[arg(long)] pages: Option<i64>,
        #[arg(long, default_value = "totalrank")] order: String,
        /// 输出 JSON 到 stdout(供外部工具程序化调用)
        #[arg(long)] json: bool,
    },
    /// 查看 B 站热门榜
    Trending {
        #[arg(long, default_value_t = 0)] rid: i64,
        /// 输出 JSON 到 stdout(供外部工具程序化调用)
        #[arg(long)] json: bool,
    },
    /// 查看/下载 UP 主合集
    Season {
        mid: String,
        #[arg(long)] list: bool,
        #[arg(long)] download: Option<String>,
        #[arg(long)] audio: Option<String>,
        #[arg(long)] outdir: Option<String>,
        #[arg(long)] dry_run: bool,
    },
    /// 收藏夹：列出（需登录）/ 下载
    Fav {
        uid: String,
        #[arg(long)] list: bool,
        #[arg(long)] download: Option<String>,
        #[arg(long)] audio: Option<String>,
        #[arg(long)] outdir: Option<String>,
        #[arg(long)] dry_run: bool,
    },
    /// 扫码登录
    Login {
        #[arg(long, default_value_t = 120)]
        timeout: i64,
        /// 二维码保存为 PNG 图片(对话内扫码登录:Agent 生成图片给用户扫)
        #[arg(long)]
        qrcode_img: Option<String>,
        /// 仅生成二维码不等待(扫码后另跑 bili-tool whoami 确认)
        #[arg(long)]
        no_wait: bool,
    },
    /// 退出登录
    Logout,
    /// 查看登录状态
    Whoami,
    /// UP 订阅监控
    Subscribe {
        #[command(subcommand)]
        sub: SubCmd,
    },
    /// 一键更新：检查所有订阅并下载新视频
    Update {
        #[arg(long)] audio: Option<String>,
        #[arg(long)] outdir: Option<String>,
        #[arg(long)] dry_run: bool,
    },
    /// 查看/设置默认参数
    Config {
        /// --set KEY VALUE 设置一项默认配置(quality/codec/outdir 等)
        #[arg(long, num_args = 2)] set: Option<Vec<String>>,
        #[arg(long)] reset: bool,
    },
    /// 查看操作历史
    History { #[arg(long)] limit: Option<i64> },
    /// 查看已下载记录(--clear 清空记录,不删文件)
    Saved {
        #[arg(long)] limit: Option<i64>,
        #[arg(long)] clear: bool,
    },
    /// 把已有 HEVC(H.265)视频就地转码为 H.264(挂件对话窗口直接可播)
    Convert {
        #[arg(required = true)] paths: Vec<String>,
    },
    /// 启动 Web 图形界面（浏览器访问 http://127.0.0.1:8787）
    Serve { #[arg(long, default_value_t = 8787)] port: u16 },
}

#[derive(Subcommand)]
enum SubCmd {
    /// 订阅 UP 主
    Add { mid: String },
    /// 列出所有订阅
    List,
    /// 取消订阅
    Remove { mid: String },
    /// 检查订阅的新视频
    Check {
        #[arg(long)] download: bool,
        #[arg(long)] audio: Option<String>,
        #[arg(long)] outdir: Option<String>,
        #[arg(long)] limit: Option<i64>,
    },
}

// ================================================================ 工具函数

fn parse_mid(text: &str) -> Result<String, String> {
    let t = text.trim();
    if t.chars().all(|c| c.is_ascii_digit()) {
        return Ok(t.to_string());
    }
    let re = regex::Regex::new(r"space\.bilibili\.com/(\d+)").unwrap();
    if let Some(cap) = re.captures(t) {
        return Ok(cap[1].to_string());
    }
    Err(format!("无法从 {text:?} 解析出 UP 主 mid"))
}

fn parse_bvid(text: &str) -> Option<String> {
    let re = regex::Regex::new(r"BV[0-9A-Za-z]{10}").unwrap();
    re.find(text).map(|m| m.as_str().to_string())
}

fn resolve_audio(audio: Option<&str>, cfg: &config::Config) -> Option<String> {
    if let Some(a) = audio {
        if a.is_empty() {
            return None;
        }
        return Some(a.to_string());
    }
    cfg.get_audio()
}

fn build_opts(
    cfg: &config::Config,
    audio: Option<&str>,
    quality: Option<&str>,
    codec: Option<&str>,
    progress_file: Option<&str>,
    parallel: Option<i64>,
    rate: Option<&str>,
    no_danmaku: bool,
    dm_fmt: Option<&str>,
    subs: bool,
    no_cover: bool,
    force: bool,
    no_skip: bool,
    page: Option<i64>,
) -> DownloadOptions {
    let quality = quality.unwrap_or("best").to_string();
    let fmt = dm_fmt.unwrap_or(&cfg.get_str("dm_fmt", "xml")).to_string();
    // 编码策略:auto(HEVC 自动转 H.264)/ copy(保留原编码);配置可设
    let codec = match codec {
        Some(c) if c == "auto" || c == "copy" => c.to_string(),
        Some(c) => {
            eprintln!("忽略未知 codec {c}(auto/copy)");
            "auto".to_string()
        }
        None => cfg.get_str("codec", "auto"),
    };
    DownloadOptions {
        quality: quality.clone(),
        audio_only: resolve_audio(audio, cfg),
        parallel: parallel.unwrap_or_else(|| cfg.get_int("parallel", 8)) as usize,
        rate: rate.map(|s| s.to_string()).or_else(|| {
            let r = cfg.get_str("rate", "");
            if r.is_empty() { None } else { Some(r) }
        }),
        danmaku: !no_danmaku && cfg.get_bool("danmaku", true),
        dm_fmt: fmt.split(',').map(|s| s.trim().to_string()).collect(),
        subs,
        cover: !no_cover && cfg.get_bool("cover", true),
        force,
        skip: !no_skip,
        page,
        codec,
        progress_file: progress_file.map(|s| s.to_string()),
    }
}

fn fmt_size(n: u64) -> String {
    utils::fmt_size(n)
}

// ================================================================ 命令实现

async fn cmd_info(api: &BiliApi, mid: &str, as_json: bool) -> Result<(), String> {
    let mid = parse_mid(mid)?;
    let info = user::get_user_info(api, &mid).await.map_err(|e| e.to_string())?;
    if as_json {
        println!("{}", serde_json::json!({
            "mid": mid,
            "name": info.name,
            "level": info.level,
            "sex": info.sex,
            "sign": info.sign,
            "official": info.official,
            "fans": info.fans,
            "following": info.following,
            "archives": info.archives,
            "likes": info.likes,
        }));
        return Ok(());
    }
    println!("UP: {}  (mid={})", info.name, mid);
    println!("  等级 {} | {} | 简介: {}", info.level, info.sex, info.sign);
    if !info.official.is_empty() {
        println!("  认证: {}", info.official);
    }
    println!("  粉丝: {} | 关注: {} | 投稿: {} | 获赞: {}", info.fans, info.following, info.archives, info.likes);
    Ok(())
}

fn filter_videos(videos: &[user::Video], since: Option<&str>, until: Option<&str>, days: Option<i64>,
                 regex: Option<&str>, exclude: Option<&str>) -> Vec<user::Video> {
    let t0 = since.and_then(utils::parse_date);
    let t0 = days.map(|d| utils::now_ts() - d * 86400).or(t0);
    let t1 = until.and_then(|u| utils::parse_date(&format!("{u} 23:59:59")));
    let rx = regex.map(|r| regex::Regex::new(r).unwrap());
    let exx = exclude.map(|r| regex::Regex::new(r).unwrap());
    let mut out: Vec<user::Video> = videos
        .iter()
        .filter(|v| t0.map(|t| v.ctime >= t).unwrap_or(true))
        .filter(|v| t1.map(|t| v.ctime <= t).unwrap_or(true))
        .filter(|v| rx.as_ref().map(|r| r.is_match(&v.title)).unwrap_or(true))
        .filter(|v| exx.as_ref().map(|r| !r.is_match(&v.title)).unwrap_or(true))
        .cloned()
        .collect();
    out.sort_by_key(|v| v.ctime);
    out
}

async fn cmd_list(api: &BiliApi, mid: &str, since: Option<&str>, until: Option<&str>, days: Option<i64>,
                  regex: Option<&str>, exclude: Option<&str>, limit: Option<i64>, as_json: bool,
                  as_csv: bool, as_md: bool, out: Option<&str>) -> Result<(), String> {
    let mid = parse_mid(mid)?;
    let t0 = since.and_then(utils::parse_date);
    let t0 = days.map(|d| utils::now_ts() - d * 86400).or(t0);
    let videos = user::get_videos(api, &mid, t0).await.map_err(|e| e.to_string())?;
    let rows = filter_videos(&videos, since, until, days, regex, exclude);
    let rows: Vec<&user::Video> = match limit {
        Some(l) if l > 0 && t0.is_none() => rows.iter().rev().take(l as usize).rev().collect(),
        Some(l) if l > 0 => rows.iter().take(l as usize).collect(),
        _ => rows.iter().collect(),
    };
    if as_json {
        // 程序化调用:JSON 直接输出到 stdout(不写文件、不打表格)
        let arr: Vec<Value> = rows.iter().map(|v| serde_json::json!({
            "bvid": v.bvid, "title": v.title, "ctime": v.ctime, "duration": v.duration,
            "play": v.play, "danmaku": v.danmaku, "comment": v.comment, "tname": v.tname,
        })).collect();
        println!("{}", serde_json::to_string(&arr).unwrap());
        return Ok(());
    }
    if rows.is_empty() {
        println!("（无匹配视频）");
        return Ok(());
    }
    println!("共 {} 个视频 (UP mid={})", rows.len(), mid);
    println!("{:<5} {:<15} {:<18} {:<6} {:<10} {}", "序号", "BVID", "发布时间", "时长", "播放", "标题");
    for (i, v) in rows.iter().enumerate() {
        let title: String = v.title.chars().take(46).collect();
        println!("{:<5} {:<15} {:<18} {:<6} {:<10} {}", i + 1, v.bvid,
                 utils::fmt_time(v.ctime, "%Y-%m-%d %H:%M"),
                 utils::fmt_duration(v.duration), v.play, title);
    }
    // 导出
    if as_json || as_csv || as_md {
        let _ = std::fs::create_dir_all("downloads");
        let base = out.map(|o| PathBuf::from(o))
            .unwrap_or_else(|| PathBuf::from(format!("downloads/list_{mid}")));
        if as_csv {
            let mut csv = String::from("bvid,title,pubdate,duration,play,danmaku,tname
");
            for v in &rows {
                csv.push_str(&format!("{},{},{},{},{},{},{}
", v.bvid, v.title,
                             utils::fmt_time(v.ctime, "%Y-%m-%d %H:%M"), v.duration,
                             v.play, v.danmaku, v.tname));
            }
            let _ = std::fs::write(base.with_extension("csv"), csv);
            println!("已导出 CSV: {}.csv", base.display());
        }
        if as_md {
            let mut md = format!("# UP {mid} 视频列表（{} 个）

", rows.len());
            md.push_str("| 序号 | BVID | 发布时间 | 时长 | 播放 | 标题 |
");
            md.push_str("|---|---|---|---|---|---|
");
            for (i, v) in rows.iter().enumerate() {
                md.push_str(&format!("| {} | {} | {} | {} | {} | {} |
", i + 1, v.bvid,
                             utils::fmt_time(v.ctime, "%Y-%m-%d %H:%M"),
                             utils::fmt_duration(v.duration), v.play, v.title));
            }
            let _ = std::fs::write(base.with_extension("md"), md);
            println!("已导出 Markdown: {}.md", base.display());
        }
    }
    Ok(())
}

async fn batch_download(api: &BiliApi, bvids: &[String], outdir: &PathBuf, up_name: Option<&str>,
                        opts: &DownloadOptions, jobs: usize) -> (i64, i64, i64) {
    let target = match up_name {
        Some(n) if !n.is_empty() => outdir.join(utils::sanitize_filename(n, 60)),
        _ => outdir.clone(),
    };
    let _ = std::fs::create_dir_all(&target);
    let mut ok = 0;
    let mut skipped = 0;
    let mut fail = 0;
    let total = bvids.len();
    let mut idx = 0usize;
    let mut handles = tokio::task::JoinSet::new();
    let api_arc = Arc::new(api.clone());

    while idx < total {
        while handles.len() < jobs.max(1) && idx < total {
            let b = bvids[idx].clone();
            let api2 = api_arc.clone();
            let outdir2 = target.clone();
            let opts2 = opts.clone();
            handles.spawn(async move {
                download::download_one(&api2, &b, &outdir2, &opts2, None).await
            });
            idx += 1;
        }
        while let Some(res) = handles.join_next().await {
            let r = res.unwrap_or_else(|_| download::DownloadResult {
                bvid: "?".into(), title: String::new(), path: None, files: vec![], skipped: false,
                error: Some("任务异常".into()),
            });
            let done_count = idx;
            if r.skipped {
                skipped += 1;
                let name = r.path.as_ref().and_then(|p| p.file_name()).map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                println!("[{}/{}] = {} 已存在，跳过 {}", done_count, total, r.bvid, name);
            } else if let Some(e) = &r.error {
                fail += 1;
                println!("[{}/{}] ✗ {}: {}", done_count, total, r.bvid, e);
            } else {
                ok += 1;
                let extra = if opts.audio_only.is_some() { format!(" [音频 {}]", opts.audio_only.as_ref().unwrap()) } else { String::new() };
                let name = r.path.as_ref().map(|p| p.display().to_string()).unwrap_or_default();
                println!("[{}/{}] ✓ {}{} -> {}", done_count, total, r.title, extra, name);
            }
            // 记录历史
            if r.error.is_none() && r.path.is_some() {
                if let Ok(d) = video::get_detail(&api_arc, &r.bvid).await {
                    let size = std::fs::metadata(r.path.as_ref().unwrap()).map(|m| m.len()).unwrap_or(0);
                    let mut st = store();
                    st.record_download(&r.bvid, d.aid, &r.title, &d.up, d.up_mid, d.pubdate,
                                       d.duration, &r.path.as_ref().unwrap().display().to_string(),
                                       size, &opts.quality, opts.audio_only.is_some());
                    st.log("download", &r.bvid, &r.path.as_ref().unwrap().display().to_string());
                }
            }
        }
    }
    println!("完成: 成功 {ok} / 跳过 {skipped} / 失败 {fail}");
    (ok, skipped, fail)
}

static STORE: std::sync::OnceLock<std::sync::Mutex<store::Store>> = std::sync::OnceLock::new();

fn store() -> std::sync::MutexGuard<'static, store::Store> {
    let dir = base_dir();
    let m = STORE.get_or_init(|| {
        std::sync::Mutex::new(store::Store::new(dir.join("config").join("store.json")))
    });
    m.lock().unwrap()
}

async fn cmd_download(api: &BiliApi, mids: &[String], since: Option<&str>, until: Option<&str>,
                      days: Option<i64>, regex: Option<&str>, exclude: Option<&str>,
                      latest: Option<i64>, limit: Option<i64>, new_only: bool, audio: Option<&str>,
                      quality: Option<&str>, codec: Option<&str>, progress_file: Option<&str>, jobs: Option<i64>, parallel: Option<i64>,
                      rate: Option<&str>, page: Option<i64>, outdir: Option<&str>, no_danmaku: bool,
                      dm_fmt: Option<&str>, subs: bool, no_cover: bool, force: bool, no_skip: bool,
                      dry_run: bool) -> Result<(), String> {
    let cfg = config::Config::new(base_dir().join("config").join("config.json"));
    let outdir = PathBuf::from(outdir.unwrap_or(&cfg.get_str("outdir", "downloads")));
    let opts = build_opts(&cfg, audio, quality, codec, None, parallel, rate, no_danmaku, dm_fmt, subs, no_cover, force, no_skip, page);
    let jobs = jobs.unwrap_or_else(|| cfg.get_int("jobs", 2)) as usize;
    let t0 = since.and_then(utils::parse_date);
    let t0 = days.map(|d| utils::now_ts() - d * 86400).or(t0);

    for mid_str in mids {
        let mid = match parse_mid(mid_str) {
            Ok(m) => m,
            Err(e) => {
                println!("✗ UP {}: {e}", mid_str);
                continue;
            }
        };
        let info = match user::get_user_info(api, &mid).await {
            Ok(i) => i,
            Err(e) => {
                println!("✗ UP {} 拉取失败: {}", mid_str, e);
                continue;
            }
        };
        let videos = match user::get_videos(api, &mid, t0).await {
            Ok(v) => v,
            Err(e) => {
                println!("✗ UP {} 拉取失败: {}", mid_str, e);
                continue;
            }
        };
        let mut rows = filter_videos(&videos, since, until, days, regex, exclude);
        if latest.is_some() || limit.is_some() {
            let n = latest.or(limit).unwrap_or(0) as usize;
            if n > 0 {
                let len = rows.len();
                rows = if t0.is_some() { rows.into_iter().take(n).collect() } else { rows.into_iter().skip(len.saturating_sub(n)).collect() };
            }
        }
        if new_only {
            rows.retain(|v| store().is_downloaded(&v.bvid).is_none());
        }
        if rows.is_empty() {
            println!("UP {}：无匹配视频", info.name);
            continue;
        }
        println!("UP {}：匹配 {} 个视频", info.name, rows.len());
        if dry_run {
            for v in &rows {
                println!("  将下载 {} | {} | {}", v.bvid, utils::fmt_time(v.ctime, "%Y-%m-%d"), v.title);
            }
            println!("共 {} 个（dry-run，未下载）", rows.len());
            continue;
        }
        let bvids: Vec<String> = rows.iter().map(|v| v.bvid.clone()).collect();
        batch_download(api, &bvids, &outdir, Some(&info.name), &opts, jobs).await;
    }
    Ok(())
}

async fn cmd_get(api: &BiliApi, bvids: &[String], audio: Option<&str>, quality: Option<&str>,
                 codec: Option<&str>, progress_file: Option<&str>, page: Option<i64>, outdir: Option<&str>, no_danmaku: bool, dm_fmt: Option<&str>,
                 subs: bool, no_cover: bool, force: bool, no_skip: bool, only_info: bool,
                 as_json: bool) -> Result<(), String> {
    let cfg = config::Config::new(base_dir().join("config").join("config.json"));
    let outdir = PathBuf::from(outdir.unwrap_or(&cfg.get_str("outdir", "downloads")));
    let opts = build_opts(&cfg, audio, quality, codec, progress_file, None, None, no_danmaku, dm_fmt, subs, no_cover, force, no_skip, page);
    for b in bvids {
        let Some(bv) = parse_bvid(b) else {
            println!("✗ 无法解析 BVID: {b}");
            continue;
        };
        let detail = match video::get_detail(api, &bv).await {
            Ok(d) => d,
            Err(e) => {
                println!("✗ {bv}: {e}");
                continue;
            }
        };
        if as_json {
            let p = outdir.join(format!("{bv}_info.json"));
            let _ = std::fs::create_dir_all(&outdir);
            let _ = std::fs::write(&p, serde_json::to_string_pretty(&detail.to_json()).unwrap());
            println!("✓ 详情已导出: {}", p.display());
            continue;
        }
        if only_info {
            println!("{} | {} | {} | 播放 {} 弹幕 {} 点赞 {} | UP {} | 分P {}",
                     bv, detail.title, utils::fmt_time(detail.pubdate, "%Y-%m-%d %H:%M"),
                     detail.view, detail.danmaku, detail.like, detail.up, detail.pages.len());
            continue;
        }
        let r = download::download_one(api, &bv, &outdir, &opts, None).await;
        if r.skipped {
            println!("= {bv} 已存在，跳过");
        } else if let Some(e) = &r.error {
            println!("✗ {bv}: {e}");
        } else {
            println!("✓ {} -> {}", r.title, r.path.as_ref().map(|p| p.display().to_string()).unwrap_or_default());
            if let Some(p) = &r.path {
                let size = std::fs::metadata(p).map(|m| m.len()).unwrap_or(0);
                let mut st = store();
                st.record_download(&bv, detail.aid, &r.title, &detail.up, detail.up_mid, detail.pubdate,
                                   detail.duration, &p.display().to_string(), size, &opts.quality,
                                   opts.audio_only.is_some());
                st.log("download", &bv, &p.display().to_string());
            }
        }
    }
    Ok(())
}

async fn cmd_danmaku(api: &BiliApi, bvid: &str, fmt: Option<&str>, out: Option<&str>) -> Result<(), String> {
    let Some(bv) = parse_bvid(bvid) else { return Err(format!("无法解析 BVID: {bvid}")) };
    let detail = video::get_detail(api, &bv).await.map_err(|e| e.to_string())?;
    println!("抓取 {bv}《{}》弹幕...", detail.title);
    let dms = danmaku::fetch_danmaku(api, detail.cid, detail.duration).await.map_err(|e| e.to_string())?;
    if dms.is_empty() {
        println!("（无弹幕）");
        return Ok(());
    }
    let outdir = PathBuf::from(out.unwrap_or("downloads/弹幕"));
    let _ = std::fs::create_dir_all(&outdir);
    let title = utils::sanitize_filename(&detail.title, 120);
    let fmts = fmt.unwrap_or("xml");
    for f in fmts.split(',') {
        let f = f.trim();
        let text = match f {
            "xml" => danmaku::to_xml(&dms),
            "ass" => danmaku::to_ass(&dms, 1920, 1080, 36),
            "txt" => danmaku::to_txt(&dms),
            "json" => danmaku::to_json(&dms),
            _ => {
                println!("忽略未知格式 {f}");
                continue;
            }
        };
        let p = outdir.join(format!("{title}.{f}"));
        if std::fs::write(&p, text).is_ok() {
            println!("✓ {} 条弹幕 -> {} ({})", dms.len(), p.display(), fmt_size(std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0)));
        }
    }
    Ok(())
}

async fn cmd_subtitle(api: &BiliApi, bvid: &str, out: Option<&str>) -> Result<(), String> {
    let Some(bv) = parse_bvid(bvid) else { return Err(format!("无法解析 BVID: {bvid}")) };
    let detail = video::get_detail(api, &bv).await.map_err(|e| e.to_string())?;
    let subs = video::get_subtitles(api, &bv, detail.cid).await.map_err(|e| e.to_string())?;
    if subs.is_empty() {
        println!("（该视频没有可用字幕）");
        return Ok(());
    }
    let outdir = PathBuf::from(out.unwrap_or("downloads/字幕"));
    let _ = std::fs::create_dir_all(&outdir);
    let title = utils::sanitize_filename(&detail.title, 120);
    for sub in subs {
        if let Ok(segs) = video::download_subtitle_json(api, &sub.url).await {
            let p = outdir.join(format!("{title}.{}.srt", sub.lan));
            if std::fs::write(&p, video::subtitles_to_srt(&segs)).is_ok() {
                println!("✓ [{} {}] {} 句 -> {}", sub.lan, sub.lan_doc, segs.len(), p.display());
            }
        }
    }
    Ok(())
}

async fn cmd_comments(api: &BiliApi, bvid: &str, pages: Option<i64>, as_json: bool, as_csv: bool,
                      out: Option<&str>) -> Result<(), String> {
    let Some(bv) = parse_bvid(bvid) else { return Err(format!("无法解析 BVID: {bvid}")) };
    if !as_json {
        println!("爬取 {bv} 评论（{} 页）...", pages.unwrap_or(1));
    }
    let rows = video::get_comments(api, &bv, pages.unwrap_or(1)).await.map_err(|e| e.to_string())?;
    if rows.is_empty() {
        if !as_json {
            println!("（无评论或未登录被限流）");
        }
        return Ok(());
    }
    if as_json {
        // 程序化调用:JSON 直接输出到 stdout(不写文件、不打表格)
        let arr: Vec<Value> = rows.iter().map(|r| serde_json::json!({
            "user": r.user, "uid": r.uid, "like": r.like, "ctime": r.ctime,
            "reply_count": r.reply_count, "content": r.content,
        })).collect();
        println!("{}", serde_json::to_string(&arr).unwrap());
        return Ok(());
    }
    println!("共 {} 条评论", rows.len());
    for r in rows.iter().take(20) {
        let content: String = r.content.chars().take(50).collect();
        println!("  [{}] {}: {}", utils::fmt_time(r.ctime, "%m-%d %H:%M"), r.user, content);
    }
    if rows.len() > 20 {
        println!("  ... 共 {} 条", rows.len());
    }
    if as_csv {
        let p = out.map(PathBuf::from).unwrap_or_else(|| PathBuf::from(format!("downloads/comments_{bv}")));
        let _ = std::fs::create_dir_all(p.parent().unwrap_or(&p));
        if as_csv {
            let mut csv = String::from("user,uid,like,ctime,reply_count,content\n");
            for r in &rows {
                csv.push_str(&format!("{},{},{},{},{},{}\n", r.user, r.uid, r.like, r.ctime, r.reply_count, r.content.replace('\n', " ")));
            }
            let _ = std::fs::write(p.with_extension("csv"), csv);
            println!("已导出: {}.csv", p.display());
        }
    }
    Ok(())
}

async fn cmd_search(api: &BiliApi, keyword: &str, stype: &str, pages: Option<i64>, order: &str,
                    as_json: bool) -> Result<(), String> {
    let pages = pages.unwrap_or(1);
    match stype {
        "video" => {
            let rows = search::search_videos(api, keyword, pages, order).await.map_err(|e| e.to_string())?;
            if as_json {
                let arr: Vec<Value> = rows.iter().map(|r| serde_json::json!({
                    "bvid": r.bvid, "title": r.title, "up": r.up, "up_mid": r.up_mid,
                    "duration": r.duration, "view": r.view, "danmaku": r.danmaku,
                    "pubdate": r.pubdate, "pic": r.pic,
                })).collect();
                println!("{}", serde_json::to_string(&arr).unwrap());
                return Ok(());
            }
            println!("搜索「{keyword}」共 {} 个视频:", rows.len());
            for (i, r) in rows.iter().enumerate() {
                println!("  {:2}. {} | {} | {} | {} | 播放 {}", i + 1, r.bvid,
                         utils::fmt_time(r.pubdate, "%m-%d"), utils::fmt_duration(r.duration),
                         truncate(&r.title, 40), r.view);
            }
        }
        "user" => {
            let rows = search::search_users(api, keyword, pages).await.map_err(|e| e.to_string())?;
            if as_json {
                let arr: Vec<Value> = rows.iter().map(|r| serde_json::json!({
                    "mid": r.mid, "name": r.name, "fans": r.fans,
                    "videos": r.videos, "sign": r.sign,
                })).collect();
                println!("{}", serde_json::to_string(&arr).unwrap());
                return Ok(());
            }
            println!("搜索用户「{keyword}」共 {} 个:", rows.len());
            for r in &rows {
                println!("  {} | {} | 粉丝 {} | 视频 {} | {}", r.mid, r.name, r.fans, r.videos, truncate(&r.sign, 40));
            }
        }
        "bangumi" => {
            let rows = search::search_bangumi(api, keyword, pages).await.map_err(|e| e.to_string())?;
            if as_json {
                let arr: Vec<Value> = rows.iter().map(|r| serde_json::json!({
                    "season_id": r.season_id, "title": r.title,
                    "score": r.score, "play": r.play, "desc": r.desc,
                })).collect();
                println!("{}", serde_json::to_string(&arr).unwrap());
                return Ok(());
            }
            println!("搜索番剧「{keyword}」共 {} 个:", rows.len());
            for r in &rows {
                println!("  {} | {} | 评分 {} | 播放 {}", r.season_id, r.title, r.score, r.play);
            }
        }
        other => return Err(format!("未知搜索类型 {other}（video/user/bangumi）")),
    }
    Ok(())
}

fn truncate(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

async fn cmd_trending(api: &BiliApi, rid: i64, as_json: bool) -> Result<(), String> {
    let names = [(0, "全站"), (1, "动画"), (3, "音乐"), (4, "游戏"), (5, "娱乐"), (36, "科技"),
                 (119, "鬼畜"), (129, "舞蹈"), (155, "生活"), (160, "时尚"), (167, "知识"), (181, "影视")];
    let name = names.iter().find(|(r, _)| *r == rid).map(|(_, n)| *n).unwrap_or("分区");
    let rows = search::trending(api, rid).await.map_err(|e| e.to_string())?;
    if as_json {
        let arr: Vec<Value> = rows.iter().map(|v| serde_json::json!({
            "bvid": v.bvid, "title": v.title, "up": v.up, "play": v.play,
            "danmaku": v.danmaku, "score": v.score, "pic": v.pic,
        })).collect();
        println!("{}", serde_json::to_string(&arr).unwrap());
        return Ok(());
    }
    println!("B站热门榜 [{name}] 共 {} 条:", rows.len());
    for (i, v) in rows.iter().enumerate() {
        let score = if v.score >= 10000.0 { format!("{:.1}万", v.score / 10000.0) } else if v.score > 0.0 { v.score.to_string() } else { "-".into() };
        println!("  {:2}. {} | {} | 播放 {} | 弹幕 {} | 热度 {} | {}", i + 1, v.bvid, v.up, v.play, v.danmaku, score, truncate(&v.title, 38));
    }
    Ok(())
}

async fn cmd_season(api: &BiliApi, mid: &str, do_list: bool, download_id: Option<&str>,
                    audio: Option<&str>, outdir: Option<&str>, dry_run: bool) -> Result<(), String> {
    let mid = parse_mid(mid)?;
    let cfg = config::Config::new(base_dir().join("config").join("config.json"));
    if do_list || download_id.is_none() {
        let seasons = user::get_seasons(api, &mid, 20).await.map_err(|e| e.to_string())?;
        if seasons.is_empty() {
            println!("（该 UP 没有合集，或最近视频均不属于合集）");
            return Ok(());
        }
        println!("UP 的合集（基于最近视频扫描，共 {} 个）:", seasons.len());
        for s in &seasons {
            println!("  ID {} | {} | {} 个视频", s.id, s.title, s.episodes.len());
        }
    }
    if let Some(sid) = download_id {
        let seasons = user::get_seasons(api, &mid, 20).await.map_err(|e| e.to_string())?;
        let Some(season) = seasons.iter().find(|s| s.id.to_string() == sid) else {
            return Err(format!("未找到合集 {sid}"));
        };
        println!("合集 {sid}《{}》共 {} 个视频:", season.title, season.episodes.len());
        for ep in &season.episodes {
            println!("  {} | {} | {}", ep.bvid, utils::fmt_time(ep.ctime, "%m-%d"), ep.title);
        }
        if !dry_run {
            let outdir = PathBuf::from(outdir.unwrap_or(&cfg.get_str("outdir", "downloads")));
            let opts = build_opts(&cfg, audio, None, None, None, None, None, false, None, false, false, false, false, None);
            let bvids: Vec<String> = season.episodes.iter().map(|e| e.bvid.clone()).collect();
            batch_download(api, &bvids, &outdir, Some(&season.title), &opts, cfg.get_int("jobs", 2) as usize).await;
        }
    }
    Ok(())
}

async fn cmd_fav(api: &BiliApi, uid: &str, _do_list: bool, media_id: Option<&str>,
                 audio: Option<&str>, outdir: Option<&str>, dry_run: bool) -> Result<(), String> {
    let cfg = config::Config::new(base_dir().join("config").join("config.json"));
    if let Some(mid) = media_id {
        let (items, total) = user::get_fav_archives(api, mid).await.map_err(|e| e.to_string())?;
        println!("收藏夹 {mid} 共 {} 个视频:", total.max(items.len() as i64));
        for v in &items {
            println!("  {} | {} | {}", v.bvid, v.up, v.title);
        }
        if !dry_run && !items.is_empty() {
            let outdir = PathBuf::from(outdir.unwrap_or(&cfg.get_str("outdir", "downloads")));
            let opts = build_opts(&cfg, audio, None, None, None, None, None, false, None, false, false, false, false, None);
            let bvids: Vec<String> = items.iter().map(|v| v.bvid.clone()).collect();
            batch_download(api, &bvids, &outdir, None, &opts, cfg.get_int("jobs", 2) as usize).await;
        }
    } else {
        if !api.is_logged_in() {
            return Err("列出收藏夹需要登录，请先运行 login".into());
        }
        let folders = user::get_fav_folders(api, uid).await.map_err(|e| e.to_string())?;
        if folders.is_empty() {
            println!("（无收藏夹）");
            return Ok(());
        }
        println!("收藏夹:");
        for f in &folders {
            println!("  ID {} | {} | {} 个", f.id, f.title, f.count);
        }
    }
    Ok(())
}

async fn cmd_subscribe(api: &BiliApi, sub: &SubCmd) -> Result<(), String> {
    match sub {
        SubCmd::Add { mid } => {
            let mid = parse_mid(mid)?;
            let mid_i = mid.parse::<i64>().map_err(|_| "mid 必须是数字")?;
            let info = user::get_user_info(api, &mid).await.map_err(|e| e.to_string())?;
            let mut st = store();
            st.sub_add(mid_i, &info.name);
            println!("已订阅 {} (mid={})", info.name, mid);
        }
        SubCmd::List => {
            let subs = store().sub_list();
            if subs.is_empty() {
                println!("（暂无订阅，subscribe add <mid> 添加）");
            }
            for s in &subs {
                println!("  {} | {} | 添加于 {} | 上次检查 {}",
                         s["mid"].as_i64().unwrap_or(0),
                         s["name"].as_str().unwrap_or("?"),
                         utils::fmt_time(s["added_at"].as_i64().unwrap_or(0), "%Y-%m-%d"),
                         utils::fmt_time(s["last_check"].as_i64().unwrap_or(0), "%m-%d %H:%M"));
            }
        }
        SubCmd::Remove { mid } => {
            let mid = parse_mid(mid)?;
            let mid_i = mid.parse::<i64>().map_err(|_| "mid 必须是数字")?;
            let mut st = store();
            st.sub_remove(mid_i);
            println!("已取消订阅 {mid}");
        }
        SubCmd::Check { download: do_dl, audio, outdir, limit } => {
            let subs = store().sub_list();
            if subs.is_empty() {
                return Err("暂无订阅，请先 subscribe add".into());
            }
            let cfg = config::Config::new(base_dir().join("config").join("config.json"));
            for s in &subs {
                let mid = s["mid"].as_i64().unwrap_or(0);
                let name = s["name"].as_str().unwrap_or("?").to_string();
                let last = s["last_check"].as_i64().unwrap_or(0);
                println!("--- 检查 {name} ({mid}) ---");
                let videos = match user::get_videos(api, &mid.to_string(), Some(last.max(0))).await {
                    Ok(v) => v,
                    Err(e) => {
                        println!("  检查失败: {e}");
                        continue;
                    }
                };
                let mut new: Vec<user::Video> = videos.into_iter().filter(|v| v.ctime > last).collect();
                new.sort_by_key(|v| v.ctime);
                if let Some(l) = limit {
                    let l = *l as usize;
                    if new.len() > l {
                        new = new[new.len() - l..].to_vec();
                    }
                }
                println!("新视频 {} 个:", new.len());
                for v in &new {
                    println!("  {} | {} | {}", v.bvid, utils::fmt_time(v.ctime, "%m-%d"), v.title);
                }
                if *do_dl && !new.is_empty() {
                    let outdir = PathBuf::from(outdir.clone().unwrap_or(cfg.get_str("outdir", "downloads")));
                    let opts = build_opts(&cfg, audio.as_deref(), None, None, None, None, None, false, None, false, false, false, false, None);
                    let bvids: Vec<String> = new.iter().map(|v| v.bvid.clone()).collect();
                    batch_download(api, &bvids, &outdir, Some(&name), &opts, cfg.get_int("jobs", 2) as usize).await;
                }
                let mut st2 = store();
                st2.sub_touch(mid, utils::now_ts());
            }
        }
    }
    Ok(())
}

async fn cmd_update(api: &BiliApi, audio: Option<&str>, outdir: Option<&str>, dry_run: bool) -> Result<(), String> {
    let subs = store().sub_list();
    if subs.is_empty() {
        return Err("暂无订阅，请先 subscribe add".into());
    }
    let cfg = config::Config::new(base_dir().join("config").join("config.json"));
    let mut total_new = 0i64;
    for s in &subs {
        let mid = s["mid"].as_i64().unwrap_or(0);
        let name = s["name"].as_str().unwrap_or("?").to_string();
        let last = s["last_check"].as_i64().unwrap_or(0);
        println!("--- {name} ({mid}) ---");
        let videos = match user::get_videos(api, &mid.to_string(), Some(last.max(0))).await {
            Ok(v) => v,
            Err(e) => {
                println!("  检查失败: {e}");
                continue;
            }
        };
        let new: Vec<user::Video> = videos.into_iter().filter(|v| v.ctime > last).collect();
        if new.is_empty() {
            println!("  无新视频");
        } else {
            total_new += new.len() as i64;
            for v in &new {
                println!("  {} | {} | {}", v.bvid, utils::fmt_time(v.ctime, "%m-%d"), v.title);
            }
            if !dry_run {
                let outdir = PathBuf::from(outdir.unwrap_or(&cfg.get_str("outdir", "downloads")));
                let opts = build_opts(&cfg, audio, None, None, None, None, None, false, None, false, false, false, false, None);
                let bvids: Vec<String> = new.iter().map(|v| v.bvid.clone()).collect();
                batch_download(api, &bvids, &outdir, Some(&name), &opts, cfg.get_int("jobs", 2) as usize).await;
            }
        }
        let mut st2 = store();
        st2.sub_touch(mid, utils::now_ts());
    }
    println!("完成：共发现 {total_new} 个新视频");
    Ok(())
}

fn cmd_config(set: Option<&[String]>, reset: bool) -> Result<(), String> {
    let mut cfg = config::Config::new(base_dir().join("config").join("config.json"));
    if reset {
        cfg.reset();
        println!("已恢复默认配置");
    }
    if let Some(kv) = set {
        if kv.len() != 2 {
            return Err("--set 需要 KEY VALUE 两个参数".into());
        }
        let key = &kv[0];
        let value = &kv[1];
        match key.as_str() {
            "jobs" | "parallel" => {
                let v: i64 = value.parse().map_err(|_| "需要整数")?;
                cfg.set(key, serde_json::json!(v));
            }
            "danmaku" | "cover" | "subs" => {
                let v = matches!(value.to_lowercase().as_str(), "1" | "true" | "yes" | "on");
                cfg.set(key, serde_json::json!(v));
            }
            "audio" => {
                if value.is_empty() || config::AUDIO_FORMATS.contains(&value.as_str()) {
                    cfg.set(key, serde_json::json!(value));
                } else {
                    return Err("audio 需为 mp3/wav/flac/m4a/opus/aac 或留空".into());
                }
            }
            "quality" => {
                if !["480", "720", "1080", "2160", "best"].contains(&value.as_str()) {
                    return Err("quality 需为 480/720/1080/2160/best".into());
                }
                cfg.set(key, serde_json::json!(value));
            }
            "codec" => {
                if !["auto", "copy"].contains(&value.as_str()) {
                    return Err("codec 需为 auto(HEVC 自动转 H.264)/copy(保留原编码)".into());
                }
                cfg.set(key, serde_json::json!(value));
            }
            "outdir" | "dm_fmt" | "rate" => {
                cfg.set(key, serde_json::json!(value));
            }
            _ => return Err(format!("未知配置项 {key}")),
        }
        println!("已设置 {key} = {value}");
    }
    println!("当前配置（config/config.json，未设置的项显示默认值）:");
    let all = cfg.all();
    let defaults: [(&str, &str); 10] = [
        ("outdir", "downloads"), ("quality", "best"), ("codec", "auto"),
        ("jobs", "2"), ("parallel", "8"), ("audio", "(空=视频)"),
        ("dm_fmt", "xml"), ("danmaku", "true"), ("cover", "true"), ("rate", "(空)"),
    ];
    for (k, d) in defaults {
        let v = all.get(k).map(|v| v.to_string()).unwrap_or_else(|| d.to_string());
        println!("  {:<10} = {}", k, v);
    }
    Ok(())
}

/// convert 子命令(2026-08-11):已有 HEVC 视频就地转码为 H.264(挂件
/// 对话窗口在禁用硬件加速下无法呈现 HEVC 帧,转码后窗口内直接可播)
fn cmd_convert(paths: &[String]) -> Result<(), String> {
    if !download::ffmpeg_exists() {
        return Err("需要 ffmpeg 转码(未找到 ffmpeg)".into());
    }
    for p in paths {
        match download::convert_to_h264(p) {
            Ok((true, msg)) => println!("✓ {msg}"),
            Ok((false, msg)) => println!("= {msg}"),
            Err(e) => println!("✗ {p}: {e}"),
        }
    }
    Ok(())
}

fn cmd_history(limit: Option<i64>) -> Result<(), String> {
    let rows = store().history(limit.unwrap_or(20) as usize);
    if rows.is_empty() {
        println!("（暂无历史记录）");
        return Ok(());
    }
    println!("最近操作:");
    for r in &rows {
        println!("  {} | {:<10} | {} | {}",
                 utils::fmt_time(r["at"].as_i64().unwrap_or(0), "%Y-%m-%d %H:%M"),
                 r["action"].as_str().unwrap_or(""),
                 r["target"].as_str().unwrap_or(""),
                 r["detail"].as_str().unwrap_or(""));
    }
    Ok(())
}

fn cmd_saved(limit: Option<i64>, clear: bool) -> Result<(), String> {
    if clear {
        let n = store().clear_downloads();
        println!("已清空 {n} 条下载记录（文件未删除）");
        return Ok(());
    }
    let rows = store().list_downloaded();
    if rows.is_empty() {
        println!("（暂无下载记录）");
        return Ok(());
    }
    println!("已下载 {} 个视频:", rows.len());
    for r in rows.iter().take(limit.unwrap_or(20) as usize) {
        println!("  {} | {} | {} | {} | {}",
                 utils::fmt_time(r["pubdate"].as_i64().unwrap_or(0), "%m-%d"),
                 truncate(r["title"].as_str().unwrap_or(""), 36),
                 r["up"].as_str().unwrap_or("-"),
                 fmt_size(r["size"].as_u64().unwrap_or(0)),
                 r["path"].as_str().unwrap_or(""));
    }
    Ok(())
}

// ================================================================ main

#[tokio::main]
async fn main() {
    init();
    let cli = Cli::parse();
    // 双击 exe（无参数）时默认启动 Web 界面
    let cmd = cli.cmd.unwrap_or(Cmd::Serve { port: 8787 });
    let dir = base_dir();
    let api = BiliApi::new(dir.join("config"));

    let result: Result<(), String> = match &cmd {
        Cmd::Info { mid, json } => cmd_info(&api, mid, *json).await,
        Cmd::List { mid, since, until, days, regex, exclude, limit, json, csv, md, out } => {
            cmd_list(&api, mid, since.as_deref(), until.as_deref(), *days, regex.as_deref(),
                     exclude.as_deref(), *limit, *json, *csv, *md, out.as_deref()).await
        }
        Cmd::Download { mid, since, until, days, regex, exclude, latest, limit, new_only, audio,
                        quality, codec, progress_file, jobs, parallel, rate, page, outdir, no_danmaku, dm_fmt, subs,
                        no_cover, force, no_skip, dry_run } => {
            cmd_download(&api, mid, since.as_deref(), until.as_deref(), *days, regex.as_deref(),
                         exclude.as_deref(), *latest, *limit, *new_only, audio.as_deref(),
                         quality.as_deref(), codec.as_deref(), progress_file.as_deref(), *jobs, *parallel, rate.as_deref(), *page,
                         outdir.as_deref(), *no_danmaku, dm_fmt.as_deref(), *subs, *no_cover,
                         *force, *no_skip, *dry_run).await
        }
        Cmd::Get { bvid, audio, quality, codec, progress_file, page, outdir, no_danmaku, dm_fmt, subs, no_cover, force, no_skip, info, json } => {
            cmd_get(&api, bvid, audio.as_deref(), quality.as_deref(), codec.as_deref(), progress_file.as_deref(), *page, outdir.as_deref(),
                    *no_danmaku, dm_fmt.as_deref(), *subs, *no_cover, *force, *no_skip, *info, *json).await
        }
        Cmd::Danmaku { bvid, fmt, out } => cmd_danmaku(&api, bvid, fmt.as_deref(), out.as_deref()).await,
        Cmd::Subtitle { bvid, out } => cmd_subtitle(&api, bvid, out.as_deref()).await,
        Cmd::Comments { bvid, pages, json, csv, out } => {
            cmd_comments(&api, bvid, *pages, *json, *csv, out.as_deref()).await
        }
        Cmd::Search { keyword, r#type, pages, order, json } => {
            cmd_search(&api, keyword, r#type, *pages, order, *json).await
        }
        Cmd::Trending { rid, json } => cmd_trending(&api, *rid, *json).await,
        Cmd::Season { mid, list, download, audio, outdir, dry_run } => {
            cmd_season(&api, mid, *list, download.as_deref(), audio.as_deref(), outdir.as_deref(), *dry_run).await
        }
        Cmd::Fav { uid, list, download, audio, outdir, dry_run } => {
            cmd_fav(&api, uid, *list, download.as_deref(), audio.as_deref(), outdir.as_deref(), *dry_run).await
        }
        Cmd::Login { timeout, qrcode_img, no_wait } => {
            match login::login(&api, *timeout, qrcode_img.as_deref(), *no_wait).await {
                Ok(Some(_)) => Ok(()),
                // no_wait 模式:仅生成二维码,生成即完成(登录确认另跑 whoami)
                Ok(None) if *no_wait => Ok(()),
                Ok(None) => Err("登录未完成".into()),
                Err(e) => Err(e.to_string()),
            }
        }
        Cmd::Logout => {
            let f = api.cookie_file();
            if f.exists() {
                let _ = std::fs::remove_file(&f);
                println!("已退出登录（cookie 已删除）");
            } else {
                println!("当前未登录");
            }
            Ok(())
        }
        Cmd::Whoami => {
            if api.is_logged_in() {
                let (uid, _, _) = api.login_info();
                println!("已登录 (UID {uid})");
            } else {
                println!("未登录（登录可解锁高清、收藏夹、AI 字幕）");
            }
            Ok(())
        }
        Cmd::Subscribe { sub } => cmd_subscribe(&api, sub).await,
        Cmd::Update { audio, outdir, dry_run } => cmd_update(&api, audio.as_deref(), outdir.as_deref(), *dry_run).await,
        Cmd::Config { set, reset } => cmd_config(set.as_deref(), *reset),
        Cmd::History { limit } => cmd_history(*limit),
        Cmd::Saved { limit, clear } => cmd_saved(*limit, *clear),
        Cmd::Convert { paths } => cmd_convert(paths),
        Cmd::Serve { port } => {
            let api2 = api.clone();
            let base2 = base_dir();
            tokio::select! {
                r = serve::serve(*port, api2, base2) => r,
                _ = tokio::signal::ctrl_c() => Ok(()),
            }
        }
    };

    if let Err(e) = result {
        eprintln!("错误: {e}");
        show_error(&e);
        std::process::exit(1);
    }
}
