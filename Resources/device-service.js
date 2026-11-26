// The `device` page service behind Swift's `BrowserService("device")`: the ios-webusb
// driver (rusbmux + idevice in wasm, ../ios-webusb) owning the iPhone through WebUSB.
// Results are JSON strings; the chosen IPA's bytes stay on this side.
(globalThis.SwiftUIWebServices ??= { queue: [], define(name, factory) { this.queue.push([name, factory]); } })
  .define("device", async ({ emit }) => {
    const driver = await import("./ios-webusb/ios_webusb_web.js");
    // Named here so the bundle's content hashing rewrites the path (the glue's own
    // `new URL(..._bg.wasm)` is left alone).
    await driver.default({ module_or_path: new URL("./ios-webusb/ios_webusb_web_bg.wasm", import.meta.url) });

    // This page is one host: one SystemBUID, one pair record per device.
    const buid = (localStorage.buid ??= crypto.randomUUID().toUpperCase());
    const fromBase64 = (text) => text && Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
    const toBase64 = (bytes) => {
      let text = "";
      for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(text);
    };

    let device = null;
    let ipa = null;

    const summary = async () => {
      const value = (key) => device.getValue(key).catch(() => null);
      return JSON.stringify({
        udid: device.udid,
        name: (await value("DeviceName")) ?? "iPhone",
        model: (await value("ProductType")) ?? "",
        version: (await value("ProductVersion")) ?? "",
      });
    };

    const pair = async () => {
      const key = `pair:${device.udid}`;
      const created = await device.pair(fromBase64(localStorage[key]), buid);
      if (created) localStorage[key] = toBase64(created);
    };

    const pickFile = () =>
      new Promise((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".ipa,application/octet-stream";
        input.onchange = () => resolve(input.files[0] ?? null);
        input.oncancel = () => resolve(null);
        input.click();
      });

    return {
      // A device granted to this origin before, without prompting; "" if none.
      async restore() {
        if (!device) [device] = await driver.IosDevice.authorized();
        if (!device) return "";
        await pair();
        return summary();
      },

      // The browser's USB chooser, then pairing ("Trust This Computer?" on first use).
      async connect() {
        const found = await driver.IosDevice.request();
        if (!found) return "";
        await device?.close().catch(() => {});
        device = found;
        await pair();
        return summary();
      },

      async disconnect() {
        await device?.close().catch(() => {});
        device = null;
      },

      async pickIpa() {
        const file = await pickFile();
        if (!file) return "";
        const bytes = new Uint8Array(await file.arrayBuffer());
        const info = driver.inspectIpa(bytes);
        ipa = bytes;
        return JSON.stringify({
          file: file.name,
          name: info.CFBundleDisplayName ?? info.CFBundleName ?? file.name,
          bundleId: info.CFBundleIdentifier,
          version: info.CFBundleShortVersionString ?? info.CFBundleVersion ?? "",
          size: bytes.length,
        });
      },

      async install() {
        if (!device) throw new Error("no device");
        if (!ipa) throw new Error("no ipa");
        await device.install(ipa, (stage, percent) => emit("progress", JSON.stringify({ stage, percent })));
      },

      async apps() {
        if (!device) return "[]";
        const apps = await device.apps("User");
        const list = Object.entries(apps).map(([bundleId, info]) => ({
          bundleId,
          name: info.CFBundleDisplayName ?? info.CFBundleName ?? bundleId,
          version: info.CFBundleShortVersionString ?? info.CFBundleVersion ?? "",
        }));
        list.sort((a, b) => a.name.localeCompare(b.name));
        return JSON.stringify(list);
      },
    };
  });
