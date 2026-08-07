//! API 基础层：请求封装、WBI/App 签名、Cookie 管理。
//! 关键兼容点（踩坑经验）：
//! - app.bilibili.com 响应 body 会重复两遍，需解析第一个完整 JSON 对象
//! - 视频列表走移动端 API（appkey 签名 + vmid + aid 游标）
//! - 合集列表接口未登录 -400，改用 view 的 ugc_season 字段

use md5::{Digest, Md5};
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use serde::Deserialize;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, ACCEPT_LANGUAGE, COOKIE, ORIGIN, REFERER, USER_AGENT};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const UA_WEB: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
pub const UA_APP: &str = "Mozilla/5.0 BiliDroid/7.73.0 (bbcallen@gmail.com) os/android model/Pixel 8 pro 13";
const APPKEY: &str = "1d8b6e7d45233436";
const APPSEC: &str = "560c52ccd288fed045859ed18bffd973";

const MIXIN_TAB: [usize; 64] = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29,
    28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25,
    54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

fn now_ts() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() as i64
}

fn md5_hex(s: &str) -> String {
    let mut h = Md5::new();
    h.update(s.as_bytes());
    format!("{:x}", h.finalize())
}

/// 解析 JSON，兼容 app 域"body 重复两遍"的怪癖：取第一个完整对象。
fn parse_json(text: &str) -> Result<Value, String> {
    match serde_json::from_str::<Value>(text) {
        Ok(v) => Ok(v),
        Err(_) => {
            // trailing characters 场景：用 Deserializer 解析第一个值
            let mut de = serde_json::Deserializer::from_str(text);
            Value::deserialize(&mut de).map_err(|e| format!("JSON 解析失败: {e} (前 80 字节: {:?})", &text[..text.len().min(80)]))
        }
    }
}

#[derive(Clone)]
pub struct BiliApi {
    client: reqwest::Client,
    cookie_dir: PathBuf,
    wbi_keys: Arc<std::sync::Mutex<Option<(String, String)>>>,
    buvid_cache: Arc<tokio::sync::Mutex<Option<String>>>,
}

use std::sync::Arc;

pub struct ApiError(pub String);

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}
impl std::fmt::Debug for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}
impl std::error::Error for ApiError {}

impl From<reqwest::Error> for ApiError {
    fn from(e: reqwest::Error) -> Self {
        ApiError(format!("网络错误: {e}"))
    }
}

fn urlencode(s: &str) -> String {
    utf8_percent_encode(s, NON_ALPHANUMERIC).to_string()
}

impl BiliApi {
    pub fn new(cookie_dir: PathBuf) -> Self {
        let mut headers = HeaderMap::new();
        headers.insert(USER_AGENT, HeaderValue::from_static(UA_WEB));
        headers.insert(ACCEPT, HeaderValue::from_static("application/json, text/plain, */*"));
        headers.insert(ACCEPT_LANGUAGE, HeaderValue::from_static("zh-CN,zh;q=0.9,en;q=0.8"));
        let client = reqwest::Client::builder()
            .default_headers(headers)
            .connect_timeout(Duration::from_secs(20))
            .timeout(Duration::from_secs(90))
            .build()
            .expect("HTTP 客户端初始化失败");
        BiliApi {
            client,
            cookie_dir,
            wbi_keys: Arc::new(std::sync::Mutex::new(None)),
            buvid_cache: Arc::new(tokio::sync::Mutex::new(None)),
        }
    }

    pub fn cookie_file(&self) -> PathBuf {
        self.cookie_dir.join("cookies.json")
    }

    fn read_cookie_file(&self) -> Value {
        let p = self.cookie_file();
        if p.exists() {
            if let Ok(s) = std::fs::read_to_string(&p) {
                if let Ok(v) = serde_json::from_str(&s) {
                    return v;
                }
            }
        }
        Value::Null
    }

