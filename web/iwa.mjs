// Packages the bundle (.build/browser/FerryWebInstaller) as an Isolated Web App, where
// libcurl reaches Apple and the anisette servers over Direct Sockets: no relay.
//
//   bun iwa.mjs prepare   -> .build/iwa/app (the IWA's files)
//   bun iwa.mjs serve     -> prepare, then serve it with the IWA headers on :8794, for
//                            Chromium's dev-mode proxy install
//   bun iwa.mjs bundle    -> prepare, then .build/iwa/ferry.swbn, signed with the key in
//                            ~/.config/ferry-webinstaller/iwa-key.pem (made on first use;
//                            the key fixes the app's isolated-app:// origin), and the update
//                            manifest .build/iwa/update.json listing it
//   bun iwa.mjs publish   -> serve .build/iwa on :8795 (install from
//                            http://127.0.0.1:8795/update.json in chrome://iwa-dev)
//   bun iwa.mjs release   -> bundle for GitHub Pages and put update.json and the .swbn in
//                            docs/iwa/, which the wiki publishes at
//                            https://jbisfun.github.io/ferry-webinstaller/docs/iwa/
//
// IWA_UPDATE_BASE is where update.json and the .swbn files are published (default
// http://127.0.0.1:8795/): the app checks <base>update.json for new versions.
//
// The IWA runs under Chromium's fixed CSP (script-src 'self' 'wasm-unsafe-eval', base-uri
// 'none', Trusted Types required), so the page shell's inline scripts become files and its
// <base> and hash-based CSP go. Resources/config.js installs the Trusted Types policy.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import * as wbn from "wbn";
import * as wbnSign from "wbn-sign";

const root = resolve(import.meta.dir, "..");
const source = join(root, ".build/browser/FerryWebInstaller");
const out = join(root, ".build/iwa");
const app = join(out, "app");
export const PAGES_BASE = "https://jbisfun.github.io/ferry-webinstaller/docs/iwa/";
const command = process.argv[2] ?? "serve";
const updateBase = (process.env.IWA_UPDATE_BASE ?? (command === "release" ? PAGES_BASE : "http://127.0.0.1:8795/")).replace(/\/?$/, "/");
const version = JSON.parse(readFileSync(join(import.meta.dir, "package.json"), "utf8")).version ?? "0.1.0";

// What Chromium enforces on every IWA response; the dev server sends the same.
export const IWA_HEADERS = {
  "Content-Security-Policy":
    "base-uri 'none'; default-src 'self'; object-src 'none'; frame-src 'self' https: blob: data:; " +
    "connect-src 'self' https: wss: blob: data:; script-src 'self' 'wasm-unsafe-eval'; " +
    "img-src 'self' https: blob: data:; media-src 'self' https: blob: data:; font-src 'self' blob: data:; " +
    "style-src 'self' 'unsafe-inline'; require-trusted-types-for 'script';",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
};

const manifest = {
  name: "Ferry",
  short_name: "Ferry",
  description: "Sideload apps onto an iPhone or iPad from the browser.",
  id: "/",
  start_url: "/",
  scope: "/",
  display: "standalone",
  version,
  update_manifest_url: `${updateBase}update.json`,
  icons: [{ src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" }],
  permissions_policy: {
    "cross-origin-isolated": ["self"],
    "direct-sockets": ["self"],
    usb: ["self"],
  },
};

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

export function prepare() {
  if (!existsSync(join(source, "index.html"))) throw new Error(`no bundle at ${source}: run \`just build\` first`);
  rmSync(app, { recursive: true, force: true });
  mkdirSync(app, { recursive: true });
  // The precompressed copies are for the static server; the bundle carries one of each.
  cpSync(source, app, { recursive: true, filter: (path) => !/\.(br|gz)$/.test(path) });

  let html = readFileSync(join(app, "index.html"), "utf8");
  let n = 0;
  html = html
    .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>\s*/i, "")
    .replace(/<base [^>]*>\s*/i, "")
    .replace(/<script((?:\s+type="module")?)>([\s\S]*?)<\/script>/g, (_, type, body) => {
      const name = `iwa-inline-${n++}.js`;
      writeFileSync(join(app, name), body.trim() + "\n");
      return `<script${type} src="./${name}"></script>`;
    });
  if (/<script(?![^>]*\ssrc=)[^>]*>/.test(html)) throw new Error("an inline script is left in index.html");
  writeFileSync(join(app, "index.html"), html);

  mkdirSync(join(app, ".well-known"), { recursive: true });
  writeFileSync(join(app, ".well-known/manifest.webmanifest"), JSON.stringify(manifest, null, 2));
  mkdirSync(join(app, "icons"), { recursive: true });
  const font = execFileSync("fc-match", ["-f", "%{file}", "sans:bold"], { encoding: "utf8" }).trim();
  execFileSync("magick", [
    "-size", "512x512", "xc:none", "-fill", "#0a84ff", "-draw", "roundrectangle 0,0 511,511 112,112",
    "-fill", "white", "-font", font, "-pointsize", "300", "-gravity", "center", "-annotate", "+0+10", "F",
    join(app, "icons/icon-512.png"),
  ]);
  console.log(`IWA files: ${app} (${n} inline scripts moved to files)`);
  return app;
}

const TYPES = {
  html: "text/html; charset=utf-8", js: "text/javascript", mjs: "text/javascript", css: "text/css",
  wasm: "application/wasm", json: "application/json", webmanifest: "application/manifest+json",
  png: "image/png", svg: "image/svg+xml", txt: "text/plain",
};
const typeOf = (path) => TYPES[path.split(".").pop()] ?? "application/octet-stream";

function serve(port = 8794) {
  prepare();
  Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch(request) {
      let path = decodeURIComponent(new URL(request.url).pathname);
      if (path.endsWith("/")) path += "index.html";
      const file = join(app, path);
      if (!file.startsWith(app) || !existsSync(file) || statSync(file).isDirectory()) {
        return new Response("not found", { status: 404, headers: IWA_HEADERS });
      }
      return new Response(Bun.file(file), { headers: { ...IWA_HEADERS, "Content-Type": typeOf(file), "Cache-Control": "no-cache" } });
    },
  });
  console.log(`IWA dev server: http://127.0.0.1:${port}/ (install it with Chromium's dev-mode proxy)`);
}

