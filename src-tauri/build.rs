const COMMANDS: &[&str] = &[
    "add_subscription",
    "refresh_show",
    "refresh_all",
    "list_shows",
    "list_episodes",
    "get_episode",
    "remove_show",
    "set_progress",
    "search_podcasts",
    "youtube_subscriptions",
    "open_privacy_settings",
    "load_transcript",
    "fetch_official_transcript",
    "get_blob",
    "set_blob",
    "get_settings",
    "set_settings",
    "set_api_key",
    "has_api_key",
    "llm_chat",
    "translate_batch",
    "cloud_transcribe",
    "list_models",
    "export_opml",
    "storage_info",
    "open_data_folder",
    "clear_temp",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("tauri-build failed");
}
