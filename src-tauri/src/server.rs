// Standalone HTTP backend (`--server`): the same AppState core the Tauri
// commands use, exposed as POST /api/invoke + GET /api/events. This is
// what browser mode talks to — it replaced the old Node bridge
// (server/web-backend.mjs), so there is exactly one backend now.
// Localhost-only, no auth: it spawns processes as you.

use std::sync::Arc;

use axum::{
    body::Body,
    extract::State,
    http::{Request, StatusCode},
    middleware::{self, Next},
    response::{
        sse::{Event, KeepAlive},
        IntoResponse, Sse,
    },
    routing::{get, post},
    Json, Router,
};
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt as _;

use super::{
    delete_session, delete_spawn_run, list_sessions, media_stat, pids_alive,
    read_media, read_session_messages, read_spawn_log, read_spawn_transcript, AppState,
};

// ---------------------------------------------------------------- params

/// First hit wins: wire speaks camelCase (frontend), snake_case accepted
/// too (the old Node bridge read both).
fn s(p: &serde_json::Value, snake: &str, camel: &str) -> Option<String> {
    p.get(snake)
        .or_else(|| p.get(camel))
        .and_then(|v| v.as_str())
        .map(|x| x.to_string())
}

fn req_s(
    p: &serde_json::Value,
    snake: &str,
    camel: &str,
    what: &str,
) -> Result<String, String> {
    s(p, snake, camel)
        .filter(|x| !x.is_empty())
        .ok_or_else(|| format!("missing {what}"))
}

fn opt_u(p: &serde_json::Value, snake: &str, camel: &str) -> Option<usize> {
    p.get(snake)
        .or_else(|| p.get(camel))
        .and_then(|v| v.as_u64())
        .map(|v| v as usize)
}

// ---------------------------------------------------------------- dispatch

/// Same 22 commands as the Tauri invoke_handler. Window-only commands are
/// no-ops here (no windows in server mode), exactly like the old bridge.
fn dispatch(
    be: &Arc<AppState>,
    cmd: &str,
    p: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    match cmd {
        "pi_ensure" => {
            let cwd = req_s(p, "cwd", "cwd", "cwd")?;
            let key = req_s(p, "key", "key", "key")?;
            let tag = s(p, "tag", "tag");
            let session_dir = s(p, "session_dir", "sessionDir");
            let session_path = s(p, "session_path", "sessionPath");
            be.pi_ensure_core(cwd, session_dir, tag, key, session_path)
                .map(serde_json::Value::String)
        }
        "pi_send" => {
            let cwd = s(p, "cwd", "cwd").unwrap_or_default();
            let payload = p
                .get("payload")
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            let tag = s(p, "tag", "tag");
            let key = req_s(p, "key", "key", "key")?;
            be.pi_send_core(cwd, payload, tag, key)
                .map(|_| serde_json::Value::Null)
        }
        "pi_stop" => {
            let cwd = s(p, "cwd", "cwd").unwrap_or_default();
            let tag = s(p, "tag", "tag");
            let key = req_s(p, "key", "key", "key")?;
            be.pi_stop_core(cwd, tag, key)
                .map(|_| serde_json::Value::Null)
        }
        "pi_states" => Ok(be.pi_states_core()),
        "pids_alive" => {
            let pids: Vec<i32> = p
                .get("pids")
                .and_then(|v| v.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_i64().map(|n| n as i32))
                        .collect()
                })
                .unwrap_or_default();
            Ok(serde_json::json!(pids_alive(pids)))
        }
        "list_sessions" => {
            let cwd_filter = s(p, "cwd_filter", "cwdFilter");
            let session_root = s(p, "session_root", "sessionRoot");
            list_sessions(cwd_filter, session_root).map(|v| serde_json::json!(v))
        }
        "delete_session" => {
            let path = req_s(p, "path", "path", "path")?;
            let session_root = s(p, "session_root", "sessionRoot");
            delete_session(path, session_root).map(|_| serde_json::Value::Null)
        }
        "read_media" => {
            let path = req_s(p, "path", "path", "path")?;
            let base = s(p, "base", "base");
            read_media(path, base)
        }
        "media_stat" => {
            let path = req_s(p, "path", "path", "path")?;
            let base = s(p, "base", "base");
            media_stat(path, base)
        }
        "read_session_messages" => {
            let path = req_s(p, "path", "path", "path")?;
            let session_root = s(p, "session_root", "sessionRoot");
            let max_bytes = opt_u(p, "max_bytes", "maxBytes");
            let offset = opt_u(p, "offset", "offset");
            read_session_messages(path, session_root, max_bytes, offset)
        }
        "read_spawn_transcript" => {
            let run_id = req_s(p, "run_id", "runId", "run_id")?;
            read_spawn_transcript(run_id)
        }
        "read_spawn_log" => {
            let run_id = req_s(p, "run_id", "runId", "run_id")?;
            read_spawn_log(run_id)
        }
        "delete_spawn_run" => {
            let run_id = req_s(p, "run_id", "runId", "run_id")?;
            delete_spawn_run(run_id).map(|_| serde_json::Value::Null)
        }
        "get_config" => Ok(serde_json::json!(be.get_config_core())),
        "set_config" => {
            let patch = p.get("patch").cloned().unwrap_or(serde_json::Value::Null);
            be.set_config_core(&patch).map(|(snap, _, _)| serde_json::json!(snap))
        }
        // Window-only: no-ops in server mode (no windows to toggle).
        "toggle_quickbar" | "toggle_main" | "show_window" | "hide_window" | "qb_hide_self"
        | "open_in_main" | "pick_dir" => Ok(serde_json::Value::Null),
        _ => Err(format!("unknown command: {cmd}")),
    }
}

