//! 通用工具：时间格式化、文件名清理、请求间隔。

use chrono::{FixedOffset, LocalResult, TimeZone};

pub fn tz8() -> FixedOffset {
    FixedOffset::east_opt(8 * 3600).unwrap()
}

/// 时间戳(秒) -> "YYYY-MM-DD HH:MM"（UTC+8）
pub fn fmt_time(ts: i64, fmt: &str) -> String {
    if ts <= 0 {
        return "?".into();
    }
    match tz8().timestamp_opt(ts, 0) {
        LocalResult::Single(dt) => dt.format(fmt).to_string(),
        _ => "?".into(),
    }
}

/// 时间戳 -> "YYYYMMDD"
pub fn fmt_date(ts: i64) -> String {
    fmt_time(ts, "%Y%m%d")
}

/// 解析 "YYYY-MM-DD[ HH:MM[:SS]]"（UTC+8），失败返回 None
pub fn parse_date(s: &str) -> Option<i64> {
    let s = s.trim();
    let dt = chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S")
        .or_else(|_| chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M"))
        .or_else(|_| {
            chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d")
                .map(|d| d.and_hms_opt(0, 0, 0).unwrap())
        })
        .ok()?;
    // 把 naive datetime 按 UTC+8 解释为时间戳
    Some(dt.and_utc().timestamp() - 8 * 3600)
}

pub fn fmt_duration(sec: i64) -> String {
    let sec = sec.max(0);
    if sec >= 3600 {
        format!("{}:{:02}:{:02}", sec / 3600, sec % 3600 / 60, sec % 60)
    } else {
        format!("{}:{:02}", sec / 60, sec % 60)
    }
}

pub fn fmt_size(n: u64) -> String {
    let mut v = n as f64;
    for unit in ["B", "KB", "MB", "GB", "TB"] {
        if v < 1024.0 {
            return format!("{:.1}{}", v, unit);
        }
        v /= 1024.0;
    }
    format!("{:.1}PB", v)
}

/// 清理 Windows 非法文件名字符
pub fn sanitize_filename(name: &str, max_len: usize) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\0' | '\x01'..='\x1f' | ' ' => '_',
            c => c,
        })
        .collect();
    let trimmed = cleaned.trim_matches(|c| c == '_' || c == '.');
    let mut out: String = trimmed.chars().take(max_len).collect();
    if out.is_empty() {
        out = "untitled".into();
    }
    out
}

pub async fn sleep_jitter(base: f64) {
    tokio::time::sleep(std::time::Duration::from_secs_f64(base)).await;
}

pub fn now_ts() -> i64 {
    chrono::Utc::now().timestamp()
}
