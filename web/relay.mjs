// Wisp relay for libcurl.js: forwards raw TCP from the page to Apple and to the
// public anisette servers. TLS is end to end (inside the page), so this only sees
// ciphertext. Only port 443 on Apple hosts and on the servers in SideStore's list
// (fetched at startup) is allowed, so it isn't an open proxy.
//   bun web/relay.mjs [--host 127.0.0.1] [--port 6001]
import http from "node:http";
import { server as wisp, logging } from "@mercuryworkshop/wisp-js/server";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const host = arg("host", "127.0.0.1");
const port = Number(arg("port", "6001"));
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const allowed = [/(^|\.)apple\.com$/, /(^|\.)mzstatic\.com$/, /^servers\.sidestore\.io$/, /^mac-ani\.jkcoxson\.com$/];
try {
  const list = await (await fetch("https://servers.sidestore.io/servers.json")).json();
  for (const { address } of list.servers) {
    const url = new URL(address);
    if (url.protocol === "https:") allowed.push(new RegExp(`^${escape(url.hostname)}$`));
  }
} catch (error) {
  console.warn(`could not fetch SideStore's server list (${error.message}); only the default server is allowed`);
}

logging.set_level(logging.WARN);
wisp.options.hostname_whitelist = allowed;
wisp.options.port_whitelist = [443];
wisp.options.allow_udp_streams = false;

const httpServer = http.createServer((_, res) => {
  res.writeHead(426).end("wisp relay: connect with a websocket\n");
});
httpServer.on("upgrade", (req, socket, head) => wisp.routeRequest(req, socket, head));
httpServer.listen(port, host, () => console.log(`wisp relay on ws://${host}:${port}/`));
