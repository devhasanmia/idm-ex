pub mod downloader;
pub mod limiter;
pub mod segment;
pub mod state;
pub mod writer;

use downloader::{DownloadTask, TaskSnapshot, TaskStatus};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::RwLock;

#[derive(Clone)]
pub struct DownloadManager {
    download_dir: PathBuf,
    tasks: Arc<RwLock<HashMap<String, Arc<DownloadTask>>>>,
}

impl DownloadManager {
    pub fn new(download_dir: PathBuf) -> Self {
        Self {
            download_dir,
            tasks: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub fn download_dir(&self) -> &Path {
        &self.download_dir
    }

    pub async fn add_download(
        &self,
        url: String,
        filename: Option<String>,
        connections: usize,
        speed_limit_bps: u64,
    ) -> Arc<DownloadTask> {
        let id = uuid::Uuid::new_v4().to_string();
        let task = Arc::new(DownloadTask::new(
            id.clone(),
            url,
            &self.download_dir,
            filename,
            connections,
            speed_limit_bps,
        ));

        {
            let mut tasks = self.tasks.write().await;
            tasks.insert(id, Arc::clone(&task));
        }

        Arc::clone(&task).start().await;
        task
    }

    pub async fn get_task(&self, id: &str) -> Option<Arc<DownloadTask>> {
        let tasks = self.tasks.read().await;
        tasks.get(id).cloned()
    }

    pub async fn pause_task(&self, id: &str) -> bool {
        if let Some(task) = self.get_task(id).await {
            task.pause().await;
            true
        } else {
            false
        }
    }

    pub async fn resume_task(&self, id: &str) -> bool {
        if let Some(task) = self.get_task(id).await {
            let mut status = task.status.lock().await;
            if *status == TaskStatus::Paused || *status == TaskStatus::Failed {
                *status = TaskStatus::Queued;
                Arc::clone(&task).start().await;
                return true;
            }
        }
        false
    }

    pub async fn cancel_task(&self, id: &str) -> bool {
        if let Some(task) = self.get_task(id).await {
            task.cancel().await;
            let mut tasks = self.tasks.write().await;
            tasks.remove(id);
            true
        } else {
            false
        }
    }

    pub async fn get_all_snapshots(&self) -> Vec<TaskSnapshot> {
        let tasks = self.tasks.read().await;
        let mut list = Vec::new();
        for task in tasks.values() {
            list.push(task.get_snapshot().await);
        }
        list
    }
}

