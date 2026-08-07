//! UP 主模块：信息、全量视频列表（app API + aid 游标）、合集（ugc_season）

use serde_json::Value;

use crate::api::{ApiError, BiliApi};

pub struct UpInfo {
    pub mid: String,
    pub name: String,
    pub face: String,
    pub sign: String,
    pub level: i64,
    pub sex: String,
    pub official: String,
    pub fans: i64,
    pub following: i64,
    pub archives: i64,
    pub likes: i64,
}

#[derive(Clone)]
pub struct Video {
    pub bvid: String,
    pub aid: String,
    pub title: String,
    pub ctime: i64,
    pub duration: i64,
    pub play: i64,
    pub danmaku: i64,
    pub comment: i64,
    pub tname: String,
    pub pic: String,
}

pub struct Season {
    pub id: i64,
    pub title: String,
    pub episodes: Vec<SeasonEp>,
}

#[allow(dead_code)]
pub struct SeasonEp {
    pub bvid: String,
    pub title: String,
    pub ctime: i64,
    pub duration: i64,
    pub pic: String,
}

fn s(v: &Value, key: &str) -> String {
    v.get(key).and_then(|x| x.as_str()).unwrap_or("").to_string()
}
fn i64_(v: &Value, key: &str) -> i64 {
    v.get(key).and_then(|x| x.as_i64()).unwrap_or(0)
}

/// UP 信息（card 接口，无需 WBI）
pub async fn get_user_info(api: &BiliApi, mid: &str) -> Result<UpInfo, ApiError> {
    let d = api
        .get_json(
            "https://api.bilibili.com/x/web-interface/card",
            &[("mid", mid), ("photo", "false")],
            false,
            Some(&api.auth_cookie().await),
        )
        .await?;
    if d.get("code").and_then(|c| c.as_i64()) != Some(0) {
        return Err(ApiError(format!(
            "获取用户信息失败: {} {}",
            i64_(&d, "code"),
            s(&d, "message")
        )));
    }
    let card = &d["data"]["card"];
    let data = &d["data"];
    let mut face = s(card, "face");
    if let Some(stripped) = face.strip_prefix("//") {
        face = format!("https://{stripped}");
    } else if let Some(stripped) = face.strip_prefix("http://") {
        face = format!("https://{stripped}");
    }
    Ok(UpInfo {
        mid: s(card, "mid"),
        name: s(card, "name"),
        face,
        sign: s(card, "sign"),
        level: i64_(&card["level_info"], "current_level"),
        sex: s(card, "sex"),
        official: s(&card["official_verify"], "desc"),
        fans: i64_(data, "follower"),
        following: i64_(data, "following"),
        archives: i64_(data, "archive_count"),
        likes: i64_(data, "like_num"),
    })
}

/// 拉取 UP 全部视频（app API，aid 游标分页；min_ctime 提前终止）
pub async fn get_videos(api: &BiliApi, mid: &str, min_ctime: Option<i64>) -> Result<Vec<Video>, ApiError> {
    let mut videos = Vec::new();
    let mut aid: Option<String> = None;
    let mut seen = std::collections::HashSet::new();
    for _page in 0..200 {
        let mut params = vec![("vmid", mid), ("pn", "1"), ("ps", "30")];
        if let Some(a) = &aid {
            params.push(("aid", a.as_str()));
        }
        let d = api
            .app_get("https://app.bilibili.com/x/v2/space/archive/cursor", &params)
            .await?;
        if d.get("code").and_then(|c| c.as_i64()) != Some(0) {
            return Err(ApiError(format!(
                "拉取视频列表失败: {} {}",
                i64_(&d, "code"),
                s(&d, "message")
            )));
        }
        let items = d["data"]["item"].as_array().cloned().unwrap_or_default();
        let mut fresh: Vec<&Value> = Vec::new();
        for v in &items {
            let p = s(v, "param");
            if !p.is_empty() && seen.insert(p) {
                fresh.push(v);
            }
        }
        for v in &fresh {
            let mut pic = s(v, "cover");
            if let Some(stripped) = pic.strip_prefix("//") {
                pic = format!("https://{stripped}");
            } else if let Some(stripped) = pic.strip_prefix("http://") {
                pic = format!("https://{stripped}");
            }
            videos.push(Video {
                bvid: s(v, "bvid"),
                aid: s(v, "param"),
                title: s(v, "title"),
                ctime: i64_(v, "ctime"),
                duration: i64_(v, "duration"),
                play: i64_(v, "play"),
                danmaku: i64_(v, "danmaku"),
                comment: i64_(v, "reply"),
                tname: s(v, "tname"),
                pic,
            });
        }
        let total = d["data"]["count"].as_i64().unwrap_or(0);
        // 按时间倒序，本页全部早于下限即终止
        if let Some(mc) = min_ctime {
            if !items.is_empty() && items.iter().all(|v| i64_(v, "ctime") < mc) {
                break;
            }
        }
        if fresh.is_empty() || videos.len() as i64 >= total {
            break;
        }
        aid = Some(s(fresh.last().unwrap(), "param"));
        crate::utils::sleep_jitter(0.6).await;
    }
    Ok(videos)
}

