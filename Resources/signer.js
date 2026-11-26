// IPA signing in the browser: apple-codesign compiled with Emscripten
// (sign/ -> signer/ferry_sign.{mjs,wasm}). Pure computation; nothing leaves the page.
//
//   const signer = await Signer.load();
//   signer.inspect(ipa)  -> [{ path, bundleId, name, version, extension, entitlements }]
//   signer.sign(ipa, { keyPem, certDer, bundles: { "": { bundleId, profile }, "PlugIns/X.appex": {...} },
//                      removeUnconfiguredExtensions })  -> signed IPA bytes
// `profile` is the embedded.mobileprovision (Uint8Array); the bundle is signed with its
// Entitlements unless `entitlements` (XML plist string) is given.
import createModule from "./signer/ferry_sign.mjs";

const b64 = (bytes) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

export class Signer {
  static async load(moduleOverrides = {}) {
    return new Signer(await createModule(moduleOverrides));
  }

  constructor(m) {
    this.m = m;
  }

  #in(bytes) {
    const ptr = this.m._malloc(Math.max(bytes.length, 1));
    this.m.HEAPU8.set(bytes, ptr);
    return ptr;
  }

  #call(fn, inputs) {
    const ptrs = inputs.map((bytes) => this.#in(bytes));
    const out = this.m._malloc(8); // FerryBuf { u8 *ptr; size_t len }
    try {
      const args = inputs.flatMap((bytes, i) => [ptrs[i], bytes.length]);
      if (fn(...args, out) !== 0) {
        const buf = this.m._malloc(4096);
        this.m._ferry_last_error(buf, 4096);
        const message = this.m.UTF8ToString(buf);
        this.m._free(buf);
        throw new Error(message);
      }
      const ptr = this.m.HEAPU32[out >> 2];
      const len = this.m.HEAPU32[(out >> 2) + 1];
      const result = this.m.HEAPU8.slice(ptr, ptr + len);
      this.m._ferry_buf_free(out);
      return result;
    } finally {
      ptrs.forEach((p) => this.m._free(p));
      this.m._free(out);
    }
  }

  inspect(ipa) {
    return JSON.parse(new TextDecoder().decode(this.#call(this.m._ferry_inspect, [ipa])));
  }

  sign(ipa, { keyPem, certDer, bundles = {}, removeUnconfiguredExtensions = false }) {
    const config = {
      removeUnconfiguredExtensions,
      bundles: Object.fromEntries(
        Object.entries(bundles).map(([path, b]) => [
          path,
          { bundleId: b.bundleId, entitlements: b.entitlements, profile: b.profile && b64(b.profile) },
        ]),
      ),
    };
    const enc = new TextEncoder();
    const key = typeof keyPem === "string" ? enc.encode(keyPem) : keyPem;
    return this.#call(this.m._ferry_sign, [ipa, key, certDer, enc.encode(JSON.stringify(config))]);
  }
}
