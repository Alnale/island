//! 扫码登录：二维码生成（终端 ASCII 显示）、轮询确认、cookie 保存。

use std::collections::HashMap;
use std::time::Duration;

use crate::api::{ApiError, BiliApi};

pub const STATUS: [(i64, &str); 4] = [
    (0, "登录成功"),
    (86038, "二维码已失效"),
    (86090, "已扫码，请在手机上确认"),
    (86101, "等待扫码"),
];

async fn generate(api: &BiliApi) -> Result<(String, String), ApiError> {
    let d = api
        .get_json("https://passport.bilibili.com/x/passport-login/web/qrcode/generate", &[], false, None)
        .await?;
    if d.get("code").and_then(|c| c.as_i64()) != Some(0) {
        return Err(ApiError(format!(
            "生成二维码失败: {} {}",
            d.get("code").and_then(|c| c.as_i64()).unwrap_or(-1),
            d.get("message").and_then(|m| m.as_str()).unwrap_or("")
        )));
    }
    Ok((
        d["data"]["url"].as_str().unwrap_or("").to_string(),
        d["data"]["qrcode_key"].as_str().unwrap_or("").to_string(),
    ))
}

async fn poll(api: &BiliApi, key: &str) -> (i64, String, HashMap<String, String>) {
    let d = api
        .get_json(
            "https://passport.bilibili.com/x/passport-login/web/qrcode/poll",
            &[("qrcode_key", key)],
            false,
            None,
        )
        .await;
    let Ok(d) = d else {
        return (86101, String::new(), HashMap::new());
    };
    // B 站新版响应:顶层 code 恒为 0,真正状态在 data.code
    // (86101 等待扫码 / 86090 已扫码待确认 / 86038 失效 / 0 登录成功);
    // 误读顶层 code 会把未扫码当成登录成功 → url 空 → "缺少 SESSDATA"
    let code = d["data"]["code"]
        .as_i64()
        .or_else(|| d.get("code").and_then(|c| c.as_i64()))
        .unwrap_or(-1);
    if code != 0 {
        return (code, String::new(), HashMap::new());
    }
    let url = d["data"]["url"].as_str().unwrap_or("").to_string();
    let mut cookies = HashMap::new();
    for seg in url.split('?').nth(1).unwrap_or("").split('&') {
        if let Some((k, v)) = seg.split_once('=') {
            cookies.insert(k.to_string(), v.to_string());
        }
    }
    (0, url, cookies)
}

/// 二维码 → PNG 图片(对话内扫码登录用):8 倍放大,黑白像素
fn render_qrcode_png(url: &str, path: &str) -> Result<(), String> {
    let qr = qrcode::QrCode::new(url.as_bytes()).map_err(|e| e.to_string())?;
    let colors = qr.to_colors();
    let n = qr.width() as u32;
    let scale = 4u32;  // 132px:PNG ~2-3KB,base64 ~4KB,LLM 复述不超 8000 截断
    let img = image::RgbImage::from_fn(n * scale, n * scale, |x, y| {
        let (px, py) = (x / scale, y / scale);
        if colors[(py * n + px) as usize] == qrcode::Color::Dark {
            image::Rgb([0u8, 0u8, 0u8])
        } else {
            image::Rgb([255u8, 255u8, 255u8])
        }
    });
    img.save(path).map_err(|e| e.to_string())
}

fn show_qrcode(url: &str, qrcode_img: Option<&str>) {
    if let Some(path) = qrcode_img {
        match render_qrcode_png(url, path) {
            Ok(()) => println!("二维码图片已保存: {path}"),
            Err(e) => println!("二维码图片保存失败: {e}"),
        }
    }
    let qr = qrcode::QrCode::new(url.as_bytes());
    match qr {
        Ok(qr) => {
            let n = qr.width() as usize;
            let colors = qr.to_colors();
            println!("{}", "=".repeat(2 * n + 4));
            for i in 0..n {
                let mut line = String::new();
                for j in 0..n {
                    line.push_str(match colors[i * n + j] {
                        qrcode::Color::Dark => "██",
                        qrcode::Color::Light => "  ",
                    });
                }
                println!("  {line}");
            }
            println!("{}", "=".repeat(2 * n + 4));
        }
        Err(_) => println!("二维码生成失败，请重试"),
    }
    println!("请用 B 站手机客户端扫码登录（2 分钟内有效）...");
}

pub async fn login(
    api: &BiliApi,
    timeout: i64,
    qrcode_img: Option<&str>,
    no_wait: bool,
) -> Result<Option<String>, ApiError> {
    let (url, key) = generate(api).await?;
    show_qrcode(&url, qrcode_img);
    if no_wait {
        // 仅生成二维码(对话内扫码登录:Agent 把图片发给用户,扫码后
        // 引擎据此 key 后台轮询写登录态——**必须打印 二维码key: <key>,
        // 否则调用方解析不到 key,扫码后无人轮询、登录态永不落盘,
        // whoami 永远未登录(2026-08-18 修复"登录半天登录不上")**)
        println!("二维码key: {key}");
        println!("(仅生成二维码,扫码确认由引擎后台轮询完成)");
        return Ok(None);
    }
    let start = crate::utils::now_ts();
    let mut last_msg = String::new();
    loop {
        tokio::time::sleep(Duration::from_secs(3)).await;
        let (code, url, cookies) = poll(api, &key).await;
        if code == 0 {
            let mut cookies = cookies;
            if cookies.get("SESSDATA").is_none() && !url.is_empty() {
                // B 站新版流程:poll 的 url 可能是 crossDomain?ticket=xxx
                // 中转地址,SESSDATA 等 cookie 需再请求该地址从 Set-Cookie
                // 获取(serve.rs 登录已实现,CLI login 漏接——实测扫码确认
                // 后报"登录响应缺少 SESSDATA")
                if let Ok(chain) = api.fetch_cookies_chain(&url).await {
                    for (k, v) in chain {
                        cookies.entry(k.to_uppercase()).or_insert(v);
                    }
                }
            }
            if cookies.get("SESSDATA").is_none() {
                println!("登录响应缺少 SESSDATA，请重试");
                return Ok(None);
            }
            api.save_cookies(&cookies);
            let uid = cookies.get("DedeUserID").cloned().unwrap_or_default();
            println!("登录成功！UID={uid}");
            return Ok(Some(uid));
        }
        let msg = STATUS
            .iter()
            .find(|(c, _)| *c == code)
            .map(|(_, m)| *m)
            .unwrap_or("未知状态");
        if msg != last_msg {
            println!("[{msg}]");
            last_msg = msg.to_string();
        }
        if code == 86038 {
            println!("二维码已过期，请重新运行 login");
            return Ok(None);
        }
        if crate::utils::now_ts() - start > timeout.max(10) {
            println!("登录超时");
            return Ok(None);
        }
    }
}
