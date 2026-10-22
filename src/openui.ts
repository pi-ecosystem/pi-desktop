// OpenUI GenUI: model emits an ```openui fence with openui-lang, rendered
// by Thesys's prebuilt browser bundle. React lives inside that bundle —
// our code stays vanilla. One dynamic import keeps it out of the main
// chunk until the first widget appears. md.ts placeholders → wireOpenUI.
declare global {
  interface Window {
    __OpenUI?: any;
  }
}

let bundlePromise: Promise<any> | null = null;

// NOTE: the bundle is vendored at public/openui/ (copied from
// @openuidev/browser-bundle dist) and loaded via plain script/link
// tags — vite cannot pre-bundle the IIFE. To update: copy the two
// dist files over and bump OPENUI_VERSION.
const OPENUI_VERSION = "0.2.1";

function loadBundle(): Promise<any> {
  if (!bundlePromise) {
    bundlePromise = new Promise((resolve, reject) => {
      try {
        // Our app is always dark; force C1 dark tokens instead of
        // depending on the OS/browser prefers-color-scheme media query.
        document.documentElement.dataset.openuiTheme = "dark";
        if (window.__OpenUI?.Renderer) {
          resolve(window.__OpenUI);
          return;
        }
        const cssHref = `/openui/openui-styles.css?v=${OPENUI_VERSION}`;
        if (!document.querySelector(`link[href^="/openui/openui-styles.css"]`)) {
          const link = document.createElement("link");
          link.rel = "stylesheet";
          link.href = cssHref;
          document.head.appendChild(link);
        }
        const src = `/openui/openui-bundle.min.js?v=${OPENUI_VERSION}`;
        const existing = document.querySelector<HTMLScriptElement>(`script[src^="/openui/openui-bundle.min.js"]`);
        if (existing) {
          existing.addEventListener("load", () => resolve(window.__OpenUI));
          existing.addEventListener("error", () => reject(new Error("script error")));
          return;
        }
        const s = document.createElement("script");
        s.src = src;
        s.onload = () => {
          const g = window.__OpenUI;
          if (g?.Renderer && g?.createRoot && g?.React && g?.openuiChatLibrary) resolve(g);
          else reject(new Error("bundle loaded but __OpenUI missing"));
        };
        s.onerror = () => reject(new Error("script error"));
        document.head.appendChild(s);
      } catch (e) {
        reject(e);
      }
    });
  }
  return bundlePromise;
}

export function openuiPlaceholder(code: string): string {
  const body = code.replace(/^\n+|\s+$/g, "");
  const esc = body
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return (
    `<div class="genui-openui" data-openui>` +
    `<script type="text/plain">${esc}</script>` +
    `<div class="genui-openui-body"><div class="genui-loading">rendering\u2026</div></div></div>`
  );
}

// <script> is a raw-text element: entities are NOT decoded by the parser,
// so reverse the escaping from openuiPlaceholder here.
function payloadOf(box: HTMLElement): string | null {
  const s = box.querySelector(":scope > script[type='text/plain']");
  const t = s?.textContent;
  if (typeof t !== "string") return null;
  return t
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function failBody(body: HTMLElement, msg: string, raw: string): void {
  body.innerHTML = "";
  const d = document.createElement("details");
  d.className = "genui-error";
  const sum = document.createElement("summary");
  sum.textContent = msg;
  d.appendChild(sum);
  const pre = document.createElement("pre");
  const code = document.createElement("code");
  code.textContent = raw.slice(0, 2000);
  pre.appendChild(code);
  d.appendChild(pre);
  body.appendChild(d);
}

export function wireOpenUI(container: HTMLElement): void {
  const boxes = container.querySelectorAll<HTMLElement>("[data-openui]");
  if (!boxes.length) return;
  void loadBundle()
    .then((g) => {
      boxes.forEach((box) => {
        if ((box as any)._openui || !box.isConnected) return;
        const body = box.querySelector(":scope > .genui-openui-body") as HTMLElement | null;
        const raw = payloadOf(box);
        if (!body || raw == null || !raw.trim()) return;
        (box as any)._openui = true;
        try {
          body.innerHTML = "";
          const root = g.createRoot(body);
          root.render(
            g.React.createElement(g.Renderer, {
              response: raw,
              library: g.openuiChatLibrary,
              onAction: (ev: any) => {
                window.dispatchEvent(new CustomEvent("pi-genui-submit", { detail: ev ?? {} }));
              },
            })
          );
        } catch {
          if (body.isConnected) failBody(body, "widget: could not render", raw);
        }
      });
    })
    .catch((err: any) => {
      boxes.forEach((box) => {
        if ((box as any)._openui || !box.isConnected) return;
        const body = box.querySelector(":scope > .genui-openui-body") as HTMLElement | null;
        if (!body) return;
        (box as any)._openui = true;
        body.innerHTML = "";
        const d = document.createElement("div");
        d.className = "genui-error";
        d.textContent = `widget: UI library failed to load (${err?.message ?? err})`;
        body.appendChild(d);
      });
    });
}
