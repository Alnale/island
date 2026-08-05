var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// electron/agent/engine.ts
var engine_exports = {};
__export(engine_exports, {
  createAgentEngine: () => createAgentEngine,
  createSummaryAgent: () => createSummaryAgent,
  createTools: () => createTools
});
module.exports = __toCommonJS(engine_exports);
var import_node_crypto = require("node:crypto");

// electron/agent/deepseek.ts
function historyToItems(history) {
  const items = [];
  for (const msg of history) {
    if (msg.role === "user") {
      const text = msg.parts.filter((p) => p.type === "text").map((p) => p.text).join("\n");
      if (text) items.push({ type: "message", role: "user", content: [{ type: "input_text", text }] });
      continue;
    }
    const reasoning = msg.parts.filter((p) => p.type === "reasoning").map((p) => p.text).join("\n");
    if (reasoning) {
      items.push({ type: "reasoning", content: [{ type: "reasoning_text", text: reasoning }] });
    }
    let pendingText = "";
    const flushText = () => {
      if (!pendingText) return;
      items.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: pendingText }] });
      pendingText = "";
    };
    for (const part of msg.parts) {
      if (part.type === "text") {
        pendingText += pendingText ? "\n" + part.text : part.text;
      } else if (part.type === "tool-call") {
        flushText();
        items.push({
          type: "function_call",
          call_id: part.id,
          name: part.name,
          arguments: JSON.stringify(part.args ?? {})
        });
      } else if (part.type === "tool-result") {
        items.push({
          type: "function_call_output",
          call_id: part.id,
          // 结果截断回填(参考后端 token 预算治理):完整结果已走事件给 UI
          output: part.result.length > 8e3 ? part.result.slice(0, 8e3) + "\n\u2026(\u5DF2\u622A\u65AD)" : part.result
        });
      }
    }
    flushText();
  }
  return items;
}
async function* parseSse(body, signal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep;
      while ((sep = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const dataLine = frame.split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith("data:"));
        if (!dataLine) continue;
        const payload = dataLine.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const parsed = JSON.parse(payload);
          if (parsed && typeof parsed.type === "string") {
            yield { type: parsed.type, data: parsed };
          }
        } catch {
        }
      }
      if (signal.aborted) throw new DOMException("aborted", "AbortError");
    }
  } finally {
    reader.releaseLock();
  }
}
async function streamResponse(params) {
  const { config, system, history, tools, signal, onEvent } = params;
  const base = config.baseURL.trim().replace(/\/+$/, "");
  const url = `${base}/responses`;
  const body = {
    model: config.model.trim() || "deepseek-v4-flash",
    instructions: system,
    input: historyToItems(history),
    // 有工具才带 tools/tool_choice(静默总结等无工具请求不带,
    // 请求体最小化,规避空数组边界)
    ...tools.length > 0 ? {
      tools: tools.map((t) => ({
        type: "function",
        name: t.name,
        description: t.description,
        parameters: t.parameters
      })),
      tool_choice: "auto"
    } : {},
    // 官方文档:reasoning.effort 支持(deepseek-v4-flash 思考模型;
    // 可配置 low/medium/high)
    reasoning: { effort: config.reasoningEffort || "high" },
    // 输出上限:单轮回复防失控(输出 384K 上限,不设会烧输出 token)
    max_output_tokens: 4096,
    stream: true
  };
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey.trim()}`
      },
      body: JSON.stringify(body),
      signal
    });
  } catch (err) {
    if (err.name === "AbortError") throw err;
    throw new Error(`\u65E0\u6CD5\u8FDE\u63A5 DeepSeek API(${url}):${err.message}`);
  }
  if (!res.ok || !res.body) {
    let detail = "";
    try {
      const text = await res.text();
      detail = text.slice(0, 500);
    } catch {
    }
    throw new Error(`DeepSeek API \u8BF7\u6C42\u5931\u8D25 HTTP ${res.status}:${detail}`);
  }
  const calls = /* @__PURE__ */ new Map();
  const textParts = [];
  let usage = null;
  for await (const evt of parseSse(res.body, signal)) {
    const d = evt.data;
    switch (evt.type) {
      case "response.output_item.added": {
        const item = d.item;
        if (item?.type === "function_call" && typeof item.call_id === "string") {
          const call = {
            id: item.call_id,
            name: typeof item.name === "string" ? item.name : "",
            args: typeof item.arguments === "string" ? item.arguments : ""
          };
          calls.set(call.id, call);
          onEvent({ type: "tool-call", id: call.id, name: call.name, args: call.args });
        }
        break;
      }
      case "response.output_text.delta": {
        const text = typeof d.delta === "string" ? d.delta : "";
        if (text) {
          textParts.push(text);
          onEvent({ type: "text-delta", text });
        }
        break;
      }
      case "response.reasoning_text.delta": {
        const text = typeof d.delta === "string" ? d.delta : "";
        if (text) {
          onEvent({ type: "reasoning-delta", text });
        }
        break;
      }
      case "response.function_call_arguments.delta": {
        const id = typeof d.call_id === "string" ? d.call_id : "";
        const delta = typeof d.delta === "string" ? d.delta : "";
        const call = calls.get(id);
        if (!call) continue;
        call.args += delta;
        onEvent({ type: "tool-partial-call", id: call.id, name: call.name, args: call.args });
        break;
      }
      case "response.output_item.done": {
        const item = d.item;
        if (item?.type === "function_call" && typeof item.call_id === "string") {
          const call = calls.get(item.call_id);
          if (call) {
            call.args = typeof item.arguments === "string" && item.arguments.length > call.args.length ? item.arguments : call.args;
            onEvent({ type: "tool-call", id: call.id, name: call.name, args: call.args });
          }
        }
        break;
      }
      case "response.completed": {
        const resp = d.response;
        const u = resp?.usage;
        if (u) {
          const details = u.input_tokens_details;
          usage = {
            input_tokens: typeof u.input_tokens === "number" ? u.input_tokens : 0,
            output_tokens: typeof u.output_tokens === "number" ? u.output_tokens : 0,
            cached_tokens: typeof details?.cached_tokens === "number" ? details.cached_tokens : void 0
          };
        }
        break;
      }
      case "response.incomplete": {
        break;
      }
      case "response.failed": {
        const err = d.error;
        throw new Error(`DeepSeek \u54CD\u5E94\u5931\u8D25:${String(err?.message ?? "\u672A\u77E5\u9519\u8BEF")}`);
      }
      case "response.error": {
        const err = d.error;
        throw new Error(`DeepSeek \u9519\u8BEF:${String(err?.message ?? "\u672A\u77E5\u9519\u8BEF")}`);
      }
      default:
        break;
    }
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
  }
  return {
    calls: [...calls.values()].map((c) => ({ id: c.id, name: c.name, args: c.args })),
    text: textParts.join(""),
    usage,
    aborted: signal.aborted
  };
}
function parseToolArgs(raw) {
  const text = raw.trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return { _raw: text };
  }
}

// electron/agent/anthropic.ts
function historyToAnthropic(history) {
  const msgs = [];
  const pushBlock = (role, block) => {
    const last = msgs[msgs.length - 1];
    if (last && last.role === role) last.content.push(block);
    else msgs.push({ role, content: [block] });
  };
  for (const msg of history) {
    if (msg.role === "user") {
      const text = msg.parts.filter((p) => p.type === "text").map((p) => p.text).join("\n");
      if (text) pushBlock("user", { type: "text", text });
      continue;
    }
    const pendingResults = [];
    for (const part of msg.parts) {
      if (part.type === "text") {
        pushBlock("assistant", { type: "text", text: part.text });
      } else if (part.type === "tool-call") {
        pushBlock("assistant", {
          type: "tool_use",
          id: part.id,
          name: part.name,
          input: part.args ?? {}
        });
      } else if (part.type === "tool-result") {
        pendingResults.push({
          type: "tool_result",
          tool_use_id: part.id,
          content: part.result.length > 8e3 ? part.result.slice(0, 8e3) + "\n\u2026(\u5DF2\u622A\u65AD)" : part.result
        });
      }
    }
    for (const block of pendingResults) pushBlock("user", block);
  }
  const filtered = msgs.filter((m) => m.content.length > 0);
  for (let i = filtered.length - 1; i > 0; i--) {
    if (filtered[i].role === filtered[i - 1].role) {
      filtered[i - 1].content.push(...filtered[i].content);
      filtered.splice(i, 1);
    }
  }
  return filtered;
}
function anthropicTools(tools) {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters
  }));
}
async function streamAnthropic(params) {
  const { config, system, history, tools, signal, onEvent } = params;
  const base = config.baseURL.trim().replace(/\/+$/, "");
  const url = `${base}/v1/messages`;
  const body = {
    model: config.model.trim() || "deepseek-v4-flash",
    max_tokens: 4096,
    system: system || void 0,
    messages: historyToAnthropic(history),
    // 有工具才带 tools(静默总结等无工具请求不带,请求体最小化)
    ...tools.length > 0 ? { tools: anthropicTools(tools) } : {},
    stream: true
  };
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.apiKey.trim(),
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify(body),
      signal
    });
  } catch (err) {
    if (err.name === "AbortError") throw err;
    throw new Error(`\u65E0\u6CD5\u8FDE\u63A5 Anthropic API(${url}):${err.message}`);
  }
  if (!res.ok || !res.body) {
    let detail = "";
    try {
      const text = await res.text();
      detail = text.slice(0, 500);
    } catch {
    }
    throw new Error(`Anthropic API \u8BF7\u6C42\u5931\u8D25 HTTP ${res.status}:${detail}`);
  }
  const blocks = /* @__PURE__ */ new Map();
  const textParts = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  const parseSse2 = async function* (reader) {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep;
        while ((sep = buffer.search(/\r?\n\r?\n/)) !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const dataLine = frame.split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith("data:"));
          if (!dataLine) continue;
          const payload = dataLine.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          try {
            const parsed = JSON.parse(payload);
            if (parsed && typeof parsed.type === "string") yield { type: parsed.type, data: parsed };
          } catch {
          }
        }
        if (signal.aborted) throw new DOMException("aborted", "AbortError");
      }
    } finally {
      reader.releaseLock();
    }
  };
  for await (const evt of parseSse2(res.body.getReader())) {
    const d = evt.data;
    switch (evt.type) {
      case "message_start": {
        const message = d.message;
        const usage = message?.usage;
        if (typeof usage?.input_tokens === "number") inputTokens = usage.input_tokens;
        if (typeof usage?.cache_read_input_tokens === "number") {
          cacheReadTokens = usage.cache_read_input_tokens;
        }
        break;
      }
      case "content_block_start": {
        const index = d.index;
        const block = d.content_block;
        if (block?.type === "tool_use" && typeof block.id === "string") {
          blocks.set(index, {
            type: "tool_use",
            id: block.id,
            name: typeof block.name === "string" ? block.name : "",
            input: ""
          });
          onEvent({ type: "tool-call", id: block.id, name: String(block.name ?? ""), args: "" });
        } else if (block?.type === "thinking" && typeof block.thinking === "string" && block.thinking) {
          blocks.set(index, { type: "thinking" });
          onEvent({ type: "reasoning-delta", text: block.thinking });
        } else {
          blocks.set(index, { type: "text" });
        }
        break;
      }
      case "content_block_delta": {
        const index = d.index;
        const delta = d.delta;
        if (delta?.type === "text_delta" && typeof delta.text === "string" && delta.text) {
          textParts.push(delta.text);
          onEvent({ type: "text-delta", text: delta.text });
        } else if (delta?.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking) {
          onEvent({ type: "reasoning-delta", text: delta.thinking });
        } else if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
          const block = blocks.get(index);
          if (block && block.type === "tool_use") {
            block.input += delta.partial_json;
            onEvent({ type: "tool-partial-call", id: block.id, name: block.name, args: block.input });
          }
        }
        break;
      }
      case "content_block_stop": {
        const block = blocks.get(d.index);
        if (block && block.type === "tool_use") {
          onEvent({ type: "tool-call", id: block.id, name: block.name, args: block.input });
        }
        break;
      }
      case "message_delta": {
        const usage = d.usage;
        if (typeof usage?.output_tokens === "number") outputTokens = usage.output_tokens;
        break;
      }
      case "message_stop": {
        break;
      }
      case "error": {
        const err = d.error;
        throw new Error(`Anthropic \u9519\u8BEF:${String(err?.message ?? "\u672A\u77E5\u9519\u8BEF")}`);
      }
      default:
        break;
    }
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
  }
  const calls = [...blocks.values()].filter((b) => b.type === "tool_use").map((b) => ({ id: b.id, name: b.name, args: b.input }));
  return {
    calls,
    text: textParts.join(""),
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cached_tokens: cacheReadTokens > 0 ? cacheReadTokens : void 0
    },
    aborted: signal.aborted
  };
}

// electron/agent/tools.ts
var import_node_child_process = require("node:child_process");
var import_node_fs = require("node:fs");
var import_node_os = __toESM(require("node:os"), 1);
var import_node_path = __toESM(require("node:path"), 1);
var import_electron = require("electron");
var XXT_SCRIPT = "C:/Users/asus/Desktop/MS Agent/main-sub-agent-system/tools/xxt/auto_answer.py";
var BILI_BIN = "C:/Users/asus/Desktop/bilibili/bili-rs/target/release/bili-tool.exe";
var DOCFLOW_BASE = "http://127.0.0.1:5000";
function runPython(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = (0, import_node_child_process.spawn)("python", args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => out += d.toString());
    child.stderr.on("data", (d) => err += d.toString());
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`\u811A\u672C\u6267\u884C\u8D85\u65F6(${Math.round(timeoutMs / 1e3)}s)`));
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`\u65E0\u6CD5\u542F\u52A8 python:${e.message}(\u9700\u5B89\u88C5 Python 3.10+)`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(out || err || `(\u8FDB\u7A0B\u9000\u51FA\u7801 ${code})`);
    });
  });
}
var biliDownloads = /* @__PURE__ */ new Map();
function runBiliBackground(args) {
  try {
    const child = (0, import_node_child_process.spawn)(BILI_BIN, args, { windowsHide: true, stdio: "ignore", detached: true });
    child.unref();
    const pid = child.pid ?? -1;
    biliDownloads.set(pid, { startedAt: Date.now(), args });
    child.on("close", (code) => {
      const job = biliDownloads.get(pid);
      biliDownloads.delete(pid);
      if (!job) return;
      const isUp = job.args[0] === "download";
      const label = isUp ? "UP \u4E3B\u89C6\u9891\u6279\u91CF\u4E0B\u8F7D" : "\u89C6\u9891\u4E0B\u8F7D";
      new import_electron.Notification({
        title: "B\u7AD9\u4E0B\u8F7D" + (code === 0 ? "\u5B8C\u6210" : "\u7ED3\u675F"),
        body: code === 0 ? `${label}\u5DF2\u5B8C\u6210,\u53EF\u5728 bili-tool \u4E0B\u8F7D\u76EE\u5F55\u67E5\u770B` : `${label}\u5F02\u5E38\u9000\u51FA(\u9000\u51FA\u7801 ${code}),\u8BF7\u7528 bili saved \u67E5\u770B\u8BB0\u5F55\u6216\u91CD\u8BD5`
      }).show();
    });
    return `\u5DF2\u540E\u53F0\u542F\u52A8 bili-tool \u4E0B\u8F7D:${args.join(" ")}(\u8FDB\u7A0B ${pid})\u3002**\u8FD9\u662F\u957F\u4EFB\u52A1,\u901A\u5E38 1-10 \u5206\u949F,\u4E0D\u8981\u7B49\u5F85**:\u8BF7\u7ACB\u5373\u544A\u77E5\u7528\u6237"\u4E0B\u8F7D\u5DF2\u5F00\u59CB,\u5B8C\u6210\u540E\u4F1A\u6709\u7CFB\u7EDF\u901A\u77E5";\u5B8C\u6210/\u5931\u8D25\u90FD\u4F1A\u81EA\u52A8\u53D1\u7CFB\u7EDF\u901A\u77E5,\u4E0D\u9700\u8981\u53CD\u590D\u67E5\u8BE2\u3002\u4EC5\u5F53\u7528\u6237\u4E3B\u52A8\u8BE2\u95EE\u4E0B\u8F7D\u8FDB\u5EA6\u65F6,\u624D\u8C03\u7528 bili saved \u67E5\u8BE2\u4E0B\u8F7D\u8BB0\u5F55(\u4E0B\u8F7D\u8FDB\u884C\u4E2D\u67E5\u4E0D\u5230\u8BB0\u5F55\u662F\u6B63\u5E38\u7684)\u3002`;
  } catch (e) {
    throw new Error(`\u65E0\u6CD5\u542F\u52A8 bili-tool:${e.message}(\u4E8C\u8FDB\u5236\u7F3A\u5931:${BILI_BIN})`);
  }
}
function runBili(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = (0, import_node_child_process.spawn)(BILI_BIN, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => out += d.toString());
    child.stderr.on("data", (d) => err += d.toString());
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`bili-tool \u6267\u884C\u8D85\u65F6(${Math.round(timeoutMs / 1e3)}s)`));
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`\u65E0\u6CD5\u542F\u52A8 bili-tool:${e.message}(\u4E8C\u8FDB\u5236\u7F3A\u5931:${BILI_BIN})`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(out || err || `(\u8FDB\u7A0B\u9000\u51FA\u7801 ${code})`);
    });
  });
}
async function biliQuery(params) {
  const action = String(params.action ?? "");
  const query = String(params.query ?? "").trim();
  let args = [];
  switch (action) {
    case "up_info": {
      if (!query) throw new Error("up_info \u9700\u8981 UP \u4E3B mid \u6216\u7A7A\u95F4\u94FE\u63A5");
      args = ["info", query, "--json"];
      break;
    }
    case "up_videos": {
      if (!query) throw new Error("up_videos \u9700\u8981 UP \u4E3B mid");
      args = ["list", query, "--json"];
      break;
    }
    case "search": {
      if (!query) throw new Error("search \u9700\u8981\u5173\u952E\u8BCD");
      const type = String(params.type ?? "video");
      if (!["video", "user", "bangumi"].includes(type)) {
        throw new Error("type \u4EC5\u652F\u6301 video/user/bangumi");
      }
      args = ["search", query, "--type", type, "--json"];
      break;
    }
    case "trending": {
      const rid = Number(params.rid) || 0;
      args = ["trending", "--rid", String(rid), "--json"];
      break;
    }
    case "comments": {
      if (!query) throw new Error("comments \u9700\u8981\u89C6\u9891 BV \u53F7\u6216\u94FE\u63A5");
      args = ["comments", query, "--json"];
      break;
    }
    case "download": {
      if (!query) throw new Error("download \u9700\u8981\u89C6\u9891 BV \u53F7\u6216\u94FE\u63A5");
      const dargs = ["get", query];
      if (params.audio) dargs.push("--audio", String(params.audio));
      if (params.quality) dargs.push("--quality", String(params.quality));
      if (params.outdir) dargs.push("--outdir", String(params.outdir));
      if (params.page) dargs.push("--page", String(Number(params.page) || 1));
      if (params.subs) dargs.push("--subs");
      if (params.no_danmaku) dargs.push("--no-danmaku");
      return runBiliBackground(dargs);
    }
    case "download_up": {
      if (!query) throw new Error("download_up \u9700\u8981 UP \u4E3B mid");
      const dargs = ["download", query];
      if (params.limit) dargs.push("--limit", String(Number(params.limit) || 0));
      if (params.days) dargs.push("--days", String(Number(params.days) || 0));
      if (params.regex) dargs.push("--regex", String(params.regex));
      if (params.audio) dargs.push("--audio", String(params.audio));
      if (params.quality) dargs.push("--quality", String(params.quality));
      if (params.outdir) dargs.push("--outdir", String(params.outdir));
      if (params.dry_run) dargs.push("--dry-run");
      return runBiliBackground(dargs);
    }
    case "danmaku": {
      if (!query) throw new Error("danmaku \u9700\u8981\u89C6\u9891 BV \u53F7\u6216\u94FE\u63A5");
      const dargs = ["danmaku", query];
      if (params.format) dargs.push("--fmt", String(params.format));
      return runBili(dargs, 6e4);
    }
    case "subtitle": {
      if (!query) throw new Error("subtitle \u9700\u8981\u89C6\u9891 BV \u53F7\u6216\u94FE\u63A5");
      return runBili(["subtitle", query], 6e4);
    }
    case "saved": {
      const limit = Math.min(Math.max(Number(params.limit) || 20, 1), 200);
      return runBili(["saved", "--limit", String(limit)], 3e4);
    }
    default:
      throw new Error(
        `\u672A\u77E5 action:${action}(\u652F\u6301 up_info/up_videos/search/trending/comments/download/download_up/danmaku/subtitle/saved)`
      );
  }
  return runBili(args, 3e4);
}
async function docConvert(params) {
  const inputPath = String(params.inputPath ?? "");
  if (!inputPath) throw new Error("inputPath \u4E0D\u80FD\u4E3A\u7A7A");
  if (!(0, import_node_fs.existsSync)(inputPath)) throw new Error(`\u6587\u4EF6\u4E0D\u5B58\u5728:${inputPath}`);
  const ext = import_node_path.default.extname(inputPath).toLowerCase();
  if (![".doc", ".docx", ".pdf"].includes(ext)) throw new Error("\u4EC5\u652F\u6301 .doc/.docx/.pdf \u6587\u4EF6");
  const target = String(params.target ?? (ext === ".pdf" ? "docx" : "pdf"));
  if (!["pdf", "docx", "markdown"].includes(target)) throw new Error("target \u4EC5\u652F\u6301 pdf/docx/markdown");
  const outputDir = typeof params.outputDir === "string" && params.outputDir ? params.outputDir : import_node_path.default.dirname(inputPath);
  const timeoutMs = Math.min(Math.max(Number(params.waitTimeout) || 120, 10), 600) * 1e3;
  const probe = await fetch(`${DOCFLOW_BASE}/api/engine`, { signal: AbortSignal.timeout(2e3) }).catch(() => null);
  if (!probe || !probe.ok) {
    throw new Error("DocFlow \u670D\u52A1\u672A\u8FD0\u884C:\u8BF7\u5728 DocFlow \u76EE\u5F55\u6267\u884C python server.py \u542F\u52A8\u540E\u91CD\u8BD5");
  }
  const buf = await import_node_fs.promises.readFile(inputPath);
  const fd = new FormData();
  fd.append("files", new Blob([buf]), import_node_path.default.basename(inputPath));
  if (target === "markdown") fd.append("mode", "to_markdown");
  const up = await fetch(`${DOCFLOW_BASE}/api/upload`, {
    method: "POST",
    body: fd,
    signal: AbortSignal.timeout(3e4)
  });
  if (!up.ok) throw new Error(`DocFlow \u4E0A\u4F20\u5931\u8D25 HTTP ${up.status}:${(await up.text()).slice(0, 300)}`);
  const upJson = await up.json();
  const jobId = upJson.jobs?.[0]?.id;
  if (!jobId) throw new Error("DocFlow \u672A\u63A5\u53D7\u8BE5\u6587\u4EF6(\u683C\u5F0F\u4E0D\u652F\u6301)");
  const conv = await fetch(`${DOCFLOW_BASE}/api/convert/${jobId}`, {
    method: "POST",
    signal: AbortSignal.timeout(1e4)
  });
  if (!conv.ok) throw new Error(`DocFlow \u8F6C\u6362\u542F\u52A8\u5931\u8D25 HTTP ${conv.status}`);
  const started = Date.now();
  for (; ; ) {
    if (Date.now() - started > timeoutMs) throw new Error("\u8F6C\u6362\u8D85\u65F6,\u8BF7\u7A0D\u540E\u5728 DocFlow \u9875\u9762\u67E5\u770B");
    const st = await fetch(`${DOCFLOW_BASE}/api/status/${jobId}`, {
      signal: AbortSignal.timeout(1e4)
    }).catch(() => null);
    if (st?.ok) {
      const s = await st.json();
      if (s.status === "done") break;
      if (s.status === "error") throw new Error(`\u8F6C\u6362\u5931\u8D25:${s.error ?? "\u672A\u77E5\u9519\u8BEF"}`);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  const dl = await fetch(`${DOCFLOW_BASE}/api/download/${jobId}`, {
    signal: AbortSignal.timeout(6e4)
  });
  if (!dl.ok) throw new Error(`DocFlow \u4E0B\u8F7D\u5931\u8D25 HTTP ${dl.status}`);
  const outBuf = Buffer.from(await dl.arrayBuffer());
  const outName = `${import_node_path.default.basename(inputPath, ext)}.${target === "markdown" ? "md" : target}`;
  await import_node_fs.promises.mkdir(outputDir, { recursive: true });
  const outPath = import_node_path.default.join(outputDir, outName);
  await import_node_fs.promises.writeFile(outPath, outBuf);
  return `\u8F6C\u6362\u5B8C\u6210:${outPath}(${outBuf.length} \u5B57\u8282)`;
}
var RESULT_MAX = 8e3;
var LIST_LIMIT = 200;
function runCommand(command, cwd, timeoutMs) {
  return new Promise((resolve, _reject) => {
    (0, import_node_child_process.exec)(
      command,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
        shell: true
      },
      (err, stdout, stderr) => {
        const out = [stdout, stderr].filter((s) => s && s.trim()).join("\n");
        if (err) {
          const code = err.code;
          resolve(`${out || "(\u65E0\u8F93\u51FA)"}
