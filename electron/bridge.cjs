// scripts/system-media-bridge.ts
var import_node_child_process = require("node:child_process");
var import_node_http = require("node:http");
var import_node_path = require("node:path");
var PORT = 8765;
var READER_SCRIPT = process.env.SMTC_READER_PATH ?? (0, import_node_path.join)(process.cwd(), "scripts", "smtc-reader.ps1");
var PS_TIMEOUT_MS = 8e3;
function parseLrc(lrc) {
  const out = [];
  for (const line of lrc.split("\n")) {
    const m = line.match(/\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\](.*)/);
    if (m) {
      const min = Number(m[1]);
      const sec = Number(m[2]);
      const frac = Number(m[3] ?? "0");
      const text = (m[4] ?? "").trim();
      if (text) out.push({ time: min * 60 + sec + frac / 1e3, text });
    }
  }
  return out.sort((a, b) => a.time - b.time);
}
var lyricCache = /* @__PURE__ */ new Map();
var LYRIC_CACHE_MS = 5 * 60 * 1e3;
var LYRIC_CACHE_MAX = 100;
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
async function lookupLyric(title, artist, provider = "qq", customUrl = "") {
  const key = `${provider}|${title}|${artist}`;
  const hit = lyricCache.get(key);
  if (hit && Date.now() - hit.at < LYRIC_CACHE_MS) return hit.data;
  let result = null;
  switch (provider) {
    case "qq":
      result = await lookupQqLyricRemote(title, artist);
      break;
    case "netease":
      result = await lookupNeteaseLyricRemote(title, artist);
      break;
    case "kugou":
      result = await lookupKugouLyricRemote(title, artist) ?? await lookupQqLyricRemote(title, artist);
      break;
    case "kuwo":
      result = await lookupKuwoLyricRemote(title, artist) ?? await lookupQqLyricRemote(title, artist);
      break;
    case "custom":
      result = customUrl ? await lookupCustomLyricRemote(title, artist, customUrl) : null;
      break;
    default:
      result = await lookupQqLyricRemote(title, artist);
  }
  lyricCache.set(key, { at: Date.now(), data: result });
  if (lyricCache.size > LYRIC_CACHE_MAX) {
    const oldestKey = lyricCache.keys().next().value;
    if (oldestKey !== void 0) lyricCache.delete(oldestKey);
  }
  return result;
}
function pickBestHit(list, title, artist) {
  const norm = (s) => s.toLowerCase().replace(/\s+/g, "");
  const t = norm(title);
  const a = norm(artist);
  let best = null;
  let bestScore = -1;
  for (const hit of list) {
    const st = norm(hit.name);
    const sa = norm(hit.artists.join("/"));
    let score = 0;
    if (st === t) score += 100;
    else if (st.includes(t) || t.includes(st)) score += 60;
    else if (st.startsWith(t.slice(0, 2)) || t.startsWith(st.slice(0, 2))) score += 20;
    if (a && sa && (sa.includes(a) || a.includes(sa))) score += 30;
    if (score > bestScore) {
      bestScore = score;
      best = hit;
    }
  }
  return best ?? null;
}
async function lookupNeteaseLyricRemote(title, artist) {
  try {
    const q = encodeURIComponent(`${title} ${artist}`);
    const search = await fetch(
      `https://music.163.com/api/search/get/web?s=${q}&type=1&limit=10`,
      { headers: { "User-Agent": UA, Referer: "https://music.163.com" } }
    );
    const searchJson = await search.json();
    const song = pickBestHit(
      (searchJson.result?.songs ?? []).map((s) => ({
        name: s.name,
        artists: s.artists?.map((a) => a.name) ?? [],
        key: String(s.id)
      })),
      title,
      artist
    );
    if (!song) return null;
    const lyric = await fetch(
      `https://music.163.com/api/song/lyric?id=${song.key}&lv=1&kv=1&tv=-1`,
      { headers: { "User-Agent": UA, Referer: "https://music.163.com" } }
    );
    const lyricJson = await lyric.json();
    const lrc = lyricJson.lrc?.lyric;
    if (!lrc) return null;
    const lines = parseLrc(lrc);
    if (lines.length === 0) return null;
    return {
      title: song.name,
      artist: song.artists.join("/") || artist,
      lines
    };
  } catch {
    return null;
  }
}
async function lookupQqLyricRemote(title, artist) {
  try {
    const q = encodeURIComponent(`${title} ${artist}`);
    const search = await fetch(
      `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?p=1&n=10&w=${q}&format=json&cr=1&t=0`,
      { headers: { "User-Agent": UA, Referer: "https://y.qq.com" } }
    );
    const searchJson = await search.json();
    const song = pickBestHit(
      (searchJson.data?.song?.list ?? []).map((s) => ({
        name: s.songname,
        artists: s.singer?.map((x) => x.name) ?? [],
        key: s.songmid
      })),
      title,
      artist
    );
    if (!song) return null;
    const lyric = await fetch(
      `https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=${song.key}&format=json`,
      { headers: { "User-Agent": UA, Referer: "https://y.qq.com" } }
    );
    const lyricJson = await lyric.json();
    const b64 = lyricJson?.lyric;
    if (!b64) return null;
    const lrc = Buffer.from(b64, "base64").toString("utf8");
    const lines = parseLrc(lrc);
    if (lines.length === 0) return null;
    return {
      title: song.name,
      artist: song.artists.join("/") || artist,
      lines
    };
  } catch {
    return null;
  }
}
async function lookupKugouLyricRemote(title, artist) {
  try {
    const q = encodeURIComponent(`${title} ${artist}`);
    const search = await fetch(
      `https://songsearch.kugou.com/song_search_v2?keyword=${q}&page=1&pagesize=10&platform=WebFilter`,
      { headers: { "User-Agent": UA, Referer: "https://www.kugou.com/" } }
    );
    const sj = await search.json();
    const hit = pickBestHit(
      (sj?.data?.lists ?? []).map((s) => ({
        name: s.SongName,
        artists: [s.SingerName],
        key: s.FileHash
      })),
      title,
      artist
    );
    if (!hit?.key) return null;
    const r2 = await fetch(
      `https://m.kugou.com/app/i/krc.php?cmd=100&hash=${hit.key}&timelength=100000`,
      { headers: { "User-Agent": UA, Referer: "https://m.kugou.com/" } }
    );
    const lrc = await r2.text();
    const lines = parseLrc(lrc);
    if (lines.length === 0) return null;
    return { title: hit.name, artist: hit.artists.join("/") || artist, lines };
  } catch {
    return null;
  }
}
async function lookupKuwoLyricRemote(title, artist) {
  try {
    const q = encodeURIComponent(`${title} ${artist}`);
    const search = await fetch(
      `https://search.kuwo.cn/r.s?all=${q}&ft=music&itemset=web_2013&client=kt&pn=0&rn=20&encoding=utf8&rformat=json`,
      { headers: { "User-Agent": UA, Referer: "https://www.kuwo.cn/" } }
    );
    const text = await search.text();
    const obj = JSON.parse(text.replace(/'/g, '"'));
    const hit = pickBestHit(
      (obj.abslist ?? []).map((s) => ({
        name: s.NAME,
        artists: [s.ARTIST],
        key: String(s.MUSICRID ?? "")
      })),
      title,
      artist
    );
    if (!hit?.key) return null;
    const rid = hit.key.replace("MUSIC_", "");
    const r2 = await fetch(`https://m.kuwo.cn/newh5/singles/songinfo?musicId=${rid}`, {
      headers: { "User-Agent": UA, Referer: "https://www.kuwo.cn/" }
    });
    const lj = await r2.json();
    const lrc = (lj?.htmlLyric ?? "").replace(/<\/p>|<\/div>/g, "\n").replace(/<[^>]+>/g, "").trim();
    const lines = parseLrc(lrc);
    if (lines.length === 0) return null;
    return { title: hit.name, artist: hit.artists.join("/") || artist, lines };
  } catch {
    return null;
  }
}
async function lookupCustomLyricRemote(title, artist, urlTemplate) {
  try {
    const url = urlTemplate.replace("{title}", encodeURIComponent(title)).replace("{artist}", encodeURIComponent(artist ?? ""));
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) return null;
    const text = await res.text();
    let lrc = text;
    try {
      const json = JSON.parse(text);
      if (typeof json.lrc === "string") lrc = json.lrc;
      else if (typeof json.lyric === "string") lrc = json.lyric;
    } catch {
    }
    const lines = parseLrc(lrc);
    if (lines.length === 0) return null;
    return { title, artist, lines };
  } catch {
    return null;
  }
}
var ps;
var psBuffer = "";
var pending = [];
function spawnReader() {
  ps = (0, import_node_child_process.spawn)(
    "powershell",
    // -Mta:PS 5.1 默认 STA,WinRT async 在 STA 控制台下等待存在死锁风险
    ["-Mta", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", READER_SCRIPT],
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true }
  );
  psBuffer = "";
  ps.stdout.setEncoding("utf8");
  ps.stdout.on("data", (chunk) => {
    psBuffer += chunk;
    let idx;
    while ((idx = psBuffer.indexOf("\n")) >= 0) {
      const line = psBuffer.slice(0, idx).replace(/\r$/, "").trim();
      psBuffer = psBuffer.slice(idx + 1);
      if (!line) continue;
      const waiter = pending.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve(line);
      }
    }
  });
  ps.stderr.on("data", (chunk) => {
    console.error("[smtc-reader]", chunk.toString().trim());
  });
  ps.on("exit", (code) => {
    console.error(`[smtc-reader] exited with code ${code}, respawning...`);
    while (pending.length > 0) {
      const waiter = pending.shift();
      clearTimeout(waiter.timer);
      waiter.resolve('{"error":"reader exited"}');
    }
    setTimeout(spawnReader, 2e3);
  });
}
function requestPS(command) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const idx = pending.findIndex((p) => p.resolve === onLine);
      if (idx >= 0) pending.splice(idx, 1);
      resolve('{"error":"timeout"}');
    }, PS_TIMEOUT_MS);
    const onLine = (line) => resolve(line);
    pending.push({ resolve: onLine, timer });
    ps.stdin.write(`${command}
`);
  });
}
function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(data);
}
function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => data += c.toString("utf8"));
    req.on("end", () => resolve(data));
  });
}
var server = (0, import_node_http.createServer)(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    res.end();
    return;
  }
  try {
    if (url.pathname === "/system-media/state") {
      const line = await requestPS("state");
      let state;
      try {
        state = JSON.parse(line);
      } catch {
        state = { error: "bad reader response" };
      }
      sendJson(res, 200, state);
      return;
    }
    if (url.pathname === "/system-media/control" && req.method === "POST") {
      let body = {};
      try {
        body = JSON.parse(await readBody(req));
      } catch {
      }
      const action = body.action ?? "";
      const SIMPLE_ACTIONS = [
        "previous",
        "play",
        "pause",
        "next",
        "repeat-one",
        "repeat-all",
        "shuffle",
        "shuffle-off"
      ];
      let line = '{"ok":true}';
      if (action === "seek" && typeof body.position === "number") {
        line = await requestPS(`control seek ${body.position}`);
      } else if (SIMPLE_ACTIONS.includes(action)) {
        line = await requestPS(`control ${action}`);
      }
      let parsed = { ok: true };
      try {
        parsed = JSON.parse(line);
      } catch {
      }
      sendJson(res, 200, parsed);
      return;
    }
    if (url.pathname === "/system-media/lyric") {
      const qTitle = url.searchParams.get("title");
      const qArtist = url.searchParams.get("artist");
      const qProvider = url.searchParams.get("provider") ?? "netease";
      const qCustomUrl = url.searchParams.get("url") ?? "";
      let title = qTitle ?? "";
      let artist = qArtist ?? "";
      if (!title) {
        const line = await requestPS("state");
        try {
          const st = JSON.parse(line);
          title = st.track?.title ?? "";
          artist = st.track?.artist ?? "";
        } catch {
        }
      }
      if (!title) {
        sendJson(res, 404, { error: "no track" });
        return;
      }
      const lyric = await lookupLyric(title, artist, qProvider, qCustomUrl);
      if (!lyric) {
        sendJson(res, 404, { error: "lyric not found" });
        return;
      }
      sendJson(res, 200, lyric);
      return;
    }
    sendJson(res, 404, { error: "not found" });
  } catch (err) {
    console.error("[bridge] request error:", err);
    sendJson(res, 500, { error: String(err) });
  }
});
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`[bridge] port ${PORT} already in use, another bridge instance is running`);
    process.exit(0);
  }
  console.error("[bridge] server error:", err);
});
server.listen(PORT, "127.0.0.1", () => {
  console.log(`System media bridge (TS) started: http://127.0.0.1:${PORT}/system-media/state`);
  console.log("Press Ctrl+C to stop.");
});
function shutdown() {
  try {
    ps.stdin.write("quit\n");
  } catch {
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
spawnReader();
