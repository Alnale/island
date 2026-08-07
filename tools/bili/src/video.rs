//! 视频模块：详情、playurl 直链、字幕、评论。

use serde_json::Value;

use crate::api::{ApiError, BiliApi};
use crate::utils;

fn s(v: &Value, key: &str) -> String {
    v.get(key).and_then(|x| x.as_str()).unwrap_or("").to_string()
}
fn i64_(v: &Value, key: &str) -> i64 {
    v.get(key).and_then(|x| x.as_i64()).unwrap_or(0)
}

pub struct Page {
    pub cid: i64,
    pub title: String,
    pub duration: i64,
}

pub struct VideoDetail {
    pub bvid: String,
    pub aid: i64,
    pub title: String,
    pub desc: String,
    pub pic: String,
    pub pubdate: i64,
    pub duration: i64,
    pub view: i64,
    pub danmaku: i64,
    pub reply: i64,
    pub like: i64,
    pub coin: i64,
    pub favorite: i64,
    pub share: i64,
    pub up: String,
    pub up_mid: i64,
    pub cid: i64,
    pub tname: String,
    pub pages: Vec<Page>,
    #[allow(dead_code)]
    pub ugc_season: Value,
}

impl VideoDetail {
    pub fn to_json(&self) -> Value {
        serde_json::json!({
            "bvid": self.bvid, "aid": self.aid, "title": self.title, "desc": self.desc,
            "pic": self.pic, "pubdate": self.pubdate, "duration": self.duration,
            "view": self.view, "danmaku": self.danmaku, "reply": self.reply,
            "like": self.like, "coin": self.coin, "favorite": self.favorite,
            "share": self.share, "up": self.up, "up_mid": self.up_mid, "cid": self.cid,
            "tname": self.tname, "pages": self.pages.iter().map(|p| serde_json::json!({
                "cid": p.cid, "title": p.title, "duration": p.duration})).collect::<Vec<_>>(),
        })
    }
}

pub async fn get_detail(api: &BiliApi, bvid: &str) -> Result<VideoDetail, ApiError> {
    let d = api
        .get_json(
            "https://api.bilibili.com/x/web-interface/view",
            &[("bvid", bvid)],
            false,
            Some(&api.auth_cookie().await),
        )
        .await?;
    if d.get("code").and_then(|c| c.as_i64()) != Some(0) {
        return Err(ApiError(format!(
            "获取视频详情失败 {bvid}: {} {}",
            i64_(&d, "code"),
            s(&d, "message")
        )));
    }
    let v = &d["data"];
    let stat = &v["stat"];
    let owner = &v["owner"];
    let pages = v["pages"]
        .as_array()
        .unwrap_or(&vec![])
        .iter()
        .map(|p| Page {
            cid: i64_(p, "cid"),
            title: s(p, "part"),
            duration: i64_(p, "duration"),
        })
        .collect();
    Ok(VideoDetail {
        bvid: s(v, "bvid"),
        aid: i64_(v, "aid"),
        title: s(v, "title"),
        desc: s(v, "desc"),
        pic: s(v, "pic"),
        pubdate: i64_(v, "pubdate"),
        duration: i64_(v, "duration"),
        view: i64_(stat, "view"),
        danmaku: i64_(stat, "danmaku"),
        reply: i64_(stat, "reply"),
        like: i64_(stat, "like"),
        coin: i64_(stat, "coin"),
        favorite: i64_(stat, "favorite"),
        share: i64_(stat, "share"),
        up: s(owner, "name"),
        up_mid: i64_(owner, "mid"),
        cid: i64_(v, "cid"),
        tname: s(v, "tname"),
        pages,
        ugc_season: v.get("ugc_season").cloned().unwrap_or(Value::Null),
    })
}

/// playurl 直链（dash）。返回 (audio 列表, video 列表, durl 兜底)。
pub struct PlayUrls {
    pub audio: Vec<Stream>,
    pub video: Vec<Stream>,
    pub durl: Vec<Stream>,
}

#[allow(dead_code)]
pub struct Stream {
    pub id: i64,
    pub base_url: String,
    pub bandwidth: i64,
    pub width: i64,
    pub height: i64,
    pub codecs: String,
    pub mime: String,
}

