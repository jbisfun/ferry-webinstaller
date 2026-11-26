// Anisette for the `anisette` page service (Swift's `BrowserService("anisette")`),
// from a public SideStore anisette v3 server. Requests to the server and to Apple go
// through libcurl.js: TLS runs here in wasm and reaches the network as raw TCP over
// the Wisp relay (relay.mjs), because neither sends CORS headers. The provisioning
// websocket goes straight to the server (websockets aren't subject to CORS).
// libcurl.js built from source with Apple Root CA + G3 in its CA bundle (see vendor/README.md).
import { libcurl } from "./vendor/libcurl_full.mjs";
import { RemoteAnisette, DEFAULT_SERVER, SERVER_LIST } from "./remote-anisette.js";

export function relayUrl() {
  if (localStorage.ferryRelay) return localStorage.ferryRelay;
  if (["localhost", "127.0.0.1"].includes(location.hostname)) return "ws://127.0.0.1:6001/";
  return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/wisp/`;
}

let curlReady;
export function curl() {
  curlReady ??= (async () => {
    libcurl.set_websocket(relayUrl());
    await libcurl.load_wasm();
    return libcurl;
  })();
  return curlReady;
}

async function curlFetch(url, init = {}) {
  const lib = await curl();
  const response = await lib.fetch(url, init);
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${url}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

// Chromium won't put User-Agent on a fetch Request, so the shim adds the one that
// belongs to the request's X-Mme-Client-Info (Apple checks that they match).
const userAgents = new Map();
let serverUserAgent = null;

/** Registers the User-Agent to send with requests carrying `clientInfo`. */
export function registerUserAgent(clientInfo, userAgent) {
  userAgents.set(clientInfo, userAgent);
}

/**
 * Routes the page's cross-origin `fetch` through libcurl.js, so code that only knows
 * `fetch` (isideload's reqwest in the ios-webusb wasm) can talk to Apple and the
 * anisette server. Same-origin requests use the browser as usual.
 *
 * Chromium strips User-Agent from Request objects, and GrandSlam wants the one that
 * matches the client info, so the shim adds it back: registered pairs
 * (registerUserAgent) and the anisette server's own /v3/client_info reply.
 */
export function installRelayFetch() {
  if (globalThis.fetch.ferryRelay) return;
  const browserFetch = globalThis.fetch.bind(globalThis);
  const relayed = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === location.origin || url.protocol !== "https:") return browserFetch(input, init);
    const headers = Object.fromEntries(request.headers);
    const clientInfo = headers["x-mme-client-info"];
    if (clientInfo && !headers["user-agent"]) {
      const userAgent = userAgents.get(clientInfo) ?? serverUserAgent;
      if (userAgent) headers["user-agent"] = userAgent;
    }
    const hasBody = !["GET", "HEAD"].includes(request.method);
    const body = hasBody ? new Uint8Array(await request.arrayBuffer()) : undefined;
    const lib = await curl();
    const response = await lib.fetch(request.url, { method: request.method, headers, body, redirect: request.redirect });
    const bytes = await response.arrayBuffer();
    if (url.pathname.endsWith("/v3/client_info") && response.ok) {
      try {
        const info = JSON.parse(new TextDecoder().decode(bytes));
        if (info.client_info && info.user_agent) userAgents.set(info.client_info, info.user_agent);
        serverUserAgent = info.user_agent ?? serverUserAgent;
      } catch {}
    }
    // libcurl hands back the decoded body; don't let anyone decode it twice.
    const responseHeaders = new Headers(response.headers);
    responseHeaders.delete("content-encoding");
    responseHeaders.delete("content-length");
    const rebuilt = new Response(response.status === 204 || response.status === 304 ? null : bytes, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
    // A constructed Response has url "", and reqwest parses it.
    Object.defineProperty(rebuilt, "url", { value: response.url || request.url });
    return rebuilt;
  };
  relayed.ferryRelay = true;
  globalThis.fetch = relayed;
}

export const http = {
  get: (url, headers) => curlFetch(url, { method: "GET", headers }),
  post: (url, body, headers) => curlFetch(url, { method: "POST", body, headers }),
};

const storage = {
  get: async (key) => localStorage.getItem(`ferry:${key}`),
  set: async (key, value) => localStorage.setItem(`ferry:${key}`, value),
};

export const server = () => (localStorage.ferryAnisetteServer || DEFAULT_SERVER).replace(/\/+$/, "");

let instance;
export function anisette() {
  if (instance?.server !== server()) instance = new RemoteAnisette({ server: server(), http, storage });
  return instance;
}

/** Public servers from SideStore's list. */
export async function servers() {
  return JSON.parse(new TextDecoder().decode(await http.get(SERVER_LIST, {}))).servers;
}

/** The service's methods (Resources/anisette-service.js loads this lazily). */
export function service() {
  return {
    relay: () => relayUrl(),
    setRelay(url) {
      if (url) localStorage.ferryRelay = url;
      else delete localStorage.ferryRelay;
    },
    server: () => server(),
    setServer(url) {
      if (url) localStorage.ferryAnisetteServer = url;
      else delete localStorage.ferryAnisetteServer;
    },
    servers: async () => JSON.stringify(await servers()),
    // Provisions with the server on first use and returns fresh headers as JSON.
    headers: async () => JSON.stringify(await anisette().headers()),
  };
}

// For the page console and tests.
globalThis.ferryAnisette = { anisette, curl, relayUrl, http, servers, installRelayFetch, registerUserAgent };
