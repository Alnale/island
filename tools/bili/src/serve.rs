//! Web 服务模式：本地 HTTP API + 下载任务系统 + 前端静态托管。
//! 运行 `bili-tool serve` 后浏览器访问 http://127.0.0.1:8787 即可使用图形界面。

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use axum::extract::{Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use rust_embed::RustEmbed;
use serde_json::{json, Value};

use crate::api::BiliApi;
use crate::config::Config;
use crate::download::DownloadOptions;
use crate::store::Store;
use crate::user;
use crate::utils;
use crate::video;

#[derive(RustEmbed)]
#[folder = "frontend/dist/"]
struct Assets;

// ---------------------------------------------------------------- 任务系统

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct TaskResult {
    pub bvid: String,
    pub title: String,
    pub path: Option<String>,
    pub skipped: bool,
    pub error: Option<String>,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct TaskState {
    pub id: u64,
    pub label: String,
    pub total: usize,
    pub done: usize,
    pub running: bool,
    pub paused: bool,
    pub at: i64,
    pub results: Vec<TaskResult>,
}

pub struct AppState {
    pub api: BiliApi,
    pub tasks: Mutex<Vec<TaskState>>,
    pub next_id: AtomicU64,
    pub base: PathBuf,
    /// mid -> (拉取时间戳, 全量视频列表) 缓存，供分页流式加载
    pub video_cache: Mutex<std::collections::HashMap<String, (i64, Vec<Value>)>>,
    /// mid -> (拉取时间戳, 合集列表[含 episodes]) 缓存，避免重复扫描
    pub season_cache: Mutex<std::collections::HashMap<String, (i64, Vec<Value>)>>,
}

impl AppState {
    pub fn new(api: BiliApi, base: PathBuf) -> Self {
        // 从 store 恢复历史任务（标记为已结束）
        let store = Store::new(base.join("config").join("store.json"));
        let mut tasks: Vec<TaskState> = store
            .task_list()
            .into_iter()
            .filter_map(|t| serde_json::from_value(t).ok())
            .collect();
        let max_id = tasks.iter().map(|t| t.id).max().unwrap_or(0);
        for t in tasks.iter_mut() {
            t.running = false;
        }
        AppState {
            api,
            tasks: Mutex::new(tasks),
            next_id: AtomicU64::new(max_id + 1),
            base,
            video_cache: Mutex::new(std::collections::HashMap::new()),
            season_cache: Mutex::new(std::collections::HashMap::new()),
        }
    }
}

/// 锁容错：Mutex 中毒后继续使用（数据尽力而为，避免级联 panic）
fn lock_tasks(state: &AppState) -> std::sync::MutexGuard<'_, Vec<TaskState>> {
    state.tasks.lock().unwrap_or_else(|e| e.into_inner())
}

fn cfg_of(state: &AppState) -> Config {
    Config::new(state.base.join("config").join("config.json"))
}

fn store_of(state: &AppState) -> Store {
    Store::new(state.base.join("config").join("store.json"))
}

// ---------------------------------------------------------------- 静态资源

async fn static_handler(uri: axum::http::Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() || path == "index.html" {
        "index.html"
    } else {
        path
    };
    match Assets::get(path) {
        Some(content) => {
            let mime = mime_for(path);
            (
                [(header::CONTENT_TYPE, mime)],
                content.data.into_owned(),
            )
                .into_response()
        }
        None => {
            // SPA 回退：非资源路径返回 index.html
            match Assets::get("index.html") {
                Some(content) => (
                    [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
                    content.data.into_owned(),
                )
                    .into_response(),
                None => (StatusCode::NOT_FOUND, "前端资源未构建（请先 npm run build）").into_response(),
            }
        }
    }
}

/// 打开默认浏览器（用 explorer.exe 而非 cmd start，避免控制台窗口闪烁）
fn open_browser(addr: &str) {
    #[cfg(windows)]
    {
        let url = format!("http://{addr}");
        let _ = std::process::Command::new("explorer").arg(&url).spawn();
    }
    #[cfg(not(windows))]
    {
        let _ = addr;
    }
}

fn mime_for(path: &str) -> &'static str {
    if path.ends_with(".js") {
        "application/javascript; charset=utf-8"
    } else if path.ends_with(".css") {
        "text/css; charset=utf-8"
    } else if path.ends_with(".html") {
        "text/html; charset=utf-8"
    } else if path.ends_with(".svg") {
        "image/svg+xml"
    } else if path.ends_with(".png") {
        "image/png"
    } else if path.ends_with(".ico") {
        "image/x-icon"
    } else if path.ends_with(".json") {
        "application/json"
    } else if path.ends_with(".woff2") {
        "font/woff2"
    } else if path.ends_with(".map") {
        "application/json"
    } else {
        "application/octet-stream"
    }
}

// ---------------------------------------------------------------- API 处理器

fn err(e: impl std::fmt::Display) -> (StatusCode, String) {
    (StatusCode::BAD_REQUEST, e.to_string())
}

async fn api_up_info(State(st): State<Arc<AppState>>, Json(body): Json<Value>) -> Result<Json<Value>, (StatusCode, String)> {
    let mid = body["mid"].as_str().ok_or_else(|| err("缺少 mid"))?;
    let info = user::get_user_info(&st.api, mid).await.map_err(err)?;
    Ok(Json(json!({
        "mid": info.mid, "name": info.name, "face": info.face, "sign": info.sign, "level": info.level,
        "sex": info.sex, "official": info.official, "fans": info.fans,
        "following": info.following, "archives": info.archives, "likes": info.likes,
    })))
}

const PAGE_SIZE: usize = 20;

async fn api_up_videos(State(st): State<Arc<AppState>>, Json(body): Json<Value>) -> Result<Json<Value>, (StatusCode, String)> {
    let mid = body["mid"].as_str().ok_or_else(|| err("缺少 mid"))?;
    let pn = body.get("pn").and_then(|v| v.as_i64()).unwrap_or(1).max(1) as usize;
    let since = body.get("since").and_then(|v| v.as_str()).and_then(utils::parse_date);
    let t0 = body.get("days").and_then(|v| v.as_i64()).map(|d| utils::now_ts() - d * 86400).or(since);

    // 缓存：同 mid 5 分钟内复用（分页滚动不再重复拉取）
    let cached = st.video_cache.lock().unwrap().get(mid).cloned();
    let (ts, mut matched) = match cached {
        Some((ts, v)) if utils::now_ts() - ts < 300 => (ts, v),
        _ => {
            let videos = user::get_videos(&st.api, mid, t0).await.map_err(err)?;
            let rx = body.get("regex").and_then(|v| v.as_str()).map(|r| regex::Regex::new(r).unwrap_or_else(|_| regex::Regex::new("").unwrap()));
            let mut list: Vec<Value> = Vec::new();
            for v in &videos {
                if let Some(r) = &rx {
                    if !r.is_match(&v.title) {
                        continue;
                    }
                }
                list.push(json!({
                    "bvid": v.bvid, "aid": v.aid, "title": v.title, "ctime": v.ctime,
                    "duration": v.duration, "play": v.play, "danmaku": v.danmaku,
                    "comment": v.comment, "tname": v.tname, "pic": v.pic,
                }));
            }
            list.sort_by(|a, b| b["ctime"].as_i64().unwrap_or(0).cmp(&a["ctime"].as_i64().unwrap_or(0)));
            let now = utils::now_ts();
            st.video_cache.lock().unwrap().insert(mid.to_string(), (now, list.clone()));
            (now, list)
        }
    };
    let _ = ts;
    let total = matched.len();
    let start = (pn - 1) * PAGE_SIZE;
    let page: Vec<Value> = matched.drain(start..start + PAGE_SIZE.min(matched.len().saturating_sub(start))).collect();
    let has_more = start + page.len() < total;
    Ok(Json(json!({ "total": total, "videos": page, "has_more": has_more, "pn": pn })))
}

// ---------------- 下载任务

fn parse_opts(body: &Value, st: &AppState) -> DownloadOptions {
    let cfg = cfg_of(st);
    let audio = body.get("audio").and_then(|v| v.as_str()).filter(|s| !s.is_empty())
        .map(|s| s.to_string()).or_else(|| cfg.get_audio());
    let quality = body.get("quality").and_then(|v| v.as_str()).unwrap_or("best").to_string();
    let fmt = body.get("dm_fmt").and_then(|v| v.as_str()).unwrap_or("xml").to_string();
    DownloadOptions {
        quality,
        audio_only: audio,
        parallel: body.get("parallel").and_then(|v| v.as_i64()).map(|v| v as usize).unwrap_or_else(|| cfg.get_int("parallel", 8) as usize),
        rate: body.get("rate").and_then(|v| v.as_str()).map(|s| s.to_string()),
        danmaku: body.get("danmaku").and_then(|v| v.as_bool()).unwrap_or_else(|| cfg.get_bool("danmaku", true)),
        dm_fmt: fmt.split(',').map(|s| s.trim().to_string()).collect(),
        subs: body.get("subs").and_then(|v| v.as_bool()).unwrap_or(false),
        cover: body.get("cover").and_then(|v| v.as_bool()).unwrap_or_else(|| cfg.get_bool("cover", true)),
        force: body.get("force").and_then(|v| v.as_bool()).unwrap_or(false),
        skip: !body.get("no_skip").and_then(|v| v.as_bool()).unwrap_or(false),
        page: body.get("page").and_then(|v| v.as_i64()),
    }
}

async fn api_download_start(State(st): State<Arc<AppState>>, Json(body): Json<Value>) -> Result<Json<Value>, (StatusCode, String)> {
    let bvids: Vec<String> = body["bvids"].as_array()
        .ok_or_else(|| err("缺少 bvids"))?
        .iter().filter_map(|v| v.as_str()).map(|s| s.to_string()).collect();
    if bvids.is_empty() {
        return Err(err("bvids 为空"));
    }
    let cfg = cfg_of(&st);
    let outdir = body.get("outdir").and_then(|v| v.as_str())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(cfg.get_str("outdir", "downloads")));
    let up_name = body.get("up_name").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let jobs = body.get("jobs").and_then(|v| v.as_i64()).map(|v| v as usize).unwrap_or_else(|| cfg.get_int("jobs", 2) as usize).max(1);
    let label = if up_name.is_empty() {
        format!("批量下载 {} 个视频", bvids.len())
    } else {
        format!("{}：{} 个视频", up_name, bvids.len())
    };

    let id = st.next_id.fetch_add(1, Ordering::SeqCst);
    let task = TaskState {
        paused: false,
        id,
        label,
        total: bvids.len(),
        done: 0,
        running: true,
        at: utils::now_ts(),
        results: Vec::new(),
    };
    lock_tasks(&st).push(task);

    let api = st.api.clone();
    let state = st.clone();
    let opts = parse_opts(&body, &state);
    let target = if up_name.is_empty() {
        outdir
    } else {
        outdir.join(utils::sanitize_filename(&up_name, 60))
    };
    let _ = std::fs::create_dir_all(&target);

    let n = bvids.len();
    tokio::spawn(async move {
        let mut handles = tokio::task::JoinSet::new();
        let mut idx = 0usize;
        while idx < n {
            // 暂停支持：暂停时等待，不启动新视频（当前正在下载的完成后自然停下）
            let paused = {
                let tasks = lock_tasks(&state);
                tasks.iter().find(|t| t.id == id).map(|t| t.paused).unwrap_or(false)
            };
            if paused {
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                continue;
            }
            while handles.len() < jobs && idx < n {
                let b = bvids[idx].clone();
                let api2 = api.clone();
                let outdir2 = target.clone();
                let opts2 = opts.clone();
                handles.spawn(async move {
                    crate::download::download_one(&api2, &b, &outdir2, &opts2, None).await
                });
                idx += 1;
            }
            while let Some(res) = handles.join_next().await {
                let r = match res {
                    Ok(r) => r,
                    Err(e) => crate::download::DownloadResult {
                        bvid: "?".into(), title: String::new(), path: None,
                        files: vec![], skipped: false, error: Some(format!("{e}")),
                    },
                };
                let err = r.error.clone();
                let path = r.path.clone();
                let bvid = r.bvid.clone();
                let title = r.title.clone();
                {
                    let mut tasks = lock_tasks(&state);
                    if let Some(t) = tasks.iter_mut().find(|t| t.id == id) {
                        t.results.push(TaskResult {
                            bvid: bvid.clone(),
                            title: title.clone(),
                            path: path.as_ref().map(|p| p.display().to_string()),
                            skipped: r.skipped,
                            error: err.clone(),
                        });
                        t.done += 1;
                        if t.done >= t.total {
                            t.running = false;
                        }
                    }
                } // drop guard 避免跨 await
                // 任务完成后持久化历史
                {
                    let mut tasks = lock_tasks(&state);
                    if let Some(t) = tasks.iter().find(|t| t.id == id) {
                        if !t.running {
                            let mut store = store_of(&state);
                            store.task_save(&serde_json::to_value(t).unwrap_or_default());
                        }
                    }
                }
                // 记录历史（get_detail 重试一次，仍失败则降级记录，保证一定写入）
                if err.is_none() && path.is_some() {
                    let mut detail = video::get_detail(&api, &bvid).await;
                    if detail.is_err() {
                        detail = video::get_detail(&api, &bvid).await;
                    }
                    let size = std::fs::metadata(path.as_ref().unwrap()).map(|m| m.len()).unwrap_or(0);
                    let mut store = store_of(&state);
                    match detail {
                        Ok(d) => {
                            store.record_download(&bvid, d.aid, &title, &d.up, d.up_mid, d.pubdate,
                                                  d.duration, &path.as_ref().unwrap().display().to_string(),
                                                  size, &opts.quality, opts.audio_only.is_some());
                        }
                        Err(_) => {
                            // 降级：详情拉取失败也记录（路径/标题/大小已知）
                            store.record_download(&bvid, 0, &title, "", 0, utils::now_ts(), 0,
                                                  &path.as_ref().unwrap().display().to_string(),
                                                  size, &opts.quality, opts.audio_only.is_some());
                        }
                    }
                    store.log("download", &bvid, &path.as_ref().unwrap().display().to_string());
                }
            }
        }
    });

    Ok(Json(json!({ "task_id": id, "total": n })))
}