[\u547D\u4EE4\u9000\u51FA\u7801 ${code ?? "\u672A\u77E5"}]`);
          return;
        }
        resolve(out || "(\u547D\u4EE4\u5B8C\u6210,\u65E0\u8F93\u51FA)");
      }
    );
  });
}
function stripHtml(s) {
  return s.replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}
var SEARCH_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
async function searchBing(query, n) {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${n}`;
  const res = await fetch(url, { headers: { "User-Agent": SEARCH_UA }, signal: AbortSignal.timeout(15e3) });
  if (!res.ok) throw new Error(`Bing \u8FD4\u56DE HTTP ${res.status}`);
  const html = await res.text();
  const itemRe = /<li class="b_algo"[\s\S]*?<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<p[^>]*>([\s\S]*?)<\/p>)?[\s\S]*?<\/li>/g;
  const results = [];
  let m;
  while ((m = itemRe.exec(html)) && results.length < n) {
    const href = m[1];
    if (!/^https?:\/\//i.test(href)) continue;
    const title = stripHtml(m[2]);
    const snippet = stripHtml(m[3] ?? "");
    if (!title) continue;
    results.push(`${results.length + 1}. ${title}
   ${href}
   ${snippet}`);
  }
  if (results.length === 0) throw new Error("Bing \u672A\u89E3\u6790\u5230\u7ED3\u679C");
  return results.join("\n");
}
async function searchDuckDuckGo(query, n) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { "User-Agent": SEARCH_UA }, signal: AbortSignal.timeout(15e3) });
  if (!res.ok) throw new Error(`DDG \u8FD4\u56DE HTTP ${res.status}`);
  const html = await res.text();
  const linkRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  const links = [];
  let m;
  while ((m = linkRe.exec(html)) && links.length < n) {
    const href = m[1].replace(/^\/\/duckduckgo\.com\/l\/\?uddg=/, "").replace(/&rut=.*$/, "");
    links.push({ href: decodeURIComponent(href), title: stripHtml(m[2]) });
  }
  const snippets = [];
  while ((m = snippetRe.exec(html)) && snippets.length < n) snippets.push(stripHtml(m[1]));
  if (links.length === 0) throw new Error("DDG \u672A\u89E3\u6790\u5230\u7ED3\u679C");
  return links.map((l, i) => `${i + 1}. ${l.title}
   ${l.href}
   ${snippets[i] ?? ""}`).join("\n");
}
async function webSearch(query, count) {
  const n = Math.min(Math.max(count || 5, 1), 10);
  try {
    return await searchBing(query, n);
  } catch {
    try {
      return await searchDuckDuckGo(query, n);
    } catch {
      return "(\u641C\u7D22\u670D\u52A1\u6682\u4E0D\u53EF\u8FBE,\u53EF\u7A0D\u540E\u91CD\u8BD5\u6216\u6362\u5173\u952E\u8BCD)";
    }
  }
}
function createTools(deps) {
  return [
    {
      name: "exec_command",
      description: "\u5728\u672C\u673A\u6267\u884C shell \u547D\u4EE4(Windows:cmd.exe)\u3002\u65E0\u6C99\u7BB1\u9650\u5236,\u53EF\u64CD\u4F5C\u672C\u673A\u4EFB\u4F55\u5185\u5BB9\u3002\u547D\u4EE4\u8F93\u51FA\u4F1A\u8FD4\u56DE\u7ED9\u4F60;\u975E\u96F6\u9000\u51FA\u7801\u4E5F\u4F1A\u5E26\u8F93\u51FA\u8FD4\u56DE\u3002\u9002\u5408:\u67E5\u8FDB\u7A0B\u3001\u7BA1\u7406\u6587\u4EF6\u3001\u8FD0\u884C\u811A\u672C\u3001\u7CFB\u7EDF\u7EF4\u62A4\u3001\u5B89\u88C5\u5DE5\u5177\u7B49\u3002\u6CE8\u610F:\u5371\u9669\u547D\u4EE4(\u5220\u9664\u3001\u683C\u5F0F\u5316\u3001\u6539\u7CFB\u7EDF\u914D\u7F6E)\u8BF7\u8C28\u614E\u6267\u884C\u3002",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "\u8981\u6267\u884C\u7684\u5B8C\u6574\u547D\u4EE4(\u5982 dir\u3001tasklist \u7B49)" },
          cwd: { type: "string", description: "\u5DE5\u4F5C\u76EE\u5F55,\u7F3A\u7701\u4E3A\u7528\u6237\u4E3B\u76EE\u5F55" },
          timeout: { type: "number", description: "\u8D85\u65F6\u79D2\u6570,\u7F3A\u7701 30,\u6700\u5927 300" }
        },
        required: ["command"]
      },
      async execute(params) {
        const command = String(params.command ?? "").trim();
        if (!command) throw new Error("command \u4E0D\u80FD\u4E3A\u7A7A");
        const timeout = Math.min(Math.max(Number(params.timeout) || 30, 1), 300) * 1e3;
        const cwd = typeof params.cwd === "string" && params.cwd ? params.cwd : import_node_os.default.homedir();
        return runCommand(command, cwd, timeout);
      }
    },
    {
      name: "read_file",
      description: "\u8BFB\u53D6\u672C\u673A\u6587\u4EF6\u5185\u5BB9(UTF-8 \u6587\u672C)\u3002\u9002\u5408\u9605\u8BFB\u4EE3\u7801\u3001\u914D\u7F6E\u3001\u65E5\u5FD7\u7B49\u3002",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "\u6587\u4EF6\u7EDD\u5BF9\u8DEF\u5F84" },
          maxChars: { type: "number", description: "\u6700\u591A\u8FD4\u56DE\u5B57\u7B26\u6570,\u7F3A\u7701 8000" }
        },
        required: ["path"]
      },
      async execute(params) {
        const filePath = String(params.path ?? "");
        if (!filePath) throw new Error("path \u4E0D\u80FD\u4E3A\u7A7A");
        const text = await import_node_fs.promises.readFile(filePath, "utf8");
        const max = Math.min(Math.max(Number(params.maxChars) || RESULT_MAX, 200), 1e5);
        return text.length > max ? text.slice(0, max) + `
\u2026(\u5185\u5BB9\u8FC7\u957F,\u5DF2\u622A\u65AD\u5230 ${max} \u5B57\u7B26)` : text;
      }
    },
    {
      name: "write_file",
      description: "\u5199\u5165\u672C\u673A\u6587\u4EF6(UTF-8 \u6587\u672C),\u76EE\u5F55\u4E0D\u5B58\u5728\u4F1A\u81EA\u52A8\u521B\u5EFA\u3002\u8986\u76D6\u5DF2\u5B58\u5728\u5185\u5BB9\u3002",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "\u6587\u4EF6\u7EDD\u5BF9\u8DEF\u5F84" },
          content: { type: "string", description: "\u8981\u5199\u5165\u7684\u5B8C\u6574\u5185\u5BB9" }
        },
        required: ["path", "content"]
      },
      async execute(params) {
        const filePath = String(params.path ?? "");
        const content = String(params.content ?? "");
        if (!filePath) throw new Error("path \u4E0D\u80FD\u4E3A\u7A7A");
        await import_node_fs.promises.mkdir(import_node_path.default.dirname(filePath), { recursive: true });
        await import_node_fs.promises.writeFile(filePath, content, "utf8");
        return `\u5DF2\u5199\u5165 ${filePath}(${Buffer.byteLength(content, "utf8")} \u5B57\u8282)`;
      }
    },
    {
      name: "list_dir",
      description: "\u5217\u51FA\u76EE\u5F55\u5185\u5BB9(\u6587\u4EF6/\u5B50\u76EE\u5F55\u540D,\u6700\u591A 200 \u6761)\u3002\u9002\u5408\u63A2\u67E5\u76EE\u5F55\u7ED3\u6784\u3002",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "\u76EE\u5F55\u7EDD\u5BF9\u8DEF\u5F84,\u7F3A\u7701\u4E3A\u7528\u6237\u4E3B\u76EE\u5F55" }
        },
        required: []
      },
      async execute(params) {
        const dir = typeof params.path === "string" && params.path ? params.path : import_node_os.default.homedir();
        const entries = await import_node_fs.promises.readdir(dir, { withFileTypes: true });
        const lines = entries.slice(0, LIST_LIMIT).map((e) => e.isDirectory() ? `[\u76EE\u5F55] ${e.name}` : e.name);
        if (entries.length > LIST_LIMIT) lines.push(`\u2026(\u5171 ${entries.length} \u9879,\u5DF2\u622A\u65AD)`);
        return lines.join("\n");
      }
    },
    {
      name: "open_url",
      description: "\u7528\u7CFB\u7EDF\u9ED8\u8BA4\u6D4F\u89C8\u5668\u6253\u5F00\u7F51\u5740(\u4EC5 http/https)\u3002",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "\u5B8C\u6574\u7F51\u5740,\u5982 https://example.com" }
        },
        required: ["url"]
      },
      async execute(params) {
        const raw = String(params.url ?? "").trim();
        if (!/^https?:\/\//i.test(raw)) throw new Error("\u4EC5\u652F\u6301 http/https \u7F51\u5740");
        await import_electron.shell.openExternal(raw);
        return `\u5DF2\u7528\u9ED8\u8BA4\u6D4F\u89C8\u5668\u6253\u5F00 ${raw}`;
      }
    },
    {
      name: "open_file",
      description: "\u7528\u7CFB\u7EDF\u9ED8\u8BA4\u7A0B\u5E8F\u6253\u5F00\u6587\u4EF6\u6216\u6587\u4EF6\u5939(\u5982\u56FE\u7247\u3001\u6587\u6863\u3001\u76EE\u5F55)\u3002",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "\u6587\u4EF6\u6216\u6587\u4EF6\u5939\u7EDD\u5BF9\u8DEF\u5F84" }
        },
        required: ["path"]
      },
      async execute(params) {
        const target = String(params.path ?? "");
        if (!target) throw new Error("path \u4E0D\u80FD\u4E3A\u7A7A");
        const errMsg = await import_electron.shell.openPath(target);
        if (errMsg) throw new Error(`\u6253\u5F00\u5931\u8D25:${errMsg}`);
        return `\u5DF2\u6253\u5F00 ${target}`;
      }
    },
    {
      name: "web_search",
      description: "\u8054\u7F51\u641C\u7D22\u7F51\u9875\u4FE1\u606F(\u8FD4\u56DE\u6807\u9898+\u94FE\u63A5+\u6458\u8981\u5217\u8868)\u3002\u641C\u7D22\u7ED3\u679C\u53EF\u80FD\u6709\u9650,\u53EF\u591A\u8BD5\u5173\u952E\u8BCD\u3002",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "\u641C\u7D22\u5173\u952E\u8BCD" },
          count: { type: "number", description: "\u8FD4\u56DE\u6761\u6570,\u7F3A\u7701 5,\u6700\u5927 10" }
        },
        required: ["query"]
      },
      async execute(params) {
        return webSearch(String(params.query ?? ""), Number(params.count) || 5);
      }
    },
    {
      name: "get_time",
      description: "\u83B7\u53D6\u5F53\u524D\u65E5\u671F\u65F6\u95F4(\u672C\u5730\u65F6\u533A)\u3002",
      parameters: { type: "object", properties: {} },
      async execute() {
        const now = /* @__PURE__ */ new Date();
        const weekday = ["\u5468\u65E5", "\u5468\u4E00", "\u5468\u4E8C", "\u5468\u4E09", "\u5468\u56DB", "\u5468\u4E94", "\u5468\u516D"][now.getDay()];
        return `${now.toLocaleString("zh-CN")} ${weekday}(${Intl.DateTimeFormat().resolvedOptions().timeZone})`;
      }
    },
    {
      name: "system_info",
      description: "\u83B7\u53D6\u672C\u673A\u7CFB\u7EDF\u4FE1\u606F:\u64CD\u4F5C\u7CFB\u7EDF\u3001CPU\u3001\u5185\u5B58\u3001\u8FD0\u884C\u65F6\u957F\u7B49\u3002",
      parameters: { type: "object", properties: {} },
      async execute() {
        const cpus = import_node_os.default.cpus();
        return [
          `\u7CFB\u7EDF:${import_node_os.default.platform()} ${import_node_os.default.release()}(${import_node_os.default.arch()})`,
          `\u4E3B\u673A:${import_node_os.default.hostname()}`,
          `CPU:${cpus[0]?.model ?? "\u672A\u77E5"} \xD7 ${cpus.length}`,
          `\u5185\u5B58:${(import_node_os.default.totalmem() / 1024 ** 3).toFixed(1)} GB,\u53EF\u7528 ${(import_node_os.default.freemem() / 1024 ** 3).toFixed(1)} GB`,
          `\u8FD0\u884C\u65F6\u957F:${Math.floor(import_node_os.default.uptime() / 3600)} \u5C0F\u65F6`,
          `Node:${process.version}`
        ].join("\n");
      }
    },
    {
      name: "notify",
      description: "\u53D1\u9001 Windows \u7CFB\u7EDF\u901A\u77E5(\u53F3\u4E0B\u89D2)\u3002\u9002\u5408\u63D0\u9192\u3001\u5B9A\u65F6\u901A\u77E5\u7B49\u573A\u666F\u3002",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "\u901A\u77E5\u6807\u9898" },
          message: { type: "string", description: "\u901A\u77E5\u6B63\u6587" }
        },
        required: ["title", "message"]
      },
      async execute(params) {
        if (!import_electron.Notification.isSupported()) return "(\u5F53\u524D\u7CFB\u7EDF\u4E0D\u652F\u6301\u901A\u77E5)";
        new import_electron.Notification({
          title: String(params.title ?? "Agent"),
          body: String(params.message ?? "")
        }).show();
        return "\u901A\u77E5\u5DF2\u53D1\u9001";
      }
    },
    {
      name: "switch_to_music",
      description: "\u628A\u7075\u52A8\u5C9B\u6302\u4EF6\u4ECE Agent \u6A21\u5F0F\u5207\u56DE\u97F3\u4E50\u64AD\u653E\u5668\u6A21\u5F0F(\u5C9B\u4F53\u6062\u590D\u6B4C\u66F2/\u64AD\u653E\u63A7\u5236)\u3002",
      parameters: { type: "object", properties: {} },
      async execute() {
        deps.onSwitchToMusic();
        return "\u5DF2\u5207\u6362\u5230\u97F3\u4E50\u6A21\u5F0F";
      }
    },
    {
      name: "doc_convert",
      description: "\u6587\u6863\u683C\u5F0F\u8F6C\u6362(\u8C03\u7528\u672C\u673A DocFlow \u670D\u52A1):DOC/DOCX\u2192PDF\u3001PDF\u2192DOCX\u3001PDF/DOC/DOCX\u2192Markdown\u3002\u9002\u5408\u6587\u6863\u5904\u7406\u4EFB\u52A1\u3002\u6CE8\u610F:\u9700\u8981 DocFlow \u670D\u52A1\u5DF2\u542F\u52A8(\u5728 DocFlow \u76EE\u5F55\u8FD0\u884C python server.py)\u3002",
      parameters: {
        type: "object",
        properties: {
          inputPath: { type: "string", description: "\u8F93\u5165\u6587\u4EF6\u7EDD\u5BF9\u8DEF\u5F84(\u652F\u6301 .doc/.docx/.pdf)" },
          target: {
            type: "string",
            enum: ["pdf", "docx", "markdown"],
            description: "\u76EE\u6807\u683C\u5F0F;\u7F3A\u7701\u6309\u8F93\u5165\u7C7B\u578B\u81EA\u52A8(pdf\u2192docx\u3001doc/docx\u2192pdf)"
          },
          outputDir: { type: "string", description: "\u8F93\u51FA\u76EE\u5F55,\u7F3A\u7701\u4E3A\u8F93\u5165\u6587\u4EF6\u6240\u5728\u76EE\u5F55" },
          waitTimeout: { type: "number", description: "\u7B49\u5F85\u8F6C\u6362\u5B8C\u6210\u79D2\u6570,\u7F3A\u7701 120,\u6700\u5927 600" }
        },
        required: ["inputPath"]
      },
      async execute(params) {
        return docConvert(params);
      }
    },
    {
      name: "xxt",
      description: "\u8D85\u661F\u5B66\u4E60\u901A\u81EA\u52A8\u7B54\u9898(\u8C03\u7528\u672C\u673A xxt \u5DE5\u5177):login \u6253\u5F00\u6D4F\u89C8\u5668\u7B49\u5F85\u4EBA\u5DE5\u767B\u5F55 / crawl \u722C\u53D6\u9898\u76EE(\u8FD4\u56DE\u9898\u76EE JSON)/ fill \u586B\u5145\u7B54\u6848(\u4F20 answers JSON)/ check \u68C0\u67E5\u586B\u5145\u72B6\u6001 / submit \u6682\u5B58\u5E76\u63D0\u4EA4 / screenshot \u622A\u56FE\u3002\u5DE5\u4F5C\u6D41:crawl \u83B7\u53D6\u9898\u76EE \u2192 Agent \u751F\u6210\u7B54\u6848 \u2192 fill \u586B\u5145 \u2192 check \u786E\u8BA4 \u2192 submit \u63D0\u4EA4\u3002",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["login", "crawl", "fill", "check", "submit", "screenshot"],
            description: "\u64CD\u4F5C:login / crawl / fill / check / submit / screenshot"
          },
          url: { type: "string", description: "\u4F5C\u4E1A\u9875\u9762 URL(\u9664 login \u5916\u5747\u5FC5\u586B)" },
          answers: {
            type: "string",
            description: 'fill \u65F6\u7684\u7B54\u6848,JSON \u5B57\u7B26\u4E32,\u5982 {"1":"C","2":"A","3":"\u7B54\u6848\u6587\u672C"}'
          },
          output: { type: "string", description: "screenshot \u7684\u622A\u56FE\u4FDD\u5B58\u8DEF\u5F84" },
          headless: { type: "boolean", description: "\u65E0\u5934\u6D4F\u89C8\u5668\u6A21\u5F0F,\u7F3A\u7701 false(\u53EF\u89C1\u7A97\u53E3)" }
        },
        required: ["action"]
      },
      async execute(params) {
        const action = String(params.action ?? "");
        const actions = ["login", "crawl", "fill", "check", "submit", "screenshot"];
        if (!actions.includes(action)) throw new Error(`action \u4EC5\u652F\u6301:${actions.join("/")}`);
        const url = String(params.url ?? "");
        if (action !== "login" && !url) throw new Error("\u8BE5\u64CD\u4F5C\u9700\u8981 url \u53C2\u6570(\u4F5C\u4E1A\u9875\u9762\u94FE\u63A5)");
        if (!import_node_fs.promises.existsSync(XXT_SCRIPT)) {
          throw new Error(`xxt \u811A\u672C\u4E0D\u5B58\u5728:${XXT_SCRIPT}`);
        }
        const args = [XXT_SCRIPT, action];
        if (url) args.push("--url", url);
        if (action === "fill" && params.answers) args.push("--answers", String(params.answers));
        if (action === "screenshot" && params.output) args.push("--output", String(params.output));
        if (params.headless) args.push("--headless");
        const timeoutMs = action === "login" ? 3e5 : 18e4;
        return runPython(args, timeoutMs);
      }
    },
    {
      name: "bili",
      description: 'B\u7AD9\u6570\u636E\u67E5\u8BE2\u4E0E\u89C6\u9891\u4E0B\u8F7D(\u8C03\u7528\u672C\u673A bili-tool,Rust \u5355\u4E8C\u8FDB\u5236,\u514D Python)\u3002\u67E5\u8BE2:up_info \u67E5 UP \u4E3B\u4FE1\u606F(\u7C89\u4E1D/\u5173\u6CE8/\u6295\u7A3F/\u83B7\u8D5E) / up_videos \u67E5 UP \u4E3B\u89C6\u9891\u5217\u8868 / search \u641C\u7D22\u89C6\u9891/\u7528\u6237/\u756A\u5267 / trending \u67E5\u70ED\u95E8\u699C(\u5206\u533A rid:0\u5168\u7AD9 1\u52A8\u753B 3\u97F3\u4E50 4\u6E38\u620F 5\u5A31\u4E50 36\u79D1\u6280 119\u9B3C\u755C 129\u821E\u8E48 155\u751F\u6D3B 160\u65F6\u5C1A 167\u77E5\u8BC6 181\u5F71\u89C6) / comments \u67E5\u89C6\u9891\u8BC4\u8BBA\u533A\u3002\u4E0B\u8F7D:download \u4E0B\u8F7D\u5355\u4E2A\u89C6\u9891 / download_up \u6279\u91CF\u4E0B\u8F7D UP \u4E3B\u89C6\u9891(\u53EF\u9650\u6700\u8FD1 N \u4E2A/\u6B63\u5219\u8FC7\u6EE4,\u652F\u6301 --dry-run \u5148\u9884\u89C8) / danmaku \u4E0B\u8F7D\u5F39\u5E55(XML/ASS/TXT/JSON) / subtitle \u4E0B\u8F7D CC \u5B57\u5E55 / saved \u67E5\u5DF2\u4E0B\u8F7D\u8BB0\u5F55\u3002**\u4E0B\u8F7D\u662F\u540E\u53F0\u957F\u4EFB\u52A1(\u901A\u5E38 1-10 \u5206\u949F)**:\u542F\u52A8\u540E\u7ACB\u5373\u8FD4\u56DE\u5E76\u544A\u77E5\u7528\u6237"\u4E0B\u8F7D\u5DF2\u5F00\u59CB",**\u4E0D\u8981\u53CD\u590D\u8F6E\u8BE2 saved \u7B49\u5F85**\u2014\u2014\u5B8C\u6210/\u5931\u8D25\u4F1A\u81EA\u52A8\u53D1\u7CFB\u7EDF\u901A\u77E5;\u4EC5\u5F53\u7528\u6237\u4E3B\u52A8\u8BE2\u95EE\u8FDB\u5EA6\u65F6\u624D\u8C03\u7528 saved\u3002\u6E05\u6670\u5EA6\u5EFA\u8BAE:1080p \u6587\u4EF6\u5927\u4E0B\u8F7D\u6162,\u53EF\u4F18\u5148 720p \u6216\u4EC5\u97F3\u9891(audio=mp3)\u3002**B\u7AD9 API \u9650\u5236\u77E5\u8BC6(\u67E5\u8BE2\u5931\u8D25\u65F6\u6309\u6B64\u5224\u65AD\u4E0E\u7B54\u590D\u7528\u6237)**:\u2460 \u63A5\u53E3\u9700\u8981\u6D4F\u89C8\u5668 UA \u4E0E WBI/App \u7B7E\u540D,\u5DE5\u5177\u5DF2\u5185\u7F6E(bili-tool \u5B9E\u73B0 WBI mixin \u7B7E\u540D\u4E0E\u79FB\u52A8\u7AEF appkey \u7B7E\u540D);\u2461 \u6E38\u5BA2\u8BF7\u6C42\u4F1A\u89E6\u53D1\u98CE\u63A7\u2014\u2014\u70ED\u95E8\u699C/\u90E8\u5206\u641C\u7D22/\u8BC4\u8BBA\u533A\u53EF\u80FD\u8FD4\u56DE -352 \u7B49\u9519\u8BEF\u7801(IP \u98CE\u63A7/\u9650\u6D41),\u5BF9\u7B56:\u964D\u4F4E\u8BF7\u6C42\u9891\u7387\u3001\u7A0D\u540E\u91CD\u8BD5\u3001\u66F4\u6362\u5173\u952E\u8BCD\u6216\u5206\u533A;\u2462 \u9AD8\u753B\u8D28(1080P+)\u3001\u6536\u85CF\u5939\u3001\u5408\u96C6\u7B49\u63A5\u53E3\u9700\u8981\u767B\u5F55\u6001\u2014\u2014bili-tool \u53EF\u626B\u7801\u767B\u5F55(login),\u767B\u5F55\u540E\u591A\u6570\u9650\u5236\u89E3\u9664;\u2463 \u4E0B\u8F7D\u4F9D\u8D56\u672C\u673A ffmpeg \u4E0E\u767B\u5F55\u6001(\u9AD8\u753B\u8D28\u6E90);\u2464 \u90E8\u5206\u63A5\u53E3\u5076\u53D1 -400(\u53C2\u6570/\u6743\u9650),\u591A\u4E3A\u63A5\u53E3\u9650\u5236,\u6362\u7528\u79FB\u52A8\u7AEF API \u6216\u767B\u5F55\u53EF\u7ED5\u8FC7(\u5DE5\u5177\u5DF2\u5185\u7F6E\u515C\u5E95)\u3002mid \u53EF\u4E3A\u7EAF\u6570\u5B57\u6216 bilibili \u7A7A\u95F4\u94FE\u63A5,BV \u53F7\u53EF\u4E3A\u94FE\u63A5\u3002',
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [
              "up_info",
              "up_videos",
              "search",
              "trending",
              "comments",
              "download",
              "download_up",
              "danmaku",
              "subtitle",
              "saved"
            ],
            description: "\u64CD\u4F5C:up_info/up_videos/search/trending/comments(\u67E5\u8BE2)/download(\u5355\u89C6\u9891\u4E0B\u8F7D)/download_up(UP\u6279\u91CF\u4E0B\u8F7D)/danmaku(\u5F39\u5E55)/subtitle(\u5B57\u5E55)/saved(\u4E0B\u8F7D\u8BB0\u5F55)"
          },
          query: {
            type: "string",
            description: "\u67E5\u8BE2/\u4E0B\u8F7D\u76EE\u6807:UP \u4E3B mid \u6216\u7A7A\u95F4\u94FE\u63A5(up_info/up_videos/download_up)\u3001\u641C\u7D22\u5173\u952E\u8BCD(search)\u3001\u89C6\u9891 BV \u53F7\u6216\u94FE\u63A5(download/comments/danmaku/subtitle);trending/saved \u4E0D\u9700\u8981"
          },
          type: {
            type: "string",
            enum: ["video", "user", "bangumi"],
            description: "search \u7684\u641C\u7D22\u7C7B\u578B,\u7F3A\u7701 video"
          },
          rid: { type: "number", description: "trending \u7684\u5206\u533A id,\u7F3A\u7701 0(\u5168\u7AD9)" },
          audio: { type: "string", description: "\u4EC5\u4E0B\u8F7D\u97F3\u9891\u5E76\u8F6C\u7801\u4E3A\u6307\u5B9A\u683C\u5F0F(\u5982 mp3/flac);\u4E0D\u586B = \u89C6\u9891" },
          quality: { type: "string", description: "\u89C6\u9891\u6E05\u6670\u5EA6(\u5982 1080p/720p/360p),\u7F3A\u7701 best" },
          outdir: { type: "string", description: "\u4E0B\u8F7D\u8F93\u51FA\u76EE\u5F55,\u7F3A\u7701 bili-tool \u7684 downloads/" },
          page: { type: "number", description: "download \u591A P \u89C6\u9891\u7684\u9009\u96C6\u9875\u7801,\u7F3A\u7701 1" },
          subs: { type: "boolean", description: "download \u540C\u65F6\u4E0B\u8F7D CC \u5B57\u5E55" },
          no_danmaku: { type: "boolean", description: "download \u4E0D\u4E0B\u8F7D\u5F39\u5E55" },
          limit: { type: "number", description: "download_up \u53EA\u4E0B\u8F7D\u6700\u8FD1 N \u4E2A\u89C6\u9891;saved \u663E\u793A\u8BB0\u5F55\u6761\u6570(\u7F3A\u7701 20)" },
          days: { type: "number", description: "download_up \u53EA\u4E0B\u8F7D\u6700\u8FD1 N \u5929\u53D1\u5E03\u7684\u89C6\u9891" },
          regex: { type: "string", description: "download_up \u6309\u6807\u9898\u6B63\u5219\u8FC7\u6EE4(\u53EA\u4E0B\u8F7D\u5339\u914D\u7684\u89C6\u9891)" },
          dry_run: { type: "boolean", description: "download_up \u53EA\u5217\u51FA\u5C06\u4E0B\u8F7D\u7684\u89C6\u9891,\u4E0D\u5B9E\u9645\u4E0B\u8F7D(\u9884\u89C8)" },
          format: { type: "string", enum: ["xml", "ass", "txt", "json"], description: "danmaku \u7684\u8F93\u51FA\u683C\u5F0F,\u7F3A\u7701 xml" }
        },
        required: ["action"]
      },
      async execute(params) {
        return biliQuery(params);
      }
    }
  ];
}

