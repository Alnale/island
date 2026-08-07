//! JSON 文件存储：已下载记录（去重）、订阅、操作历史。
//! 数据量小（几百条），JSON 足够；避免 SQLite 的 C 依赖。

use serde_json::{json, Value};
use std::path::PathBuf;

pub struct Store {
    path: PathBuf,
    data: Value,
}

impl Store {
    pub fn new(path: PathBuf) -> Self {
        let data = if path.exists() {
            std::fs::read_to_string(&path)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_else(|| json!({"videos": [], "subscribes": [], "history": [], "tasks": []}))
        } else {
            json!({"videos": [], "subscribes": [], "history": [], "tasks": []})
        };
        Store { path, data }
    }

    fn save(&self) {
        if let Some(dir) = self.path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(&self.path, serde_json::to_string_pretty(&self.data).unwrap());
    }

    fn arr(&mut self, key: &str) -> &mut Vec<Value> {
        // 容错：旧版本 store.json 可能缺字段，缺失时初始化为空数组
        if !self.data[key].is_array() {
            self.data[key] = json!([]);
        }
        self.data[key].as_array_mut().expect("store 数组字段初始化失败")
    }

    // ---------------- 已下载记录

    /// 返回已下载路径（有则 Some）
    pub fn is_downloaded(&self, bvid: &str) -> Option<String> {
        self.data["videos"]
            .as_array()
            .unwrap_or(&vec![])
            .iter()
            .find(|v| v["bvid"].as_str() == Some(bvid))
            .and_then(|v| v["path"].as_str().map(|s| s.to_string()))
    }

    pub fn record_download(&mut self, bvid: &str, aid: i64, title: &str, up: &str, up_mid: i64,
                           pubdate: i64, duration: i64, path: &str, size: u64, quality: &str, audio_only: bool) {
        let entry = json!({
            "bvid": bvid, "aid": aid, "title": title, "up": up, "up_mid": up_mid,
            "pubdate": pubdate, "duration": duration, "path": path, "size": size,
            "quality": quality, "audio_only": audio_only,
            "downloaded_at": crate::utils::now_ts(),
        });
        let videos = self.arr("videos");
        if let Some(existing) = videos.iter_mut().find(|v| v["bvid"].as_str() == Some(bvid)) {
            *existing = entry;
        } else {
            videos.push(entry);
        }
        self.save();
    }

    pub fn delete_record(&mut self, bvid: &str) -> bool {
        let videos = self.arr("videos");
        let before = videos.len();
        videos.retain(|v| v["bvid"].as_str() != Some(bvid));
        let removed = videos.len() < before;
        if removed {
            self.log("saved_delete", bvid, "删除记录");
        }
        self.save();
        removed
    }

    /// 路径绝对化（历史记录可能是运行时 cwd 的相对路径）。
    /// 依次尝试 exe 目录 / 当前工作目录 / exe 父目录，取第一个真实存在的。
    pub fn absolutize_path(&self, path: &str, base: &std::path::Path) -> String {
        let p = std::path::Path::new(path);
        if p.is_absolute() {
            return p.to_string_lossy().into_owned();
        }
        let mut candidates = vec![base.to_path_buf()];
        if let Ok(cwd) = std::env::current_dir() {
            candidates.push(cwd);
        }
        if let Some(parent) = base.parent() {
            candidates.push(parent.to_path_buf());
        }
        for c in &candidates {
            let joined = c.join(p);
            if joined.exists() {
                return joined.to_string_lossy().into_owned();
            }
        }
        // 全部不存在（文件可能已删除）：返回 exe 目录拼接，保持绝对格式
        base.join(p).to_string_lossy().into_owned()
    }

    pub fn list_downloaded(&self) -> Vec<Value> {
        let mut v = self.data["videos"].as_array().cloned().unwrap_or_default();
        v.sort_by(|a, b| b["downloaded_at"].as_i64().unwrap_or(0).cmp(&a["downloaded_at"].as_i64().unwrap_or(0)));
        v
    }

    // ---------------- 下载任务历史

    pub fn task_list(&self) -> Vec<Value> {
        self.data["tasks"].as_array().cloned().unwrap_or_default()
    }

    /// 保存/更新任务（按 id upsert，保留最近 50 条）
    pub fn task_save(&mut self, task: &Value) {
        let id = task["id"].as_u64().unwrap_or(0);
        let tasks = self.arr("tasks");
        if let Some(existing) = tasks.iter_mut().find(|t| t["id"].as_u64() == Some(id)) {
            *existing = task.clone();
        } else {
            tasks.push(task.clone());
        }
        let _ = tasks.drain(..tasks.len().saturating_sub(50));
        self.save();
    }

    /// 删除任务记录（按 id 移除并持久化）
    pub fn task_remove(&mut self, id: u64) -> bool {
        let tasks = self.arr("tasks");
        let before = tasks.len();
        tasks.retain(|t| t["id"].as_u64() != Some(id));
        let removed = tasks.len() != before;
        if removed {
            self.save();
        }
        removed
    }

    // ---------------- 订阅

    pub fn sub_add(&mut self, mid: i64, name: &str) {
        let subs = self.arr("subscribes");
        if let Some(existing) = subs.iter_mut().find(|s| s["mid"].as_i64() == Some(mid)) {
            existing["name"] = json!(name);
        } else {
            subs.push(json!({"mid": mid, "name": name, "added_at": crate::utils::now_ts(), "last_check": 0}));
        }
        self.save();
    }

    pub fn sub_remove(&mut self, mid: i64) {
        let subs = self.arr("subscribes");
        subs.retain(|s| s["mid"].as_i64() != Some(mid));
        self.save();
    }

    pub fn sub_list(&self) -> Vec<Value> {
        self.data["subscribes"].as_array().cloned().unwrap_or_default()
    }

    #[allow(dead_code)]
    pub fn sub_get(&self, mid: i64) -> Option<Value> {
        self.data["subscribes"]
            .as_array()
            .unwrap_or(&vec![])
            .iter()
            .find(|s| s["mid"].as_i64() == Some(mid))
            .cloned()
    }

    pub fn sub_touch(&mut self, mid: i64, last_check: i64) {
        let subs = self.arr("subscribes");
        if let Some(s) = subs.iter_mut().find(|s| s["mid"].as_i64() == Some(mid)) {
            s["last_check"] = json!(last_check);
        }
        self.save();
    }

    // ---------------- 历史

    pub fn log(&mut self, action: &str, target: &str, detail: &str) {
        let h = self.arr("history");
        h.push(json!({"at": crate::utils::now_ts(), "action": action, "target": target, "detail": detail}));
        if h.len() > 500 {
            let _ = h.drain(..h.len() - 500);
        }
        self.save();
    }

    pub fn history(&self, limit: usize) -> Vec<Value> {
        let mut v = self.data["history"].as_array().cloned().unwrap_or_default();
        v.reverse();
        v.truncate(limit);
        v
    }
}
