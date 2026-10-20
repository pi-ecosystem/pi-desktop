// Compat shim — must evaluate before any other app module (import it first).
// Old Android WebViews (pre-Chrome-117) have no `Iterator` global at all.
// pdfjs probes Iterator.prototype at module eval, which throws and kills
// the entire bundle on those devices. Stub the shape it probes so its
// polyfill attaches harmlessly; nothing else uses Iterator.
const g = globalThis as Record<string, any>;
if (typeof g.Iterator === "undefined") {
  g.Iterator = function () {};
  g.Iterator.prototype = {};
}
