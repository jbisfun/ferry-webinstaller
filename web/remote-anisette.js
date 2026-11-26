// SideStore anisette v3 client (port of omnisette's remote_anisette_v3.rs).
// The server runs ADI; this side keeps the identity + adi.pb and talks to Apple
// during provisioning, so Apple never sees the server and the server never sees
// Apple's responses beyond spim/ptm/tk. `http` is injected (libcurl.js over the
// Wisp relay in the browser, since most servers and Apple send no CORS headers).
//   http.get(url, headers) / http.post(url, body, headers) -> Promise<Uint8Array>
//   storage.get(key) -> Promise<string|null>, storage.set(key, string)
import * as plist from "plist";

export const SERVER_LIST = "https://servers.sidestore.io/servers.json";
export const DEFAULT_SERVER = "https://mac-ani.jkcoxson.com";
const LOOKUP = "https://gsa.apple.com/grandslam/GsService2/lookup";
const LOOKUP_CLIENT_INFO = "<MacBookPro18,3> <Mac OS X;26.6;25F84> <com.apple.AuthKit/1 (com.apple.akd/1.0)>";
// GSA 503s logins carrying these; omnisette substitutes a current Mac.
const BLOCKED = [
  "<MacBookPro13,2> <macOS;13.1;22C65> <com.apple.AuthKit/1 (com.apple.akd/1.0)>",
  "<MacBookPro13,2> <macOS;13.1;22C65> <com.apple.AuthKit/1 (com.apple.dt.Xcode/3594.4.19)>",
  "<MacBookPro15,1> <Mac OS X;10.15.2;19C57> <com.apple.AuthKit/1 (com.apple.dt.Xcode/3594.4.19)>",
];
const CURRENT_MAC = LOOKUP_CLIENT_INFO;

const text = (bytes) => new TextDecoder().decode(bytes);
const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
const hexUpper = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
const appleTime = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");

function uuid(bytes) {
  const h = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`.toUpperCase();
}

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

export class RemoteAnisette {
  /** @param options {{ server?: string, http, storage, WebSocket? }} */
  constructor({ server = DEFAULT_SERVER, http, storage, WebSocket: WS = globalThis.WebSocket }) {
    this.server = server.trim().replace(/\/+$/, "");
    this.http = http;
    this.storage = storage;
    this.WebSocket = WS;
  }

  async state() {
    if (this._state) return this._state;
    const key = `anisette-v3:${this.server}`;
    const saved = await this.storage.get(key);
    let state = saved ? JSON.parse(saved) : null;
    if (!state) {
      state = { identifier: b64(crypto.getRandomValues(new Uint8Array(16))), adiPb: null };
      await this.storage.set(key, JSON.stringify(state));
    }
    this._state = state;
    this._key = key;
    return state;
  }

  async save() {
    await this.storage.set(this._key, JSON.stringify(this._state));
  }

  async clientInfo() {
    if (!this._clientInfo) {
      const info = JSON.parse(text(await this.http.get(`${this.server}/v3/client_info`, {})));
      if (BLOCKED.includes(info.client_info.trim())) info.client_info = CURRENT_MAC;
      this._clientInfo = info;
    }
    return this._clientInfo;
  }

  async identityHeaders(clientInfo) {
    const state = await this.state();
    const id = Uint8Array.from(atob(state.identifier), (c) => c.charCodeAt(0));
    return {
      "X-Mme-Client-Info": clientInfo,
      "User-Agent": (await this.clientInfo()).user_agent,
      "X-Apple-I-MD-LU": hexUpper(await sha256(id)),
      "X-Mme-Device-Id": uuid(id),
      "X-Apple-I-Client-Time": appleTime(),
      "X-Apple-I-TimeZone": "UTC",
      "X-Apple-Locale": "en_US",
    };
  }

  async provision() {
    const state = await this.state();
    const { client_info } = await this.clientInfo();
    const lookup = plist.parse(text(await this.http.get(LOOKUP, await this.identityHeaders(LOOKUP_CLIENT_INFO))));
    const start = lookup.urls.midStartProvisioning;
    const finish = lookup.urls.midFinishProvisioning;
    const apple = async (url, request) => {
      const headers = { ...(await this.identityHeaders(client_info)), "Content-Type": "text/x-xml-plist" };
      const reply = plist.parse(text(await this.http.post(url, plist.build({ Header: {}, Request: request }), headers)));
      const response = reply.Response ?? {};
      if (response.Status && response.Status.ec !== 0) {
        throw new Error(`Apple refused provisioning (${response.Status.ec}: ${response.Status.em})`);
      }
      return response;
    };

    const wsUrl = `${this.server}/v3/provisioning_session`.replace(/^http/, "ws");
    const ws = new this.WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const fail = (error) => {
        try { ws.close(); } catch {}
        reject(error instanceof Error ? error : new Error(`provisioning session: ${error?.message ?? "closed"}`));
      };
      ws.onerror = () => fail(new Error(`could not reach ${wsUrl}`));
      ws.onclose = () => fail(new Error("the anisette server closed the provisioning session"));
      ws.onmessage = async ({ data }) => {
        try {
          const message = JSON.parse(typeof data === "string" ? data : text(new Uint8Array(await data.arrayBuffer?.() ?? data)));
          const send = (value) => ws.send(JSON.stringify(value));
          switch (message.result) {
            case "GiveIdentifier":
              send({ identifier: state.identifier });
              break;
            case "GiveStartProvisioningData":
              send({ spim: (await apple(start, {})).spim });
              break;
            case "GiveEndProvisioningData": {
              const response = await apple(finish, { cpim: message.cpim });
              send({ ptm: response.ptm, tk: response.tk });
              break;
            }
            case "ProvisioningSuccess":
              state.adiPb = message.adi_pb;
              await this.save();
              ws.onclose = null;
              ws.close();
              resolve();
              break;
            default:
              fail(new Error(`anisette server: ${message.message ?? message.result}`));
          }
        } catch (error) {
          fail(error);
        }
      };
    });
  }

  /** Fresh anisette headers; provisions this browser with the server first if needed. */
  async headers() {
    const state = await this.state();
    if (!state.adiPb) await this.provision();
    const body = JSON.stringify({ identifier: state.identifier, adi_pb: state.adiPb });
    let reply = JSON.parse(text(await this.http.post(`${this.server}/v3/get_headers`, body, { "Content-Type": "application/json" })));
    if (reply.result === "GetHeadersError" && /-45061/.test(reply.message)) {
      state.adiPb = null;
      await this.provision();
      return this.headers();
    }
    if (reply.result !== "Headers") throw new Error(`anisette server: ${reply.message ?? reply.result}`);
    const { client_info } = await this.clientInfo();
    return {
      ...(await this.identityHeaders(client_info)),
      "X-Apple-I-MD": reply["X-Apple-I-MD"],
      "X-Apple-I-MD-M": reply["X-Apple-I-MD-M"],
      "X-Apple-I-MD-RINFO": String(reply["X-Apple-I-MD-RINFO"]),
    };
  }
}
