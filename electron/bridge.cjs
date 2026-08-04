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
async function lookupLyric(title, artist) {
  const key = `${title}|${artist}`;
  const hit = lyricCache.get(key);
  if (hit && Date.now() - hit.at < LYRIC_CACHE_MS) return hit.data;
  const result = await lookupLyricRemote(title, artist);
  lyricCache.set(key, { at: Date.now(), data: result });
  if (lyricCache.size > LYRIC_CACHE_MAX) {
    const oldestKey = lyricCache.keys().next().value;
    if (oldestKey !== void 0) lyricCache.delete(oldestKey);
  }
  return result;
}
async function lookupLyricRemote(title, artist) {
  try {
    const q = encodeURIComponent(`${title} ${artist}`);
    const search = await fetch(
      `https://music.163.com/api/search/get/web?s=${q}&type=1&limit=3`,
      { headers: { "User-Agent": UA, Referer: "https://music.163.com" } }
    );
    const searchJson = await search.json();
    const song = searchJson.result?.songs?.[0];
    if (!song) return null;
    const lyric = await fetch(
      `https://music.163.com/api/song/lyric?id=${song.id}&lv=1&kv=1&tv=-1`,
      { headers: { "User-Agent": UA, Referer: "https://music.163.com" } }
    );
    const lyricJson = await lyric.json();
    const lrc = lyricJson.lrc?.lyric;
    if (!lrc) return null;
    const lines = parseLrc(lrc);
    if (lines.length === 0) return null;
    return {
      title: song.name,
      artist: song.artists?.map((a) => a.name).join("/") ?? artist,
      lines
    };
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
      const lyric = await lookupLyric(title, artist);
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
