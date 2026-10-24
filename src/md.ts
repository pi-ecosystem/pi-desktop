// Tiny markdown renderer: code fences (+copy, +highlight), headings, bold,
// inline code, links, images/video embeds, lists, quotes, paragraphs,
// tables. Pi decides content, this only displays it.
import { invoke } from "./tauri-shim";

// Browser dev mode has no system player to hand files to (the opener
// plugin is Tauri-only): video cards there play inline only.
const inTauri = typeof window !== "undefined" && "__TAURI__" in window;
//
// Media contract (desktop app concern): the agent figures out *how* to get
// pixels (ffmpeg screenshots, web search, local files) — this module only
// guarantees *rendering*. Supported embeds:
//   ![alt](https://.../pic.png)  -> <img>  (any image ext, or data:image/)
//   ![alt](https://.../clip.mp4) -> playable card opening the system
//     player (see VIDEO_FACADE: inline <video> crashes WebKitGTK where
//     GStreamer is broken, so we never emit a live <video> element).
//   youtube watch / youtu.be / shorts / live / embed -> click-to-play
//     youtube iframe card (no live iframe until clicked).
//   bare https://.../pic.png alone on a line -> auto-embed (same rules)
//   absolute local paths (/home/u/shot.png, file://..., ./rel.png)
//     render as <img data-local> and resolve via Tauri convertFileSrc at
//     wire time (needs setMediaBase(dir) for relative paths).
// Raw <img>/<video> HTML is sanitized down to src+alt+size+playback attrs.
import hljs from "highlight.js/lib/core";
import { openuiPlaceholder, wireOpenUI } from "./openui";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import shell from "highlight.js/lib/languages/shell";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