    pub fn save_cookies(&self, cookies: &HashMap<String, String>) {
        let _ = std::fs::create_dir_all(&self.cookie_dir);
        let mut map = serde_json::Map::new();
        for (k, v) in cookies {
            map.insert(k.clone(), Value::String(v.clone()));
        }
        map.insert("_saved_at".into(), Value::Number(now_ts().into()));
        let _ = std::fs::write(self.cookie_file(), serde_json::to_string_pretty(&Value::Object(map)).unwrap());
    }

    /// 组合 cookie：buvid + 登录 cookie
    pub async fn auth_cookie(&self) -> String {
        let mut parts = vec![self.buvid().await];
        if let Value::Object(m) = self.read_cookie_file() {
            for k in ["SESSDATA", "bili_jct", "DedeUserID"] {
                if let Some(Value::String(v)) = m.get(k) {
                    parts.push(format!("{k}={v}"));
                }
            }
        }
        parts.join("; ")
    }

    async fn buvid(&self) -> String {
        let mut guard = self.buvid_cache.lock().await;
        if let Some(v) = guard.as_ref() {
            return v.clone();
        }
        let mut v = String::new();
        // 直接请求，不走 get_json（避免递归）
        if let Ok(resp) = self
            .client
            .get("https://api.bilibili.com/x/frontend/finger/spi")
            .header(USER_AGENT, UA_WEB)
            .send()
            .await
        {
            if let Ok(text) = resp.text().await {
                if let Ok(r) = parse_json(&text) {
                    if r.get("code").and_then(|c| c.as_i64()) == Some(0) {
                        let d = &r["data"];
                        v = format!(
                            "buvid3={}; buvid4={}",
                            d["b_3"].as_str().unwrap_or(""),
                            d["b_4"].as_str().unwrap_or("")
                        );
                    }
                }
            }
        }
        *guard = Some(v.clone());
        v
    }

