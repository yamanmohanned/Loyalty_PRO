//! Walaa manager desktop shell.
//!
//! Deliberately thin. The API service is a **separate Windows Service**, not a
//! Tauri sidecar (CLAUDE_v3.md §12.3): the Loyalty Station and the Print Capture
//! Agent need the API alive for the whole working day, and a sidecar dies with the
//! dashboard window. So this process is only the manager's UI shell — it talks to
//! the local API over HTTP like any other client.
//!
//! Everything the frontend may touch is declared in `capabilities/default.json`
//! (CLAUDE_v2.md §11). There is no filesystem or shell access.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Persistent config for the API server URL, written on first run (§9).
        .plugin(tauri_plugin_store::Builder::new().build())
        // Opens external links in the user's real browser rather than in the app.
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("error while running walaa manager");
}