pub async fn get_playurl(api: &BiliApi, bvid: &str, cid: i64) -> Result<PlayUrls, ApiError> {
    let d = api
        .wbi_get(
            "https://api.bilibili.com/x/player/playurl",
            &[
                ("bvid", bvid),
                ("cid", &cid.to_string()),
                ("qn", "80"),
                ("fnval", "16"),
                ("fnver", "0"),
                ("fourk", "1"),
            ],
            Some(&api.auth_cookie().await),
        )
        .await?;
    if d.get("code").and_then(|c| c.as_i64()) != Some(0) {
        return Err(ApiError(format!(
            "获取播放地址失败 {bvid}: {} {}",
            i64_(&d, "code"),
            s(&d, "message")
        )));
    }
    let dash = &d["data"]["dash"];
    let mut audio = Vec::new();
    let mut video = Vec::new();
    for a in dash["audio"].as_array().unwrap_or(&vec![]) {
        audio.push(Stream {
            id: i64_(a, "id"),
            base_url: s(a, "baseUrl"),
            bandwidth: i64_(a, "bandwidth"),
            width: 0,
            height: 0,
            codecs: s(a, "codecs"),
            mime: s(a, "mimeType"),
        });
    }
    for v in dash["video"].as_array().unwrap_or(&vec![]) {
        video.push(Stream {
            id: i64_(v, "id"),
            base_url: s(v, "baseUrl"),
            bandwidth: i64_(v, "bandwidth"),
            width: i64_(v, "width"),
            height: i64_(v, "height"),
            codecs: s(v, "codecs"),
            mime: s(v, "mimeType"),
        });
    }
    let mut durl = Vec::new();
    for du in d["data"]["durl"].as_array().unwrap_or(&vec![]) {
        durl.push(Stream {
            id: 0,
            base_url: s(du, "url"),
            bandwidth: 0,
            width: 0,
            height: 0,
            codecs: String::new(),
            mime: String::new(),
        });
    }
    Ok(PlayUrls { audio, video, durl })
}

pub struct Subtitle {
    pub lan: String,
    pub lan_doc: String,
    pub url: String,
}

pub async fn get_subtitles(api: &BiliApi, bvid: &str, cid: i64) -> Result<Vec<Subtitle>, ApiError> {
    let d = api
        .wbi_get(
            "https://api.bilibili.com/x/player/wbi/v2",
            &[("bvid", bvid), ("cid", &cid.to_string())],
            None,
        )
        .await?;
    let mut out = Vec::new();
    for sub in d["data"]["subtitle"]["subtitles"].as_array().unwrap_or(&vec![]) {
        let mut u = s(sub, "subtitle_url");
        if u.is_empty() {
            continue;
        }
        if !u.starts_with("http") {
            u = format!("https:{u}");
        }
        out.push(Subtitle { lan: s(sub, "lan"), lan_doc: s(sub, "lan_doc"), url: u });
    }
    Ok(out)
}

/// 字幕 JSON -> [(start, end, content)]
pub async fn download_subtitle_json(api: &BiliApi, url: &str) -> Result<Vec<(f64, f64, String)>, ApiError> {
    let d = api.get_json(url, &[], false, None).await?;
    let mut out = Vec::new();
    for seg in d["body"].as_array().unwrap_or(&vec![]) {
        let start = seg["from"].as_f64().unwrap_or(0.0);
        let dur = seg["duration"].as_f64().unwrap_or(3.0);
        out.push((start, start + dur, s(seg, "content")));
    }
    Ok(out)
}

pub fn subtitles_to_srt(segs: &[(f64, f64, String)]) -> String {
    let mut lines = Vec::new();
    for (i, (start, end, content)) in segs.iter().enumerate() {
        let ts = |t: f64| {
            let h = (t / 3600.0) as i64;
            let m = (t % 3600.0 / 60.0) as i64;
            let sec = (t % 60.0) as i64;
            let ms = ((t - t.floor()) * 1000.0) as i64;
            format!("{h:02}:{m:02}:{sec:02},{ms:03}")
        };
        lines.push(format!("{}\n{} --> {}\n{}", i + 1, ts(*start), ts(*end), content));
    }
    lines.join("\n")
}

pub struct Comment {
    pub user: String,
    pub uid: i64,
    pub like: i64,
    pub ctime: i64,
    pub reply_count: i64,
    pub content: String,
}

pub async fn get_comments(api: &BiliApi, bvid: &str, pages: i64) -> Result<Vec<Comment>, ApiError> {
    let detail = get_detail(api, bvid).await?;
    let aid = detail.aid.to_string();
    let mut out = Vec::new();
    let mut next = 0i64;
    for _ in 0..pages.max(1) {
        let d = api
            .wbi_get(
                "https://api.bilibili.com/x/v2/reply/wbi/main",
                &[("type", "1"), ("oid", &aid), ("mode", "3"), ("next", &next.to_string())],
                None,
            )
            .await?;
        let data = &d["data"];
        let replies = data["replies"].as_array().cloned().unwrap_or_default();
        if replies.is_empty() {
            break;
        }
        for r in &replies {
            out.push(Comment {
                user: s(&r["member"], "uname"),
                uid: i64_(&r["member"], "mid"),
                like: i64_(r, "like"),
                ctime: i64_(r, "ctime"),
                reply_count: i64_(r, "rcount"),
                content: s(&r["content"], "message"),
            });
        }
        next = data["cursor"]["next"].as_i64().unwrap_or(0);
        if next <= 0 {
            break;
        }
        utils::sleep_jitter(0.4).await;
    }
    Ok(out)
}
