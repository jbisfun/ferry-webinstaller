# ferry-webinstaller

Install an `.ipa` on an iPhone or iPad from a web page. The interface is SwiftUI,
compiled to WebAssembly with [SwiftUIWeb](https://github.com/Vitorsilveira31/SwiftUIWeb)
(Embedded Swift, real DOM). The device is driven by [ios-webusb](../ios-webusb): usbmux,
lockdown, AFC and installation_proxy in wasm over WebUSB. Nothing runs natively.
Chromium-based browsers only (WebUSB).

```
Sources/FerryWebInstaller/   SwiftUI app (BrowserApp, @Observable Installer)
Resources/device-service.js  `device` page service wrapping the ios-webusb driver
Resources/ios-webusb/        driver build output (just driver; not committed)
```

Swift calls the driver through `BrowserService("device")`; results come back as JSON
and install progress as `progress` events. The IPA's bytes never cross into Swift.
Swift runs on the page's main thread (`Resources/config.js`) so the USB chooser and
the file picker keep the click's user activation.

## Build

Needs Swift 6.4 from swift.org with the matching WebAssembly SDK, bun, and Rust with
`wasm32-unknown-unknown` + `wasm-bindgen-cli` for the driver.

```sh
just dev     # debug build, served, reloads on save
just build   # static bundle in .build/browser/FerryWebInstaller
just run     # release bundle, served
```

Serve the bundle from the root of an origin over HTTPS (or localhost). On Linux the
browser needs the ios-webusb udev rule and usbmuxd out of the way; see its README.

The IPA must already be signed for the device; signing in the browser is not done yet.

## Anisette and the relay

Signing in to Apple needs anisette headers. They come from a public SideStore
anisette v3 server (default `https://mac-ani.jkcoxson.com`; any server from
`servers.sidestore.io/servers.json`, set with `localStorage.ferryAnisetteServer`).
The page keeps the identity and `adi.pb` in localStorage and talks to Apple itself
during provisioning, like SideStore does (`web/remote-anisette.js`, a port of
omnisette's v3 client).

Apple's servers and most anisette servers send no CORS headers, so HTTP goes
through [libcurl.js](https://github.com/ading2210/libcurl.js): TLS runs in the page
and only raw TCP crosses a [Wisp](https://github.com/MercuryWorkshop/wisp-protocol)
websocket relay. The relay sees ciphertext only and allows port 443 on Apple hosts
and the listed anisette servers.

```sh
bun web/relay.mjs                 # ws://127.0.0.1:6001/, used automatically on localhost
```

Deployed, serve it at `/wisp/` on the same origin, or point the page at one with
`localStorage.ferryRelay = "wss://..."`. libcurl.js is built from source with
Apple's root CAs added to its bundle (`gsa.apple.com` chains to Apple Root CA).