async fn api_tasks(State(st): State<Arc<AppState>>) -> Json<Value> {
    let mut tasks = lock_tasks(&st).clone();
    tasks.sort_by(|a, b| b.id.cmp(&a.id));
    Json(json!({ "tasks": tasks }))
}

async fn api_task_pause(State(st): State<Arc<AppState>>, Json(body): Json<Value>) -> Json<Value> {
    let id = body["task_id"].as_u64().unwrap_or(0);
    let paused = body.get("paused").and_then(|v| v.as_bool()).unwrap_or(true);
    let mut tasks = lock_tasks(&st);
    if let Some(t) = tasks.iter_mut().find(|t| t.id == id) {
        t.paused = paused;
    }
    Json(json!({ "ok": true, "task_id": id, "paused": paused }))
}

async fn api_task_cancel(State(st): State<Arc<AppState>>, Json(body): Json<Value>) -> Json<Value> {
    let id = body["task_id"].as_u64().unwrap_or(0);
    let mut tasks = lock_tasks(&st);
    if let Some(t) = tasks.iter_mut().find(|t| t.id == id) {
        t.running = false;
        t.label = format!("{}（已停止）", t.label);
    }
    Json(json!({ "ok": true }))
}

/// 删除任务记录（仅限已结束任务；运行中任务先停止再删）
async fn api_task_delete(State(st): State<Arc<AppState>>, Json(body): Json<Value>) -> Json<Value> {
    let id = body["task_id"].as_u64().unwrap_or(0);
    let running = {
        let tasks = lock_tasks(&st);
        tasks.iter().find(|t| t.id == id).map(|t| t.running).unwrap_or(false)
    };
    if running {
        return Json(json!({ "ok": false, "msg": "任务正在运行，请先停止再删除" }));
    }
    let removed = {
        let mut tasks = lock_tasks(&st);
        let before = tasks.len();
        tasks.retain(|t| t.id != id);
        tasks.len() != before
    };
    if !removed {
        return Json(json!({ "ok": false, "msg": "任务不存在" }));
    }
    // 同步删除持久化记录
    let mut store = store_of(&st);
    store.task_remove(id);
    store.log("task_delete", &id.to_string(), "删除任务记录");
    Json(json!({ "ok": true, "task_id": id }))
}