function signingKey() {
  const path = join(homedir(), ".config/ferry-webinstaller/iwa-key.pem");
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    const { privateKey } = generateKeyPairSync("ed25519");
    writeFileSync(path, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    console.log(`new IWA signing key: ${path}`);
  }
  return wbnSign.parsePemKey(readFileSync(path, "utf8"));
}

async function bundle() {
  prepare();
  const key = signingKey();
  const origin = new wbnSign.WebBundleId(key).serializeWithIsolatedWebAppOrigin();
  const builder = new wbn.BundleBuilder();
  for (const file of walk(app)) {
    let path = "/" + relative(app, file).split("\\").join("/");
    if (path === "/index.html") path = "/";
    builder.addExchange(origin + path.slice(1), 200, { "Content-Type": typeOf(file), ...IWA_HEADERS }, new Uint8Array(readFileSync(file)));
  }
  const signed = await wbnSign.SignedWebBundle.fromWebBundle(builder.createBundle(), [new wbnSign.NodeCryptoSigningStrategy(key)]);
  const name = `ferry-${version}.swbn`;
  const target = join(out, name);
  writeFileSync(target, signed.getSignedWebBundleBytes());
  rmSync(join(out, "ferry.swbn"), { force: true });
  cpSync(target, join(out, "ferry.swbn"));
  // The update manifest the installed app polls (manifest.update_manifest_url).
  writeFileSync(join(out, "update.json"), JSON.stringify({ versions: [{ version, src: `${updateBase}${name}` }] }, null, 2) + "\n");
  console.log(`signed bundle: ${target}\nupdate manifest: ${join(out, "update.json")} (published at ${updateBase}update.json)\nweb bundle ID: ${signed.getWebBundleId()} (${origin})`);
}

function publish(port = 8795) {
  Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch(request) {
      const name = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, "");
      const file = join(out, name);
      if (!/^[\w.-]+\.(swbn|json)$/.test(name) || !existsSync(file)) return new Response("not found", { status: 404 });
      const type = name.endsWith(".json") ? "application/json" : "application/octet-stream";
      return new Response(Bun.file(file), { headers: { "Content-Type": type, "Cache-Control": "no-cache" } });
    },
  });
  console.log(`IWA updates: http://127.0.0.1:${port}/update.json`);
}

/** The published release: docs/iwa holds the update manifest and only the current bundle. */
async function release() {
  await bundle();
  const docs = join(root, "docs/iwa");
  mkdirSync(docs, { recursive: true });
  for (const name of readdirSync(docs)) if (name.endsWith(".swbn")) rmSync(join(docs, name));
  cpSync(join(out, `ferry-${version}.swbn`), join(docs, `ferry-${version}.swbn`));
  cpSync(join(out, "update.json"), join(docs, "update.json"));
  console.log(`release ${version}: ${docs} -> ${updateBase}update.json`);
}

if (command === "prepare") prepare();
else if (command === "serve") serve(Number(process.argv[3]) || 8794);
else if (command === "bundle") await bundle();
else if (command === "publish") publish(Number(process.argv[3]) || 8795);
else if (command === "release") await release();
else throw new Error(`unknown command ${command}: prepare | serve | bundle | publish | release`);