for (const [name, mod] of Object.entries({ bash, c, cpp, css, diff, go, java, javascript, json, markdown, python, rust, shell, typescript, xml, yaml })) {
  try {
    if (!hljs.getLanguage(name)) hljs.registerLanguage(name, mod as any);
  } catch { /* ignore */ }
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Long raw URLs as link text are the #1 blob-maker (amazon slugs wrapping
// 2 lines in blue). Display host + trimmed path, keep the full URL in
// href (+title on hover). Short/human link text passes through untouched.
function shortUrlDisplay(escapedUrl: string): string {
  const raw = escapedUrl.replace(/&amp;/g, "&");
  const hadExtra = /[?#]/.test(raw);
  // Query strings and hashes are tracking/session noise (?ie=UTF8&node=…):
  // the path already identifies the page. Display host+path only.
  let d = raw.replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[?#]/, 1)[0];
  // Search/filter pages live in the query string (?k=asus+vivobook…): a bare
  // stub path (amazon.in/s) alone says nothing, so hint that more follows.
  if (hadExtra && /^[^/]+\/[^/]{0,2}\/?$/.test(d)) d = d.replace(/\/?$/, "/") + "?\u2026";
  else if (d.length > 44) d = d.slice(0, 43) + "\u2026";
  return esc(d);
}
function linkTag(hrefEscaped: string, textEscaped: string): string {
  const rawText = textEscaped.replace(/&amp;/g, "&");
  const isUrl = /^https?:\/\//.test(rawText);
  const long = rawText.length > 44;
  const display = isUrl && long ? shortUrlDisplay(textEscaped) : textEscaped;
  const title = isUrl && long ? ` title="${hrefEscaped}"` : "";
  return `<a href="${hrefEscaped}" target="_blank" rel="noreferrer"${title}>${display}</a>`;
}

// ---- media embeds (images + video) ----

const IMAGE_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "avif",
]);
const VIDEO_EXTS = new Set(["mp4", "webm", "mov", "ogv", "m4v"]);

// Resolve-once media cache: one backend read per path per view, shared by
// every token re-render. Positive hits are ALSO inlined synchronously at
// render time (see mediaTag), so resolved images survive per-token
// innerHTML wipes without flicker. Cleared on run end / view switch — a
// regenerated file must re-read, never serve stale bytes. Entries carry
// the stat they were read at: same-path rewrites (agents iterating on a
// screenshot) revalidate via media_stat instead of trusting bytes forever.
interface MediaEntry {
  uri: string;
  mtimeMs: number;
  size: number;
}
const mediaResolved = new Map<string, MediaEntry>();
const mediaKey = (abs: string): string => `${mediaBase}\n${abs}`;
export function clearMediaCache(): void {
  mediaResolved.clear();
}
// Base dir for resolving relative local paths (main.ts sets this on cwd
// switch and session switch; without it relative paths fail gracefully to
// a caption + path fallback).
let mediaBase = "";
export function setMediaBase(dir: string): void {
  mediaBase = dir;
}

function extOf(src: string): string {
  const clean = src.split(/[?#]/, 1)[0].split("/").pop() ?? "";
  const dot = clean.lastIndexOf(".");
  if (dot < 0) return "";
  return clean.slice(dot + 1).toLowerCase();
}

// Allowlist: remote https/http, data:image|video, blob/asset/file schemes,
// absolute + relative local paths. Reject scriptable schemes and anything
// with whitespace/control chars or quote/bracket breakouts.
function safeMediaSrc(raw: string): string | null {
  const s = raw.trim();
  // Plain spaces are legitimate (local "my shot.png", <>-delimited
  // markdown): every emission site attribute-escapes, so they cannot
  // break out. Controls, quotes and angle brackets stay rejected.
  if (!s || /[<>"\t\n\r\f\v\u0000-\u001f\u007f]/.test(s)) return null;
  const lower = s.toLowerCase();
  if (
    lower.startsWith("javascript:") ||
    lower.startsWith("vbscript:") ||
    lower.startsWith("data:text/html") ||
    lower.startsWith("data:application")
  )
    return null;
  if (
    lower.startsWith("https://") ||
    lower.startsWith("http://") ||
    lower.startsWith("blob:") ||
    lower.startsWith("asset:") ||
    lower.startsWith("file://") ||
    lower.startsWith("data:image/") ||
    lower.startsWith("data:video/")
  ) {
    return s.length > 15_000_000 ? null : s;
  }
  const scheme = s.match(/^([a-zA-Z][a-zA-Z0-9+.\-]*):/);
  // Unknown scheme (ftp:, data:audio, …) — refuse rather than guess.
  if (scheme) return null;
  // Bare local path: /abs, ~/home, ./rel, ../rel, or dir/file.ext.
  return s.length > 2048 ? null : s;
}

function isLocalSrc(src: string): boolean {
  const lower = src.toLowerCase();
  return !(
    lower.startsWith("https://") ||
    lower.startsWith("http://") ||
    lower.startsWith("blob:") ||
    lower.startsWith("asset:") ||
    lower.startsWith("data:")
  );
}

function resolveLocal(src: string): string {
  let p = src;
  if (p.toLowerCase().startsWith("file://")) {
    try {
      p = decodeURI(p.replace(/^file:\/\//, ""));
    } catch {
      p = p.replace(/^file:\/\//, "");
    }
  }
  if (p.startsWith("~/")) return p; // no home expansion frontend-side; try as-is
  if (p.startsWith("/")) return p;
  if (mediaBase && (p.startsWith("./") || p.startsWith("../") || !p.includes(":"))) {
    const base = mediaBase.replace(/\/+$/, "");
    const rel = p.replace(/^\.\//, "");
    // Keep ../ segments: convertFileSrc/the OS sorts them out.
    return `${base}/${rel}`;
  }
  return p;
}

function isVideoSrc(src: string): boolean {
  if (src.toLowerCase().startsWith("data:video/")) return true;
  return VIDEO_EXTS.has(extOf(src));
}

function mediaTag(alt: string, src: string): string {
  const safe = safeMediaSrc(src);
  if (!safe) return `<span>${esc(alt || src)}</span>`;
  const a = esc(alt);
  const u = esc(safe);
  const yt = youTubeId(safe);
  if (yt) return youTubeFacade(a || "YouTube video", yt.id, yt.start, null);
  // Local files start with NO src attribute: the raw path is not a valid
  // URL and the browser would fire `error` (→ fallback) before read_media
  // resolves. src is set only once real bytes arrive (see wireMedia).
  // Remote files load directly, src up front.
  if (isLocalSrc(safe)) {
    // Sync fast-path: an already-resolved file inlines its bytes, so the
    // image survives per-token stream re-renders with zero flicker.
    // data-fast lets wireMedia revalidate the stat behind the bytes:
    // a same-path rewrite lands on the next pass instead of never.
    const fast = mediaResolved.get(mediaKey(resolveLocal(src)));
    if (fast) {
      const cap = a ? `<figcaption>${a}</figcaption>` : "";
      return `<figure class="media"><img loading="lazy" alt="${a}" src="${fast.uri}" data-fast="${esc(src)}">${cap}</figure>`;
    }
    // Unresolved: shimmer placeholder (CSS) until bytes land — never a
    // premature failure verdict. wireMedia clears `loading` on settle.
    const cap = a ? `<figcaption>${a}</figcaption>` : "";
    return (
      `<figure class="media loading"><img loading="lazy" alt="${a}" data-local="${u}">` +
      `${cap}</figure>`
    );
  }
  const cap = a ? `<figcaption>${a}</figcaption>` : "";
  return `<figure class="media"><img loading="lazy" referrerpolicy="no-referrer" src="${u}" alt="${a}">${cap}</figure>`;
}

function fileName(src: string): string {
  try {
    const clean = src.split(/[?#]/, 1)[0].replace(/\/+$/, "");
    const base = clean.split("/").pop() ?? clean;
    return base || src;
  } catch {
    return src;
  }
}

// YouTube: watch / youtu.be / shorts / live / embed URLs can't play in
// <video> — they need an iframe. Render time holds a click-to-load card
// (same facade policy as VIDEO_FACADE: no live iframe until the user
// clicks), then playYouTubeCard swaps in a youtube embed (standard host:
// nocookie embeds get Error 153 under the app's custom URL scheme).
function youTubeId(src: string): { id: string; start: number } | null {
  let u: URL;
  try {
    u = new URL(src);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const okHost =
    host === "youtube.com" ||
    host === "m.youtube.com" ||
    host === "youtu.be" ||
    host === "youtube-nocookie.com" ||
    host === "www.youtube-nocookie.com";
  if (!okHost) return null;
  const valid = (s: string | null): s is string => !!s && /^[A-Za-z0-9_-]{11}$/.test(s);
  let id: string | null = null;
  if (host === "youtu.be") {
    id = u.pathname.split("/").filter(Boolean)[0] ?? null;
  } else {
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts[0] === "watch") id = u.searchParams.get("v");
    else if (parts[0] === "embed" || parts[0] === "shorts" || parts[0] === "live" || parts[0] === "v") id = parts[1] ?? null;
  }
  if (!valid(id)) return null;
  // Start time: ?t=1h2m3s / ?t=90 / ?start=90.
  let start = 0;
  const raw = u.searchParams.get("t") ?? u.searchParams.get("start");
  if (raw) {
    if (/^\d+$/.test(raw)) start = parseInt(raw, 10);
    else {
      const m = raw.match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/);
      if (m) start = (parseInt(m[1] ?? "0", 10) || 0) * 3600 + (parseInt(m[2] ?? "0", 10) || 0) * 60 + (parseInt(m[3] ?? "0", 10) || 0);
    }
  }
  return { id, start: start > 0 ? start : 0 };
}

function youTubeFacade(caption: string, id: string, start: number, poster: string | null = null): string {
  // True-16:9 thumbnail with hqdefault fallback (not all videos have
  // maxres). onerror is our own markup, not agent input — safe inline.
  const thumb = poster && !isLocalSrc(esc(poster))
    ? `<span class="media-thumb" aria-hidden="true"><img alt="" loading="lazy" referrerpolicy="no-referrer" src="${esc(poster)}"></span>`
    : `<span class="media-thumb" aria-hidden="true"><img alt="" loading="lazy" referrerpolicy="no-referrer" src="https://i.ytimg.com/vi/${id}/maxresdefault.jpg" onerror="this.onerror=null;this.src='https://i.ytimg.com/vi/${id}/hqdefault.jpg'"></span>`;
  const localPoster = poster && isLocalSrc(poster) ? ` data-poster-local="${esc(poster)}"` : "";
  return (
    `<button class="media-card has-poster yt" data-yt="${id}" data-start="${start}"${localPoster} title="Play YouTube video">` +
    `${thumb}` +
    `<span class="media-play" aria-hidden="true">\u25B6</span><span class="media-name">${caption}</span>` +
    `<span class="media-hint">youtube \u00B7 click to play</span></button>`
  );
}

function sanitizeYouTubeIframe(full: string): string | null {
  const open = full.match(/^<iframe\b[^>]*>/i)?.[0] ?? "";
  if (!open) return null;
  const raw = attrVal(open, "src");
  if (!raw) return null;
  const safe = safeMediaSrc(raw);
  if (!safe) return null;
  const yt = youTubeId(safe);
  if (!yt) return null;
  const label = esc(attrVal(open, "title") ?? "YouTube video");
  return youTubeFacade(label, yt.id, yt.start, null);
}

// VIDEO_FACADE: render time never contains a live <video> element — it
// starts life as a click-to-open card. On systems with broken GStreamer
// even one <video> (any preload, even a valid file) SIGABRTs the
// WebKitWebProcess (reproduced in isolation before gst-plugins-good was
// installed: 0 img + 1 video = CRASHED, 12 img + 0 video = alive). The
// pipeline only spins up on explicit user click (playVideoCard), when a
// crash would at worst follow a deliberate gesture instead of a scroll.
function videoFacade(caption: string, src: string, poster: string | null = null): string {
  const u = esc(src);
  const local = isLocalSrc(src) ? ` data-local-path="${u}"` : "";
  const play = `<span class="media-play" aria-hidden="true">\u25B6</span>`;
  // Explicit posters only (`[![cap](frame.jpg)](clip.mp4)`): no filename
  // guessing. Remote posters load directly; local ones resolve async via
  // data-poster-local (see wireMedia) and the slot stays empty meanwhile.
  let thumb = `<span class="media-thumb" aria-hidden="true"></span>`;
  let cls = "media-card";
  if (poster) {
    const p = esc(poster);
    if (isLocalSrc(poster)) {
      thumb = `<span class="media-thumb" aria-hidden="true" data-poster-local="${p}"></span>`;
    } else {
      thumb = `<span class="media-thumb" aria-hidden="true"><img alt="" src="${p}"></span>`;
      cls = "media-card has-poster";
    }
  }
  return (
    `<button class="${cls}" data-open="${u}"${local} title="Play video">` +
    `${thumb}` +
    `${play}<span class="media-name">${caption}</span>` +
    `<span class="media-hint">video \u00B7 click to play</span></button>`
  );
}

// Explicit local posters (`[![cap](./f.jpg)](./c.mp4)`): one read, bytes
// in, thumbnail on. No poster or failed read -> plain card, untouched.
function wireVideoPosters(container: HTMLElement): void {
  container.querySelectorAll<HTMLElement>(".media-thumb[data-poster-local]").forEach((thumb) => {
    if ((thumb as any)._poster) return;
    (thumb as any)._poster = true;
    const raw = thumb.getAttribute("data-poster-local") ?? "";
    const card = thumb.closest("button.media-card");
    if (!raw || !card) return;
    toAssetUrl(resolveLocal(raw)).then((url) => {
      if (!url || !thumb.isConnected) return;
      const img = document.createElement("img");
      img.alt = "";
      img.addEventListener("error", () => {
        img.remove();
        card.classList.remove("has-poster");
      });
      img.addEventListener("load", mediaSettled, { once: true });
      img.src = url;
      thumb.appendChild(img);
      card.classList.add("has-poster");
    });
  });
}

// `[![alt](poster)](target)`: explicit thumbnail syntax (no filename
// coupling). Video target -> poster card; anything else -> linked image.
// Placeholders keep the URLs inside safe from later linkification.
function linkedMedia(alt: string, posterInner: string, targetInner: string): string {
  const posterSrc = firstToken(posterInner);
  const targetSrc = firstToken(targetInner);
  const safePoster = posterSrc ? safeMediaSrc(posterSrc) : null;
  const safeTarget = targetSrc ? safeMediaSrc(targetSrc) : null;
  if (!safeTarget) return esc(`[![${alt}](${posterInner})](${targetInner})`);
  const ytTarget = youTubeId(safeTarget);
  if (ytTarget) {
    const label = esc(alt) || "YouTube video";
    return youTubeFacade(label, ytTarget.id, ytTarget.start, safePoster);
  }
  if (isVideoSrc(safeTarget)) {
    const label = esc(alt) || esc(fileName(safeTarget));
    return videoFacade(label, safeTarget, safePoster);
  }
  // Linked image: poster (or alt text if the poster is unusable).
  if (!safePoster) return esc(`[![${alt}](${posterInner})](${targetInner})`);
  const a = esc(alt);
  const t = esc(safeTarget);
  const p = esc(safePoster);
  const localUnresolved =
    isLocalSrc(safePoster) &&
    !mediaResolved.has(mediaKey(resolveLocal(safePoster)));
  const fcls = localUnresolved ? "media loading" : "media";
  const img = (() => {
    if (!isLocalSrc(safePoster)) return `<img loading="lazy" referrerpolicy="no-referrer" src="${p}" alt="${a}">`;
    const fast = mediaResolved.get(mediaKey(resolveLocal(safePoster)));
    if (fast) return `<img loading="lazy" src="${fast.uri}" alt="${a}" data-fast="${esc(firstToken(posterInner))}">`;
    return `<img loading="lazy" alt="${a}" data-local="${p}">`;
  })();
  return `<a href="${t}" target="_blank" rel="noreferrer"><figure class="${fcls}">${img}${a ? `<figcaption>${a}</figcaption>` : ""}</figure></a>`;
}

// Inline parsing runs on ALREADY-escaped HTML (esc() first), so the
// documented `<>` / `"..."` URL forms arrive entity-encoded. Decode
// before tokenizing, or paths with spaces can never resolve.
function unescEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

// First whitespace-separated token of a `![alt](...)` inner, unbracketed
// (`<a b.png>`, `"a b.png"`, or bare). Shared with parseImageToken.
function firstToken(inner: string): string {
  let rest = unescEntities(inner.trim());
  if (rest.startsWith("<")) {
    const end = rest.indexOf(">");
    return end < 0 ? "" : rest.slice(1, end);
  }
  const m = rest.match(/^("[^\"]+"|'[^']+'|\S+)/);
  if (!m) return "";
  let src = m[1];
  if ((src.startsWith('"') && src.endsWith('"')) || (src.startsWith("'") && src.endsWith("'"))) {
    src = src.slice(1, -1);
  }
  return src;
}
function parseImageToken(alt: string, inner: string): string {
  let rest = unescEntities(inner.trim());
  let src = "";
  if (rest.startsWith("<")) {
    const end = rest.indexOf(">");
    if (end < 0) return esc(`![${alt}](${inner})`);
    src = rest.slice(1, end);
    rest = rest.slice(end + 1).trim();
  } else {
    const m = rest.match(/^("[^\"]+"|'[^']+'|\S+)/);
    if (!m) return esc(`![${alt}](${inner})`);
    src = m[1];
    rest = rest.slice(m[1].length).trim();
    if ((src.startsWith('"') && src.endsWith('"')) || (src.startsWith("'") && src.endsWith("'"))) {
      src = src.slice(1, -1);
    }
  }
  void rest; // trailing title is accepted and ignored; alt is the caption.
  return mediaTag(alt, src);
}

function attrVal(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>"']+))`, "i"));
  if (!m) return null;
  return m[2] ?? m[3] ?? m[4] ?? null;
}

// Sanitize one raw <img ...> tag down to src/alt/width/height. Null = drop.
function sanitizeImg(tag: string): string | null {
  const raw = attrVal(tag, "src");
  if (!raw) return null;
  const safe = safeMediaSrc(raw);
  if (!safe) return null;
  const alt = esc(attrVal(tag, "alt") ?? "");
  const dim = (n: string): string => {
    const v = attrVal(tag, n);
    return v && /^\d{1,4}$/.test(v) ? ` ${n}="${v}"` : "";
  };
  const u = esc(safe);
  // No src up front for local files (see mediaTag: raw paths would error
  // before bytes arrive) — unless already resolved (sync fast-path, no
  // flicker on stream re-renders). Remote keeps src for direct loading.
  const srcAttr = (() => {
    if (!isLocalSrc(safe)) return { cls: "media", attr: ` src="${u}"` };
    const fast = mediaResolved.get(mediaKey(resolveLocal(safe)));
    if (fast) return { cls: "media", attr: ` src="${fast.uri}" data-fast="${u}"` };
    return { cls: "media loading", attr: ` data-local="${u}"` };
  })();
  return `<figure class="${srcAttr.cls}"><img loading="lazy" referrerpolicy="no-referrer"${srcAttr.attr} alt="${alt}"${dim("width")}${dim("height")}>${alt ? `<figcaption>${alt}</figcaption>` : ""}</figure>`;
}

// Sanitize one raw <video ...>...</video> (or self-closing) tag into a
// click-to-open card (never a live <video>: see VIDEO_FACADE). Null = drop.
function sanitizeVideo(full: string): string | null {
  const open = full.match(/^<video\b[^>]*>/i)?.[0] ?? "";
  const raw = attrVal(open || full, "src") ?? attrVal(full, "src");
  // <source> children: keep the first safe one as the video src.
  let src: string | null = raw ? safeMediaSrc(raw) : null;
  if (!src) {
    const sm = full.match(/<source\b[^>]*>/i)?.[0];
    const sraw = sm ? attrVal(sm, "src") : null;
    src = sraw ? safeMediaSrc(sraw) : null;
  }
  if (!src) return null;
  const label = esc(attrVal(open || full, "title") ?? fileName(src));
  return videoFacade(label, src);
}

function inline(s: string): string {
  // Raw <img>/<video> HTML is sanitized to placeholders BEFORE escaping so
  // legitimate embeds survive esc() while everything else stays escaped.
  const mediaHolders: string[] = [];
  let t = s
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe\s*>/gi, (m) => {
      const ok = sanitizeYouTubeIframe(m);
      if (!ok) return m; // non-YouTube iframe: leave for esc()
      mediaHolders.push(ok);
      return `\u0005${mediaHolders.length - 1}\u0006`;
    })
    .replace(/<video\b[^>]*>[\s\S]*?<\/video\s*>/gi, (m) => {
      const ok = sanitizeVideo(m);
      if (!ok) return m; // leave for esc(); renders as harmless text
      mediaHolders.push(ok);
      return `\u0005${mediaHolders.length - 1}\u0006`;
    })
    .replace(/<video\b[^>]*\/?>/gi, (m) => {
      const ok = sanitizeVideo(m);
      if (!ok) return m;
      mediaHolders.push(ok);
      return `\u0005${mediaHolders.length - 1}\u0006`;
    })
    .replace(/<img\b[^>]*\/?>/gi, (m) => {
      const ok = sanitizeImg(m);
      if (!ok) return m;
      mediaHolders.push(ok);
      return `\u0005${mediaHolders.length - 1}\u0006`;
    });
  let h = esc(t);
  h = h.replace(/`([^`]+)`/g, "\u0001$1\u0002");
  // Linked thumbnails `[![cap](poster)](clip.mp4)` come before plain
  // images AND plain links (they look like both). Video targets become
  // poster cards; other targets become linked image figures.
  h = h.replace(/\[!\[([^\]]*)\]\(([^)]+)\)\]\(([^)]+)\)/g, (_m, alt, posterInner, targetInner) =>
    `\u0005${(() => {
      mediaHolders.push(linkedMedia(alt, posterInner, targetInner));
      return mediaHolders.length - 1;
    })()}\u0006`
  );
  // ![alt](src) embeds (images AND video-by-extension) come before link
  // matching, otherwise the [alt](src) half would be eaten as a plain link.
  // Placeholders (\u0005) are restored at the end, so captions inside them
  // are never re-processed.
  h = h.replace(/!\[([^\]]*)\]\(([^)]*?(?:\([^)]*\)[^)]*?)*)\)/g, (_m, alt, inner) =>
    `\u0005${(() => {
      mediaHolders.push(parseImageToken(alt, inner));
      return mediaHolders.length - 1;
    })()}\u0006`
  );
  // Bold may contain single-asterisk italics: lazy span + trailing-star guard
  // so `**a *b* c**` (italic-close + bold-close `***`) resolves correctly.
  h = h.replace(/\*\*([\s\S]+?)\*\*(?!\*)/g, "<strong>$1</strong>");
  h = h.replace(/(^|[^*\w])\*([^\s*][^*\n]*?)\*(?![*\w])/g, "$1<em>$2</em>");
  // Link URLs may contain balanced parens (Wikipedia…): match one level
  // instead of stopping at the first `)`.
  h = h.replace(/\[([^\]]+)\]\((https?:[^()\s]*(?:\([^)]*\)[^()\s]*)*)\)/g, (_m, text, url) => linkTag(url, text));
  // Bare URLs → links, but never inside code spans, existing anchors, or
  // already-built media figures (their src="..." must not be linkified).
  h = h.split(/(\u0001[\s\S]*?\u0002|\u0005\d+\u0006|<a\b.*?<\/a>|<figure\b.*?<\/figure>)/g).map((part) => {
    if (
      part.startsWith("\u0001") ||
      part.startsWith("\u0005") ||
      part.startsWith("<a") ||
      part.startsWith("<figure")
    )
      return part;
    return part.replace(/(https?:\/\/[^\s<\]\\)]+)/g, (url) => {
      const m = url.match(/^(.*?)([.,;:!?)\]]+)$/);
      const clean = m ? m[1] : url;
      const trail = m ? m[2] : "";
      return `${linkTag(clean, clean)}${trail}`;
    });
  }).join("");
  h = h.replace(/\u0001([\s\S]*?)\u0002/g, "<code>$1</code>");
  h = h.replace(/\u0005(\d+)\u0006/g, (_m, n) => mediaHolders[Number(n)] ?? "");
  return h;
}

// A paragraph that IS just one URL to a media file embeds it instead of
// showing a bare link. Mid-sentence URLs stay links (see inline()).
export function bareMediaLine(text: string): string | null {
  const t = text.trim();
  const m = t.match(/^(https?:\/\/[^\s<>"\]]+)$/);
  if (!m) return null;
  let url = m[1].replace(/[.,;:!?)\]]+$/, "");
  if (!url) return null;
  if (!safeMediaSrc(url)) return null;
  const yt = youTubeId(url);
  if (yt) return mediaTag("", url);
  const ext = extOf(url);
  if (!IMAGE_EXTS.has(ext) && !VIDEO_EXTS.has(ext)) return null;
  return mediaTag("", url);
}

export function renderMd(src: string): string {
  try {
    return renderMdInner(src);
  } catch {
    // A single hostile message must never blank the transcript.
    return `<pre>${esc(src.slice(0, 4000))}</pre>`;
  }
}

function renderMdInner(src: string): string {
  const out: string[] = [];
  const lines = src.split("\n");
  let i = 0;
  let inList = false;
  const closeList = () => {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  };
  let inOl = false;
  const closeOl = () => {
    if (inOl) {
      out.push("</ol>");
      inOl = false;
    }
  };
  while (i < lines.length) {
    const line = lines[i];
    // Language ids are not all \w (c++, c#, f# …): accept anything up
    // to whitespace, unknown ids still fall back to plaintext below.
    const fence = line.match(/^```([^\s`]*)\s*$/);
    if (fence) {
      closeList();
      closeOl();
      const lang = fence[1];
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        buf.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      // OpenUI fence renders as a live widget, not code (see openui.ts).
      const gl = (lang || "").toLowerCase();
      if (gl === "openui" || gl === "openui-lang" || gl === "genui") {
        out.push(openuiPlaceholder(buf.join("\n")));
        continue;
      }
      const known = lang && hljs.getLanguage(lang) ? lang : "plaintext";
      out.push(
        `<div class="codeblock"><div class="codehead"><span>${esc(lang || "code")}</span>` +
          `<button class="copybtn" data-copy="${esc(buf.join("\n"))}">copy</button></div>` +
          `<pre><code class="language-${known}">${esc(buf.join("\n"))}</code></pre></div>`
      );
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeList();
      closeOl();
      out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
      i++;
      continue;
    }
    // Markdown tables: header row + |---|---| separator.
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      closeList();
      closeOl();
      // Split on pipes, but respect code spans: `a | b` is one cell.
      const splitRow = (r: string): string[] => {
        const cells: string[] = [];
        let cur = "";
        let inCode = false;
        const body = r.trim().replace(/^\||\|$/g, "");
        for (let i = 0; i < body.length; i++) {
          const ch = body[i];
          if (ch === "`") inCode = !inCode;
          if (ch === "|" && !inCode) {
            cells.push(inline(cur.trim()));
            cur = "";
          } else {
            cur += ch;
          }
        }
        cells.push(inline(cur.trim()));
        return cells;
      };
      const head = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      out.push(
        "<table><thead><tr>" +
          head.map((c) => `<th>${c}</th>`).join("") +
          "</tr></thead><tbody>" +
          rows.map((r) => "<tr>" + r.map((c) => `<td>${c}</td>`).join("") + "</tr>").join("") +
          "</tbody></table>"
      );
      continue;
    }
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ol) {
      closeList();
      if (!inOl) {
        out.push("<ol>");
        inOl = true;
      }
      out.push(`<li>${inline(ol[1])}</li>`);
      i++;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      closeOl();
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${inline(line.replace(/^\s*[-*]\s+/, ""))}</li>`);
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      closeList();
      closeOl();
      out.push(`<blockquote>${inline(line.replace(/^\s*>\s?/, ""))}</blockquote>`);
      i++;
      continue;
    }
    if (line.trim() === "") {
      closeList();
      closeOl();
      i++;
      continue;
    }
    closeList();
    closeOl();
    // paragraph: gather until blank. A lone media URL becomes an embed.
    // A lone `Label:` line (plain or **bold**, e.g. `You'll like it if you
    // like:`) is a section header, not body — peel it into <p class="sect">
    // so it gets header styling even when the model skips bold. Applies to
    // a solo label para AND a label leading a multi-line para.
    const buf = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== "" && !lines[i].startsWith("```")) {
      buf.push(lines[i]);
      i++;
    }
    const isLabelLine = (s: string): boolean => {
      // Accept plain `Label:` and **bold** `**Label:**` / `**Label**:`.
      let t = s.trim();
      const bm = t.match(/^\*\*([\s\S]+?)\*\*:?$/);
      if (bm) t = `${bm[1].trim().replace(/:+$/, "")}:`;
      if (!/^.{2,80}:$/.test(t)) return false;
      if (t.includes("://") || t.includes("::")) return false; // URLs, times
      return !/[.!?]/.test(t.slice(0, -1)); // no sentence inside
    };
    if (buf.length === 1 && isLabelLine(buf[0])) {
      const bare = bareMediaLine(buf[0]);
      out.push(bare ?? `<p class="sect">${inline(buf[0].trim())}</p>`);
      continue;
    }
    if (buf.length > 1 && isLabelLine(buf[0])) {
      out.push(`<p class="sect">${inline(buf[0].trim())}</p>`);
      const rest = buf.slice(1).join("\n");
      const bare = bareMediaLine(rest);
      out.push(bare ?? `<p>${inline(rest)}</p>`);
      continue;
    }
    const bare = bareMediaLine(buf.join("\n"));
    out.push(bare ?? `<p>${inline(buf.join("\n"))}</p>`);
  }
  closeList();
  closeOl();
  return out.join("\n");
}

// Copy buttons use data-copy; call once per container. Also paints syntax
// highlighting on fenced blocks (github-dark palette, see styles.css),
// resolves local media paths via Tauri, adds load-error fallbacks, and
// click-to-open-full for images.
export function wireCopy(container: HTMLElement): void {
  wireMedia(container);
  // OpenUI widgets mount here (bundle lazy-loads on first fence).
  // A bad spec must never break the transcript.
  try { wireOpenUI(container); } catch { /* ignore */ }
  container.querySelectorAll<HTMLElement>("pre code[class*='language-']").forEach((c) => {
    if ((c as any)._hl) return;
    (c as any)._hl = true;
    try {
      hljs.highlightElement(c as HTMLElement);
    } catch { /* unknown language: leave plain */ }
  });
  container.querySelectorAll<HTMLButtonElement>("button.copybtn").forEach((b) => {
    if ((b as any)._wired) return;
    (b as any)._wired = true;
    b.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(b.dataset.copy ?? "");
        b.textContent = "copied";
        setTimeout(() => (b.textContent = "copy"), 1200);
      } catch {
        b.textContent = "failed";
      }
    });
  });
}

// ---- media wiring (local paths, errors, click-to-open) ----

async function openExternal(url: string): Promise<void> {
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
    return;
  } catch {
    /* opener missing or refused: fall through to window.open */
  }
  try {
    window.open(url, "_blank", "noopener");
  } catch {
    /* ignore */
  }
}

// Local videos open in the system player directly off disk (no asset-URL
// round-trip: the external player couldn't reach our WebView's server).
// Full-bleed lightbox: click any chat image to inspect it big. Wheel /
// buttons zoom (0.5-5x), drag pans while zoomed, double-click toggles,
// Esc / backdrop / x closes. External-open stays as a button inside.
// One instance: opening replaces any existing overlay.
function closeLightbox(): void {
  document.querySelector(".lightbox")?.remove();
  document.removeEventListener("keydown", lightboxKeys, true);
}
function lightboxKeys(e: KeyboardEvent): void {
  if (e.key === "Escape") {
    e.stopPropagation();
    e.preventDefault();
    closeLightbox();
  }
}
export function openLightbox(src: string, alt: string): void {
  closeLightbox();
  const ov = document.createElement("div");
  ov.className = "lightbox";
  ov.tabIndex = -1;
  const back = document.createElement("div");
  back.className = "lb-back";
  back.addEventListener("click", closeLightbox);
  const fig = document.createElement("figure");
  fig.className = "lb-fig";
  const img = document.createElement("img");
  img.alt = alt;
  fig.appendChild(img);
  if (alt) {
    const cap = document.createElement("figcaption");
    cap.textContent = alt;
    fig.appendChild(cap);
  }
  const bar = document.createElement("div");
  bar.className = "lb-bar";
  let scale = 1;
  let tx = 0;
  let ty = 0;
  const apply = (): void => {
    img.style.transform = "scale(" + scale + ") translate(" + tx / scale + "px, " + ty / scale + "px)";
    img.style.cursor = scale > 1 ? "grab" : "zoom-in";
  };
  const zoomBy = (f: number): void => {
    scale = Math.min(5, Math.max(0.5, scale * f));
    if (scale === 1) {
      tx = 0;
      ty = 0;
    }
    apply();
  };
  const mk = (label: string, title: string, fn: () => void): HTMLButtonElement => {
    const b = document.createElement("button");
    b.className = "lb-btn";
    b.textContent = label;
    b.title = title;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      fn();
    });
    return b;
  };
  bar.appendChild(mk("-", "Zoom out", () => zoomBy(1 / 1.25)));
  bar.appendChild(mk("+", "Zoom in", () => zoomBy(1.25)));
  bar.appendChild(mk("1:1", "Reset zoom", () => {
    scale = 1;
    tx = 0;
    ty = 0;
    apply();
  }));
  bar.appendChild(mk("open", "Open externally", () => openExternal(src).catch(() => {})));
  bar.appendChild(mk("x", "Close", closeLightbox));
  ov.appendChild(back);
  ov.appendChild(fig);
  ov.appendChild(bar);
  // Wheel over the figure zooms (passive false: suppress page scroll).
  fig.addEventListener("wheel", (e) => {
    e.preventDefault();
    zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15);
  }, { passive: false });
  img.addEventListener("dblclick", () => zoomBy(scale > 1.2 ? 1 / scale : 2.2));
  // Pan while zoomed: drag the image itself.
  let drag: { x: number; y: number } | null = null;
  img.addEventListener("pointerdown", (e) => {
    if (scale <= 1) return;
    drag = { x: e.clientX - tx, y: e.clientY - ty };
    try {
      img.setPointerCapture(e.pointerId);
    } catch { /* ignore */ }
    img.style.cursor = "grabbing";
  });
  img.addEventListener("pointermove", (e) => {
    if (!drag) return;
    tx = e.clientX - drag.x;
    ty = e.clientY - drag.y;
    apply();
  });
  const endDrag = (): void => {
    drag = null;
    if (scale > 1) img.style.cursor = "grab";
  };
  img.addEventListener("pointerup", endDrag);
  img.addEventListener("pointercancel", endDrag);
  document.addEventListener("keydown", lightboxKeys, true);
  document.body.appendChild(ov);
  img.src = src;
  apply();
  ov.focus();
}
async function openLocalPath(abs: string, fallbackUrl: string): Promise<void> {
  try {
    const { openPath } = await import("@tauri-apps/plugin-opener");
    await openPath(abs);
    return;
  } catch {
    /* not on disk from this machine (browser dev) or refused */
  }
  if (/^https?:\/\//i.test(fallbackUrl)) return openExternal(fallbackUrl);
}

async function mediaStat(localPath: string): Promise<{ mtimeMs: number; size: number } | null> {
  try {
    const r = await invoke<{ mtimeMs: number; size: number } | null>("media_stat", {
      path: localPath,
      base: mediaBase || null,
    });
    if (r && typeof r.mtimeMs === "number" && typeof r.size === "number") return r;
    return null;
  } catch {
    return null; // old backend without media_stat: callers treat as unknown
  }
}

async function toAssetUrl(localPath: string, revalidate = false): Promise<string | null> {
  // Local files ride over plain invoke as data: URIs (see read_media).
  // Resolve-once per stat: every token re-render shares one backend read
  // while the file is unchanged; a same-path rewrite re-reads instead of
  // serving stale bytes forever (see the data-fast loop in wireMedia).
  const key = mediaKey(localPath);
  const hit = mediaResolved.get(key);
  if (hit && !revalidate) return hit.uri;
  const same = async (): Promise<boolean> => {
    if (!hit) return false;
    const st = await mediaStat(localPath);
    if (!st) return true; // unknown: keep showing rather than flashing
    return st.mtimeMs === hit.mtimeMs && st.size === hit.size;
  };
  try {
    if (revalidate && (await same())) return (mediaResolved.get(key) as MediaEntry).uri;
    const r = await invoke<{ mime: string; base64: string; mtimeMs?: number; size?: number }>("read_media", {
      path: localPath,
      base: mediaBase || null,
    });
    if (r?.mime && r?.base64) {
      const uri = `data:${r.mime};base64,${r.base64}`;
      const st = await mediaStat(localPath);
      mediaResolved.set(key, {
        uri,
        mtimeMs: r.mtimeMs ?? st?.mtimeMs ?? 0,
        size: r.size ?? st?.size ?? 0,
      });
      return uri;
    }
    return hit?.uri ?? null; // read failed: keep stale bytes over a break
  } catch {
    return hit?.uri ?? null;
  }
}

// Failed loads degrade to a caption + path/URL line instead of a broken
// icon: the reference is never silently lost.
function mediaFallback(fig: HTMLElement, label: string): void {
  if (fig.dataset.fbk) return;
  fig.dataset.fbk = "1";
  fig.classList.add("broken");
  fig.classList.remove("loading");
  const safe = esc(label.slice(0, 300));
  const isHttp = /^https?:\/\//i.test(label);
  fig.innerHTML =
    `<div class="media-fallback"><span>could not load media</span>` +
    (isHttp
      ? `<a href="${safe}" target="_blank" rel="noreferrer">${safe}</a>`
      : `<code>${safe}</code>`) +
    `</div>`;
}

// Broadcast when any media settles (bytes in, poster on, player sized).
// Followers (sessions window) re-pin only if the user never scrolled up.
function mediaSettled(): void {
  try {
    window.dispatchEvent(new CustomEvent("pi-media-settled"));
  } catch { /* ignore */ }
}

function wireMedia(container: HTMLElement): void {
  // (Settle notifications go through module-level mediaSettled.)
  // Local files (-> data: URIs via read_media, Tauri or browser dev).
  // Each element resolves once.
  container
    .querySelectorAll<HTMLElement>("img[data-local]")
    .forEach((m) => {
      const el = m as HTMLImageElement | HTMLVideoElement;
      if ((el as any)._loc) return;
      (el as any)._loc = true;
      const raw = el.getAttribute("data-local") ?? "";
      const fig = el.closest("figure") as HTMLElement | null;
      if (!raw) {
        if (fig) mediaFallback(fig, el.getAttribute("src") ?? "media");
        return;
      }
      const abs = resolveLocal(raw);
      // No src attribute yet (see mediaTag), so no premature error event.
      // Retry twice with backoff before the terminal verdict: a busy
      // backend fails transiently, and the shimmer covers the wait.
      const attempt = (): void => {
        const tries = (((el as any)._tries ?? 0) + 1) as number;
        (el as any)._tries = tries;
        toAssetUrl(abs).then((url) => {
          if (!el.isConnected) return;
          if (url) {
            fig?.classList.remove("loading");
            el.setAttribute("src", url);
            el.removeAttribute("data-local");
            el.addEventListener("load", mediaSettled, { once: true });
            // Click-to-lightbox lives in the figure loop below, but that
            // loop skips data-local images (marked _wired) — attach here
            // on resolve, or local images never pop up.
            el.addEventListener("click", () => {
              const src = (el as HTMLImageElement).currentSrc || el.getAttribute("src") || "";
              if (src) openLightbox(src, el.getAttribute("alt") ?? "");
            });
          } else if (tries < 3) {
            setTimeout(() => {
              if (el.isConnected && el.hasAttribute("data-local")) attempt();
            }, 1000 * tries);
          } else if (fig) {
            mediaFallback(fig, raw);
          }
        });
      };
      attempt();
    });
  // Fast-pathed images (bytes inlined at render): revalidate the stat
  // behind them once per wiring. A same-path rewrite swaps the src in
  // place — no shimmer, and no flicker when unchanged (toAssetUrl
  // returns the identical URI and the write is skipped).
  container
    .querySelectorAll<HTMLImageElement>("img[data-fast]")
    .forEach((img) => {
      if ((img as any)._fastCk) return;
      (img as any)._fastCk = true;
      const raw = img.getAttribute("data-fast") ?? "";
      if (!raw) return;
      const abs = resolveLocal(raw);
      void toAssetUrl(abs, true).then((url) => {
        if (!url || !img.isConnected) return;
        if (img.getAttribute("src") !== url) {
          img.setAttribute("src", url);
          mediaSettled();
        }
      });
    });
  // Remote images: error fallback + click-to-open-full. Local files
  // still carrying data-local are owned by the resolver above: an img
  // with no src is *always* complete+naturalWidth-0, so the check below
  // would instantly condemn every pending local image. Skip those.
  container.querySelectorAll<HTMLImageElement>("figure.media > img").forEach((img) => {
    if ((img as any)._wired) return;
    (img as any)._wired = true;
    if (img.hasAttribute("data-local")) return;
    const fig = img.closest("figure") as HTMLElement | null;
    img.addEventListener("error", () => {
      if (fig) mediaFallback(fig, img.getAttribute("src") ?? "image");
    });
    // Remote images load natively (no read step): follow their completion
    // too, otherwise late bytes strand the viewport mid-answer.
    // Cached images may already be complete before we attach: check
    // synchronously, or the settle (and autoscroll pin) never fires.
    // Complete-but-broken (error fired pre-listener) falls back directly.
    if (img.complete) {
      if (img.naturalWidth > 0) mediaSettled();
      else if (fig) mediaFallback(fig, img.getAttribute("src") ?? "image");
    } else if (!img.currentSrc && img.getAttribute("src")) {
      img.addEventListener("load", mediaSettled, { once: true });
    }
    img.addEventListener("click", () => {
      const src = img.currentSrc || img.getAttribute("src") || "";
      if (src) openLightbox(src, img.getAttribute("alt") ?? "");
    });
  });
  // Video cards: click plays inline (pipeline starts on user gesture
  // only — never at render time, see VIDEO_FACADE). Posters resolve
  // alongside, wherever the sidecar exists.
  wireVideoPosters(container);
  container.querySelectorAll<HTMLButtonElement>("button.media-card").forEach((b) => {
    if ((b as any)._wired) return;
    (b as any)._wired = true;
    if (b.hasAttribute("data-yt")) b.addEventListener("click", () => playYouTubeCard(b));
    else b.addEventListener("click", () => playVideoCard(b));
  });
}

function cardFallback(b: HTMLButtonElement, label: string): void {
  const div = document.createElement("div");
  div.className = "media-fallback";
  const s = document.createElement("span");
  s.textContent = "could not load video";
  div.appendChild(s);
  if (/^https?:\/\//i.test(label)) {
    const a = document.createElement("a");
    a.href = label;
    a.target = "_blank";
    a.rel = "noreferrer";
    a.textContent = label.slice(0, 300);
    div.appendChild(a);
  } else {
    const c = document.createElement("code");
    c.textContent = label.slice(0, 300);
    div.appendChild(c);
  }
  b.replaceWith(div);
}

function playYouTubeCard(b: HTMLButtonElement): void {
  const id = b.getAttribute("data-yt") ?? "";
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) {
    cardFallback(b, "YouTube video");
    return;
  }
  const start = parseInt(b.getAttribute("data-start") ?? "0", 10) || 0;
  const caption = b.querySelector(".media-name")?.textContent ?? "YouTube video";
  const row = document.createElement("div");
  row.className = "media-row";
  const fig = document.createElement("figure");
  fig.className = "media";
  const wrap = document.createElement("div");
  wrap.className = "yt-wrap";
  const f = document.createElement("iframe");
  f.src = `https://www.youtube.com/embed/${id}?autoplay=1&rel=0${start > 0 ? `&start=${start}` : ""}`;
  f.title = caption.slice(0, 200);
  f.allow = "accelerometer; autoplay; encrypted-media; picture-in-picture";
  (f as any).allowFullscreen = true;
  f.setAttribute("allowfullscreen", "");
  f.setAttribute("frameborder", "0");
  f.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
  f.addEventListener("load", mediaSettled, { once: true });
  wrap.appendChild(f);
  fig.appendChild(wrap);
  if (caption) {
    const c = document.createElement("figcaption");
    c.textContent = caption;
    fig.appendChild(c);
  }
  row.appendChild(fig);
  b.replaceWith(row);
}

