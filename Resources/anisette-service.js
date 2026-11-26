// The `anisette` page service: anisette headers from a public SideStore v3 server,
// via libcurl.js over the Wisp relay (web/anisette-entry.js -> anisette.js, ~2 MB),
// which is only fetched on the first call.
(globalThis.SwiftUIWebServices ??= { queue: [], define(name, factory) { this.queue.push([name, factory]); } })
  .define("anisette", async (context) => (await import("./anisette.js")).service(context));