/// 单视频详情（供视频链接直接下载）
async fn api_video_info(State(st): State<Arc<AppState>>, Json(body): Json<Value>) -> Result<Json<Value>, (StatusCode, String)> {
    let bvid = body["bvid"].as_str().ok_or_else(|| err("缺少 bvid"))?;
    let d = video::get_detail(&st.api, bvid).await.map_err(err)?;
    Ok(Json(json!({
        "bvid": d.bvid, "title": d.title, "pic": d.pic, "pubdate": d.pubdate,
        "duration": d.duration, "view": d.view, "danmaku": d.danmaku,
        "like": d.like, "up": d.up, "up_mid": d.up_mid, "pages": d.pages.len(),
    })))
}

// 封面图片代理：避免浏览器直连 B 站 CDN（防盗链/混合内容）
async fn api_cover(State(st): State<Arc<AppState>>, Query(q): Query<Value>) -> Response {
    let url = q.get("url").and_then(|v| v.as_str()).unwrap_or("");
    if url.is_empty() || !(url.starts_with("https://") || url.starts_with("http://")) {
        return (StatusCode::BAD_REQUEST, "缺少 url").into_response();
    }
    match st.api.get_bytes(url, None).await {
        Ok(resp) => {
            let status = resp.status();
            let body = match resp.bytes().await {
                Ok(b) => b,
                Err(_) => return (StatusCode::BAD_GATEWAY, "读取图片失败").into_response(),
            };
            let mime = if url.contains(".png") { "image/png" } else { "image/jpeg" };
            (status, [(header::CONTENT_TYPE, mime), (header::CACHE_CONTROL, "public, max-age=86400")], body).into_response()
        }
        Err(_) => (StatusCode::BAD_GATEWAY, "图片下载失败").into_response(),
    }
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (hex_val(bytes[i + 1]), hex_val(bytes[i + 2])) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

// ---------------- 其他

async fn api_search(State(st): State<Arc<AppState>>, Json(body): Json<Value>) -> Result<Json<Value>, (StatusCode, String)> {
    let keyword = body["keyword"].as_str().ok_or_else(|| err("缺少 keyword"))?;
    let stype = body.get("type").and_then(|v| v.as_str()).unwrap_or("video");
    let pages = body.get("pages").and_then(|v| v.as_i64()).unwrap_or(1);
    let order = body.get("order").and_then(|v| v.as_str()).unwrap_or("totalrank");
    match stype {
        "video" => {
            let rows = crate::search::search_videos(&st.api, keyword, pages, order).await.map_err(err)?;
            Ok(Json(json!({ "type": "video", "rows": rows.iter().map(|r| json!({
                "bvid": r.bvid, "title": r.title, "up": r.up, "duration": r.duration,
                "view": r.view, "pubdate": r.pubdate, "pic": r.pic,
            })).collect::<Vec<_>>() })))
        }
        "user" => {
            let rows = crate::search::search_users(&st.api, keyword, pages).await.map_err(err)?;
            Ok(Json(json!({ "type": "user", "rows": rows.iter().map(|r| json!({
                "mid": r.mid, "name": r.name, "fans": r.fans, "videos": r.videos, "sign": r.sign,
            })).collect::<Vec<_>>() })))
        }
        "bangumi" => {
            let rows = crate::search::search_bangumi(&st.api, keyword, pages).await.map_err(err)?;
            Ok(Json(json!({ "type": "bangumi", "rows": rows.iter().map(|r| json!({
                "season_id": r.season_id, "title": r.title, "score": r.score, "play": r.play,
            })).collect::<Vec<_>>() })))
        }
        other => Err(err(format!("未知搜索类型 {other}"))),
    }
}

async fn api_danmaku(State(st): State<Arc<AppState>>, Query(q): Query<Value>) -> Result<Json<Value>, (StatusCode, String)> {
    let bvid = q.get("bvid").and_then(|v| v.as_str()).unwrap_or("");
    let fmt = q.get("fmt").and_then(|v| v.as_str()).unwrap_or("xml");
    let detail = video::get_detail(&st.api, bvid).await.map_err(err)?;
    let dms = crate::danmaku::fetch_danmaku(&st.api, detail.cid, detail.duration).await.map_err(err)?;
    let outdir = st.base.join("downloads").join("弹幕");
    let _ = std::fs::create_dir_all(&outdir);
    let title = utils::sanitize_filename(&detail.title, 120);
    let p = outdir.join(format!("{title}.{fmt}"));
    let text = match fmt {
        "ass" => crate::danmaku::to_ass(&dms, 1920, 1080, 36),
        "txt" => crate::danmaku::to_txt(&dms),
        "json" => crate::danmaku::to_json(&dms),
        _ => crate::danmaku::to_xml(&dms),
    };
    let size = std::fs::write(&p, text).map(|_| std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0)).unwrap_or(0);
    Ok(Json(json!({ "count": dms.len(), "path": p.display().to_string(), "size": size })))
}