// ---------------------------------------------------------------- routes

/// POST {cmd, params} -> {ok, data|error}. Always HTTP 200: failures ride
/// the envelope, matching the Tauri invoke() contract in tauri-shim.
async fn invoke(
    State(be): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let cmd = body
        .get("cmd")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let params = body
        .get("params")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let val = match dispatch(&be, &cmd, &params) {
        Ok(data) => serde_json::json!({ "ok": true, "data": data }),
        Err(e) => serde_json::json!({ "ok": false, "error": e }),
    };
    (StatusCode::OK, Json(val))
}

/// SSE broadcast of forwarded pi records: `data: {...}` per record, same
/// shape as the Tauri pi-record event payload.
async fn events(State(be): State<Arc<AppState>>) -> impl IntoResponse {
    let rx = be.events.subscribe();
    let stream = BroadcastStream::new(rx)
        .filter_map(|r| r.ok())
        .map(|v| Ok::<_, axum::Error>(Event::default().json_data(v).unwrap()));
    Sse::new(stream).keep_alive(KeepAlive::default())
}

async fn cors(req: Request<Body>, next: Next) -> impl IntoResponse {
    let mut res = next.run(req).await;
    res.headers_mut().insert(
        "access-control-allow-origin",
        "*".parse().unwrap(),
    );
    res.headers_mut().insert(
        "access-control-allow-headers",
        "content-type".parse().unwrap(),
    );
    res
}

// ---------------------------------------------------------------- run

/// Serve the backend on 127.0.0.1:port. Ctrl-C kills supervised children
/// (mirrors the SIGTERM handler the old Node bridge had).
pub fn run_server(port: u16) {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    rt.block_on(async move {
        let backend = AppState::new_shared();
        {
            let be = backend.clone();
            tokio::spawn(async move {
                let _ = tokio::signal::ctrl_c().await;
                be.kill_all();
                std::process::exit(0);
            });
        }
        async fn opts() -> impl IntoResponse {
            StatusCode::NO_CONTENT
        }
        let app = Router::new()
            .route("/api/invoke", post(invoke).options(opts))
            .route("/invoke", post(invoke).options(opts))
            .route("/api/events", get(events).options(opts))
            .route("/events", get(events).options(opts))
            .fallback(|| async {
                (
                    StatusCode::NOT_FOUND,
                    "pi-desktop backend. POST /api/invoke, GET /api/events",
                )
            })
            .layer(middleware::from_fn(cors))
            .with_state(backend);
        let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
        let listener = tokio::net::TcpListener::bind(addr).await.unwrap_or_else(|e| {
            eprintln!("[pi-desktop] cannot bind http://localhost:{port}: {e}");
            std::process::exit(1);
        });
        println!("[pi-desktop] backend on http://localhost:{port}");
        axum::serve(listener, app).await.expect("serve backend");
    });
}
