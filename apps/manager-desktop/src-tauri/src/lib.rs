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

/// Removes the WebView2 profile's credential and form-history stores.
///
/// ── Why a desktop app deletes browser databases on every launch ──────────────
///
/// The window is a WebView2, which is Chromium, which keeps a full browser profile
/// under `%LOCALAPPDATA%\com.walaa.manager\EBWebView`. That profile has a password
/// manager (`Login Data`) and a form-history autofill store (`Web Data`), and both
/// were quietly active in the shipped build: a `Web Data` on the operator's machine
/// held the username `manager`, typed during testing, and it survived a full
/// uninstall and reinstall — the profile lives outside `$INSTDIR`, so nothing in the
/// installer ever touched it.
///
/// That is unacceptable for this product specifically. The credential it would offer
/// to remember unlocks a dashboard holding every customer's phone number, which §7.11
/// calls the one identifier worth protecting. A merchant is also never told the
/// profile exists, so nobody would think to clear it.
///
/// **Deleted rather than only disabled**, because disabling protects future launches
/// and leaves whatever is already there. This runs before any window is created, so
/// the files are not open. Failures are ignored on purpose: a locked file is not a
/// reason to refuse to start the dashboard, and the next launch will get it.
///
/// The autofill attributes on the login form are the other half — see `Login.tsx`.
fn purge_webview_credential_stores() {
    let Some(local) = std::env::var_os("LOCALAPPDATA") else {
        return;
    };
    let profiles = std::path::Path::new(&local)
        .join("com.walaa.manager")
        .join("EBWebView");

    let Ok(entries) = std::fs::read_dir(&profiles) else {
        return;
    };

    for entry in entries.flatten() {
        // Chromium keeps one directory per profile; ours is `Default`, but a future
        // WebView2 could add more and each carries its own copy of these stores.
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        for name in [
            "Login Data",
            "Login Data-journal",
            "Login Data For Account",
            "Login Data For Account-journal",
            "Web Data",
            "Web Data-journal",
        ] {
            let _ = std::fs::remove_file(dir.join(name));
        }
    }
}

mod backend;
mod status;

use tauri::Manager;

/// The backend's own account of itself, for the dashboard to render verbatim.
///
/// Two narrow commands rather than an `fs` capability: the frontend needs exactly two
/// known files and granting it a filesystem to read them would be a poor trade in an
/// app whose database holds every customer's phone number.
#[tauri::command]
fn backend_status(app: tauri::AppHandle) -> status::BackendStatus {
    let resource = app.path().resource_dir().unwrap_or_default();
    let demo = backend::is_demo(&resource);
    let port = *backend::PORT.lock().unwrap();
    status::read(&backend::data_dir(demo), demo, port)
}

/// The port the backend is listening on.
///
/// A demo picks a free one at every launch, so the frontend cannot assume 4000 —
/// which it used to, hardcoded, and which is exactly how an app dies permanently on a
/// machine where something else already owns that port.
///
/// ── Production answers too now, and that is the point ────────────────────────
///
/// This returned `None` for anything but a demo, and the consequence was a question
/// put to the merchant that his own machine could already answer. The manager PC runs
/// the backend; the installer fixed its port; the shop owner was nevertheless shown a
/// text box on the login screen asking for an address, which is the control he uses to
/// convince himself the software is broken.
///
/// The port is in `walaa.env`, locked to SYSTEM and Administrators because that file
/// also holds the JWT signing keys. So the service — which can read it — publishes the
/// port alone into `status.json` in the log directory, and this reads it back. Zero
/// configuration on the machine that hosts its own backend; configuration only on a
/// second machine pointing at this one.
///
/// `None` still means "genuinely not known", never a guess: see `configured_port_opt`
/// in the service host. A wrong port produces a confident dead-backend screen, which is
/// worse than an honest one.
#[tauri::command]
fn backend_port(app: tauri::AppHandle) -> Option<u16> {
    let resource = app.path().resource_dir().unwrap_or_default();
    let demo = backend::is_demo(&resource);

    if demo {
        return *backend::PORT.lock().unwrap();
    }

    status::read(&backend::data_dir(false), false, None).port
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    purge_webview_credential_stores();

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![backend_status, backend_port])
        .setup(|app| {
            /*
              A demo build supervises its own backend; a production build does not,
              because the Service Control Manager already is.

              Started here, before the window exists, so the API has the length of the
              webview's own startup as a head start. The frontend still health-gates —
              it polls `/health` and shows what `backend_status` reports until that
              answers — because "we launched it" and "it is serving" are different
              claims and only the second one is worth acting on.
            */
            let resource = app.path().resource_dir().unwrap_or_default();
            if backend::is_demo(&resource) {
                match backend::free_port() {
                    Some(port) => {
                        if let Err(error) = backend::spawn_supervisor(&resource, port) {
                            eprintln!("backend: {error}");
                        }
                    }
                    None => eprintln!("backend: no free port available"),
                }
            }
            Ok(())
        })
        // Persistent config for the API server URL, written on first run (§9).
        .plugin(tauri_plugin_store::Builder::new().build())
        // Opens external links in the user's real browser rather than in the app.
        .plugin(tauri_plugin_opener::init())
        /*
          The update path.

          `dialog: false` in the config — the plugin's own modal is English, unstyled
          and appears over a merchant's dashboard without warning. The frontend does
          the asking instead, in Arabic and in the product's own language, and calls
          into this plugin to do the work.

          `process` is here only so the app can relaunch itself once an update has
          been staged; nothing else uses it.
        */
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .build(tauri::generate_context!())
        .expect("error while running walaa manager")
        .run(|_app, event| {
            // Take the backend down with the window. A demo left behind a supervisor
            // holding the database and a port would break the NEXT launch, and the
            // merchant would have no idea why — `console` stops when its stdin closes,
            // which is what `stop_supervisor` does first.
            if let tauri::RunEvent::Exit = event {
                backend::stop_supervisor();
            }
        });
}