async fn api_subscribe_list(State(st): State<Arc<AppState>>) -> Json<Value> {
    Json(json!({ "subs": store_of(&st).sub_list() }))
}

async fn api_subscribe_add(State(st): State<Arc<AppState>>, Json(body): Json<Value>) -> Result<Json<Value>, (StatusCode, String)> {
    let mid = body["mid"].as_str().ok_or_else(|| err("缺少 mid"))?;
    let mid_i: i64 = mid.parse().map_err(|_| err("mid 必须是数字"))?;
    let info = user::get_user_info(&st.api, mid).await.map_err(err)?;
    let mut store = store_of(&st);
    store.sub_add(mid_i, &info.name);
    store.log("subscribe", mid, "add");
    Ok(Json(json!({ "ok": true, "name": info.name })))
}

async fn api_subscribe_remove(State(st): State<Arc<AppState>>, Json(body): Json<Value>) -> Json<Value> {
    let mid = body["mid"].as_i64().unwrap_or(0);
    let mut store = store_of(&st);
    store.sub_remove(mid);
    Json(json!({ "ok": true }))
}

async fn api_subscribe_update(State(st): State<Arc<AppState>>, Json(body): Json<Value>) -> Result<Json<Value>, (StatusCode, String)> {
    let audio = body.get("audio").and_then(|v| v.as_str()).map(|s| s.to_string());
    let subs = store_of(&st).sub_list();
    if subs.is_empty() {
        return Err(err("暂无订阅，请先添加"));
    }
    let cfg = cfg_of(&st);
    let outdir = body.get("outdir").and_then(|v| v.as_str()).map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(cfg.get_str("outdir", "downloads")));
    let id = st.next_id.fetch_add(1, Ordering::SeqCst);
    let task = TaskState { id, label: "一键更新".into(), total: 0, done: 0, running: true, paused: false, at: utils::now_ts(), results: Vec::new() };
    lock_tasks(&st).push(task);

    let api = st.api.clone();
    let state = st.clone();
    tokio::spawn(async move {
        let mut total = 0usize;
        let mut new_all: Vec<(String, String, String)> = Vec::new(); // (bvid, up_name, up_mid)
        for s in &subs {
            let mid = s["mid"].as_i64().unwrap_or(0);
            let name = s["name"].as_str().unwrap_or("?").to_string();
            let last = s["last_check"].as_i64().unwrap_or(0);
            if let Ok(videos) = user::get_videos(&api, &mid.to_string(), Some(last.max(0))).await {
                let new: Vec<_> = videos.into_iter().filter(|v| v.ctime > last).collect();
                total += new.len();
                for v in new {
                    new_all.push((v.bvid, name.clone(), v.title));
                }
            }
        }
        {
            let mut tasks = lock_tasks(&state);
            if let Some(t) = tasks.iter_mut().find(|t| t.id == id) {
                t.total = total;
                t.label = format!("一键更新：{} 个新视频", total);
            }
        }

        let opts = DownloadOptions {
            quality: cfg.get_str("quality", "best"),
            audio_only: audio,
            parallel: cfg.get_int("parallel", 8) as usize,
            rate: None,
            danmaku: true,
            dm_fmt: vec!["xml".into()],
            subs: false,
            cover: true,
            force: false,
            skip: true,
            page: None,
        };
        // 按 UP 分组下载
        let mut by_up: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
        let mut up_names: std::collections::HashMap<String, String> = std::collections::HashMap::new();
        for (bvid, name, _t) in &new_all {
            by_up.entry(name.clone()).or_default().push(bvid.clone());
            up_names.insert(name.clone(), name.clone());
        }
        for (name, bvids) in &by_up {
            let target = outdir.join(utils::sanitize_filename(name, 60));
            let _ = std::fs::create_dir_all(&target);
            for b in bvids {
                // 暂停支持
                loop {
                    let paused = {
                        let tasks = lock_tasks(&state);
                        tasks.iter().find(|t| t.id == id).map(|t| t.paused).unwrap_or(false)
                    };
                    if !paused {
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                }
                let r = crate::download::download_one(&api, b, &target, &opts, None).await;
                let err = r.error.clone();
                let path = r.path.clone();
                {
                    let mut tasks = lock_tasks(&state);
                    if let Some(t) = tasks.iter_mut().find(|t| t.id == id) {
                        t.results.push(TaskResult {
                            bvid: b.clone(), title: r.title,
                            path: path.as_ref().map(|p| p.display().to_string()),
                            skipped: r.skipped, error: err.clone(),
                        });
                        t.done += 1;
                        if t.done >= t.total { t.running = false; }
                    }
                }
                if err.is_none() && path.is_some() {
                    let mut detail = video::get_detail(&api, b).await;
                    if detail.is_err() {
                        detail = video::get_detail(&api, b).await;
                    }
                    let size = std::fs::metadata(path.as_ref().unwrap()).map(|m| m.len()).unwrap_or(0);
                    let mut store = store_of(&state);
                    match detail {
                        Ok(d) => {
                            store.record_download(b, d.aid, &d.title, &d.up, d.up_mid, d.pubdate,
                                                  d.duration, &path.as_ref().unwrap().display().to_string(),
                                                  size, &opts.quality, opts.audio_only.is_some());
                        }
                        Err(_) => {
                            store.record_download(b, 0, b, "", 0, utils::now_ts(), 0,
                                                  &path.as_ref().unwrap().display().to_string(),
                                                  size, &opts.quality, opts.audio_only.is_some());
                        }
                    }
                    store.log("update", b, &path.as_ref().unwrap().display().to_string());
                }
            }
        }
        for s in &subs {
            let mid = s["mid"].as_i64().unwrap_or(0);
            let mut store = store_of(&state);
            store.sub_touch(mid, utils::now_ts());
        }
        let mut tasks = lock_tasks(&state);
        if let Some(t) = tasks.iter_mut().find(|t| t.id == id) {
            if t.running { t.running = false; }
        }
        if let Some(t) = tasks.iter().find(|t| t.id == id) {
            if !t.running {
                let mut store = store_of(&state);
                store.task_save(&serde_json::to_value(t).unwrap_or_default());
            }
        }
    });
    Ok(Json(json!({ "task_id": id })))
}

