// Run Swift on the page's main thread: the WebUSB chooser and the file picker need the
// click's user activation, which a call forwarded from a worker may no longer carry.
globalThis.__renderWorker = false;

// The Isolated Web App build runs with `require-trusted-types-for 'script'`; SwiftUIWeb
// writes markup with innerHTML. A pass-through default policy keeps that working (script
// sources are still limited to the app's own files by script-src 'self').
if (globalThis.trustedTypes && !trustedTypes.defaultPolicy) {
  trustedTypes.createPolicy("default", { createHTML: (html) => html, createScriptURL: (url) => url });
}
