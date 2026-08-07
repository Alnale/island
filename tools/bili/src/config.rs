//! 配置持久化：config/config.json，命令未指定参数时读默认值。

use serde_json::{json, Value};
use std::path::PathBuf;

pub struct Config {
    pub path: PathBuf,
    data: Value,
}

impl Config {
    pub fn new(path: PathBuf) -> Self {
        let data = if path.exists() {
            std::fs::read_to_string(&path)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_else(|| json!({}))
        } else {
            json!({})
        };
        Config { path, data }
    }

    fn save(&self) {
        if let Some(dir) = self.path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(&self.path, serde_json::to_string_pretty(&self.data).unwrap());
    }

    pub fn get_str(&self, key: &str, default: &str) -> String {
        self.data.get(key)
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| default.to_string())
    }

    pub fn get_int(&self, key: &str, default: i64) -> i64 {
        self.data.get(key).and_then(|v| v.as_i64()).unwrap_or(default)
    }

    pub fn get_bool(&self, key: &str, default: bool) -> bool {
        self.data.get(key).and_then(|v| v.as_bool()).unwrap_or(default)
    }

    pub fn set(&mut self, key: &str, value: Value) {
        self.data[key] = value;
        self.save();
    }

    pub fn reset(&mut self) {
        self.data = json!({});
        self.save();
    }

    pub fn all(&self) -> Value {
        self.data.clone()
    }

    pub fn get_audio(&self) -> Option<String> {
        self.data.get("audio")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
    }
}

pub const AUDIO_FORMATS: [&str; 6] = ["mp3", "wav", "flac", "m4a", "opus", "aac"];
