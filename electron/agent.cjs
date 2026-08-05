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
  compressArgs: () => compressArgs,
  createAgentEngine: () => createAgentEngine,
  createConfigTools: () => createConfigTools,
  createEvolution: () => createEvolution,
  createMemoryStore: () => createMemoryStore,
  createSummaryAgent: () => createSummaryAgent,
  createTools: () => createTools,
  findManualTool: () => findManualTool,
  parseManualCall: () => parseManualCall,
  parseTitleJson: () => parseTitleJson
});
module.exports = __toCommonJS(engine_exports);
var import_node_crypto2 = require("node:crypto");
var import_node_fs5 = require("node:fs");
var import_node_path4 = __toESM(require("node:path"), 1);

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
  const { config, system, history, tools, signal, onEvent, jsonMode, noThinking } = params;
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
    // 官方 API 参考:reasoning.effort 值域 none/minimal/low/medium/high/
    // xhigh/max;none = 关闭思考模式;配置值直通(设置页可选"关")
    reasoning: { effort: noThinking ? "none" : config.reasoningEffort || "high" },
    // JSON 输出(API 参考 text.format):json_object 模式;
    // 官方 json_mode 指南:prompt 必须含 "json" 字样(调用方保证)
    ...jsonMode ? { text: { format: { type: "json_object" } } } : {},
    // 输出上限:单轮回复防失控(含思维链 token,官方:384K 上限,
    // 不设会烧输出 token)
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