async fn api_saved(State(st): State<Arc<AppState>>) -> Json<Value> {
    let mut store = store_of(&st);
    let mut rows: Vec<Value> = Vec::new();
    let mut removed = 0usize;
    for mut r in store.list_downloaded() {
        let bvid = r["bvid"].as_str().unwrap_or("").to_string();
        let exists = r["path"]
            .as_str()
            .map(|p| std::path::Path::new(&store.absolutize_path(p, &st.base)).exists())
            .unwrap_or(false);
        if !exists {
            // 文件已不存在 → 自动移除记录（与磁盘同步）
            store.delete_record(&bvid);
            store.log("saved_sync", &bvid, "文件不存在，自动移除记录");
            removed += 1;
            continue;
        }
        if let Some(p) = r["path"].as_str() {
            r["path"] = json!(store.absolutize_path(p, &st.base));
        }
        rows.push(r);
    }
    Json(json!({ "rows": rows, "removed": removed }))
}

/// UP 的合集+系列列表（登录时用官方接口；未登录回退 ugc_season 合集扫描）
async fn api_up_seasons(State(st): State<Arc<AppState>>, Json(body): Json<Value>) -> Result<Json<Value>, (StatusCode, String)> {
    let mid = body["mid"].as_str().ok_or_else(|| err("缺少 mid"))?;
    let mut out: Vec<Value> = Vec::new();
    let mut used_login_api = false;
    // 登录接口：合集 + 系列
    if let Ok(Some(aggs)) = user::get_seasons_series(&st.api, mid).await {
        used_login_api = true;
        for a in aggs {
            out.push(json!({
                "id": a.id, "title": a.name, "count": a.count, "kind": a.kind,
            }));
        }
    }
    // 未登录或接口失败：回退 ugc_season 全量扫描（扫描全部可用视频避免漏合集）
    if out.is_empty() {
        let cached = st.season_cache.lock().unwrap().get(mid).cloned();
        let seasons = match cached {
            Some((ts, v)) if utils::now_ts() - ts < 300 => v,
            _ => {
                let seasons = user::get_seasons(&st.api, mid, 250).await.map_err(err)?;
                let list: Vec<Value> = seasons
                    .iter()
                    .map(|s| json!({
                        "id": s.id, "title": s.title, "count": s.episodes.len(), "kind": "season",
                        "episodes": s.episodes.iter().map(|e| json!({
                            "bvid": e.bvid, "title": e.title, "ctime": e.ctime,
                            "duration": e.duration, "pic": e.pic,
                        })).collect::<Vec<_>>(),
                    }))
                    .collect();
                let now = utils::now_ts();
                st.season_cache.lock().unwrap().insert(mid.to_string(), (now, list.clone()));
                list
            }
        };
        for s in &seasons {
            out.push(json!({
                "id": s["id"], "title": s["title"], "count": s["count"], "kind": "season",
            }));
        }
    }
    Ok(Json(json!({ "seasons": out, "used_login_api": used_login_api })))
}

