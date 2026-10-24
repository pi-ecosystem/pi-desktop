// CodeMirror composer (option A prototype): plain-text markdown doc with a
// real maintained parser doing the highlighting — no hand-rolled regex, no
// overlay, no drift. The doc IS the markdown string, so send()/queue/cmds
// keep working on text exactly like before.
import { EditorState } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  keymap as cmKeymap,
  placeholder as cmPlaceholder,
  type KeyBinding,
} from "@codemirror/view";
import { history, historyKeymap, defaultKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";

let view: EditorView | null = null;

const appHighlight = HighlightStyle.define([
  { tag: tags.heading, fontWeight: "700" },
  { tag: tags.strong, fontWeight: "700" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  {
    tag: tags.monospace,
    fontFamily: "var(--mono, ui-monospace, monospace)",
    backgroundColor: "rgba(255,255,255,0.09)",
    borderRadius: "4px",
  },
  { tag: tags.link, color: "#9ecbff" },
  { tag: tags.url, color: "#9ecbff", textDecoration: "underline" },
  { tag: tags.quote, color: "var(--dim)" },
  { tag: tags.meta, color: "var(--dim)" },
]);

const appTheme = EditorView.theme({
  "&": { backgroundColor: "transparent" },
  ".cm-content": {
    fontFamily: "var(--sans)",
    fontSize: "14.5px",
    lineHeight: "22px",
    padding: "4px",
    caretColor: "var(--text)",
  },
  ".cm-cursor": { borderLeftColor: "var(--text)" },
  "&.cm-focused": { outline: "none" },
  ".cm-placeholder": { color: "#afafaf" },
  ".cm-selectionBackground": { backgroundColor: "rgba(122,162,247,0.35)" },
  "&.cm-focused .cm-selectionBackground": {
    backgroundColor: "rgba(122,162,247,0.35)",
  },
});

export interface ComposerHooks {
  onChange: () => void;
  onPaste: (files: FileList) => void;
  onDropFiles: (files: FileList) => void;
}

export function mountComposer(
  box: HTMLElement,
  extraKeys: KeyBinding[],
  hooks: ComposerHooks
): void {
  const start = EditorState.create({
    doc: "",
    extensions: [
      EditorView.lineWrapping,
      history(),
      drawSelection(),
      cmPlaceholder("Ask anything — type / for commands"),
      markdown(),
      syntaxHighlighting(appHighlight),
      appTheme,
      cmKeymap.of([...extraKeys, ...defaultKeymap, ...historyKeymap]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) {
          try {
            hooks.onChange();
          } catch {
            /* cosmetic */
          }
        }
      }),
      EditorView.domEventHandlers({
        paste(e) {
          const files = (e as ClipboardEvent).clipboardData?.files;
          if (files?.length) {
            try {
              hooks.onPaste(files);
            } catch {
              /* ignore */
            }
            return true; // handled: don't insert file names as text
          }
          return false;
        },
        // Files must be caught HERE at the editor: the #composer-level
        // drop listener runs at bubble phase (too late — CM's own drop
        // already inserted the file bytes as text). stopPropagation keeps
        // it from reaching #composer so files aren't added twice.
        drop(e) {
          const files = (e as DragEvent).dataTransfer?.files;
          if (files?.length) {
            e.stopPropagation();
            try {
              hooks.onDropFiles(files);
            } catch {
              /* ignore */
            }
            return true;
          }
          return false;
        },
      }),
    ],
  });
  view = new EditorView({ state: start, parent: box });
}

export function composerReady(): boolean {
  return view != null;
}

export function composerText(): string {
  try {
    return view?.state.doc.toString() ?? "";
  } catch {
    return "";
  }
}

export function setComposerText(s: string): void {
  if (!view) return;
  try {
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: s },
      selection: { anchor: s.length },
    });
    view.requestMeasure();
  } catch {
    /* ignore */
  }
}

export function composerCursor(): number {
  try {
    return view?.state.selection.main.head ?? 0;
  } catch {
    return 0;
  }
}

export function composerFocus(): void {
  try {
    view?.focus();
  } catch {
    /* ignore */
  }
}