function playVideoCard(b: HTMLButtonElement): void {
  const open = b.getAttribute("data-open") ?? "";
  const local = b.getAttribute("data-local-path");
  const caption = b.querySelector(".media-name")?.textContent ?? "video";
  // Build with DOM properties (never innerHTML): caption/src are untrusted.
  const finish = (playSrc: string, extPath: string | null, extUrl: string | null) => {
    const row = document.createElement("div");
    row.className = "media-row";
    const fig = document.createElement("figure");
    fig.className = "media";
    const v = document.createElement("video");
    v.controls = true;
    v.autoplay = true;
    v.preload = "metadata";
    (v as any).playsInline = true;
    v.src = playSrc;
    v.addEventListener("loadedmetadata", mediaSettled, { once: true });
    v.addEventListener("error", () => mediaFallback(fig, open || caption));
    fig.appendChild(v);
    if (caption) {
      const c = document.createElement("figcaption");
      c.textContent = caption;
      fig.appendChild(c);
    }
    row.appendChild(fig);
    // Local files open in the system player only under Tauri; in browser
    // dev the button would silently do nothing, so omit it there.
    if (extUrl || (extPath && inTauri)) {
      const x = document.createElement("button");
      x.className = "media-ext";
      x.textContent = "open in player \u2197";
      x.addEventListener("click", () => {
        if (extPath) openLocalPath(extPath, extUrl ?? "").catch(() => {});
        else if (extUrl) openExternal(extUrl).catch(() => {});
      });
      row.appendChild(x);
    }
    b.replaceWith(row);
  };
  if (local) {
    const abs = resolveLocal(local);
    // Data-URI inline play; the HTTP backend serves read_media so this works
    // in browser dev too. System player stays one click away regardless.
    toAssetUrl(abs).then((url) => {
      if (url) finish(url, abs, null);
      else cardFallback(b, local);
    });
    return;
  }
  if (open) {
    finish(open, null, open);
    return;
  }
  cardFallback(b, caption);
}
