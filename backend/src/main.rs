#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    // `--node` runs headless (no window): an always-on routing/relay node
    // for VPS deployment. Everything else is the normal GUI.
    if args.iter().any(|a| a == "--node") {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("failed to build tokio runtime");
        if let Err(e) = rt.block_on(peers_lib::run_headless()) {
            eprintln!("peers node error: {e}");
            std::process::exit(1);
        }
    } else {
        peers_lib::run();
    }
}
