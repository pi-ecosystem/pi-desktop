// Direct chat (no pi, no backend): OpenAI-compatible chat completions
// straight to a provider, streamed into the existing transcript UI.
// Keys live in this device's localStorage only — never touch the backend.
// Network runs through the Rust direct_fetch pipe (WebView CORS would
// block provider calls made straight from the page).
import { Channel } from "@tauri-apps/api/core";
import { invoke } from "./tauri-shim";

export interface DirectSettings {
  preset: "openai" | "anthropic" | "responses"; // wire shape
  baseUrl: string; // e.g. https://api.openai.com/v1 (no trailing path)
  apiKey: string;
  model: string;
}

export interface DirectMessage {
  role: "user" | "assistant";
  content: string;
  thinking?: string;
  at: number;
}

export interface DirectChat {
  id: string;
  title: string;
  model: string;
  updatedAt: number;
  messages: DirectMessage[];
}

const LS_KEY = "pi-direct";
const LS_CHATS = "pi-direct-chats";

export function loadDirectSettings(): DirectSettings {
  try {
    const j = JSON.parse(localStorage.getItem(LS_KEY) ?? "{}");
    return {
      preset: j.preset === "anthropic" ? "anthropic" : j.preset === "responses" ? "responses" : "openai",
      baseUrl: (j.baseUrl ?? "").trim().replace(/\/+$/, ""),
      apiKey: j.apiKey ?? "",
      model: (j.model ?? "").trim(),
    };
  } catch {
    return { preset: "openai" as const, baseUrl: "", apiKey: "", model: "" };
  }
}

export function saveDirectSettings(s: DirectSettings): void {
  localStorage.setItem(LS_KEY, JSON.stringify(s));
}

export function directConfigured(): boolean {
  const s = loadDirectSettings();
  return !!(s.baseUrl && s.apiKey && s.model);
}

// ---- local chat history ----

