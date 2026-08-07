//! 搜索与热门榜模块。

use serde_json::Value;

use crate::api::{ApiError, BiliApi};

fn s(v: &Value, key: &str) -> String {
    v.get(key).and_then(|x| x.as_str()).unwrap_or("").to_string()
}
fn i64_(v: &Value, key: &str) -> i64 {
    v.get(key).and_then(|x| x.as_i64()).unwrap_or(0)
}

fn strip_em(s: &str) -> String {
    s.replace("<em class=\"keyword\">", "").replace("</em>", "")
}

/// 解析 B 站时长字符串："1:23" / "1:02:03" → 秒（搜索接口返回的是字符串格式）
fn parse_duration(s: &str) -> i64 {
    let parts: Vec<&str> = s.split(':').collect();
    if parts.is_empty() {
        return 0;
    }
    let mut sec: i64 = 0;
    for p in parts {
        sec = sec * 60 + p.trim().parse::<i64>().unwrap_or(0);
    }
    sec
}

/// 封面 URL 规范化：//xx → https://xx，http:// → https://
fn normalize_pic(pic: &str) -> String {
    if let Some(stripped) = pic.strip_prefix("//") {
        format!("https://{stripped}")
    } else if let Some(stripped) = pic.strip_prefix("http://") {
        format!("https://{stripped}")
    } else {
        pic.to_string()
    }
}

#[allow(dead_code)]
pub struct SearchVideo {
    pub bvid: String,
    pub title: String,
    pub up: String,
    pub up_mid: i64,
    pub duration: i64,
    pub view: i64,
    pub danmaku: i64,
    pub pubdate: i64,
    pub pic: String,
}

pub struct SearchUser {
    pub mid: i64,
    pub name: String,
    pub fans: i64,
    pub videos: i64,
    pub sign: String,
}

#[allow(dead_code)]
pub struct SearchBangumi {
    pub season_id: i64,
    pub title: String,
    pub score: f64,
    pub play: i64,
    pub desc: String,
}

#[allow(dead_code)]
pub struct TrendingItem {
    pub bvid: String,
    pub title: String,
    pub up: String,
    pub play: i64,
    pub danmaku: i64,
    pub score: f64,
    pub pic: String,
}

pub async fn search_videos(api: &BiliApi, keyword: &str, pages: i64, order: &str) -> Result<Vec<SearchVideo>, ApiError> {
    let mut out = Vec::new();
    for p in 1..=pages.max(1) {
        let d = api
            .wbi_get(
                "https://api.bilibili.com/x/web-interface/search/type",
                &[
                    ("search_type", "video"),
                    ("keyword", keyword),
                    ("page", &p.to_string()),
                    ("order", order),
                    ("duration", "0"),
                    ("tids_1", "0"),
                ],
                None,
            )
            .await?;
        if d.get("code").and_then(|c| c.as_i64()) != Some(0) {
            return Err(ApiError(format!(
                "搜索失败: {} {}",
                i64_(&d, "code"),
                s(&d, "message")
            )));
        }
        let results = d["data"]["result"].as_array().cloned().unwrap_or_default();
        if results.is_empty() {
            break;
        }
        for v in &results {
            let pic = normalize_pic(&s(v, "pic"));
            out.push(SearchVideo {
                bvid: s(v, "bvid"),
                title: strip_em(&s(v, "title")),
                up: s(v, "author"),
                up_mid: i64_(v, "mid"),
                duration: parse_duration(&s(v, "duration")),
                view: i64_(v, "play"),
                danmaku: i64_(v, "video_review"),
                pubdate: i64_(v, "pubdate"),
                pic,
            });
        }
        crate::utils::sleep_jitter(0.4).await;
    }
    Ok(out)
}

pub async fn search_users(api: &BiliApi, keyword: &str, pages: i64) -> Result<Vec<SearchUser>, ApiError> {
    let mut out = Vec::new();
    for p in 1..=pages.max(1) {
        let d = api
            .wbi_get(
                "https://api.bilibili.com/x/web-interface/search/type",
                &[("search_type", "bili_user"), ("keyword", keyword), ("page", &p.to_string())],
                None,
            )
            .await?;
        if d.get("code").and_then(|c| c.as_i64()) != Some(0) {
            return Err(ApiError(format!(
                "搜索用户失败: {} {}",
                i64_(&d, "code"),
                s(&d, "message")
            )));
        }
        let results = d["data"]["result"].as_array().cloned().unwrap_or_default();
        if results.is_empty() {
            break;
        }
        for u in &results {
            out.push(SearchUser {
                mid: i64_(u, "mid"),
                name: s(u, "uname"),
                fans: i64_(u, "fans"),
                videos: i64_(u, "videos"),
                sign: s(u, "usign"),
            });
        }
        crate::utils::sleep_jitter(0.4).await;
    }
    Ok(out)
}

pub async fn search_bangumi(api: &BiliApi, keyword: &str, pages: i64) -> Result<Vec<SearchBangumi>, ApiError> {
    let mut out = Vec::new();
    for p in 1..=pages.max(1) {
        let d = api
            .wbi_get(
                "https://api.bilibili.com/x/web-interface/search/type",
                &[("search_type", "media_bangumi"), ("keyword", keyword), ("page", &p.to_string())],
                None,
            )
            .await?;
        if d.get("code").and_then(|c| c.as_i64()) != Some(0) {
            return Err(ApiError(format!(
                "搜索番剧失败: {} {}",
                i64_(&d, "code"),
                s(&d, "message")
            )));
        }
        let results = d["data"]["result"].as_array().cloned().unwrap_or_default();
        if results.is_empty() {
            break;
        }
        for m in &results {
            out.push(SearchBangumi {
                season_id: i64_(m, "season_id"),
                title: strip_em(&s(m, "title")),
                score: m.get("score").and_then(|x| x.as_f64()).unwrap_or(0.0),
                play: i64_(m, "play_count"),
                desc: s(m, "desc"),
            });
        }
        crate::utils::sleep_jitter(0.4).await;
    }
    Ok(out)
}

pub async fn trending(api: &BiliApi, rid: i64) -> Result<Vec<TrendingItem>, ApiError> {
    let d = api
        .wbi_get(
            "https://api.bilibili.com/x/web-interface/ranking/v2",
            &[("rid", &rid.to_string()), ("type", "all")],
            None,
        )
        .await?;
    if d.get("code").and_then(|c| c.as_i64()) != Some(0) {
        return Err(ApiError(format!(
            "获取榜单失败: {} {}",
            i64_(&d, "code"),
            s(&d, "message")
        )));
    }
    let mut out = Vec::new();
    for v in d["data"]["list"].as_array().unwrap_or(&vec![]) {
        let pic = normalize_pic(&s(v, "pic"));
        out.push(TrendingItem {
            bvid: s(v, "bvid"),
            title: s(v, "title"),
            up: s(&v["owner"], "name"),
            play: i64_(&v["stat"], "view"),
            danmaku: i64_(&v["stat"], "danmaku"),
            score: v.get("score").and_then(|x| x.as_f64()).unwrap_or(0.0),
            pic,
        });
    }
    Ok(out)
}
