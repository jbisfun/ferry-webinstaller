// Packages the bundle (.build/browser/FerryWebInstaller) as an Isolated Web App, where
// libcurl reaches Apple and the anisette servers over Direct Sockets: no relay.
//
//   bun iwa.mjs prepare   -> .build/iwa/app (the IWA's files)
//   bun iwa.mjs serve     -> prepare, then serve it with the IWA headers on :8794, for
//                            Chromium's dev-mode proxy install
//   bun iwa.mjs bundle    -> prepare, then .build/iwa/ferry.swbn, signed with the key in
//                            ~/.config/ferry-webinstaller/iwa-key.pem (made on first use;
//                            the key fixes the app's isolated-app:// origin)
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
  const target = join(out, "ferry.swbn");
  writeFileSync(target, signed.getSignedWebBundleBytes());
  console.log(`signed bundle: ${target}\nweb bundle ID: ${signed.getWebBundleId()} (${origin})`);
}

const command = process.argv[2] ?? "serve";
if (command === "prepare") prepare();
else if (command === "serve") serve(Number(process.argv[3]) || 8794);
else if (command === "bundle") await bundle();
else throw new Error(`unknown command ${command}: prepare | serve | bundle`);
