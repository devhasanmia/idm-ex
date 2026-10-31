pub mod routes;
pub mod ws;

use crate::engine::DownloadManager;
use routes::{create_router, AppState};
use std::net::SocketAddr;

pub async fn start_server(
    manager: DownloadManager,
    port: u16,
    auto_open: bool,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let app_state = AppState { manager };
    let router = create_router(app_state);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    let local_url = format!("http://127.0.0.1:{}", port);
    println!("============================================================");
    println!("⚡ Downly Turbo Download Manager is running!");
    println!("🌐 Dashboard & Web UI: {}", local_url);
    println!("🧩 Browser Extension API: {}/api/download", local_url);
    println!("============================================================");

    if auto_open {
        let _ = open::that(&local_url);
    }

    axum::serve(listener, router).await?;
    Ok(())
}

