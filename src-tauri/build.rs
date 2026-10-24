fn main() {
    // Autogenerate allow-<command> permissions for every app command so
    // remote origins (localhost UI server) can be granted them through
    // capabilities. Local tauri:// needs none of this (checks are
    // skipped there), but the grants are harmless for it.
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
            "delete_session",
            "direct_fetch",
            "get_config",
            "hide_window",
            "list_session_jobs",
            "list_sessions",
            "media_stat",
            "open_in_main",
            "pi_ensure",
            "pi_send",
            "pi_states",
            "pi_stop",
            "pick_dir",
            "pick_files",
            "qb_hide_self",
            "read_job_log",
            "read_job_transcript",
            "read_media",
            "read_office_text",
            "read_session_messages",
            "read_sheet",
            "rename_session",
            "save_upload",
            "set_config",
            "show_window",
            "shutdown_server",
            "toggle_main",
            "toggle_quickbar",
        ])),
    )
    .unwrap()
}