/// 合集/系列内视频列表（kind: season=合集(ugc_season 扫描)，series=系列(登录接口)）
async fn api_season_archives(State(st): State<Arc<AppState>>, Json(body): Json<Value>) -> Result<Json<Value>, (StatusCode, String)> {
    let mid = body["mid"].as_str().ok_or_else(|| err("缺少 mid"))?;
    let season_id = body["season_id"].as_i64().ok_or_else(|| err("缺少 season_id"))?;
    let kind = body.get("kind").and_then(|v| v.as_str()).unwrap_or("season");
    let mut episodes: Vec<Value> = Vec::new();
    let mut title = String::new();
    if kind == "series" {
        let (eps, _total) = user::get_series_archives(&st.api, mid, season_id).await.map_err(err)?;
        title = format!("系列 {season_id}");
        for e in &eps {
            episodes.push(json!({
                "bvid": e.bvid, "title": e.title, "ctime": e.ctime,
                "duration": e.duration, "pic": e.pic,
            }));
        }
    } else {
        // 优先用缓存中的合集数据（避免重复全量扫描）
        let cached = st.season_cache.lock().unwrap().get(mid).cloned();
        let seasons = match cached {
            Some((ts, v)) if utils::now_ts() - ts < 300 => v,
            _ => {
                let seasons = user::get_seasons(&st.api, mid, 250).await.map_err(err)?;
                let list: Vec<Value> = seasons
                    .iter()
                    .map(|s| json!({
                        "id": s.id, "title": s.title, "count": s.episodes.len(), "kind": "season",
                        "episodes": s.episodes.iter().map(|e| json!({
                            "bvid": e.bvid, "title": e.title, "ctime": e.ctime,
                            "duration": e.duration, "pic": e.pic,
                        })).collect::<Vec<_>>(),
                    }))
                    .collect();
                let now = utils::now_ts();
                st.season_cache.lock().unwrap().insert(mid.to_string(), (now, list.clone()));
                list
            }
        };
        let Some(season) = seasons.iter().find(|s| s["id"].as_i64() == Some(season_id)) else {
            return Err(err("未找到该合集"));
        };
        title = season["title"].as_str().unwrap_or("").to_string();
        if let Some(eps) = season["episodes"].as_array() {
            episodes = eps.clone();
        }
    }
    Ok(Json(json!({ "id": season_id, "title": title, "episodes": episodes })))
}

/// 在资源管理器中打开文件所在位置（Windows）
async fn api_saved_open(State(_st): State<Arc<AppState>>, Json(body): Json<Value>) -> Result<Json<Value>, (StatusCode, String)> {
    let path = body["path"].as_str().ok_or_else(|| err("缺少 path"))?;
    let p = std::path::Path::new(path);
    if !p.exists() {
        return Err(err(format!("文件不存在: {path}")));
    }
    let p_abs = p.to_string_lossy().into_owned();
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer")
            .arg("/select,")
            .arg(&p_abs)
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .spawn()
            .map_err(|e| err(format!("打开资源管理器失败: {e}")))?;
    }
    #[cfg(not(windows))]
    {
        let _ = p_abs;
    }
    Ok(Json(json!({ "ok": true })))
}

