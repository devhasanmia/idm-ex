use super::ws::handle_websocket;
use crate::engine::DownloadManager;
use axum::extract::{Path, State, WebSocketUpgrade};
use axum::http::StatusCode;
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use tower_http::cors::{Any, CorsLayer};

const UI_HTML: &str = include_str!("ui.html");

#[derive(Clone)]
pub struct AppState {
    pub manager: DownloadManager,
}

#[derive(Deserialize)]
pub struct AddDownloadRequest {
    pub url: String,
    pub filename: Option<String>,
    pub connections: Option<usize>,
    pub speed_limit: Option<u64>,
}

#[derive(Serialize)]
pub struct ApiResponse<T> {
    pub success: bool,
    pub data: Option<T>,
    pub message: Option<String>,
}

pub fn create_router(state: AppState) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    Router::new()
        .route("/", get(index_handler))
        .route("/api/tasks", get(get_tasks_handler))
        .route("/api/download", post(add_download_handler))
        .route("/api/tasks/:id/pause", post(pause_task_handler))
        .route("/api/tasks/:id/resume", post(resume_task_handler))
        .route("/api/tasks/:id/cancel", post(cancel_task_handler))
        .route("/api/ws", get(ws_handler))
        .layer(cors)
        .with_state(state)
}

async fn index_handler() -> Html<&'static str> {
    Html(UI_HTML)
}

async fn get_tasks_handler(State(state): State<AppState>) -> impl IntoResponse {
    let snapshots = state.manager.get_all_snapshots().await;
    Json(snapshots)
}

async fn add_download_handler(
    State(state): State<AppState>,
    Json(payload): Json<AddDownloadRequest>,
) -> impl IntoResponse {
    let connections = payload.connections.unwrap_or(16);
    let speed_limit = payload.speed_limit.unwrap_or(0);

    let task = state
        .manager
        .add_download(payload.url, payload.filename, connections, speed_limit)
        .await;

    let snapshot = task.get_snapshot().await;
    (StatusCode::CREATED, Json(snapshot))
}

async fn pause_task_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let ok = state.manager.pause_task(&id).await;
    Json(ApiResponse {
        success: ok,
        data: None::<()>,
        message: if ok { None } else { Some("Task not found".to_string()) },
    })
}

async fn resume_task_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let ok = state.manager.resume_task(&id).await;
    Json(ApiResponse {
        success: ok,
        data: None::<()>,
        message: if ok { None } else { Some("Task not found".to_string()) },
    })
}

async fn cancel_task_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let ok = state.manager.cancel_task(&id).await;
    Json(ApiResponse {
        success: ok,
        data: None::<()>,
        message: if ok { None } else { Some("Task not found".to_string()) },
    })
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> Response {
    ws.on_upgrade(move |socket| handle_websocket(socket, state.manager))
}

