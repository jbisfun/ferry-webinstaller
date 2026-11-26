# ferry-webinstaller

Sign and install an `.ipa` on an iPhone or iPad from a web page. The interface is SwiftUI,
compiled to WebAssembly with [SwiftUIWeb](https://github.com/Vitorsilveira31/SwiftUIWeb)
(Embedded Swift, real DOM). The device is driven by [ios-webusb](../ios-webusb): usbmux,
lockdown, AFC and installation_proxy in wasm over WebUSB. Apple ID sign-in, App IDs,
profiles and signing are [isideload](https://github.com/nab138/isideload) (its `wasm`
feature) in the same wasm module. Nothing runs natively.
Chromium-based browsers only (WebUSB).

```
Sources/FerryWebInstaller/   SwiftUI app (BrowserApp, @Observable Installer)
Resources/device-service.js  `device` page service: ios-webusb driver + AppleAccount
web/anisette-entry.js        relay `fetch` shim, anisette (-> Resources/anisette.js)
web/relay.mjs                Wisp relay (Apple + anisette hosts, port 443 only)
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

Without an Apple ID the IPA is installed as it is (it must already be signed for the
device). Signed in, Install registers the device and App IDs with the account's team,
gets a profile, signs in the page with the account's development certificate and
installs. The certificate, its key, the chosen team and the anisette identity are kept
in localStorage (`isideload:*`), so later installs reuse them; the password is not
stored. SideStore, AltStore, LiveContainer and StikStore get the device's pair record
embedded, as isideload does natively.

`sign/` (apple-codesign on Emscripten, `Resources/signer.js`) is a standalone signer
for IPAs with a given certificate and profile; the install flow doesn't need it.

## Anisette and the relay

Signing in to Apple needs anisette headers. They come from a public SideStore
anisette v3 server, through isideload's v3 client (default `https://mac-ani.jkcoxson.com`; any server from
`servers.sidestore.io/servers.json`, set with `localStorage.ferryAnisetteServer`).
The page keeps the identity and `adi.pb` in localStorage and talks to Apple itself
during provisioning, like SideStore does.

Apple's servers and most anisette servers send no CORS headers, so HTTP goes
through [libcurl.js](https://github.com/ading2210/libcurl.js) (isideload's reqwest
uses the page's `fetch`, which `installRelayFetch()` reroutes for cross-origin URLs;
Chromium strips User-Agent from fetch requests, so the shim restores the one the
anisette server reports): TLS runs in the page
and only raw TCP crosses a [Wisp](https://github.com/MercuryWorkshop/wisp-protocol)
websocket relay. The relay sees ciphertext only and allows port 443 on Apple hosts
and the listed anisette servers.

```sh
bun web/relay.mjs                 # ws://127.0.0.1:6001/, used automatically on localhost
```

Deployed, serve it at `/wisp/` on the same origin, or point the page at one with
`localStorage.ferryRelay = "wss://..."`. libcurl.js is built from
[jbisfun/libcurl.js](https://github.com/jbisfun/libcurl.js) `apple-roots`, which adds
Apple's root CAs to its bundle (`gsa.apple.com` chains to Apple Root CA).

## Without a relay: Isolated Web App

Installed as an [Isolated Web App](https://github.com/WICG/isolated-web-apps), the
page gets the Direct Sockets API (`TCPSocket`), and libcurl.js uses it as its
transport (`web/direct-socket.js`): TLS still runs in the page, and its bytes go
straight to Apple and the anisette server over TCP. No relay and no server of any
kind. Outside an IWA the page falls back to the Wisp relay.

```sh
just iwa          # serves the IWA with Chromium's IWA headers on http://127.0.0.1:8794/
just iwa-bundle   # .build/iwa/ferry.swbn, signed with ~/.config/ferry-webinstaller/iwa-key.pem
```

`web/iwa.mjs` turns the bundle into an IWA. It moves the page shell's inline
scripts into files, because the IWA's fixed CSP has no hashes. It drops `<base>`
(`base-uri 'none'`) and adds `/.well-known/manifest.webmanifest` with
`direct-sockets`, `usb` and `cross-origin-isolated` in its permissions policy.
`Resources/config.js` installs the Trusted Types default policy the IWA requires.
The signing key fixes the app's `isolated-app://` origin, so keep it (the first
`just iwa-bundle` creates it).

To install, enable `chrome://flags/#enable-isolated-web-app-dev-mode` (Chrome,
Chromium or Helium 157). Then, in `chrome://web-app-internals`, either install
`ferry.swbn` under "Install IWA from Signed Web Bundle", or enter
`http://127.0.0.1:8794/` under "Install IWA via Dev Mode Proxy". A scripted
install also works, for example
`--enable-features=IsolatedWebApps,IsolatedWebAppDevMode --install-isolated-web-app-from-file=.build/iwa/ferry.swbn`
on the first start of a profile.