// electron/agent/engine.ts
function detectProvider(baseURL) {
  return baseURL.toLowerCase().includes("anthropic") ? "anthropic" : "responses";
}
function streamByConfig(params) {
  return detectProvider(params.config.baseURL) === "anthropic" ? streamAnthropic(params) : streamResponse(params);
}
var MAX_STEPS = 25;
var TOOL_TIMEOUT_MS = 6e4;
var MAX_CONTEXT_TOKENS = 2e5;
var MIN_KEEP_MESSAGES = 10;
function estimateMessageTokens(m) {
  let n = 0;
  for (const p of m.parts) {
    if (p.type === "text" || p.type === "reasoning") n += p.text.length * 0.6;
    else if (p.type === "tool-result") n += p.result.length * 0.6;
    else if (p.type === "tool-call") n += JSON.stringify(p.args ?? {}).length * 0.3;
  }
  return Math.ceil(n);
}
function sanitizeTitle(raw) {
  const text = raw.trim().replace(/^[「『"'《<]+|[」』"'》>]+$/g, "").trim();
  return Array.from(text).slice(0, 10).join("");
}
function trimHistory(history) {
  let total = 0;
  for (const m of history) total += estimateMessageTokens(m);
  if (total <= MAX_CONTEXT_TOKENS) return history;
  const keep = [];
  let sum = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const t = estimateMessageTokens(history[i]);
    if (sum + t > MAX_CONTEXT_TOKENS && keep.length >= MIN_KEEP_MESSAGES) break;
    keep.unshift(history[i]);
    sum += t;
  }
  return keep;
}
function createSummaryAgent(deps) {
  return {
    async summarize(messages) {
      const config = deps.getConfig();
      if (!config.apiKey.trim() || messages.length === 0) return "";
      try {
        const recent = messages.slice(-12).map((m) => ({
          ...m,
          parts: m.parts.map(
            (p) => p.type === "reasoning" ? { ...p, text: p.text.slice(0, 500) } : p.type === "tool-result" ? { ...p, result: p.result.slice(0, 2e3) } : p
          )
        }));
        const result = await streamByConfig({
          config: { ...config, reasoningEffort: "low" },
          system: "\u4F60\u662F\u5BF9\u8BDD\u6807\u9898\u751F\u6210\u5668\u3002\u6839\u636E\u5BF9\u8BDD\u5185\u5BB9\u751F\u6210\u4E00\u4E2A\u4E0D\u8D85\u8FC7 8 \u4E2A\u6C49\u5B57\u7684\u7B80\u77ED\u6807\u9898,\u76F4\u63A5\u8FD4\u56DE\u6807\u9898\u6587\u672C,\u4E0D\u8981\u4EFB\u4F55\u89E3\u91CA\u3001\u6807\u70B9\u6216\u5F15\u53F7\u3002",
          history: recent,
          tools: [],
          signal: AbortSignal.timeout(45e3),
          onEvent: () => {
          }
        });
        return sanitizeTitle(result.text);
      } catch {
        return "";
      }
    }
  };
}
function createAgentEngine(deps) {
  let running = false;
  let ctl = null;
  const emit = (event) => deps.onEvent(event);
  async function runSubAgent(params) {
    const task = String(params.task ?? "").trim();
    if (!task) throw new Error("delegate \u7684 task \u53C2\u6570\u4E0D\u80FD\u4E3A\u7A7A");
    const config = deps.getConfig();
    if (!config.apiKey.trim()) throw new Error("\u5C1A\u672A\u914D\u7F6E DeepSeek API Key");
    const allowAll = !Array.isArray(params.tools) || params.tools.length === 0;
    const allowed = new Set((Array.isArray(params.tools) ? params.tools : []).map(String));
    const subTools = tools.filter((t) => allowAll || allowed.has(t.name));
    const subMap = new Map(subTools.map((t) => [t.name, t]));
    const system = [
      config.systemPrompt,
      String(params.system ?? "").trim() || "\u4F60\u662F\u5B50\u4EE3\u7406,\u4E13\u6CE8\u5B8C\u6210\u59D4\u6D3E\u7684\u5B50\u4EFB\u52A1,\u53EA\u8FD4\u56DE\u4EFB\u52A1\u7ED3\u679C\u6587\u672C,\u4E0D\u8981\u591A\u4F59\u89E3\u91CA\u3002"
    ].filter(Boolean).join("\n");
    const historyIn = [
      { id: (0, import_node_crypto.randomUUID)(), role: "user", parts: [{ type: "text", text: task }] }
    ];
    const msgParts = [];
    let reasoningText = "";
    let pushedParts = 0;
    for (let step = 1; step <= MAX_STEPS; step++) {
      const result = await streamByConfig({
        config,
        system,
        history: historyIn,
        tools: subTools,
        signal: AbortSignal.timeout(55e3),
        onEvent: (event) => {
          if (event.type === "reasoning-delta") reasoningText += event.text;
        }
      });
      if (result.aborted) break;
      if (reasoningText) {
        msgParts.push({ type: "reasoning", text: reasoningText });
        reasoningText = "";
      }
      const text = result.text;
      if (text) msgParts.push({ type: "text", text });
      if (result.calls.length === 0) break;
      const batch = result.calls.map((c) => ({ id: c.id, name: c.name, args: parseToolArgs(c.args) }));
      const results = await executeToolBatch(batch, subMap, subTools);
      for (let i = 0; i < batch.length; i++) {
        const r = results[i];
        msgParts.push({ type: "tool-call", id: r.id, name: r.name, args: batch[i].args });
        msgParts.push({
          type: "tool-result",
          id: r.id,
          name: r.name,
          ok: r.ok,
          result: r.out,
          durationMs: r.durationMs
        });
      }
      historyIn.push({ id: (0, import_node_crypto.randomUUID)(), role: "assistant", parts: msgParts.slice(pushedParts) });
      pushedParts = msgParts.length;
    }
    const reply = msgParts.filter((p) => p.type === "text").map((p) => p.text).join("\n");
    return reply || "(\u5B50\u4EE3\u7406\u672A\u8FD4\u56DE\u6587\u672C\u7ED3\u679C)";
  }
  const delegateTool = {
    name: "delegate",
    description: "\u59D4\u6D3E\u5B50\u4EFB\u52A1\u7ED9\u5B50 Agent \u5E76\u884C\u5904\u7406\u3002\u9002\u5408\u628A\u5927\u4EFB\u52A1\u62C6\u6210\u591A\u4E2A\u72EC\u7ACB\u5B50\u4EFB\u52A1:\u4E00\u6B21\u8C03\u7528\u591A\u4E2A delegate \u5373\u53EF\u5E76\u884C\u6267\u884C,\u6BCF\u4E2A\u5B50 Agent \u6709\u72EC\u7ACB\u4E0A\u4E0B\u6587,\u53EF\u7528\u5DE5\u5177\u6267\u884C\u5E76\u8FD4\u56DE\u7ED3\u679C\u6587\u672C\u3002\u6CE8\u610F:\u5B50\u4EFB\u52A1\u4E4B\u95F4\u5E94\u5C3D\u91CF\u72EC\u7ACB,\u907F\u514D\u4E92\u76F8\u7B49\u5F85\u3002",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "\u5B50\u4EFB\u52A1\u63CF\u8FF0:\u8981\u5B8C\u6210\u4EC0\u4E48\u3001\u671F\u671B\u7684\u8F93\u51FA" },
        system: { type: "string", description: "\u53EF\u9009:\u5B50 Agent \u4E13\u7528\u7CFB\u7EDF\u63D0\u793A(\u89D2\u8272/\u7EA6\u675F/\u8F93\u51FA\u683C\u5F0F)" },
        tools: {
          type: "array",
          items: { type: "string" },
          description: "\u53EF\u9009:\u5141\u8BB8\u5B50 Agent \u4F7F\u7528\u7684\u5DE5\u5177\u540D\u5217\u8868,\u7F3A\u7701\u5168\u90E8"
        }
      },
      required: ["task"]
    },
    async execute(params) {
      return runSubAgent(params);
    }
  };
  const tools = [...createTools(deps), delegateTool];
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  async function executeToolBatch(batch, map, list) {
    return Promise.all(
      batch.map(async ({ id, name, args }) => {
        const tool = map.get(name);
        const started = Date.now();
        let out;
        let ok;
        if (!tool) {
          out = `\u672A\u77E5\u5DE5\u5177:${name}(\u53EF\u7528\u5DE5\u5177:${list.map((t) => t.name).join("\u3001")})`;
          ok = false;
        } else {
          try {
            out = await Promise.race([
              Promise.resolve(tool.execute(args)),
              new Promise(
                (_, reject) => setTimeout(() => reject(new Error(`\u5DE5\u5177\u6267\u884C\u8D85\u65F6(${TOOL_TIMEOUT_MS / 1e3}s)`)), TOOL_TIMEOUT_MS)
              )
            ]);
            ok = true;
          } catch (err) {
            out = `\u5DE5\u5177\u6267\u884C\u5931\u8D25:${err.message}`;
            ok = false;
          }
        }
        return { id, name, ok, out, durationMs: Date.now() - started };
      })
    );
  }
  async function runTurn(text, history, ctx) {
    const { signal, onEvent, config } = ctx;
    onEvent({ type: "status", status: "thinking" });
    const historyIn = [
      ...trimHistory(history),
      { id: (0, import_node_crypto.randomUUID)(), role: "user", parts: [{ type: "text", text }] }
    ];
    const msgParts = [];
    let pushedParts = 0;
    let reasoningText = "";
    let usage = { input: 0, output: 0 };
    for (let step = 1; step <= MAX_STEPS; step++) {
      if (signal.aborted) return;
      const result = await streamByConfig({
        config,
        system: config.systemPrompt || "\u4F60\u662F\u684C\u9762\u7075\u52A8\u5C9B\u6302\u4EF6\u91CC\u7684\u4E2A\u4EBA\u52A9\u624B\u3002",
        history: historyIn,
        tools,
        signal,
        onEvent: (event) => {
          if (event.type === "reasoning-delta") reasoningText += event.text;
          onEvent(event);
        }
      });
      if (result.aborted || signal.aborted) return;
      if (result.usage) {
        usage.input += result.usage.input_tokens;
        usage.output += result.usage.output_tokens;
        if (result.usage.cached_tokens) usage.cached = (usage.cached ?? 0) + result.usage.cached_tokens;
      }
      if (reasoningText) {
        msgParts.push({ type: "reasoning", text: reasoningText });
        reasoningText = "";
      }
      const text2 = result.text;
      if (text2) msgParts.push({ type: "text", text: text2 });
      const calls = result.calls;
      if (calls.length === 0) {
        onEvent({
          type: "message",
          message: { id: (0, import_node_crypto.randomUUID)(), role: "assistant", parts: msgParts },
          usage
        });
        onEvent({ type: "status", status: "idle" });
        return;
      }
      onEvent({ type: "status", status: "running" });
      const batch = [];
      for (const call of calls) {
        if (signal.aborted) return;
        const args = parseToolArgs(call.args);
        msgParts.push({ type: "tool-call", id: call.id, name: call.name, args });
        batch.push({ id: call.id, name: call.name, args });
      }
      const results = await executeToolBatch(batch, toolMap, tools);
      for (const r of results) {
        if (signal.aborted) return;
        onEvent({
          type: "tool-result",
          id: r.id,
          name: r.name,
          ok: r.ok,
          result: r.out,
          durationMs: r.durationMs
        });
        msgParts.push({
          type: "tool-result",
          id: r.id,
          name: r.name,
          ok: r.ok,
          result: r.out,
          durationMs: r.durationMs
        });
      }
      historyIn.push({ id: (0, import_node_crypto.randomUUID)(), role: "assistant", parts: msgParts.slice(pushedParts) });
      pushedParts = msgParts.length;
    }
    onEvent({ type: "error", message: `\u5DE5\u5177\u5FAA\u73AF\u8D85\u8FC7 ${MAX_STEPS} \u8F6E\u4ECD\u672A\u5B8C\u6210,\u5DF2\u505C\u6B62(\u8BF7\u62C6\u89E3\u4EFB\u52A1\u6216\u6362\u79CD\u601D\u8DEF\u518D\u8BD5)` });
    onEvent({ type: "status", status: "idle" });
  }
  return {
    get busy() {
      return running;
    },
    send(text, history) {
      if (running) {
        emit({ type: "error", message: "Agent \u6B63\u5728\u8FD0\u884C\u4E2D,\u8BF7\u5148\u7B49\u5F85\u6216\u4E2D\u6B62" });
        return;
      }
      const config = deps.getConfig();
      if (!config.apiKey.trim()) {
        emit({ type: "error", message: "\u5C1A\u672A\u914D\u7F6E DeepSeek API Key(\u6258\u76D8\u83DC\u5355 \u2192 \u8BBE\u7F6E \u2192 Agent \u8BBE\u7F6E)" });
        return;
      }
      running = true;
      ctl = new AbortController();
      void runTurn(text, history, { config, signal: ctl.signal, onEvent: emit }).catch((err) => {
        if (err.name !== "AbortError") {
          emit({ type: "error", message: err.message || String(err) });
        }
      }).finally(() => {
        running = false;
        ctl = null;
      });
    },
    abort() {
      if (!running) return;
      ctl?.abort();
      emit({ type: "status", status: "idle" });
    },
    listTools() {
      return tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
    }
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  createAgentEngine,
  createSummaryAgent,
  createTools
});