/// 合集/系列聚合条目（登录接口 seasons_series_list）
pub struct Aggregate {
    pub id: i64,
    pub name: String,
    pub kind: String,      // "season" 合集 / "series" 系列
    pub count: i64,
}

/// （需登录）获取合集+系列列表。未登录/被拒时返回 Ok(None) 由调用方回退。
pub async fn get_seasons_series(api: &BiliApi, mid: &str) -> Result<Option<Vec<Aggregate>>, ApiError> {
    let cookie = api.auth_cookie().await;
    let d = api
        .wbi_get(
            "https://api.bilibili.com/x/polymer/web-space/seasons_series_list",
            &[("mid", mid), ("page_num", "1"), ("page_size", "100"), ("filtered", "0")],
            Some(&cookie),
        )
        .await?;
    if d.get("code").and_then(|c| c.as_i64()) != Some(0) {
        return Ok(None); // 未登录/-400 → 调用方回退 ugc_season
    }
    let lists = &d["data"]["items_lists"];
    let mut out = Vec::new();
    for item in lists["seasons_list"].as_array().unwrap_or(&vec![]) {
        let meta = &item["meta"];
        let sid = meta["season_id"].as_i64().unwrap_or(0);
        if sid > 0 {
            out.push(Aggregate {
                id: sid,
                name: s(meta, "name"),
                kind: "season".into(),
                count: item["archives_count"].as_i64().unwrap_or(0),
            });
        }
    }
    for item in lists["series_list"].as_array().unwrap_or(&vec![]) {
        let meta = &item["meta"];
        let sid = meta["series_id"].as_i64().unwrap_or(0);
        if sid > 0 {
            out.push(Aggregate {
                id: sid,
                name: s(meta, "name"),
                kind: "series".into(),
                count: item["archives_count"].as_i64().unwrap_or(0),
            });
        }
    }
    Ok(Some(out))
}

/// （需登录）系列内视频列表
pub async fn get_series_archives(api: &BiliApi, mid: &str, series_id: i64) -> Result<(Vec<SeasonEp>, i64), ApiError> {
    let cookie = api.auth_cookie().await;
    let d = api
        .wbi_get(
            "https://api.bilibili.com/x/series/archives",
            &[("mid", mid), ("series_id", &series_id.to_string()),
              ("only_normal", "true"), ("pn", "1"), ("ps", "30")],
            Some(&cookie),
        )
        .await?;
    if d.get("code").and_then(|c| c.as_i64()) != Some(0) {
        return Err(ApiError(format!(
            "获取系列视频失败（可能需要登录）: {} {}",
            i64_(&d, "code"), s(&d, "message")
        )));
    }
    let data = &d["data"];
    let items = data["archives"].as_array().cloned().unwrap_or_default();
    let mut out = Vec::new();
    for v in &items {
        let mut pic = s(v, "pic");
        if let Some(stripped) = pic.strip_prefix("//") {
            pic = format!("https://{stripped}");
        } else if let Some(stripped) = pic.strip_prefix("http://") {
            pic = format!("https://{stripped}");
        }
        out.push(SeasonEp {
            bvid: s(v, "bvid"),
            title: s(v, "title"),
            ctime: i64_(v, "pubdate"),
            duration: i64_(v, "duration"),
            pic,
        });
    }
    let total = data["page"]["total"].as_i64().unwrap_or(out.len() as i64);
    Ok((out, total))
}

pub struct FavFolder {
    pub id: i64,
    pub title: String,
    pub count: i64,
}

#[allow(dead_code)]
pub struct FavArchive {
    pub bvid: String,
    pub title: String,
    pub ctime: i64,
    pub duration: i64,
    pub up: String,
}

/// （需登录）获取自己的收藏夹列表
pub async fn get_fav_folders(api: &BiliApi, uid: &str) -> Result<Vec<FavFolder>, ApiError> {
    let d = api
        .wbi_get(
            "https://api.bilibili.com/x/v3/fav/folder/created/list-all",
            &[("up_mid", uid)],
            None,
        )
        .await?;
    if d.get("code").and_then(|c| c.as_i64()) != Some(0) {
        return Err(ApiError(format!(
            "获取收藏夹失败（可能需要登录）: {} {}",
            i64_(&d, "code"),
            s(&d, "message")
        )));
    }
    let mut out = Vec::new();
    for f in d["data"]["list"].as_array().unwrap_or(&vec![]) {
        out.push(FavFolder {
            id: i64_(f, "id"),
            title: s(f, "title"),
            count: i64_(f, "media_count"),
        });
    }
    Ok(out)
}

