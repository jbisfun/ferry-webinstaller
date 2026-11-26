# The ios-webusb driver (wasm) -> Resources/ios-webusb.
# SwiftPM checks dependencies out read-only and SwiftUIWeb's source lowerer edits
# copies of them in place (fine as root in its CI, EACCES here), so make them writable.
driver:
    swift package resolve
    chmod -R u+w .build/checkouts
    just --justfile ../ios-webusb/justfile --working-directory ../ios-webusb web
    rm -rf Resources/ios-webusb && cp -r ../ios-webusb/web/pkg Resources/ios-webusb

# Anisette page service bundle (web/anisette-entry.js -> Resources/anisette.js)
anisette:
    cd web && bun install && bun build anisette-entry.js --target browser --format esm --outfile ../Resources/anisette.js

# Wisp relay for Apple/anisette HTTP (ws://127.0.0.1:6001/)
relay:
    cd web && bun install && bun relay.mjs

# Debug build, served with reload on save
dev: driver anisette
    ./swiftweb dev

# Optimized static bundle in .build/browser/FerryWebInstaller
build: driver anisette
    ./swiftweb build

# The release bundle, served
run: driver anisette
    ./swiftweb run

# Isolated Web App (Direct Sockets: Apple and anisette traffic goes straight out, no relay).
# Serves the IWA with Chromium's IWA headers on :8794 for a dev-mode proxy install.
iwa: build
    cd web && bun iwa.mjs serve

# Signed web bundle .build/iwa/ferry.swbn (key: ~/.config/ferry-webinstaller/iwa-key.pem)
iwa-bundle: build
    cd web && bun iwa.mjs bundle
