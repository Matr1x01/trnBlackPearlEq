use std::sync::Mutex;

use tauri::{Manager, RunEvent};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Handle to the Go sidecar so it can be shut down with the window.
///
/// Without this the backend keeps the USB device open after the UI closes,
/// and the next launch finds the port already bound.
struct Backend(Mutex<Option<CommandChild>>);

/// Starts the Go sidecar that owns the HID connection and serves the local
/// API. Failure is logged rather than fatal: the UI is still usable (it
/// shows "Disconnected" with a retry button), and that beats refusing to
/// open at all.
fn spawn_backend(app: &tauri::AppHandle) {
    let sidecar = match app.shell().sidecar("trncontrol-backend") {
        Ok(cmd) => cmd,
        Err(e) => {
            eprintln!("[trncontrol] could not locate the backend sidecar: {e}");
            return;
        }
    };

    // Tells the backend to exit when our end of its stdin pipe closes.
    // The explicit kill below handles a clean quit; this covers the cases
    // that never reach it -- a crash, or SIGKILL -- which would otherwise
    // orphan the backend still holding the USB device and port 47823.
    let sidecar = sidecar.env("TRNCONTROL_SUPERVISED", "1");

    let (mut rx, child) = match sidecar.spawn() {
        Ok(pair) => pair,
        Err(e) => {
            eprintln!("[trncontrol] could not start the backend: {e}");
            return;
        }
    };

    app.state::<Backend>().0.lock().unwrap().replace(child);

    // Drain the sidecar's output. This is not just for logging -- an
    // unread pipe eventually fills and blocks the backend's writes.
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) | CommandEvent::Stderr(line) => {
                    eprintln!("[backend] {}", String::from_utf8_lossy(&line).trim_end());
                }
                CommandEvent::Terminated(payload) => {
                    eprintln!("[backend] exited with {:?}", payload.code);
                }
                _ => {}
            }
        }
    });
}

fn shutdown_backend(app: &tauri::AppHandle) {
    if let Some(child) = app.state::<Backend>().0.lock().unwrap().take() {
        if let Err(e) = child.kill() {
            eprintln!("[trncontrol] could not stop the backend: {e}");
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(Backend(Mutex::new(None)))
        .setup(|app| {
            spawn_backend(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build the application")
        .run(|app, event| {
            // Covers both closing the last window and a signal-driven exit.
            if let RunEvent::Exit = event {
                shutdown_backend(app);
            }
        });
}
