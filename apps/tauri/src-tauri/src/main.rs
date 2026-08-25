#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::OnceLock;
use std::time::Instant;

static START: OnceLock<Instant> = OnceLock::new();

fn ms() -> u128 {
    START.get().map(|s| s.elapsed().as_millis()).unwrap_or(0)
}

/// Detailed log line: `[peers +1234ms] message`. Mirrors to stderr AND
/// appends to <tmp>/peers-tauri.log so GUI launches (no terminal) still
/// leave a trail.
fn log(msg: &str) {
    let line = format!("[peers +{}ms] {}\n", ms(), msg);
    eprint!("{}", line);
    let path = std::env::temp_dir().join("peers-tauri.log");
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = std::io::Write::write_all(&mut f, line.as_bytes());
    }
}

fn log_env() {
    log(&format!(
        "build: version={} custom-protocol(embedded-UI)={} dev-url-mode={}",
        env!("CARGO_PKG_VERSION"),
        cfg!(feature = "custom-protocol"),
        cfg!(dev),
    ));
    log(&format!("log file: {}", std::env::temp_dir().join("peers-tauri.log").display()));
    for (k, v) in std::env::vars() {
        if k.starts_with("PEERS_") || k == "WEBKIT_DISABLE_COMPOSITING_MODE" || k == "LIBGL_ALWAYS_SOFTWARE" {
            log(&format!("env: {}={}", k, v));
        }
    }
    log(&format!(
        "platform: {} / {}",
        std::env::consts::OS,
        std::env::consts::ARCH
    ));
}

fn main() {
    let _ = START.set(Instant::now());
    let _ = std::fs::remove_file(std::env::temp_dir().join("peers-tauri.log"));
    log("boot");
    log_env();

    let result = tauri::Builder::default()
        .setup(|app| {
            use tauri::Manager;
            log("setup: begin");
            match app.get_webview_window("main") {
                Some(w) => {
                    let url = w.url().map(|u| u.to_string()).unwrap_or_else(|e| format!("<url err: {}>", e));
                    log(&format!("main window: url={} label={}", url, w.label()));
                }
                None => log("setup: main window NOT found"),
            }
            log("setup: done");
            Ok(())
        })
        .on_page_load(|webview, payload| {
            let url = webview
                .url()
                .map(|u| u.to_string())
                .unwrap_or_else(|e| format!("<url err: {}>", e));
            match payload.event() {
                tauri::webview::PageLoadEvent::Started => log(&format!("page-load START: {}", url)),
                tauri::webview::PageLoadEvent::Finished => log(&format!("page-load FINISH: {}", url)),
            }
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                log(&format!("window close requested: {}", window.label()));
            }
        })
        .build(tauri::generate_context!());

    match result {
        Ok(app) => {
            log("event loop starting");
            app.run(|_app, event| match event {
                tauri::RunEvent::ExitRequested { code, .. } => {
                    log(&format!("exit requested: code={:?}", code));
                }
                tauri::RunEvent::Exit => log("exit"),
                _ => {}
            });
        }
        Err(e) => {
            let m = format!("BUILDER ERROR: {}", e);
            log(&m);
            eprint!("{}\n", m);
        }
    }
}