/// 收藏夹内容（公开 media_id 无需登录）
pub async fn get_fav_archives(api: &BiliApi, media_id: &str) -> Result<(Vec<FavArchive>, i64), ApiError> {
    let mut out = Vec::new();
    let mut total = 0i64;
    for pn in 1..=30 {
        let d = api
            .wbi_get(
                "https://api.bilibili.com/x/v3/fav/resource/list",
                &[("media_id", media_id), ("pn", &pn.to_string()), ("ps", "20"), ("platform", "web")],
                None,
            )
            .await?;
        if d.get("code").and_then(|c| c.as_i64()) != Some(0) {
            return Err(ApiError(format!(
                "获取收藏内容失败: {} {}",
                i64_(&d, "code"),
                s(&d, "message")
            )));
        }
        let data = &d["data"];
        total = data["info"]["media_count"].as_i64().unwrap_or(0);
        let medias = data["medias"].as_array().cloned().unwrap_or_default();
        if medias.is_empty() {
            break;
        }
        for m in &medias {
            out.push(FavArchive {
                bvid: s(m, "bvid"),
                title: s(m, "title"),
                ctime: i64_(m, "fav_time"),
                duration: i64_(m, "duration"),
                up: s(&m["upper"], "name"),
            });
        }
        if out.len() as i64 >= total || medias.len() < 20 {
            break;
        }
        crate::utils::sleep_jitter(0.4).await;
    }
    Ok((out, total))
}

/// UP 的合集（从最近 scan 个视频的 view 响应收集 ugc_season）
pub async fn get_seasons(api: &BiliApi, mid: &str, scan: usize) -> Result<Vec<Season>, ApiError> {
    let videos = get_videos(api, mid, None).await?;
    let target: Vec<String> = videos.iter().take(scan).map(|v| v.bvid.clone()).collect();
    let mut seasons: Vec<Season> = Vec::new();
    let mut seen_ids = std::collections::HashSet::new();

    // 大范围扫描时并发 8 个 view 请求
    if target.len() > 30 {
        use futures::stream::{self, StreamExt};
        let api = api.clone();
        let results: Vec<Option<(i64, String, Vec<SeasonEp>)>> = stream::iter(target)
            .map(|bvid| {
                let api = api.clone();
                async move {
                    let d = api
                        .get_json(
                            "https://api.bilibili.com/x/web-interface/view",
                            &[("bvid", bvid.as_str())],
                            false,
                            Some(&api.auth_cookie().await),
                        )
                        .await
                        .ok()?;
                    let us = &d["data"]["ugc_season"];
                    if us.is_null() {
                        return None;
                    }
                    let id = us["id"].as_i64().unwrap_or(0);
                    if id == 0 {
                        return None;
                    }
                    let mut eps = Vec::new();
                    for sec in us["sections"].as_array().unwrap_or(&vec![]) {
                        for ep in sec["episodes"].as_array().unwrap_or(&vec![]) {
                            let arc = &ep["arc"];
                            let mut pic = s(arc, "pic");
                            if let Some(stripped) = pic.strip_prefix("//") {
                                pic = format!("https://{stripped}");
                            } else if let Some(stripped) = pic.strip_prefix("http://") {
                                pic = format!("https://{stripped}");
                            }
                            eps.push(SeasonEp {
                                bvid: s(ep, "bvid"),
                                title: {
                                    let t = s(ep, "title");
                                    if t.is_empty() { s(arc, "title") } else { t }
                                },
                                ctime: i64_(arc, "pubdate"),
                                duration: i64_(arc, "duration"),
                                pic,
                            });
                        }
                    }
                    Some((id, s(us, "title"), eps))
                }
            })
            .buffer_unordered(8)
            .collect::<Vec<_>>()
            .await;
        for r in results.into_iter().flatten() {
            let (id, title, eps) = r;
            if !seen_ids.insert(id) {
                continue;
            }
            seasons.push(Season { id, title, episodes: eps });
        }
        return Ok(seasons);
    }

    for bvid in target {
        let d = api
            .get_json(
                "https://api.bilibili.com/x/web-interface/view",
                &[("bvid", bvid.as_str())],
                false,
                Some(&api.auth_cookie().await),
            )
            .await;
        let Ok(d) = d else { continue };
        let us = &d["data"]["ugc_season"];
        if us.is_null() {
            continue;
        }
        let id = us["id"].as_i64().unwrap_or(0);
        if id == 0 || !seen_ids.insert(id) {
            continue;
        }
        let mut eps = Vec::new();
        for sec in us["sections"].as_array().unwrap_or(&vec![]) {
            for ep in sec["episodes"].as_array().unwrap_or(&vec![]) {
                let arc = &ep["arc"];
                let mut pic = s(arc, "pic");
                if let Some(stripped) = pic.strip_prefix("//") {
                    pic = format!("https://{stripped}");
                } else if let Some(stripped) = pic.strip_prefix("http://") {
                    pic = format!("https://{stripped}");
                }
                eps.push(SeasonEp {
                    bvid: s(ep, "bvid"),
                    title: {
                        let t = s(ep, "title");
                        if t.is_empty() { s(arc, "title") } else { t }
                    },
                    ctime: i64_(arc, "pubdate"),
                    duration: i64_(arc, "duration"),
                    pic,
                });
            }
        }
        eps.sort_by_key(|e| e.ctime);
        seasons.push(Season { id, title: s(us, "title"), episodes: eps });
    }
    Ok(seasons)
}