    /// 通用 GET 请求，返回 JSON。app=true 走移动端 UA。
    pub async fn get_json(&self, url: &str, params: &[(&str, &str)], app: bool, extra_cookie: Option<&str>) -> Result<Value, ApiError> {
        let mut headers = HeaderMap::new();
        headers.insert(REFERER, HeaderValue::from_static("https://www.bilibili.com/"));
        if app {
            headers.insert(USER_AGENT, HeaderValue::from_static(UA_APP));
        } else {
            headers.insert(USER_AGENT, HeaderValue::from_static(UA_WEB));
            headers.insert(ORIGIN, HeaderValue::from_static("https://www.bilibili.com"));
        }
        let mut cookie = self.buvid().await;
        if let Some(ec) = extra_cookie {
            cookie = format!("{cookie}; {ec}");
        }
        headers.insert(COOKIE, HeaderValue::from_str(&cookie).unwrap());

        let mut last_err = String::new();
        for attempt in 0..4 {
            let resp = self
                .client
                .get(url)
                .query(params)
                .headers(headers.clone())
                .send()
                .await;
            match resp {
                Ok(r) => {
                    if r.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
                        last_err = "HTTP 412 风控拦截".into();
                        tokio::time::sleep(Duration::from_secs(3 + attempt * 2)).await;
                        continue;
                    }
                    let status = r.status();
                    let text = r.text().await.map_err(ApiError::from)?;
                    if !status.is_success() {
                        last_err = format!("HTTP {status}: {}", &text[..text.len().min(120)]);
                        continue;
                    }
                    return parse_json(&text).map_err(ApiError);
                }
                Err(e) => {
                    last_err = format!("{e}");
                    tokio::time::sleep(Duration::from_secs(2 + attempt * 2)).await;
                }
            }
        }
        Err(ApiError(format!("请求失败 {url}: {last_err}")))
    }

    /// WBI 签名 GET
    pub async fn wbi_get(&self, url: &str, params: &[(&str, &str)], extra_cookie: Option<&str>) -> Result<Value, ApiError> {
        let signed = self.sign_wbi(params).await?;
        let refs: Vec<(&str, &str)> = signed.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
        self.get_json(url, &refs, false, extra_cookie).await
    }

    /// App 签名 GET
    pub async fn app_get(&self, url: &str, params: &[(&str, &str)]) -> Result<Value, ApiError> {
        let mut map: Vec<(String, String)> = params.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        map.push(("appkey".into(), APPKEY.into()));
        map.push(("ts".into(), now_ts().to_string()));
        map.sort_by(|a, b| a.0.cmp(&b.0));
        let q = map.iter().map(|(k, v)| format!("{}={}", urlencode(k), urlencode(v))).collect::<Vec<_>>().join("&");
        let sign = md5_hex(&format!("{q}{APPSEC}"));
        map.push(("sign".into(), sign));
        let refs: Vec<(&str, &str)> = map.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
        self.get_json(url, &refs, true, None).await
    }

    /// 从 nav 响应提取 WBI key(img/sub 文件名段);缺失 = 响应异常
    fn wbi_keys_from(d: &Value) -> (String, String) {
        let wbi = &d["data"]["wbi_img"];
        let img = wbi["img_url"].as_str().unwrap_or("").rsplit('/').next().unwrap_or("").split('.').next().unwrap_or("").to_string();
        let sub = wbi["sub_url"].as_str().unwrap_or("").rsplit('/').next().unwrap_or("").split('.').next().unwrap_or("").to_string();
        (img, sub)
    }

    async fn wbi_keys(&self) -> Result<(String, String), ApiError> {
        {
            let guard = self.wbi_keys.lock().unwrap();
            if let Some(k) = guard.as_ref() {
                return Ok(k.clone());
            }
        }
        let cookie = self.auth_cookie().await;
        let d = self.get_json("https://api.bilibili.com/x/web-interface/nav", &[], false, Some(&cookie)).await?;
        let (img, sub) = Self::wbi_keys_from(&d);
        if img.is_empty() || sub.is_empty() {
            // 登录态下 nav 异常(wbi_img 缺失:常见 = SESSDATA 过期/风控,
            // 实测登录过期后 trending 空 key 越界 panic)——降级为游客
            // 重试(游客 nav 必定返回 wbi_img),避免空 mixin 崩溃;
            // 多数接口不强制登录,游客 key 签名后仍可用
            let d2 = self.get_json("https://api.bilibili.com/x/web-interface/nav", &[], false, None).await?;
            let (img2, sub2) = Self::wbi_keys_from(&d2);
            if img2.is_empty() || sub2.is_empty() {
                return Err(ApiError("获取 WBI 密钥失败:nav 接口未返回 wbi_img(可能被风控)".into()));
            }
            *self.wbi_keys.lock().unwrap() = Some((img2.clone(), sub2.clone()));
            return Ok((img2, sub2));
        }
        *self.wbi_keys.lock().unwrap() = Some((img.clone(), sub.clone()));
        Ok((img, sub))
    }

    async fn sign_wbi(&self, params: &[(&str, &str)]) -> Result<HashMap<String, String>, ApiError> {
        let (img, sub) = self.wbi_keys().await?;
        let orig = format!("{img}{sub}");
        // 防御:key 不足 32 字符时 as_bytes()[i] 越界 panic(登录态异常的
        // 兜底,正常 key 两段各 32 字符)
        if orig.len() < 32 {
            return Err(ApiError(format!("WBI 密钥异常(长度 {}),无法签名,请重试", orig.len())));
        }
        let mixin: String = MIXIN_TAB.iter().map(|&i| orig.as_bytes()[i] as char).take(32).collect();

        let mut map: HashMap<String, String> = params.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        map.insert("wts".into(), now_ts().to_string());
        let mut keys: Vec<&String> = map.keys().collect();
        keys.sort();
        let query = keys
            .iter()
            .map(|k| {
                let v = map[*k].replace("!'()*", "");
                format!("{}={}", urlencode(k), urlencode(&v))
            })
            .collect::<Vec<_>>()
            .join("&");
        map.insert("w_rid".into(), md5_hex(&format!("{query}{mixin}")));
        Ok(map)
    }

    /// 扫码登录 crossDomain ticket 流程：请求中转地址（自动跟随重定向），
    /// 用 CookieStore(Jar) 收集全部 Set-Cookie（含 SESSDATA）。
    /// 要点：必须带与 poll 一致的 buvid cookie；重定向后域可能变化，需用最终 URL 查 Jar。
    pub async fn fetch_cookies_chain(&self, url: &str) -> Result<std::collections::HashMap<String, String>, ApiError> {
        use reqwest::cookie::CookieStore;
        use std::sync::Arc;
        let jar = Arc::new(reqwest::cookie::Jar::default());
        let buvid = self.buvid().await;
        let client = reqwest::Client::builder()
            .user_agent(UA_WEB)
            .cookie_provider(jar.clone())
            .redirect(reqwest::redirect::Policy::default())
            .build()
            .map_err(|e| ApiError(format!("构建客户端失败: {e}")))?;
        let parsed = url::Url::parse(url).map_err(|e| ApiError(format!("URL 解析失败: {e}")))?;
        let resp = client
            .get(url)
            .header(REFERER, "https://www.bilibili.com/")
            .header(COOKIE, buvid)
            .send()
            .await
            .map_err(|e| ApiError(format!("crossDomain 请求失败: {e}")))?;
        let status = resp.status();
        // 同时用原 URL 和最终 URL 查 Jar（重定向后域可能从 passport 变为 www）
        let mut cookie_str = String::new();
        let final_url = resp.url().clone();
        if let Some(v) = jar.cookies(&final_url) {
            if let Ok(s) = v.to_str() {
                cookie_str.push_str(s);
            }
        }
        if final_url != parsed {
            if let Some(v) = jar.cookies(&parsed) {
                if let Ok(s) = v.to_str() {
                    if !cookie_str.is_empty() {
                        cookie_str.push_str("; ");
                    }
                    cookie_str.push_str(s);
                }
            }
        }
        let mut cookies = std::collections::HashMap::new();
        for seg in cookie_str.split(';') {
            if let Some((k, v)) = seg.trim().split_once('=') {
                cookies.insert(k.trim().to_string(), v.trim().to_string());
            }
        }
        if cookies.is_empty() {
            return Err(ApiError(format!(
                "crossDomain 未返回 cookie（HTTP {status}，URL: {url}）"
            )));
        }
        Ok(cookies)
    }

    /// 原始字节 GET（下载用，支持 Range 头）
    pub async fn get_bytes(&self, url: &str, range: Option<(u64, u64)>) -> Result<reqwest::Response, ApiError> {
        let mut req = self.client.get(url).header(REFERER, "https://www.bilibili.com/");
        if let Some((s, e)) = range {
            req = req.header(reqwest::header::RANGE, format!("bytes={s}-{e}"));
        }
        req.send().await.map_err(ApiError::from)
    }

    /// GET 二进制 + buvid 指纹 cookie（弹幕等接口不带指纹会被 -352 风控拦截）
    pub async fn get_bytes_cookie(&self, url: &str) -> Result<reqwest::Response, ApiError> {
        let cookie = self.buvid().await;
        self.client
            .get(url)
            .header(REFERER, "https://www.bilibili.com/")
            .header(COOKIE, cookie)
            .send()
            .await
            .map_err(ApiError::from)
    }

    pub fn is_logged_in(&self) -> bool {
        // 同步简化：有 SESSDATA 且未过期
        if let Value::Object(m) = self.read_cookie_file() {
            return m.contains_key("SESSDATA");
        }
        false
    }

    pub fn login_info(&self) -> (String, i64, bool) {
        // 从 cookie 读 DedeUserID
        if let Value::Object(m) = self.read_cookie_file() {
            let uid = m.get("DedeUserID").and_then(|v| v.as_str()).unwrap_or("").to_string();
            return (uid.clone(), uid.parse().unwrap_or(0), true);
        }
        (String::new(), 0, false)
    }
}
