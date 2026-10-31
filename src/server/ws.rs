use crate::engine::DownloadManager;
use axum::extract::ws::{Message, WebSocket};
use std::time::Duration;
use tokio::time::sleep;

pub async fn handle_websocket(mut socket: WebSocket, manager: DownloadManager) {
    loop {
        let snapshots = manager.get_all_snapshots().await;
        if let Ok(json) = serde_json::to_string(&snapshots) {
            if socket.send(Message::Text(json)).await.is_err() {
                // Client disconnected
                break;
            }
        }
        sleep(Duration::from_millis(300)).await;
    }
}

