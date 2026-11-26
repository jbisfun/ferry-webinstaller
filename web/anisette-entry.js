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
globalThis.ferryAnisette = { anisette, curl, relayUrl, http, servers };
