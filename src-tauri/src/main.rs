// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Standalone backend for browser/debug mode: same core as the Tauri
    // app, over HTTP. `pi-desktop --server [port]` (PORT env or the
    // remote_port config). Token + bind come from config either way.
    let args: Vec<String> = std::env::args().collect();
    if let Some(i) = args.iter().position(|a| a == "--server") {
        let port: Option<u16> = args
            .get(i + 1)
            .and_then(|s| s.parse().ok())
            .or_else(|| {
                std::env::var("PORT")
                    .ok()
                    .and_then(|s| s.parse().ok())
            });
        return pi_quickbar_lib::run_server(port);
    }
    pi_quickbar_lib::run()
}
