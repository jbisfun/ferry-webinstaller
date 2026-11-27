# Installing Ferry (web installer)

Ferry's web installer signs and installs `.ipa` files on an iPhone or iPad from a desktop
Chromium browser. The phone connects over a USB cable through WebUSB. Your Apple ID signs
the app in the browser, and nothing is installed on the computer apart from the browser
app itself.

It comes as an **Isolated Web App** (IWA), an installable, signed web app with access to
Direct Sockets. In that form it talks to Apple and the anisette server directly, with no
relay or server in between. It installs from:

```
https://jbisfun.github.io/ferry-webinstaller/docs/iwa/update.json
```

## What you need

- A desktop Chromium browser: Chrome, Chromium, Edge, Brave or Helium, on Linux, Windows or
  macOS, version 131 or later. Firefox and Safari have no WebUSB.
- An iPhone or iPad and a USB cable. Data cables only: a charge-only cable won't show the
  device.
- Optional: an Apple ID. A free account works, and signed apps then run for 7 days. Without
  an Apple ID, Ferry can only install IPAs already signed for your device.

## 1. Turn on Isolated Web Apps

Outside ChromeOS, browsers only install IWAs in developer mode, so two flags are needed:

1. Open `chrome://flags` (in Edge, `edge://flags`).
2. Set **Isolated Web Apps** (`#enable-isolated-web-apps`) to *Enabled*.
3. Set **Isolated Web App Developer Mode** (`#enable-isolated-web-app-dev-mode`) to *Enabled*.
4. Click **Relaunch**.

Developer mode lets you install IWAs from any source you choose. Only install bundles you
trust.

## 2. Install Ferry

1. Open `chrome://iwa-dev`. On older versions, use `chrome://web-app-internals` and scroll to
   *Isolated Web Apps*.
2. Choose **Install IWA** → **Install from update manifest** (*Update manifest URL*).
3. Paste `https://jbisfun.github.io/ferry-webinstaller/docs/iwa/update.json`, pick the newest
   version, and install.
4. Open **Ferry** from `chrome://apps` or from your system's app launcher.

The app checks the same manifest for new versions and updates itself. To update right away,
use **Update** next to Ferry in `chrome://iwa-dev`.

## 3. Install an app on your iPhone

1. **Sign in (optional).** Enter your Apple ID and press Enter.
   - If two-factor authentication is on, a code appears on your trusted devices.
   - If no code comes, open **Settings → [your name] → Sign-In & Security → Get Verification
     Code** on your iPhone.
   - Your password goes only to Apple: TLS runs inside the app.
2. **Connect the device.** Plug in the iPhone, click **Connect Device**, pick it in the
   browser's USB prompt, unlock the phone and tap **Trust**. Ferry remembers the device after
   that.
3. **Choose the IPA**, then click **Sign and Install** (or **Install** without an Apple ID).
   - The first install registers the device and an App ID with your team, which takes a
     little longer.
   - Free accounts can have a limited number of active certificates. If Apple refuses a new
     one, turn on **Revoke an old certificate** before signing in.
4. **On the iPhone**, the first time only:
   - On iOS 16 and later, turn on **Settings → Privacy & Security → Developer Mode** and
     restart when asked.
   - Trust your developer certificate under **Settings → General → VPN & Device Management**.

## Troubleshooting

- **`chrome://iwa-dev` says to enable flags.** Both flags from step 1 must be on, and the
  browser relaunched.
- **The phone doesn't show up in the USB prompt.** Check the cable, unlock the phone, and close
  other programs that hold the device: iTunes or Apple Devices on Windows, Finder on macOS,
  `usbmuxd` on Linux. On Linux, your user also needs access to the device node (the udev rules
  most distributions ship for usbmuxd and libimobiledevice).
- **"Auth error -22410".** Ferry retries automatically with a different device identity. If it
  still fails, sign in again.
- **No verification code arrives.** Use **Get Verification Code** on the iPhone (see step 3).
- **The app stops opening after 7 days.** Free-account signatures expire. Install it again
  from Ferry to renew it.

## Without installing anything

The same installer also runs as an ordinary web page, which needs a small relay server
for Apple's traffic because browsers block reading Apple's responses from a normal page. See the
[README](../README.md#anisette-and-the-relay) for running it that way.

## Uninstalling

Remove Ferry in `chrome://iwa-dev`, or from `chrome://apps` by right-clicking it and choosing
**Uninstall**. This also deletes its stored certificate, anisette identity and pair records.