/// 删除下载记录（保留本地文件）
/// 删除主文件及其配套文件（封面 .jpg、弹幕 .danmaku.*、字幕 .srt）。
/// 返回 (主文件已删, 配套文件数, 释放字节)。
fn delete_with_companions(path: &str) -> (bool, usize, u64) {
    let pb = std::path::Path::new(path);
    let Some(parent) = pb.parent() else { return (false, 0, 0) };
    let Some(stem) = pb.file_stem().and_then(|s| s.to_str()) else { return (false, 0, 0) };
    let mut main_deleted = false;
    let mut companions = 0usize;
    let mut freed: u64 = 0;
    if pb.exists() {
        if let Ok(m) = std::fs::metadata(pb) {
            freed += m.len();
        }
        main_deleted = std::fs::remove_file(pb).is_ok();
    }
    // 同目录扫描配套文件：{stem}.jpg / {stem}.danmaku.* / {stem}.{lang}.srt
    if let Ok(entries) = std::fs::read_dir(parent) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name == pb.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default() {
                continue; // 主文件已处理
            }
            let is_companion = name.starts_with(stem)
                && (name.ends_with(".jpg")
                    || name.contains(".danmaku.")
                    || name.ends_with(".srt"));
            if !is_companion {
                continue;
            }
            let fp = entry.path();
            if let Ok(m) = std::fs::metadata(&fp) {
                freed += m.len();
            }
            if std::fs::remove_file(&fp).is_ok() {
                companions += 1;
            }
        }
    }
    (main_deleted, companions, freed)
}

/// 清除所有已下载记录 + 删除所有本地文件
async fn api_saved_clear(State(st): State<Arc<AppState>>) -> Json<Value> {
    let mut store = store_of(&st);
    let rows = store.list_downloaded();
    let mut deleted_files = 0usize;
    let mut freed: u64 = 0;
    for r in &rows {
        let bvid = r["bvid"].as_str().unwrap_or("").to_string();
        if let Some(p) = r["path"].as_str() {
            let abs = store.absolutize_path(p, &st.base);
            let (_, comps, f) = delete_with_companions(&abs);
            deleted_files += comps;
            freed += f;
        }
        store.delete_record(&bvid);
    }
    store.log("saved_clear", "-", &format!("清除 {} 条记录，删除 {} 个文件", rows.len(), deleted_files));
    Json(json!({ "ok": true, "records": rows.len(), "files": deleted_files, "freed": freed }))
}

async fn api_saved_delete(State(st): State<Arc<AppState>>, Json(body): Json<Value>) -> Json<Value> {
    let bvid = body["bvid"].as_str().unwrap_or("");
    let delete_file = body.get("delete_file").and_then(|v| v.as_bool()).unwrap_or(false);
    let mut store = store_of(&st);
    // 记录删除前先取路径（删除文件需要）
    let path = store.is_downloaded(bvid).map(|p| store.absolutize_path(&p, &st.base));
    let removed = store.delete_record(bvid);
    let mut file_deleted = false;
    let mut companions_deleted = 0usize;
    if delete_file {
        if let Some(p) = path {
            let (main, comps, _) = delete_with_companions(&p);
            file_deleted = main;
            companions_deleted = comps;
        }
    }
    Json(json!({ "ok": removed, "bvid": bvid, "file_deleted": file_deleted,
                 "companions_deleted": companions_deleted }))
}

async fn api_history(State(st): State<Arc<AppState>>, Query(q): Query<Value>) -> Json<Value> {
    let limit = q.get("limit").and_then(|v| v.as_str()).and_then(|s| s.parse::<usize>().ok()).unwrap_or(30);
    Json(json!({ "rows": store_of(&st).history(limit) }))
}

async fn api_config_get(State(st): State<Arc<AppState>>) -> Json<Value> {
    Json(json!({ "config": cfg_of(&st).all() }))
}

async fn api_config_set(State(st): State<Arc<AppState>>, Json(body): Json<Value>) -> Result<Json<Value>, (StatusCode, String)> {
    let key = body["key"].as_str().ok_or_else(|| err("缺少 key"))?;
    let value = &body["value"];
    let mut cfg = cfg_of(&st);
    if key == "jobs" || key == "parallel" {
        let v = value.as_i64().ok_or_else(|| err("需要整数"))?;
        cfg.set(key, json!(v));
    } else if matches!(key, "danmaku" | "cover" | "subs") {
        let v = value.as_bool().unwrap_or(false);
        cfg.set(key, json!(v));
    } else {
        let v = value.as_str().unwrap_or("");
        cfg.set(key, json!(v));
    }
    Ok(Json(json!({ "ok": true })))
}

async fn api_login_status(State(st): State<Arc<AppState>>) -> Json<Value> {
    let logged = st.api.is_logged_in();
    let uid = if logged { st.api.login_info().0 } else { String::new() };
    Json(json!({ "logged": logged, "uid": uid }))
}

async fn api_login_qr(State(st): State<Arc<AppState>>) -> Result<Json<Value>, (StatusCode, String)> {
    let d = st.api
        .get_json("https://passport.bilibili.com/x/passport-login/web/qrcode/generate", &[], false, None)
        .await
        .map_err(err)?;
    let url = d["data"]["url"].as_str().unwrap_or("").to_string();
    let key = d["data"]["qrcode_key"].as_str().unwrap_or("").to_string();
    Ok(Json(json!({ "url": url, "key": key })))
}

