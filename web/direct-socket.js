// libcurl.js transport over the Direct Sockets API (`TCPSocket`), for the Isolated Web
// App build: TLS still runs in libcurl's wasm, and its bytes go straight to the server
// over TCP, with no Wisp relay in between.
//
// libcurl.js constructs a custom transport the way it does a WebSocket
// (`new api.transport(url)`, url = "<websocket url>/<host>:<port>") and drives it
// through the WebSocket surface Emscripten's SOCKFS uses: readyState and its
// constants, onopen/onmessage/onclose/onerror, send and close.

/** Direct Sockets is only exposed to Isolated Web Apps that declare it. */
export const directSocketsAvailable = () =>
  typeof globalThis.TCPSocket === "function" && globalThis.crossOriginIsolated === true;

export class DirectSocketTransport extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  CONNECTING = 0;
  OPEN = 1;
  CLOSING = 2;
  CLOSED = 3;

  constructor(url) {
    super();
    this.url = url;
    this.binaryType = "arraybuffer";
    this.readyState = this.CONNECTING;
    this.bufferedAmount = 0;
    this.onopen = this.onmessage = this.onclose = this.onerror = null;

    const target = url.split("/").pop();
    const colon = target.lastIndexOf(":");
    this.host = target.slice(0, colon).replace(/^\[|\]$/g, "");
    this.port = Number(target.slice(colon + 1));
    this.writes = Promise.resolve();
    this.open();
  }

  emit(type, init = {}) {
    const event = type === "message" ? new MessageEvent("message", init) : new Event(type);
    this.dispatchEvent(event);
    this[`on${type}`]?.(event);
  }

  async open() {
    try {
      this.socket = new TCPSocket(this.host, this.port, { noDelay: true });
      const { readable, writable } = await this.socket.opened;
      this.writer = writable.getWriter();
      this.reader = readable.getReader();
    } catch (error) {
      console.error(`[ferry] TCP connection to ${this.host}:${this.port} failed`, error);
      this.readyState = this.CLOSED;
      this.emit("error");
      this.emit("close");
      return;
    }
    this.readyState = this.OPEN;
    this.emit("open");
    this.readLoop();
  }

  async readLoop() {
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        // A copy: SOCKFS keeps the buffer it is handed.
        this.emit("message", { data: value.slice().buffer });
      }
    } catch (error) {
      if (this.readyState === this.OPEN) {
        console.warn(`[ferry] TCP read from ${this.host}:${this.port} failed`, error);
        this.emit("error");
      }
    }
    this.finish();
  }

  send(data) {
    if (this.readyState !== this.OPEN) throw new DOMException("socket is not open", "InvalidStateError");
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data.slice(0)) : new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    this.bufferedAmount += bytes.byteLength;
    // Writes go out in order; a failed one closes the socket.
    this.writes = this.writes
      .then(() => this.writer.write(bytes))
      .then(() => { this.bufferedAmount -= bytes.byteLength; })
      .catch((error) => {
        console.warn(`[ferry] TCP write to ${this.host}:${this.port} failed`, error);
        this.emit("error");
        this.finish();
      });
  }

  close() {
    if (this.readyState >= this.CLOSING) return;
    this.readyState = this.CLOSING;
    this.reader?.cancel().catch(() => {});
    this.finish();
  }

  async finish() {
    if (this.readyState === this.CLOSED) return;
    this.readyState = this.CLOSED;
    try {
      await this.writes;
      this.reader?.releaseLock();
      this.writer?.releaseLock();
      await this.socket?.close();
    } catch {}
    this.emit("close");
  }
}
