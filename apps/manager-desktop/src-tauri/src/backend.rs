//! Locating, launching and reporting on the API service.
//!
//! ── Two launchers, one supervisor ────────────────────────────────────────────
//!
//! A production install registers `walaa-service.exe` with the Service Control
//! Manager, because the Loyalty Station and the Print Capture Agent need the API alive
//! for every trading hour whether or not the dashboard window is open. A demo install
//! cannot do that: it is per-user, it must not ask for UAC, and an unelevated process
//! cannot register a service or write a firewall rule.
//!
//! The temptation is to give the demo its own small supervisor. That would be a
//! mistake — a demo whose backend is babysat by different code from the merchant's
//! proves nothing about the merchant's install, which is the only reason to ship a
//! demo at all. So both paths call the SAME `supervise()` inside `walaa-service.exe`;
//! the fork is one level up, in who starts it:
//!
//!   production  SCM ──────────────► walaa-service.exe run     ─┐
//!                                                              ├─► supervise()
//!   demo        this process ─────► walaa-service.exe console ─┘
//!
//! `console` provisions its own `walaa.env` and honours `--port`, so the demo gets the
//! same bounded retry, the same status file, the same log rotation and the same
//! stdin-close shutdown as production.
//!
//! ── Why the frontend gets two commands and not a filesystem ──────────────────
//!
//! The API writes a precise Arabic sentence when it refuses to start, and the
//! supervisor lifts it into `status.json`. Both go to disk. The dashboard could not
//! read either, because the Tauri capability set grants no `fs` permission at all —
//! so the good message was written, and the screen still said "check the connection to
//! the server". Granting `fs:default` to fix that would hand the whole filesystem to a
//! webview in order to read two known files. These commands read exactly those two
//! files and return them, and the capability set stays as tight as it was.

use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// `CREATE_NO_WINDOW` — the supervisor is a console binary and would otherwise flash
/// a black window over the merchant's dashboard at every launch.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// The seed database that ships beside the service in a demo build.
///
/// Its presence is the demo signal here for the same reason it is in the service host:
/// there is no separate flag that can fall out of step with whether the demo data
/// actually exists. A production bundle has no such file to find.
const DEMO_SEED: &str = "walaa-demo.db";

/// The supervisor we launch in a demo build, and the shipped runtime it lives in.
const SERVICE_EXE: &str = "walaa-service.exe";
const RUNTIME_DIR: &str = "runtime";

/// The demo's backend child, so it can be stopped when the window closes.
pub static CHILD: Mutex<Option<Child>> = Mutex::new(None);

/// The port the backend was told to use. Read by the frontend.
pub static PORT: Mutex<Option<u16>> = Mutex::new(None);

/// Where the shipped runtime sits inside the installed app.
pub fn runtime_dir(resource_dir: &Path) -> PathBuf {
    resource_dir.join(RUNTIME_DIR)
}

/// Whether this installation is a demo build.
pub fn is_demo(resource_dir: &Path) -> bool {
    runtime_dir(resource_dir).join(DEMO_SEED).exists()
}

/// The writable runtime directory, which differs by build kind.
///
/// A production install keeps its data in `%PROGRAMDATA%\Walaa`, locked to SYSTEM and
/// Administrators, because the service runs as LocalSystem and the database holds every
/// customer's phone number. A demo install is per-user and unelevated: it cannot write
/// there, and asking it to would reintroduce the UAC prompt the per-user install exists
/// to avoid. `%LOCALAPPDATA%\Walaa` is writable, is removed with the user profile, and —
/// usefully — is somewhere the merchant can actually open the log file.
pub fn data_dir(demo: bool) -> PathBuf {
    // An explicit override, honoured by the service host for the same reason: it is the
    // only way to point an installed copy at a different directory without editing the
    // binary. Support uses it to reproduce a merchant's state; the tests here use it to
    // exercise a first run without disturbing the real one.
    if let Some(dir) = std::env::var_os("WALAA_DATA_DIR") {
        let dir = PathBuf::from(dir);
        if !dir.as_os_str().is_empty() {
            return dir;
        }
    }

    let key = if demo { "LOCALAPPDATA" } else { "PROGRAMDATA" };
    let base = std::env::var_os(key)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(if demo { "C:\\" } else { "C:\\ProgramData" }));
    base.join("Walaa")
}

/// Asks the OS for a port nobody is using, then gives it straight back.
///
/// There is an unavoidable race between releasing the port and the API binding it, and
/// no way to close it on Windows without handing the listening socket to the child.
/// The window is milliseconds on a machine where the only other listener is whatever
/// the merchant already had; and if it is lost, the API fails to bind, the supervisor
/// records the reason, and the next launch picks a different number. That is a
/// recoverable, explained failure rather than the alternative — a hardcoded 4000 that
/// collides with something else on the shop's PC and produces a dead app forever.
pub fn free_port() -> Option<u16> {
    TcpListener::bind("127.0.0.1:0")
        .ok()
        .and_then(|l| l.local_addr().ok())
        .map(|a| a.port())
}

/// Starts the demo's backend under the shared supervisor.
pub fn spawn_supervisor(resource_dir: &Path, port: u16) -> Result<(), String> {
    let exe = runtime_dir(resource_dir).join(SERVICE_EXE);
    if !exe.exists() {
        return Err(format!("لم يُعثر على خدمة النظام: {}", exe.display()));
    }
    let data = data_dir(true);
    std::fs::create_dir_all(&data).map_err(|e| format!("{}: {e}", data.display()))?;

    let mut command = Command::new(&exe);
    command
        .arg("console")
        .arg("--data-dir")
        .arg(&data)
        .arg("--port")
        .arg(port.to_string())
        // `console` stops when its stdin closes, which is how this process asks the
        // supervisor to shut down — the same mechanism the supervisor uses on the API.
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let child = command
        .spawn()
        .map_err(|e| format!("تعذّر تشغيل خدمة النظام: {e}"))?;

    *CHILD.lock().unwrap() = Some(child);
    *PORT.lock().unwrap() = Some(port);
    Ok(())
}

/// Closes the supervisor's stdin, then kills it if it does not go.
pub fn stop_supervisor() {
    let Ok(mut guard) = CHILD.lock() else { return };
    let Some(mut child) = guard.take() else { return };

    drop(child.stdin.take());
    for _ in 0..40 {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(100)),
            Err(_) => break,
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}
