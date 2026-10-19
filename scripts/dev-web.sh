#!/bin/sh
# Browser mode: Rust backend in --server mode + vite, same ports every time.
# Frontend proxies /api -> backend, so the app just works at the vite URL.
PORT=1423 cargo run --manifest-path src-tauri/Cargo.toml --bin pi-desktop -- --server &
BACK=$!
trap "kill $BACK 2>/dev/null" EXIT INT TERM
vite --port 1422 --strictPort