function readChats(): DirectChat[] {
  try {
    const a = JSON.parse(localStorage.getItem(LS_CHATS) ?? "[]");
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

function writeChats(chats: DirectChat[]): void {
  try {
    // Cap: 50 chats, 200 msgs each — localStorage is small.
    const trimmed = chats.slice(0, 50).map((c) => ({
      ...c,
      messages: c.messages.slice(-200),
    }));
    localStorage.setItem(LS_CHATS, JSON.stringify(trimmed));
  } catch {
    /* storage full/ blocked: chats just don't persist */
  }
}

export function listDirectChats(): DirectChat[] {
  return readChats().sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getDirectChat(id: string): DirectChat | null {
  return readChats().find((c) => c.id === id) ?? null;
}

export function newDirectChat(model: string): DirectChat {
  const c: DirectChat = {
    id: `d${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
    title: "New chat",
    model,
    updatedAt: Date.now(),
    messages: [],
  };
  const all = readChats();
  all.unshift(c);
  writeChats(all);
  return c;
}

export function saveDirectChat(chat: DirectChat): void {
  chat.updatedAt = Date.now();
  const all = readChats();
  const i = all.findIndex((c) => c.id === chat.id);
  if (i >= 0) all[i] = chat;
  else all.unshift(chat);
  writeChats(all);
}

export function deleteDirectChat(id: string): void {
  writeChats(readChats().filter((c) => c.id !== id));
}

export function renameDirectChat(id: string, title: string): void {
  const all = readChats();
  const c = all.find((x) => x.id === id);
  if (c) {
    c.title = title.slice(0, 80) || "Untitled";
    writeChats(all);
  }
}

// ---- model listing (fills the chat model dropdown) ----
// Always live: GET /models on dropdown open, no cache, no hardcoded ids.
// Anthropic has no list endpoint — most gateways still answer /models;
// otherwise the Settings field takes any typed id.
export async function listDirectModels(settings: DirectSettings): Promise<string[]> {
  const text = await nativeText(`${settings.baseUrl}/models`, {
    authorization: `Bearer ${settings.apiKey}`,
  });
  const j = JSON.parse(text);
  const names = Array.isArray(j?.data)
    ? j.data.map((m: any) => m?.id).filter((x: any) => typeof x === "string")
    : [];
  if (!names.length) throw new Error("no models returned");
  return names;
}

// ---- streaming completion ----

export interface DirectStreamEvents {
  onThinking?: (full: string) => void;
  onContent?: (full: string) => void;
  onDone?: (msg: DirectMessage) => void;
  onError?: (err: Error) => void;
}

// Native pipe: the WebView can't call provider APIs directly (CORS +
// gateway browser blocks), so Rust does the HTTPS and streams raw bytes
// back over a Tauri Channel. Same bytes fetch() would have delivered.
async function nativeStream(
  url: string,
  headers: Record<string, string>,
  body: string | null,
  method?: string,
): Promise<ReadableStream<Uint8Array>> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const ch = new Channel<number[]>();
      ch.onmessage = (arr) => {
        try {
          controller.enqueue(new Uint8Array(arr));
        } catch { /* closed */ }
      };
      invoke<void>("direct_fetch", { url, headers, body, method, onChunk: ch }).then(
        () => {
          try {
            controller.close();
          } catch { /* ignore */ }
        },
        (e) => {
          try {
            controller.error(e);
          } catch { /* ignore */ }
        },
      );
    },
    cancel() {
      /* reader dropped (abort): rust side ends when its send fails */
    },
  });
}

async function nativeReader(
  url: string,
  headers: Record<string, string>,
  body: string | null,
  signal: AbortSignal | undefined,
  ev: DirectStreamEvents,
): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = (await nativeStream(url, headers, body)).getReader();
  } catch (e: any) {
    const err = e instanceof Error ? e : new Error(`direct chat: network error — ${e?.message ?? e}`);
    ev.onError?.(err);
    throw err;
  }
  signal?.addEventListener("abort", () => {
    try {
      reader.cancel();
    } catch { /* ignore */ }
  });
  return reader;
}

async function nativeText(url: string, headers: Record<string, string>): Promise<string> {
  const reader = (await nativeStream(url, headers, null, "GET")).getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const buf = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    buf.set(c, o);
    o += c.length;
  }
  return new TextDecoder().decode(buf);
}

/// POST a streaming chat completion. Calls back incrementally; resolves
/// with the full assistant message. Reasoning/thinking deltas
/// (reasoning_content, Anthropic thinking blocks) accumulate separately.
/** Anthropic native streaming (thinking blocks first-class). */
async function streamAnthropic(
  settings: DirectSettings,
  history: { role: string; content: string }[],
  ev: DirectStreamEvents,
  signal?: AbortSignal,
): Promise<DirectMessage> {
  const reader = await nativeReader(
    `${settings.baseUrl}/v1/messages`,
    {
      "content-type": "application/json",
      "x-api-key": settings.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
      ...sessionHeaders(settings, undefined),
    },
    JSON.stringify({
      model: settings.model,
      max_tokens: 8192,
      thinking: { type: "enabled", budget_tokens: 4000 },
      messages: history,
      stream: true,
    }),
    signal,
    ev,
  );
  const decoder = new TextDecoder();
  let buf = "";
  let evName = "";
  let content = "";
  let thinking = "";
  const flush = (chunk: string) => {
    buf += chunk;
    const parts = buf.split("\n\n");
    buf = parts.pop() ?? "";
    for (const part of parts) {
      for (const raw of part.split("\n")) {
        const line = raw.trim();
        if (line.startsWith("event:")) {
          evName = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          const data = line.slice(5).trim();
          if (evName !== "content_block_delta") continue;
          let j: any = null;
          try {
            j = JSON.parse(data);
          } catch {
            continue;
          }
          const d = j.delta ?? {};
          if (d.type === "thinking_delta" && typeof d.thinking === "string") {
            thinking += d.thinking;
            ev.onThinking?.(thinking);
          } else if (d.type === "text_delta" && typeof d.text === "string") {
            content += d.text;
            ev.onContent?.(content);
          }
        }
      }
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      flush(decoder.decode(value, { stream: true }));
    }
    flush(decoder.decode());
    signal?.throwIfAborted();
  } catch (e: any) {
    if ((e as any)?.name === "AbortError") throw e;
    const err = new Error(`direct chat: stream error — ${e.message ?? e}`);
    ev.onError?.(err);
    throw err;
  } finally {
    try {
      reader.releaseLock();
    } catch { /* ignore */ }
  }
  const msg: DirectMessage = { role: "assistant", content, at: Date.now() };
  if (thinking) msg.thinking = thinking;
  ev.onDone?.(msg);
  return msg;
}

/** Extra per-call options: sessionId rides along as x-opencode-session
 *  (opencode-go routes on it; other providers ignore unknown headers). */
export interface DirectCallOpts {
  sessionId?: string;
}

function sessionHeaders(settings: DirectSettings, sessionId?: string): Record<string, string> {
  const h: Record<string, string> = { authorization: `Bearer ${settings.apiKey}` };
  if (sessionId) h["x-opencode-session"] = sessionId;
  return h;
}

/** OpenAI Responses API: what opencode-go speaks for
 *  muse-spark. Text arrives as output_text.delta; reasoning content is
 *  encrypted server-side, so only its token count is visible. */
async function streamResponses(
  settings: DirectSettings,
  history: { role: string; content: string }[],
  ev: DirectStreamEvents,
  signal: AbortSignal | undefined,
  sessionId?: string,
): Promise<DirectMessage> {
  const reader = await nativeReader(
    `${settings.baseUrl}/responses`,
    {
      "content-type": "application/json",
      ...sessionHeaders(settings, sessionId),
    },
    JSON.stringify({
      model: settings.model,
      input: history.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
    }),
    signal,
    ev,
  );
  const decoder = new TextDecoder();
  let buf = "";
  let evName = "";
  let content = "";
  let thinking = "";
  let reasoningTokens = 0;
  const flush = (chunk: string) => {
    buf += chunk;
    const parts = buf.split("\n\n");
    buf = parts.pop() ?? "";
    for (const part of parts) {
      for (const raw of part.split("\n")) {
        const line = raw.trim();
        if (line.startsWith("event:")) {
          evName = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          const data = line.slice(5).trim();
          if (data === "[DONE]") continue;
          let j: any = null;
          try {
            j = JSON.parse(data);
          } catch {
            continue;
          }
          if (evName === "response.output_item.added" && j.item?.type === "reasoning") {
            // Reasoning started (content often encrypted: no text yet).
            // Nudge the UI so the stream doesn't look dead for 10s+.
            ev.onThinking?.(thinking);
          } else if (evName === "response.output_text.delta" && typeof j.delta === "string") {
            content += j.delta;
            ev.onContent?.(content);
          } else if (evName === "response.reasoning_summary_text.delta" && typeof j.delta === "string") {
            thinking += j.delta;
            ev.onThinking?.(thinking);
          } else if (evName === "response.completed") {
            const rt = j.response?.usage?.output_tokens_details?.reasoning_tokens;
            if (typeof rt === "number") reasoningTokens = rt;
          } else if (evName === "response.failed" || evName === "response.incomplete") {
            throw new Error(`direct chat: response ${evName.replace("response.", "")}`);
          }
        }
      }
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      flush(decoder.decode(value, { stream: true }));
    }
    flush(decoder.decode());
    signal?.throwIfAborted();
  } catch (e: any) {
    if ((e as any)?.name === "AbortError") throw e;
    if (/^direct chat/.test((e as any)?.message ?? "")) {
      ev.onError?.(e);
      throw e;
    }
    const err = new Error(`direct chat: stream error — ${e.message ?? e}`);
    ev.onError?.(err);
    throw err;
  } finally {
    try {
      reader.releaseLock();
    } catch { /* ignore */ }
  }
  const msg: DirectMessage = { role: "assistant", content, at: Date.now() };
  if (thinking) msg.thinking = thinking;
  else if (reasoningTokens > 0) msg.thinking = `(thought for ${reasoningTokens} tokens — reasoning is encrypted server-side)`;
  ev.onDone?.(msg);
  return msg;
}

export async function streamDirectChat(
  settings: DirectSettings,
  history: { role: string; content: string }[],
  ev: DirectStreamEvents,
  signal?: AbortSignal,
  opts?: DirectCallOpts,
): Promise<DirectMessage> {
  if (settings.preset === "anthropic") return streamAnthropic(settings, history, ev, signal);
  if (settings.preset === "responses") return streamResponses(settings, history, ev, signal, opts?.sessionId);
  const url = `${settings.baseUrl}/chat/completions`;
  const reader = await nativeReader(
    url,
    {
      "content-type": "application/json",
      ...sessionHeaders(settings, opts?.sessionId),
    },
    JSON.stringify({
      model: settings.model,
      messages: history,
      stream: true,
    }),
    signal,
    ev,
  );
  const decoder = new TextDecoder();
  let buf = "";
  let content = "";
  let thinking = "";
  const flush = (chunk: string) => {
    buf += chunk;
    const parts = buf.split("\n\n");
    buf = parts.pop() ?? "";
    for (const part of parts) {
      const lines = part.split("\n").map((l) => l.trim());
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        let j: any = null;
        try {
          j = JSON.parse(data);
        } catch {
          continue;
        }
        const delta = j.choices?.[0]?.delta ?? {};
        // Anthropic-native passthrough (some gateways forward it).
        if (delta.thinking && typeof delta.thinking === "string") {
          thinking += delta.thinking;
          ev.onThinking?.(thinking);
        }
        // OpenAI-compat reasoning (DeepSeek-R1, Qwen, o-series gateways).
        if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
          thinking += delta.reasoning_content;
          ev.onThinking?.(thinking);
        }
        if (typeof delta.content === "string" && delta.content) {
          content += delta.content;
          ev.onContent?.(content);
        }
      }
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      flush(decoder.decode(value, { stream: true }));
    }
    flush(decoder.decode());
    signal?.throwIfAborted();
  } catch (e: any) {
    if ((e as any)?.name === "AbortError") throw e;
    const err = new Error(`direct chat: stream error — ${e.message ?? e}`);
    ev.onError?.(err);
    throw err;
  } finally {
    try {
      reader.releaseLock();
    } catch { /* ignore */ }
  }
  const msg: DirectMessage = {
    role: "assistant",
    content,
    at: Date.now(),
  };
  if (thinking) msg.thinking = thinking;
  ev.onDone?.(msg);
  return msg;
}