// electron/agent/chat.ts
function chatTools(tools) {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters }
  }));
}
function joinText(parts) {
  return parts.filter((p) => p.type === "text").map((p) => p.text).join("\n");
}
function joinReasoning(parts) {
  return parts.filter((p) => p.type === "reasoning").map((p) => p.text).join("\n");
}
function historyToMessages(history) {
  const out = [];
  for (const msg of history) {
    if (msg.role === "user") {
      const text2 = joinText(msg.parts);
      if (text2) out.push({ role: "user", content: text2 });
      continue;
    }
    const reasoning = joinReasoning(msg.parts);
    const text = joinText(msg.parts);
    const calls = msg.parts.filter(
      (p) => p.type === "tool-call"
    );
    const assistant = { role: "assistant" };
    if (reasoning) assistant.reasoning_content = reasoning;
    if (text) assistant.content = text;
    if (calls.length > 0) {
      assistant.tool_calls = calls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) }
      }));
    }
    if (assistant.reasoning_content || assistant.content || assistant.tool_calls) out.push(assistant);
    for (const p of msg.parts) {
      if (p.type === "tool-result") {
        const result = p.result.length > 8e3 ? p.result.slice(0, 8e3) + "\n\u2026(\u5DF2\u622A\u65AD)" : p.result;
        out.push({ role: "tool", tool_call_id: p.id, content: result });
      }
    }
  }
  return out;
}
async function* parseSse2(body, signal) {
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
          if (parsed && typeof parsed === "object") yield parsed;
        } catch {
        }
      }
      if (signal.aborted) throw new DOMException("aborted", "AbortError");
    }
  } finally {
    reader.releaseLock();
  }
}
async function streamChatCompletion(params) {
  const { config, system, history, tools, signal, onEvent, jsonMode, thinking } = params;
  const base = config.baseURL.trim().replace(/\/+$/, "");
  const url = `${base}/chat/completions`;
  const body = {
    model: config.model.trim() || "deepseek-v4-flash",
    messages: [
      // system 提示作为第一条 system 消息(多轮对话指南:system 开头、
      // 角色按序交替;前缀缓存要求该段保持稳定——动态段放在历史末尾)
      ...system ? [{ role: "system", content: system }] : [],
      ...historyToMessages(history)
    ],
    // 有工具才带 tools(静默总结等无工具请求不带,请求体最小化)
    ...tools.length > 0 ? { tools: chatTools(tools) } : {},
    // 思考模式(quick start 官方示例:thinking {type:'enabled'} +
    // reasoning_effort;v4-flash 思考模式默认开启,显式声明以对齐官方;
    // thinking:false → {type:'disabled'} 非思考模式)
    thinking: thinking === false ? { type: "disabled" } : { type: "enabled" },
    reasoning_effort: config.reasoningEffort || "high",
    // JSON 输出(json_mode 官方指南):prompt 必须含 "json" 字样
    ...jsonMode ? { response_format: { type: "json_object" } } : {},
    // 输出上限:单轮回复防失控(官方:输出上限 384K,不设会烧输出 token)
    max_tokens: 4096,
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
  const callDeltas = /* @__PURE__ */ new Map();
  const textParts = [];
  let usage = null;
  let cachedTokens;
  for await (const d of parseSse2(res.body, signal)) {
    const choice = Array.isArray(d.choices) ? d.choices[0] : void 0;
    const delta = choice?.delta;
    if (delta) {
      const rc = delta.reasoning_content;
      if (typeof rc === "string" && rc) onEvent({ type: "reasoning-delta", text: rc });
      const content = delta.content;
      if (typeof content === "string" && content) {
        textParts.push(content);
        onEvent({ type: "text-delta", text: content });
      }
      const tcs = delta.tool_calls;
      if (Array.isArray(tcs)) {
        for (const tc of tcs) {
          const index = typeof tc.index === "number" ? tc.index : 0;
          const fn = tc.function;
          const entry = callDeltas.get(index) ?? { id: "", name: "", args: "" };
          if (typeof tc.id === "string" && tc.id) entry.id = tc.id;
          if (typeof fn?.name === "string" && fn.name) entry.name = fn.name;
          if (typeof fn?.arguments === "string" && fn.arguments) entry.args += fn.arguments;
          callDeltas.set(index, entry);
          if (entry.id) {
            onEvent({ type: "tool-partial-call", id: entry.id, name: entry.name, args: entry.args });
          }
        }
      }
    }
    const u = d.usage;
    if (u && typeof u.prompt_tokens === "number") {
      usage = {
        input_tokens: u.prompt_tokens,
        output_tokens: typeof u.completion_tokens === "number" ? u.completion_tokens : 0
      };
      if (typeof u.prompt_cache_hit_tokens === "number" && u.prompt_cache_hit_tokens > 0) {
        cachedTokens = u.prompt_cache_hit_tokens;
      }
    }
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
  }
  const calls = [];
  for (const entry of callDeltas.values()) {
    if (!entry.id) continue;
    calls.push({ id: entry.id, name: entry.name, args: entry.args });
    onEvent({ type: "tool-call", id: entry.id, name: entry.name, args: entry.args });
  }
  return {
    calls,
    text: textParts.join(""),
    usage: usage ? { ...usage, cached_tokens: cachedTokens } : null,
    aborted: signal.aborted
  };
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
  const parseSse3 = async function* (reader) {
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
  for await (const evt of parseSse3(res.body.getReader())) {
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

// electron/agent/provider.ts
function detectProvider(baseURL) {
  const url = baseURL.toLowerCase();
  if (url.includes("anthropic")) return "anthropic";
  if (url.includes("chat")) return "chat";
  return "responses";
}
function streamByConfig(params) {
  switch (detectProvider(params.config.baseURL)) {
    case "anthropic":
      return streamAnthropic(params);
    case "chat":
      return streamChatCompletion(params);
    default:
      return streamResponse(params);
  }
}

// electron/agent/tools.ts
var import_node_child_process = require("node:child_process");
var import_node_fs = require("node:fs");
var import_node_os = __toESM(require("node:os"), 1);
var import_node_path = __toESM(require("node:path"), 1);
var import_electron = require("electron");
var XXT_SCRIPT = "C:/Users/asus/Desktop/MS Agent/main-sub-agent-system/tools/xxt/auto_answer.py";
var BILI_BIN = "C:/Users/asus/Desktop/bilibili/bili-rs/target/release/bili-tool.exe";
var BILI_CWD = "C:/Users/asus/Desktop/bilibili/bili-rs";
var DOCFLOW_BASE = "http://127.0.0.1:5000";
function biliOutdir(args) {
  const i = args.indexOf("--outdir");
  const dir = i >= 0 && args[i + 1] ? args[i + 1] : "downloads";
  return import_node_path.default.isAbsolute(dir) ? import_node_path.default.normalize(dir) : import_node_path.default.join(BILI_CWD, dir);
}
function absolutizeBiliPath(rel) {
  const p = rel.trim();
  if (!p || import_node_path.default.isAbsolute(p)) return p;
  return import_node_path.default.join(BILI_CWD, p);
}
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
var biliJobs = /* @__PURE__ */ new Map();
var BILI_JOB_TTL_MS = 24 * 60 * 60 * 1e3;
var BILI_STALE_MS = 6 * 60 * 60 * 1e3;
function pruneBiliJobs(now) {
  for (const [pid, job] of biliJobs) {
    if (job.finished && now - job.finishedAt > BILI_JOB_TTL_MS) biliJobs.delete(pid);
  }
}
function biliJobLabel(args) {
  const target = args[1] ?? "";
  return args[0] === "download" ? `UP \u4E3B\u6279\u91CF\u4E0B\u8F7D(${target})` : `\u89C6\u9891\u4E0B\u8F7D(${target})`;
}
function getBiliJobLines() {
  const now = Date.now();
  pruneBiliJobs(now);
  const jobs = [...biliJobs.values()].sort((a, b) => a.startedAt - b.startedAt);
  return jobs.map((j) => {
    const label = biliJobLabel(j.args);
    if (!j.finished) {
      const outdir = biliOutdir(j.args);
      return now - j.startedAt > BILI_STALE_MS ? `- \u8FDB\u884C\u4E2D(\u8FDB\u7A0B ${j.pid},\u5DF2\u542F\u52A8\u8D85\u8FC7 6 \u5C0F\u65F6,\u8FDB\u7A0B\u53EF\u80FD\u5DF2\u4E22\u5931,\u53EF\u7528 bili saved \u786E\u8BA4):${label},\u8F93\u51FA\u76EE\u5F55 ${outdir}` : `- \u8FDB\u884C\u4E2D(\u8FDB\u7A0B ${j.pid}):${label},\u8F93\u51FA\u76EE\u5F55 ${outdir}`;
    }
    const t = new Date(j.finishedAt);
    const hm = `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
    if (j.exitCode !== 0) {
      return `- \u5DF2\u5931\u8D25(${hm},\u9000\u51FA\u7801 ${j.exitCode},\u8FDB\u7A0B ${j.pid}):${label}`;
    }
    const files = j.outputPaths ?? [];
    return `- \u5DF2\u5B8C\u6210(${hm},\u8FDB\u7A0B ${j.pid}):${label}` + (files.length > 0 ? `,\u6587\u4EF6:
      ${files.join("\n      ")}` : `,\u8F93\u51FA\u76EE\u5F55 ${biliOutdir(j.args)}`);
  });
}
function getBiliBackgroundStatus() {
  const lines = getBiliJobLines();
  if (lines.length === 0) return "";
  return "\u3010\u540E\u53F0\u4E0B\u8F7D\u4EFB\u52A1\u72B6\u6001(\u6700\u65B0,\u4EE5\u6B64\u4E3A\u51C6)\u3011\n" + lines.join("\n") + '\n\u5BF9\u8BDD\u4E2D\u63D0\u53CA\u8FD9\u4E9B\u4E0B\u8F7D\u65F6\u6309\u72B6\u6001\u5982\u5B9E\u56DE\u7B54:\u5DF2\u5B8C\u6210/\u5DF2\u5931\u8D25\u5C31\u76F4\u63A5\u8BF4\u660E,\u4E0D\u8981\u518D"\u8FD8\u5728\u4E0B\u8F7D"\u6216"\u5B8C\u6210\u540E\u4F1A\u901A\u77E5";\u8FDB\u884C\u4E2D\u624D\u8BF4\u8FD8\u5728\u4E0B\u8F7D\u3002';
}
async function resolveBiliOutputs(job) {
  try {
    const out = await runBili(["saved", "--limit", "10"], 15e3);
    const outdir = biliOutdir(job.args).toLowerCase();
    const files = [];
    for (const line of out.split("\n")) {
      const i = line.lastIndexOf(" | ");
      if (i === -1) continue;
      const abs = absolutizeBiliPath(line.slice(i + 3));
      if (abs.toLowerCase().startsWith(outdir)) files.push(abs);
    }
    return files;
  } catch {
    return [];
  }
}
function runBiliBackground(args) {
  try {
    const child = (0, import_node_child_process.spawn)(BILI_BIN, args, { windowsHide: true, stdio: "ignore", detached: true, cwd: BILI_CWD });
    child.unref();
    const pid = child.pid ?? -1;
    biliJobs.set(pid, { pid, startedAt: Date.now(), args, finished: false, exitCode: null, finishedAt: 0, outputPaths: [] });
    child.on("close", (code) => {
      const job = biliJobs.get(pid);
      if (!job) return;
      job.finished = true;
      job.exitCode = code;
      job.finishedAt = Date.now();
      const label = biliJobLabel(job.args);
      if (code !== 0) {
        new import_electron.Notification({
          title: "B\u7AD9\u4E0B\u8F7D\u7ED3\u675F",
          body: `${label}\u5F02\u5E38\u9000\u51FA(\u9000\u51FA\u7801 ${code}),\u8BF7\u7528 bili saved \u67E5\u770B\u8BB0\u5F55\u6216\u91CD\u8BD5`
        }).show();
        return;
      }
      void resolveBiliOutputs(job).then((files) => {
        job.outputPaths = files;
        const outdir = biliOutdir(job.args);
        const message = files.length > 0 ? `${label}\u5DF2\u5B8C\u6210:
${files.join("\n")}` : `${label}\u5DF2\u5B8C\u6210,\u8F93\u51FA\u76EE\u5F55:${outdir}`;
        new import_electron.Notification({ title: "B\u7AD9\u4E0B\u8F7D\u5B8C\u6210", body: message }).show();
        deps.onBackgroundDone?.({ title: "B\u7AD9\u4E0B\u8F7D\u5B8C\u6210", message });
      });
    });
    return `\u5DF2\u540E\u53F0\u542F\u52A8 bili-tool \u4E0B\u8F7D:${args.join(" ")}(\u8FDB\u7A0B ${pid})\u3002\u8F93\u51FA\u76EE\u5F55:${biliOutdir(args)}\u3002**\u8FD9\u662F\u957F\u4EFB\u52A1,\u901A\u5E38 1-10 \u5206\u949F,\u4E0D\u8981\u7B49\u5F85**:\u8BF7\u7ACB\u5373\u544A\u77E5\u7528\u6237"\u4E0B\u8F7D\u5DF2\u5F00\u59CB,\u5B8C\u6210\u540E\u4F1A\u6709\u7CFB\u7EDF\u901A\u77E5";\u5B8C\u6210/\u5931\u8D25\u90FD\u4F1A\u81EA\u52A8\u53D1\u7CFB\u7EDF\u901A\u77E5,\u4E0D\u9700\u8981\u53CD\u590D\u67E5\u8BE2\u3002\u4EC5\u5F53\u7528\u6237\u4E3B\u52A8\u8BE2\u95EE\u4E0B\u8F7D\u8FDB\u5EA6\u65F6,\u624D\u8C03\u7528 bili saved \u67E5\u8BE2\u4E0B\u8F7D\u8BB0\u5F55(\u4E0B\u8F7D\u8FDB\u884C\u4E2D\u67E5\u4E0D\u5230\u8BB0\u5F55\u662F\u6B63\u5E38\u7684)\u3002`;
  } catch (e) {
    throw new Error(`\u65E0\u6CD5\u542F\u52A8 bili-tool:${e.message}(\u4E8C\u8FDB\u5236\u7F3A\u5931:${BILI_BIN})`);
  }
}
function runBili(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = (0, import_node_child_process.spawn)(BILI_BIN, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], cwd: BILI_CWD });
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
      const out = await runBili(["saved", "--limit", String(limit)], 3e4);
      return out.split("\n").map((line) => {
        const i = line.lastIndexOf(" | ");
        if (i === -1) return line;
        return line.slice(0, i + 3) + absolutizeBiliPath(line.slice(i + 3));
      }).join("\n");
    }
    case "open": {
      if (!query) throw new Error("open \u9700\u8981\u641C\u7D22\u5173\u952E\u8BCD");
      const type = String(params.type ?? "video");
      if (!["video", "user", "bangumi"].includes(type)) {
        throw new Error("type \u4EC5\u652F\u6301 video/user/bangumi");
      }
      const json = await runBili(["search", query, "--type", type, "--json"], 3e4);
      let items = null;
      try {
        items = JSON.parse(json);
      } catch {
      }
      const first = Array.isArray(items) && items.length > 0 ? items[0] : null;
      const rec = first && typeof first === "object" ? first : null;
      const url = type === "user" && typeof rec?.mid === "number" ? `https://space.bilibili.com/${rec.mid}` : typeof rec?.bvid === "string" && rec.bvid ? `https://www.bilibili.com/video/${rec.bvid}` : "";
      if (!url) throw new Error(`\u641C\u7D22"${query}"\u65E0\u7ED3\u679C\u6216\u683C\u5F0F\u5F02\u5E38,\u8BF7\u6539\u7528 search \u67E5\u770B`);
      const title = typeof rec?.title === "string" ? rec.title : typeof rec?.name === "string" ? rec.name : "";
      const shown = title ? title.includes("\u300A") ? title : `\u300A${title}\u300B` : "";
      await import_electron.shell.openExternal(url);
      return `\u5DF2\u6253\u5F00\u7B2C\u4E00\u4E2A\u641C\u7D22\u7ED3\u679C:${shown}
${url}`;
    }
    default:
      throw new Error(
        `\u672A\u77E5 action:${action}(\u652F\u6301 up_info/up_videos/search/open/trending/comments/download/download_up/danmaku/subtitle/saved)`
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
function createTools(deps2) {
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
        deps2.onSwitchToMusic();
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
      description: 'B\u7AD9\u6570\u636E\u67E5\u8BE2\u4E0E\u89C6\u9891\u4E0B\u8F7D(\u8C03\u7528\u672C\u673A bili-tool,Rust \u5355\u4E8C\u8FDB\u5236,\u514D Python)\u3002\u67E5\u8BE2:up_info \u67E5 UP \u4E3B\u4FE1\u606F(\u7C89\u4E1D/\u5173\u6CE8/\u6295\u7A3F/\u83B7\u8D5E) / up_videos \u67E5 UP \u4E3B\u89C6\u9891\u5217\u8868 / search \u641C\u7D22\u89C6\u9891/\u7528\u6237/\u756A\u5267 / open \u641C\u7D22\u5E76\u76F4\u63A5\u6253\u5F00\u7B2C\u4E00\u4E2A\u7ED3\u679C(\u7528\u6237\u8BF4"\u641C\u7D22XX\u6253\u5F00\u7B2C\u4E00\u4E2A"\u65F6\u7528\u5B83,\u4E00\u6B21\u5B8C\u6210;type=user \u6253\u5F00 UP \u7A7A\u95F4\u9875) / trending \u67E5\u70ED\u95E8\u699C(\u5206\u533A rid:0\u5168\u7AD9 1\u52A8\u753B 3\u97F3\u4E50 4\u6E38\u620F 5\u5A31\u4E50 36\u79D1\u6280 119\u9B3C\u755C 129\u821E\u8E48 155\u751F\u6D3B 160\u65F6\u5C1A 167\u77E5\u8BC6 181\u5F71\u89C6) / comments \u67E5\u89C6\u9891\u8BC4\u8BBA\u533A\u3002\u4E0B\u8F7D:download \u4E0B\u8F7D\u5355\u4E2A\u89C6\u9891 / download_up \u6279\u91CF\u4E0B\u8F7D UP \u4E3B\u89C6\u9891(\u53EF\u9650\u6700\u8FD1 N \u4E2A/\u6B63\u5219\u8FC7\u6EE4,\u652F\u6301 --dry-run \u5148\u9884\u89C8) / danmaku \u4E0B\u8F7D\u5F39\u5E55(XML/ASS/TXT/JSON) / subtitle \u4E0B\u8F7D CC \u5B57\u5E55 / saved \u67E5\u5DF2\u4E0B\u8F7D\u8BB0\u5F55\u3002**\u4E0B\u8F7D\u662F\u540E\u53F0\u957F\u4EFB\u52A1(\u901A\u5E38 1-10 \u5206\u949F)**:\u542F\u52A8\u540E\u7ACB\u5373\u8FD4\u56DE\u5E76\u544A\u77E5\u7528\u6237"\u4E0B\u8F7D\u5DF2\u5F00\u59CB",**\u4E0D\u8981\u53CD\u590D\u8F6E\u8BE2 saved \u7B49\u5F85**\u2014\u2014\u5B8C\u6210/\u5931\u8D25\u4F1A\u81EA\u52A8\u53D1\u7CFB\u7EDF\u901A\u77E5;\u4EC5\u5F53\u7528\u6237\u4E3B\u52A8\u8BE2\u95EE\u8FDB\u5EA6\u65F6\u624D\u8C03\u7528 saved\u3002\u6E05\u6670\u5EA6\u5EFA\u8BAE:1080p \u6587\u4EF6\u5927\u4E0B\u8F7D\u6162,\u53EF\u4F18\u5148 720p \u6216\u4EC5\u97F3\u9891(audio=mp3)\u3002**B\u7AD9 API \u9650\u5236\u77E5\u8BC6(\u67E5\u8BE2\u5931\u8D25\u65F6\u6309\u6B64\u5224\u65AD\u4E0E\u7B54\u590D\u7528\u6237)**:\u2460 \u63A5\u53E3\u9700\u8981\u6D4F\u89C8\u5668 UA \u4E0E WBI/App \u7B7E\u540D,\u5DE5\u5177\u5DF2\u5185\u7F6E(bili-tool \u5B9E\u73B0 WBI mixin \u7B7E\u540D\u4E0E\u79FB\u52A8\u7AEF appkey \u7B7E\u540D);\u2461 \u6E38\u5BA2\u8BF7\u6C42\u4F1A\u89E6\u53D1\u98CE\u63A7\u2014\u2014\u70ED\u95E8\u699C/\u90E8\u5206\u641C\u7D22/\u8BC4\u8BBA\u533A\u53EF\u80FD\u8FD4\u56DE -352 \u7B49\u9519\u8BEF\u7801(IP \u98CE\u63A7/\u9650\u6D41),\u5BF9\u7B56:\u964D\u4F4E\u8BF7\u6C42\u9891\u7387\u3001\u7A0D\u540E\u91CD\u8BD5\u3001\u66F4\u6362\u5173\u952E\u8BCD\u6216\u5206\u533A;\u2462 \u9AD8\u753B\u8D28(1080P+)\u3001\u6536\u85CF\u5939\u3001\u5408\u96C6\u7B49\u63A5\u53E3\u9700\u8981\u767B\u5F55\u6001\u2014\u2014bili-tool \u53EF\u626B\u7801\u767B\u5F55(login),\u767B\u5F55\u540E\u591A\u6570\u9650\u5236\u89E3\u9664;\u2463 \u4E0B\u8F7D\u4F9D\u8D56\u672C\u673A ffmpeg \u4E0E\u767B\u5F55\u6001(\u9AD8\u753B\u8D28\u6E90);\u2464 \u90E8\u5206\u63A5\u53E3\u5076\u53D1 -400(\u53C2\u6570/\u6743\u9650),\u591A\u4E3A\u63A5\u53E3\u9650\u5236,\u6362\u7528\u79FB\u52A8\u7AEF API \u6216\u767B\u5F55\u53EF\u7ED5\u8FC7(\u5DE5\u5177\u5DF2\u5185\u7F6E\u515C\u5E95)\u3002mid \u53EF\u4E3A\u7EAF\u6570\u5B57\u6216 bilibili \u7A7A\u95F4\u94FE\u63A5,BV \u53F7\u53EF\u4E3A\u94FE\u63A5\u3002',
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [
              "up_info",
              "up_videos",
              "search",
              "open",
              "trending",
              "comments",
              "download",
              "download_up",
              "danmaku",
              "subtitle",
              "saved"
            ],
            description: "\u64CD\u4F5C:up_info/up_videos/search/open/trending/comments(\u67E5\u8BE2)/download(\u5355\u89C6\u9891\u4E0B\u8F7D)/download_up(UP\u6279\u91CF\u4E0B\u8F7D)/danmaku(\u5F39\u5E55)/subtitle(\u5B57\u5E55)/saved(\u4E0B\u8F7D\u8BB0\u5F55)"
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

// electron/agent/mcp.ts
var import_node_child_process2 = require("node:child_process");
var INIT_TIMEOUT_MS = 15e3;
var CALL_TIMEOUT_MS = 55e3;
var RESULT_MAX2 = 8e3;
var DESC_MAX = 400;
function sanitizeName(raw, fallback) {
  const s = raw.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return s || fallback;
}
var RpcCore = class {
  nextId = 1;
  pending = /* @__PURE__ */ new Map();
  ready = false;
  tools = [];
  /** 连接互斥:并行工具调用会并发 connect,不加锁会重复拉起连接 */
  connectPromise = null;
  requestImpl(send, timeoutMs) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP \u8BF7\u6C42\u8D85\u65F6(${Math.round(timeoutMs / 1e3)}s)`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        send(id);
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }
  failAll(message) {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(message));
      this.pending.delete(id);
    }
  }
  settle(id, result, error) {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (error) p.reject(new Error(formatRpcError(error)));
    else p.resolve(result);
  }
  /** 握手 + 拉取工具清单(initialize → initialized → tools/list) */
  async handshake(doInitialize, notify, doList) {
    await doInitialize();
    notify("notifications/initialized");
    const listRes = await doList();
    this.tools = Array.isArray(listRes?.tools) ? listRes.tools.filter((t) => !!t && typeof t === "object").map((t) => ({
      name: String(t.name ?? ""),
      description: typeof t.description === "string" ? t.description : "",
      inputSchema: t.inputSchema ?? { type: "object" }
    })).filter((t) => t.name) : [];
    this.ready = true;
  }
};
var StdioClient = class extends RpcCore {
  constructor(cfg, onLog) {
    super();
    this.cfg = cfg;
    this.onLog = onLog;
  }
  cfg;
  onLog;
  child = null;
  buf = "";
  lastError = "";
  spawnError = false;
  get alive() {
    return this.child !== null && this.child.exitCode === null && !this.spawnError;
  }
  connect() {
    if (this.ready && this.alive) return Promise.resolve();
    if (!this.connectPromise) this.connectPromise = this.doConnect();
    return this.connectPromise.finally(() => {
      this.connectPromise = null;
    });
  }
  async doConnect() {
    if (!this.cfg.command.trim()) throw new Error("MCP \u670D\u52A1\u7F3A\u5C11\u542F\u52A8\u547D\u4EE4");
    this.buf = "";
    this.ready = false;
    this.spawnError = false;
    this.tools = [];
    this.lastError = "";
    const cmd = this.cfg.command.trim();
    const needCmdHost = process.platform === "win32" && !/\.exe$/i.test(cmd);
    const command = needCmdHost ? "cmd.exe" : cmd;
    const args = needCmdHost ? ["/d", "/c", cmd, ...this.cfg.args ?? []] : this.cfg.args ?? [];
    this.onLog(`[mcp] \u542F\u52A8\u670D\u52A1 ${this.cfg.name}:${command} ${args.join(" ")}`);
    const child = (0, import_node_child_process2.spawn)(command, args, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...this.cfg.env ?? {} }
    });
    this.child = child;
    child.stderr?.on("data", (d) => this.onLog(`[mcp:${this.cfg.name}] stderr:${d.toString().trim()}`));
    child.on("error", (err) => {
      this.spawnError = true;
      this.lastError = `\u65E0\u6CD5\u542F\u52A8 MCP \u670D\u52A1\u8FDB\u7A0B:${err.message}`;
      this.onLog(`[mcp:${this.cfg.name}] \u542F\u52A8\u5931\u8D25:${err.message}`);
      this.failAll(this.lastError);
      this.child = null;
    });
    child.on("exit", (code, signal) => {
      this.onLog(`[mcp:${this.cfg.name}] \u8FDB\u7A0B\u9000\u51FA(code=${code}, signal=${signal})`);
      this.ready = false;
      this.failAll(`MCP \u670D\u52A1\u8FDB\u7A0B\u5DF2\u9000\u51FA(\u9000\u51FA\u7801 ${code ?? signal ?? "?"}),\u5C06\u81EA\u52A8\u91CD\u542F`);
      if (this.child === child) this.child = null;
    });
    child.stdout?.on("data", (d) => this.onData(d.toString()));
    try {
      await this.handshake(
        () => this.request("initialize", {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "dynamic-island-agent", version: "1.0.0" }
        }),
        (method) => this.sendLine(JSON.stringify({ jsonrpc: "2.0", method })),
        () => this.request("tools/list", {})
      );
      this.onLog(`[mcp:${this.cfg.name}] \u63E1\u624B\u6210\u529F,${this.tools.length} \u4E2A\u5DE5\u5177`);
    } catch (err) {
      this.ready = false;
      this.failAll(err.message);
      this.kill();
      throw err;
    }
  }
  /** stdout 换行分隔解析:每行一条 JSON-RPC 消息 */
  onData(chunk) {
    this.buf += chunk;
    for (; ; ) {
      const nl = this.buf.indexOf("\n");
      if (nl === -1) break;
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        this.onLog(`[mcp:${this.cfg.name}] \u5FFD\u7565\u975E JSON \u8F93\u51FA:${line.slice(0, 120)}`);
        continue;
      }
      if (typeof msg?.id === "number" && msg.method === void 0) {
        this.settle(msg.id, msg.result, msg.error);
      } else if (msg?.method === "notifications/message") {
        const p = msg.params;
        this.onLog(`[mcp:${this.cfg.name}] ${p?.level ?? "log"}:${String(p?.message ?? "")}`);
      } else if (typeof msg?.id !== "undefined" && msg?.method) {
        this.sendLine(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32601, message: `Method not found: ${msg.method}` }
          })
        );
      }
    }
  }
  /** 发送 JSON-RPC 请求并等待响应(超时按类型区分) */
  request(method, params, timeoutMs = INIT_TIMEOUT_MS) {
    return this.requestImpl((id) => {
      if (!this.child || !this.child.stdin || this.child.stdin.destroyed) {
        throw new Error(this.spawnError ? this.lastError : "MCP \u670D\u52A1\u8FDB\u7A0B\u672A\u8FD0\u884C");
      }
      this.sendLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          method,
          params: params === void 0 ? {} : params
        })
      );
    }, timeoutMs);
  }
  sendLine(line) {
    try {
      this.child?.stdin?.write(line + "\n");
    } catch {
    }
  }
  async callTool(name, args) {
    await this.connect();
    const res = await this.request("tools/call", { name, arguments: args ?? {} }, CALL_TIMEOUT_MS);
    return settleToolResult(res);
  }
  async listRawTools() {
    await this.connect();
    return this.tools;
  }
  kill() {
    this.ready = false;
    this.failAll("MCP \u670D\u52A1\u5DF2\u5173\u95ED");
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null) return;
    try {
      if (process.platform === "win32") {
        const { execFileSync } = require("node:child_process");
        execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      } else {
        child.kill();
      }
    } catch {
      child.kill();
    }
  }
};
var SseClient = class extends RpcCore {
  constructor(cfg, onLog) {
    super();
    this.cfg = cfg;
    this.onLog = onLog;
  }
  cfg;
  onLog;
  aborter = null;
  reader = null;
  endpoint = "";
  streamEnded = false;
  get alive() {
    return this.reader !== null && !this.streamEnded;
  }
  connect() {
    if (this.ready && this.alive) return Promise.resolve();
    if (!this.connectPromise) this.connectPromise = this.doConnect();
    return this.connectPromise.finally(() => {
      this.connectPromise = null;
    });
  }
  async doConnect() {
    const url = String(this.cfg.url ?? "").trim();
    if (!/^https?:\/\//i.test(url)) throw new Error("sse \u670D\u52A1\u9700\u8981 http/https \u7AEF\u70B9 URL");
    this.endpoint = "";
    this.ready = false;
    this.streamEnded = false;
    this.tools = [];
    this.aborter = new AbortController();
    this.onLog(`[mcp] \u8FDE\u63A5 sse \u670D\u52A1 ${this.cfg.name}:${url}`);
    let res;
    try {
      res = await fetch(url, {
        headers: { Accept: "text/event-stream", ...this.cfg.headers ?? {} },
        signal: this.aborter.signal
      });
    } catch (err) {
      throw new Error(`sse \u8FDE\u63A5\u5931\u8D25:${err.message}`);
    }
    if (!res.ok) throw new Error(`sse \u7AEF\u70B9\u8FD4\u56DE HTTP ${res.status}`);
    if (!res.body) throw new Error("sse \u7AEF\u70B9\u65E0\u54CD\u5E94\u6D41");
    const reader = res.body.getReader();
    this.reader = reader;
    void this.readLoop(reader);
    const deadline = Date.now() + INIT_TIMEOUT_MS;
    while (!this.endpoint) {
      if (Date.now() > deadline) {
        this.kill();
        throw new Error("sse \u8FDE\u63A5\u8D85\u65F6:\u672A\u6536\u5230 endpoint(\u786E\u8BA4\u7AEF\u70B9\u652F\u6301 MCP SSE)");
      }
      if (this.streamEnded) {
        this.kill();
        throw new Error("sse \u8FDE\u63A5\u5DF2\u65AD\u5F00(\u7AEF\u70B9\u672A\u53D1\u9001 endpoint)");
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    try {
      await this.handshake(
        () => this.request("initialize", {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "dynamic-island-agent", version: "1.0.0" }
        }),
        (method) => this.post({ jsonrpc: "2.0", method }),
        () => this.request("tools/list", {})
      );
      this.onLog(`[mcp:${this.cfg.name}] sse \u63E1\u624B\u6210\u529F,${this.tools.length} \u4E2A\u5DE5\u5177`);
    } catch (err) {
      this.ready = false;
      this.failAll(err.message);
      this.kill();
      throw err;
    }
  }
  /** 事件流读取循环:按空行分帧,event/data 解析 */
  async readLoop(reader) {
    const decoder = new TextDecoder();
    let frame = "";
    let currentEvent = "";
    let dataLines = [];
    for (; ; ) {
      let done = false;
      let value;
      try {
        const r = await reader.read();
        done = r.done;
        value = r.value;
      } catch {
        done = true;
      }
      if (done) {
        this.streamEnded = true;
        this.failAll("sse \u8FDE\u63A5\u5DF2\u65AD\u5F00,\u5C06\u81EA\u52A8\u91CD\u8FDE");
        this.onLog(`[mcp:${this.cfg.name}] sse \u6D41\u7ED3\u675F`);
        break;
      }
      frame += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = frame.indexOf("\n\n")) !== -1) {
        const block = frame.slice(0, nl);
        frame = frame.slice(nl + 2);
        const clean = block.replace(/\r\n/g, "\n");
        for (const line of clean.split("\n")) {
          if (line.startsWith("event:")) currentEvent = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
        }
        if (dataLines.length > 0) {
          this.handleFrame(currentEvent, dataLines.join("\n"));
          currentEvent = "";
          dataLines = [];
        }
      }
    }
  }
  handleFrame(event, data) {
    if (event === "endpoint") {
      this.endpoint = data.trim();
      return;
    }
    if (event === "ping") return;
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (typeof msg?.id === "number" && msg.method === void 0) {
      this.settle(msg.id, msg.result, msg.error);
    }
  }
  /** POST 回传端点(请求;响应走事件流) */
  request(method, params, timeoutMs = INIT_TIMEOUT_MS) {
    return this.requestImpl((id) => {
      this.post({ jsonrpc: "2.0", id, method, params: params === void 0 ? {} : params }).catch((err) => {
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        clearTimeout(p.timer);
        p.reject(new Error(`sse \u8BF7\u6C42\u5931\u8D25:${err.message}`));
      });
    }, timeoutMs);
  }
  /** POST 发送(通知无响应;请求的响应走事件流,响应体通常为空) */
  async post(body) {
    if (!this.endpoint) throw new Error("sse \u7AEF\u70B9\u672A\u5C31\u7EEA");
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.cfg.headers ?? {} },
      body: JSON.stringify(body),
      signal: this.aborter?.signal
    });
    if (!res.ok) throw new Error(`sse \u56DE\u4F20 HTTP ${res.status}`);
    const text = await res.text();
    if (text.trim() && typeof body.id === "number") {
      try {
        const m = JSON.parse(text);
        if (m && m.id === body.id) this.settle(body.id, m.result, m.error);
      } catch {
      }
    }
  }
  async callTool(name, args) {
    await this.connect();
    const res = await this.request("tools/call", { name, arguments: args ?? {} }, CALL_TIMEOUT_MS);
    return settleToolResult(res);
  }
  async listRawTools() {
    await this.connect();
    return this.tools;
  }
  kill() {
    this.ready = false;
    this.endpoint = "";
    this.failAll("MCP \u670D\u52A1\u5DF2\u5173\u95ED");
    this.aborter?.abort();
    this.aborter = null;
    const reader = this.reader;
    this.reader = null;
    reader?.cancel().catch(() => {
    });
  }
};
function formatToolResult(content) {
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block;
    if (b.type === "text" && typeof b.text === "string") {
      parts.push(b.text);
    } else if (b.type === "image") {
      const len = typeof b.data === "string" ? Math.ceil(b.data.length * 3 / 4) : 0;
      parts.push(`[\u56FE\u50CF\u7ED3\u679C ${String(b.mimeType ?? "")} \u7EA6 ${len} \u5B57\u8282]`);
    } else if (b.type === "resource") {
      const r = b.resource ?? {};
      const uri = String(r.uri ?? "");
      if (typeof r.text === "string") parts.push(`${uri}:${r.text}`);
      else {
        parts.push(
          `[\u8D44\u6E90 ${uri} ${String(b.mimeType ?? "")} \u4E8C\u8FDB\u5236 ${typeof r.blob === "string" ? r.blob.length : 0}]`
        );
      }
    } else {
      parts.push(JSON.stringify(block));
    }
  }
  return parts.join("\n").slice(0, RESULT_MAX2);
}
function settleToolResult(res) {
  const text = formatToolResult(res?.content);
  if (res?.isError) throw new Error(text || "MCP \u5DE5\u5177\u8FD4\u56DE\u5931\u8D25(\u65E0\u9519\u8BEF\u4FE1\u606F)");
  return text || "(\u5DE5\u5177\u8FD4\u56DE\u7A7A)";
}
function formatRpcError(err) {
  if (err && typeof err === "object") {
    const e = err;
    const data = e.data !== void 0 ? `:${JSON.stringify(e.data).slice(0, 200)}` : "";
    return `MCP \u9519\u8BEF(${String(e.code ?? "?")})${e.message ? `:${String(e.message)}` : ""}${data}`;
  }
  return `MCP \u9519\u8BEF:${String(err)}`;
}
function toToolParameters(inputSchema) {
  if (inputSchema && typeof inputSchema === "object" && !Array.isArray(inputSchema)) {
    const schema = inputSchema;
    if (schema.type === "object" && schema.properties && typeof schema.properties === "object") {
      return {
        type: "object",
        properties: schema.properties,
        required: Array.isArray(schema.required) ? schema.required : void 0
      };
    }
    return {
      type: "object",
      properties: { input: { ...schema, description: `\u5165\u53C2(${String(schema.description ?? "")})` } }
    };
  }
  return { type: "object", properties: {} };
}
function createMCPManager() {
  const clients = /* @__PURE__ */ new Map();
  const log = (msg) => console.log(msg);
  const keyOf = (cfg) => JSON.stringify([cfg.name, cfg.type, cfg.command, cfg.args ?? [], cfg.env ?? {}, cfg.url ?? "", cfg.headers ?? {}]);
  function prune(servers) {
    const keys = new Set(servers.map(keyOf));
    for (const [key, client] of clients) {
      if (!keys.has(key)) {
        client.kill();
        clients.delete(key);
      }
    }
  }
  function clientFor(cfg) {
    const key = keyOf(cfg);
    let client = clients.get(key);
    if (!client) {
      client = cfg.type === "sse" ? new SseClient(cfg, log) : new StdioClient(cfg, log);
      clients.set(key, client);
    }
    return client;
  }
  async function listTools(servers) {
    prune(servers);
    const tools = [];
    const usedNames = /* @__PURE__ */ new Set();
    for (const cfg of servers) {
      const serverName = sanitizeName(cfg.name, "server");
      let raw = [];
      try {
        raw = await clientFor(cfg).listRawTools();
      } catch (err) {
        log(`[mcp] \u670D\u52A1 ${cfg.name} \u8FDE\u63A5\u5931\u8D25:${err.message}`);
        continue;
      }
      for (const t of raw) {
        const toolName = sanitizeName(t.name, "tool");
        if (!toolName) continue;
        let full = `mcp_${serverName}_${toolName}`;
        let n = 2;
        while (usedNames.has(full)) full = `mcp_${serverName}_${toolName}_${n++}`;
        usedNames.add(full);
        const desc = String(t.description ?? "").trim().replace(/\s+/g, " ").slice(0, DESC_MAX);
        tools.push({
          name: full,
          description: `[MCP \u670D\u52A1:${cfg.name}] ${desc || "(\u65E0\u63CF\u8FF0)"}\u3002\u8C03\u7528\u53C2\u6570\u6309 JSON Schema \u586B\u5199,\u7ED3\u679C\u7531\u670D\u52A1\u7AEF\u8FD4\u56DE\u3002`,
          parameters: toToolParameters(t.inputSchema),
          async execute(params) {
            const c = clientFor(cfg);
            await c.connect();
            return c.callTool(t.name, params);
          }
        });
      }
    }
    return tools;
  }
  async function test(cfg) {
    const client = cfg.type === "sse" ? new SseClient(cfg, log) : new StdioClient(cfg, log);
    try {
      const tools = await client.listRawTools();
      return { ok: true, toolCount: tools.length };
    } catch (err) {
      return { ok: false, error: err.message };
    } finally {
      client.kill();
    }
  }
  function dispose() {
    for (const client of clients.values()) client.kill();
    clients.clear();
  }
  return { listTools, test, dispose };
}

// electron/agent/skills.ts
var import_node_fs2 = require("node:fs");
var import_node_path2 = __toESM(require("node:path"), 1);
var DOC_MAX = 8e3;
var DESC_MAX2 = 300;
function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!m) return {};
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    if (key !== "name" && key !== "description") continue;
    const val = line.slice(i + 1).trim().replace(/^["']|["']$/g, "").trim();
    if (val) meta[key] = val;
  }
  return meta;
}
function toSlug(raw, fallback) {
  const s = raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s || fallback;
}
async function scanDirs(dirs) {
  const skills = [];
  const seen = /* @__PURE__ */ new Set();
  for (const dir of dirs) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    let entries;
    try {
      entries = await import_node_fs2.promises.readdir(dir, { withFileTypes: true }).then((list) => list.map((e) => e.name));
    } catch {
      continue;
    }
    entries.sort();
    for (const name of entries) {
      if (name.startsWith(".") || name.startsWith("_")) continue;
      const skillDir = import_node_path2.default.join(dir, name);
      const mdPath = import_node_path2.default.join(skillDir, "SKILL.md");
      let text;
      try {
        text = await import_node_fs2.promises.readFile(mdPath, "utf8");
      } catch {
        continue;
      }
      const meta = parseFrontmatter(text);
      const fallbackDesc = text.replace(/^---[\s\S]*?\n---\r?\n?/, "").split("\n").find((l) => l.trim() && !l.trim().startsWith("#"))?.trim() ?? "";
      skills.push({
        title: meta.name?.trim() || name,
        description: meta.description?.trim() || fallbackDesc,
        mdPath,
        dir: skillDir
      });
    }
  }
  return skills;
}
function createSkillLoader() {
  return {
    /**
     * 扫描并注册技能工具。excluded:已排除技能 slug 列表(设置/LLM 对话
     * 中移除的技能扫描跳过,对话中不可用)——slug = 工具名去 skill_ 前缀。
     * ownDirs:标记为"灵动岛目录"的目录(引擎传入 userData/skills)——
     * 技能来自这些目录时按目录内标记区分 sourceKind:
     * - 有 .island-imported 标记(手动导入的)→ 'imported'(手动导入区)
     * - 无标记(引擎 create / 自然语言创建)→ 'created'(灵动岛创建区)
     * - 其他目录 → 'scanned'(扫描区)
     */
    async listTools(skillsDirs, excluded = [], ownDirs = []) {
      const skills = await scanDirs(skillsDirs ?? []);
      const excludedSet = new Set(excluded);
      const ownSet = new Set(ownDirs.map((d) => d.toLowerCase()));
      const importedMark = (dir) => import_node_path2.default.join(dir, ".island-imported");
      const tools = [];
      const used = /* @__PURE__ */ new Set();
      for (const skill of skills) {
        let slug = toSlug(skill.title, "skill");
        if (excludedSet.has(slug)) continue;
        let name = `skill_${slug}`;
        let n = 2;
        while (used.has(name)) name = `skill_${slug}_${n++}`;
        used.add(name);
        const inOwn = ownSet.has(import_node_path2.default.dirname(skill.dir).toLowerCase());
        const imported = inOwn && await import_node_fs2.promises.access(importedMark(skill.dir)).then(() => true).catch(() => false);
        const sourceKind = inOwn ? imported ? "imported" : "created" : "scanned";
        const desc = skill.description.replace(/\s+/g, " ").trim().slice(0, DESC_MAX2);
        tools.push({
          name,
          description: `\u6280\u80FD:${desc || skill.title}\u3002\u8C03\u7528\u672C\u6280\u80FD\u4F1A\u8F7D\u5165\u5B83\u7684\u5B8C\u6574\u4F7F\u7528\u6587\u6863(\u6B65\u9AA4/\u811A\u672C\u76EE\u5F55),\u4E4B\u540E\u6309\u6587\u6863\u6267\u884C\u4EFB\u52A1;\u6280\u80FD\u9644\u5E26\u7684\u811A\u672C\u5728\u5176\u76EE\u5F55\u4E0B,\u7528 exec_command \u8FD0\u884C\u3002`,
          parameters: { type: "object", properties: {} },
          sourceKind,
          async execute() {
            let text;
            try {
              text = await import_node_fs2.promises.readFile(skill.mdPath, "utf8");
            } catch (err) {
              throw new Error(`\u6280\u80FD\u6587\u6863\u8BFB\u53D6\u5931\u8D25:${err.message}`);
            }
            const body = text.length > DOC_MAX ? text.slice(0, DOC_MAX) + `
\u2026(\u6587\u6863\u8FC7\u957F,\u5DF2\u622A\u65AD\u5230 ${DOC_MAX} \u5B57\u7B26)` : text;
            return `\u6280\u80FD\u76EE\u5F55:${skill.dir}(\u8FD0\u884C\u9644\u5E26\u811A\u672C\u7528)

${body}`;
          }
        });
      }
      return tools;
    }
  };
}

// electron/agent/memory.ts
var import_node_crypto = require("node:crypto");
var import_node_fs3 = require("node:fs");
var MAX_ENTRIES = 200;
var MAX_CONTENT_CHARS = 500;
var BLOCK_MAX = 6e3;
var TYPE_LABEL = {
  preference: "\u504F\u597D",
  fact: "\u4E8B\u5B9E",
  workflow: "\u5DE5\u4F5C\u6D41",
  lesson: "\u6559\u8BAD"
};
function createMemoryStore(getPath) {
  let entries = [];
  let writeChain = Promise.resolve();
  let loaded = false;
  let loadPromise = null;
  function load() {
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      try {
        const raw = await import_node_fs3.promises.readFile(getPath(), "utf8");
        const data = JSON.parse(raw);
        if (Array.isArray(data.entries)) {
          entries = data.entries.filter(
            (e) => !!e && typeof e === "object" && typeof e.content === "string"
          ).slice(0, MAX_ENTRIES);
        }
      } catch {
        entries = [];
      }
      loaded = true;
    })().finally(() => {
      loadPromise = null;
    });
    return loadPromise;
  }
  function scheduleWrite() {
    const payload = JSON.stringify({ entries }, null, 2);
    writeChain = writeChain.then(() => import_node_fs3.promises.writeFile(getPath(), payload, "utf8")).catch(() => {
    });
    return writeChain;
  }
  async function ensureLoaded() {
    if (loaded) return;
    await load();
  }
  return {
    /** 全部条目(按更新时间倒序) */
    async list() {
      await ensureLoaded();
      return [...entries].sort((a, b) => b.updatedAt - a.updatedAt);
    },
    async add(input) {
      await ensureLoaded();
      const content = input.content.trim().slice(0, MAX_CONTENT_CHARS);
      if (!content) throw new Error("\u8BB0\u5FC6\u5185\u5BB9\u4E0D\u80FD\u4E3A\u7A7A");
      const dup = entries.find((e) => e.content === content);
      if (dup) return { entry: dup, created: false };
      if (entries.length >= MAX_ENTRIES) {
        const oldest = entries.find((e) => e.createdAt === Math.min(...entries.map((e2) => e2.createdAt)));
        if (oldest) entries = entries.filter((e) => e.id !== oldest.id);
      }
      const now = Date.now();
      const entry = {
        id: (0, import_node_crypto.randomUUID)(),
        type: input.type || "fact",
        content,
        tags: input.tags?.slice(0, 8),
        source: input.source ?? "agent",
        createdAt: now,
        updatedAt: now
      };
      entries.push(entry);
      scheduleWrite();
      return { entry, created: true };
    },
    /** 按 id 或内容片段删除;返回删除条数 */
    async remove(key) {
      await ensureLoaded();
      const before = entries.length;
      entries = entries.filter((e) => e.id !== key && !e.content.includes(key));
      const removed = before - entries.length;
      if (removed > 0) scheduleWrite();
      return removed;
    },
    async update(id, patch) {
      await ensureLoaded();
      const target = entries.find((e) => e.id === id);
      if (!target) return null;
      if (typeof patch.content === "string") {
        const c = patch.content.trim().slice(0, MAX_CONTENT_CHARS);
        if (!c) throw new Error("\u8BB0\u5FC6\u5185\u5BB9\u4E0D\u80FD\u4E3A\u7A7A");
        target.content = c;
      }
      if (patch.type) target.type = patch.type;
      if (patch.tags) target.tags = patch.tags.slice(0, 8);
      target.updatedAt = Date.now();
      scheduleWrite();
      return { ...target };
    },
    /** 整组替换(自我进化提交时用);返回新列表 */
    async replaceAll(next) {
      await ensureLoaded();
      entries = next.slice(0, MAX_ENTRIES);
      scheduleWrite();
      return [...entries];
    },
    /** 快照备份(进化提交前写 .bak;回滚用) */
    async snapshot(backupPath) {
      await ensureLoaded();
      await import_node_fs3.promises.writeFile(backupPath, JSON.stringify({ entries }, null, 2), "utf8");
    }
  };
}
function formatMemoryBlock(entries) {
  if (entries.length === 0) return "";
  const lines = [];
  for (const type of ["preference", "fact", "workflow", "lesson"]) {
    for (const e of entries.filter((x) => x.type === type)) {
      lines.push(`- [${TYPE_LABEL[type]}] ${e.content}`);
    }
  }
  let body = lines.join("\n");
  if (body.length > BLOCK_MAX) {
    body = body.slice(0, BLOCK_MAX) + `
\u2026(\u8BB0\u5FC6\u8FC7\u957F,\u5DF2\u622A\u65AD)`;
  }
  return `\u3010\u957F\u671F\u8BB0\u5FC6(\u5BF9\u8BDD\u4E2D\u9075\u5B88,\u522B\u81EA\u76F8\u77DB\u76FE;\u4E0E\u4F60\u5BF9\u8BDD\u7684\u662F\u540C\u4E00\u7528\u6237)\u3011
${body}`;
}
function createMemoryTools(store) {
  return [
    {
      name: "remember",
      description: '\u628A\u7528\u6237\u504F\u597D/\u4E8B\u5B9E/\u5DE5\u4F5C\u6D41/\u6559\u8BAD\u5199\u5165\u957F\u671F\u8BB0\u5FC6(\u6C38\u4E45\u751F\u6548,\u540E\u7EED\u6240\u6709\u5BF9\u8BDD\u90FD\u9075\u5B88)\u3002\u9002\u5408:\u7528\u6237\u8868\u8FBE\u7684\u504F\u597D("\u6211\u559C\u6B22\u7B80\u6D01\u56DE\u7B54")\u3001\u91CD\u8981\u4E8B\u5B9E("\u6211\u7684\u9879\u76EE\u5728 D:/xxx")\u3001\u5B66\u5230\u7684\u6559\u8BAD\u3002\u6CE8\u610F:\u53EF\u590D\u7528\u7684\u89C4\u5F8B\u624D\u8BB0,\u4E00\u6B21\u6027\u4FE1\u606F\u4E0D\u8981\u8BB0;\u5DF2\u6709\u76F8\u540C\u5185\u5BB9\u4E0D\u4F1A\u91CD\u590D\u6DFB\u52A0\u3002',
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "\u8BB0\u5FC6\u5185\u5BB9,\u4E00\u53E5\u8BDD\u4E3A\u5B9C" },
          type: {
            type: "string",
            enum: ["preference", "fact", "workflow", "lesson"],
            description: "\u7C7B\u578B:preference \u504F\u597D / fact \u4E8B\u5B9E / workflow \u5DE5\u4F5C\u6D41 / lesson \u6559\u8BAD,\u7F3A\u7701 fact"
          },
          tags: { type: "array", items: { type: "string" }, description: "\u53EF\u9009:\u6807\u7B7E" }
        },
        required: ["content"]
      },
      async execute(params) {
        const type = String(params.type ?? "fact");
        if (!["preference", "fact", "workflow", "lesson"].includes(type)) {
          throw new Error("type \u4EC5\u652F\u6301 preference/fact/workflow/lesson");
        }
        const r = await store.add({
          content: String(params.content ?? ""),
          type,
          source: "agent",
          tags: Array.isArray(params.tags) ? params.tags.map(String) : void 0
        });
        return r.created ? `\u5DF2\u5199\u5165\u957F\u671F\u8BB0\u5FC6([${TYPE_LABEL[type]}] ${r.entry.content})` : "(\u8BB0\u5FC6\u5DF2\u5B58\u5728\u76F8\u540C\u5185\u5BB9,\u672A\u91CD\u590D\u6DFB\u52A0)";
      }
    },
    {
      name: "forget",
      description: "\u5220\u9664\u957F\u671F\u8BB0\u5FC6(\u6309\u5185\u5BB9\u7247\u6BB5\u6216\u6761\u76EE id;\u8BB0\u9519/\u8FC7\u65F6\u7684\u8BB0\u5FC6\u7528\u5B83\u4FEE\u6B63)\u3002",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", description: "\u8BB0\u5FC6\u5185\u5BB9\u7247\u6BB5\u6216\u6761\u76EE id" }
        },
        required: ["key"]
      },
      async execute(params) {
        const n = await store.remove(String(params.key ?? "").trim());
        if (n === 0) throw new Error("\u672A\u627E\u5230\u5339\u914D\u7684\u8BB0\u5FC6");
        return `\u5DF2\u5220\u9664 ${n} \u6761\u8BB0\u5FC6`;
      }
    },
    {
      name: "list_memory",
      description: "\u67E5\u770B\u957F\u671F\u8BB0\u5FC6(\u6309\u7C7B\u578B\u8FC7\u6EE4\u6216\u5173\u952E\u8BCD\u641C\u7D22;\u56DE\u7B54\u6D89\u53CA\u7528\u6237\u504F\u597D/\u5386\u53F2\u7EA6\u5B9A\u65F6\u5148\u67E5\u8BB0\u5FC6)\u3002",
      parameters: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["preference", "fact", "workflow", "lesson"],
            description: "\u53EA\u5217\u8BE5\u7C7B\u578B,\u7F3A\u7701\u5168\u90E8"
          },
          keyword: { type: "string", description: "\u53EA\u5217\u542B\u8BE5\u5173\u952E\u8BCD\u7684\u8BB0\u5FC6" }
        }
      },
      async execute(params) {
        const entries = await store.list();
        const type = params.type ? String(params.type) : "";
        const keyword = params.keyword ? String(params.keyword) : "";
        const filtered = entries.filter(
          (e) => (!type || e.type === type) && (!keyword || e.content.includes(keyword))
        );
        if (filtered.length === 0) return "(\u65E0\u5339\u914D\u7684\u8BB0\u5FC6)";
        return filtered.map((e) => `- [${TYPE_LABEL[e.type]}] ${e.content}(id:${e.id.slice(0, 8)}${e.source === "manual" ? ",\u624B\u52A8" : ""})`).join("\n");
      }
    },
    {
      name: "update_memory",
      description: "\u4FEE\u6539\u5DF2\u6709\u8BB0\u5FC6(\u6309 id;\u7EA0\u6B63\u63AA\u8F9E\u3001\u5408\u5E76\u91CD\u590D\u3001\u6362\u7C7B\u578B)\u3002",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "\u6761\u76EE id(list_memory \u53EF\u67E5\u5230)" },
          content: { type: "string", description: "\u65B0\u5185\u5BB9" },
          type: {
            type: "string",
            enum: ["preference", "fact", "workflow", "lesson"],
            description: "\u65B0\u7C7B\u578B"
          }
        },
        required: ["id"]
      },
      async execute(params) {
        const updated = await store.update(String(params.id ?? ""), {
          content: params.content ? String(params.content) : void 0,
          type: params.type
        });
        if (!updated) throw new Error(`\u672A\u627E\u5230\u6761\u76EE ${String(params.id ?? "")}`);
        return `\u5DF2\u66F4\u65B0:${updated.content}`;
      }
    }
  ];
}

// electron/agent/evolution.ts
var import_node_fs4 = require("node:fs");
var import_node_path3 = __toESM(require("node:path"), 1);
var import_electron2 = require("electron");
var EVAL_TIMEOUT_MS = 6e4;
var LOG_MAX = 20;
var MAX_ROUNDS = 4;
var TARGET_SCORE = 92;
function parseJsonLoose(raw) {
  const text = raw.trim();
  if (!text) return null;
  const candidates = [text, text.replace(/^```(?:json)?\s*|\s*```$/g, ""), text.slice(text.indexOf("{"))];
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
    }
  }
  return null;
}
function clampScore(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : 0;
}
function createEvolution(deps2) {
  const { getConfig, getStore, getMemoryDir, onEvent } = deps2;
  const evaluator = createEvaluatorAgent();
  let busy = false;
  let lastResult = null;
  let logs = [];
  let state = { version: 1, score: 0, updatedAt: 0 };
  const statePath = () => import_node_path3.default.join(getMemoryDir(), "memory-state.json");
  const snapshotsDir = () => import_node_path3.default.join(getMemoryDir(), "memory-snapshots");
  const logPath = () => import_node_path3.default.join(getMemoryDir(), "evolution.json");
  const initPromise = Promise.all([loadLog(), loadState()]);
  async function loadLog() {
    try {
      const raw = await import_node_fs4.promises.readFile(logPath(), "utf8");
      const data = JSON.parse(raw);
      if (Array.isArray(data.logs)) logs = data.logs;
    } catch {
      logs = [];
    }
  }
  async function saveLog() {
    try {
      await import_node_fs4.promises.writeFile(logPath(), JSON.stringify({ logs: logs.slice(0, LOG_MAX) }, null, 2), "utf8");
    } catch {
    }
  }
  async function loadState() {
    try {
      const raw = await import_node_fs4.promises.readFile(statePath(), "utf8");
      const data = JSON.parse(raw);
      state = {
        version: Number.isInteger(data.version) && Number(data.version) >= 1 ? Number(data.version) : 1,
        score: typeof data.score === "number" ? data.score : null,
        updatedAt: typeof data.updatedAt === "number" ? data.updatedAt : 0
      };
    } catch {
      state = { version: 1, score: null, updatedAt: 0 };
    }
  }
  async function saveState() {
    try {
      await import_node_fs4.promises.writeFile(statePath(), JSON.stringify(state, null, 2), "utf8");
    } catch {
    }
  }
  async function ensureSnapshot(version) {
    const store = getStore();
    const file = import_node_path3.default.join(snapshotsDir(), `v${version}.json`);
    try {
      await import_node_fs4.promises.access(file);
      return file;
    } catch {
    }
    await import_node_fs4.promises.mkdir(snapshotsDir(), { recursive: true });
    const entries = store ? await store.list() : [];
    await import_node_fs4.promises.writeFile(file, JSON.stringify({ version, entries }, null, 2), "utf8");
    return file;
  }
  function memoryDump(entries) {
    if (entries.length === 0) return "(\u6682\u65E0\u8BB0\u5FC6)";
    const typeLabel = { preference: "\u504F\u597D", fact: "\u4E8B\u5B9E", workflow: "\u5DE5\u4F5C\u6D41", lesson: "\u6559\u8BAD" };
    return entries.map((e, i) => `${i + 1}. [${typeLabel[e.type] ?? e.type}] ${e.content}`).join("\n");
  }
  function createEvaluatorAgent() {
    return {
      async evaluate(system, input, phase) {
        onEvent({ type: "evolution-progress", phase });
        const config = getConfig();
        if (!config.apiKey.trim()) throw new Error("\u5C1A\u672A\u914D\u7F6E API Key,\u65E0\u6CD5\u8BC4\u4F30");
        for (let retry = 0; retry < 2; retry++) {
          try {
            const result = await streamByConfig({
              config,
              system,
              history: [{ id: "eval", role: "user", parts: [{ type: "text", text: input }] }],
              tools: [],
              signal: AbortSignal.timeout(EVAL_TIMEOUT_MS),
              onEvent: () => {
              },
              jsonMode: true
            });
            if (result.aborted) throw new Error("\u8BC4\u4F30\u88AB\u4E2D\u6B62");
            return result.text;
          } catch (err) {
            if (retry === 0) {
              onEvent({ type: "evolution-progress", phase: `${phase}(\u7F51\u7EDC\u91CD\u8BD5)` });
              continue;
            }
            throw err;
          }
        }
        throw new Error("\u8BC4\u4F30\u5931\u8D25");
      }
    };
  }
  function reviewSystemPrompt() {
    return '\u4F60\u662F\u8BB0\u5FC6\u7CFB\u7EDF\u8BC4\u5BA1\u5668\u3002\u5BF9\u7ED9\u5B9A\u8BB0\u5FC6\u96C6(\u7528\u6237\u504F\u597D/\u4E8B\u5B9E/\u5DE5\u4F5C\u6D41/\u6559\u8BAD)\u505A\u8D28\u91CF\u8BC4\u4F30,\u8F93\u51FA JSON(\u5FC5\u987B\u542B "json" \u5B57\u6837)\u3002\u8BC4\u5206\u7EF4\u5EA6(\u6BCF\u9879 0-10):\u5197\u4F59\u5EA6(\u65E0\u91CD\u590D\u5185\u5BB9)\u3001\u4E00\u81F4\u6027(\u65E0\u81EA\u76F8\u77DB\u76FE)\u3001\u65F6\u6548\u6027(\u65E0\u660E\u663E\u8FC7\u65F6)\u3001\u53EF\u64CD\u4F5C\u6027(\u6BCF\u6761\u5177\u4F53\u3001\u4E0D\u7A7A\u6CDB)\u3001\u4EF7\u503C\u6027(\u503C\u5F97\u957F\u671F\u4FDD\u7559)\u3002\u603B\u5206 0-100\u3002\u8F93\u51FA\u683C\u5F0F:{"total": \u603B\u5206, "issues": ["\u95EE\u98981"], "changes": [{"op": "add"|"delete"|"update", "id": "\u539F\u6761\u76EE\u5E8F\u53F7(delete/update \u5FC5\u586B)", "content": "\u5185\u5BB9", "type": "preference|fact|workflow|lesson", "hypothesis": "\u9884\u6D4B\u7684\u6539\u8FDB\u6548\u679C"}]}\u3002change \u89C4\u5219:\u660E\u663E\u5197\u4F59/\u8FC7\u65F6/\u9519\u8BEF\u7684\u6761\u76EE delete;\u63AA\u8F9E\u53EF\u4F18\u5316\u4F46\u5185\u5BB9\u6709\u4EF7\u503C\u7684 update;\u7F3A\u5931\u7684\u91CD\u8981\u7EF4\u5EA6 add\u3002**\u6BCF\u6761 change \u5FC5\u987B\u5E26 hypothesis(\u9884\u6D4B\u6539\u8FDB\u540E Agent \u884C\u4E3A/\u56DE\u7B54\u8D28\u91CF\u7684\u5177\u4F53\u53D8\u5316)**\u2014\u2014\u53EA\u52A0\u5206\u6790\u6B65\u9AA4\u3001\u4E0D\u9884\u6D4B\u884C\u4E3A\u53D8\u5316\u7684\u5EFA\u8BAE\u662F\u65E0\u6548\u6539\u8FDB,\u4E0D\u8981\u7ED9\u51FA\u3002\u53EA\u8F93\u51FA JSON,\u4E0D\u8981\u89E3\u91CA\u3002';
  }
  function reevalSystemPrompt() {
    return '\u4F60\u662F\u8BB0\u5FC6\u7CFB\u7EDF\u8BC4\u5BA1\u5668\u3002\u5BF9\u7ED9\u5B9A\u8BB0\u5FC6\u96C6\u6253\u5206,\u8F93\u51FA JSON(\u5FC5\u987B\u542B "json" \u5B57\u6837):{"total": \u603B\u52060-100}\u3002\u8BC4\u5206\u7EF4\u5EA6:\u5197\u4F59\u5EA6/\u4E00\u81F4\u6027/\u65F6\u6548\u6027/\u53EF\u64CD\u4F5C\u6027/\u4EF7\u503C\u6027\u3002\u53EA\u8F93\u51FA JSON\u3002';
  }
  async function applyChanges(changes) {
    const store = getStore();
    if (!store) return 0;
    let changeCount = 0;
    const listNow = await store.list();
    for (const ch of changes) {
      if (!ch.hypothesis?.trim()) continue;
      try {
        if (ch.op === "add" && ch.content?.trim()) {
          await store.add({ content: ch.content, type: ch.type ?? "fact", source: "evolution" });
          changeCount++;
        } else if (ch.op === "delete") {
          changeCount += await store.remove(ch.id ?? ch.content ?? "");
        } else if (ch.op === "update" && ch.id) {
          const idx = Number(ch.id);
          const target = listNow[idx - 1];
          if (target && ch.content?.trim()) {
            await store.update(target.id, { content: ch.content, type: ch.type });
            changeCount++;
          }
        }
      } catch {
      }
    }
    return changeCount;
  }
  async function restoreFromSnapshot(version) {
    const store = getStore();
    if (!store) return 0;
    try {
      const raw = await import_node_fs4.promises.readFile(import_node_path3.default.join(snapshotsDir(), `v${version}.json`), "utf8");
      const data = JSON.parse(raw);
      const entries = Array.isArray(data.entries) ? data.entries : [];
      await store.replaceAll(entries);
      return entries.length;
    } catch {
      return -1;
    }
  }
  async function runRound(focus, roundNo, rounds) {
    const store = getStore();
    if (!store) throw new Error("\u8BB0\u5FC6\u7CFB\u7EDF\u672A\u542F\u7528");
    const entries = await store.list();
    const config = getConfig();
    const focusLine = focus?.trim() ? `
\u672C\u6B21\u5173\u6CE8\u70B9:${focus.trim()}` : "";
    const reviewText = await evaluator.evaluate(
      reviewSystemPrompt(),
      `\u3010\u7CFB\u7EDF\u63D0\u793A\u8BCD\u3011${config.systemPrompt.slice(0, 500)}

\u3010\u5F53\u524D\u8BB0\u5FC6\u3011
${memoryDump(entries)}${focusLine}`,
      `\u7B2C ${roundNo}/${rounds} \u8F6E:\u8BC4\u4F30\u5B50\u4EE3\u7406\u8BC4\u5BA1`
    );
    const review = parseJsonLoose(reviewText);
    const before = clampScore(review?.total);
    const issues = Array.isArray(review?.issues) ? review.issues.map(String) : [];
    const changes = Array.isArray(review?.changes) ? review.changes.filter((c) => !!c && typeof c === "object") : [];
    const refVersion = state.version;
    await ensureSnapshot(refVersion);
    const changeCount = await applyChanges(changes);
    const hasRealChange = changeCount > 0;
    const afterEntries = await store.list();
    const reevalText = await evaluator.evaluate(
      reevalSystemPrompt(),
      `\u3010\u6539\u8FDB\u540E\u8BB0\u5FC6\u3011
${memoryDump(afterEntries)}`,
      `\u7B2C ${roundNo}/${rounds} \u8F6E:\u8BC4\u4F30\u5B50\u4EE3\u7406\u590D\u8BC4`
    );
    const after = clampScore(parseJsonLoose(reevalText)?.total);
    const applied = after > before;
    if (applied) {
      state.version += 1;
      state.score = after;
      state.updatedAt = Date.now();
      await ensureSnapshot(state.version);
      await saveState();
    } else {
      await restoreFromSnapshot(refVersion);
    }
    const summary = `v${refVersion}\u2192v${applied ? state.version : refVersion} \u8BC4\u5206 ${before} \u2192 ${after}` + (issues.length > 0 ? `;\u95EE\u9898:${issues[0].slice(0, 50)}` : "") + (hasRealChange ? `;\u5E94\u7528 ${changeCount} \u6761\u5047\u8BF4\u6539\u8FDB` : ";\u65E0\u6709\u6548\u6539\u8FDB(\u65E0\u5047\u8BF4\u7684\u5EFA\u8BAE\u5DF2\u5FFD\u7565)");
    lastResult = { at: Date.now(), version: state.version, applied, before, after, summary };
    logs = [{ at: Date.now(), version: state.version, before, after, applied, summary, changes: changeCount }, ...logs];
    await saveLog();
    return { ok: true, applied, before, after, version: state.version, summary };
  }
  async function runEvolution(focus, rounds = 2) {
    const results = [];
    const roundBudget = Math.min(Math.max(Math.round(rounds) || 2, 1), MAX_ROUNDS);
    for (let round = 1; round <= roundBudget; round++) {
      let result;
      try {
        result = await runRound(focus, round, roundBudget);
      } catch (err) {
        onEvent({ type: "evolution-progress", phase: `\u8FDB\u5316\u4E2D\u6B62:${err.message}` });
        throw err;
      }
      results.push(result);
      if (result.after >= TARGET_SCORE) break;
      if (!result.applied) break;
    }
    return results;
  }
  return {
    async requestEvolve(focus, rounds = 2) {
      await initPromise;
      if (busy) return { started: false, message: "\u8BB0\u5FC6\u8FDB\u5316\u5DF2\u5728\u8FD0\u884C\u4E2D,\u8BF7\u7A0D\u5019" };
      busy = true;
      onEvent({ type: "evolution-progress", phase: "\u542F\u52A8\u8BB0\u5FC6\u8FDB\u5316" });
      void runEvolution(focus, rounds).then((results) => {
        if (results.length === 0) return;
        const last = results[results.length - 1];
        const n = results.filter((r) => r.applied).length;
        const title = n > 0 ? "\u8BB0\u5FC6\u8FDB\u5316\u5B8C\u6210" : "\u8BB0\u5FC6\u8FDB\u5316:\u672A\u5E94\u7528";
        const body = `${n} \u8F6E\u5E94\u7528,\u6700\u8FD1\u4E00\u8F6E ${last.summary}` + (n === 0 ? "(\u8BC4\u5206\u672A\u4E25\u683C\u63D0\u9AD8,\u5DF2\u56DE\u6EDA,\u65E0\u6539\u52A8)" : "\u3002\u53EF\u5728 Agent \u8BBE\u7F6E \u2192 \u81EA\u6211\u8FDB\u5316 \u91CC\u67E5\u770B\u6216\u56DE\u6EDA");
        new import_electron2.Notification({ title, body }).show();
      }).catch((err) => {
        new import_electron2.Notification({ title: "\u8BB0\u5FC6\u8FDB\u5316\u5931\u8D25", body: err.message.slice(0, 120) }).show();
      }).finally(() => {
        busy = false;
        onEvent({ type: "evolution-done" });
      });
      return { started: true, message: `\u8BB0\u5FC6\u8FDB\u5316\u5DF2\u5F00\u59CB(\u5171 ${Math.min(Math.max(Math.round(rounds) || 2, 1), MAX_ROUNDS)} \u8F6E,\u540E\u53F0\u6267\u884C,\u5B8C\u6210\u540E\u6709\u7CFB\u7EDF\u901A\u77E5)` };
    },
    async getStatus() {
      await initPromise;
      if (busy) return "\u3010\u8BB0\u5FC6\u8FDB\u5316\u3011\u8FDB\u884C\u4E2D,\u5B8C\u6210\u540E\u4F1A\u901A\u77E5\u3002";
      if (lastResult) {
        return `\u3010\u8BB0\u5FC6\u8FDB\u5316\u3011\u6700\u8FD1\u4E00\u8F6E:${lastResult.summary}\u3002\u5BF9\u8BDD\u4E2D\u63D0\u53CA\u8FDB\u5316\u7ED3\u679C\u65F6\u6309\u6B64\u5982\u5B9E\u56DE\u7B54\u3002`;
      }
      return "";
    },
    async getLog() {
      await initPromise;
      return logs;
    },
    async rollback() {
      await initPromise;
      const store = getStore();
      if (!store) return "\u8BB0\u5FC6\u7CFB\u7EDF\u672A\u542F\u7528";
      const target = state.version - 1;
      if (target < 1) return "\u65E0\u53EF\u56DE\u6EDA\u7684\u5DF2\u63A5\u53D7\u7248\u672C(\u5F53\u524D\u5C31\u662F\u521D\u59CB\u7248\u672C)";
      const n = await restoreFromSnapshot(target);
      if (n < 0) return `\u56DE\u6EDA\u5931\u8D25:\u5FEB\u7167 v${target} \u4E0D\u5B58\u5728\u6216\u5DF2\u635F\u574F`;
      state.version = target;
      state.score = null;
      state.updatedAt = Date.now();
      await saveState();
      logs = [
        { at: Date.now(), version: target, before: 0, after: 0, applied: false, summary: `\u624B\u52A8\u56DE\u6EDA\u5230\u5DF2\u63A5\u53D7\u7248\u672C v${target}`, changes: 0 },
        ...logs
      ];
      await saveLog();
      return `\u5DF2\u56DE\u6EDA\u5230 v${target}(${n} \u6761\u8BB0\u5FC6)`;
    },
    async resetAll() {
      await initPromise;
      try {
        await import_node_fs4.promises.rm(snapshotsDir(), { recursive: true, force: true });
      } catch {
      }
      try {
        await import_node_fs4.promises.rm(logPath(), { force: true });
      } catch {
      }
      try {
        await import_node_fs4.promises.rm(statePath(), { force: true });
      } catch {
      }
      state = { version: 1, score: null, updatedAt: 0 };
      logs = [];
      lastResult = null;
      await saveState();
      await saveLog();
      return "\u5DF2\u6E05\u9664\u5168\u90E8\u7248\u672C,\u56DE\u5230\u521D\u59CB\u72B6\u6001(v1)";
    }
  };
}

// electron/agent/engine.ts
var MAX_STEPS = 1e3;
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
function parseTitleJson(raw) {
  const text = (raw ?? "").trim();
  if (!text) return "";
  const candidates = [
    text,
    text.replace(/^```(?:json)?\s*|\s*```$/g, "").trim(),
    text.slice(text.indexOf("{")).trim(),
    // 取第一个 { 到最后一个 } 之间的子串(容忍尾随内容)
    text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1).trim()
  ];
  for (const c of candidates) {
    if (!c) continue;
    try {
      const obj = JSON.parse(c);
      if (obj && typeof obj.title === "string" && obj.title.trim()) return obj.title.trim();
    } catch {
    }
  }
  return text;
}
var TITLE_LITERAL_EXAMPLES = /* @__PURE__ */ new Set([
  "\u7B80\u77ED\u6807\u9898",
  "\u4E0D\u8D85\u8FC78\u4E2A\u6C49\u5B57\u7684\u7B80\u77ED\u6807\u9898",
  "\u6807\u9898",
  "\u5BF9\u8BDD\u6807\u9898",
  "<\u5BF9\u8BDD\u6807\u9898>",
  "\u6839\u636E\u5BF9\u8BDD\u5185\u5BB9\u6982\u62EC\u7684\u6807\u9898"
]);
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
function parseManualCall(text) {
  if (!text.startsWith("/") && !text.startsWith("@")) return null;
  const m = /^[/@]\s*(\S+)\s*([\s\S]*)$/.exec(text.trim());
  if (!m || !m[1]) return null;
  return { name: m[1], rest: m[2] ?? "" };
}
function findManualTool(tools, name) {
  const exact = tools.find((t) => t.name === name);
  if (exact) return { tool: exact, hint: "" };
  const lower = name.toLowerCase();
  const matches = tools.filter((t) => t.name.includes(lower));
  if (matches.length === 1) return { tool: matches[0], hint: "" };
  if (matches.length > 1) {
    return {
      tool: null,
      hint: `\u300C${name}\u300D\u5339\u914D\u5230 ${matches.length} \u4E2A\u5DE5\u5177(${matches.map((t) => t.name).join("\u3001")}),\u8BF7\u6307\u5B9A\u5B8C\u6574\u5DE5\u5177\u540D`
    };
  }
  return {
    tool: null,
    hint: `\u672A\u627E\u5230\u300C${name}\u300D\u3002\u6280\u80FD\u7528 /\u6280\u80FD\u540D,\u5982 /trump-perspective;MCP \u5DE5\u5177\u7528 @\u5B8C\u6574\u5DE5\u5177\u540D,\u5982 @mcp_filesystem_read_file(\u53EF\u7528\u5DE5\u5177\u5217\u8868\u67E5\u770B\u73B0\u6709\u5DE5\u5177)`
  };
}
function createConfigTools(deps2) {
  return [
    {
      name: "mcp_config",
      description: "\u7BA1\u7406 MCP \u670D\u52A1(\u81EA\u7136\u8BED\u8A00\u81EA\u6211\u914D\u7F6E):list \u67E5\u770B\u5DF2\u914D\u7F6E\u670D\u52A1 / add \u6DFB\u52A0\u670D\u52A1(stdio \u672C\u5730\u8FDB\u7A0B:name+command+args;\u6216 sse \u8FDC\u7A0B\u7AEF\u70B9:name+type=sse+url) / remove \u5220\u9664\u670D\u52A1 / test \u6D4B\u8BD5\u8FDE\u901A\u3002\u65B0\u589E\u670D\u52A1\u540E\u4E0B\u4E00\u8F6E\u5BF9\u8BDD\u8D77\u751F\u6548,\u5176\u5DE5\u5177\u540D\u79F0\u4E3A mcp_<\u670D\u52A1\u540D>_<\u5DE5\u5177\u540D>\u3002",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "add", "remove", "test"], description: "\u64CD\u4F5C" },
          name: { type: "string", description: "\u670D\u52A1\u540D(add/remove/test \u7528)" },
          command: { type: "string", description: "add(stdio):\u542F\u52A8\u547D\u4EE4,\u5982 npx -y @modelcontextprotocol/server-filesystem" },
          args: { type: "array", items: { type: "string" }, description: "add(stdio):\u542F\u52A8\u53C2\u6570" },
          type: { type: "string", enum: ["stdio", "sse"], description: "add:\u4F20\u8F93\u7C7B\u578B,\u7F3A\u7701 stdio" },
          url: { type: "string", description: "add(sse):\u8FDC\u7A0B\u7AEF\u70B9 URL" },
          env: { type: "object", description: "add(stdio):\u73AF\u5883\u53D8\u91CF KEY=VALUE" }
        },
        required: ["action"]
      },
      async execute(params) {
        const action = String(params.action ?? "");
        const cfg = deps2.getConfig();
        const servers = [...cfg.mcpServers ?? []];
        if (action === "list") {
          if (servers.length === 0) return "(\u672A\u914D\u7F6E MCP \u670D\u52A1)";
          return servers.map(
            (s, i) => `${i + 1}. ${s.name}(${s.type === "sse" ? "sse" : "stdio"}${s.type === "sse" ? ":" + (s.url ?? "") : ":" + s.command})`
          ).join("\n");
        }
        if (action === "add") {
          const name = String(params.name ?? "").trim();
          if (!name) throw new Error("add \u9700\u8981 name(\u670D\u52A1\u540D)");
          if (servers.some((s) => s.name === name)) throw new Error(`\u670D\u52A1 ${name} \u5DF2\u5B58\u5728,\u53EF\u5148 remove \u518D add`);
          const type = params.type === "sse" ? "sse" : "stdio";
          if (type === "sse") {
            const url = String(params.url ?? "").trim();
            if (!/^https?:\/\//i.test(url)) throw new Error("sse \u670D\u52A1\u9700\u8981 url(http/https \u7AEF\u70B9)");
            servers.push({ name, type: "sse", command: url, url });
          } else {
            const command = String(params.command ?? "").trim();
            if (!command) throw new Error("stdio \u670D\u52A1\u9700\u8981 command(\u542F\u52A8\u547D\u4EE4)");
            servers.push({
              name,
              type: "stdio",
              command,
              args: Array.isArray(params.args) ? params.args.map(String) : [],
              env: params.env && typeof params.env === "object" ? Object.fromEntries(Object.entries(params.env).map(([k, v]) => [k, String(v)])) : void 0
            });
          }
          if (!deps2.updateAgentConfig) throw new Error("\u914D\u7F6E\u5199\u5165\u4E0D\u53EF\u7528(\u672A\u6CE8\u5165 updateAgentConfig)");
          deps2.updateAgentConfig({ mcpServers: servers });
          return `\u5DF2\u6DFB\u52A0 MCP \u670D\u52A1 ${name}(${type})\u3002\u4E0B\u4E00\u8F6E\u5BF9\u8BDD\u8D77\u53EF\u7528,\u5DE5\u5177\u540D\u4E3A mcp_${name}_<\u5DE5\u5177\u540D>`;
        }
        if (action === "remove") {
          const name = String(params.name ?? "").trim();
          const idx = servers.findIndex((s) => s.name === name);
          if (idx === -1) {
            throw new Error(
              `\u672A\u627E\u5230\u670D\u52A1 ${name}(list \u53EF\u67E5\u770B)` + (servers.length ? `,\u73B0\u6709:${servers.map((s) => s.name).join("\u3001")}` : "")
            );
          }
          servers.splice(idx, 1);
          if (!deps2.updateAgentConfig) throw new Error("\u914D\u7F6E\u5199\u5165\u4E0D\u53EF\u7528(\u672A\u6CE8\u5165 updateAgentConfig)");
          deps2.updateAgentConfig({ mcpServers: servers });
          return `\u5DF2\u5220\u9664 MCP \u670D\u52A1 ${name}`;
        }
        if (action === "test") {
          const name = String(params.name ?? "").trim();
          const target = servers.find((s) => s.name === name);
          if (!target) throw new Error(`\u672A\u627E\u5230\u670D\u52A1 ${name}(list \u53EF\u67E5\u770B)`);
          const r = await deps2.testMcp(target);
          return r.ok ? `\u8FDE\u63A5\u6210\u529F,${r.toolCount ?? 0} \u4E2A\u5DE5\u5177` : `\u8FDE\u63A5\u5931\u8D25:${r.error}`;
        }
        throw new Error("action \u4EC5\u652F\u6301 list/add/remove/test");
      }
    },
    {
      name: "skills_config",
      description: '\u7BA1\u7406\u6280\u80FD(\u81EA\u7136\u8BED\u8A00\u81EA\u6211\u914D\u7F6E):list \u67E5\u770B\u6280\u80FD\u76EE\u5F55\u4E0E\u5168\u90E8\u5DF2\u6CE8\u518C\u6280\u80FD(\u542B\u6392\u9664\u72B6\u6001) / **create \u521B\u5EFA\u65B0\u6280\u80FD**(name+description+content,\u5199\u5165\u6280\u80FD\u76EE\u5F55,\u4E0B\u4E00\u8F6E\u8D77\u53EF /\u6280\u80FD\u540D \u8C03\u7528\u2014\u2014\u7528\u6237\u8BF4"\u5E2E\u6211\u521B\u5EFA\u4E00\u4E2AXX\u6280\u80FD"\u6216**\u89E3\u51B3\u5B8C\u95EE\u9898\u540E\u628A\u7ECF\u9A8C\u6C89\u6DC0\u6210\u53EF\u590D\u7528\u6280\u80FD**\u65F6\u7528\u5B83\u3002\u5E26\u811A\u672C\u7684\u6280\u80FD:\u5148 create(\u8FD4\u56DE\u6280\u80FD\u76EE\u5F55\u8DEF\u5F84),\u518D\u7528 write_file \u628A\u811A\u672C\u5199\u5230 `<\u6280\u80FD\u76EE\u5F55>/scripts/` \u4E0B,\u5E76\u5728 content \u91CC\u5199\u660E\u811A\u672C\u7528\u6CD5(\u7528 exec_command \u8FD0\u884C)\u2014\u2014\u5B8C\u6574\u7684"\u7ECF\u9A8C+\u811A\u672C"\u6280\u80FD\u95ED\u73AF) / add \u6DFB\u52A0\u76EE\u5F55(\u7EDD\u5BF9\u8DEF\u5F84,\u626B\u63CF\u5176\u4E2D\u7684 SKILL.md) / remove \u79FB\u9664\u76EE\u5F55 / **exclude \u79FB\u9664\u67D0\u4E2A\u6280\u80FD**(\u626B\u63CF\u8DF3\u8FC7,\u5BF9\u8BDD\u4E2D\u4E0D\u518D\u53EF\u7528,\u5982\u7528\u6237\u8BF4"\u628A\u8FD9\u4E2A\u6280\u80FD\u7981\u7528") / include \u6062\u590D\u88AB\u79FB\u9664\u7684\u6280\u80FD\u3002\u6280\u80FD\u540D = \u5DE5\u5177\u540D\u53BB skill_ \u524D\u7F00(list \u53EF\u67E5)\u3002\u65B0\u589E\u76EE\u5F55/\u521B\u5EFA/\u6392\u9664\u6280\u80FD\u540E\u4E0B\u4E00\u8F6E\u5BF9\u8BDD\u8D77\u751F\u6548\u3002',
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["list", "create", "add", "remove", "exclude", "include"],
            description: "\u64CD\u4F5C:list / create(\u521B\u5EFA\u6280\u80FD) / add / remove(\u76EE\u5F55) / exclude(\u79FB\u9664\u6280\u80FD) / include(\u6062\u590D\u6280\u80FD)"
          },
          name: { type: "string", description: "create:\u6280\u80FD\u540D(\u82F1\u6587/\u62FC\u97F3,\u81EA\u52A8\u8F6C\u5C0F\u5199\u8FDE\u5B57\u7B26)" },
          description: { type: "string", description: "create:\u4E00\u53E5\u8BDD\u63CF\u8FF0(\u505A\u4EC0\u4E48 + \u4F55\u65F6\u7528,\u2264300 \u5B57\u7B26)" },
          content: { type: "string", description: "create:\u6280\u80FD\u6587\u6863\u6B63\u6587(\u4F7F\u7528\u8BF4\u660E/\u6B65\u9AA4,Markdown,\u226450000 \u5B57\u7B26)" },
          overwrite: { type: "boolean", description: "create:\u540C\u540D\u6280\u80FD\u5DF2\u5B58\u5728\u65F6\u8986\u76D6,\u7F3A\u7701 false" },
          dir: { type: "string", description: "\u76EE\u5F55\u7EDD\u5BF9\u8DEF\u5F84(add/remove \u7528)" },
          skill: { type: "string", description: "\u6280\u80FD\u540D(exclude/include \u7528,list \u53EF\u67E5)" }
        },
        required: ["action"]
      },
      async execute(params) {
        const action = String(params.action ?? "");
        const cfg = deps2.getConfig();
        const dirs = [...cfg.skillsDirs ?? []];
        const excluded = [...cfg.excludedSkills ?? []];
        if (action === "list") {
          const lines = [];
          if (dirs.length === 0) lines.push("(\u672A\u914D\u7F6E\u6280\u80FD\u76EE\u5F55)");
          for (const [i, d] of dirs.entries()) lines.push(`${i + 1}. ${d}`);
          const all = await deps2.listSkills?.(dirs, []) ?? [];
          if (all.length === 0) lines.push("(\u76EE\u5F55\u4E0B\u672A\u626B\u63CF\u5230\u6280\u80FD)");
          for (const t of all) {
            const slug = t.name.replace(/^skill_/, "");
            lines.push(`  - ${slug}${excluded.includes(slug) ? "(\u5DF2\u6392\u9664)" : ""}`);
          }
          if (excluded.length > 0) {
            lines.push(`\u5DF2\u6392\u9664\u6280\u80FD:${excluded.join("\u3001")}(\u53EF\u7528 include \u6062\u590D)`);
          }
          return lines.join("\n");
        }
        if (action === "create") {
          const skillDir = deps2.getSkillDir?.();
          if (!skillDir) throw new Error("\u6280\u80FD\u521B\u5EFA\u4E0D\u53EF\u7528(\u672A\u6CE8\u5165\u6280\u80FD\u76EE\u5F55)");
          const name = String(params.name ?? "").trim();
          if (!name) throw new Error("create \u9700\u8981 name(\u6280\u80FD\u540D)");
          const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "skill";
          const description = String(params.description ?? "").trim().replace(/\s+/g, " ");
          if (!description) throw new Error("create \u9700\u8981 description(\u4E00\u53E5\u8BDD\u63CF\u8FF0)");
          if (description.length > 300) throw new Error("description \u8FC7\u957F(\u2264300 \u5B57\u7B26)");
          const content = String(params.content ?? "").trim();
          if (!content) throw new Error("create \u9700\u8981 content(\u6280\u80FD\u6587\u6863\u6B63\u6587)");
          if (content.length > 5e4) throw new Error("content \u8FC7\u957F(\u226450000 \u5B57\u7B26)");
          const existing = await deps2.listSkills?.(dirs, []) ?? [];
          if (existing.some((t) => t.name === `skill_${slug}`) && !params.overwrite) {
            throw new Error(`\u6280\u80FD ${slug} \u5DF2\u5B58\u5728(overwrite=true \u53EF\u8986\u76D6)`);
          }
          const targetDir = import_node_path4.default.join(skillDir, slug);
          const mdPath = import_node_path4.default.join(targetDir, "SKILL.md");
          await import_node_fs5.promises.mkdir(targetDir, { recursive: true });
          const md = `---
name: ${slug}
description: ${description}
---

${content}
`;
          await import_node_fs5.promises.writeFile(mdPath, md, "utf8");
          return `\u5DF2\u521B\u5EFA\u6280\u80FD ${slug}:
${mdPath}
\u5BF9\u8BDD\u4E2D\u53EF\u7528 /${slug} \u8C03\u7528(\u4E0B\u4E00\u8F6E\u8D77\u751F\u6548),\u4E5F\u53EF\u5728 \u8BBE\u7F6E \u2192 \u6280\u80FD\u76EE\u5F55(userData/skills) \u67E5\u770B`;
        }
        if (action === "add") {
          const dir = String(params.dir ?? "").trim();
          if (!dir) throw new Error("add \u9700\u8981 dir(\u76EE\u5F55\u7EDD\u5BF9\u8DEF\u5F84)");
          if (dirs.includes(dir)) return `\u76EE\u5F55\u5DF2\u5B58\u5728:${dir}`;
          dirs.push(dir);
          if (!deps2.updateAgentConfig) throw new Error("\u914D\u7F6E\u5199\u5165\u4E0D\u53EF\u7528(\u672A\u6CE8\u5165 updateAgentConfig)");
          deps2.updateAgentConfig({ skillsDirs: dirs });
          return `\u5DF2\u6DFB\u52A0\u6280\u80FD\u76EE\u5F55 ${dir},\u4E0B\u4E00\u8F6E\u5BF9\u8BDD\u8D77\u751F\u6548`;
        }
        if (action === "remove") {
          const dir = String(params.dir ?? "").trim();
          const idx = dirs.findIndex((d) => d === dir);
          if (idx === -1) throw new Error(`\u672A\u627E\u5230\u76EE\u5F55 ${dir}(list \u53EF\u67E5\u770B)`);
          dirs.splice(idx, 1);
          if (!deps2.updateAgentConfig) throw new Error("\u914D\u7F6E\u5199\u5165\u4E0D\u53EF\u7528(\u672A\u6CE8\u5165 updateAgentConfig)");
          deps2.updateAgentConfig({ skillsDirs: dirs });
          return `\u5DF2\u79FB\u9664\u6280\u80FD\u76EE\u5F55 ${dir}`;
        }
        if (action === "exclude") {
          const skill = String(params.skill ?? "").trim().replace(/^skill_/, "");
          if (!skill) throw new Error("exclude \u9700\u8981 skill(\u6280\u80FD\u540D,list \u53EF\u67E5)");
          const all = await deps2.listSkills?.(dirs, []) ?? [];
          if (!all.some((t) => t.name.replace(/^skill_/, "") === skill)) {
            throw new Error(`\u6280\u80FD ${skill} \u4E0D\u5B58\u5728(\u53EF\u7528 list \u67E5\u770B\u5168\u90E8\u6280\u80FD)`);
          }
          if (!excluded.includes(skill)) excluded.push(skill);
          if (!deps2.updateAgentConfig) throw new Error("\u914D\u7F6E\u5199\u5165\u4E0D\u53EF\u7528(\u672A\u6CE8\u5165 updateAgentConfig)");
          deps2.updateAgentConfig({ excludedSkills: excluded });
          return `\u5DF2\u79FB\u9664\u6280\u80FD ${skill}(\u626B\u63CF\u8DF3\u8FC7,\u5BF9\u8BDD\u4E2D /${skill} \u4E0D\u518D\u53EF\u7528;\u53EF\u7528 include \u6062\u590D)`;
        }
        if (action === "include") {
          const skill = String(params.skill ?? "").trim().replace(/^skill_/, "");
          if (!skill) throw new Error("include \u9700\u8981 skill(\u6280\u80FD\u540D)");
          const idx = excluded.indexOf(skill);
          if (idx === -1) throw new Error(`\u6280\u80FD ${skill} \u4E0D\u5728\u6392\u9664\u5217\u8868(\u53EF\u7528 list \u67E5\u770B)`);
          excluded.splice(idx, 1);
          if (!deps2.updateAgentConfig) throw new Error("\u914D\u7F6E\u5199\u5165\u4E0D\u53EF\u7528(\u672A\u6CE8\u5165 updateAgentConfig)");
          deps2.updateAgentConfig({ excludedSkills: excluded });
          return `\u5DF2\u6062\u590D\u6280\u80FD ${skill},\u4E0B\u4E00\u8F6E\u5BF9\u8BDD\u8D77\u53EF\u7528`;
        }
        throw new Error("action \u4EC5\u652F\u6301 list/add/remove/exclude/include");
      }
    }
  ];
}
function compressArgs(value, depth = 0) {
  if (depth > 4) return "(\u53C2\u6570\u5DF2\u622A\u65AD)";
  if (typeof value === "string") return value.length > 200 ? value.slice(0, 200) + "\u2026" : value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => compressArgs(v, depth + 1));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = compressArgs(v, depth + 1);
    return out;
  }
  return value;
}
function createSummaryAgent(deps2) {
  return {
    async summarize(messages) {
      const config = deps2.getConfig();
      if (!config.apiKey.trim() || messages.length === 0) return "";
      try {
        const recent = messages.slice(-12).map((m) => ({
          ...m,
          parts: m.parts.map((p) => {
            if (p.type === "reasoning") return { ...p, text: p.text.slice(0, 500) };
            if (p.type === "tool-result") return { ...p, result: p.result.slice(0, 2e3) };
            if (p.type === "tool-call") return { ...p, args: compressArgs(p.args) };
            return p;
          })
        }));
        const attempts = [
          {
            jsonMode: true,
            system: '\u4F60\u662F\u5BF9\u8BDD\u6807\u9898\u751F\u6210\u5668\u3002\u8F93\u51FA JSON \u5BF9\u8C61:{"title": "<\u5BF9\u8BDD\u6807\u9898>"}\u3002title \u7684\u503C\u662F\u6839\u636E\u5BF9\u8BDD\u5185\u5BB9\u65B0\u751F\u6210\u7684\u7B80\u77ED\u6807\u9898(\u4E0D\u8D85\u8FC7 8 \u4E2A\u6C49\u5B57),**\u7981\u6B62\u7167\u6284\u793A\u4F8B\u6587\u5B57**\u3002\u53EA\u8F93\u51FA\u8FD9\u4E2A JSON,\u4E0D\u8981\u4EFB\u4F55\u89E3\u91CA\u3002'
          },
          {
            jsonMode: true,
            system: '\u4F60\u662F\u5BF9\u8BDD\u6807\u9898\u751F\u6210\u5668\u3002\u76F4\u63A5\u8F93\u51FA JSON:{"title": "\u6839\u636E\u5BF9\u8BDD\u5185\u5BB9\u6982\u62EC\u7684\u6807\u9898"}\u3002title \u4E3A\u4E0D\u8D85\u8FC7 8 \u4E2A\u6C49\u5B57\u7684\u5BF9\u8BDD\u6807\u9898,\u5FC5\u987B\u6765\u81EA\u5BF9\u8BDD\u5185\u5BB9,\u4E0D\u8981\u4F7F\u7528\u793A\u4F8B\u4E2D\u7684\u6587\u5B57\u3002\u53EA\u8F93\u51FA JSON\u3002'
          },
          {
            jsonMode: false,
            system: "\u4F60\u662F\u5BF9\u8BDD\u6807\u9898\u751F\u6210\u5668\u3002\u6839\u636E\u5BF9\u8BDD\u5185\u5BB9\u751F\u6210\u4E00\u4E2A\u4E0D\u8D85\u8FC7 8 \u4E2A\u6C49\u5B57\u7684\u7B80\u77ED\u6807\u9898,\u76F4\u63A5\u8FD4\u56DE\u6807\u9898\u6587\u672C,\u4E0D\u8981\u4EFB\u4F55\u89E3\u91CA\u3001\u6807\u70B9\u6216\u5F15\u53F7\u3002"
          }
        ];
        for (const attempt of attempts) {
          for (let retry = 0; retry < 2; retry++) {
            try {
              const result = await streamByConfig({
                config: { ...config, reasoningEffort: "low" },
                // JSON 模式 prompt 必须含 "json" 字样(官方 json_mode 指南);
                // noThinking——标题生成无需思考(effort 'none' 官方值),
                // 思维链不挤占输出预算(空 content 的典型场景)
                system: attempt.system,
                history: recent,
                tools: [],
                signal: AbortSignal.timeout(9e4),
                onEvent: () => {
                },
                jsonMode: attempt.jsonMode,
                noThinking: true
              });
              const title = sanitizeTitle(parseTitleJson(result.text));
              if (title && !TITLE_LITERAL_EXAMPLES.has(title)) return title;
              break;
            } catch {
              if (retry === 0) continue;
              break;
            }
          }
        }
        return "";
      } catch {
        return "";
      }
    }
  };
}
function createAgentEngine(deps2) {
  let running = false;
  let ctl = null;
  const emit = (event) => deps2.onEvent(event);
  const mcpManager = createMCPManager();
  const skillLoader = createSkillLoader();
  async function getExternalTools() {
    const cfg = deps2.getConfig();
    const [mcpTools, skillTools] = await Promise.all([
      mcpManager.listTools(cfg.mcpServers ?? []).catch((err) => {
        console.error("[agent] MCP \u5DE5\u5177\u52A0\u8F7D\u5931\u8D25:", err.message);
        return [];
      }),
      // 已排除技能(对话/设置里移除)扫描跳过;
      // ownDirs = userData/skills(自己创建的技能,设置界面分区展示)
      skillLoader.listTools(cfg.skillsDirs ?? [], cfg.excludedSkills ?? [], [
        deps2.getSkillDir?.() ?? ""
      ])
    ]);
    return [...mcpTools, ...skillTools];
  }
  const memoryStore = deps2.getMemoryStore?.() ?? null;
  async function getMemoryBlock() {
    if (!memoryStore) return "";
    try {
      const entries = await memoryStore.list();
      return formatMemoryBlock(entries);
    } catch {
      return "";
    }
  }
  async function runSubAgent(params) {
    const task = String(params.task ?? "").trim();
    if (!task) throw new Error("delegate \u7684 task \u53C2\u6570\u4E0D\u80FD\u4E3A\u7A7A");
    const config = deps2.getConfig();
    if (!config.apiKey.trim()) throw new Error("\u5C1A\u672A\u914D\u7F6E DeepSeek API Key");
    const allowAll = !Array.isArray(params.tools) || params.tools.length === 0;
    const allowed = new Set((Array.isArray(params.tools) ? params.tools : []).map(String));
    const subTools = [...tools, ...await getExternalTools()].filter(
      (t) => allowAll || allowed.has(t.name)
    );
    const subMap = new Map(subTools.map((t) => [t.name, t]));
    const system = [
      config.systemPrompt,
      String(params.system ?? "").trim() || "\u4F60\u662F\u5B50\u4EE3\u7406,\u4E13\u6CE8\u5B8C\u6210\u59D4\u6D3E\u7684\u5B50\u4EFB\u52A1,\u53EA\u8FD4\u56DE\u4EFB\u52A1\u7ED3\u679C\u6587\u672C,\u4E0D\u8981\u591A\u4F59\u89E3\u91CA\u3002"
    ].filter(Boolean).join("\n");
    const historyIn = [
      { id: (0, import_node_crypto2.randomUUID)(), role: "user", parts: [{ type: "text", text: task }] }
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
      historyIn.push({ id: (0, import_node_crypto2.randomUUID)(), role: "assistant", parts: msgParts.slice(pushedParts) });
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
  const configTools = createConfigTools({
    getConfig: deps2.getConfig,
    updateAgentConfig: deps2.updateAgentConfig,
    testMcp: (server) => mcpManager.test(server),
    // 技能扫描(排除校验:确认要排除的技能确实已注册)
    listSkills: (dirs, excluded) => skillLoader.listTools(dirs, excluded),
    // 技能创建写入目录(main.cjs 注入 userData/skills)
    getSkillDir: deps2.getSkillDir
  });
  const evolveTool = {
    name: "evolve_memory",
    description: '\u89E6\u53D1\u8BB0\u5FC6\u7CFB\u7EDF\u7684\u7248\u672C\u5316\u81EA\u6211\u8FDB\u5316(\u540E\u53F0,\u591A\u8F6E\u5019\u9009\u5FAA\u73AF):\u6BCF\u8F6E \u8BC4\u4F30\u8BB0\u5FC6\u8D28\u91CF \u2192 \u751F\u6210\u5E26\u5047\u8BF4\u7684\u6539\u8FDB \u2192 \u590D\u8BC4 \u2192 \u53EA\u63A5\u53D7\u8BC4\u5206\u4E25\u683C\u66F4\u9AD8\u7684\u5019\u9009(\u63A5\u53D7 = \u65B0\u7248\u672C\u5B58\u6863,\u62D2\u7EDD = \u6062\u590D\u539F\u7248\u672C),\u6700\u591A rounds \u8F6E,\u8FBE\u6807\u63D0\u524D\u505C\u3002\u9002\u5408:\u7528\u6237\u8BF4"\u6574\u7406\u4E00\u4E0B\u8BB0\u5FC6""\u8FDB\u5316\u4E00\u4E0B"\u3001\u6216\u5BF9\u8BDD\u6C89\u6DC0\u591A\u540E\u4E3B\u52A8\u89E6\u53D1\u3002\u5B8C\u6210\u540E\u6709\u7CFB\u7EDF\u901A\u77E5\u3002',
    parameters: {
      type: "object",
      properties: {
        focus: { type: "string", description: '\u53EF\u9009:\u672C\u6B21\u8FDB\u5316\u7684\u5173\u6CE8\u70B9(\u5982"\u53BB\u91CD""\u8865\u5145\u504F\u597D")' },
        rounds: { type: "number", description: "\u5019\u9009\u8F6E\u6570,\u7F3A\u7701 2,\u6700\u5927 4(\u6BCF\u8F6E\u4E00\u4E2A\u5019\u9009\u7248\u672C)" }
      }
    },
    async execute(params) {
      const evolution = deps2.getEvolution?.() ?? null;
      if (!evolution) throw new Error("\u81EA\u6211\u8FDB\u5316\u4E0D\u53EF\u7528(\u672A\u542F\u7528)");
      return (await evolution.requestEvolve(
        params.focus ? String(params.focus) : void 0,
        params.rounds ? Number(params.rounds) : void 0
      )).message;
    }
  };
  const tools = [
    ...createTools({
      onSwitchToMusic: deps2.onSwitchToMusic,
      // 后台长任务完成(如 bili 下载)→ background-done 事件转发渲染端,
      // 渲染端自动触发一轮对话让 LLM 主动回复(用户无需提问)
      onBackgroundDone: (info) => emit({ type: "background-done", ...info })
    }),
    delegateTool,
    ...memoryStore ? createMemoryTools(memoryStore) : [],
    ...configTools,
    evolveTool
  ];
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
    const historyIn = [...trimHistory(history)];
    const lastMsg = historyIn[historyIn.length - 1];
    if (lastMsg?.role !== "user") {
      historyIn.push({ id: (0, import_node_crypto2.randomUUID)(), role: "user", parts: [{ type: "text", text }] });
    }
    const msgParts = [];
    let pushedParts = 0;
    let reasoningText = "";
    let usage = { input: 0, output: 0 };
    const manual = parseManualCall(text);
    if (manual) {
      const turnTools = [...tools, ...await getExternalTools()];
      const found = findManualTool(turnTools, manual.name);
      if (!found.tool) {
        onEvent({ type: "error", message: found.hint });
        onEvent({ type: "status", status: "idle" });
        return;
      }
      onEvent({ type: "status", status: "running" });
      const id = (0, import_node_crypto2.randomUUID)();
      let args = {};
      const rest = manual.rest.trim();
      if (rest) {
        try {
          const parsed = JSON.parse(rest);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed;
        } catch {
        }
      }
      onEvent({ type: "tool-call", id, name: found.tool.name, args: JSON.stringify(args) });
      msgParts.push({ type: "tool-call", id, name: found.tool.name, args });
      const started = Date.now();
      let ok = true;
      let out = "";
      try {
        out = await Promise.race([
          Promise.resolve(found.tool.execute(args)),
          new Promise(
            (_, reject) => setTimeout(() => reject(new Error(`\u5DE5\u5177\u6267\u884C\u8D85\u65F6(${TOOL_TIMEOUT_MS / 1e3}s)`)), TOOL_TIMEOUT_MS)
          )
        ]);
      } catch (err) {
        ok = false;
        out = `\u5DE5\u5177\u6267\u884C\u5931\u8D25:${err.message}`;
      }
      onEvent({ type: "tool-result", id, name: found.tool.name, ok, result: out, durationMs: Date.now() - started });
      msgParts.push({ type: "tool-result", id, name: found.tool.name, ok, result: out, durationMs: Date.now() - started });
      historyIn.push({ id: (0, import_node_crypto2.randomUUID)(), role: "assistant", parts: msgParts.slice(0) });
      pushedParts = msgParts.length;
    }
    for (let step = 1; step <= MAX_STEPS; step++) {
      if (signal.aborted) return;
      const bgStatus = getBiliBackgroundStatus();
      const memoryBlock = await getMemoryBlock();
      const evolutionStatus = await deps2.getEvolution?.()?.getStatus() ?? "";
      const system = [
        config.systemPrompt || "\u4F60\u662F\u684C\u9762\u7075\u52A8\u5C9B\u6302\u4EF6\u91CC\u7684\u4E2A\u4EBA\u52A9\u624B\u3002",
        memoryBlock,
        evolutionStatus,
        bgStatus
      ].filter(Boolean).join("\n\n");
      const turnTools = [...tools, ...await getExternalTools()];
      const turnMap = new Map(turnTools.map((t) => [t.name, t]));
      const result = await streamByConfig({
        config,
        system,
        history: historyIn,
        tools: turnTools,
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
          message: { id: (0, import_node_crypto2.randomUUID)(), role: "assistant", parts: msgParts },
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
      const results = await executeToolBatch(batch, turnMap, turnTools);
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
      historyIn.push({ id: (0, import_node_crypto2.randomUUID)(), role: "assistant", parts: msgParts.slice(pushedParts) });
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
      const config = deps2.getConfig();
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
    },
    async listAllTools() {
      const external = await getExternalTools();
      return [...tools, ...external].map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        // 技能来源分区(自己创建 vs 扫描到;设置界面分区展示)
        sourceKind: t.sourceKind
      }));
    },
    async testMCP(server) {
      return mcpManager.test(server);
    },
    dispose() {
      mcpManager.dispose();
    }
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  compressArgs,
  createAgentEngine,
  createConfigTools,
  createEvolution,
  createMemoryStore,
  createSummaryAgent,
  createTools,
  findManualTool,
  parseManualCall,
  parseTitleJson
});