async fn api_login_poll(State(st): State<Arc<AppState>>, Json(body): Json<Value>) -> Result<Json<Value>, (StatusCode, String)> {
    let key = body["key"].as_str().ok_or_else(|| err("缺少 key"))?;
    let d = st.api
        .get_json(
            "https://passport.bilibili.com/x/passport-login/web/qrcode/poll",
            &[("qrcode_key", key)],
            false,
            None,
        )
        .await
        .map_err(err)?;
    // 注意：真实扫码状态在 data.code（顶层 code 只是接口本身成功）
    let data = &d["data"];
    let code = data.get("code").and_then(|c| c.as_i64()).unwrap_or(-1);
    if code == 0 {
        let url = data["url"].as_str().unwrap_or("");
        // 解析 url 参数（percent-decode，键大小写不敏感）
        let mut cookies = std::collections::HashMap::new();
        if let Some(q) = url.split('?').nth(1) {
            for seg in q.split('&') {
                if let Some((k, v)) = seg.split_once('=') {
                    cookies.insert(percent_decode(k).to_uppercase(), percent_decode(v));
                }
            }
        }
        // B 站新版流程：url 可能是 crossDomain?ticket=xxx 中转地址，
        // SESSDATA 等 cookie 需再请求该地址从 Set-Cookie 获取
        let mut chain_err = String::new();
        if cookies.get("SESSDATA").is_none() && !url.is_empty() {
            match st.api.fetch_cookies_chain(url).await {
                Ok(chain) => {
                    for (k, v) in chain {
                        cookies.entry(k.to_uppercase()).or_insert(v);
                    }
                }
                Err(e) => chain_err = format!("；cookie 链: {e}"),
            }
        }
        if cookies.get("SESSDATA").is_none() {
            // 诊断信息：返回响应摘要便于排查
            let snippet = serde_json::to_string(&data).unwrap_or_default();
            let brief: String = snippet.chars().take(220).collect();
            return Ok(Json(json!({ "ok": false, "code": -1,
                "msg": format!("登录响应缺少 SESSDATA，请重试（响应: {brief}{chain_err}）") })));
        }
        st.api.save_cookies(&cookies);
        let uid = cookies.get("DEDEUSERID").cloned().or_else(|| cookies.get("DedeUserID").cloned()).unwrap_or_default();
        // 校验 SESSDATA 有效性：必须带上完整 cookie（含 SESSDATA）调 nav
        let cookie_str = st.api.auth_cookie().await;
        let d2 = st.api
            .get_json("https://api.bilibili.com/x/web-interface/nav", &[], false, Some(&cookie_str))
            .await
            .unwrap_or_default();
        let valid = d2.get("data").and_then(|x| x.get("isLogin")).and_then(|x| x.as_bool()).unwrap_or(false);
        if !valid {
            let _ = std::fs::remove_file(st.api.cookie_file());
            return Ok(Json(json!({ "ok": false, "code": -2, "msg": "SESSDATA 无效，请重新扫码" })));
        }
        Ok(Json(json!({ "ok": true, "uid": uid })))
    } else {
        let msg = match code {
            86038 => "二维码已失效，请重新扫码",
            86090 => "已扫码，请在手机上确认",
            86101 => "等待扫码",
            _ => "未知状态",
        };
        Ok(Json(json!({ "ok": false, "code": code, "msg": msg })))
    }
}

// ---------------------------------------------------------------- 服务入口

pub async fn serve(port: u16, api: BiliApi, base: PathBuf) -> Result<(), String> {
    let state = Arc::new(AppState::new(api, base.clone()));
    let app = Router::new()
        .route("/", get(static_handler))
        .route("/{*path}", get(static_handler))
        .route("/api/up/info", post(api_up_info))
        .route("/api/up/videos", post(api_up_videos))
        .route("/api/video/info", post(api_video_info))
        .route("/api/up/seasons", post(api_up_seasons))
        .route("/api/season/archives", post(api_season_archives))
        .route("/api/download/start", post(api_download_start))
        .route("/api/tasks", get(api_tasks))
        .route("/api/task/cancel", post(api_task_cancel))
        .route("/api/task/pause", post(api_task_pause))
        .route("/api/task/delete", post(api_task_delete))
        .route("/api/search", post(api_search))
        .route("/api/danmaku", get(api_danmaku))
        .route("/api/cover", get(api_cover))
        .route("/api/subscribe/list", get(api_subscribe_list))
        .route("/api/subscribe/add", post(api_subscribe_add))
        .route("/api/subscribe/remove", post(api_subscribe_remove))
        .route("/api/subscribe/update", post(api_subscribe_update))
        .route("/api/saved", get(api_saved))
        .route("/api/saved/open", post(api_saved_open))
        .route("/api/saved/delete", post(api_saved_delete))
        .route("/api/saved/clear", post(api_saved_clear))
        .route("/api/history", get(api_history))
        .route("/api/config", get(api_config_get))
        .route("/api/config/set", post(api_config_set))
        .route("/api/login/status", get(api_login_status))
        .route("/api/login/qr", post(api_login_qr))
        .route("/api/login/poll", post(api_login_poll))
        .with_state(state);

    let addr = format!("127.0.0.1:{port}");
    let listener = match tokio::net::TcpListener::bind(&addr).await {
        Ok(l) => l,
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
            // 已有实例在运行：打开浏览器连到旧实例，友好提示而不是静默退出
            open_browser(&addr);
            return Err(format!("端口 {port} 已被占用，bili-tool 可能已在运行（浏览器已打开）"));
        }
        Err(e) => return Err(format!("端口 {port} 绑定失败: {e}")),
    };
    println!("bili-tool Web 界面已启动: http://{addr}");
    println!("按 Ctrl+C 停止服务");
    open_browser(&addr);
    axum::serve(listener, app).await.map_err(|e| format!("服务异常: {e}"))?;
    Ok(())
}
