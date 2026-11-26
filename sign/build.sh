#!/usr/bin/env bash
# Build ../Resources/signer/ferry_sign.{mjs,wasm}: apple-codesign + this crate's C ABI,
# compiled for wasm32-unknown-emscripten (C deps like bzip2 and ring's asm need a libc).
# Needs emsdk in the environment (source emsdk_env.sh) and rustup's wasm32-unknown-emscripten.
set -euo pipefail
cd "$(dirname "$0")"
rustup target add wasm32-unknown-emscripten >/dev/null
cargo build --release --target wasm32-unknown-emscripten
OUT=../Resources/signer
mkdir -p "$OUT"
emcc target/wasm32-unknown-emscripten/release/libferry_sign.a -O2 -fwasm-exceptions \
    -o "$OUT/ferry_sign.mjs" -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,worker,node \
    -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=134217728 -sMAXIMUM_MEMORY=4294967296 -sSTACK_SIZE=8388608 \
    -sEXPORTED_FUNCTIONS='["_malloc","_free","_ferry_sign","_ferry_inspect","_ferry_last_error","_ferry_buf_free"]' \
    -sEXPORTED_RUNTIME_METHODS='["HEAPU8","HEAPU32","UTF8ToString"]'
ls -la "$OUT"
