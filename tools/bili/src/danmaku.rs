//! 弹幕模块：protobuf wire 零依赖解析、分段抓取、XML/ASS/TXT/JSON 导出。
//!
//! 接口: /x/v2/dm/web/seg.so?type=1&oid={cid}&segment_index={n}
//! DmSegMobileReply { repeated DmElem elems = 1 }
//! DmElem: 1=id 2=progress(ms) 3=mode 4=fontsize 5=color 6=midHash
//!         7=content 8=ctime 9=weight 10=action 11=pool 12=idStr 13=attr

use std::collections::HashMap;

use serde_json::Value;

use crate::api::{ApiError, BiliApi};

const SEG_MS: i64 = 360_000;

pub type Danmaku = HashMap<i64, Value>;

struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn varint(&mut self) -> u64 {
        let mut result: u64 = 0;
        let mut shift = 0u32;
        loop {
            let b = self.buf[self.pos];
            self.pos += 1;
            result |= ((b & 0x7F) as u64) << shift;
            if b & 0x80 == 0 {
                return result;
            }
            shift += 7;
        }
    }

    fn key(&mut self) -> (u64, u64) {
        let k = self.varint();
        (k >> 3, k & 7)
    }

    fn take(&mut self, n: usize) -> &'a [u8] {
        let s = &self.buf[self.pos..self.pos + n];
        self.pos += n;
        s
    }
}

/// 解析 seg.so 响应，返回弹幕列表（字段号 -> 值）
pub fn parse_elems(data: &[u8]) -> Vec<Danmaku> {
    let mut elems = Vec::new();
    let mut r = Reader { buf: data, pos: 0 };
    while r.pos < r.buf.len() {
        let (field, wire) = r.key();
        if field == 1 && wire == 2 {
            let len = r.varint() as usize;
            let sub = r.take(len);
            let mut sr = Reader { buf: sub, pos: 0 };
            let mut dm: Danmaku = HashMap::new();
            while sr.pos < sr.buf.len() {
                let (f, w) = sr.key();
                match w {
                    0 => { dm.insert(f as i64, Value::from(sr.varint())); }
                    2 => {
                        let n = sr.varint() as usize;
                        let bytes = sr.take(n);
                        dm.insert(f as i64, Value::String(String::from_utf8_lossy(bytes).into_owned()));
                    }
                    1 => { sr.take(8); }
                    5 => { sr.take(4); }
                    _ => break,
                }
            }
            elems.push(dm);
        } else if wire == 2 {
            let n = r.varint() as usize;
            r.take(n);
        } else if wire == 0 {
            r.varint();
        } else if wire == 1 || wire == 5 {
            r.take(8);
        } else {
            break;
        }
    }
    elems
}

fn f64_(d: &Danmaku, key: i64) -> f64 {
    d.get(&key).and_then(|v| v.as_f64()).unwrap_or(0.0)
}
fn i64_(d: &Danmaku, key: i64) -> i64 {
    d.get(&key).and_then(|v| v.as_i64()).unwrap_or(0)
}
fn str_(d: &Danmaku, key: i64) -> String {
    d.get(&key).and_then(|v| v.as_str()).unwrap_or("").to_string()
}

/// 抓取一个 cid 的全部弹幕
pub async fn fetch_danmaku(api: &BiliApi, cid: i64, duration: i64) -> Result<Vec<Danmaku>, ApiError> {
    let segs = if duration > 0 { ((duration * 1000 + SEG_MS - 1) / SEG_MS).min(200) } else { 1 };
    let mut out = Vec::new();
    for i in 1..=segs {
        let url = format!(
            "https://api.bilibili.com/x/v2/dm/web/seg.so?type=1&oid={cid}&segment_index={i}"
        );
        match api.get_bytes_cookie(&url).await {
            Ok(resp) => {
                if let Ok(bytes) = resp.bytes().await {
                    out.extend(parse_elems(&bytes));
                }
            }
            Err(_) => {}
        }
        if i < segs {
            crate::utils::sleep_jitter(0.25).await;
        }
    }
    Ok(out)
}

/// XML（bilibili 标准弹幕格式）
pub fn to_xml(danmakus: &[Danmaku]) -> String {
    let mut s = String::from("<?xml version=\"1.0\" ?>\n<i>\n  <chatserver>chat.bilibili.com</chatserver>\n  <maxlimit>1000</maxlimit>\n  <source>k-v</source>\n");
    let now = crate::utils::now_ts();
    for d in danmakus {
        let t = f64_(d, 2) / 1000.0;
        let mode = i64_(d, 3).max(1);
        let fontsize = i64_(d, 4).max(25);
        let color = i64_(d, 5).max(16777215);
        let ctime = i64_(d, 8);
        let weight = i64_(d, 9);
        let midhash = str_(d, 6);
        let content = str_(d, 7);
        let p = format!("{t:.3},{mode},{fontsize},{color},{now},{midhash},{ctime},{weight}");
        s.push_str(&format!("  <d p=\"{}\">{}</d>\n", p, xml_escape(&content)));
    }
    s.push_str("</i>\n");
    s
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// ASS 字幕（滚动/顶部/底部弹幕）
pub fn to_ass(danmakus: &[Danmaku], width: i64, height: i64, fontsize: i64) -> String {
    let mut s = format!(
        "[Script Info]\nScriptType: v4.00+\nPlayResX: {width}\nPlayResY: {height}\nWrapStyle: 2\n\n\
[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n\
Style: Default,Microsoft YaHei,{fontsize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,1.5,1,2,40,40,40,1\n\n\
[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    );
    for d in danmakus {
        let t = f64_(d, 2) / 1000.0;
        let mode = i64_(d, 3);
        let dur = if (5..=7).contains(&mode) { 5.0 } else { ((width + fontsize * 8) as f64 / 300.0).max(2.5) };
        let start = ass_time(t);
        let end = ass_time(t + dur);
        let color = i64_(d, 5).max(0);
        let b = (color >> 16) & 0xFF;
        let g = (color >> 8) & 0xFF;
        let r = color & 0xFF;
        let (layer, align) = if mode == 5 || mode == 6 {
            (1, 8)
        } else if mode == 7 {
            (2, 2)
        } else {
            (0, 5)
        };
        let text = str_(d, 7).replace('\n', "\\N");
        s.push_str(&format!(
            "Dialogue: {layer},{start},{end},Default,,0,0,0,,{{\\an{align}\\c&H{r:02X}{g:02X}{b:02X}&}}{text}\n"
        ));
    }
    s
}

fn ass_time(sec: f64) -> String {
    let h = (sec / 3600.0) as i64;
    let m = (sec % 3600.0 / 60.0) as i64;
    format!("{h}:{m:02}:{:05.2}", sec % 60.0)
}

pub fn to_txt(danmakus: &[Danmaku]) -> String {
    let mut lines = Vec::new();
    for d in danmakus {
        let t = f64_(d, 2) / 1000.0;
        lines.push(format!("[{t:.1}] {}", str_(d, 7)));
    }
    lines.join("\n")
}

pub fn to_json(danmakus: &[Danmaku]) -> String {
    let arr: Vec<Value> = danmakus.iter().map(|d| Value::Object(
        d.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()
    )).collect();
    serde_json::to_string_pretty(&arr).unwrap_or_default()
}
